/// <reference types="node" />
import assert from 'node:assert/strict';
import type { GroceryList } from '../src/lists/types';
import { mergeFeeReads, parseFeePage, sentencesOf, type FeePageRead } from '../src/onDevice/feePage';
import { BUNDLED_CONFIG, isRetailerConfig, rulesProblem } from '../src/onDevice/retailers';
import type { OnlinePlan, OnlineRules, Product, RetailerConfig } from '../src/onDevice/types';
import { basketFor, bestSplit, driveVerdict, rankBaskets, stretchPick, type ItemResult } from '../src/pricing/basket';
import { FeeBook, FEES_KEEP_MS, FEES_RETRY_MS, type FeeRead } from '../src/pricing/feeBook';
import {
  checkedWords,
  extrasOf,
  feeContexts,
  feesKey,
  inStoreCaveat,
  feesFor,
  feeStatusWords,
  feesSummary,
  onlineCost,
  onlineCosts,
  orderable,
  orderCostFn,
  partLabel,
  perksWords,
  planOffers,
  planPrice,
  plansAt,
  sourceWords,
  tripCosts,
  waivedWords,
  type FeeContext,
} from '../src/pricing/onlineCost';
import { tripSavings } from '../src/pricing/trips';
import { AppStore, type KeyValueStore } from '../src/state/appStore';

let passed = 0;
const t = async (name: string, fn: () => unknown) => { await fn(); passed++; console.log('ok -', name); };

const NAMES: Record<string, string> = { m: 'Whole Milk', e: 'Large Eggs', b: 'White Bread', j: 'Strawberry Jam' };
const p = (id: string, price: number): Product => ({ retailer: 'x', storeId: '', id, name: NAMES[id] ?? `Product ${id}`, price });
const done = (...products: Product[]): ItemResult => ({ status: 'done', products });
const list = (...names: string[]): GroceryList => ({
  id: 'L', name: 'Test', trip: null, createdAt: 0, updatedAt: 0,
  items: names.map((name, i) => ({ id: `i${i}`, name, qty: 1, checked: false })),
});
const rules = (r: Omit<OnlineRules, 'checked'>): OnlineRules => ({ checked: '2026-09-25', ...r });
const ctx = (r?: OnlineRules, plans: Record<string, boolean> = {}, read?: FeePageRead): FeeContext => ({ plans, ...(r ? { rules: r } : {}), ...(read ? { read } : {}) });
const page = (r: Partial<FeePageRead>): FeePageRead => ({ pickup: {}, delivery: {}, quotes: {}, count: 1, ...r });
const WALMART_PLUS: OnlinePlan = { id: 'walmart-plus', name: 'Walmart+', perYear: 98, perMonth: 12.95, delivery: { freeOver: 35, fee: 6.99 } };

