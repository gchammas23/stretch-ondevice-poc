import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Share, StyleSheet, Switch, Text, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { itemKey, listQueries, type ExactRef, type GroceryList } from '../../../lists/types';
import { bytesText } from '../../../onDevice/scrapeFeed';
import { adHits } from '../../../pricing/ads';
import { ago, staleness, type Staleness } from '../../../pricing/age';
import { rankBaskets, type Basket, type DriveVerdict, type RankBy, type SplitTrip } from '../../../pricing/basket';
import { couponsFitting, type CouponCredit } from '../../../pricing/coupons';
import { exactFrom } from '../../../pricing/exact';
import { dollars, feesSummary, inStoreCaveat, MODE_WORDS, orderable, type OnlineCost, type ShopMode } from '../../../pricing/onlineCost';
import type { PricingRun, StoreRun } from '../../../pricing/pricingEngine';
import { scorecard, scorecardText } from '../../../pricing/scorecard';
import { swapSavings, swapsFor } from '../../../pricing/swaps';
import { startTrip } from '../../../pricing/trips';
import type { Settings } from '../../../state/appStore';
import { milesText, storeNote } from '../../../state/storeInfo';
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
  useWeeklyAds,
} from '../../../state/AppProvider';
import { announce, useScreenReader } from '../../../ui/a11y';
import { Chip } from '../../../ui/bits';
import { IconButton, Pill } from '../../../ui/controls';
import { deviceWord } from '../../../ui/device';
import { Icon } from '../../../ui/Icon';
import { Podium, RaceLanes } from '../../../ui/Race';
import { RetailerBadge } from '../../../ui/RetailerBadge';
import { ScreenHeader } from '../../../ui/ScreenHeader';
import { ShopModeChooser } from '../../../ui/ShopMode';
import { colors, fonts, money, radius, shadow } from '../../../ui/theme';
import { useNow, useToday } from '../../../ui/useNow';
import { useScreenTimes } from '../../../ui/useScreenTimes';

export default function CompareScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const list = useList(id);
  if (!list) return <ScreenHeader title="Find a store" subtitle="This list was deleted." />;
  return <Compare list={list} />;
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
  // Shopping online, each store's fees page is read when it's due, while this screen shows.
  useFeeReads();
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
  const nameOf = (rid: string) => choices.find((c) => c.config.id === rid)?.config.name ?? run?.stores[rid]?.name ?? rid;
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
            timeMs={run.finishedAt - run.startedAt}
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

