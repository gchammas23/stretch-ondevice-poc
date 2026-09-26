import { router } from 'expo-router';
import React, { useEffect, useState, useSyncExternalStore } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { listQueries, type GroceryList } from '../lists/types';
import { laneStatus, stageLayout, STAGE } from '../onDevice/WebViewFetcher';
import { stretchPick } from '../pricing/basket';
import { MODE_WORDS, orderable } from '../pricing/onlineCost';
import { scorecard } from '../pricing/scorecard';
import { pricesOf, verdictOf } from '../pricing/truth';
import { hostOf } from '../pricing/receipt';
import { useApp, useComparison, useLists, usePricingRun, useSettings, useSharePlan, useStoreChoices } from '../state/AppProvider';
import { announce, useScreenReader } from '../ui/a11y';
import { IconButton, Pill, tap } from '../ui/controls';
import { deviceWord } from '../ui/device';
import { Icon } from '../ui/Icon';
import { Podium, RaceLanes } from '../ui/Race';
import { colors, fonts, money, radius, shadow } from '../ui/theme';
import { useNow } from '../ui/useNow';

type Stage = 'pick' | 'intro' | 'race' | 'result';

/**
 * Presenter mode: a one-minute live demo, the same steps every time. A list is priced at the user's stores with the
 * store pages big on screen and a caption for each step; it ends on the podium, and one price checked against the
 * product's own page, with its X-ray.
 */
export default function PresentScreen() {
  const insets = useSafeAreaInsets();
  const { engine, pool } = useApp();
  const lists = useLists();
  const choices = useStoreChoices();
  const [listId, setListId] = useState(() => (lists.find((l) => l.items.length) ?? lists[0])?.id);
  const list = lists.find((l) => l.id === listId);
  // Items that can take another item's search ("Whole milk" in the one for "Milk").
  const share = useSharePlan(list);
  const [step, setStep] = useState<Stage>('pick');
  const [count, setCount] = useState(3);
  const run = usePricingRun(list?.id);
  // Once every price is in, the race is over.
  const stage: Stage = step === 'race' && run?.finishedAt ? 'result' : step;

  // Leaving the screen puts the store pages back out of sight.
  useEffect(() => () => pool.setLiveView('off'), [pool]);

  // The intro counts down, then the race starts: every price read fresh, the store pages on stage.
  useEffect(() => {
    if (stage !== 'intro' || !list) return;
    const timer = setTimeout(() => {
      if (count > 1) {
        setCount(count - 1);
        return;
      }
      pool.setLiveView('stage');
      engine.start(list.id, listQueries(list), choices, { refresh: true, share });
      setStep('race');
    }, 1000);
    return () => clearTimeout(timer);
  }, [stage, count, list, choices, engine, pool, share]);

  // Every price in: the pages leave the stage.
  useEffect(() => {
    if (stage === 'result') pool.setLiveView('off');
  }, [stage, pool]);

  const begin = () => {
    tap();
    setCount(3);
    setStep('intro');
  };
  const close = () => {
    pool.setLiveView('off');
    router.back();
  };

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <View style={styles.top}>
        <View style={styles.live}>
          <View style={styles.liveDot} />
          <Text style={styles.liveText}>{stage === 'race' ? 'Live from this phone' : 'Presenter mode'}</Text>
        </View>
        <IconButton name="close" label="Close presenter mode" onPress={close} />
      </View>
      {stage === 'pick' || !list ? (
        <Pick lists={lists} listId={listId} setListId={setListId} stores={choices.map((c) => c.config.name)} onStart={begin} />
      ) : stage === 'intro' ? (
        <Intro count={count} />
      ) : stage === 'race' ? (
        <Race list={list} />
      ) : (
        <Result list={list} onAgain={begin} onClose={close} />
      )}
    </View>
  );
}

