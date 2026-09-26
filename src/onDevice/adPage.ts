import { isObj, type Obj } from './json';
import { autoDetect } from './parsers';
import type { PagePayload, PageSource } from './types';

// Pure functions only: no React Native imports, so the tests run them in Node.
//
// Reads a store's weekly ad, as the phone loaded its page hidden: each sale item's name, its price as the ad words it
// ("2 for $5", "$1.99/lb", "Buy 1, get 1 free") and what one costs at it, and the days it runs. General rules, no code
// per store: the largest list of sale items in the data the page fetched for itself (a flyer's items, whatever its
// fields are called), or the products the general product reader finds there when that's clearly more (a deals page),
// or else the item cards drawn on the page. The ad's dates come from its items, else from the ad itself in the page's
// data, else from the page's words ("Prices valid 9/24 – 9/30").

/** One sale item in a weekly ad. */
export interface AdItem {
  id: string;
  name: string;
  /** What one costs at the ad's price, when it gives one: 2.5 for "2 for $5"; per pound when `perLb`. */
  price?: number;
  /** The deal as the ad words it, tidied: "2 for $5", "$1.99/lb", "Buy 1, get 1 free", "Save $2", "40% off". */
  deal: string;
  perLb?: boolean;
  /** The regular price, when the ad gives it. */
  wasPrice?: number;
  /** Only with the store's card or program ("with Card", "Club Price"). */
  member?: boolean;
  /** A lower price for members of the store's program, beside the one everyone pays ("$3.49 with Prime"). */
  memberPrice?: number;
  imageUrl?: string;
  /** The days it runs, 'YYYY-MM-DD', both included. */
  from?: string;
  to?: string;
}

/** A store's weekly ad, as read. */
export interface WeeklyAd {
  items: AdItem[];
  /** The days the ad runs, when it says (an item's own dates win for that item). */
  from?: string;
  to?: string;
  /** Where the items were: "dam.flippenterprise.net/flyerkit/publication/1/products (212)", "cards on the page (18)". */
  source?: string;
}

/** An item or a coupon as drawn on a page: its lines of text, and its id, link, button and picture when it has them. */
export interface PageCard {
  lines: string[];
  id?: string;
  href?: string;
  /** Its button's words: "Clip", "Clipped", "Add to list". */
  button?: string;
  img?: string;
}

/** What a list page posts (see listPageScript): its data, its visible words and its cards. */
export interface ListPagePayload extends PagePayload {
  text?: string;
  cards?: PageCard[];
}

/** A list of fewer sale items than this isn't the ad (a banner's two deals, say). */
const MIN_ITEMS = 3;
/** Items kept of one ad. */
const MAX_ITEMS = 400;

// --- Deals ------------------------------------------------------------------------------------------------------

/** A deal as an ad words it. */
export interface Deal {
  /** What one costs, when the words give a price (per pound with `perLb`). */
  price?: number;
  /** How many the price is for: 2 in "2 for $5". */
  qty?: number;
  perLb?: boolean;
  /** "Save $2", "$2 off". */
  off?: number;
  /** "40% off". */
  pct?: number;
  /** "Buy 1, get 1 free": how many to buy, and how many come free (or half off, with `half`). */
  buy?: number;
  get?: number;
  half?: boolean;
  /** Only with the store's card or program. */
  member?: boolean;
  /** Tidied for display. */
  words: string;
}

