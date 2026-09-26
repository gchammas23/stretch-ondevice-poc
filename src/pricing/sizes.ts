import type { Product } from '../onDevice/types';

// Pure functions only, so the tests run them in Node.
//
// Pack sizes and unit prices, so a Costco two-pack isn't compared with one gallon as if they were the same thing.
// Sizes come from product names ("Whole Milk, 1 gal"), which is good but not perfect: "5.3 oz, 4 ct" yogurt reads as
// one cup. A unit price the store shows itself always wins over one worked out here.

/** Base units: ounces of weight, fluid ounces, or a count of things. */
export type SizeUnit = 'oz' | 'floz' | 'ct';

export interface Size {
  /** In the base unit. */
  amount: number;
  unit: SizeUnit;
  /** Tidied for display: "1 gal", "12 × 12 fl oz", "18 ct". */
  text: string;
}

export interface UnitPrice {
  /** Dollars per base unit: per ounce, per fluid ounce, or each. */
  value: number;
  unit: SizeUnit;
  /** "$0.33/oz", "2.7¢/fl oz", "$0.27 each". */
  text: string;
  /** Worked out from the name; the store didn't show one. */
  estimated: boolean;
}

interface Measure {
  pattern: string;
  unit: SizeUnit;
  /** Base units in one of these. */
  factor: number;
  label: string;
}

// Longer spellings first, so "gal" isn't read as "g" and "lb" isn't read as "l".
const MEASURES: Measure[] = [
  { pattern: 'fl\\.?\\s*oz\\.?|fluid\\s*ounces?', unit: 'floz', factor: 1, label: 'fl oz' },
  { pattern: 'gallons?|gal\\.?', unit: 'floz', factor: 128, label: 'gal' },
  { pattern: 'quarts?|qt\\.?', unit: 'floz', factor: 32, label: 'qt' },
  { pattern: 'pints?|pt\\.?', unit: 'floz', factor: 16, label: 'pt' },
  { pattern: 'milliliters?|millilitres?|ml', unit: 'floz', factor: 0.033814, label: 'mL' },
  { pattern: 'liters?|litres?|l', unit: 'floz', factor: 33.814, label: 'L' },
  { pattern: 'ounces?|oz\\.?', unit: 'oz', factor: 1, label: 'oz' },
  { pattern: 'pounds?|lbs?\\.?', unit: 'oz', factor: 16, label: 'lb' },
  { pattern: 'kilograms?|kg', unit: 'oz', factor: 35.274, label: 'kg' },
  { pattern: 'grams?|g', unit: 'oz', factor: 0.035274, label: 'g' },
];

const NUMBER = '(\\d+\\s*\\/\\s*\\d+|\\d*\\.\\d+|\\d+)';
const MEASURE_RE = new RegExp(`${NUMBER}\\s*-?\\s*(${MEASURES.map((m) => m.pattern).join('|')})(?![a-z])`, 'i');
/** "12 pack", "6 cans", "pack of 4", "4 x 12 oz": several of the measured thing. */
const PACK_RE = /(\d+)\s*-?\s*(?:pk|packs?|cans?|bottles?|cups?|pouches|pouch|boxes|box|bags?|jars?|cartons?|containers?)(?![a-z])|pack of (\d+)/i;
const TIMES_RE = new RegExp(`(\\d+)\\s*[x×]\\s*${NUMBER}\\s*(?:${MEASURES.map((m) => m.pattern).join('|')})(?![a-z])`, 'i');
const COUNT_RE =
  /(\d+)\s*-?\s*(?:(?:double|triple|mega|family|huge|giant|jumbo|large|regular|big|super|xl)\s+)?(?:ct|count|ea|each|pcs?|pieces?|rolls?|sheets?|pods?|bars?|sticks?|pk|packs?)(?![a-z])/i;
const DOZEN_RE = /(\d+(?:\.\d+)?)?\s*dozen/i;

function numberOf(text: string): number {
  const fraction = /^(\d+)\s*\/\s*(\d+)$/.exec(text.trim());
  if (fraction) return Number(fraction[1]) / Number(fraction[2]);
  return Number(text);
}

function measureOf(unitText: string): Measure | undefined {
  return MEASURES.find((m) => new RegExp(`^(${m.pattern})$`, 'i').test(unitText.trim()));
}

const tidy = (n: number) => String(Math.round(n * 100) / 100);

/** A pack's size from its name, or null when the name doesn't say. */
export function parseSize(name: string): Size | null {
  const text = name.replace(/\s+/g, ' ');
  if (/\bhalf[\s-]gallon\b/i.test(text)) return { amount: 64, unit: 'floz', text: '½ gal' };

  const m = MEASURE_RE.exec(text);
  if (m) {
    const measure = measureOf(m[2]);
    const each = numberOf(m[1]);
    if (measure && each > 0) {
      const times = TIMES_RE.exec(text);
      const pack = PACK_RE.exec(text);
      const count = times ? Number(times[1]) : pack ? Number(pack[1] ?? pack[2]) : 1;
      const n = count >= 1 && count <= 200 ? count : 1;
      const one = `${tidy(each)} ${measure.label}`;
      return { amount: each * measure.factor * n, unit: measure.unit, text: n > 1 ? `${n} × ${one}` : one };
    }
  }
  const dozen = DOZEN_RE.exec(text);
  if (dozen) {
    const n = Math.round((dozen[1] ? Number(dozen[1]) : 1) * 12);
    return { amount: n, unit: 'ct', text: `${n} ct` };
  }
  const count = COUNT_RE.exec(text);
  if (count && Number(count[1]) > 0) return { amount: Number(count[1]), unit: 'ct', text: `${Number(count[1])} ct` };
  return null;
}

