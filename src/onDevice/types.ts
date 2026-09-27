import type { SearchTiming } from './timing';

export type Strategy = 'fetch' | 'webview' | 'api';

/**
 * Per-retailer rules. Served by the Stretch config service in production,
 * so a retailer fix ships without an app release. See retailers.ts for the bundled defaults.
 */
export interface RetailerConfig {
  /** Stable id, e.g. "walmart". */
  id: string;
  name: string;
  /** Kill switch. */
  enabled: boolean;
  /** Search page URL. {{query}} is URL-encoded; {{storeId}} is inserted as-is. */
  searchUrl: string;
  /** Opened by "Open site" when the query is empty. */
  homeUrl: string;
  /**
   * Cookie header that pins the store, with {{storeId}} where the store number goes.
   * Empty means the retailer uses whatever store the WebView already has, or picks one from location.
   */
  cookieTemplate: string;
  /** Extra request headers for the fetch strategy only. */
  headers?: Record<string, string>;
  /** Strategies to try, in order. */
  strategies: Strategy[];
  /** Parser id, a key of PARSERS in parsers.ts. */
  parser: string;
  /** Official API behind the 'api' strategy. */
  api?: 'kroger';
  /**
   * When the WebView reads the page: 'nextData' as soon as Next.js page data exists (results are in the HTML),
   * 'auto' once prices show up in what the page loads (results arrive from the retailer's own API).
   */
  waitFor?: 'nextData' | 'auto';
  /**
   * Optional JS function expression run inside the WebView, e.g. "function () { ... }".
   * Return a JSON-serializable value once results are on the page, or null to be polled again.
   */
  pageScript?: string;
  /**
   * After the first WebView search, send later searches from inside that loaded page, as the page's own request
   * with the query swapped. Much faster than loading the page again. On unless false; falls back to a page load.
   */
  replay?: boolean;
  /** Substrings of the URL or title (or of a short page) that mean a bot check was served. */
  challengeMarkers: string[];
  timeoutMs: number;
  /** Shown under the store field. */
  storeHint: string;
  /**
   * The retailer's own store finder, to list its stores near a ZIP code. `url` may contain {{zip}}: the phone loads
   * it hidden, types the ZIP into its search box if it has one, and reads the stores it lists (storeListScript).
   * `jsonUrl`: an address of the same finder that answers with the list as JSON ({{zip}}, and {{radius}} in miles),
   * asked straight from the phone first; the page is the fallback.
   * `auto`: the page lists the stores nearest the ZIP, each with a button that makes it the store (e.g. Walmart's
   * "Make this my store"), and the site keeps the store in its cookies, so the app presses the chosen store's button.
   * Otherwise the store's number goes in each search. `buttons` replaces the default wording to look for
   * (STORE_BUTTONS in webviewScript.ts).
   */
  storeFinder?: { url: string; jsonUrl?: string; auto?: boolean; buttons?: string[] };
  /** What we know about this retailer so far. */
  note: string;
  /** Added in the app by the user from a search link (Add a store), not shipped or served. */
  addedByUser?: boolean;
  /**
   * A regional chain that runs on its parent's platform (the parent's id: 'kroger', 'safeway'): the same search
   * pages, store finder and API, so it takes rules only, no code. `region` says where its stores are.
   */
  sisterOf?: string;
  region?: string;
  /**
   * Kroger's API serves every chain Kroger owns: the chain's code in its Locations API, or a word in its stores'
   * names, picks this chain's stores ('KROGER', 'RALPHS').
   */
  apiChain?: string[];
  /** The store's own brands ("Great Value"), for cheaper swaps of the same product. */
  storeBrands?: string[];
  /**
   * The store's loyalty program, when members pay less: what its prices are called ("with Card"), and the page to
   * sign in on, so the phone's searches carry the member's own prices (the home page when not given).
   */
  member?: { program: string; label: string; signInUrl?: string };
  /** What ordering online costs there beyond the items: fees, online prices and plans (see onlineCost.ts). */
  online?: OnlineRules;
  /**
   * The store's own weekly ad: a page on its site listing this week's sale items, read hidden on the phone at most once
   * a day (see adPage.ts). `url` may carry {{storeId}} (the store it's set to) or {{zip}}. `storeUrl`: the same ad for
   * the store the retailer is set to, with {{storeId}}, used when one is set (Safeway's set-store link). `note`: what to
   * know about it, in words ("Walmart has no weekly ad: these are its food rollbacks").
   */
  ad?: { url: string; storeUrl?: string; note?: string };
  /**
   * The store's digital coupons for an account: the page on its site that lists them, read hidden on the phone once the
   * user has signed in on the store's own page (see couponPage.ts), and the program's name ("Kroger digital coupons").
   * `clipButtons`: the words of its clip buttons, when they aren't the usual ones (CLIP_BUTTONS in webviewScript.ts).
   */
  coupons?: { url: string; program: string; clipButtons?: string[] };
  /**
   * Where the store's search results are and how its products read, as a phone learned it from its own searches (see
   * profiles.ts). Shared rules carry the profiles learned so far, so they travel with the rules file.
   */
  profile?: ParserProfile;
}

