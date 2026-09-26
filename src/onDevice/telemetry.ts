import type { Attempt } from './types';

export interface AttemptEvent extends Attempt {
  retailer: string;
  configVersion: string;
}

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
