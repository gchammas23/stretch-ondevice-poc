import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { AppState as RNAppState } from 'react-native';
import type { GroceryList } from '../lists/types';
import { listQueries } from '../lists/types';
import type { WeeklyAd } from '../onDevice/adPage';
import { AttemptLog } from '../onDevice/attemptLog';
import type { Coupon, CouponList } from '../onDevice/couponPage';
import { CoverageCheck } from '../onDevice/coverage';
import { krogerApiConfigured, warmUpKroger } from '../onDevice/krogerApi';
import { priceEvidence } from '../onDevice/evidence';
import { PhoneVsServer, plainConfig, versusIds, type VersusScope } from '../onDevice/phoneVsServer';
import { politeness } from '../onDevice/politeness';
import { storeTuner, tuningBase } from '../onDevice/tuning';
import { BUNDLED_CONFIG, fetchRules, type RulesStatus } from '../onDevice/retailers';
import type { RetailerConfig, RetailerConfigBundle } from '../onDevice/types';
import { useRetailerSearch, type RetailerSearch } from '../onDevice/useRetailerSearch';
import { useWebViewPool } from '../onDevice/WebViewFetcher';
import type { WebViewPool } from '../onDevice/webviewPool';
import {
  basketFor,
  bestSplit,
  driveCosts,
  driveVerdict,
  stretchPick,
  withUnitTotals,
  type Basket,
  type DriveVerdict,
  type OrderCost,
  type SplitTrip,
  type TripCosts,
} from '../pricing/basket';
import { adDue, adTarget } from '../pricing/ads';
import { couponCredits, couponsDue, couponTarget, withCoupons, type CouponCredit } from '../pricing/coupons';
import { FeeBook, figuresOf } from '../pricing/feeBook';
import { PriceCache } from '../pricing/priceCache';
import { memberRun } from '../pricing/member';
import {
  extrasOf,
  feeContexts,
  feesKey,
  onlineCost,
  onlineCosts,
  orderable,
  orderCostFn,
  tripCosts,
  type FeeContext,
  type OnlineCost,
  type ShopMode,
} from '../pricing/onlineCost';
import { PriceHistory } from '../pricing/priceHistory';
import { PricingEngine, type PricingRun, type StartOptions, type StoreChoice } from '../pricing/pricingEngine';
import { ReadBook } from '../pricing/readBook';
import { sharePlan } from '../pricing/sharing';
import { useToday } from '../ui/useNow';
import { AppStore, type AppState, type WatchItem } from './appStore';
import { batteryMeter } from './battery';
import { locateZip } from './deviceLocation';
import { storeChoices } from './storeChoices';
import type { SetupDeps } from './storeSetup';

const PRICES_KEY = 'stretch.prices.v1';
const HISTORY_KEY = 'stretch.history.v1';
const HEALTH_KEY = 'stretch.health.v1';
const COVERAGE_KEY = 'stretch.coverage.v1';
const FEES_KEY = 'stretch.fees.v1';
const ADS_KEY = 'stretch.ads.v1';
const COUPONS_KEY = 'stretch.coupons.v1';
const VERSUS_KEY = 'stretch.versus.v1';
/** Every key the app saves under, for erasing it all. */
export const STORAGE_KEYS = ['stretch.app.v1', PRICES_KEY, HISTORY_KEY, HEALTH_KEY, COVERAGE_KEY, FEES_KEY, ADS_KEY, COUPONS_KEY, VERSUS_KEY];

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
/** A saved weekly ad, and a saved list of coupons: the shapes the readers give. */
const isWeeklyAd = (v: unknown): v is WeeklyAd => isRecord(v) && Array.isArray(v.items);
const isCouponList = (v: unknown): v is CouponList => isRecord(v) && Array.isArray(v.coupons);

/** Asked for by the user, a read waits this long for its store's searches to finish. */
const ASKED_WAIT_MS = 60_000;

/** Price checks (Price check anything) run as a list of their own that no screen lists. */
export const QUICK_RUN = '__quick__';
/** Store rules from a file are fetched again when the app comes back after this long. */
const RULES_RECHECK_MS = 30 * 60_000;

/** What this phone's browser says it is (its user agent), asked once: the phone vs. server test's plain request says it too. */
let browserAgent: Promise<string | null> | null = null;
const webViewUserAgent = (): Promise<string | null> => (browserAgent ??= Constants.getWebViewUserAgentAsync().catch(() => null));

