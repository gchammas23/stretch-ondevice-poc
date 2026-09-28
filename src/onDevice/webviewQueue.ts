import type { ReplayTemplate } from './replay';
import type { LoadTiming, ReplayTiming } from './timing';
import type { KnownStore, PageSource } from './types';
import {
  captureScript,
  clipScript,
  extractionScript,
  goScript,
  lightScript,
  listPageScript,
  looksLikeSignIn,
  replayScript,
  sameSite,
  stopScript,
  storeListScript,
  storeRequestScript,
  storeScript,
  suggestScript,
  type ReplayRequest,
} from './webviewScript';
import {
  failure,
  sizeOf,
  storeText,
  toSource,
  usageBytes,
  type ActiveLoad,
  type BrowseJob,
  type ReplayResponse,
  type StoreTask,
  type SuggestResponse,
  type WebViewJob,
  type WebViewPayload,
} from './webviewJobs';

export type { ActiveLoad, BrowseJob, ReplayResponse, StoreTask, SuggestResponse, WebViewJob, WebViewPayload } from './webviewJobs';

interface Job {
  id: number;
  mode: 'search' | 'browse';
  nonce: string;
  round: number;
  phase: 'hidden' | 'challenge' | 'browse';
  url: string;
  cookie?: string;
  pageScript?: string;
  challengeMarkers: string[];
  timeoutMs: number;
  retailerName: string;
  waitFor: 'nextData' | 'auto' | 'details' | 'loaded' | 'text';
  keepPage: boolean;
  task?: StoreTask;
  accept?: (payload: WebViewPayload) => boolean | 'now';
  settle?: (payload: WebViewPayload) => boolean;
  light: boolean;
  reportChallenge: boolean;
  guardSignIn: boolean;
  /** Responses streamed in so far, newest first. */
  partial: PageSource[];
  partialHref?: string;
  partialTitle?: string;
  partialBytes?: number;
  partialStore?: string;
  /** Running once `accept` said yes: related responses get a moment to land. */
  acceptTimer?: ReturnType<typeof setTimeout>;
  /** Running while a bot check the page met is given time to pass by itself (see CHALLENGE_GRACE_MS). */
  graceTimer?: ReturnType<typeof setTimeout>;
  /** What the check looked like, for the failure's words (a captcha in a frame of the page). */
  checkDetail?: string;
  purpose?: BrowseJob['purpose'];
  timing?: LoadTiming;
  resolve: (payload: WebViewPayload | null) => void;
  reject: (error: Error) => void;
}

/** Something sent into the kept page that answers by nonce: a replayed search, or suggestions for what's typed. */
interface Replay {
  nonce: string;
  script: (nonce: string) => string;
  /** Replays count toward the lane's stats; suggestions don't. */
  counts: boolean;
  timeoutMs: number;
  resolve: (msg: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
  timing?: ReplayTiming;
}

export const CHALLENGE_TIMEOUT_MS = 120_000;
/**
 * How long a hidden page gets to pass a bot check by itself before the check counts. Imperva's and PerimeterX's
 * checks often run unseen, in a script, and the page moves on: H-E-B's took 3 s on a phone (2026-09-27). Until then the
 * page stays hidden, and a check that's still there afterwards is shown, or reported, as before.
 */
export const CHALLENGE_GRACE_MS = 8_000;
export const BROWSE_TIMEOUT_MS = 15 * 60_000;
/** After the streamed responses first hold the results: how long to wait for closely related ones. */
export const ACCEPT_SETTLE_MS = 700;
/** A kept page that nothing has used for this long is unloaded. */
export const IDLE_PAGE_MS = 120_000;
/** Replays in flight at once inside one page. */
export const MAX_REPLAYS = 3;
const MAX_MESSAGE_CHARS = 8_000_000;
/** A page's text, as much as the app keeps of it: fees pages say what they have to well within this. */
const MAX_TEXT_CHARS = 150_000;
const CAPTURE = captureScript();
const LIGHT = lightScript();

const makeNonce = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
const str = (v: unknown) => (typeof v === 'string' ? v : undefined);

/**
 * Runs page loads one at a time for one WebView, and replays inside the page a search left loaded.
 * A plain class outside React, so its mutable state never lives in render;
 * the host component reads it through useSyncExternalStore.
 */
export class WebViewQueue {
  private queue: Job[] = [];
  private current: Job | null = null;
  /** The last search page, left loaded (hidden) for replays. */
  private resident: ActiveLoad | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private nextId = 1;
  private snapshot: ActiveLoad | null = null;
  private listeners = new Set<() => void>();
  private inject: ((script: string) => void) | null = null;
  private replays = new Map<string, Replay>();
  private waiting: Replay[] = [];
  private settleWaiters: (() => void)[] = [];

