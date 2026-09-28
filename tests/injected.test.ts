/// <reference types="node" />
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { JSDOM } from 'jsdom';
import { autoDetect, walmartNextData } from '../src/onDevice/parsers';
import { parseProductPage } from '../src/onDevice/productPage';
import { parseStoreLabel, storeFromFinder } from '../src/onDevice/storeIdentity';
import { nearbyList, nearbyStores } from '../src/onDevice/storeLocator';
import {
  captureScript,
  DEFAULT_CHALLENGE_MARKERS,
  extractionScript,
  lightScript,
  replayScript,
  stopScript,
  STORE_BUTTONS,
  storeListScript,
  storeRequestScript,
  storeScript,
  suggestScript,
} from '../src/onDevice/webviewScript';

const markers = DEFAULT_CHALLENGE_MARKERS;
const ctx = { retailer: 'test', storeId: '' };
const page = (data: unknown, title = 'whole milk - Walmart.com') =>
  `<!doctype html><html><head><title>${title}</title></head><body><div id="root"></div><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(data)}</script></body></html>`;
const walmartData = { props: { pageProps: { initialData: { searchResult: { itemStacks: [{ items: [
  { usItemId: '3', name: 'Milk 3', priceInfo: { currentPrice: { price: 3.12 } } },
] }] } } } } };
const apiJson = JSON.stringify({ results: Array.from({ length: 10 }, (_, i) => ({ id: `p${i}`, name: `Milk ${i}`, price: { currentPrice: 2 + i / 10 } })) });

