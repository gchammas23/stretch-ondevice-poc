import { router } from 'expo-router';
import React, { useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  COMPARE_RETAILERS,
  compareProblemWords,
  comparisonEstimate,
  comparisonProblems,
  comparisonStatus,
  comparisonSummary,
  SIDE_NAMES,
  type CompareRequest,
  type Comparison,
} from '../../cloud/compare';
import { AGENT_MODEL, browserUseKey, MAX_RUN_COST_USD, MAX_TERMS, MIN_BALANCE_USD } from '../../cloud/config';
import { cleanTerms } from '../../cloud/jobs';
import { costWords, RETAILER_NAMES } from '../../cloud/words';
import { searchText } from '../../lists/types';
import { whenLabel } from '../../pricing/receipt';
import { useApp, useAppState, useSettings } from '../../state/AppProvider';
import { useAskForNotificationsOnce, useCloudBalance, useCloudRunner, useComparisons } from '../../state/CloudProvider';
import { Chip } from '../../ui/bits';
import { Pill, tap } from '../../ui/controls';
import { FindingsBox } from '../../ui/FindingsBox';
import { Icon } from '../../ui/Icon';
import { RetailerBadge } from '../../ui/RetailerBadge';
import { ScreenHeader } from '../../ui/ScreenHeader';
import { colors, fonts, money, radius, shadow } from '../../ui/theme';
import { useComparisonPdf } from '../../ui/useComparisonPdf';
import { useNow } from '../../ui/useNow';

/**
 * Phone vs. cloud: the same searches at the same stores, on this phone (the way the app prices) and in Browser Use's
 * cloud (the cloud browser the app drives, and the AI agent if added), at once, then side by side (see compare.ts).
 * It needs the Browser Use key, and works whether Cloud fetch is on or off.
 */
