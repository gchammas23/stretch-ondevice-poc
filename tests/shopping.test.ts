/// <reference types="node" />
import assert from 'node:assert/strict';
import { ingredientName, onListAs, parseRecipe, recipeItems } from '../src/lists/recipe';
import { itemKey, listQueries, queryKey, searchText, type GroceryList, type ListItem } from '../src/lists/types';
import { krogerProductId, normalizeBarcode, sameBarcode, upcEtoA } from '../src/onDevice/barcode';
import type { Product } from '../src/onDevice/types';
import { basketFor, lineFor, rankBaskets, stretchPick, unmetPrefs, withUnitTotals, type ItemResult } from '../src/pricing/basket';
import { dealsFrom } from '../src/pricing/deals';
import { exactFrom, nameWords, sameProduct } from '../src/pricing/exact';
import { GROCERY_TERMS } from '../src/lists/groceryTerms';
import { barcodeIdentity, closestTo, priceCheckAnswers } from '../src/pricing/priceCheck';
import { productScore, searchScore, suggestProducts, suggestSearches } from '../src/pricing/suggest';
import { isStoreBrand, swapSavings, swapsFor } from '../src/pricing/swaps';
import { pricesOf, truthSample, truthSummary, verdictOf, type TruthCheck } from '../src/pricing/truth';
import { asMember, memberOffer, memberRun } from '../src/pricing/member';
import { storeChoices } from '../src/state/storeChoices';
import { BUNDLED_CONFIG } from '../src/onDevice/retailers';
import type { PricingRun, SearchResult } from '../src/pricing/pricingEngine';
import { AppStore } from '../src/state/appStore';

const p = (id: string, name: string, price: number | null, extra: Partial<Product> = {}): Product => ({ retailer: 'x', storeId: '', id, name, price, ...extra });
const done = (...products: Product[]): ItemResult => ({ status: 'done', products });
const item = (name: string, extra: Partial<ListItem> = {}): ListItem => ({ id: `i-${name}`, name, qty: 1, checked: false, ...extra });
const list = (...items: ListItem[]): GroceryList => ({ id: 'L', name: 'Test', trip: null, createdAt: 0, updatedAt: 0, items });

let passed = 0;
const t = async (name: string, fn: () => unknown) => { await fn(); passed++; console.log('ok -', name); };

