import { GROCERY_TERMS } from '../lists/groceryTerms';
import { itemKey, queryKey, searchText, type GroceryList } from '../lists/types';
import { isBarcode } from '../onDevice/barcode';
import type { Product } from '../onDevice/types';
import type { Usuals } from './basket';
import { allWords, isMatch, sameWord } from './matching';

// Pure functions only, so the tests run them in Node.
//
// One search for list items that can share it. "Milk" and "Whole milk" on one list: the store's search for milk
// usually lists its whole milk near the top, so "Whole milk" can take its product from that search instead of a
// search of its own. Only where it's safe: the item's words must include every word of the other item's and end on
// the same thing ("milk"), and a product near the top of the results must say the item's words in order ("Whole
// Milk", not "Whole Ultra-Filtered Milk" or "Whole Milk Mozzarella"). Otherwise the item is searched as always, once
// the other search is done.

/** A product that says the item must be among this many of the other search's first results: its first half. */
export const SHARE_WITHIN = 6;

/** Single-word kinds of groceries ("cheese", "yogurt"), as matching compares words. */
const KINDS = [...new Set(GROCERY_TERMS.filter((t) => !t.includes(' ')).flatMap((t) => allWords(t)))];

const has = (words: string[], w: string) => words.some((x) => sameWord(x, w));

/**
 * Which of a list's items can take another item's search, at every store: the item's search key → the key of the
 * search it can take. Items with a preferred size, an exact product or a usual product anywhere keep their own
 * search, since what they want may not be in the other's results.
 */
export function sharePlan(list: Pick<GroceryList, 'items'>, usuals: Usuals = {}): Record<string, string> {
  const searches = [...new Map(list.items.map((i) => [itemKey(i), allWords(searchText(i))])).entries()]
    .filter(([key, words]) => !isBarcode(key) && words.length > 0)
    .map(([key, words]) => ({ key, words }));
  const plan: Record<string, string> = {};
  for (const item of list.items) {
    if (item.prefs?.size?.trim() || item.exact || Object.keys(usuals[queryKey(item.name)] ?? {}).length) continue;
    const key = itemKey(item);
    const words = allWords(searchText(item));
    if (words.length < 2 || isBarcode(key)) continue;
    const head = words[words.length - 1];
    // The broadest search whose words are all the item's, ending on the same thing: "milk" for "organic whole milk".
    const host = searches
      .filter((s) => s.key !== key && s.words.length < words.length && sameWord(s.words[s.words.length - 1], head) && s.words.every((w) => has(words, w)))
      .sort((a, b) => a.words.length - b.words.length)[0];
    if (host) plan[key] = host.key;
  }
  return plan;
}

/**
 * True when a product found by another item's search is surely this item: it's the item (see isMatch), its name says
 * the item's words in order with nothing between ("Great Value Whole Milk, 1 Gallon" says "whole milk"), and it names
 * no other kind of grocery ("Whole Milk Mozzarella" is mozzarella; "Cheddar Made with Whole Milk" is cheese).
 */
export function saysItem(name: string, query: string): boolean {
  const want = allWords(query);
  if (!want.length || !isMatch(name, query)) return false;
  const have = allWords(name);
  if (have.some((w) => has(KINDS, w) && !has(want, w))) return false;
  for (let i = 0; i + want.length <= have.length; i++) {
    if (want.every((w, j) => sameWord(w, have[i + j]))) return true;
  }
  return false;
}

/**
 * The other search's products for the item: the ones that say it first (see saysItem), then the rest, in the store's
 * order. Null when none of its first SHARE_WITHIN results that could be bought says it: the item is searched then.
 */
export function sharedProducts(products: Product[], query: string): Product[] | null {
  const buyable = (p: Product) => typeof p.price === 'number' && Number.isFinite(p.price) && !p.sponsored && p.inStock !== false;
  const says = products.map((p, i) => i < SHARE_WITHIN && buyable(p) && saysItem(p.name, query));
  if (!says.some(Boolean)) return null;
  return [...products.filter((_, i) => says[i]), ...products.filter((_, i) => !says[i])];
}
