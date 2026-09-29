import type { CloudRetailerId, Engine } from '../cloud/jobs';
import type { ParsedItem } from '../lists/parse';
import { queryKey, type ExactRef, type GroceryList, type ItemPrefs, type ListItem, type Trip, type TripRecord } from '../lists/types';
import { isObj } from '../onDevice/json';
import { isRetailerConfig } from '../onDevice/retailers';
import { sameStoreId } from '../onDevice/storeIdentity';
import type { NearbyStore, ZipTie } from '../onDevice/storeLocator';
import type { KnownStore, Product, RetailerConfig } from '../onDevice/types';
import type { RankBy, Usuals } from '../pricing/basket';
import { asMember } from '../pricing/member';
import { SHOP_MODES, type ShopMode } from '../pricing/onlineCost';

// Pure TypeScript. The app saves through AsyncStorage; the tests use memory.

export interface KeyValueStore {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

/** How a retailer's store was set for the user's ZIP code. */
export interface StoreSetup {
  zip: string;
  /**
   * 'done': a store is set. 'none': the retailer has no store within the radius, so it isn't compared. 'failed': its
   * stores couldn't be listed, placed near the ZIP or set, so it isn't compared until one is (its site would pick one
   * from the phone's connection); an official API that takes the ZIP, and a store with no finder, still are.
   */
  status: 'working' | 'done' | 'none' | 'failed';
  /**
   * 'api': the official API takes the store. 'auto': the app pressed "make this my store" on the site's finder.
   * 'pinned': its number goes in each search request. 'site': the user chose it on the site (from before).
   */
  how?: 'api' | 'auto' | 'pinned' | 'site';
  /** The store as the site named it, when known. */
  label?: string;
  /**
   * Why it failed, e.g. 'challenge', 'no_stores_listed', 'button_not_found', 'timeout', 'interrupted',
   * 'stores_elsewhere' (its finder listed stores near another place), 'stores_unplaced' (nothing said where they are).
   */
  reason?: string;
  at: number;
}

/** A retailer's stores near a ZIP code, as its finder or API listed them, nearest first. */
export interface NearbyList {
  zip: string;
  /** The radius they were listed within; 0 for a finder, which lists the nearest whatever the radius. */
  radius: number;
  stores: NearbyStore[];
  /** How the list is tied to the ZIP (see nearbyList). Lists kept before it was said have none, and aren't reused. */
  tie?: ZipTie;
  at: number;
}

/** The store set on a retailer's site, as the app learned it then. */
export interface ChosenStore extends KnownStore {
  /**
   * 'nearest': picked for being the nearest. 'list': the user picked it from the list in the app. 'finder' and
   * 'site': from before, set on the retailer's own site.
   */
  from: 'nearest' | 'list' | 'finder' | 'site';
  /** Miles from the ZIP code, when known. */
  miles?: number;
  at: number;
}

/** The store a retailer's latest search got its prices for, as far as the search showed it. */
export interface SeenStore extends KnownStore {
  /** The store key the search ran under (see storeChoices): if it's another one now, the store changed since. */
  storeKey: string;
  at: number;
}

export interface Settings {
  /** Retailers compared for every list, in the order shown. */
  retailerIds: string[];
  /** The store number each retailer is set to near `zip` (see storeSetup.ts). Kroger's API takes the ZIP without one. */
  storeIds: Record<string, string>;
  /** When the user last picked a store on each retailer's site. Part of the price cache key. */
  storePickedAt: Record<string, number>;
  /** The U.S. ZIP code the user wants prices near. Empty: each site picks from the phone's connection. */
  zip: string;
  storeSetup: Record<string, StoreSetup>;
  /** The first-run welcome is done (finished or skipped). */
  onboarded: boolean;
  /** Stores the user added from a search link (Add a store). */
  customRetailers: RetailerConfig[];
  /** Rank stores by total, or by total in the same sizes everywhere. */
  rankBy: RankBy;
  /** Hidden store pages load without images, fonts or video. */
  lightPages: boolean;
  /** Where to fetch store rules from, overriding the built-in ones. Empty: the build's own setting, if any. */
  rulesUrl: string;
  /** The store set on each retailer's site. Kept until another is set: the site's cookies keep it too. */
  chosenStores: Record<string, ChosenStore>;
  /** Which store each retailer's latest search got prices for. */
  seenStores: Record<string, SeenStore>;
  /** Stores farther than this from the ZIP code don't count: a retailer with none nearer isn't compared. */
  radiusMiles: number;
  /** Where the ZIP code is on the map, for distances to stores: its own point, never the phone's. */
  origin?: { zip: string; lat: number; lng: number };
  /** Each retailer's stores near the ZIP code, for the list to choose from. */
  nearbyStores: Record<string, NearbyList>;
  /** Count the drive to each store and back (at `perMile` dollars a mile) when ranking stores. */
  drive: { on: boolean; perMile: number };
  /** The loyalty programs the user belongs to, by retailer: their member prices count. */
  memberships: Record<string, boolean>;
  /** When the user last signed in to each retailer's own site in the app, so its searches carry their account. */
  signedInAt: Record<string, number>;
  /** How the user shops: in store, or ordering online for pickup or delivery, whose fees then count (see onlineCost.ts). */
  shopMode: ShopMode;
  /** The online plans the user has (Walmart+, Instacart+...), by plan id: their perks count in online totals. */
  onlinePlans: Record<string, boolean>;
  /**
   * Take the clipped coupons that fit each store's basket off its total, and rank stores by that (see coupons.ts). The
   * user's choice, off to start: coupons show beside prices either way.
   */
  countCoupons: boolean;
  /** Shopping in store, the Shop here checklist is in the order of a walk through the store, by aisle (see aisles.ts). */
  sortByAisle: boolean;
  /** Cloud fetch (src/cloud): off to start, and then nothing about the app changes. */
  cloud: CloudSettings;
}

/**
 * Cloud fetch: Walmart and Target read through Browser Use's cloud browsers instead of on this phone, as background
 * jobs. Kroger stays on its official API either way.
 */
export interface CloudSettings {
  on: boolean;
  /** 'scripted': the app drives a cloud browser itself. 'agent': a Browser Use agent does it from a task in words. */
  engine: Engine;
  /** Target in scripted mode: a cloud browser, or this phone as before (if its cloud spike fails; see the README). */
  targetScripted: 'cloud' | 'device';
  /** Store numbers for cloud searches, used where Your stores has none: Walmart's, Target's, Kroger's locationId. */
  storeIds: Partial<Record<CloudRetailerId, string>>;
  /** Notifications were asked for, once, when the switch was first turned on. */
  askedNotifications: boolean;
}

export const CLOUD_OFF: CloudSettings = { on: false, engine: 'scripted', targetScripted: 'cloud', storeIds: {}, askedNotifications: false };

/** Saved cloud settings, keeping only valid values. */
function readCloud(v: unknown): CloudSettings {
  if (!isObj(v)) return CLOUD_OFF;
  const ids = isObj(v.storeIds) ? v.storeIds : {};
  const storeIds: CloudSettings['storeIds'] = {};
  for (const id of ['walmart', 'target', 'kroger'] as const) if (typeof ids[id] === 'string' && ids[id]) storeIds[id] = ids[id] as string;
  return {
    on: v.on === true,
    engine: v.engine === 'agent' ? 'agent' : 'scripted',
    targetScripted: v.targetScripted === 'device' ? 'device' : 'cloud',
    storeIds,
    askedNotifications: v.askedNotifications === true,
  };
}

/** A product whose price the user wants to hear about when it drops. */
export interface WatchItem {
  retailerId: string;
  /** Which of the retailer's stores, as the price cache keys it. */
  storeKey: string;
  productId: string;
  name: string;
  imageUrl?: string;
  url?: string;
  addedPrice: number;
  addedAt: number;
  lastPrice: number;
  lastAt: number;
  /** The latest drop, until the price goes back above it. */
  drop?: { from: number; to: number; at: number };
  /** Its store changed (another store, a sign-in): the next price read there starts it afresh, rather than as a drop. */
  moved?: true;
}

export interface AppState {
  lists: GroceryList[];
  settings: Settings;
  /** The product the user chose for each item at each store, used for that item in every list. */
  usuals: Usuals;
  /** Finished trips, newest first. */
  trips: TripRecord[];
  watch: WatchItem[];
  /** Price checks, newest first. */
  recentSearches: string[];
}

export const DEFAULT_RETAILERS = ['walmart', 'target', 'kroger', 'aldi'];
/** What a mile of driving costs, to start with: fuel and wear, about what U.S. mileage rates allow. */
export const DEFAULT_PER_MILE = 0.7;
/** How far a store may be from the ZIP code, to start. */
export const DEFAULT_RADIUS_MILES = 25;
const KEY = 'stretch.app.v1';
const TRIPS_KEPT = 200;
const RECENT_KEPT = 8;

export const newId = (): string => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

const item = (name: string, qty = 1, note?: string): ListItem => ({ id: newId(), name, qty, checked: false, ...(note ? { note } : {}) });
const cleanName = (name: string) => name.trim().replace(/\s+/g, ' ');

/** What a first launch shows, so there's something to price straight away. */
export function seedLists(now = Date.now()): GroceryList[] {
  const list = (name: string, names: string[], at: number): GroceryList => ({
    id: newId(),
    name,
    items: names.map((n) => item(n)),
    trip: null,
    createdAt: at,
    updatedAt: at,
  });
  return [
    list('Sunday BBQ', ['Hot dogs', 'Hot dog buns', 'Ketchup', 'Mustard', 'Napkins', 'Iced tea'], now),
    list('Pancake breakfast', ['Pancake mix', 'Maple syrup', 'Eggs', 'Butter', 'Milk', 'Blueberries'], now - 1),
  ];
}

/** A saved record of records, keeping only entries that pass `ok`. */
function records<T>(value: unknown, ok: (r: Record<string, unknown>) => boolean): Record<string, T> {
  if (!isObj(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([, r]) => isObj(r) && ok(r))) as Record<string, T>;
}

/** Saved values by retailer, keeping the valid ones. */
function flags<T>(value: unknown, ok: (v: unknown) => v is T): Record<string, T> {
  if (!isObj(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([, v]) => ok(v))) as Record<string, T>;
}

/** Only a store's own fields, without undefined ones (they don't survive saving anyway). */
const storeFields = (s: KnownStore): KnownStore => ({
  ...(s.name ? { name: s.name } : {}),
  ...(s.address ? { address: s.address } : {}),
  ...(s.id ? { id: s.id } : {}),
});

/** Saves from before usuals kept each item's choices on the item itself: those become usuals. */
function migrate(lists: GroceryList[], usuals: Usuals): { lists: GroceryList[]; usuals: Usuals } {
  const out: Usuals = { ...usuals };
  const cleaned = lists.map((list) => ({
    ...list,
    items: list.items.map((i) => {
      const { picks, ...rest } = i as ListItem & { picks?: unknown };
      if (isObj(picks)) {
        const key = queryKey(i.name);
        for (const [rid, pid] of Object.entries(picks)) {
          if (typeof pid === 'string' && !out[key]?.[rid]) out[key] = { ...out[key], [rid]: pid };
        }
      }
      return rest;
    }),
  }));
  return { lists: cleaned, usuals: out };
}

export class AppStore {
  private state: AppState = {
    lists: [],
    settings: {
      retailerIds: DEFAULT_RETAILERS,
      storeIds: {},
      storePickedAt: {},
      zip: '',
      storeSetup: {},
      onboarded: false,
      customRetailers: [],
      rankBy: 'total',
      lightPages: true,
      rulesUrl: '',
      chosenStores: {},
      seenStores: {},
      // Warehouse clubs and suburban stores are often 10 to 20 miles out: 10 left Costco out (16 miles, on a phone).
      radiusMiles: DEFAULT_RADIUS_MILES,
      nearbyStores: {},
      drive: { on: false, perMile: DEFAULT_PER_MILE },
      memberships: {},
      signedInAt: {},
      shopMode: 'store',
      onlinePlans: {},
      countCoupons: false,
      sortByAisle: true,
      cloud: CLOUD_OFF,
    },
    usuals: {},
    trips: [],
    watch: [],
    recentSearches: [],
  };
  private listeners = new Set<() => void>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private storage: KeyValueStore | null = null;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getState = (): AppState => this.state;

