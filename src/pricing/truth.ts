import type { Product } from '../onDevice/types';
import type { Basket } from './basket';

// Pure functions only, so the tests run them in Node.
//
// The price truth check: a sample of the prices a list got, each read again from the product's own page on the
// store's site, and how many agree. "Are these prices right?", answered with a number.

/** One price to check. */
export interface TruthItem {
  retailerId: string;
  itemName: string;
  product: Product;
}

export type TruthState = 'waiting' | 'checking' | 'same' | 'different' | 'unreadable';

export interface TruthCheck extends TruthItem {
  state: TruthState;
  /** What the product's own page says, when it says. */
  pagePrice?: number;
  /** Why it couldn't be read. */
  reason?: string;
}

/**
 * Up to `perStore` of each basket's products, spread across the list, that have their own page on the store's site
 * (`onSite` says which links count).
 */
export function truthSample(baskets: Basket[], perStore: number, onSite: (retailerId: string, url: string) => boolean): TruthItem[] {
  const out: TruthItem[] = [];
  for (const b of baskets) {
    const lines = b.lines.filter((l) => l.status === 'found' && l.product && typeof l.product.price === 'number' && l.product.url && onSite(b.retailerId, l.product.url));
    const take = Math.min(perStore, lines.length);
    const step = lines.length / Math.max(1, take);
    for (let i = 0; i < take; i++) {
      const line = lines[Math.floor(i * step)];
      out.push({ retailerId: b.retailerId, itemName: line.item.name, product: line.product! });
    }
  }
  return out;
}

/** The prices a product's page may rightly show for it: its price, and its member and regular prices when it has them. */
export function pricesOf(p: Product): number[] {
  const all = [p.price, p.memberPrice, p.memberApplied ? p.wasPrice : undefined];
  return all.filter((v): v is number => typeof v === 'number');
}

/** The search's price against the page's: the same to the cent (as any of `searchPrices`), different, or none. */
export function verdictOf(searchPrices: number[], pagePrice: number | undefined): 'same' | 'different' | 'unreadable' {
  if (pagePrice === undefined || !searchPrices.length) return 'unreadable';
  return searchPrices.some((price) => Math.abs(pagePrice - price) < 0.005) ? 'same' : 'different';
}

export interface TruthSummary {
  /** Checks with an answer (same or different). */
  checked: number;
  same: number;
  different: number;
  unreadable: number;
  /** Same out of checked, 0 to 1. */
  rate?: number;
  byStore: Record<string, { same: number; checked: number }>;
}

export function truthSummary(checks: TruthCheck[]): TruthSummary {
  const byStore: TruthSummary['byStore'] = {};
  let same = 0;
  let different = 0;
  let unreadable = 0;
  for (const c of checks) {
    const row = (byStore[c.retailerId] ??= { same: 0, checked: 0 });
    if (c.state === 'same') {
      same++;
      row.same++;
      row.checked++;
    } else if (c.state === 'different') {
      different++;
      row.checked++;
    } else if (c.state === 'unreadable') {
      unreadable++;
    }
  }
  const checked = same + different;
  return { checked, same, different, unreadable, ...(checked ? { rate: same / checked } : {}), byStore };
}