interface AppContextValue {
  store: AppStore;
  engine: PricingEngine;
  cache: PriceCache;
  history: PriceHistory;
  log: AttemptLog;
  coverage: CoverageCheck;
  search: RetailerSearch;
  /** The served (or bundled) rules, plus stores the user added. */
  bundle: RetailerConfigBundle;
  rules: RulesStatus;
  /** Fetches the rules file again now. */
  checkRules: () => Promise<void>;
  /** Tries one search at every enabled store, for Store health. */
  runCoverage: () => Promise<void>;
  /** The phone vs. server test: its last result, and the one running. */
  versus: PhoneVsServer;
  /**
   * Searches each store (the compared ones, or all, see versusIds) two ways: its page in this phone's browser, then a
   * plain request as a server sends. Bot checks are reported, not shown; both count toward each store's hour.
   */
  runVersus: (scope: VersusScope) => Promise<void>;
  /** Each store's fees page as the phone last read it. */
  fees: FeeBook;
  /**
   * Reads the fees page of each compared store (or only `retailerIds`) whose last read is due, or every one with
   * `force`, hidden, one at a time. Screens that show online totals call it while the user shops online; nothing
   * reads fees otherwise.
   */
  checkFees: (force?: boolean, retailerIds?: string[]) => Promise<void>;
  /** Each store's weekly ad, as the phone last read it for the store it's set to. */
  ads: ReadBook<WeeklyAd>;
  /** Each store's coupons, for the account signed in to it in the app, as the phone last read them. */
  coupons: ReadBook<CouponList>;
  /**
   * Reads the weekly ad of each compared store (or only `retailerIds`) that's due, hidden, one at a time: at most once
   * a day per store (see adDue). `asked`: the user asked, so a read that failed today is tried again, and a store being
   * searched is waited for; otherwise it's left for another time.
   */
  checkAds: (asked?: boolean, retailerIds?: string[]) => Promise<void>;
  /** Reads the coupons of each compared store signed in to in the app that are due (see couponsDue), the same way. */
  checkCoupons: (asked?: boolean, retailerIds?: string[]) => Promise<void>;
  /**
   * Clips coupons at a store, one at a time, pressing each one's own button on its coupons page, hidden: only because
   * the user asked. Ones the page didn't confirm send the coupons to be read again.
   */
  clipCoupons: (retailerId: string, couponIds: string[]) => Promise<{ clipped: number; failed: string[]; reason?: string }>;
  /** Opens the store's coupons page on screen, with nothing injected, then reads the coupons again. */
  viewCoupons: (retailerId: string) => Promise<void>;
  /**
   * Signs in on the store's own page (nothing injected into it), then reads the account's coupons there. With a
   * loyalty program, its member prices count from then on.
   */
  signInAt: (retailerId: string) => Promise<void>;
  /** Called with watched products whose price just dropped. */
  onDrops: (listener: (items: WatchItem[]) => void) => () => void;
  pool: WebViewPool;
  /**
   * Everything on this phone back to a first launch: lists, trips, stores, prices, history and health. The welcome
   * shows next. Stores chosen on a retailer's own site stay chosen there, in that site's cookies.
   */
  startOver: () => Promise<void>;
}

const AppContext = createContext<AppContextValue | null>(null);

/** Writes `save()` a moment after the last change, so a burst of changes is one write. */
function debounced(save: () => void, ms: number) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    schedule: () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(save, ms);
    },
    cancel: () => {
      if (timer) clearTimeout(timer);
    },
  };
}

const BUNDLED_STATUS: RulesStatus = { source: 'bundled', version: BUNDLED_CONFIG.version };

/** Why a read failed, as a reason code: 'challenge', 'timeout'... */
const failureOf = (e: unknown): string => {
  const reason = (e as { reason?: unknown } | null)?.reason;
  return typeof reason === 'string' ? reason : e instanceof Error ? e.message : 'failed';
};

