import type { KnownStore, Product } from '../onDevice/types';

// Pure TypeScript: the app saves it with AsyncStorage, the tests keep it in memory.

export interface CachedSearch {
  products: Product[];
  /** When it was searched. */
  at: number;
  /** How long the search took on the phone. */
  ms: number;
  strategy?: string;
  via?: 'page' | 'replay';
  source?: string;
  /** Products the search returned, before keeping the top PRODUCTS_KEPT. */
  found?: number;
  note?: string;
  /** The store the prices are for, as far as the search showed it. */
  store?: KnownStore;
}

/** Prices change during the day, but not by the minute: a search is reused for this long. */
export const PRICE_TTL_MS = 2 * 60 * 60_000;
/** Older searches are still shown while fresh ones load, up to this age, labeled with it. */
export const MAX_AGE_MS = 24 * 60 * 60_000;
/** Results kept per search. The top result is the pick; the rest are the Similar items. */
export const PRODUCTS_KEPT = 12;
const MAX_ENTRIES = 600;

export class PriceCache {
  private entries = new Map<string, CachedSearch>();
  private listeners = new Set<() => void>();
  private changes = 0;

  constructor(
    readonly ttlMs = PRICE_TTL_MS,
    private now: () => number = Date.now,
    readonly maxAgeMs = MAX_AGE_MS,
  ) {}

  /** Called after every change, so the app can save. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  static key(retailerId: string, storeKey: string, query: string): string {
    return `${retailerId}|${storeKey}|${query}`;
  }

  /** A fresh entry, or undefined. */
  get(key: string): CachedSearch | undefined {
    const hit = this.entries.get(key);
    return hit && this.isFresh(hit.at) ? hit : undefined;
  }

  /** An entry young enough to show while a fresh search runs, or undefined. */
  peek(key: string): CachedSearch | undefined {
    const hit = this.entries.get(key);
    return hit && this.now() - hit.at < this.maxAgeMs ? hit : undefined;
  }

  isFresh(at: number | undefined): boolean {
    return at !== undefined && this.now() - at < this.ttlMs;
  }

  set(key: string, value: CachedSearch): void {
    this.entries.delete(key);
    this.entries.set(key, { ...value, products: value.products.slice(0, PRODUCTS_KEPT) });
    // Map order is insertion order, so the first keys are the oldest.
    while (this.entries.size > MAX_ENTRIES) this.entries.delete(this.entries.keys().next().value!);
    this.changes += 1;
    this.listeners.forEach((listener) => listener());
  }

  /** Goes up with every change, for re-rendering. */
  get version(): number {
    return this.changes;
  }

  /** Every entry young enough to show, as [key, search]. */
  list(): [string, CachedSearch][] {
    return [...this.entries].filter(([, v]) => this.now() - v.at < this.maxAgeMs);
  }

  clear(): void {
    this.entries.clear();
    this.changes += 1;
    this.listeners.forEach((listener) => listener());
  }

  get size(): number {
    return this.entries.size;
  }

  serialize(): string {
    const kept = [...this.entries].filter(([, v]) => this.now() - v.at < this.maxAgeMs);
    return JSON.stringify(kept);
  }

  hydrate(json: string | null): void {
    if (!json) return;
    try {
      const rows = JSON.parse(json) as [string, CachedSearch][];
      if (!Array.isArray(rows)) return;
      for (const [k, v] of rows) {
        if (typeof k === 'string' && v && Array.isArray(v.products) && typeof v.at === 'number') this.entries.set(k, v);
      }
    } catch {
      // A corrupt save just means searching again.
    }
  }
}
