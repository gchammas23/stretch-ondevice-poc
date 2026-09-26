import type { Product } from '../onDevice/types';
import { asMember } from './member';
import type { CachedSearch } from './priceCache';

// Pure functions only, so the tests run them in Node.

export interface Deal {
  retailerId: string;
  product: Product;
  /** Regular price minus the sale price. */
  savings: number;
  /** Savings as a share of the regular price, 0 to 1. */
  percent: number;
  /** When the phone read it. */
  at: number;
  /** What was searched to find it: an item on a list, usually. */
  query: string;
}

/**
 * Everything on sale in the prices the phone has read lately at the stores being compared (their current store),
 * biggest discounts first, member prices included at stores whose program the user belongs to. Each product once,
 * as last read.
 */
export function dealsFrom(
  rows: [string, CachedSearch][],
  storeKeys: Record<string, string>,
  now: number,
  maxAgeMs: number,
  memberships: Record<string, boolean> = {},
): Deal[] {
  const best = new Map<string, Deal>();
  for (const [key, entry] of rows) {
    const [retailerId, storeKey, ...rest] = key.split('|');
    if (storeKeys[retailerId] !== storeKey || now - entry.at > maxAgeMs) continue;
    for (const raw of entry.products) {
      const p = memberships[retailerId] ? asMember(raw) : raw;
      if (typeof p.price !== 'number' || typeof p.wasPrice !== 'number' || !(p.wasPrice > p.price) || p.price <= 0) continue;
      const id = `${retailerId}|${p.id}`;
      const had = best.get(id);
      if (had && had.at >= entry.at) continue;
      const savings = Math.round((p.wasPrice - p.price) * 100) / 100;
      best.set(id, { retailerId, product: p, savings, percent: savings / p.wasPrice, at: entry.at, query: rest.join('|') });
    }
  }
  return [...best.values()].sort((a, b) => b.percent - a.percent || b.savings - a.savings);
}
