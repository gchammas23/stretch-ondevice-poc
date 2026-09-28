// Pure string builders for the hidden WebView: no React Native imports, so they can be tested in Node.

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

/** Wording of buttons that make a listed store the user's store, most specific first. Case-insensitive prefixes. */
export const STORE_BUTTONS = [
  'make this my store',
  'make this my preferred store',
  'set as my store',
  'set as preferred store',
  'set as my warehouse',
  'make this my warehouse',
  'make this my club',
  'shop this store',
  'choose this store',
  'select this store',
];

export interface StoreScriptOptions {
  /** How long to leave the site to save the store after pressing. */
  settleMs?: number;
  intervalMs?: number;
  maxTries?: number;
  /** The store to press the button of: its number (in a link to its page) or its name. Omitted: the first, nearest. */
  target?: { id?: string; name?: string };
}

/**
 * Runs on a retailer's store finder for a ZIP code, which lists the nearest stores first. Presses the first store's
 * "make this my store" button, as a user would. It then gives the site's own request time to save the choice, and
 * posts which store it pressed. Like a search, it posts a bot-check notice when it sees one, and gives up with
 * 'button_not_found'.
 * If pressing navigates, the host injects this again on the next page: sessionStorage remembers the press, so the
 * button is never pressed twice.
 */
export function storeScript(nonce: string, markers: string[], buttons: string[], opts: StoreScriptOptions = {}): string {
  const { settleMs = 2500, intervalMs = 250, maxTries = 100, target } = opts;
  return `(function () {
  var NONCE = ${JSON.stringify(nonce)};
  var TARGET = ${JSON.stringify(target ?? null)};
  if (window.__stretchStoreTask === NONCE) return;
  window.__stretchStoreTask = NONCE;
  var MARKERS = ${JSON.stringify(markers)};
  var BUTTONS = ${JSON.stringify(buttons.map((b) => b.toLowerCase()))};
  var SETTLE = ${Number(settleMs)}, INTERVAL = ${Number(intervalMs)}, MAX_TRIES = ${Number(maxTries)};
  var KEY = '__stretchPressed:' + NONCE;
  var mine = null;
  function post(msg) {
    msg.nonce = NONCE;
    msg.href = String(location.href);
    window.ReactNativeWebView.postMessage(JSON.stringify(msg));
  }
  function hasMarker(text) {
    for (var i = 0; i < MARKERS.length; i++) if (text.indexOf(MARKERS[i]) !== -1) return true;
    return false;
  }
  function challenged() {
    if (hasMarker(location.href + ' ' + document.title)) return true;
    var body = document.body ? document.body.innerHTML : '';
    if (body.length >= 40000) return false;
    for (var i = 0; i < MARKERS.length; i++) {
      if (MARKERS[i].indexOf(' ') === -1 && body.indexOf(MARKERS[i]) !== -1) return true;
    }
    return false;
  }
  function textOf(el) {
    return String(el.innerText || el.textContent || el.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim();
  }
  // With a store to choose: only the button in that store's listing, found by a link to its page or its name.
  function isTarget(button) {
    if (!TARGET) return true;
    var block = blockOf(button);
    if (!block) return false;
    if (TARGET.id) {
      var links = block.querySelectorAll('a[href]'), idAt = new RegExp('[/=-]' + String(TARGET.id).replace(/[^A-Za-z0-9]/g, '') + '(?:[-/?#&.]|$)');
      for (var i = 0; i < links.length; i++) if (idAt.test(links[i].getAttribute('href') || '')) return true;
    }
    return !!TARGET.name && textOf(block).toLowerCase().indexOf(String(TARGET.name).toLowerCase()) !== -1;
  }
  function findButton() {
    var nodes = document.querySelectorAll('button, a, [role="button"]');
    for (var b = 0; b < BUTTONS.length; b++) {
      for (var i = 0; i < nodes.length; i++) {
        var t = textOf(nodes[i]).toLowerCase();
        if (t && t.length <= 60 && t.indexOf(BUTTONS[b]) === 0 && !nodes[i].disabled && isTarget(nodes[i])) return nodes[i];
      }
    }
    return null;
  }
  // The listing around the button: the smallest block with a heading, or with a few lines.
  function blockOf(el) {
    for (var n = el.parentElement, i = 0; n && i < 8; n = n.parentElement, i++) {
      var h = n.querySelector('h1, h2, h3, h4, h5');
      if (h && textOf(h)) return n;
      if (String(n.innerText || '').split('\\n').length > 2) return n;
    }
    return null;
  }
  // Its text, piece by piece (street, city, hours...), and its links (a store's own page carries its number).
  function linesOf(root) {
    var out = [];
    try {
      var walker = document.createTreeWalker(root, 4);
      var node;
      while ((node = walker.nextNode()) && out.length < 30) {
        var p = node.parentElement;
        if (p && /^(SCRIPT|STYLE|NOSCRIPT)$/.test(p.tagName)) continue;
        var t = String(node.nodeValue || '').replace(/\\s+/g, ' ').trim();
        if (t) out.push(t.slice(0, 120));
      }
    } catch (e) {}
    return out;
  }
  function linksOf(root) {
    var out = [], nodes = root.querySelectorAll('a[href]');
    for (var i = 0; i < nodes.length && out.length < 8; i++) out.push(String(nodes[i].getAttribute('href') || '').slice(0, 300));
    return out;
  }
  // The store's name: the heading of the smallest block around the button that has one, or that block's first line.
  function labelOf(el) {
    for (var n = el.parentElement, i = 0; n && i < 8; n = n.parentElement, i++) {
      var h = n.querySelector('h1, h2, h3, h4, h5');
      if (h && textOf(h)) return textOf(h).slice(0, 80);
      var lines = String(n.innerText || '').split('\\n');
      if (lines.length > 2 && lines[0].trim()) return lines[0].trim().slice(0, 80);
    }
    return '';
  }
  function remembered() {
    if (mine) return mine;
    try {
      var saved = sessionStorage.getItem(KEY);
      return saved ? JSON.parse(saved) : null;
    } catch (e) {
      return null;
    }
  }
  var tries = 0;
  (function attempt() {
    tries++;
    try {
      if (challenged()) { post({ kind: 'challenge' }); return; }
      var done = remembered();
      if (!done) {
        var button = findButton();
        if (button) {
          var block = blockOf(button);
          mine = done = { pressed: textOf(button), label: labelOf(button), lines: block ? linesOf(block) : [], links: block ? linksOf(block) : [], at: Date.now() };
          try { sessionStorage.setItem(KEY, JSON.stringify(mine)); } catch (e) {}
          button.click();
        }
      }
      if (done && Date.now() - done.at >= SETTLE) {
        post({ kind: 'data', pageResult: { pressed: done.pressed, label: done.label, lines: done.lines || [], links: done.links || [] } });
        return;
      }
    } catch (e) {
      post({ kind: 'error', error: String((e && e.message) || e) });
      return;
    }
    if (remembered() || tries < MAX_TRIES) setTimeout(attempt, INTERVAL);
    else post({ kind: 'error', error: 'button_not_found' });
  })();
})();
true;`;
}