(async () => {
  // --- The fee math ---------------------------------------------------------------------------------------------
  await t('a delivery adds the store’s fee, until the order is big enough for it to be free', () => {
    const r = rules({ delivery: { fee: 9.95, freeOver: 35 } });
    const small = onlineCost('w', 'delivery', 20, ctx(r));
    assert.deepEqual(small.parts, [{ kind: 'fee', amount: 9.95, from: 'rules' }]);
    assert.deepEqual([small.extra, small.total, small.toFree, small.estimate, small.known, small.available], [9.95, 29.95, { more: 15, over: 35, saves: 9.95 }, true, true, true]);
    const big = onlineCost('w', 'delivery', 40, ctx(r));
    assert.deepEqual(big.parts, [{ kind: 'fee', amount: 0, from: 'rules', waived: { over: 35 } }]);
    assert.deepEqual([big.extra, big.total, big.toFree], [0, 40, undefined]);
  });

  await t('minimums, small-order fees, fees that depend on the time slot, and service fees with a floor and a ceiling', () => {
    const r = rules({ delivery: { fee: 3.99, feeMax: 9.99, minimum: 10, smallUnder: 35, smallFee: 2, service: { pct: 5, min: 2, max: 10 } } });
    const tiny = onlineCost('i', 'delivery', 8, ctx(r));
    assert.deepEqual(tiny.parts.map((x) => [x.kind, x.amount]), [['fee', 3.99], ['small', 2], ['service', 2]]);
    assert.equal(tiny.parts[0].upTo, 9.99);
    assert.deepEqual([tiny.extra, tiny.total, tiny.minimum], [7.99, 15.99, { amount: 10, short: 2 }]);
    const large = onlineCost('i', 'delivery', 300, ctx(r));
    assert.deepEqual(large.parts.map((x) => [x.kind, x.amount]), [['fee', 3.99], ['service', 10]], '5% would be $15: capped at $10; no small-order fee');
    assert.equal(large.minimum, undefined);
    const flat = onlineCost('i', 'delivery', 50, ctx(rules({ delivery: { fee: 0, service: { pct: 0, min: 3, max: 3 } } })));
    assert.deepEqual(flat.parts.map((x) => [x.kind, x.amount]), [['fee', 0], ['service', 3]], 'a flat service fee');
  });

  await t('online prices higher than in store: added on top, and thresholds go by the online total; the page’s figure wins', () => {
    const r = rules({ delivery: { fee: 5, freeOver: 35 }, markup: { pct: 10, ways: ['delivery'], said: 'Prices are higher than in-store prices.' } });
    const c = onlineCost('a', 'delivery', 32, ctx(r));
    assert.deepEqual(c.parts[0], { kind: 'markup', amount: 3.2, from: 'rules', pct: 10 });
    assert.deepEqual([c.parts[1].waived, c.extra, c.total], [{ over: 35 }, 3.2, 35.2], '$35.20 online clears the $35 threshold');
    const read = onlineCost('a', 'delivery', 32, ctx(r, {}, page({ markup: { said: 'Prices are about 15% higher than in-store prices.', pct: 15 } })));
    assert.deepEqual([read.parts[0].amount, read.parts[0].from, read.extra], [4.8, 'page', 4.8]);
    const pickup = onlineCost('a', 'pickup', 32, ctx(r));
    assert.deepEqual([pickup.available, pickup.known, pickup.extra, pickup.total], [false, true, 0, 32], 'no pickup in its rules: it doesn’t offer it');
  });

  await t('a store whose site shows its online prices: nothing is added for them, and in store it says so', () => {
    const aldi = rules({
      delivery: { fee: 3.99, minimum: 10, service: { pct: 10 } },
      markup: { pct: 10.7, ways: ['pickup', 'delivery'], said: 'its online prices may be higher than in its stores', included: true },
    });
    const c = onlineCost('aldi', 'delivery', 40, ctx(aldi));
    assert.deepEqual(c.parts.map((x) => [x.kind, x.amount]), [['fee', 3.99], ['service', 4]], 'no markup part');
    assert.equal(c.total, 47.99);
    assert.equal(inStoreCaveat('ALDI', aldi), 'ALDI’s site shows its online prices: in store they’re likely about 10.7% lower (an estimate).');
    assert.equal(inStoreCaveat('Wegmans', rules({ markup: { pct: 15, ways: ['delivery'], said: 'x', stated: true } })), undefined, 'its site shows in-store prices');
    assert.equal(inStoreCaveat('Target', undefined), undefined);
  });

  await t('plans: the user’s plan waives or lowers fees, the cheapest option counts, and a plan is named only when it helps', () => {
    const r = rules({ delivery: { fee: 9.95 }, plans: [WALMART_PLUS] });
    assert.deepEqual([onlineCost('w', 'delivery', 50, ctx(r)).total, onlineCost('w', 'delivery', 50, ctx(r)).plan], [59.95, undefined]);
    const member = onlineCost('w', 'delivery', 50, ctx(r, { 'walmart-plus': true }));
    assert.deepEqual([member.total, member.plan, member.parts[0].waived], [50, 'Walmart+', { plan: 'Walmart+', over: 35 }]);
    const under = onlineCost('w', 'delivery', 20, ctx(r, { 'walmart-plus': true }));
    assert.deepEqual([under.total, under.plan, under.toFree], [26.99, 'Walmart+', { more: 15, over: 35, saves: 6.99, plan: 'Walmart+' }], 'members pay $6.99 under $35');
    assert.deepEqual(planOffers('w', 'delivery', 50, ctx(r)).map((o) => [o.plan.id, o.saves]), [['walmart-plus', 9.95]]);
    assert.deepEqual(planOffers('w', 'delivery', 20, ctx(r)).map((o) => o.saves), [2.96]);
    assert.deepEqual(planOffers('w', 'delivery', 50, ctx(r, { 'walmart-plus': true })), [], 'not offered to a member');
    const target = rules({ delivery: { fee: 9.99, minimum: 35 }, plans: [{ id: 'circle-360', name: 'Target Circle 360', delivery: { freeOver: 35 } }] });
    const short = onlineCost('t', 'delivery', 20, ctx(target, { 'circle-360': true }));
    assert.deepEqual([short.plan, short.toFree, short.minimum], [undefined, { more: 15, over: 35, saves: 9.99, plan: 'Target Circle 360' }, { amount: 35, short: 15 }], 'a member under the plan’s threshold hears of it');
    const useless = rules({ delivery: { fee: 9.95 }, plans: [{ id: 'far', name: 'Far', delivery: { freeOver: 100 } }] });
    assert.equal(onlineCost('w', 'delivery', 50, ctx(useless, { far: true })).plan, undefined);

    const costco = rules({
      delivery: { fee: 0, minimum: 35 },
      markup: { pct: 13.5, ways: ['delivery'], said: 'Item pricing is higher than your local warehouse.' },
      plans: [{ id: 'instacart-plus', name: 'Instacart+', perYear: 99, delivery: { markup: 10 } }],
    });
    assert.deepEqual([onlineCost('c', 'delivery', 100, ctx(costco)).total, onlineCost('c', 'delivery', 100, ctx(costco, { 'instacart-plus': true })).total], [113.5, 110]);
    assert.deepEqual(onlineCost('c', 'delivery', 20, ctx(costco)).minimum, { amount: 35, short: 12.3 }, '$22.70 online is $12.30 short of $35');
  });

  await t('a store whose fees aren’t known counts as in store; one that doesn’t take the order is out of the running', () => {
    const unknown = onlineCost('custom', 'delivery', 30, ctx());
    assert.deepEqual([unknown.known, unknown.available, unknown.extra, unknown.total, unknown.parts], [false, true, 0, 30, []]);
    const tj = rules({ note: 'it doesn’t sell online' });
    assert.deepEqual([onlineCost('tj', 'pickup', 30, ctx(tj)).available, onlineCost('tj', 'delivery', 30, ctx(tj)).available], [false, false]);
  });

  await t('the fees page’s figures replace the rules’, one by one; a range holds only from one source; the rules say what’s offered', () => {
    const r = rules({ delivery: { fee: 7.95, feeMax: 9.95, freeOver: 35 } });
    assert.deepEqual(feesFor('delivery', r, page({ delivery: { fee: 9.95 } })), { fee: 9.95, freeOver: 35, from: { fee: 'page', freeOver: 'rules' } });
    assert.deepEqual(feesFor('delivery', r, page({ delivery: { freeOver: 50 } })), {
      fee: 7.95, feeMax: 9.95, freeOver: 50, from: { fee: 'rules', feeMax: 'rules', freeOver: 'page' },
    });
    assert.equal(feesFor('pickup', r, page({ pickup: { fee: 1 } })), null);
    const c = onlineCost('w', 'delivery', 20, ctx(r, {}, page({ delivery: { fee: 9.95 } })));
    assert.deepEqual([c.parts[0].from, c.parts[0].upTo, c.estimate], ['page', undefined, true], 'the threshold is still the rules’');
    assert.equal(onlineCost('w', 'delivery', 20, ctx(rules({ delivery: { fee: 5 } }), {}, page({ delivery: { fee: 4 } }))).estimate, false);
  });

  // --- Ranking by the way the user shops -------------------------------------------------------------------------
  const two = list('Milk', 'Eggs');
  const A = basketFor(two, 'a', { milk: done(p('m', 20)), eggs: done(p('e', 10)) }); // $30
  const B = basketFor(two, 'b', { milk: done(p('m', 21)), eggs: done(p('e', 12)) }); // $33
  const TJ = basketFor(two, 'tj', { milk: done(p('m', 15)), eggs: done(p('e', 10)) }); // $25
  const R: Record<string, OnlineRules> = {
    a: rules({ delivery: { fee: 9.95 } }),
    b: rules({ delivery: { fee: 3, freeOver: 50 } }),
    tj: rules({ note: 'it doesn’t sell online' }),
  };
  const ctxOf = (id: string) => ctx(R[id]);

  await t('delivered: a store cheaper on the items can lose to its fees, and one that doesn’t deliver can’t win', () => {
    const online = onlineCosts([A, B, TJ], 'delivery', ctxOf);
    assert.deepEqual([online.a.total, online.b.total, online.tj.available], [39.95, 36, false]);
    const extra = tripCosts(undefined, online)!;
    assert.deepEqual(extra, { a: 9.95, b: 3 });
    const can = orderable([A, B, TJ], online);
    assert.deepEqual(can.map((b) => b.retailerId), ['a', 'b']);
    assert.equal(stretchPick([A, B, TJ])?.retailerId, 'tj', 'in store');
    assert.equal(stretchPick(can, 'total', extra)?.retailerId, 'b', 'delivered');
    assert.deepEqual(rankBaskets(can, 'total', extra).map((b) => b.retailerId), ['b', 'a']);
    assert.deepEqual(driveVerdict(can, 'total', extrasOf(online)), { notWorthIt: { retailerId: 'a', saves: 3, extraDriving: 6.95 } }, 'a is $3 cheaper, but $6.95 more in fees');
    assert.deepEqual(tripCosts({ a: 2, b: 4 }, online), { a: 11.95, b: 7 }, 'driving and fees add up');
    assert.equal(tripCosts(undefined, undefined), undefined);
    assert.equal(orderable([A, TJ], undefined).length, 2, 'in store, every store is in the running');
  });

  await t('for pickup, the drive verdict counts each store’s fees on both sides', () => {
    const fees = { a: 2, b: 0 };
    const driving = { a: 8, b: 1 };
    assert.deepEqual(driveVerdict([A, B], 'total', driving, fees), { notWorthIt: { retailerId: 'a', saves: 1, extraDriving: 7 } });
    assert.deepEqual(driveVerdict([A, B], 'total', driving), { notWorthIt: { retailerId: 'a', saves: 3, extraDriving: 7 } }, 'without fees, as before');
  });

  await t('a split trip pays each order’s own fees, with each part’s thresholds', () => {
    const l4 = list('Milk', 'Eggs', 'Bread', 'Jam');
    const a = basketFor(l4, 'a', { milk: done(p('m', 5)), eggs: done(p('e', 1)), bread: done(p('b', 6)), jam: done(p('j', 1)) }); // $13
    const b = basketFor(l4, 'b', { milk: done(p('m', 2)), eggs: done(p('e', 3)), bread: done(p('b', 3)), jam: done(p('j', 3)) }); // $11
    assert.deepEqual([bestSplit([a, b])?.total, bestSplit([a, b])?.savings], [7, 4], 'in store: $7 at both against $11');
    const calls: [string, number][] = [];
    const freeFrom10 = (id: string, sub: number) => {
      calls.push([id, sub]);
      return sub >= 10 ? 0 : 5;
    };
    assert.equal(bestSplit([a, b], {}, freeFrom10), null, 'two small orders pay $5 each: $17 against $11');
    assert.ok(calls.some(([id, sub]) => id === 'a' && sub === 2) && calls.some(([id, sub]) => id === 'b' && sub === 5), 'each part costed on its own');
    const cheap = bestSplit([a, b], {}, () => 0.5)!;
    assert.deepEqual([cheap.total, cheap.fees, cheap.savings], [7, 1, 3.5]);
    const fn = orderCostFn('delivery', (id) => ctx(id === 'a' ? rules({ delivery: { fee: 4, freeOver: 10 } }) : rules({ delivery: { fee: 1 } })));
    assert.deepEqual([fn('a', 5), fn('a', 12), fn('b', 5)], [4, 0, 1]);
  });

  await t('trip savings count both sides’ fees when ordering online', () => {
    const l4 = list('Milk', 'Eggs');
    const a = basketFor(l4, 'a', { milk: done(p('m', 8)), eggs: done(p('e', 5)) }); // $13
    const b = basketFor(l4, 'b', { milk: done(p('m', 6)), eggs: done(p('e', 5)) }); // $11
    assert.deepEqual(tripSavings(b, ['b'], [a, b]), { retailerId: 'a', amount: 2 });
    const costOf = (id: string) => (id === 'a' ? 9.95 : 3);
    assert.deepEqual(tripSavings(b, ['b'], [a, b], { mode: 'delivery', fees: 3, costOf }), { retailerId: 'a', amount: 8.95 });
    assert.equal(tripSavings(a, ['a'], [a, b], { mode: 'delivery', fees: 9.95, costOf }), null, 'nothing cheaper elsewhere to save against');
  });

  // --- Words ------------------------------------------------------------------------------------------------------
  await t('fees in words: labels, waivers, plans, a one-line summary and the rules’ date', () => {
    assert.deepEqual(
      [
        partLabel({ kind: 'fee', amount: 1, from: 'rules' }, 'delivery'),
        partLabel({ kind: 'fee', amount: 1, from: 'rules' }, 'pickup'),
        partLabel({ kind: 'markup', amount: 1, from: 'rules', pct: 10 }, 'delivery'),
        partLabel({ kind: 'service', amount: 1, from: 'rules', pct: 5 }, 'delivery'),
        partLabel({ kind: 'service', amount: 1, from: 'rules', pct: 0 }, 'delivery'),
        partLabel({ kind: 'small', amount: 1, from: 'rules' }, 'delivery'),
      ],
      ['Delivery fee', 'Pickup fee', 'Online prices (+10%)', 'Service fee (5%)', 'Service fee', 'Small-order fee'],
    );
    assert.deepEqual([waivedWords({ over: 35 }), waivedWords({ plan: 'Walmart+', over: 35 }), waivedWords({ plan: 'Prime' })], [
      'free on orders of $35 or more', 'free with Walmart+ on orders of $35 or more', 'free with Prime',
    ]);
    assert.equal(planPrice(WALMART_PLUS), '$98 a year or $12.95 a month');
    assert.equal(perksWords(WALMART_PLUS), 'free delivery on orders of $35 or more');
    assert.equal(perksWords({ id: 'x', name: 'X', delivery: { service: null, markup: 10 } }), 'no delivery service fee, online prices about 10% above in store');
    const r = rules({ delivery: { fee: 3.99, feeMax: 9.99, smallUnder: 35, smallFee: 2, service: { pct: 5, min: 2 } } });
    assert.equal(feesSummary(onlineCost('i', 'delivery', 8, ctx(r))), 'Delivery from $3.99 · small-order fee $2.00 · service fee $2.00 (estimate)');
    assert.equal(feesSummary(onlineCost('i', 'delivery', 8, ctx(r, {}, page({ delivery: { fee: 4.5 } })))), 'Delivery $4.50 · small-order fee $2.00 · service fee $2.00 (partly estimated)');
    assert.equal(feesSummary(onlineCost('w', 'delivery', 40, ctx(rules({ delivery: { fee: 5, freeOver: 35 } }), {}, page({ delivery: { fee: 5, freeOver: 35 } })))), 'Free delivery');
    assert.equal(feesSummary(onlineCost('t', 'pickup', 40, ctx(rules({ pickup: { fee: 0 } })))), 'Free pickup (estimate)');
    assert.equal(feesSummary(onlineCost('tj', 'delivery', 40, ctx(R.tj))), 'No delivery');
    assert.equal(feesSummary(onlineCost('c', 'delivery', 40, ctx())), 'Fees not known');
    assert.equal(checkedWords('2026-09-25'), 'Sep 25, 2026');
    assert.equal(checkedWords('someday'), 'someday');
  });

  await t('where the fees came from, in words: the store’s page as read, the rules’ estimates, and why', () => {
    const now = Date.UTC(2026, 8, 25, 18);
    const url = 'https://www.walmart.com/help/fees';
    const r = rules({ feesUrl: url, delivery: { fee: 9.95 } });
    const name = 'Walmart';
    const estimate = onlineCost('w', 'delivery', 20, ctx(r));
    assert.equal(sourceWords(estimate, { name, rules: r, now }), 'Estimates from the store rules, checked Sep 25, 2026. walmart.com’s fees page hasn’t been read yet.');
    assert.equal(sourceWords(estimate, { name, rules: r, now, reading: true }), 'Estimates from the store rules, checked Sep 25, 2026. Reading walmart.com’s fees page now…');
    const failed: FeeRead = { url, at: now - 5 * 60_000, ok: false, reason: 'challenge' };
    assert.equal(sourceWords(estimate, { name, rules: r, read: failed, now }), 'Estimates from the store rules, checked Sep 25, 2026. walmart.com’s fees page couldn’t be read 5 min ago: bot check.');
    const fees = page({ delivery: { fee: 9.95 } });
    const read: FeeRead = { url, at: now - 2 * 3_600_000, ok: true, fees, feesAt: now - 2 * 3_600_000 };
    const fromPage = onlineCost('w', 'delivery', 20, ctx(r, {}, fees));
    assert.equal(sourceWords(fromPage, { name, rules: r, read, now }), 'From walmart.com’s fees page, read on this phone 2 h ago: the delivery fee.');
    const mixed = onlineCost('w', 'delivery', 20, ctx({ ...r, delivery: { fee: 9.95, service: { pct: 5 } } }, {}, fees));
    assert.equal(
      sourceWords(mixed, { name, rules: r, read, now }),
      'From walmart.com’s fees page, read on this phone 2 h ago: the delivery fee. Estimated from the store rules (checked Sep 25, 2026): the service fee.',
    );
    assert.equal(sourceWords(onlineCost('c', 'delivery', 20, ctx()), { name: 'Corner Shop', now }), 'Corner Shop’s online fees aren’t known, so its total is the items alone.');

    const cfg = { ...BUNDLED_CONFIG.retailers[0], id: 'w', name, online: r } as RetailerConfig;
    assert.equal(feeStatusWords(cfg, 'delivery', undefined, false, now), 'estimates until walmart.com is read');
    assert.equal(feeStatusWords(cfg, 'delivery', read, false, now), 'read from walmart.com 2 h ago');
    assert.equal(feeStatusWords(cfg, 'delivery', { ...read, ok: false, at: now - 60_000, reason: 'timeout' }, false, now), 'read from walmart.com 2 h ago; couldn’t read it again 1 min ago');
    assert.equal(feeStatusWords(cfg, 'delivery', failed, false, now), 'estimates, as walmart.com couldn’t be read 5 min ago (bot check)');
    assert.equal(feeStatusWords(cfg, 'delivery', undefined, true, now), 'reading walmart.com’s fees page now…');
    assert.equal(feeStatusWords(cfg, 'pickup', undefined, false, now), 'no pickup');
    assert.equal(feeStatusWords({ ...cfg, online: R.tj }, 'delivery', undefined, false, now), 'no delivery (it doesn’t sell online)');
    assert.equal(feeStatusWords({ ...cfg, online: undefined }, 'delivery', undefined, false, now), 'fees not known, so counted without them');
  });

  await t('fee contexts: each store’s rules, its page’s figures when they’re from its rules’ page, and the user’s plans', () => {
    const url = 'https://www.walmart.com/help/fees';
    const walmart = { ...BUNDLED_CONFIG.retailers[0], online: rules({ feesUrl: url, delivery: { fee: 9.95 }, plans: [WALMART_PLUS] }) } as RetailerConfig;
    const custom = { ...walmart, id: 'custom-1', online: undefined };
    const fees = page({ delivery: { fee: 8 } });
    const of = feeContexts([walmart, custom], (id, u) => (id === walmart.id && u === url ? fees : undefined), { 'walmart-plus': true });
    assert.deepEqual(of(walmart.id), { plans: { 'walmart-plus': true }, rules: walmart.online, read: fees });
    assert.deepEqual(of('custom-1'), { plans: { 'walmart-plus': true } });
    const plans = plansAt([walmart, { ...walmart, id: 'other', online: rules({ plans: [{ ...WALMART_PLUS, note: 'x' }] }) }]);
    assert.deepEqual(plans.map((x) => [x.plan.id, x.retailerIds]), [['walmart-plus', [walmart.id, 'other']]], 'one plan, at both stores');
  });

  // --- Reading a store's fees page ------------------------------------------------------------------------------
  await t('fees page: Walmart’s wording, with express, membership and ambiguous sentences left alone', () => {
    const text = [
      'Delivery & pickup fees',
      'Pickup',
      'Pick up orders over $35 for free.',
      'Delivery',
      '3 hr. or less delivery : $6 fee',
      'Standard Delivery from store : $9.95 delivery fee applies.',
      '$10 Express fee applies to all orders in addition to the $9.95 standard delivery fee.',
      'Walmart+ members get free delivery on orders $35+. Orders under $35 have a $6.99 fee.',
      'Free shipping on orders $35+.',
    ].join('\n');
    const read = parseFeePage(text, { planWords: ['Walmart+'] });
    assert.deepEqual(read.pickup, { freeOver: 35 });
    assert.deepEqual(read.delivery, { fee: 9.95 });
    assert.equal(read.quotes['delivery.fee'], 'Standard Delivery from store : $9.95 delivery fee applies.');
    assert.equal(read.quotes['pickup.freeOver'], 'Pick up orders over $35 for free.');
    assert.deepEqual([read.markup, read.count], [undefined, 2]);
  });

  await t('fees page: Target’s wording: a fee per order over a minimum, free pickup, the same prices, EBT left alone', () => {
    const text = [
      'Same Day Delivery',
      'Non-members: $9.99 delivery fee per order over $35.',
      'EBT orders under $35 have a $7 delivery fee.',
      'Target Circle 360 members get free same day delivery on orders over $35.',
      'You’ll find the same item pricing for Same Day Delivery as you find in your local Target store.',
      'Drive Up and Order Pickup: place your order and pick them up for free.',
    ].join('\n');
    const read = parseFeePage(text, { planWords: ['Target Circle 360'] });
    assert.deepEqual(read.delivery, { fee: 9.99, minimum: 35 });
    assert.deepEqual(read.pickup, { fee: 0 });
    assert.equal(read.markup, undefined, 'the same prices aren’t a markup');
  });

  await t('fees page: Costco’s Same-Day wording: a minimum under a heading, and higher prices than the warehouse', () => {
    const text = 'Costco Same-Day Delivery\nMinimum order of $35.\nPrices include a service and delivery fee.\nItem pricing is higher than your local warehouse in order to cover the service and delivery fees charged by Instacart.';
    const read = parseFeePage(text);
    assert.deepEqual(read.delivery, { minimum: 35 });
    assert.deepEqual(read.markup, { said: 'Item pricing is higher than your local warehouse in order to cover the service and delivery fees charged by Instacart.' });
    assert.equal(read.count, 2);
  });

  await t('fees page: service fees with a floor and a ceiling, small-order fees, a stated markup, ranges and “otherwise”', () => {
    const read = parseFeePage([
      'Delivery fees start at $3.99 for same-day orders over $35.',
      'Service fees are 5% of your order subtotal, with a $2 minimum and a maximum of $10.',
      'Prices on this site are higher than in-store prices, about 15% more.',
      'Small order fee: orders under $10 have a $2 small order fee.',
    ].join(' '));
    assert.deepEqual(read.delivery, { fee: 3.99, service: { pct: 5, min: 2, max: 10 }, smallUnder: 10, smallFee: 2 });
    assert.deepEqual(read.markup?.pct, 15);
    assert.deepEqual(parseFeePage('Delivery fees range from $6.99 to $9.95 depending on the time slot.').delivery, { fee: 6.99, feeMax: 9.95 });
    assert.deepEqual(parseFeePage('Free pickup on orders of $35 or more; $4.95 otherwise.').pickup, { freeOver: 35, fee: 4.95 });
    assert.deepEqual(parseFeePage('Delivery\nOrders that don’t reach the $35 minimum have a $6.99 fee.').delivery, { smallUnder: 35, smallFee: 6.99 }, 'a soft minimum, not a hard one');
    assert.deepEqual(parseFeePage('Delivery\nOrders under $35 have a $7.99 delivery fee.').delivery, {}, 'unclear whether that’s the fee or on top of it: skipped');
    assert.deepEqual(
      parseFeePage('Free delivery on orders of $35 or more. Orders under $35 have a $5.99 delivery fee.').delivery,
      { freeOver: 35, fee: 5.99 },
      'clear once the page has said it’s free from that same order size',
    );
  });

  await t('fees page: Kroger’s two pages: “otherwise a service fee” is the pickup fee, the standard delivery fee beats express', () => {
    const plans = { planWords: ['Kroger Boost', 'Kroger Boost Essential'] };
    const pickup = parseFeePage('Pickup\nPickup is FREE on orders of $35 or more, otherwise there’s a service fee of $4.95. Restrictions may apply.\nNo minimum purchase is required.', plans);
    assert.deepEqual(pickup.pickup, { freeOver: 35, fee: 4.95 });
    const delivery = parseFeePage(
      'Delivery\nDelivery fees vary based on the day and time slot selected.\nExpress delivery is available for an additional $4.95 on top of the standard delivery fee of $9.95.\nThe standard delivery fee is $9.95.\nKroger Boost members get free delivery on orders of $35 or more.',
      plans,
    );
    assert.deepEqual(delivery.delivery, { fee: 9.95 });
    const merged = mergeFeeReads(delivery, pickup);
    assert.deepEqual([merged.pickup, merged.delivery, merged.count], [{ freeOver: 35, fee: 4.95 }, { fee: 9.95 }, 3]);
    assert.equal(merged.quotes['pickup.fee'], 'Pickup is FREE on orders of $35 or more, otherwise there’s a service fee of $4.95.');
    const main = page({ pickup: { fee: 1 }, delivery: { fee: 5 }, quotes: { 'pickup.fee': 'a', 'delivery.fee': 'b' }, markup: { said: 'Prices are higher than in store.' } });
    const own = page({ pickup: { fee: 2, freeOver: 30 }, delivery: { fee: 7, minimum: 10 }, quotes: { 'pickup.fee': 'c' } });
    const both = mergeFeeReads(main, own);
    assert.deepEqual([both.pickup, both.delivery, both.markup?.said, both.quotes['pickup.fee'], both.count], [
      { fee: 2, freeOver: 30 }, { fee: 5, minimum: 10 }, 'Prices are higher than in store.', 'c', 5,
    ], 'pickup from its own page first, delivery from the main page first, each filling in the other');
    assert.deepEqual(mergeFeeReads(undefined, own).delivery, { fee: 7, minimum: 10 });
  });

  await t('fees page: Sprouts’ and Wegmans’ own pages, as they read on 2026-09-25', () => {
    const sprouts = parseFeePage(
      [
        'What is the fee for delivery?',
        'The delivery fee is free on your first order over $35!',
        'Future delivery fees are based on the delivery option you choose.',
        'Instacart+ members get free Fast delivery on orders $35+.',
        'For orders less than $35, Fast delivery is $7.99.',
        'Scheduled delivery (Later and Super Saver) on orders $10+ are free.',
        'Priority delivery is an additional $3.',
        'Non-Instacart+ Fast delivery is $7.99, Later is $1.99, and Super Saver is Free.',
        'What is the fee for curbside pickup?',
        'If your first order is over $35, the curbside pickup fee is free!* Future pickup fees depend on the order size.',
        'There is no pickup fee for orders over $35.',
        'For orders under $35 the pickup fee is $3.99.',
        'There are no service fees charged on pickup orders. *Available in select areas.',
        'Service fees vary and are subject to change based on factors like location and the number and types of items in your cart.',
        'Orders containing alcohol have a separate service fee.',
      ].join('\n'),
      { planWords: ['Instacart+'] },
    );
    assert.deepEqual(sprouts.delivery, { fee: 1.99, feeMax: 7.99 }, 'a first-order offer isn’t a threshold; members’ sentences are left alone');
    assert.deepEqual(sprouts.pickup, { freeOver: 35, fee: 3.99, service: { pct: 0 } });
    assert.equal(sprouts.markup, undefined);

    const wegmans = parseFeePage([
      'We’re waiving our service fees and reducing standard delivery costs to $4.99 * on grocery delivery orders.',
      'Delivery fee, taxes, and tip still apply.',
      'Our online prices remain about 15% above in-store prices, which includes our costs for shopping your order.',
      'How much does Wegmans grocery pickup cost?',
      'There is a $10 order minimum .',
      'There is no additional delivery fee, service charge or tip with grocery pickup.',
    ].join('\n'));
    assert.deepEqual(wegmans.delivery, { service: { pct: 0 }, fee: 4.99 });
    assert.deepEqual([wegmans.pickup, wegmans.markup?.pct], [{ minimum: 10 }, 15]);
    const publix = parseFeePage('Publix’s delivery and curbside pickup item prices are higher than item prices in physical store locations.');
    assert.equal(publix.markup?.said, 'Publix’s delivery and curbside pickup item prices are higher than item prices in physical store locations.');
  });

  await t('fees page: nothing is taken from sentences that don’t say plainly what a figure is', () => {
    assert.equal(parseFeePage('Our story began in 1962. Save $5 on your first order!').count, 0);
    assert.equal(parseFeePage('Delivery fee: $250 per order.').count, 0, 'out of range for a fee');
    assert.equal(parseFeePage('Prices are not higher than in store.').markup, undefined);
    assert.equal(parseFeePage('Delivery is available in most areas. Tips go 100% to your shopper: $5 suggested.').count, 0);
    assert.deepEqual(sentencesOf('Fee: $6.99. Orders of $35 ship free!\nNext line'), ['Fee: $6.99.', 'Orders of $35 ship free!', 'Next line']);
  });

  // --- Saved reads --------------------------------------------------------------------------------------------------
  await t('fee book: a read stands for a week, a failed one is retried after hours and keeps the last good figures; one round at a time', async () => {
    let clock = 1_000_000_000;
    const url = 'https://www.walmart.com/help/fees';
    const book = new FeeBook(() => clock);
    const fees = page({ delivery: { fee: 9.95 } });
    let news = 0;
    book.subscribe(() => news++);
    assert.equal(book.due('w', url), true);
    book.record('w', { url, at: clock, ok: true, fees, ms: 900 });
    assert.deepEqual([book.due('w', url), book.due('w', 'https://www.walmart.com/other'), book.figures('w', url), book.figures('w', 'https://x.com')], [false, true, fees, undefined]);
    const first = book.all();
    clock += FEES_KEEP_MS + 1;
    assert.equal(book.due('w', url), true, 'a week on');
    book.record('w', { url, at: clock, ok: false, reason: 'challenge' });
    assert.deepEqual([book.get('w')?.ok, book.get('w')?.fees, book.get('w')?.feesAt, book.due('w', url)], [false, fees, clock - FEES_KEEP_MS - 1, false]);
    assert.notEqual(book.all(), first, 'a new snapshot when a read lands');
    clock += FEES_RETRY_MS + 1;
    assert.equal(book.due('w', url), true);
    book.record('w', { url: 'https://www.walmart.com/other', at: clock, ok: false, reason: 'timeout' });
    assert.equal(book.get('w')?.fees, undefined, 'another page’s failure keeps nothing from the old one');

    const copy = new FeeBook(() => clock);
    book.record('t', { url, at: clock, ok: true, fees, bytes: 2000 });
    copy.hydrate(book.serialize());
    assert.deepEqual(copy.get('t'), book.get('t'));
    copy.hydrate('{"x": {"url": 1}, "y": "no"}');
    assert.deepEqual(copy.all(), {});
    copy.hydrate('not json');
    assert.ok(news >= 4);
    assert.deepEqual([book.beginRound(), book.beginRound()], [true, false]);
    book.setReading('w');
    book.endRound();
    assert.deepEqual([book.reading, book.beginRound()], [null, true]);
    // A read the user asks for meanwhile waits for the round to end; erasing everything tells a round running then.
    let waited = false;
    const over = book.roundOver().then(() => (waited = true));
    await Promise.resolve();
    const epoch = book.epoch;
    book.clear();
    assert.deepEqual([waited, book.all(), book.epoch === epoch], [false, {}, false]);
    book.endRound();
    await over;
    assert.equal(waited, true);
  });

  // --- Store rules and settings ----------------------------------------------------------------------------------
  await t('store rules: every bundled store’s online rules are valid, and bad ones are refused', () => {
    assert.equal(rulesProblem(BUNDLED_CONFIG), null);
    const walmart = BUNDLED_CONFIG.retailers.find((r) => r.id === 'walmart')!;
    assert.ok(walmart.online?.feesUrl?.startsWith('https://'));
    for (const r of BUNDLED_CONFIG.retailers) assert.ok(isRetailerConfig(r), r.id);
    const bad = (online: unknown) => isRetailerConfig({ ...walmart, online });
    assert.equal(bad({ ...walmart.online, feesUrl: 'http://www.walmart.com/fees' }), false);
    assert.equal(bad({ ...walmart.online, delivery: { fee: -1 } }), false);
    assert.equal(bad({ ...walmart.online, markup: { pct: 5, ways: ['ship'], said: 'x' } }), false);
    assert.equal(bad({ ...walmart.online, plans: [{ name: 'No id' }] }), false);
    assert.equal(bad({ ...walmart.online, plans: [{ id: 'p', name: 'P', delivery: { markup: 'x' } }] }), false);
    assert.equal(bad({ delivery: { fee: 1 } }), false, 'a date checked is required');
    assert.equal(bad({ checked: '2026-09-25' }), true, 'no pickup or delivery: the store doesn’t sell online');
    const tj = BUNDLED_CONFIG.retailers.find((r) => r.id === 'traderjoes')!;
    assert.deepEqual([tj.online?.pickup, tj.online?.delivery], [undefined, undefined]);
  });

  await t('store rules: chains on a parent’s platform share its fees and plans, on their own sites', () => {
    const r = (id: string) => BUNDLED_CONFIG.retailers.find((x) => x.id === id)!;
    const kroger = r('kroger').online!;
    const ralphs = r('ralphs').online!;
    assert.deepEqual([kroger.feesUrl, kroger.pickupFeesUrl], ['https://www.kroger.com/hc/help/faqs/ways-to-shop/delivery', 'https://www.kroger.com/hc/help/faqs/ways-to-shop/pickup']);
    assert.equal(ralphs.feesUrl, 'https://www.ralphs.com/hc/help/faqs/ways-to-shop/delivery');
    assert.deepEqual([ralphs.pickup, ralphs.delivery, ralphs.plans?.map((x) => x.id)], [kroger.pickup, kroger.delivery, ['kroger-boost', 'kroger-boost-essential']]);
    assert.equal(r('food4less').online?.plans, undefined, 'Boost’s terms don’t list Food 4 Less');
    assert.equal(feesKey(kroger), 'https://www.kroger.com/hc/help/faqs/ways-to-shop/delivery https://www.kroger.com/hc/help/faqs/ways-to-shop/pickup');
    assert.equal(r('vons').online?.feesUrl, 'https://www.vons.com/faq/online-shopping.html');
    assert.deepEqual(r('vons').online?.plans?.map((x) => x.id), r('safeway').online?.plans?.map((x) => x.id));
    const plans = plansAt([r('kroger'), r('ralphs'), r('safeway'), r('vons')]).map((x) => [x.plan.id, x.retailerIds]);
    assert.deepEqual(plans, [
      ['kroger-boost', ['kroger', 'ralphs']],
      ['kroger-boost-essential', ['kroger', 'ralphs']],
      ['freshpass', ['safeway', 'vons']],
    ], 'one switch per plan, whichever chains are compared');
  });

  await t('store rules: Instacart-run shops, and what each store says about its online prices', () => {
    const r = (id: string) => BUNDLED_CONFIG.retailers.find((x) => x.id === id)!.online!;
    assert.deepEqual([r('aldi').markup?.included, r('aldi').delivery?.minimum], [true, 10], 'ALDI’s storefront shows its online prices');
    assert.deepEqual([r('wegmans').markup?.pct, r('wegmans').markup?.stated, r('wegmans').markup?.included], [15, true, undefined], 'Wegmans says 15%, and shows in-store prices');
    assert.equal(r('sprouts').markup, undefined, 'Sprouts: no markups');
    assert.deepEqual([r('publix').markup?.ways, r('publix').feesUrl], [['pickup', 'delivery'], undefined], 'Publix’s words are in a pop-up: no page to read');
    assert.deepEqual([r('costco').pickup, r('costco').delivery?.fee], [undefined, 0], 'Costco: no pickup; the fee is in its prices');
    const instacart = ['aldi', 'sprouts', 'publix', 'wegmans', 'costco'].map((id) => r(id).plans?.find((x) => x.id === 'instacart-plus'));
    assert.ok(instacart.every((x) => x && x.perYear === 99 && x.perMonth === 9.99), 'one Instacart+ at every store Instacart runs or delivers');
    // What Instacart+ changes for a $40 delivery at ALDI: no fee, and a lower service fee.
    const aldi = onlineCost('aldi', 'delivery', 40, ctx(r('aldi'), { 'instacart-plus': true }));
    assert.deepEqual([aldi.plan, aldi.parts.map((x) => [x.kind, x.amount])], ['Instacart+', [['fee', 0], ['service', 2]]]);
    // Wegmans adds its 15% for pickup and delivery; delivery is $4.99 through 2026.
    assert.deepEqual(onlineCost('wegmans', 'delivery', 100, ctx(r('wegmans'))).parts.map((x) => [x.kind, x.amount]), [['markup', 15], ['fee', 4.99]]);
  });

  await t('settings: how the user shops and their plans are saved; nonsense saved values fall back', async () => {
    const saved: Record<string, string> = {};
    const storage: KeyValueStore = { getItem: async (k) => saved[k] ?? null, setItem: async (k, v) => { saved[k] = v; } };
    const a = new AppStore();
    await a.hydrate(storage);
    assert.deepEqual([a.getState().settings.shopMode, a.getState().settings.onlinePlans], ['store', {}]);
    a.setShopMode('delivery');
    a.setOnlinePlan('walmart-plus', true);
    a.setOnlinePlan('instacart-plus', true);
    a.setOnlinePlan('instacart-plus', false);
    await a.flush();
    const b = new AppStore();
    await b.hydrate(storage);
    assert.deepEqual([b.getState().settings.shopMode, b.getState().settings.onlinePlans], ['delivery', { 'walmart-plus': true }]);

    const junk: KeyValueStore = { getItem: async () => JSON.stringify({ lists: [], settings: { shopMode: 'teleport', onlinePlans: { x: 'yes', y: true } } }), setItem: async () => {} };
    const c = new AppStore();
    await c.hydrate(junk);
    assert.deepEqual([c.getState().settings.shopMode, c.getState().settings.onlinePlans], ['store', { y: true }]);

    const id = b.createList('Delivery test');
    b.startTrip(id, { retailerIds: ['walmart'], lines: {}, total: 20, startedAt: 1, mode: 'delivery', fees: 9.95 });
    assert.equal(b.endTrip(id)?.total, 29.95, 'an online order’s fees count in the trip');
    b.reset();
    assert.deepEqual([b.getState().settings.shopMode, b.getState().settings.onlinePlans], ['store', {}]);
  });

  console.log(`\n${passed} online order tests passed`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
