/// <reference types="node" />
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { storeHealth, type AttemptEntry } from '../src/onDevice/attemptLog';
import { searchViaFetch, StrategyError } from '../src/onDevice/fetchStrategy';
import { autoDetect } from '../src/onDevice/parsers';
import {
  bestCaseText,
  blockedLine,
  DATACENTER,
  DATACENTER_DAY,
  datacenterFor,
  datacenterLine,
  datacenterWords,
  fromFailure,
  fromOutcome,
  PhoneVsServer,
  plainConfig,
  sideText,
  summaryLine,
  verdictOf,
  verdictWords,
  versusIds,
  versusSummary,
  versusText,
  type SideResult,
  type VersusDeps,
  type VersusState,
  type VersusSummary,
} from '../src/onDevice/phoneVsServer';
import { citizenReport, politeness, Politeness } from '../src/onDevice/politeness';
import { createRetailerSearch, SearchFailed } from '../src/onDevice/retailerSearch';
import { BUNDLED_CONFIG } from '../src/onDevice/retailers';
import { bytesText } from '../src/onDevice/scrapeFeed';
import { StoreTuner, tuningBase } from '../src/onDevice/tuning';
import type { Product, RetailerConfig, SearchOutcome } from '../src/onDevice/types';
import { WebViewPool } from '../src/onDevice/webviewPool';
import type { WebViewQueue } from '../src/onDevice/webviewQueue';
import { DEFAULT_CHALLENGE_MARKERS } from '../src/onDevice/webviewScript';

// Search events are logged for telemetry; keep them out of the test output.
const log = console.log;
console.log = (...args: unknown[]) => {
  if (!String(args[0]).startsWith('[on-device-')) log(...args);
};

let passed = 0;
const t = async (name: string, fn: () => unknown) => { await fn(); passed++; log('ok -', name); };
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const rules = (id: string) => BUNDLED_CONFIG.retailers.find((r) => r.id === id)!;
const side = (verdict: SideResult['verdict'], extra: Partial<SideResult> = {}): SideResult => ({ verdict, products: verdict === 'prices' ? 12 : 0, ms: 1000, ...extra });
const info = (id: string) => {
  const r = BUNDLED_CONFIG.retailers.find((x) => x.id === id);
  return { retailerId: id, name: r?.name ?? id, ...(r?.sisterOf ? { sisterOf: r.sisterOf, parentName: rules(r.sisterOf).name } : {}) };
};
const summaryOf = (plain: number, browser: number, tried: number): VersusSummary => ({
  tried,
  plain: { prices: plain, blocked: 0, bytes: 0 },
  browser: { prices: browser, blocked: 0, bytes: 0 },
  paused: 0,
  cooling: 0,
  datacenter: { stores: 0, blocked: 0, noPrices: 0, loaded: 0 },
});

/** A store for searches end to end: its page loads in a simulated WebView. */
const store = (id: string, over: Partial<RetailerConfig> = {}): RetailerConfig => ({
  id, name: id.toUpperCase(), enabled: true, searchUrl: `https://www.${id}.com/s?q={{query}}`, homeUrl: `https://www.${id}.com/`,
  cookieTemplate: '', strategies: ['webview'], parser: 'autoDetect', waitFor: 'auto', challengeMarkers: DEFAULT_CHALLENGE_MARKERS,
  timeoutMs: 1000, storeHint: '', note: '', ...over,
});
const nonceOf = (script: string) => /var NONCE = "([^"]+)"/.exec(script)![1];
/** Plays a store's page in the WebView: its own request brings four products, or the page is a bot check. */
function fakePage(lane: WebViewQueue, answer: () => 'data' | 'challenge' = () => 'data') {
  let last = -1;
  lane.subscribe(() => {
    const s = lane.getSnapshot();
    if (!s || s.phase !== 'hidden' || s.id === last) return;
    last = s.id;
    const q = new URL(s.url).searchParams.get('q') ?? '';
    const request = { method: 'GET', url: `https://api.example.com/search?keyword=${q}`, headers: {}, credentials: 'include' };
    const products = [1, 2, 3, 4].map((i) => ({ id: `${q}-${i}`, title: `Brand ${q} ${i}`, price: { current: 2 + i } }));
    const reply =
      answer() === 'data'
        ? { nonce: nonceOf(s.script), kind: 'data', href: s.url, sources: [{ label: `response ${request.url}`, text: JSON.stringify({ products }), request }], usage: { bytes: 2_000_000 } }
        : { nonce: nonceOf(s.script), kind: 'challenge' };
    setTimeout(() => lane.receive(JSON.stringify(reply)), 5);
  });
}
const realFetch = globalThis.fetch;
/** Answers every plain request with `body`, after `ms` on the network; returns what was asked. */
const stubFetch = (body: string, status = 200, ms = 0) => {
  const calls: { url: string; opts: any }[] = [];
  globalThis.fetch = (async (url: string, opts: any) => {
    calls.push({ url, opts });
    await tick(ms);
    return { status, ok: status < 400, url, text: async () => body } as any;
  }) as any;
  return calls;
};

