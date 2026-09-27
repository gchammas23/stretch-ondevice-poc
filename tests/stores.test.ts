/// <reference types="node" />
import assert from 'node:assert/strict';
import type { StoreSetResult, StoresNearResult } from '../src/onDevice/retailerSearch';
import { BUNDLED_CONFIG } from '../src/onDevice/retailers';
import {
  mergeStores,
  parseStoreLabel,
  pinStoreInRequest,
  sameStoreId,
  sameStoreName,
  storeFromFinder,
  storeIdFromLink,
  storeIdFromPageData,
  storeIdFromRequest,
  storeLine,
} from '../src/onDevice/storeIdentity';
import { milesBetween, nearbyStores, sortNearest, withinRadius, type NearbyStore } from '../src/onDevice/storeLocator';
import type { RetailerConfig } from '../src/onDevice/types';
import { storeInfo, storeNote } from '../src/state/storeInfo';
import { AppStore, type KeyValueStore } from '../src/state/appStore';
import { storeChoices } from '../src/state/storeChoices';
import { chooseStore, currentSetup, isUsZip, setUpStores, type SetupDeps } from '../src/state/storeSetup';

const retailers = BUNDLED_CONFIG.retailers;
const byId = (id: string) => retailers.find((r) => r.id === id)!;
const memory = (): KeyValueStore => {
  const m = new Map<string, string>();
  return { getItem: async (k) => m.get(k) ?? null, setItem: async (k, v) => { m.set(k, v); } };
};
const fresh = async (storage = memory()) => {
  const store = new AppStore();
  await store.hydrate(storage);
  return store;
};
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

// Each retailer's stores near 10001, as its API or store finder would list them.
const WALMART: NearbyStore[] = [
  { id: '3520', name: 'Secaucus Supercenter', address: '400 Park Pl, Secaucus, NJ 07094', miles: 2.3 },
  { id: '2280', name: 'Jersey City Supercenter', address: '501 Route 440, Jersey City, NJ 07305', miles: 3.1 },
  { id: '5281', name: 'Teterboro Supercenter', miles: 11.4 },
];
const KROGER: NearbyStore[] = [{ id: '01400943', name: 'Kroger', address: '1014 Vine St, Cincinnati, OH 45202', miles: 1.2 }];
const TARGET: NearbyStore[] = [{ id: '1340', name: 'Brooklyn Atlantic Terminal', address: '139 Flatbush Ave, Brooklyn, NY 11217', miles: 4.8 }];
const ALDI: NearbyStore[] = [{ id: '77', name: 'ALDI Far Away', miles: 40 }];
type Listing = StoresNearResult | ((zip: string, radius: number) => Promise<StoresNearResult>);
const LISTS: Record<string, Listing> = {
  walmart: { ok: true, stores: WALMART, how: 'finder' },
  kroger: { ok: true, stores: KROGER, how: 'api' },
  target: { ok: true, stores: TARGET, how: 'finder' },
  aldi: { ok: true, stores: ALDI, how: 'finder' },
  costco: { ok: false, reason: 'challenge' },
};

/** A stand-in for the phone's side: each retailer's stores near a ZIP, and the store finders the app presses. */
function fakeSearch(opts: { lists?: Record<string, Listing>; auto?: (cfg: RetailerConfig, target?: { id?: string; name?: string }) => Promise<StoreSetResult> } = {}) {
  const calls: string[] = [];
  const search: SetupDeps['search'] = {
    storesNear: async (cfg, zip, radius, origin) => {
      calls.push(`list ${cfg.id} ${zip} ${radius}${origin ? ' +map' : ''}`);
      const listing = (opts.lists ?? LISTS)[cfg.id] ?? { ok: false, reason: 'no_store_finder' };
      return typeof listing === 'function' ? listing(zip, radius) : listing;
    },
    setStoreAuto: async (cfg, _zip, target) => {
      calls.push(`press ${cfg.id} ${target?.id ?? ''}`);
      return opts.auto ? opts.auto(cfg, target) : { ok: true, label: target?.name };
    },
  };
  return { search, calls };
}
const depsFor = (store: AppStore, search: SetupDeps['search'], locate?: SetupDeps['locate']): SetupDeps => ({
  store,
  search,
  retailers,
  apiTakesZip: (cfg) => cfg.id === 'kroger',
  ...(locate ? { locate } : {}),
});

let passed = 0;
const t = async (name: string, fn: () => unknown) => { await fn(); passed++; console.log('ok -', name); };

