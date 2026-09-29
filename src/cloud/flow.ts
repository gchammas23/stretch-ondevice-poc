import type { Cookie, CookieParam, SeenRequest } from './cdp';
import type { RetailerRun, TermResult } from './jobs';
import { pxForm, PX_SNAPSHOT, waitOutCheck, type PageSnapshot, type PxForm } from './perimeterx';

// Pure TypeScript: what the scripted engine's flows (walmart.ts, target.ts) need from a page and from the job, so the
// tests can hand them a fake page.

/** The page a flow drives: a PageSession (cdp.ts), or a fake one in the tests. */
export interface FlowPage {
  bytes: number;
  readonly requests: SeenRequest[];
  prepare(blocked: string[]): Promise<{ blocking: boolean }>;
  navigate(url: string, until?: 'DOMContentLoaded' | 'load', timeoutMs?: number): Promise<void>;
  evaluate<T>(expression: string, opts?: { world?: 'isolated' | 'main'; timeoutMs?: number }): Promise<T>;
  click(x: number, y: number): Promise<void>;
  cookies(urls: string[]): Promise<Cookie[]>;
  /** Sets cookies in the browser's jar, as a site's own script would. */
  setCookies(cookies: CookieParam[]): Promise<void>;
  watchRequests(accept: (url: string) => boolean): void;
  responseBody(requestId: string): Promise<string>;
}

/** What a flow tells the job as it goes, and how it waits. */
export interface FlowContext {
  sleep(ms: number): Promise<void>;
  now(): number;
  /** The job was cancelled, or the app is giving up on this browser: the flow stops at its next step. */
  stopped(): boolean;
  onTerm(result: TermResult): void;
  /** The store is set, and how; `picked`: the store the site had picked for this browser by itself, before. */
  onStoreSet(how: NonNullable<RetailerRun['storeSet']>, picked?: string): void;
  onCheck(): void;
  /** Megabytes the page may move before the flow stops (see MAX_MB_PER_BROWSER). */
  maxMb: number;
}

export type FlowOutcome = { status: 'done' } | { status: 'blocked'; reason: string; detail?: string } | { status: 'failed'; reason: string; detail?: string };

/** Thrown between steps once the job no longer wants this flow. */
export class FlowStopped extends Error {
  constructor() {
    super('stopped');
    this.name = 'FlowStopped';
  }
}

export function step(ctx: FlowContext): void {
  if (ctx.stopped()) throw new FlowStopped();
}

/** The bot check the page shows now, if any. A page that can't be read (it's loading) counts as none. */
export async function checkFor(page: FlowPage): Promise<PxForm | null> {
  try {
    const snap = await page.evaluate<PageSnapshot | null>(PX_SNAPSHOT, { timeoutMs: 10_000 });
    return snap ? pxForm({ url: String(snap.url ?? ''), title: String(snap.title ?? ''), dialogs: Array.isArray(snap.dialogs) ? snap.dialogs.map(String) : [] }) : null;
  } catch {
    return null;
  }
}

/**
 * Whether the page can be driven now: 'clear' when there's no bot check, 'cleared' when there was one and it went away
 * by itself while the flow waited, 'blocked' when it stayed.
 */
export async function gate(page: FlowPage, ctx: FlowContext): Promise<'clear' | 'cleared' | 'blocked'> {
  if (!(await checkFor(page))) return 'clear';
  ctx.onCheck();
  return (await waitOutCheck(() => checkFor(page), ctx)) ? 'cleared' : 'blocked';
}

/** A cookie's value for a site, from the browser's jar. */
export async function cookieValue(page: FlowPage, url: string, name: string): Promise<string | undefined> {
  try {
    return (await page.cookies([url])).find((c) => c.name === name)?.value;
  } catch {
    return undefined;
  }
}

/** Over the flow's data allowance. */
export const overBudget = (page: FlowPage, ctx: FlowContext): boolean => page.bytes > ctx.maxMb * 1_000_000;
