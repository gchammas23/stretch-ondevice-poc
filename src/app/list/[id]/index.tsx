import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import React, { useCallback, useEffect, useState } from 'react';
import {
  ActionSheetIOS,
  ActivityIndicator,
  Alert,
  Animated,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { listText, parseListText } from '../../../lists/parse';
import { listQueries, type GroceryList, type ListItem, type TripRecord } from '../../../lists/types';
import { MODE_WORDS } from '../../../pricing/onlineCost';
import { addAgain } from '../../../state/appStore';
import { useApp, useAppState, useComparison, useList, usePricingRun, useSharePlan, useStoreChoices, useStoreName } from '../../../state/AppProvider';
import { announce, hiddenFromScreenReaders, useFooterHeight } from '../../../ui/a11y';
import { Checkbox, IconButton, Pill, ProductThumb, ProgressRing, tap, ZigzagEdge } from '../../../ui/controls';
import { Icon } from '../../../ui/Icon';
import { brandColor } from '../../../ui/RetailerBadge';
import { goBack } from '../../../ui/ScreenHeader';
import { colors, fonts, money, radius, shadow } from '../../../ui/theme';

type Row = { kind: 'item'; item: ListItem } | { kind: 'section'; key: string; title: string; color?: string };

/** After the list opens or changes, how long to wait before pricing it: typing a few items starts one run, not several. */
const PRICE_AFTER_MS = 900;

export default function ListScreen() {
  const { id, rename } = useLocalSearchParams<{ id: string; rename?: string }>();
  const list = useList(id);
  const insets = useSafeAreaInsets();

  if (!list) {
    return (
      <View style={[styles.gone, { paddingTop: insets.top + 40 }]}>
        <Text style={styles.goneText}>This list was deleted.</Text>
        <Pill label="All lists" onPress={() => router.replace('/')} />
      </View>
    );
  }
  // Keyed by the list: going back to this screen for another list (router.dismissTo) starts it afresh, not with the
  // other list's title or draft.
  return <ListView key={list.id} list={list} startRenaming={rename === '1'} />;
}

function ListView({ list, startRenaming }: { list: GroceryList; startRenaming: boolean }) {
  const { store, engine } = useApp();
  const choices = useStoreChoices();
  const insets = useSafeAreaInsets();
  const [draft, setDraft] = useState('');
  const [renaming, setRenaming] = useState(startRenaming);
  const [title, setTitle] = useState(list.name);
  const run = usePricingRun(list.id);
  const { pick, running, mode, orderTotal, countCoupons, coupons } = useComparison(list, run);
  const trip = list.trip;
  // The pick's total the way the user shops, and a trip's with what its online order adds.
  const how = mode === 'store' ? '' : ` ${MODE_WORDS[mode]}`;
  // Clipped coupons off the pick's total, when the user counts them.
  const withCoupons = (rid: string) => (countCoupons && coupons[rid]?.amount ? ', with coupons' : '');
  const tripTotal = trip ? `${money(trip.total + (trip.fees ?? 0))}${trip.mode ? ` ${MODE_WORDS[trip.mode]}` : ''}` : '';
  const trips = useAppState((s) => s.trips);
  const lists = useAppState((s) => s.lists);
  const again = trip ? [] : addAgain({ lists, trips }, list.id);
  const [finished, setFinished] = useState<TripRecord | null>(null);
  const [footerHeight, onFooterLayout] = useFooterHeight(90 + insets.bottom);
  const { fontScale } = useWindowDimensions();

  // Prices the list in the background while it's open, and again as items are added, so Find a store is usually
  // instant. Only what isn't already known is searched; older prices show meanwhile. Not during a trip, which is frozen.
  const names = listQueries(list).join('\n');
  // Items that can take another item's search ("Whole milk" in the one for "Milk").
  const sharing = useSharePlan(list);
  const shopping = !!trip;
  const priceInBackground = useCallback(() => {
    if (shopping || !names || !choices.length) return;
    const timer = setTimeout(() => engine.start(list.id, names.split('\n'), choices, { share: sharing }), PRICE_AFTER_MS);
    return () => clearTimeout(timer);
  }, [engine, list.id, names, shopping, choices, sharing]);
  useFocusEffect(priceInBackground);
  const nameOf = useStoreName();
  const checked = list.items.filter((i) => i.checked).length;

  const saveTitle = () => {
    store.renameList(list.id, title);
    setTitle(title.trim() || list.name);
    setRenaming(false);
  };

  const addItem = () => {
    if (!draft.trim()) return;
    store.addItem(list.id, draft);
    announce(`Added ${draft.trim()}`);
    setDraft('');
  };

  // A pasted list arrives in one go with its line breaks: every line becomes an item.
  const typeItem = (text: string) => {
    if (!text.includes('\n')) {
      setDraft(text);
      return;
    }
    const items = parseListText(text);
    if (items.length > 1) {
      store.addItems(list.id, items);
      announce(`Added ${items.length} items`);
      setDraft('');
    } else {
      setDraft(items[0]?.name ?? text.replace(/\s+/g, ' ').trim());
    }
  };

  const share = () => {
    const found = pick && !running ? { store: nameOf(pick.retailerId), total: `${money(orderTotal(pick))}${how}${withCoupons(pick.retailerId)}`, found: pick.found } : null;
    void Share.share({ message: listText(list, found) }).catch(() => {});
  };

  const duplicate = () => {
    const id = store.duplicateList(list.id);
    if (id) router.push(`/list/${id}?rename=1`);
  };

  const doneShopping = () => {
    const record = store.endTrip(list.id);
    setFinished(record);
    announce(record?.saved ? `Trip saved. You saved ${money(record.saved.amount)} compared with ${nameOf(record.saved.retailerId)}.` : 'Trip saved.');
  };

  const confirmRemove = (item: ListItem) =>
    Alert.alert(`Remove ${item.name}?`, undefined, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: () => store.removeItem(list.id, item.id) },
    ]);

  const confirmDelete = () =>
    Alert.alert(`Delete ${list.name}?`, 'This can’t be undone.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => {
          // Its searches still waiting are dropped: they'd use up each store's hour for nothing.
          engine.stop(list.id);
          store.deleteList(list.id);
          goBack();
        },
      },
    ]);
  const uncheckAll = () => list.items.filter((i) => i.checked).forEach((i) => store.toggleChecked(list.id, i.id));

  const showMenu = () => {
    if (Platform.OS === 'ios') {
      const options = [
        'Add from a recipe',
        'Rename list',
        ...(list.items.length ? ['Share list', 'Duplicate list'] : []),
        ...(checked ? ['Uncheck all'] : []),
        'Delete list',
        'Cancel',
      ];
      ActionSheetIOS.showActionSheetWithOptions(
        { title: list.name, options, destructiveButtonIndex: options.length - 2, cancelButtonIndex: options.length - 1 },
        (i) => {
          if (options[i] === 'Add from a recipe') router.push(`/list/${list.id}/recipe`);
          else if (options[i] === 'Rename list') setRenaming(true);
          else if (options[i] === 'Share list') share();
          else if (options[i] === 'Duplicate list') duplicate();
          else if (options[i] === 'Uncheck all') uncheckAll();
          else if (options[i] === 'Delete list') confirmDelete();
        },
      );
      return;
    }
    // Android alerts show at most three buttons.
    Alert.alert(list.name, undefined, [
      { text: 'Delete list', style: 'destructive', onPress: confirmDelete },
      { text: 'Add from a recipe', onPress: () => router.push(`/list/${list.id}/recipe`) },
      { text: 'Share list', onPress: share },
    ]);
  };

  // Shopping a split trip: the items for each store together.
  const rows: Row[] = [];
  if (trip && trip.retailerIds.length > 1) {
    for (const rid of trip.retailerIds) {
      const items = list.items.filter((i) => trip.lines[i.id]?.retailerId === rid);
      if (!items.length) continue;
      rows.push({ kind: 'section', key: rid, title: `At ${nameOf(rid)}`, color: brandColor(rid) });
      items.forEach((item) => rows.push({ kind: 'item', item }));
    }
    const rest = list.items.filter((i) => !trip.retailerIds.includes(trip.lines[i.id]?.retailerId ?? ''));
    if (rest.length) {
      rows.push({ kind: 'section', key: 'none', title: 'Not found at either store' });
      rest.forEach((item) => rows.push({ kind: 'item', item }));
    }
  } else {
    list.items.forEach((item) => rows.push({ kind: 'item', item }));
  }

  const header = (
    <View>
      <View style={[styles.header, { paddingTop: insets.top + 4 }]}>
        <View style={styles.headerRow}>
          <IconButton name="menu" label="All lists" onPress={goBack} />
          <IconButton name="more" label="List options" onPress={showMenu} />
        </View>
        {renaming ? (
          <TextInput
            value={title}
            onChangeText={setTitle}
            onSubmitEditing={saveTitle}
            onBlur={saveTitle}
            autoFocus
            selectTextOnFocus
            returnKeyType="done"
            style={[styles.title, styles.titleInput]}
            accessibilityLabel="List name"
          />
        ) : (
          // The list's heading, which can be tapped to rename it.
          <Pressable onPress={() => setRenaming(true)} accessibilityRole="header" accessibilityHint="Double-tap to rename the list">
            <Text style={styles.title}>{list.name}</Text>
          </Pressable>
        )}
        {trip ? (
          <View style={styles.metaRow}>
            <View style={[styles.dot, { backgroundColor: brandColor(trip.retailerIds[0]) }]} />
            <Text style={styles.metaText} accessibilityLabel={`Shopping at ${trip.retailerIds.map(nameOf).join(' and ')}, ${tripTotal}`}>
              {trip.retailerIds.map(nameOf).join(' + ')} <Text style={styles.metaDot}>•</Text> {tripTotal}
            </Text>
          </View>
        ) : null}
        <View style={styles.metaRow}>
          <ProgressRing value={list.items.length ? checked / list.items.length : 0} />
          <Text style={styles.metaText}>
            {trip || checked ? `${checked} of ${list.items.length} items` : `${list.items.length} ${list.items.length === 1 ? 'item' : 'items'}`}
          </Text>
        </View>
      </View>
      <ZigzagEdge />
    </View>
  );

  return (
    <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <FlatList
        data={rows}
        keyExtractor={(row) => (row.kind === 'item' ? row.item.id : `section-${row.key}`)}
        ListHeaderComponent={header}
        renderItem={({ item: row }) =>
          row.kind === 'section' ? (
            <View style={styles.section}>
              {row.color ? <View style={[styles.dot, { backgroundColor: row.color }]} /> : null}
              <Text style={styles.sectionText} accessibilityRole="header">
                {row.title}
              </Text>
            </View>
          ) : trip ? (
            <TripRow list={list} item={row.item} />
          ) : (
            <ItemRow list={list} item={row.item} onLongPress={() => confirmRemove(row.item)} />
          )
        }
        ListFooterComponent={
          trip ? null : (
            <View>
              <View style={styles.addRow}>
                <Icon name="plus" size={20} color={colors.faint} />
                <TextInput
                  value={draft}
                  onChangeText={typeItem}
                  onSubmitEditing={addItem}
                  placeholder="Add an item"
                  placeholderTextColor={colors.faint}
                  returnKeyType="done"
                  // Multiline only so a pasted list keeps its line breaks; Return still adds the item.
                  multiline
                  numberOfLines={1}
                  scrollEnabled={false}
                  textAlignVertical="center"
                  submitBehavior="submit"
                  autoCapitalize="sentences"
                  style={styles.addInput}
                  accessibilityLabel="Add an item"
                  accessibilityHint="Paste a list to add every line"
                />
              </View>
              {again.length ? (
                <View style={styles.again}>
                  <Text style={styles.againLabel} accessibilityRole="header">
                    Add again
                  </Text>
                  <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled" contentContainerStyle={styles.againRow}>
                    {again.map((name) => (
                      <Pressable
                        key={name}
                        accessibilityRole="button"
                        accessibilityLabel={`Add ${name}`}
                        hitSlop={{ top: 6, bottom: 6 }}
                        onPress={() => {
                          tap();
                          store.addItem(list.id, name);
                          announce(`Added ${name}`);
                        }}
                        style={({ pressed }) => [styles.againChip, pressed && styles.pressed]}
                      >
                        <Icon name="plus" size={14} color={colors.orange} strokeWidth={2.5} />
                        <Text style={styles.againText}>{name}</Text>
                      </Pressable>
                    ))}
                  </ScrollView>
                </View>
              ) : null}
            </View>
          )
        }
        ListEmptyComponent={
          trip ? null : (
            <Text style={styles.empty}>Add what you need, the way you’d write it: “eggs”, “hot dog buns”. Paste a list to add every line at once.</Text>
          )
        }
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingBottom: footerHeight + 40 }}
      />

      <View style={[styles.bottom, { paddingBottom: insets.bottom + 12 }]} pointerEvents="box-none" onLayout={onFooterLayout}>
        {trip ? (
          <View style={styles.bottomRow}>
            <Pill label="Stores" icon="map" variant="light" onPress={() => router.push(`/list/${list.id}/compare`)} style={shadow.float} />
            <Pill label="Done shopping" icon="check" variant="dark" onPress={doneShopping} style={shadow.float} />
          </View>
        ) : (
          <View style={styles.bottomRow}>
            {pick ? (
              <Pressable onPress={() => router.push(`/list/${list.id}/compare`)} style={styles.pickHint} accessibilityRole="button">
                <View style={styles.pickHintHead}>
                  {running ? <ActivityIndicator size="small" color={colors.blue} style={styles.hintSpinner} /> : <Icon name="sparkle" size={12} color={colors.blue} />}
                  <Text style={styles.pickHintLabel}>{running ? 'Best so far' : 'Stretch’s pick'}</Text>
                </View>
                <Text style={styles.pickHintText} numberOfLines={fontScale > 1.3 ? undefined : 1}>
                  {nameOf(pick.retailerId)} · {money(orderTotal(pick))}
                  {how}
                  {withCoupons(pick.retailerId)}
                </Text>
              </Pressable>
            ) : running ? (
              <View style={styles.pickHint} accessibilityLiveRegion="polite">
                <View style={styles.pickHintHead}>
                  <ActivityIndicator size="small" color={colors.blue} style={styles.hintSpinner} />
                  <Text style={styles.pickHintLabel}>Checking prices</Text>
                </View>
                <Text style={styles.pickHintText}>In the background</Text>
              </View>
            ) : (
              <View />
            )}
            <Pill
              label="Find a store"
              icon="map"
              variant="orange"
              disabled={!list.items.length}
              onPress={() => router.push(`/list/${list.id}/compare`)}
              style={shadow.float}
            />
          </View>
        )}
      </View>
      {trip ? (
        <TripToast
          startedAt={trip.startedAt}
          bottom={footerHeight + 8}
          spoken={`Shopping at ${trip.retailerIds.map(nameOf).join(' and ')}, ${tripTotal}.`}
        />
      ) : null}
      {finished ? (
        <Toast
          key={finished.id}
          bottom={footerHeight + 8}
          text={
            finished.saved
              ? `Trip saved. You saved ${money(finished.saved.amount)} compared with ${nameOf(finished.saved.retailerId)}.`
              : 'Trip saved. Your savings add up on the home screen.'
          }
        />
      ) : null}
    </KeyboardAvoidingView>
  );
}

