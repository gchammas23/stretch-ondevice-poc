/// <reference types="node" />
import assert from 'node:assert/strict';
import { autoDetect, FULL_LIST, judgeList, profileSource, readPath, readWithProfile, sourceMatches } from '../src/onDevice/parsers';
import { AGREE, isProfile, observationOf, ProfileBook, readerWords, STALE_MISSES, whereWords, type Observation } from '../src/onDevice/profiles';
import { chainIds, learnChain, swapIds } from '../src/onDevice/replay';
import { createRetailerSearch } from '../src/onDevice/retailerSearch';
import { BUNDLED_CONFIG, isRetailerConfig, rulesProblem } from '../src/onDevice/retailers';
import { StoreTuner } from '../src/onDevice/tuning';
import type { CapturedRequest, ParserProfile, PageSource, ProfileCandidate, RetailerConfig } from '../src/onDevice/types';
import { WebViewPool } from '../src/onDevice/webviewPool';
import type { WebViewQueue } from '../src/onDevice/webviewQueue';
import { agreedStores } from '../src/pricing/truth';

// Search events are logged for telemetry; keep them out of the test output.
const log = console.log;
console.log = (...args: unknown[]) => {
  if (!String(args[0]).startsWith('[on-device-')) log(...args);
};

let passed = 0;
const t = async (name: string, fn: () => unknown) => {
  await fn();
  passed++;
  log('ok -', name);
};
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const nonceOf = (script: string) => /var NONCE = "([^"]+)"/.exec(script)![1];
const replayOf = (script: string) => {
  const m = /var NONCE = ("[^"]*"), REQ = (\{.*\});\n/.exec(script)!;
  return { nonce: JSON.parse(m[1]) as string, req: JSON.parse(m[2]) as { url: string; method: string } };
};
const ctx = { retailer: 'aldi', storeId: '' };

// --- An ALDI-shaped storefront (Instacart's platform, as ALDI's and Sprouts' run on) ------------------------------------
// Its search (a GraphQL request that carries the query) answers with placements: a unit of 2 featured (sponsored)
// products, in full, and the results as ids only. The page's item grid then asks for the products of the first ids in
// a second request, by id, which doesn't carry the query. The general reader used to take the 2 featured products: the
// only products with a name and a price in the search's answer.

const HOST = 'https://www.aldi.us';
const title = (q: string) => q.charAt(0).toUpperCase() + q.slice(1);
const persisted = encodeURIComponent('{"persistedQuery":{"version":1,"sha256Hash":"5c1f"}}');
const searchUrl = (q: string) =>
  `${HOST}/graphql?operationName=SearchResultsPlacements&variables=${encodeURIComponent(JSON.stringify({ query: q, shopId: '51459', first: 40 }))}&extensions=${persisted}`;
const itemsUrl = (ids: string[]) => `${HOST}/graphql?operationName=Items&variables=${encodeURIComponent(JSON.stringify({ ids, shopId: '51459', zoneId: '1208' }))}&extensions=${persisted}`;

/** Every product the storefront has, by id: what its Items request answers with. */
const catalog = new Map<string, { name: string; price: number }>();
const idsFor = (q: string, n = 40) =>
  Array.from({ length: n }, (_, i) => {
    const id = `items_1576-${[...q].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 1_000_000, 7)}${String(i).padStart(2, '0')}`;
    catalog.set(id, { name: `Friendly Farms ${title(q)} ${i + 1}`, price: 2.5 + i / 10 });
    return id;
  });
const itemJson = (id: string) => {
  const p = catalog.get(id)!;
  return {
    id,
    legacyId: id.split('-')[1],
    name: p.name,
    size: '1 gal',
    price: { viewSection: { itemCard: { priceString: `$${p.price.toFixed(2)}` } } },
    viewSection: { itemImage: { url: `https://d2d8wwwkmhfcva.cloudfront.net/${id}.jpg` } },
  };
};
const featured = (q: string) => [0, 1].map((i) => ({
  id: `ad-${q}-${i}`,
  name: `Simply Nature Organic ${title(q)} ${i + 1}`,
  price: { viewSection: { itemCard: { priceString: `$${(4.29 + i).toFixed(2)}` } } },
}));
const searchJson = (q: string) =>
  JSON.stringify({
    data: {
      searchResultsPlacements: {
        placements: [
          { content: { __typename: 'AdsFeaturedProducts', featuredProducts: featured(q) } },
          { content: { __typename: 'ItemListWithHeader', itemIds: idsFor(q) } },
        ],
      },
    },
  });
