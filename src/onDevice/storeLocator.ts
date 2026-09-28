import { storeFromFinder } from './storeIdentity';
import type { PagePayload, PageSource } from './types';

// Pure functions only, so the tests run them in Node.
//
// Stores near a ZIP code, read from a retailer's own store finder: the list of stores its page gets (JSON it
// fetched, or its page data), whatever the retailer calls the fields, the way autoDetect reads products. Failing
// that, the store cards on the page. Distances are measured from the ZIP code's center where the stores' coordinates
// are known: a finder measures from wherever it searched around, which isn't always the ZIP (a page that didn't take
// the ZIP lists the stores near where the site thinks the phone is: a VPN's city, say).

/** A store near the user, as the retailer's store finder lists it. */
export interface NearbyStore {
  /** The retailer's number for it. */
  id: string;
  name: string;
  /** Street, city, state and ZIP, as far as listed. */
  address?: string;
  /** Miles away. */
  miles?: number;
  /**
   * How `miles` is known: 'map', measured from the ZIP code's center to the store's own coordinates; 'zip', to its own
   * ZIP code's center (it had no coordinates); 'finder', as the finder said, from wherever it searched around. Lists
   * saved before this was kept have none, which counts as the finder's.
   */
  milesFrom?: 'map' | 'zip' | 'finder';
  lat?: number;
  lng?: number;
}

/**
 * How a finder's list is tied to the ZIP code searched: 'asked', the ZIP was in the finder page's address or in the
 * request that brought the list (an official API asked with it, too); 'after', the list came after the ZIP was typed
 * into the finder's box; 'none', neither: it may be for wherever the site thinks the phone is.
 */
export type ZipTie = 'asked' | 'after' | 'none';

export interface LatLng {
  lat: number;
  lng: number;
}

/**
 * Roughly within the U.S. and its territories: a ZIP code's center anywhere else is a geocoder's mistake (a string of
 * five digits can be a postcode abroad too).
 */
export function inUsa({ lat, lng }: LatLng): boolean {
  return (
    (lat >= 24 && lat <= 50 && lng >= -125.5 && lng <= -66.5) ||
    // Alaska, whose Aleutians cross the 180th meridian.
    (lat >= 51 && lat <= 72 && (lng <= -129 || lng >= 172)) ||
    (lat >= 18.5 && lat <= 22.5 && lng >= -161 && lng <= -154.5) ||
    // Puerto Rico and the Virgin Islands; Guam and the Northern Marianas.
    (lat >= 17.5 && lat <= 18.7 && lng >= -67.5 && lng <= -64.5) ||
    (lat >= 13 && lat <= 21 && lng >= 144 && lng <= 146.5)
  );
}

/** The ZIP code in a store's address ("…, Houston, TX 77007"), when it has one. */
export function zipOfAddress(address?: string): string | undefined {
  if (!address) return undefined;
  return /\b[A-Z]{2},?\s+(\d{5})(?:-\d{4})?\b/.exec(address)?.[1] ?? /(?:^|[\s,])(\d{5})(?:-\d{4})?\s*$/.exec(address)?.[1];
}

/** Miles between two points (haversine). */
export function milesBetween(a: LatLng, b: LatLng): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 3958.8 * Math.asin(Math.min(1, Math.sqrt(h)));
}

const ID_KEY = /^(?:store_?(?:id|number|num|no|nbr|code)|location_?id|id|number|facility_?id|warehouse_?(?:id|number|num)?|club_?(?:id|number)|site_?id|branch_?(?:id|number)|shop_?id|unit_?(?:id|number|num|no|nbr))$/i;
const NAME_KEY = /^(?:(?:store|location|display|vanity|branch|marketing|short|site|business)_?name|store_?short_?name|name|title|label)$/i;
const STREET_KEY = /^(?:address_?(?:line_?)?(?:1|one)|address_?lines?|street(?:_?address)?(?:_?1)?|line_?(?:1|one)|address)$/i;
const CITY_KEY = /^(?:city|city_?town|town|locality)$/i;
const STATE_KEY = /^(?:state|state_?code|state_?province|region|province|state_?abbreviation)$/i;
const ZIP_KEY = /^(?:zip|zip_?code|postal_?code|postcode|zipcode)$/i;
const LAT_KEY = /^(?:lat|latitude)$/i;
const LNG_KEY = /^(?:lng|lon|long|longitude)$/i;
const DIST_KEY = /^(?:distance|dist|distance_?(?:miles|mi|in_?miles)|miles|miles_?from|mileage)$/i;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A field of a store: its key, value, how deep it sits, and the key of the object holding it ('' at the top). */
type Field = [key: string, value: unknown, depth: number, parent: string];

