import type { Strategy } from './types';

// Pure TypeScript: the app saves it with AsyncStorage, the tests keep it in memory.

/**
 * What an attempt was for. 'fees': the store's own page about its online order fees. 'ad': its weekly ad. 'coupons':
 * the account's coupons page. 'clip': a coupon clipped there, as the user asked. 'versus': the phone vs. server test,
 * a search of the store's page in the phone's browser and a plain request for it.
 *
 * Two kinds are notes, not tries: 'cooldown', a store (or one way of searching it) left alone until `until` after a
 * block, and why (see tuning.ts); 'connection', every store failing within seconds of each other, from `at` to
 * `until`: the phone's connection, not the stores (its retailerId is CONNECTION_ID).
 */
export type AttemptKind = 'search' | 'coverage' | 'product' | 'recipe' | 'store' | 'fees' | 'ad' | 'coupons' | 'clip' | 'versus' | 'cooldown' | 'connection';

/** The retailerId of a 'connection' note: it's about every store. */
export const CONNECTION_ID = 'connection';

/**
 * When the connection was down, from the log's 'connection' notes. A note is written when the drop is found (its `at`),
 * `ms` after the first of its failures, and says it lasts until `until`. Cool-downs noted from its first failure (with a
 * second's slack) to then were called off (see StoreTuner.outcome in tuning.ts): they don't count, and don't come back.
 */
export function dropWindows(entries: Pick<AttemptEntry, 'kind' | 'at' | 'ms' | 'until'>[]): { from: number; to: number }[] {
  return entries.filter((e) => e.kind === 'connection' && e.until !== undefined).map((d) => ({ from: d.at - d.ms - 1000, to: d.until! }));
}

/** Whether a moment was while the connection was down (see dropWindows). */
export const inDrop = (at: number, drops: { from: number; to: number }[]): boolean => drops.some((d) => at >= d.from && at <= d.to);

/** Notes in the log that aren't tries at reading a store: nothing counts them as searches or pages. */
export const NOTES = new Set<AttemptKind>(['cooldown', 'connection']);

/**
 * Attempts Store health's rates leave out: those that aren't about reading prices from searches, and the phone vs.
 * server test's, which asks stores in ways the app doesn't read them (a plain request where it loads the page).
 */
const NOT_PRICES = new Set<AttemptKind>(['store', 'fees', 'ad', 'coupons', 'clip', 'versus', ...NOTES]);

/** Whether Store health's rates count an attempt: a try at reading prices from a search. */
export const countsInHealth = (e: Pick<AttemptEntry, 'kind'>): boolean => !NOT_PRICES.has(e.kind);

/** One try at reading a store, kept on the phone for Store health. */
export interface AttemptEntry {
  at: number;
  retailerId: string;
  kind: AttemptKind;
  strategy?: Strategy;
  ok: boolean;
  /** Why it failed: "challenge", "no_payload", "timeout"... */
  reason?: string;
  ms: number;
  via?: 'page' | 'replay';
  /** About how much data it moved. */
  bytes?: number;
  /** About how much less data it moved by asking for only the results the app keeps (see pageSize.ts). */
  bytesSaved?: number;
  /** Version of the store rules in use. */
  rules?: string;
  /** A 'cooldown' note: when its store (or its way of searching, in `strategy`, or `via` 'replay') may be tried again. A 'connection' note: when the failures ended. */
  until?: number;
  /** A 'cooldown' note: what the store answered, in a few words ("“Access Denied”", "HTTP 403"). */
  said?: string;
  /** A 'connection' note: the stores that failed within seconds of each other. */
  stores?: string[];
}

const KEPT = 4000;
const KEEP_MS = 14 * 24 * 60 * 60_000;

export class AttemptLog {
  private list: AttemptEntry[] = [];
  private listeners = new Set<() => void>();
  private changes = 0;

  constructor(private now: () => number = Date.now) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  get version(): number {
    return this.changes;
  }

  entries = (): AttemptEntry[] => this.list;

  add(entry: AttemptEntry): void {
    const cutoff = this.now() - KEEP_MS;
    this.list = [...this.list.filter((e) => e.at >= cutoff), entry].slice(-KEPT);
    this.emit();
  }

  clear(): void {
    this.list = [];
    this.emit();
  }

  serialize(): string {
    return JSON.stringify(this.list);
  }