function Pick({
  lists,
  listId,
  setListId,
  stores,
  onStart,
}: {
  lists: GroceryList[];
  listId?: string;
  setListId: (id: string) => void;
  stores: string[];
  onStart: () => void;
}) {
  const insets = useSafeAreaInsets();
  const ready = !!lists.find((l) => l.id === listId)?.items.length && stores.length > 0;
  return (
    <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 32 }]}>
      <Text style={styles.hero} accessibilityRole="header">
        A live demo, in a minute
      </Text>
      <Text style={styles.body}>
        A list is priced at your stores, live, on this {deviceWord}, with the store pages on screen as it reads them. It ends on the savings, and one
        price checked against the product’s own page. The same steps every time.
      </Text>
      <Text style={styles.label}>List</Text>
      <View style={styles.chips} accessibilityRole="radiogroup">
        {lists.map((l) => {
          const on = l.id === listId;
          return (
            <Pressable
              key={l.id}
              accessibilityRole="radio"
              accessibilityState={{ checked: on }}
              onPress={() => setListId(l.id)}
              style={[styles.chip, on && styles.chipOn]}
            >
              <Text style={[styles.chipText, on && styles.chipTextOn]}>
                {l.name} · {l.items.length}
              </Text>
            </Pressable>
          );
        })}
      </View>
      <Text style={styles.label}>Stores</Text>
      <Text style={styles.body}>{stores.length ? stores.join(', ') : 'None switched on: choose some in Your stores.'}</Text>
      <Pill label="Start" icon="zap" variant="orange" disabled={!ready} onPress={onStart} style={styles.cta} />
      <Text style={styles.note}>Every price is read fresh, from each store’s own website. Tip: turn on Do Not Disturb, and share the screen.</Text>
    </ScrollView>
  );
}

function Intro({ count }: { count: number }) {
  useEffect(() => {
    if (count === 3) announce('Every price you’re about to see is read live, right now, by this phone.');
  }, [count]);
  return (
    <View style={styles.intro}>
      <Text style={styles.introText}>Every price you’re about to see is read live, right now, by this {deviceWord}.</Text>
      <Text style={styles.introSub}>From each store’s own website. No server in between.</Text>
      <Text style={styles.count} accessibilityElementsHidden>
        {count || ''}
      </Text>
    </View>
  );
}

function Race({ list }: { list: GroceryList }) {
  const insets = useSafeAreaInsets();
  const { pool } = useApp();
  const run = usePricingRun(list.id);
  const { baskets } = useComparison(list, run);
  const choices = useStoreChoices();
  const feed = useSyncExternalStore(pool.feed.subscribe, pool.feed.getSnapshot);
  const { lanes } = useSyncExternalStore(pool.subscribe, pool.getSnapshot);
  const screenReader = useScreenReader();
  const { width, height } = useWindowDimensions();
  const geo = stageLayout(width, height, insets.top);
  const now = useNow(100);
  if (!run) return null;
  const nameOf = (rid: string) => choices.find((c) => c.config.id === rid)?.config.name ?? run.stores[rid]?.name ?? rid;
  const stores = Object.values(run.stores);
  const total = stores.reduce((n, s) => n + s.total, 0);
  const settled = stores.reduce((n, s) => n + s.settled, 0);
  const since = feed.filter((e) => e.at >= run.startedAt);
  const reusing = since.some((e) => e.text.includes('reused its page'));
  const first = since.length ? since[since.length - 1] : undefined;
  const caption = !settled
    ? `Opening ${joinNames(stores.map((s) => s.name))}’s own websites on this ${deviceWord}`
    : reusing
      ? 'Now each store’s page is reused: the next searches skip the reload, and send the store’s own request'
      : `First price after ${seconds(first ? first.at - run.startedAt : now - run.startedAt)}`;
  // The pages on stage, in the order the live view draws them.
  const shown = screenReader ? [] : lanes.filter((l) => l.getSnapshot()).slice(0, 4);

  return (
    <View style={styles.flex}>
      <View style={[styles.stageHead, { height: STAGE.header - 44 }]}>
        <Text style={styles.caption} accessibilityLiveRegion="polite" numberOfLines={3}>
          {caption}
        </Text>
        <View style={styles.counters}>
          <Counter value={`${settled}/${total}`} label="prices" />
          <Counter value={String(stores.length)} label="stores" />
          <Counter value={seconds(now - run.startedAt)} label="on this phone" />
        </View>
      </View>
      {/* The store pages are drawn over this space by the live view (see stageLayout). */}
      <View style={{ height: geo.height }}>
        {shown.map((lane, i) => (
          <Text
            key={lane.key}
            numberOfLines={1}
            style={[styles.tileLabel, { left: geo.tiles[i].x, top: geo.tiles[i].y - geo.top + geo.tileH + 3, width: geo.tileW }]}
          >
            {lane.label} · {laneStatus(lane)}
          </Text>
        ))}
      </View>
      <ScrollView contentContainerStyle={[styles.raceBox, { paddingBottom: insets.bottom + 24 }]}>
        <RaceLanes run={run} baskets={baskets} nameOf={nameOf} />
        {since.slice(0, 2).map((e) => (
          <Text key={e.id} style={[styles.feed, !e.ok && { color: colors.red }]} numberOfLines={1}>
            <Text style={styles.feedStore}>{e.retailer}</Text> · {e.what} · {e.text}
          </Text>
        ))}
      </ScrollView>
    </View>
  );
}

