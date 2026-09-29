/// <reference types="node" />
// Fake Walmart, Target and redsky sites, served from this machine over HTTPS, and a headless Chromium that can reach
// only them: for checking the cloud code (src/cloud) against a real browser without visiting a live site. Used by
// scripts/cloud-local-check.ts.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:https';
import { join } from 'node:path';

export const PORT = 8443;
const root = join(__dirname, '..');
const walmartFixture = JSON.parse(readFileSync(join(root, 'tests/fixtures/cloud/walmart-search-milk.json'), 'utf8'));
const targetFixture = JSON.parse(readFileSync(join(root, 'tests/fixtures/cloud/target-plp-search-milk.json'), 'utf8'));
/** Target's own page for store 2641, cut down (see its comment): the fake's store pages are made from it. */
const targetStoreFixture = readFileSync(join(root, 'tests/fixtures/cloud/target-store-2641.html'), 'utf8');
/** What the fake sites were asked for: heavy files (which blocking should keep away), store saves, redsky answers. */
export const hits = { image: 0, font: 0, setStore: 0, redsky: 0, product: 0, home: 0, storePage: 0, targetStorePage: 0 };

export function chromePath(): string {
  if (process.env.CHROME) return process.env.CHROME;
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH ?? '/opt/pw-browsers';
  const dir = readdirSync(base).find((d) => /^chromium-\d+$/.test(d));
  const path = dir ? join(base, dir, 'chrome-linux', 'chrome') : '';
  if (!path || !existsSync(path)) throw new Error('No Chromium found: set CHROME=/path/to/chrome');
  return path;
}

// --- Fake sites --------------------------------------------------------------------------------------------

const cookieOf = (header: string | undefined, name: string) => new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(header ?? '')?.[1];
const html = (title: string, body: string) => `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`;

function walmartSearch(term: string, store: string): string {
  const data = JSON.parse(JSON.stringify(walmartFixture));
  const ini = data.props.pageProps.initialData;
  const page = term === 'mismatch' ? '1111' : store;
  for (const m of [ini.pageMetadata, ini.contentLayout.pageMetadata, ini.searchResult.pageMetadata]) if (m?.location) m.location.storeId = page;
  for (const item of ini.searchResult.itemStacks[0].items) if (item.name) item.name = `[${term}] ${item.name}`;
  // Heavy files the page asks for: blocked by pattern, they never reach this server.
  return html(`${term} - Walmart.com`, `<img src="/big.png"><link rel="preload" as="font" href="/brand.woff2" crossorigin><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(data)}</script>`);
}

function storePage(id: string, current: string | undefined): string {
  // Already this browser's store: the page says so, with no button. 4040: a store that doesn't exist.
  if (current === id) return html(`Walmart Supercenter ${id}`, `<div id="app">Store ${id} · Your store</div>`);
  if (id === '4040') return html('Page not found', '<div id="app">This store couldn’t be found.</div>');
  // 7777: a "Robot or human?" dialog over the page that clears by itself after 12 s. 9999: one that never clears.
  const check =
    id === '7777' || id === '9999'
      ? `<div role="dialog" id="px"><h2>Robot or human?</h2><p>Activate and hold the button to confirm that you’re human.</p><div id="px-captcha"></div></div>${
          id === '7777' ? '<script>setTimeout(() => document.getElementById("px").remove(), 12000)</script>' : ''
        }`
      : '';
  // The button shows up late, as a script-drawn page's would, and saves the store with a request of its own.
  return html(
    `Walmart Supercenter ${id}`,
    `${check}<div id="app">Store ${id}</div><script>
      setTimeout(() => {
        const b = document.createElement('button');
        b.innerHTML = '<span>Make this my store</span>';
        // Saved with a request of its own, then the page reloads, as a site may: the app reads the new page.
        b.onclick = () => fetch('/api/set-store?id=${id}', { method: 'POST' }).then(() => setTimeout(() => location.reload(), 300));
        document.getElementById('app').appendChild(b);
      }, 800);
    </script>`,
  );
}

/**
 * Target's stores, as the fake knows them. 2766 is the one Target picks for this machine's connection, as the real
 * site picked it for a San Francisco address (2026-09-29). 4242's "Shop this store" does nothing (the real one asks
 * Target's API about the store first, which can refuse); 4040 has no page.
 */
