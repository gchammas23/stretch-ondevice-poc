import type { GroceryList, ItemPrefs, ListItem } from '../lists/types';
import { itemKey, queryKey } from '../lists/types';
import type { Product } from '../onDevice/types';
import { sameProduct } from './exact';
import { isMatch } from './matching';
import { parseSize, unitPriceOf } from './sizes';

// Pure functions only, so the tests run them in Node.

/** One search's outcome at one store, as the pricing engine records it. */
export interface ItemResult {
  status: 'queued' | 'searching' | 'done' | 'failed' | 'skipped';
  /** In the retailer's own order. */
  products: Product[];
  /**
   * The products are from an earlier search: shown while a fresh one runs (status queued or searching), or kept
   * because the fresh one failed.
   */
  stale?: boolean;
  reason?: string;
}

export type LineStatus = 'found' | 'missing' | 'pending' | 'failed';

export interface BasketLine {
  item: ListItem;
  status: LineStatus;
  product: Product | null;
  /** The other results for this item at this store, to swap to. */
  alternatives: Product[];
  /** price × quantity. */
  lineTotal: number;
  /** Shown from an earlier search while a fresh one runs. */
  refreshing: boolean;
  /** The price is from an earlier search (refreshing, or the refresh failed). */
  stale: boolean;
  /** The product is the one the user chose for this item at this store before (their usual). */
  usual: boolean;
  /** Missing because none of the store's results named the item, not because it had none. */
  noMatch: boolean;
  /** The item's exact product (see ListItem.exact): 'itself' where it was chosen, else found by 'barcode' or by 'name'. */
  exact?: 'itself' | 'barcode' | 'name';
  /** The item wants an exact product, and this store's results don't have it. */
  exactMissing: boolean;
  /** Preferences no result met, so the closest match is shown: "organic", the brand, the size. */
  prefMiss: string[];
}

/** The product the user chose for each item at each store, remembered across lists: queryKey → retailerId → id. */
export type Usuals = Record<string, Record<string, string>>;

export interface Basket {
  retailerId: string;
  lines: BasketLine[];
  total: number;
  found: number;
  missing: number;
  pending: number;
  failed: number;
  itemCount: number;
  /** Lines shown from an earlier search while fresh ones run. */
  refreshing: number;
  /** Every line has a product, a not-found, or a failure: nothing is still waiting for its first search. */
  complete: boolean;
  /** Lines whose product is on sale, and what the sales take off the regular prices, quantities included. */
  onSale: number;
  saleSavings: number;
  /** The total with every item bought in the same size at every store (see withUnitTotals). */
  unitTotal?: number;
}

/** How stores are ranked: by what the basket costs, or by what it would cost in the same sizes everywhere. */
export type RankBy = 'total' | 'unit';

export interface SplitTrip {
  retailerIds: [string, string];
  /** Where each item is cheapest of the two. */
  assignment: Record<string, string>;
  lines: BasketLine[];
  total: number;
  found: number;
  /** Against the best single store; negative when the split costs more but gets more of the list. */
  savings: number;
  /** Items the split gets that the best single store doesn't. */
  extraItems: number;
  /** When driving counts: getting to both stores, which `savings` already takes off. */
  driving?: number;
  /** Ordering online: what both orders add (fees, online prices), which `savings` already takes off. */
  fees?: number;
}

/** A split must save at least this much to be worth a second stop. */
export const MIN_SPLIT_SAVINGS = 2;
/** Other results a line offers to swap to (Similar items). */
export const MAX_ALTERNATIVES = 8;

/** A real price: a missing or broken one must never count as free. */
const priced = (p: Product): boolean => typeof p.price === 'number' && Number.isFinite(p.price) && p.price >= 0;

/**
 * The retailer's top result that's worth buying: skips sponsored, out-of-stock and unpriced products, and, given the
 * item's name, anything that isn't it (see matching.ts).
 */
export function defaultPick(products: Product[], query?: string): number {
  return products.findIndex((p) => priced(p) && !p.sponsored && p.inStock !== false && (!query || isMatch(p.name, query)));
}

/** A sale price below the regular one. */
export const onSale = (p: Product | null): boolean => !!p && priced(p) && typeof p.wasPrice === 'number' && p.wasPrice > p.price!;