(async () => {
  // --- The summary ----------------------------------------------------------------------------------------
  await t('summary: stores tried both ways, where each way got prices or was blocked, and the datacenter’s record for them', () => {
    const state: Pick<VersusState, 'stores' | 'rows'> = {
      stores: ['walmart', 'target', 'kroger', 'aldi', 'ralphs', 'mine', 'meijer', 'publix'].map(info),
      rows: {
        walmart: { retailerId: 'walmart', at: 1, browser: side('prices', { bytes: 3_000_000 }), plain: side('blocked', { reason: 'challenge', bytes: 2000 }) },
        target: { retailerId: 'target', at: 1, browser: side('prices'), plain: side('no_prices', { reason: 'no_payload', bytes: 900_000 }) },
        kroger: { retailerId: 'kroger', at: 1, browser: side('blocked', { reason: 'challenge' }), plain: side('blocked', { reason: 'http_503' }) },
        aldi: { retailerId: 'aldi', at: 1, browser: side('prices'), plain: side('empty', { reason: 'no_payload', bytes: 120 }) },
        ralphs: { retailerId: 'ralphs', at: 1, browser: side('prices'), plain: side('prices') },
        mine: { retailerId: 'mine', at: 1, browser: side('slow', { reason: 'timeout' }), plain: side('failed', { reason: 'network' }) },
        meijer: { retailerId: 'meijer', at: 1, pausedUntil: 99 },
        // Still being tested: not counted yet.
        publix: { retailerId: 'publix', at: 1, browser: side('prices') },
      },
    };
    const s = versusSummary(state);
    assert.equal(s.tried, 6);
    assert.deepEqual(s.plain, { prices: 1, blocked: 3, bytes: 2000 + 900_000 + 120 });
    assert.deepEqual(s.browser, { prices: 4, blocked: 1, bytes: 3_000_000 });
    assert.equal(s.paused, 1);
    assert.deepEqual(s.datacenter, { stores: 4, blocked: 2, noPrices: 1, loaded: 1 }, 'Walmart, Target, Kroger and ALDI: not the regional chain, not the added store');
    assert.equal(summaryLine(s, 'iPhone'), 'From a plain request: 1 of 6 stores gave prices. From this iPhone’s browser: 4 of 6.');
    assert.equal(blockedLine(s), 'Blocked (a bot check, a refusal or an empty page): the plain request at 3 stores, the browser at 1.');
    assert.equal(
      datacenterLine(s),
      'From a datacenter, one request each (Sep 24, 2026): blocked at 2 of 4 stores; the page came without prices at 1; it loaded at 1 (prices not noted).',
    );
  });

  await t('summary line: the words the result is shared in, one store or fourteen', () => {
    assert.equal(summaryLine(summaryOf(3, 12, 14)), 'From a plain request: 3 of 14 stores gave prices. From this phone’s browser: 12 of 14.');
    assert.equal(summaryLine(summaryOf(0, 1, 1), 'iPhone'), 'From a plain request: 0 of 1 store gave prices. From this iPhone’s browser: 1 of 1.');
    assert.equal(blockedLine(summaryOf(0, 1, 1)), null, 'nothing blocked, nothing said');
    assert.equal(datacenterLine(summaryOf(0, 1, 1)), null, 'no store with a record');
    const one = versusSummary({ stores: [info('walmart')], rows: { walmart: { retailerId: 'walmart', at: 1, browser: side('prices'), plain: side('blocked', { reason: 'challenge' }) } } });
    assert.equal(datacenterLine(one), 'From a datacenter, one request each (Sep 24, 2026): blocked at 1 of 1 store.');
    assert.equal(blockedLine(one), 'Blocked (a bot check, a refusal or an empty page): the plain request at 1 store, the browser at 0.');
    assert.match(bestCaseText('iPhone'), /this iPhone’s own internet address.*server’s best case\. Over a VPN, both ways left from the VPN’s address instead\.$/);
  });

  // --- What each way got ------------------------------------------------------------------------------------
  await t('verdicts: bot checks and refusals are blocks, a tiny page is empty, a big one just has no prices; each in words', () => {
    const cases: [string | undefined, number | undefined, string][] = [
      ['challenge', undefined, 'blocked'],
      ['challenge_timeout', undefined, 'blocked'],
      ['http_401', undefined, 'blocked'],
      ['http_403', undefined, 'blocked'],
      ['http_429', undefined, 'blocked'],
      ['http_503', undefined, 'blocked'],
      ['http_404', undefined, 'failed'],
      ['no_payload', 0, 'empty'],
      ['no_payload', 1999, 'empty'],
      ['no_payload', 2000, 'no_prices'],
      ['no_payload', undefined, 'no_prices'],
      ['empty', undefined, 'no_prices'],
      ['timeout', undefined, 'slow'],
      ['polite_limit', undefined, 'paused'],
      ['network', undefined, 'failed'],
      [undefined, undefined, 'failed'],
    ];
    for (const [reason, bytes, want] of cases) assert.equal(verdictOf(reason, bytes), want, `${reason} ${bytes}`);
    assert.equal(verdictWords(side('prices')), '12 products');
    assert.equal(verdictWords(side('prices', { products: 1 })), '1 product');
    assert.equal(verdictWords(side('blocked', { reason: 'challenge', status: 403 })), 'Bot check (403)');
    assert.equal(verdictWords(side('blocked', { reason: 'challenge', status: 200 })), 'Bot check');
    assert.equal(verdictWords(side('blocked', { reason: 'challenge' })), 'Bot check', 'a page’s bot check has no status');
    assert.equal(verdictWords(side('blocked', { reason: 'http_403', status: 403 })), 'Blocked (403)');
    assert.equal(verdictWords(side('blocked', { reason: 'http_429' })), 'Too many requests (429)');
    assert.equal(verdictWords(side('blocked', { reason: 'http_503' })), 'Blocked (503)');
    assert.equal(verdictWords(side('empty')), 'An empty page');
    assert.equal(verdictWords(side('no_prices')), 'No prices in the page');
    assert.equal(verdictWords(side('slow')), 'Too slow');
    assert.equal(verdictWords(side('paused')), 'Not tried: its hour is full');
    assert.equal(verdictWords(side('failed', { reason: 'network' })), 'No connection');
    assert.equal(verdictWords(side('failed', { reason: 'http_404' })), 'HTTP 404');
    const got = side('prices', { ms: 6100, bytes: 2_100_000, how: 'page load', first: { name: 'Great Value Whole Milk, 1 gal', price: 3.64 } });
    assert.equal(sideText(got, true), `12 products (Great Value Whole Milk, 1 gal, $3.64) · 6.1 s · ${bytesText(2_100_000)} · page load`);
    assert.equal(sideText(side('blocked', { reason: 'challenge', status: 403, ms: 1200, bytes: 900 })), `Bot check (403) · 1.2 s · ${bytesText(900)}`);
    assert.equal(sideText(side('paused')), 'Not tried: its hour is full', 'no time for a search that never went out');
  });

  await t('a search that worked: its priced products, the first that isn’t an ad, and the time of the try that got them', () => {
    const p = (id: string, price: number | null, extra: Partial<Product> = {}): Product => ({ retailer: 'target', storeId: '', id, name: `Milk ${id}`, price, ...extra });
    const out: SearchOutcome = {
      retailer: 'Target',
      products: [p('ad', 2, { sponsored: true }), p('none', null), p('a', 3.64), p('b', 4.19)],
      strategy: 'webview',
      via: 'page',
      // The whole search, a pause for the store's tuning included.
      ms: 9000,
      attempts: [{ strategy: 'webview', ok: true, ms: 6100, via: 'page' }],
      bytes: 2_100_000,
    };
    assert.deepEqual(fromOutcome(out), { verdict: 'prices', products: 3, ms: 6100, bytes: 2_100_000, how: 'page load', first: { name: 'Milk a', price: 3.64 } });
    const none = fromOutcome({ ...out, products: [p('none', null)], strategy: 'fetch', via: undefined });
    assert.deepEqual([none.verdict, none.products, none.reason, none.how, none.first], ['no_prices', 0, 'empty', 'direct request', undefined]);
  });

  await t('a search that failed: its reason, the store’s answer (status, size, what it showed), and how long it took', () => {
    const blocked = fromFailure(new SearchFailed([{ strategy: 'fetch', ok: false, reason: 'challenge', ms: 1200, status: 403, bytes: 2400, detail: 'HTTP 403, a page of 2 KB, with “Access Denied” in it.' }]), 5);
    assert.deepEqual(blocked, { verdict: 'blocked', products: 0, ms: 1200, bytes: 2400, status: 403, reason: 'challenge', detail: 'HTTP 403, a page of 2 KB, with “Access Denied” in it.' });
    const empty = fromFailure(new SearchFailed([{ strategy: 'fetch', ok: false, reason: 'no_payload', ms: 300, status: 200, bytes: 0 }]), 5);
    assert.deepEqual([empty.verdict, empty.bytes], ['empty', 0], 'an empty body is still a size');
    const resting = fromFailure(new SearchFailed([{ strategy: 'webview', ok: false, reason: 'resting', ms: 0 }, { strategy: 'webview', ok: false, reason: 'timeout', ms: 20_000 }]), 5);
    assert.deepEqual([resting.verdict, resting.ms], ['slow', 20_000]);
    assert.equal(fromFailure(new SearchFailed([{ strategy: 'webview', ok: false, reason: 'polite_limit', ms: 0 }]), 0).verdict, 'paused');
    assert.deepEqual(fromFailure(new Error('boom'), 42), { verdict: 'failed', products: 0, ms: 42, reason: 'boom' });
  });

  // --- The datacenter column --------------------------------------------------------------------------------
  await t('the datacenter column is the README’s table, word for word; regional chains show their parent’s site', () => {
    const readme = readFileSync('POC-README.md', 'utf8');
    const head = readme.indexOf(`| Retailer | Reads with | One request from a datacenter (${DATACENTER_DAY}) |`);
    assert.ok(head >= 0, 'the table is in the README');
    const straight = (s: string) => s.replace(/’/g, "'");
    const lines = readme.slice(head).split('\n');
    // The table's rows: after its header and rule, up to the first line that isn't one.
    const end = lines.findIndex((line) => !line.startsWith('|'));
    const rows = lines.slice(2, end).map((line) => line.split('|').map((cell) => cell.trim()));
    const table = Object.fromEntries(
      rows.map(([, name, , said]) => [BUNDLED_CONFIG.retailers.find((r) => straight(r.name) === straight(name))?.id ?? name, said]),
    );
    assert.deepEqual(Object.keys(table).sort(), Object.keys(DATACENTER).sort(), 'the same stores');
    for (const [id, said] of Object.entries(table)) assert.equal(straight(DATACENTER[id].said), straight(said), id);
    for (const [id, r] of Object.entries(DATACENTER)) {
      const want = /Bot check|Blocked/.test(r.said) ? 'blocked' : /^Loads/.test(r.said) ? 'loaded' : 'no_prices';
      assert.equal(r.outcome, want, id);
    }
    assert.deepEqual(datacenterFor('ralphs', 'kroger'), { said: 'Blocked (503)', outcome: 'blocked', parent: 'kroger' });
    assert.equal(datacenterFor('mine'), undefined);
    assert.equal(datacenterWords(info('ralphs')), 'Not tried; Kroger’s site: Blocked (503)');
    assert.equal(datacenterWords(info('target')), 'Page loads; prices arrive later');
    assert.equal(datacenterWords({ retailerId: 'mine', name: 'Mine' }), 'Not tried');
  });

  // --- Which stores, and how the plain request asks ---------------------------------------------------------
  await t('which stores: yours in your order, or every store in the rules and yours, regional chains only when compared', () => {
    const mine: RetailerConfig = { ...store('mine'), addedByUser: true };
    const off: RetailerConfig = { ...store('off'), enabled: false };
    const all = [...BUNDLED_CONFIG.retailers, mine, off];
    assert.deepEqual(versusIds(all, ['aldi', 'walmart', 'gone', 'off'], 'compared'), ['aldi', 'walmart'], 'unknown and switched-off stores are left out');
    const main = BUNDLED_CONFIG.retailers.filter((r) => !r.sisterOf).map((r) => r.id);
    assert.equal(main.length, 13);
    assert.deepEqual(versusIds(all, ['walmart'], 'all'), [...main, 'mine']);
    assert.deepEqual(versusIds(all, ['walmart', 'vons'], 'all'), [...main, 'vons', 'mine'], 'a compared chain is in, in the rules’ order');
  });

  await t('the plain request asks for the page as a browser does, with the phone browser’s user agent, under the store’s own headers', () => {
    const target = rules('target');
    assert.deepEqual(plainConfig(target, 'Mozilla/5.0 (iPhone)').headers, {
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9',
      'User-Agent': 'Mozilla/5.0 (iPhone)',
    });
    assert.equal(target.headers, undefined, 'the rules themselves are untouched');
    assert.equal(plainConfig(target, null).headers?.['User-Agent'], undefined, 'no user agent when the phone gave none');
    const walmart = plainConfig({ ...rules('walmart'), headers: { Accept: 'text/html', 'User-Agent': 'its own' } }, 'phone');
    assert.deepEqual([walmart.headers?.Accept, walmart.headers?.['User-Agent']], ['text/html', 'its own'], 'the store’s own headers win');
  });

  // --- Running it -------------------------------------------------------------------------------------------
  await t('the test: at each store its page, then the plain request, one at a time; four stores at once; a full hour leaves a store out', async () => {
    let now = 1_000_000;
    const test = new PhoneVsServer(() => now);
    const order: string[] = [];
    const busy = new Map<string, number>();
    let inFlight = 0;
    let peak = 0;
    const search: VersusDeps['search'] = async (cfg, query, storeId, only) => {
      order.push(`${cfg.id} ${only}`);
      assert.equal(busy.get(cfg.id) ?? 0, 0, 'one search at a time at each store');
      assert.deepEqual([query, storeId], ['milk', cfg.id === 'target' ? '1375' : '']);
      busy.set(cfg.id, 1);
      inFlight++;
      peak = Math.max(peak, inFlight);
      await tick(5);
      inFlight--;
      busy.set(cfg.id, 0);
      if (only === 'fetch') throw new SearchFailed([{ strategy: 'fetch', ok: false, reason: 'challenge', ms: 400, status: 403, bytes: 1500 }]);
      return { retailer: cfg.name, products: [{ retailer: cfg.id, storeId, id: '1', name: 'Milk', price: 3.5 }], strategy: 'webview', via: 'page', ms: 900, attempts: [{ strategy: 'webview', ok: true, ms: 800 }], bytes: 1_000_000 };
    };
    let prepared = 0;
    const deps: VersusDeps = {
      prepare: async () => {
        assert.equal(test.getSnapshot().running, true, 'under way before it prepares');
        prepared++;
      },
      search,
      roomAt: (id, n) => {
        assert.equal(n, 2, 'room for both searches');
        return id === 'meijer' ? now + 30 * 60_000 : now;
      },
      whenFree: async (cfg) => {
        order.push(`${cfg.id} free`);
      },
    };
    const ids = ['walmart', 'target', 'kroger', 'aldi', 'costco', 'meijer'];
    const stores = ids.map((id) => ({ config: rules(id), storeId: id === 'target' ? '1375' : '' }));
    const running = test.run(stores, deps, { scope: 'all' });
    assert.equal(test.getSnapshot().running, true);
    await test.run(stores, deps);
    assert.equal(prepared, 1, 'a second run while one is going is ignored');
    await running;
    now += 5000;
    const state = test.getSnapshot();
    assert.deepEqual([state.running, state.scope, state.query, state.doing], [false, 'all', 'milk', {}]);
    assert.equal(peak, 4, 'four stores at once');
    for (const id of ids.filter((i) => i !== 'meijer')) {
      const mine = order.filter((o) => o.startsWith(`${id} `));
      assert.deepEqual(mine, [`${id} free`, `${id} webview`, `${id} fetch`], id);
    }
    assert.ok(!order.some((o) => o.startsWith('meijer')), 'a store with no room this hour isn’t searched');
    assert.equal(state.rows.meijer.pausedUntil, 1_000_000 + 30 * 60_000);
    assert.deepEqual([state.rows.walmart.browser?.verdict, state.rows.walmart.browser?.ms, state.rows.walmart.plain?.verdict, state.rows.walmart.plain?.status], ['prices', 800, 'blocked', 403]);
    const s = versusSummary(state);
    assert.deepEqual([s.tried, s.plain.prices, s.browser.prices, s.plain.blocked, s.paused], [5, 0, 5, 5, 1]);
    assert.equal(summaryLine(s), 'From a plain request: 0 of 5 stores gave prices. From this phone’s browser: 5 of 5.');
  });

  await t('the last finished test is kept; one the app closed on halfway isn’t; clearing forgets it', async () => {
    const test = new PhoneVsServer(() => 5);
    const deps: VersusDeps = {
      search: async (cfg, _q, _s, only) => {
        if (only === 'fetch') throw new SearchFailed([{ strategy: 'fetch', ok: false, reason: 'http_403', ms: 10, status: 403 }]);
        return { retailer: cfg.name, products: [], strategy: 'webview', ms: 10, attempts: [{ strategy: 'webview', ok: true, ms: 10 }] };
      },
      roomAt: () => 0,
    };
    await test.run([{ config: rules('ralphs'), storeId: '', parentName: 'Kroger' }], deps);
    const saved = test.serialize();
    const again = new PhoneVsServer();
    again.hydrate(saved);
    assert.deepEqual(again.getSnapshot(), test.getSnapshot());
    assert.deepEqual(again.getSnapshot().stores, [{ retailerId: 'ralphs', name: 'Ralphs', sisterOf: 'kroger', parentName: 'Kroger' }]);
    const halfway = new PhoneVsServer();
    halfway.hydrate(JSON.stringify({ ...JSON.parse(saved), finishedAt: undefined }));
    assert.equal(halfway.getSnapshot().stores.length, 0);
    halfway.hydrate('not json');
    assert.equal(halfway.getSnapshot().stores.length, 0);
    again.clear();
    assert.equal(again.getSnapshot().stores.length, 0);
    // Erase everything mid-test: it stops, and what it finds afterwards is dropped.
    const erased = new PhoneVsServer(() => 5);
    const searched: string[] = [];
    const going = erased.run([{ config: rules('ralphs'), storeId: '', parentName: 'Kroger' }], {
      ...deps,
      search: async (cfg, q, s, only) => {
        searched.push(only);
        await new Promise((r) => setTimeout(r, 5));
        return deps.search(cfg, q, s, only);
      },
    });
    await new Promise((r) => setTimeout(r, 1));
    erased.clear();
    await going;
    assert.deepEqual([erased.getSnapshot().running, erased.getSnapshot().rows, searched], [false, {}, ['webview']], 'no plain request after the erase');
  });

  await t('shared as text: what was searched, the summary, what blocked what, the datacenter, the best case, then store by store', () => {
    const state: VersusState = {
      query: 'milk',
      scope: 'compared',
      running: false,
      finishedAt: 10,
      stores: ['walmart', 'ralphs', 'meijer'].map(info),
      rows: {
        walmart: {
          retailerId: 'walmart',
          at: 1,
          browser: side('prices', { ms: 6100, bytes: 2_100_000, how: 'page load', first: { name: 'Great Value Whole Milk, 1 gal', price: 3.64 } }),
          plain: side('blocked', { reason: 'challenge', status: 403, ms: 1200, bytes: 2400 }),
        },
        ralphs: { retailerId: 'ralphs', at: 1, browser: side('prices', { ms: 4000, how: 'reused its page' }), plain: side('no_prices', { reason: 'no_payload', ms: 900, bytes: 400_000 }) },
        meijer: { retailerId: 'meijer', at: 1, pausedUntil: 50 },
      },
      doing: {},
    };
    const text = versusText(state, 'Phone vs. server, on this iPhone, 9/27/2026', 'iPhone').split('\n');
    assert.deepEqual(text.slice(0, 9), [
      'Phone vs. server, on this iPhone, 9/27/2026',
      'Searching “milk” at each store two ways, from this iPhone.',
      '',
      'From a plain request: 0 of 2 stores gave prices. From this iPhone’s browser: 2 of 2.',
      'Blocked (a bot check, a refusal or an empty page): the plain request at 1 store, the browser at 0.',
      'From a datacenter, one request each (Sep 24, 2026): blocked at 1 of 1 store.',
      'Not tried: 1 store, with no room in its hour for both searches.',
      bestCaseText('iPhone'),
      '',
    ]);
    assert.deepEqual(text.slice(9), [
      'Walmart',
      `  This iPhone’s browser: 12 products (Great Value Whole Milk, 1 gal, $3.64) · 6.1 s · ${bytesText(2_100_000)} · page load`,
      `  Plain request: Bot check (403) · 1.2 s · ${bytesText(2400)}`,
      '  Datacenter (Sep 24, 2026): Bot check',
      '',
      'Ralphs',
      '  This iPhone’s browser: 12 products · 4.0 s · reused its page',
      `  Plain request: No prices in the page · 0.9 s · ${bytesText(400_000)}`,
      '  Datacenter (Sep 24, 2026): Not tried; Kroger’s site: Blocked (503)',
      '',
      'Meijer',
      '  Not tried: no room in its hour for both searches',
    ]);
  });

  // --- The plain request, as the app sends it ----------------------------------------------------------------
  await t('a plain request that fails says what it got: the HTTP status, the page’s size, and what gave a bot check away', async () => {
    const target = plainConfig(rules('target'), 'Mozilla/5.0 (iPhone)');
    const denied = '<html><head><title>Access Denied</title></head><body>Reference #18</body></html>';
    const calls = stubFetch(denied, 403);
    const blocked = await searchViaFetch(target, 'milk', '').catch((e) => e);
    assert.ok(blocked instanceof StrategyError);
    assert.deepEqual([blocked.reason, blocked.status, blocked.bytes], ['blocked', 403, denied.length], 'a block, not a bot check');
    assert.equal(blocked.detail, `HTTP 403, a page of ${denied.length} characters, with “Access Denied” in it.`);
    assert.equal(verdictWords(fromFailure(new SearchFailed([{ strategy: 'fetch', ok: false, reason: 'blocked', ms: 10, status: 403 }]), 10)), 'Blocked (403)');
    assert.deepEqual([calls[0].url, calls[0].opts.credentials, calls[0].opts.headers['User-Agent'], calls[0].opts.headers.Accept], [
      'https://www.target.com/s?searchTerm=milk',
      'omit',
      'Mozilla/5.0 (iPhone)',
      'text/html,application/xhtml+xml',
    ]);
    stubFetch(`<html><body>${'<div>app shell</div>'.repeat(200)}</body></html>`);
    const shell = await searchViaFetch(target, 'milk', '').catch((e) => e);
    assert.deepEqual([shell.reason, shell.status, shell.detail], ['no_payload', 200, 'HTTP 200, a page of 4 KB, and no product data in it.']);
    stubFetch('');
    const empty = await searchViaFetch(target, 'milk', '').catch((e) => e);
    assert.deepEqual([empty.reason, empty.bytes, verdictOf(empty.reason, empty.bytes)], ['tiny_page', 0, 'empty'], 'a nearly empty page is its own reason now');
    stubFetch('slow down', 429);
    const limited = await searchViaFetch(target, 'milk', '').catch((e) => e);
    assert.deepEqual([limited.reason, limited.status, limited.detail], ['http_429', 429, 'HTTP 429, a page of 9 characters.']);
    globalThis.fetch = realFetch;
  });

  await t('a plain request’s page is read for all the product data it carries: JSON script blocks, and the page state it sets', async () => {
    const ctx = { retailer: 'x', storeId: '' };
    const items = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `Whole Milk ${i}`, price: 3 + i }));
    const block = autoDetect({ html: `<html><script type="application/json" id="initial">${JSON.stringify({ search: { products: items(3) } })}</script></html>` }, ctx);
    assert.deepEqual([block.payloadFound, block.products.length, block.source], [true, 3, 'json script #initial (3)'], 'labeled with its id, as the browser labels it');
    // Some pages write their data URL-encoded, as Instacart's storefronts do.
    const encoded = autoDetect({ html: `<html><script id="node-state" type="application/json">${encodeURIComponent(JSON.stringify({ search: { products: items(4) } }))}</script></html>` }, ctx);
    assert.deepEqual([encoded.products.length, encoded.source], [4, 'json script #node-state (4)']);
    const state = autoDetect(
      {
        html: `<script>if (window.__PRELOADED_STATE__ == null) {}; var s = window.__PRELOADED_STATE__;</script><script>window.__PRELOADED_STATE__ = ${JSON.stringify({ results: items(2), note: 'a } in a string' })};</script>`,
      },
      ctx,
    );
    assert.deepEqual([state.products.length, state.source, state.origin?.kind], [2, '__PRELOADED_STATE__ (2)', 'other'], 'read and compared first, set later');
    const parsed = autoDetect({ html: `<script>window.__INITIAL_STATE__ = JSON.parse(${JSON.stringify(JSON.stringify({ items: items(4) }))});</script>` }, ctx);
    assert.deepEqual([parsed.products.length, parsed.source], [4, '__INITIAL_STATE__ (4)']);
    const notJson = autoDetect({ html: "<script>window.__APOLLO_STATE__ = {'a': 1};</script><script type=\"application/json\">not json</script>" }, ctx);
    assert.equal(notJson.payloadFound, false, 'what isn’t JSON is passed over');
    const next = autoDetect({ html: `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { products: items(2) } })}</script>` }, ctx);
    assert.equal(next.source, 'next-data (2)', 'Next.js’s page data is read as such');
    // End to end: a store whose page carries its results gives prices to a plain request.
    stubFetch(`<html><script type="application/json">${JSON.stringify({ products: items(5) })}</script></html>`);
    const got = await searchViaFetch(plainConfig(rules('costco'), 'UA'), 'milk', '');
    assert.equal(got.products.length, 5);
    globalThis.fetch = realFetch;
  });

  // --- End to end, through the app's own search -----------------------------------------------------------------
  const setUp = (tuner = new StoreTuner()) => {
    const pool = new WebViewPool();
    pool.challengeGraceMs = 0;
    const searcher = createRetailerSearch(pool, 'rules-9', tuner);
    const entries: AttemptEntry[] = [];
    searcher.onAttempt((e) => entries.push(e));
    const deps: VersusDeps = {
      search: (cfg, q, storeId, only) => searcher.search(only === 'fetch' ? plainConfig(cfg, 'Mozilla/5.0 (iPhone)') : cfg, q, storeId, only, { challenge: 'report', kind: 'versus' }),
      roomAt: (id, n) => politeness.roomAt(id, n),
    };
    return { pool, searcher, entries, deps, tuner };
  };

  await t('end to end: the store’s page and a plain request from the phone, counted in its hour, kept out of Store health’s rates', async () => {
    const { pool, entries, deps, tuner } = setUp();
    const cfg = store('ex1');
    fakePage(pool.lane('ex1', 'EX1'));
    const calls = stubFetch('<html><head><title>Robot or human?</title></head></html>', 403, 5);
    const test = new PhoneVsServer();
    await test.run([{ config: cfg, storeId: '' }], deps);
    globalThis.fetch = realFetch;
    const row = test.getSnapshot().rows.ex1;
    assert.deepEqual([row.browser?.verdict, row.browser?.products, row.browser?.how, row.browser?.bytes], ['prices', 4, 'page load', 2_000_000]);
    assert.deepEqual([row.plain?.verdict, verdictWords(row.plain!), row.plain?.status], ['blocked', 'Bot check (403)', 403]);
    assert.match(row.plain?.detail ?? '', /HTTP 403.*Robot or human/);
    assert.equal(calls[0].opts.headers['User-Agent'], 'Mozilla/5.0 (iPhone)');
    assert.equal(pool.getSnapshot().presented, null, 'no bot check covered the app');
    assert.deepEqual(entries.map((e) => [e.kind, e.strategy, e.ok, e.reason]), [
      ['versus', 'webview', true, undefined],
      ['versus', 'fetch', false, 'challenge'],
    ]);
    assert.equal(politeness.used('ex1'), 2, 'both count toward its hour');
    assert.equal(storeHealth(entries, 'ex1', Date.now()).attempts, 0, 'Store health’s rates leave the test out');
    const [asked] = citizenReport(entries, 0);
    assert.deepEqual([asked.searches, asked.pageLoads], [2, 2], 'what the phone asked: two page loads');
    assert.equal(tuner.get('ex1', tuningBase(cfg)).level, 'careful', 'a bot check from its site makes the phone gentle there');
    const after = new Politeness(120, () => Date.now());
    after.seed(entries);
    assert.equal(after.used('ex1'), 2, 'and still count after the app reopens');
  });

  await t('a way a store isn’t searched with doesn’t steer its tuning, unless its site pushed back', async () => {
    // Plain requests at a store read only through its page: pages without product data don't make it "failing".
    const quiet = setUp();
    const onlyPage = store('ex2');
    stubFetch(`<html>${'x'.repeat(5000)}</html>`);
    for (let i = 0; i < 3; i++) await quiet.searcher.search(onlyPage, 'milk', '', 'fetch', { kind: 'versus' }).catch(() => {});
    assert.equal(quiet.tuner.get('ex2', tuningBase(onlyPage)).level, 'normal');
    // A store searched with plain requests first: the same failures count.
    const plainFirst = store('ex3', { strategies: ['fetch', 'webview'] });
    for (let i = 0; i < 2; i++) await quiet.searcher.search(plainFirst, 'milk', '', 'fetch', { kind: 'versus' }).catch(() => {});
    assert.equal(quiet.tuner.get('ex3', tuningBase(plainFirst)).level, 'narrow');
    globalThis.fetch = realFetch;
    // Kroger with its API keys: a bot check on its website is another door, and its API searches go on as before.
    const api = setUp();
    const apiOnly = store('ex4', { strategies: ['api'], api: 'kroger' });
    fakePage(api.pool.lane('ex4', 'EX4'), () => 'challenge');
    const err = await api.searcher.search(apiOnly, 'milk', '', 'webview', { challenge: 'report', kind: 'versus' }).catch((e) => e);
    assert.equal(err.attempts[0].reason, 'challenge');
    assert.equal(api.tuner.get('ex4', tuningBase(apiOnly)).level, 'normal');
    // The same bot check at a store read through its website does count.
    const site = setUp();
    const pageStore = store('ex5');
    fakePage(site.pool.lane('ex5', 'EX5'), () => 'challenge');
    await site.searcher.search(pageStore, 'milk', '', 'webview', { challenge: 'report', kind: 'versus' }).catch(() => {});
    assert.equal(site.tuner.get('ex5', tuningBase(pageStore)).level, 'careful');
  });

  await t('the hour: a store without room for both searches isn’t tried, and says when there’s room again', async () => {
    const { deps } = setUp();
    const cfg = store('ex6');
    // 119 of its 120 this hour already.
    for (let i = 0; i < 119; i++) politeness.take('ex6');
    let searched = 0;
    const test = new PhoneVsServer();
    const counted: VersusDeps['search'] = (...args) => {
      searched++;
      return deps.search(...args);
    };
    await test.run([{ config: cfg, storeId: '' }], { ...deps, search: counted });
    const row = test.getSnapshot().rows.ex6;
    assert.equal(searched, 0);
    assert.ok(row.pausedUntil! > Date.now() + 59 * 60_000, 'room again in about an hour');
    assert.equal(versusSummary(test.getSnapshot()).paused, 1);
  });

  log(`\n${passed} phone vs. server tests passed`);
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
