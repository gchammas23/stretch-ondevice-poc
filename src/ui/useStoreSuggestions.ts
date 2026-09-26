import { useEffect, useMemo, useState } from 'react';
import type { RetailerConfig } from '../onDevice/types';
import { useApp, useStoreChoices } from '../state/AppProvider';

/** Stores asked: two, so typing stays light on the stores and on the phone's data. */
const STORES_ASKED = 2;
/** Suggestions are asked once typing pauses this long. */
const PAUSE_MS = 350;

export interface StoreSuggestion {
  text: string;
  retailerId: string;
}

/**
 * What the stores' own search boxes suggest for `text`, typed into their pages, hidden, once typing pauses: the
 * first two compared stores that are read through a page. While `active` (the search box has focus), their pages
 * are got ready, so the first suggestions come quickly.
 */
export function useStoreSuggestions(text: string, active: boolean): { items: StoreSuggestion[]; asking: RetailerConfig[] } {
  const { search, bundle } = useApp();
  const choices = useStoreChoices();
  // By id: the choices change with every setting, and that shouldn't ask again.
  const ids = choices
    .filter((c) => c.config.strategies.includes('webview'))
    .slice(0, STORES_ASKED)
    .map((c) => c.config.id)
    .join(',');
  const stores = useMemo(
    () => ids.split(',').flatMap((id) => bundle.retailers.filter((r) => r.id === id)),
    [ids, bundle.retailers],
  );
  const [items, setItems] = useState<StoreSuggestion[]>([]);
  /** The text last asked about, and whether its answers are in. */
  const [asked, setAsked] = useState({ text: '', done: true });

  useEffect(() => {
    if (!active) return;
    for (const cfg of stores) void search.prepareSuggestions(cfg);
  }, [active, stores, search]);

  useEffect(() => {
    const clean = text.trim();
    if (!active || clean.length < 2 || !stores.length) return;
    let alive = true;
    const timer = setTimeout(() => {
      setAsked({ text: clean, done: false });
      const requests = stores.map((cfg) =>
        search.suggest(cfg, clean).then(
          (found) => found.map((t) => ({ text: t, retailerId: cfg.id })),
          () => [],
        ),
      );
      void Promise.all(requests).then((lists) => {
        if (!alive) return;
        setItems(lists.flat());
        setAsked({ text: clean, done: true });
      });
    }, PAUSE_MS);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [text, active, stores, search]);

  // Only while the answer for what's typed now is on its way.
  const asking = active && !asked.done && asked.text === text.trim() ? stores : [];
  return { items, asking };
}
