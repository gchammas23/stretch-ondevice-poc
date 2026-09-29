import { get, isObj, num, parseMoney, str, type Obj } from '../onDevice/json';
import { saleFrom } from '../onDevice/parsers';
import { sameStoreId } from '../onDevice/storeIdentity';
import { parseSize } from '../pricing/sizes';
import { HEAVY_FILES, ITEMS_PER_TERM } from './config';
import { gate, overBudget, step, type FlowContext, type FlowOutcome, type FlowPage } from './flow';
import type { CloudItem } from './jobs';
import { pxBlockedAnswer } from './perimeterx';

// Pure TypeScript: Target in a cloud browser. UNTESTED there before this: the spike loads a search page on
// target.com, captures the search request the page itself sends to Target's API (redsky: plp_search_v2), and sends it
// again from inside the page with the user's store as pricing_store_id / store_ids, then checks the answer's
// location_id is that store. From a server, redsky gave different prices for different stores this way; from this
// POC's server it answered PerimeterX's HTTP 435 (tests/fixtures/cloud/target-redsky-px-435.json).

export const TARGET = 'https://www.target.com';
/** The page's own search requests: the search itself, or the products it summarizes with their fulfillment. */
export const REDSKY_SEARCH = /^https:\/\/redsky\.target\.com\/redsky_aggregations\/v1\/web\/(plp_search_v2|product_summary_with_fulfillment_v1)\b/;

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', trade: '™', reg: '®' };

/** Target's titles carry HTML entities: "Whole Milk - 1gal - Good &#38; Gather&#8482;". */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] === '#') {
      const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : whole;
    }
    return ENTITIES[code.toLowerCase()] ?? whole;
  });
}

const idOf = (v: unknown): string | undefined => str(v) ?? (typeof v === 'number' && Number.isFinite(v) ? String(v) : undefined);

/** One product of a redsky answer: its price, the regular price on a sale, unit price, size, link and picture. */
export function targetItem(p: Obj): CloudItem | null {
  const itemId = idOf(p.tcin);
  const title = str(get(p, 'item', 'product_description', 'title'));
  if (!itemId || !title) return null;
  const name = decodeEntities(title);
  const price =
    num(get(p, 'price', 'current_retail')) ?? num(get(p, 'price', 'current_retail_min')) ?? parseMoney(str(get(p, 'price', 'formatted_current_price'))) ?? null;
  const reg = num(get(p, 'price', 'reg_retail')) ?? num(get(p, 'price', 'reg_retail_min'));
  const unit = str(get(p, 'price', 'formatted_unit_price'));
  const suffix = str(get(p, 'price', 'formatted_unit_price_suffix')) ?? '';
  const size = parseSize(name)?.text;
  const url = str(get(p, 'item', 'enrichment', 'buy_url'));
  const image = str(get(p, 'item', 'enrichment', 'images', 'primary_image_url'));
  const pickup = str(get(p, 'fulfillment', 'store_options', 0, 'order_pickup', 'availability_status'));
  const wasPrice = saleFrom(price, reg);
  return {
    itemId,
    name,
    price,
    ...(wasPrice !== undefined ? { wasPrice } : {}),
    ...(unit ? { unitPrice: `${unit}${suffix}` } : {}),
    ...(size ? { size } : {}),
    ...(url ? { url } : {}),
    ...(image ? { imageUrl: image } : {}),
    ...(p.is_sponsored_sku === true ? { sponsored: true } : {}),
    ...(pickup ? { inStock: pickup === 'IN_STOCK' } : {}),
  };
}

export interface RedskySearch {
  payload: boolean;
  items: CloudItem[];
  found: number;
  /** The stores the prices say they're for (each product's price.location_id), first seen first. */
  locationIds: string[];
  /** True when every price is for the job's store; false flags them as another store's. */
  storeMatches?: boolean;
}

