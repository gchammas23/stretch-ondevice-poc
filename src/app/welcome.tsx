import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { queryKey } from '../lists/types';
import { reasonWords } from '../onDevice/scrapeFeed';
import { lineFor } from '../pricing/basket';
import { STORES_AT_ONCE } from '../pricing/pricingEngine';
import { hostOf } from '../pricing/receipt';
import { useApp, usePricingRun, useSettings, useSetupDeps } from '../state/AppProvider';
import { storeChoices } from '../state/storeChoices';
import { LOCATE_PROBLEMS, zipFromDevice } from '../state/deviceLocation';
import { isUsZip, setUpStores } from '../state/storeSetup';
import { announce, focusOn, hiddenFromScreenReaders, useScreenReader } from '../ui/a11y';
import { Pill, tap } from '../ui/controls';
import { deviceWord } from '../ui/device';
import type { RetailerConfig } from '../onDevice/types';
import { Icon, type IconName } from '../ui/Icon';
import { RetailerBadge } from '../ui/RetailerBadge';
import { colors, fonts, money, radius, shadow } from '../ui/theme';

const POINTS: { icon: IconName; title: string; body: string }[] = [
  { icon: 'store', title: 'Every store near you', body: 'Real prices from Walmart, Target, Kroger and more, before you leave the house.' },
  { icon: 'phone', title: `Read right on this ${deviceWord}`, body: 'Your phone checks each store’s own website, live. No middleman in between.' },
  { icon: 'sparkle', title: 'Your best trip', body: 'The cheapest store for your whole list, or a split trip when two stores save more.' },
];

/**
 * The first-run welcome: what Stretch does, where you shop, which stores to compare. Shown until it's finished or
 * skipped (the root layout guards it with Stack.Protected), then the app opens on your lists.
 */
