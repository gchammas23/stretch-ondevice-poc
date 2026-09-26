import { router, useLocalSearchParams } from 'expo-router';
import React, { useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { onListAs, recipeItems, type Recipe } from '../../../lists/recipe';
import { reasonWords } from '../../../onDevice/scrapeFeed';
import { useApp, useList } from '../../../state/AppProvider';
import { announce, useFooterHeight } from '../../../ui/a11y';
import { Pill, tap } from '../../../ui/controls';
import { deviceWord } from '../../../ui/device';
import { Icon } from '../../../ui/Icon';
import { ScreenHeader } from '../../../ui/ScreenHeader';
import { colors, fonts, radius, shadow } from '../../../ui/theme';

/** Kitchen staples most people have: left unticked, so they aren't bought by accident. */
const PANTRY = /^(water|ice|salt|pepper|salt and pepper|black pepper|kosher salt|sea salt|table salt)$/i;

type Read = { state: 'idle' } | { state: 'reading' } | { state: 'done'; recipe: Recipe } | { state: 'failed'; reason: string };

/**
 * Recipe to list: paste a recipe's link, the phone reads the recipe data the page publishes for search engines (no
 * AI), and the ingredients you tick become items.
 */
export default function RecipeScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const list = useList(id);
  const insets = useSafeAreaInsets();
  const { search, store } = useApp();
  const [link, setLink] = useState('');
  const [read, setRead] = useState<Read>({ state: 'idle' });
  const [skipped, setSkipped] = useState<Set<string>>(new Set());
  const [footerHeight, onFooterLayout] = useFooterHeight(110 + insets.bottom);

  if (!list) return <ScreenHeader title="Add from a recipe" subtitle="This list was deleted." />;
  const items = read.state === 'done' ? recipeItems(read.recipe) : [];
  const onList = (name: string) => onListAs(name, list.items);
  const chosen = items.filter((i) => !skipped.has(i.name) && !onList(i.name)?.same);

  const start = async () => {
    let url = link.trim();
    if (!url) return;
    if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
    url = url.replace(/^http:\/\//i, 'https://');
    setRead({ state: 'reading' });
    try {
      const recipe = await search.readRecipe(url);
      const found = recipeItems(recipe);
      // Staples, and what the list may already have ("Butter" for unsalted butter), start unticked.
      setSkipped(new Set(found.filter((i) => PANTRY.test(i.name) || onList(i.name)).map((i) => i.name)));
      setRead({ state: 'done', recipe });
      announce(`${recipe.name ?? 'Recipe'}: ${found.length} ingredients. Untick what you have.`);
    } catch (e) {
      const reason = (e as { reason?: string })?.reason ?? String(e);
      setRead({ state: 'failed', reason });
      announce(reason === 'no_recipe' ? 'That page doesn’t publish its recipe in a way the phone can read.' : 'Couldn’t read that page.');
    }
  };

  const toggle = (name: string) =>
    setSkipped((s) => {
      const next = new Set(s);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  const add = () => {
    tap();
    store.addItems(list.id, chosen);
    router.back();
  };

  return (
    <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScreenHeader title="Add from a recipe" subtitle={`To ${list.name}. The phone reads the recipe from its page; no AI.`} />
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={[styles.content, { paddingBottom: footerHeight + 16 }]}>
        <View style={styles.card}>
          <Text style={styles.label}>Recipe link</Text>
          <TextInput
            value={link}
            onChangeText={(t) => {
              setLink(t);
              if (read.state !== 'reading') setRead({ state: 'idle' });
            }}
            onSubmitEditing={() => void start()}
            placeholder="https://www.allrecipes.com/recipe/…"
            placeholderTextColor={colors.faint}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            returnKeyType="go"
            style={styles.input}
            accessibilityLabel="Recipe link"
          />
          <Pill
            label={read.state === 'reading' ? 'Reading…' : 'Read the recipe'}
            icon="book"
            variant="dark"
            small
            busy={read.state === 'reading'}
            disabled={!link.trim()}
            onPress={() => void start()}
            style={styles.alignStart}
          />
          {read.state === 'reading' ? (
            <View style={styles.row}>
              <ActivityIndicator size="small" color={colors.orange} />
              <Text style={styles.small}>Loading the recipe page on this {deviceWord}, hidden, and reading its recipe…</Text>
            </View>
          ) : null}
          {read.state === 'failed' ? (
            <Text style={[styles.small, { color: colors.amber }]}>
              {read.reason === 'no_recipe'
                ? 'That page doesn’t publish its recipe in a way the phone can read. Most big recipe sites do; try another.'
                : `Couldn’t read that page (${reasonWords(read.reason)}).`}
            </Text>
          ) : null}
        </View>

        {read.state === 'done' ? (
          <View style={styles.card}>
            <Text style={styles.title} accessibilityRole="header">
              {read.recipe.name ?? 'Recipe'}
            </Text>
            <Text style={styles.small}>
              {read.recipe.ingredients.length} ingredients{read.recipe.yields ? ` · ${read.recipe.yields}` : ''}. Untick what you have.
            </Text>
            {items.map((i) => {
              const had = onList(i.name);
              const on = !skipped.has(i.name) && !had?.same;
              const note = had?.same ? 'Already on the list' : had ? `On the list as ${had.name} · ${i.note}` : i.note;
              return (
                <Pressable
                  key={i.name}
                  onPress={() => !had?.same && toggle(i.name)}
                  disabled={had?.same}
                  style={styles.item}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: on, disabled: had?.same }}
                  accessibilityLabel={`${i.name}, ${note}`}
                >
                  <View style={[styles.tick, on && styles.tickOn]}>{on ? <Icon name="check" size={16} color="#ffffff" strokeWidth={3} /> : null}</View>
                  <View style={styles.flex}>
                    <Text style={[styles.itemName, !on && styles.off]}>{i.name}</Text>
                    <Text style={styles.note}>{note}</Text>
                  </View>
                </Pressable>
              );
            })}
          </View>
        ) : null}
      </ScrollView>
      {read.state === 'done' ? (
        <View style={[styles.footer, { paddingBottom: insets.bottom + 12 }]} onLayout={onFooterLayout}>
          <Pill
            label={chosen.length ? `Add ${chosen.length} ${chosen.length === 1 ? 'item' : 'items'} to ${list.name}` : 'Nothing ticked'}
            icon="plus"
            variant="orange"
            disabled={!chosen.length}
            onPress={add}
          />
        </View>
      ) : null}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.paper },
  content: { paddingHorizontal: 16, gap: 12 },
  flex: { flex: 1, gap: 2 },
  alignStart: { alignSelf: 'flex-start' },
  card: { backgroundColor: colors.card, borderRadius: radius.lg, padding: 16, gap: 10, ...shadow.card },
  label: { fontFamily: fonts.semibold, fontSize: 15, color: colors.ink },
  title: { fontFamily: fonts.display, fontSize: 22, lineHeight: 28, color: colors.ink },
  small: { flexShrink: 1, fontFamily: fonts.body, fontSize: 14, lineHeight: 19, color: colors.muted },
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
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  item: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  itemName: { fontFamily: fonts.medium, fontSize: 16, color: colors.ink },
  off: { color: colors.muted },
  tick: {
    width: 24,
    height: 24,
    borderRadius: 7,
    borderWidth: 1.5,
    // 3:1 against the card, so an empty box can be seen.
    borderColor: colors.faint,
    backgroundColor: colors.card,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tickOn: { backgroundColor: colors.orange, borderColor: colors.orange },
  note: { fontFamily: fonts.body, fontSize: 13, lineHeight: 18, color: colors.muted },
  footer: { position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 20, paddingTop: 12, backgroundColor: 'rgba(246,244,240,0.96)' },
});
