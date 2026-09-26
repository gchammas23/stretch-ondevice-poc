import type { AttemptEntry } from './attemptLog';
import { politeness } from './politeness';
import type { RetailerConfig } from './types';

// Pure TypeScript: how hard the phone pushes each store, from how its recent searches went. A store whose searches
// keep working gets more at once, however long each takes (a slow store gains the most from not waiting in line); one
// that's failing gets fewer at once; one that pushes back (a bot check, or HTTP 429, "too many requests") gets one
// search at a time, with a pause between them. Slow stores get more time before a request is given up on, fast ones
// less. None of it goes past the politeness limits (politeness.ts): the hourly limit, and one page load at a time per
// store, hold whatever the tuning says; a store near its hourly limit gets one search at a time; and a store searched
// with plain requests, each a whole search page, never gets more than the usual 3 at once.

/** One search at a store, as the tuning sees it. */
export interface TuningSample {
  at: number;
  ok: boolean;
  /** Why it failed: 'timeout', 'challenge', 'http_429'... */
  reason?: string;
  /** How long the whole search took. */
  ms: number;
  /** Its page load, and its request replayed from a kept page, when it had one. */
  loadMs?: number;
  replayMs?: number;
  /** The store answered "too many requests" (HTTP 429), even if the search then worked another way. */
  limited?: boolean;
  /** The store showed a bot check, to its page or a plain request, even if the search then worked another way. */
  checked?: boolean;
  /** Through an official API. */
  api?: boolean;
}

export type TuningLevel = 'wide' | 'normal' | 'narrow' | 'careful';

/** How hard the phone may push one store right now, and why. */
export interface StoreTuning {
  level: TuningLevel;
  /** Searches at once at the store (the pricing engine). */
  searches: number;
  /** Requests at once from its kept page. */
  replays: number;
  /** How long a page load may take. */
  pageTimeoutMs: number;
  /** How long a request replayed from its page may take before a page load is tried instead. */
  replayTimeoutMs: number;
  /** A pause between searches there, after it pushed back. */
  gapMs: number;
  /** Why, in words. */
  why: string;
}

/** How a store is searched, for its tuning: its rules' page timeout, only through an official API, or plain requests first. */
export interface TuningBase {
  pageTimeoutMs: number;
  api?: boolean;
  plain?: boolean;
}

/** A replay that takes longer than this is abandoned for a page load: before tuning, and when it's off. */
export const REPLAY_TIMEOUT_MS = 10_000;
/** At each level: searches at once through a page (and requests at once from it), or through an official API. */
const LEVELS: Record<TuningLevel, { searches: number; replays: number; api: number }> = {
  wide: { searches: 6, replays: 6, api: 8 },
  normal: { searches: 3, replays: 3, api: 6 },
  narrow: { searches: 2, replays: 2, api: 3 },
  careful: { searches: 1, replays: 1, api: 1 },
};

/**
 * What's looked at: a store's last 20 searches from the last day, which say whether it has been healthy lately and
 * how fast it is. Pushback and failures older than 15 minutes are forgiven.
 */
export const TUNING_WINDOW_MS = 15 * 60_000;
export const HEALTH_WINDOW_MS = 24 * 60 * 60_000;
const SAMPLES_KEPT = 20;
/** The latest searches, for failures; and how many that worked it takes to call a store healthy. */
const LATEST = 10;
const MIN_TO_WIDEN = 3;
const SLOW_REPLAY_MS = 2500;
const SLOW_LOAD_MS = 10_000;
/** Page loads are given between these, whatever the tuning; slow stores up to 1.5 × their rules' time. */
const MIN_PAGE_TIMEOUT_MS = 10_000;
const MAX_PAGE_TIMEOUT_MS = 30_000;
const MIN_REPLAY_TIMEOUT_MS = 4000;
const MAX_REPLAY_TIMEOUT_MS = 15_000;
/** A pause after "too many requests", doubling with each one in the window, up to 30 s; and after a bot check. */
const LIMITED_GAP_MS = 5000;
const MAX_GAP_MS = 30_000;
const CHECK_GAP_MS = 3000;
/** From this share of its hourly limit, a store gets one search at a time. */
const NEAR_LIMIT = 0.8;

const CHECKS = new Set(['challenge', 'challenge_timeout', 'challenge_cancelled']);
const isLimited = (s: TuningSample) => !!s.limited || /(^|_)429$/.test(s.reason ?? '');
const defined = (v: number | undefined): v is number => typeof v === 'number' && Number.isFinite(v);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

function quantile(values: number[], q: number): number | undefined {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}
const median = (values: number[]) => quantile(values, 0.5);
const p90 = (values: number[]) => quantile(values, 0.9);

/** How a store is searched, from its rules, for its tuning. */
export const tuningBase = (cfg: RetailerConfig): TuningBase => ({
  pageTimeoutMs: cfg.timeoutMs,
  api: !cfg.strategies.includes('webview'),
  plain: cfg.strategies[0] === 'fetch',
});

