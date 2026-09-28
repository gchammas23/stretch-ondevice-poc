import type { RetailerSearch } from '../onDevice/retailerSearch';
import { sameStoreId } from '../onDevice/storeIdentity';
import { inUsa, milesBetween, placeStores, sortNearest, trustedMiles, zipOfAddress, type LatLng, type NearbyStore, type ZipTie } from '../onDevice/storeLocator';
import type { RetailerConfig } from '../onDevice/types';
import type { AppStore, ChosenStore, StoreSetup } from './appStore';

// Pure TypeScript: sets each compared retailer's store near the user's ZIP code, with no store websites to visit.
// 1. The retailer's stores near the ZIP are listed: through its official API (Kroger, with keys), else from its own
//    store finder, loaded hidden on the phone.
// 2. Each is placed against the ZIP (see placeStores): measured on the map from the ZIP's center where its coordinates
//    are known, or its own ZIP code's; the finder's own distances count only when the finder searched the ZIP. A store
//    that can't be placed near the ZIP is never set: a finder that didn't take the ZIP lists the stores near wherever
//    the site thinks the phone is (a VPN's city, say).
// 3. A retailer with none within the radius isn't compared: nothing is searched there.
// 4. The store the user picked in the app, while it's in range, or else the nearest, becomes its store (a store
//    already set isn't set again), and is applied:
//    - 'api': the official API gets the store's number;
//    - 'auto': "make this my store" is pressed on the site's finder, hidden, where the store lives in its cookies;
//    - 'pinned': its number goes in each search request (see pinStoreInRequest).
// 5. When its stores can't be listed, placed or set, the setup fails and says why; it isn't compared until a store is
//    set (see storeChoices), since its site would pick one from the phone's connection, or keep one set near an earlier
//    ZIP.

export interface SetupDeps {
  store: AppStore;
  search: Pick<RetailerSearch, 'setStoreAuto' | 'storesNear'>;
  retailers: RetailerConfig[];
  /** True when the retailer's official API is set up, so it takes the store itself. */
  apiTakesZip: (cfg: RetailerConfig) => boolean;
  /** Where a ZIP code is on the map, for distances to stores whose finder doesn't give them. */
  locate?: (zip: string) => Promise<LatLng | null>;
}

/** Retailers set up at once: each is a page load, or an API call. */
const AT_ONCE = 4;
/** Stores kept per retailer for the list to choose from. */
const LISTED = 12;
/** Stores placed by their own ZIP code, at most, per retailer: each is a look-up on the phone's geocoder. */
const LOCATE_AT_MOST = 3;

type Locate = NonNullable<SetupDeps['locate']>;

/** ZIP codes each geocoder answered for this session (null: nowhere in the U.S.), so none is asked for twice. */
const located = new WeakMap<Locate, Map<string, Promise<LatLng | null>>>();

/**
 * Where a ZIP code is on the map, once a session; null when it can't be told, or the answer isn't in the U.S. A look-up
 * that failed (no connection, say) is asked again next time.
 */
function locateOnce(zip: string, locate: Locate): Promise<LatLng | null> {
  let places = located.get(locate);
  if (!places) located.set(locate, (places = new Map()));
  let at = places.get(zip);
  if (!at) {
    const asked = locate(zip).then(
      (p) => (p && inUsa(p) ? p : null),
      () => {
        places!.delete(zip);
        return null;
      },
    );
    places.set(zip, asked);
    at = asked;
  }
  return at;
}

export const isUsZip = (zip: string): boolean => /^\d{5}$/.test(zip.trim());

/** The retailer's setup for the current ZIP, or undefined if it hasn't been set up for it. */
export function currentSetup(store: AppStore, retailerId: string): StoreSetup | undefined {
  const { zip, storeSetup } = store.getState().settings;
  const setup = storeSetup[retailerId];
  return zip && setup?.zip === zip ? setup : undefined;
}

/**
 * Saves the ZIP and sets up every compared retailer (or just `only`) for it, four at a time. Store lists already
 * read for this ZIP are reused, unless `refresh`.
 */
export async function setUpStores(zip: string, deps: SetupDeps, only?: string[], opts: { refresh?: boolean } = {}): Promise<void> {
  const { store, retailers } = deps;
  const clean = zip.trim();
  if (!isUsZip(clean)) return;
  store.setZip(clean);
  const ids = (only ?? store.getState().settings.retailerIds).filter((id) => retailers.some((r) => r.id === id && r.enabled));
  for (const id of ids) store.setStoreSetup(id, { zip: clean, status: 'working', at: Date.now() });
  const origin = await originOf(clean, deps);
  const queue = [...ids];
  await Promise.all(
    Array.from({ length: AT_ONCE }, async () => {
      for (let id = queue.shift(); id; id = queue.shift()) await setUpOne(id, clean, origin, deps, !!opts.refresh);
    }),
  );
}

/** Where the ZIP code is on the map: saved, or looked up once. A place outside the U.S. is the geocoder's mistake. */
async function originOf(zip: string, deps: SetupDeps): Promise<LatLng | undefined> {
  const saved = deps.store.getState().settings.origin;
  if (saved?.zip === zip && inUsa(saved)) return { lat: saved.lat, lng: saved.lng };
  const found = deps.locate ? await locateOnce(zip, deps.locate) : null;
  if (!found) return undefined;
  deps.store.setOrigin({ zip, ...found });
  return found;
}

/**
 * Stores whose distance can't be trusted (no coordinates, and a finder that didn't search the ZIP, or gave none),
 * placed by their own ZIP code on the map, in the list's order, a few at most: until one is within the radius.
 */