let passed = 0;
const t = async (name: string, fn: () => unknown) => { await fn(); passed++; console.log('ok -', name); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function makePage(html: string, url: string) {
  const dom = new JSDOM(html, { url, runScripts: 'outside-only' });
  const posts: any[] = [];
  const w = dom.window as any;
  w.ReactNativeWebView = { postMessage: (s: string) => { assert.equal(typeof s, 'string'); posts.push(JSON.parse(s)); } };
  const run = (script: string) => assert.equal(w.eval(script), true, 'script must evaluate to true');
  return { dom, w, posts, run };
}

(async () => {
  await t('search page posts its data with the nonce', async () => {
    const p = makePage(page(walmartData), 'https://www.walmart.com/search?q=milk');
    p.run(extractionScript('n1', markers));
    await sleep(30);
    assert.deepEqual(p.posts.map((m) => [m.kind, m.nonce]), [['data', 'n1']]);
    assert.deepEqual(p.posts[0].sources, [], 'nextData mode sends no extra sources');
    assert.deepEqual(walmartNextData({ nextDataText: p.posts[0].nextDataText }, ctx).products.map((x) => x.id), ['3']);
  });

  await t('block URL or title posts a challenge even when the page has its own data; an “Access Denied” page is a block, not a check', async () => {
    const a = makePage(page({ props: {} }, 'Robot or human?'), 'https://www.walmart.com/blocked?url=x');
    a.run(extractionScript('n2', markers));
    const b = makePage('<html><head><title>Access Denied</title></head><body>Reference #18</body></html>', 'https://www.kroger.com/search?query=milk');
    b.run(extractionScript('n3', markers, undefined, { waitFor: 'auto' }));
    // Cloudflare's block page: a bot-check title, but its words say it's a block.
    const c = makePage('<html><head><title>Attention Required! | Cloudflare</title></head><body><h1>Sorry, you have been blocked</h1></body></html>', 'https://www.example.com/s?q=milk');
    c.run(extractionScript('n3c', markers, undefined, { waitFor: 'auto' }));
    await sleep(30);
    assert.deepEqual([a.posts.map((m) => m.kind), b.posts.map((m) => m.kind), c.posts.map((m) => m.kind)], [['challenge'], ['blocked'], ['blocked']]);
    assert.deepEqual([b.posts[0].marker, c.posts[0].marker], ['Access Denied', 'Sorry, you have been blocked']);
  });

  await t('vendor ids in a short page body count; phrases in the body do not', async () => {
    const a = makePage('<html><head><title>Walmart</title></head><body><div id="px-captcha"></div></body></html>', 'https://www.walmart.com/search?q=milk');
    a.run(extractionScript('n4', markers));
    const b = makePage('<html><head><title>Shop</title></head><body><p>Just a moment, loading your store…</p></body></html>', 'https://www.example.com/s?q=milk');
    b.run(extractionScript('n5', markers, undefined, { waitFor: 'auto', intervalMs: 10, maxTries: 3 }));
    await sleep(100);
    assert.deepEqual(a.posts.map((m) => m.kind), ['challenge']);
    assert.deepEqual(b.posts.map((m) => m.kind), ['data'], 'gives up waiting and posts, instead of a false challenge');
  });

  await t('capture hook keeps JSON the page fetches, and auto mode posts once prices show up', async () => {
    const p = makePage('<html><head><title>Shop</title></head><body><div id="app"></div></body></html>', 'https://www.example.com/s?q=milk');
    p.w.fetch = (url: string) => Promise.resolve({
      headers: { get: () => 'application/json; charset=utf-8' },
      clone: () => ({ text: () => Promise.resolve(url.includes('search') ? apiJson : '{"ok":true}') }),
    });
    p.run(captureScript());
    p.run(captureScript()); // installing twice is harmless
    p.run(extractionScript('n6', markers, undefined, { waitFor: 'auto', intervalMs: 20, maxTries: 100 }));
    await sleep(60);
    assert.equal(p.posts.length, 0, 'still waiting for prices');
    await p.w.fetch('https://api.example.com/config');
    await p.w.fetch('https://api.example.com/search?q=milk&key=secret');
    await sleep(900);
    assert.deepEqual(p.posts.map((m) => m.kind), ['data']);
    assert.equal(p.w.__stretchCapture.items.length, 2);
    const labels = p.posts[0].sources.map((s: any) => s.label);
    assert.equal(labels[0], 'response https://api.example.com/search?q=milk&key=secret', 'newest first');
    const r = autoDetect({ sources: p.posts[0].sources, href: p.posts[0].href }, ctx);
    assert.equal(r.products.length, 10);
    assert.equal(r.source, 'response https://api.example.com/search (10)', 'query string (and keys) dropped from labels');
  });

  await t('capture hook also sees XMLHttpRequest responses', async () => {
    const server = createServer((req, res) => {
      if (req.url?.startsWith('/api')) { res.setHeader('content-type', 'application/json'); res.end(apiJson); }
      else { res.setHeader('content-type', 'text/html'); res.end('<html></html>'); }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const p = makePage('<html><body></body></html>', `${origin}/s?q=milk`);
    p.run(captureScript());
    p.w.eval(`var x = new XMLHttpRequest(); x.open('GET', '/api/search'); x.send(); true;`);
    for (let i = 0; i < 50 && !p.w.__stretchCapture.items.length; i++) await sleep(20);
    server.close();
    assert.equal(p.w.__stretchCapture.items.length, 1);
    assert.equal(p.w.__stretchCapture.items[0].url, '/api/search');
    assert.equal(p.w.__stretchCapture.priceKeys, 20, 'price and currentPrice in each of 10 items');
  });

  await t('read mode posts right away with everything on the page', async () => {
    const ld = { '@type': 'ItemList', itemListElement: [{ item: { name: 'Milk A', offers: { price: 1.5 } } }, { item: { name: 'Milk B', offers: { price: 2.5 } } }] };
    const p = makePage(`<html><head><title>Robot or human?</title><script type="application/ld+json">${JSON.stringify(ld)}</script></head><body></body></html>`, 'https://www.example.com/');
    p.w.__APOLLO_STATE__ = { a: 1 };
    p.run(extractionScript('n7', [], undefined, { mode: 'read' }));
    await sleep(20);
    assert.equal(p.posts[0].kind, 'data', 'read mode never reports a challenge');
    assert.deepEqual(p.posts[0].sources.map((s: any) => s.label), ['ld+json', '__APOLLO_STATE__']);
    assert.deepEqual(autoDetect({ sources: p.posts[0].sources }, ctx).products.map((x) => x.price), [1.5, 2.5]);
  });

  await t('pageScript: result is posted, null keeps polling, a throw posts an error', async () => {
    const ps = "function () { var tiles = document.querySelectorAll('[data-id]'); if (!tiles.length) return null; return Array.prototype.map.call(tiles, function (el) { return { id: el.getAttribute('data-id'), name: el.textContent }; }); }";
    const a = makePage('<html><body><div data-id="a">Eggs</div></body></html>', 'https://www.target.com/s?searchTerm=eggs');
    a.run(extractionScript('n8', [], ps));
    const b = makePage('<html><body></body></html>', 'https://www.target.com/', );
    b.run(extractionScript('n9', [], ps, { intervalMs: 20, maxTries: 1000 }));
    const c = makePage('<html><body></body></html>', 'https://www.target.com/');
    c.run(extractionScript('n10', [], 'function () { throw new Error("selector broke"); }'));
    await sleep(150);
    assert.deepEqual(a.posts[0].pageResult, [{ id: 'a', name: 'Eggs' }]);
    assert.equal(b.posts.length, 0);
    assert.deepEqual(c.posts.map((m) => [m.kind, m.error]), [['error', 'selector broke']]);
    b.dom.window.close();
  });

  const jsonResponse = (body: string, url = '') => ({
    status: 200, url,
    headers: { get: () => 'application/json' },
    clone: () => ({ text: () => Promise.resolve(body) }),
    text: () => Promise.resolve(body),
  });

  await t('capture hook records how each response was requested, and extraction posts it with the response', async () => {
    const p = makePage('<html><body></body></html>', 'https://www.example.com/s?q=milk');
    p.w.fetch = () => Promise.resolve(jsonResponse(apiJson));
    p.run(captureScript());
    await p.w.fetch('/api/search?q=milk', { method: 'post', headers: { 'X-Api-Key': 'k', 'Content-Type': 'application/json' }, body: '{"q":"milk"}', credentials: 'include' });
    await p.w.fetch({ url: 'https://api.example.com/graphql?q=milk', method: 'GET', headers: new Map([['x-client', 'web']]), credentials: 'same-origin' });
    await p.w.fetch({ url: 'https://api.example.com/upload', method: 'POST', headers: new Map(), credentials: 'same-origin' });
    await sleep(20);
    // Through JSON, as it crosses the bridge (and out of jsdom's realm).
    assert.deepEqual(JSON.parse(JSON.stringify(p.w.__stretchCapture.items.map((i: any) => i.req))), [
      { method: 'POST', url: 'https://www.example.com/api/search?q=milk', headers: { 'x-api-key': 'k', 'content-type': 'application/json' }, credentials: 'include', body: '{"q":"milk"}' },
      { method: 'GET', url: 'https://api.example.com/graphql?q=milk', headers: { 'x-client': 'web' }, credentials: 'same-origin' },
      { method: 'POST', url: 'https://api.example.com/upload', headers: {}, credentials: 'same-origin', opaqueBody: true },
    ]);
    p.run(extractionScript('n11', markers, undefined, { waitFor: 'auto', intervalMs: 10, maxTries: 2 }));
    await sleep(60);
    const sent = p.posts[0].sources.find((s: any) => s.label === 'response /api/search?q=milk');
    assert.equal(sent.request.url, 'https://www.example.com/api/search?q=milk');
    assert.equal(p.w.__stretchCapture.fetch !== p.w.fetch, true, 'the unhooked fetch is kept for replays');
  });

  await t('capture hook records XMLHttpRequest method, headers, body and credentials', async () => {
    const server = createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end(apiJson); });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const p = makePage('<html><body></body></html>', `${origin}/s?q=milk`);
    p.run(captureScript());
    p.w.eval(`var x = new XMLHttpRequest(); x.open('POST', '/api/search'); x.setRequestHeader('X-Token', 't1'); x.withCredentials = true; x.send('q=milk'); true;`);
    for (let i = 0; i < 50 && !p.w.__stretchCapture.items.length; i++) await sleep(20);
    server.close();
    assert.deepEqual(JSON.parse(JSON.stringify(p.w.__stretchCapture.items[0].req)), { method: 'POST', url: `${origin}/api/search`, headers: { 'x-token': 't1' }, credentials: 'include', body: 'q=milk' });
  });

  await t('replay script: sends the request with the page’s fetch and posts the JSON back with its nonce', async () => {
    const p = makePage('<html><body></body></html>', 'https://www.example.com/s?q=milk');
    const calls: any[] = [];
    p.w.fetch = (url: string, init: any) => { calls.push({ url, init }); return Promise.resolve(jsonResponse(apiJson, url)); };
    p.run(captureScript());
    p.run(replayScript('r1', { expect: 'json', method: 'GET', url: 'https://api.example.com/search?q=eggs', headers: { 'x-api-key': 'k' }, body: 'ignored for GET', credentials: 'include' }));
    await sleep(20);
    assert.deepEqual(JSON.parse(JSON.stringify(calls)), [{ url: 'https://api.example.com/search?q=eggs', init: { method: 'GET', headers: { 'x-api-key': 'k' }, credentials: 'include' } }]);
    assert.deepEqual(p.posts, [{ kind: 'replay', nonce: 'r1', status: 200, url: 'https://api.example.com/search?q=eggs', type: 'application/json', bytes: apiJson.length, text: apiJson }]);
    assert.equal(p.w.__stretchCapture.items.length, 0, 'replays bypass the capture hook');
  });

  await t('replay script: an HTML page comes back as its embedded data; failures post an error', async () => {
    const html = page(walmartData, 'eggs - Walmart.com').replace('</head>', '<script type="application/ld+json">{"x":1}</script></head>');
    const p = makePage('<html><body></body></html>', 'https://www.walmart.com/search?q=milk');
    p.w.fetch = (url: string) => Promise.resolve({ status: 200, url, headers: { get: () => 'text/html' }, text: () => Promise.resolve(html) });
    p.run(replayScript('r2', { expect: 'document', method: 'GET', url: 'https://www.walmart.com/search?q=eggs' }));
    await sleep(20);
    const m = p.posts[0];
    assert.deepEqual([m.kind, m.nonce, m.title, m.ld], ['replay', 'r2', 'eggs - Walmart.com', ['{"x":1}']]);
    assert.deepEqual(walmartNextData({ nextDataText: m.nextDataText }, ctx).products.map((x) => x.id), ['3']);
    assert.equal(m.short, html, 'short pages come whole, for bot-check markers');

    const q = makePage('<html><body></body></html>', 'https://www.example.com/');
    q.w.fetch = () => Promise.reject(new TypeError('Load failed'));
    q.run(replayScript('r3', { expect: 'json', method: 'GET', url: 'https://api.example.com/x' }));
    await sleep(20);
    assert.deepEqual(q.posts, [{ error: 'Load failed', kind: 'replay', nonce: 'r3' }]);
  });

  await t('progress: each new price-bearing response streams back once, with its request; stop ends the wait', async () => {
    const p = makePage('<html><head><title>milk - Shop</title></head><body></body></html>', 'https://www.example.com/s?q=milk');
    p.w.fetch = (url: string) => Promise.resolve(jsonResponse(url.includes('config') ? '{"ok":true}' : apiJson, url));
    p.run(captureScript());
    p.run(extractionScript('n12', markers, undefined, { waitFor: 'auto', progress: true, intervalMs: 10, maxTries: 1000, giveUpMs: 0 }));
    await p.w.fetch('https://api.example.com/config');
    await p.w.fetch('https://api.example.com/search?q=milk');
    await sleep(60);
    const progress = p.posts.filter((m) => m.kind === 'progress');
    assert.equal(progress.length, 1, 'sent once; the config response has no prices');
    assert.deepEqual(progress[0].sources.map((s: any) => [s.label, s.request.url]), [['response https://api.example.com/search?q=milk', 'https://api.example.com/search?q=milk']]);
    assert.equal(progress[0].title, 'milk - Shop');
    p.run(stopScript('n12'));
    await sleep(900);
    assert.deepEqual(p.posts.map((m) => m.kind), ['progress'], 'stopped: no final post');
  });

  await t('give up: a loaded page with nothing arriving posts what it has after a short wait, not the full time', async () => {
    const p = makePage('<html><head><title>Kroger</title></head><body><div id="app"></div></body></html>', 'https://www.kroger.com/search?query=milk');
    p.run(captureScript());
    p.run(extractionScript('n13', markers, undefined, { waitFor: 'auto', intervalMs: 10, maxTries: 1000, giveUpMs: 80 }));
    await sleep(40);
    assert.equal(p.posts.length, 0);
    await sleep(200);
    assert.deepEqual(p.posts.map((m) => [m.kind, m.title]), [['data', 'Kroger']]);
    assert.deepEqual(p.posts[0].sources, []);
  });

  await t('details mode: a product page posts its share tags and structured data first, once it has them', async () => {
    const ld = { '@type': 'Product', name: 'Great Value Whole Milk', offers: { price: '3.48' } };
    const html = `<html><head><title>Great Value Whole Milk - Walmart.com</title>
      <meta property="og:image" content="https://i/og.jpg"><meta name="description" content="Fresh milk">
      <meta property="og:title" content="Great Value Whole Milk"><meta name="viewport" content="width=device-width">
      <script type="application/ld+json">${JSON.stringify(ld)}</script></head><body></body></html>`;
    const p = makePage(html, 'https://www.walmart.com/ip/10450114');
    p.run(captureScript());
    p.run(extractionScript('n14', markers, undefined, { waitFor: 'details', intervalMs: 10, maxTries: 1000, giveUpMs: 3000 }));
    await sleep(60);
    assert.deepEqual(p.posts.map((m) => m.kind), ['data'], 'no need to wait out the give-up time');
    assert.deepEqual(p.posts[0].sources.map((s: any) => s.label), ['meta', 'ld+json']);
    assert.deepEqual(JSON.parse(p.posts[0].sources[0].text), { 'og:image': 'https://i/og.jpg', description: 'Fresh milk', 'og:title': 'Great Value Whole Milk' });
    const d = parseProductPage({ href: p.posts[0].href, sources: p.posts[0].sources }, { retailer: 'walmart', storeId: '', id: '10450114', name: 'Great Value Whole Milk', price: 3.48 });
    assert.deepEqual([d.price, d.images], [3.48, ['https://i/og.jpg']]);

    const bare = makePage('<html><head><title>Item</title><meta property="og:title" content="Item"></head><body></body></html>', 'https://www.example.com/p/1');
    bare.run(captureScript());
    bare.run(extractionScript('n15', markers, undefined, { waitFor: 'details', intervalMs: 10, maxTries: 1000, giveUpMs: 80 }));
    await sleep(40);
    assert.equal(bare.posts.length, 0, 'waits a moment for data that might still come');
    await sleep(150);
    assert.deepEqual(bare.posts.map((m) => [m.kind, m.sources.map((s: any) => s.label)]), [['data', ['meta']]]);
  });

  await t('lighter pages: a content policy against images, fonts and video goes in as soon as the page has a head', async () => {
    const p = makePage('<html><head><title>Shop</title></head><body></body></html>', 'https://www.example.com/s?q=milk');
    p.run(lightScript());
    p.run(lightScript());
    const metas = p.w.document.querySelectorAll('meta[http-equiv="Content-Security-Policy"]');
    assert.equal(metas.length, 1, 'once');
    assert.equal(metas[0].getAttribute('content'), "img-src data: blob:; font-src data:; media-src 'none'");
    assert.equal(p.w.document.head.firstChild, metas[0], 'first in the head, before anything loads');

    // Injected before the page has a head: it waits for one.
    const q = makePage('<html><head></head><body></body></html>', 'https://www.example.com/');
    q.w.document.head.remove();
    q.run(lightScript());
    assert.equal(q.w.document.querySelector('meta[data-stretch-light]'), null);
    q.w.document.documentElement.prepend(q.w.document.createElement('head'));
    await sleep(10);
    assert.ok(q.w.document.head.querySelector('meta[data-stretch-light]'));
  });

  await t('data use: every post carries the page’s own count of what it loaded, estimating files it can’t measure', async () => {
    const p = makePage(page(walmartData), 'https://www.walmart.com/search?q=milk');
    p.w.performance.getEntriesByType = (type: string) =>
      type === 'navigation'
        ? [{ transferSize: 20_000 }]
        : [
            { initiatorType: 'fetch', transferSize: 5_000, encodedBodySize: 4_800, responseStart: 12 },
            { initiatorType: 'script', transferSize: 0, encodedBodySize: 90_000, responseStart: 3 },
            { initiatorType: 'img', transferSize: 0, encodedBodySize: 0, responseStart: 0 },
          ];
    p.run(extractionScript('n16', markers));
    await sleep(30);
    assert.deepEqual(p.posts[0].usage, { bytes: 50_000, files: 4, estimated: 1 }, 'cached files count nothing; an unmeasured image counts 25 KB');
  });

  await t('store script: presses the nearest store’s "make this my store" once, waits for the site, names the store', async () => {
    const html = `<html><head><title>Walmart Stores Near Me</title></head><body>
      <button>Pickup or delivery?</button>
      <div class="card"><h3>Secaucus Supercenter</h3><p>400 Park Pl, Secaucus, NJ 07094</p><button id="a">Make this my store</button><a href="/store/3520-secaucus-nj">Store details</a></div>
      <div class="card"><h3>North Bergen Supercenter</h3><button id="b">Make this my store</button></div>
    </body></html>`;
    const p = makePage(html, 'https://www.walmart.com/store-finder?location=10001&distance=50');
    const clicks: string[] = [];
    for (const id of ['a', 'b']) p.w.document.getElementById(id).addEventListener('click', () => clicks.push(id));
    const script = storeScript('s1', markers, STORE_BUTTONS, { settleMs: 50, intervalMs: 10 });
    p.run(script);
    p.run(script); // The host injects it again after the load; it runs once per page.
    await sleep(20);
    assert.deepEqual(clicks, ['a'], 'pressed once, on the nearest store');
    assert.equal(p.posts.length, 0, 'gives the site time to save it');
    await sleep(90);
    assert.deepEqual(p.posts.map((m) => [m.kind, m.nonce, m.pageResult]), [
      [
        'data',
        's1',
        {
          pressed: 'Make this my store',
          label: 'Secaucus Supercenter',
          lines: ['Secaucus Supercenter', '400 Park Pl, Secaucus, NJ 07094', 'Make this my store', 'Store details'],
          links: ['/store/3520-secaucus-nj'],
        },
      ],
    ]);
    assert.deepEqual(storeFromFinder(p.posts[0].pageResult, '10001'), { name: 'Secaucus Supercenter', address: '400 Park Pl, Secaucus, NJ 07094', id: '3520' });
  });

  await t('store script: never presses twice across a navigation; gives up without a button; reports a bot check', async () => {
    // The press navigated to the store's page in the same tab: sessionStorage remembers it.
    const next = makePage('<html><body><button>Make this my store</button></body></html>', 'https://www.walmart.com/store/3520');
    let pressed = 0;
    next.w.document.querySelector('button').addEventListener('click', () => pressed++);
    next.w.sessionStorage.setItem('__stretchPressed:s2', JSON.stringify({ pressed: 'Make this my store', label: 'Secaucus Supercenter', at: Date.now() - 1000 }));
    next.run(storeScript('s2', markers, STORE_BUTTONS, { settleMs: 50, intervalMs: 10 }));
    await sleep(30);
    assert.equal(pressed, 0);
    assert.deepEqual(next.posts[0].pageResult, { pressed: 'Make this my store', label: 'Secaucus Supercenter', lines: [], links: [] });

    const none = makePage('<html><body><button>Find stores</button><button>My store: Seattle</button></body></html>', 'https://www.example.com/stores');
    none.run(storeScript('s3', markers, STORE_BUTTONS, { intervalMs: 5, maxTries: 3 }));
    const blocked = makePage('<html><head><title>Access Denied</title></head><body></body></html>', 'https://www.kroger.com/stores/search');
    blocked.run(storeScript('s4', markers, STORE_BUTTONS, { intervalMs: 5 }));
    await sleep(60);
    assert.deepEqual(none.posts.map((m) => [m.kind, m.error]), [['error', 'button_not_found']]);
    assert.deepEqual(blocked.posts.map((m) => m.kind), ['challenge']);
  });

  await t('store script: with a store to choose, presses only that store’s button, found by its page’s link or its name', async () => {
    const html = `<html><body>
      <div class="card"><h3>Secaucus Supercenter</h3><button id="a">Make this my store</button><a href="/store/3520-secaucus-nj">Details</a></div>
      <div class="card"><h3>Jersey City Supercenter</h3><button id="b">Make this my store</button><a href="/store/2280-jersey-city-nj">Details</a></div>
      <div class="card"><h3>Teterboro Supercenter</h3><button id="c">Make this my store</button></div>
    </body></html>`;
    const clicks: string[] = [];
    const press = async (nonce: string, target: { id?: string; name?: string }) => {
      const p = makePage(html, 'https://www.walmart.com/store-finder?location=10001');
      for (const id of ['a', 'b', 'c']) p.w.document.getElementById(id).addEventListener('click', () => clicks.push(id));
      p.run(storeScript(nonce, markers, STORE_BUTTONS, { settleMs: 20, intervalMs: 5, maxTries: 4, target }));
      await sleep(60);
      return p.posts;
    };
    const byLink = await press('t1', { id: '2280', name: 'Somewhere else' });
    const byName = await press('t2', { id: '5281', name: 'Teterboro Supercenter' });
    const missing = await press('t3', { id: '9999', name: 'Not listed' });
    assert.deepEqual(clicks, ['b', 'c'], 'the store asked for, not the nearest');
    assert.deepEqual([byLink[0].pageResult.label, byName[0].pageResult.label], ['Jersey City Supercenter', 'Teterboro Supercenter']);
    assert.deepEqual(missing.map((m) => [m.kind, m.error]), [['error', 'button_not_found']], 'another store isn’t pressed instead');
  });

  await t('store list: types the ZIP into the finder, as a user would, and posts the stores its page fetched', async () => {
    const p = makePage(
      `<html><head><title>Find a store</title></head><body><header><input type="search" placeholder="Search products"></header>
       <form id="f"><input id="where" placeholder="ZIP code, or city and state"><button>Find</button></form></body></html>`,
      'https://www.example.com/stores',
    );
    p.w.__stretchCapture = { items: [], priceKeys: 0, lastAt: 0 };
    const typed: string[] = [];
    const box = p.w.document.getElementById('where');
    box.addEventListener('input', () => typed.push(box.value));
    p.w.document.getElementById('f').addEventListener('submit', (e: Event) => {
      e.preventDefault();
      // The finder's own script asks for the stores near what was typed.
      setTimeout(() => p.w.__stretchCapture.items.push({ url: 'https://www.example.com/api/stores?q=' + box.value, text: JSON.stringify({ stores: [
        { storeNumber: '12', name: 'Chelsea', address: { line1: '100 W 23rd St', city: 'New York', state: 'NY', zip: '10011' }, distance: '1.4 mi' },
        { storeNumber: '7', name: 'Midtown', address: { line1: '50 W 34th St', city: 'New York', state: 'NY', zip: '10001' }, distance: '0.3 mi' },
      ] }) }), 20);
    });
    p.run(storeListScript('l1', '10001', markers, { quietMs: 40, intervalMs: 10, maxMs: 2000 }));
    p.run(storeListScript('l1', '10001', markers, { quietMs: 40, intervalMs: 10, maxMs: 2000 }));
    await sleep(200);
    assert.deepEqual(typed, ['10001'], 'into the finder’s box, once, not the product search');
    assert.equal(p.posts.length, 1);
    const stores = nearbyStores(p.posts[0]);
    assert.deepEqual(stores.map((st) => [st.id, st.name, st.miles]), [['7', 'Midtown', 0.3], ['12', 'Chelsea', 1.4]]);
  });

  await t('store list: a ZIP already in the address isn’t typed; store cards when no data came; a bot check says so', async () => {
    const p = makePage(
      `<html><body><input placeholder="zip code"><ul>
        <li><a href="/sl/brooklyn-atlantic-terminal/1340">Brooklyn Atlantic Terminal</a><p>139 Flatbush Ave</p><p>Brooklyn, NY 11217</p><p>4.8 mi</p></li>
        <li><a href="/sl/queens-place/1920">Queens Place</a><p>88-01 Queens Blvd</p><p>Elmhurst, NY 11373</p><p>6.1 mi</p></li>
        <li><a href="/help/contact">Contact us 24/7</a></li>
      </ul></body></html>`,
      'https://www.target.com/store-locator/find-stores/10001',
    );
    let typed = 0;
    p.w.document.querySelector('input').addEventListener('input', () => typed++);
    p.run(storeListScript('l2', '10001', markers, { quietMs: 20, intervalMs: 10 }));
    await sleep(120);
    assert.equal(typed, 0);
    assert.equal(p.posts[0].pageResult.zipIn, 'url');
    assert.deepEqual(nearbyStores({ ...p.posts[0], cards: p.posts[0].pageResult.cards }).map((st) => [st.id, st.miles]), [['1340', 4.8], ['1920', 6.1]]);

    // After the typed ZIP reloaded the page, it isn't typed again.
    const again = makePage('<html><body><input name="zip"></body></html>', 'https://www.example.com/stores?page=results');
    again.w.sessionStorage.setItem('__stretchZipTyped:l3', '1');
    let retyped = 0;
    again.w.document.querySelector('input').addEventListener('input', () => retyped++);
    again.run(storeListScript('l3', '10001', markers, { quietMs: 20, intervalMs: 10 }));
    const blocked = makePage('<html><head><title>Access Denied</title></head><body></body></html>', 'https://www.kroger.com/stores/search');
    blocked.run(storeListScript('l4', '10001', markers, { intervalMs: 5 }));
    await sleep(100);
    assert.deepEqual([retyped, again.posts.map((m) => m.kind), again.posts[0].pageResult.zipIn], [0, ['data'], 'next'], 'all of this page came after the ZIP was typed');
    assert.deepEqual(blocked.posts.map((m) => m.kind), ['challenge']);
  });

  await t('store list: says how the ZIP reached the page; what it listed before the ZIP was typed is left out; requests go without headers', async () => {
    const ohio = JSON.stringify({ stores: [{ store_id: '1969', name: 'Dublin', address: { line1: '6555 Sawmill Rd', city: 'Dublin', state: 'OH', zip: '43017' }, distance: 0.2 }] });
    const houston = JSON.stringify({ stores: [{ store_id: '2093', name: 'Houston Heights', address: { line1: '2580 Shearn St', city: 'Houston', state: 'TX', zip: '77007' }, distance: 1.1 }] });
    const finder = (body: string) =>
      makePage(`<html><head><title>Find a store</title></head><body>${body}</body></html>`, 'https://www.example.com/store-locator/find-stores');
    // The page lists the stores near where it thinks the phone is, then those near the ZIP typed into its box.
    const p = finder('<form id="f"><input id="where" placeholder="ZIP code, or city and state"><button>Find</button></form>');
    p.w.__stretchCapture = { items: [
      { url: 'https://www.example.com/api/stores?lat=40.1&lng=-83.11', text: ohio, req: { method: 'GET', url: 'https://www.example.com/api/stores?lat=40.1&lng=-83.11', headers: { 'x-api-key': 'k' } } },
    ], priceKeys: 0, lastAt: 0 };
    p.w.document.getElementById('f').addEventListener('submit', (e: Event) => {
      e.preventDefault();
      setTimeout(() => p.w.__stretchCapture.items.push({
        url: 'https://www.example.com/api/stores',
        text: houston,
        req: { method: 'POST', url: 'https://www.example.com/api/stores', headers: { 'x-api-key': 'k' }, body: '{"place":"77007"}' },
      }), 20);
    });
    p.run(storeListScript('l6', '77007', markers, { quietMs: 40, intervalMs: 10, maxMs: 2000 }));
    await sleep(200);
    const post = p.posts[0];
    assert.equal(post.pageResult.zipIn, 'box');
    assert.deepEqual(post.sources.map((s: { label: string; request?: unknown }) => [s.label, s.request]), [
      ['response https://www.example.com/api/stores', { method: 'POST', url: 'https://www.example.com/api/stores', body: '{"place":"77007"}' }],
    ], 'only what came after the ZIP was typed, and none of its request’s headers');
    const read = nearbyList({ ...post, zipIn: post.pageResult.zipIn }, undefined, '77007');
    assert.deepEqual([read.tie, read.stores.map((st) => st.id)], ['asked', ['2093']]);

    // A page with no box the app knows for a ZIP: what it listed goes back all the same, said not to be for the ZIP.
    const boxless = finder('<div id="map"></div>');
    boxless.w.__stretchCapture = { items: [{ url: 'https://www.example.com/api/stores?lat=40.1&lng=-83.11', text: ohio }], priceKeys: 0, lastAt: 0 };
    boxless.run(storeListScript('l7', '77007', markers, { quietMs: 20, intervalMs: 10, maxMs: 60 }));
    await sleep(150);
    assert.equal(boxless.posts[0].pageResult.zipIn, 'none');
    assert.equal(nearbyList({ ...boxless.posts[0], zipIn: 'none' }, undefined, '77007').tie, 'none');
  });

  await t('store list: stores in the page’s own data blocks count, as Whole Foods’ finder writes them (an "a-state" block)', async () => {
    const state = { isDesktop: false, locations: [
      { locationName: 'West Lane', locationId: '7KKZrXZ3zM', geocode: { latitude: 40.00653, longitude: -83.052569 },
        address: { addressLines: ['1555 W Lane Ave'], city: 'Upper Arlington', state: 'OH', postalCode: '43221-3955' }, distance: 8.8099, distanceUnit: 'miles', storeCode: '10385' },
      { locationName: 'Columbus', locationId: '6Po2SHCiuG', geocode: { latitude: 40.0981, longitude: -83.08666 },
        address: { addressLines: ['3670 W Dublin Granville Rd'], city: 'Columbus', state: 'OH', postalCode: '43235-4904' }, distance: 2.8071, distanceUnit: 'miles', storeCode: '10214' },
    ] };
    const p = makePage(
      `<html><body><div id="list"></div><script type="a-state" data-a-state='{"key":"list-page-state"}'>${JSON.stringify(state)}</script></body></html>`,
      'https://www.wholefoodsmarket.com/aplf/list?almBrandId=VUZHIFdob2xlIEZvb2Rz&context=wholefoods&postalCode=43017',
    );
    p.run(storeListScript('l5', '43017', markers, { quietMs: 20, intervalMs: 10 }));
    await sleep(100);
    assert.deepEqual(p.posts[0].sources.map((s: { label: string }) => s.label), ['json script']);
    assert.deepEqual(nearbyStores(p.posts[0]).map((st) => [st.id, st.name, st.address, st.miles]), [
      ['10214', 'Columbus', '3670 W Dublin Granville Rd, Columbus, OH 43235-4904', 2.81],
      ['10385', 'West Lane', '1555 W Lane Ave, Upper Arlington, OH 43221-3955', 8.81],
    ], 'by their store numbers, not the finder’s ids for the places, nearest first');
  });

  await t('store list: store cards linked as Meijer links a store’s page (/store-locator/58.html) count', async () => {
    const p = makePage(
      `<html><body><input placeholder="Search by city, state or ZIP"><ul>
        <li><h3>Sawmill Rd</h3><p>6175 Sawmill Rd</p><p>Dublin, OH 43017</p><p>1.1 mi</p><a href="/shopping/store-locator/58.html">Store details</a></li>
        <li><h3>Lewis Center</h3><p>8870 Columbus Pike</p><p>Lewis Center, OH 43035</p><p>6.4 mi</p><a href="/shopping/store-locator/143.html">Store details</a></li>
        <li><a href="/shopping/store-locator.html">Find another store</a></li>
      </ul></body></html>`,
      'https://www.meijer.com/shopping/store-locator.html?zip=43017',
    );
    p.run(storeListScript('l6', '43017', markers, { quietMs: 20, intervalMs: 10 }));
    await sleep(100);
    assert.deepEqual(nearbyStores({ ...p.posts[0], cards: p.posts[0].pageResult.cards }).map((st) => [st.id, st.miles]), [['58', 1.1], ['143', 6.4]]);
  });

  await t('store request: the site’s own request goes out once from its page, with its cookies; a refusal or a bot check says so', async () => {
    const req = { method: 'PUT', url: 'https://www.wholefoodsmarket.com/api/store-affinity', body: '{"storeId":"10214"}', headers: { 'Content-Type': 'application/json' } };
    const make = (status: number, html = '<html><body><div id="list"></div></body></html>') => {
      const p = makePage(html, 'https://www.wholefoodsmarket.com/aplf/list?postalCode=43017');
      const sent: unknown[] = [];
      p.w.fetch = (url: string, init: unknown) => {
        sent.push([url, init]);
        return Promise.resolve({ status });
      };
      return { p, sent };
    };
    const ok = make(200);
    const script = storeRequestScript('r1', markers, req, { intervalMs: 5 });
    ok.p.run(script);
    ok.p.run(script); // The host injects it again after the load; it's sent once per page.
    await sleep(40);
    // Made in the page's own realm: compared as plain data.
    assert.deepEqual(JSON.parse(JSON.stringify(ok.sent)), [[req.url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: '{"storeId":"10214"}' }]]);
    assert.deepEqual(ok.p.posts.map((m) => [m.kind, m.nonce, m.pageResult]), [['data', 'r1', { status: 200 }]]);

    const refused = make(403);
    refused.p.run(storeRequestScript('r2', markers, req, { intervalMs: 5 }));
    const checked = make(200, '<html><head><title>Robot or human?</title></head><body></body></html>');
    checked.p.run(storeRequestScript('r3', markers, req, { intervalMs: 5 }));
    await sleep(40);
    assert.deepEqual(refused.p.posts.map((m) => [m.kind, m.error]), [['error', 'store_request_http_403']]);
    assert.deepEqual([checked.p.posts.map((m) => m.kind), checked.sent.length], [['challenge'], 0], 'a bot check is said, and nothing is sent');
  });

  await t('store label: a search page says which store it’s set to, from its header; links to choose one don’t count', async () => {
    const header = `<header><a href="/stores">Find a store</a><button aria-label="Change your store">Change</button>
      <button data-test="@web/StoreMenu"><span>My Store</span><span>Brooklyn Atlantic Terminal</span></button></header>`;
    const p = makePage(`<html><head><title>milk : Target</title></head><body>${header}<div id="root"></div>${`<script id="__NEXT_DATA__" type="application/json">{"props":{}}</script>`}</body></html>`, 'https://www.target.com/s?searchTerm=milk');
    p.run(extractionScript('st1', markers));
    await sleep(30);
    assert.equal(p.posts[0].kind, 'data');
    assert.deepEqual(parseStoreLabel(p.posts[0].store), { name: 'Brooklyn Atlantic Terminal' });

    const aria = makePage('<html><body><header><button aria-label="Your store: Secaucus Supercenter, open until 11pm">Store</button></header></body></html>', 'https://www.walmart.com/');
    aria.run(extractionScript('st2', markers, undefined, { waitFor: 'loaded', intervalMs: 10 }));
    const none = makePage('<html><body><header><a>Find a store</a><button>Choose your store</button><p>Your store hours</p></header></body></html>', 'https://www.example.com/');
    none.run(extractionScript('st3', markers, undefined, { waitFor: 'loaded', intervalMs: 10 }));
    await sleep(80);
    assert.deepEqual([aria.posts[0].kind, aria.posts[0].nonce, parseStoreLabel(aria.posts[0].store)], ['data', 'st2', { name: 'Secaucus Supercenter' }]);
    assert.equal(none.posts[0].store, undefined, 'names no store');
  });

  await t('suggestions: types into the site’s search box, as a user would, and reads its suggestion list', async () => {
    const p = makePage(
      `<html><body><header><form><input type="search" id="q" placeholder="Search"><ul role="listbox" id="lb"></ul></form></header>
       <div role="option">Delivery</div></body></html>`,
      'https://www.target.com/',
    );
    const box = p.w.document.getElementById('q');
    const typed: string[] = [];
    box.addEventListener('input', () => {
      typed.push(box.value);
      setTimeout(() => {
        p.w.document.getElementById('lb').innerHTML = ['milk', 'whole milk', 'milk 2% gallon', 'Shop all deals'].map((x) => `<li role="option">${x}</li>`).join('');
      }, 30);
    });
    p.run(suggestScript('sg1', 'mil', { settleMs: 40, intervalMs: 10, maxMs: 1000 }));
    await sleep(150);
    assert.deepEqual(typed, ['mil'], 'the site saw the typing');
    assert.deepEqual(p.posts, [{ kind: 'suggest', nonce: 'sg1', items: ['milk', 'whole milk', 'milk 2% gallon'], how: 'list' }], 'only suggestions with what was typed');
    assert.equal(p.w.location.href, 'https://www.target.com/', 'nothing submitted');
  });

  await t('suggestions: from the suggestion data the site fetched, when it shows no list; no search box says so', async () => {
    const p = makePage('<html><body><input name="query" id="q"></body></html>', 'https://www.aldi.us/');
    p.w.__stretchCapture = { items: [{ url: 'https://www.aldi.us/old', text: '{"q":"milk old"}' }], priceKeys: 0, lastAt: 0 };
    p.w.document.getElementById('q').addEventListener('input', () => {
      p.w.__stretchCapture.items.push({ url: 'https://www.aldi.us/api/typeahead', text: JSON.stringify({ terms: [{ text: 'milk' }, { text: 'oat milk' }], link: 'https://x/milk', other: 'bread' }) });
    });
    p.run(suggestScript('sg2', 'milk', { settleMs: 30, intervalMs: 10, maxMs: 1000 }));
    await sleep(120);
    assert.deepEqual(p.posts.map((m) => [m.items, m.how]), [[['milk', 'oat milk'], 'response']], 'from what arrived after typing, not before');

    const none = makePage('<html><body><p>No search here</p></body></html>', 'https://www.example.com/');
    none.run(suggestScript('sg3', 'milk'));
    assert.deepEqual(none.posts.map((m) => [m.items, m.how]), [[[], 'no_box']]);
  });

  await t('loaded: a page kept to type into posts as soon as it has loaded, without its data', async () => {
    const p = makePage('<html><head><title>ALDI</title></head><body><header><button aria-label="Your store: ALDI Brooklyn">Store</button></header></body></html>', 'https://www.aldi.us/');
    p.run(extractionScript('ld1', markers, undefined, { waitFor: 'loaded', intervalMs: 10 }));
    await sleep(80);
    assert.deepEqual([p.posts[0].kind, p.posts[0].sources, p.posts[0].store], ['data', [], 'Your store ALDI Brooklyn']);
  });

  await t('text: a fees page posts what it says, a line per block, without its scripts, data or other sources', async () => {
    const help = [
      '<html><head><title>Delivery fees</title><script type="application/ld+json">{"price": "$1.00"}</script></head><body>',
      '<h1>Delivery &amp; pickup fees</h1>',
      '<p>Standard delivery from store: <strong>$9.95</strong> delivery fee applies.</p>',
      '<script>var promo = "Free delivery for $0.01";</script>',
      '<ul><li>Pick up orders over $35 for free.</li><li>Orders are packed by a store team member who checks each item.</li></ul>',
      '<p>Delivery windows run from 6 a.m. to 10 p.m. in most areas, seven days a week, depending on the store.</p>',
      '</body></html>',
    ].join('');
    const p = makePage(help, 'https://www.example.com/help/fees');
    p.run(extractionScript('tx1', markers, undefined, { waitFor: 'text', textSettleMs: 20, intervalMs: 10 }));
    await sleep(250);
    assert.deepEqual(p.posts.map((m) => m.kind), ['data']);
    const post = p.posts[0];
    assert.deepEqual([post.sources, post.nextDataText], [[], null], 'only the words');
    assert.equal(
      post.text,
      [
        'Delivery & pickup fees',
        'Standard delivery from store: $9.95 delivery fee applies.',
        'Pick up orders over $35 for free.',
        'Orders are packed by a store team member who checks each item.',
        'Delivery windows run from 6 a.m. to 10 p.m. in most areas, seven days a week, depending on the store.',
      ].join('\n'),
      'inline parts stay in their sentence; scripts are left out',
    );

    const short = makePage('<html><head><title>Fees</title></head><body><p>Pickup is free.</p></body></html>', 'https://www.example.com/help/short');
    short.run(extractionScript('tx2', markers, undefined, { waitFor: 'text', textSettleMs: 20, giveUpMs: 40, intervalMs: 10 }));
    await sleep(250);
    assert.deepEqual([short.posts.map((m) => m.kind), short.posts[0]?.text], [['data'], 'Pickup is free.'], 'a short page is posted once it has gone quiet');

    const blocked = makePage('<html><head><title>Access Denied</title></head><body>Reference #18</body></html>', 'https://www.example.com/help/fees');
    blocked.run(extractionScript('tx3', markers, undefined, { waitFor: 'text', intervalMs: 10 }));
    await sleep(50);
    assert.deepEqual(blocked.posts.map((m) => m.kind), ['blocked'], 'a block, not a bot check');
  });

  console.log(`\n${passed} injected-script tests passed`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
