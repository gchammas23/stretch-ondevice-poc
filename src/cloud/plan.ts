import { sameStoreId } from '../onDevice/storeIdentity';
import type { Product, SearchOutcome } from '../onDevice/types';
import { parseSize } from '../pricing/sizes';
import type { CloudSettings, Settings } from '../state/appStore';
import type { CloudItem, CloudRetailerId, JobRequest, Via } from './jobs';
import type { DeviceResult } from './runner';

// Pure TypeScript: what cloud fetch does with the app's settings. Which retailers go to the cloud, how each is read
// in a job, and which store each is searched at.

/**
 * The retailers read in the cloud while cloud fetch is on: Walmart, and Target unless it stays on this phone in
 * scripted mode (when it fails in the cloud, see the README). The phone doesn't search these itself meanwhile.
 */
export function cloudRetailers(cloud: CloudSettings | undefined): CloudRetailerId[] {
  if (!cloud?.on) return [];
  return cloud.engine === 'scripted' && cloud.targetScripted === 'device' ? ['walmart'] : ['walmart', 'target'];
}

/** How a retailer is read in a job: Kroger always through its official API on the phone, as before. */
export function viaFor(retailerId: CloudRetailerId, cloud: CloudSettings): Via {
  if (retailerId === 'kroger') return 'device';
  if (cloud.engine === 'agent') return 'agent';
  return retailerId === 'target' && cloud.targetScripted === 'device' ? 'device' : 'browser';
}

/**
 * The store a retailer is searched at in a job: the one set in Your stores (the app's own store selection), else the
 * number typed for cloud searches. Kroger's API also takes the ZIP code, for its nearest store, as the app does.
 */
export function cloudStoreId(retailerId: CloudRetailerId, settings: Pick<Settings, 'storeIds' | 'zip' | 'cloud'>, krogerApi: boolean): { id: string; from: 'your stores' | 'typed' | 'zip' | 'none' } {
  const set = settings.storeIds[retailerId];
  if (set) return { id: set, from: 'your stores' };
  const typed = settings.cloud.storeIds[retailerId];
  if (typed) return { id: typed, from: 'typed' };
  if (retailerId === 'kroger' && krogerApi && /^\d{5}$/.test(settings.zip)) return { id: settings.zip, from: 'zip' };
  return { id: '', from: 'none' };
}

/**
 * A job's retailers from the settings: those picked, each with its store and how it's read. Kroger without its API's
 * keys is left out (its website is the on-device path's business); a retailer with no store is reported, not dropped,
 * so the job isn't started without it by surprise.
 */
export function planRetailers(
  picked: CloudRetailerId[],
  settings: Pick<Settings, 'storeIds' | 'zip' | 'cloud'>,
  krogerApi: boolean,
): { retailers: JobRequest['retailers']; skipped: CloudRetailerId[] } {
  const retailers: JobRequest['retailers'] = [];
  const skipped: CloudRetailerId[] = [];
  for (const retailerId of picked) {
    if (retailerId === 'kroger' && !krogerApi) {
      skipped.push(retailerId);
      continue;
    }
    retailers.push({ retailerId, storeId: cloudStoreId(retailerId, settings, krogerApi).id, via: viaFor(retailerId, settings.cloud) });
  }
  return { retailers, skipped };
}

/** A product the app's own search read, as a cloud job keeps it. */
export function fromProduct(p: Product): CloudItem {
  const size = parseSize(p.name)?.text;
  return {
    itemId: p.id,
    name: p.name,
    price: p.price,
    ...(p.wasPrice !== undefined ? { wasPrice: p.wasPrice } : {}),
    ...(p.unitPriceText ? { unitPrice: p.unitPriceText } : {}),
    ...(size ? { size } : {}),
    ...(p.url ? { url: p.url } : {}),
    ...(p.imageUrl ? { imageUrl: p.imageUrl } : {}),
    ...(p.sponsored ? { sponsored: true } : {}),
    ...(p.inStock !== undefined ? { inStock: p.inStock } : {}),
  };
}

/**
 * This phone's search, as a comparison's phone side has it: its first `max` products (one its answer priced for another
 * store than `storeId` marked so), the store the answer itself priced (else the one the request asked for), the store
 * the site's own page asked for by itself, and what it took.
 */
export function deviceResult(outcome: SearchOutcome, storeId: string, max: number): DeviceResult {
  return {
    items: outcome.products.slice(0, max).map((p) => {
      const item = fromProduct(p);
      const at = outcome.itemStores?.[p.id];
      return at && !sameStoreId(at, storeId) ? { ...item, pricedAt: at } : item;
    }),
    found: outcome.products.length,
    ...((outcome.pricedFor ?? outcome.store?.id) ? { storeId: outcome.pricedFor ?? outcome.store?.id } : {}),
    ...(outcome.siteStore ? { siteStoreId: outcome.siteStore } : {}),
    ms: outcome.ms,
    ...(outcome.bytes !== undefined ? { bytes: outcome.bytes } : {}),
    how: outcome.strategy === 'api' ? 'api' : outcome.strategy === 'fetch' ? 'request' : outcome.via === 'replay' ? 'replay' : 'page',
  };
}
