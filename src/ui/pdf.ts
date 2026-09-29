import { Fraunces_600SemiBold } from '@expo-google-fonts/fraunces/600SemiBold';
import { Asset } from 'expo-asset';
import { File, Paths } from 'expo-file-system';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import { Platform } from 'react-native';

// PDFs made on the phone (expo-print) and handed to the share sheet (expo-sharing): the results report's and Phone
// vs. cloud's.

/** Reading the font for the headings can't hold a PDF up longer than this: the phone's own serif stands in. */
const FONT_WAIT_MS = 3000;

/** "iOS 26.0", for a PDF's first line. */
export const SYSTEM = Platform.OS === 'ios' ? `iOS ${Platform.Version}` : Platform.OS === 'android' ? `Android (API ${Platform.Version})` : undefined;

/** Fraunces SemiBold as base64, read once from the app's own font file, for a PDF's headings. */
let fraunces: Promise<string | undefined> | null = null;
export function displayFont(): Promise<string | undefined> {
  fraunces ??= Asset.loadAsync(Fraunces_600SemiBold)
    .then(([asset]) => (asset?.localUri ? new File(asset.localUri).base64() : undefined))
    .catch(() => {
      fraunces = null;
      return undefined;
    });
  return Promise.race([fraunces, new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), FONT_WAIT_MS))]);
}

export function deleteQuietly(file: File): void {
  try {
    if (file.exists) file.delete();
  } catch {
    // The cache is the system's to clear, if it comes to that.
  }
}

/** A US Letter page in points, and the margin every page of a multi-page PDF gets. */
export const LETTER = { width: 612, height: 792 } as const;
export const PDF_MARGIN = 40;

/**
 * Makes a PDF of a multi-page document on the phone and opens the share sheet with it, named `fileName`. iOS takes
 * the margins as an option, and gives every page them; Android's printing, like Chromium's, takes them from the page's
 * own @page rule: `html` is given the margin its @page rule should have. The file isn't kept once the sheet closes:
 * a copy is wherever it was sent or saved.
 */
export async function sharePdf(opts: { html: (pageMargin: number) => string; fileName: string; dialogTitle: string }): Promise<{ pages: number }> {
  if (Platform.OS === 'web') throw new Error('PDFs are made on a phone, not in a browser');
  if (!(await Sharing.isAvailableAsync())) throw new Error('this phone can’t share files from the app');
  const ios = Platform.OS === 'ios';
  const out = await Print.printToFileAsync({
    html: opts.html(ios ? 0 : PDF_MARGIN),
    width: LETTER.width,
    height: LETTER.height,
    ...(ios ? { margins: { top: PDF_MARGIN, bottom: PDF_MARGIN, left: PDF_MARGIN, right: PDF_MARGIN } } : {}),
  });
  const pdf = new File(out.uri);
  try {
    try {
      // Its name when shared, instead of a random one.
      await pdf.move(new File(Paths.cache, opts.fileName), { overwrite: true });
    } catch {
      // Shared under its random name, then.
    }
    await Sharing.shareAsync(pdf.uri, { mimeType: 'application/pdf', UTI: 'com.adobe.pdf', dialogTitle: opts.dialogTitle });
  } finally {
    deleteQuietly(pdf);
  }
  return { pages: out.numberOfPages };
}