  /** What to replay in the kept page. Set by the search layer after a page load; dropped with the page. */
  template: ReplayTemplate | null = null;
  /** Replays in a row that came back unusable. */
  replayMisses = 0;
  /** The store the kept page was loaded for. A different one needs a fresh page. */
  context = '';
  /** Which store the kept page said it's set to, for searches replayed in it. Dropped with the page. */
  seenStore: KnownStore | null = null;
  /** Set by the pool: frees a WebView before this lane loads a page. */
  beforeMount: (() => void) | null = null;
  lastUsed = 0;
  maxReplays = MAX_REPLAYS;
  idleMs = IDLE_PAGE_MS;
  challengeGraceMs = CHALLENGE_GRACE_MS;
  /** How long the user has to finish a bot check once it's on screen (see onPresented); tests shorten it. */
  challengeTimeoutMs = CHALLENGE_TIMEOUT_MS;
  /** When the user last skipped a bot check here: searches that were waiting to load a page since then don't. */
  skippedAt = 0;
  /** Counts resets: a search whose page load was running at one leaves the lane as it found it (see reset). */
  resets = 0;
  readonly stats = { pageLoads: 0, replays: 0, replayMisses: 0 };

  constructor(
    readonly key = 'default',
    readonly label = key,
  ) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): ActiveLoad | null => this.snapshot;

  /** A hidden load for a search. */
  run = (job: WebViewJob): Promise<WebViewPayload> =>
    new Promise<WebViewPayload>((resolve, reject) => {
      if (job.timing) {
        job.timing.queuedAt = Date.now();
        job.timing.url = job.url;
      }
      this.enqueue({
        ...job,
        mode: 'search',
        phase: 'hidden',
        waitFor: job.waitFor ?? 'nextData',
        keepPage: !!job.keepPage,
        light: !!job.light,
        reportChallenge: !!job.reportChallenge,
        guardSignIn: !!job.guardSignIn,
        resolve: (payload) => (payload ? resolve(payload) : reject(new Error('no_payload'))),
        reject,
      });
    });

  /** A visible visit. Resolves with the page's data when the user taps Read products, or null if they close it. */
  browse = (job: BrowseJob): Promise<WebViewPayload | null> =>
    new Promise<WebViewPayload | null>((resolve, reject) => {
      this.enqueue({
        ...job,
        mode: 'browse',
        phase: 'browse',
        challengeMarkers: [],
        timeoutMs: BROWSE_TIMEOUT_MS,
        waitFor: 'auto',
        keepPage: false,
        light: false,
        reportChallenge: false,
        guardSignIn: false,
        resolve,
        reject,
      });
    });

  /**
   * Sends one request from inside the kept page. Waits for a page load that is running or queued;
   * rejects with 'no_page' when there's no page to send it from. `timing` is filled in as it goes.
   */
  replay = (req: ReplayRequest, timeoutMs: number, timing?: ReplayTiming): Promise<ReplayResponse> =>
    new Promise<ReplayResponse>((resolve, reject) => {
      if (timing) timing.askedAt = Date.now();
      this.waiting.push({
        nonce: makeNonce(),
        script: (nonce) => replayScript(nonce, req),
        counts: true,
        timeoutMs,
        resolve: (msg) => resolve(this.toResponse(msg)),
        reject,
        timing,
      });
      this.pump();
    });

