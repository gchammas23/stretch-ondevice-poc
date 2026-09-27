import { countsInHealth, storeHealth, type AttemptEntry, type StoreHealth } from '../onDevice/attemptLog';
import { COVERAGE_WORDS, type CoverageRow, type CoverageState, type CoverageStatus } from '../onDevice/coverage';
import { blockedLine, summaryLine, type VersusSummary } from '../onDevice/phoneVsServer';
import { citizenReport, MAX_SEARCHES_PER_HOUR, type CitizenRow } from '../onDevice/politeness';
import { bytesText } from '../onDevice/scrapeFeed';
import { DEFAULT_INPUTS, ESTIMATED, measuredFrom, monthlyCost, type CostInputs, type CostResult, type Measured } from './costModel';
import type { Scorecard } from './scorecard';
import type { TruthRecord } from './truth';

// Pure functions only, so the tests run them in Node.
//
// The results report: what this phone measured, on one page for people who weren't there to see it. The report
// screen (report.tsx) shows what goes in it, and makes it a PDF from reportHtml (reportHtml.ts). Every figure says how
// it was had: measured on the phone, an estimate worked out from what was, or an assumption anyone can change.

/** How a figure was had. Measured is the default; the other two are said beside the figure, in words. */
export type Basis = 'measured' | 'estimate' | 'assumption';

/** A run of words: a lead in bold ("Works (12):"), then the rest, and how its figure was had. */
export interface ReportRun {
  lead?: string;
  text: string;
  basis?: Basis;
}

/** A paragraph of the report: a run, and more runs after it. */
export interface ReportLine extends ReportRun {
  more?: ReportRun[];
}

/** A headline figure, big at the top of the page. */
export interface ReportStat {
  value: string;
  label: string;
  basis?: Basis;
  /** Nothing measured yet: the value is a dash, and the label says what's missing. */
  none?: boolean;
}

export type SectionId = 'stores' | 'table' | 'speed' | 'data' | 'truth' | 'blocks' | 'limit' | 'cost';

export interface ReportSection {
  id: SectionId;
  title: string;
  /** Something was measured for it. When not, its lines say how to measure it. */
  has: boolean;
  /** In a line, for the report screen: what it says, or what's missing. */
  summary: string;
  lines: ReportLine[];
}

/** A store's row in the table, in words as printed: the store check, its last 7 days, and the speed test. */
export interface StoreRow {
  retailerId: string;
  name: string;
  /** "✓ Works", "✗ Blocked": the last store check. Undefined when the check didn't try the store. */
  check?: string;
  searches: number;
  /** "98%". */
  worked?: string;
  /** The median time of the searches that worked: "1.3 s". */
  median?: string;
  botChecks: number;
  /** "38 of 120": the most visits in any one hour, against the limit. */
  busiest?: string;
  data?: string;
  /** Its time in the speed test, since the app opened. */
  speed?: string;
}

export interface Report {
  madeAt: number;
  kicker: string;
  title: string;
  /** The device, when it was made, the ZIP code's area and the store rules, one part each. */
  meta: string[];
  stats: ReportStat[];
  /** In the page's order. */
  sections: ReportSection[];
  table: {
    rows: StoreRow[];
    /** Stores with searches in the last 7 days that didn't fit in the table. */
    more: number;
    /** Searches the speed test made at each store, for its column's heading. */
    speedItems?: number;
    caption: string;
  };
  /** Where the numbers come from. */
  notes: ReportLine[];
  /** The PDF's name when it's shared. */
  fileName: string;
}

