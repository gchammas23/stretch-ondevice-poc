import React, { useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import { useCloudRunner } from '../state/CloudProvider';
import { colors, fonts, radius } from './theme';

/**
 * What the user noticed, for a Phone vs. cloud PDF's Findings: a run's (`id`), or the report of every run's (none).
 * Kept on the phone with the runs as it's typed.
 */
export function FindingsBox({ id, label, placeholder }: { id?: string; label: string; placeholder: string }) {
  const runner = useCloudRunner();
  const [text, setText] = useState(() => runner.getNotes(id));
  return (
    <View style={styles.box}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        value={text}
        onChangeText={(next) => {
          setText(next);
          runner.setNotes(id, next);
        }}
        placeholder={placeholder}
        placeholderTextColor={colors.faint}
        multiline
        style={styles.input}
        accessibilityLabel={label}
        accessibilityHint="Goes at the top of the PDF, under Findings"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  box: { gap: 6 },
  label: { fontFamily: fonts.semibold, fontSize: 14, color: colors.ink },
  input: {
    minHeight: 72,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.md,
    padding: 12,
    fontFamily: fonts.body,
    fontSize: 15,
    lineHeight: 20,
    color: colors.ink,
    textAlignVertical: 'top',
  },
});
