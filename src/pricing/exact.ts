import type { ExactRef } from '../lists/types';
import { sameBarcode } from '../onDevice/barcode';
import type { Product } from '../onDevice/types';
import { parseSize } from './sizes';

// Pure functions only, so the tests run them in Node.
//
// The same product at every store: by its barcode when both stores give one, else by its name and size.

const UNIT_WORDS = /^(oz|ounces?|fl|floz|lbs?|pounds?|g|grams?|kg|ml|l|liters?|litres?|gal|gallons?|qt|quarts?|pt|pints?|ct|count|pk|pack|packs|each|ea)$/;
const FILLER = new Set(['the', 'and', 'with', 'of', 'a', 'an', 'for', 'size', 'family', 'value']);

/** A name's words that say what the product is: lower-case, sizes and filler left out. */
export function nameWords(name: string): string[] {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/['’®™]/g, '')
    .replace(/(\d)([a-z])/g, '$1 $2')
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 && !/^\d+$/.test(w) && !UNIT_WORDS.test(w) && !FILLER.has(w));
}

/**
 * Whether `p` is the reference product: 'barcode' when the barcodes agree, 'name' when the names share nearly all
 * their words and the sizes agree, else null.
 */
export function sameProduct(ref: { name: string; gtin?: string }, p: Product): 'barcode' | 'name' | null {
  if (ref.gtin && p.gtin) return sameBarcode(ref.gtin, p.gtin) ? 'barcode' : null;
  const a = new Set(nameWords(ref.name));
  const b = new Set(nameWords(p.name));
  if (a.size < 2 || b.size < 2) return null;
  const shared = [...a].filter((w) => b.has(w)).length;
  if (shared < 2 || shared / Math.min(a.size, b.size) < 0.8) return null;
  const sa = parseSize(ref.name);
  const sb = parseSize(p.name);
  if (!sa || !sb) return sa === sb ? 'name' : null;
  const sameFamily = (sa.unit === 'ct') === (sb.unit === 'ct');
  return sameFamily && Math.abs(sa.amount - sb.amount) <= sa.amount * 0.03 ? 'name' : null;
}

export const exactFrom = (product: Product, retailerId: string): ExactRef => ({
  name: product.name,
  gtin: product.gtin,
  retailerId,
  productId: product.id,
});
