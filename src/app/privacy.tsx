import { router } from 'expo-router';
import React, { useSyncExternalStore } from 'react';
import { Alert, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { krogerApiConfigured } from '../onDevice/krogerApi';
import { MODE_NAMES } from '../pricing/onlineCost';
import { useAisles, useApp, useAppState, useAttemptLog, useHistory } from '../state/AppProvider';
import { Pill } from '../ui/controls';
import { deviceWord } from '../ui/device';
import { Icon, type IconName } from '../ui/Icon';
import { ScreenHeader } from '../ui/ScreenHeader';
import { colors, fonts, radius, shadow } from '../ui/theme';

/**
 * What stays on this phone: what the app keeps, what it sends and to whom, what it never collects, and a way to
 * erase it all. For anyone this POC is shown to.
 */
export default function PrivacyScreen() {
  const insets = useSafeAreaInsets();
  const { cache, fees, ads, coupons, forgetPrices: forget, startOver } = useApp();
  const history = useHistory();
  const aisles = useAisles();
  const log = useAttemptLog();
  const state = useAppState((s) => s);
  const items = state.lists.reduce((n, l) => n + l.items.length, 0);
  const telemetry = !!process.env.EXPO_PUBLIC_TELEMETRY_URL;
  const listed = Object.values(state.settings.nearbyStores).filter((l) => l.zip === state.settings.zip).length;
  const feesRead = Object.values(useSyncExternalStore(fees.subscribe, fees.all)).filter((r) => r.fees).length;
  const adsRead = Object.values(useSyncExternalStore(ads.subscribe, ads.all)).filter((r) => r.value).length;
  const couponsRead = Object.values(useSyncExternalStore(coupons.subscribe, coupons.all)).filter((r) => r.value).length;
  const plans = Object.keys(state.settings.onlinePlans).length;
  const maps = Platform.OS === 'ios' ? 'Apple’s map service' : 'the phone’s map service';

  const forgetPrices = () =>
    Alert.alert('Forget prices and history?', 'Saved prices, price history, the fees, weekly ads, coupons and aisles read from store pages, the store health log and the last price truth check are erased. Lists, and the aisles you noted, stay.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Forget',
        style: 'destructive',
        onPress: forget,
      },
    ]);

  const eraseAll = () =>
    Alert.alert('Erase everything?', 'Lists, trips, savings, stores and prices are erased, and the app starts over with the welcome.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Erase',
        style: 'destructive',
        onPress: async () => {
          await startOver();
          router.replace('/welcome');
        },
      },
    ]);

  return (
    <View style={styles.screen}>
      <ScreenHeader title="What stays on this phone" subtitle="What the app keeps, what it sends, and to whom." />
      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 32 }]}>
        <Section icon="phone" title={`Kept on this ${deviceWord}`}>
          <Line text={`${count(state.lists.length, 'list')} with ${count(items, 'item')}, ${count(state.trips.length, 'finished trip')} and your savings.`} />
          <Line text={`Your ZIP code${state.settings.zip ? ` (${state.settings.zip})` : ''}, how far stores may be (${state.settings.radiusMiles} mi), your stores, ${count(Object.keys(state.usuals).length, 'usual product')} and ${state.watch.length} watched.`} />
          <Line text={`The stores ${count(listed, 'retailer')} listed near your ZIP code, and where that ZIP code is on the map (its center, not where you are).`} />
          <Line text={`${count(cache.size, 'saved search', 'saved searches')}, the price history of ${count(history.size, 'product')}, and a log of ${count(log.entries().length, 'store search', 'store searches')} for Store health.`} />
          <Line text="How the last price truth check went (how many prices matched, at each store), for the results report." />
          <Line text={`Where you noted finding ${count(aisles.notes, 'product')} in your stores, and the aisles ${count(aisles.pages, 'product page')} gave, for Shop here.`} />
          <Line
            text={`How you shop (${MODE_NAMES[state.settings.shopMode].toLowerCase()}), ${count(plans, 'online plan')} you said you have, and what ${count(feesRead, 'store’s fees page', 'stores’ fees pages')} said when the phone last read ${feesRead === 1 ? 'it' : 'them'}.`}
          />
          <Line text={`The weekly ads of ${count(adsRead, 'store')}, and your coupons at ${count(couponsRead, 'store')}, as the phone last read them from each store’s own site.`} />
          <Line text="Each store’s cookies, in the app’s own browser: some sites keep your store there, and your sign-in if you signed in to one." />
          <Line text="The data behind each price read since the app opened, for its X-ray: only until the app closes." />
          <Text style={styles.note}>None of this is sent anywhere. It goes when you erase it below, or delete the app.</Text>
        </Section>

        <Section icon="globe" title="Sent from this phone">
          <Line text="Searches to each store’s own website, as a browser would send them: the item, and the store’s cookies. The store sees this phone’s internet address, as it does for anyone visiting." />
          <Line text="While you type a price check, what you’ve typed so far goes to two of your stores, into their own search boxes, for their suggestions." />
          <Line text="Your ZIP code to each store’s own store finder, to list its stores near you: typed into it on a hidden page, or asked of it directly. A finder that asks for a place on the map (Meijer’s) gets your ZIP code’s center, not where you are." />
          <Line text="Shopping for pickup or delivery: a visit to each of your stores’ own page about its fees, about once a week, as a browser would. Nothing about you or your list goes with it." />
          <Line text="If you sign in to a store for your member prices or coupons: that happens on the store’s own page, which the app adds nothing to and reads nothing on." />
          <Line text="A visit to each of your stores’ weekly ad page, at most once a day, as a browser would. For the stores you signed in to here, a visit to your coupons page on their site; a coupon’s Clip button is pressed there only when you tap Clip." />
          <Line text={`To ${maps}: your ZIP code, to measure how far each store is; and when you tap Use my location, where the phone is, once, to get its ZIP code.`} />
          <Line text={krogerApiConfigured() ? 'To Kroger’s official API: your ZIP code, to list its stores near you, and your searches.' : 'Nothing to Kroger’s API: no keys are set.'} />
          <Line text={state.settings.rulesUrl ? 'A download of the store rules file you set in Store health.' : 'No store rules file: the app uses its built-in rules.'} />
          <Line
            text={
              telemetry
                ? 'Health reports to the address this build was given: which store, whether it worked, how long it took. No search words, products, cookies or ids.'
                : 'No health reports: this build has no address to send them to.'
            }
          />
          <Line text="A results report (Store health or Diagnostics), only when you make one and share it yourself: a one-page PDF of what this phone measured, with your ZIP code’s area (its first three digits). No lists, products or location go in it, and the PDF isn’t kept once you’ve shared it." />
          <Text style={styles.note}>Nothing is sent to Stretch. There’s no account.</Text>
        </Section>

        <Section icon="shield" title="Never collected">
          <Line text="Your location in the background, or where you’ve been: it’s read once, only when you tap Use my location, and only the ZIP code is kept." />
          <Line text="Photos: the camera only reads barcodes as you scan, and keeps no pictures." />
          <Line text="Your passwords: you sign in to stores on their own pages, never in the app." />
          <Line text="Contacts, your name or email, or any id that follows you." />
        </Section>

        <Pill label="Forget prices and history" icon="trash" variant="outline" onPress={forgetPrices} />
        <Pill label="Erase everything" icon="trash" variant="dark" onPress={eraseAll} />
      </ScrollView>
    </View>
  );
}

