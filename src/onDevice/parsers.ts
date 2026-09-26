import { get, isObj, moneyFromText, num, parseMoney, str, type Obj } from './json';
import type { PagePayload, PageSource, Parser, Product, ProductOrigin, RawProduct } from './types';

// Pure functions only: no React Native imports, so scripts/parse-capture.ts and the tests run them in Node.

export { parseMoney } from './json';

/** Text of the first <script> whose opening tag contains `marker`, or null. String search, since pages run to megabytes. */
function scriptText(html: string, marker: string, from = 0): { text: string; end: number } | null {
  const at = html.indexOf(marker, from);
  if (at === -1) return null;
  const start = html.indexOf('>', at);
  const end = start === -1 ? -1 : html.indexOf('</script>', start);
  if (end === -1) return null;
  return { text: html.slice(start + 1, end), end };
}

/** Raw JSON text of <script id="__NEXT_DATA__">, or null. */
export function extractNextDataText(html: string): string | null {
  return scriptText(html, 'id="__NEXT_DATA__"')?.text ?? null;
}

function extractLdJson(html: string): string[] {
  const out: string[] = [];
  let from = 0;
  for (let i = 0; i < 50; i++) {
    const hit = scriptText(html, 'application/ld+json', from);
    if (!hit) break;
    out.push(hit.text);
    from = hit.end;
  }
  return out;
}

/** Texts of the <script type="application/json"> blocks in a page's HTML, but Next.js's page data (read on its own). */
function extractJsonScripts(html: string): string[] {
  const marker = 'type="application/json"';
  const out: string[] = [];
  let from = 0;
  for (let i = 0; i < 50; i++) {
    const at = html.indexOf(marker, from);
    if (at === -1) break;
    const open = html.lastIndexOf('<script', at);
    const start = html.indexOf('>', at);
    // Only where the words are in a script's opening tag.
    if (open === -1 || start === -1 || html.indexOf('>', open) !== start) {
      from = at + marker.length;
      continue;
    }
    const end = html.indexOf('</script>', start);
    if (end === -1) break;
    if (!html.slice(open, start).includes('__NEXT_DATA__')) out.push(html.slice(start + 1, end));
    from = end;
  }
  return out;
}

/** The page state a store page's own scripts set, which the browser's page script reads (see collect in webviewScript.ts). */
const PAGE_STATES = ['__APOLLO_STATE__', '__PRELOADED_STATE__', '__INITIAL_STATE__', '__NUXT__'];
const isSpace = (c: string | undefined) => c === ' ' || c === '\n' || c === '\r' || c === '\t';

/** The JSON object or array that starts at `at`, as text: brackets matched outside strings. Null when it doesn't close. */
function balancedJson(text: string, at: number): string | null {
  let depth = 0;
  let inString = false;
  for (let i = at; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') {
      depth--;
      if (depth === 0) return text.slice(at, i + 1);
    }
  }
  return null;
}

/** The JSON text in `JSON.parse("…")` whose string starts at `at` (its opening quote). Null when it isn't a JSON string. */
function jsonStringAt(text: string, at: number): string | null {
  if (text[at] !== '"') return null;
  for (let i = at + 1; i < text.length; i++) {
    if (text[i] === '\\') i++;
    else if (text[i] === '"') {
      try {
        const inner: unknown = JSON.parse(text.slice(at, i + 1));
        return typeof inner === 'string' ? inner : null;
      } catch {
        return null;
      }
    }
  }
  return null;
}

/**
 * The page state a page's HTML sets as it loads (`window.__APOLLO_STATE__ = {…}`, or `= JSON.parse("…")`), which a
 * browser reads from the page itself: a plain request's HTML carries it too. Only what's written as JSON.
 */
