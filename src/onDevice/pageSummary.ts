import type { PagePayload } from './types';

// Pure functions only, so the tests run them in Node.

const kb = (chars: number) => (chars < 1024 ? `${chars} B` : `${Math.round(chars / 1024)} KB`);

/** "https://www.kroger.com/atlas/v1/products?x=1" → "www.kroger.com/atlas/v1/products": no query string (it can hold keys). */
function shortUrl(label: string): string {
  return label
    .replace(/^(response|replay) /, '')
    .replace(/[?#].*$/, '')
    .replace(/^https?:\/\//, '')
    .slice(0, 90);
}

/**
 * Why a page load found no products, in words: what the page was, and what data it fetched. For the Diagnostics
 * screen; never sent anywhere (a page title can include the search).
 */
export function describePage(payload: PagePayload & { title?: string }, retailerName: string): string {
  const page = payload.title?.trim() ? `“${payload.title.trim().slice(0, 60)}”` : 'its page';
  const responses = (payload.sources ?? []).filter((s) => s.label.startsWith('response '));
  if (!responses.length && !payload.nextDataText) {
    return `${retailerName} showed ${page}, but no product data arrived. Its product requests may have been blocked, or it may need a store chosen first.`;
  }
  const biggest = [...responses].sort((a, b) => b.text.length - a.text.length)[0];
  const largest = biggest ? ` Largest: ${shortUrl(biggest.label)} (${kb(biggest.text.length)}).` : '';
  const count = responses.length === 1 ? '1 data response' : `${responses.length} data responses`;
  return `${retailerName} showed ${page} and loaded ${count}, but none listed products with prices.${largest}`;
}
