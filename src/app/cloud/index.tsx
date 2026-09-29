import { router, useLocalSearchParams } from 'expo-router';
import React, { useMemo, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AGENT_MODEL, browserUseKey, MAX_RUN_COST_USD, MAX_RUNNING_JOBS, MAX_TERMS, MIN_BALANCE_USD } from '../../cloud/config';
import { CLOUD_RETAILERS, cleanTerms, jobCost, jobStatus, type CloudJob, type CloudRetailerId } from '../../cloud/jobs';
import { cloudRetailers, cloudStoreId, planRetailers } from '../../cloud/plan';
import { costWords, estimateWords, problemWords, RETAILER_NAMES, STATUS_WORDS } from '../../cloud/words';
import { krogerApiConfigured } from '../../onDevice/krogerApi';
import { whenLabel } from '../../pricing/receipt';
import { useApp, useSettings } from '../../state/AppProvider';
import { useCloudBalance, useCloudJobs, useCloudRunner, useSetCloudOn } from '../../state/CloudProvider';
import { Chip } from '../../ui/bits';
import { Pill, tap } from '../../ui/controls';
import { Icon } from '../../ui/Icon';
import { RetailerBadge } from '../../ui/RetailerBadge';
import { ScreenHeader } from '../../ui/ScreenHeader';
import { colors, fonts, money, radius } from '../../ui/theme';
import { useNow } from '../../ui/useNow';

/** `terms`: search terms to start with, a line each (from a list's Find a store). */
type Params = { terms?: string };

/**
 * Cloud fetch: the switch, the engine, the account's credit, the stores searched, a new cloud search, and the searches
 * so far. Off, the app is as it was: nothing here runs.
 */
