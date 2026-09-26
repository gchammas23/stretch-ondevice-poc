import { router } from 'expo-router';
import React, { useEffect, useRef, useSyncExternalStore } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { itemKey } from '../lists/types';
import { dayOf } from '../onDevice/adPage';
import { adDeals, adPriceWords, runsWords, type AdDeal } from '../pricing/ads';
import { couponsForItems } from '../pricing/coupons';
import { dealsFrom } from '../pricing/deals';
import { MAX_AGE_MS } from '../pricing/priceCache';
import { whenLabel } from '../pricing/receipt';
import { useApp, useCoupons, useLists, useSavingsReads, useSettings, useStoreChoices, useWatch, useWeeklyAds } from '../state/AppProvider';
import { announce } from '../ui/a11y';
import { Chip } from '../ui/bits';
import { Pill, ProductThumb, tap } from '../ui/controls';
import { Icon } from '../ui/Icon';
import { RetailerBadge } from '../ui/RetailerBadge';
import { ScreenHeader } from '../ui/ScreenHeader';
import { colors, fonts, money, radius, shadow } from '../ui/theme';
import { useNow } from '../ui/useNow';

/** Watched products' own runs, one per store, apart from any list's. */
const watchRun = (retailerId: string) => `__watch__:${retailerId}`;

/**
 * Watchlist and deals: products you're watching, with any price drop the phone has read, and everything on sale in
 * the prices it read lately at your stores.
 */
