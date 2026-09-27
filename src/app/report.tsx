import { Fraunces_600SemiBold } from '@expo-google-fonts/fraunces/600SemiBold';
import { Asset } from 'expo-asset';
import { File, Paths } from 'expo-file-system';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import React, { useState, useSyncExternalStore } from 'react';
import { Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { versusSummary } from '../onDevice/phoneVsServer';
import { clockText } from '../onDevice/tuning';
import { buildReport, type ReportInput, type ReportSection, type ReportStat } from '../pricing/report';
import { PAGE, reportHtml } from '../pricing/reportHtml';
import { scorecard, SPEED_ITEMS, SPEED_TEST } from '../pricing/scorecard';
import { useApp, useAttemptLog, useLists, useSettings, useStoreChoices } from '../state/AppProvider';
import { useBattery } from '../state/battery';
import { announce, useFooterHeight } from '../ui/a11y';
import { Chip } from '../ui/bits';
import { Pill, tap } from '../ui/controls';
import { deviceWord } from '../ui/device';
import { Icon } from '../ui/Icon';
import { ScreenHeader } from '../ui/ScreenHeader';
import { colors, fonts, radius, shadow } from '../ui/theme';
import { useNow } from '../ui/useNow';

/** When the page still runs past one at its smallest type, the table keeps this many stores. */
const FEWER_ROWS = 6;
/** Reading the font for the headings can't hold the PDF up longer than this: the phone's own serif stands in. */
const FONT_WAIT_MS = 3000;

/** "iOS 26.0", for the report's first line. */
const SYSTEM = Platform.OS === 'ios' ? `iOS ${Platform.Version}` : Platform.OS === 'android' ? `Android (API ${Platform.Version})` : undefined;

/** Fraunces SemiBold as base64, read once from the app's own font file, for the PDF's headings. */
let fraunces: Promise<string | undefined> | null = null;
function displayFont(): Promise<string | undefined> {
  fraunces ??= Asset.loadAsync(Fraunces_600SemiBold)
    .then(([asset]) => (asset?.localUri ? new File(asset.localUri).base64() : undefined))
    .catch(() => {
      fraunces = null;
      return undefined;
    });
  return Promise.race([fraunces, new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), FONT_WAIT_MS))]);
}

/**
 * The results report: one page of what this phone measured, to share with people who weren't there. The screen shows
 * what goes in it; Make the PDF makes it on the phone (expo-print) and opens the share sheet (expo-sharing).
 */
