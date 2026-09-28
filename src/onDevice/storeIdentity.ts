import type { CapturedRequest, KnownStore } from './types';

// Pure functions only, so the tests run them in Node.
//
// Which store a retailer's prices are for. A search asks for them with the store's number, in the request's URL, its
// body or a header; a store finder lists the store next to the button the app pressed; a site's header names the
// store it's set to. All of it stays on the phone.

/** Request fields that name the store, best first: the store the prices are for beats a list of nearby ones. */
const STORE_FIELDS: RegExp[] = [
  /^pricing_?store_?id$/,
  /^(?:selected|preferred|current|my|home|fulfillment|pickup|default)_?store_?(?:id|number|num|no|code)?$/,
  /^store_?(?:id|number|num|no|nbr|code)$/,
  /^(?:filter\.)?location_?id$/,
  /^shop_?id$/,
  /^(?:warehouse|club)_?(?:id|number|num|no)?$/,
  /^store$/,
  /^store_?ids$/,
];

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** "x-Store-Id" and "storeId" alike: "store_id", "storeid". */
const fieldKey = (name: string) => name.trim().toLowerCase().replace(/^x-/, '').replace(/-/g, '_');

/** A store number: letters and digits, with a digit, not all zeros ("3081", "01400943", "T-1340"). */
function storeValue(raw: unknown): string | undefined {
  const value = typeof raw === 'number' && Number.isInteger(raw) ? String(raw) : typeof raw === 'string' ? raw.trim() : '';
  if (!/^[A-Za-z0-9-]{1,16}$/.test(value) || !/\d/.test(value) || /^[0-]+$/.test(value)) return undefined;
  return value;
}

function queryPairs(url: string): [string, string][] {
  const q = url.indexOf('?');
  if (q === -1) return [];
  return url
    .slice(q + 1)
    .split('#')[0]
    .split('&')
    .flatMap((pair): [string, string][] => {
      const at = pair.indexOf('=');
      if (at <= 0) return [];
      try {
        return [[decodeURIComponent(pair.slice(0, at).replace(/\+/g, ' ')), decodeURIComponent(pair.slice(at + 1).replace(/\+/g, ' '))]];
      } catch {
        return [];
      }
    });
}

/** Where a request names its store: the field, and in which part of the request (and URL param, for JSON in one). */
interface StoreField {
  id: string;
  key: string;
  where: 'URL' | 'body' | 'header';
  /** For JSON inside a URL param (GraphQL variables over GET): that param. */
  param?: string;
  rank: number;
}

function findStoreField(req: Pick<CapturedRequest, 'url' | 'body' | 'headers'>): StoreField | undefined {
  let best: StoreField | undefined;
  const consider = (name: string, raw: unknown, where: StoreField['where'], param?: string) => {
    const key = fieldKey(name);
    const rank = STORE_FIELDS.findIndex((re) => re.test(key));
    if (rank === -1 || (best && best.rank <= rank)) return;
    // A list of nearby stores ("store_ids=1340,1920"): the first is the closest.
    const value = storeValue(typeof raw === 'string' && /ids$/.test(key) ? raw.split(',')[0] : raw);
    if (value) best = { id: value, key: name, where, rank, ...(param ? { param } : {}) };
  };
  const walk = (node: unknown, where: StoreField['where'], depth: number, param?: string) => {
    if (depth > 6) return;
    if (Array.isArray(node)) node.slice(0, 10).forEach((v) => walk(v, where, depth + 1, param));
    else if (isObj(node)) {
      for (const [k, v] of Object.entries(node)) {
        if (typeof v === 'string' || typeof v === 'number') consider(k, v, where, param);
        else walk(v, where, depth + 1, param);
      }
    }
  };
  const json = (text: string, where: StoreField['where'], param?: string) => {
    const t = text.trim();
    if (!t.startsWith('{') && !t.startsWith('[')) return false;
    try {
      walk(JSON.parse(t), where, 0, param);
    } catch {
      // Not JSON after all.
    }
    return true;
  };
  for (const [k, v] of queryPairs(req.url)) {
    // GraphQL over GET: "variables" is JSON in the URL.
    if (!json(v, 'URL', k)) consider(k, v, 'URL');
  }
  const body = req.body?.trim();
  if (body && !json(body, 'body') && body.includes('=')) for (const [k, v] of queryPairs(`?${body}`)) consider(k, v, 'body');
  for (const [k, v] of Object.entries(req.headers ?? {})) consider(k, v, 'header');
  return best;
}

/**
 * The store a search request asks prices for, from its URL, its body (JSON, GraphQL variables, a form) or a header:
 * `pricing_store_id=3285`, `filter.locationId=01400943`, `{"variables":{"storeId":"1234"}}`, `x-store-id: 88`.
 */
