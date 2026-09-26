import { MAX_SEARCHES_PER_HOUR } from '../onDevice/politeness';
import { bytesText } from '../onDevice/scrapeFeed';
import type { PricingRun } from './pricingEngine';
import { scorecard } from './scorecard';

// Pure TypeScript, so the tests run it in Node.
//
// What reading prices costs the phone's battery, from the phone's own readings: the battery before and after the speed
// test's runs, divided by the lists and searches they priced. Three things keep it honest:
// - The phone reports its battery in steps (whole percents; 5% on some phones), so each reading can be up to a step
//   off. Every figure carries the range that leaves open, and one run is too short to tell: the battery test repeats
//   it, and the same step spread over more runs is a smaller error for each.
// - The screen and anything else running draw on the same battery: the figures are the whole phone while it priced.
// - On the charger, the battery can't be measured: plugged in at any moment, there's no estimate.

/** Whether the phone is on its battery, as it says. Full is full and still on the charger. */
export type ChargeState = 'unplugged' | 'charging' | 'full' | 'not_charging' | 'unknown';

/** One look at the battery. */
export interface BatteryReading {
  at: number;
  /** 0 to 1, as the phone reports it; null when it can't say (a simulator, a computer's browser). */
  level: number | null;
  charge: ChargeState;
  /** Low Power Mode (iOS), or Power Saver (Android). */
  lowPower: boolean;
}

/** On the charger, one way or another. */
export const pluggedIn = (charge: ChargeState): boolean => charge === 'charging' || charge === 'full' || charge === 'not_charging';

/** What the phone says between readings. */
export type BatteryNews =
  | { kind: 'charge'; charge: ChargeState; at: number }
  | { kind: 'lowPower'; on: boolean; at: number }
  | { kind: 'level'; level: number; at: number }
  /** The app left the screen (iOS pauses it soon after), or came back to it. */
  | { kind: 'app'; active: boolean; at: number };

/** A stretch of time measured on the battery: a reading at its start, one at its end, and what happened between. */
export interface BatteryWindow {
  start: BatteryReading;
  end?: BatteryReading;
  /** On the charger at some moment, at either end or between them. */
  plugged: boolean;
  /** Low Power Mode on at some moment. */
  lowPower: boolean;
  /** The app left the screen at some moment: iOS paused it, and the time away drew on the battery too. */
  leftApp: boolean;
}

export function openWindow(start: BatteryReading): BatteryWindow {
  return { start, plugged: pluggedIn(start.charge), lowPower: start.lowPower, leftApp: false };
}

/** The window with what the phone said while it was open. A closed window stays as it was. */
export function windowNews(w: BatteryWindow, news: BatteryNews): BatteryWindow {
  if (w.end) return w;
  if (news.kind === 'charge' && pluggedIn(news.charge) && !w.plugged) return { ...w, plugged: true };
  if (news.kind === 'lowPower' && news.on && !w.lowPower) return { ...w, lowPower: true };
  if (news.kind === 'app' && !news.active && !w.leftApp) return { ...w, leftApp: true };
  return w;
}

export function closeWindow(w: BatteryWindow, end: BatteryReading): BatteryWindow {
  if (w.end) return w;
  return { ...w, end, plugged: w.plugged || pluggedIn(end.charge), lowPower: w.lowPower || end.lowPower };
}

/** Why a battery figure can't be given. */
export type NoEstimate = 'unreadable' | 'plugged_in' | 'charge_unknown' | 'left_app' | 'started_full' | 'rose' | 'nothing_searched';
/** The ones that come from the readings themselves. */
export type WindowProblem = Exclude<NoEstimate, 'nothing_searched'>;

/** At or above this, the phone may be holding 100% after the charger, and a drop from it would read low. */
const FULL = 0.995;
/** Levels arrive as floats (0.76 as 0.7599999…): drops are rounded to four places, far finer than any gauge. */
const round4 = (x: number) => Math.round(x * 10_000) / 10_000;

