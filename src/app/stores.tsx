import { router } from 'expo-router';
import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ActivityIndicator, Alert, Keyboard, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { COVERAGE_WORDS } from '../onDevice/coverage';
import type { RetailerConfig } from '../onDevice/types';
import { feeStatusWords, perksWords, planPrice, plansAt, type ShopMode } from '../pricing/onlineCost';
import { hostOf, whenLabel } from '../pricing/receipt';
import { useNow } from '../ui/useNow';
import { STORES_AT_ONCE } from '../pricing/pricingEngine';
import { storeInfo, type StoreInfo } from '../state/storeInfo';
import type { Settings, StoreSetup } from '../state/appStore';
import { useApp, useFeeBook, useFeeReads, useSettings, useSetupDeps, useStoreChoices } from '../state/AppProvider';
import { LOCATE_PROBLEMS, zipFromDevice } from '../state/deviceLocation';
import { isUsZip, setUpStores } from '../state/storeSetup';
import { announce } from '../ui/a11y';
import { Pill, tap } from '../ui/controls';
import { Icon } from '../ui/Icon';
import { RetailerBadge } from '../ui/RetailerBadge';
import { ScreenHeader } from '../ui/ScreenHeader';
import { MODE_ICONS, ShopModeChooser } from '../ui/ShopMode';
import { colors, fonts, radius, shadow } from '../ui/theme';

/** The retailer's setup for the ZIP currently set, if it has one. */
function setupFor(settings: Settings, retailerId: string): StoreSetup | undefined {
  const setup = settings.storeSetup[retailerId];
  return settings.zip && setup?.zip === settings.zip ? setup : undefined;
}

/** Search radius choices, in miles. */
const RADII = [5, 10, 25, 50];

/** Regional chains on a parent's platform: one set of rules each, no code. */
const FAMILIES = [
  { parent: 'kroger', title: 'More on Kroger’s platform', note: 'Ralphs, Fred Meyer, King Soopers and more: the same site and API as Kroger.' },
  { parent: 'safeway', title: 'More on Albertsons’ platform', note: 'Albertsons, Vons, Jewel-Osco and more: the same site as Safeway.' },
];

/** A family of regional chains, folded away until opened. */
function Family({ title, note, count, children }: { title: string; note: string; count: number; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`${title}, ${count} stores`}
        onPress={() => setOpen(!open)}
        style={({ pressed }) => [styles.family, pressed && styles.pressed]}
      >
        <View style={styles.flex}>
          <Text style={styles.name}>
            {title} <Text style={styles.small}>({count})</Text>
          </Text>
          <Text style={styles.small}>{note}</Text>
        </View>
        <Icon name={open ? 'up' : 'down'} size={18} color={colors.muted} />
      </Pressable>
      {open ? children : null}
    </>
  );
}

