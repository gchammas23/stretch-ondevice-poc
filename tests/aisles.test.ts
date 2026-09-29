/// <reference types="node" />
import assert from 'node:assert/strict';
import { aisleCode, aisleText, compareAisles, departmentOf, placeOf } from '../src/onDevice/aisle';
import { krogerProducts } from '../src/onDevice/krogerApi';
import { autoDetect, pageScriptProducts, profileSource, readWithProfile, walmartNextData } from '../src/onDevice/parsers';
import { parseProductPage } from '../src/onDevice/productPage';
import { isProfile } from '../src/onDevice/profiles';
import type { PageSource, ParserProfile, Product } from '../src/onDevice/types';
import { AisleBook, aisleSections, noteFromText, placeLabel, spotFor, type Spot } from '../src/pricing/aisles';

let passed = 0;
const t = async (name: string, fn: () => unknown) => { await fn(); passed++; console.log('ok -', name); };

(async () => {
  // --- Reading a place --------------------------------------------------------------------------------------------
  // The shapes are the stores' as Kroger's API reference and others' scrapers show them (2026-09): see aisle.ts.
  await t('places: each store’s shape reads as its aisle, or the area it names', () => {
    const cases: [string, unknown, unknown][] = [
      ['aisleLocations', [{ description: 'AISLE 13', number: '13', side: 'L', bayNumber: '2', shelfNumber: '2' }], { aisle: '13' }],
      ['productLocation', [{ displayValue: 'D34', aisle: { zone: 'D', aisle: 34 } }], { aisle: 'D34' }],
      ['productLocation', [{ aisle: { zone: 'D', aisle: 34 } }], { aisle: 'D34' }],
      ['productLocationDisplayValue', 'D34', { aisle: 'D34' }],
      ['store_positions', [{ aisle: 26, block: 'G' }], { aisle: 'G26' }],
      ['aisleLocation', 'Aisle 17', { aisle: '17' }],
      ['inStoreLocation', ['Aisle 3 - Pasta'], { aisle: '3' }],
      ['productLocation', { location: 'Aisle 5' }, { aisle: '5' }],
      ['planogram', { aisle: '14B', aisleSide: 'L', section: '11', shelf: '1' }, { aisle: '14B' }],
    ];
    for (const [key, value, want] of cases) assert.deepEqual(placeOf(value, key), want, key);
  });

  await t('places: a place that names an area is that area; its plain number is the area’s code, not an aisle', () => {
    assert.deepEqual(placeOf([{ description: 'DAIRY', number: '100' }], 'aisleLocations'), { department: 'Dairy' }, 'Kroger’s DAIRY is 100');
    assert.equal(placeOf([{ number: '100' }], 'aisleLocations'), undefined, 'three digits are a code');
    assert.deepEqual(placeOf('Dairy', 'aisleLocation'), { department: 'Dairy' });
    assert.deepEqual(placeOf({ location: 'In Produce' }, 'productLocation'), { department: 'Produce' });
    assert.deepEqual(placeOf({ aisle: 'Dairy' }, 'planogram'), { department: 'Dairy' }, 'Wegmans’ perishables');
    assert.equal(placeOf('Ask Associate', 'aisleLocation'), undefined);
    assert.equal(placeOf(null, 'productLocation'), undefined, 'Walmart’s items only shipped');
    assert.equal(placeOf([], 'aisleLocations'), undefined);
  });

  await t('places: of several, the first with an aisle; else the first area', () => {
    const two = [{ description: 'NATURES MARKET 3', number: '354' }, { description: 'AISLE 7', number: '7' }];
    assert.deepEqual(placeOf(two, 'aisleLocations'), { aisle: '7' });
    assert.deepEqual(placeOf([{ description: 'NATURES MARKET 3' }, { description: 'DAIRY' }], 'aisleLocations'), { department: 'Natures Market 3' });
  });

  await t('places: a category some stores call an aisle is neither an aisle nor an area', () => {
    assert.equal(placeOf('Milk & Cream|1_11_4', 'aisleName'), undefined, 'Albertsons’ aisleName');
    assert.equal(placeOf({ id: 123, name: 'Milk' }, 'aisle'), undefined, 'Instacart’s aisles');
    assert.equal(placeOf('fresh vegetables', 'aisle'), undefined, 'a plain "aisle" key names no area');
  });

  await t('aisles: written as signs have them; sizes, ranges, codes and long texts aren’t aisles', () => {
    assert.deepEqual(
      ['a-12', 'E 7', '07', 'Aisle: 12', 'aisle #4', 'Located in aisle G24', 'AISLE 13', 'Aisle 5, Bay 3'].map((s) => aisleText(s)),
      ['A12', 'E7', '7', '12', '4', 'G24', '13', '5'],
    );
    assert.deepEqual(
      ['aisles 5-7', '12 oz', '100', '0', '1_23_4', 'Milk', 'This aisle 12 is described in far more than forty letters'].map((s) => aisleText(s)),
      [undefined, undefined, undefined, undefined, undefined, undefined, undefined],
    );
    assert.deepEqual([aisleText(14), aisleText(0), aisleText(14.5), aisleText(100)], ['14', undefined, undefined, undefined]);
    assert.equal(aisleCode('b-015'), 'B15');
  });

  await t('departments: shouting lowered, "In" dropped; too wide, ids and links aren’t one', () => {
    assert.deepEqual(['DAIRY', 'MEAT & SEAFOOD', 'In the Bakery', ['Beverages'], { name: 'Frozen' }].map(departmentOf), ['Dairy', 'Meat & Seafood', 'Bakery', 'Beverages', 'Frozen']);
    assert.deepEqual(['Grocery', 'Food & Beverages', 'dairy_eggs', '/c/dairy', '12345', 'See an associate'].map(departmentOf), [undefined, undefined, undefined, undefined, undefined, undefined]);
  });

  await t('aisles sort as they’re numbered', () => {
    assert.deepEqual(['A12', '12', '2', 'B1', 'A2', '12B', '3'].sort(compareAisles), ['2', '3', '12', '12B', 'A2', 'A12', 'B1']);
  });

  // --- The readers --------------------------------------------------------------------------------------------------
  const albertsons = [
    { id: '1', name: 'Lucerne Whole Milk 1 Gal', price: 4.99, aisleLocation: 'Dairy', aisleName: 'Milk & Cream|1_11_4', aisleId: '1_11_4_5', departmentName: 'Dairy, Eggs & Cheese' },
    { id: '2', name: 'Signature Select 2% Milk 1 Gal', price: 3.99, aisleLocation: 'Aisle 17', aisleName: 'Milk & Cream|1_11_4', departmentName: 'Dairy, Eggs & Cheese' },
    { id: '3', name: 'O Organics Whole Milk Half Gallon', price: 6.49, aisleName: 'Milk & Cream|1_11_4', departmentName: 'Dairy, Eggs & Cheese' },
  ];
  const source: PageSource = { label: 'response https://www.safeway.com/abs/pub/xapi/pgmsearch/v1/search/products', text: JSON.stringify({ response: { docs: albertsons } }) };
  const where = (products: Product[]) => products.map((p) => [p.id, p.aisle, p.department]);
  const expected = [
    ['1', undefined, 'Dairy'],
    ['2', '17', 'Dairy, Eggs & Cheese'],
    ['3', undefined, 'Dairy, Eggs & Cheese'],
  ];

  await t('general reader: a product’s aisle, or the area its place names before a department field’s, and where they were', () => {
    const r = autoDetect({ sources: [source] }, { retailer: 'safeway', storeId: '3132', query: 'milk' });
    assert.deepEqual(where(r.products), expected);
    assert.deepEqual([r.read?.candidate?.fields.place, r.read?.candidate?.fields.department], [[['aisleLocation']], [['departmentName']]], 'for the store’s profile to learn');
  });

  await t('profiles: read the place where learned; a profile from before places were read finds them the general way', () => {
    const r = autoDetect({ sources: [source] }, { retailer: 'safeway', storeId: '3132', query: 'milk' });
    const learned: ParserProfile = { source: profileSource(source), list: r.read!.candidate!.list, fields: r.read!.candidate!.fields, usual: 3, learnedAt: 0, searches: 3, how: 'searches' };
    assert.ok(isProfile(learned), 'a rules file can carry it');
    assert.deepEqual(where(readWithProfile(learned, { sources: [source] }, { retailer: 'safeway', storeId: '3132', query: 'milk' }).products), expected);
    const { place, department, ...before } = learned.fields;
    assert.ok(place && department);
    const older: ParserProfile = { ...learned, fields: before };
    assert.deepEqual(where(readWithProfile(older, { sources: [source] }, { retailer: 'safeway', storeId: '3132', query: 'milk' }).products), expected);
    assert.equal(isProfile({ ...learned, fields: { ...learned.fields, place: 'aisleLocation' } }), false, 'ways are lists of paths');
  });

  await t('walmart: productLocation, for the store set; none for an item only shipped', () => {
    const item = (id: string, extra: Record<string, unknown>) => ({ usItemId: id, name: `Milk ${id}`, priceInfo: { currentPrice: { price: 3.12 } }, ...extra });
    const data = {
      props: {
        pageProps: {
          initialData: {
            searchResult: {
              itemStacks: [
                {
                  items: [
                    item('1', { productLocation: [{ displayValue: 'D34', aisle: { zone: 'D', aisle: 34 } }], productLocationDisplayValue: 'D34' }),
                    item('2', { productLocation: null, fulfillmentType: 'FC' }),
                  ],
                },
              ],
            },
          },
        },
      },
    };
    const r = walmartNextData({ nextDataText: JSON.stringify(data) }, { retailer: 'walmart', storeId: '3081' });
    assert.deepEqual(where(r.products), [['1', 'D34', undefined], ['2', undefined, undefined]]);
  });

  await t('page scripts: their aisle, or area, and department', () => {
    const r = pageScriptProducts({ pageResult: [{ id: '1', name: 'Eggs', price: 3, aisle: 'Aisle 9' }, { id: '2', name: 'Milk', price: 4, aisle: 'Dairy', department: 'Dairy & Eggs' }] }, { retailer: 'x', storeId: '' });
    assert.deepEqual(where(r.products), [['1', '9', undefined], ['2', undefined, 'Dairy']]);
  });

  await t('kroger: the first place with an aisle; a department’s place names it; else its first category', () => {
    const json = {
      data: [
        { productId: '1', description: 'Kroger Whole Milk', items: [{ price: { regular: 2.49 }, size: '1 gal' }], aisleLocations: [{ description: 'DAIRY', number: '100' }], categories: ['Dairy'] },
        {
          productId: '2',
          description: 'Cheerios',
          items: [{ price: { regular: 4.99 } }],
          aisleLocations: [{ description: 'NATURES MARKET 3', number: '354' }, { description: 'AISLE 13', number: '13', side: 'L' }],
          categories: ['Breakfast'],
        },
        { productId: '3', description: 'Organic Bananas', items: [{ price: { regular: 0.69 } }], aisleLocations: [], categories: ['Produce'] },
      ],
    };
    assert.deepEqual(where(krogerProducts(json, '01400943')), [['1', undefined, 'Dairy'], ['2', '13', 'Breakfast'], ['3', undefined, 'Produce']]);
  });

  await t('product pages: its place from the page’s data, looking past the data that describes it to the rest', () => {
    const product: Product = { retailer: 'target', storeId: '1340', id: '13202943', name: 'Good & Gather Milk', price: 3.49 };
    const described = { props: { pageProps: { product: { tcin: '13202943', title: 'Good & Gather Milk', description: 'Fresh whole milk from cows not treated with rBST.' } } } };
    const fulfillment = { data: { product: { tcin: '13202943', fulfillment: { store_options: [{ store_positions: [{ aisle: 26, block: 'G' }] }] } } } };
    const details = parseProductPage(
      { nextDataText: JSON.stringify(described), sources: [{ label: 'response https://redsky.target.com/pdp_fulfillment_v1', text: JSON.stringify(fulfillment) }] },
      product,
    );
    assert.deepEqual([details.aisle, details.description?.slice(0, 10)], ['G26', 'Fresh whol']);
    const area = parseProductPage({ sources: [{ label: 'response x', text: JSON.stringify({ product: { tcin: '13202943', productLocation: 'Dairy', department: 'Grocery' } }) }] }, product);
    assert.deepEqual([area.aisle, area.department], [undefined, 'Dairy']);
  });

  // --- The aisle book ---------------------------------------------------------------------------------------------------
  await t('aisle book: pages and notes by store and product; a note for the item too; a page doesn’t replace a note', () => {
    let now = 1_000;
    const book = new AisleBook(() => now);
    const milk = { storeId: '3081', id: 'm1' };
    book.notePage('walmart', milk, { aisle: 'D34' });
    assert.deepEqual(book.page('walmart', '3081', 'm1'), { aisle: 'D34', from: 'page', at: 1_000 });
    now = 2_000;
    book.noteYours('walmart', milk, 'Whole milk', { aisle: 'D36' });
    book.notePage('walmart', milk, { aisle: 'D34' });
    assert.deepEqual([book.yours('walmart', '3081', 'm1')?.aisle, book.page('walmart', '3081', 'm1')], ['D36', undefined], 'the note stays');
    assert.equal(book.yoursForItem('walmart', '3081', '  whole  MILK ')?.aisle, 'D36', 'the item, as searched');
    assert.deepEqual([book.yours('walmart', '9999', 'm1'), book.yours('target', '3081', 'm1')], [undefined, undefined], 'another store');
    assert.equal(book.notes, 1);
    book.noteYours('walmart', milk, 'Whole milk', null);
    assert.deepEqual([book.yours('walmart', '3081', 'm1'), book.yoursForItem('walmart', '3081', 'whole milk'), book.notes], [undefined, undefined, 0], 'forgotten, both');
  });

  await t('aisle book: Forget prices and history keeps the user’s notes; saved and read back; bad rows skipped', () => {
    const book = new AisleBook(() => 5);
    book.notePage('kroger', { storeId: '014', id: 'b1' }, { department: 'Bakery' });
    book.noteYours('kroger', { storeId: '014', id: 'e1' }, 'Eggs', { department: 'Dairy' });
    const copy = new AisleBook();
    copy.hydrate(book.serialize());
    assert.deepEqual([copy.page('kroger', '014', 'b1')?.department, copy.yours('kroger', '014', 'e1')?.department, copy.pages, copy.notes], ['Bakery', 'Dairy', 1, 1]);
    book.forgetPages();
    assert.deepEqual([book.page('kroger', '014', 'b1'), book.yours('kroger', '014', 'e1')?.department], [undefined, 'Dairy']);
    const odd = new AisleBook();
    odd.hydrate(JSON.stringify([['a', { from: 'you', at: 1 }], ['b', { from: 'x', at: 1, aisle: '3' }], 5, ['c', { from: 'page', at: 1, aisle: '4' }]]));
    assert.equal(odd.size, 1);
    odd.hydrate('not json');
    assert.equal(odd.size, 1);
  });

  await t('where to look: the user’s note, the store’s aisle, their note for the item, then the store’s area', () => {
    const book = new AisleBook(() => 1);
    const product: Product = { retailer: 'kroger', storeId: '014', id: 'p', name: 'Kroger 2% Milk', price: 2.29, aisle: '13', department: 'Dairy' };
    assert.deepEqual(spotFor(book, 'kroger', product, 'Milk'), { aisle: '13', department: 'Dairy', from: 'search' });
    assert.equal(spotFor(book, 'kroger', product, 'Milk', false), undefined, 'the prices were for another store');
    const bare: Product = { ...product, aisle: undefined, department: 'Beverages' };
    book.notePage('kroger', bare, { aisle: '14' });
    assert.deepEqual(spotFor(book, 'kroger', bare, 'Milk'), { aisle: '14', from: 'page' });
    book.noteYours('kroger', { storeId: '014', id: 'other' }, 'Milk', { department: 'Dairy' });
    assert.deepEqual(spotFor(book, 'kroger', product, 'Milk'), { aisle: '13', department: 'Dairy', from: 'search' }, 'its own aisle beats a note for another product');
    assert.deepEqual(spotFor(book, 'kroger', { ...bare, id: 'third' }, 'Milk'), { department: 'Dairy', from: 'you' }, 'a note for the item beats an area');
    assert.deepEqual(spotFor(book, 'kroger', { ...bare, id: 'third' }, 'Milk', false), { department: 'Dairy', from: 'you' }, 'notes count whatever the store');
    book.noteYours('kroger', product, 'Milk', { aisle: '15' });
    assert.deepEqual(spotFor(book, 'kroger', product, 'Milk'), { aisle: '15', from: 'you' });
  });

  await t('checklist: in the order of a walk through the store, list order kept in each', () => {
    const rows: [string, Spot | undefined, boolean][] = [
      ['peas', { department: 'Frozen', from: 'search' }, true],
      ['cereal', { aisle: '3', from: 'search' }, true],
      ['apples', { department: 'Produce', from: 'you' }, true],
      ['bread', { department: 'Bakery', from: 'page' }, true],
      ['soap', { department: 'Household', from: 'search' }, true],
      ['mystery', undefined, true],
      ['chicken', { department: 'Meat & seafood', from: 'you' }, true],
      ['gone', undefined, false],
      ['eggs', { department: 'Dairy', from: 'search' }, true],
      ['granola', { aisle: '3', from: 'you' }, true],
      ['pasta', { aisle: '12', from: 'search' }, true],
    ];
    const sections = aisleSections(rows, ([, spot, found]) => ({ spot, found }));
    assert.deepEqual(
      sections.map((s) => [s.title, s.rows.map(([name]) => name)]),
      [
        ['Produce', ['apples']],
        ['Bakery', ['bread']],
        ['Aisle 3', ['cereal', 'granola']],
        ['Aisle 12', ['pasta']],
        ['Household', ['soap']],
        ['Meat & seafood', ['chicken']],
        ['Dairy', ['eggs']],
        ['Frozen', ['peas']],
        ['Aisle not known yet', ['mystery']],
        ['Not found here', ['gone']],
      ],
    );
  });

  await t('notes typed: an aisle, or an area; a failed number isn’t an area', () => {
    assert.deepEqual(['12', 'aisle a-12', 'dairy', ' Frozen ', '123', '12 oz', ''].map(noteFromText), [
      { aisle: '12' },
      { aisle: 'A12' },
      { department: 'Dairy' },
      { department: 'Frozen' },
      undefined,
      undefined,
      undefined,
    ]);
    assert.deepEqual([placeLabel({ aisle: 'G26' }), placeLabel({ department: 'Dairy' })], ['Aisle G26', 'Dairy']);
  });

  console.log(`\n${passed} aisle tests passed`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
