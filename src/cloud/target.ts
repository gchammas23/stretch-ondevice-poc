import { get, isObj, num, parseMoney, str, type Obj } from '../onDevice/json';
import { saleFrom } from '../onDevice/parsers';
import { sameStoreId, storeIdFromRequest } from '../onDevice/storeIdentity';
import { parseSize } from '../pricing/sizes';
import type { CookieParam } from './cdp';
import { BUTTON_WAIT_MS, HEAVY_FILES, ITEMS_PER_TERM } from './config';
import { cookieValue, gate, overBudget, step, type FlowContext, type FlowOutcome, type FlowPage } from './flow';
import type { CloudItem } from './jobs';
import { pxBlockedAnswer } from './perimeterx';

// Pure TypeScript: Target in a cloud browser.
//
// Target's site picks a store for every new visitor from where it thinks the connection is, and keeps it in its
// cookies (fiatsCookie "DSI_2766|DSN_San%20Francisco%20Central|DSZ_94103", with the visitor's place in UserLocation
// and GuestLocation: seen in a browser, 2026-09-29). The page's own search requests to Target's API (redsky:
// plp_search_v2) ask for that store's prices: pricing_store_id, store_ids and scheduled_delivery_store_id, and the
// place's zip. A cloud browser's connection is a home address Browser Use rents, anywhere in the U.S., so Target picks
// some other store; and asking for the user's store by number in the page's request, in place of the site's, got the
// site's store's prices all the same (live runs: store 2930's, and 1086's, for 1072). So the store is set on the site
// first, as a shopper sets it: the store's own page (target.com/sl/<name>/<number>, which Target serves for any name),
// its "Shop this store" pressed with a real click, and the store cookie checked. When the press doesn't change the
// cookie, the cookies are set as it would leave them, from what the store's page says (the page's own requests then
// ask for the store: checked in a browser, 2026-09-29). The search page's own request must then ask for the store
// before anything is read; each term is that request sent again from inside the page, and each product's
// price.location_id says whose price it is. From the cloud machine this was built on, redsky answered PerimeterX's
// HTTP 435 (tests/fixtures/cloud/target-redsky-px-435.json), while store pages were served
// (tests/fixtures/cloud/target-store-2641.html).

export const TARGET = 'https://www.target.com';
/** Target's store cookie: the store the site prices for ("DSI_2766|DSN_San%20Francisco%20Central|DSZ_94103"). */
export const STORE_COOKIE = 'fiatsCookie';

/** The store a Target store cookie names: "DSI_2766|DSN_…|DSZ_94103" → "2766". */
export function cookieStore(value: string | undefined): string | undefined {
  return /(?:^|\|)DSI_([A-Za-z0-9-]{1,10})(?:\||$)/.exec(value ?? '')?.[1];
}

/** A Target store's own page. Target serves it for any name before the number. */
export const storePageUrl = (storeId: string): string => `${TARGET}/sl/store/${encodeURIComponent(storeId)}`;

/** A Target store as its own page describes it: what its cookies take. */
export interface TargetStore {
  id: string;
  name?: string;
  zip?: string;
  state?: string;
  lat?: number;
  lon?: number;
}

/**
 * The cookies Target's site keeps a shopper's store and place in, for `store`, written as a real browser had them
 * (2026-09-29): the store, and its same-day delivery store ("DSI_2641|DSN_Salt%20Lake%20City|DSZ_84101"); and the
 * shopper's place, as the store's own ("84101|40.745|-111.902|UT|US"), so the site's own requests agree with it,
 * when the store's page gave it.
 */