/** "organic · Horizon · 1 gal · same product", what's set on an item beyond its name. */
function itemExtras(item: ListItem): string {
  const p = item.prefs ?? {};
  return [p.organic ? 'organic' : '', p.brand ?? '', p.size ?? '', item.exact ? 'same product everywhere' : ''].filter(Boolean).join(' · ');
}

function ItemRow({ list, item, onLongPress }: { list: GroceryList; item: ListItem; onLongPress: () => void }) {
  const { store } = useApp();
  const extras = itemExtras(item);
  return (
    <View style={styles.row}>
      <Checkbox checked={item.checked} label={item.name} onPress={() => store.toggleChecked(list.id, item.id)} />
      <Pressable
        onPress={() => router.push(`/list/${list.id}/item/${item.id}`)}
        onLongPress={onLongPress}
        style={styles.itemPress}
        accessibilityRole="button"
        accessibilityHint="Opens the item: quantity, note and what you want. Long-press to remove."
        accessibilityActions={[{ name: 'remove', label: 'Remove' }]}
        onAccessibilityAction={(e) => e.nativeEvent.actionName === 'remove' && onLongPress()}
      >
        <View style={styles.itemText}>
          <Text style={[styles.itemName, item.checked && styles.checked]}>{item.name}</Text>
          {extras || item.note ? (
            <Text style={styles.itemExtras} numberOfLines={2}>
              {[extras, item.note].filter(Boolean).join(' · ')}
            </Text>
          ) : null}
        </View>
        {item.qty > 1 ? (
          <Text style={styles.qty} accessibilityLabel={`quantity ${item.qty}`}>
            ×{item.qty}
          </Text>
        ) : null}
      </Pressable>
    </View>
  );
}