/** Why the window's readings can't be used, if they can't: the first reason that applies. */
export function windowProblem(w: BatteryWindow): WindowProblem | undefined {
  const ends = w.end ? [w.start, w.end] : [w.start];
  if (ends.some((r) => r.level === null)) return 'unreadable';
  if (w.plugged || ends.some((r) => pluggedIn(r.charge))) return 'plugged_in';
  if (ends.some((r) => r.charge === 'unknown')) return 'charge_unknown';
  if (w.leftApp) return 'left_app';
  if (w.start.level! >= FULL) return 'started_full';
  if (w.end && w.end.level! > w.start.level! + 1e-4) return 'rose';
  return undefined;
}

/**
 * The steps the phone's battery gauge moves in, from the levels it has reported: 5%, as some phones report it, until a
 * level between those shows it's finer; then whole percents. Assuming the coarser step keeps the ranges honest.
 */
export function gaugeStep(levels: number[]): number {
  const between = levels.some((level) => {
    const fifths = (level * 100) / 5;
    return level >= 0 && level <= 1 && Math.abs(fifths - Math.round(fifths)) > 0.01;
  });
  return between ? 0.01 : 0.05;
}

/** What a measured stretch did: speed test runs, each pricing one list, the searches that ran in them, and their data. */
export interface BatteryWork {
  runs: number;
  /** Searches that ran, worked or failed. Prices saved from earlier don't count. */
  searches: number;
  /** Searches the runs were to make: fewer ran when a store paused or kept failing. */
  planned: number;
  bytes: number;
}

export const NO_WORK: BatteryWork = { runs: 0, searches: 0, planned: 0, bytes: 0 };

/** One finished run's work, from its scorecard. */
export function runWork(run: PricingRun): BatteryWork {
  const card = scorecard(run);
  return { runs: 1, searches: card.searches, planned: Object.values(run.stores).reduce((n, s) => n + s.total, 0), bytes: card.bytes };
}

export function addWork(a: BatteryWork, b: BatteryWork): BatteryWork {
  return { runs: a.runs + b.runs, searches: a.searches + b.searches, planned: a.planned + b.planned, bytes: a.bytes + b.bytes };
}

/**
 * Speed test runs that fit in every store's hour: each run is `perRun` searches at each store, a store takes `perHour`
 * an hour at most, and `used` is how many each has had in the last hour. Past that, a store would pause mid-test.
 */
export function runsRoom(used: number[], perRun: number, perHour = MAX_SEARCHES_PER_HOUR): number {
  if (perRun <= 0) return 0;
  return Math.max(0, Math.floor((perHour - Math.max(0, ...used)) / perRun));
}

/** A figure, and the range the gauge's steps leave open around it: the real value is above `low` and below `high`. */
export interface Ranged {
  value: number;
  low: number;
  high: number;
}

const scale = (r: Ranged, by: number): Ranged => ({ value: r.value * by, low: r.low * by, high: r.high * by });

interface EstimateBase {
  start: BatteryReading;
  end: BatteryReading;
  /** From the first reading to the last. */
  ms: number;
  work: BatteryWork;
  /** The gauge's step (see gaugeStep). */
  step: number;
  /** Low Power Mode was on at some moment. */
  lowPower: boolean;
}

export type BatteryEstimate =
  | (EstimateBase & { ok: false; why: NoEstimate })
  | (EstimateBase & {
      ok: true;
      /** What the battery lost, 0 to 1: 0.02 is 2% of it. */
      drop: Ranged;
      perList: Ranged;
      perSearch: Ranged;
      /** Under two steps: the range is as wide as the figure, so it's mostly an upper limit. */
      rough: boolean;
    });

/**
 * What the battery lost over a closed window, per list and per search, each with its range, or why there's no figure.
 * Each reading hides up to a step, so the real drop is within a step either side of what the readings show (and never
 * below nothing). Undefined while the window is open.
 */
