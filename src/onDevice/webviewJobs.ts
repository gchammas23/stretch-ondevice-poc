import type { LoadTiming } from './timing';
import type { PageSource } from './types';
import type { StoreRequest } from './webviewScript';

// What a WebView lane is asked to do (a hidden page load, a store task, a visible visit), what it hands back, and how
// the messages pages post are read. The lane itself is in webviewQueue.ts.

/**
 * Instead of reading results: press the store finder's "make this my store" button, on the first store or a given
 * one (see storeScript), or send the site's own request that does it (see storeRequestScript), or list the stores it
 * finds near a ZIP code (see storeListScript); read a page that lists things, a weekly ad or an account's coupons (see
 * listPageScript); or clip one coupon, because the user asked in the app (see clipScript).
 */
export type StoreTask =
  | { kind: 'setStore'; buttons: string[]; target?: { id?: string; name?: string } }
  | { kind: 'storeRequest'; request: StoreRequest }
  | { kind: 'listStores'; zip: string }
  | { kind: 'readList'; scrolls?: number }
  | { kind: 'clip'; target: { id?: string; title: string }; buttons?: string[] };

/** One hidden page load for a search, or for setting the store. */
export interface WebViewJob {
  url: string;
  /** Sent as a Cookie header. react-native-webview only attaches headers to the first request. */
  cookie?: string;
  pageScript?: string;
  challengeMarkers: string[];
  timeoutMs: number;
  /** Shown to the user if the retailer asks for a bot check. */
  retailerName: string;
  /** See ExtractOptions in webviewScript.ts. 'details' reads a product's own page; 'text', what a page says. */
  waitFor?: 'nextData' | 'auto' | 'details' | 'loaded' | 'text';
  /** Leave the page loaded afterwards, so later searches can be replayed inside it. */
  keepPage?: boolean;
  task?: StoreTask;
  /**
   * Checked against the responses the page streams in as they arrive: true once they hold the results, so the load
   * finishes shortly after instead of waiting for the page to go quiet; 'now' when nothing that matters is still to
   * come (the search's own answer, whole), so it finishes at once.
   */
  accept?: (payload: WebViewPayload) => boolean | 'now';
  /**
   * Asked when the page's requests go quiet before `accept` took anything (see askQuiet in webviewScript.ts), with what
   * streamed in so far: true to end the load with what the page has, false to wait for more (the list so far may be a
   * carousel beside the results, which come later). The page still gives up when nothing new comes for a while.
   */
  settle?: (payload: WebViewPayload) => boolean;
  /** Load without images, fonts or video (see lightScript). A bot check is shown with everything, reloaded. */
  light?: boolean;
  /** Fail with 'challenge' on a bot check instead of showing it: for checks nobody is waiting on. */
  reportChallenge?: boolean;
  /** Filled in as the load goes (see LoadTiming), for the speed test's timeline. */
  timing?: LoadTiming;
  /**
   * A page of the user's account (their coupons): if the site sends it to a sign-in page, that page isn't loaded and
   * the job fails with 'signed_out'. Nothing is ever injected into a sign-in page (see allows).
   */
  guardSignIn?: boolean;
}

/** A visible visit: the user searches on the site, then taps Read products; or looks at a page. */
export interface BrowseJob {
  url: string;
  retailerName: string;
  pageScript?: string;
  /**
   * 'read' offers Read products. 'view' shows a page (a product's) to look at, with only Close. 'signin' is the store's
   * own sign-in page: nothing is injected into it at all, so nothing typed there can reach the app. 'account' is a
   * page of the user's account (their coupons, to clip there), which may ask them to sign in: nothing is injected
   * into it either.
   */
  purpose?: 'read' | 'view' | 'signin' | 'account';
}

