import { router, useLocalSearchParams } from 'expo-router';
import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Share, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  bestCaseText,
  blockedLine,
  DATACENTER_DATE,
  datacenterFor,
  datacenterLine,
  datacenterWords,
  sideMeta,
  summaryLine,
  verdictWords,
  versusIds,
  versusSummary,
  versusText,
  type Doing,
  type ServerOutcome,
  type SideResult,
  type Verdict,
  type VersusRow,
  type VersusScope,
  type VersusState,
  type VersusStoreInfo,
  type VersusSummary,
} from '../onDevice/phoneVsServer';
import { MAX_SEARCHES_PER_HOUR } from '../onDevice/politeness';
import { bytesText } from '../onDevice/scrapeFeed';
import { whenLabel } from '../pricing/receipt';
import { useApp, useSettings } from '../state/AppProvider';
import { storeChoices } from '../state/storeChoices';
import { announce } from '../ui/a11y';
import { Pill, tap } from '../ui/controls';
import { deviceWord } from '../ui/device';
import { Icon, type IconName } from '../ui/Icon';
import { RetailerBadge } from '../ui/RetailerBadge';
import { ScreenHeader } from '../ui/ScreenHeader';
import { colors, fonts, money, radius, shadow } from '../ui/theme';
import { useNow } from '../ui/useNow';

/** "Sep 24": the day the datacenter's requests were sent, for a column's caption. */
const DATACENTER_SHORT = DATACENTER_DATE.replace(/,\s*\d{4}$/, '');
/** "11:42 PM", to the next minute. */
const clock = (at: number) => new Date(Math.ceil(at / 60_000) * 60_000).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

const LOOK: Record<Verdict, { color: string; icon: IconName }> = {
  prices: { color: colors.green, icon: 'check' },
  blocked: { color: colors.red, icon: 'close' },
  empty: { color: colors.red, icon: 'close' },
  no_prices: { color: colors.amber, icon: 'alert' },
  slow: { color: colors.amber, icon: 'clock' },
  failed: { color: colors.amber, icon: 'alert' },
  paused: { color: colors.muted, icon: 'clock' },
};
const SERVER_COLOR: Record<ServerOutcome, string> = { blocked: colors.red, no_prices: colors.amber, loaded: colors.muted };

/** Stores in the test that have their result, or were left out. */
const settledCount = (state: VersusState) =>
  state.stores.filter((s) => {
    const r = state.rows[s.retailerId];
    return !!r && (r.pausedUntil !== undefined || (!!r.browser && !!r.plain));
  }).length;

/**
 * Phone vs. server: the POC's argument, tested live. Each store is searched for one common item two ways from this
 * phone (its page in the phone's own browser, and a plain request, the way a scraping server asks), beside what one
 * request from a datacenter got (the README's table). The plain request still leaves from the phone's own internet
 * address, so it's a server's best case, and the screen says so.
 */
