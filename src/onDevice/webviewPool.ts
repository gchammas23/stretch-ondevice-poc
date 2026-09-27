import { ScrapeFeed } from './scrapeFeed';
import { CHALLENGE_GRACE_MS, WebViewQueue } from './webviewQueue';

/**
 * Watch it scrape: 'open' shows the hidden pages as live mini windows with a feed; 'min' shrinks that to a pill;
 * 'stage' shows them large, for presenter mode (which draws everything around them).
 */
export type LiveView = 'off' | 'open' | 'min' | 'stage';

export interface PoolSnapshot {
  lanes: WebViewQueue[];
  /** The lane shown over the app: a store visit first, else the oldest bot check. Others wait hidden. */
  presented: WebViewQueue | null;
  live: LiveView;
}

/** The lane that reads and shows single pages (a product's, a recipe's), apart from the stores' search pages. */
export const PAGE_LANE = 'pages';

/** WebViews kept loaded at once. Each is a full browser page, so this bounds memory. */
export const MAX_LOADED_PAGES = 4;

/**
 * One WebView lane per retailer, so retailers search in parallel while each retailer still sees
 * one page load at a time, like one person browsing. Pure TypeScript; the host renders the lanes.
 */
export class WebViewPool {
  private lanes = new Map<string, WebViewQueue>();
  private checkOrder: string[] = [];
  private snapshot: PoolSnapshot = { lanes: [], presented: null, live: 'off' };
  private listeners = new Set<() => void>();
  private live: LiveView = 'off';
  /** What the phone just did, for the live view. */
  readonly feed = new ScrapeFeed();
  /** Diagnostics switch. Off, every WebView search is a full page load, as before replays existed. */
  replayEnabled = true;
  /** Hidden pages load without images, fonts or video (see lightScript). Set from the app's settings. */
  lightPages = true;
  /** Diagnostics switch. On, replays ask a store for only the results the app keeps, where its request says how many (see pageSize.ts). */
  leanRequests = true;
  maxLoadedPages = MAX_LOADED_PAGES;
  /** How long a hidden page gets to pass a bot check by itself (see CHALLENGE_GRACE_MS); tests shorten it. */
  challengeGraceMs = CHALLENGE_GRACE_MS;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): PoolSnapshot => this.snapshot;

  /** The lane for a retailer, created on first use. */
  lane = (key: string, label = key): WebViewQueue => {
    const existing = this.lanes.get(key);
    if (existing) return existing;
    const lane = new WebViewQueue(key, label);
    lane.challengeGraceMs = this.challengeGraceMs;
    lane.beforeMount = () => this.makeRoom(lane);
    lane.subscribe(() => this.refresh(false));
    this.lanes.set(key, lane);
    this.refresh(true);
    return lane;
  };

  all = (): WebViewQueue[] => [...this.lanes.values()];

  /** Unloads every kept page. */
  resetAll = (): void => this.all().forEach((lane) => lane.reset());

  setReplayEnabled = (on: boolean): void => {
    this.replayEnabled = on;
    if (!on) this.resetAll();
  };

  setLightPages = (on: boolean): void => {
    this.lightPages = on;
  };

  setLeanRequests = (on: boolean): void => {
    this.leanRequests = on;
  };

  setLiveView = (live: LiveView): void => {
    if (live === this.live) return;
    this.live = live;
    this.refresh(true);
  };

  /** Before `lane` loads a page, unload the least recently used idle pages beyond the limit. */
  private makeRoom(lane: WebViewQueue): void {
    const loaded = this.all().filter((l) => l !== lane && l.getSnapshot());
    let excess = loaded.length - (this.maxLoadedPages - 1);
    if (excess <= 0) return;
    const idle = loaded.filter((l) => l.isIdle()).sort((a, b) => a.lastUsed - b.lastUsed);
    for (const l of idle) {
      if (excess-- <= 0) break;
      l.reset();
    }
  }

  private refresh(lanesChanged: boolean): void {
    for (const lane of this.lanes.values()) {
      const checking = lane.getSnapshot()?.phase === 'challenge';
      const at = this.checkOrder.indexOf(lane.key);
      if (checking && at === -1) this.checkOrder.push(lane.key);
      if (!checking && at !== -1) this.checkOrder.splice(at, 1);
    }
    const visit = this.all().find((l) => l.getSnapshot()?.phase === 'browse');
    const presented = visit ?? (this.checkOrder.length ? (this.lanes.get(this.checkOrder[0]) ?? null) : null);
    // The live view shows every lane's page, so any page change is news to it.
    if (!lanesChanged && presented === this.snapshot.presented && this.live !== 'open') return;
    if (presented && presented !== this.snapshot.presented) presented.onPresented();
    this.snapshot = { lanes: this.all(), presented, live: this.live };
    this.listeners.forEach((listener) => listener());
  }
}