const NUMBER = '(\\d{1,4}(?:,\\d{3})*(?:\\.\\d{1,2})?|\\.\\d{1,2})';
const COUNTS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const toNumber = (s: string): number => COUNTS[s.toLowerCase()] ?? Number(s.replace(/,/g, ''));
const round2 = (n: number): number => Math.round(n * 100) / 100;
/** "$5", "$2.50": whole dollars without cents. */
export const cash = (n: number): string => (Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`);
/** Words that say a price is for members of the store's program. */
export const MEMBER_WORDS = /\bwith (?:your )?(?:card|digital coupon|coupon|membership)\b|\bclub price\b|\bmembers?\b|\bprime\b|\bcircle\b|\bfor u\b|\bmperks\b|\brewards? price\b|\bloyalty\b/i;

/**
 * A deal from an ad's words: "2 for $5", "2/$5.00", "$1.99 lb", "99¢", "Buy 1 Get 1 Free", "BOGO", "Save $2",
 * "40% off", "$3.99 with Card". Null when the words hold no deal. `loose`: the words are only a price, as a flyer's data
 * gives its pieces ("2/ 5.00", "3.99 ea"), so a bare number is a price and "2/5" is 2 for $5, not a date.
 */
export function parseDeal(raw: string | undefined | null, loose = false): Deal | null {
  if (!raw) return null;
  const text = raw.replace(/\s+/g, ' ').trim();
  if (!text || text.length > 140) return null;
  const member = MEMBER_WORDS.test(text) ? { member: true as const } : {};
  const perLb = /(?:\/|\bper\b|\s|\d)\s*(?:lb|lbs|pound)\b\.?/i.test(text) ? { perLb: true as const } : {};

  // "Buy 1, get 1 free", "BOGO", "Buy 2 Get 1 50% off".
  const bogo = /\bbogo\b|\bb1g1\b/i.test(text);
  const buyGet = /\bbuy\s+(one|two|three|four|\d{1,2})\b[^a-z0-9%]*(?:and\s+)?get\s+(one|two|three|\d{1,2})\b\s*(free|50\s*%\s*off|half\s+off)?/i.exec(text);
  if (buyGet || bogo) {
    const buy = buyGet ? toNumber(buyGet[1]) : 1;
    const get = buyGet ? toNumber(buyGet[2]) : 1;
    const half = !!buyGet?.[3] && !/free/i.test(buyGet[3]);
    if (buy >= 1 && buy <= 10 && get >= 1 && get <= 10) {
      return { buy, get, ...(half ? { half: true } : {}), ...member, words: `Buy ${buy}, get ${get} ${half ? 'half off' : 'free'}` };
    }
  }

  // "2 for $5", "2/$5.00"; and from a flyer's pieces, "2/ 5.00".
  const multi = new RegExp(`(?:^|[^\\d.$,/])(\\d{1,2})\\s*(?:for|/)\\s*(\\$)?\\s*${NUMBER}(?!\\s*(?:%|\\d|/))`, 'i').exec(text);
  if (multi && (loose || multi[2] || /\bfor\b/i.test(multi[0]))) {
    const qty = Number(multi[1]);
    const total = toNumber(multi[3]);
    if (qty >= 2 && qty <= 20 && total > 0 && total < 1000) {
      return { price: round2(total / qty), qty, ...perLb, ...member, words: `${qty} for ${cash(total)}` };
    }
  }

  // "Save up to $2", "Up to 50% off": nothing sure, whatever else they say.
  if (/\bup\s+to\b/i.test(text)) return null;

  // "40% off", "Save 40%".
  const pct = /(\d{1,2})\s*%\s*off\b|\bsave\s+(\d{1,2})\s*%/i.exec(text);
  if (pct) {
    const value = Number(pct[1] ?? pct[2]);
    if (value > 0 && value < 100) return { pct: value, ...member, words: `${value}% off` };
  }

  // "Save $2", "$2 off". A price given too ("$3.99, save $2") is the deal, and the saving the story around it.
  const off = new RegExp(`\\bsave\\s+\\$\\s?${NUMBER}|\\$\\s?${NUMBER}\\s*off\\b`, 'i').exec(text);
  const offValue = off ? toNumber(off[1] ?? off[2]) : undefined;
  const amounts = [...text.matchAll(new RegExp(`\\$\\s?${NUMBER}`, 'g'))].map((m) => toNumber(m[1]));
  const price = amounts.find((n) => n !== offValue);
  if (offValue !== undefined && price === undefined && offValue > 0 && offValue < 500) return { off: offValue, ...member, words: `Save ${cash(offValue)}` };

  // "$3.99", "$1.99/lb", "99¢"; and from a flyer's pieces, "3.99" or "3.99 ea".
  const cents = /(?:^|[^\d.])(\d{1,2})\s*¢/.exec(text);
  const bare = loose ? new RegExp(`^${NUMBER}(?:\\s*/?\\s*(?:ea|each|lb|lbs)\\.?)?$`, 'i').exec(text) : null;
  const value = price ?? (bare ? toNumber(bare[1]) : cents ? Number(cents[1]) / 100 : undefined);
  if (value !== undefined && value > 0 && value < 10000) {
    const words = price === undefined && !bare && cents ? `${cents[1]}¢` : cash(round2(value));
    return { price: round2(value), ...perLb, ...member, words: perLb.perLb ? `${words}/lb` : words };
  }
  return null;
}

// --- Dates -------------------------------------------------------------------------------------------------------

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const pad = (n: number) => String(n).padStart(2, '0');
const iso = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
const realDay = (y: number, m: number, d: number) =>
  y >= 2000 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= new Date(Date.UTC(y, m, 0)).getUTCDate();

/** The day `ms` falls on, on the phone's calendar: 'YYYY-MM-DD'. */
export function dayOf(ms: number): string {
  const d = new Date(ms);
  return iso(d.getFullYear(), d.getMonth() + 1, d.getDate());
}

/** Days from `a` to `b`, both 'YYYY-MM-DD'. */
export const daysBetween = (a: string, b: string): number => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86_400_000);

/** A month's number from its name or abbreviation ("Sept", "September"): 1 to 12, or 0. */
const monthOf = (name: string): number => MONTHS.indexOf(name.slice(0, 3).toLowerCase()) + 1;

/**
 * A day as data gives it: an ISO string (its own day, not the phone's), epoch seconds or milliseconds, "09/30/2026",
 * "Sep 30, 2026", or "9/30" (the year nearest `now`). Undefined for anything else.
 */
export function dateOf(v: unknown, now = Date.now()): string | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) {
    const ms = v > 1e12 ? v : v > 1e9 ? v * 1000 : NaN;
    return Number.isNaN(ms) ? undefined : dayOf(ms);
  }
  if (typeof v !== 'string') return undefined;
  const s = v.trim();
  if (/^\d{13}$/.test(s)) return dayOf(Number(s));
  if (/^\d{10}$/.test(s)) return dayOf(Number(s) * 1000);
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return realDay(+m[1], +m[2], +m[3]) ? iso(+m[1], +m[2], +m[3]) : undefined;
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})\b/.exec(s);
  if (m) {
    const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    return realDay(y, +m[1], +m[2]) ? iso(y, +m[1], +m[2]) : undefined;
  }
  m = /^(?:[a-z]+\.?,?\s+)?([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/i.exec(s);
  if (m) {
    const month = monthOf(m[1]);
    return month && realDay(+m[3], month, +m[2]) ? iso(+m[3], month, +m[2]) : undefined;
  }
  m = /^(\d{1,2})\/(\d{1,2})$/.exec(s);
  return m ? nearest(+m[1], +m[2], now) : undefined;
}

/** A month and day without a year: the year that puts it nearest `now`. */
function nearest(month: number, day: number, now: number): string | undefined {
  const here = new Date(now);
  const today = Date.UTC(here.getFullYear(), here.getMonth(), here.getDate());
  const years = [here.getFullYear() - 1, here.getFullYear(), here.getFullYear() + 1].filter((y) => realDay(y, month, day));
  if (!years.length) return undefined;
  const y = years.reduce((a, b) => (Math.abs(Date.UTC(b, month - 1, day) - today) < Math.abs(Date.UTC(a, month - 1, day) - today) ? b : a));
  return iso(y, month, day);
}

const withYear = (month: number, day: number, year: string | undefined, now: number): string | undefined => {
  if (!month) return undefined;
  if (!year) return nearest(month, day, now);
  const y = year.length === 2 ? 2000 + Number(year) : Number(year);
  return realDay(y, month, day) ? iso(y, month, day) : undefined;
};

const WEEKDAY = '(?:\\b(?:mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)[a-z]*\\.?,?\\s+)?';
const MONTH = '\\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?';
const DASH = '\\s*(?:-|–|—|to|through|thru|until)\\s*';
const NUMERIC_RANGE = new RegExp(`${WEEKDAY}\\b(\\d{1,2})/(\\d{1,2})(?:/(\\d{4}|\\d{2}))?${DASH}${WEEKDAY}(\\d{1,2})/(\\d{1,2})(?:/(\\d{4}|\\d{2}))?`, 'i');
const NAMED_RANGE = new RegExp(`${WEEKDAY}${MONTH}\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?${DASH}${WEEKDAY}(?:${MONTH}\\s+)?(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s+(\\d{4}))?`, 'i');
const UNTIL = new RegExp(`\\b(?:through|thru|until|til|ends?|expires?|exp\\.?)\\s+${WEEKDAY}(?:\\b(\\d{1,2})/(\\d{1,2})(?:/(\\d{4}|\\d{2}))?|${MONTH}\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s+(\\d{4}))?)`, 'i');

/** A range that ran across new year without saying so ("Dec 30 – Jan 5"): its start is the year before. */
function ordered(from: string, to: string): { from?: string; to: string } {
  if (from <= to) return { from, to };
  const earlier = `${Number(from.slice(0, 4)) - 1}${from.slice(4)}`;
  return earlier <= to ? { from: earlier, to } : { to };
}

/** A range worth taking for this week's ad: it hasn't long ended, doesn't start far off, and lasts days, not months. */
function current(r: { from?: string; to: string }, today: string): boolean {
  if (daysBetween(r.to, today) > 7) return false;
  if (r.from && (daysBetween(today, r.from) > 14 || daysBetween(r.from, r.to) > 45)) return false;
  return true;
}

/**
 * The days an ad runs, from its words: "Prices valid 9/24 – 9/30", "Sale dates: Wed., Sep. 24 – Tue., Sep. 30, 2026",
 * "September 24 - 30", "Valid through 9/30". A year left out is the one that puts the day nearest `now`. Line by line,
 * the first range that could be this week's.
 */
export function rangeIn(text: string | undefined, now: number): { from?: string; to?: string } {
  if (!text) return {};
  const today = dayOf(now);
  const lines = text
    .split(/\n+/)
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter((l) => l.length >= 4 && l.length <= 240);
  for (const line of lines) {
    let m = NUMERIC_RANGE.exec(line);
    if (m) {
      const year = m[6] ?? m[3];
      const from = withYear(+m[1], +m[2], m[3] ?? year, now);
      const to = withYear(+m[4], +m[5], year, now);
      if (from && to && current(ordered(from, to), today)) return ordered(from, to);
    }
    m = NAMED_RANGE.exec(line);
    if (m) {
      const month = monthOf(m[1]);
      const year = m[6] ?? m[3];
      const from = withYear(month, +m[2], m[3] ?? year, now);
      const to = withYear(m[4] ? monthOf(m[4]) : month, +m[5], year, now);
      if (from && to && current(ordered(from, to), today)) return ordered(from, to);
    }
    m = UNTIL.exec(line);
    if (m) {
      const to = m[1] ? withYear(+m[1], +m[2], m[3], now) : withYear(monthOf(m[4]), +m[5], m[6], now);
      if (to && current({ to }, today)) return { to };
    }
  }
  return {};
}

// --- Items in the page's data -----------------------------------------------------------------------------------

const NAME_KEYS = ['name', 'title', 'productName', 'product_name', 'mainlineCopy', 'displayName', 'display_name', 'itemName', 'item_name', 'headline', 'description'];
const ID_KEYS = ['id', 'itemId', 'item_id', 'productId', 'product_id', 'tcin', 'flyer_item_id', 'flyerItemId', 'offerId', 'offer_id', 'dealId', 'deal_id', 'sku', 'upc'];
/** The price itself, as a number or words. */
const PRICE_KEY = /^(current_?price|sale_?price|ad_?price|deal_?price|offer_?price|promo_?price|special_?price|price|final_?price|now_?price|price_?value)$/i;
/** The price as the ad prints it. */
const PRICE_TEXT_KEY = /^(price_?text|display_?price|price_?display|formatted_?price|price_?label|pricing_?text|pricing_?template|ad_?price_?text|sale_?price_?text|deal_?price_?text|price_?string)$/i;
/** What comes before and after the price in print ("2/", "lb"): a flyer's pieces. */
const PRE_KEY = /^(pre_?price_?text|price_?prefix)$/i;
const POST_KEY = /^(post_?price_?text|price_?suffix|price_?unit|uom|unit_?of_?measure)$/i;
/** The deal's story around the price: "Save $2", "Buy 1 Get 1 Free". */
const STORY_KEY = /^(sale_?story|deal_?text|offer_?text|promo(?:tion)?_?(?:text|message|description)|savings(?:_?text)?|additional_?deal_?info|badge_?text|callout|tagline|deal_?description|offer_?description)$/i;
const WAS_KEY = /^(original_?price|regular_?price|reg_?price|retail_?price|was_?price|list_?price|base_?price|strike_?(?:through_?)?price|compare_?at_?price)$/i;
/** A price for members beside everyone's: Whole Foods' "primePrice". */
const MEMBER_PRICE_KEY = /^(prime_?price|member_?price|club_?price|card_?price|loyalty_?price|circle_?price|with_?card_?price)$/i;
/** Only for members, as a yes: Target's "circle_offer". */
const MEMBER_FLAG = /^(?:is_?)?(?:circle_?offer|member_?only|members_?only|club_?only|card_?required|loyalty_?only|prime_?only)$/i;
const BUY_KEY = /^buy_?(?:quantity|qty)$/i;
const GET_KEY = /^get_?(?:quantity|qty)$/i;
const IMAGE_KEY = /^(image_?url|image|img|thumbnail|thumbnail_?url|x_?large_?image_?url|large_?image_?url|image_?link|picture)$/i;
/** When an item or an ad starts, and ends, with a short prefix and "formatted" allowed (Publix's "wa_startDateFormatted"). */
export const FROM_KEY = /^(?:[a-z]{1,3}_)?(valid_?from|start_?date|effective_?date|sale_?start(?:_?date)?|offer_?start(?:_?date)?|begin_?date|start_?time|starts_?at|display_?start(?:_?date)?|valid_?start|from_?date|ad_?start(?:_?date)?)(?:_?formatted)?$/i;
export const TO_KEY = /^(?:[a-z]{1,3}_)?(valid_?to|valid_?until|valid_?till|valid_?through|end_?date|expir(?:ation|y|es)(?:_?date)?|expires_?(?:at|on)|sale_?end(?:_?date)?|offer_?end(?:_?date)?|end_?time|ends_?at|display_?end(?:_?date)?|valid_?end|good_?through|to_?date|ad_?end(?:_?date)?)(?:_?formatted)?$/i;

const text = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.replace(/\s+/g, ' ').trim() : undefined);

/** The first value whose key fits, on the object or in a small object under it ({ dates: { start, end } }). */
export function valueAt(o: Obj, key: RegExp, depth = 0): unknown {
  for (const [k, v] of Object.entries(o)) if (key.test(k) && v !== null && v !== undefined && v !== '') return v;
  if (depth >= 1) return undefined;
  for (const v of Object.values(o)) {
    if (!isObj(v) || Object.keys(v).length > 12) continue;
    const inner = valueAt(v, key, depth + 1);
    if (inner !== undefined) return inner;
  }
  return undefined;
}

const textAt = (o: Obj, key: RegExp): string | undefined => {
  const v = valueAt(o, key);
  return typeof v === 'number' ? String(v) : text(v);
};

/** A price the data gives as a number, as words that are only a price ("3.99", "$3.99"), or in a small object. */
function priceAt(o: Obj): number | undefined {
  for (const [k, v] of Object.entries(o)) {
    if (!PRICE_KEY.test(k)) continue;
    if (typeof v === 'number' && v > 0 && v < 10000) return v;
    if (typeof v === 'string' && /^\s*\$?\s?\d{1,4}(?:\.\d{1,2})?\s*$/.test(v)) return Number(v.replace(/[$\s]/g, '')) || undefined;
    if (isObj(v)) {
      const inner = ['amount', 'value', 'price', 'current', 'sale', 'salePrice', 'currentPrice'].map((x) => v[x]).find((x) => typeof x === 'number' && x > 0 && x < 10000);
      if (typeof inner === 'number') return inner;
    }
  }
  return undefined;
}

function nameAt(o: Obj): string | undefined {
  for (const k of NAME_KEYS) {
    const s = text(o[k]);
    if (s && s.length >= 3 && s.length <= 160 && /[a-z]{2}/i.test(s) && !/^https?:/.test(s)) return s;
  }
  return undefined;
}

function imageAt(o: Obj): string | undefined {
  const v = valueAt(o, IMAGE_KEY);
  const url = typeof v === 'string' ? v : isObj(v) ? (typeof v.url === 'string' ? v.url : typeof v.src === 'string' ? v.src : undefined) : undefined;
  return url && /^https?:\/\//.test(url) ? url : url?.startsWith('//') ? `https:${url}` : undefined;
}

/** Words under a price's own key ("price": "2 for $6"), when they're more than a plain number. */
function priceWordsAt(o: Obj): string | undefined {
  for (const [k, v] of Object.entries(o)) {
    if (PRICE_KEY.test(k) && typeof v === 'string' && !/^\s*\$?\s?\d{1,4}(?:\.\d{1,2})?\s*$/.test(v) && v.trim()) return v.replace(/\s+/g, ' ').trim();
  }
  return undefined;
}

const count = (v: unknown): number | undefined => (typeof v === 'number' && v >= 1 && v <= 20 ? v : typeof v === 'string' && /^\d{1,2}$/.test(v) ? Number(v) : undefined);

/** A sale item from an object of the page's data: a name, and a price or a deal. Null for anything else. */
function itemFrom(o: Obj, now: number): AdItem | null {
  const name = nameAt(o);
  if (!name) return null;
  const price = priceAt(o);
  const pre = textAt(o, PRE_KEY);
  const post = textAt(o, POST_KEY);
  const printed = textAt(o, PRICE_TEXT_KEY) ?? priceWordsAt(o);
  const story = textAt(o, STORY_KEY);
  // The price as the ad prints it, its pieces put together: "2/" "5.00" "lb" is 2 for $5 a pound.
  const composed = [pre, printed ?? (price !== undefined ? String(price) : ''), post].filter(Boolean).join(' ');
  // Buy and get quantities given apart (Kroger's shoppable ad): "Buy 2, get 1 free".
  const buy = count(valueAt(o, BUY_KEY));
  const get = count(valueAt(o, GET_KEY));
  const quantities = buy && get ? parseDeal(`Buy ${buy} get ${get} free`) : null;
  const reads = [parseDeal(composed, true), parseDeal(story), price !== undefined ? parseDeal(cash(price)) : null];
  const deal = quantities ?? reads.find((d) => d?.price !== undefined) ?? reads.find((d) => !!d) ?? null;
  if (!deal) return null;
  const idValue = ID_KEYS.map((k) => o[k]).find((v) => (typeof v === 'string' && v) || typeof v === 'number');
  const was = valueAt(o, WAS_KEY);
  const wasPrice = typeof was === 'number' ? was : typeof was === 'string' ? Number(was.replace(/[$\s,]/g, '')) : undefined;
  const from = dateOf(valueAt(o, FROM_KEY), now);
  const to = dateOf(valueAt(o, TO_KEY), now);
  const flagged = Object.entries(o).some(([k, v]) => v === true && MEMBER_FLAG.test(k));
  const member = deal.member || flagged || MEMBER_WORDS.test(`${story ?? ''} ${pre ?? ''} ${post ?? ''}`);
  const memberValue = valueAt(o, MEMBER_PRICE_KEY);
  const memberPrice = typeof memberValue === 'number' ? memberValue : typeof memberValue === 'string' ? Number(memberValue.replace(/[$\s,]/g, '')) : undefined;
  const imageUrl = imageAt(o);
  return {
    id: idValue !== undefined ? String(idValue) : `name:${name}|${deal.words}`,
    name,
    ...(deal.price !== undefined ? { price: deal.price } : {}),
    deal: deal.words,
    ...(deal.perLb ? { perLb: true } : {}),
    ...(wasPrice !== undefined && Number.isFinite(wasPrice) && deal.price !== undefined && wasPrice > deal.price && wasPrice < deal.price * 5 ? { wasPrice } : {}),
    ...(member ? { member: true } : {}),
    ...(memberPrice !== undefined && Number.isFinite(memberPrice) && memberPrice > 0 && (deal.price === undefined || memberPrice < deal.price - 0.004) ? { memberPrice } : {}),
    ...(imageUrl ? { imageUrl } : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
  };
}

/** Arrays of objects, and big id-keyed maps, anywhere in a JSON document, as the general product reader walks them. */
export function listsIn(root: unknown, min = MIN_ITEMS, out: Obj[][] = [], depth = 0): Obj[][] {
  if (depth > 30 || typeof root !== 'object' || root === null) return out;
  if (Array.isArray(root)) {
    const objs = root.filter(isObj);
    if (objs.length >= min) out.push(objs);
    for (const child of objs) listsIn(child, min, out, depth + 1);
    return out;
  }
  const values = Object.values(root as Obj);
  const objs = values.filter(isObj);
  if (objs.length >= Math.max(5, min) && objs.length >= values.length * 0.8) out.push(objs);
  for (const child of values) listsIn(child, min, out, depth + 1);
  return out;
}

/** The ad's own days, from objects in the data that have both a start and an end (a flyer, a publication). */
function adDays(root: unknown, now: number, found: { from: string; to: string }[] = [], depth = 0): { from: string; to: string }[] {
  if (depth > 12 || typeof root !== 'object' || root === null || found.length > 50) return found;
  if (Array.isArray(root)) {
    for (const child of root.slice(0, 100)) adDays(child, now, found, depth + 1);
    return found;
  }
  const o = root as Obj;
  const from = dateOf(Object.entries(o).find(([k]) => FROM_KEY.test(k))?.[1], now);
  const to = dateOf(Object.entries(o).find(([k]) => TO_KEY.test(k))?.[1], now);
  // An ad runs days or weeks, not months.
  if (from && to && from <= to && daysBetween(from, to) <= 45) found.push({ from, to });
  for (const v of Object.values(o)) if (typeof v === 'object' && v !== null) adDays(v, now, found, depth + 1);
  return found;
}

/** The range most of the items give: an ad's items usually share its dates. */
function commonRange(items: AdItem[]): { from?: string; to?: string } {
  const counts = new Map<string, number>();
  for (const i of items) if (i.from || i.to) counts.set(`${i.from ?? ''}|${i.to ?? ''}`, (counts.get(`${i.from ?? ''}|${i.to ?? ''}`) ?? 0) + 1);
  const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  if (!best) return {};
  const [from, to] = best[0].split('|');
  return { ...(from ? { from } : {}), ...(to ? { to } : {}) };
}

export function parseJson(t: string): unknown {
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}

/** Every item once: by id, name and deal. */
function unique(items: AdItem[]): AdItem[] {
  const seen = new Set<string>();
  return items.filter((i) => {
    const key = `${i.id}|${i.name.toLowerCase()}|${i.deal}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// --- Cards drawn on the page ------------------------------------------------------------------------------------

