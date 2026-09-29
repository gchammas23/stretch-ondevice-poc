/// <reference types="node" />
import assert from 'node:assert/strict';
import type { FetchLike } from '../src/cloud/browserUse';
import {
  checkComparison,
  compareProblemWords,
  comparisonEstimate,
  comparisonJobs,
  comparisonNotice,
  comparisonOf,
  comparisons,
  comparisonStatus,
  comparisonSummary,
  comparisonText,
  dataWords,
  durationWords,
  itemKey,
  matchTerm,
  pricesWords,
  sideFigures,
  sideFigureWords,
  sideStatusWords,
  sideSummaryWords,
  type CompareRequest,
  type Comparison,
} from '../src/cloud/compare';
import {
  applyToJob,
  checkRequest,
  newJob,
  type CloudItem,
  type CloudJob,
  type CompareSide,
  type JobRequest,
  type RetailerRun,
  type TermResult,
} from '../src/cloud/jobs';
import { DeviceSearchError } from '../src/cloud/runner';
import { parseWalmartSearch } from '../src/cloud/walmart';
import { reasonWords } from '../src/cloud/words';
import { fakeBrowserUse, FakePage, makeRunner, memory, tick, walmartFor, walmartJob } from './cloudKit';

// Phone vs. cloud: comparisons made of cloud jobs, their guardrails and estimate, the same products matched by item
// number, each side's figures, what's said and shared, and the runner running one end to end against a simulated
// Browser Use API, a simulated Walmart page and a simulated phone search. No live site, no credit.

let passed = 0;
let finished = false;
const t = async (name: string, fn: () => unknown) => {
  await fn();
  passed++;
  console.log('ok -', name);
};
// A test left waiting on a promise that never settles lets Node exit quietly, as if all was well: that's a failure.
process.on('exit', () => {
  if (!finished) {
    console.error(`Stopped after ${passed} tests: one was left waiting.`);
    process.exitCode = 1;
  }
});

const req = (extra: Partial<CompareRequest> = {}): CompareRequest => ({
  terms: ['milk'],
  retailers: [
    { retailerId: 'walmart', storeId: '5260' },
    { retailerId: 'target', storeId: '1375' },
  ],
  agent: false,
  ...extra,
});

// The real Walmart search page, for store 5260, as the cloud browser reads it: 14 products.
const cloudItems: CloudItem[] = parseWalmartSearch(walmartFor('5260'), '5260').items;
// The same search as the phone read it: one product at another price, one it didn't list, and one only it listed.
const phoneItems = (): CloudItem[] => [
  ...cloudItems.filter((i) => i.itemId !== '15556052').map((i) => (i.itemId === '10450114' ? { ...i, price: 3.12 } : i)),
  { itemId: '999999991', name: 'Phone-only milk', price: 2 },
];

const term = (name: string, extra: Partial<TermResult> = {}): TermResult => ({ term: name, status: 'done', items: [], at: 1, ...extra });

/** A side's job for a comparison, every store queued. */
function sideJob(id: string, side: CompareSide, at: number, request = req({ agent: true })): CloudJob {
  return { ...newJob(comparisonJobs(request).find((s) => s.side === side)!.request, `${id}-${side}`, at), compare: { id, side } };
}

type End = 'done' | 'blocked' | 'failed';

/** Every store of a job run to an end (the same for all, or each its own), with these results. */
function finish(job: CloudJob, results: Partial<Record<string, TermResult[]>> = {}, end: End | Partial<Record<string, End>> = 'done'): CloudJob {
  let j = job;
  for (const r of job.retailers) {
    const status = typeof end === 'string' ? end : (end[r.retailerId] ?? 'done');
    j = applyToJob(j, r.retailerId, { type: 'start', at: 1 });
    // A cloud browser sets its store first, as the flows do.
    if (r.via === 'browser' && status === 'done') j = applyToJob(j, r.retailerId, { type: 'storeSet', how: 'button' });
    for (const result of results[r.retailerId] ?? []) j = applyToJob(j, r.retailerId, { type: 'term', result });
    j = applyToJob(j, r.retailerId, { type: 'finish', status, ...(status === 'blocked' ? { reason: 'challenge' } : {}), at: 2 });
  }
  return j;
}

