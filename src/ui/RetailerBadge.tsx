import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { colors, fonts } from './theme';

// Colored monograms rather than the retailers' logos, which are their trademarks.
const BRANDS: Record<string, { bg: string; fg: string; mark: string }> = {
  walmart: { bg: '#0071DC', fg: '#FFC220', mark: 'W' },
  target: { bg: '#CC0000', fg: '#FFFFFF', mark: 'T' },
  kroger: { bg: '#1F4E9D', fg: '#FFFFFF', mark: 'K' },
  costco: { bg: '#E31837', fg: '#FFFFFF', mark: 'C' },
  traderjoes: { bg: '#B31F24', fg: '#FFFFFF', mark: 'TJ' },
  heb: { bg: '#E42313', fg: '#FFFFFF', mark: 'H' },
  publix: { bg: '#3F8F3F', fg: '#FFFFFF', mark: 'P' },
  aldi: { bg: '#00205B', fg: '#F7A600', mark: 'A' },
  wholefoods: { bg: '#00674B', fg: '#FFFFFF', mark: 'WF' },
  safeway: { bg: '#E1261C', fg: '#FFFFFF', mark: 'S' },
  meijer: { bg: '#0060A9', fg: '#FFFFFF', mark: 'M' },
  wegmans: { bg: '#4B7F52', fg: '#FFFFFF', mark: 'W' },
  sprouts: { bg: '#5D9732', fg: '#FFFFFF', mark: 'S' },
  // Chains on Kroger's and Albertsons' platforms.
  ralphs: { bg: '#D71920', fg: '#FFFFFF', mark: 'R' },
  fredmeyer: { bg: '#0053A0', fg: '#FFFFFF', mark: 'FM' },
  kingsoopers: { bg: '#C8102E', fg: '#FFFFFF', mark: 'KS' },
  frys: { bg: '#E21A2C', fg: '#FFFFFF', mark: 'F' },
  smiths: { bg: '#B5121B', fg: '#FFFFFF', mark: 'Sm' },
  qfc: { bg: '#00843D', fg: '#FFFFFF', mark: 'Q' },
  dillons: { bg: '#D52B1E', fg: '#FFFFFF', mark: 'D' },
  marianos: { bg: '#1B365D', fg: '#FFFFFF', mark: 'Ma' },
  picknsave: { bg: '#E4002B', fg: '#FFFFFF', mark: 'PS' },
  food4less: { bg: '#F2A900', fg: '#1F1F1F', mark: '4L' },
  albertsons: { bg: '#00529F', fg: '#FFFFFF', mark: 'Al' },
  vons: { bg: '#E31837', fg: '#FFFFFF', mark: 'V' },
  jewelosco: { bg: '#D6001C', fg: '#FFFFFF', mark: 'J' },
  acme: { bg: '#E4002B', fg: '#FFFFFF', mark: 'Ac' },
  shaws: { bg: '#004B8D', fg: '#FFFFFF', mark: 'Sh' },
  starmarket: { bg: '#00539B', fg: '#FFFFFF', mark: 'SM' },
  randalls: { bg: '#A6192E', fg: '#FFFFFF', mark: 'Ra' },
  tomthumb: { bg: '#CE1126', fg: '#FFFFFF', mark: 'TT' },
  pavilions: { bg: '#002D72', fg: '#FFFFFF', mark: 'Pv' },
};

/** Stores the user added get one of these, picked from their id, so each keeps its color. */
const ADDED = ['#6B4EA2', '#1B7F8C', '#B5532A', '#3F6E2A', '#A23E6B', '#2F5D9C', '#8A6D1F'];

function brandOf(retailerId: string, name: string) {
  const known = BRANDS[retailerId];
  if (known) return known;
  let hash = 0;
  for (const ch of retailerId) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const initials = name
    .split(/[\s-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w.charAt(0).toUpperCase())
    .join('');
  return { bg: retailerId.startsWith('custom-') ? ADDED[hash % ADDED.length] : colors.ink, fg: '#FFFFFF', mark: initials || '?' };
}

export const brandColor = (retailerId: string): string => BRANDS[retailerId]?.bg ?? brandOf(retailerId, retailerId).bg;

/**
 * A store's monogram. Screen readers skip it, since the store's name is almost always written next to it; pass
 * `labelled` where the badge is the only thing naming the store, and it's read as the store's name.
 */
export function RetailerBadge({ retailerId, name, size = 40, labelled }: { retailerId: string; name: string; size?: number; labelled?: boolean }) {
  const brand = brandOf(retailerId, name);
  const a11y = labelled
    ? ({ accessible: true, accessibilityRole: 'image', accessibilityLabel: name } as const)
    : ({ accessibilityElementsHidden: true, importantForAccessibility: 'no-hide-descendants' } as const);
  return (
    <View {...a11y} style={[styles.badge, { width: size, height: size, borderRadius: size * 0.26, backgroundColor: brand.bg }]}>
      {/* The mark fits its square: it doesn't grow with the text size. */}
      <Text allowFontScaling={false} style={[styles.mark, { color: brand.fg, fontSize: size * (brand.mark.length > 1 ? 0.36 : 0.46) }]}>
        {brand.mark}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: { alignItems: 'center', justifyContent: 'center' },
  mark: { fontFamily: fonts.bold, includeFontPadding: false },
});