export default function StoresScreen() {
  const insets = useSafeAreaInsets();
  const { bundle } = useApp();
  const settings = useSettings();
  const retailers = bundle.retailers.filter((r) => r.enabled);
  const on = settings.retailerIds.filter((id) => retailers.some((r) => r.id === id));
  // Those with no store in range aren't searched.
  const compared = on.filter((id) => setupFor(settings, id)?.status !== 'none');
  // Stores being compared first, in the order they were switched on; then the rest, with the regional chains that run
  // on a parent's platform folded away by family.
  const rest = retailers.filter((r) => !on.includes(r.id));
  const main = [...on.map((id) => retailers.find((r) => r.id === id)!), ...rest.filter((r) => !r.sisterOf)];
  const families = FAMILIES.map((f) => ({ ...f, stores: rest.filter((r) => r.sisterOf === f.parent) })).filter((f) => f.stores.length);

  return (
    <View style={styles.screen}>
      <ScreenHeader title="Your stores" subtitle="Every list is priced at these stores, live, from this phone." />
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 32 }]}>
        <LocationCard />
        <ShopModeCard />
        <Pressable accessibilityRole="button" onPress={() => router.push('/health')} style={({ pressed }) => [styles.healthLink, pressed && styles.pressed]}>
          <Icon name="heartPulse" size={18} color={colors.orange} />
          <Text style={styles.healthText}>Which stores work from this phone? Check them all in Store health.</Text>
          <Icon name="forward" size={16} color={colors.faint} />
        </Pressable>
        <Pressable accessibilityRole="button" onPress={() => router.push('/ads')} style={({ pressed }) => [styles.healthLink, pressed && styles.pressed]}>
          <Icon name="star" size={18} color={colors.orange} />
          <Text style={styles.healthText}>Weekly ads and coupons: each store’s ad, and your digital coupons once you sign in.</Text>
          <Icon name="forward" size={16} color={colors.faint} />
        </Pressable>
        {compared.length > STORES_AT_ONCE ? (
          <Text style={styles.warn}>
            Stretch checks {STORES_AT_ONCE} stores at a time, so with {compared.length} the rest wait their turn.
          </Text>
        ) : null}
        {main.map((r) => (
          <StoreCard key={r.id} retailer={r} on={on.includes(r.id)} />
        ))}
        {families.map((f) => (
          <Family key={f.parent} title={f.title} note={f.note} count={f.stores.length}>
            {f.stores.map((r) => (
              <StoreCard key={r.id} retailer={r} on={false} />
            ))}
          </Family>
        ))}
        <Pressable
          accessibilityRole="button"
          onPress={() => router.push('/add-store')}
          style={({ pressed }) => [styles.addCard, pressed && styles.pressed]}
        >
          <View style={styles.addIcon}>
            <Icon name="plus" size={20} color={colors.orange} strokeWidth={2.5} />
          </View>
          <View style={styles.flex}>
            <Text style={styles.name}>Add a store</Text>
            <Text style={styles.small}>Any grocery site that shows prices online. Paste a search link; the phone reads it like the others.</Text>
          </View>
          <Icon name="forward" size={18} color={colors.faint} />
        </Pressable>
      </ScrollView>
    </View>
  );
}

