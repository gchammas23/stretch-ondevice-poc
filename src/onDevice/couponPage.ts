import { isObj, type Obj } from './json';
import { BUTTON_LINE, cash, dateOf, listsIn, parseJson, rangeIn, TO_KEY, valueAt, type ListPagePayload, type PageCard } from './adPage';
import type { PageSource } from './types';

// Pure functions only: no React Native imports, so the tests run them in Node.
//
// Reads a signed-in account's digital coupons from the store's own coupons page, as the phone loaded it hidden: what
// each is for (its brand and words), what it takes off ("$1 off", "25% off", "Buy 2, save $1"), when it expires, and
// whether it's clipped to the account. General rules, no code per store: the largest list of coupons in the data the
// page fetched for itself, whatever its fields are called, else the coupon tiles drawn on the page, with their buttons.

/** One digital coupon, as the store's page listed it for the account. */
export interface Coupon {
  /** The store's id for it, else its words. */
  id: string;
  /** The brand it's for, when it says: "Tide". */
  brand?: string;
  /** What it's for, as the store words it: "Save $1.00 on any ONE Tide PODS". */
  title: string;
  /** What it takes off: an amount, a share, or the price with it (for `qty` of them), or one free. */
  off?: number;
  pct?: number;
  price?: number;
  free?: boolean;
  /** How many to buy for it: 2 in "Save $1 on 2". */
  qty?: number;
  /** What it's worth, in a few words: "$1 off", "25% off", "Buy 2, save $1", "$2.99 with it". */
  value: string;
  /** Its last day, 'YYYY-MM-DD'. */
  expires?: string;
  /** The barcodes it's good for, when the store lists them: a product with one of these fits for sure. */
  upcs?: string[];
  /** Clipped to the account: it comes off at checkout. */
  clipped: boolean;
  /** Clipped in the app (Clip), and when: until a read of the page confirms it. */
  clippedAt?: number;
  imageUrl?: string;
}

/** An account's coupons, as its coupons page listed them. */
export interface CouponList {
  coupons: Coupon[];
  /** The page listed coupons without the account (every tile says to sign in): signed out on the store's site. */
  signedOut?: boolean;
  /** Where they were: "api.kroger.com/… (184)", "tiles on the page (40)". */
  source?: string;
}

/** A coupon's worth, from its words or its data. */
export interface CouponValue {
  off?: number;
  pct?: number;
  price?: number;
  free?: boolean;
  qty?: number;
  words: string;
}

const NUMBER = '(\\d{1,4}(?:\\.\\d{1,2})?|\\.\\d{1,2})';
const COUNTS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const count = (s: string): number => COUNTS[s.toLowerCase()] ?? Number(s);
const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Words that say the page wants the account, not a coupon: "Sign in to clip", "Log in to see your coupons". */
export const SIGNED_OUT_WORDS =
  /\b(?:sign|log)[\s-]?in\s+(?:to|and)\s+(?:clip|see|view|use|save|load|add|access|get|start)\b|\bsign in or create an account\b|\bplease (?:sign|log)[\s-]?in\b/i;

/**
 * How many to buy for a coupon, from its words: "on TWO (2)", "when you buy 2", "Buy 3". Not a size ("on 10 oz").
 * Undefined when they don't say, or say one.
 */
export function quantityIn(t: string): number | undefined {
  const m = /\b(?:when you buy|buy|on|purchase of)\s+(?:any\s+)?(one|two|three|four|five|six|\d{1,2})\b(?:\s*\(\d{1,2}\))?(?!\s*-?\s*(?:(?:oz|ounces?|lbs?|pounds?|ct|count|pk|packs?|fl|g|kg|ml|l|liters?)\b|%|\$|\.\d))/i.exec(t);
  const n = m ? count(m[1]) : undefined;
  return n !== undefined && n >= 2 && n <= 10 ? n : undefined;
}

/**
 * A coupon's worth from its words: "$1.00 off", "Save $0.75 on 2", "Save 25%", "50¢ off", "2 for $5", "$2.99",
 * "FREE". Null when they give none.
 */