/** A redsky answer: a search's products (data.search.products) or product summaries (data.product_summaries). */
export function parseRedsky(json: unknown, storeId: string): RedskySearch {
  const search = get(json, 'data', 'search', 'products');
  const summaries = get(json, 'data', 'product_summaries');
  const list = Array.isArray(search) ? search : Array.isArray(summaries) ? summaries : null;
  const items: CloudItem[] = [];
  const locations: string[] = [];
  for (const p of list ?? []) {
    if (!isObj(p)) continue;
    const item = targetItem(p);
    if (item && !items.some((i) => i.itemId === item.itemId)) items.push(item);
    const location = idOf(get(p, 'price', 'location_id'));
    if (location && !locations.includes(location)) locations.push(location);
  }
  return {
    payload: !!list,
    items: items.slice(0, ITEMS_PER_TERM),
    found: items.length,
    locationIds: locations,
    ...(locations.length ? { storeMatches: locations.every((l) => sameStoreId(l, storeId)) } : {}),
  };
}

/** The store fields a redsky request may carry. pricing_store_id is the one prices follow. */
const STORE_PARAMS = ['pricing_store_id', 'store_id', 'store_ids', 'scheduled_delivery_store_id'];

/**
 * The page's own redsky search request, asking for `term` at `storeId`: its keyword and page swapped, the first page
 * of results, and every store field it has set to the store (pricing_store_id added if it had none). Everything else
 * (the key, the visitor, the channel) stays as the page sent it.
 */
export function redskySearchUrl(captured: string, term: string, storeId: string): string {
  const at = captured.indexOf('?');
  const base = at === -1 ? captured : captured.slice(0, at);
  const pairs = (at === -1 ? '' : captured.slice(at + 1))
    .split('&')
    .filter(Boolean)
    .map((p) => {
      const eq = p.indexOf('=');
      return eq === -1 ? [p, ''] : [p.slice(0, eq), p.slice(eq + 1)];
    });
  const set = (key: string, value: string, add = false) => {
    const hit = pairs.find(([k]) => k === key);
    if (hit) hit[1] = encodeURIComponent(value);
    else if (add) pairs.push([key, encodeURIComponent(value)]);
  };
  const isSearch = /plp_search/.test(base);
  if (isSearch) {
    set('keyword', term, true);
    set('page', `/s/${term}`);
    set('offset', '0');
  }
  for (const key of STORE_PARAMS) set(key, storeId, key === 'pricing_store_id');
  return `${base}?${pairs.map(([k, v]) => `${k}=${v}`).join('&')}`;
}

// --- In the page -------------------------------------------------------------------------------------------

/** Fields of each product the phone reads; the rest of the answer stays in the cloud browser. */
const PRUNE = `(p) => ({
  tcin: p.tcin, is_sponsored_sku: p.is_sponsored_sku, price: p.price,
  item: p.item ? {
    product_description: p.item.product_description ? { title: p.item.product_description.title } : undefined,
    enrichment: p.item.enrichment ? { buy_url: p.item.enrichment.buy_url, images: p.item.enrichment.images ? { primary_image_url: p.item.enrichment.images.primary_image_url } : undefined } : undefined,
  } : undefined,
  fulfillment: p.fulfillment && Array.isArray(p.fulfillment.store_options) ? { store_options: p.fulfillment.store_options.slice(0, 1).map((s) => ({
    location_id: s.location_id, location_name: s.location_name, order_pickup: s.order_pickup ? { availability_status: s.order_pickup.availability_status } : undefined,
  })) } : undefined,
})`;

/**
 * Sends `url` from inside the page, as the page's own code does (with the site's cookies where the API takes them),
 * and hands back its status and answer, cut down to what parseRedsky reads when it's a search.
 */
export function replayScript(url: string): string {
  return `(async () => {
  const url = ${JSON.stringify(url)};
  const go = (credentials) => fetch(url, { credentials, headers: { accept: 'application/json' } });
  let r;
  try { r = await go('include'); } catch (e) { r = await go('omit'); }
  const text = await r.text();
  if (r.status !== 200) return { status: r.status, text: text.slice(0, 4000) };
  let json;
  try { json = JSON.parse(text); } catch (e) { return { status: r.status, text: text.slice(0, 4000) }; }
  const prune = ${PRUNE};
  const data = (json && json.data) || {};
  const out = { data: {} };
  if (data.search) out.data.search = { products: (data.search.products || []).map(prune) };
  if (data.product_summaries) out.data.product_summaries = data.product_summaries.map(prune);
  return { status: r.status, text: JSON.stringify(out), size: text.length };
})()`;
}

// --- The flow ----------------------------------------------------------------------------------------------

