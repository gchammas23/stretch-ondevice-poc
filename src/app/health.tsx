import { router } from 'expo-router';
import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Platform, Share, ScrollView, StyleSheet, Text, TextInput, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { bytesSavedToday, bytesToday, storeHealth, type StoreHealth } from '../onDevice/attemptLog';
import { COVERAGE_WORDS, coverageText, type CoverageRow } from '../onDevice/coverage';
import { citizenReport, MAX_SEARCHES_PER_HOUR, type CitizenRow } from '../onDevice/politeness';
import { BUNDLED_CONFIG } from '../onDevice/retailers';
import { bytesText, reasonWords } from '../onDevice/scrapeFeed';
import { sessionText } from '../pricing/batteryCost';
import { whenLabel } from '../pricing/receipt';
import { useApp, useAttemptLog, useSettings } from '../state/AppProvider';
import { useBattery } from '../state/battery';
import { announce } from '../ui/a11y';
import { Chip } from '../ui/bits';
import { Pill, tap } from '../ui/controls';
import { deviceWord } from '../ui/device';
import { RetailerBadge } from '../ui/RetailerBadge';
import { ScreenHeader } from '../ui/ScreenHeader';
import { colors, fonts, radius, shadow } from '../ui/theme';
import { useNow } from '../ui/useNow';

const TONE = { works: 'green', bot_check: 'red', no_products: 'orange', slow: 'orange', failed: 'red' } as const;

/**
 * Store health: which stores this phone can read right now (one search at each), how reading them has gone over
 * the last week, and the store rules in use, which a hosted file can replace without an app update.
 */
