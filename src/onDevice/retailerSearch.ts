import { parseRecipe, type Recipe } from '../lists/recipe';
import { parseAd, type WeeklyAd } from './adPage';
import { parseCoupons, type Coupon, type CouponList } from './couponPage';
import { MAX_ALTERNATIVES } from '../pricing/basket';
import { PRODUCTS_KEPT } from '../pricing/priceCache';
import { CONNECTION_ID, type AttemptEntry, type AttemptKind } from './attemptLog';
import { priceEvidence, redactUrl, type PriceEvidence } from './evidence';
import { StrategyError, buildRequest, fill, isStoreNumber, searchViaFetch, storeSetRequest } from './fetchStrategy';
import { krogerApiConfigured, krogerStoresNear, searchKrogerApi } from './krogerApi';
import { mergeFeeReads, parseFeePage, type FeePageRead } from './feePage';
import { createNutritionLookup, type Nutrition } from './nutrition';
import { leanRequest, leanSaving, leanVerdict } from './pageSize';
import { describePage } from './pageSummary';
import { EVIDENCE_KEPT, PARSERS, readWithProfile, sourceMatches } from './parsers';
import { politeness } from './politeness';
import { parseProductPage, type ProductDetails } from './productPage';
import { observationOf, ProfileBook, STALE_MISSES, whereWords } from './profiles';
import { applyTemplate, chainIds, learnChain, learnTemplate, looksRelevant, mentionsQuery, replayPayload, swapIds, type ReplayTemplate } from './replay';
import { bytesText, reasonWords, seconds } from './scrapeFeed';
import { mergeStores, parseStoreLabel, pinStoreInRequest, sameStoreId, storeFromFinder, storeIdFromPageData, storeIdFromRequest, storeLine } from './storeIdentity';
import { nearbyList, sortNearest, withMiles, type LatLng, type NearbyStore, type StoreCard, type ZipTie } from './storeLocator';
import { reportAttempt, reportNote } from './telemetry';
import { SpanLog, type LoadTiming, type ReplayTiming, type SearchTiming } from './timing';
import {
  blockOf,
  CONNECTION_WINDOW_MS,
  coolWords,
  isRest,
  storeTuner,
  tuningBase,
  type BlockKind,
  type ConnectionDrop,
  type CoolDown,
  type StoreTuner,
  type StoreTuning,
  type TuningSample,
  type Way,
} from './tuning';
import type {
  Attempt,
  KnownStore,
  ListRead,
  PageSource,
  ParseResult,
  Parser,
  ParserProfile,
  Product,
  ReaderNote,
  RetailerConfig,
  SearchOutcome,
  Strategy,
} from './types';
import { PAGE_LANE, type WebViewPool } from './webviewPool';
import type { ReplayResponse, StoreTask, WebViewPayload, WebViewQueue } from './webviewQueue';
import { CLIP_BUTTONS, DEFAULT_CHALLENGE_MARKERS, STORE_BUTTONS, hostOf, sameSite, type ReplayRequest } from './webviewScript';

export class SearchFailed extends Error {
  constructor(
    public readonly attempts: Attempt[],
    /** When each part of the search happened, for the speed test's timeline. */
    public readonly timing?: SearchTiming,
  ) {
    super(
      attempts
        .filter((a) => a.reason !== 'resting')
        .map((a) => `${a.strategy}: ${a.reason ?? 'failed'}`)
        .join('; ') || 'no strategies configured',
    );
    this.name = 'SearchFailed';
  }
}

const reasonOf = (e: unknown) =>
  e instanceof StrategyError ? e.reason : e instanceof Error ? e.message : 'unknown';
const detailOf = (e: unknown) => (e instanceof StrategyError ? e.detail : undefined);
/** What a failed try knew of the store's answer: a plain request's HTTP status, and the data it moved. */
const infoOf = (e: unknown): Pick<Attempt, 'status' | 'bytes'> =>
  e instanceof StrategyError ? { ...(e.status !== undefined ? { status: e.status } : {}), ...(e.bytes !== undefined ? { bytes: e.bytes } : {}) } : {};

/** A failed attempt, kept on the phone for the Diagnostics screen. */
export interface FailureRecord {
  retailer: string;
  query: string;
  strategy: Strategy;
  reason: string;
  detail?: string;
  at: number;
}

type StrategyResult = ParseResult & {
  note?: string;
  via?: 'page' | 'replay';
  bytes?: number;
  /** About how much data asking for fewer results saved (see pageSize.ts). */
  bytesSaved?: number;
  store?: KnownStore;
  /** The request that brought the products, for the price X-ray. */
  request?: { method: string; url: string };
};

export interface SearchOptions {
  /** 'report': a bot check fails the search instead of covering the app, for checks nobody is waiting on. */
  challenge?: 'ask' | 'report';
  /** What the search is for, for Store health. */
  kind?: AttemptKind;
}

/** Unusable replays in a row before a retailer goes back to page loads until a new page teaches it again. */
const REPLAY_MISSES_ALLOWED = 2;
/** Loading a store finder and saving the store takes longer than a search page. */
const STORE_SET_TIMEOUT_MS = 30_000;
/** Streamed-in results are taken early only when there are at least this many and they fit the query. */
const MIN_EARLY_PRODUCTS = 3;
const MAX_FAILURES_KEPT = 30;
/** A single page read for its details: a product's, a recipe's. */
const PAGE_TIMEOUT_MS = 20_000;
/** Details read from a product's page are reused for this long. */
const DETAILS_TTL_MS = 60 * 60_000;
/** Loading a store's page to type into its search box. */
const SUGGEST_PAGE_TIMEOUT_MS = 15_000;
/** Typing into it and waiting for its suggestions. */
const SUGGEST_TIMEOUT_MS = 4_000;
/** A store finder, hidden: its page, the ZIP typed into it, and the stores it finds. */
const STORE_LIST_TIMEOUT_MS = 25_000;
/** A weekly ad or an account's coupons, hidden: the page, scrolled a few screens, and its requests gone quiet. */
const LIST_PAGE_TIMEOUT_MS = 30_000;
/** Clipping a coupon: the page, the press, and the site saving it. */
const CLIP_TIMEOUT_MS = 35_000;
/** Results a replay asks for, where the store's request says how many: what the app keeps of a search. */
const LEAN_TO = PRODUCTS_KEPT;
/** A lean answer with this many products works: the pick, and the basket's alternatives to swap to. */
const LEAN_ENOUGH = MAX_ALTERNATIVES + 1;
const LOAD_KINDS = new Set(['start', 'open', 'prices', 'settle']);

/** One search as it goes: when each part happened, how hard its store may be pushed, and what the store said. */
interface Run {
  clock: SpanLog;
  tune: StoreTuning;
  /** The store answered "too many requests" (HTTP 429) along the way. */
  limited: boolean;
  /** The store showed a bot check along the way, to a plain request or its page. */
  checked: boolean;
  /** The store refused the phone along the way (a block page, HTTP 401 or 403, a nearly empty page). */
  blocked: boolean;
  /** Replays the store refused along the way, to cool that way down once the search ends. */
  blocks: { kind: BlockKind; said: string }[];
  /** This search already counted as an empty answer (see emptyBlock): one search counts once, however many ways it tried. */
  emptied: boolean;
  /** Data that answers thrown away moved (a lean answer checked again, a replay that didn't work): it counts too. */
  extraBytes: number;
}

const BOT_CHECKS = new Set(['challenge', 'challenge_timeout', 'challenge_cancelled']);

/** A search as the store tuning sees it: how it went, its page load and replayed request, and any pushback. */
function tuningSample(run: Run, ok: boolean, ms: number, strategy: Strategy, reason?: string): TuningSample {
  const spans = run.clock.spans.filter((s) => s.ok !== false && !s.during);
  const load = spans.filter((s) => LOAD_KINDS.has(s.kind)).reduce((n, s) => n + s.end - s.start, 0);
  const replay = spans.filter((s) => s.kind === 'replay').pop();
  return {
    at: Date.now(),
    ok,
    ms,
    ...(reason ? { reason } : {}),
    ...(load ? { loadMs: load } : {}),
    ...(replay ? { replayMs: replay.end - replay.start } : {}),
    ...(run.limited ? { limited: true } : {}),
    ...(run.checked || run.clock.spans.some((s) => s.kind === 'check') ? { checked: true } : {}),
    ...(run.blocked ? { blocked: true } : {}),
    ...(strategy === 'api' ? { api: true } : {}),
  };
}

export type StoreSetResult = { ok: true; label?: string; store?: KnownStore } | { ok: false; reason: string };

/**
 * A retailer's stores near a ZIP code, nearest first: from its official API, or its own store finder. `tie`: how the
 * list is tied to the ZIP asked for (see nearbyList in storeLocator.ts).
 */
export type StoresNearResult = { ok: true; stores: NearbyStore[]; how: 'api' | 'finder'; tie: ZipTie } | { ok: false; reason: string };

/** What a store's fees page said, the page, and what reading it took. */
export type FeesPageResult = FeePageRead & { url: string; ms: number; bytes?: number };

/** A store's weekly ad as its page gave it, the page, what reading it took, and the store the page said it's for. */
export type AdPageResult = WeeklyAd & { url: string; ms: number; bytes?: number; store?: KnownStore };

/** An account's coupons as its coupons page gave them, the page, and what reading it took. */
export type CouponPageResult = CouponList & { url: string; ms: number; bytes?: number };

/**
 * A coupon clipped, as the store's page showed it after the press: `already` when it was clipped before; `gone` when its
 * tile left the page instead of saying so (moved to the clipped ones, perhaps): read the coupons again to know.
 */
export type ClipResult = { clipped: boolean; already?: boolean; gone?: boolean };