export default function WatchlistScreen() {
  const insets = useSafeAreaInsets();
  const { store, engine, cache, bundle } = useApp();
  const watch = useWatch();
  const lists = useLists();
  const choices = useStoreChoices();
  const settings = useSettings();
  const now = useNow(60_000);
  const nameOf = (id: string) => bundle.retailers.find((r) => r.id === id)?.name ?? id;
  const stores = [...new Set(watch.map((w) => w.retailerId))];
  // Re-renders as the watched stores' checks start and finish, and as prices land for the deals.
  useSyncExternalStore(engine.subscribe, () => stores.map((rid) => engine.getRun(watchRun(rid))?.finishedAt ?? (engine.getRun(watchRun(rid)) ? 'running' : 'none')).join('|'));
  useSyncExternalStore(cache.subscribe, () => cache.version);
  const checking = stores.some((rid) => engine.isRunning(watchRun(rid)));
  // Screen readers hear when a check is done.
  const wasChecking = useRef(checking);
  useEffect(() => {
    if (wasChecking.current && !checking) {
      const drops = watch.filter((w) => w.drop).length;
      announce(`Checked ${watch.length} watched ${watch.length === 1 ? 'price' : 'prices'}${drops ? `: ${drops} dropped` : ''}.`);
    }
    wasChecking.current = checking;
  });
  const checkNow = () => {
    tap();
    for (const rid of stores) {
      const choice = choices.find((c) => c.config.id === rid);
      if (!choice) continue;
      engine.start(watchRun(rid), watch.filter((w) => w.retailerId === rid).map((w) => w.name), [choice], { refresh: true });
    }
  };

  const storeKeys = Object.fromEntries(choices.map((c) => [c.config.id, c.storeKey]));
  const deals = dealsFrom(cache.list(), storeKeys, now, MAX_AGE_MS, settings.memberships);
  const listItems = new Map(lists.flatMap((l) => l.items.map((i) => [itemKey(i), i.name] as const)));
  const onLists = deals.filter((d) => listItems.has(d.query));
  const others = deals.filter((d) => !listItems.has(d.query)).slice(0, 30);
  // This week's ads and the accounts' coupons, read on the phone from each store's own site.
  useSavingsReads(true);
  const ads = useWeeklyAds();
  const couponLists = useCoupons();
  const today = dayOf(now);
  const inAds = adDeals(lists, ads, today);
  const couponRows = choices.flatMap((c) => couponsForItems(lists, couponLists[c.config.id], today).map((x) => ({ ...x, retailerId: c.config.id })));
  const adsRead = choices.filter((c) => ads[c.config.id]).length;
  const withAds = choices.filter((c) => c.config.ad).length;

  return (
    <View style={styles.screen}>
      <ScreenHeader title="Watchlist and deals" subtitle="Price drops the phone has seen, and what’s on sale at your stores." />
      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 32 }]}>
        <Pressable
          accessibilityRole="button"
          accessibilityHint="Opens each store’s weekly ad and your coupons"
          onPress={() => router.push('/ads')}
          style={({ pressed }) => [styles.card, styles.adsLink, pressed && styles.pressed]}
        >
          <Icon name="star" size={20} color={colors.blue} />
          <View style={styles.flex}>
            <Text style={styles.name}>Weekly ads and coupons</Text>
            <Text style={styles.small}>
              {withAds ? `${adsRead} of ${withAds} stores’ ads read` : 'None of your stores has a weekly ad'}
              {inAds.length ? ` · ${inAds.length} of your items in them` : ''}
              {couponRows.length ? ` · ${couponRows.length} ${couponRows.length === 1 ? 'coupon' : 'coupons'} for your lists` : ''}
            </Text>
          </View>
          <Icon name="forward" size={18} color={colors.faint} />
        </Pressable>
        <Text style={styles.section} accessibilityRole="header">
          Watching
        </Text>
        {watch.length ? (
          <>
            {watch.map((w) => (
              <View key={`${w.retailerId}|${w.productId}`} style={styles.card}>
                <View style={styles.row}>
                  <ProductThumb product={{ retailer: w.retailerId, storeId: '', id: w.productId, name: w.name, price: w.lastPrice, imageUrl: w.imageUrl }} size={52} />
                  <View style={styles.flex}>
                    <Text style={styles.name} numberOfLines={2}>
                      {w.name}
                    </Text>
                    <View style={styles.storeRow}>
                      <RetailerBadge retailerId={w.retailerId} name={nameOf(w.retailerId)} size={18} />
                      <Text style={styles.small}>
                        {nameOf(w.retailerId)} · read {whenLabel(w.lastAt, now)}
                      </Text>
                    </View>
                    {w.drop ? (
                      <Chip label={`Dropped ${money(w.drop.from - w.drop.to)} ${whenLabel(w.drop.at, now)}`} icon="arrowDown" tone="green" />
                    ) : w.lastPrice !== w.addedPrice ? (
                      <Text style={styles.small}>
                        {w.lastPrice < w.addedPrice ? 'Down' : 'Up'} from {money(w.addedPrice)} when you started watching
                      </Text>
                    ) : null}
                  </View>
                  <View style={styles.right}>
                    <Text style={styles.price}>{money(w.lastPrice)}</Text>
                    <Pressable accessibilityRole="button" accessibilityLabel={`Stop watching ${w.name}`} onPress={() => store.unwatch(w.retailerId, w.productId)} hitSlop={{ top: 12, bottom: 12, left: 10, right: 10 }}>
                      <Text style={styles.stop}>Stop</Text>
                    </Pressable>
                  </View>
                </View>
              </View>
            ))}
            <Pill
              label={checking ? 'Checking…' : 'Check watched prices now'}
              icon="refresh"
              small
              variant="dark"
              busy={checking}
              onPress={checkNow}
              style={styles.alignStart}
            />
            <Text style={styles.hint}>
              Watched prices are also checked whenever the phone reads them for a list. Only while the app is open: the phone doesn’t search in the background.
            </Text>
          </>
        ) : (
          <Text style={styles.small}>Nothing yet. Open a product and tap Watch the price.</Text>
        )}

        <Text style={styles.section} accessibilityRole="header">
          On sale on your lists
        </Text>
        {onLists.length ? onLists.map((d) => <DealRow key={`${d.retailerId}|${d.product.id}`} deal={d} storeName={nameOf(d.retailerId)} itemName={listItems.get(d.query)} now={now} />) : (
          <Text style={styles.small}>Nothing on your lists is on sale in the prices read lately.</Text>
        )}

        <Text style={styles.section} accessibilityRole="header">
          In this week’s ads
        </Text>
        {inAds.length ? (
          inAds.map((d) => <AdRow key={`${d.retailerId}|${d.itemName}`} deal={d} storeName={nameOf(d.retailerId)} />)
        ) : (
          <Text style={styles.small}>
            {adsRead ? 'None of your lists’ items is in your stores’ weekly ads.' : 'No weekly ad read yet: they’re read on this phone, at most once a day per store.'}
          </Text>
        )}

        {couponRows.length ? (
          <>
            <Text style={styles.section} accessibilityRole="header">
              Coupons for your lists
            </Text>
            {couponRows.map(({ retailerId, itemName, coupon }) => (
              <Pressable
                key={`${retailerId}|${coupon.id}`}
                accessibilityRole="button"
                accessibilityHint="Opens weekly ads and coupons"
                onPress={() => router.push('/ads')}
                style={({ pressed }) => [styles.card, pressed && styles.pressed]}
              >
                <View style={styles.row}>
                  <RetailerBadge retailerId={retailerId} name={nameOf(retailerId)} size={36} />
                  <View style={styles.flex}>
                    <Text style={styles.name}>
                      {itemName} · {coupon.value}
                    </Text>
                    <Text style={styles.small} numberOfLines={2}>
                      {nameOf(retailerId)} · {coupon.clipped ? 'clipped' : 'not clipped'} · {coupon.title}
                    </Text>
                  </View>
                </View>
              </Pressable>
            ))}
          </>
        ) : null}

        {others.length ? (
          <>
            <Text style={styles.section} accessibilityRole="header">
              Other deals the phone has seen
            </Text>
            {others.map((d) => (
              <DealRow key={`${d.retailerId}|${d.product.id}`} deal={d} storeName={nameOf(d.retailerId)} now={now} />
            ))}
          </>
        ) : null}
        {checking ? <ActivityIndicator color={colors.orange} /> : null}
      </ScrollView>
    </View>
  );
}

