import { router, useLocalSearchParams } from 'expo-router';
import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { GroceryList } from '../../../lists/types';
import { onRetailerSite } from '../../../onDevice/retailerSearch';
import { reasonWords } from '../../../onDevice/scrapeFeed';
import { agreedStores, pricesOf, truthSample, truthSummary, verdictOf, type TruthCheck } from '../../../pricing/truth';
import { useApp, useComparison, useList, usePricingRun } from '../../../state/AppProvider';
import { announce } from '../../../ui/a11y';
import { Chip } from '../../../ui/bits';
import { Pill, tap } from '../../../ui/controls';
import { deviceWord } from '../../../ui/device';
import { Icon } from '../../../ui/Icon';
import { RetailerBadge } from '../../../ui/RetailerBadge';
import { ScreenHeader } from '../../../ui/ScreenHeader';
import { colors, fonts, money, radius, shadow } from '../../../ui/theme';

export default function TruthScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const list = useList(id);
  if (!list) return <ScreenHeader title="Price truth check" subtitle="This list was deleted." />;
  return <Truth list={list} />;
}

const PER_STORE = [3, 5, 10];

/**
 * The price truth check: a sample of the list's prices at each store, each read again from the product's own page
 * on the store's site, on this phone, and how many agree.
 */
function Truth({ list }: { list: GroceryList }) {
  const insets = useSafeAreaInsets();
  const { search, bundle, profiles } = useApp();
  const run = usePricingRun(list.id);
  const { baskets } = useComparison(list, run);
  const [perStore, setPerStore] = useState(3);
  const [checks, setChecks] = useState<TruthCheck[] | null>(null);
  /** Stores whose prices all matched: where their results are was learned from them (their profile). */
  const [taught, setTaught] = useState<string[]>([]);
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );
  const cfgOf = (rid: string) => bundle.retailers.find((r) => r.id === rid);
  const nameOf = (rid: string) => cfgOf(rid)?.name ?? rid;
  const sample = truthSample(baskets, perStore, (rid, url) => {
    const cfg = cfgOf(rid);
    return !!cfg && onRetailerSite(cfg, url);
  });
  const summary = checks ? truthSummary(checks) : null;
  const done = checks ? checks.filter((c) => c.state !== 'waiting' && c.state !== 'checking').length : 0;
  const running = !!checks && done < checks.length;

  const start = async () => {
    tap();
    const list0: TruthCheck[] = sample.map((s) => ({ ...s, state: 'waiting' }));
    setChecks(list0);
    setTaught([]);
    const results = [...list0];
    // One page at a time, like a person clicking through: the pages lane reads them in turn anyway.
    for (let i = 0; i < results.length && alive.current; i++) {
      const c = results[i];
      const cfg = cfgOf(c.retailerId);
      results[i] = { ...c, state: 'checking' };
      setChecks([...results]);
      try {
        if (!cfg) throw Object.assign(new Error('no_store'), { reason: 'no_store' });
        const details = await search.readProduct(cfg, c.product);
        results[i] = { ...c, state: verdictOf(pricesOf(c.product), details.price), ...(details.price !== undefined ? { pagePrice: details.price } : {}) };
      } catch (e) {
        results[i] = { ...c, state: 'unreadable', reason: (e as { reason?: string })?.reason ?? String(e) };
      }
      if (alive.current) setChecks([...results]);
    }
    if (alive.current) {
      const s = truthSummary(results);
      // Prices that all match confirm the list they came from: it becomes the store's profile, where it isn't already.
      setTaught(agreedStores(results).filter((a) => !!profiles.confirm(a.retailerId, a.productIds)).map((a) => a.retailerId));
      announce(s.checked ? `${s.same} of ${s.checked} prices match their product pages.` : 'No product page could be read.');
    }
  };

  return (
    <View style={styles.screen}>
      <ScreenHeader title="Price truth check" subtitle="Each price read again from the product’s own page on the store’s site." />
      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 32 }]}>
        {!checks ? (
          <View style={styles.card}>
            <Text style={styles.body}>
              For {list.name}, this {deviceWord} opens each sampled product’s own page on the store’s site, hidden, reads the price there, and
              compares it with the price the search got. One page at a time.
            </Text>
            <Text style={styles.label}>Prices per store</Text>
            <View style={styles.chips} accessibilityRole="radiogroup">
              {PER_STORE.map((n) => (
                <Pressable
                  key={n}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: perStore === n }}
                  onPress={() => setPerStore(n)}
                  style={[styles.chip, perStore === n && styles.chipOn]}
                >
                  <Text style={[styles.chipText, perStore === n && styles.chipTextOn]}>{n}</Text>
                </Pressable>
              ))}
            </View>
            <Pill
              label={sample.length ? `Check ${sample.length} prices` : 'Price the list first'}
              icon="check"
              variant="orange"
              disabled={!sample.length}
              onPress={() => void start()}
            />
            {!sample.length ? <Text style={styles.small}>Open Find a store for this list: its prices are what gets checked.</Text> : null}
          </View>
        ) : (
          <View style={styles.card}>
            {summary && summary.checked ? (
              <>
                <Text style={styles.big}>
                  {summary.same} of {summary.checked} match
                </Text>
                <Chip label={`${Math.round((summary.rate ?? 0) * 100)}% the same as the product page`} tone={(summary.rate ?? 0) >= 0.9 ? 'green' : 'orange'} icon="check" />
              </>
            ) : (
              <Text style={styles.big}>{running ? 'Checking…' : 'No page answered'}</Text>
            )}
            {running ? (
              <View style={styles.row}>
                <ActivityIndicator size="small" color={colors.orange} />
                <Text style={styles.small}>
                  Checked {done} of {checks.length}
                </Text>
              </View>
            ) : summary?.unreadable ? (
              <Text style={styles.small}>{summary.unreadable} product pages didn’t show a price the phone could read.</Text>
            ) : null}
            <View style={styles.stores}>
              {Object.entries(summary?.byStore ?? {}).map(([rid, s]) => (
                <View key={rid} style={styles.storeChip}>
                  <RetailerBadge retailerId={rid} name={nameOf(rid)} size={22} />
                  <Text style={styles.small}>
                    {s.same}/{s.checked}
                  </Text>
                </View>
              ))}
            </View>
            {taught.length ? (
              <Text style={styles.small}>
                These prices confirmed where {taught.map(nameOf).join(' and ')}’s results are: {taught.length === 1 ? 'its' : 'their'} searches read
                there first from now on (Store health, Where each store’s results are).
              </Text>
            ) : null}
          </View>
        )}

        {checks?.map((c, i) => (
          <Pressable
            key={`${c.retailerId}-${c.product.id}-${i}`}
            accessibilityRole="button"
            accessibilityHint="Opens the X-ray of this price"
            onPress={() => router.push({ pathname: '/xray', params: { retailerId: c.retailerId, productId: c.product.id } })}
            style={({ pressed }) => [styles.checkRow, pressed && styles.pressed]}
          >
            <RetailerBadge retailerId={c.retailerId} name={nameOf(c.retailerId)} size={30} />
            <View style={styles.flex}>
              <Text style={styles.item}>{c.itemName}</Text>
              <Text style={styles.small} numberOfLines={2}>
                {c.product.name}
              </Text>
              <Text style={styles.small}>
                Search {c.product.price !== null ? money(c.product.price) : '—'}
                {c.pagePrice !== undefined ? ` · page ${money(c.pagePrice)}` : ''}
                {c.state === 'unreadable' ? ` · ${c.reason ? reasonWords(c.reason) : 'the page showed no price'}` : ''}
              </Text>
            </View>
            {c.state === 'checking' ? (
              <ActivityIndicator size="small" color={colors.orange} />
            ) : c.state === 'same' ? (
              <Icon name="check" size={20} color={colors.green} strokeWidth={2.6} />
            ) : c.state === 'different' ? (
              <Icon name="alert" size={20} color={colors.amber} />
            ) : c.state === 'unreadable' ? (
              <Icon name="info" size={18} color={colors.faint} />
            ) : null}
          </Pressable>
        ))}

        {checks && !running ? (
          <>
            <Text style={styles.note}>
              A product page can show another price than the search when it’s for another store (sites often pick their own store for product
              pages), or when a price changed in between. Tap a price for its X-ray.
            </Text>
            <Pill label="Check again" icon="refresh" variant="outline" onPress={() => setChecks(null)} />
          </>
        ) : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.paper },
  content: { paddingHorizontal: 16, gap: 12 },
  flex: { flex: 1, gap: 2 },
  pressed: { opacity: 0.8 },
  card: { backgroundColor: colors.card, borderRadius: radius.lg, padding: 16, gap: 10, ...shadow.card },
  body: { fontFamily: fonts.body, fontSize: 15, lineHeight: 21, color: colors.ink },
  small: { fontFamily: fonts.body, fontSize: 13, lineHeight: 18, color: colors.muted },
  note: { fontFamily: fonts.body, fontSize: 13, lineHeight: 18, color: colors.muted },
  label: { fontFamily: fonts.semibold, fontSize: 13, letterSpacing: 0.6, textTransform: 'uppercase', color: colors.muted },
  big: { fontFamily: fonts.display, fontSize: 30, color: colors.ink },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  chips: { flexDirection: 'row', gap: 8 },
  chip: { minWidth: 48, minHeight: 36, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 12, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.line },
  chipOn: { backgroundColor: colors.pill, borderColor: colors.pill },
  chipText: { fontFamily: fonts.medium, fontSize: 15, color: colors.ink },
  chipTextOn: { color: '#ffffff' },
  stores: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  storeChip: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  checkRow: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: colors.card, borderRadius: radius.md, padding: 12, ...shadow.card },
  item: { fontFamily: fonts.semibold, fontSize: 15, color: colors.ink },
});
