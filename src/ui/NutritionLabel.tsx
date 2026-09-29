import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { amountText, amountWords, NUTRIENTS, type NutrientInfo, type Nutrition } from '../onDevice/nutrition';
import { fonts } from './theme';

// Black on white, as on the package, whatever the app's colors.
const INK = '#000000';
const PAPER = '#FFFFFF';

/** A product's Nutrition Facts, laid out like the FDA's label: only the lines the source gave. */
export function NutritionLabel({ nutrition }: { nutrition: Nutrition }) {
  const lines = NUTRIENTS.filter((n) => nutrition.nutrients[n.key]);
  const main = lines.filter((n) => !n.mineral);
  const minerals = lines.filter((n) => n.mineral);
  const per = nutrition.per100 ? `per 100 ${nutrition.per100}` : 'per serving';
  const showDv = lines.some((n) => nutrition.nutrients[n.key]?.dv !== undefined);

  return (
    <View style={styles.label}>
      <Text style={styles.title} accessibilityRole="header">
        Nutrition Facts
      </Text>
      {nutrition.servingsPerContainer ? <Text style={styles.text}>{nutrition.servingsPerContainer} servings per container</Text> : null}
      {nutrition.servingSize ? (
        <View style={styles.row} accessible accessibilityLabel={`Serving size, ${nutrition.servingSize}`}>
          <Text style={styles.strong}>{nutrition.per100 ? 'Amounts' : 'Serving size'}</Text>
          <Text style={[styles.strong, styles.right]}>{nutrition.per100 ? per : nutrition.servingSize}</Text>
        </View>
      ) : null}
      <View style={styles.thick} />
      {nutrition.calories !== undefined ? (
        <>
          <View style={styles.caloriesRow} accessible accessibilityLabel={`Calories ${per}, ${nutrition.calories}`}>
            <View>
              <Text style={styles.small}>Amount {per}</Text>
              <Text style={styles.calories}>Calories</Text>
            </View>
            <Text style={styles.caloriesValue}>{nutrition.calories}</Text>
          </View>
          <View style={styles.medium} />
        </>
      ) : null}
      {showDv ? <Text style={[styles.small, styles.right, styles.dvHead]}>% Daily Value*</Text> : null}
      {main.map((n) => (
        <Line key={n.key} info={n} nutrition={nutrition} />
      ))}
      {minerals.length ? <View style={styles.thick} /> : null}
      {minerals.map((n) => (
        <Line key={n.key} info={n} nutrition={nutrition} />
      ))}
      {showDv ? (
        <>
          <View style={styles.medium} />
          <Text style={styles.footnote}>
            * The % Daily Value (DV) tells you how much a nutrient in a serving of food contributes to a daily diet. 2,000 calories a day is used for general
            nutrition advice.
          </Text>
        </>
      ) : null}
    </View>
  );
}

function Line({ info, nutrition }: { info: NutrientInfo; nutrition: Nutrition }) {
  const a = nutrition.nutrients[info.key]!;
  const amount = amountText(a);
  const dv = a.dv !== undefined ? `${a.dv}%` : '';
  const spoken = `${info.key === 'addedSugars' ? 'Includes added sugars' : info.label}, ${amountWords(a)}${a.dv !== undefined ? `, ${a.dv} percent daily value` : ''}`;
  return (
    <View style={[styles.row, styles.rule, info.indent && styles.indent]} accessible accessibilityLabel={spoken}>
      <Text style={[styles.text, styles.flex]}>
        {info.key === 'addedSugars' ? (
          <>Includes {amount} Added Sugars</>
        ) : (
          <>
            <Text style={info.indent || info.mineral ? undefined : styles.strong}>{info.label}</Text> {amount}
          </>
        )}
      </Text>
      <Text style={info.mineral ? styles.text : styles.strong}>{dv}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  label: { borderWidth: 1, borderColor: INK, backgroundColor: PAPER, paddingHorizontal: 8, paddingTop: 4, paddingBottom: 8 },
  title: { fontFamily: fonts.bold, fontSize: 30, lineHeight: 36, color: INK, letterSpacing: -0.6 },
  text: { fontFamily: fonts.body, fontSize: 15, lineHeight: 21, color: INK },
  strong: { fontFamily: fonts.bold, fontSize: 15, lineHeight: 21, color: INK },
  small: { fontFamily: fonts.bold, fontSize: 13, lineHeight: 18, color: INK },
  flex: { flex: 1 },
  right: { textAlign: 'right' },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', gap: 8, paddingVertical: 2 },
  rule: { borderTopWidth: 1, borderTopColor: INK },
  indent: { marginLeft: 16 },
  thick: { height: 10, backgroundColor: INK, marginVertical: 4 },
  medium: { height: 5, backgroundColor: INK, marginVertical: 2 },
  caloriesRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end' },
  calories: { fontFamily: fonts.bold, fontSize: 26, lineHeight: 32, color: INK },
  caloriesValue: { fontFamily: fonts.bold, fontSize: 34, lineHeight: 40, color: INK },
  dvHead: { paddingVertical: 2 },
  footnote: { fontFamily: fonts.body, fontSize: 12, lineHeight: 16, color: INK, marginTop: 2 },
});