export default function PhoneVsCloudScreen() {
  const insets = useSafeAreaInsets();
  const { bundle } = useApp();
  const settings = useSettings();
  const lists = useAppState((s) => s.lists);
  const runner = useCloudRunner();
  const all = useComparisons();
  const pdf = useComparisonPdf();
  const balance = useCloudBalance();
  const askOnce = useAskForNotificationsOnce();
  const now = useNow(30_000);
  const hasKey = !!browserUseKey();
  const [draft, setDraft] = useState('');
  const [agent, setAgent] = useState(false);
  const [starting, setStarting] = useState(false);

  // Each store as Your stores has it: the phone is set to it on the retailer's own site, so it's the one compared.
  const stores = COMPARE_RETAILERS.map((retailerId) => ({
    retailerId,
    storeId: settings.storeIds[retailerId] ?? '',
    name: settings.chosenStores[retailerId]?.name,
    inRules: bundle.retailers.some((r) => r.id === retailerId && r.enabled),
  }));
  const ready = stores.filter((s) => s.storeId && s.inRules);
  const terms = cleanTerms(draft);
  const req: CompareRequest = { terms: terms.slice(0, MAX_TERMS), retailers: ready.map(({ retailerId, storeId }) => ({ retailerId, storeId })), agent };
  const estimate = comparisonEstimate(req);
  const running = all.find((c) => comparisonStatus(c) === 'running');
  const finished = all.filter((c) => comparisonStatus(c) !== 'running');
  const canStart = hasKey && !!ready.length && !!terms.length && terms.length <= MAX_TERMS && !running;

  const start = async () => {
    if (starting) return;
    tap();
    setStarting(true);
    try {
      await askOnce();
      const got = await runner.startComparison(req);
      if (!got.ok) {
        Alert.alert('Not started', compareProblemWords(got));
        return;
      }
      setDraft('');
      balance.refresh();
      router.push(`/phone-vs-cloud/${got.comparison.id}`);
    } finally {
      setStarting(false);
    }
  };

  return (
    <View style={styles.screen}>
      <ScreenHeader title="Phone vs. cloud" subtitle="The same searches at the same stores, on this phone and in Browser Use’s cloud, side by side." />
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 32 }]}>
        <View style={styles.card}>
          <Text style={styles.lead}>Does the cloud read what this phone reads?</Text>
          <Text style={styles.body}>
            A comparison searches your Walmart and Target stores for the same things two ways at once: on this phone, the way the app prices (its own
            browser, set to your store on the store’s site), and in the cloud (a Browser Use browser the app drives
            {agent ? ', and Browser Use’s AI agent' : ''}). Then, store by store: which way got prices, for which store, the same products’ prices, and
            what each took in time, data and money.
          </Text>
        </View>

        {running ? <RunningCard comparison={running} /> : null}

        <View style={styles.card}>
          <Text style={styles.title} accessibilityRole="header">
            Stores
          </Text>
          {stores.map((s) => (
            <View key={s.retailerId} style={styles.storeRow}>
              <RetailerBadge retailerId={s.retailerId} name={RETAILER_NAMES[s.retailerId]} size={28} />
              <View style={styles.flex}>
                <Text style={styles.storeName}>{RETAILER_NAMES[s.retailerId]}</Text>
                <Text style={styles.small}>
                  {!s.inRules
                    ? 'Not in the store rules on this phone: left out.'
                    : s.storeId
                      ? `${s.name ? `${s.name}, ` : ''}store ${s.storeId}, from Your stores`
                      : 'No store set in Your stores: left out until one is.'}
                </Text>
              </View>
              {s.inRules ? (
                <Pressable accessibilityRole="link" hitSlop={12} onPress={() => router.push(`/choose-store/${s.retailerId}`)}>
                  <Text style={styles.link}>{s.storeId ? 'Change' : 'Set one'}</Text>
                </Pressable>
              ) : null}
            </View>
          ))}
          <Text style={styles.small}>Kroger isn’t compared: its official API reads it the same way on the phone and off it.</Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.title} accessibilityRole="header">
            What to search for
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
          {terms.length > MAX_TERMS ? <Text style={styles.warn}>That’s {terms.length}: a comparison takes at most {MAX_TERMS}.</Text> : null}
          {lists.some((l) => l.items.length) ? (
            <>
              <Text style={styles.small}>Or a list’s first {MAX_TERMS} items:</Text>
              <View style={styles.chips}>
                {lists
                  .filter((l) => l.items.length)
                  .map((l) => (
                    <Pressable
                      key={l.id}
                      accessibilityRole="button"
                      accessibilityLabel={`Use ${l.name}’s first ${Math.min(MAX_TERMS, l.items.length)} items`}
                      onPress={() => {
                        tap();
                        setDraft(cleanTerms(l.items.map(searchText)).slice(0, MAX_TERMS).join('\n'));
                      }}
                      style={({ pressed }) => [styles.chip, pressed && styles.pressed]}
                    >
                      <Text style={styles.chipText}>{l.name}</Text>
                    </Pressable>
                  ))}
              </View>
            </>
          ) : null}
        </View>

        <View style={styles.card}>
          <Text style={styles.title} accessibilityRole="header">
            The cloud’s side
          </Text>
          <View style={styles.rowTop}>
            <View style={styles.iconLine}>
              <Icon name="check" size={16} color={colors.green} />
            </View>
            <Text style={[styles.body, styles.flex]}>The cloud browser, always: the app drives a Browser Use browser itself, as Cloud fetch’s scripted engine does.</Text>
          </View>
          <View style={styles.row}>
            <View style={styles.flex}>
              <Text style={styles.body}>Add the AI agent</Text>
              <Text style={styles.small}>
                A third column: Browser Use’s agent ({AGENT_MODEL}) given the searches in words. Up to {money(MAX_RUN_COST_USD)} a store, and slower.
              </Text>
            </View>
            <Switch
              value={agent}
              onValueChange={(on) => {
                tap();
                setAgent(on);
              }}
              trackColor={{ true: colors.orange, false: colors.faint }}
              thumbColor="#FFFFFF"
              accessibilityLabel="Add the AI agent"
            />
          </View>
        </View>

        <View style={styles.card}>
          {!hasKey ? (
            <Text style={styles.warn}>No Browser Use API key in this build. Add EXPO_PUBLIC_BROWSER_USE_API_KEY to .env, then restart Expo with --clear.</Text>
          ) : (
            <Text style={styles.small}>
              Browser Use credit:{' '}
              {balance.error ? `couldn’t read it (${balance.error})` : balance.usd !== undefined ? money(balance.usd) : balance.loading ? 'reading…' : 'unknown'}. A
              comparison doesn’t start below {money(MIN_BALANCE_USD)}.
            </Text>
          )}
          {terms.length && ready.length ? (
            <Text style={styles.small}>
              {estimate.capped
                ? `Costs up to ${money(estimate.usd)}: the cloud browser a few cents, each agent run at most ${money(MAX_RUN_COST_USD)}.`
                : `Costs about ${Math.max(1, Math.round(estimate.usd * 100))}¢, for the cloud browser. This phone’s side is free.`}
            </Text>
          ) : null}
          <Pill
            label={running ? 'A comparison is running' : 'Compare'}
            icon="zap"
            variant="orange"
            busy={starting}
            disabled={!canStart}
            onPress={() => void start()}
            style={styles.alignStart}
          />
          <Text style={styles.small}>
            Keep the app open while it runs: this phone’s side searches only while the app is on screen. Both sides start at once, and this phone’s
            searches count toward each store’s hour, as the app’s do.
          </Text>
        </View>

        {finished.length ? (
          <>
            <View style={styles.card}>
              <Text style={styles.title} accessibilityRole="header">
                Share every run
              </Text>
              <Text style={styles.small}>
                One PDF of {finished.length === 1 ? 'the run' : `all ${finished.length} runs`} on this phone: the totals across them, a table of the runs, then each run store by
                store, with every product each side read, what went wrong and why.
              </Text>
              <FindingsBox label="Findings for the report" placeholder="What the runs showed, for the team: at the top of the PDF." />
              <Pill
                label={pdf.busy ? 'Making the PDF…' : `Share all runs (${finished.length})`}
                accessibilityLabel={`Share all runs as a PDF: ${finished.length}`}
                icon="share"
                variant="orange"
                busy={pdf.busy}
                onPress={() => {
                  tap();
                  void pdf.share('all', finished);
                }}
                style={styles.alignStart}
              />
              {pdf.problem ? (
                <Text style={styles.bad} selectable accessibilityLiveRegion="polite">
                  {pdf.problem}
                </Text>
              ) : null}
            </View>
            <View style={styles.sectionRow}>
              <Text style={styles.section} accessibilityRole="header">
                Comparisons
              </Text>
              <Pressable
                accessibilityRole="button"
                hitSlop={12}
                onPress={() =>
                  Alert.alert(
                    `Clear ${finished.length === 1 ? 'this run' : `these ${finished.length} runs`}?`,
                    'Their results and your findings about them go from this phone. The report’s own findings stay.',
                    [
                      { text: 'Keep them', style: 'cancel' },
                      { text: 'Clear', style: 'destructive', onPress: () => finished.forEach((c) => runner.removeComparison(c.id)) },
                    ],
                  )
                }
              >
                <Text style={styles.link}>Clear</Text>
              </Pressable>
            </View>
            {finished.map((c) => (
              <ComparisonCard key={c.id} comparison={c} now={now} />
            ))}
          </>
        ) : null}

        <HowItWorks />
      </ScrollView>
    </View>
  );
}

