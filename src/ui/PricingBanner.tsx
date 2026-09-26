import { router, usePathname } from 'expo-router';
import React, { useEffect, useRef, useState } from 'react';
import { Animated, Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { basketFor, driveCosts, stretchPick } from '../pricing/basket';
import { memberRun } from '../pricing/member';
import { feeContexts, MODE_WORDS, onlineCosts, orderable, tripCosts } from '../pricing/onlineCost';
import { useApp } from '../state/AppProvider';
import { announce, useScreenReader } from './a11y';
import { Icon } from './Icon';
import { colors, fonts, money, radius, shadow } from './theme';

/** Pricing that finished faster than this happened while you watched; no need to announce it. */
const ANNOUNCE_AFTER_MS = 3000;
const SHOW_MS = 5000;

interface Note {
  /** Where tapping it goes. */
  href: string;
  title: string;
  body: string;
  /** The body as a screen reader should say it, when it has symbols. */
  spoken?: string;
  icon: 'sparkle' | 'arrowDown';
}

/**
 * "Sunday BBQ is priced": slides in on whatever screen you're on when a list finishes pricing in the background,
 * unless you're on one of that list's own screens, which show the result already. Tap to see the stores. Screen
 * readers hear it, and with one on it stays until it's closed.
 */
export function PricingBanner() {
  const { engine, store, bundle, onDrops, fees } = useApp();
  const pathname = usePathname();
  const insets = useSafeAreaInsets();
  const [note, setNote] = useState<Note | null>(null);
  const [slide] = useState(() => new Animated.Value(0));
  const where = useRef(pathname);
  const running = useRef(new Set<string>());
  const screenReader = useScreenReader();
  const { fontScale } = useWindowDimensions();
  const lines = fontScale > 1.3 ? undefined : 1;

  useEffect(() => {
    where.current = pathname;
  }, [pathname]);

  useEffect(
    () =>
      engine.subscribe(() => {
        for (const list of store.getState().lists) {
          const raw = engine.getRun(list.id);
          const run = raw && memberRun(raw, store.getState().settings.memberships);
          if (!run) continue;
          if (!run.finishedAt) {
            running.current.add(list.id);
            continue;
          }
          if (!running.current.delete(list.id)) continue; // Finished before, not just now.
          if (run.finishedAt - run.startedAt < ANNOUNCE_AFTER_MS) continue;
          // Already looking at that list: its own screens show the result.
          if (where.current === `/list/${list.id}` || where.current.startsWith(`/list/${list.id}/`)) continue;
          const { usuals, settings } = store.getState();
          const baskets = run.retailerIds.map((id) => basketFor(list, id, run.results[id], usuals));
          // The same pick as Find a store's: driving included when it counts, and ordering online, the fees.
          const way = settings.shopMode === 'store' ? null : settings.shopMode;
          const driving =
            settings.drive.on && way !== 'delivery'
              ? driveCosts(Object.fromEntries(run.retailerIds.map((id) => [id, settings.chosenStores[id]?.miles])), settings.drive.perMile)
              : undefined;
          const online = way ? onlineCosts(baskets, way, feeContexts(bundle.retailers, (id, url) => fees.figures(id, url), settings.onlinePlans)) : undefined;
          const pick = stretchPick(orderable(baskets, online).filter((b) => b.complete), 'total', tripCosts(driving, online));
          const name = pick && (bundle.retailers.find((r) => r.id === pick.retailerId)?.name ?? pick.retailerId);
          const total = pick ? `${money(online?.[pick.retailerId]?.total ?? pick.total)}${way ? ` ${MODE_WORDS[way]}` : ''}` : '';
          setNote({
            href: `/list/${list.id}/compare`,
            title: `${list.name} is priced`,
            body: pick && name ? `Stretch’s pick: ${name} · ${total}` : 'See how the stores compare.',
            icon: 'sparkle',
          });
        }
      }),
    [engine, store, bundle.retailers, fees],
  );

  // A watched product just got cheaper at a store the phone read.
  useEffect(
    () =>
      onDrops((items) => {
        if (where.current === '/watchlist') return;
        const first = items[0];
        const store = bundle.retailers.find((r) => r.id === first.retailerId)?.name ?? first.retailerId;
        setNote({
          href: '/watchlist',
          title: items.length > 1 ? `${items.length} watched prices dropped` : `Price drop at ${store}`,
          body: `${first.name}: ${money(first.drop!.from)} → ${money(first.drop!.to)}`,
          spoken: `${first.name}: ${money(first.drop!.from)}, now ${money(first.drop!.to)}`,
          icon: 'arrowDown',
        });
      }),
    [onDrops, bundle.retailers],
  );

  useEffect(() => {
    if (!note) return;
    announce(`${note.title}. ${note.spoken ?? note.body}`);
    slide.setValue(0);
    const show = Animated.spring(slide, { toValue: 1, useNativeDriver: true, speed: 16, bounciness: 4 });
    // Five seconds is too short to find it with a screen reader: then it stays until it's closed.
    const animation = screenReader
      ? show
      : Animated.sequence([show, Animated.delay(SHOW_MS), Animated.timing(slide, { toValue: 0, duration: 220, useNativeDriver: true })]);
    animation.start(({ finished }) => {
      if (finished && !screenReader) setNote(null);
    });
    return () => animation.stop();
  }, [note, slide, screenReader]);

  if (!note) return null;
  return (
    <Animated.View
      pointerEvents="box-none"
      style={[
        styles.wrap,
        { top: insets.top + 6, opacity: slide, transform: [{ translateY: slide.interpolate({ inputRange: [0, 1], outputRange: [-24, 0] }) }] },
      ]}
    >
      <View style={styles.banner}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${note.title}. ${note.spoken ?? note.body}`}
          accessibilityHint={note.icon === 'sparkle' ? 'Opens Find a store for this list' : 'Opens the watchlist'}
          onPress={() => {
            setNote(null);
            router.push(note.href);
          }}
          style={({ pressed }) => [styles.main, pressed && styles.pressed]}
        >
          <Icon name={note.icon} size={18} color={note.icon === 'sparkle' ? colors.blue : colors.green} />
          <View style={styles.flex}>
            <Text style={styles.title} numberOfLines={lines}>
              {note.title}
            </Text>
            <Text style={styles.body} numberOfLines={lines}>
              {note.body}
            </Text>
          </View>
          <Text style={styles.view}>View</Text>
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="Close" hitSlop={12} onPress={() => setNote(null)} style={styles.close}>
          <Icon name="close" size={16} color={colors.muted} />
        </Pressable>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  // Above the screens, below a WebView sheet (bot checks and store visits).
  wrap: { position: 'absolute', left: 12, right: 12, zIndex: 5 },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.blueLine,
    paddingVertical: 12,
    paddingLeft: 14,
    paddingRight: 10,
    ...shadow.float,
  },
  main: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 12 },
  close: { width: 28, height: 28, alignItems: 'center', justifyContent: 'center' },
  pressed: { opacity: 0.85 },
  flex: { flex: 1, gap: 2 },
  title: { fontFamily: fonts.semibold, fontSize: 15, color: colors.ink },
  body: { fontFamily: fonts.body, fontSize: 14, color: colors.muted },
  view: { fontFamily: fonts.semibold, fontSize: 15, color: colors.orangeText },
});
