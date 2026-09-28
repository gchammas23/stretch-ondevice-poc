/// <reference types="node" />
import assert from 'node:assert/strict';
import { priceEvidence } from '../src/onDevice/evidence';
import { createRetailerSearch, SearchFailed } from '../src/onDevice/retailerSearch';
import { BUNDLED_CONFIG } from '../src/onDevice/retailers';
import { StoreTuner } from '../src/onDevice/tuning';
import type { RetailerConfig } from '../src/onDevice/types';
import { PAGE_LANE, WebViewPool } from '../src/onDevice/webviewPool';
import { WebViewQueue } from '../src/onDevice/webviewQueue';
import { DEFAULT_CHALLENGE_MARKERS } from '../src/onDevice/webviewScript';
import { PriceCache } from '../src/pricing/priceCache';
import { PricingEngine } from '../src/pricing/pricingEngine';

// Search events are logged for telemetry; keep them out of the test output.
const log = console.log;
console.log = (...args: unknown[]) => {
  if (!String(args[0]).startsWith('[on-device-')) log(...args);
};

const nonceOf = (script: string) => /var NONCE = "([^"]+)"/.exec(script)![1];
const replayOf = (script: string) => {
  const m = /var NONCE = ("[^"]*"), REQ = (\{.*\});\n/.exec(script)!;
  return { nonce: JSON.parse(m[1]) as string, req: JSON.parse(m[2]) as { url: string; method: string; headers?: Record<string, string>; expect: string } };
};
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const job = (over: Partial<Parameters<WebViewQueue['run']>[0]> = {}) => ({
  url: 'https://www.example.com/s?q=milk', challengeMarkers: ['/blocked?'], timeoutMs: 500, retailerName: 'Example', ...over,
});
const data = (lane: WebViewQueue, extra: Record<string, unknown> = {}) =>
  lane.receive(JSON.stringify({ nonce: nonceOf(lane.getSnapshot()!.script), kind: 'data', href: 'h', nextDataText: '{}', ...extra }));
const reply = (lane: WebViewQueue, nonce: string, extra: Record<string, unknown> = {}) =>
  lane.receive(JSON.stringify({ kind: 'replay', nonce, status: 200, url: 'u', type: 'application/json', text: '{}', ...extra }));

let passed = 0;
const t = async (name: string, fn: () => unknown) => { await fn(); passed++; log('ok -', name); };