  /**
   * Types `text` into the kept page's search box and resolves with what the site suggests. Like a replay, it waits
   * for a page load that is running or queued, and rejects with 'no_page' when there's no page.
   */
  suggest = (text: string, timeoutMs: number): Promise<SuggestResponse> =>
    new Promise<SuggestResponse>((resolve, reject) => {
      this.waiting.push({
        nonce: makeNonce(),
        script: (nonce) => suggestScript(nonce, text),
        counts: false,
        timeoutMs,
        resolve: (msg) =>
          resolve({
            items: Array.isArray(msg.items) ? msg.items.filter((i): i is string => typeof i === 'string').slice(0, 12) : [],
            how: str(msg.how) ?? 'none',
          }),
        reject,
      });
      this.pump();
    });

  /** A page is loaded and free for replays right now. */
  hasPage = (): boolean => !!this.resident && !this.current && !this.queue.length;

  /** A search page load is running or waiting. */
  loading = (): boolean => this.current?.mode === 'search' || this.queue.some((j) => j.mode === 'search');

  /** Nothing running or waiting at all. */
  isIdle = (): boolean => !this.current && !this.queue.length && !this.replays.size && !this.waiting.length;

  /** Requests being sent from inside the kept page right now. */
  replaysInFlight = (): number => this.replays.size;

  /** Resolves once no page load or visit is running or waiting. */
  settled = (): Promise<void> =>
    !this.current && !this.queue.length ? Promise.resolve() : new Promise((resolve) => this.settleWaiters.push(resolve));

  /** The host hands over its WebView's injectJavaScript. */
  attach = (inject: (script: string) => void): void => {
    this.inject = inject;
    this.pump();
  };

  detach = (): void => {
    this.inject = null;
  };

  /** A message the page posted through window.ReactNativeWebView.postMessage. */
  receive = (raw: unknown): void => {
    if (typeof raw !== 'string' || raw.length > MAX_MESSAGE_CHARS) return;

    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    if (msg.kind === 'replay' || msg.kind === 'suggest') {
      this.replayDone(msg);
      return;
    }

    const job = this.current;
    // Ignore anything without this load's nonce, including the retailer's own scripts.
    if (!job || msg.nonce !== job.nonce) return;

    // A page that refuses the phone outright ("Access Denied"): there's nothing to answer, so it's never shown.
    if (msg.kind === 'blocked') {
      if (job.phase !== 'browse') this.finish(failure('blocked', typeof msg.marker === 'string' ? `“${msg.marker.slice(0, 60)}”` : undefined));
      return;
    }

    if (msg.kind === 'challenge') {
      if (job.phase !== 'hidden' || job.graceTimer) return;
      if (job.timing) job.timing.check = { loadFrom: job.timing.startedAt ?? Date.now(), from: Date.now() };
      // A captcha showing in a frame of the page needs the user: there's no waiting for it to pass by itself.
      if (msg.frame === true) {
        job.checkDetail = 'a captcha in a frame of the page';
        this.checkStands(job);
        return;
      }
      // Otherwise the page gets a moment, still hidden, to pass the check by itself and move on (an invisible check
      // does). The script it posted from stops there; the one injected after the page moves on picks up.
      job.graceTimer = setTimeout(() => {
        job.graceTimer = undefined;
        if (this.current === job && job.phase === 'hidden') this.checkStands(job);
      }, this.challengeGraceMs);
      return;
    }

    if (msg.kind === 'progress') {
      if (job.phase === 'hidden' && job.accept) this.progress(job, msg);
      return;
    }

    // Its requests went quiet: the search says whether what streamed in is enough, or to wait for more.
    if (msg.kind === 'quiet') {
      if (job.phase !== 'hidden' || job.acceptTimer) return;
      let enough = true;
      try {
        enough = job.settle ? job.settle(this.partialPayload(job)) : true;
      } catch {
        enough = true;
      }
      if (enough) this.inject?.(goScript(job.nonce));
      return;
    }

    if (msg.kind === 'data') {
      if (job.phase === 'challenge') {
        // Check passed. Reload from scratch, since the Cookie header only rides the first request.
        job.phase = 'hidden';
        job.round += 1;
        job.nonce = makeNonce();
        job.partial = [];
        if (job.acceptTimer) clearTimeout(job.acceptTimer);
        job.acceptTimer = undefined;
        const t = job.timing;
        if (t?.check) {
          t.check.to = Date.now();
          t.startedAt = t.check.to;
          t.navAt = t.fetchAt = t.htmlAt = t.dataAt = t.openedAt = undefined;
          t.navigations = 0;
          t.streamed = undefined;
        }
        this.arm(job.timeoutMs, 'timeout');
        this.publish();
        return;
      }
      if (job.graceTimer) this.checkPassedUnseen(job);
      this.noteData(job, msg);
      if (job.timing) job.timing.ended ??= str(msg.ready) ?? 'data';
      const payload: WebViewPayload = {
        href: typeof msg.href === 'string' ? msg.href : job.url,
        nextDataText: typeof msg.nextDataText === 'string' ? msg.nextDataText : undefined,
        sources: Array.isArray(msg.sources) ? msg.sources.flatMap(toSource) : undefined,
        pageResult: msg.pageResult ?? undefined,
      };
      if (typeof msg.title === 'string' && msg.title) payload.title = msg.title;
      const bytes = usageBytes(msg);
      if (bytes !== undefined) payload.bytes = bytes;
      const store = storeText(msg) ?? job.partialStore;
      if (store) payload.store = store;
      if (typeof msg.text === 'string') payload.text = msg.text.slice(0, MAX_TEXT_CHARS);
      const size = sizeOf(msg);
      if (size) payload.size = size;
      this.finish(payload);
      return;
    }

    this.finish(new Error(typeof msg.error === 'string' ? msg.error : 'page_error'));
  };

