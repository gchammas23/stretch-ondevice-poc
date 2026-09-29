import { MAX_RUNNING_JOBS, MAX_TERMS, MIN_BALANCE_USD } from './config';

// Pure TypeScript: what a cloud job is, how each of its retailers moves from queued to done, and the guardrails a job
// passes before it starts. The runner (runner.ts) does the work and saves every change; the screens read it.

/** Scripted: the app drives a cloud browser itself. Agent: a Browser Use agent is given the task. */
export type Engine = 'scripted' | 'agent';
export type CloudRetailerId = 'walmart' | 'target' | 'kroger';
export const CLOUD_RETAILERS: CloudRetailerId[] = ['walmart', 'target', 'kroger'];
/**
 * How a retailer is read in a job: a cloud browser the app drives ('browser'), a cloud agent ('agent'), or this phone
 * ('device': Kroger's official API as always, or Target's page when its cloud spike failed, see the README).
 */
export type Via = 'browser' | 'agent' | 'device';

export type RetailerStatus = 'queued' | 'running' | 'blocked' | 'failed' | 'done' | 'interrupted' | 'cancelled';
/** Over, one way or another; all but 'done' can be tried again. */
export const SETTLED: ReadonlySet<RetailerStatus> = new Set(['blocked', 'failed', 'done', 'interrupted', 'cancelled']);
const RETRYABLE: ReadonlySet<RetailerStatus> = new Set(['blocked', 'failed', 'interrupted', 'cancelled']);

/** One product, the same shape from every engine (it's what the agent is asked to return, plus what pages say). */
export interface CloudItem {
  itemId: string;
  name: string;
  price: number | null;
  /** The regular price, when `price` is a sale price below it. */
  wasPrice?: number;
  /** As the store printed it: "2.6 ¢/fl oz". */
  unitPrice?: string;
  /** "1 gal", "12 × 12 fl oz". */
  size?: string;
  url?: string;
  imageUrl?: string;
  sponsored?: boolean;
  inStock?: boolean;
  /**
   * Walmart: a store sells it (pickup or delivery from one), rather than it only shipping from a warehouse. Which store
   * is the page's to say (TermResult.storeMatches).
   */
  atStore?: boolean;
  /**
   * Target: the store its price is for, when that isn't the store asked for. Target prices each product for a store,
   * and one the store asked for doesn't carry comes priced at another: not the store's price, so not compared.
   */
  pricedAt?: string;
}

export interface TermResult {
  term: string;
  status: 'done' | 'blocked' | 'failed';
  items: CloudItem[];
  /** The store the retailer's own data said the prices are for. */
  pageStoreId?: string;
  /** True when that's the job's store. False: its prices are flagged, and not shown as the store's. */
  storeMatches?: boolean;
  /** Products the page listed, before keeping the first ITEMS_PER_TERM. */
  found?: number;
  reason?: string;
  /** What exactly went wrong, as the search said it. */
  detail?: string;
  /** Data this search moved, as metered: the cloud browser's page (its proxy's traffic), or this phone's own search. */
  bytes?: number;
  /** How long this search took: from the end of the one before (or of setting the store) to its products. */
  ms?: number;
  /**
   * Of `ms`, what driving the cloud browser from this phone added: its trips over the phone's connection, which a
   * server next to the browser wouldn't make (see PageSession in cdp.ts).
   */
  linkMs?: number;
  /** This phone's search: a page load, a request sent again from a loaded page, a plain request, or an official API. */
  how?: 'page' | 'replay' | 'request' | 'api';
  at: number;
}

/** A cloud browser a retailer used: whether the API confirmed it stopped, and what it cost as the API reported it. */
export interface BrowserUse {
  stopped?: boolean;
  proxyMb?: number;
  proxyUsd?: number;
  browserUsd?: number;
}

