import { isObj, num, str, type Obj } from './json';

// Pure functions only: no React Native imports, so the tests run them in Node.
//
// A product's Nutrition Facts, as a store's product page publishes them (schema.org NutritionInformation, or the
// page's own data, however it names its nutrients), or as Open Food Facts has them by barcode. No per-store code.

export type NutrientKey =
  | 'totalFat'
  | 'saturatedFat'
  | 'transFat'
  | 'cholesterol'
  | 'sodium'
  | 'totalCarbohydrate'
  | 'dietaryFiber'
  | 'totalSugars'
  | 'addedSugars'
  | 'protein'
  | 'vitaminD'
  | 'calcium'
  | 'iron'
  | 'potassium';

export type NutrientUnit = 'g' | 'mg' | 'mcg';

export interface NutrientAmount {
  value: number;
  unit: NutrientUnit;
  /** "Less than": the source said "<1g". */
  less?: boolean;
  /** % Daily Value, as the source gave it or as the phone worked it out (see `dvWorkedOut`). */
  dv?: number;
}

export interface Nutrition {
  servingSize?: string;
  servingsPerContainer?: string;
  calories?: number;
  nutrients: Partial<Record<NutrientKey, NutrientAmount>>;
  /** Some % Daily Values were worked out on the phone from the FDA's daily values: the source didn't give them. */
  dvWorkedOut: boolean;
  /** The amounts are per 100 g or 100 ml, not per serving: Open Food Facts had no serving for the product. */
  per100?: 'g' | 'ml';
}

export interface NutrientInfo {
  key: NutrientKey;
  label: string;
  unit: NutrientUnit;
  /** The FDA's daily value (2016 label rules), where the label shows a % for it. */
  dv?: number;
  /** A sub-line on the label (Saturated Fat under Total Fat). */
  indent?: boolean;
  /** Below the label's thick bar: vitamins and minerals. */
  mineral?: boolean;
  /** How pages name it. Matched against the name with punctuation and case dropped. */
  name: RegExp;
  /** schema.org NutritionInformation's property for it, where it has one. */
  ld?: string;
  /** Open Food Facts' nutriment key. */
  off: string;
}

/** The label's lines, in its order. */
export const NUTRIENTS: NutrientInfo[] = [
  { key: 'totalFat', label: 'Total Fat', unit: 'g', dv: 78, name: /^(total )?fats?$/, ld: 'fatContent', off: 'fat' },
  { key: 'saturatedFat', label: 'Saturated Fat', unit: 'g', dv: 20, indent: true, name: /^sat(urated)? fats?$/, ld: 'saturatedFatContent', off: 'saturated-fat' },
  { key: 'transFat', label: 'Trans Fat', unit: 'g', indent: true, name: /^trans fats?$/, ld: 'transFatContent', off: 'trans-fat' },
  { key: 'cholesterol', label: 'Cholesterol', unit: 'mg', dv: 300, name: /^cholesterol$/, ld: 'cholesterolContent', off: 'cholesterol' },
  { key: 'sodium', label: 'Sodium', unit: 'mg', dv: 2300, name: /^sodium$/, ld: 'sodiumContent', off: 'sodium' },
  { key: 'totalCarbohydrate', label: 'Total Carbohydrate', unit: 'g', dv: 275, name: /^(total )?carb(ohydrate)?s?$/, ld: 'carbohydrateContent', off: 'carbohydrates' },
  { key: 'dietaryFiber', label: 'Dietary Fiber', unit: 'g', dv: 28, indent: true, name: /^(dietary |total )?fib(er|re)s?$/, ld: 'fiberContent', off: 'fiber' },
  { key: 'totalSugars', label: 'Total Sugars', unit: 'g', indent: true, name: /^(total )?sugars?$/, ld: 'sugarContent', off: 'sugars' },
  { key: 'addedSugars', label: 'Added Sugars', unit: 'g', dv: 50, indent: true, name: /^(incl(udes)? (\d+(\.\d+)? ?g )?)?added sugars?$/, off: 'added-sugars' },
  // Labels rarely show protein's %: a % only when the page gives one.
  { key: 'protein', label: 'Protein', unit: 'g', name: /^proteins?$/, ld: 'proteinContent', off: 'proteins' },
  { key: 'vitaminD', label: 'Vitamin D', unit: 'mcg', dv: 20, mineral: true, name: /^vit(amin)? d( ?[23])?$/, off: 'vitamin-d' },
  { key: 'calcium', label: 'Calcium', unit: 'mg', dv: 1300, mineral: true, name: /^calcium$/, off: 'calcium' },
  { key: 'iron', label: 'Iron', unit: 'mg', dv: 18, mineral: true, name: /^iron$/, off: 'iron' },
  { key: 'potassium', label: 'Potassium', unit: 'mg', dv: 4700, mineral: true, name: /^potassium$/, off: 'potassium' },
];