  async hydrate(storage: KeyValueStore): Promise<void> {
    this.storage = storage;
    let saved: Partial<AppState> | null = null;
    try {
      const raw = await storage.getItem(KEY);
      saved = raw ? (JSON.parse(raw) as Partial<AppState>) : null;
    } catch {
      saved = null;
    }
    const { lists, usuals } = migrate(
      Array.isArray(saved?.lists) ? saved.lists : seedLists(),
      isObj(saved?.usuals) ? (saved.usuals as Usuals) : {},
    );
    const settings = { ...this.state.settings, ...(saved?.settings ?? {}) };
    // A setup still running when the app was closed didn't finish; nor did one left for the user to finish on the
    // retailer's site, before stores were set in the app.
    const storeSetup: Record<string, StoreSetup> = {};
    for (const [id, s] of Object.entries(settings.storeSetup)) {
      storeSetup[id] = s.status === 'working' || String(s.status) === 'needsYou' ? { ...s, status: 'failed', reason: 'interrupted' } : s;
    }
    const customRetailers = (Array.isArray(settings.customRetailers) ? settings.customRetailers : []).filter(
      (r) => isRetailerConfig(r) && r.addedByUser === true && r.id.startsWith('custom-'),
    );
    const trips = Array.isArray(saved?.trips) ? saved.trips.filter((t) => isObj(t) && typeof t.total === 'number') : [];
    const watch = Array.isArray(saved?.watch)
      ? saved.watch.filter((w) => isObj(w) && typeof w.productId === 'string' && typeof w.lastPrice === 'number')
      : [];
    const recentSearches = Array.isArray(saved?.recentSearches) ? saved.recentSearches.filter((q) => typeof q === 'string').slice(0, RECENT_KEPT) : [];
    this.state = {
      lists,
      settings: {
        ...settings,
        storeSetup,
        customRetailers,
        onboarded: settings.onboarded === true,
        rankBy: settings.rankBy === 'unit' ? 'unit' : 'total',
        lightPages: settings.lightPages !== false,
        rulesUrl: typeof settings.rulesUrl === 'string' ? settings.rulesUrl : '',
        chosenStores: records<ChosenStore>(settings.chosenStores, (r) => ['nearest', 'list', 'finder', 'site'].includes(String(r.from)) && typeof r.at === 'number'),
        radiusMiles: typeof settings.radiusMiles === 'number' && settings.radiusMiles > 0 ? settings.radiusMiles : DEFAULT_RADIUS_MILES,
        origin:
          isObj(settings.origin) && typeof settings.origin.zip === 'string' && typeof settings.origin.lat === 'number' && typeof settings.origin.lng === 'number'
            ? settings.origin
            : undefined,
        nearbyStores: records<NearbyList>(
          settings.nearbyStores,
          (r) => typeof r.zip === 'string' && Array.isArray(r.stores) && typeof r.at === 'number' && (r.tie === undefined || ['asked', 'after', 'none'].includes(String(r.tie))),
        ),
        seenStores: records<SeenStore>(settings.seenStores, (r) => typeof r.storeKey === 'string' && typeof r.at === 'number'),
        drive: {
          on: isObj(settings.drive) && settings.drive.on === true,
          perMile: isObj(settings.drive) && typeof settings.drive.perMile === 'number' && settings.drive.perMile >= 0 ? settings.drive.perMile : DEFAULT_PER_MILE,
        },
        memberships: flags(settings.memberships, (v): v is boolean => v === true),
        signedInAt: flags(settings.signedInAt, (v): v is number => typeof v === 'number'),
        shopMode: SHOP_MODES.includes(settings.shopMode) ? settings.shopMode : 'store',
        onlinePlans: flags(settings.onlinePlans, (v): v is boolean => v === true),
        countCoupons: settings.countCoupons === true,
        sortByAisle: settings.sortByAisle !== false,
        cloud: readCloud(settings.cloud),
      },
      usuals,
      trips,
      watch,
      recentSearches,
    };
    this.emit();
    if (!saved) this.save();
  }

