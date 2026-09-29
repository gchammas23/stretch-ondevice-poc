/// <reference types="node" />
// Cloud fetch, live: the app's own cloud code (src/cloud) against Browser Use's real API, from a computer, one small
// step at a time. Each step's cost is logged to scripts/cloud-live-log.jsonl (as Browser Use reports it, and as the
// account's balance moved), and no step starts once the log adds up to LIVE_BUDGET_USD.
//
// The key: BROWSER_USE_API_KEY, or EXPO_PUBLIC_BROWSER_USE_API_KEY in .env (read here, never printed).
//
//   npx tsx scripts/cloud-live.ts endpoint                       what cdpUrl and {cdpUrl}/json/version look like (~$0.001)
//   npx tsx scripts/cloud-live.ts walmart --store 5260 --terms milk [--product]
//                                                                the scripted Walmart flow (~4¢ a term), and with
//                                                                --product the top result's own page, as a spot check
//   npx tsx scripts/cloud-live.ts target --store 1375 --terms milk [--compare 2766]
//                                                                Target: the store set on its site ("Shop this store"),
//                                                                then its own search request replayed; --compare sets
//                                                                and asks a second store too
//   npx tsx scripts/cloud-live.ts job --engine agent --walmart 5260 --terms milk
//                                                                a whole job through the app's runner (scripted or
//                                                                agent; --target 1375 adds Target), as the app runs it
//   npx tsx scripts/cloud-live.ts log                            the log so far, and its total
//
// Don't run the app's cloud fetch at the same time: the app stops browsers with its label that it doesn't know.
import { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BrowserUseApi, type CloudBrowser } from '../src/cloud/browserUse';
import { connectToPage, resolveSocketUrl, versionUrl, type PageSession, type SocketFactory } from '../src/cloud/cdp';
import { browserUseKey, MAX_MB_PER_BROWSER } from '../src/cloud/config';
import type { FlowContext } from '../src/cloud/flow';
import { jobCost, jobStatus, type CloudRetailerId, type JobRequest, type TermResult, type Via } from '../src/cloud/jobs';
import { CloudRunner } from '../src/cloud/runner';
import { parseRedsky, targetFlow } from '../src/cloud/target';
import { parseWalmartProductPage, walmartFlow } from '../src/cloud/walmart';
import { costWords, retailerLine } from '../src/cloud/words';

const LIVE_BUDGET_USD = 5;
const root = join(__dirname, '..');
/** Where the log and the saved answers go (a rehearsal against fakes points these elsewhere). */
const logFile = () => process.env.CLOUD_LIVE_LOG || join(__dirname, 'cloud-live-log.jsonl');
const outDir = () => process.env.CLOUD_LIVE_OUT || join(__dirname, 'cloud-live-out');

// --- Setup -----------------------------------------------------------------------------------------------------

