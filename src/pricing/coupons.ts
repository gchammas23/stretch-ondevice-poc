import type { GroceryList } from '../lists/types';
import { sameBarcode } from '../onDevice/barcode';
import type { Coupon, CouponList } from '../onDevice/couponPage';
import { reasonWords } from '../onDevice/scrapeFeed';
import type { RetailerConfig } from '../onDevice/types';
import { isThing, itemNames, NOT_SENT, NOT_SENT_RETRY_MS, whenWords } from './ads';
import type { Basket, BasketLine, TripCosts } from './basket';
import { allWords, sameWord } from './matching';
import type { PageRead } from './readBook';

// Pure functions only, so the tests run them in Node.
//
// The digital coupons of the user's account at a store, matched to basket lines. A coupon fits a product when the
// product names the coupon's brand (when it has one) and is one of the things it's for, by the rules list items are
// matched with. Each coupon comes off once, on the line it saves most. Totals only count coupons when the user chooses
// to, and then only the clipped ones: a coupon not clipped doesn't come off at checkout.

/** An account's coupons are read at most every six hours on their own; whenever the user asks, or signs in again. */
export const COUPONS_READ_EVERY_MS = 6 * 60 * 60_000;

/** Where an account's coupons are, and whose (the sign-in they're read under), or what reading them still needs. */
export type CouponTarget = { url: string; key: string } | { needs: 'signin' };

/** The page of a store's coupons, for the sign-in made in the app; null when its rules have no coupons. */
export function couponTarget(cfg: RetailerConfig, signedInAt: number | undefined): CouponTarget | null {
  if (!cfg.coupons) return null;
  if (!signedInAt) return { needs: 'signin' };
  return { url: cfg.coupons.url, key: `${cfg.coupons.url} ~${signedInAt}` };
}

/**
 * Whether an account's coupons should be read (again): never read under this sign-in, the user asks, or six hours
 * have passed. Signed out on the site, they wait for the user to sign in again (a new sign-in is a new key).
 */
export function couponsDue(read: PageRead<CouponList> | undefined, key: string, now: number, asked = false): boolean {
  if (!read || read.key !== key || asked) return true;
  const age = now - read.at;
  if (read.reason && NOT_SENT.has(read.reason)) return age >= NOT_SENT_RETRY_MS;
  if (read.reason === 'signed_out') return false;
  return age >= COUPONS_READ_EVERY_MS;
}

// --- Which coupon fits which product ----------------------------------------------------------------------------

/** Words in a coupon's text about its worth or its terms, not what it's for. */
const TERMS =
  /\$\s?\d+(?:\.\d{1,2})?|\d+\s*¢|\d+\s*%|\(\d+\)|\b\d+(?:\.\d+)?\s*-?\s*(?:oz|ounces?|lbs?|pounds?|ct|count|pk|packs?|fl|g|kg|ml|l|liters?)\b|\b\d+\b|\b(?:save|off|on|any|one|two|three|four|five|when|you|buy|get|free|purchase|of|the|a|an|per|only|digital|coupons?|offers?|each|with|your|card|select(?:ed)?|varieties|variety|sizes?|larger|smaller|or more|new|all|items?|products?|brand|at|in|for|to)\b/gi;

/**
 * What a coupon is for, as phrases a product could say: "Oscar Mayer Wieners or Bacon" is "oscar mayer wieners" and
 * "oscar mayer bacon" (a one-word choice takes the first one's other words). Its terms ("Limit 1", "Excludes trial
 * sizes") and worth are left out. "And" doesn't separate choices: "Mac and Cheese" is one thing.
 */