function extractPageStates(html: string): PageSource[] {
  const out: PageSource[] = [];
  for (const name of PAGE_STATES) {
    let from = 0;
    for (let tries = 0; tries < 5; tries++) {
      const at = html.indexOf(name, from);
      if (at === -1) break;
      let i = at + name.length;
      while (isSpace(html[i])) i++;
      from = i;
      // Set here, not read or compared.
      if (html[i] !== '=' || html[i + 1] === '=') continue;
      i++;
      while (isSpace(html[i])) i++;
      let text: string | null = null;
      if (html[i] === '{' || html[i] === '[') text = balancedJson(html, i);
      else if (html.startsWith('JSON.parse(', i)) {
        i += 'JSON.parse('.length;
        while (isSpace(html[i])) i++;
        text = jsonStringAt(html, i);
      }
      if (text) {
        out.push({ label: name, text });
        break;
      }
    }
  }
  return out;
}

/** True when a bot-check marker shows up in any of the given strings. */
export function looksChallenged(markers: string[], ...haystacks: (string | undefined)[]): boolean {
  return markers.some((m) => haystacks.some((h) => h !== undefined && h.includes(m)));
}

function parseJson(text: string | undefined | null): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Depth-first walk; stops descending into objects that `visit` claims. */
function walk(node: unknown, visit: (o: Obj) => boolean, depth = 0): void {
  if (depth > 60 || typeof node !== 'object' || node === null) return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit, depth + 1);
    return;
  }
  if (visit(node as Obj)) return;
  for (const child of Object.values(node as Obj)) walk(child, visit, depth + 1);
}

/** Products whose raw data is kept for the price X-ray: the ones a basket can show. */
export const EVIDENCE_KEPT = 12;
/** A product's own data is cut at this length: enough to find the price in. */
const EVIDENCE_CHARS = 8000;

/** A product's data as the store sent it, pretty-printed, and the path to its price. */
export function rawProduct(o: unknown, pricePath: string[]): RawProduct {
  let json = '';
  try {
    json = JSON.stringify(o, null, 2) ?? '';
  } catch {
    json = '';
  }
  return { json: json.length > EVIDENCE_CHARS ? `${json.slice(0, EVIDENCE_CHARS)}\n…` : json, pricePath: pricePath.join('.') };
}

/** A regular price worth showing as "was": above the current price, and not absurdly so. */
export function saleFrom(price: number | null | undefined, was: number | undefined): number | undefined {
  if (typeof price !== 'number' || !(price > 0) || was === undefined) return undefined;
  return was > price + 0.004 && was < price * 5 ? was : undefined;
}

// ---------------------------------------------------------------------------
// Walmart: search pages embed their results as Next.js page data.
// Field paths below match Walmart's markup as publicly documented;
// confirm them against a real capture with scripts/parse-capture.ts.

function walmartProduct(o: Obj, retailer: string, storeId: string): Product | null {
  const id = str(o.usItemId);
  const name = str(o.name);
  if (!id || !name) return null;

  const priceText = str(get(o, 'priceInfo', 'currentPrice', 'priceString')) ?? str(get(o, 'priceInfo', 'linePrice'));
  const canonical = str(o.canonicalUrl);
  const availability = str(get(o, 'availabilityStatusV2', 'value')) ?? str(o.availabilityStatus);
  const price = num(get(o, 'priceInfo', 'currentPrice', 'price')) ?? num(o.price) ?? parseMoney(priceText) ?? null;
  const was = num(get(o, 'priceInfo', 'wasPrice', 'price')) ?? parseMoney(str(get(o, 'priceInfo', 'wasPrice', 'priceString')));

  return {
    retailer,
    storeId,
    id,
    name,
    price,
    wasPrice: saleFrom(price, was),
    priceText,
    unitPriceText: str(get(o, 'priceInfo', 'unitPrice', 'priceString')),
    imageUrl: str(get(o, 'imageInfo', 'thumbnailUrl')) ?? str(o.image),
    url: canonical ? (canonical.startsWith('http') ? canonical : `https://www.walmart.com${canonical}`) : undefined,
    inStock: availability ? availability === 'IN_STOCK' : undefined,
    sponsored: o.isSponsoredFlag === true ? true : undefined,
    gtin: findGtin(o),
  };
}