  /**
   * injectedJavaScript only runs on a WebView's first load, so the host re-runs this after each navigation: during a
   * check, and while setting a store (pressing the button may load another page).
   */
  scriptAfterNavigation = (): string | null => {
    const job = this.current;
    return job && (job.phase === 'challenge' || (job.phase === 'hidden' && (job.task || job.graceTimer))) ? this.scriptFor(job) : null;
  };

  /** The Read products button: a script that posts whatever the current page holds. */
  readPage = (): string | null => {
    const job = this.current;
    return job?.phase === 'browse' && job.purpose !== 'signin' && job.purpose !== 'account' ? extractionScript(job.nonce, [], job.pageScript, { mode: 'read' }) : null;
  };

  /**
   * Whether the WebView may load `url` now. A hidden read of the user's account (see guardSignIn) that the site sends
   * to a sign-in page stops there, before that page loads: it fails with 'signed_out', and the page gets nothing.
   */
  allows = (url: string, isTopFrame: boolean): boolean => {
    const job = this.current;
    if (!job || job.phase !== 'hidden' || !job.guardSignIn || !isTopFrame || !looksLikeSignIn(url)) return true;
    this.finish(new Error('signed_out'));
    return false;
  };

  closeBrowse = (): void => {
    if (this.current?.phase === 'browse') this.finish(null);
  };

  networkError = (): void => {
    if (this.current?.phase === 'hidden') this.finish(new Error('network'));
    else if (!this.current && this.resident) this.dropPage();
  };

  /** The WebView began loading a page (its own event), for the speed test's timeline: when, and how many. */
  loadStarted = (): void => {
    const job = this.current;
    // A page that was on a bot check is loading another page: the check let it through.
    if (job?.phase === 'hidden' && job.graceTimer) this.checkPassedUnseen(job);
    const t = job?.phase === 'hidden' ? job.timing : undefined;
    if (!t) return;
    t.openedAt ??= Date.now();
    t.navigations = (t.navigations ?? 0) + 1;
  };

  /** The WebView's content process died (memory pressure, usually). */
  pageLost = (): void => {
    const job = this.current;
    if (job) this.finish(job.phase === 'browse' ? null : new Error('page_crashed'));
    else this.dropPage();
  };

