import { GROCERY_TERMS } from '../lists/groceryTerms';
import type { GroceryList } from '../lists/types';
import { cash, dayOf, type AdItem, type WeeklyAd } from '../onDevice/adPage';
import { reasonWords } from '../onDevice/scrapeFeed';
import type { RetailerConfig } from '../onDevice/types';
import type { Basket, BasketLine } from './basket';
import { nameWords } from './exact';
import { allWords, isMatch, sameWord } from './matching';
import type { StoreChoice } from './pricingEngine';
import type { PageRead } from './readBook';
import { whenLabel } from './receipt';

// Pure functions only, so the tests run them in Node.
//
// This week's ads, matched to lists. An ad item is a list item when it names the item, by the rules search results are
// matched with, and isn't something else made of it (see isThing: "Oscar Mayer Classic Wieners" are hot dogs, "Milk
// Chocolate" isn't milk, "Peanut Butter" isn't butter). On a basket line, an ad item that names the line's own product
// comes first. Ads don't change
// totals: the prices the phone reads from the store's site are what it charges there; the ad says what's on sale, and
// when an ad's price is lower than the site's, that's said beside it.

/** A store's ad is read at most once a day; while the one read still runs, not until it ends, and a week at most. */
export const AD_READ_EVERY_MS = 24 * 60 * 60_000;
export const AD_KEEP_MAX_MS = 7 * 24 * 60 * 60_000;
/** A read that never went out (the store's hour was full, or it was busy) is tried again after this long. */
export const NOT_SENT_RETRY_MS = 60 * 60_000;
/** Reasons a read never reached the store's site. */
export const NOT_SENT = new Set(['polite_limit', 'busy']);

/** Where a store's ad is and whose it is (the store the retailer is set to), or what reading it still needs. */
export type AdTarget = { url: string; key: string } | { needs: 'store' | 'zip' };

/**
 * The page of a store's weekly ad, for the store it's set to (its `storeUrl` when one is set); null when its rules have
 * no ad.
 */
export function adTarget(cfg: RetailerConfig, choice: Pick<StoreChoice, 'storeId' | 'storeKey'>, zip: string): AdTarget | null {
  const rules = cfg.ad;
  if (!rules) return null;
  const page = rules.storeUrl && choice.storeId ? rules.storeUrl : rules.url;
  if (page.includes('{{storeId}}') && !choice.storeId) return { needs: 'store' };
  if (page.includes('{{zip}}') && !zip) return { needs: 'zip' };
  const url = page.replace(/\{\{storeId\}\}/g, encodeURIComponent(choice.storeId)).replace(/\{\{zip\}\}/g, encodeURIComponent(zip));
  // The store it's for, not the account signed in to it: signing in doesn't change the ad (see storeChoices).
  return { url, key: `${url} ${choice.storeKey.replace(/~\d+$/, '')}` };
}

/**
 * Whether a store's ad should be read (again): never read for this store, or not today. A read that worked stands while
 * the ad it read still runs, up to a week; one that failed is tried again tomorrow, or today when the user asks. One
 * that never went out is tried again after an hour.
 */
export function adDue(read: PageRead<WeeklyAd> | undefined, key: string, now: number, asked = false): boolean {
  if (!read || read.key !== key) return true;
  const age = now - read.at;
  if (read.reason && NOT_SENT.has(read.reason)) return age >= NOT_SENT_RETRY_MS;
  if (age < AD_READ_EVERY_MS) return !read.ok && asked;
  if (!read.ok) return true;
  const to = read.value?.to;
  return !to || to < dayOf(now) || age >= AD_KEEP_MAX_MS;
}

/** Whether an ad item runs on `today` ('YYYY-MM-DD'): by its own days, else the ad's. */
export function runsOn(item: AdItem, ad: WeeklyAd, today: string): boolean {
  const from = item.from ?? ad.from;
  const to = item.to ?? ad.to;
  return (!from || from <= today) && (!to || to >= today);
}

/**
 * Single-word kinds of groceries ("chocolate", "cheese"), and two-word ones ("peanut butter"), as matching compares
 * words. A hyphenated term ("coca-cola") is two words, and neither is a kind of its own.
 */
const KINDS = [...new Set(GROCERY_TERMS.map((t) => allWords(t)).filter((w) => w.length === 1).map((w) => w[0]))];
const PAIRS = new Set(GROCERY_TERMS.map((t) => allWords(t)).filter((w) => w.length === 2).map((w) => w.join(' ')));
const isKind = (w: string) => KINDS.some((k) => sameWord(k, w));

