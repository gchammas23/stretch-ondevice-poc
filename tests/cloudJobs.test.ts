/// <reference types="node" />
import assert from 'node:assert/strict';
import type { FetchLike } from '../src/cloud/browserUse';
import { CdpClosed, CdpError } from '../src/cloud/cdp';
import { FlowStopped } from '../src/cloud/flow';
import {
  applyToJob,
  canApply,
  checkRequest,
  cleanTerms,
  jobCost,
  jobStatus,
  newJob,
  readJobs,
  retailerCost,
  storeConfirmed,
  transition,
  unstoppedBrowsers,
  type CloudJob,
  type JobRequest,
  type RetailerRun,
  type TermResult,
} from '../src/cloud/jobs';
import { cloudRetailers, cloudStoreId, planRetailers, viaFor } from '../src/cloud/plan';
import { walmartFlow } from '../src/cloud/walmart';
import { estimate, jobNotice, problemWords, retailerLine } from '../src/cloud/words';
import { BUNDLED_CONFIG } from '../src/onDevice/retailers';
import { AppStore, CLOUD_OFF } from '../src/state/appStore';
import { phoneChoices, steadyChoices, storeChoices } from '../src/state/storeChoices';
import { clock, fakeBrowserUse, FakePage, flowContext, makeRunner, memory, tick, walmartJob } from './cloudKit';

// Cloud jobs: the per-retailer state machine, the guardrails, what the switch changes (and, off, doesn't), and the
// runner end to end against a simulated Browser Use API and simulated pages. No live site, no credit.

let passed = 0;
let finished = false;
const t = async (name: string, fn: () => unknown) => {
  await fn();
  passed++;
  console.log('ok -', name);
};
// A test left waiting on a promise that never settles lets Node exit quietly, as if all was well: that's a failure.
process.on('exit', (code) => {
  if (!finished && code === 0) {
    console.error(`Stopped after ${passed} tests: one was left waiting.`);
    process.exitCode = 1;
  }
});

