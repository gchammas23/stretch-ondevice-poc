import type { PagePayload } from '../onDevice/types';
import type { ParsedItem } from './parse';

// Pure functions only, so the tests run them in Node.
//
// Recipe to list: recipe sites publish their recipes as schema.org Recipe data for search engines, ingredients
// included. The phone reads that from the page, and each ingredient line becomes a list item. No AI.

export interface Recipe {
  name?: string;
  /** Ingredient lines as the recipe writes them: "2 cups all-purpose flour, sifted". */
  ingredients: string[];
  yields?: string;
  image?: string;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function recipeNode(root: unknown, depth = 0): Record<string, unknown> | null {
  if (depth > 6) return null;
  if (Array.isArray(root)) {
    for (const x of root) {
      const hit = recipeNode(x, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  if (!isObj(root)) return null;
  const t = root['@type'];
  if ((Array.isArray(t) ? t : [t]).some((x) => typeof x === 'string' && /^Recipe$/i.test(x))) return root;
  for (const k of ['@graph', 'mainEntity', 'mainEntityOfPage', 'itemListElement', 'item']) {
    const hit = root[k] ? recipeNode(root[k], depth + 1) : null;
    if (hit) return hit;
  }
  return null;
}

const text = (v: unknown): string | undefined =>
  typeof v === 'string' ? v : Array.isArray(v) ? text(v[0]) : isObj(v) ? text(v.text ?? v.name ?? v.url) : undefined;

/** The recipe on a page, from its structured data; null when the page doesn't publish one. */
export function parseRecipe(payload: PagePayload): Recipe | null {
  for (const s of payload.sources ?? []) {
    if (s.label !== 'ld+json') continue;
    const node = recipeNode(parse(s.text));
    if (!node) continue;
    const raw = node.recipeIngredient ?? node.ingredients;
    const ingredients = (Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split('\n') : [])
      .map((x) => (typeof x === 'string' ? decode(x).replace(/\s+/g, ' ').trim() : ''))
      .filter(Boolean);
    if (!ingredients.length) continue;
    return { name: text(node.name), ingredients, yields: text(node.recipeYield), image: text(node.image) };
  }
  return null;
}

function decode(s: string): string {
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, '’')
    .replace(/&frac12;/g, '½')
    .replace(/&frac14;/g, '¼')
    .replace(/&frac34;/g, '¾');
}

const FRACTIONS = '½⅓⅔¼¾⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞';
const QUANTITY = new RegExp(
  `^(?:(?:about|approximately|approx\\.?|roughly|heaping|scant|generous|a|an|one|two|three|four|five|six|a few|few|several)\\s+)?` +
    `(?:[\\d${FRACTIONS}][\\d.,/${FRACTIONS}]*(?:\\s*(?:-|–|to|or)\\s*[\\d${FRACTIONS}][\\d.,/${FRACTIONS}]*)?\\s*)*`,
  'i',
);
const UNITS =
  /^(?:cups?|c\.|tablespoons?|tbsps?\.?|tbs\.?|tbl\.?|teaspoons?|tsps?\.?|fluid ounces?|fl\.? ?oz\.?|ounces?|oz\.?|pounds?|lbs?\.?|grams?|g|kilograms?|kg|milliliters?|millilitres?|ml|liters?|litres?|l|pints?|pt\.?|quarts?|qt\.?|gallons?|gal\.?|pinch(?:es)?|dash(?:es)?|cloves?|cans?|jars?|packages?|pkgs?\.?|packets?|boxes|box|bags?|bunch(?:es)?|sprigs?|slices?|sticks?|heads?|stalks?|pieces?|handfuls?|containers?|bottles?|envelopes?|drops?|sheets?|fillets?|scoops?)\b\.?\s*(?:of\s+)?/i;
const SIZES = /^(?:extra[- ]large|large|medium|small|jumbo|big)\s+/i;
// Only words for what's done in the kitchen: "diced tomatoes" and "sliced almonds" are things to buy.
const PREP = /^(?:finely|thinly|roughly|coarsely|freshly|lightly|chopped|minced|peeled|softened|melted|beaten|sifted|packed|divided|cooked|uncooked|cubed|halved|quartered|trimmed)\s+/i;

/**
 * An ingredient line as something to buy: "2 ½ cups all-purpose flour, sifted" → "All-purpose flour",
 * "1 (15 oz) can black beans, drained" → "Black beans", "Juice of 1 lemon" → "Lemon". Null when nothing's left.
 */
export function ingredientName(line: string): string | null {
  let s = decode(line).replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
  const juice = /^(?:juice|zest|juice and zest) of\s+(?:\d+\s+|an?\s+|one\s+)?(.+)$/i.exec(s);
  if (juice) s = juice[1];
  s = s.split(/,|;| for | to taste| or | plus | if needed| as needed/i)[0];
  s = s.replace(QUANTITY, '');
  for (let i = 0; i < 3; i++) s = s.replace(UNITS, '').replace(SIZES, '').replace(PREP, '');
  s = s.replace(/^(?:of|and)\s+/i, '').replace(/[.*:]+$/, '').replace(/\s+/g, ' ').trim();
  if (!/[a-z]{2}/i.test(s)) return null;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const stem = (w: string) => (w.length > 3 && w.endsWith('ies') ? `${w.slice(0, -3)}y` : w.length > 3 && /[^s]s$/.test(w) ? w.slice(0, -1) : w);
const wordsOf = (name: string) => new Set(name.toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 1).map(stem));
const within = (a: Set<string>, b: Set<string>) => [...a].every((w) => b.has(w));

/**
 * The list item that already covers an ingredient: the same thing ("Eggs" for egg), or the same with fewer words
 * ("Butter" for unsalted butter, "Unsalted butter" for butter), which is only a maybe.
 */
export function onListAs(name: string, items: { name: string }[]): { name: string; same: boolean } | null {
  const mine = wordsOf(name);
  if (!mine.size) return null;
  const theirs = items.map((i) => ({ name: i.name, words: wordsOf(i.name) })).filter((i) => i.words.size);
  const same = theirs.find((i) => i.words.size === mine.size && within(mine, i.words));
  if (same) return { name: same.name, same: true };
  const near = theirs.find((i) => within(i.words, mine) || within(mine, i.words));
  return near ? { name: near.name, same: false } : null;
}

/** A recipe's ingredients as list items, each keeping its original line as a note. Repeats are merged. */
export function recipeItems(recipe: Recipe): (ParsedItem & { note: string })[] {
  const seen = new Set<string>();
  const out: (ParsedItem & { note: string })[] = [];
  for (const line of recipe.ingredients) {
    const name = ingredientName(line);
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push({ name, qty: 1, note: line });
  }
  return out;
}
