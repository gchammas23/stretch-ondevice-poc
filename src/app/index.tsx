import { router } from 'expo-router';
import React, { useSyncExternalStore } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { GroceryList } from '../lists/types';
import { dayOf } from '../onDevice/adPage';
import { adDeals } from '../pricing/ads';
import { dealsFrom } from '../pricing/deals';
import { MAX_AGE_MS } from '../pricing/priceCache';
import { whenLabel } from '../pricing/receipt';
import { MODE_WORDS } from '../pricing/onlineCost';
import { jobStatus } from '../cloud/jobs';
import { jobNotice } from '../cloud/words';
import { useApp, useAppState, useComparison, useLists, usePricingRun, useStoreChoices, useStoreName, useTrips, useWatch, useWeeklyAds } from '../state/AppProvider';
import { useCloudJobs } from '../state/CloudProvider';
import { hiddenFromScreenReaders } from '../ui/a11y';
import { IconButton, Pill } from '../ui/controls';
import { Icon } from '../ui/Icon';
import { colors, fonts, money, radius, shadow } from '../ui/theme';
import { useNow } from '../ui/useNow';

export default function ListsScreen() {
  const insets = useSafeAreaInsets();
  const lists = useLists();
  const { store } = useApp();
  const cloudOn = useAppState((s) => s.settings.cloud.on);

  const newList = () => {
    const id = store.createList();
    router.push(`/list/${id}?rename=1`);
  };

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={[styles.content, { paddingTop: insets.top + 6, paddingBottom: insets.bottom + 32 }]}
    >
      <View style={styles.top}>
        <Text style={styles.wordmark} accessibilityRole="header">
          Stretch
        </Text>
        <View style={styles.topActions}>
          <IconButton name="zap" label="Presenter mode: a one-minute live demo" onPress={() => router.push('/present')} />
          <IconButton name="store" label="Your stores" onPress={() => router.push('/stores')} />
          <IconButton name="activity" label="Diagnostics" onPress={() => router.push('/diagnostics')} />
        </View>
      </View>
      <Text style={styles.tagline}>Don’t grocery alone.</Text>
      <Text style={styles.script}>Let Stretch do the hard part.</Text>

      <View style={styles.searchRow}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Check a price at every store"
          accessibilityHint="Opens price check"
          onPress={() => router.push('/search')}
          style={({ pressed }) => [styles.searchBar, pressed && styles.pressed]}
        >
          <Icon name="search" size={20} color={colors.muted} />
          <Text style={styles.searchText}>Check a price at every store</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Scan a barcode"
          onPress={() => router.push('/scan')}
          style={({ pressed }) => [styles.scan, pressed && styles.pressed]}
        >
          <Icon name="scan" size={22} color="#ffffff" />
        </Pressable>
      </View>

      <CloudCard />
      <Savings />
      <WatchCard />

      <Text style={styles.section} accessibilityRole="header">
        Your lists
      </Text>
      {lists.map((list) => (
        <ListCard key={list.id} list={list} />
      ))}
      {!lists.length ? <Text style={styles.empty}>No lists yet. Start one and add what you need.</Text> : null}
      <Pill label="New list" icon="plus" variant="outline" onPress={newList} style={styles.newList} />

      <View style={styles.note}>
        <Icon name="phone" size={18} color={colors.muted} />
        <Text style={styles.noteText}>
          {cloudOn
            ? 'Prices are read live, straight from each store’s own website: on this phone while your lists are open, and Walmart’s and Target’s in Browser Use’s cloud browsers when you ask.'
            : 'Prices are read live on this phone, straight from each store’s own website, while your lists are open.'}
        </Text>
      </View>
      <View style={styles.links}>
        <Pressable accessibilityRole="link" onPress={() => router.push('/health')} hitSlop={LINK_SLOP}>
          <Text style={styles.link}>Store health</Text>
        </Pressable>
        <Text style={styles.linkDot} {...hiddenFromScreenReaders}>
          ·
        </Text>
        <Pressable accessibilityRole="link" onPress={() => router.push('/privacy')} hitSlop={LINK_SLOP}>
          <Text style={styles.link}>What stays on this phone</Text>
        </Pressable>
      </View>
    </ScrollView>
  );
}

