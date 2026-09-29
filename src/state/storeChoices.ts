import { cloudRetailers } from '../cloud/plan';
import { krogerApiConfigured } from '../onDevice/krogerApi';
import type { RetailerConfig } from '../onDevice/types';
import type { StoreChoice } from '../pricing/pricingEngine';
import type { Settings } from './appStore';

// Pure functions only, so the tests run them in Node.

/** True when the retailer's official API has credentials, so it can do all of that retailer's searching. */
export type ApiReady = (cfg: RetailerConfig) => boolean;

const krogerReady: ApiReady = (cfg) => cfg.api === 'kroger' && krogerApiConfigured();

/**
 * A retailer whose store couldn't be set near the ZIP code, to be compared all the same: its site picks the store from
 * the phone's connection (or keeps one set near an earlier ZIP), which can be anywhere. Only for asking whether its
 * site answers the phone at all (the store check, the phone vs. server test), never for prices.
 */
export interface ChoiceOptions {
  unsetToo?: boolean;
}

/**
 * The stores to compare, from the settings: what each is searched with, and a key that changes when its store does
 * (so saved prices for the old store aren't reused). A retailer with no store within the radius of the ZIP code
 * isn't compared: there's nothing near to price. Nor is one whose store couldn't be set near it (see ChoiceOptions),
 * unless its official API takes the ZIP itself, or it has no store finder (a store added from a link: its site picks,
 * as it always has).
 */
export function storeChoices(settings: Settings, retailers: RetailerConfig[], apiReady: ApiReady = krogerReady, opts: ChoiceOptions = {}): StoreChoice[] {
  return settings.retailerIds.flatMap((id) => {
    const found = retailers.find((r) => r.id === id && r.enabled);
    if (!found) return [];
    const setup = settings.zip && settings.storeSetup[id]?.zip === settings.zip ? settings.storeSetup[id] : undefined;
    if (setup?.status === 'none') return [];
    if (setup?.status === 'failed' && !opts.unsetToo && !apiReady(found) && setup.reason !== 'no_store_finder') return [];
    // The store chosen for it (its number goes to the API, or into its site's search requests); before one is, an
    // official API takes the ZIP itself.
    const storeId = settings.storeIds[id] || (apiReady(found) ? settings.zip : '');
    let strategies = found.strategies;
    if (apiReady(found) && strategies.includes('api')) {
      // With credentials, the official API does it all: a website fallback would only add slow page loads.
      strategies = ['api'];
    } else if (settings.storePickedAt[id]) {
      // A store set on the site lives in the WebView's cookies, which a plain request doesn't send, so it would
      // get the store the site picks from the connection instead.
      const kept = strategies.filter((s) => s !== 'fetch');
      if (kept.length) strategies = kept;
    }
    const config = strategies === found.strategies || strategies.join() === found.strategies.join() ? found : { ...found, strategies };
    // Signing in to the store's site can change its prices (the member's own), so it's another store key too.
    const signedIn = settings.signedInAt[id] ? `~${settings.signedInAt[id]}` : '';
    return [{ config, storeId, storeKey: `${storeId}@${settings.storePickedAt[id] ?? 0}${signedIn}` }];
  });
}

/** The last choices made from each set of rules (see steadyChoices). */
const lastChoices = new WeakMap<RetailerConfig[], StoreChoice[]>();
/** The choices made from each settings snapshot (settings are replaced, never changed): asked again, nothing is redone. */
const bySettings = new WeakMap<Settings, { retailers: RetailerConfig[]; choices: StoreChoice[] }>();

const sameChoice = (a: StoreChoice, b: StoreChoice) =>
  a.config.id === b.config.id && a.storeId === b.storeId && a.storeKey === b.storeKey && a.config.strategies.join() === b.config.strategies.join();

/**
 * The stores this phone prices lists and price checks at: the ones to compare, but those cloud fetch reads in the
 * cloud while it's on (Walmart and Target: see cloudRetailers). Off, they're all of them, as before.
 */
export function phoneChoices(settings: Settings, retailers: RetailerConfig[]): StoreChoice[] {
  const choices = storeChoices(settings, retailers);
  const cloud = new Set<string>(cloudRetailers(settings.cloud));
  return cloud.size ? choices.filter((c) => !cloud.has(c.config.id)) : choices;
}

/**
 * The stores to compare (see phoneChoices), as the same array for as long as they're chosen the same way from the
 * same rules: screens price a list again when its stores change, and shouldn't every time another setting changes (the
 * store a search saw, noted, say).
 */
export function steadyChoices(settings: Settings, retailers: RetailerConfig[]): StoreChoice[] {
  const cached = bySettings.get(settings);
  if (cached?.retailers === retailers) return cached.choices;
  const next = phoneChoices(settings, retailers);
  const prev = lastChoices.get(retailers);
  const choices = prev && prev.length === next.length && prev.every((c, i) => sameChoice(c, next[i])) ? prev : next;
  lastChoices.set(retailers, choices);
  bySettings.set(settings, { retailers, choices });
  return choices;
}