/** Every field of an object and of objects inside it, nearest first: store fields often sit one or two down. */
function fieldsOf(o: Obj, depth = 0, parent = '', out: Field[] = []): Field[] {
  for (const [k, v] of Object.entries(o)) {
    if (isObj(v)) {
      if (depth < 2) fieldsOf(v, depth + 1, k, out);
    } else if (Array.isArray(v)) {
      // Names in a list ("location_names": [{ "name": ... }]), or lines of an address: the first counts.
      if (depth < 2 && isObj(v[0])) fieldsOf(v[0], depth + 1, k, out);
      else if (typeof v[0] === 'string') out.push([k, v[0], depth, parent]);
    } else {
      out.push([k, v, depth, parent]);
    }
  }
  return out.sort((a, b) => a[2] - b[2]);
}

/** Coordinates that aren't the store's own: its city's, or the searched place's. */
const NOT_THE_STORE = /city|town|region|state|country|postal|zip|search|query|origin|user|center|centre/i;

/** The store's place on the map: a latitude and longitude held by the same object. */
function coordinatesOf(fields: Field[]): LatLng | undefined {
  for (const [k, v, , parent] of fields) {
    if (!LAT_KEY.test(k) || NOT_THE_STORE.test(parent)) continue;
    const lat = num(v);
    const lng = num(fields.find(([k2, , , p2]) => p2 === parent && LNG_KEY.test(k2))?.[1]);
    if (lat !== undefined && lng !== undefined && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && (lat !== 0 || lng !== 0)) return { lat, lng };
  }
  return undefined;
}

const text = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' && Number.isFinite(v) ? String(v) : undefined;
const num = (v: unknown): number | undefined => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v.trim()) : NaN;
  return Number.isFinite(n) ? n : undefined;
};

/** "2.1 mi", 2.1, "3.4 km", { value: 2.1, unit: "MI" } as miles. */
function milesFrom(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? v : undefined;
  if (isObj(v)) {
    const value = num(v.value ?? v.distance ?? v.amount);
    const unit = text(v.unit ?? v.units ?? v.unitOfMeasure) ?? 'mi';
    return value === undefined ? undefined : /^k/i.test(unit) ? value * 0.621371 : value;
  }
  const m = typeof v === 'string' ? /([\d.]+)\s*(mi|miles?|km|kilometers?)?/i.exec(v) : null;
  if (!m) return undefined;
  const value = Number(m[1]);
  if (!Number.isFinite(value)) return undefined;
  return m[2] && /^k/i.test(m[2]) ? value * 0.621371 : value;
}

/**
 * The store's number: of the number fields nearest the top, the first that's all digits, else the first. A finder can
 * list its own id for a place beside the store's number (Whole Foods: "locationId": "6Po2SHCiuG", "storeCode": "10214").
 */
function idOf(fields: Field[]): string | undefined {
  const ids = fields.filter(([k, v]) => ID_KEY.test(k) && text(v) !== undefined);
  if (!ids.length) return undefined;
  const nearest = ids.filter(([, , depth]) => depth === ids[0][2]).map(([, v]) => text(v)!);
  return nearest.find((v) => /^\d+$/.test(v)) ?? nearest[0];
}