/** The comparison running now, and the way to it. */
function RunningCard({ comparison }: { comparison: Comparison }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityHint="Opens the comparison"
      onPress={() => router.push(`/phone-vs-cloud/${comparison.id}`)}
      style={({ pressed }) => [styles.card, styles.running, pressed && styles.pressed]}
    >
      <View style={styles.row}>
        <ActivityIndicator color={colors.orange} />
        <View style={styles.flex}>
          <Text style={styles.title}>Comparing “{comparison.terms.join('”, “')}”</Text>
          <Text style={styles.small}>Keep the app open until this phone’s side is done.</Text>
        </View>
        <Icon name="forward" color={colors.faint} />
      </View>
    </Pressable>
  );
}

/** A finished comparison in the list: its searches, when, and each side's stores with prices and cost. */
function ComparisonCard({ comparison: c, now }: { comparison: Comparison; now: number }) {
  const summary = comparisonSummary(c);
  const status = comparisonStatus(c);
  const same = summary.prices.find((p) => p.side === 'scripted');
  const problems = comparisonProblems(c).length;
  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => router.push(`/phone-vs-cloud/${c.id}`)}
      style={({ pressed }) => [styles.card, pressed && styles.pressed]}
    >
      <View style={styles.row}>
        <View style={styles.flex}>
          <Text style={styles.storeName} numberOfLines={2}>
            {c.terms.join(', ')}
          </Text>
          <Text style={styles.small}>
            {whenLabel(c.createdAt, now)}
            {status !== 'done' ? ` · ${status}` : ''}
            {same?.both ? ` · same price ${same.same} of ${same.both}` : ''}
            {problems ? ` · ${problems} ${problems === 1 ? 'problem' : 'problems'}` : ''}
          </Text>
        </View>
        <Icon name="forward" color={colors.faint} />
      </View>
      <View style={styles.chips}>
        {summary.sides.map((s) => (
          <Chip
            key={s.side}
            label={`${SIDE_NAMES[s.side]}: ${s.withPrices} of ${s.stores}${s.side !== 'phone' && s.usd > 0 ? ` · ${costWords(s.usd)}` : ''}`}
            tone={s.withPrices === s.stores ? 'green' : s.withPrices ? 'orange' : 'red'}
          />
        ))}
      </View>
    </Pressable>
  );
}

