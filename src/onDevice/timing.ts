// Pure TypeScript: when each part of a search happened, for the speed test's timeline. Times are Date.now() values in
// milliseconds. A page's own clock is the phone's clock, so what a page reports lines up with what the app saw.

/**
 * What the phone was doing for a search during one stretch of it:
 * - 'queue': waiting its turn in the pricing engine (stores at once, searches at once per store);
 * - 'wait': waiting at the store: for a page another search is loading, a page load ahead of it, a free slot to send
 *   a request, or a pause after the store pushed back;
 * - a page load, in four parts: 'start' (the hidden browser starting it, until the page's request went out), 'open'
 *   (until the page's HTML was in), 'prices' (until the store's data arrived) and 'settle' (until the load ended);
 * - 'check': a bot check on screen;
 * - 'replay': a request sent from the store's kept page, until its answer;
 * - 'fetch' and 'api': a plain request, an official API;
 * - 'parse': reading the products out of what came back, on the phone;
 * - 'show': from the result to the screen showing it.
 */
export type SpanKind = 'queue' | 'wait' | 'start' | 'open' | 'prices' | 'settle' | 'check' | 'replay' | 'fetch' | 'api' | 'parse' | 'show';

export interface TimingSpan {
  kind: SpanKind;
  start: number;
  end: number;
  /** False: this part failed, and the search went on another way (or failed). */
  ok?: false;
  /** Work done while something else ran (checking streamed data during a page load): counted, not drawn. */
  during?: true;
}

/** A page load's moments, filled in by its lane as they happen (see WebViewQueue.run). */
export interface LoadTiming {
  /** When the load was asked for. */
  queuedAt: number;
  /** When its hidden browser was given the page's address: after a bot check, when the page was loaded again. */
  startedAt?: number;
  /**
   * When the browser itself began loading the page (its own event, the first one), and how many pages it began in
   * all: more than one is the site moving itself on to another page.
   */
  openedAt?: number;
  navigations?: number;
  /**
   * From the page's own clock: when it started loading, when its final address was asked for (after redirects), and
   * when its HTML had been read.
   */
  navAt?: number;
  fetchAt?: number;
  htmlAt?: number;
  /** When the store's data first reached the app: a response with prices, or the page's own data. */
  dataAt?: number;
  /** When what had arrived was taken as the results (see WebViewJob.accept): the rest is the load finishing. */
  acceptedAt?: number;
  /** When the load ended, with its data or without. */
  doneAt?: number;
  /** The address asked for, and the one the page was at when it answered. */
  url?: string;
  pageUrl?: string;
  /**
   * How the load ended: 'results', taken as they streamed in; or the page's own say: 'quiet' (its requests went
   * quiet), 'gave_up' (nothing new came for a while), 'tries' (it ran out of time), 'data' (its data was in it).
   */
  ended?: string;
  /** Where the responses that streamed in came from, by label ("response https://…"). */
  streamed?: string[];
  /** A bot check: the first load's start, when the check showed, and when it was passed (the page loaded again then). */
  check?: { loadFrom: number; from: number; to?: number };
}

/** A request replayed in a kept page: asked for, sent from the page, answered. */
export interface ReplayTiming {
  askedAt: number;
  sentAt?: number;
  doneAt?: number;
}

/** One search, as the search layer timed it, with what its spans don't say ("redirects took 1.30 s"). */
export interface SearchTiming {
  startedAt: number;
  endedAt: number;
  spans: TimingSpan[];
  notes?: string[];
}

/** One search as the pricing engine saw it: queued, started, ended, and what happened in between. */
export interface SearchTimeline {
  queuedAt: number;
  startedAt: number;
  endedAt: number;
  spans: TimingSpan[];
  notes?: string[];
}

function span(kind: SpanKind, start: number | undefined, end: number | undefined, ok = true): TimingSpan | null {
  if (start === undefined || end === undefined || !(end > start)) return null;
  return ok ? { kind, start, end } : { kind, start, end, ok: false };
}

/** A moment the page reported, if it falls where it can: between `from` and `to`. */
const within = (at: number | undefined, from: number, to: number): number | undefined => (at !== undefined && at >= from && at <= to ? at : undefined);

/** A page load as spans: waiting for its turn, then its parts (see SpanKind). `ok` false marks them all failed. */
export function loadSpans(t: LoadTiming, ok = true): TimingSpan[] {
  const end = t.doneAt ?? t.dataAt ?? t.startedAt ?? t.queuedAt;
  const started = Math.min(t.startedAt ?? end, end);
  const first = t.check ? t.check.loadFrom : started;
  const parts: (TimingSpan | null)[] = [span('wait', t.queuedAt, first)];
  if (t.check) parts.push(span('open', t.check.loadFrom, t.check.from), span('check', t.check.from, t.check.to ?? end));
  // Loaded (again, after a check that was passed).
  if (!t.check || t.check.to !== undefined) {
    // The browser's own word for when it began loading the page, else the page's clock.
    const nav = within(t.openedAt, started, end) ?? within(t.navAt, started, end);
    const html = within(t.htmlAt, nav ?? started, end);
    // Waiting for prices lasts until the results were taken; before that, what arrived wasn't them yet.
    const data = within(t.acceptedAt ?? t.dataAt, html ?? nav ?? started, end);
    parts.push(
      span('start', started, nav),
      span('open', nav ?? started, html ?? data ?? end),
      html !== undefined ? span('prices', html, data ?? end) : null,
      data !== undefined ? span('settle', data, end) : null,
    );
  }
  return parts.filter((s): s is TimingSpan => !!s).map((s) => (ok || s.kind === 'wait' ? s : { ...s, ok: false }));
}