  /** Everything back to a first launch: the sample lists, no stores set, the welcome again. */
  reset(): void {
    const fresh = new AppStore().state;
    this.set({ ...fresh, lists: seedLists() });
  }

  /** Writes soon after the last change, so typing an item doesn't write per keystroke. */
  flush(): Promise<void> {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    return this.storage?.setItem(KEY, JSON.stringify(this.state)).catch(() => {}) ?? Promise.resolve();
  }

  // --- Lists ---------------------------------------------------------------------------------------

  createList(name = 'New list', items: ListItem[] = []): string {
    const at = Date.now();
    const list: GroceryList = { id: newId(), name, items, trip: null, createdAt: at, updatedAt: at };
    this.set({ ...this.state, lists: [list, ...this.state.lists] });
    return list.id;
  }

  /** A copy with the same items, unchecked, for next week's shop. */
  duplicateList(id: string): string | null {
    const list = this.state.lists.find((l) => l.id === id);
    if (!list) return null;
    return this.createList(`${list.name} (copy)`, list.items.map((i) => item(i.name, i.qty)));
  }

  renameList(id: string, name: string): void {
    const clean = name.trim();
    if (clean) this.editList(id, (l) => ({ ...l, name: clean }));
  }

  deleteList(id: string): void {
    this.set({ ...this.state, lists: this.state.lists.filter((l) => l.id !== id) });
  }