async function placeByZip(stores: NearbyStore[], tie: ZipTie, radius: number, origin: LatLng | undefined, deps: SetupDeps): Promise<NearbyStore[]> {
  const { locate } = deps;
  if (!origin || !locate || stores.some((s) => (trustedMiles(s, tie) ?? Infinity) <= radius)) return stores;
  const out = [...stores];
  let asked = 0;
  for (let i = 0; i < out.length && asked < LOCATE_AT_MOST; i++) {
    if (trustedMiles(out[i], tie) !== undefined) continue;
    const zip = zipOfAddress(out[i].address);
    if (!zip) continue;
    asked++;
    const at = await locateOnce(zip, locate);
    if (!at) continue;
    out[i] = { ...out[i], miles: Math.round(milesBetween(origin, at) * 10) / 10, milesFrom: 'zip' };
    if (out[i].miles! <= radius) break;
  }
  return out;
}

async function setUpOne(id: string, zip: string, origin: LatLng | undefined, deps: SetupDeps, refresh: boolean): Promise<void> {
  const { store, search, retailers } = deps;
  const cfg = retailers.find((r) => r.id === id && r.enabled);
  if (!cfg) return;
  const { radiusMiles, nearbyStores } = store.getState().settings;
  // A finder lists the nearest whatever the radius; an API is asked within one. A list kept from before lists said how
  // they're tied to the ZIP isn't reused: it may be for another place.
  const cached = nearbyStores[id];
  let stores: NearbyStore[];
  let tie: ZipTie;
  if (!refresh && cached?.zip === zip && cached.tie && (cached.radius === 0 || cached.radius >= radiusMiles)) {
    stores = cached.stores;
    tie = cached.tie;
  } else {
    const listed = await search.storesNear(cfg, zip, radiusMiles, origin);
    // Another ZIP or distance was set meanwhile: its own run sets this retailer up.
    const now = store.getState().settings;
    if (now.zip !== zip || now.radiusMiles !== radiusMiles) return;
    if (!listed.ok) {
      // Looking again failed: a store already set near this ZIP stays.
      if (now.storeIds[id] && now.chosenStores[id]) {
        store.setStoreSetup(id, { zip, status: 'done', how: howOf(cfg, deps), at: Date.now() });
      } else {
        store.setStoreSetup(id, { zip, status: 'failed', reason: listed.reason, at: Date.now() });
      }
      return;
    }
    tie = listed.tie;
    stores = sortNearest(await placeByZip(listed.stores.slice(0, LISTED), tie, radiusMiles, origin, deps));
    const later = store.getState().settings;
    if (later.zip !== zip || later.radiusMiles !== radiusMiles) return;
    store.setNearbyStores(id, { zip, radius: listed.how === 'api' ? radiusMiles : 0, stores, tie, at: Date.now() });
  }
  const placed = placeStores(stores, radiusMiles, tie);
  if (placed.verdict === 'none') {
    store.setStoreSetup(id, { zip, status: 'none', at: Date.now() });
    return;
  }
  if (placed.verdict !== 'near') {
    // Its finder listed stores near another place, or couldn't say where they are: none of them is set.
    store.setStoreSetup(id, { zip, status: 'failed', reason: placed.verdict === 'elsewhere' ? 'stores_elsewhere' : 'stores_unplaced', at: Date.now() });
    return;
  }
  // A store the user picked stays theirs while it's in range; otherwise, the nearest.
  const { chosenStores, storeIds } = store.getState().settings;
  const had = chosenStores[id];
  const picked = had?.from === 'list' ? placed.stores.find((s) => sameStoreId(s.id, had.id)) : undefined;
  const target = picked ?? placed.stores[0];
  if (!refresh && sameStoreId(storeIds[id], target.id)) {
    // Already its store: nothing to set again.
    store.setStoreSetup(id, { zip, status: 'done', how: howOf(cfg, deps), at: Date.now() });
    return;
  }
  await applyStore(cfg, target, picked ? 'list' : 'nearest', zip, deps);
}

/** How a store is set at this retailer: its API, its site's finder (pressed by the app), or its number in each search. */
const howOf = (cfg: RetailerConfig, deps: SetupDeps): NonNullable<StoreSetup['how']> =>
  deps.apiTakesZip(cfg) ? 'api' : cfg.storeFinder?.auto ? 'auto' : 'pinned';

/**
 * Makes `nearby` the retailer's store: through its API, on its site's finder (hidden) where the store lives in its
 * cookies, or pinned in each search request. False when it couldn't be set.
 */
export async function applyStore(cfg: RetailerConfig, nearby: NearbyStore, from: ChosenStore['from'], zip: string, deps: SetupDeps): Promise<boolean> {
  const { store, search } = deps;
  const how = howOf(cfg, deps);
  if (how === 'auto') {
    store.setStoreSetup(cfg.id, { zip, status: 'working', at: Date.now() });
    const result = await search.setStoreAuto(cfg, zip, { id: nearby.id, name: nearby.name });
    if (store.getState().settings.zip !== zip) return false;
    if (!result.ok) {
      store.setStoreSetup(cfg.id, { zip, status: 'failed', reason: result.reason, at: Date.now() });
      return false;
    }
    store.storePicked(cfg.id);
  }
  const at = Date.now();
  store.setStoreId(cfg.id, nearby.id);
  store.setChosenStore(cfg.id, { id: nearby.id, name: nearby.name, address: nearby.address, miles: nearby.miles, from, at });
  store.setStoreSetup(cfg.id, { zip, status: 'done', how, at });
  return true;
}

/** The user picked `nearby` from the retailer's list in the app. */
export function chooseStore(cfg: RetailerConfig, nearby: NearbyStore, deps: SetupDeps): Promise<boolean> {
  return applyStore(cfg, nearby, 'list', deps.store.getState().settings.zip, deps);
}
