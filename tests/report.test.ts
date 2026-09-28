/// <reference types="node" />
import assert from 'node:assert/strict';
import { countsInHealth, type AttemptEntry } from '../src/onDevice/attemptLog';
import type { CoverageState, CoverageStatus } from '../src/onDevice/coverage';
import { DEFAULT_INPUTS, ESTIMATED, measuredFrom, monthlyCost } from '../src/pricing/costModel';
import { buildReport, reportFileName, TABLE_ROWS, zipArea, type Report, type ReportInput, type ReportLine, type SectionId } from '../src/pricing/report';
import { BASE_PX, esc, FLOOR_PX, PAGE, reportHtml } from '../src/pricing/reportHtml';
import type { Scorecard, StoreScore } from '../src/pricing/scorecard';
import { TruthBook, type TruthRecord } from '../src/pricing/truth';

let passed = 0;
const t = async (name: string, fn: () => unknown) => { await fn(); passed++; console.log('ok -', name); };

// Local times, so the words are the same in any time zone.
const NOW = new Date(2026, 8, 27, 22, 41).getTime();
const H = 60 * 60_000;
const D = 24 * H;
const STORES = [
  { id: 'walmart', name: 'Walmart' },
  { id: 'target', name: 'Target' },
  { id: 'kroger', name: 'Kroger' },
  { id: 'aldi', name: 'ALDI' },
  { id: 'heb', name: 'H-E-B' },
  { id: 'costco', name: 'Costco' },
  { id: 'meijer', name: 'Meijer' },
];

const search = (retailerId: string, at: number, ok: boolean, extra: Partial<AttemptEntry> = {}): AttemptEntry => ({
  at, retailerId, kind: 'search', strategy: 'webview', ok, ms: 1000, bytes: 100_000, rules: 'v1', ...(ok ? {} : { reason: 'timeout' }), ...extra,
});

/**
 * A week's log: Walmart (one of 10 failed), Target (reusing its page), Kroger through its API and refused once on its
 * site, ALDI once, H-E-B's two bot checks; and what Store health leaves out.
 */
function week(): AttemptEntry[] {
  const out: AttemptEntry[] = [];
  for (let i = 0; i < 10; i++) {
    out.push(search('walmart', NOW - i * 3 * H, i !== 3, { ms: 2000 + i * 100, bytes: 1_000_000, strategy: i % 2 ? 'fetch' : 'webview' }));
    out.push(search('target', NOW - i * 3 * H - 60_000, true, { ms: 1200, via: i ? 'replay' : 'page' }));
    out.push(search('kroger', NOW - i * 3 * H - 120_000, true, { ms: 1400, bytes: 40_000, strategy: 'api' }));
  }
  out.push(search('aldi', NOW - 2 * D, true, { ms: 2200, bytes: 13_000_000 }));
  out.push(search('heb', NOW - D, false, { reason: 'challenge' }), search('heb', NOW - D + 60_000, false, { reason: 'challenge_timeout' }), search('heb', NOW - D + 2 * 60_000, true));
  // Not in Store health's rates: a store finder, the phone vs. server test, a cool-down's note, and a search 8 days ago.
  out.push({ at: NOW - H, retailerId: 'walmart', kind: 'store', ok: true, ms: 500 });
  out.push({ ...search('meijer', NOW - H, false), kind: 'versus' });
  out.push({ at: NOW - 2 * D, retailerId: 'kroger', kind: 'cooldown', ok: false, reason: 'refused', ms: 0, until: NOW - 2 * D + 10 * 60_000 });
  out.push(search('walmart', NOW - 8 * D, false));
  return out.sort((a, b) => a.at - b.at);
}

function checked(verdicts: Record<string, CoverageStatus>, extra: Partial<CoverageState> = {}): CoverageState {
  const stores = STORES.map((s) => ({ retailerId: s.id, name: s.name }));
  return {
    query: 'milk',
    running: false,
    startedAt: NOW - 30 * 60_000,
    finishedAt: NOW - 28 * 60_000,
    stores,
    rows: Object.fromEntries(stores.map((s) => [s.retailerId, { ...s, status: verdicts[s.retailerId] ?? 'works', products: 24, ms: 1500, at: NOW - 29 * 60_000 }])),
    checking: [],
    ...extra,
  };
}

