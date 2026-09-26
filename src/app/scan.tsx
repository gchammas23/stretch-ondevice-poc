import { CameraView, useCameraPermissions } from 'expo-camera';
import { router } from 'expo-router';
import React, { useRef, useState } from 'react';
import { KeyboardAvoidingView, Linking, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { normalizeBarcode } from '../onDevice/barcode';
import { IconButton, Pill, tap } from '../ui/controls';
import { Icon } from '../ui/Icon';
import { goBack } from '../ui/ScreenHeader';
import { colors, fonts, radius } from '../ui/theme';

const lookUp = (code: string) => {
  tap();
  router.replace({ pathname: '/search', params: { code } });
};

/**
 * Scan a product's barcode, then see what every store charges for it (the Price check screen). The barcode can also
 * be typed: for a blurry label, dim light, no camera, or anyone who can't frame it.
 */
export default function ScanScreen() {
  const insets = useSafeAreaInsets();
  const [permission, requestPermission] = useCameraPermissions();
  // One scan per visit: the camera keeps reporting the same code while it's in view.
  const scanned = useRef(false);
  const [typing, setTyping] = useState(false);

  if (typing) return <TypeBarcode onCancel={() => setTyping(false)} />;
  if (!permission) return <View style={styles.dark} />;

  if (!permission.granted) {
    return (
      <View style={[styles.ask, { paddingTop: insets.top + 12 }]}>
        <IconButton name="back" label="Back" onPress={goBack} />
        <View style={styles.askBody}>
          <Icon name="scan" size={44} color={colors.orange} />
          <Text style={styles.askTitle} accessibilityRole="header">
            Scan a barcode
          </Text>
          <Text style={styles.askText}>
            Point the camera at a product’s barcode and Stretch looks it up at every store you compare, by the barcode itself.
          </Text>
          {permission.canAskAgain ? (
            <Pill label="Allow the camera" variant="orange" onPress={() => void requestPermission()} />
          ) : (
            <Pill label="Open Settings" variant="orange" onPress={() => void Linking.openSettings()} />
          )}
          <Pressable accessibilityRole="button" hitSlop={{ top: 12, bottom: 12, left: 8, right: 8 }} onPress={() => setTyping(true)}>
            <Text style={styles.typeLink}>Type the barcode instead</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.dark}>
      <CameraView
        style={StyleSheet.absoluteFill}
        facing="back"
        barcodeScannerSettings={{ barcodeTypes: ['ean13', 'ean8', 'upc_a', 'upc_e'] }}
        onBarcodeScanned={({ data }) => {
          const code = normalizeBarcode(data);
          if (!code || scanned.current) return;
          scanned.current = true;
          lookUp(code);
        }}
      />
      <View style={[styles.top, { paddingTop: insets.top + 8 }]} pointerEvents="box-none">
        <IconButton name="close" label="Close the scanner" color="#ffffff" onPress={goBack} />
      </View>
      <View style={styles.frame} pointerEvents="none" accessibilityElementsHidden />
      <View style={[styles.bottom, { bottom: insets.bottom + 28 }]} pointerEvents="box-none">
        <Text style={styles.tip}>Point at a product’s barcode</Text>
        <Pill label="Type the barcode" icon="edit" variant="light" small onPress={() => setTyping(true)} />
      </View>
    </View>
  );
}

/** The barcode's digits, typed. */
function TypeBarcode({ onCancel }: { onCancel: () => void }) {
  const insets = useSafeAreaInsets();
  const [digits, setDigits] = useState('');
  const code = normalizeBarcode(digits);
  const check = () => code && lookUp(code);
  return (
    <KeyboardAvoidingView style={[styles.ask, { paddingTop: insets.top + 12 }]} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <IconButton name="back" label="Back" onPress={onCancel} />
      <View style={styles.typeBody}>
        <Text style={styles.askTitle} accessibilityRole="header">
          Type the barcode
        </Text>
        <Text style={styles.askText}>The numbers under the lines: 12 digits on most U.S. products, 13 or 8 on others.</Text>
        <TextInput
          value={digits}
          onChangeText={(t) => setDigits(t.replace(/\D/g, ''))}
          onSubmitEditing={check}
          keyboardType="number-pad"
          returnKeyType="search"
          maxLength={14}
          autoFocus
          placeholder="016000275287"
          placeholderTextColor={colors.faint}
          style={styles.codeInput}
          accessibilityLabel="Barcode number"
          accessibilityHint="The digits under the barcode's lines"
        />
        {digits.length >= 8 && !code ? (
          <Text style={[styles.askText, { color: colors.amber }]}>That isn’t a barcode’s length: check the digits.</Text>
        ) : null}
        <Pill label="Check its price" icon="search" variant="orange" disabled={!code} onPress={() => check()} />
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  dark: { flex: 1, backgroundColor: '#000000' },
  top: { position: 'absolute', top: 0, left: 12, right: 12 },
  frame: {
    position: 'absolute',
    left: '12%',
    right: '12%',
    top: '38%',
    height: 150,
    borderRadius: radius.lg,
    borderWidth: 3,
    borderColor: colors.orange,
  },
  bottom: { position: 'absolute', left: 24, right: 24, alignItems: 'center', gap: 14 },
  tip: { textAlign: 'center', fontFamily: fonts.semibold, fontSize: 17, color: '#ffffff' },
  ask: { flex: 1, backgroundColor: colors.cream, paddingHorizontal: 12 },
  askBody: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 14, paddingHorizontal: 24, paddingBottom: 80 },
  askTitle: { fontFamily: fonts.display, fontSize: 28, color: colors.ink },
  askText: { fontFamily: fonts.body, fontSize: 16, lineHeight: 23, color: colors.muted, textAlign: 'center' },
  typeLink: { fontFamily: fonts.semibold, fontSize: 16, color: colors.orangeText },
  typeBody: { gap: 14, paddingHorizontal: 12, paddingTop: 24, alignItems: 'center' },
  codeInput: {
    alignSelf: 'stretch',
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.md,
    backgroundColor: colors.card,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontFamily: fonts.semibold,
    fontSize: 22,
    letterSpacing: 2,
    textAlign: 'center',
    color: colors.ink,
  },
});
