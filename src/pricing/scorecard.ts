import { bytesText, reasonWords, seconds } from '../onDevice/scrapeFeed';
import { shownAt, type SearchTimeline, type SpanKind, type TimingSpan } from '../onDevice/timing';
import { runMs, type PricingRun, type SearchResult } from './pricingEngine';

// Pure functions only, so the tests run them in Node.

/** The speed test (Diagnostics) prices these at every compared store, as a list of its own that no screen shows. */
export const SPEED_TEST = '__speedtest__';
export const SPEED_ITEMS = ['milk', 'eggs', 'bread', 'bananas', 'butter', 'coffee'];

/** How one store's searches went in a run. Only searches run in it count, not prices saved from earlier. */
export interface StoreScore {
  retailerId: string;
  name: string;
  searches: number;
  ok: number;
  failed: number;
  /** Products with prices the searches returned. */
  products: number;
  /** From the run's start to this store's first fresh price. */
  firstMs?: number;
  /** From this store starting to it finishing. */
  totalMs?: number;
  medianMs?: number;
  /** A full page load in a hidden browser. */
  pageLoads: number;
  /** The store's own search request sent again from a page already loaded. */
  reused: number;
  /** An official API. */
  api: number;
  /** A plain request for the search page, without a browser. */
  direct: number;
  /** Prices reused from earlier instead of searched. */
  saved: number;
  /** Items that took another item's search instead of one of their own (see sharing.ts). */
  shared: number;
  /** Data the searches moved, about. */
  bytes: number;
  /** Data they didn't move by asking for only the results the app keeps, about (see pageSize.ts). */
  bytesSaved: number;
}

export interface Scorecard {
  stores: StoreScore[];
  searches: number;
  ok: number;
  failed: number;
  products: number;
  /** Stores that searched something in this run. */
  storesSearched: number;
  bytes: number;
  bytesSaved: number;
  shared: number;
  /** Start to finish, once the run is done. */
  totalMs?: number;
  firstMs?: number;
}

const live = (r: SearchResult, run: PricingRun) =>
  r.status === 'done' && !r.reason && !r.cached && !r.sharedWith && r.at !== undefined && r.at >= run.startedAt;
const failed = (r: SearchResult) => r.status === 'failed' || r.outcome === 'failed';

