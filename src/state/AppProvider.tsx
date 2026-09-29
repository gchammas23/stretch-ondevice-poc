import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import { useIsFocused } from 'expo-router';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { AppState as RNAppState } from 'react-native';
import type { GroceryList } from '../lists/types';
import { queryKey } from '../lists/types';
import type { WeeklyAd } from '../onDevice/adPage';
import { cloudRunner } from '../cloud/runner';
import { AttemptLog } from '../onDevice/attemptLog';
import type { Coupon, CouponList } from '../onDevice/couponPage';
import { CoverageCheck } from '../onDevice/coverage';
import { isObj } from '../onDevice/json';
import { krogerApiConfigured, warmUpKroger } from '../onDevice/krogerApi';
import { priceEvidence } from '../onDevice/evidence';
import { PhoneVsServer, plainConfig, versusIds, type VersusScope } from '../onDevice/phoneVsServer';
import { politeness } from '../onDevice/politeness';
import { parserProfiles, type ProfileBook } from '../onDevice/profiles';
import type { SearchHooks } from '../onDevice/retailerSearch';
import { coolWords, storeTuner, tuningBase } from '../onDevice/tuning';
import { BUNDLED_CONFIG, fetchRules, type RulesStatus } from '../onDevice/retailers';
import type { RetailerConfig, RetailerConfigBundle } from '../onDevice/types';
import { useRetailerSearch, type RetailerSearch } from '../onDevice/useRetailerSearch';
import { useWebViewPool } from '../onDevice/WebViewFetcher';
import type { WebViewPool } from '../onDevice/webviewPool';
import { adDue, adTarget } from '../pricing/ads';
import { AisleBook } from '../pricing/aisles';
import { compareStores, couponListsFor, type Comparison } from '../pricing/comparison';
import { couponsDue, couponTarget } from '../pricing/coupons';
import { FeeBook, figuresOf } from '../pricing/feeBook';
import { PriceCache } from '../pricing/priceCache';
import { memberRun } from '../pricing/member';
import { feeContexts, feesKey, type FeeContext } from '../pricing/onlineCost';
import { PriceHistory } from '../pricing/priceHistory';
import { PricingEngine, type PricingRun, type StoreChoice } from '../pricing/pricingEngine';
import { ReadBook } from '../pricing/readBook';
import { sharePlan } from '../pricing/sharing';
import { TruthBook } from '../pricing/truth';
import { useToday } from '../ui/useNow';
import { AppStore, type AppState, type WatchItem } from './appStore';
import { batteryMeter } from './battery';
import { locateZip } from './deviceLocation';
import { steadyChoices, storeChoices } from './storeChoices';
import { isUsZip, setUpStores, type SetupDeps } from './storeSetup';

const PRICES_KEY = 'stretch.prices.v1';
const HISTORY_KEY = 'stretch.history.v1';
const HEALTH_KEY = 'stretch.health.v1';
const COVERAGE_KEY = 'stretch.coverage.v1';
const FEES_KEY = 'stretch.fees.v1';
const ADS_KEY = 'stretch.ads.v1';
const COUPONS_KEY = 'stretch.coupons.v1';
const VERSUS_KEY = 'stretch.versus.v1';
const PROFILES_KEY = 'stretch.profiles.v1';
const TRUTH_KEY = 'stretch.truth.v1';
const AISLES_KEY = 'stretch.aisles.v1';
/** Every key the app saves under, for erasing it all. */
export const STORAGE_KEYS = ['stretch.app.v1', PRICES_KEY, HISTORY_KEY, HEALTH_KEY, COVERAGE_KEY, FEES_KEY, ADS_KEY, COUPONS_KEY, VERSUS_KEY, PROFILES_KEY, TRUTH_KEY, AISLES_KEY];

/** The connection counts as down for the pricing engine's words this long after the last of its failures. */
const DROP_FRESH_MS = 60_000;

