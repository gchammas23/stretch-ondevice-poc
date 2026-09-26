import { customRetailer } from '../onDevice/retailers';
import type { RetailerConfig } from '../onDevice/types';

// Pure functions only, so the tests run them in Node.
//
// "Add a store": the user searches a grocery site in their browser and pastes the results page's link. The link
// becomes a search template, the searched words replaced by {{query}}, and the phone reads the site like any other
// store with the general product reader (parsers.ts, autoDetect). No code per store.

export interface StoreDraft {
  /** The link with what was searched replaced by {{query}}. */
  searchUrl: string;
  homeUrl: string;
  /** What the link searched for, to test the store with. */
  word: string;
  host: string;
  /** A first guess at the store's name, from its web address. */
  name: string;
}

export type DraftResult = { ok: true; draft: StoreDraft } | { ok: false; message: string };

/** Query parameters sites commonly put the search in, lower-case. */
const SEARCH_PARAMS = new Set([
  'q', 'query', 'searchterm', 'search_term', 'keyword', 'keywords', 'k', 'text', 'term', 'search', 's', 'ntt', 'w', 'st',
  'kw', 'search_query', 'searchtext', 'qs',
]);

const decode = (s: string) => {
  try {
    return decodeURIComponent(s.replace(/\+/g, ' '));
  } catch {
    return s;
  }
};

/** "www.hy-vee.com" → "Hy-Vee", "shop.foodlion.com" → "Foodlion". */
export function guessName(host: string): string {
  const label = host.replace(/^(www|shop|m|grocery|groceries|store|online)\./i, '').split('.')[0] ?? host;
  return label
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('-');
}

/**
 * Turns a pasted search-results link into a search template. `word` is what the user searched for; without it,
 * the usual search parameters (q=, query=, searchTerm=...) and /search/… paths are tried.
 */
export function draftFromLink(link: string, word = ''): DraftResult {
  let url = link.trim().replace(/\s+/g, '');
  if (!url) return { ok: false, message: 'Paste the link of a search results page.' };
  if (!/^[a-z]+:\/\//i.test(url)) url = `https://${url}`;
  url = url.replace(/^http:\/\//i, 'https://').replace(/#.*$/, '');
  const origin = /^https:\/\/([a-z0-9.-]+\.[a-z]{2,})(:\d+)?/i.exec(url);
  if (!origin) return { ok: false, message: 'That doesn’t look like a web link. It should start with https://' };
  const host = origin[1].toLowerCase();
  const base = origin[0];
  const rest = url.slice(base.length) || '/';
  const [path, query = ''] = rest.split(/\?(.*)/s, 2);

  let searchUrl: string | null = null;
  let searched = word.trim();

  if (searched) {
    const encoded = encodeURIComponent(searched);
    const spellings = [encoded, encoded.replace(/%20/g, '+'), searched.replace(/ /g, '+'), searched];
    const lower = rest.toLowerCase();
    for (const s of spellings) {
      const at = lower.indexOf(s.toLowerCase());
      if (at !== -1) {
        searchUrl = `${base}${rest.slice(0, at)}{{query}}${rest.slice(at + s.length)}`;
        break;
      }
    }
    if (!searchUrl) return { ok: false, message: `Couldn’t find “${searched}” in that link. Check what you searched for.` };
  } else {
    const pairs = query ? query.split('&') : [];
    const hit = pairs.find((p) => {
      const [k, v] = p.split('=');
      return !!v && SEARCH_PARAMS.has(decode(k).toLowerCase());
    });
    if (hit) {
      const value = hit.split('=')[1];
      searched = decode(value);
      // Other parameters that repeat the search (say, originalQuery=milk) follow it too.
      const params = pairs.map((p) => {
        const [k, v] = p.split('=');
        return v !== undefined && decode(v) === searched ? `${k}={{query}}` : p;
      });
      searchUrl = `${base}${path}?${params.join('&')}`;
    } else {
      const m = /^(.*\/(?:search|s|find|results)\/)([^/]+)(.*)$/i.exec(path);
      if (m) {
        searched = decode(m[2]);
        searchUrl = `${base}${m[1]}{{query}}${m[3]}${query ? `?${query}` : ''}`;
      }
    }
    if (!searchUrl) return { ok: false, message: 'Couldn’t tell which part of the link is the search. Type what you searched for below.' };
  }
  if (!searched) return { ok: false, message: 'That link doesn’t search for anything yet. Search the site first, then copy the link.' };
  return { ok: true, draft: { searchUrl, homeUrl: `${base}/`, word: searched, host, name: guessName(host) } };
}

const slug = (name: string) =>
  name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'store';

/** The store's rules, with an id no other store has. */
export function storeFromDraft(draft: StoreDraft, name: string, takenIds: string[]): RetailerConfig {
  const clean = name.trim() || draft.name;
  let id = `custom-${slug(clean)}`;
  for (let n = 2; takenIds.includes(id); n++) id = `custom-${slug(clean)}-${n}`;
  return customRetailer(id, clean, draft.searchUrl, draft.homeUrl, draft.host);
}