/** Loads saved lists, settings and prices, then renders the app. Until then it renders nothing (the splash stays). */
export function AppProvider({ children, onReady }: { children: React.ReactNode; onReady?: () => void }) {
  const pool = useWebViewPool();
  const [fetched, setFetched] = useState<{ url: string; bundle?: RetailerConfigBundle; status: RulesStatus } | null>(null);
  const [store] = useState(() => new AppStore());
  const [cache] = useState(() => new PriceCache());
  const [history] = useState(() => new PriceHistory());
  const [log] = useState(() => new AttemptLog());
  const [coverage] = useState(() => new CoverageCheck());
  const [versus] = useState(() => new PhoneVsServer());
  const [fees] = useState(() => new FeeBook());
  const [ads] = useState(() => new ReadBook<WeeklyAd>(isWeeklyAd));
  const [coupons] = useState(() => new ReadBook<CouponList>(isCouponList));
  const [dropListeners] = useState(() => new Set<(items: WatchItem[]) => void>());
  // Its search is set below, before anything can be priced (nothing renders until the saved state has loaded).
  const [engine] = useState(() => new PricingEngine(() => Promise.reject(new Error('not_ready')), cache));
  const [ready, setReady] = useState(false);
  const custom = useSyncExternalStore(store.subscribe, () => store.getState().settings.customRetailers);
  const rulesUrl = useSyncExternalStore(store.subscribe, () => store.getState().settings.rulesUrl);
  const lightPages = useSyncExternalStore(store.subscribe, () => store.getState().settings.lightPages);
  const settings = useSyncExternalStore(store.subscribe, () => store.getState().settings);

  // Rules come from the file set in Store health, else the build's own setting, else the ones built in.
  const url = rulesUrl || process.env.EXPO_PUBLIC_RETAILER_CONFIG_URL || '';
  const current = url && fetched?.url === url ? fetched : null;
  const served = current?.bundle ?? BUNDLED_CONFIG;
  const rules = useMemo<RulesStatus>(() => (!url ? BUNDLED_STATUS : (current?.status ?? { ...BUNDLED_STATUS, url })), [url, current]);
  const search = useRetailerSearch(served.version);

  const bundle = useMemo(() => {
    const ids = new Set(served.retailers.map((r) => r.id));
    return { ...served, retailers: [...served.retailers, ...custom.filter((r) => !ids.has(r.id))] };
  }, [served, custom]);

  /** Takes a fetched rules file, or keeps the rules in use and says why the file wasn't taken. */
  const applyRules = useCallback((from: string, got: Awaited<ReturnType<typeof fetchRules>>) => {
    setFetched((had) => {
      const at = Date.now();
      if ('bundle' in got) return { url: from, bundle: got.bundle, status: { source: 'served', url: from, version: got.bundle.version, checkedAt: at } };
      const kept = had?.url === from ? had.bundle : undefined;
      const status: RulesStatus = { source: kept ? 'served' : 'bundled', url: from, version: kept?.version ?? BUNDLED_CONFIG.version, checkedAt: at, error: got.error };
      return { url: from, bundle: kept, status };
    });
  }, []);

  const checkRules = useCallback(async () => {
    if (url) applyRules(url, await fetchRules(url));
  }, [url, applyRules]);

  useEffect(() => {
    if (!ready || !url) return;
    let alive = true;
    fetchRules(url).then((got) => alive && applyRules(url, got));
    return () => {
      alive = false;
    };
  }, [ready, url, applyRules]);

  useEffect(() => {
    pool.setLightPages(lightPages);
  }, [pool, lightPages]);

  useEffect(() => {
    engine.setSearch((cfg, q, storeId) => search.search(cfg, q, storeId));
  }, [engine, search]);

  // Kroger's official API, where it's compared: signed in and its store looked up before the first search needs them.
  useEffect(() => {
    if (!ready) return;
    for (const { config, storeId } of storeChoices(settings, bundle.retailers)) {
      if (config.api === 'kroger') void warmUpKroger(storeId, config.timeoutMs, config.apiChain);
    }
  }, [ready, settings, bundle.retailers]);

  // Searches at once at each store, and stores at once, as the store tuning says from how their searches go.
  useEffect(() => {
    engine.setConcurrency({ searches: (cfg) => storeTuner.get(cfg.id, tuningBase(cfg)).searches, stores: (max) => storeTuner.storesAtOnce(max) });
    return () => engine.setConcurrency(null);
  }, [engine]);

  // The battery, read while lists are priced: this session's share in Store health (the speed test measures its own).
  useEffect(() => batteryMeter.attach(engine), [engine]);

  // Every fresh price goes into the product's history, and into the watchlist, which may have news. The store the
  // search got them from is noted for Your stores.
  useEffect(
    () =>
      engine.onSearched((retailerId, storeKey, products, at, seen) => {
        history.record(retailerId, storeKey, products, at);
        const dropped = store.notePrices(retailerId, storeKey, products, at);
        if (dropped.length) dropListeners.forEach((listener) => listener(dropped));
        if (seen) store.noteSeenStore(retailerId, storeKey, seen, at);
      }),
    [engine, history, store, dropListeners],
  );

  useEffect(() => search.onAttempt((entry) => log.add(entry)), [search, log]);

  useEffect(() => {
    let alive = true;
    (async () => {
      await store.hydrate(AsyncStorage);
      const [prices, past, health, covered, feesRead, adsRead, couponsRead, versusRead] = await Promise.all(
        [PRICES_KEY, HISTORY_KEY, HEALTH_KEY, COVERAGE_KEY, FEES_KEY, ADS_KEY, COUPONS_KEY, VERSUS_KEY].map((k) => AsyncStorage.getItem(k).catch(() => null)),
      );
      cache.hydrate(prices);
      history.hydrate(past);
      log.hydrate(health);
      // Searches made before the app last closed count toward each store's hour, and toward how it's tuned.
      politeness.seed(log.entries());
      storeTuner.seed(log.entries());
      coverage.hydrate(covered);
      versus.hydrate(versusRead);
      fees.hydrate(feesRead);
      ads.hydrate(adsRead);
      coupons.hydrate(couponsRead);
      if (alive) setReady(true);
    })();
    return () => {
      alive = false;
    };
  }, [store, cache, history, log, coverage, versus, fees, ads, coupons]);

  useEffect(() => {
    const save = (key: string, data: () => string) => () => AsyncStorage.setItem(key, data()).catch(() => {});
    const writers = [
      { subscribe: cache.subscribe, write: save(PRICES_KEY, () => cache.serialize()), ms: 1500 },
      { subscribe: history.subscribe, write: save(HISTORY_KEY, () => history.serialize()), ms: 3000 },
      { subscribe: log.subscribe, write: save(HEALTH_KEY, () => log.serialize()), ms: 3000 },
      { subscribe: coverage.subscribe, write: save(COVERAGE_KEY, () => coverage.serialize()), ms: 1500 },
      { subscribe: versus.subscribe, write: save(VERSUS_KEY, () => versus.serialize()), ms: 1500 },
      { subscribe: fees.subscribe, write: save(FEES_KEY, () => fees.serialize()), ms: 1500 },
      { subscribe: ads.subscribe, write: save(ADS_KEY, () => ads.serialize()), ms: 1500 },
      { subscribe: coupons.subscribe, write: save(COUPONS_KEY, () => coupons.serialize()), ms: 1500 },
    ].map((w) => ({ ...w, timer: debounced(w.write, w.ms) }));
    const unsubscribe = writers.map((w) => w.subscribe(w.timer.schedule));
    // Write everything before the app is suspended.
    const sub = RNAppState.addEventListener('change', (state) => {
      // iOS pauses the app's WebViews soon after it leaves the screen; searches wait and pick up on return.
      if (state === 'background') engine.setForeground(false);
      if (state === 'active') engine.setForeground(true);
      if (state !== 'active') {
        void store.flush();
        writers.forEach((w) => void w.write());
      }
    });
    return () => {
      unsubscribe.forEach((u) => u());
      writers.forEach((w) => w.timer.cancel());
      sub.remove();
    };
  }, [cache, history, log, coverage, versus, fees, ads, coupons, store, engine]);

  // Coming back to the app after a while fetches the rules file again, so a fixed store is picked up.
  useEffect(() => {
    const sub = RNAppState.addEventListener('change', (state) => {
      if (state === 'active' && url && Date.now() - (rules.checkedAt ?? 0) > RULES_RECHECK_MS) void checkRules();
    });
    return () => sub.remove();
  }, [url, rules.checkedAt, checkRules]);

  const runCoverage = useCallback(async () => {
    const settings = store.getState().settings;
    const all = bundle.retailers.filter((r) => r.enabled).map((r) => r.id);
    const choices = storeChoices({ ...settings, retailerIds: all }, bundle.retailers);
    await coverage.run(
      choices.map((c) => ({ config: c.config, storeId: c.storeId })),
      (cfg, q, storeId) => search.search(cfg, q, storeId, undefined, { challenge: 'report', kind: 'coverage' }),
    );
  }, [store, bundle.retailers, coverage, search]);

  const checkFees = useCallback(
    async (force = false, retailerIds?: string[]) => {
      if (!fees.beginRound()) return;
      try {
        for (const { config } of storeChoices(store.getState().settings, bundle.retailers)) {
          const url = feesKey(config.online);
          if (!url || (retailerIds && !retailerIds.includes(config.id)) || (!force && !fees.due(config.id, url))) continue;
          fees.setReading(config.id);
          try {
            const got = await search.readFees(config);
            const found = { pickup: got.pickup, delivery: got.delivery, quotes: got.quotes, count: got.count, ...(got.markup ? { markup: got.markup } : {}) };
            fees.record(config.id, { url, at: Date.now(), ok: got.count > 0, ms: got.ms, bytes: got.bytes, ...(got.count > 0 ? { fees: found } : { reason: 'no_fees' }) });
          } catch (e) {
            fees.record(config.id, { url, at: Date.now(), ok: false, reason: failureOf(e) });
          }
        }
      } finally {
        fees.endRound();
      }
    },
    [store, bundle.retailers, fees, search],
  );

  /**
   * Whether a store's lane is free for a page of its own (its ad, its coupons): no list is searching it and nothing runs
   * in its lane. Asked for by the user, it's waited for, a minute at most. One page load at a time at each store.
   */
  const storeFree = useCallback(
    async (config: RetailerConfig, wait: boolean) => {
      const free = () => !engine.busyAt(config.id) && pool.lane(config.id, config.name).isIdle();
      const until = Date.now() + (wait ? ASKED_WAIT_MS : 0);
      while (!free() && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 500));
      return free();
    },
    [engine, pool],
  );

  const runVersus = useCallback(
    async (scope: VersusScope) => {
      const settings = store.getState().settings;
      const nameOf = (id?: string) => bundle.retailers.find((r) => r.id === id)?.name;
      // Each store as it's searched (with keys, Kroger through its API alone), so its tuning only hears of the other
      // ways when its site pushes back. Its website gets the store chosen for it, not the ZIP code the API takes.
      const stores = storeChoices({ ...settings, retailerIds: versusIds(bundle.retailers, settings.retailerIds, scope) }, bundle.retailers).map((c) => ({
        config: c.config,
        storeId: settings.storeIds[c.config.id] || '',
        parentName: nameOf(c.config.sisterOf),
      }));
      let agent: string | null = null;
      await versus.run(
        stores,
        {
          prepare: async () => {
            agent = await webViewUserAgent();
          },
          search: (cfg, q, storeId, only) =>
            search.search(only === 'fetch' ? plainConfig(cfg, agent) : cfg, q, storeId, only, { challenge: 'report', kind: 'versus' }),
          roomAt: (id, n) => politeness.roomAt(id, n),
          // A list being priced there goes first, so neither waits on the other's page loads mid-search.
          whenFree: async (cfg) => {
            await storeFree(cfg, true);
          },
        },
        { scope },
      );
    },
    [store, bundle.retailers, versus, search, storeFree],
  );

  const checkAds = useCallback(
    async (asked = false, retailerIds?: string[]) => {
      if (!ads.beginRound()) return;
      try {
        const settings = store.getState().settings;
        for (const choice of storeChoices(settings, bundle.retailers)) {
          const { config } = choice;
          const target = adTarget(config, choice, settings.zip);
          if (!target || 'needs' in target || (retailerIds && !retailerIds.includes(config.id))) continue;
          if (!adDue(ads.get(config.id), target.key, Date.now(), asked) || !(await storeFree(config, asked))) continue;
          ads.setReading(config.id);
          try {
            const got = await search.readAd(config, target.url);
            const ad: WeeklyAd = { items: got.items, ...(got.from ? { from: got.from } : {}), ...(got.to ? { to: got.to } : {}), ...(got.source ? { source: got.source } : {}) };
            const ok = ad.items.length > 0;
            ads.record(config.id, { key: target.key, url: target.url, at: Date.now(), ok, ms: got.ms, bytes: got.bytes, ...(ok ? { value: ad } : { reason: 'no_ad' }) });
          } catch (e) {
            ads.record(config.id, { key: target.key, url: target.url, at: Date.now(), ok: false, reason: failureOf(e) });
          }
        }
      } finally {
        ads.endRound();
      }
    },
    [store, bundle.retailers, ads, search, storeFree],
  );

  const checkCoupons = useCallback(
    async (asked = false, retailerIds?: string[]) => {
      if (!coupons.beginRound()) return;
      try {
        const settings = store.getState().settings;
        for (const { config } of storeChoices(settings, bundle.retailers)) {
          const target = couponTarget(config, settings.signedInAt[config.id]);
          if (!target || 'needs' in target || (retailerIds && !retailerIds.includes(config.id))) continue;
          if (!couponsDue(coupons.get(config.id), target.key, Date.now(), asked) || !(await storeFree(config, asked))) continue;
          coupons.setReading(config.id);
          try {
            const got = await search.readCoupons(config);
            const list: CouponList = { coupons: got.coupons, ...(got.signedOut ? { signedOut: true } : {}), ...(got.source ? { source: got.source } : {}) };
            coupons.record(config.id, { key: target.key, url: target.url, at: Date.now(), ok: true, ms: got.ms, bytes: got.bytes, value: list });
          } catch (e) {
            coupons.record(config.id, { key: target.key, url: target.url, at: Date.now(), ok: false, reason: failureOf(e) });
          }
        }
      } finally {
        coupons.endRound();
      }
    },
    [store, bundle.retailers, coupons, search, storeFree],
  );

  const clipCoupons = useCallback(
    async (retailerId: string, couponIds: string[]) => {
      const config = bundle.retailers.find((r) => r.id === retailerId);
      const list = coupons.get(retailerId)?.value?.coupons ?? [];
      const failed: string[] = [];
      let clipped = 0;
      let reason: string | undefined;
      if (!config?.coupons) return { clipped, failed: couponIds };
      for (const id of couponIds) {
        const coupon = list.find((c) => c.id === id);
        if (!coupon || coupon.clipped) continue;
        coupons.mark(`${retailerId}|${id}`, true);
        try {
          if (!(await storeFree(config, true))) throw new Error('busy');
          const got = await search.clipCoupon(config, coupon);
          if (got.clipped) {
            clipped++;
            const at = Date.now();
            coupons.update(retailerId, (v) => ({ ...v, coupons: v.coupons.map((c) => (c.id === id ? { ...c, clipped: true, clippedAt: at } : c)) }));
          } else {
            failed.push(id);
            reason ??= 'not_clipped';
          }
        } catch (e) {
          failed.push(id);
          reason ??= failureOf(e);
        } finally {
          coupons.mark(`${retailerId}|${id}`, false);
        }
      }
      // What the page didn't confirm is known once the coupons are read again.
      if (failed.length && reason !== 'signed_out' && reason !== 'polite_limit') void checkCoupons(true, [retailerId]);
      return { clipped, failed, ...(reason ? { reason } : {}) };
    },
    [bundle.retailers, coupons, search, storeFree, checkCoupons],
  );

  const viewCoupons = useCallback(
    async (retailerId: string) => {
      const config = bundle.retailers.find((r) => r.id === retailerId);
      if (!config?.coupons) return;
      await search.viewCoupons(config);
      // What the user clipped there shows once the coupons are read again.
      await checkCoupons(true, [retailerId]);
    },
    [bundle.retailers, search, checkCoupons],
  );

  const signInAt = useCallback(
    async (retailerId: string) => {
      const config = bundle.retailers.find((r) => r.id === retailerId);
      if (!config) return;
      await search.signIn(config);
      store.noteSignedIn(retailerId, Date.now());
      if (config.member) store.setMember(retailerId, true);
      // Signed in: the account's coupons can be read, on the store's coupons page, hidden.
      if (config.coupons) await checkCoupons(true, [retailerId]);
    },
    [bundle.retailers, search, store, checkCoupons],
  );

  const onDrops = useCallback(
    (listener: (items: WatchItem[]) => void) => {
      dropListeners.add(listener);
      return () => {
        dropListeners.delete(listener);
      };
    },
    [dropListeners],
  );

  useEffect(() => {
    if (ready) onReady?.();
  }, [ready, onReady]);

  const startOver = useCallback(async () => {
    engine.reset();
    pool.resetAll();
    storeTuner.reset();
    priceEvidence.clear();
    cache.clear();
    history.clear();
    log.clear();
    coverage.clear();
    versus.clear();
    fees.clear();
    ads.clear();
    coupons.clear();
    // Saves the fresh state under its own key; the others are removed outright.
    store.reset();
    await AsyncStorage.multiRemove(STORAGE_KEYS.filter((k) => k !== 'stretch.app.v1')).catch(() => {});
  }, [engine, pool, cache, history, log, coverage, versus, fees, ads, coupons, store]);

  const value = useMemo(
    () => ({
      store, engine, cache, history, log, coverage, versus, search, bundle, rules, checkRules, runCoverage, runVersus, fees, checkFees,
      ads, coupons, checkAds, checkCoupons, clipCoupons, viewCoupons, signInAt, onDrops, pool, startOver,
    }),
    [
      store, engine, cache, history, log, coverage, versus, search, bundle, rules, checkRules, runCoverage, runVersus, fees, checkFees,
      ads, coupons, checkAds, checkCoupons, clipCoupons, viewCoupons, signInAt, onDrops, pool, startOver,
    ],
  );
  if (!ready) return null;
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppContextValue {
  const value = useContext(AppContext);
  if (!value) throw new Error('useApp must be used inside <AppProvider>');
  return value;
}

