import type { Product } from './types';

// Pure functions only: whether a list of products is about what was searched. Shared by the readers (parsers.ts,
// profiles.ts) and replays (replay.ts), which import it from here so neither imports the other.

const STOP_WORDS = new Set(['the', 'and', 'for', 'with', 'of']);

function stem(word: string): string {
  if (word.length > 4 && word.endsWith('ies')) return word.slice(0, -3);
  if (word.length > 4 && word.endsWith('es')) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s')) return word.slice(0, -1);
  return word;
}

/**
 * Whether one of the top results mentions a word of the query (plurals folded), or undefined when that can't be
 * told: no products, or no word of 3+ letters in the query.
 */
export function mentionsQuery(products: Pick<Product, 'name'>[], query: string): boolean | undefined {
  const stems = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !STOP_WORDS.has(w))
    .map(stem);
  if (!stems.length || !products.length) return undefined;
  return products.slice(0, 8).some((p) => {
    const name = p.name.toLowerCase();
    return stems.some((s) => name.includes(s));
  });
}

/**
 * A cheap guard against a list that isn't the results (say, the first query's results again): one of the top
 * results must mention a word of the query. Passes when that can't be told.
 */
export function looksRelevant(products: Pick<Product, 'name'>[], query: string): boolean {
  return mentionsQuery(products, query) !== false;
}