export const walmartNextData: Parser = (payload, { retailer, storeId }) => {
  const data = parseJson(payload.nextDataText ?? (payload.html ? extractNextDataText(payload.html) : null));
  if (!data) return { payloadFound: false, products: [] };

  const seen = new Set<string>();
  const products: Product[] = [];
  const evidence: Record<string, RawProduct> = {};
  const add = (o: Obj): boolean => {
    const p = walmartProduct(o, retailer, storeId);
    if (!p) return false;
    if (!seen.has(p.id)) {
      seen.add(p.id);
      products.push(p);
      if (products.length <= EVIDENCE_KEPT) {
        const path = num(get(o, 'priceInfo', 'currentPrice', 'price')) !== undefined ? ['priceInfo', 'currentPrice', 'price'] : ['price'];
        evidence[p.id] = rawProduct(o, path);
      }
    }
    return true;
  };

  // 1) Where search results normally live.
  const searchResult = get(data, 'props', 'pageProps', 'initialData', 'searchResult');
  const stacks = get(searchResult, 'itemStacks');
  if (Array.isArray(stacks)) {
    for (const stack of stacks) {
      const items = get(stack, 'items');
      if (Array.isArray(items)) for (const item of items) if (isObj(item)) add(item);
    }
  }
  // 2) If that path moved, take anything product-shaped in the page data.
  if (products.length === 0) walk(data, add);

  // A real "no results" page still has a searchResult; anything else means the layout changed.
  return { payloadFound: isObj(searchResult) || products.length > 0, products, source: 'next-data', origin: { kind: 'document' }, evidence };
};

// ---------------------------------------------------------------------------
// Generic: for retailers scraped with a pageScript that returns
// [{ id, name, price?, wasPrice?, priceText?, unitPriceText?, imageUrl?, url?, inStock? }].

export const pageScriptProducts: Parser = (payload, { retailer, storeId }) => {
  const list = payload.pageResult;
  if (!Array.isArray(list)) return { payloadFound: false, products: [] };

  const products: Product[] = [];
  const evidence: Record<string, RawProduct> = {};
  for (const raw of list) {
    if (!isObj(raw)) continue;
    const id = str(raw.id);
    const name = str(raw.name);
    if (!id || !name) continue;
    const priceText = str(raw.priceText);
    const price = num(raw.price) ?? parseMoney(priceText) ?? null;
    if (products.length < EVIDENCE_KEPT) evidence[id] = rawProduct(raw, [num(raw.price) !== undefined ? 'price' : 'priceText']);
    products.push({
      retailer,
      storeId,
      id,
      name,
      price,
      wasPrice: saleFrom(price, num(raw.wasPrice)),
      priceText,
      unitPriceText: str(raw.unitPriceText),
      imageUrl: str(raw.imageUrl),
      url: str(raw.url),
      inStock: typeof raw.inStock === 'boolean' ? raw.inStock : undefined,
      gtin: findGtin(raw),
    });
  }
  return { payloadFound: true, products, source: 'page script', origin: { kind: 'other' }, evidence };
};

// ---------------------------------------------------------------------------
// Auto-detect: no per-retailer code. Looks through every JSON document the page embedded or fetched
// for the largest list of product-shaped objects (a name plus a price), whatever the field names.
// It can pick the wrong list (e.g. recommendations); the test screen shows which source it used.

const NAME_KEYS = ['name', 'title', 'productName', 'product_name', 'displayName', 'display_name', 'description'];
const ID_KEYS = ['usItemId', 'tcin', 'productId', 'product_id', 'itemId', 'item_id', 'sku', 'skuId', 'sku_id', 'upc', 'gtin13', 'gtin', 'id'];
/** Keys worth looking inside for a product's name or price. */
const NEST = /^(item|items|product|productInfo|product_description|details|attributes|offers|offer|pricing|variants|skus|node|content|data|view|viewSection)$/i;
/** Keys whose names belong to something else (the brand, the store...). */
const SKIP = /brand|seller|categor|store|department|manufacturer|vendor|fulfil|promotion|badge|rating|review|breadcrumb|facet|filter/i;
const PRICE_KEY = /price|retail|amount/i;
/** Prices for members of the store's loyalty program: kept apart from the price everyone pays. */
const MEMBER_KEY = /member|club|loyal|with_?card|card_?price|prime|circle|reward/i;
/** Price-looking keys that hold something else. */
const NOT_PRICE = /(^|[a-z_])(id|Id|ID)$|retailer|count|quantity|qty|percent|rating|size|weight|limit|min|max/;
const URL_KEY = /^(url|canonicalUrl|canonical_url|productUrl|product_url|pdpUrl|buy_url|productPageURI|href|link|seoUrl)$/;
const GTIN_KEY = /^(upc|upcs|upc_?code|gtin|gtin8|gtin12|gtin13|gtin14|ean|ean13|barcode|primary_?barcode)$/i;
const IMAGE_KEY = /image|thumbnail|img|photo|picture|media/i;

