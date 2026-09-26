import { queryKey } from '../lists/types';
import { timelineOf, type SearchTimeline, type SearchTiming } from '../onDevice/timing';
import type { KnownStore, Product, RetailerConfig, SearchOutcome } from '../onDevice/types';
import type { ItemResult } from './basket';
import { PRODUCTS_KEPT, PriceCache } from './priceCache';
import { sharedProducts } from './sharing';

// Pure TypeScript: prices a list at several stores through whatever `search` it's given.

export type SearchFn = (cfg: RetailerConfig, query: string, storeId: string) => Promise<SearchOutcome>;

export interface SearchResult extends ItemResult {
  /** The query as the user wrote it. */
  query: string;
  ms?: number;
  via?: 'page' | 'replay';
  strategy?: string;
  /** When the prices shown were read: earlier than now when they came from the cache. */
  at?: number;
  /** From the cache, not searched in this run. */
  cached?: boolean;
  /** What the page showed when the search failed, for the basket and Diagnostics. */
  detail?: string;
  /** Products the search returned, before keeping the top PRODUCTS_KEPT. */
  found?: number;
  /** Where in the page the products were found, e.g. "response www.target.com/… (24)". */
  source?: string;
  /** Extra context from the search, e.g. which Kroger store a ZIP resolved to. */
  note?: string;
  /** Why an item didn't get fresh prices: its search ran and 'failed', or it was 'skipped'. */
  outcome?: 'failed' | 'skipped';
  /** About how much data the search moved (not set for prices saved from earlier). */
  bytes?: number;
  /** The store the prices are for, as far as the search showed it. */
  store?: KnownStore;
  /** When the item was queued for a search in this run. */
  queuedAt?: number;
  /** When each part of its search happened, from the queue on, for the speed test's timeline. */
  timing?: SearchTimeline;
  /** About how much less data the search moved by asking for only the results the app keeps. */
  bytesSaved?: number;
  /**
   * The query of another item on the list whose search brought these products, one of which says this item (see
   * sharing.ts): no search of its own.
   */
  sharedWith?: string;
}

export interface StoreRun {
  retailerId: string;
  name: string;
  status: 'waiting' | 'running' | 'done';
  total: number;
  /** Searched, failed or skipped: everything no longer pending. */
  settled: number;
  failed: number;
  /** Queries being searched right now. */
  searching: string[];
  startedAt?: number;
  finishedAt?: number;
  /** Why the rest of this store's searches were skipped. */
  stoppedBecause?: string;
}

export interface PricingRun {
  listId: string;
  retailerIds: string[];
  startedAt: number;
  finishedAt?: number;
  stores: Record<string, StoreRun>;
  /** retailerId → queryKey → result. */
  results: Record<string, Record<string, SearchResult>>;
}

export interface StartOptions {
  /** Search everything again, showing the last known prices meanwhile. */
  refresh?: boolean;
  /** Items that can take another item's search, by their search's key: the other's key (see sharePlan in sharing.ts). */
  share?: Record<string, string>;
}

/** How many searches at once each store takes, and how many stores at once: they can change as searches land. */
export interface Concurrency {
  searches: (config: RetailerConfig) => number;
  stores: (max: number) => number;
}

export interface StoreChoice {
  config: RetailerConfig;
  /** Store number or ZIP passed to the search, when the retailer takes one. */
  storeId: string;
  /** Identifies the store for the cache: changes when the user picks another store. */
  storeKey: string;
}

export type SearchedListener = (retailerId: string, storeKey: string, products: Product[], at: number, store?: KnownStore) => void;

/** Stores searched at once: one WebView lane each. */
export const STORES_AT_ONCE = 4;
/** Searches in flight per store. The lane itself allows one page load at a time and a few replays. */
export const SEARCHES_PER_STORE = 3;
/** Failures in a row after which a store's remaining searches are skipped (it's likely blocking us). */
export const FAILURES_BEFORE_STOP = 2;

interface Worker {
  config: RetailerConfig;
  storeId: string;
  storeKey: string;
}

/** An item taken for a search: its key, how it stood, and the store's worker then. */
interface Claimed {
  key: string;
  pending: SearchResult;
  worker: Worker;
}

