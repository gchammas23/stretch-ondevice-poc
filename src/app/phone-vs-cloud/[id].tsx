import { router, useLocalSearchParams } from 'expo-router';
import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Platform, Pressable, ScrollView, Share, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  compareProblemWords,
  comparisonNotice,
  comparisonProblems,
  comparisonStatus,
  comparisonSummary,
  comparisonText,
  dataWords,
  durationWords,
  gapWords,
  linkWords,
  matchTerm,
  pricesWords,
  problemKindWords,
  SIDE_NAMES,
  sideFigures,
  sideReasonWords,
  sideRun,
  sidesOf,
  sideStatusWords,
  sideSummaryWords,
  testLinkWords,
  type CompareRetailerId,
  type Comparison,
  type SideFigures,
  type TermMatch,
} from '../../cloud/compare';
import type { CompareSide } from '../../cloud/jobs';
import { costWords, RETAILER_NAMES } from '../../cloud/words';
import { whenLabel } from '../../pricing/receipt';
import { useCloudRunner, useComparison } from '../../state/CloudProvider';
import { announce } from '../../ui/a11y';
import { Pill, tap } from '../../ui/controls';
import { FindingsBox } from '../../ui/FindingsBox';
import { Icon, type IconName } from '../../ui/Icon';
import { RetailerBadge } from '../../ui/RetailerBadge';
import { ScreenHeader } from '../../ui/ScreenHeader';
import { colors, fonts, money, radius, shadow } from '../../ui/theme';
import { useComparisonPdf } from '../../ui/useComparisonPdf';
import { useNow } from '../../ui/useNow';

/** How many differing prices show before "All N". */
const GAPS_SHOWN = 3;

/**
 * One Phone vs. cloud comparison: how many stores each side got prices from, what each took, then store by store,
 * side by side, and each search's same products at their two prices (see compare.ts).
 */
export default function ComparisonScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const insets = useSafeAreaInsets();
  const comparison = useComparison(id);
  const runner = useCloudRunner();
  const now = useNow(5_000);
  const { fontScale } = useWindowDimensions();
  const pdf = useComparisonPdf();
  const status = comparison ? comparisonStatus(comparison) : 'done';

  // Screen readers hear the result when the comparison ends.
  const wasRunning = useRef(status === 'running');
  useEffect(() => {
    if (wasRunning.current && status !== 'running' && comparison) {
      const { title, body } = comparisonNotice(comparison);
      announce(`${title}. ${body}`);
    }
    wasRunning.current = status === 'running';
  });

  if (!comparison) {
    return (
      <View style={styles.screen}>
        <ScreenHeader title="Phone vs. cloud" subtitle="This comparison isn’t on the phone any more." />
      </View>
    );
  }
  const c = comparison;

  const again = async () => {
    tap();
    const got = await runner.startComparison({ terms: c.terms, retailers: c.retailers, agent: !!c.sides.agent });
    if (!got.ok) Alert.alert('Not started', compareProblemWords(got));
    else router.replace(`/phone-vs-cloud/${got.comparison.id}`);
  };
  const shareText = () => {
    const heading = `Phone vs. cloud, ${new Date(c.createdAt).toLocaleString('en-US')}`;
    void Share.share({ message: comparisonText(c, heading) }).catch(() => {});
  };
  const sharePdf = () => {
    tap();
    void pdf.share('run', [c]);
  };

  return (
    <View style={styles.screen}>
      <ScreenHeader title="Phone vs. cloud" subtitle={`“${c.terms.join('”, “')}” · ${whenLabel(c.createdAt, now)}`} />
      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 32 }]}>
        <Hero
          comparison={c}
          status={status}
          onCancel={() => void runner.cancelComparison(c.id)}
          onAgain={() => void again()}
          onPdf={sharePdf}
          onText={shareText}
          making={pdf.busy}
          problem={pdf.problem}
        />
        <View style={styles.card}>
          <FindingsBox id={c.id} label="Your findings" placeholder="What you noticed, for the PDF: which side was right, faster, cheaper…" />
          <Text style={styles.small}>They go at the top of this run’s PDF, and in every run’s report.</Text>
        </View>
        <ProblemsCard comparison={c} />
        {c.retailers.map((r) => (
          <StoreCard key={r.retailerId} comparison={c} retailerId={r.retailerId} storeId={r.storeId} stacked={fontScale > 1.3} />
        ))}
        <View style={styles.card}>
          <Text style={styles.title} accessibilityRole="header">
            Every product each side read
          </Text>
          <Text style={styles.small}>Each side is kept as a search of its own, with its products, the store its data named, and its costs.</Text>
          <View style={styles.rowWrap}>
            {sidesOf(c).map((side) => (
              <Pill key={side} label={SIDE_NAMES[side]} icon="forward" small variant="outline" onPress={() => router.push(`/cloud/${c.sides[side]!.id}`)} />
            ))}
          </View>
        </View>
      </ScrollView>
    </View>
  );
}

