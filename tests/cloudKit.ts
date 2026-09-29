/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BrowserUseApi, type FetchLike } from '../src/cloud/browserUse';
import { CdpClosed, type Cookie, type SeenRequest } from '../src/cloud/cdp';
import type { FlowContext } from '../src/cloud/flow';
import type { CloudJob, JobRequest, TermResult } from '../src/cloud/jobs';
import { PX_SNAPSHOT } from '../src/cloud/perimeterx';
import { CloudRunner, type LivePage, type RunnerDeps } from '../src/cloud/runner';
import { FIND_STORE_BUTTON, READ_SEARCH_DATA } from '../src/cloud/walmart';

// What the cloud tests share: a simulated Browser Use API, a simulated Walmart page, a runner on a fake clock, and the
// real search page's data (tests/fixtures/cloud). No live site, no credit.

export const walmartText = readFileSync(join(__dirname, 'fixtures', 'cloud', 'walmart-search-milk.json'), 'utf8');
/** The real search page's data, as another store's (its store number swapped). */
export const walmartFor = (store: string) => walmartText.split('"3081"').join(`"${store}"`);

export const tick = async (n = 40) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};
export function clock() {
  let now = 1_000_000;
  return { now: () => now, sleep: async (ms: number) => void (now += ms) };
}
export const memory = () => {
  const map = new Map<string, string>();
  return { map, getItem: async (k: string) => map.get(k) ?? null, setItem: async (k: string, v: string) => void map.set(k, v) };
};

/** A Walmart page as the flow sees it: a store page whose button sets the store, and search pages with its data. */
export class FakePage implements LivePage {
  bytes = 0;
  /** The DevTools link's traffic, when `wire` says how much each script run moves. */
  wireBytes?: number;
  readonly requests: SeenRequest[] = [];
  url = 'about:blank';
  cookie: string;
  closed = false;
  navigations: string[] = [];
  checks = 0;
  private partial: number;
  private hangs: ((e: Error) => void)[] = [];
  constructor(
    private opts: {
      store?: string;
      /** A bot check on pages whose address matches, while this says so. */
      px?: (url: string) => boolean;
      /** The store the search page's data is for (the cookie's, else). */
      dataStore?: (term: string) => string;
      partialReads?: number;
      mb?: number;
      hangAt?: string;
      failAt?: { at: string; error: Error };
      alive?: boolean;
      /** Bytes each script run moves between the phone and the browser. */
      wire?: number;
      /**
       * Started from a saved profile: its cookies (the store's, `store`) are there before any page loads. A fresh
       * browser has none until a Walmart page sets them.
       */
      profile?: boolean;
      /** What driving it from the phone adds, in ms: to each page load, and to each script run (see PageSession). */
      link?: { load: number; script: number };
    } = {},
  ) {
    this.cookie = opts.store ?? '3081';
    if (opts.wire) this.wireBytes = 0;
    if (opts.link) {
      this.linkMs = 0;
      this.rttMs = opts.link.script;
      this.commands = 0;
    }
    this.partial = opts.partialReads ?? 0;
  }
  linkMs?: number;
  rttMs?: number;
  commands?: number;
  private linked(ms: number) {
    if (this.linkMs === undefined) return;
    this.linkMs += ms;
    this.commands! += 1;
  }
  async prepare() {
    return { blocking: true };
  }
  async navigate(url: string) {
    if (this.closed) throw new CdpClosed('closed');
    this.navigations.push(url);
    if (this.opts.failAt && url.includes(this.opts.failAt.at)) throw this.opts.failAt.error;
    if (this.opts.hangAt && url.includes(this.opts.hangAt)) await new Promise((_, reject) => this.hangs.push(reject));
    this.url = url;
    this.bytes += (this.opts.mb ?? 2.6) * 1e6;
    this.linked(this.opts.link?.load ?? 0);
  }
  async evaluate<T>(expression: string): Promise<T> {
    if (this.closed) throw new CdpClosed('closed');
    if (this.wireBytes !== undefined) this.wireBytes += this.opts.wire ?? 0;
    this.linked(this.opts.link?.script ?? 0);
    if (expression === PX_SNAPSHOT) {
      this.checks++;
      return { url: this.url, title: 'Walmart', dialogs: this.opts.px?.(this.url) ? ['Robot or human? Activate and hold'] : [] } as T;
    }
    const store = /\/store\/(\d+)/.exec(this.url)?.[1];
    if (expression === FIND_STORE_BUTTON) return (store && store !== this.cookie ? { x: 100, y: 200 } : null) as T;
    if (expression === READ_SEARCH_DATA) {
      if (this.partial > 0) {
        this.partial--;
        return { state: 'partial' } as T;
      }
      const term = new URL(this.url).searchParams.get('q') ?? '';
      return { state: 'ok', text: walmartFor(this.opts.dataStore?.(term) ?? this.cookie) } as T;
    }
    throw new Error(`unexpected script: ${expression.slice(0, 40)}`);
  }
  async click() {
    const store = /\/store\/(\d+)/.exec(this.url)?.[1];
    if (store) this.cookie = store;
  }
  async cookies(): Promise<Cookie[]> {
    if (!this.navigations.length && !this.opts.profile) return [];
    return [{ name: 'assortmentStoreId', value: this.cookie }];
  }
  watchRequests() {}
  async responseBody() {
    return '';
  }
  async alive() {
    return !this.closed && this.opts.alive !== false;
  }
  close() {
    this.closed = true;
    this.hangs.splice(0).forEach((reject) => reject(new CdpClosed('closed by the app')));
  }
}

