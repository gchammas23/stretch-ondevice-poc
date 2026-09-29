import type { KeyValueStore } from '../state/appStore';
import { sameStoreId } from '../onDevice/storeIdentity';
import { agentTask, followUpTask, readAgentAnswer, type AgentRetailer } from './agent';
import { BrowserUseApi, BrowserUseError, TERMINAL_RUN, type RunStatus } from './browserUse';
import { CdpClosed, CdpTimeout } from './cdp';
import { checkComparison, comparisonJobs, comparisonOf, comparisonStatus, type CompareProblem, type CompareRequest, type Comparison } from './compare';
import { AGENT_MODEL, BROWSER_LABEL, BROWSER_TIMEOUT_MIN, browserUseKey, MAX_MB_PER_BROWSER, MAX_RUN_COST_USD, POLL_MS } from './config';
import { FlowStopped, type FlowContext, type FlowOutcome, type FlowPage } from './flow';
import {
  applyToJob,
  checkRequest,
  jobStatus,
  needsCloud,
  newJob,
  readJobs,
  runningJobs,
  unstoppedBrowsers,
  type CloudItem,
  type CloudJob,
  type CloudRetailerId,
  type JobRequest,
  type RequestProblem,
  type RetailerRun,
  type RunEvent,
  type TermResult,
} from './jobs';
import { targetFlow } from './target';
import { walmartFlow } from './walmart';

// Pure TypeScript: runs cloud jobs, whatever screen is open. Each retailer of a job runs on its own, in parallel:
// - 'browser': a cloud browser is created (its id saved at once), driven over the DevTools protocol by walmart.ts or
//   target.ts, and stopped in a finally block, which also reads what it cost;
// - 'agent': a Browser Use agent run is started and polled every 10 s while the app is open, and on every launch or
//   return to the app; an answer that isn't the JSON asked for gets one follow-up in its session;
// - 'device': this phone's own search, as the app always does it (Kroger's official API; and in a Phone vs. cloud
//   comparison, the phone's side: see compare.ts).
// Every change is saved on the phone. When the app opens, browsers not known to be stopped are stopped again, and
// whatever was running then is taken up: agent runs are polled and finished, anything else was cut off with the app
// and is marked interrupted, to try again. No OS background task is used: work goes on only while the OS keeps the
// app running.

/** A cloud browser's page, connected: a flow drives it, and the runner checks it's still there and lets it go. */
export interface LivePage extends FlowPage {
  alive(timeoutMs?: number): Promise<boolean>;
  close(): void;
  /** About the data this phone moved driving the browser (see PageSession.wireBytes). */
  readonly wireBytes?: number;
}

/** A term searched on this phone: its products, the store its search said it priced, and what the search took. */
export interface DeviceResult {
  items: CloudItem[];
  found: number;
  storeId?: string;
  ms?: number;
  bytes?: number;
  how?: TermResult['how'];
}

/**
 * A search on this phone that didn't work: why (the phone's own reason code: 'challenge', 'http_403', 'cooling_down'…),
 * what the page showed, whether a store's defenses stopped it (a bot check, or a refusal), and what it took.
 */
export class DeviceSearchError extends Error {
  constructor(
    readonly reason: string,
    readonly detail?: string,
    readonly info: { blocked?: boolean; ms?: number; bytes?: number } = {},
  ) {
    super(detail ?? reason);
    this.name = 'DeviceSearchError';
  }
}

export interface RunnerDeps {
  api: BrowserUseApi;
  connect(cdpUrl: string): Promise<LivePage>;
  /**
   * One search on this phone, through the app's own search. `test`: for a Phone vs. cloud comparison, so a bot check
   * is noted, not shown, and the search counts as a test's (as the phone vs. server test's do).
   */
  deviceSearch(retailerId: CloudRetailerId, term: string, storeId: string, opts?: { test?: boolean }): Promise<DeviceResult>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  newId?: () => string;
  /** How long after a browser stops its charges are read (Browser Use settles them a moment later). */
  costDelayMs?: number;
  pollMs?: number;
}

export type StartResult = { ok: true; job: CloudJob } | ({ ok: false } & RequestProblem);
export type CompareStartResult = { ok: true; comparison: Comparison } | ({ ok: false } & CompareProblem);

const KEY = 'stretch.cloud.v1';
export const CLOUD_STORAGE_KEY = KEY;
/** Jobs kept on the phone, newest first. Running ones are never dropped. */
const JOBS_KEPT = 30;
/** A scripted retailer gives up a minute before Browser Use would stop its browser anyway. */
const BROWSER_MAX_MS = (BROWSER_TIMEOUT_MIN - 1) * 60_000;
/** An agent run still going after this long is cancelled. */
const AGENT_MAX_MS = 20 * 60_000;
const COST_DELAY_MS = 5_000;

