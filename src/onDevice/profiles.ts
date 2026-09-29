import type { ListRead, ParserProfile, ProfileCandidate, ProfileFields, ProfileSource, RetailerConfig } from './types';

// Pure TypeScript: each store's parser profile. The general reader (autoDetect in parsers.ts) guesses on every search
// which list in a store's data holds its results, and which fields are the id, name, price and the rest. Once a store's
// searches agree on where the list is (the same data and the same list in it, lists that fit their searches, none the
// wrong-list rule suspects), or the price truth check agrees with one, that becomes the store's profile: later
// searches read the list there first (readWithProfile), fall back to the general reader when it stops matching, and
// learn again. The app saves the book with AsyncStorage; the tests keep it in memory.

/** Searches that must agree on a list before it's learned. */
export const AGREE = 3;
/** A list this small isn't learned from, however often it comes back: too little to tell a carousel from results. */
const MIN_LEARN = 3;
/** Searches remembered per store, to learn from. */
const KEPT = 6;
/** Searches that agree must be this recent. */
const AGREE_WINDOW_MS = 24 * 60 * 60_000;
/** Good lists remembered per store, for how many products it usually gives. */
const SIZES_KEPT = 12;
/** Misses in a row after which a profile is said to have stopped matching. */
export const STALE_MISSES = 2;

/** One search the general reader read at a store: where its list was, and what the wrong-list rule made of it. */
export interface Observation {
  at: number;
  candidate: ProfileCandidate;
  /** The list's products' names fit the search; undefined when that can't be told. */
  fits?: boolean;
  /** The wrong-list rule's reason, when it suspects the list. */
  suspect?: string;
  /** The ids of its first products, to match with the price truth check's. */
  ids: string[];
}

/** A store's entry: its profile, what its recent searches read, and when the user last reset it. */
interface Entry {
  profile?: ParserProfile;
  seen: Observation[];
  /** Sizes of recent lists that looked like results, newest last: how many products the store usually gives. */
  sizes: number[];
  resetAt?: number;
}

/** Where a list was, as one key: the same data and the same list in it. */
export const listKey = (c: Pick<ProfileCandidate, 'source' | 'list'>): string => JSON.stringify([c.source, c.list]);

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)] ?? 0;
};

/** A search's read as the book learns from it: only the general reader's, with where its list was. */
export function observationOf(read: ListRead | undefined, at: number, productIds: string[]): Observation | null {
  if (!read || read.by !== 'general' || !read.candidate) return null;
  return {
    at,
    candidate: read.candidate,
    ...(read.fits !== undefined ? { fits: read.fits } : {}),
    ...(read.suspect ? { suspect: read.suspect } : {}),
    ids: productIds.slice(0, 12),
  };
}

/** A list the book can learn from: it fits its search, nothing suspects it, and it has a few products. */
const learnable = (o: Observation): boolean => o.fits === true && !o.suspect && o.candidate.count >= MIN_LEARN;

/** Each store's profile, and what its searches taught so far. */
export class ProfileBook {
  private entries: Record<string, Entry> = {};
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

  /** The store's profile, if it has one. */
  get = (retailerId: string): ParserProfile | undefined => this.entries[retailerId]?.profile;

  /** Every store's profile, by retailer. */
  all(): Record<string, ParserProfile> {
    const out: Record<string, ParserProfile> = {};
    for (const [id, e] of Object.entries(this.entries)) if (e.profile) out[id] = e.profile;
    return out;
  }

  /**
   * How many products the store usually gives: its profile's figure, else the most its recent good lists had. "12 or
   * more came before" is what makes a list of 1 to 4 suspect (see judgeList).
   */
  usual(retailerId: string): number | undefined {
    const e = this.entries[retailerId];
    if (e?.profile) return e.profile.usual;
    return e?.sizes.length ? Math.max(...e.sizes) : undefined;
  }

  /**
   * A search the general reader read (not the phone vs. server test's, nor a way of searching asked for on purpose:
   * the caller leaves those out). Returns the profile it taught, when it taught one.
   */
  observe(retailerId: string, o: Observation): ParserProfile | undefined {
    const e = this.entry(retailerId);
    e.seen = [...e.seen, o].slice(-KEPT);
    if (learnable(o)) e.sizes = [...e.sizes, o.candidate.count].slice(-SIZES_KEPT);
    const learned = this.agreement(e);
    if (learned) e.profile = learned;
    this.emit();
    return learned;
  }

  /** The last AGREE searches, when they all read a learnable list at the same place, as a profile. */
  private agreement(e: Entry): ParserProfile | undefined {
    const last = e.seen.slice(-AGREE);
    if (last.length < AGREE || !last.every(learnable)) return undefined;
    const key = listKey(last[0].candidate);
    if (!last.every((o) => listKey(o.candidate) === key && this.now() - o.at < AGREE_WINDOW_MS)) return undefined;
    // The same list the store's profile already has: nothing new to learn.
    if (e.profile && listKey(e.profile) === key && !e.profile.misses) return undefined;
    return this.profileFrom(last, 'searches');
  }

