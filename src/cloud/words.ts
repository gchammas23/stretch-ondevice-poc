import { money } from '../ui/theme';
import { MAX_MB_PER_BROWSER, MAX_RUN_COST_USD, MAX_RUNNING_JOBS, MAX_TERMS, MB_PER_PAGE, MB_PER_REDSKY, MIN_BALANCE_USD, PROXY_USD_PER_GB } from './config';
import { jobStatus, storeConfirmed, type CloudJob, type CloudRetailerId, type JobRequest, type RequestProblem, type RetailerRun, type RetailerStatus } from './jobs';

// Pure TypeScript: what the screens and notifications say about cloud jobs, in words.

export const RETAILER_NAMES: Record<CloudRetailerId, string> = { walmart: 'Walmart', target: 'Target', kroger: 'Kroger' };

export const STATUS_WORDS: Record<RetailerStatus, string> = {
  queued: 'Waiting to start',
  running: 'Searching',
  done: 'Done',
  blocked: 'Blocked by a bot check',
  failed: 'Failed',
  interrupted: 'Interrupted',
  cancelled: 'Cancelled',
};

const REASONS: Record<string, string> = {
  challenge: 'a “Robot or human?” check that didn’t clear in 45 s',
  store_not_set: 'pressing “Make this my store” didn’t change the store',
  no_store_button: 'its store page had no “Make this my store” button',
  no_store_page: 'the store’s own page on the site didn’t load as that store’s',
  target_store_not_set: 'Target kept a store of its own choosing: the one asked for couldn’t be set on its site',
  data_budget: `it moved over ${MAX_MB_PER_BROWSER} MB, the limit for one browser`,
  no_page_data: 'the search page had no data to read',
  no_search_results: 'the page’s data had no search results',
  no_search_request: 'the page didn’t send its own search request',
  replay_failed: 'its search request couldn’t be sent again',
  not_json: 'its search request answered with something other than data',
  app_closed: 'the app closed while it ran',
  app_slept: 'the phone paused the app, and the cloud browser’s connection dropped',
  connection: 'the connection to the cloud browser dropped',
  too_slow: 'it took too long',
  timeout: 'a page took too long to load',
  bad_json: 'the agent’s answer wasn’t the JSON asked for, even after a follow-up',
  agent_failed: 'the agent’s run failed',
  agent_cancelled: 'the agent’s run was cancelled',
  no_credit: 'Browser Use has no credit left',
  spend_limit: 'the API key reached its monthly spending cap',
  too_many_browsers: 'Browser Use is running too many browsers for this account',
  browser_api: 'Browser Use’s API refused the browser',
  no_cdp: 'the cloud browser gave no DevTools address',
  cancelled: 'you cancelled it',
  no_results: 'no search found anything',
  error: 'something went wrong',
  // This phone's own searches (a comparison's phone side, or Kroger's API).
  device_failed: 'the search on this phone failed',
  phone_check: 'a bot check on this phone (noted, not shown: nobody pressed it)',
  refused: 'the store refused the page',
  polite_limit: 'this phone’s searches an hour at the store were used up',
  cooling_down: 'the store is cooling down after a block on this phone',
};

/** Why a retailer is blocked, failed or interrupted, in words. */
export function reasonWords(reason: string | undefined): string {
  if (!reason) return '';
  const http = /^http_(\d{3})$/.exec(reason);
  if (http) return `the store answered HTTP ${http[1]}`;
  return REASONS[reason] ?? reason.replace(/_/g, ' ');
}

/** A retailer's line: "Done · prices for store 3081", "Blocked by a bot check: …". */
export function retailerLine(run: RetailerRun): string {
  if (run.status === 'done') {
    const confirmed = storeConfirmed(run);
    const mismatch = run.results.find((r) => r.storeMatches === false);
    if (mismatch) return `Done, but a search priced store ${mismatch.pageStoreId ?? '?'}, not ${run.storeId}`;
    return confirmed ? `Done · prices confirmed for store ${run.storeId}` : `Done · store ${run.storeId} not confirmed`;
  }
  const why = reasonWords(run.reason);
  return why && run.status !== 'running' && run.status !== 'queued' ? `${STATUS_WORDS[run.status]}: ${why}` : STATUS_WORDS[run.status];
}

