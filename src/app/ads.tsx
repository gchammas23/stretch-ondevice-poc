import { router } from 'expo-router';
import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { dayOf } from '../onDevice/adPage';
import { adDeals, adPriceWords, adStatusWords, adTarget, runsWords } from '../pricing/ads';
import { couponsForItems, couponStatusWords, couponTarget } from '../pricing/coupons';
import { reasonWords } from '../onDevice/scrapeFeed';
import type { StoreChoice } from '../pricing/pricingEngine';
import { hostOf } from '../pricing/receipt';
import { useAdBook, useApp, useCouponBook, useLists, useSavingsReads, useSettings, useStoreChoices, useWeeklyAds } from '../state/AppProvider';
import { announce } from '../ui/a11y';
import { Pill, tap } from '../ui/controls';
import { Icon } from '../ui/Icon';
import { RetailerBadge } from '../ui/RetailerBadge';
import { ScreenHeader } from '../ui/ScreenHeader';
import { colors, fonts, radius, shadow } from '../ui/theme';
import { useNow } from '../ui/useNow';

/** Items of an ad, or coupons, shown for a store before "and N more". */
const SHOWN = 5;

/**
 * Weekly ads and coupons: each compared store's weekly ad as the phone read it from the store's own site, and the
 * digital coupons of the account signed in to it here, which of them are clipped, and whether clipped ones count in
 * totals. Nothing is clipped unless the user taps Clip.
 */
export default function AdsScreen() {
  const insets = useSafeAreaInsets();
  const { store } = useApp();
  const settings = useSettings();
  const choices = useStoreChoices();
  // The ads and coupons that are due are read while this shows.
  useSavingsReads(true);

  return (
    <View style={styles.screen}>
      <ScreenHeader title="Weekly ads and coupons" subtitle="Read on this phone, from each store’s own site." />
      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 32 }]}>
        <View style={styles.card}>
          <View style={styles.row}>
            <Icon name="tag" size={18} color={colors.green} />
            <Text style={styles.title}>Count clipped coupons in totals</Text>
            <Switch
              value={settings.countCoupons}
              onValueChange={(on) => {
                tap();
                store.setCountCoupons(on);
              }}
              trackColor={{ true: colors.orange, false: colors.faint }}
              thumbColor="#FFFFFF"
              accessibilityLabel="Count clipped coupons in totals"
            />
          </View>
          <Text style={styles.small}>
            {settings.countCoupons
              ? 'On: each store’s total takes off the clipped coupons that fit your list, and says “with coupons”. Stores are ranked by that.'
              : 'Off: coupons show beside prices, and totals are the stores’ own prices.'}{' '}
            Coupons you haven’t clipped never count: they don’t come off at checkout.
          </Text>
        </View>
        {choices.map((choice) => (
          <StoreSavings key={choice.config.id} choice={choice} />
        ))}
        {!choices.length ? <Text style={styles.small}>No stores are switched on. Choose them in Your stores.</Text> : null}
        <Text style={styles.note}>
          Each store’s ad is read at most once a day, hidden, one page at a time, and each read counts toward the store’s hourly limit. Coupons
          are read only for the stores you signed in to here, from their own pages, and stay on this phone. Nothing is clipped unless you tap Clip.
        </Text>
      </ScrollView>
    </View>
  );
}