  /**
   * Skip <store>, on its bot check: the load fails, and so do the page loads waiting behind it at the same site, which
   * would only meet the check again. Searches still waiting to load one see skippedAt (see searchViaWebView).
   */
  cancel = (): void => {
    const job = this.current;
    if (job?.phase === 'challenge') {
      this.skippedAt = Date.now();
      const behind = this.queue.filter((j) => j.mode === 'search' && !j.task && sameSite(j.url, job.url));
      this.queue = this.queue.filter((j) => !behind.includes(j));
      // They never loaded: nothing to learn from them, nor to count as bot checks of their own (see retailerSearch.ts).
      for (const j of behind) j.reject(Object.assign(new Error('challenge_cancelled'), { unsent: true }));
    }
    this.finish(new Error('challenge_cancelled'));
  };

  /** Shown to the user now: give them the full time for a bot check. */
  onPresented = (): void => {
    if (this.current?.phase === 'challenge') this.arm(this.challengeTimeoutMs, 'challenge_timeout');
  };

  /** Covered by another page (a store visit goes first): a bot check waits unseen again, its time not counting. */
  onHidden = (): void => {
    if (this.current?.phase === 'challenge') this.arm(BROWSE_TIMEOUT_MS, 'challenge_timeout');
  };

  /**
   * Unloads the kept page and forgets what to replay, e.g. after the user picked another store, or erased everything.
   * A page loading now finishes, but isn't kept: it was loaded for before.
   */
  reset = (): void => {
    this.resets += 1;
    if (this.current) this.current.keepPage = false;
    this.dropPage();
  };

  private toResponse(msg: Record<string, unknown>): ReplayResponse {
    return {
      status: typeof msg.status === 'number' ? msg.status : 0,
      url: str(msg.url) ?? '',
      type: str(msg.type) ?? '',
      text: str(msg.text),
      nextDataText: str(msg.nextDataText) ?? null,
      ld: Array.isArray(msg.ld) ? msg.ld.filter((s): s is string => typeof s === 'string') : undefined,
      title: str(msg.title),
      short: str(msg.short),
      bytes: typeof msg.bytes === 'number' ? msg.bytes : undefined,
    };
  }

  private replayDone(msg: Record<string, unknown>): void {
    const r = typeof msg.nonce === 'string' ? this.replays.get(msg.nonce) : undefined;
    if (!r) return;
    this.replays.delete(r.nonce);
    if (r.timer) clearTimeout(r.timer);
    if (r.timing) r.timing.doneAt = Date.now();
    if (r.counts) this.stats.replays += 1;
    if (typeof msg.error === 'string') r.reject(new Error(msg.error === 'too_large' ? 'replay_too_large' : 'replay_failed'));
    else r.resolve(msg);
    this.pump();
  }

  /** The check the page met is still there once its grace is over: shown to the user, or reported, as asked. */
  private checkStands(job: Job): void {
    if (job.reportChallenge) {
      this.finish(failure('challenge', job.checkDetail));
      return;
    }
    job.phase = 'challenge';
    // A check can need images to be answered: shown with everything, which means loading it again.
    if (job.light) {
      job.light = false;
      job.round += 1;
      job.nonce = makeNonce();
    }
    // Its time counts from when it's on screen (see onPresented, which the pool calls as it shows it): until then it may
    // wait behind another store's check, or a page the user has open.
    this.arm(BROWSE_TIMEOUT_MS, 'challenge_timeout');
    this.publish();
  }

  /** The page passed its bot check by itself, unseen: the load goes on from here, for the timeline. */
  private checkPassedUnseen(job: Job): void {
    if (job.graceTimer) clearTimeout(job.graceTimer);
    job.graceTimer = undefined;
    const t = job.timing;
    if (!t?.check || t.check.to !== undefined) return;
    t.check.to = Date.now();
    t.check.unseen = true;
    t.startedAt = t.check.to;
    t.navAt = t.fetchAt = t.htmlAt = t.dataAt = t.openedAt = undefined;
  }

  private enqueue(job: Omit<Job, 'id' | 'nonce' | 'round' | 'partial'>): void {
    this.queue.push({ ...job, id: this.nextId++, nonce: makeNonce(), round: 0, partial: [] });
    this.pump();
  }