/**
 * Prices each list item at each chosen store: the user's own lists, while the app is open (when a list opens or
 * changes, or on Find a store). Stores run in parallel; results stream into the run as they land, so screens fill in
 * live, and prices up to a day old are shown meanwhile, labeled with their age.
 */
export class PricingEngine {
  private runs = new Map<string, PricingRun>();
  private listeners = new Set<() => void>();
  private searched = new Set<SearchedListener>();
  private active = new Set<string>();
  private stopped = new Set<string>();
  private workers = new Map<string, Worker>();
  private slots = 0;
  private slotWaiters: (() => void)[] = [];
  private streaks = new Map<string, number>();
  private foreground = true;
  private foregroundWaiters: (() => void)[] = [];
  /** When the app last left the screen: searches running then were cut off, not failed. */
  private backgroundedAt = -1;
  /** Each list's items that can take another item's search (see StartOptions.share). */
  private shares = new Map<string, Record<string, string>>();
  private concurrency: Concurrency | null = null;

  constructor(
    private search: SearchFn,
    private cache: PriceCache,
    readonly storesAtOnce = STORES_AT_ONCE,
    readonly searchesPerStore = SEARCHES_PER_STORE,
    private now: () => number = Date.now,
  ) {}

  setSearch(search: SearchFn): void {
    this.search = search;
  }