/** Searches at once at a level: an API's, or a page's, and never more than the usual for plain requests. */
function searchesAt(level: TuningLevel, base: TuningBase): number {
  if (base.api) return LEVELS[level].api;
  return base.plain ? Math.min(LEVELS[level].searches, LEVELS.normal.searches) : LEVELS[level].searches;
}

/** The fixed values the app had before tuning: what a store gets with tuning off. */
export function fixedTuning(base: TuningBase, why = 'the usual settings'): StoreTuning {
  return {
    level: 'normal',
    searches: searchesAt('normal', base),
    replays: LEVELS.normal.replays,
    pageTimeoutMs: base.pageTimeoutMs,
    replayTimeoutMs: REPLAY_TIMEOUT_MS,
    gapMs: 0,
    why,
  };
}

/**
 * How hard to push a store, from its recent searches (oldest first): how it's searched (see TuningBase), and how much
 * of its hourly limit it has used.
 */
export function tuneStore(samples: TuningSample[], base: TuningBase, now: number, hour?: { used: number; perHour: number }): StoreTuning {
  const known = samples.filter((s) => now - s.at < HEALTH_WINDOW_MS).slice(-SAMPLES_KEPT);
  const recent = known.filter((s) => now - s.at < TUNING_WINDOW_MS);
  const latest = known.slice(-LATEST);
  const tuned = (level: TuningLevel, why: string, over: Partial<StoreTuning> = {}): StoreTuning => ({
    ...fixedTuning(base, why),
    level,
    searches: searchesAt(level, base),
    replays: LEVELS[level].replays,
    ...over,
  });

  // Pushed back: one search at a time, with a pause.
  const limited = recent.filter(isLimited);
  if (limited.length) {
    const gapMs = Math.min(MAX_GAP_MS, LIMITED_GAP_MS * 2 ** (limited.length - 1));
    const times = limited.length === 1 ? 'once' : `${limited.length} times`;
    return tuned('careful', `it answered “too many requests” ${times} in the last 15 minutes: one search at a time, ${secs(gapMs)} apart`, { gapMs });
  }
  if (recent.some((s) => s.checked || CHECKS.has(s.reason ?? ''))) {
    return tuned('careful', `a bot check in the last 15 minutes: one search at a time, ${secs(CHECK_GAP_MS)} apart`, { gapMs: CHECK_GAP_MS });
  }
  if (hour && hour.perHour > 0 && hour.used >= hour.perHour * NEAR_LIMIT) {
    return tuned('careful', `near its hourly limit (${hour.used} of ${hour.perHour} searches in the last hour): one at a time`);
  }

  const loads = known.map((s) => s.loadMs).filter(defined);
  const replays = known.map((s) => s.replayMs).filter(defined);
  const api = known.filter((s) => s.api && s.ok).map((s) => s.ms);
  const worked = known.filter((s) => s.ok).map((s) => s.ms);
  // Failures that say something about the store, lately: the phone's own hourly limit doesn't.
  const lately = latest.filter((s) => now - s.at < TUNING_WINDOW_MS);
  const failed = lately.filter((s) => !s.ok && s.reason !== 'polite_limit');
  const timedOut = lately.some((s) => /timeout/.test(s.reason ?? ''));
  const replayMid = replays.length >= 3 ? median(replays)! : undefined;
  const loadMid = loads.length >= 2 ? median(loads)! : undefined;
  const slow = (replayMid ?? 0) >= SLOW_REPLAY_MS || (loadMid ?? 0) >= SLOW_LOAD_MS;
  const loadLong = p90(loads);
  const replayLong = p90(replays);
  // More time before a request is given up on, for a slow or failing store; less for a quick one.
  const patient = {
    pageTimeoutMs:
      timedOut || (loadLong ?? 0) * 1.5 > base.pageTimeoutMs ? Math.max(base.pageTimeoutMs, Math.min(MAX_PAGE_TIMEOUT_MS, Math.round(base.pageTimeoutMs * 1.5))) : base.pageTimeoutMs,
    replayTimeoutMs: replayLong ? clamp(Math.round(replayLong * 3), REPLAY_TIMEOUT_MS, MAX_REPLAY_TIMEOUT_MS) : REPLAY_TIMEOUT_MS,
  };
  const brisk = {
    pageTimeoutMs: loadLong ? clamp(Math.round(loadLong * 4), MIN_PAGE_TIMEOUT_MS, Math.max(MIN_PAGE_TIMEOUT_MS, base.pageTimeoutMs)) : base.pageTimeoutMs,
    replayTimeoutMs: replayLong ? clamp(Math.round(replayLong * 5), MIN_REPLAY_TIMEOUT_MS, REPLAY_TIMEOUT_MS) : REPLAY_TIMEOUT_MS,
  };

  // Failing: fewer at once, and more time.
  if (failed.length >= 2 || timedOut) {
    const why = failed.length >= 2 ? `${failed.length} of its last ${lately.length} searches failed` : 'a search timed out';
    return tuned('narrow', `${why}: fewer at once, more time`, patient);
  }
  // Healthy: more at once, however long each takes.
  if (worked.length >= MIN_TO_WIDEN && !failed.length) {
    const pace =
      replayMid !== undefined
        ? `its replays take ${secs(replayMid)}`
        : api.length >= 3
          ? `its API answers in ${secs(median(api)!)}`
          : worked.length
            ? `its searches take ${secs(median(worked)!)}`
            : '';
    const plain = base.plain ? '; plain requests stay 3 at once, each a whole search page' : '';
    const ok = latest.filter((s) => s.ok).length;
    const record = ok === latest.length ? `its last ${ok} searches worked` : `${ok} of its last ${latest.length} searches worked, none failing lately`;
    return tuned('wide', `healthy: ${record}${pace ? `, ${pace}` : ''}${slow ? ', so it gets more time' : ''}${plain}`, slow ? patient : brisk);
  }
  const why = worked.length < MIN_TO_WIDEN ? 'not enough searches yet to tell' : `one of its last ${latest.length} searches failed`;
  return tuned('normal', why, slow ? patient : {});
}