  hydrate(json: string | null): void {
    if (!json) return;
    try {
      const rows = JSON.parse(json) as AttemptEntry[];
      if (!Array.isArray(rows)) return;
      const cutoff = this.now() - KEEP_MS;
      this.list = rows.filter((e) => e && typeof e.at === 'number' && typeof e.retailerId === 'string' && e.at >= cutoff).slice(-KEPT);
      this.changes += 1;
    } catch {
      // A corrupt save just means starting the log again.
    }
  }

  private emit(): void {
    this.changes += 1;
    this.listeners.forEach((listener) => listener());
  }
}

export interface DayHealth {
  /** Days ago: 0 is today. */
  daysAgo: number;
  ok: number;
  total: number;
}

export interface StoreHealth {
  retailerId: string;
  attempts: number;
  /** Times it was cooled down after a block (itself, or a way of searching it), in the days looked at. */
  coolDowns: number;
  ok: number;
  /** Share that worked, 0 to 1; undefined with no attempts. */
  rate?: number;
  medianMs?: number;
  botChecks: number;
  /** Data the attempts used, about. */
  bytes: number;
  /** Data they didn't use by asking for only the results the app keeps, about. */
  bytesSaved: number;
  lastOk?: number;
  lastFailure?: { reason: string; at: number };
  /** Oldest first. */
  days: DayHealth[];
  /** Attempts since the rules last changed, when they did. */
  sinceRules?: { version: string; ok: number; total: number };
}

const DAY = 24 * 60 * 60_000;

function median(values: number[]): number | undefined {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * How reading one store has gone over the last `days` days. Store setting, fees pages, weekly ads and coupons aren't
 * counted: they aren't prices from its searches. Nor is the phone vs. server test.
 */
export function storeHealth(entries: AttemptEntry[], retailerId: string, now: number, days = 7): StoreHealth {
  const since = now - days * DAY;
  const mine = entries.filter((e) => e.retailerId === retailerId && e.at >= since && !NOT_PRICES.has(e.kind));
  // Cool-downs after blocks, not rests, and not ones a dropped connection called off.
  const drops = dropWindows(entries);
  const coolDowns = entries.filter(
    (e) => e.retailerId === retailerId && e.at >= since && e.kind === 'cooldown' && e.reason !== 'check' && e.reason !== 'fails' && !inDrop(e.at, drops),
  ).length;
  const ok = mine.filter((e) => e.ok);
  const failures = mine.filter((e) => !e.ok);
  const last = failures[failures.length - 1];
  const byDay: DayHealth[] = Array.from({ length: days }, (_, i) => ({ daysAgo: days - 1 - i, ok: 0, total: 0 }));
  for (const e of mine) {
    const ago = Math.floor((now - e.at) / DAY);
    const slot = byDay[days - 1 - ago];
    if (!slot) continue;
    slot.total += 1;
    if (e.ok) slot.ok += 1;
  }
  const rules = mine[mine.length - 1]?.rules;
  const firstWithRules = rules ? mine.findIndex((e) => e.rules === rules) : -1;
  const changed = firstWithRules > 0;
  const sinceRules = changed ? mine.slice(firstWithRules) : [];
  return {
    retailerId,
    attempts: mine.length,
    coolDowns,
    ok: ok.length,
    rate: mine.length ? ok.length / mine.length : undefined,
    medianMs: median(ok.map((e) => e.ms)),
    botChecks: failures.filter((e) => e.reason === 'challenge' || e.reason === 'challenge_timeout' || e.reason === 'challenge_cancelled').length,
    bytes: mine.reduce((n, e) => n + (e.bytes ?? 0), 0),
    bytesSaved: mine.reduce((n, e) => n + (e.bytesSaved ?? 0), 0),
    lastOk: ok[ok.length - 1]?.at,
    lastFailure: last ? { reason: last.reason ?? 'failed', at: last.at } : undefined,
    days: byDay,
    sinceRules: changed && rules ? { version: rules, ok: sinceRules.filter((e) => e.ok).length, total: sinceRules.length } : undefined,
  };
}

/** Data used in the last day across every store, about. */
export function bytesToday(entries: AttemptEntry[], now: number): number {
  return entries.filter((e) => e.at >= now - DAY).reduce((n, e) => n + (e.bytes ?? 0), 0);
}

/** Data not used in the last day by asking stores for only the results the app keeps, about (see pageSize.ts). */
export function bytesSavedToday(entries: AttemptEntry[], now: number): number {
  return entries.filter((e) => e.at >= now - DAY).reduce((n, e) => n + (e.bytesSaved ?? 0), 0);
}