export function storeIdFromRequest(req: Pick<CapturedRequest, 'url' | 'body' | 'headers'> | undefined): { id: string; field: string } | undefined {
  const f = req ? findStoreField(req) : undefined;
  return f && { id: f.id, field: `${f.key} in the request ${f.where}` };
}

/**
 * The store a page's own data is for, when the products were in the page rather than in a request. Walmart's page data
 * carries it under its page metadata (`location.storeId`, next to the ZIP; seen on a phone, 2026-09-27). The best-ranked
 * store field in the data, by the value it holds most often; nothing unless one value has most of them, since a page
 * can hold other stores' numbers too (nearby stores, say).
 */
export function storeIdFromPageData(text: string | undefined): { id: string; field: string } | undefined {
  const t = text?.trim();
  if (!t || !(t.startsWith('{') || t.startsWith('['))) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(t);
  } catch {
    return undefined;
  }
  // By rank, then by value: how many fields held it, and the first key that did.
  const counts = new Map<number, Map<string, { n: number; key: string }>>();
  let budget = 200_000;
  const walk = (node: unknown, depth: number) => {
    if (budget-- <= 0 || depth > 40) return;
    if (Array.isArray(node)) {
      node.slice(0, 50).forEach((v) => walk(v, depth + 1));
      return;
    }
    if (!isObj(node)) return;
    for (const [k, v] of Object.entries(node)) {
      if (typeof v !== 'string' && typeof v !== 'number') {
        walk(v, depth + 1);
        continue;
      }
      const rank = STORE_FIELDS.findIndex((re) => re.test(fieldKey(k)));
      const value = rank === -1 ? undefined : storeValue(v);
      if (!value) continue;
      const byValue = counts.get(rank) ?? new Map<string, { n: number; key: string }>();
      const had = byValue.get(value) ?? { n: 0, key: k };
      had.n += 1;
      byValue.set(value, had);
      counts.set(rank, byValue);
    }
  };
  walk(json, 0);
  const best = [...counts.keys()].sort((a, b) => a - b)[0];
  if (best === undefined) return undefined;
  const values = [...counts.get(best)!.entries()].sort((a, b) => b[1].n - a[1].n);
  const total = values.reduce((sum, [, v]) => sum + v.n, 0);
  const [id, top] = values[0];
  return top.n * 2 > total ? { id, field: `${top.key} in the page data` } : undefined;
}

/** `value` with `from` swapped for `to`: the whole of it, or the first of a list ("1340,1920"). */
function swapped(value: string, from: string, to: string): string {
  if (value === from) return to;
  const parts = value.split(',');
  return parts[0].trim() === from ? [to, ...parts.slice(1)].join(',') : value;
}

/** Every field named `key` holding `from` in a JSON value, set to `to` (a number where it was one). */
function swapDeep(node: unknown, key: string, from: string, to: string): unknown {
  if (Array.isArray(node)) return node.map((v) => swapDeep(v, key, from, to));
  if (!isObj(node)) return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === key && (typeof v === 'string' || typeof v === 'number') && swapped(String(v), from, to) !== String(v)) {
      out[k] = typeof v === 'number' && /^\d+$/.test(to) ? Number(to) : swapped(String(v), from, to);
    } else out[k] = swapDeep(v, key, from, to);
  }
  return out;
}

function swapPairs(query: string, key: string, from: string, to: string, jsonParam?: string): string {
  return query
    .split('&')
    .map((pair) => {
      const at = pair.indexOf('=');
      if (at <= 0) return pair;
      let name: string;
      let value: string;
      try {
        name = decodeURIComponent(pair.slice(0, at).replace(/\+/g, ' '));
        value = decodeURIComponent(pair.slice(at + 1).replace(/\+/g, ' '));
      } catch {
        return pair;
      }
      if (jsonParam !== undefined) {
        if (name !== jsonParam) return pair;
        try {
          return `${pair.slice(0, at)}=${encodeURIComponent(JSON.stringify(swapDeep(JSON.parse(value), key, from, to)))}`;
        } catch {
          return pair;
        }
      }
      return name === key ? `${pair.slice(0, at)}=${encodeURIComponent(swapped(value, from, to))}` : pair;
    })
    .join('&');
}

/**
 * The same request, asking for `storeId`'s prices: its store field (as storeIdFromRequest finds it) set to that
 * store. `pinned` is false when the request names no store, so it can't be pointed at one.
 */