  /** The page's data reached the app: when, and when the page itself loaded, for the speed test's timeline. */
  private noteData(job: Job, msg: Record<string, unknown>): void {
    const t = job.timing;
    if (!t) return;
    t.dataAt ??= Date.now();
    if (typeof msg.href === 'string') t.pageUrl = msg.href;
    const nav = msg.nav;
    if (typeof nav !== 'object' || nav === null) return;
    const { start, fetch, html } = nav as { start?: unknown; fetch?: unknown; html?: unknown };
    if (typeof start === 'number' && start > 0) t.navAt ??= start;
    if (typeof fetch === 'number' && fetch > 0) t.fetchAt ??= fetch;
    if (typeof html === 'number' && html > 0) t.htmlAt ??= html;
  }

  /** Responses the page streamed in: once they hold the results, finish shortly instead of waiting for quiet. */
  private progress(job: Job, msg: Record<string, unknown>): void {
    const sources = Array.isArray(msg.sources) ? msg.sources.flatMap(toSource) : [];
    if (!sources.length) return;
    this.noteData(job, msg);
    if (job.timing) job.timing.streamed = [...(job.timing.streamed ?? []), ...sources.map((s) => s.label)].slice(-30);
    job.partial = [...sources, ...job.partial];
    if (typeof msg.href === 'string') job.partialHref = msg.href;
    if (typeof msg.title === 'string' && msg.title) job.partialTitle = msg.title;
    const bytes = usageBytes(msg);
    if (bytes !== undefined) job.partialBytes = Math.max(bytes, job.partialBytes ?? 0);
    job.partialStore = storeText(msg) ?? job.partialStore;
    if (job.acceptTimer) return; // Already settling; the timer takes whatever has arrived by then.

    let ok: boolean | 'now' = false;
    try {
      ok = job.accept?.(this.partialPayload(job)) ?? false;
    } catch {
      ok = false;
    }
    if (!ok) return;
    if (job.timing) {
      job.timing.acceptedAt = Date.now();
      job.timing.ended = 'results';
    }
    if (ok === 'now') {
      this.inject?.(stopScript(job.nonce));
      this.finish(this.partialPayload(job));
      return;
    }
    job.acceptTimer = setTimeout(() => {
      if (this.current !== job) return;
      this.inject?.(stopScript(job.nonce));
      this.finish(this.partialPayload(job));
    }, ACCEPT_SETTLE_MS);
  }

  private partialPayload(job: Job): WebViewPayload {
    const payload: WebViewPayload = { href: job.partialHref ?? job.url, sources: job.partial };
    if (job.partialTitle) payload.title = job.partialTitle;
    if (job.partialBytes !== undefined) payload.bytes = job.partialBytes;
    if (job.partialStore) payload.store = job.partialStore;
    return payload;
  }

  private scriptFor(job: Job): string {
    if (job.mode === 'browse') return 'true;';
    if (job.task?.kind === 'listStores') return storeListScript(job.nonce, job.task.zip, job.challengeMarkers);
    if (job.task?.kind === 'readList') return listPageScript(job.nonce, job.challengeMarkers, { scrolls: job.task.scrolls });
    if (job.task?.kind === 'clip') return clipScript(job.nonce, job.challengeMarkers, job.task.target, job.task.buttons);
    if (job.task?.kind === 'storeRequest') return storeRequestScript(job.nonce, job.challengeMarkers, job.task.request);
    if (job.task) return storeScript(job.nonce, job.challengeMarkers, job.task.buttons, { target: job.task.target });
    return extractionScript(job.nonce, job.challengeMarkers, job.pageScript, {
      waitFor: job.waitFor,
      progress: !!job.accept,
      askQuiet: !!job.settle,
      // A product page with nothing more coming after it loads has said all it will; a page read for its words, soon.
      giveUpMs: job.waitFor === 'details' ? 3000 : job.waitFor === 'text' ? 4000 : undefined,
    });
  }

  private loadOf(job: Job): ActiveLoad {
    return {
      id: job.id,
      round: job.round,
      phase: job.phase,
      url: job.url,
      cookie: job.cookie,
      retailerName: job.retailerName,
      purpose: job.purpose,
      // A sign-in page gets nothing: no response capture, which would see what's typed there. Nor does a page of the
      // user's account shown to them, which may ask them to sign in.
      beforeScript:
        job.purpose === 'signin' || job.purpose === 'account'
          ? undefined
          : [job.mode === 'browse' || job.waitFor !== 'nextData' ? CAPTURE : '', job.light && job.phase === 'hidden' ? LIGHT : '']
              .filter(Boolean)
              .join('\n') || undefined,
      script: this.scriptFor(job),
    };
  }