/** Waits for the page's own redsky search request to be answered: the search itself, else a product summary. */
async function pageSearchRequest(page: FlowPage, ctx: FlowContext, ms: number, since = 0) {
  const until = ctx.now() + ms;
  for (;;) {
    const seen = page.requests.slice(since);
    const answered = seen.find((r) => /plp_search/.test(r.url) && r.status !== undefined) ?? seen.find((r) => r.status !== undefined);
    if (answered) return answered;
    if (ctx.now() >= until) return seen[0];
    step(ctx);
    await ctx.sleep(500);
  }
}

/** Loads the term's search page, so the page sends its own redsky request; null when it's blocked. */
async function loadSearch(page: FlowPage, term: string, ctx: FlowContext) {
  const since = page.requests.length;
  await page.navigate(`${TARGET}/s?searchTerm=${encodeURIComponent(term)}`);
  await ctx.sleep(2500);
  if ((await gate(page, ctx)) === 'blocked') return null;
  return (await pageSearchRequest(page, ctx, 20_000, since)) ?? undefined;
}

/**
 * Target, scripted (the spike): its search page for the first term, so the page sends its own redsky request; then
 * that request again for each term, from inside the page, with the user's store in it. Each answer's location_id
 * says whose prices they are. A page that only sent a product summary (by product numbers, not the words) has its own
 * page loaded for each term, and that page's request sent again.
 */
export async function targetFlow(page: FlowPage, storeId: string, terms: string[], ctx: FlowContext): Promise<FlowOutcome> {
  await page.prepare(HEAVY_FILES);
  page.watchRequests((url) => REDSKY_SEARCH.test(url));
  step(ctx);
  let own = await loadSearch(page, terms[0], ctx);
  if (own === null) return { status: 'blocked', reason: 'challenge' };
  if (!own) return { status: 'failed', reason: 'no_search_request' };
  if (own.status === 435) return { status: 'blocked', reason: 'challenge' };
  const bySearch = /plp_search/.test(own.url);
  ctx.onStoreSet('request');

  for (const [i, term] of terms.entries()) {
    step(ctx);
    if (overBudget(page, ctx)) return { status: 'failed', reason: 'data_budget' };
    if (i > 0 && !bySearch) {
      const next = await loadSearch(page, term, ctx);
      if (next === null) {
        ctx.onTerm({ term, status: 'blocked', items: [], reason: 'challenge', at: ctx.now() });
        return { status: 'blocked', reason: 'challenge' };
      }
      if (!next) {
        ctx.onTerm({ term, status: 'failed', items: [], reason: 'no_search_request', at: ctx.now() });
        continue;
      }
      own = next;
    }
    const res = await page
      .evaluate<{ status: number; text: string; size?: number } | null>(replayScript(redskySearchUrl(own.url, term, storeId)), { world: 'main', timeoutMs: 30_000 })
      .catch(() => null);
    if (!res) {
      ctx.onTerm({ term, status: 'failed', items: [], reason: 'replay_failed', at: ctx.now() });
      continue;
    }
    if (pxBlockedAnswer(res.status, res.text)) {
      ctx.onCheck();
      ctx.onTerm({ term, status: 'blocked', items: [], reason: 'challenge', at: ctx.now() });
      return { status: 'blocked', reason: 'challenge' };
    }
    if (res.status !== 200) {
      ctx.onTerm({ term, status: 'failed', items: [], reason: `http_${res.status}`, at: ctx.now() });
      continue;
    }
    let parsed: RedskySearch;
    try {
      parsed = parseRedsky(JSON.parse(res.text), storeId);
    } catch {
      ctx.onTerm({ term, status: 'failed', items: [], reason: 'not_json', at: ctx.now() });
      continue;
    }
    ctx.onTerm({
      term,
      status: parsed.payload ? 'done' : 'failed',
      items: parsed.items,
      found: parsed.found,
      ...(parsed.locationIds.length ? { pageStoreId: parsed.locationIds[0], storeMatches: parsed.storeMatches } : {}),
      ...(parsed.payload ? {} : { reason: 'no_search_results' }),
      ...(res.size ? { bytes: res.size } : {}),
      at: ctx.now(),
    });
  }
  return { status: 'done' };
}