/** While cloud fetch is on: its latest search, and a way to the rest. Off, there's no card. */
function CloudCard() {
  const on = useAppState((s) => s.settings.cloud.on);
  const jobs = useCloudJobs();
  if (!on) return null;
  const running = jobs.filter((j) => jobStatus(j) === 'running');
  const last = jobs[0];
  const detail = running.length
    ? `${running.length} cloud ${running.length === 1 ? 'search' : 'searches'} running: ${running.map((j) => j.terms.join(', ')).join('; ')}`
    : last
      ? `Last: ${last.terms.join(', ')} · ${jobNotice(last).body}`
      : 'Walmart and Target are searched in the cloud: start one from Price check or a list.';
  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => router.push(running.length === 1 ? `/cloud/${running[0].id}` : '/cloud')}
      style={({ pressed }) => [styles.watch, pressed && styles.pressed]}
    >
      <Icon name="cloud" size={20} color={colors.blue} />
      <View style={styles.cardText}>
        <Text style={styles.watchTitle}>Cloud fetch is on</Text>
        <Text style={styles.cardMeta} numberOfLines={3}>
          {detail}
        </Text>
      </View>
      <Icon name="forward" color={colors.faint} />
    </Pressable>
  );
}

/** Watched prices that dropped, and what's on sale at your stores, from what the phone has read. */
function WatchCard() {
  const { cache } = useApp();
  const watch = useWatch();
  const choices = useStoreChoices();
  const now = useNow(60_000);
  useSyncExternalStore(cache.subscribe, () => cache.version);
  const drops = watch.filter((w) => w.drop).length;
  const storeKeys = Object.fromEntries(choices.map((c) => [c.config.id, c.storeKey]));
  const memberships = useAppState((s) => s.settings.memberships);
  const deals = dealsFrom(cache.list(), storeKeys, now, MAX_AGE_MS, memberships).length;
  // The lists' items in the weekly ads the phone has read (nothing is read from here: not at app launch).
  const lists = useLists();
  const ads = useWeeklyAds();
  const inAds = adDeals(lists, ads, dayOf(now)).length;
  if (!watch.length && !deals && !inAds) return null;
  const parts = [
    drops ? `${drops} price ${drops === 1 ? 'drop' : 'drops'}` : watch.length ? `Watching ${watch.length}` : '',
    deals ? `${deals} on sale at your stores` : '',
    inAds ? `${inAds} in this week’s ads` : '',
  ].filter(Boolean);
  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => router.push('/watchlist')}
      style={({ pressed }) => [styles.watch, drops > 0 && styles.watchNews, pressed && styles.pressed]}
    >
      <Icon name={drops ? 'arrowDown' : 'tag'} size={20} color={drops ? colors.green : colors.orange} />
      <View style={styles.cardText}>
        <Text style={styles.watchTitle}>Watchlist and deals</Text>
        <Text style={styles.cardMeta}>{parts.join(' · ')}</Text>
      </View>
      <Icon name="forward" color={colors.faint} />
    </Pressable>
  );
}

/** The savings tracker: what trips at Stretch's pick saved against the next-cheapest store for the same items. */
function Savings() {
  const { fontScale } = useWindowDimensions();
  const trips = useTrips();
  const now = useNow(60_000);
  const nameOf = useStoreName();
  if (!trips.length) {
    return (
      <View style={[styles.savings, styles.savingsEmpty]}>
        <Icon name="tag" size={18} color={colors.orange} />
        <Text style={styles.noteText}>Your savings add up here. Shop at Stretch’s pick, then tap Done shopping.</Text>
      </View>
    );
  }
  const total = trips.reduce((n, t) => n + (t.saved?.amount ?? 0), 0);
  const last = trips[0];
  // Read as one summary.
  return (
    <View style={styles.savings} accessible accessibilityRole="summary">
      <Text style={styles.savingsLabel}>Saved with Stretch</Text>
      <Text style={styles.savingsTotal}>{money(total)}</Text>
      <Text style={styles.noteText}>
        {trips.length === 1 ? '1 trip, compared' : `${trips.length} trips, each compared`} with the next-cheapest store for the same items.
      </Text>
      <Text style={styles.savingsLast} numberOfLines={fontScale > 1.3 ? undefined : 2}>
        Last: {last.listName} at {last.retailerIds.map(nameOf).join(' + ')}, {whenLabel(last.endedAt, now)}
        {last.saved ? `, ${money(last.saved.amount)} less than ${nameOf(last.saved.retailerId)}` : ''}
      </Text>
    </View>
  );
}

