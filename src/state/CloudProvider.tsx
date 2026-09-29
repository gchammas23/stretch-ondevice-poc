import AsyncStorage from '@react-native-async-storage/async-storage';
import { router } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import { connectToPage } from '../cloud/cdp';
import { comparisonOf, comparisons, type Comparison } from '../cloud/compare';
import { browserUseKey, ITEMS_PER_TERM } from '../cloud/config';
import type { CloudJob } from '../cloud/jobs';
import { askForNotifications, notifyComparisonDone, notifyJobDone, openJobsFromNotifications } from '../cloud/notify';
import { deviceResult } from '../cloud/plan';
import { browserUseApi, cloudRunner, DeviceSearchError, type CloudRunner } from '../cloud/runner';
import { fromFailure } from '../onDevice/phoneVsServer';
import type { SearchOutcome } from '../onDevice/types';
import { useApp, useAppState } from './AppProvider';
import { storeChoices } from './storeChoices';

/**
 * Runs cloud jobs whatever screen is open (see src/cloud/runner.ts): gives the runner the Browser Use API, the
 * DevTools connection and the app's own search for what stays on this phone (Kroger's API), loads the saved jobs,
 * follows the app to the background and back, and opens a job when its notification is tapped.
 */
export function CloudProvider({ children }: { children: React.ReactNode }) {
  const { store, search, bundle } = useApp();
  const on = useAppState((s) => s.settings.cloud.on);
  const hasJobs = useSyncExternalStore(cloudRunner.subscribe, () => cloudRunner.getJobs().length > 0);
  // The runner outlives renders: it reads the app's search and rules as they are when it searches.
  const latest = useRef({ store, search, bundle });
  useEffect(() => {
    latest.current = { store, search, bundle };
  }, [store, search, bundle]);

  useEffect(() => {
    cloudRunner.attach({
      api: browserUseApi(),
      connect: (cdpUrl) => connectToPage(cdpUrl, { fetchJson: (url) => fetch(url) }),
      // What stays on this phone goes through the app's own search, as always: Kroger through its official API. A
      // comparison's phone side is searched the same way, as a test: a bot check is noted, not shown (the cloud's
      // can't be pressed either), and its searches count as the phone vs. server test's do.
      deviceSearch: async (retailerId, term, storeId, opts) => {
        const { store, search, bundle } = latest.current;
        const settings = store.getState().settings;
        const choice = storeChoices({ ...settings, retailerIds: [retailerId] }, bundle.retailers, undefined, { unsetToo: true })[0];
        const config = choice?.config ?? bundle.retailers.find((r) => r.id === retailerId);
        if (!config) throw new Error(`${retailerId} isn’t in the store rules`);
        const began = Date.now();
        let outcome: SearchOutcome;
        try {
          outcome = await search.search(config, term, storeId, undefined, opts?.test ? { challenge: 'report', kind: 'versus' } : undefined);
        } catch (e) {
          if (!opts?.test) throw e;
          const side = fromFailure(e, Date.now() - began);
          throw new DeviceSearchError(side.reason ?? 'failed', side.detail ?? (e instanceof Error ? e.message : undefined), {
            blocked: side.verdict === 'blocked',
            ms: side.ms,
            ...(side.bytes !== undefined ? { bytes: side.bytes } : {}),
          });
        }
        // The store its answer priced, where the answer says (Target's do, product by product), not just the one asked.
        return deviceResult(outcome, storeId, ITEMS_PER_TERM);
      },
    });
    const off = cloudRunner.onFinished((job) => void notifyJobDone(job));
    const offCompared = cloudRunner.onCompared((comparison) => void notifyComparisonDone(comparison));
    cloudRunner.setActive(AppState.currentState === 'active' || AppState.currentState == null);
    const sub = AppState.addEventListener('change', (state) => cloudRunner.setActive(state === 'active'));
    void cloudRunner.hydrate(AsyncStorage);
    return () => {
      off();
      offCompared();
      sub.remove();
    };
  }, []);

  // A tap on a job's notification opens it: listened for once cloud fetch is on, or has jobs from before.
  useEffect(() => {
    if (!on && !hasJobs) return;
    return openJobsFromNotifications((url) => router.push(url));
  }, [on, hasJobs]);

  return <>{children}</>;
}

/** The app's cloud runner; re-renders when any job changes. */
export function useCloudRunner(): CloudRunner {
  useSyncExternalStore(cloudRunner.subscribe, () => cloudRunner.version);
  return cloudRunner;
}

/** Every cloud job, newest first. */
export function useCloudJobs(): CloudJob[] {
  return useSyncExternalStore(cloudRunner.subscribe, cloudRunner.getJobs);
}

/** One job, by id. */
export function useCloudJob(id: string | undefined): CloudJob | undefined {
  return useSyncExternalStore(cloudRunner.subscribe, () => (id ? cloudRunner.getJob(id) : undefined));
}

/** Every Phone vs. cloud comparison, newest first (see compare.ts). */
export function useComparisons(): Comparison[] {
  const jobs = useCloudJobs();
  return useMemo(() => comparisons(jobs), [jobs]);
}

/** One comparison, by id. */
export function useComparison(id: string | undefined): Comparison | undefined {
  const jobs = useCloudJobs();
  return useMemo(() => (id ? comparisonOf(jobs, id) : undefined), [jobs, id]);
}

/** The Browser Use account's credit, read when the screen opens and on `refresh`. */
export function useCloudBalance(): { usd?: number; sessions?: number; error?: string; loading: boolean; refresh: () => void } {
  const [state, setState] = useState<{ usd?: number; sessions?: number; error?: string; loading: boolean }>(() => ({ loading: !!browserUseKey() }));
  const read = useCallback(() => {
    if (!browserUseKey()) return () => {};
    let alive = true;
    browserUseApi()
      .account()
      .then(
        (account) => alive && setState({ usd: account.balanceUsd, sessions: account.activeSessions, loading: false }),
        (e: unknown) => alive && setState({ error: e instanceof Error ? e.message : 'failed', loading: false }),
      );
    return () => {
      alive = false;
    };
  }, []);
  useEffect(read, [read]);
  const refresh = useCallback(() => {
    setState((s) => ({ ...s, loading: true }));
    read();
  }, [read]);
  return { ...state, refresh };
}

/** Asks to show notifications once, the first time cloud work is started or cloud fetch turned on. */
export function useAskForNotificationsOnce(): () => Promise<void> {
  const { store } = useApp();
  return useCallback(async () => {
    if (store.getState().settings.cloud.askedNotifications) return;
    store.setCloud({ askedNotifications: true });
    await askForNotifications();
  }, [store]);
}

/** Turns cloud fetch on or off; the first time it's turned on, the phone asks to show notifications. */
export function useSetCloudOn(): (on: boolean) => Promise<void> {
  const { store } = useApp();
  return useCallback(
    async (on: boolean) => {
      store.setCloud({ on });
      if (on && !store.getState().settings.cloud.askedNotifications) {
        store.setCloud({ askedNotifications: true });
        await askForNotifications();
      }
    },
    [store],
  );
}