(async () => {
  // --- Barcodes -----------------------------------------------------------------------------------------
  await t('barcodes: as phones scan them, as stores write them, and as Kroger ids them', () => {
    assert.equal(normalizeBarcode('0016000275287'), '016000275287', 'an EAN-13 with a leading zero is a UPC-A');
    assert.equal(normalizeBarcode(' 016000275287 '), '016000275287');
    assert.equal(normalizeBarcode('01234565'), '012345000065', 'UPC-E is expanded');
    assert.equal(upcEtoA('04252614'), '042100005264');
    assert.equal(normalizeBarcode('hello'), null);
    assert.equal(krogerProductId('011110417007'), '0001111041700');
    assert.ok(sameBarcode('0001111041700', '011110417007'), 'Kroger’s id against the UPC-A');
    assert.ok(sameBarcode('00016000275287', '016000275287'), 'GTIN-14 against UPC-A');
    assert.equal(sameBarcode('016000275287', '016000275294'), false);
  });

  // --- The same product ---------------------------------------------------------------------------------
  await t('same product: by barcode when both have one; else by name words and size', () => {
    const heinz = { name: 'Heinz Tomato Ketchup, 32 oz Bottle' };
    assert.deepEqual(nameWords(heinz.name), ['heinz', 'tomato', 'ketchup', 'bottle']);
    assert.equal(sameProduct(heinz, p('t', 'Heinz Tomato Ketchup - 32oz', 3.49)), 'name');
    assert.equal(sameProduct(heinz, p('t', 'Heinz Tomato Ketchup - 20oz', 2.49)), null, 'another size');
    assert.equal(sameProduct(heinz, p('t', 'Hunt’s Tomato Ketchup, 32 oz', 2.19)), null, 'another brand');
    assert.equal(sameProduct({ name: 'x', gtin: '013000006408' }, p('k', 'Anything', 1, { gtin: '0001300000640' })), 'barcode');
    assert.equal(sameProduct({ name: 'Heinz Ketchup 32 oz', gtin: '013000006408' }, p('k', 'Heinz Ketchup 32 oz', 1, { gtin: '0999' })), null, 'barcodes win');
  });

  await t('exact product: picked at every store from the name search or the barcode search; missing says so', () => {
    const ref = exactFrom(p('w1', 'Heinz Tomato Ketchup, 32 oz', 3.12, { gtin: '013000006408' }), 'walmart');
    const ketchup = item('Ketchup', { exact: ref });
    const target = lineFor(ketchup, 'target', done(p('t0', 'Good & Gather Ketchup, 24 oz', 1.99), p('t1', 'Heinz Tomato Ketchup - 32oz', 3.49)));
    assert.deepEqual([target.product?.id, target.exact], ['t1', 'name'], 'not the top result: the same product');
    const byCode = lineFor(ketchup, 'kroger', done(p('k0', 'Kroger Ketchup, 32 oz', 1.79)), undefined, done(p('k9', 'Heinz Ketchup', 3.29, { gtin: '0001300000640' })));
    assert.deepEqual([byCode.product?.id, byCode.exact], ['k9', 'barcode']);
    const itself = lineFor(ketchup, 'walmart', done(p('w0', 'Great Value Ketchup', 1.5), p('w1', 'Heinz Tomato Ketchup, 32 oz', 3.12)));
    assert.deepEqual([itself.product?.id, itself.exact], ['w1', 'itself']);
    const none = lineFor(ketchup, 'aldi', done(p('a0', 'Burman’s Ketchup, 38 oz', 1.49)));
    assert.deepEqual([none.status, none.exactMissing, none.alternatives.length], ['missing', true, 1]);
    assert.deepEqual(listQueries(list(ketchup, item('Milk'))), ['Ketchup', 'Milk', '013000006408'], 'its barcode is searched too');
  });

  // --- Preferences --------------------------------------------------------------------------------------
  await t('preferences: organic and a brand join the search; size steers the pick; misses are said', () => {
    const milk = item('Milk', { prefs: { organic: true, brand: 'Horizon', size: '1 gal' } });
    assert.equal(searchText(milk), 'organic Horizon Milk');
    assert.equal(searchText(item('Organic milk', { prefs: { organic: true } })), 'Organic milk', 'not said twice');
    assert.equal(itemKey(milk), 'organic horizon milk');
    const results = done(
      p('1', 'Horizon Organic Whole Milk, Half Gallon', 4.99),
      p('2', 'Great Value Organic Whole Milk, 1 gal', 5.48),
      p('3', 'Horizon Organic Whole Milk, 1 gal', 7.99),
    );
    assert.equal(lineFor(milk, 's', results).product?.id, '3', 'the one that meets all three');
    const closest = lineFor(item('Milk', { prefs: { size: '2 gal' } }), 's', results);
    assert.deepEqual([closest.product?.id, closest.prefMiss], ['1', ['2 gal']]);
    assert.deepEqual(unmetPrefs(p('x', 'Kroger 2% Milk, 1 gal', 3), { organic: true, brand: 'Horizon' }), ['organic', 'Horizon']);
  });

  // --- Ranking by unit price -----------------------------------------------------------------------------
  await t('rank by unit: each item counted in the smallest pack sold, at each store’s price per unit', () => {
    const l = list(item('Milk'), item('Eggs'));
    const walmart = basketFor(l, 'walmart', { milk: done(p('w', 'Whole Milk, 1 gal', 3.48)), eggs: done(p('we', 'Large Eggs, 12 ct', 3.24)) });
    const costco = basketFor(l, 'costco', { milk: done(p('c', 'Kirkland Whole Milk, 2 x 1 gal', 5.99)), eggs: done(p('ce', 'Kirkland Large Eggs, 24 ct', 5.49)) });
    const [w, c] = withUnitTotals([walmart, costco]);
    assert.deepEqual([w.total, c.total], [6.72, 11.48]);
    assert.deepEqual([w.unitTotal, c.unitTotal], [6.72, 5.74], 'Costco’s packs cost less per gallon and per egg');
    assert.equal(stretchPick([w, c])?.retailerId, 'walmart');
    assert.equal(stretchPick([w, c], 'unit')?.retailerId, 'costco');
    assert.deepEqual(rankBaskets([w, c], 'unit').map((b) => b.retailerId), ['costco', 'walmart']);
  });

  // --- Recipes -----------------------------------------------------------------------------------------
  await t('recipes: ingredient lines become things to buy', () => {
    const lines: [string, string | null][] = [
      ['2 ½ cups all-purpose flour, sifted', 'All-purpose flour'],
      ['1 (15 ounce) can black beans, rinsed and drained', 'Black beans'],
      ['3 large eggs, at room temperature', 'Eggs'],
      ['½ cup (1 stick) unsalted butter, melted', 'Unsalted butter'],
      ['Juice of 1 lemon', 'Lemon'],
      ['2 cups whole milk', 'Whole milk'],
      ['1 can diced tomatoes', 'Diced tomatoes'],
      ['a pinch of salt', 'Salt'],
      ['1 cup chopped walnuts (optional)', 'Walnuts'],
      ['3/4 cup packed brown sugar', 'Brown sugar'],
      ['2', null],
    ];
    for (const [line, want] of lines) assert.equal(ingredientName(line), want, line);
  });

  await t('recipes: read from a page’s schema.org Recipe, @graph and all; pantry lines kept as notes', () => {
    const ld = { '@context': 'https://schema.org', '@graph': [
      { '@type': 'WebPage', name: 'x' },
      { '@type': ['Recipe'], name: 'Fluffy Pancakes', recipeYield: ['4 servings'],
        recipeIngredient: ['1 ½ cups all-purpose flour', '3 ½ teaspoons baking powder', '1 teaspoon salt', '1 &frac14; cups milk', '1 egg', '1 egg'] },
    ] };
    const recipe = parseRecipe({ sources: [{ label: 'ld+json', text: JSON.stringify(ld) }] })!;
    assert.deepEqual([recipe.name, recipe.yields, recipe.ingredients[3]], ['Fluffy Pancakes', '4 servings', '1 ¼ cups milk']);
    const items = recipeItems(recipe);
    assert.deepEqual(items.map((i) => i.name), ['All-purpose flour', 'Baking powder', 'Salt', 'Milk', 'Egg'], 'repeats merged');
    assert.equal(items[0].note, '1 ½ cups all-purpose flour');
    assert.equal(parseRecipe({ sources: [{ label: 'ld+json', text: '{"@type":"Product"}' }] }), null);
    const list = [{ name: 'Eggs' }, { name: 'Butter' }, { name: 'Unsalted peanut butter' }, { name: 'Milk' }];
    assert.deepEqual(onListAs('Egg', list), { name: 'Eggs', same: true });
    assert.deepEqual(onListAs('Unsalted butter', list), { name: 'Butter', same: false }, 'a maybe: left unticked, not hidden');
    assert.deepEqual(onListAs('Fresh blueberries', [{ name: 'Blueberry' }]), { name: 'Blueberry', same: false });
    assert.equal(onListAs('Buttermilk', list), null, 'another word, not a longer one');
  });

  // --- Deals and the watchlist ------------------------------------------------------------------------------
  await t('deals: what’s on sale in recent prices at the current stores, biggest discount first, each once', () => {
    const now = 1_000_000_000;
    const rows: Parameters<typeof dealsFrom>[0] = [
      ['target|k|milk', { products: [p('m', 'Milk', 3, { wasPrice: 4 }), p('n', 'Oat milk', 4)], at: now - 1000, ms: 1 }],
      ['target|k|oat milk', { products: [p('m', 'Milk', 3.5, { wasPrice: 4 })], at: now - 5000, ms: 1 }],
      ['walmart|k|eggs', { products: [p('e', 'Eggs', 2, { wasPrice: 4 })], at: now - 1000, ms: 1 }],
      ['walmart|old-store|eggs', { products: [p('e2', 'Eggs', 1, { wasPrice: 9 })], at: now, ms: 1 }],
      ['aldi|k|butter', { products: [p('b', 'Butter', 1, { wasPrice: 2 })], at: now - 48 * 3600e3, ms: 1 }],
    ];
    const deals = dealsFrom(rows, { target: 'k', walmart: 'k', aldi: 'k' }, now, 24 * 3600e3);
    assert.deepEqual(deals.map((d) => [d.retailerId, d.product.id, d.product.price, d.query]), [
      ['walmart', 'e', 2, 'eggs'],
      ['target', 'm', 3, 'milk'],
    ]);
  });

  await t('watchlist: a lower price read at the same store is a drop; going back up clears it', () => {
    const a = new AppStore();
    a.watchProduct('target', 'k', p('m', 'Milk', 3.99), 1);
    assert.deepEqual(a.notePrices('walmart', 'k', [p('m', 'Milk', 1)], 2), [], 'another store');
    assert.deepEqual(a.notePrices('target', 'other', [p('m', 'Milk', 1)], 2), [], 'another of its stores');
    const dropped = a.notePrices('target', 'k', [p('m', 'Milk', 3.49)], 3);
    assert.deepEqual(dropped.map((w) => w.drop), [{ from: 3.99, to: 3.49, at: 3 }]);
    assert.equal(a.notePrices('target', 'k', [p('m', 'Milk', 3.49)], 4).length, 0, 'the same price is no news');
    a.notePrices('target', 'k', [p('m', 'Milk', 3.79)], 5);
    assert.deepEqual([a.getState().watch[0].lastPrice, a.getState().watch[0].drop], [3.79, undefined]);
    a.unwatch('target', 'm');
    assert.equal(a.getState().watch.length, 0);
  });

  await t('watchlist: a watched product follows its store when the store changes; its first price there starts it afresh', () => {
    const a = new AppStore();
    a.watchProduct('walmart', 'old', p('m', 'Milk', 3.99), 1);
    a.notePrices('walmart', 'old', [p('m', 'Milk', 3.49)], 2);
    assert.ok(a.getState().watch[0].drop, 'a drop at the old store');
    // Signed in, or another store chosen: searches now run under another store key.
    a.followStore('walmart', 'new');
    assert.deepEqual(a.notePrices('walmart', 'old', [p('m', 'Milk', 1)], 3), [], 'a late answer for the old store says nothing now');
    assert.deepEqual(a.notePrices('walmart', 'new', [p('m', 'Milk', 2.99)], 4), [], 'the new store’s price isn’t a drop from the old one’s');
    const w = a.getState().watch[0];
    assert.deepEqual([w.storeKey, w.addedPrice, w.lastPrice, w.drop, w.moved], ['new', 2.99, 2.99, undefined, undefined]);
    assert.deepEqual(a.notePrices('walmart', 'new', [p('m', 'Milk', 2.49)], 5).map((x) => x.drop), [{ from: 2.99, to: 2.49, at: 5 }], 'from then on, drops count');
  });

  await t('watchlist: at a store whose program the user belongs to, the member price is what’s watched and read again', () => {
    const a = new AppStore();
    a.setMember('kroger', true);
    const milk = (price: number, memberPrice: number) => p('m', 'Milk', price, { memberPrice, memberLabel: 'with Card' });
    // Watched from a screen, where the price shown is the member's.
    a.watchProduct('kroger', 'k', asMember(milk(3.99, 2.99)), 1);
    // Searches hand over the prices as read: the regular price, with the member price beside it.
    assert.deepEqual(a.notePrices('kroger', 'k', [milk(3.99, 2.99)], 2), [], 'the same member price is no news');
    assert.deepEqual([a.getState().watch[0].addedPrice, a.getState().watch[0].lastPrice], [2.99, 2.99], 'not “up” to the regular price');
    assert.deepEqual(a.notePrices('kroger', 'k', [milk(3.99, 2.49)], 3).map((w) => w.drop), [{ from: 2.99, to: 2.49, at: 3 }], 'a lower member price is a drop');
  });

  await t('app store: preferences, notes and exact products per item; recent price checks; erase everything', () => {
    const a = new AppStore();
    const id = a.createList('Week', [item('Milk')]);
    const itemId = a.getState().lists[0].items[0].id;
    a.setItemPrefs(id, itemId, { organic: true, brand: '  ', size: '1 gal' });
    assert.deepEqual(a.getState().lists[0].items[0].prefs, { organic: true, size: '1 gal' }, 'blank ones dropped');
    a.setItemPrefs(id, itemId, { organic: false, size: '' });
    assert.equal('prefs' in a.getState().lists[0].items[0], false);
    a.setItemNote(id, itemId, ' for the cake ');
    a.setExactAll(id, { [itemId]: { name: 'Horizon Milk', retailerId: 'target', productId: 't1' } });
    assert.deepEqual([a.getState().lists[0].items[0].note, a.getState().lists[0].items[0].exact?.productId], ['for the cake', 't1']);
    a.setExact(id, itemId, null);
    assert.equal('exact' in a.getState().lists[0].items[0], false);
    for (const q of ['milk', 'eggs', 'Milk ']) a.addRecentSearch(q);
    assert.deepEqual(a.getState().recentSearches, ['Milk', 'eggs']);
    a.setOnboarded(true);
    a.reset();
    assert.deepEqual([a.getState().lists.length, a.getState().settings.onboarded, a.getState().recentSearches], [2, false, []]);
  });

  // --- Price check ---------------------------------------------------------------------------------------
  await t('price check: a barcode is matched by barcode, then by the product’s name and size, else marked unsure', () => {
    const code = '016000275287';
    const cheerios = 'General Mills Cheerios Cereal, 18 oz';
    const r = (products: Product[], status: SearchResult['status'] = 'done'): SearchResult => ({ status, query: '', products });
    const run: PricingRun = {
      listId: 'q',
      retailerIds: ['walmart', 'aldi', 'target', 'meijer', 'publix'],
      startedAt: 0,
      stores: {},
      results: {
        walmart: { [queryKey(code)]: r([p('w9', cheerios, 4.48, { gtin: '0001600027528' })]) },
        aldi: { [queryKey(code)]: r([]), [queryKey(cheerios)]: r([p('a0', 'Millville Crispy Oats, 18 oz', 1.99), p('a1', 'General Mills Cheerios, 18 oz', 3.99)]) },
        target: { [queryKey(code)]: r([p('t0', 'Honey Nut Cheerios, 15.4 oz', 4.29)]), [queryKey(cheerios)]: r([]) },
        meijer: { [queryKey(code)]: r([]), [queryKey(cheerios)]: r([], 'searching') },
        publix: { [queryKey(code)]: r([], 'failed'), [queryKey(cheerios)]: r([]) },
      },
    };
    assert.equal(barcodeIdentity(run, code)?.name, cheerios, 'a store’s result with the same barcode names it');
    const stores = run.retailerIds.map((id) => ({ id, name: id }));
    const answers = priceCheckAnswers(run, stores, code, code);
    assert.deepEqual(
      answers.map((a) => [a.retailerId, a.status, a.product?.id, a.sure, a.query]),
      [
        ['walmart', 'found', 'w9', 'barcode', code],
        ['aldi', 'found', 'a1', 'name', cheerios],
        ['target', 'found', 't0', 'maybe', code],
        ['meijer', 'checking', undefined, undefined, undefined],
        ['publix', 'failed', undefined, undefined, undefined],
      ],
    );
    const words = priceCheckAnswers({ ...run, results: { walmart: { [queryKey('pancake mix')]: r([p('x', 'Trail Mix, 26 oz', 5), p('y', 'Pancake Mix, 32 oz', 2.64), p('z', 'Pancake Mix, 2 lb', 2.99)]) } } }, [{ id: 'walmart', name: 'Walmart' }], 'pancake mix', null);
    assert.deepEqual([words[0].product?.id, words[0].more.map((m) => m.id)], ['y', ['x', 'z']], 'the first that matches the words; the rest as more');
  });

  await t('price check: a product to find everywhere: same barcode, same name and size, else the closest thing', () => {
    const known = { name: 'Great Value Whole Milk, 1 gal', gtin: '078742351865' };
    const r = (products: Product[], status: SearchResult['status'] = 'done'): SearchResult => ({ status, query: '', products });
    const run: PricingRun = {
      listId: 'q',
      retailerIds: ['walmart', 'kroger', 'target', 'aldi'],
      startedAt: 0,
      stores: {},
      results: {
        walmart: { [queryKey(known.name)]: r([p('w1', 'Great Value Whole Milk, 1 gal', 3.48, { gtin: '0078742351865' })]) },
        kroger: { [queryKey(known.name)]: r([p('k1', 'Kroger Whole Milk, 1 gal', 3.29)]), [queryKey(known.gtin)]: r([]) },
        target: {
          [queryKey(known.name)]: r([p('t0', 'Good & Gather Whole Milk, 64 oz', 2.49), p('t1', 'Good & Gather Whole Milk, 1 gal', 3.69), p('t2', 'Milk Duds Candy, 5 oz', 1.99)]),
        },
        aldi: { [queryKey(known.name)]: r([], 'searching') },
      },
    };
    const answers = priceCheckAnswers(run, run.retailerIds.map((id) => ({ id, name: id })), known.name, known.gtin, known);
    assert.deepEqual(
      answers.map((a) => [a.retailerId, a.status, a.product?.id, a.sure]),
      [
        ['walmart', 'found', 'w1', 'barcode'],
        ['kroger', 'found', 'k1', 'maybe'],
        ['target', 'found', 't1', 'maybe'],
        ['aldi', 'checking', undefined, undefined],
      ],
      'Target: its own whole milk in the same size, not candy or a smaller carton',
    );
    assert.equal(closestTo({ name: 'Heinz Tomato Ketchup, 32 oz Bottle' }, [p('a', 'Hunt’s Tomato Ketchup, 38 oz', 2), p('b', 'Heinz Mustard, 14 oz', 1)])?.id, 'a', 'packaging isn’t the kind of thing');
    assert.equal(closestTo({ name: 'Oat Milk, 64 oz' }, [p('c', 'Oatmeal, 18 oz', 3)]), undefined, 'nothing of the kind');
  });

  // --- Suggestions ---------------------------------------------------------------------------------------------
  await t('suggestions: searches that start with what’s typed first, then yours, the stores’ and common kinds', () => {
    assert.ok(GROCERY_TERMS.length > 400 && new Set(GROCERY_TERMS).size === GROCERY_TERMS.length, 'many, each once');
    assert.ok(GROCERY_TERMS.every((term) => term === term.toLowerCase() && term.trim() === term));
    const sources = {
      recent: ['cheerios', 'Whole milk'],
      list: ['Milk', 'Maple syrup', 'Hot dog buns'],
      store: [{ text: 'milk 2% gallon', retailerId: 'walmart' }, { text: 'milk', retailerId: 'target' }],
      common: GROCERY_TERMS,
    };
    const texts = (typed: string) => suggestSearches(typed, sources).map((x) => x.text);
    assert.deepEqual(texts('mil').slice(0, 3), ['Milk', 'milk 2% gallon', 'Whole milk']);
    assert.deepEqual(suggestSearches('mil', sources)[0], { text: 'Milk', from: 'list', stores: ['target'] }, 'the user’s own words, and which store also suggested it');
    assert.ok(!texts('milk').includes('Milk'), 'not what’s typed itself');
    assert.deepEqual(texts('eggs').slice(0, 2), ['large eggs', 'organic eggs'], 'kinds of eggs, not eggplant');
    assert.ok(!texts('chees').includes('cheerios'), 'a word isn’t a longer one');
    assert.deepEqual(texts('hot d'), ['Hot dog buns', 'hot dogs', 'beef hot dogs']);
    assert.deepEqual(suggestSearches('  ', sources), []);
    const store = ['milk crate', 'milk frother', 'milk chocolate', 'whole milk'].map((text) => ({ text, retailerId: 'target' }));
    const ranked = suggestSearches('milk', { store, common: GROCERY_TERMS }, 8).map((x) => x.text);
    assert.equal(ranked[0], 'whole milk', 'the store’s milk first');
    assert.ok(!ranked.includes('milk crate') && !ranked.includes('milk frother'), 'what it sells beyond groceries goes below the rest');
    assert.equal(searchScore('mil', 'buttermilk'), null, 'words start with what’s typed');
    assert.ok(productScore('milk', 'Great Value Whole Milk, 1 gal')! > productScore('milk', 'Milk Duds Candy, 5 oz')!, 'milk, not candy with milk in its name');
  });

  await t('suggestions: products the stores showed lately, at their current store, best fit then cheapest, two per store', () => {
    const rows: Parameters<typeof suggestProducts>[1] = [
      ['walmart|k|milk', { at: 1000, ms: 1, products: [p('w1', 'Great Value Whole Milk, 1 gal', 3.48), p('w2', 'Great Value 2% Milk, 1 gal', 3.38), p('w3', 'Horizon Organic Whole Milk, 64 oz', 5.12)] }],
      ['target|t|milk', { at: 1000, ms: 1, products: [p('t1', 'Good & Gather Whole Milk, 1 gal', 3.69), p('t2', 'Milk Duds Candy, 5 oz', 1.99), p('t3', 'No price milk', null)] }],
      ['aldi|old-store|milk', { at: 1000, ms: 1, products: [p('a1', 'Friendly Farms Whole Milk, 1 gal', 2.99)] }],
      ['kroger|kr|milk', { at: 0, ms: 1, products: [p('k1', 'Kroger Whole Milk, 1 gal', 2.5)] }],
    ];
    const keys = { walmart: 'k', target: 't', aldi: 'a', kroger: 'kr' };
    const got = (typed: string) => suggestProducts(typed, rows, keys, 2000, 1500).map((x) => x.product.id);
    assert.deepEqual(got('whole mil'), ['w1', 't1', 'w3'], 'at the store set now, read lately, cheaper first');
    assert.deepEqual(got('milk'), ['w2', 'w1', 't1', 't2'], 'two per store at most; candy last');
    assert.deepEqual(got('bread'), []);
  });

  // --- Cheaper swaps ------------------------------------------------------------------------------------
  await t('swaps: a cheaper product of the same size at the same store, its own brand winning a tie; no extra searching', () => {
    const brands = ['Great Value', 'Kroger'];
    assert.deepEqual(
      [isStoreBrand('Great Value Whole Vitamin D Milk, 1 gal', brands), isStoreBrand('Kroger® 2% Reduced Fat Milk', brands), isStoreBrand('Horizon Organic Whole Milk', brands)],
      [true, true, false],
    );
    const horizon = p('h', 'Horizon Organic Whole Milk, 1 gal', 6.49);
    const results = {
      [itemKey(item('Milk'))]: done(
        horizon,
        p('gv', 'Great Value Whole Milk, 1 gal', 3.64),
        p('fl', 'Fairlife Whole Milk, 52 fl oz', 3.2),
        p('ad', 'Store Whole Milk, 1 gal', 2.5, { sponsored: true }),
        p('oos', 'Other Whole Milk, 1 gal', 2.6, { inStock: false }),
        p('dz', 'Prairie Farms Whole Milk, 1 gal', 3.64),
      ),
      [itemKey(item('Eggs'))]: done(p('e1', 'Eggland’s Best Large Eggs, 12 ct', 4.99), p('e2', 'Great Value Large Eggs, 12 ct', 4.89)),
      [itemKey(item('Bread'))]: done(p('b1', 'Sara Lee White Bread, 20 oz', 3.2), p('b2', 'Great Value White Bread, 20 oz', 1.42)),
    };
    const l = list(item('Milk', { qty: 2 }), item('Eggs'), item('Bread', { exact: { retailerId: 'walmart', productId: 'b1', name: 'Sara Lee White Bread, 20 oz' } }));
    const basket = basketFor(l, 'walmart', results);
    const productsOf = (line: { item: ListItem }) => results[itemKey(line.item)].products;
    const swaps = swapsFor(basket, productsOf, brands);
    assert.deepEqual(swaps.map((s) => [s.item.name, s.to.id, s.saves, s.storeBrand]), [['Milk', 'gv', 5.7, true]],
      'milk: the same gallon for less, twice (the half gallon, the ad and the out-of-stock one don’t count); eggs save only 10¢; bread is an exact product');
    assert.equal(swapSavings(swaps), 5.7);

    const organic = basketFor(list(item('Milk', { prefs: { organic: true } })), 'walmart', results);
    assert.deepEqual(swapsFor(organic, productsOf, brands), [], 'nothing cheaper is organic');
    const usual = basketFor(list(item('Milk')), 'walmart', results, { milk: { walmart: 'h' } });
    assert.deepEqual(swapsFor(usual, productsOf, brands), [], 'the user’s usual stays');
  });

  // --- Member prices -------------------------------------------------------------------------------------
  await t('member prices: counted only at stores whose program the user belongs to; shown beside the price elsewhere', () => {
    const card = p('m', 'Kroger 2% Milk, 1 gal', 3.99, { memberPrice: 2.99, memberLabel: 'with Card' });
    assert.deepEqual(asMember(card), { ...card, price: 2.99, wasPrice: 3.99, memberApplied: true });
    const plain = p('x', 'Jam', 3);
    assert.equal(asMember(plain), plain, 'no member price: the same product');
    assert.deepEqual([memberOffer(card), memberOffer(asMember(card)), memberOffer(null)], [2.99, undefined, undefined]);

    const run: PricingRun = {
      listId: 'L', retailerIds: ['kroger', 'target'], startedAt: 0, stores: {},
      results: { kroger: { milk: { status: 'done', query: 'Milk', products: [card] } }, target: { milk: { status: 'done', query: 'Milk', products: [card] } } },
    };
    const memberships = { kroger: true };
    const mine = memberRun(run, memberships);
    assert.deepEqual([mine.results.kroger.milk.products[0].price, mine.results.target.milk.products[0].price], [2.99, 3.99]);
    assert.equal(memberRun(run, {}), run, 'no programs: the same run');
    assert.equal(memberRun(run, memberships), mine, 'screens showing the same run share its member prices');
    // Another price lands: the results that didn't change keep their products, so screens showing them redo nothing.
    const next: PricingRun = { ...run, results: { ...run.results, kroger: { ...run.results.kroger, eggs: { status: 'done', query: 'Eggs', products: [] } } } };
    assert.equal(memberRun(next, memberships).results.kroger.milk.products[0], mine.results.kroger.milk.products[0]);
    const basket = basketFor(list(item('Milk')), 'kroger', mine.results.kroger);
    assert.deepEqual([basket.total, basket.onSale, basket.saleSavings], [2.99, 1, 1]);

    const rows: Parameters<typeof dealsFrom>[0] = [['kroger|k|milk', { products: [card], at: 1000, ms: 1 }]];
    assert.deepEqual([dealsFrom(rows, { kroger: 'k' }, 2000, 1e9).length, dealsFrom(rows, { kroger: 'k' }, 2000, 1e9, { kroger: true }).length], [0, 1], 'a member deal is a deal for members');
  });

  await t('member prices: signing in to a store’s site gives it a new store key, so its prices are read again', () => {
    const store = new AppStore();
    const key = () => storeChoices(store.getState().settings, BUNDLED_CONFIG.retailers).find((c) => c.config.id === 'target')!.storeKey;
    const before = key();
    store.noteSignedIn('target', 1234);
    assert.notEqual(key(), before);
    assert.match(key(), /~1234$/);
    store.setMember('target', true);
    assert.deepEqual(store.getState().settings.memberships, { target: true });
    store.setMember('target', false);
    assert.deepEqual(store.getState().settings.memberships, {});
    // Signed in again, but the store's page says nobody is: back to the sign-in before, and its store key.
    const signedIn = key();
    store.noteSignedIn('target', 5678);
    store.undoSignIn('target', 1234);
    assert.equal(key(), signedIn);
    store.undoSignIn('target', undefined);
    assert.deepEqual([key(), store.getState().settings.signedInAt], [before, {}]);
  });

  // --- Price truth check --------------------------------------------------------------------------------
  await t('truth check: a sample spread across the list, on the store’s own site; same to the cent, different, or no price', () => {
    const names = ['Milk', 'Eggs', 'Bread', 'Jam', 'Rice', 'Beans'];
    const results = Object.fromEntries(names.map((n, i) => [itemKey(item(n)), done(p(`p${i}`, `${n} ${i}`, 2 + i, { url: i === 1 ? 'https://elsewhere.com/x' : `https://www.store.com/p/${i}` }))]));
    const basket = basketFor(list(...names.map((n) => item(n))), 'store', results);
    const sample = truthSample([basket], 3, (_rid, url) => url.startsWith('https://www.store.com/'));
    assert.deepEqual(sample.map((s) => s.itemName), ['Milk', 'Bread', 'Rice'], 'three of the five on its site, spread out');
    assert.deepEqual(truthSample([basket], 10, () => true).length, 6);

    assert.deepEqual([verdictOf([3.49], 3.49), verdictOf([3.49], 3.5), verdictOf([3.49], undefined), verdictOf([], 3)], ['same', 'different', 'unreadable', 'unreadable']);
    const member = { ...p('k', 'Milk', 2.99, { memberPrice: 2.99, wasPrice: 3.99, memberApplied: true }) };
    assert.equal(verdictOf(pricesOf(member), 3.99), 'same', 'a member’s price: the page may show the regular one');
    const check = (retailerId: string, state: TruthCheck['state']): TruthCheck => ({ retailerId, itemName: 'x', product: p('x', 'x', 1), state });
    assert.deepEqual(truthSummary([check('a', 'same'), check('a', 'different'), check('b', 'same'), check('b', 'unreadable'), check('b', 'checking')]), {
      checked: 3, same: 2, different: 1, unreadable: 1, rate: 2 / 3, byStore: { a: { same: 1, checked: 2 }, b: { same: 1, checked: 1 } },
    });
  });

  console.log(`\n${passed} shopping tests passed`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
