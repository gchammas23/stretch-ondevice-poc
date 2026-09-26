// Pure functions only, so the tests run them in Node.
//
// Barcodes as phones scan them and as stores write them: UPC-A, UPC-E, EAN-13, GTIN-14.

/** A scanned or printed barcode as the digits stores search by, or null if it isn't one. UPC-E is expanded to UPC-A. */
export function normalizeBarcode(raw: string): string | null {
  const d = raw.replace(/\D/g, '');
  if (d.length === 8 && raw.trim().length === 8 && /^[01]/.test(d)) return upcEtoA(d) ?? d;
  // Phones report a UPC-A as an EAN-13 with a leading zero; U.S. stores index the UPC-A.
  if (d.length === 13 && d.startsWith('0')) return d.slice(1);
  return [8, 12, 13, 14].includes(d.length) ? d : null;
}

export const isBarcode = (q: string): boolean => /^\d{8,14}$/.test(q.trim());

/** UPC-E (8 digits: number system, 6 digits, check) to its UPC-A. */
export function upcEtoA(e: string): string | null {
  if (!/^[01]\d{7}$/.test(e)) return null;
  const [n, d1, d2, d3, d4, d5, d6, c] = e.split('');
  let body: string;
  if (d6 === '0' || d6 === '1' || d6 === '2') body = `${n}${d1}${d2}${d6}0000${d3}${d4}${d5}`;
  else if (d6 === '3') body = `${n}${d1}${d2}${d3}00000${d4}${d5}`;
  else if (d6 === '4') body = `${n}${d1}${d2}${d3}${d4}00000${d5}`;
  else body = `${n}${d1}${d2}${d3}${d4}${d5}0000${d6}`;
  return `${body}${c}`;
}

/** Kroger's productId for a barcode: 13 digits, without the check digit. */
export function krogerProductId(code: string): string {
  const d = code.replace(/\D/g, '');
  return d.slice(0, -1).padStart(13, '0');
}

/** Two barcodes for the same product, however they're written: leading zeros, with or without the check digit. */
export function sameBarcode(a: string | undefined, b: string | undefined): boolean {
  const core = (s: string | undefined) => (s ?? '').replace(/\D/g, '').replace(/^0+/, '');
  const x = core(a);
  const y = core(b);
  if (x.length < 6 || y.length < 6) return false;
  return x === y || x.slice(0, -1) === y || y.slice(0, -1) === x;
}