function TripRow({ list, item }: { list: GroceryList; item: ListItem }) {
  const { store } = useApp();
  const line = list.trip?.lines[item.id];
  const product = line?.product ?? null;
  return (
    <View style={styles.row}>
      <Checkbox checked={item.checked} label={product?.name ?? item.name} onPress={() => store.toggleChecked(list.id, item.id)} />
      <Pressable
        disabled={!product || !line?.retailerId}
        accessibilityRole="button"
        accessibilityHint="Opens the product"
        onPress={() =>
          router.push({ pathname: '/list/[id]/product', params: { id: list.id, store: line!.retailerId, item: item.id, product: product!.id } })
        }
        style={({ pressed }) => [styles.tripPress, pressed && styles.pressed]}
      >
        <View style={styles.tripText}>
          <Text style={[styles.itemName, item.checked && styles.checked]} numberOfLines={2}>
            {product?.name ?? item.name}
          </Text>
          <Text style={styles.tripMeta}>
            {item.qty} {item.qty === 1 ? 'unit' : 'units'}
            {'  ·  '}
            {product?.price != null ? money(product.price * item.qty) : 'Not found here'}
          </Text>
        </View>
        <View>
          <ProductThumb product={product} size={48} />
          {/* Said already: "2 units". */}
          <View style={styles.qtyBadge} {...hiddenFromScreenReaders}>
            <Text style={styles.qtyBadgeText} maxFontSizeMultiplier={1.3}>
              {item.qty}
            </Text>
          </View>
        </View>
      </Pressable>
    </View>
  );
}