function HowItWorks() {
  return (
    <View style={styles.card}>
      <Text style={styles.title} accessibilityRole="header">
        How a comparison works
      </Text>
      <Bullet text="This phone: each search in the app’s own browser, hidden, at the store set in Your stores (Walmart’s set on its site; Target’s number put in its page’s own requests), read the way the app reads prices (a page load, or the store’s own request sent again from its page)." />
      <Bullet text="The cloud browser: a Browser Use browser in the U.S., through home internet addresses Browser Use rents. The app drives it from this phone: Walmart’s store page and its button, then a search page a term; Target’s store page and its “Shop this store” (or its store cookies, when that doesn’t take), then its search page, whose own request must ask for your store, sent again for each term." />
      <Bullet text="The AI agent, if added: Browser Use’s agent is asked, in words, to set the store on its page and open each term’s search page, and answers in JSON with the first 10 products." />
      <Bullet text="Measured as a server would run it: the cloud browser’s time comes with an estimate for a server, which takes out what driving it from this phone added (a trip over your connection a step). Its data to this phone is the results a server would send; what driving it moved here is shown apart, and not counted. Each store’s browser starts from a profile Browser Use keeps for that store, so Walmart’s and Target’s stores stay set from one run to the next." />
      <Text style={styles.small}>
        Both run at the same time, since prices change. The same product is matched by the store’s own item number, and this phone’s price is the
        reference: it’s set to your store on the store’s own site. A price that differs may be the other store’s, a sale one side read and the other
        didn’t, or a change between the two reads. Bot checks are noted on both sides, never shown or pressed.
      </Text>
    </View>
  );
}

function Bullet({ text }: { text: string }) {
  return (
    <View style={styles.bullet}>
      <Text style={styles.body} accessibilityElementsHidden importantForAccessibility="no">
        •
      </Text>
      <Text style={[styles.body, styles.flex]}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.paper },
  content: { paddingHorizontal: 16, gap: 12 },
  flex: { flex: 1, gap: 2 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  rowTop: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  // Level with the first line of the words beside it.
  iconLine: { paddingTop: 3 },
  pressed: { opacity: 0.8 },
  alignStart: { alignSelf: 'flex-start' },
  card: { backgroundColor: colors.card, borderRadius: radius.lg, padding: 16, gap: 10, ...shadow.card },
  running: { borderWidth: 1, borderColor: colors.orange },
  lead: { fontFamily: fonts.display, fontSize: 22, lineHeight: 28, color: colors.ink },
  title: { fontFamily: fonts.semibold, fontSize: 17, color: colors.ink },
  body: { fontFamily: fonts.body, fontSize: 15, lineHeight: 21, color: colors.ink },
  small: { flexShrink: 1, fontFamily: fonts.body, fontSize: 13, lineHeight: 18, color: colors.muted },
  warn: { fontFamily: fonts.medium, fontSize: 14, lineHeight: 19, color: colors.amber },
  bad: { fontFamily: fonts.medium, fontSize: 14, lineHeight: 19, color: colors.red },
  storeRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  storeName: { fontFamily: fonts.semibold, fontSize: 15, color: colors.ink },
  link: { fontFamily: fonts.semibold, fontSize: 14, color: colors.orangeText },
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
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 14, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.line },
  chipText: { fontFamily: fonts.medium, fontSize: 14, color: colors.ink },
  sectionRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 12 },
  section: { fontFamily: fonts.semibold, fontSize: 13, letterSpacing: 0.8, textTransform: 'uppercase', color: colors.muted },
  bullet: { flexDirection: 'row', gap: 8 },
});