export function flowContext(results: TermResult[], c = clock(), extra: Partial<FlowContext> = {}) {
  const ctx = {
    set: [] as string[],
    seen: 0,
    ...c,
    stopped: () => false,
    onTerm: (r: TermResult) => void results.push(r),
    onStoreSet: (how: string) => void ctx.set.push(how),
    onCheck: () => void ctx.seen++,
    maxMb: 40,
    ...extra,
  };
  return ctx;
}

/** Browser Use's API as the runner uses it, simulated: browsers, agent runs and the account, with every call kept. */
export function fakeBrowserUse(
  init: {
    balance?: number | 'error';
    agent?: Record<string, { status?: string; result?: string; cost?: string; error?: string }[]>;
    active?: { id: string; label?: boolean; session?: string }[];
    failStop?: string[];
    /** Browser Use won't make a profile (its limit on them): HTTP 402. */
    profileLimit?: boolean;
    /** Profiles it doesn't have (deleted in its dashboard, say): a browser asked to start from one gets HTTP 404. */
    missingProfiles?: string[];
  } = {},
) {
  const calls: string[] = [];
  const stopped = new Set<string>();
  /** Each browser made, and the profile it started from. */
  const made: { id: string; profileId?: string }[] = [];
  let profiles = 0;
  const tasks: { task: string; sessionId?: string; maxCostUsd?: number; model: string }[] = [];
  let browsers = 0;
  let runs = 0;
  // Each run's answers, in the order they're polled: the last one stays.
  const script: Record<string, { status: string; result?: string; cost?: string; error?: string; sessionId: string }[]> = {};
  const fetchFn: FetchLike = async (url, req) => {
    const method = req?.method ?? 'GET';
    const path = url.replace(/^https:\/\/api\.browser-use\.com\/api/, '');
    calls.push(`${method} ${path}`);
    const ok = (body: unknown, status = 200) => ({ ok: status < 400, status, text: async () => JSON.stringify(body) });
    if (path === '/v2/billing/account') return init.balance === 'error' ? ok({ detail: 'down' }, 503) : ok({ totalCreditsBalanceUsd: init.balance ?? 12.5 });
    if (method === 'POST' && path === '/v4/browsers') {
      const body = JSON.parse(req!.body!);
      if (body.profileId && init.missingProfiles?.includes(body.profileId)) return ok({ detail: 'Profile not found' }, 404);
      browsers++;
      made.push({ id: `b${browsers}`, ...(body.profileId ? { profileId: body.profileId } : {}) });
      return ok({ id: `b${browsers}`, status: 'active', cdpUrl: `https://b${browsers}.cdp.example` }, 201);
    }
    if (method === 'POST' && path === '/v4/profiles') {
      if (init.profileLimit) return ok({ detail: 'Profile limit reached' }, 402);
      profiles++;
      return ok({ id: `p${profiles}`, name: JSON.parse(req!.body!).name, cookieDomains: [] }, 201);
    }
    if (method === 'DELETE' && path.startsWith('/v4/profiles/')) return { ok: true, status: 204, text: async () => '' };
    if (method === 'GET' && path.startsWith('/v4/browsers?')) {
      const q = new URL(url).searchParams;
      const items = (init.active ?? []).filter((b) => !stopped.has(b.id) && (q.get('agentSessionId') ? b.session === q.get('agentSessionId') : b.label));
      return ok({ items: items.map((b) => ({ id: b.id, status: 'active' })), totalItems: items.length, pageNumber: 1, pageSize: 50 });
    }
    const browser = /^\/v4\/browsers\/([^/?]+)$/.exec(path);
    if (browser && method === 'PATCH') {
      if (init.failStop?.includes(browser[1])) return ok({ detail: 'busy' }, 503);
      stopped.add(browser[1]);
      return ok({ id: browser[1], status: 'stopped' });
    }
    if (browser) return ok({ id: browser[1], status: stopped.has(browser[1]) ? 'stopped' : 'active', proxyUsedMb: '7.8', proxyCost: '0.039', browserCost: '0.0007' });
    if (method === 'POST' && path === '/v4/runs') {
      const body = JSON.parse(req!.body!);
      runs++;
      const id = `r${runs}`;
      tasks.push(body);
      const sessionId = body.sessionId ?? `s${runs}`;
      script[id] = (init.agent?.[id] ?? [{ status: 'completed', result: '{}' }]).map((a) => ({ status: a.status ?? 'completed', ...a, sessionId }));
      return ok({ id, status: 'queued', sessionId, model: body.model });
    }
    const status = /^\/v4\/runs\/([^/]+)\/status$/.exec(path);
    if (status) return ok({ status: (script[status[1]].length > 1 ? script[status[1]].shift()! : script[status[1]][0]).status });
    const run = /^\/v4\/runs\/([^/]+)$/.exec(path);
    if (run) {
      const a = script[run[1]][0];
      return ok({ id: run[1], status: a.status, sessionId: a.sessionId, result: a.result ?? null, error: a.error ?? null, totalCostUsd: a.cost ?? '0.10' });
    }
    if (/\/cancel$/.test(path)) return ok({});
    return ok({ detail: 'not found' }, 404);
  };
  return { fetchFn, calls, tasks, stopped, made };
}

export function makeRunner(api: ReturnType<typeof fakeBrowserUse>, pages: (cdpUrl: string) => FakePage, extra: Partial<RunnerDeps> = {}, key = 'bu_test') {
  const c = clock();
  const connected: string[] = [];
  const runner = new CloudRunner({
    api: new BrowserUseApi(key, api.fetchFn),
    connect: async (cdpUrl) => {
      connected.push(cdpUrl);
      return pages(cdpUrl);
    },
    deviceSearch: async (_id, term) => ({ items: [{ itemId: 'k1', name: `Kroger ${term}`, price: 2.49 }], found: 1, storeId: '01400943' }),
    now: c.now,
    sleep: c.sleep,
    costDelayMs: 0,
    pollMs: 5,
    ...extra,
  });
  const done: CloudJob[] = [];
  runner.onFinished((job) => void done.push(job));
  return { runner, done, connected, clock: c };
}

export const walmartJob = (terms = ['milk', 'eggs']): JobRequest => ({
  engine: 'scripted',
  terms,
  retailers: [
    { retailerId: 'walmart', storeId: '5260', via: 'browser' },
    { retailerId: 'kroger', storeId: '45202', via: 'device' },
  ],
});