export interface ReportInput {
  /** When the report is made. */
  now: number;
  /** "iPhone". */
  device: string;
  /** "iOS 26.0", when known. */
  system?: string;
  /** The ZIP code set in the app: only its area goes in the report. */
  zip: string;
  rules: { version: string; source: 'bundled' | 'served' };
  /** Every store in the rules, and the ones the user added: for their names. */
  stores: { id: string; name: string }[];
  /** The stores the user compares, in their order: first in the table. */
  compared: string[];
  /** The search log (see attemptLog.ts). */
  entries: AttemptEntry[];
  /** The last store check (see coverage.ts). */
  coverage: CoverageState;
  /** The speed test's last finished run since the app opened: its scorecard, when it started, its items, cold or warm. */
  speed?: { card: Scorecard; at: number; items: number; kind?: 'cold' | 'warm' };
  /** Lists priced since the app opened, newest first: how many items, when, and their scorecards. Never their names. */
  lists?: { items: number; at: number; card: Scorecard }[];
  /** The last finished price truth check. */
  truth?: TruthRecord;
  /** The last finished phone vs. server test. */
  versus?: { at: number; summary: VersusSummary };
  /** The server cost model's inputs: its defaults, unless given. */
  cost?: CostInputs;
  /** Rows in the store table at most, TABLE_ROWS unless given: fewer, for a report that has to fit its page. */
  maxRows?: number;
}

/** Rates, bot checks and the hourly limit look back this many days, as Store health does. */
export const REPORT_DAYS = 7;
/** Rows in the store table at most: the compared stores first, then the most searched of the others. */
export const TABLE_ROWS = 12;

const DAY = 24 * 60 * 60_000;
/** The store check's verdicts, most welcome first. */
const VERDICTS: CoverageStatus[] = ['works', 'bot_check', 'no_products', 'slow', 'failed', 'cooling'];
/** The same, short, for the table: ✓ or ✗ carries it in black and white. */
const CHECK_WORDS: Record<CoverageStatus, string> = {
  works: '✓ Works',
  bot_check: '✗ Blocked',
  no_products: '✗ No products',
  slow: '✗ Too slow',
  failed: '✗ Failed',
  cooling: '– Cooling down',
};

