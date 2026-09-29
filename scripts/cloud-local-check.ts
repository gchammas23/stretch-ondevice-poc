/// <reference types="node" />
// Cloud fetch without the cloud: the scripted engine's real code (the CDP client in src/cloud/cdp.ts, the Walmart and
// Target flows, the PerimeterX checks and the job runner) driving a local headless Chromium against fake Walmart,
// Target and redsky sites served from this machine over HTTPS. No live site is visited and no credit is spent; the
// Browser Use API is simulated. Needs a Chromium: Playwright's (PLAYWRIGHT_BROWSERS_PATH) or CHROME=/path/to/chrome.
//
//   npx tsx scripts/cloud-local-check.ts          (about 40 s)
//   npx tsx scripts/cloud-local-check.ts --slow   (adds a bot check that never clears: 45 s more)
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserUseApi } from '../src/cloud/browserUse';
import { comparisonSummary, matchTerm, sideFigures, type Comparison } from '../src/cloud/compare';
import { connectToPage, type PageSession } from '../src/cloud/cdp';
import type { FlowContext } from '../src/cloud/flow';
import type { TermResult } from '../src/cloud/jobs';
import { CloudRunner, type LivePage } from '../src/cloud/runner';
import { targetFlow } from '../src/cloud/target';
import { parseWalmartSearch, walmartFlow } from '../src/cloud/walmart';
import { hits, startChrome, startSites, waitForChrome } from './cloud-fakes';

const SLOW = process.argv.includes('--slow');
const fetchJson = (url: string) => fetch(url);
const connect = (port: number) => connectToPage(`http://127.0.0.1:${port}`, { fetchJson });

function context(results: TermResult[], extra: Partial<FlowContext> = {}): FlowContext & { set: string[]; checks: number } {
  const ctx = {
    set: [] as string[],
    checks: 0,
    sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
    now: Date.now,
    stopped: () => false,
    onTerm: (r: TermResult) => results.push(r),
    onStoreSet: (how: string) => ctx.set.push(how),
    onCheck: () => ctx.checks++,
    maxMb: 40,
    ...extra,
  };
  return ctx;
}