(async () => {
  await t('choices: an official API takes the ZIP until a store is set; a store set on the site drops the plain request; the key follows the store', async () => {
    const store = await fresh();
    const pick = (id: string) => storeChoices(store.getState().settings, retailers, (cfg) => cfg.api === 'kroger').find((c) => c.config.id === id)!;
    assert.deepEqual([pick('walmart').config.strategies, pick('kroger').storeId], [['fetch', 'webview'], '']);
    store.setZip('10001');
    assert.deepEqual([pick('kroger').storeId, pick('walmart').storeId], ['10001', '']);
    store.setStoreId('kroger', '01400943');
    assert.equal(pick('kroger').storeId, '01400943', 'the store set for it');
    const before = pick('walmart').storeKey;
    store.storePicked('walmart');
    assert.deepEqual(pick('walmart').config.strategies, ['webview'], 'a plain request wouldn’t send the site’s cookies');
    assert.notEqual(pick('walmart').storeKey, before, 'saved prices for the old store aren’t reused');
    assert.deepEqual(pick('kroger').config.strategies, ['api'], 'with keys, no slow website fallback');
    const noKeys = storeChoices(store.getState().settings, retailers, () => false).find((c) => c.config.id === 'kroger')!;
    assert.deepEqual(noKeys.config.strategies, ['api', 'webview']);
  });

  await t('set up: each retailer’s nearest store; none within the radius drops it; a finder that fails leaves the site to pick', async () => {
    const store = await fresh();
    store.setRetailers(['walmart', 'kroger', 'target', 'aldi', 'costco']);
    const f = fakeSearch();
    assert.equal(isUsZip('1000'), false);
    await setUpStores('1000', depsFor(store, f.search));
    assert.deepEqual([store.getState().settings.zip, f.calls], ['', []], 'not a ZIP: nothing happens');

    await setUpStores(' 10001 ', depsFor(store, f.search));
    const s = store.getState().settings;
    const setup = (id: string) => currentSetup(store, id);
    assert.deepEqual(
      [...f.calls].sort(),
      ['list aldi 10001 10', 'list costco 10001 10', 'list kroger 10001 10', 'list target 10001 10', 'list walmart 10001 10', 'press walmart 3520'],
    );
    assert.deepEqual(
      ['walmart', 'kroger', 'target'].map((id) => [setup(id)?.status, setup(id)?.how, s.storeIds[id]]),
      [['done', 'auto', '3520'], ['done', 'api', '01400943'], ['done', 'pinned', '1340']],
    );
    assert.deepEqual([setup('aldi')?.status, s.storeIds.aldi], ['none', undefined], 'its nearest is 40 mi away');
    assert.deepEqual([setup('costco')?.status, setup('costco')?.reason], ['failed', 'challenge']);
    const { at, ...walmart } = s.chosenStores.walmart;
    assert.ok(at > 0);
    assert.deepEqual(walmart, { name: 'Secaucus Supercenter', address: '400 Park Pl, Secaucus, NJ 07094', id: '3520', from: 'nearest', miles: 2.3 });
    assert.ok(s.storePickedAt.walmart, 'set in its cookies: prices saved for the store before aren’t reused');
    assert.deepEqual([s.nearbyStores.kroger.radius, s.nearbyStores.walmart.radius], [10, 0], 'an API lists within the radius; a finder, the nearest');
    assert.deepEqual(
      storeChoices(s, retailers, () => false).map((c) => [c.config.id, c.storeId]),
      [['walmart', '3520'], ['kroger', '01400943'], ['target', '1340'], ['costco', '']],
      'ALDI isn’t searched',
    );
  });

  await t('set up: a store picked from the list stays while in range; lists are reused until the radius grows; nothing is set twice', async () => {
    const store = await fresh();
    store.setRetailers(['walmart', 'kroger', 'aldi']);
    const f = fakeSearch();
    const deps = depsFor(store, f.search);
    await setUpStores('10001', deps);
    f.calls.length = 0;
    assert.equal(await chooseStore(byId('walmart'), WALMART[1], deps), true);
    assert.deepEqual(f.calls, ['press walmart 2280']);
    const walmart = () => [store.getState().settings.storeIds.walmart, store.getState().settings.chosenStores.walmart?.from, currentSetup(store, 'walmart')?.status];
    assert.deepEqual(walmart(), ['2280', 'list', 'done']);

    f.calls.length = 0;
    await setUpStores('10001', deps);
    assert.deepEqual(f.calls, [], 'the same ZIP: the lists and stores already set are kept');
    assert.deepEqual(walmart(), ['2280', 'list', 'done']);

    store.setRadius(50);
    await setUpStores('10001', deps);
    assert.deepEqual([...f.calls].sort(), ['list kroger 10001 50'], 'only an API’s list, asked within the old radius, is asked again');
    assert.deepEqual([currentSetup(store, 'aldi')?.status, store.getState().settings.storeIds.aldi, currentSetup(store, 'aldi')?.how], ['done', '77', 'pinned']);

    f.calls.length = 0;
    store.setRadius(3);
    await setUpStores('10001', deps);
    assert.deepEqual(f.calls, ['press walmart 3520'], 'the store picked is 3.1 mi away, so the nearest takes over');
    assert.deepEqual(walmart(), ['3520', 'nearest', 'done']);
    assert.equal(currentSetup(store, 'aldi')?.status, 'none');

    f.calls.length = 0;
    await setUpStores('10001', deps, ['walmart'], { refresh: true });
    assert.deepEqual(f.calls, ['list walmart 10001 3', 'press walmart 3520'], 'looking again lists and sets it again');
  });

  await t('set up: a failed press or listing; looking again that fails keeps the store; a result for a replaced ZIP is dropped', async () => {
    const store = await fresh();
    const failing = fakeSearch({ auto: async () => ({ ok: false, reason: 'button_not_found' }) });
    await setUpStores('10001', depsFor(store, failing.search));
    assert.deepEqual([currentSetup(store, 'walmart')?.status, currentSetup(store, 'walmart')?.reason], ['failed', 'button_not_found']);
    assert.deepEqual([store.getState().settings.storePickedAt.walmart, store.getState().settings.storeIds.walmart], [undefined, undefined]);

    const ok = fakeSearch();
    await setUpStores('10001', depsFor(store, ok.search), ['walmart'], { refresh: true });
    assert.equal(currentSetup(store, 'walmart')?.status, 'done');
    const blocked = fakeSearch({ lists: { walmart: { ok: false, reason: 'challenge' } } });
    await setUpStores('10001', depsFor(store, blocked.search), ['walmart'], { refresh: true });
    assert.deepEqual([currentSetup(store, 'walmart')?.status, store.getState().settings.storeIds.walmart], ['done', '3520'], 'the store already set stays');

    let release!: () => void;
    const slow = fakeSearch({ lists: { walmart: () => new Promise((r) => { release = () => r({ ok: true, stores: WALMART, how: 'finder' }); }) } });
    const first = setUpStores('30301', depsFor(store, slow.search), ['walmart']);
    await tick();
    assert.deepEqual([currentSetup(store, 'walmart')?.status, store.getState().settings.storeIds], ['working', {}], 'a new ZIP forgets the stores set near the old one');
    store.setZip('60601');
    release();
    await first;
    assert.equal(currentSetup(store, 'walmart'), undefined, 'nothing recorded for the ZIP now set');
    assert.deepEqual(slow.calls, ['list walmart 30301 10']);
  });

  await t('set up: distances from the map when a finder gives none; with no distances at all, nothing is dropped', async () => {
    const store = await fresh();
    store.setRetailers(['target', 'aldi']);
    const located: string[] = [];
    const locate = async (zip: string) => { located.push(zip); return { lat: 40.75, lng: -73.99 }; };
    const f = fakeSearch({ lists: { target: { ok: true, stores: [{ id: '1340', name: 'Brooklyn' }, { id: '1920', name: 'Queens' }], how: 'finder' }, aldi: { ok: true, stores: ALDI, how: 'finder' } } });
    await setUpStores('10001', depsFor(store, f.search, locate));
    assert.deepEqual([...f.calls].sort(), ['list aldi 10001 10 +map', 'list target 10001 10 +map'], 'finders get where the ZIP is, to measure');
    assert.deepEqual(store.getState().settings.origin, { zip: '10001', lat: 40.75, lng: -73.99 });
    assert.deepEqual([currentSetup(store, 'target')?.status, store.getState().settings.storeIds.target], ['done', '1340'], 'unmeasured: the finder’s first');
    await setUpStores('10001', depsFor(store, f.search, locate), undefined, { refresh: true });
    assert.deepEqual(located, ['10001'], 'looked up once per ZIP');
  });

  await t('a setup still running when the app closed has failed when it opens again, as has one left for the site', async () => {
    const storage = memory();
    const store = await fresh(storage);
    store.setZip('10001');
    store.setStoreSetup('walmart', { zip: '10001', status: 'working', at: 1 });
    store.setStoreSetup('target', { zip: '10001', status: 'needsYou' as 'failed', at: 1 });
    await store.flush();
    const reopened = await fresh(storage);
    assert.deepEqual(
      ['walmart', 'target'].map((id) => [currentSetup(reopened, id)?.status, currentSetup(reopened, id)?.reason]),
      [['failed', 'interrupted'], ['failed', 'interrupted']],
    );
  });

  // --- Stores near a ZIP ---------------------------------------------------------------------------------------
  await t('nearby: the store list a finder got, whatever it calls the fields, nearest first', () => {
    const walmartLike = JSON.stringify({
      props: { pageProps: { initialData: { stores: [
        { id: 2280, displayName: 'Jersey City Supercenter', address: { address: '501 Route 440', city: 'Jersey City', state: 'NJ', postalCode: '07305' }, distance: 3.1 },
        { id: 3520, displayName: 'Secaucus Supercenter', address: { address: '400 Park Pl', city: 'Secaucus', state: 'NJ', postalCode: '07094' }, distance: 2.3 },
      ] } } },
    });
    assert.deepEqual(nearbyStores({ nextDataText: walmartLike }).map((s) => [s.id, s.name, s.address, s.miles]), [
      ['3520', 'Secaucus Supercenter', '400 Park Pl, Secaucus, NJ 07094', 2.3],
      ['2280', 'Jersey City Supercenter', '501 Route 440, Jersey City, NJ 07305', 3.1],
    ]);

    // Yext, as Safeway's finder answers: the store's own coordinates, not its city's, and a distance in miles.
    const yext = JSON.stringify({ response: { entities: [
      { distance: { distanceMiles: 1.1772, id: '667' }, profile: { name: 'Safeway', address: { line1: '5290 Diamond Heights Blvd', city: 'San Francisco', region: 'CA', postalCode: '94131' }, cityCoordinate: { lat: 37.7752, long: -122.4192 }, displayCoordinate: { lat: 37.7436, long: -122.439 }, meta: { id: '667' } } },
      { distance: { distanceMiles: 0.4326, id: '739' }, profile: { name: 'Safeway', address: { line1: '3350 Mission St', city: 'San Francisco', region: 'CA', postalCode: '94110' }, cityCoordinate: { lat: 37.7752, long: -122.4192 }, displayCoordinate: { lat: 37.7432, long: -122.4225 }, meta: { id: '739' } } },
    ] } });
    assert.deepEqual(nearbyStores({ sources: [{ label: 'response', text: yext }] }), [
      { id: '739', name: 'Safeway', address: '3350 Mission St, San Francisco, CA 94110', miles: 0.43, lat: 37.7432, lng: -122.4225 },
      { id: '667', name: 'Safeway', address: '5290 Diamond Heights Blvd, San Francisco, CA 94131', miles: 1.18, lat: 37.7436, lng: -122.439 },
    ]);

    // Places on the map only: measured from the ZIP's center.
    const mapped = JSON.stringify({ locations: [
      { locationId: '01400943', name: 'Kroger On Vine', address: { addressLine1: '1014 Vine St', city: 'Cincinnati', state: 'OH', zipCode: '45202' }, geolocation: { latitude: 39.1086, longitude: -84.5153 } },
      { locationId: '01400376', name: 'Kroger Corryville', address: { addressLine1: '2900 Woodburn Ave', city: 'Cincinnati', state: 'OH', zipCode: '45206' }, geolocation: { latitude: 39.1286, longitude: -84.4912 } },
    ] });
    const measured = nearbyStores({ sources: [{ label: 'response', text: mapped }] }, { lat: 39.1031, lng: -84.512 });
    assert.deepEqual(measured.map((s) => [s.id, s.miles]), [['01400943', 0.4], ['01400376', 2.1]]);

    const products = JSON.stringify({ items: [{ id: '1', name: 'Whole Milk', price: 3.49 }, { id: '2', name: 'Eggs', price: 4.99 }] });
    assert.deepEqual(nearbyStores({ sources: [{ label: 'response', text: products }] }), [], 'a product list isn’t a store list');

    const cards = nearbyStores({ cards: [
      { lines: ['Brooklyn Atlantic Terminal', '21 Flushing Ave', 'Brooklyn, NY 11205'], href: 'https://www.target.com/sl/brooklyn-atlantic-terminal/1340' },
      { lines: ['Queens Place', '88-01 Queens Blvd', 'Elmhurst, NY 11373', '1.8 mi'], href: '/sl/queens-place/1920' },
    ] });
    assert.deepEqual(cards.map((s) => [s.id, s.miles]), [['1920', 1.8], ['1340', undefined]], 'from store cards; 21 Flushing Ave is no distance');
  });

  await t('nearby: within the radius, when distances are known; miles between places', () => {
    const stores: NearbyStore[] = [{ id: 'a', name: 'A', miles: 12 }, { id: 'b', name: 'B', miles: 4 }, { id: 'c', name: 'C' }];
    assert.deepEqual(sortNearest(stores).map((s) => s.id), ['b', 'a', 'c']);
    assert.deepEqual(withinRadius(stores, 10), { stores: [stores[1]], measured: true });
    assert.deepEqual(withinRadius([{ id: 'x', name: 'X' }], 1), { stores: [{ id: 'x', name: 'X' }], measured: false }, 'nothing to tell: all kept');
    assert.equal(Math.round(milesBetween({ lat: 40.7506, lng: -73.9971 }, { lat: 40.7357, lng: -74.1724 })), 9, 'Penn Station to Newark');
  });

  // --- Which store ---------------------------------------------------------------------------------------------
  await t('which store: the number a search asks prices for, from its URL, body, GraphQL variables or a header', () => {
    const id = (req: Parameters<typeof storeIdFromRequest>[0]) => storeIdFromRequest(req)?.id;
    assert.equal(id({ url: 'https://redsky.target.com/plp_search_v2?keyword=milk&store_ids=1920%2C1340&pricing_store_id=1340&visitor_id=A1' }), '1340', 'the pricing store, not the nearby list');
    assert.equal(id({ url: 'https://redsky.target.com/x?keyword=milk&store_ids=1920%2C1340' }), '1920', 'a list alone: its first');
    assert.equal(id({ url: 'https://api.kroger.com/v1/products?filter.term=milk&filter.locationId=01400943' }), '01400943');
    assert.equal(id({ url: 'https://www.heb.com/graphql', body: JSON.stringify({ variables: { searchTerm: 'milk', storeId: 92 } }) }), '92');
    assert.equal(id({ url: 'https://shop.example.com/graphql?operationName=Items&variables=%7B%22shopId%22%3A%2212345%22%7D' }), '12345');
    assert.equal(id({ url: 'https://www.wholefoodsmarket.com/api/search?text=milk&store=10160' }), '10160');
    assert.equal(id({ url: 'https://x.com/api', body: 'q=milk&storeNumber=0457' }), '0457', 'a form body');
    assert.equal(id({ url: 'https://x.com/api', headers: { 'x-store-id': '88', authorization: 'Bearer 12345' } }), '88');
    assert.equal(id({ url: 'https://x.com/s?q=milk&store=true&storeId=0000&zip=10001' }), undefined, 'not store numbers');
    assert.equal(id(undefined), undefined);
    assert.deepEqual(storeIdFromRequest({ url: 'https://x.com/s?pricing_store_id=1340' }), { id: '1340', field: 'pricing_store_id in the request URL' });
  });

  await t('which store: a search pointed at the store set, wherever the request names one', () => {
    const pin = (req: Parameters<typeof pinStoreInRequest>[0]) => pinStoreInRequest(req, '1340');
    assert.equal(pin({ url: 'https://redsky.target.com/plp_search_v2?keyword=milk&store_ids=1920%2C1263&pricing_store_id=1263' }).request.url, 'https://redsky.target.com/plp_search_v2?keyword=milk&store_ids=1920%2C1263&pricing_store_id=1340');
    const heb = pinStoreInRequest({ url: 'https://www.heb.com/graphql', body: JSON.stringify({ variables: { searchTerm: 'milk', storeId: 92 } }) }, '790');
    assert.deepEqual([heb.pinned, JSON.parse(heb.request.body!).variables.storeId], [true, 790], 'a number stays a number');
    const gql = pin({ url: 'https://shop.example.com/graphql?operationName=Items&variables=%7B%22shopId%22%3A%2212345%22%7D' }).request.url;
    assert.equal(JSON.parse(new URL(gql).searchParams.get('variables')!).shopId, '1340');
    assert.equal(pin({ url: 'https://x.com/api', body: 'q=milk&storeNumber=0457' }).request.body, 'q=milk&storeNumber=1340');
    assert.deepEqual(pin({ url: 'https://x.com/api', headers: { 'x-store-id': '88' } }).request.headers, { 'x-store-id': '1340' });
    assert.deepEqual(pin({ url: 'https://x.com/s?q=milk' }), { request: { url: 'https://x.com/s?q=milk' }, pinned: false }, 'no store in it: left as it is');
  });

  await t('which store: named as a site’s header or a store finder writes it, number and address apart', () => {
    assert.deepEqual(parseStoreLabel('Your store: Brooklyn Atlantic Terminal · Open until 10pm'), { name: 'Brooklyn Atlantic Terminal' });
    assert.deepEqual(parseStoreLabel('My Warehouse Brooklyn'), { name: 'Brooklyn' });
    assert.deepEqual(parseStoreLabel('Shopping at Sprouts Farmers Market 139 Flatbush Ave, Brooklyn, NY 11217'), {
      name: 'Sprouts Farmers Market',
      address: '139 Flatbush Ave, Brooklyn, NY 11217',
    });
    assert.deepEqual(parseStoreLabel('Secaucus Supercenter #3520 400 Park Pl, Secaucus, NJ 07094 2.3 mi'), {
      name: 'Secaucus Supercenter',
      address: '400 Park Pl, Secaucus, NJ 07094',
      id: '3520',
    });
    assert.deepEqual(parseStoreLabel('Store 1340'), { id: '1340' });
    assert.deepEqual(parseStoreLabel('Lake View Plaza'), { name: 'Lake View Plaza' }, 'a word in its name isn’t cut');
    assert.equal(parseStoreLabel('Find a store'), undefined);
    assert.equal(parseStoreLabel(''), undefined);

    const listing = { label: 'Secaucus Supercenter', lines: ['Secaucus Supercenter', '400 Park Pl', 'Secaucus, NJ 07094', 'Open until 11pm'], links: ['/store/3520-secaucus-nj'] };
    assert.deepEqual(storeFromFinder(listing, '07094'), { name: 'Secaucus Supercenter', address: '400 Park Pl, Secaucus, NJ 07094', id: '3520' });
    assert.equal(storeIdFromLink('https://www.target.com/sl/brooklyn-atlantic-terminal/1340'), '1340');
    assert.equal(storeIdFromLink('https://www.target.com/store-locator/find-stores/10001', '10001'), undefined, 'the ZIP searched for isn’t a store');
    assert.equal(storeFromFinder('nothing'), undefined);
    assert.deepEqual(mergeStores({ id: '1340' }, undefined, { name: 'Brooklyn', id: '9' }), { id: '1340', name: 'Brooklyn' });
    assert.deepEqual([sameStoreId('01400943', '1400943'), sameStoreId('3081', '3520'), sameStoreId(undefined, '')], [true, false, false]);
    assert.deepEqual([storeLine({ name: 'Kroger', id: '01400943' }), storeLine({ id: '1340' }), storeLine(undefined)], ['Kroger (store 01400943)', 'Store 1340', undefined]);
  });

  await t('which store: kept as it was set, and as searches saw it; a new store or ZIP forgets what searches saw', async () => {
    const storage = memory();
    const store = await fresh(storage);
    store.setRetailers(['walmart', 'target', 'kroger']);
    await setUpStores('10001', depsFor(store, fakeSearch().search));
    const { chosenStores } = store.getState().settings;
    assert.deepEqual([chosenStores.walmart.from, chosenStores.walmart.id, chosenStores.target.from, chosenStores.target.name], ['nearest', '3520', 'nearest', 'Brooklyn Atlantic Terminal']);

    store.noteSeenStore('target', 'k1', { id: '1340' }, 1000);
    store.noteSeenStore('target', 'k1', { name: 'Brooklyn Atlantic Terminal' }, 2000);
    assert.deepEqual(store.getState().settings.seenStores.target, { id: '1340', name: 'Brooklyn Atlantic Terminal', storeKey: 'k1', at: 2000 }, 'what each search showed, together');
    const before = store.getState();
    store.noteSeenStore('target', 'k1', { id: '1340' }, 30_000);
    assert.equal(store.getState(), before, 'nothing new within a minute: no write');
    store.noteSeenStore('target', 'k1', { id: '1920' }, 40_000);
    assert.deepEqual(store.getState().settings.seenStores.target, { id: '1920', storeKey: 'k1', at: 40_000 }, 'another store: the old name goes');

    await store.flush();
    const reopened = await fresh(storage);
    assert.deepEqual([reopened.getState().settings.seenStores.target.id, reopened.getState().settings.chosenStores.walmart.id], ['1920', '3520'], 'saved');
    store.storePicked('target');
    assert.equal(store.getState().settings.seenStores.target, undefined, 'a new store on the site');
    store.noteSeenStore('kroger', 'k2', { id: '01400943' }, 1);
    store.setZip('10001');
    assert.ok(store.getState().settings.seenStores.kroger, 'the same ZIP again changes nothing');
    store.setZip('60601');
    const s = store.getState().settings;
    assert.deepEqual([s.seenStores, s.chosenStores, s.storeIds], [{}, {}, {}], 'a new ZIP: the stores near the old one go');
    store.reset();
    assert.deepEqual([store.getState().settings.chosenStores, store.getState().settings.seenStores], [{}, {}]);
  });

  await t('which store: Your stores shows its name, address, number and distance, how it was set, and where prices came from', async () => {
    const store = await fresh();
    store.setRetailers(['walmart', 'kroger', 'target', 'aldi', 'costco']);
    const deps = depsFor(store, fakeSearch().search);
    await setUpStores('10001', deps);
    const now = 10 * 60_000;
    const info = (id: string, name: string, key = 'k') => storeInfo(id, name, `${id}.com`, store.getState().settings, key, now);

    assert.deepEqual(info('walmart', 'Walmart'), {
      title: 'Secaucus Supercenter',
      detail: '400 Park Pl, Secaucus, NJ 07094 · store 3520 · 2.3 mi',
      how: 'Nearest to 10001, set on walmart.com’s store finder by the app',
    });
    store.noteSeenStore('walmart', 'k', { id: '3520' }, now - 2 * 60_000);
    assert.deepEqual(info('walmart', 'Walmart').check, { tone: 'ok', text: 'The last search’s prices were for this store (2 min ago).' });
    assert.equal(info('walmart', 'Walmart', 'another key').check, undefined, 'a search for an earlier store says nothing');
    store.noteSeenStore('walmart', 'k', { id: '2280', name: 'Jersey City Supercenter' }, now);
    assert.deepEqual(info('walmart', 'Walmart').check, {
      tone: 'warn',
      text: 'The last search got prices for Jersey City Supercenter (store 2280) instead: walmart.com wouldn’t take this store.',
    });
    assert.equal(storeNote('walmart', store.getState().settings), 'Jersey City Supercenter (store 2280), near 10001', 'headers show where the prices came from');

    assert.deepEqual(info('kroger', 'Kroger'), {
      title: 'Kroger',
      detail: '1014 Vine St, Cincinnati, OH 45202 · store 01400943 · 1.2 mi',
      how: 'Nearest to 10001, through Kroger’s official API',
    });
    assert.deepEqual([info('target', 'Target').title, info('target', 'Target').how], ['Brooklyn Atlantic Terminal', 'Nearest to 10001, asked for by number in each search']);
    assert.equal(storeNote('target', store.getState().settings), 'Brooklyn Atlantic Terminal (store 1340), near 10001');
    assert.deepEqual(info('aldi', 'ALDI'), { title: 'No ALDI within 10 mi', how: 'Its nearest store is 40 mi from 10001, so it isn’t compared.' });
    assert.deepEqual(info('costco', 'Costco'), {
      title: 'The store costco.com picks for this phone',
      how: 'Couldn’t set its store near 10001: a bot check.',
    });

    await chooseStore(byId('target'), { id: '1920', name: 'Queens Place', miles: 5.2 }, deps);
    assert.deepEqual(info('target', 'Target'), { title: 'Queens Place', detail: 'store 1920 · 5.2 mi', how: 'Picked by you, asked for by number in each search' });

    // No ZIP: the site picks, and its searches say which store it picked.
    const none = await fresh();
    const noZip = (id: string) => storeInfo(id, 'Target', 'target.com', none.getState().settings, 'k', now);
    assert.deepEqual(noZip('target'), { title: 'The store target.com picks for this phone', how: 'Not chosen: target.com picks one from this phone’s connection. Set your location to use the nearest store.' });
    none.noteSeenStore('target', 'k', { id: '1340' }, now);
    assert.deepEqual([noZip('target').title, noZip('target').check?.tone], ['Store 1340', 'ok']);
  });

  await t('which store: a search that said nothing about its store is noted once, and Your stores says the number went nowhere', async () => {
    const store = await fresh();
    store.setRetailers(['walmart', 'target']);
    const deps = depsFor(store, fakeSearch().search);
    await setUpStores('10001', deps);
    const now = 10 * 60_000;
    const info = (id: string, name: string) => storeInfo(id, name, `${id}.com`, store.getState().settings, 'k', now);

    // Target is asked for by number: a search whose request carried none never applied it.
    store.noteSeenStore('target', 'k', {}, now - 60_000);
    assert.deepEqual(store.getState().settings.seenStores.target, { storeKey: 'k', at: now - 60_000 });
    const before = store.getState();
    store.noteSeenStore('target', 'k', {}, now);
    assert.equal(store.getState(), before, 'noted once per store key');
    assert.deepEqual(info('target', 'Target').check, {
      tone: 'warn',
      text: 'The last search’s request carried no store number, so target.com priced the store it picks itself (1 min ago).',
    });
    store.noteSeenStore('target', 'k', { id: '1340' }, now);
    assert.equal(info('target', 'Target').check?.tone, 'ok', 'a later search that did say replaces it');
    store.noteSeenStore('target', 'k', {}, now + 1);
    assert.equal(store.getState().settings.seenStores.target.id, '1340', 'and isn’t replaced by one that didn’t');

    // Walmart's store is set on its site: without a number, the name its page shows is what there is to go by.
    store.noteSeenStore('walmart', 'k', {}, now);
    assert.deepEqual(info('walmart', 'Walmart').check, { tone: 'warn', text: 'The last search didn’t say which store it priced (just now).' });
    store.noteSeenStore('walmart', 'k', { name: 'Jersey City Supercenter' }, now + 70_000);
    assert.deepEqual(info('walmart', 'Walmart').check, {
      tone: 'warn',
      text: 'The last search got prices for Jersey City Supercenter instead: walmart.com wouldn’t take this store.',
    });
    assert.equal(storeNote('walmart', store.getState().settings), 'Jersey City Supercenter, near 10001');
    store.noteSeenStore('walmart', 'k', { name: 'Secaucus' }, now + 140_000);
    assert.equal(info('walmart', 'Walmart').check?.tone, 'ok', 'a shorter form of the same name');
    store.noteSeenStore('walmart', 'k', { id: '3520', name: 'Somewhere Else' }, now + 210_000);
    assert.equal(info('walmart', 'Walmart').check?.tone, 'ok', 'the number settles it when both have one');

    assert.deepEqual(
      [
        sameStoreName('Sacramento Supercenter', 'Sacramento Gerber Rd Supercenter'),
        sameStoreName('Kroger', 'Kroger On Vine'),
        sameStoreName('Secaucus Supercenter', 'Houston Heights Supercenter'),
        sameStoreName('H-E-B', 'Buffalo Heights H-E-B'),
        sameStoreName(undefined, 'Kroger'),
      ],
      [true, true, false, undefined, undefined],
    );
  });

  await t('which store: the number in a page’s own data, when the products were in the page', () => {
    // Walmart's page data, as a phone saw it (2026-09-27): the store under the page metadata, next to the ZIP.
    const walmart = JSON.stringify({
      props: {
        pageProps: {
          initialData: { searchResult: { itemStacks: [{ items: [{ id: 'a', storeIds: '3520,2280' }, { id: 'b' }] }] } },
          initialTempoData: { data: { contentLayout: { pageMetadata: { location: { postalCode: '10016', storeId: '3520' } } } } },
        },
      },
    });
    assert.deepEqual(storeIdFromPageData(walmart), { id: '3520', field: 'storeId in the page data' });
    assert.deepEqual(storeIdFromPageData(JSON.stringify({ stores: [{ storeId: 1 }, { storeId: 2 }], picked: { storeId: 1 } })), { id: '1', field: 'storeId in the page data' }, 'the value most fields hold');
    assert.equal(storeIdFromPageData(JSON.stringify({ stores: [{ storeId: 1 }, { storeId: 2 }] })), undefined, 'no one store has most of them');
    assert.deepEqual(
      storeIdFromPageData(JSON.stringify({ a: { pricing_store_id: '1340' }, b: { storeId: '9' }, c: { storeId: '9' } })),
      { id: '1340', field: 'pricing_store_id in the page data' },
      'the best-ranked field wins over a commoner one',
    );
    assert.equal(storeIdFromPageData(JSON.stringify({ items: [{ id: 'x', price: 3, store: 'Walmart' }] })), undefined, 'not a store number');
    assert.deepEqual([storeIdFromPageData('not json'), storeIdFromPageData(''), storeIdFromPageData(undefined)], [undefined, undefined, undefined]);
  });

  console.log(`\n${passed} store setup tests passed`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