export interface RetailerRun {
  retailerId: CloudRetailerId;
  storeId: string;
  via: Via;
  status: RetailerStatus;
  /** Why it's blocked, failed or interrupted: a code (see words.ts). */
  reason?: string;
  /** What exactly went wrong, as the browser or API said it, for Diagnostics-style reading. */
  detail?: string;
  /** Scripted: the browser in use now. */
  browserId?: string;
  /** Every browser this retailer used (retries use a new one), so each is stopped and costed once. */
  browsers: Record<string, BrowserUse>;
  /** Agent: the run in progress, its session, and the follow-up asked for when its answer wasn't valid JSON. */
  runId?: string;
  sessionId?: string;
  followUpId?: string;
  /** Each agent run's cost, as Browser Use reported it (by run id). */
  runs: Record<string, number>;
  /**
   * How the store was set: pressed on its page, found already set, kept from an earlier run in the browser's saved
   * profile, asked for by number in each request (Target's pricing_store_id), or as the agent said.
   */
  storeSet?: 'button' | 'already' | 'kept' | 'request' | 'agent';
  /**
   * Scripted: the browser started from the retailer and store's saved profile (Browser Use keeps its cookies between
   * browsers): made for this run ('new'), or kept from an earlier one ('saved'). None: it started empty.
   */
  profile?: 'new' | 'saved';
  results: TermResult[];
  /** Data the scripted browser's page moved, as the app metered it. */
  bytes?: number;
  /** Data between this phone and the cloud browser (the DevTools connection), about. */
  wireBytes?: number;
  /**
   * Scripted: what driving the browser from this phone added to the time, in ms (see TermResult.linkMs): in all, and
   * before the store was set. The link's fastest round trip, and the commands sent (each a trip).
   */
  linkMs?: number;
  setupLinkMs?: number;
  rttMs?: number;
  commands?: number;
  /** A bot check showed up along the way, cleared or not. */
  checkSeen?: boolean;
  startedAt?: number;
  finishedAt?: number;
  /** Times it was started: 1, then more after retries. */
  attempts: number;
}

export interface CloudJob {
  id: string;
  engine: Engine;
  terms: string[];
  retailers: RetailerRun[];
  createdAt: number;
  finishedAt?: number;
  /** Where the user asked for it. */
  from?: { kind: 'price-check' | 'list' | 'cloud'; listId?: string };
  /** Credit before it started, and after it finished: its whole cost as the account saw it, when it ran alone. */
  balanceBefore?: number;
  balanceAfter?: number;
  ranAlone?: boolean;
  /** When the user was told it had finished. */
  notifiedAt?: number;
  /** One side of a Phone vs. cloud comparison (see compare.ts): the comparison's id, and which side this job is. */
  compare?: { id: string; side: CompareSide };
}

/** Phone vs. cloud: this phone's own search, the scripted cloud browser, or the Browser Use agent. */
export type CompareSide = 'phone' | 'scripted' | 'agent';

export type RunEvent =
  | { type: 'start'; at: number }
  | { type: 'browser'; id: string; profile?: RetailerRun['profile'] }
  | { type: 'browserStopped'; id: string; use?: Omit<BrowserUse, 'stopped'> }
  | { type: 'agentRun'; runId: string; sessionId: string; followUp?: boolean }
  | { type: 'runCost'; runId: string; usd: number }
  | { type: 'storeSet'; how: NonNullable<RetailerRun['storeSet']>; linkMs?: number }
  | { type: 'term'; result: TermResult }
  | { type: 'bytes'; bytes: number; wireBytes?: number; linkMs?: number; rttMs?: number; commands?: number }
  | { type: 'checkSeen' }
  | { type: 'finish'; status: 'done' | 'blocked' | 'failed'; reason?: string; detail?: string; at: number }
  | { type: 'interrupt'; reason: string; detail?: string; at: number }
  | { type: 'cancel'; at: number }
  | { type: 'retry'; at: number };

/**
 * Events that only mean something while the retailer runs. Anything else is taken at any time: costs, stops, and a
 * browser created as the retailer was cancelled (it's recorded, so it's stopped).
 */
const WHILE_RUNNING = new Set<RunEvent['type']>(['agentRun', 'storeSet', 'term', 'bytes', 'checkSeen', 'finish']);