function Counter({ value, label }: { value: string; label: string }) {
  return (
    <View style={styles.counter}>
      <Text style={styles.counterValue}>{value}</Text>
      <Text style={styles.counterLabel}>{label}</Text>
    </View>
  );
}

interface Proof {
  state: 'checking' | 'same' | 'different' | 'failed';
  pagePrice?: number;
}

function Result({ list, onAgain, onClose }: { list: GroceryList; onAgain: () => void; onClose: () => void }) {
  const insets = useSafeAreaInsets();
  const { search, bundle } = useApp();
  const settings = useSettings();
  const run = usePricingRun(list.id);
  const { baskets, extra, online, mode, countCoupons } = useComparison(list, run);
  const choices = useStoreChoices();
  const nameOf = (rid: string) => choices.find((c) => c.config.id === rid)?.config.name ?? run?.stores[rid]?.name ?? rid;
  // The same pick as Find a store's: by how the user shops, driving and online fees included when they count.
  const contenders = orderable(baskets, online);
  const winner = stretchPick(contenders.filter((b) => b.complete), settings.rankBy, extra);
  // One of the winner's prices, checked against the product's own page on the store's site.
  const line = winner?.lines.find((l) => l.status === 'found' && l.product?.url && l.product.price !== null);
  const product = line?.product ?? undefined;
  const cfg = winner ? bundle.retailers.find((r) => r.id === winner.retailerId) : undefined;
  const [proof, setProof] = useState<Proof>({ state: 'checking' });

  useEffect(() => {
    if (!cfg || !product) return;
    let alive = true;
    search.readProduct(cfg, product).then(
      (details) => {
        if (!alive) return;
        const pagePrice = details.price;
        const verdict = verdictOf(pricesOf(product), pagePrice);
        setProof(verdict === 'unreadable' ? { state: 'failed' } : { state: verdict, pagePrice });
      },
      () => alive && setProof({ state: 'failed' }),
    );
    return () => {
      alive = false;
    };
  }, [cfg, product, search]);

  if (!run?.finishedAt) return null;
  // Products read, as Find a store's banner counts them.
  const read = scorecard(run).products;
  const host = product?.url ? hostOf(product.url).replace(/^www\./, '') : '';

  return (
    <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 32 }]}>
      <Text style={styles.hero} accessibilityRole="header">
        {read} prices in {seconds(run.finishedAt - run.startedAt)}
      </Text>
      <Text style={styles.body}>
        From {Object.keys(run.stores).length} stores’ own websites, read on this {deviceWord}, with no server in between.
      </Text>
      <Podium
        baskets={contenders}
        by={settings.rankBy}
        extra={extra}
        how={[mode === 'store' ? '' : `${MODE_WORDS[mode]}, fees included`, countCoupons ? 'clipped coupons counted' : ''].filter(Boolean).join(', ') || undefined}
        nameOf={nameOf}
        timeMs={run.finishedAt - run.startedAt}
        items={list.items.length}
        onShare={() => router.push(`/list/${list.id}/share`)}
      />
      {winner && product && cfg ? (
        <View style={styles.proof}>
          <Text style={styles.proofTitle}>Is that price real?</Text>
          <Text style={styles.body}>
            {line!.item.name} at {cfg.name}: {money(product.price!)}, {product.name}.
          </Text>
          {proof.state === 'checking' ? (
            <View style={styles.row}>
              <ActivityIndicator size="small" color={colors.orange} />
              <Text style={styles.note}>Opening the product’s own page on {host}, on this {deviceWord}…</Text>
            </View>
          ) : proof.state === 'same' ? (
            <View style={styles.row}>
              <Icon name="check" size={18} color={colors.green} strokeWidth={2.6} />
              <Text style={[styles.note, styles.flex, { color: colors.green }]}>{host}’s own product page shows the same price, just now.</Text>
            </View>
          ) : proof.state === 'different' ? (
            <Text style={[styles.note, { color: colors.amber }]}>
              The product page shows {money(proof.pagePrice!)}: search results and product pages can differ, or be for another store.
            </Text>
          ) : (
            <Text style={styles.note}>The product’s page couldn’t be read just now: the X-ray still shows the data the price came in.</Text>
          )}
          <Pill
            label="X-ray: the data behind it"
            icon="eye"
            small
            variant="outline"
            onPress={() => router.push({ pathname: '/xray', params: { retailerId: winner.retailerId, productId: product.id } })}
            style={styles.alignStart}
          />
        </View>
      ) : null}
      <View style={styles.actions}>
        <Pill label="Run it again" icon="refresh" variant="dark" onPress={onAgain} />
        <Pill label="See Find a store" variant="outline" onPress={() => router.push(`/list/${list.id}/compare`)} />
        <Pill label="Done" variant="outline" onPress={onClose} />
      </View>
    </ScrollView>
  );
}

