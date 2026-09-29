import { money } from '../ui/theme';
import { MAX_RUNNING_JOBS } from './config';
import {
  checkRequest,
  jobStatus,
  retailerCost,
  runningCloudJobs,
  storeConfirmed,
  type CloudItem,
  type CloudJob,
  type CompareSide,
  type JobRequest,
  type JobStatus,
  type RequestProblem,
  type RetailerRun,
  type RetailerStatus,
  type TermResult,
} from './jobs';
import { costWords, estimate, problemWords, reasonWords, RETAILER_NAMES } from './words';

// Pure TypeScript: Phone vs. cloud. The same terms at the same stores (Walmart's and Target's, as set in Your stores),
// searched at once on this phone, the way the app prices, and in Browser Use's cloud: the scripted browser, and the
// agent when asked. Each side is an ordinary cloud job (jobs.ts) tagged with the comparison's id, run by the runner
// like any other; this file groups them, checks a comparison can start, and says how the sides compare: which stores
// each got prices from and for which store, what each took in time, data and money, and the same products' prices,
// matched by the retailer's own item number (Walmart's usItemId, Target's TCIN). The phone is the reference: it's set
// to the store on the retailer's own site, the way the app always prices.

export type CompareRetailerId = 'walmart' | 'target';
export const COMPARE_RETAILERS: CompareRetailerId[] = ['walmart', 'target'];
export const SIDES: CompareSide[] = ['phone', 'scripted', 'agent'];
export const SIDE_NAMES: Record<CompareSide, string> = { phone: 'This phone', scripted: 'Cloud browser', agent: 'AI agent' };
/** The same, within a sentence. */
export const SIDE_WORDS: Record<CompareSide, string> = { phone: 'this phone', scripted: 'the cloud browser', agent: 'the AI agent' };
/** Where a side's data went: this phone's own, or Browser Use's. */
const VIA: Record<CompareSide, JobRequest['retailers'][number]['via']> = { phone: 'device', scripted: 'browser', agent: 'agent' };

export interface CompareRequest {
  terms: string[];
  /** Each store as set in Your stores: the phone's side is priced there, on the retailer's own site. */
  retailers: { retailerId: CompareRetailerId; storeId: string }[];
  /** The Browser Use agent as a third side. */
  agent: boolean;
}

/** A comparison, as its sides' jobs make it up. */
export interface Comparison {
  id: string;
  terms: string[];
  createdAt: number;
  retailers: { retailerId: CompareRetailerId; storeId: string }[];
  sides: Partial<Record<CompareSide, CloudJob>>;
}

/** The comparisons among `jobs`, newest first. */
export function comparisons(jobs: CloudJob[]): Comparison[] {
  const byId = new Map<string, Comparison>();
  for (const job of jobs) {
    if (!job.compare) continue;
    let c = byId.get(job.compare.id);
    if (!c) {
      c = {
        id: job.compare.id,
        terms: job.terms,
        createdAt: job.createdAt,
        retailers: job.retailers.map((r) => ({ retailerId: r.retailerId as CompareRetailerId, storeId: r.storeId })),
        sides: {},
      };
      byId.set(c.id, c);
    }
    c.sides[job.compare.side] = job;
    c.createdAt = Math.min(c.createdAt, job.createdAt);
  }
  return [...byId.values()].sort((a, b) => b.createdAt - a.createdAt);
}

export const comparisonOf = (jobs: CloudJob[], id: string): Comparison | undefined => comparisons(jobs.filter((j) => j.compare?.id === id))[0];

/** The sides present, in their order: the phone, the cloud browser, the agent. */
export const sidesOf = (c: Comparison): CompareSide[] => SIDES.filter((s) => c.sides[s]);

/**
 * Running while any side runs; else cancelled if the user stopped it (any store of any side cancelled: a cut-off store
 * of a comparison stopped by the user doesn't make it interrupted); else interrupted if a store was cut off; else done.
 */