interface Live {
  stopped: boolean;
  /** Why the app stopped it. Cancelling and interrupting say so themselves; taking too long is said by the run. */
  why?: 'cancelled' | 'interrupted' | 'too_slow';
  browserId?: string;
  page?: LivePage;
  startedAt: number;
}

const liveKey = (jobId: string, retailerId: CloudRetailerId) => `${jobId}|${retailerId}`;

/** A Browser Use error as a reason code: no credit, a spending cap, too many browsers, or anything else it refused. */
function apiReason(e: BrowserUseError): string {
  if (e.status === 402) return /spend/i.test(e.detail) ? 'spend_limit' : 'no_credit';
  if (e.status === 429) return 'too_many_browsers';
  if (e.status === 0) return 'connection';
  return 'browser_api';
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 200);

export class CloudRunner {
  version = 0;
  private jobs: CloudJob[] = [];
  /** Browsers of jobs no longer on the phone, not yet known to be stopped. */
  private orphans: string[] = [];
  private listeners = new Set<() => void>();
  private finishedListeners = new Set<(job: CloudJob) => void>();
  private comparedListeners = new Set<(comparison: Comparison) => void>();
  private live = new Map<string, Live>();
  private active = true;
  private backgroundedAt = -1;
  private activeWaiters: (() => void)[] = [];
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private polling = false;
  private creating = 0;
  private sweeping = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private storage: KeyValueStore | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private readyResolve!: () => void;
  private ready = new Promise<void>((resolve) => {
    this.readyResolve = resolve;
  });

  constructor(private deps: RunnerDeps | null = null) {}

  /** Gives the runner what it works with (the app does this once, as it opens). */
  attach(deps: RunnerDeps): void {
    this.deps = deps;
  }

