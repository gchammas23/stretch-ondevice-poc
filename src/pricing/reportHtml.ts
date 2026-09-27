import type { Basis, Report, ReportLine, ReportRun, ReportSection, ReportStat, SectionId } from './report';

// Pure: the results report as one page of HTML, for expo-print to make a PDF of (see report.tsx). It looks like the
// app (Fraunces headings, Stretch's orange as an accent) and reads the same printed in black and white: nothing is
// said by color alone, and every figure that isn't plainly measured carries its label in words.
//
// expo-print lays the page out on iOS at the page's width, a CSS pixel to a point, with no margins of its own: the
// body's padding is the page's margin. Sizes are in em, so the whole page scales with the body's font size, which a
// short script brings down, step by step, until the page fits (never below FLOOR_PX).

/** A US Letter page in points, as expo-print makes it by default: the report screen asks for this size. */
export const PAGE = { width: 612, height: 792 } as const;
/** The body's font size, and the smallest the page may shrink it to so as to fit: still readable printed. */
export const BASE_PX = 8.6;
export const FLOOR_PX = 7.4;

export interface HtmlOptions {
  /** Fraunces SemiBold as base64 TrueType, for headings and big figures. Without it, the phone's own serif stands in. */
  displayFont?: string;
}

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
/** Text as HTML: store names and rules versions can come from a file anyone wrote. */
export const esc = (s: string): string => s.replace(/[&<>"']/g, (ch) => ESCAPES[ch]);

const TAGS: Record<Exclude<Basis, 'measured'>, string> = { estimate: 'Estimate', assumption: 'Assumed' };
const tag = (basis?: Basis) => (basis && basis !== 'measured' ? `<span class="tag">${TAGS[basis]}</span> ` : '');

const run = (r: ReportRun) => `${tag(r.basis)}${r.lead ? `<b>${esc(r.lead)}</b> ` : ''}${esc(r.text)}`;
const line = (l: ReportLine) => `<p>${[l, ...(l.more ?? [])].map(run).join(' ')}</p>`;

const part = (s: ReportSection | undefined, body = s ? s.lines.map(line).join('') : '') =>
  s ? `<section class="part${s.has ? '' : ' empty'}"><h2>${esc(s.title)}</h2>${body}</section>` : '';

const stat = (s: ReportStat) =>
  `<div class="stat${s.none ? ' none' : ''}">${tag(s.basis)}<div class="value">${esc(s.value)}</div><div class="label">${esc(s.label)}</div></div>`;

/** A table cell: the value, or a dash for nothing. */
const cell = (value: string | number | undefined, cls = 'num') =>
  `<td class="${cls}">${value === undefined || value === '' ? '<span class="dash">–</span>' : esc(String(value))}</td>`;

function storeTable(r: Report, s: ReportSection | undefined): string {
  const t = r.table;
  if (!t.rows.length) return part(s);
  const speed = t.speedItems !== undefined;
  const head =
    `<tr class="groups"><th class="store"></th><th class="check">Store check</th><th class="span" colspan="6">Last 7 days</th>${speed ? '<th>Speed test</th>' : ''}</tr>` +
    '<tr><th class="store">Store</th><th class="check">Result</th><th>Searches</th><th>Worked</th><th>Median</th><th>Bot checks</th><th>Busiest hour</th><th>Data</th>' +
    `${speed ? `<th>${t.speedItems} searches</th>` : ''}</tr>`;
  const rows = t.rows
    .map(
      (row) =>
        `<tr><td class="store">${esc(row.name)}</td>${cell(row.check, 'check')}${cell(row.searches)}${cell(row.worked)}${cell(row.median)}${cell(row.botChecks)}` +
        `${cell(row.busiest)}${cell(row.data)}${speed ? cell(row.speed) : ''}</tr>`,
    )
    .join('');
  return part(s, `<table><thead>${head}</thead><tbody>${rows}</tbody></table><p class="caption">${esc(t.caption)}</p>`);
}

const SERIF = `'Fraunces', ui-serif, 'New York', 'Iowan Old Style', Palatino, Georgia, serif`;

const STYLE = `
@page { size: ${PAGE.width}px ${PAGE.height}px; margin: 0; }
* { box-sizing: border-box; }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; -webkit-text-size-adjust: none; text-size-adjust: none; }
body { margin: 0; padding: 28px 36px 18px; background: #fff; color: #1f1f1f;
  font: 400 ${BASE_PX}px/1.36 -apple-system, BlinkMacSystemFont, 'Helvetica Neue', Helvetica, Arial, sans-serif; }
h1, h2, .value { font-family: ${SERIF}; font-weight: 600; color: #1f1f1f; }
header { border-left: 4px solid #f95a37; padding: 1px 0 1px 10px; margin: 0 0 1.1em; }
.kicker { font-size: .86em; font-weight: 700; letter-spacing: .14em; text-transform: uppercase; color: #c2462a; }
h1 { font-size: 2.6em; line-height: 1.08; letter-spacing: -.01em; margin: .1em 0 .15em; }
.meta { margin: 0; color: #55514c; }
.stats { display: flex; gap: 1.3em; margin: 0 0 1.1em; }
.stat { position: relative; flex: 1 1 0; min-width: 0; border-top: 2.5px solid #f95a37; padding-top: .5em; }
.stat > .tag { position: absolute; top: -.85em; right: 0; background: #fff; }
.stat .value { font-size: 2.2em; line-height: 1.1; white-space: nowrap; }
.stat .label { margin-top: .25em; font-size: .86em; line-height: 1.3; color: #55514c; }
.stat.none .value { color: #8c8883; }
h2 { font-size: 1.3em; line-height: 1.2; margin: 0 0 .3em; padding-bottom: .12em; border-bottom: .75px solid #1f1f1f; }
.part { margin: 0 0 .85em; break-inside: avoid; page-break-inside: avoid; }
p { margin: 0 0 .25em; }
b { font-weight: 600; }
.empty p { color: #55514c; font-style: italic; }
.tag { display: inline-block; font-style: normal; font-size: .72em; font-weight: 700; letter-spacing: .08em; text-transform: uppercase;
  line-height: 1.45; color: #55514c; border: .75px solid #55514c; border-radius: 2px; padding: 0 .35em; vertical-align: .12em; }
table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; margin: .2em 0 .35em; }
th { font-size: .79em; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; color: #55514c; text-align: right;
  padding: 0 0 .25em .75em; white-space: nowrap; vertical-align: bottom; }
tr.groups th { color: #1f1f1f; padding-bottom: .1em; }
tr.groups th.span { text-align: center; border-bottom: .5px solid #9d978e; }
thead tr:last-child th { border-bottom: .75px solid #1f1f1f; }
td { padding: .2em 0 .2em .75em; text-align: right; white-space: nowrap; border-bottom: .5px solid #e2ddd4; }
th.store, td.store { text-align: left; padding-left: 0; }
th.check, td.check { text-align: left; }
td.store { font-weight: 600; white-space: normal; }
tbody tr:nth-child(even) td { background: #f6f4f0; }
.dash { color: #8c8883; }
.caption { color: #55514c; font-size: .86em; }
.cols { display: flex; gap: 2em; }
.col { flex: 1 1 0; min-width: 0; }
footer { border-top: 2.5px solid #f95a37; padding-top: .5em; color: #55514c; font-size: .9em; }
footer p:first-child > b:first-child { font-family: ${SERIF}; font-size: 1.2em; }
footer b { color: #1f1f1f; }
`;

/**
 * Shrinks the body's font size until the page is one page high, a tenth of a pixel at a time, never below the floor.
 * It runs as the page is read, before it counts as loaded (expo-print prints then), and again once its fonts are in.
 */
const FIT = `<script>(function () {
  var body = document.body;
  function fit() {
    var size = parseFloat(getComputedStyle(body).fontSize);
    while (document.documentElement.scrollHeight > ${PAGE.height} && size > ${FLOOR_PX}) {
      size = Math.max(${FLOOR_PX}, Math.round((size - 0.1) * 10) / 10);
      body.style.fontSize = size + 'px';
    }
  }
  fit();
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(fit);
})();</script>`;

/** The report as a page of HTML: one US Letter page when it fits, which the report screen checks. */
export function reportHtml(r: Report, opts: HtmlOptions = {}): string {
  const bySection = new Map<SectionId, ReportSection>(r.sections.map((s) => [s.id, s]));
  const at = (id: SectionId) => bySection.get(id);
  // Only base64 goes into the style sheet: anything else is left out, and the phone's serif stands in.
  const font = opts.displayFont?.replace(/\s+/g, '');
  const face =
    font && /^[A-Za-z0-9+/]+=*$/.test(font)
      ? `@font-face { font-family: 'Fraunces'; font-style: normal; font-weight: 600; font-display: swap; src: url(data:font/ttf;base64,${font}) format('truetype'); }`
      : '';
  // Asking for the font while the page is read keeps it loading before the page counts as loaded, and printed.
  const early = face ? '<script>try { document.fonts && document.fonts.load("600 16px Fraunces"); } catch (e) {}</script>' : '';
  return [
    '<!DOCTYPE html>',
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${esc(r.fileName.replace(/\.pdf$/, ''))}</title>`,
    `<style>${face}${STYLE}</style>${early}</head>`,
    '<body>',
    `<header><div class="kicker">${esc(r.kicker)}</div><h1>${esc(r.title)}</h1><p class="meta">${r.meta.map(esc).join(' · ')}</p></header>`,
    `<div class="stats">${r.stats.map(stat).join('')}</div>`,
    part(at('stores')),
    storeTable(r, at('table')),
    `<div class="cols"><div class="col">${part(at('speed'))}${part(at('data'))}${part(at('limit'))}</div>`,
    `<div class="col">${part(at('truth'))}${part(at('blocks'))}${part(at('cost'))}</div></div>`,
    `<footer>${r.notes.map(line).join('')}</footer>`,
    FIT,
    '</body></html>',
  ].join('\n');
}
