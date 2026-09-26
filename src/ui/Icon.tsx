import React from 'react';
import Svg, { Circle, Path } from 'react-native-svg';
import { colors } from './theme';

// Outline icons on a 24-unit grid, drawn with react-native-svg (@expo/vector-icons is being deprecated).
const ICONS = {
  back: { paths: ['M15 18l-6-6 6-6'] },
  forward: { paths: ['M9 18l6-6-6-6'] },
  down: { paths: ['M6 9l6 6 6-6'] },
  up: { paths: ['M18 15l-6-6-6 6'] },
  menu: { paths: ['M4 6h16', 'M4 12h16', 'M4 18h16'] },
  plus: { paths: ['M12 5v14', 'M5 12h14'] },
  minus: { paths: ['M5 12h14'] },
  check: { paths: ['M20 6L9 17l-5-5'] },
  close: { paths: ['M18 6L6 18', 'M6 6l12 12'] },
  trash: { paths: ['M3 6h18', 'M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6', 'M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2'] },
  refresh: {
    paths: [
      'M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8',
      'M3 3v5h5',
      'M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16',
      'M16 16h5v5',
    ],
  },
  map: {
    paths: [
      'M14.1 5.55a2 2 0 0 0 1.8 0l3.66-1.83A1 1 0 0 1 21 4.62v12.76a1 1 0 0 1-.55.9l-4.55 2.27a2 2 0 0 1-1.8 0l-4.2-2.1a2 2 0 0 0-1.8 0l-3.66 1.83A1 1 0 0 1 3 19.38V6.62a1 1 0 0 1 .55-.9L8.1 3.45a2 2 0 0 1 1.8 0z',
      'M15 5.76v15',
      'M9 3.24v15',
    ],
  },
  pin: { paths: ['M20 10c0 5-5.54 10.19-7.4 11.8a1 1 0 0 1-1.2 0C9.54 20.19 4 15 4 10a8 8 0 0 1 16 0'], circles: [[12, 10, 3]] },
  sparkle: { paths: ['M12 3l1.8 5.6a2 2 0 0 0 1.3 1.3L21 12l-5.9 1.8a2 2 0 0 0-1.3 1.3L12 21l-1.8-5.9a2 2 0 0 0-1.3-1.3L3 12l5.9-1.8a2 2 0 0 0 1.3-1.3z'] },
  split: { paths: ['M16 3h5v5', 'M8 3H3v5', 'M12 22v-8.3a4 4 0 0 0-1.17-2.87L3 3', 'M15 9l6-6'] },
  store: { paths: ['M3 10l1.6-5.4A1 1 0 0 1 5.56 4h12.88a1 1 0 0 1 .96.6L21 10', 'M3 10h18', 'M5 10v10h14V10', 'M10 20v-5h4v5'] },
  activity: { paths: ['M22 12h-4l-3 9L9 3l-3 9H2'] },
  zap: { paths: ['M13 2L3 14h9l-1 8 10-12h-9l1-8z'] },
  phone: { paths: ['M7 2h10a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z', 'M12 18h.01'] },
  alert: { paths: ['M12 8v4', 'M12 16h.01'], circles: [[12, 12, 10]] },
  cart: { paths: ['M2 3h3l2.7 12.4a2 2 0 0 0 2 1.6h8.1a2 2 0 0 0 1.95-1.57L21.4 8H6'], circles: [[9, 20, 1.3], [18, 20, 1.3]] },
  edit: { paths: ['M12 20h9', 'M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z'] },
  more: { paths: [], dots: [[12, 5], [12, 12], [12, 19]] },
  eye: { paths: ['M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z'], circles: [[12, 12, 3]] },
  search: { paths: ['M21 21l-4.35-4.35'], circles: [[11, 11, 7]] },
  scan: { paths: ['M3 7V5a2 2 0 0 1 2-2h2', 'M17 3h2a2 2 0 0 1 2 2v2', 'M21 17v2a2 2 0 0 1-2 2h-2', 'M7 21H5a2 2 0 0 1-2-2v-2', 'M7 8v8', 'M10.5 8v8', 'M14 8v8', 'M17 8v8'] },
  book: { paths: ['M4 19.5A2.5 2.5 0 0 1 6.5 17H20', 'M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z'] },
  shield: { paths: ['M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z'] },
  bell: { paths: ['M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9', 'M13.73 21a2 2 0 0 1-3.46 0'] },
  sliders: { paths: ['M4 21v-7', 'M4 10V3', 'M12 21v-9', 'M12 8V3', 'M20 21v-5', 'M20 12V3', 'M1 14h6', 'M9 8h6', 'M17 16h6'] },
  heartPulse: { paths: ['M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78L12 21.23l8.84-8.84a5.5 5.5 0 0 0 0-7.78z', 'M3.5 12h4l2-3 3 6 2-3h6'] },
  tag: { paths: ['M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z'], dots: [[7, 7]] },
  clock: { paths: ['M12 6v6l4 2'], circles: [[12, 12, 10]] },
  star: { paths: ['M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z'] },
  share: { paths: ['M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8', 'M16 6l-4-4-4 4', 'M12 2v13'] },
  copy: { paths: ['M9 9h11v11H9z', 'M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1'] },
  info: { paths: ['M12 16v-4', 'M12 8h.01'], circles: [[12, 12, 10]] },
  arrowDown: { paths: ['M12 5v14', 'M19 12l-7 7-7-7'] },
  arrowUp: { paths: ['M12 19V5', 'M5 12l7-7 7 7'] },
  external: { paths: ['M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6', 'M15 3h6v6', 'M10 14L21 3'] },
  heart: {
    paths: ['M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z'],
  },
  timer: { paths: ['M12 9v4l2 2', 'M10 2h4'], circles: [[12, 14, 8]] },
  globe: { paths: ['M2 12h20', 'M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z'], circles: [[12, 12, 10]] },
  paste: { paths: ['M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2', 'M9 2h6v4H9z'] },
  ruler: { paths: ['M21.3 15.3a2.4 2.4 0 0 1 0 3.4l-2.6 2.6a2.4 2.4 0 0 1-3.4 0L2.7 8.7a2.41 2.41 0 0 1 0-3.4l2.6-2.6a2.41 2.41 0 0 1 3.4 0z', 'M14.5 12.5l2-2', 'M11.5 9.5l2-2', 'M8.5 6.5l2-2', 'M17.5 15.5l2-2'] },
  truck: {
    paths: ['M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2', 'M15 18H9', 'M19 18h2a1 1 0 0 0 1-1v-3.65a1 1 0 0 0-.22-.62l-3.48-4.35A1 1 0 0 0 17.52 8H14'],
    circles: [[17, 18, 2], [7, 18, 2]],
  },
  bag: { paths: ['M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z', 'M3 6h18', 'M16 10a4 4 0 0 1-8 0'] },
} satisfies Record<string, { paths: string[]; circles?: number[][]; dots?: number[][] }>;

export type IconName = keyof typeof ICONS;

export function Icon({
  name,
  size = 22,
  color = colors.ink,
  strokeWidth = 2,
}: {
  name: IconName;
  size?: number;
  color?: string;
  strokeWidth?: number;
}) {
  const icon: { paths: string[]; circles?: number[][]; dots?: number[][] } = ICONS[name];
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      {icon.paths.map((d) => (
        <Path key={d} d={d} stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
      ))}
      {icon.circles?.map(([cx, cy, r]) => (
        <Circle key={`${cx}-${cy}`} cx={cx} cy={cy} r={r} stroke={color} strokeWidth={strokeWidth} />
      ))}
      {icon.dots?.map(([cx, cy]) => <Circle key={`${cx}-${cy}`} cx={cx} cy={cy} r={1.7} fill={color} />)}
    </Svg>
  );
}