  private get d(): Required<RunnerDeps> {
    if (!this.deps) throw new Error('the cloud runner has nothing attached');
    return {
      now: Date.now,
      sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
      newId: () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
      costDelayMs: COST_DELAY_MS,
      pollMs: POLL_MS,
      ...this.deps,
    };
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Called once for each job that finishes (every retailer done, blocked, failed, interrupted or cancelled). */
  onFinished(listener: (job: CloudJob) => void): () => void {
    this.finishedListeners.add(listener);
    return () => {
      this.finishedListeners.delete(listener);
    };
  }

  /** Called once for each Phone vs. cloud comparison that finishes (every side over), unless it was cancelled. */
  onCompared(listener: (comparison: Comparison) => void): () => void {
    this.comparedListeners.add(listener);
    return () => {
      this.comparedListeners.delete(listener);
    };
  }

  getJobs = (): CloudJob[] => this.jobs;
  getJob = (id: string): CloudJob | undefined => this.jobs.find((j) => j.id === id);

  /** The app is on screen (true) or not. Coming back checks the cloud browsers and polls the agent runs at once. */
  setActive(active: boolean): void {
    if (active === this.active) return;
    this.active = active;
    if (!active) {
      this.backgroundedAt = this.d.now();
      if (this.pollTimer) clearTimeout(this.pollTimer);
      this.pollTimer = null;
      void this.flush();
      return;
    }
    this.activeWaiters.splice(0).forEach((wake) => wake());
    void this.resume();
  }

  /**
   * Loads the saved jobs and takes up what was running when the app last closed: agent runs are polled and finished;
   * cloud browsers lost their connection with the app, and this phone's own searches ended with it, so those are
   * interrupted. Then every browser not known to be stopped is stopped.
   */
  async hydrate(storage: KeyValueStore): Promise<void> {
    // Once per app launch: a screen reloading in development mustn't load over jobs that are running.
    if (this.storage) return;
    this.storage = storage;
    let raw: string | null = null;
    try {
      raw = await storage.getItem(KEY);
    } catch {
      raw = null;
    }
    this.jobs = readJobs(raw);
    this.orphans = readOrphans(raw);
    const at = this.d.now();
    let cutOff = false;
    for (const job of this.jobs) {
      for (const r of job.retailers) {
        if (r.status !== 'queued' && r.status !== 'running') continue;
        cutOff = true;
        if (r.via === 'agent' && (r.runId || r.followUpId)) continue;
        this.apply(job.id, r.retailerId, { type: 'interrupt', reason: 'app_closed', at });
      }
    }
    // Shown, not saved: nothing is written unless something changed (with cloud fetch never used, nothing at all).
    this.version++;
    this.listeners.forEach((listener) => listener());
    this.readyResolve();
    // Work cut off by the app closing may have left a browser whose id never reached the phone: its label finds it.
    void this.sweep(cutOff);
    void this.pollAgents().then(() => this.ensurePolling());
  }

  /** Checks the guardrails (see checkRequest), reading the account's credit first, and starts the job. */
  start(req: JobRequest): Promise<StartResult> {
    return this.serial(async () => {
      const check = await this.admit(req, this.jobs);
      if (!check.ok) return check;
      const d = this.d;
      const running = runningJobs(this.jobs);
      const job: CloudJob = { ...newJob(req, d.newId(), d.now()), ranAlone: running.length === 0, ...(check.balanceUsd !== undefined ? { balanceBefore: check.balanceUsd } : {}) };
      this.jobs = trim([job, ...this.jobs.map((j) => (running.includes(j) ? { ...j, ranAlone: false } : j))], this.orphans);
      this.changed();
      await this.saveNow();
      for (const r of job.retailers) void this.runRetailer(job.id, r.retailerId);
      return { ok: true, job };
    });
  }

  /** Tries a job's blocked, failed, interrupted or cancelled retailers again (or only `only`), after the same checks. */
  retry(jobId: string, only?: CloudRetailerId[]): Promise<StartResult> {
    return this.serial(async () => {
      const job = this.getJob(jobId);
      const again = (job?.retailers ?? []).filter((r) => ['blocked', 'failed', 'interrupted', 'cancelled'].includes(r.status) && (!only || only.includes(r.retailerId)));
      if (!job || !again.length) return { ok: false, problem: 'no_retailers' } as const;
      const others = this.jobs.filter((j) => j.id !== jobId);
      const check = await this.admit({ engine: job.engine, terms: job.terms, retailers: again.map((r) => ({ retailerId: r.retailerId, storeId: r.storeId, via: r.via })) }, others);
      if (!check.ok) return check;
      const at = this.d.now();
      for (const r of again) this.apply(jobId, r.retailerId, { type: 'retry', at });
      const running = runningJobs(others);
      this.update(jobId, (j) => ({ ...j, notifiedAt: undefined, balanceAfter: undefined, ranAlone: running.length === 0, balanceBefore: check.balanceUsd }));
      await this.saveNow();
      for (const r of again) void this.runRetailer(jobId, r.retailerId);
      return { ok: true, job: this.getJob(jobId)! };
    });
  }

  /**
   * Starts a Phone vs. cloud comparison (see compare.ts): the same terms at the same stores, on this phone and in the
   * cloud at once, a job for each side. Its cloud sides pass a job's guardrails together (the credit read first), and
   * one comparison runs at a time.
   */
  startComparison(req: CompareRequest): Promise<CompareStartResult> {
    return this.serial(async () => {
      const d = this.d;
      let balanceUsd: number | undefined;
      let balanceError: string | undefined;
      if (d.api.configured) {
        try {
          balanceUsd = (await d.api.account()).balanceUsd;
        } catch (e) {
          balanceError = e instanceof BrowserUseError ? (e.status ? `HTTP ${e.status}` : e.detail) : message(e);
        }
      }
      const check = checkComparison(req, { jobs: this.jobs, hasKey: d.api.configured, balanceUsd, balanceError });
      if (!check.ok) return check;
      const id = d.newId();
      const at = d.now();
      // Its sides run together, so the credit's move isn't any one side's cost: each side's own costs are kept instead.
      const jobs: CloudJob[] = comparisonJobs(req).map(({ side, request }) => ({ ...newJob(request, d.newId(), at), compare: { id, side }, ranAlone: false }));
      this.jobs = trim([...jobs, ...this.jobs], this.orphans);
      this.changed();
      await this.saveNow();
      for (const job of jobs) for (const r of job.retailers) void this.runRetailer(job.id, r.retailerId);
      return { ok: true, comparison: comparisonOf(this.jobs, id)! };
    });
  }

  /** Stops a comparison: every side still running is cancelled (see cancel). */
  async cancelComparison(id: string): Promise<void> {
    for (const job of this.jobs.filter((j) => j.compare?.id === id)) await this.cancel(job.id);
  }

  /** Removes a finished comparison from the phone, every side of it (see remove). */
  removeComparison(id: string): void {
    const sides = this.jobs.filter((j) => j.compare?.id === id);
    if (sides.some((j) => jobStatus(j) === 'running')) return;
    for (const job of sides) this.remove(job.id);
  }

  /** Stops a job: its browsers are stopped, its agent runs cancelled, and what came back so far stays. */
  async cancel(jobId: string): Promise<void> {
    const job = this.getJob(jobId);
    if (!job) return;
    const at = this.d.now();
    for (const r of job.retailers) {
      if (r.status !== 'queued' && r.status !== 'running') continue;
      const live = this.live.get(liveKey(jobId, r.retailerId));
      if (live) {
        live.stopped = true;
        live.why = 'cancelled';
        live.page?.close();
      }
      this.apply(jobId, r.retailerId, { type: 'cancel', at });
      if (r.via === 'agent') {
        for (const id of [r.runId, r.followUpId]) if (id) await this.d.api.cancelRun(id).catch(() => {});
        void this.stopAgentBrowsers(r.sessionId);
      }
    }
    await this.saveNow();
  }

  /** Removes a finished job from the phone; its browsers, if any aren't known to be stopped, are stopped later. */
  remove(jobId: string): void {
    const job = this.getJob(jobId);
    if (!job || jobStatus(job) === 'running') return;
    this.orphans = [...new Set([...this.orphans, ...unstoppedBrowsers([job]).map((b) => b.browserId)])];
    this.jobs = this.jobs.filter((j) => j.id !== jobId);
    this.changed();
  }

  /** Stops every job and forgets them all (Forget prices and history, Start over). Their browsers are still stopped. */
  async clear(): Promise<void> {
    await this.ready;
    // Never used: nothing to erase, and nothing is written.
    if (!this.jobs.length && !this.orphans.length) return;
    for (const job of this.jobs) if (jobStatus(job) === 'running') await this.cancel(job.id);
    this.orphans = [...new Set([...this.orphans, ...unstoppedBrowsers(this.jobs).map((b) => b.browserId)])];
    this.jobs = [];
    this.changed();
    await this.saveNow();
    void this.sweep(true);
  }

  /** Writes now, as the app leaves the screen. */
  flush(): Promise<void> {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    return this.storage?.setItem(KEY, JSON.stringify({ v: 1, jobs: this.jobs, orphans: this.orphans })).catch(() => {}) ?? Promise.resolve();
  }

  /**
   * Stops every browser the app started that isn't known to be stopped: from saved jobs and from jobs no longer kept;
   * and with `labeled`, any still running with the app's label (one created just before the app was killed, before its
   * id was saved). With nothing to stop, it asks Browser Use nothing.
   */
  async sweep(labeled = false): Promise<void> {
    const d = this.d;
    if (!d.api.configured || this.sweeping) return;
    if (!labeled && !this.orphans.length && !unstoppedBrowsers(this.jobs).length) return;
    this.sweeping = true;
    try {
      const inUse = new Set([...this.live.values()].map((l) => l.browserId).filter(Boolean));
      for (const { jobId, retailerId, browserId } of unstoppedBrowsers(this.jobs)) {
        if (!inUse.has(browserId)) await this.stopBrowser(jobId, retailerId, browserId, 0);
      }
      for (const id of [...this.orphans]) {
        if (inUse.has(id)) continue;
        try {
          await d.api.stopBrowser(id);
        } catch (e) {
          if (!(e instanceof BrowserUseError && e.status === 404)) continue;
        }
        this.orphans = this.orphans.filter((o) => o !== id);
      }
      // A browser being created now isn't in use yet: the label sweep waits for another time.
      if (labeled && !this.creating) {
        const leftovers = await d.api.activeBrowsers({ label: BROWSER_LABEL }).catch(() => []);
        const nowInUse = new Set([...this.live.values()].map((l) => l.browserId).filter(Boolean));
        for (const b of leftovers) if (!nowInUse.has(b.id) && !this.creating) await d.api.stopBrowser(b.id).catch(() => {});
      }
      this.changed();
    } finally {
      this.sweeping = false;
    }
  }

  // --- Internals ---------------------------------------------------------------------------------------------

  /** Starts and retries one at a time, so two can't both pass the running-jobs check. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(async () => {
      await this.ready;
      return fn();
    });
    this.queue = next.catch(() => {});
    return next;
  }

  /** The guardrails for `req` against `jobs`, reading the credit when the cloud is used. */
  private async admit(req: JobRequest, jobs: CloudJob[]): Promise<({ ok: true } | ({ ok: false } & RequestProblem)) & { balanceUsd?: number }> {
    const d = this.d;
    let balanceUsd: number | undefined;
    let balanceError: string | undefined;
    if (needsCloud(req) && d.api.configured) {
      try {
        balanceUsd = (await d.api.account()).balanceUsd;
      } catch (e) {
        balanceError = e instanceof BrowserUseError ? (e.status ? `HTTP ${e.status}` : e.detail) : message(e);
      }
    }
    const check = checkRequest(req, { jobs, hasKey: d.api.configured, balanceUsd, balanceError });
    return { ...check, ...(balanceUsd !== undefined ? { balanceUsd } : {}) };
  }

  private job(jobId: string): CloudJob | undefined {
    return this.jobs.find((j) => j.id === jobId);
  }

  private retailer(jobId: string, retailerId: CloudRetailerId): RetailerRun | undefined {
    return this.job(jobId)?.retailers.find((r) => r.retailerId === retailerId);
  }

  private update(jobId: string, fn: (job: CloudJob) => CloudJob): void {
    this.jobs = this.jobs.map((j) => (j.id === jobId ? fn(j) : j));
    this.changed();
  }

  /** One retailer event; a job that just finished is announced once. */
  private apply(jobId: string, retailerId: CloudRetailerId, event: RunEvent): void {
    const before = this.job(jobId);
    if (!before) return;
    const after = applyToJob(before, retailerId, event);
    if (after === before) return;
    this.jobs = this.jobs.map((j) => (j.id === jobId ? after : j));
    this.changed();
    if (after.finishedAt && !before.finishedAt && !after.notifiedAt) this.finished(jobId);
  }

  private finished(jobId: string): void {
    this.update(jobId, (j) => ({ ...j, notifiedAt: this.d.now() }));
    const job = this.job(jobId);
    if (!job) return;
    if (job.compare) {
      // A comparison is news once, as its last side ends; one the user cancelled isn't news at all.
      const comparison = comparisonOf(this.jobs, job.compare.id);
      const status = comparison && comparisonStatus(comparison);
      if (comparison && status !== 'running' && status !== 'cancelled') this.comparedListeners.forEach((listener) => listener(comparison));
      return;
    }
    // A job the user cancelled isn't news to them.
    if (jobStatus(job) !== 'cancelled') this.finishedListeners.forEach((listener) => listener(job));
    if (needsCloud(job)) void this.balanceAfter(jobId);
  }

  /** The account's credit once the job's browsers are stopped: with the credit before, what the job cost. */
  private async balanceAfter(jobId: string): Promise<void> {
    const d = this.d;
    for (let i = 0; i < 30; i++) {
      const job = this.job(jobId);
      if (!job || !unstoppedBrowsers([job]).length) break;
      await d.sleep(2000);
    }
    await d.sleep(d.costDelayMs);
    try {
      const { balanceUsd } = await d.api.account();
      if (this.job(jobId)?.finishedAt) this.update(jobId, (j) => ({ ...j, balanceAfter: balanceUsd }));
    } catch {
      // Left out.
    }
  }

  private changed(): void {
    this.version++;
    this.listeners.forEach((listener) => listener());
    if (!this.storage) return;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.flush(), 300);
  }

