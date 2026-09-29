import { isObj, str } from './json';

// Pure functions only: no React Native imports, so the tests run them in Node.
//
// Where a product is in a store, as the store's own data says: its aisle ("13", "D34", "G26"), or, where its place has
// no number, the area it's in ("Dairy"). Stores' data calls other things aisles too: the storefronts Instacart runs
// (ALDI's, Sprouts') and Albertsons' sites name their online categories so ("Milk & Cream"), with ids, and those say
// nothing about where the shelf is. So an aisle is only taken when it reads like one: a number of one or two digits,
// with a letter or two before it (a zone or block, as Walmart's and Target's signs have) or one after it, at most.
//
// How stores write it, from others' scrapers and Kroger's own API reference (2026-09): Kroger's API gives a list of
// places, { description: "AISLE 13", number: "13", side: "L" }, or { description: "DAIRY", number: "100" } for a
// department, whose number is a code, not an aisle; Walmart, productLocation [{ displayValue: "D34", aisle: { zone: "D",
// aisle: 34 } }]; Target, store_positions [{ aisle: 26, block: "G" }]; Albertsons' sites, aisleLocation "Aisle 17" or
// "Dairy" (while aisleName, "Milk & Cream|1_11_4", is a category); Publix, inStoreLocation ["Aisle 3 - Pasta"]; H-E-B,
// productLocation { location: "Aisle 5" } or "In Produce"; Wegmans, planogram { aisle: "14B" }, or "Dairy".

/** Where a product is in the store: its aisle, and the area it's in when its place names one instead ("Dairy"). */
export interface Place {
  aisle?: string;
  department?: string;
}

