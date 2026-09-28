import { router } from 'expo-router';
import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Platform, Share, ScrollView, StyleSheet, Text, TextInput, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { bytesSavedToday, bytesToday, storeHealth, type StoreHealth } from '../onDevice/attemptLog';
import { COVERAGE_WORDS, coverageCounts, coverageDetail, coverageText, type CoverageRow } from '../onDevice/coverage';
import { summaryLine, versusSummary } from '../onDevice/phoneVsServer';
import { citizenReport, MAX_SEARCHES_PER_HOUR, type CitizenRow } from '../onDevice/politeness';
import { AGREE, STALE_MISSES, whereWords } from '../onDevice/profiles';
import { BUNDLED_CONFIG } from '../onDevice/retailers';
import { bytesText, reasonWords } from '../onDevice/scrapeFeed';
import { connectionWords, coolWords, dropFromLog, isRest, storeTuner, type CoolDown } from '../onDevice/tuning';
import type { ParserProfile } from '../onDevice/types';
import { sessionText } from '../pricing/batteryCost';
import { whenLabel } from '../pricing/receipt';
import { useApp, useAttemptLog, useProfiles, useSettings } from '../state/AppProvider';
import { useBattery } from '../state/battery';
import { announce } from '../ui/a11y';
import { Chip } from '../ui/bits';
import { Pill, tap } from '../ui/controls';
import { deviceWord } from '../ui/device';
import { RetailerBadge } from '../ui/RetailerBadge';
import { ScreenHeader } from '../ui/ScreenHeader';
import { colors, fonts, radius, shadow } from '../ui/theme';
import { useNow } from '../ui/useNow';

const TONE = { works: 'green', few: 'orange', bot_check: 'red', no_products: 'orange', slow: 'orange', failed: 'red', no_store: 'plain', cooling: 'plain' } as const;

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
  // A store with none near the ZIP code wasn't searched: it's counted apart, not as a failure.
  const { works, searched, noStore } = coverageCounts(rows);
  const apart = noStore ? `, and ${noStore} ${noStore === 1 ? 'has' : 'have'} no store near you` : '';
  const done = rows.length;
  const { fontScale } = useWindowDimensions();

  // Screen readers hear the result when the check is done.
  const wasRunning = useRef(state.running);
  useEffect(() => {
    if (wasRunning.current && !state.running && rows.length) announce(`${works} of ${searched} stores work from this ${deviceWord}${apart}.`);
    wasRunning.current = state.running;
  });

  return (
    <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScreenHeader title="Store health" subtitle={`How reading each store goes, from this ${deviceWord}.`} />
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 32 }]}>
        <Pill label="Results report: one page to share, as a PDF" icon="share" small variant="outline" onPress={() => router.push('/report')} style={styles.alignStart} />
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
              {works} of {searched} stores work from this {deviceWord}
              {apart}
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
                      {r.status === 'works' || r.status === 'few'
                        ? `${r.products} ${r.products === 1 ? 'product' : 'products'} in ${(r.ms / 1000).toFixed(1)} s · ${r.how}${r.bytes ? ` · ${bytesText(r.bytes)}` : ''}${r.status === 'few' ? ' · likely not the search’s results' : ''}`
                        : coverageDetail(r)}
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

        <CoolDownCard />

        <VersusCard />

        <View style={styles.card}>
          <Text style={styles.title} accessibilityRole="header">
            The last 7 days
          </Text>
          <Text style={styles.small}>
            Every search this {deviceWord} made, kept on it, but for the store check’s, above. About {bytesText(bytesToday(entries, now))} of data in the last day, all told
            {bytesSavedToday(entries, now) ? `, and ${bytesText(bytesSavedToday(entries, now))} not used by asking stores for only the results the app keeps` : ''}.
          </Text>
          {health.map(({ retailer, health: h }) => (
            <HealthRow key={retailer.id} name={retailer.name} retailerId={retailer.id} h={h} now={now} />
          ))}
        </View>

        <CitizenCard />
        <Pill label="What would servers cost for this?" icon="phone" variant="outline" onPress={() => router.push('/cost')} />

        <ProfilesCard />
        <RulesCard />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