export function couponValue(raw: string | undefined | null): CouponValue | null {
  if (!raw) return null;
  const t = raw.replace(/\s+/g, ' ').trim();
  if (!t || t.length > 300 || /\bup\s+to\b/i.test(t)) return null;
  const qty = quantityIn(t);
  const n = qty ? { qty } : {};
  const pct = /(\d{1,2})\s*%\s*off\b|\bsave\s+(\d{1,2})\s*%/i.exec(t);
  if (pct) {
    const v = Number(pct[1] ?? pct[2]);
    if (v > 0 && v < 100) return { pct: v, ...n, words: qty ? `Buy ${qty}, save ${v}%` : `${v}% off` };
  }
  const off = new RegExp(`\\bsave\\s+\\$\\s?${NUMBER}|\\$\\s?${NUMBER}\\s*off\\b`, 'i').exec(t);
  const centsOff = /\bsave\s+(\d{1,2})\s*¢|(\d{1,2})\s*¢\s*off\b/i.exec(t);
  const amount = off ? Number(off[1] ?? off[2]) : centsOff ? Number(centsOff[1] ?? centsOff[2]) / 100 : undefined;
  if (amount !== undefined && amount > 0 && amount < 200) {
    const v = round2(amount);
    return { off: v, ...n, words: qty ? `Buy ${qty}, save ${cash(v)}` : `${cash(v)} off` };
  }
  const multi = new RegExp(`\\b(\\d{1,2})\\s*(?:for|/)\\s*\\$\\s?${NUMBER}`, 'i').exec(t);
  if (multi && Number(multi[1]) >= 2 && Number(multi[1]) <= 10) {
    const total = Number(multi[2]);
    return { price: round2(total), qty: Number(multi[1]), words: `${multi[1]} for ${cash(total)} with it` };
  }
  const price = new RegExp(`^(?:now|only|price|pay)?\\s*\\$\\s?${NUMBER}(?:\\s*(?:each|ea))?$`, 'i').exec(t) ?? new RegExp(`\\bfor (?:just |only )?\\$\\s?${NUMBER}\\b`, 'i').exec(t);
  if (price && Number(price[1]) > 0) return { price: round2(Number(price[1])), ...n, words: `${cash(Number(price[1]))} with it` };
  if (/^(?:free|get (?:one|1|it) free|free item)$/i.test(t) || (/\bfree\b(?!\s+(?:delivery|shipping|pickup))/i.test(t) && /\b(?:get|free item|item free|for free)\b/i.test(t))) {
    return { free: true, ...n, words: qty ? `Buy ${qty}, get one free` : 'Free' };
  }
  return null;
}

// --- Coupons in the page's data ---------------------------------------------------------------------------------

/** What a coupon is for, and what it's worth, in words: shortest first. */
const TITLE_KEYS = ['shortDescription', 'short_description', 'title', 'offerTitle', 'offer_title', 'displayDescription', 'display_description', 'description', 'offerDescription', 'couponDescription', 'name', 'summary', 'headline', 'requirementDescription', 'longDescription', 'details'];
/** The barcodes it's good for. */
const UPC_KEY = /^(upcs?|gtins?|product_?upcs?|qualifying_?upcs?)$/i;
const BRAND_KEY = /^(brand_?name|brand|manufacturer(?:_?name)?|brand_?display_?name)$/i;
/** What it's worth, as a number or words. */
const VALUE_KEY = /^(savings|value|amount|discount|offer_?price|offer_?value|savings_?amount|reward_?value|display_?value|value_?text|coupon_?value|discount_?value|amount_?off|face_?value|offer_?savings|savings_?text|display_?savings|price|display_?price)$/i;
const QTY_KEY = /^(requirement_?quantity|min_?qty|minimum_?quantity|purchase_?quantity|min_?purchase_?qty|minimum_?purchase_?quantity|buy_?quantity|required_?qty|required_?quantity)$/i;
const ID_KEYS = ['couponId', 'coupon_id', 'offerId', 'offer_id', 'id', 'code', 'krogerCouponNumber', 'displayId', 'offerNumber'];
/** Clipped, as a yes or no: "clipped": true, "isAddedToCard": false. */
const CLIP_FLAG = /^(?:is_?)?(?:clipped|added|loaded|activated|claimed|saved)(?:_?to_?(?:card|account|list))?$/i;
/** Clipped, as a status: "status": "C" (Safeway's clipped), "U" (unclipped), "ADDED", "AVAILABLE". */
const CLIP_STATUS = /^(?:clip_?status|clip_?state|status|state|offer_?status|clipped_?status|load_?status|coupon_?status)$/i;
const CLIPPED = /^(?:c|clipped|added|loaded|activated|claimed|saved|clipped_?to_?card|added_?to_?card)$/i;
const UNCLIPPED = /^(?:u|unclipped|available|not_?clipped|clippable|new|unloaded|not_?loaded|not_?added)$/i;
const IMAGE_KEY = /^(image_?url|image|img|thumbnail|thumbnail_?url|image_?link|product_?image|brand_?logo)$/i;

const text = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.replace(/\s+/g, ' ').trim() : undefined);

/** A day in data, or in a small object ({ value: '2026-10-04' }). */
function dayIn(v: unknown): string | undefined {
  if (isObj(v)) return dateOf(v.value ?? v.date ?? v.iso ?? v.dateTime ?? v.utc);
  return dateOf(v);
}