export default function WelcomeScreen() {
  const insets = useSafeAreaInsets();
  const { store, bundle, engine, pool } = useApp();
  const settings = useSettings();
  const deps = useSetupDeps();
  const [step, setStep] = useState(0);
  const [zip, setZip] = useState(settings.zip);
  const [locating, setLocating] = useState(false);
  const [regional, setRegional] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const retailers = bundle.retailers.filter((r) => r.enabled);
  const [chosen, setChosen] = useState<string[]>(() => settings.retailerIds.filter((id) => retailers.some((r) => r.id === id)));
  const screenReader = useScreenReader();
  const { fontScale } = useWindowDimensions();
  // Each step's heading takes the screen reader's focus when the step changes, and says which step it is.
  const heading = useRef<Text>(null);
  useEffect(() => (step ? focusOn(heading) : undefined), [step]);
  const stepOf = ` Step ${step + 1} of 4.`;

  // The first minute: one staple, read live at the stores just picked, before any list.
  const watchItWork = () => {
    const choices = storeChoices({ ...store.getState().settings, zip: isUsZip(zip) ? zip : '', retailerIds: chosen }, bundle.retailers);
    engine.start(WELCOME_RUN, [STAPLE], choices, { refresh: true });
    setStep(3);
  };

  const finish = () => {
    if (chosen.length) store.setRetailers(chosen);
    // Each retailer's nearest store is found in the background while the lists open.
    if (isUsZip(zip)) void setUpStores(zip, deps);
    store.setOnboarded(true);
  };
  const fromMyLocation = async () => {
    setLocating(true);
    setProblem(null);
    const found = await zipFromDevice();
    setLocating(false);
    if (!found.ok) {
      setProblem(LOCATE_PROBLEMS[found.reason]);
      return;
    }
    setZip(found.zip);
    announce(`Your ZIP code is ${found.zip.split('').join(' ')}.`);
  };
  const toggle = (id: string) => {
    tap();
    setChosen((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));
  };
  const tile = (r: RetailerConfig) => {
    const on = chosen.includes(r.id);
    return (
      <Pressable
        key={r.id}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: on }}
        accessibilityLabel={r.region ? `${r.name}, ${r.region}` : r.name}
        onPress={() => toggle(r.id)}
        style={[styles.storeTile, r.sisterOf && styles.storeTileWide, on && styles.storeTileOn]}
      >
        <RetailerBadge retailerId={r.id} name={r.name} size={32} />
        <View style={styles.flex}>
          <Text style={styles.storeName} numberOfLines={fontScale > 1.3 ? undefined : 2}>
            {r.name}
          </Text>
          {r.region ? (
            <Text style={styles.storeRegion} numberOfLines={fontScale > 1.3 ? undefined : 1}>
              {r.region}
            </Text>
          ) : null}
        </View>
        <View style={[styles.tick, on && styles.tickOn]}>{on ? <Icon name="check" size={13} color="#ffffff" strokeWidth={3} /> : null}</View>
      </Pressable>
    );
  };

  return (
    <KeyboardAvoidingView style={[styles.screen, step === 0 && styles.blush]} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={[styles.top, { paddingTop: insets.top + 8 }]}>
        <Text style={styles.wordmark}>Stretch</Text>
        {/* The headings say which step it is. */}
        <View style={styles.dots} {...hiddenFromScreenReaders}>
          {[0, 1, 2, 3].map((i) => (
            <View key={i} style={[styles.dot, i === step && styles.dotOn]} />
          ))}
        </View>
        <Pressable accessibilityRole="button" accessibilityLabel="Skip the welcome" onPress={() => store.setOnboarded(true)} hitSlop={14}>
          <Text style={styles.skip}>Skip</Text>
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 24 }]} keyboardShouldPersistTaps="handled">
        {step === 0 ? (
          <>
            <Text style={styles.hero} accessibilityRole="header" accessibilityLabel={`Don’t grocery alone.${stepOf}`}>
              Don’t grocery alone.
            </Text>
            <Text style={styles.script}>Let Stretch do the hard part.</Text>
            <View style={styles.points}>
              {POINTS.map((p) => (
                <View key={p.title} style={styles.point}>
                  <View style={styles.pointIcon}>
                    <Icon name={p.icon} size={20} color={colors.orange} />
                  </View>
                  <View style={styles.flex}>
                    <Text style={styles.pointTitle}>{p.title}</Text>
                    <Text style={styles.body}>{p.body}</Text>
                  </View>
                </View>
              ))}
            </View>
            <Pill label="Get started" variant="orange" onPress={() => setStep(1)} style={styles.cta} />
          </>
        ) : step === 1 ? (
          <>
            <Text ref={heading} style={styles.title} accessibilityRole="header" accessibilityLabel={`Where do you shop?${stepOf}`}>
              Where do you shop?
            </Text>
            <Text style={styles.body}>
              Prices come from each retailer’s nearest store, within {settings.radiusMiles} miles. The phone finds them itself, from each
              retailer’s own store finder.
            </Text>
            <Pill label={locating ? 'Finding this phone…' : 'Use my location'} icon="pin" variant="dark" busy={locating} onPress={() => void fromMyLocation()} />
            <TextInput
              value={zip}
              onChangeText={(t) => setZip(t.replace(/\D/g, '').slice(0, 5))}
              onSubmitEditing={() => isUsZip(zip) && setStep(2)}
              placeholder="Or type a ZIP code"
              placeholderTextColor={colors.faint}
              keyboardType="number-pad"
              returnKeyType="next"
              maxLength={5}
              // With a screen reader, the heading and the explanation come first.
              autoFocus={!screenReader}
              style={styles.zip}
              accessibilityLabel="Your ZIP code"
            />
            {problem ? <Text style={[styles.note, { color: colors.amber }]}>{problem}</Text> : null}
            <Text style={styles.note}>
              Your location is read once, when you tap it, and only its ZIP code is kept. Outside the U.S.? Some store sites block
              the connection or pick a store of their own. A U.S. VPN on the phone gets past that, or skip this and each site picks.
            </Text>
            <View style={styles.row}>
              <Pill label="Next" variant="orange" disabled={!isUsZip(zip)} onPress={() => setStep(2)} style={styles.flex} />
              <Pill
                label="Skip"
                variant="outline"
                onPress={() => {
                  setZip('');
                  setStep(2);
                }}
              />
            </View>
          </>
        ) : step === 2 ? (
          <>
            <Text ref={heading} style={styles.title} accessibilityRole="header" accessibilityLabel={`Pick your stores.${stepOf}`}>
              Pick your stores
            </Text>
            <Text style={styles.body}>
              Every list is priced at these, live from this {deviceWord}. Stretch checks {STORES_AT_ONCE} at a time; more just wait their turn.
            </Text>
            <View style={styles.grid}>{retailers.filter((r) => !r.sisterOf).map(tile)}</View>
            {/* Regional chains on Kroger's and Albertsons' platforms, folded away: they only matter where they are. */}
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ expanded: regional }}
              onPress={() => setRegional(!regional)}
              style={styles.regional}
            >
              <Text style={styles.regionalText}>
                {regional ? 'Hide regional chains' : `Regional chains (${retailers.filter((r) => r.sisterOf).length}): Ralphs, Vons, Fred Meyer, Jewel-Osco…`}
              </Text>
              <Icon name={regional ? 'up' : 'down'} size={18} color={colors.muted} />
            </Pressable>
            {regional ? <View style={styles.grid}>{retailers.filter((r) => r.sisterOf).map(tile)}</View> : null}
            <Pill label={chosen.length ? 'Next: watch it work' : 'Pick at least one store'} variant="orange" disabled={!chosen.length} onPress={watchItWork} style={styles.cta} />
          </>
        ) : (
          <>
            <Text ref={heading} style={styles.title} accessibilityRole="header" accessibilityLabel={`Watch it work.${stepOf}`}>
              Watch it work
            </Text>
            <Text style={styles.body}>
              Your {deviceWord} is reading the price of {STAPLE.toLowerCase()} at your stores right now, from each store’s own website. No server in
              between.
            </Text>
            <LiveCheck retailerIds={chosen} />
            <Pressable accessibilityRole="button" onPress={() => pool.setLiveView('open')} style={styles.regional}>
              <Text style={styles.regionalText}>See the store pages it’s reading</Text>
              <Icon name="eye" size={18} color={colors.muted} />
            </Pressable>
            <Pill label="Start saving" variant="orange" onPress={finish} style={styles.cta} />
            <Text style={styles.note}>
              {isUsZip(zip)
                ? `These are the stores each site picks for this ${deviceWord}. Next, the nearest store of each within ${settings.radiusMiles} mi of ${zip} is set, while your lists open.`
                : `These are the stores each site picks for this ${deviceWord}. Set your location in Your stores to use the ones nearest you.`}
            </Text>
          </>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

/** What the welcome prices live: something every store sells. */
const STAPLE = 'Milk';
/** The welcome's price check runs as a list of its own that no screen lists. */
const WELCOME_RUN = '__welcome__';

/** Each store's price for the staple as it lands, how long it took, and the cheapest once they're in. */
function LiveCheck({ retailerIds }: { retailerIds: string[] }) {
  const { bundle } = useApp();
  const run = usePricingRun(WELCOME_RUN);
  const item = { id: 'staple', name: STAPLE, qty: 1, checked: false };
  const rows = retailerIds.map((id) => {
    const cfg = bundle.retailers.find((r) => r.id === id);
    const result = run?.results[id]?.[queryKey(STAPLE)];
    return { id, name: cfg?.name ?? id, host: hostOf(cfg?.homeUrl ?? '').replace(/^www\./, ''), result, line: lineFor(item, id, result) };
  });
  const found = rows.filter((r) => r.line.status === 'found' && r.line.product?.price != null);
  const cheapest = found.length > 1 && !!run?.finishedAt ? found.reduce((a, b) => (b.line.product!.price! < a.line.product!.price! ? b : a)) : null;

  // Screen readers hear the answer when it's in.
  const told = useRef(false);
  useEffect(() => {
    if (!cheapest || told.current) return;
    told.current = true;
    announce(`${STAPLE}: cheapest at ${cheapest.name}, ${money(cheapest.line.product!.price!)}.`);
  });

  return (
    <View style={styles.checkCard}>
      {rows.map((r) => {
        const product = r.line.product;
        const busy = r.line.status === 'pending';
        return (
          <View key={r.id} style={styles.checkRow}>
            <RetailerBadge retailerId={r.id} name={r.name} size={30} />
            <View style={styles.flex}>
              <Text style={styles.storeName}>{r.name}</Text>
              {busy ? (
                <View style={styles.checkBusy}>
                  <ActivityIndicator size="small" color={colors.orange} />
                  <Text style={styles.note}>Reading {r.host}…</Text>
                </View>
              ) : product ? (
                <Text style={styles.note} numberOfLines={1}>
                  {product.name}
                </Text>
              ) : (
                <Text style={styles.note}>
                  {r.line.status === 'failed' ? `Couldn’t read it from here: ${reasonWords(r.result?.reason)}` : `No ${STAPLE.toLowerCase()} in its results`}
                </Text>
              )}
            </View>
            {product && product.price != null ? (
              <View style={styles.checkPrice}>
                <Text style={[styles.price, cheapest?.id === r.id && { color: colors.orangeText }]}>{money(product.price)}</Text>
                {r.result?.ms !== undefined ? <Text style={styles.ms}>{(r.result.ms / 1000).toFixed(1)} s</Text> : null}
              </View>
            ) : null}
          </View>
        );
      })}
      {cheapest ? (
        <Text style={styles.cheapest}>
          Cheapest right now: {cheapest.name}, {money(cheapest.line.product!.price!)}. Stretch does this for every item on your lists.
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.cream },
  checkCard: { backgroundColor: colors.card, borderRadius: radius.lg, padding: 14, gap: 12, ...shadow.card },
  checkRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  checkBusy: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  checkPrice: { alignItems: 'flex-end' },
  price: { fontFamily: fonts.semibold, fontSize: 17, color: colors.ink },
  ms: { fontFamily: fonts.body, fontSize: 12, color: colors.muted },
  cheapest: { fontFamily: fonts.medium, fontSize: 15, lineHeight: 21, color: colors.ink, paddingTop: 4, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  blush: { backgroundColor: colors.blush },
  flex: { flex: 1 },
  top: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingBottom: 8 },
  wordmark: { fontFamily: fonts.display, fontSize: 24, color: colors.ink },
  dots: { flexDirection: 'row', gap: 6 },
  dot: { width: 7, height: 7, borderRadius: 4, backgroundColor: 'rgba(31,31,31,0.18)' },
  dotOn: { backgroundColor: colors.orange, width: 20 },
  skip: { fontFamily: fonts.semibold, fontSize: 15, color: colors.muted },
  content: { paddingHorizontal: 22, paddingTop: 20, gap: 16 },
  hero: { fontFamily: fonts.display, fontSize: 46, lineHeight: 52, color: colors.ink, marginTop: 20 },
  script: { fontFamily: fonts.script, fontSize: 32, color: colors.orangeText, marginTop: -10, transform: [{ rotate: '-2deg' }] },
  title: { fontFamily: fonts.display, fontSize: 34, lineHeight: 40, color: colors.ink, marginTop: 8 },
  body: { fontFamily: fonts.body, fontSize: 16, lineHeight: 23, color: colors.muted },
  note: { fontFamily: fonts.body, fontSize: 14, lineHeight: 20, color: colors.muted },
  points: { gap: 18, marginTop: 12 },
  point: { flexDirection: 'row', gap: 14, alignItems: 'flex-start' },
  pointIcon: { width: 40, height: 40, borderRadius: 20, backgroundColor: colors.cream, alignItems: 'center', justifyContent: 'center' },
  pointTitle: { fontFamily: fonts.semibold, fontSize: 17, color: colors.ink, marginBottom: 2 },
  cta: { marginTop: 18 },
  zip: {
    fontFamily: fonts.semibold,
    fontSize: 24,
    letterSpacing: 2,
    color: colors.ink,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.md,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  row: { flexDirection: 'row', gap: 10, marginTop: 4 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  storeTile: {
    width: '48%',
    flexGrow: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: colors.card,
    borderRadius: radius.md,
    borderWidth: 1.5,
    borderColor: colors.line,
    padding: 10,
    minHeight: 58,
    ...shadow.card,
  },
  storeTileOn: { borderColor: colors.orange },
  // Regional chains take a row each: their region fits beside the name.
  storeTileWide: { width: '100%' },
  storeName: { fontFamily: fonts.medium, fontSize: 14, lineHeight: 18, color: colors.ink },
  storeRegion: { fontFamily: fonts.body, fontSize: 12, lineHeight: 16, color: colors.muted },
  regional: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, minHeight: 44 },
  regionalText: { flex: 1, fontFamily: fonts.medium, fontSize: 14, lineHeight: 19, color: colors.muted },
  tick: { width: 22, height: 22, borderRadius: 7, borderWidth: 1.5, borderColor: colors.faint, alignItems: 'center', justifyContent: 'center' },
  tickOn: { backgroundColor: colors.orange, borderColor: colors.orange },
});