/**
 * Blocks and cool-downs: the stores (or ways of searching one) the phone leaves alone after they refused it, until when,
 * and a dropped connection, which cools nothing down.
 */
function CoolDownCard() {
  const { bundle } = useApp();
  const log = useAttemptLog();
  const now = useNow(15_000);
  const nameOf = (id: string) => bundle.retailers.find((r) => r.id === id)?.name ?? id;
  const all = storeTuner.coolDowns();
  const cools = all.filter((c) => !isRest(c));
  const rests = all.filter(isRest);
  const drop = storeTuner.connection() ?? dropFromLog(log.entries(), now);
  return (
    <View style={styles.card}>
      <Text style={styles.title} accessibilityRole="header">
        Blocks and cool-downs
      </Text>
      <Text style={styles.small}>
        A store that refuses this {deviceWord}, openly or not (a page that says so, HTTP 403 or 429, a nearly empty page, no results for searches
        that worked before), isn’t searched again until a retry time: 10 minutes, twice that each time within two hours, an hour at most. When
        another way of searching it still works, only the blocked way waits. The hourly limit holds as always.
      </Text>
      {drop ? <Text style={[styles.small, { color: colors.amber }]}>{connectionWords(drop, nameOf, deviceWord)}</Text> : null}
      {cools.length ? (
        cools.map((c) => <CoolLine key={`${c.retailerId}:${c.way ?? ''}`} cool={c} name={nameOf(c.retailerId)} />)
      ) : (
        <Text style={styles.body}>Nothing is cooling down right now.</Text>
      )}
      {rests.length ? (
        <View style={styles.rests}>
          {rests.map((c) => (
            <Text key={`${c.retailerId}:${c.way ?? ''}`} style={styles.small}>
              {nameOf(c.retailerId)}: {coolWords(c)}.
            </Text>
          ))}
        </View>
      ) : null}
    </View>
  );
}

function CoolLine({ cool, name }: { cool: CoolDown; name: string }) {
  return (
    <View style={styles.storeRow} accessible accessibilityLabel={`${name}: ${coolWords(cool)}.${cool.way ? ' Its other searches go on.' : ''}`}>
      <RetailerBadge retailerId={cool.retailerId} name={name} size={28} />
      <View style={styles.flex}>
        <Text style={styles.storeName}>{name}</Text>
        <Text style={styles.small}>
          {coolWords(cool)}.{cool.way ? ' Its other searches go on.' : ''}
        </Text>
      </View>
      <Chip label={cool.way ? 'One way' : 'Cooling down'} tone={cool.way ? 'plain' : 'orange'} />
    </View>
  );
}

/**
 * Where the phone learned each store's results are (its profile, see profiles.ts): learned when and from how many
 * searches, when it last matched, and a reset, after which the phone learns it again.
 */
function ProfilesCard() {
  const { bundle } = useApp();
  const book = useProfiles();
  const settings = useSettings();
  const now = useNow(60_000);
  const stores = bundle.retailers.filter((r) => r.enabled && r.parser === 'autoDetect' && (settings.retailerIds.includes(r.id) || book.get(r.id) || book.lastSeen(r.id)));
  const own = bundle.retailers.filter((r) => settings.retailerIds.includes(r.id) && r.parser !== 'autoDetect');
  return (
    <View style={styles.card}>
      <Text style={styles.title} accessibilityRole="header">
        Where each store’s results are
      </Text>
      <Text style={styles.small}>
        The general reader guesses on every search which list in a store’s data is its results, and where each price is. Once {AGREE} searches agree
        (the same list, fitting what was searched), or the price truth check agrees, that’s the store’s profile: later searches read there first,
        and when it stops matching, the phone learns again. A list much smaller than the store gives, or one that doesn’t name what was searched,
        isn’t learned. Shared rules carry the profiles.
      </Text>
      {stores.map((r) => (
        <ProfileLine key={r.id} retailerId={r.id} name={r.name} now={now} />
      ))}
      {own.length ? <Text style={styles.small}>{own.map((r) => r.name).join(', ')}: read with {own.length === 1 ? 'its' : 'their'} own parser or API, no profile needed.</Text> : null}
    </View>
  );
}