  private saveNow(): Promise<void> {
    return this.flush();
  }

  private async runRetailer(jobId: string, retailerId: CloudRetailerId): Promise<void> {
    const r = this.retailer(jobId, retailerId);
    if (!r || r.status !== 'queued') return;
    this.apply(jobId, retailerId, { type: 'start', at: this.d.now() });
    try {
      if (r.via === 'browser') await this.runBrowser(jobId, retailerId, r.storeId);
      else if (r.via === 'agent') await this.startAgent(jobId, retailerId, r.storeId);
      else await this.runDevice(jobId, retailerId, r.storeId);
    } catch (e) {
      this.apply(jobId, retailerId, { type: 'finish', status: 'failed', reason: 'error', detail: message(e), at: this.d.now() });
    }
  }

  private flowContext(jobId: string, retailerId: CloudRetailerId, live: Live): FlowContext {
    const d = this.d;
    // Each search's time and data: since the search before it ended, or since the store was set.
    let mark = { at: d.now(), bytes: live.page?.bytes ?? 0 };
    const since = (): { ms: number; bytes: number } => {
      const at = d.now();
      const bytes = live.page?.bytes ?? 0;
      const took = { ms: at - mark.at, bytes: Math.max(0, bytes - mark.bytes) };
      mark = { at, bytes };
      return took;
    };
    return {
      sleep: d.sleep,
      now: d.now,
      stopped: () => live.stopped,
      onTerm: (result) => this.apply(jobId, retailerId, { type: 'term', result: { ...since(), ...result } }),
      onStoreSet: (how) => {
        since();
        this.apply(jobId, retailerId, { type: 'storeSet', how });
      },
      onCheck: () => this.apply(jobId, retailerId, { type: 'checkSeen' }),
      maxMb: MAX_MB_PER_BROWSER,
    };
  }

