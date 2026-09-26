import type { Product } from '../onDevice/types';

/** What the user wants of an item, beyond its name. */
export interface ItemPrefs {
  organic?: boolean;
  /** A brand to prefer, as written: "Horizon". */
  brand?: string;
  /** A size to prefer: "1 gal", "12 ct". */
  size?: string;
}

/** One store's product the user wants compared as-is at every store. */
export interface ExactRef {
  name: string;
  /** Its barcode, when the store gave one: then stores are also searched by it. */
  gtin?: string;
  /** Where it was chosen. */
  retailerId: string;
  productId: string;
}

export interface ListItem {
  id: string;
  /** What the user wrote, e.g. "Hot dogs". This is what gets searched, with the preferences. */
  name: string;
  qty: number;
  checked: boolean;
  /** Shown under the name, e.g. the recipe line it came from: "2 cups, sifted". */
  note?: string;
  prefs?: ItemPrefs;
  exact?: ExactRef;
}

/** What the user is buying where, frozen when they tap Shop here so it survives prices refreshing. */
export interface TripLine {
  retailerId: string;
  product: Product | null;
}

/** What a trip saves against the cheapest other store that has everything it buys. */
export interface TripSaving {
  retailerId: string;
  amount: number;
}

export interface Trip {
  /** One store, or two for a split trip, in the order shown. */
  retailerIds: string[];
  lines: Record<string, TripLine>;
  /** The items, at the prices then. */
  total: number;
  startedAt: number;
  /** Worked out when the trip started, from the prices then. Null when no other store had everything. */
  saved?: TripSaving | null;
  /** Ordered online: for pickup or delivery, and what the order adds to `total` (fees, online prices). */
  mode?: 'pickup' | 'delivery';
  fees?: number;
}

/** A finished trip, for the savings tracker and Add again. */
export interface TripRecord {
  id: string;
  listId: string;
  listName: string;
  retailerIds: string[];
  total: number;
  saved: TripSaving | null;
  /** The items as written on the list. */
  items: string[];
  startedAt: number;
  endedAt: number;
}

export interface GroceryList {
  id: string;
  name: string;
  items: ListItem[];
  trip: Trip | null;
  createdAt: number;
  updatedAt: number;
}

/** How a list item is searched and cached: "Hot  Dogs " and "hot dogs" are the same search. */
export const queryKey = (name: string): string => name.trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * What an item is searched for: its name, with "organic" and a preferred brand added when they aren't in it
 * already. A preferred size isn't searched for; it steers which result is picked.
 */
export function searchText(item: Pick<ListItem, 'name' | 'prefs'>): string {
  const p = item.prefs ?? {};
  const lower = item.name.toLowerCase();
  const brand = p.brand?.trim();
  return [p.organic && !lower.includes('organic') ? 'organic' : '', brand && !lower.includes(brand.toLowerCase()) ? brand : '', item.name]
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The key an item's results are stored under. */
export const itemKey = (item: Pick<ListItem, 'name' | 'prefs'>): string => queryKey(searchText(item));

/** Every search a list needs: each item's search, plus the barcode of each item wanted as an exact product. */
export function listQueries(list: Pick<GroceryList, 'items'>): string[] {
  const out = list.items.map(searchText);
  for (const i of list.items) if (i.exact?.gtin) out.push(i.exact.gtin);
  return out;
}