/**
 * Where one store's search results are, learned on the phone from its searches (see profiles.ts): which of the page's
 * data holds the list, the keys down to the list in it, and the keys from a product down to each of its fields. Later
 * searches read the list there first, and fall back to the general reader when it stops matching.
 */
export interface ParserProfile {
  source: ProfileSource;
  /** Keys from the document down to the list; '*' for any item of an array, or any entry of a map, on the way. */
  list: string[];
  fields: ProfileFields;
  /** Products its searches usually gave: the middle of the lists it was learned from. */
  usual: number;
  learnedAt: number;
  /** Searches whose lists agreed when it was learned. */
  searches: number;
  /** Searches that agreed, the price truth check, or a rules file. */
  how: 'searches' | 'truth' | 'rules';
  /** The last search it read the products of. */
  matchedAt?: number;
  /** Searches in a row it didn't match, and the last of them. */
  misses?: number;
  missedAt?: number;
}

/** A response from this address (and GraphQL operation, where one address serves many), or the page's own data by name. */
export type ProfileSource = { kind: 'request'; host: string; path: string; op?: string } | { kind: 'page'; label: string };

/**
 * Where each of a product's fields is: the ways it was found (keys from the product down to it), in the order to try
 * them. A price's ways go in the order the general reader ranks them, so a product on sale is read at its sale price.
 * A key past a list goes to its first item, as the general reader reads.
 */
export interface ProfileFields {
  id?: string[][];
  name: string[][];
  price: string[][];
  was?: string[][];
  member?: string[][];
  /** What the store calls its member price ("with Card"), from the field it's in. */
  memberLabel?: string;
  unit?: string[][];
  link?: string[][];
  image?: string[][];
  stock?: string[][];
  gtin?: string[][];
  sponsored?: string[][];
}

/** Where the general reader found a list, and how its products read: what a profile is learned from. */
export interface ProfileCandidate {
  source: ProfileSource;
  list: string[];
  fields: ProfileFields;
  count: number;
}

/** How a search's list was chosen and read. */
export interface ListRead {
  /** 'profile': the store's profile read it. 'general': the general reader (autoDetect) found it. */
  by: 'profile' | 'general';
  /** The store has a profile, and it didn't match this time. */
  missed?: boolean;
  /** Where the general reader found the list, and how it reads. */
  candidate?: ProfileCandidate;
  /** Its products' names fit the query; undefined when that can't be told. */
  fits?: boolean;
  /** Why it may not be the store's results (the wrong-list rule), in words; undefined when nothing says so. */
  suspect?: string;
  /** A bigger list that fits the query was taken over the one the general reader ranks first. */
  preferred?: boolean;
}

/** A way to order online. In store is the third way to shop, with nothing to add. */
export type OnlineWay = 'pickup' | 'delivery';

/** A service fee: a share of the order, with a floor and a ceiling. */
export interface ServiceFee {
  pct: number;
  min?: number;
  max?: number;
}

/** What a store charges per order one way (pickup or delivery), as its own pages state it. */
export interface FeeSchedule {
  /** The pickup or delivery fee. With `feeMax`, the lowest of a range that depends on the time slot. */
  fee: number;
  feeMax?: number;
  /** No fee on orders of at least this much. */
  freeOver?: number;
  /** The smallest order the store takes. */
  minimum?: number;
  /** A small-order fee, on orders under `smallUnder`. */
  smallFee?: number;
  smallUnder?: number;
  service?: ServiceFee;
}

