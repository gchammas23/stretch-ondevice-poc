import { router } from 'expo-router';
import React, { useState, useSyncExternalStore } from 'react';
import { Alert, FlatList, Image, Pressable, ScrollView, Share, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { krogerApiConfigured, krogerEnvironment } from '../onDevice/krogerApi';
import type { Product, RetailerConfig, SearchOutcome, Strategy } from '../onDevice/types';
import { SearchFailed } from '../onDevice/useRetailerSearch';
import { storeTuner, tuningBase, tuningWords } from '../onDevice/tuning';
import type { WebViewQueue } from '../onDevice/webviewQueue';
import { ago } from '../pricing/age';
import { PRODUCTS_KEPT } from '../pricing/priceCache';
import { scorecard, scorecardText, speedProfile, speedProfileText } from '../pricing/scorecard';
import { bytesText } from '../onDevice/scrapeFeed';
import { useApp, usePricingRun, useSettings, useStoreChoices } from '../state/AppProvider';
import { Pill } from '../ui/controls';
import { deviceWord } from '../ui/device';
import { ScreenHeader } from '../ui/ScreenHeader';
import { colors, fonts, radius } from '../ui/theme';
import { useNow } from '../ui/useNow';
import { useScreenTimes } from '../ui/useScreenTimes';
import { StoreWaterfall, WaterfallLegend, WhereTimeWent } from '../ui/Waterfall';

/** The speed test prices these at every compared store, as a list of its own that no screen shows. */
const SPEED_TEST = '__speedtest__';
const SPEED_ITEMS = ['milk', 'eggs', 'bread', 'bananas', 'butter', 'coffee'];

type Mode = 'auto' | Strategy;

const STRATEGY_LABELS: Record<Strategy, string> = {
  fetch: 'Plain request',
  webview: 'WebView',
  api: 'Official API',
};

function modesFor(cfg: RetailerConfig | undefined): { value: Mode; label: string }[] {
  const strategies = cfg?.strategies ?? [];
  if (strategies.length <= 1) return [];
  return [{ value: 'auto', label: 'Auto' }, ...strategies.map((s) => ({ value: s, label: STRATEGY_LABELS[s] }))];
}

/** The engineering view: one search at a time with every detail, and what each retailer's WebView lane is doing. */
export default function DiagnosticsScreen() {
  const { bundle, search, cache } = useApp();
  const [retailerId, setRetailerId] = useState('walmart');
  const [storeId, setStoreId] = useState('');
  const [query, setQuery] = useState('whole milk');
  const [mode, setMode] = useState<Mode>('auto');
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<SearchOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);

  const retailers = bundle.retailers.filter((r) => r.enabled);
  const cfg = retailers.find((r) => r.id === retailerId) ?? retailers[0];
  const modes = modesFor(cfg);
  const activeMode: Mode = modes.some((m) => m.value === mode) ? mode : 'auto';

  const pickRetailer = (id: string) => {
    setRetailerId(id);
    setMode('auto');
    setOutcome(null);
    setError(null);
  };

  const run = async (task: () => Promise<SearchOutcome | null>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setOutcome(null);
    try {
      const result = await task();
      if (result) setOutcome(result);
    } catch (e) {
      setError(e instanceof SearchFailed ? `No results. ${e.message}` : String(e));
    } finally {
      setBusy(false);
    }
  };

  const runSearch = () => {
    if (!cfg || !query.trim()) return;
    run(() => search.search(cfg, query, storeId.trim(), activeMode === 'auto' ? undefined : activeMode));
  };

  return (
    <View style={styles.screen}>
      <ScreenHeader title="Diagnostics" subtitle={`Retailer rules: ${bundle.version} · ${cache.size} saved searches`} />
      <FlatList
        data={outcome?.products ?? []}
        keyExtractor={(p, i) => `${p.id}-${i}`}
        renderItem={({ item }) => <ProductRow product={item} />}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={styles.list}
        ListHeaderComponent={
          <View style={styles.form}>
            <Pill label="Store health: which stores work, and how often" icon="heartPulse" small variant="outline" onPress={() => router.push('/health')} style={styles.alignStart} />
            <Pill label="What servers would cost instead" icon="phone" small variant="outline" onPress={() => router.push('/cost')} style={styles.alignStart} />
            <StartOver />
            <SpeedTest />
            <Lanes />
            <RecentFailures />

            <Text style={styles.heading} accessibilityRole="header">
              One search
            </Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
              {retailers.map((r) => {
                const selected = r.id === cfg?.id;
                return (
                  <Pressable
                    key={r.id}
                    accessibilityRole="radio"
                    accessibilityState={{ checked: selected }}
                    hitSlop={{ top: 6, bottom: 6 }}
                    onPress={() => pickRetailer(r.id)}
                    style={[styles.chip, selected && styles.chipOn]}
                  >
                    <Text style={[styles.chipText, selected && styles.chipTextOn]}>{r.name}</Text>
                  </Pressable>
                );
              })}
            </ScrollView>
            {cfg ? <Text style={styles.meta}>{cfg.note}</Text> : null}

            <Text style={styles.label}>Store</Text>
            <TextInput
              value={storeId}
              onChangeText={setStoreId}
              placeholder="Store number, ZIP or locationId"
              placeholderTextColor={colors.faint}
              keyboardType="number-pad"
              style={styles.input}
              accessibilityLabel="Store"
            />
            {cfg ? <Text style={styles.meta}>{cfg.storeHint}</Text> : null}

            <Text style={styles.label}>Search</Text>
            <TextInput
              value={query}
              onChangeText={setQuery}
              onSubmitEditing={runSearch}
              returnKeyType="search"
              autoCorrect={false}
              style={styles.input}
              accessibilityLabel="Search"
            />

            {modes.length ? <Segmented options={modes} value={activeMode} onChange={setMode} /> : null}

            {cfg?.id === 'walmart' && !cfg.cookieTemplate ? (
              <Text style={styles.warn}>
                No store cookie is set for Walmart, so a plain request gets the store Walmart picks for this phone’s location.
              </Text>
            ) : null}
            {cfg?.api === 'kroger' && !krogerApiConfigured() ? (
              <Text style={styles.warn}>Kroger API credentials aren’t set, so Kroger searches go straight to the website. See the README.</Text>
            ) : null}
            {cfg?.api === 'kroger' && krogerApiConfigured() && krogerEnvironment() === 'certification' ? (
              <Text style={styles.warn}>
                These Kroger keys are certification keys, so Kroger is searched on its certification environment (api-ce.kroger.com), which
                Kroger provides for testing: its prices may not be the store’s own. Production keys give live prices; see the README.
              </Text>
            ) : null}

            <Pill label={`Search ${cfg?.name ?? ''}`} variant="orange" busy={busy} disabled={!cfg} onPress={runSearch} style={styles.button} />
            <Pressable accessibilityRole="button" onPress={() => cfg && run(() => search.readFromSite(cfg, query))} disabled={busy || !cfg} style={styles.linkButton}>
              <Text style={styles.linkText}>Open {cfg?.name ?? 'the'} site to pick a store or read a page</Text>
            </Pressable>

            {outcome ? <Text style={styles.status}>{summary(outcome)}</Text> : null}
            {error ? <Text style={styles.error}>{error}</Text> : null}
          </View>
        }
        ListEmptyComponent={outcome && !busy ? <Text style={styles.meta}>The page loaded but listed no products for this search.</Text> : null}
      />
    </View>
  );
}