/** One store: its weekly ad, and its coupons for the account signed in to it here. */
function StoreSavings({ choice }: { choice: StoreChoice }) {
  const { config } = choice;
  const { checkAds, checkCoupons, clipCoupons, viewCoupons, signInAt } = useApp();
  const settings = useSettings();
  const lists = useLists();
  const adBook = useAdBook();
  const couponBook = useCouponBook();
  const ads = useWeeklyAds();
  const now = useNow(60_000);
  const today = dayOf(now);
  const [message, setMessage] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  // One round of clips at a time: a second tap meanwhile would clip the same coupons again, each a page load.
  const [clipping, setClipping] = useState(false);
  const clipRound = useRef(false);
  const [viewing, setViewing] = useState(false);
  const site = hostOf(config.homeUrl).replace(/^www\./, '');

  const adAt = adTarget(config, choice, settings.zip);
  const adRead = adBook.get(config.id);
  const readingAd = adBook.reading === config.id;
  const ad = ads[config.id];
  const onLists = ad ? adDeals(lists, { [config.id]: ad }, today) : [];
  const mine = adAt && !('needs' in adAt) && adRead?.key === adAt.key ? adRead : undefined;
  // Read today and it worked: not again until tomorrow. A read that failed can be tried again now. The button stays
  // while its read runs, busy, so the screen reader's place isn't lost.
  const canAsk = !!adAt && !('needs' in adAt) && (!mine || !mine.ok);

  const couponAt = couponTarget(config, settings.signedInAt[config.id]);
  const couponRead = couponBook.get(config.id);
  const readingCoupons = couponBook.reading === config.id;
  const coupons = couponAt && !('needs' in couponAt) && couponRead?.key === couponAt.key ? couponRead.value?.coupons : undefined;
  const forLists = couponsForItems(lists, coupons, today);
  const toClip = forLists.filter((x) => !x.coupon.clipped);

  const clip = async (ids: string[]) => {
    if (clipRound.current) return;
    clipRound.current = true;
    setClipping(true);
    tap();
    setMessage(null);
    try {
      const got = await clipCoupons(config.id, ids);
      const text = got.failed.length
        ? `${got.clipped ? `Clipped ${got.clipped}. ` : ''}Couldn’t clip ${got.failed.length === 1 ? 'one' : got.failed.length} here (${reasonWords(got.reason)}): it’s being checked again, or clip it on ${site}.`
        : `Clipped ${got.clipped} ${got.clipped === 1 ? 'coupon' : 'coupons'} to your ${config.name} account.`;
      setMessage(text);
      announce(text);
    } finally {
      clipRound.current = false;
      setClipping(false);
    }
  };
  const view = async () => {
    setViewing(true);
    try {
      await viewCoupons(config.id);
    } catch {
      // Left open until its page gave up: nothing changed, and the card says where the coupons stand.
    } finally {
      setViewing(false);
    }
  };

  // Reads end out of sight of VoiceOver: each is said when it's done, as the card words it.
  const wasReadingAd = useRef(readingAd);
  const wasReadingCoupons = useRef(readingCoupons);
  useEffect(() => {
    if (wasReadingAd.current && !readingAd) announce(adStatusWords(config, adAt, adRead, false, now));
    if (wasReadingCoupons.current && !readingCoupons) announce(couponStatusWords(config, couponAt, couponRead, false, now));
    wasReadingAd.current = readingAd;
    wasReadingCoupons.current = readingCoupons;
  });
  const signIn = async () => {
    setSigningIn(true);
    try {
      await signInAt(config.id);
    } catch {
      // Left open until its page gave up: the card says where the account stands.
    } finally {
      setSigningIn(false);
    }
  };

  return (
    <View style={styles.card}>
      <View style={styles.row}>
        <RetailerBadge retailerId={config.id} name={config.name} size={36} />
        <Text style={styles.store} accessibilityRole="header">
          {config.name}
        </Text>
      </View>

      <Text style={styles.part} accessibilityRole="header">
        Weekly ad
      </Text>
      <Text style={styles.small}>{adStatusWords(config, adAt, adRead, readingAd, now)}</Text>
      {config.ad?.note ? <Text style={styles.small}>{capital(config.ad.note)}.</Text> : null}
      {readingAd ? <ActivityIndicator color={colors.orange} style={styles.alignStart} /> : null}
      {onLists.slice(0, SHOWN).map((d) => (
        <AdRow key={`${d.itemName}|${d.item.id}`} itemName={d.itemName} name={d.item.name} deal={adPriceWords(d.item)} when={runsWords(d.from, d.to)} />
      ))}
      {onLists.length > SHOWN ? <Text style={styles.small}>And {onLists.length - SHOWN} more of your items.</Text> : null}
      {ad && !onLists.length ? <Text style={styles.small}>None of your lists’ items is in it.</Text> : null}
      {canAsk ? (
        <Pill
          label={mine ? 'Try again' : 'Read it now'}
          accessibilityLabel={`${mine ? 'Try again' : 'Read it now'}: ${config.name}’s weekly ad`}
          icon="refresh"
          small
          variant="outline"
          busy={readingAd}
          onPress={() => void checkAds(true, [config.id])}
          style={styles.alignStart}
        />
      ) : null}

      {config.coupons ? (
        <>
          <Text style={styles.part} accessibilityRole="header">
            {capital(config.coupons.program)}
          </Text>
          <Text style={styles.small}>{couponStatusWords(config, couponAt, couponRead, readingCoupons, now)}</Text>
          {readingCoupons ? <ActivityIndicator color={colors.green} style={styles.alignStart} /> : null}
          {forLists.slice(0, SHOWN).map(({ itemName, coupon }) => (
            <View key={coupon.id} style={styles.itemRow}>
              <View style={styles.flex}>
                <Text style={styles.item}>
                  {itemName} <Text style={styles.small}>· {coupon.value}</Text>
                </Text>
                <Text style={styles.small} numberOfLines={2}>
                  {coupon.title}
                  {coupon.expires ? ` · until ${runsWords(undefined, coupon.expires).replace(/^through /, '')}` : ''}
                </Text>
              </View>
              {coupon.clipped ? (
                <Text style={styles.clipped}>{coupon.clippedAt ? 'Clipped here' : 'Clipped'}</Text>
              ) : couponBook.marked(`${config.id}|${coupon.id}`) ? (
                <ActivityIndicator color={colors.green} accessibilityLabel={`Clipping the coupon for ${itemName}`} />
              ) : (
                <Pressable
                  onPress={() => void clip([coupon.id])}
                  disabled={clipping}
                  hitSlop={{ top: 12, bottom: 12, left: 8, right: 8 }}
                  accessibilityRole="button"
                  accessibilityLabel={`Clip the coupon for ${itemName}: ${coupon.value}`}
                  accessibilityHint={`Clips it to your ${config.name} account, on ${config.name}’s own page`}
                  accessibilityState={{ disabled: clipping }}
                >
                  <Text style={[styles.clip, clipping && styles.clipWaiting]}>Clip</Text>
                </Pressable>
              )}
            </View>
          ))}
          {forLists.length > SHOWN ? <Text style={styles.small}>And {forLists.length - SHOWN} more for your items, in your basket at {config.name}.</Text> : null}
          {coupons && !forLists.length ? <Text style={styles.small}>None of them is for your lists’ items.</Text> : null}
          {message ? <Text style={[styles.small, { color: colors.ink }]}>{message}</Text> : null}
          <View style={styles.actions}>
            {!couponAt || 'needs' in couponAt ? (
              <Pill
                label={`Sign in on ${site}`}
                accessibilityLabel={`Sign in on ${site}, for your ${config.coupons.program}`}
                icon="shield"
                small
                variant="dark"
                busy={signingIn}
                onPress={() => void signIn()}
              />
            ) : (
              <>
                {toClip.length > 1 ? (
                  <Pill
                    label={`Clip all ${toClip.length} for your lists`}
                    icon="tag"
                    small
                    variant="dark"
                    busy={clipping}
                    onPress={() => void clip(toClip.map((x) => x.coupon.id))}
                  />
                ) : null}
                <Pill
                  label="Read them again"
                  accessibilityLabel={`Read your ${config.coupons.program} again`}
                  icon="refresh"
                  small
                  variant="outline"
                  busy={readingCoupons}
                  onPress={() => void checkCoupons(true, [config.id])}
                />
                <Pill
                  label={`See them on ${site}`}
                  accessibilityLabel={`See your coupons on ${site}`}
                  accessibilityHint={`Opens ${config.name}’s own coupons page, where you can clip them yourself`}
                  icon="external"
                  small
                  variant="outline"
                  busy={viewing}
                  onPress={() => void view()}
                />
                <Pill label="Sign in again" accessibilityLabel={`Sign in again on ${site}`} icon="shield" small variant="outline" busy={signingIn} onPress={() => void signIn()} />
              </>
            )}
          </View>
        </>
      ) : (
        <Text style={styles.small}>{config.name} has no digital coupons in the store rules.</Text>
      )}
    </View>
  );
}