export default function ReportScreen() {
  const insets = useSafeAreaInsets();
  const { bundle, rules, engine, coverage, truth, versus } = useApp();
  const log = useAttemptLog();
  const settings = useSettings();
  const lists = useLists();
  const choices = useStoreChoices();
  const battery = useBattery();
  const checkState = useSyncExternalStore(coverage.subscribe, coverage.getSnapshot);
  const lastTruth = useSyncExternalStore(truth.subscribe, truth.getSnapshot);
  const versusState = useSyncExternalStore(versus.subscribe, versus.getSnapshot);
  const now = useNow(15_000);
  const [busy, setBusy] = useState(false);
  const [made, setMade] = useState<{ at: number; pages: number } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [footerHeight, onFooterLayout] = useFooterHeight(120 + insets.bottom);
  const canMake = Platform.OS !== 'web';

  /** Everything the report is made from, as it stands: the phone's records, and what ran since the app opened. */
  const gather = (at: number, maxRows?: number): ReportInput => {
    const speedRun = engine.getRun(SPEED_TEST);
    const priced = lists
      .map((list) => engine.getRun(list.id))
      .filter((run) => run?.finishedAt !== undefined)
      .map((run) => ({ items: new Set(Object.values(run!.results).flatMap((r) => Object.keys(r))).size, at: run!.finishedAt!, card: scorecard(run!) }))
      .sort((a, b) => b.at - a.at);
    return {
      now: at,
      device: deviceWord,
      ...(SYSTEM ? { system: SYSTEM } : {}),
      zip: settings.zip,
      rules: { version: rules.version, source: rules.source },
      stores: bundle.retailers.map((r) => ({ id: r.id, name: r.name })),
      compared: choices.map((c) => c.config.id),
      entries: log.entries(),
      coverage: checkState,
      ...(speedRun?.finishedAt !== undefined
        ? { speed: { card: scorecard(speedRun), at: speedRun.startedAt, items: SPEED_ITEMS.length, ...(battery.lastRun ? { kind: battery.lastRun.kind } : {}) } }
        : {}),
      lists: priced,
      ...(lastTruth ? { truth: lastTruth } : {}),
      ...(versusState.finishedAt !== undefined ? { versus: { at: versusState.finishedAt, summary: versusSummary(versusState) } } : {}),
      ...(maxRows ? { maxRows } : {}),
    };
  };
  const report = buildReport(gather(now));
  const speedRun = engine.getRun(SPEED_TEST);
  const speedRunning = battery.busy || (!!speedRun && speedRun.finishedAt === undefined);

  const make = async () => {
    tap();
    setBusy(true);
    setProblem(null);
    let pdf: File | null = null;
    try {
      if (!(await Sharing.isAvailableAsync())) throw new Error(`this ${deviceWord} can’t share files from the app`);
      const font = await displayFont();
      const at = Date.now();
      const print = (maxRows?: number) => {
        const r = buildReport(gather(at, maxRows));
        return Print.printToFileAsync({ html: reportHtml(r, { displayFont: font }), width: PAGE.width, height: PAGE.height }).then((out) => ({ ...out, r }));
      };
      let out = await print();
      // Past one page even at its smallest type: fewer stores in the table.
      if (out.numberOfPages > 1) {
        deleteQuietly(new File(out.uri));
        out = await print(FEWER_ROWS);
      }
      pdf = new File(out.uri);
      try {
        // Its name when shared, instead of a random one.
        await pdf.move(new File(Paths.cache, out.r.fileName), { overwrite: true });
      } catch {
        // Shared under its random name, then.
      }
      setMade({ at, pages: out.numberOfPages });
      announce(`The PDF is made: ${out.numberOfPages === 1 ? 'one page' : `${out.numberOfPages} pages`}. Choose where to send it.`);
      await Sharing.shareAsync(pdf.uri, { mimeType: 'application/pdf', UTI: 'com.adobe.pdf', dialogTitle: 'Share the results report' });
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      setProblem(`The PDF couldn’t be made: ${why}.`);
      announce(`The PDF couldn’t be made: ${why}.`);
    } finally {
      // Not kept on the phone once the share sheet has closed: a copy is wherever it was sent or saved.
      if (pdf) deleteQuietly(pdf);
      setBusy(false);
    }
  };

  const missing = report.sections.filter((s) => !s.has).length;

  return (
    <View style={styles.screen}>
      <ScreenHeader title="Results report" subtitle={`One page to share: what this ${deviceWord} measured, as a PDF.`} />
      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: footerHeight + 16 }]}>
        <View style={styles.card}>
          <Text style={styles.kicker}>{report.kicker}</Text>
          <Text style={styles.title}>{report.title}</Text>
          <Text style={styles.small}>{report.meta.join(' · ')}</Text>
          <View style={styles.stats}>
            {report.stats.map((s) => (
              <Stat key={s.label} stat={s} />
            ))}
          </View>
        </View>

        <View style={styles.card}>
          <Text style={styles.heading} accessibilityRole="header">
            What goes in it
          </Text>
          <Text style={styles.small}>
            {missing
              ? `${missing} ${missing === 1 ? 'part says' : 'parts say'} how to measure ${missing === 1 ? 'it' : 'them'} instead, until you do. `
              : 'Every part has something measured. '}
            The last 7 days come from this {deviceWord}’s own log; the speed test and lists priced count since the app opened.
          </Text>
          {report.sections.map((s) => (
            <SectionLine key={s.id} section={s} />
          ))}
        </View>

        {checkState.running ? <Text style={styles.warn}>The store check is still running: what it has so far goes in.</Text> : null}
        {speedRunning ? <Text style={styles.warn}>A speed test is running: it goes in once it’s done.</Text> : null}
        <Text style={styles.note}>
          Made on this {deviceWord}, it goes only where you send it. It has the ZIP code’s area, not the ZIP code or where the phone is, and no lists or
          products. Numbers that are estimates or assumptions say so. Once you’ve shared it, the PDF isn’t kept here.
        </Text>
      </ScrollView>

      <View style={[styles.footer, { paddingBottom: insets.bottom + 12 }]} onLayout={onFooterLayout}>
        <Pill
          label={busy ? 'Making the PDF…' : 'Make the PDF'}
          icon="share"
          variant="orange"
          busy={busy}
          disabled={!canMake}
          accessibilityHint="Makes one page of these results as a PDF, then opens the share sheet"
          onPress={() => void make()}
        />
        {!canMake ? <Text style={styles.small}>Making the PDF needs the app on a phone.</Text> : null}
        {made && !problem ? (
          <Text style={styles.small}>
            Made at {clockText(made.at)}: {made.pages === 1 ? 'one page' : `${made.pages} pages, even at its smallest type`}.
          </Text>
        ) : null}
        {problem ? <Text style={[styles.small, { color: colors.red }]}>{problem}</Text> : null}
      </View>
    </View>
  );
}

