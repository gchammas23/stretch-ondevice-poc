/// <reference types="node" />
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { leanRequest, leanSaving, leanVerdict, pageSizeSpots } from '../src/onDevice/pageSize';
import { createRetailerSearch } from '../src/onDevice/retailerSearch';
import { loadNotes, loadSpans, markShown, replaySpans, shownAt, SpanLog, timelineOf, type TimingSpan } from '../src/onDevice/timing';
import { REPLAY_TIMEOUT_MS, StoreTuner, storesAtOnce, tuneStore, type TuningSample } from '../src/onDevice/tuning';
import type { RetailerConfig, SearchOutcome } from '../src/onDevice/types';
import { WebViewPool } from '../src/onDevice/webviewPool';
import type { WebViewQueue } from '../src/onDevice/webviewQueue';
import { captureScript, DEFAULT_CHALLENGE_MARKERS, extractionScript } from '../src/onDevice/webviewScript';
import { autoDetect, PARSERS } from '../src/onDevice/parsers';
import { PriceCache } from '../src/pricing/priceCache';
import { PricingEngine } from '../src/pricing/pricingEngine';
import { paceOf, scorecard, speedProfile, speedProfileText } from '../src/pricing/scorecard';
import { saysItem, sharedProducts, sharePlan } from '../src/pricing/sharing';
import type { GroceryList, ListItem } from '../src/lists/types';
import type { Product } from '../src/onDevice/types';

/** The cache an engine was given, to start another engine from the same saved prices. */
const engineCache = (engine: PricingEngine) => (engine as unknown as { cache: PriceCache }).cache;

// Search events are logged for telemetry; keep them out of the test output.
const log = console.log;
console.log = (...args: unknown[]) => {
  if (!String(args[0]).startsWith('[on-device-search]')) log(...args);
};

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const nonceOf = (script: string) => /var NONCE = "([^"]+)"/.exec(script)![1];
const replayOf = (script: string) => {
  const m = /var NONCE = ("[^"]*"), REQ = (\{.*\});\n/.exec(script)!;
  return { nonce: JSON.parse(m[1]) as string, req: JSON.parse(m[2]) as { url: string; method: string; body?: string } };
};
const kinds = (spans: TimingSpan[]) => spans.map((s) => `${s.kind}${s.ok === false ? '✗' : ''}`);
const shape = (spans: TimingSpan[]) => spans.map((s) => [s.kind, s.start, s.end, ...(s.ok === false ? ['✗'] : [])]);

let passed = 0;
const t = async (name: string, fn: () => unknown) => { await fn(); passed++; log('ok -', name); };

const example: RetailerConfig = {
  id: 'example', name: 'Example', enabled: true,
  searchUrl: 'https://www.example.com/s?q={{query}}', homeUrl: 'https://www.example.com/', cookieTemplate: '',
  strategies: ['webview'], parser: 'autoDetect', waitFor: 'auto', challengeMarkers: DEFAULT_CHALLENGE_MARKERS,
  timeoutMs: 2000, storeHint: '', note: '',
};
const queryOf = (url: string) => new URL(url).searchParams.get('q') ?? new URL(url).searchParams.get('keyword') ?? '';
const apiUrl = (q: string, count = 24) => `https://api.example.com/search?keyword=${encodeURIComponent(q).replace(/%20/g, '+')}&count=${count}&offset=0`;
const apiJson = (q: string, n = 24) =>
  JSON.stringify({ total: 200, products: Array.from({ length: n }, (_, i) => ({ id: `${q}-${i}`, title: `Brand ${q} ${i}`, price: { current: 2 + i / 10 } })) });

/**
 * Plays a store's WebView with delays: a page load streams its results, then posts its data, with the page's own
 * navigation timing; replays answer after `replayMs`, with as many products as the request's count asks for, or as
 * `answer` says.
 */
function slowWebView(
  lane: WebViewQueue,
  opts: { loadMs?: number; replayMs?: number; answer?: (q: string, count: number) => { status?: number; text: string } } = {},
) {
  const loadMs = opts.loadMs ?? 40;
  const seen = { pageLoads: 0, replays: [] as string[] };
  let last = -1;
  lane.subscribe(() => {
    const s = lane.getSnapshot();
    if (!s || s.phase !== 'hidden' || s.id === last) return;
    last = s.id;
    seen.pageLoads++;
    const started = Date.now();
    const q = queryOf(s.url);
    const request = { method: 'GET', url: apiUrl(q), headers: {}, credentials: 'include' };
    const sources = [{ label: `response ${request.url}`, text: apiJson(q), request }];
    const nav = { start: started + 5, html: started + Math.round(loadMs / 3) };
    setTimeout(() => lane.receive(JSON.stringify({ nonce: nonceOf(s.script), kind: 'progress', sources, nav })), Math.round(loadMs / 2));
    setTimeout(() => lane.receive(JSON.stringify({ nonce: nonceOf(s.script), kind: 'data', href: s.url, sources, nav })), loadMs);
  });
  lane.attach((script) => {
    if (!script.includes('REQ = ')) return; // The page's own script being told to stop, say.
    const { nonce, req } = replayOf(script);
    seen.replays.push(req.url);
    const count = Number(new URL(req.url).searchParams.get('count') ?? 24);
    const { status = 200, text } = opts.answer ? opts.answer(queryOf(req.url), count) : { text: apiJson(queryOf(req.url), Math.min(24, count)) };
    setTimeout(() => lane.receive(JSON.stringify({ kind: 'replay', nonce, status, url: req.url, type: 'application/json', text, bytes: text.length })), opts.replayMs ?? 15);
  });
  return seen;
}

