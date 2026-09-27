import { dropWindows, inDrop, type AttemptEntry } from './attemptLog';
import { politeness } from './politeness';
import type { Attempt, RetailerConfig, Strategy } from './types';

// Pure TypeScript: how hard the phone pushes each store, from how its recent searches went. A store whose searches
// keep working gets more at once, however long each takes (a slow store gains the most from not waiting in line); one
// that's failing gets fewer at once; one that pushes back (a bot check, or HTTP 429, "too many requests") gets one
// search at a time, with a pause between them. Slow stores get more time before a request is given up on, fast ones
// less. None of it goes past the politeness limits (politeness.ts): the hourly limit, and one page load at a time per
// store, hold whatever the tuning says; a store near its hourly limit gets one search at a time; and a store searched
// with plain requests, each a whole search page, never gets more than the usual 3 at once.
//
// Cool-downs are part of it, at its Careful level: a store that refuses the phone, openly or not ("Access Denied", HTTP
// 401, 403 or 429, a nearly empty page, no results for searches that worked before), isn't searched again until a
// retry time; nor is one way of searching it (its plain requests, say) when another still works. A way that fails twice
// in a row, or meets a bot check, rests for a while the same way. And when every store fails within seconds of each
// other, that's the phone's connection, not the stores: none of them is cooled down for it (see outcome). Stores on one
// site (a regional chain and its parent's platform) failing together are that site refusing the phone, not the
// connection.

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
  /**
   * The store refused the phone another way (a page that says so, HTTP 401 or 403, a nearly empty page), even if the
   * search then worked another way.
   */
  blocked?: boolean;
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
  /** The store is cooling down: nothing is searched there until its retry time. */
  cooling?: CoolDown;
  /** Ways of searching it that are cooling down or resting, while the others go on. */
  resting?: CoolDown[];
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
export function tuneStore(
  samples: TuningSample[],
  base: TuningBase,
  now: number,
  hour?: { used: number; perHour: number },
  cool: { store?: CoolDown; ways?: CoolDown[] } = {},
): StoreTuning {
  const tuning = tuneFrom(samples, base, now, hour);
  const ways = (cool.ways ?? []).filter((c) => c.until > now);
  const withWays = ways.length ? { ...tuning, resting: ways } : tuning;
  // Cooling down: the Careful level, with nothing searched until the retry time.
  if (cool.store && cool.store.until > now) {
    return { ...withWays, level: 'careful', searches: 1, replays: 1, gapMs: Math.max(tuning.gapMs, CHECK_GAP_MS), why: lowerFirst(coolWords(cool.store)), cooling: cool.store };
  }
  return withWays;
}

function tuneFrom(samples: TuningSample[], base: TuningBase, now: number, hour?: { used: number; perHour: number }): StoreTuning {
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
  if (recent.some((s) => s.blocked)) {
    return tuned('careful', `it refused this phone in the last 15 minutes: one search at a time, ${secs(CHECK_GAP_MS)} apart`, { gapMs: CHECK_GAP_MS });
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
  if (t.cooling) return `${LEVEL_WORDS.careful}: ${coolWords(t.cooling)}.`;
  const pause = t.gapMs ? `, ${secs(t.gapMs)} apart` : '';
  const why = t.why.charAt(0).toUpperCase() + t.why.slice(1);
  const resting = (t.resting ?? []).map((c) => ` ${coolWords(c)}.`).join('');
  return `${LEVEL_WORDS[t.level]}: ${t.searches} ${t.searches === 1 ? 'search' : 'searches'} and ${t.replays} ${t.replays === 1 ? 'request' : 'requests'} at once${pause}, pages ${secs(t.pageTimeoutMs)}, requests ${secs(t.replayTimeoutMs)}. ${why}.${resting}`;
}

const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);

// ---------------------------------------------------------------------------------------------------------------------
// Cool-downs.

/** A way of searching a store: one of its strategies, or requests replayed from its kept page. */
export type Way = Strategy | 'replay';

/**
 * What set a cool-down off. Blocks: 'blocked' (a page that refuses the phone: "Access Denied"), 'refused' (HTTP 401 or
 * 403), 'limited' (HTTP 429, "too many requests"), 'tiny' (a nearly empty page, with no product data), 'empty' (no
 * results for searches that worked before). Rests, as before cool-downs: 'check' (a bot check), 'fails' (two failures
 * in a row).
 */
export type BlockKind = 'blocked' | 'refused' | 'limited' | 'tiny' | 'empty' | 'check' | 'fails';