  private publish(): void {
    const job = this.current;
    const prev = this.snapshot;
    const same = !!job && !!prev && prev.id === job.id && prev.round === job.round && prev.phase === job.phase;
    const next = job ? (same ? prev : this.loadOf(job)) : this.resident;
    if (next === prev) return;
    this.snapshot = next;
    this.listeners.forEach((listener) => listener());
  }

  /** Starts whatever can run next: a queued load (once replays in the old page finish), else waiting replays. */
  private pump(): void {
    if (!this.current && this.queue.length && !this.replays.size) this.startNext();
    if (!this.current && !this.queue.length) {
      while (this.waiting.length && this.replays.size < this.maxReplays) {
        const r = this.waiting.shift()!;
        const inject = this.inject;
        if (!this.resident || !inject) {
          if (r.timing) r.timing.doneAt = Date.now();
          r.reject(new Error('no_page'));
          continue;
        }
        this.replays.set(r.nonce, r);
        r.timer = setTimeout(() => {
          if (!this.replays.delete(r.nonce)) return;
          if (r.counts) this.stats.replays += 1;
          if (r.timing) r.timing.doneAt = Date.now();
          r.reject(new Error('replay_timeout'));
          this.pump();
        }, r.timeoutMs);
        this.lastUsed = Date.now();
        if (r.timing) r.timing.sentAt = this.lastUsed;
        inject(r.script(r.nonce));
      }
      const settled = this.settleWaiters.splice(0);
      settled.forEach((resolve) => resolve());
    }
    this.armIdle();
    this.publish();
  }

  private startNext(): void {
    const job = this.queue.shift();
    if (!job) return;
    this.current = job;
    this.resident = null;
    this.lastUsed = Date.now();
    if (job.timing) job.timing.startedAt = this.lastUsed;
    if (job.mode === 'search') this.stats.pageLoads += 1;
    this.beforeMount?.();
    this.arm(job.timeoutMs, 'timeout');
  }

  private arm(ms: number, reason: string): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      const job = this.current;
      // Out of time while a bot check was being given its moment: the check is what happened, as before the grace.
      if (job?.graceTimer && job.phase === 'hidden') {
        clearTimeout(job.graceTimer);
        job.graceTimer = undefined;
        this.checkStands(job);
        return;
      }
      this.finish(new Error(reason));
    }, ms);
  }

  private armIdle(): void {
    const idle = !!this.resident && this.isIdle();
    if (!idle) {
      if (this.idleTimer) clearTimeout(this.idleTimer);
      this.idleTimer = null;
    } else if (!this.idleTimer) {
      this.idleTimer = setTimeout(() => {
        this.idleTimer = null;
        if (this.isIdle()) this.dropPage();
      }, this.idleMs);
    }
  }

  private dropPage(): void {
    this.resident = null;
    this.template = null;
    this.seenStore = null;
    this.replayMisses = 0;
    // Requests in flight in that page will never answer.
    for (const r of this.replays.values()) {
      if (r.timer) clearTimeout(r.timer);
      if (r.timing) r.timing.doneAt = Date.now();
      r.reject(new Error('no_page'));
    }
    this.replays.clear();
    this.pump();
  }

  private finish(result: WebViewPayload | Error | null): void {
    const job = this.current;
    if (!job) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (job.acceptTimer) clearTimeout(job.acceptTimer);
    if (job.graceTimer) clearTimeout(job.graceTimer);
    job.graceTimer = undefined;
    if (job.timing) job.timing.doneAt = Date.now();
    this.current = null;
    const keep = job.mode === 'search' && job.keepPage && result !== null && !(result instanceof Error);
    // Kept as the same load (same id and round), so the host leaves the WebView and its page alone.
    this.resident = keep ? { ...this.loadOf(job), phase: 'idle' } : null;
    if (result instanceof Error) job.reject(result);
    else job.resolve(result);
    this.pump();
  }
}