function median(values: number[]): number | undefined {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function scorecard(run: PricingRun): Scorecard {
  const stores = run.retailerIds.map((retailerId): StoreScore => {
    const results = Object.values(run.results[retailerId] ?? {});
    const ok = results.filter((r) => live(r, run));
    const bad = results.filter(failed);
    const store = run.stores[retailerId];
    const firsts = ok.map((r) => r.at! - run.startedAt);
    return {
      retailerId,
      name: store?.name ?? retailerId,
      searches: ok.length + bad.length,
      ok: ok.length,
      failed: bad.length,
      products: ok.reduce((n, r) => n + (r.found ?? r.products.length), 0),
      firstMs: firsts.length ? Math.max(0, Math.min(...firsts)) : undefined,
      totalMs: store?.startedAt !== undefined && store.finishedAt !== undefined ? store.finishedAt - store.startedAt : undefined,
      medianMs: median(ok.map((r) => r.ms).filter((ms): ms is number => typeof ms === 'number')),
      pageLoads: ok.filter((r) => r.strategy === 'webview' && r.via !== 'replay').length,
      reused: ok.filter((r) => r.via === 'replay').length,
      api: ok.filter((r) => r.strategy === 'api').length,
      direct: ok.filter((r) => r.strategy === 'fetch').length,
      saved: results.filter((r) => r.status === 'done' && r.cached && !r.stale).length,
      shared: results.filter((r) => r.status === 'done' && r.sharedWith && !r.cached).length,
      bytes: ok.reduce((n, r) => n + (r.bytes ?? 0), 0),
      bytesSaved: ok.reduce((n, r) => n + (r.bytesSaved ?? 0), 0),
    };
  });
  const firsts = stores.map((s) => s.firstMs).filter((ms): ms is number => ms !== undefined);
  return {
    stores,
    searches: stores.reduce((n, s) => n + s.searches, 0),
    ok: stores.reduce((n, s) => n + s.ok, 0),
    failed: stores.reduce((n, s) => n + s.failed, 0),
    products: stores.reduce((n, s) => n + s.products, 0),
    storesSearched: stores.filter((s) => s.searches > 0).length,
    bytes: stores.reduce((n, s) => n + s.bytes, 0),
    bytesSaved: stores.reduce((n, s) => n + s.bytesSaved, 0),
    shared: stores.reduce((n, s) => n + s.shared, 0),
    totalMs: runMs(run),
    firstMs: firsts.length ? Math.min(...firsts) : undefined,
  };
}

const sec = (ms: number | undefined) => (ms === undefined ? '—' : seconds(ms));

/** A plain-text report, for sharing. */
export function scorecardText(card: Scorecard, heading: string): string {
  const lines = [
    heading,
    `${card.ok} of ${card.searches} searches worked · ${card.products} products read · ${card.storesSearched} stores` +
      (card.bytes ? ` · about ${bytesText(card.bytes)} of data` : '') +
      (card.bytesSaved ? ` (${bytesText(card.bytesSaved)} saved by asking for fewer results)` : ''),
    `First price after ${sec(card.firstMs)} · all done in ${sec(card.totalMs)}` +
      (card.shared ? ` · ${card.shared} ${card.shared === 1 ? 'item' : 'items'} shared another item’s search` : ''),
    '',
  ];
  for (const s of card.stores) {
    if (!s.searches) {
      lines.push(`${s.name}: ${s.saved ? `${s.saved} saved from earlier` : 'nothing searched'}`);
      continue;
    }
    const how = [
      s.pageLoads && `${s.pageLoads} page ${s.pageLoads === 1 ? 'load' : 'loads'}`,
      s.reused && `${s.reused} reused page`,
      s.api && `${s.api} API`,
      s.direct && `${s.direct} direct`,
    ].filter(Boolean);
    const data = s.bytes ? ` · ${bytesText(s.bytes)}${s.bytesSaved ? ` (${bytesText(s.bytesSaved)} saved)` : ''}` : '';
    const shared = s.shared ? ` · ${s.shared} shared` : '';
    lines.push(`${s.name}: ${s.ok}/${s.searches} in ${sec(s.totalMs)} · median ${sec(s.medianMs)}${data} · ${how.join(', ') || 'no results'}${shared}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------------------------------------------------
// Speed profile: each search's timeline, from its queue to the screen, and where a run's time went.

/** What held a store up at a moment: what a search was doing then, a try that failed, or nothing (between searches). */
export type PaceKind = SpanKind | 'failed' | 'idle';

/** Most direct cause first: while a page loads, the searches waiting for it are held up by the load itself. */
const PRIORITY: SpanKind[] = ['check', 'start', 'open', 'prices', 'settle', 'fetch', 'api', 'replay', 'parse', 'show', 'wait', 'queue'];
const LOAD_KINDS = new Set<SpanKind>(['start', 'open', 'prices', 'settle', 'check']);

/** Each kind of time, in a few words. */
export const PACE_WORDS: Record<PaceKind, string> = {
  queue: 'waiting for a turn',
  wait: 'waiting for its page',
  start: 'starting the page',
  open: 'loading the page',
  prices: 'waiting for prices',
  settle: 'finishing the load',
  check: 'bot check',
  replay: 'requests from its page',
  fetch: 'plain requests',
  api: 'official API',
  parse: 'reading products',
  show: 'to the screen',
  failed: 'tries that failed',
  idle: 'between searches',
};

/** The same in a word, for the shared timeline. */
const SHORT: Record<SpanKind, string> = {
  queue: 'queue',
  wait: 'wait',
  start: 'start',
  open: 'html',
  prices: 'prices',
  settle: 'finish',
  check: 'check',
  replay: 'replay',
  fetch: 'fetch',
  api: 'api',
  parse: 'parse',
  show: 'screen',
};

/** One search in a run: its item, how it went, and its parts from the queue to the screen. */
export interface ProfileRow {
  query: string;
  ok: boolean;
  /** "page load", "reused its page", "official API", "direct request", or why it failed. */
  how: string;
  /** From its queueing to its result on screen (or its end, when no screen showed it). */
  start: number;
  end: number;
  /** Its parts in order, as drawn. Work done meanwhile (checking data as it streamed in) is left out. */
  spans: TimingSpan[];
  /** That work, in ms: reading streamed data while its page was still loading. */
  during: number;
  /** What its parts don't say: "redirects took 1.30 s", "ended up at …". */
  notes: string[];
}

export interface StoreProfile {
  retailerId: string;
  name: string;
  /** In the order they were queued. */
  rows: ProfileRow[];
  /** From the run's start until its last search's result was on screen (or ended). */
  endMs: number;
  /** What held the store up, each moment counted once, from the run's start until endMs. */
  pace: Partial<Record<PaceKind, number>>;
  /** Time spent in each kind over its searches, all counted even when they ran at once. */
  sums: Partial<Record<SpanKind, number>>;
  /** How long each page load took, from its start until it ended (bot checks included). */
  pageLoads: number[];
  /** Each request's round trip from the kept page. */
  replays: { ms: number; query: string }[];
}

export interface SpeedProfile {
  startedAt: number;
  /** Until the last result was on screen (or the last search ended, when no screen showed them). */
  totalMs: number;
  stores: StoreProfile[];
  /** The store that finished last: its time is the run's. */
  slowest?: StoreProfile;
  sums: Partial<Record<SpanKind, number>>;
  /** Of the time reading products, how much went on data streamed in while pages still loaded. */
  parseDuring: number;
  searches: number;
  /** The biggest costs, in words. */
  findings: string[];
}

const sum = (values: number[]) => values.reduce((n, v) => n + v, 0);
const add = (into: Partial<Record<string, number>>, key: string, ms: number) => {
  into[key] = (into[key] ?? 0) + ms;
};

/** How a finished search got its prices, or why it failed, in a few words. */
function howOf(r: SearchResult): string {
  if (r.status === 'failed' || r.outcome === 'failed') return `failed: ${reasonWords(r.reason)}`;
  if (r.strategy === 'api') return 'official API';
  if (r.strategy === 'fetch') return 'direct request';
  return r.via === 'replay' ? 'reused its page' : 'page load';
}

/** What held things up from `from` to `to`: at each moment, the most direct cause among the spans running then. */
export function paceOf(spans: TimingSpan[], from: number, to: number): Partial<Record<PaceKind, number>> {
  const cuts = [...new Set([from, to, ...spans.flatMap((s) => [s.start, s.end])])].filter((x) => x >= from && x <= to).sort((a, b) => a - b);
  const out: Partial<Record<PaceKind, number>> = {};
  for (let i = 0; i + 1 < cuts.length; i++) {
    const [a, b] = [cuts[i], cuts[i + 1]];
    const active = spans.filter((s) => s.start < b && s.end > a);
    let kind: PaceKind = 'idle';
    for (const k of PRIORITY) {
      const running = active.filter((s) => s.kind === k);
      if (!running.length) continue;
      kind = running.some((s) => s.ok !== false) ? k : 'failed';
      break;
    }
    add(out, kind, b - a);
  }
  return out;
}

/** Durations of the page loads among these spans: runs of a page load's parts in a row. */
function pageLoadsOf(spans: TimingSpan[]): number[] {
  const out: number[] = [];
  let block: { start: number; end: number } | null = null;
  for (const s of spans) {
    if (LOAD_KINDS.has(s.kind) && s.ok !== false) {
      if (block && s.start <= block.end + 1) block.end = s.end;
      else {
        if (block) out.push(block.end - block.start);
        block = { start: s.start, end: s.end };
      }
    } else if (block) {
      out.push(block.end - block.start);
      block = null;
    }
  }
  if (block) out.push(block.end - block.start);
  return out;
}

/**
 * Each store's searches in a run, as timelines from the queue to the screen, and what the time went on. Only searches
 * run in it count. `shown` says when a screen first showed a search's result (see markShown in timing.ts).
 */
export function speedProfile(run: PricingRun, shown: (t: SearchTimeline) => number | undefined = shownAt): SpeedProfile {
  let end = run.startedAt;
  const stores = run.retailerIds.map((retailerId): StoreProfile => {
    const rows: ProfileRow[] = [];
    const sums: Partial<Record<SpanKind, number>> = {};
    for (const r of Object.values(run.results[retailerId] ?? {})) {
      const t = r.timing;
      if (!t || t.startedAt < run.startedAt) continue;
      const on = shown(t);
      const all = on !== undefined && on > t.endedAt ? [...t.spans, { kind: 'show' as const, start: t.endedAt, end: on }] : t.spans;
      for (const s of all) add(sums, s.kind, s.end - s.start);
      rows.push({
        query: r.query,
        ok: r.status === 'done' && r.outcome !== 'failed',
        how: howOf(r),
        start: t.queuedAt,
        end: Math.max(t.endedAt, on ?? 0),
        spans: all.filter((s) => !s.during),
        during: sum(all.filter((s) => s.during).map((s) => s.end - s.start)),
        notes: t.notes ?? [],
      });
    }
    rows.sort((a, b) => a.start - b.start || a.end - b.end);
    const storeEnd = rows.length ? Math.max(...rows.map((r) => r.end)) : run.startedAt;
    end = Math.max(end, storeEnd);
    return {
      retailerId,
      name: run.stores[retailerId]?.name ?? retailerId,
      rows,
      endMs: storeEnd - run.startedAt,
      pace: paceOf(rows.flatMap((r) => r.spans), run.startedAt, storeEnd),
      sums,
      pageLoads: rows.flatMap((r) => pageLoadsOf(r.spans)),
      replays: rows.flatMap((r) => r.spans.filter((s) => s.kind === 'replay' && s.ok !== false).map((s) => ({ ms: s.end - s.start, query: r.query }))),
    };
  });
  const searched = stores.filter((s) => s.rows.length);
  const slowest = searched.length ? searched.reduce((a, b) => (b.endMs > a.endMs ? b : a)) : undefined;
  const sums: Partial<Record<SpanKind, number>> = {};
  for (const s of stores) for (const [k, ms] of Object.entries(s.sums)) add(sums, k, ms ?? 0);
  const profile: SpeedProfile = {
    startedAt: run.startedAt,
    totalMs: end - run.startedAt,
    stores,
    slowest,
    sums,
    parseDuring: sum(stores.flatMap((s) => s.rows.map((r) => r.during))),
    searches: sum(stores.map((s) => s.rows.length)),
    findings: [],
  };
  profile.findings = findingsOf(profile);
  return profile;
}

/** Seconds, to a tenth, or to a hundredth under one second: the speed test's parts are often that short. */
export function shortSeconds(ms: number): string {
  return ms < 1000 ? `${(ms / 1000).toFixed(2)} s` : `${(ms / 1000).toFixed(1)} s`;
}

/** The kinds of time that held the store up, biggest first, leaving out slivers (under 50 ms, or 2% of a short run). */
export function paceParts(pace: Partial<Record<PaceKind, number>>): { kind: PaceKind; ms: number }[] {
  const entries = Object.entries(pace) as [PaceKind, number][];
  const min = Math.min(50, sum(entries.map(([, ms]) => ms)) * 0.02);
  return entries
    .filter(([, ms]) => ms >= min)
    .sort((a, b) => b[1] - a[1])
    .map(([kind, ms]) => ({ kind, ms }));
}

/** The most of these that ran at the same moment. */
function atOnce(spans: TimingSpan[]): number {
  const edges = spans.flatMap((x) => [
    [x.start, 1],
    [x.end, -1],
  ]);
  // Ends before starts at the same moment: one ending as another starts isn't two at once.
  edges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let now = 0;
  let most = 0;
  for (const [, step] of edges) most = Math.max(most, (now += step));
  return most;
}

/** The biggest costs of a run, in words, most telling first. */
function findingsOf(p: SpeedProfile): string[] {
  const s = p.slowest;
  if (!s) return [];
  const out: string[] = [];
  const pace = s.pace;
  const load = sum((['start', 'open', 'prices', 'settle', 'check'] as const).map((k) => pace[k] ?? 0));
  if (load >= 100) {
    const parts = (['start', 'open', 'prices', 'settle', 'check'] as const)
      .filter((k) => (pace[k] ?? 0) >= 50)
      .map((k) => `${PACE_WORDS[k]} ${shortSeconds(pace[k]!)}`);
    out.push(`${s.name}’s page loads held it up for ${shortSeconds(load)} of its ${shortSeconds(s.endMs)}: ${parts.join(', ')}.`);
  }
  const loads = p.stores.flatMap((st) => st.pageLoads.map((ms) => ({ ms, name: st.name })));
  if (loads.length) {
    const sorted = [...loads].sort((a, b) => a.ms - b.ms);
    const mid = median(loads.map((l) => l.ms))!;
    out.push(
      loads.length === 1
        ? `1 page load: ${shortSeconds(mid)} (${sorted[0].name}).`
        : `${loads.length} page loads, ${shortSeconds(mid)} each in the middle: from ${shortSeconds(sorted[0].ms)} (${sorted[0].name}) to ${shortSeconds(sorted[sorted.length - 1].ms)} (${sorted[sorted.length - 1].name}).`,
    );
  }
  // Plain requests and official API calls: how long each took, and how many went at once.
  for (const st of p.stores) {
    for (const [kind, what] of [['fetch', 'plain requests'], ['api', 'official API calls']] as const) {
      const calls = st.rows.flatMap((r) => r.spans.filter((x) => x.kind === kind && x.ok !== false));
      if (!calls.length) continue;
      const took = calls.map((x) => x.end - x.start);
      const range = calls.length === 1 ? shortSeconds(took[0]) : `${shortSeconds(Math.min(...took))} to ${shortSeconds(Math.max(...took))}`;
      out.push(`${st.name}’s ${calls.length} ${what} took ${range} each, ${atOnce(calls)} at a time at most.`);
    }
  }
  const replays = p.stores.flatMap((st) => st.replays.map((r) => ({ ...r, name: st.name })));
  if (replays.length) {
    const slowest = replays.reduce((a, b) => (b.ms > a.ms ? b : a));
    out.push(`${replays.length} ${replays.length === 1 ? 'request' : 'requests'} from kept pages, ${shortSeconds(median(replays.map((r) => r.ms))!)} each in the middle; the slowest ${shortSeconds(slowest.ms)} (${slowest.name}, ${slowest.query}).`);
  }
  const waited = p.sums.wait ?? 0;
  if (waited >= 300) out.push(`Searches spent ${shortSeconds(waited)} in all waiting at their store: for a page another search was loading, or a free slot.`);
  // Searches waiting their turn: how many go at once at a store, and how many stores at once.
  const lined = p.stores.filter((st) => (st.sums.queue ?? 0) >= 1000);
  if (lined.length) out.push(`Searches waited their turn, in all: ${lined.map((st) => `${st.name} ${shortSeconds(st.sums.queue!)}`).join(', ')}.`);
  const parse = p.sums.parse ?? 0;
  if (parse >= 100) out.push(`Reading products took ${shortSeconds(parse)} of the phone’s time${p.parseDuring >= 50 ? `, ${shortSeconds(p.parseDuring)} of it checking data as it streamed in` : ''}.`);
  const shows = p.stores.flatMap((st) => st.rows.flatMap((r) => r.spans.filter((x) => x.kind === 'show').map((x) => x.end - x.start)));
  if (shows.length) out.push(`Results reached the screen ${shortSeconds(median(shows)!)} after they were in, at most ${shortSeconds(Math.max(...shows))}.`);
  const failed = sum(p.stores.map((st) => st.pace.failed ?? 0));
  if (failed >= 100) {
    const why = [...new Set(p.stores.flatMap((st) => st.rows.filter((r) => !r.ok).map((r) => `${st.name} ${r.how.replace(/^failed: /, '')}`)))];
    out.push(`Tries that failed held stores up for ${shortSeconds(failed)}${why.length ? ` (${why.join('; ')})` : ''}.`);
  }
  const idle = pace.idle ?? 0;
  if (idle >= 200) out.push(`${shortSeconds(idle)} of ${s.name}’s time was between searches, with none running.`);
  return out;
}

/** The profile as text to share: where the time went, the biggest costs, and every search's parts. */
export function speedProfileText(p: SpeedProfile): string {
  const s = p.slowest;
  if (!s) return 'No searches ran in this run.';
  const lines = [
    `Where the ${shortSeconds(p.totalMs)} went (${s.name} finished last):`,
    `  ${paceParts(s.pace).map((x) => `${PACE_WORDS[x.kind]} ${shortSeconds(x.ms)}`).join(' · ')}`,
    '',
    'Biggest costs:',
    ...p.findings.map((f) => `- ${f}`),
    '',
    `Each search, in seconds from the start (${Object.values(SHORT).join(', ')}; ✗ failed):`,
  ];
  for (const st of p.stores) {
    if (!st.rows.length) continue;
    lines.push(`${st.name}, done at ${shortSeconds(st.endMs)}:`);
    for (const r of st.rows) {
      // Parts under 5 ms would read 0.00: left out.
      const parts = r.spans.filter((x) => x.end - x.start >= 5).map((x) => `${SHORT[x.kind]} ${((x.end - x.start) / 1000).toFixed(2)}${x.ok === false ? '✗' : ''}`);
      const during = r.during >= 10 ? ` (+ parse ${(r.during / 1000).toFixed(2)} meanwhile)` : '';
      const notes = r.notes.length ? ` [${r.notes.join('; ')}]` : '';
      lines.push(`  ${r.query}: ${((r.start - p.startedAt) / 1000).toFixed(2)}–${((r.end - p.startedAt) / 1000).toFixed(2)}, ${r.how}: ${parts.join(', ')}${during}${notes}`);
    }
  }
  return lines.join('\n');
}
