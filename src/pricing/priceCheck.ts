import { queryKey } from '../lists/types';
import { sameBarcode } from '../onDevice/barcode';
import type { Product } from '../onDevice/types';
import { defaultPick } from './basket';
import { nameWords, sameProduct } from './exact';
import type { PricingRun, SearchResult } from './pricingEngine';
import { parseSize } from './sizes';

/** What one store has for a price check: its best match and a couple more, and how sure that is. */
export interface StoreAnswer {
  retailerId: string;
  name: string;
  status: 'waiting' | 'checking' | 'found' | 'none' | 'failed';
  product?: Product;
  /** The query it was found under, to open it. */
  query?: string;
  more: Product[];
  /** For a barcode: how the product is known to be the scanned one. */
  sure?: 'barcode' | 'name' | 'maybe';
  reason?: string;
}

const firstMatch = (r: SearchResult | undefined, q: string) => {
  const products = r?.products ?? [];
  const at = defaultPick(products, q);
  return at === -1 ? undefined : products[at];
};

const pending = (r: SearchResult | undefined) => !r || r.status === 'queued' || r.status === 'searching';

/** Packaging, which says nothing about what's inside ("Heinz Tomato Ketchup, 32 oz Bottle" is ketchup). */
const PACKAGING = /^(?:bottles?|jars?|cans?|bags?|box(?:es)?|packs?|cartons?|tubs?|pouch(?:es)?|containers?|jugs?)$/;

/**
 * The store's nearest thing to a product it doesn't carry: the same kind of item (its last word: "milk" in "Great
 * Value Whole Milk"), sharing the most words and ideally the size, a store brand's whole milk, 1 gal, say.
 */
export function closestTo(known: KnownProduct, products: Product[]): Product | undefined {
  const mine = nameWords(known.name).filter((w) => !PACKAGING.test(w));
  const head = mine[mine.length - 1];
  if (!head) return undefined;
  const size = parseSize(known.name);
  let best: { p: Product; score: number } | undefined;
  products.forEach((p, i) => {
    if (typeof p.price !== 'number') return;
    const theirs = new Set(nameWords(p.name));
    if (!theirs.has(head)) return;
    const shared = mine.filter((w) => theirs.has(w)).length;
    const s = parseSize(p.name);
    const sameSize = !!size && !!s && (size.unit === 'ct') === (s.unit === 'ct') && Math.abs(size.amount - s.amount) <= size.amount * 0.05;
    const score = shared * 10 + (sameSize ? 15 : 0) - i;
    if (!best || score > best.score) best = { p, score };
  });
  return best?.p;
}

/** The scanned product, once any store's result for the barcode carries the same barcode. */
export function barcodeIdentity(run: PricingRun | undefined, barcode: string): Product | undefined {
  return Object.values(run?.results ?? {})
    .flatMap((byQuery) => byQuery[queryKey(barcode)]?.products ?? [])
    .find((p) => p.gtin && sameBarcode(p.gtin, barcode));
}

/** A product to find at every store, known from the start: a suggestion the user tapped. */
export interface KnownProduct {
  name: string;
  gtin?: string;
}

/**
 * Each store's answer to a price check, in the stores' order.
 * - Words: the first product that matches them.
 * - A barcode (`query` is the code): the product with the same barcode, else the scanned product's name and size
 *   in a search by its name, else the store's top result for the code, marked as unsure.
 * - A known product (`query` is its name, `barcode` its barcode if it has one): the same barcode, else the same
 *   name and size, else the closest match, marked as unsure.
 */
export function priceCheckAnswers(
  run: PricingRun | undefined,
  stores: { id: string; name: string }[],
  query: string | null,
  barcode: string | null,
  known?: KnownProduct,
): StoreAnswer[] {
  const identity = known ?? (barcode ? barcodeIdentity(run, barcode) : undefined);
  return stores.map(({ id: rid, name }) => {
    const byQuery = run?.results[rid] ?? {};
    const storeRun = run?.stores[rid];
    const base = { retailerId: rid, name, more: [] as Product[] };
    if (!query) return { ...base, status: 'waiting' };
    const main = byQuery[queryKey(query)];
    const waiting = { ...base, status: storeRun?.status === 'waiting' ? 'waiting' : 'checking' } as const;
    if (barcode || known) {
      const byCode = barcode ? byQuery[queryKey(barcode)] : undefined;
      const byName = identity ? byQuery[queryKey(identity.name)] : undefined;
      if (barcode) {
        for (const [r, q] of [[byCode, barcode], [byName, identity?.name]] as const) {
          const exact = r?.products.find((p) => p.gtin && sameBarcode(p.gtin, barcode));
          if (exact && q) return { ...base, status: 'found', product: exact, query: q, sure: 'barcode' };
        }
      }
      if (identity) {
        for (const p of byName?.products ?? []) {
          const same = sameProduct(identity, p);
          if (same) return { ...base, status: 'found', product: p, query: identity.name, sure: same };
        }
      }
      const top = known ? closestTo(known, byName?.products ?? []) : byCode?.products.find((p) => typeof p.price === 'number');
      if (top) return { ...base, status: 'found', product: top, query: known ? known.name : barcode!, sure: 'maybe' };
      if ((barcode && pending(byCode)) || (identity && pending(byName))) return waiting;
      const failed = (byCode ?? byName)?.status === 'failed';
      return { ...base, status: failed ? 'failed' : 'none', reason: (byCode ?? byName)?.reason };
    }
    if (pending(main) && !main?.products.length) return waiting;
    if (main?.status === 'failed' || main?.status === 'skipped') return { ...base, status: 'failed', reason: main.reason };
    const product = firstMatch(main, query);
    if (!product) return { ...base, status: 'none' };
    const more = (main?.products ?? []).filter((p) => p.id !== product.id && typeof p.price === 'number').slice(0, 3);
    return { ...base, status: 'found', product, query, more };
  });
}