/** Re-renders when the selected part of the state changes. The store replaces only what changed. */
export function useAppState<T>(select: (state: AppState) => T): T {
  const { store } = useApp();
  return useSyncExternalStore(store.subscribe, () => select(store.getState()));
}

export const useLists = () => useAppState((s) => s.lists);
export const useSettings = () => useAppState((s) => s.settings);
export const useUsuals = () => useAppState((s) => s.usuals);
export const useTrips = () => useAppState((s) => s.trips);
export const useWatch = () => useAppState((s) => s.watch);
export function useList(id: string | undefined): GroceryList | undefined {
  return useAppState((s) => s.lists.find((l) => l.id === id));
}

/** A list's pricing run, with member prices at the stores whose loyalty program the user belongs to. */
export function usePricingRun(listId: string | undefined): PricingRun | undefined {
  const { engine } = useApp();
  const memberships = useAppState((s) => s.settings.memberships);
  const run = useSyncExternalStore(engine.subscribe, () => (listId ? engine.getRun(listId) : undefined));
  return useMemo(() => (run ? memberRun(run, memberships) : undefined), [run, memberships]);
}

/** Re-renders when any product's price history changes. */
export function useHistory(): PriceHistory {
  const { history } = useApp();
  useSyncExternalStore(history.subscribe, () => history.version);
  return history;
}