export interface WebViewPayload {
  href: string;
  /** The page's title, for explaining a failure. */
  title?: string;
  nextDataText?: string;
  sources?: PageSource[];
  pageResult?: unknown;
  /** About how much data the page moved. */
  bytes?: number;
  /** The store the page says it's set to, as it writes it (see storeLabel in webviewScript.ts). */
  store?: string;
  /** A page read for what it says ('text'): its visible text. */
  text?: string;
  /** How much the page was: its elements, and its words when it had few elements (-1 when it had many). */
  size?: { elements: number; chars: number };
}

/** What a replayed request returned (see replayScript). */
export interface ReplayResponse {
  status: number;
  url: string;
  type: string;
  /** JSON responses: the body. */
  text?: string;
  /** HTML responses: the embedded data, the title, and the whole page only when it's short. */
  nextDataText?: string | null;
  ld?: string[];
  title?: string;
  short?: string;
  /** How much data the response was, about. */
  bytes?: number;
}

/** What the host renders. A new object only when the load changes. */
export interface ActiveLoad {
  id: number;
  /** Bumps after a bot check; the host remounts the WebView on change. */
  round: number;
  /** 'idle': a finished search page kept loaded (hidden) for replays. */
  phase: 'hidden' | 'challenge' | 'browse' | 'idle';
  url: string;
  cookie?: string;
  retailerName: string;
  purpose?: BrowseJob['purpose'];
  /** For injectedJavaScriptBeforeContentLoaded: the response capture hook, when this load needs it. */
  beforeScript?: string;
  /** For injectedJavaScript on this load. */
  script: string;
}

/** What the site suggested for what was typed into its search box (see suggestScript). */
export interface SuggestResponse {
  items: string[];
  /** 'list': the site's suggestion list; 'response': its suggestion data; 'none'; 'no_box': no search box found. */
  how: string;
}

/** An error with what the page showed, in words, for the search's failure (see StrategyError). */
export function failure(reason: string, detail?: string): Error {
  return Object.assign(new Error(reason), detail ? { detail } : {});
}

/** How much a page was, as its script counted it (see pageSize in webviewScript.ts). */
export function sizeOf(msg: Record<string, unknown>): WebViewPayload['size'] | undefined {
  const size = msg.size;
  if (typeof size !== 'object' || size === null) return undefined;
  const { elements, chars } = size as { elements?: unknown; chars?: unknown };
  return typeof elements === 'number' && typeof chars === 'number' ? { elements, chars } : undefined;
}

/** The store label a page posted, if any (see storeLabel in webviewScript.ts). */
export function storeText(msg: Record<string, unknown>): string | undefined {
  return typeof msg.store === 'string' && msg.store.trim() ? msg.store.trim().slice(0, 300) : undefined;
}

/** The data a page reported moving (see pageBytes in webviewScript.ts). */
export function usageBytes(msg: Record<string, unknown>): number | undefined {
  const usage = msg.usage;
  if (typeof usage !== 'object' || usage === null) return undefined;
  const bytes = (usage as { bytes?: unknown }).bytes;
  return typeof bytes === 'number' && Number.isFinite(bytes) && bytes >= 0 ? bytes : undefined;
}

export function toSource(s: unknown): PageSource[] {
  if (typeof s !== 'object' || s === null) return [];
  const o = s as Record<string, unknown>;
  if (typeof o.label !== 'string' || typeof o.text !== 'string') return [];
  const source: PageSource = { label: o.label, text: o.text };
  const req = o.request;
  if (typeof req === 'object' && req !== null) {
    const r = req as Record<string, unknown>;
    if (typeof r.method === 'string' && typeof r.url === 'string') {
      const headers: Record<string, string> = {};
      if (typeof r.headers === 'object' && r.headers !== null) {
        for (const [k, v] of Object.entries(r.headers)) if (typeof v === 'string') headers[k] = v;
      }
      source.request = {
        method: r.method,
        url: r.url,
        headers,
        body: typeof r.body === 'string' ? r.body : undefined,
        opaqueBody: r.opaqueBody === true ? true : undefined,
        credentials: r.credentials === 'omit' || r.credentials === 'include' ? r.credentials : 'same-origin',
      };
    }
  }
  return [source];
}