  addItem(listId: string, name: string): void {
    const clean = cleanName(name);
    if (clean) this.editList(listId, (l) => ({ ...l, items: [...l.items, item(clean)] }));
  }

  /**
   * Several items at once, e.g. a pasted list or a recipe's ingredients. Items already on the list are left as they
   * are. Returns how many were added.
   */
  addItems(listId: string, items: (ParsedItem & { note?: string })[]): number {
    const list = this.state.lists.find((l) => l.id === listId);
    if (!list) return 0;
    const have = new Set(list.items.map((i) => queryKey(i.name)));
    const fresh = items.filter((i) => cleanName(i.name) && !have.has(queryKey(i.name)));
    if (fresh.length) {
      this.editList(listId, (l) => ({ ...l, items: [...l.items, ...fresh.map((i) => item(cleanName(i.name), i.qty, i.note))] }));
    }
    return fresh.length;
  }

  renameItem(listId: string, itemId: string, name: string): void {
    const clean = cleanName(name);
    if (clean) this.editItem(listId, itemId, (i) => ({ ...i, name: clean }));
  }

  setItemNote(listId: string, itemId: string, note: string): void {
    const clean = note.trim();
    this.editItem(listId, itemId, (i) => {
      const next: ListItem = { ...i, note: clean };
      if (!clean) delete next.note;
      return next;
    });
  }