/**
 * The same six searches at every compared store, ignoring saved prices: from cold (pages unloaded, so each store's
 * first search loads its page) or warm (pages kept, so searches reuse them). A scorecard to share, with each search's
 * timeline (waiting, page load, replay, reading, to the screen) and where the run's time went.
 */
function SpeedTest() {
  const { engine, pool } = useApp();
  const choices = useStoreChoices();
  const run = usePricingRun(SPEED_TEST);
  const now = useNow(run && !run.finishedAt ? 500 : 60_000);
  const [mode, setMode] = useState<'cold' | 'warm'>('cold');
  // The last results reach this panel after the run ends: once they have, the timeline is drawn again with them.
  const [, setShown] = useState(0);
  useScreenTimes(run, () => {
    if (run?.finishedAt) setShown((n) => n + 1);
  });
  const card = run ? scorecard(run) : null;
  const running = !!run && !run.finishedAt;
  const profile = run && !running ? speedProfile(run) : null;
  const settled = run ? Object.values(run.stores).reduce((n, s) => n + s.settled, 0) : 0;
  const total = run ? Object.values(run.stores).reduce((n, s) => n + s.total, 0) : 0;

  const start = (next: 'cold' | 'warm') => {
    if (next === 'cold') pool.resetAll();
    setMode(next);
    engine.start(SPEED_TEST, SPEED_ITEMS, choices, { refresh: true });
  };
  const onOff = (on: boolean) => (on ? 'on' : 'off');
  const heading = () =>
    `Stretch on-device speed test (${mode === 'cold' ? 'cold start' : 'pages kept warm'}), on this ${deviceWord}, ${new Date(run!.startedAt).toLocaleString('en-US')}\n` +
    `${SPEED_ITEMS.length} searches × ${run!.retailerIds.length} stores: ${SPEED_ITEMS.join(', ')}\n` +
    `Replays ${onOff(pool.replayEnabled)} · lighter pages ${onOff(pool.lightPages)} · asking for only what the app keeps ${onOff(pool.leanRequests)} · adapting to each store ${onOff(storeTuner.enabled)}`;
  // How hard each store is pushed now, after this run: what the next one starts from.
  const tuningText = () =>
    `How hard each store is pushed now:\n${choices.map(({ config }) => `${config.name}: ${tuningWords(storeTuner.get(config.id, tuningBase(config)))}`).join('\n')}`;

  return (
    <View style={styles.panel}>
      <Text style={styles.panelTitle} accessibilityRole="header">
        Speed test
      </Text>
      <Text style={styles.meta}>
        Searches {SPEED_ITEMS.join(', ')} at your {choices.length} stores, ignoring saved prices. Cold unloads every page first; warm reuses
        the pages left from the last run.
      </Text>
      <View style={styles.panelActions}>
        <Pill label="Run from cold" small variant="dark" busy={running && mode === 'cold'} disabled={running || !choices.length} onPress={() => start('cold')} />
        <Pill label="Run again warm" small variant="outline" busy={running && mode === 'warm'} disabled={running || !run} onPress={() => start('warm')} />
        {running ? <Pill label="Stop" small variant="outline" onPress={() => engine.stop(SPEED_TEST)} /> : null}
      </View>
      {run && card ? (
        <>
          <Text style={styles.status}>
            {running
              ? `${settled} of ${total} searches · ${((now - run.startedAt) / 1000).toFixed(1)} s`
              : `${card.ok} of ${card.searches} worked · ${card.products} products read · first price after ${
                  card.firstMs !== undefined ? `${(card.firstMs / 1000).toFixed(1)} s` : '—'
                } · all in ${card.totalMs !== undefined ? `${(card.totalMs / 1000).toFixed(1)} s` : '—'}${card.bytes ? ` · about ${bytesText(card.bytes)}` : ''}${
                  card.bytesSaved ? `, ${bytesText(card.bytesSaved)} saved` : ''
                }${card.shared ? ` · ${card.shared} shared a search` : ''}`}
          </Text>
          {profile ? <WhereTimeWent profile={profile} /> : null}
          {card.stores.map((s) => (
            <View key={s.retailerId} style={styles.lane}>
              <Text style={styles.laneName}>
                {s.name}{' '}
                <Text style={styles.meta}>
                  · {s.ok}/{s.searches || SPEED_ITEMS.length}
                  {s.totalMs !== undefined ? ` in ${(s.totalMs / 1000).toFixed(1)} s` : ''}
                </Text>
              </Text>
              <Text style={styles.meta}>
                {[
                  s.medianMs !== undefined ? `median ${(s.medianMs / 1000).toFixed(1)} s` : null,
                  s.firstMs !== undefined ? `first after ${(s.firstMs / 1000).toFixed(1)} s` : null,
                  s.pageLoads ? `${s.pageLoads} page ${s.pageLoads === 1 ? 'load' : 'loads'}` : null,
                  s.reused ? `${s.reused} reused page` : null,
                  s.api ? `${s.api} official API` : null,
                  s.direct ? `${s.direct} direct` : null,
                  s.bytes ? `${bytesText(s.bytes)}${s.bytesSaved ? `, ${bytesText(s.bytesSaved)} saved` : ''}` : null,
                  s.shared ? `${s.shared} shared a search` : null,
                  s.failed ? `${s.failed} failed` : null,
                ]
                  .filter(Boolean)
                  .join(' · ') || (running ? 'waiting' : 'nothing searched')}
              </Text>
              {profile ? <StoreWaterfall store={profile.stores.find((p) => p.retailerId === s.retailerId)!} profile={profile} /> : null}
            </View>
          ))}
          {profile && profile.searches ? <WaterfallLegend profile={profile} /> : null}
          {!running ? (
            <Pill
              label="Share results"
              icon="share"
              small
              variant="outline"
              onPress={() =>
                void Share.share({ message: `${scorecardText(card, heading())}${profile ? `\n\n${speedProfileText(profile)}` : ''}\n\n${tuningText()}` }).catch(() => {})
              }
              style={styles.alignStart}
            />
          ) : null}
        </>
      ) : null}
    </View>
  );
}

