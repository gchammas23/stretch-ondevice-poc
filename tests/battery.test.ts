/// <reference types="node" />
import assert from 'node:assert/strict';
import { Politeness } from '../src/onDevice/politeness';
import type { RetailerConfig, SearchOutcome } from '../src/onDevice/types';
import {
  BatteryMeter,
  batteryEstimate,
  batteryLines,
  batteryShort,
  closeWindow,
  durationText,
  gaugeStep,
  levelText,
  NO_SESSION,
  openWindow,
  pctText,
  rangeText,
  runsRoom,
  sessionClose,
  sessionLeft,
  sessionNews,
  sessionOpen,
  sessionText,
  startProblemText,
  stepWords,
  windowNews,
  workText,
  type BatteryEstimate,
  type BatteryNews,
  type BatteryReading,
  type BatterySource,
  type BatteryWindow,
  type BatteryWork,
  type ChargeState,
} from '../src/pricing/batteryCost';
import { PriceCache } from '../src/pricing/priceCache';
import { PricingEngine } from '../src/pricing/pricingEngine';

const MIN = 60_000;
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
const t = async (name: string, fn: () => unknown) => { await fn(); passed++; console.log('ok -', name); };

const reading = (at: number, level: number | null, extra: Partial<BatteryReading> = {}): BatteryReading => ({ at, level, charge: 'unplugged', lowPower: false, ...extra });
const work = (runs: number, searches: number, extra: Partial<BatteryWork> = {}): BatteryWork => ({ runs, searches, planned: searches, bytes: 0, ...extra });
const whyNot = (e: BatteryEstimate) => (e.ok ? 'ok' : e.why);

const cfg = (id: string): RetailerConfig => ({
  id, name: id.toUpperCase(), enabled: true,
  searchUrl: 'https://www.example.com/s?q={{query}}', homeUrl: 'https://www.example.com/', cookieTemplate: '',
  strategies: ['webview'], parser: 'autoDetect', waitFor: 'auto', challengeMarkers: [],
  timeoutMs: 2000, storeHint: '', note: '',
});
const STORES = ['a', 'b', 'c', 'd'].map((id) => ({ config: cfg(id), storeId: '', storeKey: 'k' }));
const ITEMS = ['milk', 'eggs', 'bread', 'bananas', 'butter', 'coffee'];

/**
 * A phone's battery: a real level that searches draw on, reported the way a gauge does, rounded down to whole percents.
 * `say` passes on news, as the phone would.
 */
class FakeBattery implements BatterySource {
  charge: ChargeState = 'unplugged';
  reads = 0;
  private listener?: (news: BatteryNews) => void;
  constructor(public level: number) {}
  read = async (): Promise<BatteryReading> => {
    this.reads++;
    return { at: Date.now(), level: Math.floor(this.level * 100 + 1e-9) / 100, charge: this.charge, lowPower: false };
  };
  watch = (listener: (news: BatteryNews) => void) => {
    this.listener = listener;
    return () => {
      this.listener = undefined;
    };
  };
  say(news: BatteryNews) {
    this.listener?.(news);
  }
}

/** Each search takes a moment and `drain` of the battery, and calls `during` (to plug the phone in mid-run, say). */
function engineOn(battery: FakeBattery, drain: number, during: () => void = () => {}): PricingEngine {
  const search = async (c: RetailerConfig, q: string): Promise<SearchOutcome> => {
    await tick(2);
    battery.level -= drain;
    during();
    return { retailer: c.name, products: [{ retailer: c.id, storeId: '', id: q, name: `Brand ${q}`, price: 3 }], strategy: 'webview', via: 'replay', ms: 2, attempts: [], bytes: 1000 };
  };
  return new PricingEngine(search, new PriceCache());
}

