/// <reference types="node" />
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import type { GroceryList, ListItem } from '../src/lists/types';
import { dateOf, dayOf, parseAd, parseDeal, rangeIn, type WeeklyAd } from '../src/onDevice/adPage';
import { couponValue, parseCoupons, quantityIn, type Coupon, type CouponList } from '../src/onDevice/couponPage';
import { storeHealth, type AttemptEntry } from '../src/onDevice/attemptLog';
import { citizenReport, Politeness, politeness } from '../src/onDevice/politeness';
import { createRetailerSearch, onRetailerSite } from '../src/onDevice/retailerSearch';
import { BUNDLED_CONFIG, isRetailerConfig, rulesProblem } from '../src/onDevice/retailers';
import type { Product, RetailerConfig } from '../src/onDevice/types';
import { WebViewPool } from '../src/onDevice/webviewPool';
import { WebViewQueue } from '../src/onDevice/webviewQueue';
import { captureScript, CLIP_BUTTONS, clipScript, DEFAULT_CHALLENGE_MARKERS, listPageScript, looksLikeSignIn } from '../src/onDevice/webviewScript';
import {
  AD_KEEP_MAX_MS,
  AD_READ_EVERY_MS,
  adDeals,
  adDue,
  adFor,
  adHits,
  adItemsFor,
  adLineWords,
  adPriceWords,
  adStatusWords,
  adTarget,
  runsWords,
  sameAsAd,
} from '../src/pricing/ads';
import { basketFor, stretchPick, type ItemResult } from '../src/pricing/basket';
import {
  COUPONS_READ_EVERY_MS,
  couponChip,
  couponCredit,
  couponCredits,
  couponFits,
  couponHits,
  couponSaves,
  couponsDue,
  couponsForItems,
  couponStateWords,
  couponStatusWords,
  couponsWords,
  couponTarget,
  couponTargets,
  withCoupons,
} from '../src/pricing/coupons';
import { ReadBook } from '../src/pricing/readBook';

// Search events are logged for telemetry; keep them out of the test output.
const log = console.log;
console.log = (...args: unknown[]) => {
  if (!String(args[0]).startsWith('[on-device-')) log(...args);
};

let passed = 0;
const t = async (name: string, fn: () => unknown) => { await fn(); passed++; log('ok -', name); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const nonceOf = (script: string) => /var NONCE = "([^"]+)"/.exec(script)![1];
const markers = DEFAULT_CHALLENGE_MARKERS;

/** A page in jsdom, whose posts to the app are collected. */
function makePage(html: string, url: string) {
  const dom = new JSDOM(html, { url, runScripts: 'outside-only' });
  const posts: any[] = [];
  const w = dom.window as any;
  w.ReactNativeWebView = { postMessage: (s: string) => posts.push(JSON.parse(s)) };
  const run = (script: string) => assert.equal(w.eval(script), true, 'script must evaluate to true');
  return { w, posts, run };
}

/** Noon on Sep 26, 2026, on the phone's calendar. */
const NOW = new Date(2026, 8, 26, 12).getTime();
const TODAY = dayOf(NOW);
const HOUR = 60 * 60_000;

const p = (id: string, name: string, price: number, extra: Partial<Product> = {}): Product => ({ retailer: 'x', storeId: '', id, name, price, ...extra });
const done = (...products: Product[]): ItemResult => ({ status: 'done', products });
const item = (name: string, qty = 1): ListItem => ({ id: `i-${name}`, name, qty, checked: false });
const list = (...items: ListItem[]): GroceryList => ({ id: 'L', name: 'Test', trip: null, createdAt: 0, updatedAt: 0, items });
const cfg = (over: Partial<RetailerConfig>): RetailerConfig => ({
  id: 'kroger', name: 'Kroger', enabled: true, searchUrl: 'https://www.kroger.com/search?query={{query}}', homeUrl: 'https://www.kroger.com/',
  cookieTemplate: '', strategies: ['webview'], parser: 'autoDetect', challengeMarkers: [], timeoutMs: 1000, storeHint: '', note: '', ...over,
});

/** A flyer's items, as a flyer service's data gives them to an ad page. */
const FLYER = [
  { id: 101, name: 'Oscar Mayer Classic Wieners', description: 'Select varieties, 16 oz', pre_price_text: '2/', price_text: '5.00', post_price_text: '', sale_story: 'SAVE UP TO $2', valid_from: '2026-09-24T00:00:00-04:00', valid_to: '2026-09-30T23:59:59-04:00', image_url: 'https://f.wishabi.net/1.jpg' },
  { id: 102, name: 'Boneless Skinless Chicken Breast', pre_price_text: '', price_text: '1.99', post_price_text: 'lb', valid_from: '2026-09-24T00:00:00-04:00', valid_to: '2026-09-30T23:59:59-04:00' },
  { id: 103, name: 'Heinz Tomato Ketchup', pre_price_text: 'BUY 1 GET 1', price_text: 'FREE', valid_from: '2026-09-24T00:00:00-04:00', valid_to: '2026-09-30T23:59:59-04:00' },
  { id: 104, name: 'Hershey’s Milk Chocolate Bars', price_text: '99¢', valid_from: '2026-09-24T00:00:00-04:00', valid_to: '2026-09-30T23:59:59-04:00' },
  { id: 105, name: 'Kroger Whole Milk, 1 gal', current_price: 2.5, post_price_text: 'ea', sale_story: 'with Card', original_price: 3.49 },
  { id: 106, name: 'Store Hours Banner', description: 'Open 7 days' },
];
const flyerPage = (extra: Partial<Parameters<typeof parseAd>[0]> = {}) =>
  parseAd(
    {
      sources: [
        { label: 'response https://dam.flippenterprise.net/flyerkit/publications/kroger?locale=en', text: JSON.stringify([{ id: 9, name: 'Weekly Ad', valid_from: '2026-09-24T00:00:00-04:00', valid_to: '2026-09-30T23:59:59-04:00' }]) },
        { label: 'response https://dam.flippenterprise.net/flyerkit/publication/9/products?display_type=all', text: JSON.stringify(FLYER) },
        { label: 'response https://www.kroger.com/api/recommended', text: JSON.stringify({ products: [{ name: 'Something', price: 3 }, { name: 'Else', price: 4 }] }) },
      ],
      ...extra,
    },
    NOW,
  );

