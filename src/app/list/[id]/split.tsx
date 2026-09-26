import { router, useLocalSearchParams } from 'expo-router';
import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { GroceryList } from '../../../lists/types';
import { dollars, feesSummary, MODE_WORDS, orderable } from '../../../pricing/onlineCost';
import { startTrip } from '../../../pricing/trips';
import { storeNote } from '../../../state/storeInfo';
import { useApp, useComparison, useList, usePricingRun, useSettings } from '../../../state/AppProvider';
import { useFooterHeight } from '../../../ui/a11y';
import { Pill, ProductThumb } from '../../../ui/controls';
import { RetailerBadge } from '../../../ui/RetailerBadge';
import { ScreenHeader } from '../../../ui/ScreenHeader';
import { colors, fonts, money, radius, shadow } from '../../../ui/theme';

export default function SplitScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const list = useList(id);
  if (!list) return <ScreenHeader title="Split trip" subtitle="This list was deleted." />;
  return <SplitView list={list} />;
}

function SplitView({ list }: { list: GroceryList }) {
  const insets = useSafeAreaInsets();
  const { store, bundle } = useApp();
  const settings = useSettings();
  const run = usePricingRun(list.id);
  const { split, baskets, mode, costAt, online, orderCost } = useComparison(list, run);
  // Ordering online: two orders, each with its own fees.
  const how = mode === 'store' ? '' : ` ${MODE_WORDS[mode]}`;
  const nameOf = (rid: string) => bundle.retailers.find((r) => r.id === rid)?.name ?? rid;
  const [footerHeight, onFooterLayout] = useFooterHeight(110 + insets.bottom);

  if (!split) {
    return (
      <View style={styles.screen}>
        <ScreenHeader title="Split trip" subtitle="With the latest prices, one store is the better deal." />
      </View>
    );
  }

  const names = split.retailerIds.map(nameOf);
  const notFound = split.lines.filter((l) => l.status !== 'found');

  return (
    <View style={styles.screen}>
      <ScreenHeader
        title="Split trip"
        subtitle={
          split.extraItems > 0
            ? `${names.join(' + ')} gets ${split.extraItems} more of your list`
            : `${names.join(' + ')} saves ${money(split.savings)} over one store`
        }
      />
      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: footerHeight + 16 }]}>
        {split.retailerIds.map((rid, i) => {
          const lines = split.lines.filter((l) => l.status === 'found' && split.assignment[l.item.id] === rid);
          const subtotal = lines.reduce((sum, l) => sum + l.lineTotal, 0);
          const order = costAt(rid, subtotal);
          return (
            <View key={rid} style={styles.card}>
              <View style={styles.storeHead}>
                <RetailerBadge retailerId={rid} name={names[i]} />
                <View style={styles.flex}>
                  <Text style={styles.storeName} accessibilityRole="header">
                    {i + 1}. {names[i]}
                  </Text>
                  <Text style={styles.small}>{storeNote(rid, settings)}</Text>
                </View>
                <View style={styles.right}>
                  <Text style={styles.subtotal}>{money(order ? order.total : subtotal)}</Text>
                  <Text style={styles.small}>
                    {lines.length} {lines.length === 1 ? 'item' : 'items'}
                    {how}
                  </Text>
                </View>
              </View>
              {order ? <Text style={styles.small}>{feesSummary(order)}</Text> : null}
              {order?.minimum ? (
                <Text style={[styles.small, { color: colors.amber }]}>Under its {dollars(order.minimum.amount)} minimum order: add {money(order.minimum.short)} more.</Text>
              ) : null}
              {lines.map((l) => (
                <Pressable
                  key={l.item.id}
                  accessibilityRole="button"
                  onPress={() =>
                    router.push({ pathname: '/list/[id]/product', params: { id: list.id, store: rid, item: l.item.id, product: l.product!.id } })
                  }
                  style={({ pressed }) => [styles.line, pressed && styles.pressed]}
                >
                  <ProductThumb product={l.product} size={48} />
                  <View style={styles.flex}>
                    <Text style={styles.productName} numberOfLines={2}>
                      {l.product!.name}
                    </Text>
                    <Text style={styles.small}>
                      {l.item.name}
                      {l.item.qty > 1 ? ` · ${l.item.qty} units` : ''}
                    </Text>
                  </View>
                  <Text style={styles.price}>{money(l.lineTotal)}</Text>
                </Pressable>
              ))}
            </View>
          );
        })}
        {notFound.length ? (
          <View style={styles.card}>
            <Text style={styles.storeName} accessibilityRole="header">
              Not found at either store
            </Text>
            <Text style={styles.small}>{notFound.map((l) => l.item.name).join(', ')}</Text>
          </View>
        ) : null}
      </ScrollView>
      <View style={[styles.footer, { paddingBottom: insets.bottom + 12 }]} onLayout={onFooterLayout}>
        <View style={styles.flex}>
          <Text style={styles.footerName}>{names.join(' + ')}</Text>
          <Text
            style={styles.footerTotal}
            accessibilityLabel={`${money(split.total + (split.fees ?? 0))}${how}, ${split.found} of ${list.items.length} items`}
          >
            {money(split.total + (split.fees ?? 0))} <Text style={styles.small}>/ {split.found} of {list.items.length} items{how}</Text>
          </Text>
        </View>
        <Pill
          label="Shop this split"
          variant="dark"
          onPress={() => {
            startTrip(store, list, split.retailerIds, split, orderable(baskets, online), mode === 'store' ? undefined : { mode, fees: split.fees, costOf: orderCost });
            router.dismissTo(`/list/${list.id}`);
          }}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.paper },
  content: { paddingHorizontal: 16, gap: 12 },
  flex: { flex: 1, gap: 3 },
  right: { alignItems: 'flex-end', gap: 2 },
  pressed: { opacity: 0.8 },
  small: { fontFamily: fonts.body, fontSize: 14, lineHeight: 19, color: colors.muted },
  card: { backgroundColor: colors.card, borderRadius: radius.lg, padding: 16, gap: 4, ...shadow.card },
  storeHead: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingBottom: 10 },
  storeName: { fontFamily: fonts.semibold, fontSize: 17, color: colors.ink },
  subtotal: { fontFamily: fonts.semibold, fontSize: 17, color: colors.ink },
  line: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line,
  },
  productName: { fontFamily: fonts.medium, fontSize: 15, lineHeight: 20, color: colors.ink },
  price: { fontFamily: fonts.semibold, fontSize: 15, color: colors.ink },
  footer: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
    paddingHorizontal: 20,
    paddingTop: 14,
    backgroundColor: '#F2F1EC',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line,
  },
  footerName: { fontFamily: fonts.semibold, fontSize: 16, color: colors.ink },
  footerTotal: { fontFamily: fonts.semibold, fontSize: 18, color: colors.ink },
});
