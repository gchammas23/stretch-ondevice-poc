import React from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import type { WeeklyAd } from '../onDevice/adPage';
import { adLineWords, type AdHit } from '../pricing/ads';
import { couponChip, couponStateWords, type CouponHit } from '../pricing/coupons';
import { Chip } from './bits';
import { TEXT_BUTTON_SLOP } from './controls';
import { colors, fonts, money } from './theme';

/** A basket line in the store's weekly ad: "In this week's ad", then the ad's deal and when it ends. */
export function AdNote({ hit, ad, productPrice }: { hit: AdHit; ad: WeeklyAd | undefined; productPrice?: number }) {
  return (
    <View style={styles.note}>
      <Chip label="In this week’s ad" icon="star" tone="blue" />
      <Text style={styles.text}>{adLineWords(hit, ad, productPrice).replace(/^In this week’s ad: /, '')}</Text>
    </View>
  );
}

/**
 * A basket line's coupon: "Coupon: $1 off", whether it's clipped, and a Clip button when it isn't, which clips it on
 * the store's own page only because the user tapped it. `counted`: it comes off the total shown.
 */
export function CouponNote({
  hit,
  itemName,
  storeName,
  counted,
  clipping,
  onClip,
}: {
  hit: CouponHit;
  itemName: string;
  storeName: string;
  counted: boolean;
  clipping: boolean;
  onClip?: () => void;
}) {
  const c = hit.coupon;
  return (
    <View style={styles.note}>
      <Chip label={couponChip(c)} icon="tag" tone="green" />
      <Text style={styles.text}>
        {couponStateWords(hit)}
        {counted && hit.counts ? ` · ${money(hit.saves)} off the total` : ''}
      </Text>
      {!c.clipped && onClip ? (
        clipping ? (
          <ActivityIndicator size="small" color={colors.green} accessibilityLabel={`Clipping the coupon for ${itemName}`} />
        ) : (
          <Pressable
            onPress={onClip}
            hitSlop={TEXT_BUTTON_SLOP}
            accessibilityRole="button"
            accessibilityLabel={`Clip the coupon for ${itemName}: ${c.value}`}
            accessibilityHint={`Clips it to your ${storeName} account, on ${storeName}’s own page`}
          >
            <Text style={styles.action}>Clip</Text>
          </Pressable>
        )
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  note: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginTop: 4 },
  text: { flexShrink: 1, fontFamily: fonts.body, fontSize: 13, lineHeight: 18, color: colors.muted },
  action: { fontFamily: fonts.semibold, fontSize: 13, color: colors.green },
});
