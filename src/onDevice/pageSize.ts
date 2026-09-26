// Pure functions only: no React Native imports, so the tests run them in Node.
//
// Leaner store requests. A store's own search request usually says how many results to send back (count=24,
// rows=30, "limit": 60, GraphQL's "first": 40...), and the app keeps only the first few of them. A replayed search
// asks for what the app keeps instead, so the store sends less. Whether the store answers that well is checked on the
// phone (see leanVerdict), and a request that answers badly goes back to asking as the page did.

/** Field names that say how many results to send back, as the last part of the name ("page.size", "page[size]"), in lower case without _ or -. */
const PAGE_SIZE_KEYS = new Set([
  'count',
  'limit',
  'rows',
  'size',
  'num',
  'pagesize',
  'perpage',
  'pagelimit',
  'numresults',
  'resultsperpage',
  'hitsperpage',
  'itemsperpage',
  'productsperpage',
  'maxresults',
  'take',
  'first',
]);
/** Parts of a JSON body that aren't about the results: an image's size is left alone. */
const NOT_RESULTS = /image|img|thumb|photo|picture|media|video|banner|ad(?:s|vert)/i;
/** A page size to rewrite: a whole number above what's asked for, and not absurd. */
const MAX_PAGE_SIZE = 500;

/** Where a request says how many results it wants, and what it says. */
export interface PageSizeSpot {
  /** In the URL (a query parameter, or JSON inside one), or the body. */
  where: 'url' | 'body';
  /** As written: "count", "page.size", "hitsPerPage". */
  key: string;
  value: number;
}

const keyOf = (name: string): string => {
  const parts = name.split(/[.[\]]/).filter(Boolean);
  return (parts[parts.length - 1] ?? '').toLowerCase().replace(/[_-]/g, '');
};
const isPageSizeKey = (name: string) => PAGE_SIZE_KEYS.has(keyOf(name));

