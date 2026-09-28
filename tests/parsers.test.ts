/// <reference types="node" />
import assert from 'node:assert/strict';
import { excerpt, redactUrl } from '../src/onDevice/evidence';
import { searchViaFetch, StrategyError, buildRequest } from '../src/onDevice/fetchStrategy';
import { krogerEvidence, krogerProducts, searchKrogerApi } from '../src/onDevice/krogerApi';
import { autoDetect, extractNextDataText, looksChallenged, pageScriptProducts, parseMoney, walmartNextData } from '../src/onDevice/parsers';
import { describePage } from '../src/onDevice/pageSummary';
import { parseProductPage, plainText } from '../src/onDevice/productPage';
import { BUNDLED_CONFIG } from '../src/onDevice/retailers';
import { sameSite } from '../src/onDevice/webviewScript';

const walmart = BUNDLED_CONFIG.retailers.find((r) => r.id === 'walmart')!;
const item = (id: string, extra: Record<string, unknown> = {}) => ({
  __typename: 'Product', usItemId: id, name: `Milk ${id}`, canonicalUrl: `/ip/milk/${id}`,
  priceInfo: { currentPrice: { price: 3.12, priceString: '$3.12' }, unitPrice: { priceString: '2.4 ¢/fl oz' } },
  imageInfo: { thumbnailUrl: `https://img/${id}.jpg` }, availabilityStatusV2: { value: 'IN_STOCK' }, ...extra,
});
const page = (data: unknown, title = 'whole milk - Walmart.com') =>
  `<!doctype html><html><head><title>${title}</title></head><body><div id="root"></div><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(data)}</script></body></html>`;
const searchData = (items: unknown[]) => ({ props: { pageProps: { initialData: { searchResult: { itemStacks: [{ items }] } } } } });
const ctx = { retailer: 'test', storeId: '1234' };
let passed = 0;
const t = async (name: string, fn: () => unknown) => { await fn(); passed++; console.log('ok -', name); };

