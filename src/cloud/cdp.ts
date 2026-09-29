import { NAV_TIMEOUT_MS } from './config';

// Pure TypeScript: a minimal Chrome DevTools Protocol client, for driving a Browser Use cloud browser from the phone.
// Playwright can't run in React Native, but the protocol is JSON over a WebSocket, which React Native has (and Node,
// for the scripts and tests). Only what the scripted engine needs: attach to the browser's own page, navigate and wait
// for it, run a script, click with the mouse, read cookies, block heavy files, and watch the page's requests.
//
// The browser's existing page is used, in its existing context: a new context would throw away the fingerprint and
// proxy setup Browser Use manages for it.

/** The bits of a WebSocket this uses: React Native's, the browser's and Node's all have them. */
export interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onclose: ((ev: unknown) => void) | null;
}
export type SocketFactory = (url: string) => SocketLike;
export type JsonFetch = (url: string) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

const OPEN = 1;

/** The protocol answered a command with an error. */
export class CdpError extends Error {
  constructor(
    readonly method: string,
    message: string,
  ) {
    super(`${method}: ${message}`);
    this.name = 'CdpError';
  }
}

/** The connection to the browser is gone: the phone slept, the network dropped, or the browser stopped. */
export class CdpClosed extends Error {
  constructor(why: string) {
    super(`connection closed: ${why}`);
    this.name = 'CdpClosed';
  }
}

/** A command or a wait took too long. */
export class CdpTimeout extends Error {
  constructor(what: string, ms: number) {
    super(`${what} timed out after ${Math.round(ms / 1000)} s`);
    this.name = 'CdpTimeout';
  }
}

export interface CdpEvent {
  method: string;
  params: Record<string, unknown>;
  sessionId?: string;
}

interface Pending {
  method: string;
  resolve: (value: Record<string, unknown>) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** One WebSocket to the browser: numbered commands and their answers, and the events in between. */
export class CdpConnection {
  /** Characters sent and received over the WebSocket: about the bytes this phone moves to drive the browser. */
  wireBytes = 0;
  private seq = 0;
  private pending = new Map<number, Pending>();
  private listeners = new Set<(event: CdpEvent) => void>();
  private closed: string | null = null;

  private constructor(private readonly socket: SocketLike) {
    socket.onmessage = (ev) => {
      const raw = typeof ev.data === 'string' ? ev.data : String(ev.data);
      this.wireBytes += raw.length;
      this.receive(raw);
    };
    socket.onclose = () => this.fail('the socket closed');
    socket.onerror = () => this.fail('the socket failed');
  }

  /** Opens the browser's WebSocket (see browserSocketUrl). */
  static open(url: string, factory: SocketFactory = defaultSocket, timeoutMs = 15_000): Promise<CdpConnection> {
    return new Promise((resolve, reject) => {
      let socket: SocketLike;
      try {
        socket = factory(url);
      } catch (e) {
        reject(new CdpClosed(e instanceof Error ? e.message : 'could not open'));
        return;
      }
      const timer = setTimeout(() => {
        socket.onopen = socket.onerror = socket.onclose = null;
        try {
          socket.close();
        } catch {
          // Closing a socket that never opened.
        }
        reject(new CdpTimeout('connecting to the browser', timeoutMs));
      }, timeoutMs);
      socket.onopen = () => {
        clearTimeout(timer);
        resolve(new CdpConnection(socket));
      };
      socket.onerror = socket.onclose = () => {
        clearTimeout(timer);
        reject(new CdpClosed('the browser refused the connection'));
      };
    });
  }

  /** Still connected, as far as the socket knows (see PageSession.alive for a real check). */
  get open(): boolean {
    return !this.closed && this.socket.readyState === OPEN;
  }

