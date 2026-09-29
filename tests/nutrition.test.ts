/// <reference types="node" />
import assert from 'node:assert/strict';
import {
  amountOf,
  amountText,
  amountWords,
  createNutritionLookup,
  nutrientInfo,
  nutritionFromData,
  nutritionFromOpenFoodFacts,
  nutritionFromSchemaOrg,
  openFoodFactsCode,
  type FetchLike,
} from '../src/onDevice/nutrition';
import { parseProductPage } from '../src/onDevice/productPage';

let passed = 0;
const t = async (name: string, fn: () => unknown) => { await fn(); passed++; console.log('ok -', name); };

// Open Food Facts' answer for Great Value whole milk (0078742351865), as it came on 2026-09-29, trimmed.
const offMilk = {
  code: '0078742351865',
  status: 1,
  product: {
    serving_size: '1 portion (240 ml)',
    nutrition_data_per: '100ml',
    nutriments: {
      'energy-kcal_serving': 150, 'energy-kcal_100g': 62.5, fat_serving: 8, fat_100g: 3.33333333333333, 'saturated-fat_serving': 5,
      'trans-fat_serving': 0, cholesterol_serving: 0.035, sodium_serving: 0.125, carbohydrates_serving: 12, fiber_serving: 0,
      sugars_serving: 12, 'added-sugars_serving': 0, proteins_serving: 8, 'vitamin-d_serving': 2.5e-6, calcium_serving: 0.3,
      iron_serving: 0, potassium_serving: 0.37, salt_serving: 0.3, 'nova-group_serving': 1,
    },
  },
};