/** An aisle written plainly: "13", "D34", "G26", "14B". Three digits are a department's code (Kroger's DAIRY is 100). */
const AISLE_CODE = /^([A-Z]{1,2})?(\d{1,2})([A-Z])?$/;
/** "Aisle 12", "aisle #12", "Aisle: 12", "AISLE A-12", in a short text: "Aisle 3 - Pasta". Not "aisles 5-7". */
const AISLE_WORDS = /\baisle(?![a-z])\s*(?:[:#]|no\.?|number)?\s*([A-Z]{0,2}[ -]?\d{1,3}[A-Z]?)\b/i;
/** A text longer than this is a description that mentions an aisle, not where the product is. */
const MAX_TEXT = 40;

/** Keys that say where a product is in the store. */
export const AISLE_KEY = /aisle|store_?positions?|product_?location|shelf_?location|in_?store_?location|item_?location|planogram/i;
/** Keys that name an aisle without saying where it is: its id, link or count (a category's, at Instacart's storefronts). */
export const NOT_AISLE_KEY = /(?:id|ids|url|uri|link|href|slug|seo|path|count|image|icon)$/i;
/**
 * Of those, the keys for a place, not a plain "aisle" (which some stores use for a category): a place whose words aren't
 * an aisle names the area it's in. Kroger's "DAIRY", Albertsons' "Dairy", H-E-B's "In Produce".
 */
const PLACE_KEY = /location|position|planogram/i;
/** Keys for a product's department. */
export const DEPARTMENT_KEY = /^(?:department|dept|department_?name|dept_?name|department_?description|primary_?department)$/i;

/** Inside a place's own data, how the store shows it: "D34", "Aisle 14", "DAIRY". */
const SHOWN_KEYS = ['displayValue', 'display_value', 'display', 'location', 'label', 'text', 'description', 'name', 'value'];
/** ...or its number. "number" alone is only an aisle when the place has no words of its own (see readPlace). */
const NUMBER_KEYS = ['aisle', 'aisleNumber', 'aisle_number', 'aisleNo', 'aisle_no', 'number', 'num'];
const PLAIN_NUMBER = new Set(['number', 'num']);
/** The letters before the number, where they come apart from it: Target's block, Walmart's zone. */
const ZONE_KEYS = ['block', 'zone', 'aisleBlock', 'aisle_block', 'aisleZone', 'aisle_zone'];

/** An aisle's code as signs write it, from "a-12", "E 7" or "07": "A12", "E7", "7". Undefined when it isn't one. */
export function aisleCode(text: string): string | undefined {
  const plain = text
    .trim()
    .toUpperCase()
    .replace(/^([A-Z]{1,2})[ -](?=\d)/, '$1')
    .replace(/^([A-Z]{0,2})0+(?=\d)/, '$1');
  const m = AISLE_CODE.exec(plain);
  if (!m) return undefined;
  const n = Number(m[2]);
  return n >= 1 ? `${m[1] ?? ''}${n}${m[3] ?? ''}` : undefined;
}

/** An aisle from a plain value: a whole number, a code ("D34"), or a short text that says it ("Aisle 3 - Pasta"). */
export function aisleText(v: unknown): string | undefined {
  if (typeof v === 'number') return Number.isInteger(v) && v >= 1 && v <= 99 ? String(v) : undefined;
  if (typeof v !== 'string') return undefined;
  const text = v.trim().replace(/\s+/g, ' ');
  if (!text || text.length > MAX_TEXT) return undefined;
  const said = AISLE_WORDS.exec(text);
  return said ? aisleCode(said[1]) : aisleCode(text);
}

const letters = (v: unknown): string | undefined => {
  const s = str(v)?.trim().toUpperCase();
  return s && /^[A-Z]{1,2}$/.test(s) ? s : undefined;
};

const zoned = (code: string, o: Record<string, unknown>): string => {
  const zone = ZONE_KEYS.map((z) => letters(o[z])).find(Boolean);
  return zone && /^\d/.test(code) ? `${zone}${code}` : code;
};

/**
 * Where a value found under `key` (a key that says where the product is, see AISLE_KEY) puts the product: a plain
 * value, a list of places (a product can be in more than one: the first with an aisle, else the first area), or a
 * place's own data. A place is read by how the store shows it ("D34"), else by its number, with the letters of its
 * block or zone put before it: Target's { block: "G", aisle: 26 } is G26. A place's words that aren't an aisle name its
 * area ("DAIRY"), when the key is a place's; then its plain number is the area's code, not an aisle.
 */
export function placeOf(v: unknown, key = ''): Place | undefined {
  return readPlace(v, PLACE_KEY.test(key), 0);
}

function readPlace(v: unknown, located: boolean, depth: number): Place | undefined {
  if (depth > 3) return undefined;
  if (Array.isArray(v)) {
    let area: Place | undefined;
    for (const x of v.slice(0, 8)) {
      const place = readPlace(x, located, depth + 1);
      if (place?.aisle) return place;
      area ??= place;
    }
    return area;
  }
  if (!isObj(v)) {
    const aisle = aisleText(v);
    if (aisle) return { aisle };
    const department = located ? departmentOf(v) : undefined;
    return department ? { department } : undefined;
  }
  let words: string | undefined;
  for (const k of SHOWN_KEYS) {
    const aisle = aisleText(v[k]);
    if (aisle) return { aisle };
    words ??= str(v[k])?.trim() || undefined;
  }
  for (const k of NUMBER_KEYS) {
    if (words && PLAIN_NUMBER.has(k)) continue;
    const inner = v[k];
    if (isObj(inner) || Array.isArray(inner)) {
      const place = readPlace(inner, located, depth + 1);
      if (place?.aisle) return { aisle: zoned(place.aisle, v) };
      continue;
    }
    const aisle = aisleText(inner);
    if (aisle) return { aisle: zoned(aisle, v) };
    // Wegmans' perishables: { aisle: "Dairy" }.
    words ??= str(inner)?.trim() || undefined;
  }
  const department = located && words ? departmentOf(words) : undefined;
  return department ? { department } : undefined;
}

/** Departments so wide they say nothing of where in the store: "Grocery", "Food". */
const BROAD = /^(?:all(?: departments)?|shop all|grocery|groceries|food|foods|food (?:and|&) (?:beverages?|grocery)|grocery (?:and|&) gourmet(?: food)?|general merchandise|home|products?|departments?|other|misc(?:ellaneous)?|none|n\/a|unknown|not available)$/i;
/** Words that aren't a place: "Ask Associate", as Albertsons' sites say for some products. */
const NOT_A_PLACE = /\b(?:ask|see)\b.*\bassociate\b|customer service/i;

const titleCase = (s: string): string => s.toLowerCase().replace(/(^|[\s&/-])([a-z])/g, (_, before: string, c: string) => before + c.toUpperCase());

/**
 * A department from a value: a short name ("Dairy"), the first of a list, or an object's name. "In Produce" is Produce,
 * and shouting is lowered ("MEAT & SEAFOOD" is Meat & Seafood).
 */
export function departmentOf(v: unknown): string | undefined {
  while (Array.isArray(v)) v = v[0];
  if (isObj(v)) v = v.name ?? v.displayName ?? v.title ?? v.description;
  const s = str(v)
    ?.trim()
    .replace(/\s+/g, ' ')
    .replace(/^in (?:the )?/i, '');
  if (!s || s.length < 3 || s.length > 40 || !/[a-z]/i.test(s) || /^(?:https?:|\/)|[_|]|\d{3,}/i.test(s) || BROAD.test(s) || NOT_A_PLACE.test(s)) {
    return undefined;
  }
  return s === s.toUpperCase() ? titleCase(s) : s;
}

/** "Aisle 12", "Aisle G26". */
export const aisleLabel = (aisle: string): string => `Aisle ${aisle}`;

/** Aisles in the order they're numbered: "2" before "12", "A2" before "A12" before "B1". */
export function compareAisles(a: string, b: string): number {
  const pa = AISLE_CODE.exec(a);
  const pb = AISLE_CODE.exec(b);
  if (!pa || !pb) return a.localeCompare(b);
  return (pa[1] ?? '').localeCompare(pb[1] ?? '') || Number(pa[2]) - Number(pb[2]) || (pa[3] ?? '').localeCompare(pb[3] ?? '');
}