function LiveBanner({
  run,
  baskets,
  nameOf,
  listName,
  watching,
  onWatch,
  onStop,
  onRefresh,
}: {
  run: PricingRun;
  baskets: Basket[];
  nameOf: (retailerId: string) => string;
  listName: string;
  watching: boolean;
  onWatch: () => void;
  onStop: () => void;
  onRefresh: () => void;
}) {
  const now = useNow(run.finishedAt ? 30_000 : 1000);
  const [open, setOpen] = useState(false);
  const stores = Object.values(run.stores);
  const total = stores.reduce((n, s) => n + s.total, 0);
  const settled = stores.reduce((n, s) => n + s.settled, 0);
  const active = stores.filter((s) => s.status === 'running').length;
  const results = Object.values(run.results).flatMap((r) => Object.values(r));
  const read = results.filter((r) => r.status === 'done' && r.at);
  const oldest = read.length ? Math.min(...read.map((r) => r.at!)) : undefined;
  // Searched in this run, not saved from earlier, nor found in another item's search.
  const live = read.filter((r) => !r.cached && !r.sharedWith && r.at! >= run.startedAt).length;
  const shownMeanwhile = results.filter((r) => r.stale && r.products.length && (r.status === 'queued' || r.status === 'searching'));
  const meanwhileAt = shownMeanwhile.length ? Math.min(...shownMeanwhile.map((r) => r.at ?? now)) : undefined;

  if (!run.finishedAt) {
    return (
      <View style={[styles.banner, styles.bannerLive]}>
        <View style={styles.bannerHead}>
          <Icon name="zap" size={18} color={colors.orange} />
          <Text style={styles.bannerTitle}>{meanwhileAt ? 'Updating prices live from this phone' : 'Checking prices live from this phone'}</Text>
        </View>
        {meanwhileAt ? <Text style={styles.bannerText}>Showing prices from {ago(now - meanwhileAt)} until the new ones land.</Text> : null}
        {/* The race: each store's lane fills as its prices come in, with its own stopwatch. */}
        <RaceLanes run={run} baskets={baskets} nameOf={nameOf} />
        <View style={styles.bannerFoot}>
          <Text style={styles.bannerText}>
            {settled} of {total} searches{active > 1 ? ` · ${active} stores at once` : ''} · {seconds(now - run.startedAt)}
          </Text>
          {!watching ? (
            <Pressable onPress={onWatch} hitSlop={TEXT_BUTTON_SLOP} accessibilityRole="button" accessibilityHint="Shows the store pages this phone is reading">
              <Text style={styles.bannerAction}>Watch</Text>
            </Pressable>
          ) : null}
          <Pressable onPress={onStop} hitSlop={TEXT_BUTTON_SLOP} accessibilityRole="button" accessibilityLabel="Stop checking prices">
            <Text style={styles.bannerAction}>Stop</Text>
          </Pressable>
        </View>
      </View>
    );
  }
  const card = scorecard(run);
  return (
    <View style={styles.banner}>
      <View style={styles.bannerHead}>
        <Icon name="phone" size={18} color={colors.green} />
        <Text style={styles.bannerTitle}>
          {live && card.products
            ? `${card.products} prices from ${card.storesSearched} ${card.storesSearched === 1 ? 'store' : 'stores'} in ${seconds(run.finishedAt - run.startedAt)}, on this ${deviceWord}`
            : `Prices read live from this ${deviceWord}`}
        </Text>
      </View>
      <View style={styles.bannerFoot}>
        <Text style={styles.bannerText}>
          {live
            ? `${live} searches${card.firstMs !== undefined ? ` · first price after ${seconds(card.firstMs)}` : ''}${card.bytes ? ` · about ${bytesText(card.bytes)}` : ''}${
                card.bytesSaved ? `, ${bytesText(card.bytesSaved)} saved` : ''
              }`
            : 'Saved from earlier'}
          {oldest ? ` · oldest price ${ago(now - oldest)}` : ''}
        </Text>
        {live ? (
          <Pressable
            onPress={() => setOpen(!open)}
            hitSlop={TEXT_BUTTON_SLOP}
            accessibilityRole="button"
            accessibilityLabel={open ? 'Hide scorecard' : 'Scorecard'}
            accessibilityState={{ expanded: open }}
          >
            <Text style={styles.bannerAction}>{open ? 'Hide' : 'Scorecard'}</Text>
          </Pressable>
        ) : null}
        <Pressable onPress={onRefresh} hitSlop={TEXT_BUTTON_SLOP} accessibilityRole="button" accessibilityLabel="Refresh prices">
          <Text style={styles.bannerAction}>Refresh</Text>
        </Pressable>
      </View>
      {open ? (
        <View style={styles.score}>
          {card.stores.map((s) => (
            <View key={s.retailerId} style={styles.scoreRow}>
              <Text style={styles.scoreName} numberOfLines={1}>
                {s.name}
              </Text>
              <Text style={styles.scoreText}>
                {!s.searches
                  ? s.saved
                    ? `${s.saved} saved from earlier`
                    : 'nothing searched'
                  : [
                      `${s.ok}/${s.searches} worked`,
                      s.totalMs !== undefined ? seconds(s.totalMs) : null,
                      s.medianMs !== undefined ? `${seconds(s.medianMs)} each` : null,
                      s.api ? 'official API' : null,
                      s.direct ? `${s.direct} direct` : null,
                      s.pageLoads ? `${s.pageLoads} page ${s.pageLoads === 1 ? 'load' : 'loads'}` : null,
                      s.reused ? `${s.reused} reused page` : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
              </Text>
            </View>
          ))}
          <Pressable
            accessibilityRole="button"
            onPress={() =>
              void Share.share({
                message: scorecardText(card, `${listName}: prices read on this ${deviceWord}, ${new Date(run.startedAt).toLocaleString('en-US')}`),
              }).catch(() => {})
            }
            style={styles.shareScore}
          >
            <Icon name="share" size={16} color={colors.orange} />
            <Text style={styles.bannerAction}>Share scorecard</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

function PickCard({
  by,
  basket,
  total,
  asSoldTotal,
  mode,
  online,
  name,
  note,
  label,
  ready,
  stale,
  stillChecking,
  driving,
  miles,
  verdict,
  feesVerdict,
  caveat,
  swaps,
  adItems,
  coupons,
  countCoupons,
  onOpen,
  onShop,
}: {
  by: RankBy;
  basket: Basket;
  /** Its total the way the user ranks and shops (same sizes or as sold; in store, for pickup or delivered). */
  total: number;
  /** As sold, the way the user shops. */
  asSoldTotal: number;
  mode: ShopMode;
  /** Ordering online: the order, with its fees. */
  online?: OnlineCost;
  name: string;
  note: string;
  label: string;
  /** Its store has finished, so it can be shopped while others keep checking. */
  ready: boolean;
  stale: Staleness;
  stillChecking: string[];
  /** When driving counts: the drive there and back, and how far the store is. */
  driving?: number;
  miles?: number;
  /** Whether its prices make up for the drive, in words. */
  verdict?: string;
  /** Ordering online: whether a store's fees cost it the pick, in words. */
  feesVerdict?: string;
  /** In store, when the prices read are the store's online ones. */
  caveat?: string;
  /** What cheaper swaps of the same size would take off, at this store. */
  swaps: number;
  /** Items of the list in this store's weekly ad. */
  adItems: number;
  /** The account's coupons that fit the basket, when they've been read. */
  coupons?: CouponCredit;
  /** Clipped coupons come off the total. */
  countCoupons: boolean;
  onOpen: () => void;
  onShop: () => void;
}) {
  const now = useNow(60_000);
  const all = basket.found === basket.itemCount;
  const withCoupons = countCoupons && !!coupons?.amount;
  const how = `${mode === 'store' ? '' : ` ${MODE_WORDS[mode]}`}${withCoupons ? ', with coupons' : ''}`;
  const fitting = couponsFitting(coupons);
  // The card opens the basket; Shop here sits beside that area, not inside it, so each is its own control.
  return (
    <View style={styles.pickCard}>
      <Pressable
        onPress={onOpen}
        style={({ pressed }) => [styles.pickTop, pressed && styles.pressed]}
        accessibilityRole="button"
        accessibilityLabel={`${label}: ${name}, ${money(total)}${how}. ${note}`}
        accessibilityHint="Opens the basket"
      >
        <View style={styles.pickHead}>
          <Icon name="sparkle" size={16} color={colors.blue} />
          <Text style={styles.pickLabel}>{label}</Text>
        </View>
        <View style={styles.storeLine}>
          <RetailerBadge retailerId={basket.retailerId} name={name} size={44} />
          <View style={styles.flex}>
            <Text style={styles.storeName}>{name}</Text>
            <Text style={styles.small}>{note}</Text>
          </View>
          <View style={styles.totals}>
            <Text style={styles.pickTotal}>{money(total)}</Text>
            {how ? <Text style={styles.small}>{how.replace(/^[\s,]+/, '')}</Text> : null}
            {asSold(total, asSoldTotal, by) ? <Text style={styles.small}>{money(asSoldTotal)} as sold</Text> : null}
            {online?.extra ? <Text style={styles.small}>{money(basket.total)} in store</Text> : null}
            {driving !== undefined ? <Text style={styles.small}>+ {money(driving)} driving</Text> : null}
          </View>
        </View>
      </Pressable>
      {online ? (
        <View style={styles.feesLine}>
          <Icon name={mode === 'delivery' ? 'truck' : 'bag'} size={15} color={colors.muted} />
          <Text style={[styles.small, styles.flexText]}>{feesSummary(online)}</Text>
        </View>
      ) : null}
      {online?.minimum ? (
        <Text style={[styles.small, { color: colors.amber }]}>
          Under {name}’s {dollars(online.minimum.amount)} minimum order: add {money(online.minimum.short)} more to order it.
        </Text>
      ) : null}
      <View style={styles.pickFoot}>
        <View style={styles.flex}>
          <Text style={styles.pickWhy}>{all ? 'Best basket:' : 'Most of your list:'}</Text>
          <Text style={styles.small}>
            {all
              ? `Includes all ${basket.itemCount} items at their lowest overall price.`
              : `${basket.found} of ${basket.itemCount} items for the lowest total.`}
          </Text>
        </View>
        <Pill
          label="Shop here"
          accessibilityLabel={`Shop here at ${name}`}
          accessibilityHint={ready ? undefined : `Available when ${name} finishes checking`}
          small
          variant="dark"
          disabled={!ready}
          onPress={onShop}
        />
      </View>
      {basket.onSale ? (
        <Chip
          label={`${basket.onSale} of your items ${basket.onSale === 1 ? 'is' : 'are'} on sale here · save ${money(basket.saleSavings)}`}
          icon="tag"
          tone="orange"
        />
      ) : null}
      {adItems ? (
        <Chip label={`${adItems} of your items ${adItems === 1 ? 'is' : 'are'} in this week’s ad here`} icon="star" tone="blue" />
      ) : null}
      {coupons && fitting ? (
        <Chip
          label={`${fitting} of your coupons ${fitting === 1 ? 'fits' : 'fit'} here · ${money(coupons.amount)} off${coupons.amount ? (countCoupons ? ', counted' : ', not counted') : ''}`}
          icon="tag"
          tone="green"
        />
      ) : null}
      {swaps > 0 ? (
        <Pressable onPress={onOpen} accessibilityRole="button" accessibilityHint="Opens the basket, with its swaps" style={styles.swapLine}>
          <Icon name="tag" size={15} color={colors.green} />
          <Text style={[styles.small, styles.flexText, { color: colors.green }]}>Cheaper swaps of the same size could save another {money(swaps)} here.</Text>
          <Icon name="forward" size={15} color={colors.green} />
        </Pressable>
      ) : null}
      {driving !== undefined && miles !== undefined ? (
        <Text style={styles.small}>
          {milesText(miles)} away: {money(driving)} there and back. {verdict ?? ''}
        </Text>
      ) : null}
      {feesVerdict ? <Text style={styles.small}>{feesVerdict}</Text> : null}
      {caveat ? <Text style={styles.small}>{caveat}</Text> : null}
      {stale.oldestAt ? <Text style={styles.staleNote}>{staleText(stale, now)}</Text> : null}
      {ready && stillChecking.length ? (
        <Text style={styles.small}>Still checking {stillChecking.join(', ')}. The pick changes if one turns out cheaper.</Text>
      ) : null}
    </View>
  );
}

function staleText(stale: Staleness, now: number): string {
  const when = ago(now - (stale.oldestAt ?? now));
  if (stale.refreshing) return `Some prices are from ${when}, updating now.`;
  return `Some prices are from ${when}: they couldn’t be updated.`;
}

function SplitCard({ split, names, mode, onOpen }: { split: SplitTrip; names: string[]; mode: ShopMode; onOpen: () => void }) {
  return (
    <Pressable onPress={onOpen} style={({ pressed }) => [styles.card, styles.splitCard, pressed && styles.pressed]} accessibilityRole="button">
      <View style={styles.pickHead}>
        <Icon name="split" size={16} color={colors.orange} />
        <Text style={[styles.pickLabel, { color: colors.orangeText }]}>
          {split.extraItems > 0 ? `Split trip gets ${split.extraItems} more ${split.extraItems === 1 ? 'item' : 'items'}` : `Split trip saves ${money(split.savings)}`}
        </Text>
      </View>
      <View style={styles.storeLine}>
        <View style={styles.badgePair}>
          <RetailerBadge retailerId={split.retailerIds[0]} name={names[0]} size={34} />
          <View style={styles.badgeOverlap}>
            <RetailerBadge retailerId={split.retailerIds[1]} name={names[1]} size={34} />
          </View>
        </View>
        <View style={styles.flex}>
          <Text style={styles.storeName}>{names.join(' + ')}</Text>
          <Text style={styles.small}>
            {split.found} items at the cheaper of the two stores
            {split.fees !== undefined ? `, ${money(split.fees)} in fees for two ${mode === 'delivery' ? 'deliveries' : 'pickups'}` : ''}
            {split.driving !== undefined ? `, ${money(split.driving)} driving to both` : ''}
          </Text>
        </View>
        <View style={styles.totals}>
          <Text style={styles.total}>{money(split.total + (split.fees ?? 0))}</Text>
          {mode !== 'store' ? <Text style={styles.small}>{MODE_WORDS[mode]}</Text> : null}
        </View>
      </View>
    </Pressable>
  );
}

function StoreRow({
  by,
  basket,
  total,
  asSoldTotal,
  mode,
  online,
  caveat,
  name,
  storeRun,
  stale,
  waitingForUser,
  driving,
  miles,
  adItems,
  withCoupons,
  onOpen,
  onRetry,
}: {
  by: RankBy;
  basket: Basket;
  /** Its total the way the user ranks and shops. */
  total: number;
  /** As sold, the way the user shops. */
  asSoldTotal: number;
  mode: ShopMode;
  /** Ordering online: the order, with its fees, or that the store doesn't take it. */
  online?: OnlineCost;
  /** In store, when the prices read are the store's online ones. */
  caveat?: string;
  name: string;
  storeRun: StoreRun | undefined;
  stale: Staleness;
  waitingForUser: boolean;
  /** When driving counts: the drive there and back, and how far the store is. */
  driving?: number;
  miles?: number;
  /** Items of the list in this store's weekly ad. */
  adItems: number;
  /** Its total has clipped coupons taken off. */
  withCoupons: boolean;
  onOpen: () => void;
  onRetry: () => void;
}) {
  const now = useNow(60_000);
  const { fontScale } = useWindowDimensions();
  // Big text wraps instead of cutting off a status.
  const lines = (n: number) => (fontScale > 1.3 ? undefined : n);
  const s = storeRun;
  let status: React.ReactNode;
  if (waitingForUser) {
    status = <Text style={[styles.small, { color: colors.amber }]}>Waiting for you to finish {name}’s check</Text>;
  } else if (s && s.status !== 'done') {
    const current = s.searching[0];
    status = (
      <View style={styles.statusLine}>
        {s.status === 'running' ? <ActivityIndicator size="small" color={colors.orange} /> : null}
        <Text style={styles.small} numberOfLines={lines(1)}>
          {s.status === 'waiting'
            ? 'Next in line'
            : `${stale.refreshing ? 'Updating' : 'Checking'} ${Math.min(s.settled + 1, s.total)} of ${s.total}${current ? ` · ${current.toLowerCase()}` : ''}`}
        </Text>
      </View>
    );
  } else {
    status = (
      <Text style={[styles.small, basket.failed ? { color: colors.red } : stale.notRefreshed ? { color: colors.amber } : null]} numberOfLines={lines(2)}>
        {s?.stoppedBecause
          ? `${s.stoppedBecause}. ${basket.found} of ${basket.itemCount} found`
          : stale.notRefreshed
            ? `Prices from ${ago(now - (stale.oldestAt ?? now))} · couldn’t update`
            : basket.failed
            ? `${basket.found} of ${basket.itemCount} found · couldn’t check ${basket.failed}`
            : basket.found === basket.itemCount
              ? `All ${basket.itemCount} items`
              : `${basket.found} of ${basket.itemCount} items · ${basket.missing} not found`}
        {basket.onSale ? <Text style={styles.onSale}>{` · ${basket.onSale} on sale`}</Text> : null}
        {adItems ? <Text style={styles.inAd}>{` · ${adItems} in the ad`}</Text> : null}
      </Text>
    );
  }
  const canRetry = s?.status === 'done' && (basket.failed > 0 || stale.notRefreshed > 0);
  // A store that doesn't take the order the way the user shops shows its total in store, set apart.
  const cannot = online?.available === false;
  const how = [mode === 'store' ? '' : cannot ? 'in store only' : MODE_WORDS[mode], withCoupons && !cannot ? 'with coupons' : ''].filter(Boolean).join(', ');

  return (
    <View style={styles.card}>
      <Pressable onPress={onOpen} style={({ pressed }) => [styles.storeLine, pressed && styles.pressed]} accessibilityRole="button">
        <RetailerBadge retailerId={basket.retailerId} name={name} />
        <View style={styles.flex}>
          <Text style={styles.storeName}>{name}</Text>
          {status}
          {online ? (
            <Text style={[styles.small, cannot && { color: colors.amber }]} numberOfLines={lines(2)}>
              {feesSummary(online)}
            </Text>
          ) : null}
          {online?.minimum ? (
            <Text style={[styles.small, { color: colors.amber }]} numberOfLines={lines(1)}>
              Under its {dollars(online.minimum.amount)} minimum order
            </Text>
          ) : null}
          {caveat ? (
            <Text style={styles.small} numberOfLines={lines(2)}>
              {caveat}
            </Text>
          ) : null}
          {driving !== undefined && miles !== undefined ? (
            <Text style={styles.small} numberOfLines={lines(1)}>
              {milesText(miles)} away · {money(driving)} there and back
            </Text>
          ) : null}
        </View>
        <View style={styles.totals}>
          <Text
            style={[styles.total, (!basket.found || cannot) && { color: colors.faint }]}
            accessibilityLabel={basket.found ? `${money(cannot ? basket.total : total)}${how ? ` ${how}` : ''}` : 'No total yet'}
          >
            {basket.found ? money(cannot ? basket.total : total) : '—'}
          </Text>
          {basket.found && how ? <Text style={styles.small}>{how}</Text> : null}
          {basket.found && !cannot && asSold(total, asSoldTotal, by) ? <Text style={styles.small}>{money(asSoldTotal)} as sold</Text> : null}
        </View>
        <Icon name="forward" size={18} color={colors.faint} />
      </Pressable>
      {canRetry ? <Pill label={`Try ${name} again`} icon="refresh" small variant="outline" onPress={onRetry} style={styles.retry} /> : null}
    </View>
  );
}

/** What a mile costs, to choose from. */
const PER_MILE = [0.35, 0.5, 0.7, 1];

/** Count the drive to each store and back, at a cost per mile. */
function DriveRow({ drive, onChange, unknown }: { drive: Settings['drive']; onChange: (d: Partial<Settings['drive']>) => void; unknown: string[] }) {
  return (
    <View style={styles.driveBox}>
      <View style={styles.driveHead}>
        <Icon name="map" size={17} color={colors.ink} />
        <Text style={styles.driveTitle}>Count the drive</Text>
        <Switch
          value={drive.on}
          onValueChange={(on) => onChange({ on })}
          trackColor={{ true: colors.orange, false: colors.faint }}
          thumbColor="#FFFFFF"
          accessibilityLabel="Count the drive to each store"
        />
      </View>
      {drive.on ? (
        <>
          <View style={styles.rateRow} accessibilityRole="radiogroup" accessibilityLabel="What a mile of driving costs">
            {PER_MILE.map((rate) => {
              const on = Math.abs(drive.perMile - rate) < 0.001;
              return (
                <Pressable
                  key={rate}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: on }}
                  hitSlop={{ top: 6, bottom: 6 }}
                  onPress={() => onChange({ perMile: rate })}
                  style={[styles.rate, on && styles.rateOn]}
                >
                  <Text style={[styles.rateText, on && styles.rateTextOn]}>{rate < 1 ? `${Math.round(rate * 100)}¢` : `$${rate}`} a mile</Text>
                </Pressable>
              );
            })}
          </View>
          <Text style={styles.small}>
            Each store’s distance from your ZIP code, there and back.
            {unknown.length ? ` Not known for ${unknown.join(', ')}: counted without driving.` : ''}
          </Text>
        </>
      ) : null}
    </View>
  );
}

/** Whether the pick's prices make up for the drive, in a sentence. Ordering for pickup, its fees count on both sides. */
function verdictText(verdict: DriveVerdict, nameOf: (rid: string) => string, mode: ShopMode): string | undefined {
  if (verdict.notWorthIt) {
    const v = verdict.notWorthIt;
    return `${nameOf(v.retailerId)} is ${money(v.saves)} cheaper ${mode === 'store' ? 'on groceries' : MODE_WORDS[mode]}, but ${money(v.extraDriving)} more to drive to: not worth it.`;
  }
  if (verdict.worthIt) {
    const v = verdict.worthIt;
    return `Worth the drive: ${money(v.saves)} less than ${nameOf(v.nearer)}, which is nearer, for ${money(v.extraDriving)} more driving.`;
  }
  return undefined;
}

/** Ordering online: whether a store's fees (and online prices) cost it the pick, or the pick is worth its fees. */
function feesVerdictText(verdict: DriveVerdict, nameOf: (rid: string) => string, mode: ShopMode, online?: Record<string, OnlineCost>): string | undefined {
  const marked = (rid: string) => !!online?.[rid]?.parts.some((p) => p.kind === 'markup' && p.amount > 0);
  if (verdict.notWorthIt) {
    const v = verdict.notWorthIt;
    return `${nameOf(v.retailerId)} is ${money(v.saves)} cheaper before fees, but ${money(v.extraDriving)} more in fees${marked(v.retailerId) ? ' and online prices' : ''}, so it costs more ${MODE_WORDS[mode]}.`;
  }
  // Pennies of difference in fees aren't worth a sentence.
  if (verdict.worthIt && verdict.worthIt.extraDriving >= 1) {
    const v = verdict.worthIt;
    return `Worth its fees: ${money(v.saves)} less than ${nameOf(v.nearer)} before fees, for ${money(v.extraDriving)} more in fees.`;
  }
  return undefined;
}

function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <View style={styles.segmented} accessibilityRole="radiogroup">
      {options.map((o) => {
        const on = o.value === value;
        return (
          <Pressable
            key={o.value}
            accessibilityRole="radio"
            accessibilityState={{ checked: on }}
            hitSlop={{ top: 8, bottom: 8 }}
            onPress={() => onChange(o.value)}
            style={[styles.segment, on && styles.segmentOn]}
          >
            <Text style={[styles.segmentText, on && styles.segmentTextOn]}>{o.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function seconds(ms: number): string {
  return `${Math.max(0, ms / 1000).toFixed(1)} s`;
}

/** Text-sized buttons reach 44 pt to touch. */
const TEXT_BUTTON_SLOP = { top: 12, bottom: 12, left: 8, right: 8 };

/** Under a same-sizes total, what the basket costs as sold, when that's different. */
const asSold = (total: number, asSoldTotal: number, by: RankBy) => by === 'unit' && money(total) !== money(asSoldTotal);

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.paper },
  content: { paddingHorizontal: 16, gap: 12 },
  flex: { flex: 1, gap: 3 },
  alignStart: { alignSelf: 'flex-start' },
  pressed: { opacity: 0.85 },
  section: { fontFamily: fonts.semibold, fontSize: 13, letterSpacing: 0.6, textTransform: 'uppercase', color: colors.muted, marginTop: 10, marginLeft: 4 },
  body: { fontFamily: fonts.body, fontSize: 15, color: colors.ink },
  small: { fontFamily: fonts.body, fontSize: 14, lineHeight: 19, color: colors.muted },
  banner: { backgroundColor: colors.card, borderRadius: radius.lg, padding: 16, gap: 10, borderWidth: 1, borderColor: colors.line },
  bannerLive: { borderColor: '#F7C2B3', backgroundColor: '#FFF6F2' },
  bannerHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  bannerTitle: { fontFamily: fonts.semibold, fontSize: 15, color: colors.ink },
  bannerFoot: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  bannerText: { flex: 1, fontFamily: fonts.body, fontSize: 13, color: colors.muted },
  bannerAction: { fontFamily: fonts.semibold, fontSize: 14, color: colors.orangeText },
  pickCard: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    borderWidth: 1.5,
    borderColor: colors.blueLine,
    padding: 16,
    gap: 12,
    ...shadow.card,
  },
  pickTop: { gap: 12 },
  pickHead: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingBottom: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  retry: { alignSelf: 'flex-start', marginLeft: 52 },
  staleNote: { fontFamily: fonts.body, fontSize: 13, lineHeight: 18, color: colors.amber },
  pickLabel: { fontFamily: fonts.semibold, fontSize: 15, color: colors.blue },
  storeLine: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  storeName: { fontFamily: fonts.semibold, fontSize: 17, color: colors.ink },
  pickTotal: { fontFamily: fonts.semibold, fontSize: 20, color: colors.ink },
  total: { fontFamily: fonts.semibold, fontSize: 17, color: colors.ink },
  pickFoot: { flexDirection: 'row', alignItems: 'flex-end', gap: 12 },
  onSale: { color: colors.orangeText },
  inAd: { color: colors.blue },
  rankRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  rankLabel: { fontFamily: fonts.medium, fontSize: 14, color: colors.muted },
  rankNote: { fontFamily: fonts.body, fontSize: 13, lineHeight: 18, color: colors.muted, marginTop: -4 },
  segmented: { flexDirection: 'row', backgroundColor: colors.chip, borderRadius: radius.pill, padding: 3 },
  segment: { paddingVertical: 7, paddingHorizontal: 14, borderRadius: radius.pill },
  segmentOn: { backgroundColor: colors.card, ...shadow.card },
  segmentText: { fontFamily: fonts.medium, fontSize: 14, color: colors.muted },
  segmentTextOn: { color: colors.ink },
  totals: { alignItems: 'flex-end', gap: 1 },
  pickLabelInk: { fontFamily: fonts.semibold, fontSize: 15, color: colors.ink },
  score: { gap: 6, paddingTop: 10, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  scoreRow: { gap: 1 },
  scoreName: { fontFamily: fonts.semibold, fontSize: 14, color: colors.ink },
  scoreText: { fontFamily: fonts.body, fontSize: 13, lineHeight: 18, color: colors.muted },
  shareScore: { flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start', minHeight: 44 },
  pickWhy: { fontFamily: fonts.semibold, fontSize: 14, color: colors.ink },
  card: { backgroundColor: colors.card, borderRadius: radius.lg, padding: 16, gap: 10, ...shadow.card },
  splitCard: { borderWidth: 1, borderColor: '#F7C2B3' },
  badgePair: { flexDirection: 'row', width: 58 },
  badgeOverlap: { marginLeft: -10, borderWidth: 2, borderColor: colors.card, borderRadius: 11 },
  statusLine: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  link: { flexDirection: 'row', alignItems: 'center', gap: 8, alignSelf: 'center', paddingVertical: 14 },
  linkText: { flexShrink: 1, fontFamily: fonts.medium, fontSize: 15, color: colors.muted },
  swapLine: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 32 },
  flexText: { flex: 1 },
  driveBox: { gap: 8, backgroundColor: colors.card, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, padding: 12 },
  modeBox: { gap: 8 },
  feesLine: { flexDirection: 'row', alignItems: 'flex-start', gap: 6 },
  driveHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  driveTitle: { flex: 1, fontFamily: fonts.medium, fontSize: 15, color: colors.ink },
  rateRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  rate: { minHeight: 32, justifyContent: 'center', paddingHorizontal: 10, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.line },
  rateOn: { backgroundColor: colors.pill, borderColor: colors.pill },
  rateText: { fontFamily: fonts.medium, fontSize: 13, color: colors.ink },
  rateTextOn: { color: '#ffffff' },
});