(async () => {
  await t('amounts: units, "less than", IU and % aren’t amounts', () => {
    const fat = nutrientInfo('totalFat');
    const sodium = nutrientInfo('sodium');
    const vitD = nutrientInfo('vitaminD');
    assert.deepEqual(amountOf('8 g', fat), { value: 8, unit: 'g' });
    assert.deepEqual(amountOf('8g', fat), { value: 8, unit: 'g' });
    assert.deepEqual(amountOf('<1g', fat), { value: 1, unit: 'g', less: true });
    assert.deepEqual(amountOf('0.14 g', sodium), { value: 140, unit: 'mg' }, 'grams of sodium become milligrams');
    assert.deepEqual(amountOf(140, sodium), { value: 140, unit: 'mg' }, 'a bare number is in the nutrient’s own unit');
    assert.deepEqual(amountOf(3, sodium, 'g'), { value: 3000, unit: 'mg' }, 'a separate unit counts');
    assert.deepEqual(amountOf('400 IU', vitD), { value: 10, unit: 'mcg' });
    assert.equal(amountOf('400 IU', sodium), undefined, 'only vitamin D is written in IU');
    assert.equal(amountOf('10%', fat), undefined, 'a % Daily Value isn’t an amount');
    assert.equal(amountOf('about a spoonful', fat), undefined);
    assert.equal(amountText({ value: 2.5, unit: 'mcg' }), '2.5mcg');
    assert.equal(amountText({ value: 12.4, unit: 'g' }), '12g');
    assert.equal(amountWords({ value: 1, unit: 'g', less: true }), 'less than 1 grams');
    assert.equal(amountWords({ value: 140, unit: 'mg' }), '140 milligrams');
  });

  await t('schema.org NutritionInformation, with % Daily Values worked out', () => {
    const n = nutritionFromSchemaOrg({
      '@type': 'NutritionInformation', calories: '150 calories', servingSize: '1 cup (240 mL)', fatContent: '8 g', saturatedFatContent: '5 g',
      sodiumContent: '125 mg', carbohydrateContent: '12 g', sugarContent: '12 g', proteinContent: '8 g',
    })!;
    assert.equal(n.calories, 150);
    assert.equal(n.servingSize, '1 cup (240 mL)');
    assert.deepEqual(n.nutrients.totalFat, { value: 8, unit: 'g', dv: 10 });
    assert.deepEqual(n.nutrients.saturatedFat, { value: 5, unit: 'g', dv: 25 });
    assert.deepEqual(n.nutrients.sodium, { value: 125, unit: 'mg', dv: 5 });
    assert.deepEqual(n.nutrients.protein, { value: 8, unit: 'g' }, 'no % for protein unless the page gives one');
    assert.equal(n.dvWorkedOut, true);
    assert.equal(nutritionFromSchemaOrg({ '@type': 'NutritionInformation', fatContent: '8 g' }), undefined, 'one nutrient isn’t a label');
    assert.equal(nutritionFromSchemaOrg('nope'), undefined);
  });

  await t('page data shaped like Walmart’s: named rows, children, serving values', () => {
    const n = nutritionFromData({
      usItemId: '10450114',
      nutritionFacts: {
        calorieInfo: { mainNutrient: { name: 'Calories', amount: '150' } },
        servingInfo: { values: [{ name: 'Servings Per Container', values: [{ value: '16' }] }, { name: 'Serving Size', values: [{ value: '1 cup' }] }] },
        keyNutrients: {
          values: [
            { mainNutrient: { name: 'Total Fat', amount: '8g', dvp: '10%' }, childNutrients: [{ name: 'Saturated Fat', amount: '5g', dvp: '25%' }, { name: 'Trans Fat', amount: '0g' }] },
            { mainNutrient: { name: 'Sodium', amount: '125mg', dvp: '5%' } },
            { mainNutrient: { name: 'Total Carbohydrate', amount: '12g', dvp: '4%' }, childNutrients: [{ name: 'Sugars', amount: '12g' }, { name: 'Includes 0g Added Sugars', amount: '0g', dvp: '0%' }] },
          ],
        },
        vitaminMinerals: { childNutrients: [{ name: 'Vitamin D', amount: '2.5mcg', dvp: '10%' }, { name: 'Calcium', amount: '300mg', dvp: '25%' }] },
      },
    })!;
    assert.equal(n.calories, 150);
    assert.deepEqual([n.servingSize, n.servingsPerContainer], ['1 cup', '16']);
    assert.deepEqual(n.nutrients.totalFat, { value: 8, unit: 'g', dv: 10 });
    assert.deepEqual(n.nutrients.transFat, { value: 0, unit: 'g' });
    assert.deepEqual(n.nutrients.totalSugars, { value: 12, unit: 'g' });
    assert.deepEqual(n.nutrients.addedSugars, { value: 0, unit: 'g', dv: 0 });
    assert.deepEqual(n.nutrients.vitaminD, { value: 2.5, unit: 'mcg', dv: 10 });
    assert.deepEqual(n.nutrients.calcium, { value: 300, unit: 'mg', dv: 25 });
    assert.equal(n.dvWorkedOut, false, 'every % came from the page');
  });

  await t('page data shaped like Target’s: quantity, separate units, percentage', () => {
    const n = nutritionFromData({
      tcin: '13276134',
      enrichment: {
        nutrition_facts: {
          value_prepared_list: [{
            serving_size: '1', serving_size_unit_of_measurement: 'cup', servings_per_container: '16',
            nutrients: [
              { name: 'Calories', quantity: 150, unit_of_measurement: '' },
              { name: 'Total Fat', quantity: 8, unit_of_measurement: 'g', percentage: 10 },
              { name: 'Cholesterol', quantity: 35, unit_of_measurement: 'mg', percentage: 12 },
              { name: 'Protein', quantity: 8, unit_of_measurement: 'g' },
              { name: 'Vitamin D', quantity: 100, unit_of_measurement: 'IU', percentage: 10 },
            ],
          }],
        },
      },
    })!;
    assert.equal(n.calories, 150);
    assert.deepEqual([n.servingSize, n.servingsPerContainer], ['1 cup', '16']);
    assert.deepEqual(n.nutrients.cholesterol, { value: 35, unit: 'mg', dv: 12 });
    assert.deepEqual(n.nutrients.vitaminD, { value: 2.5, unit: 'mcg', dv: 10 });
    assert.deepEqual(n.nutrients.protein, { value: 8, unit: 'g' });
  });

  await t('page data: plain fields; nothing outside a nutrition field', () => {
    const n = nutritionFromData({ id: '1', nutrition: { calories: 90, totalFat: '1.5 g', total_carbohydrate: '17g', protein: '3g', servingSize: '2 slices (43g)' } })!;
    assert.deepEqual([n.calories, n.servingSize, n.nutrients.totalFat?.value, n.nutrients.totalCarbohydrate?.value, n.nutrients.protein?.value], [90, '2 slices (43g)', 1.5, 17, 3]);
    assert.equal(nutritionFromData({ id: '1', calories: 90, calcium: '300mg', description: 'Good source of calcium' }), undefined, 'loose fields aren’t a label');
    assert.equal(nutritionFromData({ nutritionFacts: { calories: 'n/a' } }), undefined);
  });

  await t('Open Food Facts: per serving, grams turned into the label’s units', () => {
    const n = nutritionFromOpenFoodFacts(offMilk)!;
    assert.equal(n.calories, 150);
    assert.equal(n.servingSize, '1 portion (240 ml)');
    assert.equal(n.per100, undefined);
    assert.deepEqual(n.nutrients.cholesterol, { value: 35, unit: 'mg', dv: 12 });
    assert.deepEqual(n.nutrients.sodium, { value: 125, unit: 'mg', dv: 5 });
    assert.deepEqual(n.nutrients.vitaminD, { value: 2.5, unit: 'mcg', dv: 13 });
    assert.deepEqual(n.nutrients.calcium, { value: 300, unit: 'mg', dv: 23 });
    assert.deepEqual(n.nutrients.potassium, { value: 370, unit: 'mg', dv: 8 });
    assert.equal(n.dvWorkedOut, true);
  });

  await t('Open Food Facts: per 100 ml without servings, and no % of it', () => {
    const n = nutritionFromOpenFoodFacts({ status: 1, product: { nutrition_data_per: '100ml', nutriments: { 'energy-kcal_100g': 42, sugars_100g: 10.6, sodium_100g: 0.01 } } })!;
    assert.deepEqual([n.per100, n.servingSize, n.calories], ['ml', '100 ml', 42]);
    assert.deepEqual(n.nutrients.sodium, { value: 10, unit: 'mg' });
    assert.equal(n.dvWorkedOut, false);
    const kj = nutritionFromOpenFoodFacts({ status: 1, product: { nutriments: { energy_serving: 836.8, fat_serving: 1 } } })!;
    assert.equal(kj.calories, 200, 'kilojoules become calories');
    assert.equal(nutritionFromOpenFoodFacts({ status: 0, status_verbose: 'product not found' }), undefined);
    assert.equal(nutritionFromOpenFoodFacts({ status: 1, product: { nutriments: {} } }), undefined);
  });

  await t('Open Food Facts: barcodes as it files them', () => {
    assert.equal(openFoodFactsCode('078742351865'), '0078742351865', 'a UPC-A gets its leading zero');
    assert.equal(openFoodFactsCode('00078742351865'), '0078742351865', 'a GTIN-14');
    assert.equal(openFoodFactsCode('3017620422003'), '3017620422003');
    assert.equal(openFoodFactsCode('96385074'), '96385074');
    assert.equal(openFoodFactsCode('12345'), null);
  });

  await t('Open Food Facts lookup: once per barcode, misses kept, failures not, cleared by erase', async () => {
    const calls: string[] = [];
    let answer: () => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }> = async () => ({ ok: true, status: 200, json: async () => offMilk });
    const fake: FetchLike = (url, init) => {
      calls.push(url);
      assert.match(init?.headers?.['User-Agent'] ?? '', /Stretch/);
      return answer();
    };
    const off = createNutritionLookup(fake, 1000);
    const [a, b] = await Promise.all([off.lookup('078742351865'), off.lookup('0078742351865')]);
    assert.equal(a?.calories, 150);
    assert.equal(a, b, 'the same barcode written two ways is one request');
    assert.equal(calls.length, 1);
    assert.match(calls[0], /\/api\/v2\/product\/0078742351865\.json\?fields=/);
    await off.lookup('078742351865');
    assert.equal(calls.length, 1, 'kept');

    answer = async () => ({ ok: true, status: 200, json: async () => ({ status: 0 }) });
    assert.equal(await off.lookup('3017620422003'), null);
    await off.lookup('3017620422003');
    assert.equal(calls.length, 2, 'a barcode it doesn’t have is asked once');

    answer = async () => { throw new Error('offline'); };
    assert.equal(await off.lookup('96385074'), null);
    answer = async () => ({ ok: false, status: 503, json: async () => ({}) });
    assert.equal(await off.lookup('96385074'), null);
    assert.equal(calls.length, 4, 'failures are asked again');

    assert.equal(await off.lookup('12'), null);
    assert.equal(calls.length, 4, 'not a barcode: nothing sent');

    answer = async () => ({ ok: true, status: 200, json: async () => offMilk });
    off.clear();
    await off.lookup('078742351865');
    assert.equal(calls.length, 5, 'erased: asked again');

    // Erased while a lookup is under way: its answer isn't kept.
    let release: () => void = () => {};
    answer = () => new Promise((resolve) => { release = () => resolve({ ok: true, status: 200, json: async () => offMilk }); });
    off.clear();
    const inFlight = off.lookup('078742351865');
    off.clear();
    release();
    await inFlight;
    answer = async () => ({ ok: true, status: 200, json: async () => offMilk });
    await off.lookup('078742351865');
    assert.equal(calls.length, 7);
  });

  await t('product page: nutrition from the structured data, else the page’s own data, and counted', () => {
    const product = { retailer: 'walmart', storeId: '', id: '10450114', name: 'Great Value Whole Milk, 1 Gallon', price: 3.48 };
    const ld = {
      '@type': 'Product', name: 'Great Value Whole Milk, 1 Gallon', sku: '10450114',
      nutrition: { '@type': 'NutritionInformation', calories: '150 calories', fatContent: '8 g', proteinContent: '8 g' },
    };
    const fromLd = parseProductPage({ href: 'https://www.walmart.com/ip/10450114', sources: [{ label: 'ld+json', text: JSON.stringify(ld) }] }, product);
    assert.equal(fromLd.nutrition?.calories, 150);
    assert.equal(fromLd.count, 1);

    const data = { item: { usItemId: '10450114', nutritionFacts: { calorieInfo: { mainNutrient: { name: 'Calories', amount: '150' } } } } };
    const fromData = parseProductPage(
      { href: 'https://www.walmart.com/ip/10450114', sources: [{ label: 'ld+json', text: JSON.stringify({ ...ld, nutrition: undefined }) }, { label: 'response https://www.walmart.com/orchestra/pdp', text: JSON.stringify(data) }] },
      product,
    );
    assert.equal(fromData.nutrition?.calories, 150);

    // Another product's label, elsewhere in the page's data, isn't this one's.
    const other = { item: { usItemId: '10450114', name: 'Milk' }, related: [{ usItemId: '999', nutritionFacts: { calories: 400, totalFat: '20g' } }] };
    const none = parseProductPage({ href: 'https://www.walmart.com/ip/10450114', sources: [{ label: 'response x', text: JSON.stringify(other) }] }, product);
    assert.equal(none.nutrition, undefined);
  });

  console.log(`\n${passed} passed`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
