import { PX_RECHECK_MS, PX_WAIT_MS } from './config';

// Pure TypeScript: PerimeterX, the bot check Walmart and Target use, as a cloud browser meets it. It shows up three
// ways on a page (from the Walmart tests): a redirect to /blocked, a page titled "Robot or human?", or a
// [role=dialog] saying "Robot or human?" drawn over a page that otherwise looks normal. An API it guards answers with
// HTTP 435 and a small JSON naming PerimeterX's app id instead (Target's redsky, seen from a server, 2026-09-28).
//
// The app never tries to solve it (never the "Press & Hold"): it stops driving the page and gives the browser time to
// clear it by itself (Browser Use's solver may), then gives up and calls the retailer blocked.

export type PxForm = 'blocked_url' | 'title' | 'dialog';

/** What the page shows, read by PX_SNAPSHOT inside it. */
export interface PageSnapshot {
  url: string;
  title: string;
  /** The text of each [role=dialog] on the page, short. */
  dialogs: string[];
}

const ROBOT = /robot\s+or\s+human/i;

/** The path of a URL, without its query or fragment ("/blocked"). */
function pathOf(url: string): string {
  const rest = url.replace(/^[a-z]+:\/\/[^/?#]*/i, '');
  return rest.split(/[?#]/)[0] || '/';
}

/** Which form of the bot check the page shows, or null when it shows none. */
export function pxForm(s: PageSnapshot): PxForm | null {
  if (/(?:^|\/)blocked(?:\/|$)/i.test(pathOf(s.url))) return 'blocked_url';
  if (ROBOT.test(s.title)) return 'title';
  if (s.dialogs.some((d) => ROBOT.test(d))) return 'dialog';
  return null;
}

/**
 * Run inside the page (in the app's own world, see PageSession.evaluate): its address, title and dialogs. Nothing on
 * the page is touched.
 */
export const PX_SNAPSHOT = `(() => {
  const dialogs = Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"]'))
    .map((el) => (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 300))
    .filter(Boolean)
    .slice(0, 5);
  return { url: location.href, title: document.title || '', dialogs };
})()`;

/** An API's answer that is PerimeterX's block, not data: HTTP 435, or its JSON (app id "PX…", a captcha script). */
export function pxBlockedAnswer(status: number, body: string): boolean {
  if (status === 435) return true;
  if (!/^\s*\{/.test(body) || body.length > 4000) return false;
  try {
    const json = JSON.parse(body) as Record<string, unknown>;
    return typeof json.appId === 'string' && /^PX/i.test(json.appId) && (typeof json.blockScript === 'string' || typeof json.jsClientSrc === 'string');
  } catch {
    return false;
  }
}

/**
 * After a bot check was seen: looks again every `everyMs` for up to `waitMs`, doing nothing else meanwhile. True when
 * it cleared (the browser's own solver, or the site letting it through), false when it's still there.
 */
export async function waitOutCheck(
  check: () => Promise<PxForm | null>,
  clock: { sleep: (ms: number) => Promise<void>; now: () => number },
  waitMs = PX_WAIT_MS,
  everyMs = PX_RECHECK_MS,
): Promise<boolean> {
  const deadline = clock.now() + waitMs;
  while (clock.now() < deadline) {
    await clock.sleep(Math.min(everyMs, Math.max(0, deadline - clock.now())));
    if (!(await check())) return true;
  }
  return false;
}
