import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import React, { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { itemKey, listQueries, type ExactRef, type GroceryList } from '../../../lists/types';
import { adHits } from '../../../pricing/ads';
import { staleness } from '../../../pricing/age';
import { rankBaskets, type Basket, type SplitTrip } from '../../../pricing/basket';
import { exactFrom } from '../../../pricing/exact';
import { inStoreCaveat, MODE_WORDS, orderable, type ShopMode } from '../../../pricing/onlineCost';
import { runMs } from '../../../pricing/pricingEngine';
import { swapSavings, swapsFor } from '../../../pricing/swaps';
import { startTrip } from '../../../pricing/trips';
import {
  useApp,
  useComparison,
  useFeeBook,
  useFeeReads,
  useList,
  usePricingRun,
  useSavingsReads,
  useSettings,
  useSharePlan,
  useStoreChoices,
  useStoreName,
  useWeeklyAds,
} from '../../../state/AppProvider';
import { storeNote } from '../../../state/storeInfo';
import { announce, useScreenReader } from '../../../ui/a11y';
import { ConnectionNote, LiveBanner } from '../../../ui/CompareBanner';
import { IconButton, Pill } from '../../../ui/controls';
import { Icon } from '../../../ui/Icon';
import { Podium } from '../../../ui/Race';
import { ScreenHeader } from '../../../ui/ScreenHeader';
import { ShopModeChooser } from '../../../ui/ShopMode';
import { DriveRow, feesVerdictText, PickCard, Segmented, SplitCard, StoreRow, verdictText } from '../../../ui/StoreCards';
import { colors, fonts, money, radius, shadow } from '../../../ui/theme';
import { useToday } from '../../../ui/useNow';
import { useScreenTimes } from '../../../ui/useScreenTimes';

export default function CompareScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const list = useList(id);
  if (!list) return <ScreenHeader title="Find a store" subtitle="This list was deleted." />;
  return <Compare key={list.id} list={list} />;
}

