import type { FeePageRead } from '../onDevice/feePage';
import { isObj } from '../onDevice/json';
import { Rounds } from './readBook';

// Pure TypeScript: the app saves it with AsyncStorage, the tests keep it in memory.

/** A store's fees page, as the phone last read it. */
export interface FeeRead {
  url: string;
  /** The last try. */
  at: number;
  /** It loaded and said something about fees. */
  ok: boolean;
  /** Why not: 'challenge', 'timeout', 'no_fees' (it loaded, without a figure in it)... */
  reason?: string;
  ms?: number;
  bytes?: number;
  /** What the last read that worked found, and when: kept through a failed try until the next one works. */
  fees?: FeePageRead;
  feesAt?: number;
}

/** A read stands for a week; a failed one is tried again after six hours, or when the user asks. */
export const FEES_KEEP_MS = 7 * 24 * 60 * 60_000;
export const FEES_RETRY_MS = 6 * 60 * 60_000;

/** What a read found, when it's a read of `url`. */
export const figuresOf = (read: FeeRead | undefined, url: string | undefined): FeePageRead | undefined =>
  url && read?.url === url ? read.fees : undefined;

/** Each store's fees page as last read, by retailer. */
export class FeeBook {
  private reads: Record<string, FeeRead> = {};
  private listeners = new Set<() => void>();
  private changes = 0;
  /** The store whose page is being read right now, if any. Not saved. */
  reading: string | null = null;
  private rounds = new Rounds();

  constructor(private now: () => number = Date.now) {}

  setReading(retailerId: string | null): void {
    if (retailerId === this.reading) return;
    this.reading = retailerId;
    this.emit();
  }

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

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  get version(): number {
    return this.changes;
  }

  get = (retailerId: string): FeeRead | undefined => this.reads[retailerId];

  /** Every store's last read, by retailer: a new object whenever one changes, so screens can depend on it. */
  all = (): Record<string, FeeRead> => this.reads;

  /** The figures the store's page gave, when they're from this page (the rules may point at another one now). */
  figures(retailerId: string, url: string | undefined): FeePageRead | undefined {
    return figuresOf(this.reads[retailerId], url);
  }

  /** Whether the store's page should be read (again): never read, another page now, or its last read is old. */
  due(retailerId: string, url: string): boolean {
    const r = this.reads[retailerId];
    if (!r || r.url !== url) return true;
    return this.now() - r.at > (r.ok ? FEES_KEEP_MS : FEES_RETRY_MS);
  }

  /** A read just tried. One that didn't work keeps what the last good read of the same page found. */
  record(retailerId: string, read: Omit<FeeRead, 'feesAt'>): void {
    const had = this.reads[retailerId];
    const next: FeeRead = { ...read };
    if (read.ok && read.fees) next.feesAt = read.at;
    else {
      delete next.fees;
      if (had?.url === read.url && had.fees) {
        next.fees = had.fees;
        next.feesAt = had.feesAt;
      }
    }
    this.reads = { ...this.reads, [retailerId]: next };
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
    const reads: Record<string, FeeRead> = {};
    for (const [id, r] of Object.entries(saved)) {
      if (!isObj(r) || typeof r.url !== 'string' || typeof r.at !== 'number' || typeof r.ok !== 'boolean') continue;
      const fees = isObj(r.fees) && isObj(r.fees.pickup) && isObj(r.fees.delivery) ? (r.fees as unknown as FeePageRead) : undefined;
      reads[id] = { ...(r as unknown as FeeRead), fees, ...(fees && typeof r.feesAt === 'number' ? { feesAt: r.feesAt } : { feesAt: undefined }) };
      if (!fees) delete reads[id].fees;
      if (reads[id].feesAt === undefined) delete reads[id].feesAt;
    }
    this.reads = reads;
    this.emit();
  }

  private emit(): void {
    this.changes++;
    this.listeners.forEach((listener) => listener());
  }
}
