import { get, isObj, moneyFromText, num, parseMoney, str, type Obj } from './json';
import { mentionsQuery } from './relevance';
import type {
  ListRead,
  PagePayload,
  PageSource,
  ParseContext,
  ParseResult,
  Parser,
  ParserProfile,
  Product,
  ProductOrigin,
  ProfileFields,
  ProfileSource,
  RawProduct,
} from './types';

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

/**
 * The <script type="application/json"> blocks in a page's HTML, but Next.js's page data (read on its own), each
 * labeled with its id when it has one ("json script #node-apollo-state"), as the browser's page script labels them.
 */
function extractJsonScripts(html: string): PageSource[] {
  const marker = 'type="application/json"';
  const out: PageSource[] = [];
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
    const tag = html.slice(open, start);
    if (!tag.includes('__NEXT_DATA__')) out.push({ label: jsonScriptLabel(/\bid="([^"]{1,80})"/.exec(tag)?.[1]), text: html.slice(start + 1, end) });
    from = end;
  }
  return out;
}

/** A JSON script block's label: "json script", with its id when it has one. */
export const jsonScriptLabel = (id?: string | null): string => (id ? `json script #${id}` : 'json script');

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
    // Some pages write their data URL-encoded ("%7B%22…"), as Instacart's storefronts do in their JSON script blocks.
    if (!/^\s*%(7B|5B)/i.test(text)) return null;
    try {
      return JSON.parse(decodeURIComponent(text));
    } catch {
      return null;
    }
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
// Auto-detect: no per-retailer code. Looks through every JSON document the page embedded or fetched for lists of
// product-shaped objects (a name plus a price), whatever the field names, and takes the largest, or, for a search, the
// largest that names what was searched. It notes where that list was and where each product's fields were, so the
// store's profile can be learned from its searches (see profiles.ts), and says when the list may not be the results
// (judgeList). It can still pick the wrong list (e.g. recommendations); the test screen shows which source it used.

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
const SPONSORED_KEY = /sponsor|isAd$|advert/i;

/** Something found in a product's data, and the keys from the product down to it. */
interface Found<T> {
  value: T;
  path: string[];
}

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

/** A price from a price-looking field's value: a number (cents when the key says so), or text like "$3.49". */
function priceValue(v: unknown, key: string): { value: number; text?: string } | undefined {
  if (typeof v === 'number') {
    const value = /cents/i.test(key) ? v / 100 : v;
    return value > 0 && value < 10000 ? { value } : undefined;
  }
  if (typeof v !== 'string') return undefined;
  const value = moneyFromText(v) ?? (/^\d{1,5}(\.\d{1,2})?$/.test(v) ? Number(v) : undefined);
  return value !== undefined && value > 0 ? { value, text: v.includes('$') ? v : undefined } : undefined;
}