const place = (url: string | undefined) => {
  const m = /^https?:\/\/([^/?#]+)([^?#]*)/i.exec(url ?? '');
  return m ? `${m[1].toLowerCase()}${m[2].replace(/\/$/, '')}` : undefined;
};

const ENDED: Record<string, string> = {
  quiet: 'its page went quiet',
  gave_up: 'its page got nothing new for a while',
  tries: 'its page ran out of time',
};

/**
 * What a page load did that its spans don't say: time spent on redirects, the site moving itself on to other pages,
 * ending up at another address, and ending on the page's own say rather than its results streaming in.
 */
export function loadNotes(t: LoadTiming): string[] {
  const out: string[] = [];
  if (t.openedAt !== undefined && t.navAt !== undefined && t.navAt - t.openedAt >= 300) {
    out.push(`the page itself started ${((t.navAt - t.openedAt) / 1000).toFixed(2)} s after its browser began loading it`);
  }
  if (t.navAt !== undefined && t.fetchAt !== undefined && t.fetchAt - t.navAt >= 150) out.push(`redirects took ${((t.fetchAt - t.navAt) / 1000).toFixed(2)} s`);
  if ((t.navigations ?? 0) > 1) out.push(`the site moved on to another page ${t.navigations! - 1 === 1 ? 'once' : `${t.navigations! - 1} times`}`);
  const asked = place(t.url);
  const landed = place(t.pageUrl);
  if (asked && landed && asked !== landed) out.push(`ended up at ${landed}`);
  if (t.ended && ENDED[t.ended]) out.push(`it ended when ${ENDED[t.ended]}, not as its results came in`);
  return out;
}

/** A replayed request as spans: waiting for a free slot in the page, then the round trip. */
export function replaySpans(t: ReplayTiming, ok = true): TimingSpan[] {
  const end = t.doneAt ?? t.sentAt ?? t.askedAt;
  return [span('wait', t.askedAt, t.sentAt ?? end), span('replay', t.sentAt, end, ok)].filter((s): s is TimingSpan => !!s);
}

/** Collects a search's spans as it goes. */
export class SpanLog {
  readonly spans: TimingSpan[] = [];
  readonly notes: string[] = [];

  add(kind: SpanKind, start: number, end: number, ok = true): void {
    const s = span(kind, start, end, ok);
    if (s) this.spans.push(s);
  }

  /** Something about the search its spans don't say. */
  note(text: string): void {
    if (!this.notes.includes(text)) this.notes.push(text);
  }

  load(t: LoadTiming, ok = true): void {
    this.spans.push(...loadSpans(t, ok));
    for (const note of loadNotes(t)) if (!this.notes.includes(note)) this.notes.push(note);
  }

  replay(t: ReplayTiming, ok = true): void {
    this.spans.push(...replaySpans(t, ok));
  }

  /** Runs `fn`, logging the time it took as `kind`. */
  time<T>(kind: SpanKind, fn: () => T, during = false): T {
    const t0 = Date.now();
    try {
      return fn();
    } finally {
      const s = span(kind, t0, Date.now());
      if (s) this.spans.push(during ? { ...s, during: true } : s);
    }
  }

  /** Marks the spans logged since `from` (a length of `spans`) failed: that way of searching didn't work out. */
  failSince(from: number): void {
    for (let i = from; i < this.spans.length; i++) {
      const s = this.spans[i];
      if (s.kind !== 'wait' && s.kind !== 'queue') this.spans[i] = { ...s, ok: false };
    }
  }
}

/** The engine's view of a search: its time in the queue, then the search's own spans. */
export function timelineOf(queuedAt: number, startedAt: number, endedAt: number, search?: SearchTiming): SearchTimeline {
  const queued = Math.min(queuedAt, startedAt);
  const queue = span('queue', queued, startedAt);
  return {
    queuedAt: queued,
    startedAt,
    endedAt,
    spans: [...(queue ? [queue] : []), ...(search?.spans ?? [])],
    ...(search?.notes?.length ? { notes: search.notes } : {}),
  };
}

// When a screen first showed each search's result: kept apart from the run, so noting it re-renders nothing.
const shown = new WeakMap<SearchTimeline, number>();

/** Notes that a screen showed the search's result at `at`. True the first time. */
export function markShown(timeline: SearchTimeline, at: number): boolean {
  if (shown.has(timeline)) return false;
  shown.set(timeline, Math.max(at, timeline.endedAt));
  return true;
}

export const shownAt = (timeline: SearchTimeline): number | undefined => shown.get(timeline);