/** Hidden pages without images, fonts or video: less data and quicker first loads. On by default. */
function LightPagesSwitch() {
  const { store } = useApp();
  const on = useSettings().lightPages;
  return (
    <View style={styles.panelRow}>
      <View style={styles.flex}>
        <Text style={styles.panelTitle} accessibilityRole="header">
          Lighter hidden pages
        </Text>
        <Text style={styles.meta}>
          Hidden store pages skip images, fonts and video; prices arrive as data anyway. A bot check is reloaded in full. Turn it off, then run the
          speed test, to compare data and time.
        </Text>
      </View>
      <Switch
        value={on}
        onValueChange={(v) => store.setLightPages(v)}
        trackColor={{ true: colors.orange, false: colors.faint }}
        thumbColor="#FFFFFF"
        accessibilityLabel="Lighter hidden pages"
      />
    </View>
  );
}

/** Watch it scrape: the hidden store pages drawn small over the app, with a feed of what the phone does. */
function LiveViewSwitch() {
  const { pool } = useApp();
  const live = useSyncExternalStore(pool.subscribe, () => pool.getSnapshot().live);
  return (
    <View style={styles.panelRow}>
      <View style={styles.flex}>
        <Text style={styles.panelTitle} accessibilityRole="header">
          Watch it scrape
        </Text>
        <Text style={styles.meta}>Shows the hidden store pages live, small, over any screen, with a feed of every search. For demos.</Text>
      </View>
      <Switch
        value={live !== 'off'}
        onValueChange={(on) => pool.setLiveView(on ? 'open' : 'off')}
        trackColor={{ true: colors.orange, false: colors.faint }}
        thumbColor="#FFFFFF"
        accessibilityLabel="Watch it scrape"
      />
    </View>
  );
}

