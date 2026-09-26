import * as Battery from 'expo-battery';
import { useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import { BatteryMeter, type BatteryMeterState, type BatteryNews, type BatteryReading, type ChargeState } from '../pricing/batteryCost';

// The phone's battery, through expo-battery (included in Expo Go), for the battery meter in batteryCost.ts.

const CHARGE: Record<number, ChargeState> = {
  [Battery.BatteryState.UNPLUGGED]: 'unplugged',
  [Battery.BatteryState.CHARGING]: 'charging',
  [Battery.BatteryState.FULL]: 'full',
  [Battery.BatteryState.NOT_CHARGING]: 'not_charging',
};

/** A reading can't take longer than this: past it, the battery counts as unreadable. */
const READ_TIMEOUT_MS = 1500;

const unknown = (): BatteryReading => ({ at: Date.now(), level: null, charge: 'unknown', lowPower: false });

/**
 * The battery now: its level, whether it's plugged in, and Low Power Mode. Never throws. A simulator has no battery to
 * read, and neither do most computers' browsers: their level is null.
 */
async function read(): Promise<BatteryReading> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<BatteryReading>((resolve) => {
    timer = setTimeout(() => resolve(unknown()), READ_TIMEOUT_MS);
  });
  const got = Promise.all([Battery.isAvailableAsync(), Battery.getPowerStateAsync()]).then(
    ([available, power]): BatteryReading => ({
      at: Date.now(),
      level: available && power.batteryLevel >= 0 && power.batteryLevel <= 1 ? power.batteryLevel : null,
      charge: CHARGE[power.batteryState] ?? 'unknown',
      lowPower: power.lowPowerMode,
    }),
    unknown,
  );
  try {
    return await Promise.race([got, late]);
  } finally {
    clearTimeout(timer);
  }
}

/** Subscribes, or does without: expo-battery's listeners throw in a browser, where readings still work. */
function listen(subscribe: () => { remove: () => void }): { remove: () => void } {
  try {
    return subscribe();
  } catch {
    return { remove: () => {} };
  }
}

/**
 * The phone's news: plugged in or out, Low Power Mode, the level (iOS says so at each whole percent, once a minute at
 * most), and the app leaving the screen or coming back. Only leaving for good counts: iOS pauses the app's pages in
 * the background, not while it's merely inactive (a notification pulled down).
 */
function watch(listener: (news: BatteryNews) => void): () => void {
  const subscriptions = [
    listen(() => Battery.addBatteryStateListener(({ batteryState }) => listener({ kind: 'charge', charge: CHARGE[batteryState] ?? 'unknown', at: Date.now() }))),
    listen(() => Battery.addLowPowerModeListener(({ lowPowerMode }) => listener({ kind: 'lowPower', on: lowPowerMode, at: Date.now() }))),
    listen(() =>
      Battery.addBatteryLevelListener(({ batteryLevel }) => {
        if (batteryLevel >= 0 && batteryLevel <= 1) listener({ kind: 'level', level: batteryLevel, at: Date.now() });
      }),
    ),
    listen(() =>
      AppState.addEventListener('change', (state) => {
        if (state === 'background' || state === 'active') listener({ kind: 'app', active: state === 'active', at: Date.now() });
      }),
    ),
  ];
  return () => subscriptions.forEach((s) => s.remove());
}

/**
 * The app's battery meter: attached to the pricing engine when the app starts (see AppProvider), read by Store health
 * for this session's pricing and by Diagnostics for the speed test's runs and the battery test.
 */
export const batteryMeter = new BatteryMeter({ read, watch });

/** The battery meter's state, re-rendering when it changes. */
export function useBattery(): BatteryMeterState {
  return useSyncExternalStore(batteryMeter.subscribe, batteryMeter.getSnapshot);
}