const BY_KEY = new Map(NUTRIENTS.map((n) => [n.key, n]));
const PER_GRAM: Record<NutrientUnit, number> = { g: 1, mg: 1000, mcg: 1_000_000 };

/** "Total_Fat", "totalFat", "Total Fat:" → "total fat". */
function words(s: string): string {
  return s
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .replace(/\.(?!\d)/g, ' ')
    .replace(/[^a-z0-9.]+/g, ' ')
    .trim();
}

function nutrientNamed(name: string): NutrientInfo | undefined {
  const w = words(name);
  return NUTRIENTS.find((n) => n.name.test(w));
}

const isCalories = (name: string) => /^(total )?(calories|energy( kcal)?|kcal)$/.test(words(name));
const isServingSize = (name: string) => /^serving size$/.test(words(name));
const isServings = (name: string) => /^(number of )?servings?( per (container|package|pack))?$/.test(words(name));

/** "8 g", "140mg", "<1g", "2.5 mcg", "400 IU", 8 → the amount in the nutrient's own unit. */
export function amountOf(v: unknown, info: NutrientInfo, unitHint?: string): NutrientAmount | undefined {
  let value: number | undefined;
  let unit = unitHint?.trim().toLowerCase();
  let less = false;
  if (typeof v === 'number') value = num(v);
  else if (typeof v === 'string') {
    // "10%" is a % Daily Value, not an amount.
    if (v.includes('%')) return undefined;
    const m = /^\s*(<|less than\s*)?\s*(\d+(?:\.\d+)?|\.\d+)\s*(mcg|µg|μg|ug|mg|g|grams?|milligrams?|micrograms?|iu)?\b/i.exec(v);
    if (!m) return undefined;
    less = !!m[1];
    value = Number(m[2]);
    if (m[3]) unit = m[3].toLowerCase();
  }
  if (value === undefined || !Number.isFinite(value) || value < 0) return undefined;
  const from: NutrientUnit | 'iu' | undefined = !unit
    ? undefined
    : /^(mcg|µg|μg|ug|micrograms?)$/.test(unit)
      ? 'mcg'
      : /^(mg|milligrams?)$/.test(unit)
        ? 'mg'
        : /^(g|grams?)$/.test(unit)
          ? 'g'
          : unit === 'iu'
            ? 'iu'
            : undefined;
  // Only vitamin D is still written in IU on some labels: 40 IU to the microgram.
  if (from === 'iu') {
    if (info.key !== 'vitaminD') return undefined;
    value /= 40;
  } else if (from && from !== info.unit) value = (value / PER_GRAM[from]) * PER_GRAM[info.unit];
  return { value: tidy(value), unit: info.unit, ...(less ? { less } : {}) };
}

const tidy = (v: number) => Math.round(v * 1000) / 1000;

/** "10%", "10", 10 → 10. */
function percentOf(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(/^\s*<?\s*(\d+(?:\.\d+)?)\s*%?\s*$/.exec(v)?.[1] ?? NaN) : NaN;
  return Number.isFinite(n) && n >= 0 && n < 10_000 ? Math.round(n) : undefined;
}

/** "240 calories", "240 kcal", 240. Kilojoules are turned into calories. */
function caloriesOf(v: unknown): number | undefined {
  if (typeof v === 'number') return v >= 0 && v < 10_000 ? Math.round(v) : undefined;
  if (typeof v !== 'string') return undefined;
  const m = /^\s*(\d+(?:\.\d+)?)\s*(kj|kilojoules?)?/i.exec(v);
  if (!m) return undefined;
  const n = Number(m[1]) / (m[2] ? 4.184 : 1);
  return n < 10_000 ? Math.round(n) : undefined;
}

const text = (v: unknown): string | undefined => {
  const s = typeof v === 'number' && Number.isFinite(v) ? String(v) : str(v)?.trim();
  return s && s.length <= 60 ? s : undefined;
};

interface Draft {
  servingSize?: string;
  servingsPerContainer?: string;
  calories?: number;
  nutrients: Partial<Record<NutrientKey, NutrientAmount>>;
}

