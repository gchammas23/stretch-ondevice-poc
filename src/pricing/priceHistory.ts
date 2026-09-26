import type { Product } from '../onDevice/types';

// Pure TypeScript: the app saves it with AsyncStorage, the tests keep it in memory.

/** One price, from when it was first read to when it was last read. */
export interface PricePoint {
  price: number;
  /** First read at this price. */
  at: number;
  /** Last read at this price. */
  seen: number;
}

export interface PriceChange {
  /** New price minus the one before it: negative when it went down. */
  delta: number;
  from: number;
  to: number;
  /** When the old price was last read. */
  since: number;
}

const POINTS_KEPT = 30;
const PRODUCTS_KEPT = 4000;
/** Products not seen for this long are forgotten. */
const KEEP_MS = 60 * 24 * 60 * 60_000;

/**
 * Every price the phone has read for each product at each store, so a fresh price can say how it moved
 * ("↓ $0.30 since yesterday") and a product can show its history. Kept on the phone only.
 */
export class PriceHistory {
  private rows = new Map<string, PricePoint[]>();
  private listeners = new Set<() => void>();
  private changes = 0;

  constructor(private now: () => number = Date.now) {}

  static key(retailerId: string, storeKey: string, productId: string): string {
    return `${retailerId}|${storeKey}|${productId}`;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Records a search's products as read at `at`. */
  record(retailerId: string, storeKey: string, products: Product[], at: number = this.now()): void {
    let changed = false;
    for (const p of products) {
      if (typeof p.price !== 'number' || !Number.isFinite(p.price) || p.price <= 0) continue;
      const key = PriceHistory.key(retailerId, storeKey, p.id);
      const points = this.rows.get(key) ?? [];
      const last = points[points.length - 1];
      // Only news goes in: a price read before the latest one known would put the history out of order.
      if (last && at <= last.seen) continue;
      let next: PricePoint[];
      if (last && Math.abs(last.price - p.price) < 0.005) {
        next = [...points.slice(0, -1), { ...last, seen: at }];
      } else {
        next = [...points, { price: p.price, at, seen: at }].slice(-POINTS_KEPT);
      }
      // Re-inserted, so the Map's first keys are the least recently seen.
      this.rows.delete(key);
      this.rows.set(key, next);
      changed = true;
    }
    if (!changed) return;
    while (this.rows.size > PRODUCTS_KEPT) this.rows.delete(this.rows.keys().next().value!);
    this.emit();
  }

  /** Goes up with every change, for re-rendering. */
  get version(): number {
    return this.changes;
  }

  private emit(): void {
    this.changes += 1;
    this.listeners.forEach((listener) => listener());
  }

  points(retailerId: string, storeKey: string, productId: string): PricePoint[] {
    return this.rows.get(PriceHistory.key(retailerId, storeKey, productId)) ?? [];
  }

  /** How the latest price differs from the one before it, if it ever changed (within `withinMs`, if given). */
  change(retailerId: string, storeKey: string, productId: string, withinMs?: number): PriceChange | null {
    const points = this.points(retailerId, storeKey, productId);
    if (points.length < 2) return null;
    const prev = points[points.length - 2];
    const cur = points[points.length - 1];
    if (withinMs !== undefined && this.now() - cur.at > withinMs) return null;
    return { delta: Math.round((cur.price - prev.price) * 100) / 100, from: prev.price, to: cur.price, since: prev.seen };
  }

  clear(): void {
    this.rows.clear();
    this.emit();
  }

  get size(): number {
    return this.rows.size;
  }

  serialize(): string {
    const cutoff = this.now() - KEEP_MS;
    return JSON.stringify([...this.rows].filter(([, points]) => points[points.length - 1].seen >= cutoff));
  }

  hydrate(json: string | null): void {
    if (!json) return;
    try {
      const rows = JSON.parse(json) as [string, PricePoint[]][];
      if (!Array.isArray(rows)) return;
      for (const [k, points] of rows) {
        const ok =
          typeof k === 'string' &&
          Array.isArray(points) &&
          points.length > 0 &&
          points.every((p) => p && typeof p.price === 'number' && typeof p.at === 'number' && typeof p.seen === 'number');
        if (ok) this.rows.set(k, points);
      }
      this.changes += 1;
    } catch {
      // A corrupt save just means starting the history again.
    }
  }
}