function Compare({ list }: { list: GroceryList }) {
  const insets = useSafeAreaInsets();
  const { engine, pool, store } = useApp();
  const settings = useSettings();
  const choices = useStoreChoices();
  const run = usePricingRun(list.id);
  // When each price reached this screen, for the speed test's timeline.
  useScreenTimes(run);
  const { baskets, pick, pickReady, split, running, driving, verdict, mode, online, extra, feesVerdict, orderTotal, orderCost, countCoupons, coupons } = useComparison(list, run);
  // This week's ads and the accounts' coupons, read on the phone once the stores' prices are in: one page load at a time
  // at each store.
  useSavingsReads(!running);
  const ads = useWeeklyAds();
  const today = useToday();
  const adItems = (b: Basket) => Object.keys(adHits(b, ads[b.retailerId], today)).length;
  // Clipped coupons come off a store's total only when the user counts them.
  const couponsOff = (rid: string) => (countCoupons ? (coupons[rid]?.amount ?? 0) : 0);
  // Shopping online, each store's fees page is read when it's due, while this screen shows, once the stores' prices
  // are in: one page load at a time at each store.
  useFeeReads(!running);
  const fees = useFeeBook();
  const milesTo = (rid: string) => settings.chosenStores[rid]?.miles;
  // Prices read in this run, not saved from earlier: the race, and its podium, are about those.
  const liveCount = run
    ? Object.values(run.results)
        .flatMap((r) => Object.values(r))
        .filter((r) => r.status === 'done' && !r.cached && r.at !== undefined && r.at >= run.startedAt).length
    : 0;
  // What cheaper products of the same size would take off the pick's basket, from what the phone already read.
  const pickSwaps = pick
    ? swapSavings(
        swapsFor(pick, (line) => run?.results[pick.retailerId]?.[itemKey(line.item)]?.products ?? line.alternatives, choices.find((c) => c.config.id === pick.retailerId)?.config.storeBrands),
      )
    : 0;
  // The retailer whose bot check is on screen, if any.
  const checking = useSyncExternalStore(pool.subscribe, () => pool.getSnapshot().presented?.key ?? null);
  const watching = useSyncExternalStore(pool.subscribe, () => pool.getSnapshot().live !== 'off');
  const nameOf = useStoreName(run);
  // In store, a store whose site shows its online prices says so.
  const caveatOf = (rid: string) => (mode === 'store' ? inStoreCaveat(nameOf(rid), choices.find((c) => c.config.id === rid)?.config.online) : undefined);

  // Prices whatever isn't known yet each time the screen shows, and when the list or the stores change.
  const queries = listQueries(list).join('\n');
  // Items that can take another item's search ("Whole milk" in the one for "Milk").
  const share = useSharePlan(list);
  const price = useCallback(() => {
    engine.start(list.id, queries.split('\n'), choices, { share });
  }, [engine, list.id, queries, choices, share]);
  useFocusEffect(price);

  const refresh = () => engine.start(list.id, listQueries(list), choices, { refresh: true, share });
  const shop = (retailerIds: string[], basketOrSplit: Basket | SplitTrip) => {
    // Ordering online, the trip counts the order's fees, and its savings are against stores that take the order too.
    const added = 'assignment' in basketOrSplit ? basketOrSplit.fees : online?.[retailerIds[0]]?.extra;
    startTrip(store, list, retailerIds, basketOrSplit, orderable(baskets, online), mode === 'store' ? undefined : { mode, fees: added, costOf: orderCost });
    router.dismissTo(`/list/${list.id}`);
  };
  const watch = () => pool.setLiveView(watching ? 'off' : 'open');

  // While searching, stores keep their places; once done, best first, and stores that can't take the order last.
  const rankBy = settings.rankBy;
  const ranked = running ? baskets : rankBaskets(baskets, rankBy, extra);
  const can = orderable(ranked, online);
  const ordered = [...can, ...ranked.filter((b) => !can.includes(b))];
  const others = ordered.filter((b) => b.retailerId !== pick?.retailerId || running);
  // A basket's total the way the user shops: in the same sizes or as sold, plus what ordering online adds.
  const shown = (b: Basket) => Math.round(((rankBy === 'unit' ? (b.unitTotal ?? b.total) : b.total) + (online?.[b.retailerId]?.extra ?? 0) - couponsOff(b.retailerId)) * 100) / 100;
  const setMode = (m: ShopMode) => store.setShopMode(m);
  const exactItems = list.items.filter((i) => i.exact).length;
  const lockIn = () => {
    if (!pick) return;
    const refs: Record<string, ExactRef | null> = {};
    for (const line of pick.lines) if (line.status === 'found' && line.product) refs[line.item.id] = exactFrom(line.product, pick.retailerId);
    store.setExactAll(list.id, refs);
  };
  const unlock = () => store.setExactAll(list.id, Object.fromEntries(list.items.map((i) => [i.id, null])));
  // The live view is only something to look at: it stays off with a screen reader.
  const screenReader = useScreenReader();

  // Screen readers hear when the prices are in, and the pick.
  const wasRunning = useRef(running);
  useEffect(() => {
    if (wasRunning.current && !running && pick) {
      announce(`Prices checked. Stretch’s pick: ${nameOf(pick.retailerId)}, ${money(shown(pick))}${mode === 'store' ? '' : ` ${MODE_WORDS[mode]}`}${couponsOff(pick.retailerId) ? ', with coupons' : ''}.`);
    }
    wasRunning.current = running;
  });

  return (
    <View style={styles.screen}>
      <ScreenHeader
        title="Find a store"
        subtitle={`${list.name} · ${list.items.length} ${list.items.length === 1 ? 'item' : 'items'}`}
        right={
          <>
            {!screenReader ? (
              <IconButton
                name="eye"
                label={watching ? 'Stop watching the phone work' : 'Watch the phone read the stores'}
                color={watching ? colors.orange : colors.ink}
                onPress={watch}
              />
            ) : null}
            <IconButton name="refresh" label="Check prices again" onPress={refresh} />
          </>
        }
      />
      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 32 }]}>
        {!choices.length ? (
          <View style={styles.card}>
            <Text style={styles.body}>No stores are switched on.</Text>
            <Pill label="Choose stores" small variant="dark" onPress={() => router.push('/stores')} style={styles.alignStart} />
          </View>
        ) : null}
        {run ? (
          <LiveBanner
            run={run}
            baskets={baskets}
            nameOf={nameOf}
            listName={list.name}
            watching={watching || screenReader}
            onWatch={watch}
            onStop={() => engine.stop(list.id)}
            onRefresh={refresh}
          />
        ) : null}
        {run ? <ConnectionNote run={run} nameOf={nameOf} onRetry={() => engine.retry(list.id)} /> : null}

        {baskets.length > 1 ? (
          <View style={styles.rankRow}>
            <Text style={styles.rankLabel}>Rank stores by</Text>
            <Segmented
              value={rankBy}
              options={[
                { value: 'total', label: 'Total' },
                { value: 'unit', label: 'Same sizes' },
              ]}
              onChange={(v) => store.setRankBy(v)}
            />
          </View>
        ) : null}
        {rankBy === 'unit' && baskets.length > 1 ? (
          <Text style={styles.rankNote}>Each item counted in the smallest pack any of your stores sells, at each store’s price per unit.</Text>
        ) : null}
        {baskets.length ? (
          <View style={styles.modeBox}>
            <Text style={styles.rankLabel}>How you shop</Text>
            <ShopModeChooser value={mode} onChange={setMode} />
            {mode !== 'store' ? (
              <Text style={styles.rankNote}>
                {mode === 'delivery' ? 'Delivered' : 'For pickup'}: each total adds the store’s fees, and its higher online prices where it says
                they’re higher, before tip and tax. Tap a store for its fees and where they come from.
                {fees.reading ? ` Reading ${nameOf(fees.reading)}’s fees page now…` : ''}
              </Text>
            ) : null}
          </View>
        ) : null}
        {baskets.length > 1 && mode !== 'delivery' ? (
          <DriveRow
            drive={settings.drive}
            onChange={(d) => store.setDrive(d)}
            unknown={driving ? baskets.filter((b) => driving[b.retailerId] === undefined).map((b) => nameOf(b.retailerId)) : []}
          />
        ) : null}

        {run?.finishedAt && liveCount && !running ? (
          <Podium
            baskets={orderable(baskets, online)}
            by={rankBy}
            extra={extra}
            how={[mode === 'store' ? '' : `${MODE_WORDS[mode]}, fees included`, countCoupons ? 'clipped coupons counted' : ''].filter(Boolean).join(', ') || undefined}
            nameOf={nameOf}
            timeMs={runMs(run)!}
            items={list.items.length}
            onShare={() => router.push(`/list/${list.id}/share`)}
          />
        ) : null}

        {pick ? (
          <PickCard
            by={rankBy}
            basket={pick}
            total={shown(pick)}
            asSoldTotal={orderTotal(pick)}
            mode={mode}
            online={online?.[pick.retailerId]}
            name={nameOf(pick.retailerId)}
            note={storeNote(pick.retailerId, settings)}
            label={!running ? 'Stretch’s pick' : pickReady ? 'Stretch’s pick so far' : 'Leading so far'}
            ready={pickReady}
            stale={staleness(run, pick.retailerId)}
            stillChecking={baskets.filter((b) => b !== pick && (!b.complete || b.refreshing)).map((b) => nameOf(b.retailerId))}
            driving={driving?.[pick.retailerId]}
            miles={milesTo(pick.retailerId)}
            verdict={verdict ? verdictText(verdict, nameOf, mode) : undefined}
            feesVerdict={feesVerdict ? feesVerdictText(feesVerdict, nameOf, mode, online) : undefined}
            caveat={caveatOf(pick.retailerId)}
            swaps={pickReady ? pickSwaps : 0}
            adItems={adItems(pick)}
            coupons={coupons[pick.retailerId]}
            countCoupons={countCoupons}
            onOpen={() => router.push(`/list/${list.id}/store/${pick.retailerId}`)}
            onShop={() => shop([pick.retailerId], pick)}
          />
        ) : null}

        {split ? (
          <SplitCard split={split} names={split.retailerIds.map(nameOf)} mode={mode} onOpen={() => router.push(`/list/${list.id}/split`)} />
        ) : null}

        {pick && baskets.length > 1 ? (
          <View style={styles.card}>
            <View style={styles.pickHead}>
              <Icon name="copy" size={16} color={colors.ink} />
              <Text style={styles.pickLabelInk} accessibilityRole="header">
                {exactItems ? `The same products, for ${exactItems} ${exactItems === 1 ? 'item' : 'items'}` : 'Like for like'}
              </Text>
            </View>
            <Text style={styles.small}>
              {exactItems
                ? 'Every store is compared on the same products, found by barcode where stores publish one, else by name and size. Stores without one say so.'
                : `Compare ${nameOf(pick.retailerId)}’s products at every store, the exact same ones, instead of each store’s best match.`}
            </Text>
            <Pill
              label={exactItems ? 'Back to the best match at each store' : 'Compare the same products'}
              small
              variant={exactItems ? 'outline' : 'dark'}
              onPress={exactItems ? unlock : lockIn}
              style={styles.alignStart}
            />
          </View>
        ) : null}

        {others.length ? (
          <Text style={styles.section} accessibilityRole="header">
            {running ? 'Checking each store' : 'Other stores'}
          </Text>
        ) : null}
        {others.map((b) => (
          <StoreRow
            key={b.retailerId}
            by={rankBy}
            basket={b}
            total={shown(b)}
            asSoldTotal={orderTotal(b)}
            mode={mode}
            online={online?.[b.retailerId]}
            caveat={caveatOf(b.retailerId)}
            name={nameOf(b.retailerId)}
            storeRun={run?.stores[b.retailerId]}
            stale={staleness(run, b.retailerId)}
            waitingForUser={checking === b.retailerId}
            driving={driving?.[b.retailerId]}
            miles={milesTo(b.retailerId)}
            adItems={adItems(b)}
            withCoupons={couponsOff(b.retailerId) > 0}
            onOpen={() => router.push(`/list/${list.id}/store/${b.retailerId}`)}
            onRetry={() => engine.retry(list.id, b.retailerId)}
          />
        ))}

        {pick && !running ? (
          <Pressable onPress={() => router.push(`/list/${list.id}/truth`)} style={styles.link} accessibilityRole="button">
            <Icon name="check" size={18} color={colors.muted} />
            <Text style={styles.linkText}>Are these prices right? Check them against each product’s page</Text>
          </Pressable>
        ) : null}
        <Pressable onPress={() => router.push('/stores')} style={styles.link} accessibilityRole="button">
          <Icon name="store" size={18} color={colors.muted} />
          <Text style={styles.linkText}>Change which stores are compared</Text>
        </Pressable>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.paper },
  content: { paddingHorizontal: 16, gap: 12 },
  alignStart: { alignSelf: 'flex-start' },
  section: { fontFamily: fonts.semibold, fontSize: 13, letterSpacing: 0.6, textTransform: 'uppercase', color: colors.muted, marginTop: 10, marginLeft: 4 },
  body: { fontFamily: fonts.body, fontSize: 15, color: colors.ink },
  small: { fontFamily: fonts.body, fontSize: 14, lineHeight: 19, color: colors.muted },
  pickHead: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingBottom: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  rankRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  rankLabel: { fontFamily: fonts.medium, fontSize: 14, color: colors.muted },
  rankNote: { fontFamily: fonts.body, fontSize: 13, lineHeight: 18, color: colors.muted, marginTop: -4 },
  pickLabelInk: { fontFamily: fonts.semibold, fontSize: 15, color: colors.ink },
  card: { backgroundColor: colors.card, borderRadius: radius.lg, padding: 16, gap: 10, ...shadow.card },
  link: { flexDirection: 'row', alignItems: 'center', gap: 8, alignSelf: 'center', paddingVertical: 14 },
  linkText: { flexShrink: 1, fontFamily: fonts.medium, fontSize: 15, color: colors.muted },
  modeBox: { gap: 8 },
});