/** Enough to be a Nutrition Facts label: calories, or two nutrients. Fills in the % Daily Values the source left out. */
function finish(d: Draft, per100?: 'g' | 'ml'): Nutrition | undefined {
  const found = Object.keys(d.nutrients).length;
  if (d.calories === undefined && found < 2) return undefined;
  let dvWorkedOut = false;
  const nutrients: Nutrition['nutrients'] = {};
  for (const info of NUTRIENTS) {
    const a = d.nutrients[info.key];
    if (!a) continue;
    // A % per 100 g isn't a % of anything on the package.
    if (a.dv === undefined && info.dv && !per100) {
      nutrients[info.key] = { ...a, dv: Math.round((a.value / info.dv) * 100) };
      dvWorkedOut = true;
    } else nutrients[info.key] = a;
  }
  return {
    ...(d.servingSize ? { servingSize: d.servingSize } : {}),
    ...(d.servingsPerContainer ? { servingsPerContainer: d.servingsPerContainer } : {}),
    ...(d.calories !== undefined ? { calories: d.calories } : {}),
    nutrients,
    dvWorkedOut,
    ...(per100 ? { per100 } : {}),
  };
}

/** schema.org NutritionInformation: `calories: "240 calories"`, `fatContent: "8 g"`, `servingSize: "1 cup"`. */
export function nutritionFromSchemaOrg(node: unknown): Nutrition | undefined {
  const n = Array.isArray(node) ? node.find(isObj) : node;
  if (!isObj(n)) return undefined;
  const d: Draft = { nutrients: {}, servingSize: text(n.servingSize), calories: caloriesOf(n.calories) };
  for (const info of NUTRIENTS) {
    const a = info.ld ? amountOf(n[info.ld], info) : undefined;
    if (a) d.nutrients[info.key] = a;
  }
  return finish(d);
}

const NAME_KEYS = ['name', 'label', 'title', 'nutrientName', 'nutrient_name', 'nutrient', 'displayName', 'display_name', 'type', 'description'];
const AMOUNT_KEYS = ['amount', 'quantity', 'value', 'amountPerServing', 'amount_per_serving', 'displayAmount', 'display_amount', 'qty', 'measure', 'amountText'];
const UNIT_KEYS = ['unit', 'units', 'unitOfMeasure', 'unit_of_measure', 'unitOfMeasurement', 'unit_of_measurement', 'uom', 'unitName', 'unit_name'];
const DV_KEYS = ['dvp', 'dv', 'dailyValue', 'daily_value', 'percentDailyValue', 'percent_daily_value', 'dailyValuePercent', 'daily_value_percent', 'percentage', 'percent', 'pdv', 'dvPercent'];

const first = (o: Obj, keys: string[]): unknown => {
  for (const k of keys) if (o[k] !== undefined && o[k] !== null && o[k] !== '') return o[k];
  return undefined;
};

/** A value that is itself a list of values, as some pages write a serving size: `values: [{ value: '1 cup' }]`. */
function flatText(v: unknown, depth = 0): string | undefined {
  if (depth > 3) return undefined;
  const t = text(v);
  if (t) return t;
  if (Array.isArray(v)) return v.map((x) => flatText(x, depth + 1)).find(Boolean);
  if (isObj(v)) return flatText(first(v, ['value', 'values', ...AMOUNT_KEYS]), depth + 1);
  return undefined;
}

/**
 * Nutrition in a page's own data, however it's shaped: rows of `{ name: 'Total Fat', amount: '8g', dvp: '10%' }`
 * (Walmart's, nested under their parent nutrient), `{ name, quantity, unit_of_measurement, percentage }` (Target's), or
 * plain fields (`totalFat: '8 g'`). Only inside a field whose name says nutrition, so a description that mentions
 * calcium isn't taken for a label.
 */
