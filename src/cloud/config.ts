// Pure TypeScript. Cloud fetch: Walmart and Target read through Browser Use's cloud browsers instead of on this phone,
// as background jobs (see jobs.ts and runner.ts). Everything here is a guardrail or a measured figure: the POC runs on
// a small prepaid credit, so each limit is kept low and in one place.

/**
 * The Browser Use API key, from .env. Local testing only: EXPO_PUBLIC_ values are compiled into the app bundle, so
 * anyone with the build can read it. Node scripts may set BROWSER_USE_API_KEY instead.
 */
export const browserUseKey = (): string => process.env.EXPO_PUBLIC_BROWSER_USE_API_KEY || process.env.BROWSER_USE_API_KEY || '';

export const API_V4 = 'https://api.browser-use.com/api/v4';
/** The account's balance is only on the v2 API, for v4 keys too. */
export const BILLING_URL = 'https://api.browser-use.com/api/v2/billing/account';

/** A job searches at most this many terms. */
export const MAX_TERMS = 5;
/** Jobs running at once, at most: each can hold two cloud browsers or agent runs. */
export const MAX_RUNNING_JOBS = 2;
/** A job doesn't start when the account has less credit than this, in dollars. */
export const MIN_BALANCE_USD = 1;

/**
 * Minutes a cloud browser may live (the create request's `timeout`). Browser Use stops it then, whatever the app does:
 * the backstop when the app is killed before it can stop the browser itself. A store takes about 40 s, and 5 searches
 * about as long again.
 */
export const BROWSER_TIMEOUT_MIN = 10;
/** Labels every browser the app creates, so one it lost track of can be found and stopped (see runner.ts). */
export const BROWSER_LABEL = { app: 'stretch-poc' };
/** A scripted job stops driving a browser once it has moved this much data, in MB (about 2.6 MB a search page). */
export const MAX_MB_PER_BROWSER = 40;

/**
 * The agent engine's model: the one Browser Use's docs recommend for price and accuracy ("GPT-5.6 Luna", checked
 * 2026-09-28 on docs.browser-use.com/cloud/agent/models; the brief expected grok-4.5, which costs about 10× more per
 * input token). One constant, to change in one place.
 */
export const AGENT_MODEL = 'gpt-5.6-luna';
/**
 * How hard the agent's model thinks before each step: its `reasoning.effort`, sent as the run's modelParams. Browser
 * Use runs gpt-5.6-luna at "xhigh" unless told otherwise (its API reference, checked 2026-09-29), slow for a task of
 * opening pages and reading prices: a Target run took about 7 minutes. "medium" is a middle ground; "low" would be
 * faster still, and less careful.
 */
export const AGENT_MODEL_PARAMS = { reasoning: { effort: 'medium' } } as const;
/** Each agent run's own cost cap (the run's `maxCostUsd`): Browser Use stops the run past it. */
export const MAX_RUN_COST_USD = 0.75;
/** Agent runs are polled this often while the app is open. */
export const POLL_MS = 10_000;
/** Products kept per search term: the cloud browser's and this phone's, for Phone vs. cloud. */
export const ITEMS_PER_TERM = 20;
/** Products an agent is asked for per search term: fewer than the others keep, since reading each one takes it time. */
export const AGENT_ITEMS_PER_TERM = 10;

/**
 * Traffic saved by not loading these, blocked by file type only (Network.setBlockedURLs). Never by host:
 * i5.walmartimages.com also serves Walmart's JavaScript, and blocking it silently broke the store button. Never by
 * request interception either: it turns off the browser's cache, which about tripled the traffic in tests.
 */
export const HEAVY_FILES = ['*.png*', '*.jpg*', '*.jpeg*', '*.gif*', '*.webp*', '*.avif*', '*.svg*', '*.woff*', '*.ttf*', '*.mp4*'];

/** How long a bot check is left to clear by itself (Browser Use's solver may), and how often it's looked at meanwhile. */
export const PX_WAIT_MS = 45_000;
export const PX_RECHECK_MS = 10_000;
/** How long a page may take to load before the job gives up on it. */
export const NAV_TIMEOUT_MS = 60_000;
/** How long Walmart's store page has to show its "Make this my store" button. */
export const BUTTON_WAIT_MS = 15_000;
/** __NEXT_DATA__ can still be streaming when it's read: it's parsed this many times, this far apart. */
export const NEXT_DATA_TRIES = 3;
export const NEXT_DATA_RETRY_MS = 1_500;

/** Residential proxy traffic, measured in the Walmart tests and listed on Browser Use's pricing page. */
export const PROXY_USD_PER_GB = 5;
/** A Walmart page with heavy files blocked, as measured in the Walmart tests; a redsky answer is far smaller. */
export const MB_PER_PAGE = 2.6;
export const MB_PER_REDSKY = 0.4;
