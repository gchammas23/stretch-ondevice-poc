import type { FeePageRead } from '../onDevice/feePage';
import { reasonWords } from '../onDevice/scrapeFeed';
import type { FeeSchedule, OnlinePlan, OnlineRules, OnlineWay, PlanPerks, RetailerConfig, ServiceFee } from '../onDevice/types';
import type { Basket, OrderCost, TripCosts } from './basket';
import type { FeeRead } from './feeBook';
import { hostOf, whenLabel } from './receipt';

// Pure functions only, so the tests run them in Node.
//
// What a basket costs ordered online, for pickup or delivery: the items, plus what the store adds where it says its
// online prices are higher than in its stores, plus its fees. The fees are what the store's own fees page says, as
// the phone read it, or else the store rules' estimates. Tips, taxes, bag fees and faster time slots aren't counted.

/** How the user shops: in the store, or ordering online for pickup or delivery. */
export type ShopMode = 'store' | OnlineWay;

export const SHOP_MODES: ShopMode[] = ['store', 'pickup', 'delivery'];

/** Where a figure came from: the store's own page, read on this phone, or the store rules, which are estimates. */
export type FeeSource = 'page' | 'rules';

const FIELDS = ['fee', 'feeMax', 'freeOver', 'minimum', 'smallFee', 'smallUnder', 'service'] as const;
type Field = (typeof FIELDS)[number];

/** A store's fees one way, and where each figure came from. */
export interface Fees extends FeeSchedule {
  from: Partial<Record<Field, FeeSource>>;
}

/** What the fee math needs about one store. */
export interface FeeContext {
  /** Its store rules; none for a store added from a link, whose fees aren't known. */
  rules?: OnlineRules;
  /** What its fees page said, when the phone last read it. */
  read?: FeePageRead;
  /** The plans the user has, by plan id (see OnlinePlan). */
  plans: Record<string, boolean>;
}

/** One thing an online order adds to the items. */
export interface CostPart {
  kind: 'markup' | 'fee' | 'small' | 'service';
  amount: number;
  from: FeeSource;
  /** The markup's or the service fee's percentage. */
  pct?: number;
  /** The fee depends on the time slot: `amount` in the cheapest, up to this in others. */
  upTo?: number;
  /** The fee is waived: on orders of at least `over`, or by a plan (on orders of at least `over`, if it says). */
  waived?: { over?: number; plan?: string };
}

/** A figure an order's cost depends on, and where it came from: "the delivery fee", "the free-delivery threshold". */
export interface Figure {
  name: string;
  from: FeeSource;
}

export interface OnlineCost {
  retailerId: string;
  way: OnlineWay;
  /** The store rules say how the store takes online orders. False (a store added from a link): counted as in store. */
  known: boolean;
  /** The store takes orders this way. */
  available: boolean;
  /** The basket at the prices the phone read. */
  items: number;
  parts: CostPart[];
  /** What the order adds to the items: online prices and fees. */
  extra: number;
  total: number;
  /** The plan counted, when one the user has makes this order cheaper. */
  plan?: string;
  /** The order is short of the store's minimum, by `short`. */
  minimum?: { amount: number; short: number };
  /** Spending `more` (to reach `over`) would waive a fee of `saves`: with `plan`, when it's the plan's threshold. */
  toFree?: { more: number; over: number; saves: number; plan?: string };
  /** Every figure the cost depends on, and where each came from. */
  figures: Figure[];
  /** Some figure is the store rules' estimate, not read from the store's own page. */
  estimate: boolean;
}