function deleteQuietly(file: File): void {
  try {
    if (file.exists) file.delete();
  } catch {
    // The cache is the system's to clear, if it comes to that.
  }
}

/** A headline figure, as at the top of the page. */
function Stat({ stat }: { stat: ReportStat }) {
  const spoken = stat.none ? stat.label : `${stat.value}: ${stat.label}${stat.basis === 'estimate' ? ', an estimate' : ''}`;
  return (
    <View style={styles.stat} accessible accessibilityLabel={spoken}>
      <Text style={[styles.value, stat.none && styles.none]}>{stat.value}</Text>
      <Text style={styles.small}>{stat.label}</Text>
      {stat.basis === 'estimate' ? <Chip label="Estimate" tone="plain" /> : null}
    </View>
  );
}

/** A part of the page: what it says, or how to measure it. */
function SectionLine({ section: s }: { section: ReportSection }) {
  return (
    <View style={styles.line} accessible accessibilityLabel={`${s.title}${s.has ? '' : ', not measured yet'}. ${s.summary}`}>
      <Icon name={s.has ? 'check' : 'info'} size={18} color={s.has ? colors.green : colors.faint} strokeWidth={s.has ? 2.6 : 2} />
      <View style={styles.flex}>
        <Text style={styles.lineTitle}>{s.title}</Text>
        <Text style={styles.small}>{s.summary}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.paper },
  content: { paddingHorizontal: 16, gap: 12 },
  flex: { flex: 1, gap: 2 },
  card: { backgroundColor: colors.card, borderRadius: radius.lg, padding: 16, gap: 8, ...shadow.card },
  kicker: { fontFamily: fonts.bold, fontSize: 12, letterSpacing: 1.4, textTransform: 'uppercase', color: colors.orangeText },
  title: { fontFamily: fonts.display, fontSize: 24, lineHeight: 30, color: colors.ink },
  heading: { fontFamily: fonts.semibold, fontSize: 17, color: colors.ink },
  small: { fontFamily: fonts.body, fontSize: 13, lineHeight: 18, color: colors.muted },
  note: { fontFamily: fonts.body, fontSize: 13, lineHeight: 18, color: colors.muted, paddingHorizontal: 4 },
  warn: { fontFamily: fonts.body, fontSize: 14, lineHeight: 19, color: colors.amber, backgroundColor: colors.amberTint, padding: 10, borderRadius: radius.sm },
  stats: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, marginTop: 6 },
  stat: { flexBasis: '45%', flexGrow: 1, gap: 2, paddingTop: 6, borderTopWidth: 2, borderTopColor: colors.orange },
  value: { fontFamily: fonts.display, fontSize: 24, lineHeight: 30, color: colors.ink },
  none: { color: colors.faint },
  line: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, paddingTop: 10, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  lineTitle: { fontFamily: fonts.semibold, fontSize: 15, color: colors.ink },
  footer: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    gap: 6,
    paddingHorizontal: 16,
    paddingTop: 12,
    backgroundColor: '#F2F1EC',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line,
  },
});