function ProfileLine({ retailerId, name, now }: { retailerId: string; name: string; now: number }) {
  const book = useProfiles();
  const p = book.get(retailerId);
  const seen = book.lastSeen(retailerId);
  const agreeing = book.progress(retailerId);
  const reset = () => {
    book.reset(retailerId);
    announce(`${name}’s profile was reset. The phone learns where its results are again from its next searches.`);
  };
  return (
    <View style={styles.healthRow}>
      <View style={styles.row}>
        <RetailerBadge retailerId={retailerId} name={name} size={28} />
        <Text style={[styles.storeName, styles.flex]}>{name}</Text>
        <Chip label={p ? ((p.misses ?? 0) >= STALE_MISSES ? 'Learning again' : 'Learned') : 'Learning'} tone={p && (p.misses ?? 0) < STALE_MISSES ? 'green' : 'plain'} />
      </View>
      {p ? (
        <>
          <Text style={styles.small}>Reads its results in {whereWords(p)}.</Text>
          <Text style={styles.small}>{learnedWords(p, now)}</Text>
          {(p.misses ?? 0) >= STALE_MISSES ? (
            <Text style={[styles.small, { color: colors.amber }]}>
              It didn’t match its last {p.misses} searches: the general reader read them, and the phone is learning where its results are again.
            </Text>
          ) : null}
        </>
      ) : (
        <Text style={styles.small}>
          {seen ? `Not learned yet: ${agreeing} of ${AGREE} searches agree so far.` : 'Not searched yet.'}
          {seen?.suspect ? ` Its last list may not be the results: ${seen.suspect}.` : ''}
        </Text>
      )}
      {p || seen ? (
        <Pill
          label="Reset"
          icon="refresh"
          small
          variant="outline"
          accessibilityLabel={`Reset ${name}’s profile`}
          accessibilityHint="The phone forgets where its results are, and learns it again from its next searches"
          onPress={reset}
          style={styles.alignStart}
        />
      ) : null}
    </View>
  );
}

/** "Learned 2 h ago from 3 searches that agreed; last matched 5 min ago." */
function learnedWords(p: ParserProfile, now: number): string {
  const how = p.how === 'truth' ? 'confirmed by the price truth check' : p.how === 'rules' ? 'from the rules file' : `from ${p.searches} searches that agreed`;
  const matched = p.matchedAt ? `; last matched ${whenLabel(p.matchedAt, now)}` : '';
  return `Learned ${whenLabel(p.learnedAt, now)}, ${how}${matched}.`;
}

/** Phone vs. server: the last test's result, and the way to it. */
function VersusCard() {
  const { versus } = useApp();
  const state = useSyncExternalStore(versus.subscribe, versus.getSnapshot);
  const now = useNow(60_000);
  const summary = versusSummary(state);
  return (
    <View style={styles.card}>
      <Text style={styles.title} accessibilityRole="header">
        Phone vs. server
      </Text>
      <Text style={styles.small}>
        {state.finishedAt && summary.tried
          ? `${summaryLine(summary, deviceWord)} Tested ${whenLabel(state.finishedAt, now)}.`
          : `Could a server read these stores? A live test at each store: a plain request, the way a scraping server asks, against this ${deviceWord}’s own browser.`}
      </Text>
      <View style={styles.row}>
        <Pill
          label={state.running ? 'Testing now' : 'Open the test'}
          accessibilityLabel={`${state.running ? 'Testing now' : 'Open the test'}: phone vs. server`}
          icon="globe"
          small
          variant="outline"
          onPress={() => router.push('/phone-vs-server')}
        />
      </View>
    </View>
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
            {h.coolDowns ? ` · cooled down ${h.coolDowns === 1 ? 'once' : `${h.coolDowns} times`}` : ''}
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
  const book = useProfiles();
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
  // The rules as they stand, with what the phone learned of where each store's results are.
  const served = bundle.retailers
    .filter((r) => !r.addedByUser)
    .map((r) => {
      const profile = book.get(r.id);
      return profile ? { ...r, profile } : r;
    });
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
  rests: { gap: 4, paddingTop: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  alignStart: { alignSelf: 'flex-start' },
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