export default function PhoneVsServerScreen() {
  const insets = useSafeAreaInsets();
  const { versus, runVersus, bundle } = useApp();
  const settings = useSettings();
  const state = useSyncExternalStore(versus.subscribe, versus.getSnapshot);
  const now = useNow(30_000);
  const { fontScale } = useWindowDimensions();
  // From presenter mode's ending: start at once, at the compared stores.
  const { start } = useLocalSearchParams<{ start?: string }>();
  const [scope, setScope] = useState<VersusScope>(() => (start !== '1' && state.finishedAt ? state.scope : 'compared'));
  // How many stores each choice tests: the ones with a store near the ZIP code, as when pricing.
  const sizes = useMemo(() => {
    const count = (s: VersusScope) => storeChoices({ ...settings, retailerIds: versusIds(bundle.retailers, settings.retailerIds, s) }, bundle.retailers).length;
    return { compared: count('compared'), all: count('all') };
  }, [settings, bundle.retailers]);
  const summary = versusSummary(state);
  const settled = settledCount(state);

  const run = (next: VersusScope) => {
    tap();
    setScope(next);
    void runVersus(next);
  };

  const autoStarted = useRef(false);
  useEffect(() => {
    if (start !== '1' || autoStarted.current) return;
    autoStarted.current = true;
    if (!versus.getSnapshot().running) void runVersus('compared');
  }, [start, versus, runVersus]);

  // Screen readers hear the result when the test is done.
  const wasRunning = useRef(state.running);
  useEffect(() => {
    if (wasRunning.current && !state.running && summary.tried) announce(summaryLine(summary, deviceWord));
    wasRunning.current = state.running;
  });

  const share = () => {
    const heading = `Phone vs. server, on this ${deviceWord}, ${new Date(state.finishedAt ?? now).toLocaleString('en-US')}`;
    void Share.share({ message: versusText(state, heading, deviceWord) }).catch(() => {});
  };
  const stores = (n: number) => `${n} ${n === 1 ? 'store' : 'stores'}`;

  return (
    <View style={styles.screen}>
      <ScreenHeader title="Phone vs. server" subtitle={`Could a server read these stores? A live test on this ${deviceWord}.`} />
      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 32 }]}>
        <Hero state={state} summary={summary} settled={settled} now={now} />

        <View style={styles.card}>
          <Text style={styles.title} accessibilityRole="header">
            Which stores
          </Text>
          <View style={styles.chips} accessibilityRole="radiogroup">
            {(['compared', 'all'] as const).map((s) => {
              const on = scope === s;
              const label = s === 'compared' ? `Your ${stores(sizes.compared)}` : `All ${stores(sizes.all)}`;
              return (
                <Pressable
                  key={s}
                  accessibilityRole="radio"
                  accessibilityLabel={label}
                  accessibilityState={{ checked: on, disabled: state.running }}
                  disabled={state.running}
                  onPress={() => {
                    tap();
                    setScope(s);
                  }}
                  style={[styles.chip, on && styles.chipOn]}
                >
                  <Text style={[styles.chipText, on && styles.chipTextOn]}>{label}</Text>
                </Pressable>
              );
            })}
          </View>
          <View style={styles.rowWrap}>
            <Pill
              label={state.running ? `Testing… ${settled} of ${state.stores.length}` : state.finishedAt ? 'Run it again' : 'Run the test'}
              icon="zap"
              variant="orange"
              busy={state.running}
              disabled={!sizes[scope]}
              onPress={() => run(scope)}
            />
            {state.finishedAt && !state.running ? <Pill label="Share" accessibilityLabel="Share the result" icon="share" variant="outline" onPress={share} /> : null}
          </View>
          <Text style={styles.small}>
            {sizes[scope]
              ? `Two searches at each store, one at a time, four stores at once. Both count toward each store’s ${MAX_SEARCHES_PER_HOUR} searches an hour, and a store without room for both is left out.`
              : 'No stores to test: choose some to compare in Your stores.'}
            {sizes[scope] && scope === 'all' ? ' Regional chains are in only if you compare them: they run on Kroger’s and Albertsons’ sites, which are tested.' : ''}
          </Text>
        </View>

        {state.stores.length ? (
          <View style={styles.card}>
            <Text style={styles.title} accessibilityRole="header">
              Store by store
            </Text>
            <Text style={styles.small}>
              Searching “{state.query}”. The first two ways ran on this {deviceWord}; the datacenter’s request was recorded on {DATACENTER_DATE}.
            </Text>
            {state.stores.map((store) => (
              <StoreRow
                key={store.retailerId}
                store={store}
                row={state.rows[store.retailerId]}
                doing={state.doing[store.retailerId]}
                running={state.running}
                stacked={fontScale > 1.3}
              />
            ))}
          </View>
        ) : null}

        <HowItWorks />
        <Pill label="What would servers cost for this?" icon="phone" variant="outline" onPress={() => router.push('/cost')} />
      </ScrollView>
    </View>
  );
}