export default function CloudScreen() {
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<Params>();
  const { store } = useApp();
  const settings = useSettings();
  const cloud = settings.cloud;
  const runner = useCloudRunner();
  // A comparison's sides are on Phone vs. cloud, not here.
  const all = useCloudJobs();
  const jobs = useMemo(() => all.filter((j) => !j.compare), [all]);
  const balance = useCloudBalance();
  const now = useNow(30_000);
  const hasKey = !!browserUseKey();
  const krogerApi = krogerApiConfigured();
  const [draft, setDraft] = useState(params.terms ?? '');
  const [picked, setPicked] = useState<CloudRetailerId[]>(() => CLOUD_RETAILERS.filter((id) => settings.retailerIds.includes(id) || id !== 'kroger'));
  const [starting, setStarting] = useState(false);

  const terms = cleanTerms(draft);
  const plan = planRetailers(picked, settings, krogerApi);
  // What the guardrail counts: every search using the cloud, a comparison's included.
  const running = all.filter((j) => jobStatus(j) === 'running' && j.retailers.some((r) => r.via !== 'device')).length;

  const setCloudOn = useSetCloudOn();
  const setOn = (on: boolean) => {
    tap();
    void setCloudOn(on);
  };

  const start = async () => {
    if (starting) return;
    setStarting(true);
    try {
      const got = await runner.start({ engine: cloud.engine, terms, retailers: plan.retailers, from: { kind: 'cloud' } });
      if (!got.ok) {
        Alert.alert('Not started', problemWords(got));
        return;
      }
      setDraft('');
      balance.refresh();
      router.push(`/cloud/${got.job.id}`);
    } finally {
      setStarting(false);
    }
  };

  const toggle = (id: CloudRetailerId) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  return (
    <View style={styles.screen}>
      <ScreenHeader title="Cloud fetch" subtitle="Walmart and Target through Browser Use’s cloud browsers, as searches that run in the background." />
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 32 }]}>
        <View style={styles.panel}>
          <View style={styles.row}>
            <View style={styles.flex}>
              <Text style={styles.panelTitle} accessibilityRole="header">
                Cloud fetch
              </Text>
              <Text style={styles.meta}>
                {cloud.on
                  ? `On: this phone no longer searches ${cloudRetailers(cloud).map((id) => RETAILER_NAMES[id]).join(' or ')}. They’re searched in the cloud when you ask (Price check, a list, or below), and a notification says when the prices are in. Kroger stays on its official API.`
                  : 'Off: the app works as before, every store searched on this phone.'}
              </Text>
            </View>
            <Switch
              value={cloud.on}
              onValueChange={setOn}
              trackColor={{ true: colors.orange, false: colors.faint }}
              thumbColor="#FFFFFF"
              accessibilityLabel="Cloud fetch"
            />
          </View>
        </View>

        <View style={styles.panel}>
          <Text style={styles.panelTitle} accessibilityRole="header">
            Engine
          </Text>
          <View style={styles.choices} accessibilityRole="radiogroup">
            <Choice label="Scripted browser" selected={cloud.engine === 'scripted'} onPress={() => store.setCloud({ engine: 'scripted' })} />
            <Choice label="AI agent" selected={cloud.engine === 'agent'} onPress={() => store.setCloud({ engine: 'agent' })} />
          </View>
          <Text style={styles.meta}>
            {cloud.engine === 'scripted'
              ? 'The app drives a cloud browser itself over the DevTools protocol, as walmart_store_test.py did: Walmart’s own store page and search pages, about 40 s a store and 2.6 MB a page. One browser per store, stopped as soon as it’s done.'
              : `A Browser Use agent (${AGENT_MODEL}) gets the task in words: set the store, search each term, answer in JSON. Slower; each run is capped at ${money(MAX_RUN_COST_USD)}, and runs on in the cloud when the app is away.`}
          </Text>
          {cloud.engine === 'scripted' ? (
            <>
              <Text style={styles.label}>Target, in scripted mode</Text>
              <View style={styles.choices} accessibilityRole="radiogroup">
                <Choice label="Cloud browser" selected={cloud.targetScripted === 'cloud'} onPress={() => store.setCloud({ targetScripted: 'cloud' })} />
                <Choice label="This phone" selected={cloud.targetScripted === 'device'} onPress={() => store.setCloud({ targetScripted: 'device' })} />
              </View>
              <Text style={styles.meta}>
                Target in a cloud browser: your store is set on its site (its store page’s “Shop this store”, or its store cookies), then its search
                page’s own request is sent again for each term. Target picks a store of its own for a new browser: if its site still asks for another
                once yours is set, Target fails rather than read that store’s prices. This phone: Target is searched here, as before.
              </Text>
            </>
          ) : null}
        </View>

        <View style={styles.panel}>
          <View style={styles.row}>
            <View style={styles.flex}>
              <Text style={styles.panelTitle} accessibilityRole="header">
                Browser Use credit
              </Text>
              {!hasKey ? (
                <Text style={styles.warn}>No API key. Add EXPO_PUBLIC_BROWSER_USE_API_KEY to .env, then restart Expo with --clear.</Text>
              ) : balance.error ? (
                <Text style={styles.warn}>Couldn’t read it: {balance.error}</Text>
              ) : balance.usd !== undefined ? (
                <Text style={[styles.big, balance.usd < MIN_BALANCE_USD && styles.bad]}>{money(balance.usd)}</Text>
              ) : (
                <ActivityIndicator color={colors.orange} />
              )}
              <Text style={styles.meta}>
                Searches don’t start below {money(MIN_BALANCE_USD)}, nor more than {MAX_RUNNING_JOBS} at once, nor with more than {MAX_TERMS} terms.
                {balance.sessions !== undefined ? ` Browsers running for this account now: ${balance.sessions}.` : ''}
              </Text>
            </View>
            {hasKey ? <Pill label="Refresh" small variant="outline" busy={balance.loading} onPress={balance.refresh} /> : null}
          </View>
        </View>

        <View style={styles.panel}>
          <Text style={styles.panelTitle} accessibilityRole="header">
            Stores
          </Text>
          <Text style={styles.meta}>One store per retailer: the one set in Your stores. Where none is set, type its number here.</Text>
          {CLOUD_RETAILERS.map((id) => (
            <StoreRow key={id} retailerId={id} krogerApi={krogerApi} />
          ))}
        </View>

        <View style={styles.panel}>
          <Text style={styles.panelTitle} accessibilityRole="header">
            New cloud search
          </Text>
          <TextInput
            value={draft}
            onChangeText={setDraft}
            placeholder={`Up to ${MAX_TERMS} things, one a line or with commas: milk, eggs`}
            placeholderTextColor={colors.faint}
            multiline
            autoCorrect={false}
            style={styles.input}
            accessibilityLabel="What to search for"
          />
          {terms.length > MAX_TERMS ? <Text style={styles.warn}>That’s {terms.length}: a cloud search takes at most {MAX_TERMS}.</Text> : null}
          <View style={styles.choices}>
            {CLOUD_RETAILERS.map((id) => (
              <Choice key={id} label={RETAILER_NAMES[id]} selected={picked.includes(id)} onPress={() => toggle(id)} multi />
            ))}
          </View>
          {plan.skipped.includes('kroger') && picked.includes('kroger') ? <Text style={styles.meta}>Kroger is left out: its API keys aren’t set (see the README).</Text> : null}
          {terms.length && plan.retailers.length ? (
            <Text style={styles.meta}>
              {plan.retailers.map((r) => `${RETAILER_NAMES[r.retailerId]}: ${r.via === 'browser' ? 'cloud browser' : r.via === 'agent' ? 'agent' : 'this phone'}`).join(' · ')}. Costs{' '}
              {estimateWords({ terms: terms.slice(0, MAX_TERMS), retailers: plan.retailers })}.
            </Text>
          ) : null}
          <Pill
            label={running >= MAX_RUNNING_JOBS ? (all.some((j) => j.compare && jobStatus(j) === 'running') ? 'A comparison is running' : `${running} searches running`) : 'Search in the cloud'}
            icon="cloud"
            variant="orange"
            busy={starting}
            disabled={!cloud.on || !terms.length || !plan.retailers.length || running >= MAX_RUNNING_JOBS}
            onPress={() => void start()}
            style={styles.alignStart}
          />
          {!cloud.on ? <Text style={styles.meta}>Turn Cloud fetch on first.</Text> : null}
        </View>

        <Pressable
          accessibilityRole="button"
          accessibilityHint="Opens Phone vs. cloud"
          onPress={() => router.push('/phone-vs-cloud')}
          style={({ pressed }) => [styles.panel, styles.row, pressed && styles.pressed]}
        >
          <Icon name="phone" color={colors.orange} />
          <View style={styles.flex}>
            <Text style={styles.panelTitle}>Phone vs. cloud</Text>
            <Text style={styles.meta}>The same searches at the same stores on this phone and in the cloud at once, side by side: prices, their store, time, data and cost. It works with Cloud fetch on or off.</Text>
          </View>
          <Icon name="forward" color={colors.faint} />
        </Pressable>

        {jobs.length ? (
          <>
            <View style={styles.sectionRow}>
              <Text style={styles.section} accessibilityRole="header">
                Cloud searches
              </Text>
              {jobs.some((j) => jobStatus(j) !== 'running') ? (
                <Pressable
                  accessibilityRole="button"
                  hitSlop={12}
                  onPress={() => jobs.filter((j) => jobStatus(j) !== 'running').forEach((j) => runner.remove(j.id))}
                >
                  <Text style={styles.link}>Clear finished</Text>
                </Pressable>
              ) : null}
            </View>
            {jobs.map((job) => (
              <JobCard key={job.id} job={job} now={now} />
            ))}
          </>
        ) : null}
      </ScrollView>
    </View>
  );
}

