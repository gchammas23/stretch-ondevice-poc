/// <reference types="node" />
import assert from 'node:assert/strict';
import { AttemptLog, bytesToday, storeHealth, type AttemptEntry } from '../src/onDevice/attemptLog';
import { CoverageCheck, coverageStatus, coverageText } from '../src/onDevice/coverage';
import { citizenReport, Politeness } from '../src/onDevice/politeness';
import { DEFAULT_INPUTS, ESTIMATED, measuredFrom, monthlyCost } from '../src/pricing/costModel';
import { SearchFailed } from '../src/onDevice/retailerSearch';
import { BUNDLED_CONFIG, fetchRules, rulesProblem } from '../src/onDevice/retailers';
import { bytesText } from '../src/onDevice/scrapeFeed';
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
      { ...e(0, true), retailerId: 'walmart' },
    ];
    const h = storeHealth(entries, 'target', now);
    assert.deepEqual([h.attempts, h.ok, h.medianMs, h.botChecks, h.bytes], [4, 3, 600, 1, 150_000], 'the week, without store setting');
    assert.equal(h.rate, 0.75);
    assert.deepEqual(h.days.map((d) => [d.daysAgo, d.ok, d.total]), [[6, 0, 0], [5, 0, 0], [4, 0, 0], [3, 1, 2], [2, 0, 0], [1, 1, 1], [0, 1, 1]]);
    assert.deepEqual(h.lastFailure, { reason: 'challenge', at: now - 3 * DAY - 1000 });
    assert.deepEqual(h.sinceRules, { version: 'v2', ok: 2, total: 2 }, 'how it has gone since the rules changed');
    assert.equal(bytesToday(entries, now), 150_000);
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
      return { retailer: c.name, products: [{ retailer: c.id, storeId: '', id: '1', name: 'Milk', price: 3 }], strategy: 'webview', via: 'page', ms: 1500, attempts: [], bytes: 1_200_000 };
    };
    const check = new CoverageCheck();
    const stores = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => ({ config: cfg(id), storeId: '' }));
    const run = check.run(stores, search, 'milk', 2);
    assert.deepEqual([check.getSnapshot().running, check.getSnapshot().stores.length], [true, 6]);
    await run;
    const s = check.getSnapshot();
    assert.equal(peak, 2);
    assert.deepEqual(stores.map(({ config }) => s.rows[config.id].status), ['works', 'bot_check', 'no_products', 'no_products', 'works', 'works']);
    assert.deepEqual([s.rows.a.products, s.rows.a.how, s.rows.a.bytes], [1, 'page load', 1_200_000]);
    assert.equal(s.rows.c.detail, 'C showed “C”, but no product data arrived.');
    assert.match(coverageText(s, 'Test'), /3 of 6 stores readable[\s\S]*✗ B: Bot check or blocked \(challenge\)/);
    const again = new CoverageCheck();
    again.hydrate(check.serialize());
    assert.deepEqual([again.getSnapshot().running, again.rowFor('a')?.status], [false, 'works']);
    assert.deepEqual([coverageStatus('http_403'), coverageStatus('timeout'), coverageStatus('network')], ['bot_check', 'slow', 'failed']);
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
