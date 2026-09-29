import { z } from 'zod';
import { moneyFromText } from '../onDevice/json';
import { sameStoreId } from '../onDevice/storeIdentity';
import { parseSize } from '../pricing/sizes';
import { AGENT_ITEMS_PER_TERM } from './config';
import type { CloudItem } from './jobs';

// Pure TypeScript: the agent engine's side of a job. One Browser Use agent run per retailer is told, in words, to set
// the store on the retailer's own site, search each term and answer with JSON only. API v4 hands the answer back as
// text (run.result), with no output schema, so it's checked here with zod; an answer that isn't the JSON asked for gets
// one follow-up in the run's session (see runner.ts).

export type AgentRetailer = 'walmart' | 'target';

/**
 * Each site: its store step (straight to the store's own page, rather than through a store locator: Target serves
 * target.com/sl/<name>/<number> for any name, checked 2026-09-29), its search page for a term (opened directly rather
 * than typed into its search box), and where its item numbers are.
 */
const SITES: Record<AgentRetailer, { name: string; host: string; storeStep: (id: string) => string; search: (term: string) => string; itemId: string }> = {
  walmart: {
    name: 'Walmart',
    host: 'https://www.walmart.com',
    storeStep: (id) =>
      `Open https://www.walmart.com/store/${id}, Walmart's own page for store ${id}, and make it your store with its "Make this my store" button. If the page says it is your store already, go on.`,
    search: (term) => `https://www.walmart.com/search?q=${encodeURIComponent(term)}`,
    itemId: "Walmart's item number (in the product's link, after /ip/)",
  },
  target: {
    name: 'Target',
    host: 'https://www.target.com',
    storeStep: (id) =>
      `Open https://www.target.com/sl/store/${id}, Target's own page for store ${id}, and make it your store with its "Shop this store" button. If the page says it is your store already, go on.`,
    search: (term) => `https://www.target.com/s?searchTerm=${encodeURIComponent(term)}`,
    itemId: "Target's item number, the TCIN (in the product's link, after /A-)",
  },
};

const example = (retailer: AgentRetailer, storeId: string, term: string) =>
  JSON.stringify({
    retailer,
    storeId,
    storeConfirmed: true,
    items: [{ term, name: 'Product name as shown', price: 3.32, unitPrice: '2.6 ¢/fl oz', size: '1 gal', itemId: '123456', url: `${SITES[retailer].host}/…` }],
  });

/** The words an agent run is given: set the store, search each term, answer with JSON only, never solve a check. */
export function agentTask(retailer: AgentRetailer, storeId: string, terms: string[]): string {
  const site = SITES[retailer];
  return [
    `You are checking grocery prices at one ${site.name} store, number ${storeId}.`,
    `1. ${site.storeStep(storeId)}`,
    `2. Search for each of these terms, one at a time, by opening its search page directly: ${terms.map((t) => `${JSON.stringify(t)} at ${site.search(t)}`).join(', ')}.`,
    `3. For each term, read the first ${AGENT_ITEMS_PER_TERM} products on its results page, in the order shown: no more, and don't open the products' own pages.`,
    'If a human-verification check appears (such as "Robot or human?" or a "Press & Hold" button), do not try to solve it. Wait about 30 seconds without doing anything. If it is still there, stop and return exactly {"blocked": true}.',
    'Return ONLY JSON, with no other text before or after it, in this form:',
    example(retailer, storeId, terms[0] ?? 'milk'),
    `- storeConfirmed: true only if the site shows store ${storeId} as your store when you search.`,
    '- price: the price the site shows for that store, as a number in dollars; null if it shows none.',
    '- unitPrice and size: as the page shows them, or null.',
    `- itemId: ${site.itemId}.`,
    '- term: the search term the product came from.',
  ].join('\n');
}

/** The one follow-up, in the same session, when the answer wasn't the JSON asked for. */
export function followUpTask(retailer: AgentRetailer, storeId: string, terms: string[], why: string): string {
  return [
    `Your last answer was not the JSON I asked for (${why}).`,
    'Do not search again: use what you already found.',
    'Reply with ONLY the JSON, nothing before or after it, in this form:',
    example(retailer, storeId, terms[0] ?? 'milk'),
    `Include at most ${AGENT_ITEMS_PER_TERM} items per term. If a human-verification check stopped you, reply with exactly {"blocked": true}.`,
  ].join('\n');
}

/** A price as a number: 3.32, or "$3.32" read as one. */
const price = z
  .union([z.number(), z.string(), z.null()])
  .optional()
  .transform((v): number | null => {
    if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? v : null;
    if (typeof v === 'string') return moneyFromText(v) ?? (/^\s*\d+(\.\d{1,2})?\s*$/.test(v) ? Number(v) : null);
    return null;
  });
