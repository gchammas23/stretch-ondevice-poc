import * as Sharing from 'expo-sharing';
import { useLocalSearchParams } from 'expo-router';
import React, { useRef, useState } from 'react';
import { Platform, ScrollView, Share, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { captureRef } from 'react-native-view-shot';
import type { GroceryList } from '../../../lists/types';
import { rankBaskets, type Basket } from '../../../pricing/basket';
import { MODE_WORDS, orderable } from '../../../pricing/onlineCost';
import { useComparison, useList, usePricingRun, useSettings, useStoreChoices } from '../../../state/AppProvider';
import { Pill } from '../../../ui/controls';
import { deviceWord } from '../../../ui/device';
import { brandColor, RetailerBadge } from '../../../ui/RetailerBadge';
import { ScreenHeader } from '../../../ui/ScreenHeader';
import { colors, fonts, money, radius } from '../../../ui/theme';
import { useNow } from '../../../ui/useNow';

export default function ShareScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const list = useList(id);
  if (!list) return <ScreenHeader title="Share" subtitle="This list was deleted." />;
  return <ShareCardScreen list={list} />;
}

/** What a list's comparison says, for a card: the winner, what it saves against the dearest store, and the rest. */
function summaryOf(baskets: Basket[], cost: (b: Basket) => number) {
  const complete = baskets.filter((b) => b.complete && b.found > 0);
  const most = Math.max(0, ...complete.map((b) => b.found));
  const ranked = rankBaskets(complete.filter((b) => b.found === most)).sort((a, b) => cost(a) - cost(b));
  if (ranked.length < 2) return null;
  const winner = ranked[0];
  const priciest = ranked[ranked.length - 1];
  return { ranked, winner, priciest, saves: Math.round((cost(priciest) - cost(winner)) * 100) / 100, items: most };
}

/**
 * A picture of a list's result, made on the phone, to send in Messages or post: what the cheapest store saves, the
 * stores side by side, and that the prices were read live on the phone.
 */