function ListCard({ list }: { list: GroceryList }) {
  const run = usePricingRun(list.id);
  const { pick, running, mode, orderTotal, countCoupons, coupons } = useComparison(list, run);
  const nameOf = useStoreName();

  let detail: string | null = null;
  if (list.trip) detail = `Shopping at ${list.trip.retailerIds.map(nameOf).join(' + ')}`;
  else if (pick) {
    const withCoupons = countCoupons && coupons[pick.retailerId]?.amount ? ' with coupons' : '';
    detail = `${running ? 'Best so far' : 'Stretch’s pick'}: ${nameOf(pick.retailerId)} ${money(orderTotal(pick))}${mode === 'store' ? '' : ` ${MODE_WORDS[mode]}`}${withCoupons}`;
  }

  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => router.push(`/list/${list.id}`)}
      style={({ pressed }) => [styles.card, pressed && styles.pressed]}
    >
      <View style={styles.cardText}>
        <Text style={styles.cardTitle} numberOfLines={1}>
          {list.name}
        </Text>
        <Text style={styles.cardMeta}>
          {list.items.length} {list.items.length === 1 ? 'item' : 'items'}
        </Text>
        {detail ? (
          <View style={styles.detailRow}>
            <Icon name={list.trip ? 'cart' : 'sparkle'} size={14} color={list.trip ? colors.orange : colors.blue} />
            <Text style={[styles.cardDetail, list.trip && { color: colors.orangeText }]}>{detail}</Text>
          </View>
        ) : null}
      </View>
      <Icon name="forward" color={colors.faint} />
    </Pressable>
  );
}

/** The text links reach 44 pt to touch. */
const LINK_SLOP = { top: 14, bottom: 14, left: 8, right: 8 };

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.cream },
  content: { paddingHorizontal: 20, gap: 12 },
  top: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  topActions: { flexDirection: 'row', gap: 2, marginRight: -8 },
  wordmark: { fontFamily: fonts.display, fontSize: 30, color: colors.ink },
  tagline: { fontFamily: fonts.display, fontSize: 36, lineHeight: 42, color: colors.ink, marginTop: 18 },
  script: { fontFamily: fonts.script, fontSize: 30, color: colors.orangeText, marginTop: -8, transform: [{ rotate: '-2deg' }] },
  section: { fontFamily: fonts.semibold, fontSize: 13, letterSpacing: 0.8, textTransform: 'uppercase', color: colors.muted, marginTop: 20 },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    padding: 18,
    ...shadow.card,
  },
  pressed: { opacity: 0.8 },
  cardText: { flex: 1, gap: 4 },
  cardTitle: { fontFamily: fonts.display, fontSize: 23, color: colors.ink },
  cardMeta: { fontFamily: fonts.body, fontSize: 15, color: colors.muted },
  detailRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 2 },
  cardDetail: { fontFamily: fonts.medium, fontSize: 14, color: colors.blue },
  empty: { fontFamily: fonts.body, fontSize: 15, color: colors.muted },
  newList: { alignSelf: 'flex-start', marginTop: 4 },
  note: { flexDirection: 'row', gap: 10, alignItems: 'flex-start', marginTop: 28, paddingRight: 12 },
  noteText: { flex: 1, fontFamily: fonts.body, fontSize: 14, lineHeight: 20, color: colors.muted },
  searchRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 18 },
  searchBar: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: colors.card,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.line,
    paddingHorizontal: 16,
    minHeight: 52,
    ...shadow.card,
  },
  searchText: { flex: 1, fontFamily: fonts.body, fontSize: 16, color: colors.muted },
  scan: { width: 52, height: 52, borderRadius: 26, backgroundColor: colors.orange, alignItems: 'center', justifyContent: 'center', ...shadow.card },
  watch: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: colors.card, borderRadius: radius.lg, padding: 16, marginTop: 10, ...shadow.card },
  watchNews: { borderWidth: 1.5, borderColor: '#A8DDBE' },
  watchTitle: { fontFamily: fonts.semibold, fontSize: 16, color: colors.ink },
  links: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', flexWrap: 'wrap', gap: 8, marginTop: 8 },
  link: { fontFamily: fonts.medium, fontSize: 14, color: colors.muted, textDecorationLine: 'underline' },
  linkDot: { color: colors.faint },
  savings: { backgroundColor: colors.blush, borderRadius: radius.lg, padding: 18, gap: 4, marginTop: 18 },
  savingsEmpty: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: colors.orangeTint, paddingVertical: 14 },
  savingsLabel: { fontFamily: fonts.semibold, fontSize: 13, letterSpacing: 0.8, textTransform: 'uppercase', color: '#8A4B3A' },
  savingsTotal: { fontFamily: fonts.display, fontSize: 40, lineHeight: 46, color: colors.ink },
  savingsLast: { fontFamily: fonts.medium, fontSize: 14, lineHeight: 19, color: colors.ink, marginTop: 4 },
});
