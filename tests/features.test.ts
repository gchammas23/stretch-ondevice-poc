/// <reference types="node" />
import assert from 'node:assert/strict';
import { listText, parseListText } from '../src/lists/parse';
import type { GroceryList } from '../src/lists/types';
import { isRetailerConfig } from '../src/onDevice/retailers';
import type { Product } from '../src/onDevice/types';
import { basketFor, bestSplit, type ItemResult } from '../src/pricing/basket';
import { isMatch, queryWords } from '../src/pricing/matching';
import { PriceCache } from '../src/pricing/priceCache';
import { PriceHistory } from '../src/pricing/priceHistory';
import { PricingEngine, type PricingRun, type SearchResult } from '../src/pricing/pricingEngine';
import { changeText, receiptFor, sourceWords } from '../src/pricing/receipt';
import { scorecard, scorecardText } from '../src/pricing/scorecard';
import { compareSizes, parseSize, parseUnitPrice, unitPriceOf } from '../src/pricing/sizes';
import { tripSavings } from '../src/pricing/trips';
import { addAgain, AppStore } from '../src/state/appStore';
import { draftFromLink, guessName, storeFromDraft } from '../src/state/customStores';

const p = (id: string, name: string, price: number | null, extra: Partial<Product> = {}): Product => ({ retailer: 'x', storeId: '', id, name, price, ...extra });
const done = (...products: Product[]): ItemResult => ({ status: 'done', products });
const list = (...names: string[]): GroceryList => ({
  id: 'L', name: 'Test', trip: null, createdAt: 0, updatedAt: 0,
  items: names.map((name, i) => ({ id: `i${i}`, name, qty: 1, checked: false })),
});

let passed = 0;
const t = async (name: string, fn: () => unknown) => { await fn(); passed++; console.log('ok -', name); };

