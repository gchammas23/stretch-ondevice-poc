import React, { useEffect, useRef, useState } from 'react';
import { Pressable, Share, StyleSheet, Text, View } from 'react-native';
import { bytesText, seconds } from '../onDevice/scrapeFeed';
import { connectionWords, storeTuner } from '../onDevice/tuning';
import { ago } from '../pricing/age';
import type { Basket } from '../pricing/basket';
import { runMs, type PricingRun } from '../pricing/pricingEngine';
import { scorecard, scorecardText } from '../pricing/scorecard';
import { announce } from './a11y';
import { Pill, TEXT_BUTTON_SLOP } from './controls';
import { deviceWord } from './device';
import { Icon } from './Icon';
import { RaceLanes } from './Race';
import { colors, fonts, radius, shadow } from './theme';
import { useNow } from './useNow';

// Find a store's top: the live banner while a list's prices are read (the race), the scorecard once they're in,
// and the note when the phone's connection dropped rather than the stores.

export function LiveBanner({
  run,
  baskets,
  nameOf,
  listName,
  watching,
  onWatch,
  onStop,
  onRefresh,
}: {
  run: PricingRun;
  baskets: Basket[];
  nameOf: (retailerId: string) => string;
  listName: string;
  watching: boolean;
  onWatch: () => void;
  onStop: () => void;
  onRefresh: () => void;
}) {
  const now = useNow(run.finishedAt ? 30_000 : 1000);
  const [open, setOpen] = useState(false);
  const stores = Object.values(run.stores);
  const total = stores.reduce((n, s) => n + s.total, 0);
  const settled = stores.reduce((n, s) => n + s.settled, 0);
  const active = stores.filter((s) => s.status === 'running').length;
  const results = Object.values(run.results).flatMap((r) => Object.values(r));
  const read = results.filter((r) => r.status === 'done' && r.at);
  const oldest = read.length ? Math.min(...read.map((r) => r.at!)) : undefined;
  // Searched in this run, not saved from earlier, nor found in another item's search.
  const live = read.filter((r) => !r.cached && !r.sharedWith && r.at! >= run.startedAt).length;
  const shownMeanwhile = results.filter((r) => r.stale && r.products.length && (r.status === 'queued' || r.status === 'searching'));
  const meanwhileAt = shownMeanwhile.length ? Math.min(...shownMeanwhile.map((r) => r.at ?? now)) : undefined;

  if (!run.finishedAt) {
    return (
      <View style={[styles.banner, styles.bannerLive]}>
        <View style={styles.bannerHead}>
          <Icon name="zap" size={18} color={colors.orange} />
          <Text style={styles.bannerTitle}>{meanwhileAt ? 'Updating prices live from this phone' : 'Checking prices live from this phone'}</Text>
        </View>
        {meanwhileAt ? <Text style={styles.bannerText}>Showing prices from {ago(now - meanwhileAt)} until the new ones land.</Text> : null}
        {/* The race: each store's lane fills as its prices come in, with its own stopwatch. */}
        <RaceLanes run={run} baskets={baskets} nameOf={nameOf} />
        <View style={styles.bannerFoot}>
          <Text style={styles.bannerText}>
            {settled} of {total} searches{active > 1 ? ` · ${active} stores at once` : ''} · {seconds(now - run.startedAt)}
          </Text>
          {!watching ? (
            <Pressable onPress={onWatch} hitSlop={TEXT_BUTTON_SLOP} accessibilityRole="button" accessibilityHint="Shows the store pages this phone is reading">
              <Text style={styles.bannerAction}>Watch</Text>
            </Pressable>
          ) : null}
          <Pressable onPress={onStop} hitSlop={TEXT_BUTTON_SLOP} accessibilityRole="button" accessibilityLabel="Stop checking prices">
            <Text style={styles.bannerAction}>Stop</Text>
          </Pressable>
        </View>
      </View>
    );
  }
  const card = scorecard(run);
  return (
    <View style={styles.banner}>
      <View style={styles.bannerHead}>
        <Icon name="phone" size={18} color={colors.green} />
        <Text style={styles.bannerTitle}>
          {live && card.products
            ? `${card.products} prices from ${card.storesSearched} ${card.storesSearched === 1 ? 'store' : 'stores'} in ${seconds(runMs(run)!)}, on this ${deviceWord}`
            : `Prices read live from this ${deviceWord}`}
        </Text>
      </View>
      <View style={styles.bannerFoot}>
        <Text style={styles.bannerText}>
          {live
            ? `${live} searches${card.firstMs !== undefined ? ` · first price after ${seconds(card.firstMs)}` : ''}${card.bytes ? ` · about ${bytesText(card.bytes)}` : ''}${
                card.bytesSaved ? `, ${bytesText(card.bytesSaved)} saved` : ''
              }`
            : 'Saved from earlier'}
          {oldest ? ` · oldest price ${ago(now - oldest)}` : ''}
        </Text>
        {live ? (
          <Pressable
            onPress={() => setOpen(!open)}
            hitSlop={TEXT_BUTTON_SLOP}
            accessibilityRole="button"
            accessibilityLabel={open ? 'Hide scorecard' : 'Scorecard'}
            accessibilityState={{ expanded: open }}
          >
            <Text style={styles.bannerAction}>{open ? 'Hide' : 'Scorecard'}</Text>
          </Pressable>
        ) : null}
        <Pressable onPress={onRefresh} hitSlop={TEXT_BUTTON_SLOP} accessibilityRole="button" accessibilityLabel="Refresh prices">
          <Text style={styles.bannerAction}>Refresh</Text>
        </Pressable>
      </View>
      {open ? (
        <View style={styles.score}>
          {card.stores.map((s) => (
            <View key={s.retailerId} style={styles.scoreRow}>
              <Text style={styles.scoreName} numberOfLines={1}>
                {s.name}
              </Text>
              <Text style={styles.scoreText}>
                {!s.searches
                  ? s.saved
                    ? `${s.saved} saved from earlier`
                    : 'nothing searched'
                  : [
                      `${s.ok}/${s.searches} worked`,
                      s.totalMs !== undefined ? seconds(s.totalMs) : null,
                      s.medianMs !== undefined ? `${seconds(s.medianMs)} each` : null,
                      s.api ? 'official API' : null,
                      s.direct ? `${s.direct} direct` : null,
                      s.pageLoads ? `${s.pageLoads} page ${s.pageLoads === 1 ? 'load' : 'loads'}` : null,
                      s.reused ? `${s.reused} reused page` : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
              </Text>
            </View>
          ))}
          <Pressable
            accessibilityRole="button"
            onPress={() =>
              void Share.share({
                message: scorecardText(card, `${listName}: prices read on this ${deviceWord}, ${new Date(run.startedAt).toLocaleString('en-US')}`),
              }).catch(() => {})
            }
            style={styles.shareScore}
          >
            <Icon name="share" size={16} color={colors.orange} />
            <Text style={styles.bannerAction}>Share scorecard</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

/**
 * When every store failed within seconds of each other during this run: the phone's connection dropped, not the
 * stores, so none of them is cooling down, and Try again searches them all once it's back.
 */
export function ConnectionNote({ run, nameOf, onRetry }: { run: PricingRun; nameOf: (retailerId: string) => string; onRetry: () => void }) {
  const now = useNow(5000);
  const drop = storeTuner.connection();
  const during = !!drop && drop.to >= run.startedAt && now - drop.to < 60 * 60_000;
  // Screen readers hear it once, when it happens.
  const told = useRef<number | null>(null);
  useEffect(() => {
    if (!during || !drop || told.current === drop.from) return;
    told.current = drop.from;
    announce('The connection dropped: every store failed within seconds. None of them is cooling down.');
  });
  if (!during || !drop) return null;
  return (
    <View style={[styles.card, styles.dropCard]}>
      <View style={styles.pickHead}>
        <Icon name="alert" size={16} color={colors.amber} />
        <Text style={[styles.pickLabelInk, { color: colors.amber }]} accessibilityRole="header">
          The connection dropped
        </Text>
      </View>
      <Text style={styles.small}>{connectionWords(drop, nameOf, deviceWord)}</Text>
      <Pill label="Try every store again" icon="refresh" small variant="outline" onPress={onRetry} style={styles.alignStart} />
    </View>
  );
}

const styles = StyleSheet.create({
  alignStart: { alignSelf: 'flex-start' },
  small: { fontFamily: fonts.body, fontSize: 14, lineHeight: 19, color: colors.muted },
  banner: { backgroundColor: colors.card, borderRadius: radius.lg, padding: 16, gap: 10, borderWidth: 1, borderColor: colors.line },
  bannerLive: { borderColor: '#F7C2B3', backgroundColor: '#FFF6F2' },
  bannerHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  bannerTitle: { fontFamily: fonts.semibold, fontSize: 15, color: colors.ink },
  bannerFoot: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  bannerText: { flex: 1, fontFamily: fonts.body, fontSize: 13, color: colors.muted },
  bannerAction: { fontFamily: fonts.semibold, fontSize: 14, color: colors.orangeText },
  pickHead: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingBottom: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  pickLabelInk: { fontFamily: fonts.semibold, fontSize: 15, color: colors.ink },
  score: { gap: 6, paddingTop: 10, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  scoreRow: { gap: 1 },
  scoreName: { fontFamily: fonts.semibold, fontSize: 14, color: colors.ink },
  scoreText: { fontFamily: fonts.body, fontSize: 13, lineHeight: 18, color: colors.muted },
  shareScore: { flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start', minHeight: 44 },
  card: { backgroundColor: colors.card, borderRadius: radius.lg, padding: 16, gap: 10, ...shadow.card },
  dropCard: { borderWidth: 1, borderColor: colors.amberTint },
});