export function nutritionFromData(root: unknown, productId?: string): Nutrition | undefined {
  const subtrees: unknown[] = [];
  const find = (v: unknown, depth: number) => {
    if (depth > 14 || subtrees.length >= 4) return;
    if (Array.isArray(v)) v.slice(0, 50).forEach((x) => find(x, depth + 1));
    else if (isObj(v)) {
      // Looking through a whole page's data: another product (a related item, a carousel) keeps its own label.
      if (productId && otherProduct(v, productId)) return;
      for (const [k, child] of Object.entries(v)) {
        if (/nutri/i.test(k) && (isObj(child) || Array.isArray(child))) subtrees.push(child);
        else find(child, depth + 1);
      }
    }
  };
  find(root, 0);

  for (const tree of subtrees) {
    const d: Draft = { nutrients: {} };
    const visit = (v: unknown, depth: number) => {
      if (depth > 10) return;
      if (Array.isArray(v)) return v.slice(0, 80).forEach((x) => visit(x, depth + 1));
      if (!isObj(v)) return;
      const name = NAME_KEYS.map((k) => str(v[k])).find(Boolean);
      if (name) {
        const amount = first(v, AMOUNT_KEYS);
        const unit = str(first(v, UNIT_KEYS));
        const info = nutrientNamed(name);
        if (info && !d.nutrients[info.key]) {
          const a = amountOf(amount, info, unit);
          if (a) {
            const dv = percentOf(first(v, DV_KEYS));
            d.nutrients[info.key] = dv !== undefined ? { ...a, dv } : a;
          }
        } else if (isCalories(name) && d.calories === undefined) d.calories = caloriesOf(amount);
        else if (isServingSize(name) && !d.servingSize) d.servingSize = flatText(amount ?? v.values);
        else if (isServings(name) && !d.servingsPerContainer) d.servingsPerContainer = flatText(amount ?? v.values);
      }
      for (const [k, child] of Object.entries(v)) {
        if (NAME_KEYS.includes(k) || AMOUNT_KEYS.includes(k) || UNIT_KEYS.includes(k) || DV_KEYS.includes(k)) {
          if (typeof child !== 'object' || child === null) continue;
        }
        const keyWords = words(k);
        if (typeof child === 'string' || typeof child === 'number') {
          const info = nutrientNamed(k);
          if (info && !d.nutrients[info.key]) {
            const a = amountOf(child, info, str(v[`${k}Unit`]) ?? str(v[`${k}_unit`]));
            if (a) d.nutrients[info.key] = a;
          } else if (isCalories(k) && d.calories === undefined) d.calories = caloriesOf(child);
          else if (keyWords === 'serving size' && !d.servingSize) {
            const unit = str(v.servingSizeUnit) ?? str(v.serving_size_unit) ?? str(v.serving_size_unit_of_measurement) ?? str(v.servingSizeUom);
            d.servingSize = text(unit && !String(child).toLowerCase().includes(unit.toLowerCase()) ? `${child} ${unit}` : child);
          } else if (/^servings? per (container|package|pack)$/.test(keyWords) && !d.servingsPerContainer) d.servingsPerContainer = text(child);
        } else visit(child, depth + 1);
      }
    };
    visit(tree, 0);
    const n = finish(d);
    if (n) return n;
  }
  return undefined;
}

// Keys that name a product, where it's a product: a page's own "id" can name anything, so it isn't one.
const PRODUCT_ID_KEYS = ['usItemId', 'tcin', 'productId', 'product_id', 'itemId', 'item_id', 'sku', 'skuId', 'sku_id', 'upc', 'gtin', 'gtin13'];

const otherProduct = (o: Obj, productId: string): boolean =>
  PRODUCT_ID_KEYS.some((k) => (typeof o[k] === 'string' || typeof o[k] === 'number') && String(o[k]) !== productId);

/** Open Food Facts' answer for a barcode: per serving where it has servings, else per 100 g (or ml). */
export function nutritionFromOpenFoodFacts(json: unknown): Nutrition | undefined {
  if (!isObj(json) || json.status !== 1 || !isObj(json.product) || !isObj(json.product.nutriments)) return undefined;
  const p = json.product;
  const n = p.nutriments as Obj;
  const perServing = num(n['energy-kcal_serving']) !== undefined || NUTRIENTS.some((i) => num(n[`${i.off}_serving`]) !== undefined);
  const suffix = perServing ? '_serving' : '_100g';
  const per100 = perServing ? undefined : /ml/i.test(str(p.nutrition_data_per) ?? '') ? 'ml' : 'g';
  const kcal = num(n[`energy-kcal${suffix}`]);
  const kj = num(n[`energy-kj${suffix}`]) ?? num(n[`energy${suffix}`]);
  const d: Draft = {
    nutrients: {},
    servingSize: perServing ? text(p.serving_size) : `100 ${per100}`,
    calories: kcal !== undefined ? Math.round(kcal) : kj !== undefined ? Math.round(kj / 4.184) : undefined,
  };
  for (const info of NUTRIENTS) {
    // Open Food Facts keeps every nutrient in grams.
    const a = amountOf(num(n[`${info.off}${suffix}`]), info, 'g');
    if (a) d.nutrients[info.key] = a;
  }
  return finish(d, per100);
}

