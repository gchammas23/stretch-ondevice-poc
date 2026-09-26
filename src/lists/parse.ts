import { queryKey, type GroceryList } from './types';

// Pure functions only, so the tests run them in Node.

export interface ParsedItem {
  name: string;
  qty: number;
}

/** Bullets, numbering and checkboxes that pasted lists start their lines with. */
const LEAD = /^\s*(?:[-*•·◦▪–—>]+|\d{1,3}[.)]|\[[ xX✓✔]?\]|[☐☑✓✔□■])\s*/;

/**
 * A pasted list, one item per line: "- Milk", "2 x eggs", "Bread ×2", "☐ Butter". Quantities up to 99 are read from
 * "2 x", "x2" or "(2)"; repeated items add up.
 */
export function parseListText(text: string): ParsedItem[] {
  const out = new Map<string, ParsedItem>();
  for (const raw of text.split(/\r?\n/)) {
    let line = raw;
    for (let i = 0; i < 3 && LEAD.test(line); i++) line = line.replace(LEAD, '');
    line = line.replace(/\s+/g, ' ').trim();
    let qty = 1;
    const before = /^(\d{1,2})\s*[x×]\s+(.+)$/i.exec(line);
    const after = /^(.+?)\s*(?:[x×]\s*(\d{1,2})|\((\d{1,2})\))$/i.exec(line);
    if (before) {
      qty = Number(before[1]);
      line = before[2];
    } else if (after) {
      qty = Number(after[2] ?? after[3]);
      line = after[1];
    }
    line = line.replace(/[,;:.]+$/, '').trim();
    if (!line || !/[a-z]/i.test(line)) continue;
    const key = queryKey(line);
    const had = out.get(key);
    out.set(key, { name: had?.name ?? line, qty: Math.min(99, Math.max(1, qty) + (had?.qty ?? 0)) });
  }
  return [...out.values()];
}

/** The list as text to share: its items, and Stretch's pick when there is one. */
export function listText(list: GroceryList, pick?: { store: string; total: string; found: number } | null): string {
  const lines = [list.name, ...list.items.map((i) => `• ${i.name}${i.qty > 1 ? ` ×${i.qty}` : ''}`)];
  if (pick) {
    const all = pick.found === list.items.length;
    lines.push('', `Stretch’s pick: ${pick.store}, ${pick.total} for ${all ? `all ${pick.found}` : `${pick.found} of ${list.items.length}`} items`);
  }
  return lines.join('\n');
}
