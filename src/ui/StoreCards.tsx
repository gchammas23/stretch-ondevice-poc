import React from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Switch, Text, useWindowDimensions, View } from 'react-native';
import { ago, type Staleness } from '../pricing/age';
import type { Basket, DriveVerdict, RankBy, SplitTrip } from '../pricing/basket';
import { couponsFitting, type CouponCredit } from '../pricing/coupons';
import { dollars, feesSummary, MODE_WORDS, type OnlineCost, type ShopMode } from '../pricing/onlineCost';
import type { StoreRun } from '../pricing/pricingEngine';
import type { Settings } from '../state/appStore';
import { milesText } from '../state/storeInfo';
import { Chip } from './bits';
import { Pill } from './controls';
import { Icon } from './Icon';
import { RetailerBadge } from './RetailerBadge';
import { colors, fonts, money, radius, shadow } from './theme';
import { useNow } from './useNow';

// Find a store's cards: Stretch's pick, a split trip, each other store, and the rows that change how they're ranked
// (driving, how the totals count).

export function PickCard({
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

export function SplitCard({ split, names, mode, onOpen }: { split: SplitTrip; names: string[]; mode: ShopMode; onOpen: () => void }) {
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

export function StoreRow({
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
  // Cooling down after a block: its searches wait for its retry time, and are tried again then, by themselves.
  const cooling = !!s?.retryAt && s.retryAt > now;
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
      <Text
        style={[styles.small, cooling ? { color: colors.amber } : basket.failed ? { color: colors.red } : stale.notRefreshed ? { color: colors.amber } : null]}
        numberOfLines={lines(cooling ? 3 : 2)}
      >
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
  const canRetry = s?.status === 'done' && !cooling && (basket.failed > 0 || stale.notRefreshed > 0);
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
export function DriveRow({ drive, onChange, unknown }: { drive: Settings['drive']; onChange: (d: Partial<Settings['drive']>) => void; unknown: string[] }) {
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
export function verdictText(verdict: DriveVerdict, nameOf: (rid: string) => string, mode: ShopMode): string | undefined {
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
export function feesVerdictText(verdict: DriveVerdict, nameOf: (rid: string) => string, mode: ShopMode, online?: Record<string, OnlineCost>): string | undefined {
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

export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
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

/** Under a same-sizes total, what the basket costs as sold, when that's different. */
const asSold = (total: number, asSoldTotal: number, by: RankBy) => by === 'unit' && money(total) !== money(asSoldTotal);

const styles = StyleSheet.create({
  flex: { flex: 1, gap: 3 },
  pressed: { opacity: 0.85 },
  small: { fontFamily: fonts.body, fontSize: 14, lineHeight: 19, color: colors.muted },
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
  segmented: { flexDirection: 'row', backgroundColor: colors.chip, borderRadius: radius.pill, padding: 3 },
  segment: { paddingVertical: 7, paddingHorizontal: 14, borderRadius: radius.pill },
  segmentOn: { backgroundColor: colors.card, ...shadow.card },
  segmentText: { fontFamily: fonts.medium, fontSize: 14, color: colors.muted },
  segmentTextOn: { color: colors.ink },
  totals: { alignItems: 'flex-end', gap: 1 },
  pickWhy: { fontFamily: fonts.semibold, fontSize: 14, color: colors.ink },
  card: { backgroundColor: colors.card, borderRadius: radius.lg, padding: 16, gap: 10, ...shadow.card },
  splitCard: { borderWidth: 1, borderColor: '#F7C2B3' },
  badgePair: { flexDirection: 'row', width: 58 },
  badgeOverlap: { marginLeft: -10, borderWidth: 2, borderColor: colors.card, borderRadius: 11 },
  statusLine: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  swapLine: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 32 },
  flexText: { flex: 1 },
  driveBox: { gap: 8, backgroundColor: colors.card, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, padding: 12 },
  feesLine: { flexDirection: 'row', alignItems: 'flex-start', gap: 6 },
  driveHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  driveTitle: { flex: 1, fontFamily: fonts.medium, fontSize: 15, color: colors.ink },
  rateRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  rate: { minHeight: 32, justifyContent: 'center', paddingHorizontal: 10, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.line },
  rateOn: { backgroundColor: colors.pill, borderColor: colors.pill },
  rateText: { fontFamily: fonts.medium, fontSize: 13, color: colors.ink },
  rateTextOn: { color: '#ffffff' },
});