export function batteryEstimate(w: BatteryWindow, work: BatteryWork, step: number): BatteryEstimate | undefined {
  const { start, end } = w;
  if (!end) return undefined;
  const base: EstimateBase = { start, end, ms: Math.max(0, end.at - start.at), work, step, lowPower: w.lowPower };
  const why = windowProblem(w) ?? (work.searches > 0 ? undefined : 'nothing_searched');
  if (why) return { ...base, ok: false, why };
  const lost = round4(start.level! - end.level!);
  const drop: Ranged = { value: lost, low: Math.max(0, round4(lost - step)), high: round4(lost + step) };
  return {
    ...base,
    ok: true,
    drop,
    perList: scale(drop, 1 / Math.max(1, work.runs)),
    perSearch: scale(drop, 1 / work.searches),
    rough: lost < 2 * step - 1e-9,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// This session's pricing on the battery, for Store health: each stretch of pricing with the app open is measured from a
// reading when it starts to one when it stops, and the drops add up.

export interface SessionBattery {
  /** Pricing counted: how long in all, and what the battery lost over those times, as the readings show. */
  ms: number;
  drop: number;
  /** Stretches of pricing counted, and ones left out (see WindowProblem). */
  counted: number;
  skipped: number;
  skippedMs: number;
  /** Why pricing was left out, each reason once. */
  skipWhy: WindowProblem[];
  /** The pricing going on now, measured from its start. */
  open?: BatteryWindow;
}

export const NO_SESSION: SessionBattery = { ms: 0, drop: 0, counted: 0, skipped: 0, skippedMs: 0, skipWhy: [] };

/** The session with no stretch open. */
function closed(s: SessionBattery): SessionBattery {
  const next = { ...s };
  delete next.open;
  return next;
}

function skip(s: SessionBattery, ms: number, why: WindowProblem): SessionBattery {
  return { ...closed(s), skipped: s.skipped + 1, skippedMs: s.skippedMs + ms, skipWhy: s.skipWhy.includes(why) ? s.skipWhy : [...s.skipWhy, why] };
}

/** Pricing started: measured from this reading. One already open carries on. */
export function sessionOpen(s: SessionBattery, reading: BatteryReading): SessionBattery {
  return s.open ? s : { ...s, open: openWindow(reading) };
}

/** Pricing stopped: counted, or left out when its readings can't be used. */
export function sessionClose(s: SessionBattery, reading: BatteryReading): SessionBattery {
  if (!s.open) return s;
  const w = closeWindow(s.open, reading);
  const ms = Math.max(0, reading.at - w.start.at);
  const why = windowProblem(w);
  if (why) return skip(s, ms, why);
  return { ...closed(s), counted: s.counted + 1, ms: s.ms + ms, drop: round4(s.drop + w.start.level! - reading.level!) };
}

/** The app left the screen: the pricing going on is left out, with no reading needed (the app may be paused by then). */
export function sessionLeft(s: SessionBattery, at: number): SessionBattery {
  return s.open ? skip(s, Math.max(0, at - s.open.start.at), 'left_app') : s;
}

/** What the phone said, for the pricing going on. */
export function sessionNews(s: SessionBattery, news: BatteryNews): SessionBattery {
  if (!s.open) return s;
  const open = windowNews(s.open, news);
  return open === s.open ? s : { ...s, open };
}

// ---------------------------------------------------------------------------------------------------------------------
// In words.

/** A share of the battery: "2%", "0.2%", "0.042%". Two figures at most: the range says how sure it is. */
export function pctText(share: number): string {
  const p = share * 100;
  if (p <= 0) return '0%';
  if (p >= 10) return `${Math.round(p)}%`;
  if (p < 0.0001) return 'under 0.0001%';
  return `${Number(p.toPrecision(2))}%`;
}

/** A battery level as the phone shows it: "83%". */
export const levelText = (level: number): string => `${Math.round(level * 100)}%`;

/** "0.1% to 0.3%", or "under 0.3%" when it may be nothing. */
export function rangeText(r: Ranged): string {
  return r.low <= 0 ? `under ${pctText(r.high)}` : `${pctText(r.low)} to ${pctText(r.high)}`;
}

/** How the phone reports its battery: "whole percents", or "steps of 5%" until it shows finer. */
export function stepWords(step: number): string {
  return Math.abs(step - 0.01) < 1e-9 ? 'whole percents' : `steps of ${pctText(step)}`;
}

/** "45 s", "3 min 10 s", "1 h 5 min". */
export function durationText(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const min = Math.floor(s / 60);
  if (min < 60) return s % 60 ? `${min} min ${s % 60} s` : `${min} min`;
  return min % 60 ? `${Math.floor(min / 60)} h ${min % 60} min` : `${Math.floor(min / 60)} h`;
}

export const CHARGE_WORDS: Record<ChargeState, string> = {
  unplugged: 'on battery',
  charging: 'charging',
  full: 'plugged in and full',
  not_charging: 'plugged in, not charging',
  unknown: 'not saying whether it’s plugged in',
};

/** "83%, on battery, Low Power Mode off", or what can't be read. */
export function readingText(r: BatteryReading): string {
  return `${r.level === null ? 'level unknown' : levelText(r.level)}, ${CHARGE_WORDS[r.charge]}, Low Power Mode ${r.lowPower ? 'on' : 'off'}`;
}

/**
 * The battery now, for the battery test's panel. A phone that gives apps its level in 5% steps shows whole percents in
 * its status bar, which can differ by a few (23% there reaches apps as 25%): the line says so.
 */
export function nowText(r: BatteryReading, step: number): string {
  if (r.level === null || step <= 0.01) return `Now: ${readingText(r)}`;
  return `Now: ${levelText(r.level)} as apps get it (the status bar may say a few percent more or less), ${CHARGE_WORDS[r.charge]}, Low Power Mode ${r.lowPower ? 'on' : 'off'}`;
}

const WHY: Record<NoEstimate, (device: string) => string> = {
  unreadable: (d) => `this ${d} doesn’t report its battery here (a simulator or a computer’s browser can’t).`,
  plugged_in: (d) => `it was plugged in, and the charger hides what pricing draws. Unplug the ${d} and run it again.`,
  charge_unknown: (d) => `the ${d} didn’t say whether it was plugged in.`,
  left_app: () => 'the app left the screen: iOS pauses it, and the time away draws on the battery too. Run it again with the app open.',
  started_full: () =>
    'it started at 100%. Just off the charger, a phone can show 100% for a while, so the drop would read low. Run it again below 100%.',
  rose: () => 'the battery’s reading went up meanwhile, so it can’t be trusted.',
  nothing_searched: () => 'nothing was searched.',
};

/** Why there's no figure, in a sentence. */
export const noEstimateText = (why: NoEstimate, device = 'phone'): string => `No battery estimate: ${WHY[why](device)}`;

const SHORT: Record<NoEstimate, string> = {
  unreadable: 'unreadable here',
  plugged_in: 'not measured (plugged in)',
  charge_unknown: 'not measured',
  left_app: 'not measured (left the app)',
  started_full: 'not measured (from 100%)',
  rose: 'not measured',
  nothing_searched: 'not measured',
};

/** The battery's part of a run's status line, next to its data: "battery 1%", "battery under 1%". */
export function batteryShort(e: BatteryEstimate): string {
  if (!e.ok) return `battery ${SHORT[e.why]}`;
  return e.drop.value > 0 ? `battery ${pctText(e.drop.value)}` : `battery under ${pctText(e.step)}`;
}

/** "about 0.2% a list (0.1% to 0.3%)", or "under 0.3% a list" when it may be nothing. */
function perText(r: Ranged, what: string): string {
  return r.value > 0 ? `about ${pctText(r.value)} ${what} (${rangeText(r)})` : `under ${pctText(r.high)} ${what}`;
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Where a figure's levels came from: the phone's own readings, or the status bar, as the user read it. */
export type LevelSource = 'phone' | 'statusBar';

/** As much as one reading can be off: "a percent", "5%". */
const stepOff = (step: number) => (Math.abs(step - 0.01) < 1e-9 ? 'a percent' : pctText(step));

/**
 * A measured stretch in sentences, for the screen and for sharing: where the battery went from and to, the drop per
 * list and per search with their ranges, and how sure that is. Or why there's no figure.
 */
export function batteryLines(e: BatteryEstimate, device = 'phone', from: LevelSource = 'phone'): string[] {
  const bar = from === 'statusBar';
  if (!e.ok) {
    if (bar) return [`No estimate from the status bar: ${e.why === 'rose' ? 'the end’s percentage is above the start’s. Check what was typed.' : WHY[e.why](device)}`];
    const lines = [noEstimateText(e.why, device)];
    if (e.why !== 'unreadable') lines.push(`At the start: ${readingText(e.start)}. At the end: ${readingText(e.end)}.`);
    return lines;
  }
  const lost = e.drop.value > 0 ? `${pctText(e.drop.value)} (${rangeText(e.drop)})` : `under ${pctText(e.step)}`;
  const went = `from ${levelText(e.start.level!)} to ${levelText(e.end.level!)}, ${CHARGE_WORDS[e.end.charge]}${e.lowPower ? ', Low Power Mode on' : ''}`;
  if (e.work.runs <= 1) {
    return [
      `Battery ${went}: ${lost} for this run, ${perText(e.perSearch, 'a search')}.`,
      `One run is too short to tell, as the ${device} gives apps its battery in ${stepWords(e.step)}: the battery test runs it again and again.`,
    ];
  }
  const lines = [
    `${bar ? 'The status bar' : 'The battery'} went ${went}: ${lost} over ${e.work.runs} runs.`,
    `${capital(perText(e.perList, 'a list'))}, and ${perText(e.perSearch, 'a search')}.`,
    `How sure: ${bar ? 'the status bar shows whole percents' : `the ${device} gives apps its battery in ${stepWords(e.step)}`}, so each reading can be up to ${stepOff(e.step)} off, and the ranges say how far that goes${
      e.rough ? '. With so small a drop, this is mostly an upper limit: more runs make it closer' : ''
    }. The screen and anything else running draw on the same battery: this is the whole ${device} while it priced.`,
  ];
  if (e.lowPower) lines.push(`Low Power Mode was on: iOS slows the ${device} to save battery, so pricing takes longer and may draw less.`);
  if (e.work.searches < e.work.planned) {
    lines.push(`${e.work.planned - e.work.searches} of ${e.work.planned} searches didn’t run (a store paused or kept failing), so a full list may take a little more.`);
  }
  return lines;
}

/** Why a battery test starting from this reading would get no figure, in a sentence; undefined when it can start. */
export function startProblemText(now: BatteryReading, device = 'phone'): string | undefined {
  switch (windowProblem(openWindow(now))) {
    case 'unreadable':
      return `This ${device} doesn’t report its battery here (a simulator or a computer’s browser can’t), so there’s nothing to measure.`;
    case 'plugged_in':
      return `Plugged in: unplug the ${device} to run the battery test. On the charger, there’s no estimate.`;
    case 'charge_unknown':
      return `The ${device} doesn’t say whether it’s plugged in, so there’d be no estimate.`;
    case 'started_full':
      return 'At 100%: just off the charger, a phone can show 100% for a while, so the drop would read low. Use it a little first.';
    default:
      return undefined;
  }
}

/** A percentage typed from the status bar, read (see readPercent). */
export type TypedPercent = { ok: true; level: number } | { ok: false; why: 'not_a_percent' | 'mismatch' };

/**
 * A battery percentage the user typed from the status bar: a whole number from 0 to 100, within a step of the phone's
 * own reading, else it was misread or mistyped. Undefined when nothing's typed.
 */
export function readPercent(text: string, phone: number | null, step: number): TypedPercent | undefined {
  const typed = text.trim().replace(/\s*%$/, '');
  if (!typed) return undefined;
  if (!/^\d{1,3}$/.test(typed) || Number(typed) > 100) return { ok: false, why: 'not_a_percent' };
  const level = Number(typed) / 100;
  if (phone !== null && Math.abs(level - phone) > step + 1e-9) return { ok: false, why: 'mismatch' };
  return { ok: true, level };
}

/** What's wrong with a typed percentage, in a sentence. */
export function typedProblemText(why: 'not_a_percent' | 'mismatch', phone: number | null, step: number, device = 'phone'): string {
  if (why === 'not_a_percent' || phone === null) return 'Type the status bar’s percentage as a whole number, like 23.';
  return `That’s more than ${pctText(step)} from the ${device}’s own reading (${levelText(phone)}): check the status bar.`;
}

/**
 * A battery test's figure from the status bar's whole percents, once the user typed them at its start and end: the
 * same window, with those levels in place of the phone's coarser readings.
 */
export function statusBarEstimate(m: Measurement): BatteryEstimate | undefined {
  const bar = m.statusBar;
  if (!m.window.end || !bar || bar.end === undefined) return undefined;
  return batteryEstimate({ ...m.window, start: { ...m.window.start, level: bar.start }, end: { ...m.window.end, level: bar.end } }, m.work, 0.01);
}

/** The phone's own figure in a line, beside a closer one: "By the iPhone’s own readings (steps of 5%): 25% to 20%, …". */
export function batteryBrief(e: BatteryEstimate, device = 'phone'): string {
  const by = `By the ${device}’s own readings (${stepWords(e.step)})`;
  if (!e.ok) return `${by}: ${SHORT[e.why]}.`;
  return `${by}: ${levelText(e.start.level!)} to ${levelText(e.end.level!)}, ${perText(e.perList, 'a list')}.`;
}

/**
 * A finished battery test's result, for the screen and for sharing: from the status bar's whole percents when both
 * ends were typed, with the phone's own readings in brief; else from the phone's own readings. `answer` is the line
 * with the drop per list and per search, when there is one.
 */
export function testReport(m: Measurement, step: number, device = 'phone'): { short: string; lines: string[]; answer?: number } | undefined {
  const phone = batteryEstimate(m.window, m.work, step);
  if (!phone) return undefined;
  const bar = statusBarEstimate(m);
  if (bar?.ok) return { short: `${batteryShort(bar)} by the status bar`, lines: [...batteryLines(bar, device, 'statusBar'), batteryBrief(phone, device)], answer: 1 };
  const lines = batteryLines(phone, device);
  // The status bar's figure, when it couldn't be had for a reason of its own; else what was typed so far.
  if (bar && (phone.ok || phone.why !== bar.why)) lines.push(...batteryLines(bar, device, 'statusBar'));
  else if (m.statusBar && m.statusBar.end === undefined) lines.push(`The status bar read ${levelText(m.statusBar.start)} at the start; no end was typed.`);
  return { short: batteryShort(phone), lines, answer: phone.ok && m.work.runs > 1 ? 1 : undefined };
}

/** A battery test's work in a line: "10 runs from cold in 4 min 12 s · 240 searches · about 34 MB". */
export function workText(kind: RunKind, ms: number, work: BatteryWork): string {
  return [
    `${work.runs} ${kind === 'warm' ? 'warm ' : ''}${work.runs === 1 ? 'run' : 'runs'}${kind === 'cold' ? ' from cold' : ''} in ${durationText(ms)}`,
    `${work.searches} ${work.searches === 1 ? 'search' : 'searches'}`,
    work.bytes ? `about ${bytesText(work.bytes)}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

const SKIPPED: Record<WindowProblem, string> = {
  unreadable: 'without a battery reading',
  plugged_in: 'on the charger',
  charge_unknown: 'not known to be on battery',
  left_app: 'cut short by leaving the app',
  started_full: 'from 100%, which a phone can hold for a while off the charger',
  rose: 'whose reading went up',
};

/** This session's pricing on the battery, in a few sentences, for Store health. */
export function sessionText(s: SessionBattery, step: number, device = 'phone'): string {
  const left = s.skipped ? ` Not counted: ${durationText(s.skippedMs)} of pricing ${s.skipWhy.map((why) => SKIPPED[why]).join(', or ')}.` : '';
  if (!s.counted) {
    if (s.skipWhy.length === 1 && s.skipWhy[0] === 'unreadable') return `Battery: this ${device} doesn’t report its battery here, so pricing isn’t measured.`;
    if (s.skipped) return `Battery: nothing measured yet this session.${left}`;
    return s.open ? 'Battery: measuring the pricing going on now.' : 'Battery: no list priced since the app opened.';
  }
  const drop = s.drop > 0 ? `dropped ${pctText(s.drop)}` : `didn’t drop ${step === 0.01 ? 'a whole percent' : `a ${pctText(step)} step`}`;
  return (
    `Battery this session: lists were priced for ${durationText(s.ms)} in all, and the battery ${drop} meanwhile, the screen included. ` +
    `The ${device} reports its battery in ${stepWords(step)}, so that’s rough: the battery test in Diagnostics measures it properly.${left}`
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// The meter: watches the phone's battery and the pricing engine, for this session's pricing and the speed test's runs.

/** Where the meter's readings and news come from: expo-battery and the app's state on a phone (see state/battery.ts). */
export interface BatterySource {
  /** The battery now. Never throws: what it can't tell is null or unknown. */
  read(): Promise<BatteryReading>;
  /** Calls back with the phone's news; returns a function that stops it. */
  watch(listener: (news: BatteryNews) => void): () => void;
}

/** The pricing engine, as far as the meter needs it. */
export interface PricingWatch {
  subscribe(listener: () => void): () => void;
  /** Some list is being priced. */
  pricing(): boolean;
  getRun(listId: string): PricingRun | undefined;
}

/** From cold (pages unloaded first) or with the pages kept from the last run. */
export type RunKind = 'cold' | 'warm';

/** Speed test runs measured on the battery: one, or a battery test's many, one after another. */
export interface Measurement {
  kind: RunKind;
  /** Runs asked for, and finished so far. */
  runs: number;
  done: number;
  window: BatteryWindow;
  work: BatteryWork;
  running: boolean;
  /** Ended before all its runs: stopped, or its list was erased (Start over). */
  cut: boolean;
  /** The battery levels the user read off the status bar, if they typed them: whole percents (see statusBarEstimate). */
  statusBar?: { start: number; end?: number };
}

export interface BatteryMeterState {
  /** The battery as last read, kept up to date by the phone's news. */
  now?: BatteryReading;
  /** The gauge's step, from the levels seen so far (see gaugeStep). */
  step: number;
  /** Speed test runs are being measured. */
  busy: boolean;
  session: SessionBattery;
  /** The speed test's last run, measured on its own. */
  lastRun?: Measurement;
  /** The last battery test (more than one run), or the one going on. */
  test?: Measurement;
}

export interface MeasureOptions {
  engine: PricingWatch;
  /** The list the runs price; `start` prices it again. */
  listId: string;
  start: () => void;
  kind: RunKind;
  runs: number;
  /** The status bar's level at the start, as the user typed it (a battery test only). */
  statusBarStart?: number;
}

/** The run of `listId` once it has finished, or undefined when it's gone (the app was started over). */
function finished(engine: PricingWatch, listId: string): Promise<PricingRun | undefined> {
  return new Promise((resolve) => {
    let stop = () => {};
    const check = () => {
      const run = engine.getRun(listId);
      if (run && run.finishedAt === undefined) return;
      stop();
      resolve(run);
    };
    stop = engine.subscribe(check);
    check();
  });
}

function withNews(m: Measurement | undefined, news: BatteryNews): Measurement | undefined {
  if (!m?.running) return m;
  const window = windowNews(m.window, news);
  return window === m.window ? m : { ...m, window };
}

export class BatteryMeter {
  private state: BatteryMeterState = { step: gaugeStep([]), busy: false, session: NO_SESSION };
  private listeners = new Set<() => void>();
  /** A level between the 5% marks has been seen: the gauge reports whole percents (see gaugeStep). */
  private finer = false;
  /** Stretches of pricing open and close one at a time, in order, each on a reading. */
  private queue: Promise<void> = Promise.resolve();
  private engine?: PricingWatch;
  private appActive = true;
  /** A stretch of pricing should be open: something is being priced, with the app on screen. */
  private wanted = false;
  private stopping = false;

  constructor(private source: BatterySource) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): BatteryMeterState => this.state;

  /** Reads the battery, then measures each stretch of the engine's pricing, until the returned function is called. */
  attach(engine: PricingWatch): () => void {
    this.engine = engine;
    const stopNews = this.source.watch(this.hear);
    const stopEngine = engine.subscribe(this.check);
    this.enqueue(async () => {
      await this.read();
    });
    this.wanted = !!engine.pricing() && this.appActive;
    this.reconcile();
    return () => {
      stopNews();
      stopEngine();
      if (this.engine === engine) this.engine = undefined;
    };
  }

  /**
   * Speed test runs measured on the battery: `runs` of them, one after another, each priced by `start`, with the
   * battery read before and after each run and around them all. One measurement at a time; `stop` ends it early.
   */
  async measure({ engine, listId, start, kind, runs, statusBarStart }: MeasureOptions): Promise<void> {
    if (this.state.busy) return;
    this.stopping = false;
    this.set({ busy: true });
    try {
      const many = runs > 1;
      let reading = await this.read();
      if (many) {
        const statusBar = statusBarStart !== undefined ? { statusBar: { start: statusBarStart } } : {};
        this.set({ test: { kind, runs, done: 0, window: openWindow(reading), work: NO_WORK, running: true, cut: false, ...statusBar } });
      }
      for (let i = 0; i < runs && !this.stopping; i++) {
        this.set({ lastRun: { kind, runs: 1, done: 0, window: openWindow(reading), work: NO_WORK, running: true, cut: false } });
        let run: PricingRun | undefined;
        try {
          start();
          run = await finished(engine, listId);
        } catch {
          run = undefined;
        }
        reading = await this.read();
        const work = run ? runWork(run) : NO_WORK;
        const last = this.state.lastRun!;
        this.set({ lastRun: { ...last, window: closeWindow(last.window, reading), work, done: run ? 1 : 0, running: false, cut: !run } });
        const test = this.state.test;
        if (many && test && run) this.set({ test: { ...test, done: test.done + 1, work: addWork(test.work, work) } });
        if (!run) break;
      }
      const test = this.state.test;
      if (many && test?.running) this.set({ test: { ...test, window: closeWindow(test.window, reading), running: false, cut: test.done < runs } });
    } finally {
      this.set({ busy: false });
    }
  }

  /** Ends the measurement after the run going on; stop the run itself to end it sooner. */
  stop(): void {
    if (this.state.busy) this.stopping = true;
  }

  /** The status bar's level at the end of the last battery test, as the user typed it; undefined takes it back. */
  noteStatusBar(end: number | undefined): void {
    const test = this.state.test;
    if (!test || test.running || !test.statusBar) return;
    this.set({ test: { ...test, statusBar: { start: test.statusBar.start, ...(end !== undefined ? { end } : {}) } } });
  }

  /** Reads the battery again, for a screen that shows it now: some phones and browsers send no news of it. */
  async refresh(): Promise<void> {
    await this.read();
  }

  private set(patch: Partial<BatteryMeterState>): void {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener());
  }

  private note(level: number | null): void {
    if (level !== null && !this.finer && gaugeStep([level]) < 0.05) this.finer = true;
  }

  private async read(): Promise<BatteryReading> {
    const reading = await this.source.read();
    this.note(reading.level);
    this.set({ now: reading, step: this.finer ? 0.01 : 0.05 });
    return reading;
  }

  private enqueue(task: () => Promise<void>): void {
    this.queue = this.queue.then(task).catch(() => {});
  }

  /** Pricing started or stopped, or the app left the screen or came back: a stretch opens or closes. */
  private check = (): void => {
    const want = !!this.engine?.pricing() && this.appActive;
    if (want === this.wanted) return;
    this.wanted = want;
    this.reconcile();
  };

  /** Opens or closes this session's stretch of pricing, on a reading, to match what's wanted. */
  private reconcile(): void {
    this.enqueue(async () => {
      if (this.wanted === !!this.state.session.open) return;
      const reading = await this.read();
      // What's wanted may have changed while the battery was read: the latest counts.
      this.set({ session: this.wanted ? sessionOpen(this.state.session, reading) : sessionClose(this.state.session, reading) });
    });
  }

  /** The phone's news: the latest reading, and what it means for the stretches being measured. */
  private hear = (news: BatteryNews): void => {
    const now = this.state.now;
    const patch: Partial<BatteryMeterState> = {
      session: news.kind === 'app' && !news.active ? sessionLeft(this.state.session, news.at) : sessionNews(this.state.session, news),
      lastRun: withNews(this.state.lastRun, news),
      test: withNews(this.state.test, news),
    };
    if (now && news.kind === 'charge') patch.now = { ...now, at: news.at, charge: news.charge };
    if (now && news.kind === 'lowPower') patch.now = { ...now, at: news.at, lowPower: news.on };
    if (news.kind === 'level') {
      this.note(news.level);
      patch.step = this.finer ? 0.01 : 0.05;
      if (now) patch.now = { ...now, at: news.at, level: news.level };
    }
    // Plugged in, or the app left: a battery test can't give a figure now, so it ends after the run going on.
    if (patch.test?.running && (patch.test.window.plugged || patch.test.window.leftApp)) this.stopping = true;
    this.set(patch);
    if (news.kind === 'app') {
      this.appActive = news.active;
      this.check();
    }
  };
}
