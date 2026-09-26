import * as Haptics from 'expo-haptics';
import React from 'react';
import { ActivityIndicator, Image, Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';
import type { Product } from '../onDevice/types';
import { Icon, type IconName } from './Icon';
import { colors, fonts, radius } from './theme';

export const tap = () => void Haptics.selectionAsync().catch(() => {});

type Variant = 'orange' | 'dark' | 'light' | 'outline';

const VARIANTS: Record<Variant, { bg: string; fg: string; border?: string }> = {
  orange: { bg: colors.orangeButton, fg: '#ffffff' },
  dark: { bg: colors.pill, fg: '#ffffff' },
  light: { bg: colors.card, fg: colors.ink },
  outline: { bg: 'transparent', fg: colors.ink, border: colors.line },
};

/**
 * The rounded buttons: Find a store (orange), Shop here (dark). A Pill that turns something on or off is a switch:
 * pass `checked`, and a label that names the setting rather than its state.
 */
export function Pill({
  label,
  onPress,
  variant = 'dark',
  icon,
  disabled,
  busy,
  small,
  style,
  checked,
  accessibilityLabel,
  accessibilityHint,
}: {
  label: string;
  onPress: () => void;
  variant?: Variant;
  icon?: IconName;
  disabled?: boolean;
  busy?: boolean;
  small?: boolean;
  style?: StyleProp<ViewStyle>;
  checked?: boolean;
  /** What a screen reader says instead of `label`: start it with the label's words, for Voice Control. */
  accessibilityLabel?: string;
  accessibilityHint?: string;
}) {
  const v = VARIANTS[variant];
  return (
    <Pressable
      accessibilityRole={checked === undefined ? 'button' : 'switch'}
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: !!disabled, busy: !!busy, ...(checked === undefined ? {} : { checked }) }}
      disabled={disabled || busy}
      onPress={onPress}
      style={({ pressed }) => [
        styles.pill,
        small && styles.pillSmall,
        { backgroundColor: v.bg, borderColor: v.border ?? v.bg },
        pressed && styles.pressed,
        disabled && styles.disabled,
        style,
      ]}
    >
      {busy ? <ActivityIndicator color={v.fg} size="small" /> : icon ? <Icon name={icon} size={small ? 16 : 19} color={v.fg} /> : null}
      <Text style={[styles.pillText, small && styles.pillTextSmall, { color: v.fg }]}>{label}</Text>
    </Pressable>
  );
}

/** A plain round icon button, for headers. */
export function IconButton({
  name,
  label,
  onPress,
  color = colors.ink,
  style,
}: {
  name: IconName;
  label: string;
  onPress: () => void;
  color?: string;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={10}
      onPress={onPress}
      style={({ pressed }) => [styles.iconButton, pressed && styles.pressed, style]}
    >
      <Icon name={name} color={color} />
    </Pressable>
  );
}

export function Checkbox({ checked, onPress, label }: { checked: boolean; onPress: () => void; label: string }) {
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityLabel={label}
      accessibilityState={{ checked }}
      hitSlop={10}
      onPress={() => {
        tap();
        onPress();
      }}
      style={[styles.checkbox, checked && styles.checkboxOn]}
    >
      {checked ? <Icon name="check" size={16} color="#ffffff" strokeWidth={3} /> : null}
    </Pressable>
  );
}

/**
 * − 5 +, with a trash can instead of − at 1. For a screen reader it's one control: swipe up or down to change the
 * quantity, and Remove is an action, so a swipe down can't take the item off by accident.
 */