const sec = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
const pct = (share: number) => `${Math.round(share * 100)}%`;
const count = (n: number) => n.toLocaleString('en-US');
const plural = (n: number, one: string, many = `${one}s`) => `${count(n)} ${n === 1 ? one : many}`;
const searches = (n: number) => plural(n, 'search', 'searches');
/** "$12,400", or "$3.25" under $100. */
const dollars = (n: number) => (n >= 100 ? `$${Math.round(n).toLocaleString('en-US')}` : `$${n.toFixed(2)}`);
/** An estimate's dollars, to three figures ("$171,000"): the model isn't closer than that. */
const roughly = (n: number) => {
  if (n < 1000) return dollars(n);
  const step = 10 ** (Math.floor(Math.log10(n)) - 2);
  return dollars(Math.round(n / step) * step);
};
/** A unit price, as a person says it: "$4", "$2.50", "10¢". */
const rate = (n: number) => (n < 1 ? `${Math.round(n * 100)}¢` : Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`);
/** "a" or "an", for a number said aloud: an 8-item list, an 11-item list. */
const an = (n: number) => (String(n).startsWith('8') || n === 11 || n === 18 ? 'an' : 'a');
const times = (n: number) => (n === 1 ? 'once' : n === 2 ? 'twice' : `${count(n)} times`);
/** "100k", "1M". */
const people = (n: number) => (n >= 1_000_000 && n % 1_000_000 === 0 ? `${n / 1_000_000}M` : n >= 1000 && n % 1000 === 0 ? `${n / 1000}k` : count(n));

function median(values: number[]): number | undefined {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** "Sep 27, 2026, 10:41 PM". */
export const fullStamp = (at: number): string =>
  new Date(at).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });

/** "Sep 27, 10:41 PM", with the year when it isn't the report's. */
function stamp(at: number, now: number): string {
  const sameYear = new Date(at).getFullYear() === new Date(now).getFullYear();
  return new Date(at).toLocaleString('en-US', { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }), hour: 'numeric', minute: '2-digit' });
}

/** "Sep 21". */
const day = (at: number) => new Date(at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

/** "100xx": the area a U.S. ZIP code is in (its first three digits), not the code itself. */
export function zipArea(zip: string): string | undefined {
  const z = zip.trim();
  return /^\d{5}$/.test(z) ? `${z.slice(0, 3)}xx` : undefined;
}

/** "Stretch results 2026-09-27.pdf": the PDF's name when it's shared. */
export function reportFileName(at: number): string {
  const d = new Date(at);
  const two = (n: number) => String(n).padStart(2, '0');
  return `Stretch results ${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}.pdf`;
}

/** The last store check's results, in its order. */
function checkedRows(c: CoverageState): CoverageRow[] {
  return c.stores.map((s) => c.rows[s.retailerId]).filter((r): r is CoverageRow => !!r);
}

/** "Walmart 3, Target 1": the stores with some, most first. */
const perStore = (items: { name: string; n: number }[]) =>
  items
    .filter((i) => i.n > 0)
    .sort((a, b) => b.n - a.n)
    .map((i) => `${i.name} ${count(i.n)}`)
    .join(', ');

/** How a run's searches went out, in words: "3 page loads, 15 sent from a page already open, 6 through an official API". */
function howText(card: Scorecard): string {
  const sum = (key: 'pageLoads' | 'reused' | 'api' | 'direct') => card.stores.reduce((n, s) => n + s[key], 0);
  return [
    sum('pageLoads') && plural(sum('pageLoads'), 'page load'),
    sum('reused') && `${count(sum('reused'))} sent from a page already open`,
    sum('api') && `${count(sum('api'))} through an official API`,
    sum('direct') && plural(sum('direct'), 'plain request'),
    card.shared && `${plural(card.shared, 'item')} took another item’s search`,
  ]
    .filter((p): p is string => !!p)
    .join(', ');
}

const kindWords = (kind?: 'cold' | 'warm') => (kind === 'cold' ? ', from cold' : kind === 'warm' ? ', pages kept warm' : '');

/** What the sections are made from. */
interface Ctx {
  input: ReportInput;
  device: string;
  now: number;
  since: number;
  nameOf: (id: string) => string;
  /** Store health's searches in the window: tries at reading prices, at every store. */
  tries: AttemptEntry[];
  worked: AttemptEntry[];
  medianMs?: number;
  healths: Map<string, StoreHealth>;
  citizen: CitizenRow[];
  measured: Measured;
  inputs: CostInputs;
  cost: CostResult;
  speed?: ReportInput['speed'];
  checked: CoverageRow[];
}

/** Everything the report says, from what the phone measured. */
export function buildReport(input: ReportInput): Report {
  const { now, device } = input;
  const since = now - REPORT_DAYS * DAY;
  const tries = input.entries.filter((e) => e.at >= since && countsInHealth(e));
  const worked = tries.filter((e) => e.ok);
  const ids = [...new Set([...input.compared, ...tries.map((e) => e.retailerId)])];
  const measured = measuredFrom(input.entries);
  const inputs = input.cost ?? DEFAULT_INPUTS;
  const c: Ctx = {
    input,
    device,
    now,
    since,
    nameOf: (id) => input.stores.find((s) => s.id === id)?.name ?? id,
    tries,
    worked,
    medianMs: median(worked.map((e) => e.ms)),
    healths: new Map(ids.map((id) => [id, storeHealth(input.entries, id, now, REPORT_DAYS)])),
    citizen: citizenReport(input.entries, since),
    measured,
    inputs,
    cost: monthlyCost(inputs, measured),
    speed: input.speed && input.speed.card.totalMs !== undefined ? input.speed : undefined,
    checked: checkedRows(input.coverage),
  };
  const area = zipArea(input.zip);
  return {
    madeAt: now,
    kicker: 'Stretch · proof of concept',
    title: 'Grocery prices, read on the phone',
    meta: [
      `Results from this ${device}${input.system ? ` (${input.system})` : ''}`,
      `made ${fullStamp(now)}`,
      area ? `ZIP area ${area}` : 'no ZIP code set',
      `store rules ${input.rules.version}, ${input.rules.source === 'served' ? 'from a rules file' : 'built into the app'}`,
    ],
    stats: stats(c),
    sections: [storesSection(c), tableSection(c), speedSection(c), dataSection(c), truthSection(c), blocksSection(c), limitSection(c), costSection(c)],
    table: storeTable(c),
    notes: [
      {
        lead: 'Where these numbers come from.',
        text: `Measured on this ${device}:`,
        more: [
          { text: 'the store check; each search’s result, time and bot checks (its log keeps 14 days); visits an hour; the speed test; the truth check’s sample.' },
          { basis: 'estimate', lead: 'Estimates:', text: 'data sizes (a file a site doesn’t give the size of counts at a typical size for its type), data for a typical list, and what servers would cost.' },
          { basis: 'assumption', lead: 'Assumptions:', text: 'the server prices and use under What servers would cost, which anyone can change in the app; and the limit of 120 visits an hour, a guess at a person’s pace.' },
        ],
      },
      { text: `Made on this ${device} by Stretch’s proof of concept, from its own records. Every price was read on the phone: no server read them.` },
    ],
    fileName: reportFileName(now),
  };
}

function stats(c: Ctx): ReportStat[] {
  const works = c.checked.filter((r) => r.status === 'works').length;
  const s = c.speed;
  const t = c.input.truth?.summary;
  return [
    c.checked.length
      ? { value: `${works} of ${c.checked.length}`, label: `stores work from this ${c.device}, in the store check` }
      : { value: '—', label: 'Store check not run yet', none: true },
    c.tries.length
      ? { value: pct(c.worked.length / c.tries.length), label: `of ${searches(c.tries.length)} worked, the last ${REPORT_DAYS} days` }
      : { value: '—', label: `No searches in the last ${REPORT_DAYS} days`, none: true },
    s
      ? { value: sec(s.card.totalMs!), label: `to price ${s.items} items at ${plural(s.card.storesSearched, 'store')}${kindWords(s.kind)}, in the speed test` }
      : c.medianMs !== undefined
        ? { value: sec(c.medianMs), label: `a search, in the middle, the last ${REPORT_DAYS} days` }
        : { value: '—', label: 'No speed test yet', none: true },
    t?.checked
      ? { value: `${t.same} of ${t.checked}`, label: 'prices matched the product’s own page, in the truth check' }
      : { value: '—', label: t ? 'No product page could be read' : 'Price truth check not run yet', none: true },
    { value: roughly(c.cost.total), label: `a month from servers for ${people(c.inputs.users)} users; on phones, $0`, basis: 'estimate' },
  ];
}

function storesSection(c: Ctx): ReportSection {
  const title = 'Which stores work from here';
  const state = c.input.coverage;
  if (!c.checked.length) {
    return {
      id: 'stores',
      title,
      has: false,
      summary: 'Not run yet: Store health → Check all stores.',
      lines: [{ text: `The store check hasn’t run on this ${c.device} yet: Store health → Check all stores searches “milk” once at every store.` }],
    };
  }
  const works = c.checked.filter((r) => r.status === 'works').length;
  const at = state.finishedAt ?? Math.max(...c.checked.map((r) => r.at));
  const groups = VERDICTS.map((status) => ({ status, names: c.checked.filter((r) => r.status === status).map((r) => r.name) })).filter((g) => g.names.length);
  const runOf = (g: (typeof groups)[number]): ReportRun => ({ lead: `${COVERAGE_WORDS[g.status]} (${g.names.length}):`, text: `${g.names.join(', ')}.` });
  const [first, ...rest] = groups.filter((g) => g.status !== 'works');
  const lines: ReportLine[] = [
    {
      lead: `${works} of ${c.checked.length} stores work from this ${c.device}.`,
      text: `The store check searched “${state.query}” once at each store, four at a time, ${stamp(at, c.now)}${state.running ? ', and was still going' : ''}.`,
    },
    ...groups.filter((g) => g.status === 'works').map(runOf),
    // The rest in one paragraph: fewer stores each, and less said.
    ...(first ? [{ ...runOf(first), more: rest.map(runOf) }] : []),
  ];
  return { id: 'stores', title, has: true, summary: `${works} of ${c.checked.length} stores work, checked ${stamp(at, c.now)}.`, lines };
}

function storeTable(c: Ctx): Report['table'] {
  const compared = c.input.compared.filter((id, i, all) => all.indexOf(id) === i);
  const others = [...c.healths.values()]
    .filter((h) => h.attempts > 0 && !compared.includes(h.retailerId))
    .sort((a, b) => b.attempts - a.attempts || c.nameOf(a.retailerId).localeCompare(c.nameOf(b.retailerId)))
    .map((h) => h.retailerId);
  const ids = [...compared, ...others];
  const shown = ids.slice(0, Math.max(1, c.input.maxRows ?? TABLE_ROWS));
  const tried = new Set(c.input.coverage.stores.map((s) => s.retailerId));
  const rows = shown.map((id): StoreRow => {
    const h = c.healths.get(id) ?? storeHealth(c.input.entries, id, c.now, REPORT_DAYS);
    const busiest = c.citizen.find((r) => r.retailerId === id)?.busiestHour;
    const check = tried.has(id) ? c.input.coverage.rows[id] : undefined;
    const speed = c.speed?.card.stores.find((s) => s.retailerId === id);
    return {
      retailerId: id,
      name: c.nameOf(id),
      ...(check ? { check: CHECK_WORDS[check.status] } : {}),
      searches: h.attempts,
      ...(h.rate !== undefined ? { worked: pct(h.rate) } : {}),
      ...(h.medianMs !== undefined ? { median: sec(h.medianMs) } : {}),
      botChecks: h.botChecks,
      ...(busiest ? { busiest: `${busiest} of ${MAX_SEARCHES_PER_HOUR}` } : {}),
      ...(h.bytes ? { data: bytesText(h.bytes) } : {}),
      ...(speed?.totalMs !== undefined && speed.searches ? { speed: sec(speed.totalMs) } : {}),
    };
  });
  const caption = [
    `Last ${REPORT_DAYS} days: ${day(c.since)} to ${day(c.now)}. Worked: the share of searches that did; median: their time in the middle; busiest hour: the most visits in any one hour, against the app’s limit; data: about.`,
    'Blocked: a bot check or a refusal.',
    c.speed ? `Speed test: each store’s ${c.speed.items} searches, start to finish.` : '',
    ids.length > shown.length ? `${plural(ids.length - shown.length, 'more store')} with fewer searches aren’t shown: see Store health.` : '',
  ]
    .filter(Boolean)
    .join(' ');
  return { rows, more: ids.length - shown.length, ...(c.speed ? { speedItems: c.speed.items } : {}), caption };
}

function tableSection(c: Ctx): ReportSection {
  const stores = new Set(c.tries.map((e) => e.retailerId)).size;
  return {
    id: 'table',
    title: 'Store by store',
    has: c.tries.length > 0,
    summary: c.tries.length
      ? `${searches(c.tries.length)} at ${plural(stores, 'store')} in the last ${REPORT_DAYS} days: ${pct(c.worked.length / c.tries.length)} worked${c.medianMs !== undefined ? `, ${sec(c.medianMs)} each in the middle` : ''}.`
      : `No searches in the last ${REPORT_DAYS} days: price a list, or run the speed test.`,
    lines: c.tries.length || c.input.compared.length ? [] : [{ text: `No store was searched in the last ${REPORT_DAYS} days.` }],
  };
}

function speedSection(c: Ctx): ReportSection {
  const s = c.speed;
  const lines: ReportLine[] = [];
  if (s) {
    const card = s.card;
    const how = howText(card);
    lines.push({
      lead: `${s.items} items at ${plural(card.storesSearched, 'store')} in ${sec(card.totalMs!)}${kindWords(s.kind)}`,
      text:
        `${s.kind === 'cold' ? '(every store’s page loaded first, as after opening the app) ' : ''}in the speed test, ${stamp(s.at, c.now)}. ` +
        `${card.ok} of ${searches(card.searches)} worked${how ? ` (${how})` : ''}${card.firstMs !== undefined ? `, and the first price came after ${sec(card.firstMs)}` : ''}.`,
    });
  } else {
    lines.push({ text: 'No speed test since the app opened: Diagnostics → Speed test prices 6 items at every compared store.' });
  }
  if (c.medianMs !== undefined) {
    lines.push({ text: `Over the last ${REPORT_DAYS} days, a search that worked took ${sec(c.medianMs)} in the middle (of ${count(c.worked.length)}).` });
  }
  return {
    id: 'speed',
    title: 'Speed',
    has: !!s || c.medianMs !== undefined,
    summary: s
      ? `${s.items} items at ${plural(s.card.storesSearched, 'store')} in ${sec(s.card.totalMs!)}${kindWords(s.kind)}.`
      : c.medianMs !== undefined
        ? `No speed test since the app opened; ${sec(c.medianMs)} a search over ${REPORT_DAYS} days.`
        : 'No speed test yet: Diagnostics → Speed test.',
    lines,
  };
}

function dataSection(c: Ctx): ReportSection {
  const lines: ReportLine[] = [];
  const s = c.speed;
  if (s && s.card.bytes) {
    lines.push({
      lead: `The speed test: about ${bytesText(s.card.bytes)}`,
      text: `for ${s.items} items at ${plural(s.card.storesSearched, 'store')} (${searches(s.card.searches)}${kindWords(s.kind)}).`,
    });
  }
  const lists = (c.input.lists ?? []).filter((l) => l.card.searches > 0 && l.card.bytes > 0).slice(0, 2);
  for (const l of lists) {
    lines.push({
      lead: `${an(l.items) === 'an' ? 'An' : 'A'} ${l.items}-item list at ${plural(l.card.storesSearched, 'store')}: about ${bytesText(l.card.bytes)}`,
      text: `(${searches(l.card.searches)}, ${stamp(l.at, c.now)}).`,
    });
  }
  const m = c.measured;
  const items = c.inputs.itemsPerList;
  const stores = c.inputs.stores;
  const perList = m.bytesPerSearch * items * stores;
  const typical = `${an(items)} ${items}-item list at ${stores} stores takes about ${bytesText(perList)}`;
  lines.push(
    m.searches
      ? {
          lead: `About ${bytesText(m.bytesPerSearch)} a search`,
          text: `over this ${c.device}’s last ${searches(m.searches)} that worked,`,
          more: [{ basis: 'estimate', text: `so ${typical}.` }],
        }
      : {
          basis: 'estimate',
          text: `At the app’s starting estimate of ${bytesText(ESTIMATED.bytesPerSearch)} a search, ${typical}: this ${c.device} hasn’t measured enough searches yet.`,
        },
  );
  return {
    id: 'data',
    title: 'Data per list',
    has: !!(s && s.card.bytes) || lists.length > 0 || m.searches > 0,
    summary:
      s && s.card.bytes
        ? `About ${bytesText(s.card.bytes)} for the speed test’s ${s.items} items at ${plural(s.card.storesSearched, 'store')}.`
        : m.searches
          ? `About ${bytesText(m.bytesPerSearch)} a search, so ${typical}.`
          : 'Only the starting estimate: search a few times first.',
    lines,
  };
}

function truthSection(c: Ctx): ReportSection {
  const title = 'Are the prices right?';
  const t = c.input.truth;
  if (!t) {
    return {
      id: 'truth',
      title,
      has: false,
      summary: 'Not run yet: a list’s Find a store → Are these prices right?',
      lines: [
        {
          text: 'The price truth check hasn’t run yet: on a priced list, Find a store → Are these prices right? reads a sample of its prices again, each from the product’s own page on the store’s site.',
        },
      ],
    };
  }
  const s = t.summary;
  if (!s.checked) {
    return {
      id: 'truth',
      title,
      has: false,
      summary: `No product page could be read in the last check (${stamp(t.at, c.now)}).`,
      lines: [{ text: `The last price truth check, ${stamp(t.at, c.now)}, couldn’t read a price on any of the ${plural(s.unreadable, 'product page')} it opened.` }],
    };
  }
  const stores = Object.entries(s.byStore).filter(([, v]) => v.checked > 0);
  const lines: ReportLine[] = [
    {
      lead: `${s.same} of ${s.checked} prices matched (${pct(s.same / s.checked)})`,
      text:
        `the product’s own page on the store’s site, each read again, ${t.perStore} per store, ${stamp(t.at, c.now)}. ` +
        `${stores.map(([id, v]) => `${c.nameOf(id)} ${v.same} of ${v.checked}`).join(' · ')}.` +
        `${s.unreadable ? ` ${plural(s.unreadable, 'page')} showed no price the phone could read: not counted.` : ''}`,
    },
  ];
  if (s.different) lines.push({ text: 'A product page can be for another store than the search, or a price can change in between.' });
  return { id: 'truth', title, has: true, summary: `${s.same} of ${s.checked} prices matched their product pages (${stamp(t.at, c.now)}).`, lines };
}

function blocksSection(c: Ctx): ReportSection {
  const healths = [...c.healths.values()];
  const checks = healths.reduce((n, h) => n + h.botChecks, 0);
  const cools = healths.reduce((n, h) => n + h.coolDowns, 0);
  const never = 'The app never answers one itself.';
  const lines: ReportLine[] = [];
  if (c.tries.length) {
    const who = perStore(healths.map((h) => ({ name: c.nameOf(h.retailerId), n: h.botChecks })));
    const refusers = healths.filter((h) => h.coolDowns > 0);
    const refused = !cools
      ? `No store refused this ${c.device} outright.`
      : refusers.length === 1
        ? `${c.nameOf(refusers[0].retailerId)} refused this ${c.device} outright ${times(cools)}, and was left alone to cool down${cools > 1 ? ' each time' : ''} before it was tried again.`
        : `Stores refused this ${c.device} outright ${times(cools)} (${perStore(refusers.map((h) => ({ name: c.nameOf(h.retailerId), n: h.coolDowns })))}): each was left alone to cool down before it was tried again.`;
    lines.push({
      lead: `${checks ? plural(checks, 'bot check') : 'No bot checks'} in ${searches(c.tries.length)}`,
      text: `over the last ${REPORT_DAYS} days${checks ? `: ${who}` : ''}. ${never} ${refused}`,
    });
  } else {
    lines.push({ text: `No searches in the last ${REPORT_DAYS} days. The app never answers a bot check itself.` });
  }
  const v = c.input.versus;
  if (v && v.summary.tried) {
    const blocked = blockedLine(v.summary);
    lines.push({ lead: `Phone vs. server, ${day(v.at)}:`, text: `${summaryLine(v.summary, c.device)}${blocked ? ` ${blocked}` : ''}` });
  }
  return {
    id: 'blocks',
    title: 'Bot checks and blocks',
    has: c.tries.length > 0 || !!v?.summary.tried,
    summary: c.tries.length
      ? `${checks ? plural(checks, 'bot check') : 'No bot checks'} in ${searches(c.tries.length)} over ${REPORT_DAYS} days${cools ? `; refused ${times(cools)}` : ''}.`
      : `No searches in the last ${REPORT_DAYS} days.`,
    lines,
  };
}

function limitSection(c: Ctx): ReportSection {
  const rows = c.citizen;
  const rule: ReportRun = { lead: `At most ${MAX_SEARCHES_PER_HOUR} visits an hour at one store,`, text: 'and one page load at a time: the app’s own limit, at about a person’s pace.' };
  if (!rows.length) {
    return {
      id: 'limit',
      title: 'The hourly limit',
      has: false,
      summary: `Nothing asked of any store in the last ${REPORT_DAYS} days.`,
      lines: [{ ...rule, more: [{ text: `Nothing was asked of any store in the last ${REPORT_DAYS} days.` }] }],
    };
  }
  const top = rows.reduce((a, b) => (b.busiestHour > a.busiestHour ? b : a));
  const sum = (key: 'pageLoads' | 'reused' | 'api' | 'otherPages') => rows.reduce((n, r) => n + r[key], 0);
  const parts = [
    sum('pageLoads') && plural(sum('pageLoads'), 'full page load'),
    sum('reused') && `${searches(sum('reused'))} sent from a page already open`,
    sum('api') && plural(sum('api'), 'official API call'),
    sum('otherPages') && `${plural(sum('otherPages'), 'other page')} (products, fees, weekly ads, coupons)`,
  ].filter((p): p is string => !!p);
  return {
    id: 'limit',
    title: 'The hourly limit',
    has: true,
    summary: `Busiest hour: ${top.busiestHour} of ${MAX_SEARCHES_PER_HOUR} at ${c.nameOf(top.retailerId)}.`,
    lines: [
      {
        ...rule,
        more: [
          {
            lead: `The busiest hour in the last ${REPORT_DAYS} days: ${plural(top.busiestHour, 'visit')}`,
            text: `at ${c.nameOf(top.retailerId)}, ${pct(top.busiestHour / MAX_SEARCHES_PER_HOUR)} of the limit.`,
          },
        ],
      },
      { text: `All it asked of the stores in those days: ${parts.join(', ')}.` },
    ],
  };
}

function costSection(c: Ctx): ReportSection {
  const { cost, inputs, measured } = c;
  return {
    id: 'cost',
    title: 'What servers would cost',
    // Worked out from the phone's own searches; until there are some, from the model's starting estimates.
    has: measured.searches > 0,
    summary: measured.searches
      ? `About ${roughly(cost.total)} a month from servers for ${people(inputs.users)} users, against $0 on phones (an estimate).`
      : `About ${roughly(cost.total)} a month for ${people(inputs.users)} users, from starting estimates: search a few times first.`,
    lines: [
      {
        basis: 'estimate',
        lead: `From servers: about ${roughly(cost.total)} a month`,
        text: `for ${count(inputs.users)} users: proxies ${roughly(cost.proxy)}, bot checks solved ${roughly(cost.solving)}, browsers ${roughly(cost.browsers)}.`,
        more: [{ basis: 'estimate', lead: 'On phones: $0 to Stretch;', text: `each phone uses about ${bytesText(cost.phoneBytesPerUserMonth)} of its data a month.` }],
      },
      {
        ...(measured.searches
          ? { text: `Worked out from this ${c.device}’s average search (${bytesText(measured.bytesPerSearch)}, ${sec(measured.msPerSearch)}) and:` }
          : {
              basis: 'estimate' as const,
              text: `Worked out from the app’s starting estimate of a search (${bytesText(measured.bytesPerSearch)}, ${sec(measured.msPerSearch)}: this ${c.device} hasn’t measured enough yet) and:`,
            }),
        more: [
          {
            basis: 'assumption',
            text:
              `${plural(inputs.listsPerWeek, 'list')} a week per user, of ${inputs.itemsPerList} items at ${inputs.stores} stores; residential proxies at ${rate(inputs.proxyPerGb)} a GB; ` +
              `${pct(inputs.botCheckRate)} of server searches meet a bot check, solved at ${rate(inputs.solvePer1000)} per 1,000; headless browsers at ${rate(inputs.browserPerHour)} an hour. ` +
              'Building and running servers isn’t counted.',
          },
        ],
      },
    ],
  };
}