const round = (n: number): number => Math.round(n * 100) / 100;
/** An amount, without cents when it's whole: "$35", "$12.95". For thresholds and plan prices. */
export const dollars = (n: number): string => (Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`);
const usd = dollars;

/**
 * The store's fees for `way`: the rules' figures, each replaced by the figure its fees page gave, as read on the phone.
 * Null when the rules say it doesn't take orders that way, or have nothing on it.
 */
export function feesFor(way: OnlineWay, rules: OnlineRules | undefined, read?: FeePageRead): Fees | null {
  const base = rules?.[way];
  if (!base) return null;
  const page: Partial<FeeSchedule> = read?.[way] ?? {};
  const out: Fees = { ...base, from: {} };
  for (const k of FIELDS) {
    if (page[k] !== undefined) {
      Object.assign(out, { [k]: page[k] });
      out.from[k] = 'page';
    } else if (base[k] !== undefined) out.from[k] = 'rules';
  }
  // A range holds together only from one source, and only when its top is above its bottom.
  if ((out.from.fee === 'page' && out.from.feeMax === 'rules') || (out.feeMax !== undefined && !(out.feeMax > out.fee))) {
    delete out.feeMax;
    delete out.from.feeMax;
  }
  return out;
}

/** A service fee on an order of `sub`: its share, no less than its floor, no more than its ceiling. */
export function serviceAmount(s: ServiceFee, sub: number): number {
  let v = (s.pct / 100) * sub;
  if (s.min !== undefined) v = Math.max(v, s.min);
  if (s.max !== undefined) v = Math.min(v, s.max);
  return round(Math.max(0, v));
}

/** How much the store's online prices are above its in-store ones for `way`, if it says they are. */
function markupFor(way: OnlineWay, rules: OnlineRules, read?: FeePageRead, perks?: PlanPerks): { pct: number; from: FeeSource } | null {
  const m = rules.markup;
  // Where the store's site shows its online prices, the prices read have it already.
  if (!m || !m.ways.includes(way) || m.included) return null;
  // A plan's lower prices for members count; else the store's page giving a figure beats the rules' estimate.
  if (perks?.markup !== undefined) return { pct: perks.markup, from: 'rules' };
  return read?.markup?.pct !== undefined ? { pct: read.markup.pct, from: 'page' } : { pct: m.pct, from: 'rules' };
}

/** The user's plans that change `way` at this store. */
function plansFor(way: OnlineWay, rules: OnlineRules, mine: Record<string, boolean>): { plan: OnlinePlan; perks: PlanPerks }[] {
  return (rules.plans ?? []).flatMap((plan) => (mine[plan.id] && plan[way] ? [{ plan, perks: plan[way]! }] : []));
}

/** The order's cost with one plan (or none). */
function charge(retailerId: string, way: OnlineWay, items: number, fees: Fees, ctx: FeeContext, with_?: { plan: OnlinePlan; perks: PlanPerks }): OnlineCost {
  const parts: CostPart[] = [];
  const perks = with_?.perks;
  const m = markupFor(way, ctx.rules!, ctx.read, perks);
  const markup = m ? round((items * m.pct) / 100) : 0;
  if (m) parts.push({ kind: 'markup', amount: markup, from: m.from, pct: m.pct });
  // Thresholds and service fees go by what the order costs online.
  const sub = round(items + markup);

  const feeAt = perks?.fee ?? fees.fee;
  const byPlan = perks?.freeOver !== undefined && sub >= perks.freeOver;
  const byStore = fees.freeOver !== undefined && sub >= fees.freeOver;
  const waived = byPlan
    ? { plan: with_!.plan.name, ...(perks!.freeOver ? { over: perks!.freeOver } : {}) }
    : byStore
      ? { over: fees.freeOver }
      : undefined;
  // A waived fee is as sure as what waived it; a fee paid, as its own figure.
  const feeFrom: FeeSource = byPlan || perks?.fee !== undefined ? 'rules' : byStore ? (fees.from.freeOver ?? 'rules') : (fees.from.fee ?? 'rules');
  const fee: CostPart = { kind: 'fee', amount: waived ? 0 : feeAt, from: feeFrom };
  if (waived) fee.waived = waived;
  else if (perks?.fee === undefined && fees.feeMax !== undefined) fee.upTo = fees.feeMax;
  parts.push(fee);

  if (fees.smallUnder !== undefined && fees.smallFee && sub < fees.smallUnder) {
    parts.push({ kind: 'small', amount: fees.smallFee, from: fees.from.smallFee ?? 'rules' });
  }
  const service = perks && perks.service !== undefined ? perks.service : fees.service;
  if (service && (service.pct > 0 || service.min)) {
    parts.push({ kind: 'service', amount: serviceAmount(service, sub), from: perks?.service !== undefined ? 'rules' : (fees.from.service ?? 'rules'), pct: service.pct });
  }

  // Every figure the total depends on, thresholds included: one the rules give makes the total an estimate.
  const figures: Figure[] = [];
  const figure = (name: string, from: FeeSource | undefined) => figures.push({ name, from: from ?? 'rules' });
  if (m) figure('the online prices', m.from);
  figure(`the ${way} fee`, perks?.fee !== undefined ? 'rules' : fees.from.fee);
  if (fees.freeOver !== undefined) figure(`the free-${way} threshold`, fees.from.freeOver);
  if (fees.minimum !== undefined) figure('the minimum order', fees.from.minimum);
  if (fees.smallFee !== undefined && fees.smallUnder !== undefined) {
    figure('the small-order fee', fees.from.smallFee === 'page' && fees.from.smallUnder === 'page' ? 'page' : 'rules');
  }
  if (service) figure('the service fee', perks?.service !== undefined ? 'rules' : fees.from.service);
  if (with_) figure(`${with_.plan.name}’s perks`, 'rules');

  const extra = round(parts.reduce((sum, p) => sum + p.amount, 0));
  const out: OnlineCost = {
    retailerId,
    way,
    known: true,
    available: true,
    items: round(items),
    parts,
    extra,
    total: round(items + extra),
    figures,
    estimate: figures.some((f) => f.from === 'rules'),
  };
  if (with_) out.plan = with_.plan.name;
  if (fees.minimum !== undefined && sub < fees.minimum) out.minimum = { amount: fees.minimum, short: round(fees.minimum - sub) };
  return out;
}

/** The nearest order size that would waive the fee being paid: the store's own, or one of the user's plans'. */
function toFree(cost: OnlineCost, fees: Fees, mine: { plan: OnlinePlan; perks: PlanPerks }[]): OnlineCost['toFree'] {
  const fee = cost.parts.find((p) => p.kind === 'fee');
  if (!fee?.amount) return undefined;
  const sub = round(cost.items + (cost.parts.find((p) => p.kind === 'markup')?.amount ?? 0));
  const over = [
    ...(fees.freeOver !== undefined ? [{ over: fees.freeOver, plan: undefined }] : []),
    ...mine.flatMap(({ plan, perks }) => (perks.freeOver !== undefined ? [{ over: perks.freeOver, plan: plan.name }] : [])),
  ]
    .filter((t) => t.over > sub)
    .sort((a, b) => a.over - b.over)[0];
  return over ? { more: round(over.over - sub), over: over.over, saves: fee.amount, ...(over.plan ? { plan: over.plan } : {}) } : undefined;
}

/**
 * What ordering `items` worth (at the prices the phone read) costs at a store, `way`: its online prices, fees and
 * the user's plan there, whichever of their plans makes it cheapest.
 */
export function onlineCost(retailerId: string, way: OnlineWay, items: number, ctx: FeeContext): OnlineCost {
  const plain = { retailerId, way, items: round(items), parts: [], extra: 0, total: round(items), figures: [], estimate: false };
  if (!ctx.rules) return { ...plain, known: false, available: true };
  const fees = feesFor(way, ctx.rules, ctx.read);
  if (!fees) return { ...plain, known: true, available: false };
  const mine = plansFor(way, ctx.rules, ctx.plans);
  const options = [undefined, ...mine].map((p) => charge(retailerId, way, items, fees, ctx, p));
  // A plan is only named when it makes the order cheaper.
  const best = options.reduce((a, c) => (c.total < a.total - 0.004 ? c : a));
  const free = toFree(best, fees, mine);
  return free ? { ...best, toFree: free } : best;
}

/**
 * Each store's fee context, by retailer: its rules, the figures its fees page gave when the phone last read that page,
 * and the user's plans.
 */
export function feeContexts(
  retailers: RetailerConfig[],
  figures: (retailerId: string, url: string | undefined) => FeePageRead | undefined,
  plans: Record<string, boolean>,
): (retailerId: string) => FeeContext {
  return (retailerId) => {
    const rules = retailers.find((r) => r.id === retailerId)?.online;
    const read = rules ? figures(retailerId, feesKey(rules)) : undefined;
    return { plans, ...(rules ? { rules } : {}), ...(read ? { read } : {}) };
  };
}

/** Each basket's online cost, `way`, at the prices the phone read. */
export function onlineCosts(baskets: Basket[], way: OnlineWay, ctxOf: (retailerId: string) => FeeContext): Record<string, OnlineCost> {
  return Object.fromEntries(baskets.map((b) => [b.retailerId, onlineCost(b.retailerId, way, b.total, ctxOf(b.retailerId))]));
}

/** What ordering a part of the list online adds at each store, for split trips. */
export function orderCostFn(way: OnlineWay, ctxOf: (retailerId: string) => FeeContext): OrderCost {
  return (retailerId, subtotal) => onlineCost(retailerId, way, subtotal, ctxOf(retailerId)).extra;
}

/**
 * Everything else each store costs, by retailer, for ranking (see TripCosts in basket.ts): the drive there and back
 * when it counts, plus what ordering online adds. Undefined when nothing does.
 */
export function tripCosts(driving: TripCosts | undefined, online: Record<string, OnlineCost> | undefined): TripCosts | undefined {
  if (!driving && !online) return undefined;
  const out: TripCosts = { ...driving };
  for (const [id, c] of Object.entries(online ?? {})) if (c.extra) out[id] = round((out[id] ?? 0) + c.extra);
  return out;
}

/** What ordering online adds at each store, by retailer, for the fees verdict (see driveVerdict). */
export function extrasOf(online: Record<string, OnlineCost>): TripCosts {
  return Object.fromEntries(Object.entries(online).map(([id, c]) => [id, c.extra]));
}

/** The baskets that can be ordered the way the user shops (all of them in store). */
export function orderable(baskets: Basket[], online: Record<string, OnlineCost> | undefined): Basket[] {
  return online ? baskets.filter((b) => online[b.retailerId]?.available !== false) : baskets;
}

/** Plans the user doesn't have that would make this order cheaper, and by how much, best first. */
export function planOffers(retailerId: string, way: OnlineWay, items: number, ctx: FeeContext): { plan: OnlinePlan; saves: number }[] {
  const now = onlineCost(retailerId, way, items, ctx).total;
  return (ctx.rules?.plans ?? [])
    .filter((p) => !ctx.plans[p.id] && p[way])
    .map((plan) => ({ plan, saves: round(now - onlineCost(retailerId, way, items, { ...ctx, plans: { ...ctx.plans, [plan.id]: true } }).total) }))
    .filter((o) => o.saves > 0)
    .sort((a, b) => b.saves - a.saves);
}

/** Every plan the given stores take, once each, with the stores it works at, for the settings. */
export function plansAt(retailers: RetailerConfig[]): { plan: OnlinePlan; retailerIds: string[] }[] {
  const out = new Map<string, { plan: OnlinePlan; retailerIds: string[] }>();
  for (const r of retailers) {
    for (const plan of r.online?.plans ?? []) {
      const had = out.get(plan.id);
      if (had) had.retailerIds.push(r.id);
      else out.set(plan.id, { plan, retailerIds: [r.id] });
    }
  }
  return [...out.values()];
}

// --- Words ------------------------------------------------------------------------------------------------------

/** How a total is described: "in store", "for pickup", "delivered". */
export const MODE_WORDS: Record<ShopMode, string> = { store: 'in store', pickup: 'for pickup', delivery: 'delivered' };

/** The choice's name: "In store", "Pickup", "Delivery". */
export const MODE_NAMES: Record<ShopMode, string> = { store: 'In store', pickup: 'Pickup', delivery: 'Delivery' };

/** A part's name: "Delivery fee", "Online prices (+10%)", "Service fee (5%)". */
export function partLabel(part: CostPart, way: OnlineWay): string {
  if (part.kind === 'markup') return `Online prices (+${part.pct}%)`;
  if (part.kind === 'small') return 'Small-order fee';
  if (part.kind === 'service') return part.pct ? `Service fee (${part.pct}%)` : 'Service fee';
  return way === 'delivery' ? 'Delivery fee' : 'Pickup fee';
}

/** Why a fee is waived: "free on orders of $35 or more", "free with Walmart+", or both. */
export function waivedWords(w: NonNullable<CostPart['waived']>): string {
  const over = w.over !== undefined ? ` on orders of ${usd(w.over)} or more` : '';
  return w.plan ? `free with ${w.plan}${over}` : `free${over}`;
}

/** A plan's price: "$98 a year or $12.95 a month". */
export function planPrice(plan: OnlinePlan): string {
  return [plan.perYear !== undefined ? `${usd(plan.perYear)} a year` : '', plan.perMonth !== undefined ? `${usd(plan.perMonth)} a month` : '']
    .filter(Boolean)
    .join(' or ');
}

/**
 * A store's online costs in a line: "Delivery $6.99 · service fee $3.71", "Free pickup", "No delivery", with
 * "(estimate)" when the figures are the store rules', not read from its page.
 */
export function feesSummary(cost: OnlineCost): string {
  const way = cost.way === 'delivery' ? 'delivery' : 'pickup';
  if (!cost.available) return `No ${way}`;
  if (!cost.known) return 'Fees not known';
  const bits = cost.parts.flatMap((p) => {
    if (p.kind === 'fee') return [p.waived || !p.amount ? `free ${way}` : `${way} ${p.upTo !== undefined ? 'from ' : ''}$${p.amount.toFixed(2)}`];
    if (!p.amount) return [];
    if (p.kind === 'markup') return [`online prices +${p.pct}%`];
    return [`${p.kind === 'small' ? 'small-order fee' : 'service fee'} $${p.amount.toFixed(2)}`];
  });
  const estimated = cost.figures.filter((f) => f.from === 'rules').length;
  const text = bits.join(' · ');
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}${estimated === cost.figures.length ? ' (estimate)' : estimated ? ' (partly estimated)' : ''}`;
}