const words = z
  .union([z.string(), z.number(), z.null()])
  .optional()
  .transform((v) => (v === null || v === undefined ? undefined : String(v).trim() || undefined));

const ItemSchema = z.object({
  term: words,
  name: z.string().trim().min(1),
  price,
  unitPrice: words,
  size: words,
  itemId: z.union([z.string().trim().min(1), z.number()]).transform(String),
  url: words,
});

const AnswerSchema = z.object({
  retailer: z.string(),
  storeId: z.union([z.string(), z.number()]).transform(String),
  storeConfirmed: z.boolean(),
  items: z.array(z.unknown()),
});

const BlockedSchema = z.object({ blocked: z.literal(true) });

/** The JSON in an agent's answer: all of it, or inside a code fence, or from its first { to its last }. */
export function extractJson(raw: string): unknown {
  let text = raw.trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fence) text = fence[1].trim();
  try {
    return JSON.parse(text);
  } catch {
    const a = text.indexOf('{');
    const b = text.lastIndexOf('}');
    if (a !== -1 && b > a) {
      try {
        return JSON.parse(text.slice(a, b + 1));
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
}

export type AgentReading =
  | { kind: 'blocked' }
  | {
      kind: 'ok';
      /** The agent says the site showed the store as set. */
      storeConfirmed: boolean;
      /** The store it answered for is the job's. */
      storeMatches: boolean;
      answeredStoreId: string;
      /** Products by search term (the job's own spelling); '' for ones it didn't say the term of. */
      byTerm: Record<string, CloudItem[]>;
      /** Items left out for not being valid. */
      dropped: number;
    }
  | { kind: 'invalid'; why: string };

const absolute = (url: string | undefined, host: string) => (!url ? undefined : url.startsWith('http') ? url : url.startsWith('/') ? `${host}${url}` : undefined);

/**
 * Reads an agent run's answer against the job: `{"blocked": true}`, or the retailer, store and items asked for, each
 * item validated on its own (invalid ones are dropped; all of them invalid makes the answer invalid). At most
 * AGENT_ITEMS_PER_TERM items are kept per term.
 */
export function readAgentAnswer(raw: string | undefined, output: unknown, job: { retailer: AgentRetailer; storeId: string; terms: string[] }): AgentReading {
  const value = output !== undefined && output !== null && typeof output === 'object' ? output : raw ? extractJson(raw) : undefined;
  if (value === undefined) return { kind: 'invalid', why: raw?.trim() ? 'it was not JSON' : 'it was empty' };
  if (BlockedSchema.safeParse(value).success) return { kind: 'blocked' };
  const answer = AnswerSchema.safeParse(value);
  if (!answer.success) {
    const issue = answer.error.issues[0];
    return { kind: 'invalid', why: issue ? `${issue.path.join('.') || 'the answer'}: ${issue.message}` : 'it had the wrong shape' };
  }
  if (!answer.data.retailer.toLowerCase().includes(job.retailer)) return { kind: 'invalid', why: `it was for ${answer.data.retailer}, not ${job.retailer}` };
  const host = SITES[job.retailer].host;
  const byTerm: Record<string, CloudItem[]> = Object.fromEntries(job.terms.map((t) => [t, [] as CloudItem[]]));
  let dropped = 0;
  for (const raw of answer.data.items) {
    const item = ItemSchema.safeParse(raw);
    if (!item.success) {
      dropped++;
      continue;
    }
    const said = item.data.term?.toLowerCase();
    const term = job.terms.find((t) => t.toLowerCase() === said) ?? (job.terms.length === 1 ? job.terms[0] : '');
    const list = (byTerm[term] ??= []);
    if (list.length >= AGENT_ITEMS_PER_TERM || list.some((i) => i.itemId === item.data.itemId)) continue;
    const size = item.data.size ?? parseSize(item.data.name)?.text;
    const url = absolute(item.data.url, host);
    list.push({
      itemId: item.data.itemId,
      name: item.data.name,
      price: item.data.price,
      ...(item.data.unitPrice ? { unitPrice: item.data.unitPrice } : {}),
      ...(size ? { size } : {}),
      ...(url ? { url } : {}),
    });
  }
  if (answer.data.items.length > 0 && dropped === answer.data.items.length) return { kind: 'invalid', why: 'none of its items had a name and an item number' };
  return {
    kind: 'ok',
    storeConfirmed: answer.data.storeConfirmed,
    storeMatches: sameStoreId(answer.data.storeId, job.storeId),
    answeredStoreId: answer.data.storeId,
    byTerm,
    dropped,
  };
}