export function comparisonStatus(c: Comparison): JobStatus {
  const jobs = Object.values(c.sides);
  if (jobs.some((j) => jobStatus(j) === 'running')) return 'running';
  const runs = jobs.flatMap((j) => j.retailers);
  if (runs.some((r) => r.status === 'cancelled')) return 'cancelled';
  if (runs.some((r) => r.status === 'interrupted')) return 'interrupted';
  return 'done';
}

/** The jobs a comparison starts: this phone's, the cloud browser's, and the agent's when asked. */
export function comparisonJobs(req: CompareRequest): { side: CompareSide; request: JobRequest }[] {
  const sides: CompareSide[] = req.agent ? ['phone', 'scripted', 'agent'] : ['phone', 'scripted'];
  return sides.map((side) => ({
    side,
    request: { engine: side === 'agent' ? 'agent' : 'scripted', terms: req.terms, retailers: req.retailers.map((r) => ({ ...r, via: VIA[side] })) },
  }));
}

export type CompareProblem = RequestProblem | { problem: 'comparison_running' } | { problem: 'too_many_for_comparison'; running: number; sides: number };

/**
 * The guardrails for a comparison: each side's as a job's (1 to MAX_TERMS terms, one store per retailer with its
 * number, a key and MIN_BALANCE_USD of credit for the cloud); its cloud sides and the cloud jobs running together at
 * most MAX_RUNNING_JOBS; and one comparison at a time, since its phone side needs this phone's own searches.
 */
export function checkComparison(
  req: CompareRequest,
  ctx: { jobs: CloudJob[]; hasKey: boolean; balanceUsd?: number; balanceError?: string },
): { ok: true } | ({ ok: false } & CompareProblem) {
  if (comparisons(ctx.jobs).some((c) => comparisonStatus(c) === 'running')) return { ok: false, problem: 'comparison_running' };
  const sides = comparisonJobs(req);
  for (const { request } of sides) {
    // The running jobs are counted below, for the cloud sides together.
    const check = checkRequest(request, { ...ctx, jobs: [] });
    if (!check.ok) return check;
  }
  const cloud = sides.filter((s) => s.side !== 'phone').length;
  const running = runningCloudJobs(ctx.jobs).length;
  if (running + cloud > MAX_RUNNING_JOBS) return { ok: false, problem: 'too_many_for_comparison', running, sides: cloud };
  return { ok: true };
}

/** Why a comparison couldn't start, in words. */
export function compareProblemWords(p: CompareProblem): string {
  if (p.problem === 'comparison_running') return 'A comparison is running already: one at a time, since this phone searches its side itself.';
  if (p.problem === 'too_many_for_comparison') {
    return `This comparison runs ${p.sides} cloud searches at once, and ${p.running} ${p.running === 1 ? 'is' : 'are'} running already (at most ${MAX_RUNNING_JOBS} at once). Start it when ${p.running === 1 ? 'that one is' : 'they are'} done${p.sides > 1 ? ', or leave the agent out' : ''}.`;
  }
  return problemWords(p);
}

/** What a comparison may cost before it starts: its cloud sides' estimates (see estimate); the phone's side is free. */
export function comparisonEstimate(req: CompareRequest): { usd: number; capped: boolean } {
  return comparisonJobs(req)
    .filter((s) => s.side !== 'phone')
    .map((s) => estimate(s.request))
    .reduce((a, b) => ({ usd: a.usd + b.usd, capped: a.capped || b.capped }), { usd: 0, capped: false });
}

// --- How the sides compare --------------------------------------------------------------------------------------

/** One side at one store, in figures. */
export interface SideFigures {
  side: CompareSide;
  status: RetailerStatus;
  reason?: string;
  /** Searches that came back with products, and every product they listed. */
  searched: number;
  products: number;
  /** Every search that came back said it priced the store asked for (see storeConfirmed). */
  confirmed: boolean;
  /** The store a search's data said instead, when one said another. */
  otherStore?: string;
  /** From its start to its end. */
  totalMs?: number;
  /** Before its first search began: for the cloud browser, starting it and setting its store. */
  setupMs?: number;
  /** A search's time, the median of its searches'. */
  searchMs?: number;
  /** Data this phone moved: its own searches' on the phone's side; driving the cloud browser (the DevTools link) on the cloud browser's. */
  phoneBytes?: number;
  /** Data moved in the cloud: through Browser Use's proxy as it reported it, else as the app metered the page. */
  cloudMb?: number;
  usd: number;
  checkSeen: boolean;
}