(async () => {
  await t('battery words: shares of the battery, ranges, the gauge’s steps and times', () => {
    assert.deepEqual(
      [pctText(0), pctText(0.02), pctText(0.003), pctText(0.03 / 200), pctText(0.02 / 240), pctText(0.0999), pctText(0.36), pctText(1)],
      ['0%', '2%', '0.3%', '0.015%', '0.0083%', '10%', '36%', '100%'],
    );
    assert.equal(levelText(Math.fround(0.76)), '76%', 'the phone’s float for 76%');
    assert.equal(rangeText({ value: 0.03, low: 0.02, high: 0.04 }), '2% to 4%');
    assert.equal(rangeText({ value: 0.01, low: 0, high: 0.02 }), 'under 2%', 'a range that may be nothing');
    assert.deepEqual([stepWords(0.01), stepWords(0.05)], ['whole percents', 'steps of 5%']);
    assert.deepEqual([durationText(45_000), durationText(190_000), durationText(180_000), durationText(65 * MIN)], ['45 s', '3 min 10 s', '3 min', '1 h 5 min']);
  });

  await t('the gauge’s step: 5%, until a level between the 5% marks shows the phone reports whole percents', () => {
    assert.equal(gaugeStep([]), 0.05);
    assert.equal(gaugeStep([Math.fround(0.8), 0.75, 1]), 0.05, 'only 5% marks so far, floats and all');
    assert.equal(gaugeStep([0.8, Math.fround(0.76)]), 0.01);
    assert.equal(gaugeStep([-1]), 0.05, 'an unreadable level says nothing');
  });

  await t('a battery test’s estimate: the drop per list and per search, each with the range the steps leave', () => {
    const w = closeWindow(openWindow(reading(0, 0.83)), reading(5 * MIN, 0.8));
    const e = batteryEstimate(w, work(10, 200, { bytes: 34_000_000 }), 0.01)!;
    assert.ok(e.ok);
    if (!e.ok) return;
    assert.deepEqual(e.drop, { value: 0.03, low: 0.02, high: 0.04 }, 'each reading can be a step off: the real drop is 2% to 4%');
    assert.equal(e.rough, false);
    assert.equal(e.ms, 5 * MIN);
    assert.equal(batteryShort(e), 'battery 3%');
    assert.deepEqual(batteryLines(e, 'iPhone'), [
      'The battery went from 83% to 80%, on battery: 3% (2% to 4%) over 10 runs.',
      'About 0.3% a list (0.2% to 0.4%), and about 0.015% a search (0.01% to 0.02%).',
      'How sure: the iPhone reports its battery in whole percents, so each reading can be up to a step off, and the ranges say how far that goes. The screen and anything else running draw on the same battery: this is the whole iPhone while it priced.',
    ]);
    assert.equal(workText('cold', 5 * MIN, work(10, 200, { bytes: 34_000_000 })), '10 runs from cold in 5 min · 200 searches · about 34 MB');
  });

  await t('a drop too small to see is an upper limit; one run is too short to tell; some searches not run are said', () => {
    const flat = batteryEstimate(closeWindow(openWindow(reading(0, 0.83)), reading(2 * MIN, 0.83)), work(10, 240), 0.01)!;
    assert.ok(flat.ok && flat.rough);
    assert.equal(batteryShort(flat), 'battery under 1%');
    const lines = batteryLines(flat, 'iPhone');
    assert.equal(lines[1], 'Under 0.1% a list, and under 0.0042% a search.');
    assert.match(lines[2], /With so small a drop, this is mostly an upper limit: more runs make it closer/);

    const one = batteryEstimate(closeWindow(openWindow(reading(0, 0.83)), reading(12_000, 0.82)), work(1, 24), 0.01)!;
    assert.deepEqual(batteryLines(one, 'iPhone'), [
      'Battery from 83% to 82%, on battery: 1% (under 2%) for this run, about 0.042% a search (under 0.083%).',
      'One run is too short to tell, as the iPhone reports its battery in whole percents: the battery test runs it again and again.',
    ]);

    const coarse = batteryEstimate(closeWindow(openWindow(reading(0, 0.8, { lowPower: true })), reading(4 * MIN, 0.75)), work(10, 230, { planned: 240 }), 0.05)!;
    assert.ok(coarse.ok);
    if (!coarse.ok) return;
    assert.deepEqual(coarse.drop, { value: 0.05, low: 0, high: 0.1 }, 'a 5% gauge: one step either way');
    assert.ok(coarse.rough);
    const said = batteryLines(coarse, 'iPhone').join('\n');
    assert.match(said, /reports its battery in steps of 5%/);
    assert.match(said, /Low Power Mode was on: iOS slows the iPhone to save battery/);
    assert.match(said, /10 of 240 searches didn’t run \(a store paused or kept failing\)/);
  });

  await t('no estimate while plugged in (at either end or between), unreadable, unsure, after leaving the app, from 100%, or rising', () => {
    const from = (start: Partial<BatteryReading>, end: Partial<BatteryReading>, news: BatteryNews[] = []): BatteryWindow =>
      closeWindow(news.reduce(windowNews, openWindow(reading(0, 0.8, start))), reading(MIN, 0.79, end));
    const est = (w: BatteryWindow, searches = 24) => batteryEstimate(w, work(1, searches), 0.01)!;
    assert.equal(whyNot(est(from({}, {}))), 'ok');
    assert.equal(whyNot(est(from({ charge: 'charging' }, {}))), 'plugged_in');
    assert.equal(whyNot(est(from({}, { charge: 'full' }))), 'plugged_in', 'full is still on the charger');
    assert.equal(whyNot(est(from({}, {}, [{ kind: 'charge', charge: 'not_charging', at: 10 }, { kind: 'charge', charge: 'unplugged', at: 20 }]))), 'plugged_in', 'plugged in and out again meanwhile');
    assert.equal(whyNot(est(from({ level: null }, {}))), 'unreadable');
    assert.equal(whyNot(est(from({ charge: 'unknown' }, {}))), 'charge_unknown');
    assert.equal(whyNot(est(from({}, {}, [{ kind: 'app', active: false, at: 10 }, { kind: 'app', active: true, at: 20 }]))), 'left_app');
    assert.equal(whyNot(est(from({ level: 1 }, {}))), 'started_full', 'a phone can hold 100% for a while off the charger');
    assert.equal(whyNot(est(from({}, { level: 0.81 }))), 'rose');
    assert.equal(whyNot(est(from({}, {}), 0)), 'nothing_searched');
    assert.equal(batteryEstimate(openWindow(reading(0, 0.8)), work(1, 24), 0.01), undefined, 'nothing until the window closes');

    const plugged = est(from({ charge: 'charging' }, { charge: 'charging' }));
    assert.equal(batteryShort(plugged), 'battery not measured (plugged in)');
    assert.deepEqual(batteryLines(plugged, 'iPhone'), [
      'No battery estimate: it was plugged in, and the charger hides what pricing draws. Unplug the iPhone and run it again.',
      'At the start: 80%, charging, Low Power Mode off. At the end: 79%, charging, Low Power Mode off.',
    ]);
    const closedWindow = from({}, {});
    assert.equal(windowNews(closedWindow, { kind: 'charge', charge: 'charging', at: 2 * MIN }), closedWindow, 'news after the end changes nothing');
  });

  await t('before a battery test: runs that fit in every store’s hour, and a reading it can’t start from', () => {
    assert.equal(runsRoom([], 6), 20);
    assert.equal(runsRoom([30, 12, 0], 6), 15, 'the busiest store sets it, so none pauses mid-test');
    assert.equal(runsRoom([118], 6), 0);
    // 40 searches at Walmart 50 minutes ago and 60 (a 10-run battery test) 10 minutes ago: room for 3 runs, not 5.
    let clock = 100 * 60 * MIN;
    const hour = new Politeness(120, () => clock);
    clock -= 50 * MIN;
    for (let i = 0; i < 40; i++) hour.take('walmart');
    clock += 40 * MIN;
    for (let i = 0; i < 60; i++) hour.take('walmart');
    clock += 10 * MIN;
    assert.equal(runsRoom([hour.used('walmart')], 6), 3);
    assert.equal(hour.roomAt('walmart', 30), clock + 10 * MIN + 1, 'room for 5 runs once 10 of the older searches are an hour old');
    assert.equal(hour.roomAt('target', 30), clock, 'room now');
    assert.equal(hour.roomAt('walmart', 121), Infinity, 'more than an hour holds');
    assert.equal(startProblemText(reading(0, 0.8), 'iPhone'), undefined);
    assert.equal(startProblemText(reading(0, 0.8, { charge: 'charging' }), 'iPhone'), 'Plugged in: unplug the iPhone to run the battery test. On the charger, there’s no estimate.');
    assert.match(startProblemText(reading(0, 1), 'iPhone')!, /^At 100%: just off the charger/);
    assert.match(startProblemText(reading(0, null), 'iPhone')!, /doesn’t report its battery here/);
    assert.equal(workText('warm', 90_000, work(5, 120)), '5 warm runs in 1 min 30 s · 120 searches', 'no data counted, none said');
  });

  await t('this session: each stretch of pricing on the battery adds up; plugged in or leaving the app isn’t counted', () => {
    let s = NO_SESSION;
    assert.equal(sessionText(s, 0.01, 'iPhone'), 'Battery: no list priced since the app opened.');
    s = sessionClose(sessionOpen(s, reading(0, 0.9)), reading(2 * MIN, 0.89));
    s = sessionClose(sessionOpen(s, reading(5 * MIN, 0.89)), reading(6 * MIN, 0.89));
    assert.deepEqual([s.counted, s.ms, s.drop, s.open], [2, 3 * MIN, 0.01, undefined]);
    s = sessionOpen(s, reading(10 * MIN, 0.88));
    s = sessionNews(s, { kind: 'charge', charge: 'charging', at: 10.5 * MIN });
    s = sessionClose(s, reading(11 * MIN, 0.88, { charge: 'unplugged' }));
    s = sessionLeft(sessionOpen(s, reading(20 * MIN, 0.87)), 20.5 * MIN);
    assert.deepEqual([s.counted, s.skipped, s.skippedMs, s.skipWhy, s.open], [2, 2, 1.5 * MIN, ['plugged_in', 'left_app'], undefined]);
    assert.equal(
      sessionText(s, 0.01, 'iPhone'),
      'Battery this session: lists were priced for 3 min in all, and the battery dropped 1% meanwhile, the screen included. The iPhone reports its battery in whole percents, so that’s rough: the battery test in Diagnostics measures it properly. Not counted: 1 min 30 s of pricing on the charger, or cut short by leaving the app.',
    );
    const unreadable = sessionClose(sessionOpen(NO_SESSION, reading(0, null)), reading(MIN, null));
    assert.equal(sessionText(unreadable, 0.05, 'iPhone'), 'Battery: this iPhone doesn’t report its battery here, so pricing isn’t measured.');
    const still = sessionClose(sessionOpen(NO_SESSION, reading(0, 0.5)), reading(MIN, 0.5));
    assert.match(sessionText(still, 0.05, 'iPhone'), /the battery didn’t drop a 5% step meanwhile/);
  });

  await t('battery meter: a battery test prices the list again and again, reading the battery around each run and all of them', async () => {
    const battery = new FakeBattery(0.835);
    const engine = engineOn(battery, 0.0005);
    const meter = new BatteryMeter(battery);
    const detach = meter.attach(engine);
    await tick(5);
    assert.deepEqual([meter.getSnapshot().now?.level, meter.getSnapshot().step], [0.83, 0.01], 'read once attached; 83% is between the 5% marks');
    let starts = 0;
    const measuring = meter.measure({ engine, listId: 'speed', runs: 3, kind: 'warm', start: () => { starts++; engine.start('speed', ITEMS, STORES, { refresh: true }); } });
    assert.equal(meter.getSnapshot().busy, true);
    await measuring;
    const { test, lastRun, step, busy } = meter.getSnapshot();
    assert.equal(starts, 3);
    assert.equal(busy, false);
    assert.deepEqual([test!.done, test!.running, test!.cut, test!.kind], [3, false, false, 'warm']);
    assert.deepEqual(test!.work, { runs: 3, searches: 72, planned: 72, bytes: 72_000 });
    assert.deepEqual(lastRun!.work, { runs: 1, searches: 24, planned: 24, bytes: 24_000 }, 'the last run, on its own');
    // 72 searches took 3.6% of a battery that read 83% (83.5%): it reads 79% (79.9%) after. 4%, give or take a step.
    const e = batteryEstimate(test!.window, test!.work, step)!;
    assert.ok(e.ok);
    if (!e.ok) return;
    assert.equal(e.drop.value, 0.04);
    assert.ok(e.drop.low < 0.036 && 0.036 < e.drop.high, 'the real drop is within the range');
    await tick(10);
    const session = meter.getSnapshot().session;
    assert.ok(session.counted >= 1 && session.skipped === 0 && !session.open, 'the session counted the pricing too');
    assert.ok(Math.abs(session.drop - 0.04) < 0.0201, 'about the same drop, a step either way at each stretch');
    detach();
  });

  await t('battery meter: plugged in or leaving the app mid-test means no estimate; stopping ends it after the run going on', async () => {
    const battery = new FakeBattery(0.6);
    let searches = 0;
    let during = (n: number) => {
      if (n === 30) battery.say({ kind: 'charge', charge: 'charging', at: Date.now() });
      if (n === 31) battery.say({ kind: 'charge', charge: 'unplugged', at: Date.now() });
    };
    const engine = engineOn(battery, 0.0005, () => during(++searches));
    const meter = new BatteryMeter(battery);
    const detach = meter.attach(engine);
    const start = () => engine.start('speed', ITEMS, STORES, { refresh: true });
    await meter.measure({ engine, listId: 'speed', runs: 4, kind: 'cold', start });
    const plugged = meter.getSnapshot();
    assert.equal(whyNot(batteryEstimate(plugged.test!.window, plugged.test!.work, plugged.step)!), 'plugged_in', 'plugged in and out during the second run');
    assert.equal(whyNot(batteryEstimate(plugged.lastRun!.window, plugged.lastRun!.work, plugged.step)!), 'plugged_in');
    assert.deepEqual([plugged.test!.done, plugged.test!.cut], [2, true], 'no figure could come of the rest: it ended after that run');
    await tick(10);
    assert.deepEqual(meter.getSnapshot().session.skipWhy, ['plugged_in'], 'the session left that stretch out too');

    searches = 0;
    during = (n) => {
      if (n !== 5) return;
      battery.say({ kind: 'app', active: false, at: Date.now() });
      battery.say({ kind: 'app', active: true, at: Date.now() });
    };
    await meter.measure({ engine, listId: 'speed', runs: 1, kind: 'warm', start });
    const left = meter.getSnapshot();
    assert.equal(whyNot(batteryEstimate(left.lastRun!.window, left.lastRun!.work, left.step)!), 'left_app');
    assert.equal(left.test!.runs, 4, 'a single run leaves the last battery test as it was');
    await tick(10);
    assert.deepEqual(meter.getSnapshot().session.skipWhy, ['plugged_in', 'left_app']);

    searches = 0;
    during = (n) => n === 1 && meter.stop();
    await meter.measure({ engine, listId: 'speed', runs: 5, kind: 'warm', start });
    const stopped = meter.getSnapshot().test!;
    assert.deepEqual([stopped.done, stopped.cut, stopped.running, stopped.work.searches], [1, true, false, 24]);
    detach();
  });

  await t('battery meter: one measurement at a time, and a list erased mid-run (Start over) ends it', async () => {
    const battery = new FakeBattery(0.7);
    let erased = false;
    const engine: PricingEngine = engineOn(battery, 0.0002, () => {
      if (!erased) engine.reset();
      erased = true;
    });
    const meter = new BatteryMeter(battery);
    let starts = 0;
    const start = () => { starts++; engine.start('speed', ITEMS, STORES, { refresh: true }); };
    const first = meter.measure({ engine, listId: 'speed', runs: 3, kind: 'warm', start });
    await meter.measure({ engine, listId: 'speed', runs: 3, kind: 'warm', start });
    await first;
    const { test, lastRun, busy } = meter.getSnapshot();
    assert.equal(starts, 1, 'the second, asked while the first ran, was ignored; the erased run ended the first');
    assert.deepEqual([test!.done, test!.cut, test!.running, lastRun!.cut, busy], [0, true, false, true, false]);
  });

  console.log(`\n${passed} battery tests passed`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
