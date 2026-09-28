import type { AttemptEntry } from '../onDevice/attemptLog';

// Pure functions only, so the tests run them in Node.
//
// What reading the same prices would cost from servers, next to reading them on the users' phones. The phone's own
// measurements (data and time per search) come from its search log; everything else is an assumption the user can
// change: the model is a way to argue with numbers, not a quote.

export interface CostInputs {
  users: number;
  listsPerWeek: number;
  itemsPerList: number;
  stores: number;
  /** Residential proxies, so stores don't block the servers outright: dollars per GB through them. */
  proxyPerGb: number;
  /** Share of server searches that meet a bot check (0 to 1). */
  botCheckRate: number;
  /** Solving a bot check with a paid service: dollars per 1,000. */
  solvePer1000: number;
  /** A headless browser on a server: dollars per hour of browser time. */
  browserPerHour: number;
}

export const DEFAULT_INPUTS: CostInputs = {
  users: 100_000,
  listsPerWeek: 2,
  itemsPerList: 20,
  stores: 4,
  proxyPerGb: 4,
  botCheckRate: 0.3,
  solvePer1000: 2,
  browserPerHour: 0.1,
};

/** What the phone measured per search: data and time. */
export interface Measured {
  bytesPerSearch: number;
  msPerSearch: number;
  /** Searches the averages come from; 0 means they're the starting estimates. */
  searches: number;
}

/** Starting estimates, until the phone has searched: a hidden page load averaged with the requests reused after it. */
export const ESTIMATED: Measured = { bytesPerSearch: 250_000, msPerSearch: 2500, searches: 0 };

/** Weeks in a month, on average. */
const WEEKS = 52 / 12;

export interface CostResult {
  searchesPerMonth: number;
  /** From servers, per month: through proxies, bot checks solved, browser time, and all together. */
  proxy: number;
  solving: number;
  browsers: number;
  total: number;
  perUser: number;
  /** On the phones: what Stretch pays (nothing), and the data each phone uses a month. */
  phoneBytesPerUserMonth: number;
}

/**
 * The phone's averages over the searches in its log that worked and say how much data they moved. The store check's
 * aren't counted: each is a page load at a store the app doesn't otherwise search, far heavier than a list's searches,
 * most of which are sent from a page already open.
 */
export function measuredFrom(entries: AttemptEntry[]): Measured {
  const searches = entries.filter((e) => e.kind === 'search' && e.ok && typeof e.bytes === 'number' && e.bytes > 0);
  if (searches.length < 3) return ESTIMATED;
  const bytes = searches.reduce((n, e) => n + (e.bytes ?? 0), 0) / searches.length;
  const ms = searches.reduce((n, e) => n + e.ms, 0) / searches.length;
  return { bytesPerSearch: Math.round(bytes), msPerSearch: Math.round(ms), searches: searches.length };
}

/** The month's cost of reading every user's lists at every store from servers, against doing it on their phones. */
export function monthlyCost(inputs: CostInputs, measured: Measured): CostResult {
  const n = (v: number) => (Number.isFinite(v) && v > 0 ? v : 0);
  const searchesPerUser = n(inputs.listsPerWeek) * WEEKS * n(inputs.itemsPerList) * n(inputs.stores);
  const searchesPerMonth = Math.round(n(inputs.users) * searchesPerUser);
  const gb = (searchesPerMonth * measured.bytesPerSearch) / 1e9;
  const proxy = gb * n(inputs.proxyPerGb);
  const solving = ((searchesPerMonth * Math.min(1, n(inputs.botCheckRate))) / 1000) * n(inputs.solvePer1000);
  const browsers = ((searchesPerMonth * measured.msPerSearch) / 3_600_000) * n(inputs.browserPerHour);
  const total = proxy + solving + browsers;
  return {
    searchesPerMonth,
    proxy: round(proxy),
    solving: round(solving),
    browsers: round(browsers),
    total: round(total),
    perUser: n(inputs.users) ? round(total / inputs.users, 4) : 0,
    phoneBytesPerUserMonth: Math.round(searchesPerUser * measured.bytesPerSearch),
  };
}

function round(n: number, places = 2): number {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}