/** For demos: the app as on a first launch, with the welcome, or just the welcome again. */
function StartOver() {
  const { store, startOver } = useApp();
  const confirm = () =>
    Alert.alert(
      'Start over?',
      'Lists, trips, savings, stores and prices on this phone are erased, and the welcome shows, as on a first launch. A store you chose on a retailer’s own website stays chosen there, in that site’s cookies.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Start over',
          style: 'destructive',
          onPress: async () => {
            await startOver();
            router.replace('/welcome');
          },
        },
      ],
    );
  return (
    <View style={styles.panel}>
      <Text style={styles.panelTitle} accessibilityRole="header">
        Start over
      </Text>
      <Text style={styles.meta}>
        For a demo of the first launch. Start over erases everything on this {deviceWord}; Show the welcome again keeps your lists, stores
        and prices.
      </Text>
      <View style={styles.panelActions}>
        <Pill label="Start over" icon="refresh" small variant="dark" onPress={confirm} />
        <Pill
          label="Show the welcome again"
          small
          variant="outline"
          onPress={() => {
            store.setOnboarded(false);
            router.replace('/welcome');
          }}
        />
      </View>
    </View>
  );
}

/** What each retailer's WebView is doing, refreshed every second. */
function Lanes() {
  const { pool, cache, history } = useApp();
  const choices = useStoreChoices();
  useNow(1000);
  const [replay, setReplay] = useState(pool.replayEnabled);
  const [lean, setLean] = useState(pool.leanRequests);
  const [adapt, setAdapt] = useState(storeTuner.enabled);
  const lanes = pool.all();

  return (
    <View style={styles.panel}>
      <LiveViewSwitch />
      <LightPagesSwitch />
      <View style={styles.panelRow}>
        <View style={styles.flex}>
          <Text style={styles.panelTitle} accessibilityRole="header">
            Replay searches in a loaded page
          </Text>
          <Text style={styles.meta}>
            Off: every WebView search loads the retailer’s whole page, as the first version did. Turn it off to compare timings.
          </Text>
        </View>
        <Switch
          value={replay}
          onValueChange={(on) => {
            pool.setReplayEnabled(on);
            setReplay(on);
          }}
          trackColor={{ true: colors.orange, false: colors.faint }}
          thumbColor="#FFFFFF"
          accessibilityLabel="Replay searches in a loaded page"
        />
      </View>
      <View style={styles.panelRow}>
        <View style={styles.flex}>
          <Text style={styles.panelTitle} accessibilityRole="header">
            Ask for only what the app keeps
          </Text>
          <Text style={styles.meta}>
            Where a store’s search request says how many results to send, replays ask for {PRODUCTS_KEPT}, what the app keeps, instead of the
            page’s 24 or 60, and check the answer. Off: they ask as the page does.
          </Text>
        </View>
        <Switch
          value={lean}
          onValueChange={(on) => {
            pool.setLeanRequests(on);
            setLean(on);
          }}
          trackColor={{ true: colors.orange, false: colors.faint }}
          thumbColor="#FFFFFF"
          accessibilityLabel="Ask for only what the app keeps"
        />
      </View>
      <View style={styles.panelRow}>
        <View style={styles.flex}>
          <Text style={styles.panelTitle} accessibilityRole="header">
            Adapt to each store
          </Text>
          <Text style={styles.meta}>
            Fast, healthy stores get more searches at once and tighter timeouts; slow or failing ones fewer, with more time; one that pushes
            back (a bot check, “too many requests”) one at a time, with a pause. Never past the hourly limit or one page load at a time. Off:
            every store the same, as before.
          </Text>
        </View>
        <Switch
          value={adapt}
          onValueChange={(on) => {
            storeTuner.enabled = on;
            setAdapt(on);
          }}
          trackColor={{ true: colors.orange, false: colors.faint }}
          thumbColor="#FFFFFF"
          accessibilityLabel="Adapt to each store"
        />
      </View>
      {choices.map(({ config }) => (
        <Text key={config.id} style={styles.meta}>
          <Text style={styles.tuneName}>{config.name}</Text> · {tuningWords(storeTuner.get(config.id, tuningBase(config)))}
        </Text>
      ))}
      {lanes.length ? (
        lanes.map((lane) => <LaneLine key={lane.key} lane={lane} />)
      ) : (
        <Text style={styles.meta}>No retailer has been searched with a WebView yet.</Text>
      )}
      <View style={styles.panelActions}>
        <Pill label="Unload all pages" small variant="outline" onPress={pool.resetAll} />
        <Pill label="Forget saved prices" small variant="outline" onPress={() => cache.clear()} />
        <Pill label="Forget price history" small variant="outline" onPress={() => history.clear()} />
      </View>
    </View>
  );
}

