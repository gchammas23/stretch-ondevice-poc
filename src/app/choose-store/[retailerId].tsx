import { router, useLocalSearchParams, useNavigation } from 'expo-router';
import React, { useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { sameStoreId } from '../../onDevice/storeIdentity';
import { trustedMiles, type NearbyStore } from '../../onDevice/storeLocator';
import type { RetailerConfig } from '../../onDevice/types';
import { hostOf } from '../../pricing/receipt';
import { useApp, useRetailer, useSettings, useSetupDeps } from '../../state/AppProvider';
import { milesText, reasonText } from '../../state/storeInfo';
import { chooseStore, currentSetup, setUpStores } from '../../state/storeSetup';
import { announce } from '../../ui/a11y';
import { Pill, tap } from '../../ui/controls';
import { Icon } from '../../ui/Icon';
import { RetailerBadge } from '../../ui/RetailerBadge';
import { ScreenHeader } from '../../ui/ScreenHeader';
import { colors, fonts, radius, shadow } from '../../ui/theme';

export default function ChooseStoreScreen() {
  const { retailerId } = useLocalSearchParams<{ retailerId: string }>();
  const retailer = useRetailer(retailerId);
  if (!retailer) return <ScreenHeader title="Choose a store" subtitle="This store was removed." />;
  return <StoreList key={retailer.id} retailer={retailer} />;
}

/** A retailer's stores near the ZIP code, nearest first, as its own finder listed them: the one tapped is where prices come from. */
function StoreList({ retailer }: { retailer: RetailerConfig }) {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const { store } = useApp();
  const settings = useSettings();
  const deps = useSetupDeps();
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const { zip, radiusMiles } = settings;
  const listed = settings.nearbyStores[retailer.id];
  const stores = listed?.zip === zip ? listed.stores : [];
  const setup = zip && settings.storeSetup[retailer.id]?.zip === zip ? settings.storeSetup[retailer.id] : undefined;
  const working = setup?.status === 'working';
  const chosen = settings.chosenStores[retailer.id];
  const site = hostOf(retailer.homeUrl).replace(/^www\./, '');
  // Distances that can be trusted: measured on the map, or the finder's when it searched the ZIP (a list kept from
  // before lists said so counts as the finder's answer for it). A store whose distance can't be told can be chosen.
  const tie = listed?.tie ?? 'asked';
  const milesOf = (s: NearbyStore) => trustedMiles(s, tie);
  const measured = stores.some((s) => milesOf(s) !== undefined);
  const inRange = (s: NearbyStore) => (milesOf(s) ?? 0) <= radiusMiles;
  const how = deps.apiTakesZip(retailer)
    ? `${retailer.name}’s official API is asked for that store’s prices.`
    : retailer.storeFinder?.setRequest && retailer.storeFinder.auto
      ? `The phone makes it your store on ${site}, hidden, as its store picker does.`
      : retailer.storeFinder?.auto
        ? `The phone makes it your store on ${site}’s store finder, hidden, the way you would.`
        : `Its store number goes in each search the phone makes on ${site}.`;

  const choose = async (s: NearbyStore) => {
    if (busy || working) return;
    if (chosen && sameStoreId(chosen.id, s.id)) {
      router.back();
      return;
    }
    tap();
    setProblem(null);
    setBusy(s.id);
    const ok = await chooseStore(retailer, s, deps);
    setBusy(null);
    if (ok) {
      announce(`${s.name} is your ${retailer.name} store.`);
      // Setting it can take a while: if the user went back meanwhile, going back again would leave the screen under.
      if (navigation.isFocused()) router.back();
    } else {
      setProblem(`Couldn’t make it your store on ${site} (${reasonText(currentSetup(store, retailer.id)?.reason)}). Try again, or choose another.`);
    }
  };
  const lookAgain = () => {
    setProblem(null);
    void setUpStores(zip, deps, [retailer.id], { refresh: true });
  };

  return (
    <View style={styles.screen}>
      <ScreenHeader
        title={`${retailer.name} near ${zip}`}
        subtitle={`Nearest first, as ${listed?.radius ? 'its official API' : `${site}’s store finder`} lists them. Prices come from the one you choose.`}
      />
      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 32 }]}>
        {stores.length ? (
          <View style={styles.card} accessibilityRole="radiogroup" accessibilityLabel={`${retailer.name} stores`}>
            {stores.map((s, i) => {
              const current = !!chosen && sameStoreId(chosen.id, s.id);
              const away = !inRange(s);
              const miles = milesOf(s);
              const where = [s.address, miles !== undefined ? `${milesText(miles)} away` : ''].filter(Boolean).join(', ');
              return (
                <Pressable
                  key={s.id}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: current, disabled: away, busy: busy === s.id }}
                  accessibilityLabel={`${s.name}, store ${s.id}${where ? `, ${where}` : ''}${away ? `, more than ${radiusMiles} miles away` : ''}`}
                  disabled={away || !!busy || working}
                  onPress={() => void choose(s)}
                  style={({ pressed }) => [styles.row, i > 0 && styles.divider, pressed && styles.pressed]}
                >
                  <View style={[styles.flex, away && styles.away]}>
                    <Text style={styles.name}>{s.name}</Text>
                    {s.address ? <Text style={styles.small}>{s.address}</Text> : null}
                    <Text style={styles.small}>
                      Store {s.id}
                      {miles !== undefined ? ` · ${milesText(miles)}` : ''}
                      {away ? ` · beyond ${radiusMiles} mi` : ''}
                    </Text>
                  </View>
                  {busy === s.id ? (
                    <ActivityIndicator size="small" color={colors.orange} />
                  ) : current ? (
                    <View style={styles.current}>
                      <Icon name="check" size={15} color={colors.green} strokeWidth={2.5} />
                      <Text style={styles.currentText}>Your store</Text>
                    </View>
                  ) : null}
                </Pressable>
              );
            })}
          </View>
        ) : (
          <View style={[styles.card, styles.empty]}>
            <RetailerBadge retailerId={retailer.id} name={retailer.name} />
            <Text style={styles.small}>
              {working
                ? `Finding ${retailer.name} stores near ${zip}…`
                : setup?.status === 'failed'
                  ? `Its stores couldn’t be listed (${reasonText(setup.reason)}).`
                  : `No list of its stores near ${zip} yet.`}
            </Text>
          </View>
        )}
        {problem ? <Text style={styles.problem}>{problem}</Text> : null}
        {!problem && stores.length && setup?.status === 'failed' ? (
          <Text style={styles.problem}>
            {`None was set on its own: ${reasonText(setup.reason)}.${tie === 'none' ? ` Check these are near ${zip} before choosing one.` : ''}`}
          </Text>
        ) : null}
        {measured && stores.some((s) => !inRange(s)) ? (
          <Text style={styles.note}>Stores beyond {radiusMiles} mi can’t be chosen. Widen the distance on Your stores to choose them.</Text>
        ) : null}
        <Text style={styles.note}>{how}</Text>
        {/* While a store tapped is being set, the list isn't being looked for again. */}
        <Pill label={working && !busy ? 'Looking…' : 'Look again'} icon="refresh" variant="outline" busy={working && !busy} disabled={!!busy} onPress={lookAgain} />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.paper },
  content: { paddingHorizontal: 16, gap: 12 },
  card: { backgroundColor: colors.card, borderRadius: radius.lg, paddingHorizontal: 14, ...shadow.card },
  empty: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 14 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, minHeight: 56 },
  divider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  flex: { flex: 1, gap: 2 },
  away: { opacity: 0.45 },
  name: { fontFamily: fonts.semibold, fontSize: 16, lineHeight: 21, color: colors.ink },
  small: { flexShrink: 1, fontFamily: fonts.body, fontSize: 14, lineHeight: 19, color: colors.muted },
  current: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  currentText: { fontFamily: fonts.semibold, fontSize: 13, color: colors.green },
  problem: { fontFamily: fonts.body, fontSize: 14, lineHeight: 20, color: colors.amber, backgroundColor: colors.amberTint, borderRadius: radius.md, padding: 12 },
  note: { fontFamily: fonts.body, fontSize: 13, lineHeight: 18, color: colors.muted },
  pressed: { opacity: 0.7 },
});
