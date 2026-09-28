import { howWords } from './retailerSearch';
import { reasonWords } from './scrapeFeed';
import type { Attempt, RetailerConfig, SearchOutcome } from './types';

// Pure TypeScript: which stores this phone can read right now, one search each.

/**
 * What a store's search in the check came to. 'few': 1 or 2 products, more likely a featured product than the results.
 * 'no_store': none of its stores is near the ZIP code (Kroger's API says so for its chains), so it wasn't searched:
 * counted apart, not as a failure.
 */
export type CoverageStatus = 'works' | 'few' | 'bot_check' | 'no_products' | 'slow' | 'failed' | 'no_store' | 'cooling';

/** A search for milk gives dozens of products: this many or fewer isn't taken as the results. */
export const FEW_PRODUCTS = 2;

export interface CoverageRow {
  retailerId: string;
  name: string;
  status: CoverageStatus;
  /** Products with prices it returned. */
  products: number;
  ms: number;
  /** "page load", "reused its page", "official API"... */
  how?: string;
  bytes?: number;
  reason?: string;
  /** What the page showed, when it failed. */
  detail?: string;
  at: number;
}

export interface CoverageState {
  query: string;
  running: boolean;
  startedAt?: number;
  finishedAt?: number;
  /** Every store in the check, in order. */
  stores: { retailerId: string; name: string }[];
  rows: Record<string, CoverageRow>;
  /** Stores being searched right now. */
  checking: string[];
}

export type CoverageSearch = (cfg: RetailerConfig, query: string, storeId: string) => Promise<SearchOutcome>;

/** What a failure reason means for coverage. */
export function coverageStatus(reason: string | undefined): CoverageStatus {
  if (!reason) return 'failed';
  if (reason === 'cooling_down') return 'cooling';
  if (/(?:^|_)no_store_near/.test(reason)) return 'no_store';
  if (reason.startsWith('challenge') || reason === 'blocked' || reason === 'tiny_page' || /^http_(401|403|429|503)$/.test(reason)) return 'bot_check';
  if (reason === 'no_payload' || reason === 'no_products_on_page' || reason === 'empty') return 'no_products';
  if (reason === 'timeout') return 'slow';
  return 'failed';
}

export const COVERAGE_WORDS: Record<CoverageStatus, string> = {
  works: 'Works',
  few: 'Too few products',
  bot_check: 'Bot check or blocked',
  no_products: 'No products came back',
  slow: 'Too slow',
  failed: 'Failed',
  no_store: 'No store near you',
  cooling: 'Cooling down',
};

/**
 * How a check went: the stores that work, of those it searched. A store with none near the ZIP code wasn't searched,
 * so it's counted apart.
 */
export function coverageCounts(rows: CoverageRow[]): { works: number; searched: number; noStore: number } {
  const noStore = rows.filter((r) => r.status === 'no_store').length;
  return { works: rows.filter((r) => r.status === 'works').length, searched: rows.length - noStore, noStore };
}

/** What Store health says under a store that didn't work: what its page showed, or why, in words. */
export function coverageDetail(r: CoverageRow): string {
  if (r.detail) return r.detail;
  if (r.reason === 'empty') return 'its search gave no products with prices';
  return reasonWords(r.reason);
}

const EMPTY: CoverageState = { query: 'milk', running: false, stores: [], rows: {}, checking: [] };

/** Runs one search at every store, a few at a time, and keeps the last finished run. */
export class CoverageCheck {
  private state: CoverageState = EMPTY;
  private listeners = new Set<() => void>();