/** Failed attempts from pricing and single searches, newest first, with what the page showed. On the phone only. */
function RecentFailures() {
  const { search } = useApp();
  const now = useNow(2000);
  const failures = search.recentFailures();
  if (!failures.length) return null;
  return (
    <View style={styles.panel}>
      <Text style={styles.panelTitle} accessibilityRole="header">
        Recent failures
      </Text>
      {failures.slice(0, 12).map((f, i) => (
        <View key={`${f.at}-${i}`} style={styles.lane}>
          <Text style={styles.laneName}>
            {f.retailer} · {f.query} <Text style={styles.meta}>· {ago(now - f.at)}</Text>
          </Text>
          <Text style={styles.meta}>
            {STRATEGY_LABELS[f.strategy]}: {f.reason}
          </Text>
          {f.detail ? <Text style={styles.meta}>{f.detail}</Text> : null}
        </View>
      ))}
    </View>
  );
}

function LaneLine({ lane }: { lane: WebViewQueue }) {
  const load = lane.getSnapshot();
  const state = !load
    ? 'no page'
    : load.phase === 'idle'
      ? 'page kept, idle'
      : load.phase === 'hidden'
        ? 'loading a page'
        : load.phase === 'challenge'
          ? 'bot check on screen'
          : 'user visiting';
  const t = lane.template;
  const learned = !t ? 'nothing learned yet' : t.kind === 'document' ? 'replays: the search page’s own data' : `replays: ${t.request.method} ${t.request.url.replace(/\?.*$/, '').replace(/^https?:\/\//, '').slice(0, 70)}`;
  const lean = t?.kind === 'json' ? t.lean : undefined;
  const size = !lean
    ? null
    : lean.state === 'on'
      ? `asks for ${lean.to} results instead of the page’s ${lean.from}`
      : lean.state === 'trial'
        ? `will ask for ${lean.to} results instead of ${lean.from}, checking the answer`
        : `asks for ${lean.from} results, as its page does: a smaller page size didn’t work there`;
  return (
    <View style={styles.lane}>
      <Text style={styles.laneName}>
        {lane.label} <Text style={styles.meta}>· {state}</Text>
      </Text>
      <Text style={styles.meta}>{learned}</Text>
      {size ? <Text style={styles.meta}>{size}</Text> : null}
      <Text style={styles.meta}>
        {lane.stats.pageLoads} page loads · {lane.stats.replays} replays · {lane.stats.replayMisses} unusable
      </Text>
    </View>
  );
}

