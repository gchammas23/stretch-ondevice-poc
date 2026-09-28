import type { GroceryList } from '../lists/types';
import type { Coupon, CouponList } from '../onDevice/couponPage';
import {
  basketFor,
  bestSplit,
  driveCosts,
  driveVerdict,
  stretchPick,
  withUnitTotals,
  type Basket,
  type DriveVerdict,
  type OrderCost,
  type RankBy,
  type SplitTrip,
  type TripCosts,
  type Usuals,
} from './basket';
import { couponCredits, couponTarget, withCoupons, type CouponCredit } from './coupons';
import { extrasOf, onlineCost, onlineCosts, orderable, orderCostFn, tripCosts, type FeeContext, type OnlineCost, type ShopMode } from './onlineCost';
import type { PricingRun, StoreChoice } from './pricingEngine';
import type { PageRead } from './readBook';

// Pure functions only, so the tests run them in Node: Find a store's comparison, which the "list is priced" banner
// and the other screens share, so they all name the same pick.

export interface Comparison {
  baskets: Basket[];
  /** The best basket among stores that have finished; until one has, the best so far. */
  pick: Basket | null;
  /** The pick's store has finished, so it can be shopped while slower stores keep checking. */
  pickReady: boolean;
  /** The best split among stores that have finished, when it's worth it. */
  split: SplitTrip | null;
  /** Some store is still searching, or refreshing older prices. */
  running: boolean;
  /** When driving counts: each store's round trip, by retailer (stores whose distance is known). Not for delivery. */
  driving?: TripCosts;
  /** When driving counts: whether the pick's prices make up for the drive. */
  verdict: DriveVerdict | null;
  /** How the user shops. */
  mode: ShopMode;
  /** Ordering online: each store's order, by retailer: its items at online prices, fees and total. */
  online?: Record<string, OnlineCost>;
  /** Everything each store costs beyond its basket, by retailer, for ranking: driving, and ordering online. */
  extra?: TripCosts;
  /** Ordering online: whether a store's fees and online prices cost it the pick. */
  feesVerdict: DriveVerdict | null;
  /**
   * What the basket costs the way the user shops, as sold: its items, plus online prices and fees, less its clipped
   * coupons when the user counts them. Not driving.
   */
  orderTotal: (b: Basket) => number;
  /** The user counts clipped coupons in totals, and in ranking stores (see coupons.ts). */
  countCoupons: boolean;
  /** Each store's coupons for its basket, by retailer: the stores whose coupons the phone has read. Counted or not. */
  coupons: Record<string, CouponCredit>;
  /** What ordering `items` worth online costs at a store, for a part of the list (split trips). */
  costAt: (retailerId: string, items: number) => OnlineCost | undefined;
  /** Ordering online: what an order of a given size adds at each store, for split trips and trip savings. */
  orderCost?: OrderCost;
}

/** What the comparison depends on besides the list and its run: the user's choices, and what the phone has read. */
export interface ComparisonInputs {
  usuals: Usuals;
  rankBy: RankBy;
  drive: { on: boolean; perMile: number };
  /** The store each retailer is set to, for how far it is. */
  chosen: Record<string, { miles?: number } | undefined>;
  mode: ShopMode;
  /** The fee math's view of each store (see feeContexts). */
  ctxOf: (retailerId: string) => FeeContext;
  countCoupons: boolean;
  /** Each store's coupons for the account signed in to it in the app (see couponListsFor). */
  couponLists: Record<string, Coupon[] | undefined>;
  /** Today on the phone's calendar ('YYYY-MM-DD'), for which coupons still run. */
  today: string;
}

/**
 * Every store's basket for the list, with the user's usuals, Stretch's pick and the best split, from the run's prices.
 * Ranked by total, or by total in the same sizes everywhere, as the user chose on Find a store; and by what each costs
 * the way they shop: driving there, and ordering online, fees included, less clipped coupons when they count them.
 */
export function compareStores(list: GroceryList | undefined, run: PricingRun | undefined, inputs: ComparisonInputs): Comparison {
  const { usuals, rankBy, drive, chosen, mode, ctxOf, countCoupons, couponLists, today } = inputs;
  const way = mode === 'store' ? null : mode;
  const costAt = (retailerId: string, items: number) => (way ? onlineCost(retailerId, way, items, ctxOf(retailerId)) : undefined);
  const empty: Comparison = {
    baskets: [],
    pick: null,
    pickReady: false,
    split: null,
    running: false,
    verdict: null,
    feesVerdict: null,
    mode,
    orderTotal: (b: Basket) => b.total,
    costAt,
    countCoupons,
    coupons: {},
  };
  if (!list || !run) return empty;
  const baskets = withUnitTotals(run.retailerIds.map((id) => basketFor(list, id, run.results[id], usuals)));
  const running = baskets.some((b) => !b.complete || b.refreshing > 0);
  // Driving there and back, from each store's distance as its finder gave it. Nobody drives for a delivery.
  const driving = drive.on && mode !== 'delivery' ? driveCosts(Object.fromEntries(run.retailerIds.map((id) => [id, chosen[id]?.miles])), drive.perMile) : undefined;
  // Ordering online: each store's order, at its online prices with its fees. A store that doesn't take orders that
  // way can't be the pick, nor half of a split.
  const online = way ? onlineCosts(baskets, way, ctxOf) : undefined;
  // The coupons the phone read for each store's account, on its basket; they come off totals only when the user says.
  const coupons = couponCredits(baskets, (id) => couponLists[id], today);
  const counted = countCoupons ? coupons : undefined;
  const extra = withCoupons(tripCosts(driving, online), counted);
  const can = orderable(baskets, online);
  // A slow store doesn't hold the answer back: the pick comes from the stores that are done, and changes if the
  // slow one turns out cheaper.
  const pick = stretchPick(can.filter((b) => b.complete), rankBy, extra) ?? stretchPick(can, rankBy, extra);
  const fees = online ? extrasOf(online) : undefined;
  const orderCost = way ? orderCostFn(way, ctxOf) : undefined;
  return {
    baskets,
    pick,
    pickReady: !!pick?.complete,
    split: bestSplit(can, driving, orderCost),
    running,
    driving,
    verdict: driving ? driveVerdict(can, rankBy, driving, withCoupons(fees, counted)) : null,
    mode,
    online,
    extra,
    feesVerdict: fees ? driveVerdict(can, rankBy, fees, withCoupons(driving, counted)) : null,
    orderTotal: (b: Basket) => Math.round(((online?.[b.retailerId]?.total ?? b.total) - (counted?.[b.retailerId]?.amount ?? 0)) * 100) / 100,
    costAt,
    orderCost,
    countCoupons,
    coupons,
  };
}

/**
 * The compared stores' coupons, by retailer, for the accounts signed in to in the app, as last read; undefined where
 * there are none, or the read was for another sign-in.
 */
export function couponListsFor(
  choices: StoreChoice[],
  reads: Record<string, PageRead<CouponList>>,
  signedInAt: Record<string, number>,
): Record<string, Coupon[] | undefined> {
  const out: Record<string, Coupon[] | undefined> = {};
  for (const c of choices) {
    const target = couponTarget(c.config, signedInAt[c.config.id]);
    const read = reads[c.config.id];
    out[c.config.id] = target && !('needs' in target) && read?.key === target.key ? read.value?.coupons : undefined;
  }
  return out;
}