  /** A flow's outcome as the retailer's end: done only when at least one search came back. */
  private endFlow(jobId: string, retailerId: CloudRetailerId, outcome: FlowOutcome): void {
    const at = this.d.now();
    if (outcome.status !== 'done') {
      this.apply(jobId, retailerId, { type: 'finish', status: outcome.status, reason: outcome.reason, at });
      return;
    }
    const results = this.retailer(jobId, retailerId)?.results ?? [];
    if (results.some((r) => r.status === 'done')) this.apply(jobId, retailerId, { type: 'finish', status: 'done', at });
    else this.apply(jobId, retailerId, { type: 'finish', status: 'failed', reason: results[0]?.reason ?? 'no_results', at });
  }

  /** Scripted: a cloud browser of its own, driven by the retailer's flow, and stopped whatever happens. */
  private async runBrowser(jobId: string, retailerId: CloudRetailerId, storeId: string): Promise<void> {
    const d = this.d;
    const key = liveKey(jobId, retailerId);
    const live: Live = { stopped: false, startedAt: d.now() };
    this.live.set(key, live);
    const watchdog = setTimeout(() => {
      live.stopped = true;
      live.why = 'too_slow';
      live.page?.close();
    }, BROWSER_MAX_MS);
    let browserId: string | undefined;
    try {
      this.creating++;
      let cdpUrl: string | undefined;
      try {
        const browser = await d.api.createBrowser({ job: jobId, retailer: retailerId });
        browserId = browser.id;
        cdpUrl = browser.cdpUrl;
      } finally {
        this.creating--;
      }
      live.browserId = browserId;
      this.apply(jobId, retailerId, { type: 'browser', id: browserId });
      // Its id is on the phone before anything else happens, so it's stopped even if the app dies now.
      await this.saveNow();
      if (live.stopped) throw new FlowStopped();
      if (!cdpUrl) {
        this.apply(jobId, retailerId, { type: 'finish', status: 'failed', reason: 'no_cdp', at: d.now() });
        return;
      }
      live.page = await d.connect(cdpUrl);
      if (live.stopped) throw new FlowStopped();
      const terms = this.job(jobId)?.terms ?? [];
      const flow = retailerId === 'walmart' ? walmartFlow : targetFlow;
      const outcome = await flow(live.page, storeId, terms, this.flowContext(jobId, retailerId, live));
      this.apply(jobId, retailerId, { type: 'bytes', bytes: live.page.bytes, wireBytes: live.page.wireBytes });
      this.endFlow(jobId, retailerId, outcome);
    } catch (e) {
      const at = d.now();
      if (live.page) this.apply(jobId, retailerId, { type: 'bytes', bytes: live.page.bytes, wireBytes: live.page.wireBytes });
      if (live.why === 'too_slow') this.apply(jobId, retailerId, { type: 'finish', status: 'failed', reason: 'too_slow', at });
      else if (live.stopped) {
        // Cancelled or interrupted: whoever stopped it said so.
      } else if (e instanceof CdpClosed) {
        const slept = this.backgroundedAt >= live.startedAt;
        this.apply(jobId, retailerId, { type: 'interrupt', reason: slept ? 'app_slept' : 'connection', detail: message(e), at });
      } else if (e instanceof BrowserUseError) this.apply(jobId, retailerId, { type: 'finish', status: 'failed', reason: apiReason(e), detail: message(e), at });
      else if (e instanceof CdpTimeout) this.apply(jobId, retailerId, { type: 'finish', status: 'failed', reason: 'timeout', detail: message(e), at });
      else this.apply(jobId, retailerId, { type: 'finish', status: 'failed', reason: 'error', detail: message(e), at });
    } finally {
      clearTimeout(watchdog);
      live.page?.close();
      this.live.delete(key);
      if (browserId) await this.stopBrowser(jobId, retailerId, browserId, d.costDelayMs);
    }
  }