/** The result: stores with prices on each side, what each took, the same products' prices, and what to do next. */
function Hero({
  comparison: c,
  status,
  onCancel,
  onAgain,
  onPdf,
  onText,
  making,
  problem,
}: {
  comparison: Comparison;
  status: string;
  onCancel: () => void;
  onAgain: () => void;
  onPdf: () => void;
  onText: () => void;
  making: boolean;
  problem: string | null;
}) {
  const summary = comparisonSummary(c);
  const running = status === 'running';
  return (
    <View style={styles.card}>
      <View style={styles.hero}>
        {summary.sides.map((s, i) => {
          const tone = running && !s.withPrices ? colors.muted : s.withPrices === s.stores ? colors.green : s.withPrices ? colors.amber : colors.red;
          return (
            <React.Fragment key={s.side}>
              {i ? <View style={styles.divider} /> : null}
              <View style={styles.side} accessible accessibilityLabel={sideSummaryWords(s)}>
                <Text style={styles.sideLabel}>{SIDE_NAMES[s.side]}</Text>
                <Text style={[styles.big, { color: tone }]}>{running && !s.withPrices ? '–' : `${s.withPrices} of ${s.stores}`}</Text>
                <Text style={styles.small}>stores gave prices</Text>
              </View>
            </React.Fragment>
          );
        })}
      </View>
      {running ? (
        <View style={styles.row}>
          <ActivityIndicator size="small" color={colors.orange} />
          <Text style={[styles.small, styles.flex]}>Comparing. Keep the app open: this phone’s side searches only while it’s on screen.</Text>
        </View>
      ) : null}
      {summary.sides.map((s) => (
        <Text key={s.side} style={styles.body}>
          {sideSummaryWords(s)}
        </Text>
      ))}
      {summary.sides.map((s) =>
        testLinkWords(s) ? (
          <Text key={`${s.side}-link`} style={styles.small}>
            {testLinkWords(s)}
          </Text>
        ) : null,
      )}
      {summary.prices.map((p) => (
        <Text key={p.side} style={[styles.body, styles.strong]}>
          {pricesWords(p)}
        </Text>
      ))}
      {status === 'interrupted' ? (
        <Text style={styles.warn}>A side was cut off (the app closed, or left the screen and lost its cloud browser): run it again for all sides.</Text>
      ) : status === 'cancelled' ? (
        <Text style={styles.small}>Cancelled: what came back before stays.</Text>
      ) : null}
      <View style={styles.rowWrap}>
        {running ? <Pill label="Cancel" small variant="outline" onPress={onCancel} /> : null}
        {!running ? (
          <Pill label={making ? 'Making the PDF…' : 'Share PDF'} accessibilityLabel="Share PDF of this comparison" icon="share" small variant="orange" busy={making} onPress={onPdf} />
        ) : null}
        {!running ? <Pill label="Run it again" icon="refresh" small variant="dark" onPress={onAgain} /> : null}
        {!running ? <Pill label="Share as text" small variant="outline" onPress={onText} /> : null}
      </View>
      {problem ? (
        <Text style={styles.bad} selectable accessibilityLiveRegion="polite">
          {problem}
        </Text>
      ) : null}
    </View>
  );
}