/** "Stretch keeps an eye on prices", shown for a moment after tapping Shop here. Screen readers hear where and how much. */
function TripToast({ startedAt, bottom, spoken }: { startedAt: number; bottom: number; spoken: string }) {
  const [show] = useState(() => Date.now() - startedAt < 5000);
  useEffect(() => {
    if (show) announce(spoken);
    // Once, as the trip starts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return show ? <Toast bottom={bottom} text="Stretch keeps an eye on prices so you don’t have to!" /> : null;
}

/**
 * A message that fades in above the buttons for a few seconds, then goes. Screen readers are told what matters in it
 * when it's shown (see announce), so the toast itself is left out for them.
 */
function Toast({ text, bottom }: { text: string; bottom: number }) {
  const [opacity] = useState(() => new Animated.Value(0));
  const [gone, setGone] = useState(false);

  useEffect(() => {
    const animation = Animated.sequence([
      Animated.timing(opacity, { toValue: 1, duration: 260, useNativeDriver: true }),
      Animated.delay(3200),
      Animated.timing(opacity, { toValue: 0, duration: 320, useNativeDriver: true }),
    ]);
    animation.start(({ finished }) => finished && setGone(true));
    return () => animation.stop();
  }, [opacity]);

  if (gone) return null;
  return (
    <Animated.View
      pointerEvents="none"
      {...hiddenFromScreenReaders}
      style={[
        styles.toast,
        { bottom, opacity, transform: [{ translateY: opacity.interpolate({ inputRange: [0, 1], outputRange: [12, 0] }) }] },
      ]}
    >
      <Text style={styles.toastText}>{text}</Text>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.paper },
  gone: { flex: 1, alignItems: 'center', gap: 16, backgroundColor: colors.paper },
  goneText: { fontFamily: fonts.body, fontSize: 17, color: colors.muted },
  header: { backgroundColor: colors.blush, paddingHorizontal: 12, paddingBottom: 18, gap: 8 },
  headerRow: { flexDirection: 'row', justifyContent: 'space-between' },
  title: { fontFamily: fonts.display, fontSize: 36, lineHeight: 42, color: colors.ink, paddingHorizontal: 8, marginTop: 6 },
  titleInput: { paddingVertical: 0, borderBottomWidth: 1.5, borderBottomColor: 'rgba(31,31,31,0.25)', marginHorizontal: 8, paddingHorizontal: 0 },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 8 },
  metaText: { fontFamily: fonts.body, fontSize: 16, color: '#5F5750' },
  metaDot: { color: colors.orange },
  dot: { width: 12, height: 12, borderRadius: 6 },
  section: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 22, paddingTop: 22, paddingBottom: 6 },
  sectionText: { fontFamily: fonts.semibold, fontSize: 13, letterSpacing: 0.6, textTransform: 'uppercase', color: colors.muted },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    marginHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
  },
  itemPress: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10, alignSelf: 'stretch' },
  itemText: { flex: 1, gap: 2 },
  itemExtras: { fontFamily: fonts.body, fontSize: 13, lineHeight: 18, color: colors.muted },
  itemName: { flex: 1, fontFamily: fonts.body, fontSize: 17, color: colors.ink },
  checked: { color: colors.muted, textDecorationLine: 'line-through' },
  qty: { fontFamily: fonts.medium, fontSize: 15, color: colors.muted },
  tripText: { flex: 1, gap: 4 },
  tripPress: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 14 },
  pressed: { opacity: 0.75 },
  again: { gap: 8, paddingTop: 4, paddingBottom: 8 },
  againLabel: { fontFamily: fonts.semibold, fontSize: 13, letterSpacing: 0.6, textTransform: 'uppercase', color: colors.muted, marginLeft: 22 },
  againRow: { gap: 8, paddingHorizontal: 20 },
  againChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.pill,
    paddingVertical: 7,
    paddingHorizontal: 12,
  },
  againText: { fontFamily: fonts.medium, fontSize: 14, color: colors.ink },
  tripMeta: { fontFamily: fonts.body, fontSize: 14, color: colors.muted },
  qtyBadge: {
    position: 'absolute',
    left: -8,
    bottom: -6,
    minWidth: 20,
    minHeight: 20,
    borderRadius: 6,
    // White text on it at 4.5:1.
    backgroundColor: colors.muted,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 4,
  },
  qtyBadgeText: { fontFamily: fonts.semibold, fontSize: 12, color: '#ffffff' },
  addRow: { flexDirection: 'row', alignItems: 'center', gap: 14, marginHorizontal: 20, paddingVertical: 12 },
  addInput: { flex: 1, fontFamily: fonts.body, fontSize: 17, color: colors.ink, paddingVertical: 6 },
  empty: { fontFamily: fonts.body, fontSize: 15, lineHeight: 21, color: colors.muted, marginHorizontal: 22, marginTop: 18 },
  bottom: { position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 20 },
  bottomRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  pickHint: {
    flexShrink: 1,
    gap: 2,
    backgroundColor: colors.blueTint,
    borderRadius: radius.md,
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  pickHintHead: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  pickHintLabel: { fontFamily: fonts.medium, fontSize: 12, color: colors.blue },
  hintSpinner: { transform: [{ scale: 0.6 }], width: 12, height: 12 },
  pickHintText: { flexShrink: 1, fontFamily: fonts.semibold, fontSize: 15, color: colors.ink },
  toast: {
    position: 'absolute',
    left: 20,
    right: 20,
    backgroundColor: colors.orangeButton,
    borderRadius: radius.lg,
    paddingVertical: 16,
    paddingHorizontal: 20,
    ...shadow.float,
  },
  toastText: { fontFamily: fonts.medium, fontSize: 16, lineHeight: 22, color: '#ffffff' },
});