  /** Stops a browser, then reads what it cost. One the API can't stop now is tried again later (see sweep). */
  private async stopBrowser(jobId: string, retailerId: CloudRetailerId, id: string, costDelayMs: number): Promise<void> {
    const d = this.d;
    try {
      await d.api.stopBrowser(id);
    } catch (e) {
      // Gone already: nothing to stop. Anything else: tried again when the app opens or comes back.
      if (!(e instanceof BrowserUseError && e.status === 404)) return;
    }
    if (costDelayMs) await d.sleep(costDelayMs);
    let use: { proxyMb: number; proxyUsd: number; browserUsd: number } | undefined;
    try {
      const b = await d.api.getBrowser(id);
      use = { proxyMb: b.proxyUsedMb, proxyUsd: b.proxyCost, browserUsd: b.browserCost };
    } catch {
      use = undefined;
    }
    this.apply(jobId, retailerId, { type: 'browserStopped', id, ...(use ? { use } : {}) });
  }

  /** Agent: starts the run; polling does the rest (see pollAgents). */
  private async startAgent(jobId: string, retailerId: CloudRetailerId, storeId: string): Promise<void> {
    const d = this.d;
    const terms = this.job(jobId)?.terms ?? [];
    try {
      const run = await d.api.createRun({ task: agentTask(retailerId as AgentRetailer, storeId, terms), model: AGENT_MODEL, maxCostUsd: MAX_RUN_COST_USD });
      this.apply(jobId, retailerId, { type: 'agentRun', runId: run.id, sessionId: run.sessionId });
      await this.saveNow();
      // Cancelled while it was being created: cancelled in the cloud too.
      if (this.retailer(jobId, retailerId)?.status === 'cancelled') await d.api.cancelRun(run.id).catch(() => {});
      else this.ensurePolling();
    } catch (e) {
      this.apply(jobId, retailerId, {
        type: 'finish',
        status: 'failed',
        reason: e instanceof BrowserUseError ? apiReason(e) : 'error',
        detail: message(e),
        at: d.now(),
      });
    }
  }

  private hasRunningAgents(): boolean {
    return this.jobs.some((j) => j.retailers.some((r) => r.via === 'agent' && r.status === 'running' && (r.runId || r.followUpId)));
  }

  private ensurePolling(): void {
    if (this.pollTimer || !this.active || !this.deps || !this.hasRunningAgents()) return;
    this.pollTimer = setTimeout(async () => {
      this.pollTimer = null;
      await this.pollAgents();
      this.ensurePolling();
    }, this.d.pollMs);
  }