/** The GTIN check digit for the digits before it. */
function checkDigit(body: string): string {
  let sum = 0;
  for (let i = 0; i < body.length; i++) sum += Number(body[body.length - 1 - i]) * (i % 2 === 0 ? 3 : 1);
  return String((10 - (sum % 10)) % 10);
}

const validGtin = (d: string) => d.length >= 8 && checkDigit(d.slice(0, -1)) === d.slice(-1);

/**
 * The barcode as Open Food Facts files it: 8 or 13 digits (a UPC-A is an EAN-13 with a leading zero), or null. A
 * barcode written without its check digit, as Kroger writes its UPCs ("0001111041700"), gets it back.
 */
export function openFoodFactsCode(gtin: string): string | null {
  let d = gtin.replace(/\D/g, '');
  if (d.length < 8 || d.length > 14) return null;
  if (!validGtin(d)) {
    const body = d.replace(/^0+/, '');
    if (body.length < 6 || body.length > 12) return null;
    d = body.padStart(12, '0') + checkDigit(body.padStart(12, '0'));
  }
  if (d.length === 14 && d.startsWith('0')) d = d.slice(1);
  if (d.length === 12) d = `0${d}`;
  return d.length === 8 || d.length === 13 ? d : null;
}

export const openFoodFactsUrl = (code: string) =>
  `https://world.openfoodfacts.org/api/v2/product/${code}.json?fields=serving_size,nutrition_data_per,nutriments`;

export type FetchLike = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface NutritionLookup {
  /** The product's Nutrition Facts from Open Food Facts, by barcode; null when it doesn't have them. */
  lookup(gtin: string): Promise<Nutrition | null>;
  /** Forgets every answer (Erase everything). A lookup under way then keeps nothing. */
  clear(): void;
}

/**
 * Looks up barcodes at Open Food Facts, once each while the app is open: answers, "not there" included, are kept in
 * memory. A failed request isn't kept, so opening the product again asks again.
 */
export function createNutritionLookup(fetchImpl: FetchLike, timeoutMs = 8000): NutritionLookup {
  const answers = new Map<string, Nutrition | null>();
  const pending = new Map<string, Promise<Nutrition | null>>();
  let epoch = 0;
  const lookup = (gtin: string): Promise<Nutrition | null> => {
    const code = openFoodFactsCode(gtin);
    if (!code) return Promise.resolve(null);
    if (answers.has(code)) return Promise.resolve(answers.get(code)!);
    const waiting = pending.get(code);
    if (waiting) return waiting;
    const at = epoch;
    let run: Promise<Nutrition | null> | undefined;
    run = (async () => {
      const abort = typeof AbortController === 'function' ? new AbortController() : undefined;
      const timer = setTimeout(() => abort?.abort(), timeoutMs);
      try {
        // Open Food Facts asks apps to say who they are.
        const res = await fetchImpl(openFoodFactsUrl(code), { headers: { 'User-Agent': 'StretchOnDevicePOC/1.0 (nutrition facts by barcode)' }, signal: abort?.signal });
        if (!res.ok && res.status !== 404) return null;
        const value = res.status === 404 ? null : (nutritionFromOpenFoodFacts(await res.json()) ?? null);
        if (at === epoch) answers.set(code, value);
        return value;
      } catch {
        return null;
      } finally {
        clearTimeout(timer);
        // After a clear, a newer lookup of the same barcode may be the one waiting.
        if (pending.get(code) === run) pending.delete(code);
      }
    })();
    pending.set(code, run);
    return run;
  };
  return {
    lookup,
    clear: () => {
      epoch += 1;
      answers.clear();
      pending.clear();
    },
  };
}

/** How an amount reads on the label: "8g", "140mg", "<1g", "2.5mcg". */
export function amountText(a: NutrientAmount): string {
  const v = a.value >= 10 ? Math.round(a.value) : Math.round(a.value * 10) / 10;
  return `${a.less ? '<' : ''}${v}${a.unit}`;
}

/** What a screen reader says for an amount: "8 grams". */
export function amountWords(a: NutrientAmount): string {
  const unit = { g: 'grams', mg: 'milligrams', mcg: 'micrograms' }[a.unit];
  return `${a.less ? 'less than ' : ''}${amountText(a).replace(/^<|[a-z]+$/g, '')} ${unit}`;
}

export const nutrientInfo = (key: NutrientKey): NutrientInfo => BY_KEY.get(key)!;
