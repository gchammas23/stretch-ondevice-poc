import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { ActionSheetIOS, ActivityIndicator, Alert, Keyboard, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { GROCERY_TERMS } from '../lists/groceryTerms';
import { normalizeBarcode } from '../onDevice/barcode';
import { reasonWords } from '../onDevice/scrapeFeed';
import type { Product } from '../onDevice/types';
import { MAX_AGE_MS } from '../pricing/priceCache';
import { barcodeIdentity, priceCheckAnswers, type KnownProduct } from '../pricing/priceCheck';
import { unitPriceOf } from '../pricing/sizes';
import { suggestProducts, suggestSearches, type ProductSuggestion } from '../pricing/suggest';
import { QUICK_RUN, useApp, useAppState, useLists, usePricingRun, useStoreChoices } from '../state/AppProvider';
import { announce, useFooterHeight } from '../ui/a11y';
import { Chip, SaleChip } from '../ui/bits';
import { IconButton, Pill, ProductThumb, tap } from '../ui/controls';
import { deviceWord } from '../ui/device';
import { Icon } from '../ui/Icon';
import { RetailerBadge } from '../ui/RetailerBadge';
import { ScreenHeader } from '../ui/ScreenHeader';
import { Suggestions } from '../ui/Suggestions';
import { colors, fonts, money, radius, shadow } from '../ui/theme';
import { useNow } from '../ui/useNow';
import { useStoreSuggestions } from '../ui/useStoreSuggestions';

/** `q`: words. `code`: a scanned barcode. `like` (with `from`, and `code` if it has one): a product to find everywhere. */
type Params = { q?: string; code?: string; like?: string; from?: string };

/**
 * Price check anything: one search at every compared store, side by side, without a list.
 * - Typing suggests searches and products (see Suggestions).
 * - From a barcode, each store is searched by the barcode; once one store names the product, the others are also
 *   searched by its name.
 * - From a product (a suggestion), each store is searched by its name, and its barcode if it has one, for that
 *   same product.
 */
export default function PriceCheckScreen() {
  const params = useLocalSearchParams<Params>();
  const insets = useSafeAreaInsets();
  const { engine, store, cache, bundle } = useApp();
  const choices = useStoreChoices();
  const lists = useLists();
  const recent = useAppState((s) => s.recentSearches);
  const run = usePricingRun(QUICK_RUN);
  const now = useNow(60_000);
  const barcode = params.code ? normalizeBarcode(params.code) : null;
  const known: KnownProduct | undefined = params.like ? { name: params.like, ...(barcode ? { gtin: barcode } : {}) } : undefined;
  const mode = known ? 'product' : barcode ? 'barcode' : 'words';
  const [draft, setDraft] = useState(params.q ?? '');
  const [query, setQuery] = useState<string | null>(known?.name ?? barcode ?? params.q ?? null);
  const [openMore, setOpenMore] = useState<string | null>(null);
  /** Typing: suggestions show instead of results until a search is chosen. */
  const [editing, setEditing] = useState(!query);
  // The box starts focused when there's nothing searched yet (autoFocus below).
  const [focused, setFocused] = useState(!query);
  /** The query whose answer screen readers were told. */
  const spoken = useRef<string | null>(null);
  const nameOf = (rid: string) => bundle.retailers.find((r) => r.id === rid)?.name ?? rid;

  // The scanned product's name, once a store's result carries the same barcode.
  const identityName = mode === 'barcode' ? barcodeIdentity(run, barcode!)?.name : undefined;
  // What's searched at every store: the words, or the barcode (and the scanned product's name once known), or the
  // chosen product's name (and its barcode). Again whenever the screen shows, so coming back to it finds its results.
  const queries = known ? [known.name, ...(barcode ? [barcode] : [])] : barcode ? [barcode, ...(identityName ? [identityName] : [])] : query ? [query] : [];
  const queriesKey = queries.join('\n');
  useFocusEffect(
    useCallback(() => {
      if (queriesKey) engine.start(QUICK_RUN, queriesKey.split('\n'), choices);
    }, [engine, queriesKey, choices]),
  );

  const submit = (text = draft) => {
    const clean = text.trim().replace(/\s+/g, ' ');
    if (!clean) return;
    Keyboard.dismiss();
    tap();
    setDraft(clean);
    setEditing(false);
    setOpenMore(null);
    spoken.current = null;
    store.addRecentSearch(clean);
    if (clean === query) engine.start(QUICK_RUN, [clean], choices, { refresh: true });
    else setQuery(clean);
  };

  // Suggestions for what's typed: the user's own searches and items, what two stores' search boxes suggest, common
  // grocery terms, and products the stores already showed this phone.
  const suggesting = mode === 'words' && editing && !!draft.trim();
  const live = useStoreSuggestions(draft, mode === 'words' && focused);
  const listNames = useMemo(() => [...new Set(lists.flatMap((l) => l.items.map((i) => i.name)))], [lists]);
  const cacheVersion = useSyncExternalStore(cache.subscribe, () => cache.version);
  const storeKeys = useMemo(() => Object.fromEntries(choices.map((c) => [c.config.id, c.storeKey])), [choices]);
  const searches = useMemo(
    () => (suggesting ? suggestSearches(draft, { recent, list: listNames, store: live.items, common: GROCERY_TERMS }) : []),
    [suggesting, draft, recent, listNames, live.items],
  );
  const products = useMemo(
    () => (suggesting && cacheVersion >= 0 ? suggestProducts(draft, cache.list(), storeKeys, now, MAX_AGE_MS) : []),
    [suggesting, draft, cache, cacheVersion, storeKeys, now],
  );
  const compareProduct = (s: ProductSuggestion) => {
    tap();
    Keyboard.dismiss();
    router.push({ pathname: '/search', params: { like: s.product.name, from: s.retailerId, ...(s.product.gtin ? { code: s.product.gtin } : {}) } });
  };

  const answers = priceCheckAnswers(run, choices.map((c) => c.config), query, barcode, known);
  const found = answers.filter((a) => a.status === 'found' && a.product?.price != null);
  const done = !!query && answers.every((a) => a.status !== 'checking' && a.status !== 'waiting');
  // Once everything's in, cheapest first; until then stores keep their places.
  const ordered = done ? [...answers].sort((a, b) => (a.product?.price ?? Infinity) - (b.product?.price ?? Infinity)) : answers;
  const cheapest = found.length ? found.reduce((a, b) => (b.product!.price! < a.product!.price! ? b : a)) : null;
  const itemName = known ? known.name : barcode ? identityName : query;
  const productParams = { ...(barcode ? { code: barcode } : {}), ...(known ? { like: known.name } : {}) };
  const [footerHeight, onFooterLayout] = useFooterHeight(110 + insets.bottom);

  // Screen readers hear the answer once every store is in.
  useEffect(() => {
    if (!done || !query || spoken.current === query) return;
    spoken.current = query;
    announce(
      cheapest
        ? `Cheapest: ${cheapest.name}, ${money(cheapest.product!.price!)}. ${found.length} of ${answers.length} stores have it.`
        : mode === 'words'
          ? 'None of your stores had it.'
          : 'None of your stores had this product.',
    );
  });

  const addToList = () => {
    if (!itemName) return;
    const add = (listId: string) => {
      store.addItem(listId, itemName);
      tap();
      Alert.alert(`Added ${itemName}`, undefined, [
        { text: 'OK', style: 'cancel' },
        { text: 'Open the list', onPress: () => router.push(`/list/${listId}`) },
      ]);
    };
    const create = () => {
      const id = store.createList('New list');
      add(id);
    };
    if (Platform.OS === 'ios') {
      const options = [...lists.map((l) => l.name), 'New list', 'Cancel'];
      ActionSheetIOS.showActionSheetWithOptions({ title: `Add “${itemName}” to…`, options, cancelButtonIndex: options.length - 1 }, (i) => {
        if (i < lists.length) add(lists[i].id);
        else if (i === lists.length) create();
      });
      return;
    }
    Alert.alert(`Add “${itemName}” to…`, undefined, [
      ...lists.slice(0, 2).map((l) => ({ text: l.name, onPress: () => add(l.id) })),
      { text: 'New list', onPress: create },
    ]);
  };

  return (
    <View style={styles.screen}>
      <ScreenHeader
        title={mode === 'product' ? 'The same product' : mode === 'barcode' ? 'Scanned product' : 'Price check'}
        subtitle={
          mode === 'product'
            ? `${known!.name}${params.from ? `, seen at ${nameOf(params.from)}` : ''}. Found at each of your stores.`
            : mode === 'barcode'
              ? `Barcode ${barcode}${identityName ? ` · ${identityName}` : ''}`
              : `Any product, at your ${choices.length} stores, live from this ${deviceWord}.`
        }
        right={<IconButton name="scan" label="Scan a barcode" onPress={() => router.push('/scan')} />}
      />
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={[styles.content, { paddingBottom: footerHeight + 16 }]}>
        {mode === 'words' ? (
          <View style={styles.searchRow}>
            <Icon name="search" size={20} color={colors.muted} />
            <TextInput
              value={draft}
              onChangeText={(text) => {
                setDraft(text);
                setEditing(true);
              }}
              onFocus={() => {
                setFocused(true);
                setEditing(true);
              }}
              onBlur={() => {
                setFocused(false);
                // Left as it was: back to its results.
                if (query && draft.trim() === query) setEditing(false);
              }}
              onSubmitEditing={() => submit()}
              placeholder="Milk, Cheerios, paper towels…"
              placeholderTextColor={colors.faint}
              returnKeyType="search"
              autoFocus={!query}
              autoCorrect={false}
              style={styles.input}
              accessibilityLabel="What to price"
            />
            {draft ? (
              <Pressable accessibilityRole="button" accessibilityLabel="Check the price" onPress={() => submit()} hitSlop={8} style={styles.go}>
                <Icon name="forward" size={18} color="#ffffff" />
              </Pressable>
            ) : null}
          </View>
        ) : null}

        {suggesting ? (
          <Suggestions
            typed={draft}
            searches={searches}
            products={products}
            asking={live.asking}
            nameOf={nameOf}
            now={now}
            onSearch={submit}
            onProduct={compareProduct}
          />
        ) : null}

        {mode === 'words' && !draft.trim() && (editing || !query) && recent.length ? (
          <View style={styles.recent}>
            <Text style={styles.section} accessibilityRole="header">
              Recent
            </Text>
            <View style={styles.recentRow}>
              {recent.map((q) => (
                <Pressable
                  key={q}
                  accessibilityRole="button"
                  accessibilityHint="Checks its price again"
                  hitSlop={{ top: 5, bottom: 5 }}
                  onPress={() => submit(q)}
                  style={({ pressed }) => [styles.recentChip, pressed && styles.pressed]}
                >
                  <Text style={styles.recentText}>{q}</Text>
                </Pressable>
              ))}
            </View>
          </View>
        ) : null}

        {query && !suggesting ? (
          <View style={styles.summary}>
            {cheapest ? (
              <>
                <Text style={styles.summaryLabel}>{done ? 'Cheapest' : 'Cheapest so far'}</Text>
                <Text style={styles.summaryTitle}>
                  {cheapest.name} · {money(cheapest.product!.price!)}
                </Text>
                {found.length > 1 ? (
                  <Text style={styles.small}>
                    {money(Math.max(...found.map((a) => a.product!.price!)) - cheapest.product!.price!)} less than the priciest of {found.length} stores.
                  </Text>
                ) : null}
              </>
            ) : (
              <View style={styles.checkingRow}>
                {!done ? <ActivityIndicator size="small" color={colors.orange} /> : null}
                <Text style={styles.small}>{done ? 'None of your stores had it.' : `Checking your ${choices.length} stores…`}</Text>
              </View>
            )}
          </View>
        ) : null}

        {query && !suggesting
          ? ordered.map((a) => (
              <View key={a.retailerId} style={styles.card}>
                <View style={styles.cardHead}>
                  <RetailerBadge retailerId={a.retailerId} name={a.name} size={28} />
                  <Text style={styles.storeName}>{a.name}</Text>
                  {a.sure === 'barcode' ? <Chip label="Same barcode" icon="check" tone="green" /> : null}
                  {a.sure === 'name' ? <Chip label="Same name and size" icon="check" tone="green" /> : null}
                  {a.sure === 'maybe' ? <Chip label={mode === 'product' ? 'Closest match; check it' : 'Its top result; check the name'} tone="plain" /> : null}
                </View>
                {a.status === 'found' && a.product ? (
                  <Result
                    product={a.product}
                    onOpen={() => router.push({ pathname: '/product', params: { store: a.retailerId, q: a.query!, product: a.product!.id, ...productParams } })}
                  />
                ) : a.status === 'checking' || a.status === 'waiting' ? (
                  <View style={styles.checkingRow}>
                    <ActivityIndicator size="small" color={colors.orange} />
                    <Text style={styles.small}>{a.status === 'waiting' ? 'Next in line' : `Checking ${a.name}…`}</Text>
                  </View>
                ) : (
                  <Text style={styles.small}>
                    {a.status === 'failed' ? `Couldn’t check (${reasonWords(a.reason)}).` : mode === 'words' ? 'No close match.' : 'Didn’t find this product.'}
                  </Text>
                )}
                {a.more.length ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityState={{ expanded: openMore === a.retailerId }}
                    onPress={() => setOpenMore(openMore === a.retailerId ? null : a.retailerId)}
                    hitSlop={{ top: 12, bottom: 12, left: 8, right: 8 }}
                  >
                    <Text style={styles.more}>{openMore === a.retailerId ? 'Fewer' : `${a.more.length} more at ${a.name}`}</Text>
                  </Pressable>
                ) : null}
                {openMore === a.retailerId
                  ? a.more.map((p) => (
                      <Result
                        key={p.id}
                        product={p}
                        compact
                        onOpen={() => router.push({ pathname: '/product', params: { store: a.retailerId, q: a.query!, product: p.id, ...productParams } })}
                      />
                    ))
                  : null}
              </View>
            ))
          : null}
      </ScrollView>
      {query && itemName && !suggesting ? (
        <View style={[styles.footer, { paddingBottom: insets.bottom + 12 }]} onLayout={onFooterLayout}>
          <Pill label={`Add “${itemName}” to a list`} icon="plus" variant="dark" onPress={addToList} />
        </View>
      ) : null}
    </View>
  );
}

