import { PAGE_BYTES } from './pageHelpers';

// Scripts injected into a store finder's page: pressing "make this my store", sending the site's own request for it,
// and listing the stores it finds near a ZIP code. See webviewScript.ts for what they share.

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
      if (!/\\/(?:stores?|sl|locations?|warehouses?|clubs?|store-locator)\\/[^?#]*\\d/i.test(href) || seen.indexOf(href) !== -1) continue;
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