interface PriceHit {
  value: number;
  text?: string;
  score: number;
  depth: number;
  /** Keys from the product down to the price. */
  path: string[];
}

/** Most specific signal on the key path wins: unit price < regular/was < plain < current/sale. */
function pathScore(keys: string[]): number {
  const path = keys.join('.');
  if (/unit|per_?unit|perunit|per_?oz|per_?lb/i.test(path)) return -1;
  if (/(^|[._])reg|regular|list|was|original|base|compare|msrp|strike|old|full_?price/i.test(path)) return 1;
  if (/current|sale|promo|final|offer|now|selling|actual|reduced/i.test(path)) return 3;
  return 2;
}

function collectPrices(o: Obj, keys: string[], hits: PriceHit[], unit: string[], member: PriceHit[] = []): void {
  if (keys.length > 4) return;
  for (const [k, v] of Object.entries(o)) {
    if (NOT_PRICE.test(k)) continue;
    const path = [...keys, k];
    const priceish = PRICE_KEY.test(k) || keys.some((p) => PRICE_KEY.test(p));
    const into = MEMBER_KEY.test(path.join('.')) ? member : hits;
    if (typeof v === 'number' && priceish) {
      const value = /cents/i.test(k) ? v / 100 : v;
      if (value > 0 && value < 10000) into.push({ value, score: pathScore(path), depth: path.length, path });
    } else if (typeof v === 'string' && priceish) {
      const value = moneyFromText(v) ?? (/^\d{1,5}(\.\d{1,2})?$/.test(v) ? Number(v) : undefined);
      const score = pathScore(path);
      if (score === -1 && /[$¢]/.test(v)) unit.push(v);
      else if (value !== undefined && value > 0) into.push({ value, text: v.includes('$') ? v : undefined, score, depth: path.length, path });
    } else if (priceish || NEST.test(k)) {
      const child = Array.isArray(v) ? v[0] : v;
      if (isObj(child) && !SKIP.test(k)) collectPrices(child, path, hits, unit, member);
    }
  }
}

/** What a store calls its member price, from the field it's in. */
function memberLabelOf(path: string[]): string {
  const p = path.join('.');
  if (/club/i.test(p)) return 'Club Price';
  if (/card/i.test(p)) return 'with Card';
  if (/prime/i.test(p)) return 'Prime member deal';
  if (/circle/i.test(p)) return 'Circle price';
  if (/reward/i.test(p)) return 'rewards price';
  return 'member price';
}

function findName(o: Obj, depth = 0): string | undefined {
  for (const k of NAME_KEYS) {
    const v = o[k];
    if (typeof v !== 'string') continue;
    const s = v.trim();
    if (s.length >= 2 && s.length <= (k === 'description' ? 160 : 250) && !/^https?:/.test(s)) return s;
  }
  if (depth >= 3) return undefined;
  for (const [k, v] of Object.entries(o)) {
    if (SKIP.test(k) || !NEST.test(k)) continue;
    const child = Array.isArray(v) ? v[0] : v;
    if (isObj(child)) {
      const n = findName(child, depth + 1);
      if (n) return n;
    }
  }
  return undefined;
}

function findId(o: Obj): string | undefined {
  for (const k of ID_KEYS) {
    const v = o[k];
    if ((typeof v === 'string' && v) || typeof v === 'number') return String(v);
  }
  for (const [k, v] of Object.entries(o)) {
    if (!NEST.test(k) || !isObj(v)) continue;
    for (const key of ID_KEYS) {
      const inner = v[key];
      if ((typeof inner === 'string' && inner) || typeof inner === 'number') return String(inner);
    }
  }
  return undefined;
}