  send<T extends Record<string, unknown> = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs = 30_000): Promise<T> {
    if (!this.open) return Promise.reject(new CdpClosed(this.closed ?? 'not open'));
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CdpTimeout(method, timeoutMs));
      }, timeoutMs);
      this.pending.set(id, { method, resolve: resolve as (v: Record<string, unknown>) => void, reject, timer });
      try {
        const message = JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) });
        this.wireBytes += message.length;
        this.socket.send(message);
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new CdpClosed(e instanceof Error ? e.message : 'send failed'));
      }
    });
  }

  onEvent(listener: (event: CdpEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Closes the WebSocket. This doesn't stop the cloud browser: its API does (see BrowserUseApi.stopBrowser). */
  close(): void {
    this.fail('closed by the app');
    try {
      this.socket.close();
    } catch {
      // Already closed.
    }
  }

  private receive(raw: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (!isObj(msg)) return;
    if (typeof msg.id === 'number') {
      const waiting = this.pending.get(msg.id);
      if (!waiting) return;
      this.pending.delete(msg.id);
      clearTimeout(waiting.timer);
      if (isObj(msg.error)) waiting.reject(new CdpError(waiting.method, String(msg.error.message ?? 'error')));
      else waiting.resolve(isObj(msg.result) ? msg.result : {});
      return;
    }
    if (typeof msg.method === 'string') {
      const event: CdpEvent = { method: msg.method, params: isObj(msg.params) ? msg.params : {}, ...(typeof msg.sessionId === 'string' ? { sessionId: msg.sessionId } : {}) };
      this.listeners.forEach((listener) => listener(event));
    }
  }

  private fail(why: string): void {
    if (this.closed) return;
    this.closed = why;
    for (const [id, waiting] of this.pending) {
      clearTimeout(waiting.timer);
      waiting.reject(new CdpClosed(why));
      this.pending.delete(id);
    }
  }
}

const defaultSocket: SocketFactory = (url) => new WebSocket(url) as unknown as SocketLike;

const LOCAL_HOST = /^(?:127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\])(?::\d+)?$/i;

/**
 * `{cdpUrl}/json/version`, where the browser says its own WebSocket address. The query (a token, say) is kept; a
 * WebSocket address of the browser itself (…/devtools/browser/…) asks at its host's root.
 */
export function versionUrl(cdpUrl: string): string {
  const at = cdpUrl.indexOf('?');
  let base = (at === -1 ? cdpUrl : cdpUrl.slice(0, at)).replace(/^ws(s?):/i, 'http$1:').replace(/\/+$/, '');
  base = base.replace(/^([a-z]+:\/\/[^/]+)\/devtools\/.*$/i, '$1');
  return `${base}/json/version${at === -1 ? '' : cdpUrl.slice(at)}`;
}

