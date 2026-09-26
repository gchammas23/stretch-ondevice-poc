import { mergeStores, sameStoreId, storeLine } from '../onDevice/storeIdentity';
import type { KnownStore } from '../onDevice/types';
import { ago } from '../pricing/age';
import type { SeenStore, Settings, StoreSetup } from './appStore';

// Pure functions only, so the tests run them in Node.
//
// Which store each retailer is set to, put together from how it was set (Kroger's API, the store finder the app
// pressed, the site the user chose on) and from what its searches asked prices for.

/** A retailer's store, as Your stores shows it. */
export interface StoreInfo {
  /** "Sacramento Supercenter", or who picks the store when it isn't known. */
  title: string;
  /** Its address and number: "8915 Gerber Rd, Sacramento, CA 95829 · store 3081". */
  detail?: string;
  /** How it was set: "Set automatically on walmart.com, near 95829". */
  how: string;
  /** Where the latest search's prices came from, next to the store that was set. */
  check?: { tone: 'ok' | 'warn'; text: string };
}

/** The store setup for the ZIP code now set, when it finished. */
function doneSetup(retailerId: string, settings: Settings): StoreSetup | undefined {
  const setup = settings.storeSetup[retailerId];
  return settings.zip && setup?.zip === settings.zip && setup.status === 'done' ? setup : undefined;
}

/**
 * What's known about a retailer's store: the one set (from its store finder or its site), what its latest search
 * got prices for (only if it ran under `storeKey`, when given), and the two together. When they name different
 * stores, the search's is where the prices came from.
 */
export function knownStore(
  retailerId: string,
  settings: Settings,
  storeKey?: string,
): { chosen?: KnownStore; seen?: SeenStore; store?: KnownStore; conflict: boolean } {
  const setup = doneSetup(retailerId, settings);
  const chosen: KnownStore | undefined =
    settings.chosenStores[retailerId] ?? (setup?.how === 'auto' && setup.label ? { name: setup.label } : undefined);
  const seenRaw = settings.seenStores[retailerId];
  const seen = seenRaw && (storeKey === undefined || seenRaw.storeKey === storeKey) ? seenRaw : undefined;
  const conflict = !!chosen?.id && !!seen?.id && !sameStoreId(chosen.id, seen.id);
  return { chosen, seen, store: conflict ? mergeStores(seen) : mergeStores(chosen, seen), conflict };
}

/**
 * The store a retailer's prices come from, in a line under its name: "Secaucus Supercenter (store 3520), near
 * 10001", or who picks it when it isn't known.
 */
export function storeNote(retailerId: string, settings: Settings): string {
  const setup = doneSetup(retailerId, settings);
  const line = storeLine(knownStore(retailerId, settings).store);
  if (line) return setup && setup.how !== 'site' ? `${line}, near ${setup.zip}` : line;
  if (setup) {
    if (setup.how === 'site') return `The store you chose near ${setup.zip}`;
    return `Nearest store to ${setup.zip}`;
  }
  const storeId = settings.storeIds[retailerId];
  if (storeId) return /^\d{5}$/.test(storeId) ? `Nearest store to ${storeId}` : `Store ${storeId}`;
  if (settings.storePickedAt[retailerId]) return 'The store you chose on its site';
  return 'The store its site picks for this phone';
}

const REASONS: Record<string, string> = {
  challenge: 'a bot check',
  no_stores_listed: 'its store finder listed none',
  no_store_finder: 'no store finder is known for it',
  button_not_found: 'its store finder changed',
  timeout: 'its store finder was too slow',
  interrupted: 'the app closed before it was done',
  api_not_configured: 'its API has no keys',
};

/** Why a store couldn't be listed or set, in words. */
export const reasonText = (reason?: string): string => REASONS[reason ?? ''] ?? (reason ?? 'it failed').replace(/_/g, ' ');

/** "2.1 mi". */
export const milesText = (miles: number): string => `${miles < 10 ? miles.toFixed(1) : Math.round(miles)} mi`;

/**
 * A retailer's store for Your stores: its name, address, number and distance as far as they're known, how it was
 * set, and whether the latest search (under `storeKey`) got its prices there. A retailer with no store within the
 * radius says so; it isn't compared.
 */
export function storeInfo(retailerId: string, retailerName: string, host: string, settings: Settings, storeKey: string, now: number): StoreInfo {
  const setup = settings.zip && settings.storeSetup[retailerId]?.zip === settings.zip ? settings.storeSetup[retailerId] : undefined;
  if (setup?.status === 'none') {
    const nearest = settings.nearbyStores[retailerId]?.stores.find((s) => s.miles !== undefined);
    return {
      title: `No ${retailerName} within ${settings.radiusMiles} mi`,
      how: nearest?.miles !== undefined ? `Its nearest store is ${milesText(nearest.miles)} from ${setup.zip}, so it isn’t compared.` : `Not compared near ${setup.zip}.`,
    };
  }
  const chosenStore = settings.chosenStores[retailerId];
  const { chosen, seen, store, conflict } = knownStore(retailerId, settings, storeKey);
  const shown = conflict ? chosen : store;
  const picked = !!settings.storePickedAt[retailerId];
  const failed = setup?.status === 'failed';

  let title: string;
  if (shown?.name) title = shown.name;
  else if (shown?.id) title = `Store ${shown.id}`;
  else if (setup?.how === 'api') title = `The ${retailerName} store nearest ${setup.zip}`;
  else if (picked && !failed) title = `The store you chose on ${host}`;
  else title = `The store ${host} picks for this phone`;
  const miles = !conflict && chosenStore?.miles !== undefined ? milesText(chosenStore.miles) : undefined;
  const detail = [shown?.address, shown?.name && shown.id ? `store ${shown.id}` : undefined, miles].filter(Boolean).join(' · ') || undefined;

  const which = chosenStore?.from === 'list' ? 'Picked by you' : setup ? `Nearest to ${setup.zip}` : '';
  let how: string;
  if (failed) {
    how = `Couldn’t set its store near ${setup?.zip}: ${reasonText(setup?.reason)}.`;
  } else if (setup?.status === 'done' && setup.how === 'api') how = `${which}, through ${retailerName}’s official API`;
  else if (setup?.status === 'done' && setup.how === 'auto') how = `${which}, set on ${host}’s store finder by the app`;
  else if (setup?.status === 'done' && setup.how === 'pinned') how = `${which}, asked for by number in each search`;
  else if (chosenStore?.from === 'finder') how = `Set automatically on ${host}${setup ? `, near ${setup.zip}` : ''}`;
  else if (chosenStore?.from === 'site' || picked) how = `You chose it on ${host}${setup ? `, near ${setup.zip}` : ''}`;
  else how = `Not chosen: ${host} picks one from this phone’s connection. Set your location to use the nearest store.`;

  let check: StoreInfo['check'];
  if (seen && conflict) {
    check = { tone: 'warn', text: `The last search got prices for ${storeLine(seen)} instead: ${host} wouldn’t take this store.` };
  } else if (seen) {
    check = { tone: 'ok', text: `The last search’s prices were for this store (${ago(now - seen.at)}).` };
  }
  return { title, ...(detail ? { detail } : {}), how, ...(check ? { check } : {}) };
}