const score = (retailerId: string, name: string, totalMs: number, parts: Partial<StoreScore> = {}): StoreScore => ({
  retailerId, name, searches: 6, ok: 6, failed: 0, products: 72, firstMs: 700, totalMs, medianMs: 1200,
  pageLoads: 1, reused: 5, api: 0, direct: 0, saved: 0, shared: 0, bytes: 1_000_000, bytesSaved: 0, ...parts,
});
function card(stores: StoreScore[], totalMs = 10_900): Scorecard {
  const sum = (key: 'searches' | 'ok' | 'failed' | 'products' | 'bytes') => stores.reduce((n, s) => n + s[key], 0);
  return {
    stores, searches: sum('searches'), ok: sum('ok'), failed: sum('failed'), products: sum('products'), storesSearched: stores.filter((s) => s.searches).length,
    bytes: sum('bytes'), bytesSaved: 0, shared: 0, totalMs, firstMs: 700,
  };
}
const SPEED = card([
  score('walmart', 'Walmart', 10_300),
  score('target', 'Target', 3_400),
  score('kroger', 'Kroger', 2_300, { pageLoads: 0, reused: 0, api: 6, bytes: 120_000 }),
  score('aldi', 'ALDI', 4_300, { bytes: 13_000_000 }),
]);

const TRUTH: TruthRecord = {
  at: NOW - H,
  perStore: 3,
  summary: {
    checked: 12, same: 11, different: 1, unreadable: 1, rate: 11 / 12,
    byStore: { walmart: { same: 3, checked: 3 }, target: { same: 2, checked: 3 }, kroger: { same: 3, checked: 3 }, aldi: { same: 3, checked: 3 } },
  },
};

function input(extra: Partial<ReportInput> = {}): ReportInput {
  return {
    now: NOW,
    device: 'iPhone',
    system: 'iOS 26.0',
    zip: '10016',
    rules: { version: 'bundled-2026-09-25', source: 'bundled' },
    stores: STORES,
    compared: ['walmart', 'target', 'kroger', 'aldi'],
    entries: week(),
    coverage: checked({ kroger: 'bot_check', heb: 'bot_check', meijer: 'no_products', costco: 'slow' }),
    speed: { card: SPEED, at: NOW - 40 * 60_000, items: 6, kind: 'cold' },
    lists: [{ items: 8, at: NOW - 2 * H, card: card([score('walmart', 'Walmart', 5000, { searches: 8, ok: 8, bytes: 2_100_000 })]) }],
    truth: TRUTH,
    versus: {
      at: NOW - D,
      summary: { tried: 13, plain: { prices: 3, blocked: 6, bytes: 0 }, browser: { prices: 11, blocked: 1, bytes: 0 }, paused: 0, cooling: 0, datacenter: { stores: 13, blocked: 5, noPrices: 6, loaded: 2 } },
    },
    ...extra,
  };
}

/** Nothing measured yet: a first launch. */
const nothing = (): ReportInput => ({
  now: NOW, device: 'iPhone', zip: '', rules: { version: 'bundled-2026-09-25', source: 'bundled' }, stores: STORES, compared: ['walmart', 'target'], entries: [],
  coverage: { query: 'milk', running: false, stores: [], rows: {}, checking: [] },
});

const section = (r: Report, id: SectionId) => r.sections.find((s) => s.id === id)!;
/** A section's words as printed: every run of every line, a line each. */
const words = (lines: ReportLine[]) => lines.map((l) => [l, ...(l.more ?? [])].map((x) => `${x.lead ?? ''} ${x.text}`.trim()).join(' ')).join('\n');
const said = (r: Report, id: SectionId) => words(section(r, id).lines);
/** Every figure's basis, by what it says. */
const bases = (lines: ReportLine[]) => lines.flatMap((l) => [l, ...(l.more ?? [])]).filter((x) => x.basis).map((x) => [x.basis, `${x.lead ?? ''} ${x.text}`.trim()]);

