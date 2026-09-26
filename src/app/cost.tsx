import React, { useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, Share, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { bytesText } from '../onDevice/scrapeFeed';
import { DEFAULT_INPUTS, measuredFrom, monthlyCost, type CostInputs } from '../pricing/costModel';
import { useAttemptLog } from '../state/AppProvider';
import { Pill, tap } from '../ui/controls';
import { deviceWord } from '../ui/device';
import { ScreenHeader } from '../ui/ScreenHeader';
import { colors, fonts, radius, shadow } from '../ui/theme';

/** "$12,400", or "$3.25" under $100. */
const dollars = (n: number) => (n >= 100 ? `$${Math.round(n).toLocaleString('en-US')}` : `$${n.toFixed(2)}`);
const count = (n: number) => n.toLocaleString('en-US');

const USERS = [10_000, 100_000, 1_000_000];

type Field = { key: keyof CostInputs; label: string; unit?: string; percent?: boolean };
const USE: Field[] = [
  { key: 'listsPerWeek', label: 'Lists priced a week, per user' },
  { key: 'itemsPerList', label: 'Items per list' },
  { key: 'stores', label: 'Stores compared' },
];
const SERVERS: Field[] = [
  { key: 'proxyPerGb', label: 'Residential proxies', unit: '$ per GB' },
  { key: 'botCheckRate', label: 'Server searches that meet a bot check', unit: '%', percent: true },
  { key: 'solvePer1000', label: 'Solving bot checks', unit: '$ per 1,000' },
  { key: 'browserPerHour', label: 'Headless browsers', unit: '$ per browser-hour' },
];

/**
 * What reading the same prices would cost from servers, next to reading them on users' phones: the phone's own
 * measurements, and assumptions anyone can change.
 */
export default function CostScreen() {
  const insets = useSafeAreaInsets();
  const log = useAttemptLog();
  const measured = measuredFrom(log.entries());
  const [inputs, setInputs] = useState<CostInputs>(DEFAULT_INPUTS);
  const [texts, setTexts] = useState<Record<string, string>>({});
  const result = monthlyCost(inputs, measured);

  const shown = (f: Field) => texts[f.key] ?? String(f.percent ? Math.round(inputs[f.key] * 100) : inputs[f.key]);
  const edit = (f: Field, text: string) => {
    setTexts((t) => ({ ...t, [f.key]: text }));
    const value = Number(text.replace(/[^\d.]/g, ''));
    if (text.trim() && Number.isFinite(value)) setInputs((i) => ({ ...i, [f.key]: f.percent ? value / 100 : value }));
  };
  const setUsers = (users: number) => {
    tap();
    setInputs((i) => ({ ...i, users }));
    setTexts((t) => ({ ...t, users: String(users) }));
  };

  const summary = [
    `Reading ${count(result.searchesPerMonth)} searches a month for ${count(inputs.users)} users:`,
    `From servers: about ${dollars(result.total)} a month (${dollars(result.proxy)} proxies, ${dollars(result.solving)} bot checks, ${dollars(result.browsers)} browsers).`,
    `On their phones: $0 to Stretch; each phone uses about ${bytesText(result.phoneBytesPerUserMonth)} a month.`,
    `Measured on a phone: ${measured.searches ? `${bytesText(measured.bytesPerSearch)} and ${(measured.msPerSearch / 1000).toFixed(1)} s per search, over ${measured.searches} searches` : 'starting estimates'}. The rest are assumptions.`,
  ].join('\n');

  return (
    <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScreenHeader title="What servers would cost" subtitle="Reading the same prices from servers, against on your users’ phones." />
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 32 }]}>
        <View style={styles.hero}>
          <View style={styles.side}>
            <Text style={styles.sideLabel}>From servers</Text>
            <Text style={styles.big} accessibilityLabel={`From servers: about ${dollars(result.total)} a month`}>
              {dollars(result.total)}
            </Text>
            <Text style={styles.small}>a month, about {dollars(result.perUser)} per user</Text>
          </View>
          <View style={styles.divider} />
          <View style={styles.side}>
            <Text style={styles.sideLabel}>On phones</Text>
            <Text style={[styles.big, { color: colors.green }]} accessibilityLabel="On phones: nothing to Stretch">
              $0
            </Text>
            <Text style={styles.small}>to Stretch. Each phone uses about {bytesText(result.phoneBytesPerUserMonth)} a month.</Text>
          </View>
        </View>

        <View style={styles.card}>
          <Text style={styles.title} accessibilityRole="header">
            {count(result.searchesPerMonth)} searches a month
          </Text>
          <Row label="Data through residential proxies" value={dollars(result.proxy)} />
          <Row label="Bot checks solved" value={dollars(result.solving)} />
          <Row label="Headless browser time" value={dollars(result.browsers)} />
          <Text style={styles.note}>
            {measured.searches
              ? `Data and time per search as this ${deviceWord} measured them: ${bytesText(measured.bytesPerSearch)} and ${(measured.msPerSearch / 1000).toFixed(1)} s, over its last ${measured.searches} searches.`
              : `Data and time per search are starting estimates (${bytesText(measured.bytesPerSearch)}, ${(measured.msPerSearch / 1000).toFixed(1)} s) until this ${deviceWord} has searched a few times.`}{' '}
            Servers would also need building and looking after: not counted.
          </Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.title} accessibilityRole="header">
            Users
          </Text>
          <View style={styles.chips}>
            {USERS.map((u) => {
              const on = inputs.users === u;
              return (
                <Pressable
                  key={u}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: on }}
                  onPress={() => setUsers(u)}
                  style={[styles.chip, on && styles.chipOn]}
                >
                  <Text style={[styles.chipText, on && styles.chipTextOn]}>{u >= 1_000_000 ? `${u / 1_000_000}M` : `${u / 1000}k`}</Text>
                </Pressable>
              );
            })}
          </View>
          {USE.map((f) => (
            <NumberRow key={f.key} field={f} value={shown(f)} onChange={(t) => edit(f, t)} />
          ))}
        </View>

        <View style={styles.card}>
          <Text style={styles.title} accessibilityRole="header">
            Server assumptions
          </Text>
          <Text style={styles.small}>Change them to your own quotes: they’re a starting point, not prices anyone offered.</Text>
          {SERVERS.map((f) => (
            <NumberRow key={f.key} field={f} value={shown(f)} onChange={(t) => edit(f, t)} />
          ))}
        </View>

        <Pill label="Share these numbers" icon="share" variant="outline" onPress={() => void Share.share({ message: summary }).catch(() => {})} />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text style={[styles.body, styles.flex]}>{label}</Text>
      <Text style={styles.value}>{value}</Text>
    </View>
  );
}