export function pinStoreInRequest<T extends { url: string; body?: string; headers?: Record<string, string> }>(req: T, storeId: string): { request: T; pinned: boolean } {
  const f = findStoreField(req);
  if (!f) return { request: req, pinned: false };
  if (sameStoreId(f.id, storeId)) return { request: req, pinned: true };
  if (f.where === 'header') return { request: { ...req, headers: { ...req.headers, [f.key]: storeId } }, pinned: true };
  if (f.where === 'body') {
    const body = req.body ?? '';
    const t = body.trim();
    if (t.startsWith('{') || t.startsWith('[')) {
      try {
        return { request: { ...req, body: JSON.stringify(swapDeep(JSON.parse(t), f.key, f.id, storeId)) }, pinned: true };
      } catch {
        return { request: req, pinned: false };
      }
    }
    return { request: { ...req, body: swapPairs(body, f.key, f.id, storeId) }, pinned: true };
  }
  const q = req.url.indexOf('?');
  const hash = req.url.indexOf('#', q);
  const query = req.url.slice(q + 1, hash === -1 ? undefined : hash);
  const url = `${req.url.slice(0, q + 1)}${swapPairs(query, f.key, f.id, storeId, f.param)}${hash === -1 ? '' : req.url.slice(hash)}`;
  return { request: { ...req, url }, pinned: true };
}