/** A list's item in a store's weekly ad: tapping checks it at every store. */
function AdRow({ deal, storeName }: { deal: AdDeal; storeName: string }) {
  const when = runsWords(deal.from, deal.to);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityHint="Checks this at every store"
      onPress={() => router.push({ pathname: '/search', params: { q: deal.itemName } })}
      style={({ pressed }) => [styles.card, pressed && styles.pressed]}
    >
      <View style={styles.row}>
        <RetailerBadge retailerId={deal.retailerId} name={storeName} size={36} />
        <View style={styles.flex}>
          <Text style={styles.name}>
            {deal.itemName} · {adPriceWords(deal.item)}
          </Text>
          <Text style={styles.small} numberOfLines={2}>
            {storeName}’s weekly ad · {deal.item.name}
            {when ? ` · ${when}` : ''}
          </Text>
        </View>
        <Chip label="In this week’s ad" icon="star" tone="blue" />
      </View>
    </Pressable>
  );
}

function DealRow({ deal, storeName, itemName, now }: { deal: ReturnType<typeof dealsFrom>[number]; storeName: string; itemName?: string; now: number }) {
  const p = deal.product;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityHint="Checks this at every store"
      onPress={() => router.push({ pathname: '/search', params: { q: itemName ?? deal.query } })}
      style={({ pressed }) => [styles.card, pressed && styles.pressed]}
    >
      <View style={styles.row}>
        <ProductThumb product={p} size={52} />
        <View style={styles.flex}>
          <Text style={styles.name} numberOfLines={2}>
            {p.name}
          </Text>
          <Text style={styles.small}>
            {storeName}
            {itemName ? ` · for ${itemName}` : ''} · read {whenLabel(deal.at, now)}
          </Text>
        </View>
        <View style={styles.right}>
          <Text style={styles.price}>{money(p.price!)}</Text>
          <Text style={styles.was} accessibilityLabel={`was ${money(p.wasPrice!)}`}>
            {money(p.wasPrice!)}
          </Text>
          <Chip label={`−${Math.round(deal.percent * 100)}%`} spoken={`${Math.round(deal.percent * 100)}% off`} tone="orange" />
        </View>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.paper },
  content: { paddingHorizontal: 16, gap: 10 },
  flex: { flex: 1, gap: 4 },
  alignStart: { alignSelf: 'flex-start' },
  pressed: { opacity: 0.85 },
  section: { fontFamily: fonts.semibold, fontSize: 13, letterSpacing: 0.6, textTransform: 'uppercase', color: colors.muted, marginTop: 12 },
  card: { backgroundColor: colors.card, borderRadius: radius.lg, padding: 12, ...shadow.card },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  storeRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  right: { alignItems: 'flex-end', gap: 4 },
  name: { fontFamily: fonts.medium, fontSize: 15, lineHeight: 20, color: colors.ink },
  small: { flexShrink: 1, fontFamily: fonts.body, fontSize: 13, lineHeight: 18, color: colors.muted },
  hint: { fontFamily: fonts.body, fontSize: 13, lineHeight: 18, color: colors.muted },
  price: { fontFamily: fonts.semibold, fontSize: 17, color: colors.ink },
  was: { fontFamily: fonts.body, fontSize: 13, color: colors.muted, textDecorationLine: 'line-through' },
  stop: { fontFamily: fonts.semibold, fontSize: 14, color: colors.orangeText },
  adsLink: { flexDirection: 'row', alignItems: 'center', gap: 12 },
});
