/// <reference types="node" />
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { agentTask, extractJson, followUpTask, readAgentAnswer } from '../src/cloud/agent';
import { BrowserUseApi, BrowserUseError } from '../src/cloud/browserUse';
import { browserSocketUrl, CdpClosed, CdpConnection, CdpError, CdpTimeout, decodeBase64, PageSession, resolveSocketUrl, versionUrl, type SocketLike } from '../src/cloud/cdp';
import { MAX_RUN_COST_USD } from '../src/cloud/config';
import { pxBlockedAnswer, pxForm, PX_SNAPSHOT, waitOutCheck } from '../src/cloud/perimeterx';
import { decodeEntities, parseRedsky, redskySearchUrl, replayScript } from '../src/cloud/target';
import { FIND_STORE_BUTTON, parseWalmartProductPage, parseWalmartSearch, READ_SEARCH_DATA, walmartItem } from '../src/cloud/walmart';

// Cloud fetch's readers, against saved answers only (tests/fixtures/cloud): a real Walmart search page's data and
// block page and redsky's PerimeterX answer, read from this POC's server on 2026-09-28; a redsky search answer and a
// Walmart product page built by hand in their documented shapes, as their files say. No live site is visited.

const fixture = (name: string) => readFileSync(join(__dirname, 'fixtures', 'cloud', name), 'utf8');
const walmartText = fixture('walmart-search-milk.json');
const targetJson = JSON.parse(fixture('target-plp-search-milk.json'));

let passed = 0;
const t = async (name: string, fn: () => unknown) => {
  await fn();
  passed++;
  console.log('ok -', name);
};

/** A clock that only moves when slept on. */
function clock() {
  let now = 0;
  return { now: () => now, sleep: async (ms: number) => void (now += ms) };
}

/** A WebSocket the test plays the browser's side of. */
function fakeSocket() {
  const sent: any[] = [];
  const s: SocketLike & { sent: any[]; reply: (msg: unknown) => void; drop: () => void } = {
    readyState: 0,
    sent,
    onopen: null,
    onmessage: null,
    onerror: null,
    onclose: null,
    send: (data: string) => void sent.push(JSON.parse(data)),
    close: () => {
      (s as { readyState: number }).readyState = 3;
      s.onclose?.({});
    },
    reply: (msg) => s.onmessage?.({ data: JSON.stringify(msg) }),
    drop: () => {
      (s as { readyState: number }).readyState = 3;
      s.onclose?.({});
    },
  };
  setTimeout(() => {
    (s as { readyState: number }).readyState = 1;
    s.onopen?.({});
  }, 0);
  return s;
}