function findImage(v: unknown, depth = 0): string | undefined {
  if (typeof v === 'string') return /^https?:\/\//.test(v) ? v : v.startsWith('//') ? `https:${v}` : undefined;
  if (depth > 3) return undefined;
  if (Array.isArray(v)) return findImage(v[0], depth + 1);
  if (!isObj(v)) return undefined;
  for (const k of ['url', 'src', 'href']) {
    const hit = depth > 0 ? findImage(v[k], depth + 1) : undefined;
    if (hit) return hit;
  }
  for (const [k, child] of Object.entries(v)) {
    if (IMAGE_KEY.test(k) || (depth > 0 && /sizes|urls/i.test(k))) {
      const hit = findImage(child, depth + 1);
      if (hit) return hit;
    }
  }
  return undefined;
}

/** A barcode under a key that says so (upc, gtin13, primary_barcode...), on the object or one level in. */
export function findGtin(o: Obj, depth = 0): string | undefined {
  for (const [k, v] of Object.entries(o)) {
    if (!GTIN_KEY.test(k)) continue;
    const raw = typeof v === 'string' ? v : typeof v === 'number' ? String(v) : Array.isArray(v) && typeof v[0] === 'string' ? v[0] : undefined;
    if (raw && /^\d{8,14}$/.test(raw.trim())) return raw.trim();
  }
  if (depth >= 2) return undefined;
  for (const [k, v] of Object.entries(o)) {
    if (!NEST.test(k) || !isObj(v)) continue;
    const hit = findGtin(v, depth + 1);
    if (hit) return hit;
  }
  return undefined;
}

function findStock(o: Obj): boolean | undefined {
  for (const [k, v] of Object.entries(o)) {
    if (typeof v === 'boolean' && /^(inStock|in_stock|available|isAvailable|is_available)$/.test(k)) return v;
    if (typeof v === 'string' && /availab|stock/i.test(k)) {
      if (/out.?of.?stock|unavailable|temporarily/i.test(v)) return false;
      if (/in.?stock|available|high|low/i.test(v)) return true;
    }
  }
  return undefined;
}

