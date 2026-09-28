import { PAGE_BYTES, STORE_LABEL } from './pageHelpers';

// Weekly ads and coupons: scripts that read a page that lists things (an ad, an account's coupons) and clip a coupon,
// and the guard that keeps them out of sign-in pages. See webviewScript.ts for what they share.

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
