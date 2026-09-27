/// <reference types="node" />
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { CONNECTION_ID, storeHealth, type AttemptEntry } from '../src/onDevice/attemptLog';
import { coverageStatus } from '../src/onDevice/coverage';
import { verdictOf, verdictWords, versusSummary } from '../src/onDevice/phoneVsServer';
import { citizenReport, Politeness, politeness } from '../src/onDevice/politeness';
import { createRetailerSearch, SearchFailed } from '../src/onDevice/retailerSearch';
import {
  blockOf,
  clockText,
  connectionWords,
  coolWords,
  dropFromLog,
  REST_MS,
  StoreTuner,
  tuneStore,
  tuningBase,
  tuningWords,
  type CoolDown,
  type TuningSample,
} from '../src/onDevice/tuning';
import type { RetailerConfig, SearchOutcome } from '../src/onDevice/types';
import { WebViewPool } from '../src/onDevice/webviewPool';
import type { WebViewQueue } from '../src/onDevice/webviewQueue';
import { DEFAULT_CHALLENGE_MARKERS, extractionScript } from '../src/onDevice/webviewScript';
import { PriceCache } from '../src/pricing/priceCache';
import { PricingEngine } from '../src/pricing/pricingEngine';

// Search events are logged for telemetry; keep them out of the test output.
const log = console.log;
console.log = (...args: unknown[]) => {
  if (!String(args[0]).startsWith('[on-device-')) log(...args);
};

let passed = 0;
const t = async (name: string, fn: () => unknown) => {
  await fn();
  passed++;
  log('ok -', name);
};
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const nonceOf = (script: string) => /var NONCE = "([^"]+)"/.exec(script)![1];
const replayOf = (script: string) => {
  const m = /var NONCE = ("[^"]*"), REQ = (\{.*\});\n/.exec(script)!;
  return { nonce: JSON.parse(m[1]) as string, req: JSON.parse(m[2]) as { url: string } };
};
const MIN = 60_000;

const store = (id: string, over: Partial<RetailerConfig> = {}): RetailerConfig => ({
  id,
  name: id.toUpperCase(),
  enabled: true,
  searchUrl: `https://www.${id}.com/s?q={{query}}`,
  homeUrl: `https://www.${id}.com/`,
  cookieTemplate: '',
  strategies: ['webview'],
  parser: 'autoDetect',
  waitFor: 'auto',
  challengeMarkers: DEFAULT_CHALLENGE_MARKERS,
  timeoutMs: 2000,
  storeHint: '',
  note: '',
  replay: false,
  ...over,
});
const queryOf = (url: string) => new URL(url).searchParams.get('q') ?? new URL(url).searchParams.get('keyword') ?? '';
const apiUrl = (id: string, q: string) => `https://api.${id}.com/search?keyword=${encodeURIComponent(q)}`;
const apiJson = (q: string, n = 12) => JSON.stringify({ results: Array.from({ length: n }, (_, i) => ({ id: `${q}-${i}`, name: `Brand ${q} ${i}`, price: { current: 2 + i / 10 } })) });

type PageAnswer = 'products' | 'blocked' | 'tiny' | 'empty';

/**
 * Plays a store's page: each load answers as `answer` says for its query (products; a page that refuses the phone; a
 * nearly empty page; a page without products). Replays answer with `replayStatus`, 200 unless it says otherwise.
 */
function shopWebView(lane: WebViewQueue, id: string, answer: (q: string) => PageAnswer, replayStatus: (q: string) => number = () => 200) {
  const seen = { pageLoads: 0, replays: 0 };
  let last = -1;
  lane.subscribe(() => {
    const s = lane.getSnapshot();
    if (!s || s.phase !== 'hidden' || s.id === last) return;
    last = s.id;
    seen.pageLoads++;
    const q = queryOf(s.url);
    const nonce = nonceOf(s.script);
    const a = answer(q);
    const request = { method: 'GET', url: apiUrl(id, q), headers: {}, credentials: 'include' };
    const msg =
      a === 'blocked'
        ? { nonce, kind: 'blocked', marker: 'Access Denied' }
        : a === 'tiny'
          ? { nonce, kind: 'data', href: s.url, sources: [], title: 'Error', size: { elements: 12, chars: 180 } }
          : a === 'empty'
            ? { nonce, kind: 'data', href: s.url, sources: [{ label: `response ${request.url}`, text: '{"results":[]}', request }], title: `${q} - Shop`, size: { elements: 900, chars: -1 } }
            : { nonce, kind: 'data', href: s.url, sources: [{ label: `response ${request.url}`, text: apiJson(q), request }] };
    setTimeout(() => lane.receive(JSON.stringify(msg)), 3);
  });
  lane.attach((script) => {
    if (!script.includes('REQ = ')) return;
    const { nonce, req } = replayOf(script);
    seen.replays++;
    const q = queryOf(req.url);
    const status = replayStatus(q);
    const text = status === 200 ? apiJson(q) : '{"error":"forbidden"}';
    setTimeout(() => lane.receive(JSON.stringify({ kind: 'replay', nonce, status, url: req.url, type: 'application/json', text })), 3);
  });
  return seen;
}

