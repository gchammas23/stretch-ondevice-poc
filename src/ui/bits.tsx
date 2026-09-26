import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';
import type { Product } from '../onDevice/types';
import { onSale } from '../pricing/basket';
import type { PricePoint } from '../pricing/priceHistory';
import { Icon, type IconName } from './Icon';
import { colors, fonts, money, radius } from './theme';
import { memberOffer } from '../pricing/member';

type Tone = 'orange' | 'blue' | 'green' | 'red' | 'plain';

const TONES: Record<Tone, { bg: string; fg: string }> = {
  orange: { bg: colors.orangeTint, fg: '#B83A1C' },
  blue: { bg: colors.blueTint, fg: colors.blue },
  green: { bg: colors.greenTint, fg: colors.green },
  // A shade darker than colors.red, for small text on its tint (4.5:1).
  red: { bg: '#FBE3E0', fg: '#AD3229' },
  plain: { bg: colors.chip, fg: colors.muted },
};

/** A small rounded label. `spoken` is what screen readers say, when the label has symbols ("−16%"). */
export function Chip({ label, icon, tone = 'plain', spoken }: { label: string; icon?: IconName; tone?: Tone; spoken?: string }) {
  const t = TONES[tone];
  return (
    <View style={[styles.chip, { backgroundColor: t.bg }]}>
      {icon ? <Icon name={icon} size={12} color={t.fg} strokeWidth={2.4} /> : null}
      <Text style={[styles.chipText, { color: t.fg }]} accessibilityLabel={spoken}>
        {label}
      </Text>
    </View>
  );
}

/**
 * "Sale · was $4.49", when the product is below its regular price; "with Card · was $4.49" when that's the member
 * price the user gets. A member price they don't get shows beside the price: "$3.99 with Card".
 */
export function SaleChip({ product }: { product: Product | null }) {
  if (!product) return null;
  const offer = memberOffer(product);
  if (offer !== undefined) return <Chip label={`${money(offer)} ${product.memberLabel ?? 'for members'}`} icon="tag" tone="plain" />;
  if (!onSale(product)) return null;
  const what = product.memberApplied ? (product.memberLabel ?? 'Member price') : 'Sale';
  return <Chip label={`${what.charAt(0).toUpperCase()}${what.slice(1)} · was ${money(product.wasPrice!)}`} icon="tag" tone="orange" />;
}

/** A price's history as a small line: dots where it was read, flat while it held. */
export function Sparkline({ points, width, height = 56 }: { points: PricePoint[]; width: number; height?: number }) {
  if (points.length < 2) return null;
  const pad = 6;
  const t0 = points[0].at;
  const t1 = Math.max(points[points.length - 1].seen, t0 + 1);
  const prices = points.map((p) => p.price);
  const lo = Math.min(...prices);
  const hi = Math.max(...prices);
  const x = (t: number) => pad + ((t - t0) / (t1 - t0)) * (width - 2 * pad);
  const y = (p: number) => (hi === lo ? height / 2 : pad + (1 - (p - lo) / (hi - lo)) * (height - 2 * pad));
  // Each price holds from when it was first read until the next one: steps, not slopes.
  let d = `M${x(points[0].at)} ${y(points[0].price)}`;
  points.forEach((p, i) => {
    if (i > 0) d += ` L${x(p.at)} ${y(points[i - 1].price)} L${x(p.at)} ${y(p.price)}`;
    d += ` L${x(p.seen)} ${y(p.price)}`;
  });
  const last = points[points.length - 1];
  const up = last.price > points[points.length - 2].price;
  return (
    <Svg width={width} height={height}>
      <Path d={d} stroke={up ? colors.red : colors.green} strokeWidth={2} fill="none" strokeLinejoin="round" />
      {points.map((p) => (
        <Circle key={p.at} cx={x(p.at)} cy={y(p.price)} r={2.5} fill={colors.card} stroke={colors.muted} strokeWidth={1.2} />
      ))}
    </Svg>
  );
}

const styles = StyleSheet.create({
  chip: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderRadius: radius.sm,
    paddingHorizontal: 7,
    paddingVertical: 3,
  },
  chipText: { fontFamily: fonts.medium, fontSize: 12 },
});
