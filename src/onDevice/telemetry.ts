import type { Attempt } from './types';

export interface AttemptEvent extends Attempt {
  retailer: string;
  configVersion: string;
  /**
   * How a search's list was read: where the store's profile says ('profile'), by the general reader ('general'), or by
   * the general reader because the profile didn't match ('missed'). See profiles.ts.
   */
  read?: 'profile' | 'general' | 'missed';
  /** The wrong-list rule suspects the list: it may not be the store's results (see judgeList in parsers.ts). */
  suspect?: boolean;
}

/**
 * A note, not a try: a store (or one way of searching it) cooling down after a block, or resting; the connection
 * dropping (every store failing within seconds of each other); a store's profile learned (see profiles.ts).
 */
export type NoteEvent =
  | { note: 'cooldown'; retailer: string; way?: string; block: string; said?: string; minutes: number; configVersion: string }
  | { note: 'connection'; stores: string[]; seconds: number; lifted: number; configVersion: string }
  | { note: 'profile'; retailer: string; where: string; searches: number; configVersion: string };

/**
 * Health signal only: no search text, product data, cookies or user ids.
 * Set EXPO_PUBLIC_TELEMETRY_URL to POST events to the Stretch backend.
 */
export function reportAttempt(event: AttemptEvent): void {
  // A failure's detail can name the page, whose title may include the search, so it never leaves the phone.
  const { detail: _detail, ...health } = event;
  console.log('[on-device-search]', JSON.stringify(health));

  const url = process.env.EXPO_PUBLIC_TELEMETRY_URL;
  if (!url) return;
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...health, at: new Date().toISOString() }),
  }).catch(() => {
    // Telemetry must never break a search.
  });
}

/**
 * Notes go in the log under their own tag, apart from tries (`[on-device-search]`), so counts of tries stay as they
 * were. Health signal only, like tries: a block's words ("“Access Denied”") and where a store's results are, never a
 * search's words.
 */
export function reportNote(event: NoteEvent): void {
  console.log('[on-device-note]', JSON.stringify(event));

  const url = process.env.EXPO_PUBLIC_TELEMETRY_URL;
  if (!url) return;
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...event, at: new Date().toISOString() }),
  }).catch(() => {
    // Telemetry must never break a search.
  });
}