const TARGET_STORES: Record<string, { name: string; zip: string; state: string; lat: number; lon: number }> = {
  '2766': { name: 'San Francisco Central', zip: '94103', state: 'CA', lat: 37.7839, lon: -122.4071 },
  '1375': { name: 'Minneapolis Uptown', zip: '55408', state: 'MN', lat: 44.9483, lon: -93.2977 },
  '4242': { name: 'Button Broken', zip: '10001', state: 'NY', lat: 40.7506, lon: -73.9972 },
};
const PICKED = '2766';

/** A Target store cookie's store ("DSI_1375|DSN_…|DSZ_55408" → "1375"), and a UserLocation's ZIP. */
const cookieStoreOf = (header: string | undefined) => /DSI_([^|;]+)/.exec(decodeURIComponent(cookieOf(header, 'fiatsCookie') ?? ''))?.[1];
const cookieZipOf = (header: string | undefined) => /^(\d{5})/.exec(decodeURIComponent(cookieOf(header, 'UserLocation') ?? ''))?.[1];

/** What Target's site sets for a new visitor: the store and place it picks from where it thinks the connection is. */
function targetFirstVisit(header: string | undefined): Record<string, string[]> {
  if (cookieOf(header, 'fiatsCookie')) return {};
  const s = TARGET_STORES[PICKED];
  const named = `DSI_${PICKED}|DSN_${encodeURIComponent(s.name)}|DSZ_${s.zip}`;
  return {
    'set-cookie': [
      `fiatsCookie=${named}; Domain=target.com; Path=/; Secure; SameSite=Lax`,
      `sddStore=${named}; Domain=target.com; Path=/`,
      `UserLocation=94104|37.790|-122.400|CA|US; Domain=target.com; Path=/; Secure; SameSite=Lax`,
    ],
  };
}

/**
 * A Target store's own page, made from the real one's (tests/fixtures/cloud/target-store-2641.html) with this store's
 * details in its data; its "Shop this store" drawn late, as the real page's script draws it, and saving the store in
 * the site's cookies when pressed (4242's saves nothing).
 */
function targetStorePage(id: string): string | null {
  const s = TARGET_STORES[id];
  if (!s) return null;
  const page = targetStoreFixture
    .split('2641')
    .join(id)
    .split('Salt Lake City')
    .join(s.name)
    .split('84101-3053')
    .join(`${s.zip}-0000`)
    .split('\\"address_region\\":\\"UT\\"')
    .join(`\\"address_region\\":\\"${s.state}\\"`)
    .split('40.744916')
    .join(String(s.lat))
    .split('-111.901664')
    .join(String(s.lon))
    // The button is the script's to draw.
    .replace(/<button type="button" data-test="@store-locator\/StoreCard\/MakeItMyStoreBtn">Shop this store<\/button>/, '<span id="card"></span>');
  const named = `DSI_${id}|DSN_${encodeURIComponent(s.name)}|DSZ_${s.zip}`;
  const place = `${s.zip}|${s.lat.toFixed(3)}|${s.lon.toFixed(3)}|${s.state}|US`;
  const save =
    id === '4242'
      ? ''
      : `document.cookie = ${JSON.stringify(`fiatsCookie=${named}; domain=target.com; path=/; secure; samesite=lax`)};
         document.cookie = ${JSON.stringify(`sddStore=${named}; domain=target.com; path=/`)};
         document.cookie = ${JSON.stringify(`UserLocation=${place}; domain=target.com; path=/; secure; samesite=lax`)};`;
  return page.replace(
    '</body>',
    `<script>
      setTimeout(() => {
        const b = document.createElement('button');
        b.setAttribute('data-test', '@store-locator/StoreCard/MakeItMyStoreBtn');
        b.textContent = 'Shop this store';
        b.onclick = () => { ${save} };
        document.getElementById('card').appendChild(b);
      }, 800);
    </script></body>`,
  );
}

/**
 * Redsky answers for the store the site has for the visitor (its store cookie, sent with the request), whatever store
 * number the request asks for: as the live runs had it (their answers were the site's store's, the request's own
 * edited number aside). Without that cookie, for the number asked.
 */