  constructor(private now: () => number = Date.now) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): CoverageState => this.state;

  /** The latest result for a store, if it has been checked. */
  rowFor(retailerId: string): CoverageRow | undefined {
    return this.state.rows[retailerId];
  }

  async run(stores: { config: RetailerConfig; storeId: string }[], search: CoverageSearch, query = 'milk', atOnce = 4): Promise<void> {
    if (this.state.running || !stores.length) return;
    this.set({
      query,
      running: true,
      startedAt: this.now(),
      stores: stores.map((s) => ({ retailerId: s.config.id, name: s.config.name })),
      rows: this.state.rows,
      checking: [],
    });
    let next = 0;
    const worker = async () => {
      for (let i = next++; i < stores.length; i = next++) {
        const { config, storeId } = stores[i];
        this.set({ ...this.state, checking: [...this.state.checking, config.id] });
        const row = await this.check(config, storeId, query, search);
        const rows = { ...this.state.rows, [config.id]: row };
        this.set({ ...this.state, rows, checking: this.state.checking.filter((id) => id !== config.id) });
      }
    };
    await Promise.all(Array.from({ length: Math.min(atOnce, stores.length) }, worker));
    this.set({ ...this.state, running: false, finishedAt: this.now() });
  }

  private async check(config: RetailerConfig, storeId: string, query: string, search: CoverageSearch): Promise<CoverageRow> {
    const base = { retailerId: config.id, name: config.name };
    const t0 = this.now();
    try {
      const out = await search(config, query, storeId);
      const priced = out.products.filter((p) => typeof p.price === 'number').length;
      return {
        ...base,
        status: !priced ? 'no_products' : priced <= FEW_PRODUCTS ? 'few' : 'works',
        products: priced,
        ms: out.ms,
        how: howWords(out.strategy, out.via),
        bytes: out.bytes,
        reason: priced ? undefined : 'empty',
        at: this.now(),
      };
    } catch (e) {
      const attempts = ((e as { attempts?: Attempt[] }).attempts ?? []).filter((a) => a.reason && a.reason !== 'resting');
      const last = attempts[attempts.length - 1];
      const reason = last?.reason ?? (e instanceof Error ? e.message : 'failed');
      return { ...base, status: coverageStatus(reason), products: 0, ms: this.now() - t0, reason, detail: last?.detail, at: this.now() };
    }
  }

  clear(): void {
    if (!this.state.running) this.set(EMPTY);
  }

  serialize(): string {
    return JSON.stringify({ ...this.state, running: false, checking: [] });
  }

  hydrate(json: string | null): void {
    if (!json) return;
    try {
      const s = JSON.parse(json) as CoverageState;
      if (s && typeof s === 'object' && Array.isArray(s.stores) && s.rows && typeof s.rows === 'object') {
        this.state = { ...EMPTY, ...s, running: false, checking: [] };
      }
    } catch {
      // Start with no results.
    }
  }

  private set(next: CoverageState): void {
    this.state = next;
    this.listeners.forEach((listener) => listener());
  }
}

const sec = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

/** "58 products in 3.2 s (page load)". */
const gotText = (r: CoverageRow) => `${r.products} ${r.products === 1 ? 'product' : 'products'} in ${sec(r.ms)}${r.how ? ` (${r.how})` : ''}`;

/** A store's result in a line of text: its verdict, its reason's code, and what Store health says under it. */
export function coverageLine(r: CoverageRow): string {
  if (r.status === 'works') return `✓ ${r.name}: ${gotText(r)}`;
  if (r.status === 'few') return `? ${r.name}: ${COVERAGE_WORDS.few}: ${gotText(r)}, which may not be the search’s results`;
  const mark = r.status === 'no_store' || r.status === 'cooling' ? '–' : '✗';
  const code = r.reason && r.reason !== 'empty' ? ` (${r.reason})` : '';
  return `${mark} ${r.name}: ${COVERAGE_WORDS[r.status]}${code}: ${coverageDetail(r)}`;
}

/** A plain-text report, for sharing: a line per store, with what Store health says under it. */
export function coverageText(state: CoverageState, heading: string): string {
  const rows = state.stores.map((s) => state.rows[s.retailerId]).filter((r): r is CoverageRow => !!r);
  const { works, searched, noStore } = coverageCounts(rows);
  const apart = noStore ? `; ${noStore} with no store near the ZIP code, not searched` : '';
  const lines = [heading, `${works} of ${searched} stores readable, searching “${state.query}”${apart}`, ''];
  for (const r of rows) lines.push(coverageLine(r));
  return lines.join('\n');
}
