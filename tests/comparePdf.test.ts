/// <reference types="node" />
import assert from 'node:assert/strict';
import {
  comparisonJobs,
  comparisonOf,
  comparisonProblems,
  problemLine,
  sideReasonWords,
  sideTotals,
  termProducts,
  type CompareRequest,
  type Comparison,
} from '../src/cloud/compare';
import { comparisonPdfHtml, comparisonPdfName, type PdfInput } from '../src/cloud/comparePdf';
import { applyToJob, newJob, type CloudItem, type CloudJob, type CompareSide, type RetailerStatus, type TermResult } from '../src/cloud/jobs';
import { parseWalmartSearch } from '../src/cloud/walmart';
import { fakeBrowserUse, FakePage, makeRunner, memory, walmartFor } from './cloudKit';

// Phone vs. cloud as a PDF to share: what went wrong (in words, with the exact error), every product each side read
// lined up, the totals across runs, the PDF's HTML, and the findings kept with the runs. No live site, no credit.

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

const cloudItems: CloudItem[] = parseWalmartSearch(walmartFor('5260'), '5260').items;
const phoneItems = (): CloudItem[] => [
  ...cloudItems.filter((i) => i.itemId !== '15556052').map((i) => (i.itemId === '10450114' ? { ...i, price: 3.12 } : i)),
  { itemId: '999999991', name: 'Phone-only milk & <cream>', price: 2 },
];
const done = (term: string, items: CloudItem[], extra: Partial<TermResult> = {}): TermResult => ({ term, status: 'done', items, found: items.length, at: 10_000, ...extra });

type Step = { status: RetailerStatus | 'done'; results?: TermResult[]; reason?: string; detail?: string; storeSet?: boolean; started?: number; ended?: number };

/** A side's job with each store's searches and end. */
function side(id: string, req: CompareRequest, s: CompareSide, steps: Partial<Record<string, Step>>): CloudJob {
  let job: CloudJob = { ...newJob(comparisonJobs(req).find((x) => x.side === s)!.request, `${id}-${s}`, 1000), compare: { id, side: s } };
  for (const r of job.retailers) {
    const step = steps[r.retailerId];
    if (!step) continue;
    job = applyToJob(job, r.retailerId, { type: 'start', at: step.started ?? 1000 });
    if (step.storeSet) job = applyToJob(job, r.retailerId, { type: 'storeSet', how: s === 'agent' ? 'agent' : 'button' });
    for (const result of step.results ?? []) job = applyToJob(job, r.retailerId, { type: 'term', result });
    const at = step.ended ?? 20_000;
    if (step.status === 'interrupted') job = applyToJob(job, r.retailerId, { type: 'interrupt', reason: step.reason ?? 'app_slept', ...(step.detail ? { detail: step.detail } : {}), at });
    else if (step.status === 'cancelled') job = applyToJob(job, r.retailerId, { type: 'cancel', at });
    else if (step.status === 'done' || step.status === 'blocked' || step.status === 'failed') {
      job = applyToJob(job, r.retailerId, { type: 'finish', status: step.status, ...(step.reason ? { reason: step.reason } : {}), ...(step.detail ? { detail: step.detail } : {}), at });
    }
  }
  return job;
}

const both: CompareRequest = { terms: ['milk', 'eggs'], retailers: [{ retailerId: 'walmart', storeId: '5260' }, { retailerId: 'target', storeId: '1375' }], agent: true };

/** A run where a bit of everything went wrong. */
function troubled(): Comparison {
  const phone = side('c1', both, 'phone', {
    walmart: {
      status: 'done',
      results: [done('milk', phoneItems(), { storeMatches: true, pageStoreId: '5260', ms: 6000, bytes: 1_400_000 }), { term: 'eggs', status: 'blocked', items: [], reason: 'phone_check', detail: 'Robot or human? (HTTP 200)', at: 12_000, ms: 2000 }],
    },
    // The store's data didn't say which store it priced: not confirmed.
    target: { status: 'done', results: [done('milk', [{ itemId: '13276134', name: 'Whole Milk - 1gal', price: 3.69 }]), done('eggs', [])] },
  });
  const cloud = side('c1', both, 'scripted', {
    walmart: { status: 'failed', reason: 'timeout', detail: 'CdpTimeout: Page.navigate took over 60000 ms', storeSet: true, results: [done('milk', cloudItems, { storeMatches: true, pageStoreId: '5260', ms: 9000, bytes: 2_600_000 })] },
    target: { status: 'done', storeSet: true, results: [done('milk', [{ itemId: '13276134', name: 'Whole Milk - 1gal', price: 3.89 }], { storeMatches: false, pageStoreId: '2766' }), done('eggs', [], { storeMatches: true, pageStoreId: '1375' })] },
  });
  const agent = side('c1', both, 'agent', {
    walmart: { status: 'done', storeSet: true, results: [done('Milk', [{ itemId: 'https://www.walmart.com/ip/x/10450114', name: 'GV Whole Milk', price: 3.12 }], { storeMatches: true, pageStoreId: '5260' })] },
    target: { status: 'blocked', reason: 'challenge', detail: 'The agent answered {"blocked": true}' },
  });
  return comparisonOf([phone, cloud, agent], 'c1')!;
}

