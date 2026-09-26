import { buildRequest } from './fetchStrategy';
import { leanRequest, type LeanState } from './pageSize';
import { looksChallenged } from './parsers';
import type { CapturedRequest, PagePayload, Product, ProductOrigin, RetailerConfig } from './types';
import type { ReplayResponse } from './webviewQueue';
import type { ReplayRequest } from './webviewScript';

// Pure functions only: no React Native imports, so the tests run them in Node.
//
// A retailer's first search loads its search page in a hidden WebView, the same as always. The page then stays
// loaded, and later searches are sent from inside it as the request that brought the first results, with the
// query swapped. Same device, same cookies, same origin, so it reads the same live data, in a fraction of the time
// of loading and rendering the whole page again. Anything unexpected falls back to a page load.

/** How to ask a retailer's loaded page for another query's results. */
export type ReplayTemplate =
  /** Results are in the search page's HTML: fetch that page for the new query and read its embedded data. */
  | { kind: 'document' }
  /**
   * Results came from the page's own API call: send it again with the query swapped. `lean`: the request says how many
   * results to send, and asking for fewer (what the app keeps) is being tried or works (see pageSize.ts).
   */
  | { kind: 'json'; request: CapturedRequest; query: string; lean?: LeanState };

/**
 * What to replay after a page load, or null when that load's results can only come from another page load. With
 * `leanTo`, a request that asks for more results than that is to ask for that many instead, once it's been tried.
 */