  private profileFrom(from: Observation[], how: ParserProfile['how']): ParserProfile {
    const latest = from[from.length - 1];
    return {
      source: latest.candidate.source,
      list: latest.candidate.list,
      fields: mergeFields(from.map((o) => o.candidate.fields)),
      usual: median(from.map((o) => o.candidate.count)),
      learnedAt: this.now(),
      searches: from.length,
      how,
      matchedAt: latest.at,
    };
  }

  /**
   * The price truth check agreed with prices from this store: the search those products came from, when the general
   * reader read it at a place worth learning, becomes its profile at once. Prices can match on the wrong list (a
   * carousel's products have their own pages too), so the wrong-list rule still has its say.
   */
  confirm(retailerId: string, productIds: string[]): ParserProfile | undefined {
    const e = this.entries[retailerId];
    if (!e || !productIds.length) return undefined;
    const hits = (o: Observation) => productIds.filter((id) => o.ids.includes(id)).length;
    const from = [...e.seen].reverse().find((o) => hits(o) > 0 && hits(o) >= productIds.length / 2);
    if (!from || !learnable(from)) return undefined;
    if (e.profile && listKey(e.profile) === listKey(from.candidate) && !e.profile.misses) return undefined;
    e.profile = this.profileFrom([from], 'truth');
    this.emit();
    return e.profile;
  }

  /** A search the profile read. */
  matched(retailerId: string, at = this.now()): void {
    const p = this.entries[retailerId]?.profile;
    if (!p) return;
    const { misses: _misses, missedAt: _missedAt, ...rest } = p;
    this.entries[retailerId].profile = { ...rest, matchedAt: at };
    this.emit();
  }

  /** A search the profile didn't match: the general reader read it, and the book learns from that as usual. */
  missed(retailerId: string, at = this.now()): void {
    const p = this.entries[retailerId]?.profile;
    if (!p) return;
    this.entries[retailerId].profile = { ...p, misses: (p.misses ?? 0) + 1, missedAt: at };
    this.emit();
  }

  /** Searches so far that agree on a list worth learning, for "learning: 2 of 3 searches agree". */
  progress(retailerId: string): number {
    const seen = this.entries[retailerId]?.seen ?? [];
    let n = 0;
    for (let i = seen.length - 1; i >= 0 && learnable(seen[i]) && listKey(seen[i].candidate) === listKey(seen[seen.length - 1].candidate); i--) n++;
    return n;
  }

  /** The last search the general reader read at the store, for what it found and whether the rule suspected it. */
  lastSeen(retailerId: string): Observation | undefined {
    const seen = this.entries[retailerId]?.seen ?? [];
    return seen[seen.length - 1];
  }

  /**
   * Profiles from a rules file: a store takes one when it has none of its own, or when the file's was learned later
   * than its own, and not before the user last reset the store's (their reset stands until a newer one comes).
   */
  seed(retailers: Pick<RetailerConfig, 'id' | 'profile'>[]): void {
    let changed = false;
    for (const r of retailers) {
      const p = r.profile;
      if (!p || !isProfile(p)) continue;
      const e = this.entry(r.id);
      if (e.resetAt !== undefined && p.learnedAt <= e.resetAt) continue;
      if (e.profile && e.profile.learnedAt >= p.learnedAt) continue;
      e.profile = { ...p, how: 'rules' };
      changed = true;
    }
    if (changed) this.emit();
  }

  /** Forgets the store's profile and what its searches taught: the general reader reads it, and it learns again. */
  reset(retailerId: string): void {
    this.entries[retailerId] = { seen: [], sizes: [], resetAt: this.now() };
    this.emit();
  }

  clear(): void {
    this.entries = {};
    this.emit();
  }

  serialize(): string {
    return JSON.stringify(this.entries);
  }

  hydrate(raw: string | null): void {
    let saved: unknown = null;
    try {
      saved = raw ? JSON.parse(raw) : null;
    } catch {
      saved = null;
    }
    if (!isRecord(saved)) return;
    const entries: Record<string, Entry> = {};
    for (const [id, v] of Object.entries(saved)) {
      if (!isRecord(v)) continue;
      const seen = Array.isArray(v.seen) ? v.seen.filter(isObservation) : [];
      const sizes = Array.isArray(v.sizes) ? v.sizes.filter((n): n is number => typeof n === 'number' && n > 0) : [];
      entries[id] = {
        seen,
        sizes,
        ...(isProfile(v.profile) ? { profile: v.profile } : {}),
        ...(typeof v.resetAt === 'number' ? { resetAt: v.resetAt } : {}),
      };
    }
    this.entries = entries;
    this.emit();
  }

  private entry(retailerId: string): Entry {
    return (this.entries[retailerId] ??= { seen: [], sizes: [] });
  }

  private emit(): void {
    this.changes++;
    this.listeners.forEach((listener) => listener());
  }
}

/** The app's own: every search reads through it. */
export const parserProfiles = new ProfileBook();