export function targetStoreCookies(store: TargetStore, nowMs: number): CookieParam[] {
  const now = Math.round(nowMs / 1000);
  const year = now + 365 * 24 * 3600;
  const named = `DSI_${store.id}|DSN_${encodeURIComponent(store.name ?? '')}|DSZ_${store.zip ?? ''}`;
  const cookies: CookieParam[] = [
    { name: STORE_COOKIE, value: named, domain: '.target.com', path: '/', secure: true, sameSite: 'Lax', expires: year },
    { name: 'sddStore', value: named, domain: '.target.com', path: '/' },
  ];
  if (store.zip && store.state && store.lat !== undefined && store.lon !== undefined) {
    const place = `${store.zip}|${store.lat.toFixed(3)}|${store.lon.toFixed(3)}|${store.state}|US`;
    cookies.push(
      { name: 'UserLocation', value: place, domain: '.target.com', path: '/', secure: true, sameSite: 'Lax', expires: year },
      // Host-only, and for a day, as the site's own.
      { name: 'GuestLocation', value: place, url: `${TARGET}/`, path: '/', secure: true, expires: now + 24 * 3600 },
    );
  }
  return cookies;
}
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
  /** The store most of the prices are for: the job's store when as many are for it as for any other. */
  pageStoreId?: string;
  /**
   * True when most prices are for the job's store; false flags the search as another store's. Either way, a product
   * priced for another store (one the store asked for doesn't carry, say) says so itself (CloudItem.pricedAt).
   */
  storeMatches?: boolean;
}

