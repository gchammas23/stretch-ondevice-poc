import type { GroceryList, Trip, TripSaving } from '../lists/types';
import type { AppStore } from '../state/appStore';
import type { Basket, OrderCost, SplitTrip } from './basket';
import type { ShopMode } from './onlineCost';

/** Ordering online: how, what the order adds to its items, and what ordering the same items elsewhere would add. */
export interface TripOrder {
  mode: ShopMode;
  /** Fees and online prices on top of the items, for the whole trip. */
  fees?: number;
  costOf?: OrderCost;
}

/**
 * What shopping `from` saves against the cheapest other store that has every item it buys, at that store's prices
 * for those same items. Ordering online, each side's fees count. Null when no other finished store has them all, or
 * none costs more.
 */
export function tripSavings(from: Basket | SplitTrip, retailerIds: string[], baskets: Basket[], order?: TripOrder): TripSaving | null {
  const bought = from.lines.filter((l) => l.status === 'found').map((l) => l.item.id);
  if (!bought.length) return null;
  const mine = from.total + (order?.fees ?? 0);
  let best: TripSaving | null = null;
  for (const b of baskets) {
    if (retailerIds.includes(b.retailerId) || !b.complete) continue;
    const lines = bought.map((id) => b.lines.find((l) => l.item.id === id));
    if (lines.some((l) => !l || l.status !== 'found')) continue;
    const items = lines.reduce((sum, l) => sum + l!.lineTotal, 0);
    const cost = items + (order?.costOf ? order.costOf(b.retailerId, items) : 0);
    const amount = Math.round((cost - mine) * 100) / 100;
    if (!best || amount < best.amount) best = { retailerId: b.retailerId, amount };
  }
  return best && best.amount > 0 ? best : null;
}

/**
 * Shop here: freezes what to buy where, so the checklist doesn't shift if prices are refreshed mid-trip. Ordering
 * online, `order` says how, and the fees count in the trip's total and its savings; `baskets` are then the stores
 * that take the order that way.
 */
export function startTrip(
  store: AppStore,
  list: GroceryList,
  retailerIds: string[],
  from: Basket | SplitTrip,
  baskets: Basket[] = [],
  order?: TripOrder,
): void {
  const split = 'assignment' in from ? from : null;
  const lines: Trip['lines'] = {};
  for (const line of from.lines) {
    const found = line.status === 'found';
    lines[line.item.id] = {
      retailerId: found ? (split ? (split.assignment[line.item.id] ?? '') : retailerIds[0]) : '',
      product: found ? line.product : null,
    };
  }
  const way = order?.mode === 'pickup' || order?.mode === 'delivery' ? order.mode : undefined;
  store.startTrip(list.id, {
    retailerIds,
    lines,
    total: from.total,
    startedAt: Date.now(),
    saved: tripSavings(from, retailerIds, baskets, way ? order : undefined),
    ...(way ? { mode: way, fees: Math.round((order?.fees ?? 0) * 100) / 100 } : {}),
  });
}