/** A list's item in the ad: the item, the ad's product and its deal, when it ends. Tapping checks it at every store. */
function AdRow({ itemName, name, deal, when }: { itemName: string; name: string; deal: string; when: string }) {
  return (
    <Pressable
      onPress={() => router.push({ pathname: '/search', params: { q: itemName } })}
      style={({ pressed }) => [styles.itemRow, pressed && styles.pressed]}
      accessibilityRole="button"
      accessibilityLabel={`${itemName}: ${name}, ${deal}${when ? `, ${when}` : ''}`}
      accessibilityHint="Checks it at every store"
    >
      <View style={styles.flex}>
        <Text style={styles.item}>
          {itemName} <Text style={styles.small}>· {deal}</Text>
        </Text>
        <Text style={styles.small} numberOfLines={2}>
          {name}
          {when ? ` · ${when}` : ''}
        </Text>
      </View>
      <Icon name="forward" size={16} color={colors.faint} />
    </Pressable>
  );
}

const capital = (s: string) => `${s.charAt(0).toUpperCase()}${s.slice(1)}`;

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.paper },
  content: { paddingHorizontal: 16, gap: 12 },
  card: { backgroundColor: colors.card, borderRadius: radius.lg, padding: 16, gap: 8, ...shadow.card },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  flex: { flex: 1, gap: 2 },
  alignStart: { alignSelf: 'flex-start' },
  pressed: { opacity: 0.8 },
  title: { flex: 1, fontFamily: fonts.semibold, fontSize: 16, color: colors.ink },
  store: { flex: 1, fontFamily: fonts.semibold, fontSize: 18, color: colors.ink },
  part: { fontFamily: fonts.semibold, fontSize: 13, letterSpacing: 0.6, textTransform: 'uppercase', color: colors.muted, marginTop: 6 },
  small: { fontFamily: fonts.body, fontSize: 14, lineHeight: 19, color: colors.muted },
  note: { fontFamily: fonts.body, fontSize: 13, lineHeight: 18, color: colors.muted, marginTop: 4 },
  itemRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  item: { fontFamily: fonts.medium, fontSize: 15, color: colors.ink },
  clip: { fontFamily: fonts.semibold, fontSize: 15, color: colors.green },
  clipWaiting: { opacity: 0.45 },
  clipped: { fontFamily: fonts.medium, fontSize: 14, color: colors.green },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 4 },
});