export function QtyStepper({
  qty,
  onChange,
  onRemove,
  itemName,
}: {
  qty: number;
  onChange: (qty: number) => void;
  onRemove: () => void;
  itemName: string;
}) {
  return (
    <View
      style={styles.stepper}
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel={`Quantity of ${itemName}`}
      accessibilityValue={{ text: String(qty) }}
      accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }, { name: 'remove', label: `Remove ${itemName}` }]}
      onAccessibilityAction={(e) => {
        const action = e.nativeEvent.actionName;
        if (action === 'increment') onChange(qty + 1);
        else if (action === 'decrement' && qty > 1) onChange(qty - 1);
        else if (action === 'remove') onRemove();
      }}
    >
      <Pressable
        importantForAccessibility="no-hide-descendants"
        hitSlop={6}
        onPress={() => {
          tap();
          if (qty <= 1) onRemove();
          else onChange(qty - 1);
        }}
        style={styles.stepperButton}
      >
        <Icon name={qty <= 1 ? 'trash' : 'minus'} size={17} color={colors.muted} />
      </Pressable>
      <Text style={styles.stepperQty} maxFontSizeMultiplier={1.5}>
        {qty}
      </Text>
      <Pressable
        importantForAccessibility="no-hide-descendants"
        hitSlop={6}
        onPress={() => {
          tap();
          onChange(qty + 1);
        }}
        style={styles.stepperButton}
      >
        <Icon name="plus" size={17} color={colors.ink} />
      </Pressable>
    </View>
  );
}

/** How many items are checked off, as a ring. */
export function ProgressRing({ value, size = 20 }: { value: number; size?: number }) {
  const stroke = 3;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const clamped = Math.max(0, Math.min(1, value));
  return (
    <Svg width={size} height={size}>
      <Circle cx={size / 2} cy={size / 2} r={r} stroke="rgba(249, 90, 55, 0.22)" strokeWidth={stroke} fill="none" />
      {clamped > 0 ? (
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke={colors.orange}
          strokeWidth={stroke}
          fill="none"
          strokeLinecap="round"
          strokeDasharray={`${c * clamped} ${c}`}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      ) : null}
    </Svg>
  );
}

/** The torn-paper bottom edge of the list header. */
export function ZigzagEdge({ color = colors.blush }: { color?: string }) {
  const teeth = 32;
  const w = 400 / teeth;
  let d = 'M0 0';
  for (let i = 0; i < teeth; i++) d += ` L${(i + 0.5) * w} ${i % 2 ? 7 : 9} L${(i + 1) * w} 0`;
  d += ' Z';
  return (
    <Svg width="100%" height={9} viewBox="0 0 400 9" preserveAspectRatio="none" style={styles.zigzag}>
      <Path d={d} fill={color} />
    </Svg>
  );
}

/** A product photo on white, or a placeholder. */
export function ProductThumb({ product, size = 56 }: { product: Product | null; size?: number }) {
  return (
    <View style={[styles.thumb, { width: size, height: size }]}>
      {product?.imageUrl ? (
        <Image source={{ uri: product.imageUrl }} style={styles.thumbImage} resizeMode="contain" accessibilityIgnoresInvertColors />
      ) : (
        <Icon name="cart" size={size * 0.42} color={colors.faint} strokeWidth={1.6} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderRadius: radius.pill,
    borderWidth: 1,
    paddingVertical: 14,
    paddingHorizontal: 22,
    minHeight: 50,
  },
  pillSmall: { paddingVertical: 10, paddingHorizontal: 14, minHeight: 44, gap: 6 },
  pillText: { fontFamily: fonts.semibold, fontSize: 16 },
  pillTextSmall: { fontSize: 14 },
  pressed: { opacity: 0.75 },
  disabled: { opacity: 0.45 },
  iconButton: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  checkbox: {
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
  checkboxOn: { backgroundColor: colors.orange, borderColor: colors.orange },
  stepper: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.chip,
    borderRadius: radius.md,
    minHeight: 38,
  },
  stepperButton: { width: 36, minHeight: 38, alignSelf: 'stretch', alignItems: 'center', justifyContent: 'center' },
  stepperQty: { minWidth: 18, textAlign: 'center', fontFamily: fonts.semibold, fontSize: 16, color: colors.ink },
  zigzag: { marginTop: -1 },
  thumb: {
    borderRadius: radius.md,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.line,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  thumbImage: { width: '86%', height: '86%' },
});