/** Everything that went wrong, side by side and store by store: why in plain words, and the exact error. */
function ProblemsCard({ comparison: c }: { comparison: Comparison }) {
  const problems = comparisonProblems(c);
  if (!problems.length) return null;
  return (
    <View style={styles.card}>
      <Text style={styles.title} accessibilityRole="header">
        What went wrong
      </Text>
      {problems.map((p, i) => {
        const where = [RETAILER_NAMES[p.retailerId], SIDE_NAMES[p.side], p.term ? `“${p.term}”` : ''].filter(Boolean).join(' · ');
        const minor = p.kind === 'other_store' || p.kind === 'mixed_store' || p.kind === 'unconfirmed' || p.kind === 'cancelled';
        return (
          <View key={`${p.side}-${p.retailerId}-${p.term ?? ''}-${i}`} style={[styles.problem, minor && styles.problemMinor]}>
            <Text style={styles.problemWhere}>
              {where} <Text style={[styles.problemKind, minor && styles.problemKindMinor]}>{problemKindWords(p.kind).toUpperCase()}</Text>
            </Text>
            <Text style={styles.body}>{p.words.charAt(0).toUpperCase() + p.words.slice(1)}.</Text>
            {p.detail ? (
              <Text style={styles.code} selectable>
                {p.detail}
              </Text>
            ) : null}
          </View>
        );
      })}
      {problems.some((p) => p.detail) ? (
        <Text style={styles.small}>The exact errors are as the cloud browser, Browser Use or this phone’s search gave them. They’re in the PDF too.</Text>
      ) : null}
    </View>
  );
}

/** One store: each side's status and figures side by side, then each search's same products at their two prices. */
function StoreCard({ comparison: c, retailerId, storeId, stacked }: { comparison: Comparison; retailerId: CompareRetailerId; storeId: string; stacked: boolean }) {
  const name = RETAILER_NAMES[retailerId];
  const sides = sidesOf(c).filter((side) => sideRun(c, side, retailerId));
  const cells = sides.map((side) => ({ side, figures: sideFigures(side, sideRun(c, side, retailerId)!) }));
  return (
    <View style={styles.card}>
      <View style={styles.row}>
        <RetailerBadge retailerId={retailerId} name={name} size={28} />
        <Text style={[styles.storeName, styles.flex]}>
          {name}, store {storeId}
        </Text>
      </View>
      {stacked ? (
        // Large text: one side below the other, each with its caption.
        cells.map(({ side, figures }) => (
          <View key={side} style={styles.cellStacked}>
            <Text style={styles.caption}>{SIDE_NAMES[side]}</Text>
            <SideValue figures={figures} storeId={storeId} />
          </View>
        ))
      ) : (
        // The captions in a row of their own, so the answers start level whatever the captions' lengths.
        <View style={styles.grid}>
          <View style={styles.cells}>
            {cells.map(({ side }) => (
              <Text key={side} style={[styles.caption, styles.cell]}>
                {SIDE_NAMES[side]}
              </Text>
            ))}
          </View>
          <View style={styles.cells}>
            {cells.map(({ side, figures }) => (
              <View key={side} style={styles.cell}>
                <SideValue figures={figures} storeId={storeId} />
              </View>
            ))}
          </View>
        </View>
      )}
      {c.terms.map((term) => (
        <TermBlock key={term} comparison={c} retailerId={retailerId} term={term} />
      ))}
    </View>
  );
}

const LOOK: Record<string, { color: string; icon: IconName }> = {
  done: { color: colors.green, icon: 'check' },
  unconfirmed: { color: colors.amber, icon: 'alert' },
  blocked: { color: colors.red, icon: 'close' },
  failed: { color: colors.amber, icon: 'alert' },
  interrupted: { color: colors.amber, icon: 'clock' },
  cancelled: { color: colors.muted, icon: 'close' },
};

