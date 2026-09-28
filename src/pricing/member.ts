import type { Product } from '../onDevice/types';
import type { PricingRun, SearchResult } from './pricingEngine';

// Pure functions only, so the tests run them in Node.
//
// Member prices: many stores charge members of their loyalty program less ("with Card", "Club Price"). Searches keep
// both prices; these count the member price only at stores whose program the user belongs to. Nothing is searched
// again when that changes.

/** A product as a member pays for it: the member price, with the price everyone pays as the "was". */
export function asMember(p: Product): Product {
  if (p.memberPrice === undefined || typeof p.price !== 'number' || !(p.memberPrice < p.price)) return p;
  return { ...p, price: p.memberPrice, wasPrice: p.wasPrice ?? p.price, memberApplied: true };
}

/** A member price the user doesn't get (they're not a member there), to show beside the price. */
export const memberOffer = (p: Product | null): number | undefined =>
  p && !p.memberApplied && p.memberPrice !== undefined && typeof p.price === 'number' && p.memberPrice < p.price ? p.memberPrice : undefined;

/**
 * Each search's result as a member sees it, made once per result: a result the run didn't change keeps its products,
 * so a product page showing one doesn't read the product's page again every time another price lands.
 */
const memberResults = new WeakMap<SearchResult, SearchResult>();

function memberResult(r: SearchResult): SearchResult {
  let out = memberResults.get(r);
  if (!out) {
    out = r.products.some((p) => p.memberPrice !== undefined) ? { ...r, products: r.products.map(asMember) } : r;
    memberResults.set(r, out);
  }
  return out;
}

/** The member run last made from each run, and for which memberships: the screens showing a list share it. */
const memberRuns = new WeakMap<PricingRun, { memberships: Record<string, boolean>; run: PricingRun }>();

/** The run with member prices at the stores whose programs the user belongs to; the same run when there are none. */
export function memberRun(run: PricingRun, memberships: Record<string, boolean>): PricingRun {
  const at = run.retailerIds.filter((id) => memberships[id] && run.results[id]);
  if (!at.length) return run;
  const had = memberRuns.get(run);
  if (had?.memberships === memberships) return had.run;
  const results = { ...run.results };
  for (const id of at) results[id] = Object.fromEntries(Object.entries(results[id]).map(([k, r]) => [k, memberResult(r)]));
  const out = { ...run, results };
  memberRuns.set(run, { memberships, run: out });
  return out;
}