  /** Searches at once per store, and stores at once, from each store's tuning (see tuning.ts). Null: the fixed ones. */
  setConcurrency(concurrency: Concurrency | null): void {
    this.concurrency = concurrency;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Called with every search's fresh products, e.g. to keep their price history. */
  onSearched = (listener: SearchedListener): (() => void) => {
    this.searched.add(listener);
    return () => {
      this.searched.delete(listener);
    };
  };

  getRun = (listId: string): PricingRun | undefined => this.runs.get(listId);

  /** Anything still searching for this list. */
  isRunning(listId: string): boolean {
    const run = this.runs.get(listId);
    return !!run && Object.values(run.stores).some((s) => s.status !== 'done');
  }

  /** Some list is still being priced: the phone is searching, for the battery meter (see batteryCost.ts). */
  pricing(): boolean {
    return [...this.runs.keys()].some((listId) => this.isRunning(listId));
  }

  /** Some list is still searching this store: its lane is in use, and pages read for other things can wait. */
  busyAt(retailerId: string): boolean {
    return [...this.runs.values()].some((run) => {
      const store = run.stores[retailerId];
      return !!store && store.status !== 'done';
    });
  }

  /**
   * iOS pauses the app's WebViews soon after it leaves the screen. Searches wait while it's away, and ones it cut
   * off are run again when it's back.
   */
  setForeground(active: boolean): void {
    if (!active) {
      this.foreground = false;
      this.backgroundedAt = this.now();
      return;
    }
    this.foreground = true;
    this.foregroundWaiters.splice(0).forEach((resolve) => resolve());
  }

  /**
   * Prices `names` at `stores`. Reuses what this run already has and fresh cached prices, unless refreshing, and
   * searches only the rest, showing their last known prices (up to a day old) meanwhile. Safe to call again whenever
   * the list or the stores change.
   */
  start(listId: string, names: string[], stores: StoreChoice[], opts: StartOptions = {}): void {
    const prev = this.runs.get(listId);
    const queries = new Map<string, string>();
    for (const name of names) if (name.trim() && !queries.has(queryKey(name))) queries.set(queryKey(name), name.trim());

    const now = this.now();
    const results: PricingRun['results'] = {};
    const runStores: PricingRun['stores'] = {};
    this.stopped.delete(listId);
    const share = opts.share ?? {};
    this.shares.set(listId, share);

    for (const { config, storeId, storeKey } of stores) {
      const r = config.id;
      const workerKey = `${listId}|${r}`;
      const sameStore = this.workers.get(workerKey)?.storeKey === storeKey;
      this.workers.set(workerKey, { config, storeId, storeKey });
      const before = sameStore ? prev?.results[r] : undefined;
      const planned: Record<string, SearchResult> = {};
      for (const [key, query] of queries) planned[key] = this.plan(before?.[key], query, PriceCache.key(r, storeKey, key), workerKey, opts);
      // An item that can take another's search, already done, takes it at once.
      const mine = shareDone(planned, share);
      results[r] = mine;
      const prevStore = sameStore ? prev?.stores[r] : undefined;
      const queued = Object.values(mine).some((x) => x.status === 'queued');
      // A store that had finished keeps its times when there's nothing new, and starts its clock again when there is.
      runStores[r] = storeSummary(
        {
          retailerId: r,
          name: config.name,
          status: 'waiting',
          total: 0,
          settled: 0,
          failed: 0,
          searching: [],
          startedAt: queued && prevStore?.finishedAt !== undefined ? undefined : prevStore?.startedAt,
          finishedAt: queued ? undefined : prevStore?.finishedAt,
        },
        mine,
        now,
      );
      if (queued) this.streaks.set(workerKey, 0);
    }

    // A run still going keeps its start; new searches after a finished run start the clock again.
    const searching = Object.values(results).some((mine) => Object.values(mine).some((x) => x.status === 'queued'));
    const run: PricingRun = {
      listId,
      retailerIds: stores.map((s) => s.config.id),
      startedAt: prev && !prev.finishedAt ? prev.startedAt : searching || !prev ? now : prev.startedAt,
      stores: runStores,
      results,
    };
    run.finishedAt = allDone(run) ? (prev?.finishedAt ?? now) : undefined;
    this.runs.set(listId, run);
    this.emit();
    for (const { config } of stores) void this.work(listId, config.id);
  }

  /** What one item at one store should be at the start of a run. */
  private plan(had: SearchResult | undefined, query: string, cacheKey: string, workerKey: string, opts: StartOptions): SearchResult {
    const inFlight = had && (had.status === 'searching' || (had.status === 'queued' && this.active.has(workerKey)));
    if (had && inFlight) return had;
    if (had && !opts.refresh) {
      // Failures, and refreshes that failed, stay as they are until the user retries: coming back to a screen
      // shouldn't hit a blocking store again.
      if (had.status === 'failed' || had.status === 'skipped' || (had.status === 'done' && had.reason)) return had;
      if (had.status === 'done' && !had.stale && this.cache.isFresh(had.at)) return had;
    }
    const hit = opts.refresh ? undefined : this.cache.get(cacheKey);
    if (hit) {
      return {
        status: 'done', query, products: hit.products, ms: hit.ms, via: hit.via, strategy: hit.strategy, at: hit.at, cached: true,
        found: hit.found, source: hit.source, note: hit.note, store: hit.store,
      };
    }
    // Search again, showing the last known prices meanwhile.
    const earlier = this.cache.peek(cacheKey) ?? (had?.products.length ? { products: had.products, at: had.at } : undefined);
    const queuedAt = this.now();
    return earlier?.products.length
      ? { status: 'queued', query, products: earlier.products, at: earlier.at, stale: true, cached: true, queuedAt }
      : { status: 'queued', query, products: [], queuedAt };
  }

  /** Forgets every run, as on a fresh start. Searches already running finish, and their results go nowhere. */
  reset(): void {
    for (const listId of this.runs.keys()) this.stopped.add(listId);
    this.runs.clear();
    this.workers.clear();
    this.streaks.clear();
    this.shares.clear();
    this.emit();
  }

  /** Stops starting new searches for this list. Searches already running finish. */
  stop(listId: string): void {
    this.stopped.add(listId);
    this.update(listId, (run) => {
      const results = { ...run.results };
      const stores = { ...run.stores };
      for (const r of run.retailerIds) {
        const mine = { ...results[r] };
        for (const [k, v] of Object.entries(mine)) if (v.status === 'queued') mine[k] = settle(v, 'skipped', 'stopped');
        results[r] = mine;
        stores[r] = storeSummary(stores[r], mine, this.now());
      }
      return finishIfDone({ ...run, results, stores }, this.now());
    });
  }

  /** Searches again whatever failed, was skipped, or couldn't be refreshed, at one store or all of them. */
  retry(listId: string, retailerId?: string): void {
    this.stopped.delete(listId);
    const run = this.runs.get(listId);
    if (!run) return;
    const targets = retailerId ? [retailerId] : run.retailerIds;
    this.update(listId, (r) => {
      const results = { ...r.results };
      const stores = { ...r.stores };
      for (const id of targets) {
        const mine = { ...results[id] };
        const queuedAt = this.now();
        for (const [k, v] of Object.entries(mine)) {
          if (v.status === 'failed' || v.status === 'skipped') mine[k] = { status: 'queued', query: v.query, products: [], queuedAt };
          else if (v.status === 'done' && v.reason) mine[k] = { ...v, status: 'queued', reason: undefined, detail: undefined, outcome: undefined, timing: undefined, queuedAt };
        }
        results[id] = mine;
        this.streaks.set(`${listId}|${id}`, 0);
        stores[id] = { ...storeSummary(stores[id], mine, this.now()), stoppedBecause: undefined, finishedAt: undefined };
      }
      return { ...r, results, stores, finishedAt: undefined };
    });
    for (const id of targets) void this.work(listId, id);
  }

  private emit(): void {
    this.listeners.forEach((listener) => listener());
  }

  private update(listId: string, fn: (run: PricingRun) => PricingRun): void {
    const run = this.runs.get(listId);
    if (!run) return;
    this.runs.set(listId, fn(run));
    this.emit();
  }

  private setResult(listId: string, retailerId: string, key: string, result: SearchResult): void {
    this.update(listId, (run) => {
      if (!run.results[retailerId]?.[key]) return run; // The item left the list meanwhile.
      const mine = { ...run.results[retailerId], [key]: result };
      const store = storeSummary(run.stores[retailerId], mine, this.now());
      return finishIfDone({ ...run, results: { ...run.results, [retailerId]: mine }, stores: { ...run.stores, [retailerId]: store } }, this.now());
    });
  }

  /** A slot among the stores searched at once: fewer after pages crashed, when the tuning says so. */
  private async acquire(): Promise<void> {
    while (this.slots >= Math.max(1, this.concurrency?.stores(this.storesAtOnce) ?? this.storesAtOnce)) {
      await new Promise<void>((resolve) => this.slotWaiters.push(resolve));
    }
    this.slots++;
  }

  private release(): void {
    this.slots--;
    this.slotWaiters.shift()?.();
  }

  /**
   * Searches at once at a store, as its tuning says. Without it: a few, or twice as many without a WebView (an
   * official API, plain requests), whose searches are just HTTP calls.
   */
  private searchesFor(config: RetailerConfig): number {
    const fixed = config.strategies.includes('webview') ? this.searchesPerStore : this.searchesPerStore * 2;
    return Math.max(1, this.concurrency?.searches(config) ?? fixed);
  }

  private async work(listId: string, retailerId: string): Promise<void> {
    const workerKey = `${listId}|${retailerId}`;
    const worker = this.workers.get(workerKey);
    if (!worker || this.active.has(workerKey) || !this.nextReady(listId, retailerId)) return;
    this.active.add(workerKey);
    try {
      await this.acquire();
      try {
        this.update(listId, (run) => {
          const store = run.stores[retailerId];
          if (!store) return run;
          return { ...run, stores: { ...run.stores, [retailerId]: { ...store, status: 'running', startedAt: store.startedAt ?? this.now() } } };
        });
        await this.drain(listId, retailerId, worker.config);
      } finally {
        this.release();
      }
    } finally {
      this.active.delete(workerKey);
    }
    // Retried or added while the last searches were finishing.
    if (this.nextReady(listId, retailerId) && !this.stopped.has(listId)) void this.work(listId, retailerId);
  }

  /** The next item the store can search now, in list order: queued, and not waiting for a search it can share. */
  private nextReady(listId: string, retailerId: string): [string, SearchResult] | undefined {
    const mine = this.runs.get(listId)?.results[retailerId];
    if (!mine || this.stopped.has(listId)) return undefined;
    const share = this.shares.get(listId) ?? {};
    const waiting = (key: string) => {
      const host = share[key] ? mine[share[key]] : undefined;
      return !!host && (host.status === 'queued' || host.status === 'searching');
    };
    return Object.entries(mine).find(([key, r]) => r.status === 'queued' && !waiting(key));
  }

  /** Takes the next item the store can search now, marked as searching. */
  private claim(listId: string, retailerId: string): Claimed | null {
    const worker = this.workers.get(`${listId}|${retailerId}`);
    const next = this.nextReady(listId, retailerId);
    if (!worker || !next) return null;
    const [key, pending] = next;
    this.setResult(listId, retailerId, key, { ...pending, status: 'searching' });
    return { key, pending, worker };
  }

  /**
   * Keeps as many searches going at the store as it takes. Its tuning can change as they land, so it's asked again
   * each time one ends. An item that can take another's search waits for it.
   */
  private async drain(listId: string, retailerId: string, config: RetailerConfig): Promise<void> {
    const running = new Set<Promise<void>>();
    let stop = false;
    for (;;) {
      if (!this.foreground) await new Promise<void>((resolve) => this.foregroundWaiters.push(resolve));
      while (!stop && running.size < this.searchesFor(config)) {
        const next = this.claim(listId, retailerId);
        if (!next) break;
        const task: Promise<void> = this.searchOne(listId, retailerId, next).then(
          (goOn) => {
            if (!goOn) stop = true;
          },
          () => {},
        );
        running.add(task);
        void task.then(() => running.delete(task));
      }
      if (!running.size) return;
      await Promise.race(running);
    }
  }

  /** One search at the store. False when the store's other searches are to stop (see skipRest). */
  private async searchOne(listId: string, retailerId: string, { key, pending, worker }: Claimed): Promise<boolean> {
    const workerKey = `${listId}|${retailerId}`;
    const { config, storeId, storeKey } = worker;
    // The user may pick another store while this search runs; its prices would then belong to the old one.
    const stillSameStore = () => this.workers.get(workerKey)?.storeKey === storeKey;
    const startedAt = this.now();
    try {
      const out = await this.search(config, pending.query, storeId);
      const at = this.now();
      const found = out.products.length;
      this.cache.set(PriceCache.key(retailerId, storeKey, key), {
        products: out.products, at, ms: out.ms, strategy: out.strategy, via: out.via, source: out.source, found, note: out.note, store: out.store,
      });
      const kept = out.products.slice(0, PRODUCTS_KEPT);
      this.searched.forEach((listener) => listener(retailerId, storeKey, kept, at, out.store));
      if (!stillSameStore()) return true;
      this.streaks.set(workerKey, 0);
      this.setResult(listId, retailerId, key, {
        status: 'done', query: pending.query, products: kept, ms: out.ms, via: out.via, strategy: out.strategy, at,
        found, source: out.source, note: out.note, bytes: out.bytes, store: out.store,
        queuedAt: pending.queuedAt, timing: timelineOf(pending.queuedAt ?? startedAt, startedAt, at, out.timing),
        ...(out.bytesSaved ? { bytesSaved: out.bytesSaved } : {}),
      });
      this.shareFrom(listId, retailerId);
      return true;
    } catch (e) {
      if (!stillSameStore()) return true;
      // Cut off by the app leaving the screen, not a real failure: run it again.
      if (this.backgroundedAt >= startedAt) {
        this.setResult(listId, retailerId, key, { ...pending, status: 'queued' });
        return true;
      }
      const reason = reasonFrom(e);
      const streak = (this.streaks.get(workerKey) ?? 0) + 1;
      this.streaks.set(workerKey, streak);
      const timing = timelineOf(pending.queuedAt ?? startedAt, startedAt, this.now(), timingFrom(e));
      this.setResult(listId, retailerId, key, settle(pending, 'failed', reason, detailFrom(e), timing));
      // The phone has asked this store as much as a person would in an hour: the rest waits.
      if (reason === 'polite_limit') {
        this.skipRest(listId, retailerId, 'Paused: an hour’s worth of searches here already');
        return false;
      }
      if (reason === 'challenge_cancelled' || streak >= FAILURES_BEFORE_STOP) {
        this.skipRest(listId, retailerId, reason === 'challenge_cancelled' ? 'You skipped the bot check' : `Kept failing (${reason})`);
        return false;
      }
      return true;
    }
  }

  /** Items waiting to take a search that just ended: its products where one says the item; else they search on their own. */
  private shareFrom(listId: string, retailerId: string): void {
    const share = this.shares.get(listId);
    const mine = this.runs.get(listId)?.results[retailerId];
    if (!share || !mine) return;
    const next = shareDone(mine, share);
    if (next === mine) return;
    this.update(listId, (run) => {
      const store = storeSummary(run.stores[retailerId], next, this.now());
      return finishIfDone({ ...run, results: { ...run.results, [retailerId]: next }, stores: { ...run.stores, [retailerId]: store } }, this.now());
    });
  }

  private skipRest(listId: string, retailerId: string, why: string): void {
    this.update(listId, (run) => {
      const mine = { ...run.results[retailerId] };
      for (const [k, v] of Object.entries(mine)) if (v.status === 'queued') mine[k] = settle(v, 'skipped', why);
      const store = { ...storeSummary(run.stores[retailerId], mine, this.now()), stoppedBecause: why };
      return finishIfDone({ ...run, results: { ...run.results, [retailerId]: mine }, stores: { ...run.stores, [retailerId]: store } }, this.now());
    });
  }
}

/**
 * The store's results with each waiting item that can take another item's done search given that search's products,
 * where one of its first results says the item (see sharedProducts). The same object when nothing changes.
 */
function shareDone(mine: Record<string, SearchResult>, share: Record<string, string>): Record<string, SearchResult> {
  let out = mine;
  for (const [key, hostKey] of Object.entries(share)) {
    const item = out[key];
    const host = out[hostKey];
    if (item?.status !== 'queued' || host?.status !== 'done' || host.reason || host.stale || host.sharedWith || !host.products.length) continue;
    const products = sharedProducts(host.products, item.query);
    if (!products) continue;
    out = {
      ...out,
      [key]: {
        status: 'done', query: item.query, products, ms: host.ms, via: host.via, strategy: host.strategy, at: host.at, cached: host.cached,
        found: host.found, source: host.source, note: host.note, store: host.store, sharedWith: host.query,
      },
    };
  }
  return out;
}

/**
 * An item that won't get fresh prices this run: 'failed' when its search ran and failed, 'skipped' when it never
 * ran. Either way it keeps the older prices it was showing, if it had any.
 */
function settle(result: SearchResult, status: 'failed' | 'skipped', reason: string, detail?: string, timing?: SearchTimeline): SearchResult {
  const ran = timing ? { timing } : {};
  if (result.products.length) return { ...result, status: 'done', stale: true, reason, detail, outcome: status, ...ran };
  return { status, query: result.query, products: [], reason, detail, outcome: status, ...ran };
}

/** When the parts of a failed search happened, as its error carries them (see SearchFailed). */
function timingFrom(e: unknown): SearchTiming | undefined {
  const timing = (e as { timing?: SearchTiming } | null)?.timing;
  return timing && Array.isArray(timing.spans) ? timing : undefined;
}

function lastAttempt(e: unknown): { reason?: string; detail?: string } | undefined {
  const attempts = (e as { attempts?: { reason?: string; detail?: string }[] } | null)?.attempts;
  if (!Array.isArray(attempts)) return undefined;
  const real = attempts.filter((a) => a.reason && a.reason !== 'resting');
  return real[real.length - 1];
}

function reasonFrom(e: unknown): string {
  const last = lastAttempt(e);
  if (last) return last.reason ?? 'failed';
  return e instanceof Error ? e.message : 'failed';
}

function detailFrom(e: unknown): string | undefined {
  return lastAttempt(e)?.detail;
}

function storeSummary(store: StoreRun, results: Record<string, SearchResult>, now: number): StoreRun {
  const all = Object.values(results);
  const searching = all.filter((r) => r.status === 'searching').map((r) => r.query);
  const queued = all.filter((r) => r.status === 'queued').length;
  const settled = all.length - queued - searching.length;
  const status: StoreRun['status'] = settled === all.length ? 'done' : searching.length ? 'running' : store.status === 'running' ? 'running' : 'waiting';
  return {
    ...store,
    status,
    total: all.length,
    settled,
    failed: all.filter((r) => r.status === 'failed' || r.status === 'skipped').length,
    searching,
    finishedAt: status === 'done' ? (store.finishedAt ?? now) : undefined,
  };
}

function allDone(run: PricingRun): boolean {
  return Object.values(run.stores).every((s) => s.status === 'done');
}

function finishIfDone(run: PricingRun, now: number): PricingRun {
  return allDone(run) ? { ...run, finishedAt: run.finishedAt ?? now } : { ...run, finishedAt: undefined };
}