/**
 * Where a store's site shows its online prices (see `included` in OnlineRules), the prices read aren't its in-store
 * ones: said once, in store, beside its total. Undefined for every other store.
 */
export function inStoreCaveat(name: string, rules: OnlineRules | undefined): string | undefined {
  const m = rules?.markup;
  if (!m?.included) return undefined;
  return `${name}’s site shows its online prices: in store they’re likely about ${m.pct}% lower (${m.stated ? `${name}’s figure` : 'an estimate'}).`;
}

/** A rules date, '2026-09-25', as 'Sep 25, 2026'. */
export function checkedWords(checked: string): string {
  const at = new Date(`${checked}T12:00:00`);
  return Number.isNaN(at.getTime()) ? checked : at.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/** "2 h ago", "yesterday", "on Sep 22". */
const whenWords = (at: number, now: number): string => {
  const when = whenLabel(at, now);
  return /ago$|^just now$|^yesterday$/.test(when) ? when : `on ${when}`;
};

/** Figures named in a sentence: "the delivery fee and the service fee". */
function figureNames(figures: Figure[]): string {
  const names = figures.map((f) => f.name);
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : (names[0] ?? '');
}

/** The host a store's fees pages are on, without "www.": "walmart.com". */
export function feesHost(rules: OnlineRules | undefined): string | undefined {
  const url = rules?.feesUrl ?? rules?.pickupFeesUrl;
  return url ? hostOf(url).replace(/^www\./, '') : undefined;
}

/** The store's fees pages as one key, for the saved reads: its main page, and its pickup page when it has one. */
export function feesKey(rules: OnlineRules | undefined): string | undefined {
  const pages = [rules?.feesUrl, rules?.pickupFeesUrl].filter((u): u is string => !!u);
  return pages.length ? pages.join(' ') : undefined;
}

/**
 * Where a store's figures came from, in a sentence or two: its own fees page as the phone read it, or the store rules'
 * estimates, and why the page's figures aren't in use when they aren't.
 */
export function sourceWords(
  cost: OnlineCost,
  info: { name: string; rules?: OnlineRules; read?: FeeRead; reading?: boolean; now: number },
): string {
  const { name, rules, read, reading, now } = info;
  if (!cost.known || !rules) return `${name}’s online fees aren’t known, so its total is the items alone.`;
  const host = feesHost(rules);
  const fromPage = cost.figures.filter((f) => f.from === 'page');
  const fromRules = cost.figures.filter((f) => f.from === 'rules');
  const date = checkedWords(rules.checked);
  const out: string[] = [];
  if (fromPage.length && read?.feesAt !== undefined) {
    out.push(`From ${host}’s fees page, read on this phone ${whenWords(read.feesAt, now)}: ${figureNames(fromPage)}.`);
    if (fromRules.length) out.push(`Estimated from the store rules (checked ${date}): ${figureNames(fromRules)}.`);
  } else {
    out.push(`Estimates from the store rules, checked ${date}.`);
  }
  if (reading) out.push(`Reading ${host ?? name}’s fees page now…`);
  else if (host && read && !read.ok) out.push(`${host}’s fees page couldn’t be read ${whenWords(read.at, now)}: ${reasonWords(read.reason)}.`);
  else if (host && !read) out.push(`${host}’s fees page hasn’t been read yet.`);
  return out.join(' ');
}

/**
 * Where a store's fees for `way` stand, in a few words, for the settings: "read from walmart.com 2 h ago", "estimates
 * until target.com is read", "no delivery".
 */
export function feeStatusWords(cfg: RetailerConfig, way: OnlineWay, read: FeeRead | undefined, reading: boolean, now: number): string {
  const rules = cfg.online;
  if (!rules) return 'fees not known, so counted without them';
  if (!rules[way]) return `no ${way}${rules.note ? ` (${rules.note})` : ''}`;
  const host = feesHost(rules);
  if (reading) return `reading ${host ? `${host}’s` : 'its'} fees page now…`;
  if (!host) return `estimates from the store rules, checked ${checkedWords(rules.checked)}`;
  if (read?.fees && read.feesAt !== undefined) {
    const failed = !read.ok ? `; couldn’t read it again ${whenWords(read.at, now)}` : '';
    return `read from ${host} ${whenWords(read.feesAt, now)}${failed}`;
  }
  if (read && !read.ok) return `estimates, as ${host} couldn’t be read ${whenWords(read.at, now)} (${reasonWords(read.reason)})`;
  return `estimates until ${host} is read`;
}

/** What a plan does for orders, in a few words: "free delivery on orders of $35 or more". */
export function perksWords(plan: OnlinePlan): string {
  const bits: string[] = [];
  for (const way of ['delivery', 'pickup'] as const) {
    const p = plan[way];
    if (!p) continue;
    const what = way === 'delivery' ? 'delivery' : 'pickup';
    if (p.freeOver !== undefined) bits.push(`free ${what}${p.freeOver ? ` on orders of ${usd(p.freeOver)} or more` : ''}`);
    else if (p.fee !== undefined) bits.push(`${usd(p.fee)} ${what}`);
    if (p.service === null) bits.push(`no ${what} service fee`);
    else if (p.service) bits.push(`a ${p.service.pct}% ${what} service fee`);
    if (p.markup !== undefined) bits.push(`online prices about ${p.markup}% above in store`);
  }
  return bits.join(', ');
}