function summary(o: SearchOutcome): string {
  const trail = o.attempts
    .filter((a) => a.reason !== 'resting')
    .map((a) =>
      a.ok
        ? `${STRATEGY_LABELS[a.strategy]}${a.via === 'replay' ? ' (replayed in a loaded page)' : a.via === 'page' ? ' (page load)' : ''} worked`
        : `${STRATEGY_LABELS[a.strategy]} failed (${a.reason})`,
    )
    .join(', then ');
  const lines = [`${o.retailer}: ${o.products.length} products in ${(o.ms / 1000).toFixed(1)} s. ${trail}.`];
  if (o.source) lines.push(`Found in: ${o.source}`);
  if (o.note) lines.push(o.note);
  return lines.join('\n');
}

function ProductRow({ product: p }: { product: Product }) {
  return (
    <View style={styles.row}>
      {p.imageUrl ? <Image source={{ uri: p.imageUrl }} style={styles.thumb} /> : <View style={styles.thumb} />}
      <View style={styles.rowText}>
        <Text style={styles.name} numberOfLines={2}>
          {p.name}
        </Text>
        <Text style={styles.price}>
          {p.priceText ?? (p.price !== null ? `$${p.price.toFixed(2)}` : 'No price shown')}
          {p.unitPriceText ? `   ${p.unitPriceText}` : ''}
        </Text>
        <Text style={styles.meta}>
          Item {p.id}
          {p.inStock === false ? ', out of stock' : ''}
          {p.sponsored ? ', sponsored' : ''}
        </Text>
      </View>
    </View>
  );
}

