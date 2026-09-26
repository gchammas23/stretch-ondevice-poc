import { useLocalSearchParams } from 'expo-router';
import React, { useState } from 'react';
import { Alert, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { itemKey, queryKey, searchText, type GroceryList, type ListItem } from '../../../../lists/types';
import { parseSize } from '../../../../pricing/sizes';
import { useApp, useList, usePricingRun, useUsuals } from '../../../../state/AppProvider';
import { announce } from '../../../../ui/a11y';
import { Pill, QtyStepper } from '../../../../ui/controls';
import { RetailerBadge } from '../../../../ui/RetailerBadge';
import { goBack, ScreenHeader } from '../../../../ui/ScreenHeader';
import { colors, fonts, radius, shadow } from '../../../../ui/theme';

export default function ItemScreen() {
  const { id, itemId } = useLocalSearchParams<{ id: string; itemId: string }>();
  const list = useList(id);
  const item = list?.items.find((i) => i.id === itemId);
  if (!list || !item) return <ScreenHeader title="Item" subtitle="This item isn’t on the list anymore." />;
  return <ItemView list={list} item={item} />;
}

/**
 * What you want when you write an item: its name and quantity, a note, and preferences (organic, a brand, a size)
 * that steer the search and the pick at every store.
 */
function ItemView({ list, item }: { list: GroceryList; item: ListItem }) {
  const insets = useSafeAreaInsets();
  const { store, bundle } = useApp();
  const usuals = useUsuals();
  const run = usePricingRun(list.id);
  const [name, setName] = useState(item.name);
  const [note, setNote] = useState(item.note ?? '');
  const [brand, setBrand] = useState(item.prefs?.brand ?? '');
  const [size, setSize] = useState(item.prefs?.size ?? '');
  const nameOf = (rid: string) => bundle.retailers.find((r) => r.id === rid)?.name ?? rid;
  const parsed = size.trim() ? parseSize(size) : null;
  const sizeNote = !size.trim()
    ? null
    : parsed
      ? `Picks packs of ${parsed.text}, give or take 5%.`
      : 'Couldn’t read that size. Try a number and a unit: 1 gal, 12 ct, 16 oz.';
  const mine = usuals[queryKey(item.name)] ?? {};
  const productName = (rid: string, productId: string) =>
    run?.results[rid]?.[itemKey(item)]?.products.find((p) => p.id === productId)?.name ?? 'The product you chose there';

  const remove = () =>
    Alert.alert(`Remove ${item.name}?`, undefined, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: () => {
          store.removeItem(list.id, item.id);
          goBack();
        },
      },
    ]);

  return (
    <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScreenHeader title={item.name} subtitle={`On ${list.name} · searched as “${searchText(item)}”`} />
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 32 }]}>
        <View style={styles.card}>
          <Text style={styles.label}>Name</Text>
          <TextInput
            value={name}
            onChangeText={setName}
            onEndEditing={() => store.renameItem(list.id, item.id, name)}
            onSubmitEditing={() => store.renameItem(list.id, item.id, name)}
            returnKeyType="done"
            style={styles.input}
            accessibilityLabel="Item name"
          />
          <View style={styles.row}>
            <Text style={[styles.label, styles.flex]}>Quantity</Text>
            <QtyStepper qty={item.qty} itemName={item.name} onChange={(qty) => store.setQty(list.id, item.id, qty)} onRemove={remove} />
          </View>
          <Text style={styles.label}>Note</Text>
          <TextInput
            value={note}
            onChangeText={setNote}
            onEndEditing={() => store.setItemNote(list.id, item.id, note)}
            placeholder="Anything to remember, e.g. “for the cake”"
            placeholderTextColor={colors.faint}
            style={styles.input}
            accessibilityLabel="Note"
          />
        </View>

        <View style={styles.card}>
          <Text style={styles.title} accessibilityRole="header">
            What you want
          </Text>
          <Text style={styles.small}>Stretch searches with these and picks the first result that meets them at each store. If none does, it shows the closest one and says so.</Text>
          <View style={styles.row}>
            <View style={styles.flex}>
              <Text style={styles.label}>Organic</Text>
              <Text style={styles.small}>Adds “organic” to the search.</Text>
            </View>
            <Switch
              value={!!item.prefs?.organic}
              onValueChange={(on) => store.setItemPrefs(list.id, item.id, { organic: on })}
              trackColor={{ true: colors.orange, false: colors.faint }}
              thumbColor="#FFFFFF"
              accessibilityLabel="Organic"
            />
          </View>
          <Text style={styles.label}>Brand</Text>
          <TextInput
            value={brand}
            onChangeText={setBrand}
            onEndEditing={() => store.setItemPrefs(list.id, item.id, { brand })}
            placeholder="Any brand"
            placeholderTextColor={colors.faint}
            autoCapitalize="words"
            style={styles.input}
            accessibilityLabel="Brand"
          />
          <Text style={styles.label}>Size</Text>
          <TextInput
            value={size}
            onChangeText={setSize}
            onEndEditing={() => {
              store.setItemPrefs(list.id, item.id, { size });
              if (sizeNote) announce(sizeNote);
            }}
            placeholder="Any size, or e.g. 1 gal, 12 ct, 16 oz"
            placeholderTextColor={colors.faint}
            style={styles.input}
            accessibilityLabel="Size"
            accessibilityHint={sizeNote ?? undefined}
          />
          {sizeNote ? <Text style={[styles.small, !parsed && { color: colors.amber }]}>{sizeNote}</Text> : null}
        </View>

        <View style={styles.card}>
          <Text style={styles.title} accessibilityRole="header">
            The same product everywhere
          </Text>
          {item.exact ? (
            <>
              <View style={styles.row}>
                <RetailerBadge retailerId={item.exact.retailerId} name={nameOf(item.exact.retailerId)} size={28} labelled />
                <Text style={[styles.body, styles.flex]}>{item.exact.name}</Text>
              </View>
              <Text style={styles.small}>
                Compared as this exact product at every store{item.exact.gtin ? `, by its barcode (${item.exact.gtin}) where they publish one, else` : ','} by its name and size.
              </Text>
              <Pill label="Back to the best match at each store" small variant="outline" onPress={() => store.setExact(list.id, item.id, null)} style={styles.alignStart} />
            </>
          ) : (
            <Text style={styles.small}>
              Open a product from this item’s basket and tap Compare this exact product, or tap Compare the same products on Find a store.
            </Text>
          )}
        </View>

        {Object.keys(mine).length ? (
          <View style={styles.card}>
            <Text style={styles.title} accessibilityRole="header">
              Your usuals
            </Text>
            {Object.entries(mine).map(([rid, productId]) => (
              <View key={rid} style={styles.row}>
                <RetailerBadge retailerId={rid} name={nameOf(rid)} size={28} labelled />
                <Text style={[styles.body, styles.flex]} numberOfLines={2}>
                  {productName(rid, productId)}
                </Text>
                <Pill
                  label="Forget"
                  accessibilityLabel={`Forget your usual at ${nameOf(rid)}`}
                  small
                  variant="outline"
                  onPress={() => {
                    store.forgetUsual(item.name, rid);
                    announce(`Forgot your usual at ${nameOf(rid)}`);
                  }}
                />
              </View>
            ))}
          </View>
        ) : null}

        <Pill label={`Remove ${item.name}`} icon="trash" variant="outline" onPress={remove} />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.paper },
  content: { paddingHorizontal: 16, gap: 12 },
  flex: { flex: 1, gap: 2 },
  alignStart: { alignSelf: 'flex-start' },
  card: { backgroundColor: colors.card, borderRadius: radius.lg, padding: 16, gap: 10, ...shadow.card },
  title: { fontFamily: fonts.semibold, fontSize: 17, color: colors.ink },
  label: { fontFamily: fonts.semibold, fontSize: 15, color: colors.ink },
  body: { fontFamily: fonts.body, fontSize: 15, lineHeight: 21, color: colors.ink },
  small: { fontFamily: fonts.body, fontSize: 14, lineHeight: 19, color: colors.muted },
  input: {
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.md,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontFamily: fonts.body,
    fontSize: 16,
    color: colors.ink,
    minWidth: 0,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
});