  /** Changes the item's preferences; empty ones are dropped. */
  setItemPrefs(listId: string, itemId: string, patch: ItemPrefs): void {
    this.editItem(listId, itemId, (i) => {
      const prefs: ItemPrefs = { ...i.prefs, ...patch };
      if (!prefs.organic) delete prefs.organic;
      if (!prefs.brand?.trim()) delete prefs.brand;
      if (!prefs.size?.trim()) delete prefs.size;
      const next: ListItem = { ...i, prefs };
      if (!Object.keys(prefs).length) delete next.prefs;
      return next;
    });
  }

  /** The product to compare at every store for this item, or null to go back to the best match at each. */
  setExact(listId: string, itemId: string, ref: ExactRef | null): void {
    this.setExactAll(listId, { [itemId]: ref });
  }

  /** Several items' exact products at once, e.g. a whole basket's. */
  setExactAll(listId: string, refs: Record<string, ExactRef | null>): void {
    this.editList(listId, (l) => ({
      ...l,
      items: l.items.map((i) => {
        if (!(i.id in refs)) return i;
        const ref = refs[i.id];
        const next: ListItem = { ...i, exact: ref ?? undefined };
        if (!ref) delete next.exact;
        return next;
      }),
    }));
  }

  removeItem(listId: string, itemId: string): void {
    this.editList(listId, (l) => ({ ...l, items: l.items.filter((i) => i.id !== itemId) }));
  }

  setQty(listId: string, itemId: string, qty: number): void {
    const n = Math.max(1, Math.min(99, Math.round(qty)));
    this.editItem(listId, itemId, (i) => ({ ...i, qty: n }));
  }

  toggleChecked(listId: string, itemId: string): void {
    this.editItem(listId, itemId, (i) => ({ ...i, checked: !i.checked }));
  }

  /** The user's choice of product for a list item at one retailer. It becomes their usual for that item everywhere. */
  setPick(listId: string, itemId: string, retailerId: string, productId: string): void {
    const found = this.state.lists.find((l) => l.id === listId)?.items.find((i) => i.id === itemId);
    if (found) this.setUsual(found.name, retailerId, productId);
  }

  setUsual(itemName: string, retailerId: string, productId: string): void {
    const key = queryKey(itemName);
    this.set({ ...this.state, usuals: { ...this.state.usuals, [key]: { ...this.state.usuals[key], [retailerId]: productId } } });
  }

  /** Back to Stretch's match for this item at this retailer. */
  forgetUsual(itemName: string, retailerId: string): void {
    const key = queryKey(itemName);
    const mine = { ...this.state.usuals[key] };
    delete mine[retailerId];
    const usuals = { ...this.state.usuals, [key]: mine };
    if (!Object.keys(mine).length) delete usuals[key];
    this.set({ ...this.state, usuals });
  }

  startTrip(listId: string, trip: Trip): void {
    this.editList(listId, (l) => ({ ...l, trip, items: l.items.map((i) => ({ ...i, checked: false })) }));
  }

  /** Done shopping: the trip goes into the savings tracker. Returns what was recorded. */
  endTrip(listId: string): TripRecord | null {
    const list = this.state.lists.find((l) => l.id === listId);
    const trip = list?.trip;
    if (!list || !trip) return null;
    const record: TripRecord = {
      id: newId(),
      listId,
      listName: list.name,
      retailerIds: trip.retailerIds,
      // Ordered online, what the order added counts too.
      total: Math.round((trip.total + (trip.fees ?? 0)) * 100) / 100,
      saved: trip.saved ?? null,
      items: list.items.map((i) => i.name),
      startedAt: trip.startedAt,
      endedAt: Date.now(),
    };
    this.set({
      ...this.state,
      trips: [record, ...this.state.trips].slice(0, TRIPS_KEPT),
      lists: this.state.lists.map((l) =>
        l.id === listId ? { ...l, trip: null, items: l.items.map((i) => ({ ...i, checked: false })), updatedAt: Date.now() } : l,
      ),
    });
    return record;
  }