function Segmented<T extends string>(props: { options: { value: T; label: string }[]; value: T; onChange: (value: T) => void }) {
  return (
    <View style={styles.segmented} accessibilityRole="radiogroup">
      {props.options.map((o) => {
        const selected = o.value === props.value;
        return (
          <Pressable
            key={o.value}
            accessibilityRole="radio"
            accessibilityState={{ checked: selected }}
            onPress={() => props.onChange(o.value)}
            style={[styles.segment, selected && styles.segmentOn]}
          >
            <Text style={[styles.segmentText, selected && styles.segmentTextOn]}>{o.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.paper },
  flex: { flex: 1, gap: 4 },
  list: { paddingHorizontal: 16, paddingBottom: 40 },
  form: { gap: 8, paddingBottom: 16 },
  heading: { fontFamily: fonts.display, fontSize: 22, color: colors.ink, marginTop: 16 },
  label: { fontFamily: fonts.semibold, fontSize: 14, color: colors.ink, marginTop: 8 },
  input: {
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.card,
    borderRadius: radius.md,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontFamily: fonts.body,
    fontSize: 17,
    color: colors.ink,
  },
  chips: { gap: 8, paddingVertical: 4 },
  chip: { borderWidth: 1, borderColor: colors.line, backgroundColor: colors.card, borderRadius: radius.pill, paddingHorizontal: 14, paddingVertical: 8 },
  chipOn: { backgroundColor: colors.ink, borderColor: colors.ink },
  chipText: { fontFamily: fonts.medium, fontSize: 14, color: colors.ink },
  chipTextOn: { color: '#ffffff' },
  segmented: { flexDirection: 'row', borderWidth: 1, borderColor: colors.line, borderRadius: radius.md, overflow: 'hidden', marginTop: 8, backgroundColor: colors.card },
  segment: { flex: 1, paddingVertical: 10, alignItems: 'center' },
  segmentOn: { backgroundColor: colors.ink },
  segmentText: { fontFamily: fonts.medium, fontSize: 14, color: colors.ink },
  segmentTextOn: { color: '#ffffff' },
  warn: { fontFamily: fonts.body, fontSize: 14, color: colors.amber, backgroundColor: colors.amberTint, padding: 10, borderRadius: radius.sm, marginTop: 4 },
  button: { marginTop: 8 },
  linkButton: { alignItems: 'center', paddingVertical: 10 },
  linkText: { fontFamily: fonts.semibold, color: colors.orangeText, fontSize: 15 },
  status: { fontFamily: fonts.body, fontSize: 14, lineHeight: 20, color: colors.ink, marginTop: 4 },
  error: { fontFamily: fonts.body, fontSize: 14, color: colors.red, marginTop: 4 },
  meta: { fontFamily: fonts.body, fontSize: 13, lineHeight: 18, color: colors.muted },
  panel: { backgroundColor: colors.card, borderRadius: radius.lg, padding: 14, gap: 12, borderWidth: 1, borderColor: colors.line },
  panelRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  panelTitle: { fontFamily: fonts.semibold, fontSize: 15, color: colors.ink },
  panelActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  alignStart: { alignSelf: 'flex-start' },
  lane: { gap: 2, paddingTop: 10, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  laneName: { fontFamily: fonts.semibold, fontSize: 15, color: colors.ink },
  tuneName: { fontFamily: fonts.semibold, color: colors.ink },
  row: { flexDirection: 'row', gap: 12, paddingVertical: 10, borderTopWidth: 1, borderTopColor: colors.line },
  thumb: { width: 56, height: 56, borderRadius: 8, backgroundColor: colors.card },
  rowText: { flex: 1, gap: 2 },
  name: { fontFamily: fonts.body, fontSize: 15, color: colors.ink },
  price: { fontFamily: fonts.semibold, fontSize: 15, color: colors.ink },
});
