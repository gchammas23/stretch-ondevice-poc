/**
 * Stretch's look, sampled from its App Store screenshots and stretchgroceries.com.
 * Headings there use Canela Deck (a commercial font); Fraunces stands in for it. Body text is Geist, as on the site.
 */
export const colors = {
  /** Screen background. */
  paper: '#F6F4F0',
  /** Warmer background for the home screen. */
  cream: '#FFFDF4',
  card: '#FFFFFF',
  /** The list header. */
  blush: '#FDDED6',
  /** Brand orange: accents, icons, progress. Too light for text: see orangeText and orangeButton. */
  orange: '#F95A37',
  /** Orange for text: 4.5:1 or more on the light backgrounds (WCAG AA). */
  orangeText: '#C2462A',
  /** Orange behind white text, such as Find a store: 4.5:1 with white. */
  orangeButton: '#CE4A2D',
  orangePressed: '#DE4A2A',
  orangeTint: '#FFE7DF',
  /** Stretch's pick. Dark enough for text on its tint (4.5:1). */
  blue: '#316EAC',
  blueTint: '#DDF1FD',
  blueLine: '#9CC3EA',
  ink: '#1F1F1F',
  /** Shop here. */
  pill: '#2E2E2E',
  /** Secondary text: 4.5:1 or more on paper, white, chip and blush. */
  muted: '#696661',
  /** Placeholders, dividers' dots and icons that aren't the only cue: 3:1 on paper and white. */
  faint: '#8C8883',
  line: '#E8E4DD',
  /** Steppers and chips. */
  chip: '#F0EEE9',
  green: '#1A7A46',
  greenTint: '#DDF3E6',
  red: '#C23A2F',
  amber: '#9A5B00',
  amberTint: '#FFF0D2',
} as const;

export const fonts = {
  display: 'Fraunces_600SemiBold',
  body: 'Geist_400Regular',
  medium: 'Geist_500Medium',
  semibold: 'Geist_600SemiBold',
  bold: 'Geist_700Bold',
  /** The handwritten accent, used once or twice. */
  script: 'Caveat_700Bold',
} as const;

export const radius = { sm: 8, md: 12, lg: 18, pill: 999 } as const;

export const shadow = {
  card: {
    shadowColor: '#3B2A1A',
    shadowOpacity: 0.08,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 4 },
    elevation: 3,
  },
  float: {
    shadowColor: '#3B2A1A',
    shadowOpacity: 0.18,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
    elevation: 8,
  },
} as const;

export const money = (n: number): string => `$${n.toFixed(2)}`;