/** One side at one store: how it ended (or that it's still going), then its figures a line each. */
function SideValue({ figures: f, storeId }: { figures: SideFigures; storeId: string }) {
  if (f.status === 'running' || f.status === 'queued') {
    return (
      <View style={styles.verdict}>
        <ActivityIndicator size="small" color={colors.orange} />
        <Text style={styles.meta}>{f.status === 'queued' ? 'Waiting' : f.searched ? `Searching (${f.searched} done)` : 'Searching…'}</Text>
      </View>
    );
  }
  const look = LOOK[f.status === 'done' ? (f.confirmed && !f.otherStore ? 'done' : 'unconfirmed') : f.status];
  const setup = f.setupMs !== undefined && f.setupMs >= 1000;
  const parts = (setupMs: number | undefined, searchMs: number | undefined) =>
    [setup && setupMs !== undefined ? `${durationWords(setupMs)} to set up` : '', searchMs !== undefined ? `${durationWords(searchMs)} a search` : ''].filter(Boolean).join(', ');
  const measured = parts(f.setupMs, f.searchMs);
  const estimated = parts(f.serverSetupMs, f.serverSearchMs);
  // The cloud browser's time as a server would have it comes first, marked as the estimate it is; then as measured.
  const time =
    f.serverMs !== undefined && f.totalMs !== undefined
      ? [
          `About ${durationWords(f.serverMs)} on a server (estimate)${estimated ? `: ${estimated}` : ''}`,
          `Measured from this phone: ${durationWords(f.totalMs)}${measured ? ` (${measured})` : ''}`,
        ]
      : [f.totalMs !== undefined ? `${durationWords(f.totalMs)} in all` : '', setup ? `${durationWords(f.setupMs!)} to set up` : '', f.searchMs !== undefined ? `${durationWords(f.searchMs)} a search` : ''];
  const lines = [
    f.searched || f.products ? `${f.products} ${f.products === 1 ? 'product' : 'products'}, ${f.searched} ${f.searched === 1 ? 'search' : 'searches'}` : '',
    ...time,
    f.storeSet === 'kept' ? 'Store kept from its last run' : '',
    f.side === 'phone' ? (f.phoneBytes !== undefined ? `${dataWords(f.phoneBytes)} of this phone’s data` : '') : f.cloudMb ? `${f.cloudMb.toFixed(1)} MB through the proxy` : '',
    f.side !== 'phone' && f.phoneBytes !== undefined ? `${dataWords(f.phoneBytes)} of results to this phone` : '',
    f.side === 'phone' ? 'Free' : f.usd > 0 ? costWords(f.usd) : 'Cost not reported yet',
    f.checkSeen ? 'Bot check seen' : '',
  ].filter(Boolean);
  const link = linkWords(f);
  return (
    <>
      <View style={styles.verdict}>
        <View style={styles.verdictIcon}>
          <Icon name={look.icon} size={14} color={look.color} strokeWidth={2.6} />
        </View>
        <Text style={[styles.verdictText, { color: look.color }]}>{sideStatusWords(f, storeId)}</Text>
      </View>
      {lines.map((line) => (
        <Text key={line} style={styles.meta}>
          {line}
        </Text>
      ))}
      {link ? <Text style={styles.faint}>Not counted: {link}.</Text> : null}
    </>
  );
}

/** One search at one store: for each cloud side, the products both read and their prices against this phone's. */
function TermBlock({ comparison: c, retailerId, term }: { comparison: Comparison; retailerId: CompareRetailerId; term: string }) {
  const phone = sideRun(c, 'phone', retailerId);
  const cloudSides = (['scripted', 'agent'] as const).filter((side) => sideRun(c, side, retailerId));
  const matches = cloudSides.map((side) => ({ side, m: matchTerm(term, phone, sideRun(c, side, retailerId)) }));
  const phoneTerm = matches[0]?.m.phone;
  return (
    <View style={styles.term}>
      <Text style={styles.termTitle}>“{term}”</Text>
      <TermSide side="phone" result={phoneTerm} storeId={phone?.storeId ?? ''} running={phone?.status === 'running' || phone?.status === 'queued'} />
      {matches.map(({ side, m }) => (
        <CloudTerm key={side} side={side} m={m} storeId={phone?.storeId ?? ''} running={isRunning(sideRun(c, side, retailerId)?.status)} />
      ))}
    </View>
  );
}

