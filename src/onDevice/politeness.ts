import { NOTES, type AttemptEntry } from './attemptLog';

// Pure TypeScript: how much the phone asks of each store, and the limit it keeps to. A person shopping searches a
// store's site now and then, one page at a time; the app stays at that scale: one page load at a time per store
// (see webviewQueue.ts), and no more than MAX_SEARCHES_PER_HOUR searches at one store in any hour.

/** Searches one store gets from this phone in any hour, at most: one every 30 seconds on average. */
export const MAX_SEARCHES_PER_HOUR = 120;
const HOUR = 60 * 60_000;

/**
 * Kinds of attempt that are searches of the store's site (not store finders or single product pages): the phone vs.
 * server test's too, its page and its plain request.
 */
const SEARCHES = new Set(['search', 'coverage', 'versus']);
/** Kinds that count toward the hourly limit: searches, and pages read for the store's weekly ad and coupons. */
const COUNTED = new Set([...SEARCHES, 'ad', 'coupons', 'clip']);

/** Each store's searches in the last hour, to keep under the limit. */
export class Politeness {
  private times = new Map<string, number[]>();

  constructor(
    readonly perHour = MAX_SEARCHES_PER_HOUR,
    private now: () => number = Date.now,
  ) {}

  /** Searches from the saved log count too, so closing and opening the app doesn't reset the hour. */
  seed(entries: Pick<AttemptEntry, 'at' | 'retailerId' | 'kind'>[]): void {
    const since = this.now() - HOUR;
    for (const e of entries) {
      if (e.at < since || !COUNTED.has(e.kind)) continue;
      const list = this.recent(e.retailerId);
      if (!list.includes(e.at)) list.push(e.at);
    }
    for (const list of this.times.values()) list.sort((a, b) => a - b);
  }

  /** Takes a search's place in the hour; false when the store has had its fill, and the search mustn't go out. */
  take(retailerId: string): boolean {
    const list = this.recent(retailerId);
    if (list.length >= this.perHour) return false;
    list.push(this.now());
    return true;
  }

  /** Searches at the store in the last hour. */
  used(retailerId: string): number {
    return this.recent(retailerId).length;
  }

  /**
   * The first moment the store has room for `n` more searches: now, or once enough of its last hour's searches are an
   * hour old. Never, for more than it takes in an hour.
   */
  roomAt(retailerId: string, n: number): number {
    if (n > this.perHour) return Infinity;
    const list = [...this.recent(retailerId)].sort((a, b) => a - b);
    const over = list.length + n - this.perHour;
    return over <= 0 ? this.now() : list[over - 1] + HOUR + 1;
  }

  reset(): void {
    this.times.clear();
  }

  private recent(retailerId: string): number[] {
    const since = this.now() - HOUR;
    const list = (this.times.get(retailerId) ?? []).filter((t) => t >= since);
    this.times.set(retailerId, list);
    return list;
  }
}

/** The app's own: every search goes through it. */
export const politeness = new Politeness();

/** What the phone asked of one store since `since`. */
export interface CitizenRow {
  retailerId: string;
  /** Searches: each is one request to the store, or one page load. */
  searches: number;
  /** Of those, full page loads (a hidden page, or a plain request for the search page). */
  pageLoads: number;
  /** Sent from a page already open, as the page's own request. */
  reused: number;
  /** Through the store's official API. */
  api: number;
  /** Other pages read: products, store finders, fees pages, weekly ads and coupons. */
  otherPages: number;
  bytes: number;
  /** Data not used by asking for only the results the app keeps, about. */
  bytesSaved: number;
  /** The most visits in any one hour that count toward the limit: searches, weekly ads and coupons. */
  busiestHour: number;
}

/** Each store's asks since `since`, busiest first. */
export function citizenReport(entries: AttemptEntry[], since: number): CitizenRow[] {
  const rows = new Map<string, CitizenRow & { times: number[] }>();
  for (const e of entries) {
    // Cool-downs and connection drops are notes in the log, not visits to a store.
    if (e.at < since || NOTES.has(e.kind)) continue;
    const row =
      rows.get(e.retailerId) ??
      ({ retailerId: e.retailerId, searches: 0, pageLoads: 0, reused: 0, api: 0, otherPages: 0, bytes: 0, bytesSaved: 0, busiestHour: 0, times: [] } as CitizenRow & { times: number[] });
    rows.set(e.retailerId, row);
    row.bytes += e.bytes ?? 0;
    row.bytesSaved += e.bytesSaved ?? 0;
    if (COUNTED.has(e.kind)) row.times.push(e.at);
    if (!SEARCHES.has(e.kind)) {
      row.otherPages += 1;
      continue;
    }
    row.searches += 1;
    if (e.strategy === 'api') row.api += 1;
    else if (e.via === 'replay') row.reused += 1;
    else row.pageLoads += 1;
  }
  return [...rows.values()]
    .map(({ times, ...row }) => ({ ...row, busiestHour: busiest(times) }))
    .sort((a, b) => b.searches + b.otherPages - (a.searches + a.otherPages));
}

/** The most timestamps within any one hour. */
function busiest(times: number[]): number {
  const t = [...times].sort((a, b) => a - b);
  let most = 0;
  for (let i = 0, j = 0; i < t.length; i++) {
    while (t[i] - t[j] >= HOUR) j++;
    most = Math.max(most, i - j + 1);
  }
  return most;
}