/** Lines on a card that are its buttons or links, not its name. */
export const BUTTON_LINE = /^(?:add(?: to (?:list|cart))?|clip(?:ped)?(?: coupon)?|unclip|details|view(?: details| deal| item)?|shop(?: now)?|see (?:more|details|items)|learn more|sign in.*|select|more info|save|saved|\+|-)$/i;

function itemFromCard(card: PageCard, now: number): AdItem | null {
  const lines = card.lines.map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 12);
  const dealLine = lines.find((l) => l.length <= 60 && parseDeal(l));
  if (!dealLine) return null;
  const deal = parseDeal(dealLine)!;
  const name = lines
    .filter((l) => l !== dealLine && l.length >= 4 && l.length <= 160 && /[a-z]{3}/i.test(l) && !BUTTON_LINE.test(l) && !parseDeal(l) && !rangeIn(l, now).to)
    .sort((a, b) => b.length - a.length)[0];
  if (!name) return null;
  const range = lines.map((l) => rangeIn(l, now)).find((r) => r.to) ?? {};
  return {
    id: card.id ?? `card:${name}|${deal.words}`,
    name,
    ...(deal.price !== undefined ? { price: deal.price } : {}),
    deal: deal.words,
    ...(deal.perLb ? { perLb: true } : {}),
    ...(deal.member || lines.some((l) => MEMBER_WORDS.test(l)) ? { member: true } : {}),
    ...(card.img && /^https?:\/\//.test(card.img) ? { imageUrl: card.img } : {}),
    ...range,
  };
}