function loadEnv() {
  const file = join(root, '.env');
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

function arg(name: string, fallback = ''): string {
  const at = process.argv.indexOf(`--${name}`);
  return at !== -1 && process.argv[at + 1] && !process.argv[at + 1].startsWith('--') ? process.argv[at + 1] : fallback;
}
const flag = (name: string) => process.argv.includes(`--${name}`);
const terms = () => arg('terms', 'milk').split(',').map((t) => t.trim()).filter(Boolean).slice(0, 5);

// Node 22 has a WebSocket of its own; older Nodes use the ws package the project already has.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const WS = (globalThis as { WebSocket?: unknown }).WebSocket ?? require('ws');
const socket: SocketFactory = (url) => new (WS as new (u: string) => ReturnType<SocketFactory>)(url);
const fetchJson = (url: string) => fetch(url);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface LogLine {
  at: string;
  step: string;
  detail: Record<string, unknown>;
  /** What Browser Use reported for this step's browsers and runs. */
  reportedUsd: number;
  balanceBefore?: number;
  balanceAfter?: number;
}

function readLog(): LogLine[] {
  if (!existsSync(logFile())) return [];
  return readFileSync(logFile(), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as LogLine);
}

/** A step's cost: the balance's move when both ends were read, else what Browser Use reported. */
const spent = (l: LogLine) => (l.balanceBefore !== undefined && l.balanceAfter !== undefined ? Math.max(l.balanceBefore - l.balanceAfter, l.reportedUsd) : l.reportedUsd);

function log(line: LogLine) {
  appendFileSync(logFile(), `${JSON.stringify(line)}\n`);
  const total = readLog().reduce((n, l) => n + spent(l), 0);
  console.log(`\nLogged: ${line.step}, ${costWords(spent(line))} (reported ${costWords(line.reportedUsd)}). Live total so far: ${costWords(total)} of ${costWords(LIVE_BUDGET_USD)}.`);
}

async function begin(api: BrowserUseApi, step: string, upTo: number): Promise<number> {
  const total = readLog().reduce((n, l) => n + spent(l), 0);
  if (total + upTo > LIVE_BUDGET_USD) throw new Error(`Refused: the log has ${costWords(total)} already, and ${step} may cost up to ${costWords(upTo)} (budget ${costWords(LIVE_BUDGET_USD)}).`);
  const { balanceUsd } = await api.account();
  console.log(`Balance before ${step}: ${costWords(balanceUsd)}.`);
  if (balanceUsd < 1) throw new Error('Refused: under $1 of credit.');
  return balanceUsd;
}

async function balanceAfter(api: BrowserUseApi): Promise<number | undefined> {
  await sleep(5000);
  return api.account().then((a) => a.balanceUsd).catch(() => undefined);
}

/** A browser for one step, always stopped, and what it cost. */
async function withBrowser<T>(api: BrowserUseApi, step: string, fn: (b: CloudBrowser) => Promise<T>): Promise<{ value?: T; error?: string; cost: { mb: number; usd: number }; id: string }> {
  const browser = await api.createBrowser({ job: `script-${step}` });
  console.log(`Browser ${browser.id} created.`);
  let value: T | undefined;
  let error: string | undefined;
  try {
    value = await fn(browser);
  } catch (e) {
    error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    console.error(`Failed: ${error}`);
  } finally {
    await api.stopBrowser(browser.id).catch((e) => console.error(`STOP FAILED for ${browser.id}: ${e}. Stop it in the dashboard.`));
  }
  await sleep(5000);
  const b = await api.getBrowser(browser.id);
  console.log(`Browser ${browser.id}: ${b.status}, ${b.proxyUsedMb} MB proxy, $${b.proxyCost} proxy + $${b.browserCost} browser.`);
  return { value, error, cost: { mb: b.proxyUsedMb, usd: b.proxyCost + b.browserCost }, id: browser.id };
}

function context(results: TermResult[], set: string[], checks: { n: number }): FlowContext {
  return {
    sleep,
    now: Date.now,
    stopped: () => false,
    onTerm: (r) => {
      results.push(r);
      const site = r.siteStoreId ? `, the site's own request asked for ${r.siteStoreId}` : '';
      console.log(`  "${r.term}": ${r.status}${r.reason ? ` (${r.reason})` : ''}, ${r.found ?? 0} products, page store ${r.pageStoreId ?? '?'}${site}${r.storeMatches === false ? ' — NOT the store asked for' : ''}`);
      for (const i of r.items.slice(0, 3)) console.log(`     ${i.price ?? '—'}  ${i.name}${i.unitPrice ? ` (${i.unitPrice})` : ''}`);
    },
    onStoreSet: (how, picked) => {
      set.push(picked ? `${how} over ${picked}` : how);
      console.log(`  store set: ${how}${picked ? ` (the site had picked store ${picked} by itself)` : ''}`);
    },
    onCheck: () => {
      checks.n++;
      console.log('  bot check seen: waiting it out, up to 45 s');
    },
    maxMb: MAX_MB_PER_BROWSER,
  };
}

// --- Steps -----------------------------------------------------------------------------------------------------

/** "Get the browser WebSocket endpoint from {cdpUrl}/json/version. Verify this with curl first." */
async function endpoint(api: BrowserUseApi) {
  const before = await begin(api, 'endpoint', 0.01);
  const shape: Record<string, unknown> = {};
  const run = await withBrowser(api, 'endpoint', async (b) => {
    const cdp = b.cdpUrl ?? '';
    const hide = (u: string) => u.replace(/([?&][^=]+=)[^&]+/g, '$1…').replace(/\/\/([^./]{6})[^./]*\./, '//$1….');
    shape.cdpUrl = hide(cdp);
    shape.versionUrl = hide(versionUrl(cdp));
    const res = await fetch(versionUrl(cdp));
    shape.versionStatus = res.status;
    const body = res.ok ? ((await res.json()) as Record<string, unknown>) : {};
    shape.versionKeys = Object.keys(body);
    shape.browser = body.Browser;
    shape.reportedWs = typeof body.webSocketDebuggerUrl === 'string' ? hide(body.webSocketDebuggerUrl) : null;
    shape.usedWs = hide(await resolveSocketUrl(cdp, fetchJson));
    const page = await connectToPage(cdp, { fetchJson, socket });
    const targets = (await page.conn.send<{ targetInfos: { type: string }[] }>('Target.getTargets')).targetInfos;
    shape.pages = targets.filter((t) => t.type === 'page').length;
    shape.evaluate = await page.evaluate<string>('navigator.userAgent.slice(0, 40)');
    page.close();
    console.log('\nWhat the endpoint looks like (secrets cut):', JSON.stringify(shape, null, 2));
  });
  log({ at: new Date().toISOString(), step: 'endpoint', detail: { browser: run.id, error: run.error, ...shape }, reportedUsd: run.cost.usd, balanceBefore: before, balanceAfter: await balanceAfter(api) });
}

async function walmart(api: BrowserUseApi) {
  const store = arg('store');
  if (!store) throw new Error('--store is needed (a Walmart store number, e.g. 5260)');
  const words = terms();
  const before = await begin(api, 'walmart', 0.02 + 0.015 * (2 + words.length) + (flag('product') ? 0.015 : 0));
  const results: TermResult[] = [];
  const set: string[] = [];
  const checks = { n: 0 };
  let bytes = 0;
  let product: unknown;
  const run = await withBrowser(api, 'walmart', async (b) => {
    const page = (await connectToPage(b.cdpUrl!, { fetchJson, socket })) as PageSession;
    const t0 = Date.now();
    try {
      const out = await walmartFlow(page, store, words, context(results, set, checks));
      console.log(`Walmart: ${out.status}${'reason' in out ? ` (${out.reason})` : ''} in ${Math.round((Date.now() - t0) / 1000)} s, ${(page.bytes / 1e6).toFixed(1)} MB metered.`);
      const top = results.find((r) => r.status === 'done')?.items.find((i) => !i.sponsored && i.url);
      if (flag('product') && top?.url) {
        // walmart_store_test.py's check: the product's own page, its price and the store numbers in it.
        await page.navigate(top.url);
        await sleep(2500);
        const text = await page.evaluate<string>("document.getElementById('__NEXT_DATA__')?.textContent || ''");
        product = text ? { ...parseWalmartProductPage(text, store), searchPrice: top.price } : { error: 'no page data' };
        console.log('Product page spot check:', JSON.stringify(product));
      }
      return out;
    } finally {
      bytes = page.bytes;
      page.close();
    }
  });
  log({
    at: new Date().toISOString(),
    step: 'walmart',
    detail: { store, terms: words, browser: run.id, outcome: run.value, error: run.error, storeSet: set, checks: checks.n, mbMetered: +(bytes / 1e6).toFixed(2), proxyMb: run.cost.mb, results: results.map((r) => ({ term: r.term, status: r.status, found: r.found, pageStoreId: r.pageStoreId, storeMatches: r.storeMatches })), product },
    reportedUsd: run.cost.usd,
    balanceBefore: before,
    balanceAfter: await balanceAfter(api),
  });
}

/** Target: the store set on its site, then the page's own redsky request replayed (and a second store's, to compare). */
async function target(api: BrowserUseApi) {
  const store = arg('store');
  if (!store) throw new Error('--store is needed (a Target store number, e.g. 1375)');
  const compare = arg('compare');
  const words = terms();
  // A store page and a search page (about 3¢ at most), then a small answer a term; twice with --compare.
  const before = await begin(api, 'target', (0.03 + 0.003 * words.length) * (compare ? 2 : 1));
  const results: TermResult[] = [];
  const other: TermResult[] = [];
  const set: string[] = [];
  const checks = { n: 0 };
  let own: Record<string, unknown> = {};
  const run = await withBrowser(api, 'target', async (b) => {
    const page = (await connectToPage(b.cdpUrl!, { fetchJson, socket })) as PageSession;
    try {
      const out = await targetFlow(page, store, words, context(results, set, checks));
      console.log(`Target (store ${store}): ${out.status}${'reason' in out ? ` (${out.reason})` : ''}`);
      // The page's own first search answer: saved, to replace the hand-built fixture (its prices say whose they are).
      const req = page.requests.find((r) => /plp_search/.test(r.url) && r.status === 200);
      if (req) {
        const body = await page.responseBody(req.requestId).catch(() => '');
        if (body) {
          mkdirSync(outDir(), { recursive: true });
          writeFileSync(join(outDir(), 'target-plp-search-live.json'), body);
          const parsed = parseRedsky(JSON.parse(body), store);
          own = { pageLocationIds: parsed.locationIds, pageItems: parsed.found, savedTo: 'scripts/cloud-live-out/target-plp-search-live.json' };
          console.log(`The page's own search answer: store ${parsed.locationIds.join(',')}, ${parsed.found} products (saved).`);
        }
      }
      if (compare && out.status === 'done') {
        const again = await targetFlow(page, compare, words.slice(0, 1), context(other, set, checks));
        console.log(`Target (store ${compare}): ${again.status}`);
        const a = results[0]?.items ?? [];
        const bItems = other[0]?.items ?? [];
        const differ = a.filter((x) => bItems.some((y) => y.itemId === x.itemId && y.price !== x.price)).length;
        own.samePriceItems = a.filter((x) => bItems.some((y) => y.itemId === x.itemId && y.price === x.price)).length;
        own.differentPriceItems = differ;
        console.log(`Same product, the two stores: ${differ} priced differently, ${own.samePriceItems} the same.`);
      }
      return out;
    } finally {
      page.close();
    }
  });
  const spike = run.value?.status === 'done' && results.some((r) => r.status === 'done' && r.storeMatches === true) ? 'passed' : 'failed';
  console.log(`\nTarget spike: ${spike}.${spike === 'failed' ? ' Leave Target on "This phone" in scripted mode (Cloud fetch → Engine) and see the README.' : ''}`);
  log({
    at: new Date().toISOString(),
    step: 'target',
    detail: { spike, store, compare, terms: words, browser: run.id, outcome: run.value, error: run.error, checks: checks.n, storeSet: set, ...own, results: [...results, ...other].map((r) => ({ term: r.term, status: r.status, reason: r.reason, found: r.found, pageStoreId: r.pageStoreId, siteStoreId: r.siteStoreId, storeMatches: r.storeMatches })) },
    reportedUsd: run.cost.usd,
    balanceBefore: before,
    balanceAfter: await balanceAfter(api),
  });
}

/** A whole job through the app's runner, as the app runs it (Kroger left out: that's the phone's). */
async function job(api: BrowserUseApi) {
  const engine = arg('engine', 'scripted') === 'agent' ? 'agent' : 'scripted';
  const via: Via = engine === 'agent' ? 'agent' : 'browser';
  const retailers: JobRequest['retailers'] = (['walmart', 'target'] as CloudRetailerId[]).filter((id) => arg(id)).map((id) => ({ retailerId: id, storeId: arg(id), via }));
  if (!retailers.length) throw new Error('--walmart STORE and/or --target STORE are needed');
  const words = terms();
  const before = await begin(api, `job-${engine}`, engine === 'agent' ? 1.5 * retailers.length : 0.1 * retailers.length);
  const store = new Map<string, string>();
  const runner = new CloudRunner({
    api,
    connect: (cdpUrl) => connectToPage(cdpUrl, { fetchJson, socket }),
    deviceSearch: async () => {
      throw new Error('this script searches nothing on a phone');
    },
  });
  await runner.hydrate({ getItem: async (k) => store.get(k) ?? null, setItem: async (k, v) => void store.set(k, v) });
  const finished = new Promise<string>((resolve) => runner.onFinished((j) => resolve(j.id)));
  const started = await runner.start({ engine, terms: words, retailers, from: { kind: 'cloud' } });
  if (!started.ok) throw new Error(`Not started: ${started.problem}`);
  console.log(`Job ${started.job.id} started (${engine}).`);
  const timer = setInterval(() => {
    const j = runner.getJob(started.job.id)!;
    console.log(`  ${new Date().toISOString().slice(11, 19)} ${j.retailers.map((r) => `${r.retailerId}: ${r.status}`).join(', ')}`);
  }, 15_000);
  const id = await finished;
  clearInterval(timer);
  // Browsers stop in the runner's finally blocks, then their costs are read.
  for (let i = 0; i < 30 && runner.getJob(id)!.retailers.some((r) => Object.values(r.browsers).some((b) => !b.stopped)); i++) await sleep(1000);
  await sleep(6000);
  const j = runner.getJob(id)!;
  for (const r of j.retailers) {
    console.log(`\n${r.retailerId}: ${retailerLine(r)}${r.detail ? ` — ${r.detail}` : ''}`);
    for (const t of r.results) {
      console.log(`  "${t.term}": ${t.status}, ${t.found ?? 0} products, store ${t.pageStoreId ?? '?'}${t.storeMatches === false ? ' (NOT the store asked for)' : ''}`);
      for (const i of t.items.slice(0, 3)) console.log(`     ${i.price ?? '—'}  ${i.name}`);
    }
  }
  const cost = jobCost(j);
  console.log(`\nJob ${jobStatus(j)} in ${Math.round(((j.finishedAt ?? Date.now()) - j.createdAt) / 1000)} s; reported cost ${costWords(cost.usd)} (${cost.proxyMb} MB proxy).`);
  log({
    at: new Date().toISOString(),
    step: `job-${engine}`,
    detail: {
      terms: words,
      status: jobStatus(j),
      seconds: Math.round(((j.finishedAt ?? Date.now()) - j.createdAt) / 1000),
      retailers: j.retailers.map((r) => ({ retailer: r.retailerId, store: r.storeId, status: r.status, reason: r.reason, detail: r.detail, storeSet: r.storeSet, browsers: Object.keys(r.browsers), runs: r.runs, results: r.results.map((t) => ({ term: t.term, status: t.status, found: t.found, storeMatches: t.storeMatches })) })),
    },
    reportedUsd: cost.usd,
    balanceBefore: before,
    balanceAfter: await balanceAfter(api),
  });
}

/** Runs one step: `argv` is the command line after the script's name. */
export async function main(argv: string[]): Promise<void> {
  process.argv = [process.argv[0], __filename, ...argv];
  loadEnv();
  const step = argv[0];
  if (step === 'log') {
    const lines = readLog();
    for (const l of lines) console.log(`${l.at}  ${l.step.padEnd(14)} ${costWords(spent(l)).padStart(8)}  ${JSON.stringify(l.detail).slice(0, 160)}`);
    console.log(`\n${lines.length} live steps, ${costWords(lines.reduce((n, l) => n + spent(l), 0))} in all (budget ${costWords(LIVE_BUDGET_USD)}).`);
    return;
  }
  const key = browserUseKey();
  if (!key) throw new Error('No key: set BROWSER_USE_API_KEY, or EXPO_PUBLIC_BROWSER_USE_API_KEY in .env.');
  const api = new BrowserUseApi(key);
  const steps: Record<string, (api: BrowserUseApi) => Promise<void>> = { endpoint, walmart, target, job };
  if (!steps[step]) throw new Error(`Step: one of ${[...Object.keys(steps), 'log'].join(', ')}`);
  await steps[step](api);
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