export function couponTargets(c: Pick<Coupon, 'title'>): string[] {
  const body = c.title.replace(/[®™]/g, '').replace(/\b(?:excludes?|excluding|not valid|limit|valid|expires?|exp\.)\b.*$/i, '');
  const phrases = body
    .split(/\bor\b|,|\/|;/i)
    .map((p) => allWords(p.replace(TERMS, ' ')).join(' '))
    .filter((p) => p.length >= 3);
  const first = phrases[0]?.split(' ') ?? [];
  // "or Bacon": the first choice's other words (the brand, often) go with it.
  return phrases.map((p, i) => (i > 0 && !p.includes(' ') && first.length > 1 ? `${first.slice(0, -1).join(' ')} ${p}` : p));
}

/** Whether a product's name says a brand's words: "Kellogg’s Frosted Flakes" says "Kellogg's". */
export function namesBrand(name: string, brand: string): boolean {
  const want = allWords(brand.replace(/[®™]/g, ''));
  if (!want.length) return true;
  const have = allWords(name);
  return want.every((w) => have.some((h) => sameWord(h, w)));
}

/**
 * Whether a coupon fits a product. With a brand: the product says the brand, and at least half the words of one of the
 * things the coupon is for ("Froot Loops" for "Froot Loops Cereal"); a brand's coupon that says nothing more fits any
 * of its products. Without one: the product is one of those things, and not something made of it (see isThing:
 * "Strawberry Jam" isn't strawberries).
 */
export function couponFits(productName: string, c: Pick<Coupon, 'title' | 'brand' | 'upcs'>, gtin?: string): boolean {
  // The barcodes it lists, where both sides have them, settle it.
  if (c.upcs?.length && gtin) return c.upcs.some((u) => sameBarcode(u, gtin));
  if (c.brand && !namesBrand(productName, c.brand)) return false;
  const brand = c.brand ? allWords(c.brand) : [];
  const targets = couponTargets(c)
    .map((t) => t.split(' ').filter((w) => !brand.some((b) => sameWord(b, w))).join(' '))
    .filter((t) => t.length >= 3);
  if (!targets.length) return !!c.brand;
  const have = allWords(productName);
  const said = (w: string) => have.some((h) => sameWord(h, w));
  if (c.brand) {
    return targets.some((t) => {
      const words = t.split(' ');
      return words.filter(said).length >= Math.ceil(words.length / 2);
    });
  }
  return targets.some((t) => isThing(productName, t));
}

/** How many of a product a coupon wants bought: two for "Save $1 on 2", three for "Buy 2, get one free". */
export const neededFor = (c: Pick<Coupon, 'qty' | 'free'>): number => (c.free && c.qty ? c.qty + 1 : Math.max(1, c.qty ?? 1));

const round = (n: number): number => Math.round(n * 100) / 100;

/** What a coupon takes off, once, bought `qty` at `unitPrice`: nothing when that isn't enough of it. */
export function couponSaves(c: Coupon, unitPrice: number, qty: number): number {
  const need = neededFor(c);
  if (qty < need || !(unitPrice > 0)) return 0;
  const cost = unitPrice * Math.max(1, c.qty ?? 1);
  if (c.off !== undefined) return round(Math.min(c.off, cost));
  if (c.pct !== undefined) return round((cost * c.pct) / 100);
  if (c.price !== undefined) return round(Math.max(0, cost - c.price));
  if (c.free) return round(unitPrice);
  return 0;
}

/** A basket line's coupon. */
export interface CouponHit {
  coupon: Coupon;
  /** What it takes off this line, once. 0 when the line has too few (see `needs`). */
  saves: number;
  /** What it would take off with enough of it. */
  could: number;
  /** Buy this many for it, when the line has fewer. */
  needs?: number;
  /** It comes off at checkout: clipped, and the line has enough. */
  counts: boolean;
}

/** Lines with a product and a price, which a coupon can come off. */
const pricedLine = (l: BasketLine): l is BasketLine & { product: NonNullable<BasketLine['product']> } =>
  l.status === 'found' && !!l.product && typeof l.product.price === 'number' && l.product.price > 0;

/**
 * The best coupon for each of a basket's lines, each coupon on one line only: those that come off first, then the
 * most they'd take off, clipped before not. Expired coupons are left out.
 */