const LEVEL_WORDS: Record<TuningLevel, string> = { wide: 'Wider', normal: 'Usual', narrow: 'Narrower', careful: 'Careful' };

/** A store's tuning in words: "Wider: 6 searches and 6 requests at once, pages 10.0 s, requests 4.0 s. Healthy: …". */
export function tuningWords(t: StoreTuning): string {
  const pause = t.gapMs ? `, ${secs(t.gapMs)} apart` : '';
  const why = t.why.charAt(0).toUpperCase() + t.why.slice(1);
  return `${LEVEL_WORDS[t.level]}: ${t.searches} ${t.searches === 1 ? 'search' : 'searches'} and ${t.replays} ${t.replays === 1 ? 'request' : 'requests'} at once${pause}, pages ${secs(t.pageTimeoutMs)}, requests ${secs(t.replayTimeoutMs)}. ${why}.`;
}

/** A page's content process dying means the phone ran short of memory: each one in the window takes a store off. */
export function storesAtOnce(crashes: number, max: number): number {
  return Math.max(Math.min(2, max), max - crashes);
}

/** Every store's recent searches, and the pauses between them. The app has one (storeTuner). */
export class StoreTuner {
  /** Off: every store gets the fixed values the app always had, for comparing. */
  enabled = true;
  private samples = new Map<string, TuningSample[]>();
  private crashes: number[] = [];
  private nextStart = new Map<string, number>();

  constructor(
    private now: () => number = Date.now,
    private hour: (retailerId: string) => { used: number; perHour: number } | undefined = () => undefined,
  ) {}

  record(retailerId: string, sample: TuningSample): void {
    const since = this.now() - HEALTH_WINDOW_MS;
    this.samples.set(retailerId, [...(this.samples.get(retailerId) ?? []), sample].filter((s) => s.at >= since).slice(-SAMPLES_KEPT));
  }

  /** A page's content process died (see WebViewQueue.pageLost). */
  crashed(): void {
    this.crashes = [...this.crashes.filter((at) => at >= this.now() - TUNING_WINDOW_MS), this.now()];
  }

  /** Searches from the saved log count too: a store that pushed back before the app closed is still handled gently, and one that has worked today starts with more at once. */
  seed(entries: Pick<AttemptEntry, 'at' | 'retailerId' | 'kind' | 'ok' | 'reason' | 'ms' | 'via' | 'strategy'>[]): void {
    const since = this.now() - HEALTH_WINDOW_MS;
    for (const e of entries) {
      if (e.at < since || (e.kind !== 'search' && e.kind !== 'coverage')) continue;
      this.record(e.retailerId, {
        at: e.at,
        ok: e.ok,
        reason: e.reason,
        ms: e.ms,
        ...(e.ok && e.via === 'replay' ? { replayMs: e.ms } : {}),
        ...(e.ok && e.via === 'page' ? { loadMs: e.ms } : {}),
        ...(e.strategy === 'api' ? { api: true } : {}),
      });
    }
  }

  get(retailerId: string, base: TuningBase): StoreTuning {
    if (!this.enabled) return fixedTuning(base, 'fixed: adapting to each store is off');
    return tuneStore(this.samples.get(retailerId) ?? [], base, this.now(), this.hour(retailerId));
  }

  /** Stores searched at once, at most `max`: fewer after pages crashed in the last 15 minutes. */
  storesAtOnce(max: number): number {
    if (!this.enabled) return max;
    return storesAtOnce(this.crashes.filter((at) => at >= this.now() - TUNING_WINDOW_MS).length, max);
  }

  /** How long a search starting now at the store must wait for its pause (`gapMs` since the last one): it keeps that turn. */
  delay(retailerId: string, gapMs: number): number {
    const now = this.now();
    if (gapMs <= 0) return 0;
    const at = Math.max(now, this.nextStart.get(retailerId) ?? 0);
    this.nextStart.set(retailerId, at + gapMs);
    return at - now;
  }

  reset(): void {
    this.samples.clear();
    this.crashes = [];
    this.nextStart.clear();
  }
}

/** The app's own: every search is tuned by it, within the politeness limits. */
export const storeTuner = new StoreTuner(Date.now, (retailerId) => ({ used: politeness.used(retailerId), perHour: politeness.perHour }));
