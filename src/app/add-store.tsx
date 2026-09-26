import { router } from 'expo-router';
import React, { useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { SearchFailed } from '../onDevice/retailerSearch';
import { reasonWords } from '../onDevice/scrapeFeed';
import type { Product } from '../onDevice/types';
import { sourceWords } from '../pricing/receipt';
import { draftFromLink, storeFromDraft } from '../state/customStores';
import { useApp, useSettings, useSetupDeps } from '../state/AppProvider';
import { isUsZip, setUpStores } from '../state/storeSetup';
import { announce } from '../ui/a11y';
import { Pill, ProductThumb } from '../ui/controls';
import { deviceWord } from '../ui/device';
import { Icon } from '../ui/Icon';
import { RetailerBadge } from '../ui/RetailerBadge';
import { ScreenHeader } from '../ui/ScreenHeader';
import { colors, fonts, money, radius, shadow } from '../ui/theme';

type Test =
  | { state: 'idle' }
  | { state: 'testing' }
  | { state: 'ok'; products: Product[]; count: number; ms: number; source?: string }
  | { state: 'empty'; ms: number }
  | { state: 'failed'; reason?: string; detail?: string };

/**
 * Add a store from a search link. The link becomes a search template and the phone tries it right here, with the
 * same general product reader every WebView store uses. No code per store: this is the on-device approach's reach.
 */
export default function AddStoreScreen() {
  const insets = useSafeAreaInsets();
  const { store, search, bundle } = useApp();
  const settings = useSettings();
  const deps = useSetupDeps();
  const [link, setLink] = useState('');
  const [word, setWord] = useState('');
  const [name, setName] = useState('');
  const [test, setTest] = useState<Test>({ state: 'idle' });

  const result = link.trim() ? draftFromLink(link, word) : null;
  const draft = result?.ok ? result.draft : null;
  const cfg = draft ? storeFromDraft(draft, name, bundle.retailers.map((r) => r.id)) : null;
  const changed = <T,>(set: (v: T) => void) => (v: T) => {
    set(v);
    setTest({ state: 'idle' });
  };

  const runTest = async () => {
    if (!cfg || !draft) return;
    setTest({ state: 'testing' });
    const t0 = Date.now();
    try {
      const out = await search.search(cfg, draft.word, '', 'webview');
      const priced = out.products.filter((p) => typeof p.price === 'number');
      const ms = Date.now() - t0;
      setTest(priced.length ? { state: 'ok', products: priced.slice(0, 3), count: priced.length, ms, source: out.source } : { state: 'empty', ms });
      announce(priced.length ? `Found ${priced.length} products with prices.` : 'The page loaded, but listed no products with prices.');
    } catch (e) {
      const failed = e instanceof SearchFailed ? e.attempts.find((a) => !a.ok) : undefined;
      setTest({ state: 'failed', reason: failed?.reason ?? String(e), detail: failed?.detail });
      announce('No prices came back.');
    }
  };

  const add = () => {
    if (!cfg) return;
    store.addCustomRetailer(cfg);
    // Its store is chosen on its own site, like the other stores without an automatic store finder.
    if (isUsZip(settings.zip)) void setUpStores(settings.zip, { ...deps, retailers: [...deps.retailers, cfg] }, [cfg.id]);
    router.back();
  };

  return (
    <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScreenHeader title="Add a store" subtitle="Any grocery site that shows prices online. No code: the phone reads it like the others." />
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 32 }]}>
        <View style={styles.card}>
          <Text style={styles.step} accessibilityRole="header">
            1. Search the store’s website
          </Text>
          <Text style={styles.small}>
            In your browser, search the store’s site for something, milk say. Then copy the address of the results page and paste it here.
          </Text>
          <TextInput
            value={link}
            onChangeText={changed(setLink)}
            placeholder="https://www.foodlion.com/search?q=milk"
            placeholderTextColor={colors.faint}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            returnKeyType="done"
            style={styles.input}
            accessibilityLabel="Search results link"
            accessibilityHint={result && !result.ok ? result.message : undefined}
          />
          {result && !result.ok ? <Text style={styles.error}>{result.message}</Text> : null}
          {draft ? (
            <View style={styles.template}>
              <Icon name="check" size={16} color={colors.green} strokeWidth={2.6} />
              <Text style={[styles.small, styles.flex]}>
                Searches go to <Text style={styles.strong}>{draft.host}</Text>, with each list item in place of “{draft.word}”.
              </Text>
            </View>
          ) : null}
          <Text style={styles.label}>What you searched for</Text>
          <TextInput
            value={word}
            onChangeText={changed(setWord)}
            placeholder={draft?.word ?? 'milk'}
            placeholderTextColor={colors.faint}
            autoCapitalize="none"
            autoCorrect={false}
            style={styles.input}
            accessibilityLabel="What you searched for"
          />
          <Text style={styles.hint}>Only needed when Stretch can’t tell which part of the link is the search.</Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.step} accessibilityRole="header">
            2. Name it
          </Text>
          <View style={styles.nameRow}>
            {cfg ? <RetailerBadge retailerId={cfg.id} name={cfg.name} size={40} /> : null}
            <TextInput
              value={name}
              onChangeText={changed(setName)}
              placeholder={draft?.name ?? 'Store name'}
              placeholderTextColor={colors.faint}
              autoCapitalize="words"
              style={[styles.input, styles.flex]}
              accessibilityLabel="Store name"
            />
          </View>
        </View>

        <View style={styles.card}>
          <Text style={styles.step} accessibilityRole="header">
            3. Try it on this {deviceWord}
          </Text>
          <Text style={styles.small}>
            The phone opens the search in a hidden browser and looks through what the page loads for products with prices, the same way it
            reads every other store.
          </Text>
          <Pill
            label={test.state === 'testing' ? 'Reading…' : `Search for “${draft?.word ?? 'milk'}”`}
            icon="search"
            variant="dark"
            busy={test.state === 'testing'}
            disabled={!cfg}
            onPress={runTest}
            style={styles.alignStart}
          />
          {test.state === 'testing' ? (
            <View style={styles.template}>
              <ActivityIndicator size="small" color={colors.orange} />
              <Text style={[styles.small, styles.flex]}>Loading {draft?.host} and reading what it sends…</Text>
            </View>
          ) : null}
          {test.state === 'ok' ? (
            <View style={styles.found}>
              <Text style={[styles.body, { color: colors.green }]}>
                Found {test.count} products with prices in {(test.ms / 1000).toFixed(1)} s.
              </Text>
              {test.products.map((p) => (
                <View key={p.id} style={styles.product}>
                  <ProductThumb product={p} size={44} />
                  <Text style={[styles.body, styles.flex]} numberOfLines={2}>
                    {p.name}
                  </Text>
                  <Text style={styles.price}>{money(p.price!)}</Text>
                </View>
              ))}
              {test.source ? <Text style={styles.hint}>The prices were in {sourceWords(test.source)}.</Text> : null}
            </View>
          ) : null}
          {test.state === 'empty' ? (
            <Text style={[styles.small, { color: colors.amber }]}>
              The page loaded, but listed no products with prices. The site may want a store chosen first, which Stretch can’t do for a store added from a link.
            </Text>
          ) : null}
          {test.state === 'failed' ? (
            <Text style={[styles.small, { color: colors.amber }]}>
              {test.detail ?? `No prices came back (${reasonWords(test.reason)}).`} Some sites need a store chosen first, and some don’t show prices
              online at all.
            </Text>
          ) : null}
        </View>

        <Pill
          label={cfg ? `Add ${cfg.name}` : 'Add store'}
          variant="orange"
          disabled={!cfg || test.state !== 'ok'}
          onPress={add}
        />
        {cfg && (test.state === 'failed' || test.state === 'empty') ? (
          <Pill label="Add it anyway" variant="outline" onPress={add} />
        ) : null}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.paper },
  content: { paddingHorizontal: 16, gap: 12 },
  flex: { flex: 1 },
  alignStart: { alignSelf: 'flex-start' },
  card: { backgroundColor: colors.card, borderRadius: radius.lg, padding: 16, gap: 10, ...shadow.card },
  step: { fontFamily: fonts.semibold, fontSize: 17, color: colors.ink },
  label: { fontFamily: fonts.semibold, fontSize: 14, color: colors.ink, marginTop: 4 },
  small: { fontFamily: fonts.body, fontSize: 14, lineHeight: 20, color: colors.muted },
  body: { fontFamily: fonts.body, fontSize: 15, lineHeight: 21, color: colors.ink },
  strong: { fontFamily: fonts.semibold, color: colors.ink },
  hint: { fontFamily: fonts.body, fontSize: 13, lineHeight: 18, color: colors.muted },
  error: { fontFamily: fonts.body, fontSize: 14, lineHeight: 20, color: colors.red },
  input: {
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.md,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontFamily: fonts.body,
    fontSize: 16,
    color: colors.ink,
    minWidth: 0,
  },
  template: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  found: { gap: 8 },
  product: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  price: { fontFamily: fonts.semibold, fontSize: 15, color: colors.ink },
});
