import type { Product } from '../onDevice/types';
import { parseSize } from '../pricing/sizes';
import type { CloudSettings, Settings } from '../state/appStore';
import type { CloudItem, CloudRetailerId, JobRequest, Via } from './jobs';

// Pure TypeScript: what cloud fetch does with the app's settings. Which retailers go to the cloud, how each is read
// in a job, and which store each is searched at.

/**
 * The retailers read in the cloud while cloud fetch is on: Walmart, and Target unless it stays on this phone in
 * scripted mode (its cloud spike failed, see the README). The phone doesn't search these itself meanwhile.
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