function redsky(query: URLSearchParams, path = '', cookie?: string): { status: number; body: string } {
  hits.redsky++;
  const site = cookieStoreOf(cookie);
  if (path.includes('product_summary')) {
    const store = site ?? query.get('pricing_store_id') ?? query.get('store_id') ?? '2766';
    const products = JSON.parse(JSON.stringify(targetFixture)).data.search.products.slice(0, 2);
    for (const p of products) {
      p.price.location_id = Number(store);
      p.item.product_description.title = `${p.item.product_description.title} (${query.get('tcins')})`;
    }
    return { status: 200, body: JSON.stringify({ data: { product_summaries: products } }) };
  }
  const keyword = query.get('keyword') ?? '';
  if (keyword === 'blockme') {
    return { status: 435, body: JSON.stringify({ appId: 'PXGWPp4wUS', blockScript: 'https://captcha.px-cdn.net/PXGWPp4wUS/captcha.js', vid: '' }) };
  }
  const store = site ?? query.get('pricing_store_id') ?? '2766';
  const data = JSON.parse(JSON.stringify(targetFixture));
  for (const p of data.data.search.products) {
    if (!p.price) continue;
    p.price.location_id = Number(store);
    // Another store, another price: what the server-side test found.
    if (store !== '2766' && typeof p.price.current_retail === 'number') p.price.current_retail = Math.round((p.price.current_retail - 0.2) * 100) / 100;
    if (p.item?.product_description?.title) p.item.product_description.title = `${p.item.product_description.title} (${keyword})`;
  }
  return { status: 200, body: JSON.stringify(data) };
}

/** A search page: its own request asks for the store the site has for the visitor, and its place's ZIP, as the real one's. */
function targetPage(term: string, cookie: string | undefined): string {
  const store = cookieStoreOf(cookie) ?? PICKED;
  const zip = cookieZipOf(cookie) ?? '94104';
  // "sum-…": a page that only asks for product summaries (by product numbers, here the term), not the search.
  if (term.startsWith('sum-')) {
    const summary = `https://redsky.target.com/redsky_aggregations/v1/web/product_summary_with_fulfillment_v1?key=9f36aeafbe60771e321a7cc95a78140772ab3e96&tcins=${encodeURIComponent(term)}&store_id=${store}&pricing_store_id=${store}&has_required_store_id=true&channel=WEB`;
    return html(`${term} : Target`, `<div id="r">loading</div><script>fetch(${JSON.stringify(summary)}, { credentials: 'include' }).then((r) => r.json());</script>`);
  }
  const url = `https://redsky.target.com/redsky_aggregations/v1/web/plp_search_v2?count=24&default_purchasability_filter=true&include_sponsored=true&keyword=${encodeURIComponent(term)}&new_search=true&offset=0&page=%2Fs%2F${encodeURIComponent(term)}&platform=desktop&pricing_store_id=${store}&spellcheck=true&store_ids=${store}&visitor_id=01A0EA7528A70200&scheduled_delivery_store_id=${store}&zip=${zip}&key=9f36aeafbe60771e321a7cc95a78140772ab3e96&channel=WEB`;
  return html(`${term} : Target`, `<div id="r">loading</div><img src="/hero.webp"><script>
    fetch(${JSON.stringify(url)}, { credentials: 'include' }).then((r) => r.json()).then((j) => { document.getElementById('r').textContent = j.data.search.products.length + ' products'; });
  </script>`);
}