  /** Every running agent run's status, once; the finished ones are read and their retailers finished. */
  async pollAgents(): Promise<void> {
    if (this.polling || !this.deps) return;
    this.polling = true;
    try {
      for (const job of this.jobs) {
        for (const r of job.retailers) {
          const runId = r.followUpId ?? r.runId;
          if (r.via === 'agent' && r.status === 'running' && runId) await this.pollAgent(job.id, r.retailerId, runId);
        }
      }
    } finally {
      this.polling = false;
    }
  }

  private async pollAgent(jobId: string, retailerId: CloudRetailerId, runId: string): Promise<void> {
    const d = this.d;
    const fail = (reason: string, detail?: string) =>
      this.apply(jobId, retailerId, { type: 'finish', status: 'failed', reason, ...(detail ? { detail } : {}), at: d.now() });
    let status: RunStatus;
    try {
      status = await d.api.runStatus(runId);
    } catch (e) {
      // A lost run can't come back; anything else is asked again at the next poll.
      if (e instanceof BrowserUseError && e.status === 404) fail('agent_failed', message(e));
      return;
    }
    const r = this.retailer(jobId, retailerId);
    const job = this.job(jobId);
    if (!r || !job || r.status !== 'running') return;
    if (!TERMINAL_RUN.has(status)) {
      if (r.startedAt !== undefined && d.now() - r.startedAt > AGENT_MAX_MS) {
        await d.api.cancelRun(runId).catch(() => {});
        fail('too_slow');
        void this.stopAgentBrowsers(r.sessionId);
      }
      return;
    }
    let run;
    try {
      run = await d.api.getRun(runId);
    } catch {
      return;
    }
    if (run.costUsd !== undefined) this.apply(jobId, retailerId, { type: 'runCost', runId, usd: run.costUsd });
    const sessionId = run.sessionId || r.sessionId;
    if (run.status !== 'completed') {
      fail(run.status === 'cancelled' ? 'agent_cancelled' : 'agent_failed', run.error);
      void this.stopAgentBrowsers(sessionId);
      return;
    }
    const reading = readAgentAnswer(run.result, run.output, { retailer: retailerId as AgentRetailer, storeId: r.storeId, terms: job.terms });
    if (reading.kind === 'invalid') {
      if (!r.followUpId && sessionId) {
        try {
          const next = await d.api.createRun({
            task: followUpTask(retailerId as AgentRetailer, r.storeId, job.terms, reading.why),
            model: AGENT_MODEL,
            maxCostUsd: MAX_RUN_COST_USD,
            sessionId,
          });
          this.apply(jobId, retailerId, { type: 'agentRun', runId: next.id, sessionId: next.sessionId || sessionId, followUp: true });
          await this.saveNow();
          return;
        } catch (e) {
          fail('bad_json', `${reading.why}; the follow-up couldn't start: ${message(e)}`);
        }
      } else fail('bad_json', reading.why);
      void this.stopAgentBrowsers(sessionId);
      return;
    }
    if (reading.kind === 'blocked') {
      this.apply(jobId, retailerId, { type: 'checkSeen' });
      this.apply(jobId, retailerId, { type: 'finish', status: 'blocked', reason: 'challenge', at: d.now() });
      void this.stopAgentBrowsers(sessionId);
      return;
    }
    if (reading.storeConfirmed) this.apply(jobId, retailerId, { type: 'storeSet', how: 'agent' });
    const at = d.now();
    for (const [term, items] of Object.entries(reading.byTerm)) {
      if (!term && !items.length) continue;
      this.apply(jobId, retailerId, {
        type: 'term',
        result: { term, status: 'done', items, found: items.length, pageStoreId: reading.answeredStoreId, storeMatches: reading.storeMatches, at },
      });
    }
    this.apply(jobId, retailerId, { type: 'finish', status: 'done', at });
    void this.stopAgentBrowsers(sessionId);
  }

  /** An agent's browser outlives its run by about 20 minutes: once the app is done with the session, it's stopped. */
  private async stopAgentBrowsers(sessionId: string | undefined): Promise<void> {
    if (!sessionId) return;
    try {
      for (const b of await this.d.api.activeBrowsers({ agentSessionId: sessionId })) await this.d.api.stopBrowser(b.id).catch(() => {});
    } catch {
      // Browser Use cleans it up by itself.
    }
  }

  /** Waits until the app is on screen: this phone's own searches pause while it's away. */
  private whenActive(live: Live): Promise<void> {
    if (this.active || live.stopped) return Promise.resolve();
    return new Promise((resolve) => this.activeWaiters.push(resolve));
  }