export function couponHits(basket: Basket, coupons: Coupon[] | undefined, today: string): Record<string, CouponHit> {
  const out: Record<string, CouponHit> = {};
  if (!coupons?.length) return out;
  const live = coupons.filter((c) => !c.expires || c.expires >= today);
  const pairs: { itemId: string; hit: CouponHit }[] = [];
  for (const line of basket.lines.filter(pricedLine)) {
    const price = line.product.price as number;
    for (const coupon of live) {
      if (!couponFits(line.product.name, coupon, line.product.gtin)) continue;
      const need = neededFor(coupon);
      const saves = couponSaves(coupon, price, line.item.qty);
      const could = couponSaves(coupon, price, Math.max(need, line.item.qty));
      if (could <= 0) continue;
      pairs.push({ itemId: line.item.id, hit: { coupon, saves, could, ...(line.item.qty < need ? { needs: need } : {}), counts: coupon.clipped && saves > 0 } });
    }
  }
  pairs.sort((a, b) => Number(b.hit.counts) - Number(a.hit.counts) || b.hit.could - a.hit.could || Number(b.hit.coupon.clipped) - Number(a.hit.coupon.clipped));
  const used = new Set<string>();
  for (const { itemId, hit } of pairs) {
    if (out[itemId] || used.has(hit.coupon.id)) continue;
    out[itemId] = hit;
    used.add(hit.coupon.id);
  }
  return out;
}

/** What a basket's coupons take off. */
export interface CouponCredit {
  /** Clipped coupons that fit and are met: what comes off at checkout, and counts in totals when the user chooses. */
  amount: number;
  count: number;
  /** Coupons that fit but aren't clipped yet: what they'd take off once clipped (with enough of each item). */
  unclipped: { count: number; amount: number };
  /** Clipped coupons that fit, on lines with too few of the item for them ("Buy 2, save $1" on one). */
  short: number;
}

export function couponCredit(basket: Basket, coupons: Coupon[] | undefined, today: string): CouponCredit {
  const hits = Object.values(couponHits(basket, coupons, today));
  const counted = hits.filter((h) => h.counts);
  const waiting = hits.filter((h) => !h.coupon.clipped);
  return {
    amount: round(counted.reduce((sum, h) => sum + h.saves, 0)),
    count: counted.length,
    unclipped: { count: waiting.length, amount: round(waiting.reduce((sum, h) => sum + h.could, 0)) },
    short: hits.filter((h) => h.coupon.clipped && !h.counts).length,
  };
}

/** Each basket's coupons, by retailer, for the stores whose coupons the phone has read. */
export function couponCredits(baskets: Basket[], couponsOf: (retailerId: string) => Coupon[] | undefined, today: string): Record<string, CouponCredit> {
  const out: Record<string, CouponCredit> = {};
  for (const b of baskets) {
    const coupons = couponsOf(b.retailerId);
    if (coupons) out[b.retailerId] = couponCredit(b, coupons, today);
  }
  return out;
}

/** What else each store costs, for ranking (see TripCosts), with its clipped coupons taken off. */
export function withCoupons(extra: TripCosts | undefined, credits: Record<string, CouponCredit> | undefined): TripCosts | undefined {
  const off = Object.entries(credits ?? {}).filter(([, c]) => c.amount > 0);
  if (!off.length) return extra;
  const out: TripCosts = { ...extra };
  for (const [id, c] of off) out[id] = round((out[id] ?? 0) - c.amount);
  return out;
}

/** The lists' items that one of a store's coupons is for, by item name: for deals, where there are no products yet. */
export function couponsForItems(lists: GroceryList[], coupons: Coupon[] | undefined, today: string): { itemName: string; coupon: Coupon }[] {
  if (!coupons?.length) return [];
  const names = itemNames(lists);
  const live = coupons.filter((c) => !c.expires || c.expires >= today);
  const out: { itemName: string; coupon: Coupon }[] = [];
  for (const itemName of names) {
    const coupon = live.find((c) => couponTargets(c).some((t) => isThing(t, itemName)));
    if (coupon) out.push({ itemName, coupon });
  }
  return out;
}