/** The result in two numbers, what blocked what, the datacenter's record, and why the plain request is a server's best case. */
function Hero({ state, summary: s, settled, now }: { state: VersusState; summary: VersusSummary; settled: number; now: number }) {
  if (!state.running && !state.finishedAt) {
    return (
      <View style={styles.card}>
        <Text style={styles.lead}>Can a server read what this {deviceWord} reads?</Text>
        <Text style={styles.body}>
          The test searches each store from this {deviceWord} two ways: in its own browser, the way the app reads prices, and with a plain request, the way a
          scraping server asks. Beside them, what one request from a datacenter got on {DATACENTER_DATE}.
        </Text>
      </View>
    );
  }
  // The side that got more stores' prices shows green, the other red: neither is assumed.
  const tone = (mine: number, theirs: number) => (mine > theirs ? colors.green : mine < theirs ? colors.red : colors.ink);
  const blocked = blockedLine(s);
  const datacenter = datacenterLine(s);
  const scope = state.scope === 'compared' ? `your ${state.stores.length === 1 ? 'store' : `${state.stores.length} stores`}` : `all ${state.stores.length} stores`;
  return (
    <View style={styles.card}>
      <View style={styles.hero} accessible accessibilityLabel={s.tried ? summaryLine(s, deviceWord) : 'Testing the first stores.'}>
        <View style={styles.side}>
          <Text style={styles.sideLabel}>Plain request, a server’s way</Text>
          <Text style={[styles.big, { color: tone(s.plain.prices, s.browser.prices) }]}>{s.tried ? `${s.plain.prices} of ${s.tried}` : '–'}</Text>
          <Text style={styles.small}>stores gave prices</Text>
        </View>
        <View style={styles.divider} />
        <View style={styles.side}>
          <Text style={styles.sideLabel}>This {deviceWord}’s browser</Text>
          <Text style={[styles.big, { color: tone(s.browser.prices, s.plain.prices) }]}>{s.tried ? `${s.browser.prices} of ${s.tried}` : '–'}</Text>
          <Text style={styles.small}>stores gave prices</Text>
        </View>
      </View>
      {state.running ? (
        <View style={styles.row}>
          <ActivityIndicator size="small" color={colors.orange} />
          <Text style={styles.small}>
            Testing: {settled} of {state.stores.length} stores done
          </Text>
        </View>
      ) : null}
      {blocked ? <Text style={styles.body}>{blocked}</Text> : null}
      {datacenter ? <Text style={styles.body}>{datacenter}</Text> : null}
      {s.paused ? (
        <Text style={styles.small}>
          {s.paused === 1 ? '1 store wasn’t' : `${s.paused} stores weren’t`} tried: no room in {s.paused === 1 ? 'its' : 'their'} hour for both searches (at
          most {MAX_SEARCHES_PER_HOUR} an hour from this {deviceWord}).
        </Text>
      ) : null}
      <View style={styles.caveat}>
        <Icon name="info" size={16} color={colors.muted} />
        <Text style={[styles.small, styles.flex]}>{bestCaseText(deviceWord)}</Text>
      </View>
      {state.finishedAt && !state.running ? (
        <Text style={styles.small}>
          Tested {whenLabel(state.finishedAt, now)}: {scope}, searching “{state.query}”.
        </Text>
      ) : null}
    </View>
  );
}