  // --- Watchlist and price checks ------------------------------------------------------------------

  watchProduct(retailerId: string, storeKey: string, product: Product, at = Date.now()): void {
    const p = this.paid(retailerId, product);
    if (typeof p.price !== 'number') return;
    const rest = this.state.watch.filter((w) => !(w.retailerId === retailerId && w.productId === p.id));
    const entry: WatchItem = {
      retailerId,
      storeKey,
      productId: p.id,
      name: p.name,
      imageUrl: p.imageUrl,
      url: p.url,
      addedPrice: p.price,
      addedAt: at,
      lastPrice: p.price,
      lastAt: at,
    };
    this.set({ ...this.state, watch: [entry, ...rest] });
  }

  /**
   * The retailer's store is now `storeKey` (another store, a sign-in, a new ZIP): its watched products follow it, and
   * the first price read there starts them afresh (see notePrices).
   */
  followStore(retailerId: string, storeKey: string): void {
    if (!this.state.watch.some((w) => w.retailerId === retailerId && w.storeKey !== storeKey)) return;
    const watch = this.state.watch.map((w): WatchItem => (w.retailerId === retailerId && w.storeKey !== storeKey ? { ...w, storeKey, moved: true } : w));
    this.set({ ...this.state, watch });
  }

  unwatch(retailerId: string, productId: string): void {
    this.set({ ...this.state, watch: this.state.watch.filter((w) => !(w.retailerId === retailerId && w.productId === productId)) });
  }

  /**
   * Fresh prices read at a store: watched products among them take their new price. Returns the ones that just
   * dropped, to tell the user.
   */
  notePrices(retailerId: string, storeKey: string, products: Product[], at: number): WatchItem[] {
    if (!this.state.watch.some((w) => w.retailerId === retailerId)) return [];
    const byId = new Map(products.map((p) => [p.id, this.paid(retailerId, p)]));
    const dropped: WatchItem[] = [];
    let changed = false;
    const watch = this.state.watch.map((w) => {
      const p = w.retailerId === retailerId && w.storeKey === storeKey ? byId.get(w.productId) : undefined;
      if (!p || typeof p.price !== 'number' || at <= w.lastAt) return w;
      changed = true;
      if (w.moved) {
        // The first price at the store it moved to: where it starts from now, not a drop.
        const { moved: _moved, drop: _drop, ...rest } = w;
        return { ...rest, addedPrice: p.price, lastPrice: p.price, lastAt: at };
      }
      let next: WatchItem = { ...w, lastPrice: p.price, lastAt: at };
      if (p.price < w.lastPrice - 0.004) {
        next = { ...next, drop: { from: w.lastPrice, to: p.price, at } };
        dropped.push(next);
      } else if (w.drop && p.price > w.drop.to + 0.004) {
        delete next.drop;
      }
      return next;
    });
    if (changed) this.set({ ...this.state, watch });
    return dropped;
  }

  addRecentSearch(query: string): void {
    const clean = query.trim().replace(/\s+/g, ' ');
    if (!clean) return;
    const rest = this.state.recentSearches.filter((q) => queryKey(q) !== queryKey(clean));
    this.set({ ...this.state, recentSearches: [clean, ...rest].slice(0, RECENT_KEPT) });
  }

  // --- Settings --------------------------------------------------------------------------------------

  setRankBy(rankBy: RankBy): void {
    this.setSettings({ rankBy });
  }

  /** Whether driving counts when ranking stores, and what a mile costs. */
  setDrive(drive: Partial<Settings['drive']>): void {
    this.setSettings({ drive: { ...this.state.settings.drive, ...drive } });
  }

  /** The user belongs to (or left) a retailer's loyalty program: its member prices count, or don't. */
  setMember(retailerId: string, on: boolean): void {
    const memberships = { ...this.state.settings.memberships };
    if (on) memberships[retailerId] = true;
    else delete memberships[retailerId];
    this.setSettings({ memberships });
  }

  /** How the user shops: in store, or online for pickup or delivery. */
  setShopMode(shopMode: ShopMode): void {
    if (SHOP_MODES.includes(shopMode)) this.setSettings({ shopMode });
  }

  /** The user has (or dropped) an online plan, Walmart+ say: its perks count, at every store that takes it. */
  setOnlinePlan(planId: string, on: boolean): void {
    const onlinePlans = { ...this.state.settings.onlinePlans };
    if (on) onlinePlans[planId] = true;
    else delete onlinePlans[planId];
    this.setSettings({ onlinePlans });
  }