(async () => {
  // --- One lane --------------------------------------------------------------------------------------
  await t('keepPage leaves the page loaded as the same load, then unloads it when idle', async () => {
    const lane = new WebViewQueue();
    lane.idleMs = 40;
    const p = lane.run(job({ keepPage: true }));
    const loading = lane.getSnapshot()!;
    data(lane);
    await p;
    const kept = lane.getSnapshot()!;
    assert.deepEqual([kept.phase, kept.id, kept.round, kept.script], ['idle', loading.id, loading.round, loading.script], 'no remount');
    assert.equal(lane.hasPage(), true);
    await tick(80);
    assert.equal(lane.getSnapshot(), null, 'unloaded after idleMs');
    assert.equal(lane.hasPage(), false);
  });

  await t('replays run inside the kept page, three at a time, and answer by nonce', async () => {
    const lane = new WebViewQueue();
    const injected: string[] = [];
    lane.attach((s) => injected.push(s));
    const load = lane.run(job({ keepPage: true }));
    data(lane);
    await load;
    const replies = [1, 2, 3, 4, 5].map((i) => lane.replay({ expect: 'json', method: 'GET', url: `https://api.example.com/s?q=${i}` }, 1000));
    assert.equal(injected.length, 3, 'three in flight');
    lane.receive(JSON.stringify({ kind: 'replay', nonce: 'forged', status: 200, text: 'x' }));
    const first = replayOf(injected[0]);
    reply(lane, first.nonce, { text: '{"n":1}', url: first.req.url });
    assert.equal(injected.length, 4, 'a slot freed up');
    assert.deepEqual(await replies[0], { status: 200, url: 'https://api.example.com/s?q=1', type: 'application/json', text: '{"n":1}', nextDataText: null, ld: undefined, title: undefined, short: undefined, bytes: undefined });
    for (const s of injected.slice(1)) reply(lane, replayOf(s).nonce);
    assert.equal(injected.length, 5);
    reply(lane, replayOf(injected[4]).nonce, { error: 'Failed to fetch' });
    await Promise.all(replies.slice(1, 4));
    await assert.rejects(replies[4], /replay_failed/);
    assert.equal(lane.getSnapshot()!.phase, 'idle', 'page still there');
  });

  await t('a replay waits for a page load in progress; with no page it is refused', async () => {
    const lane = new WebViewQueue();
    const injected: string[] = [];
    lane.attach((s) => injected.push(s));
    await assert.rejects(lane.replay({ expect: 'json', method: 'GET', url: 'https://x/1' }, 100), /no_page/);
    const load = lane.run(job({ keepPage: true }));
    const r = lane.replay({ expect: 'json', method: 'GET', url: 'https://x/2' }, 100);
    assert.equal(injected.length, 0, 'waits for the page');
    data(lane);
    await load;
    assert.equal(injected.length, 1);
    reply(lane, replayOf(injected[0]).nonce);
    await r;
    const noKeep = lane.run(job());
    const refused = lane.replay({ expect: 'json', method: 'GET', url: 'https://x/3' }, 100);
    data(lane);
    await noKeep;
    await assert.rejects(refused, /no_page/, 'the load that replaced the page did not keep one');
  });

  await t('a new page load waits for replays in flight; reset refuses them; timeouts reject', async () => {
    const lane = new WebViewQueue();
    const injected: string[] = [];
    lane.attach((s) => injected.push(s));
    const first = lane.run(job({ keepPage: true }));
    data(lane);
    await first;
    const firstId = lane.getSnapshot()!.id;
    const inFlight = lane.replay({ expect: 'json', method: 'GET', url: 'https://x/1' }, 1000);
    const next = lane.run(job({ keepPage: true, url: 'https://www.example.com/s?q=eggs' }));
    assert.equal(lane.getSnapshot()!.id, firstId, 'old page stays until its replay answers');
    reply(lane, replayOf(injected[0]).nonce);
    await inFlight;
    assert.match(lane.getSnapshot()!.url, /q=eggs/, 'then the new load starts');
    data(lane);
    await next;
    const doomed = lane.replay({ expect: 'json', method: 'GET', url: 'https://x/2' }, 1000);
    lane.reset();
    await assert.rejects(doomed, /no_page/);
    assert.equal(lane.getSnapshot(), null);
    const again = lane.run(job({ keepPage: true }));
    data(lane);
    await again;
    await assert.rejects(lane.replay({ expect: 'json', method: 'GET', url: 'https://x/3' }, 20), /replay_timeout/);
  });

  await t('the content process dying fails the load, or drops a kept page', async () => {
    const lane = new WebViewQueue();
    const p = lane.run(job({ keepPage: true }));
    lane.pageLost();
    await assert.rejects(p, /page_crashed/);
    const q = lane.run(job({ keepPage: true }));
    data(lane);
    await q;
    lane.pageLost();
    assert.equal(lane.getSnapshot(), null);
  });

  // --- The pool ----------------------------------------------------------------------------------------
  await t('pool: one lane per retailer; a store visit is shown before bot checks, then the oldest check', async () => {
    const pool = new WebViewPool();
    pool.challengeGraceMs = 0;
    const a = pool.lane('a');
    assert.equal(pool.lane('a'), a);
    const b = pool.lane('b');
    const c = pool.lane('c');
    assert.deepEqual(pool.getSnapshot().lanes.map((l) => l.key), ['a', 'b', 'c']);
    const pa = a.run(job());
    const pb = b.run(job());
    b.receive(JSON.stringify({ nonce: nonceOf(b.getSnapshot()!.script), kind: 'challenge' }));
    a.receive(JSON.stringify({ nonce: nonceOf(a.getSnapshot()!.script), kind: 'challenge' }));
    await tick();
    assert.equal(pool.getSnapshot().presented, b, 'b asked first');
    const visit = c.browse({ url: 'https://www.example.com/', retailerName: 'C' });
    assert.equal(pool.getSnapshot().presented, c, 'the user opened c');
    c.closeBrowse();
    await visit;
    assert.equal(pool.getSnapshot().presented, b);
    b.cancel();
    await assert.rejects(pb, /challenge_cancelled/);
    assert.equal(pool.getSnapshot().presented, a);
    a.cancel();
    await assert.rejects(pa);
    assert.equal(pool.getSnapshot().presented, null);
  });

  await t('pool: loading a page past the limit unloads the least recently used idle page', async () => {
    const pool = new WebViewPool();
    pool.maxLoadedPages = 2;
    const [a, b, c] = ['a', 'b', 'c'].map((k) => pool.lane(k));
    for (const lane of [a, b]) {
      const p = lane.run(job({ keepPage: true }));
      data(lane);
      await p;
      await tick(2);
    }
    const p = c.run(job({ keepPage: true }));
    assert.equal(a.getSnapshot(), null, 'a was used longest ago');
    assert.ok(b.getSnapshot());
    data(c);
    await p;
  });

  // --- Searching through lanes ---------------------------------------------------------------------------
  const example: RetailerConfig = {
    id: 'example', name: 'Example', enabled: true,
    searchUrl: 'https://www.example.com/s?q={{query}}', homeUrl: 'https://www.example.com/', cookieTemplate: '',
    strategies: ['webview'], parser: 'autoDetect', waitFor: 'auto', challengeMarkers: DEFAULT_CHALLENGE_MARKERS,
    timeoutMs: 1000, storeHint: '', note: '',
  };
  const apiUrl = (q: string) => `https://api.example.com/search?keyword=${encodeURIComponent(q).replace(/%20/g, '+')}&store=12`;
  const apiJson = (q: string, n = 5) => JSON.stringify({ products: Array.from({ length: n }, (_, i) => ({ id: `${q}-${i}`, title: `Brand ${q} ${i}`, price: { current: 2 + i } })) });
  const queryOf = (url: string) => new URL(url).searchParams.get('q') ?? new URL(url).searchParams.get('keyword') ?? '';

  /** Plays the WebView: answers page loads with the API response the page "fetched", and replays like the page would. */
  function fakeWebView(lane: WebViewQueue, opts: { replayText?: (q: string, pageQuery: string) => string; store?: string } = {}) {
    const seen = { pageLoads: 0, replays: [] as { url: string; headers?: Record<string, string> }[] };
    let lastId = -1;
    let pageQuery = '';
    lane.subscribe(() => {
      const s = lane.getSnapshot();
      if (!s || s.phase !== 'hidden' || s.id === lastId) return;
      lastId = s.id;
      seen.pageLoads++;
      const q = queryOf(s.url);
      pageQuery = q;
      const request = { method: 'GET', url: apiUrl(q), headers: { 'x-api-key': 'k' }, credentials: 'include' };
      const sources = [{ label: `response ${request.url}`, text: apiJson(q), request }];
      setTimeout(() => lane.receive(JSON.stringify({ nonce: nonceOf(s.script), kind: 'data', href: s.url, sources, store: opts.store })), 5);
    });
    lane.attach((script) => {
      const { nonce, req } = replayOf(script);
      seen.replays.push({ url: req.url, headers: req.headers });
      const text = opts.replayText ? opts.replayText(queryOf(req.url), pageQuery) : apiJson(queryOf(req.url));
      setTimeout(() => reply(lane, nonce, { url: req.url, text }), 5);
    });
    return seen;
  }

  await t('search: the first query loads the page, the rest are replayed inside it with the query swapped', async () => {
    const pool = new WebViewPool();
    const seen = fakeWebView(pool.lane('example', 'Example'));
    const searcher = createRetailerSearch(pool, 'test');
    const first = await searcher.search(example, 'hot dogs', '');
    assert.deepEqual([first.via, first.products[0].name, first.products[0].price], ['page', 'Brand hot dogs 0', 2]);
    const second = await searcher.search(example, 'Ketchup', '');
    assert.deepEqual([second.via, second.products[0].name, seen.pageLoads], ['replay', 'Brand ketchup 0', 1]);
    assert.deepEqual(seen.replays[0], { url: 'https://api.example.com/search?keyword=ketchup&store=12', headers: { 'x-api-key': 'k' } });
    assert.equal(second.attempts[0].via, 'replay');

    // The price X-ray: the data each price came in, and the request that brought it, in memory.
    const fromPage = priceEvidence.get('example', 'hot dogs-0')!;
    assert.deepEqual([fromPage.via, fromPage.strategy, fromPage.request, fromPage.pricePath, fromPage.price], [
      'page', 'webview', { method: 'GET', url: 'https://api.example.com/search?keyword=hot+dogs&store=12' }, 'price.current', 2,
    ]);
    assert.equal(JSON.parse(fromPage.json).title, 'Brand hot dogs 0');
    assert.deepEqual([priceEvidence.get('example', 'ketchup-1')?.via, priceEvidence.get('example', 'ketchup-1')?.request?.url], ['replay', 'https://api.example.com/search?keyword=ketchup&store=12']);
    assert.equal(searcher.evidence('example', 'ketchup-1'), priceEvidence.get('example', 'ketchup-1'));
  });

  await t('search: the store the prices are for: the number the request asked for, the name the page shows; replays too', async () => {
    const pool = new WebViewPool();
    fakeWebView(pool.lane('example', 'Example'), { store: 'Your store: Example Midtown · Open until 10pm' });
    const searcher = createRetailerSearch(pool, 'test');
    const first = await searcher.search(example, 'milk', '');
    assert.deepEqual([first.via, first.store], ['page', { id: '12', name: 'Example Midtown' }]);
    const second = await searcher.search(example, 'eggs', '');
    assert.deepEqual([second.via, second.store], ['replay', { id: '12', name: 'Example Midtown' }], 'the page it was sent from names the store');
    pool.lane('example').reset();
    assert.equal(pool.lane('example').seenStore, null, 'forgotten with the page');
  });

  await t('search: queries sent together share one page load, then replay', async () => {
    const pool = new WebViewPool();
    const seen = fakeWebView(pool.lane('example', 'Example'));
    const searcher = createRetailerSearch(pool, 'test');
    const results = await Promise.all(['hot dogs', 'buns', 'ketchup', 'mustard', 'napkins'].map((q) => searcher.search(example, q, '')));
    assert.deepEqual(results.map((r) => r.via), ['page', 'replay', 'replay', 'replay', 'replay']);
    assert.equal(seen.pageLoads, 1);
    assert.deepEqual(results.map((r) => r.products[0].name.split(' ')[1]), ['hot', 'buns', 'ketchup', 'mustard', 'napkins']);
  });

  await t('search: a replay that returns the page’s old results falls back, and two in a row stop replays', async () => {
    const pool = new WebViewPool();
    const lane = pool.lane('example', 'Example');
    // A session-bound API: it ignores the swapped query and answers for whatever the page last loaded.
    const seen = fakeWebView(lane, { replayText: (_q, pageQuery) => apiJson(pageQuery) });
    const searcher = createRetailerSearch(pool, 'test');
    await searcher.search(example, 'hot dogs', '');
    const eggs = await searcher.search(example, 'eggs', '');
    assert.deepEqual([eggs.via, eggs.products[0].name, seen.pageLoads], ['page', 'Brand eggs 0', 2]);
    assert.ok(lane.template, 'one miss: relearned from the page load');
    await searcher.search(example, 'bread', '');
    assert.equal(lane.template, null, 'dropped after two misses in a row');
    const jam = await searcher.search(example, 'jam', '');
    assert.deepEqual([jam.via, seen.replays.length, lane.template], ['page', 2, null], 'page loads only from now on');
    lane.reset();
    await searcher.search(example, 'rice', '');
    assert.ok(lane.template, 'a fresh page gets a fresh chance');
  });

  await t('search: results that fit neither query fall back for that query only; the template is kept', async () => {
    const pool = new WebViewPool();
    const lane = pool.lane('example', 'Example');
    const seen = fakeWebView(lane, { replayText: (q) => (q === 'soda' ? apiJson('cola') : apiJson(q)) });
    const searcher = createRetailerSearch(pool, 'test');
    await searcher.search(example, 'hot dogs', '');
    const soda = await searcher.search(example, 'soda', '');
    assert.deepEqual([soda.via, soda.products[0].name, lane.replayMisses], ['page', 'Brand soda 0', 0]);
    const chips = await searcher.search(example, 'chips', '');
    assert.deepEqual([chips.via, seen.pageLoads], ['replay', 2]);
  });

  await t('search: replays switched off, a page script, or a store cookie mean page loads only', async () => {
    for (const setup of [
      (p: WebViewPool) => { p.replayEnabled = false; return example; },
      () => ({ ...example, pageScript: 'function () { return null; }', parser: 'autoDetect' }),
      () => ({ ...example, cookieTemplate: 'store={{storeId}}' }),
    ]) {
      const pool = new WebViewPool();
      const seen = fakeWebView(pool.lane('example', 'Example'));
      const cfg = setup(pool);
      const searcher = createRetailerSearch(pool, 'test');
      await searcher.search(cfg, 'hot dogs', '1');
      const next = await searcher.search(cfg, 'ketchup', '1');
      assert.deepEqual([next.via, seen.pageLoads, seen.replays.length], ['page', 2, 0]);
    }
  });

  await t('search: a different store gets a fresh page; a failing strategy rests and the next one runs; one refused cools down at once', async () => {
    const pool = new WebViewPool();
    const seen = fakeWebView(pool.lane('example', 'Example'));
    const searcher = createRetailerSearch(pool, 'test', new StoreTuner());
    await searcher.search(example, 'hot dogs', 'A');
    const other = await searcher.search(example, 'ketchup', 'B');
    assert.deepEqual([other.via, seen.pageLoads, other.store?.id], ['replay', 2, 'B'], 'a fresh page, then its request asked for store B');

    const realFetch = globalThis.fetch;
    let fetches = 0;
    // A server error: not a block, so the plain request rests after two in a row.
    globalThis.fetch = (async () => { fetches++; return { status: 500, ok: false, url: 'https://www.example.com/s', text: async () => `<html>${'error '.repeat(500)}</html>` }; }) as any;
    const both = { ...example, strategies: ['fetch', 'webview'] as RetailerConfig['strategies'] };
    const r1 = await searcher.search(both, 'eggs', 'B');
    const r2 = await searcher.search(both, 'milk', 'B');
    const r3 = await searcher.search(both, 'bread', 'B');
    assert.equal(fetches, 2, 'the plain request rests after two failures');
    assert.deepEqual(r3.attempts.map((a) => [a.strategy, a.reason ?? 'ok']), [['fetch', 'resting'], ['webview', 'ok']]);
    assert.deepEqual([r1.strategy, r2.strategy, r3.strategy], ['webview', 'webview', 'webview']);
    const err = await searcher.search(both, 'jam', 'B', 'fetch').catch((e) => e);
    assert.ok(err instanceof SearchFailed, 'asking for a resting strategy still runs it');

    // Refused (HTTP 403): a block. Plain requests cool down at once, while the store's page still works.
    const tuner = new StoreTuner();
    const refused = createRetailerSearch(pool, 'test', tuner);
    fetches = 0;
    globalThis.fetch = (async () => { fetches++; return { status: 403, ok: false, url: 'https://www.example.com/s', text: async () => '<html>no</html>' }; }) as any;
    await refused.search(both, 'eggs', 'B');
    const next = await refused.search(both, 'milk', 'B');
    globalThis.fetch = realFetch;
    assert.equal(fetches, 1, 'one refusal is enough');
    assert.deepEqual(next.attempts.map((a) => [a.strategy, a.reason ?? 'ok']), [['fetch', 'resting'], ['webview', 'ok']]);
    assert.deepEqual([tuner.cooling('example', 'fetch')?.kind, tuner.cooling('example', 'fetch')?.said, tuner.cooling('example')], ['refused', 'HTTP 403', undefined]);
  });

  await t('search: a page load finishes as soon as its results stream in, and still teaches replays', async () => {
    const pool = new WebViewPool();
    const lane = pool.lane('example', 'Example');
    let last = -1;
    lane.subscribe(() => {
      const s = lane.getSnapshot();
      if (!s || s.phase !== 'hidden' || s.id === last) return;
      last = s.id;
      const q = queryOf(s.url);
      const request = { method: 'GET', url: apiUrl(q), headers: {}, credentials: 'include' };
      // Results stream in, but the page never goes quiet (ads, analytics), so it wouldn't post 'data' by itself.
      setTimeout(() => lane.receive(JSON.stringify({ nonce: nonceOf(s.script), kind: 'progress', title: `${q} - Example`, sources: [{ label: `response ${request.url}`, text: apiJson(q), request }] })), 5);
    });
    const slow = { ...example, timeoutMs: 20_000 };
    const searcher = createRetailerSearch(pool, 'test');
    const t0 = Date.now();
    const first = await searcher.search(slow, 'hot dogs', '');
    assert.ok(Date.now() - t0 < 2000, `took ${Date.now() - t0} ms, not the ${slow.timeoutMs} ms timeout`);
    assert.deepEqual([first.via, first.products[0].name, lane.template?.kind], ['page', 'Brand hot dogs 0', 'json']);
  });

  await t('search: a page that loads without products says what it showed, and is listed in recent failures', async () => {
    const pool = new WebViewPool();
    const lane = pool.lane('example', 'Example');
    lane.subscribe(() => {
      const s = lane.getSnapshot();
      if (!s || s.phase !== 'hidden') return;
      const sources = [{ label: 'response https://www.kroger.com/atlas/v1/search?query=milk&key=k', text: '{"upcs":["1","2"]}' }];
      setTimeout(() => lane.receive(JSON.stringify({ nonce: nonceOf(s.script), kind: 'data', title: 'Kroger', sources })), 5);
    });
    const searcher = createRetailerSearch(pool, 'test');
    const err = await searcher.search(example, 'milk', '').catch((e) => e);
    assert.ok(err instanceof SearchFailed);
    assert.equal(err.attempts[0].reason, 'no_payload');
    assert.match(
      err.attempts[0].detail ?? '',
      /^Example showed “Kroger” and loaded 1 data response, but none listed products with prices\. Largest: www\.kroger\.com\/atlas\/v1\/search \(\d+ B\)\.$/,
      'no query string: it can hold keys',
    );
    const [recent] = searcher.recentFailures();
    assert.deepEqual([recent.retailer, recent.query, recent.reason, recent.detail], ['Example', 'milk', 'no_payload', err.attempts[0].detail]);
  });

  await t('store: pressed on the store finder for the ZIP, hidden, naming the store; replays start over; failures are reported', async () => {
    const pool = new WebViewPool();
    const lane = pool.lane('walmart', 'Walmart');
    const loads: string[] = [];
    const listing = {
      pressed: 'Make this my store',
      label: 'Secaucus Supercenter',
      lines: ['Secaucus Supercenter', '400 Park Pl', 'Secaucus, NJ 07094', 'Open until 11pm', 'Make this my store'],
      links: ['/store-finder?location=10001', '/store/3520-secaucus-nj'],
    };
    let answer = (nonce: string): Record<string, unknown> => ({ nonce, kind: 'data', pageResult: listing });
    let last = -1;
    lane.subscribe(() => {
      const s = lane.getSnapshot();
      if (!s || s.phase !== 'hidden' || s.id === last) return;
      last = s.id;
      loads.push(s.url);
      setTimeout(() => lane.receive(JSON.stringify(answer(nonceOf(s.script)))), 5);
    });
    const byId = (id: string) => BUNDLED_CONFIG.retailers.find((r) => r.id === id)!;
    const searcher = createRetailerSearch(pool, 'test');
    lane.template = { kind: 'document' }; // As if a search page had been kept for replays.

    assert.deepEqual(await searcher.setStoreAuto(byId('walmart'), '10001'), {
      ok: true,
      label: 'Secaucus Supercenter',
      store: { name: 'Secaucus Supercenter', address: '400 Park Pl, Secaucus, NJ 07094', id: '3520' },
    });
    assert.deepEqual(loads, ['https://www.walmart.com/store-finder?location=10001&distance=50']);
    assert.equal(lane.template, null, 'the kept page pointed at the old store');
    answer = (nonce) => ({ nonce, kind: 'error', error: 'button_not_found' });
    assert.deepEqual(await searcher.setStoreAuto(byId('walmart'), '10001'), { ok: false, reason: 'button_not_found' });
    assert.deepEqual(await searcher.setStoreAuto(byId('aldi'), '10001'), { ok: false, reason: 'not_automatic' });
  });

  await t('store: a store set by number is asked for in each search; a page that got the site’s pick is replayed for it', async () => {
    const pool = new WebViewPool();
    const seen = fakeWebView(pool.lane('example', 'Example'), { store: 'Your store: Example Midtown' });
    const searcher = createRetailerSearch(pool, 'test');
    const first = await searcher.search(example, 'milk', '40');
    assert.deepEqual([first.via, first.store, seen.pageLoads], ['replay', { id: '40' }, 1], 'the page’s name is for its own store, 12');
    assert.deepEqual(seen.replays.map((r) => r.url), ['https://api.example.com/search?keyword=milk&store=40'], 'the page’s own request, for the store set');
    const second = await searcher.search(example, 'eggs', '40');
    assert.deepEqual([second.via, seen.replays[1].url, seen.pageLoads], ['replay', 'https://api.example.com/search?keyword=eggs&store=40', 1]);

    // A site that won't answer for that store: the page's prices stand, and say which store they're for.
    const refusing = new WebViewPool();
    fakeWebView(refusing.lane('example', 'Example'), { store: 'Your store: Example Midtown', replayText: () => '{"error":"unknown store"}' });
    const got = await createRetailerSearch(refusing, 'test').search(example, 'milk', '40');
    assert.deepEqual([got.via, got.store], ['page', { id: '12', name: 'Example Midtown' }]);
  });

  await t('stores near: Meijer’s finder asked straight for a point on the map, the ZIP code’s center; without one, not asked', async () => {
    const pool = new WebViewPool();
    const searcher = createRetailerSearch(pool, 'test');
    const meijer = BUNDLED_CONFIG.retailers.find((r) => r.id === 'meijer')!;
    // As its proximity search answered (June 2026): the store's number as UnitId, its name as storeShortName.
    const answer = { store: [
      { IsMobileShoppingEnabled: 'Y', UnitId: 143, streetAddress: '8870 Columbus Pike', city: 'Lewis Center', state: 'OH', zip: '43035', latitude: 40.1797, longitude: -83.0265, storeHours: '6am-12am, daily', milesFrom: 6.41, storeShortName: 'Lewis Center', UnitType: 'MS' },
      { IsMobileShoppingEnabled: 'Y', UnitId: 58, streetAddress: '6175 Sawmill Rd', city: 'Dublin', state: 'OH', zip: '43017', latitude: 40.0924, longitude: -83.0987, storeHours: '6am-12am, daily', milesFrom: 1.12, storeShortName: 'Sawmill Rd', UnitType: 'MS' },
    ] };
    const realFetch = globalThis.fetch;
    const asked: string[] = [];
    globalThis.fetch = (async (url: string) => {
      asked.push(url);
      return { ok: true, status: 200, text: async () => JSON.stringify(answer) };
    }) as typeof fetch;
    try {
      const got = await searcher.storesNear(meijer, '43017', 25, { lat: 40.09917, lng: -83.11408 });
      assert.deepEqual(asked, ['https://www.meijer.com/bin/meijer/store/search/proximity-v2?latitude=40.0992&longitude=-83.1141&miles=1000&numToReturn=12']);
      // Measured on the map from the ZIP's center, over its own milesFrom; and asked with the ZIP's center, the list is
      // for the ZIP, though its digits aren't in the address.
      assert.deepEqual(got.ok && [got.tie, got.stores.map((st) => [st.id, st.name, st.address, st.miles, st.milesFrom])], [
        'asked',
        [
          ['58', 'Sawmill Rd', '6175 Sawmill Rd, Dublin, OH 43017', 0.9, 'map'],
          ['143', 'Lewis Center', '8870 Columbus Pike, Lewis Center, OH 43035', 7.2, 'map'],
        ],
      ]);
      assert.equal(pool.lane('meijer').getSnapshot(), null, 'no page loaded');

      // The ZIP code's center unknown: the address can't be filled in, so its page is loaded instead.
      asked.length = 0;
      const lane = pool.lane('meijer');
      let last = -1;
      lane.subscribe(() => {
        const snap = lane.getSnapshot();
        if (!snap || snap.phase !== 'hidden' || snap.id === last) return;
        last = snap.id;
        // The page's store cards, linked as Meijer links a store's page.
        const cards = [{ lines: ['Sawmill Rd', '6175 Sawmill Rd', 'Dublin, OH 43017', '1.1 mi'], href: '/shopping/store-locator/58.html' }];
        setTimeout(() => lane.receive(JSON.stringify({ nonce: nonceOf(snap.script), kind: 'data', sources: [], pageResult: { cards } })), 5);
      });
      const fromPage = await searcher.storesNear(meijer, '43017', 25);
      assert.deepEqual(asked, [], 'not asked without a place');
      assert.deepEqual(fromPage.ok && fromPage.stores.map((st) => [st.id, st.miles]), [['58', 1.1]], 'its store cards, by the number in their links');
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  await t('stores near: from the finder’s JSON when it answers, else its page, hidden, with the ZIP typed in; failures say why', async () => {
    const pool = new WebViewPool();
    pool.challengeGraceMs = 0;
    const searcher = createRetailerSearch(pool, 'test');
    const safeway = BUNDLED_CONFIG.retailers.find((r) => r.id === 'safeway')!;
    const yext = { response: { entities: [
      { distance: { distanceMiles: 1.18, id: '667' }, profile: { name: 'Safeway', address: { line1: '5290 Diamond Heights Blvd', city: 'San Francisco', region: 'CA', postalCode: '94131' } } },
      { distance: { distanceMiles: 0.43, id: '739' }, profile: { name: 'Safeway', address: { line1: '3350 Mission St', city: 'San Francisco', region: 'CA', postalCode: '94110' } } },
    ] } };
    const realFetch = globalThis.fetch;
    const asked: string[] = [];
    let status = 200;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      asked.push(`${url} ${(init?.headers as Record<string, string>).Accept}`);
      return { ok: status === 200, status, text: async () => JSON.stringify(yext) };
    }) as typeof fetch;
    try {
      const fromJson = await searcher.storesNear(safeway, '94110', 10);
      assert.deepEqual(asked, ['https://local.safeway.com/locator?q=94110&storetype=5655 application/json']);
      assert.deepEqual(fromJson, {
        ok: true,
        how: 'finder',
        stores: [
          { id: '739', name: 'Safeway', address: '3350 Mission St, San Francisco, CA 94110', miles: 0.43, milesFrom: 'finder' },
          { id: '667', name: 'Safeway', address: '5290 Diamond Heights Blvd, San Francisco, CA 94131', miles: 1.18, milesFrom: 'finder' },
        ],
        tie: 'asked',
      });
      assert.equal(pool.lane('safeway').getSnapshot(), null, 'no page loaded');

      // Refused: the finder's page, hidden, reads the list the page fetches once the ZIP is typed in.
      status = 403;
      const lane = pool.lane('safeway');
      const loads: { url: string; typesZip: boolean; captures: boolean }[] = [];
      let answer = (nonce: string): Record<string, unknown> => ({ nonce, kind: 'data', sources: [{ label: 'response https://local.safeway.com/locator?q=94110', text: JSON.stringify(yext) }], pageResult: { cards: [] } });
      let last = -1;
      lane.subscribe(() => {
        const snap = lane.getSnapshot();
        if (!snap || snap.phase !== 'hidden' || snap.id === last) return;
        last = snap.id;
        loads.push({ url: snap.url, typesZip: snap.script.includes('ZIP = "94110"'), captures: !!snap.beforeScript?.includes('__stretchCapture') });
        setTimeout(() => lane.receive(JSON.stringify(answer(nonceOf(snap.script)))), 5);
      });
      const fromPage = await searcher.storesNear(safeway, '94110', 10, { lat: 37.75, lng: -122.42 });
      assert.deepEqual(loads, [{ url: 'https://local.safeway.com/search.html', typesZip: true, captures: true }]);
      assert.deepEqual(fromPage.ok && [fromPage.stores.map((st) => st.id), fromPage.tie], [['739', '667'], 'asked'], 'its request carried the ZIP');
      assert.equal(lane.getSnapshot(), null, 'a finder isn’t kept for replays');

      // A finder page that didn't take the ZIP: its list is said not to be for it, in the feed too.
      answer = (nonce) => ({
        nonce,
        kind: 'data',
        sources: [{ label: 'response https://local.safeway.com/locator?lat=40.1&lng=-83.11', text: JSON.stringify(yext) }],
        pageResult: { cards: [], zipIn: 'none' },
      });
      const untied = await searcher.storesNear(safeway, '94110', 10);
      assert.equal(untied.ok && untied.tie, 'none');
      assert.ok(pool.feed.getSnapshot().some((e) => e.what === 'stores near 94110' && /didn’t take the ZIP/.test(e.text)));

      answer = (nonce) => ({ nonce, kind: 'challenge' });
      assert.deepEqual(await searcher.storesNear(safeway, '94110', 10), { ok: false, reason: 'challenge' }, 'a bot check doesn’t cover the app');
      // A check the page passes by itself: the list comes from the page it moves on to, and the feed says so.
      lane.challengeGraceMs = 100;
      answer = (nonce) => {
        setTimeout(() => {
          lane.loadStarted();
          lane.receive(JSON.stringify({ nonce, kind: 'data', sources: [{ label: 'response https://local.safeway.com/locator?q=94110', text: JSON.stringify(yext) }], pageResult: { cards: [] } }));
        }, 20);
        return { nonce, kind: 'challenge' };
      };
      const passed = await searcher.storesNear(safeway, '94110', 10);
      assert.deepEqual(passed.ok && passed.stores.map((st) => st.id), ['739', '667'], 'listed from the page the check let through');
      assert.ok(pool.feed.getSnapshot().some((e) => e.what === 'stores near 94110' && /passed by itself/.test(e.text)), 'the feed says so');
      lane.challengeGraceMs = 0;
      answer = (nonce) => ({ nonce, kind: 'data', sources: [], pageResult: { cards: [] } });
      assert.deepEqual(await searcher.storesNear(safeway, '94110', 10), { ok: false, reason: 'no_stores_listed' });
      assert.deepEqual(await searcher.storesNear(example, '94110', 10), { ok: false, reason: 'no_store_finder' });
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  await t('suggestions: a store’s page is loaded once, hidden and light, and typed into; a bot check leaves it out', async () => {
    const pool = new WebViewPool();
    const lane = pool.lane('example', 'Example');
    const loads: { url: string; light: boolean }[] = [];
    let last = -1;
    lane.subscribe(() => {
      const s = lane.getSnapshot();
      if (!s || s.phase !== 'hidden' || s.id === last) return;
      last = s.id;
      loads.push({ url: s.url, light: !!s.beforeScript?.includes('Content-Security-Policy') });
      setTimeout(() => lane.receive(JSON.stringify({ nonce: nonceOf(s.script), kind: 'data', href: s.url, store: 'Your store Example Midtown' })), 5);
    });
    const typed: string[] = [];
    lane.attach((script) => {
      typed.push(/TEXT = ("[^"]*")/.exec(script)![1]);
      setTimeout(() => lane.receive(JSON.stringify({ kind: 'suggest', nonce: nonceOf(script), items: ['milk', 'whole milk'], how: 'list' })), 5);
    });
    const searcher = createRetailerSearch(pool, 'test');
    const ready = await Promise.all([searcher.prepareSuggestions(example), searcher.prepareSuggestions(example)]);
    assert.deepEqual([ready, loads], [[true, true], [{ url: 'https://www.example.com/', light: true }]], 'one load, however many ask');
    assert.deepEqual(await searcher.suggest(example, ' mil '), ['milk', 'whole milk']);
    assert.deepEqual(await searcher.suggest(example, 'm'), [], 'two letters at least');
    assert.deepEqual([loads.length, typed], [1, ['"mil"']], 'the same page, typed into');
    assert.deepEqual(lane.seenStore, { name: 'Example Midtown' }, 'its header said which store');
    lane.reset();

    const blocked = new WebViewPool();
    blocked.challengeGraceMs = 0;
    const b = blocked.lane('example', 'Example');
    b.subscribe(() => {
      const s = b.getSnapshot();
      if (s?.phase === 'hidden') setTimeout(() => b.receive(JSON.stringify({ nonce: nonceOf(s.script), kind: 'challenge' })), 5);
    });
    const other = createRetailerSearch(blocked, 'test');
    assert.deepEqual([await other.suggest(example, 'milk'), b.getSnapshot()], [[], null], 'no bot check shown for a suggestion');
  });

  // --- Product pages and the live view ------------------------------------------------------------------------
  await t('product page: read hidden on its own lane, only on the store’s site; opening it twice loads it once', async () => {
    const pool = new WebViewPool();
    const lane = pool.lane(PAGE_LANE, 'Pages');
    let loads = 0;
    let last = -1;
    lane.subscribe(() => {
      const s = lane.getSnapshot();
      if (!s || s.phase !== 'hidden' || s.id === last) return;
      last = s.id;
      loads++;
      assert.match(s.script, /WAIT_FOR = "details"/);
      assert.ok(s.beforeScript, 'it captures what the page fetches, like a search');
      const ld = { '@type': 'Product', name: 'Brand milk 0', description: 'A carton of fresh milk from a very good farm.', offers: { price: 2 } };
      setTimeout(() => lane.receive(JSON.stringify({ nonce: nonceOf(s.script), kind: 'data', href: s.url, sources: [{ label: 'ld+json', text: JSON.stringify(ld) }] })), 5);
    });
    const searcher = createRetailerSearch(pool, 'test');
    const product = { retailer: 'example', storeId: '', id: 'milk-0', name: 'Brand milk 0', price: 2, url: 'https://www.example.com/p/milk-0' };
    const [a, b] = await Promise.all([searcher.readProduct(example, product), searcher.readProduct(example, product)]);
    assert.equal(loads, 1);
    assert.equal(a, b);
    assert.deepEqual([a.price, a.description, a.count], [2, 'A carton of fresh milk from a very good farm.', 2]);
    await searcher.readProduct(example, product);
    assert.equal(loads, 1, 'reused for a while');
    assert.equal(lane.getSnapshot(), null, 'the page isn’t kept');
    await assert.rejects(searcher.readProduct(example, { ...product, url: 'https://ads.example.org/p/1' }), (e: any) => e.reason === 'other_site');
    await assert.rejects(searcher.readProduct(example, { ...product, url: undefined }), (e: any) => e.reason === 'no_link');
    assert.deepEqual(pool.feed.getSnapshot().map((e) => [e.retailer, e.what, e.ok]), [['Example', 'product page', true]]);

    const viewing = searcher.viewProduct(example, product.url);
    const s = lane.getSnapshot()!;
    assert.deepEqual([s.phase, s.purpose, s.url, pool.getSnapshot().presented === lane], ['browse', 'view', product.url, true]);
    lane.closeBrowse();
    await viewing;
    await assert.rejects(searcher.viewProduct(example, 'https://ads.example.org/p/1'), (e: any) => e.reason === 'other_site', 'only the store’s own pages');
  });

  await t('live view: every search lands in the feed, in words; while it’s open every page change is news', async () => {
    const pool = new WebViewPool();
    const lane = pool.lane('example', 'Example');
    fakeWebView(lane);
    const searcher = createRetailerSearch(pool, 'test');
    await searcher.search(example, 'milk', '');
    await searcher.search(example, 'eggs', '');
    const lines = pool.feed.getSnapshot().map((e) => `${e.retailer} · ${e.what} · ${e.text}`);
    assert.match(lines[0], /^Example · eggs · 5 products · \d+\.\d s · reused its page$/);
    assert.match(lines[1], /^Example · milk · 5 products · \d+\.\d s · page load$/);

    let news = 0;
    pool.subscribe(() => news++);
    lane.reset();
    assert.equal(news, 0, 'closed: a page coming and going changes nothing on screen');
    pool.setLiveView('open');
    assert.deepEqual([pool.getSnapshot().live, news], ['open', 1]);
    const p = searcher.search(example, 'bread', '');
    await p;
    assert.ok(news >= 3, 'the tile follows the page load');
    pool.setLiveView('off');

    // Presenter mode's stage draws the pages too: one loaded after the stage opened is news, so it's put on stage.
    lane.reset();
    pool.setLiveView('stage');
    news = 0;
    await searcher.search(example, 'jam', '');
    assert.ok(news >= 1, 'the stage follows the page load');
    pool.setLiveView('off');
  });

  await t('fees page: read hidden on the page lane for its words; a bot check fails the read, unseen; Store health hears of it', async () => {
    const pool = new WebViewPool();
    pool.challengeGraceMs = 0;
    const lane = pool.lane(PAGE_LANE, 'Pages');
    let reply: (nonce: string, url: string) => Record<string, unknown> = (nonce, url) => ({
      nonce, kind: 'data', href: url, usage: { bytes: 42000 },
      text: 'Delivery\nStandard delivery from store: $9.95 delivery fee applies.\nExample+ members get free delivery on orders over $35.',
    });
    const scripts: string[] = [];
    let last = -1;
    lane.subscribe(() => {
      const s = lane.getSnapshot();
      if (!s || s.phase !== 'hidden' || s.id === last) return;
      last = s.id;
      scripts.push(s.script);
      setTimeout(() => lane.receive(JSON.stringify(reply(nonceOf(s.script), s.url))), 5);
    });
    const searcher = createRetailerSearch(pool, 'rules-9');
    const entries: any[] = [];
    searcher.onAttempt((e) => entries.push(e));
    const url = 'https://www.example.com/help/fees';
    const cfg: RetailerConfig = { ...example, online: { checked: '2026-09-25', feesUrl: url, delivery: { fee: 7 }, plans: [{ id: 'ex-plus', name: 'Example+' }] } };
    const got = await searcher.readFees(cfg);
    assert.deepEqual([got.delivery, got.count, got.url, got.bytes], [{ fee: 9.95 }, 1, url, 42000], 'the members’ sentence is left alone');
    assert.match(scripts[0], /WAIT_FOR = "text"/);
    assert.equal(lane.getSnapshot(), null, 'the page isn’t kept');
    assert.deepEqual(entries.map((e) => [e.kind, e.ok, e.bytes, e.rules]), [['fees', true, 42000, 'rules-9']]);
    assert.deepEqual(pool.feed.getSnapshot().map((e) => [e.retailer, e.what, e.ok]), [['Example', 'fees page', true]]);

    reply = (nonce, u) => ({ nonce, kind: 'data', href: u, text: 'Welcome to our help center.' });
    const empty = await searcher.readFees(cfg);
    assert.deepEqual([empty.count, entries[1].ok, entries[1].reason], [0, false, 'no_fees'], 'loaded, with no figures in it');

    reply = (nonce) => ({ nonce, kind: 'challenge' });
    await assert.rejects(searcher.readFees(cfg), (e: any) => e.reason === 'challenge');
    assert.deepEqual([pool.getSnapshot().presented, entries[2].reason], [null, 'challenge'], 'nobody is shown a bot check for a fees page');
    await assert.rejects(searcher.readFees(example), (e: any) => e.reason === 'no_fees_page');
  });

  await t('fees pages: a store with a page for pickup has both read, one at a time; one that fails leaves the other’s', async () => {
    const pool = new WebViewPool();
    pool.challengeGraceMs = 0;
    const lane = pool.lane(PAGE_LANE, 'Pages');
    const main = 'https://www.example.com/help/delivery';
    const pickup = 'https://www.example.com/help/pickup';
    const texts: Record<string, string> = {
      [main]: 'Delivery\nThe standard delivery fee is $9.95.',
      [pickup]: 'Pickup\nPickup is FREE on orders of $35 or more, otherwise there’s a service fee of $4.95.',
    };
    let blocked = '';
    const order: string[] = [];
    let last = -1;
    lane.subscribe(() => {
      const s = lane.getSnapshot();
      if (!s || s.phase !== 'hidden' || s.id === last) return;
      last = s.id;
      order.push(s.url);
      const nonce = nonceOf(s.script);
      setTimeout(() => lane.receive(JSON.stringify(s.url === blocked ? { nonce, kind: 'challenge' } : { nonce, kind: 'data', href: s.url, text: texts[s.url], usage: { bytes: 1000 } })), 5);
    });
    const searcher = createRetailerSearch(pool, 'test');
    const cfg: RetailerConfig = { ...example, online: { checked: '2026-09-25', feesUrl: main, pickupFeesUrl: pickup, delivery: { fee: 7 }, pickup: { fee: 1 } } };
    const got = await searcher.readFees(cfg);
    assert.deepEqual([got.delivery, got.pickup, got.url, got.bytes, order], [{ fee: 9.95 }, { freeOver: 35, fee: 4.95 }, `${main} ${pickup}`, 2000, [main, pickup]]);
    blocked = pickup;
    const half = await searcher.readFees(cfg);
    assert.deepEqual([half.delivery, half.pickup, half.count], [{ fee: 9.95 }, {}, 1], 'the pickup page’s bot check leaves the delivery page’s figures');
    blocked = main;
    texts[pickup] = 'Nothing here';
    const none = await searcher.readFees(cfg);
    assert.equal(none.count, 0);
  });

  await t('recipes: read hidden on the page lane from the recipe data the page publishes', async () => {
    const pool = new WebViewPool();
    const lane = pool.lane(PAGE_LANE, 'Pages');
    let reply: (nonce: string, url: string) => Record<string, unknown> = (nonce, url) => ({
      nonce, kind: 'data', href: url,
      sources: [{ label: 'ld+json', text: JSON.stringify({ '@type': 'Recipe', name: 'Pancakes', recipeIngredient: ['2 cups flour', '1 cup milk'] }) }],
    });
    let last = -1;
    lane.subscribe(() => {
      const s = lane.getSnapshot();
      if (!s || s.phase !== 'hidden' || s.id === last) return;
      last = s.id;
      assert.match(s.script, /WAIT_FOR = "details"/);
      setTimeout(() => lane.receive(JSON.stringify(reply(nonceOf(s.script), s.url))), 5);
    });
    const searcher = createRetailerSearch(pool, 'test');
    const recipe = await searcher.readRecipe('https://www.allrecipes.com/recipe/21014/pancakes/');
    assert.deepEqual([recipe.name, recipe.ingredients], ['Pancakes', ['2 cups flour', '1 cup milk']]);
    assert.equal(pool.feed.getSnapshot()[0].what, 'recipe');
    reply = (nonce, url) => ({ nonce, kind: 'data', href: url, sources: [] });
    await assert.rejects(searcher.readRecipe('https://example.com/not-a-recipe'), (e: any) => e.reason === 'no_recipe');
  });

  await t('store health: every attempt is recorded, with what it was for, how it went, the data and the rules', async () => {
    const pool = new WebViewPool();
    fakeWebView(pool.lane('example', 'Example'));
    const searcher = createRetailerSearch(pool, 'rules-7');
    const entries: any[] = [];
    const stop = searcher.onAttempt((e) => entries.push(e));
    await searcher.search(example, 'milk', '');
    await searcher.search(example, 'eggs', '', undefined, { kind: 'coverage' });
    stop();
    await searcher.search(example, 'bread', '');
    assert.deepEqual(entries.map((e) => [e.retailerId, e.kind, e.ok, e.via, e.rules]), [
      ['example', 'search', true, 'page', 'rules-7'],
      ['example', 'coverage', true, 'replay', 'rules-7'],
    ]);
  });

  await t('coverage searches report a bot check instead of covering the app; lighter pages follow the setting', async () => {
    const pool = new WebViewPool();
    pool.challengeGraceMs = 0;
    const lane = pool.lane('example', 'Example');
    const seen: { light: boolean }[] = [];
    let last = -1;
    lane.subscribe(() => {
      const s = lane.getSnapshot();
      if (!s || s.phase !== 'hidden' || s.id === last) return;
      last = s.id;
      seen.push({ light: /__stretchLight/.test(s.beforeScript ?? '') });
      setTimeout(() => lane.receive(JSON.stringify({ nonce: nonceOf(s.script), kind: 'challenge' })), 5);
    });
    const searcher = createRetailerSearch(pool, 'test');
    const err = await searcher.search(example, 'milk', '', undefined, { challenge: 'report' }).catch((e) => e);
    assert.ok(err instanceof SearchFailed);
    assert.equal(err.attempts[0].reason, 'challenge');
    assert.equal(pool.getSnapshot().presented, null, 'nothing covered the app');
    pool.setLightPages(false);
    await searcher.search(example, 'eggs', '', undefined, { challenge: 'report' }).catch(() => {});
    assert.deepEqual(seen, [{ light: true }, { light: false }]);
  });

  // --- Whole Foods: its store is set by the site's own request, and lasts only for the app's session -------------
  const wholefoods = BUNDLED_CONFIG.retailers.find((r) => r.id === 'wholefoods')!;
  /** Its search page's data for a query: products with sale and Prime prices, and the store the page is for. */
  const wfmData = (q: string) =>
    JSON.stringify({ props: { pageProps: {
      programType: 'GROCERY',
      productsInfo: Array.from({ length: 5 }, (_, i) => ({
        brandName: '365 by Whole Foods Market', name: `365 by Whole Foods Market ${q} ${i}`, asin: `B0${i}${q.length}`,
        productImages: ['https://m.media-amazon.com/images/I/x.jpg'], availability: 'IN_STOCK',
        offerDetails: { price: { currencyCode: 'USD', priceAmount: 3 + i, basisPriceAmount: i ? null : 3.5, savings: { savingsAmount: i ? null : 0.5 },
          primeBenefit: { isApplied: false, priceAmount: i ? null : 2.75 } } },
      })),
      wfmccLocationData: { cateringStoreContext: { almAttributes: { storeId: '10214', offerListingDiscriminator: 'A0BP' } } },
    } } });
  /** Plays the WebView at Whole Foods: its finder's page takes the store request, its search pages carry their data. */
  function fakeWholeFoods(lane: WebViewQueue) {
    const seen = { loads: [] as string[], requests: [] as { method: string; url: string; body?: string; headers?: Record<string, string> }[], replays: 0 };
    let lastId = -1;
    lane.subscribe(() => {
      const s = lane.getSnapshot();
      if (!s || s.phase !== 'hidden' || s.id === lastId) return;
      lastId = s.id;
      seen.loads.push(s.url);
      if (s.url.includes('/aplf/list')) {
        seen.requests.push(replayOf(s.script).req as never);
        setTimeout(() => lane.receive(JSON.stringify({ nonce: nonceOf(s.script), kind: 'data', href: s.url, pageResult: { status: 200 } })), 5);
      } else {
        const q = new URL(s.url).searchParams.get('k') ?? '';
        setTimeout(() => lane.receive(JSON.stringify({ nonce: nonceOf(s.script), kind: 'data', href: s.url, nextDataText: wfmData(q) })), 5);
      }
    });
    lane.attach((script) => {
      const { nonce, req } = replayOf(script);
      seen.replays++;
      setTimeout(() => reply(lane, nonce, { url: req.url, type: 'text/html', text: undefined, nextDataText: wfmData(new URL(req.url).searchParams.get('k') ?? ''), ld: [] }), 5);
    });
    return seen;
  }

  await t('Whole Foods: its store is set with the site’s own request, sent from its finder’s page; its prices are read from its page', async () => {
    const pool = new WebViewPool();
    const seen = fakeWholeFoods(pool.lane('wholefoods', 'Whole Foods'));
    const searcher = createRetailerSearch(pool, 'test');
    const set = await searcher.setStoreAuto(wholefoods, '43017', { id: '10214', name: 'Columbus' });
    assert.deepEqual(set, { ok: true, label: 'Columbus', store: { id: '10214', name: 'Columbus' } });
    assert.deepEqual(seen.loads, ['https://www.wholefoodsmarket.com/aplf/list?almBrandId=VUZHIFdob2xlIEZvb2Rz&context=wholefoods&postalCode=43017']);
    assert.deepEqual(seen.requests, [
      { method: 'PUT', url: 'https://www.wholefoodsmarket.com/api/store-affinity', body: '{"storeId":"10214"}', headers: { 'Content-Type': 'application/json' } },
    ]);

    const milk = await searcher.search(wholefoods, 'milk', '10214');
    const first = milk.products.find((p) => p.id === 'B004')!;
    assert.deepEqual([milk.via, milk.products.length, first.price, first.wasPrice, first.memberPrice, first.memberLabel], ['page', 5, 3, 3.5, 2.75, 'Prime member deal']);
    assert.deepEqual(milk.store, { id: '10214' }, 'the page’s own data says which store');
    const eggs = await searcher.search(wholefoods, 'eggs', '10214');
    assert.deepEqual([eggs.via, seen.replays, seen.requests.length], ['replay', 1, 1], 'set once: the next search is sent from the page, no store request');

    const unnumbered = await searcher.setStoreAuto(wholefoods, '43017', { name: 'Columbus' });
    assert.deepEqual(unnumbered, { ok: false, reason: 'no_store_number' }, 'the request takes the store’s number');
  });

  await t('Whole Foods: its store cookie ends with the app’s session, so the store is set again before the first search of the next', async () => {
    const pool = new WebViewPool();
    const seen = fakeWholeFoods(pool.lane('wholefoods', 'Whole Foods'));
    // A new session: the store was set before, but not since the app opened.
    const searcher = createRetailerSearch(pool, 'test');
    const [milk, eggs] = await Promise.all([searcher.search(wholefoods, 'milk', '10214'), searcher.search(wholefoods, 'eggs', '10214')]);
    assert.deepEqual([milk.products.length, eggs.products.length], [5, 5]);
    assert.equal(seen.requests.length, 1, 'once, however many searches start together');
    assert.equal(seen.loads[0], 'https://www.wholefoodsmarket.com/aplf/list?almBrandId=VUZHIFdob2xlIEZvb2Rz&context=wholefoods&postalCode=', 'before any search page');
    await searcher.search(wholefoods, 'bread', '10214');
    assert.equal(seen.requests.length, 1);
    // No store set: nothing to send.
    await searcher.search(wholefoods, 'rice', '');
    assert.equal(seen.requests.length, 1);
  });

  // --- Skipping a bot check, checks waiting their turn, erasing, one page load per store -------------------------------------
  await t('Skip: a store’s other searches waiting to load its page don’t meet its bot check again; the check shows once', async () => {
    // A store whose searches replay wait for its page; one that can't replay queues its page loads in the lane: both ways.
    for (const config of [example, { ...example, replay: false }]) {
      const pool = new WebViewPool();
      pool.challengeGraceMs = 0;
      const lane = pool.lane('example', 'Example');
      let lastLoad = -1;
      let lastCheck = '';
      let loads = 0;
      let shown = 0;
      // Every page load of this store meets a bot check, and the user taps “Skip Example” on it.
      lane.subscribe(() => {
        const s = lane.getSnapshot();
        if (!s) return;
        if (s.phase === 'hidden' && s.id !== lastLoad) {
          lastLoad = s.id;
          loads++;
          setTimeout(() => lane.receive(JSON.stringify({ nonce: nonceOf(s.script), kind: 'challenge' })), 5);
        }
        if (s.phase === 'challenge' && `${s.id}:${s.round}` !== lastCheck) {
          lastCheck = `${s.id}:${s.round}`;
          shown++;
          setTimeout(() => lane.cancel(), 5);
        }
      });
      const searcher = createRetailerSearch(pool, 'test', new StoreTuner());
      const heard: string[] = [];
      searcher.onAttempt((e) => heard.push(`${e.kind}:${e.reason}`));
      const engine = new PricingEngine((cfg, q, id) => searcher.search(cfg, q, id), new PriceCache(), 4, 3);
      engine.start('L', ['milk', 'eggs', 'bread', 'rice', 'jam'], [{ config, storeId: '', storeKey: 'k' }]);
      for (let i = 0; i < 300 && !engine.getRun('L')?.finishedAt; i++) await tick(10);
      const run = engine.getRun('L')!;
      const how = config.replay === false ? 'queued in the lane' : 'waiting for its page';
      assert.deepEqual([shown, loads, run.stores.example.stoppedBecause], [1, 1, 'You skipped the bot check'], how);
      assert.equal(heard.filter((h) => h === 'search:challenge_cancelled').length, 1, `${how}: one skip in the search log, not one for each search that waited`);
    }
  });

  await t('a bot check’s time counts only while it’s on screen: one behind a store visit waits, then gets its full time', async () => {
    const pool = new WebViewPool();
    pool.challengeGraceMs = 0;
    const visit = pool.lane('kroger', 'Kroger');
    const other = pool.lane('target', 'Target');
    other.challengeTimeoutMs = 30;
    const signingIn = visit.browse({ url: 'https://www.kroger.com/signin', retailerName: 'Kroger', purpose: 'signin' });
    let outcome = 'pending';
    const search = other.run(job({ url: 'https://www.target.com/s?searchTerm=milk', timeoutMs: 20 })).then(
      () => 'ok',
      (e: Error) => e.message,
    );
    void search.then((o) => (outcome = o));
    other.receive(JSON.stringify({ nonce: nonceOf(other.getSnapshot()!.script), kind: 'challenge' }));
    await tick(60);
    assert.deepEqual([outcome, other.getSnapshot()?.phase, pool.getSnapshot().presented], ['pending', 'challenge', visit], 'not on screen, so not out of time');
    visit.closeBrowse();
    await signingIn;
    assert.equal(pool.getSnapshot().presented, other);
    assert.equal(await search, 'challenge_timeout', 'its own time, once on screen');
  });

  await t('erasing everything mid-search: the search then running adds nothing anywhere, and the lane keeps no page from it', async () => {
    priceEvidence.clear();
    for (const q of ['milk', 'eggs']) {
      const pool = new WebViewPool();
      const lane = pool.lane('example', 'Example');
      // Page loads answer 60 ms after they start: milk with products, eggs with a page that refuses the phone.
      let last = -1;
      lane.subscribe(() => {
        const s = lane.getSnapshot();
        if (!s || s.phase !== 'hidden' || s.id === last) return;
        last = s.id;
        const query = queryOf(s.url);
        const request = { method: 'GET', url: apiUrl(query), headers: {}, credentials: 'include' };
        const msg =
          query === 'eggs'
            ? { nonce: nonceOf(s.script), kind: 'blocked', marker: 'Access Denied' }
            : { nonce: nonceOf(s.script), kind: 'data', href: s.url, sources: [{ label: `response ${request.url}`, text: apiJson(query), request }] };
        setTimeout(() => lane.receive(JSON.stringify(msg)), 60);
      });
      lane.attach(() => {});
      const tuner = new StoreTuner();
      const searcher = createRetailerSearch(pool, 'test', tuner);
      const heard: string[] = [];
      searcher.onAttempt((e) => heard.push(e.kind));
      const searching = searcher.search(example, q, '').catch((e: unknown) => e);
      await tick(20);
      // Erase everything (see startOver in AppProvider.tsx), as far as the search layer goes.
      searcher.reset();
      pool.resetAll();
      const feed = pool.feed.getSnapshot().length;
      const out = await searching;
      assert.ok(out instanceof SearchFailed && out.attempts.some((a) => a.reason === 'reset'), `${q}: it ends as erased`);
      assert.deepEqual(
        [heard, tuner.cooling('example')?.kind, priceEvidence.get('example', `${q}-0`), pool.feed.getSnapshot().length - feed, lane.hasPage(), lane.template],
        [[], undefined, undefined, 0, false, null],
        `${q}: no log, no cool-down, no X-ray, no feed, no kept page`,
      );
    }
  });

  await t('a product page waits for its store’s own page load: one page load at a time at each store', async () => {
    const pool = new WebViewPool();
    const lane = pool.lane('example', 'Example');
    const pages = pool.lane(PAGE_LANE, 'Pages');
    const searcher = createRetailerSearch(pool, 'test');
    const loading = lane.run(job());
    const product = searcher.readProduct(example, { retailer: 'example', storeId: '', id: 'p1', name: 'Milk', price: 2, url: 'https://www.example.com/p/1' });
    await tick(5);
    assert.equal(pages.getSnapshot(), null, 'the product page waits');
    data(lane);
    await loading;
    await tick(5);
    assert.equal(pages.getSnapshot()?.url, 'https://www.example.com/p/1', 'then loads');
    data(pages);
    await product.catch(() => {});
  });

  log(`\n${passed} lane and search tests passed`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