export default function HealthScreen() {
  const insets = useSafeAreaInsets();
  const { coverage, runCoverage, bundle } = useApp();
  const log = useAttemptLog();
  const settings = useSettings();
  const state = useSyncExternalStore(coverage.subscribe, coverage.getSnapshot);
  const now = useNow(30_000);
  const enabled = bundle.retailers.filter((r) => r.enabled);
  const entries = log.entries();
  const health = enabled
    .map((r) => ({ retailer: r, health: storeHealth(entries, r.id, now) }))
    .filter((h) => h.health.attempts > 0 || settings.retailerIds.includes(h.retailer.id));
  const rows = state.stores.map((s) => state.rows[s.retailerId]).filter((r): r is CoverageRow => !!r);
  const works = rows.filter((r) => r.status === 'works').length;
  const done = rows.length;
  const { fontScale } = useWindowDimensions();

  // Screen readers hear the result when the check is done.
  const wasRunning = useRef(state.running);
  useEffect(() => {
    if (wasRunning.current && !state.running && rows.length) announce(`${works} of ${rows.length} stores work from this ${deviceWord}.`);
    wasRunning.current = state.running;
  });

  return (
    <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScreenHeader title="Store health" subtitle={`How reading each store goes, from this ${deviceWord}.`} />
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 32 }]}>
        <View style={styles.card}>
          <Text style={styles.title} accessibilityRole="header">
            Which stores work from here
          </Text>
          <Text style={styles.small}>
            Searches “{state.query}” once at each of the {enabled.length} stores, four at a time. Bot checks are noted, not shown.
          </Text>
          <View style={styles.row}>
            <Pill
              label={state.running ? `Checking… ${done} of ${state.stores.length}` : `Check all ${enabled.length} stores`}
              icon="refresh"
              small
              variant="dark"
              busy={false}
              disabled={state.running}
              onPress={() => {
                tap();
                void runCoverage();
              }}
            />
            {!state.running && rows.length ? (
              <Pill
                label="Share"
                icon="share"
                small
                variant="outline"
                onPress={() =>
                  void Share.share({ message: coverageText(state, `Stores readable from this ${deviceWord}, ${new Date(state.finishedAt ?? now).toLocaleString('en-US')}`) }).catch(() => {})
                }
              />
            ) : null}
          </View>
          {rows.length ? (
            <Text style={styles.summary}>
              {works} of {state.running ? done : rows.length} stores work from this {deviceWord}
              {state.finishedAt && !state.running ? ` · checked ${whenLabel(state.finishedAt, now)}` : ''}
            </Text>
          ) : null}
          {state.stores.map((s) => {
            const r = state.rows[s.retailerId];
            const checking = state.checking.includes(s.retailerId);
            return (
              <View key={s.retailerId} style={styles.storeRow}>
                <RetailerBadge retailerId={s.retailerId} name={s.name} size={28} />
                <View style={styles.flex}>
                  <Text style={styles.storeName}>{s.name}</Text>
                  {checking ? (
                    <View style={styles.row}>
                      <ActivityIndicator size="small" color={colors.orange} />
                      <Text style={styles.small}>Checking…</Text>
                    </View>
                  ) : r ? (
                    <Text style={styles.small} numberOfLines={fontScale > 1.3 ? undefined : 3}>
                      {r.status === 'works'
                        ? `${r.products} products in ${(r.ms / 1000).toFixed(1)} s · ${r.how}${r.bytes ? ` · ${bytesText(r.bytes)}` : ''}`
                        : (r.detail ?? reasonWords(r.reason))}
                    </Text>
                  ) : (
                    <Text style={styles.small}>{state.running ? 'Waiting' : 'Not checked yet'}</Text>
                  )}
                </View>
                {r && !checking ? <Chip label={COVERAGE_WORDS[r.status]} tone={TONE[r.status]} /> : null}
              </View>
            );
          })}
        </View>

        <View style={styles.card}>
          <Text style={styles.title} accessibilityRole="header">
            The last 7 days
          </Text>
          <Text style={styles.small}>
            Every search this {deviceWord} made, kept on it. About {bytesText(bytesToday(entries, now))} of data in the last day
            {bytesSavedToday(entries, now) ? `, and ${bytesText(bytesSavedToday(entries, now))} not used by asking stores for only the results the app keeps` : ''}.
          </Text>
          {health.map(({ retailer, health: h }) => (
            <HealthRow key={retailer.id} name={retailer.name} retailerId={retailer.id} h={h} now={now} />
          ))}
        </View>

        <CitizenCard />
        <Pill label="What would servers cost for this?" icon="phone" variant="outline" onPress={() => router.push('/cost')} />

        <RulesCard />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function HealthRow({ name, retailerId, h, now }: { name: string; retailerId: string; h: StoreHealth; now: number }) {
  const pct = h.rate !== undefined ? Math.round(h.rate * 100) : undefined;
  const max = Math.max(1, ...h.days.map((d) => d.total));
  return (
    <View style={styles.healthRow}>
      <View style={styles.row}>
        <RetailerBadge retailerId={retailerId} name={name} size={28} />
        <Text style={[styles.storeName, styles.flex]}>{name}</Text>
        {pct !== undefined ? <Chip label={`${pct}% worked`} tone={pct >= 90 ? 'green' : pct >= 60 ? 'orange' : 'red'} /> : null}
      </View>
      {h.attempts ? (
        <>
          <View
            style={styles.bars}
            accessible
            accessibilityRole="image"
            accessibilityLabel={`Searches that worked, by day: ${h.days
              .filter((d) => d.total)
              .map((d) => `${d.daysAgo === 0 ? 'today' : d.daysAgo === 1 ? 'yesterday' : `${d.daysAgo} days ago`}, ${d.ok} of ${d.total}`)
              .join('; ')}`}
          >
            {h.days.map((d) => (
              <View key={d.daysAgo} style={styles.barSlot}>
                <View style={[styles.bar, { height: 4 + (d.total / max) * 28 }]}>
                  <View style={[styles.barOk, { height: `${d.total ? (d.ok / d.total) * 100 : 0}%` }]} />
                </View>
                <Text style={styles.barDay}>{d.daysAgo === 0 ? 'today' : `-${d.daysAgo}`}</Text>
              </View>
            ))}
          </View>
          <Text style={styles.small}>
            {h.ok} of {h.attempts} searches worked
            {h.medianMs !== undefined ? ` · ${(h.medianMs / 1000).toFixed(1)} s each` : ''}
            {h.botChecks ? ` · ${h.botChecks} bot ${h.botChecks === 1 ? 'check' : 'checks'}` : ''}
            {h.bytes ? ` · ${bytesText(h.bytes)}` : ''}
            {h.bytesSaved ? ` (${bytesText(h.bytesSaved)} saved)` : ''}
          </Text>
          {h.lastFailure ? (
            <Text style={styles.small}>
              Last failure {whenLabel(h.lastFailure.at, now)}: {reasonWords(h.lastFailure.reason)}
            </Text>
          ) : null}
          {h.sinceRules ? (
            <Text style={[styles.small, { color: colors.green }]}>
              Since rules {h.sinceRules.version}: {h.sinceRules.ok} of {h.sinceRules.total} worked
            </Text>
          ) : null}
        </>
      ) : (
        <Text style={styles.small}>Not searched this week.</Text>
      )}
    </View>
  );
}