export interface RetailerSearch {
  /** One search at one retailer, trying its strategies in order (or only `only`). */
  search(cfg: RetailerConfig, query: string, storeId: string, only?: Strategy, opts?: SearchOptions): Promise<SearchOutcome>;
  /** Opens the retailer's site and reads the page the user ends on. Null if they close it. */
  readFromSite(cfg: RetailerConfig, query: string): Promise<SearchOutcome | null>;
  /**
   * Sets a store near `zip` on the retailer's own site, as a user would: opens its store finder for the ZIP, hidden,
   * and presses "make this my store" on `target` (by number or name), or on the nearest; or, where the rules give the
   * site's own request for it, sends that for `target`, from the finder's page. Where the finder allows it.
   */
  setStoreAuto(cfg: RetailerConfig, zip: string, target?: { id?: string; name?: string }): Promise<StoreSetResult>;
  /**
   * The retailer's stores near `zip`, nearest first: through its official API (Kroger, with keys), else from its own
   * store finder, loaded hidden, with the ZIP typed in. Miles from `origin` where the finder doesn't say.
   */
  storesNear(cfg: RetailerConfig, zip: string, radiusMiles: number, origin?: LatLng): Promise<StoresNearResult>;
  /** Recent failed attempts, newest first, with what the page showed. */
  recentFailures(): FailureRecord[];
  /**
   * Loads the product's own page on the retailer's site, hidden, and reads what it says about the product (photos,
   * description, size, rating...). Only pages on the retailer's own site.
   */
  readProduct(cfg: RetailerConfig, product: Product): Promise<ProductDetails>;
  /**
   * The Nutrition Facts Open Food Facts has for a barcode, or null. For a product whose store page didn't give them:
   * one request with the barcode alone, each barcode once while the app is open.
   */
  lookupNutrition(gtin: string): Promise<Nutrition | null>;
  /** Opens the product's page on the retailer's site for the user to look at. */
  viewProduct(cfg: RetailerConfig, url: string): Promise<void>;
  /** Loads a recipe page, hidden, and reads its ingredients from the recipe data the page publishes. */
  readRecipe(url: string): Promise<Recipe>;
  /**
   * Loads the store's own page about its online order fees (`online.feesUrl` in its rules), hidden, and reads what
   * it says pickup and delivery cost (see feePage.ts). A bot check fails the read instead of covering the app: the
   * store rules' estimates stand meanwhile.
   */
  readFees(cfg: RetailerConfig): Promise<FeesPageResult>;
  /**
   * Loads a page of the store's weekly ad (`url`, from `ad` in its rules), hidden, on the store's own lane (one page
   * load at a time there), and reads its sale items (see adPage.ts). It counts toward the store's hourly limit. A bot
   * check, or a sign-in page, fails the read instead of showing.
   */
  readAd(cfg: RetailerConfig, url: string): Promise<AdPageResult>;
  /**
   * The signed-in account's digital coupons, available and clipped, from the store's coupons page (`coupons.url`),
   * hidden, on its own lane (see couponPage.ts). The site sending it to sign in fails the read with 'signed_out', and
   * the sign-in page isn't loaded. It counts toward the store's hourly limit.
   */
  readCoupons(cfg: RetailerConfig): Promise<CouponPageResult>;
  /** Clips one coupon on the store's coupons page, hidden, pressing its own button: only when the user asks in the app. */
  clipCoupon(cfg: RetailerConfig, coupon: Coupon): Promise<ClipResult>;
  /** Opens the store's coupons page on screen, with nothing injected, for the user to look at or clip there. */
  viewCoupons(cfg: RetailerConfig): Promise<void>;
  /** Every attempt as it ends, for Store health. */
  onAttempt(listener: (entry: AttemptEntry) => void): () => void;
  /** The data a price read since the app opened came in: the price X-ray. */
  evidence(retailerId: string, productId: string): PriceEvidence | undefined;
  /**
   * Opens the store's own sign-in page (or its home page) for the user to sign in to its loyalty program: the site
   * keeps them signed in, so the phone's searches there get their member prices. Nothing is injected into the page.
   */
  signIn(cfg: RetailerConfig): Promise<void>;
  /**
   * Gets a page of the retailer's loaded, hidden, to ask its search box for suggestions: its home page, unless one
   * of its pages is loaded already. False if it can't (a bot check, say): it's then left out of suggestions.
   */
  prepareSuggestions(cfg: RetailerConfig): Promise<boolean>;
  /** What the retailer's own search box suggests for `text`, typed into its page, hidden. Empty if nothing. */
  suggest(cfg: RetailerConfig, text: string): Promise<string[]>;
  /**
   * Erase everything: searches running now end without adding to anything (the search log, the store tuning, profiles,
   * X-rays, the live feed), and what this search remembers in memory goes.
   */
  reset(): void;
}

/** A page on the retailer's own site (its search or home page's domain), where the app may open product pages. */
export const onRetailerSite = (cfg: RetailerConfig, url: string): boolean => sameSite(url, cfg.homeUrl) || sameSite(url, cfg.searchUrl);

/** How a search got its prices, in a few words. */
export function howWords(strategy: Strategy, via?: 'page' | 'replay'): string {
  if (strategy === 'api') return 'official API';
  if (strategy === 'fetch') return 'direct request';
  return via === 'replay' ? 'reused its page' : 'page load';
}

/**
 * Searches retailers from the phone. Only call this for searches the user starts:
 * no background crawling on users' devices.
 */
/**
 * A store finder's list as JSON, asked straight from the phone for `zip`. Empty when it can't be had, so the finder's
 * page is tried instead. `asked`: its address was made from the ZIP or its center, so the list is for the ZIP.
 */
async function storesFromJson(url: string, zip: string, timeoutMs: number, origin?: LatLng, asked = false): Promise<{ stores: NearbyStore[]; tie: ZipTie }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: controller.signal });
    if (!res.ok) return { stores: [], tie: 'none' };
    const list = nearbyList({ sources: [{ label: `response ${url}`, text: await res.text() }] }, origin, zip);
    return asked ? { ...list, tie: 'asked' } : list;
  } catch {
    return { stores: [], tie: 'none' };
  } finally {
    clearTimeout(timer);
  }
}

/** What the search layer can ask of the app. */
export interface SearchHooks {
  /** A search for `query` gave products at the store before (in the phone's saved prices, say). */
  worked?: (retailerId: string, query: string) => boolean;
}

/** A page this small (its elements, and its words) with no product data is nearly empty: see 'tiny_page'. */
const TINY_PAGE = { elements: 150, chars: 400 };

/** A search that isn't sent, because its store (or every way of searching it) is cooling down. */
const coolingFailed = (strategy: Strategy, c: CoolDown) =>
  new SearchFailed([{ strategy, ok: false, reason: 'cooling_down', detail: coolWords(c), until: c.until, ms: 0 }]);

/** How a search's list was read, for "Found in" and the X-ray. */
const readerNote = (read?: ListRead): ReaderNote | undefined =>
  read ? { by: read.by, ...(read.missed ? { missed: true } : {}), ...(read.suspect ? { suspect: read.suspect } : {}), ...(read.preferred ? { preferred: true } : {}) } : undefined;

/**
 * `tuner`: how hard each store may be pushed, and its cool-downs, from how its searches go (see tuning.ts); the app's
 * own by default. `profiles`: where each store's results are, learned from its searches (see profiles.ts); the app
 * passes its own (parserProfiles), kept across rules changes; tests get a fresh one each.
 */
