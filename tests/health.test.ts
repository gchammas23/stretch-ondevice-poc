/// <reference types="node" />
import assert from 'node:assert/strict';
import { AttemptLog, bytesToday, storeHealth, type AttemptEntry } from '../src/onDevice/attemptLog';
import { CoverageCheck, coverageCounts, coverageStatus, coverageText } from '../src/onDevice/coverage';
import { citizenReport, Politeness } from '../src/onDevice/politeness';
import { DEFAULT_INPUTS, ESTIMATED, measuredFrom, monthlyCost } from '../src/pricing/costModel';
import { SearchFailed } from '../src/onDevice/retailerSearch';
import { BUNDLED_CONFIG, fetchRules, rulesProblem } from '../src/onDevice/retailers';
import { bytesText, reasonWords } from '../src/onDevice/scrapeFeed';
import type { RetailerConfig, SearchOutcome } from '../src/onDevice/types';

const DAY = 24 * 60 * 60_000;
let passed = 0;
const t = async (name: string, fn: () => unknown) => { await fn(); passed++; console.log('ok -', name); };
const cfg = (id: string): RetailerConfig => ({ ...BUNDLED_CONFIG.retailers.find((r) => r.id === 'target')!, id, name: id.toUpperCase() });

(async () => {
  await t('store health: success rate, speed, bot checks and data per store, day by day, over the last week', () => {
    const now = 100 * DAY;
    const e = (daysAgo: number, ok: boolean, extra: Partial<AttemptEntry> = {}): AttemptEntry => ({
      at: now - daysAgo * DAY - 1000, retailerId: 'target', kind: 'search', strategy: 'webview', ok, ms: 800, bytes: 50_000, rules: 'v1', ...extra,
    });
    const entries = [
      e(9, false),
      e(3, true, { ms: 400 }),
      e(3, false, { reason: 'challenge', bytes: undefined }),
      e(1, true, { ms: 1200, rules: 'v2' }),
      e(0, true, { ms: 600, rules: 'v2' }),
      e(0, true, { kind: 'store' }),
      e(0, false, { kind: 'coverage', reason: 'no_payload', ms: 9000, bytes: 6_000_000 }),
      { ...e(0, true), retailerId: 'walmart' },
    ];
    const h = storeHealth(entries, 'target', now);
    assert.deepEqual([h.attempts, h.ok, h.medianMs, h.botChecks, h.bytes], [4, 3, 600, 1, 150_000], 'the week, without store setting or the store check');
    assert.equal(h.rate, 0.75);
    assert.deepEqual(h.days.map((d) => [d.daysAgo, d.ok, d.total]), [[6, 0, 0], [5, 0, 0], [4, 0, 0], [3, 1, 2], [2, 0, 0], [1, 1, 1], [0, 1, 1]]);
    assert.deepEqual(h.lastFailure, { reason: 'challenge', at: now - 3 * DAY - 1000 });
    assert.deepEqual(h.sinceRules, { version: 'v2', ok: 2, total: 2 }, 'how it has gone since the rules changed');
    assert.equal(bytesToday(entries, now), 6_150_000, 'the day’s data is all of it, the store check’s too');
    assert.equal(storeHealth(entries, 'aldi', now).rate, undefined);
  });

  await t('attempt log: keeps two weeks, saves and loads', () => {
    let now = 30 * DAY;
    const log = new AttemptLog(() => now);
    log.add({ at: now - 20 * DAY, retailerId: 'a', kind: 'search', ok: true, ms: 1 });
    log.add({ at: now, retailerId: 'a', kind: 'search', ok: false, reason: 'timeout', ms: 1 });
    assert.equal(log.entries().length, 1, 'older than two weeks is dropped');
    const again = new AttemptLog(() => now);
    again.hydrate(log.serialize());
    assert.equal(again.entries()[0].reason, 'timeout');
    now += 15 * DAY;
    again.hydrate(log.serialize());
    assert.equal(again.entries().length, 0);
  });

  await t('coverage: every store once, a few at a time; each outcome in words; the last run is kept', async () => {
    let inFlight = 0;
    let peak = 0;
    const search = async (c: RetailerConfig): Promise<SearchOutcome> => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      if (c.id === 'b') throw new SearchFailed([{ strategy: 'webview', ok: false, reason: 'challenge', ms: 1 }]);
      if (c.id === 'c') throw new SearchFailed([{ strategy: 'webview', ok: false, reason: 'no_payload', detail: 'C showed “C”, but no product data arrived.', ms: 1 }]);
      if (c.id === 'd') return { retailer: 'D', products: [{ retailer: 'd', storeId: '', id: '1', name: 'Milk', price: null }], strategy: 'webview', ms: 3, attempts: [] };
      if (c.id === 'h') throw new SearchFailed([{ strategy: 'api', ok: false, reason: 'kroger_no_store_near_zip', ms: 1 }]);
      if (c.id === 'i') throw new SearchFailed([{ strategy: 'api', ok: false, reason: 'kroger_products_http_503', ms: 1 }]);
      // G gives 2 products; the rest a dozen.
      const products = Array.from({ length: c.id === 'g' ? 2 : 12 }, (_, i) => ({ retailer: c.id, storeId: '', id: String(i), name: `Milk ${i}`, price: 3 }));
      return { retailer: c.name, products, strategy: 'webview', via: 'page', ms: 1500, attempts: [], bytes: 1_200_000 };
    };
    const check = new CoverageCheck();
    const stores = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'].map((id) => ({ config: cfg(id), storeId: '' }));
    const run = check.run(stores, search, 'milk', 2);
    assert.deepEqual([check.getSnapshot().running, check.getSnapshot().stores.length], [true, 9]);
    await run;
    const s = check.getSnapshot();
    assert.equal(peak, 2);
    assert.deepEqual(
      stores.map(({ config }) => s.rows[config.id].status),
      ['works', 'bot_check', 'no_products', 'no_products', 'works', 'works', 'few', 'no_store', 'failed'],
      '2 products are too few to be the results; no store near the ZIP code isn’t a failure',
    );
    assert.deepEqual([s.rows.a.products, s.rows.a.how, s.rows.a.bytes], [12, 'page load', 1_200_000]);
    assert.equal(s.rows.c.detail, 'C showed “C”, but no product data arrived.');
    assert.deepEqual(coverageCounts(Object.values(s.rows)), { works: 3, searched: 8, noStore: 1 });
    // Shared as text: every store's line carries what Store health says under it.
    assert.deepEqual(coverageText(s, 'Test').split('\n'), [
      'Test',
      '3 of 8 stores readable, searching “milk”; 1 with no store near the ZIP code, not searched',
      '',
      '✓ A: 12 products in 1.5 s (page load)',
      '✗ B: Bot check or blocked (challenge): bot check',
      '✗ C: No products came back (no_payload): C showed “C”, but no product data arrived.',
      '✗ D: No products came back: its search gave no products with prices',
      '✓ E: 12 products in 1.5 s (page load)',
      '✓ F: 12 products in 1.5 s (page load)',
      '? G: Too few products: 2 products in 1.5 s (page load), which may not be the search’s results',
      '– H: No store near you (kroger_no_store_near_zip): no store of this chain near the ZIP code, by Kroger’s API',
      '✗ I: Failed (kroger_products_http_503): Kroger’s API was busy (503), twice',
    ]);
    const again = new CoverageCheck();
    again.hydrate(check.serialize());
    assert.deepEqual([again.getSnapshot().running, again.rowFor('a')?.status], [false, 'works']);
    assert.deepEqual([coverageStatus('http_403'), coverageStatus('timeout'), coverageStatus('network')], ['bot_check', 'slow', 'failed']);
    assert.deepEqual([coverageStatus('kroger_no_store_near_zip'), coverageStatus('kroger_products_http_503')], ['no_store', 'failed']);
    assert.deepEqual(
      ['kroger_auth_http_401', 'kroger_locations_timeout', 'kroger_products_network'].map(reasonWords),
      ['Kroger’s API answered 401', 'Kroger’s API was too slow', 'Kroger’s API couldn’t be reached'],
    );
  });

  await t('store rules from a file: problems said in words; a good file is taken', async () => {
    assert.equal(rulesProblem([]), 'It isn’t a JSON object.');
    assert.equal(rulesProblem({ retailers: [] }), 'It has no "version".');
    assert.equal(rulesProblem({ version: 'v', retailers: [] }), 'It has no "retailers".');
    assert.match(rulesProblem({ version: 'v', retailers: [BUNDLED_CONFIG.retailers[0], { id: 'broken' }] })!, /Store 2 \(broken\)/);
    assert.equal(rulesProblem({ version: 'v2', retailers: BUNDLED_CONFIG.retailers }), null);

    const realFetch = globalThis.fetch;
    const answers: Record<string, { status: number; body: string }> = {
      'https://gist.example.com/good.json': { status: 200, body: JSON.stringify({ version: 'fixed-1', retailers: BUNDLED_CONFIG.retailers }) },
      'https://gist.example.com/html': { status: 200, body: '<html>' },
      'https://gist.example.com/gone': { status: 404, body: '' },
    };
    globalThis.fetch = (async (url: string) => {
      const a = answers[url];
      return { ok: a.status < 400, status: a.status, text: async () => a.body };
    }) as unknown as typeof fetch;
    const good = await fetchRules('https://gist.example.com/good.json');
    assert.equal('bundle' in good && good.bundle.version, 'fixed-1');
    assert.deepEqual(await fetchRules('https://gist.example.com/html'), { error: 'The link didn’t return JSON.' });
    assert.deepEqual(await fetchRules('https://gist.example.com/gone'), { error: 'The link answered with HTTP 404.' });
    assert.deepEqual(await fetchRules('http://insecure.example.com/x'), { error: 'The link must start with https://' });
    globalThis.fetch = realFetch;
  });

  await t('data sizes in words', () => {
    assert.deepEqual([bytesText(400), bytesText(41_234), bytesText(2_430_000), bytesText(48_000_000)], ['under 1\u00a0KB', '41\u00a0KB', '2.4\u00a0MB', '48\u00a0MB']);
    assert.deepEqual([bytesText(999_400_000), bytesText(1_146_000_000), bytesText(12_300_000_000)], ['999\u00a0MB', '1.1\u00a0GB', '12\u00a0GB'], 'a gigabyte and up in GB');
  });

  await t('good citizen: at most so many searches an hour at one store, counting ones from before the app last closed', () => {
    let now = 10 * DAY;
    const limit = new Politeness(3, () => now);
    limit.seed([
      { at: now - 30 * 60_000, retailerId: 'target', kind: 'search' },
      { at: now - 2 * 60 * 60_000, retailerId: 'target', kind: 'search' },
      { at: now - 60_000, retailerId: 'target', kind: 'store' },
    ]);
    assert.equal(limit.used('target'), 1, 'only searches in the last hour');
    assert.deepEqual([limit.take('target'), limit.take('target'), limit.take('target'), limit.take('walmart')], [true, true, false, true]);
    now += 31 * 60_000;
    assert.equal(limit.take('target'), true, 'the oldest left the hour');
  });

  await t('good citizen: what the phone asked of each store today, and its busiest hour', () => {
    const now = 20 * DAY;
    const e = (minsAgo: number, extra: Partial<AttemptEntry> = {}): AttemptEntry => ({ at: now - minsAgo * 60_000, retailerId: 'target', kind: 'search', strategy: 'webview', ok: true, ms: 500, ...extra });
    const report = citizenReport(
      [
        e(300, { via: 'page', bytes: 400_000 }),
        e(290, { via: 'replay', bytes: 20_000, bytesSaved: 15_000 }),
        e(280, { via: 'replay', bytes: 20_000, bytesSaved: 15_000 }),
        e(100, { via: 'replay', bytes: 20_000 }),
        e(90, { kind: 'product', bytes: 300_000 }),
        e(80, { retailerId: 'kroger', strategy: 'api' }),
        e(2000, { via: 'page' }),
      ],
      now - 12 * 60 * 60_000,
    );
    assert.deepEqual(report, [
      { retailerId: 'target', searches: 4, pageLoads: 1, reused: 3, api: 0, otherPages: 1, bytes: 760_000, bytesSaved: 30_000, busiestHour: 3 },
      { retailerId: 'kroger', searches: 1, pageLoads: 0, reused: 0, api: 1, otherPages: 0, bytes: 0, bytesSaved: 0, busiestHour: 1 },
    ]);
  });

  await t('cost: the same searches from servers, from the phone’s own measurements and assumptions anyone can change', () => {
    const e = (bytes: number, ms: number): AttemptEntry => ({ at: 1, retailerId: 'target', kind: 'search', strategy: 'webview', ok: true, ms, bytes });
    assert.deepEqual(measuredFrom([e(100_000, 1000)]), ESTIMATED, 'too few searches: the starting estimates');
    const measured = measuredFrom([e(100_000, 1000), e(200_000, 3000), e(300_000, 2000), { ...e(9, 9), ok: false }]);
    assert.deepEqual(measured, { bytesPerSearch: 200_000, msPerSearch: 2000, searches: 3 });
    const month = monthlyCost({ ...DEFAULT_INPUTS, users: 1000, listsPerWeek: 3, itemsPerList: 10, stores: 4 }, measured);
    // 3 lists × 52/12 weeks × 10 items × 4 stores = 520 searches per user a month.
    assert.equal(month.searchesPerMonth, 520_000);
    assert.deepEqual([month.proxy, month.solving, month.browsers, month.total], [416, 312, 28.89, 756.89], '104 GB at $4; 156k checks at $2 per 1,000; 289 browser-hours at 10¢');
    assert.equal(month.perUser, 0.7569);
    assert.equal(month.phoneBytesPerUserMonth, 104_000_000, 'what each phone uses instead');
    assert.equal(monthlyCost({ ...DEFAULT_INPUTS, users: Number.NaN }, measured).total, 0, 'a half-typed number counts as nothing');
  });

  console.log(`\n${passed} store health tests passed`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