function Section({ icon, title, children }: { icon: IconName; title: string; children: React.ReactNode }) {
  return (
    <View style={styles.card}>
      <View style={styles.head}>
        <Icon name={icon} size={18} color={colors.orange} />
        <Text style={styles.title} accessibilityRole="header">
          {title}
        </Text>
      </View>
      {children}
    </View>
  );
}

/** "1 list", "2 lists". */
const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function Line({ text }: { text: string }) {
  return (
    <View style={styles.line}>
      <Text style={styles.bullet} accessibilityElementsHidden importantForAccessibility="no">
        •
      </Text>
      <Text style={styles.body}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.paper },
  content: { paddingHorizontal: 16, gap: 12 },
  card: { backgroundColor: colors.card, borderRadius: radius.lg, padding: 16, gap: 8, ...shadow.card },
  head: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 2 },
  title: { flex: 1, fontFamily: fonts.semibold, fontSize: 17, color: colors.ink },
  line: { flexDirection: 'row', gap: 8 },
  bullet: { fontFamily: fonts.body, fontSize: 15, lineHeight: 21, color: colors.muted },
  body: { flex: 1, fontFamily: fonts.body, fontSize: 15, lineHeight: 21, color: colors.ink },
  note: { fontFamily: fonts.medium, fontSize: 14, lineHeight: 19, color: colors.green, marginTop: 4 },
});