/** A store, if the object looks like one: a number, and an address or a place on the map. */
function toStore(o: Obj): NearbyStore | null {
  const fields = fieldsOf(o);
  const find = (re: RegExp) => fields.find(([k, v]) => re.test(k) && text(v) !== undefined)?.[1];
  const id = idOf(fields);
  if (!id || id.length > 20) return null;
  const street = text(find(STREET_KEY));
  const city = text(find(CITY_KEY));
  const state = text(find(STATE_KEY));
  const zip = text(find(ZIP_KEY));
  const at = coordinatesOf(fields);
  const hasPlace = !!at || !!(street && (city || zip));
  if (!hasPlace && !(city && state)) return null;
  const name = text(find(NAME_KEY)) ?? city ?? `Store ${id}`;
  const place = [city, [state, zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  const address = [street, place].filter(Boolean).join(', ') || undefined;
  const distance = fields.find(([k]) => DIST_KEY.test(k))?.[1] ?? Object.entries(o).find(([k]) => DIST_KEY.test(k))?.[1];
  const miles = milesFrom(distance);
  return {
    id,
    name,
    ...(address ? { address } : {}),
    ...(miles !== undefined ? { miles: Math.round(miles * 100) / 100 } : {}),
    ...(at ? { lat: at.lat, lng: at.lng } : {}),
  };
}

/** The list in `node` with the most stores in it. */
function bestList(node: unknown, depth = 0, best: { stores: NearbyStore[] } = { stores: [] }): { stores: NearbyStore[] } {
  if (depth > 12 || node === null || typeof node !== 'object') return best;
  if (Array.isArray(node)) {
    const objects = node.filter(isObj);
    if (objects.length) {
      const stores = objects.map(toStore).filter((s): s is NearbyStore => !!s);
      // Most of the list should be stores: a product list with one address in it isn't a store list.
      if (stores.length > best.stores.length && stores.length >= Math.ceil(objects.length / 2)) best.stores = stores;
    }
    for (const v of node.slice(0, 50)) bestList(v, depth + 1, best);
    return best;
  }
  for (const v of Object.values(node)) bestList(v, depth + 1, best);
  return best;
}

/** Store cards read off the page, when no data held the list (see storeListScript). */
export interface StoreCard {
  lines: string[];
  href?: string;
}

/** What a store finder page gave: its data and cards, and how the ZIP reached it (see storeListScript). */
export interface FinderPage extends PagePayload {
  cards?: StoreCard[];
  /**
   * The ZIP was in the page's address, typed into its box, typed into the box of the page before it (which moved on to
   * this one), or none of these (it had no box the app knew).
   */
  zipIn?: 'url' | 'box' | 'next' | 'none';
}

/** Beyond this, a list's nearest store says the list is for another place than the ZIP searched. */
export const ELSEWHERE_MILES = 100;

/** A list found on a finder page, how it's tied to the ZIP, and whether it came from the page's data or its cards. */
interface Candidate {
  stores: NearbyStore[];
  tie: ZipTie;
  cards: boolean;
  order: number;
}

const TIE_RANK: Record<ZipTie, number> = { asked: 0, after: 1, none: 2 };

/**
 * The stores a store finder page listed: of the lists in the data it got (responses it fetched, its page data) and its
 * store cards, the one nearest the ZIP code. Measured on the map where the stores' coordinates and `origin` (the ZIP's
 * center) are known; then a list the finder was asked for with the ZIP, or got after it was typed; then the biggest.
 * Each store once, nearest first. `tie` says how the list is tied to the ZIP (see placeStores).
 */
export function nearbyList(payload: FinderPage, origin?: LatLng, zip?: string): { stores: NearbyStore[]; tie: ZipTie } {
  const carries = (text?: string) => !!zip && !!text && text.includes(zip);
  const typed = payload.zipIn === 'url' || payload.zipIn === 'box' || payload.zipIn === 'next';
  // The page's own data is for the ZIP when its address carries it, or the page came after the ZIP was typed on the one
  // before; otherwise it may be what the page showed before the ZIP was typed. A response is for the ZIP when its
  // request carries it (or came after the ZIP was typed: a site can ask by the place it found for the ZIP instead).
  const pageTie: ZipTie = carries(payload.href) || payload.zipIn === 'url' ? 'asked' : payload.zipIn === 'next' ? 'after' : 'none';
  const responseTie = (s: PageSource): ZipTie =>
    carries(s.request?.url) || carries(s.request?.body) || carries(/^(?:response|replay) (\S+)/.exec(s.label)?.[1]) ? 'asked' : typed ? 'after' : pageTie;
  const texts: { text: string; tie: ZipTie }[] = [
    ...(payload.nextDataText ? [{ text: payload.nextDataText, tie: pageTie }] : []),
    ...(payload.sources ?? []).map((s) => ({ text: s.text, tie: /^(?:response|replay) /.test(s.label) ? responseTie(s) : pageTie })),
  ];
  const candidates: Candidate[] = [];
  const measure = (stores: NearbyStore[]) => {
    const seen = new Set<string>();
    return stores.filter((s) => !seen.has(s.id) && seen.add(s.id)).map((s) => withMiles(s, origin));
  };
  for (const { text, tie } of texts) {
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      continue;
    }
    const found = bestList(json).stores;
    if (found.length) candidates.push({ stores: measure(found), tie, cards: false, order: candidates.length });
  }
  const fromCards: NearbyStore[] = [];
  for (const card of payload.cards ?? []) {
    const s = storeFromFinder({ label: card.lines[0], lines: card.lines, links: card.href ? [card.href] : [] });
    // Only a number with a unit is a distance: "1.8 mi", not the 21 of "21 Flushing Ave".
    const unit = card.lines.map((l) => /(\d+(?:\.\d+)?)\s*(mi|miles?|km)\b/i.exec(l)).find(Boolean);
    const miles = unit ? milesFrom(`${unit[1]} ${unit[2]}`) : undefined;
    if (s?.id) fromCards.push({ id: s.id, name: s.name ?? `Store ${s.id}`, ...(s.address ? { address: s.address } : {}), ...(miles !== undefined ? { miles } : {}) });
  }
  // Cards are what the page shows at the end: for the ZIP when the page took it.
  if (fromCards.length) candidates.push({ stores: measure(fromCards), tie: pageTie === 'asked' ? 'asked' : typed ? 'after' : 'none', cards: true, order: candidates.length });
  if (!candidates.length) return { stores: [], tie: 'none' };

  // A list whose nearest store on the map is near the ZIP comes first, nearest first; then by how it's tied to the ZIP,
  // the page's data before its cards, the biggest, and the first found.
  const nearOnMap = (c: Candidate) => {
    const onMap = c.stores.filter((s) => s.milesFrom === 'map').map((s) => s.miles!);
    const nearest = onMap.length ? Math.min(...onMap) : Infinity;
    return nearest <= ELSEWHERE_MILES ? nearest : Infinity;
  };
  const best = [...candidates].sort(
    (a, b) =>
      nearOnMap(a) - nearOnMap(b) ||
      TIE_RANK[a.tie] - TIE_RANK[b.tie] ||
      Number(a.cards) - Number(b.cards) ||
      b.stores.length - a.stores.length ||
      a.order - b.order,
  )[0];
  return { stores: sortNearest(best.stores), tie: best.tie };
}

/**
 * The stores a store finder page listed (see nearbyList), nearest first, measured from `origin` where their coordinates
 * are known.
 */
export function nearbyStores(payload: FinderPage, origin?: LatLng, zip?: string): NearbyStore[] {
  return nearbyList(payload, origin, zip).stores;
}

/**
 * A store's miles from `origin`, measured on the map when its coordinates are known: that wins over the finder's own
 * distance, which is from wherever the finder searched around. Otherwise the finder's, said to be.
 */
export function withMiles(s: NearbyStore, origin?: LatLng): NearbyStore {
  if (origin && s.lat !== undefined && s.lng !== undefined) {
    return { ...s, miles: Math.round(milesBetween(origin, { lat: s.lat, lng: s.lng }) * 10) / 10, milesFrom: 'map' };
  }
  return s.miles !== undefined && !s.milesFrom ? { ...s, milesFrom: 'finder' } : s;
}

/**
 * How far a store is, as far as it can be trusted: measured on the map (from its coordinates, or its own ZIP code), or
 * as its finder said, when the finder searched around the ZIP (a list tied to it). Undefined when it can't be told.
 */
export function trustedMiles(s: NearbyStore, tie: ZipTie): number | undefined {
  if (s.miles === undefined) return undefined;
  if (s.milesFrom === 'map' || s.milesFrom === 'zip') return s.miles;
  return tie === 'none' ? undefined : s.miles;
}

/**
 * Where a retailer's listed stores are, against the radius around the ZIP:
 * - 'near': the stores within it, nearest first (a list the finder was asked for with the ZIP, but with no distances
 *   at all, in the finder's own order: nearest first, as finders list);
 * - 'none': the finder searched the ZIP, and its nearest store is beyond the radius: the retailer has none near;
 * - 'elsewhere': what was listed is beyond the radius, but the list isn't for the ZIP (the finder wasn't asked for it,
 *   or what came after it was typed is far away): its stores near the ZIP are unknown, not missing;
 * - 'unplaced': nothing says where its stores are.
 */
export type Placement =
  | { verdict: 'near'; stores: NearbyStore[] }
  | { verdict: 'none'; nearest: number }
  | { verdict: 'elsewhere'; nearest: number }
  | { verdict: 'unplaced' };

export function placeStores(stores: NearbyStore[], radius: number, tie: ZipTie): Placement {
  const measured = stores.flatMap((s) => {
    const miles = trustedMiles(s, tie);
    return miles === undefined ? [] : [{ s, miles }];
  });
  const within = measured.filter((m) => m.miles <= radius).sort((a, b) => a.miles - b.miles);
  if (within.length) return { verdict: 'near', stores: within.map((m) => m.s) };
  if (measured.length) {
    const nearest = Math.min(...measured.map((m) => m.miles));
    const forZip = tie === 'asked' || (tie === 'after' && nearest <= ELSEWHERE_MILES);
    return forZip ? { verdict: 'none', nearest } : { verdict: 'elsewhere', nearest };
  }
  if (tie === 'asked' && stores.length) return { verdict: 'near', stores };
  return { verdict: 'unplaced' };
}

/** Nearest first; stores without a distance keep the finder's order, after those with one. */
export function sortNearest(stores: NearbyStore[]): NearbyStore[] {
  return stores
    .map((s, i) => ({ s, i }))
    .sort((a, b) => (a.s.miles ?? Infinity) - (b.s.miles ?? Infinity) || a.i - b.i)
    .map(({ s }) => s);
}

/**
 * The stores within `radius` miles. `measured` is false when no store had a distance: then nothing can be told
 * about the radius, and every store is kept, in the finder's order.
 */
export function withinRadius(stores: NearbyStore[], radius: number): { stores: NearbyStore[]; measured: boolean } {
  const measured = stores.some((s) => s.miles !== undefined);
  if (!measured) return { stores, measured };
  return { stores: stores.filter((s) => s.miles !== undefined && s.miles <= radius), measured };
}