const median = (xs: number[]): number | undefined => {
  if (!xs.length) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

/** A comparison side's run at a store. */
export const sideRun = (c: Comparison, side: CompareSide, retailerId: CompareRetailerId): RetailerRun | undefined =>
  c.sides[side]?.retailers.find((r) => r.retailerId === retailerId);

export function sideFigures(side: CompareSide, run: RetailerRun): SideFigures {
  const done = run.results.filter((r) => r.status === 'done');
  const timed = run.results.filter((r) => r.ms !== undefined);
  const firstBegan = timed.length ? Math.min(...timed.map((r) => r.at - r.ms!)) : undefined;
  const searchMs = median(done.filter((r) => r.ms !== undefined).map((r) => r.ms!));
  const cost = retailerCost(run);
  const phoneBytes = side === 'phone' ? sum(run.results.map((r) => r.bytes)) : side === 'scripted' ? run.wireBytes : undefined;
  const cloudMb = side === 'phone' ? undefined : cost.proxyMb || (run.bytes ? run.bytes / 1e6 : undefined);
  const other = run.results.find((r) => r.storeMatches === false);
  return {
    side,
    status: run.status,
    ...(run.reason ? { reason: run.reason } : {}),
    searched: done.length,
    products: done.reduce((n, r) => n + (r.found ?? r.items.length), 0),
    confirmed: storeConfirmed(run),
    ...(other?.pageStoreId ? { otherStore: other.pageStoreId } : {}),
    ...(run.startedAt !== undefined && run.finishedAt !== undefined ? { totalMs: run.finishedAt - run.startedAt } : {}),
    ...(side !== 'phone' && run.startedAt !== undefined && firstBegan !== undefined ? { setupMs: Math.max(0, firstBegan - run.startedAt) } : {}),
    ...(searchMs !== undefined ? { searchMs } : {}),
    ...(phoneBytes !== undefined ? { phoneBytes } : {}),
    ...(cloudMb ? { cloudMb } : {}),
    usd: cost.usd,
    checkSeen: !!run.checkSeen || run.results.some((r) => r.status === 'blocked'),
  };
}

function sum(xs: (number | undefined)[]): number | undefined {
  const known = xs.filter((x): x is number => x !== undefined);
  return known.length ? known.reduce((a, b) => a + b, 0) : undefined;
}

/** A product both sides listed, at different prices. */
export interface PriceGap {
  itemId: string;
  name: string;
  phone: number | null;
  cloud: number | null;
  phoneWas?: number;
  cloudWas?: number;
}

/** One term at one store: what the phone and one cloud side listed, and the same products' prices. */
export interface TermMatch {
  term: string;
  phone?: TermResult;
  cloud?: TermResult;
  /** Products both kept (up to 20 a side), by the retailer's item number; how many had the same price. */
  both: number;
  same: number;
  differ: PriceGap[];
  onlyPhone: number;
  onlyCloud: number;
}

/** The retailer's item number, however a side wrote it ("10450114", "ID 10450114", a link ending in it). */
export function itemKey(id: string): string {
  const digits = /\d{5,}(?!.*\d{5,})/.exec(id)?.[0];
  return (digits ?? id.trim().toLowerCase()).replace(/^0+(?=\d)/, '');
}

const samePrice = (a: number | null, b: number | null) => (a === null || b === null ? a === b : Math.abs(a - b) < 0.005);

export function matchTerm(term: string, phone: RetailerRun | undefined, cloud: RetailerRun | undefined): TermMatch {
  const p = phone?.results.find((r) => r.term === term);
  const c = cloud?.results.find((r) => r.term.toLowerCase() === term.toLowerCase());
  const phoneItems = p?.status === 'done' ? p.items : [];
  const cloudItems = c?.status === 'done' ? c.items : [];
  const cloudBy = new Map<string, CloudItem>();
  for (const item of cloudItems) if (!cloudBy.has(itemKey(item.itemId))) cloudBy.set(itemKey(item.itemId), item);
  let both = 0;
  let same = 0;
  const differ: PriceGap[] = [];
  const matched = new Set<string>();
  for (const item of phoneItems) {
    const key = itemKey(item.itemId);
    const other = cloudBy.get(key);
    if (!other || matched.has(key)) continue;
    matched.add(key);
    both++;
    if (samePrice(item.price, other.price)) same++;
    else
      differ.push({
        itemId: item.itemId,
        name: item.name,
        phone: item.price,
        cloud: other.price,
        ...(item.wasPrice !== undefined ? { phoneWas: item.wasPrice } : {}),
        ...(other.wasPrice !== undefined ? { cloudWas: other.wasPrice } : {}),
      });
  }
  const phoneKeys = new Set(phoneItems.map((i) => itemKey(i.itemId)));
  return {
    term,
    ...(p ? { phone: p } : {}),
    ...(c ? { cloud: c } : {}),
    both,
    same,
    differ,
    onlyPhone: phoneKeys.size - matched.size,
    onlyCloud: [...cloudBy.keys()].filter((k) => !phoneKeys.has(k)).length,
  };
}

export interface SideSummary {
  side: CompareSide;
  stores: number;
  /** Stores it got prices from, and of those, the ones whose prices were confirmed for the store. */
  withPrices: number;
  confirmed: number;
  blocked: number;
  /** The slowest store's time: the stores run at once. */
  totalMs?: number;
  phoneBytes?: number;
  cloudMb?: number;
  usd: number;
}

export interface ComparisonSummary {
  sides: SideSummary[];
  /** For each cloud side: the same products' prices against the phone's, every store and term. */
  prices: { side: Exclude<CompareSide, 'phone'>; both: number; same: number; differ: number }[];
}

export function comparisonSummary(c: Comparison): ComparisonSummary {
  const sides = sidesOf(c).map((side): SideSummary => {
    const figures = c.retailers.map((r) => sideRun(c, side, r.retailerId)).filter((r): r is RetailerRun => !!r).map((r) => sideFigures(side, r));
    const totals = figures.map((f) => f.totalMs).filter((ms): ms is number => ms !== undefined);
    const phoneBytes = sum(figures.map((f) => f.phoneBytes));
    const cloudMb = sum(figures.map((f) => f.cloudMb));
    return {
      side,
      stores: figures.length,
      withPrices: figures.filter((f) => f.status === 'done' && f.searched > 0).length,
      confirmed: figures.filter((f) => f.status === 'done' && f.confirmed).length,
      blocked: figures.filter((f) => f.status === 'blocked').length,
      ...(totals.length ? { totalMs: Math.max(...totals) } : {}),
      ...(phoneBytes !== undefined ? { phoneBytes } : {}),
      ...(cloudMb !== undefined ? { cloudMb } : {}),
      usd: Math.round(figures.reduce((n, f) => n + f.usd, 0) * 1e6) / 1e6,
    };
  });
  const prices = (['scripted', 'agent'] as const)
    .filter((side) => c.sides[side])
    .map((side) => {
      let both = 0;
      let same = 0;
      let differ = 0;
      for (const r of c.retailers) {
        for (const term of c.terms) {
          const m = matchTerm(term, sideRun(c, 'phone', r.retailerId), sideRun(c, side, r.retailerId));
          both += m.both;
          same += m.same;
          differ += m.differ.length;
        }
      }
      return { side, both, same, differ };
    });
  return { sides, prices };
}

// --- In words ---------------------------------------------------------------------------------------------------

/** "12 s", "2 min 5 s". */
export function durationWords(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${Math.max(s, ms > 0 ? 1 : 0)} s`;
  const m = Math.floor(s / 60);
  return s % 60 ? `${m} min ${s % 60} s` : `${m} min`;
}

/** "3.2 MB", "240 KB". */
export function dataWords(bytes: number): string {
  return bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}

/** A side's store line: "Done, prices for store 5260", "Blocked by a bot check: …", "Searching". */
export function sideStatusWords(f: SideFigures, storeId: string): string {
  if (f.status === 'done') {
    if (f.otherStore) return `Done, but a search priced store ${f.otherStore}, not ${storeId}`;
    return f.confirmed ? `Prices for store ${storeId}` : `Done, store ${storeId} not confirmed`;
  }
  const words: Record<RetailerStatus, string> = {
    queued: 'Waiting',
    running: 'Searching',
    done: 'Done',
    blocked: 'Blocked',
    failed: 'Failed',
    interrupted: 'Interrupted',
    cancelled: 'Cancelled',
  };
  const why = reasonWords(f.reason);
  return why && f.status !== 'running' && f.status !== 'queued' ? `${words[f.status]}: ${why}` : words[f.status];
}

/** A side's figures in a line: "2 searches, 40 products · 45 s (22 s to set up, a search 9 s) · 5.2 MB proxy, 0.2 MB on this phone · $0.04". */
export function sideFigureWords(f: SideFigures): string {
  const parts = [f.setupMs !== undefined && f.setupMs >= 1000 ? `${durationWords(f.setupMs)} to set up` : '', f.searchMs !== undefined ? `a search ${durationWords(f.searchMs)}` : ''].filter(Boolean);
  const time = f.totalMs !== undefined ? `${durationWords(f.totalMs)}${parts.length ? ` (${parts.join(', ')})` : ''}` : '';
  const data =
    f.side === 'phone'
      ? f.phoneBytes !== undefined
        ? `${dataWords(f.phoneBytes)} of this phone’s data`
        : ''
      : [f.cloudMb ? `${f.cloudMb.toFixed(1)} MB through the proxy` : '', f.phoneBytes !== undefined ? `${dataWords(f.phoneBytes)} on this phone` : ''].filter(Boolean).join(', ');
  const cost = f.side === 'phone' ? 'free' : f.usd > 0 ? costWords(f.usd) : '';
  return [f.searched || f.products ? `${f.searched} ${f.searched === 1 ? 'search' : 'searches'}, ${f.products} ${f.products === 1 ? 'product' : 'products'}` : '', time, data, cost]
    .filter(Boolean)
    .join(' · ');
}

/** A side's result in a line: "This phone: prices from 2 of 2 stores, 38 s, 6.1 MB of this phone's data, free." */
export function sideSummaryWords(s: SideSummary): string {
  const parts = [`prices from ${s.withPrices} of ${s.stores} ${s.stores === 1 ? 'store' : 'stores'}${s.withPrices && s.confirmed < s.withPrices ? ` (confirmed for ${s.confirmed})` : ''}`];
  if (s.blocked) parts.push(`${s.blocked} blocked`);
  if (s.totalMs !== undefined) parts.push(durationWords(s.totalMs));
  if (s.side === 'phone') {
    if (s.phoneBytes !== undefined) parts.push(`${dataWords(s.phoneBytes)} of this phone’s data`);
    parts.push('free');
  } else {
    if (s.cloudMb) parts.push(`${s.cloudMb.toFixed(1)} MB through Browser Use’s proxy`);
    if (s.phoneBytes !== undefined) parts.push(`${dataWords(s.phoneBytes)} on this phone`);
    parts.push(s.usd > 0 ? costWords(s.usd) : 'no cost reported yet');
  }
  return `${SIDE_NAMES[s.side]}: ${parts.join(', ')}.`;
}

/** The same products' prices, in a line: "Same product, same price: 38 of 40 (cloud browser against this phone)." */
export function pricesWords(p: ComparisonSummary['prices'][number]): string {
  const who = `${SIDE_WORDS[p.side].replace(/^the /, '')} against this phone`;
  if (!p.both) return `No product was listed by both sides (${who}).`;
  return `Same product, same price: ${p.same} of ${p.both}${p.differ ? `; ${p.differ} differ` : ''} (${who}).`;
}

/** A price in a gap: "$3.32", "$2.50 (was $3.00)", "no price". */
const priceWords = (price: number | null, was?: number) => (price === null ? 'no price' : `${money(price)}${was !== undefined ? ` (was ${money(was)})` : ''}`);

/** One gap: "Great Value Whole Milk, 1 gal: $3.32 on this phone, $3.48 in the cloud browser". */
export function gapWords(g: PriceGap, side: Exclude<CompareSide, 'phone'>): string {
  return `${g.name}: ${priceWords(g.phone, g.phoneWas)} on this phone, ${priceWords(g.cloud, g.cloudWas)} ${side === 'agent' ? 'from the AI agent' : 'in the cloud browser'}`;
}

/** What the notification and the banner say when a comparison is over. */
export function comparisonNotice(c: Comparison): { title: string; body: string } {
  const status = comparisonStatus(c);
  const summary = comparisonSummary(c);
  const what = c.terms.length === 1 ? `“${c.terms[0]}”` : `${c.terms.length} searches`;
  if (status === 'interrupted') return { title: 'Phone vs. cloud interrupted', body: `${what}: open it to run it again.` };
  if (status === 'cancelled') return { title: 'Phone vs. cloud cancelled', body: `${what}: what came back before stays.` };
  const sides = summary.sides.map((s) => `${SIDE_NAMES[s.side]} ${s.withPrices} of ${s.stores}`);
  const same = summary.prices.find((p) => p.side === 'scripted');
  return {
    title: `Phone vs. cloud ready: ${what}`,
    body: [...sides, ...(same?.both ? [`same price ${same.same} of ${same.both}`] : [])].join(' · '),
  };
}

/** The whole comparison as text, to share: the summary, then each store, side by side, and the prices that differ. */
export function comparisonText(c: Comparison, heading: string): string {
  const summary = comparisonSummary(c);
  const lines = [heading, `Searched: ${c.terms.join(', ')} · ${c.retailers.map((r) => `${RETAILER_NAMES[r.retailerId]} store ${r.storeId}`).join(', ')}`, ''];
  for (const s of summary.sides) lines.push(sideSummaryWords(s));
  for (const p of summary.prices) lines.push(pricesWords(p));
  for (const r of c.retailers) {
    lines.push('', `${RETAILER_NAMES[r.retailerId]} (store ${r.storeId})`);
    for (const side of sidesOf(c)) {
      const run = sideRun(c, side, r.retailerId);
      if (!run) continue;
      const f = sideFigures(side, run);
      lines.push(`- ${SIDE_NAMES[side]}: ${sideStatusWords(f, r.storeId)}${sideFigureWords(f) ? ` · ${sideFigureWords(f)}` : ''}`);
    }
    for (const side of ['scripted', 'agent'] as const) {
      if (!c.sides[side]) continue;
      for (const term of c.terms) {
        const m = matchTerm(term, sideRun(c, 'phone', r.retailerId), sideRun(c, side, r.retailerId));
        if (!m.phone && !m.cloud) continue;
        const who = SIDE_WORDS[side];
        if (m.phone?.status !== 'done' || m.cloud?.status !== 'done') {
          const why = (x: TermResult | undefined) => (!x ? 'not searched' : reasonWords(x.reason) || x.status);
          const parts = [m.phone?.status !== 'done' ? `this phone: ${why(m.phone)}` : '', m.cloud?.status !== 'done' ? `${who}: ${why(m.cloud)}` : ''].filter(Boolean);
          lines.push(`  “${term}”, this phone and ${who}: nothing to compare (${parts.join('; ')}).`);
          continue;
        }
        const line = m.both
          ? `  “${term}”, this phone and ${who}: ${m.both} products on both, ${m.same} the same price${m.onlyPhone || m.onlyCloud ? `; ${m.onlyPhone} only on the phone, ${m.onlyCloud} only in the cloud` : ''}.`
          : `  “${term}”, this phone and ${who}: no product on both.`;
        lines.push(line);
        for (const g of m.differ) lines.push(`    ${gapWords(g, side)}`);
      }
    }
  }
  return lines.join('\n');
}
