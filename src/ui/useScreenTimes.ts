import { useLayoutEffect, useState } from 'react';
import { markShown } from '../onDevice/timing';
import type { PricingRun } from '../pricing/pricingEngine';

/**
 * Notes when this screen first drew each of the run's fresh results, for the speed test's timeline ("to the screen").
 * Only results that came in while the screen was open count: one opened later didn't keep them waiting. `onNew` is
 * called when some were new, e.g. to re-render a summary that counts them. Noting them re-renders nothing.
 */
export function useScreenTimes(run: PricingRun | undefined, onNew?: () => void): void {
  const [openedAt] = useState(Date.now);
  useLayoutEffect(() => {
    if (!run) return;
    const now = Date.now();
    let fresh = false;
    for (const results of Object.values(run.results)) {
      for (const r of Object.values(results)) {
        const t = r.timing;
        if (t && t.startedAt >= run.startedAt && t.endedAt >= openedAt && markShown(t, now)) fresh = true;
      }
    }
    if (fresh) onNew?.();
  });
}