/** Clipped or not, when the data says; undefined when it doesn't. */
function clippedIn(o: Obj): boolean | undefined {
  for (const [k, v] of Object.entries(o)) {
    if (typeof v === 'boolean' && CLIP_FLAG.test(k)) return v;
    if (typeof v === 'string' && CLIP_STATUS.test(k)) {
      if (CLIPPED.test(v.trim())) return true;
      if (UNCLIPPED.test(v.trim())) return false;
    }
  }
  return undefined;
}

function brandIn(o: Obj): string | undefined {
  const v = valueAt(o, BRAND_KEY);
  const name = typeof v === 'string' ? v : isObj(v) ? text(v.name ?? v.displayName ?? v.title) : undefined;
  const clean = name?.replace(/[®™]/g, '').replace(/\s+/g, ' ').trim();
  return clean && clean.length >= 2 && clean.length <= 60 ? clean : undefined;
}

/** What a coupon is worth: its value's own field, else the first of its words that says. */
function valueIn(o: Obj, texts: string[]): CouponValue | null {
  for (const [k, v] of Object.entries(o)) {
    if (!VALUE_KEY.test(k)) continue;
    if (typeof v === 'string') {
      const read = couponValue(v);
      if (read) return read;
    } else if (typeof v === 'number' && v > 0 && v < 200) {
      // A plain number: a price where the field says so, else what it takes off.
      return /price/i.test(k) ? { price: round2(v), words: `${cash(round2(v))} with it` } : { off: round2(v), words: `${cash(round2(v))} off` };
    }
  }
  for (const t of texts) {
    const read = couponValue(t);
    if (read) return read;
  }
  return null;
}

/** Words that say what a coupon is for, beyond its worth: "Save $1.00" alone doesn't. */
const saysWhat = (t: string) => t.replace(/\$\s?\d+(?:\.\d+)?|\d+\s*(?:%|¢)|\b(?:save|off|on|any|one|when|you|buy|get|free|with|coupon)\b/gi, ' ').replace(/[^a-z]+/gi, ' ').trim().split(' ').filter((w) => w.length >= 3).length >= 1;

/** The barcodes a coupon lists, as digits. */
function upcsIn(o: Obj): string[] | undefined {
  const v = valueAt(o, UPC_KEY);
  const list = (Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[\s,]+/) : []).filter((x): x is string | number => typeof x === 'string' || typeof x === 'number').map((x) => String(x).trim()).filter((x) => /^\d{8,14}$/.test(x));
  return list.length ? list.slice(0, 200) : undefined;
}

/** A coupon from an object of the page's data: words saying what it's for, and what it's worth. Null otherwise. */
function couponFrom(o: Obj): Coupon | null {
  const texts = TITLE_KEYS.map((k) => text(o[k])).filter((t): t is string => !!t && t.length >= 5 && t.length <= 300 && /[a-z]{3}/i.test(t) && !/^https?:/.test(t));
  const title = texts.find(saysWhat);
  if (!title) return null;
  const read = valueIn(o, texts);
  if (!read) return null;
  const clipped = clippedIn(o);
  const expires = dayIn(valueAt(o, TO_KEY));
  const brand = brandIn(o);
  const idValue = ID_KEYS.map((k) => o[k]).find((v) => (typeof v === 'string' && v) || typeof v === 'number');
  // A coupon says whether it's clipped, when it expires or whose it is: a list of plain deals says none of that.
  if (clipped === undefined && !expires && !brand) return null;
  const qtyField = valueAt(o, QTY_KEY);
  const qty = typeof qtyField === 'number' && qtyField >= 2 && qtyField <= 10 ? qtyField : (read.qty ?? texts.map(quantityIn).find((n) => n !== undefined));
  const upcs = upcsIn(o);
  const image = valueAt(o, IMAGE_KEY);
  const imageUrl = typeof image === 'string' && /^https?:\/\//.test(image) ? image : undefined;
  const value: CouponValue = qty && qty !== read.qty ? { ...read, ...couponValue(`${read.words} on ${qty}`), qty } : read;
  return {
    id: idValue !== undefined ? String(idValue) : `text:${title}`,
    ...(brand ? { brand } : {}),
    title,
    ...(value.off !== undefined ? { off: value.off } : {}),
    ...(value.pct !== undefined ? { pct: value.pct } : {}),
    ...(value.price !== undefined ? { price: value.price } : {}),
    ...(value.free ? { free: true } : {}),
    ...(qty ? { qty } : {}),
    value: value.words,
    ...(expires ? { expires } : {}),
    ...(upcs ? { upcs } : {}),
    clipped: clipped === true,
    ...(imageUrl ? { imageUrl } : {}),
  };
}

// --- Coupon tiles drawn on the page -----------------------------------------------------------------------------

