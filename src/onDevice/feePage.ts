import type { FeeSchedule, OnlineWay } from './types';

// Pure functions only: no React Native imports, so the tests run them in Node.
//
// Reads what a store's own fees page says its online orders cost, from the page's text as the phone loaded it: the
// pickup and delivery fees, when they're waived, the minimum order, small-order and service fees, and whether it says
// its online prices are higher than in its stores. General rules, no code per store. A figure is only taken from a
// sentence that says plainly what it is, and sentences about memberships, express time slots, tips, EBT or shipping
// are left alone: those aren't what everyone pays for a standard order. When a sentence could mean two things, it's
// skipped, and the store rules' estimate stands.

/** What a store's fees page said, by way of ordering. */
export interface FeePageRead {
  pickup: Partial<FeeSchedule>;
  delivery: Partial<FeeSchedule>;
  /** The page says online prices are higher than in store: its words, and the figure when it gives one. */
  markup?: { said: string; pct?: number };
  /** The sentence each figure came from, by 'way.field' ('delivery.fee'), and 'markup'. */
  quotes: Record<string, string>;
  /** Figures found. */
  count: number;
}

export interface FeePageOptions {
  /** The store's plan names ("Walmart+", "Kroger Boost"): sentences about them aren't about everyone's fees. */
  planWords?: string[];
}

