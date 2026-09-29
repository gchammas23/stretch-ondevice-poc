import { get, isObj, num, parseMoney, str, type Obj } from '../onDevice/json';
import { saleFrom, walmartPrice, walmartPriceLine as priceLine } from '../onDevice/parsers';
import { sameStoreId, storeIdFromPageData } from '../onDevice/storeIdentity';
import { parseSize } from '../pricing/sizes';
import { BUTTON_WAIT_MS, HEAVY_FILES, ITEMS_PER_TERM, NEXT_DATA_RETRY_MS, NEXT_DATA_TRIES } from './config';
import { cookieValue, gate, overBudget, step, type FlowContext, type FlowOutcome, type FlowPage } from './flow';
import type { CloudItem } from './jobs';

// Pure TypeScript: Walmart in a cloud browser, the way walmart_store_test.py tested it. Real page loads only (fetching
// Walmart's HTML from inside the page got PerimeterX's block), the store set by pressing its own "Make this my store",
// and each search read from the page's Next.js data, which holds about 50 products priced for the store set. The
// parsers follow a real search page read on 2026-09-28 (tests/fixtures/cloud/walmart-search-milk.json).

export const WALMART = 'https://www.walmart.com';
/** Walmart's store cookie: the store the site prices for. */
export const STORE_COOKIE = 'assortmentStoreId';

