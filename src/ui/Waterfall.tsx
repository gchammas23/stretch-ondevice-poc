import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { PACE_WORDS, paceParts, type PaceKind, type SpeedProfile, type StoreProfile } from '../pricing/scorecard';
import { colors, fonts, radius } from './theme';

/** A color for each kind of time: greys for waiting, oranges for a page load (lighter first), then one each. */
export const PACE_COLORS: Record<PaceKind, string> = {
  queue: '#DAD6CF',
  wait: '#B3AEA6',
  start: '#FCD3C5',
  open: '#F9A083',
  prices: colors.orange,
  settle: '#A83A22',
  check: '#E0A100',
  replay: '#3FA46A',
  fetch: colors.blue,
  api: '#7FB2E3',
  parse: '#7B5EA7',
  show: '#1F9C9C',
  failed: '#E7B1AB',
  idle: '#EEEBE6',
};

/** The order the kinds come in on a timeline, for the bar and the legend. */
const ORDER: PaceKind[] = ['queue', 'wait', 'start', 'open', 'prices', 'settle', 'check', 'replay', 'fetch', 'api', 'parse', 'show', 'failed', 'idle'];
const LABEL_WIDTH = 64;

const secs = (ms: number) => (ms < 1000 ? `${(ms / 1000).toFixed(2)} s` : `${(ms / 1000).toFixed(1)} s`);

/** Where a run's time went at the store that finished last, as one bar, then the biggest costs in words. */
export function WhereTimeWent({ profile }: { profile: SpeedProfile }) {
  const s = profile.slowest;
  if (!s || !s.endMs) return null;
  const words = paceParts(s.pace).map((p) => `${PACE_WORDS[p.kind]} ${secs(p.ms)}`);
  return (
    <View style={styles.where}>
      <Text style={styles.title} accessibilityRole="header">
        Where the {secs(profile.totalMs)} went
      </Text>
      <View style={styles.bar} accessible accessibilityRole="image" accessibilityLabel={`${s.name} finished last: ${words.join(', ')}.`}>
        {ORDER.filter((k) => (s.pace[k] ?? 0) > 0).map((k) => (
          <View key={k} style={{ flex: s.pace[k], backgroundColor: PACE_COLORS[k] }} />
        ))}
      </View>
      <Text style={styles.meta}>
        {s.name} finished last: {words.join(' · ')}.
      </Text>
      {profile.findings.map((f) => (
        <Text key={f} style={styles.finding}>
          • {f}
        </Text>
      ))}
    </View>
  );
}

/** One store's searches as bars on the run's time scale: when each waited, loaded a page, replayed, read, showed. */
export function StoreWaterfall({ store, profile }: { store: StoreProfile; profile: SpeedProfile }) {
  if (!store.rows.length) return null;
  const total = Math.max(1, profile.totalMs);
  const at = (t: number) => Math.min(100, Math.max(0, ((t - profile.startedAt) / total) * 100));
  const label = `Timeline for ${store.name}, done at ${secs(store.endMs)}: ${store.rows
    .map((r) => `${r.query}, ${r.how}, from ${secs(r.start - profile.startedAt)} to ${secs(r.end - profile.startedAt)}`)
    .join('; ')}.`;
  return (
    <View style={styles.fall} accessible accessibilityRole="image" accessibilityLabel={label}>
      {store.rows.map((r, i) => (
        <View key={`${r.query}-${i}`} style={styles.row}>
          <Text style={[styles.rowLabel, !r.ok && styles.rowFailed]} numberOfLines={1} maxFontSizeMultiplier={1.2}>
            {r.query}
          </Text>
          <View style={styles.track}>
            {r.spans.map((s, j) => (
              <View
                key={j}
                style={[
                  styles.seg,
                  { left: `${at(s.start)}%`, width: `${Math.max(0, at(s.end) - at(s.start))}%`, backgroundColor: PACE_COLORS[s.ok === false ? 'failed' : s.kind] },
                ]}
              />
            ))}
          </View>
        </View>
      ))}
    </View>
  );
}

/** What the colors mean, and the time scale: only the kinds the run had. The words above say it all for screen readers. */
export function WaterfallLegend({ profile }: { profile: SpeedProfile }) {
  const failed = profile.stores.some((s) => s.rows.some((r) => r.spans.some((x) => x.ok === false)));
  const kinds = ORDER.filter((k) => (k === 'failed' ? failed : k !== 'idle' && (profile.sums[k] ?? 0) > 0));
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={styles.legendBox}>
      <View style={styles.row}>
        <View style={{ width: LABEL_WIDTH - 6 }} />
        <View style={styles.axis}>
          <Text style={styles.axisText}>0 s</Text>
          <Text style={styles.axisText}>{secs(profile.totalMs / 2)}</Text>
          <Text style={styles.axisText}>{secs(profile.totalMs)}</Text>
        </View>
      </View>
      <View style={styles.legend}>
        {kinds.map((k) => (
          <View key={k} style={styles.key}>
            <View style={[styles.swatch, { backgroundColor: PACE_COLORS[k] }]} />
            <Text style={styles.keyText} maxFontSizeMultiplier={1.3}>
              {PACE_WORDS[k]}
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  where: { gap: 6 },
  title: { fontFamily: fonts.semibold, fontSize: 15, color: colors.ink },
  bar: { flexDirection: 'row', height: 14, borderRadius: radius.sm, overflow: 'hidden', backgroundColor: colors.chip },
  meta: { fontFamily: fonts.body, fontSize: 13, lineHeight: 18, color: colors.muted },
  finding: { fontFamily: fonts.body, fontSize: 13, lineHeight: 18, color: colors.ink },
  fall: { gap: 3, marginTop: 4 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  rowLabel: { width: LABEL_WIDTH - 6, fontFamily: fonts.body, fontSize: 11, color: colors.muted },
  rowFailed: { color: colors.red },
  track: { flex: 1, height: 8, borderRadius: 2, backgroundColor: colors.chip, overflow: 'hidden' },
  seg: { position: 'absolute', top: 0, bottom: 0 },
  legendBox: { gap: 6, marginTop: 4 },
  axis: { flex: 1, flexDirection: 'row', justifyContent: 'space-between' },
  axisText: { fontFamily: fonts.body, fontSize: 11, color: colors.muted },
  legend: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 12, rowGap: 4 },
  key: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  swatch: { width: 10, height: 10, borderRadius: 2 },
  keyText: { fontFamily: fonts.body, fontSize: 12, color: colors.muted },
});
