import { API_V4, BILLING_URL, BROWSER_LABEL, BROWSER_TIMEOUT_MIN } from './config';

// Pure TypeScript: Browser Use's REST API, as far as cloud fetch uses it (checked against docs.browser-use.com,
// 2026-09-28). The key goes in X-Browser-Use-API-Key, with no "Bearer". `fetch` is passed in, so the tests run it in
// Node against saved answers.

export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

/** A cloud browser as the API describes it. Money and data come as decimal strings; they're numbers here. */
export interface CloudBrowser {
  id: string;
  status: 'active' | 'stopped';
  /** Where to connect with the DevTools protocol (see cdp.ts). */
  cdpUrl?: string;
  liveUrl?: string;
  startedAt?: string;
  finishedAt?: string;
  proxyUsedMb: number;
  proxyCost: number;
  browserCost: number;
}

export type RunStatus = 'queued' | 'dispatching' | 'running' | 'completed' | 'failed' | 'cancelled';
export const TERMINAL_RUN: ReadonlySet<RunStatus> = new Set(['completed', 'failed', 'cancelled']);

/** An agent run (API v4). `result` is the agent's final answer, as text. */
export interface AgentRun {
  id: string;
  status: RunStatus;
  sessionId: string;
  result?: string;
  /** Some runs carry their answer already parsed. */
  output?: unknown;
  error?: string;
  costUsd?: number;
}

export interface Account {
  balanceUsd: number;
  activeSessions?: number;
  sessionLimit?: number;
}

/** The API refused or failed a request: its HTTP status, and what it said (never the key). */
export class BrowserUseError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
    readonly path: string,
  ) {
    super(`Browser Use ${path}: HTTP ${status}${detail ? ` (${detail})` : ''}`);
    this.name = 'BrowserUseError';
  }
}

const TIMEOUT_MS = 30_000;

const dollars = (v: unknown): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : 0;
};
const text = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function toBrowser(json: unknown): CloudBrowser {
  const o = isObj(json) ? json : {};
  return {
    id: String(o.id ?? ''),
    status: o.status === 'stopped' ? 'stopped' : 'active',
    cdpUrl: text(o.cdpUrl),
    liveUrl: text(o.liveUrl),
    startedAt: text(o.startedAt),
    finishedAt: text(o.finishedAt),
    proxyUsedMb: dollars(o.proxyUsedMb),
    proxyCost: dollars(o.proxyCost),
    browserCost: dollars(o.browserCost),
  };
}

export function toRun(json: unknown): AgentRun {
  const o = isObj(json) ? json : {};
  const status = String(o.status ?? 'queued') as RunStatus;
  return {
    id: String(o.id ?? ''),
    status,
    sessionId: String(o.sessionId ?? ''),
    result: text(o.result),
    ...(o.output !== undefined && o.output !== null ? { output: o.output } : {}),
    error: text(o.error),
    ...(o.totalCostUsd !== undefined ? { costUsd: dollars(o.totalCostUsd) } : {}),
  };
}

/** What the API said went wrong, in a few words: FastAPI puts it in `detail`, as text or an object. */
function detailOf(body: string): string {
  try {
    const json: unknown = JSON.parse(body);
    const detail = isObj(json) ? json.detail : undefined;
    if (typeof detail === 'string') return detail.slice(0, 200);
    if (isObj(detail) && typeof detail.message === 'string') return detail.message.slice(0, 200);
    if (Array.isArray(detail)) return detail.map((d) => (isObj(d) ? String(d.msg ?? '') : '')).filter(Boolean).join('; ').slice(0, 200);
  } catch {
    // Not JSON.
  }
  return body.slice(0, 120);
}

export class BrowserUseApi {
  constructor(
    private readonly key: string,
    private readonly fetchFn: FetchLike = (url, init) => fetch(url, init),
  ) {}

  get configured(): boolean {
    return !!this.key;
  }

