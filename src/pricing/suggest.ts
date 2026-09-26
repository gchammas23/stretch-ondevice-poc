import { queryKey } from '../lists/types';
import type { Product } from '../onDevice/types';
import type { CachedSearch } from './priceCache';

// Pure functions only, so the tests run them in Node.
//
// Suggestions for a price check as it's typed: searches (recent ones, list items, what the stores' own search
// boxes suggest, common grocery terms) and products the stores already showed this phone, with their prices.

export type SearchSource = 'recent' | 'list' | 'store' | 'common';

export interface SearchSuggestion {
  text: string;
  from: SearchSource;
  /** For a store's suggestion: which stores suggested it. */
  stores?: string[];
}

export interface ProductSuggestion {
  retailerId: string;
  product: Product;
  /** When the phone read it. */
  at: number;
}

/** A search or a name as words: lower case, without accents or punctuation ("2% milk" keeps its "2%"). */
export function suggestWords(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/['’®™]/g, '')
    .split(/[^a-z0-9%]+/)
    .filter(Boolean);
}

/** A word's singular, roughly, to tell a whole word apart from a longer one: "eggs" is "egg", "eggplant" isn't. */
const singular = (w: string) => (w.length > 3 && w.endsWith('ies') ? `${w.slice(0, -3)}y` : w.length > 3 && /[^s]s$/.test(w) ? w.slice(0, -1) : w);

/** Sizes, counts and numbers, which say how much, not what. */
const UNIT = /^(?:\d+(?:\.\d+)?%?|oz|fl|gal|gallons?|ct|count|lbs?|pk|pack|ml|l|liters?|qt|quarts?|pt|pints?|each|ea|x)$/;

/** What a search or a name is: its last word that isn't a size ("milk" in "whole milk" and "milk 2% gallon"). */
const headOf = (words: string[]): string | undefined => [...words].reverse().find((w) => !UNIT.test(w));

/**
 * How `typed` words sit in a candidate's words, or null if one of them starts none of its words (the last may be
 * half typed). `head` is the word that says what the candidate is ("milk" in "whole milk").
 */
function fit(typed: string[], words: string[], head: string | undefined): { inOrder: number; whole: number; head: 'same' | 'starts' | null } | null {
  if (!typed.length || !words.length) return null;
  let inOrder = 0;
  let whole = 0;
  let from = 0;
  for (const t of typed) {
    const at = words.findIndex((w) => w.startsWith(t));
    if (at === -1) return null;
    if (at >= from) {
      inOrder++;
      from = at + 1;
    }
    if (singular(words[at]) === singular(t)) whole++;
  }
  const last = typed[typed.length - 1];
  return { inOrder, whole, head: !head ? null : singular(head) === singular(last) ? 'same' : head.startsWith(last) ? 'starts' : null };
}

/**
 * How well a search fits what's typed, or null if it doesn't. Higher is better: starting with the typed text,
 * words in the same order and typed in full, being the kind of thing typed ("whole milk" for "milk", not "milk
 * duds"), and fewer words left over.
 */
export function searchScore(typedText: string, candidate: string): number | null {
  const typed = suggestWords(typedText);
  const words = suggestWords(candidate);
  const f = fit(typed, words, headOf(words));
  if (!f) return null;
  const prefix = candidate.toLowerCase().startsWith(typedText.trim().toLowerCase());
  return (prefix ? 100 : 0) + f.inOrder * 10 + f.whole * 8 + headPoints(f.head) - Math.max(0, words.length - typed.length) * 3;
}

/** Being the kind of thing typed ("whole milk" for "milk") counts most; starting like it ("mil"), a little. */
const headPoints = (head: 'same' | 'starts' | null) => (head === 'same' ? 120 : head === 'starts' ? 12 : 0);

/**
 * How well a product fits what's typed, or null if it doesn't. Names lead with the brand, so what counts is naming
 * the kind of thing typed: its last word before the size ("Great Value Whole Milk, 1 gal" is milk; "Milk Duds
 * Candy" isn't).
 */
export function productScore(typedText: string, name: string): number | null {
  const typed = suggestWords(typedText);
  const words = suggestWords(name.split(',')[0]).filter((w) => !UNIT.test(w));
  const f = fit(typed, words, headOf(words));
  if (!f) return null;
  return f.inOrder * 10 + f.whole * 8 + headPoints(f.head);
}

/** What the common grocery terms are ("milk", "eggs", "cheese"...), to tell a store's grocery suggestions from the rest. */
const headsOf = new WeakMap<string[], Set<string>>();
function groceryHeads(common: string[]): Set<string> {
  let heads = headsOf.get(common);
  if (!heads) {
    heads = new Set(common.map((t) => headOf(suggestWords(t))).filter((h): h is string => !!h).map(singular));
    headsOf.set(common, heads);
  }
  return heads;
}

const WEIGHT: Record<SearchSource, number> = { recent: 40, list: 30, store: 20, common: 0 };

/**
 * Searches to suggest for what's typed, best first: those that start with it, then the user's own (recent checks,
 * list items), then the stores', then common terms. Each once, and not what's typed itself.
 */
export function suggestSearches(
  typedText: string,
  sources: { recent?: string[]; list?: string[]; store?: { text: string; retailerId: string }[]; common?: string[] },
  limit = 6,
): SearchSuggestion[] {
  const typedClean = typedText.trim().toLowerCase().replace(/\s+/g, ' ');
  const typed = suggestWords(typedClean);
  if (!typed.length) return [];
  const best = new Map<string, SearchSuggestion & { score: number }>();
  const heads = sources.common?.length ? groceryHeads(sources.common) : null;
  const offer = (text: string, from: SearchSource, retailerId?: string) => {
    const clean = text.trim().replace(/\s+/g, ' ');
    const key = queryKey(clean);
    if (!key || key === queryKey(typedClean) || clean.length > 60) return;
    const score = searchScore(typedClean, clean);
    if (score === null) return;
    // A store also suggests what it sells beyond groceries ("milk frother"): those go below.
    const head = headOf(suggestWords(clean));
    const offTopic = from === 'store' && !!heads && !!head && !heads.has(singular(head)) && !typed.includes(head);
    const total = score + WEIGHT[from] - (offTopic ? 50 : 0);
    const had = best.get(key);
    const stores = [...new Set([...(had?.stores ?? []), ...(retailerId ? [retailerId] : [])])];
    if (!had || total > had.score) best.set(key, { text: had && WEIGHT[had.from] > WEIGHT[from] ? had.text : clean, from, score: total, ...(stores.length ? { stores } : {}) });
    else if (stores.length) had.stores = stores;
  };
  for (const text of sources.recent ?? []) offer(text, 'recent');
  for (const text of sources.list ?? []) offer(text, 'list');
  for (const s of sources.store ?? []) offer(s.text, 'store', s.retailerId);
  for (const text of sources.common ?? []) offer(text, 'common');
  return [...best.values()]
    .sort((a, b) => b.score - a.score || a.text.length - b.text.length)
    .slice(0, limit)
    .map((s) => ({ text: s.text, from: s.from, ...(s.stores ? { stores: s.stores } : {}) }));
}

/**
 * Products the stores being compared showed this phone lately that fit what's typed, best fit first and cheaper
 * first among equals, at most two from any one store so every store gets a say. Each product once, as last read.
 */
export function suggestProducts(
  typedText: string,
  rows: [string, CachedSearch][],
  storeKeys: Record<string, string>,
  now: number,
  maxAgeMs: number,
  limit = 5,
): ProductSuggestion[] {
  const typedClean = typedText.trim().toLowerCase().replace(/\s+/g, ' ');
  const typed = suggestWords(typedClean);
  if (!typed.length) return [];
  const found = new Map<string, ProductSuggestion & { score: number }>();
  for (const [key, entry] of rows) {
    const [retailerId, storeKey] = key.split('|');
    if (storeKeys[retailerId] !== storeKey || now - entry.at > maxAgeMs) continue;
    for (const product of entry.products) {
      if (typeof product.price !== 'number' || product.price <= 0) continue;
      const id = `${retailerId}|${product.id}`;
      const had = found.get(id);
      if (had && had.at >= entry.at) continue;
      const score = productScore(typedClean, product.name);
      if (score === null) continue;
      found.set(id, { retailerId, product, at: entry.at, score });
    }
  }
  const ranked = [...found.values()].sort((a, b) => b.score - a.score || a.product.price! - b.product.price!);
  const perStore = new Map<string, number>();
  const out: ProductSuggestion[] = [];
  for (const s of ranked) {
    const n = perStore.get(s.retailerId) ?? 0;
    if (n >= 2) continue;
    perStore.set(s.retailerId, n + 1);
    out.push({ retailerId: s.retailerId, product: s.product, at: s.at });
    if (out.length >= limit) break;
  }
  return out;
}