(async () => {
  // --- Matching ------------------------------------------------------------------------------------------
  await t('matching: a result must name the item, the thing itself, not just a word of it', () => {
    assert.equal(isMatch('Dark Green Dog Leg Warmers', 'avocado'), false, 'the App Store review');
    assert.equal(isMatch('Fresh Hass Avocados, Each', 'avocado'), true);
    assert.equal(isMatch('Nathan’s Famous Skinless Beef Hot Dogs', 'Hot dog buns'), false, 'buns are the thing');
    assert.equal(isMatch('Wonder Classic Hot Dog Buns, 8 Count', 'Hot dog buns'), true);
    assert.equal(isMatch('Pepperidge Farm Hot Dog Rolls', 'Hot dog buns'), true, 'rolls are buns');
    assert.equal(isMatch('Ball Park Beef Franks', 'Hot dogs'), true, 'franks are hot dogs');
    assert.equal(isMatch('Oscar Mayer Classic Wieners', 'hot dogs'), true);
    assert.equal(isMatch('Great Value Whole Vitamin D Milk, 1 gal', 'Whole milk'), true);
    assert.equal(isMatch('Planters Trail Mix', 'Pancake mix'), false);
    assert.equal(isMatch('Driscoll’s Blueberries, 1 pint', 'Blueberries'), true, 'plurals');
    assert.equal(isMatch('Fresh Eggplant', 'Eggs'), false, 'a word isn’t the start of another');
    assert.equal(isMatch('Heinz Tomato Ketchup', 'catsup'), true);
  });

  await t('matching: plainly not groceries, or pet food, unless that’s what was asked for', () => {
    assert.equal(isMatch('Artificial Lettuce Plant, 12 in', 'lettuce'), false);
    assert.equal(isMatch('Iceberg Lettuce', 'lettuce'), true);
    assert.equal(isMatch('Purina Cat Chow Chicken', 'chicken'), false);
    assert.equal(isMatch('Rotisserie Chicken', 'chicken'), true);
    assert.equal(isMatch('Milk-Bone Dog Treats', 'dog treats'), true);
    assert.equal(isMatch('Avocado Plush Toy', 'avocado toy'), true);
    assert.equal(isMatch('PET Evaporated Milk', 'evaporated milk'), true, 'PET is a milk brand');
  });

  await t('matching: a query without usable words matches anything', () => {
    assert.deepEqual(queryWords('2% of the tp'), []);
    assert.equal(isMatch('Anything', '2%'), true);
  });

  // --- Sizes and unit prices -------------------------------------------------------------------------------
  await t('sizes: read from names, packs multiplied, counts kept apart from weights', () => {
    const size = (name: string) => {
      const s = parseSize(name);
      return s && [Math.round(s.amount * 100) / 100, s.unit, s.text];
    };
    assert.deepEqual(size('Great Value Whole Milk, 1 Gallon, 128 Fl Oz'), [128, 'floz', '1 gal']);
    assert.deepEqual(size('Horizon Organic Whole Milk, Half Gallon'), [64, 'floz', '½ gal']);
    assert.deepEqual(size('Coca-Cola Soda Pop, 12 fl oz, 12 Pack Cans'), [144, 'floz', '12 × 12 fl oz']);
    assert.deepEqual(size('Chobani Greek Yogurt, 4 x 5.3 oz'), [21.2, 'oz', '4 × 5.3 oz']);
    assert.deepEqual(size('Ball Park Hot Dog Buns, 8 Count, 12 oz'), [12, 'oz', '12 oz'], 'a count isn’t a multiplier');
    assert.deepEqual(size('Kroger Grade A Large Eggs, 18 ct'), [18, 'ct', '18 ct']);
    assert.deepEqual(size('Large Brown Eggs, 1 Dozen'), [12, 'ct', '12 ct']);
    assert.deepEqual(size('Fresh Strawberries, 2 lb'), [32, 'oz', '2 lb']);
    assert.deepEqual(size('Pepsi, 2 L'), [67.63, 'floz', '2 L']);
    assert.deepEqual(size('Bounty Paper Towels, 6 Double Rolls'), [6, 'ct', '6 ct']);
    assert.equal(parseSize('Bananas'), null);
    assert.equal(parseSize('Great Value 2% Reduced Fat Milk'), null);
  });

  await t('unit prices: the store’s own wins; else worked out; formats in cents under a dime', () => {
    assert.deepEqual(parseUnitPrice('27.2 ¢/oz'), { value: 0.272, unit: 'oz' });
    assert.deepEqual(parseUnitPrice('($4.80/pound)'), { value: 0.3, unit: 'oz' });
    assert.deepEqual(parseUnitPrice('$3.84/gal'), { value: 0.03, unit: 'floz' });
    assert.deepEqual(parseUnitPrice('$0.50 each'), { value: 0.5, unit: 'ct' });
    assert.equal(parseUnitPrice('see store'), null);
    const given = unitPriceOf(p('1', 'Milk, 1 gal', 3.48, { unitPriceText: '2.7 ¢/fl oz' }))!;
    assert.deepEqual([given.text, given.estimated], ['2.7¢/fl oz', false]);
    const worked = unitPriceOf(p('2', 'Doritos Nacho Cheese, 9.25 oz', 4.28))!;
    assert.deepEqual([worked.text, worked.estimated], ['$0.46/oz', true]);
    assert.equal(unitPriceOf(p('3', 'Hass Avocado, 1 each', 1.25)), null, 'one of something is its price');
    assert.equal(unitPriceOf(p('4', 'Eggs, 12 ct', 3.24))!.text, '$0.27 each');
  });

  await t('sizes compared across stores: a much bigger pack is called out; the lowest per unit is marked', () => {
    const notes = compareSizes([
      { retailerId: 'walmart', product: p('w', 'Great Value Whole Milk, 1 gal', 3.48) },
      { retailerId: 'costco', product: p('c', 'Kirkland Signature Whole Milk, 2 x 1 gal', 6.59) },
      { retailerId: 'target', product: p('t', 'Good & Gather Whole Milk, 0.5 gal', 2.49) },
    ]);
    assert.deepEqual(notes.costco.bigger, { times: 4, than: 'target' });
    assert.deepEqual(notes.target.smaller, { times: 0.3, than: 'costco' });
    assert.deepEqual(notes.walmart.bigger, { times: 2, than: 'target' }, 'a gallon is twice a half gallon');
    assert.deepEqual([notes.costco.cheapestPerUnit, notes.walmart.cheapestPerUnit], [true, false]);
  });

  // --- Lists ---------------------------------------------------------------------------------------------
  await t('pasted lists: one item per line; bullets, checkboxes and numbering dropped; quantities read', () => {
    const items = parseListText('Groceries:\n- Milk\n• 2 x eggs\n[ ] Bread ×2\n☐ butter (3)\n1. coffee\n\n- milk\n  ');
    assert.deepEqual(items, [
      { name: 'Groceries', qty: 1 },
      { name: 'Milk', qty: 2 },
      { name: 'eggs', qty: 2 },
      { name: 'Bread', qty: 2 },
      { name: 'butter', qty: 3 },
      { name: 'coffee', qty: 1 },
    ]);
  });

  await t('lists: shared as text, with Stretch’s pick', () => {
    const l = list('Milk', 'Eggs');
    l.items[1].qty = 2;
    assert.equal(listText(l, { store: 'Walmart', total: '$6.20', found: 2 }), 'Test\n• Milk\n• Eggs ×2\n\nStretch’s pick: Walmart, $6.20 for all 2 items');
  });

  await t('app store: pasting adds what isn’t there; a list duplicates unchecked; usuals can be forgotten', () => {
    const a = new AppStore();
    const id = a.createList('Week', []);
    a.addItem(id, 'Milk');
    assert.equal(a.addItems(id, parseListText('milk\nEggs\n2x Bread')), 2);
    const week = a.getState().lists.find((l) => l.id === id)!;
    assert.deepEqual(week.items.map((i) => [i.name, i.qty]), [['Milk', 1], ['Eggs', 1], ['Bread', 2]]);
    a.toggleChecked(id, week.items[0].id);
    const copyId = a.duplicateList(id);
    const copy = a.getState().lists.find((l) => l.id === copyId)!;
    assert.deepEqual([copy.name, copy.items.map((i) => [i.name, i.qty, i.checked])], ['Week (copy)', [['Milk', 1, false], ['Eggs', 1, false], ['Bread', 2, false]]]);
    a.setUsual('Milk', 'target', 't1');
    a.setUsual('milk ', 'walmart', 'w1');
    assert.deepEqual(a.getState().usuals, { milk: { target: 't1', walmart: 'w1' } });
    a.forgetUsual('Milk', 'target');
    a.forgetUsual('Milk', 'walmart');
    assert.deepEqual(a.getState().usuals, {});
  });

  // --- Add a store ---------------------------------------------------------------------------------------
  await t('add a store: the search in a pasted link becomes the template, wherever the site puts it', () => {
    const q = draftFromLink('https://www.foodlion.com/search?search_term=whole+milk&sort=relevance');
    assert.ok(q.ok);
    assert.deepEqual([q.draft.searchUrl, q.draft.word, q.draft.homeUrl, q.draft.name], [
      'https://www.foodlion.com/search?search_term={{query}}&sort=relevance',
      'whole milk',
      'https://www.foodlion.com/',
      'Foodlion',
    ]);
    const path = draftFromLink('samsclub.com/s/milk');
    assert.ok(path.ok);
    assert.equal(path.draft.searchUrl, 'https://samsclub.com/s/{{query}}');
    const told = draftFromLink('https://www.hy-vee.com/aisles-online/p/milk-results', 'milk');
    assert.ok(told.ok);
    assert.deepEqual([told.draft.searchUrl, told.draft.name], ['https://www.hy-vee.com/aisles-online/p/{{query}}-results', 'Hy-Vee']);
    const repeats = draftFromLink('https://shop.example.com/search?q=eggs&originalQuery=eggs');
    assert.ok(repeats.ok);
    assert.equal(repeats.draft.searchUrl, 'https://shop.example.com/search?q={{query}}&originalQuery={{query}}');
  });

  await t('add a store: links that don’t say what they searched ask for it; bad links are explained', () => {
    const unsure = draftFromLink('https://www.giantfood.com/product-search/results');
    assert.equal(unsure.ok, false);
    assert.match(!unsure.ok ? unsure.message : '', /Type what you searched for/);
    assert.equal(draftFromLink('not a link').ok, false);
    assert.equal(draftFromLink('https://www.giantfood.com/search?q=milk', 'bread').ok, false);
    assert.equal(guessName('shop.wegmans.com'), 'Wegmans');
  });

  await t('add a store: the store gets its own id and the general reader, and survives validation', () => {
    const q = draftFromLink('https://www.foodlion.com/search?q=milk');
    assert.ok(q.ok);
    const cfg = storeFromDraft(q.draft, 'Food Lion', ['custom-food-lion']);
    assert.deepEqual([cfg.id, cfg.name, cfg.parser, cfg.strategies, cfg.addedByUser, cfg.pageScript], ['custom-food-lion-2', 'Food Lion', 'autoDetect', ['webview'], true, undefined]);
    assert.equal(isRetailerConfig(cfg), true);
    const a = new AppStore();
    a.addCustomRetailer(cfg);
    assert.deepEqual([a.getState().settings.customRetailers.length, a.getState().settings.retailerIds.includes(cfg.id)], [1, true]);
    a.storePicked(cfg.id);
    a.removeCustomRetailer(cfg.id);
    const s = a.getState().settings;
    assert.deepEqual([s.customRetailers, s.retailerIds.includes(cfg.id), cfg.id in s.storePickedAt], [[], false, false]);
  });

  // --- Price history -----------------------------------------------------------------------------------
  await t('price history: a steady price is one point; a change says by how much since when; it saves and loads', () => {
    let clock = 1_000_000;
    const h = new PriceHistory(() => clock);
    h.record('walmart', 'k', [p('m', 'Milk', 3.78), p('free', 'Bag', 0)], clock);
    clock += 3_600_000;
    h.record('walmart', 'k', [p('m', 'Milk', 3.78)], clock);
    assert.deepEqual(h.points('walmart', 'k', 'm'), [{ price: 3.78, at: 1_000_000, seen: 4_600_000 }]);
    assert.equal(h.change('walmart', 'k', 'm'), null);
    clock += 3_600_000;
    h.record('walmart', 'k', [p('m', 'Milk', 3.48)], clock);
    const change = h.change('walmart', 'k', 'm')!;
    assert.deepEqual(change, { delta: -0.3, from: 3.78, to: 3.48, since: 4_600_000 });
    assert.equal(changeText(change, clock), '↓ $0.30 vs 1 h ago');
    assert.equal(h.points('walmart', 'other-store', 'm').length, 0, 'each store keeps its own');
    h.record('walmart', 'k', [p('m', 'Milk', 9.99)], 2_000_000);
    assert.equal(h.points('walmart', 'k', 'm').length, 2, 'a price older than the latest known is ignored');
    clock += 5000;
    assert.equal(h.change('walmart', 'k', 'm', 1000), null, 'not news any more');
    const again = new PriceHistory(() => clock);
    again.hydrate(h.serialize());
    assert.equal(again.points('walmart', 'k', 'm').length, 2);
  });

  await t('price history: the engine hands every fresh search to it', async () => {
    const search = async () => ({ retailer: 'S', products: [p('m', 'Milk', 2)], strategy: 'webview' as const, ms: 1, attempts: [] });
    const engine = new PricingEngine(search, new PriceCache());
    const h = new PriceHistory();
    engine.onSearched((r, k, products, at) => h.record(r, k, products, at));
    engine.start('L', ['milk'], [{ config: { ...isStore('s1') }, storeId: '', storeKey: 'k' }]);
    for (let i = 0; i < 100 && !engine.getRun('L')?.finishedAt; i++) await new Promise((r) => setTimeout(r, 2));
    assert.equal(h.points('s1', 'k', 'm')[0].price, 2);
    assert.deepEqual([engine.getRun('L')!.results.s1.milk.found, engine.getRun('L')!.results.s1.milk.source], [1, undefined]);
  });

  // --- Scorecard, receipts, savings -------------------------------------------------------------------------
  const result = (r: Partial<SearchResult>): SearchResult => ({ status: 'done', query: 'q', products: [p('x', 'X', 1)], ...r });
  const run: PricingRun = {
    listId: 'L',
    retailerIds: ['a', 'b', 'c'],
    startedAt: 1000,
    finishedAt: 9000,
    stores: {
      a: { retailerId: 'a', name: 'Alpha', status: 'done', total: 3, settled: 3, failed: 0, searching: [], startedAt: 1000, finishedAt: 5000 },
      b: { retailerId: 'b', name: 'Beta', status: 'done', total: 3, settled: 3, failed: 2, searching: [], startedAt: 1000, finishedAt: 9000 },
      c: { retailerId: 'c', name: 'Gamma', status: 'done', total: 1, settled: 1, failed: 0, searching: [] },
    },
    results: {
      a: {
        milk: result({ strategy: 'webview', via: 'page', at: 2500, ms: 1500, found: 24 }),
        eggs: result({ strategy: 'webview', via: 'replay', at: 3000, ms: 400, found: 20 }),
        bread: result({ strategy: 'webview', via: 'replay', at: 3200, ms: 600, found: 18 }),
      },
      b: {
        milk: result({ strategy: 'api', at: 1800, ms: 800, found: 10 }),
        eggs: { status: 'failed', query: 'eggs', products: [], reason: 'timeout', outcome: 'failed' },
        bread: result({ stale: true, reason: 'no_payload', outcome: 'failed', at: 100, cached: true }),
      },
      c: { milk: result({ cached: true, at: 500 }) },
    },
  };

  await t('scorecard: what this run searched, how, and how fast; prices saved from earlier counted apart', () => {
    const card = scorecard(run);
    assert.deepEqual([card.searches, card.ok, card.failed, card.products, card.storesSearched, card.totalMs, card.firstMs], [6, 4, 2, 72, 2, 8000, 800]);
    const [a, b, c] = card.stores;
    assert.deepEqual([a.ok, a.pageLoads, a.reused, a.medianMs, a.firstMs, a.totalMs], [3, 1, 2, 600, 1500, 4000]);
    assert.deepEqual([b.ok, b.failed, b.api], [1, 2, 1]);
    assert.deepEqual([c.searches, c.saved], [0, 1]);
    assert.match(scorecardText(card, 'Test'), /Alpha: 3\/3 in 4\.0 s · median 0\.6 s · 1 page load, 2 reused page/);
  });

  await t('receipts: when and how each price was read, in words', () => {
    const now = 3000 + 3 * 60_000;
    const r = receiptFor(run.results.a.eggs, 'Alpha', 'www.alpha.com', now)!;
    assert.deepEqual([r.when, r.short, r.saved], ['Read 3 min ago', 'reused its page', false]);
    assert.match(r.how, /Alpha’s own search request again from its page/);
    assert.equal(receiptFor(run.results.b.milk, 'Beta', 'beta.com', now)!.short, 'official API');
    assert.equal(receiptFor(run.results.c.milk, 'Gamma', 'gamma.com', now)!.when, 'Saved from 3 min ago');
    assert.equal(receiptFor(undefined, 'X', 'x.com', now), null);
    assert.equal(sourceWords('response https://redsky.target.com/redsky_aggregations/v1/plp_search_v2 (24)'), 'a response the page got from redsky.target.com/redsky_aggregations/v1/plp_search_v2');
    assert.deepEqual([sourceWords('next-data (40)'), sourceWords('ld+json (3)'), sourceWords('Kroger Products API (20)')], [
      'the search page’s own data', 'the search page’s structured data', 'Kroger Products API',
    ]);
  });

  await t('savings: against the cheapest other finished store with everything the trip buys', () => {
    const l = list('Milk', 'Eggs');
    const cheap = basketFor(l, 'cheap', { milk: done(p('1', 'Milk', 3)), eggs: done(p('2', 'Eggs', 2)) });
    const mid = basketFor(l, 'mid', { milk: done(p('1', 'Milk', 3.5)), eggs: done(p('2', 'Eggs', 2.5)) });
    const pricey = basketFor(l, 'pricey', { milk: done(p('1', 'Milk', 4)), eggs: done(p('2', 'Eggs', 3)) });
    const partial = basketFor(l, 'partial', { milk: done(p('1', 'Milk', 1)), eggs: done() });
    assert.deepEqual(tripSavings(cheap, ['cheap'], [cheap, mid, pricey, partial]), { retailerId: 'mid', amount: 1 });
    assert.equal(tripSavings(pricey, ['pricey'], [cheap, pricey]), null, 'nothing saved');
    assert.equal(tripSavings(cheap, ['cheap'], [cheap, partial]), null, 'no store had it all');
    // A split trip: against all of it at one store, one of its own two included, as its card says.
    const a = basketFor(l, 'a', { milk: done(p('1', 'Milk', 3)), eggs: done(p('2', 'Eggs', 5)) });
    const b = basketFor(l, 'b', { milk: done(p('1', 'Milk', 5)), eggs: done(p('2', 'Eggs', 2)) });
    const split = bestSplit([a, b])!;
    assert.deepEqual([split.total, split.savings], [5, 2]);
    assert.deepEqual(tripSavings(split, ['a', 'b'], [a, b]), { retailerId: 'b', amount: 2 });
  });

  await t('add again: finished trips first, then other lists, without what’s already on this list', () => {
    const state = {
      lists: [
        { ...list('Milk'), id: 'this' },
        { ...list('Eggs', 'Bread'), id: 'other' },
      ],
      trips: [
        { id: 't', listId: 'x', listName: 'X', retailerIds: ['a'], total: 1, saved: null, items: ['Bananas', 'Milk', 'Bread'], startedAt: 0, endedAt: 1 },
      ],
    };
    assert.deepEqual(addAgain(state, 'this'), ['Bread', 'Bananas', 'Eggs']);
  });

  console.log(`\n${passed} feature tests passed`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });

function isStore(id: string) {
  return {
    id, name: id.toUpperCase(), enabled: true, searchUrl: 'https://x.com/s?q={{query}}', homeUrl: 'https://x.com/', cookieTemplate: '',
    strategies: ['webview' as const], parser: 'autoDetect', challengeMarkers: [], timeoutMs: 1000, storeHint: '', note: '',
  };
}
