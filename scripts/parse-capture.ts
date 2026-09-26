/// <reference types="node" />
/**
 * Checks a parser against something saved from Proxyman, with no phone needed:
 * a retailer's search page (HTML), its __NEXT_DATA__ JSON, or a JSON response its page fetched.
 *   npx tsx scripts/parse-capture.ts walmart-search.html                  (Walmart parser)
 *   npx tsx scripts/parse-capture.ts target-search-response.json autoDetect
 */
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { PARSERS } from '../src/onDevice/parsers';
import type { PagePayload } from '../src/onDevice/types';

const [file, parserId = 'walmartNextData', storeId = 'capture'] = process.argv.slice(2);

if (!file) {
  console.error('Usage: npx tsx scripts/parse-capture.ts <saved-page.html|response.json> [parserId] [storeId]');
  process.exit(1);
}

const parser = PARSERS[parserId];
if (!parser) {
  console.error(`Unknown parser "${parserId}". Known: ${Object.keys(PARSERS).join(', ')}`);
  process.exit(1);
}

const text = readFileSync(file, 'utf8');
const isJson = /^[{[]/.test(text.trimStart());
const payload: PagePayload = !isJson
  ? { html: text }
  : parserId === 'walmartNextData'
    ? { nextDataText: text }
    : { sources: [{ label: basename(file), text }] };

const t0 = performance.now();
const result = parser(payload, { retailer: parserId, storeId });
const ms = (performance.now() - t0).toFixed(1);

console.log(`payloadFound=${result.payloadFound}  products=${result.products.length}  source=${result.source ?? '-'}  parsed in ${ms} ms`);
console.table(
  result.products.slice(0, 15).map((p) => ({
    id: p.id,
    name: p.name.slice(0, 48),
    price: p.price,
    unit: p.unitPriceText ?? '',
    inStock: p.inStock ?? '',
    sponsored: p.sponsored ?? '',
  })),
);