/**
 * Whether a name is the thing a phrase says, not something made of it: it names the phrase (see isMatch), no other
 * kind of grocery follows the phrase's last word in it ("Milk Chocolate" isn't milk, "Strawberry Jam" isn't
 * strawberries), and no kind of grocery just before it makes a thing of its own with it ("Peanut Butter" isn't butter,
 * while "Whole Milk" and "Tomato Ketchup" are what they say).
 */
export function isThing(name: string, phrase: string): boolean {
  if (!isMatch(name, phrase)) return false;
  const want = allWords(phrase);
  const have = allWords(name);
  if (!want.length) return true;
  const mine = (w: string) => want.some((x) => sameWord(x, w));
  const head = have.reduce((at, w, i) => (sameWord(w, want[want.length - 1]) ? i : at), -1);
  if (head !== -1) {
    const next = have[head + 1];
    if (have.slice(head + 1).some((w) => isKind(w) && !mine(w))) return false;
    if (next && !mine(next) && PAIRS.has(`${have[head]} ${next}`)) return false;
  }
  const start = have.findIndex((w) => sameWord(w, want[0]));
  const before = start > 0 ? have[start - 1] : undefined;
  return !(before && !mine(before) && isKind(before) && PAIRS.has(`${before} ${have[start]}`));
}

/** The ad's items that are this list item, running today, in the ad's order. */
export function adItemsFor(itemName: string, ad: WeeklyAd | undefined, today: string): AdItem[] {
  if (!ad) return [];
  return ad.items.filter((a) => runsOn(a, ad, today) && isThing(a.name, itemName));
}

/** Words an ad uses about a product that aren't the product's own. */
const AD_FILLER = new Set(['select', 'selected', 'varieties', 'variety', 'assorted', 'all', 'types', 'kinds', 'flavors', 'flavours', 'sizes', 'pack', 'packs', 'bag', 'bags', 'box', 'boxes', 'bottle', 'bottles', 'jar', 'jars', 'container', 'containers', 'ea', 'each', 'fresh', 'plus', 'deposit', 'crv', 'or', 'more']);

/**
 * Whether an ad item names this product: nearly all its words (brand and kind) are in the product's name. Ads name
 * products loosely ("Kellogg's Cereal, select varieties"), so sizes and ads' own words don't count.
 */
export function sameAsAd(productName: string, adName: string): boolean {
  const ad = nameWords(adName).filter((w) => !AD_FILLER.has(w));
  if (ad.length < 2) return false;
  const have = new Set(nameWords(productName));
  const shared = ad.filter((w) => have.has(w) || have.has(w.replace(/s$/, '')) || have.has(`${w}s`)).length;
  return shared / ad.length >= 0.8;
}

/** A basket line in the store's weekly ad. */
export interface AdHit {
  item: AdItem;
  /** The ad's item names the line's own product, not only the same kind of thing. */
  same: boolean;
  /** The ad's price is below the one the phone read for the line's product: in store only, or with a card, perhaps. */
  lower?: boolean;
}

/** The ad item for a basket line: one that names its product first, else the first that is the item. Null: none. */
export function adFor(line: BasketLine, ad: WeeklyAd | undefined, today: string): AdHit | null {
  const product = line.status === 'found' ? line.product : null;
  if (!product) return null;
  const items = adItemsFor(line.item.name, ad, today);
  if (!items.length) return null;
  const same = items.find((i) => sameAsAd(product.name, i.name));
  const item = same ?? items[0];
  const lower = !!same && item.price !== undefined && !item.perLb && typeof product.price === 'number' && item.price < product.price - 0.005;
  return { item, same: !!same, ...(lower ? { lower: true } : {}) };
}

/** Each of a basket's lines in the store's weekly ad, by item id. */
export function adHits(basket: Basket, ad: WeeklyAd | undefined, today: string): Record<string, AdHit> {
  const out: Record<string, AdHit> = {};
  if (!ad) return out;
  for (const line of basket.lines) {
    const hit = adFor(line, ad, today);
    if (hit) out[line.item.id] = hit;
  }
  return out;
}

/** A list's item in a store's weekly ad, for deals. */
export interface AdDeal {
  retailerId: string;
  /** The item as written on the list. */
  itemName: string;
  item: AdItem;
  /** When it runs, the item's own days or else the ad's. */
  from?: string;
  to?: string;
}

/** The lists' items, each once (as first written), in the lists' order. */
export function itemNames(lists: GroceryList[]): string[] {
  const names = new Map<string, string>();
  for (const i of lists.flatMap((l) => l.items)) if (!names.has(i.name.trim().toLowerCase())) names.set(i.name.trim().toLowerCase(), i.name.trim());
  return [...names.values()];
}

