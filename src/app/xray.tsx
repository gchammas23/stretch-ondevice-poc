import { useLocalSearchParams } from 'expo-router';
import React from 'react';
import { Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { excerpt } from '../onDevice/evidence';
import { readerWords } from '../onDevice/profiles';
import { howWords } from '../onDevice/retailerSearch';
import { bytesText } from '../onDevice/scrapeFeed';
import { hostOf, sourceWords } from '../pricing/receipt';
import { useApp, useRetailer } from '../state/AppProvider';
import { hiddenFromScreenReaders } from '../ui/a11y';
import { deviceWord } from '../ui/device';
import { Icon } from '../ui/Icon';
import { ScreenHeader } from '../ui/ScreenHeader';
import { colors, fonts, money, radius, shadow } from '../ui/theme';

const MONO = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' });

/**
 * The price X-ray: the data the store's server sent the phone for a product, with the price highlighted, and how
 * the phone asked for it. For prices read since the app opened; nothing of it is saved.
 */
export default function XrayScreen() {
  const { retailerId, productId } = useLocalSearchParams<{ retailerId: string; productId: string }>();
  const insets = useSafeAreaInsets();
  const { search } = useApp();
  const retailer = useRetailer(retailerId);
  const name = retailer?.name ?? retailerId ?? 'the store';
  const e = retailerId && productId ? search.evidence(retailerId, productId) : undefined;

  if (!e) {
    return (
      <View style={styles.screen}>
        <ScreenHeader title="Price X-ray" subtitle={`The data behind a price, as ${name} sent it.`} />
        <View style={[styles.card, styles.margin]}>
          <Text style={styles.body}>
            This price was read before the app last opened, or kept from earlier, and the data behind it isn’t kept. Check the prices again, then
            open the X-ray: it shows what the store sent this {deviceWord}, as it arrived.
          </Text>
        </View>
      </View>
    );
  }

  const { lines, highlight, first } = excerpt(e);
  const path = e.pricePath.split('.');
  const host = e.request ? hostOf(e.request.url) : hostOf(retailer?.searchUrl ?? '');
  const when = new Date(e.at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' });

  return (
    <View style={styles.screen}>
      <ScreenHeader title="Price X-ray" subtitle={`What ${name}’s server sent this ${deviceWord}, and where the price was in it.`} />
      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 32 }]}>
        <View style={styles.card}>
          <Text style={styles.price}>{e.price !== null ? money(e.price) : 'No price'}</Text>
          <Text style={styles.body}>
            Read at {when} by this {deviceWord}, from {host}, in {(e.ms / 1000).toFixed(1)} s{e.bytes ? `, about ${bytesText(e.bytes)} of data` : ''}.
          </Text>
          <Text style={styles.small}>
            How: {howWords(e.strategy, e.via)}
            {e.source ? `. The products were in ${sourceWords(e.source)}.` : '.'}
            {e.reader ? ` ${readerWords(e.reader, name)}` : ''}
          </Text>
        </View>

        {e.request ? (
          <View style={styles.card}>
            <Text style={styles.title} accessibilityRole="header">
              The request
            </Text>
            <Text style={styles.mono} selectable>
              {e.request.method} {e.request.url}
            </Text>
            <Text style={styles.small}>Anything in it that could identify this {deviceWord} or an account shows as “…”.</Text>
          </View>
        ) : null}

        <View style={styles.card}>
          <Text style={styles.title} accessibilityRole="header">
            Where the price was
          </Text>
          <View style={styles.path} accessible accessibilityLabel={`Path: ${path.join(', then ')}, equals ${e.price !== null ? e.price : 'nothing'}`}>
            {path.map((key, i) => (
              <View key={`${key}-${i}`} style={styles.pathPart}>
                {i ? <Icon name="forward" size={12} color={colors.faint} /> : null}
                <Text style={styles.pathKey}>{key}</Text>
              </View>
            ))}
            <Text style={styles.pathValue}>= {e.price !== null ? e.price : '?'}</Text>
          </View>
          <View
            style={styles.code}
            accessible
            accessibilityLabel={`The product’s data, ${lines.length} lines.${highlight >= 0 ? ` The price is on line ${first + highlight + 1}: ${lines[highlight].trim()}` : ''}`}
          >
            <View {...hiddenFromScreenReaders}>
              {first > 0 ? <Text style={styles.codeLine}>…</Text> : null}
              {lines.map((line, i) => (
                <View key={i} style={[styles.codeRow, i === highlight && styles.codeRowOn]}>
                  <Text style={styles.lineNo}>{first + i + 1}</Text>
                  <Text style={[styles.codeLine, i === highlight && styles.codeLineOn]}>{line}</Text>
                </View>
              ))}
            </View>
          </View>
        </View>

        <Text style={styles.note}>
          On this {deviceWord} only, until the app closes: X-rays aren’t saved or sent anywhere.
        </Text>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.paper },
  content: { paddingHorizontal: 16, gap: 12 },
  margin: { marginHorizontal: 16 },
  card: { backgroundColor: colors.card, borderRadius: radius.lg, padding: 16, gap: 8, ...shadow.card },
  title: { fontFamily: fonts.semibold, fontSize: 16, color: colors.ink },
  price: { fontFamily: fonts.display, fontSize: 32, color: colors.ink },
  body: { fontFamily: fonts.body, fontSize: 15, lineHeight: 21, color: colors.ink },
  small: { fontFamily: fonts.body, fontSize: 13, lineHeight: 18, color: colors.muted },
  note: { fontFamily: fonts.body, fontSize: 13, lineHeight: 18, color: colors.muted, textAlign: 'center' },
  mono: { fontFamily: MONO, fontSize: 12, lineHeight: 17, color: colors.ink },
  path: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 4 },
  pathPart: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  pathKey: { fontFamily: MONO, fontSize: 13, color: colors.ink, backgroundColor: colors.chip, borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2 },
  pathValue: { fontFamily: MONO, fontSize: 13, color: colors.orangeText, marginLeft: 4 },
  code: { backgroundColor: '#FAF7F2', borderRadius: radius.md, paddingVertical: 8, borderWidth: 1, borderColor: colors.line },
  codeRow: { flexDirection: 'row', gap: 8, paddingHorizontal: 8 },
  codeRowOn: { backgroundColor: '#FFE3D8' },
  lineNo: { width: 28, textAlign: 'right', fontFamily: MONO, fontSize: 11, lineHeight: 17, color: colors.faint },
  codeLine: { flex: 1, fontFamily: MONO, fontSize: 11, lineHeight: 17, color: colors.ink },
  codeLineOn: { color: colors.orangeText, fontWeight: '700' },
});
