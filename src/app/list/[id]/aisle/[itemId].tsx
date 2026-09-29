import { useLocalSearchParams } from 'expo-router';
import React, { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { ListItem } from '../../../../lists/types';
import type { Place } from '../../../../onDevice/aisle';
import type { Product } from '../../../../onDevice/types';
import { AREAS, noteFromText, placeLabel, spotFor, type Spot } from '../../../../pricing/aisles';
import { useAisles, useList, useSettings, useStoreChoices, useStoreName } from '../../../../state/AppProvider';
import { knownStore } from '../../../../state/storeInfo';
import { announce } from '../../../../ui/a11y';
import { Pill, tap } from '../../../../ui/controls';
import { goBack, ScreenHeader } from '../../../../ui/ScreenHeader';
import { colors, fonts, radius, shadow } from '../../../../ui/theme';

export default function AisleScreen() {
  const { id, itemId } = useLocalSearchParams<{ id: string; itemId: string }>();
  const list = useList(id);
  const item = list?.items.find((i) => i.id === itemId);
  const line = item ? list?.trip?.lines[item.id] : undefined;
  if (!list || !item || !line?.product || !line.retailerId) return <ScreenHeader title="Where was it?" subtitle="This item isn’t on a trip anymore." />;
  return <AisleView key={`${list.id}|${item.id}`} item={item} retailerId={line.retailerId} product={line.product} />;
}

/** What's known of where it is before the user notes it, in a sentence. */
function knownWords(spot: Spot, storeName: string, mine: boolean, itemName: string): string {
  const where = placeLabel(spot);
  if (spot.from === 'you') return mine ? `You noted ${where}.` : `You noted ${where} for another product you bought as “${itemName}”.`;
  const says = spot.from === 'page' ? `Its page on ${storeName}’s site says ${where}` : `${storeName}’s search results say ${where}`;
  return `${says}. If it was somewhere else, note where: your note comes first from now on.`;
}

/**
 * Where the user found an item in the store, noted while shopping: its aisle as the sign has it, or the area it's in.
 * Kept on the phone for that store, for the product and for the item, so the checklist shows it next time, before
 * what the store's site says.
 */
function AisleView({ item, retailerId, product }: { item: ListItem; retailerId: string; product: Product }) {
  const insets = useSafeAreaInsets();
  const aisles = useAisles();
  const settings = useSettings();
  const choices = useStoreChoices();
  const nameOf = useStoreName();
  const name = nameOf(retailerId);
  const storeData = !knownStore(retailerId, settings, choices.find((c) => c.config.id === retailerId)?.storeKey).conflict;
  const spot = spotFor(aisles, retailerId, product, item.name, storeData);
  const mine = aisles.yours(retailerId, product.storeId, product.id);
  const [text, setText] = useState(mine?.aisle ?? '');
  const typed = text.trim() ? noteFromText(text) : undefined;
  // The store's own area for it first, when it isn't one of the usual ones.
  const own = product.department && !AREAS.some((a) => a.toLowerCase() === product.department!.toLowerCase()) ? [product.department] : [];
  const areas = [...own, ...AREAS];

  const save = (place: Place) => {
    tap();
    aisles.noteYours(retailerId, product, item.name, place);
    announce(`Noted: ${placeLabel(place)}`);
    goBack();
  };
  const forget = () => {
    aisles.noteYours(retailerId, product, item.name, null);
    announce('Your note is gone');
    goBack();
  };

  return (
    <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScreenHeader title="Where was it?" subtitle={`${product.name}, at ${name}`} />
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 32 }]}>
        {spot ? <Text style={styles.body}>{knownWords(spot, name, !!mine, item.name)}</Text> : null}
        <View style={styles.card}>
          <Text style={styles.label}>Aisle</Text>
          <View style={styles.row}>
            <TextInput
              value={text}
              onChangeText={setText}
              onSubmitEditing={() => typed && save(typed)}
              placeholder="12, or A12"
              placeholderTextColor={colors.faint}
              autoCapitalize="characters"
              autoCorrect={false}
              returnKeyType="done"
              style={[styles.input, styles.flex]}
              accessibilityLabel="Aisle"
              accessibilityHint="As its sign has it"
            />
            <Pill label="Save" small disabled={!typed} onPress={() => typed && save(typed)} />
          </View>
          {text.trim() && !typed ? (
            <Text style={[styles.small, { color: colors.amber }]}>Couldn’t read that. Type the aisle as its sign has it: 12, or A12.</Text>
          ) : null}
        </View>
        <View style={styles.card}>
          <Text style={styles.label} accessibilityRole="header">
            Or the area it’s in
          </Text>
          <View style={styles.areas}>
            {areas.map((area) => (
              <Pill key={area} label={area} accessibilityLabel={`${area}, save`} small variant="outline" onPress={() => save({ department: area })} />
            ))}
          </View>
        </View>
        <Text style={styles.small}>Kept on this phone for this store. Next time you shop here, your list shows it before what {name}’s site says.</Text>
        {mine ? <Pill label="Forget my note" icon="trash" variant="outline" onPress={forget} style={styles.alignStart} /> : null}
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
  label: { fontFamily: fonts.semibold, fontSize: 15, color: colors.ink },
  body: { fontFamily: fonts.body, fontSize: 15, lineHeight: 21, color: colors.ink },
  small: { fontFamily: fonts.body, fontSize: 14, lineHeight: 19, color: colors.muted },
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
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  areas: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
});