const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** The item's preferences this product doesn't meet, in words: "organic", "Horizon", "1 gal". */
export function unmetPrefs(p: Product, prefs: ItemPrefs | undefined): string[] {
  if (!prefs) return [];
  const out: string[] = [];
  const name = ` ${words(p.name)} `;
  if (prefs.organic && !name.includes(' organic ')) out.push('organic');
  const brand = prefs.brand?.trim();
  if (brand && !name.includes(` ${words(brand)} `)) out.push(brand);
  const want = prefs.size?.trim() ? parseSize(prefs.size) : null;
  if (want) {
    const have = parseSize(p.name);
    const same = have && (have.unit === 'ct') === (want.unit === 'ct') && Math.abs(have.amount - want.amount) <= want.amount * 0.05;
    if (!same) out.push(prefs.size!.trim());
  }
  return out;
}

const worthBuying = (p: Product) => priced(p) && !p.sponsored && p.inStock !== false;

/**
 * One item at one store. In order: the item's exact product, if it has one (found in the name search or the barcode
 * search); else the user's usual there, if the results still have it; else the top result that is the item and
 * meets its preferences, or failing those, the top result that is the item.
 */
export function lineFor(
  item: ListItem,
  retailerId: string,
  result: ItemResult | undefined,
  usualId?: string,
  barcode?: ItemResult,
): BasketLine {
  const empty = { product: null, alternatives: [], lineTotal: 0, refreshing: false, stale: false, usual: false, noMatch: false, exactMissing: false, prefMiss: [] };
  const searching = !result || result.status === 'queued' || result.status === 'searching';
  // Still searching, with nothing from an earlier search to show meanwhile.
  if (!result || (searching && !result.products.length)) return { item, status: 'pending', ...empty };
  if (result.status === 'failed' || result.status === 'skipped') return { item, status: 'failed', ...empty };

  const { products } = result;
  const flags = { refreshing: searching, stale: !!result.stale, usual: false, noMatch: false, exactMissing: false, prefMiss: [] as string[] };
  const found = (product: Product, extra: Partial<BasketLine> = {}): BasketLine => ({
    item,
    status: 'found',
    product,
    alternatives: products.filter((p) => p.id !== product.id && priced(p)).slice(0, MAX_ALTERNATIVES),
    lineTotal: (product.price ?? 0) * item.qty,
    ...flags,
    ...extra,
  });
  const missing = (extra: Partial<BasketLine>): BasketLine => {
    const alternatives = products.filter(priced).slice(0, MAX_ALTERNATIVES);
    return { item, status: 'missing', product: null, alternatives, lineTotal: 0, ...flags, ...extra };
  };

  const exact = item.exact;
  if (exact) {
    const candidates = [...products, ...(barcode?.products ?? [])].filter(priced);
    if (exact.retailerId === retailerId) {
      const itself = candidates.find((p) => p.id === exact.productId);
      if (itself) return found(itself, { exact: 'itself' });
    }
    for (const p of candidates) {
      const how = sameProduct(exact, p);
      if (how) return found(p, { exact: how });
    }
    const barcodePending = !!barcode && (barcode.status === 'queued' || barcode.status === 'searching');
    return missing({ exactMissing: true, refreshing: searching || barcodePending });
  }

  const usual = usualId ? products.find((p) => p.id === usualId && priced(p)) : undefined;
  if (usual) return found(usual, { usual: true });

  const fits = products.filter((p) => worthBuying(p) && isMatch(p.name, item.name));
  const best = fits.find((p) => unmetPrefs(p, item.prefs).length === 0);
  if (best) return found(best);
  if (fits.length) return found(fits[0], { prefMiss: unmetPrefs(fits[0], item.prefs) });
  return missing({ noMatch: products.some(priced) });
}

/** A store's basket for the list, from that store's results keyed by queryKey, with the user's usuals. */
export function basketFor(
  list: GroceryList,
  retailerId: string,
  results: Record<string, ItemResult> | undefined,
  usuals: Usuals = {},
): Basket {
  const lines = list.items.map((item) =>
    lineFor(
      item,
      retailerId,
      results?.[itemKey(item)],
      usuals[queryKey(item.name)]?.[retailerId],
      item.exact?.gtin ? results?.[queryKey(item.exact.gtin)] : undefined,
    ),
  );
  const count = (s: LineStatus) => lines.filter((l) => l.status === s).length;
  const pending = count('pending');
  const sales = lines.filter((l) => l.status === 'found' && onSale(l.product));
  return {
    retailerId,
    lines,
    total: round(lines.reduce((sum, l) => sum + l.lineTotal, 0)),
    found: count('found'),
    missing: count('missing'),
    pending,
    failed: count('failed'),
    itemCount: lines.length,
    refreshing: lines.filter((l) => l.refreshing).length,
    complete: pending === 0,
    onSale: sales.length,
    saleSavings: round(sales.reduce((sum, l) => sum + (l.product!.wasPrice! - l.product!.price!) * l.item.qty, 0)),
  };
}