/** A site's request that makes a store the user's, with the store's number in it (see StoreSetRequest in types.ts). */
export interface StoreRequest {
  method: string;
  url: string;
  body?: string;
  headers?: Record<string, string>;
}

/**
 * Runs on a page of a retailer's site, hidden: sends the site's own request that makes a store the user's, as its
 * store picker would, so the cookie the site answers with lands in the WebView. Posts the answer's status, or
 * 'store_request_http_<status>' when the site refuses. Like a search, it posts a bot-check notice when it sees one.
 * Sent once per page: if the host injects it again, nothing is sent twice.
 */
export function storeRequestScript(nonce: string, markers: string[], req: StoreRequest, opts: { intervalMs?: number; maxTries?: number } = {}): string {
  const { intervalMs = 250, maxTries = 40 } = opts;
  return `(function () {
  var NONCE = ${JSON.stringify(nonce)}, REQ = ${JSON.stringify(req)};
  if (window.__stretchStoreTask === NONCE) return;
  window.__stretchStoreTask = NONCE;
  var MARKERS = ${JSON.stringify(markers)};
  var INTERVAL = ${Number(intervalMs)}, MAX_TRIES = ${Number(maxTries)};
  function post(msg) {
    msg.nonce = NONCE;
    msg.href = String(location.href);
    window.ReactNativeWebView.postMessage(JSON.stringify(msg));
  }
  function hasMarker(text) {
    for (var i = 0; i < MARKERS.length; i++) if (text.indexOf(MARKERS[i]) !== -1) return true;
    return false;
  }
  function challenged() {
    if (hasMarker(location.href + ' ' + document.title)) return true;
    var body = document.body ? document.body.innerHTML : '';
    if (body.length >= 40000) return false;
    for (var i = 0; i < MARKERS.length; i++) {
      if (MARKERS[i].indexOf(' ') === -1 && body.indexOf(MARKERS[i]) !== -1) return true;
    }
    return false;
  }
  var tries = 0;
  (function attempt() {
    tries++;
    try {
      // Once the page is there: a bot check instead is said, not answered.
      if (document.readyState === 'loading' && tries < MAX_TRIES) { setTimeout(attempt, INTERVAL); return; }
      if (challenged()) { post({ kind: 'challenge' }); return; }
      var cap = window.__stretchCapture;
      var send = (cap && cap.fetch) || window.fetch;
      var init = { method: REQ.method, headers: REQ.headers || {}, credentials: 'same-origin' };
      if (REQ.body != null) init.body = REQ.body;
      send.call(window, REQ.url, init).then(function (res) {
        if (res.status >= 200 && res.status < 300) post({ kind: 'data', pageResult: { status: res.status } });
        else post({ kind: 'error', error: 'store_request_http_' + res.status });
      }, function () {
        post({ kind: 'error', error: 'store_request_failed' });
      });
    } catch (e) {
      post({ kind: 'error', error: String((e && e.message) || e) });
    }
  })();
})();
true;`;
}