/** Where to shop from: the phone's location or a typed ZIP code, and how far stores may be. */
function LocationCard() {
  const { store, bundle } = useApp();
  const settings = useSettings();
  const deps = useSetupDeps();
  const [zip, setZip] = useState(settings.zip);
  const [locating, setLocating] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const setups = settings.retailerIds.map((id) => [id, setupFor(settings, id)] as const);
  const working = setups.some(([, s]) => s?.status === 'working');
  const nameOf = (id: string) => bundle.retailers.find((r) => r.id === id)?.name ?? id;
  const done = setups.filter(([, s]) => s?.status === 'done').length;
  const failed = setups.filter(([, s]) => s?.status === 'failed').length;
  const none = setups.filter(([, s]) => s?.status === 'none').map(([id]) => nameOf(id));

  const setStores = (value = zip) => {
    if (!isUsZip(value) || working) return;
    Keyboard.dismiss();
    setMessage(null);
    // The same ZIP again: its stores are looked for again, not taken from the last time.
    void setUpStores(value, deps, undefined, { refresh: value === settings.zip });
  };
  const fromMyLocation = async () => {
    setLocating(true);
    setMessage(null);
    const found = await zipFromDevice();
    setLocating(false);
    if (!found.ok) {
      setMessage(LOCATE_PROBLEMS[found.reason]);
      return;
    }
    setZip(found.zip);
    setStores(found.zip);
  };
  const setRadius = (miles: number) => {
    tap();
    store.setRadius(miles);
    if (isUsZip(settings.zip)) void setUpStores(settings.zip, deps);
  };

  const summary = working
    ? `Finding stores near ${settings.zip}…`
    : [
        `Within ${settings.radiusMiles} mi of ${settings.zip}: ${done} ${done === 1 ? 'store' : 'stores'} set`,
        failed ? `${failed} couldn’t be set` : '',
        none.length ? `no ${none.join(' or ')} nearby, so ${none.length === 1 ? 'it isn’t' : 'they aren’t'} compared` : '',
      ]
        .filter(Boolean)
        .join('; ') + '.';

  // Screen readers hear how setting the stores went.
  const wasWorking = useRef(working);
  useEffect(() => {
    if (wasWorking.current && !working && settings.zip) announce(summary);
    wasWorking.current = working;
  });

  return (
    <View style={styles.locationCard}>
      <View style={styles.row}>
        <Icon name="pin" size={20} color={colors.orange} />
        <Text style={styles.locationTitle} accessibilityRole="header">
          Your location
        </Text>
      </View>
      <Text style={styles.small}>
        Prices come from the nearest store of each retailer, within the distance below. The phone finds them itself, from each
        retailer’s own store finder.
      </Text>
      <Pill label={locating ? 'Finding this phone…' : 'Use my location'} icon="pin" small variant="dark" busy={locating} onPress={() => void fromMyLocation()} style={styles.alignStart} />
      <View style={styles.row}>
        <TextInput
          value={zip}
          onChangeText={(t) => setZip(t.replace(/\D/g, '').slice(0, 5))}
          onSubmitEditing={() => setStores()}
          placeholder="Or a ZIP code, e.g. 10001"
          placeholderTextColor={colors.faint}
          keyboardType="number-pad"
          returnKeyType="done"
          maxLength={5}
          style={styles.zipInput}
          accessibilityLabel="Your ZIP code"
        />
        <Pill
          label={settings.zip && zip === settings.zip ? 'Find again' : 'Find stores'}
          small
          variant="orange"
          busy={working}
          disabled={!isUsZip(zip)}
          onPress={() => setStores()}
        />
      </View>
      <View style={styles.radiusRow} accessibilityRole="radiogroup" accessibilityLabel="How far stores may be">
        <Text style={styles.radiusLabel}>Within</Text>
        {RADII.map((miles) => {
          const selected = settings.radiusMiles === miles;
          return (
            <Pressable
              key={miles}
              accessibilityRole="radio"
              accessibilityState={{ checked: selected }}
              accessibilityLabel={`${miles} miles`}
              hitSlop={{ top: 6, bottom: 6 }}
              onPress={() => setRadius(miles)}
              style={[styles.radius, selected && styles.radiusOn]}
            >
              <Text style={[styles.radiusText, selected && styles.radiusTextOn]}>{miles} mi</Text>
            </Pressable>
          );
        })}
      </View>
      {message ? <Text style={[styles.small, { color: colors.amber }]}>{message}</Text> : null}
      {settings.zip ? <Text style={styles.summary}>{summary}</Text> : null}
      <Text style={styles.note}>
        Your location is read once, when you tap Use my location, and only its ZIP code is kept. From outside the U.S., some
        store sites block the connection or pick a store of their own: a U.S. VPN on the phone gets past that.
      </Text>
    </View>
  );
}

/** What each way of shopping counts, under the choice. */
const MODE_EXPLAINED: Record<ShopMode, string> = {
  store: 'Totals are the items at the prices each store’s site shows. Choose Pickup or Delivery to count what ordering online adds.',
  pickup: 'Totals add each store’s pickup fee, and its higher online prices where it says they’re higher.',
  delivery: 'Totals add each store’s delivery and service fees, and its higher online prices where it says they’re higher. Tip and tax aren’t in them.',
};

/**
 * How the user shops: in store, or online for pickup or delivery, with the plans they have (Walmart+, Instacart+...)
 * and where each compared store's fees come from: its own fees page, read on this phone, or the store rules' estimates.
 */
