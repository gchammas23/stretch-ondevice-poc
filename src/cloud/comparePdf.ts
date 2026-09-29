import { esc } from '../pricing/reportHtml';
import { money } from '../ui/theme';
import {
  comparisonProblems,
  comparisonStatus,
  comparisonSummary,
  dataWords,
  durationWords,
  matchTerm,
  problemKindWords,
  SIDE_NAMES,
  sideReasonWords,
  sideFigures,
  sideRun,
  sidesOf,
  sideStatusWords,
  sideTotals,
  termProducts,
  type CompareRetailerId,
  type Comparison,
  type ProductCell,
  type SideFigures,
  type SideTotals,
} from './compare';
import type { CompareSide, TermResult } from './jobs';
import { sameStoreId } from '../onDevice/storeIdentity';
import { costWords, RETAILER_NAMES } from './words';

// Pure: Phone vs. cloud as a PDF to share, as HTML for expo-print (see src/ui/pdf.ts). One run's, or every run's with
// their totals first: then, run by run and store by store, each side's result side by side, every product each side
// read with its price (a cloud side's that isn't this phone's marked), what went wrong with the exact error, and how
// it was all measured. It reads the same printed in black and white: nothing is said by color alone.
//
// It runs over as many US Letter pages as it needs: a table's header repeats on the next page, a row isn't split, and
// each run of every run's report starts on a page of its own. The margins are the page's: iOS's printing takes them
// as an option, Android's (like Chromium's) from the @page rule, so the caller says which (`pageMargin`).

export interface PdfInput {
  /** The runs, newest first: one, for a run's PDF. */
  comparisons: Comparison[];
  /** 'run': one run's PDF; 'all': every run's, with their totals and a table of them first. */
  scope: 'run' | 'all';
  /** What the user wrote: each run's findings by its id, and the report's. */
  notes: { runs: Record<string, string>; report: string };
  madeAt: number;
  /** "iPhone", and "iOS 26.0" when known. */
  device: string;
  system?: string;
  /** A date and time as the phone says it: "Sep 29, 2026, 2:14 PM". */
  when: (at: number) => string;
  /** Fraunces SemiBold as base64 TrueType, for the headings. Without it, the phone's own serif stands in. */
  displayFont?: string;
  /** The @page margin, in points: 0 when the printing adds the margins itself (iOS). */
  pageMargin: number;
}

const PAGE = { width: 612, height: 792 } as const;