/** A redsky answer: a search's products (data.search.products) or product summaries (data.product_summaries). */
export function parseRedsky(json: unknown, storeId: string): RedskySearch {
  const search = get(json, 'data', 'search', 'products');
  const summaries = get(json, 'data', 'product_summaries');
  const list = Array.isArray(search) ? search : Array.isArray(summaries) ? summaries : null;
  const items: CloudItem[] = [];
  const locations: string[] = [];
  const priced = new Map<string, number>();
  for (const p of list ?? []) {
    if (!isObj(p)) continue;
    const location = idOf(get(p, 'price', 'location_id'));
    const item = targetItem(p);
    if (!item || items.some((i) => i.itemId === item.itemId)) continue;
    items.push(location && !sameStoreId(location, storeId) ? { ...item, pricedAt: location } : item);
    if (!location) continue;
    if (!locations.includes(location)) locations.push(location);
    const key = sameStoreId(location, storeId) ? storeId : location;
    priced.set(key, (priced.get(key) ?? 0) + 1);
  }
  const ours = priced.get(storeId) ?? 0;
  const [mostly, most] = [...priced.entries()].filter(([k]) => k !== storeId).sort((a, b) => b[1] - a[1])[0] ?? ['', 0];
  const matches = ours >= most;
  return {
    payload: !!list,
    items: items.slice(0, ITEMS_PER_TERM),
    found: items.length,
    locationIds: locations,
    ...(priced.size ? { pageStoreId: matches ? storeId : mostly, storeMatches: matches } : {}),
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

/**
 * Reads a Target store's own page: its name, ZIP, state and place on the map, from the page's own data (the modules its
 * self.__next_f script carries, escaped), else its ZIP and state from the address it shows. Null when the page isn't
 * that store's.
 */
export function readStorePage(storeId: string): string {
  return `(() => {
  const id = ${JSON.stringify(storeId)};
  const html = document.documentElement.innerHTML.split('\\\\"').join('"');
  const key = '"store_id":"' + id + '"';
  if (html.indexOf(key) === -1) return null;
  // Its details follow its number, in each module that describes it.
  const near = (re) => {
    for (let at = html.indexOf(key); at !== -1; at = html.indexOf(key, at + 1)) {
      const m = re.exec(html.slice(at, at + 1500));
      if (m) return m;
    }
    return null;
  };
  const text = (s) => { try { return JSON.parse('"' + s + '"'); } catch (e) { return s; } };
  const name = near(/^"store_id":"[^"]*","location_name":"([^"]+)"/);
  const zip = near(/"postal_code":"(\\d{5})/);
  const state = near(/"address_region":"([A-Z]{2})"/);
  const geo = near(/"geo":\\{"latitude":(-?\\d+(?:\\.\\d+)?),"longitude":(-?\\d+(?:\\.\\d+)?)\\}/);
  const shown = document.querySelector('[data-test="@store-locator/StoreInfo"]');
  const address = shown ? /,\\s*([A-Z]{2})\\s+(\\d{5})/.exec(shown.innerText || shown.textContent || '') : null;
  return {
    id: id,
    name: name ? text(name[1]) : undefined,
    zip: zip ? zip[1] : address ? address[2] : undefined,
    state: state ? state[1] : address ? address[1] : undefined,
    lat: geo ? Number(geo[1]) : undefined,
    lon: geo ? Number(geo[2]) : undefined,
  };
})()`;
}

/**
 * Finds the store card's "Shop this store" (its data-test names it MakeItMyStoreBtn; else a button that says so),
 * scrolls it to the middle of the screen, and returns its center in CSS pixels; null when there's none.
 */
export const FIND_SHOP_BUTTON = `(() => {
  const want = /^(?:shop this store|make this my store|make it my store|set as my store)\\b/i;
  const text = (b) => String(b.innerText || b.textContent || '').replace(/\\s+/g, ' ').trim();
  const button = document.querySelector('[data-test="@store-locator/StoreCard/MakeItMyStoreBtn"]') ||
    Array.from(document.querySelectorAll('button')).find((b) => !b.disabled && want.test(text(b)));
  if (!button || button.disabled) return null;
  button.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  const r = button.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return null;
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
})()`;

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

/** The store Target's store cookie names now. */
const siteStore = async (page: FlowPage): Promise<string | undefined> => cookieStore(await cookieValue(page, `${TARGET}/`, STORE_COOKIE));

/** Waits up to `ms` for the store card's "Shop this store", looking twice a second. */
async function findShopButton(page: FlowPage, ctx: FlowContext, ms: number): Promise<{ x: number; y: number } | null> {
  const until = ctx.now() + ms;
  while (true) {
    step(ctx);
    const at = await page.evaluate<{ x: number; y: number } | null>(FIND_SHOP_BUTTON).catch(() => null);
    if (at) {
      // Scrolled into view just now: its place once the scroll has settled.
      await ctx.sleep(400);
      return (await page.evaluate<{ x: number; y: number } | null>(FIND_SHOP_BUTTON).catch(() => null)) ?? at;
    }
    if (ctx.now() >= until) return null;
    await ctx.sleep(500);
  }
}

type StoreSet = { how: 'button' | 'cookie'; picked?: string };

/**
 * Makes `storeId` the site's store, as a shopper does: its own page, and "Shop this store" pressed, until the store
 * cookie names it. When the press doesn't change the cookie (it asks Target's API about the store first, which may
 * refuse), the cookies are set as it would have left them, from what the store's page says. How it was set, and the
 * store the site had picked by itself (its cookie once a page of its had loaded); or the outcome when it couldn't be.
 */
async function setStore(page: FlowPage, storeId: string, ctx: FlowContext): Promise<StoreSet | FlowOutcome> {
  step(ctx);
  const url = storePageUrl(storeId);
  await page.navigate(url);
  await ctx.sleep(3000);
  if ((await gate(page, ctx)) === 'blocked') return { status: 'blocked', reason: 'challenge' };
  const picked = await siteStore(page);
  const store = await page.evaluate<TargetStore | null>(readStorePage(storeId)).catch(() => null);
  if (!store) return { status: 'failed', reason: 'no_store_page', detail: `${url} wasn’t store ${storeId}’s page` };
  const button = await findShopButton(page, ctx, BUTTON_WAIT_MS);
  if (button) {
    step(ctx);
    await page.click(button.x, button.y);
    await ctx.sleep(2500);
    if ((await gate(page, ctx)) === 'blocked') return { status: 'blocked', reason: 'challenge' };
    for (let i = 0; i < 3; i++) {
      if (sameStoreId((await siteStore(page)) ?? '', storeId)) return { how: 'button', ...(picked ? { picked } : {}) };
      await ctx.sleep(1500);
    }
  }
  const pressed = button ? '“Shop this store” was pressed, but the store cookie didn’t change' : 'its page had no “Shop this store” button';
  if (!store.name || !store.zip) return { status: 'failed', reason: 'target_store_not_set', detail: `${pressed}, and the page didn’t say the store’s name and ZIP` };
  step(ctx);
  try {
    await page.setCookies(targetStoreCookies(store, ctx.now()));
  } catch (e) {
    return { status: 'failed', reason: 'target_store_not_set', detail: `${pressed}, and the browser refused its store cookies (${e instanceof Error ? e.message : String(e)})` };
  }
  const now = await siteStore(page);
  if (!now || !sameStoreId(now, storeId)) return { status: 'failed', reason: 'target_store_not_set', detail: `${pressed}, and its store cookie names store ${now ?? '(none)'}` };
  return { how: 'cookie', ...(picked ? { picked } : {}) };
}

/**
 * Target, scripted: the store set on the site (see setStore; a browser from the store's saved profile may have it
 * still, which its cookie says before any page loads), then the search page for the first term, whose own request
 * must ask for the store: otherwise the store is set once more, and then Target fails, rather than read another
 * store's prices. Then that request again for each term, from inside the page, with the term in it. Each answer's
 * price.location_id says whose prices they are, product by product. A page that only sent a product summary (by
 * product numbers, not the words) has its own page loaded for each term, and that page's request sent again.
 */
export async function targetFlow(page: FlowPage, storeId: string, terms: string[], ctx: FlowContext): Promise<FlowOutcome> {
  await page.prepare(HEAVY_FILES);
  page.watchRequests((url) => REDSKY_SEARCH.test(url));
  step(ctx);
  const had = await siteStore(page);
  let how: 'kept' | 'button' | 'cookie' | undefined = had && sameStoreId(had, storeId) ? 'kept' : undefined;
  let picked: string | undefined;
  let own: Awaited<ReturnType<typeof loadSearch>>;
  for (let tries = 0; ; tries++) {
    if (!how) {
      const set = await setStore(page, storeId, ctx);
      if ('status' in set) return set;
      how = set.how;
      picked ??= set.picked;
    }
    own = await loadSearch(page, terms[0], ctx);
    if (own === null) return { status: 'blocked', reason: 'challenge' };
    if (!own) return { status: 'failed', reason: 'no_search_request' };
    if (own.status === 435) return { status: 'blocked', reason: 'challenge' };
    const asked = storeIdFromRequest({ url: own.url })?.id;
    if (!asked || sameStoreId(asked, storeId)) break;
    // The site didn't keep the store: set once more, then no more.
    if (tries > 0) return { status: 'failed', reason: 'target_store_not_set', detail: `after it was set, Target’s search page still asked for store ${asked}` };
    picked ??= asked;
    how = undefined;
  }
  const bySearch = /plp_search/.test(own.url);
  ctx.onStoreSet(how, picked && !sameStoreId(picked, storeId) ? picked : undefined);

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
    const siteStoreId = storeIdFromRequest({ url: own.url })?.id;
    const res = await page
      .evaluate<{ status: number; text: string; size?: number } | null>(replayScript(redskySearchUrl(own.url, term, storeId)), { world: 'main', timeoutMs: 30_000 })
      .catch(() => null);
    const where = siteStoreId ? { siteStoreId } : {};
    if (!res) {
      ctx.onTerm({ term, status: 'failed', items: [], reason: 'replay_failed', ...where, at: ctx.now() });
      continue;
    }
    if (pxBlockedAnswer(res.status, res.text)) {
      ctx.onCheck();
      ctx.onTerm({ term, status: 'blocked', items: [], reason: 'challenge', ...where, at: ctx.now() });
      return { status: 'blocked', reason: 'challenge' };
    }
    if (res.status !== 200) {
      ctx.onTerm({ term, status: 'failed', items: [], reason: `http_${res.status}`, ...where, at: ctx.now() });
      continue;
    }
    let parsed: RedskySearch;
    try {
      parsed = parseRedsky(JSON.parse(res.text), storeId);
    } catch {
      ctx.onTerm({ term, status: 'failed', items: [], reason: 'not_json', ...where, at: ctx.now() });
      continue;
    }
    ctx.onTerm({
      term,
      status: parsed.payload ? 'done' : 'failed',
      items: parsed.items,
      found: parsed.found,
      ...(parsed.pageStoreId ? { pageStoreId: parsed.pageStoreId, storeMatches: parsed.storeMatches } : {}),
      ...where,
      ...(parsed.payload ? {} : { reason: 'no_search_results' }),
      ...(res.size ? { bytes: res.size } : {}),
      at: ctx.now(),
    });
  }
  return { status: 'done' };
}
