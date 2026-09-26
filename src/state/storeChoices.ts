import { krogerApiConfigured } from '../onDevice/krogerApi';
import type { RetailerConfig } from '../onDevice/types';
import type { StoreChoice } from '../pricing/pricingEngine';
import type { Settings } from './appStore';

// Pure functions only, so the tests run them in Node.

/** True when the retailer's official API has credentials, so it can do all of that retailer's searching. */
export type ApiReady = (cfg: RetailerConfig) => boolean;

const krogerReady: ApiReady = (cfg) => cfg.api === 'kroger' && krogerApiConfigured();

/**
 * The stores to compare, from the settings: what each is searched with, and a key that changes when its store does
 * (so saved prices for the old store aren't reused). A retailer with no store within the radius of the ZIP code
 * isn't compared: there's nothing near to price.
 */
export function storeChoices(settings: Settings, retailers: RetailerConfig[], apiReady: ApiReady = krogerReady): StoreChoice[] {
  return settings.retailerIds.flatMap((id) => {
    const found = retailers.find((r) => r.id === id && r.enabled);
    if (!found) return [];
    const setup = settings.storeSetup[id];
    if (settings.zip && setup?.zip === settings.zip && setup.status === 'none') return [];
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
