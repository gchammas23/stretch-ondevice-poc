import { router, usePathname } from 'expo-router';
import React, { useEffect, useRef, useState } from 'react';
import { Animated, Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { comparisonNotice } from '../cloud/compare';
import { cloudRunner } from '../cloud/runner';
import { jobNotice } from '../cloud/words';
import { dayOf } from '../onDevice/adPage';
import { compareStores, couponListsFor } from '../pricing/comparison';
import { memberRun } from '../pricing/member';
import { runMs } from '../pricing/pricingEngine';
import { feeContexts, MODE_WORDS } from '../pricing/onlineCost';
import { useApp } from '../state/AppProvider';
import { storeChoices } from '../state/storeChoices';
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
  icon: 'sparkle' | 'arrowDown' | 'cloud';
}

/**
 * "Sunday BBQ is priced": slides in on whatever screen you're on when a list finishes pricing in the background,
 * unless you're on one of that list's own screens, which show the result already. Tap to see the stores. Screen
 * readers hear it, and with one on it stays until it's closed.
 */
export function PricingBanner() {
  const { engine, store, bundle, onDrops, fees, coupons } = useApp();
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
          if (!raw) continue;
          if (!raw.finishedAt) {
            running.current.add(list.id);
            continue;
          }
          if (!running.current.delete(list.id)) continue; // Finished before, not just now.
          if ((runMs(raw) ?? 0) < ANNOUNCE_AFTER_MS) continue;
          // Already looking at that list: its own screens show the result. So does presenter mode.
          if (where.current === `/list/${list.id}` || where.current.startsWith(`/list/${list.id}/`) || where.current === '/present') continue;
          const { usuals, settings } = store.getState();
          // The same pick as Find a store's (see compareStores): member prices, how the user ranks and shops, driving,
          // online fees and counted coupons included.
          const c = compareStores(list, memberRun(raw, settings.memberships), {
            usuals,
            rankBy: settings.rankBy,
            drive: settings.drive,
            chosen: settings.chosenStores,
            mode: settings.shopMode,
            ctxOf: feeContexts(bundle.retailers, (id, url) => fees.figures(id, url), settings.onlinePlans),
            countCoupons: settings.countCoupons,
            couponLists: couponListsFor(storeChoices(settings, bundle.retailers), coupons.all(), settings.signedInAt),
            today: dayOf(Date.now()),
          });
          const pick = c.pick;
          const name = pick && (bundle.retailers.find((r) => r.id === pick.retailerId)?.name ?? pick.retailerId);
          const how = `${c.mode === 'store' ? '' : ` ${MODE_WORDS[c.mode]}`}${pick && c.countCoupons && c.coupons[pick.retailerId]?.amount ? ', with coupons' : ''}`;
          setNote({
            href: `/list/${list.id}/compare`,
            title: `${list.name} is priced`,
            body: pick && name ? `Stretch’s pick: ${name} · ${money(c.orderTotal(pick))}${how}` : 'See how the stores compare.',
            icon: 'sparkle',
          });
        }
      }),
    [engine, store, bundle.retailers, fees, coupons],
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

  // A cloud search finished (see src/cloud): its notification says so too, on and off screen.
  useEffect(
    () =>
      cloudRunner.onFinished((job) => {
        if (where.current === `/cloud/${job.id}`) return;
        const { title, body } = jobNotice(job);
        setNote({ href: `/cloud/${job.id}`, title, body, icon: 'cloud' });
      }),
    [],
  );

  // A Phone vs. cloud comparison finished: its notification says so too.
  useEffect(
    () =>
      cloudRunner.onCompared((comparison) => {
        if (where.current === `/phone-vs-cloud/${comparison.id}`) return;
        const { title, body } = comparisonNotice(comparison);
        setNote({ href: `/phone-vs-cloud/${comparison.id}`, title, body, icon: 'cloud' });
      }),
    [],
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
          accessibilityHint={
            note.icon === 'sparkle'
              ? 'Opens Find a store for this list'
              : note.icon === 'cloud'
                ? note.href.startsWith('/phone-vs-cloud/')
                  ? 'Opens the comparison'
                  : 'Opens the cloud search'
                : 'Opens the watchlist'
          }
          onPress={() => {
            setNote(null);
            router.push(note.href);
          }}
          style={({ pressed }) => [styles.main, pressed && styles.pressed]}
        >
          <Icon name={note.icon} size={18} color={note.icon === 'arrowDown' ? colors.green : colors.blue} />
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