function NumberRow({ field, value, onChange }: { field: Field; value: string; onChange: (text: string) => void }) {
  return (
    <View style={styles.row}>
      <View style={styles.flex}>
        <Text style={styles.body}>{field.label}</Text>
        {field.unit ? <Text style={styles.small}>{field.unit}</Text> : null}
      </View>
      <TextInput
        value={value}
        onChangeText={onChange}
        keyboardType="decimal-pad"
        returnKeyType="done"
        style={styles.input}
        accessibilityLabel={`${field.label}${field.unit ? `, ${field.unit}` : ''}`}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.paper },
  content: { paddingHorizontal: 16, gap: 12 },
  flex: { flex: 1 },
  hero: { flexDirection: 'row', backgroundColor: colors.card, borderRadius: radius.lg, padding: 16, gap: 14, ...shadow.card },
  side: { flex: 1, gap: 2 },
  sideLabel: { fontFamily: fonts.semibold, fontSize: 13, letterSpacing: 0.6, textTransform: 'uppercase', color: colors.muted },
  big: { fontFamily: fonts.display, fontSize: 34, lineHeight: 40, color: colors.ink },
  divider: { width: StyleSheet.hairlineWidth, backgroundColor: colors.line },
  card: { backgroundColor: colors.card, borderRadius: radius.lg, padding: 16, gap: 10, ...shadow.card },
  title: { fontFamily: fonts.semibold, fontSize: 17, color: colors.ink },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  body: { fontFamily: fonts.body, fontSize: 15, lineHeight: 21, color: colors.ink },
  value: { fontFamily: fonts.semibold, fontSize: 16, color: colors.ink },
  small: { fontFamily: fonts.body, fontSize: 13, lineHeight: 18, color: colors.muted },
  note: { fontFamily: fonts.body, fontSize: 13, lineHeight: 18, color: colors.muted, marginTop: 2 },
  chips: { flexDirection: 'row', gap: 8 },
  chip: { minHeight: 36, justifyContent: 'center', paddingHorizontal: 14, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.line },
  chipOn: { backgroundColor: colors.pill, borderColor: colors.pill },
  chipText: { fontFamily: fonts.medium, fontSize: 14, color: colors.ink },
  chipTextOn: { color: '#ffffff' },
  input: {
    width: 96,
    textAlign: 'right',
    fontFamily: fonts.semibold,
    fontSize: 16,
    color: colors.ink,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.md,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
});

