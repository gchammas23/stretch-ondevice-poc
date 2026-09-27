import type { ReaderNote } from '../onDevice/types';
import { ago } from './age';
import type { PriceChange } from './priceHistory';
import type { SearchResult } from './pricingEngine';

// Pure functions only, so the tests run them in Node.

export interface Receipt {
  /** "Read 3 min ago", "Saved from 2 h ago". */
  when: string;
  /** How the phone got the price, in a sentence. */
  how: string;
  /** The same in a few words: "reused its page". */
  short: string;
  /** How long the search took on the phone. */
  ms?: number;
  /** About how much data it moved. */
  bytes?: number;
  /** Which of the page's data held the products. */
  source?: string;
  /** Which reader found them there: the store's profile, or the general reader. */
  reader?: ReaderNote;
  note?: string;
  /** Searched earlier and reused, not searched just now. */
  saved: boolean;
}

/** "www.target.com" from a URL. */
export const hostOf = (url: string): string => /^https?:\/\/([^/?#:]+)/i.exec(url)?.[1]?.toLowerCase() ?? url;

/** Where in the page the products were, in words: "a response to redsky.target.com/…", "the page’s own data". */
export function sourceWords(source: string | undefined): string | undefined {
  if (!source) return undefined;
  const bare = source.replace(/\s*\(\d+\)$/, '');
  const response = /^(?:response|replay) (?:https?:\/\/)?(\S+)/.exec(bare);
  if (response) return `a response the page got from ${response[1]}`;
  if (bare === 'next-data') return 'the search page’s own data';
  if (bare === 'ld+json') return 'the search page’s structured data';
  if (/^__\w+__$/.test(bare)) return 'the page’s app state';
  if (bare.startsWith('json script')) return 'the page’s own data';
  return bare;
}

/** How one search's prices were read, for the basket and the product page. Null before its first search lands. */
export function receiptFor(result: SearchResult | undefined, storeName: string, host: string, now: number): Receipt | null {
  if (!result?.at || !result.products.length) return null;
  const saved = !!result.cached;
  let how: string;
  let short: string;
  if (result.sharedWith) {
    // No search of its own: another item's search found it (see sharing.ts).
    how = `Found in ${storeName}’s results for “${result.sharedWith}”, another item on this list, so it wasn’t searched on its own.`;
    short = `with “${result.sharedWith}”`;
  } else if (result.strategy === 'api') {
    how = `Asked ${storeName}’s official API from this phone.`;
    short = 'official API';
  } else if (result.strategy === 'fetch') {
    how = `Requested ${host}’s search page from this phone and read the prices in it.`;
    short = 'direct request';
  } else if (result.via === 'replay') {
    how = `Sent ${storeName}’s own search request again from its page, already loaded in a hidden browser on this phone.`;
    short = 'reused its page';
  } else {
    how = `Loaded ${host}’s search page in a hidden browser on this phone and read the prices it received.`;
    short = 'page load';
  }
  return {
    when: saved ? `Saved from ${ago(now - result.at)}` : `Read ${ago(now - result.at)}`,
    how,
    short,
    ms: result.ms,
    bytes: saved || result.sharedWith ? undefined : result.bytes,
    source: result.source,
    ...(result.reader && !saved && !result.sharedWith ? { reader: result.reader } : {}),
    note: result.note,
    saved,
  };
}

/** "yesterday", "Sep 22", or "2 h ago" within a day. */
export function whenLabel(at: number, now: number): string {
  const ms = now - at;
  if (ms < 24 * 60 * 60_000) return ago(ms);
  if (ms < 48 * 60 * 60_000) return 'yesterday';
  return new Date(at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** "↓ $0.30 vs yesterday". */
export function changeText(change: PriceChange, now: number): string {
  return `${change.delta < 0 ? '↓' : '↑'} $${Math.abs(change.delta).toFixed(2)} vs ${whenLabel(change.since, now)}`;
}