/**
 * Each basket's total as if every item came in the same size at every store: per item, the smallest pack among the
 * stores whose packs can be compared (weight and volume together, or counts), at each store's price per unit.
 * Items whose size or unit price isn't known count at their actual price.
 */
export function withUnitTotals(baskets: Basket[]): Basket[] {
  const extra = new Map<Basket, number>();
  const count = baskets[0]?.lines.length ?? 0;
  for (let i = 0; i < count; i++) {
    const rows = baskets.map((b) => {
      const line = b.lines[i];
      const product = line?.status === 'found' ? line.product : null;
      const unit = product ? unitPriceOf(product) : null;
      const size = product ? parseSize(product.name) : null;
      const family = unit ? (unit.unit === 'ct' ? 'ct' : 'oz') : null;
      return { b, line, unit, size, family };
    });
    const families = rows.map((r) => r.family).filter((f): f is 'ct' | 'oz' => !!f);
    const family = families.filter((f) => f === 'oz').length >= families.filter((f) => f === 'ct').length ? 'oz' : 'ct';
    const sizes = rows.filter((r) => r.family === family && r.size && (r.size.unit === 'ct') === (family === 'ct')).map((r) => r.size!.amount);
    const ref = sizes.length ? Math.min(...sizes) : 0;
    for (const r of rows) {
      if (!r.line || r.line.status !== 'found') continue;
      const cost = r.unit && r.family === family && ref > 0 ? r.unit.value * ref * r.line.item.qty : r.line.lineTotal;
      extra.set(r.b, (extra.get(r.b) ?? 0) + cost);
    }
  }
  return baskets.map((b) => ({ ...b, unitTotal: round(extra.get(b) ?? 0) }));
}

/**
 * What else a trip to each store costs, by retailer: driving there and back, and what ordering online adds (see
 * onlineCost.ts). Stores not in it cost nothing more.
 */
export type TripCosts = Record<string, number>;

/** What ordering `subtotal` worth at a store adds, when that depends on the order's size (online fees do). */
export type OrderCost = (retailerId: string, subtotal: number) => number;

const totalOf = (b: Basket, by: RankBy, extra: TripCosts = {}) => (by === 'unit' ? (b.unitTotal ?? b.total) : b.total) + (extra[b.retailerId] ?? 0);

/**
 * Driving to each store and back at `perMile` dollars, by retailer, from its distance from the ZIP code. Stores
 * whose distance isn't known are left out.
 */
export function driveCosts(miles: Record<string, number | undefined>, perMile: number): TripCosts {
  const out: TripCosts = {};
  for (const [id, m] of Object.entries(miles)) if (typeof m === 'number' && Number.isFinite(m) && m >= 0) out[id] = round(2 * m * perMile);
  return out;
}

/** Most of the list first, then the lowest total (or, by unit, the lowest total in the same sizes), trips included. */
export function rankBaskets(baskets: Basket[], by: RankBy = 'total', extra: TripCosts = {}): Basket[] {
  return [...baskets].sort((a, b) => b.found - a.found || totalOf(a, by, extra) - totalOf(b, by, extra));
}

/** Stretch's pick: the store that gets the most of the list for the least. Null until a store has found something. */
export function stretchPick(baskets: Basket[], by: RankBy = 'total', extra: TripCosts = {}): Basket | null {
  const best = rankBaskets(baskets.filter((b) => b.found > 0), by, extra)[0];
  return best ?? null;
}

/** Whether a store's lower prices make up for the drive, once driving counts. */
export interface DriveVerdict {
  /** A store cheaper on groceries alone, that the drive makes dearer than the pick. */
  notWorthIt?: { retailerId: string; saves: number; extraDriving: number };
  /** A nearer store the pick beats even after its longer drive. */
  worthIt?: { nearer: string; saves: number; extraDriving: number };
}

/** Two sets of costs added up, by retailer. */
const plus = (a: TripCosts, b: TripCosts): TripCosts => {
  const out = { ...a };
  for (const [id, v] of Object.entries(b)) out[id] = (out[id] ?? 0) + v;
  return out;
};

/**
 * Compares the pick with and without `costs` (driving), among stores that have finished and get as much of the list,
 * and whose cost is known. `base` counts either way: ordering online, what it adds. The same comparison with online
 * costs as `costs` says whether a store's fees cost it the pick.
 */
