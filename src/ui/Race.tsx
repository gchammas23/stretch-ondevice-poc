import React, { useEffect, useState } from 'react';
import { Animated, Pressable, StyleSheet, Text, View, type StyleProp, type TextStyle } from 'react-native';
import { seconds } from '../onDevice/scrapeFeed';
import { rankBaskets, type Basket, type RankBy, type TripCosts } from '../pricing/basket';
import type { PricingRun, StoreRun } from '../pricing/pricingEngine';
import { hiddenFromScreenReaders, useReduceMotion } from './a11y';
import { Icon } from './Icon';
import { brandColor, RetailerBadge } from './RetailerBadge';
import { colors, fonts, money, radius } from './theme';
import { useNow } from './useNow';

/** "3.4 seconds", as a screen reader should say a time. */
const spokenSeconds = (ms: number) => `${(Math.max(0, ms) / 1000).toFixed(1)} seconds`;

/**
 * The seconds since `from`, ticking every tenth of a second. Only this text draws again each tick, not the screen
 * around it: the phone is busy reading the stores meanwhile.
 */
export function Stopwatch({ from, style }: { from: number; style?: StyleProp<TextStyle> }) {
  const now = useNow(100);
  return <Text style={style}>{seconds(now - from)}</Text>;
}

/**
 * The race: a lane per store that fills as its prices come in, with its own stopwatch and the basket so far. Stores
 * that finish show their place.
 */
export function RaceLanes({ run, baskets, nameOf }: { run: PricingRun; baskets: Basket[]; nameOf: (retailerId: string) => string }) {
  const stores = run.retailerIds.map((id) => run.stores[id]).filter((s): s is StoreRun => !!s);
  // Places by finishing time, among stores that have finished.
  const finished = stores.filter((s) => s.status === 'done' && s.finishedAt !== undefined).sort((a, b) => a.finishedAt! - b.finishedAt!);
  return (
    <View style={styles.lanes}>
      {stores.map((s) => {
        const basket = baskets.find((b) => b.retailerId === s.retailerId);
        // Only prices read in this run: older ones shown meanwhile don't count toward the race.
        const fresh = basket?.lines.filter((l) => l.status === 'found' && !l.refreshing && !l.stale) ?? [];
        const soFar = fresh.length ? Math.round(fresh.reduce((sum, l) => sum + l.lineTotal, 0) * 100) / 100 : undefined;
        const place = finished.indexOf(s);
        return (
          <Lane
            key={s.retailerId}
            store={s}
            name={nameOf(s.retailerId)}
            total={soFar}
            place={place === -1 ? undefined : place + 1}
            start={s.startedAt ?? run.startedAt}
          />
        );
      })}
    </View>
  );
}

function Lane({ store, name, total, place, start }: { store: StoreRun; name: string; total?: number; place?: number; start: number }) {
  const progress = store.total ? store.settled / store.total : 0;
  const [width] = useState(() => new Animated.Value(progress));
  const reduceMotion = useReduceMotion();
  useEffect(() => {
    if (reduceMotion) width.setValue(progress);
    else Animated.timing(width, { toValue: progress, duration: 350, useNativeDriver: false }).start();
  }, [progress, width, reduceMotion]);
  const done = store.status === 'done';
  const took = done && store.finishedAt !== undefined ? store.finishedAt - start : undefined;
  const label = [
    `${name}: ${store.settled} of ${store.total} prices`,
    took !== undefined ? `finished${place ? ` ${ordinal(place)}` : ''}, in ${spokenSeconds(took)}` : '',
    total !== undefined ? `${money(total)} so far` : '',
  ]
    .filter(Boolean)
    .join(', ');
  return (
    <View style={styles.lane} accessible accessibilityLabel={store.stoppedBecause ? `${label}. ${store.stoppedBecause}` : label}>
      <RetailerBadge retailerId={store.retailerId} name={name} size={28} />
      <View style={styles.flex} {...hiddenFromScreenReaders}>
        <View style={styles.laneHead}>
          <Text style={styles.laneName} numberOfLines={1}>
            {name}
          </Text>
          {took !== undefined ? (
            <Text style={[styles.clock, styles.clockDone]}>
              {place ? `${ordinal(place)} · ` : ''}
              {seconds(took)}
            </Text>
          ) : store.startedAt !== undefined && !done ? (
            <Stopwatch from={start} style={styles.clock} />
          ) : (
            <Text style={styles.clock}>{seconds(0)}</Text>
          )}
        </View>
        <View style={styles.track}>
          <Animated.View
            style={[
              styles.fill,
              { backgroundColor: brandColor(store.retailerId), width: width.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] }) },
            ]}
          />
        </View>
        <Text style={styles.laneFoot}>
          {store.settled}/{store.total} prices{total !== undefined ? ` · ${money(total)} so far` : ''}
          {store.stoppedBecause ? ` · ${store.stoppedBecause}` : ''}
        </Text>
      </View>
    </View>
  );
}

const ordinal = (n: number) => `${n}${n === 1 ? 'st' : n === 2 ? 'nd' : n === 3 ? 'rd' : 'th'}`;

/**
 * The podium once every store is in: the three cheapest baskets (of the stores that got the most of the list), the
 * winner in the middle, with what it saves against the dearest and how long the phone took.
 */
