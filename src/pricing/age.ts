import type { PricingRun } from './pricingEngine';

// Pure functions only, so the tests run them in Node.

export interface Staleness {
  /** When the oldest price shown from an earlier search was read. */
  oldestAt?: number;
  /** Older prices shown while fresh searches run. */
  refreshing: number;
  /** Older prices kept because a fresh search failed. */
  notRefreshed: number;
}

/** How old the prices a store is showing are. */
export function staleness(run: PricingRun | undefined, retailerId: string): Staleness {
  const stale = Object.values(run?.results[retailerId] ?? {}).filter((r) => r.stale && r.products.length);
  return {
    oldestAt: stale.length ? Math.min(...stale.map((r) => r.at ?? Date.now())) : undefined,
    refreshing: stale.filter((r) => r.status === 'queued' || r.status === 'searching').length,
    notRefreshed: stale.filter((r) => r.status === 'done').length,
  };
}

/** "just now", "12 min ago", "5 h ago". */
export function ago(ms: number): string {
  const min = Math.floor(ms / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  return `${Math.floor(min / 60)} h ago`;
}