/** A saved weekly ad, and a saved list of coupons: the shapes the readers give. */
const isWeeklyAd = (v: unknown): v is WeeklyAd => isObj(v) && Array.isArray(v.items);
const isCouponList = (v: unknown): v is CouponList => isObj(v) && Array.isArray(v.coupons);

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
  /** The last finished price truth check, for the results report. */
  truth: TruthBook;
  /** Where each store's results are, learned from its searches (see profiles.ts), and what they taught so far. */
  profiles: ProfileBook;
  /** Where products are in each store, beyond what searches read: what their pages said, and the user's notes. */
  aisles: AisleBook;
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
   * Saved prices and history, what was read from store pages, the search log and the last checks go (Forget prices and
   * history); lists, and where the user noted things are in stores, stay. Searches running now keep nothing, and lists
   * are priced afresh.
   */
  forgetPrices: () => void;
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
  const [truth] = useState(() => new TruthBook());
  const [fees] = useState(() => new FeeBook());
  const [ads] = useState(() => new ReadBook<WeeklyAd>(isWeeklyAd));
  const [coupons] = useState(() => new ReadBook<CouponList>(isCouponList));
  const [aisles] = useState(() => new AisleBook());
  const [dropListeners] = useState(() => new Set<(items: WatchItem[]) => void>());
  // Its search is set below, before anything can be priced (nothing renders until the saved state has loaded).
  const [engine] = useState(() => new PricingEngine(() => Promise.reject(new Error('not_ready')), cache));
  const [ready, setReady] = useState(false);
  // A search for something a store gave products for before (in the saved prices): an empty answer is then a quiet
  // block, not a lack of results (see emptyBlock in retailerSearch.ts).
  const [hooks] = useState<SearchHooks>(() => ({
    worked: (retailerId, query) => {
      const tail = `|${queryKey(query)}`;
      return cache.list().some(([key, hit]) => key.startsWith(`${retailerId}|`) && key.endsWith(tail) && hit.products.length > 0);
    },
    // Where a product's own page puts it in the store is kept, for the Shop here checklist.
    readPage: (retailerId, product, details) => aisles.notePage(retailerId, product, { aisle: details.aisle, department: details.department }),
  }));
  const custom = useSyncExternalStore(store.subscribe, () => store.getState().settings.customRetailers);
  const rulesUrl = useSyncExternalStore(store.subscribe, () => store.getState().settings.rulesUrl);
  const lightPages = useSyncExternalStore(store.subscribe, () => store.getState().settings.lightPages);
  const settings = useSyncExternalStore(store.subscribe, () => store.getState().settings);

  // Rules come from the file set in Store health, else the build's own setting, else the ones built in.
  const url = rulesUrl || process.env.EXPO_PUBLIC_RETAILER_CONFIG_URL || '';
  const current = url && fetched?.url === url ? fetched : null;
  const served = current?.bundle ?? BUNDLED_CONFIG;
  const rules = useMemo<RulesStatus>(() => (!url ? BUNDLED_STATUS : (current?.status ?? { ...BUNDLED_STATUS, url })), [url, current]);
  const search = useRetailerSearch(served.version, hooks);

  // Profiles a rules file carries: a store takes one when it has none of its own, or the file's is newer.
  useEffect(() => {
    if (ready) parserProfiles.seed(served.retailers);
  }, [ready, served]);

  const bundle = useMemo(() => {
    const ids = new Set(served.retailers.map((r) => r.id));
    return { ...served, retailers: [...served.retailers, ...custom.filter((r) => !ids.has(r.id))] };
  }, [served, custom]);

  // The rules file set now: an answer for one set before it (a slow "Check now") doesn't replace the newer one's.
  const latestUrl = useRef(url);
  useEffect(() => {
    latestUrl.current = url;
  }, [url]);

  /** Takes a fetched rules file, or keeps the rules in use and says why the file wasn't taken. */
  const applyRules = useCallback((from: string, got: Awaited<ReturnType<typeof fetchRules>>) => {
    if (from !== latestUrl.current) return;
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

  // Store setups the app closed on halfway are taken up again when it opens: until a retailer's store is set near the
  // ZIP, it isn't compared (see storeChoices).
  useEffect(() => {
    if (!ready) return;
    const { zip, retailerIds, storeSetup } = store.getState().settings;
    const again = retailerIds.filter((id) => storeSetup[id]?.zip === zip && storeSetup[id]?.status === 'failed' && storeSetup[id]?.reason === 'interrupted');
    if (isUsZip(zip) && again.length) void setUpStores(zip, setupDeps(store, search, bundle.retailers), again, { refresh: true });
    // Once, as the app opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  // Searches at once at each store, and stores at once, as the store tuning says from how their searches go; a store
  // cooling down after a block is skipped until its retry time; and a dropped connection is said as such.
  useEffect(() => {
    engine.setConcurrency({
      searches: (cfg) => storeTuner.get(cfg.id, tuningBase(cfg)).searches,
      stores: (max) => storeTuner.storesAtOnce(max),
      cooling: (cfg) => {
        const c = storeTuner.cooling(cfg.id);
        return c ? { until: c.until, words: coolWords(c) } : undefined;
      },
      connectionDropped: () => {
        const drop = storeTuner.connection();
        return drop && !drop.endedAt && Date.now() - drop.to < DROP_FRESH_MS ? { from: drop.from } : undefined;
      },
    });
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
        // Prices for the retailer's store as it is now: its watched products follow it there, if it changed. A search for
        // a store it had before, landing late, says nothing about the one it has now.
        const current = steadyChoices(store.getState().settings, bundle.retailers).find((c) => c.config.id === retailerId)?.storeKey === storeKey;
        if (current) store.followStore(retailerId, storeKey);
        const dropped = store.notePrices(retailerId, storeKey, products, at);
        if (dropped.length) dropListeners.forEach((listener) => listener(dropped));
        // Noted even when the search said nothing about its store: Your stores then says so.
        if (current) store.noteSeenStore(retailerId, storeKey, seen ?? {}, at);
      }),
    [engine, history, store, dropListeners, bundle.retailers],
  );

  useEffect(() => search.onAttempt((entry) => log.add(entry)), [search, log]);

  useEffect(() => {
    let alive = true;
    (async () => {
      await store.hydrate(AsyncStorage);
      const [prices, past, health, covered, feesRead, adsRead, couponsRead, versusRead, profilesRead, truthRead, aislesRead] = await Promise.all(
        [PRICES_KEY, HISTORY_KEY, HEALTH_KEY, COVERAGE_KEY, FEES_KEY, ADS_KEY, COUPONS_KEY, VERSUS_KEY, PROFILES_KEY, TRUTH_KEY, AISLES_KEY].map((k) =>
          AsyncStorage.getItem(k).catch(() => null),
        ),
      );
      cache.hydrate(prices);
      history.hydrate(past);
      log.hydrate(health);
      // Searches made before the app last closed count toward each store's hour, and toward how it's tuned; a store
      // that was cooling down still is, until its retry time.
      politeness.seed(log.entries());
      storeTuner.seed(log.entries());
      parserProfiles.hydrate(profilesRead);
      coverage.hydrate(covered);
      versus.hydrate(versusRead);
      truth.hydrate(truthRead);
      fees.hydrate(feesRead);
      ads.hydrate(adsRead);
      coupons.hydrate(couponsRead);
      aisles.hydrate(aislesRead);
      if (alive) setReady(true);
    })();
    return () => {
      alive = false;
    };
  }, [store, cache, history, log, coverage, versus, truth, fees, ads, coupons, aisles]);

  useEffect(() => {
    const save = (key: string, data: () => string) => () => AsyncStorage.setItem(key, data()).catch(() => {});
    const writers = [
      { subscribe: cache.subscribe, write: save(PRICES_KEY, () => cache.serialize()), ms: 1500 },
      { subscribe: history.subscribe, write: save(HISTORY_KEY, () => history.serialize()), ms: 3000 },
      { subscribe: log.subscribe, write: save(HEALTH_KEY, () => log.serialize()), ms: 3000 },
      { subscribe: coverage.subscribe, write: save(COVERAGE_KEY, () => coverage.serialize()), ms: 1500 },
      { subscribe: versus.subscribe, write: save(VERSUS_KEY, () => versus.serialize()), ms: 1500 },
      { subscribe: truth.subscribe, write: save(TRUTH_KEY, () => truth.serialize()), ms: 1500 },
      { subscribe: parserProfiles.subscribe, write: save(PROFILES_KEY, () => parserProfiles.serialize()), ms: 3000 },
      { subscribe: fees.subscribe, write: save(FEES_KEY, () => fees.serialize()), ms: 1500 },
      { subscribe: ads.subscribe, write: save(ADS_KEY, () => ads.serialize()), ms: 1500 },
      { subscribe: coupons.subscribe, write: save(COUPONS_KEY, () => coupons.serialize()), ms: 1500 },
      { subscribe: aisles.subscribe, write: save(AISLES_KEY, () => aisles.serialize()), ms: 1500 },
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
  }, [cache, history, log, coverage, versus, truth, fees, ads, coupons, aisles, store, engine]);

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
    // Whether each site answers the phone: a store that couldn't be set near the ZIP is checked too.
    const choices = storeChoices({ ...settings, retailerIds: all }, bundle.retailers, undefined, { unsetToo: true });
    await coverage.run(
      choices.map((c) => ({ config: c.config, storeId: c.storeId })),
      (cfg, q, storeId) => search.search(cfg, q, storeId, undefined, { challenge: 'report', kind: 'coverage' }),
    );
  }, [store, bundle.retailers, coverage, search]);

  /**
   * Whether a store is free for a page of its own (its ad, its coupons, its fees): no list is searching it and nothing
   * runs in its lane. Asked for by the user, it's waited for, a minute at most. One page load at a time at each store.
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

  const checkFees = useCallback(
    async (force = false, retailerIds?: string[]) => {
      // A read the user asked for waits for one going on its own, rather than being dropped.
      while (!fees.beginRound()) {
        if (!force) return;
        await fees.roundOver();
      }
      // Everything erased meanwhile: the round stops, and records nothing more.
      const epoch = fees.epoch;
      try {
        for (const { config } of storeChoices(store.getState().settings, bundle.retailers)) {
          const url = feesKey(config.online);
          if (!url || (retailerIds && !retailerIds.includes(config.id)) || (!force && !fees.due(config.id, url))) continue;
          // The fees page is on the store's own site: not while the store is being searched.
          if (!(await storeFree(config, force))) continue;
          if (fees.epoch !== epoch) break;
          fees.setReading(config.id);
          try {
            const got = await search.readFees(config);
            if (fees.epoch !== epoch) break;
            const found = { pickup: got.pickup, delivery: got.delivery, quotes: got.quotes, count: got.count, ...(got.markup ? { markup: got.markup } : {}) };
            fees.record(config.id, { url, at: Date.now(), ok: got.count > 0, ms: got.ms, bytes: got.bytes, ...(got.count > 0 ? { fees: found } : { reason: 'no_fees' }) });
          } catch (e) {
            if (fees.epoch !== epoch) break;
            fees.record(config.id, { url, at: Date.now(), ok: false, reason: failureOf(e) });
          }
        }
      } finally {
        fees.endRound();
      }
    },
    [store, bundle.retailers, fees, search, storeFree],
  );

  const runVersus = useCallback(
    async (scope: VersusScope) => {
      const settings = store.getState().settings;
      const nameOf = (id?: string) => bundle.retailers.find((r) => r.id === id)?.name;
      // Each store as it's searched (with keys, Kroger through its API alone), so its tuning only hears of the other
      // ways when its site pushes back. Its website gets the store chosen for it, not the ZIP code the API takes.
      const stores = storeChoices({ ...settings, retailerIds: versusIds(bundle.retailers, settings.retailerIds, scope) }, bundle.retailers, undefined, { unsetToo: true }).map((c) => ({
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
      // A read the user asked for waits for one going on its own, rather than being dropped.
      while (!ads.beginRound()) {
        if (!asked) return;
        await ads.roundOver();
      }
      // Everything erased meanwhile: the round stops, and records nothing more.
      const epoch = ads.epoch;
      try {
        const settings = store.getState().settings;
        for (const choice of storeChoices(settings, bundle.retailers)) {
          const { config } = choice;
          const target = adTarget(config, choice, settings.zip);
          if (!target || 'needs' in target || (retailerIds && !retailerIds.includes(config.id))) continue;
          if (!adDue(ads.get(config.id), target.key, Date.now(), asked) || !(await storeFree(config, asked))) continue;
          if (ads.epoch !== epoch) break;
          ads.setReading(config.id);
          try {
            const got = await search.readAd(config, target.url);
            if (ads.epoch !== epoch) break;
            const ad: WeeklyAd = { items: got.items, ...(got.from ? { from: got.from } : {}), ...(got.to ? { to: got.to } : {}), ...(got.source ? { source: got.source } : {}) };
            const ok = ad.items.length > 0;
            ads.record(config.id, { key: target.key, url: target.url, at: Date.now(), ok, ms: got.ms, bytes: got.bytes, ...(ok ? { value: ad } : { reason: 'no_ad' }) });
          } catch (e) {
            if (ads.epoch !== epoch) break;
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
      // A read the user asked for (after signing in, clipping, or the coupons page) waits for one going on its own.
      while (!coupons.beginRound()) {
        if (!asked) return;
        await coupons.roundOver();
      }
      // Everything erased meanwhile: the round stops before reading any more of the accounts' pages.
      const epoch = coupons.epoch;
      try {
        const settings = store.getState().settings;
        for (const { config } of storeChoices(settings, bundle.retailers)) {
          const target = couponTarget(config, settings.signedInAt[config.id]);
          if (!target || 'needs' in target || (retailerIds && !retailerIds.includes(config.id))) continue;
          if (!couponsDue(coupons.get(config.id), target.key, Date.now(), asked) || !(await storeFree(config, asked))) continue;
          if (coupons.epoch !== epoch) break;
          coupons.setReading(config.id);
          try {
            const got = await search.readCoupons(config);
            if (coupons.epoch !== epoch) break;
            const list: CouponList = { coupons: got.coupons, ...(got.signedOut ? { signedOut: true } : {}), ...(got.source ? { source: got.source } : {}) };
            coupons.record(config.id, { key: target.key, url: target.url, at: Date.now(), ok: true, ms: got.ms, bytes: got.bytes, value: list });
          } catch (e) {
            if (coupons.epoch !== epoch) break;
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
      const had = store.getState().settings;
      const before = had.signedInAt[retailerId];
      const wasMember = !!had.memberships[retailerId];
      await search.signIn(config);
      const at = Date.now();
      store.noteSignedIn(retailerId, at);
      if (config.member) store.setMember(retailerId, true);
      if (!config.coupons) return;
      // Signed in: the account's coupons can be read, on the store's coupons page, hidden.
      await checkCoupons(true, [retailerId]);
      // That page says nobody is signed in (Done was tapped without signing in): no account, and no member prices it
      // turned on, but a membership the user set themselves stays.
      const read = coupons.get(retailerId);
      const signedOut = !!read && read.at >= at && (read.reason === 'signed_out' || !!read.value?.signedOut);
      if (signedOut && store.getState().settings.signedInAt[retailerId] === at) {
        store.undoSignIn(retailerId, before);
        if (config.member && !wasMember) store.setMember(retailerId, false);
      }
    },
    [bundle.retailers, search, store, checkCoupons, coupons],
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

  const forgetPrices = useCallback(() => {
    // Nothing running adds to what's erased: runs are forgotten, searches, checks and reads under way keep nothing.
    // Cloud jobs are stopped (their browsers too) and forgotten.
    void cloudRunner.clear();
    engine.reset();
    search.reset();
    priceEvidence.clear();
    cache.clear();
    history.clear();
    log.clear();
    coverage.clear();
    versus.clear();
    truth.clear();
    fees.clear();
    ads.clear();
    coupons.clear();
    aisles.forgetPages();
  }, [engine, search, cache, history, log, coverage, versus, truth, fees, ads, coupons, aisles]);

  const startOver = useCallback(async () => {
    forgetPrices();
    // Kept pages go too: a page loading now finishes, but isn't kept (see WebViewQueue.reset).
    pool.resetAll();
    pool.feed.clear();
    storeTuner.reset();
    parserProfiles.clear();
    aisles.clear();
    // Saves the fresh state under its own key; the others are removed outright.
    store.reset();
    await AsyncStorage.multiRemove(STORAGE_KEYS.filter((k) => k !== 'stretch.app.v1')).catch(() => {});
  }, [forgetPrices, pool, store, aisles]);

  const value = useMemo(
    () => ({
      store, engine, cache, history, log, coverage, versus, truth, profiles: parserProfiles, aisles, search, bundle, rules, checkRules, runCoverage,
      runVersus, fees, checkFees, ads, coupons, checkAds, checkCoupons, clipCoupons, viewCoupons, signInAt, onDrops, pool, forgetPrices, startOver,
    }),
    [
      store, engine, cache, history, log, coverage, versus, truth, aisles, search, bundle, rules, checkRules, runCoverage, runVersus, fees, checkFees,
      ads, coupons, checkAds, checkCoupons, clipCoupons, viewCoupons, signInAt, onDrops, pool, forgetPrices, startOver,
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

const noUpdates = () => () => {};

/**
 * A list's pricing run, with member prices at the stores whose loyalty program the user belongs to. A screen that
 * isn't showing (one under another in the stack) doesn't draw again as each price lands, while the phone is busy
 * reading the stores: it catches up when it shows again.
 */
export function usePricingRun(listId: string | undefined): PricingRun | undefined {
  const { engine } = useApp();
  const focused = useIsFocused();
  const memberships = useAppState((s) => s.settings.memberships);
  const run = useSyncExternalStore(focused ? engine.subscribe : noUpdates, () => (listId ? engine.getRun(listId) : undefined));
  return useMemo(() => (run ? memberRun(run, memberships) : undefined), [run, memberships]);
}

/** Re-renders when any product's price history changes. */
export function useHistory(): PriceHistory {
  const { history } = useApp();
  useSyncExternalStore(history.subscribe, () => history.version);
  return history;
}

/** Re-renders when a product's place in a store is read from its page, or noted. */
export function useAisles(): AisleBook {
  const { aisles } = useApp();
  useSyncExternalStore(aisles.subscribe, () => aisles.version);
  return aisles;
}

/** Re-renders when a store's profile is learned, matched, missed or reset. */
export function useProfiles(): ProfileBook {
  const { profiles } = useApp();
  useSyncExternalStore(profiles.subscribe, () => profiles.version);
  return profiles;
}

/** Re-renders when the attempt log changes. */
export function useAttemptLog(): AttemptLog {
  const { log } = useApp();
  useSyncExternalStore(log.subscribe, () => log.version);
  return log;
}

/** The stores to compare: the same array until they change (see steadyChoices), so screens don't price again meanwhile. */
export function useStoreChoices(): StoreChoice[] {
  const settings = useSettings();
  const { bundle } = useApp();
  return useMemo(() => steadyChoices(settings, bundle.retailers), [settings, bundle.retailers]);
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

export type { Comparison } from '../pricing/comparison';

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

/**
 * While the user shops online, reads the fees pages of the compared stores that are due, once per screen visit, when
 * `ready` (screens that price a list wait for it: one page load at a time at each store).
 */
export function useFeeReads(ready = true): void {
  const { checkFees } = useApp();
  const mode = useAppState((s) => s.settings.shopMode);
  const ids = useAppState((s) => s.settings.retailerIds.join());
  useEffect(() => {
    if (ready && mode !== 'store') void checkFees();
  }, [ready, mode, ids, checkFees]);
}

/**
 * Every store's basket for the list, with the user's usuals, Stretch's pick and the best split, from the latest
 * prices (see compareStores): what Find a store and the other screens show.
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
  return useMemo(
    () => compareStores(list, run, { usuals, rankBy, drive, chosen, mode, ctxOf, countCoupons, couponLists, today }),
    [list, run, usuals, rankBy, drive, chosen, mode, ctxOf, countCoupons, couponLists, today],
  );
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
  return useMemo(() => couponListsFor(choices, reads, signedInAt), [reads, choices, signedInAt]);
}

/**
 * Reads the compared stores' weekly ads that are due, then their coupons for the accounts signed in to here, once per
 * screen visit, when `ready` (screens that price a list wait for it: one page load at a time at each store).
 */
export function useSavingsReads(ready = true): void {
  const { checkAds, checkCoupons } = useApp();
  // Another store, a new ZIP or a sign-in has its own ad and coupons: they're read when those change too.
  const zip = useAppState((s) => s.settings.zip);
  const stores = useStoreChoices()
    .map((c) => `${c.config.id}:${c.storeKey}`)
    .join();
  useEffect(() => {
    if (!ready) return;
    void (async () => {
      await checkAds();
      await checkCoupons();
    })();
  }, [ready, zip, stores, checkAds, checkCoupons]);
}

export function useRetailer(id: string | undefined): RetailerConfig | undefined {
  const { bundle } = useApp();
  return bundle.retailers.find((r) => r.id === id);
}

/**
 * A store's name, by retailer id: as the rules give it; for a store they no longer have (one added and removed), as
 * `run` recorded it; else its id.
 */
export function useStoreName(run?: PricingRun): (retailerId: string) => string {
  const { bundle } = useApp();
  return useCallback((rid: string) => bundle.retailers.find((r) => r.id === rid)?.name ?? run?.stores[rid]?.name ?? rid, [bundle.retailers, run]);
}

/** What the store setup functions in storeSetup.ts need. */
function setupDeps(store: AppStore, search: RetailerSearch, retailers: RetailerConfig[]): SetupDeps {
  return { store, search, retailers, apiTakesZip: (cfg) => cfg.api === 'kroger' && krogerApiConfigured(), locate: locateZip };
}

export function useSetupDeps(): SetupDeps {
  const { store, search, bundle } = useApp();
  return useMemo(() => setupDeps(store, search, bundle.retailers), [store, search, bundle.retailers]);
}
