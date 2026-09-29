import { departmentOf, placeOf } from './aisle';
import { isBarcode, krogerProductId } from './barcode';
import { StrategyError } from './fetchStrategy';
import { get, isObj, num, str } from './json';
import type { NearbyStore } from './storeLocator';
import { EVIDENCE_KEPT, rawProduct } from './parsers';
import type { KnownStore, ParseResult, Product, RawProduct } from './types';

// Kroger's official Products API: https://developer.kroger.com (register an app for a client id and secret).
// Passing a store's locationId returns that store's regular and promo prices.
//
// Kroger locks an app's keys to the environment it was registered in: production (live data), or certification,
// which Kroger provides for testing. Production is tried first; keys it refuses are tried on certification, and
// whichever took them is used from then on, with certification results saying where they came from.

const PRODUCTION = 'https://api.kroger.com/v1';
const CERTIFICATION = 'https://api-ce.kroger.com/v1';
type Environment = 'production' | 'certification';
const baseOf = (env: Environment) => (env === 'certification' ? CERTIFICATION : PRODUCTION);

/** Said with every result from Kroger's certification environment. */
export const CERTIFICATION_NOTE =
  'From Kroger’s certification environment, which Kroger provides for testing, as these are certification keys: its prices may not be the store’s own. Production keys give live prices (see the README).';
/** Enough for the top result and its Similar items; a smaller reply comes back faster. */
const RESULTS_KEPT = 20;

/**
 * Local testing only: EXPO_PUBLIC_* values are compiled into the app, so anyone with the build can read the secret.
 * In production the Stretch backend holds the credentials and calls Kroger for the app.
 */
const CLIENT_ID = process.env.EXPO_PUBLIC_KROGER_CLIENT_ID;
const CLIENT_SECRET = process.env.EXPO_PUBLIC_KROGER_CLIENT_SECRET;

export const krogerApiConfigured = (): boolean => !!CLIENT_ID && !!CLIENT_SECRET;

/** The environment that took the keys, once one has: null before the first sign-in. */
let environment: Environment | null = null;
export const krogerEnvironment = (): Environment | null => environment;

/** A signed-in session: the token, and the environment's address to ask with it. */
interface Session {
  token: string;
  base: string;
}

let cachedToken: { value: string; expiresAt: number; base: string } | null = null;

/** Kroger's answers that mean "busy, ask again shortly": its servers' or their gateway's. */
const TEMPORARY = new Set([502, 503, 504]);
/** The pause before asking again, once, after one of those. */
export const RETRY_AFTER_MS = 800;

async function getJson(url: string, init: RequestInit, timeoutMs: number, what: string, retried = false): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: controller.signal });
  } catch {
    throw new StrategyError(controller.signal.aborted ? `${what}_timeout` : `${what}_network`);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    // A temporary error is asked again once, after a moment, before it counts: the next search usually works.
    if (TEMPORARY.has(res.status) && !retried) {
      await new Promise((r) => setTimeout(r, RETRY_AFTER_MS));
      return getJson(url, init, timeoutMs, what, true);
    }
    throw new StrategyError(`${what}_http_${res.status}`);
  }
  return res.json();
}

/** Searches that start together share one token request. */
let tokenRequest: Promise<Session> | null = null;

function accessToken(timeoutMs: number): Promise<Session> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return Promise.resolve({ token: cachedToken.value, base: cachedToken.base });
  if (!tokenRequest) {
    tokenRequest = requestToken(timeoutMs).finally(() => {
      tokenRequest = null;
    });
  }
  return tokenRequest;
}

async function requestToken(timeoutMs: number): Promise<Session> {
  // Where the keys worked before; else production, then certification.
  const order: Environment[] = environment ? [environment] : ['production', 'certification'];
  let refused: unknown = null;
  for (const env of order) {
    let json: unknown;
    try {
      json = await getJson(
        `${baseOf(env)}/connect/oauth2/token`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Authorization: `Basic ${btoa(`${CLIENT_ID}:${CLIENT_SECRET}`)}`,
          },
          body: 'grant_type=client_credentials&scope=product.compact',
        },
        timeoutMs,
        'kroger_auth',
      );
    } catch (e) {
      // Only keys refused mean they may be the other environment's; a network problem is the same in both.
      if (!(e instanceof StrategyError) || !/^kroger_auth_http_40[01]$/.test(e.reason)) throw e;
      refused ??= e;
      continue;
    }
    const value = str(get(json, 'access_token'));
    if (!value) throw new StrategyError('kroger_auth_no_token');
    environment = env;
    cachedToken = { value, expiresAt: Date.now() + (num(get(json, 'expires_in')) ?? 1800) * 1000, base: baseOf(env) };
    return { token: value, base: cachedToken.base };
  }
  // Refused everywhere: what production said.
  throw refused;
}

/** Forgets the sign-in, the environment and the stores looked up, as a fresh start of the app would. For tests. */
export function resetKrogerApi(): void {
  environment = null;
  cachedToken = null;
  tokenRequest = null;
  nearestStore.clear();
}