/** The Items answer: `v2` is the site after a change, with the list somewhere else. */
const itemsJson = (ids: string[], v2 = false) =>
  JSON.stringify(v2 ? { data: { catalog: { itemsV2: { nodes: ids.map(itemJson) } } } } : { data: { items: ids.map(itemJson) } });
const request = (url: string): CapturedRequest => ({ method: 'GET', url, headers: { 'x-client': 'store' }, credentials: 'include' });
const searchSource = (q: string): PageSource => ({ label: `response ${searchUrl(q)}`, text: searchJson(q), request: request(searchUrl(q)) });
const itemsSource = (q: string, v2 = false): PageSource => {
  const ids = idsFor(q).slice(0, 12);
  return { label: `response ${itemsUrl(ids)}`, text: itemsJson(ids, v2), request: request(itemsUrl(ids)) };
};
const varsOf = (url: string) => JSON.parse(decodeURIComponent(/[?&]variables=([^&]+)/.exec(url)![1])) as { query?: string; ids?: string[]; zoneId?: string };

const aldi: RetailerConfig = { ...BUNDLED_CONFIG.retailers.find((r) => r.id === 'aldi')!, timeoutMs: 5000 };

/**
 * Plays ALDI's page in a hidden WebView: the search's answer streams in, then the page goes quiet and asks the app
 * whether that's all (see askQuiet); the grid's Items request answers a moment later, unless `items` is off, when the
 * page gives up and posts what it has. Replays answer like the site: the search for its query, Items for its ids.
 */
function aldiWebView(lane: WebViewQueue, opts: { items?: boolean; v2?: () => boolean } = {}) {
  const seen = { pageLoads: 0, replays: [] as string[] };
  let last = -1;
  let page: { nonce: string; href: string; sources: PageSource[] } | null = null;
  const post = (msg: Record<string, unknown>) => lane.receive(JSON.stringify(msg));
  lane.subscribe(() => {
    const s = lane.getSnapshot();
    if (!s || s.phase !== 'hidden' || s.id === last) return;
    last = s.id;
    seen.pageLoads++;
    const q = /[?&]k=([^&]+)/.exec(s.url)![1];
    const nonce = nonceOf(s.script);
    const search = searchSource(decodeURIComponent(q));
    const mine = { nonce, href: s.url, sources: [search] };
    page = mine;
    setTimeout(() => post({ nonce, kind: 'progress', sources: [search] }), 3);
    setTimeout(() => post({ nonce, kind: 'quiet' }), 8);
    if (opts.items === false) {
      setTimeout(() => post({ nonce, kind: 'data', href: s.url, sources: mine.sources, ready: 'gave_up' }), 60);
    } else {
      setTimeout(() => {
        const items = itemsSource(decodeURIComponent(q), opts.v2?.());
        mine.sources = [items, search];
        post({ nonce, kind: 'progress', sources: [items] });
      }, 25);
    }
  });
  lane.attach((script) => {
    // The app saying the quiet page may post what it has.
    const go = /__stretchGo = "([^"]+)"/.exec(script);
    if (go) {
      if (page?.nonce === go[1]) post({ nonce: go[1], kind: 'data', href: page.href, sources: page.sources, ready: 'quiet' });
      return;
    }
    if (!script.includes('REQ = ')) return;
    const { nonce, req } = replayOf(script);
    seen.replays.push(req.url);
    const vars = varsOf(req.url);
    const text = req.url.includes('operationName=Items') ? itemsJson(vars.ids ?? [], opts.v2?.()) : searchJson(vars.query ?? '');
    setTimeout(() => post({ kind: 'replay', nonce, status: 200, url: req.url, type: 'application/json', text, bytes: text.length }), 3);
  });
  return seen;
}

