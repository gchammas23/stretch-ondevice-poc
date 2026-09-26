import { useEffect, useState } from 'react';
import { dayOf } from '../onDevice/adPage';

/** The current time, updated every `intervalMs`, for elapsed and "x min ago" labels. */
export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/** Today on the phone's calendar ('YYYY-MM-DD'): the screen draws again only when the day changes. */
export function useToday(): string {
  const [today, setToday] = useState(() => dayOf(Date.now()));
  useEffect(() => {
    const timer = setInterval(() => setToday(dayOf(Date.now())), 60_000);
    return () => clearInterval(timer);
  }, []);
  return today;
}
