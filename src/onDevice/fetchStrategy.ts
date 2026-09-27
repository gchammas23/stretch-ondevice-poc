import { PARSERS, looksChallenged } from './parsers';
import type { SpanLog } from './timing';
import type { ParseResult, Parser, RetailerConfig } from './types';
import { BLOCK_MARKERS } from './webviewScript';

/** A page with no product data under this many characters is nearly empty: a real search page is far bigger. */
export const TINY_PAGE_CHARS = 2000;

/** A strategy failed for a reason worth reporting (and falling back on). */
export class StrategyError extends Error {
  /** The HTTP status the store answered with, when a plain request got an answer. */
  readonly status?: number;
  /** About how much data the try moved, when that's known: a plain request's page, or a page load's. */
  readonly bytes?: number;

  constructor(
    public readonly reason: string,
    /** What the page showed, in words, for the Diagnostics screen. May name the page and its data URLs. */
    public readonly detail?: string,
    info?: { status?: number; bytes?: number },
  ) {
    super(reason);
    this.name = 'StrategyError';
    this.status = info?.status;
    this.bytes = info?.bytes;
  }
}

export const fill = (template: string, vars: Record<string, string>): string =>
  template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => vars[key] ?? '');

/** The search URL and store cookie for one query, shared by both strategies. */
export function buildRequest(cfg: RetailerConfig, query: string, storeId: string) {
  return {
    url: fill(cfg.searchUrl, { query: encodeURIComponent(query.trim()), storeId }),
    cookie: cfg.cookieTemplate ? fill(cfg.cookieTemplate, { storeId }) : '',
  };
}

interface Page {
  status: number;
  ok: boolean;
  finalUrl: string;
  html: string;
}

async function getPage(url: string, init: RequestInit, timeoutMs: number): Promise<Page> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    return { status: res.status, ok: res.ok, finalUrl: res.url || url, html: await res.text() };
  } catch {
    throw new StrategyError(controller.signal.aborted ? 'timeout' : 'network');
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One plain GET from the phone, with no rendering: the parser reads the data the page embeds.
 * `credentials: 'omit'` keeps the phone's shared cookie jar out, so the store cookie we pass is what gets sent.
 * Verify that on a device (Proxyman shows the outgoing Cookie header).
 * `parser`: how the page is read, when the caller chose (the store's profile first: see readerFor in retailerSearch.ts);
 * the rules' parser otherwise.
 */
export async function searchViaFetch(
  cfg: RetailerConfig,
  query: string,
  storeId: string,
  clock?: SpanLog,
  parser: Parser | undefined = PARSERS[cfg.parser],
): Promise<ParseResult & { bytes: number }> {
  if (!parser) throw new StrategyError(`unknown_parser_${cfg.parser}`);

  const { url, cookie } = buildRequest(cfg, query, storeId);
  const t0 = Date.now();
  let page: Page;
  try {
    page = await getPage(
      url,
      {
        method: 'GET',
        headers: { ...(cfg.headers ?? {}), ...(cookie ? { Cookie: cookie } : {}) },
        credentials: 'omit',
      },
      cfg.timeoutMs,
    );
  } finally {
    clock?.add('fetch', t0, Date.now());
  }

  const read = () => parser({ html: page.html, href: page.finalUrl }, { retailer: cfg.id, storeId });
  const parsed = clock ? clock.time('parse', read) : read();
  // The page as received; over the network it was likely compressed to a fraction of that.
  if (parsed.payloadFound) return { ...parsed, bytes: page.html.length };
  const info = { status: page.status, bytes: page.html.length };
  // A page that refuses the phone outright ("Access Denied"): its address or title says so, or a short page's words.
  const title = /<title[^>]*>([^<]*)<\/title>/i.exec(page.html)?.[1] ?? '';
  const short = page.html.length < 40_000 ? page.html : '';
  const block = BLOCK_MARKERS.find((m) => looksChallenged([m], page.finalUrl, title, short));
  if (block) throw new StrategyError('blocked', plainDetail(page, block), info);
  const marker = cfg.challengeMarkers.find((m) => looksChallenged([m], page.finalUrl, page.html));
  if (marker) throw new StrategyError('challenge', plainDetail(page, marker), info);
  if (!page.ok) throw new StrategyError(`http_${page.status}`, plainDetail(page), info);
  // Nearly empty, and no product data: a store that won't say it blocked the phone often answers like this.
  throw new StrategyError(page.html.length < TINY_PAGE_CHARS ? 'tiny_page' : 'no_payload', plainDetail(page), info);
}

/** What a plain request got instead of products, in words: "HTTP 403, a page of 2 KB, with “Robot or human” in it." */
function plainDetail(page: Page, marker?: string): string {
  const size = page.html.length < 1000 ? `${page.html.length} characters` : `${Math.round(page.html.length / 1000)} KB`;
  const what = marker ? `, with “${marker}” in it` : page.ok ? ', and no product data in it' : '';
  return `HTTP ${page.status}, a page of ${size}${what}.`;
}
