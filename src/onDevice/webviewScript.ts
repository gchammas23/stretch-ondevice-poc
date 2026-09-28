// Pure string builders for the hidden WebView: no React Native imports, so they can be tested in Node.

import { PAGE_BYTES, STORE_LABEL } from './pageHelpers';

// Store finder scripts, and the weekly ad and coupon ones, live beside this file: the app imports them from here.
export * from './listScripts';
export * from './storeScripts';

export const hostOf = (url: string) => /^https?:\/\/([^/?#:]+)/i.exec(url)?.[1]?.toLowerCase() ?? null;

/** Keeps top-frame navigation on the retailer's own domain, bot-check pages included. */
export function sameSite(url: string, jobUrl: string): boolean {
  if (url.startsWith('about:')) return true;
  const host = hostOf(url);
  const site = hostOf(jobUrl)?.replace(/^www\./, '');
  return !!host && !!site && (host === site || host.endsWith(`.${site}`));
}

/**
 * Signs of a page that refuses the phone outright, with nothing to answer: a block, not a bot check. Checked before
 * the bot-check signs, in the URL and title, and in the body of short pages. A search that gets one fails with
 * 'blocked' and is never shown, and the store cools down (see tuning.ts).
 */
export const BLOCK_MARKERS = [
  'Access Denied',
  'Request unsuccessful',
  'Sorry, you have been blocked',
  'Error 1020',
  'The requested URL was rejected',
  'You don’t have permission to access',
  "You don't have permission to access",
  '403 Forbidden',
];

/**
 * A bot check drawn in a frame of the page (reCAPTCHA's, hCaptcha's, DataDome's, Arkose's, GeeTest's, Cloudflare's,
 * HUMAN's), which the page's own address and title don't give away. Only a frame that shows counts: an invisible one
 * sits on many ordinary pages.
 */
export const CAPTCHA_FRAMES =
  /recaptcha\/(api2|enterprise)\/(anchor|bframe)|hcaptcha\.com\/captcha|captcha-delivery\.com|arkoselabs\.com|funcaptcha\.com|geetest\.com|challenges\.cloudflare\.com|px-cloud\.net|captcha\.px-cdn\.net/i;

/** Bot-check signs across common protection vendors. Phrases are checked in the URL and title; ids also in the body of short pages. */
export const DEFAULT_CHALLENGE_MARKERS = [
  'Robot or human',
  '/blocked?',
  'px-captcha',
  '_Incapsula_Resource',
  'Request unsuccessful',
  'Pardon Our Interruption',
  'captcha-delivery',
  'Access Denied',
  'Just a moment',
  'Attention Required',
];

/**
 * Runs before the page's own scripts and keeps copies of the JSON responses the page fetches for itself
 * (search results on most retailer sites arrive this way, after the HTML), with how each was requested, so a
 * later search can send the same request with another query. Reads only; changes nothing it returns.
 */
export function captureScript(): string {
  return `(function () {
  if (window.__stretchCapture) return;
  var store = { items: [], bytes: 0, priceKeys: 0, lastAt: 0 };
  window.__stretchCapture = store;
  var MAX_ITEMS = 40, MAX_BYTES = 5000000, MAX_ONE = 2500000, MAX_BODY = 20000;
  var PRICE_KEY = /"[A-Za-z_]*[Pp]rice[A-Za-z_]*"\\s*:/g;
  function absolute(url) {
    try { return new URL(String(url), location.href).href; } catch (e) { return String(url || ''); }
  }
  function copyHeaders(h, out) {
    try {
      if (!h) return;
      if (Array.isArray(h)) {
        for (var i = 0; i < h.length; i++) if (h[i] && h[i].length === 2) out[String(h[i][0]).toLowerCase()] = String(h[i][1]);
      } else if (typeof h.forEach === 'function') {
        h.forEach(function (v, k) { out[String(k).toLowerCase()] = String(v); });
      } else {
        for (var k in h) if (Object.prototype.hasOwnProperty.call(h, k)) out[k.toLowerCase()] = String(h[k]);
      }
    } catch (e) {}
  }
  function setBody(req, b) {
    if (b === undefined || b === null) return;
    if (typeof b === 'string') {
      if (b.length <= MAX_BODY) req.body = b; else req.opaqueBody = true;
    } else if (typeof URLSearchParams !== 'undefined' && b instanceof URLSearchParams) {
      req.body = String(b);
      if (!req.headers['content-type']) req.headers['content-type'] = 'application/x-www-form-urlencoded;charset=UTF-8';
    } else {
      req.opaqueBody = true;
    }
  }
  function describeFetch(input, init) {
    var isRequest = !!input && typeof input === 'object' && typeof input.url === 'string' && typeof input.method === 'string';
    var req = {
      method: String((init && init.method) || (isRequest && input.method) || 'GET').toUpperCase(),
      url: absolute(isRequest ? input.url : (input && input.href) || input),
      headers: {},
      credentials: (init && init.credentials) || (isRequest && input.credentials) || 'same-origin'
    };
    if (isRequest) copyHeaders(input.headers, req.headers);
    if (init) copyHeaders(init.headers, req.headers);
    // A Request's own body can only be read asynchronously, so such a request isn't replayable.
    if (init && init.body !== undefined) setBody(req, init.body);
    else if (isRequest && req.method !== 'GET' && req.method !== 'HEAD') req.opaqueBody = true;
    return req;
  }
  function keep(url, text, req) {
    if (typeof text !== 'string' || text.length < 2 || text.length > MAX_ONE) return;
    var c = text.replace(/^\\s+/, '').charAt(0);
    if (c !== '{' && c !== '[') return;
    var hits = text.match(PRICE_KEY);
    store.items.push({ url: String(url || '').slice(0, 300), text: text, req: req || null, priceKeys: hits ? hits.length : 0 });
    store.bytes += text.length;
    store.priceKeys += hits ? hits.length : 0;
    store.lastAt = Date.now();
    while (store.items.length > MAX_ITEMS || store.bytes > MAX_BYTES) {
      var old = store.items.shift();
      store.bytes -= old.text.length;
    }
    // A search waiting on prices hears of them now, not at its next look (see extractionScript).
    if (hits && typeof store.onPrices === 'function') {
      try { store.onPrices(); } catch (e) {}
    }
  }
  var nativeFetch = window.fetch;
  if (typeof nativeFetch === 'function') {
    // Replayed searches use the unhooked fetch, so their responses don't pile up here.
    store.fetch = nativeFetch;
    window.fetch = function (input, init) {
      var p = nativeFetch.apply(this, arguments);
      var url = typeof input === 'string' ? input : (input && (input.url || input.href)) || '';
      p.then(function (res) {
        try {
          var type = (res.headers && res.headers.get('content-type')) || '';
          if (type.indexOf('json') === -1) return;
          var req = null;
          try { req = describeFetch(input, init); } catch (e) {}
          res.clone().text().then(function (t) { keep(url, t, req); }, function () {});
        } catch (e) {}
      }, function () {});
      return p;
    };
  }
  var XHR = window.XMLHttpRequest;
  if (XHR && XHR.prototype) {
    var open = XHR.prototype.open, send = XHR.prototype.send, setHeader = XHR.prototype.setRequestHeader;
    XHR.prototype.open = function (method, url) {
      this.__stretchUrl = url;
      this.__stretchReq = { method: String(method || 'GET').toUpperCase(), url: absolute(url), headers: {}, credentials: 'same-origin' };
      return open.apply(this, arguments);
    };
    XHR.prototype.setRequestHeader = function (name, value) {
      try { if (this.__stretchReq) this.__stretchReq.headers[String(name).toLowerCase()] = String(value); } catch (e) {}
      return setHeader.apply(this, arguments);
    };
    XHR.prototype.send = function (body) {
      var xhr = this;
      try { if (xhr.__stretchReq) setBody(xhr.__stretchReq, body); } catch (e) {}
      xhr.addEventListener('load', function () {
        try {
          var type = xhr.getResponseHeader('content-type') || '';
          if (type.indexOf('json') === -1) return;
          var req = xhr.__stretchReq || null;
          if (req) req.credentials = xhr.withCredentials ? 'include' : 'same-origin';
          if (xhr.responseType === '' || xhr.responseType === 'text') keep(xhr.__stretchUrl, xhr.responseText, req);
          else if (xhr.responseType === 'json' && xhr.response) keep(xhr.__stretchUrl, JSON.stringify(xhr.response), req);
        } catch (e) {}
      });
      return send.apply(this, arguments);
    };
  }
})();
true;`;
}

export interface SuggestScriptOptions {
  /** How long the site's suggestions must stay the same before they're taken. */
  settleMs?: number;
  /** When to give up and post what's there. */
  maxMs?: number;
  intervalMs?: number;
}

/**
 * Types `text` into the retailer's own search box in its kept page, as a user would, and posts what the site
 * suggests: the options of its suggestion list, or failing that, the words in the suggestion data the site fetched
 * (the capture script keeps it). Nothing is submitted: the page stays where it is, for searches replayed in it.
 */
export function suggestScript(nonce: string, text: string, opts: SuggestScriptOptions = {}): string {
  const { settleMs = 400, maxMs = 2500, intervalMs = 120 } = opts;
  return `(function () {
  var NONCE = ${JSON.stringify(nonce)}, TEXT = ${JSON.stringify(text)};
  var SETTLE = ${Number(settleMs)}, MAX = ${Number(maxMs)}, INTERVAL = ${Number(intervalMs)};
  var BOX = 'input[type="search"], input[role="combobox"], input[aria-autocomplete], input[name*="search" i], input[id*="search" i], input[placeholder*="search" i], input[aria-label*="search" i], input[name="q"], input[name="query"]';
  var OPTIONS = '[role="listbox"] [role="option"], [role="option"], [id*="typeahead" i] li, [class*="typeahead" i] li, [class*="suggest" i] li, [class*="autocomplete" i] li';
  function post(msg) {
    msg.kind = 'suggest';
    msg.nonce = NONCE;
    window.ReactNativeWebView.postMessage(JSON.stringify(msg));
  }
  function clean(s) { return String(s || '').replace(/\\s+/g, ' ').trim(); }
  var words = TEXT.toLowerCase().split(/\\s+/).filter(Boolean);
  function fits(s) {
    var low = s.toLowerCase();
    for (var i = 0; i < words.length; i++) if (low.indexOf(words[i]) === -1) return false;
    return true;
  }
  try {
    var boxes = document.querySelectorAll(BOX), box = null;
    for (var i = 0; i < boxes.length && !box; i++) if (!boxes[i].disabled && boxes[i].type !== 'hidden') box = boxes[i];
    if (!box) { post({ items: [], how: 'no_box' }); return; }
    var cap = window.__stretchCapture, seen = cap ? cap.items.length : 0;
    box.focus();
    // Through the input's own value setter, so a React site sees the change.
    var setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(box, TEXT);
    var key = TEXT.slice(-1);
    box.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: key }));
    box.dispatchEvent(new Event('input', { bubbles: true }));
    box.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: key }));
    function fromList() {
      var out = [], nodes = document.querySelectorAll(OPTIONS);
      for (var i = 0; i < nodes.length && out.length < 20; i++) {
        var t = clean(nodes[i].innerText || nodes[i].textContent);
        if (t && t.length <= 80 && fits(t) && out.indexOf(t) === -1) out.push(t);
      }
      return out;
    }
    function fromResponses() {
      var out = [];
      if (!cap) return out;
      function walk(v, depth) {
        if (out.length >= 20 || depth > 6 || v == null) return;
        if (typeof v === 'string') {
          var t = clean(v);
          if (t.length >= 2 && t.length <= 60 && fits(t) && !/^https?:|[{}<>\\/]/.test(t) && out.indexOf(t) === -1) out.push(t);
        } else if (Array.isArray(v)) {
          for (var j = 0; j < v.length && j < 30; j++) walk(v[j], depth + 1);
        } else if (typeof v === 'object') {
          for (var k in v) walk(v[k], depth + 1);
        }
      }
      for (var i = seen; i < cap.items.length; i++) {
        try { walk(JSON.parse(cap.items[i].text), 0); } catch (e) {}
      }
      return out;
    }
    var started = Date.now(), last = '', since = Date.now();
    (function poll() {
      try {
        var items = fromList(), how = 'list';
        if (!items.length) { items = fromResponses(); how = 'response'; }
        var now = Date.now(), sig = items.join('|');
        if (sig !== last) { last = sig; since = now; }
        if ((items.length && now - since >= SETTLE) || now - started >= MAX) {
          post({ items: items.slice(0, 12), how: items.length ? how : 'none' });
          return;
        }
      } catch (e) {
        post({ items: [], error: String((e && e.message) || e) });
        return;
      }
      setTimeout(poll, INTERVAL);
    })();
  } catch (e) {
    post({ items: [], error: String((e && e.message) || e) });
  }
})();
true;`;
}

/** One request to send from inside a loaded retailer page, built by replay.ts. */
export interface ReplayRequest {
  /** 'document': the search page's HTML, read for its embedded data. 'json': an API response. */
  expect: 'json' | 'document';
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
  credentials?: 'omit' | 'same-origin' | 'include';
}

/**
 * Sends one request from inside the retailer's page, with the page's own cookies and origin, and posts back the
 * response. For HTML, only the embedded JSON crosses the bridge (plus the title, and short pages whole, to spot
 * bot checks).
 */
export function replayScript(nonce: string, req: ReplayRequest): string {
  return `(function () {
  var NONCE = ${JSON.stringify(nonce)}, REQ = ${JSON.stringify(req)};
  var LIMIT = 5500000;
  function post(msg) {
    msg.kind = 'replay';
    msg.nonce = NONCE;
    window.ReactNativeWebView.postMessage(JSON.stringify(msg));
  }
  function scripts(html, marker) {
    var out = [], from = 0;
    for (var i = 0; i < 50; i++) {
      var at = html.indexOf(marker, from);
      if (at === -1) break;
      var start = html.indexOf('>', at);
      var end = start === -1 ? -1 : html.indexOf('</script>', start);
      if (end === -1) break;
      out.push(html.slice(start + 1, end));
      from = end;
    }
    return out;
  }
  function fail(e) { post({ error: String((e && e.message) || e) }); }
  try {
    var cap = window.__stretchCapture;
    var send = (cap && cap.fetch) || window.fetch;
    var init = { method: REQ.method, headers: REQ.headers || {}, credentials: REQ.credentials || 'same-origin' };
    if (REQ.body != null && REQ.method !== 'GET' && REQ.method !== 'HEAD') init.body = REQ.body;
    send.call(window, REQ.url, init).then(function (res) {
      return res.text().then(function (text) {
        var out = { status: res.status, url: String(res.url || REQ.url), type: (res.headers && res.headers.get('content-type')) || '' };
        out.bytes = text.length;
        try {
          var timing = performance.getEntriesByName(out.url);
          var last = timing[timing.length - 1];
          if (last && last.transferSize > 0) out.bytes = last.transferSize;
        } catch (e) {}
        if (text.length > LIMIT) { out.error = 'too_large'; post(out); return; }
        if (REQ.expect === 'document') {
          var nd = scripts(text, 'id="__NEXT_DATA__"');
          var title = /<title[^>]*>([^<]*)<\\/title>/i.exec(text);
          out.nextDataText = nd.length ? nd[0] : null;
          out.ld = scripts(text, 'application/ld+json');
          out.title = title ? title[1] : '';
          out.short = text.length < 40000 ? text : '';
        } else {
          out.text = text;
        }
        post(out);
      });
    }).then(null, fail);
  } catch (e) {
    fail(e);
  }
})();
true;`;
}

/**
 * Script text defining navTiming(): from the browser's own navigation timing, when the page started loading, when its
 * final address was asked for (after any redirects), and when its HTML had been read, as clock times (the phone's
 * clock), for the speed test's timeline. Null if unknown.
 */
const NAV_TIMING = `function navTiming() {
    try {
      var origin = performance.timeOrigin || (performance.timing && performance.timing.navigationStart) || 0;
      var nav = performance.getEntriesByType ? performance.getEntriesByType('navigation')[0] : null;
      if (origin && nav) {
        var html = nav.domInteractive || nav.domContentLoadedEventEnd || 0;
        return { start: Math.round(origin), fetch: Math.round(origin + (nav.fetchStart || 0)), html: html > 0 ? Math.round(origin + html) : 0 };
      }
      var t = performance.timing;
      if (t && t.navigationStart) return { start: t.navigationStart, fetch: t.fetchStart || t.navigationStart, html: t.domInteractive || t.domContentLoadedEventEnd || 0 };
    } catch (e) {}
    return null;
  }`;

/**
 * Runs before the page's own scripts, like the capture script, on hidden loads: adds a content security policy that
 * stops images, fonts and video from loading. Search results arrive as data, so the page doesn't need them, and a
 * store page is mostly images. The policy goes in as soon as the page has a head, before the body starts loading.
 */
export function lightScript(): string {
  return `(function () {
  if (window.__stretchLight) return;
  window.__stretchLight = true;
  var POLICY = "img-src data: blob:; font-src data:; media-src 'none'";
  function add() {
    var head = document.head;
    if (!head) return false;
    if (!head.querySelector('meta[data-stretch-light]')) {
      var meta = document.createElement('meta');
      meta.httpEquiv = 'Content-Security-Policy';
      meta.content = POLICY;
      meta.setAttribute('data-stretch-light', '1');
      head.insertBefore(meta, head.firstChild);
    }
    return true;
  }
  if (add()) return;
  var watch = new MutationObserver(function () { if (add()) watch.disconnect(); });
  watch.observe(document.documentElement || document, { childList: true, subtree: true });
})();
true;`;
}

export interface ExtractOptions {
  /** 'search' waits for data (and reports bot checks); 'read' posts what's there now, when the user taps Read. */
  mode?: 'search' | 'read';
  /**
   * 'nextData': post as soon as Next.js page data exists. 'auto': wait until prices show up, or give up and post
   * what's there. 'details': a product's own page; post once its structured data is in and the page has settled,
   * with its share tags. 'loaded': post as soon as the page has loaded (a page kept to type into its search box).
   * 'text': a page read for what it says (a store's fees page); post its visible text once it has loaded and its
   * text has stopped changing.
   */
  waitFor?: 'nextData' | 'auto' | 'details' | 'loaded' | 'text';
  /** Also post each new price-bearing response as it arrives ('progress'), so the app can stop waiting early. */
  progress?: boolean;
  /** Once the page has finished loading, post what's there after this long with nothing new arriving. 0: don't. */
  giveUpMs?: number;
  /**
   * 'auto': when the page's requests go quiet, ask the app ('quiet') instead of posting at once, and post when it says
   * so (goScript). The app knows what the store usually gives, and can wait for a list the quiet came before.
   */
  askQuiet?: boolean;
  /** 'text': how long the page's text must stay the same before it's posted. */
  textSettleMs?: number;
  intervalMs?: number;
  maxTries?: number;
}

/** Tells a page's extraction script that the app has what it needs, so it stops (see extractionScript). */
export const stopScript = (nonce: string): string => `window.__stretchDone = ${JSON.stringify(nonce)}; true;`;

/** Tells a page's extraction script that asked about its quiet (askQuiet) to post what it has now. */
export const goScript = (nonce: string): string => `window.__stretchGo = ${JSON.stringify(nonce)}; true;`;

/**
 * Runs inside the retailer's page and posts back once: page data, a bot-check notice, or an error.
 * URL and title markers go first because a block page can carry its own __NEXT_DATA__.
 */
export function extractionScript(nonce: string, markers: string[], pageScript?: string, opts: ExtractOptions = {}): string {
  const { mode = 'search', waitFor = 'nextData', progress = false, giveUpMs = 5000, textSettleMs = 1000, intervalMs = 250, maxTries = 60, askQuiet = false } = opts;
  return `(function () {
  var NONCE = ${JSON.stringify(nonce)};
  var MARKERS = ${JSON.stringify(markers)};
  var BLOCK_SIGNS = ${JSON.stringify(BLOCK_MARKERS)};
  var FRAMES = ${CAPTCHA_FRAMES.toString()};
  var ASK_QUIET = ${askQuiet ? 'true' : 'false'}, askedFor = 0;
  var PAGE_SCRIPT = ${pageScript ? `(${pageScript})` : 'null'};
  var MODE = ${JSON.stringify(mode)}, WAIT_FOR = ${JSON.stringify(waitFor)};
  var PROGRESS = ${progress ? 'true' : 'false'}, GIVE_UP = ${Number(giveUpMs)};
  var INTERVAL = ${Number(intervalMs)}, MAX_TRIES = ${Number(maxTries)};
  var BUDGET = 5500000;
  var PRICE_KEY = /"[A-Za-z_]*[Pp]rice[A-Za-z_]*"\\s*:/g;
  var loadedAt = 0;
  var storeText = null;
  var TEXT_LIMIT = 150000, TEXT_SETTLE = ${Number(textSettleMs)}, textLength = -1, textSince = 0;
  ${PAGE_BYTES}
  ${NAV_TIMING}
  ${STORE_LABEL}
  var BLOCKS = /^(P|DIV|LI|UL|OL|DL|DT|DD|H[1-6]|TABLE|TR|TD|TH|SECTION|ARTICLE|HEADER|FOOTER|MAIN|ASIDE|NAV|BLOCKQUOTE|FIGCAPTION|DETAILS|SUMMARY|BODY)$/;
  // What the page says, as a reader sees it: its rendered text, or without layout, its words outside scripts and
  // styles, a line per block.
  function pageText() {
    var body = document.body;
    if (!body) return '';
    var t = '';
    try { t = String(body.innerText || ''); } catch (e) {}
    if (t.replace(/\\s+/g, '').length >= 20) return t.slice(0, TEXT_LIMIT);
    var out = [], used = 0, lastBlock = null;
    try {
      var walker = document.createTreeWalker(body, 4), node;
      while ((node = walker.nextNode()) && used < TEXT_LIMIT) {
        var p = node.parentElement;
        if (p && /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(p.tagName)) continue;
        var s = String(node.nodeValue || '').replace(/\\s+/g, ' ').trim();
        if (!s) continue;
        var block = p;
        while (block && !BLOCKS.test(block.tagName)) block = block.parentElement;
        out.push((out.length ? (block !== lastBlock ? '\\n' : ' ') : '') + s);
        used += s.length + 1;
        lastBlock = block;
      }
    } catch (e) {}
    return out.join('').slice(0, TEXT_LIMIT);
  }
  var finished = false, framed = false;
  function post(msg) {
    if (msg.kind !== 'progress' && msg.kind !== 'quiet' && !msg.frame) finished = true;
    msg.nonce = NONCE;
    msg.href = String(location.href);
    msg.title = String(document.title || '');
    msg.usage = pageBytes();
    // Which store the page is set to, as it says: the prices it shows are that store's. And when the page itself
    // loaded, for the speed test.
    if (msg.kind === 'data' || msg.kind === 'progress') {
      if (!storeText) storeText = storeLabel();
      if (storeText) msg.store = storeText;
      msg.nav = navTiming();
    }
    window.ReactNativeWebView.postMessage(JSON.stringify(msg));
  }
  // Price-bearing responses not sent yet, newest first; each is sent once.
  function newSources() {
    var out = [], cap = window.__stretchCapture;
    if (!cap) return out;
    for (var i = cap.items.length - 1; i >= 0; i--) {
      var it = cap.items[i];
      if (it.sent || !it.priceKeys) continue;
      it.sent = true;
      var source = { label: 'response ' + it.url, text: it.text };
      if (it.req) source.request = it.req;
      out.push(source);
    }
    return out;
  }
  // Price-bearing responses stream back as the capture script keeps them, not at the next look; ones that land
  // within a moment of each other go together.
  if (PROGRESS && MODE === 'search' && window.__stretchCapture) {
    var flushing = false;
    window.__stretchCapture.onPrices = function () {
      if (flushing || finished) return;
      flushing = true;
      setTimeout(function () {
        flushing = false;
        if (finished || window.__stretchDone === NONCE) return;
        try {
          var fresh = newSources();
          if (fresh.length) post({ kind: 'progress', sources: fresh });
        } catch (e) {}
      }, 30);
    };
  }
  function hasMarker(text) {
    for (var i = 0; i < MARKERS.length; i++) if (text.indexOf(MARKERS[i]) !== -1) return true;
    return false;
  }
  // A short page's body, or '' for a page of many elements: that isn't short, and isn't written out to find that out,
  // which would take the page's time at every look.
  function shortBody() {
    if (document.getElementsByTagName('*').length > 1000) return '';
    var body = document.body ? document.body.innerHTML : '';
    return body.length < 40000 ? body : '';
  }
  // A page that refuses the phone outright ("Access Denied"): its URL or title says so, or a short page's words do.
  function blockedBy(body) {
    var head = location.href + ' ' + document.title;
    for (var i = 0; i < BLOCK_SIGNS.length; i++) {
      if (head.indexOf(BLOCK_SIGNS[i]) !== -1 || (body && body.indexOf(BLOCK_SIGNS[i]) !== -1)) return BLOCK_SIGNS[i];
    }
    return null;
  }
  // A captcha in a frame of the page, big enough to see, which its URL and title don't give away.
  function captchaFrame() {
    var frames = document.getElementsByTagName('iframe');
    for (var i = 0; i < frames.length && i < 60; i++) {
      var f = frames[i], src = String(f.getAttribute('src') || '');
      if (!FRAMES.test(src) || /invisible/i.test(src)) continue;
      var r = f.getBoundingClientRect ? f.getBoundingClientRect() : null;
      if (!r || r.width < 150 || r.height < 60) continue;
      var st = window.getComputedStyle ? window.getComputedStyle(f) : null;
      if (st && (st.visibility === 'hidden' || st.display === 'none' || st.opacity === '0')) continue;
      return true;
    }
    return false;
  }
  // 'marker': the page's URL or title, or a short page's body, has a bot-check sign (ids only in the body, not phrases a
  // normal page might show). 'frame': a captcha shows in a frame of the page.
  function challenged(body) {
    if (hasMarker(location.href + ' ' + document.title)) return 'marker';
    for (var i = 0; i < MARKERS.length; i++) {
      if (body && MARKERS[i].indexOf(' ') === -1 && body.indexOf(MARKERS[i]) !== -1) return 'marker';
    }
    return captchaFrame() ? 'frame' : null;
  }
  // How much the page is: its elements, and its words when it has few elements (-1 when it has many).
  function pageSize() {
    try {
      var elements = document.getElementsByTagName('*').length, chars = -1;
      if (elements < 400 && document.body) chars = String(document.body.innerText || document.body.textContent || '').replace(/\\s+/g, ' ').trim().length;
      return { elements: elements, chars: chars };
    } catch (e) {
      return null;
    }
  }
  function priceKeys(text) {
    var m = text ? text.match(PRICE_KEY) : null;
    return m ? m.length : 0;
  }
  function ldTexts() {
    var out = [], nodes = document.querySelectorAll('script[type="application/ld+json"]');
    for (var i = 0; i < nodes.length; i++) if (nodes[i].textContent) out.push(nodes[i].textContent);
    return out;
  }
  // A product page's share tags (og:image, og:description, product:price...), as one JSON document.
  function metaJson() {
    var out = {}, nodes = document.querySelectorAll('meta[property], meta[name]');
    for (var i = 0; i < nodes.length && i < 300; i++) {
      var k = nodes[i].getAttribute('property') || nodes[i].getAttribute('name') || '';
      if (/^(og:|product:|twitter:|description$)/i.test(k) && !out[k]) out[k] = String(nodes[i].getAttribute('content') || '').slice(0, 3000);
    }
    return JSON.stringify(out);
  }
  function collect(budget) {
    var out = [], used = 0;
    function add(label, text, request) {
      if (typeof text !== 'string' || !text || used + text.length > budget) return;
      var source = { label: label, text: text };
      if (request) source.request = request;
      out.push(source);
      used += text.length;
    }
    var ld = ldTexts();
    // A product page's own small documents go first, so big responses can't crowd them out.
    if (WAIT_FOR === 'details') {
      add('meta', metaJson());
      for (var d = 0; d < ld.length; d++) add('ld+json', ld[d]);
    }
    var cap = window.__stretchCapture;
    if (cap) for (var i = cap.items.length - 1; i >= 0; i--) add('response ' + cap.items[i].url, cap.items[i].text, cap.items[i].req);
    if (WAIT_FOR !== 'details') for (var j = 0; j < ld.length; j++) add('ld+json', ld[j]);
    // The page's JSON script blocks (its data, as some frameworks write it: Next.js's is read on its own).
    var blocks = document.querySelectorAll('script[type="application/json"]');
    for (var b = 0; b < blocks.length && b < 30; b++) {
      if (blocks[b].id !== '__NEXT_DATA__') add(blocks[b].id ? 'json script #' + blocks[b].id : 'json script', blocks[b].textContent);
    }
    var names = ['__APOLLO_STATE__', '__PRELOADED_STATE__', '__INITIAL_STATE__', '__NUXT__'];
    for (var k = 0; k < names.length; k++) {
      try { if (window[names[k]]) add(names[k], JSON.stringify(window[names[k]])); } catch (e) {}
    }
    return out;
  }
  var tries = 0;
  (function attempt() {
    tries++;
    // The app already took what it needed from the progress posts.
    if (window.__stretchDone === NONCE) return;
    try {
      if (MODE === 'search') {
        var body = shortBody();
        var block = blockedBy(body);
        if (block) { post({ kind: 'blocked', marker: block }); return; }
        var check = challenged(body);
        if (check === 'marker') { post({ kind: 'challenge' }); return; }
        if (check === 'frame') {
          // A captcha in a frame: the app shows the page for it (or reports it), and the frame is watched until it goes.
          if (!framed) { framed = true; post({ kind: 'challenge', frame: true }); }
          tries--;
          setTimeout(attempt, INTERVAL);
          return;
        }
      }
      var nd = document.getElementById('__NEXT_DATA__');
      var ndText = nd && nd.textContent ? nd.textContent : null;
      var pageResult = PAGE_SCRIPT ? PAGE_SCRIPT() : null;
      var cap = window.__stretchCapture;
      if (!loadedAt && document.readyState === 'complete') loadedAt = Date.now();
      // A page that finished loading and then went quiet isn't going to show products (blocked calls, no results).
      var lastActivity = Math.max(loadedAt, (cap && cap.lastAt) || 0);
      var givenUp = GIVE_UP > 0 && loadedAt > 0 && Date.now() - lastActivity >= GIVE_UP;
      if (PROGRESS && MODE === 'search') {
        var fresh = newSources();
        if (fresh.length) post({ kind: 'progress', sources: fresh });
      }
      // Why it's ready, for the speed test: 'quiet', 'gave_up', 'tries', or 'data' (what it waited for is there).
      var ready, why = 'data';
      if (MODE === 'read' || pageResult != null) ready = true;
      else if (WAIT_FOR === 'nextData') {
        ready = !!ndText || givenUp;
        if (!ndText) why = 'gave_up';
      }
      else if (WAIT_FOR === 'loaded') ready = loadedAt > 0 || tries >= MAX_TRIES;
      else if (WAIT_FOR === 'text') {
        // A page drawn by its scripts keeps growing after it loads: wait until its text holds still.
        var length = pageText().length;
        if (length !== textLength) { textLength = length; textSince = Date.now(); }
        ready = (loadedAt > 0 && length >= 200 && Date.now() - textSince >= TEXT_SETTLE) || givenUp || tries >= MAX_TRIES;
      } else if (WAIT_FOR === 'details') {
        var hasProduct = /"(Product|ProductGroup|Recipe)"/.test(ldTexts().join(' '));
        var settled = !cap || !cap.lastAt || Date.now() - cap.lastAt > 800;
        ready = (loadedAt > 0 && (hasProduct || !!ndText) && settled) || givenUp || tries >= MAX_TRIES;
      } else {
        var signals = (cap ? cap.priceKeys : 0) + priceKeys(ldTexts().join(' '));
        var quiet = !cap || !cap.lastAt || Date.now() - cap.lastAt > 600;
        var go = window.__stretchGo === NONCE;
        if (ASK_QUIET && signals >= 8 && quiet && !go && !givenUp && tries < MAX_TRIES) {
          // Quiet: the app says whether that's the results, or a list to wait past. Asked once each time it goes quiet.
          var spell = (cap && cap.lastAt) || loadedAt || 1;
          if (askedFor !== spell) { askedFor = spell; post({ kind: 'quiet' }); }
          ready = false;
        } else {
          ready = (signals >= 8 && quiet) || go || givenUp || tries >= MAX_TRIES;
        }
        why = go || (signals >= 8 && quiet) ? 'quiet' : givenUp ? 'gave_up' : 'tries';
      }
      if (ready) {
        var wantSources = MODE === 'read' || (WAIT_FOR !== 'nextData' && WAIT_FOR !== 'loaded' && WAIT_FOR !== 'text');
        var msg = {
          kind: 'data',
          nextDataText: WAIT_FOR === 'text' ? null : ndText,
          sources: wantSources ? collect(BUDGET - (ndText ? ndText.length : 0)) : [],
          pageResult: pageResult,
          ready: why,
          size: MODE === 'search' ? pageSize() : null
        };
        if (WAIT_FOR === 'text') msg.text = pageText();
        post(msg);
        return;
      }
    } catch (e) {
      post({ kind: 'error', error: String((e && e.message) || e) });
      return;
    }
    if (tries < MAX_TRIES) setTimeout(attempt, INTERVAL);
    else post({ kind: 'error', error: 'no_payload' });
  })();
})();
true;`;
}