/** Whether `event` can happen to a retailer in `status`. */
export function canApply(status: RetailerStatus, event: RunEvent['type']): boolean {
  if (event === 'start') return status === 'queued';
  if (WHILE_RUNNING.has(event)) return status === 'running';
  if (event === 'interrupt' || event === 'cancel') return status === 'running' || status === 'queued';
  if (event === 'retry') return RETRYABLE.has(status);
  return true;
}

/**
 * The retailer after `event`. One that can't happen in its state leaves it as it was (the same object), so a late
 * answer from a run that was interrupted or cancelled changes nothing.
 */
export function transition(run: RetailerRun, event: RunEvent): RetailerRun {
  if (!canApply(run.status, event.type)) return run;
  switch (event.type) {
    case 'start':
      return { ...run, status: 'running', startedAt: event.at, attempts: run.attempts + 1, reason: undefined, detail: undefined, finishedAt: undefined };
    case 'browser':
      return { ...run, browserId: event.id, browsers: { ...run.browsers, [event.id]: { ...run.browsers[event.id] } }, ...(event.profile ? { profile: event.profile } : {}) };
    case 'browserStopped':
      return { ...run, browsers: { ...run.browsers, [event.id]: { ...run.browsers[event.id], ...event.use, stopped: true } } };
    case 'agentRun':
      return event.followUp ? { ...run, followUpId: event.runId, sessionId: event.sessionId } : { ...run, runId: event.runId, sessionId: event.sessionId };
    case 'runCost':
      return { ...run, runs: { ...run.runs, [event.runId]: event.usd } };
    case 'storeSet':
      return { ...run, storeSet: event.how, ...(event.linkMs !== undefined ? { setupLinkMs: event.linkMs } : {}) };
    case 'term':
      return { ...run, results: [...run.results.filter((r) => r.term !== event.result.term), event.result] };
    case 'bytes':
      return {
        ...run,
        bytes: event.bytes,
        ...(event.wireBytes !== undefined ? { wireBytes: event.wireBytes } : {}),
        ...(event.linkMs !== undefined ? { linkMs: event.linkMs } : {}),
        ...(event.rttMs !== undefined ? { rttMs: event.rttMs } : {}),
        ...(event.commands !== undefined ? { commands: event.commands } : {}),
      };
    case 'checkSeen':
      return { ...run, checkSeen: true };
    case 'finish':
      return { ...run, status: event.status, reason: event.reason, detail: event.detail, finishedAt: event.at };
    case 'interrupt':
      return { ...run, status: 'interrupted', reason: event.reason, detail: event.detail, finishedAt: event.at };
    case 'cancel':
      return { ...run, status: 'cancelled', reason: 'cancelled', finishedAt: event.at };
    case 'retry':
      // A fresh start: its old results go, while the browsers and runs it used stay, to be stopped and counted.
      return {
        ...run,
        status: 'queued',
        reason: undefined,
        detail: undefined,
        results: [],
        storeSet: undefined,
        browserId: undefined,
        runId: undefined,
        followUpId: undefined,
        sessionId: undefined,
        checkSeen: undefined,
        profile: undefined,
        bytes: undefined,
        wireBytes: undefined,
        linkMs: undefined,
        setupLinkMs: undefined,
        rttMs: undefined,
        commands: undefined,
        finishedAt: undefined,
      };
  }
}

/** The job with one retailer's event applied (the same job when nothing changed). */
export function applyToJob(job: CloudJob, retailerId: CloudRetailerId, event: RunEvent): CloudJob {
  let changed = false;
  const retailers = job.retailers.map((r) => {
    if (r.retailerId !== retailerId) return r;
    const next = transition(r, event);
    changed ||= next !== r;
    return next;
  });
  if (!changed) return job;
  const settled = retailers.every((r) => SETTLED.has(r.status));
  // Settled when its last retailer did; a retry opens it again.
  const last = Math.max(...retailers.map((r) => r.finishedAt ?? 0));
  return { ...job, retailers, finishedAt: settled ? (job.finishedAt ?? last) : undefined };
}

export type JobStatus = 'running' | 'done' | 'interrupted' | 'cancelled';

/**
 * Running while any retailer is queued or running; else interrupted if one was; else cancelled if the user stopped it
 * (Cancel stops the whole job, so any retailer cancelled means that); else done.
 */