const isRunning = (status: string | undefined) => status === 'running' || status === 'queued';

/** A side's search, when it didn't bring products, or brought another store's. */
function TermSide({ side, result, storeId, running }: { side: CompareSide; result: TermMatch['phone']; storeId: string; running: boolean }) {
  const label = SIDE_NAMES[side];
  if (!result) return running ? <Text style={styles.meta}>{label}: searching…</Text> : <Text style={styles.meta}>{label}: not searched.</Text>;
  if (result.status !== 'done') return <Text style={styles.warn}>{`${label}: ${sideReasonWords(side, result.reason) || result.status}.`}</Text>;
  const how = result.how === 'replay' ? ', a request sent again' : result.how === 'page' ? ', a page load' : result.how === 'api' ? ', its API' : '';
  const server = side === 'scripted' && result.ms !== undefined && result.linkMs !== undefined ? ` (about ${durationWords(Math.max(0, result.ms - result.linkMs))} on a server)` : '';
  return (
    <>
      <Text style={styles.meta}>
        {label}: {result.found ?? result.items.length} products
        {result.ms !== undefined ? ` in ${durationWords(result.ms)}${server}${how}` : ''}
        {result.bytes !== undefined ? `, ${dataWords(result.bytes)}${side === 'phone' ? '' : ' through the proxy'}` : ''}.
      </Text>
      {result.storeMatches === false ? (
        <Text style={styles.warn}>
          Its data priced store {result.pageStoreId ?? '?'}, not {storeId}.
        </Text>
      ) : null}
    </>
  );
}

