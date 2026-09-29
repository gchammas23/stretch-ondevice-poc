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
/** What the fake sites were asked for: heavy files (which blocking should keep away), store saves, redsky answers. */
export const hits = { image: 0, font: 0, setStore: 0, redsky: 0, product: 0, home: 0, storePage: 0 };

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

function redsky(query: URLSearchParams, path = ''): { status: number; body: string } {
  hits.redsky++;
  if (path.includes('product_summary')) {
    const store = query.get('pricing_store_id') ?? query.get('store_id') ?? '2766';
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
  const store = query.get('pricing_store_id') ?? '2766';
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

function targetPage(term: string): string {
  // "sum-…": a page that only asks for product summaries (by product numbers, here the term), not the search.
  if (term.startsWith('sum-')) {
    const summary = `https://redsky.target.com/redsky_aggregations/v1/web/product_summary_with_fulfillment_v1?key=9f36aeafbe60771e321a7cc95a78140772ab3e96&tcins=${encodeURIComponent(term)}&store_id=2766&pricing_store_id=2766&has_required_store_id=true&channel=WEB`;
    return html(`${term} : Target`, `<div id="r">loading</div><script>fetch(${JSON.stringify(summary)}, { credentials: 'include' }).then((r) => r.json());</script>`);
  }
  const url = `https://redsky.target.com/redsky_aggregations/v1/web/plp_search_v2?key=9f36aeafbe60771e321a7cc95a78140772ab3e96&channel=WEB&count=24&default_purchasability_filter=true&include_sponsored=true&keyword=${encodeURIComponent(term)}&new_search=true&offset=0&page=%2Fs%2F${encodeURIComponent(term)}&platform=desktop&pricing_store_id=2766&scheduled_delivery_store_id=2766&store_ids=2766%2C2768&visitor_id=01A0EA7528A70200&zip=94103`;
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
    if (host === 'www.target.com' && url.pathname === '/s') return send(200, targetPage(url.searchParams.get('searchTerm') ?? ''));
    if (host === 'redsky.target.com') {
      const cors = { 'access-control-allow-origin': 'https://www.target.com', 'access-control-allow-credentials': 'true', 'content-type': 'application/json' };
      if (req.method === 'OPTIONS') return send(204, '', { ...cors, 'access-control-allow-headers': 'accept' });
      const { status, body } = redsky(url.searchParams, url.pathname);
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