export function driveVerdict(baskets: Basket[], by: RankBy, costs: TripCosts, base: TripCosts = {}): DriveVerdict | null {
  const done = baskets.filter((b) => b.complete && b.found > 0 && costs[b.retailerId] !== undefined);
  const pick = stretchPick(done, by, plus(base, costs));
  if (!pick) return null;
  const rivals = done.filter((b) => b !== pick && b.found === pick.found);
  const groceries = stretchPick([pick, ...rivals], by, base);
  if (groceries && groceries !== pick) {
    return {
      notWorthIt: {
        retailerId: groceries.retailerId,
        saves: round(totalOf(pick, by, base) - totalOf(groceries, by, base)),
        extraDriving: round(costs[groceries.retailerId] - costs[pick.retailerId]),
      },
    };
  }
  const nearer = rivals.filter((b) => costs[b.retailerId] < costs[pick.retailerId]).sort((a, b) => costs[a.retailerId] - costs[b.retailerId])[0];
  if (!nearer) return {};
  return {
    worthIt: {
      nearer: nearer.retailerId,
      saves: round(totalOf(nearer, by, base) - totalOf(pick, by, base)),
      extraDriving: round(costs[pick.retailerId] - costs[nearer.retailerId]),
    },
  };
}

/**
 * The best two-store split, when it beats the best single store: it gets more of the list, or the same items for
 * at least MIN_SPLIT_SAVINGS less. Only stores that have finished searching are considered. With `extra` (driving),
 * the split pays for trips to both stores; with `orderCost` (ordering online), for two orders, each costed on its
 * own part of the list.
 */
export function bestSplit(baskets: Basket[], extra: TripCosts = {}, orderCost?: OrderCost): SplitTrip | null {
  const done = baskets.filter((b) => b.complete && b.found > 0);
  const ordered = (id: string, subtotal: number) => (orderCost ? orderCost(id, subtotal) : 0);
  const single = stretchPick(done, 'total', orderCost ? plus(extra, Object.fromEntries(done.map((b) => [b.retailerId, ordered(b.retailerId, b.total)]))) : extra);
  if (!single || done.length < 2) return null;
  const singleCost = totalOf(single, 'total', extra) + ordered(single.retailerId, single.total);

  let best: SplitTrip | null = null;
  for (let i = 0; i < done.length; i++) {
    for (let j = i + 1; j < done.length; j++) {
      const [a, b] = [done[i], done[j]];
      const assignment: Record<string, string> = {};
      const lines = a.lines.map((la, k) => {
        const lb = b.lines[k];
        const useB = lb.status === 'found' && (la.status !== 'found' || lb.lineTotal < la.lineTotal);
        const line = useB ? lb : la;
        if (line.status === 'found') assignment[line.item.id] = useB ? b.retailerId : a.retailerId;
        return line;
      });
      const found = lines.filter((l) => l.status === 'found').length;
      const stores = new Set(Object.values(assignment));
      if (stores.size < 2) continue; // One store wins everything: that's not a split.
      const total = round(lines.reduce((sum, l) => sum + l.lineTotal, 0));
      const driving = extra[a.retailerId] !== undefined || extra[b.retailerId] !== undefined ? round((extra[a.retailerId] ?? 0) + (extra[b.retailerId] ?? 0)) : undefined;
      // Each store's order is its own part of the list, with its own fees and thresholds.
      const partOf = (id: string) => round(lines.reduce((sum, l) => sum + (l.status === 'found' && assignment[l.item.id] === id ? l.lineTotal : 0), 0));
      const fees = orderCost ? round(ordered(a.retailerId, partOf(a.retailerId)) + ordered(b.retailerId, partOf(b.retailerId))) : undefined;
      const candidate: SplitTrip = {
        retailerIds: [a.retailerId, b.retailerId],
        assignment,
        lines,
        total,
        found,
        savings: round(singleCost - total - (driving ?? 0) - (fees ?? 0)),
        extraItems: found - single.found,
        ...(driving !== undefined ? { driving } : {}),
        ...(fees !== undefined ? { fees } : {}),
      };
      const cost = (t: SplitTrip) => t.total + (t.driving ?? 0) + (t.fees ?? 0);
      if (!best || candidate.found > best.found || (candidate.found === best.found && cost(candidate) < cost(best))) best = candidate;
    }
  }
  if (!best) return null;
  const worthIt = best.extraItems > 0 || (best.extraItems === 0 && best.savings >= MIN_SPLIT_SAVINGS);
  return worthIt ? best : null;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