/** A store, or one way of searching it, left alone until a retry time. */
export interface CoolDown {
  retailerId: string;
  /** The way of searching it's for; none: the whole store. */
  way?: Way;
  kind: BlockKind;
  /** What the store answered, in a few words: "“Access Denied”", "HTTP 403". */
  said?: string;
  from: number;
  until: number;
}

/** A rest ('check', 'fails') never holds back the last way a store is searched with; a cool-down after a block does. */
export const isRest = (c: Pick<CoolDown, 'kind'>): boolean => c.kind === 'check' || c.kind === 'fails';

/** A rest, and a first cool-down; each cool-down that ended within the last two hours doubles the next, up to an hour. */
export const REST_MS = 10 * 60_000;
const COOL_MAX_MS = 60 * 60_000;
const COOL_MEMORY_MS = 2 * 60 * 60_000;
/** Failures in a row that rest a way. */
const FAILS_BEFORE_REST = 2;

/** A failed try as a block, when it was one: what kind, and what the store answered, in a few words. */
export function blockOf(a: Pick<Attempt, 'reason' | 'status' | 'detail'>): { kind: BlockKind; said: string } | undefined {
  const reason = a.reason ?? '';
  if (CHECKS.has(reason)) return { kind: 'check', said: a.detail?.includes('frame') ? 'a captcha' : 'a bot check' };
  if (reason === 'blocked') return { kind: 'blocked', said: /“[^”]+”/.exec(a.detail ?? '')?.[0] ?? 'a page that refused this phone' };
  const code = /(?:^|_)(401|403|429)$/.exec(reason)?.[1] ?? (a.status === 401 || a.status === 403 || a.status === 429 ? String(a.status) : undefined);
  if (code === '429') return { kind: 'limited', said: '“too many requests” (HTTP 429)' };
  if (code) return { kind: 'refused', said: `HTTP ${code}` };
  if (reason === 'tiny_page') return { kind: 'tiny', said: 'a nearly empty page' };
  return undefined;
}