  /** Whether clipped coupons come off stores' totals. */
  setCountCoupons(on: boolean): void {
    this.setSettings({ countCoupons: on });
  }

  /** Cloud fetch's settings: the switch, the engine, where Target goes in scripted mode. */
  setCloud(patch: Partial<Omit<CloudSettings, 'storeIds'>>): void {
    this.setSettings({ cloud: { ...this.state.settings.cloud, ...patch } });
  }

  /** A store number typed for cloud searches, where Your stores has none; empty removes it. */
  setCloudStoreId(retailerId: CloudRetailerId, storeId: string): void {
    const storeIds = { ...this.state.settings.cloud.storeIds };
    const clean = storeId.trim();
    if (clean) storeIds[retailerId] = clean;
    else delete storeIds[retailerId];
    this.setSettings({ cloud: { ...this.state.settings.cloud, storeIds } });
  }

  /** The user signed in to the retailer's site in the app: its searches now carry their account. */
  noteSignedIn(retailerId: string, at: number): void {
    this.setSettings({ signedInAt: { ...this.state.settings.signedInAt, [retailerId]: at } });
  }

  /** A sign-in the store's own page says didn't happen (Done, without signing in): back to how it was before it. */
  undoSignIn(retailerId: string, before: number | undefined): void {
    const signedInAt = { ...this.state.settings.signedInAt };
    if (before === undefined) delete signedInAt[retailerId];
    else signedInAt[retailerId] = before;
    this.setSettings({ signedInAt });
  }

  setLightPages(on: boolean): void {
    this.setSettings({ lightPages: on });
  }

  /** Whether the Shop here checklist goes by aisle, or keeps the list's order. */
  setSortByAisle(on: boolean): void {
    this.setSettings({ sortByAisle: on });
  }

  setRulesUrl(url: string): void {
    this.setSettings({ rulesUrl: url.trim() });
  }

  setRetailerOn(retailerId: string, on: boolean): void {
    const ids = this.state.settings.retailerIds.filter((id) => id !== retailerId);
    this.setSettings({ retailerIds: on ? [...ids, retailerId] : ids });
  }

  setRetailers(retailerIds: string[]): void {
    this.setSettings({ retailerIds: [...new Set(retailerIds)] });
  }

  setStoreId(retailerId: string, storeId: string): void {
    this.setSettings({ storeIds: { ...this.state.settings.storeIds, [retailerId]: storeId.trim() } });
  }

  /** Another store was just set on the retailer's site: what earlier searches saw there is about the old one. */
  storePicked(retailerId: string): void {
    const seenStores = { ...this.state.settings.seenStores };
    delete seenStores[retailerId];
    this.setSettings({ storePickedAt: { ...this.state.settings.storePickedAt, [retailerId]: Date.now() }, seenStores });
  }

  /** A new ZIP code forgets the stores set near the old one, and what searches saw there: they're set again for it. */
  setZip(zip: string): void {
    const clean = zip.trim();
    this.setSettings(clean === this.state.settings.zip ? { zip: clean } : { zip: clean, seenStores: {}, storeIds: {}, chosenStores: {} });
  }

  /** How far stores may be: a retailer with none nearer isn't compared. */
  setRadius(miles: number): void {
    if (miles > 0 && miles !== this.state.settings.radiusMiles) this.setSettings({ radiusMiles: miles });
  }

  /** Where the ZIP code is on the map. */
  setOrigin(origin: { zip: string; lat: number; lng: number }): void {
    this.setSettings({ origin });
  }

  /** A retailer's stores near the ZIP code, as just listed. */
  setNearbyStores(retailerId: string, list: NearbyList): void {
    this.setSettings({ nearbyStores: { ...this.state.settings.nearbyStores, [retailerId]: list } });
  }

  /** The store now set on a retailer's site, as the app learned it; null forgets it. */
  setChosenStore(retailerId: string, chosen: ChosenStore | null): void {
    const chosenStores = { ...this.state.settings.chosenStores };
    if (chosen) chosenStores[retailerId] = { ...storeFields(chosen), from: chosen.from, ...(chosen.miles !== undefined ? { miles: chosen.miles } : {}), at: chosen.at };
    else delete chosenStores[retailerId];
    this.setSettings({ chosenStores });
  }

