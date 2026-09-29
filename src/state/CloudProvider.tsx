import AsyncStorage from '@react-native-async-storage/async-storage';
import { router } from 'expo-router';
import React, { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import { connectToPage } from '../cloud/cdp';
import { ITEMS_PER_TERM } from '../cloud/config';
import type { CloudJob } from '../cloud/jobs';
import { askForNotifications, notifyJobDone, openJobsFromNotifications } from '../cloud/notify';
import { fromProduct } from '../cloud/plan';
import { browserUseApi, cloudRunner, type CloudRunner } from '../cloud/runner';
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
      // What stays on this phone goes through the app's own search, as always: Kroger through its official API.
      deviceSearch: async (retailerId, term, storeId) => {
        const { store, search, bundle } = latest.current;
        const settings = store.getState().settings;
        const choice = storeChoices({ ...settings, retailerIds: [retailerId] }, bundle.retailers, undefined, { unsetToo: true })[0];
        const config = choice?.config ?? bundle.retailers.find((r) => r.id === retailerId);
        if (!config) throw new Error(`${retailerId} isn’t in the store rules`);
        const outcome = await search.search(config, term, storeId);
        return { items: outcome.products.slice(0, ITEMS_PER_TERM).map(fromProduct), found: outcome.products.length, storeId: outcome.store?.id };
      },
    });
    const off = cloudRunner.onFinished((job) => void notifyJobDone(job));
    cloudRunner.setActive(AppState.currentState === 'active' || AppState.currentState == null);
    const sub = AppState.addEventListener('change', (state) => cloudRunner.setActive(state === 'active'));
    void cloudRunner.hydrate(AsyncStorage);
    return () => {
      off();
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