export function startSites(dir: string) {
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem')], { stdio: 'ignore' });
  const server = createServer({ key: readFileSync(join(dir, 'key.pem')), cert: readFileSync(join(dir, 'cert.pem')) }, (req, res) => {
    const host = (req.headers.host ?? '').split(':')[0];
    const url = new URL(req.url ?? '/', `https://${host}`);
    const send = (status: number, body: string, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...headers });
      res.end(body);
    };
    if (url.pathname.endsWith('.png') || url.pathname.endsWith('.webp')) {
      hits.image++;
      return send(200, 'x'.repeat(200_000), { 'content-type': 'image/png' });
    }
    if (url.pathname.endsWith('.woff2')) {
      hits.font++;
      return send(200, 'x'.repeat(50_000), { 'content-type': 'font/woff2' });
    }
    if (host === 'www.walmart.com') {
      // A first visit gets the store Walmart picks for the connection; a store set later stays.
      if (url.pathname === '/') {
        hits.home++;
        const first = !cookieOf(req.headers.cookie, 'assortmentStoreId');
        return send(200, html('Walmart.com', 'Home'), first ? { 'set-cookie': 'assortmentStoreId=3081; Path=/; Secure' } : {});
      }
      // A page that moves on by itself, as a redirect would.
      if (url.pathname === '/redirect-me') return send(200, html('Moving', '<script>setTimeout(() => { location.href = "/landed"; }, 200)</script>'));
      if (url.pathname === '/landed') return send(200, html('Landed', 'Landed'));
      // A page the site takes a second to answer, as a busy one would.
      if (url.pathname === '/slow') return void setTimeout(() => send(200, html('Slow', 'Slow')), 1000);
      if (url.pathname.startsWith('/store/')) {
        hits.storePage++;
        return send(200, storePage(url.pathname.split('/')[2], cookieOf(req.headers.cookie, 'assortmentStoreId')));
      }
      if (url.pathname === '/api/set-store') {
        hits.setStore++;
        return send(200, '{}', { 'content-type': 'application/json', 'set-cookie': `assortmentStoreId=${url.searchParams.get('id')}; Path=/; Secure` });
      }
      if (url.pathname === '/search') return send(200, walmartSearch(url.searchParams.get('q') ?? '', cookieOf(req.headers.cookie, 'assortmentStoreId') ?? '3081'));
      if (url.pathname.startsWith('/ip/')) {
        hits.product++;
        const store = cookieOf(req.headers.cookie, 'assortmentStoreId') ?? '3081';
        const data = readFileSync(join(root, 'tests/fixtures/cloud/walmart-product-10450114.json'), 'utf8').split('"3081"').join(`"${store}"`);
        return send(200, html('Great Value Whole Vitamin D Milk - Walmart.com', `<script id="__NEXT_DATA__" type="application/json">${data}</script>`));
      }
    }
    if (host === 'www.target.com') {
      // A new visitor gets the store Target picks for its connection, on whichever page it lands first.
      const first = targetFirstVisit(req.headers.cookie);
      const cookie = first['set-cookie'] ? `${req.headers.cookie ?? ''}; ${first['set-cookie'].map((c) => c.split(';')[0]).join('; ')}` : req.headers.cookie;
      const reply = (status: number, body: string) => {
        res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...first });
        res.end(body);
      };
      if (url.pathname === '/s') return reply(200, targetPage(url.searchParams.get('searchTerm') ?? '', cookie));
      // Its store pages: /sl/<any name>/<number>.
      const sl = /^\/sl\/[^/]+\/([^/]+)$/.exec(url.pathname);
      if (sl) {
        hits.targetStorePage++;
        const page = targetStorePage(sl[1]);
        return page ? reply(200, page) : reply(404, html('Target', 'Sorry, something went wrong.'));
      }
    }
    if (host === 'redsky.target.com') {
      const cors = { 'access-control-allow-origin': 'https://www.target.com', 'access-control-allow-credentials': 'true', 'content-type': 'application/json' };
      if (req.method === 'OPTIONS') return send(204, '', { ...cors, 'access-control-allow-headers': 'accept' });
      const { status, body } = redsky(url.searchParams, url.pathname, req.headers.cookie);
      return send(status, body, cors);
    }
    send(404, html('Not found', 'Not found'));
  });
  server.listen(PORT, '127.0.0.1');
  return server;
}

// --- Browsers --------------------------------------------------------------------------------------------

export function startChrome(port: number, dir: string): ChildProcess {
  // The three hosts go to the fake sites; every other host resolves to nothing, so no live site can be reached. No
  // proxy either: Chromium takes one from the environment (https_proxy) and would resolve hosts there instead.
  const rules = [...['www.walmart.com', 'www.target.com', 'redsky.target.com'].map((h) => `MAP ${h} 127.0.0.1:${PORT}`), 'MAP * ~NOTFOUND', 'EXCLUDE 127.0.0.1'].join(',');
  return spawn(
    chromePath(),
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--no-proxy-server',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${join(dir, `profile-${port}`)}`,
      `--host-resolver-rules=${rules}`,
      '--ignore-certificate-errors',
      '--no-first-run',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
}

export async function waitForChrome(port: number) {
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return;
    } catch {
      // Not up yet.
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Chromium on ${port} didn't start`);
}