export function jobStatus(job: CloudJob): JobStatus {
  if (job.retailers.some((r) => r.status === 'queued' || r.status === 'running')) return 'running';
  if (job.retailers.some((r) => r.status === 'interrupted')) return 'interrupted';
  if (job.retailers.some((r) => r.status === 'cancelled')) return 'cancelled';
  return 'done';
}

export const runningJobs = (jobs: CloudJob[]): CloudJob[] => jobs.filter((j) => jobStatus(j) === 'running');

/** Jobs running that use the cloud: what the running-jobs guardrail counts (this phone's own searches cost nothing). */
export const runningCloudJobs = (jobs: CloudJob[]): CloudJob[] => runningJobs(jobs).filter((j) => needsCloud(j));

/** A retailer's cost so far, in dollars: its browsers' proxy and hosting charges, and its agent runs. */
export function retailerCost(run: RetailerRun): { usd: number; proxyMb: number } {
  let usd = 0;
  let proxyMb = 0;
  for (const b of Object.values(run.browsers)) {
    usd += (b.proxyUsd ?? 0) + (b.browserUsd ?? 0);
    proxyMb += b.proxyMb ?? 0;
  }
  for (const c of Object.values(run.runs)) usd += c;
  return { usd: micro(usd), proxyMb: micro(proxyMb) };
}

/** Sums of money and megabytes, without floating-point dust: to a millionth. */
const micro = (n: number) => Math.round(n * 1e6) / 1e6;

export function jobCost(job: CloudJob): { usd: number; proxyMb: number } {
  return job.retailers.reduce(
    (sum, r) => {
      const c = retailerCost(r);
      return { usd: micro(sum.usd + c.usd), proxyMb: micro(sum.proxyMb + c.proxyMb) };
    },
    { usd: 0, proxyMb: 0 },
  );
}

/** The browsers a job used that the API hasn't confirmed stopped: they're stopped again when the app opens. */
export function unstoppedBrowsers(jobs: CloudJob[]): { jobId: string; retailerId: CloudRetailerId; browserId: string }[] {
  return jobs.flatMap((j) =>
    j.retailers.flatMap((r) => Object.entries(r.browsers).filter(([, b]) => !b.stopped).map(([browserId]) => ({ jobId: j.id, retailerId: r.retailerId, browserId }))),
  );
}

/**
 * Whether a retailer's prices can be called its store's: the store was set (or the agent said so) and every search
 * that came back said it was for that store.
 */
export function storeConfirmed(run: RetailerRun): boolean {
  const searched = run.results.filter((r) => r.status === 'done');
  if (!searched.length) return false;
  const pagesAgree = searched.every((r) => r.storeMatches === true);
  if (run.via === 'device') return pagesAgree;
  return !!run.storeSet && pagesAgree;
}

// --- Asking for a job ------------------------------------------------------------------------------------

export interface JobRequest {
  engine: Engine;
  terms: string[];
  retailers: { retailerId: CloudRetailerId; storeId: string; via: Via }[];
  from?: CloudJob['from'];
}

/** Search terms as typed (a line or a comma each), tidied: no blanks, no repeats. The job's cap is checked apart. */
export function cleanTerms(raw: string | string[]): string[] {
  const parts = Array.isArray(raw) ? raw : raw.split(/[\n,]/);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of parts) {
    const t = p.trim().replace(/\s+/g, ' ');
    const key = t.toLowerCase();
    if (!t || seen.has(key)) continue;
    seen.add(key);
    out.push(t.slice(0, 80));
  }
  return out;
}

export type RequestProblem =
  | { problem: 'no_terms' }
  | { problem: 'too_many_terms'; count: number }
  | { problem: 'no_retailers' }
  | { problem: 'same_retailer_twice'; retailerId: CloudRetailerId }
  | { problem: 'no_store'; retailerId: CloudRetailerId }
  | { problem: 'too_many_jobs'; running: number }
  | { problem: 'no_key' }
  | { problem: 'balance_unknown'; detail?: string }
  | { problem: 'low_balance'; balanceUsd: number };