/**
 * How much the phone asked of each store today, next to what a person looking up the same things would load: the
 * answer to "isn't this hammering the stores?".
 */
function CitizenCard() {
  const { bundle } = useApp();
  const log = useAttemptLog();
  const now = useNow(60_000);
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const rows = citizenReport(log.entries(), midnight.getTime());
  const nameOf = (id: string) => bundle.retailers.find((r) => r.id === id)?.name ?? id;
  return (
    <View style={styles.card}>
      <Text style={styles.title} accessibilityRole="header">
        How much this {deviceWord} asks
      </Text>
      <Text style={styles.small}>
        Like one person shopping: one page at a time at each store, and never more than {MAX_SEARCHES_PER_HOUR} searches an hour at any of them.
        Past that, the store waits. Only your own lists and checks, only while the app is open.
      </Text>
      {rows.length ? (
        rows.map((row) => <CitizenLine key={row.retailerId} row={row} name={nameOf(row.retailerId)} />)
      ) : (
        <Text style={styles.small}>Nothing asked of any store today yet.</Text>
      )}
      <BatteryNote />
    </View>
  );
}

/** And what it asks of the phone: the battery this session's pricing took, from the phone's own readings (batteryCost.ts). */
function BatteryNote() {
  const battery = useBattery();
  return <Text style={[styles.small, styles.batteryNote]}>{sessionText(battery.session, battery.step, deviceWord)}</Text>;
}

function CitizenLine({ row, name }: { row: CitizenRow; name: string }) {
  const host = name;
  const parts = [
    row.pageLoads ? `${row.pageLoads} page ${row.pageLoads === 1 ? 'load' : 'loads'}` : null,
    row.reused ? `${row.reused} sent from a page already open` : null,
    row.api ? `${row.api} through its official API` : null,
    row.otherPages ? `${row.otherPages} other ${row.otherPages === 1 ? 'page' : 'pages'}` : null,
  ].filter(Boolean);
  return (
    <View style={styles.healthRow}>
      <View style={styles.row}>
        <RetailerBadge retailerId={row.retailerId} name={name} size={28} />
        <Text style={[styles.storeName, styles.flex]}>{name}</Text>
        <Chip label={`${row.busiestHour} of ${MAX_SEARCHES_PER_HOUR} in its busiest hour`} tone={row.busiestHour > MAX_SEARCHES_PER_HOUR * 0.8 ? 'orange' : 'green'} />
      </View>
      <Text style={styles.small}>
        {row.searches} {row.searches === 1 ? 'search' : 'searches'} today{parts.length ? `: ${parts.join(', ')}` : ''}
        {row.bytes ? ` · ${bytesText(row.bytes)}` : ''}
        {row.bytesSaved ? `, ${bytesText(row.bytesSaved)} less by asking for only what the app keeps` : ''}.
      </Text>
      {row.searches > 1 && row.reused ? (
        <Text style={styles.small}>
          Looking up the same {row.searches} things at {host} by hand takes {row.searches} full page loads, pictures and all.
        </Text>
      ) : null}
    </View>
  );
}