/** A street address: a number, up to a few words, and a street type ("400 Park Pl", "8915 Gerber Rd."). */
const STREET =
  /\b\d{1,6}[A-Za-z]?\s+(?:[A-Za-z0-9.'#-]+\s+){0,5}?(?:St|Street|Ave|Avenue|Rd|Road|Blvd|Boulevard|Dr|Drive|Hwy|Highway|Pkwy|Parkway|Ln|Lane|Way|Pl|Place|Ct|Court|Cir|Circle|Sq|Square|Tpke|Turnpike|Pike|Plaza|Plz|Ter|Terrace|Trl|Trail|Loop|Row|Expy|Expressway|Fwy|Freeway|Ctr|Center|Mall|Broadway|Commons|Crossing)\b\.?(?:\s*(?:#|Ste\.?|Suite|Unit)\s*[A-Za-z0-9-]+)?/i;
/** "Secaucus, NJ 07094", "Sacramento, CA". */
const CITY = /^[A-Za-z .'-]{2,40},\s*[A-Z]{2}(?:\s+\d{5}(?:-\d{4})?)?$/;
const CITY_AFTER = /^,?\s*[A-Za-z .'-]{2,40},\s*[A-Z]{2}(?:\s+\d{5}(?:-\d{4})?)?/;
/** What comes before a store's name in a site's header: "Your store:", "Shopping at", "My Warehouse". */
const LEAD =
  /^(?:(?:my|your|selected|preferred|current|home)\s+(?:store|warehouse|club|location)|shopping\s+(?:at|in)|pick\s?up\s+(?:at|from)|picking\s+up\s+at|store|warehouse|location)\s*[:\-–—|·]?\s*/i;
/** What comes after it: opening hours, a distance, a "Change" link. */
const TAIL =
  /\s*(?:[·|•]|\bopens?\s+(?:until|at|now|today|24)\b|\bclose[sd]?\b|\bclosing\b|\bchange(?:\s+store)?\s*$|\bstore details\b|\bget directions\b|\b\d+(?:\.\d+)?\s*(?:mi|miles|km)\b).*$/i;
/** Buttons and links, not a store's name. */
const NOT_A_NAME = /^(?:find|choose|select|change|set|pick|see|view|browse|search|locate|update|shop|enter|add|sign)\b|\bstore (?:locator|finder|hours|directory)\b|\bnear (?:you|me)\b/i;
const STORE_NUMBER = /(?:#\s?|\bstore\s*(?:#|no\.?|number)?\s*)(\d{2,6})\b/i;

const clip = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, max).replace(/\s+\S*$/, '')}…`);
const trimSeparators = (s: string) => s.replace(/^[\s,:;|·•\-–—]+|[\s,:;|·•\-–—]+$/g, '');

/**
 * A store as a site's header or store finder writes it, in parts: "Your store: Brooklyn Atlantic Terminal · Open
 * until 10pm" is Brooklyn Atlantic Terminal; "Secaucus Supercenter #3520 400 Park Pl, Secaucus, NJ 07094" has a name,
 * a number and an address. Undefined when it names no store ("Find a store").
 */
export function parseStoreLabel(raw: string | undefined): KnownStore | undefined {
  let s = String(raw ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  // The number first, so "Store 1340" keeps it.
  let id: string | undefined;
  const number = STORE_NUMBER.exec(s);
  if (number) {
    id = number[1];
    s = `${s.slice(0, number.index)} ${s.slice(number.index + number[0].length)}`.replace(/\s+/g, ' ').trim();
  }
  s = s.replace(LEAD, '');
  let address: string | undefined;
  const street = STREET.exec(s);
  if (street) {
    const rest = s.slice(street.index + street[0].length);
    const city = CITY_AFTER.exec(rest);
    address = trimSeparators(street[0] + (city ? city[0] : ''));
    s = s.slice(0, street.index);
  }
  s = trimSeparators(s.replace(TAIL, ''));
  const name = s && !NOT_A_NAME.test(s) && /[A-Za-z]/.test(s) ? clip(s, 60) : undefined;
  if (!name && !address && !id) return undefined;
  return { ...(name ? { name } : {}), ...(address ? { address: clip(address, 100) } : {}), ...(id ? { id } : {}) };
}

/** A store's own page linked from a store finder: "/store/3081-sacramento-ca", "/sl/brooklyn-atlantic-terminal/1340". */
const LINK_IDS = [
  /\/(?:stores?|sl|locations?|warehouses?|clubs?)\/(\d{2,7})(?=[-/?#]|$)/i,
  // Meijer's: "/shopping/store-locator/20.html".
  /\/store-locator\/(\d{1,7})\.html/i,
  /\/(?:stores?|sl|locations?|warehouses?|clubs?)\/[^?#]*?\/(\d{2,7})\/?(?=[?#]|$)/i,
  /[?&](?:store_?id|store_?number|storenum|location_?id|warehouse(?:_?id)?)=(\d{2,9})/i,
];

/** The store number in a link to a store's own page, if it is one. Never the ZIP code the page was searched for. */
export function storeIdFromLink(href: string | undefined, zip = ''): string | undefined {
  for (const re of LINK_IDS) {
    const m = re.exec(href ?? '');
    if (m && m[1] !== zip) return m[1];
  }
  return undefined;
}

/**
 * The store the app pressed "make this my store" for, from what storeScript saw around the button: its heading, the
 * lines of its listing (the address among them) and links to the store's own page (its number).
 */
export function storeFromFinder(result: unknown, zip = ''): KnownStore | undefined {
  if (!isObj(result)) return undefined;
  const name = typeof result.label === 'string' ? parseStoreLabel(result.label)?.name : undefined;
  const lines = Array.isArray(result.lines) ? result.lines.filter((l): l is string => typeof l === 'string').map((l) => l.trim()) : [];
  let street: string | undefined;
  let city: string | undefined;
  for (const line of lines.slice(0, 20)) {
    if (!street && STREET.test(line) && line.length <= 100) street = line;
    else if (!city && CITY.test(line)) city = line;
  }
  const address = street && city && !street.includes(city) ? `${trimSeparators(street)}, ${city}` : (street ?? city);
  const links = Array.isArray(result.links) ? result.links.filter((l): l is string => typeof l === 'string') : [];
  const id = links.map((href) => storeIdFromLink(href, zip)).find(Boolean);
  if (!name && !address && !id) return undefined;
  return { ...(name ? { name } : {}), ...(address ? { address: trimSeparators(address) } : {}), ...(id ? { id } : {}) };
}

/** What two sources say about the same store, the first one winning where both know something. */
export function mergeStores(...stores: (KnownStore | undefined | null)[]): KnownStore | undefined {
  const out: KnownStore = {};
  for (const s of stores) {
    if (!s) continue;
    if (!out.name && s.name) out.name = s.name;
    if (!out.address && s.address) out.address = s.address;
    if (!out.id && s.id) out.id = s.id;
  }
  return out.name || out.address || out.id ? out : undefined;
}

/** The same store number, however it's written: "01400943" and "1400943", "T-1340" and "t1340". */
export function sameStoreId(a: string | undefined, b: string | undefined): boolean {
  const norm = (s: string | undefined) => (s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '').replace(/^0+/, '');
  return !!norm(a) && norm(a) === norm(b);
}

/**
 * Whether two store names name the same store, as far as names can tell: every word of the shorter is in the longer
 * ("Sacramento Supercenter" and "Sacramento Gerber Rd Supercenter"; "Kroger" and "Kroger On Vine"), false when the
 * shorter has a word the longer lacks ("Secaucus Supercenter" against "Houston Heights Supercenter"), undefined when
 * either has no words to compare.
 */
export function sameStoreName(a: string | undefined, b: string | undefined): boolean | undefined {
  const words = (s: string | undefined) =>
    new Set(
      (s ?? '')
        .toLowerCase()
        .replace(/[^a-z0-9 ]+/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length > 1),
    );
  const wa = words(a);
  const wb = words(b);
  if (!wa.size || !wb.size) return undefined;
  const [shorter, longer] = wa.size <= wb.size ? [wa, wb] : [wb, wa];
  return [...shorter].every((w) => longer.has(w));
}

/** "Sacramento Supercenter (store 3081)", "Sacramento Supercenter", or "Store 3081". */
export function storeLine(store: KnownStore | undefined): string | undefined {
  if (!store) return undefined;
  if (store.name) return store.id ? `${store.name} (store ${store.id})` : store.name;
  return store.id ? `Store ${store.id}` : store.address;
}