function Choice({ label, selected, onPress, multi }: { label: string; selected: boolean; onPress: () => void; multi?: boolean }) {
  return (
    <Pressable
      accessibilityRole={multi ? 'checkbox' : 'radio'}
      accessibilityState={multi ? { checked: selected } : { selected }}
      onPress={() => {
        tap();
        onPress();
      }}
      style={({ pressed }) => [styles.choice, selected && styles.choiceOn, pressed && styles.pressed]}
    >
      {selected ? <Icon name="check" size={14} color="#FFFFFF" /> : null}
      <Text style={[styles.choiceText, selected && styles.choiceTextOn]}>{label}</Text>
    </Pressable>
  );
}

/** A retailer's store for cloud searches: Your stores', else a number typed here. */
function StoreRow({ retailerId, krogerApi }: { retailerId: CloudRetailerId; krogerApi: boolean }) {
  const { store } = useApp();
  const settings = useSettings();
  const got = cloudStoreId(retailerId, settings, krogerApi);
  const chosen = settings.chosenStores[retailerId];
  const [typed, setTyped] = useState(settings.cloud.storeIds[retailerId] ?? '');
  const from = got.from === 'your stores' ? `${chosen?.name ? `${chosen.name}, ` : ''}store ${got.id}, from Your stores` : got.from === 'zip' ? `The nearest to ${got.id}, through Kroger’s API` : '';
  return (
    <View style={styles.storeRow}>
      <RetailerBadge retailerId={retailerId} name={RETAILER_NAMES[retailerId]} size={24} />
      <View style={styles.flex}>
        <Text style={styles.storeName}>{RETAILER_NAMES[retailerId]}</Text>
        {from ? (
          <Text style={styles.meta}>{from}</Text>
        ) : (
          <TextInput
            value={typed}
            onChangeText={setTyped}
            onEndEditing={() => store.setCloudStoreId(retailerId, typed)}
            placeholder={retailerId === 'kroger' ? 'Kroger locationId, e.g. 01400943' : `${RETAILER_NAMES[retailerId]} store number, e.g. ${retailerId === 'walmart' ? '5260' : '1375'}`}
            placeholderTextColor={colors.faint}
            keyboardType="number-pad"
            autoCorrect={false}
            style={styles.storeInput}
            accessibilityLabel={`${RETAILER_NAMES[retailerId]} store number for cloud searches`}
          />
        )}
        {retailerId === 'kroger' && !krogerApi ? <Text style={styles.meta}>Kroger’s API keys aren’t set, so cloud searches leave Kroger out.</Text> : null}
      </View>
      {got.from === 'your stores' ? (
        <Pressable accessibilityRole="link" hitSlop={12} onPress={() => router.push(`/choose-store/${retailerId}`)}>
          <Text style={styles.link}>Change</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/** One cloud search in the list: its terms, each retailer's state, when, and what it cost. */
function JobCard({ job, now }: { job: CloudJob; now: number }) {
  const status = jobStatus(job);
  const cost = jobCost(job);
  return (
    <Pressable accessibilityRole="button" onPress={() => router.push(`/cloud/${job.id}`)} style={({ pressed }) => [styles.card, pressed && styles.pressed]}>
      <View style={styles.row}>
        <View style={styles.flex}>
          <Text style={styles.jobTitle} numberOfLines={2}>
            {job.terms.join(', ')}
          </Text>
          <Text style={styles.meta}>
            {job.engine === 'agent' ? 'AI agent' : 'Scripted browser'} · {whenLabel(job.createdAt, now)}
            {cost.usd > 0 ? ` · ${costWords(cost.usd)}` : ''}
          </Text>
        </View>
        {status === 'running' ? <ActivityIndicator color={colors.orange} /> : <Icon name="forward" color={colors.faint} />}
      </View>
      <View style={styles.chips}>
        {job.retailers.map((r) => (
          <Chip
            key={r.retailerId}
            label={`${RETAILER_NAMES[r.retailerId]}: ${STATUS_WORDS[r.status].toLowerCase()}`}
            tone={r.status === 'done' ? 'green' : r.status === 'running' || r.status === 'queued' ? 'blue' : r.status === 'cancelled' ? 'plain' : 'red'}
          />
        ))}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.paper },
  content: { paddingHorizontal: 16, gap: 12 },
  flex: { flex: 1, gap: 4 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  pressed: { opacity: 0.8 },
  alignStart: { alignSelf: 'flex-start' },
  panel: { backgroundColor: colors.card, borderRadius: radius.lg, padding: 14, gap: 10, borderWidth: 1, borderColor: colors.line },
  panelTitle: { fontFamily: fonts.semibold, fontSize: 16, color: colors.ink },
  label: { fontFamily: fonts.semibold, fontSize: 14, color: colors.ink, marginTop: 4 },
  meta: { fontFamily: fonts.body, fontSize: 13, lineHeight: 18, color: colors.muted },
  warn: { fontFamily: fonts.medium, fontSize: 14, lineHeight: 19, color: colors.amber },
  big: { fontFamily: fonts.display, fontSize: 28, color: colors.ink },
  bad: { color: colors.red },
  choices: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  choice: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minHeight: 44,
    paddingHorizontal: 14,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.card,
  },
  choiceOn: { backgroundColor: colors.pill, borderColor: colors.pill },
  choiceText: { fontFamily: fonts.medium, fontSize: 15, color: colors.ink },
  choiceTextOn: { color: '#FFFFFF' },
  input: {
    minHeight: 64,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.md,
    padding: 12,
    fontFamily: fonts.body,
    fontSize: 16,
    color: colors.ink,
    textAlignVertical: 'top',
  },
  storeRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingTop: 4 },
  storeName: { fontFamily: fonts.semibold, fontSize: 15, color: colors.ink },
  storeInput: { borderBottomWidth: 1, borderBottomColor: colors.line, paddingVertical: 6, fontFamily: fonts.body, fontSize: 15, color: colors.ink },
  link: { fontFamily: fonts.semibold, fontSize: 14, color: colors.orangeText },
  sectionRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 12 },
  section: { fontFamily: fonts.semibold, fontSize: 13, letterSpacing: 0.8, textTransform: 'uppercase', color: colors.muted },
  card: { backgroundColor: colors.card, borderRadius: radius.lg, padding: 14, gap: 10, borderWidth: 1, borderColor: colors.line },
  jobTitle: { fontFamily: fonts.semibold, fontSize: 16, color: colors.ink },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
});