const hostOf = (url: string) => /^[a-z]+:\/\/([^/?#]+)/i.exec(url)?.[1] ?? '';

/**
 * The browser's WebSocket address from its /json/version answer. A browser behind a proxy may report the address it
 * listens on inside its machine (127.0.0.1): then its path goes on the address the API gave, over TLS when that was.
 */
export function browserSocketUrl(cdpUrl: string, version: unknown): string {
  const ws = isObj(version) && typeof version.webSocketDebuggerUrl === 'string' ? version.webSocketDebuggerUrl : '';
  if (!ws) throw new CdpError('/json/version', 'no webSocketDebuggerUrl');
  const given = hostOf(cdpUrl);
  if (!LOCAL_HOST.test(hostOf(ws)) || LOCAL_HOST.test(given)) return ws;
  const secure = /^(https|wss):/i.test(cdpUrl);
  const path = ws.replace(/^[a-z]+:\/\/[^/?#]+/i, '');
  const query = cdpUrl.includes('?') && !path.includes('?') ? cdpUrl.slice(cdpUrl.indexOf('?')) : '';
  return `${secure ? 'wss' : 'ws'}://${given}${path}${query}`;
}

/**
 * Where to open the browser's WebSocket: asked of {cdpUrl}/json/version. A cdpUrl that is a WebSocket address already
 * is used as it is when /json/version doesn't answer.
 */
export async function resolveSocketUrl(cdpUrl: string, fetchJson: JsonFetch): Promise<string> {
  try {
    const res = await fetchJson(versionUrl(cdpUrl));
    if (!res.ok) throw new CdpError('/json/version', `HTTP ${res.status}`);
    return browserSocketUrl(cdpUrl, JSON.parse(await res.text()));
  } catch (e) {
    if (/^wss?:/i.test(cdpUrl)) return cdpUrl;
    throw e instanceof Error ? e : new CdpError('/json/version', 'failed');
  }
}

/** A request the page made, as the Network domain reported it. */
export interface SeenRequest {
  requestId: string;
  url: string;
  method: string;
  headers: Record<string, string>;
  postData?: string;
  status?: number;
  finished?: boolean;
  failed?: string;
}

export interface Cookie {
  name: string;
  value: string;
  domain?: string;
}

/**
 * The browser's page, attached with its own session (flattened: its commands carry the session's id). Meters the data
 * its requests move, and keeps the requests whose address `watch` accepts.
 */
export class PageSession {
  /** Bytes the page's requests moved over the network (encodedDataLength), blocked files excluded. */
  bytes = 0;
  readonly requests: SeenRequest[] = [];
  private watch: ((url: string) => boolean) | null = null;
  private world: { contextId: number; loaderId?: string } | null = null;
  private frameId: string | null = null;
  private loaderId: string | undefined;
  private off: () => void;

  constructor(
    readonly conn: CdpConnection,
    readonly sessionId: string,
  ) {
    this.off = conn.onEvent((e) => {
      if (e.sessionId !== sessionId) return;
      this.note(e);
    });
  }

  send<T extends Record<string, unknown> = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<T> {
    return this.conn.send<T>(method, params, this.sessionId, timeoutMs);
  }

  /** About the data this phone moved driving the browser: the DevTools connection's messages, both ways. */
  get wireBytes(): number {
    return this.conn.wireBytes;
  }

  /** This page's events of one kind. */
  on(method: string, listener: (params: Record<string, unknown>) => void): () => void {
    return this.conn.onEvent((e) => {
      if (e.sessionId === this.sessionId && e.method === method) listener(e.params);
    });
  }

  /** Page and network events on, and heavy files blocked by pattern (never by host, never by interception). */
  async prepare(blocked: string[]): Promise<{ blocking: boolean }> {
    await this.send('Page.enable');
    await this.send('Page.setLifecycleEventsEnabled', { enabled: true });
    await this.send('Network.enable');
    let blocking = false;
    if (blocked.length) {
      try {
        await this.send('Network.setBlockedURLs', { urls: blocked });
        blocking = true;
      } catch {
        // An older or newer browser may not take it: the job goes on, moving more data.
      }
    }
    const tree = await this.send<{ frameTree?: { frame?: { id?: string } } }>('Page.getFrameTree');
    this.frameId = tree.frameTree?.frame?.id ?? null;
    return { blocking };
  }

  /** Keeps the requests (and their answers) whose address this accepts, from now on. */
  watchRequests(accept: (url: string) => boolean): void {
    this.watch = accept;
  }

  /**
   * Goes to `url` as a real navigation and waits for its DOMContentLoaded (or load), for this navigation and not an
   * earlier one. Rejects on a network error; an HTTP error page counts as loaded (a block page is one).
   */
  async navigate(url: string, until: 'DOMContentLoaded' | 'load' = 'DOMContentLoaded', timeoutMs = NAV_TIMEOUT_MS): Promise<void> {
    const seen: { loaderId?: string; frameId?: string; name?: string }[] = [];
    let wake: (() => void) | null = null;
    const off = this.on('Page.lifecycleEvent', (p) => {
      seen.push({ loaderId: p.loaderId as string, frameId: p.frameId as string, name: p.name as string });
      wake?.();
    });
    try {
      const res = await this.send<{ frameId?: string; loaderId?: string; errorText?: string }>('Page.navigate', { url }, timeoutMs);
      if (res.errorText) throw new CdpError('Page.navigate', res.errorText);
      const frame = res.frameId ?? this.frameId;
      this.frameId = frame ?? this.frameId;
      this.loaderId = res.loaderId;
      this.world = null;
      const deadline = Date.now() + timeoutMs;
      const done = () => seen.some((e) => e.name === until && (!res.loaderId || e.loaderId === res.loaderId) && (!frame || e.frameId === frame));
      while (!done()) {
        if (!this.conn.open) throw new CdpClosed('while the page loaded');
        if (Date.now() > deadline) throw new CdpTimeout(`loading ${url.split('?')[0]}`, timeoutMs);
        await new Promise<void>((resolve) => {
          wake = resolve;
          setTimeout(resolve, 250);
        });
      }
    } finally {
      wake = null;
      off();
    }
  }

  /**
   * Runs `expression` and returns its value (awaited when it's a promise). 'isolated' runs it in a world of the app's
   * own, beside the page's scripts, which can't see it or change what it reads; 'main' runs it among them, where the
   * page's own fetch() lives.
   */
  async evaluate<T>(expression: string, opts: { world?: 'isolated' | 'main'; timeoutMs?: number } = {}): Promise<T> {
    const timeoutMs = opts.timeoutMs ?? 30_000;
    // Twice at most: a world the page moved on from (a redirect, a reload) is made again once.
    for (let attempt = 0; ; attempt++) {
      const contextId = opts.world === 'main' ? undefined : await this.isolatedWorld();
      let res: { result?: { value?: unknown }; exceptionDetails?: { text?: string; exception?: { description?: string } } };
      try {
        res = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, ...(contextId !== undefined ? { contextId } : {}) }, timeoutMs);
      } catch (e) {
        if (attempt === 0 && contextId !== undefined && e instanceof CdpError && /context/i.test(e.message)) {
          this.world = null;
          continue;
        }
        throw e;
      }
      if (res.exceptionDetails) {
        const why = res.exceptionDetails.exception?.description ?? res.exceptionDetails.text ?? 'script error';
        if (/context/i.test(why)) this.world = null;
        throw new CdpError('Runtime.evaluate', why.split('\n')[0]);
      }
      return res.result?.value as T;
    }
  }

  /** A press of the left mouse button at (x, y), in the page's CSS pixels: moved there, pressed, released. */
  async click(x: number, y: number): Promise<void> {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
  }

  /** The cookies the browser would send to these addresses. */
  async cookies(urls: string[]): Promise<Cookie[]> {
    const res = await this.send<{ cookies?: Cookie[] }>('Network.getCookies', { urls });
    return Array.isArray(res.cookies) ? res.cookies : [];
  }

  /** A watched request's answer, as text. */
  async responseBody(requestId: string): Promise<string> {
    const res = await this.send<{ body?: string; base64Encoded?: boolean }>('Network.getResponseBody', { requestId });
    const body = res.body ?? '';
    return res.base64Encoded ? decodeBase64(body) : body;
  }

  /** Whether the browser still answers, within `timeoutMs`: after the phone slept, the socket may be gone. */
  async alive(timeoutMs = 5_000): Promise<boolean> {
    if (!this.conn.open) return false;
    try {
      await this.send('Runtime.evaluate', { expression: '1', returnByValue: true }, timeoutMs);
      return true;
    } catch {
      return false;
    }
  }

  detach(): void {
    this.off();
  }

  /** Lets go of the page and closes the WebSocket. The cloud browser keeps running until its API stops it. */
  close(): void {
    this.off();
    this.conn.close();
  }

  /** A world of the app's own in the page's main frame, made once per navigation. */
  private async isolatedWorld(): Promise<number | undefined> {
    if (this.world && this.world.loaderId === this.loaderId) return this.world.contextId;
    if (!this.frameId) return undefined;
    try {
      const res = await this.send<{ executionContextId?: number }>('Page.createIsolatedWorld', { frameId: this.frameId, worldName: 'stretch', grantUniveralAccess: false });
      if (typeof res.executionContextId !== 'number') return undefined;
      this.world = { contextId: res.executionContextId, loaderId: this.loaderId };
      return res.executionContextId;
    } catch {
      return undefined;
    }
  }

  private note(e: CdpEvent): void {
    const p = e.params;
    if (e.method === 'Page.frameNavigated') {
      // The page went somewhere by itself (a redirect, a reload): its old world went with its old document.
      const frame = isObj(p.frame) ? p.frame : {};
      if (!frame.parentId && (!this.frameId || frame.id === this.frameId)) {
        this.loaderId = typeof frame.loaderId === 'string' ? frame.loaderId : this.loaderId;
        this.world = null;
      }
      return;
    }
    if (e.method === 'Network.loadingFinished') {
      const n = typeof p.encodedDataLength === 'number' ? p.encodedDataLength : 0;
      this.bytes += n;
      const r = this.requests.find((q) => q.requestId === p.requestId);
      if (r) r.finished = true;
    } else if (e.method === 'Network.requestWillBeSent' && this.watch) {
      const req = isObj(p.request) ? p.request : {};
      const url = typeof req.url === 'string' ? req.url : '';
      if (!url || !this.watch(url)) return;
      this.requests.push({
        requestId: String(p.requestId),
        url,
        method: typeof req.method === 'string' ? req.method : 'GET',
        headers: isObj(req.headers) ? Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), String(v)])) : {},
        ...(typeof req.postData === 'string' ? { postData: req.postData } : {}),
      });
    } else if (e.method === 'Network.responseReceived') {
      const r = this.requests.find((q) => q.requestId === p.requestId);
      const res = isObj(p.response) ? p.response : {};
      if (r && typeof res.status === 'number') r.status = res.status;
    } else if (e.method === 'Network.loadingFailed') {
      const r = this.requests.find((q) => q.requestId === p.requestId);
      if (r) r.failed = String(p.errorText ?? 'failed');
    }
  }
}