/** A cloud side's search against this phone's: products on both, the same price or not, and those that differ. */
function CloudTerm({ side, m, storeId, running }: { side: Exclude<CompareSide, 'phone'>; m: TermMatch; storeId: string; running: boolean }) {
  const [all, setAll] = useState(false);
  if (!m.cloud || m.cloud.status !== 'done') return <TermSide side={side} result={m.cloud} storeId={storeId} running={running} />;
  const gaps = all ? m.differ : m.differ.slice(0, GAPS_SHOWN);
  return (
    <View style={styles.cloudTerm}>
      <TermSide side={side} result={m.cloud} storeId={storeId} running={running} />
      {m.phone?.status === 'done' ? (
        <Text style={[styles.meta, styles.strong, { color: m.both && m.same === m.both ? colors.green : m.both ? colors.amber : colors.muted }]}>
          {m.both ? `${m.both} on both, ${m.same} the same price` : 'No product on both'}
          {m.onlyPhone || m.onlyCloud ? ` · ${m.onlyPhone} only on this phone, ${m.onlyCloud} only in the cloud` : ''}
        </Text>
      ) : null}
      {m.phone?.status === 'done' && m.elsewhere ? (
        <Text style={styles.warn}>
          {m.elsewhere} more on both {m.elsewhere === 1 ? 'was' : 'were'} priced for another store, and not compared.
        </Text>
      ) : null}
      {gaps.length ? (
        <View style={styles.gap} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
          <Text style={[styles.caption, styles.flex]}>Priced differently</Text>
          <View style={styles.gapPrices}>
            <Text style={[styles.caption, styles.gapHead]}>Phone</Text>
            <Text style={[styles.caption, styles.gapHead]}>{side === 'agent' ? 'Agent' : 'Cloud'}</Text>
          </View>
        </View>
      ) : null}
      {gaps.map((g) => (
        <View key={g.itemId} style={styles.gap} accessible accessibilityLabel={gapWords(g, side)}>
          <Text style={[styles.meta, styles.flex]} numberOfLines={2}>
            {g.name}
          </Text>
          <View style={styles.gapPrices}>
            <Text style={styles.gapPrice}>{g.phone === null ? '—' : money(g.phone)}</Text>
            <Text style={[styles.gapPrice, { color: colors.amber }]}>{g.cloud === null ? '—' : money(g.cloud)}</Text>
          </View>
        </View>
      ))}
      {m.differ.length > GAPS_SHOWN ? (
        <Pressable accessibilityRole="button" accessibilityState={{ expanded: all }} hitSlop={12} onPress={() => setAll(!all)}>
          <Text style={styles.link}>{all ? 'Fewer' : `All ${m.differ.length} that differ`}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.paper },
  content: { paddingHorizontal: 16, gap: 12 },
  flex: { flex: 1 },
  card: { backgroundColor: colors.card, borderRadius: radius.lg, padding: 16, gap: 10, ...shadow.card },
  hero: { flexDirection: 'row', gap: 12 },
  side: { flex: 1, gap: 2 },
  sideLabel: { fontFamily: fonts.semibold, fontSize: 12, letterSpacing: 0.6, textTransform: 'uppercase', color: colors.muted },
  big: { fontFamily: fonts.display, fontSize: 30, lineHeight: 36, color: colors.ink, fontVariant: ['tabular-nums'] },
  divider: { width: StyleSheet.hairlineWidth, backgroundColor: colors.line },
  title: { fontFamily: fonts.semibold, fontSize: 17, color: colors.ink },
  body: { fontFamily: fonts.body, fontSize: 15, lineHeight: 21, color: colors.ink },
  strong: { fontFamily: fonts.semibold },
  small: { flexShrink: 1, fontFamily: fonts.body, fontSize: 13, lineHeight: 18, color: colors.muted },
  warn: { flexShrink: 1, fontFamily: fonts.medium, fontSize: 13, lineHeight: 18, color: colors.amber },
  bad: { flexShrink: 1, fontFamily: fonts.medium, fontSize: 13, lineHeight: 18, color: colors.red },
  problem: { gap: 3, borderLeftWidth: 3, borderLeftColor: colors.red, paddingLeft: 10 },
  problemMinor: { borderLeftColor: colors.amber },
  problemWhere: { fontFamily: fonts.semibold, fontSize: 14, color: colors.ink },
  problemKind: { fontFamily: fonts.semibold, fontSize: 11, letterSpacing: 0.6, color: colors.red },
  problemKindMinor: { color: colors.amber },
  code: {
    fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }),
    fontSize: 12,
    lineHeight: 17,
    color: colors.ink,
    backgroundColor: colors.chip,
    borderRadius: radius.sm,
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  link: { fontFamily: fonts.semibold, fontSize: 14, color: colors.orangeText },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  rowWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  storeName: { fontFamily: fonts.semibold, fontSize: 15, color: colors.ink },
  grid: { gap: 4 },
  cells: { flexDirection: 'row', gap: 8 },
  cell: { flex: 1, gap: 3 },
  // Large text: one below the other, each as tall as its words.
  cellStacked: { gap: 3 },
  caption: { fontFamily: fonts.semibold, fontSize: 11, lineHeight: 14, letterSpacing: 0.4, textTransform: 'uppercase', color: colors.muted },
  verdict: { flexDirection: 'row', alignItems: 'flex-start', gap: 4 },
  // Level with the first line of the words beside it.
  verdictIcon: { paddingTop: 2 },
  verdictText: { flexShrink: 1, fontFamily: fonts.semibold, fontSize: 13, lineHeight: 18 },
  meta: { flexShrink: 1, fontFamily: fonts.body, fontSize: 12, lineHeight: 16, color: colors.muted },
  term: { gap: 4, paddingTop: 10, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  termTitle: { fontFamily: fonts.semibold, fontSize: 15, color: colors.ink },
  cloudTerm: { gap: 4 },
  gap: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 32 },
  gapPrices: { flexDirection: 'row', gap: 10 },
  gapPrice: { minWidth: 52, textAlign: 'right', fontFamily: fonts.semibold, fontSize: 13, color: colors.ink, fontVariant: ['tabular-nums'] },
  gapHead: { minWidth: 52, textAlign: 'right' },
  faint: { flexShrink: 1, fontFamily: fonts.body, fontSize: 11, lineHeight: 15, color: colors.faint },
});