(async () => {
  // --- Walmart ------------------------------------------------------------------------------------------

  await t('walmart search: the real page’s products, ads and tiles left out, in the page’s order, with the store its data is for', () => {
    const got = parseWalmartSearch(walmartText, '3081');
    assert.equal(got.payload, true);
    assert.equal(got.found, 14, '16 places in the grid, less an ad and a tile');
    assert.equal(got.items.length, 14);
    assert.deepEqual([got.pageStoreId, got.storeMatches, got.place], ['3081', true, 'Sacramento, CA 95829']);
    assert.deepEqual(got.items.slice(0, 4).map((i) => i.itemId), ['16864710228', '20042402979', '15556050', '10450114']);
  });

  await t('walmart product parser: price, sale, unit price and size as the page prints them; sponsored, stock and store', () => {
    const [first, , , gv] = parseWalmartSearch(walmartText, '3081').items;
    assert.deepEqual(first, {
      itemId: '16864710228',
      name: 'Feastables Protein Fortified Chocolate Milk, Shelf-Stable, 8 fl oz, 6 Pack',
      price: 8.27,
      unitPrice: '17.2 ¢/fl oz',
      size: '6 × 8 fl oz',
      url: 'https://www.walmart.com/ip/Feastables-6ct-Chocolate-Milk-8oz/16864710228',
      imageUrl: first.imageUrl,
      sponsored: true,
      inStock: true,
      atStore: false,
    });
    assert.match(first.imageUrl ?? '', /^https:\/\/i5\.walmartimages\.com\//);
    assert.deepEqual([gv.name, gv.price, gv.unitPrice, gv.atStore, gv.sponsored], ['Great Value Whole Vitamin D Milk, Gallon', 3.32, '2.6 ¢/fl oz', true, undefined]);
    const fairlife = parseWalmartSearch(walmartText, '3081').items.find((i) => i.itemId === '43984343')!;
    assert.deepEqual([fairlife.price, fairlife.wasPrice], [4.78, 5.32], 'a discount’s comparison line is the regular price');
    const half = parseWalmartSearch(walmartText, '3081').items.find((i) => i.itemId === '10450118')!;
    assert.equal(half.size, '½ gal');
    // The older shape the app's own parser reads still reads.
    assert.deepEqual(walmartItem({ usItemId: 7, name: 'Milk', priceInfo: { currentPrice: { price: 2.5 }, wasPrice: { price: 2.9 }, unitPrice: { priceString: '1.9 ¢/fl oz' } } }), {
      itemId: '7',
      name: 'Milk',
      price: 2.5,
      wasPrice: 2.9,
      unitPrice: '1.9 ¢/fl oz',
    });
    assert.equal(walmartItem({ __typename: 'AdPlaceholder' }), null, 'no id or name: not a product');
  });

  await t('walmart search: prices for another store are flagged, never taken for the one asked for', () => {
    const got = parseWalmartSearch(walmartText, '5260');
    assert.deepEqual([got.pageStoreId, got.storeMatches], ['3081', false]);
    assert.equal(got.items.find((i) => i.itemId === '10450114')?.atStore, true, 'sold by a store: store 3081, which the page, not the item, says');
  });

  await t('walmart search: still-streaming data throws (the flow reads it again); no search data at all is no payload; 20 kept', () => {
    assert.throws(() => parseWalmartSearch(walmartText.slice(0, 5000), '3081'));
    assert.deepEqual(parseWalmartSearch('{"props":{"pageProps":{}}}', '3081'), { payload: false, items: [], found: 0 });
    const many = { props: { pageProps: { initialData: { searchResult: { itemStacks: [{ items: Array.from({ length: 50 }, (_, i) => ({ __typename: 'Product', usItemId: String(i), name: `Milk ${i}`, price: 1 + i })) }] } } } } };
    const got = parseWalmartSearch(JSON.stringify(many), '1');
    assert.deepEqual([got.found, got.items.length, got.pageStoreId], [50, 20, undefined], 'a page without its store says nothing about it');
  });

  await t('walmart product page: its current price, and the store numbers in the page (walmart_store_test.py’s check)', () => {
    const got = parseWalmartProductPage(fixture('walmart-product-10450114.json'), '3081');
    assert.deepEqual(got, { itemId: '10450114', name: 'Great Value Whole Vitamin D Milk, Gallon, 128 fl oz', price: 3.32, unitPrice: '2.6 ¢/fl oz', storeIds: ['3081'], storeMatches: true });
    assert.equal(parseWalmartProductPage(fixture('walmart-product-10450114.json'), '5260').storeMatches, false);
  });

  // --- Target -------------------------------------------------------------------------------------------

  await t('target redsky: products with decoded names, prices, sales, ranges, unit prices, stock; duplicates and tiles left out', () => {
    const got = parseRedsky(targetJson, '2766');
    assert.deepEqual([got.payload, got.found, got.locationIds, got.storeMatches], [true, 5, ['2766'], true]);
    assert.deepEqual(got.items[0], {
      itemId: '13276134',
      name: 'Whole Milk - 1gal - Good & Gather™',
      price: 3.69,
      unitPrice: '$0.03/fluid ounce',
      size: '1 gal',
      url: 'https://www.target.com/p/whole-milk-1gal-good-38-gather-8482/-/A-13276134',
      imageUrl: 'https://target.scene7.com/is/image/Target/GUEST_ab3fc39c-3cfd-4a5c-bb05-7a1a4a78ea35',
      inStock: true,
    });
    const byId = Object.fromEntries(got.items.map((i) => [i.itemId, i]));
    assert.equal(byId['54469418'].sponsored, true);
    assert.deepEqual([byId['84220341'].price, byId['84220341'].wasPrice, byId['84220341'].inStock], [4.49, 5.19, false]);
    assert.equal(byId['78025470'].price, 3.49, 'a range: its lowest price');
  });

  await t('target redsky: prices for another store than asked are flagged; summaries read too; nothing is no payload', () => {
    assert.equal(parseRedsky(targetJson, '1375').storeMatches, false);
    const summaries = { data: { product_summaries: targetJson.data.search.products.slice(0, 2).map((p: any) => ({ ...p, price: { ...p.price, location_id: 1375 } })) } };
    assert.deepEqual([parseRedsky(summaries, '1375').items.length, parseRedsky(summaries, '1375').storeMatches], [2, true]);
    assert.deepEqual(parseRedsky({ data: {} }, '1'), { payload: false, items: [], found: 0, locationIds: [] });
  });

  await t('target: the page’s own search request, asking for the user’s store and another term; the rest as the page sent it', () => {
    const captured =
      'https://redsky.target.com/redsky_aggregations/v1/web/plp_search_v2?key=9f36aeafbe60771e321a7cc95a78140772ab3e96&channel=WEB&count=24&keyword=milk&offset=24&page=%2Fs%2Fmilk&pricing_store_id=2766&scheduled_delivery_store_id=2766&store_ids=2766%2C2768&visitor_id=V1&zip=94103';
    const url = redskySearchUrl(captured, 'oat milk', '1375');
    const q = new URL(url).searchParams;
    assert.deepEqual(
      ['keyword', 'page', 'offset', 'pricing_store_id', 'scheduled_delivery_store_id', 'store_ids', 'key', 'visitor_id', 'zip', 'count'].map((k) => q.get(k)),
      ['oat milk', '/s/oat milk', '0', '1375', '1375', '1375', '9f36aeafbe60771e321a7cc95a78140772ab3e96', 'V1', '94103', '24'],
    );
    const bare = new URL(redskySearchUrl('https://redsky.target.com/redsky_aggregations/v1/web/plp_search_v2?key=k&keyword=milk', 'eggs', '1375')).searchParams;
    assert.deepEqual([bare.get('pricing_store_id'), bare.get('keyword')], ['1375', 'eggs'], 'a request without a store gets one');
    const summary = new URL(redskySearchUrl('https://redsky.target.com/redsky_aggregations/v1/web/product_summary_with_fulfillment_v1?key=k&tcins=1,2&store_id=2766', 'eggs', '1375')).searchParams;
    assert.deepEqual([summary.get('store_id'), summary.get('pricing_store_id'), summary.get('keyword')], ['1375', '1375', null]);
    assert.equal(decodeEntities('A &amp; B &#38; C &#x2122; &trade; &bogus;'), 'A & B & C ™ ™ &bogus;');
  });

  // --- PerimeterX ------------------------------------------------------------------------------------------

  await t('perimeterx: a /blocked address, a “Robot or human?” title, or a dialog saying it; not a search for “blocked”', () => {
    const real = 'https://www.walmart.com/blocked?url=L2lwLzEwNDUwMTE0&uuid=928bbb10-bb98-11f1-a1a8-f202e9aa30d3&vid=&g=b';
    assert.equal(pxForm({ url: real, title: 'Robot or human?', dialogs: [] }), 'blocked_url');
    assert.equal(pxForm({ url: 'https://www.walmart.com/ip/10450114', title: 'Robot or human?', dialogs: [] }), 'title');
    assert.equal(pxForm({ url: 'https://www.walmart.com/store/5260', title: 'Walmart Supercenter', dialogs: ['Your store', 'Robot or Human? Activate and hold the button'] }), 'dialog');
    assert.equal(pxForm({ url: 'https://www.walmart.com/search?q=blocked+drain', title: 'blocked drain - Walmart.com', dialogs: ['Sign in'] }), null);
    assert.equal(pxForm({ url: 'https://www.walmart.com/ip/Blocked-Tile/123', title: 'Tile', dialogs: [] }), null);
  });

  await t('perimeterx: the page snapshot, run in the real block page and in a normal page with the check drawn over it', () => {
    const run = (html: string, url: string) => {
      const dom = new JSDOM(html, { url, runScripts: 'outside-only' });
      return pxForm((dom.window as any).eval(PX_SNAPSHOT));
    };
    assert.equal(run(fixture('walmart-blocked.html'), 'https://www.walmart.com/ip/10450114'), 'title');
    assert.equal(run(fixture('walmart-blocked.html'), 'https://www.walmart.com/blocked?url=L2lw'), 'blocked_url');
    const overlay = '<html><head><title>Walmart Supercenter 5260</title></head><body><main>Store 5260</main><div role="dialog"><h2>Robot or human?</h2><div id="px-captcha"></div></div></body></html>';
    assert.equal(run(overlay, 'https://www.walmart.com/store/5260'), 'dialog');
    assert.equal(run('<html><head><title>milk - Walmart.com</title></head><body><div role="dialog">Choose your store</div></body></html>', 'https://www.walmart.com/search?q=milk'), null);
  });

  await t('perimeterx: an API’s block (HTTP 435, or its JSON), from the real redsky answer', () => {
    const real = fixture('target-redsky-px-435.json');
    assert.equal(pxBlockedAnswer(435, real), true);
    assert.equal(pxBlockedAnswer(200, real), true, 'its JSON says it, whatever the status');
    assert.equal(pxBlockedAnswer(200, JSON.stringify(targetJson)), false);
    assert.equal(pxBlockedAnswer(403, '<html>Access Denied</html>'), false, 'another block is an HTTP error, not PerimeterX');
  });

  await t('perimeterx: a check is waited out, looked at every 10 s for up to 45 s, nothing else done meanwhile', async () => {
    const c = clock();
    const seen: number[] = [];
    const clears = await waitOutCheck(async () => (seen.push(c.now()), c.now() >= 20_000 ? null : 'dialog'), c);
    assert.deepEqual([clears, seen], [true, [10_000, 20_000]]);
    const c2 = clock();
    const seen2: number[] = [];
    const stays = await waitOutCheck(async () => (seen2.push(c2.now()), 'title'), c2);
    assert.deepEqual([stays, seen2], [false, [10_000, 20_000, 30_000, 40_000, 45_000]]);
  });

  // --- The agent ---------------------------------------------------------------------------------------------

  const job = { retailer: 'walmart' as const, storeId: '5260', terms: ['milk', 'eggs'] };
  const answer = (items: unknown[], extra: object = {}) => JSON.stringify({ retailer: 'walmart', storeId: '5260', storeConfirmed: true, items, ...extra });

  await t('agent: the task sets the store on the retailer’s own page, searches each term, asks for JSON only, never solves a check', () => {
    const task = agentTask('walmart', '5260', ['milk', 'eggs']);
    for (const words of ['https://www.walmart.com/store/5260', '"milk", "eggs"', 'Return ONLY JSON', 'do not try to solve it', '{"blocked": true}', 'at most 20 per term', '"storeConfirmed"']) {
      assert.ok(task.includes(words), words);
    }
    assert.ok(agentTask('target', '1375', ['milk']).includes("Target's own page for store 1375"));
    assert.ok(followUpTask('walmart', '5260', ['milk'], 'it was not JSON').includes('(it was not JSON)'));
  });

  await t('agent answer: validated with zod, products by term, prices as numbers, invalid items dropped, 20 a term at most', () => {
    const items = [
      { term: 'milk', name: 'Great Value Whole Milk, 1 gal', price: 3.32, unitPrice: '2.6 ¢/fl oz', size: '1 gal', itemId: '10450114', url: '/ip/10450114' },
      { term: 'MILK', name: 'Lactaid Whole Milk, 96 oz', price: '$6.38', itemId: 23619910, url: 'https://www.walmart.com/ip/23619910' },
      { term: 'eggs', name: 'Great Value Large White Eggs, 12 Count', price: null, itemId: '145051970' },
      { term: 'eggs', name: '', price: 1, itemId: 'x' },
      { term: 'eggs', name: 'No id', price: 1 },
    ];
    const got = readAgentAnswer(answer(items), undefined, job);
    assert.equal(got.kind, 'ok');
    if (got.kind !== 'ok') return;
    assert.deepEqual([got.storeConfirmed, got.storeMatches, got.dropped], [true, true, 2]);
    assert.deepEqual(got.byTerm.milk.map((i) => [i.itemId, i.price, i.url]), [
      ['10450114', 3.32, 'https://www.walmart.com/ip/10450114'],
      ['23619910', 6.38, 'https://www.walmart.com/ip/23619910'],
    ]);
    assert.deepEqual(got.byTerm.milk[1].size, '96 oz', 'a size it didn’t give comes from the name');
    assert.deepEqual(got.byTerm.eggs.map((i) => [i.itemId, i.price]), [['145051970', null]]);
    const many = readAgentAnswer(answer(Array.from({ length: 30 }, (_, i) => ({ term: 'milk', name: `Milk ${i}`, price: i, itemId: String(i) }))), undefined, job);
    assert.equal(many.kind === 'ok' && many.byTerm.milk.length, 20);
  });

  await t('agent answer: JSON in a code fence or among words is found; the store it answered for is checked', () => {
    const fenced = readAgentAnswer(`Here you go:\n\`\`\`json\n${answer([{ term: 'milk', name: 'Milk', price: 3, itemId: '1' }])}\n\`\`\``, undefined, job);
    assert.equal(fenced.kind, 'ok');
    const prose = readAgentAnswer(`Done! ${answer([], { storeId: 3081, storeConfirmed: false })} Thanks.`, undefined, job);
    assert.equal(prose.kind === 'ok' && `${prose.storeMatches} ${prose.answeredStoreId} ${prose.storeConfirmed}`, 'false 3081 false');
    const single = readAgentAnswer(answer([{ name: 'Milk', price: 3, itemId: '1' }]), undefined, { ...job, terms: ['milk'] });
    assert.equal(single.kind === 'ok' && single.byTerm.milk.length, 1, 'one term: items without a term are its');
    const unknown = readAgentAnswer(answer([{ name: 'Milk', price: 3, itemId: '1' }]), undefined, job);
    assert.equal(unknown.kind === 'ok' && unknown.byTerm[''].length, 1, 'several terms: kept apart, not guessed');
    const parsed = readAgentAnswer(undefined, JSON.parse(answer([{ term: 'milk', name: 'Milk', price: 3, itemId: '1' }])), job);
    assert.equal(parsed.kind, 'ok', 'an answer already parsed is taken as it is');
  });

  await t('agent answer: blocked, not JSON, empty, the wrong shape, the wrong retailer, or no valid item: each said', () => {
    assert.deepEqual(readAgentAnswer('{"blocked": true}', undefined, job), { kind: 'blocked' });
    assert.deepEqual(readAgentAnswer('I could not finish the task.', undefined, job), { kind: 'invalid', why: 'it was not JSON' });
    assert.deepEqual(readAgentAnswer('  ', undefined, job), { kind: 'invalid', why: 'it was empty' });
    const shape = readAgentAnswer('{"retailer":"walmart","items":[]}', undefined, job);
    assert.equal(shape.kind, 'invalid');
    assert.match(shape.kind === 'invalid' ? shape.why : '', /storeId/);
    assert.deepEqual(readAgentAnswer(JSON.stringify({ retailer: 'target', storeId: '5260', storeConfirmed: true, items: [] }), undefined, job), {
      kind: 'invalid',
      why: 'it was for target, not walmart',
    });
    assert.deepEqual(readAgentAnswer(answer([{ term: 'milk', price: 3 }]), undefined, job), { kind: 'invalid', why: 'none of its items had a name and an item number' });
    assert.deepEqual(readAgentAnswer(answer([]), undefined, job).kind, 'ok', 'nothing found is an answer');
    assert.equal(extractJson('{"a": 1} and {"b": 2}'), undefined, 'two objects are not one answer');
  });

  // --- Browser Use's API -------------------------------------------------------------------------------------

  await t('browser use: the key in its header, no Bearer; browsers made with a proxy, a timeout and labels; money as numbers', async () => {
    const calls: { url: string; init: any }[] = [];
    const api = new BrowserUseApi('bu_test', async (url, init) => {
      calls.push({ url, init });
      if (url.includes('billing')) return { ok: true, status: 200, text: async () => '{"totalCreditsBalanceUsd": 12.43, "activeSessionCount": 1, "concurrentSessionLimit": 10}' };
      if (init?.method === 'POST' && url.endsWith('/runs')) return { ok: true, status: 200, text: async () => '{"id":"r1","status":"queued","sessionId":"s1","model":"gpt-5.6-luna"}' };
      return { ok: true, status: 201, text: async () => '{"id":"b1","status":"active","cdpUrl":"https://b1.cdp.example","proxyUsedMb":"2.61","proxyCost":"0.0131","browserCost":"0.0033"}' };
    });
    assert.deepEqual(await api.account(), { balanceUsd: 12.43, activeSessions: 1, sessionLimit: 10 });
    assert.equal(calls[0].url, 'https://api.browser-use.com/api/v2/billing/account');
    assert.deepEqual(calls[0].init.headers['X-Browser-Use-API-Key'], 'bu_test');
    assert.ok(!Object.values(calls[0].init.headers).some((v) => String(v).startsWith('Bearer')));
    const b = await api.createBrowser({ job: 'j1' });
    assert.deepEqual([b.id, b.cdpUrl, b.proxyUsedMb, b.proxyCost, b.browserCost], ['b1', 'https://b1.cdp.example', 2.61, 0.0131, 0.0033]);
    assert.deepEqual(JSON.parse(calls[1].init.body), { proxyCountryCode: 'us', timeout: 10, metadata: { app: 'stretch-poc', job: 'j1' } });
    await api.stopBrowser('b1');
    assert.deepEqual([calls[2].init.method, calls[2].url, JSON.parse(calls[2].init.body)], ['PATCH', 'https://api.browser-use.com/api/v4/browsers/b1', { action: 'stop' }]);
    await api.createRun({ task: 'x', model: 'gpt-5.6-luna', maxCostUsd: MAX_RUN_COST_USD, sessionId: 's0' });
    assert.deepEqual(JSON.parse(calls[3].init.body), { task: 'x', model: 'gpt-5.6-luna', maxCostUsd: 0.75, sessionId: 's0' }, 'a cost cap on every run');
    await api.activeBrowsers({ label: { app: 'stretch-poc' } });
    assert.equal(calls[4].url, 'https://api.browser-use.com/api/v4/browsers?filterBy=active&pageSize=50&metadata=app%3Dstretch-poc');
  });

  await t('browser use: refusals carry their status and what the API said; no key refuses before asking', async () => {
    const api = new BrowserUseApi('bu_test', async () => ({ ok: false, status: 402, text: async () => '{"detail":{"code":"api_key_monthly_spend_limit_reached","message":"API key monthly spend limit reached","cap":5,"spent":5.1}}' }));
    await assert.rejects(api.createBrowser(), (e: unknown) => e instanceof BrowserUseError && e.status === 402 && e.detail === 'API key monthly spend limit reached');
    let asked = false;
    const none = new BrowserUseApi('', async () => ((asked = true), { ok: true, status: 200, text: async () => '{}' }));
    await assert.rejects(none.account(), (e: unknown) => e instanceof BrowserUseError && /no API key/.test(e.detail));
    assert.equal(asked, false);
  });

  // --- The DevTools protocol ------------------------------------------------------------------------------

  await t('cdp: /json/version beside the address given; a proxied browser’s local WebSocket moved onto that address', async () => {
    assert.equal(versionUrl('https://b1.cdp.browser-use.com'), 'https://b1.cdp.browser-use.com/json/version');
    assert.equal(versionUrl('https://cdp.example/s/123/?token=a'), 'https://cdp.example/s/123/json/version?token=a');
    assert.equal(versionUrl('wss://cdp.example/devtools/browser/abc?token=a'), 'https://cdp.example/json/version?token=a');
    const local = { webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/abc' };
    assert.equal(browserSocketUrl('https://b1.cdp.example', local), 'wss://b1.cdp.example/devtools/browser/abc');
    assert.equal(browserSocketUrl('https://b1.cdp.example?token=t', local), 'wss://b1.cdp.example/devtools/browser/abc?token=t');
    assert.equal(browserSocketUrl('http://127.0.0.1:9222', local), 'ws://127.0.0.1:9222/devtools/browser/abc');
    assert.equal(browserSocketUrl('https://b1.cdp.example', { webSocketDebuggerUrl: 'wss://b1.cdp.example/devtools/browser/x' }), 'wss://b1.cdp.example/devtools/browser/x');
    assert.throws(() => browserSocketUrl('https://x', {}), CdpError);
    const answer = (ok: boolean, body = '') => async () => ({ ok, status: ok ? 200 : 404, text: async () => body });
    assert.equal(await resolveSocketUrl('https://b1.cdp.example', answer(true, JSON.stringify(local))), 'wss://b1.cdp.example/devtools/browser/abc');
    assert.equal(await resolveSocketUrl('wss://b1.cdp.example/devtools/browser/abc', answer(false)), 'wss://b1.cdp.example/devtools/browser/abc');
    await assert.rejects(resolveSocketUrl('https://b1.cdp.example', answer(false)), CdpError);
  });

  await t('cdp: numbered commands and their answers, events by session, errors, timeouts, and a dropped socket failing what waits', async () => {
    const socket = fakeSocket();
    const conn = await CdpConnection.open('wss://x', () => socket);
    const events: string[] = [];
    conn.onEvent((e) => events.push(`${e.method}@${e.sessionId ?? '-'}`));
    const a = conn.send('Target.getTargets');
    const b = conn.send('Page.navigate', { url: 'https://www.walmart.com/' }, 'S1');
    assert.deepEqual(socket.sent, [
      { id: 1, method: 'Target.getTargets', params: {} },
      { id: 2, method: 'Page.navigate', params: { url: 'https://www.walmart.com/' }, sessionId: 'S1' },
    ]);
    socket.reply({ method: 'Page.lifecycleEvent', params: { name: 'init' }, sessionId: 'S1' });
    socket.reply({ id: 2, error: { message: 'Cannot navigate to invalid URL' } });
    socket.reply({ id: 1, result: { targetInfos: [] } });
    assert.deepEqual(await a, { targetInfos: [] });
    await assert.rejects(b, (e: unknown) => e instanceof CdpError && e.message === 'Page.navigate: Cannot navigate to invalid URL');
    assert.deepEqual(events, ['Page.lifecycleEvent@S1']);
    await assert.rejects(conn.send('Runtime.evaluate', {}, 'S1', 20), CdpTimeout);
    const waiting = conn.send('Runtime.evaluate', {}, 'S1');
    socket.drop();
    await assert.rejects(waiting, CdpClosed);
    await assert.rejects(conn.send('Runtime.evaluate'), CdpClosed);
    assert.equal(conn.open, false);
  });

  await t('cdp page: waits for its own navigation’s DOMContentLoaded, not an earlier one’s; a network error rejects; data metered', async () => {
    const socket = fakeSocket();
    const conn = await CdpConnection.open('wss://x', () => socket);
    const page = new PageSession(conn, 'S1');
    let done = false;
    const nav = page.navigate('https://www.walmart.com/store/5260').then(() => (done = true));
    await new Promise((r) => setTimeout(r, 5));
    socket.reply({ method: 'Page.lifecycleEvent', params: { name: 'DOMContentLoaded', loaderId: 'OLD', frameId: 'F' }, sessionId: 'S1' });
    socket.reply({ id: socket.sent[0].id, result: { frameId: 'F', loaderId: 'L2' } });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(done, false, 'the page before it doesn’t count');
    socket.reply({ method: 'Page.lifecycleEvent', params: { name: 'DOMContentLoaded', loaderId: 'L2', frameId: 'F' }, sessionId: 'S2' });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(done, false, 'nor another page’s');
    socket.reply({ method: 'Page.lifecycleEvent', params: { name: 'DOMContentLoaded', loaderId: 'L2', frameId: 'F' }, sessionId: 'S1' });
    await nav;
    const failed = page.navigate('https://nowhere.invalid/');
    await new Promise((r) => setTimeout(r, 5));
    socket.reply({ id: socket.sent[socket.sent.length - 1].id, result: { frameId: 'F', loaderId: 'L3', errorText: 'net::ERR_NAME_NOT_RESOLVED' } });
    await assert.rejects(failed, /ERR_NAME_NOT_RESOLVED/);
    socket.reply({ method: 'Network.loadingFinished', params: { requestId: '1', encodedDataLength: 2_600_000 }, sessionId: 'S1' });
    socket.reply({ method: 'Network.loadingFinished', params: { requestId: '2', encodedDataLength: 400 }, sessionId: 'S2' });
    assert.equal(page.bytes, 2_600_000, 'only its own');
    page.close();
    assert.equal(await page.alive(), false);
  });

  await t('cdp: base64 bodies to text, UTF-8 included', () => {
    assert.equal(decodeBase64(Buffer.from('{"price":"2.6 ¢/fl oz","t":"Gather™"}').toString('base64')), '{"price":"2.6 ¢/fl oz","t":"Gather™"}');
    assert.equal(decodeBase64(Buffer.from('ab').toString('base64')), 'ab');
  });

  // --- Scripts run inside the cloud browser's page, here in jsdom ------------------------------------------

  const inPage = (html: string, url: string) => {
    const dom = new JSDOM(html, { url, runScripts: 'outside-only' });
    return dom.window as any;
  };

  await t('in the page: the search data, cut down to what the phone reads, reads the same; still streaming, or missing, says so', () => {
    const html = `<html><head><title>milk - Walmart.com</title></head><body><script id="__NEXT_DATA__" type="application/json">${walmartText}</script></body></html>`;
    const got = inPage(html, 'https://www.walmart.com/search?q=milk').eval(READ_SEARCH_DATA);
    assert.equal(got.state, 'ok');
    assert.ok(got.text.length < walmartText.length);
    assert.deepEqual(parseWalmartSearch(got.text, '3081'), parseWalmartSearch(walmartText, '3081'));
    const partial = `<html><body><script id="__NEXT_DATA__" type="application/json">${walmartText.slice(0, 9000)}</script></body></html>`;
    assert.equal(inPage(partial, 'https://www.walmart.com/search?q=milk').eval(READ_SEARCH_DATA).state, 'partial');
    assert.equal(inPage('<html><body></body></html>', 'https://www.walmart.com/search?q=milk').eval(READ_SEARCH_DATA).state, 'missing');
  });

  await t('in the page: the store button found by its words, scrolled to the middle, and its center given; none, or a disabled one, is null', () => {
    const html = (button: string) => `<html><body><main>Store 5260</main>${button}</body></html>`;
    const w = inPage(html('<button id="b"><span>Make this</span> <span>my store</span></button>'), 'https://www.walmart.com/store/5260');
    let scrolled = '';
    w.HTMLElement.prototype.scrollIntoView = function (this: { id: string }, opts: { block: string }) {
      scrolled = `${this.id}:${opts.block}`;
    };
    w.HTMLElement.prototype.getBoundingClientRect = () => ({ left: 20, top: 300, width: 200, height: 44 });
    assert.deepEqual({ ...w.eval(FIND_STORE_BUTTON) }, { x: 120, y: 322 });
    assert.equal(scrolled, 'b:center');
    const off = inPage(html('<button disabled>Make this my store</button><button>Set as My Store</button>'), 'https://www.walmart.com/store/5260');
    off.HTMLElement.prototype.scrollIntoView = () => {};
    off.HTMLElement.prototype.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 40 });
    assert.equal(off.eval(FIND_STORE_BUTTON), null);
  });

  await t('in the page: redsky asked again from the page, its answer cut down to what the phone reads, reading the same', async () => {
    const w = inPage('<html><body></body></html>', 'https://www.target.com/s?searchTerm=milk');
    const asked: { url: string; credentials: string }[] = [];
    w.fetch = async (url: string, init: { credentials: string }) => {
      asked.push({ url, credentials: init.credentials });
      return { status: 200, text: async () => JSON.stringify(targetJson) };
    };
    const url = 'https://redsky.target.com/redsky_aggregations/v1/web/plp_search_v2?key=k&keyword=milk&pricing_store_id=2766';
    const got = await w.eval(replayScript(url));
    assert.deepEqual(asked.map((a) => ({ ...a })), [{ url, credentials: 'include' }]);
    assert.deepEqual(parseRedsky(JSON.parse(got.text), '2766'), parseRedsky(targetJson, '2766'));
    w.fetch = async () => ({ status: 435, text: async () => fixture('target-redsky-px-435.json') });
    const blocked = await w.eval(replayScript(url));
    assert.equal(pxBlockedAnswer(blocked.status, blocked.text), true);
  });

  console.log(`\n${passed} cloud reader tests passed`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