/** Re-renders when the attempt log changes. */
export function useAttemptLog(): AttemptLog {
  const { log } = useApp();
  useSyncExternalStore(log.subscribe, () => log.version);
  return log;
}

export function useStoreChoices(): StoreChoice[] {
  const settings = useSettings();
  const { bundle } = useApp();
  return useMemo(() => storeChoices(settings, bundle.retailers), [settings, bundle.retailers]);
}

/**
 * Which of the list's items can take another item's search ("Whole milk" in the search for "Milk", see sharing.ts):
 * the same object for as long as that doesn't change.
 */
export function useSharePlan(list: GroceryList | undefined): Record<string, string> {
  const usuals = useUsuals();
  const key = list ? JSON.stringify(sharePlan(list, usuals)) : '{}';
  return useMemo(() => JSON.parse(key) as Record<string, string>, [key]);
}

/**
 * Prices the list at the chosen stores: only what isn't already known, unless refreshing. Items that can take
 * another item's search do (see sharing.ts).
 */
export function usePriceList() {
  const { engine } = useApp();
  const choices = useStoreChoices();
  const usuals = useUsuals();
  return (list: GroceryList, opts?: StartOptions) => engine.start(list.id, listQueries(list), choices, { ...opts, share: sharePlan(list, usuals) });
}