export function Podium({
  baskets,
  by,
  extra,
  how,
  nameOf,
  timeMs,
  items,
  onShare,
}: {
  /** The stores in the running: those that take the order the way the user shops. */
  baskets: Basket[];
  by: RankBy;
  /** What else each store costs: driving there, and ordering online (see TripCosts). */
  extra?: TripCosts;
  /** How the totals are counted, when it isn't in store: "delivered, fees included". */
  how?: string;
  nameOf: (retailerId: string) => string;
  timeMs: number;
  /** Items on the list. */
  items: number;
  /** Opens the savings card to share. */
  onShare?: () => void;
}) {
  const complete = baskets.filter((b) => b.complete && b.found > 0);
  const most = Math.max(0, ...complete.map((b) => b.found));
  const ranked = rankBaskets(
    complete.filter((b) => b.found === most),
    by,
    extra,
  );
  if (ranked.length < 2) return null;
  const cost = (b: Basket) => (by === 'unit' ? (b.unitTotal ?? b.total) : b.total) + (extra?.[b.retailerId] ?? 0);
  const [first, second, third] = ranked;
  const priciest = ranked[ranked.length - 1];
  const saves = Math.round((cost(priciest) - cost(first)) * 100) / 100;
  const steps = [
    { basket: second, place: 2, height: 42 },
    { basket: first, place: 1, height: 64 },
    ...(third ? [{ basket: third, place: 3, height: 28 }] : []),
  ];
  // Screen readers hear the podium in order: the picture puts first place in the middle.
  const places = [first, second, third]
    .filter((b): b is Basket => !!b)
    .map((b, i) => `${ordinal(i + 1)}, ${nameOf(b.retailerId)}, ${money(cost(b))}`)
    .join('. ');
  return (
    <View style={styles.podiumCard}>
      <View style={styles.podiumHead} accessible accessibilityRole="header">
        <Icon name="star" size={16} color={colors.orange} />
        <Text style={styles.podiumTitle}>
          {nameOf(first.retailerId)} wins{saves > 0 ? `: ${money(saves)} less than ${nameOf(priciest.retailerId)}` : ''}
        </Text>
      </View>
      <Text style={styles.podiumSub}>
        {items} {items === 1 ? 'item' : 'items'} at {baskets.length} stores, read live on this phone in {seconds(timeMs)}.
        {how ? ` Totals ${how}.` : ''}
      </Text>
      <View style={styles.podium} accessible accessibilityRole="image" accessibilityLabel={places}>
        {steps.map(({ basket, place, height }) => (
          <View key={basket.retailerId} style={styles.step}>
            <RetailerBadge retailerId={basket.retailerId} name={nameOf(basket.retailerId)} size={place === 1 ? 40 : 32} />
            <Text style={styles.stepName} numberOfLines={1}>
              {nameOf(basket.retailerId)}
            </Text>
            <Text style={styles.stepTotal}>{money(cost(basket))}</Text>
            <View style={[styles.block, { height }, place === 1 && styles.blockWin]}>
              <Text style={[styles.blockText, place === 1 && styles.blockTextWin]} maxFontSizeMultiplier={1.3}>
                {place}
              </Text>
            </View>
          </View>
        ))}
      </View>
      {onShare ? (
        <Pressable
          onPress={onShare}
          accessibilityRole="button"
          accessibilityHint="Opens a picture of your savings to share"
          hitSlop={{ top: 10, bottom: 10 }}
          style={styles.share}
        >
          <Icon name="share" size={16} color={colors.orangeText} />
          <Text style={styles.shareText}>Share your savings</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, gap: 3 },
  lanes: { gap: 10 },
  lane: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  laneHead: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 },
  laneName: { flex: 1, fontFamily: fonts.semibold, fontSize: 14, color: colors.ink },
  clock: { fontFamily: fonts.medium, fontSize: 13, color: colors.muted, fontVariant: ['tabular-nums'] },
  clockDone: { color: colors.green },
  track: { height: 8, borderRadius: 4, backgroundColor: 'rgba(31, 31, 31, 0.08)', overflow: 'hidden' },
  fill: { height: 8, borderRadius: 4 },
  laneFoot: { fontFamily: fonts.body, fontSize: 12, color: colors.muted },
  podiumCard: { backgroundColor: colors.card, borderRadius: radius.lg, padding: 16, gap: 8, borderWidth: 1.5, borderColor: '#F7C2B3' },
  podiumHead: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  podiumTitle: { flex: 1, fontFamily: fonts.semibold, fontSize: 16, color: colors.ink },
  podiumSub: { fontFamily: fonts.body, fontSize: 13, lineHeight: 18, color: colors.muted },
  podium: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'center', gap: 8, marginTop: 6 },
  step: { flex: 1, alignItems: 'center', gap: 3, maxWidth: 110 },
  stepName: { fontFamily: fonts.semibold, fontSize: 13, color: colors.ink },
  stepTotal: { fontFamily: fonts.medium, fontSize: 13, color: colors.muted },
  block: { alignSelf: 'stretch', borderTopLeftRadius: 8, borderTopRightRadius: 8, backgroundColor: colors.chip, alignItems: 'center', justifyContent: 'center' },
  blockWin: { backgroundColor: colors.orange },
  blockText: { fontFamily: fonts.display, fontSize: 18, color: colors.muted },
  blockTextWin: { color: '#ffffff' },
  share: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, minHeight: 36, marginTop: 4 },
  shareText: { fontFamily: fonts.semibold, fontSize: 14, color: colors.orangeText },
});