(async () => {
  // --- The state machine --------------------------------------------------------------------------------------

  const run = (): RetailerRun => newJob({ engine: 'scripted', terms: ['milk'], retailers: [{ retailerId: 'walmart', storeId: '5260', via: 'browser' }] }, 'j', 0).retailers[0];
  const term = (t: string, extra: Partial<TermResult> = {}): TermResult => ({ term: t, status: 'done', items: [], at: 1, ...extra });

  await t('state machine: queued → running → done, blocked or failed; a retry queues it afresh, keeping its browsers to stop', () => {
    let r = run();
    assert.equal(r.status, 'queued');
    r = transition(r, { type: 'start', at: 10 });
    assert.deepEqual([r.status, r.startedAt, r.attempts], ['running', 10, 1]);
    r = transition(r, { type: 'browser', id: 'b1' });
    r = transition(r, { type: 'storeSet', how: 'button' });
    r = transition(r, { type: 'term', result: term('milk', { storeMatches: true }) });
    r = transition(r, { type: 'finish', status: 'blocked', reason: 'challenge', at: 50 });
    assert.deepEqual([r.status, r.reason, r.finishedAt, r.browserId], ['blocked', 'challenge', 50, 'b1']);
    r = transition(r, { type: 'retry', at: 60 });
    assert.deepEqual([r.status, r.results.length, r.storeSet, r.browserId, Object.keys(r.browsers)], ['queued', 0, undefined, undefined, ['b1']]);
    r = transition(transition(r, { type: 'start', at: 70 }), { type: 'finish', status: 'done', at: 80 });
    assert.deepEqual([r.status, r.attempts], ['done', 2]);
  });

  await t('state machine: what can’t happen changes nothing, the same object (a late answer after a cancel, a second start)', () => {
    const queued = run();
    assert.equal(transition(queued, { type: 'finish', status: 'done', at: 1 }), queued);
    assert.equal(transition(queued, { type: 'term', result: term('milk') }), queued);
    const cancelled = transition(transition(queued, { type: 'start', at: 1 }), { type: 'cancel', at: 2 });
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(transition(cancelled, { type: 'term', result: term('milk') }), cancelled, 'a search landing after the cancel');
    assert.equal(transition(cancelled, { type: 'finish', status: 'done', at: 3 }), cancelled);
    assert.equal(transition(cancelled, { type: 'start', at: 3 }), cancelled);
    const done = transition(transition(run(), { type: 'start', at: 1 }), { type: 'finish', status: 'done', at: 2 });
    assert.equal(transition(done, { type: 'retry', at: 3 }), done, 'a done retailer isn’t tried again');
    assert.equal(transition(done, { type: 'interrupt', reason: 'app_closed', at: 3 }), done);
    assert.deepEqual(
      (['queued', 'running', 'done', 'blocked', 'failed', 'interrupted', 'cancelled'] as const).map((s) => canApply(s, 'retry')),
      [false, false, false, true, true, true, true],
    );
    // A browser created as it was cancelled, and costs, are taken whatever the state: so it's stopped and counted.
    const late = transition(cancelled, { type: 'browser', id: 'b9' });
    assert.deepEqual(Object.keys(late.browsers), ['b9']);
    assert.equal(transition(late, { type: 'browserStopped', id: 'b9', use: { proxyMb: 1, proxyUsd: 0.005, browserUsd: 0.001 } }).browsers.b9.stopped, true);
  });

  await t('state machine: a search again replaces the term’s result; costs count once per browser and run, however often reported', () => {
    let r = transition(run(), { type: 'start', at: 1 });
    r = transition(r, { type: 'term', result: term('milk', { found: 1 }) });
    r = transition(r, { type: 'term', result: term('milk', { found: 2 }) });
    assert.deepEqual(r.results.map((x) => x.found), [2]);
    for (let i = 0; i < 3; i++) r = transition(r, { type: 'browserStopped', id: 'b1', use: { proxyMb: 7.8, proxyUsd: 0.039, browserUsd: 0.001 } });
    r = transition(r, { type: 'runCost', runId: 'r1', usd: 0.2 });
    r = transition(r, { type: 'runCost', runId: 'r1', usd: 0.25 });
    assert.deepEqual(retailerCost(r), { usd: 0.29, proxyMb: 7.8 });
  });

  await t('jobs: finished when every retailer is, running while any runs, interrupted when one was; costs and unstopped browsers', () => {
    let job = newJob(walmartJob(), 'j1', 0);
    assert.equal(jobStatus(job), 'running');
    job = applyToJob(job, 'walmart', { type: 'start', at: 1 });
    job = applyToJob(job, 'walmart', { type: 'browser', id: 'b1' });
    job = applyToJob(job, 'kroger', { type: 'start', at: 1 });
    job = applyToJob(job, 'kroger', { type: 'finish', status: 'done', at: 5 });
    assert.deepEqual([jobStatus(job), job.finishedAt], ['running', undefined]);
    job = applyToJob(job, 'walmart', { type: 'interrupt', reason: 'app_slept', at: 9 });
    assert.deepEqual([jobStatus(job), job.finishedAt], ['interrupted', 9]);
    assert.deepEqual(unstoppedBrowsers([job]), [{ jobId: 'j1', retailerId: 'walmart', browserId: 'b1' }]);
    job = applyToJob(job, 'walmart', { type: 'browserStopped', id: 'b1', use: { proxyMb: 5, proxyUsd: 0.025, browserUsd: 0.001 } });
    assert.deepEqual([unstoppedBrowsers([job]).length, jobCost(job)], [0, { usd: 0.026, proxyMb: 5 }]);
    job = applyToJob(job, 'walmart', { type: 'retry', at: 20 });
    assert.deepEqual([jobStatus(job), job.finishedAt], ['running', undefined], 'a retry opens it again');
  });

  await t('jobs: prices are the store’s only when the store was set and every search said it was that store’s', () => {
    let r = transition(run(), { type: 'start', at: 1 });
    r = transition(r, { type: 'term', result: term('milk', { storeMatches: true, pageStoreId: '5260' }) });
    assert.equal(storeConfirmed(r), false, 'the store wasn’t set');
    r = transition(r, { type: 'storeSet', how: 'button' });
    assert.equal(storeConfirmed(r), true);
    const mixed = transition(r, { type: 'term', result: term('eggs', { storeMatches: false, pageStoreId: '3081' }) });
    assert.equal(storeConfirmed(mixed), false);
    assert.equal(retailerLine({ ...transition(mixed, { type: 'finish', status: 'done', at: 3 }) }), 'Done, but a search priced store 3081, not 5260');
  });

  await t('saved jobs: well-formed ones kept; a broken save, or one from another version, dropped', () => {
    const good = newJob(walmartJob(), 'j1', 0);
    assert.deepEqual(readJobs(JSON.stringify({ v: 1, jobs: [good, { id: 'x' }, { ...good, engine: 'robot' }] })), [good]);
    assert.deepEqual(readJobs('{not json'), []);
    assert.deepEqual(readJobs(null), []);
  });

  // --- Guardrails ------------------------------------------------------------------------------------------

  await t('guardrails: 1 to 5 terms, one store per retailer with its number, 2 jobs running at most, a key and $1 of credit', () => {
    assert.deepEqual(cleanTerms(' milk ,Eggs\n\n MILK , whole   milk,'), ['milk', 'Eggs', 'whole milk']);
    const ctx = { jobs: [] as CloudJob[], hasKey: true, balanceUsd: 12.5 };
    assert.deepEqual(checkRequest(walmartJob(), ctx), { ok: true });
    assert.deepEqual(checkRequest({ ...walmartJob(), terms: [] }, ctx), { ok: false, problem: 'no_terms' });
    assert.deepEqual(checkRequest({ ...walmartJob(), terms: ['a', 'b', 'c', 'd', 'e', 'f'] }, ctx), { ok: false, problem: 'too_many_terms', count: 6 });
    assert.deepEqual(checkRequest({ ...walmartJob(), retailers: [] }, ctx), { ok: false, problem: 'no_retailers' });
    const twice = { ...walmartJob(), retailers: [...walmartJob().retailers, { retailerId: 'walmart' as const, storeId: '100', via: 'browser' as const }] };
    assert.deepEqual(checkRequest(twice, ctx), { ok: false, problem: 'same_retailer_twice', retailerId: 'walmart' });
    assert.deepEqual(checkRequest({ ...walmartJob(), retailers: [{ retailerId: 'walmart', storeId: ' ', via: 'browser' }] }, ctx), { ok: false, problem: 'no_store', retailerId: 'walmart' });
    const running = [newJob(walmartJob(), 'a', 0), newJob(walmartJob(), 'b', 0)];
    assert.deepEqual(checkRequest(walmartJob(), { ...ctx, jobs: running }), { ok: false, problem: 'too_many_jobs', running: 2 });
    assert.deepEqual(checkRequest(walmartJob(), { ...ctx, hasKey: false }), { ok: false, problem: 'no_key' });
    assert.deepEqual(checkRequest(walmartJob(), { ...ctx, balanceUsd: 0.99 }), { ok: false, problem: 'low_balance', balanceUsd: 0.99 });
    assert.deepEqual(checkRequest(walmartJob(), { ...ctx, balanceUsd: undefined, balanceError: 'HTTP 503' }), { ok: false, problem: 'balance_unknown', detail: 'HTTP 503' });
    const krogerOnly: JobRequest = { engine: 'scripted', terms: ['milk'], retailers: [{ retailerId: 'kroger', storeId: '45202', via: 'device' }] };
    assert.deepEqual(checkRequest(krogerOnly, { jobs: [], hasKey: false }), { ok: true }, 'no cloud, no key or credit needed');
    assert.equal(problemWords({ problem: 'low_balance', balanceUsd: 0.83 }), 'Browser Use has $0.83 of credit left. Cloud searches don’t start below $1.00.');
  });

  await t('estimates: scripted pages at 2.6 MB through a $5/GB proxy; an agent run at most its cap; the phone free', () => {
    const one = estimate({ terms: ['milk'], retailers: [{ retailerId: 'walmart', storeId: '1', via: 'browser' }] });
    assert.deepEqual([Math.round(one.usd * 1000) / 1000, one.capped], [0.04, false]);
    const agent = estimate({ terms: ['milk'], retailers: [{ retailerId: 'walmart', storeId: '1', via: 'agent' }, { retailerId: 'target', storeId: '2', via: 'agent' }] });
    assert.deepEqual(agent, { usd: 1.5, capped: true });
    assert.deepEqual(estimate({ terms: ['milk'], retailers: [{ retailerId: 'kroger', storeId: '1', via: 'device' }] }), { usd: 0, capped: false });
  });

  // --- What the switch changes ------------------------------------------------------------------------------

  await t('switch off: the phone prices exactly the stores it did before; settings start off and survive a bad save', async () => {
    const store = new AppStore();
    await store.hydrate(memory());
    const s = store.getState().settings;
    assert.deepEqual(s.cloud, CLOUD_OFF);
    assert.deepEqual(
      phoneChoices(s, BUNDLED_CONFIG.retailers).map((c) => c.config.id),
      storeChoices(s, BUNDLED_CONFIG.retailers).map((c) => c.config.id),
    );
    assert.deepEqual(steadyChoices(s, BUNDLED_CONFIG.retailers).map((c) => c.config.id), ['walmart', 'target', 'kroger', 'aldi']);
    const bad = memory();
    await bad.setItem('stretch.app.v1', JSON.stringify({ settings: { cloud: { on: 'yes', engine: 'robot', storeIds: { walmart: 5260, target: '1375' } } } }));
    const again = new AppStore();
    await again.hydrate(bad);
    assert.deepEqual(again.getState().settings.cloud, { ...CLOUD_OFF, storeIds: { target: '1375' } });
  });

  await t('switch on: the phone stops searching Walmart and Target (Target stays in scripted mode when set to); Start over turns it off', async () => {
    const store = new AppStore();
    await store.hydrate(memory());
    store.setCloud({ on: true });
    const ids = () => steadyChoices(store.getState().settings, BUNDLED_CONFIG.retailers).map((c) => c.config.id);
    assert.deepEqual(ids(), ['kroger', 'aldi']);
    store.setCloud({ targetScripted: 'device' });
    assert.deepEqual(ids(), ['target', 'kroger', 'aldi']);
    store.setCloud({ engine: 'agent' });
    assert.deepEqual(ids(), ['kroger', 'aldi'], 'the agent reads Target too');
    assert.deepEqual(cloudRetailers(store.getState().settings.cloud), ['walmart', 'target']);
    store.reset();
    assert.deepEqual(store.getState().settings.cloud, CLOUD_OFF);
    assert.deepEqual(ids(), ['walmart', 'target', 'kroger', 'aldi']);
  });

  await t('stores for a job: the one set in Your stores, else the number typed for the cloud; Kroger’s API takes the ZIP; how each is read', async () => {
    const store = new AppStore();
    await store.hydrate(memory());
    store.setZip('45202');
    store.setStoreId('walmart', '5260');
    store.setCloudStoreId('walmart', '100');
    store.setCloudStoreId('target', '1375');
    const s = store.getState().settings;
    assert.deepEqual(cloudStoreId('walmart', s, false), { id: '5260', from: 'your stores' }, 'the app’s own selection first');
    assert.deepEqual(cloudStoreId('target', s, false), { id: '1375', from: 'typed' });
    assert.deepEqual(cloudStoreId('kroger', s, true), { id: '45202', from: 'zip' });
    assert.deepEqual(cloudStoreId('kroger', s, false), { id: '', from: 'none' });
    assert.deepEqual(
      (['walmart', 'target', 'kroger'] as const).map((id) => viaFor(id, { ...CLOUD_OFF, on: true })),
      ['browser', 'browser', 'device'],
    );
    assert.deepEqual(planRetailers(['walmart', 'target', 'kroger'], s, false), {
      retailers: [
        { retailerId: 'walmart', storeId: '5260', via: 'browser' },
        { retailerId: 'target', storeId: '1375', via: 'browser' },
      ],
      skipped: ['kroger'],
    });
    store.setCloudStoreId('target', ' ');
    assert.equal(store.getState().settings.cloud.storeIds.target, undefined);
  });

  // --- The scripted flow, on a simulated page ---------------------------------------------------------------

  await t('walmart flow: home, store page, a real click, the cookie checked, then each search read with its store', async () => {
    const page = new FakePage({ dataStore: (term) => (term === 'eggs' ? '3081' : '5260') });
    const results: TermResult[] = [];
    const ctx = flowContext(results);
    assert.deepEqual(await walmartFlow(page, '5260', ['milk', 'eggs'], ctx), { status: 'done' });
    assert.deepEqual(page.navigations, [
      'https://www.walmart.com/',
      'https://www.walmart.com/store/5260',
      'https://www.walmart.com/search?q=milk',
      'https://www.walmart.com/search?q=eggs',
    ]);
    assert.deepEqual(ctx.set, ['button']);
    assert.deepEqual(results.map((r) => [r.term, r.status, r.pageStoreId, r.storeMatches, r.items.length]), [
      ['milk', 'done', '5260', true, 14],
      ['eggs', 'done', '3081', false, 14],
    ]);
  });

  await t('walmart flow: a bot check that stays stops everything for 45 s, then Walmart is blocked; nothing is pressed meanwhile', async () => {
    const page = new FakePage({ px: (url) => url.includes('/store/') });
    const results: TermResult[] = [];
    const c = clock();
    const start = c.now();
    const ctx = flowContext(results, c);
    assert.deepEqual(await walmartFlow(page, '5260', ['milk'], ctx), { status: 'blocked', reason: 'challenge' });
    assert.deepEqual([ctx.seen, page.checks, page.cookie, results.length], [1, 7, '3081', 0], 'one look at home, one at the store page, then 5 while it waited');
    assert.equal(c.now() - start, 3000 + 3000 + 45_000, 'the page loads’ pauses and the 45 s wait, no more');
  });

  await t('walmart flow: a check on a search page that clears by itself: that search is loaded again, once, and read', async () => {
    let shown = 2;
    const page = new FakePage({ px: (url) => url.includes('/search') && shown-- > 0 });
    const results: TermResult[] = [];
    const ctx = flowContext(results);
    assert.deepEqual(await walmartFlow(page, '5260', ['milk'], ctx), { status: 'done' });
    assert.equal(page.navigations.filter((u) => u.includes('/search')).length, 2);
    assert.deepEqual([ctx.seen, results[0].status], [1, 'done']);
  });

  await t('walmart flow: page data still streaming is read again (3 tries, 1.5 s apart); still partial, that search fails and the next goes on', async () => {
    const results: TermResult[] = [];
    assert.deepEqual(await walmartFlow(new FakePage({ partialReads: 2 }), '5260', ['milk'], flowContext(results)), { status: 'done' });
    assert.equal(results[0].status, 'done');
    const worse: TermResult[] = [];
    assert.deepEqual(await walmartFlow(new FakePage({ partialReads: 3 }), '5260', ['milk', 'eggs'], flowContext(worse)), { status: 'done' });
    assert.deepEqual(worse.map((r) => [r.term, r.status, r.reason]), [
      ['milk', 'failed', 'no_page_data'],
      ['eggs', 'done', undefined],
    ]);
  });

  await t('walmart flow: no button: already this store, or failed; over its data allowance it stops; a stopped job stops it', async () => {
    const same: TermResult[] = [];
    const sameCtx = flowContext(same);
    assert.deepEqual(await walmartFlow(new FakePage({ store: '5260' }), '5260', ['milk'], sameCtx), { status: 'done' });
    assert.deepEqual(sameCtx.set, ['already']);
    const heavy: TermResult[] = [];
    assert.deepEqual(await walmartFlow(new FakePage({ mb: 25 }), '5260', ['milk'], flowContext(heavy)), { status: 'failed', reason: 'data_budget' });
    await assert.rejects(walmartFlow(new FakePage(), '5260', ['milk'], flowContext([], clock(), { stopped: () => true })), FlowStopped);
  });

  // --- The runner, end to end ------------------------------------------------------------------------------------

  await t('runner: refuses a job below $1 of credit, without a key, when the credit can’t be read, or a third at once; nothing is created', async () => {
    for (const [balance, key, problem] of [
      [0.99, 'bu_test', 'low_balance'],
      [12, '', 'no_key'],
      ['error', 'bu_test', 'balance_unknown'],
    ] as const) {
      const api = fakeBrowserUse({ balance });
      const { runner } = makeRunner(api, () => new FakePage(), {}, key);
      await runner.hydrate(memory());
      const got = await runner.start(walmartJob());
      assert.equal(got.ok ? 'ok' : got.problem, problem);
      assert.equal(api.calls.filter((c) => c.startsWith('POST')).length, 0);
      assert.equal(runner.getJobs().length, 0);
    }
    const api = fakeBrowserUse();
    const { runner } = makeRunner(api, () => new FakePage({ hangAt: '/store/' }));
    await runner.hydrate(memory());
    assert.equal((await runner.start(walmartJob())).ok, true);
    assert.equal((await runner.start(walmartJob())).ok, true);
    const third = await runner.start(walmartJob());
    assert.equal(third.ok ? 'ok' : third.problem, 'too_many_jobs');
    await Promise.all(runner.getJobs().map((j) => runner.cancel(j.id)));
  });

  await t('runner: a scripted job end to end; the browser’s id saved before it’s driven, stopped in the finally, costed; told once', async () => {
    const api = fakeBrowserUse();
    const disk = memory();
    let savedFirst = false;
    const { runner, done } = makeRunner(api, () => {
      savedFirst = (disk.map.get('stretch.cloud.v1') ?? '').includes('"b1"');
      return new FakePage();
    });
    await runner.hydrate(disk);
    const got = await runner.start(walmartJob());
    assert.equal(got.ok, true);
    await tick(80);
    const job = runner.getJobs()[0];
    assert.equal(savedFirst, true, 'the id was on the phone before the browser was driven');
    assert.deepEqual(job.retailers.map((r) => [r.retailerId, r.status, r.storeSet ?? null]), [
      ['walmart', 'done', 'button'],
      ['kroger', 'done', null],
    ]);
    assert.deepEqual(job.retailers[0].results.map((r) => [r.term, r.storeMatches]), [
      ['milk', true],
      ['eggs', true],
    ]);
    assert.equal(job.retailers[1].results[0].storeMatches, true, 'Kroger asked by ZIP: the store its API picked is the one asked for');
    assert.deepEqual(job.retailers[0].browsers, { b1: { stopped: true, proxyMb: 7.8, proxyUsd: 0.039, browserUsd: 0.0007 } });
    assert.ok(api.calls.includes('PATCH /v4/browsers/b1'));
    assert.deepEqual([done.length, done[0].id], [1, job.id], 'told once');
    assert.equal(job.balanceBefore, 12.5);
    assert.equal(job.balanceAfter, 12.5, 'read again once its browsers stopped');
    assert.match(jobNotice(job).title, /Cloud search ready: 2 searches/);
    await runner.flush();
    const saved = JSON.parse(disk.map.get('stretch.cloud.v1')!);
    assert.equal(saved.jobs[0].retailers[0].browsers.b1.stopped, true);
  });

  await t('runner: a page error fails the retailer with what went wrong, and its browser is still stopped', async () => {
    const api = fakeBrowserUse();
    const { runner } = makeRunner(api, () => new FakePage({ failAt: { at: '/store/', error: new CdpError('Page.navigate', 'net::ERR_TUNNEL_CONNECTION_FAILED') } }));
    await runner.hydrate(memory());
    await runner.start(walmartJob(['milk']));
    await tick(60);
    const walmart = runner.getJobs()[0].retailers[0];
    assert.deepEqual([walmart.status, walmart.reason, walmart.detail], ['failed', 'error', 'Page.navigate: net::ERR_TUNNEL_CONNECTION_FAILED']);
    assert.equal(walmart.browsers.b1.stopped, true);
  });

  await t('runner: the connection dropping mid-job interrupts it (browser stopped); Try again runs it afresh and tells again', async () => {
    const api = fakeBrowserUse();
    let n = 0;
    const { runner, done } = makeRunner(api, () => (++n === 1 ? new FakePage({ failAt: { at: '/search', error: new CdpClosed('the socket closed') } }) : new FakePage()));
    await runner.hydrate(memory());
    const got = await runner.start(walmartJob(['milk']));
    await tick(60);
    const id = got.ok ? got.job.id : '';
    let walmart = runner.getJob(id)!.retailers[0];
    assert.deepEqual([walmart.status, walmart.reason, jobStatus(runner.getJob(id)!)], ['interrupted', 'connection', 'interrupted']);
    assert.equal(walmart.browsers.b1.stopped, true);
    assert.equal(done.length, 1);
    assert.equal((await runner.retry(id)).ok, true);
    await tick(60);
    walmart = runner.getJob(id)!.retailers[0];
    assert.deepEqual([walmart.status, walmart.attempts, Object.keys(walmart.browsers)], ['done', 2, ['b1', 'b2']]);
    assert.equal(done.length, 2, 'told again when it finished again');
  });

  await t('runner: back from the background with the browser’s socket gone: interrupted, its page let go, its browser stopped', async () => {
    const api = fakeBrowserUse();
    const page = new FakePage({ hangAt: '/store/', alive: false });
    const { runner } = makeRunner(api, () => page);
    await runner.hydrate(memory());
    const got = await runner.start(walmartJob(['milk']));
    await tick(30);
    runner.setActive(false);
    runner.setActive(true);
    await tick(60);
    const walmart = runner.getJob(got.ok ? got.job.id : '')!.retailers[0];
    assert.deepEqual([walmart.status, walmart.reason, page.closed, walmart.browsers.b1?.stopped], ['interrupted', 'app_slept', true, true]);
  });

  await t('runner: Cancel stops the browser and cancels agent runs; what arrives afterwards changes nothing', async () => {
    const api = fakeBrowserUse({ agent: { r1: [{ status: 'running' }] } });
    const page = new FakePage({ hangAt: '/search' });
    const { runner } = makeRunner(api, () => page);
    await runner.hydrate(memory());
    const scripted = await runner.start(walmartJob(['milk']));
    const agent = await runner.start({ engine: 'agent', terms: ['milk'], retailers: [{ retailerId: 'target', storeId: '1375', via: 'agent' }] });
    await tick(30);
    await runner.cancel(scripted.ok ? scripted.job.id : '');
    await runner.cancel(agent.ok ? agent.job.id : '');
    await tick(40);
    const [a, s] = runner.getJobs();
    assert.deepEqual([jobStatus(s), s.retailers[0].status, s.retailers[0].browsers.b1.stopped, page.closed], ['cancelled', 'cancelled', true, true]);
    assert.equal(jobStatus(a), 'cancelled');
    assert.ok(api.calls.includes('POST /v4/runs/r1/cancel'));
  });

  await t('agent: an answer that isn’t the JSON asked for gets one follow-up in its session; then its products; both runs costed', async () => {
    const good = JSON.stringify({ retailer: 'walmart', storeId: '5260', storeConfirmed: true, items: [{ term: 'milk', name: 'Great Value Whole Milk, 1 gal', price: 3.32, itemId: '10450114' }] });
    const api = fakeBrowserUse({
      agent: { r1: [{ status: 'running' }, { status: 'completed', result: 'I found the prices: whole milk is $3.32.', cost: '0.21' }], r2: [{ status: 'completed', result: good, cost: '0.04' }] },
      active: [{ id: 'agent-browser', session: 's1' }],
    });
    const { runner, done } = makeRunner(api, () => new FakePage());
    await runner.hydrate(memory());
    const got = await runner.start({ engine: 'agent', terms: ['milk'], retailers: [{ retailerId: 'walmart', storeId: '5260', via: 'agent' }] });
    assert.equal(got.ok, true);
    for (let i = 0; i < 20 && !done.length; i++) await new Promise((r) => setTimeout(r, 10));
    const walmart = runner.getJobs()[0].retailers[0];
    assert.deepEqual([walmart.status, walmart.runId, walmart.followUpId, walmart.sessionId, walmart.storeSet], ['done', 'r1', 'r2', 's1', 'agent']);
    assert.deepEqual(walmart.results[0].items.map((i) => [i.itemId, i.price]), [['10450114', 3.32]]);
    assert.deepEqual(walmart.runs, { r1: 0.21, r2: 0.04 });
    assert.equal(api.tasks.length, 2);
    assert.deepEqual([api.tasks[0].model, api.tasks[0].maxCostUsd, api.tasks[1].sessionId], ['gpt-5.6-luna', 0.75, 's1']);
    assert.match(api.tasks[1].task, /not the JSON I asked for \(it was not JSON\)/);
    await tick(20);
    assert.ok(api.stopped.has('agent-browser'), 'the session’s browser is stopped once the app is done with it');
  });

  await t('agent: blocked, invalid twice, or failed: said as such', async () => {
    const api = fakeBrowserUse({
      agent: {
        r1: [{ result: '{"blocked": true}' }],
        r2: [{ result: 'nope' }],
        r3: [{ result: 'still nope' }],
        r4: [{ status: 'failed', error: 'Max cost reached' }],
      },
    });
    const { runner, done } = makeRunner(api, () => new FakePage());
    await runner.hydrate(memory());
    await runner.start({ engine: 'agent', terms: ['milk'], retailers: [{ retailerId: 'walmart', storeId: '5260', via: 'agent' }, { retailerId: 'target', storeId: '1375', via: 'agent' }] });
    for (let i = 0; i < 40 && !done.length; i++) await new Promise((r) => setTimeout(r, 10));
    const [walmart, target] = runner.getJobs()[0].retailers;
    assert.deepEqual([walmart.status, walmart.reason, walmart.checkSeen], ['blocked', 'challenge', true]);
    assert.deepEqual([target.status, target.reason, target.detail], ['failed', 'bad_json', 'it was not JSON']);
    const api2 = fakeBrowserUse({ agent: { r1: [{ status: 'failed', error: 'Max cost reached' }] } });
    const second = makeRunner(api2, () => new FakePage());
    await second.runner.hydrate(memory());
    await second.runner.start({ engine: 'agent', terms: ['milk'], retailers: [{ retailerId: 'walmart', storeId: '5260', via: 'agent' }] });
    for (let i = 0; i < 40 && !second.done.length; i++) await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual([second.runner.getJobs()[0].retailers[0].reason, second.runner.getJobs()[0].retailers[0].detail], ['agent_failed', 'Max cost reached']);
  });

  await t('app launch: browsers left unstopped are stopped (saved ones, orphans, labeled ones); scripted work interrupted; agent runs finished', async () => {
    const answer = JSON.stringify({ retailer: 'target', storeId: '1375', storeConfirmed: true, items: [{ term: 'milk', name: 'Whole Milk - 1gal', price: 3.69, itemId: '13276134' }] });
    const api = fakeBrowserUse({ agent: {}, active: [{ id: 'bL', label: true }] });
    const disk = memory();
    let scripted = newJob(walmartJob(['milk']), 'j1', 0);
    scripted = applyToJob(scripted, 'walmart', { type: 'start', at: 1 });
    scripted = applyToJob(scripted, 'walmart', { type: 'browser', id: 'bA' });
    scripted = applyToJob(scripted, 'kroger', { type: 'start', at: 1 });
    let agent = newJob({ engine: 'agent', terms: ['milk'], retailers: [{ retailerId: 'target', storeId: '1375', via: 'agent' }] }, 'j2', 0);
    agent = applyToJob(agent, 'target', { type: 'start', at: 1 });
    agent = applyToJob(agent, 'target', { type: 'agentRun', runId: 'rX', sessionId: 'sX' });
    await disk.setItem('stretch.cloud.v1', JSON.stringify({ v: 1, jobs: [agent, scripted], orphans: ['bO'] }));
    // The agent's run finished in the cloud while the app was closed.
    const fetchFn = api.fetchFn;
    const withRun: FetchLike = async (url, req) =>
      url.includes('/runs/rX') ? { ok: true, status: 200, text: async () => JSON.stringify({ id: 'rX', status: 'completed', sessionId: 'sX', result: answer, totalCostUsd: '0.12' }) } : fetchFn(url, req);
    const { runner, done } = makeRunner({ ...api, fetchFn: withRun }, () => new FakePage());
    await runner.hydrate(disk);
    await tick(80);
    const [a, s] = runner.getJobs();
    assert.deepEqual(s.retailers.map((r) => [r.retailerId, r.status, r.reason]), [
      ['walmart', 'interrupted', 'app_closed'],
      ['kroger', 'interrupted', 'app_closed'],
    ]);
    assert.equal(s.retailers[0].browsers.bA.stopped, true);
    assert.deepEqual(['PATCH /v4/browsers/bA', 'PATCH /v4/browsers/bO', 'PATCH /v4/browsers/bL'].map((c) => api.calls.includes(c)), [true, true, true]);
    assert.deepEqual([a.retailers[0].status, a.retailers[0].results[0].items[0].price, a.retailers[0].runs], ['done', 3.69, { rX: 0.12 }]);
    assert.deepEqual(done.map((j) => j.id).sort(), ['j1', 'j2']);
  });

  await t('this phone’s part: Kroger’s searches through the app’s own search; a failure said per search; cut off by the background: interrupted', async () => {
    const api = fakeBrowserUse();
    let fail = true;
    const { runner } = makeRunner(api, () => new FakePage(), {
      deviceSearch: async (_id, term) => {
        if (term === 'eggs' && fail) throw new Error('api: kroger_products_http_401');
        return { items: [{ itemId: 'k', name: term, price: 1 }], found: 1, storeId: '01400943' };
      },
    });
    await runner.hydrate(memory());
    const req: JobRequest = { engine: 'scripted', terms: ['milk', 'eggs'], retailers: [{ retailerId: 'kroger', storeId: '01400943', via: 'device' }] };
    await runner.start(req);
    await tick(30);
    const kroger = runner.getJobs()[0].retailers[0];
    assert.deepEqual(kroger.results.map((r) => [r.term, r.status, r.detail]), [
      ['milk', 'done', undefined],
      ['eggs', 'failed', 'api: kroger_products_http_401'],
    ]);
    assert.equal(kroger.status, 'done', 'one search came back');
    fail = false;
    let release: () => void = () => {};
    const slow = makeRunner(api, () => new FakePage(), {
      deviceSearch: () =>
        new Promise((_, reject) => {
          release = () => reject(new Error('timeout'));
        }),
    });
    await slow.runner.hydrate(memory());
    await slow.runner.start(req);
    await tick(10);
    slow.runner.setActive(false);
    slow.clock.sleep(5000);
    release();
    await tick(20);
    assert.deepEqual([slow.runner.getJobs()[0].retailers[0].status, slow.runner.getJobs()[0].retailers[0].reason], ['interrupted', 'app_slept']);
  });

  await t('forgetting everything: running jobs cancelled, their browsers still stopped (or kept to stop later), the list emptied', async () => {
    const api = fakeBrowserUse({ failStop: ['b1'] });
    const disk = memory();
    const { runner } = makeRunner(api, () => new FakePage({ hangAt: '/store/' }));
    await runner.hydrate(disk);
    await runner.start(walmartJob(['milk']));
    await tick(30);
    await runner.clear();
    await tick(40);
    assert.equal(runner.getJobs().length, 0);
    await runner.flush();
    assert.deepEqual(JSON.parse(disk.map.get('stretch.cloud.v1')!), { v: 1, jobs: [], orphans: ['b1'] }, 'a browser the API wouldn’t stop yet is kept, to stop at the next launch');
  });

  finished = true;
  console.log(`\n${passed} cloud job tests passed`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