(async () => {
  // --- Comparisons and their guardrails -----------------------------------------------------------------------

  await t('comparison jobs: this phone, the cloud browser, and the agent when asked; grouped back by their id, newest first', () => {
    assert.deepEqual(
      comparisonJobs(req()).map((s) => [s.side, s.request.engine, s.request.retailers.map((r) => `${r.retailerId}:${r.storeId}:${r.via}`).join(' ')]),
      [
        ['phone', 'scripted', 'walmart:5260:device target:1375:device'],
        ['scripted', 'scripted', 'walmart:5260:browser target:1375:browser'],
      ],
    );
    assert.deepEqual(
      comparisonJobs(req({ agent: true })).map((s) => s.side),
      ['phone', 'scripted', 'agent'],
    );
    const jobs = [sideJob('c2', 'phone', 20), sideJob('c2', 'scripted', 20), newJob(walmartJob(), 'plain', 15), sideJob('c1', 'phone', 10), sideJob('c1', 'scripted', 10), sideJob('c1', 'agent', 10)];
    const all = comparisons(jobs);
    assert.deepEqual(
      all.map((c) => [c.id, Object.keys(c.sides).sort().join()]),
      [
        ['c2', 'phone,scripted'],
        ['c1', 'agent,phone,scripted'],
      ],
    );
    const c1 = comparisonOf(jobs, 'c1')!;
    assert.deepEqual([c1.terms, c1.retailers, c1.sides.agent?.id], [['milk'], req().retailers, 'c1-agent']);
    assert.equal(comparisonOf(jobs, 'plain'), undefined, 'a job of its own is no comparison');
  });

  await t('status: running while any side runs; else cancelled if stopped; else interrupted if cut off; else done', () => {
    const phone = sideJob('c', 'phone', 1, req());
    const cloud = sideJob('c', 'scripted', 1, req());
    const status = (jobs: CloudJob[]) => comparisonStatus(comparisonOf(jobs, 'c')!);
    assert.equal(status([phone, cloud]), 'running');
    assert.equal(status([finish(phone), cloud]), 'running');
    assert.equal(status([finish(phone), finish(cloud)]), 'done');
    const cut = applyToJob(applyToJob(applyToJob(cloud, 'walmart', { type: 'start', at: 1 }), 'walmart', { type: 'interrupt', reason: 'app_slept', at: 2 }), 'target', { type: 'cancel', at: 3 });
    assert.equal(status([finish(phone), applyToJob(cloud, 'walmart', { type: 'cancel', at: 2 })]), 'running', 'Target still queued');
    assert.equal(status([finish(phone), cut]), 'cancelled');
    const slept = finish(applyToJob(applyToJob(cloud, 'walmart', { type: 'start', at: 1 }), 'walmart', { type: 'interrupt', reason: 'app_slept', at: 2 }));
    assert.equal(status([finish(phone), slept]), 'interrupted');
  });

  await t('guardrails: each side’s as a job’s, one comparison at a time, and its cloud sides with the cloud jobs running at most 2', () => {
    const ctx = { jobs: [] as CloudJob[], hasKey: true, balanceUsd: 12.5 };
    assert.deepEqual(checkComparison(req(), ctx), { ok: true });
    assert.deepEqual(checkComparison(req({ terms: [] }), ctx), { ok: false, problem: 'no_terms' });
    assert.deepEqual(checkComparison(req({ terms: ['a', 'b', 'c', 'd', 'e', 'f'] }), ctx), { ok: false, problem: 'too_many_terms', count: 6 });
    assert.deepEqual(checkComparison(req({ retailers: [] }), ctx), { ok: false, problem: 'no_retailers' });
    assert.deepEqual(checkComparison(req({ retailers: [{ retailerId: 'target', storeId: ' ' }] }), ctx), { ok: false, problem: 'no_store', retailerId: 'target' });
    assert.deepEqual(checkComparison(req(), { ...ctx, hasKey: false }), { ok: false, problem: 'no_key' });
    assert.deepEqual(checkComparison(req(), { ...ctx, balanceUsd: 0.5 }), { ok: false, problem: 'low_balance', balanceUsd: 0.5 });
    assert.deepEqual(checkComparison(req(), { ...ctx, balanceUsd: undefined, balanceError: 'HTTP 503' }), { ok: false, problem: 'balance_unknown', detail: 'HTTP 503' });
    // One at a time: its phone side is this phone's own searching.
    assert.deepEqual(checkComparison(req(), { ...ctx, jobs: [sideJob('c', 'phone', 1, req()), sideJob('c', 'scripted', 1, req())] }), { ok: false, problem: 'comparison_running' });
    // The cloud jobs running and its own cloud sides, together.
    const oneRunning = [newJob(walmartJob(), 'a', 0)];
    assert.deepEqual(checkComparison(req(), { ...ctx, jobs: oneRunning }), { ok: true });
    const refused = checkComparison(req({ agent: true }), { ...ctx, jobs: oneRunning });
    assert.deepEqual(refused, { ok: false, problem: 'too_many_for_comparison', running: 1, sides: 2 });
    if (!refused.ok) assert.match(compareProblemWords(refused), /runs 2 cloud searches at once, and 1 is running already.*leave the agent out/);
    assert.deepEqual(checkComparison(req(), { ...ctx, jobs: [...oneRunning, newJob(walmartJob(), 'b', 0)] }), { ok: false, problem: 'too_many_for_comparison', running: 2, sides: 1 });
    // This phone's own searches cost nothing: they don't count, and aren't limited.
    const phoneOnly: JobRequest = { engine: 'scripted', terms: ['milk'], retailers: [{ retailerId: 'kroger', storeId: '45202', via: 'device' }] };
    assert.deepEqual(checkComparison(req(), { ...ctx, jobs: [newJob(phoneOnly, 'k1', 0), newJob(phoneOnly, 'k2', 0)] }), { ok: true });
    assert.deepEqual(checkRequest(phoneOnly, { jobs: [newJob(walmartJob(), 'a', 0), newJob(walmartJob(), 'b', 0)], hasKey: true }), { ok: true });
  });

  await t('estimate: the cloud browser a few cents (2.6 MB pages through a $5/GB proxy), the agent at most its cap a store; the phone free', () => {
    const scripted = comparisonEstimate(req());
    // Walmart: home, store page and a search at 2.6 MB each; Target: a page, then a small answer.
    assert.deepEqual([Math.round(scripted.usd * 1000) / 1000, scripted.capped], [0.056, false]);
    const agent = comparisonEstimate(req({ agent: true }));
    assert.deepEqual([Math.round(agent.usd * 1000) / 1000, agent.capped], [1.556, true]);
  });

  // --- How the sides compare ----------------------------------------------------------------------------------

  const run = (via: RetailerRun['via'], results: TermResult[], extra: Partial<RetailerRun> = {}): RetailerRun => ({
    ...newJob({ engine: 'scripted', terms: ['milk', 'eggs'], retailers: [{ retailerId: 'walmart', storeId: '5260', via }] }, 'j', 0).retailers[0],
    status: 'done',
    results,
    ...extra,
  });

  await t('matching: the same products by item number, their two prices, and what only one side listed', () => {
    const m = matchTerm('milk', run('device', [term('milk', { items: phoneItems() })]), run('browser', [term('milk', { items: cloudItems })]));
    assert.deepEqual([m.both, m.same, m.differ.length, m.onlyPhone, m.onlyCloud], [13, 12, 1, 1, 1]);
    assert.deepEqual([m.differ[0].itemId, m.differ[0].name, m.differ[0].phone, m.differ[0].cloud], ['10450114', 'Great Value Whole Vitamin D Milk, Gallon', 3.12, 3.32]);
    // However a side wrote the number (the agent: in a link, with words), and whatever case its term came back in.
    assert.deepEqual(['10450114', 'ID 10450114', 'https://www.walmart.com/ip/Great-Value-Milk/10450114?from=x', '00123456', 'A1b '].map(itemKey), ['10450114', '10450114', '10450114', '123456', 'a1b']);
    const agent = run('agent', [term('Milk', { items: [{ itemId: 'https://www.walmart.com/ip/x/10450114', name: 'GV Whole Milk 1 gal', price: 3.12 }] })]);
    assert.deepEqual(
      (({ both, same }) => [both, same])(matchTerm('milk', run('device', [term('milk', { items: phoneItems() })]), agent)),
      [1, 1],
    );
    // A search that didn't come back matches nothing; a product neither side priced is the same (no price).
    const failed = matchTerm('milk', run('device', [term('milk', { items: phoneItems() })]), run('browser', [term('milk', { status: 'failed', reason: 'no_page_data' })]));
    assert.deepEqual([failed.both, failed.cloud?.status, failed.onlyPhone], [0, 'failed', 14]);
    const unpriced = matchTerm('milk', run('device', [term('milk', { items: [{ itemId: '1', name: 'A', price: null }, { itemId: '2', name: 'B', price: 2 }] })]), run('browser', [term('milk', { items: [{ itemId: '1', name: 'A', price: null }, { itemId: '2', name: 'B', price: null }] })]));
    assert.deepEqual([unpriced.both, unpriced.same, unpriced.differ.map((g) => [g.phone, g.cloud])], [2, 1, [[2, null]]]);
  });

  const phoneRun = run('device', [term('milk', { ms: 9000, bytes: 1_500_000, at: 10_000, found: 40, storeMatches: true, pageStoreId: '5260' }), term('eggs', { ms: 11_000, bytes: 1_700_000, at: 21_000, found: 40, storeMatches: true, pageStoreId: '5260' })], { startedAt: 1000, finishedAt: 21_000 });
  const cloudRun = run(
    'browser',
    [term('milk', { ms: 9000, bytes: 2_600_000, at: 32_000, found: 40, storeMatches: true, pageStoreId: '5260' }), term('eggs', { ms: 14_000, bytes: 2_600_000, at: 46_000, found: 40, storeMatches: true, pageStoreId: '5260' })],
    { startedAt: 1000, finishedAt: 46_000, storeSet: 'button', wireBytes: 250_000, bytes: 7_800_000, browsers: { b1: { stopped: true, proxyMb: 7.8, proxyUsd: 0.039, browserUsd: 0.0007 } } },
  );

  await t('figures: time in all, to set up and a search’s; data on this phone and in the cloud; cost; the store confirmed or not', () => {
    const phone = sideFigures('phone', phoneRun);
    assert.deepEqual(
      [phone.totalMs, phone.setupMs, phone.searchMs, phone.phoneBytes, phone.cloudMb, phone.usd, phone.confirmed, phone.products, phone.searched],
      [20_000, undefined, 10_000, 3_200_000, undefined, 0, true, 80, 2],
    );
    const cloud = sideFigures('scripted', cloudRun);
    assert.deepEqual([cloud.totalMs, cloud.setupMs, cloud.searchMs, cloud.phoneBytes, cloud.cloudMb, cloud.usd, cloud.confirmed], [45_000, 22_000, 11_500, 250_000, 7.8, 0.0397, true]);
    assert.equal(sideFigureWords(cloud), '2 searches, 80 products · 45 s (22 s to set up, a search 12 s) · 7.8 MB through the proxy, 250 KB on this phone · $0.04');
    assert.equal(sideFigureWords(phone), '2 searches, 80 products · 20 s (a search 10 s) · 3.2 MB of this phone’s data · free');
    assert.equal(sideStatusWords(cloud, '5260'), 'Prices for store 5260');
    const other = sideFigures('scripted', { ...cloudRun, results: [term('milk', { storeMatches: false, pageStoreId: '3081' })] });
    assert.equal(sideStatusWords(other, '5260'), 'Done, but a search priced store 3081, not 5260');
    const blocked = sideFigures('phone', run('device', [term('milk', { status: 'blocked', reason: 'phone_check' })], { status: 'blocked', reason: 'phone_check' }));
    assert.deepEqual([sideStatusWords(blocked, '5260'), blocked.checkSeen], ['Blocked: a bot check on this phone (noted, not shown: nobody pressed it)', true]);
    assert.deepEqual([durationWords(400), durationWords(59_400), durationWords(125_000), dataWords(240_000), dataWords(3_160_000)], ['1 s', '59 s', '2 min 5 s', '240 KB', '3.2 MB']);
  });

  await t('summary, notice and the text to share: stores with prices each side, the same products’ prices, the prices that differ', () => {
    const phone = finish(sideJob('c', 'phone', 5, req()), {
      walmart: [term('milk', { items: phoneItems(), found: 40, storeMatches: true, pageStoreId: '5260' })],
      target: [term('milk', { items: [], found: 0, storeMatches: true, pageStoreId: '1375' })],
    });
    const cloud = applyToJob(
      finish(sideJob('c', 'scripted', 5, req()), { walmart: [term('milk', { items: cloudItems, found: 40, storeMatches: true, pageStoreId: '5260' })] }, { target: 'blocked' }),
      'walmart',
      { type: 'browserStopped', id: 'b1', use: { proxyMb: 7.8, proxyUsd: 0.039, browserUsd: 0.0007 } },
    );
    const c = comparisonOf([phone, cloud], 'c')!;
    const summary = comparisonSummary(c);
    assert.deepEqual(
      summary.sides.map((s) => [s.side, s.withPrices, s.stores, s.blocked, s.usd]),
      [
        ['phone', 2, 2, 0, 0],
        ['scripted', 1, 2, 1, 0.0397],
      ],
    );
    assert.deepEqual(summary.prices, [{ side: 'scripted', both: 13, same: 12, differ: 1 }]);
    assert.equal(pricesWords(summary.prices[0]), 'Same product, same price: 12 of 13; 1 differ (cloud browser against this phone).');
    assert.equal(sideSummaryWords(summary.sides[1]), 'Cloud browser: prices from 1 of 2 stores, 1 blocked, 1 s, 7.8 MB through Browser Use’s proxy, $0.04.');
    assert.deepEqual(comparisonNotice(c), { title: 'Phone vs. cloud ready: “milk”', body: 'This phone 2 of 2 · Cloud browser 1 of 2 · same price 12 of 13' });
    const text = comparisonText(c, 'Phone vs. cloud, test');
    for (const line of [
      'Phone vs. cloud, test',
      'Searched: milk · Walmart store 5260, Target store 1375',
      'Walmart (store 5260)',
      '- Cloud browser: Prices for store 5260 · 1 search, 40 products · 1 s · 7.8 MB through the proxy · $0.04',
      '  “milk”, this phone and the cloud browser: 13 products on both, 12 the same price; 1 only on the phone, 1 only in the cloud.',
      '    Great Value Whole Vitamin D Milk, Gallon: $3.12 on this phone, $3.32 in the cloud browser',
      `- Cloud browser: Blocked: ${reasonWords('challenge')} · 1 s`,
      '  “milk”, this phone and the cloud browser: nothing to compare (the cloud browser: not searched).',
    ]) {
      assert.ok(text.split('\n').includes(line), `missing: ${line}\n---\n${text}`);
    }
    const cut = comparisonOf([phone, finish(sideJob('c', 'scripted', 5, req()), {}, 'failed')].map((j, i) => (i ? applyToJob(applyToJob(j, 'walmart', { type: 'retry', at: 3 }), 'walmart', { type: 'interrupt', reason: 'app_closed', at: 4 }) : j)), 'c')!;
    assert.equal(comparisonNotice(cut).title, 'Phone vs. cloud interrupted');
    const stopped = comparisonOf([phone, applyToJob(sideJob('c', 'scripted', 5, req()), 'walmart', { type: 'cancel', at: 3 })].map((j, i) => (i ? applyToJob(j, 'target', { type: 'cancel', at: 3 }) : j)), 'c')!;
    assert.deepEqual(comparisonNotice(stopped), { title: 'Phone vs. cloud cancelled', body: '“milk”: what came back before stays.' });
  });

  // --- The runner ---------------------------------------------------------------------------------------------

  await t('runner: a comparison end to end: both sides at once, this phone’s searches as a test’s, each search timed and metered, told once', async () => {
    const api = fakeBrowserUse();
    const asked: string[] = [];
    const { runner, done } = makeRunner(api, () => new FakePage({ store: '3081', wire: 5000 }), {
      deviceSearch: async (retailerId, name, storeId, opts) => {
        asked.push(`${retailerId} ${name} ${storeId} ${opts?.test ? 'test' : 'search'}`);
        return { items: phoneItems(), found: 40, storeId: '5260', ms: 6000, bytes: 1_500_000, how: 'page' };
      },
    });
    const told: Comparison[] = [];
    runner.onCompared((c) => void told.push(c));
    await runner.hydrate(memory());
    const got = await runner.startComparison(req({ retailers: [{ retailerId: 'walmart', storeId: '5260' }] }));
    assert.ok(got.ok);
    if (!got.ok) return;
    assert.deepEqual(Object.keys(got.comparison.sides).sort(), ['phone', 'scripted']);
    await tick(300);
    const c = comparisonOf(runner.getJobs(), got.comparison.id)!;
    assert.equal(comparisonStatus(c), 'done');
    assert.deepEqual(asked, ['walmart milk 5260 test']);
    assert.deepEqual([told.length, told[0]?.id, done.length], [1, c.id, 0], 'told once, as a comparison, not as two cloud searches');
    const phone = c.sides.phone!.retailers[0];
    assert.deepEqual([phone.status, phone.results[0].ms, phone.results[0].bytes, phone.results[0].how, phone.results[0].storeMatches], ['done', 6000, 1_500_000, 'page', true]);
    const cloud = c.sides.scripted!.retailers[0];
    assert.deepEqual([cloud.status, cloud.storeSet, cloud.results[0].pageStoreId, cloud.results[0].bytes], ['done', 'button', '5260', 2_600_000]);
    assert.ok(cloud.results[0].ms! >= 2500, 'the search page and its wait');
    assert.ok(cloud.wireBytes! > 0, 'the DevTools link metered');
    assert.ok(api.calls.includes('PATCH /v4/browsers/b1'), 'its browser stopped');
    assert.equal(cloud.browsers.b1.proxyMb, 7.8);
    assert.deepEqual(comparisonSummary(c).prices, [{ side: 'scripted', both: 13, same: 12, differ: 1 }]);
    const f = sideFigures('scripted', cloud);
    assert.ok(f.setupMs! > 0 && f.setupMs! < f.totalMs!, 'setting up is apart from the search');
  });

  await t('runner: this phone blocked is blocked, not failed; one comparison at a time; Cancel stops the cloud side and tells nobody', async () => {
    const api = fakeBrowserUse();
    const { runner } = makeRunner(api, () => new FakePage({ store: '5260', hangAt: '/search' }), {
      deviceSearch: async (_id, name) => {
        if (name === 'milk') throw new DeviceSearchError('challenge', 'Robot or human?', { blocked: true, ms: 4000, bytes: 90_000 });
        throw new DeviceSearchError('cooling_down', 'cooling down until 3:40 PM');
      },
    });
    const told: Comparison[] = [];
    runner.onCompared((c) => void told.push(c));
    await runner.hydrate(memory());
    const got = await runner.startComparison(req({ terms: ['milk', 'eggs'], retailers: [{ retailerId: 'walmart', storeId: '5260' }] }));
    assert.ok(got.ok);
    if (!got.ok) return;
    await tick(200);
    let c = comparisonOf(runner.getJobs(), got.comparison.id)!;
    const phone = c.sides.phone!.retailers[0];
    assert.deepEqual(
      [phone.status, phone.reason, phone.results.map((r) => [r.term, r.status, r.reason, r.ms])],
      [
        'blocked',
        'phone_check',
        [
          ['milk', 'blocked', 'phone_check', 4000],
          ['eggs', 'failed', 'cooling_down', 0],
        ],
      ],
    );
    assert.equal(reasonWords('cooling_down'), 'the store is cooling down after a block on this phone');
    assert.equal(comparisonStatus(c), 'running', 'the cloud browser hangs on its search');
    assert.deepEqual(await runner.startComparison(req()), { ok: false, problem: 'comparison_running' });
    await runner.cancelComparison(c.id);
    await tick(100);
    c = comparisonOf(runner.getJobs(), c.id)!;
    assert.deepEqual([comparisonStatus(c), c.sides.scripted!.retailers[0].status, told.length], ['cancelled', 'cancelled', 0]);
    assert.ok(api.calls.includes('PATCH /v4/browsers/b1'), 'its browser stopped');
    runner.removeComparison(c.id);
    assert.equal(comparisonOf(runner.getJobs(), c.id), undefined);
  });

  await t('app launch: a comparison the app closed on: its phone and browser sides interrupted, its agent side finished in the cloud, told once', async () => {
    const answer = JSON.stringify({ retailer: 'walmart', storeId: '5260', storeConfirmed: true, items: [{ term: 'milk', name: 'Great Value Whole Milk, Gallon', price: 3.32, itemId: '10450114' }] });
    const api = fakeBrowserUse();
    const disk = memory();
    const one = req({ agent: true, retailers: [{ retailerId: 'walmart', storeId: '5260' }] });
    const started = (side: CompareSide) => applyToJob(sideJob('c', side, 1, one), 'walmart', { type: 'start', at: 1 });
    const phone = started('phone');
    const scripted = applyToJob(started('scripted'), 'walmart', { type: 'browser', id: 'bA' });
    const agent = applyToJob(started('agent'), 'walmart', { type: 'agentRun', runId: 'rX', sessionId: 'sX' });
    await disk.setItem('stretch.cloud.v1', JSON.stringify({ v: 1, jobs: [phone, scripted, agent], orphans: [] }));
    const fetchFn = api.fetchFn;
    const withRun: FetchLike = async (url, init) =>
      url.includes('/runs/rX') ? { ok: true, status: 200, text: async () => JSON.stringify({ id: 'rX', status: 'completed', sessionId: 'sX', result: answer, totalCostUsd: '0.21' }) } : fetchFn(url, init);
    const { runner, done } = makeRunner({ ...api, fetchFn: withRun }, () => new FakePage());
    const told: Comparison[] = [];
    runner.onCompared((c) => void told.push(c));
    await runner.hydrate(disk);
    await tick(120);
    const c = comparisonOf(runner.getJobs(), 'c')!;
    assert.deepEqual(
      (['phone', 'scripted', 'agent'] as const).map((s) => [s, c.sides[s]!.retailers[0].status, c.sides[s]!.retailers[0].reason]),
      [
        ['phone', 'interrupted', 'app_closed'],
        ['scripted', 'interrupted', 'app_closed'],
        ['agent', 'done', undefined],
      ],
    );
    assert.ok(api.calls.includes('PATCH /v4/browsers/bA'), 'the browser it left is stopped');
    assert.deepEqual([told.length, comparisonStatus(told[0]), comparisonNotice(told[0]).title, done.length], [1, 'interrupted', 'Phone vs. cloud interrupted', 0]);
    assert.deepEqual(c.sides.agent!.retailers[0].runs, { rX: 0.21 });
  });

  await t('jobs kept: the newest 30, and a comparison whole or not at all', async () => {
    const api = fakeBrowserUse();
    const disk = memory();
    const old = Array.from({ length: 28 }, (_, i) => finish(newJob(walmartJob(['milk']), `old${i}`, 100 - i)));
    const pair = [finish(sideJob('c', 'phone', 10, req())), finish(sideJob('c', 'scripted', 10, req()))];
    await disk.setItem('stretch.cloud.v1', JSON.stringify({ v: 1, jobs: [...old, ...pair], orphans: [] }));
    const { runner } = makeRunner(api, () => new FakePage({ store: '5260', hangAt: '/search' }));
    await runner.hydrate(disk);
    assert.ok((await runner.start(walmartJob(['milk']))).ok);
    assert.deepEqual([runner.getJobs().length, Object.keys(comparisonOf(runner.getJobs(), 'c')?.sides ?? {}).length], [31, 2], 'the comparison straddling the 30th stays whole');
    assert.ok((await runner.start(walmartJob(['eggs']))).ok);
    assert.deepEqual([runner.getJobs().length, comparisonOf(runner.getJobs(), 'c')], [30, undefined], 'then it goes whole');
    for (const j of runner.getJobs()) await runner.cancel(j.id);
    await tick(50);
  });

  finished = true;
  console.log(`\n${passed} phone vs. cloud tests passed`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