const DELIVERY = /\bdeliver(?:y|ies|ed)?\b/i;
const PICKUP = /\bpick\s?-?ups?\b|\bpick (?:it|them|your order|orders) up\b|\bcurbside\b|\bdrive\s?-?up\b|\bdriveup\b/i;
/** About a membership, a trial or a card: not what everyone pays. "Walmart+" and "Instacart+" end in a plus. */
const PLAN = /[a-z]\+|\bmembers?\b|\bmemberships?\b|\bsubscri|\btrial\b|\bpass holders?\b/i;
const NOT_PLAN = /\bnon-?members?\b|\bnon-?subscribers?\b|\bnon-[a-z]+\+|\bwithout (?:a |an )?(?:membership|subscription)\b/gi;
/** Faster (or rarer) than a standard order: "Express", "3 hr. or less". */
const EXPRESS = /\b(?:express|priority|expedited|rush)\b|\b\d+\s*(?:hr|hour)s?\.?\s*or less\b|\bunder an hour\b/i;
const OTHER = /\b(?:tips?|tipping|gratuity|bags?|alcohol|taxe?s?|heavy|oversized?|shipping|ship to home|marketplace|returns?|refunds?|ebt|snap)\b/i;
/** A welcome offer, not what an order costs: "free on your first order over $35". */
const PROMO = /\bfirst (?:order|delivery|pickup|purchase)\b|\bnew customers?\b|\bpromo(?:tion(?:al)?)? codes?\b/i;
/** A small-order or below-minimum fee, as opposed to the order's own fee. */
const SMALL = /\bsmall[- ]?(?:order|basket)\b|\b(?:below|under)[- ]minimum\b|\bminimum[- ]order fee\b|\bbasket fee\b|\bdon[’']?t (?:reach|meet) (?:the|a|our) \$[\d.,]+ (?:order )?minimum\b/i;
const MONEY = /\$\s?(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?)/g;
const AMOUNT = '\\$\\s?(\\d{1,3}(?:,\\d{3})*(?:\\.\\d{1,2})?)';
const UNDER = `\\b(?:orders?|baskets?|purchases?|subtotals?)\\s+(?:of\\s+)?(?:under|below|less than)\\s+${AMOUNT}`;

const num = (s: string): number => Number(s.replace(/,/g, ''));

/** Plausible figures only: anything else is some other number on the page. */
const OK: Record<keyof FeeSchedule, (v: number) => boolean> = {
  fee: (v) => v >= 0 && v <= 30,
  feeMax: (v) => v > 0 && v <= 40,
  freeOver: (v) => v >= 10 && v <= 250,
  minimum: (v) => v >= 5 && v <= 150,
  smallFee: (v) => v > 0 && v <= 20,
  smallUnder: (v) => v >= 5 && v <= 150,
  service: () => true,
};

/** The page's text as sentences: a line per block, split after full stops, dashes and spaces made plain. */
export function sentencesOf(text: string): string[] {
  return text
    .replace(/ /g, ' ')
    .replace(/[‐-―−]/g, '-')
    .replace(/[‘’]/g, '’')
    .replace(/([.!?])\s+(?=["“(]?[A-Z$0-9])/g, '$1\n')
    .split(/\n+/)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => s.length >= 3 && s.length <= 400);
}

/** Which ways a sentence is about. */
function waysOf(s: string): OnlineWay[] {
  return [...(DELIVERY.test(s) ? (['delivery'] as const) : []), ...(PICKUP.test(s) ? (['pickup'] as const) : [])];
}

/** Says online prices are higher than in the store's own stores (or warehouses). */
export function markupIn(s: string): { said: string; pct?: number } | null {
  const higher =
    /\b(?:prices?|pricing)\b[^.]*?\b(?:(?:higher|more)\s+than|above)\b[^.]*?\b(?:in[- ]?stores?|in[- ]?warehouses?|in[- ]?clubs?|(?:in|at)\s+(?:our|the|a|your|your local)\s+(?:stores?|warehouses?|clubs?|locations?)|your local (?:stores?|warehouses?|clubs?)|physical (?:stores?|store locations?)|shelf prices?)/i.test(s) ||
    /\b(?:(?:higher|more)\s+than|above)\s+(?:the\s+)?(?:in[- ]?store|in[- ]?warehouse|in[- ]?club|shelf)\b/i.test(s);
  if (!higher || /\b(?:not|never|no|isn[’']t|aren[’']t)\b[^.]{0,24}\b(?:higher|more|markup)\b/i.test(s)) return null;
  const pct = /(\d{1,2}(?:\.\d+)?)\s?%/.exec(s);
  const value = pct ? Number(pct[1]) : undefined;
  return { said: s, ...(value !== undefined && value >= 1 && value <= 40 ? { pct: value } : {}) };
}

type Setter = (way: OnlineWay, field: keyof FeeSchedule, value: FeeSchedule[keyof FeeSchedule], quote: string, over?: boolean) => void;

/**
 * Everything a store's fees page says, from its text. Each figure is the first one the page gives for it (a
 * "standard" delivery or pickup fee beats one given earlier), from sentences about one or both ways of ordering, or
 * following a heading about one.
 */
export function parseFeePage(text: string, opts: FeePageOptions = {}): FeePageRead {
  const out: FeePageRead = { pickup: {}, delivery: {}, quotes: {}, count: 0 };
  const planWords = (opts.planWords ?? []).map((w) => w.toLowerCase()).filter((w) => w.length >= 3);
  // A sentence that names no way belongs to the last one named on its own (a section heading, say).
  let context: OnlineWay[] = [];

  const set: Setter = (way, field, value, quote, over = false) => {
    if (out[way][field] !== undefined && !over) return;
    if (typeof value === 'number' && !OK[field](value)) return;
    if (out[way][field] === undefined) out.count++;
    Object.assign(out[way], { [field]: value });
    out.quotes[`${way}.${field}`] = quote;
  };

  for (const s of sentencesOf(text)) {
    if (!out.markup) {
      const m = markupIn(s);
      if (m) {
        out.markup = m;
        out.quotes.markup = s;
        out.count++;
      }
    }
    const named = waysOf(s);
    if (named.length === 1) context = named;
    const ways = named.length ? named : context;
    if (!ways.length || !/\$|%|\bfree\b|\bno\b/i.test(s)) continue;
    const lower = s.toLowerCase().replace(NOT_PLAN, '');
    if (PLAN.test(lower) || planWords.some((w) => lower.includes(w)) || EXPRESS.test(s) || OTHER.test(s) || PROMO.test(s)) continue;
    for (const way of ways) readSentence(s, way, set, out[way]);
  }
  // A range only holds with its bottom figure.
  for (const way of ['pickup', 'delivery'] as const) {
    const w = out[way];
    if (w.feeMax !== undefined && (w.fee === undefined || w.feeMax <= w.fee)) {
      delete w.feeMax;
      delete out.quotes[`${way}.feeMax`];
      out.count--;
    }
  }
  return out;
}

/** The figures one sentence gives for one way, given what the page has said about that way so far. */
function readSentence(s: string, way: OnlineWay, set: Setter, known: Partial<FeeSchedule>): void {
  const wayWords = way === 'delivery' ? 'delivery' : '(?:pick\\s?-?up|curbside|drive\\s?-?up)';
  // "the delivery fee", "delivery costs", "Fast delivery is $7.99".
  const namesFee = new RegExp(`\\b${wayWords}\\s+(?:fees?|charges?|costs?)\\b|\\b${wayWords}\\s+(?:is|costs?)\\s+\\$`, 'i').test(s);
  const small = SMALL.test(s);
  const saysFree = new RegExp(
    way === 'delivery'
      ? '\\bfree delivery\\b|\\bdelivery is (?:always )?free\\b|\\bno delivery fees?\\b|\\bdeliver(?:ed|s)? for free\\b'
      : '\\bfree (?:pick\\s?-?up|curbside|drive\\s?-?up)\\b|\\b(?:pick\\s?-?up|curbside|drive\\s?-?up) is (?:always )?free\\b|\\bno (?:pick\\s?-?up|curbside|drive\\s?-?up) fees?\\b|\\bpick (?:it|them|your order|orders) up for free\\b|\\bpick\\s?-?up for free\\b',
    'i',
  ).test(s);

  // "Orders under $35 have a $6.99 fee" and its turns of phrase. A small-order fee when the sentence says so; with
  // "free" in it, this way's fee and the order size it's free from; otherwise it's unclear which, and it's skipped.
  const under =
    new RegExp(`${UNDER}[^.]*?${AMOUNT}`, 'i').exec(s) ??
    swap(new RegExp(`${AMOUNT}[^.$]*?\\b(?:fee|charge|surcharge)s?\\b[^.$]*?${UNDER}`, 'i').exec(s)) ??
    swap(new RegExp(`\\b(?:fee|charge|surcharge)s?\\b[^.$]{0,30}${AMOUNT}[^.$]*?${UNDER}`, 'i').exec(s)) ??
    new RegExp(`\\bdon[’']?t (?:reach|meet) (?:the|a|our) ${AMOUNT} (?:order )?minimum[^.]*?${AMOUNT}`, 'i').exec(s);
  if (under) {
    const [below, fee] = [num(under[1]), num(under[2])];
    if (small) {
      set(way, 'smallUnder', below, s);
      set(way, 'smallFee', fee, s);
    } else if (/\bfree\b/i.test(s) || (namesFee && known.freeOver === below)) {
      // Said with "free", or after the page said this way is free from that same order size.
      set(way, 'fee', fee, s);
      set(way, 'freeOver', below, s);
    }
    return;
  }

  // The smallest order it takes. Not from a sentence about the service fee, whose own floor is "a $2 minimum".
  const service = /\bservice fees?\b/i.test(s);
  if (!small && !service) {
    const min =
      new RegExp(`\\bminimum\\s+(?:order|purchase|basket|subtotal)s?\\b[^.$]{0,30}${AMOUNT}`, 'i').exec(s) ??
      new RegExp(`\\border\\s+minimum\\b[^.$]{0,30}${AMOUNT}`, 'i').exec(s) ??
      new RegExp(`${AMOUNT}\\s*(?:order\\s+)?minimum\\b`, 'i').exec(s) ??
      (!/\bfees?\b/i.test(s) ? new RegExp(`\\bminimum\\b[^.$]{0,30}${AMOUNT}`, 'i').exec(s) : null) ??
      new RegExp(`\\borders?\\s+must\\s+(?:be|total|meet)\\s+(?:at least\\s+)?${AMOUNT}`, 'i').exec(s) ??
      // "a $9.99 delivery fee per order over $35": only orders over it.
      (namesFee ? new RegExp(`\\bper order (?:over|above|of at least)\\s+${AMOUNT}`, 'i').exec(s) : null);
    if (min && !/\bfree\b/i.test(s)) set(way, 'minimum', num(min[1]), s);
  }

  const free =
    new RegExp(`\\bfree\\b[^.]*?\\b(?:orders?|purchases?|baskets?)\\s+(?:of|over|above|totaling|totalling|at least|worth)?\\s*${AMOUNT}`, 'i').exec(s) ??
    // "There is no pickup fee for orders over $35."
    new RegExp(`\\bno\\s+(?:${wayWords}\\s+)?(?:fees?|charges?)\\b[^.]*?\\b(?:orders?|purchases?|baskets?)\\s+(?:of|over|above|totaling|totalling|at least)\\s+${AMOUNT}`, 'i').exec(s) ??
    new RegExp(`\\bfree\\b[^.]*?${AMOUNT}\\s*(?:\\+|or more|and up|and above|or above|minimum)`, 'i').exec(s) ??
    new RegExp(`\\b(?:orders?|purchases?)\\s+(?:of|over|above)\\s+${AMOUNT}[^.]*?\\b(?:free|no (?:delivery |pickup )?fee)\\b`, 'i').exec(s);
  if (free) set(way, 'freeOver', num(free[1]), s);
  // "Free on orders of $35 or more, otherwise a $4.95 fee": the figure left is the fee under that, whatever the page
  // calls it (Kroger calls it a service fee).
  const otherwise = !!free && /\botherwise\b|\bbelow that\b|\bunder that\b/i.test(s);

  // "We're waiving our service fees", "no service fees on pickup orders": none.
  const noService = /\b(?:waiv\w*|no|free of|without)\b[^.]{0,24}\bservice fees?\b|\bservice fees?\b[^.]{0,24}\b(?:waived|free)\b/i.test(s);
  if (service && noService) set(way, 'service', { pct: 0 }, s);
  if (service && !noService && !otherwise) {
    const pct = /(\d{1,2}(?:\.\d+)?)\s?%/.exec(s);
    const floor =
      new RegExp(`\\b(?:minimum|min\\.?|at least|starting at|starts at|as low as)\\s*(?:of\\s*)?${AMOUNT}`, 'i').exec(s) ??
      new RegExp(`${AMOUNT}\\s*(?:minimum|min\\.?)\\b`, 'i').exec(s);
    const ceiling = new RegExp(`\\b(?:maximum|max\\.?|up to|no more than|capped at|at most)\\s*(?:of\\s*)?${AMOUNT}`, 'i').exec(s);
    const amounts = [...s.matchAll(MONEY)].map((m) => num(m[1]));
    if (pct && Number(pct[1]) > 0 && Number(pct[1]) <= 25) {
      set(way, 'service', { pct: Number(pct[1]), ...(floor ? { min: num(floor[1]) } : {}), ...(ceiling ? { max: num(ceiling[1]) } : {}) }, s);
    } else if (!pct && amounts.length === 1 && amounts[0] > 0 && amounts[0] <= 15) {
      set(way, 'service', { pct: 0, min: amounts[0], max: amounts[0] }, s);
    }
    // A sentence about the service fee isn't about the delivery or pickup fee.
    if (!namesFee) return;
  }

  // The amounts left once order sizes are taken out ("orders of $35 or more", "a $35 minimum", "per order over $35").
  const rest = s
    .replace(new RegExp(`\\b(?:orders?|purchases?|baskets?|subtotals?)\\s+(?:of|over|above|under|below|less than|at least|totaling|totalling|worth)?\\s*${AMOUNT}\\s*\\+?`, 'gi'), '')
    .replace(new RegExp(`${AMOUNT}\\s*(?:\\+|or more|and up|and above|or above|(?:order\\s+)?minimum)`, 'gi'), '')
    .replace(new RegExp(`\\bminimum\\b[^.$]{0,40}${AMOUNT}`, 'gi'), '');
  const amounts = [...rest.matchAll(MONEY)].map((m) => num(m[1]));
  if (!amounts.length) {
    // "Pickup is free", "pick them up for free": no fee, when no order size is attached.
    if (saysFree && !free) set(way, 'fee', 0, s);
    return;
  }
  if (!namesFee && !otherwise && !/\bfees?\b/i.test(s)) return;
  const lo = Math.min(...amounts);
  const hi = Math.max(...amounts);
  const standard = /\bstandard\b/i.test(s);
  set(way, 'fee', lo, s, standard);
  if (hi > lo) set(way, 'feeMax', hi, s, standard);
}

/**
 * Two pages' figures as one: a store's main fees page, and its page about pickup when it has one. Pickup figures come
 * from the pickup page first, delivery figures from the main page first; either fills in what the other lacks.
 */
export function mergeFeeReads(main: FeePageRead | undefined, pickupPage: FeePageRead | undefined): FeePageRead {
  const out: FeePageRead = { pickup: {}, delivery: {}, quotes: {}, count: 0 };
  const take = (way: OnlineWay, from: (FeePageRead | undefined)[]) => {
    for (const read of from) {
      if (!read) continue;
      for (const [field, value] of Object.entries(read[way]) as [keyof FeeSchedule, FeeSchedule[keyof FeeSchedule]][]) {
        if (value === undefined || out[way][field] !== undefined) continue;
        Object.assign(out[way], { [field]: value });
        const quote = read.quotes[`${way}.${field}`];
        if (quote) out.quotes[`${way}.${field}`] = quote;
        out.count++;
      }
    }
  };
  take('pickup', [pickupPage, main]);
  take('delivery', [main, pickupPage]);
  const markup = main?.markup ?? pickupPage?.markup;
  if (markup) {
    out.markup = markup;
    out.quotes.markup = markup.said;
    out.count++;
  }
  return out;
}

/** A match of a fee-first form, with its figures in the order of the other forms: the order size, then the fee. */
function swap(m: RegExpExecArray | null): RegExpExecArray | null {
  if (!m) return null;
  const out = [...m] as unknown as RegExpExecArray;
  out[1] = m[2];
  out[2] = m[1];
  return out;
}