export interface Comparison {
  baskets: Basket[];
  /** The best basket among stores that have finished; until one has, the best so far. */
  pick: Basket | null;
  /** The pick's store has finished, so it can be shopped while slower stores keep checking. */
  pickReady: boolean;
  /** The best split among stores that have finished, when it's worth it. */
  split: SplitTrip | null;
  /** Some store is still searching, or refreshing older prices. */
  running: boolean;
  /** When driving counts: each store's round trip, by retailer (stores whose distance is known). Not for delivery. */
  driving?: TripCosts;
  /** When driving counts: whether the pick's prices make up for the drive. */
  verdict: DriveVerdict | null;
  /** How the user shops. */
  mode: ShopMode;
  /** Ordering online: each store's order, by retailer: its items at online prices, fees and total. */
  online?: Record<string, OnlineCost>;
  /** Everything each store costs beyond its basket, by retailer, for ranking: driving, and ordering online. */
  extra?: TripCosts;
  /** Ordering online: whether a store's fees and online prices cost it the pick. */
  feesVerdict: DriveVerdict | null;
  /**
   * What the basket costs the way the user shops, as sold: its items, plus online prices and fees, less its clipped
   * coupons when the user counts them. Not driving.
   */
  orderTotal: (b: Basket) => number;
  /** The user counts clipped coupons in totals, and in ranking stores (see coupons.ts). */
  countCoupons: boolean;
  /** Each store's coupons for its basket, by retailer: the stores whose coupons the phone has read. Counted or not. */
  coupons: Record<string, CouponCredit>;
  /** What ordering `items` worth online costs at a store, for a part of the list (split trips). */
  costAt: (retailerId: string, items: number) => OnlineCost | undefined;
  /** Ordering online: what an order of a given size adds at each store, for split trips and trip savings. */
  orderCost?: OrderCost;
}