function ShopModeCard() {
  const { store, checkFees } = useApp();
  const settings = useSettings();
  const fees = useFeeBook();
  const now = useNow(60_000);
  const compared = useStoreChoices().map((c) => c.config);
  // Shopping online, the compared stores' fees pages are read when they're due, while this shows.
  useFeeReads();
  const mode = settings.shopMode;
  const plans = plansAt(compared);
  const nameOf = (id: string) => compared.find((r) => r.id === id)?.name ?? id;
  const readable = compared.some((r) => r.online?.feesUrl);

  return (
    <View style={styles.modeCard}>
      <View style={styles.row}>
        <Icon name={MODE_ICONS[mode]} size={20} color={colors.orange} />
        <Text style={styles.locationTitle} accessibilityRole="header">
          How you shop
        </Text>
      </View>
      <ShopModeChooser value={mode} onChange={(m) => store.setShopMode(m)} />
      <Text style={styles.small}>{MODE_EXPLAINED[mode]}</Text>
      {mode !== 'store' ? (
        <>
          {plans.length ? (
            <Text style={styles.storeTitle} accessibilityRole="header">
              Your plans
            </Text>
          ) : null}
          {plans.map(({ plan, retailerIds }) => (
            <View key={plan.id} style={styles.planRow}>
              <View style={styles.flex}>
                <Text style={styles.name}>{plan.name}</Text>
                <Text style={styles.small}>
                  {[planPrice(plan), plan.note ?? perksWords(plan), retailerIds.length > 1 ? `at ${retailerIds.map(nameOf).join(', ')}` : '']
                    .filter(Boolean)
                    .join(' · ')}
                </Text>
              </View>
              <Switch
                value={!!settings.onlinePlans[plan.id]}
                onValueChange={(value) => store.setOnlinePlan(plan.id, value)}
                trackColor={{ true: colors.orange, false: colors.faint }}
                thumbColor="#FFFFFF"
                accessibilityLabel={`I have ${plan.name}`}
              />
            </View>
          ))}
          <Text style={styles.storeTitle} accessibilityRole="header">
            Where the fees come from
          </Text>
          <Text style={styles.small}>
            The phone reads each store’s own fees page, hidden, about once a week. Until it has, the store rules’ figures count, marked as
            estimates.
          </Text>
          {compared.map((r) => (
            <Text key={r.id} style={styles.small}>
              <Text style={styles.feeStore}>{r.name}:</Text> {feeStatusWords(r, mode, fees.get(r.id), fees.reading === r.id, now)}
            </Text>
          ))}
          {readable ? (
            <Pill
              label={fees.reading ? `Reading ${nameOf(fees.reading)}’s fees…` : 'Read the fees pages again'}
              icon="refresh"
              small
              variant="outline"
              busy={!!fees.reading}
              onPress={() => void checkFees(true)}
              style={styles.alignStart}
            />
          ) : null}
        </>
      ) : null}
      <Text style={styles.note}>The same choice is on Find a store.</Text>
    </View>
  );
}