/** Why a job couldn't start, in words. */
export function problemWords(p: RequestProblem): string {
  switch (p.problem) {
    case 'no_terms':
      return 'Type at least one thing to search for.';
    case 'too_many_terms':
      return `A cloud search takes at most ${MAX_TERMS} terms; this has ${p.count}.`;
    case 'no_retailers':
      return 'Pick at least one store.';
    case 'same_retailer_twice':
      return `One store per retailer: ${RETAILER_NAMES[p.retailerId]} is in it twice.`;
    case 'no_store':
      return `No ${RETAILER_NAMES[p.retailerId]} store is set. Set one in Your stores, or type its number under Stores.`;
    case 'too_many_jobs':
      return `${MAX_RUNNING_JOBS} cloud searches are running already. Start this one when one of them is done.`;
    case 'no_key':
      return 'No Browser Use API key. Add EXPO_PUBLIC_BROWSER_USE_API_KEY to .env, then restart Expo with --clear.';
    case 'balance_unknown':
      return `Couldn’t read the Browser Use balance${p.detail ? ` (${p.detail})` : ''}, so nothing was started.`;
    case 'low_balance':
      return `Browser Use has ${money(p.balanceUsd)} of credit left. Cloud searches don’t start below ${money(MIN_BALANCE_USD)}.`;
  }
}

/** The cheapest product a retailer found for a term, at its own store's price (flagged prices are left out). */
export function cheapest(run: RetailerRun, term: string): { name: string; price: number } | null {
  const result = run.results.find((r) => r.term === term && r.status === 'done' && r.storeMatches !== false);
  const priced = (result?.items ?? []).filter((i) => typeof i.price === 'number' && !i.sponsored);
  if (!priced.length) return null;
  const best = priced.reduce((a, b) => (b.price! < a.price! ? b : a));
  return { name: best.name, price: best.price! };
}

/** What the notification and the banner say when a job is over. */
export function jobNotice(job: CloudJob): { title: string; body: string } {
  const status = jobStatus(job);
  const names = (runs: RetailerRun[]) => runs.map((r) => RETAILER_NAMES[r.retailerId]).join(' and ');
  const what = job.terms.length === 1 ? `“${job.terms[0]}”` : `${job.terms.length} searches`;
  if (status === 'cancelled') return { title: 'Cloud search cancelled', body: what };
  const trouble = job.retailers.filter((r) => r.status !== 'done');
  const done = job.retailers.filter((r) => r.status === 'done');
  if (status === 'interrupted') {
    return { title: 'Cloud search interrupted', body: `${what} at ${names(trouble.filter((r) => r.status === 'interrupted'))}: open it to try again.` };
  }
  if (!done.length) return { title: 'Cloud search didn’t work', body: `${what}: ${trouble.map((r) => `${RETAILER_NAMES[r.retailerId]} ${STATUS_WORDS[r.status].toLowerCase()}`).join(', ')}` };
  const parts =
    job.terms.length === 1
      ? done.map((r) => {
          const best = cheapest(r, job.terms[0]);
          return `${RETAILER_NAMES[r.retailerId]} ${best ? money(best.price) : 'none'}`;
        })
      : [`done at ${names(done)}`];
  const rest = trouble.map((r) => `${RETAILER_NAMES[r.retailerId]} ${STATUS_WORDS[r.status].toLowerCase()}`);
  return { title: `Cloud search ready: ${what}`, body: [...parts, ...rest].join(' · ') };
}

/** "$0.04", or "under 1¢". */
export function costWords(usd: number): string {
  if (usd <= 0) return '$0.00';
  return usd < 0.01 ? 'under 1¢' : money(usd);
}

/**
 * What a job may cost before it starts: a scripted browser's pages at the measured 2.6 MB each (Walmart's home and
 * store pages, then a page per term; Target's store page and one search page, then a small answer per term) through the
 * $5/GB proxy, plus a little browser time; an agent run at most its cap. A store kept from its last run skips its
 * store pages, so this is the most a store's pages cost.
 */
export function estimate(req: Pick<JobRequest, 'terms' | 'retailers'>): { usd: number; capped: boolean } {
  const n = req.terms.length;
  let usd = 0;
  let capped = false;
  for (const r of req.retailers) {
    if (r.via === 'agent') {
      usd += MAX_RUN_COST_USD;
      capped = true;
    } else if (r.via === 'browser') {
      const mb = r.retailerId === 'walmart' ? (2 + n) * MB_PER_PAGE : 2 * MB_PER_PAGE + n * MB_PER_REDSKY;
      usd += (mb / 1000) * PROXY_USD_PER_GB + 0.001;
    }
  }
  return { usd, capped };
}

/** "about 4¢", "up to $1.50 (each agent run is capped)", "nothing: it's all on this phone". */
export function estimateWords(req: Pick<JobRequest, 'terms' | 'retailers'>): string {
  const { usd, capped } = estimate(req);
  if (usd <= 0) return 'nothing: it’s all on this phone';
  if (capped) return `up to ${money(usd)} (each agent run is capped at ${money(MAX_RUN_COST_USD)}; a follow-up, when an answer needs one, is another run)`;
  return usd < 0.01 ? 'under 1¢' : `about ${Math.max(1, Math.round(usd * 100))}¢`;
}