/** "Phone vs cloud - milk, eggs - 2026-09-29.pdf", "Phone vs cloud - 4 runs - 2026-09-29.pdf". */
export function comparisonPdfName(input: Pick<PdfInput, 'comparisons' | 'scope' | 'madeAt'>): string {
  const d = new Date(input.madeAt);
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const what =
    input.scope === 'all' ? `${input.comparisons.length} ${input.comparisons.length === 1 ? 'run' : 'runs'}` : (input.comparisons[0]?.terms.join(', ') ?? 'run');
  const safe = what.replace(/[\\/:*?"<>|\n\r\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
  return `Phone vs cloud - ${safe} - ${day}.pdf`;
}

const quote = (terms: string[]) => terms.map((t) => `“${t}”`).join(', ');
const pct = (part: number, whole: number) => (whole ? `${Math.round((part / whole) * 100)}%` : '');
const dash = '<span class="dash">–</span>';
const cellText = (s: string | undefined) => (s ? esc(s) : dash);

/**
 * A time as a cell: as measured; for the cloud browser, as a server would have it first, marked as the estimate it is,
 * and as measured from this phone below it.
 */
function timeCell(measured: number | undefined, server: number | undefined): string | undefined {
  if (measured === undefined) return undefined;
  if (server === undefined) return esc(durationWords(measured));
  return `${esc(durationWords(server))} <span class="tag">Server estimate</span><br><span class="small">${esc(durationWords(measured))} measured from this phone</span>`;
}

/** How the store was set, in a few words. */
const STORE_SET: Record<NonNullable<SideFigures['storeSet']>, string> = {
  button: 'Set on its page',
  already: 'Already set',
  kept: 'Kept from its last run',
  cookie: 'Set in its store cookies',
  request: 'In each request',
  agent: 'By the agent',
};

/** Every side any of the runs had, in their order. */
const sidesIn = (list: Comparison[]): CompareSide[] => (['phone', 'scripted', 'agent'] as const).filter((s) => list.some((c) => c.sides[s]));

/** The stores the runs searched: "Walmart store 5260, Target store 2766". */
function storesWords(list: Comparison[]): string {
  const seen = new Map<string, string>();
  for (const c of list) for (const r of c.retailers) seen.set(`${r.retailerId}:${r.storeId}`, `${RETAILER_NAMES[r.retailerId]} store ${r.storeId}`);
  return [...seen.values()].join(', ');
}

// --- At a glance ------------------------------------------------------------------------------------------------

function glanceRows(totals: SideTotals[], all: boolean): { label: string; cells: string[] }[] {
  const row = (label: string, f: (t: SideTotals) => string | undefined) => ({ label, cells: totals.map((t) => cellText(f(t))) });
  /** A row whose cells are HTML already. */
  const rowHtml = (label: string, f: (t: SideTotals) => string | undefined) => ({ label, cells: totals.map((t) => f(t) ?? dash) });
  const trouble = (t: SideTotals) => {
    const parts = [t.blocked ? `${t.blocked} blocked` : '', t.failed ? `${t.failed} failed` : '', t.cutOff ? `${t.cutOff} cut off` : ''].filter(Boolean);
    return parts.length ? parts.join(', ') : 'None';
  };
  return [
    ...(all ? [row('Runs', (t) => String(t.runs))] : []),
    row('Stores that gave prices', (t) => `${t.withPrices} of ${t.stores}`),
    row('Prices confirmed for the store', (t) => `${t.confirmed} of ${t.stores}`),
    row('Blocked, failed or cut off', trouble),
    row('Same price as this phone', (t) => (t.side === 'phone' ? 'The reference' : t.both ? `${t.same} of ${t.both} (${pct(t.same ?? 0, t.both)})` : undefined)),
    rowHtml(all ? 'A run’s time (median)' : 'Time, start to end', (t) => timeCell(t.runMs, t.serverRunMs)),
    rowHtml('Setting up (median)', (t) => timeCell(t.setupMs, t.serverSetupMs)),
    rowHtml('A search (median)', (t) => timeCell(t.searchMs, t.serverSearchMs)),
    row('Data to this phone', (t) => (t.phoneBytes !== undefined ? `${dataWords(t.phoneBytes)}${t.side === 'phone' ? '' : ' of results'}` : undefined)),
    row('Data through Browser Use’s proxy', (t) => (t.cloudMb ? `${t.cloudMb.toFixed(1)} MB` : undefined)),
    ...(totals.some((t) => t.linkBytes !== undefined) ? [row('Left out: driving it from this phone', (t) => (t.linkBytes !== undefined ? dataWords(t.linkBytes) : undefined))] : []),
    row('Cost', (t) => (t.side === 'phone' ? 'Free' : t.usd > 0 ? `${costWords(t.usd)}${all && t.runs > 1 ? ` in all · ${costWords(t.usd / t.runs)} a run` : ''}` : undefined)),
  ];
}

/** The difference in a sentence a side: what the cloud got against this phone. */
function inShort(totals: SideTotals[], all: boolean): string[] {
  const phone = totals.find((t) => t.side === 'phone');
  return totals
    .filter((t) => t.side !== 'phone')
    .map((t) => {
      const parts = [`prices from ${t.withPrices} of ${t.stores} ${t.stores === 1 ? 'store' : 'stores'}${phone ? ` (this phone: ${phone.withPrices} of ${phone.stores})` : ''}`];
      if (t.both) parts.push(`this phone’s price for ${t.same} of the ${t.both} products both listed (${pct(t.same ?? 0, t.both)})`);
      if (t.serverRunMs !== undefined && t.runMs !== undefined && phone?.runMs !== undefined) {
        parts.push(`about ${durationWords(t.serverRunMs)} ${all ? 'a run' : 'in all'} on a server, estimated (${durationWords(t.runMs)} as measured from this phone), against this phone’s ${durationWords(phone.runMs)}`);
      } else if (t.runMs !== undefined && phone?.runMs !== undefined) parts.push(`${durationWords(t.runMs)} ${all ? 'a run' : 'in all'} against this phone’s ${durationWords(phone.runMs)}`);
      if (t.phoneBytes !== undefined && phone?.phoneBytes !== undefined) parts.push(`${dataWords(t.phoneBytes)} of results to this phone against the ${dataWords(phone.phoneBytes)} its own searches used`);
      if (t.usd > 0) parts.push(`${costWords(t.usd)}${all ? ' in all' : ''}`);
      return `<b>${esc(SIDE_NAMES[t.side])}:</b> ${esc(parts.join('; '))}.`;
    });
}

function glance(list: Comparison[], all: boolean): string {
  const totals = sideTotals(list);
  const head = `<tr><th class="label"></th>${totals.map((t) => `<th>${esc(SIDE_NAMES[t.side])}</th>`).join('')}</tr>`;
  const body = glanceRows(totals, all)
    .map((r) => `<tr><td class="label">${esc(r.label)}</td>${r.cells.map((c) => `<td>${c}</td>`).join('')}</tr>`)
    .join('');
  const short = inShort(totals, all);
  return `<section class="part keep"><h2>At a glance</h2><table class="glance"><thead>${head}</thead><tbody>${body}</tbody></table>${
    short.length ? `<div class="short">${short.map((s) => `<p>${s}</p>`).join('')}</div>` : ''
  }</section>`;
}

// --- Every run, in a table --------------------------------------------------------------------------------------

function runsTable(list: Comparison[], when: PdfInput['when']): string {
  const sides = sidesIn(list);
  const head = `<tr><th class="num">#</th><th class="label">When</th><th class="label">Searched</th>${sides.map((s) => `<th>${esc(SIDE_NAMES[s])}</th>`).join('')}<th>Same price</th><th>Cost</th><th>Problems</th></tr>`;
  const rows = list
    .map((c, i) => {
      const summary = comparisonSummary(c);
      const same = summary.prices.find((p) => p.side === 'scripted');
      const cost = summary.sides.reduce((n, s) => n + s.usd, 0);
      const problems = comparisonProblems(c).length;
      const sideCells = sides
        .map((side) => {
          const s = summary.sides.find((x) => x.side === side);
          return `<td>${s ? `${s.withPrices} of ${s.stores}` : dash}</td>`;
        })
        .join('');
      const status = comparisonStatus(c);
      return `<tr><td class="num">${i + 1}</td><td class="label">${esc(when(c.createdAt))}${status !== 'done' ? `<br><span class="small">${esc(status)}</span>` : ''}</td><td class="label">${esc(c.terms.join(', '))}</td>${sideCells}<td>${
        same?.both ? `${same.same} of ${same.both}` : dash
      }</td><td>${cost > 0 ? esc(costWords(cost)) : dash}</td><td>${problems || dash}</td></tr>`;
    })
    .join('');
  return `<section class="part"><h2>The runs</h2><table class="runs"><thead>${head}</thead><tbody>${rows}</tbody></table><p class="caption">Stores with prices on each side, of those searched. Same price: the products the cloud browser listed that this phone listed too, at this phone’s price.</p></section>`;
}

// --- A run, store by store --------------------------------------------------------------------------------------

function sideRows(figures: { side: CompareSide; f: SideFigures; tried: number }[], storeId: string): string {
  const row = (label: string, f: (x: SideFigures) => string | undefined, cls = '') =>
    `<tr><td class="label">${esc(label)}</td>${figures.map(({ f: x }) => `<td class="${cls}">${cellText(f(x))}</td>`).join('')}</tr>`;
  /** A row whose cells are HTML already. */
  const rowHtml = (label: string, f: (x: SideFigures) => string | undefined) =>
    `<tr><td class="label">${esc(label)}</td>${figures.map(({ f: x }) => `<td>${f(x) ?? dash}</td>`).join('')}</tr>`;
  const result = `<tr><td class="label">Result</td>${figures
    .map(({ f, tried }) => {
      const cls = f.status === 'done' ? (f.confirmed && !f.otherStore ? 'ok' : 'warn') : f.status === 'running' || f.status === 'queued' ? '' : 'bad';
      const mark = cls === 'ok' ? '✓ ' : cls === 'bad' ? '✗ ' : cls === 'warn' ? '! ' : '';
      const missed = f.status === 'done' && tried > f.searched ? `<br><span class="small">${tried - f.searched} of ${tried} searches didn’t work</span>` : '';
      return `<td class="result ${cls}">${esc(mark + sideStatusWords(f, storeId))}${missed}</td>`;
    })
    .join('')}</tr>`;
  return [
    result,
    row('Products', (x) => (x.searched || x.products ? `${x.products} from ${x.searched} ${x.searched === 1 ? 'search' : 'searches'}` : undefined)),
    rowHtml('Time, start to end', (x) => timeCell(x.totalMs, x.serverMs)),
    rowHtml('Setting up', (x) => (x.setupMs !== undefined && x.setupMs >= 1000 ? timeCell(x.setupMs, x.serverSetupMs) : undefined)),
    rowHtml('A search (median)', (x) => timeCell(x.searchMs, x.serverSearchMs)),
    row('The store', (x) => (x.storeSet ? `${STORE_SET[x.storeSet]}${x.sitePicked && x.storeSet !== 'kept' ? ` (the site had picked ${x.sitePicked})` : ''}` : undefined)),
    row('Data to this phone', (x) => (x.phoneBytes !== undefined ? `${dataWords(x.phoneBytes)}${x.side === 'phone' ? '' : ' of results'}` : undefined)),
    row('Data through the proxy', (x) => (x.cloudMb ? `${x.cloudMb.toFixed(1)} MB` : undefined)),
    ...(figures.some(({ f }) => f.linkBytes !== undefined || f.linkMs !== undefined)
      ? [row('Left out: driving it from this phone', (x) => [x.linkBytes !== undefined ? dataWords(x.linkBytes) : '', x.linkMs !== undefined ? durationWords(x.linkMs) : ''].filter(Boolean).join(', ') || undefined)]
      : []),
    row('Cost', (x) => (x.side === 'phone' ? 'Free' : x.usd > 0 ? costWords(x.usd) : undefined)),
    row('Bot check', (x) => (x.checkSeen ? 'Seen' : 'None')),
  ].join('');
}

/**
 * A price cell: the price, what it was; a cloud side's marked when it isn't this phone's, and one priced for another
 * store said so (it isn't compared).
 */
function priceCell(cell: ProductCell | undefined): string {
  if (!cell) return `<td class="missing">${dash}</td>`;
  const price = cell.price === null ? 'no price' : money(cell.price);
  const extra = [cell.was !== undefined ? `was ${money(cell.was)}` : '', cell.pricedAt ? `store ${cell.pricedAt}’s price` : ''].filter(Boolean).join(', ');
  return `<td class="${cell.differs ? 'differs' : cell.pricedAt ? 'elsewhere' : ''}">${cell.differs ? '≠ ' : ''}${esc(price)}${extra ? `<br><span class="small">${esc(extra)}</span>` : ''}</td>`;
}

/** What a side's search came to, in a line: "40 products in 6 s, a page load, 1.4 MB", or why it didn't. */
function searchLine(side: CompareSide, r: TermResult | undefined, running: boolean, storeId = ''): string {
  if (!r) return `${SIDE_NAMES[side]}: ${running ? 'still searching' : 'not searched'}.`;
  if (r.status !== 'done') return `${SIDE_NAMES[side]}: ${r.status === 'blocked' ? 'blocked' : 'failed'}, ${sideReasonWords(side, r.reason) || r.status}.`;
  const how = r.how === 'replay' ? ', a request sent again' : r.how === 'page' ? ', a page load' : r.how === 'api' ? ', its API' : '';
  const found = r.found ?? r.items.length;
  const server = side === 'scripted' && r.ms !== undefined && r.linkMs !== undefined ? ` (about ${durationWords(Math.max(0, r.ms - r.linkMs))} on a server)` : '';
  // The phone's own data; a cloud side's is its browser's page, through the proxy.
  const data = r.bytes !== undefined ? `, ${dataWords(r.bytes)}${side === 'phone' ? '' : ' through the proxy'}` : '';
  const asked = r.siteStoreId && storeId && !sameStoreId(r.siteStoreId, storeId) ? `; the site’s own page asked for store ${r.siteStoreId}` : '';
  return `${SIDE_NAMES[side]}: ${found} ${found === 1 ? 'product' : 'products'}${r.ms !== undefined ? ` in ${durationWords(r.ms)}${server}${how}` : ''}${data}${asked}${
    r.storeMatches === false ? `; priced store ${r.pageStoreId ?? '?'}, not this one` : ''
  }.`;
}

function termBlock(c: Comparison, retailerId: CompareRetailerId, term: string): string {
  const sides = sidesOf(c).filter((s) => sideRun(c, s, retailerId));
  const t = termProducts(c, retailerId, term);
  const lines = sides.map((side) => {
    const run = sideRun(c, side, retailerId);
    return searchLine(side, t.results[side], run?.status === 'running' || run?.status === 'queued', run?.storeId);
  });
  const matches = (['scripted', 'agent'] as const)
    .filter((side) => sides.includes(side))
    .map((side) => {
      const m = matchTerm(term, sideRun(c, 'phone', retailerId), sideRun(c, side, retailerId));
      if (m.phone?.status !== 'done' || m.cloud?.status !== 'done') return '';
      const elsewhere = m.elsewhere ? ` ${m.elsewhere} more on both ${m.elsewhere === 1 ? 'was' : 'were'} priced for another store, and not compared.` : '';
      return `<b>${esc(SIDE_NAMES[side])} against this phone:</b> ${esc(
        (m.both ? `${m.both} products on both, ${m.same} at the same price${m.differ.length ? `, ${m.differ.length} not` : ''}; ${m.onlyPhone} only on this phone, ${m.onlyCloud} only in the cloud.` : 'no product on both.') + elsewhere,
      )}`;
    })
    .filter(Boolean);
  const head = `<tr><th class="label">Product</th>${sides.map((s) => `<th>${esc(SIDE_NAMES[s])}</th>`).join('')}</tr>`;
  const rows = t.rows
    .map((row) => {
      const size = row.size && !row.name.includes(row.size) ? `<span class="small"> · ${esc(row.size)}</span>` : '';
      const sponsored = Object.values(row.cells).some((cell) => cell?.sponsored) ? ' <span class="tag">Sponsored</span>' : '';
      return `<tr><td class="label name">${esc(row.name)}${size}${sponsored}</td>${sides.map((s) => priceCell(row.cells[s])).join('')}</tr>`;
    })
    .join('');
  return `<div class="term"><h4>“${esc(term)}”</h4>${lines.map((l) => `<p class="small">${esc(l)}</p>`).join('')}${matches.map((m) => `<p>${m}</p>`).join('')}${
    t.rows.length ? `<table class="products"><thead>${head}</thead><tbody>${rows}</tbody></table>` : '<p class="small">No products from any side.</p>'
  }</div>`;
}

function problemsBlock(c: Comparison): string {
  const problems = comparisonProblems(c);
  if (!problems.length) return '';
  const items = problems
    .map((p) => {
      const where = [RETAILER_NAMES[p.retailerId], SIDE_NAMES[p.side], p.term ? `“${p.term}”` : ''].filter(Boolean).join(' · ');
      const why = p.words.charAt(0).toUpperCase() + p.words.slice(1);
      const tone = p.kind === 'other_store' || p.kind === 'mixed_store' || p.kind === 'unconfirmed' || p.kind === 'cancelled' ? 'minor' : 'major';
      return `<div class="problem ${tone}"><p><b>${esc(where)}</b> <span class="kind">${esc(problemKindWords(p.kind))}</span></p><p>${esc(why)}.</p>${
        p.detail ? `<p class="detail"><span class="small">Exact error:</span> <code>${esc(p.detail)}</code></p>` : ''
      }</div>`;
    })
    .join('');
  return `<div class="problems"><h3>What went wrong</h3>${items}</div>`;
}

function runSection(c: Comparison, index: number, input: PdfInput): string {
  const all = input.scope === 'all';
  const sides = sidesOf(c);
  const status = comparisonStatus(c);
  const notes = all ? input.notes.runs[c.id]?.trim() : '';
  const title = all ? `Run ${index + 1}: ${quote(c.terms)}` : 'Store by store';
  const meta = [input.when(c.createdAt), sides.map((s) => SIDE_NAMES[s]).join(', '), status === 'done' ? '' : status === 'interrupted' ? 'Cut off' : status === 'cancelled' ? 'Cancelled' : 'Still running'].filter(Boolean);
  const stores = c.retailers
    .map(({ retailerId, storeId }) => {
      const figures = sides
        .map((side) => ({ side, run: sideRun(c, side, retailerId) }))
        .filter((x) => x.run)
        .map(({ side, run }) => ({ side, f: sideFigures(side, run!), tried: run!.results.length }));
      const head = `<tr><th class="label"></th>${figures.map(({ side }) => `<th>${esc(SIDE_NAMES[side])}</th>`).join('')}</tr>`;
      return `<div class="store"><h3>${esc(RETAILER_NAMES[retailerId])} · store ${esc(storeId)}</h3><table class="sides keep"><thead>${head}</thead><tbody>${sideRows(figures, storeId)}</tbody></table>${c.terms
        .map((term) => termBlock(c, retailerId, term))
        .join('')}</div>`;
    })
    .join('');
  return `<section class="run${all ? ' newpage' : ''}"><h2>${esc(title)}</h2><p class="meta">${meta.map(esc).join(' · ')}</p>${
    notes ? `<div class="findings"><h3>Findings</h3><p>${esc(notes)}</p></div>` : ''
  }${problemsBlock(c)}${stores}</section>`;
}

// --- How it was measured ----------------------------------------------------------------------------------------

function howBlock(list: Comparison[]): string {
  const agent = list.some((c) => c.sides.agent);
  const points = [
    '<b>This phone</b>: each search in the app’s own browser, hidden, on the store’s own site, at the store set in Your stores (Walmart’s set on its site; Target’s number put in its page’s own requests): a page load, or the store’s own request sent again from its page. The reference for prices.',
    '<b>Cloud browser</b>: a Browser Use browser in the U.S., through home internet addresses Browser Use rents, driven by the app from this phone: for Walmart, its store page and its button, then a search page a term; for Target, its store page and its “Shop this store” (or, when that doesn’t take, the site’s store cookies set as it would leave them), then its search page, whose own request must ask for the store, sent again for each term.',
    '<b>Its store</b>: each store’s browser starts from a Browser Use profile kept for that store, as a server keeps its browser’s cookies. The first run sets Walmart’s and Target’s stores on their pages; later runs find them still set (“Kept from its last run”), and the first search checks the store held, setting it again if not. Target picks a store by itself for a new browser, from where its connection seems to be: the one it had picked is said beside how the store was set.',
    ...(agent ? ['<b>AI agent</b>: Browser Use’s agent, asked in words to set the store on its page and open each term’s search page, answering in JSON with the first 10 products of each.'] : []),
    '<b>Same product</b>: matched by the store’s own item number (Walmart’s usItemId, Target’s TCIN) among the first 20 products each side kept a search (the AI agent’s first 10). ≠ marks a cloud price that isn’t this phone’s; – a product that side didn’t list. Target prices each product for a store: one it priced for another store than the one asked isn’t compared.',
    '<b>Time</b>: a store from its start to its end, both sides started together; the cloud browser’s setting up (starting it, setting the store) is apart from a search’s time. The cloud browser’s times are given as a server driving it would have them, an estimate: as measured, less what driving it from this phone added. Each command the app sent took a trip over this phone’s connection, counted as no more than the fastest of three pings, so the browser’s own work stays in; each page load took what it took beyond the browser’s own clock for it. A server in the same region as the browser would add back a few milliseconds a command.',
    '<b>Data</b>: this phone’s own searches, as the app metered them. For a cloud side, what a server would send this phone: the results, as JSON, before any compression. The cloud’s own traffic went through Browser Use’s proxy, as Browser Use reported it. What driving the cloud browser from this phone moved (its DevTools connection, which streams the page’s network events) is the test’s own, and left out: a server next to the browser wouldn’t send it to a phone.',
    '<b>Cost</b>: as Browser Use reported it for each browser and agent run. This phone’s searches cost nothing but its data and battery.',
    '<b>Bot checks</b> were noted on both sides, never shown or pressed. A price can differ for another store’s prices, a sale one side read and the other didn’t, or a change between the two reads.',
  ];
  return `<section class="part how keep"><h2>How it was measured</h2>${points.map((p) => `<p>${p}</p>`).join('')}</section>`;
}

// --- The page ---------------------------------------------------------------------------------------------------

const SERIF = `'Fraunces', ui-serif, 'New York', 'Iowan Old Style', Palatino, Georgia, serif`;

const style = (margin: number) => `
@page { size: ${PAGE.width}px ${PAGE.height}px; margin: ${margin}px; }
* { box-sizing: border-box; }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; -webkit-text-size-adjust: none; text-size-adjust: none; }
body { margin: 0; background: #fff; color: #1f1f1f; font: 400 9px/1.38 -apple-system, BlinkMacSystemFont, 'Helvetica Neue', Helvetica, Arial, sans-serif; }
h1, h2 { font-family: ${SERIF}; font-weight: 600; color: #1f1f1f; }
header { border-left: 4px solid #f95a37; padding: 1px 0 1px 10px; margin: 0 0 12px; }
.kicker { font-size: 7.5px; font-weight: 700; letter-spacing: .14em; text-transform: uppercase; color: #c2462a; }
h1 { font-size: 23px; line-height: 1.1; margin: 2px 0 3px; }
.meta { margin: 0 0 2px; color: #55514c; }
.intro { margin: 4px 0 0; color: #1f1f1f; }
h2 { font-size: 13.5px; line-height: 1.2; margin: 0 0 6px; padding-bottom: 2px; border-bottom: .75px solid #1f1f1f; }
h3 { font-size: 10.5px; margin: 12px 0 5px; }
h4 { font-size: 9.5px; margin: 10px 0 3px; }
h2, h3, h4 { break-after: avoid; page-break-after: avoid; }
p { margin: 0 0 3px; }
b { font-weight: 600; }
.part { margin: 0 0 14px; }
.run { margin: 0 0 14px; }
.newpage { break-before: page; page-break-before: always; }
.keep { break-inside: avoid; page-break-inside: avoid; }
.findings { border: 1px solid #f95a37; background: #fff6f3; border-radius: 3px; padding: 6px 9px; margin: 0 0 12px; break-inside: avoid; }
.findings h3 { margin: 0 0 3px; color: #c2462a; }
.findings p { white-space: pre-wrap; font-size: 9.5px; }
.short { margin-top: 6px; }
.short p { margin-bottom: 3px; }
table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; margin: 2px 0 6px; }
thead { display: table-header-group; }
tr { break-inside: avoid; page-break-inside: avoid; }
th { font-size: 7.2px; font-weight: 600; letter-spacing: .05em; text-transform: uppercase; color: #55514c; text-align: right;
  padding: 0 0 3px 8px; vertical-align: bottom; border-bottom: .75px solid #1f1f1f; }
td { padding: 2.5px 0 2.5px 8px; text-align: right; vertical-align: top; border-bottom: .5px solid #e2ddd4; }
th.label, td.label { text-align: left; padding-left: 0; }
td.label { color: #3b3834; }
td.name { color: #1f1f1f; word-break: break-word; }
th.num, td.num { text-align: left; padding-left: 0; width: 16px; }
table.glance td.label { font-weight: 600; width: 34%; }
table.glance td, table.sides td { white-space: normal; }
/* Each side's column as wide as the others', whatever one says: a long reason mustn't squeeze the figures beside it. */
table.sides { table-layout: fixed; }
table.sides th.label, table.sides td.label { width: 22%; }
table.products td.name { width: 52%; }
tbody tr:nth-child(even) td { background: #f8f6f2; }
td.result { font-weight: 600; }
.ok { color: #1e6e47; }
.bad { color: #a8322a; }
.warn { color: #8a5300; }
td.differs { font-weight: 700; color: #8a5300; background: #fff1d6 !important; }
td.elsewhere { color: #6b6660; }
td.missing, .dash { color: #8c8883; }
.small { font-size: 7.6px; color: #6b6660; font-weight: 400; }
.caption { color: #55514c; font-size: 7.8px; }
.store { margin: 0 0 6px; }
.term { margin: 0 0 4px; }
.problems { margin: 4px 0 10px; }
.problems h3 { margin-top: 4px; }
.problem { border-left: 3px solid #a8322a; padding: 1px 0 1px 8px; margin: 0 0 7px; break-inside: avoid; page-break-inside: avoid; }
.problem.minor { border-left-color: #c98a1a; }
.problem .kind, .tag { display: inline-block; font-size: 6.8px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; border: .75px solid currentColor;
  border-radius: 2px; padding: 0 3px; margin-left: 4px; color: #a8322a; vertical-align: 1px; }
.problem.minor .kind { color: #8a5300; }
.tag { color: #6b6660; font-weight: 600; }
.detail code { font-family: ui-monospace, Menlo, 'SF Mono', Consolas, monospace; font-size: 7.6px; background: #f3f0ea; padding: 1px 3px; border-radius: 2px;
  white-space: pre-wrap; word-break: break-word; }
.how p { margin-bottom: 4px; }
`;

/** The PDF as a page of HTML, for expo-print. */
export function comparisonPdfHtml(input: PdfInput): string {
  const list = input.comparisons;
  const all = input.scope === 'all';
  const font = input.displayFont?.replace(/\s+/g, '');
  // Only base64 goes into the style sheet: anything else is left out, and the phone's serif stands in.
  const face =
    font && /^[A-Za-z0-9+/]+=*$/.test(font)
      ? `@font-face { font-family: 'Fraunces'; font-style: normal; font-weight: 600; font-display: swap; src: url(data:font/ttf;base64,${font}) format('truetype'); }`
      : '';
  const early = face ? '<script>try { document.fonts && document.fonts.load("600 16px Fraunces"); } catch (e) {}</script>' : '';
  const first = list[list.length - 1];
  const last = list[0];
  const title = all ? `${list.length} ${list.length === 1 ? 'run' : 'runs'}` : quote(last?.terms ?? []);
  const span = all && first && last ? `${input.when(first.createdAt)} to ${input.when(last.createdAt)}` : last ? input.when(last.createdAt) : '';
  const agent = list.some((c) => c.sides.agent);
  const findings = (all ? input.notes.report : last ? input.notes.runs[last.id] : '')?.trim();
  const made = `Made on this ${input.device}${input.system ? ` (${input.system})` : ''}, ${input.when(input.madeAt)}`;
  return [
    '<!DOCTYPE html>',
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${esc(comparisonPdfName(input).replace(/\.pdf$/, ''))}</title>`,
    `<style>${face}${style(input.pageMargin)}</style>${early}</head>`,
    '<body>',
    `<header><div class="kicker">Stretch · Phone vs. cloud</div><h1>${esc(title)}</h1><p class="meta">${esc([span, storesWords(list)].filter(Boolean).join(' · '))}</p><p class="meta">${esc(made)}.</p><p class="intro">${esc(
      `The same searches at the same stores, run at once on this ${input.device} (the way the app prices, in its own browser set to the store) and in Browser Use’s cloud (a cloud browser the app drives${agent ? ', and Browser Use’s AI agent' : ''}). This ${input.device}’s prices are the reference.`,
    )}</p></header>`,
    findings ? `<div class="findings"><h3>Findings</h3><p>${esc(findings)}</p></div>` : '',
    list.length ? glance(list, all) : '<p>No runs yet.</p>',
    all && list.length ? runsTable(list, input.when) : '',
    list.map((c, i) => runSection(c, i, input)).join(''),
    list.length ? howBlock(list) : '',
    '</body></html>',
  ].join('\n');
}
