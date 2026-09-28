import { storeFromFinder } from './storeIdentity';
import type { PagePayload } from './types';

// Pure functions only, so the tests run them in Node.
//
// Stores near a ZIP code, read from a retailer's own store finder: the list of stores its page gets (JSON it
// fetched, or its page data), whatever the retailer calls the fields, the way autoDetect reads products. Failing
// that, the store cards on the page. Distances come from the finder, or from coordinates.

/** A store near the user, as the retailer's store finder lists it. */
export interface NearbyStore {
  /** The retailer's number for it. */
  id: string;
  name: string;
  /** Street, city, state and ZIP, as far as listed. */
  address?: string;
  /** Miles away: from the finder, or worked out from coordinates. */
  miles?: number;
  lat?: number;
  lng?: number;
}

export interface LatLng {
  lat: number;
  lng: number;
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

/**
 * The stores a store finder page listed: from the data it got (responses it fetched, its page data), else its
 * store cards. Each once, nearest first, with miles from `origin` where the finder didn't say.
 */
export function nearbyStores(payload: PagePayload & { cards?: StoreCard[] }, origin?: LatLng): NearbyStore[] {
  const texts = [payload.nextDataText, ...(payload.sources ?? []).map((s) => s.text)].filter((t): t is string => !!t);
  let stores: NearbyStore[] = [];
  for (const t of texts) {
    let json: unknown;
    try {
      json = JSON.parse(t);
    } catch {
      continue;
    }
    const found = bestList(json).stores;
    if (found.length > stores.length) stores = found;
  }
  if (!stores.length) {
    for (const card of payload.cards ?? []) {
      const s = storeFromFinder({ label: card.lines[0], lines: card.lines, links: card.href ? [card.href] : [] });
      // Only a number with a unit is a distance: "1.8 mi", not the 21 of "21 Flushing Ave".
      const unit = card.lines.map((l) => /(\d+(?:\.\d+)?)\s*(mi|miles?|km)\b/i.exec(l)).find(Boolean);
      const miles = unit ? milesFrom(`${unit[1]} ${unit[2]}`) : undefined;
      if (s?.id) stores.push({ id: s.id, name: s.name ?? `Store ${s.id}`, ...(s.address ? { address: s.address } : {}), ...(miles !== undefined ? { miles } : {}) });
    }
  }
  const seen = new Set<string>();
  const out = stores.filter((s) => !seen.has(s.id) && seen.add(s.id)).map((s) => withMiles(s, origin));
  return sortNearest(out);
}

/** Miles from `origin` for a store the finder placed on the map but didn't measure. */
export function withMiles(s: NearbyStore, origin?: LatLng): NearbyStore {
  if (s.miles !== undefined || !origin || s.lat === undefined || s.lng === undefined) return s;
  return { ...s, miles: Math.round(milesBetween(origin, { lat: s.lat, lng: s.lng }) * 10) / 10 };
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
