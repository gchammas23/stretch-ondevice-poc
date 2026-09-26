import React from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import type { RetailerConfig } from '../onDevice/types';
import { whenLabel } from '../pricing/receipt';
import type { ProductSuggestion, SearchSuggestion } from '../pricing/suggest';
import { SaleChip } from './bits';
import { ProductThumb } from './controls';
import { Icon, type IconName } from './Icon';
import { colors, fonts, money, radius, shadow } from './theme';

const ICONS: Record<SearchSuggestion['from'], IconName> = { recent: 'clock', list: 'cart', store: 'store', common: 'search' };

/**
 * What to check for what's being typed: searches (what's typed itself first, then recent checks, list items, what
 * the stores suggest, common terms) and products the stores already showed this phone, with their prices.
 */
export function Suggestions({
  typed,
  searches,
  products,
  asking,
  nameOf,
  now,
  onSearch,
  onProduct,
}: {
  typed: string;
  searches: SearchSuggestion[];
  products: ProductSuggestion[];
  /** Stores asked for suggestions right now. */
  asking: RetailerConfig[];
  nameOf: (retailerId: string) => string;
  now: number;
  onSearch: (text: string) => void;
  onProduct: (suggestion: ProductSuggestion) => void;
}) {
  const fromWords = (s: SearchSuggestion) =>
    s.from === 'recent' ? 'Recent' : s.from === 'list' ? 'On a list' : s.from === 'store' ? `From ${(s.stores ?? []).map(nameOf).join(' and ')}` : '';
  return (
    <View style={styles.box}>
      <Pressable
        onPress={() => onSearch(typed)}
        accessibilityRole="button"
        accessibilityLabel={`Check “${typed.trim()}” at every store`}
        style={({ pressed }) => [styles.row, pressed && styles.pressed]}
      >
        <Icon name="search" size={18} color={colors.orangeText} />
        <Text style={[styles.text, styles.typed]} numberOfLines={1}>
          Check “{typed.trim()}”
        </Text>
      </Pressable>
      {searches.map((s) => {
        const from = fromWords(s);
        return (
          <Pressable
            key={s.text}
            onPress={() => onSearch(s.text)}
            accessibilityRole="button"
            accessibilityLabel={from ? `${s.text}, ${from.toLowerCase()}` : s.text}
            accessibilityHint="Checks its price at every store"
            style={({ pressed }) => [styles.row, pressed && styles.pressed]}
          >
            <Icon name={ICONS[s.from]} size={18} color={colors.muted} />
            <Text style={styles.text} numberOfLines={1}>
              {s.text}
            </Text>
            {from ? (
              <Text style={styles.from} numberOfLines={1}>
                {from}
              </Text>
            ) : null}
          </Pressable>
        );
      })}
      {asking.length ? (
        <View style={styles.asking}>
          <ActivityIndicator size="small" color={colors.orange} />
          <Text style={styles.small}>Asking {asking.map((a) => a.name).join(' and ')} what they suggest…</Text>
        </View>
      ) : null}

      {products.length ? (
        <>
          <Text style={styles.section} accessibilityRole="header">
            Products at your stores
          </Text>
          {products.map((p) => (
            <Pressable
              key={`${p.retailerId}|${p.product.id}`}
              onPress={() => onProduct(p)}
              accessibilityRole="button"
              accessibilityLabel={`${p.product.name}, ${nameOf(p.retailerId)}, ${money(p.product.price!)}`}
              accessibilityHint="Compares this exact product at every store"
              style={({ pressed }) => [styles.product, pressed && styles.pressed]}
            >
              <ProductThumb product={p.product} size={44} />
              <View style={styles.flex}>
                <Text style={styles.productName} numberOfLines={2}>
                  {p.product.name}
                </Text>
                <Text style={styles.small}>
                  {nameOf(p.retailerId)} · read {whenLabel(p.at, now)}
                </Text>
                <SaleChip product={p.product} />
              </View>
              <Text style={styles.price}>{money(p.product.price!)}</Text>
            </Pressable>
          ))}
          <Text style={styles.hint}>Tap a product to find that exact product at every store.</Text>
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { backgroundColor: colors.card, borderRadius: radius.lg, paddingHorizontal: 14, paddingVertical: 6, ...shadow.card },
  pressed: { opacity: 0.7 },
  flex: { flex: 1, gap: 2 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 44, paddingVertical: 6 },
  text: { flex: 1, fontFamily: fonts.body, fontSize: 16, color: colors.ink },
  typed: { fontFamily: fonts.semibold, color: colors.orangeText },
  from: { maxWidth: '45%', fontFamily: fonts.body, fontSize: 13, color: colors.muted },
  asking: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8 },
  small: { flexShrink: 1, fontFamily: fonts.body, fontSize: 13, lineHeight: 18, color: colors.muted },
  section: { fontFamily: fonts.semibold, fontSize: 13, letterSpacing: 0.6, textTransform: 'uppercase', color: colors.muted, marginTop: 10, marginBottom: 2 },
  product: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line,
  },
  productName: { fontFamily: fonts.medium, fontSize: 15, lineHeight: 20, color: colors.ink },
  price: { fontFamily: fonts.semibold, fontSize: 16, color: colors.ink },
  hint: { fontFamily: fonts.body, fontSize: 13, lineHeight: 18, color: colors.muted, paddingTop: 4, paddingBottom: 6 },
});