/** Store rules: where they come from, and a hosted file that can replace them. */
function RulesCard() {
  const { store, rules, checkRules, bundle } = useApp();
  const settings = useSettings();
  const [url, setUrl] = useState(settings.rulesUrl);
  const [busy, setBusy] = useState(false);
  const now = useNow(30_000);
  // Screen readers hear how each check of the file went.
  const lastCheck = useRef(rules.checkedAt);
  useEffect(() => {
    if (rules.checkedAt === lastCheck.current) return;
    lastCheck.current = rules.checkedAt;
    announce(rules.error ? `The file wasn’t used. ${rules.error}` : `Using store rules version ${rules.version}.`);
  }, [rules.checkedAt, rules.error, rules.version]);
  const check = async () => {
    setBusy(true);
    try {
      await checkRules();
    } finally {
      setBusy(false);
    }
  };
  const served = bundle.retailers.filter((r) => !r.addedByUser);
  return (
    <View style={styles.card}>
      <Text style={styles.title} accessibilityRole="header">
        Store rules
      </Text>
      <Text style={styles.body}>
        {rules.source === 'served' ? 'From your file' : 'Built into the app'}: version {rules.version}
        {rules.checkedAt ? ` · checked ${whenLabel(rules.checkedAt, now)}` : ''}
      </Text>
      {rules.error ? <Text style={[styles.small, { color: colors.red }]}>The file wasn’t used. {rules.error}</Text> : null}
      <Text style={styles.small}>
        A store’s search link, where its products are, and how to read them are rules, not code. To fix a store without an app
        update: share the current rules, put them in a GitHub Gist, change the store, and paste the Gist’s raw link here. The
        app fetches it now, and again when you come back to the app after half an hour.
      </Text>
      <TextInput
        value={url}
        onChangeText={setUrl}
        placeholder="https://gist.githubusercontent.com/…/rules.json"
        placeholderTextColor={colors.faint}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        style={styles.input}
        accessibilityLabel="Store rules link"
      />
      <View style={styles.rowWrap}>
        <Pill
          label={url.trim() === settings.rulesUrl ? 'Check now' : url.trim() ? 'Use this file' : 'Use the built-in rules'}
          small
          variant="dark"
          busy={busy}
          onPress={() => {
            if (url.trim() !== settings.rulesUrl) store.setRulesUrl(url);
            else void check();
          }}
        />
        <Pill
          label="Share the current rules"
          icon="share"
          small
          variant="outline"
          onPress={() =>
            void Share.share({ message: JSON.stringify({ version: `${rules.version}-edited`, retailers: served.length ? served : BUNDLED_CONFIG.retailers }, null, 2) }).catch(() => {})
          }
        />
      </View>
      <Text style={styles.hint}>A rules file can include scripts that run inside store pages. Only use a file you control.</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.paper },
  content: { paddingHorizontal: 16, gap: 12 },
  flex: { flex: 1, gap: 2 },
  card: { backgroundColor: colors.card, borderRadius: radius.lg, padding: 16, gap: 10, ...shadow.card },
  title: { fontFamily: fonts.semibold, fontSize: 17, color: colors.ink },
  body: { fontFamily: fonts.body, fontSize: 15, lineHeight: 21, color: colors.ink },
  small: { flexShrink: 1, fontFamily: fonts.body, fontSize: 13, lineHeight: 18, color: colors.muted },
  hint: { fontFamily: fonts.body, fontSize: 13, lineHeight: 18, color: colors.muted },
  summary: { fontFamily: fonts.semibold, fontSize: 15, color: colors.ink },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  rowWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  storeRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingTop: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  storeName: { fontFamily: fonts.semibold, fontSize: 15, color: colors.ink },
  healthRow: { gap: 6, paddingTop: 10, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  batteryNote: { paddingTop: 10, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  bars: { flexDirection: 'row', alignItems: 'flex-end', gap: 6, height: 50, marginLeft: 36 },
  barSlot: { alignItems: 'center', gap: 2, width: 26 },
  bar: { width: 14, borderRadius: 4, backgroundColor: '#F2D5CC', justifyContent: 'flex-end', overflow: 'hidden' },
  barOk: { width: '100%', backgroundColor: colors.green },
  barDay: { fontFamily: fonts.body, fontSize: 10, color: colors.muted },
  input: {
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.md,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontFamily: fonts.body,
    fontSize: 15,
    color: colors.ink,
    minWidth: 0,
  },
});
