import type { ListItem } from '../lists/types';
import type { Product } from '../onDevice/types';
import { unmetPrefs, type Basket, type BasketLine } from './basket';
import { isMatch } from './matching';
import { parseSize } from './sizes';

// Pure functions only, so the tests run them in Node.
//
// Cheaper swaps: for each item in a store's basket, a cheaper product of the same kind and size at the same store,
// often its own brand, found in the results the phone already read for that item. No extra searching.

/** A cheaper product to buy instead, at the same store. */
export interface Swap {
  item: ListItem;
  from: Product;
  to: Product;
  /** What it takes off the basket, quantity included. */
  saves: number;
  /** The store's own brand ("Great Value"). */
  storeBrand: boolean;
}

/** A swap must save at least this much to be worth suggesting. */
export const MIN_SWAP = 0.25;

const clean = (s: string) =>
  s
    .toLowerCase()
    .replace(/[®™©]/g, '')
    .replace(/[’‘]/g, "'")
    .replace(/[^a-z0-9'&!]+/g, ' ')
    .trim();

/** One of the store's own brands, by name: "Great Value Whole Milk", "Kroger® 2% Milk". */
export function isStoreBrand(name: string, brands: string[]): boolean {
  const n = ` ${clean(name)} `;
  return brands.some((b) => {
    const w = clean(b);
    return !!w && n.includes(` ${w} `);
  });
}

/** The same amount in the pack, within 5%, or neither says its size. Ounces and fluid ounces are the same thing here. */
function sameSize(a: Product, b: Product): boolean {
  const x = parseSize(a.name);
  const y = parseSize(b.name);
  if (!x || !y) return !x && !y;
  const kind = (u: string) => (u === 'ct' ? 'ct' : 'oz');
  return kind(x.unit) === kind(y.unit) && Math.abs(y.amount - x.amount) <= x.amount * 0.05;
}

const buyable = (p: Product) => typeof p.price === 'number' && Number.isFinite(p.price) && p.price > 0 && !p.sponsored && p.inStock !== false;

/**
 * The swaps a basket could make, biggest saving first: for each item whose product the store's results name
 * something cheaper for (the item, its preferences met, the same size), the cheapest of those, the store's own
 * brand winning a tie. Items with a usual or an exact product are the user's choice, and left alone.
 * `productsOf` gives everything the item's search returned (the basket line keeps only a few alternatives).
 */
export function swapsFor(basket: Basket, productsOf: (line: BasketLine) => Product[], storeBrands: string[] = []): Swap[] {
  const out: Swap[] = [];
  for (const line of basket.lines) {
    const from = line.product;
    if (line.status !== 'found' || !from || typeof from.price !== 'number' || line.usual || line.exact) continue;
    const price = from.price;
    const cheaper = productsOf(line).filter(
      (p) => p.id !== from.id && buyable(p) && p.price! <= price - 0.01 && isMatch(p.name, line.item.name) && !unmetPrefs(p, line.item.prefs).length && sameSize(from, p),
    );
    if (!cheaper.length) continue;
    const own = (p: Product) => isStoreBrand(p.name, storeBrands);
    const to = cheaper.reduce((best, p) => (p.price! < best.price! - 0.004 || (Math.abs(p.price! - best.price!) < 0.005 && own(p) && !own(best)) ? p : best));
    const saves = round((price - to.price!) * line.item.qty);
    if (saves < MIN_SWAP) continue;
    out.push({ item: line.item, from, to, saves, storeBrand: own(to) });
  }
  return out.sort((a, b) => b.saves - a.saves);
}

/** What every swap together takes off. */
export const swapSavings = (swaps: Swap[]): number => round(swaps.reduce((sum, s) => sum + s.saves, 0));

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