/** "$0.33/oz", "2.7¢/fl oz", "$0.27 each". */
export function formatUnitPrice(value: number, unit: SizeUnit): string {
  const money = value < 0.1 ? `${(value * 100).toFixed(1)}¢` : `$${value.toFixed(2)}`;
  return unit === 'ct' ? `${money} each` : `${money}/${unit === 'floz' ? 'fl oz' : 'oz'}`;
}

const UNIT_WORDS: [RegExp, SizeUnit, number][] = [
  [/^(fl\.?\s*oz|fluid\s*ounces?)/i, 'floz', 1],
  [/^(gallons?|gal)/i, 'floz', 128],
  [/^(quarts?|qt)/i, 'floz', 32],
  [/^(pints?|pt)/i, 'floz', 16],
  [/^(milliliters?|millilitres?|ml)/i, 'floz', 0.033814],
  [/^(liters?|litres?|l)\b/i, 'floz', 33.814],
  [/^(ounces?|oz)/i, 'oz', 1],
  [/^(pounds?|lbs?)/i, 'oz', 16],
  [/^(kilograms?|kg)/i, 'oz', 35.274],
  [/^(grams?|g)\b/i, 'oz', 0.035274],
  [/^(each|ea|count|ct|units?|pieces?|pcs?|items?|rolls?|sheets?|eggs?)/i, 'ct', 1],
];

/** A unit price as a store printed it: "$0.21/oz", "27.2 ¢/oz", "($4.99/pound)", "$0.50 each", "$0.99 / 100 g". */
export function parseUnitPrice(text: string): { value: number; unit: SizeUnit } | null {
  const m = /(?:\$\s*(\d+(?:\.\d+)?)|(\d+(?:\.\d+)?)\s*¢)\s*(\/|per\b|each\b|ea\b)\s*(\d+(?:\.\d+)?)?\s*([a-z][a-z. ]*)?/i.exec(text);
  if (!m) return null;
  const dollars = m[1] !== undefined ? Number(m[1]) : Number(m[2]) / 100;
  if (/^(each|ea)$/i.test(m[3])) return dollars > 0 ? { value: dollars, unit: 'ct' } : null;
  const per = m[4] ? Number(m[4]) : 1;
  const word = (m[5] ?? '').trim();
  const hit = UNIT_WORDS.find(([re]) => re.test(word));
  if (!hit || !(dollars > 0) || !(per > 0)) return null;
  return { value: dollars / (per * hit[2]), unit: hit[1] };
}

/** The product's price per base unit: the store's own figure when it shows one, else worked out from the name. */
export function unitPriceOf(product: Product): UnitPrice | null {
  const price = product.price;
  if (typeof price !== 'number' || !(price > 0)) return null;
  const given = product.unitPriceText ? parseUnitPrice(product.unitPriceText) : null;
  if (given) return { ...given, text: formatUnitPrice(given.value, given.unit), estimated: false };
  const size = parseSize(product.name);
  // One of something costs its price: nothing to add.
  if (!size || (size.unit === 'ct' && size.amount <= 1)) return null;
  const value = price / size.amount;
  return { value, unit: size.unit, text: formatUnitPrice(value, size.unit), estimated: true };
}

/** Ounces of weight and fluid ounces are compared as one family: close enough for groceries. */
const family = (unit: SizeUnit) => (unit === 'ct' ? 'ct' : 'oz');

export interface SizeNote {
  size: Size | null;
  unitPrice: UnitPrice | null;
  /** This pack is at least this many times the size of the smallest comparable one elsewhere... */
  bigger?: { times: number; than: string };
  /** ...or at most this fraction of the largest. */
  smaller?: { times: number; than: string };
  /** The lowest price per unit of the stores that have this item in the same unit. */
  cheapestPerUnit: boolean;
}

/** Packs this much bigger or smaller than another store's are called out. */
const NOTE_RATIO = 1.8;

/** One item's picks across stores: how each pack's size and price per unit compare with the others'. */
export function compareSizes(entries: { retailerId: string; product: Product }[]): Record<string, SizeNote> {
  const rows = entries.map((e) => ({ ...e, size: parseSize(e.product.name), unit: unitPriceOf(e.product) }));
  const out: Record<string, SizeNote> = {};
  for (const row of rows) {
    const note: SizeNote = { size: row.size, unitPrice: row.unit, cheapestPerUnit: false };
    const others = rows.filter((o) => o !== row && o.size && row.size && family(o.size.unit) === family(row.size.unit));
    if (row.size && others.length) {
      const smallest = others.reduce((a, b) => (b.size!.amount < a.size!.amount ? b : a));
      const largest = others.reduce((a, b) => (b.size!.amount > a.size!.amount ? b : a));
      const up = row.size.amount / smallest.size!.amount;
      const down = row.size.amount / largest.size!.amount;
      if (up >= NOTE_RATIO) note.bigger = { times: Math.round(up * 10) / 10, than: smallest.retailerId };
      else if (down <= 1 / NOTE_RATIO) note.smaller = { times: Math.round(down * 10) / 10, than: largest.retailerId };
    }
    const comparable = rows.filter((o) => o.unit && row.unit && family(o.unit.unit) === family(row.unit.unit));
    if (row.unit && comparable.length >= 2) {
      const lowest = Math.min(...comparable.map((o) => o.unit!.value));
      const runnerUp = Math.min(...comparable.filter((o) => o !== row).map((o) => o.unit!.value));
      note.cheapestPerUnit = row.unit.value === lowest && row.unit.value < runnerUp * 0.99;
    }
    out[row.retailerId] = note;
  }
  return out;
}