/** The fee math's view of each store: its rules, what the phone read of its fees page, and the user's plans. */
export function useFeeContexts(): (retailerId: string) => FeeContext {
  const { bundle, fees } = useApp();
  const reads = useSyncExternalStore(fees.subscribe, fees.all);
  const plans = useAppState((s) => s.settings.onlinePlans);
  return useMemo(() => feeContexts(bundle.retailers, (id, url) => figuresOf(reads[id], url), plans), [bundle.retailers, reads, plans]);
}

/** Re-renders when a fees page is read, or starts or stops being read. */
export function useFeeBook(): FeeBook {
  const { fees } = useApp();
  useSyncExternalStore(fees.subscribe, () => fees.version);
  return fees;
}

/** While the user shops online, reads the fees pages of the compared stores that are due, once per screen visit. */
export function useFeeReads(): void {
  const { checkFees } = useApp();
  const mode = useAppState((s) => s.settings.shopMode);
  const ids = useAppState((s) => s.settings.retailerIds.join());
  useEffect(() => {
    if (mode !== 'store') void checkFees();
  }, [mode, ids, checkFees]);
}

/**
 * Every store's basket for the list, with the user's usuals, Stretch's pick and the best split, from the latest
 * prices. Ranked by total, or by total in the same sizes everywhere, as the user chose on Find a store; and by what
 * each costs the way they shop: driving there, and ordering online, fees included.
 */