let passed = 0;
const t = async (name: string, fn: () => Promise<void>) => {
  const t0 = Date.now();
  await fn();
  passed++;
  console.log(`ok - ${name} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
};

(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cloud-check-'));
  const server = startSites(dir);
  const chromes = [startChrome(9331, dir), startChrome(9332, dir)];
  try {
    await Promise.all([waitForChrome(9331), waitForChrome(9332)]);

    await t('cdp: /json/version gives the WebSocket; the browser’s own page is attached, no new one', async () => {
      const before = (await (await fetch('http://127.0.0.1:9331/json/list')).json()) as { type: string }[];
      const page = await connect(9331);
      const after = (await (await fetch('http://127.0.0.1:9331/json/list')).json()) as { type: string }[];
      assert.equal(after.filter((p) => p.type === 'page').length, before.filter((p) => p.type === 'page').length);
      assert.equal(await page.evaluate<number>('1 + 1'), 2);
      assert.equal(await page.alive(), true);
      page.close();
      assert.equal(await page.alive(), false, 'closed: not alive');
    });

    await t('walmart: store set with a real click, its cookie checked, searches read and their store checked; heavy files blocked', async () => {
      const page = (await connect(9331)) as PageSession;
      const results: TermResult[] = [];
      const ctx = context(results);
      hits.image = hits.font = 0;
      const out = await walmartFlow(page, '5260', ['milk', 'mismatch'], ctx);
      assert.deepEqual(out, { status: 'done' });
      assert.deepEqual(ctx.set, ['button']);
      assert.equal(hits.setStore >= 1, true, 'the page’s own request saved the store');
      assert.deepEqual(results.map((r) => [r.term, r.status, r.pageStoreId, r.storeMatches]), [
        ['milk', 'done', '5260', true],
        ['mismatch', 'done', '1111', false],
      ]);
      assert.equal(results[0].items.length, 14, "the fixture’s 16 grid places, less an ad and a tile");
      assert.match(results[0].items[0].name, /^\[milk\]/);
      assert.equal(hits.image + hits.font, 0, 'images and fonts never left the browser');
      assert.ok(page.bytes > 10_000, 'the data moved is metered');
      console.log(`   ${Math.round(page.bytes / 1000)} kB metered`);
      page.close();
    });

    await t('walmart: no button, and the cookie already this store: already set (after the 15 s wait for the button)', async () => {
      const page = (await connect(9331)) as PageSession;
      const results: TermResult[] = [];
      const ctx = context(results);
      const out = await walmartFlow(page, '5260', ['eggs'], ctx);
      assert.deepEqual(out, { status: 'done' });
      assert.deepEqual(ctx.set, ['already']);
      assert.equal(results[0].storeMatches, true);
      page.close();
    });

    await t('walmart: no button, and the cookie another store: failed, nothing searched', async () => {
      const page = (await connect(9332)) as PageSession;
      const results: TermResult[] = [];
      const out = await walmartFlow(page, '4040', ['eggs'], context(results));
      assert.deepEqual(out, { status: 'failed', reason: 'no_store_button' });
      assert.equal(results.length, 0);
      page.close();
    });

    await t('perimeterx: a “Robot or human?” dialog that clears by itself is waited out, then the flow goes on', async () => {
      const page = (await connect(9332)) as PageSession;
      const results: TermResult[] = [];
      const ctx = context(results);
      const out = await walmartFlow(page, '7777', ['milk'], ctx);
      assert.deepEqual(out, { status: 'done' });
      assert.equal(ctx.checks, 1, 'the check was seen');
      assert.equal(results[0].pageStoreId, '7777');
      page.close();
    });

    await t('target: the page’s own redsky request is captured, replayed with the user’s store, and location_id checked', async () => {
      const page = (await connect(9332)) as PageSession;
      const results: TermResult[] = [];
      const ctx = context(results);
      const out = await targetFlow(page, '1375', ['milk', 'eggs'], ctx);
      assert.deepEqual(out, { status: 'done' });
      assert.deepEqual(ctx.set, ['request']);
      assert.deepEqual(results.map((r) => [r.term, r.status, r.pageStoreId, r.storeMatches]), [
        ['milk', 'done', '1375', true],
        ['eggs', 'done', '1375', true],
      ]);
      assert.equal(results[0].items[0].price, 3.49, 'store 1375’s price, not the page’s store 2766 ($3.69)');
      assert.match(results[1].items[0].name, /\(eggs\)$/);
      page.close();
    });

    await t('cdp: a page that moves on by itself (a redirect, a reload) is still read, in a fresh world of the app’s own', async () => {
      const page = (await connect(9331)) as PageSession;
      await page.prepare([]);
      await page.navigate('https://www.walmart.com/redirect-me');
      assert.equal(await page.evaluate<string>('location.pathname'), '/redirect-me');
      await new Promise((r) => setTimeout(r, 1200));
      assert.equal(await page.evaluate<string>('location.pathname'), '/landed');
      assert.equal(await page.evaluate<string>('document.title'), 'Landed');
      page.close();
    });

    await t('target: a page that only sent product summaries: each term’s own page loaded, and its request replayed with the store', async () => {
      const page = (await connect(9332)) as PageSession;
      const results: TermResult[] = [];
      const out = await targetFlow(page, '1375', ['sum-milk', 'sum-eggs'], context(results));
      assert.deepEqual(out, { status: 'done' });
      assert.deepEqual(results.map((r) => [r.term, r.status, r.pageStoreId, r.storeMatches, r.items.length]), [
        ['sum-milk', 'done', '1375', true, 2],
        ['sum-eggs', 'done', '1375', true, 2],
      ]);
      assert.match(results[1].items[0].name, /\(sum-eggs\)$/, 'the second term’s own products');
      page.close();
    });

    await t('target: a replay PerimeterX answers with HTTP 435 makes Target blocked', async () => {
      const page = (await connect(9332)) as PageSession;
      const results: TermResult[] = [];
      const out = await targetFlow(page, '1375', ['milk', 'blockme'], context(results));
      assert.deepEqual(out, { status: 'blocked', reason: 'challenge' });
      assert.deepEqual(results.map((r) => r.status), ['done', 'blocked']);
      page.close();
    });

    if (SLOW) {
      await t('perimeterx: a check that stays 45 s makes Walmart blocked', async () => {
        const page = (await connect(9332)) as PageSession;
        const results: TermResult[] = [];
        const out = await walmartFlow(page, '9999', ['milk'], context(results));
        assert.deepEqual(out, { status: 'blocked', reason: 'challenge' });
        page.close();
      });
    }

    await t('runner: a whole job end to end (Walmart and Target in "cloud" browsers, Kroger on the phone), browsers stopped and costed', async () => {
      let port = 9331;
      const calls: string[] = [];
      const api = new BrowserUseApi('test-key', async (url, init) => {
        calls.push(`${init?.method ?? 'GET'} ${url.replace(/^https:\/\/api\.browser-use\.com\/api/, '')}`);
        const json = (body: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
        if (url.includes('/billing/account')) return json({ totalCreditsBalanceUsd: 12.5 });
        if (init?.method === 'POST' && url.endsWith('/browsers')) {
          const id = `b-${port}`;
          const cdpUrl = `http://127.0.0.1:${port}`;
          port = port === 9331 ? 9332 : 9331;
          return json({ id, status: 'active', cdpUrl });
        }
        if (url.includes('/browsers?')) return json({ items: [] });
        if (/\/browsers\/b-/.test(url)) return json({ id: url.split('/').pop(), status: 'stopped', proxyUsedMb: '5.2', proxyCost: '0.026', browserCost: '0.0007' });
        return { ok: false, status: 404, text: async () => '{"detail":"not found"}' };
      });
      const runner = new CloudRunner({
        api,
        connect: async (cdpUrl) => (await connectToPage(cdpUrl, { fetchJson })) as LivePage,
        deviceSearch: async (_id, term) => ({ items: [{ itemId: 'k1', name: `Kroger ${term}`, price: 2.49 }], found: 1, storeId: '01400943' }),
        costDelayMs: 0,
      });
      const store = new Map<string, string>();
      await runner.hydrate({ getItem: async (k) => store.get(k) ?? null, setItem: async (k, v) => void store.set(k, v) });
      const finished = new Promise<string>((resolve) => runner.onFinished((job) => resolve(job.id)));
      const started = await runner.start({
        engine: 'scripted',
        terms: ['milk'],
        retailers: [
          { retailerId: 'walmart', storeId: '5260', via: 'browser' },
          { retailerId: 'target', storeId: '1375', via: 'browser' },
          { retailerId: 'kroger', storeId: '01400943', via: 'device' },
        ],
      });
      assert.equal(started.ok, true);
      const id = await finished;
      const job = runner.getJob(id)!;
      assert.deepEqual(job.retailers.map((r) => [r.retailerId, r.status]), [
        ['walmart', 'done'],
        ['target', 'done'],
        ['kroger', 'done'],
      ]);
      // The finally blocks stop both browsers; wait for them.
      for (let i = 0; i < 50 && runner.getJob(id)!.retailers.some((r) => Object.values(r.browsers).some((b) => !b.stopped)); i++) await new Promise((r) => setTimeout(r, 100));
      const after = runner.getJob(id)!;
      assert.equal(calls.filter((c) => c.startsWith('PATCH /v4/browsers/')).length, 2, 'both browsers stopped');
      assert.ok(after.retailers.slice(0, 2).every((r) => Object.values(r.browsers).every((b) => b.stopped && b.proxyMb === 5.2)));
      assert.ok(JSON.parse(store.get('stretch.cloud.v1')!).jobs[0].retailers[0].browsers['b-9331'] !== undefined, 'saved on the phone');
    });

    await t('phone vs. cloud: a comparison end to end (this phone simulated, Walmart in a "cloud" browser): timed, metered, matched, told once', async () => {
      const calls: string[] = [];
      const api = new BrowserUseApi('test-key', async (url, init) => {
        calls.push(`${init?.method ?? 'GET'} ${url.replace(/^https:\/\/api\.browser-use\.com\/api/, '')}`);
        const json = (body: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
        if (url.includes('/billing/account')) return json({ totalCreditsBalanceUsd: 12.5 });
        if (init?.method === 'POST' && url.endsWith('/browsers')) return json({ id: 'b-compare', status: 'active', cdpUrl: 'http://127.0.0.1:9331' });
        if (url.includes('/browsers?')) return json({ items: [] });
        if (/\/browsers\/b-/.test(url)) return json({ id: 'b-compare', status: 'stopped', proxyUsedMb: '5.2', proxyCost: '0.026', browserCost: '0.0007' });
        return { ok: false, status: 404, text: async () => '{"detail":"not found"}' };
      });
      // This phone's side, simulated: the same products the fake site lists, the first at 20¢ more.
      const fixture = readFileSync(join(__dirname, '..', 'tests', 'fixtures', 'cloud', 'walmart-search-milk.json'), 'utf8');
      const phoneItems = parseWalmartSearch(fixture, '3081').items.map((i, n) => (n === 0 && i.price !== null ? { ...i, price: Math.round((i.price + 0.2) * 100) / 100 } : i));
      const runner = new CloudRunner({
        api,
        connect: async (cdpUrl) => (await connectToPage(cdpUrl, { fetchJson })) as LivePage,
        deviceSearch: async () => ({ items: phoneItems, found: phoneItems.length, storeId: '5260', ms: 5000, bytes: 1_200_000, how: 'page' }),
        costDelayMs: 0,
      });
      const saved = new Map<string, string>();
      await runner.hydrate({ getItem: async (k) => saved.get(k) ?? null, setItem: async (k, v) => void saved.set(k, v) });
      const told = new Promise<Comparison>((resolve) => runner.onCompared(resolve));
      const got = await runner.startComparison({ terms: ['milk'], retailers: [{ retailerId: 'walmart', storeId: '5260' }], agent: false });
      assert.equal(got.ok, true);
      const c = await told;
      const cloud = c.sides.scripted!.retailers[0];
      assert.equal(cloud.status, 'done');
      const search = cloud.results[0];
      assert.ok(search.ms! > 0 && search.bytes! > 0, 'the cloud browser’s search timed and metered');
      assert.ok(cloud.wireBytes! > 10_000, 'the DevTools link’s traffic counted');
      const figures = sideFigures('scripted', cloud);
      assert.ok(figures.setupMs! > 0 && figures.setupMs! < figures.totalMs!, 'setting up is told apart from the search');
      const m = matchTerm('milk', c.sides.phone!.retailers[0], cloud);
      assert.deepEqual([m.both, m.same, m.differ.length], [phoneItems.length, phoneItems.length - 1, 1]);
      for (let i = 0; i < 50 && !calls.includes('PATCH /v4/browsers/b-compare'); i++) await new Promise((r) => setTimeout(r, 100));
      assert.ok(calls.includes('PATCH /v4/browsers/b-compare'), 'its browser stopped');
      const summary = comparisonSummary(c);
      console.log(`   setup ${Math.round(figures.setupMs! / 100) / 10} s, search ${Math.round(search.ms! / 100) / 10} s, ${Math.round(search.bytes! / 1000)} kB page, ${Math.round(cloud.wireBytes! / 1000)} kB DevTools; same price ${summary.prices[0].same} of ${summary.prices[0].both}`);
    });

    console.log(`\n${passed} local cloud checks passed (Chromium, fake sites; no live site, no credit).`);
  } finally {
    await Promise.all(chromes.map((c) => new Promise((resolve) => (c.exitCode !== null ? resolve(null) : (c.once('exit', resolve), c.kill('SIGKILL'))))));
    server.close();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Chromium may still be letting go of its profile: the system's temp folder is cleaned anyway.
    }
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