/** Fields merged over the searches a profile was learned from: each field's ways, the latest search's first. */
function mergeFields(all: ProfileFields[]): ProfileFields {
  const out: ProfileFields = { name: [], price: [] };
  const keys = ['id', 'name', 'price', 'was', 'member', 'unit', 'link', 'image', 'stock', 'gtin', 'sponsored', 'place', 'department'] as const;
  for (const key of keys) {
    const ways: string[][] = [];
    for (const f of [...all].reverse()) {
      for (const path of f[key] ?? []) if (!ways.some((w) => w.join('\u0000') === path.join('\u0000'))) ways.push(path);
    }
    if (ways.length) out[key] = ways.slice(0, 3);
  }
  const label = [...all].reverse().find((f) => f.memberLabel)?.memberLabel;
  return label ? { ...out, memberLabel: label } : out;
}

// ---------------------------------------------------------------------------
// Checking a profile from a rules file.

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isPath = (v: unknown): v is string[] => Array.isArray(v) && v.length > 0 && v.length <= 30 && v.every((k) => typeof k === 'string');
const isWays = (v: unknown): v is string[][] => Array.isArray(v) && v.length > 0 && v.length <= 5 && v.every(isPath);
const optWays = (v: unknown): boolean => v === undefined || isWays(v);
const isCount = (v: unknown): boolean => typeof v === 'number' && Number.isFinite(v) && v >= 0;

function isSource(v: unknown): v is ProfileSource {
  if (!isRecord(v)) return false;
  if (v.kind === 'page') return typeof v.label === 'string' && !!v.label;
  return v.kind === 'request' && typeof v.host === 'string' && typeof v.path === 'string' && (v.op === undefined || typeof v.op === 'string');
}

function isFields(v: unknown): v is ProfileFields {
  if (!isRecord(v) || !isWays(v.name) || !isWays(v.price)) return false;
  const optional = ['id', 'was', 'member', 'unit', 'link', 'image', 'stock', 'gtin', 'sponsored', 'place', 'department'];
  return optional.every((k) => optWays(v[k])) && (v.memberLabel === undefined || typeof v.memberLabel === 'string');
}

/** A store's profile, as a rules file or a save may carry it: every part there and of the right kind. */
export function isProfile(v: unknown): v is ParserProfile {
  return (
    isRecord(v) &&
    isSource(v.source) &&
    Array.isArray(v.list) &&
    v.list.length <= 30 &&
    v.list.every((k) => typeof k === 'string') &&
    isFields(v.fields) &&
    isCount(v.usual) &&
    isCount(v.learnedAt) &&
    isCount(v.searches) &&
    (v.how === 'searches' || v.how === 'truth' || v.how === 'rules') &&
    (v.matchedAt === undefined || isCount(v.matchedAt)) &&
    (v.misses === undefined || isCount(v.misses)) &&
    (v.missedAt === undefined || isCount(v.missedAt))
  );
}

function isObservation(v: unknown): v is Observation {
  if (!isRecord(v) || typeof v.at !== 'number' || !Array.isArray(v.ids)) return false;
  const c = v.candidate;
  return isRecord(c) && isSource(c.source) && Array.isArray(c.list) && isFields(c.fields) && typeof c.count === 'number';
}

// ---------------------------------------------------------------------------
// In words, for Store health, Diagnostics and the X-ray.

/** Where a profile's list is, in a few words: "www.aldi.us/graphql (Items) › data › items". */
export function whereWords(p: Pick<ParserProfile, 'source' | 'list'>): string {
  const where = p.source.kind === 'request' ? `${p.source.host}${p.source.path}${p.source.op ? ` (${p.source.op})` : ''}` : pageWords(p.source.label);
  const list = p.list.length ? ` › ${p.list.map((k) => (k === '*' ? 'each' : k)).join(' › ')}` : '';
  return `${where}${list}`;
}

function pageWords(label: string): string {
  if (label === 'next-data') return 'the page’s own data';
  if (label === 'ld+json') return 'the page’s structured data';
  if (label.startsWith('json script')) return `the page’s data${label.includes('#') ? ` (${label.slice(label.indexOf('#'))})` : ''}`;
  if (/^__\w+__$/.test(label)) return `the page’s app state (${label})`;
  return label;
}

/** How a search's list was read, in a sentence, for Diagnostics' "Found in" and the X-ray. Empty when there's nothing to say. */
export function readerWords(read: { by: 'profile' | 'general'; missed?: boolean; suspect?: string; preferred?: boolean } | undefined, storeName: string): string {
  if (!read) return '';
  const parts: string[] = [];
  if (read.by === 'profile') parts.push(`Read where ${storeName}’s profile says its results are.`);
  else if (read.missed) parts.push(`${storeName}’s profile didn’t match, so the general reader found these, and the phone is learning where its results are again.`);
  else parts.push('Found by the general reader.');
  if (read.preferred) parts.push('A bigger list didn’t name what was searched, so the largest that did was taken.');
  if (read.suspect) parts.push(`It may not be the results: ${read.suspect}.`);
  return parts.join(' ');
}