(async () => {
  // --- Walmart ---------------------------------------------------------------------------------
  await t('walmart: known path, dedupes, skips ad slots, keeps sponsored flag', () => {
    const r = walmartNextData({ html: page(searchData([item('1'), { __typename: 'AdPlaceholder' }, item('2', { isSponsoredFlag: true }), item('1')])) }, ctx);
    assert.equal(r.payloadFound, true);
    assert.deepEqual(r.products.map((p) => p.id), ['1', '2']);
    assert.equal(r.products[0].price, 3.12);
    assert.equal(r.products[0].unitPriceText, '2.4 ¢/fl oz');
    assert.equal(r.products[0].url, 'https://www.walmart.com/ip/milk/1');
    assert.equal(r.products[0].inStock, true);
    assert.equal(r.products[1].sponsored, true);
  });

  await t('walmart: tree walk when the path moves; empty search is found-but-empty; no data is not found', () => {
    const moved = walmartNextData({ html: page({ props: { pageProps: { newLayout: { tiles: [item('9'), item('8', { priceInfo: { linePrice: '$4.50' } })] } } } }) }, ctx);
    assert.deepEqual(moved.products.map((p) => [p.id, p.price]), [['9', 3.12], ['8', 4.5]]);
    const empty = walmartNextData({ html: page(searchData([])) }, ctx);
    assert.deepEqual([empty.payloadFound, empty.products.length], [true, 0]);
    assert.equal(walmartNextData({ html: '<html><title>Robot or human?</title></html>' }, ctx).payloadFound, false);
    assert.equal(walmartNextData({ nextDataText: '{broken' }, ctx).payloadFound, false);
  });

  // --- Auto-detect -----------------------------------------------------------------------------
  const targetLike = {
    data: { search: { products: [
      { tcin: '1', brand: { name: 'Good & Gather' }, item: { product_description: { title: 'Good & Gather Whole Milk, 1 gal' } },
        price: { current_retail: 3.49, formatted_current_price: '$3.49', reg_retail: 3.99 } },
      { tcin: '2', item: { product_description: { title: 'Horizon Organic Whole Milk, 0.5 gal' } }, price: { current_retail: 5.29, reg_retail: 5.29 } },
      { tcin: '3', item: { product_description: { title: 'Fairlife Whole Milk, 52 fl oz' } }, price: { current_retail: 4.99 } },
    ] } },
  };
  const recs = { recommendations: [{ id: 'r1', name: 'Cookies', price: 2.5 }] };

  await t('auto: finds a Target-style list, skips the brand name, prefers the current price', () => {
    const r = autoDetect({ sources: [{ label: 'response https://api.example.com/search?key=abc&q=milk', text: JSON.stringify(targetLike) }] }, ctx);
    assert.equal(r.payloadFound, true);
    assert.deepEqual(r.products.map((p) => [p.id, p.name, p.price]), [
      ['1', 'Good & Gather Whole Milk, 1 gal', 3.49],
      ['2', 'Horizon Organic Whole Milk, 0.5 gal', 5.29],
      ['3', 'Fairlife Whole Milk, 52 fl oz', 4.99],
    ]);
    assert.equal(r.products[0].priceText, '$3.49');
    assert.equal(r.source, 'response https://api.example.com/search (3)');
  });

  await t('auto: picks the biggest list across sources', () => {
    const r = autoDetect({ sources: [
      { label: 'response https://x/recs', text: JSON.stringify(recs) },
      { label: 'response https://x/search', text: JSON.stringify(targetLike) },
    ] }, ctx);
    assert.equal(r.products.length, 3);
    assert.match(r.source ?? '', /x\/search \(3\)/);
  });

  await t('auto: JSON-LD ItemList with offers', () => {
    const ld = { '@context': 'https://schema.org', '@type': 'ItemList', itemListElement: [
      { '@type': 'ListItem', position: 1, item: { '@type': 'Product', name: 'Milk A', sku: 'a', offers: { '@type': 'Offer', price: '3.29', priceCurrency: 'USD' } } },
      { '@type': 'ListItem', position: 2, item: { '@type': 'Product', name: 'Milk B', sku: 'b', offers: { price: 2.79 } } },
    ] };
    const html = `<html><head><script type="application/ld+json">${JSON.stringify(ld)}</script></head><body></body></html>`;
    const r = autoDetect({ html, href: 'https://shop.example.com/search?q=milk' }, ctx);
    assert.deepEqual(r.products.map((p) => [p.id, p.name, p.price]), [['a', 'Milk A', 3.29], ['b', 'Milk B', 2.79]]);
    assert.equal(r.source, 'ld+json (2)');
  });

  await t('auto: normalized cache maps, cents fields, sale over regular, ids never read as prices', () => {
    const cache: Record<string, unknown> = { ROOT_QUERY: { search: 'x' } };
    for (let i = 1; i <= 5; i++) cache[`Item:${i}`] = { id: `i${i}`, name: `Oat milk ${i}`, priceInCents: 300 + i, image: { url: `https://img/${i}.png` } };
    const r = autoDetect({ sources: [{ label: '__APOLLO_STATE__', text: JSON.stringify(cache) }] }, ctx);
    assert.equal(r.products.length, 5);
    assert.deepEqual([r.products[0].price, r.products[0].imageUrl], [3.01, 'https://img/1.png']);

    const r2 = autoDetect({ sources: [{ label: 'x', text: JSON.stringify({ list: [
      { productId: 'p1', productName: 'Milk', regularPrice: 4.99, salePrice: 3.99, url: '/p/milk' },
      { productId: 'p2', productName: 'Eggs', pricing: { currencyId: 840, amount: 2.99 }, availability: 'OUT_OF_STOCK' },
    ] }) }], href: 'https://www.example.com/s?q=milk' }, ctx);
    assert.deepEqual(r2.products.map((p) => [p.name, p.price]), [['Milk', 3.99], ['Eggs', 2.99]]);
    assert.equal(r2.products[0].url, 'https://www.example.com/p/milk');
    assert.equal(r2.products[1].inStock, false);
  });

  await t('auto: also reads Walmart-style page data; nothing product-shaped is not found', () => {
    const r = autoDetect({ nextDataText: JSON.stringify(searchData([item('5'), item('6')])) }, ctx);
    assert.deepEqual(r.products.map((p) => [p.id, p.price]), [['5', 3.12], ['6', 3.12]]);
    const none = autoDetect({ sources: [{ label: 'x', text: JSON.stringify({ menu: [{ name: 'Home', url: '/' }, { name: 'Deals', url: '/deals' }] }) }] }, ctx);
    assert.equal(none.payloadFound, false);
  });

  // --- Kroger API mapping (response shape from Kroger's Products API docs) ------------------------
  const krogerDoc = { data: [
    { productId: '0001111041700', productPageURI: '/p/kroger-2-reduced-fat-milk/0001111041700?cid=dis.api', brand: 'Kroger', description: 'Kroger 2% Reduced Fat Milk',
      images: [{ perspective: 'front', default: true, sizes: [{ size: 'medium', url: 'https://www.kroger.com/product/images/medium/front/0001111041700' }] }],
      items: [{ itemId: '0001111041700', inventory: { stockLevel: 'HIGH' }, price: { regular: 1.99, promo: 1.59 }, size: '1 gal', soldBy: 'unit' }], upc: '0001111041700' },
    { productId: '2', description: 'Kroger Whole Milk', items: [{ price: { regular: 2.29, promo: 0 }, inventory: { stockLevel: 'TEMPORARILY_OUT_OF_STOCK' } }] },
  ], meta: {} };

  await t('kroger: maps the documented response; a promo below the regular price is the price with the card', async () => {
    const p = krogerProducts(krogerDoc, '01400943');
    assert.deepEqual(p.map((x) => [x.name, x.price, x.memberPrice, x.memberLabel]), [
      ['Kroger 2% Reduced Fat Milk, 1 gal', 1.99, 1.59, 'with Card'],
      ['Kroger Whole Milk', 2.29, undefined, undefined],
    ]);
    const ralphs = krogerProducts(krogerDoc, '70300022', 'ralphs', 'www.ralphs.com');
    assert.deepEqual([ralphs[0].retailer, ralphs[0].url], ['ralphs', 'https://www.ralphs.com/p/kroger-2-reduced-fat-milk/0001111041700'], 'a chain Kroger runs');
    assert.equal(p[0].url, 'https://www.kroger.com/p/kroger-2-reduced-fat-milk/0001111041700');
    assert.equal(p[0].imageUrl, 'https://www.kroger.com/product/images/medium/front/0001111041700');
    assert.deepEqual([p[0].inStock, p[1].inStock], [true, false]);
    await assert.rejects(searchKrogerApi('milk', '45202', 1000), (e: unknown) => e instanceof StrategyError && e.reason === 'api_not_configured');
  });

  // --- Helpers & config ----------------------------------------------------------------------------
  await t('helpers and bundled config', () => {
    assert.equal(parseMoney('$1,299.99'), 1299.99);
    assert.equal(parseMoney('$2.47 - $3.10'), undefined);
    assert.equal(extractNextDataText('<script id="__NEXT_DATA__" type="application/json">{"a":1}</script>'), '{"a":1}');
    assert.equal(looksChallenged(walmart.challengeMarkers, 'https://www.walmart.com/blocked?url=x'), true);
    assert.equal(looksChallenged(walmart.challengeMarkers, 'https://www.walmart.com/search?q=milk', '<html>ok</html>'), false);
    assert.equal(sameSite('https://i5.walmartimages.com/x', 'https://www.walmart.com/search?q=a'), false);
    assert.equal(sameSite('https://evilwalmart.com/', 'https://www.walmart.com/search?q=a'), false);
    const req = buildRequest({ ...walmart, cookieTemplate: 'storeCookie={{storeId}}; other=1' }, '  whole milk ', '5260');
    assert.deepEqual(req, { url: 'https://www.walmart.com/search?q=whole%20milk', cookie: 'storeCookie=5260; other=1' });
    const ids = BUNDLED_CONFIG.retailers.map((r) => r.id);
    assert.equal(new Set(ids).size, ids.length, 'unique ids');
    assert.ok(ids.length >= 13);
    for (const r of BUNDLED_CONFIG.retailers) {
      assert.ok(r.searchUrl.startsWith('https://') && r.searchUrl.includes('{{query}}'), r.id);
      assert.ok(r.homeUrl.startsWith('https://'), r.id);
      assert.ok(r.parser in { walmartNextData: 1, autoDetect: 1, pageScriptProducts: 1 }, r.id);
    }
  });

  await t('pageScript parser validates items', () => {
    const r = pageScriptProducts({ pageResult: [{ id: 'a', name: 'Eggs', priceText: '$2.99' }, { id: 'b' }, 'junk'] }, ctx);
    assert.deepEqual(r.products.map((p) => [p.id, p.price]), [['a', 2.99]]);
  });

  // --- Fetch strategy with a mocked fetch -----------------------------------------------------------
  const realFetch = globalThis.fetch;
  const mockFetch = (body: string, init: { status?: number; url?: string } = {}) => {
    const calls: any[] = [];
    globalThis.fetch = (async (url: string, opts: any) => {
      calls.push({ url, opts });
      return { status: init.status ?? 200, ok: (init.status ?? 200) < 400, url: init.url ?? url, text: async () => body } as any;
    }) as any;
    return calls;
  };

  await t('fetch: success sends the Cookie header, omits the shared jar, reports its source', async () => {
    const calls = mockFetch(page(searchData([item('7')])));
    const r = await searchViaFetch({ ...walmart, cookieTemplate: 'storeCookie={{storeId}}' }, 'milk', '5260');
    assert.deepEqual([r.products.map((p) => p.id), r.source], [['7'], 'next-data']);
    assert.equal(calls[0].opts.headers.Cookie, 'storeCookie=5260');
    assert.equal(calls[0].opts.credentials, 'omit');
  });

  await t('fetch: block page, unknown page, HTTP error and timeout each report their reason', async () => {
    mockFetch('<html><head><title>Robot or human?</title></head><body><div id="px-captcha"></div></body></html>', { url: 'https://www.walmart.com/blocked?url=L3NlYXJjaA==' });
    await assert.rejects(searchViaFetch(walmart, 'milk', ''), (e: any) => e.reason === 'challenge');
    mockFetch(`<html><body>${'<p>Our site is down for maintenance.</p>'.repeat(60)}</body></html>`);
    await assert.rejects(searchViaFetch(walmart, 'milk', ''), (e: any) => e.reason === 'no_payload');
    mockFetch('<html>maintenance</html>');
    await assert.rejects(searchViaFetch(walmart, 'milk', ''), (e: any) => e.reason === 'tiny_page', 'nearly empty, and no product data: a quiet block, often');
    mockFetch('<html><head><title>Access Denied</title></head><body>You don’t have permission to access this server. Reference #18</body></html>', { status: 403 });
    await assert.rejects(searchViaFetch(walmart, 'milk', ''), (e: any) => e.reason === 'blocked' && e.status === 403 && /“Access Denied”/.test(e.detail), 'a block, not a bot check');
    mockFetch('<html>nope</html>', { status: 503 });
    await assert.rejects(searchViaFetch(walmart, 'milk', ''), (e: any) => e.reason === 'http_503');
    globalThis.fetch = ((_u: string, opts: any) => new Promise((_res, rej) => opts.signal.addEventListener('abort', () => rej(new Error('aborted'))))) as any;
    await assert.rejects(searchViaFetch({ ...walmart, timeoutMs: 50 }, 'milk', ''), (e: any) => e.reason === 'timeout');
  });
  globalThis.fetch = realFetch;

  // --- Sale prices ----------------------------------------------------------------------------------------
  await t('sales: Walmart’s was price, the general reader’s regular or full price; Kroger’s promo is a member price', () => {
    const onSale = walmartNextData({ html: page(searchData([
      item('3', { priceInfo: { currentPrice: { price: 2.5, priceString: '$2.50' }, wasPrice: { price: 3.12, priceString: '$3.12' } } }),
      item('4', { priceInfo: { currentPrice: { price: 2.5 }, wasPrice: { price: 2.5 } } }),
    ])) }, ctx);
    assert.deepEqual(onSale.products.map((p) => p.wasPrice), [3.12, undefined]);

    const target = autoDetect({ sources: [{ label: 'x', text: JSON.stringify({ products: [
      { tcin: '1', title: 'Whole Milk', price: { current_retail: 3.99, reg_retail: 4.49, formatted_current_price: '$3.99' } },
      { tcin: '2', title: 'Eggs', price: { current_retail: 2.99, reg_retail: 2.99 } },
    ] }) }] }, ctx);
    assert.deepEqual(target.products.map((p) => [p.price, p.wasPrice]), [[3.99, 4.49], [2.99, undefined]]);

    const instacart = autoDetect({ sources: [{ label: 'x', text: JSON.stringify({ items: [
      { id: 'a', name: 'Butter', price: { viewSection: { priceString: '$3.49', fullPriceString: '$4.29' } } },
    ] }) }] }, ctx);
    assert.deepEqual([instacart.products[0].price, instacart.products[0].wasPrice], [3.49, 4.29]);

    const kroger = krogerProducts(krogerDoc, '01400943');
    assert.deepEqual(kroger.map((p) => [p.wasPrice, p.memberPrice]), [[undefined, 1.59], [undefined, undefined]], 'on sale only with the card');
  });

  await t('barcodes: read wherever a store labels one (upc, gtin13, primary_barcode), as digits only', () => {
    const r = autoDetect({ sources: [{ label: 'x', text: JSON.stringify({ products: [
      { tcin: '1', title: 'Heinz Ketchup', price: { current_retail: 3.49 }, item: { primary_barcode: '013000006408' } },
      { id: '2', name: 'Milk', price: 3, upc: 16000275287 },
      { id: '3', name: 'Eggs', price: 2, gtin13: 'n/a' },
    ] }) }] }, ctx);
    assert.deepEqual(r.products.map((p) => p.gtin), ['013000006408', '16000275287', undefined]);
    assert.equal(krogerProducts(krogerDoc, '01400943')[0].gtin, '0001111041700');
  });

  // --- Product pages --------------------------------------------------------------------------------------
  await t('product page: schema.org data first, the page’s own data and share tags fill the gaps', () => {
    const product = { retailer: 'walmart', storeId: '', id: '10450114', name: 'Great Value Whole Milk, 1 gal', price: 3.48, imageUrl: 'https://i/1.jpg?w=80' };
    const ld = { '@context': 'https://schema.org', '@graph': [
      { '@type': 'BreadcrumbList', itemListElement: [] },
      { '@type': 'Product', name: 'Other Milk', sku: 'zzz', image: 'https://i/other.jpg' },
      { '@type': 'Product', name: 'Great Value Whole Milk, 1 Gallon', sku: '10450114', gtin13: '0078742351865',
        image: ['https://i/1.jpg', 'https://i/2.jpg'], description: '<p>Fresh <b>whole</b> milk&amp; more.</p><ul><li>Vitamin D</li></ul>',
        brand: { '@type': 'Brand', name: 'Great Value' },
        offers: { '@type': 'Offer', price: '3.48', availability: 'https://schema.org/InStock' },
        aggregateRating: { ratingValue: '4.6', reviewCount: '1234' } },
    ] };
    const data = { item: { usItemId: '10450114', ingredients: { text: 'nope' }, ingredientsText: 'Milk, Vitamin D3', bullets: ['Grade A', '<b>Pasteurized</b>'],
      images: [{ url: '/img/3.jpg' }, { url: 'https://i/2.jpg?w=500' }], size: '1 gal' } };
    const d = parseProductPage({ href: 'https://www.walmart.com/ip/10450114', sources: [
      { label: 'meta', text: JSON.stringify({ 'og:image': 'https://i/og.jpg', 'og:description': 'A gallon of whole milk from Great Value, fresh every day.' }) },
      { label: 'ld+json', text: JSON.stringify(ld) },
      { label: 'response https://www.walmart.com/orchestra/pdp', text: JSON.stringify(data) },
    ] }, product);
    assert.deepEqual(d.images, ['https://i/2.jpg', 'https://www.walmart.com/img/3.jpg', 'https://i/og.jpg'], 'the listing photo isn’t repeated');
    assert.equal(d.description, 'Fresh whole milk& more.\n• Vitamin D');
    assert.deepEqual([d.brand, d.gtin, d.price, d.inStock, d.rating], ['Great Value', '0078742351865', 3.48, true, { value: 4.6, count: 1234 }]);
    assert.deepEqual([d.ingredients, d.highlights, d.size], ['Milk, Vitamin D3', ['Grade A', 'Pasteurized'], '1 gal']);
    assert.deepEqual(d.sources, ['the structured data the store publishes', 'the page’s own data', 'the page’s share tags']);
    assert.equal(d.count, 10);
  });

  await t('product page: a page with nothing about the product says so', () => {
    const d = parseProductPage({ href: 'https://x.com/p/1', sources: [{ label: 'meta', text: '{}' }] }, { retailer: 'x', storeId: '', id: '1', name: 'Milk', price: 1 });
    assert.deepEqual([d.count, d.images, d.sources], [0, [], []]);
    assert.equal(plainText('<div>A&nbsp;b</div><br/>c &lt;3'), 'A b\nc <3');
  });

  await t('page summary: what a page showed when it had no products, without query strings', () => {
    assert.equal(
      describePage({ title: ' Kroger ', sources: [] }, 'Kroger'),
      'Kroger showed “Kroger”, but no product data arrived. Its product requests may have been blocked, or it may need a store chosen first.',
    );
    const summary = describePage(
      { sources: [{ label: 'response https://a.example.com/x?key=secret', text: 'x'.repeat(3000) }, { label: 'response https://b.example.com/y', text: '{}' }, { label: 'ld+json', text: '{}' }] },
      'Target',
    );
    assert.equal(summary, 'Target showed its page and loaded 2 data responses, but none listed products with prices. Largest: a.example.com/x (3 KB).');
  });

  await t('member prices: kept apart from what everyone pays, and named as the store names them', () => {
    const r = autoDetect({ sources: [{ label: 'x', text: JSON.stringify({ products: [
      { id: '1', name: 'Whole Milk', price: 3.99, clubPrice: 2.99 },
      { id: '2', name: 'Eggs', price: { current: 4.49, withCardPrice: 3.99 } },
      { id: '3', name: 'Bread', price: 2.49, memberPrice: 2.99 },
      { id: '4', name: 'Jam', price: 3.29 },
    ] }) }] }, ctx);
    assert.deepEqual(r.products.map((p) => [p.price, p.memberPrice, p.memberLabel]), [
      [3.99, 2.99, 'Club Price'],
      [4.49, 3.99, 'with Card'],
      [2.49, undefined, undefined],
      [3.29, undefined, undefined],
    ], 'a member price above the price isn’t a deal');
  });

  // --- Price X-ray ---------------------------------------------------------------------------------------
  await t('Whole Foods: prices under offerDetails, the basis price as the regular one, the Prime price apart, the ASIN as the id', () => {
    // As its search page's data had them (2026-09-28), trimmed.
    const offer = (price: number, basis: number | null, prime: number | null) => ({
      price: { currencyCode: 'USD', priceAmount: price, basisPriceAmount: basis, savings: { currencyCode: 'USD', savingsAmount: basis ? +(basis - price).toFixed(2) : null, percentSavings: '6%' },
        primeBenefit: { isApplied: false, text: 'Join Prime to buy this item at ', currencyCode: 'USD', priceAmount: prime, savingsAmount: prime ? +(price - prime).toFixed(2) : null } },
      unitPrice: { baseUnit: 'count', currencyCode: 'USD', priceAmount: price },
      offerListingId: 'jQiR3', availability: 'IN_STOCK',
    });
    const data = { props: { pageProps: {
      programType: 'GROCERY',
      productsInfo: [
        { brandName: 'Organic Valley', name: 'Organic Valley Organic Whole Milk, 64 oz', asin: 'B000O6K8TI', productImages: ['https://m.media-amazon.com/images/I/71V8yVZRLSL.jpg'], availability: 'IN_STOCK', offerDetails: offer(5.65, 5.99, 5.09) },
        { brandName: '365 by Whole Foods Market', name: '365 by Whole Foods Market Whole Milk, 1 GL', asin: 'B074V3XKVV', productImages: [], availability: 'IN_STOCK', offerDetails: offer(4.39, null, null) },
        { brandName: 'Horizon', name: 'Horizon Organic Whole Milk, 64 oz', asin: 'B00032G1S0', productImages: [], availability: 'OUT_OF_STOCK', offerDetails: offer(6.49, null, null) },
      ],
      wfmccLocationData: { cateringStoreContext: { almAttributes: { storeId: '10214', offerListingDiscriminator: 'A0BP' } } },
    } } };
    const r = autoDetect({ nextDataText: JSON.stringify(data), href: 'https://www.wholefoodsmarket.com/grocery/search?k=milk' }, { retailer: 'wholefoods', storeId: '10214', query: 'milk' });
    assert.deepEqual(
      r.products.map((p) => [p.id, p.price, p.wasPrice, p.memberPrice, p.memberLabel, p.inStock]),
      [
        ['B000O6K8TI', 5.65, 5.99, 5.09, 'Prime member deal', true],
        ['B074V3XKVV', 4.39, undefined, undefined, undefined, true],
        ['B00032G1S0', 6.49, undefined, undefined, undefined, false],
      ],
      'not the 34¢ it saves, nor the price per count',
    );
    // A saving is never the price, even where it sits nearer the product than the price does.
    const saved = autoDetect({ nextDataText: JSON.stringify({ items: [1, 2, 3].map((i) => ({ id: `s${i}`, name: `Milk ${i}`, savingsAmount: 0.5, price: { amount: 3 + i } })) }) }, ctx);
    assert.deepEqual(saved.products.map((p) => p.price), [4, 5, 6]);
  });

  await t('x-ray: each product keeps the store’s own data for it, and the path to its price', () => {
    const target = autoDetect({ sources: [{ label: 'response https://redsky.target.com/x', text: JSON.stringify({ products: [
      { tcin: '1', title: 'Whole Milk', price: { current_retail: 3.99, reg_retail: 4.49 } },
      { tcin: '2', title: 'Eggs', price: { current_retail: 2.99 } },
    ] }) }] }, ctx);
    assert.equal(target.evidence?.['1'].pricePath, 'price.current_retail');
    assert.deepEqual(JSON.parse(target.evidence!['1'].json), { tcin: '1', title: 'Whole Milk', price: { current_retail: 3.99, reg_retail: 4.49 } });
    const walmart = walmartNextData({ html: page(searchData([item('3', { priceInfo: { currentPrice: { price: 2.5 } } })])) }, ctx);
    assert.equal(walmart.evidence?.['3'].pricePath, 'priceInfo.currentPrice.price');
    assert.equal(krogerEvidence(krogerDoc)['0001111041700'].pricePath, 'items.0.price.regular');

    const { lines, highlight } = excerpt({ ...target.evidence!['1'], price: 3.99 });
    assert.match(lines[highlight], /"current_retail": 3\.99/, 'the line with the price is the one highlighted');
    assert.equal(
      redactUrl('https://redsky.target.com/plp_search_v2?key=9f36aeafbe60771e321a7cc95a78140772ab3e96&keyword=milk&visitor_id=0192A&pricing_store_id=1340'),
      'https://redsky.target.com/plp_search_v2?key=…&keyword=milk&visitor_id=…&pricing_store_id=1340',
    );
    assert.equal(redactUrl('https://api.kroger.com/v1/products?filter.term=milk'), 'https://api.kroger.com/v1/products?filter.term=milk');
  });

  console.log(`\n${passed} parser and strategy tests passed`);
})().catch((e) => { console.error(e); process.exit(1); });