function StoreCard({ retailer, on }: { retailer: RetailerConfig; on: boolean }) {
  const { store, signInAt } = useApp();
  const settings = useSettings();
  const deps = useSetupDeps();
  const setup = setupFor(settings, retailer.id);
  const { coverage } = useApp();
  const checked = useSyncExternalStore(coverage.subscribe, () => coverage.rowFor(retailer.id));
  const now = useNow(60_000);
  const { fontScale } = useWindowDimensions();
  const storeKey = useStoreChoices().find((c) => c.config.id === retailer.id)?.storeKey ?? '';
  const site = hostOf(retailer.homeUrl).replace(/^www\./, '');
  // A regional chain says where it is, until it's switched on.
  const note = retailer.region && !checked ? `${retailer.region}. ${retailer.sisterOf === 'kroger' ? 'Kroger’s platform.' : 'Albertsons’ platform.'}` : retailer.note;
  const member = retailer.member;
  const isMember = !!settings.memberships[retailer.id];
  const signedInAt = settings.signedInAt[retailer.id];
  // Signing in happens on the store's own page, which the app leaves alone; being signed in makes you a member, and
  // the account's coupons are read then (see Weekly ads and coupons).
  const signIn = () => signInAt(retailer.id);
  const listed = settings.nearbyStores[retailer.id];
  const hasList = !!listed && listed.zip === settings.zip && listed.stores.length > 0;

  const toggle = (value: boolean) => {
    store.setRetailerOn(retailer.id, value);
    // A store switched on after the ZIP was set is set up for it too.
    if (value && isUsZip(settings.zip) && !setup) void setUpStores(settings.zip, deps, [retailer.id]);
  };

  let status: React.ReactNode;
  if (!on) {
    status = (
      <Text style={styles.small} numberOfLines={fontScale > 1.3 ? undefined : 2}>
        {checked
          ? checked.status === 'works'
            ? `Worked from this phone ${whenLabel(checked.at, now)}: ${checked.products} products in ${(checked.ms / 1000).toFixed(1)} s`
            : `${COVERAGE_WORDS[checked.status]} from this phone ${whenLabel(checked.at, now)}`
          : note}
      </Text>
    );
  } else if (setup?.status === 'working') {
    status = (
      <View style={styles.statusRow}>
        <ActivityIndicator size="small" color={colors.orange} />
        <Text style={styles.small}>Finding its stores near {setup.zip}…</Text>
      </View>
    );
  }
  // Which store it is, how it was set, and where the last prices came from.
  const info = on && setup?.status !== 'working' ? storeInfo(retailer.id, retailer.name, site, settings, storeKey, now) : null;
  const failed = setup?.status === 'failed';

  const removeStore = () =>
    Alert.alert(`Remove ${retailer.name}?`, 'It stops being compared. You can add it again from a search link.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: () => store.removeCustomRetailer(retailer.id) },
    ]);

  const actions = [
    on && hasList && (setup?.status === 'done' || failed) ? (
      <Pill
        key="change"
        label="Change store"
        accessibilityLabel={`Change store: ${retailer.name}`}
        icon="store"
        small
        variant="outline"
        onPress={() => router.push({ pathname: '/choose-store/[retailerId]', params: { retailerId: retailer.id } })}
      />
    ) : null,
    // Nothing to try again without a store finder (a store added from a link).
    on && failed && setup?.reason !== 'no_store_finder' && isUsZip(settings.zip) ? (
      <Pill
        key="retry"
        label="Try again"
        accessibilityLabel={`Try again: ${retailer.name}`}
        icon="refresh"
        small
        variant="outline"
        onPress={() => void setUpStores(settings.zip, deps, [retailer.id], { refresh: true })}
      />
    ) : null,
    on && member ? (
      <Pill
        key="signin"
        label={signedInAt ? 'Sign in again' : `Sign in on ${site}`}
        accessibilityLabel={`${signedInAt ? 'Sign in again' : 'Sign in'} on ${site}, for your ${member!.program} prices`}
        icon="shield"
        small
        variant="outline"
        onPress={() => void signIn()}
      />
    ) : null,
    retailer.addedByUser ? (
      <Pill key="remove" label="Remove" accessibilityLabel={`Remove ${retailer.name}`} icon="trash" small variant="outline" onPress={removeStore} />
    ) : null,
  ].filter(Boolean);

  return (
    <View style={[styles.card, !on && styles.cardOff, setup?.status === 'none' && styles.cardAway]}>
      <View style={styles.row}>
        <RetailerBadge retailerId={retailer.id} name={retailer.name} />
        <View style={styles.flex}>
          <Text style={styles.name}>{retailer.name}</Text>
          {status}
        </View>
        <Switch
          value={on}
          onValueChange={toggle}
          trackColor={{ true: colors.orange, false: colors.faint }}
          thumbColor="#FFFFFF"
          accessibilityLabel={`Compare ${retailer.name}`}
        />
      </View>
      {info ? <StoreBlock info={info} /> : null}
      {on && member ? (
        <View style={styles.memberRow}>
          <Icon name="tag" size={16} color={colors.orangeText} />
          <View style={styles.flex}>
            <Text style={styles.storeTitle}>{member.program}</Text>
            <Text style={styles.small}>
              {isMember ? `Its member prices (“${member.label}”) count in your totals.` : `Member prices (“${member.label}”) show beside the price, but don’t count.`}
              {signedInAt ? ` Signed in on ${site} ${whenLabel(signedInAt, now)}: its searches carry your account.` : ''}
            </Text>
          </View>
          <Switch
            value={isMember}
            onValueChange={(value) => store.setMember(retailer.id, value)}
            trackColor={{ true: colors.orange, false: colors.faint }}
            thumbColor="#FFFFFF"
            accessibilityLabel={`I have a ${member.program}`}
          />
        </View>
      ) : null}
      {actions.length ? <View style={styles.actions}>{actions}</View> : null}
    </View>
  );
}