export function learnTemplate(origin: ProductOrigin | undefined, query: string, leanTo?: number): ReplayTemplate | null {
  if (!origin) return null;
  if (origin.kind === 'document') return { kind: 'document' };
  if (origin.kind !== 'response' || !origin.request) return null;
  const { request } = origin;
  const method = request.method.toUpperCase();
  if (request.opaqueBody || !/^https?:\/\//i.test(request.url) || (method !== 'GET' && method !== 'POST')) return null;
  // Only a request that carries the query can be pointed at another one. A request without it (say, prices for
  // a list of product ids) would return the same products whatever we searched for.
  if (substitute(request, query, query).count === 0) return null;
  const lean = leanTo ? leanRequest(request, leanTo) : null;
  return lean ? { kind: 'json', request, query, lean: { to: leanTo!, from: lean.from, state: 'trial' } } : { kind: 'json', request, query };
}

/** The request to send for `query`, or null when the template has nowhere to put it. */
export function applyTemplate(
  template: ReplayTemplate,
  cfg: RetailerConfig,
  query: string,
  storeId: string,
): ReplayRequest | null {
  if (template.kind === 'document') {
    return {
      expect: 'document',
      method: 'GET',
      url: buildRequest(cfg, query, storeId).url,
      headers: { accept: 'text/html,application/xhtml+xml' },
      credentials: 'same-origin',
    };
  }
  const { request, count } = substitute(template.request, template.query, query);
  if (!count) return null;
  const out: ReplayRequest = { expect: 'json', method: request.method, url: request.url, credentials: request.credentials };
  if (request.headers) out.headers = request.headers;
  if (request.body !== undefined) out.body = request.body;
  return out;
}

/**
 * Turns a replayed response into what the retailer's parser reads, or null when it isn't usable: an HTTP error,
 * a bot check, or not the kind of response the template expects.
 */
export function replayPayload(res: ReplayResponse, expect: ReplayRequest['expect'], markers: string[]): PagePayload | null {
  if (!(res.status >= 200 && res.status < 400)) return null;
  // Same rule as the page check: phrases in the URL or title; marker ids also in the body of a short page.
  if (looksChallenged(markers, res.url, res.title)) return null;
  const short = res.short;
  if (short && markers.some((m) => !m.includes(' ') && short.includes(m))) return null;

  if (expect === 'document') {
    const sources = (res.ld ?? []).map((text) => ({ label: 'ld+json', text }));
    if (!res.nextDataText && !sources.length) return null;
    return { href: res.url, nextDataText: res.nextDataText ?? undefined, sources };
  }
  const text = res.text;
  if (!text || !/^\s*[[{]/.test(text)) return null;
  return { href: res.url, sources: [{ label: `replay ${res.url}`, text }] };
}

const STOP_WORDS = new Set(['the', 'and', 'for', 'with', 'of']);

function stem(word: string): string {
  if (word.length > 4 && word.endsWith('ies')) return word.slice(0, -3);
  if (word.length > 4 && word.endsWith('es')) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s')) return word.slice(0, -1);
  return word;
}

/**
 * Whether one of the top results mentions a word of the query (plurals folded), or undefined when that can't be
 * told: no products, or no word of 3+ letters in the query.
 */
export function mentionsQuery(products: Product[], query: string): boolean | undefined {
  const stems = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !STOP_WORDS.has(w))
    .map(stem);
  if (!stems.length || !products.length) return undefined;
  return products.slice(0, 8).some((p) => {
    const name = p.name.toLowerCase();
    return stems.some((s) => name.includes(s));
  });
}

/**
 * A cheap guard against a replay that silently returned the wrong list (say, the first query's results again):
 * one of the top results must mention a word of the query. Passes when that can't be told.
 */
export function looksRelevant(products: Product[], query: string): boolean {
  return mentionsQuery(products, query) !== false;
}

// ---------------------------------------------------------------------------
// Query substitution

const WORD_CHAR = /[a-z0-9]/i;
const JOINERS = [' ', '+', '-', '%20', '_'];

/** Keeps the letter case of what it replaces: "hot dogs" → "ketchup", "Hot Dogs" → "Ketchup" as typed. */
function styled(found: string, replacement: string): string {
  if (found === found.toLowerCase()) return replacement.toLowerCase();
  if (found === found.toUpperCase()) return replacement.toUpperCase();
  return replacement;
}

/**
 * Replaces whole-word, case-insensitive occurrences of the query `from` with `to`, however the words are joined
 * ("hot dogs", "hot+dogs", "hot-dogs"...), keeping that joiner. "tea" is not replaced inside "steak".
 */
export function replaceQuery(text: string, from: string, to: string): { text: string; count: number } {
  const fromWords = from.trim().split(/\s+/).filter(Boolean);
  const toWords = to.trim().split(/\s+/).filter(Boolean);
  if (!fromWords.length || !toWords.length) return { text, count: 0 };

  let out = text;
  let count = 0;
  for (const joiner of fromWords.length > 1 ? JOINERS : [' ']) {
    const needle = fromWords.join(joiner).toLowerCase();
    const lower = out.toLowerCase();
    let result = '';
    let last = 0;
    let at = lower.indexOf(needle);
    while (at !== -1) {
      const before = at > 0 ? out[at - 1] : '';
      const after = out[at + needle.length] ?? '';
      if (!WORD_CHAR.test(before) && !WORD_CHAR.test(after)) {
        result += out.slice(last, at) + styled(out.slice(at, at + needle.length), toWords.join(joiner));
        last = at + needle.length;
        count++;
        at = lower.indexOf(needle, last);
      } else {
        at = lower.indexOf(needle, at + 1);
      }
    }
    out = result + out.slice(last);
  }
  return { text: out, count };
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function replaceDeep(value: unknown, from: string, to: string, add: (n: number) => void): unknown {
  if (typeof value === 'string') {
    const r = replaceQuery(value, from, to);
    add(r.count);
    return r.text;
  }
  if (Array.isArray(value)) return value.map((v) => replaceDeep(v, from, to, add));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = replaceDeep(v, from, to, add);
    return out;
  }
  return value;
}

/** A decoded value: JSON (GraphQL variables, say) is edited as JSON, so quotes and escapes stay valid. */
function replaceValue(value: string, from: string, to: string): { text: string; count: number } {
  if (/^\s*[[{]/.test(value)) {
    try {
      let count = 0;
      const next = replaceDeep(JSON.parse(value), from, to, (n) => (count += n));
      return count ? { text: JSON.stringify(next), count } : { text: value, count: 0 };
    } catch {
      // Not JSON after all; treat it as text.
    }
  }
  return replaceQuery(value, from, to);
}

/** Form or query-string pairs. Only values that change are re-encoded; '+' spacing is kept where it was used. */
function replacePairs(text: string, from: string, to: string, add: (n: number) => void): string {
  return text
    .split('&')
    .map((pair) => {
      const eq = pair.indexOf('=');
      if (eq === -1) return pair;
      const raw = pair.slice(eq + 1);
      const r = replaceValue(safeDecode(raw.replace(/\+/g, ' ')), from, to);
      if (!r.count) return pair;
      add(r.count);
      const encoded = encodeURIComponent(r.text);
      return `${pair.slice(0, eq)}=${raw.includes('+') ? encoded.replace(/%20/g, '+') : encoded}`;
    })
    .join('&');
}

function replaceInUrl(url: string, from: string, to: string, add: (n: number) => void): string {
  const hashAt = url.indexOf('#');
  const hash = hashAt === -1 ? '' : url.slice(hashAt);
  const beforeHash = hashAt === -1 ? url : url.slice(0, hashAt);
  const queryAt = beforeHash.indexOf('?');
  const base = queryAt === -1 ? beforeHash : beforeHash.slice(0, queryAt);
  const m = /^(https?:\/\/[^/]+)(.*)$/i.exec(base);
  const origin = m ? m[1] : '';
  const path = (m ? m[2] : base)
    .split('/')
    .map((segment) => {
      const r = replaceValue(safeDecode(segment), from, to);
      if (!r.count) return segment;
      add(r.count);
      return encodeURIComponent(r.text);
    })
    .join('/');
  const search = queryAt === -1 ? '' : `?${replacePairs(beforeHash.slice(queryAt + 1), from, to, add)}`;
  return origin + path + search + hash;
}

/** The request with the query swapped in its URL and body, and how many places it was found. Headers are left alone. */
export function substitute(req: CapturedRequest, from: string, to: string): { request: CapturedRequest; count: number } {
  let count = 0;
  const add = (n: number) => {
    count += n;
  };
  const request: CapturedRequest = { ...req, url: replaceInUrl(req.url, from, to, add) };
  if (typeof req.body === 'string' && req.body) {
    const type = req.headers?.['content-type'] ?? '';
    if (/^\s*[[{]/.test(req.body)) {
      const r = replaceValue(req.body, from, to);
      add(r.count);
      request.body = r.text;
    } else if (/x-www-form-urlencoded/i.test(type) || /^[^=&\s]+=[^&]*(&[^=&\s]+=[^&]*)*$/.test(req.body)) {
      request.body = replacePairs(req.body, from, to, add);
    } else {
      const r = replaceQuery(req.body, from, to);
      add(r.count);
      request.body = r.text;
    }
  }
  return { request, count };
}