/** Whether any of the job's retailers is read in the cloud, so Browser Use's credit and key matter. */
export const needsCloud = (req: Pick<JobRequest, 'retailers'>): boolean => req.retailers.some((r) => r.via !== 'device');

/**
 * The guardrails, checked before a job starts: 1 to MAX_TERMS terms; one store per retailer, each with its store
 * number; fewer than MAX_RUNNING_JOBS jobs using the cloud running; and, for a job that uses the cloud, a key and at
 * least MIN_BALANCE_USD of credit, just read from the account (unknown credit refuses too).
 */
export function checkRequest(
  req: JobRequest,
  ctx: { jobs: CloudJob[]; hasKey: boolean; balanceUsd?: number; balanceError?: string },
): { ok: true } | ({ ok: false } & RequestProblem) {
  if (!req.terms.length) return { ok: false, problem: 'no_terms' };
  if (req.terms.length > MAX_TERMS) return { ok: false, problem: 'too_many_terms', count: req.terms.length };
  if (!req.retailers.length) return { ok: false, problem: 'no_retailers' };
  const seen = new Set<string>();
  for (const r of req.retailers) {
    if (seen.has(r.retailerId)) return { ok: false, problem: 'same_retailer_twice', retailerId: r.retailerId };
    seen.add(r.retailerId);
    if (!r.storeId.trim()) return { ok: false, problem: 'no_store', retailerId: r.retailerId };
  }
  if (needsCloud(req)) {
    const running = runningCloudJobs(ctx.jobs).length;
    if (running >= MAX_RUNNING_JOBS) return { ok: false, problem: 'too_many_jobs', running };
    if (!ctx.hasKey) return { ok: false, problem: 'no_key' };
    if (ctx.balanceUsd === undefined) return { ok: false, problem: 'balance_unknown', ...(ctx.balanceError ? { detail: ctx.balanceError } : {}) };
    if (ctx.balanceUsd < MIN_BALANCE_USD) return { ok: false, problem: 'low_balance', balanceUsd: ctx.balanceUsd };
  }
  return { ok: true };
}

/** A new job: every retailer queued, none started. */
export function newJob(req: JobRequest, id: string, at: number): CloudJob {
  return {
    id,
    engine: req.engine,
    terms: req.terms,
    createdAt: at,
    ...(req.from ? { from: req.from } : {}),
    retailers: req.retailers.map((r) => ({
      retailerId: r.retailerId,
      storeId: r.storeId.trim(),
      via: r.via,
      status: 'queued',
      browsers: {},
      runs: {},
      results: [],
      attempts: 0,
    })),
  };
}

/** Saved jobs, keeping only well-formed ones (a save from an older version, or a broken one, is dropped). */
export function readJobs(raw: string | null): CloudJob[] {
  if (!raw) return [];
  try {
    const saved: unknown = JSON.parse(raw);
    const jobs = typeof saved === 'object' && saved !== null && Array.isArray((saved as { jobs?: unknown }).jobs) ? (saved as { jobs: unknown[] }).jobs : [];
    return jobs.filter(isJob);
  } catch {
    return [];
  }
}

function isJob(v: unknown): v is CloudJob {
  if (typeof v !== 'object' || v === null) return false;
  const j = v as Partial<CloudJob>;
  return (
    typeof j.id === 'string' &&
    (j.engine === 'scripted' || j.engine === 'agent') &&
    Array.isArray(j.terms) &&
    typeof j.createdAt === 'number' &&
    Array.isArray(j.retailers) &&
    (j.compare === undefined || (typeof j.compare === 'object' && j.compare !== null && typeof j.compare.id === 'string' && ['phone', 'scripted', 'agent'].includes(j.compare.side))) &&
    j.retailers.every(
      (r) =>
        typeof r === 'object' &&
        r !== null &&
        CLOUD_RETAILERS.includes(r.retailerId) &&
        typeof r.storeId === 'string' &&
        typeof r.status === 'string' &&
        Array.isArray(r.results) &&
        typeof r.browsers === 'object' &&
        typeof r.runs === 'object',
    )
  );
}