  private async call(method: string, url: string, body?: unknown): Promise<unknown> {
    if (!this.key) throw new BrowserUseError(0, 'no API key: set EXPO_PUBLIC_BROWSER_USE_API_KEY in .env', url);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const path = url.replace(/^https:\/\/api\.browser-use\.com\/api/, '').split('?')[0];
    try {
      const res = await this.fetchFn(url, {
        method,
        headers: { 'X-Browser-Use-API-Key': this.key, 'Content-Type': 'application/json', Accept: 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
      const raw = await res.text();
      if (!res.ok) throw new BrowserUseError(res.status, detailOf(raw), path);
      return raw ? JSON.parse(raw) : {};
    } catch (e) {
      if (e instanceof BrowserUseError) throw e;
      throw new BrowserUseError(0, controller.signal.aborted ? 'timed out' : e instanceof Error ? e.message : 'network error', path);
    } finally {
      clearTimeout(timer);
    }
  }

  /** The credit left (GET /api/v2/billing/account, which v4 keys use too), and how many browsers are running. */
  async account(): Promise<Account> {
    const json = await this.call('GET', BILLING_URL);
    const o = isObj(json) ? json : {};
    return {
      balanceUsd: dollars(o.totalCreditsBalanceUsd),
      ...(typeof o.activeSessionCount === 'number' ? { activeSessions: o.activeSessionCount } : {}),
      ...(typeof o.concurrentSessionLimit === 'number' ? { sessionLimit: o.concurrentSessionLimit } : {}),
    };
  }

  /**
   * A new cloud browser through a U.S. residential proxy, which Browser Use stops by itself after `timeoutMin`
   * minutes. Labeled, with its job, so the app can find it again (see BROWSER_LABEL).
   */
  async createBrowser(labels: Record<string, string> = {}, timeoutMin = BROWSER_TIMEOUT_MIN): Promise<CloudBrowser> {
    const json = await this.call('POST', `${API_V4}/browsers`, {
      proxyCountryCode: 'us',
      timeout: timeoutMin,
      metadata: { ...BROWSER_LABEL, ...labels },
    });
    return toBrowser(json);
  }

  /** Stops a browser. Closing the DevTools connection does not: this does, and ends its billing. */
  async stopBrowser(id: string): Promise<CloudBrowser> {
    return toBrowser(await this.call('PATCH', `${API_V4}/browsers/${encodeURIComponent(id)}`, { action: 'stop' }));
  }

  /** A browser's state, and what it cost: proxy data (MB), proxy and browser charges. */
  async getBrowser(id: string): Promise<CloudBrowser> {
    return toBrowser(await this.call('GET', `${API_V4}/browsers/${encodeURIComponent(id)}`));
  }

  /** Browsers still running, with the app's label (or an agent session's). */
  async activeBrowsers(opts: { label?: Record<string, string>; agentSessionId?: string } = {}): Promise<CloudBrowser[]> {
    const params = ['filterBy=active', 'pageSize=50'];
    for (const [k, v] of Object.entries(opts.label ?? {})) params.push(`metadata=${encodeURIComponent(`${k}=${v}`)}`);
    if (opts.agentSessionId) params.push(`agentSessionId=${encodeURIComponent(opts.agentSessionId)}`);
    const json = await this.call('GET', `${API_V4}/browsers?${params.join('&')}`);
    const items = isObj(json) && Array.isArray(json.items) ? json.items : [];
    return items.map(toBrowser).filter((b) => b.id && b.status === 'active');
  }

  /**
   * Starts an agent run. `sessionId` continues an earlier run's conversation (and reuses its browser, while it lives).
   * `maxCostUsd` is the run's own cost cap.
   */
  async createRun(req: { task: string; model: string; maxCostUsd?: number; sessionId?: string }): Promise<AgentRun> {
    const json = await this.call('POST', `${API_V4}/runs`, {
      task: req.task,
      model: req.model,
      ...(req.maxCostUsd ? { maxCostUsd: req.maxCostUsd } : {}),
      ...(req.sessionId ? { sessionId: req.sessionId } : {}),
    });
    return toRun(json);
  }

  /** A run's status alone: the cheap poll. */
  async runStatus(id: string): Promise<RunStatus> {
    const json = await this.call('GET', `${API_V4}/runs/${encodeURIComponent(id)}/status`);
    return String(isObj(json) ? json.status : 'queued') as RunStatus;
  }

  /** The whole run, with its answer: once it's over. */
  async getRun(id: string): Promise<AgentRun> {
    return toRun(await this.call('GET', `${API_V4}/runs/${encodeURIComponent(id)}`));
  }

  /** Stops a run: Browser Use bills nothing more for it. Harmless on a run that's over. */
  async cancelRun(id: string): Promise<void> {
    await this.call('POST', `${API_V4}/runs/${encodeURIComponent(id)}/cancel`, {});
  }
}