(async () => {
  // --- The wrong-list rule --------------------------------------------------------------------------------------------
  await t('wrong-list rule: a list that doesn’t name the search, or a small one beside the results, is a suspect', () => {
    assert.equal(judgeList({ count: 20, fits: false, path: ['deals'] }), 'its products don’t name what was searched');
    assert.equal(judgeList({ count: 2, fits: true, path: ['results'] }, 24), '2 products where the store gave 24 before');
    assert.equal(judgeList({ count: 2, fits: true, path: ['results'] }, 8), undefined, 'a store that never gave 12 or more');
    assert.equal(judgeList({ count: 2, fits: true, path: ['data', 'placements', '*', 'content', 'featuredProducts'] }), '2 products in “featuredProducts”, a list beside the results');
    assert.equal(judgeList({ count: 3, path: ['adProducts'] }), '3 products in “adProducts”, a list beside the results');
    assert.equal(judgeList({ count: 3, path: ['address', 'items'] }), undefined, '“address” isn’t an ad');
    assert.equal(judgeList({ count: 2, path: ['items'], ids: 40 }), '2 products, next to 40 results named by their ids');
    assert.equal(judgeList({ count: 2, path: ['items'], ids: 5 }), undefined, 'a few ids say nothing');
    assert.equal(judgeList({ count: 5, fits: true, path: ['featuredProducts'] }, 40), undefined, 'more than a handful is never suspected for its size');
    assert.equal(FULL_LIST, 12);
  });

  await t('ALDI-shaped search: the 2 featured products are suspected, and the grid’s products win once they’re in', () => {
    // The search's answer alone: its only products with a name and a price are the 2 featured ones.
    const alone = autoDetect({ sources: [searchSource('milk')] }, { ...ctx, query: 'milk' });
    assert.deepEqual([alone.products.length, alone.read?.fits], [2, true]);
    assert.match(alone.read?.suspect ?? '', /2 products in “featuredProducts”/);
    // With the grid's Items answer in, its 12 are taken, and nothing suspects them.
    const both = autoDetect({ sources: [itemsSource('milk'), searchSource('milk')] }, { ...ctx, query: 'milk' });
    assert.deepEqual([both.products.length, both.products[0].name, both.products[0].price, both.read?.suspect], [12, 'Friendly Farms Milk 1', 2.5, undefined]);
    assert.equal(both.products[0].imageUrl, `https://d2d8wwwkmhfcva.cloudfront.net/${both.products[0].id}.jpg`);
    // Where it was, and how its products read, for a profile.
    const c = both.read?.candidate as ProfileCandidate;
    assert.deepEqual([c.source, c.list, c.count], [{ kind: 'request', host: 'www.aldi.us', path: '/graphql', op: 'Items' }, ['data', 'items'], 12]);
    assert.deepEqual([c.fields.id, c.fields.name, c.fields.price, c.fields.image], [[['id']], [['name']], [['price', 'viewSection', 'itemCard', 'priceString']], [['viewSection', 'itemImage', 'url']]]);
  });

  await t('wrong-list rule: a bigger list that fits the search is taken over the largest when that one doesn’t; the store’s history counts', () => {
    const deals = { label: 'response https://x/deals', text: JSON.stringify({ carousel: Array.from({ length: 20 }, (_, i) => ({ id: `d${i}`, name: `Weekly Deal ${i}`, price: 5 })) }) };
    const results = { label: 'response https://x/search?q=milk', text: JSON.stringify({ results: Array.from({ length: 8 }, (_, i) => ({ id: `m${i}`, name: `Whole Milk ${i}`, price: 3 })) }) };
    const r = autoDetect({ sources: [deals, results] }, { ...ctx, query: 'milk' });
    assert.deepEqual([r.products.length, r.read?.preferred, r.read?.fits], [8, true, true]);
    assert.equal(autoDetect({ sources: [deals, results] }, ctx).products.length, 20, 'without a search to fit, the largest as before');
    const few = { label: 'response https://x/search?q=milk', text: JSON.stringify({ results: [{ id: 'a', name: 'Whole Milk', price: 3 }] }) };
    assert.equal(autoDetect({ sources: [few] }, { ...ctx, query: 'milk', usual: 24 }).read?.suspect, '1 product where the store gave 24 before');
  });

  // --- Learning ------------------------------------------------------------------------------------------------------
  const cand = (over: Partial<ProfileCandidate> = {}): ProfileCandidate => ({
    source: { kind: 'request', host: 'www.aldi.us', path: '/graphql', op: 'Items' },
    list: ['data', 'items'],
    fields: { id: [['id']], name: [['name']], price: [['price', 'viewSection', 'itemCard', 'priceString']] },
    count: 12,
    ...over,
  });
  const obs = (at: number, over: Partial<Observation> = {}, c: Partial<ProfileCandidate> = {}): Observation => ({ at, candidate: cand(c), fits: true, ids: ['a', 'b'], ...over });

  await t('learning: three searches that agree on a list that fits teach the store’s profile; suspects and small lists don’t', () => {
    let now = 1_000_000;
    const book = new ProfileBook(() => now);
    assert.equal(book.observe('aldi', obs(now)), undefined);
    assert.equal(book.observe('aldi', obs(now + 1)), undefined);
    assert.equal(book.progress('aldi'), 2);
    const learned = book.observe('aldi', obs(now + 2, {}, { count: 14 }))!;
    assert.ok(learned, 'the third agreeing search teaches it');
    assert.deepEqual([learned.list, learned.searches, learned.how, learned.usual], [['data', 'items'], AGREE, 'searches', 12]);
    assert.equal(book.get('aldi'), learned);
    assert.equal(book.usual('aldi'), 12);
    assert.equal(whereWords(learned), 'www.aldi.us/graphql (Items) › data › items');

    // Suspected lists, lists that don't fit, and tiny ones never teach, however often they come back.
    const other = new ProfileBook(() => now);
    for (let i = 0; i < 5; i++) other.observe('aldi', obs(now + i, { suspect: '2 products in “featuredProducts”, a list beside the results' }, { count: 2, list: ['data', 'featuredProducts'] }));
    assert.deepEqual([other.get('aldi'), other.progress('aldi'), other.usual('aldi')], [undefined, 0, undefined]);
    for (let i = 0; i < 3; i++) other.observe('sprouts', obs(now + i, { fits: false }));
    for (let i = 0; i < 3; i++) other.observe('meijer', obs(now + i, {}, { count: 2 }));
    assert.deepEqual([other.get('sprouts'), other.get('meijer')], [undefined, undefined]);
    // Searches that disagree start the count again.
    const mixed = new ProfileBook(() => now);
    mixed.observe('target', obs(now));
    mixed.observe('target', obs(now + 1, {}, { list: ['data', 'search', 'products'] }));
    mixed.observe('target', obs(now + 2));
    assert.deepEqual([mixed.get('target'), mixed.progress('target')], [undefined, 1]);
    // And must be recent.
    now += 25 * 60 * 60_000;
    const stale = new ProfileBook(() => now);
    stale.observe('x', obs(now - 26 * 60 * 60_000));
    stale.observe('x', obs(now - 1));
    assert.equal(stale.observe('x', obs(now)), undefined, 'a search from over a day ago doesn’t agree');
    // Only the general reader's reads are observed.
    assert.equal(observationOf({ by: 'profile' }, now, []), null);
    assert.ok(observationOf({ by: 'general', candidate: cand(), fits: true }, now, ['x']));
  });

  await t('learning: the price truth check agreeing confirms the list its products came from, unless the rule suspects it', () => {
    const book = new ProfileBook(() => 5000);
    book.observe('aldi', obs(1000, { ids: ['p1', 'p2', 'p3'] }));
    assert.equal(book.confirm('aldi', ['nope']), undefined);
    const p = book.confirm('aldi', ['p1', 'p3'])!;
    assert.deepEqual([p.how, p.searches], ['truth', 1]);
    const carousel = new ProfileBook(() => 5000);
    carousel.observe('aldi', obs(1000, { ids: ['ad1', 'ad2'], suspect: '2 products in “featuredProducts”, a list beside the results' }, { count: 2 }));
    assert.equal(carousel.confirm('aldi', ['ad1', 'ad2']), undefined, 'a carousel’s prices match their pages too');
    // What the screen passes: stores whose checked prices all matched, two at least.
    const check = (retailerId: string, id: string, state: 'same' | 'different') => ({ retailerId, itemName: id, product: { retailer: retailerId, storeId: '', id, name: id, price: 1 }, state });
    assert.deepEqual(agreedStores([check('aldi', 'p1', 'same'), check('aldi', 'p3', 'same'), check('target', 't1', 'same'), check('target', 't2', 'different'), check('walmart', 'w1', 'same')]), [
      { retailerId: 'aldi', productIds: ['p1', 'p3'] },
    ]);
  });

  // --- Applying ------------------------------------------------------------------------------------------------------
  const profile: ParserProfile = {
    source: { kind: 'request', host: 'www.aldi.us', path: '/graphql', op: 'Items' },
    list: ['data', 'items'],
    fields: { id: [['id']], name: [['name']], price: [['price', 'viewSection', 'itemCard', 'priceString']], image: [['viewSection', 'itemImage', 'url']] },
    usual: 12,
    learnedAt: 1,
    searches: 3,
    how: 'searches',
  };

  await t('applying: the profile reads the list where it says, from a page load’s response or a replay; not found elsewhere', () => {
    const r = readWithProfile(profile, { sources: [searchSource('milk'), itemsSource('milk')] }, { ...ctx, query: 'milk' });
    assert.deepEqual([r.payloadFound, r.products.length, r.read?.by, r.read?.suspect, r.source?.startsWith('response https://www.aldi.us/graphql')], [true, 12, 'profile', undefined, true]);
    assert.equal(r.evidence?.[r.products[0].id].pricePath, 'price.viewSection.itemCard.priceString');
    const ids = idsFor('eggs').slice(0, 12);
    const replayed = readWithProfile(profile, { sources: [{ label: `replay ${itemsUrl(ids)}`, text: itemsJson(ids) }] }, { ...ctx, query: 'eggs' });
    assert.deepEqual([replayed.products.length, replayed.products[0].name], [12, 'Friendly Farms Eggs 1'], 'a replay of the same request');
    const missing = readWithProfile(profile, { sources: [searchSource('milk')] }, ctx);
    assert.deepEqual([missing.payloadFound, missing.read], [false, { by: 'profile', missed: true }]);
    // Another GraphQL operation on the same address isn't the profile's; a request's body can say which it is.
    assert.equal(sourceMatches(profile.source, searchSource('milk')), false);
    assert.equal(sourceMatches(profile.source, { label: 'replay https://www.aldi.us/graphql', request: { method: 'POST', url: 'https://www.aldi.us/graphql', body: '{"operationName":"Items","variables":{}}' } }), true);
    assert.deepEqual(profileSource({ label: 'json script #node-apollo-state' }), { kind: 'page', label: 'json script #node-apollo-state' });
    assert.deepEqual(profileSource({ label: 'response /graphql?operationName=Items', request: request(itemsUrl(['a'])) }).kind, 'request');
  });

  await t('applying: a field’s ways are tried in order, so a product on sale reads at its sale price; past a list, its first item', () => {
    const sale: ParserProfile = {
      ...profile,
      source: { kind: 'page', label: 'next-data' },
      list: ['props', 'products'],
      fields: { name: [['title']], price: [['price', 'sale'], ['price', 'regular']], was: [['price', 'regular']], image: [['images']] },
    };
    const data = { props: { products: [
      { title: 'Whole Milk', price: { regular: 3.99, sale: 2.99 }, images: ['https://img/1.jpg', 'https://img/2.jpg'] },
      { title: 'Oat Milk', price: { regular: 4.49 }, images: ['//img/3.jpg'] },
    ] } };
    const r = readWithProfile(sale, { nextDataText: JSON.stringify(data) }, ctx);
    assert.deepEqual(r.products.map((p) => [p.name, p.price, p.wasPrice, p.imageUrl]), [
      ['Whole Milk', 2.99, 3.99, 'https://img/1.jpg'],
      ['Oat Milk', 4.49, undefined, 'https://img/3.jpg'],
    ]);
    assert.equal(readPath({ a: [{ b: 1 }, { b: 2 }] }, ['a', 'b']), 1);
    assert.equal(readPath({ a: [{ b: 1 }, { b: 2 }] }, ['a', '1', 'b']), 2);
  });

  // --- Chains: the search's ids, then the products for them ---------------------------------------------------------------
  await t('chain: the page’s by-id request after a search that answered with those ids replays in two steps', () => {
    const items = itemsSource('milk');
    const chain = learnChain(items.request!, items.text, [items, searchSource('milk')], 'milk');
    assert.ok(chain && chain.kind === 'chain');
    assert.deepEqual([chain.ids, chain.asked.length], [['data', 'searchResultsPlacements', 'placements', '*', 'content', 'itemIds'], 12]);
    const eggs = chainIds(chain, searchJson('eggs'));
    assert.deepEqual(eggs, idsFor('eggs').slice(0, 12), 'the first ids, as many as the page asked for');
    const second = swapIds(chain.detail, chain.asked, eggs)!;
    assert.deepEqual([varsOf(second.url).ids, varsOf(second.url).zoneId, second.headers], [eggs, '1208', { 'x-client': 'store' }]);
    assert.match(second.url, /extensions=%7B/, 'the rest of the address as it was');
    assert.equal(learnChain(items.request!, items.text, [items], 'milk'), null, 'no search answered with its ids');
    const bodyReq: CapturedRequest = { method: 'POST', url: 'https://x/items', body: JSON.stringify({ ids: [1, 2, 3], store: 5 }) };
    assert.deepEqual(JSON.parse(swapIds(bodyReq, ['1', '2', '3'], ['7', '8'])!.body!), { ids: [7, 8], store: 5 }, 'numbers stay numbers');
  });

  // --- End to end on ALDI's storefront ------------------------------------------------------------------------------------
  await t('ALDI end to end: the page waits past the 2 featured products, takes the grid’s, replays in two steps, and learns its profile', async () => {
    const pool = new WebViewPool();
    const seen = aldiWebView(pool.lane('aldi', 'ALDI'));
    const profiles = new ProfileBook();
    const searcher = createRetailerSearch(pool, 'test', new StoreTuner(), profiles);
    // What the phone's log (Metro's) gets: each try, with how its list was read, and notes apart from tries.
    const lines: string[] = [];
    const quiet = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
      quiet(...args);
    };
    const milk = await searcher.search(aldi, 'milk', '');
    assert.deepEqual([milk.via, milk.products.length, milk.products[0].name, milk.reader?.by], ['page', 12, 'Friendly Farms Milk 1', 'general']);
    assert.equal(pool.lane('aldi').template?.kind, 'chain');
    const eggs = await searcher.search(aldi, 'eggs', '');
    assert.deepEqual([eggs.via, eggs.products.length, eggs.products[0].name, seen.pageLoads], ['replay', 12, 'Friendly Farms Eggs 1', 1]);
    assert.deepEqual(seen.replays.map((u) => /operationName=(\w+)/.exec(u)![1]), ['SearchResultsPlacements', 'Items']);
    assert.deepEqual(varsOf(seen.replays[1]).ids, idsFor('eggs').slice(0, 12), 'asked for the eggs search’s own ids');
    assert.equal(profiles.get('aldi'), undefined, 'two searches aren’t enough');
    await searcher.search(aldi, 'bread', '');
    const learned = profiles.get('aldi')!;
    assert.ok(learned, 'three that agree are');
    assert.equal(whereWords(learned), 'www.aldi.us/graphql (Items) › data › items');
    // Later searches read there first.
    const butter = await searcher.search(aldi, 'butter', '');
    assert.deepEqual([butter.products.length, butter.reader], [12, { by: 'profile' }]);
    assert.ok(profiles.get('aldi')!.matchedAt! >= learned.learnedAt);
    assert.equal(readerWords(butter.reader, 'ALDI'), 'Read where ALDI’s profile says its results are.');
    console.log = quiet;
    const tries = lines.filter((l) => l.startsWith('[on-device-search]')).map((l) => JSON.parse(l.slice(l.indexOf('{'))) as { count: number; read?: string });
    assert.deepEqual(tries.map((e) => [e.count, e.read]), [[12, 'general'], [12, 'general'], [12, 'general'], [12, 'profile']]);
    assert.deepEqual(
      lines.filter((l) => l.startsWith('[on-device-note]')),
      ['[on-device-note] {"note":"profile","retailer":"aldi","where":"www.aldi.us/graphql (Items) › data › items","searches":3,"configVersion":"test"}'],
    );
  });

  await t('ALDI end to end: when the grid never loads, the 2 featured products are all there is, said to be suspect, and never learned', async () => {
    const pool = new WebViewPool();
    aldiWebView(pool.lane('aldi', 'ALDI'), { items: false });
    const profiles = new ProfileBook();
    const searcher = createRetailerSearch(pool, 'test', new StoreTuner(), profiles);
    for (const q of ['milk', 'eggs', 'bread']) {
      const got = await searcher.search(aldi, q, '');
      assert.equal(got.products.length, 2);
      assert.match(got.reader?.suspect ?? '', /featuredProducts/);
      assert.match(got.timing?.notes?.join(' ') ?? '', /the list may not be the results/);
    }
    assert.deepEqual([profiles.get('aldi'), profiles.progress('aldi')], [undefined, 0]);
    assert.match(profiles.lastSeen('aldi')?.suspect ?? '', /featuredProducts/);
  });

  await t('falling back and relearning: when the site moves its list, the general reader reads it, and the new place is learned', async () => {
    const pool = new WebViewPool();
    let moved = false;
    aldiWebView(pool.lane('aldi', 'ALDI'), { v2: () => moved });
    const profiles = new ProfileBook();
    const searcher = createRetailerSearch(pool, 'test', new StoreTuner(), profiles);
    for (const q of ['milk', 'eggs', 'bread']) await searcher.search(aldi, q, '');
    const first = profiles.get('aldi')!;
    assert.deepEqual(first.list, ['data', 'items']);
    moved = true;
    const jam = await searcher.search(aldi, 'jam', '');
    assert.deepEqual([jam.products.length, jam.reader], [12, { by: 'general', missed: true }]);
    assert.equal(profiles.get('aldi')!.misses, 1);
    assert.match(readerWords(jam.reader, 'ALDI'), /ALDI’s profile didn’t match, so the general reader found these/);
    await searcher.search(aldi, 'rice', '');
    assert.equal(profiles.get('aldi')!.misses, STALE_MISSES, 'said to have stopped matching');
    await searcher.search(aldi, 'tea', '');
    const relearned = profiles.get('aldi')!;
    assert.deepEqual([relearned.list, relearned.misses], [['data', 'catalog', 'itemsV2', 'nodes'], undefined], 'three searches agree on the new place');
    const oats = await searcher.search(aldi, 'oats', '');
    assert.deepEqual(oats.reader, { by: 'profile' });
  });

  await t('plain requests: a profile of the page’s own data reads their pages too; one of a response isn’t tried there, nor missed', async () => {
    const page = (q: string) =>
      `<html><head><title>${title(q)} | Shop</title></head><body><script type="application/json" id="search-data">${JSON.stringify({
        results: { items: Array.from({ length: 12 }, (_, i) => ({ sku: `${q}-${i}`, title: `Good & Gather ${title(q)} ${i + 1}`, price: { current: 3 + i / 10 } })) },
      })}</script></body></html>`;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string) => ({ status: 200, ok: true, url, text: async () => page(new URL(url).searchParams.get('q') ?? '') })) as unknown as typeof fetch;
    try {
      const plain: RetailerConfig = { ...aldi, id: 'pd', name: 'PD', searchUrl: 'https://www.pd.com/s?q={{query}}', strategies: ['fetch'], replay: false };
      const profiles = new ProfileBook();
      const searcher = createRetailerSearch(new WebViewPool(), 'test', new StoreTuner(), profiles);
      for (const q of ['milk', 'eggs', 'bread']) await searcher.search(plain, q, '');
      assert.deepEqual(profiles.get('pd')?.source, { kind: 'page', label: 'json script #search-data' });
      const jam = await searcher.search(plain, 'jam', '');
      assert.deepEqual([jam.products.length, jam.reader], [12, { by: 'profile' }]);
      // A profile of a response the page's scripts fetch later: a plain request's page never has one.
      const other = new ProfileBook();
      other.seed([{ id: 'pd', profile: { ...profiles.get('pd')!, source: { kind: 'request', host: 'www.pd.com', path: '/api/search' } } }]);
      const rice = await createRetailerSearch(new WebViewPool(), 'test', new StoreTuner(), other).search(plain, 'rice', '');
      assert.deepEqual([rice.products.length, rice.reader, other.get('pd')?.misses], [12, { by: 'general' }, undefined]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  await t('forced strategies and the phone vs. server test don’t teach profiles', async () => {
    const pool = new WebViewPool();
    aldiWebView(pool.lane('aldi', 'ALDI'));
    const profiles = new ProfileBook();
    const searcher = createRetailerSearch(pool, 'test', new StoreTuner(), profiles);
    for (const q of ['milk', 'eggs', 'bread']) await searcher.search(aldi, q, '', 'webview');
    for (const q of ['jam', 'rice', 'tea']) await searcher.search(aldi, q, '', undefined, { kind: 'versus', challenge: 'report' });
    assert.deepEqual([profiles.get('aldi'), profiles.lastSeen('aldi')], [undefined, undefined]);
  });

  // --- Keeping them -------------------------------------------------------------------------------------------------------
  await t('profiles are saved on the phone, travel in the rules file, and a reset makes the store learn again', () => {
    let now = 10_000;
    const book = new ProfileBook(() => now);
    for (let i = 0; i < AGREE; i++) book.observe('aldi', obs(now + i));
    const again = new ProfileBook(() => now);
    again.hydrate(book.serialize());
    assert.deepEqual(again.get('aldi'), book.get('aldi'));
    again.hydrate('{"aldi":{"profile":{"source":"x"}},"x":7}');
    assert.equal(again.get('aldi'), undefined, 'a broken save is left out');

    // In a rules file: checked like every other field.
    const withProfile = { ...aldi, profile: book.get('aldi') };
    assert.equal(isRetailerConfig(withProfile), true);
    assert.equal(isProfile(book.get('aldi')), true);
    const broken = { version: 'v', retailers: [{ ...aldi, profile: { ...book.get('aldi')!, fields: { name: 'name' } } }] };
    assert.match(rulesProblem(broken) ?? '', /Store 1 \(aldi\)/);
    // A file's profile is taken by a store with none, or an older one of its own; one learned before a reset isn't.
    const fresh = new ProfileBook(() => now);
    fresh.seed([withProfile]);
    assert.equal(fresh.get('aldi')?.how, 'rules');
    now += 1000;
    fresh.reset('aldi');
    fresh.seed([withProfile]);
    assert.equal(fresh.get('aldi'), undefined, 'the reset stands');
    fresh.seed([{ ...withProfile, profile: { ...withProfile.profile!, learnedAt: now + 5 } }]);
    assert.equal(fresh.get('aldi')?.how, 'rules', 'until a newer one comes');
  });

  log(`\n${passed} parser profile tests passed`);
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