/** A search layer with its own tuner on a clock the test moves, and the log it writes. */
function setUp(ids: string[], answer: (id: string, q: string) => PageAnswer, opts: { replayStatus?: (q: string) => number; worked?: (id: string, q: string) => boolean } = {}) {
  let clock = Date.now();
  const tuner = new StoreTuner(() => clock);
  const pool = new WebViewPool();
  const pages = Object.fromEntries(ids.map((id) => [id, shopWebView(pool.lane(id, id.toUpperCase()), id, (q) => answer(id, q), opts.replayStatus)]));
  const searcher = createRetailerSearch(pool, 'rules-t', tuner, undefined, opts.worked ? { worked: opts.worked } : {});
  const entries: AttemptEntry[] = [];
  searcher.onAttempt((e) => entries.push(e));
  return { tuner, pool, pages, searcher, entries, later: (ms: number) => (clock += ms), now: () => clock };
}
const failure = (p: Promise<unknown>) => p.then(() => assert.fail('expected the search to fail'), (e: unknown) => e as SearchFailed);

(async () => {
  // --- What a block is ---------------------------------------------------------------------------------------------
  await t('blocks: a page that refuses the phone, HTTP 401, 403 or 429, a nearly empty page and bot checks; not a timeout', () => {
    assert.deepEqual(blockOf({ reason: 'blocked', detail: '“Access Denied”' }), { kind: 'blocked', said: '“Access Denied”' });
    assert.deepEqual(blockOf({ reason: 'blocked', detail: 'HTTP 403, a page of 380 characters, with “Access Denied” in it.' }), { kind: 'blocked', said: '“Access Denied”' });
    assert.deepEqual(blockOf({ reason: 'http_403', status: 403 }), { kind: 'refused', said: 'HTTP 403' });
    assert.deepEqual(blockOf({ reason: 'http_401' }), { kind: 'refused', said: 'HTTP 401' });
    assert.deepEqual(blockOf({ reason: 'replay_429' }), { kind: 'limited', said: '“too many requests” (HTTP 429)' });
    assert.deepEqual(blockOf({ reason: 'tiny_page' }), { kind: 'tiny', said: 'a nearly empty page' });
    assert.deepEqual(blockOf({ reason: 'challenge' }), { kind: 'check', said: 'a bot check' });
    assert.deepEqual(blockOf({ reason: 'challenge', detail: 'a captcha in a frame of the page' }), { kind: 'check', said: 'a captcha' });
    for (const reason of ['timeout', 'network', 'no_payload', 'http_503', 'http_500', undefined]) assert.equal(blockOf({ reason }), undefined, String(reason));
  });

  await t('captcha frames: a captcha showing in a frame is a bot check; an invisible one isn’t; it’s watched until it goes', async () => {
    const page = (frame: string, rect = { width: 304, height: 78 }) => {
      const dom = new JSDOM(`<html><head><title>Shop</title></head><body><div id="app"></div>${frame}</body></html>`, { url: 'https://www.shop.com/s?q=milk', runScripts: 'outside-only' });
      const w = dom.window as unknown as Record<string, unknown> & { eval: (s: string) => unknown; document: Document };
      const posts: Record<string, unknown>[] = [];
      w.ReactNativeWebView = { postMessage: (s: string) => posts.push(JSON.parse(s)) };
      for (const f of Array.from(w.document.getElementsByTagName('iframe'))) (f as unknown as { getBoundingClientRect: () => unknown }).getBoundingClientRect = () => rect;
      w.eval(extractionScript('n1', DEFAULT_CHALLENGE_MARKERS, undefined, { waitFor: 'auto', intervalMs: 10, giveUpMs: 40, maxTries: 12 }));
      return { w, posts };
    };
    const shown = page('<iframe src="https://www.google.com/recaptcha/api2/bframe?hl=en&v=1"></iframe>');
    await new Promise((r) => setTimeout(r, 60));
    assert.deepEqual(shown.posts.map((m) => [m.kind, m.frame]), [['challenge', true]]);
    // Solved: the frame goes, and the page carries on to post what it has.
    shown.w.document.querySelector('iframe')!.remove();
    await new Promise((r) => setTimeout(r, 250));
    assert.deepEqual(shown.posts.map((m) => m.kind), ['challenge', 'data']);
    const invisible = page('<iframe src="https://www.google.com/recaptcha/api2/anchor?size=invisible"></iframe>', { width: 256, height: 60 });
    const tinyFrame = page('<iframe src="https://newassets.hcaptcha.com/captcha/v1/a1/static/hcaptcha.html#frame=challenge"></iframe>', { width: 0, height: 0 });
    await new Promise((r) => setTimeout(r, 250));
    assert.deepEqual([invisible.posts.map((m) => m.kind), tinyFrame.posts.map((m) => m.kind)], [['data'], ['data']], 'they sit on ordinary pages');
  });

  // --- Cool-downs, in the store tuning ---------------------------------------------------------------------------------
  await t('cool-downs: a block cools the store, or only its blocked way while another works; each within two hours doubles, to an hour', () => {
    let now = 1_000_000;
    const tuner = new StoreTuner(() => now);
    const walmart: ('fetch' | 'webview' | 'replay')[] = ['fetch', 'webview', 'replay'];
    const plain = tuner.failed('walmart', 'fetch', { block: { kind: 'refused', said: 'HTTP 403' }, ways: walmart })!;
    assert.deepEqual([plain.way, plain.kind, plain.until - now], ['fetch', 'refused', 10 * MIN], 'its page still works');
    assert.equal(tuner.cooling('walmart'), undefined);
    const page = tuner.failed('walmart', 'webview', { block: { kind: 'blocked', said: '“Access Denied”' }, ways: walmart })!;
    assert.deepEqual([page.way, page.until - now], [undefined, 10 * MIN], 'nothing else left: the whole store');
    assert.equal(tuner.cooling('walmart'), page);
    // Only way, a replay: page loads go on.
    const replay = tuner.failed('target', 'replay', { block: { kind: 'refused', said: 'HTTP 403' }, ways: ['webview', 'replay'] })!;
    assert.deepEqual([replay.way, tuner.cooling('target')], ['replay', undefined]);
    // Doubling: 10, 20, 40, then an hour at most.
    const minutes: number[] = [];
    for (let i = 0; i < 5; i++) {
      const c = tuner.failed('aldi', 'webview', { block: { kind: 'tiny' }, ways: ['webview'] })!;
      minutes.push((c.until - now) / MIN);
      now = c.until + 1;
    }
    assert.deepEqual(minutes, [10, 20, 40, 60, 60]);
    now += 3 * 60 * MIN;
    assert.equal((tuner.failed('aldi', 'webview', { block: { kind: 'tiny' }, ways: ['webview'] })!.until - now) / MIN, 10, 'forgiven after two hours');
    // A quiet block is always the whole store.
    assert.equal(tuner.failed('kroger', 'api', { block: { kind: 'empty' }, ways: ['api', 'webview'] })!.way, undefined);
  });

  await t('rests: a bot check rests its way at once, two failures in a row rest it; a rest gives way to the last way left', async () => {
    let now = 5_000_000;
    const tuner = new StoreTuner(() => now);
    assert.equal(tuner.failed('walmart', 'fetch', { ways: ['fetch', 'webview'] }), undefined);
    const fails = tuner.failed('walmart', 'fetch', { ways: ['fetch', 'webview'] })!;
    assert.deepEqual([fails.kind, fails.until - now], ['fails', REST_MS]);
    tuner.worked('target', 'webview');
    assert.equal(tuner.failed('target', 'webview', {}), undefined, 'one failure');
    tuner.worked('target', 'webview');
    assert.equal(tuner.failed('target', 'webview', {}), undefined, 'a success in between starts the count again');
    const check = tuner.failed('heb', 'webview', { block: { kind: 'check', said: 'a bot check' }, ways: ['webview', 'replay'] })!;
    assert.deepEqual([check.kind, check.way], ['check', 'webview'], 'a rest is never the whole store');
    assert.equal(coolWords(check), `Its page resting after a bot check, until ${clockText(check.until)}`);
    // In a search: the store's only way resting still runs.
    const s = setUp(['heb'], () => 'products');
    s.tuner.failed('heb', 'webview', { block: { kind: 'check', said: 'a bot check' }, ways: ['webview'] });
    const got = await s.searcher.search(store('heb'), 'milk', '');
    assert.equal(got.products.length, 12);
    now += 1;
  });

  await t('the Careful level: a store cooling down says until when; one that refused the phone lately goes one search at a time after', () => {
    const now = 9_000_000;
    const base = { pageTimeoutMs: 20_000 };
    const cool: CoolDown = { retailerId: 'kroger', kind: 'blocked', said: '“Access Denied”', from: now - MIN, until: now + 9 * MIN };
    const cooling = tuneStore([], base, now, undefined, { store: cool });
    assert.deepEqual([cooling.level, cooling.searches, cooling.cooling], ['careful', 1, cool]);
    assert.equal(tuningWords(cooling), `Careful: Cooling down after “Access Denied”, retrying at ${clockText(cool.until)}.`);
    assert.equal(coolWords({ ...cool, way: 'fetch', said: 'HTTP 403' }), `Plain requests cooling down after HTTP 403, retrying at ${clockText(cool.until)}`);
    const sample = (over: Partial<TuningSample>): TuningSample => ({ at: now - 2 * MIN, ok: true, ms: 900, ...over });
    const after = tuneStore([...Array.from({ length: 6 }, () => sample({ replayMs: 500 })), sample({ ok: false, reason: 'blocked', blocked: true })], base, now);
    assert.deepEqual([after.level, after.gapMs], ['careful', 3000]);
    assert.match(after.why, /refused this phone in the last 15 minutes/);
    // A way resting shows with the rest of the tuning.
    const ways = tuneStore([], base, now, undefined, { ways: [{ ...cool, way: 'fetch', said: 'HTTP 403' }] });
    assert.match(tuningWords(ways), /Plain requests cooling down after HTTP 403/);
    // Cool-downs hold with adapting switched off.
    const tuner = new StoreTuner(() => now);
    tuner.failed('kroger', 'webview', { block: { kind: 'blocked', said: '“Access Denied”' }, ways: ['webview'] });
    tuner.enabled = false;
    assert.equal(tuner.get('kroger', base).level, 'careful');
  });

  // --- In searches ------------------------------------------------------------------------------------------------------
  await t('a page that refuses the phone: the store cools down; nothing goes out or counts in its hour until the retry time; the log notes it', async () => {
    const s = setUp(['kr1'], () => 'blocked');
    const cfg = store('kr1');
    const err = await failure(s.searcher.search(cfg, 'milk', ''));
    assert.deepEqual([err.attempts[0].reason, err.attempts[0].detail], ['blocked', '“Access Denied”']);
    assert.equal(s.pool.getSnapshot().presented, null, 'a block is never shown: there’s nothing to answer');
    const cool = s.tuner.cooling('kr1')!;
    assert.deepEqual([cool.kind, cool.said, cool.until - s.now()], ['blocked', '“Access Denied”', 10 * MIN]);
    assert.deepEqual(
      s.entries.map((e) => [e.kind, e.ok, e.reason, e.until, e.said]),
      [
        ['search', false, 'blocked', undefined, undefined],
        ['cooldown', false, 'blocked', cool.until, '“Access Denied”'],
      ],
    );
    const used = politeness.used('kr1');
    const skipped = await failure(s.searcher.search(cfg, 'eggs', ''));
    assert.deepEqual([skipped.attempts[0].reason, skipped.attempts[0].until, skipped.attempts[0].detail], ['cooling_down', cool.until, coolWords(cool)]);
    assert.deepEqual([s.pages.kr1.pageLoads, politeness.used('kr1'), s.entries.length], [1, used, 2], 'no page, no hour, no log');
    // Diagnostics' strategy picker still asks, on purpose; refused again, the store waits twice as long.
    await failure(s.searcher.search(cfg, 'jam', '', 'webview'));
    assert.equal(s.pages.kr1.pageLoads, 2);
    assert.equal(s.tuner.cooling('kr1')!.until - s.now(), 20 * MIN);
    // After the retry time, it's tried again; refused again, twice as long again.
    s.later(20 * MIN + 1000);
    await failure(s.searcher.search(cfg, 'bread', ''));
    assert.equal(s.pages.kr1.pageLoads, 3);
    assert.equal(s.tuner.cooling('kr1')!.until - s.now(), 40 * MIN);
  });

  await t('a way refused while the others work cools down alone; replays refused rest while page loads go on', async () => {
    const s = setUp(['wm'], () => 'products');
    const realFetch = globalThis.fetch;
    let fetches = 0;
    globalThis.fetch = (async () => {
      fetches++;
      return { status: 429, ok: false, url: 'https://www.wm.com/s', text: async () => 'slow down' };
    }) as unknown as typeof fetch;
    const both = store('wm', { strategies: ['fetch', 'webview'] });
    try {
      const first = await s.searcher.search(both, 'milk', '');
      const next = await s.searcher.search(both, 'eggs', '');
      assert.deepEqual([first.strategy, next.strategy, fetches], ['webview', 'webview', 1]);
      assert.deepEqual(next.attempts.map((a) => [a.strategy, a.reason ?? 'ok']), [['fetch', 'resting'], ['webview', 'ok']]);
      assert.deepEqual([s.tuner.cooling('wm', 'fetch')?.kind, s.tuner.cooling('wm')], ['limited', undefined]);
    } finally {
      globalThis.fetch = realFetch;
    }

    // Replays the store refuses (HTTP 403): the replay falls back to a page load, and replays wait out their cool-down.
    const r = setUp(['tg'], () => 'products', { replayStatus: (q) => (q === 'eggs' ? 403 : 200) });
    const target = store('tg', { replay: true });
    await r.searcher.search(target, 'milk', '');
    const eggs = await r.searcher.search(target, 'eggs', '');
    assert.deepEqual([eggs.via, r.pages.tg.replays, r.pages.tg.pageLoads], ['page', 1, 2]);
    assert.deepEqual([r.tuner.cooling('tg', 'replay')?.said, r.tuner.cooling('tg')], ['HTTP 403', undefined]);
    const bread = await r.searcher.search(target, 'bread', '');
    assert.deepEqual([bread.via, r.pages.tg.replays], ['page', 1], 'no replay while they cool down');
    r.later(10 * MIN + 1000);
    const jam = await r.searcher.search(target, 'jam', '');
    assert.equal(jam.via, 'replay', 'then replays again');
  });

  await t('quiet blocks: no results, twice in a row, for searches that worked before cool the store down; a new search’s none don’t', async () => {
    let hiding = false;
    const s = setUp(['sp'], (_id, q) => (hiding || q === 'saffron' ? 'empty' : 'products'), { worked: (_id, q) => q === 'bread' });
    const cfg = store('sp');
    await s.searcher.search(cfg, 'milk', '');
    await s.searcher.search(cfg, 'eggs', '');
    await failure(s.searcher.search(cfg, 'saffron', ''));
    await failure(s.searcher.search(cfg, 'saffron', ''));
    assert.equal(s.tuner.cooling('sp'), undefined, 'searches that never gave anything say nothing');
    hiding = true;
    await failure(s.searcher.search(cfg, 'milk', ''));
    assert.equal(s.tuner.cooling('sp'), undefined, 'once may be a hiccup');
    // A search the phone's saved prices say worked counts too.
    await failure(s.searcher.search(cfg, 'bread', ''));
    const cool = s.tuner.cooling('sp')!;
    assert.deepEqual([cool.kind, cool.said], ['empty', 'no results for 2 searches that gave some before']);

    // One search counts once, however many ways it tried: a plain request and the page both without results.
    const b = setUp(['wf'], () => 'empty', { worked: (_id, q) => q === 'milk' || q === 'eggs' });
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string) => ({ status: 200, ok: true, url, text: async () => `<html><body>${'<p>Our shelves</p>'.repeat(3000)}</body></html>` })) as unknown as typeof fetch;
    try {
      const both = store('wf', { strategies: ['fetch', 'webview'] });
      const one = await failure(b.searcher.search(both, 'milk', ''));
      assert.deepEqual(one.attempts.map((a) => [a.strategy, a.reason]), [['fetch', 'no_payload'], ['webview', 'no_payload']]);
      assert.equal(b.tuner.cooling('wf'), undefined, 'one search, not two');
      await failure(b.searcher.search(both, 'eggs', ''));
      assert.equal(b.tuner.cooling('wf')?.said, 'no results for 2 searches that gave some before');
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  await t('tiny pages: a nearly empty page with no product data is a block too', async () => {
    const s = setUp(['mj'], () => 'tiny');
    const err = await failure(s.searcher.search(store('mj'), 'milk', ''));
    assert.equal(err.attempts[0].reason, 'tiny_page');
    assert.equal(s.tuner.cooling('mj')?.kind, 'tiny');
  });

  // --- The connection, not the stores ---------------------------------------------------------------------------------------
  await t('connection: stores on two sites or more failing within seconds of each other, none working, is the connection: no cool-downs, and ones started are called off', () => {
    let now = 50_000_000;
    const tuner = new StoreTuner(() => now);
    const blocked = { kind: 'blocked' as const, said: '“Access Denied”' };
    assert.ok(tuner.failed('target', 'webview', { block: blocked, ways: ['webview'] }));
    assert.equal(tuner.outcome('target', false), undefined, 'one store: it may be the store');
    assert.ok(tuner.cooling('target'));
    now += 3000;
    tuner.failed('kroger', 'api', { block: { kind: 'refused', said: 'HTTP 403' }, ways: ['api', 'webview'] });
    const drop = tuner.outcome('kroger', false)!;
    assert.deepEqual([drop.stores, drop.lifted, drop.to - drop.from], [['target', 'kroger'], 2, 3000]);
    assert.deepEqual([tuner.cooling('target'), tuner.cooling('kroger', 'api')], [undefined, undefined], 'called off');
    now += 2000;
    assert.equal(tuner.failed('aldi', 'webview', { block: blocked, ways: ['webview'] }), undefined, 'none while it’s down');
    assert.equal(tuner.outcome('aldi', false), undefined, 'the same drop, not a new one');
    assert.deepEqual(tuner.connection()!.stores, ['target', 'kroger', 'aldi']);
    assert.equal(
      connectionWords(tuner.connection()!, (id) => id.toUpperCase(), 'iPhone'),
      `The connection dropped at ${clockText(drop.from)}: TARGET, KROGER and ALDI all failed within 5 seconds. That’s this iPhone’s connection (a VPN, or no internet), not the stores, so none of them is cooling down for it.`,
    );
    now += 1000;
    tuner.outcome('walmart', true);
    assert.ok(tuner.connection()!.endedAt, 'a search that works ends it');
    now += 20_000;
    assert.ok(tuner.failed('aldi', 'webview', { block: blocked, ways: ['webview'] }), 'and stores cool down again');
    // A search that worked meanwhile means it's the stores.
    const other = new StoreTuner(() => now);
    other.outcome('target', false);
    other.outcome('walmart', true);
    assert.equal(other.outcome('kroger', false), undefined);
    // Failures far apart are the stores' own.
    const apart = new StoreTuner(() => now);
    apart.outcome('target', false);
    now += 16_000;
    assert.equal(apart.outcome('kroger', false), undefined);
    // Chains on one site failing together are that site refusing the phone: they cool down as usual.
    const family = new StoreTuner(() => now);
    family.failed('kroger', 'webview', { block: blocked, ways: ['webview'] });
    assert.equal(family.outcome('kroger', false, 'kroger'), undefined);
    family.failed('ralphs', 'webview', { block: blocked, ways: ['webview'] });
    assert.equal(family.outcome('ralphs', false, 'kroger'), undefined);
    assert.deepEqual([!!family.cooling('kroger'), !!family.cooling('ralphs'), family.connection()], [true, true, undefined]);
    // A store on another site failing with them is the connection again.
    assert.deepEqual(family.outcome('target', false)?.stores, ['kroger', 'ralphs', 'target']);
  });

  await t('connection, end to end: every store blocked at once cools none, notes the drop once, and the engine says the connection dropped', async () => {
    const s = setUp(['c1', 'c2', 'c3'], () => 'blocked');
    const lines: string[] = [];
    const quiet = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
      quiet(...args);
    };
    await Promise.all(['c1', 'c2', 'c3'].map((id) => failure(s.searcher.search(store(id), 'milk', ''))));
    console.log = quiet;
    // The phone's log (Metro's): the first store's cool-down, then the drop that called it off.
    const notes = lines.filter((l) => l.startsWith('[on-device-note]')).map((l) => JSON.parse(l.slice(l.indexOf('{'))) as { note: string; stores?: string[]; lifted?: number });
    // Each of the first two stores' searches cooled it down as it failed; the second's found the drop, which called both off.
    assert.deepEqual(notes.map((n) => [n.note, n.stores?.length, n.lifted]), [['cooldown', undefined, undefined], ['cooldown', undefined, undefined], ['connection', 2, 2]]);
    assert.deepEqual(['c1', 'c2', 'c3'].map((id) => s.tuner.cooling(id)), [undefined, undefined, undefined]);
    const drops = s.entries.filter((e) => e.kind === 'connection');
    assert.equal(drops.length, 1);
    assert.deepEqual([drops[0].retailerId, drops[0].stores?.length], [CONNECTION_ID, 2]);
    assert.deepEqual(s.tuner.connection()!.stores.sort(), ['c1', 'c2', 'c3']);
    assert.ok(dropFromLog(s.entries, s.now()), 'after the app reopens, from the log');
    // The engine words a store's stop as the connection's, not "kept failing".
    const engine = new PricingEngine(async () => {
      throw new SearchFailed([{ strategy: 'webview', ok: false, reason: 'network', ms: 5 }]);
    }, new PriceCache());
    engine.setConcurrency({ searches: () => 1, stores: (max) => max, connectionDropped: () => ({ from: 0 }) });
    engine.start('L', ['milk', 'eggs', 'bread'], [{ config: store('c1'), storeId: '', storeKey: 'k' }]);
    for (let i = 0; i < 100 && !engine.getRun('L')?.finishedAt; i++) await tick(5);
    assert.equal(engine.getRun('L')!.stores.c1.stoppedBecause, 'The connection dropped');

    // A store given up on a moment before the next store's failure told of the drop: its stop is the connection's too.
    let drop: { from: number } | undefined;
    const two = new PricingEngine(async (cfg) => {
      if (cfg.id === 'c2') await tick(40);
      throw new SearchFailed([{ strategy: 'webview', ok: false, reason: 'timeout', ms: 5 }]);
    }, new PriceCache());
    const since = Date.now();
    two.setConcurrency({ searches: () => 2, stores: (max) => max, connectionDropped: () => drop });
    two.start('M', ['milk', 'eggs', 'bread'], ['c1', 'c2'].map((id) => ({ config: store(id), storeId: '', storeKey: 'k' })));
    for (let i = 0; i < 100 && !two.getRun('M')!.stores.c1.stoppedBecause; i++) await tick(2);
    assert.equal(two.getRun('M')!.stores.c1.stoppedBecause, 'Kept failing (timeout)');
    drop = { from: since };
    for (let i = 0; i < 100 && !two.getRun('M')?.finishedAt; i++) await tick(5);
    const m = two.getRun('M')!;
    assert.deepEqual([m.stores.c1.stoppedBecause, m.stores.c2.stoppedBecause, m.results.c1.bread.reason], ['The connection dropped', 'The connection dropped', 'The connection dropped']);
  });

  // --- The pricing engine -----------------------------------------------------------------------------------------------
  await t('engine: a store cooling down is skipped with its words, not failed twice, and tried again at its retry time', async () => {
    const searched: string[] = [];
    const until = Date.now() + 60;
    let cooling = true;
    const engine = new PricingEngine(async (cfg, q): Promise<SearchOutcome> => {
      searched.push(`${cfg.id}:${q}`);
      return { retailer: cfg.name, products: [{ retailer: cfg.id, storeId: '', id: q, name: `Brand ${q}`, price: 2 }], strategy: 'webview', ms: 5, attempts: [] };
    }, new PriceCache());
    const words = `Cooling down after “Access Denied”, retrying at ${clockText(until)}`;
    engine.setConcurrency({ searches: () => 2, stores: (max) => max, cooling: (cfg) => (cfg.id === 'kr' && cooling ? { until, words } : undefined) });
    engine.start('L', ['milk', 'eggs'], [
      { config: store('kr'), storeId: '', storeKey: 'k' },
      { config: store('wm'), storeId: '', storeKey: 'k' },
    ]);
    for (let i = 0; i < 100 && !engine.getRun('L')?.finishedAt; i++) await tick(5);
    const run = engine.getRun('L')!;
    assert.deepEqual([run.stores.kr.stoppedBecause, run.stores.kr.retryAt, run.results.kr.milk.status, run.results.kr.milk.reason, run.results.kr.milk.detail], [
      words, until, 'skipped', 'cooling_down', words,
    ]);
    assert.deepEqual(searched.sort(), ['wm:eggs', 'wm:milk'], 'nothing went out to it');
    cooling = false;
    for (let i = 0; i < 200 && engine.getRun('L')!.results.kr.milk.status !== 'done'; i++) await tick(10);
    assert.deepEqual([engine.getRun('L')!.results.kr.milk.status, engine.getRun('L')!.stores.kr.retryAt], ['done', undefined], 'tried again at its retry time');
    assert.ok(searched.includes('kr:milk'));

    // A store that starts cooling down mid-run: its other items wait for the retry time instead of failing too.
    let calls = 0;
    const later = Date.now() + 10 * MIN;
    const mid = new PricingEngine(async (cfg, q): Promise<SearchOutcome> => {
      calls++;
      if (q === 'milk') throw new SearchFailed([{ strategy: 'webview', ok: false, reason: 'blocked', detail: '“Access Denied”', ms: 5 }]);
      throw new SearchFailed([{ strategy: 'webview', ok: false, reason: 'cooling_down', detail: `Cooling down, retrying at ${clockText(later)}`, until: later, ms: 0 }]);
    }, new PriceCache());
    mid.setConcurrency({ searches: () => 1, stores: (max) => max });
    mid.start('M', ['milk', 'eggs', 'bread', 'jam'], [{ config: store('kr'), storeId: '', storeKey: 'k' }]);
    for (let i = 0; i < 100 && !mid.getRun('M')?.finishedAt; i++) await tick(5);
    const m = mid.getRun('M')!;
    assert.deepEqual([calls, m.stores.kr.stoppedBecause, m.stores.kr.retryAt], [2, `Cooling down, retrying at ${clockText(later)}`, later]);
    assert.deepEqual(['milk', 'eggs', 'bread', 'jam'].map((k) => m.results.kr[k].status), ['failed', 'skipped', 'skipped', 'skipped']);
    mid.reset();
  });

  // --- Kept in the log, counted apart --------------------------------------------------------------------------------------------
  await t('the log: cool-downs outlive the app, but not ones a dropped connection called off; Store health counts them; notes aren’t visits', () => {
    const now = 80_000_000;
    const entries: AttemptEntry[] = [
      { at: now - 2 * MIN, retailerId: 'kroger', kind: 'search', strategy: 'webview', ok: false, reason: 'blocked', ms: 900 },
      { at: now - 2 * MIN, retailerId: 'kroger', kind: 'cooldown', ok: false, reason: 'blocked', ms: 0, until: now + 8 * MIN, said: '“Access Denied”' },
      { at: now - MIN, retailerId: 'walmart', kind: 'cooldown', strategy: 'fetch', ok: false, reason: 'refused', ms: 0, until: now + 9 * MIN, said: 'HTTP 403' },
      { at: now - MIN, retailerId: 'target', kind: 'cooldown', strategy: 'webview', via: 'replay', ok: false, reason: 'refused', ms: 0, until: now + 9 * MIN, said: 'HTTP 403' },
      { at: now - 40 * MIN, retailerId: 'aldi', kind: 'cooldown', ok: false, reason: 'tiny', ms: 0, until: now - 30 * MIN },
      // H-E-B's failure began a drop, found 3 s later when Meijer's failed: its cool-down was called off then.
      { at: now - 5 * MIN - 3000, retailerId: 'heb', kind: 'cooldown', ok: false, reason: 'blocked', ms: 0, until: now + 5 * MIN - 3000 },
      { at: now - 5 * MIN, retailerId: CONNECTION_ID, kind: 'connection', ok: false, reason: 'connection', ms: 3000, until: now - 5 * MIN + 15_000, stores: ['heb', 'meijer'] },
    ];
    const tuner = new StoreTuner(() => now);
    tuner.seed(entries);
    assert.deepEqual(
      [tuner.cooling('kroger')?.said, tuner.cooling('walmart', 'fetch')?.said, tuner.cooling('target', 'replay')?.kind, tuner.cooling('aldi'), tuner.cooling('heb')],
      ['“Access Denied”', 'HTTP 403', 'refused', undefined, undefined],
    );
    assert.equal(storeHealth(entries, 'kroger', now).coolDowns, 1);
    assert.equal(storeHealth(entries, 'heb', now).coolDowns, 0, 'called off by the drop');
    assert.equal(storeHealth(entries, 'kroger', now).attempts, 1, 'the note isn’t a search');
    assert.deepEqual(citizenReport(entries, 0).map((r) => [r.retailerId, r.searches, r.otherPages]), [['kroger', 1, 0]]);
    const hour = new Politeness(120, () => now);
    hour.seed(entries);
    assert.equal(hour.used('kroger'), 1);
    const drop = dropFromLog(entries, now)!;
    assert.deepEqual([drop.stores, drop.from, drop.to], [['heb', 'meijer'], now - 5 * MIN - 3000, now - 5 * MIN]);
  });

  await t('the store check and the phone vs. server test say a store is cooling down, and don’t count it as tried', () => {
    assert.equal(coverageStatus('cooling_down'), 'cooling');
    assert.equal(coverageStatus('blocked'), 'bot_check');
    assert.equal(coverageStatus('tiny_page'), 'bot_check');
    assert.deepEqual([verdictOf('cooling_down'), verdictOf('blocked'), verdictOf('tiny_page')], ['cooling', 'blocked', 'empty']);
    const cooling = { verdict: 'cooling' as const, products: 0, ms: 0 };
    assert.equal(verdictWords(cooling), 'Not tried: cooling down after a block');
    const s = versusSummary({ stores: [{ retailerId: 'kroger', name: 'Kroger' }], rows: { kroger: { retailerId: 'kroger', at: 1, browser: cooling, plain: cooling } } });
    assert.deepEqual([s.tried, s.cooling], [0, 1]);
    assert.equal(tuningBase(store('x')).pageTimeoutMs, 2000);
  });

  log(`\n${passed} cool-down tests passed`);
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
