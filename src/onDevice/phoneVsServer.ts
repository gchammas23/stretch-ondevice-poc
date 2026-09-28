import { howWords } from './retailerSearch';
import { bytesText, reasonWords, seconds } from './scrapeFeed';
import type { Attempt, RetailerConfig, SearchOutcome, Strategy } from './types';

// Pure TypeScript: the phone vs. server test. Each store is searched for one common item two ways, from the phone:
// its page in the phone's own browser (a hidden WebView, the way the app reads prices), and one plain request for its
// search page, the way a scraping server asks for it. Beside them, what one request from a datacenter got on
// DATACENTER_DAY (the README's table). The plain request still leaves from the phone's own internet address, which
// stores trust more than a datacenter's, so it's a server's best case.

/** The day one request per store was sent from a datacenter (the README's table). */
export const DATACENTER_DAY = '2026-09-24';
/** "Sep 24, 2026". */
export const DATACENTER_DATE = new Date(`${DATACENTER_DAY}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

/** How the datacenter's request went: blocked, a page without the prices in it, or loaded (with prices or not, unrecorded). */
export type ServerOutcome = 'blocked' | 'no_prices' | 'loaded';

/** What one request from a datacenter got at each store on DATACENTER_DAY, in the README table's words. */
export const DATACENTER: Record<string, { said: string; outcome: ServerOutcome }> = {
  walmart: { said: 'Bot check', outcome: 'blocked' },
  kroger: { said: 'Blocked (503)', outcome: 'blocked' },
  target: { said: 'Page loads; prices arrive later', outcome: 'no_prices' },
  costco: { said: 'Page loads; prices arrive later', outcome: 'no_prices' },
  traderjoes: { said: 'Blocked (403)', outcome: 'blocked' },
  heb: { said: 'Bot check', outcome: 'blocked' },
  publix: { said: 'Redirects common terms to a category page', outcome: 'no_prices' },
  aldi: { said: 'Loads (runs on Instacart’s platform)', outcome: 'loaded' },
  wholefoods: { said: 'Page loads; prices arrive later', outcome: 'no_prices' },
  safeway: { said: 'Page loads; prices arrive later', outcome: 'no_prices' },
  meijer: { said: 'Blocked (403)', outcome: 'blocked' },
  wegmans: { said: 'Page loads; prices arrive later', outcome: 'no_prices' },
  sprouts: { said: 'Loads (runs on Instacart’s platform)', outcome: 'loaded' },
};

/**
 * A store's datacenter record: its own, or for a regional chain that wasn't tried, its parent's (`parent`: the chain
 * runs on the parent's site). None for stores added in the app.
 */
export function datacenterFor(retailerId: string, sisterOf?: string): { said: string; outcome: ServerOutcome; parent?: string } | undefined {
  const own = DATACENTER[retailerId];
  if (own) return own;
  const parent = sisterOf ? DATACENTER[sisterOf] : undefined;
  return parent ? { ...parent, parent: sisterOf } : undefined;
}

/**
 * How one way of searching a store went: prices; blocked (a bot check, a page that refuses the phone, or the store
 * refusing: HTTP 401, 403, 429 or 503); an empty page; a page without prices in it (on most stores they come later,
 * from the page's own requests, which only a browser makes); too slow; failed another way; or not tried, the store's
 * hour being full ('paused') or the store cooling down after a block ('cooling').
 */
export type Verdict = 'prices' | 'blocked' | 'empty' | 'no_prices' | 'slow' | 'failed' | 'paused' | 'cooling';

/** A page with no product data under this much is empty: a real search page is far bigger. */
export const EMPTY_PAGE_BYTES = 2000;

/** What a failure reason means here, with how big the page was when that's known. */
export function verdictOf(reason: string | undefined, bytes?: number): Verdict {
  if (!reason) return 'failed';
  if (reason === 'polite_limit') return 'paused';
  if (reason === 'cooling_down') return 'cooling';
  if (reason.startsWith('challenge') || reason === 'blocked' || /^http_(401|403|429|503)$/.test(reason)) return 'blocked';
  if (reason === 'tiny_page') return 'empty';
  if (reason === 'no_payload' || reason === 'no_products_on_page' || reason === 'empty') {
    return bytes !== undefined && bytes < EMPTY_PAGE_BYTES ? 'empty' : 'no_prices';
  }
  if (reason === 'timeout') return 'slow';
  return 'failed';
}

/** What one way of searching one store got. */
export interface SideResult {
  verdict: Verdict;
  /** Products with prices. */
  products: number;
  /** How long this way took at the store: not a pause the store's tuning asked for before it. */
  ms: number;
  /** About how much data it moved, when that's known. */
  bytes?: number;
  /** "page load", "reused its page", "direct request". */
  how?: string;
  reason?: string;
  /** The HTTP status a plain request was answered with, when it failed. */
  status?: number;
  /** What the page showed, in words. */
  detail?: string;
  /** Its first product with a price (not an ad): what came back. */
  first?: { name: string; price: number };
}

/** A search that worked: its products with prices, and the time of the try that got them. */
export function fromOutcome(out: SearchOutcome): SideResult {
  const priced = out.products.filter((p) => typeof p.price === 'number' && p.price > 0);
  const first = priced.find((p) => !p.sponsored) ?? priced[0];
  const attempt = out.attempts[out.attempts.length - 1];
  return {
    verdict: priced.length ? 'prices' : 'no_prices',
    products: priced.length,
    ms: attempt?.ms ?? out.ms,
    ...(out.bytes !== undefined ? { bytes: out.bytes } : {}),
    how: howWords(out.strategy, out.via),
    ...(priced.length ? {} : { reason: 'empty' }),
    ...(first ? { first: { name: first.name, price: first.price as number } } : {}),
  };
}

/** A search that failed (a SearchFailed, with its attempts), or never went out. `ms`: how long it took, when no attempt says. */
export function fromFailure(e: unknown, ms: number): SideResult {
  const attempts = ((e as { attempts?: Attempt[] } | null)?.attempts ?? []).filter((a) => a.reason !== 'resting');
  const last = attempts[attempts.length - 1];
  const reason = last?.reason ?? (e instanceof Error ? e.message : 'failed');
  return {
    verdict: verdictOf(reason, last?.bytes),
    products: 0,
    ms: last ? last.ms : ms,
    ...(last?.bytes !== undefined ? { bytes: last.bytes } : {}),
    ...(last?.status !== undefined ? { status: last.status } : {}),
    reason,
    ...(last?.detail ? { detail: last.detail } : {}),
  };
}

const httpCode = (reason: string | undefined) => /^http_(\d+)$/.exec(reason ?? '')?.[1];

/** "24 products", "Bot check", "Blocked (403)", "Too many requests (429)", "An empty page"... */
export function verdictWords(side: SideResult): string {
  switch (side.verdict) {
    case 'prices':
      return `${side.products} ${side.products === 1 ? 'product' : 'products'}`;
    case 'blocked': {
      const code = httpCode(side.reason);
      if (code === '429') return 'Too many requests (429)';
      if (code) return `Blocked (${code})`;
      if (side.reason === 'blocked') return side.status && side.status !== 200 ? `Blocked (${side.status})` : 'Blocked';
      return side.status && side.status !== 200 ? `Bot check (${side.status})` : 'Bot check';
    }
    case 'empty':
      return 'An empty page';
    case 'no_prices':
      return 'No prices in the page';
    case 'slow':
      return 'Too slow';
    case 'paused':
      return 'Not tried: its hour is full';
    case 'cooling':
      return 'Not tried: cooling down after a block';
    default: {
      const code = httpCode(side.reason);
      const words = code ? `HTTP ${code}` : reasonWords(side.reason);
      return words.charAt(0).toUpperCase() + words.slice(1);
    }
  }
}

/** "6.1 s · 2.1 MB · page load": its time, data and, with `how`, how it read the store. */
export function sideMeta(side: SideResult, how = false): string {
  if (side.verdict === 'paused' || side.verdict === 'cooling') return '';
  return [seconds(side.ms), side.bytes ? bytesText(side.bytes) : '', how ? (side.how ?? '') : ''].filter(Boolean).join(' · ');
}

/** "24 products (Great Value Whole Milk, 1 gal, $3.64) · 6.1 s · 2.1 MB · page load". */
export function sideText(side: SideResult, how = false): string {
  const first = side.first ? ` (${side.first.name}, $${side.first.price.toFixed(2)})` : '';
  const meta = sideMeta(side, how);
  return `${verdictWords(side)}${first}${meta ? ` · ${meta}` : ''}`;
}

/** A store in the test, and the site that stands in for it when it's a regional chain. */
export interface VersusStoreInfo {
  retailerId: string;
  name: string;
  sisterOf?: string;
  /** The parent chain's name: "Kroger". */
  parentName?: string;
}

/** One store's result: its page in the phone's browser, the plain request, or why it wasn't tried. */
export interface VersusRow {
  retailerId: string;
  browser?: SideResult;
  plain?: SideResult;
  /** Not tried this time: its hour was full, until then. */
  pausedUntil?: number;
  at: number;
}

/** The stores the phone compares, or every store (see versusIds). */
export type VersusScope = 'compared' | 'all';

/** What a store being tested is on: waiting for a list's searches there, its page, or the plain request. */
export type Doing = 'waiting' | 'browser' | 'plain';

export interface VersusState {
  query: string;
  scope: VersusScope;
  running: boolean;
  startedAt?: number;
  finishedAt?: number;
  /** Every store in the test, in order. */
  stores: VersusStoreInfo[];
  rows: Record<string, VersusRow>;
  doing: Record<string, Doing>;
}

export interface VersusSummary {
  /** Stores tried both ways. */
  tried: number;
  /** Of those, where each way got prices, where it was blocked (a bot check, a refusal or an empty page), and its data. */
  plain: { prices: number; blocked: number; bytes: number };
  browser: { prices: number; blocked: number; bytes: number };
  /** Stores not tried both ways this time: their hour was full. */
  paused: number;
  /** Stores not tried both ways this time: cooling down after a block (see tuning.ts). */
  cooling: number;
  /** What the datacenter's request got at the stores tried that it was sent to itself (not a parent's site). */
  datacenter: { stores: number; blocked: number; noPrices: number; loaded: number };
}

const BLOCKS = new Set<Verdict>(['blocked', 'empty']);

/** The test's result in numbers: stores tried both ways, and what each way got. */
export function versusSummary(state: Pick<VersusState, 'stores' | 'rows'>): VersusSummary {
  const s: VersusSummary = {
    tried: 0,
    plain: { prices: 0, blocked: 0, bytes: 0 },
    browser: { prices: 0, blocked: 0, bytes: 0 },
    paused: 0,
    cooling: 0,
    datacenter: { stores: 0, blocked: 0, noPrices: 0, loaded: 0 },
  };
  for (const store of state.stores) {
    const row = state.rows[store.retailerId];
    if (!row) continue;
    const { plain, browser } = row;
    if (row.pausedUntil !== undefined || plain?.verdict === 'paused' || browser?.verdict === 'paused') {
      s.paused += 1;
      continue;
    }
    if (plain?.verdict === 'cooling' || browser?.verdict === 'cooling') {
      s.cooling += 1;
      continue;
    }
    // Still being tested.
    if (!plain || !browser) continue;
    s.tried += 1;
    for (const [side, into] of [
      [plain, s.plain],
      [browser, s.browser],
    ] as const) {
      if (side.verdict === 'prices') into.prices += 1;
      if (BLOCKS.has(side.verdict)) into.blocked += 1;
      into.bytes += side.bytes ?? 0;
    }
    const record = DATACENTER[store.retailerId];
    if (!record) continue;
    s.datacenter.stores += 1;
    if (record.outcome === 'blocked') s.datacenter.blocked += 1;
    else if (record.outcome === 'no_prices') s.datacenter.noPrices += 1;
    else s.datacenter.loaded += 1;
  }
  return s;
}

/** "From a plain request: 3 of 14 stores gave prices. From this phone’s browser: 12 of 14." */
export function summaryLine(s: VersusSummary, device = 'phone'): string {
  return `From a plain request: ${s.plain.prices} of ${s.tried} ${s.tried === 1 ? 'store' : 'stores'} gave prices. From this ${device}’s browser: ${s.browser.prices} of ${s.tried}.`;
}

/** "Blocked (a bot check, a refusal or an empty page): the plain request at 6 stores, the browser at 1." Null when neither was. */
export function blockedLine(s: VersusSummary): string | null {
  if (!s.plain.blocked && !s.browser.blocked) return null;
  return `Blocked (a bot check, a refusal or an empty page): the plain request at ${s.plain.blocked} ${s.plain.blocked === 1 ? 'store' : 'stores'}, the browser at ${s.browser.blocked}.`;
}

/**
 * "From a datacenter, one request each (Sep 24, 2026): blocked at 5 of 13 stores; the page came without prices at 6;
 * it loaded at 2 (prices not noted)." Null when none of the stores tried has a record of its own.
 */
export function datacenterLine(s: VersusSummary): string | null {
  const d = s.datacenter;
  if (!d.stores) return null;
  const parts = [`blocked at ${d.blocked} of ${d.stores} ${d.stores === 1 ? 'store' : 'stores'}`];
  if (d.noPrices) parts.push(`the page came without prices at ${d.noPrices}`);
  if (d.loaded) parts.push(`it loaded at ${d.loaded} (prices not noted)`);
  return `From a datacenter, one request each (${DATACENTER_DATE}): ${parts.join('; ')}.`;
}

/** Said with every result: why the plain request is a server's best case, and when it isn't (a VPN). */
export const bestCaseText = (device = 'phone'): string =>
  `The plain request still left from this ${device}’s own internet address, which stores trust more than a datacenter’s: that makes it a server’s best case. Over a VPN, both ways left from the VPN’s address instead.`;

/** A regional chain's line for the datacenter: never tried itself; what its parent's site did. */
export function datacenterWords(store: VersusStoreInfo): string {
  const record = datacenterFor(store.retailerId, store.sisterOf);
  if (!record) return 'Not tried';
  return record.parent ? `Not tried; ${store.parentName ?? record.parent}’s site: ${record.said}` : record.said;
}

/** The result as text, for sharing. */
export function versusText(state: VersusState, heading: string, device = 'phone'): string {
  const s = versusSummary(state);
  const lines = [heading, `Searching “${state.query}” at each store two ways, from this ${device}.`, '', summaryLine(s, device)];
  const blocked = blockedLine(s);
  if (blocked) lines.push(blocked);
  const dc = datacenterLine(s);
  if (dc) lines.push(dc);
  if (s.paused) lines.push(`Not tried: ${s.paused} ${s.paused === 1 ? 'store, with no room in its' : 'stores, with no room in their'} hour for both searches.`);
  if (s.cooling) lines.push(`Not tried: ${s.cooling} ${s.cooling === 1 ? 'store, cooling down' : 'stores, cooling down'} after a block.`);
  lines.push(bestCaseText(device));
  for (const store of state.stores) {
    const row = state.rows[store.retailerId];
    if (!row) continue;
    lines.push('', store.name);
    if (row.pausedUntil !== undefined) {
      lines.push('  Not tried: no room in its hour for both searches');
      continue;
    }
    if (row.browser) lines.push(`  This ${device}’s browser: ${sideText(row.browser, true)}`);
    if (row.plain) lines.push(`  Plain request: ${sideText(row.plain)}`);
    lines.push(`  Datacenter (${DATACENTER_DATE}): ${datacenterWords(store)}`);
  }
  return lines.join('\n');
}

/**
 * The stores a test covers: the compared ones, in their order; or every store switched on in the rules, and any added
 * in the app, in the rules' order, with regional chains only when compared (they run on Kroger's and Albertsons'
 * sites, which stand in for them).
 */
export function versusIds(retailers: RetailerConfig[], compared: string[], scope: VersusScope): string[] {
  const on = retailers.filter((r) => r.enabled);
  if (scope === 'compared') return compared.filter((id) => on.some((r) => r.id === id));
  return on.filter((r) => !r.sisterOf || compared.includes(r.id)).map((r) => r.id);
}

/** Asks for the page the way a browser does. */
export const PLAIN_HEADERS: Record<string, string> = {
  Accept: 'text/html,application/xhtml+xml',
  'Accept-Language': 'en-US,en;q=0.9',
};

/**
 * A store's rules for the test's plain request: a browser's Accept headers, and the user agent this phone's browser
 * sends (a server would claim to be a browser too), under the store's own plain-request headers where it has them.
 * Cookies stay out, as in every plain request (see fetchStrategy.ts).
 */
export function plainConfig(cfg: RetailerConfig, userAgent?: string | null): RetailerConfig {
  return { ...cfg, headers: { ...PLAIN_HEADERS, ...(userAgent ? { 'User-Agent': userAgent } : {}), ...(cfg.headers ?? {}) } };
}

/** A store to test, and the store number its site's searches take (empty: the site picks). */
export interface VersusStore {
  config: RetailerConfig;
  storeId: string;
  /** The parent chain's name, for a regional chain. */
  parentName?: string;
}

export interface VersusDeps {
  /** One search at the store, only this way. Bot checks are reported, not shown, and it counts toward the store's hour. */
  search: (cfg: RetailerConfig, query: string, storeId: string, only: Strategy) => Promise<SearchOutcome>;
  /** When the store's hour next has room for `n` more searches: now, or later. */
  roomAt: (retailerId: string, n: number) => number;
  /** Waits until nothing else is searching the store (a list being priced), a while at most. */
  whenFree?: (cfg: RetailerConfig) => Promise<void>;
  /** Anything to do before the first search, once the test is under way. */
  prepare?: () => Promise<void>;
}

const EMPTY: VersusState = { query: 'milk', scope: 'compared', running: false, stores: [], rows: {}, doing: {} };

/** Searches each store two ways, a few stores at a time, and keeps the last finished test. */
export class PhoneVsServer {
  private state: VersusState = EMPTY;
  private listeners = new Set<() => void>();
  /** Counts clears: a test running at one (Erase everything) stops there, and keeps nothing. */
  private cleared = 0;

  constructor(private now: () => number = Date.now) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): VersusState => this.state;

  /**
   * Tests every store in `stores`, `atOnce` stores at a time. At each, one search at a time: its page in the phone's
   * browser, then the plain request, each counted in its hour. A store without room in its hour for both isn't tried.
   */
  async run(stores: VersusStore[], deps: VersusDeps, opts: { query?: string; scope?: VersusScope; atOnce?: number } = {}): Promise<void> {
    if (this.state.running || !stores.length) return;
    const epoch = this.cleared;
    const query = opts.query ?? 'milk';
    this.set({
      query,
      scope: opts.scope ?? 'compared',
      running: true,
      startedAt: this.now(),
      stores: stores.map(({ config, parentName }) => ({
        retailerId: config.id,
        name: config.name,
        ...(config.sisterOf ? { sisterOf: config.sisterOf } : {}),
        ...(parentName ? { parentName } : {}),
      })),
      rows: {},
      doing: {},
    });
    try {
      await deps.prepare?.();
      let next = 0;
      const worker = async () => {
        for (let i = next++; i < stores.length && epoch === this.cleared; i = next++) await this.test(stores[i], deps, query, epoch);
      };
      await Promise.all(Array.from({ length: Math.min(opts.atOnce ?? 4, stores.length) }, worker));
    } finally {
      if (epoch === this.cleared) this.set({ ...this.state, running: false, finishedAt: this.now(), doing: {} });
    }
  }

  private async test({ config, storeId }: VersusStore, deps: VersusDeps, query: string, epoch: number): Promise<void> {
    const id = config.id;
    const room = deps.roomAt(id, 2);
    if (room > this.now()) {
      this.row(id, { pausedUntil: room });
      return;
    }
    // Erased meanwhile (see clear): nothing more is searched, nor kept.
    const erased = () => epoch !== this.cleared;
    this.doing(id, 'waiting');
    await deps.whenFree?.(config);
    if (erased()) return;
    this.doing(id, 'browser');
    const browser = await this.side(() => deps.search(config, query, storeId, 'webview'));
    if (erased()) return;
    this.row(id, { browser });
    this.doing(id, 'plain');
    const plain = await this.side(() => deps.search(config, query, storeId, 'fetch'));
    if (erased()) return;
    this.row(id, { plain });
    this.doing(id, null);
  }

  private async side(search: () => Promise<SearchOutcome>): Promise<SideResult> {
    const t0 = this.now();
    try {
      return fromOutcome(await search());
    } catch (e) {
      return fromFailure(e, this.now() - t0);
    }
  }

  private row(retailerId: string, part: Partial<VersusRow>): void {
    const row = { ...(this.state.rows[retailerId] ?? { retailerId }), ...part, at: this.now() };
    this.set({ ...this.state, rows: { ...this.state.rows, [retailerId]: row } });
  }

  private doing(retailerId: string, what: Doing | null): void {
    const { [retailerId]: _was, ...rest } = this.state.doing;
    this.set({ ...this.state, doing: what ? { ...rest, [retailerId]: what } : rest });
  }

  /** Forgets the last test. One running stops: what it finds from here on is dropped. */
  clear(): void {
    this.cleared++;
    this.set(EMPTY);
  }

  serialize(): string {
    return JSON.stringify({ ...this.state, running: false, doing: {} });
  }

  /** Takes a saved test, when it finished: one the app closed on halfway isn't kept. */
  hydrate(json: string | null): void {
    if (!json) return;
    try {
      const s = JSON.parse(json) as VersusState;
      if (s && typeof s === 'object' && typeof s.finishedAt === 'number' && Array.isArray(s.stores) && s.rows && typeof s.rows === 'object') {
        this.state = { ...EMPTY, ...s, running: false, doing: {} };
      }
    } catch {
      // Start with no result.
    }
  }

  private set(next: VersusState): void {
    this.state = next;
    this.listeners.forEach((listener) => listener());
  }
}
