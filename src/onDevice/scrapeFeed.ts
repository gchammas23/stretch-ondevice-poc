// Pure TypeScript: what the phone just did, newest first, for Watch it scrape.

export interface FeedEvent {
  id: number;
  at: number;
  retailerId: string;
  retailer: string;
  /** What was searched for, or "product page", "store". */
  what: string;
  ok: boolean;
  /** "24 products · 0.8 s · reused its page", "failed: bot check". */
  text: string;
}

const KEPT = 40;

export class ScrapeFeed {
  private events: FeedEvent[] = [];
  private nextId = 1;
  private listeners = new Set<() => void>();

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): FeedEvent[] => this.events;

  add(event: Omit<FeedEvent, 'id'>): void {
    this.events = [{ ...event, id: this.nextId++ }, ...this.events].slice(0, KEPT);
    this.listeners.forEach((listener) => listener());
  }
}

const REASONS: Record<string, string> = {
  no_payload: 'no product data',
  timeout: 'too slow',
  challenge: 'bot check',
  challenge_timeout: 'bot check not finished',
  challenge_cancelled: 'bot check skipped',
  network: 'no connection',
  page_crashed: 'page stopped',
  no_products_on_page: 'no products on the page',
  button_not_found: 'no store button',
  polite_limit: 'paused: an hour’s worth of searches at this store',
  no_fees: 'no fees on the page',
  no_fees_page: 'no fees page in the store rules',
  no_ad: 'no sale items on the page',
  no_coupons: 'no coupons on the page',
  no_coupons_page: 'no coupons page in the store rules',
  signed_out: 'signed out of the store’s site',
  other_site: 'a page on another site',
  coupon_not_found: 'the coupon isn’t on the page',
  no_clip_button: 'no clip button on the coupon',
  not_clipped: 'the page didn’t confirm it',
  busy: 'busy with searches',
  blocked: 'refused: a page that blocks this phone',
  tiny_page: 'a nearly empty page',
  cooling_down: 'cooling down after a block',
  connection: 'the connection dropped',
};

/** A failure reason in a few plain words. */
export const reasonWords = (reason: string | undefined): string => (reason ? (REASONS[reason] ?? reason.replace(/_/g, ' ')) : 'failed');

export const seconds = (ms: number): string => `${(Math.max(0, ms) / 1000).toFixed(1)} s`;

/** "40 KB", "2.4 MB": data sizes, about. */
export function bytesText(bytes: number): string {
  // A no-break space, so a wrapped line never leaves the unit on its own.
  if (bytes < 1000) return 'under 1\u00a0KB';
  if (bytes < 1_000_000) return `${Math.round(bytes / 1000)}\u00a0KB`;
  return `${(bytes / 1_000_000).toFixed(bytes < 10_000_000 ? 1 : 0)}\u00a0MB`;
}