/** Base64 to text (UTF-8), without Buffer or atob, which React Native may lack. */
export function decodeBase64(b64: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const clean = b64.replace(/[^A-Za-z0-9+/]/g, '');
  const bytes: number[] = [];
  for (let i = 0; i < clean.length; i += 4) {
    const n = [0, 1, 2, 3].map((k) => (i + k < clean.length ? alphabet.indexOf(clean[i + k]) : -1));
    bytes.push((n[0] << 2) | (n[1] >> 4));
    if (n[2] >= 0) bytes.push(((n[1] & 15) << 4) | (n[2] >> 2));
    if (n[3] >= 0) bytes.push(((n[2] & 3) << 6) | n[3]);
  }
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b < 0x80) out += String.fromCharCode(b);
    else if (b >= 0xc0 && b < 0xe0) out += String.fromCharCode(((b & 31) << 6) | (bytes[++i] & 63));
    else if (b >= 0xe0 && b < 0xf0) out += String.fromCharCode(((b & 15) << 12) | ((bytes[++i] & 63) << 6) | (bytes[++i] & 63));
    else {
      const cp = ((b & 7) << 18) | ((bytes[++i] & 63) << 12) | ((bytes[++i] & 63) << 6) | (bytes[++i] & 63);
      out += String.fromCodePoint(cp);
    }
  }
  return out;
}

/**
 * Connects to a cloud browser and attaches to the page it already has (Target.attachToTarget, flattened). Only when it
 * has none is one opened, in the browser's own context, never a new one.
 */
export async function connectToPage(cdpUrl: string, deps: { fetchJson: JsonFetch; socket?: SocketFactory }): Promise<PageSession> {
  const url = await resolveSocketUrl(cdpUrl, deps.fetchJson);
  const conn = await CdpConnection.open(url, deps.socket);
  try {
    const { targetInfos } = await conn.send<{ targetInfos?: { targetId: string; type: string; url: string }[] }>('Target.getTargets');
    const pages = (targetInfos ?? []).filter((t) => t.type === 'page' && !t.url.startsWith('devtools://') && !t.url.startsWith('chrome-extension://'));
    let targetId = pages[0]?.targetId;
    if (!targetId) targetId = (await conn.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' })).targetId;
    const { sessionId } = await conn.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
    return new PageSession(conn, sessionId);
  } catch (e) {
    conn.close();
    throw e;
  }
}