/** The lists' items in the stores' weekly ads, each item once per store (its first ad item), in the lists' order. */
export function adDeals(lists: GroceryList[], ads: Record<string, WeeklyAd | undefined>, today: string): AdDeal[] {
  const names = itemNames(lists);
  const out: AdDeal[] = [];
  for (const [retailerId, ad] of Object.entries(ads)) {
    if (!ad) continue;
    for (const itemName of names) {
      const item = adItemsFor(itemName, ad, today)[0];
      if (!item) continue;
      const from = item.from ?? ad.from;
      const to = item.to ?? ad.to;
      out.push({ retailerId, itemName, item, ...(from ? { from } : {}), ...(to ? { to } : {}) });
    }
  }
  return out;
}

// --- Words -------------------------------------------------------------------------------------------------------

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** 'YYYY-MM-DD' as "Sep 30". */
export function dayWords(day: string): string {
  const [, m, d] = day.split('-').map(Number);
  return m >= 1 && m <= 12 ? `${MONTH_NAMES[m - 1]} ${d}` : day;
}

/** When something runs, in a few words: "Sep 24–30", "Sep 28–Oct 4", "through Sep 30", "from Oct 1". Empty: unknown. */
export function runsWords(from: string | undefined, to: string | undefined): string {
  if (from && to) {
    if (from === to) return dayWords(from);
    return from.slice(0, 7) === to.slice(0, 7) ? `${dayWords(from)}–${Number(to.slice(8))}` : `${dayWords(from)}–${dayWords(to)}`;
  }
  if (to) return `through ${dayWords(to)}`;
  if (from) return `from ${dayWords(from)}`;
  return '';
}

/** An ad item's deal, in a few words: "2 for $5 ($2.50 each)", "$1.99/lb", "Buy 1, get 1 free", "$3.99 for members". */
export function adPriceWords(item: AdItem): string {
  const each = item.price !== undefined && / for \$/.test(item.deal) ? ` (${cash(item.price)} each)` : '';
  const members = item.memberPrice !== undefined ? `, ${cash(item.memberPrice)} for members` : '';
  return `${item.deal}${each}${item.member && item.memberPrice === undefined ? ' for members' : ''}${members}`;
}

/** What a basket line's ad says, in a sentence: "In this week's ad: 2 for $5 ($2.50 each), through Sep 30." */
export function adLineWords(hit: AdHit, ad: WeeklyAd | undefined, productPrice?: number): string {
  const to = hit.item.to ?? ad?.to;
  const what = hit.same ? '' : `${hit.item.name}, `;
  const lower = hit.lower && productPrice !== undefined ? ` The site shows ${cash(productPrice)}: the ad’s price may be in store only.` : '';
  return `In this week’s ad: ${what}${adPriceWords(hit.item)}${to ? `, through ${dayWords(to)}` : ''}.${lower}`;
}

/** "just now", "2 h ago", "yesterday", "on Sep 22". */
export function whenWords(at: number, now: number): string {
  const when = whenLabel(at, now);
  return /ago$|^just now$|^yesterday$/.test(when) ? when : `on ${when}`;
}

/**
 * Where a store's weekly ad stands, in a sentence, for Weekly ads and coupons: when it was read and what it gave, or why
 * it couldn't be, and when it's read next.
 */
export function adStatusWords(
  cfg: RetailerConfig,
  target: AdTarget | null,
  read: PageRead<WeeklyAd> | undefined,
  reading: boolean,
  now: number,
): string {
  if (!cfg.ad) return `${cfg.name} has no weekly ad in the store rules.`;
  if (!target) return '';
  if ('needs' in target) return target.needs === 'store' ? `Its ad is for a store: set ${cfg.name}’s store near you first.` : 'Its ad needs your ZIP code: set it in Your stores.';
  if (reading) return `Reading ${cfg.name}’s weekly ad now…`;
  const mine = read?.key === target.key ? read : undefined;
  if (!mine) return `Not read yet. It’s read on this phone, hidden, at most once a day.`;
  const ad = mine.value;
  const got = ad && mine.valueAt !== undefined ? `${ad.items.length} sale ${ad.items.length === 1 ? 'item' : 'items'}${ad.from || ad.to ? `, ${runsWords(ad.from, ad.to).replace(/^(?=[A-Z])/, 'running ')}` : ''}` : '';
  if (mine.ok) return `Read ${whenWords(mine.at, now)}: ${got}. Next read ${ad?.to && ad.to >= dayOf(now) ? `when this ad ends, or in a week` : 'tomorrow'}.`;
  if (mine.reason && NOT_SENT.has(mine.reason)) return `Waiting: ${reasonWords(mine.reason)}.${got ? ` From before: ${got}.` : ''}`;
  return `Couldn’t read it ${whenWords(mine.at, now)}: ${reasonWords(mine.reason)}.${got ? ` Showing the ad read ${whenWords(mine.valueAt!, now)}: ${got}.` : ''}`;
}
