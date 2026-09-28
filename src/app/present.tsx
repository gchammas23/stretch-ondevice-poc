import { router } from 'expo-router';
import React, { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { listQueries, type GroceryList } from '../lists/types';
import { seconds } from '../onDevice/scrapeFeed';
import { laneStatus, stageLayout, STAGE } from '../onDevice/WebViewFetcher';
import type { WebViewQueue } from '../onDevice/webviewQueue';
import { stretchPick } from '../pricing/basket';
import { MODE_WORDS, orderable } from '../pricing/onlineCost';
import { runMs, type PricingRun } from '../pricing/pricingEngine';
import { scorecard } from '../pricing/scorecard';
import { pricesOf, verdictOf } from '../pricing/truth';
import { hostOf } from '../pricing/receipt';
import { useApp, useComparison, useLists, usePricingRun, useSettings, useSharePlan, useStoreChoices, useStoreName } from '../state/AppProvider';
import { announce, focusOn, hiddenFromScreenReaders, useScreenReader } from '../ui/a11y';
import { IconButton, Pill, tap } from '../ui/controls';
import { deviceWord } from '../ui/device';
import { Icon } from '../ui/Icon';
import { Podium, RaceLanes } from '../ui/Race';
import { colors, fonts, money, radius, shadow } from '../ui/theme';
import { useNow } from '../ui/useNow';

type Stage = 'pick' | 'intro' | 'race' | 'result';

/** How long the race took: the result keeps it, whatever the run does afterwards (a store tried again, say). */
type Finish = { ms: number };

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
  const [finish, setFinish] = useState<Finish | null>(null);
  const run = usePricingRun(list?.id);
  // Once every price is in, the race is over, and stays over: a store cooling down may be tried again at its retry
  // time, long after the podium showed.
  const stage: Stage = step === 'race' && (finish || run?.finishedAt) ? 'result' : step;
  useEffect(() => {
    if (step !== 'race' || !listId) return;
    return engine.subscribe(() => {
      const r = engine.getRun(listId);
      if (r?.finishedAt) setFinish((had) => had ?? { ms: runMs(r)! });
    });
  }, [step, listId, engine]);

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
    setFinish(null);
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
          <Text style={styles.liveText} maxFontSizeMultiplier={1.3}>
            {stage === 'race' ? 'Live from this phone' : 'Presenter mode'}
          </Text>
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
        <Result list={list} finish={finish ?? (run?.finishedAt ? { ms: runMs(run)! } : null)} onAgain={begin} onClose={close} />
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
      <View style={styles.chips} accessibilityRole="radiogroup" accessibilityLabel="List">
        {lists.map((l) => {
          const on = l.id === listId;
          return (
            <Pressable
              key={l.id}
              accessibilityRole="radio"
              accessibilityLabel={`${l.name}, ${l.items.length} ${l.items.length === 1 ? 'item' : 'items'}`}
              accessibilityState={{ checked: on }}
              hitSlop={{ top: 2, bottom: 2 }}
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
      <Pill
        label="Start"
        accessibilityLabel="Start the live demo"
        accessibilityHint={ready ? undefined : stores.length ? 'Choose a list with items first' : 'Switch on some stores in Your stores first'}
        icon="zap"
        variant="orange"
        disabled={!ready}
        onPress={onStart}
        style={styles.cta}
      />
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
      <Text style={styles.introText} maxFontSizeMultiplier={1.3}>
        Every price you’re about to see is read live, right now, by this {deviceWord}.
      </Text>
      <Text style={styles.introSub} maxFontSizeMultiplier={1.3}>
        From each store’s own website. No server in between.
      </Text>
      <Text style={styles.count} maxFontSizeMultiplier={1.3} {...hiddenFromScreenReaders}>
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
  const feed = useSyncExternalStore(pool.feed.subscribe, pool.feed.getSnapshot);
  const { lanes } = useSyncExternalStore(pool.subscribe, pool.getSnapshot);
  const screenReader = useScreenReader();
  const { width, height } = useWindowDimensions();
  const geo = stageLayout(width, height, insets.top);
  const nameOf = useStoreName(run);
  // What the phone did since the race started: the caption's steps, and the last lines under the lanes.
  const since = run ? feed.filter((e) => e.at >= run.startedAt) : [];
  const caption = run ? captionOf(run, since) : '';
  // VoiceOver doesn't read a caption changing by itself: each step is said once, as it comes.
  useEffect(() => announce(caption), [caption]);
  if (!run) return null;
  const stores = Object.values(run.stores);
  const total = stores.reduce((n, s) => n + s.total, 0);
  const settled = stores.reduce((n, s) => n + s.settled, 0);
  // The pages on stage, in the order the live view draws them.
  const shown = screenReader ? [] : lanes.filter((l) => l.getSnapshot()).slice(0, 4);

  return (
    <View style={styles.flex}>
      <View style={[styles.stageHead, { height: STAGE.header - 44 }]}>
        <Text style={styles.caption} numberOfLines={3} maxFontSizeMultiplier={1.3}>
          {caption}
        </Text>
        <View style={styles.counters}>
          <Counter value={`${settled}/${total}`} label="prices" spoken={`${settled} of ${total} prices`} />
          <Counter value={String(stores.length)} label="stores" spoken={`${stores.length} ${stores.length === 1 ? 'store' : 'stores'}`} />
          <TimeCounter from={run.startedAt} />
        </View>
      </View>
      {/* The store pages are drawn over this space by the live view (see stageLayout). */}
      <View style={{ height: geo.height }}>
        {shown.map((lane, i) => (
          <TileLabel key={lane.key} lane={lane} style={{ left: geo.tiles[i].x, top: geo.tiles[i].y - geo.top + geo.tileH + 3, width: geo.tileW }} />
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

/** What the stage says, step by step: opening the stores' sites, the first price, then pages reused. */
function captionOf(run: PricingRun, since: { at: number; text: string }[]): string {
  // The first price read in this run: the feed's oldest line since it started, else the first result that landed.
  const reads = Object.values(run.results)
    .flatMap((r) => Object.values(r))
    .filter((r) => r.status === 'done' && !r.cached && r.at !== undefined && r.at >= run.startedAt)
    .map((r) => r.at!);
  const firstAt = since.length ? since[since.length - 1].at : reads.length ? Math.min(...reads) : undefined;
  if (firstAt === undefined) return `Opening ${joinNames(Object.values(run.stores).map((s) => s.name))}’s own websites on this ${deviceWord}`;
  if (since.some((e) => e.text.includes('reused its page'))) {
    return 'Now each store’s page is reused: the next searches skip the reload, and send the store’s own request';
  }
  return `First price after ${seconds(firstAt - run.startedAt)}`;
}

function Counter({ value, label, spoken }: { value: ReactNode; label: string; spoken: string }) {
  return (
    <View style={styles.counter} accessible accessibilityLabel={spoken}>
      <Text style={styles.counterValue} maxFontSizeMultiplier={1.3}>
        {value}
      </Text>
      <Text style={styles.counterLabel} maxFontSizeMultiplier={1.3}>
        {label}
      </Text>
    </View>
  );
}

/** The race's time so far, ticking every tenth of a second: only this counter draws again, not the stage. */
function TimeCounter({ from }: { from: number }) {
  const now = useNow(100);
  const s = seconds(now - from);
  return <Counter value={s} label="on this phone" spoken={`${s.replace(/ s$/, ' seconds')} on this phone`} />;
}

/** A page's name and what it's doing, under its tile. Replays come and go without the page changing, so it looks again. */
function TileLabel({ lane, style }: { lane: WebViewQueue; style: object }) {
  useNow(500);
  return (
    <Text numberOfLines={1} style={[styles.tileLabel, style]} maxFontSizeMultiplier={1.3}>
      {lane.label} · {laneStatus(lane)}
    </Text>
  );
}

interface Proof {
  state: 'checking' | 'same' | 'different' | 'failed';
  pagePrice?: number;
}

function Result({ list, finish, onAgain, onClose }: { list: GroceryList; finish: Finish | null; onAgain: () => void; onClose: () => void }) {
  const insets = useSafeAreaInsets();
  const { search, bundle } = useApp();
  const settings = useSettings();
  const run = usePricingRun(list.id);
  const { baskets, extra, online, mode, countCoupons } = useComparison(list, run);
  const nameOf = useStoreName(run);
  // The same pick as Find a store's: by how the user shops, driving and online fees included when they count.
  const contenders = orderable(baskets, online);
  const winner = stretchPick(contenders.filter((b) => b.complete), settings.rankBy, extra);
  // One of the winner's prices, checked against the product's own page on the store's site.
  const line = winner?.lines.find((l) => l.status === 'found' && l.product?.url && l.product.price !== null);
  const product = line?.product ?? undefined;
  const cfg = winner ? bundle.retailers.find((r) => r.id === winner.retailerId) : undefined;
  const host = product?.url ? hostOf(product.url).replace(/^www\./, '') : '';
  // The check is for one product: another winner's product is checked afresh, not shown with this one's answer.
  const checking = cfg && product ? `${cfg.id}|${product.id}` : '';
  const [proof, setProof] = useState<Proof & { of: string }>({ of: '', state: 'checking' });
  const shownProof: Proof = proof.of === checking ? proof : { state: 'checking' };
  // The screen changes wholesale: the screen reader starts at the result.
  const heading = useRef<Text>(null);
  useEffect(() => focusOn(heading), []);

  useEffect(() => {
    if (!cfg || !product) return;
    let alive = true;
    search.readProduct(cfg, product).then(
      (details) => {
        if (!alive) return;
        const pagePrice = details.price;
        const verdict = verdictOf(pricesOf(product), pagePrice);
        setProof(verdict === 'unreadable' ? { of: checking, state: 'failed' } : { of: checking, state: verdict, pagePrice });
        if (verdict === 'same') announce(`${host}’s own product page shows the same price.`);
        else if (verdict === 'different' && pagePrice !== undefined) announce(`The product page shows ${money(pagePrice)}.`);
        else announce('The product’s page couldn’t be read just now.');
      },
      () => {
        if (!alive) return;
        setProof({ of: checking, state: 'failed' });
        announce('The product’s page couldn’t be read just now.');
      },
    );
    return () => {
      alive = false;
    };
  }, [cfg, product, search, checking, host]);

  if (!run || !finish) return null;
  // Products read, as Find a store's banner counts them.
  const read = scorecard(run).products;

  return (
    <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 32 }]}>
      <Text ref={heading} style={styles.hero} accessibilityRole="header">
        {read} prices in {seconds(finish.ms)}
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
        timeMs={finish.ms}
        items={list.items.length}
        onShare={() => router.push(`/list/${list.id}/share`)}
      />
      {winner && product && cfg ? (
        <View style={styles.proof}>
          <Text style={styles.proofTitle} accessibilityRole="header">
            Is that price real?
          </Text>
          <Text style={styles.body}>
            {line!.item.name} at {cfg.name}: {money(product.price!)}, {product.name}.
          </Text>
          {shownProof.state === 'checking' ? (
            <View style={styles.row}>
              <ActivityIndicator size="small" color={colors.orange} />
              <Text style={styles.note}>Opening the product’s own page on {host}, on this {deviceWord}…</Text>
            </View>
          ) : shownProof.state === 'same' ? (
            <View style={styles.row}>
              <Icon name="check" size={18} color={colors.green} strokeWidth={2.6} />
              <Text style={[styles.note, styles.flex, { color: colors.green }]}>{host}’s own product page shows the same price, just now.</Text>
            </View>
          ) : shownProof.state === 'different' ? (
            <Text style={[styles.note, { color: colors.amber }]}>
              The product page shows {money(shownProof.pagePrice!)}: search results and product pages can differ, or be for another store.
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
        <Pill
          label="Could a server do this?"
          icon="globe"
          variant="outline"
          accessibilityHint={`Tests each of your stores live: a plain request, the way a server asks, against this ${deviceWord}’s browser.`}
          onPress={() => router.push({ pathname: '/phone-vs-server', params: { start: '1' } })}
        />
        <Pill label="See Find a store" variant="outline" onPress={() => router.push(`/list/${list.id}/compare`)} />
        <Pill label="Done" variant="outline" onPress={onClose} />
      </View>
    </ScrollView>
  );
}

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