/** What a membership changes for one way of ordering. */
export interface PlanPerks {
  /** No fee on orders of at least this much; 0: on every order. */
  freeOver?: number;
  /** The fee members pay instead. */
  fee?: number;
  /** The service fee members pay instead; null: none. */
  service?: ServiceFee | null;
  /** Where the store's online prices are higher than in store: how much higher they are for members, in percent. */
  markup?: number;
}

/** A membership that changes a store's online fees: Walmart+, Target Circle 360, Instacart+... */
export interface OnlinePlan {
  /** The same at every store the plan works at ('instacart-plus'), so one switch covers them all. */
  id: string;
  name: string;
  perYear?: number;
  perMonth?: number;
  pickup?: PlanPerks;
  delivery?: PlanPerks;
  /** What it does, in words, when that's more than the perks say (a cheaper price with a card, perks by store). */
  note?: string;
}

/**
 * What a store's online orders cost beyond the items, as the store rules have it. They're estimates, checked by hand
 * on `checked`, until the phone reads the store's own fees page (`feesUrl`, see feePage.ts), whose figures replace them.
 */
export interface OnlineRules {
  /** When these were checked against the store's own pages: '2026-09-25'. */
  checked: string;
  /** The store's own page stating its fees, read hidden on the phone. */
  feesUrl?: string;
  /**
   * A second page, read too, whose pickup figures come first: where pickup fees are on a page of their own (Kroger's),
   * or a FAQ that covers pickup (Wegmans').
   */
  pickupFeesUrl?: string;
  /** Absent: the store doesn't offer it. */
  pickup?: FeeSchedule;
  delivery?: FeeSchedule;
  /**
   * The store says its online prices are higher than in its stores, for the ways listed: `said` says so in words
   * ("its Same-Day prices are higher than in the warehouse"), and `pct` is about how much, an estimate unless `stated`
   * (the store gives the figure). The prices the phone reads are usually in-store prices, and this is added on top for
   * those ways. `included`: the store's site shows its online prices, so the prices the phone reads already have it;
   * nothing is added, and in store they're lower.
   */
  markup?: { pct: number; ways: OnlineWay[]; said: string; stated?: boolean; included?: boolean };
  plans?: OnlinePlan[];
  /** Anything else to know, in words: who delivers, what varies by store. */
  note?: string;
}

export interface RetailerConfigBundle {
  version: string;
  retailers: RetailerConfig[];
}

/** One product shape for every retailer. */
export interface Product {
  retailer: string;
  storeId: string;
  id: string;
  name: string;
  price: number | null;
  /** The regular price, when `price` is a sale or promo price below it. */
  wasPrice?: number;
  /** A lower price for members of the store's loyalty program ("with Card"), and what the store calls it. */
  memberPrice?: number;
  memberLabel?: string;
  /** `price` is the member price: the user belongs to the program (see member.ts). */
  memberApplied?: boolean;
  priceText?: string;
  unitPriceText?: string;
  imageUrl?: string;
  url?: string;
  inStock?: boolean;
  sponsored?: boolean;
  /** Its barcode (GTIN, UPC or EAN digits), when the store gives one. */
  gtin?: string;
}

/** How the page asked for a JSON response, so the same request can be sent again for another query. */
export interface CapturedRequest {
  method: string;
  /** Absolute URL. */
  url: string;
  /** Lower-case names. Stays on the device: never logged or sent to telemetry. */
  headers?: Record<string, string>;
  /** Text body, when there is one. */
  body?: string;
  /** The body wasn't text (FormData, a stream...), so the request can't be sent again. */
  opaqueBody?: boolean;
  credentials?: 'omit' | 'same-origin' | 'include';
}

/** A JSON document found in or loaded by the page. */
export interface PageSource {
  /** Where it came from: "response <url>", "ld+json", "__APOLLO_STATE__", ... */
  label: string;
  text: string;
  /** For responses the page fetched: the request that fetched it. */
  request?: CapturedRequest;
}

