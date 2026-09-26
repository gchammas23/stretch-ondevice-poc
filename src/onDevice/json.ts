export type Obj = Record<string, unknown>;

export const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
export const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);
export const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** Safe path lookup: get(o, 'a', 'b', 0, 'c'). */
export function get(root: unknown, ...path: (string | number)[]): unknown {
  let cur = root;
  for (const key of path) {
    if (typeof key === 'number') {
      if (!Array.isArray(cur)) return undefined;
      cur = cur[key];
    } else {
      if (!isObj(cur)) return undefined;
      cur = cur[key];
    }
  }
  return cur;
}

/** "$3.12" → 3.12. Ranges and anything else → undefined. */
export function parseMoney(text: string | undefined): number | undefined {
  if (!text) return undefined;
  const m = /^\s*\$\s*(\d{1,6}(?:,\d{3})*(?:\.\d{1,2})?)\s*$/.exec(text);
  return m ? Number(m[1].replace(/,/g, '')) : undefined;
}

/** Looser: "$3.49/ea", "$3.49 each". Rejects "2 for $5" and "$2.49 - $3.10". */
export function moneyFromText(text: string): number | undefined {
  if (text.length > 32 || /\bfor\b|\d\s*[-–]\s*\$/i.test(text)) return undefined;
  const m = /\$\s?(\d{1,5}(?:,\d{3})*(?:\.\d{1,2})?)/.exec(text);
  return m ? Number(m[1].replace(/,/g, '')) : undefined;
}