/**
 * Signs in and looks up the store ahead of the first search: both are kept for the session, so the first prices come
 * a round trip or two sooner. Nothing is searched. A failure is left for the first search, which says why.
 */
export async function warmUpKroger(storeInput: string, timeoutMs: number, chain?: string[]): Promise<void> {
  if (!krogerApiConfigured()) return;
  try {
    const session = await accessToken(timeoutMs);
    if (/^\d{5}$/.test(storeInput.trim())) await resolveStore(storeInput, session, timeoutMs, chain);
  } catch {
    // The first search tries again.
  }
}

/** A Kroger store: its locationId, and its name and address when the Locations API gave them. */
interface KrogerStore {
  locationId: string;
  name?: string;
  address?: string;
}

/** The nearest store to each ZIP (and chain), looked up once per app session rather than once per search. */
const nearestStore = new Map<string, Promise<KrogerStore>>();

const letters = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');

/**
 * A location of one of the chains in `chain` (Kroger runs Ralphs, Fred Meyer and more from the same API): by the
 * chain code the Locations API gives, or the start of its name. No chain: any location.
 */
export function isChain(location: unknown, chain?: string[]): boolean {
  if (!chain?.length) return true;
  const code = letters(str(get(location, 'chain')) ?? '');
  const name = letters(str(get(location, 'name')) ?? '');
  return chain.some((c) => {
    const want = letters(c);
    return !!want && (code === want || name.startsWith(want));
  });
}

/** A 5-digit ZIP picks the nearest store (of the chain); anything else is taken as a Kroger locationId. */
async function resolveStore(input: string, session: Session, timeoutMs: number, chain?: string[]): Promise<KrogerStore> {
  const value = input.trim();
  if (!value) throw new StrategyError('kroger_needs_zip_or_location_id');
  if (!/^\d{5}$/.test(value)) return { locationId: value };
  const key = `${value}|${(chain ?? []).join(',')}`;
  const known = nearestStore.get(key);
  if (known) return known;
  const lookup = lookUpNearest(value, session, timeoutMs, chain);
  nearestStore.set(key, lookup);
  // A failed lookup shouldn't stick.
  lookup.catch(() => nearestStore.delete(key));
  return lookup;
}

