/**
 * L5.9: the kit's icons — a table of stroke paths on a 16 × 16 grid (1.5 px strokes, round caps; the canvas' set), drawn
 * by `<Icon>` as an `aria-hidden` SVG in `currentColor`: an icon never carries meaning alone (a button names itself, a
 * status mark says its word). No icon font, no file, no dependency.
 */

/** Each icon: stroke paths (`d`), and filled paths (`fill`) for the solid ones. */
const ICONS = {
  'chevron-down': { d: ['M4 6l4 4 4-4'] },
  'chevron-right': { d: ['M6 4l4 4-4 4'] },
  'chevron-left': { d: ['M10 4L6 8l4 4'] },
  sidebar: { d: ['M2.5 3.5h11v9h-11z', 'M6 3.5v9'] },
  inspector: { d: ['M2.5 3.5h11v9h-11z', 'M10 3.5v9'] },
  play: { fill: ['M5 3.5v9l7.5-4.5z'] },
  pause: { fill: ['M4.5 3.5h2.5v9H4.5z', 'M9 3.5h2.5v9H9z'] },
  record: { fill: ['M8 3.5a4.5 4.5 0 1 1 0 9a4.5 4.5 0 1 1 0-9z'] },
  stop: { fill: ['M4 4h8v8H4z'] },
  search: { d: ['M7 3a4 4 0 1 1 0 8a4 4 0 1 1 0-8z', 'M10 10l3.5 3.5'] },
  copy: { d: ['M5.5 5.5h7v7h-7z', 'M3.5 10.5v-7h7'] },
  check: { d: ['M3.5 8.5l3 3 6-7'] },
  plus: { d: ['M8 3.5v9', 'M3.5 8h9'] },
  close: { d: ['M4 4l8 8', 'M12 4l-8 8'] },
  more: { fill: ['M3 6.75h2.5v2.5H3z', 'M6.75 6.75h2.5v2.5h-2.5z', 'M10.5 6.75H13v2.5h-2.5z'] },
  warning: { d: ['M8 2.5l6 11H2z', 'M8 6.5v3', 'M8 11.25v.5'] },
  theme: { d: ['M8 2.5a5.5 5.5 0 1 0 0 11c1 0 1.25-.75.75-1.5s0-1.75 1-1.75H12a1.5 1.5 0 0 0 1.5-1.5A5.5 5.5 0 0 0 8 2.5z'] },
  folder: { d: ['M2.5 4.5h4l1.5 1.5h5.5v6.5h-11z'] },
  scene: { d: ['M2.5 3.5h11v9h-11z', 'M5 3.5v9', 'M11 3.5v9'] },
  report: { d: ['M4 2.5h5.5L12 5v8.5H4z', 'M6 8h4', 'M6 10.5h4'] },
  undo: { d: ['M5.5 4L3 6.5 5.5 9', 'M3 6.5h6.5a3 3 0 0 1 0 6H7'] },
  redo: { d: ['M10.5 4L13 6.5 10.5 9', 'M13 6.5H6.5a3 3 0 0 0 0 6H9'] },
  film: { d: ['M2.5 3.5h11v9h-11z', 'M6.75 6v4l3.25-2z'] },
  components: { d: ['M3 3h4v4H3z', 'M9 3h4v4H9z', 'M3 9h4v4H3z', 'M9 9h4v4H9z'] },
  location: { d: ['M8 13.75s-4-3.5-4-7a4 4 0 0 1 8 0c0 3.5-4 7-4 7z', 'M8 5.5a1.25 1.25 0 1 1 0 2.5a1.25 1.25 0 1 1 0-2.5z'] },
  person: { d: ['M8 3a2.5 2.5 0 1 1 0 5a2.5 2.5 0 1 1 0-5z', 'M3.5 13.5a4.5 4.5 0 0 1 9 0'] },
  command: { d: ['M6 6h4v4H6z', 'M6 6V4.5A1.5 1.5 0 1 0 4.5 6H6', 'M10 6V4.5A1.5 1.5 0 1 1 11.5 6H10', 'M6 10v1.5A1.5 1.5 0 1 1 4.5 10H6', 'M10 10v1.5a1.5 1.5 0 1 0 1.5-1.5H10'] },
} satisfies Record<string, { d?: string[]; fill?: string[] }>;

export type IconName = keyof typeof ICONS;
export const ICON_NAMES = Object.keys(ICONS) as IconName[];

export function Icon({ name, className }: { name: IconName; className?: string }) {
  const icon: { d?: string[]; fill?: string[] } = ICONS[name];
  return (
    <svg className={className ? `k-icon ${className}` : 'k-icon'} viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
      {icon.d?.map((d) => <path key={d} d={d} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />)}
      {icon.fill?.map((d) => <path key={d} d={d} fill="currentColor" />)}
    </svg>
  );
}
