/// <reference types="node" />
import assert from 'node:assert/strict';
import type { GroceryList } from '../src/lists/types';
import { SearchFailed } from '../src/onDevice/retailerSearch';
import { BUNDLED_CONFIG } from '../src/onDevice/retailers';
import type { Product, RetailerConfig, SearchOutcome } from '../src/onDevice/types';
import { basketFor, bestSplit, defaultPick, driveCosts, driveVerdict, lineFor, rankBaskets, stretchPick, type ItemResult } from '../src/pricing/basket';
import { PriceCache } from '../src/pricing/priceCache';
import { PricingEngine, type StoreChoice } from '../src/pricing/pricingEngine';
import { AppStore, type KeyValueStore } from '../src/state/appStore';

const cfg = (id: string): RetailerConfig => ({ ...BUNDLED_CONFIG.retailers.find((r) => r.id === 'target')!, id, name: id.toUpperCase() });
// The basket tests' products are named after the items they stand for, so they pass as those items (matching.ts
// has its own tests in features.test.ts).
const NAMES: Record<string, string> = { m: 'Whole Milk', e: 'Large Eggs', b: 'White Bread', j: 'Strawberry Jam' };
const p = (id: string, price: number | null, extra: Partial<Product> = {}): Product => ({ retailer: 'x', storeId: '', id, name: NAMES[id] ?? `Product ${id}`, price, ...extra });
const done = (...products: Product[]): ItemResult => ({ status: 'done', products });
const list = (...names: string[]): GroceryList => ({
  id: 'L', name: 'Test', trip: null, createdAt: 0, updatedAt: 0,
  items: names.map((name, i) => ({ id: `i${i}`, name, qty: 1, checked: false })),
});
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
const t = async (name: string, fn: () => unknown) => { await fn(); passed++; console.log('ok -', name); };