// --- Words -------------------------------------------------------------------------------------------------------

/** How many of the account's coupons fit a basket: coming off, waiting for more of an item, or to clip. */
export const couponsFitting = (c: CouponCredit | undefined): number => (c ? c.count + c.short + c.unclipped.count : 0);

/**
 * A basket's coupons in a sentence: "3 of your coupons fit this basket: 1 comes off at checkout, $1.00; 1 more once
 * you buy enough; 1 to clip, $0.75 more."
 */
export function couponsWords(c: CouponCredit): string {
  const n = couponsFitting(c);
  const parts = [
    c.count ? `${c.count} ${c.count === 1 ? 'comes' : 'come'} off at checkout, ${cash2(c.amount)}` : 'none comes off yet',
    c.short ? `${c.short} more once you buy enough` : '',
    c.unclipped.count ? `${c.unclipped.count} to clip, ${cash2(c.unclipped.amount)} more` : '',
  ].filter(Boolean);
  return `${n} of your coupons ${n === 1 ? 'fits' : 'fit'} this basket: ${parts.join('; ')}.`;
}

const cash2 = (n: number): string => `$${n.toFixed(2)}`;

/** A line's coupon, as its chip says it: "Coupon: $1 off". */
export const couponChip = (c: Coupon): string => `Coupon: ${c.value}`;

/** A line's coupon's state, in a few words: "clipped", "not clipped", "clipped · buy 2 for it". */
export function couponStateWords(hit: CouponHit): string {
  const state = hit.coupon.clipped ? (hit.coupon.clippedAt ? 'clipped here' : 'clipped') : 'not clipped';
  return hit.needs ? `${state} · buy ${hit.needs} for it` : state;
}

/**
 * Where an account's coupons stand, in a sentence, for Weekly ads and coupons: when they were read and how many are
 * clipped, or why they couldn't be, or that signing in comes first.
 */
export function couponStatusWords(
  cfg: RetailerConfig,
  target: CouponTarget | null,
  read: PageRead<CouponList> | undefined,
  reading: boolean,
  now: number,
): string {
  if (!cfg.coupons) return `${cfg.name} has no digital coupons in the store rules.`;
  if (!target) return '';
  if ('needs' in target) return `Sign in on ${cfg.name}’s own page, and the phone reads your ${cfg.coupons.program}: which there are, and which you’ve clipped.`;
  if (reading) return `Reading your ${cfg.coupons.program} now…`;
  const mine = read?.key === target.key ? read : undefined;
  if (!mine) return 'Not read yet.';
  const list = mine.value;
  const clipped = list?.coupons.filter((c) => c.clipped).length ?? 0;
  const got = list ? `${list.coupons.length} ${list.coupons.length === 1 ? 'coupon' : 'coupons'}, ${clipped} clipped` : '';
  if (mine.ok && list?.signedOut) return `Read ${whenWords(mine.at, now)}, signed out: ${list.coupons.length} coupons for everyone. Sign in again to see which you’ve clipped.`;
  if (mine.ok) return `Read ${whenWords(mine.at, now)}: ${got}.`;
  if (mine.reason === 'signed_out') return `Signed out of ${cfg.name}’s site ${whenWords(mine.at, now)}: sign in again to read your coupons.${got ? ` From before: ${got}.` : ''}`;
  if (mine.reason && NOT_SENT.has(mine.reason)) return `Waiting: ${reasonWords(mine.reason)}.${got ? ` From before: ${got}.` : ''}`;
  return `Couldn’t read them ${whenWords(mine.at, now)}: ${reasonWords(mine.reason)}.${got ? ` From before: ${got}.` : ''}`;
}