  /**
   * On this phone: each term through the app's own search (Kroger's official API, Target's page, or a comparison's
   * phone side: see compare.ts). A store that only blocked is blocked.
   */
  private async runDevice(jobId: string, retailerId: CloudRetailerId, storeId: string): Promise<void> {
    const d = this.d;
    const key = liveKey(jobId, retailerId);
    const live: Live = { stopped: false, startedAt: d.now() };
    this.live.set(key, live);
    const test = !!this.job(jobId)?.compare;
    try {
      for (const term of this.job(jobId)?.terms ?? []) {
        await this.whenActive(live);
        if (live.stopped || this.retailer(jobId, retailerId)?.status !== 'running') return;
        const began = d.now();
        try {
          const got = await d.deviceSearch(retailerId, term, storeId, test ? { test } : undefined);
          // A ZIP code asks the API for its nearest store: whichever store it answers for is the one asked for.
          const matches = got.storeId ? /^\d{5}$/.test(storeId) || sameStoreId(got.storeId, storeId) : undefined;
          this.apply(jobId, retailerId, {
            type: 'term',
            result: {
              term,
              status: 'done',
              items: got.items,
              found: got.found,
              ...(got.storeId ? { pageStoreId: got.storeId, storeMatches: matches } : {}),
              ms: got.ms ?? d.now() - began,
              ...(got.bytes !== undefined ? { bytes: got.bytes } : {}),
              ...(got.how ? { how: got.how } : {}),
              at: d.now(),
            },
          });
        } catch (e) {
          if (live.stopped) return;
          if (this.backgroundedAt >= began) {
            // The app left the screen mid-search: cut off, not failed.
            this.apply(jobId, retailerId, { type: 'interrupt', reason: 'app_slept', detail: message(e), at: d.now() });
            return;
          }
          const why = e instanceof DeviceSearchError ? e : undefined;
          this.apply(jobId, retailerId, {
            type: 'term',
            result: {
              term,
              status: why?.info.blocked ? 'blocked' : 'failed',
              items: [],
              reason: why ? (why.info.blocked ? phoneBlockReason(why.reason) : why.reason) : 'device_failed',
              detail: message(e),
              ms: why?.info.ms ?? d.now() - began,
              ...(why?.info.bytes !== undefined ? { bytes: why.info.bytes } : {}),
              at: d.now(),
            },
          });
        }
      }
      const results = this.retailer(jobId, retailerId)?.results ?? [];
      const blocked = results.find((r) => r.status === 'blocked');
      if (blocked && !results.some((r) => r.status === 'done')) this.apply(jobId, retailerId, { type: 'finish', status: 'blocked', reason: blocked.reason, at: d.now() });
      else if (this.retailer(jobId, retailerId)?.status === 'running') this.endFlow(jobId, retailerId, { status: 'done' });
    } finally {
      this.live.delete(key);
    }
  }

  /** Back on screen: a cloud browser whose connection dropped meanwhile is interrupted, and agent runs are polled. */
  private async resume(): Promise<void> {
    const at = this.d.now();
    for (const [key, live] of [...this.live]) {
      if (!live.page || live.stopped) continue;
      if (await live.page.alive(5_000)) continue;
      const [jobId, retailerId] = key.split('|') as [string, CloudRetailerId];
      live.stopped = true;
      live.why = 'interrupted';
      this.apply(jobId, retailerId, { type: 'interrupt', reason: 'app_slept', at });
      // Its flow stops at once, and its finally block stops the browser.
      live.page.close();
    }
    await this.pollAgents();
    this.ensurePolling();
    void this.sweep();
  }
}

/**
 * Jobs kept: the newest JOBS_KEPT, never a running one, and a comparison whole (all its sides, or none). Browsers of
 * the ones dropped go to `orphans` to be stopped.
 */
function trim(jobs: CloudJob[], orphans: string[]): CloudJob[] {
  if (jobs.length <= JOBS_KEPT) return jobs;
  const keep: CloudJob[] = [];
  const kept = new Set<string>();
  for (const job of jobs) {
    if (keep.length < JOBS_KEPT || jobStatus(job) === 'running' || (job.compare && kept.has(job.compare.id))) {
      keep.push(job);
      if (job.compare) kept.add(job.compare.id);
    } else for (const b of unstoppedBrowsers([job])) if (!orphans.includes(b.browserId)) orphans.push(b.browserId);
  }
  return keep;
}

/** A phone search a store's defenses stopped, as a reason code: its HTTP status, a refusal, or a bot check. */
function phoneBlockReason(reason: string): string {
  if (/^http_\d{3}$/.test(reason)) return reason;
  return reason === 'blocked' ? 'refused' : 'phone_check';
}

function readOrphans(raw: string | null): string[] {
  try {
    const saved: unknown = raw ? JSON.parse(raw) : null;
    const list = typeof saved === 'object' && saved !== null ? (saved as { orphans?: unknown }).orphans : undefined;
    return Array.isArray(list) ? list.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

/** The app's one runner, attached to the app by CloudProvider. The tests make their own. */
export const cloudRunner = new CloudRunner();

/** The Browser Use API with the key from .env. */
export const browserUseApi = (fetchFn?: ConstructorParameters<typeof BrowserUseApi>[1]) => new BrowserUseApi(browserUseKey(), fetchFn);
