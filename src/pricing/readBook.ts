import { isObj } from '../onDevice/json';

// Pure TypeScript: the app saves it with AsyncStorage, the tests keep it in memory.

/** A page of a store's, as the phone last read it: its weekly ad, or the account's coupons. */
export interface PageRead<T> {
  /**
   * What was read: the page, and whose it is (the store an ad is for; the sign-in coupons were read under). A read
   * under another key is someone else's, and doesn't count as this one's.
   */
  key: string;
  url: string;
  /** The last try. */
  at: number;
  /** It loaded and gave something. */
  ok: boolean;
  /** Why not: 'challenge', 'timeout', 'signed_out', 'polite_limit'... */
  reason?: string;
  ms?: number;
  bytes?: number;
  /** What the last read that worked found, and when: kept through a failed try of the same key until one works. */
  value?: T;
  valueAt?: number;
}

/**
 * One round of page reads at a time (stores' ads, coupons or fees, one page after another), and a count of clears that
 * a round running then checks, to stop and record nothing more (Erase everything).
 */
export class Rounds {
  private going = false;
  private waiters: (() => void)[] = [];
  private cleared = 0;

  /** Starts a round; false when one is already going. */
  begin(): boolean {
    if (this.going) return false;
    this.going = true;
    return true;
  }

  end(): void {
    this.going = false;
    this.waiters.splice(0).forEach((resolve) => resolve());
  }

  /** Resolves once no round is going (at once when none is): a read the user asked for waits for it. */
  over(): Promise<void> {
    return this.going ? new Promise((resolve) => this.waiters.push(resolve)) : Promise.resolve();
  }

  get epoch(): number {
    return this.cleared;
  }

  clear(): void {
    this.cleared++;
  }
}

/**
 * Each store's last read of one kind of page, by retailer, with what the last read that worked found. `valid` checks a
 * saved value, so a save from an older version of the app can't break it.
 */
export class ReadBook<T> {
  private reads: Record<string, PageRead<T>> = {};
  private listeners = new Set<() => void>();
  private changes = 0;
  private rounds = new Rounds();
  private marks = new Set<string>();
  /** The store whose page is being read right now, if any. Not saved. */
  reading: string | null = null;

  constructor(private valid: (v: unknown) => v is T) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  get version(): number {
    return this.changes;
  }

  get = (retailerId: string): PageRead<T> | undefined => this.reads[retailerId];

  /** Every store's last read, by retailer: a new object whenever one changes, so screens can depend on it. */
  all = (): Record<string, PageRead<T>> => this.reads;

  /** What the store's page gave, when it's a read of this key. */
  current(retailerId: string, key: string): T | undefined {
    const r = this.reads[retailerId];
    return r?.key === key ? r.value : undefined;
  }

  setReading(retailerId: string | null): void {
    if (retailerId === this.reading) return;
    this.reading = retailerId;
    this.emit();
  }

  /** Something underway that isn't a read (a coupon being clipped: "kroger|c1"), by key. Not saved. */
  mark(key: string, on: boolean): void {
    if (on === this.marks.has(key)) return;
    if (on) this.marks.add(key);
    else this.marks.delete(key);
    this.emit();
  }

  marked = (key: string): boolean => this.marks.has(key);

  /** Starts a round of reads, one page at a time; false when a round is already going. */
  beginRound(): boolean {
    return this.rounds.begin();
  }

  endRound(): void {
    this.rounds.end();
    this.setReading(null);
  }

  /** Resolves once no round of reads is going (at once when none is): a read the user asked for waits for it. */
  roundOver(): Promise<void> {
    return this.rounds.over();
  }

  /** Counts clears (Erase everything): a round started before one stops there, and records nothing more. */
  get epoch(): number {
    return this.rounds.epoch;
  }

  /** A read just tried. One that didn't work keeps what the last good read of the same key found. */
  record(retailerId: string, read: Omit<PageRead<T>, 'valueAt'>): void {
    const had = this.reads[retailerId];
    const next: PageRead<T> = { ...read };
    if (read.ok && read.value !== undefined) next.valueAt = read.at;
    else {
      delete next.value;
      if (had?.key === read.key && had.value !== undefined) {
        next.value = had.value;
        next.valueAt = had.valueAt;
      }
    }
    this.reads = { ...this.reads, [retailerId]: next };
    this.emit();
  }

  /** Changes what a store's last good read found (a coupon clipped in the app), without a new read. */
  update(retailerId: string, change: (value: T) => T): void {
    const had = this.reads[retailerId];
    if (had?.value === undefined) return;
    this.reads = { ...this.reads, [retailerId]: { ...had, value: change(had.value) } };
    this.emit();
  }

  clear(): void {
    this.rounds.clear();
    this.reads = {};
    this.emit();
  }

  serialize(): string {
    return JSON.stringify(this.reads);
  }

  hydrate(raw: string | null): void {
    let saved: unknown = null;
    try {
      saved = raw ? JSON.parse(raw) : null;
    } catch {
      saved = null;
    }
    if (!isObj(saved)) return;
    const reads: Record<string, PageRead<T>> = {};
    for (const [id, r] of Object.entries(saved)) {
      if (!isObj(r) || typeof r.key !== 'string' || typeof r.url !== 'string' || typeof r.at !== 'number' || typeof r.ok !== 'boolean') continue;
      const read = { ...(r as unknown as PageRead<T>) };
      if (!this.valid(read.value) || typeof read.valueAt !== 'number') {
        delete read.value;
        delete read.valueAt;
      }
      reads[id] = read;
    }
    this.reads = reads;
    this.emit();
  }

  private emit(): void {
    this.changes++;
    this.listeners.forEach((listener) => listener());
  }
}