/** A tile's button that clips it, and one that says it's clipped. */
const CLIP_BUTTON = /^(?:clip|clip coupon|clip offer|clip to card|load to card|load|add to card|add offer|add|activate|save offer)$/i;
const CLIPPED_BUTTON = /^(?:clipped|unclip|added|loaded|activated|remove|saved|in your card|on your card|clipped to card|added to card)\b/i;

function couponFromCard(card: PageCard, now: number): Coupon | null {
  const lines = card.lines.map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 12);
  const button = card.button?.replace(/\s+/g, ' ').trim() ?? lines.find((l) => CLIP_BUTTON.test(l) || CLIPPED_BUTTON.test(l) || SIGNED_OUT_WORDS.test(l));
  if (!button || !(CLIP_BUTTON.test(button) || CLIPPED_BUTTON.test(button) || SIGNED_OUT_WORDS.test(button))) return null;
  const valueLine = lines.find((l) => l.length <= 80 && couponValue(l));
  if (!valueLine) return null;
  const read = couponValue(valueLine)!;
  const expiresLine = lines.find((l) => /\b(?:exp|expires?|ends?|valid)\b/i.test(l));
  const expires = expiresLine ? rangeIn(expiresLine, now).to : undefined;
  const title = lines
    .filter((l) => l !== valueLine && l !== expiresLine && l !== button && l.length >= 4 && /[a-z]{3}/i.test(l) && !BUTTON_LINE.test(l) && !SIGNED_OUT_WORDS.test(l))
    .sort((a, b) => b.length - a.length)[0];
  if (!title) return null;
  const qty = read.qty ?? quantityIn(title);
  return {
    id: card.id ?? `tile:${title}|${read.words}`,
    title,
    ...(read.off !== undefined ? { off: read.off } : {}),
    ...(read.pct !== undefined ? { pct: read.pct } : {}),
    ...(read.price !== undefined ? { price: read.price } : {}),
    ...(read.free ? { free: true } : {}),
    ...(qty ? { qty } : {}),
    value: read.words,
    ...(expires ? { expires } : {}),
    clipped: CLIPPED_BUTTON.test(button),
    ...(card.img && /^https?:\/\//.test(card.img) ? { imageUrl: card.img } : {}),
  };
}

// --- The account's coupons --------------------------------------------------------------------------------------

/** A list of fewer coupons than this is some other list (a banner's offers). */
const MIN_COUPONS = 2;
const MAX_COUPONS = 600;

function unique(coupons: Coupon[]): Coupon[] {
  const seen = new Set<string>();
  return coupons.filter((c) => (seen.has(c.id) ? false : (seen.add(c.id), true)));
}

/**
 * The account's coupons, from what its coupons page posted: the largest list of coupons in its data (the one that says
 * more of them are clipped or not, on a tie), else its coupon tiles. Signed out when the page asks to sign in and no
 * coupon is clipped: the store listed its coupons for everyone.
 */
export function parseCoupons(payload: ListPagePayload, now: number): CouponList {
  const sources: PageSource[] = [...(payload.sources ?? [])];
  if (payload.nextDataText) sources.push({ label: 'next-data', text: payload.nextDataText });
  let best: { coupons: Coupon[]; label: string; known: number } | undefined;
  for (const source of sources) {
    const root = parseJson(source.text);
    if (!root) continue;
    for (const objs of listsIn(root, MIN_COUPONS)) {
      const found = objs.map((o) => ({ c: couponFrom(o), known: clippedIn(o) !== undefined })).filter((x): x is { c: Coupon; known: boolean } => !!x.c);
      const coupons = unique(found.map((x) => x.c));
      const known = found.filter((x) => x.known).length;
      if (coupons.length >= MIN_COUPONS && (!best || coupons.length > best.coupons.length || (coupons.length === best.coupons.length && known > best.known))) {
        best = { coupons, label: source.label, known };
      }
    }
  }
  if (!best && payload.cards?.length) {
    const coupons = unique(payload.cards.map((c) => couponFromCard(c, now)).filter((c): c is Coupon => !!c));
    if (coupons.length >= MIN_COUPONS) best = { coupons, label: 'tiles on the page', known: coupons.length };
  }
  const coupons = (best?.coupons ?? []).slice(0, MAX_COUPONS);
  const asks = SIGNED_OUT_WORDS.test(payload.text ?? '') || (payload.cards ?? []).some((c) => SIGNED_OUT_WORDS.test(c.button ?? ''));
  const where = best?.label.replace(/^response /, '').replace(/^https?:\/\//, '').replace(/\?.*$/, '').slice(0, 120);
  return {
    coupons,
    ...(asks && !coupons.some((c) => c.clipped) ? { signedOut: true } : {}),
    ...(where ? { source: `${where} (${coupons.length})` } : {}),
  };
}