/** A whole-number value as written ("24" or 24), or undefined. */
function sizeOf(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isInteger(v) && v > 0 ? v : undefined;
  if (typeof v === 'string' && /^\d{1,4}$/.test(v.trim())) return Number(v.trim());
  return undefined;
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

const looksJson = (s: string) => /^\s*[[{]/.test(s);
/** Form or query-string pairs: "q=milk&hitsPerPage=40". */
const looksPairs = (s: string) => /^[^=&\s]+=[^&]*(&[^=&\s]+=[^&]*)*$/.test(s);

/** One pass over a request that finds its page sizes, and rewrites the ones above `to` when `to` is given. */
class Walker {
  spots: PageSizeSpot[] = [];
  changed = 0;
  from = 0;

  constructor(
    private where: 'url' | 'body',
    private to?: number,
  ) {}

  /** A value found at a page-size field: the replacement (same type) when it's to be rewritten, else the value. */
  private visit<T>(key: string, raw: T): T | string | number {
    const value = sizeOf(raw);
    if (value === undefined || value > MAX_PAGE_SIZE) return raw;
    this.spots.push({ where: this.where, key, value });
    if (this.to === undefined || value <= this.to) return raw;
    this.changed += 1;
    this.from = Math.max(this.from, value);
    return typeof raw === 'number' ? this.to : String(this.to);
  }

  json(value: unknown, depth = 0): unknown {
    if (depth > 12) return value;
    if (Array.isArray(value)) return value.map((v) => this.json(v, depth + 1));
    if (typeof value === 'string') return looksPairs(value) && value.includes('=') ? this.pairs(value) : value;
    if (!value || typeof value !== 'object') return value;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (NOT_RESULTS.test(k)) out[k] = v;
      else if (isPageSizeKey(k) && (typeof v === 'number' || typeof v === 'string')) out[k] = this.visit(k, v);
      else out[k] = this.json(v, depth + 1);
    }
    return out;
  }

  /** A JSON text, edited as JSON so it stays valid; unchanged text when nothing changed. */
  jsonText(text: string): string {
    try {
      const before = this.changed;
      const next = this.json(JSON.parse(text));
      return this.changed > before ? JSON.stringify(next) : text;
    } catch {
      return text;
    }
  }

  /** "a=1&count=24": only the pairs that change are re-encoded; '+' spacing is kept where it was used. */
  pairs(text: string): string {
    return text
      .split('&')
      .map((pair) => {
        const eq = pair.indexOf('=');
        if (eq === -1) return pair;
        const key = safeDecode(pair.slice(0, eq).replace(/\+/g, ' '));
        const raw = pair.slice(eq + 1);
        const value = safeDecode(raw.replace(/\+/g, ' '));
        const before = this.changed;
        let next: string;
        if (isPageSizeKey(key)) next = String(this.visit(key, value));
        else if (looksJson(value)) next = this.jsonText(value);
        else return pair;
        if (this.changed === before) return pair;
        const encoded = encodeURIComponent(next);
        return `${pair.slice(0, eq)}=${raw.includes('+') ? encoded.replace(/%20/g, '+') : encoded}`;
      })
      .join('&');
  }

  url(url: string): string {
    const hashAt = url.indexOf('#');
    const beforeHash = hashAt === -1 ? url : url.slice(0, hashAt);
    const queryAt = beforeHash.indexOf('?');
    if (queryAt === -1) return url;
    return `${beforeHash.slice(0, queryAt + 1)}${this.pairs(beforeHash.slice(queryAt + 1))}${hashAt === -1 ? '' : url.slice(hashAt)}`;
  }

  body(body: string, type: string): string {
    if (looksJson(body)) return this.jsonText(body);
    if (/x-www-form-urlencoded/i.test(type) || looksPairs(body)) return this.pairs(body);
    return body;
  }
}

type Req = { url: string; body?: string; headers?: Record<string, string> };

/** Every place a request says how many results it wants (see PAGE_SIZE_KEYS): its URL, JSON inside it, and its body. */
export function pageSizeSpots(req: Req): PageSizeSpot[] {
  const inUrl = new Walker('url');
  inUrl.url(req.url);
  const inBody = new Walker('body');
  if (req.body) inBody.body(req.body, req.headers?.['content-type'] ?? '');
  return [...inUrl.spots, ...inBody.spots];
}

/**
 * The request asking for `to` results wherever it asks for more, with how many it asked for before (the most, where
 * it says it more than once) and in how many places. Null when it never asks for more than `to`.
 */
export function leanRequest<T extends Req>(req: T, to: number): { request: T; from: number; spots: number } | null {
  const inUrl = new Walker('url', to);
  const url = inUrl.url(req.url);
  const inBody = new Walker('body', to);
  const body = req.body ? inBody.body(req.body, req.headers?.['content-type'] ?? '') : req.body;
  const spots = inUrl.changed + inBody.changed;
  if (!spots) return null;
  return { request: { ...req, url, ...(body !== undefined ? { body } : {}) }, from: Math.max(inUrl.from, inBody.from), spots };
}

/**
 * How a store answered a lean request:
 * - 'good': at least `enough` relevant products: it works (a store may add a few of its own to what was asked for:
 *   ads, say);
 * - 'fewer': fewer than `enough`: maybe the store has no more for this search, maybe the smaller size broke something;
 * - 'ignored': more than asked for, and as many as the page's own answer had (`full`): the store takes no notice of the
 *   size, so there's nothing to save;
 * - 'broken': unusable, empty or off the query.
 */
export type LeanVerdict = 'good' | 'fewer' | 'ignored' | 'broken';

export function leanVerdict(answer: { usable: boolean; products: number; relevant: boolean }, to: number, enough: number, full?: number): LeanVerdict {
  if (!answer.usable || !answer.products || !answer.relevant) return 'broken';
  if (answer.products > to && (full === undefined || answer.products >= full)) return 'ignored';
  return answer.products >= enough ? 'good' : 'fewer';
}

/** What a lean request is doing for a store's replays. */
export interface LeanState {
  /** The page size asked for, and what the store's page asked for. */
  to: number;
  from: number;
  /** 'trial' until a lean answer comes back good; 'off' once one comes back broken, or ignored, where a full one worked. */
  state: 'trial' | 'on' | 'off';
  /** The full answer the page got for its own search, to count what lean answers save. */
  baseline?: { chars: number; products: number };
}

/**
 * About how much data a lean answer saved, in the same measure as `lean.bytes` (what moved over the network, when the
 * page could tell): the full answer the store's page got, less this one. Nothing when the smaller size likely held no
 * product back: fewer than `enough` came (this search may have no more), or the page's own answer had no more.
 */
export function leanSaving(baseline: LeanState['baseline'], lean: { chars: number; bytes?: number; products: number }, enough: number): number {
  if (!baseline || lean.products < enough || baseline.products <= lean.products || !(lean.chars > 0)) return 0;
  const chars = Math.max(0, baseline.chars - lean.chars);
  const ratio = lean.bytes && lean.bytes > 0 ? Math.min(1, lean.bytes / lean.chars) : 1;
  return Math.round(chars * ratio);
}
