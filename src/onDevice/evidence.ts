import type { RawProduct, Strategy } from './types';

// Pure TypeScript: the price X-ray. For the prices read since the app opened, the exact data the store sent the
// phone, where the price sat in it, and how the phone asked for it. In memory only: never saved, never sent.

/** Where one product's price came from. */
export interface PriceEvidence extends RawProduct {
  retailerId: string;
  productId: string;
  price: number | null;
  at: number;
  strategy: Strategy;
  via?: 'page' | 'replay';
  /** How long the search took, and about how much data it moved. */
  ms: number;
  bytes?: number;
  /** The request that brought the data, its private parts hidden (see redactUrl). */
  request?: { method: string; url: string };
  /** Which of the page's data held the products. */
  source?: string;
}

/** Prices kept: the latest few hundred, across stores. */
const KEPT = 600;

export class EvidenceStore {
  private map = new Map<string, PriceEvidence>();

  record(e: PriceEvidence): void {
    const key = `${e.retailerId}|${e.productId}`;
    this.map.delete(key);
    this.map.set(key, e);
    while (this.map.size > KEPT) this.map.delete(this.map.keys().next().value!);
  }

  get(retailerId: string, productId: string): PriceEvidence | undefined {
    return this.map.get(`${retailerId}|${productId}`);
  }

  clear(): void {
    this.map.clear();
  }
}

/** Every price the app reads in this session goes here. */
export const priceEvidence = new EvidenceStore();

/** Words in a query parameter's name that mean its value could identify the phone or unlock an account. */
const PRIVATE = new Set([
  'key', 'token', 'visitor', 'session', 'auth', 'sig', 'signature', 'secret', 'password', 'pass', 'uid', 'user', 'email', 'device', 'cookie',
  'client', 'account', 'member', 'membership', 'guest', 'profile', 'tracking', 'fingerprint',
]);

/** "api_key", "apiKey" and "x-api-key" are all [api, key]; "keyword" is just [keyword]. */
const isPrivate = (name: string) =>
  name
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .some((word) => PRIVATE.has(word));

/** A request's URL with its private query values replaced by "…". */
export function redactUrl(url: string): string {
  const q = url.indexOf('?');
  if (q === -1) return url;
  const query = url
    .slice(q + 1)
    .split('&')
    .map((pair) => {
      const eq = pair.indexOf('=');
      if (eq === -1) return pair;
      const name = pair.slice(0, eq);
      let decoded = name;
      try {
        decoded = decodeURIComponent(name);
      } catch {
        // Keep it as it is.
      }
      return isPrivate(decoded) ? `${name}=…` : pair;
    })
    .join('&');
  return `${url.slice(0, q)}?${query}`;
}

/**
 * The lines of a product's data to show, around the price: the line where the path's last key holds the price is
 * `highlight` (-1 when it can't be told which line it is).
 */
export function excerpt(e: Pick<PriceEvidence, 'json' | 'pricePath' | 'price'>, max = 48): { lines: string[]; highlight: number; first: number } {
  const all = e.json.split('\n');
  const key = e.pricePath.split('.').pop() ?? '';
  const price = e.price;
  const holdsPrice = (line: string) => {
    if (!key || !line.includes(`"${key}"`)) return false;
    if (price === null) return true;
    const value = /:\s*"?\$?([\d.,]+)/.exec(line)?.[1];
    return value !== undefined && Math.abs(Number(value.replace(/,/g, '')) - price) < 0.005;
  };
  let at = all.findIndex(holdsPrice);
  if (at === -1) at = all.findIndex((line) => !!key && line.includes(`"${key}"`));
  const first = at === -1 || at < max - 8 ? 0 : Math.min(at - Math.floor(max / 3), Math.max(0, all.length - max));
  const lines = all.slice(first, first + max);
  return { lines, highlight: at === -1 ? -1 : at - first, first };
}