const numberOf = (text: string | undefined): number | undefined => {
  if (!text) return undefined;
  const n = Number(text.replace(/[$,\s]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : parseMoney(text);
};

/** A product link on walmart.com, without the query the page adds ("?classType=REGULAR"). */
function productUrl(canonical: string | undefined): string | undefined {
  if (!canonical) return undefined;
  const path = canonical.split('?')[0];
  return path.startsWith('http') ? path : `${WALMART}${path.startsWith('/') ? '' : '/'}${path}`;
}

/**
 * One search result as a product: its price as the card shows it, read as the phone reads it (see walmartPrice), the
 * regular price on a sale, the unit price as printed, the size from its name, and whether a store sells it (its
 * fulfillment names a store) or it only ships (store "0").
 */
export function walmartItem(o: Obj): CloudItem | null {
  const itemId = str(o.usItemId) ?? (typeof o.usItemId === 'number' ? String(o.usItemId) : undefined);
  const name = str(o.name);
  if (!itemId || !name) return null;
  const price = walmartPrice(o)?.price ?? parseMoney(str(get(o, 'priceInfo', 'currentPrice', 'priceString')) ?? str(get(o, 'priceInfo', 'linePrice'))) ?? null;
  const was =
    numberOf(priceLine(o, ['COMPARISON'], 'WAS_PRICE')) ??
    num(get(o, 'priceInfo', 'wasPrice', 'price')) ??
    parseMoney(str(get(o, 'priceInfo', 'wasPrice', 'priceString')) ?? str(get(o, 'priceInfo', 'wasPrice')));
  const unit = priceLine(o, ['UNIT_PRICE'], 'UNIT_PRICE') ?? str(get(o, 'priceInfo', 'unitPrice', 'priceString')) ?? str(get(o, 'priceInfo', 'unitPrice'));
  const image = str(get(o, 'imageInfo', 'thumbnailUrl')) ?? str(o.imageInfo) ?? str(o.image);
  const availability = str(get(o, 'availabilityStatusV2', 'value')) ?? str(o.availabilityStatus);
  const stores = Array.isArray(o.fulfillmentSummary) ? o.fulfillmentSummary.map((f) => str(get(f, 'storeId'))).filter((s): s is string => !!s) : [];
  const fromStore = stores.some((s) => s !== '0');
  const size = parseSize(name)?.text;
  const wasPrice = saleFrom(price, was);
  return {
    itemId,
    name,
    price,
    ...(wasPrice !== undefined ? { wasPrice } : {}),
    ...(unit ? { unitPrice: unit } : {}),
    ...(size ? { size } : {}),
    ...(productUrl(str(o.canonicalUrl)) ? { url: productUrl(str(o.canonicalUrl)) } : {}),
    ...(image ? { imageUrl: image } : {}),
    ...(o.isSponsoredFlag === true ? { sponsored: true } : {}),
    ...(availability ? { inStock: availability === 'IN_STOCK' } : {}),
    ...(stores.length ? { atStore: fromStore } : {}),
  };
}

export interface WalmartSearch {
  /** The page carried search data (a real "no results" page does too). */
  payload: boolean;
  /** Its first ITEMS_PER_TERM products, in the page's order. */
  items: CloudItem[];
  /** Products the page listed. */
  found: number;
  /** The store the page's data says it priced for (its location's storeId). */
  pageStoreId?: string;
  /** True when that's the job's store; false flags its prices as another store's. */
  storeMatches?: boolean;
  /** Where that store is, as the page said: "Sacramento, CA 95829". */
  place?: string;
}

/** The page's own location: under its page metadata, or its content layout's (both seen on 2026-09-28). */
function pageLocation(data: unknown): Obj | undefined {
  const ini = get(data, 'props', 'pageProps', 'initialData');
  const at = [get(ini, 'pageMetadata', 'location'), get(ini, 'contentLayout', 'pageMetadata', 'location'), get(ini, 'searchResult', 'pageMetadata', 'location')];
  return at.find((l): l is Obj => isObj(l) && !!str(l.storeId));
}

/**
 * A Walmart search page's Next.js data (its __NEXT_DATA__ text): the products at
 * props.pageProps.initialData.searchResult.itemStacks[].items, and the store the data is for. Throws on text that
 * isn't JSON (still streaming: the flow reads it again).
 */
export function parseWalmartSearch(text: string, storeId: string): WalmartSearch {
  const data: unknown = JSON.parse(text);
  const searchResult = get(data, 'props', 'pageProps', 'initialData', 'searchResult');
  const stacks = get(searchResult, 'itemStacks');
  const products: CloudItem[] = [];
  const seen = new Set<string>();
  if (Array.isArray(stacks)) {
    for (const stack of stacks) {
      const items = get(stack, 'items');
      if (!Array.isArray(items)) continue;
      for (const o of items) {
        // Ads and tiles take places in the grid without being products.
        if (!isObj(o) || (o.__typename !== undefined && o.__typename !== 'Product')) continue;
        const item = walmartItem(o);
        if (item && !seen.has(item.itemId)) {
          seen.add(item.itemId);
          products.push(item);
        }
      }
    }
  }
  const location = pageLocation(data);
  const pageStoreId = str(location?.storeId) ?? storeIdFromPageData(text)?.id;
  const place = location ? [str(location.city), [str(location.stateOrProvinceCode), str(location.postalCode)].filter(Boolean).join(' ')].filter(Boolean).join(', ') : '';
  return {
    payload: isObj(searchResult),
    items: products.slice(0, ITEMS_PER_TERM),
    found: products.length,
    ...(pageStoreId ? { pageStoreId, storeMatches: sameStoreId(pageStoreId, storeId) } : {}),
    ...(place ? { place } : {}),
  };
}

export interface WalmartProductPage {
  itemId?: string;
  name?: string;
  price: number | null;
  unitPrice?: string;
  /** Store numbers in the page's data, first seen first, as walmart_store_test.py read them. */
  storeIds: string[];
  /** The page is for the job's store: its location says so, or else its first store number. */
  storeMatches?: boolean;
}

/**
 * A product page's Next.js data: props.pageProps.initialData.data.product, its current price, and the store numbers
 * in the page (walmart_store_test.py's check: the store set should be among them). For a spot check of one price; the
 * scripted flow itself reads search pages only.
 */
export function parseWalmartProductPage(text: string, storeId: string): WalmartProductPage {
  const data: unknown = JSON.parse(text);
  const product = get(data, 'props', 'pageProps', 'initialData', 'data', 'product');
  const price = num(get(product, 'priceInfo', 'currentPrice', 'price')) ?? parseMoney(str(get(product, 'priceInfo', 'currentPrice', 'priceString'))) ?? null;
  const storeIds = [...new Set([...text.matchAll(/"storeId"\s*:\s*"(\d+)"/g)].map((m) => m[1]))].filter((id) => id !== '0');
  const own = str(pageLocation(data)?.storeId) ?? storeIds[0];
  return {
    itemId: str(get(product, 'usItemId')),
    name: str(get(product, 'name')),
    price,
    unitPrice: str(get(product, 'priceInfo', 'unitPrice', 'priceString')),
    storeIds: storeIds.slice(0, 5),
    ...(own ? { storeMatches: sameStoreId(own, storeId) } : {}),
  };
}

// --- In the page -------------------------------------------------------------------------------------------

/**
 * Finds a visible, enabled <button> whose text says "Make this my store" (by text: its accessible role didn't find
 * it), scrolls it to the middle of the screen, and returns its center in CSS pixels; null when there's none.
 */
export const FIND_STORE_BUTTON = `(() => {
  const want = /make\\s+this\\s+my\\s+store/i;
  const button = Array.from(document.querySelectorAll('button')).find(
    (b) => !b.disabled && want.test((b.innerText || b.textContent || '').replace(/\\s+/g, ' ')),
  );
  if (!button) return null;
  button.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  const r = button.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return null;
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
})()`;

/** Product fields the phone reads; the rest of each product stays in the cloud browser. */
const ITEM_KEYS = [
  '__typename', 'usItemId', 'id', 'name', 'price', 'priceInfo', 'canonicalUrl', 'imageInfo', 'image', 'availabilityStatusV2', 'availabilityStatus',
  'isSponsoredFlag', 'fulfillmentSummary', 'sellerName', 'productLocationDisplayValue',
];

/**
 * The search page's __NEXT_DATA__, parsed in the page and cut down to what parseWalmartSearch reads, in the same
 * shape (about a tenth of the megabyte the page holds, for the phone's data). 'partial' while it's still streaming.
 */
export const READ_SEARCH_DATA = `(() => {
  const el = document.getElementById('__NEXT_DATA__');
  const text = el ? el.textContent || '' : '';
  if (!text) return { state: 'missing' };
  let data;
  try { data = JSON.parse(text); } catch (e) { return { state: 'partial', size: text.length }; }
  const keys = ${JSON.stringify(ITEM_KEYS)};
  const pick = (o) => { const out = {}; for (const k of keys) if (o && k in o) out[k] = o[k]; return out; };
  const where = (m) => (m && m.location ? { location: m.location } : undefined);
  const ini = (((data || {}).props || {}).pageProps || {}).initialData || {};
  const sr = ini.searchResult;
  const cut = { props: { pageProps: { initialData: {
    searchResult: sr ? {
      title: sr.title, count: sr.count, aggregatedCount: sr.aggregatedCount, pageMetadata: where(sr.pageMetadata),
      itemStacks: (sr.itemStacks || []).map((s) => ({ items: ((s && s.items) || []).map(pick) })),
    } : null,
    pageMetadata: where(ini.pageMetadata),
    contentLayout: ini.contentLayout ? { pageMetadata: where(ini.contentLayout.pageMetadata) } : undefined,
  } } } };
  return { state: 'ok', text: JSON.stringify(cut), size: text.length };
})()`;

// --- The flow ----------------------------------------------------------------------------------------------

/** Waits up to `ms` for the store button, looking twice a second. */
async function findButton(page: FlowPage, ctx: FlowContext, ms: number): Promise<{ x: number; y: number } | null> {
  const until = ctx.now() + ms;
  while (true) {
    step(ctx);
    const at = await page.evaluate<{ x: number; y: number } | null>(FIND_STORE_BUTTON).catch(() => null);
    if (at) {
      // Scrolled into view just now: its place once the scroll has settled.
      await ctx.sleep(400);
      return (await page.evaluate<{ x: number; y: number } | null>(FIND_STORE_BUTTON).catch(() => null)) ?? at;
    }
    if (ctx.now() >= until) return null;
    await ctx.sleep(500);
  }
}

/** The search page's data, read up to NEXT_DATA_TRIES times while it's still streaming. */
async function readSearchData(page: FlowPage, ctx: FlowContext): Promise<string | null> {
  for (let i = 0; i < NEXT_DATA_TRIES; i++) {
    const got = await page.evaluate<{ state: string; text?: string } | null>(READ_SEARCH_DATA).catch(() => null);
    if (got?.state === 'ok' && got.text) return got.text;
    if (i < NEXT_DATA_TRIES - 1) await ctx.sleep(NEXT_DATA_RETRY_MS);
  }
  return null;
}

/**
 * Sets the store the long way: the home page, then the store's own page, where "Make this my store" is pressed with a
 * real mouse click and the store cookie checked. Its outcome when it can't (blocked, or the store not set); null once
 * it's set.
 */
async function setStore(page: FlowPage, storeId: string, ctx: FlowContext): Promise<FlowOutcome | null> {
  step(ctx);
  await page.navigate(`${WALMART}/`);
  await ctx.sleep(3000);
  if ((await gate(page, ctx)) === 'blocked') return { status: 'blocked', reason: 'challenge' };

  step(ctx);
  await page.navigate(`${WALMART}/store/${encodeURIComponent(storeId)}`);
  await ctx.sleep(3000);
  if ((await gate(page, ctx)) === 'blocked') return { status: 'blocked', reason: 'challenge' };
  const button = await findButton(page, ctx, BUTTON_WAIT_MS);
  if (button) {
    step(ctx);
    await page.click(button.x, button.y);
    await ctx.sleep(2500);
    if ((await gate(page, ctx)) === 'blocked') return { status: 'blocked', reason: 'challenge' };
    // The site saves the store with a request of its own: its cookie changes once that's answered.
    let cookie = await cookieValue(page, `${WALMART}/`, STORE_COOKIE);
    for (let i = 0; i < 3 && !(cookie && sameStoreId(cookie, storeId)); i++) {
      await ctx.sleep(1500);
      cookie = await cookieValue(page, `${WALMART}/`, STORE_COOKIE);
    }
    if (!cookie || !sameStoreId(cookie, storeId)) return { status: 'failed', reason: 'store_not_set' };
    ctx.onStoreSet('button');
  } else {
    // No button: this browser's store may already be that one (the store Walmart picked for its address, say).
    const cookie = await cookieValue(page, `${WALMART}/`, STORE_COOKIE);
    if (!cookie || !sameStoreId(cookie, storeId)) return { status: 'failed', reason: 'no_store_button' };
    ctx.onStoreSet('already');
  }
  return null;
}

/**
 * Walmart, scripted: the store set (see setStore), then each term's search page, read from its data. A browser started
 * from the store's saved profile may have the store still set from an earlier run: its cookie says so before any page
 * loads, and the store pages are skipped, as a server keeping its browser's cookies would skip them. The first search
 * checks it held: if its data priced another store, the store is set the long way and that search done again. A bot
 * check stops everything for up to 45 s; if it stays, Walmart is blocked. The browser itself is created and stopped by
 * the runner.
 */
export async function walmartFlow(page: FlowPage, storeId: string, terms: string[], ctx: FlowContext): Promise<FlowOutcome> {
  await page.prepare(HEAVY_FILES);
  step(ctx);
  const kept = await cookieValue(page, `${WALMART}/`, STORE_COOKIE);
  /** The store was kept, and no search has said yet whether it held. */
  let unproven = !!kept && sameStoreId(kept, storeId);
  if (unproven) ctx.onStoreSet('kept');
  else {
    const unset = await setStore(page, storeId, ctx);
    if (unset) return unset;
  }

  for (let i = 0; i < terms.length; i++) {
    const term = terms[i];
    step(ctx);
    if (overBudget(page, ctx)) return { status: 'failed', reason: 'data_budget' };
    const url = `${WALMART}/search?q=${encodeURIComponent(term)}`;
    await page.navigate(url);
    await ctx.sleep(2500);
    let passed = await gate(page, ctx);
    if (passed === 'cleared') {
      // The check went away: its page may be where it left the browser, so the search is loaded again, once.
      await page.navigate(url);
      await ctx.sleep(2500);
      passed = (await gate(page, ctx)) === 'clear' ? 'clear' : 'blocked';
    }
    if (passed === 'blocked') {
      ctx.onTerm({ term, status: 'blocked', items: [], reason: 'challenge', at: ctx.now() });
      return { status: 'blocked', reason: 'challenge' };
    }
    const text = await readSearchData(page, ctx);
    if (!text) {
      ctx.onTerm({ term, status: 'failed', items: [], reason: 'no_page_data', at: ctx.now() });
      continue;
    }
    let parsed: WalmartSearch;
    try {
      parsed = parseWalmartSearch(text, storeId);
    } catch {
      ctx.onTerm({ term, status: 'failed', items: [], reason: 'no_page_data', at: ctx.now() });
      continue;
    }
    if (unproven && parsed.pageStoreId) {
      unproven = false;
      if (parsed.storeMatches === false) {
        // The kept store didn't hold: set the long way, and this search done again.
        const unset = await setStore(page, storeId, ctx);
        if (unset) return unset;
        i--;
        continue;
      }
    }
    ctx.onTerm({
      term,
      status: parsed.payload ? 'done' : 'failed',
      items: parsed.items,
      found: parsed.found,
      ...(parsed.pageStoreId ? { pageStoreId: parsed.pageStoreId, storeMatches: parsed.storeMatches } : {}),
      ...(parsed.payload ? {} : { reason: 'no_search_results' }),
      at: ctx.now(),
    });
  }
  return { status: 'done' };
}