(async () => {
  // --- (a) Timelines ---------------------------------------------------------------------------------------------
  await t('timeline: a page load’s parts, from its lane’s moments; a failed load is marked; a bot check sits between loads', () => {
    assert.deepEqual(shape(loadSpans({ queuedAt: 0, startedAt: 100, navAt: 300, htmlAt: 900, dataAt: 2000, doneAt: 2700 })), [
      ['wait', 0, 100], ['start', 100, 300], ['open', 300, 900], ['prices', 900, 2000], ['settle', 2000, 2700],
    ]);
    assert.deepEqual(shape(loadSpans({ queuedAt: 0, startedAt: 0, doneAt: 5000 }, false)), [['open', 0, 5000, '✗']], 'timed out with nothing in');
    assert.deepEqual(
      shape(loadSpans({ queuedAt: 0, startedAt: 4000, check: { loadFrom: 0, from: 500, to: 4000 }, navAt: 4100, htmlAt: 4500, dataAt: 4600, doneAt: 4700 })),
      [['open', 0, 500], ['check', 500, 4000], ['start', 4000, 4100], ['open', 4100, 4500], ['prices', 4500, 4600], ['settle', 4600, 4700]],
    );
    assert.deepEqual(shape(loadSpans({ queuedAt: 0, startedAt: 100, navAt: 50, htmlAt: 9000, dataAt: 600, doneAt: 800 })), [
      ['wait', 0, 100], ['open', 100, 600], ['settle', 600, 800],
    ], 'moments the page reported out of place are left out');
    assert.deepEqual(shape(replaySpans({ askedAt: 0, sentAt: 40, doneAt: 400 })), [['wait', 0, 40], ['replay', 40, 400]]);
    assert.deepEqual(
      shape(loadSpans({ queuedAt: 0, startedAt: 0, navAt: 100, htmlAt: 800, dataAt: 1200, acceptedAt: 2500, doneAt: 3200 })),
      [['start', 0, 100], ['open', 100, 800], ['prices', 800, 2500], ['settle', 2500, 3200]],
      'waiting for prices lasts until the results were taken, not the first priced response',
    );
    assert.deepEqual(loadNotes({ queuedAt: 0, navAt: 1000, fetchAt: 2300, url: 'https://www.aldi.us/store/aldi/s?k=milk', pageUrl: 'https://new.aldi.us/results?q=milk' }), [
      'redirects took 1.30 s',
      'ended up at new.aldi.us/results',
    ]);
    assert.deepEqual(loadNotes({ queuedAt: 0, navAt: 1000, fetchAt: 1010, url: 'https://www.target.com/s?searchTerm=milk', pageUrl: 'https://www.target.com/s?searchTerm=milk&x=1' }), []);
    assert.deepEqual(
      shape(loadSpans({ queuedAt: 0, startedAt: 0, openedAt: 1400, navAt: 1450, htmlAt: 2000, dataAt: 2500, doneAt: 2600 })),
      [['start', 0, 1400], ['open', 1400, 2000], ['prices', 2000, 2500], ['settle', 2500, 2600]],
      'the browser’s own word for when it began loading',
    );
    assert.deepEqual(loadNotes({ queuedAt: 0, navigations: 2, ended: 'quiet' }), [
      'the site moved on to another page once',
      'it ended when its page went quiet, not as its results came in',
    ]);
    assert.deepEqual(loadNotes({ queuedAt: 0, navigations: 1, ended: 'results' }), []);
    assert.deepEqual(loadNotes({ queuedAt: 0, openedAt: 100, navAt: 1500, fetchAt: 1505 }), ['the page itself started 1.40 s after its browser began loading it']);
    assert.deepEqual(shape(replaySpans({ askedAt: 0, sentAt: 0, doneAt: 10_000 }, false)), [['replay', 0, 10_000, '✗']]);

    const clock = new SpanLog();
    clock.add('wait', 0, 50);
    clock.replay({ askedAt: 50, sentAt: 50, doneAt: 300 });
    clock.add('parse', 300, 320);
    clock.failSince(1);
    clock.add('parse', 330, 330);
    assert.deepEqual(kinds(clock.spans), ['wait', 'replay✗', 'parse✗'], 'waiting isn’t a failure; nothing of no length');
    const line = timelineOf(1000, 1400, 2000, { startedAt: 1400, endedAt: 2000, spans: [{ kind: 'replay', start: 1400, end: 1900 }] });
    assert.deepEqual(shape(line.spans), [['queue', 1000, 1400], ['replay', 1400, 1900]]);
    assert.equal(markShown(line, 2030), true);
    assert.equal(markShown(line, 2500), false, 'the first time a screen showed it');
    assert.equal(shownAt(line), 2030);
  });

  await t('where the time went: each moment counted once, for its most direct cause; failed tries and gaps apart', () => {
    const spans: TimingSpan[] = [
      { kind: 'open', start: 0, end: 1000 },
      { kind: 'wait', start: 0, end: 1000 },
      { kind: 'replay', start: 1000, end: 1300 },
      { kind: 'wait', start: 0, end: 1000 },
      { kind: 'replay', start: 1000, end: 1500, ok: false },
      { kind: 'parse', start: 1600, end: 1700 },
    ];
    assert.deepEqual(paceOf(spans, 0, 1800), { open: 1000, replay: 300, failed: 200, idle: 200, parse: 100 });
  });

  await t('speed test end to end: the first search loads the page, the rest wait for it or queue, then replay; the profile says where it went', async () => {
    const pool = new WebViewPool();
    const seen = slowWebView(pool.lane('example', 'Example'), { loadMs: 60, replayMs: 20 });
    const searcher = createRetailerSearch(pool, 'test', new StoreTuner());
    const engine = new PricingEngine((c, q, s) => searcher.search(c, q, s), new PriceCache());
    const items = ['milk', 'eggs', 'bread', 'bananas', 'butter', 'coffee'];
    engine.start('S', items, [{ config: example, storeId: '', storeKey: 'k' }], { refresh: true });
    for (let i = 0; i < 300 && !engine.getRun('S')?.finishedAt; i++) await tick(5);
    const run = engine.getRun('S')!;
    assert.ok(run.finishedAt, 'finished');
    assert.equal(seen.pageLoads, 1);

    const profile = speedProfile(run, () => undefined);
    const store = profile.stores[0];
    assert.equal(store.rows.length, 6);
    assert.equal(profile.slowest, store);
    const [first, ...rest] = store.rows;
    assert.deepEqual([first.query, first.how], ['milk', 'page load']);
    assert.ok(['start', 'open', 'prices'].every((k) => kinds(first.spans).includes(k)), kinds(first.spans).join(' '));
    const settled = first.spans.filter((x) => x.kind === 'settle').reduce((n, x) => n + x.end - x.start, 0);
    assert.ok(settled <= 3, `its own answer, whole, ended the load at once (${settled} ms after)`);
    assert.equal(store.pageLoads.length, 1);
    assert.ok(store.pageLoads[0] >= 25 && store.pageLoads[0] < 55, `ended when its answer streamed in, not when the page posted its data: ${store.pageLoads[0]} ms`);
    assert.ok(rest.every((r) => r.how === 'reused its page' && kinds(r.spans).includes('replay')));
    const longest = (r: (typeof rest)[number], kind: string) => Math.max(0, ...r.spans.filter((s) => s.kind === kind).map((s) => s.end - s.start));
    assert.ok(rest.slice(0, 2).every((r) => longest(r, 'wait') >= 20), 'the two searches started with it waited for its page');
    assert.ok(rest.slice(2).every((r) => longest(r, 'queue') >= 20), 'the rest waited for a turn: 3 at once to start with');
    assert.equal(store.replays.length, 5);
    const paced = Object.values(store.pace).reduce((a, b) => a + (b ?? 0), 0);
    assert.equal(paced, store.endMs, 'every moment counted once');
    assert.ok((store.pace.start ?? 0) + (store.pace.open ?? 0) + (store.pace.prices ?? 0) >= 20);
    assert.match(profile.findings.join('\n'), /1 page load: /);
    assert.match(profile.findings.join('\n'), /5 requests from kept pages/);

    // A screen showed them: 'to the screen' joins each timeline.
    for (const r of Object.values(run.results.example)) if (r.timing) markShown(r.timing, r.timing.endedAt + 12);
    const onScreen = speedProfile(run);
    assert.ok(onScreen.stores[0].rows.every((r) => kinds(r.spans).at(-1) === 'show'));
    assert.equal(onScreen.totalMs, profile.totalMs + 12);
    const text = speedProfileText(onScreen);
    assert.match(text, /^Where the \d+\.\d+ s went \(Example finished last\):/);
    assert.match(text, /\n {2}milk: 0\.00–\d\.\d\d, page load: start 0\.\d\d, html 0\.\d\d, prices 0\.\d\d, (parse 0\.\d\d, )?screen 0\.01/);
    assert.match(text, /\n {2}butter: .*, reused its page: queue 0\.\d\d, replay 0\.\d\d/);
  });

  await t('speed test: a failed search keeps its timeline, marked failed, and says why', async () => {
    const pool = new WebViewPool();
    const lane = pool.lane('example', 'Example');
    lane.subscribe(() => {
      const s = lane.getSnapshot();
      if (s?.phase === 'hidden') setTimeout(() => lane.receive(JSON.stringify({ nonce: nonceOf(s.script), kind: 'error', error: 'no_payload' })), 10);
    });
    const searcher = createRetailerSearch(pool, 'test');
    const engine = new PricingEngine((c, q, s) => searcher.search(c, q, s), new PriceCache(), 4, 1);
    engine.start('F', ['milk'], [{ config: example, storeId: '', storeKey: 'k' }], { refresh: true });
    for (let i = 0; i < 200 && !engine.getRun('F')?.finishedAt; i++) await tick(5);
    const row = speedProfile(engine.getRun('F')!, () => undefined).stores[0].rows[0];
    assert.deepEqual([row.ok, row.how], [false, 'failed: no product data']);
    assert.ok(row.spans.some((s) => s.kind === 'open' && s.ok === false));
  });

  // --- Fixes: less work while a page loads ------------------------------------------------------------------------
  const pageWith = (html: string, url: string) => {
    const dom = new JSDOM(html, { url, runScripts: 'outside-only' });
    const w = dom.window as any;
    const posts: any[] = [];
    w.ReactNativeWebView = { postMessage: (x: string) => posts.push(JSON.parse(x)) };
    return { w, posts, run: (script: string) => assert.equal(w.eval(script), true) };
  };

  await t('streamed prices are posted as they’re captured, not at the page script’s next look; a burst goes together', async () => {
    const p = pageWith('<html><head><title>milk</title></head><body></body></html>', 'https://www.example.com/s?q=milk');
    const body = apiJson('milk', 5);
    p.w.fetch = (url: string) => Promise.resolve({ status: 200, url, headers: { get: () => 'application/json' }, clone: () => ({ text: () => Promise.resolve(body) }), text: () => Promise.resolve(body) });
    p.run(captureScript());
    p.run(extractionScript('e1', DEFAULT_CHALLENGE_MARKERS, undefined, { waitFor: 'auto', progress: true, intervalMs: 5000, maxTries: 5, giveUpMs: 0 }));
    await p.w.fetch('https://api.example.com/search?q=milk');
    await p.w.fetch('https://api.example.com/sponsored?q=milk');
    await tick(80);
    const progress = p.posts.filter((m) => m.kind === 'progress');
    assert.equal(progress.length, 1, 'one post for the burst, long before the next look (5 s)');
    assert.equal(progress[0].sources.length, 2);
  });

  await t('the bot check test doesn’t write out a big page at every look; a short page is still checked', async () => {
    const many = `<html><head><title>Search</title></head><body>${'<div>x</div>'.repeat(1200)}<div id="px-captcha"></div></body></html>`;
    const big = pageWith(many, 'https://www.example.com/s?q=milk');
    let serialized = 0;
    const inner = Object.getOwnPropertyDescriptor(big.w.Element.prototype, 'innerHTML')!;
    Object.defineProperty(big.w.Element.prototype, 'innerHTML', { get() { serialized++; return inner.get!.call(this); }, configurable: true });
    big.run(extractionScript('e2', DEFAULT_CHALLENGE_MARKERS, undefined, { waitFor: 'auto', intervalMs: 5, maxTries: 4, giveUpMs: 0 }));
    await tick(60);
    assert.equal(serialized, 0);
    assert.notEqual(big.posts[0]?.kind, 'challenge');
    const small = pageWith('<html><head><title>One moment</title></head><body><div id="px-captcha"></div></body></html>', 'https://www.example.com/s?q=milk');
    small.run(extractionScript('e3', DEFAULT_CHALLENGE_MARKERS, undefined, { waitFor: 'auto', intervalMs: 5, maxTries: 4 }));
    await tick(30);
    assert.equal(small.posts[0].kind, 'challenge');
  });

  await t('a page load reads each streamed response once, not everything so far with each new one', async () => {
    const reads: number[] = [];
    PARSERS.countingReader = (payload, ctx) => {
      reads.push(payload.sources?.length ?? 0);
      return autoDetect(payload, ctx);
    };
    const pool = new WebViewPool();
    const lane = pool.lane('example', 'Example');
    let last = -1;
    lane.subscribe(() => {
      const s = lane.getSnapshot();
      if (!s || s.phase !== 'hidden' || s.id === last) return;
      last = s.id;
      const nonce = nonceOf(s.script);
      const batch = (name: string, n: number) => [{ label: `response https://api.example.com/${name}`, text: apiJson(name === 'search' ? 'milk' : name, n) }];
      // Two responses without enough products, then the results: each is read as it comes, once.
      setTimeout(() => lane.receive(JSON.stringify({ nonce, kind: 'progress', sources: batch('ads', 1) })), 2);
      setTimeout(() => lane.receive(JSON.stringify({ nonce, kind: 'progress', sources: batch('recommended', 2) })), 4);
      setTimeout(() => lane.receive(JSON.stringify({ nonce, kind: 'progress', sources: batch('search', 8) })), 6);
    });
    const searcher = createRetailerSearch(pool, 'test', new StoreTuner());
    const got = await searcher.search({ ...example, parser: 'countingReader', timeoutMs: 5000 }, 'milk', '');
    delete PARSERS.countingReader;
    assert.equal(got.products.length, 8);
    assert.deepEqual(reads, [1, 1, 1, 3], 'three reads as they came, then the whole payload once at the end');
  });

  // --- (b) Leaner store requests ----------------------------------------------------------------------------------
  await t('page size: found in the URL (count, page.size, rows), kept where it isn’t a page size, rewritten to what the app keeps', () => {
    const get = (url: string) => ({ method: 'GET', url });
    const target = get('https://redsky.target.com/redsky_aggregations/v1/web/plp_search_v2?key=abc&channel=WEB&count=24&keyword=milk&offset=0&page=%2Fs%2Fmilk&pricing_store_id=1234');
    const lean = leanRequest(target, 12)!;
    assert.deepEqual([lean.from, lean.spots], [24, 1]);
    assert.equal(lean.request.url, target.url.replace('count=24', 'count=12'), 'nothing else touched, offset included');
    assert.equal(leanRequest(get('https://www.kroger.com/atlas/v1/search/v1/products-search?filter.query=milk&page.size=24&page.offset=0'), 12)!.request.url,
      'https://www.kroger.com/atlas/v1/search/v1/products-search?filter.query=milk&page.size=12&page.offset=0');
    assert.equal(leanRequest(get('https://www.safeway.com/abs/pub/xapi/pgmsearch/v1/search/products?q=hot+dogs&rows=30&start=0'), 12)!.request.url,
      'https://www.safeway.com/abs/pub/xapi/pgmsearch/v1/search/products?q=hot+dogs&rows=12&start=0', '“+” spacing kept');
    assert.equal(leanRequest(get('https://api.example.com/s?q=milk&page[size]=48#top'), 12)!.request.url, 'https://api.example.com/s?q=milk&page[size]=12#top');
    for (const url of ['https://api.example.com/s?q=milk&count=10', 'https://api.example.com/s?q=milk&size=large', 'https://api.example.com/s?q=milk&limit=5000', 'https://api.example.com/s?q=milk&per_page=12', 'https://api.example.com/s?q=milk']) {
      assert.equal(leanRequest(get(url), 12), null, url);
    }
  });

  await t('page size: JSON bodies, GraphQL variables (in the URL or the body), search-engine params and forms stay valid', () => {
    const post = (body: string, headers: Record<string, string> = { 'content-type': 'application/json' }) => ({ method: 'POST', url: 'https://api.example.com/search', body, headers });
    const es = leanRequest(post(JSON.stringify({ query: 'milk', size: 24, from: 0, image: { size: 300 } })), 12)!;
    assert.deepEqual(JSON.parse(es.request.body!), { query: 'milk', size: 12, from: 0, image: { size: 300 } }, 'an image’s size is left alone');
    const gql = leanRequest(post(JSON.stringify({ operationName: 'SearchProducts', variables: { query: 'milk', limit: '60', offset: 0 } })), 12)!;
    assert.deepEqual([JSON.parse(gql.request.body!).variables, gql.from], [{ query: 'milk', limit: '12', offset: 0 }, 60], 'a number written as text stays text');
    const vars = encodeURIComponent(JSON.stringify({ query: 'milk', first: 40 }));
    const inUrl = leanRequest({ method: 'GET', url: `https://www.example.com/graphql?operationName=Search&variables=${vars}` }, 12)!;
    assert.deepEqual(JSON.parse(new URL(inUrl.request.url).searchParams.get('variables')!), { query: 'milk', first: 12 });
    const algolia = leanRequest(post(JSON.stringify({ requests: [{ indexName: 'products', params: 'query=milk&hitsPerPage=40&page=0' }] })), 12)!;
    assert.equal(JSON.parse(algolia.request.body!).requests[0].params, 'query=milk&hitsPerPage=12&page=0');
    const form = leanRequest(post('q=milk&num=36', { 'content-type': 'application/x-www-form-urlencoded' }), 12)!;
    assert.equal(form.request.body, 'q=milk&num=12');
    const both = { method: 'POST', url: 'https://api.example.com/search?count=24', body: JSON.stringify({ q: 'milk', limit: 60 }), headers: { 'content-type': 'application/json' } };
    assert.deepEqual(pageSizeSpots(both), [{ where: 'url', key: 'count', value: 24 }, { where: 'body', key: 'limit', value: 60 }]);
    assert.deepEqual([leanRequest(both, 12)!.spots, leanRequest(both, 12)!.from], [2, 60]);
    assert.equal(leanRequest(post('not json at all'), 12), null);
  });

  await t('page size: a lean answer is good with enough relevant products; fewer is checked; more means ignored; the data saved', () => {
    assert.equal(leanVerdict({ usable: true, products: 12, relevant: true }, 12, 9), 'good');
    assert.equal(leanVerdict({ usable: true, products: 10, relevant: true }, 12, 9), 'good', 'unpriced ones dropped');
    assert.equal(leanVerdict({ usable: true, products: 4, relevant: true }, 12, 9), 'fewer');
    assert.equal(leanVerdict({ usable: true, products: 24, relevant: true }, 12, 9), 'ignored');
    assert.equal(leanVerdict({ usable: true, products: 16, relevant: true }, 12, 9, 28), 'good', '12 as asked, and 4 ads on top: fewer than the page’s 28');
    assert.equal(leanVerdict({ usable: true, products: 28, relevant: true }, 12, 9, 28), 'ignored', 'as many as the page’s own');
    assert.equal(leanVerdict({ usable: false, products: 0, relevant: true }, 12, 9), 'broken');
    assert.equal(leanVerdict({ usable: true, products: 12, relevant: false }, 12, 9), 'broken');
    const baseline = { chars: 240_000, products: 24 };
    assert.equal(leanSaving(baseline, { chars: 120_000, products: 12 }, 9), 120_000);
    assert.equal(leanSaving(baseline, { chars: 120_000, bytes: 30_000, products: 12 }, 9), 30_000, 'as compressed as the lean answer was');
    assert.equal(leanSaving(baseline, { chars: 40_000, products: 4 }, 9), 0, 'this search has no more to hold back');
    assert.equal(leanSaving({ chars: 100_000, products: 12 }, { chars: 90_000, products: 12 }, 9), 0, 'the page’s own answer had no more');
    assert.equal(leanSaving(undefined, { chars: 1, products: 12 }, 9), 0);
  });

  // --- (c) Adaptive per-store tuning ------------------------------------------------------------------------------
  const NOW = 10_000_000;
  const base = { pageTimeoutMs: 20_000 };
  const samples = (n: number, over: Partial<TuningSample> | ((i: number) => Partial<TuningSample>)): TuningSample[] =>
    Array.from({ length: n }, (_, i) => ({ at: NOW - (n - i) * 5000, ok: true, ms: 500, ...(typeof over === 'function' ? over(i) : over) }));

  await t('tuning: unknown stores get the usual; healthy ones get more at once, whatever their speed, with timeouts to match', () => {
    const fresh = tuneStore([], base, NOW);
    assert.deepEqual([fresh.level, fresh.searches, fresh.replays, fresh.pageTimeoutMs, fresh.replayTimeoutMs, fresh.gapMs], ['normal', 3, 3, 20_000, REPLAY_TIMEOUT_MS, 0]);
    assert.match(fresh.why, /not enough searches yet/);
    assert.equal(tuneStore(samples(2, { replayMs: 400 }), base, NOW).level, 'normal', 'two searches aren’t enough to tell');
    // Quick: a stuck request is given up on sooner.
    const quick = tuneStore([...samples(1, { loadMs: 2000, ms: 2100 }), ...samples(7, (i) => ({ replayMs: 400 + i * 30 }))], base, NOW);
    assert.deepEqual([quick.level, quick.searches, quick.replays, quick.pageTimeoutMs, quick.replayTimeoutMs], ['wide', 6, 6, 10_000, 4000]);
    assert.equal(quick.why, 'healthy: its last 8 searches worked, its replays take 0.5 s');
    // Slow, and healthy: more at once all the same (it gains the most from not waiting in line), and more time.
    const slow = tuneStore(samples(5, (i) => ({ replayMs: 3000 + i * 200 })), base, NOW);
    assert.deepEqual([slow.level, slow.searches, slow.replayTimeoutMs], ['wide', 6, 11_400]);
    assert.equal(slow.why, 'healthy: its last 5 searches worked, its replays take 3.4 s, so it gets more time');
    // Plain requests are whole search pages: never more than the usual 3 at once.
    const plain = tuneStore(samples(6, { ms: 3000 }), { ...base, plain: true }, NOW);
    assert.deepEqual([plain.level, plain.searches, plain.replays], ['wide', 3, 6]);
    assert.match(plain.why, /its searches take 3\.0 s; plain requests stay 3 at once, each a whole search page$/);
    // An official API: more of its calls at once.
    const api = tuneStore(samples(6, { api: true, ms: 2500 }), { ...base, api: true }, NOW);
    assert.deepEqual([api.level, api.searches], ['wide', 8]);
    assert.match(api.why, /its API answers in 2\.5 s/);
    assert.deepEqual([tuneStore([], { ...base, api: true }, NOW).searches], [6]);
  });

  await t('tuning: a store that has worked today starts with more at once; its failures and pushback are forgiven after 15 minutes', () => {
    const earlier = (n: number, over: Partial<TuningSample>) => samples(n, over).map((x) => ({ ...x, at: x.at - 40 * 60_000 }));
    assert.equal(tuneStore(earlier(6, { replayMs: 900 }), base, NOW).level, 'wide', 'six searches that worked 40 minutes ago');
    assert.equal(tuneStore(earlier(6, { replayMs: 900 }).map((x) => ({ ...x, at: x.at - 24 * 60 * 60_000 })), base, NOW).level, 'normal', 'not yesterday’s');
    assert.equal(tuneStore([...earlier(5, { replayMs: 900 }), ...earlier(3, { ok: false, reason: 'timeout' })], base, NOW).level, 'wide', 'old failures are forgiven');
    assert.equal(tuneStore(earlier(4, { ok: false, reason: 'no_payload' }), base, NOW).level, 'normal', 'failures alone never make a store healthy');
    assert.equal(tuneStore([...earlier(6, { replayMs: 900 }), ...earlier(1, { ok: false, reason: 'challenge' })], base, NOW).level, 'wide', 'a bot check 40 minutes ago is forgiven');
    const mixed = tuneStore([...earlier(2, { ok: false, reason: 'no_payload' }), ...samples(4, { replayMs: 800 })], base, NOW);
    assert.deepEqual([mixed.level, mixed.why], ['wide', 'healthy: 4 of its last 6 searches worked, none failing lately, its replays take 0.8 s']);
  });

  await t('tuning: failing stores get fewer at once and more time; one failure keeps a store usual; the window forgives', () => {
    const failing = tuneStore([...samples(6, { replayMs: 500 }), ...samples(2, { ok: false, reason: 'no_payload', ms: 3000 })], base, NOW);
    assert.deepEqual([failing.level, failing.searches, failing.replays], ['narrow', 2, 2]);
    assert.equal(failing.why, '2 of its last 8 searches failed: fewer at once, more time');
    const timeout = tuneStore(samples(3, { ok: false, reason: 'timeout', ms: 20_000 }).slice(-1), base, NOW);
    assert.deepEqual([timeout.level, timeout.pageTimeoutMs], ['narrow', 30_000], '1.5 × its rules’ 20 s');
    assert.deepEqual([tuneStore(samples(3, { ok: false, reason: 'timeout' }), { ...base, api: true }, NOW).searches], [3], 'an API, narrower');
    const once = tuneStore([...samples(6, { replayMs: 500 }), ...samples(1, { ok: false, reason: 'no_payload' })], base, NOW);
    assert.deepEqual([once.level, once.why], ['normal', 'one of its last 7 searches failed']);
    const ours = tuneStore([...samples(6, { replayMs: 500 }), ...samples(2, { ok: false, reason: 'polite_limit' })], base, NOW);
    assert.equal(ours.level, 'wide', 'the phone’s own hourly limit says nothing about the store');
    const old = samples(4, { ok: false, reason: 'timeout' }).map((x) => ({ ...x, at: x.at - 20 * 60_000 }));
    assert.equal(tuneStore(old, base, NOW).level, 'normal', 'failures from more than 15 minutes ago are forgiven');
  });

  await t('tuning: a store that pushes back gets one search at a time, paced; near its hourly limit, one at a time', () => {
    const once = tuneStore([...samples(8, { replayMs: 300 }), ...samples(1, { limited: true })], base, NOW);
    assert.deepEqual([once.level, once.searches, once.replays, once.gapMs], ['careful', 1, 1, 5000]);
    assert.match(once.why, /“too many requests” once in the last 15 minutes: one search at a time, 5\.0 s apart/);
    assert.equal(tuneStore(samples(2, { ok: false, reason: 'http_429' }), base, NOW).gapMs, 10_000, 'doubling');
    assert.equal(tuneStore(samples(5, { ok: false, reason: 'replay_429' }), base, NOW).gapMs, 30_000, 'up to 30 s');
    const checked = tuneStore(samples(1, { ok: false, reason: 'challenge' }), { ...base, api: true }, NOW);
    assert.deepEqual([checked.level, checked.searches, checked.gapMs], ['careful', 1, 3000]);
    const near = tuneStore(samples(8, { replayMs: 300 }), base, NOW, { used: 100, perHour: 120 });
    assert.deepEqual([near.level, near.searches], ['careful', 1]);
    assert.match(near.why, /near its hourly limit \(100 of 120 searches in the last hour\)/);
  });

  await t('tuning: the tuner keeps each store’s last searches, paces pushed-back stores, counts crashes, and can be switched off', () => {
    let now = NOW;
    const tuner = new StoreTuner(() => now);
    for (const x of samples(7, { replayMs: 300 })) tuner.record('a', x);
    assert.equal(tuner.get('a', base).level, 'wide');
    assert.equal(tuner.get('b', base).level, 'normal');
    tuner.enabled = false;
    assert.deepEqual([tuner.get('a', base).level, tuner.get('a', base).searches, tuner.get('a', base).why], ['normal', 3, 'fixed: adapting to each store is off']);
    tuner.enabled = true;
    assert.deepEqual([tuner.delay('a', 0), tuner.delay('a', 3000), tuner.delay('a', 3000), tuner.delay('a', 3000)], [0, 0, 3000, 6000]);
    now += 7000;
    assert.equal(tuner.delay('a', 3000), 2000);
    assert.equal(tuner.storesAtOnce(4), 4);
    tuner.crashed();
    assert.equal(tuner.storesAtOnce(4), 3);
    tuner.crashed();
    tuner.crashed();
    assert.equal(tuner.storesAtOnce(4), 2, 'never below 2');
    assert.equal(storesAtOnce(0, 4), 4);
    const seeded = new StoreTuner(() => NOW);
    seeded.seed([
      { at: NOW - 60_000, retailerId: 'c', kind: 'search', ok: false, reason: 'challenge', ms: 900 },
      { at: NOW - 60 * 60_000, retailerId: 'd', kind: 'search', ok: false, reason: 'challenge', ms: 900 },
      { at: NOW - 60_000, retailerId: 'd', kind: 'store', ok: false, reason: 'challenge', ms: 900 },
    ]);
    assert.deepEqual([seeded.get('c', base).level, seeded.get('d', base).level], ['careful', 'normal'], 'from the saved log, recent searches only');
  });

  // --- (c) One search for items that can share it ----------------------------------------------------------------
  const item = (name: string, over: Partial<ListItem> = {}): ListItem => ({ id: name, name, qty: 1, checked: false, ...over });
  const listOf = (...items: ListItem[]): Pick<GroceryList, 'items'> => ({ items });
  const product = (name: string, over: Partial<Product> = {}): Product => ({ retailer: 's', storeId: '', id: name, name, price: 3, ...over });

  await t('sharing: an item whose words all come from another item’s, ending on the same thing, can take its search', () => {
    const plan = sharePlan(listOf(
      item('Milk'), item('Whole milk'), item('Organic whole milk'), item('2% milk'), item('Almond milk'),
      item('Butter'), item('Peanut butter'), item('Hot dogs'), item('Hot dog buns'), item('Eggs'),
      item('Large eggs', { prefs: { size: '18 ct' } }), item('Brown eggs', { exact: { name: 'Brown Eggs', retailerId: 's', productId: '1' } }),
      item('Cage free eggs'), item('Bread'), item('Wheat bread', { prefs: { organic: true } }),
    ), { 'cage free eggs': { s: 'p9' } });
    assert.deepEqual(plan, {
      'whole milk': 'milk',
      'organic whole milk': 'milk',
      '2% milk': 'milk',
      'almond milk': 'milk',
      'peanut butter': 'butter',
      'organic wheat bread': 'bread',
    });
    assert.deepEqual(sharePlan(listOf(item('Whole milk'), item('Skim milk'))), {}, 'no broader search on the list');
    assert.deepEqual(sharePlan(listOf(item('Milk'), item('milk '))), {}, 'the same search is one search already');
  });

  await t('sharing: a product counts only when it says the item word for word, near the top, and is no other kind of grocery', () => {
    assert.equal(saysItem('Great Value Whole Milk, 1 Gallon, 128 fl oz', 'whole milk'), true);
    assert.equal(saysItem('Horizon Organic Whole Milk, Half Gallon', 'organic whole milk'), true);
    assert.equal(saysItem('Fairlife Whole Ultra-Filtered Milk', 'whole milk'), false, 'not word for word');
    assert.equal(saysItem('Galbani Whole Milk Mozzarella Cheese, 16 oz', 'whole milk'), false, 'mozzarella');
    assert.equal(saysItem('Tillamook Cheddar Cheese Made with Whole Milk', 'whole milk'), false, 'cheese');
    assert.equal(saysItem('Jif Creamy Peanut Butter, 16 oz', 'peanut butter'), true);
    assert.equal(saysItem('Stubb’s Sweet Apple BBQ Sauce', 'apple sauce'), false);
    const milk = [
      product('Great Value 2% Reduced Fat Milk'), product('Fairlife Whole Ultra-Filtered Milk'), product('Horizon Whole Milk', { sponsored: true }),
      product('Great Value Whole Milk, 1 Gallon'), product('Great Value Fat Free Milk'), product('Lactaid Whole Milk'), product('Kroger Whole Milk'),
    ];
    assert.deepEqual(sharedProducts(milk, 'whole milk')!.map((p) => p.name), [
      'Great Value Whole Milk, 1 Gallon', 'Lactaid Whole Milk', 'Great Value 2% Reduced Fat Milk', 'Fairlife Whole Ultra-Filtered Milk',
      'Horizon Whole Milk', 'Great Value Fat Free Milk', 'Kroger Whole Milk',
    ], 'the ones that say it first, then the rest, in the store’s order; an ad and one past the top half don’t count');
    assert.equal(sharedProducts(milk, 'oat milk'), null, 'none says it: searched on its own');
    assert.equal(sharedProducts([...Array(6)].map((_, i) => product(`Milk ${i}`)).concat(product('Great Value Whole Milk')), 'whole milk'), null, 'too far down');
  });

  // --- (b) and (c) end to end --------------------------------------------------------------------------------------
  const countOf = (url: string) => new URL(url).searchParams.get('count');
  const leanOf = (pool: WebViewPool) => {
    const tpl = pool.lane('example').template;
    return tpl?.kind === 'json' ? tpl.lean : undefined;
  };

  await t('leaner requests: replays ask for what the app keeps, and say what that saved; the page’s own request is left alone', async () => {
    const pool = new WebViewPool();
    const seen = slowWebView(pool.lane('example', 'Example'), { loadMs: 20, replayMs: 5 });
    const searcher = createRetailerSearch(pool, 'test', new StoreTuner());
    const entries: { bytesSaved?: number }[] = [];
    searcher.onAttempt((e) => entries.push(e));
    const first = await searcher.search(example, 'milk', '');
    assert.deepEqual([first.via, first.products.length, first.bytesSaved], ['page', 24, undefined]);
    assert.deepEqual([leanOf(pool)?.state, leanOf(pool)?.from, leanOf(pool)?.to, leanOf(pool)?.baseline], ['trial', 24, 12, { chars: apiJson('milk').length, products: 24 }]);
    const eggs = await searcher.search(example, 'eggs', '');
    assert.deepEqual([eggs.via, eggs.products.length, countOf(seen.replays[0])], ['replay', 12, '12']);
    assert.equal(eggs.bytesSaved, apiJson('milk').length - apiJson('eggs', 12).length);
    assert.equal(leanOf(pool)?.state, 'on');
    const bread = await searcher.search(example, 'bread', '');
    assert.deepEqual([countOf(seen.replays[1]), bread.products.length], ['12', 12]);
    assert.deepEqual(entries.map((e) => e.bytesSaved ?? 0).map((b) => b > 0), [false, true, true], 'the data meter hears of it');
    assert.match(pool.feed.getSnapshot()[0].text, /^12 products · \d\.\d s · .+KB, .+KB saved · reused its page$/);

    // Off in Diagnostics: they ask as the page did.
    pool.setLeanRequests(false);
    await searcher.search(example, 'jam', '');
    assert.equal(countOf(seen.replays[2]), '24');
  });

  await t('leaner requests: a store that ignores the smaller size, or breaks with it, is asked as its page does from then on', async () => {
    // Ignored: as many as ever come back. A fine answer, nothing saved, and not asked that way again.
    const ignoring = new WebViewPool();
    const seenIgnoring = slowWebView(ignoring.lane('example', 'Example'), { loadMs: 20, replayMs: 5, answer: (q) => ({ text: apiJson(q, 24) }) });
    const a = createRetailerSearch(ignoring, 'test', new StoreTuner());
    await a.search(example, 'milk', '');
    const eggs = await a.search(example, 'eggs', '');
    assert.deepEqual([eggs.products.length, eggs.bytesSaved, leanOf(ignoring)?.state], [24, undefined, 'off']);
    await a.search(example, 'bread', '');
    assert.deepEqual(seenIgnoring.replays.map(countOf), ['12', '24']);

    // Broken: the store refuses it. The page's own request answers instead, and is used from then on, even from a new page.
    const breaking = new WebViewPool();
    const seenBreaking = slowWebView(breaking.lane('example', 'Example'), {
      loadMs: 20,
      replayMs: 5,
      answer: (q, count) => (count === 12 ? { status: 400, text: '{"error":"invalid count"}' } : { text: apiJson(q, count) }),
    });
    const b = createRetailerSearch(breaking, 'test', new StoreTuner());
    await b.search(example, 'milk', '');
    const butter = await b.search(example, 'butter', '');
    assert.deepEqual([butter.via, butter.products.length, leanOf(breaking)?.state], ['replay', 24, 'off']);
    assert.deepEqual(seenBreaking.replays.map(countOf), ['12', '24']);
    const spans = butter.timing!.spans.filter((x) => x.kind === 'replay').map((x) => x.ok !== false);
    assert.deepEqual(spans, [false, true], 'the timeline shows the lean try failed');
    breaking.lane('example').reset();
    await b.search(example, 'rice', '');
    assert.equal(leanOf(breaking)?.state, 'off', 'remembered for the store’s request, across page loads');

    // Fewer than it keeps, while on trial: checked against the page's own request. The same answer: the store just has no more.
    const few = new WebViewPool();
    slowWebView(few.lane('example', 'Example'), { loadMs: 20, replayMs: 5, answer: (q) => ({ text: apiJson(q, 4) }) });
    const c = createRetailerSearch(few, 'test', new StoreTuner());
    await c.search(example, 'milk', '');
    const saffron = await c.search(example, 'saffron', '');
    assert.deepEqual([saffron.products.length, leanOf(few)?.state], [4, 'trial']);
  });

  await t('tuning in searches: a store that answers “too many requests” gets one request at a time and a pause; replays follow the tuning', async () => {
    const pool = new WebViewPool();
    let limit = true;
    slowWebView(pool.lane('example', 'Example'), {
      loadMs: 20,
      replayMs: 5,
      answer: (q, count) => (limit ? { status: 429, text: '{"error":"too many requests"}' } : { text: apiJson(q, Math.min(24, count)) }),
    });
    const tuner = new StoreTuner();
    const searcher = createRetailerSearch(pool, 'test', tuner);
    await searcher.search(example, 'milk', '');
    assert.equal(tuner.get('example', { pageTimeoutMs: 2000 }).level, 'normal');
    await searcher.search(example, 'eggs', '').catch(() => {});
    const careful = tuner.get('example', { pageTimeoutMs: 2000 });
    assert.deepEqual([careful.level, careful.searches, careful.replays, careful.gapMs], ['careful', 1, 1, 5000]);
    limit = false;
    const t0 = Date.now();
    const next = searcher.search(example, 'bread', '');
    const after = searcher.search(example, 'jam', '');
    await next;
    assert.equal(pool.lane('example').maxReplays, 1);
    await after;
    assert.ok(Date.now() - t0 >= 4500, `the second waited for its pause (${Date.now() - t0} ms)`);
  });

  await t('leaner requests: a store that adds ads to the smaller page still counts as taking it; thrown-away answers count as data', async () => {
    const ads = new WebViewPool();
    slowWebView(ads.lane('example', 'Example'), { loadMs: 20, replayMs: 5, answer: (q, count) => ({ text: apiJson(q, count === 12 ? 16 : count) }) });
    const a = createRetailerSearch(ads, 'test', new StoreTuner());
    await a.search(example, 'milk', '');
    const eggs = await a.search(example, 'eggs', '');
    assert.deepEqual([eggs.products.length, leanOf(ads)?.state], [16, 'on']);
    assert.equal(eggs.bytesSaved, apiJson('milk').length - apiJson('eggs', 16).length);

    const refusing = new WebViewPool();
    const refusal = '{"error":"invalid count"}';
    slowWebView(refusing.lane('example', 'Example'), { loadMs: 20, replayMs: 5, answer: (q, count) => (count === 12 ? { status: 400, text: refusal } : { text: apiJson(q, count) }) });
    const b = createRetailerSearch(refusing, 'test', new StoreTuner());
    await b.search(example, 'milk', '');
    const butter = await b.search(example, 'butter', '');
    assert.equal(butter.bytes, apiJson('butter').length + refusal.length, 'the refused try moved data too');
  });

  await t('tuning in searches: a bot check to a plain request is the store pushing back, even when its page then works', async () => {
    const pool = new WebViewPool();
    slowWebView(pool.lane('example', 'Example'), { loadMs: 20, replayMs: 5 });
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string) => ({ status: 200, ok: true, url, text: async () => '<html><head><title>Robot or human?</title></head><body></body></html>' })) as unknown as typeof fetch;
    try {
      const tuner = new StoreTuner();
      const both = { ...example, strategies: ['fetch', 'webview'] as RetailerConfig['strategies'] };
      const got = await createRetailerSearch(pool, 'test', tuner).search(both, 'milk', '');
      assert.deepEqual([got.strategy, got.attempts.map((x) => x.reason ?? 'ok')], ['webview', ['challenge', 'ok']]);
      const now = tuner.get('example', { pageTimeoutMs: 2000, plain: true });
      assert.deepEqual([now.level, now.searches, now.gapMs], ['careful', 1, 3000]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  await t('findings: plain requests and API calls, how long each took and how many at once; waiting in line; notes per search', () => {
    const at = 1_000_000;
    const timeline = (spans: TimingSpan[], notes?: string[]) => ({ queuedAt: at, startedAt: spans[0].start, endedAt: spans[spans.length - 1].end, spans, ...(notes ? { notes } : {}) });
    const result = (query: string, spans: TimingSpan[], notes?: string[]) => ({ status: 'done' as const, query, products: [], strategy: 'fetch', at: at + 1, timing: timeline(spans, notes) });
    const run = {
      listId: 'S', retailerIds: ['w'], startedAt: at, finishedAt: at + 7000,
      stores: { w: { retailerId: 'w', name: 'Walmart', status: 'done' as const, total: 4, settled: 4, failed: 0, searching: [] } },
      results: {
        w: {
          milk: result('milk', [{ kind: 'fetch', start: at, end: at + 3900 }]),
          eggs: result('eggs', [{ kind: 'fetch', start: at, end: at + 4300 }]),
          bread: result('bread', [{ kind: 'fetch', start: at, end: at + 4600 }], ['ended up at www.walmart.com/search']),
          jam: result('jam', [{ kind: 'queue', start: at, end: at + 3900 }, { kind: 'fetch', start: at + 3900, end: at + 6500 }]),
        },
      },
    };
    const profile = speedProfile(run, () => undefined);
    assert.ok(profile.findings.includes('Walmart’s 4 plain requests took 2.6 s to 4.6 s each, 3 at a time at most.'), profile.findings.join('\n'));
    assert.ok(profile.findings.includes('Searches waited their turn, in all: Walmart 3.9 s.'), profile.findings.join('\n'));
    assert.match(speedProfileText(profile), /\n {2}bread: 0\.00–4\.60, direct request: fetch 4\.60 \[ended up at www\.walmart\.com\/search\]/);
  });

  await t('page loads: the results are recognized past a bigger unrelated list, and taken over it; a load that ended on its page’s say says where its products were', async () => {
    const pool = new WebViewPool();
    const lane = pool.lane('example', 'Example');
    const deals = JSON.stringify({ carousel: Array.from({ length: 20 }, (_, i) => ({ id: `deal-${i}`, title: `Weekly Deal ${i}`, price: { current: 5 } })) });
    let streamResults = true;
    let last = -1;
    lane.subscribe(() => {
      const s = lane.getSnapshot();
      if (!s || s.phase !== 'hidden' || s.id === last) return;
      last = s.id;
      const nonce = nonceOf(s.script);
      const q = queryOf(s.url);
      const request = { method: 'GET', url: apiUrl(q, 8), headers: {}, credentials: 'include' };
      const results = { label: `response ${request.url}`, text: apiJson(q, 8), request };
      const carousel = { label: 'response https://api.example.com/deals', text: deals };
      lane.loadStarted();
      setTimeout(() => lane.receive(JSON.stringify({ nonce, kind: 'progress', sources: [carousel] })), 3);
      if (streamResults) setTimeout(() => lane.receive(JSON.stringify({ nonce, kind: 'progress', sources: [results] })), 6);
      else setTimeout(() => lane.receive(JSON.stringify({ nonce, kind: 'data', href: s.url, sources: [carousel, results], ready: 'quiet' })), 12);
    });
    const searcher = createRetailerSearch(pool, 'test', new StoreTuner());
    const cfg = { ...example, timeoutMs: 5000, replay: false };
    const t0 = Date.now();
    const first = await searcher.search(cfg, 'milk', '');
    assert.ok(Date.now() - t0 < 2000, 'recognized as it streamed in, not at the timeout');
    assert.deepEqual([first.products.length, first.products[0].name], [8, 'Brand milk 0'], 'the results, not the 20 deals');
    streamResults = false;
    const second = await searcher.search(cfg, 'eggs', '');
    assert.equal(second.products[0].name, 'Brand eggs 0');
    assert.deepEqual(second.timing!.notes, [
      'it ended when its page went quiet, not as its results came in',
      'its products were in https://api.example.com/search, which never streamed in',
    ]);
  });

  await t('a bot check to a plain request rests plain requests at once: the next search goes straight to the page', async () => {
    const pool = new WebViewPool();
    slowWebView(pool.lane('example', 'Example'), { loadMs: 20, replayMs: 5 });
    const realFetch = globalThis.fetch;
    let asked = 0;
    globalThis.fetch = (async (url: string) => {
      asked++;
      return { status: 200, ok: true, url, text: async () => '<html><head><title>Robot or human?</title></head><body></body></html>' };
    }) as unknown as typeof fetch;
    try {
      const searcher = createRetailerSearch(pool, 'test', new StoreTuner());
      const both = { ...example, strategies: ['fetch', 'webview'] as RetailerConfig['strategies'] };
      await searcher.search(both, 'milk', '');
      const next = await searcher.search(both, 'eggs', '');
      assert.equal(asked, 1, 'one bot check is enough');
      assert.deepEqual(next.attempts.map((x) => [x.strategy, x.reason ?? 'ok']), [['fetch', 'resting'], ['webview', 'ok']]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  const milkProduct = (name: string, i: number): Product => ({ retailer: 's', storeId: '', id: `${name}-${i}`, name, price: 3 + i / 10 });
  const cfg = (id: string): RetailerConfig => ({ ...example, id, name: id.toUpperCase() });

  await t('engine: an item that can take another’s search waits for it and takes it; one whose product isn’t there searches after', async () => {
    const calls: string[] = [];
    const results: Record<string, string[]> = {
      milk: ['Great Value 2% Reduced Fat Milk', 'Great Value Whole Milk, 1 Gallon', 'Fairlife 2% Milk'],
      'oat milk': ['Oatly Oat Milk'],
      butter: ['Land O Lakes Salted Butter'],
      'peanut butter': ['Jif Creamy Peanut Butter'],
    };
    const search = async (c: RetailerConfig, q: string): Promise<SearchOutcome> => {
      calls.push(q);
      await tick(5);
      return { retailer: c.name, products: (results[q.toLowerCase()] ?? [`Brand ${q}`]).map(milkProduct), strategy: 'webview', via: 'replay', ms: 5, attempts: [] };
    };
    const engine = new PricingEngine(search, new PriceCache());
    const list = listOf(item('Whole milk'), item('Milk'), item('Oat milk'), item('Peanut butter'), item('Butter'));
    engine.start('L', list.items.map((i) => i.name), [{ config: cfg('s1'), storeId: '', storeKey: 'k' }], { share: sharePlan(list) });
    for (let i = 0; i < 200 && !engine.getRun('L')?.finishedAt; i++) await tick(5);
    const run = engine.getRun('L')!;
    assert.deepEqual(calls.sort(), ['Butter', 'Milk', 'Oat milk', 'Peanut butter'].sort(), 'whole milk wasn’t searched');
    const whole = run.results.s1['whole milk'];
    assert.deepEqual([whole.status, whole.sharedWith, whole.products[0].name], ['done', 'Milk', 'Great Value Whole Milk, 1 Gallon']);
    assert.equal(run.results.s1['oat milk'].sharedWith, undefined, 'not in the milk search: its own');
    assert.equal(run.results.s1['peanut butter'].sharedWith, undefined);
    const card = scorecard(run);
    assert.deepEqual([card.searches, card.shared, card.stores[0].shared], [4, 1, 1], 'a shared item isn’t a search');

    // Coming back with the milk search saved: whole milk takes it at once.
    const again = new PricingEngine(search, engineCache(engine));
    again.start('M', ['Whole milk', 'Milk'], [{ config: cfg('s1'), storeId: '', storeKey: 'k' }], { share: { 'whole milk': 'milk' } });
    assert.deepEqual([again.getRun('M')!.results.s1['whole milk'].status, again.getRun('M')!.finishedAt !== undefined], ['done', true]);
  });

  await t('engine: searches at once per store, and stores at once, follow the tuning as it changes mid-run', async () => {
    const inFlight = new Map<string, number>();
    const peaks: Record<string, number[]> = {};
    let storesPeak = 0;
    const search = async (c: RetailerConfig, q: string): Promise<SearchOutcome> => {
      inFlight.set(c.id, (inFlight.get(c.id) ?? 0) + 1);
      (peaks[c.id] ??= []).push(inFlight.get(c.id)!);
      storesPeak = Math.max(storesPeak, [...inFlight.values()].filter((n) => n > 0).length);
      await tick(8);
      inFlight.set(c.id, inFlight.get(c.id)! - 1);
      return { retailer: c.name, products: [milkProduct(q, 0)], strategy: 'webview', ms: 8, attempts: [] };
    };
    const engine = new PricingEngine(search, new PriceCache());
    let done = 0;
    engine.onSearched(() => done++);
    // One at a time for the first two searches, then five at once; two stores at once.
    engine.setConcurrency({ searches: () => (done < 2 ? 1 : 5), stores: () => 2 });
    const items = Array.from({ length: 9 }, (_, i) => `item ${i}`);
    engine.start('C', items, [cfg('a'), cfg('b'), cfg('c')].map((config) => ({ config, storeId: '', storeKey: 'k' })));
    for (let i = 0; i < 400 && !engine.getRun('C')?.finishedAt; i++) await tick(5);
    assert.ok(engine.getRun('C')!.finishedAt);
    assert.equal(storesPeak, 2, 'two stores at once');
    assert.deepEqual(peaks.a.slice(0, 2), [1, 1], 'one at a time to start');
    assert.equal(Math.max(...peaks.a), 5, 'then five at once');
  });

  log(`\n${passed} speed tests passed`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