(async () => {
  // --- Deals as ads word them ---------------------------------------------------------------------------------
  await t('deals: multi-buys, per pound, cents, buy-one-get-one, savings, percentages and member prices, tidied', () => {
    const read = (s: string, loose = false) => {
      const d = parseDeal(s, loose);
      return d && [d.words, d.price, d.qty, d.perLb, d.off, d.pct, d.buy, d.get, d.half, d.member];
    };
    assert.deepEqual(read('2 for $5'), ['2 for $5', 2.5, 2, undefined, undefined, undefined, undefined, undefined, undefined, undefined]);
    assert.deepEqual(read('2/$5.00')?.slice(0, 3), ['2 for $5', 2.5, 2]);
    assert.deepEqual(read('10/$10')?.slice(0, 3), ['10 for $10', 1, 10]);
    assert.equal(parseDeal('2/5'), null, 'on a page, 2/5 could be a date');
    assert.deepEqual(read('2/ 5.00', true)?.slice(0, 3), ['2 for $5', 2.5, 2], 'a flyer’s pieces put together');
    assert.equal(parseDeal('Valid 9/24 - 9/30'), null);
    assert.deepEqual(read('$1.99 lb')?.slice(0, 4), ['$1.99/lb', 1.99, undefined, true]);
    assert.deepEqual(read('1.99/lb', true)?.slice(0, 4), ['$1.99/lb', 1.99, undefined, true]);
    assert.equal(parseDeal('1.99'), null, 'a bare number only counts as a price in a flyer’s data');
    assert.deepEqual(read('99¢')?.slice(0, 2), ['99¢', 0.99]);
    assert.deepEqual(read('BUY 1 GET 1 FREE')?.slice(6, 9), [1, 1, undefined]);
    assert.equal(parseDeal('BOGO')?.words, 'Buy 1, get 1 free');
    assert.deepEqual([parseDeal('Buy 2, Get 1 50% Off')?.words, parseDeal('Buy 2, Get 1 50% Off')?.half], ['Buy 2, get 1 half off', true]);
    assert.deepEqual(read('SAVE $2.00')?.slice(0, 5), ['Save $2', undefined, undefined, undefined, 2]);
    assert.deepEqual(read('$3.99 Save $1')?.slice(0, 2), ['$3.99', 3.99], 'the price is the deal; the saving is its story');
    assert.equal(parseDeal('Save up to $2'), null, 'up to says nothing sure');
    assert.equal(parseDeal('40% off')?.pct, 40);
    assert.deepEqual(read('$3.99 with Card')?.slice(0, 2), ['$3.99', 3.99]);
    assert.equal(parseDeal('$3.99 with Card')?.member, true);
    assert.equal(parseDeal('Oscar Mayer Wieners'), null);
  });

  // --- Dates ------------------------------------------------------------------------------------------------
  await t('dates: as data gives them, and from an ad’s words, with the year nearest today', () => {
    assert.equal(dateOf('2026-09-30T23:59:59-04:00'), '2026-09-30', 'the store’s own day, not the phone’s');
    assert.deepEqual([dateOf('09/30/2026'), dateOf('9/30/26'), dateOf('Sep 30, 2026'), dateOf('Tuesday, September 30, 2026')], Array(4).fill('2026-09-30'));
    assert.equal(dateOf(Date.UTC(2026, 8, 30, 12)), '2026-09-30', 'epoch milliseconds');
    assert.equal(dateOf(String(Math.round(Date.UTC(2026, 8, 30, 12) / 1000))), '2026-09-30', 'epoch seconds, as words');
    assert.deepEqual([dateOf('2026-02-30'), dateOf('soon'), dateOf(20260930)], [undefined, undefined, undefined]);

    assert.deepEqual(rangeIn('Weekly Ad\nPrices valid 9/24 – 9/30', NOW), { from: '2026-09-24', to: '2026-09-30' });
    assert.deepEqual(rangeIn('Sale dates: Wed., Sep. 24 – Tue., Sep. 30, 2026', NOW), { from: '2026-09-24', to: '2026-09-30' });
    assert.deepEqual(rangeIn('September 24 - 30', NOW), { from: '2026-09-24', to: '2026-09-30' });
    assert.deepEqual(rangeIn('Sep 28 – Oct 4', NOW), { from: '2026-09-28', to: '2026-10-04' });
    assert.deepEqual(rangeIn('Valid through Tuesday, 9/30', NOW), { to: '2026-09-30' });
    assert.deepEqual(rangeIn('Holiday hours 12/24 - 12/26\n© 2026 Kroger', NOW), {}, 'a range months away isn’t this week’s ad');
    const newYear = new Date(2026, 11, 30, 12).getTime();
    assert.deepEqual(rangeIn('Dec 30 - Jan 5', newYear), { from: '2026-12-30', to: '2027-01-05' }, 'across the new year');
  });

  // --- Reading an ad ------------------------------------------------------------------------------------------
  await t('weekly ad: the flyer’s items from the page’s data, their deals, prices each and days; not a smaller list', () => {
    const ad = flyerPage();
    assert.deepEqual(
      ad.items.map((i) => [i.id, i.deal, i.price, i.perLb ?? false, i.member ?? false]),
      [
        ['101', '2 for $5', 2.5, false, false],
        ['102', '$1.99/lb', 1.99, true, false],
        ['103', 'Buy 1, get 1 free', undefined, false, false],
        ['104', '99¢', 0.99, false, false],
        ['105', '$2.50', 2.5, false, true],
      ],
      'a banner without a price isn’t an item; "save up to" isn’t a deal',
    );
    assert.deepEqual([ad.from, ad.to, ad.items[0].imageUrl, ad.items[4].wasPrice], ['2026-09-24', '2026-09-30', 'https://f.wishabi.net/1.jpg', 3.49]);
    assert.equal(ad.source, 'dam.flippenterprise.net/flyerkit/publication/9/products (5)');
    // Items without dates of their own: the ad's, from the flyer in the data, else its words.
    const bare = parseAd({ sources: [{ label: 'response https://x.com/ad', text: JSON.stringify(FLYER.map((i) => Object.fromEntries(Object.entries(i).filter(([k]) => !k.startsWith('valid_'))))) }], text: 'Prices valid 9/24 – 9/30' }, NOW);
    assert.deepEqual([bare.items.length, bare.from, bare.to], [5, '2026-09-24', '2026-09-30']);
  });

  await t('weekly ad: a deals page read with the general product reader; else the item cards drawn on the page', () => {
    const deals = { items: ['Great Value Whole Milk, 1 gal', 'Great Value Large Eggs, 12 ct', 'Marketside Strawberries, 1 lb'].map((name, i) => ({ usItemId: `w${i}`, name, priceInfo: { currentPrice: { price: 3 + i }, wasPrice: { price: 4 + i } } })) };
    const page = parseAd({ nextDataText: JSON.stringify({ props: { pageProps: deals } }) }, NOW);
    assert.deepEqual(page.items.map((i) => [i.name, i.deal, i.wasPrice]), [['Great Value Whole Milk, 1 gal', '$3', 4], ['Great Value Large Eggs, 12 ct', '$4', 5], ['Marketside Strawberries, 1 lb', '$5', 6]]);
    const cards = parseAd(
      {
        text: 'This week’s deals\nPrices valid 9/24 – 9/30',
        cards: [
          { lines: ['Oscar Mayer Wieners', '2 for $5', 'Add to list'], id: 'a1' },
          { lines: ['Chicken Breast', '$1.99 lb', 'Valid 9/24 - 9/30'] },
          { lines: ['Fresh Strawberries 1 lb', '$2.49'] },
          { lines: ['9/24 - 9/30'] },
        ],
      },
      NOW,
    );
    assert.deepEqual(cards.items.map((i) => [i.id, i.name, i.deal]), [['a1', 'Oscar Mayer Wieners', '2 for $5'], ['card:Chicken Breast|$1.99/lb', 'Chicken Breast', '$1.99/lb'], ['card:Fresh Strawberries 1 lb|$2.49', 'Fresh Strawberries 1 lb', '$2.49']]);
    assert.deepEqual([cards.from, cards.to, cards.source], ['2026-09-24', '2026-09-30', 'cards on the page (3)']);
    assert.deepEqual(parseAd({ text: 'Sorry, something went wrong' }, NOW), { items: [] });
  });

  // --- Matching an ad to lists ----------------------------------------------------------------------------------
  await t('ad matching: an ad item is a list item when it says the item’s words and no other kind of grocery', () => {
    const ad = flyerPage();
    const names = (itemName: string) => adItemsFor(itemName, ad, TODAY).map((i) => i.name);
    assert.deepEqual(names('Hot dogs'), ['Oscar Mayer Classic Wieners'], 'wieners are hot dogs');
    assert.deepEqual(names('Milk'), ['Kroger Whole Milk, 1 gal'], 'milk chocolate isn’t milk');
    assert.deepEqual(names('Chicken breast'), ['Boneless Skinless Chicken Breast']);
    assert.deepEqual(names('Ketchup'), ['Heinz Tomato Ketchup']);
    assert.deepEqual(names('Napkins'), []);
    assert.deepEqual(adItemsFor('Hot dogs', ad, '2026-10-01'), [], 'an ad that ended isn’t this week’s');
    assert.equal(sameAsAd('Oscar Mayer Classic Uncured Wieners, 10 ct', 'Oscar Mayer Classic Wieners'), true);
    assert.equal(sameAsAd('Ball Park Beef Franks, 8 ct', 'Oscar Mayer Classic Wieners'), false);
    assert.equal(sameAsAd('Kellogg’s Frosted Flakes Cereal, 13.5 oz', 'Kellogg’s Cereal, select varieties'), true, 'an ad names products loosely');
  });

  await t('ad on a basket line: its own product first, said with its price and when it ends; a lower ad price is said', () => {
    const ad = flyerPage();
    const l = list(item('Hot dogs'), item('Ketchup'), item('Napkins'));
    const own = basketFor(l, 'kroger', { 'hot dogs': done(p('k1', 'Oscar Mayer Classic Uncured Wieners, 10 ct', 3.49)), ketchup: done(p('k2', 'Kroger Tomato Ketchup, 32 oz', 1.79)), napkins: done(p('k3', 'Bounty Napkins, 200 ct', 4.99)) });
    const hits = adHits(own, ad, TODAY);
    assert.deepEqual(Object.keys(hits), ['i-Hot dogs', 'i-Ketchup']);
    assert.deepEqual([hits['i-Hot dogs'].same, hits['i-Hot dogs'].lower, hits['i-Ketchup'].same, hits['i-Ketchup'].lower], [true, true, false, undefined]);
    assert.equal(adLineWords(hits['i-Hot dogs'], ad, 3.49), 'In this week’s ad: 2 for $5 ($2.50 each), through Sep 30. The site shows $3.49: the ad’s price may be in store only.');
    assert.equal(adLineWords(hits['i-Ketchup'], ad), 'In this week’s ad: Heinz Tomato Ketchup, Buy 1, get 1 free, through Sep 30.');
    assert.equal(adFor(own.lines[2], ad, TODAY), null);
    assert.equal(adPriceWords(ad.items[4]), '$2.50 for members');
    assert.deepEqual([runsWords('2026-09-24', '2026-09-30'), runsWords('2026-09-28', '2026-10-04'), runsWords(undefined, '2026-09-30'), runsWords(undefined, undefined)], ['Sep 24–30', 'Sep 28–Oct 4', 'through Sep 30', '']);

    const deals = adDeals([l, list(item('hot dogs'), item('Milk'))], { kroger: ad, target: undefined }, TODAY);
    assert.deepEqual(deals.map((d) => [d.retailerId, d.itemName, d.item.name, d.to]), [
      ['kroger', 'Hot dogs', 'Oscar Mayer Classic Wieners', '2026-09-30'],
      ['kroger', 'Ketchup', 'Heinz Tomato Ketchup', '2026-09-30'],
      ['kroger', 'Milk', 'Kroger Whole Milk, 1 gal', '2026-09-30'],
    ], 'each item once per store, as first written; an item without days of its own runs with the ad');
  });

  // --- Reading coupons --------------------------------------------------------------------------------------------
  const KROGER_COUPONS = {
    data: {
      coupons: [
        { id: 'c1', brandName: 'Kellogg’s', shortDescription: 'Save $1.00 on 2 Kellogg’s Frosted Flakes or Froot Loops Cereal', savings: 1, requirementQuantity: 2, expirationDate: { value: '2026-10-04' }, addedToCard: true },
        { id: 'c2', brandName: 'Tide', shortDescription: 'Save $2.00 on any ONE (1) Tide PODS Laundry Detergent', savings: 2, expirationDate: { value: '2026-10-10' }, addedToCard: false },
        { id: 'c3', brandName: 'Kroger', shortDescription: 'Save $0.50 on Kroger Large Eggs, 12 ct', value: '$0.50 OFF', expirationDate: { value: '2026-09-20' }, addedToCard: true },
        { id: 'c4', shortDescription: 'Save 25% on Fresh Strawberries', expirationDate: { value: '2026-10-01' }, addedToCard: true },
      ],
      categories: [{ name: 'Breakfast Cereal', count: 12 }, { name: 'Laundry Care', count: 4 }],
    },
  };

  await t('coupons: worth from their words, with how many to buy; not a size', () => {
    const v = (s: string) => {
      const c = couponValue(s);
      return c && [c.words, c.off, c.pct, c.price, c.free, c.qty];
    };
    assert.deepEqual(v('$1.00 OFF'), ['$1 off', 1, undefined, undefined, undefined, undefined]);
    assert.deepEqual(v('Save $1.00 on any ONE (1) Tide PODS'), ['$1 off', 1, undefined, undefined, undefined, undefined]);
    assert.deepEqual(v('SAVE $2.00 on TWO (2) Kellogg’s cereals'), ['Buy 2, save $2', 2, undefined, undefined, undefined, 2]);
    assert.deepEqual(v('Save 50¢ when you buy 3'), ['Buy 3, save $0.50', 0.5, undefined, undefined, undefined, 3]);
    assert.deepEqual(v('Save 25%'), ['25% off', undefined, 25, undefined, undefined, undefined]);
    assert.deepEqual(v('2 for $5'), ['2 for $5 with it', undefined, undefined, 5, undefined, 2]);
    assert.deepEqual(v('$2.99'), ['$2.99 with it', undefined, undefined, 2.99, undefined, undefined]);
    assert.deepEqual(v('Buy 2 Get 1 Free'), ['Buy 2, get one free', undefined, undefined, undefined, true, 2]);
    assert.equal(quantityIn('Save $1 on 10 oz bag'), undefined, 'a size, not a count');
    assert.equal(couponValue('Save up to $3 on select items'), null);
    assert.equal(couponValue('Breakfast Cereal'), null);
  });

  await t('coupons: the account’s list from the page’s data, clipped or not, with expiry, brand and quantity', () => {
    const got = parseCoupons({ sources: [{ label: 'response https://www.kroger.com/atlas/v1/savings-coupons/v1/coupons?x=1', text: JSON.stringify(KROGER_COUPONS) }] }, NOW);
    assert.deepEqual(
      got.coupons.map((c) => [c.id, c.brand, c.value, c.qty, c.expires, c.clipped]),
      [
        ['c1', 'Kellogg’s', 'Buy 2, save $1', 2, '2026-10-04', true],
        ['c2', 'Tide', '$2 off', undefined, '2026-10-10', false],
        ['c3', 'Kroger', '$0.50 off', undefined, '2026-09-20', true],
        ['c4', undefined, '25% off', undefined, '2026-10-01', true],
      ],
      'categories aren’t coupons',
    );
    assert.deepEqual([got.signedOut, got.source], [undefined, 'www.kroger.com/atlas/v1/savings-coupons/v1/coupons (4)']);

    // Offers keyed by id, with a status of C (clipped) or U: as Albertsons' stores give them.
    const offers = Object.fromEntries(
      [
        ['111', 'Signature SELECT Ice Cream', 'Signature SELECT Ice Cream 48 oz', '$1.00 OFF', 'Signature SELECT', 'C'],
        ['112', 'Oscar Mayer Wieners', 'Oscar Mayer Wieners or Bacon', '$1.50 OFF', 'Oscar Mayer', 'U'],
        ['113', 'Lucerne Cheese', 'Lucerne Shredded Cheese 8 oz', '$0.75 OFF', 'Lucerne', 'U'],
        ['114', 'Tide', 'Tide Liquid Detergent 92 oz', '$3.00 OFF', 'Tide', 'C'],
        ['115', 'Cheerios', 'Cheerios Cereal 12 oz', '$1.00 OFF', 'General Mills', 'U'],
      ].map(([id, name, description, offerPrice, brand, status]) => [id, { offerId: id, name, description, offerPrice, brand, endDate: String(Date.UTC(2026, 9, 5, 12)), status }]),
    );
    const albertsons = parseCoupons({ sources: [{ label: 'response https://www.safeway.com/abs/pub/xapi/offers/companiongalleryoffer', text: JSON.stringify({ companionGalleryOffer: offers }) }] }, NOW);
    assert.deepEqual(albertsons.coupons.map((c) => [c.id, c.title, c.value, c.clipped, c.expires]).slice(0, 2), [
      ['111', 'Signature SELECT Ice Cream 48 oz', '$1 off', true, '2026-10-05'],
      ['112', 'Oscar Mayer Wieners or Bacon', '$1.50 off', false, '2026-10-05'],
    ]);
  });

  await t('coupons: tiles drawn on the page, by their buttons; signed out when the page asks to sign in', () => {
    const tiles = parseCoupons(
      {
        cards: [
          { lines: ['$1.00 off', 'Tide PODS Laundry Detergent', 'Exp 10/10/26'], button: 'Clip', id: 'k1' },
          { lines: ['Save $0.75', 'Hot Pockets Sandwiches', 'Expires 10/4'], button: 'Clipped' },
          { lines: ['New! Weekly digital deals'], button: 'Shop now' },
        ],
      },
      NOW,
    );
    assert.deepEqual(tiles.coupons.map((c) => [c.id, c.title, c.value, c.expires, c.clipped]), [
      ['k1', 'Tide PODS Laundry Detergent', '$1 off', '2026-10-10', false],
      ['tile:Hot Pockets Sandwiches|$0.75 off', 'Hot Pockets Sandwiches', '$0.75 off', '2026-10-04', true],
    ]);
    const out = parseCoupons({ text: 'Digital Coupons\nSign in to clip coupons', cards: [{ lines: ['$1.00 off', 'Tide PODS'], button: 'Sign In to Clip' }, { lines: ['$2.00 off', 'Gain Flings'], button: 'Sign In to Clip' }] }, NOW);
    assert.deepEqual([out.coupons.length, out.signedOut], [2, true]);
  });

  // --- Coupons on basket lines, and totals ----------------------------------------------------------------------
  const COUPONS: Coupon[] = parseCoupons({ sources: [{ label: 'response x', text: JSON.stringify(KROGER_COUPONS) }] }, NOW).coupons;

  await t('coupon matching: the brand, then one of the things it’s for; a one-word choice takes the first’s brand', () => {
    const [c1, c2, , c4] = COUPONS;
    assert.deepEqual(couponTargets(c1), ['kelloggs frosted flakes', 'froot loops cereal']);
    assert.equal(couponFits('Kellogg’s Frosted Flakes Cereal, 13.5 oz', c1), true);
    assert.equal(couponFits('Kellogg’s Froot Loops, 10.1 oz', c1), true);
    assert.equal(couponFits('Great Value Frosted Flakes, 24 oz', c1), false, 'another brand');
    assert.equal(couponFits('Tide PODS Laundry Detergent Pacs, 42 ct', c2), true);
    assert.equal(couponFits('Gain Flings Laundry Detergent Pacs', c2), false);
    assert.equal(couponFits('Driscoll’s Strawberries, 1 lb', c4), true, 'no brand: what it’s for');
    assert.equal(couponFits('Strawberry Jam', c4), false);
    const bacon = { title: 'Save $1.50 on Oscar Mayer Wieners or Bacon' };
    assert.deepEqual(couponTargets(bacon), ['oscar mayer hotdog', 'oscar mayer bacon']);
    assert.equal(couponFits('Oscar Mayer Naturally Hardwood Smoked Bacon', bacon), true);
    assert.equal(couponFits('Hormel Black Label Bacon', bacon), false, 'the first choice’s brand goes with “or Bacon”');
    assert.deepEqual(couponTargets({ title: 'Save $1 on Kraft Mac and Cheese, 7.25 oz. Limit 1.' }), ['kraft mac cheese'], 'and doesn’t separate choices');
    assert.equal(couponFits('Kellogg’s Pop-Tarts', { title: 'Save $1 on any Kellogg’s product', brand: 'Kellogg’s' }), true, 'a brand’s coupon for anything of its');
  });

  await t('coupon savings: once per coupon, when enough is bought; percentages, prices with it and a free one', () => {
    const c = (over: Partial<Coupon>): Coupon => ({ id: 'x', title: 'x', value: 'x', clipped: true, ...over });
    assert.deepEqual([couponSaves(c({ off: 1, qty: 2 }), 3.49, 1), couponSaves(c({ off: 1, qty: 2 }), 3.49, 2), couponSaves(c({ off: 1, qty: 2 }), 3.49, 5)], [0, 1, 1]);
    assert.equal(couponSaves(c({ off: 5 }), 3.49, 1), 3.49, 'never more than the item');
    assert.equal(couponSaves(c({ pct: 25 }), 2.99, 1), 0.75);
    assert.equal(couponSaves(c({ price: 5, qty: 2 }), 3.49, 2), 1.98);
    assert.deepEqual([couponSaves(c({ free: true, qty: 2 }), 2, 2), couponSaves(c({ free: true, qty: 2 }), 2, 3)], [0, 2], 'buy 2, get the third free');
  });

  await t('coupons on a basket: each coupon on one line, expired ones out; only clipped ones that are met count', () => {
    const l = list(item('Cereal', 2), item('Laundry detergent'), item('Strawberries'), item('Eggs'), item('More cereal'));
    const b = basketFor(l, 'kroger', {
      cereal: done(p('k1', 'Kellogg’s Frosted Flakes Cereal, 13.5 oz', 3.49)),
      'laundry detergent': done(p('k2', 'Tide PODS Laundry Detergent Pacs, 42 ct', 12.97)),
      strawberries: done(p('k3', 'Driscoll’s Strawberries, 1 lb', 2.99)),
      eggs: done(p('k4', 'Kroger Large Eggs, 12 ct', 3.29)),
      'more cereal': done(p('k5', 'Kellogg’s Froot Loops Cereal, 10.1 oz', 3.29)),
    });
    const hits = couponHits(b, COUPONS, TODAY);
    assert.deepEqual(
      Object.entries(hits).map(([id, h]) => [id, h.coupon.id, h.saves, h.counts, h.needs]),
      [
        ['i-Cereal', 'c1', 1, true, undefined],
        ['i-Strawberries', 'c4', 0.75, true, undefined],
        ['i-Laundry detergent', 'c2', 2, false, undefined],
      ],
      'the eggs’ coupon expired; the cereal coupon is used once, where two are bought; the Tide one isn’t clipped',
    );
    assert.equal(couponChip(hits['i-Cereal'].coupon), 'Coupon: Buy 2, save $1');
    assert.equal(couponStateWords(hits['i-Laundry detergent']), 'not clipped');
    const credit = couponCredit(b, COUPONS, TODAY);
    assert.deepEqual(credit, { amount: 1.75, count: 2, unclipped: { count: 1, amount: 2 }, short: 0 });
    assert.equal(couponsWords(credit), '3 of your coupons fit this basket: 2 come off at checkout, $1.75; 1 to clip, $2.00 more.');
    const one = basketFor(list(item('Cereal')), 'kroger', { cereal: done(p('k1', 'Kellogg’s Frosted Flakes Cereal, 13.5 oz', 3.49)) });
    const short = couponHits(one, COUPONS, TODAY)['i-Cereal'];
    assert.deepEqual([short.saves, short.could, short.needs, short.counts, couponStateWords(short)], [0, 1, 2, false, 'clipped · buy 2 for it']);
    assert.equal(couponsWords(couponCredit(one, COUPONS, TODAY)), '1 of your coupons fits this basket: none comes off yet; 1 more once you buy enough.');
  });

  await t('totals with coupons: only when the user counts them, and then they can change the pick', () => {
    const l = list(item('Cereal', 2), item('Strawberries'));
    const kroger = basketFor(l, 'kroger', { cereal: done(p('k1', 'Kellogg’s Frosted Flakes Cereal, 13.5 oz', 3.49)), strawberries: done(p('k3', 'Driscoll’s Strawberries, 1 lb', 2.99)) });
    const target = basketFor(l, 'target', { cereal: done(p('t1', 'Kellogg’s Frosted Flakes Cereal, 13.5 oz', 3.29)), strawberries: done(p('t3', 'Driscoll’s Strawberries, 1 lb', 2.99)) });
    assert.deepEqual([kroger.total, target.total], [9.97, 9.57]);
    assert.equal(stretchPick([kroger, target])?.retailerId, 'target', 'shelf prices');
    const credits = couponCredits([kroger, target], (id) => (id === 'kroger' ? COUPONS : undefined), TODAY);
    assert.deepEqual(Object.keys(credits), ['kroger'], 'only stores whose coupons were read');
    const extra = withCoupons(undefined, credits);
    assert.deepEqual(extra, { kroger: -1.75 });
    assert.equal(stretchPick([kroger, target], 'total', extra)?.retailerId, 'kroger', 'with clipped coupons counted: $8.22 against $9.57');
    assert.deepEqual(withCoupons({ kroger: 2, target: 5 }, credits), { kroger: 0.25, target: 5 }, 'on top of fees and driving');
    assert.deepEqual(withCoupons({ kroger: 2 }, { kroger: { amount: 0, count: 0, unclipped: { count: 1, amount: 2 }, short: 0 } }), { kroger: 2 }, 'nothing clipped: the costs as they were');
    const unclippedOnly = COUPONS.map((c) => ({ ...c, clipped: false }));
    assert.equal(couponCredit(kroger, unclippedOnly, TODAY).amount, 0, 'coupons not clipped never count');
  });

  await t('coupons for lists’ items, for deals: by what each coupon is for', () => {
    const l = list(item('Laundry detergent'), item('Strawberries'), item('Bread'));
    assert.deepEqual(couponsForItems([l], COUPONS, TODAY).map((x) => [x.itemName, x.coupon.id]), [['Laundry detergent', 'c2'], ['Strawberries', 'c4']]);
  });

  // --- Reading at most once a day, and saying when -------------------------------------------------------------
  await t('ads are read at most once a day per store; kept while they run; a failed one again only when asked', () => {
    const key = 'https://www.kroger.com/weeklyad 01400943@0';
    const ad: WeeklyAd = { items: [], from: '2026-09-24', to: '2026-09-30' };
    const read = (over: Partial<Parameters<typeof adDue>[0] & object>) => ({ key, url: 'u', at: NOW, ok: true, value: ad, valueAt: NOW, ...over });
    assert.equal(adDue(undefined, key, NOW), true, 'never read');
    assert.equal(adDue(read({}), 'another store', NOW), true, 'another store’s ad');
    assert.equal(adDue(read({}), key, NOW + HOUR, true), false, 'read today: not again, even when asked');
    assert.equal(adDue(read({}), key, NOW + AD_READ_EVERY_MS + HOUR), false, 'the ad it read still runs');
    assert.equal(adDue(read({}), key, new Date(2026, 9, 1, 9).getTime()), true, 'the ad it read has ended');
    assert.equal(adDue(read({ value: { items: [] } }), key, NOW + AD_READ_EVERY_MS), true, 'no end date: daily');
    assert.equal(adDue(read({ value: { items: [], to: '2026-12-31' } }), key, NOW + AD_KEEP_MAX_MS), true, 'a week at most');
    const failed = read({ ok: false, reason: 'timeout', value: undefined });
    assert.deepEqual([adDue(failed, key, NOW + HOUR), adDue(failed, key, NOW + HOUR, true), adDue(failed, key, NOW + AD_READ_EVERY_MS)], [false, true, true]);
    const notSent = read({ ok: false, reason: 'polite_limit', value: undefined });
    assert.deepEqual([adDue(notSent, key, NOW + 30 * 60_000), adDue(notSent, key, NOW + HOUR)], [false, true], 'the hourly limit: tried again after an hour');
  });

  await t('where an ad is: the store it’s set to fills the page; signing in doesn’t make it another ad', () => {
    const withStore = cfg({ ad: { url: 'https://www.kroger.com/weeklyad?store={{storeId}}' } });
    assert.deepEqual(adTarget(withStore, { storeId: '', storeKey: '@0' }, '10001'), { needs: 'store' });
    const target = adTarget(withStore, { storeId: '01400943', storeKey: '01400943@0~1234' }, '10001');
    assert.deepEqual(target, { url: 'https://www.kroger.com/weeklyad?store=01400943', key: 'https://www.kroger.com/weeklyad?store=01400943 01400943@0' });
    assert.equal(adTarget(cfg({}), { storeId: '', storeKey: '' }, ''), null, 'no ad in its rules');
    assert.deepEqual(adTarget(cfg({ ad: { url: 'https://www.kroger.com/weeklyad?zip={{zip}}' } }), { storeId: '', storeKey: '' }, ''), { needs: 'zip' });
  });

  await t('coupons are read once signed in, every six hours or when asked; signed out, they wait for a new sign-in', () => {
    const c = cfg({ coupons: { url: 'https://www.kroger.com/savings/cl/coupons/', program: 'Kroger digital coupons' } });
    assert.deepEqual(couponTarget(c, undefined), { needs: 'signin' });
    const target = couponTarget(c, 1234) as { url: string; key: string };
    assert.equal(target.key, 'https://www.kroger.com/savings/cl/coupons/ ~1234');
    const read = { key: target.key, url: target.url, at: NOW, ok: true, value: { coupons: [] } as CouponList, valueAt: NOW };
    assert.deepEqual([couponsDue(read, target.key, NOW + HOUR), couponsDue(read, target.key, NOW + HOUR, true), couponsDue(read, target.key, NOW + COUPONS_READ_EVERY_MS)], [false, true, true]);
    const out = { ...read, ok: false, reason: 'signed_out' };
    assert.deepEqual([couponsDue(out, target.key, NOW + 2 * COUPONS_READ_EVERY_MS), couponsDue(out, 'https://www.kroger.com/savings/cl/coupons/ ~5678', NOW)], [false, true]);
  });

  await t('reads are saved with what the last good one found, kept through a failure; broken saves are dropped', () => {
    const book = new ReadBook<WeeklyAd>((v): v is WeeklyAd => typeof v === 'object' && v !== null && Array.isArray((v as WeeklyAd).items));
    let heard = 0;
    book.subscribe(() => heard++);
    const ad = flyerPage();
    book.record('kroger', { key: 'k', url: 'u', at: NOW, ok: true, value: ad });
    book.record('kroger', { key: 'k', url: 'u', at: NOW + HOUR, ok: false, reason: 'timeout' });
    assert.deepEqual([book.get('kroger')?.ok, book.get('kroger')?.valueAt, book.current('kroger', 'k')?.items.length, book.current('kroger', 'other')], [false, NOW, 5, undefined]);
    book.record('kroger', { key: 'other', url: 'u', at: NOW + 2 * HOUR, ok: false, reason: 'challenge' });
    assert.equal(book.get('kroger')?.value, undefined, 'another store’s read keeps nothing of this one’s');
    const copy = new ReadBook<WeeklyAd>((v): v is WeeklyAd => typeof v === 'object' && v !== null && Array.isArray((v as WeeklyAd).items));
    copy.hydrate(JSON.stringify({ target: { key: 'k', url: 'u', at: 1, ok: true, value: { items: 'broken' }, valueAt: 1 }, bad: { at: 'x' } }));
    assert.deepEqual(copy.all(), { target: { key: 'k', url: 'u', at: 1, ok: true } });
    book.record('target', { key: 't', url: 'u', at: NOW, ok: true, value: ad });
    book.update('target', (v) => ({ ...v, items: v.items.slice(0, 1) }));
    assert.equal(book.current('target', 't')?.items.length, 1);
    const saved = new ReadBook<WeeklyAd>((v): v is WeeklyAd => typeof v === 'object' && v !== null && Array.isArray((v as WeeklyAd).items));
    saved.hydrate(book.serialize());
    assert.deepEqual(saved.all(), book.all());
    assert.ok(heard >= 4);
  });

  await t('when each was read, in words: the ad’s items and days, or why not; the coupons clipped, or sign in first', () => {
    const c = cfg({ ad: { url: 'https://www.kroger.com/weeklyad' }, coupons: { url: 'https://www.kroger.com/savings/cl/coupons/', program: 'Kroger digital coupons' } });
    const target = adTarget(c, { storeId: '1', storeKey: '1@0' }, '')!;
    const key = (target as { key: string }).key;
    assert.equal(adStatusWords(c, target, undefined, false, NOW), 'Not read yet. It’s read on this phone, hidden, at most once a day.');
    assert.equal(adStatusWords(c, target, undefined, true, NOW), 'Reading Kroger’s weekly ad now…');
    const ok = { key, url: 'u', at: NOW - 2 * HOUR, ok: true, value: flyerPage(), valueAt: NOW - 2 * HOUR };
    assert.equal(adStatusWords(c, target, ok, false, NOW), 'Read 2 h ago: 5 sale items, running Sep 24–30. Next read when this ad ends, or in a week.');
    const failed = { ...ok, at: NOW - HOUR, ok: false, reason: 'challenge' };
    assert.equal(adStatusWords(c, target, failed, false, NOW), 'Couldn’t read it 1 h ago: bot check. Showing the ad read 2 h ago: 5 sale items, running Sep 24–30.');
    assert.equal(adStatusWords(cfg({}), null, undefined, false, NOW), 'Kroger has no weekly ad in the store rules.');

    assert.equal(couponStatusWords(c, couponTarget(c, undefined), undefined, false, NOW), 'Sign in on Kroger’s own page, and the phone reads your Kroger digital coupons: which there are, and which you’ve clipped.');
    const ct = couponTarget(c, 99) as { url: string; key: string };
    const read = { key: ct.key, url: ct.url, at: NOW - 10 * 60_000, ok: true, value: { coupons: COUPONS }, valueAt: NOW - 10 * 60_000 };
    assert.equal(couponStatusWords(c, ct, read, false, NOW), 'Read 10 min ago: 4 coupons, 3 clipped.');
    assert.equal(couponStatusWords(c, ct, { ...read, ok: false, reason: 'signed_out', at: NOW }, false, NOW), 'Signed out of Kroger’s site just now: sign in again to read your coupons. From before: 4 coupons, 3 clipped.');
  });

  // --- Stores' own data, as their pages get it (researched 2026-09-26) ------------------------------------------
  await t('weekly ads as stores give them: Kroger’s shoppable ad, Target’s, Whole Foods’ page data, Publix’s', () => {
    const kroger = parseAd({ sources: [{ label: 'response https://www.kroger.com/atlas/v1/shoppable-weekly-deals/deals', text: JSON.stringify({ data: { shoppableWeeklyDeals: { storeId: '01400943', ads: [
      { id: 'a1', mainlineCopy: 'Kroger Large Eggs', underlineCopy: '12 ct', salePrice: 1.99, retailPrice: 2.79, validFrom: '2026-09-23', validTill: '2026-09-29' },
      { id: 'a2', mainlineCopy: 'Oscar Mayer Wieners', salePrice: 2.5, retailPrice: 3.99, validFrom: '2026-09-23', validTill: '2026-09-29' },
      { id: 'a3', mainlineCopy: 'Heinz Ketchup', buyQuantity: 1, getQuantity: 1, validFrom: '2026-09-23', validTill: '2026-09-29' },
    ] } } }) }] }, NOW);
    assert.deepEqual(kroger.items.map((i) => [i.name, i.deal, i.price, i.wasPrice]), [
      ['Kroger Large Eggs', '$1.99', 1.99, 2.79],
      ['Oscar Mayer Wieners', '$2.50', 2.5, 3.99],
      ['Heinz Ketchup', 'Buy 1, get 1 free', undefined, undefined],
    ]);
    assert.deepEqual([kroger.from, kroger.to], ['2026-09-23', '2026-09-29']);

    const target = parseAd({ sources: [
      { label: 'response https://api.target.com/weekly_ads/v1/store_promotions?key=x&store_id=1', text: JSON.stringify([{ promotion_id: 'p1', sale_start_date: '2026-09-20', sale_end_date: '2026-09-26' }]) },
      { label: 'response https://api.target.com/weekly_ads/v1/promotions/p1', text: JSON.stringify({ hotspots: [
        { tcin: '1', title: 'Good & Gather Milk', price: '$2.89', reg_price: '$3.29', circle_offer: false },
        { tcin: '2', title: 'Doritos Tortilla Chips', price: '2 for $6', circle_offer: true, promotion_message: 'With Target Circle' },
        { tcin: '3', title: 'Tide PODS', price: '$19.99', reg_price: '$22.99' },
      ] }) },
    ] }, NOW);
    assert.deepEqual(target.items.map((i) => [i.id, i.deal, i.price, i.member ?? false, i.wasPrice]), [['1', '$2.89', 2.89, false, 3.29], ['2', '2 for $6', 3, true, undefined], ['3', '$19.99', 19.99, false, 22.99]]);
    assert.deepEqual([target.from, target.to], ['2026-09-20', '2026-09-26'], 'the promotion’s days, running today');

    const wholefoods = parseAd({ nextDataText: JSON.stringify({ props: { pageProps: { promotions: [
      { productName: 'Organic Strawberries, 1 lb', originBrandName: 'Driscoll’s', regularPrice: 4.99, salePrice: 3.99, primePrice: 3.49, startDate: '2026-09-23', endDate: '2026-09-29' },
      { productName: 'Boneless Chicken Breast', regularPrice: 6.99, salePrice: 5.99, primePrice: 4.99, startDate: '2026-09-23', endDate: '2026-09-29' },
      { productName: '365 Whole Milk, 1 gal', regularPrice: 4.49, salePrice: 3.99, startDate: '2026-09-23', endDate: '2026-09-29' },
    ] } } }) }, NOW);
    assert.deepEqual(wholefoods.items.map((i) => [i.name, i.deal, i.wasPrice, i.memberPrice]), [
      ['Organic Strawberries, 1 lb', '$3.99', 4.99, 3.49],
      ['Boneless Chicken Breast', '$5.99', 6.99, 4.99],
      ['365 Whole Milk, 1 gal', '$3.99', 4.49, undefined],
    ]);
    assert.equal(adPriceWords(wholefoods.items[0]), '$3.99, $3.49 for members');

    const publix = parseAd({ sources: [{ label: 'response https://services.publix.com/api/v4/savings?getSavingType=WeeklyAd', text: JSON.stringify({ Savings: [
      { id: 'x1', title: 'Publix Chicken Breasts', savings: '$3.99 lb', wa_startDateFormatted: '9/24', wa_endDateFormatted: '9/30' },
      { id: 'x2', title: 'Heinz Tomato Ketchup', savings: 'Buy 1 Get 1 FREE', wa_startDateFormatted: '9/24', wa_endDateFormatted: '9/30' },
      { id: 'x3', title: 'Coca-Cola, 12-pack', savings: '2/$14', additionalDealInfo: 'Limit 4', wa_startDateFormatted: '9/24', wa_endDateFormatted: '9/30' },
    ] }) }] }, NOW);
    assert.deepEqual(publix.items.map((i) => [i.deal, i.price, i.perLb ?? false]), [['$3.99/lb', 3.99, true], ['Buy 1, get 1 free', undefined, false], ['2 for $14', 7, false]]);
    assert.deepEqual([publix.from, publix.to], ['2026-09-24', '2026-09-30'], 'days without a year, in the year nearest the read');
    assert.deepEqual(adItemsFor('Ketchup', publix, TODAY).map((i) => i.name), ['Heinz Tomato Ketchup'], 'tomato ketchup is ketchup');
    assert.deepEqual(adItemsFor('Soda', publix, TODAY).map((i) => i.name), ['Coca-Cola, 12-pack'], 'cola is soda');
  });

  await t('matching: something else made of the item isn’t it; a kind of the item is', () => {
    const ad: WeeklyAd = { items: ['Jif Peanut Butter', 'Land O Lakes Butter', 'Smucker’s Strawberry Jam', 'Driscoll’s Strawberries', 'Nestle Chocolate Milk', 'Kroger Whole Milk'].map((name, i) => ({ id: `${i}`, name, deal: '$1' })) };
    assert.deepEqual(adItemsFor('Butter', ad, TODAY).map((i) => i.name), ['Land O Lakes Butter']);
    assert.deepEqual(adItemsFor('Peanut butter', ad, TODAY).map((i) => i.name), ['Jif Peanut Butter']);
    assert.deepEqual(adItemsFor('Strawberries', ad, TODAY).map((i) => i.name), ['Driscoll’s Strawberries']);
    assert.deepEqual(adItemsFor('Milk', ad, TODAY).map((i) => i.name), ['Kroger Whole Milk']);
  });

  await t('coupons as Kroger gives them: the worth in one field, what it’s for in another, and the barcodes it’s good for', () => {
    const compact = parseCoupons({ sources: [{ label: 'response https://www.kroger.com/atlas/v1/savings-coupons/v1/coupons?projections=coupons.compact', text: JSON.stringify({ data: { coupons: [
      { id: 'k1', brandName: 'Kellogg’s', title: 'Save $1.00', shortDescription: 'on 2 Kellogg’s Frosted Flakes Cereal', requirementDescription: 'when you buy 2', expirationDate: '2026-10-04', addedToCard: true, canBeAddedToCard: true, upcs: ['0003800000120'] },
      { id: 'k2', brandName: 'Tide', title: 'Save $2.00', shortDescription: 'Tide PODS Laundry Detergent', expirationDate: '2026-10-10', addedToCard: false, canBeAddedToCard: true },
    ] } }) }] }, NOW);
    assert.deepEqual(compact.coupons.map((c) => [c.id, c.title, c.value, c.qty, c.clipped, c.upcs]), [
      ['k1', 'on 2 Kellogg’s Frosted Flakes Cereal', 'Buy 2, save $1', 2, true, ['0003800000120']],
      ['k2', 'Tide PODS Laundry Detergent', '$2 off', undefined, false, undefined],
    ]);
    const [k1] = compact.coupons;
    assert.equal(couponFits('Kellogg’s Frosted Flakes, 13.5 oz', k1, '038000001208'), true, 'its barcode, as Kroger and a UPC-A write it');
    assert.equal(couponFits('Kellogg’s Frosted Flakes, 24 oz', k1, '038000009990'), false, 'another barcode: not this one, whatever its name');
    assert.equal(couponFits('Kellogg’s Frosted Flakes, 24 oz', k1), true, 'no barcode on the product: its name');
  });

  // --- Pages on the phone -------------------------------------------------------------------------------------------
  await t('sign-in pages, by address: host or path, not the query', () => {
    for (const url of [
      'https://login.kroger.com/signin', 'https://www.kroger.com/signin?redirectUrl=/savings', 'https://www.safeway.com/account/sign-in.html', 'https://www.target.com/login?client_id=x',
      'https://albertsons.okta.com/oauth2/v1/authorize', 'https://www.meijer.com/shopping/login.html', 'https://accounts.heb.com/', 'https://www.amazon.com/ap/signin',
    ]) assert.equal(looksLikeSignIn(url), true, url);
    for (const url of [
      'https://www.kroger.com/savings/cl/coupons/', 'https://www.safeway.com/foru/coupons-deals.html', 'https://www.target.com/deals/all?facet=circle_deals&login=1',
      'https://www.meijer.com/shopping/weeklyad.html', 'https://www.heb.com/digital-coupon/coupon-selection/all-coupons', 'https://www.publix.com/savings/digital-coupons',
    ]) assert.equal(looksLikeSignIn(url), false, url);
  });

  await t('a hidden read of the account sent to a sign-in page stops before it loads; an account page on screen gets nothing', async () => {
    const lane = new WebViewQueue();
    const read = lane.run({ url: 'https://www.kroger.com/savings/cl/coupons/', challengeMarkers: [], timeoutMs: 1000, retailerName: 'Kroger', waitFor: 'auto', guardSignIn: true, task: { kind: 'readList' } });
    assert.match(lane.getSnapshot()!.script, /__stretchList/);
    assert.match(lane.getSnapshot()!.beforeScript ?? '', /__stretchCapture/, 'its own page is read like a search page');
    assert.equal(lane.allows('https://www.kroger.com/savings/cl/coupons/?page=2', true), true);
    assert.equal(lane.allows('https://login.kroger.com/signin', false), true, 'a frame inside the page is left to the page');
    assert.equal(lane.allows('https://login.kroger.com/signin?redirect=coupons', true), false);
    await assert.rejects(read, /signed_out/);
    assert.equal(lane.getSnapshot(), null, 'the page is gone');

    const search = lane.run({ url: 'https://www.kroger.com/search?query=milk', challengeMarkers: [], timeoutMs: 1000, retailerName: 'Kroger' });
    assert.equal(lane.allows('https://www.kroger.com/signin', true), true, 'searches aren’t guarded: the site’s own rules keep them on it');
    lane.receive(JSON.stringify({ nonce: nonceOf(lane.getSnapshot()!.script), kind: 'data', href: 'h', nextDataText: '{}' }));
    await search;

    const view = lane.browse({ url: 'https://www.kroger.com/savings/cl/coupons/', retailerName: 'Kroger', purpose: 'account' });
    const page = lane.getSnapshot()!;
    assert.deepEqual([page.phase, page.purpose, page.beforeScript, page.script, lane.readPage()], ['browse', 'account', undefined, 'true;', null]);
    lane.closeBrowse();
    assert.equal(await view, null);
  });

  await t('list page script: scrolls a few screens, waits for the page’s requests to go quiet, posts its data, words and cards', async () => {
    const p = makePage(
      `<html><head><title>Weekly Ad</title></head><body><h1>Weekly Ad</h1><p>Prices valid 9/24 – 9/30</p><ul>
        <li class="deal-card" data-item-id="a1"><h3>Oscar Mayer Wieners</h3><span class="price">2 for $5</span><button>Add to list</button></li>
        <li class="deal-card" data-item-id="a2"><h3>Chicken Breast</h3><span class="price">$1.99 lb</span></li>
        <li class="deal-card"><h3>Fresh Strawberries</h3><span>$2.49</span><img src="https://img.example.com/s.jpg"></li>
      </ul></body></html>`,
      'https://www.example.com/weeklyad',
    );
    let scrolled = 0;
    p.w.scrollBy = () => scrolled++;
    p.w.fetch = () => Promise.resolve({ headers: { get: () => 'application/json' }, clone: () => ({ text: () => Promise.resolve(JSON.stringify({ items: FLYER })) }) });
    p.run(captureScript());
    p.run(listPageScript('ad1', markers, { quietMs: 40, intervalMs: 10, maxMs: 3000, scrolls: 2 }));
    p.run(listPageScript('ad1', markers, { quietMs: 40, intervalMs: 10, maxMs: 3000, scrolls: 2 }));
    await p.w.fetch('https://dam.flippenterprise.net/flyerkit/publication/9/products?access_token=x');
    await sleep(250);
    assert.equal(scrolled, 2);
    assert.deepEqual(p.posts.map((m) => [m.kind, m.nonce]), [['data', 'ad1']], 'once, however often it’s injected');
    const post = p.posts[0];
    assert.equal(post.sources[0].request, undefined, 'the data, not how it was asked for');
    assert.match(post.text, /Prices valid 9\/24 – 9\/30/);
    assert.deepEqual(post.pageResult.cards.map((c: any) => [c.id, c.lines, c.button, c.img]), [
      ['a1', ['Oscar Mayer Wieners', '2 for $5', 'Add to list'], 'Add to list', undefined],
      ['a2', ['Chicken Breast', '$1.99 lb'], undefined, undefined],
      [undefined, ['Fresh Strawberries', '$2.49'], undefined, 'https://img.example.com/s.jpg'],
    ]);
    const ad = parseAd({ sources: post.sources, text: post.text, cards: post.pageResult.cards }, NOW);
    assert.deepEqual([ad.items.length, ad.source], [5, 'dam.flippenterprise.net/flyerkit/publication/9/products (5)'], 'the flyer’s data before the cards');
    const blocked = makePage('<html><head><title>Access Denied</title></head><body></body></html>', 'https://www.kroger.com/weeklyad');
    blocked.run(listPageScript('ad2', markers, { intervalMs: 5 }));
    await sleep(30);
    assert.deepEqual(blocked.posts.map((m) => m.kind), ['challenge']);
  });

  await t('clip script: presses the coupon’s own button once and says it’s clipped; clipped already, it isn’t pressed', async () => {
    const tiles = (second: string) => `<html><body>
      <div class="coupon-tile" data-offer-id="111"><p>$1.00 off</p><p>Signature SELECT Ice Cream 48 oz</p><button>Clip Coupon</button></div>
      <div class="coupon-tile" data-offer-id="112"><p>$1.50 off</p><p>Oscar Mayer Wieners or Bacon</p><button>${second}</button></div>
    </body></html>`;
    const p = makePage(tiles('Clip Coupon'), 'https://www.safeway.com/foru/coupons-deals.html');
    const buttons = p.w.document.querySelectorAll('button');
    const presses = [0, 0];
    buttons[0].addEventListener('click', () => presses[0]++);
    buttons[1].addEventListener('click', () => {
      presses[1]++;
      setTimeout(() => (buttons[1].textContent = 'Clipped'), 20);
    });
    p.run(clipScript('c1', markers, { id: '112', title: 'Oscar Mayer Wieners or Bacon' }, CLIP_BUTTONS, { settleMs: 300, intervalMs: 10 }));
    await sleep(120);
    assert.deepEqual(presses, [0, 1], 'only its own tile’s button, once');
    assert.deepEqual(p.posts.map((m) => [m.kind, m.pageResult.clipped, m.pageResult.already]), [['data', true, false]]);

    const done = makePage(tiles('Clipped'), 'https://www.safeway.com/foru/coupons-deals.html');
    done.run(clipScript('c2', markers, { id: 'text:x', title: 'Oscar Mayer Wieners or Bacon' }, CLIP_BUTTONS, { intervalMs: 10 }));
    await sleep(40);
    assert.deepEqual(done.posts.map((m) => [m.pageResult.clipped, m.pageResult.already]), [[true, true]], 'found by its words; already clipped');

    const stuck = makePage(tiles('Clip Coupon'), 'https://www.safeway.com/foru/coupons-deals.html');
    stuck.run(clipScript('c3', markers, { id: '112', title: 'x' }, CLIP_BUTTONS, { settleMs: 40, intervalMs: 10 }));
    await sleep(120);
    assert.deepEqual(stuck.posts.map((m) => [m.kind, m.pageResult.clipped]), [['data', false]], 'the page never said so');

    const out = makePage(tiles('Sign In to Clip'), 'https://www.safeway.com/foru/coupons-deals.html');
    out.run(clipScript('c4', markers, { id: '112', title: 'x' }, CLIP_BUTTONS, { intervalMs: 10 }));
    const none = makePage(tiles('Clip Coupon'), 'https://www.safeway.com/foru/coupons-deals.html');
    none.run(clipScript('c5', markers, { id: '999', title: 'Nothing like it at all' }, CLIP_BUTTONS, { intervalMs: 5, maxTries: 3 }));
    await sleep(60);
    assert.deepEqual([out.posts.map((m) => m.error), none.posts.map((m) => m.error)], [['signed_out'], ['coupon_not_found']]);
  });

  await t('ads and coupons read on the store’s own lane, one page at a time, counted in its hour; log and live feed hear of it', async () => {
    const pool = new WebViewPool();
    const lane = pool.lane('kroger', 'Kroger');
    const loads: { url: string; script: string }[] = [];
    let answer: (url: string, script: string) => Record<string, unknown> | 'signin' = (url) =>
      url.includes('weeklyad')
        ? { kind: 'data', href: url, sources: [{ label: 'response https://dam.flippenterprise.net/x', text: JSON.stringify(FLYER) }], text: 'Prices valid 9/24 – 9/30', pageResult: { cards: [] }, usage: { bytes: 90000 }, store: 'Your store: Kroger Marketplace' }
        : { kind: 'data', href: url, sources: [{ label: 'response https://www.kroger.com/atlas/coupons', text: JSON.stringify(KROGER_COUPONS) }], text: '', pageResult: { cards: [] }, usage: { bytes: 40000 } };
    let last = -1;
    lane.subscribe(() => {
      const s = lane.getSnapshot();
      if (!s || s.phase !== 'hidden' || s.id === last) return;
      last = s.id;
      loads.push({ url: s.url, script: s.script });
      setTimeout(() => {
        const reply = answer(s.url, s.script);
        if (reply === 'signin') lane.allows('https://login.kroger.com/signin', true);
        else lane.receive(JSON.stringify({ nonce: nonceOf(s.script), ...reply }));
      }, 5);
    });
    const searcher = createRetailerSearch(pool, 'rules-ads');
    const entries: AttemptEntry[] = [];
    searcher.onAttempt((e) => entries.push(e));
    const kroger = BUNDLED_CONFIG.retailers.find((r) => r.id === 'kroger')!;
    const hour = politeness.used('kroger');

    const ad = await searcher.readAd(kroger, 'https://www.kroger.com/weeklyad/shoppable');
    assert.deepEqual([ad.items.length, ad.bytes, ad.url, ad.store?.name], [5, 90000, 'https://www.kroger.com/weeklyad/shoppable', 'Kroger Marketplace']);
    assert.match(loads[0].script, /__stretchList/);
    assert.equal(lane.getSnapshot(), null, 'the page isn’t kept');
    const list = await searcher.readCoupons(kroger);
    assert.deepEqual([list.coupons.length, list.url, loads[1].url], [4, 'https://www.kroger.com/savings/cl/coupons/', 'https://www.kroger.com/savings/cl/coupons/']);
    answer = () => ({ kind: 'data', href: 'u', pageResult: { clipped: true } });
    const clip = await searcher.clipCoupon(kroger, COUPONS[1]);
    assert.deepEqual(clip, { clipped: true });
    assert.match(loads[2].script, /__stretchClip/);
    assert.match(loads[2].script, /"id":"c2"/, 'that coupon');
    assert.equal(politeness.used('kroger'), hour + 3, 'each page counts toward the store’s hour');
    assert.deepEqual(entries.map((e) => [e.kind, e.ok, e.bytes, e.rules]), [['ad', true, 90000, 'rules-ads'], ['coupons', true, 40000, 'rules-ads'], ['clip', true, undefined, 'rules-ads']]);
    assert.deepEqual(pool.feed.getSnapshot().map((e) => `${e.retailer} · ${e.what} · ${e.text.replace(/\d+\.\d s/, 'N s')}`), [
      'Kroger · clip coupon · clipped · N s',
      'Kroger · coupons · 4 coupons, 3 clipped · N s',
      'Kroger · weekly ad · 5 sale items · N s · 90 KB',
    ]);

    answer = () => 'signin';
    await assert.rejects(searcher.readCoupons(kroger), (e: any) => e.reason === 'signed_out');
    assert.deepEqual([entries[3].kind, entries[3].ok, entries[3].reason], ['coupons', false, 'signed_out']);
    answer = () => ({ kind: 'data', href: 'u', text: 'Sign in to see your coupons', pageResult: { cards: [] } });
    await assert.rejects(searcher.readCoupons(kroger), (e: any) => e.reason === 'signed_out', 'a page asking to sign in, listing none');

    await assert.rejects(searcher.readAd(kroger, 'https://ads.example.org/weekly'), (e: any) => e.reason === 'other_site');
    const full = { ...kroger, id: 'busy-store', name: 'Busy' };
    for (let i = 0; i < politeness.perHour; i++) politeness.take('busy-store');
    const logged = entries.length;
    await assert.rejects(searcher.readAd(full, 'https://www.kroger.com/weeklyad/shoppable'), (e: any) => e.reason === 'polite_limit');
    assert.equal(entries.length, logged, 'a read that never went out isn’t in the log');
    assert.match(pool.feed.getSnapshot()[0].text, /^paused: 120 visits here in the last hour$/);
  });

  await t('ads, coupons and clips count toward a store’s hour, and not in its search health', () => {
    const at = 10 * HOUR;
    const entry = (kind: AttemptEntry['kind'], i: number): AttemptEntry => ({ at: at - 60_000 * (i + 1), retailerId: 'k', kind, ok: true, ms: 1 });
    const entries = (['ad', 'coupons', 'clip', 'search', 'fees'] as const).map(entry);
    const hour = new Politeness(120, () => at);
    hour.seed(entries);
    assert.equal(hour.used('k'), 4, 'not the fees page');
    const [row] = citizenReport(entries, 0);
    assert.deepEqual([row.searches, row.otherPages, row.busiestHour], [1, 4, 4]);
    assert.equal(storeHealth(entries, 'k', at).attempts, 1);
  });

  await t('store rules: each store’s ad and coupons are on its own site; a rules file’s are checked', () => {
    for (const r of BUNDLED_CONFIG.retailers) {
      for (const url of [r.ad?.url, r.ad?.storeUrl, r.coupons?.url]) {
        if (url) assert.ok(url.startsWith('https://') && onRetailerSite(r, url.replace(/\{\{\w+\}\}/g, '1')), `${r.id}: ${url}`);
      }
      assert.ok(isRetailerConfig(r), r.id);
    }
    const which = (id: string) => {
      const r = BUNDLED_CONFIG.retailers.find((x) => x.id === id)!;
      return [id, !!r.ad, !!r.coupons];
    };
    assert.deepEqual(['walmart', 'target', 'kroger', 'aldi', 'costco', 'traderjoes', 'wegmans', 'safeway', 'vons', 'ralphs'].map(which), [
      ['walmart', true, false], ['target', true, true], ['kroger', true, true], ['aldi', true, false], ['costco', true, false],
      ['traderjoes', false, false], ['wegmans', false, true], ['safeway', true, true], ['vons', true, true], ['ralphs', true, true],
    ]);
    const kroger = BUNDLED_CONFIG.retailers.find((r) => r.id === 'kroger')!;
    assert.equal(isRetailerConfig({ ...kroger, ad: { url: 'http://www.kroger.com/weeklyad' } }), false);
    assert.equal(isRetailerConfig({ ...kroger, coupons: { url: 'https://www.kroger.com/c', program: '' } }), false);
    assert.equal(rulesProblem({ version: 'v', retailers: [{ ...kroger, coupons: { url: 'https://www.kroger.com/c' } }] }), 'Store 1 (kroger) is missing a field, or has one of the wrong kind.');
    const safeway = BUNDLED_CONFIG.retailers.find((r) => r.id === 'safeway')!;
    assert.deepEqual([adTarget(safeway, { storeId: '', storeKey: '@0' }, ''), adTarget(safeway, { storeId: '1711', storeKey: '1711@0' }, '')], [
      { url: 'https://www.safeway.com/weeklyad', key: 'https://www.safeway.com/weeklyad @0' },
      { url: 'https://www.safeway.com/set-store.html?storeId=1711&target=weeklyad', key: 'https://www.safeway.com/set-store.html?storeId=1711&target=weeklyad 1711@0' },
    ], 'the store it’s set to, through its own set-store link');
  });

  log(`\n${passed} weekly ad and coupon tests passed`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