  /**
   * Which store a search just got its prices for. Saved only when it's news: another store, a name or number it
   * didn't have, or a minute since the last note, so a list's searches don't each write. A search that said nothing
   * about its store is noted too (the key and the time alone), once, so Your stores can say so.
   */
  noteSeenStore(retailerId: string, storeKey: string, store: KnownStore, at: number): void {
    const fresh = storeFields(store);
    const had = this.state.settings.seenStores[retailerId];
    if (!fresh.name && !fresh.id && !fresh.address) {
      // The search didn't say which store it priced: noted once, until a search under the same key does say.
      if (had?.storeKey === storeKey) return;
      this.setSettings({ seenStores: { ...this.state.settings.seenStores, [retailerId]: { storeKey, at } } });
      return;
    }
    const sameStore = !!had && had.storeKey === storeKey && (!fresh.id || !had.id || sameStoreId(fresh.id, had.id));
    const next: SeenStore = sameStore ? { ...storeFields(had), ...fresh, storeKey, at } : { ...fresh, storeKey, at };
    const unchanged = sameStore && had.name === next.name && had.address === next.address && had.id === next.id;
    if (unchanged && at - had.at < 60_000) return;
    this.setSettings({ seenStores: { ...this.state.settings.seenStores, [retailerId]: next } });
  }

  setStoreSetup(retailerId: string, setup: StoreSetup): void {
    this.setSettings({ storeSetup: { ...this.state.settings.storeSetup, [retailerId]: setup } });
  }

  setOnboarded(done: boolean): void {
    this.setSettings({ onboarded: done });
  }

  /** Adds a store made from a search link and compares it from now on. */
  addCustomRetailer(cfg: RetailerConfig): void {
    const { customRetailers, retailerIds } = this.state.settings;
    this.setSettings({
      customRetailers: [...customRetailers.filter((r) => r.id !== cfg.id), { ...cfg, addedByUser: true }],
      retailerIds: retailerIds.includes(cfg.id) ? retailerIds : [...retailerIds, cfg.id],
    });
  }

  removeCustomRetailer(id: string): void {
    const s = this.state.settings;
    const without = <T>(record: Record<string, T>) => {
      const copy = { ...record };
      delete copy[id];
      return copy;
    };
    this.setSettings({
      customRetailers: s.customRetailers.filter((r) => r.id !== id),
      retailerIds: s.retailerIds.filter((r) => r !== id),
      storeIds: without(s.storeIds),
      storePickedAt: without(s.storePickedAt),
      storeSetup: without(s.storeSetup),
      chosenStores: without(s.chosenStores),
      seenStores: without(s.seenStores),
      nearbyStores: without(s.nearbyStores),
    });
  }

  // --- Internals -------------------------------------------------------------------------------------

  /**
   * A product at the price the user pays there: the member price at a store whose program they belong to, as the
   * screens show it, so a watched price is the same kind of price when it's watched and when it's read again.
   */
  private paid(retailerId: string, p: Product): Product {
    return this.state.settings.memberships[retailerId] ? asMember(p) : p;
  }

  private setSettings(patch: Partial<Settings>): void {
    this.set({ ...this.state, settings: { ...this.state.settings, ...patch } });
  }

  private editList(id: string, fn: (l: GroceryList) => GroceryList): void {
    this.set({
      ...this.state,
      lists: this.state.lists.map((l) => (l.id === id ? { ...fn(l), updatedAt: Date.now() } : l)),
    });
  }

  private editItem(listId: string, itemId: string, fn: (i: ListItem) => ListItem): void {
    this.editList(listId, (l) => ({ ...l, items: l.items.map((i) => (i.id === itemId ? fn(i) : i)) }));
  }

  private set(next: AppState): void {
    this.state = next;
    this.emit();
    this.save();
  }

  private save(): void {
    if (!this.storage) return;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.flush(), 400);
  }

  private emit(): void {
    this.listeners.forEach((listener) => listener());
  }
}

/** What Add again offers: items from finished trips and other lists that aren't on this list, most used first. */
export function addAgain(state: Pick<AppState, 'lists' | 'trips'>, listId: string, limit = 8): string[] {
  const list = state.lists.find((l) => l.id === listId);
  const have = new Set(list?.items.map((i) => queryKey(i.name)) ?? []);
  const score = new Map<string, { name: string; n: number }>();
  const bump = (name: string, by: number) => {
    const key = queryKey(name);
    if (!key || have.has(key)) return;
    const had = score.get(key);
    score.set(key, { name: had?.name ?? name, n: (had?.n ?? 0) + by });
  };
  // Bought on a trip counts double: it was really needed.
  for (const t of state.trips) for (const name of t.items) bump(name, 2);
  for (const l of state.lists) if (l.id !== listId) for (const i of l.items) bump(i.name, 1);
  return [...score.values()].sort((a, b) => b.n - a.n).slice(0, limit).map((s) => s.name);
}
