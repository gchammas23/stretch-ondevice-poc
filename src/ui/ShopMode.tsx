import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { OnlinePlan, OnlineRules } from '../onDevice/types';
import type { FeeRead } from '../pricing/feeBook';
import {
  dollars,
  feesHost,
  MODE_NAMES,
  partLabel,
  planPrice,
  SHOP_MODES,
  sourceWords,
  waivedWords,
  type CostPart,
  type OnlineCost,
  type ShopMode,
} from '../pricing/onlineCost';
import { Pill, tap } from './controls';
import { Icon, type IconName } from './Icon';
import { colors, fonts, money, radius } from './theme';

export const MODE_ICONS: Record<ShopMode, IconName> = { store: 'store', pickup: 'bag', delivery: 'truck' };

/** In store, Pickup or Delivery: how the user shops, which decides what counts in each store's total. */
export function ShopModeChooser({ value, onChange }: { value: ShopMode; onChange: (mode: ShopMode) => void }) {
  return (
    <View style={styles.segmented} accessibilityRole="radiogroup" accessibilityLabel="How you shop">
      {SHOP_MODES.map((mode) => {
        const on = mode === value;
        return (
          <Pressable
            key={mode}
            accessibilityRole="radio"
            accessibilityState={{ checked: on }}
            accessibilityLabel={MODE_NAMES[mode]}
            hitSlop={{ top: 8, bottom: 8 }}
            onPress={() => {
              if (on) return;
              tap();
              onChange(mode);
            }}
            style={[styles.segment, on && styles.segmentOn]}
          >
            <Icon name={MODE_ICONS[mode]} size={15} color={on ? colors.ink : colors.muted} />
            <Text style={[styles.segmentText, on && styles.segmentTextOn]}>{MODE_NAMES[mode]}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** What a part's figure is, beside its name: why it's free, its range, and whether it's read or estimated. */
function partNote(part: CostPart, host: string | undefined): string {
  const bits: string[] = [];
  if (part.waived) bits.push(waivedWords(part.waived));
  else if (part.upTo !== undefined) bits.push(`up to ${money(part.upTo)} in other time slots`);
  bits.push(part.from === 'page' ? `from ${host ? `${host}’s` : 'its'} page` : 'estimate');
  return bits.join(' · ');
}

/** The sentence on the store's page a part's figure was read from, when it was: the fee's receipt. */
function quoteOf(part: CostPart, way: string, read: FeeRead | undefined): string | undefined {
  if (part.from !== 'page') return undefined;
  const key =
    part.kind === 'markup' ? 'markup' : part.kind === 'small' ? `${way}.smallFee` : part.kind === 'service' ? `${way}.service` : part.waived?.over !== undefined ? `${way}.freeOver` : `${way}.fee`;
  const quote = read?.fees?.quotes[key];
  return quote ? (quote.length > 160 ? `${quote.slice(0, 157)}…` : quote) : undefined;
}

/**
 * A basket ordered online: the items, what the store adds (online prices, fees), the total, and where each figure
 * came from. Also what would make it cheaper: a threshold within reach, or a plan the user doesn't have.
 */
export function OnlineBreakdown({
  cost,
  name,
  rules,
  read,
  reading,
  offers,
  now,
  onReadAgain,
}: {
  cost: OnlineCost;
  name: string;
  rules?: OnlineRules;
  read?: FeeRead;
  reading: boolean;
  /** Plans the user doesn't have that would take something off this order. */
  offers: { plan: OnlinePlan; saves: number }[];
  now: number;
  onReadAgain?: () => void;
}) {
  const way = cost.way === 'delivery' ? 'delivery' : 'pickup';
  if (!cost.available || !cost.known) {
    return (
      <View style={styles.card}>
        <View style={styles.head}>
          <Icon name={MODE_ICONS[cost.way]} size={18} color={colors.muted} />
          <Text style={[styles.body, styles.flex]}>
            {!cost.known
              ? `${name}’s online fees aren’t known, so this basket is counted at the prices read, without fees.`
              : `${name} doesn’t take ${way} orders${rules?.note ? ` (${rules.note})` : ''}, so it isn’t in the running for ${way}. This basket is at the prices read.`}
          </Text>
        </View>
      </View>
    );
  }
  const host = feesHost(rules);
  const markup = cost.parts.find((p) => p.kind === 'markup');
  const range = cost.parts.some((p) => p.upTo !== undefined);
  return (
    <View style={styles.card}>
      <View style={styles.head}>
        <Icon name={MODE_ICONS[cost.way]} size={18} color={colors.orange} />
        <Text style={styles.title} accessibilityRole="header">
          {cost.way === 'delivery' ? `Delivery from ${name}` : `Pickup at ${name}`}
        </Text>
        <Text style={styles.total} accessibilityLabel={`${money(cost.total)} in all`}>
          {money(cost.total)}
        </Text>
      </View>
      <Line label="Items, at the prices read" amount={money(cost.items)} />
      {cost.parts.map((p) => (
        <Line
          key={p.kind}
          label={partLabel(p, cost.way)}
          amount={p.amount ? `+ ${money(p.amount)}` : money(0)}
          note={partNote(p, host)}
          quote={quoteOf(p, cost.way, read)}
        />
      ))}
      <Text style={styles.small}>
        Before tip and tax{range ? ', in the cheapest time slot' : ''}
        {cost.plan ? `, with your ${cost.plan}` : ''}.{rules?.note ? ` ${rules.note.charAt(0).toUpperCase()}${rules.note.slice(1)}.` : ''}
      </Text>
      {rules?.markup?.ways.includes(cost.way) ? (
        <Text style={styles.small}>
          {rules.markup.included
            ? `These are ${name}’s online prices, as its site shows them (${name} says ${rules.markup.said}), so nothing is added for them.`
            : read?.fees?.markup
              ? `${host}’s page says: “${read.fees.markup.said}”`
              : `${name} says ${rules.markup.said}.`}
          {markup && markup.from !== 'page' && !rules.markup.stated ? ` It doesn’t say by how much: ${markup.pct}% is an estimate.` : ''}
        </Text>
      ) : null}
      {cost.minimum ? (
        <View style={styles.warnRow}>
          <Icon name="alert" size={16} color={colors.amber} />
          <Text style={[styles.small, styles.flex, { color: colors.amber }]}>
            Under {name}’s {dollars(cost.minimum.amount)} minimum order: add {money(cost.minimum.short)} more to order it.
          </Text>
        </View>
      ) : null}
      {cost.toFree ? (
        <Text style={[styles.small, { color: colors.green }]}>
          Add {money(cost.toFree.more)} more for free {way}
          {cost.toFree.plan ? ` with your ${cost.toFree.plan}` : ''}: {money(cost.toFree.saves)} less.
        </Text>
      ) : null}
      {offers.map((o) => (
        <Text key={o.plan.id} style={styles.small}>
          With {o.plan.name} ({planPrice(o.plan)}), this order would cost {money(o.saves)} less.
        </Text>
      ))}
      <Text style={styles.source}>{sourceWords(cost, { name, rules, read, reading, now })}</Text>
      {onReadAgain && host ? (
        <Pill
          label={reading ? 'Reading…' : `Read ${host}’s fees again`}
          accessibilityLabel={`Read ${host}’s fees page again`}
          icon="refresh"
          small
          variant="outline"
          busy={reading}
          onPress={onReadAgain}
          style={styles.alignStart}
        />
      ) : null}
    </View>
  );
}

function Line({ label, amount, note, quote }: { label: string; amount: string; note?: string; quote?: string }) {
  return (
    <View
      style={styles.line}
      accessible
      accessibilityLabel={`${label}, ${amount.replace('+ ', 'plus ')}${note ? `, ${note}` : ''}${quote ? `. The page says: ${quote}` : ''}`}
    >
      <View style={styles.flex}>
        <Text style={styles.lineLabel}>{label}</Text>
        {note ? <Text style={styles.small}>{note}</Text> : null}
        {quote ? <Text style={styles.quote}>“{quote}”</Text> : null}
      </View>
      <Text style={styles.lineAmount}>{amount}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  // Wraps with the largest text sizes rather than running off the screen.
  segmented: { flexDirection: 'row', flexWrap: 'wrap', maxWidth: '100%', backgroundColor: colors.chip, borderRadius: radius.lg, padding: 3, alignSelf: 'flex-start' },
  segment: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingVertical: 7, paddingHorizontal: 12, borderRadius: radius.pill },
  segmentOn: { backgroundColor: colors.card, shadowColor: '#3B2A1A', shadowOpacity: 0.08, shadowRadius: 8, shadowOffset: { width: 0, height: 2 }, elevation: 2 },
  segmentText: { fontFamily: fonts.medium, fontSize: 14, color: colors.muted },
  segmentTextOn: { color: colors.ink },
  card: { marginHorizontal: 16, marginBottom: 12, backgroundColor: colors.card, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.line, padding: 14, gap: 8 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  title: { flex: 1, fontFamily: fonts.semibold, fontSize: 16, color: colors.ink },
  total: { fontFamily: fonts.semibold, fontSize: 17, color: colors.ink },
  flex: { flex: 1, gap: 1 },
  body: { fontFamily: fonts.body, fontSize: 14, lineHeight: 20, color: colors.ink },
  small: { fontFamily: fonts.body, fontSize: 13, lineHeight: 18, color: colors.muted },
  source: { fontFamily: fonts.body, fontSize: 12, lineHeight: 17, color: colors.muted, marginTop: 2 },
  quote: { fontFamily: fonts.body, fontSize: 12, lineHeight: 17, color: colors.muted, fontStyle: 'italic' },
  line: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, paddingTop: 6, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  lineLabel: { fontFamily: fonts.medium, fontSize: 14, color: colors.ink },
  lineAmount: { fontFamily: fonts.semibold, fontSize: 14, color: colors.ink, fontVariant: ['tabular-nums'] },
  warnRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 6 },
  alignStart: { alignSelf: 'flex-start' },
});