const seconds = (ms: number) => `${(Math.max(0, ms) / 1000).toFixed(1)} s`;

/** "Walmart, Target and ALDI". */
function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? 'your stores';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.cream },
  flex: { flex: 1 },
  top: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, height: 44 },
  live: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  liveDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.orange },
  liveText: { fontFamily: fonts.semibold, fontSize: 15, color: colors.ink },
  content: { paddingHorizontal: 20, paddingTop: 8, gap: 14 },
  hero: { fontFamily: fonts.display, fontSize: 32, lineHeight: 38, color: colors.ink },
  body: { fontFamily: fonts.body, fontSize: 16, lineHeight: 23, color: colors.muted },
  label: { fontFamily: fonts.semibold, fontSize: 13, letterSpacing: 0.6, textTransform: 'uppercase', color: colors.muted, marginTop: 6 },
  note: { fontFamily: fonts.body, fontSize: 14, lineHeight: 20, color: colors.muted },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { minHeight: 40, justifyContent: 'center', paddingHorizontal: 14, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.card },
  chipOn: { backgroundColor: colors.pill, borderColor: colors.pill },
  chipText: { fontFamily: fonts.medium, fontSize: 15, color: colors.ink },
  chipTextOn: { color: '#ffffff' },
  cta: { marginTop: 10 },
  intro: { flex: 1, justifyContent: 'center', paddingHorizontal: 28, gap: 16 },
  introText: { fontFamily: fonts.display, fontSize: 36, lineHeight: 44, color: colors.ink },
  introSub: { fontFamily: fonts.script, fontSize: 28, color: colors.orangeText },
  count: { fontFamily: fonts.display, fontSize: 72, color: colors.orange, textAlign: 'center', marginTop: 20 },
  stageHead: { paddingHorizontal: 16, justifyContent: 'space-between', paddingBottom: 6 },
  caption: { fontFamily: fonts.semibold, fontSize: 19, lineHeight: 25, color: colors.ink },
  counters: { flexDirection: 'row', gap: 10 },
  counter: { flex: 1, backgroundColor: colors.card, borderRadius: radius.md, paddingVertical: 6, paddingHorizontal: 10, ...shadow.card },
  counterValue: { fontFamily: fonts.display, fontSize: 20, color: colors.ink, fontVariant: ['tabular-nums'] },
  counterLabel: { fontFamily: fonts.body, fontSize: 12, color: colors.muted },
  tileLabel: { position: 'absolute', fontFamily: fonts.medium, fontSize: 12, color: colors.ink },
  raceBox: { paddingHorizontal: 16, paddingTop: 12, gap: 10 },
  feed: { fontFamily: fonts.body, fontSize: 12, lineHeight: 16, color: colors.muted },
  feedStore: { fontFamily: fonts.semibold, color: colors.ink },
  proof: { backgroundColor: colors.card, borderRadius: radius.lg, padding: 16, gap: 8, ...shadow.card },
  proofTitle: { fontFamily: fonts.semibold, fontSize: 17, color: colors.ink },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  alignStart: { alignSelf: 'flex-start' },
  actions: { gap: 10, marginTop: 4 },
});