(async () => {
  await t('the ZIP code’s area, never the code; the file’s name; which searches Store health counts', () => {
    assert.deepEqual([zipArea('10016'), zipArea(' 94103 '), zipArea(''), zipArea('1001'), zipArea('10016-1234'), zipArea('ABCDE')], ['100xx', '941xx', undefined, undefined, undefined, undefined]);
    assert.equal(reportFileName(new Date(2026, 0, 5, 9, 3).getTime()), 'Stretch results 2026-01-05.pdf');
    assert.deepEqual(
      (['search', 'coverage', 'product', 'versus', 'store', 'fees', 'ad', 'cooldown', 'connection'] as const).map((kind) => countsInHealth({ kind })),
      [true, true, true, false, false, false, false, false, false],
    );
  });

  await t('report: when, the ZIP code’s area (never the code), which rules, and the headline figures', () => {
    const r = buildReport(input());
    assert.equal(r.title, 'Grocery prices, read on the phone');
    assert.equal(r.meta[0], 'Results from this iPhone (iOS 26.0)');
    assert.match(r.meta[1], /^made Sep 27, 2026, 10:41\sPM$/);
    assert.deepEqual(r.meta.slice(2), ['ZIP area 100xx', 'store rules bundled-2026-09-25, built into the app']);
    assert.ok(!JSON.stringify(r).includes('10016'), 'the ZIP code itself is nowhere in it');
    assert.equal(r.fileName, 'Stretch results 2026-09-27.pdf');
    assert.deepEqual(buildReport(input({ zip: '', rules: { version: 'fixed-1', source: 'served' } })).meta.slice(2), ['no ZIP code set', 'store rules fixed-1, from a rules file']);

    const [stores, rate, speed, truth, cost] = r.stats;
    assert.deepEqual([stores.value, stores.label], ['3 of 7', 'stores work from this iPhone, in the store check']);
    // 34 searches in the week, not counting the store finder, the phone vs. server test, the note or 8 days ago: 31 worked.
    assert.deepEqual([rate.value, rate.label], ['91%', 'of 34 searches worked, the last 7 days']);
    assert.deepEqual([speed.value, speed.label], ['10.9 s', 'to price 6 items at 4 stores, from cold, in the speed test']);
    assert.deepEqual([truth.value, truth.label], ['11 of 12', 'prices matched; 1 of 13 product pages couldn’t be read'], 'the pages it couldn’t read, said');
    // The average search: 23.5 MB over 31 that worked, 758 KB; about $255,000 a month at the defaults, to three figures.
    assert.equal(Math.round(monthlyCost(DEFAULT_INPUTS, measuredFrom(input().entries)).total), 255_030);
    assert.deepEqual([cost.value, cost.label, cost.basis], ['$255,000', 'a month from servers for 100k users; on phones, $0', 'estimate']);
    assert.ok(r.stats.every((s) => !s.none));
  });

  await t('report: which stores work, grouped by what the store check found', () => {
    const r = buildReport(input());
    const lines = said(r, 'stores').split('\n');
    assert.match(lines[0], /^3 of 7 stores work from this iPhone\. The store check searched “milk” once at each store, four at a time, Sep 27, 10:13\sPM\.$/);
    assert.equal(lines[1], 'Works (3): Walmart, Target, ALDI.');
    assert.equal(lines[2], 'Bot check or blocked (2): Kroger, H-E-B. No products came back (1): Meijer. Too slow (1): Costco.', 'the rest in one paragraph');
    assert.match(section(r, 'stores').summary, /^3 of 7 stores work, checked Sep 27, 10:13\sPM\.$/);
    assert.match(said(buildReport(input({ coverage: checked({}, { running: true }) })), 'stores'), /, and was still going\./);
    const none = buildReport(nothing());
    assert.equal(section(none, 'stores').has, false);
    assert.match(said(none, 'stores'), /hasn’t run on this iPhone yet: Store health → Check all stores/);
  });

  await t('report: store by store, the compared stores first, each with its week, its busiest hour and its speed test', () => {
    const r = buildReport(input());
    const row = (id: string) => r.table.rows.find((x) => x.retailerId === id)!;
    assert.deepEqual(r.table.rows.map((x) => x.name), ['Walmart', 'Target', 'Kroger', 'ALDI', 'H-E-B'], 'compared, then others searched this week; Meijer’s only try was the phone vs. server test');
    assert.deepEqual(row('walmart'), { retailerId: 'walmart', name: 'Walmart', check: '✓ Works', searches: 10, worked: '90%', median: '2.5 s', botChecks: 0, busiest: '1 of 120', data: '10\u00a0MB', speed: '10.3 s' });
    assert.deepEqual(row('kroger'), { retailerId: 'kroger', name: 'Kroger', check: '✗ Blocked', searches: 10, worked: '100%', median: '1.4 s', botChecks: 0, busiest: '1 of 120', data: '400\u00a0KB', speed: '2.3 s' });
    assert.deepEqual(row('heb'), { retailerId: 'heb', name: 'H-E-B', check: '✗ Blocked', searches: 3, worked: '33%', median: '1.0 s', botChecks: 2, busiest: '3 of 120', data: '300\u00a0KB' });
    assert.equal(r.table.speedItems, 6);
    assert.equal(r.table.more, 0);
    assert.match(
      r.table.caption,
      /^Last 7 days: Sep 20 to Sep 27\. .*Blocked: a bot check or a refusal\. Speed test: each store’s 6 searches, start to finish\. The other 2 stores in the store check are in the list above\.$/,
      'Costco and Meijer: in the store check, and nothing else',
    );
    assert.match(section(r, 'table').summary, /^34 searches at 5 stores in the last 7 days: 91% worked, 1\.4 s each in the middle\.$/);

    // Too many for the page: the busiest first, and the rest counted.
    const few = buildReport(input({ maxRows: 3 }));
    assert.deepEqual([few.table.rows.map((x) => x.retailerId), few.table.more], [['walmart', 'target', 'kroger'], 2]);
    assert.match(few.table.caption, /2 more stores with fewer searches aren’t shown: see Store health\. The other 2 stores in the store check are in the list above\.$/);
    // 15 stores searched this week, none compared: the 12 most searched, most first.
    const many = Array.from({ length: 15 }, (_, i) => ({ id: `s${i}`, name: `Store ${i}` }));
    const busy = buildReport(
      input({ stores: many, compared: [], coverage: nothing().coverage, speed: undefined, entries: many.flatMap((s, i) => Array.from({ length: i + 1 }, (_, k) => search(s.id, NOW - k * H, true))) }),
    );
    assert.deepEqual([busy.table.rows.length, busy.table.more, busy.table.rows[0].name, busy.table.rows[11].name], [TABLE_ROWS, 3, 'Store 14', 'Store 3']);
    // No speed test: no column for it.
    const slow = buildReport(input({ speed: undefined }));
    assert.equal(slow.table.speedItems, undefined);
    assert.ok(slow.table.rows.every((x) => x.speed === undefined));
  });

  await t('report: speed and data per list, from the speed test, lists priced since the app opened, and the week', () => {
    const r = buildReport(input());
    assert.match(
      said(r, 'speed'),
      /^6 items at 4 stores in 10\.9 s, from cold \(every store’s page loaded first, as after opening the app\) in the speed test, Sep 27, 10:01\sPM\. 24 of 24 searches worked \(3 page loads, 15 sent from a page already open, 6 through an official API\), and the first price came after 0\.7 s\.\nOver the last 7 days, a search that worked took 1\.4 s in the middle \(of 31\)\.$/,
    );
    // 15.1 MB for the speed test; 758 KB a search over the week's 31 that worked (23.5 MB), 80 of them to a 20-item list.
    assert.match(
      said(r, 'data'),
      /^The speed test: about 15\u00a0MB for 6 items at 4 stores \(24 searches, from cold\)\.\nAn 8-item list at 1 store: about 2\.1\u00a0MB \(8 searches, Sep 27, 8:41\sPM\)\.\nAbout 758\u00a0KB a search over this iPhone’s last 31 searches that worked, not counting the store check, so a 20-item list at 4 stores takes about 61\u00a0MB\.$/,
    );
    assert.deepEqual(bases(section(r, 'data').lines), [['estimate', 'so a 20-item list at 4 stores takes about 61\u00a0MB.']], 'only the typical list is an estimate');
    // Warm, and no speed test at all: the week's median stands in for it at the top.
    assert.match(said(buildReport(input({ speed: { card: SPEED, at: NOW - H, items: 6, kind: 'warm' } })), 'speed'), /^6 items at 4 stores in 10\.9 s, pages kept warm in the speed test/);
    const none = buildReport(input({ speed: undefined, lists: [] }));
    assert.deepEqual([none.stats[2].value, none.stats[2].label], ['1.4 s', 'a search, in the middle, the last 7 days']);
    assert.match(said(none, 'speed'), /^No speed test since the app opened: Diagnostics → Speed test/);
    // A speed test still running doesn't count.
    assert.equal(buildReport(input({ speed: { card: { ...SPEED, totalMs: undefined }, at: NOW, items: 6 } })).stats[2].value, '1.4 s');
  });

  await t('report: the truth check’s match rate, store by store; a check that read nothing; none yet', () => {
    const r = buildReport(input());
    assert.match(
      said(r, 'truth'),
      /^12 of 13 product pages could be read, and 11 of those 12 prices matched \(92%\)\. Each is a search’s price read again on the product’s own page on the store’s site, 3 per store, Sep 27, 9:41\sPM: Walmart 3 of 3 · Target 2 of 3 · Kroger 3 of 3 · ALDI 3 of 3\. A page with no price the phone could read isn’t counted\.\nA product page can be for another store than the search, or a price can change in between\.$/,
    );
    assert.match(section(r, 'truth').summary, /^12 of 13 product pages read; 11 of 12 prices matched \(Sep 27, 9:41\sPM\)\.$/);
    // It read 1 page of 6: said first, not a bare "1 of 1".
    const thin = buildReport(input({ truth: { at: NOW - H, perStore: 3, summary: { checked: 1, same: 1, different: 0, unreadable: 5, rate: 1, byStore: { walmart: { same: 1, checked: 1 }, target: { same: 0, checked: 0 } } } } }));
    assert.deepEqual([thin.stats[3].value, thin.stats[3].label], ['1 of 1', 'prices matched; 5 of 6 product pages couldn’t be read']);
    assert.match(said(thin, 'truth'), /^1 of 6 product pages could be read, and its price matched\. Each is a search’s price read again .*: Walmart 1 of 1\. A page with no price the phone could read isn’t counted\.$/);
    // Every page read: the rate alone, as before.
    const all = buildReport(input({ truth: { at: NOW - H, perStore: 3, summary: { checked: 3, same: 3, different: 0, unreadable: 0, rate: 1, byStore: { walmart: { same: 3, checked: 3 } } } } }));
    assert.equal(all.stats[3].label, 'prices matched the product’s own page, in the truth check');
    assert.match(said(all, 'truth'), /^3 of 3 prices matched \(100%\) the product’s own page on the store’s site, each read again, 3 per store, Sep 27, 9:41\sPM\. Walmart 3 of 3\.$/);
    const unread = buildReport(input({ truth: { at: NOW - H, perStore: 3, summary: { checked: 0, same: 0, different: 0, unreadable: 6, byStore: { walmart: { same: 0, checked: 0 } } } } }));
    assert.deepEqual([unread.stats[3].value, unread.stats[3].label, unread.stats[3].none], ['—', 'No product page could be read', true]);
    assert.match(said(unread, 'truth'), /couldn’t read a price on any of the 6 product pages it opened\.$/);
    const none = buildReport(input({ truth: undefined }));
    assert.deepEqual([none.stats[3].label, section(none, 'truth').has], ['Price truth check not run yet', false]);
    assert.match(said(none, 'truth'), /Find a store → Are these prices right\?/);
  });

  await t('report: bot checks and blocks, the hourly limit, and the phone vs. server test', () => {
    const r = buildReport(input());
    assert.equal(
      said(r, 'blocks'),
      [
        '2 bot checks in 34 searches over the last 7 days: H-E-B 2. The app never answers one itself. Kroger refused this iPhone outright once, and was left alone to cool down before it was tried again.',
        'Phone vs. server, Sep 26: From a plain request: 3 of 13 stores gave prices. From this iPhone’s browser: 11 of 13. Blocked (a bot check, a refusal or an empty page): the plain request at 6 stores, the browser at 1.',
      ].join('\n'),
    );
    assert.equal(
      said(r, 'limit'),
      [
        'At most 120 visits an hour at one store, and one page load at a time: the app’s own limit, at about a person’s pace. The busiest hour in the last 7 days: 3 visits at H-E-B, 3% of the limit.',
        // The phone vs. server test's try counts here, and Walmart's store finder is another page.
        'All it asked of the stores in those days: 16 full page loads, 9 searches sent from a page already open, 10 official API calls, 1 other page (products, fees, weekly ads, coupons).',
      ].join('\n'),
    );
    const calm = buildReport(input({ entries: week().filter((e) => e.retailerId !== 'heb' && e.kind !== 'cooldown'), versus: undefined }));
    assert.match(said(calm, 'blocks'), /^No bot checks in 31 searches over the last 7 days\. The app never answers one itself\. No store refused this iPhone outright\.$/);
    const none = buildReport(nothing());
    assert.deepEqual([section(none, 'blocks').has, section(none, 'limit').has], [false, false]);
    assert.match(said(none, 'limit'), /Nothing was asked of any store in the last 7 days\.$/);
  });

  await t('report: what servers would cost, each figure said to be measured, an estimate or an assumption', () => {
    const r = buildReport(input());
    const month = monthlyCost(DEFAULT_INPUTS, measuredFrom(input().entries));
    assert.deepEqual([Math.round(month.proxy), Math.round(month.solving), Math.round(month.browsers)], [210_237, 41_600, 3_193]);
    assert.equal(
      said(r, 'cost'),
      [
        // 693 searches a phone a month at 758 KB each.
        'From servers: about $255,000 a month for 100,000 users: proxies $210,000, bot checks solved $41,600, browsers $3,190. On phones: $0 to Stretch; each phone uses about 526\u00a0MB of its data a month.',
        'Worked out from this iPhone’s average search (758\u00a0KB, 1.7 s) and: 2 lists a week per user, of 20 items at 4 stores; residential proxies at $4 a GB; 30% of server searches meet a bot check, solved at $2 per 1,000; headless browsers at 10¢ an hour. Building and running servers isn’t counted.',
      ].join('\n'),
    );
    assert.deepEqual(
      bases(section(r, 'cost').lines).map(([basis]) => basis),
      ['estimate', 'estimate', 'assumption'],
      'the costs are estimates and the prices assumptions; the phone’s own averages are measured',
    );
    // Nothing measured: the starting estimates, said to be.
    const none = buildReport(nothing());
    assert.match(said(none, 'cost'), new RegExp(`Worked out from the app’s starting estimate of a search \\(250\u00a0KB, 2\\.5 s: this iPhone hasn’t measured enough yet\\) and:`));
    assert.equal(bases(section(none, 'cost').lines)[2][0], 'estimate');
    assert.match(said(none, 'data'), /^At the app’s starting estimate of 250\u00a0KB a search, a 20-item list at 4 stores takes about 20\u00a0MB: this iPhone hasn’t measured enough searches yet\.$/);
    assert.equal(ESTIMATED.bytesPerSearch, 250_000);
    // The model's own inputs, when given.
    assert.match(buildReport(input({ cost: { ...DEFAULT_INPUTS, users: 1_000_000 } })).stats[4].label, /for 1M users/);
  });

  await t('report: a first launch says what’s missing and how to measure it, section by section', () => {
    const r = buildReport(nothing());
    assert.deepEqual(r.stats.map((s) => [s.value, !!s.none]), [['—', true], ['—', true], ['—', true], ['—', true], ['$116,000', false]]);
    assert.deepEqual(
      r.sections.map((s) => [s.id, s.has]),
      [['stores', false], ['table', false], ['speed', false], ['data', false], ['truth', false], ['blocks', false], ['limit', false], ['cost', false]],
      'even the servers’ cost: it’s from the starting estimates until the phone has searched',
    );
    assert.equal(section(r, 'cost').summary, 'About $116,000 a month for 100k users, from starting estimates: search a few times first.');
    assert.deepEqual(r.table.rows.map((x) => [x.name, x.searches, x.worked, x.check]), [['Walmart', 0, undefined, undefined], ['Target', 0, undefined, undefined]]);
    assert.equal(r.meta[0], 'Results from this iPhone');
    assert.match(section(r, 'speed').summary, /Diagnostics → Speed test/);
    assert.deepEqual(bases(r.notes).map(([b]) => b), ['estimate', 'assumption']);
    assert.match(words(r.notes), /^Where these numbers come from\. Measured on this iPhone: the store check;/);
  });

  await t('report: the store check says why stores didn’t work; too few products isn’t working; no store near isn’t a failure', () => {
    const names = [...STORES, { id: 'ralphs', name: 'Ralphs' }, { id: 'fredmeyer', name: 'Fred Meyer' }, { id: 'sprouts', name: 'Sprouts' }, { id: 'wholefoods', name: 'Whole Foods' }, { id: 'traderjoes', name: 'Trader Joe’s' }];
    const row = (id: string, status: CoverageStatus, extra: { reason?: string; products?: number } = {}) => ({
      retailerId: id, name: names.find((n) => n.id === id)!.name, status, products: 24, ms: 1500, at: NOW - 29 * 60_000, ...extra,
    });
    const rows = [
      row('walmart', 'works'),
      row('ralphs', 'no_store', { reason: 'kroger_no_store_near_zip', products: 0 }),
      row('fredmeyer', 'no_store', { reason: 'kroger_no_store_near_zip', products: 0 }),
      row('kroger', 'failed', { reason: 'kroger_products_http_503', products: 0 }),
      row('meijer', 'few', { products: 1 }),
      row('sprouts', 'few', { products: 2 }),
      row('costco', 'no_products', { reason: 'no_payload', products: 0 }),
      row('wholefoods', 'no_products', { reason: 'no_payload', products: 0 }),
      row('heb', 'bot_check', { reason: 'challenge', products: 0 }),
      row('traderjoes', 'bot_check', { reason: 'http_403', products: 0 }),
      row('aldi', 'slow', { reason: 'timeout', products: 0 }),
    ];
    const coverage: CoverageState = { ...checked({}), stores: rows.map((r) => ({ retailerId: r.retailerId, name: r.name })), rows: Object.fromEntries(rows.map((r) => [r.retailerId, r])) };
    const r = buildReport(input({ stores: names, compared: ['walmart', 'kroger', 'meijer', 'ralphs'], coverage }));
    const lines = said(r, 'stores').split('\n');
    assert.match(lines[0], /^1 of 9 stores work from this iPhone\. The store check searched “milk” once at each store, four at a time, Sep 27, 10:13\sPM; stores with none near the ZIP code aren’t counted\.$/);
    assert.equal(lines[1], 'Works (1): Walmart.');
    assert.equal(
      lines[2],
      'Too few products (2): Meijer (1), Sprouts (2): 2 products or fewer each, more likely a featured product than the search’s results. ' +
        'Bot check or blocked (2): H-E-B (a bot check), Trader Joe’s (HTTP 403). ' +
        'No products came back (2): Costco, Whole Foods: no product data. ' +
        'Too slow (1): ALDI. ' +
        'Failed (1): Kroger: Kroger’s API was busy (503), twice. ' +
        'No store near you (2): Ralphs, Fred Meyer: Kroger’s API found none of their stores near the ZIP code, so they weren’t searched.',
    );
    assert.deepEqual([r.stats[0].value, r.stats[0].label], ['1 of 9', 'stores work from this iPhone; 2 had no store nearby']);
    assert.match(section(r, 'stores').summary, /^1 of 9 stores work \(2 had none nearby\), checked Sep 27, 10:13\sPM\.$/);
    const check = (id: string) => r.table.rows.find((x) => x.retailerId === id)?.check;
    assert.deepEqual(['walmart', 'kroger', 'meijer', 'ralphs'].map(check), ['✓ Works', '✗ Failed', '? Too few', '– None near']);
  });

  await t('report: stores searched only in the store check stay out of the table and the averages; big sizes in GB', () => {
    // The store check's page loads: heavy, one at each store, and nothing else at three of them.
    const checks = ['walmart', 'costco', 'meijer', 'ralphs', 'fredmeyer'].map((id): AttemptEntry => ({
      at: NOW - 29 * 60_000, retailerId: id, kind: 'coverage', strategy: 'webview', ok: true, ms: 9000, bytes: 5_000_000, rules: 'v1',
    }));
    const r = buildReport(input({ entries: [...week(), ...checks] }));
    assert.deepEqual(r.table.rows.map((x) => x.name), ['Walmart', 'Target', 'Kroger', 'ALDI', 'H-E-B'], 'no row for a store the check alone searched');
    assert.equal(r.table.rows[0].searches, 11, 'a compared store’s check still counts in its own row');
    assert.deepEqual(measuredFrom([...week(), ...checks]), measuredFrom(week()), 'the average search leaves the check out');
    assert.match(said(r, 'data'), /About 758\u00a0KB a search over this iPhone’s last 31 searches that worked, not counting the store check,/);
    // A month's data past a gigabyte, in GB: 5 lists a week of 20 items at 4 stores, at 758 KB a search.
    const busy = buildReport(input({ cost: { ...DEFAULT_INPUTS, listsPerWeek: 5 } }));
    assert.match(said(busy, 'cost'), /each phone uses about 1\.3\u00a0GB of its data a month\./);
  });

  await t('the page: one document, sized for expo-print’s US Letter, shrinking to fit but not below its floor', () => {
    const html = reportHtml(buildReport(input()));
    assert.ok(html.startsWith('<!DOCTYPE html>'));
    assert.match(html, /<title>Stretch results 2026-09-27<\/title>/);
    assert.deepEqual(PAGE, { width: 612, height: 792 });
    assert.match(html, /@page \{ size: 612px 792px; margin: 0; \}/);
    assert.match(html, new RegExp(`font: 400 ${BASE_PX}px/1\\.36`));
    assert.match(html, new RegExp(`scrollHeight > ${PAGE.height} && size > ${FLOOR_PX}`), 'the fitting script, with the page’s height and the floor');
    assert.ok(FLOOR_PX < BASE_PX && FLOOR_PX >= 7);
    // The page's parts in order: the figures, the store check, the table, then two columns and where the numbers come from.
    const order = ['<div class="stats">', ...['Which stores work from here', 'Store by store', 'Speed', 'Data per list', 'The hourly limit', 'Are the prices right?', 'Bot checks and blocks', 'What servers would cost'].map((h) => `<h2>${h}</h2>`), '<footer>'];
    const at = order.map((s) => html.indexOf(s));
    assert.ok(at.every((i, n) => i > 0 && (n === 0 || i > at[n - 1])), `in order: ${at.join(', ')}`);
    assert.ok(!html.includes('10016'));
  });

  await t('the page: said in words, not colors, for black and white; estimates and assumptions labeled', () => {
    const html = reportHtml(buildReport(input()));
    assert.match(html, /<td class="check">✓ Works<\/td>/);
    assert.match(html, /<td class="check">✗ Blocked<\/td>/);
    assert.match(html, /<th>6 searches<\/th>/, 'the speed test’s column');
    assert.match(html, /<td class="num"><span class="dash">–<\/span><\/td><\/tr>/, 'nothing is a dash: H-E-B had no speed test');
    assert.match(html, /<div class="stat"><span class="tag">Estimate<\/span> <div class="value">\$255,000<\/div>/);
    assert.equal((html.match(/<span class="tag">Estimate<\/span>/g) ?? []).length, 5, 'the servers’ cost (twice, and in its figure), the typical list, and the footer');
    assert.equal((html.match(/<span class="tag">Assumed<\/span>/g) ?? []).length, 2, 'the server prices, and the footer');
    assert.match(html, /<p><span class="tag">Estimate<\/span> <b>From servers: about \$255,000 a month<\/b> for 100,000 users/);
    const empty = reportHtml(buildReport(nothing()));
    assert.match(empty, /<section class="part empty"><h2>Which stores work from here<\/h2><p>The store check hasn’t run/);
    assert.match(empty, /<div class="stat none"><div class="value">—<\/div><div class="label">Store check not run yet<\/div><\/div>/);
    assert.ok(!empty.includes('Speed test</th>'), 'no speed test, no column');
  });

  await t('the page: names and versions from files are text, not HTML; only base64 goes in as the font', () => {
    const r = buildReport(
      input({
        stores: [...STORES.filter((s) => s.id !== 'aldi'), { id: 'aldi', name: '<img src=x onerror=alert(1)> & “Co”' }],
        rules: { version: '</style><script>alert(1)</script>', source: 'served' },
      }),
    );
    const html = reportHtml(r);
    assert.ok(!html.includes('<img src=x'), 'a store name is escaped');
    assert.ok(!html.includes('<script>alert(1)'), 'so is a rules version');
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt; &amp; “Co”/);
    assert.equal(esc(`<a href="x">'&'</a>`), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');

    const font = Buffer.from('not really a font, but base64 all the same').toString('base64');
    const withFont = reportHtml(r, { displayFont: `${font.slice(0, 20)}\n${font.slice(20)}` });
    assert.match(withFont, new RegExp(`@font-face \\{ font-family: 'Fraunces'; font-style: normal; font-weight: 600; font-display: swap; src: url\\(data:font/ttf;base64,${font.replace(/[+/]/g, '\\$&')}\\) format\\('truetype'\\); \\}`));
    assert.match(withFont, /document\.fonts\.load\("600 16px Fraunces"\)/, 'asked for early, so it loads before the page is printed');
    for (const bad of ['abc)}body{display:none', 'abc<def', 'data:font/ttf;base64,abc']) {
      assert.ok(!reportHtml(r, { displayFont: bad }).includes('@font-face'), bad);
    }
    const plain = reportHtml(r);
    assert.ok(!plain.includes('@font-face') && !plain.includes('document.fonts.load'), 'no font: the phone’s own serif');
    assert.match(plain, /font-family: 'Fraunces', ui-serif, 'New York', 'Iowan Old Style', Palatino, Georgia, serif/);
  });

  await t('truth book: the last check kept, saved and loaded; a bad save is ignored; cleared', () => {
    const book = new TruthBook();
    let heard = 0;
    const stop = book.subscribe(() => heard++);
    assert.equal(book.getSnapshot(), undefined);
    book.record(TRUTH);
    assert.equal(book.getSnapshot(), TRUTH);
    const again = new TruthBook();
    again.hydrate(book.serialize());
    assert.deepEqual(again.getSnapshot(), TRUTH);
    for (const bad of ['{', 'null', '[]', JSON.stringify({ ...TRUTH, at: 'soon' }), JSON.stringify({ ...TRUTH, summary: { same: 1 } }), JSON.stringify({ ...TRUTH, summary: { ...TRUTH.summary, byStore: [] } })]) {
      const b = new TruthBook();
      b.hydrate(bad);
      assert.equal(b.getSnapshot(), undefined, bad);
    }
    book.clear();
    book.clear();
    assert.deepEqual([book.getSnapshot(), heard], [undefined, 2], 'clearing what’s already clear says nothing');
    assert.equal(book.serialize(), 'null');
    stop();
    book.record(TRUTH);
    assert.equal(heard, 2);
  });

  console.log(`\n${passed} results report tests passed`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