export interface StoreListScriptOptions {
  /** How long the page's requests must be quiet before its store list is taken. */
  quietMs?: number;
  /** When to post whatever is there. */
  maxMs?: number;
  intervalMs?: number;
}

/**
 * Runs on a retailer's store finder, hidden, to list its stores near `zip`: types the ZIP into the finder's own box
 * and submits it, as a user would, unless the page's address already carries it. Then, once the page's requests
 * go quiet, posts what it got (the store list is in one of them, or in its page data) and its store cards, read off
 * the page, for when the data can't be found. The app reads the stores out of that (nearbyList in storeLocator.ts).
 * It says how the ZIP reached the page (`zipIn`: in its address, typed into its box, typed into the page before this
 * one, or not at all), and each response goes with the request that brought it (its address and body; never its
 * headers), so a list the page asked for with the ZIP can be told from one it showed first, for wherever the site
 * thinks the phone is. Responses the page got before the ZIP was typed are left out.
 */
export function storeListScript(nonce: string, zip: string, markers: string[], opts: StoreListScriptOptions = {}): string {
  const { quietMs = 1500, maxMs = 12000, intervalMs = 250 } = opts;
  return `(function () {
  var NONCE = ${JSON.stringify(nonce)}, ZIP = ${JSON.stringify(zip)};
  if (window.__stretchStoreList === NONCE) return;
  window.__stretchStoreList = NONCE;
  var MARKERS = ${JSON.stringify(markers)};
  var QUIET = ${Number(quietMs)}, MAX = ${Number(maxMs)}, INTERVAL = ${Number(intervalMs)};
  // The finder's box: one for a ZIP code or a place first, a plain search box last.
  var BOXES = ['input[autocomplete="postal-code"]', 'input[name*="zip" i]', 'input[id*="zip" i]', 'input[placeholder*="zip" i]', 'input[aria-label*="zip" i]', 'input[name*="location" i]', 'input[id*="location" i]', 'input[aria-label*="location" i]', 'input[placeholder*="city" i]', 'input[placeholder*="address" i]', 'input[aria-label*="address" i]', 'input[type="search"]', 'input[name="q"]', 'input[id*="search" i]', 'input[title*="search" i]'];
  var KEY = '__stretchZipTyped:' + NONCE;
  ${PAGE_BYTES}
  function post(msg) {
    msg.nonce = NONCE;
    msg.href = String(location.href);
    msg.title = String(document.title || '');
    msg.usage = pageBytes();
    window.ReactNativeWebView.postMessage(JSON.stringify(msg));
  }
  function hasMarker(text) {
    for (var i = 0; i < MARKERS.length; i++) if (text.indexOf(MARKERS[i]) !== -1) return true;
    return false;
  }
  function challenged() {
    if (hasMarker(location.href + ' ' + document.title)) return true;
    var body = document.body ? document.body.innerHTML : '';
    if (body.length >= 40000) return false;
    for (var i = 0; i < MARKERS.length; i++) {
      if (MARKERS[i].indexOf(' ') === -1 && body.indexOf(MARKERS[i]) !== -1) return true;
    }
    return false;
  }
  function typedAlready() {
    try { return sessionStorage.getItem(KEY) === '1'; } catch (e) { return false; }
  }
  // How the ZIP reached the page: 'url' (its address carries it), 'box' (typed into its box here), 'next' (typed into
  // the box of the page before, which the finder moved on from: all of this page came after), or null, not yet. And
  // the responses this page had got when it was typed: its list for wherever it thinks the phone is, not for the ZIP.
  var zipIn = null, before = null;
  // The ZIP, typed into the finder's box and submitted, once (the page may reload with the results).
  function typeZip() {
    if (zipIn) return true;
    if (location.href.indexOf(ZIP) !== -1) { zipIn = 'url'; return true; }
    if (typedAlready()) { zipIn = 'next'; return true; }
    var box = null;
    for (var b = 0; b < BOXES.length && !box; b++) {
      var found = document.querySelector(BOXES[b]);
      if (found && !found.disabled && found.type !== 'hidden') box = found;
    }
    if (!box) return false;
    try { sessionStorage.setItem(KEY, '1'); } catch (e) {}
    var cap = window.__stretchCapture;
    before = cap ? cap.items.slice() : [];
    zipIn = 'box';
    box.focus();
    var setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(box, ZIP);
    box.dispatchEvent(new Event('input', { bubbles: true }));
    box.dispatchEvent(new Event('change', { bubbles: true }));
    var enter = { bubbles: true, key: 'Enter', code: 'Enter', keyCode: 13, which: 13 };
    box.dispatchEvent(new KeyboardEvent('keydown', enter));
    box.dispatchEvent(new KeyboardEvent('keyup', enter));
    if (box.form) {
      if (typeof box.form.requestSubmit === 'function') box.form.requestSubmit();
      else box.form.submit();
    }
    return true;
  }
  function linesOf(root) {
    var out = [];
    try {
      var walker = document.createTreeWalker(root, 4), node;
      while ((node = walker.nextNode()) && out.length < 12) {
        var p = node.parentElement;
        if (p && /^(SCRIPT|STYLE|NOSCRIPT)$/.test(p.tagName)) continue;
        var t = String(node.nodeValue || '').replace(/\\s+/g, ' ').trim();
        if (t) out.push(t.slice(0, 120));
      }
    } catch (e) {}
    return out;
  }
  // Store cards: the listing around each link to a store's own page.
  function cards() {
    var out = [], seen = [], links = document.querySelectorAll('a[href]');
    for (var i = 0; i < links.length && out.length < 20; i++) {
      var href = links[i].getAttribute('href') || '';
      if (!/\\/(?:stores?|sl|locations?|warehouses?|clubs?)\\/[^?#]*\\d/i.test(href) || seen.indexOf(href) !== -1) continue;
      seen.push(href);
      var block = links[i];
      for (var up = 0; up < 5 && block.parentElement && linesOf(block).length < 3; up++) block = block.parentElement;
      out.push({ lines: linesOf(block), href: href.slice(0, 300) });
    }
    return out;
  }
  function sources() {
    var out = [], used = 0, cap = window.__stretchCapture;
    if (cap) for (var i = cap.items.length - 1; i >= 0; i--) {
      var it = cap.items[i];
      if (used + it.text.length > 5000000 || (before && before.indexOf(it) !== -1)) continue;
      var source = { label: 'response ' + it.url, text: it.text };
      // The request's address and body say whether it asked for the ZIP; its headers stay in the page.
      if (it.req) source.request = { method: it.req.method, url: it.req.url, body: it.req.body };
      out.push(source);
      used += it.text.length;
    }
    var ld = document.querySelectorAll('script[type="application/ld+json"]');
    for (var j = 0; j < ld.length; j++) if (ld[j].textContent) out.push({ label: 'ld+json', text: ld[j].textContent });
    // The page's own data in script blocks: JSON, and Amazon's "a-state" (Whole Foods' finder lists its stores in one).
    var blocks = document.querySelectorAll('script[type="application/json"], script[type="a-state"]');
    for (var b = 0; b < blocks.length && b < 30; b++) {
      var text = blocks[b].textContent;
      if (blocks[b].id === '__NEXT_DATA__' || !text || used + text.length > 5000000) continue;
      out.push({ label: 'json script', text: text });
      used += text.length;
    }
    return out;
  }
  var started = Date.now(), seenCount = -1, quietSince = Date.now();
  (function poll() {
    try {
      if (challenged()) { post({ kind: 'challenge' }); return; }
      var ready = typeZip();
      var cap = window.__stretchCapture, count = cap ? cap.items.length : 0;
      if (count !== seenCount) { seenCount = count; quietSince = Date.now(); }
      var loaded = document.readyState === 'complete';
      if ((ready && loaded && Date.now() - quietSince >= QUIET) || Date.now() - started >= MAX) {
        var nd = document.getElementById('__NEXT_DATA__');
        post({ kind: 'data', nextDataText: nd && nd.textContent ? nd.textContent : null, sources: sources(), pageResult: { cards: cards(), zipIn: zipIn || 'none' } });
        return;
      }
    } catch (e) {
      post({ kind: 'error', error: String((e && e.message) || e) });
      return;
    }
    setTimeout(poll, INTERVAL);
  })();
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
 * Script text defining storeLabel(): the store the site says it's set to, as its header (or a store card) writes it:
 * "Your store: Brooklyn Atlantic Terminal", "My Warehouse Brooklyn", "Shopping at Sprouts Farmers Market". Null when
 * the page names none. The app splits it into a name, an address and a number (parseStoreLabel in storeIdentity.ts).
 */
const STORE_LABEL = `function storeLabel() {
    try {
      var PHRASE = /\\b(?:(?:my|your|selected|preferred|current|home)\\s+(?:store|warehouse|club)|shopping\\s+(?:at|in)|pick\\s?up\\s+(?:at|from)|picking\\s+up\\s+at)\\b|\\b(?:store|warehouse)\\s*:/i;
      var BEFORE = /\\b(?:find|choose|select|change|set|pick|update|search|locate)\\b/i;
      var NOT_NAME = /^(?:find|choose|select|change|set|hours|details|info|deals|weekly|ad|locator|finder|near)\\b/i;
      var nodes = document.querySelectorAll('[aria-label], button, a, [role="button"], [data-test], [data-testid], [data-automation-id], header span, header div, header p');
      for (var i = 0; i < nodes.length && i < 2000; i++) {
        var el = nodes[i];
        var own = String(el.textContent || '').replace(/\\s+/g, ' ').trim();
        var texts = [String(el.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim(), own.length <= 160 ? own : ''];
        for (var j = 0; j < texts.length; j++) {
          var t = texts[j];
          var m = t && t.length <= 200 ? PHRASE.exec(t) : null;
          if (!m || BEFORE.test(t.slice(0, m.index))) continue;
          var rest = t.slice(m.index + m[0].length).replace(/^[\\s:|\\u00b7\\u2022-]+/, '');
          // "Your store" on its own: the name is next to it.
          if (!rest && el.nextElementSibling) rest = String(el.nextElementSibling.textContent || '').replace(/\\s+/g, ' ').trim();
          if (rest.length >= 2 && rest.length <= 200 && /^[A-Za-z0-9]/.test(rest) && !NOT_NAME.test(rest)) return (m[0] + ' ' + rest).slice(0, 240);
        }
      }
    } catch (e) {}
    return null;
  }`;

/**
 * Script text defining pageBytes(): about how much data the page has moved so far, from the browser's own resource
 * timing. Files from other sites that don't allow timing (images on a CDN, usually) report no size; each of those
 * is counted at a typical size for its kind, so the figure is an estimate.
 */
const PAGE_BYTES = `function pageBytes() {
    try {
      var TYPICAL = { img: 25000, image: 25000, css: 30000, link: 30000, script: 60000, font: 40000, fetch: 4000, xmlhttprequest: 4000, beacon: 500, video: 300000, audio: 100000, other: 10000 };
      var nav = performance.getEntriesByType('navigation')[0];
      var total = nav ? nav.transferSize || nav.encodedBodySize || 0 : 0;
      var list = performance.getEntriesByType('resource'), estimated = 0;
      for (var i = 0; i < list.length; i++) {
        var r = list[i];
        if (r.transferSize > 0) total += r.transferSize;
        else if (r.encodedBodySize > 0) continue; // From the cache: nothing moved.
        else if (!r.responseStart) { total += TYPICAL[r.initiatorType] || TYPICAL.other; estimated++; }
      }
      return { bytes: Math.round(total), files: list.length + 1, estimated: estimated };
    } catch (e) {
      return null;
    }
  }`;

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

// --- Weekly ads and coupons -------------------------------------------------------------------------------------

/**
 * Whether an address is a sign-in page: its host or path says so ("login.example.com", "/signin", "/login",
 * "/account/sign-in.html", "/oauth2/…"). A hidden read sent to one stops before it loads, so nothing is ever injected
 * into a sign-in page (see guardSignIn in webviewQueue.ts).
 */
export function looksLikeSignIn(url: string): boolean {
  const m = /^https?:\/\/([^/?#]+)([^?#]*)/i.exec(url);
  if (!m) return false;
  const host = m[1].toLowerCase();
  const path = m[2].toLowerCase();
  if (/^(?:login|signin|sign-in|auth|accounts?|identity|sso|secure)\./.test(host)) return true;
  return /(?:^|[/_.-])(?:sign-?in|log-?in|signon|sign-?on|oauth2?|authorize|authenticate|sso)(?:$|[/_.?-])/.test(path);
}

/** Wording of buttons that clip a coupon to the account, most specific first. Case-insensitive; whole words. */
export const CLIP_BUTTONS = ['clip coupon', 'clip offer', 'clip to card', 'clip', 'load to card', 'add to card', 'add offer', 'save offer', 'activate', 'add'];

/** Wording of a coupon's button once it's clipped. Case-insensitive prefixes. */
const CLIPPED_BUTTONS = ['clipped', 'unclip', 'added', 'loaded', 'activated', 'remove', 'saved', 'in your card', 'on your card'];

/**
 * Script text defining pageText(limit): what the page says, as a reader sees it: its rendered text, or without layout,
 * its words outside scripts and styles, a line per block.
 */
const PAGE_TEXT = `function pageText(limit) {
    var body = document.body;
    if (!body) return '';
    var t = '';
    try { t = String(body.innerText || ''); } catch (e) {}
    if (t.replace(/\\s+/g, '').length >= 20) return t.slice(0, limit);
    var BLOCKS = /^(P|DIV|LI|UL|OL|DL|DT|DD|H[1-6]|TABLE|TR|TD|TH|SECTION|ARTICLE|HEADER|FOOTER|MAIN|ASIDE|NAV|BLOCKQUOTE|FIGCAPTION|DETAILS|SUMMARY|BODY|BUTTON)$/;
    var out = [], used = 0, lastBlock = null;
    try {
      var walker = document.createTreeWalker(body, 4), node;
      while ((node = walker.nextNode()) && used < limit) {
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
    return out.join('').slice(0, limit);
  }`;

export interface ListPageScriptOptions {
  /** How long the page's requests must be quiet before what it has is posted. */
  quietMs?: number;
  /** When to post whatever is there. */
  maxMs?: number;
  intervalMs?: number;
  /** Screens to scroll down first, so items drawn as the page scrolls get loaded. */
  scrolls?: number;
}

/**
 * Runs on a page that lists things (a store's weekly ad, an account's coupons), hidden. Scrolls down a few screens, so
 * items the page draws as it's scrolled get loaded, then once its requests have gone quiet, posts what it got: the data
 * it fetched for itself (the capture script keeps it; not how it was asked for, whose headers stay in the page), its
 * visible words, and its cards: the smallest blocks with a price or a coupon's worth and some words, with their ids,
 * links and buttons. The app reads the ad or the coupons out of that (see adPage.ts and couponPage.ts).
 */
export function listPageScript(nonce: string, markers: string[], opts: ListPageScriptOptions = {}): string {
  const { quietMs = 1500, maxMs = 15000, intervalMs = 250, scrolls = 6 } = opts;
  return `(function () {
  var NONCE = ${JSON.stringify(nonce)};
  if (window.__stretchList === NONCE) return;
  window.__stretchList = NONCE;
  var MARKERS = ${JSON.stringify(markers)};
  var QUIET = ${Number(quietMs)}, MAX = ${Number(maxMs)}, INTERVAL = ${Number(intervalMs)}, SCROLLS = ${Number(scrolls)};
  var TEXT_LIMIT = 150000, BUDGET = 5000000;
  var WORTH = /\\$\\s?\\d|\\d\\s?¢|\\d+\\s*(?:\\/|for)\\s*\\$|\\bfree\\b|\\bbogo\\b|\\bbuy\\s+\\d|\\d\\s?%|\\boff\\b/i;
  var CARD = 'li, article, [role="listitem"], [class*="card" i], [class*="tile" i], [class*="product" i], [class*="item" i], [class*="coupon" i], [class*="offer" i], [class*="deal" i]';
  var BUTTON = /clip|unclip|clipped|\\badd|\\bload|\\bsave|activat|sign\\s?in|log\\s?in|remove/i;
  ${PAGE_BYTES}
  ${STORE_LABEL}
  ${PAGE_TEXT}
  function post(msg) {
    msg.nonce = NONCE;
    msg.href = String(location.href);
    msg.title = String(document.title || '');
    msg.usage = pageBytes();
    if (msg.kind === 'data') {
      var store = storeLabel();
      if (store) msg.store = store;
    }
    window.ReactNativeWebView.postMessage(JSON.stringify(msg));
  }
  function hasMarker(text) {
    for (var i = 0; i < MARKERS.length; i++) if (text.indexOf(MARKERS[i]) !== -1) return true;
    return false;
  }
  function challenged() {
    if (hasMarker(location.href + ' ' + document.title)) return true;
    if (document.getElementsByTagName('*').length > 1000) return false;
    var body = document.body ? document.body.innerHTML : '';
    if (body.length >= 40000) return false;
    for (var i = 0; i < MARKERS.length; i++) {
      if (MARKERS[i].indexOf(' ') === -1 && body.indexOf(MARKERS[i]) !== -1) return true;
    }
    return false;
  }
  function clean(s) { return String(s || '').replace(/\\s+/g, ' ').trim(); }
  // A card's text, piece by piece (name, price, dates...), up to 12 pieces.
  function linesOf(root) {
    var out = [];
    try {
      var walker = document.createTreeWalker(root, 4), node;
      while ((node = walker.nextNode()) && out.length < 12) {
        var p = node.parentElement;
        if (p && /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(p.tagName)) continue;
        var t = clean(node.nodeValue);
        if (t) out.push(t.slice(0, 160));
      }
    } catch (e) {}
    return out;
  }
  function idOf(card) {
    var ATTRS = ['data-offer-id', 'data-coupon-id', 'data-item-id', 'data-product-id', 'data-id', 'data-sku', 'id'];
    var els = [card].concat(Array.prototype.slice.call(card.querySelectorAll('[data-offer-id],[data-coupon-id],[data-item-id],[data-product-id],[data-id],[data-sku]'), 0, 5));
    for (var e = 0; e < els.length; e++) {
      for (var a = 0; a < ATTRS.length; a++) {
        var v = els[e].getAttribute(ATTRS[a]);
        if (v && v.length <= 80 && /\\d/.test(v)) return v;
      }
    }
    return undefined;
  }
  function buttonOf(card) {
    var nodes = card.querySelectorAll('button, [role="button"], a');
    for (var i = 0; i < nodes.length; i++) {
      var t = clean(nodes[i].textContent || nodes[i].getAttribute('aria-label'));
      if (t && t.length <= 40 && BUTTON.test(t)) return t;
    }
    return undefined;
  }
  function cards() {
    var nodes = document.querySelectorAll(CARD), found = [];
    for (var i = 0; i < nodes.length && i < 4000 && found.length < 600; i++) {
      var el = nodes[i], t = String(el.textContent || '');
      if (t.length < 6 || t.length > 600 || !WORTH.test(t) || linesOf(el).length < 2) continue;
      found.push(el);
    }
    // The smallest blocks: one that holds another is left out.
    for (var j = 0; j < found.length; j++) {
      for (var up = found[j].parentElement, d = 0; up && d < 12; up = up.parentElement, d++) up.__stretchOuter = NONCE;
    }
    var out = [];
    for (var k = 0; k < found.length && out.length < 300; k++) {
      var card = found[k];
      if (card.__stretchOuter === NONCE) continue;
      var link = card.querySelector('a[href]'), img = card.querySelector('img');
      out.push({
        lines: linesOf(card),
        id: idOf(card),
        href: link ? String(link.getAttribute('href') || '').slice(0, 300) : undefined,
        button: buttonOf(card),
        img: img ? String(img.getAttribute('src') || img.getAttribute('data-src') || '').slice(0, 300) : undefined
      });
    }
    return out;
  }
  function sources() {
    var out = [], used = 0, cap = window.__stretchCapture;
    function add(label, text) {
      if (typeof text !== 'string' || !text || used + text.length > BUDGET) return;
      out.push({ label: label, text: text });
      used += text.length;
    }
    if (cap) for (var i = cap.items.length - 1; i >= 0; i--) add('response ' + cap.items[i].url, cap.items[i].text);
    var ld = document.querySelectorAll('script[type="application/ld+json"]');
    for (var j = 0; j < ld.length; j++) add('ld+json', ld[j].textContent);
    var names = ['__APOLLO_STATE__', '__PRELOADED_STATE__', '__INITIAL_STATE__', '__NUXT__'];
    for (var k = 0; k < names.length; k++) {
      try { if (window[names[k]]) add(names[k], JSON.stringify(window[names[k]])); } catch (e) {}
    }
    return out;
  }
  var started = Date.now(), seen = -1, quietSince = Date.now(), scrolled = 0;
  (function poll() {
    try {
      if (challenged()) { post({ kind: 'challenge' }); return; }
      var cap = window.__stretchCapture, count = cap ? cap.items.length : 0;
      if (count !== seen) { seen = count; quietSince = Date.now(); }
      var loaded = document.readyState === 'complete';
      if (loaded && scrolled < SCROLLS) {
        scrolled++;
        try { window.scrollBy(0, Math.max(400, window.innerHeight || 0) * 2); } catch (e) {}
        quietSince = Date.now();
      }
      if ((loaded && scrolled >= SCROLLS && Date.now() - quietSince >= QUIET) || Date.now() - started >= MAX) {
        var nd = document.getElementById('__NEXT_DATA__');
        post({ kind: 'data', nextDataText: nd && nd.textContent ? nd.textContent : null, sources: sources(), text: pageText(TEXT_LIMIT), pageResult: { cards: cards() } });
        return;
      }
    } catch (e) {
      post({ kind: 'error', error: String((e && e.message) || e) });
      return;
    }
    setTimeout(poll, INTERVAL);
  })();
})();
true;`;
}

export interface ClipScriptOptions {
  /** How long the site gets to save the clip after the press, before the tile is looked at again. */
  settleMs?: number;
  intervalMs?: number;
  maxTries?: number;
}

/**
 * Clips one coupon on the store's coupons page, hidden, because the user asked in the app: finds its tile (by the id in
 * its data, else its words), presses the tile's clip button once, and, once the site has had a moment, posts whether
 * the tile now says it's clipped. A tile that says so already isn't pressed. A tile that says to sign in posts
 * 'signed_out'. Nothing else on the page is touched. If pressing loads another page, the host injects this again, and
 * sessionStorage remembers the press, so it's never pressed twice.
 */
export function clipScript(nonce: string, markers: string[], target: { id?: string; title: string }, buttons: string[] = CLIP_BUTTONS, opts: ClipScriptOptions = {}): string {
  const { settleMs = 2500, intervalMs = 250, maxTries = 80 } = opts;
  return `(function () {
  var NONCE = ${JSON.stringify(nonce)};
  if (window.__stretchClip === NONCE) return;
  window.__stretchClip = NONCE;
  var TARGET = ${JSON.stringify({ id: target.id ?? null, title: target.title })};
  var MARKERS = ${JSON.stringify(markers)};
  var BUTTONS = ${JSON.stringify(buttons.map((b) => b.toLowerCase()))};
  var DONE = ${JSON.stringify(CLIPPED_BUTTONS)};
  var SETTLE = ${Number(settleMs)}, INTERVAL = ${Number(intervalMs)}, MAX_TRIES = ${Number(maxTries)};
  var KEY = '__stretchClipped:' + NONCE;
  ${PAGE_BYTES}
  function post(msg) {
    msg.nonce = NONCE;
    msg.href = String(location.href);
    msg.title = String(document.title || '');
    msg.usage = pageBytes();
    window.ReactNativeWebView.postMessage(JSON.stringify(msg));
  }
  function hasMarker(text) {
    for (var i = 0; i < MARKERS.length; i++) if (text.indexOf(MARKERS[i]) !== -1) return true;
    return false;
  }
  function challenged() {
    if (hasMarker(location.href + ' ' + document.title)) return true;
    if (document.getElementsByTagName('*').length > 1000) return false;
    var body = document.body ? document.body.innerHTML : '';
    if (body.length >= 40000) return false;
    for (var i = 0; i < MARKERS.length; i++) {
      if (MARKERS[i].indexOf(' ') === -1 && body.indexOf(MARKERS[i]) !== -1) return true;
    }
    return false;
  }
  function norm(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9$%.]+/g, ' ').replace(/\\s+/g, ' ').trim(); }
  function isDone(t) {
    for (var i = 0; i < DONE.length; i++) if (t.indexOf(DONE[i]) === 0) return true;
    return false;
  }
  function isClip(t) {
    if (/cart|list|shop|view|details|sign in|log in/.test(t) || isDone(t)) return false;
    for (var i = 0; i < BUTTONS.length; i++) if (t === BUTTONS[i] || t.indexOf(BUTTONS[i] + ' ') === 0) return true;
    return false;
  }
  function isSignIn(t) { return /^(?:sign|log) ?in\\b/.test(t); }
  function words(el) { return norm(el.textContent || el.getAttribute('aria-label')); }
  var WORDS = norm(TARGET.title).split(' ').filter(function (w) { return w.length >= 3; }).slice(0, 10);
  // The tile around an element: the nearest block, up to 8 levels up, that holds a button.
  function tileAround(el) {
    for (var n = el, i = 0; n && i < 8; n = n.parentElement, i++) if (n.querySelector && n.querySelector('button, [role="button"]')) return n;
    return null;
  }
  // The coupon's tile: the element carrying its id, else the smallest tile with a coupon's button and most of its words.
  function tile() {
    if (TARGET.id && !/^(?:text|tile):/.test(TARGET.id)) {
      var all = document.querySelectorAll('[data-offer-id],[data-coupon-id],[data-id],[data-item-id],[data-couponid],[data-offerid],[id]');
      for (var i = 0; i < all.length; i++) {
        var attrs = all[i].attributes;
        for (var a = 0; a < attrs.length; a++) {
          if ((attrs[a].name === 'id' || attrs[a].name.indexOf('data-') === 0) && String(attrs[a].value) === String(TARGET.id)) return tileAround(all[i]);
        }
      }
    }
    if (!WORDS.length) return null;
    var nodes = document.querySelectorAll('button, [role="button"]'), best = null;
    for (var j = 0; j < nodes.length; j++) {
      var t = words(nodes[j]);
      if (!isClip(t) && !isDone(t) && !isSignIn(t)) continue;
      for (var up = nodes[j].parentElement, d = 0; up && d < 8; up = up.parentElement, d++) {
        var text = norm(up.textContent), hits = 0;
        for (var w = 0; w < WORDS.length; w++) if (text.indexOf(WORDS[w]) !== -1) hits++;
        if (hits / WORDS.length >= 0.6) {
          if (!best || hits > best.hits || (hits === best.hits && text.length < best.len)) best = { el: up, hits: hits, len: text.length };
          break;
        }
      }
    }
    return best ? best.el : null;
  }
  // What the tile's button says: clipped, clip, or sign in.
  function stateOf(el) {
    var nodes = el.querySelectorAll('button, [role="button"]');
    for (var i = 0; i < nodes.length; i++) {
      var t = words(nodes[i]);
      if (isDone(t)) return { kind: 'done', words: t };
      if (isSignIn(t)) return { kind: 'signin', words: t };
      if (isClip(t) && !nodes[i].disabled) return { kind: 'clip', words: t, button: nodes[i] };
    }
    return { kind: 'none' };
  }
  function pressedAt() {
    try { return Number(sessionStorage.getItem(KEY) || 0) || window.__stretchPressedAt || 0; } catch (e) { return window.__stretchPressedAt || 0; }
  }
  var tries = 0, sawTile = false;
  (function attempt() {
    tries++;
    try {
      if (challenged()) { post({ kind: 'challenge' }); return; }
      var el = tile(), at = pressedAt();
      // Pressed, and the tile went (moved to the clipped ones, or the page changed): the app reads the coupons again to know.
      if (!el && at && Date.now() - at >= SETTLE) { post({ kind: 'data', pageResult: { clipped: false, gone: true } }); return; }
      if (el) {
        sawTile = true;
        var state = stateOf(el);
        if (state.kind === 'done') { post({ kind: 'data', pageResult: { clipped: true, already: !at, words: state.words } }); return; }
        if (state.kind === 'signin') { post({ kind: 'error', error: 'signed_out' }); return; }
        if (state.kind === 'clip' && !at) {
          window.__stretchPressedAt = Date.now();
          try { sessionStorage.setItem(KEY, String(window.__stretchPressedAt)); } catch (e) {}
          state.button.click();
        } else if (at && Date.now() - at >= SETTLE) {
          post({ kind: 'data', pageResult: { clipped: false, words: state.words || '' } });
          return;
        }
      }
    } catch (e) {
      post({ kind: 'error', error: String((e && e.message) || e) });
      return;
    }
    if (tries < MAX_TRIES) setTimeout(attempt, INTERVAL);
    else post({ kind: 'error', error: sawTile ? 'no_clip_button' : 'coupon_not_found' });
  })();
})();
true;`;
}
