/// <reference types="node" />
import assert from 'node:assert/strict';

// krogerApi reads its credentials when it loads, so set them before importing it.
process.env.EXPO_PUBLIC_KROGER_CLIENT_ID = 'test-id';
process.env.EXPO_PUBLIC_KROGER_CLIENT_SECRET = 'test-secret';

const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
let passed = 0;
const t = async (name: string, fn: () => unknown) => { await fn(); passed++; console.log('ok -', name); };

(async () => {
  const { CERTIFICATION_NOTE, krogerEnvironment, krogerStoresNear, resetKrogerApi, searchKrogerApi, warmUpKroger } = await import('../src/onDevice/krogerApi');
  const calls: string[] = [];
  globalThis.fetch = (async (url: string) => {
    calls.push(url);
    await new Promise((r) => setTimeout(r, 10));
    if (url.includes('/connect/oauth2/token')) return json({ access_token: 'token', expires_in: 1800 });
    if (url.includes('/locations')) {
      return json({ data: [{ locationId: '01400943', name: 'Kroger', address: { addressLine1: '1014 Vine St', city: 'Cincinnati', state: 'OH', zipCode: '45202' } }] });
    }
    return json({ data: [{ productId: '1', description: 'Kroger Whole Milk', items: [{ price: { regular: 2.49 } }] }] });
  }) as typeof fetch;

  await t('kroger: searches started together share one sign-in and one store lookup per ZIP', async () => {
    const results = await Promise.all(['milk', 'eggs', 'bread', 'jam'].map((q) => searchKrogerApi(q, '45202', 1000)));
    const count = (part: string) => calls.filter((u) => u.includes(part)).length;
    assert.deepEqual([count('/connect/oauth2/token'), count('/locations'), count('/products')], [1, 1, 4]);
    assert.deepEqual(results[0].store, { name: 'Kroger', address: '1014 Vine St, Cincinnati, OH 45202', id: '01400943' }, 'which store, for Your stores');
    assert.equal(results[0].products[0].price, 2.49);
    assert.ok(calls.filter((u) => u.includes('/products')).every((u) => u.includes('filter.limit=20')));
    assert.deepEqual(
      [krogerEnvironment(), results[0].note, calls.every((u) => u.startsWith('https://api.kroger.com/v1/'))],
      ['production', undefined, true],
      'production keys: production, as before',
    );

    await searchKrogerApi('rice', '45202', 1000);
    assert.deepEqual([count('/connect/oauth2/token'), count('/locations')], [1, 1], 'both reused later too');
  });

  await t('kroger: a barcode is looked up as the product it is, then searched as text if that finds nothing', async () => {
    calls.length = 0;
    const byId = await searchKrogerApi('011110417007', '45202', 1000);
    assert.ok(calls.some((u) => u.includes('filter.productId=0001111041700')), 'the UPC-A as Kroger’s id');
    assert.equal(calls.filter((u) => u.includes('filter.term=')).length, 0);
    assert.ok(byId.bytes > 0, 'counts the data it used');
    globalThis.fetch = (async (url: string) => {
      calls.push(url);
      return json(url.includes('productId') ? { data: [] } : { data: [{ productId: '9', description: 'Something', items: [{ price: { regular: 1 } }] }] });
    }) as typeof fetch;
    calls.length = 0;
    const byTerm = await searchKrogerApi('012345678905', '45202', 1000);
    assert.deepEqual([calls.length, byTerm.products[0].id], [2, '9']);
  });

  await t('kroger: its stores near a ZIP, within the radius, with their places on the map', async () => {
    const asked: string[] = [];
    globalThis.fetch = (async (url: string) => {
      asked.push(url);
      if (url.includes('/connect/oauth2/token')) return json({ access_token: 'token', expires_in: 1800 });
      return json({
        data: [
          { locationId: '01400943', name: 'Kroger On Vine', address: { addressLine1: '1014 Vine St', city: 'Cincinnati', state: 'OH', zipCode: '45202' }, geolocation: { latitude: 39.1086, longitude: -84.5153 } },
          { name: 'No number' },
        ],
      });
    }) as typeof fetch;
    const stores = await krogerStoresNear('45202', 7.6, 1000);
    const locations = asked.find((u) => u.includes('/locations'))!;
    assert.ok(locations.includes('filter.zipCode.near=45202') && locations.includes('filter.radiusInMiles=8'), locations);
    assert.deepEqual(stores, [{ id: '01400943', name: 'Kroger On Vine', address: '1014 Vine St, Cincinnati, OH 45202', lat: 39.1086, lng: -84.5153 }]);
  });

  await t('kroger: certification keys: production refuses them, certification takes them, and its results say so', async () => {
    resetKrogerApi();
    const asked: string[] = [];
    const refused = { ok: false, status: 401, json: async () => ({ error: 'invalid_client' }) };
    globalThis.fetch = (async (url: string) => {
      asked.push(url);
      if (url.includes('/connect/oauth2/token')) return url.startsWith('https://api.kroger.com/') ? refused : json({ access_token: 'ce-token', expires_in: 1800 });
      if (url.includes('/locations')) return json({ data: [{ locationId: '01400943', name: 'Kroger' }] });
      return json({ data: [{ productId: '1', description: 'Kroger Whole Milk', items: [{ price: { regular: 2.49 } }] }] });
    }) as typeof fetch;
    const got = await searchKrogerApi('milk', '45202', 1000);
    assert.deepEqual([krogerEnvironment(), got.note, got.products[0].price], ['certification', CERTIFICATION_NOTE, 2.49]);
    assert.ok(asked.filter((u) => !u.includes('/connect/')).every((u) => u.startsWith('https://api-ce.kroger.com/v1/')), 'its stores and products asked there too');
    await searchKrogerApi('eggs', '45202', 1000);
    assert.equal(asked.filter((u) => u.startsWith('https://api.kroger.com/')).length, 1, 'production isn’t asked again');

    // Keys neither takes: production's refusal is the reason given.
    resetKrogerApi();
    globalThis.fetch = (async () => refused) as unknown as typeof fetch;
    await assert.rejects(searchKrogerApi('milk', '45202', 1000), (e: any) => e.reason === 'kroger_auth_http_401');
    assert.equal(krogerEnvironment(), null);

    // No connection isn't a refusal: certification isn't tried.
    resetKrogerApi();
    const tried: string[] = [];
    globalThis.fetch = (async (url: string) => {
      tried.push(url);
      throw new Error('offline');
    }) as typeof fetch;
    await assert.rejects(searchKrogerApi('milk', '45202', 1000), (e: any) => e.reason === 'kroger_auth_network');
    assert.equal(tried.length, 1);
  });

  await t('kroger: warmed up before the first search, which then only asks for products; a failed warm-up is left to it', async () => {
    resetKrogerApi();
    const asked: string[] = [];
    globalThis.fetch = (async (url: string) => {
      asked.push(url);
      if (url.includes('/connect/oauth2/token')) return json({ access_token: 'token', expires_in: 1800 });
      if (url.includes('/locations')) return json({ data: [{ locationId: '01400943', name: 'Kroger' }] });
      return json({ data: [{ productId: '1', description: 'Kroger Whole Milk', items: [{ price: { regular: 2.49 } }] }] });
    }) as typeof fetch;
    await warmUpKroger('45202', 1000);
    assert.deepEqual(asked.map((u) => u.replace(/\?.*$/, '').replace('https://api.kroger.com/v1', '')), ['/connect/oauth2/token', '/locations']);
    asked.length = 0;
    await searchKrogerApi('milk', '45202', 1000);
    assert.deepEqual(asked.map((u) => u.replace(/\?.*$/, '').replace('https://api.kroger.com/v1', '')), ['/products']);
    asked.length = 0;
    await warmUpKroger('01400943', 1000);
    assert.equal(asked.length, 0, 'a locationId needs no lookup, and the sign-in is kept');

    resetKrogerApi();
    globalThis.fetch = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    await warmUpKroger('45202', 1000);
    assert.equal(krogerEnvironment(), null, 'nothing kept; the first search tries again');
  });

  await t('kroger: a busy answer (502 to 504) is asked again once, after a moment; other errors and a second one count', async () => {
    const { RETRY_AFTER_MS } = await import('../src/onDevice/krogerApi');
    resetKrogerApi();
    const busy = (status: number) => ({ ok: false, status, json: async () => ({}) });
    let answers: number[] = [];
    const asked: number[] = [];
    globalThis.fetch = (async (url: string) => {
      if (url.includes('/connect/oauth2/token')) return json({ access_token: 'token', expires_in: 1800 });
      if (url.includes('/locations')) return json({ data: [{ locationId: '01400943', name: 'Kroger' }] });
      asked.push(Date.now());
      const status = answers.shift() ?? 200;
      return status === 200 ? json({ data: [{ productId: '1', description: 'Kroger Whole Milk', items: [{ price: { regular: 2.49 } }] }] }) : busy(status);
    }) as typeof fetch;

    answers = [503];
    const got = await searchKrogerApi('milk', '45202', 1000);
    assert.deepEqual([got.products[0].price, asked.length], [2.49, 2], 'the second ask worked');
    assert.ok(asked[1] - asked[0] >= RETRY_AFTER_MS - 20, 'after a moment');

    asked.length = 0;
    answers = [503, 503];
    await assert.rejects(searchKrogerApi('eggs', '45202', 1000), (e: any) => e.reason === 'kroger_products_http_503');
    assert.equal(asked.length, 2, 'asked again once, not more');

    asked.length = 0;
    answers = [500];
    await assert.rejects(searchKrogerApi('bread', '45202', 1000), (e: any) => e.reason === 'kroger_products_http_500');
    assert.equal(asked.length, 1, 'an error that isn’t "busy" isn’t asked again');
  });

  console.log(`\n${passed} Kroger API tests passed`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
