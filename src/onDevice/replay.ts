import { buildRequest } from './fetchStrategy';
import { leanRequest, type LeanState } from './pageSize';
import { looksChallenged } from './parsers';
import type { CapturedRequest, PagePayload, PageSource, ProductOrigin, RetailerConfig } from './types';
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
  | { kind: 'json'; request: CapturedRequest; query: string; lean?: LeanState }
  /**
   * Results came in two requests, as on Instacart's storefronts (ALDI's, Sprouts'): the page's search (it carries the
   * query) answered with the results' ids, then a second request asked for those products by id. Both are sent again:
   * the search with the query swapped, then the second with the ids it answered with in place of `asked`. `ids`: the
   * keys down to the list of ids in the search's answer ('*' for any item of an array, or entry of a map).
   */
  | { kind: 'chain'; search: CapturedRequest; query: string; ids: string[]; detail: CapturedRequest; asked: string[] };

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

/** The request to send for `query`, or null when the template has nowhere to put it. For a chain: its search. */
export function applyTemplate(
  template: ReplayTemplate,
  cfg: RetailerConfig,
  query: string,
  storeId: string,
): ReplayRequest | null {
  if (template.kind === 'chain') return applyTemplate({ kind: 'json', request: template.search, query: template.query }, cfg, query, storeId);
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
 * a bot check, or not the kind of response the template expects. `request`: what was sent, so a store's profile can
 * tell its source by the operation in its body too (see profileSource).
 */
export function replayPayload(res: ReplayResponse, expect: ReplayRequest['expect'], markers: string[], request?: ReplayRequest): PagePayload | null {
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
  const sent = request ? { request: { method: request.method, url: request.url, ...(request.body !== undefined ? { body: request.body } : {}) } } : {};
  return { href: res.url, sources: [{ label: `replay ${res.url}`, text, ...sent }] };
}

// ---------------------------------------------------------------------------
// Chains: a search that answers with ids, then the products asked for by id.

/** An id as sites write them: a number, or a word without spaces ("items_1576-17316069", "0001111041700"). */
const ID_LIKE = /^[\w:.-]{1,80}$/;
/** Of a request's ids, at least this share must be in an answer for the answer to count as having them. */
const ID_SHARE = 0.6;

/** A list of ids, as text, or null when it isn't one: three or more plain values, each like an id. */
function idList(v: unknown): string[] | null {
  if (!Array.isArray(v) || v.length < 3) return null;
  const out = v.map((x) => (typeof x === 'number' ? String(x) : x));
  return out.every((x) => typeof x === 'string' && ID_LIKE.test(x)) ? (out as string[]) : null;
}

/** Every list of ids in a JSON value, with the keys down to each ('*' for any item of an array). */
function idListsIn(root: unknown, path: string[] = [], out: { ids: string[]; path: string[] }[] = [], depth = 0): { ids: string[]; path: string[] }[] {
  if (depth > 30 || typeof root !== 'object' || root === null) return out;
  const list = idList(root);
  if (list) {
    out.push({ ids: list, path });
    return out;
  }
  if (Array.isArray(root)) root.forEach((child) => idListsIn(child, [...path, '*'], out, depth + 1));
  else for (const [k, child] of Object.entries(root)) idListsIn(child, [...path, /^[[{]|\d{3,}|[:|]/.test(k) ? '*' : k], out, depth + 1);
  return out;
}

function parseText(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** The lists of ids a request carries: in its address's values (JSON, like GraphQL variables, or "1,2,3") and its JSON body. */
function idListsOfRequest(req: CapturedRequest): string[][] {
  const out: string[][] = [];
  const q = req.url.indexOf('?');
  if (q !== -1) {
    for (const pair of req.url.slice(q + 1).split('#')[0].split('&')) {
      const eq = pair.indexOf('=');
      if (eq === -1) continue;
      const value = safeDecode(pair.slice(eq + 1).replace(/\+/g, ' '));
      if (/^\s*[[{]/.test(value)) out.push(...idListsIn(parseText(value)).map((l) => l.ids));
      else if (value.includes(',')) {
        const list = idList(value.split(','));
        if (list) out.push(list);
      }
    }
  }
  if (typeof req.body === 'string' && /^\s*[[{]/.test(req.body)) out.push(...idListsIn(parseText(req.body)).map((l) => l.ids));
  return out;
}

/** How many of `ids` a text has, as JSON values ("…" or a bare number). */
function idsIn(text: string, ids: string[]): number {
  return ids.filter((id) => text.includes(`"${id}"`) || new RegExp(`[\\[,:]\\s*${id.replace(/[.]/g, '\\.')}\\s*[,\\]}]`).test(text)).length;
}

/**
 * A chain to replay, when a page load's products came from a request that asked for them by id (`detail`, whose answer
 * is `detailText`) and another of the page's requests, one that carries the query, answered with those ids. Null when
 * the products' request isn't one by id, or no search answered with its ids.
 */
export function learnChain(detail: CapturedRequest, detailText: string, sources: PageSource[], query: string): ReplayTemplate | null {
  const method = detail.method.toUpperCase();
  if (detail.opaqueBody || (method !== 'GET' && method !== 'POST') || !/^https?:\/\//i.test(detail.url)) return null;
  // The ids it asked for, as its answer has them.
  const asked = idListsOfRequest(detail).find((ids) => idsIn(detailText, ids) >= ids.length * ID_SHARE);
  if (!asked) return null;
  let best: { search: CapturedRequest; ids: string[]; overlap: number; length: number } | null = null;
  for (const source of sources) {
    const req = source.request;
    if (!req || req === detail || req.opaqueBody || !/^https?:\/\//i.test(req.url) || substitute(req, query, query).count === 0) continue;
    for (const list of idListsIn(parseText(source.text))) {
      const overlap = asked.filter((id) => list.ids.includes(id)).length;
      if (overlap < asked.length * ID_SHARE) continue;
      if (!best || overlap > best.overlap || (overlap === best.overlap && list.ids.length > best.length)) best = { search: req, ids: list.path, overlap, length: list.ids.length };
    }
  }
  return best ? { kind: 'chain', search: best.search, query, ids: best.ids, detail, asked } : null;
}

/** The ids a chain's search answered with, in its order: the longest list at the template's place in its answer. */
export function chainIds(template: Extract<ReplayTemplate, { kind: 'chain' }>, text: string | undefined): string[] {
  if (!text) return [];
  const lists = idListsIn(parseText(text)).filter((l) => l.path.length === template.ids.length && l.path.every((k, i) => k === template.ids[i] || template.ids[i] === '*'));
  const longest = lists.sort((a, b) => b.ids.length - a.ids.length)[0];
  return longest ? longest.ids.slice(0, template.asked.length) : [];
}

/** Puts `next` in place of the list `was` wherever a JSON value holds it, keeping numbers as numbers. */
function swapInJson(value: unknown, was: string[], next: string[], add: () => void): unknown {
  const list = idList(value);
  if (list && list.length === was.length && list.every((id, i) => id === was[i])) {
    add();
    const numeric = (value as unknown[]).every((x) => typeof x === 'number');
    return numeric && next.every((id) => /^\d+$/.test(id)) ? next.map(Number) : next;
  }
  if (Array.isArray(value)) return value.map((v) => swapInJson(v, was, next, add));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = swapInJson(v, was, next, add);
    return out;
  }
  return value;
}

/** The chain's second request for another list of ids, or null when the ids it asked for can't be found in it. */
export function swapIds(req: CapturedRequest, was: string[], next: string[]): ReplayRequest | null {
  let count = 0;
  const add = () => {
    count++;
  };
  let url = req.url;
  const q = url.indexOf('?');
  if (q !== -1) {
    const hashAt = url.indexOf('#', q);
    const hash = hashAt === -1 ? '' : url.slice(hashAt);
    const query = url.slice(q + 1, hashAt === -1 ? undefined : hashAt);
    const pairs = query.split('&').map((pair) => {
      const eq = pair.indexOf('=');
      if (eq === -1) return pair;
      const raw = pair.slice(eq + 1);
      const value = safeDecode(raw.replace(/\+/g, ' '));
      let swapped: string | null = null;
      if (/^\s*[[{]/.test(value)) {
        const before = count;
        const json = swapInJson(parseText(value), was, next, add);
        if (count > before) swapped = JSON.stringify(json);
      } else if (value === was.join(',')) {
        add();
        swapped = next.join(',');
      }
      if (swapped === null) return pair;
      const encoded = encodeURIComponent(swapped);
      return `${pair.slice(0, eq)}=${raw.includes('+') ? encoded.replace(/%20/g, '+') : encoded}`;
    });
    url = `${url.slice(0, q)}?${pairs.join('&')}${hash}`;
  }
  let body = req.body;
  if (typeof body === 'string' && /^\s*[[{]/.test(body)) {
    const before = count;
    const json = swapInJson(parseText(body), was, next, add);
    if (count > before) body = JSON.stringify(json);
  }
  if (!count) return null;
  const out: ReplayRequest = { expect: 'json', method: req.method, url, credentials: req.credentials };
  if (req.headers) out.headers = req.headers;
  if (body !== undefined) out.body = body;
  return out;
}

// Whether a list is about the query: in relevance.ts, shared with the readers.
export { looksRelevant, mentionsQuery } from './relevance';

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