// --- The ad ------------------------------------------------------------------------------------------------------

interface Found {
  items: AdItem[];
  label: string;
}

const dated = (items: AdItem[]) => items.filter((i) => i.from || i.to).length;

/**
 * A store's weekly ad, from what its page posted: the largest list of sale items in its data (the products the
 * general product reader finds there instead, when those are clearly more), else its cards; its days from most of its
 * items, else from the ad in its data (the one running now first), else from its words.
 */
export function parseAd(payload: ListPagePayload, now: number): WeeklyAd {
  const sources: PageSource[] = [...(payload.sources ?? [])];
  if (payload.nextDataText) sources.push({ label: 'next-data', text: payload.nextDataText });

  const found: Found[] = [];
  const days: { from: string; to: string }[] = [];
  for (const source of sources) {
    const root = parseJson(source.text);
    if (!root) continue;
    adDays(root, now, days);
    for (const objs of listsIn(root)) {
      const items = unique(objs.map((o) => itemFrom(o, now)).filter((i): i is AdItem => !!i));
      if (items.length >= MIN_ITEMS) found.push({ items, label: source.label });
    }
  }
  let best = found.reduce<Found | undefined>(
    (a, c) => (!a || c.items.length > a.items.length || (c.items.length === a.items.length && dated(c.items) > dated(a.items)) ? c : a),
    undefined,
  );
  // A deals page's products, as the general product reader finds them (prices and "was" prices, no dates): only when
  // clearly more, since the ad's own list has its deals' words and dates.
  const read = autoDetect(payload, { retailer: '', storeId: '' });
  if (read.payloadFound) {
    const items = unique(
      read.products
        .filter((p) => typeof p.price === 'number' && p.price > 0 && !p.sponsored)
        .map((p): AdItem => ({
          id: p.id,
          name: p.name,
          price: p.price!,
          deal: cash(p.price!),
          ...(p.wasPrice !== undefined ? { wasPrice: p.wasPrice } : {}),
          ...(p.memberPrice !== undefined ? { member: true } : {}),
          ...(p.imageUrl ? { imageUrl: p.imageUrl } : {}),
        })),
    );
    if (items.length >= MIN_ITEMS && (!best || items.length > best.items.length * 1.5)) best = { items, label: read.source ?? 'products' };
  }
  if (!best && payload.cards?.length) {
    const items = unique(payload.cards.map((c) => itemFromCard(c, now)).filter((i): i is AdItem => !!i));
    if (items.length >= MIN_ITEMS) best = { items, label: 'cards on the page' };
  }

  const items = (best?.items ?? []).slice(0, MAX_ITEMS);
  const today = dayOf(now);
  const fromItems = commonRange(items);
  const running = days.find((d) => d.from <= today && today <= d.to) ?? days[0];
  const range = fromItems.from || fromItems.to ? fromItems : (running ?? rangeIn(payload.text, now));
  const where = best?.label.replace(/^response /, '').replace(/^https?:\/\//, '').replace(/\?.*$/, '').replace(/\s*\(\d+\)$/, '').slice(0, 120);
  return {
    items,
    ...(range.from ? { from: range.from } : {}),
    ...(range.to ? { to: range.to } : {}),
    ...(where ? { source: `${where} (${items.length})` } : {}),
  };
}
