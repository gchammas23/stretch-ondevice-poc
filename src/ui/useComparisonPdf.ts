import { useState } from 'react';
import type { Comparison } from '../cloud/compare';
import { comparisonPdfHtml, comparisonPdfName, type PdfInput } from '../cloud/comparePdf';
import { useCloudRunner } from '../state/CloudProvider';
import { announce } from './a11y';
import { deviceWord } from './device';
import { displayFont, sharePdf, SYSTEM } from './pdf';

/** "Sep 29, 2026, 2:14 PM", as the PDF says a run's time. */
const when = (at: number) => new Date(at).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });

/**
 * Makes a Phone vs. cloud PDF, one run's or every run's (see comparePdf.ts), with what the user wrote as its
 * findings, and opens the share sheet with it. When it can't, `problem` says why, and a screen reader hears it.
 */
export function useComparisonPdf(): { busy: boolean; problem: string | null; share: (scope: PdfInput['scope'], list: Comparison[]) => Promise<void> } {
  const runner = useCloudRunner();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const share = async (scope: PdfInput['scope'], list: Comparison[]) => {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    try {
      if (!list.length) throw new Error('there’s no finished run to put in it');
      const font = await displayFont();
      const input: Omit<PdfInput, 'pageMargin'> = {
        comparisons: list,
        scope,
        notes: { runs: Object.fromEntries(list.map((c) => [c.id, runner.getNotes(c.id)])), report: runner.getNotes() },
        madeAt: Date.now(),
        device: deviceWord,
        ...(SYSTEM ? { system: SYSTEM } : {}),
        when,
        ...(font ? { displayFont: font } : {}),
      };
      const { pages } = await sharePdf({
        html: (pageMargin) => comparisonPdfHtml({ ...input, pageMargin }),
        fileName: comparisonPdfName(input),
        dialogTitle: scope === 'all' ? 'Share every run' : 'Share this comparison',
      });
      announce(`The PDF is made: ${pages === 1 ? 'one page' : `${pages} pages`}. Choose where to send it.`);
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      setProblem(`The PDF couldn’t be made: ${why}.`);
      announce(`The PDF couldn’t be made: ${why}.`);
    } finally {
      setBusy(false);
    }
  };
  return { busy, problem, share };
}