/** The store a retailer is set to: its name, address and number, how it was set, and where the last prices came from. */
function StoreBlock({ info }: { info: StoreInfo }) {
  const ok = info.check?.tone === 'ok';
  return (
    <View style={styles.storeBlock}>
      <Icon name="pin" size={16} color={colors.orangeText} />
      <View style={styles.flex}>
        <Text style={styles.storeTitle}>{info.title}</Text>
        {info.detail ? <Text style={styles.small}>{info.detail}</Text> : null}
        <Text style={styles.small}>{info.how}</Text>
        {info.check ? (
          <View style={styles.checkRow}>
            <Icon name={ok ? 'check' : 'alert'} size={15} color={ok ? colors.green : colors.amber} strokeWidth={2.5} />
            <Text style={[styles.small, styles.flexText, { color: ok ? colors.green : colors.amber }]}>{info.check.text}</Text>
          </View>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.paper },
  content: { paddingHorizontal: 16, gap: 10 },
  flex: { flex: 1, gap: 3 },
  flexText: { flex: 1 },
  alignStart: { alignSelf: 'flex-start' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  small: { fontFamily: fonts.body, fontSize: 14, lineHeight: 19, color: colors.muted },
  warn: {
    fontFamily: fonts.body,
    fontSize: 14,
    lineHeight: 20,
    color: colors.amber,
    backgroundColor: colors.amberTint,
    borderRadius: radius.md,
    padding: 12,
  },
  locationCard: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    borderWidth: 1.5,
    borderColor: '#F7C2B3',
    padding: 16,
    gap: 12,
    marginBottom: 6,
    ...shadow.card,
  },
  locationTitle: { fontFamily: fonts.display, fontSize: 21, color: colors.ink },
  zipInput: {
    flex: 1,
    // Lets the field shrink to make room for the button on narrow phones.
    minWidth: 0,
    fontFamily: fonts.semibold,
    fontSize: 18,
    letterSpacing: 1,
    color: colors.ink,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.md,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  summary: { fontFamily: fonts.medium, fontSize: 14, lineHeight: 19, color: colors.ink },
  note: { fontFamily: fonts.body, fontSize: 13, lineHeight: 18, color: colors.muted },
  card: { backgroundColor: colors.card, borderRadius: radius.lg, padding: 14, gap: 12, ...shadow.card },
  cardOff: { backgroundColor: '#FBFAF7', shadowOpacity: 0, elevation: 0, borderWidth: 1, borderColor: colors.line },
  cardAway: { backgroundColor: '#FBFAF7' },
  radiusRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 5 },
  radiusLabel: { fontFamily: fonts.medium, fontSize: 14, color: colors.muted },
  radius: { minHeight: 34, justifyContent: 'center', paddingHorizontal: 10, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.card },
  radiusOn: { backgroundColor: colors.pill, borderColor: colors.pill },
  radiusText: { fontFamily: fonts.medium, fontSize: 14, color: colors.ink },
  radiusTextOn: { color: '#ffffff' },
  name: { fontFamily: fonts.semibold, fontSize: 17, color: colors.ink },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingLeft: 52 },
  storeBlock: {
    flexDirection: 'row',
    gap: 8,
    marginLeft: 52,
    paddingTop: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line,
  },
  storeTitle: { fontFamily: fonts.semibold, fontSize: 15, lineHeight: 20, color: colors.ink },
  checkRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 5, marginTop: 2 },
  pressed: { opacity: 0.8 },
  healthLink: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: colors.orangeTint, borderRadius: radius.md, padding: 12 },
  modeCard: { backgroundColor: colors.card, borderRadius: radius.lg, padding: 16, gap: 12, marginBottom: 6, ...shadow.card },
  planRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingTop: 10, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  feeStore: { fontFamily: fonts.medium, color: colors.ink },
  healthText: { flex: 1, fontFamily: fonts.medium, fontSize: 14, lineHeight: 19, color: colors.ink },
  addCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderRadius: radius.lg,
    borderWidth: 1.5,
    borderStyle: 'dashed',
    borderColor: '#F7C2B3',
    padding: 14,
    marginTop: 4,
  },
  addIcon: { width: 40, height: 40, borderRadius: 11, backgroundColor: colors.orangeTint, alignItems: 'center', justifyContent: 'center' },
  family: { flexDirection: 'row', alignItems: 'center', gap: 12, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.line, padding: 14, marginTop: 4 },
  memberRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginLeft: 52,
    paddingTop: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line,
  },
});
