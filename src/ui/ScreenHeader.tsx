import { router } from 'expo-router';
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { IconButton } from './controls';
import { colors, fonts } from './theme';

/** Back chevron, a serif title and an optional action, on the screen's own background. */
export function ScreenHeader({ title, subtitle, right }: { title?: string; subtitle?: string; right?: React.ReactNode }) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.header, { paddingTop: insets.top + 4 }]}>
      <View style={styles.row}>
        <IconButton name="back" label="Back" onPress={goBack} />
        <View style={styles.right}>{right}</View>
      </View>
      {/* The header stays put while the screen scrolls, so at the largest text sizes it grows less than the rest. */}
      {title ? (
        <Text style={styles.title} accessibilityRole="header" maxFontSizeMultiplier={1.6}>
          {title}
        </Text>
      ) : null}
      {subtitle ? (
        <Text style={styles.subtitle} maxFontSizeMultiplier={2}>
          {subtitle}
        </Text>
      ) : null}
    </View>
  );
}

export function goBack() {
  if (router.canGoBack()) router.back();
  else router.replace('/');
}

const styles = StyleSheet.create({
  header: { paddingHorizontal: 12, paddingBottom: 10 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  right: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  title: { fontFamily: fonts.display, fontSize: 30, color: colors.ink, paddingHorizontal: 8, marginTop: 4 },
  subtitle: { fontFamily: fonts.body, fontSize: 15, color: colors.muted, paddingHorizontal: 8, marginTop: 2 },
});