/** "3:40 PM". */
export const clockText = (at: number): string => new Date(at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

const WAY_WORDS: Record<Way, string> = { fetch: 'Plain requests', webview: 'Its page', replay: 'Requests sent from its page', api: 'Its official API' };
const KIND_WORDS: Record<BlockKind, string> = {
  blocked: 'a page that refused this phone',
  refused: 'a refusal',
  limited: '“too many requests”',
  tiny: 'a nearly empty page',
  empty: 'empty results for searches that worked before',
  check: 'a bot check',
  fails: 'two failures in a row',
};

/**
 * A cool-down in words: "Cooling down after “Access Denied”, retrying at 3:40 PM"; one way of searching: "Plain
 * requests cooling down after HTTP 403, retrying at 3:40 PM"; a rest: "Plain requests resting after a bot check, until
 * 3:40 PM".
 */
export function coolWords(c: CoolDown): string {
  const after = c.said ?? KIND_WORDS[c.kind];
  if (isRest(c)) return `${c.way ? WAY_WORDS[c.way] : 'It'} resting after ${after}, until ${clockText(c.until)}`;
  return `${c.way ? `${WAY_WORDS[c.way]} cooling` : 'Cooling'} down after ${after}, retrying at ${clockText(c.until)}`;
}

/** When every store failed within seconds of each other: the phone's connection dropped, not the stores. */
export interface ConnectionDrop {
  /** When the first of the failures was, and the last. */
  from: number;
  to: number;
  /** The stores that failed. */
  stores: string[];
  /** Cool-downs it called off, since they were the connection's doing. */
  lifted: number;
  /** When a search worked again. */
  endedAt?: number;
}

/** Failures this close together, at two sites or more with none working meanwhile, are the connection's. */
export const CONNECTION_WINDOW_MS = 15_000;
/** A drop is news for this long. */
const DROP_NEWS_MS = 60 * 60_000;

/**
 * The last drop the search log noted in the last hour (see 'connection' notes in attemptLog.ts): after the app reopens,
 * the tuner no longer has it.
 */
export function dropFromLog(entries: Pick<AttemptEntry, 'kind' | 'at' | 'ms' | 'stores'>[], now: number): ConnectionDrop | undefined {
  const last = [...entries].reverse().find((e) => e.kind === 'connection');
  if (!last || now - last.at > DROP_NEWS_MS) return undefined;
  // Noted when it was found, `ms` after the first of its failures.
  return { from: last.at - last.ms, to: last.at, stores: last.stores ?? [], lifted: 0 };
}

/** A drop in words, with store names: "The connection dropped at 3:25 PM: Walmart, Target and ALDI all failed within 4 seconds. …". */
export function connectionWords(drop: ConnectionDrop, nameOf: (retailerId: string) => string, device = 'phone'): string {
  const names = drop.stores.map(nameOf);
  const list = names.length <= 2 ? names.join(' and ') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  const within = Math.max(1, Math.round((drop.to - drop.from) / 1000));
  const back = drop.endedAt ? ` Searches worked again at ${clockText(drop.endedAt)}.` : '';
  return (
    `The connection dropped at ${clockText(drop.from)}: ${list} ${names.length === 2 ? 'both' : 'all'} failed within ${within} ${within === 1 ? 'second' : 'seconds'}. ` +
    `That’s this ${device}’s connection (a VPN, or no internet), not the stores, so none of them is cooling down for it.${back}`
  );
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
  /** Cool-downs and rests, by store ("walmart") or way ("walmart:fetch"), and the ones of the last two hours. */
  private cools = new Map<string, CoolDown>();
  private past: CoolDown[] = [];
  /** Failures in a row, by way ("walmart:fetch"). */
  private streaks = new Map<string, number>();
  /** Recent searches' outcomes at every store, and the site each is on, for telling the connection from the stores. */
  private outcomes: { at: number; retailerId: string; site: string; ok: boolean }[] = [];
  private drop: ConnectionDrop | null = null;

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
  seed(entries: Pick<AttemptEntry, 'at' | 'retailerId' | 'kind' | 'ok' | 'reason' | 'ms' | 'via' | 'strategy' | 'until' | 'said'>[]): void {
    const since = this.now() - HEALTH_WINDOW_MS;
    // Cool-downs noted in the log that still run, but for ones a dropped connection called off.
    const drops = dropWindows(entries);
    for (const e of entries) {
      if (e.kind !== 'cooldown' || e.until === undefined || e.until <= this.now()) continue;
      if (inDrop(e.at, drops)) continue;
      const way: Way | undefined = e.via === 'replay' ? 'replay' : e.strategy;
      const kind = (['blocked', 'refused', 'limited', 'tiny', 'empty', 'check', 'fails'] as BlockKind[]).find((k) => k === e.reason) ?? 'blocked';
      this.start({ retailerId: e.retailerId, ...(way ? { way } : {}), kind, ...(e.said ? { said: e.said } : {}), from: e.at, until: e.until });
    }
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
    const cool = { store: this.cooling(retailerId), ways: this.waysCooling(retailerId) };
    // Cool-downs hold whether adapting is on or off: they keep the phone from asking a store that refused it.
    if (!this.enabled) {
      if (cool.store) return tuneStore([], base, this.now(), undefined, cool);
      return { ...fixedTuning(base, 'fixed: adapting to each store is off'), ...(cool.ways.length ? { resting: cool.ways } : {}) };
    }
    return tuneStore(this.samples.get(retailerId) ?? [], base, this.now(), this.hour(retailerId), cool);
  }

  /** The cool-down holding back the store, or (with `way`) that way of searching it, while one runs. */
  cooling(retailerId: string, way?: Way): CoolDown | undefined {
    const c = this.cools.get(way ? `${retailerId}:${way}` : retailerId);
    return c && c.until > this.now() ? c : undefined;
  }

  /** The ways of searching a store that are cooling down or resting now. */
  waysCooling(retailerId: string): CoolDown[] {
    const now = this.now();
    return [...this.cools.values()].filter((c) => c.retailerId === retailerId && c.way && c.until > now);
  }

  /** Every cool-down and rest running now, soonest over first. */
  coolDowns(): CoolDown[] {
    const now = this.now();
    return [...this.cools.values()].filter((c) => c.until > now).sort((a, b) => a.until - b.until);
  }

  /** A way worked at a store: its failures in a row start again from none. */
  worked(retailerId: string, way: Way): void {
    this.streaks.delete(`${retailerId}:${way}`);
  }

  /**
   * A way failed at a store. A block (see blockOf) cools down that way when another way of searching the store is
   * there and free (`ways`: the ways it's searched with), else the whole store; 'empty' is always the whole store. A bot
   * check rests that way at once, and two failures in a row rest it, as before. None of it while the connection is down
   * (see outcome). Returns the cool-down started, to note in the search log.
   */
  failed(retailerId: string, way: Way, opts: { block?: { kind: BlockKind; said?: string }; ways?: Way[] } = {}): CoolDown | undefined {
    const now = this.now();
    if (this.dropActive(now)) return undefined;
    const key = `${retailerId}:${way}`;
    const streak = (this.streaks.get(key) ?? 0) + 1;
    this.streaks.set(key, streak);
    const block = opts.block;
    if (!block) return streak >= FAILS_BEFORE_REST ? this.start({ retailerId, way, kind: 'fails', from: now, until: now + REST_MS }) : undefined;
    if (isRest(block)) return this.start({ retailerId, way, kind: block.kind, said: block.said, from: now, until: now + REST_MS });
    const others = (opts.ways ?? []).filter((w) => w !== way && !this.blocking(retailerId, w));
    const whole = block.kind === 'empty' || (way !== 'replay' && !others.some((w) => w !== 'replay'));
    const scope = whole ? undefined : way;
    // Cool-downs of the same scope that ended (or run) within the last two hours: a store that keeps refusing stays at an hour.
    const before = this.past.filter((c) => c.retailerId === retailerId && c.way === scope && !isRest(c) && now - c.until < COOL_MEMORY_MS).length;
    const until = now + Math.min(COOL_MAX_MS, REST_MS * 2 ** before);
    return this.start({ retailerId, ...(scope ? { way: scope } : {}), kind: block.kind, ...(block.said ? { said: block.said } : {}), from: now, until });
  }

  /** A way held back by a block's cool-down (a rest doesn't count: it gives way to the last way left). */
  private blocking(retailerId: string, way: Way): boolean {
    const c = this.cooling(retailerId, way);
    return !!c && !isRest(c);
  }

  private start(c: CoolDown): CoolDown {
    this.cools.set(c.way ? `${c.retailerId}:${c.way}` : c.retailerId, c);
    this.past = [...this.past.filter((p) => this.now() - p.until < COOL_MEMORY_MS), c];
    return c;
  }

  /**
   * A search at a store ended, one that went out. When stores on two sites or more failed within CONNECTION_WINDOW_MS
   * of each other and none worked meanwhile, it's the phone's connection that dropped, not the stores: cool-downs those
   * failures started are called off, and none starts while it's down. A search that works ends it. Returns the drop
   * when this failure found it, to note in the search log and say. `site`: the site the store is on, when it shares one
   * (a regional chain on its parent's platform: its parent's id); chains failing together on one site are that site.
   */
  outcome(retailerId: string, ok: boolean, site = retailerId): ConnectionDrop | undefined {
    const now = this.now();
    this.outcomes = [...this.outcomes.filter((o) => now - o.at < CONNECTION_WINDOW_MS), { at: now, retailerId, site, ok }];
    if (ok) {
      if (this.drop && !this.drop.endedAt) this.drop = { ...this.drop, endedAt: now };
      return undefined;
    }
    if (this.outcomes.some((o) => o.ok)) return undefined;
    if (new Set(this.outcomes.map((o) => o.site)).size < 2) return undefined;
    const stores = [...new Set(this.outcomes.map((o) => o.retailerId))];
    const from = Math.min(...this.outcomes.map((o) => o.at));
    const fresh = !this.dropActive(now);
    const lifted = this.lift(from);
    this.drop = fresh
      ? { from, to: now, stores, lifted }
      : { ...this.drop!, to: now, stores: [...new Set([...this.drop!.stores, ...stores])], lifted: this.drop!.lifted + lifted };
    return fresh ? this.drop : undefined;
  }

  /** Calls off the cool-downs and rests that started since `from`: the connection's doing. */
  private lift(from: number): number {
    let n = 0;
    for (const [key, c] of this.cools) {
      if (c.from >= from - 1000 && c.until > this.now()) {
        this.cools.delete(key);
        this.past = this.past.filter((p) => p !== c);
        n++;
      }
    }
    for (const key of [...this.streaks.keys()]) this.streaks.delete(key);
    return n;
  }

  private dropActive(now: number): boolean {
    return !!this.drop && !this.drop.endedAt && now - this.drop.to < CONNECTION_WINDOW_MS;
  }

  /** The connection's last drop, while it's news. */
  connection(): ConnectionDrop | undefined {
    return this.drop && this.now() - this.drop.to < DROP_NEWS_MS ? this.drop : undefined;
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
    this.cools.clear();
    this.past = [];
    this.streaks.clear();
    this.outcomes = [];
    this.drop = null;
  }
}

/** The app's own: every search is tuned by it, within the politeness limits. */
export const storeTuner = new StoreTuner(Date.now, (retailerId) => ({ used: politeness.used(retailerId), perHour: politeness.perHour }));