/** Where a parser found its products, so the WebView strategy can learn how to ask for them again. */
export type ProductOrigin =
  /** In the search page's own HTML (Next.js data, JSON-LD): fetch the page for another query and read it. */
  | { kind: 'document' }
  /** In a JSON response the page fetched: resend that request with the query swapped. */
  | { kind: 'response'; request?: CapturedRequest }
  /** Anywhere else (window globals, a pageScript): only a page load can get them. */
  | { kind: 'other' };

/** What a strategy hands to a parser. */
export interface PagePayload {
  /** Fetch strategy: the raw HTML. */
  html?: string;
  /** Final page URL, for resolving relative product links. */
  href?: string;
  /** WebView strategy: the page's title, for explaining a failure. */
  title?: string;
  /** Contents of <script id="__NEXT_DATA__">, when the page has one. */
  nextDataText?: string;
  /** WebView strategy: JSON the page embedded or fetched for itself. */
  sources?: PageSource[];
  /** WebView strategy: return value of the retailer's pageScript. */
  pageResult?: unknown;
  /** About how much data getting this moved. */
  bytes?: number;
}

export interface ParseResult {
  /** False when the page lacks the data this parser expects (layout change or bot check). */
  payloadFound: boolean;
  products: Product[];
  /** Where the products were found, for the test screen and telemetry. */
  source?: string;
  origin?: ProductOrigin;
  /** The store's own data for each product (by id), and where in it the price was: for the price X-ray. */
  evidence?: Record<string, RawProduct>;
  /** How the list was chosen and read: the store's profile, or the general reader (see profiles.ts). */
  read?: ListRead;
}

/** A product as the store's data had it: its JSON, and the path to the price in it ("priceInfo.currentPrice.price"). */
export interface RawProduct {
  json: string;
  pricePath: string;
}

/**
 * What a reader is told: the store and store number; for a search, what was searched (to tell whether a list fits
 * it) and how many products the store usually gives (a much smaller list is suspect, see judgeList).
 */
export interface ParseContext {
  retailer: string;
  storeId: string;
  query?: string;
  usual?: number;
}

export type Parser = (payload: PagePayload, ctx: ParseContext) => ParseResult;

export interface Attempt {
  strategy: Strategy;
  ok: boolean;
  /** Failure reason, e.g. "challenge", "timeout", "no_payload", "http_403". */
  reason?: string;
  /** What the page showed, in words. Stays on the phone: not sent with telemetry. */
  detail?: string;
  ms: number;
  count?: number;
  /** WebView only: a full page load, or a request replayed inside an already loaded page. */
  via?: 'page' | 'replay';
  /** About how much data it moved over the network (see pageBytes in webviewScript.ts). */
  bytes?: number;
  /** A plain request that failed: the HTTP status the store answered with. */
  status?: number;
  /** A search that wasn't sent because the store, or this way of searching it, is cooling down: until when. */
  until?: number;
}

/** A store as the phone learned it: from the retailer's API, its store finder, its page, or a search's request. */
export interface KnownStore {
  /** As the retailer names it: "Sacramento Supercenter", "Kroger Marketplace". */
  name?: string;
  /** Its address, as far as it was shown: "8915 Gerber Rd, Sacramento, CA 95829". */
  address?: string;
  /** The retailer's number for it: "3081", "01400943". */
  id?: string;
}

export interface SearchOutcome {
  retailer: string;
  products: Product[];
  strategy: Strategy;
  ms: number;
  attempts: Attempt[];
  via?: 'page' | 'replay';
  source?: string;
  /** Extra context from the search. */
  note?: string;
  /** About how much data the search that worked moved. */
  bytes?: number;
  /** About how much less data it moved by asking for only the results the app keeps (see pageSize.ts). */
  bytesSaved?: number;
  /** The store the prices are for, as far as the search showed it. */
  store?: KnownStore;
  /** When each part of the search happened, for the speed test's timeline. */
  timing?: SearchTiming;
  /** How its list was read: with the store's profile, or by the general reader (and whether a profile missed). */
  reader?: ReaderNote;
}

/** Which reader found a search's products, for "Found in" and the X-ray. */
export interface ReaderNote {
  by: 'profile' | 'general';
  /** The store's profile didn't match, so the general reader read it, and the phone learns again. */
  missed?: boolean;
  /** The list may not be the store's results (the wrong-list rule), in words. */
  suspect?: string;
  /** A bigger list that fits the search was taken over a smaller one. */
  preferred?: boolean;
}