function collectPrices(o: Obj, keys: string[], hits: PriceHit[], unit: Found<string>[], member: PriceHit[] = []): void {
  if (keys.length > 4) return;
  for (const [k, v] of Object.entries(o)) {
    if (NOT_PRICE.test(k)) continue;
    const path = [...keys, k];
    const priceish = PRICE_KEY.test(k) || keys.some((p) => PRICE_KEY.test(p));
    const into = MEMBER_KEY.test(path.join('.')) ? member : hits;
    if (typeof v === 'number' && priceish) {
      const got = priceValue(v, k);
      if (got) into.push({ value: got.value, score: pathScore(path), depth: path.length, path });
    } else if (typeof v === 'string' && priceish) {
      const score = pathScore(path);
      if (score === -1 && /[$¢]/.test(v)) unit.push({ value: v, path });
      else {
        const got = priceValue(v, k);
        if (got) into.push({ value: got.value, text: got.text, score, depth: path.length, path });
      }
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

/** A product's name from a field's value: short text that isn't a link. */
function nameValue(v: unknown, key: string): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.trim();
  return s.length >= 2 && s.length <= (key === 'description' ? 160 : 250) && !/^https?:/.test(s) ? s : undefined;
}

function findName(o: Obj, depth = 0): Found<string> | undefined {
  for (const k of NAME_KEYS) {
    const value = nameValue(o[k], k);
    if (value) return { value, path: [k] };
  }
  if (depth >= 3) return undefined;
  for (const [k, v] of Object.entries(o)) {
    if (SKIP.test(k) || !NEST.test(k)) continue;
    const child = Array.isArray(v) ? v[0] : v;
    if (isObj(child)) {
      const n = findName(child, depth + 1);
      if (n) return { value: n.value, path: [k, ...n.path] };
    }
  }
  return undefined;
}

const idValue = (v: unknown): string | undefined => ((typeof v === 'string' && v) || typeof v === 'number' ? String(v) : undefined);

function findId(o: Obj): Found<string> | undefined {
  for (const k of ID_KEYS) {
    const value = idValue(o[k]);
    if (value) return { value, path: [k] };
  }
  for (const [k, v] of Object.entries(o)) {
    if (!NEST.test(k) || !isObj(v)) continue;
    for (const key of ID_KEYS) {
      const value = idValue(v[key]);
      if (value) return { value, path: [k, key] };
    }
  }
  return undefined;
}

/** An image's address from a field's value: a full link, or one without its scheme. */
function imageValue(v: unknown): string | undefined {
  while (Array.isArray(v)) v = v[0];
  if (typeof v !== 'string') return undefined;
  return /^https?:\/\//.test(v) ? v : v.startsWith('//') ? `https:${v}` : undefined;
}

function findImage(v: unknown, depth = 0, path: string[] = []): Found<string> | undefined {
  if (typeof v === 'string') {
    const value = imageValue(v);
    return value ? { value, path } : undefined;
  }
  if (depth > 3) return undefined;
  if (Array.isArray(v)) return findImage(v[0], depth + 1, path);
  if (!isObj(v)) return undefined;
  for (const k of ['url', 'src', 'href']) {
    const hit = depth > 0 ? findImage(v[k], depth + 1, [...path, k]) : undefined;
    if (hit) return hit;
  }
  for (const [k, child] of Object.entries(v)) {
    if (IMAGE_KEY.test(k) || (depth > 0 && /sizes|urls/i.test(k))) {
      const hit = findImage(child, depth + 1, [...path, k]);
      if (hit) return hit;
    }
  }
  // An image a level in, under a key worth looking inside ("viewSection.itemImage.url"), found under a key that says so.
  if (depth === 0) {
    for (const [k, child] of Object.entries(v)) {
      if (!NEST.test(k) || SKIP.test(k) || !isObj(child)) continue;
      const hit = findImage(child, depth + 1, [...path, k]);
      if (hit && hit.path.some((key) => IMAGE_KEY.test(key))) return hit;
    }
  }
  return undefined;
}

/** A barcode from a field's value: 8 to 14 digits, as text, a number, or the first of a list. */
function gtinValue(v: unknown): string | undefined {
  const raw = typeof v === 'string' ? v : typeof v === 'number' ? String(v) : Array.isArray(v) && typeof v[0] === 'string' ? v[0] : undefined;
  return raw && /^\d{8,14}$/.test(raw.trim()) ? raw.trim() : undefined;
}

/** A barcode under a key that says so (upc, gtin13, primary_barcode...), on the object or one level in. */
export function findGtin(o: Obj): string | undefined {
  return findGtinAt(o)?.value;
}

function findGtinAt(o: Obj, depth = 0): Found<string> | undefined {
  for (const [k, v] of Object.entries(o)) {
    if (!GTIN_KEY.test(k)) continue;
    const value = gtinValue(v);
    if (value) return { value, path: [k] };
  }
  if (depth >= 2) return undefined;
  for (const [k, v] of Object.entries(o)) {
    if (!NEST.test(k) || !isObj(v)) continue;
    const hit = findGtinAt(v, depth + 1);
    if (hit) return { value: hit.value, path: [k, ...hit.path] };
  }
  return undefined;
}

/** In stock or not, from a field that says so: a yes or no under an availability key, or words. */
function stockValue(v: unknown, key: string): boolean | undefined {
  if (typeof v === 'boolean') return /^(inStock|in_stock|available|isAvailable|is_available)$/.test(key) ? v : undefined;
  if (typeof v === 'string' && /availab|stock/i.test(key)) {
    if (/out.?of.?stock|unavailable|temporarily/i.test(v)) return false;
    if (/in.?stock|available|high|low/i.test(v)) return true;
  }
  return undefined;
}

function findStock(o: Obj): Found<boolean> | undefined {
  for (const [k, v] of Object.entries(o)) {
    const value = stockValue(v, k);
    if (value !== undefined) return { value, path: [k] };
  }
  return undefined;
}

function originOf(href: string | undefined): string {
  return (href && /^https?:\/\/[^/?#]+/i.exec(href)?.[0]) || '';
}

const linkOf = (link: string | undefined, origin: string): string | undefined => (link ? (link.startsWith('/') && origin ? origin + link : link) : undefined);

type FieldKey = Exclude<keyof ProfileFields, 'memberLabel'>;
const FIELD_KEYS: FieldKey[] = ['id', 'name', 'price', 'was', 'member', 'unit', 'link', 'image', 'stock', 'gtin', 'sponsored'];
/** The ways of finding one field a profile keeps, at most. */
const FIELD_WAYS = 3;

/** A product read from its data: where its price was, and where each of its fields was. */
interface ProductRead {
  o: Obj;
  product: Product;
  pricePath: string[];
  fields: Partial<Record<FieldKey, string[]>>;
  memberLabel?: string;
}

interface ReadContext {
  retailer: string;
  storeId: string;
  origin: string;
}

/** A product-shaped object as a product, the path to the price it was given, and where each of its fields was. */
function toProduct(o: Obj, ctx: ReadContext): ProductRead | null {
  const name = findName(o);
  if (!name) return null;
  const hits: PriceHit[] = [];
  const unit: Found<string>[] = [];
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

  const linkKey = Object.entries(o).find(([k, v]) => URL_KEY.test(k) && typeof v === 'string')?.[0];
  const sponsoredKey = Object.entries(o).find(([k, v]) => v === true && SPONSORED_KEY.test(k))?.[0];
  const id = findId(o);
  const image = findImage(o);
  const stock = findStock(o);
  const gtin = findGtinAt(o);
  const memberLabel = deal ? memberLabelOf(deal.path) : undefined;
  const product: Product = {
    retailer: ctx.retailer,
    storeId: ctx.storeId,
    id: id?.value ?? `name:${name.value}`,
    name: name.value,
    price: best.value,
    wasPrice: was?.value,
    ...(deal ? { memberPrice: deal.value, memberLabel } : {}),
    priceText: best.text,
    unitPriceText: unit[0]?.value,
    imageUrl: image?.value,
    url: linkOf(linkKey ? (o[linkKey] as string) : undefined, ctx.origin),
    inStock: stock?.value,
    sponsored: sponsoredKey ? true : undefined,
    gtin: gtin?.value,
  };
  const fields: ProductRead['fields'] = { name: name.path, price: best.path };
  if (id) fields.id = id.path;
  if (was) fields.was = was.path;
  if (deal) fields.member = deal.path;
  if (unit[0]) fields.unit = unit[0].path;
  if (linkKey) fields.link = [linkKey];
  if (image) fields.image = image.path;
  if (stock) fields.stock = stock.path;
  if (gtin) fields.gtin = gtin.path;
  if (sponsoredKey) fields.sponsored = [sponsoredKey];
  return { o, product, pricePath: best.path, fields, ...(memberLabel ? { memberLabel } : {}) };
}

/**
 * Where each field was across a list's products, as a profile keeps it: the ways each was found, in the order to try
 * them. Prices in the order the general reader ranks them (a sale price before a regular one, so a product on sale is
 * read at its sale price); the rest, the most used first.
 */
function listFields(reads: ProductRead[]): ProfileFields {
  const ways: Partial<Record<FieldKey, string[][]>> = {};
  for (const key of FIELD_KEYS) {
    const seen = new Map<string, { path: string[]; n: number }>();
    for (const r of reads) {
      const path = r.fields[key];
      if (!path) continue;
      const k = JSON.stringify(path);
      const had = seen.get(k);
      if (had) had.n++;
      else seen.set(k, { path, n: 1 });
    }
    if (!seen.size) continue;
    const all = [...seen.values()].sort((a, b) =>
      key === 'price' ? pathScore(b.path) - pathScore(a.path) || a.path.length - b.path.length || b.n - a.n : b.n - a.n,
    );
    ways[key] = all.slice(0, FIELD_WAYS).map((w) => w.path);
  }
  const labels = reads.map((r) => r.memberLabel).filter((l): l is string => !!l);
  const memberLabel = labels.sort((a, b) => labels.filter((l) => l === b).length - labels.filter((l) => l === a).length)[0];
  return { ...ways, name: ways.name ?? [], price: ways.price ?? [], ...(memberLabel ? { memberLabel } : {}) };
}

interface Candidate {
  objs: Obj[];
  /** Keys from the document down to the list; '*' for any item of an array, or any entry of a map. */
  path: string[];
}

/** A key that names one entry among many (an id, a query's variables) rather than a place: '*' in a list's path. */
const varying = (key: string): boolean => /^[[{]/.test(key) || /\d{3,}/.test(key) || /[:|]/.test(key);
/** A key that holds a list of ids ("itemIds", "product_ids"): results named by id, whose details come another way. */
const IDS_KEY = /ids$/i;

/**
 * Arrays of objects, plus big id-keyed maps (normalized caches like Apollo's), with the keys down to each; and, in
 * `ids`, the longest list of plain ids anywhere in the document.
 */
function candidateLists(root: unknown, out: Candidate[], path: string[], ids: { most: number }, depth = 0): void {
  if (depth > 40 || typeof root !== 'object' || root === null) return;
  if (Array.isArray(root)) {
    const objs = root.filter(isObj);
    if (objs.length >= 1) out.push({ objs, path: [...path] });
    path.push('*');
    for (const child of objs) candidateLists(child, out, path, ids, depth + 1);
    path.pop();
    return;
  }
  const entries = Object.entries(root as Obj);
  const objs = entries.map(([, v]) => v).filter(isObj);
  const map = objs.length >= 5 && objs.length >= entries.length * 0.8;
  if (map) out.push({ objs, path: [...path] });
  for (const [k, child] of entries) {
    if (Array.isArray(child) && child.length > ids.most && IDS_KEY.test(k) && child.every((v) => typeof v === 'string' || typeof v === 'number')) ids.most = child.length;
    path.push(map || varying(k) ? '*' : k);
    candidateLists(child, out, path, ids, depth + 1);
    path.pop();
  }
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
    list.push(...extractJsonScripts(payload.html));
    list.push(...extractPageStates(payload.html));
  }
  return list;
}

/** A list this small can be a carousel or a list beside the results: see judgeList. */
export const TINY_LIST = 4;
/** "12 or more came before": a store whose lists ran this big is expected to give as many again. */
export const FULL_LIST = 12;
/** Words in a list's keys that name something beside the results. */
const SIDE_WORDS = /featured|sponsor|carousel|recommend|related|similar|popular|trending|recent|also|bought|viewed|banner|promo|advert/i;
/** An ad unit's key: "ads", "adProducts", "ad_items" (not "address"). */
const AD_KEY = /^ads?$|^ad[A-Z_]/;

/** What the wrong-list rule looks at: a list's size, whether it names what was searched, where it was, and ids beside it. */
export interface ListFacts {
  count: number;
  fits?: boolean;
  path: string[];
  /** The longest list of plain ids in the same document, when there is one. */
  ids?: number;
}

/**
 * The wrong-list rule: why a list may not be the store's search results, in words, or undefined when nothing says so.
 * A list whose products don't name what was searched; or a small one (1 to 4 products) where the store gave 12 or more
 * before (`usual`), or whose keys say it's beside the results (featured, sponsored, a carousel...), or next to many
 * more results named only by their ids (their details come another way, like Instacart's storefronts' item ids).
 */
export function judgeList(list: ListFacts, usual?: number): string | undefined {
  if (list.fits === false) return 'its products don’t name what was searched';
  if (list.count > TINY_LIST || list.count < 1) return undefined;
  const count = `${list.count} ${list.count === 1 ? 'product' : 'products'}`;
  if (usual !== undefined && usual >= FULL_LIST) return `${count} where the store gave ${usual} before`;
  const side = list.path.find((k) => SIDE_WORDS.test(k) || AD_KEY.test(k));
  if (side) return `${count} in “${side}”, a list beside the results`;
  if ((list.ids ?? 0) >= Math.max(8, 3 * list.count)) return `${count}, next to ${list.ids} results named by their ids`;
  return undefined;
}

interface FoundList {
  source: PageSource;
  path: string[];
  reads: ProductRead[];
  ids: number;
  /** The order it was found in: earlier sources win ties, since captured responses come newest first. */
  order: number;
}

/**
 * Which list to take: the largest; for a search, the largest that names what was searched when the largest doesn't;
 * and a list the wrong-list rule suspects gives way to a bigger one that fits and isn't suspect.
 */
function chooseList(found: FoundList[], query?: string, usual?: number): { pick: FoundList; fits?: boolean; suspect?: string; preferred?: boolean } {
  const ranked = [...found].sort((a, b) => b.reads.length - a.reads.length || a.order - b.order);
  const fitsOf = (f: FoundList) => (query ? mentionsQuery(f.reads.map((r) => r.product), query) : undefined);
  const judge = (f: FoundList) => judgeList({ count: f.reads.length, fits: fitsOf(f), path: f.path, ids: f.ids }, usual);
  const first = ranked[0];
  let pick = first;
  if (query && fitsOf(first) === false) pick = ranked.find((f) => fitsOf(f) !== false) ?? first;
  let suspect = judge(pick);
  if (suspect) {
    const better = ranked.find((f) => f.reads.length > pick.reads.length && fitsOf(f) !== false && !judge(f));
    if (better) {
      pick = better;
      suspect = undefined;
    }
  }
  const fits = fitsOf(pick);
  return { pick, ...(fits !== undefined ? { fits } : {}), ...(suspect ? { suspect } : {}), ...(pick !== first ? { preferred: true } : {}) };
}

/** What a found list reads as: its products, where they were, the data kept for the X-ray, and how it was chosen. */
function asResult(list: { source: PageSource; reads: ProductRead[] }, read: ListRead): ParseResult {
  const products = list.reads.map((r) => r.product);
  const label = list.source.label.replace(/\?.*$/, '').slice(0, 120);
  const evidence: Record<string, RawProduct> = {};
  for (const r of list.reads.slice(0, EVIDENCE_KEPT)) evidence[r.product.id] = rawProduct(r.o, r.pricePath);
  return { payloadFound: true, products, source: `${label} (${products.length})`, origin: productOrigin(list.source), evidence, read };
}

export const autoDetect: Parser = (payload, ctx) => {
  const rctx: ReadContext = { retailer: ctx.retailer, storeId: ctx.storeId, origin: originOf(payload.href) };
  const cache = new Map<Obj, ProductRead | null>();
  const readOf = (o: Obj) => {
    if (!cache.has(o)) cache.set(o, toProduct(o, rctx));
    return cache.get(o) ?? null;
  };

  const found: FoundList[] = [];
  for (const source of sourcesOf(payload)) {
    const root = parseJson(source.text);
    if (!root) continue;
    const lists: Candidate[] = [];
    const ids = { most: 0 };
    candidateLists(root, lists, [], ids);
    for (const c of lists) {
      const seen = new Set<string>();
      const reads: ProductRead[] = [];
      for (const o of c.objs) {
        const r = readOf(o);
        if (r && !seen.has(r.product.id)) {
          seen.add(r.product.id);
          reads.push(r);
        }
      }
      if (reads.length) found.push({ source, path: c.path, reads, ids: ids.most, order: found.length });
    }
  }

  if (!found.length) return { payloadFound: false, products: [] };
  const { pick, fits, suspect, preferred } = chooseList(found, ctx.query, ctx.usual);
  return asResult(pick, {
    by: 'general',
    candidate: { source: profileSource(pick.source), list: pick.path, fields: listFields(pick.reads), count: pick.reads.length },
    ...(fits !== undefined ? { fits } : {}),
    ...(suspect ? { suspect } : {}),
    ...(preferred ? { preferred } : {}),
  });
};

// ---------------------------------------------------------------------------
// Profiles: where a store's list is, as learned from its searches (see profiles.ts), read without guessing.

/** A GraphQL operation's name, from the address (?operationName=) or a JSON body: one address can serve many. */
function operationOf(url: string, body?: string): string | undefined {
  const q = /[?&](?:operationName|opname|operation)=([^&#]+)/i.exec(url)?.[1];
  if (q) {
    try {
      return decodeURIComponent(q).slice(0, 80);
    } catch {
      return q.slice(0, 80);
    }
  }
  if (!body || !/^\s*[[{]/.test(body)) return undefined;
  try {
    const parsed = JSON.parse(body) as unknown;
    const one = Array.isArray(parsed) ? parsed[0] : parsed;
    const name = isObj(one) ? one.operationName : undefined;
    return typeof name === 'string' && name ? name.slice(0, 80) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Which of a page's data a list was in, as a profile keeps it: a response's address (host and path, and its GraphQL
 * operation), from the request that brought it where that's known; or the data's name ("next-data", "json script
 * #node-apollo-state", "__APOLLO_STATE__").
 */
export function profileSource(s: Pick<PageSource, 'label' | 'request'>): ProfileSource {
  const labeled = /^(?:response|replay) (\S+)/.exec(s.label)?.[1];
  if (!labeled) return { kind: 'page', label: s.label };
  const url = s.request?.url ?? labeled;
  const m = /^(?:https?:\/\/([^/?#]+))?([^?#]*)/i.exec(url);
  const op = operationOf(url, s.request?.body);
  return { kind: 'request', host: (m?.[1] ?? '').toLowerCase(), path: (m?.[2] ?? '').replace(/\/+$/, '') || '/', ...(op ? { op } : {}) };
}

const bareHost = (host: string) => host.replace(/^www\./, '');

/** Whether a document is where a profile says the list is. */
export function sourceMatches(want: ProfileSource, s: Pick<PageSource, 'label' | 'request'>): boolean {
  const got = profileSource(s);
  if (want.kind === 'page') return got.kind === 'page' && got.label === want.label;
  if (got.kind !== 'request' || got.path !== want.path) return false;
  if (got.host && want.host && bareHost(got.host) !== bareHost(want.host)) return false;
  return !want.op || got.op === want.op;
}

/** Every value at `path` in a document: '*' is any item of an array, or any entry of a map. */
function nodesAt(root: unknown, path: string[], at = 0): unknown[] {
  if (at === path.length) return [root];
  const key = path[at];
  if (key === '*') {
    const kids = Array.isArray(root) ? root : isObj(root) ? Object.values(root) : [];
    return kids.flatMap((kid) => (typeof kid === 'object' && kid !== null ? nodesAt(kid, path, at + 1) : []));
  }
  if (isObj(root)) return key in root ? nodesAt(root[key], path, at + 1) : [];
  if (Array.isArray(root) && /^\d+$/.test(key)) return nodesAt(root[Number(key)], path, at + 1);
  return [];
}

/** The value at `path` in a product's data; a key past a list goes to its first item, as the general reader reads. */
export function readPath(root: unknown, path: string[]): unknown {
  let cur = root;
  for (const key of path) {
    while (Array.isArray(cur) && !/^\d+$/.test(key)) cur = cur[0];
    if (Array.isArray(cur)) cur = cur[Number(key)];
    else if (isObj(cur)) cur = cur[key];
    else return undefined;
  }
  return cur;
}

/** A field's value from the first of its ways that has one. */
function firstOf<T>(o: Obj, ways: string[][] | undefined, value: (v: unknown, key: string) => T | undefined): Found<T> | undefined {
  for (const path of ways ?? []) {
    const got = value(readPath(o, path), path[path.length - 1] ?? '');
    if (got !== undefined) return { value: got, path };
  }
  return undefined;
}

/** A product read with a profile's fields, or null when its name or price isn't where the profile says. */
function byProfile(o: Obj, f: ProfileFields, ctx: ReadContext): ProductRead | null {
  const name = firstOf(o, f.name, nameValue);
  const price = firstOf(o, f.price, priceValue);
  if (!name || !price) return null;
  const was = firstOf(o, f.was, priceValue);
  const member = firstOf(o, f.member, priceValue);
  const deal = member && member.value.value < price.value.value - 0.004 && member.value.value > price.value.value * 0.3 ? member.value.value : undefined;
  const id = firstOf(o, f.id, idValue);
  const unit = firstOf(o, f.unit, (v) => (typeof v === 'string' && /[$¢]/.test(v) ? v : undefined));
  const link = firstOf(o, f.link, (v) => (typeof v === 'string' && v ? v : undefined));
  const stock = firstOf(o, f.stock, stockValue);
  const product: Product = {
    retailer: ctx.retailer,
    storeId: ctx.storeId,
    id: id?.value ?? `name:${name.value}`,
    name: name.value,
    price: price.value.value,
    wasPrice: saleFrom(price.value.value, was?.value.value),
    ...(deal !== undefined ? { memberPrice: deal, memberLabel: f.memberLabel ?? memberLabelOf(member!.path) } : {}),
    priceText: price.value.text,
    unitPriceText: unit?.value,
    imageUrl: firstOf(o, f.image, imageValue)?.value,
    url: linkOf(link?.value, ctx.origin),
    inStock: stock?.value,
    sponsored: firstOf(o, f.sponsored, (v) => (v === true ? true : undefined))?.value,
    gtin: firstOf(o, f.gtin, gtinValue)?.value,
  };
  return { o, product, pricePath: price.path, fields: {} };
}

/**
 * Reads a payload with a store's profile: the list where the profile says it is, and each product's fields where it
 * says they are (one whose name or price is elsewhere is read the general way). Not found when the profile's list isn't
 * in the page's data, or has no products: the caller then falls back to the general reader. The profile says the list
 * is the results, so only its size against what the store gives, and whether it names what was searched, can suspect it.
 */
export function readWithProfile(profile: ParserProfile, payload: PagePayload, ctx: ParseContext): ParseResult {
  const rctx: ReadContext = { retailer: ctx.retailer, storeId: ctx.storeId, origin: originOf(payload.href) };
  let best: { source: PageSource; reads: ProductRead[] } | null = null;
  for (const source of sourcesOf(payload)) {
    if (!sourceMatches(profile.source, source)) continue;
    const root = parseJson(source.text);
    if (!root) continue;
    for (const node of nodesAt(root, profile.list)) {
      const objs = Array.isArray(node) ? node.filter(isObj) : isObj(node) ? Object.values(node).filter(isObj) : [];
      const seen = new Set<string>();
      const reads: ProductRead[] = [];
      for (const o of objs) {
        const r = byProfile(o, profile.fields, rctx) ?? toProduct(o, rctx);
        if (r && !seen.has(r.product.id)) {
          seen.add(r.product.id);
          reads.push(r);
        }
      }
      if (reads.length && (!best || reads.length > best.reads.length)) best = { source, reads };
    }
  }
  if (!best) return { payloadFound: false, products: [], read: { by: 'profile', missed: true } };
  const fits = ctx.query ? mentionsQuery(best.reads.map((r) => r.product), ctx.query) : undefined;
  const suspect = judgeList({ count: best.reads.length, fits, path: [] }, ctx.usual ?? profile.usual);
  return asResult(best, { by: 'profile', ...(fits !== undefined ? { fits } : {}), ...(suspect ? { suspect } : {}) });
}

export const PARSERS: Record<string, Parser> = { walmartNextData, pageScriptProducts, autoDetect };