export function createRetailerSearch(
  pool: WebViewPool,
  configVersion: string,
  tuner: StoreTuner = storeTuner,
  profiles: ProfileBook = new ProfileBook(),
  hooks: SearchHooks = {},
): RetailerSearch {
  const failures: FailureRecord[] = [];
  // Counts resets (see reset): a search running at one ends without adding to anything.
  let epoch = 0;
  // Searches that never went out: the user skipped the store's bot check while they waited to load a page.
  const unsent = new WeakSet<Error>();
  const details = new Map<string, { at: number; value: ProductDetails }>();
  const reading = new Map<string, Promise<ProductDetails>>();
  const nutrition = createNutritionLookup((url, init) => fetch(url, init));
  const attemptListeners = new Set<(entry: AttemptEntry) => void>();
  const log = (cfg: RetailerConfig | { id: string; name: string }, what: string, ok: boolean, text: string) =>
    pool.feed.add({ at: Date.now(), retailerId: cfg.id, retailer: cfg.name, what, ok, text });
  const record = (entry: Omit<AttemptEntry, 'at' | 'rules'>) => {
    const full: AttemptEntry = { ...entry, at: Date.now(), rules: configVersion };
    attemptListeners.forEach((listener) => listener(full));
  };

  // Searches each store gave products for, and its empty answers in a row to searches that had given some: two of
  // those is a quiet block (see emptyBlock).
  const worked = new Map<string, Set<string>>();
  const empties = new Map<string, number>();
  const norm = (query: string) => query.trim().toLowerCase().replace(/\s+/g, ' ');
  const workedBefore = (cfg: RetailerConfig, query: string) => !!worked.get(cfg.id)?.has(norm(query)) || !!hooks.worked?.(cfg.id, query);

  /** A cool-down or rest started: in the search log (Store health, and after the app reopens) and the live feed. */
  const noteCool = (cfg: RetailerConfig, c: CoolDown) => {
    const way = c.way === 'replay' ? { strategy: 'webview' as const, via: 'replay' as const } : c.way ? { strategy: c.way } : {};
    record({ retailerId: cfg.id, kind: 'cooldown', ...way, ok: false, reason: c.kind, ms: 0, until: c.until, ...(c.said ? { said: c.said } : {}) });
    log(cfg, isRest(c) ? 'rest' : 'cool-down', false, coolWords(c));
    const minutes = Math.round((c.until - c.from) / 60_000);
    reportNote({ note: 'cooldown', retailer: cfg.id, ...(c.way ? { way: c.way } : {}), block: c.kind, ...(c.said ? { said: c.said } : {}), minutes, configVersion });
  };

  /** Every store failing within seconds of each other: the connection, noted once, and said in the feed. */
  const noteDrop = (drop: ConnectionDrop) => {
    record({ retailerId: CONNECTION_ID, kind: 'connection', ok: false, reason: 'connection', ms: drop.to - drop.from, until: drop.to + CONNECTION_WINDOW_MS, stores: drop.stores });
    const called = drop.lifted ? `, so ${drop.lifted === 1 ? 'a cool-down was' : `${drop.lifted} cool-downs were`} called off` : '';
    pool.feed.add({ at: Date.now(), retailerId: CONNECTION_ID, retailer: 'Connection', what: 'dropped', ok: false, text: `${drop.stores.length} stores failed within seconds: this phone’s connection, not the stores${called}` });
    reportNote({ note: 'connection', stores: drop.stores, seconds: Math.round((drop.to - drop.from) / 1000), lifted: drop.lifted, configVersion });
  };

  /**
   * No results for a search that gave some at the store before: a store can hide its results from a phone it doesn't
   * want, instead of saying so. Two in a row is a quiet block, and cools the store down.
   */
  const emptyBlock = (cfg: RetailerConfig, query: string, run: Run, reason?: string): { kind: BlockKind; said: string } | undefined => {
    if (reason !== undefined && reason !== 'no_payload' && reason !== 'no_products_on_page') return undefined;
    if (run.emptied || !workedBefore(cfg, query)) return undefined;
    run.emptied = true;
    const n = (empties.get(cfg.id) ?? 0) + 1;
    empties.set(cfg.id, n);
    return n >= 2 ? { kind: 'empty', said: `no results for ${n} searches that gave some before` } : undefined;
  };

  /** What a search taught the store's profile: it matched, it missed, or one more search the general reader read. */
  const teach = (cfg: RetailerConfig, result: StrategyResult) => {
    const read = result.read;
    if (!read) return;
    if (read.by === 'profile') {
      profiles.matched(cfg.id);
      return;
    }
    if (read.missed) profiles.missed(cfg.id);
    const o = observationOf(read, Date.now(), result.products.map((p) => p.id));
    const learned = o ? profiles.observe(cfg.id, o) : undefined;
    if (!learned) return;
    log(cfg, 'profile', true, `learned where its results are: ${whereWords(learned)}`);
    reportNote({ note: 'profile', retailer: cfg.id, where: whereWords(learned), searches: learned.searches, configVersion });
  };

  const missed = (lane: WebViewQueue) => {
    lane.stats.replayMisses += 1;
    lane.replayMisses += 1;
    if (lane.replayMisses >= REPLAY_MISSES_ALLOWED) lane.template = null;
  };

  // What was learned of each store's request taking a smaller page size, by store and address: kept across its page
  // loads, so a store that doesn't take one isn't asked again and again.
  const leanKnown = new Map<string, 'on' | 'off'>();
  const leanKey = (cfg: RetailerConfig, url: string) => `${cfg.id} ${url.replace(/[?#].*$/, '')}`;

  /**
   * How a store's search is read: its profile first, when it has one (see profiles.ts), and the general reader when
   * that doesn't match, or when a bigger list that fits the search is there and the profile's is small or off it. Told
   * what was searched and how many products the store usually gives, for the wrong-list rule (see judgeList). A plain
   * request (`plain`) gets the page without the responses its scripts fetch later: a profile that reads one of those
   * isn't tried there, and doesn't count as missing.
   */
  const readerFor = (cfg: RetailerConfig, query: string, plain = false): { parse?: Parser; profile?: ParserProfile } => {
    const base = PARSERS[cfg.parser];
    if (!base) return {};
    const usual = profiles.usual(cfg.id);
    const told = { query, ...(usual !== undefined ? { usual } : {}) };
    const general: Parser = (p, ctx) => base(p, { ...ctx, ...told });
    const profile = cfg.parser === 'autoDetect' ? profiles.get(cfg.id) : undefined;
    if (!profile || (plain && profile.source.kind === 'request')) return { parse: general };
    const parse: Parser = (p, ctx) => {
      const mine = readWithProfile(profile, p, { ...ctx, ...told });
      if (mine.payloadFound && !mine.read?.suspect) return mine;
      const other = general(p, ctx);
      const better = other.payloadFound && other.products.length > mine.products.length && other.read?.fits !== false && !other.read?.suspect;
      if (mine.payloadFound && !better) return mine;
      return other.payloadFound ? { ...other, read: { ...(other.read ?? { by: 'general' }), missed: true } } : other;
    };
    return { parse, profile };
  };

  /** A replay the store refused (HTTP 401, 403 or 429): that way of searching it may cool down (see search). */
  const replayRefused = (run: Run, status: number) => {
    if (status === 401 || status === 403 || status === 429) run.blocks.push({ kind: status === 429 ? 'limited' : 'refused', said: status === 429 ? '“too many requests” (HTTP 429)' : `HTTP ${status}` });
  };

  /** Sends the search from inside the retailer's already loaded page. Null means: do a page load instead. */
  async function replaySearch(cfg: RetailerConfig, lane: WebViewQueue, parser: Parser, query: string, storeId: string, run: Run): Promise<StrategyResult | null> {
    const template = lane.template;
    if (!template) return null;
    if (template.kind === 'chain') return chainSearch(cfg, lane, template, parser, query, storeId, run);
    let req = applyTemplate(template, cfg, query, storeId);
    if (!req) return null;
    // A store chosen in the app: its number goes in the request, in place of the one the page asked for.
    let pinned = false;
    if (storeId && req.expect === 'json') ({ request: req, pinned } = pinStoreInRequest(req, storeId));
    const ctx = { retailer: cfg.id, storeId };

    /** One request sent from the page, and read: its products when it's usable, or why it couldn't be sent. */
    const ask = async (request: ReplayRequest): Promise<{ res: ReplayResponse; parsed: ParseResult | null } | { error: string }> => {
      const timing: ReplayTiming = { askedAt: Date.now() };
      let res: ReplayResponse;
      try {
        res = await lane.replay(request, run.tune.replayTimeoutMs, timing);
      } catch (e) {
        run.clock.replay(timing, false);
        return { error: reasonOf(e) };
      }
      run.clock.replay(timing);
      if (res.status === 429) run.limited = true;
      replayRefused(run, res.status);
      const payload = replayPayload(res, request.expect, cfg.challengeMarkers, request);
      const parsed = payload ? run.clock.time('parse', () => parser(payload, ctx)) : null;
      // An empty result only counts from a page's own data (a real "no results" page); an API reply with no
      // products is more likely the wrong request.
      const usable = !!parsed && parsed.payloadFound && (parsed.products.length > 0 || request.expect === 'document');
      return { res, parsed: usable ? parsed : null };
    };

    const done = (res: ReplayResponse, parsed: ParseResult, sent: ReplayRequest, bytesSaved = 0): StrategyResult => {
      lane.replayMisses = 0;
      // The request says which store it asked prices for; the page it was sent from, what that store is called (when
      // it's the same store: a store pinned in the request isn't the page's).
      const id = pinned ? storeId : storeIdFromRequest(sent)?.id;
      const page = lane.seenStore && (!lane.seenStore.id || !id || sameStoreId(lane.seenStore.id, id)) ? lane.seenStore : undefined;
      return {
        ...parsed,
        via: 'replay',
        bytes: res.bytes,
        ...(bytesSaved > 0 ? { bytesSaved } : {}),
        store: mergeStores(id ? { id } : undefined, page),
        request: { method: sent.method, url: sent.url },
      };
    };

    // Leaner: where the request says how many results to send, it asks for what the app keeps (see pageSize.ts). An
    // answer that isn't clearly right is checked by asking as the page did.
    const state = template.kind === 'json' && pool.leanRequests && template.lean?.state !== 'off' ? template.lean : undefined;
    const lean = state ? leanRequest(req, state.to) : null;
    /** What the lean answer had, when it needs checking: its products, or -1 when it was unusable. */
    let leanHad: number | undefined;
    if (state && lean && template.kind === 'json') {
      const from = run.clock.spans.length;
      const got = await ask(lean.request);
      if ('error' in got && got.error === 'no_page') return null;
      const products = 'error' in got || !got.parsed ? [] : got.parsed.products;
      const verdict = leanVerdict({ usable: products.length > 0, products: products.length, relevant: looksRelevant(products, query) }, state.to, LEAN_ENOUGH, state.baseline?.products);
      if (!('error' in got) && got.parsed && (verdict === 'good' || verdict === 'ignored' || (verdict === 'fewer' && state.state === 'on'))) {
        // Good: it works. Ignored: the store sent as many as ever, which is a fine answer, but nothing to save.
        if (verdict !== 'fewer') state.state = verdict === 'good' ? 'on' : 'off';
        leanKnown.set(leanKey(cfg, template.request.url), state.state === 'off' ? 'off' : 'on');
        const saved = verdict === 'ignored' ? 0 : leanSaving(state.baseline, { chars: got.res.text?.length ?? 0, bytes: got.res.bytes, products: products.length }, LEAN_ENOUGH);
        return done(got.res, got.parsed, lean.request, saved);
      }
      run.clock.failSince(from);
      if (!('error' in got)) run.extraBytes += got.res.bytes ?? 0;
      leanHad = verdict === 'fewer' ? products.length : -1;
    }

    const from = run.clock.spans.length;
    const got = await ask(req);
    if ('error' in got) {
      // The page went away before the request could go out; that says nothing about the template.
      if (got.error !== 'no_page') missed(lane);
      return null;
    }
    if (!got.parsed) {
      run.clock.failSince(from);
      run.extraBytes += got.res.bytes ?? 0;
      missed(lane);
      return null;
    }
    if (!looksRelevant(got.parsed.products, query)) {
      run.clock.failSince(from);
      run.extraBytes += got.res.bytes ?? 0;
      // Results for the query the page was loaded with mean the swapped request was ignored: the template is
      // broken. Results that fit neither query may just be how the retailer names things; this one query
      // falls back to a page load either way.
      if (template.kind === 'json' && mentionsQuery(got.parsed.products, template.query)) missed(lane);
      return null;
    }
    // The page's own request worked where the lean one didn't, or had more: the store doesn't take a smaller size.
    if (state && template.kind === 'json' && leanHad !== undefined && (leanHad < 0 || got.parsed.products.length > leanHad)) {
      state.state = 'off';
      leanKnown.set(leanKey(cfg, template.request.url), 'off');
    }
    return done(got.res, got.parsed, req);
  }

  /**
   * A replay in two steps (see learnChain): the page's search for the new query, for its results' ids, then the page's
   * request for products by id, with those ids. Null means: do a page load instead.
   */
  async function chainSearch(
    cfg: RetailerConfig,
    lane: WebViewQueue,
    template: Extract<ReplayTemplate, { kind: 'chain' }>,
    parser: Parser,
    query: string,
    storeId: string,
    run: Run,
  ): Promise<StrategyResult | null> {
    const first = applyTemplate(template, cfg, query, storeId);
    if (!first) return null;
    const send = async (request: ReplayRequest): Promise<ReplayResponse | { error: string }> => {
      const timing: ReplayTiming = { askedAt: Date.now() };
      try {
        const res = await lane.replay(storeId ? pinStoreInRequest(request, storeId).request : request, run.tune.replayTimeoutMs, timing);
        run.clock.replay(timing);
        if (res.status === 429) run.limited = true;
        replayRefused(run, res.status);
        return res;
      } catch (e) {
        run.clock.replay(timing, false);
        return { error: reasonOf(e) };
      }
    };
    const from = run.clock.spans.length;
    /** Unusable: counted in the data meter, and as a miss when it says the template is wrong. */
    const unusable = (bytes: number, miss: boolean) => {
      run.clock.failSince(from);
      run.extraBytes += bytes;
      if (miss) missed(lane);
      return null;
    };
    const ids = await send(first);
    if ('error' in ids) return ids.error === 'no_page' ? null : unusable(0, true);
    if (!(ids.status >= 200 && ids.status < 400)) return unusable(ids.bytes ?? 0, true);
    // No ids: maybe no results at all. The page load says.
    const list = chainIds(template, ids.text);
    if (!list.length) return unusable(ids.bytes ?? 0, false);
    const second = swapIds(template.detail, template.asked, list);
    if (!second) return unusable(ids.bytes ?? 0, true);
    const got = await send(second);
    if ('error' in got) return got.error === 'no_page' ? null : unusable(ids.bytes ?? 0, true);
    const bytes = (ids.bytes ?? 0) + (got.bytes ?? 0);
    const payload = replayPayload(got, 'json', cfg.challengeMarkers, second);
    const parsed = payload ? run.clock.time('parse', () => parser(payload, { retailer: cfg.id, storeId })) : null;
    if (!parsed?.payloadFound || !parsed.products.length) return unusable(bytes, true);
    if (!looksRelevant(parsed.products, query)) return unusable(bytes, !!mentionsQuery(parsed.products, template.query));
    lane.replayMisses = 0;
    const id = storeId || storeIdFromRequest(second)?.id;
    const page = lane.seenStore && (!lane.seenStore.id || !id || sameStoreId(lane.seenStore.id, id)) ? lane.seenStore : undefined;
    return { ...parsed, via: 'replay', bytes, store: mergeStores(id ? { id } : undefined, page), request: { method: second.method, url: second.url } };
  }

  async function searchViaWebView(cfg: RetailerConfig, query: string, storeId: string, opts: SearchOptions, run: Run): Promise<StrategyResult> {
    const began = Date.now();
    const { parse: parser, profile } = readerFor(cfg, query);
    if (!parser) throw new StrategyError(`unknown_parser_${cfg.parser}`);
    const { clock, tune } = run;

    await keepStoreSet(cfg, storeId);
    const lane = pool.lane(cfg.id, cfg.name);
    if (lane.context !== storeId) {
      lane.reset();
      lane.context = storeId;
    }
    // Requests at once from its page, as the store's tuning allows.
    lane.maxReplays = tune.replays;
    // A page script reads the rendered page, and a store cookie only rides a page load, so both need page loads.
    const replayable = pool.replayEnabled && cfg.replay !== false && !cfg.pageScript && !cfg.cookieTemplate;

    if (replayable) {
      // Another search may be loading this retailer's page right now. Wait for it rather than queue a second
      // load: it leaves a page to replay in, and its results may show what to replay.
      const waited = Date.now();
      while (lane.loading()) await lane.settled();
      clock.add('wait', waited, Date.now());
      // Replays that the store refused rest while they cool down: page loads go on.
      if (lane.template && lane.hasPage() && !tuner.cooling(cfg.id, 'replay')) {
        const hit = await replaySearch(cfg, lane, parser, query, storeId, run);
        if (hit) return hit;
      }
    }

    const { url, cookie } = buildRequest(cfg, query, storeId);
    const ctx = { retailer: cfg.id, storeId };
    const waitFor = cfg.waitFor ?? 'auto';
    // Results that arrive from the page's own API calls are taken as soon as they're in, not once the page goes quiet.
    // Each streamed response is read once, as it arrives: the parser takes the largest list among them anyway, so
    // reading all of them again with each new one would only cost the phone time.
    const readOnce = new WeakMap<PageSource, ParseResult>();
    const readEach = (p: WebViewPayload) =>
      (p.sources ?? []).map((source) => {
        let read = readOnce.get(source);
        if (!read) {
          read = clock.time('parse', () => parser({ href: p.href, sources: [source] }, ctx), true);
          readOnce.set(source, read);
        }
        return read;
      });
    /**
     * The largest list that fits the query, among the responses one by one: a bigger unrelated one can't hide it, and a
     * small one the wrong-list rule suspects (a carousel beside the results) doesn't count as the results.
     */
    const bestFitting = (reads: ParseResult[]) =>
      reads
        .filter((r) => r.payloadFound && r.products.length > 0 && looksRelevant(r.products, query) && !r.read?.suspect)
        .reduce<ParseResult | undefined>((best, r) => (!best || r.products.length > best.products.length ? r : best), undefined);
    // A store whose profile reads a response waits for that response, unless the profile has stopped matching.
    const waitsFor = profile?.source.kind === 'request' && (profile.misses ?? 0) < STALE_MISSES ? profile.source : undefined;
    const accept =
      waitFor === 'auto' && !cfg.pageScript
        ? (p: WebViewPayload): boolean | 'now' => {
            const early = bestFitting(readEach(p));
            if (!early || early.products.length < MIN_EARLY_PRODUCTS) return false;
            // Where the store's profile says its results are; or the answer to the search's own request (it carries
            // the query), with a full page of results: whatever else the page loads now doesn't matter, so the load ends
            // at once. Otherwise related responses get a moment.
            if (early.read?.by === 'profile') return 'now';
            return early.products.length >= PRODUCTS_KEPT && learnTemplate(early.origin, query)?.kind === 'json' ? 'now' : true;
          }
        : undefined;
    // The page went quiet before any of that: a list the wrong-list rule suspects, or no sign yet of the list the
    // store's profile reads, is waited past (the page still gives up when nothing new comes for a while).
    const settle = accept
      ? (p: WebViewPayload): boolean => {
          if (waitsFor && !(p.sources ?? []).some((s) => sourceMatches(waitsFor, s))) return false;
          const best = readEach(p)
            .filter((r) => r.payloadFound && r.products.length > 0 && looksRelevant(r.products, query))
            .reduce<ParseResult | undefined>((a, r) => (!a || r.products.length > a.products.length ? r : a), undefined);
          return !best?.read?.suspect;
        }
      : undefined;
    const from = clock.spans.length;
    const timing: LoadTiming = { queuedAt: Date.now() };
    // The user skipped this store's bot check since this search began: its page load would only meet the check again.
    if (lane.skippedAt >= began) {
      const skipped = new StrategyError('challenge_cancelled', `${cfg.name}’s bot check was skipped`);
      unsent.add(skipped);
      throw skipped;
    }
    // Another store chosen, or everything erased, while the page loads: nothing is kept from it in the lane.
    const resets = lane.resets;
    let payload;
    try {
      payload = await lane.run({
        url,
        cookie: cookie || undefined,
        pageScript: cfg.pageScript,
        challengeMarkers: cfg.challengeMarkers,
        timeoutMs: tune.pageTimeoutMs,
        retailerName: cfg.name,
        waitFor,
        keepPage: replayable,
        accept,
        settle,
        light: pool.lightPages,
        reportChallenge: opts.challenge === 'report',
        timing,
      });
    } catch (e) {
      clock.load(timing, false);
      // Waiting behind a page load whose bot check the user skipped: it never loaded (see WebViewQueue.cancel).
      if ((e as { unsent?: unknown } | null)?.unsent === true) {
        const skipped = new StrategyError('challenge_cancelled', `${cfg.name}’s bot check was skipped`);
        unsent.add(skipped);
        throw skipped;
      }
      const reason = reasonOf(e);
      const said = (e as { detail?: unknown } | null)?.detail;
      throw new StrategyError(
        reason,
        reason === 'timeout' ? `${cfg.name}’s page didn’t finish within ${Math.round(tune.pageTimeoutMs / 1000)} s.` : typeof said === 'string' ? said : undefined,
      );
    }
    clock.load(timing);
    // A bot check the page passed by itself, hidden, is worth a word in the timeline.
    if (timing.check?.unseen && timing.check.to !== undefined) clock.note(`its bot check passed by itself, in ${seconds(timing.check.to - timing.check.from)}`);

    let parsed = clock.time('parse', () => parser(payload, ctx));
    if (!parsed.payloadFound) {
      clock.failSince(from);
      // Nearly empty, and no product data: a store that won't say it blocked the phone often answers like this.
      const size = payload.size;
      const tiny = !!size && size.chars >= 0 && size.elements < TINY_PAGE.elements && size.chars < TINY_PAGE.chars;
      throw new StrategyError(tiny ? 'tiny_page' : 'no_payload', describePage(payload, cfg.name), { bytes: payload.bytes });
    }
    // The largest list isn't always the results (a carousel of deals, say): when it doesn't fit the query and one of
    // the responses has a list that does, that one is taken.
    if (accept && parsed.products.length && !looksRelevant(parsed.products, query)) {
      const fitting = clock.time('parse', () => bestFitting(readEach(payload)));
      if (fitting) parsed = fitting;
    }
    // A load that ended on its page's own say, not as its results streamed in: where its products were, and whether
    // that response streamed in (see the speed test's timeline).
    if (accept && timing.ended && timing.ended !== 'results' && parsed.source) {
      const where = parsed.source.replace(/\s*\(\d+\)$/, '');
      const streamed = (timing.streamed ?? []).some((label) => label.replace(/\?.*$/, '').slice(0, 120) === where);
      clock.note(`its products were in ${where.replace(/^response /, '')}, which ${streamed ? 'streamed in' : 'never streamed in'}`);
    }
    const current = lane.resets === resets;
    // A lane whose replays keep missing stays on page loads until its page is unloaded and it starts fresh.
    if (current && replayable && lane.replayMisses < REPLAY_MISSES_ALLOWED) {
      let template = learnTemplate(parsed.origin, query, LEAN_TO);
      if (template?.kind === 'json' && template.lean) {
        // The page's own answer, to count what smaller ones save; and what this store's request did before.
        const request = template.request;
        const source = payload.sources?.find((src) => src.request === request);
        if (source) template.lean.baseline = { chars: source.text.length, products: parsed.products.length };
        template.lean.state = leanKnown.get(leanKey(cfg, request.url)) ?? 'trial';
      }
      // Products asked for by id, after a search that answered with their ids (Instacart's storefronts): replayed in two
      // steps, the search and then the products.
      const origin = parsed.origin;
      if (!template && origin?.kind === 'response' && origin.request) {
        const text = payload.sources?.find((src) => src.request === origin.request)?.text;
        if (text) template = learnChain(origin.request, text, payload.sources ?? [], query);
      }
      if (template) lane.template = template;
    }
    // Which store these prices are for: the number in the request that brought them (or in the page's own data, when
    // they were in the page), and the name the page shows.
    const id =
      parsed.origin?.kind === 'response'
        ? storeIdFromRequest(parsed.origin.request)?.id
        : parsed.origin?.kind === 'document'
          ? storeIdFromPageData(payload.nextDataText)?.id
          : undefined;
    const store = mergeStores(id ? { id } : undefined, parseStoreLabel(payload.store));
    if (current) lane.seenStore = store ?? null;
    // The page asked for the store the site picked, and another was chosen in the app: ask for that one's prices
    // from this page, with its number in the request. If the site won't have it, the page's prices stand, and say so.
    if (current && storeId && id && !sameStoreId(id, storeId) && lane.template?.kind === 'json') {
      const pinned = await replaySearch(cfg, lane, parser, query, storeId, run);
      if (pinned) return pinned;
    }
    const asked = parsed.origin?.kind === 'response' && parsed.origin.request ? parsed.origin.request : { method: 'GET', url };
    return { ...parsed, via: 'page', bytes: payload.bytes, store, request: { method: asked.method, url: asked.url } };
  }

  const runStrategy = (strategy: Strategy, cfg: RetailerConfig, query: string, storeId: string, opts: SearchOptions, run: Run): Promise<StrategyResult> => {
    if (strategy === 'fetch') {
      return searchViaFetch(cfg, query, storeId, run.clock, readerFor(cfg, query, true).parse).then((r) => ({
        ...r,
        request: { method: 'GET', url: buildRequest(cfg, query, storeId).url },
      }));
    }
    if (strategy === 'webview') return searchViaWebView(cfg, query, storeId, opts, run);
    if (cfg.api === 'kroger') {
      const t0 = Date.now();
      return searchKrogerApi(query, storeId, cfg.timeoutMs, { retailerId: cfg.id, host: hostOf(cfg.homeUrl) ?? undefined, chain: cfg.apiChain }).finally(() =>
        run.clock.add('api', t0, Date.now()),
      );
    }
    return Promise.reject(new StrategyError('no_api_for_retailer'));
  };

  const search = async (cfg: RetailerConfig, query: string, storeId: string, only?: Strategy, opts: SearchOptions = {}): Promise<SearchOutcome> => {
    const started = Date.now();
    const attempts: Attempt[] = [];
    // Everything erased while this search runs (see reset): it ends there, and adds to nothing.
    const mine = epoch;
    const stopped = (strategy: Strategy) => new SearchFailed([...attempts, { strategy, ok: false, reason: 'reset', ms: Date.now() - started }]);
    const order = only ? [only] : cfg.strategies;
    const kind = opts.kind ?? 'search';
    // A way asked for on purpose, in Diagnostics: it goes out whatever is cooling down there.
    const asked = !!only && kind === 'search';
    // The ways the store is searched with, for whether a block cools down one of them or the whole store.
    const ways: Way[] = cfg.strategies.includes('webview') ? [...cfg.strategies, 'replay'] : [...cfg.strategies];
    // A store cooling down after a block isn't asked at all until its retry time: nothing goes out, nor counts in its hour.
    const cooling = asked ? undefined : tuner.cooling(cfg.id);
    if (cooling) {
      log(cfg, query, false, `not searched: ${coolWords(cooling).replace(/^Cooling/, 'cooling')}`);
      throw coolingFailed(order[0], cooling);
    }
    // A way of searching it that's cooling down is skipped; one that's resting gives way when it's the last one left.
    const held = order.map((strategy, i) => {
      if (asked) return undefined;
      const c = tuner.cooling(cfg.id, strategy);
      return c && (!isRest(c) || i < order.length - 1) ? c : undefined;
    });
    if (held.every(Boolean)) throw coolingFailed(order[0], held.reduce((a, b) => (b!.until > a!.until ? b : a))!);
    // No more than a person would ask of one store in an hour: past that, the search doesn't go out.
    if (!politeness.take(cfg.id)) {
      log(cfg, query, false, `paused: ${politeness.perHour} searches here in the last hour`);
      throw new SearchFailed([{ strategy: order[0], ok: false, reason: 'polite_limit', ms: 0 }]);
    }

    const clock = new SpanLog();
    const timing = (): SearchTiming => ({ startedAt: started, endedAt: Date.now(), spans: clock.spans, ...(clock.notes.length ? { notes: clock.notes } : {}) });
    // How hard this store may be pushed right now, from how its searches have gone (see tuning.ts).
    const run: Run = { clock, tune: tuner.get(cfg.id, tuningBase(cfg)), limited: false, checked: false, blocked: false, blocks: [], emptied: false, extraBytes: 0 };
    // A way the store isn't searched with (asked for with `only`, to test it) says nothing about how its searches go:
    // its tuning hears of it only when the store pushed back, on a site the store is searched on (its website, for a
    // plain request or its page; an official API is another door).
    const door = (s: Strategy) => (s === 'api' ? 'api' : 'site');
    const tells = (strategy: Strategy) =>
      cfg.strategies.includes(strategy) || ((run.checked || run.limited) && cfg.strategies.some((s) => door(s) === door(strategy)));
    // What this search teaches the store's profile: not the phone vs. server test's, nor a way asked for on purpose.
    const learns = !only && (kind === 'search' || kind === 'coverage') && cfg.parser === 'autoDetect';
    // Searches, the phone vs. server test's too, tell the connection from the stores (see ConnectionWatch in tuning.ts).
    const outcomes = kind === 'search' || kind === 'coverage' || kind === 'versus';
    /** A way the store is searched with failed: it may rest, or cool down, and the search log says so. */
    const failedWay = (way: Way, block?: { kind: BlockKind; said?: string }) => {
      if (way !== 'replay' && !cfg.strategies.includes(way)) return;
      const c = tuner.failed(cfg.id, way, { ...(block ? { block } : {}), ways });
      if (c) noteCool(cfg, c);
    };
    /** Replays the store refused along the way: that way of searching it cools down, while page loads go on. */
    const refusedReplays = () => {
      for (const block of run.blocks.splice(0)) {
        run.blocked = true;
        failedWay('replay', block);
      }
    };
    // A store that pushed back gets a pause between searches.
    const pause = tuner.delay(cfg.id, run.tune.gapMs);
    if (pause > 0) {
      const t0 = Date.now();
      await new Promise((resolve) => setTimeout(resolve, pause));
      clock.add('wait', t0, Date.now());
      if (mine !== epoch) throw stopped(order[0]);
    }
    for (let i = 0; i < order.length; i++) {
      const strategy = order[i];
      const hold = held[i];
      // A way of searching that's cooling down or resting is skipped for now (see above).
      if (hold) {
        attempts.push({ strategy, ok: false, reason: 'resting', ms: 0, until: hold.until });
        continue;
      }
      const t0 = Date.now();
      const from = clock.spans.length;
      try {
        const found = await runStrategy(strategy, cfg, query, storeId, opts, run);
        if (mine !== epoch) throw stopped(strategy);
        refusedReplays();
        if (found.read?.suspect) clock.note(`the list may not be the results: ${found.read.suspect}`);
        // What answers thrown away along the way moved counts too.
        const result = run.extraBytes ? { ...found, bytes: (found.bytes ?? 0) + run.extraBytes } : found;
        tuner.worked(cfg.id, strategy);
        const attempt: Attempt = { strategy, ok: true, ms: Date.now() - t0, count: result.products.length, via: result.via, bytes: result.bytes };
        attempts.push(attempt);
        const read = result.read ? { read: result.read.by === 'general' && result.read.missed ? ('missed' as const) : result.read.by, ...(result.read.suspect ? { suspect: true } : {}) } : {};
        reportAttempt({ ...attempt, retailer: cfg.id, configVersion, ...read });
        record({ retailerId: cfg.id, kind, strategy, ok: true, ms: attempt.ms, via: result.via, bytes: result.bytes, ...(result.bytesSaved ? { bytesSaved: result.bytesSaved } : {}) });
        if (tells(strategy)) tuner.record(cfg.id, tuningSample(run, true, attempt.ms, strategy));
        if (outcomes) tuner.outcome(cfg.id, true);
        // Where its results are, for the store's profile.
        if (learns) teach(cfg, result);
        // Searches that gave products; and one that gave none, where it gave some before, may be a quiet block.
        if (result.products.length) {
          worked.set(cfg.id, (worked.get(cfg.id) ?? new Set<string>()).add(norm(query)));
          empties.delete(cfg.id);
        } else if (cfg.strategies.includes(strategy)) {
          const quiet = emptyBlock(cfg, query, run);
          const c = quiet ? tuner.failed(cfg.id, strategy, { block: quiet, ways }) : undefined;
          if (c) noteCool(cfg, c);
        }
        const reader = readerNote(result.read);
        // What the store sent, for the price X-ray: in memory only.
        const at = Date.now();
        for (const p of result.products.slice(0, EVIDENCE_KEPT)) {
          const raw = result.evidence?.[p.id];
          if (!raw) continue;
          priceEvidence.record({
            ...raw,
            retailerId: cfg.id,
            productId: p.id,
            price: p.price,
            at,
            strategy,
            via: result.via,
            ms: attempt.ms,
            bytes: result.bytes,
            source: result.source,
            ...(reader ? { reader } : {}),
            ...(result.request ? { request: { method: result.request.method, url: redactUrl(result.request.url) } } : {}),
          });
        }
        const data = result.bytes ? ` · ${bytesText(result.bytes)}${result.bytesSaved ? `, ${bytesText(result.bytesSaved)} saved` : ''}` : '';
        log(cfg, query, true, `${result.products.length} products · ${seconds(attempt.ms)}${data} · ${howWords(strategy, result.via)}`);
        return {
          retailer: cfg.name,
          products: result.products,
          strategy,
          ms: Date.now() - started,
          attempts,
          via: result.via,
          source: result.source,
          note: result.note,
          bytes: result.bytes,
          ...(result.bytesSaved ? { bytesSaved: result.bytesSaved } : {}),
          store: result.store,
          timing: timing(),
          ...(reader ? { reader } : {}),
        };
      } catch (e) {
        if (mine !== epoch) throw stopped(strategy);
        // It never went out: the store's bot check was skipped while it waited. Nothing to learn from, nor count.
        if (unsent.has(e as Error)) throw new SearchFailed([...attempts, { strategy, ok: false, reason: 'challenge_cancelled', ms: 0 }], timing());
        refusedReplays();
        clock.failSince(from);
        const attempt: Attempt = { strategy, ok: false, reason: reasonOf(e), detail: detailOf(e), ms: Date.now() - t0, ...infoOf(e) };
        // A bot check or "too many requests", to any way of searching, is the store pushing back; a refusal, a block.
        if (BOT_CHECKS.has(attempt.reason!)) run.checked = true;
        if (/(^|_)429$/.test(attempt.reason!)) run.limited = true;
        const block = blockOf(attempt) ?? (cfg.strategies.includes(strategy) ? emptyBlock(cfg, query, run, attempt.reason) : undefined);
        if (block && (block.kind === 'blocked' || block.kind === 'refused' || block.kind === 'tiny')) run.blocked = true;
        attempts.push(attempt);
        reportAttempt({ ...attempt, retailer: cfg.id, configVersion });
        record({ retailerId: cfg.id, kind, strategy, ok: false, reason: attempt.reason, ms: attempt.ms });
        log(cfg, query, false, `${howWords(strategy)} failed: ${reasonWords(attempt.reason)}`);
        failures.unshift({ retailer: cfg.name, query, strategy, reason: attempt.reason!, detail: attempt.detail, at: Date.now() });
        failures.splice(MAX_FAILURES_KEPT);
        failedWay(strategy, block);
        if (attempt.reason === 'page_crashed') tuner.crashed();
        if (attempt.reason === 'challenge_cancelled') break; // The user chose to stop.
      }
    }
    const last = attempts.filter((a) => a.reason !== 'resting').pop();
    if (last && tells(last.strategy)) tuner.record(cfg.id, tuningSample(run, false, Date.now() - started, last.strategy, last.reason));
    // Every store failing within seconds of each other is the phone's connection, not the stores.
    if (outcomes && last && last.reason !== 'challenge_cancelled') {
      const drop = tuner.outcome(cfg.id, false, cfg.sisterOf ?? cfg.id);
      if (drop) noteDrop(drop);
    }
    throw new SearchFailed(attempts, timing());
  };

  const readFromSite = async (cfg: RetailerConfig, query: string): Promise<SearchOutcome | null> => {
    const started = Date.now();
    const url = query.trim() ? buildRequest(cfg, query, '').url : cfg.homeUrl;
    const lane = pool.lane(cfg.id, cfg.name);
    const payload = await lane.browse({ url, retailerName: cfg.name, pageScript: cfg.pageScript, purpose: 'read' });
    // The user may have picked another store there, which a kept page and its replays wouldn't know.
    lane.reset();
    if (!payload) return null;

    const parser = cfg.pageScript ? PARSERS[cfg.parser] : PARSERS.autoDetect;
    const parsed = (parser ?? PARSERS.autoDetect)(payload, { retailer: cfg.id, storeId: '' });
    const attempt: Attempt = {
      strategy: 'webview',
      ok: parsed.products.length > 0,
      reason: parsed.products.length > 0 ? undefined : 'no_products_on_page',
      ms: Date.now() - started,
      count: parsed.products.length,
    };
    reportAttempt({ ...attempt, retailer: cfg.id, configVersion });
    if (!attempt.ok) throw new SearchFailed([attempt]);
    return {
      retailer: cfg.name,
      products: parsed.products,
      strategy: 'webview',
      ms: attempt.ms,
      attempts: [attempt],
      source: parsed.source,
      note: 'Read from the page you had open.',
    };
  };

  // After a store changes, searches must start from a fresh page: a kept page and its replays point at the old one.

  // Stores set by the site's own request, this session (see keepStoreSet).
  const sessionStores = new Map<string, Promise<void>>();
  const sessionKey = (cfg: RetailerConfig, storeId: string) => `${cfg.id}:${storeId}`;

  const setStoreAuto = async (cfg: RetailerConfig, zip: string, target?: { id?: string; name?: string }): Promise<StoreSetResult> => {
    const finder = cfg.storeFinder;
    if (!finder?.auto || !finder.url.includes('{{zip}}')) return { ok: false, reason: 'not_automatic' };
    // The site's own request takes the store's number: there's no button to find it by name.
    const request = finder.setRequest;
    const id = target?.id;
    if (request && !isStoreNumber(id)) return { ok: false, reason: 'no_store_number' };
    const lane = pool.lane(cfg.id, cfg.name);
    const t0 = Date.now();
    // Without a ZIP, the store is set again for this session (see keepStoreSet): the finder's page lists none.
    const near = zip ? ` near ${zip}` : ' again, for this session';
    try {
      const payload = await lane.run({
        url: fill(finder.url, { zip: encodeURIComponent(zip) }),
        challengeMarkers: cfg.challengeMarkers,
        timeoutMs: STORE_SET_TIMEOUT_MS,
        retailerName: cfg.name,
        task:
          request && id
            ? { kind: 'storeRequest', request: storeSetRequest(request, id) }
            : { kind: 'setStore', buttons: finder.buttons ?? STORE_BUTTONS, target },
      });
      let label: string | undefined;
      let store: KnownStore | undefined;
      if (request && id) {
        sessionStores.set(sessionKey(cfg, id), Promise.resolve());
        label = target?.name || undefined;
        store = { id, ...(label ? { name: label } : {}) };
      } else {
        const pressed = (payload.pageResult as { label?: unknown } | undefined)?.label;
        label = typeof pressed === 'string' && pressed ? pressed : undefined;
        store = storeFromFinder(payload.pageResult, zip);
      }
      record({ retailerId: cfg.id, kind: 'store', strategy: 'webview', ok: true, ms: Date.now() - t0 });
      log(cfg, 'store', true, `store set${near}${store ? `: ${storeLine(store)}` : ''}`);
      return { ok: true, label, store };
    } catch (e) {
      record({ retailerId: cfg.id, kind: 'store', strategy: 'webview', ok: false, reason: reasonOf(e), ms: Date.now() - t0 });
      log(cfg, 'store', false, `couldn’t set the store${zip ? '' : ' again'}: ${reasonWords(reasonOf(e))}`);
      return { ok: false, reason: reasonOf(e) };
    } finally {
      lane.reset();
    }
  };

  /**
   * A store set by the site's own request (see StoreSetRequest) can last only as long as the app's session, in a
   * cookie the WebView forgets when the app closes (Whole Foods'): it's set again before the session's first search
   * there. Once a session, whatever the answer: the search then says which store its prices are for.
   */
  const keepStoreSet = (cfg: RetailerConfig, storeId: string): Promise<void> => {
    const finder = cfg.storeFinder;
    if (!finder?.auto || !finder.setRequest || !isStoreNumber(storeId)) return Promise.resolve();
    const key = sessionKey(cfg, storeId);
    let done = sessionStores.get(key);
    if (!done) {
      done = setStoreAuto(cfg, '', { id: storeId }).then(() => undefined);
      sessionStores.set(key, done);
    }
    return done;
  };

  const storesNear = async (cfg: RetailerConfig, zip: string, radiusMiles: number, origin?: LatLng): Promise<StoresNearResult> => {
    const t0 = Date.now();
    const api = cfg.api === 'kroger' && krogerApiConfigured();
    // How the list was had: the official API, the finder's JSON, or its page.
    let how: Strategy = api ? 'api' : 'webview';
    // The finder's page met a bot check that passed by itself, hidden (see CHALLENGE_GRACE_MS).
    let checkPassed = false;
    try {
      let stores: NearbyStore[] = [];
      // How the list is tied to the ZIP: an API and a finder's JSON are asked for it; a finder's page has to take it.
      let tie: ZipTie = 'asked';
      const finder = cfg.storeFinder;
      if (api) {
        stores = (await krogerStoresNear(zip, radiusMiles, cfg.timeoutMs, cfg.apiChain)).map((s) => withMiles(s, origin));
      } else if (!finder?.url) {
        return { ok: false, reason: 'no_store_finder' };
      } else {
        // The finder's JSON when it answers with some, straight from the phone: no page to load. One that asks for a
        // place on the map gets the ZIP code's center (never the phone's), when the phone's geocoder gave it. Asked
        // with the ZIP or its center, its list is for the ZIP, whether or not the ZIP's digits are in its address.
        const place = origin ? { lat: origin.lat.toFixed(4), lng: origin.lng.toFixed(4) } : undefined;
        if (finder.jsonUrl && (place || !/\{\{(?:lat|lng)\}\}/.test(finder.jsonUrl))) {
          const url = fill(finder.jsonUrl, { zip: encodeURIComponent(zip), radius: String(radiusMiles), ...place });
          ({ stores, tie } = await storesFromJson(url, zip, cfg.timeoutMs, origin, /\{\{(?:zip|lat|lng)\}\}/.test(finder.jsonUrl)));
          if (stores.length) how = 'fetch';
        }
        if (!stores.length) {
          const lane = pool.lane(cfg.id, cfg.name);
          const timing: LoadTiming = { queuedAt: Date.now() };
          try {
            const payload = await lane.run({
              url: fill(finder.url, { zip: encodeURIComponent(zip) }),
              challengeMarkers: cfg.challengeMarkers,
              timeoutMs: STORE_LIST_TIMEOUT_MS,
              retailerName: cfg.name,
              // Loaded with the capture script: the store list comes in one of the page's own requests.
              waitFor: 'auto',
              light: pool.lightPages,
              reportChallenge: true,
              task: { kind: 'listStores', zip },
              timing,
            });
            checkPassed = !!timing.check?.unseen;
            const result = payload.pageResult as { cards?: unknown; zipIn?: unknown } | undefined;
            const cards = Array.isArray(result?.cards) ? (result.cards as StoreCard[]) : undefined;
            const zipIn = result?.zipIn === 'url' || result?.zipIn === 'box' || result?.zipIn === 'next' || result?.zipIn === 'none' ? result.zipIn : undefined;
            ({ stores, tie } = nearbyList({ ...payload, cards, zipIn }, origin, zip));
          } finally {
            // A store finder isn't a search page to replay in.
            lane.reset();
          }
        }
      }
      stores = sortNearest(stores);
      const ms = Date.now() - t0;
      record({ retailerId: cfg.id, kind: 'store', strategy: how, ok: stores.length > 0, ms, ...(stores.length ? {} : { reason: 'no_stores_listed' }) });
      const passed = checkPassed ? ' · its bot check passed by itself' : '';
      // A list the finder didn't search the ZIP for may be for wherever the site thinks the phone is.
      const untied = stores.length && tie === 'none' ? ' · its finder didn’t take the ZIP' : '';
      log(cfg, `stores near ${zip}`, stores.length > 0, stores.length ? `${stores.length} stores · ${seconds(ms)}${untied}${passed}` : `no stores listed${passed}`);
      return stores.length ? { ok: true, stores, how: api ? 'api' : 'finder', tie } : { ok: false, reason: 'no_stores_listed' };
    } catch (e) {
      record({ retailerId: cfg.id, kind: 'store', strategy: how, ok: false, reason: reasonOf(e), ms: Date.now() - t0 });
      log(cfg, `stores near ${zip}`, false, `couldn’t list its stores: ${reasonWords(reasonOf(e))}`);
      return { ok: false, reason: reasonOf(e) };
    }
  };

  const signIn = async (cfg: RetailerConfig): Promise<void> => {
    const lane = pool.lane(cfg.id, cfg.name);
    try {
      await lane.browse({ url: cfg.member?.signInUrl ?? cfg.homeUrl, retailerName: cfg.name, purpose: 'signin' });
      log(cfg, 'sign-in', true, 'signed in on its own site');
    } finally {
      // Searches start again from a fresh page, now with the account's cookies.
      lane.reset();
    }
  };

  const pageLane = () => pool.lane(PAGE_LANE, 'Pages');

  const readProduct = async (cfg: RetailerConfig, product: Product): Promise<ProductDetails> => {
    const url = product.url;
    if (!url || !/^https:\/\//i.test(url)) throw new StrategyError('no_link');
    // Hidden pages stay on the retailer's own site, as searches do.
    if (!onRetailerSite(cfg, url)) throw new StrategyError('other_site');
    const hit = details.get(url);
    if (hit && Date.now() - hit.at < DETAILS_TTL_MS) return hit.value;
    // Opening the same product twice while its page loads shares the one load.
    const pending = reading.get(url);
    if (pending) return pending;

    const read = (async () => {
      // One page load at a time at each store: a page load of the store's own searches goes first.
      const storeLane = pool.lane(cfg.id, cfg.name);
      while (storeLane.loading()) await storeLane.settled();
      const t0 = Date.now();
      try {
        const payload = await pageLane().run({
          url,
          challengeMarkers: cfg.challengeMarkers,
          timeoutMs: PAGE_TIMEOUT_MS,
          retailerName: cfg.name,
          waitFor: 'details',
          light: pool.lightPages,
        });
        const value = parseProductPage(payload, product);
        details.set(url, { at: Date.now(), value });
        record({ retailerId: cfg.id, kind: 'product', strategy: 'webview', ok: value.count > 0, ms: Date.now() - t0, bytes: payload.bytes });
        const data = payload.bytes ? ` · ${bytesText(payload.bytes)}` : '';
        log(cfg, 'product page', value.count > 0, `${value.count} ${value.count === 1 ? 'detail' : 'details'} · ${seconds(Date.now() - t0)}${data}`);
        return value;
      } catch (e) {
        record({ retailerId: cfg.id, kind: 'product', strategy: 'webview', ok: false, reason: reasonOf(e), ms: Date.now() - t0 });
        log(cfg, 'product page', false, `failed: ${reasonWords(reasonOf(e))}`);
        throw e instanceof StrategyError ? e : new StrategyError(reasonOf(e));
      } finally {
        reading.delete(url);
      }
    })();
    reading.set(url, read);
    return read;
  };

  const viewProduct = async (cfg: RetailerConfig, url: string): Promise<void> => {
    if (!/^https:\/\//i.test(url) || !onRetailerSite(cfg, url)) throw new StrategyError('other_site');
    await pageLane().browse({ url, retailerName: cfg.name, purpose: 'view' });
  };

  const readRecipe = async (url: string): Promise<Recipe> => {
    if (!/^https:\/\/[^/\s]+\.[^/\s]+/i.test(url)) throw new StrategyError('not_a_link');
    const host = /^https:\/\/([^/?#]+)/i.exec(url)![1].replace(/^www\./, '');
    const site = { id: `recipe:${host}`, name: host };
    const t0 = Date.now();
    try {
      const payload = await pageLane().run({
        url,
        challengeMarkers: DEFAULT_CHALLENGE_MARKERS,
        timeoutMs: PAGE_TIMEOUT_MS,
        retailerName: host,
        waitFor: 'details',
        light: pool.lightPages,
      });
      const recipe = parseRecipe(payload);
      if (!recipe) throw new StrategyError('no_recipe');
      log(site, 'recipe', true, `${recipe.ingredients.length} ingredients · ${seconds(Date.now() - t0)}`);
      return recipe;
    } catch (e) {
      log(site, 'recipe', false, `failed: ${reasonWords(reasonOf(e))}`);
      throw e instanceof StrategyError ? e : new StrategyError(reasonOf(e));
    }
  };

  /** One fees page, hidden, read for its words. */
  const readFeesPage = async (cfg: RetailerConfig, url: string): Promise<FeePageRead & { ms: number; bytes?: number }> => {
    const t0 = Date.now();
    try {
      const payload = await pageLane().run({
        url,
        challengeMarkers: cfg.challengeMarkers,
        timeoutMs: PAGE_TIMEOUT_MS,
        retailerName: cfg.name,
        waitFor: 'text',
        light: pool.lightPages,
        // Nobody is waiting on a fees page: a bot check fails the read, and the store rules' estimates stand.
        reportChallenge: true,
      });
      const fees = parseFeePage(payload.text ?? '', { planWords: (cfg.online?.plans ?? []).map((p) => p.name) });
      const ms = Date.now() - t0;
      const ok = fees.count > 0;
      record({ retailerId: cfg.id, kind: 'fees', strategy: 'webview', ok, ms, bytes: payload.bytes, ...(ok ? {} : { reason: 'no_fees' }) });
      const data = payload.bytes ? ` · ${bytesText(payload.bytes)}` : '';
      log(cfg, 'fees page', ok, `${ok ? `${fees.count} ${fees.count === 1 ? 'figure' : 'figures'}` : 'no fees found'} · ${seconds(ms)}${data}`);
      return { ...fees, ms, bytes: payload.bytes };
    } catch (e) {
      record({ retailerId: cfg.id, kind: 'fees', strategy: 'webview', ok: false, reason: reasonOf(e), ms: Date.now() - t0 });
      log(cfg, 'fees page', false, `failed: ${reasonWords(reasonOf(e))}`);
      throw e instanceof StrategyError ? e : new StrategyError(reasonOf(e));
    }
  };

  const readFees = async (cfg: RetailerConfig): Promise<FeesPageResult> => {
    const main = cfg.online?.feesUrl;
    const pickup = cfg.online?.pickupFeesUrl;
    const pages = [main, pickup].filter((u): u is string => !!u && /^https:\/\//i.test(u));
    if (!pages.length) throw new StrategyError('no_fees_page');
    // One page at a time; what one page gives stands when the other can't be read.
    const reads = new Map<string, FeePageRead & { ms: number; bytes?: number }>();
    let failure: unknown = null;
    for (const url of pages) {
      try {
        reads.set(url, await readFeesPage(cfg, url));
      } catch (e) {
        failure ??= e;
      }
    }
    if (!reads.size) throw failure;
    const all = [...reads.values()];
    const merged = mergeFeeReads(main ? reads.get(main) : undefined, pickup ? reads.get(pickup) : undefined);
    const bytes = all.reduce((sum, r) => sum + (r.bytes ?? 0), 0);
    return { ...merged, url: pages.join(' '), ms: all.reduce((sum, r) => sum + r.ms, 0), ...(bytes ? { bytes } : {}) };
  };

  /**
   * A page of the store's that lists things (its weekly ad, the account's coupons), or one to clip a coupon on, hidden,
   * on the store's own lane: one page load at a time there. Only pages on the store's own site; each is a visit, like a
   * search, and counts toward the store's hour. A sign-in page it's sent to isn't loaded (see guardSignIn).
   */
  const listPage = async (cfg: RetailerConfig, url: string, task: StoreTask): Promise<{ payload: WebViewPayload; ms: number }> => {
    if (!/^https:\/\//i.test(url) || !onRetailerSite(cfg, url)) throw new StrategyError('other_site');
    if (!politeness.take(cfg.id)) throw new StrategyError('polite_limit');
    const t0 = Date.now();
    const payload = await pool.lane(cfg.id, cfg.name).run({
      url,
      challengeMarkers: cfg.challengeMarkers,
      timeoutMs: task.kind === 'clip' ? CLIP_TIMEOUT_MS : LIST_PAGE_TIMEOUT_MS,
      retailerName: cfg.name,
      // Loaded with the capture script: the items come in the page's own requests.
      waitFor: 'auto',
      light: pool.lightPages,
      // Nobody is waiting on a bot check here: the read fails instead.
      reportChallenge: true,
      guardSignIn: true,
      task,
    });
    return { payload, ms: Date.now() - t0 };
  };

  /** A read that failed: in the log (unless it never went out, past the hourly limit) and the live feed, as an error. */
  const listFailed = (cfg: RetailerConfig, kind: 'ad' | 'coupons' | 'clip', what: string, e: unknown, t0: number): StrategyError => {
    const reason = reasonOf(e);
    if (reason !== 'polite_limit') record({ retailerId: cfg.id, kind, strategy: 'webview', ok: false, reason, ms: Date.now() - t0 });
    log(cfg, what, false, reason === 'polite_limit' ? `paused: ${politeness.perHour} visits here in the last hour` : `failed: ${reasonWords(reason)}`);
    return e instanceof StrategyError ? e : new StrategyError(reason);
  };

  const readAd = async (cfg: RetailerConfig, url: string): Promise<AdPageResult> => {
    const t0 = Date.now();
    let payload: WebViewPayload;
    let ms: number;
    try {
      ({ payload, ms } = await listPage(cfg, url, { kind: 'readList' }));
    } catch (e) {
      throw listFailed(cfg, 'ad', 'weekly ad', e, t0);
    }
    const ad = parseAd(payload, Date.now());
    const ok = ad.items.length > 0;
    record({ retailerId: cfg.id, kind: 'ad', strategy: 'webview', ok, ms, bytes: payload.bytes, ...(ok ? {} : { reason: 'no_ad' }) });
    const data = payload.bytes ? ` · ${bytesText(payload.bytes)}` : '';
    log(cfg, 'weekly ad', ok, `${ok ? `${ad.items.length} sale ${ad.items.length === 1 ? 'item' : 'items'}` : 'no sale items found'} · ${seconds(ms)}${data}`);
    const store = mergeStores(parseStoreLabel(payload.store));
    return { ...ad, url, ms, ...(payload.bytes ? { bytes: payload.bytes } : {}), ...(store ? { store } : {}) };
  };

  const readCoupons = async (cfg: RetailerConfig): Promise<CouponPageResult> => {
    const url = cfg.coupons?.url;
    if (!url) throw new StrategyError('no_coupons_page');
    const t0 = Date.now();
    let payload: WebViewPayload;
    let ms: number;
    try {
      ({ payload, ms } = await listPage(cfg, url, { kind: 'readList' }));
    } catch (e) {
      throw listFailed(cfg, 'coupons', 'coupons', e, t0);
    }
    const list = parseCoupons(payload, Date.now());
    const ok = list.coupons.length > 0;
    const reason = ok ? undefined : list.signedOut ? 'signed_out' : 'no_coupons';
    record({ retailerId: cfg.id, kind: 'coupons', strategy: 'webview', ok, ms, bytes: payload.bytes, ...(reason ? { reason } : {}) });
    const clipped = list.coupons.filter((c) => c.clipped).length;
    log(cfg, 'coupons', ok, `${ok ? `${list.coupons.length} coupons, ${clipped} clipped${list.signedOut ? ', signed out' : ''}` : reasonWords(reason)} · ${seconds(ms)}`);
    if (reason) throw new StrategyError(reason);
    return { ...list, url, ms, ...(payload.bytes ? { bytes: payload.bytes } : {}) };
  };

  const clipCoupon = async (cfg: RetailerConfig, coupon: Coupon): Promise<ClipResult> => {
    const url = cfg.coupons?.url;
    if (!url) throw new StrategyError('no_coupons_page');
    const t0 = Date.now();
    let payload: WebViewPayload;
    let ms: number;
    try {
      ({ payload, ms } = await listPage(cfg, url, { kind: 'clip', target: { id: coupon.id, title: coupon.title }, buttons: cfg.coupons?.clipButtons ?? CLIP_BUTTONS }));
    } catch (e) {
      throw listFailed(cfg, 'clip', 'clip coupon', e, t0);
    }
    const r = (payload.pageResult ?? {}) as { clipped?: unknown; already?: unknown; gone?: unknown };
    const result: ClipResult = { clipped: r.clipped === true, ...(r.already === true ? { already: true } : {}), ...(r.gone === true ? { gone: true } : {}) };
    record({ retailerId: cfg.id, kind: 'clip', strategy: 'webview', ok: result.clipped, ms, bytes: payload.bytes, ...(result.clipped ? {} : { reason: 'not_clipped' }) });
    log(cfg, 'clip coupon', result.clipped, result.clipped ? (result.already ? 'it was clipped already' : `clipped · ${seconds(ms)}`) : 'the page didn’t confirm it');
    return result;
  };

  const viewCoupons = async (cfg: RetailerConfig): Promise<void> => {
    const url = cfg.coupons?.url;
    if (!url || !/^https:\/\//i.test(url) || !onRetailerSite(cfg, url)) throw new StrategyError('no_coupons_page');
    const lane = pool.lane(cfg.id, cfg.name);
    try {
      await lane.browse({ url, retailerName: cfg.name, purpose: 'account' });
      log(cfg, 'coupons', true, 'opened on its own site');
    } finally {
      // Searches start again from a fresh page.
      lane.reset();
    }
  };

  // One page load per retailer at a time for suggestions, however fast the typing.
  const preparing = new Map<string, Promise<boolean>>();
  const prepareSuggestions = (cfg: RetailerConfig): Promise<boolean> => {
    const pending = preparing.get(cfg.id);
    if (pending) return pending;
    const run = (async () => {
      const lane = pool.lane(cfg.id, cfg.name);
      while (lane.loading()) await lane.settled();
      if (lane.hasPage()) return true;
      // Busy with something the user is looking at, like a store visit: not now.
      if (!lane.isIdle()) return false;
      try {
        const payload = await lane.run({
          url: cfg.homeUrl,
          challengeMarkers: cfg.challengeMarkers,
          timeoutMs: SUGGEST_PAGE_TIMEOUT_MS,
          retailerName: cfg.name,
          waitFor: 'loaded',
          keepPage: true,
          light: pool.lightPages,
          // Nobody is waiting on a bot check for suggestions: the store is left out instead.
          reportChallenge: true,
        });
        if (!lane.seenStore) lane.seenStore = mergeStores(parseStoreLabel(payload.store)) ?? null;
        log(cfg, 'suggestions', true, `page loaded to ask its search box${payload.bytes ? ` · ${bytesText(payload.bytes)}` : ''}`);
        return true;
      } catch (e) {
        log(cfg, 'suggestions', false, `couldn’t load its page: ${reasonWords(reasonOf(e))}`);
        return false;
      }
    })();
    preparing.set(cfg.id, run);
    void run.finally(() => preparing.delete(cfg.id));
    return run;
  };

  const suggest = async (cfg: RetailerConfig, text: string): Promise<string[]> => {
    const clean = text.trim().replace(/\s+/g, ' ');
    if (clean.length < 2 || !(await prepareSuggestions(cfg))) return [];
    const t0 = Date.now();
    try {
      const res = await pool.lane(cfg.id, cfg.name).suggest(clean, SUGGEST_TIMEOUT_MS);
      const what = res.items.length
        ? `${res.items.length} ${res.items.length === 1 ? 'suggestion' : 'suggestions'} · ${seconds(Date.now() - t0)}`
        : res.how === 'no_box'
          ? 'no search box on its page'
          : 'no suggestions';
      log(cfg, clean.toLowerCase(), res.items.length > 0, what);
      return res.items;
    } catch {
      return [];
    }
  };

  const onAttempt = (listener: (entry: AttemptEntry) => void) => {
    attemptListeners.add(listener);
    return () => {
      attemptListeners.delete(listener);
    };
  };

  const reset = () => {
    epoch += 1;
    failures.length = 0;
    details.clear();
    nutrition.clear();
    worked.clear();
    empties.clear();
    leanKnown.clear();
    sessionStores.clear();
  };

  return {
    search,
    readFromSite,
    evidence: (retailerId: string, productId: string) => priceEvidence.get(retailerId, productId),
    signIn,
    setStoreAuto,
    storesNear,
    recentFailures: () => [...failures],
    readProduct,
    lookupNutrition: nutrition.lookup,
    viewProduct,
    readRecipe,
    readFees,
    readAd,
    readCoupons,
    clipCoupon,
    viewCoupons,
    onAttempt,
    prepareSuggestions,
    suggest,
    reset,
  };
}