async function lookUpNearest(value: string, session: Session, timeoutMs: number, chain?: string[]): Promise<KrogerStore> {
  const json = await getJson(
    `${session.base}/locations?filter.zipCode.near=${value}&filter.limit=${chain?.length ? 50 : 1}`,
    { headers: { Accept: 'application/json', Authorization: `Bearer ${session.token}` } },
    timeoutMs,
    'kroger_locations',
  );
  const all = get(json, 'data');
  const store = Array.isArray(all) ? all.find((l) => isChain(l, chain)) : undefined;
  const locationId = str(get(store, 'locationId'));
  if (!locationId) throw new StrategyError('kroger_no_store_near_zip');
  const street = str(get(store, 'address', 'addressLine1'));
  const city = str(get(store, 'address', 'city'));
  const state = str(get(store, 'address', 'state'));
  const zip = str(get(store, 'address', 'zipCode'));
  const place = [city, [state, zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  return { locationId, name: str(get(store, 'name')) ?? 'Kroger', address: [street, place].filter(Boolean).join(', ') || undefined };
}

/**
 * Kroger stores (of `chain`, when given) within `radiusMiles` of a ZIP code, nearest first, from the official
 * Locations API: each with its locationId, name, address and place on the map.
 */
export async function krogerStoresNear(zip: string, radiusMiles: number, timeoutMs: number, chain?: string[]): Promise<NearbyStore[]> {
  if (!krogerApiConfigured()) throw new StrategyError('api_not_configured');
  const session = await accessToken(timeoutMs);
  const radius = Math.max(1, Math.min(100, Math.round(radiusMiles)));
  // Every chain's stores come back together: enough of them for one chain's nearest dozen.
  const json = await getJson(
    `${session.base}/locations?filter.zipCode.near=${encodeURIComponent(zip)}&filter.radiusInMiles=${radius}&filter.limit=${chain?.length ? 50 : 12}`,
    { headers: { Accept: 'application/json', Authorization: `Bearer ${session.token}` } },
    timeoutMs,
    'kroger_locations',
  );
  const data = get(json, 'data');
  if (!Array.isArray(data)) return [];
  return data.flatMap((store): NearbyStore[] => {
    const id = str(get(store, 'locationId'));
    if (!id || !isChain(store, chain)) return [];
    const street = str(get(store, 'address', 'addressLine1'));
    const city = str(get(store, 'address', 'city'));
    const place = [city, [str(get(store, 'address', 'state')), str(get(store, 'address', 'zipCode'))].filter(Boolean).join(' ')].filter(Boolean).join(', ');
    const lat = num(get(store, 'geolocation', 'latitude'));
    const lng = num(get(store, 'geolocation', 'longitude'));
    const address = [street, place].filter(Boolean).join(', ');
    return [
      {
        id,
        name: str(get(store, 'name')) ?? 'Kroger',
        ...(address ? { address } : {}),
        ...(lat !== undefined && lng !== undefined ? { lat, lng } : {}),
      },
    ];
  });
}

/**
 * Maps a /v1/products response, for Kroger or a chain it runs (`retailerId`, its site's `host`). A promo price below
 * the regular one is the price with the store's card: the member price.
 */
export function krogerProducts(json: unknown, storeId: string, retailerId = 'kroger', host = 'www.kroger.com'): Product[] {
  const data = get(json, 'data');
  if (!Array.isArray(data)) return [];
  const products: Product[] = [];
  for (const p of data) {
    if (!isObj(p)) continue;
    const id = str(p.productId) ?? str(p.upc);
    const description = str(p.description);
    if (!id || !description) continue;

    const item = get(p, 'items', 0);
    const regular = num(get(item, 'price', 'regular'));
    const promo = num(get(item, 'price', 'promo'));
    const onPromo = promo !== undefined && promo > 0 && (regular === undefined || promo < regular);
    const size = str(get(item, 'size'));
    const stock = str(get(item, 'inventory', 'stockLevel'));

    const images = Array.isArray(p.images) ? p.images.filter(isObj) : [];
    const image = images.find((i) => i.default === true || i.perspective === 'front') ?? images[0];
    const sizes = Array.isArray(image?.sizes) ? image.sizes.filter(isObj) : [];
    const imageUrl = str((sizes.find((s) => s.size === 'medium') ?? sizes[0])?.url);
    const page = str(p.productPageURI);
    const upc = str(p.upc) ?? (/^\d{12,14}$/.test(id) ? id : undefined);
    // Where it is in the store asked for (filter.locationId, which Kroger needs to give it): the first of its places
    // with an aisle ("AISLE 13"), else the department its place names ("DAIRY", whose number, 100, is a code, not an
    // aisle), else its first category, which is the website's rather than the store's.
    const place = placeOf(p.aisleLocations, 'aisleLocations');
    const department = place?.department ?? departmentOf(p.categories);

    products.push({
      retailer: retailerId,
      storeId,
      id,
      name: size ? `${description}, ${size}` : description,
      price: regular ?? promo ?? null,
      ...(onPromo && regular !== undefined ? { memberPrice: promo, memberLabel: 'with Card' } : {}),
      imageUrl,
      url: page ? `https://${host}${page.split('?')[0]}` : undefined,
      inStock: stock ? stock !== 'TEMPORARILY_OUT_OF_STOCK' : undefined,
      gtin: upc,
      ...(place?.aisle ? { aisle: place.aisle } : {}),
      ...(department ? { department } : {}),
    });
  }
  return products;
}

/** Each product's own data in a /v1/products response, for the price X-ray: the regular price is the price. */
export function krogerEvidence(json: unknown): Record<string, RawProduct> {
  const data = get(json, 'data');
  const out: Record<string, RawProduct> = {};
  if (!Array.isArray(data)) return out;
  for (const p of data.slice(0, EVIDENCE_KEPT)) {
    const id = isObj(p) ? (str(p.productId) ?? str(p.upc)) : undefined;
    if (id) out[id] = rawProduct(p, ['items', '0', 'price', 'regular']);
  }
  return out;
}

/**
 * Searches Kroger's API for `query` at the store for `storeInput`. A barcode is looked up as the product it is
 * (Kroger's productId is the barcode without its check digit), then searched as text if that finds nothing.
 */
export async function searchKrogerApi(
  query: string,
  storeInput: string,
  timeoutMs: number,
  chainOf: { retailerId?: string; host?: string; chain?: string[] } = {},
): Promise<ParseResult & { store: KnownStore; bytes: number; request: { method: string; url: string }; note?: string }> {
  if (!krogerApiConfigured()) throw new StrategyError('api_not_configured');
  const session = await accessToken(timeoutMs);
  const store = await resolveStore(storeInput, session, timeoutMs, chainOf.chain);
  const at = `&filter.locationId=${encodeURIComponent(store.locationId)}`;
  const init = { headers: { Accept: 'application/json', Authorization: `Bearer ${session.token}` } };
  const term = `${session.base}/products?filter.term=${encodeURIComponent(query.trim())}${at}&filter.limit=${RESULTS_KEPT}`;
  let bytes = 0;
  let evidence: Record<string, RawProduct> = {};
  let asked = term;
  const load = async (url: string) => {
    const json = await getJson(url, init, timeoutMs, 'kroger_products');
    bytes += JSON.stringify(json ?? null).length;
    evidence = krogerEvidence(json);
    asked = url;
    return krogerProducts(json, store.locationId, chainOf.retailerId, chainOf.host);
  };
  let products = isBarcode(query) ? await load(`${session.base}/products?filter.productId=${krogerProductId(query)}${at}`) : [];
  if (!products.length) products = await load(term);
  return {
    payloadFound: true,
    products,
    source: `Kroger Products API (${products.length})`,
    store: { name: store.name, address: store.address, id: store.locationId },
    bytes,
    evidence,
    request: { method: 'GET', url: asked },
    ...(session.base === CERTIFICATION ? { note: CERTIFICATION_NOTE } : {}),
  };
}
