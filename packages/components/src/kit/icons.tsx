/**
 * A small built-in icon set for cards (studio/card-features, L2.10): line icons on a 24 × 24 grid, drawn with the
 * stroke colour the component picks from the theme. Generic shapes only (no brand marks).
 */
import type { CSSProperties, ReactNode } from 'react';

type Shape = { d?: string; circle?: [number, number, number]; rect?: [number, number, number, number, number] };

const S = (d: string): Shape => ({ d });
const C = (cx: number, cy: number, r: number): Shape => ({ circle: [cx, cy, r] });
const R = (x: number, y: number, w: number, h: number, rx: number): Shape => ({ rect: [x, y, w, h, rx] });

/** Icon name → its shapes. */
export const ICON_SHAPES: Readonly<Record<string, readonly Shape[]>> = {
  check: [S('M5 12.5l4.2 4.2L19 7')],
  bolt: [S('M13.5 2.5 5 13.5h6.5L10.5 21.5 19 10.5h-6.5z')],
  clock: [C(12, 12, 9), S('M12 7v5l3.5 2')],
  chart: [S('M5 20v-6M11 20V8M17 20v-9M3 20h18')],
  trend: [S('M3 17l6-6 4 4 8-8'), S('M15 7h6v6')],
  shield: [S('M12 3l7.5 3v5.5c0 4.6-3.2 8.3-7.5 9.5-4.3-1.2-7.5-4.9-7.5-9.5V6z'), S('M8.8 12.2l2.2 2.2 4.4-4.6')],
  globe: [C(12, 12, 9), S('M3 12h18'), S('M12 3c2.6 2.5 4 5.7 4 9s-1.4 6.5-4 9c-2.6-2.5-4-5.7-4-9s1.4-6.5 4-9z')],
  users: [C(9, 8, 3.5), S('M2.5 20c.6-3.6 3.2-5.6 6.5-5.6s5.9 2 6.5 5.6'), C(17, 9, 2.6), S('M17.5 14.6c2.3.4 3.7 2 4.1 4.6')],
  truck: [S('M2.5 6.5h11v9h-11z'), S('M13.5 9.5h4.2l3.3 3.6v2.4h-7.5'), C(7, 17.5, 1.9), C(17, 17.5, 1.9)],
  receipt: [S('M6 3h12v18l-2-1.4L14 21l-2-1.4L10 21l-2-1.4L6 21z'), S('M9 8h6M9 12h6M9 16h3')],
  bell: [S('M6 16v-5a6 6 0 0 1 12 0v5l1.5 2h-15z'), S('M10 20.5a2 2 0 0 0 4 0')],
  star: [S('M12 3.2l2.7 5.6 6.1.8-4.5 4.3 1.1 6.1L12 17.1 6.6 20l1.1-6.1-4.5-4.3 6.1-.8z')],
  sparkles: [S('M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z'), S('M19 15l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z')],
  lock: [R(5, 10.5, 14, 10, 2), S('M8 10.5V7.5a4 4 0 0 1 8 0v3')],
  heart: [S('M12 20s-7.5-4.6-7.5-10.2A4.3 4.3 0 0 1 12 7.2a4.3 4.3 0 0 1 7.5 2.6C19.5 15.4 12 20 12 20z')],
  leaf: [S('M5 19C5 10 10.5 4.5 20 4.5c0 9.5-5.5 15-14 15z'), S('M5 19c3.5-4.5 6.5-7 10-9')],
  cup: [S('M4 9h12v5a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5z'), S('M16 10.5h1.5a2.5 2.5 0 0 1 0 5H16'), S('M8 3.5c-.6.9-.6 1.8 0 2.7M12 3.5c-.6.9-.6 1.8 0 2.7')],
  mail: [R(3, 5.5, 18, 13, 2), S('M3.5 7l8.5 6.5L20.5 7')],
  search: [C(10.5, 10.5, 6.5), S('M15.5 15.5 21 21')],
  calendar: [R(3.5, 5, 17, 15.5, 2), S('M3.5 10h17M8 3v4M16 3v4')],
  cart: [S('M3 4h2.5l2.2 10.5h10.6L20.5 7H6.3'), C(9.5, 19, 1.5), C(17, 19, 1.5)],
  document: [S('M6 3h8l4 4v14H6z'), S('M14 3v4h4'), S('M9 12h6M9 16h6')],
  sliders: [S('M4 7h10M18 7h2M4 17h4M12 17h8'), C(16, 7, 2), C(10, 17, 2)],
  link: [S('M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1.2 1.2'), S('M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1.2-1.2')],
  phone: [R(7, 2.5, 10, 19, 2.5), S('M11 18.5h2')],
  tag: [S('M3 12V4h8l10 10-8 8z'), C(7.5, 7.5, 1.5)],
};

/** Names of the built-in icons. */
export const ICON_NAMES: readonly string[] = Object.keys(ICON_SHAPES);

/** A built-in icon (`name`), `size` px square, stroked in `color`; nothing for an unknown name. */
export function Icon(props: { name: string; size: number; color: string; strokeWidth?: number; style?: CSSProperties }): ReactNode {
  const shapes = ICON_SHAPES[props.name];
  if (!shapes) return null;
  const sw = props.strokeWidth ?? 1.8;
  return (
    <svg width={props.size} height={props.size} viewBox="0 0 24 24" fill="none" stroke={props.color} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" style={props.style}>
      {shapes.map((s, i) =>
        s.d ? <path key={i} d={s.d} /> : s.circle ? <circle key={i} cx={s.circle[0]} cy={s.circle[1]} r={s.circle[2]} /> : s.rect ? <rect key={i} x={s.rect[0]} y={s.rect[1]} width={s.rect[2]} height={s.rect[3]} rx={s.rect[4]} /> : null,
      )}
    </svg>
  );
}
