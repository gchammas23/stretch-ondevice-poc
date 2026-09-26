import { PARSERS, looksChallenged } from './parsers';
import type { SpanLog } from './timing';
import type { ParseResult, RetailerConfig } from './types';

/** A strategy failed for a reason worth reporting (and falling back on). */
export class StrategyError extends Error {
  constructor(
    public readonly reason: string,
    /** What the page showed, in words, for the Diagnostics screen. May name the page and its data URLs. */
    public readonly detail?: string,
  ) {
    super(reason);
    this.name = 'StrategyError';
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
 */
export async function searchViaFetch(cfg: RetailerConfig, query: string, storeId: string, clock?: SpanLog): Promise<ParseResult & { bytes: number }> {
  const parser = PARSERS[cfg.parser];
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
  if (looksChallenged(cfg.challengeMarkers, page.finalUrl, page.html)) throw new StrategyError('challenge');
  throw new StrategyError(page.ok ? 'no_payload' : `http_${page.status}`);
}