export function useComparison(list: GroceryList | undefined, run: PricingRun | undefined): Comparison {
  const usuals = useUsuals();
  const rankBy = useAppState((s) => s.settings.rankBy);
  const drive = useAppState((s) => s.settings.drive);
  const chosen = useAppState((s) => s.settings.chosenStores);
  const mode = useAppState((s) => s.settings.shopMode);
  const countCoupons = useAppState((s) => s.settings.countCoupons);
  const couponLists = useCoupons();
  const today = useToday();
  const ctxOf = useFeeContexts();
  return useMemo(() => {
    const way = mode === 'store' ? null : mode;
    const costAt = (retailerId: string, items: number) => (way ? onlineCost(retailerId, way, items, ctxOf(retailerId)) : undefined);
    const empty = {
      baskets: [], pick: null, pickReady: false, split: null, running: false, verdict: null, feesVerdict: null, mode, orderTotal: (b: Basket) => b.total, costAt,
      countCoupons, coupons: {},
    };
    if (!list || !run) return empty;
    const baskets = withUnitTotals(run.retailerIds.map((id) => basketFor(list, id, run.results[id], usuals)));
    const running = baskets.some((b) => !b.complete || b.refreshing > 0);
    // Driving there and back, from each store's distance as its finder gave it. Nobody drives for a delivery.
    const driving = drive.on && mode !== 'delivery' ? driveCosts(Object.fromEntries(run.retailerIds.map((id) => [id, chosen[id]?.miles])), drive.perMile) : undefined;
    // Ordering online: each store's order, at its online prices with its fees. A store that doesn't take orders that
    // way can't be the pick, nor half of a split.
    const online = way ? onlineCosts(baskets, way, ctxOf) : undefined;
    // The coupons the phone read for each store's account, on its basket; they come off totals only when the user says.
    const coupons = couponCredits(baskets, (id) => couponLists[id], today);
    const counted = countCoupons ? coupons : undefined;
    const extra = withCoupons(tripCosts(driving, online), counted);
    const can = orderable(baskets, online);
    // A slow store doesn't hold the answer back: the pick comes from the stores that are done, and changes if the
    // slow one turns out cheaper.
    const pick = stretchPick(can.filter((b) => b.complete), rankBy, extra) ?? stretchPick(can, rankBy, extra);
    const fees = online ? extrasOf(online) : undefined;
    const orderCost = way ? orderCostFn(way, ctxOf) : undefined;
    return {
      baskets,
      pick,
      pickReady: !!pick?.complete,
      split: bestSplit(can, driving, orderCost),
      running,
      driving,
      verdict: driving ? driveVerdict(can, rankBy, driving, withCoupons(fees, counted)) : null,
      mode,
      online,
      extra,
      feesVerdict: fees ? driveVerdict(can, rankBy, fees, withCoupons(driving, counted)) : null,
      orderTotal: (b: Basket) => Math.round(((online?.[b.retailerId]?.total ?? b.total) - (counted?.[b.retailerId]?.amount ?? 0)) * 100) / 100,
      costAt,
      orderCost,
      countCoupons,
      coupons,
    };
  }, [list, run, usuals, rankBy, drive, chosen, mode, ctxOf, countCoupons, couponLists, today]);
}

/** Re-renders when a weekly ad is read, or starts or stops being read. */
export function useAdBook(): ReadBook<WeeklyAd> {
  const { ads } = useApp();
  useSyncExternalStore(ads.subscribe, () => ads.version);
  return ads;
}

/** Re-renders when coupons are read or clipped, or start or stop being. */
export function useCouponBook(): ReadBook<CouponList> {
  const { coupons } = useApp();
  useSyncExternalStore(coupons.subscribe, () => coupons.version);
  return coupons;
}

/** The compared stores' weekly ads, by retailer, as last read for the store each is set to; undefined where there's none. */
export function useWeeklyAds(): Record<string, WeeklyAd | undefined> {
  const { ads } = useApp();
  const reads = useSyncExternalStore(ads.subscribe, ads.all);
  const choices = useStoreChoices();
  const zip = useAppState((s) => s.settings.zip);
  return useMemo(() => {
    const out: Record<string, WeeklyAd | undefined> = {};
    for (const c of choices) {
      const target = adTarget(c.config, c, zip);
      const read = reads[c.config.id];
      out[c.config.id] = target && !('needs' in target) && read?.key === target.key ? read.value : undefined;
    }
    return out;
  }, [reads, choices, zip]);
}

/** The compared stores' coupons, by retailer, for the accounts signed in to in the app; undefined where there are none. */
export function useCoupons(): Record<string, Coupon[] | undefined> {
  const { coupons } = useApp();
  const reads = useSyncExternalStore(coupons.subscribe, coupons.all);
  const choices = useStoreChoices();
  const signedInAt = useAppState((s) => s.settings.signedInAt);
  return useMemo(() => {
    const out: Record<string, Coupon[] | undefined> = {};
    for (const c of choices) {
      const target = couponTarget(c.config, signedInAt[c.config.id]);
      const read = reads[c.config.id];
      out[c.config.id] = target && !('needs' in target) && read?.key === target.key ? read.value?.coupons : undefined;
    }
    return out;
  }, [reads, choices, signedInAt]);
}

/**
 * Reads the compared stores' weekly ads that are due, then their coupons for the accounts signed in to here, once per
 * screen visit, when `ready` (screens that price a list wait for it: one page load at a time at each store).
 */
export function useSavingsReads(ready = true): void {
  const { checkAds, checkCoupons } = useApp();
  const ids = useAppState((s) => s.settings.retailerIds.join());
  const signedIn = useAppState((s) => Object.keys(s.settings.signedInAt).join());
  useEffect(() => {
    if (!ready) return;
    void (async () => {
      await checkAds();
      await checkCoupons();
    })();
  }, [ready, ids, signedIn, checkAds, checkCoupons]);
}

export function useRetailer(id: string | undefined): RetailerConfig | undefined {
  const { bundle } = useApp();
  return bundle.retailers.find((r) => r.id === id);
}

/** What the store setup functions in storeSetup.ts need. */
export function useSetupDeps(): SetupDeps {
  const { store, search, bundle } = useApp();
  return useMemo(
    () => ({ store, search, retailers: bundle.retailers, apiTakesZip: (cfg) => cfg.api === 'kroger' && krogerApiConfigured(), locate: locateZip }),
    [store, search, bundle.retailers],
  );
}