function Result({ product, onOpen, compact }: { product: Product; onOpen: () => void; compact?: boolean }) {
  const unit = unitPriceOf(product);
  return (
    <Pressable accessibilityRole="button" onPress={onOpen} style={({ pressed }) => [styles.result, compact && styles.resultCompact, pressed && styles.pressed]}>
      <ProductThumb product={product} size={compact ? 44 : 56} />
      <View style={styles.flex}>
        <Text style={styles.productName} numberOfLines={2}>
          {product.name}
        </Text>
        {unit ? <Text style={styles.unit}>{unit.text}</Text> : null}
        <SaleChip product={product} />
      </View>
      <Text style={styles.price}>{product.price != null ? money(product.price) : ''}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.paper },
  content: { paddingHorizontal: 16, gap: 12 },
  flex: { flex: 1, gap: 3 },
  pressed: { opacity: 0.8 },
  small: { fontFamily: fonts.body, fontSize: 14, lineHeight: 19, color: colors.muted },
  section: { fontFamily: fonts.semibold, fontSize: 13, letterSpacing: 0.6, textTransform: 'uppercase', color: colors.muted },
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: colors.card,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.line,
    paddingLeft: 16,
    paddingRight: 6,
    minHeight: 52,
  },
  input: { flex: 1, minWidth: 0, fontFamily: fonts.body, fontSize: 17, color: colors.ink, paddingVertical: 12 },
  go: { width: 40, height: 40, borderRadius: 20, backgroundColor: colors.orange, alignItems: 'center', justifyContent: 'center' },
  recent: { gap: 8 },
  recentRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  recentChip: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.line, borderRadius: radius.pill, paddingVertical: 7, paddingHorizontal: 12 },
  recentText: { fontFamily: fonts.medium, fontSize: 14, color: colors.ink },
  summary: { backgroundColor: colors.blueTint, borderRadius: radius.lg, padding: 16, gap: 4 },
  summaryLabel: { fontFamily: fonts.semibold, fontSize: 13, letterSpacing: 0.6, textTransform: 'uppercase', color: colors.blue },
  summaryTitle: { fontFamily: fonts.display, fontSize: 22, lineHeight: 28, color: colors.ink },
  checkingRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  card: { backgroundColor: colors.card, borderRadius: radius.lg, padding: 14, gap: 10, ...shadow.card },
  cardHead: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8 },
  storeName: { fontFamily: fonts.semibold, fontSize: 16, color: colors.ink, marginRight: 'auto' },
  result: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  resultCompact: { paddingTop: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  productName: { fontFamily: fonts.medium, fontSize: 15, lineHeight: 20, color: colors.ink },
  unit: { fontFamily: fonts.body, fontSize: 13, color: colors.muted },
  price: { fontFamily: fonts.semibold, fontSize: 18, color: colors.ink },
  more: { fontFamily: fonts.semibold, fontSize: 14, color: colors.orangeText },
  footer: { position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 20, paddingTop: 12, backgroundColor: 'rgba(246,244,240,0.96)' },
});