/** One store: its page in this phone's browser, the plain request, and the datacenter's record, side by side. */
function StoreRow({ store, row, doing, running, stacked }: { store: VersusStoreInfo; row?: VersusRow; doing?: Doing; running: boolean; stacked: boolean }) {
  const waiting = doing === 'waiting' ? 'Waiting for a list’s searches there' : running ? 'Waiting' : 'Not tried';
  const proof = row?.browser?.first ?? row?.plain?.first;
  const spoken = [
    store.name,
    row?.pausedUntil !== undefined
      ? `Not tried: no room in its hour for both searches. Room again about ${clock(row.pausedUntil)}`
      : [
          `This ${deviceWord}’s browser: ${spokenSide(row?.browser, doing === 'browser', waiting)}`,
          `Plain request: ${spokenSide(row?.plain, doing === 'plain', doing === 'browser' ? 'next' : waiting)}`,
          `Datacenter, ${DATACENTER_DATE}: ${datacenterWords(store)}`,
        ].join('. '),
  ].join('. ');
  const cells = [
    {
      caption: `This ${deviceWord}’s browser`,
      value: <SideValue side={row?.browser} busy={doing === 'browser' ? 'Loading its page…' : undefined} waiting={waiting} how />,
    },
    {
      caption: 'Plain request',
      value: <SideValue side={row?.plain} busy={doing === 'plain' ? 'Asking for the page…' : undefined} waiting={doing === 'browser' ? 'Next' : waiting} />,
    },
    { caption: `Datacenter, ${DATACENTER_SHORT}`, value: <ServerValue store={store} /> },
  ];
  return (
    <View style={styles.storeRow} accessible accessibilityLabel={`${spoken}.`}>
      <View style={styles.row}>
        <RetailerBadge retailerId={store.retailerId} name={store.name} size={28} />
        <Text style={[styles.storeName, styles.flex]}>{store.name}</Text>
      </View>
      {row?.pausedUntil !== undefined ? (
        <Text style={styles.small}>
          Not tried: no room in {store.name}’s hour for both searches (at most {MAX_SEARCHES_PER_HOUR} an hour from this {deviceWord}). Room again about{' '}
          {clock(row.pausedUntil)}.
        </Text>
      ) : stacked ? (
        // Large text: one below the other, each with its caption.
        cells.map((c) => (
          <View key={c.caption} style={styles.cellStacked}>
            <Text style={styles.caption}>{c.caption}</Text>
            {c.value}
          </View>
        ))
      ) : (
        // The captions in a row of their own, so the three answers start level whatever the captions' lengths.
        <View style={styles.grid}>
          <View style={styles.cells}>
            {cells.map((c) => (
              <Text key={c.caption} style={[styles.caption, styles.cell]}>
                {c.caption}
              </Text>
            ))}
          </View>
          <View style={styles.cells}>
            {cells.map((c) => (
              <View key={c.caption} style={styles.cell}>
                {c.value}
              </View>
            ))}
          </View>
        </View>
      )}
      {row?.pausedUntil === undefined && proof ? (
        <Text style={styles.meta} numberOfLines={stacked ? undefined : 2}>
          Read: {proof.name}, {money(proof.price)}
        </Text>
      ) : null}
    </View>
  );
}

/** What one way got, in words for a screen reader. */
function spokenSide(side: SideResult | undefined, now: boolean, waiting: string): string {
  if (!side) return now ? 'testing now' : waiting.toLowerCase();
  const parts = [verdictWords(side)];
  if (side.first) parts.push(`${side.first.name} at ${money(side.first.price)}`);
  if (side.verdict !== 'paused') parts.push(`${(side.ms / 1000).toFixed(1)} seconds`);
  if (side.bytes) parts.push(bytesText(side.bytes));
  if (side.how && side.how !== 'direct request') parts.push(side.how);
  return parts.join(', ');
}

/** What one way got: its verdict, with its time, data and (for the browser) how it read the store; or where it's at. */
function SideValue({ side, busy, waiting, how }: { side?: SideResult; busy?: string; waiting: string; how?: boolean }) {
  if (!side) {
    return busy ? (
      <View style={styles.verdict}>
        <ActivityIndicator size="small" color={colors.orange} />
        <Text style={styles.meta}>{busy}</Text>
      </View>
    ) : (
      <Text style={styles.meta}>{waiting}</Text>
    );
  }
  const look = LOOK[side.verdict];
  const meta = sideMeta(side, how);
  return (
    <>
      <View style={styles.verdict}>
        <View style={styles.verdictIcon}>
          <Icon name={look.icon} size={14} color={look.color} strokeWidth={2.6} />
        </View>
        <Text style={[styles.verdictText, { color: look.color }]}>{verdictWords(side)}</Text>
      </View>
      {meta ? <Text style={styles.meta}>{meta}</Text> : null}
    </>
  );
}