function originOf(href: string | undefined): string {
  return (href && /^https?:\/\/[^/?#]+/i.exec(href)?.[0]) || '';
}

/** A product-shaped object as a product, and the path to the price it was given. */
function toProduct(o: Obj, ctx: { retailer: string; storeId: string; origin: string }): { product: Product; pricePath: string[] } | null {
  const name = findName(o);
  if (!name) return null;
  const hits: PriceHit[] = [];
  const unit: string[] = [];
  const member: PriceHit[] = [];
  collectPrices(o, [], hits, unit, member);
  const best = hits
    .filter((h) => h.score >= 0)
    .sort((a, b) => b.score - a.score || a.depth - b.depth || (b.text ? 1 : 0) - (a.text ? 1 : 0))[0];
  if (!best) return null;
  // A regular or "was" price above the one charged: the product is on sale. The nearest one to the product wins.
  const was = hits.filter((h) => h.score === 1 && saleFrom(best.value, h.value) !== undefined).sort((a, b) => a.depth - b.depth)[0];
  // A member price below what everyone pays, and not absurdly so.
  const deal = member.filter((h) => h.score >= 0 && h.value < best.value - 0.004 && h.value > best.value * 0.3).sort((a, b) => a.value - b.value)[0];

  const link = Object.entries(o).find(([k, v]) => URL_KEY.test(k) && typeof v === 'string')?.[1] as string | undefined;
  const product: Product = {
    retailer: ctx.retailer,
    storeId: ctx.storeId,
    id: findId(o) ?? `name:${name}`,
    name,
    price: best.value,
    wasPrice: was?.value,
    ...(deal ? { memberPrice: deal.value, memberLabel: memberLabelOf(deal.path) } : {}),
    priceText: best.text,
    unitPriceText: unit[0],
    imageUrl: findImage(o),
    url: link ? (link.startsWith('/') && ctx.origin ? ctx.origin + link : link) : undefined,
    inStock: findStock(o),
    sponsored: Object.entries(o).some(([k, v]) => v === true && /sponsor|isAd$|advert/i.test(k)) || undefined,
    gtin: findGtin(o),
  };
  return { product, pricePath: best.path };
}

interface Candidate {
  label: string;
  objs: Obj[];
}

/** Arrays of objects, plus big id-keyed maps (normalized caches like Apollo's). */
function candidateLists(root: unknown, label: string, out: Candidate[], depth = 0): void {
  if (depth > 40 || typeof root !== 'object' || root === null) return;
  if (Array.isArray(root)) {
    const objs = root.filter(isObj);
    if (objs.length >= 1) out.push({ label, objs });
    for (const child of objs) candidateLists(child, label, out, depth + 1);
    return;
  }
  const values = Object.values(root as Obj);
  const objs = values.filter(isObj);
  if (objs.length >= 5 && objs.length >= values.length * 0.8) out.push({ label, objs });
  for (const child of values) candidateLists(child, label, out, depth + 1);
}

/** Page data and JSON-LD come with the page's HTML; captured responses came from a request we can send again. */
function productOrigin(source: PageSource): ProductOrigin {
  if (source.label === 'next-data' || source.label === 'ld+json') return { kind: 'document' };
  if (source.label.startsWith('response ')) return { kind: 'response', request: source.request };
  return { kind: 'other' };
}

/**
 * The JSON documents to look through. A plain request's HTML is read for everything a page carries in it, as a
 * scraper would: Next.js's page data, JSON-LD, JSON script blocks, and the page state its scripts set.
 */
function sourcesOf(payload: PagePayload): PageSource[] {
  const list: PageSource[] = [...(payload.sources ?? [])];
  const nextData = payload.nextDataText ?? (payload.html ? extractNextDataText(payload.html) : null);
  if (nextData) list.push({ label: 'next-data', text: nextData });
  if (payload.html) {
    for (const text of extractLdJson(payload.html)) list.push({ label: 'ld+json', text });
    for (const text of extractJsonScripts(payload.html)) list.push({ label: 'json script', text });
    list.push(...extractPageStates(payload.html));
  }
  return list;
}

export const autoDetect: Parser = (payload, { retailer, storeId }) => {
  const ctx = { retailer, storeId, origin: originOf(payload.href) };
  const cache = new Map<Obj, { product: Product; pricePath: string[] } | null>();
  // Where each product came from, for the price X-ray.
  const origins = new Map<Product, { o: Obj; pricePath: string[] }>();
  const productOf = (o: Obj) => {
    if (!cache.has(o)) {
      const hit = toProduct(o, ctx);
      cache.set(o, hit);
      if (hit) origins.set(hit.product, { o, pricePath: hit.pricePath });
    }
    return cache.get(o)?.product ?? null;
  };

  let best: { source: PageSource; label: string; products: Product[] } | null = null;
  for (const source of sourcesOf(payload)) {
    const root = parseJson(source.text);
    if (!root) continue;
    const candidates: Candidate[] = [];
    candidateLists(root, source.label, candidates);
    for (const c of candidates) {
      const seen = new Set<string>();
      const products: Product[] = [];
      for (const o of c.objs) {
        const p = productOf(o);
        if (p && !seen.has(p.id)) {
          seen.add(p.id);
          products.push(p);
        }
      }
      // Earlier sources win ties: captured responses come newest first.
      if (products.length > 0 && (!best || products.length > best.products.length)) best = { source, label: c.label, products };
    }
  }

  if (!best) return { payloadFound: false, products: [] };
  const label = best.label.replace(/\?.*$/, '').slice(0, 120);
  const evidence: Record<string, RawProduct> = {};
  for (const p of best.products.slice(0, EVIDENCE_KEPT)) {
    const from = origins.get(p);
    if (from) evidence[p.id] = rawProduct(from.o, from.pricePath);
  }
  return {
    payloadFound: true,
    products: best.products,
    source: `${label} (${best.products.length})`,
    origin: productOrigin(best.source),
    evidence,
  };
};

export const PARSERS: Record<string, Parser> = { walmartNextData, pageScriptProducts, autoDetect };