(async () => {
  // --- Basket ----------------------------------------------------------------------------------------
  await t('the default pick is the top result worth buying: no ads, nothing out of stock or unpriced', () => {
    assert.equal(defaultPick([p('ad', 1, { sponsored: true }), p('oos', 2, { inStock: false }), p('np', null), p('ok', 4), p('next', 3)]), 3);
    assert.equal(defaultPick([p('ad', 1, { sponsored: true })]), -1);
    assert.equal(defaultPick([{ ...p('broken', 0), price: undefined as unknown as null }, p('nan', Number.NaN), p('ok', 2)]), 2, 'a missing price is never free');
  });

  await t('a line uses the user’s usual when it’s still in the results; alternatives are the other priced results', () => {
    const item = { id: 'i', name: 'Milk', qty: 2, checked: false };
    const milk = (id: string, price: number | null, extra: Partial<Product> = {}) => p(id, price, { name: `Milk ${id}`, ...extra });
    const line = lineFor(item, 's', done(milk('a', 3), milk('b', 4), milk('c', null), milk('d', 5)), 'b');
    assert.deepEqual([line.status, line.product?.id, line.lineTotal, line.alternatives.map((x) => x.id), line.usual], ['found', 'b', 8, ['a', 'd'], true]);
    const gone = lineFor(item, 's', done(milk('a', 3)), 'zzz');
    assert.deepEqual([gone.product?.id, gone.usual], ['a', false], 'falls back to the top result');
    assert.equal(lineFor(item, 's', done(milk('ad', 1, { sponsored: true }))).status, 'missing');
    assert.equal(lineFor(item, 's', { status: 'searching', products: [] }).status, 'pending');
    assert.equal(lineFor(item, 's', { status: 'failed', products: [] }).status, 'failed');
    assert.equal(lineFor(item, 's', undefined).status, 'pending');
  });

  await t('a line skips results that aren’t the item, and says so when none of them is', () => {
    const item = { id: 'i', name: 'Avocado', qty: 1, checked: false };
    const warmers = p('w', 3, { name: 'Dark Green Dog Leg Warmers' });
    const line = lineFor(item, 's', done(warmers, p('h', 2, { name: 'Fresh Hass Avocado, Each' })));
    assert.deepEqual([line.status, line.product?.id, line.alternatives.map((x) => x.id)], ['found', 'h', ['w']]);
    const none = lineFor(item, 's', done(warmers));
    assert.deepEqual([none.status, none.noMatch, none.alternatives.length], ['missing', true, 1]);
    assert.equal(lineFor(item, 's', done(warmers), 'w').product?.id, 'w', 'the user can still choose it');
    assert.equal(lineFor(item, 's', done()).noMatch, false, 'no results at all');
  });

  await t('baskets: sale prices are counted, with what they take off, quantities included', () => {
    const l = list('Milk', 'Eggs');
    l.items[1].qty = 2;
    const b = basketFor(l, 's', { milk: done(p('m', 3, { wasPrice: 3.5 })), eggs: done(p('e', 2, { wasPrice: 2.75 })) });
    assert.deepEqual([b.onSale, b.saleSavings], [2, 2]);
    assert.equal(basketFor(l, 's', { milk: done(p('m', 3, { wasPrice: 2 })) }).onSale, 0, 'a lower “was” price isn’t a sale');
  });

  await t('baskets: usuals apply to every list with the item, at the store they were chosen for', () => {
    const l = list('Milk');
    const results = { milk: done(p('m', 3), p('m2', 4, { name: 'Organic Milk' })) };
    assert.equal(basketFor(l, 's', results, { milk: { s: 'm2' } }).lines[0].product?.id, 'm2');
    assert.equal(basketFor(l, 't', results, { milk: { s: 'm2' } }).lines[0].product?.id, 'm', 'other stores keep Stretch’s match');
  });

  await t('baskets: totals with quantities; the pick gets the most of the list, then the lowest total', () => {
    const l = list('Milk', 'Eggs', 'Bread');
    l.items[0].qty = 3;
    const a = basketFor(l, 'a', { milk: done(p('m', 1)), eggs: done(p('e', 2)), bread: done(p('b', 3)) });
    const b = basketFor(l, 'b', { milk: done(p('m', 0.5)), eggs: done(p('e', 1)), bread: done() });
    const c = basketFor(l, 'c', { milk: done(p('m', 1)), eggs: { status: 'queued', products: [] }, bread: done(p('b', 1)) });
    assert.deepEqual([a.total, a.found, a.complete], [8, 3, true]);
    assert.deepEqual([b.total, b.found, b.missing], [2.5, 2, 1]);
    assert.deepEqual([c.pending, c.complete], [1, false]);
    assert.deepEqual(rankBaskets([b, c, a]).map((x) => x.retailerId), ['a', 'b', 'c']);
    assert.equal(stretchPick([b, a])?.retailerId, 'a', 'all 3 items beats cheaper but missing one');
    assert.equal(stretchPick([basketFor(l, 'z', {})]), null);
  });

  await t('split trip: the cheapest store per item across two stores, only when it saves enough or gets more', () => {
    const l = list('Milk', 'Eggs', 'Bread', 'Jam');
    const a = basketFor(l, 'a', { milk: done(p('m', 5)), eggs: done(p('e', 2)), bread: done(p('b', 6)), jam: done(p('j', 2)) });
    const b = basketFor(l, 'b', { milk: done(p('m', 2)), eggs: done(p('e', 3)), bread: done(p('b', 3)), jam: done(p('j', 3)) });
    const split = bestSplit([a, b])!;
    assert.deepEqual([split.retailerIds, split.total, split.savings], [['a', 'b'], 9, 2], 'b alone is $11');
    assert.deepEqual(split.assignment, { i0: 'b', i1: 'a', i2: 'b', i3: 'a' });

    const close = basketFor(l, 'c', { milk: done(p('m', 4.5)), eggs: done(p('e', 2.5)), bread: done(p('b', 6)), jam: done(p('j', 2)) });
    assert.equal(bestSplit([a, close]), null, 'saves 50¢: not worth a second stop');

    const partial = basketFor(l, 'd', { milk: done(p('m', 1)), eggs: done(), bread: done(), jam: done() });
    const noJam = basketFor(l, 'e', { milk: done(p('m', 9)), eggs: done(p('e', 1)), bread: done(p('b', 1)), jam: done() });
    const more = bestSplit([partial, noJam])!;
    assert.deepEqual([more.found, more.extraItems], [3, 0], 'no split gets more than 3 here');
    assert.equal(bestSplit([a]), null);
    assert.equal(bestSplit([a, { ...b, complete: false }]), null, 'only finished stores');
  });

  await t('worth the drive: each store’s round trip counts toward its total; the verdict says when the drive eats the savings', () => {
    const l = list('Milk', 'Eggs');
    const near = basketFor(l, 'near', { milk: done(p('m', 4)), eggs: done(p('e', 4)) }); // $8, 1 mi
    const far = basketFor(l, 'far', { milk: done(p('m', 3)), eggs: done(p('e', 3)) }); // $6, 4 mi
    const costs = driveCosts({ near: 1, far: 4, unknown: undefined }, 0.5);
    assert.deepEqual(costs, { near: 1, far: 4 }, 'there and back; unknown distances left out');
    assert.equal(stretchPick([near, far])?.retailerId, 'far', 'groceries alone');
    assert.equal(stretchPick([near, far], 'total', costs)?.retailerId, 'near', '$9 with driving beats $10');
    assert.deepEqual(rankBaskets([far, near], 'total', costs).map((b) => b.retailerId), ['near', 'far']);
    assert.deepEqual(driveVerdict([near, far], 'total', costs), { notWorthIt: { retailerId: 'far', saves: 2, extraDriving: 3 } });

    const cheap = driveCosts({ near: 1, far: 1.5 }, 0.5); // far costs $1.50 there and back
    assert.deepEqual(driveVerdict([near, far], 'total', cheap), { worthIt: { nearer: 'near', saves: 2, extraDriving: 0.5 } });
    assert.equal(driveVerdict([{ ...near, complete: false }, far], 'total', cheap)?.worthIt, undefined, 'only stores that have finished');

    // A split pays for trips to both stores.
    const l4 = list('Milk', 'Eggs', 'Bread', 'Jam');
    const a = basketFor(l4, 'a', { milk: done(p('m', 5)), eggs: done(p('e', 1)), bread: done(p('b', 6)), jam: done(p('j', 1)) });
    const b = basketFor(l4, 'b', { milk: done(p('m', 2)), eggs: done(p('e', 3)), bread: done(p('b', 3)), jam: done(p('j', 3)) });
    const withDrive = bestSplit([a, b], { a: 0.5, b: 0.5 })!;
    assert.deepEqual([withDrive.total, withDrive.driving, withDrive.savings], [7, 1, 3.5], 'b alone: $11 + 50¢ driving; the split: $7 + $1');
    assert.equal(bestSplit([a, b], { a: 3, b: 0.5 }), null, 'a second stop that far saves only $1');
  });

  // --- Pricing engine ---------------------------------------------------------------------------------------
  function fakeSearch(opts: { fail?: (store: string, q: string) => string | null; delay?: number } = {}) {
    const calls: { store: string; q: string; storeId: string }[] = [];
    const inFlight = new Map<string, number>();
    const peak = { total: 0, perStore: 0 };
    const search = async (c: RetailerConfig, q: string, storeId: string): Promise<SearchOutcome> => {
      calls.push({ store: c.id, q, storeId });
      inFlight.set(c.id, (inFlight.get(c.id) ?? 0) + 1);
      peak.perStore = Math.max(peak.perStore, inFlight.get(c.id)!);
      peak.total = Math.max(peak.total, [...inFlight.values()].reduce((a, b) => a + b, 0));
      await tick(opts.delay ?? 3);
      inFlight.set(c.id, inFlight.get(c.id)! - 1);
      const reason = opts.fail?.(c.id, q);
      if (reason) throw new SearchFailed([{ strategy: 'webview', ok: false, reason, ms: 1 }]);
      return { retailer: c.name, products: [p(`${c.id}-${q}`, q.length)], strategy: 'webview', via: 'replay', ms: 7, attempts: [] };
    };
    return { search, calls, peak };
  }
  const stores = (...ids: string[]): StoreChoice[] => ids.map((id) => ({ config: cfg(id), storeId: '', storeKey: 'k' }));
  const until = async (fn: () => boolean) => { for (let i = 0; i < 500 && !fn(); i++) await tick(2); assert.ok(fn(), 'timed out waiting'); };
  const names = ['a', 'bb', 'ccc', 'dddd', 'eeeee', 'ffffff'];

  await t('engine: stores run in parallel (at most 4), 3 searches per store, results stream in, then it finishes', async () => {
    const f = fakeSearch();
    const engine = new PricingEngine(f.search, new PriceCache());
    let updates = 0;
    engine.subscribe(() => updates++);
    engine.start('L', names, stores('s1', 's2', 's3', 's4', 's5'));
    assert.equal(engine.getRun('L')!.stores.s5.status, 'waiting');
    await until(() => !!engine.getRun('L')!.finishedAt);
    const run = engine.getRun('L')!;
    assert.equal(f.calls.length, 30);
    assert.deepEqual([f.peak.perStore, f.peak.total], [3, 12]);
    assert.deepEqual(Object.values(run.stores).map((s) => [s.status, s.settled, s.total]), Array(5).fill(['done', 6, 6]));
    assert.equal(run.results.s1.ccc.products[0].id, 's1-ccc');
    assert.ok(updates > 30, 'every search shows up as it lands');
  });

  await t('engine: the store each search got prices for rides along to results, saved prices and listeners; reset forgets runs', async () => {
    const store = { name: 'Example Midtown', id: '12' };
    const search = async (c: RetailerConfig, q: string): Promise<SearchOutcome> => {
      await tick(2);
      return { retailer: c.name, products: [p(`${c.id}-${q}`, 1)], strategy: 'webview', via: 'page', ms: 5, attempts: [], store };
    };
    const cache = new PriceCache();
    const engine = new PricingEngine(search, cache);
    const heard: unknown[] = [];
    engine.onSearched((rid, storeKey, _products, _at, seen) => heard.push([rid, storeKey, seen]));
    engine.start('L', ['milk'], stores('s1'));
    await until(() => !!engine.getRun('L')!.finishedAt);
    assert.deepEqual(engine.getRun('L')!.results.s1.milk.store, store);
    assert.deepEqual(heard, [['s1', 'k', store]]);
    const again = new PricingEngine(search, cache);
    again.start('M', ['milk'], stores('s1'));
    assert.deepEqual([again.getRun('M')!.results.s1.milk.cached, again.getRun('M')!.results.s1.milk.store], [true, store], 'saved with the prices');

    engine.start('L', ['eggs'], stores('s1'));
    engine.reset();
    assert.equal(engine.getRun('L'), undefined);
    await tick(10);
    assert.equal(engine.getRun('L'), undefined, 'a search that was running goes nowhere');
    engine.start('L', ['milk'], stores('s1'));
    assert.ok(engine.getRun('L'), 'starts again as new');
  });

  await t('engine: fresh cached prices are reused; refresh searches again; a new item searches only itself', async () => {
    const f = fakeSearch();
    const cache = new PriceCache();
    const engine = new PricingEngine(f.search, cache);
    engine.start('L', names.slice(0, 3), stores('s1', 's2'));
    await until(() => !!engine.getRun('L')!.finishedAt);
    assert.equal(f.calls.length, 6);

    const other = new PricingEngine(f.search, cache);
    other.start('M', ['A', ' bb ', 'ccc'], stores('s1', 's2'));
    assert.equal(other.getRun('M')!.finishedAt !== undefined, true, 'all from cache, instantly');
    assert.equal(other.getRun('M')!.results.s1.a.cached, true);

    const firstDone = engine.getRun('L')!.finishedAt!;
    engine.start('L', [...names.slice(0, 3), 'zz'], stores('s1', 's2'));
    assert.ok(engine.getRun('L')!.startedAt >= firstDone, 'the clock restarts for the new search');
    await until(() => !!engine.getRun('L')!.finishedAt);
    assert.deepEqual(f.calls.slice(6).map((c) => c.q), ['zz', 'zz']);
    engine.start('L', names.slice(0, 3), stores('s1'), { refresh: true });
    await until(() => !!engine.getRun('L')!.finishedAt);
    assert.equal(f.calls.length, 11);
    assert.deepEqual(Object.keys(engine.getRun('L')!.results), ['s1']);
  });

  await t('engine: coming back to a finished run keeps each store’s times; new searches start its clock again', async () => {
    let clock = 1_000_000;
    const search = async (c: RetailerConfig, q: string): Promise<SearchOutcome> => {
      await tick(3);
      clock += 1000;
      return { retailer: c.name, products: [p(q, 1)], strategy: 'webview', ms: 1000, attempts: [] };
    };
    const engine = new PricingEngine(search, new PriceCache(undefined, () => clock), 4, 1, () => clock);
    engine.start('L', ['milk', 'eggs'], stores('s1'));
    await until(() => !!engine.getRun('L')!.finishedAt);
    const first = engine.getRun('L')!;
    const times = [first.stores.s1.startedAt, first.stores.s1.finishedAt];
    clock += 60_000;
    engine.start('L', ['milk', 'eggs'], stores('s1'));
    const again = engine.getRun('L')!;
    assert.deepEqual([again.stores.s1.startedAt, again.stores.s1.finishedAt, again.finishedAt], [...times, first.finishedAt], 'nothing new: nothing moves');
    engine.start('L', ['milk', 'eggs', 'jam'], stores('s1'));
    await until(() => !!engine.getRun('L')!.finishedAt);
    const later = engine.getRun('L')!;
    assert.ok(later.stores.s1.startedAt! >= times[1]!, 'the store’s clock started again');
    assert.equal(later.stores.s1.finishedAt! - later.stores.s1.startedAt!, 1000, 'one search, one second');
  });

  await t('engine: two failures in a row stop a store; skipping its bot check stops it at once; retry resumes', async () => {
    const blocked = new Set(['s1']);
    const f = fakeSearch({ fail: (s, q) => (blocked.has(s) ? 'challenge' : s === 's2' && q === 'bb' ? 'challenge_cancelled' : null) });
    const engine = new PricingEngine(f.search, new PriceCache(), 4, 1);
    engine.start('L', names, stores('s1', 's2', 's3'));
    await until(() => !!engine.getRun('L')!.finishedAt);
    const run = engine.getRun('L')!;
    assert.equal(f.calls.filter((c) => c.store === 's1').length, 2);
    assert.match(run.stores.s1.stoppedBecause ?? '', /Kept failing \(challenge\)/);
    assert.deepEqual(Object.values(run.results.s1).map((r) => r.status), ['failed', 'failed', 'skipped', 'skipped', 'skipped', 'skipped']);
    assert.equal(run.stores.s2.stoppedBecause, 'You skipped the bot check');
    assert.equal(f.calls.filter((c) => c.store === 's2').length, 2);
    assert.equal(run.stores.s3.failed, 0);

    engine.start('L', names, stores('s1', 's2', 's3'));
    await tick(20);
    assert.equal(f.calls.length, 10, 'coming back doesn’t retry by itself');
    blocked.clear();
    engine.retry('L', 's1');
    await until(() => !!engine.getRun('L')!.finishedAt);
    assert.deepEqual(Object.values(engine.getRun('L')!.results.s1).map((r) => r.status), Array(6).fill('done'));
    assert.equal(engine.getRun('L')!.stores.s1.stoppedBecause, undefined);
  });

  await t('engine: a store that has had an hour’s worth of searches waits: the rest of its searches are skipped, and say why', async () => {
    const f = fakeSearch({ fail: (s) => (s === 's1' ? 'polite_limit' : null) });
    const engine = new PricingEngine(f.search, new PriceCache(), 4, 1);
    engine.start('P', names, stores('s1', 's2'));
    await until(() => !!engine.getRun('P')!.finishedAt);
    const run = engine.getRun('P')!;
    assert.equal(f.calls.filter((c) => c.store === 's1').length, 1, 'one refusal is enough');
    assert.equal(run.stores.s1.stoppedBecause, 'Paused: an hour’s worth of searches here already');
    assert.equal(run.stores.s2.failed, 0);
  });

  await t('engine: picking another store drops its old prices, even from a search still running; stop skips the rest', async () => {
    const f = fakeSearch({ delay: 15 });
    const engine = new PricingEngine(f.search, new PriceCache(), 4, 1);
    engine.start('L', ['milk', 'eggs'], stores('s1'));
    await tick(5);
    engine.start('L', ['milk', 'eggs'], [{ config: cfg('s1'), storeId: '42', storeKey: 'new' }]);
    await until(() => !!engine.getRun('L')!.finishedAt);
    assert.deepEqual(f.calls.map((c) => [c.q, c.storeId]), [['milk', ''], ['milk', '42'], ['eggs', '42']]);

    engine.start('L', ['a', 'b', 'c'], stores('s1'));
    await tick(5);
    engine.stop('L');
    await until(() => !!engine.getRun('L')!.finishedAt);
    assert.deepEqual(Object.values(engine.getRun('L')!.results.s1).map((r) => r.status), ['done', 'skipped', 'skipped']);
  });

  await t('engine: older prices show at once while fresh ones load; a failed refresh keeps them until a retry', async () => {
    let clock = 1_000_000_000;
    const now = () => clock;
    const cache = new PriceCache(undefined, now);
    let fail = false;
    const calls: string[] = [];
    const search = async (c: RetailerConfig, q: string): Promise<SearchOutcome> => {
      calls.push(q);
      await tick(5);
      if (fail) throw new SearchFailed([{ strategy: 'webview', ok: false, reason: 'no_payload', detail: 'S1 showed its page, but no product data arrived.', ms: 1 }]);
      return { retailer: c.name, products: [p(`fresh-${q}`, 2)], strategy: 'webview', ms: 5, attempts: [] };
    };
    cache.set(PriceCache.key('s1', 'k', 'milk'), { products: [p('old-milk', 3)], at: clock, ms: 1 });
    clock += 5 * 3600_000; // Five hours later.
    const engine = new PricingEngine(search, cache, 4, 1, now);
    const milk = list('Milk').items[0];

    engine.start('L', ['Milk'], stores('s1'));
    const shown = engine.getRun('L')!.results.s1.milk;
    assert.deepEqual([shown.status, shown.stale, shown.products[0].id, shown.at], ['queued', true, 'old-milk', clock - 5 * 3600_000]);
    const line = lineFor(milk, 's1', shown);
    assert.deepEqual([line.status, line.product?.id, line.refreshing, line.stale], ['found', 'old-milk', true, true]);
    await until(() => !!engine.getRun('L')!.finishedAt);
    const fresh = engine.getRun('L')!.results.s1.milk;
    assert.deepEqual([fresh.status, fresh.stale, fresh.products[0].id], ['done', undefined, 'fresh-Milk']);

    clock += 3 * 3600_000; // Stale again; this time the refresh fails.
    fail = true;
    engine.start('L', ['Milk'], stores('s1'));
    await until(() => !!engine.getRun('L')!.finishedAt);
    const kept = engine.getRun('L')!.results.s1.milk;
    assert.deepEqual([kept.status, kept.stale, kept.products[0].id, kept.reason], ['done', true, 'fresh-Milk', 'no_payload']);
    assert.equal(kept.detail, 'S1 showed its page, but no product data arrived.');
    assert.deepEqual([lineFor(milk, 's1', kept).status, lineFor(milk, 's1', kept).refreshing], ['found', false]);

    const before = calls.length;
    engine.start('L', ['Milk'], stores('s1'));
    await tick(20);
    assert.equal(calls.length, before, 'coming back doesn’t retry a failed refresh by itself');
    fail = false;
    engine.retry('L', 's1');
    assert.deepEqual([engine.getRun('L')!.results.s1.milk.status, engine.getRun('L')!.results.s1.milk.products[0].id], ['queued', 'fresh-Milk'], 'still shown while retrying');
    await until(() => !!engine.getRun('L')!.finishedAt);
    assert.deepEqual([engine.getRun('L')!.results.s1.milk.stale, engine.getRun('L')!.results.s1.milk.reason], [undefined, undefined]);
  });

  await t('engine: searches wait while the app is away, and ones it cut off run again instead of failing', async () => {
    const calls: string[] = [];
    let release: (() => void) | undefined;
    const search = async (c: RetailerConfig, q: string): Promise<SearchOutcome> => {
      calls.push(q);
      if (calls.length === 1) {
        // iOS paused the app mid-search; the search times out when it comes back.
        await new Promise<void>((resolve) => { release = resolve; });
        throw new SearchFailed([{ strategy: 'webview', ok: false, reason: 'timeout', ms: 1 }]);
      }
      await tick(3);
      return { retailer: c.name, products: [p(q, 2)], strategy: 'webview', ms: 3, attempts: [] };
    };
    const engine = new PricingEngine(search, new PriceCache(), 4, 1);
    engine.start('L', ['milk', 'eggs'], stores('s1'));
    await tick(5);
    engine.setForeground(false);
    release!();
    await tick(20);
    assert.deepEqual(calls, ['milk'], 'nothing new starts while away');
    assert.equal(engine.getRun('L')!.results.s1.milk.status, 'queued', 'cut off, not failed');
    engine.setForeground(true);
    await until(() => !!engine.getRun('L')!.finishedAt);
    assert.deepEqual(calls, ['milk', 'milk', 'eggs']);
    assert.deepEqual(Object.values(engine.getRun('L')!.results.s1).map((r) => r.status), ['done', 'done']);
  });

  await t('engine: a store searched without a WebView (an official API) runs twice as many searches at once', async () => {
    const f = fakeSearch({ delay: 10 });
    const api: RetailerConfig = { ...cfg('api1'), strategies: ['api'] };
    const engine = new PricingEngine(f.search, new PriceCache());
    engine.start('L', names, [{ config: api, storeId: '', storeKey: 'k' }]);
    await until(() => !!engine.getRun('L')!.finishedAt);
    assert.equal(f.peak.perStore, 6);
  });

  // --- App store --------------------------------------------------------------------------------------------
  await t('app store: seeds two lists on first launch, saves changes, and loads them back', async () => {
    const memory = new Map<string, string>();
    const storage: KeyValueStore = { getItem: async (k) => memory.get(k) ?? null, setItem: async (k, v) => { memory.set(k, v); } };
    const a = new AppStore();
    await a.hydrate(storage);
    const bbq = a.getState().lists[0];
    assert.deepEqual([bbq.name, bbq.items.map((i) => i.name)], ['Sunday BBQ', ['Hot dogs', 'Hot dog buns', 'Ketchup', 'Mustard', 'Napkins', 'Iced tea']]);
    a.addItem(bbq.id, '  Paper   plates ');
    a.setQty(bbq.id, bbq.items[0].id, 0);
    a.setPick(bbq.id, bbq.items[0].id, 'walmart', 'w1');
    a.setRetailerOn('target', false);
    a.startTrip(bbq.id, { retailerIds: ['walmart'], lines: {}, total: 12, startedAt: 1 });
    a.toggleChecked(bbq.id, bbq.items[1].id);
    await a.flush();

    const b = new AppStore();
    await b.hydrate(storage);
    const back = b.getState().lists[0];
    assert.equal(back.items[6].name, 'Paper plates');
    assert.deepEqual([back.items[0].qty, b.getState().usuals['hot dogs'], back.items[1].checked, back.trip?.total], [1, { walmart: 'w1' }, true, 12]);
    assert.deepEqual(b.getState().settings.retailerIds, ['walmart', 'kroger', 'aldi']);
    const record = b.endTrip(back.id);
    assert.deepEqual([b.getState().lists[0].trip, b.getState().lists[0].items[1].checked], [null, false]);
    assert.deepEqual([record?.listName, record?.total, b.getState().trips.length, b.getState().trips[0].items.length], ['Sunday BBQ', 12, 1, 7]);
    assert.equal(b.getState().settings.onboarded, false, 'a first launch shows the welcome');
  });

  await t('app store: choices saved on list items by the earlier version become usuals', async () => {
    const old = {
      lists: [{ id: 'L1', name: 'Old', trip: null, createdAt: 0, updatedAt: 0, items: [{ id: 'i1', name: 'Milk', qty: 1, checked: false, picks: { target: 't9' } }] }],
      settings: { retailerIds: ['target'], storeIds: {}, storePickedAt: {}, zip: '', storeSetup: {}, onboarded: true },
    };
    const storage: KeyValueStore = { getItem: async () => JSON.stringify(old), setItem: async () => {} };
    const a = new AppStore();
    await a.hydrate(storage);
    assert.deepEqual(a.getState().usuals, { milk: { target: 't9' } });
    assert.equal('picks' in a.getState().lists[0].items[0], false);
    assert.deepEqual([a.getState().settings.onboarded, a.getState().settings.customRetailers, a.getState().trips], [true, [], []]);
  });

  console.log(`\n${passed} pricing tests passed`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