function ShareCardScreen({ list }: { list: GroceryList }) {
  const insets = useSafeAreaInsets();
  const settings = useSettings();
  const choices = useStoreChoices();
  const run = usePricingRun(list.id);
  const { baskets, driving, extra, online, mode, countCoupons } = useComparison(list, run);
  const card = useRef<View>(null);
  const [busy, setBusy] = useState(false);
  const now = useNow(60_000);
  const nameOf = (rid: string) => choices.find((c) => c.config.id === rid)?.config.name ?? run?.stores[rid]?.name ?? rid;
  // Each store's total the way the user shops: driving there, and ordering online, its fees, when they count. Only
  // stores that take the order that way are on the card.
  const cost = (b: Basket) => (settings.rankBy === 'unit' ? (b.unitTotal ?? b.total) : b.total) + (extra?.[b.retailerId] ?? 0);
  const summary = summaryOf(orderable(baskets, online), cost);
  const how = [mode === 'store' ? '' : `${MODE_WORDS[mode]}, fees included`, countCoupons ? 'clipped coupons counted' : ''].filter(Boolean).join(', ');
  const seconds = run?.finishedAt ? ((run.finishedAt - run.startedAt) / 1000).toFixed(1) : undefined;
  const date = new Date(run?.finishedAt ?? now).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

  if (!summary) {
    return (
      <View style={styles.screen}>
        <ScreenHeader title="Share your savings" />
        <Text style={[styles.body, styles.margin]}>
          {mode !== 'store' && summaryOf(baskets, cost)
            ? `Fewer than two of your stores take ${mode} orders, so there’s nothing to compare ${MODE_WORDS[mode]}.`
            : 'Price the list at two or more stores first: the card shows how they compare.'}
        </Text>
      </View>
    );
  }
  const { ranked, winner, priciest, saves, items } = summary;
  const most = Math.max(...ranked.map(cost));
  const text = `${money(saves)} less at ${nameOf(winner.retailerId)} than ${nameOf(priciest.retailerId)} for my ${list.name} list (${items} items${how ? `, ${how}` : ''}). Prices read live on my ${deviceWord} from ${ranked.length} stores’ own websites${seconds ? ` in ${seconds} s` : ''}, with Stretch.`;

  const share = async () => {
    setBusy(true);
    try {
      // A picture where the phone can make one; the words otherwise.
      if (Platform.OS !== 'web' && (await Sharing.isAvailableAsync())) {
        const uri = await captureRef(card, { format: 'png', quality: 1, result: 'tmpfile' });
        await Sharing.shareAsync(uri, { mimeType: 'image/png', UTI: 'public.png', dialogTitle: 'Share your savings' });
      } else {
        await Share.share({ message: text });
      }
    } catch {
      await Share.share({ message: text }).catch(() => {});
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.screen}>
      <ScreenHeader title="Share your savings" subtitle="A picture of this list’s result, made on this phone." />
      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 32 }]}>
        {/* The card itself: what gets shared, as a picture. */}
        <View ref={card} collapsable={false} style={styles.card} accessible accessibilityLabel={text}>
          <Text style={styles.wordmark}>Stretch</Text>
          <Text style={styles.headline}>
            {money(saves)} less at {nameOf(winner.retailerId)}
          </Text>
          <Text style={styles.sub}>
            than {nameOf(priciest.retailerId)}, for my {list.name} list · {items} items{how ? ` · ${how}` : ''}
            {driving ? ' · driving there included' : ''}
          </Text>
          <View style={styles.bars}>
            {ranked.map((b, i) => (
              <View key={b.retailerId} style={styles.barRow}>
                <RetailerBadge retailerId={b.retailerId} name={nameOf(b.retailerId)} size={30} />
                <View style={styles.barTrack}>
                  <View style={[styles.bar, { width: `${Math.max(12, (cost(b) / most) * 100)}%`, backgroundColor: i === 0 ? colors.orange : brandColor(b.retailerId) }]} />
                </View>
                <Text style={[styles.barTotal, i === 0 && { color: colors.orangeText }]}>{money(cost(b))}</Text>
              </View>
            ))}
          </View>
          <View style={styles.foot}>
            <View style={styles.liveDot} />
            <Text style={styles.footText}>
              Read live on my {deviceWord} from {ranked.length} stores’ own websites{seconds ? ` in ${seconds} s` : ''} · {date}
            </Text>
          </View>
        </View>
        <Pill label={busy ? 'Making the picture…' : 'Share'} icon="share" variant="orange" busy={busy} onPress={() => void share()} />
        <Text style={styles.small}>Only this picture is shared: no list, location or account goes with it.</Text>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.paper },
  content: { paddingHorizontal: 16, gap: 14 },
  margin: { marginHorizontal: 16 },
  body: { fontFamily: fonts.body, fontSize: 15, lineHeight: 21, color: colors.ink },
  small: { fontFamily: fonts.body, fontSize: 13, lineHeight: 18, color: colors.muted, textAlign: 'center' },
  card: { backgroundColor: colors.blush, borderRadius: radius.lg, padding: 22, gap: 10 },
  wordmark: { fontFamily: fonts.display, fontSize: 22, color: colors.ink },
  headline: { fontFamily: fonts.display, fontSize: 38, lineHeight: 44, color: colors.ink, marginTop: 6 },
  sub: { fontFamily: fonts.medium, fontSize: 16, lineHeight: 22, color: colors.muted },
  bars: { gap: 10, marginTop: 10 },
  barRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  barTrack: { flex: 1, height: 14, borderRadius: 7, backgroundColor: 'rgba(31, 31, 31, 0.07)', overflow: 'hidden' },
  bar: { height: 14, borderRadius: 7 },
  barTotal: { width: 72, textAlign: 'right', fontFamily: fonts.semibold, fontSize: 15, color: colors.ink },
  foot: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 10 },
  liveDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.orange },
  footText: { flex: 1, fontFamily: fonts.body, fontSize: 13, lineHeight: 18, color: colors.muted },
});