/** The datacenter's request at the store, as recorded; for a regional chain, its parent's site's. */
function ServerValue({ store }: { store: VersusStoreInfo }) {
  const record = datacenterFor(store.retailerId, store.sisterOf);
  if (record && !record.parent) return <Text style={[styles.verdictText, { color: SERVER_COLOR[record.outcome] }]}>{record.said}</Text>;
  return (
    <>
      <Text style={[styles.verdictText, { color: colors.muted }]}>Not tried</Text>
      {record ? (
        <Text style={styles.meta}>
          {store.parentName ?? record.parent}’s site: {record.said}
        </Text>
      ) : null}
    </>
  );
}

function HowItWorks() {
  return (
    <View style={styles.card}>
      <Text style={styles.title} accessibilityRole="header">
        How the test works
      </Text>
      <Bullet
        text={`This ${deviceWord}’s browser: the store’s search page, loaded hidden and read the way the app reads prices, from the data the page itself asks the store for.`}
      />
      <Bullet
        text={`A plain request: one GET for the same page, the way a scraping server asks. It gives the same user agent as this ${deviceWord}’s browser, but runs none of the page’s scripts and sends no cookies. Whatever product data the page carries is read.`}
      />
      <Bullet
        text={`The datacenter: what one request from a datacenter got at each store on ${DATACENTER_DATE}, as the POC’s README records it. Regional chains weren’t tried there: their parent’s site is shown instead.`}
      />
      <Text style={styles.small}>
        The plain request is a server’s best case: it leaves from this {deviceWord}’s own internet address, which stores trust more than a datacenter’s.
        Over a VPN, both ways leave from the VPN’s address, often a datacenter’s itself: then the only difference between them is the browser. Many stores
        send their page without the prices and fetch them afterwards, with requests only a browser makes. A server could make those too, from a
        datacenter, or through home internet addresses it rents.
      </Text>
      <Text style={styles.small}>
        Bot checks are noted, not shown, and the app then goes gently on that store’s site for 15 minutes. The test searches only stores you compare or
        that are in the store rules, and only when you run it.
      </Text>
    </View>
  );
}

function Bullet({ text }: { text: string }) {
  return (
    <View style={styles.bullet}>
      <Text style={styles.body} accessibilityElementsHidden importantForAccessibility="no">
        •
      </Text>
      <Text style={[styles.body, styles.flex]}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.paper },
  content: { paddingHorizontal: 16, gap: 12 },
  flex: { flex: 1 },
  card: { backgroundColor: colors.card, borderRadius: radius.lg, padding: 16, gap: 10, ...shadow.card },
  hero: { flexDirection: 'row', gap: 14 },
  side: { flex: 1, gap: 2 },
  sideLabel: { fontFamily: fonts.semibold, fontSize: 13, letterSpacing: 0.6, textTransform: 'uppercase', color: colors.muted },
  big: { fontFamily: fonts.display, fontSize: 34, lineHeight: 40, color: colors.ink, fontVariant: ['tabular-nums'] },
  divider: { width: StyleSheet.hairlineWidth, backgroundColor: colors.line },
  lead: { fontFamily: fonts.display, fontSize: 22, lineHeight: 28, color: colors.ink },
  title: { fontFamily: fonts.semibold, fontSize: 17, color: colors.ink },
  body: { fontFamily: fonts.body, fontSize: 15, lineHeight: 21, color: colors.ink },
  small: { flexShrink: 1, fontFamily: fonts.body, fontSize: 13, lineHeight: 18, color: colors.muted },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  rowWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  caveat: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, backgroundColor: colors.chip, borderRadius: radius.md, padding: 10 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 14, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.line },
  chipOn: { backgroundColor: colors.pill, borderColor: colors.pill },
  chipText: { fontFamily: fonts.medium, fontSize: 14, color: colors.ink },
  chipTextOn: { color: '#ffffff' },
  storeRow: { gap: 8, paddingTop: 10, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
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
  bullet: { flexDirection: 'row', gap: 8 },
});