const when = (at: number) => `T+${Math.round(at / 1000)}s`;
const pdfInput = (list: Comparison[], extra: Partial<PdfInput> = {}): PdfInput => ({
  comparisons: list,
  scope: 'run',
  notes: { runs: {}, report: '' },
  madeAt: Date.UTC(2026, 8, 29, 18),
  device: 'iPhone',
  system: 'iOS 26.0',
  when,
  pageMargin: 40,
  ...extra,
});

(async () => {
  await t('what went wrong: a store’s end, each search, another store’s prices, an unconfirmed store; in words, with the exact error', () => {
    const c = troubled();
    const problems = comparisonProblems(c);
    assert.deepEqual(
      problems.map((p) => [p.retailerId, p.side, p.term ?? '', p.kind]),
      [
        ['walmart', 'phone', 'eggs', 'blocked'],
        ['walmart', 'scripted', '', 'failed'],
        ['target', 'phone', '', 'unconfirmed'],
        ['target', 'scripted', 'milk', 'other_store'],
        ['target', 'agent', '', 'blocked'],
      ],
    );
    assert.equal(problems[1].detail, 'CdpTimeout: Page.navigate took over 60000 ms', 'the exact error kept');
    assert.equal(problemLine(problems[1]), 'Walmart, cloud browser: Failed. A page took too long to load.');
    assert.equal(problemLine(problems[0]), 'Walmart, this phone, “eggs”: Blocked. A bot check on this phone (noted, not shown: nobody pressed it).');
    assert.match(problems[3].words, /priced store 2766, not 1375/);
    assert.equal(problems[2].words, 'the store’s data didn’t say which store its prices are for');
    // This phone's search cut off by the app leaving the screen isn't a cloud browser's dropped connection.
    assert.match(sideReasonWords('phone', 'app_slept'), /left the screen/);
    assert.match(sideReasonWords('scripted', 'app_slept'), /connection dropped/);
    // A store's end that only repeats its search's is said once.
    const failedPhone = side('c2', { ...both, agent: false, retailers: [both.retailers[0]] }, 'phone', {
      walmart: { status: 'failed', reason: 'device_failed', results: [{ term: 'milk', status: 'failed', items: [], reason: 'device_failed', detail: 'the page never loaded', at: 1 }] },
    });
    const c2 = comparisonOf([failedPhone], 'c2')!;
    assert.deepEqual(comparisonProblems(c2).map((p) => [p.term, p.detail]), [['milk', 'the page never loaded']]);
  });

  await t('every product side by side: this phone’s in its order, then the cloud’s own, then the agent’s; a price not this phone’s marked', () => {
    const c = troubled();
    const milk = termProducts(c, 'walmart', 'milk');
    assert.equal(milk.rows[0].key, phoneItems()[0].itemId.replace(/^0+/, ''));
    const gallon = milk.rows.find((r) => r.key === '10450114')!;
    assert.deepEqual([gallon.cells.phone?.price, gallon.cells.scripted?.price, gallon.cells.scripted?.differs, gallon.cells.agent?.price, gallon.cells.agent?.differs], [3.12, 3.32, true, 3.12, undefined]);
    assert.equal(milk.rows.find((r) => r.key === '999999991')?.cells.scripted, undefined, 'only this phone listed it');
    assert.equal(milk.rows[milk.rows.length - 1].key, '15556052', 'only the cloud browser listed it: after this phone’s');
    assert.equal(milk.rows.filter((r) => Object.values(r.cells).some((x) => x?.differs)).length, 1);
    assert.deepEqual(Object.keys(milk.results).sort(), ['agent', 'phone', 'scripted'], 'the agent’s “Milk” is the same search');
    assert.deepEqual(termProducts(c, 'target', 'milk').rows[0].cells.scripted, { price: 3.89, differs: true });
  });

  await t('totals across runs: stores with prices, same price, the medians of a run, setting up and a search; data and cost summed', () => {
    const one: CompareRequest = { terms: ['milk'], retailers: [{ retailerId: 'walmart', storeId: '5260' }], agent: false };
    const run = (id: string, cloudMs: number, price: number) => [
      side(id, one, 'phone', { walmart: { status: 'done', results: [done('milk', phoneItems(), { storeMatches: true, pageStoreId: '5260', ms: 5000, bytes: 1_000_000, at: 6000 })], started: 1000, ended: 6000 } }),
      side(id, one, 'scripted', {
        walmart: { status: 'done', storeSet: true, started: 1000, ended: 1000 + cloudMs, results: [done('milk', cloudItems.map((i) => (i.itemId === '10450114' ? { ...i, price } : i)), { storeMatches: true, pageStoreId: '5260', ms: 9000, bytes: 2_600_000, at: 1000 + cloudMs })] },
      }),
    ];
    const list = [comparisonOf(run('r1', 30_000, 3.12), 'r1')!, comparisonOf(run('r2', 40_000, 3.32), 'r2')!];
    const [phone, cloud] = sideTotals(list);
    assert.deepEqual([phone.side, phone.runs, phone.withPrices, phone.stores, phone.runMs, phone.searchMs, phone.phoneBytes, phone.usd], ['phone', 2, 2, 2, 5000, 5000, 2_000_000, 0]);
    assert.deepEqual([cloud.side, cloud.withPrices, cloud.both, cloud.same, cloud.runMs, cloud.setupMs, cloud.searchMs], ['scripted', 2, 26, 25, 35_000, 26_000, 9000]);
  });

  await t('the PDF: its title, the findings, at a glance, each store side by side, every product (≠ where it differs), what went wrong with the exact error', () => {
    const c = troubled();
    const html = comparisonPdfHtml(pdfInput([c], { notes: { runs: { c1: 'Cloud was 5× slower <b>here</b>' }, report: '' } }));
    for (const part of [
      '<h1>“milk”, “eggs”</h1>',
      'Made on this iPhone (iOS 26.0)',
      '<h3>Findings</h3><p>Cloud was 5× slower &lt;b&gt;here&lt;/b&gt;</p>',
      '<h2>At a glance</h2>',
      '<th>This phone</th><th>Cloud browser</th><th>AI agent</th>',
      '<h3>Walmart · store 5260</h3>',
      '<h3>What went wrong</h3>',
      'Exact error:</span> <code>CdpTimeout: Page.navigate took over 60000 ms</code>',
      '<td class="differs">≠ $3.32</td>',
      'Phone-only milk &amp; &lt;cream&gt;',
      '<h2>How it was measured</h2>',
      '@page { size: 612px 792px; margin: 40px; }',
    ]) {
      assert.ok(html.includes(part), `missing: ${part}`);
    }
    assert.ok(!html.includes('class="run newpage"'), 'one run: no page of its own for it');
    assert.ok(!html.includes('<b>here</b>'), 'what the user wrote is escaped');
    assert.ok(comparisonPdfHtml(pdfInput([c], { pageMargin: 0 })).includes('margin: 0px; }'), 'iOS: the printing adds the margins');
    // Only base64 goes into the style sheet.
    assert.ok(comparisonPdfHtml(pdfInput([c], { displayFont: 'AAEC' })).includes('base64,AAEC'));
    assert.ok(!comparisonPdfHtml(pdfInput([c], { displayFont: 'x") } body { color: red' })).includes('@font-face'));
  });

  await t('the PDF as a server would have it: the cloud browser’s times estimated beside those measured, the results as this phone’s data, the test’s own link left out', () => {
    const one: CompareRequest = { terms: ['milk'], retailers: [{ retailerId: 'target', storeId: '1072' }], agent: false };
    const milk = [
      { itemId: '1', name: 'Milk 1', price: 3.49 },
      { itemId: '2', name: 'Milk 2', price: 3.29 },
    ];
    const phone = side('s1', one, 'phone', { target: { status: 'done', results: [done('milk', milk, { storeMatches: true, pageStoreId: '1072', ms: 5000, bytes: 900_000, at: 6000 })], started: 1000, ended: 6000 } });
    let cloud: CloudJob = { ...newJob(comparisonJobs(one).find((x) => x.side === 'scripted')!.request, 's1-scripted', 1000), compare: { id: 's1', side: 'scripted' } };
    cloud = applyToJob(cloud, 'target', { type: 'start', at: 1000 });
    cloud = applyToJob(cloud, 'target', { type: 'storeSet', how: 'cookie', linkMs: 4000, picked: '2930' });
    const read = [milk[0], { ...milk[1], price: 2.99, pricedAt: '1086' }];
    cloud = applyToJob(cloud, 'target', { type: 'term', result: done('milk', read, { storeMatches: true, pageStoreId: '1072', ms: 12_000, linkMs: 5000, at: 31_000 }) });
    cloud = applyToJob(cloud, 'target', { type: 'bytes', bytes: 2_000_000, wireBytes: 9_000_000, linkMs: 9000, rttMs: 150, commands: 30 });
    cloud = applyToJob(cloud, 'target', { type: 'finish', status: 'done', at: 31_000 });
    const c = comparisonOf([phone, cloud], 's1')!;
    const html = comparisonPdfHtml(pdfInput([c]));
    for (const part of [
      // 30 s from this phone, 9 s of it the link's: about 21 s on a server. Setting up 18 s (4 s the link's); the search 12 s (5 s).
      '21 s <span class="tag">Server estimate</span><br><span class="small">30 s measured from this phone</span>',
      '14 s <span class="tag">Server estimate</span><br><span class="small">18 s measured from this phone</span>',
      '7 s <span class="tag">Server estimate</span><br><span class="small">12 s measured from this phone</span>',
      '<td class="label">Left out: driving it from this phone</td><td class=""><span class="dash">–</span></td><td class="">9.0 MB, 9 s</td>',
      ' of results</td>',
      '<td class="">Set in its store cookies (the site had picked 2930)</td>',
      '<td class="elsewhere">$2.99<br><span class="small">store 1086’s price</span></td>',
      'Some prices another store’s',
      '1 more on both was priced for another store, and not compared.',
      'about 7 s on a server',
    ]) {
      assert.ok(html.includes(part), `missing: ${part}`);
    }
  });

  await t('every run’s PDF: the report’s findings, the totals, a table of the runs, then each run on a page of its own; its file’s name', () => {
    const c = troubled();
    const one: CompareRequest = { terms: ['bread'], retailers: [{ retailerId: 'walmart', storeId: '5260' }], agent: false };
    const quiet = comparisonOf(
      [
        side('c0', one, 'phone', { walmart: { status: 'done', results: [done('bread', [], { storeMatches: true, pageStoreId: '5260' })] } }),
        side('c0', one, 'scripted', { walmart: { status: 'done', storeSet: true, results: [done('bread', [], { storeMatches: true, pageStoreId: '5260' })] } }),
      ],
      'c0',
    )!;
    const html = comparisonPdfHtml(pdfInput([c, quiet], { scope: 'all', notes: { runs: { c1: 'first run notes' }, report: 'What the team should know' } }));
    for (const part of ['<h1>2 runs</h1>', '<h3>Findings</h3><p>What the team should know</p>', '<h2>The runs</h2>', '<h2>Run 1: “milk”, “eggs”</h2>', '<h2>Run 2: “bread”</h2>', 'first run notes', '<td>Runs</td>'.replace('<td>', '<td class="label">')]) {
      assert.ok(html.includes(part), `missing: ${part}`);
    }
    assert.equal(html.match(/class="run newpage"/g)?.length, 2, 'each run on a page of its own');
    const d = new Date(Date.UTC(2026, 8, 29, 18));
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    assert.equal(comparisonPdfName({ comparisons: [c, quiet], scope: 'all', madeAt: d.getTime() }), `Phone vs cloud - 2 runs - ${day}.pdf`);
    assert.equal(comparisonPdfName({ comparisons: [c], scope: 'run', madeAt: d.getTime() }), `Phone vs cloud - milk, eggs - ${day}.pdf`);
    const odd = { ...c, terms: ['half/half: 2%?'] };
    assert.equal(comparisonPdfName({ comparisons: [odd], scope: 'run', madeAt: d.getTime() }), `Phone vs cloud - half half 2% - ${day}.pdf`);
  });

  await t('findings: kept with their run and saved; a run removed takes its findings with it; Forget clears them all', async () => {
    const disk = memory();
    const one: CompareRequest = { terms: ['milk'], retailers: [{ retailerId: 'walmart', storeId: '5260' }], agent: false };
    const jobs = [side('k1', one, 'phone', { walmart: { status: 'done', results: [done('milk', [])] } }), side('k1', one, 'scripted', { walmart: { status: 'done', results: [done('milk', [])] } })];
    await disk.setItem('stretch.cloud.v1', JSON.stringify({ v: 1, jobs, orphans: [] }));
    const api = fakeBrowserUse();
    const first = makeRunner(api, () => new FakePage()).runner;
    await first.hydrate(disk);
    first.setNotes('k1', 'Walmart matched');
    first.setNotes(undefined, 'For the team');
    first.setNotes('gone', 'a run no longer on the phone');
    await first.flush();
    const second = makeRunner(api, () => new FakePage()).runner;
    await second.hydrate(disk);
    assert.deepEqual([second.getNotes('k1'), second.getNotes(), second.getNotes('gone')], ['Walmart matched', 'For the team', '']);
    second.removeComparison('k1');
    await second.flush();
    assert.equal(second.getNotes('k1'), '');
    assert.equal(JSON.parse(disk.map.get('stretch.cloud.v1')!).notes.report, 'For the team', 'the report’s own findings stay');
    await second.clear();
    assert.deepEqual([second.getNotes(), JSON.parse(disk.map.get('stretch.cloud.v1')!).notes], ['', undefined], 'nothing written: no findings kept');
  });

  finished = true;
  console.log(`\n${passed} phone vs. cloud PDF tests passed`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
