/**
 * L5.9: the Studio's tokens, the ONE file for both appearances (docs/reference/studio-ui.md, DESIGN §4k). Pure data;
 * `tokensCss()` writes `tokens.css` from it (`pnpm -F @demo-studio/ui gen:tokens`; a test fails when the committed file
 * differs). Dark is the default and follows the system: no preference or `dark` → dark, `prefers-color-scheme: light` →
 * light; a `data-appearance` scope (the gallery's columns) forces one inside the page.
 * - `UI_COLOURS` — the design system's semantic set (`--ui-*`), read by the kit (`ui-kit/`), the shell, the screens and
 *   the page's base (base.css).
 * - `UI_STATIC` — appearance-free tokens: type, spacing, radii, sizes, the font stacks.
 * L5.12d: the L4.1 – L4.9 palette (`--bg`, `--fg` …) and its appearance-free tokens went with the legacy layer (app.css):
 * every token is a `--ui-*` one.
 * No token is built from another (every value is a literal); the font files are the bundled Geist pair (BL-120),
 * served by the Studio's own origin (`/fonts/…`, bundle.ts).
 */

export type Appearance = 'dark' | 'light';
export interface Pair {
  dark: string;
  light: string;
}

/** The kit's semantic colours (`--ui-<name>`), from the validated canvas (round 4; R4-Light for light). */
export const UI_COLOURS: Record<string, Pair> = {
  // Surfaces
  canvas: { dark: '#111214', light: '#f6f6f7' },
  pane: { dark: '#18191c', light: '#ececee' },
  raised: { dark: '#25272b', light: '#dfe0e4' },
  'raised-hi': { dark: '#2b2d32', light: '#ffffff' },
  // Fields and the segmented well are sunken, as the canvas draws them (review B-L2).
  field: { dark: '#111214', light: '#ffffff' },
  well: { dark: '#111214', light: '#e2e3e6' },
  overlay: { dark: '#222428', light: '#ffffff' },
  select: { dark: '#1d2a44', light: '#dbe7ff' },
  video: { dark: '#0a0a0b', light: '#0a0a0b' },
  kbd: { dark: '#2e3035', light: '#e2e3e6' },
  'record-tint': { dark: '#2b2224', light: '#f6e3e1' },
  recording: { dark: '#3d2523', light: '#f2d4d1' },
  accent: { dark: '#2f6fe0', light: '#2f6fe0' },
  danger: { dark: '#c42e25', light: '#b42318' },
  // Text
  text: { dark: '#ececef', light: '#16181d' },
  'text-2': { dark: '#c9ccd3', light: '#3d424b' },
  'text-3': { dark: '#a3a8b3', light: '#555b66' },
  'text-strong': { dark: '#ffffff', light: '#0f1115' },
  link: { dark: '#7aaaff', light: '#1a56c4' },
  'on-accent': { dark: '#ffffff', light: '#ffffff' },
  'on-video': { dark: '#ffffff', light: '#ffffff' },
  'danger-text': { dark: '#ff7b72', light: '#b42318' },
  // Marks (non-text, ≥ 3:1 where they stand)
  ring: { dark: '#4c8dff', light: '#2f6fe0' },
  // L5.12c fixes (review A-L6): a pressed toggle's bar (Play) — its own colour, not the focus ring's.
  pressed: { dark: '#a3c4ff', light: '#1b45ad' },
  ok: { dark: '#4cd27a', light: '#1a8d4c' },
  warn: { dark: '#f2b84b', light: '#a86d14' },
  fail: { dark: '#ff7b72', light: '#d93a30' },
  record: { dark: '#ff453a', light: '#d93a30' },
  // (Never a text or track colour's value: the checker reads a colour back to its status family — review A-L7.)
  idle: { dark: '#9fa4ae', light: '#6b7079' },
  waiting: { dark: '#7d828c', light: '#7a7f89' },
  track: { dark: '#6b7079', light: '#7d828c' },
  knob: { dark: '#ececef', light: '#ffffff' },
  // Lines and veils
  hairline: { dark: '#2e3035', light: '#d6d8dc' },
  'field-line': { dark: '#43464d', light: '#d3d5da' },
  backdrop: { dark: 'rgba(6, 7, 8, 0.55)', light: 'rgba(22, 24, 29, 0.35)' },
  shadow: { dark: 'rgba(0, 0, 0, 0.55)', light: 'rgba(0, 0, 0, 0.18)' },
};

const SANS = "'Geist', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";
const MONO = "'Geist Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

/** The kit's appearance-free tokens (`--ui-<name>`): three type sizes, a 4-based spacing scale, radii, pane sizes. */
export const UI_STATIC: Record<string, string> = {
  font: SANS,
  mono: MONO,
  'type-sm': '13px',
  'type-md': '15px',
  'type-lg': '20px',
  'lead-sm': '18px',
  'lead-md': '22px',
  'lead-lg': '26px',
  tracking: '-0.01em',
  'weight-regular': '400',
  'weight-strong': '600',
  'space-1': '2px',
  'space-2': '4px',
  'space-3': '6px',
  'space-4': '8px',
  'space-5': '12px',
  'space-6': '16px',
  'space-7': '20px',
  'space-8': '24px',
  'space-9': '32px',
  'space-10': '40px',
  'radius-kbd': '4px',
  'radius-segment': '6px',
  'radius-control': '7px',
  'radius-frame': '8px',
  'radius-seg': '9px',
  'radius-well': '10px',
  'radius-card': '12px',
  'radius-overlay': '14px',
  'titlebar-h': '48px',
  'statusbar-h': '34px',
  'browser-w': '240px',
  'inspector-w': '320px',
  'label-w': '96px',
  'control-h': '30px',
  'control-sm': '26px',
  'control-lg': '36px',
  icon: '16px',
  mark: '7px',
  'card-w': '248px',
  'overlay-w': '560px',
  /** L5.12b: the command palette's width (R4-Palette). */
  'palette-w': '640px',
  /** The window buttons' room at the title bar's left (0 on the web; 80px under the desktop's overlay title bar). */
  'titlebar-inset': '0px',
};

/** The bundled fonts (packages/ui/fonts, SIL OFL 1.1 beside them), served at `/fonts/<file>`. */
export const FONT_FILES = [
  { family: 'Geist', file: 'Geist-Variable.woff2' },
  { family: 'Geist Mono', file: 'GeistMono-Variable.woff2' },
] as const;

/** The overlay title bar's inset (DESIGN §4j): the window buttons sit inside it. */
export const TITLEBAR_INSET_OVERLAY = '80px';

/** Every colour token of one appearance, `--name` → value. */
export function colourTokens(a: Appearance): Map<string, string> {
  return new Map(Object.entries(UI_COLOURS).map(([k, v]) => [`--ui-${k}`, v[a]] as [string, string]));
}

/** Every token of one appearance, `--name` → value (colours and the appearance-free ones). */
export function tokenMap(a: Appearance): Map<string, string> {
  return new Map([...Object.entries(UI_STATIC).map(([k, v]) => [`--ui-${k}`, v] as [string, string]), ...colourTokens(a)]);
}

const block = (selector: string, scheme: Appearance, decls: Map<string, string>, indent = '') =>
  `${indent}${selector} {\n${indent}  color-scheme: ${scheme};\n${[...decls].map(([k, v]) => `${indent}  ${k}: ${v};`).join('\n')}\n${indent}}\n`;

/** The dialogs' veil for one appearance, declared on `selector` (review A-L9). */
const veils = (selector: string, a: Appearance, indent = '') =>
  `${indent}${selector} {\n${[...colourTokens(a)].filter(([k]) => k === '--ui-backdrop').map(([k, v]) => `${indent}  ${k}: ${v};`).join('\n')}\n${indent}}\n`;

/** tokens.css, generated (scripts/gen-tokens.ts writes it; app-source.test.ts compares it). */
export function tokensCss(): string {
  const fonts = FONT_FILES.map((f) => `@font-face {\n  font-family: '${f.family}';\n  src: url('/fonts/${f.file}') format('woff2');\n  font-weight: 100 900;\n  font-style: normal;\n  font-display: swap;\n}\n`).join('');
  const statics = Object.entries(UI_STATIC).map(([k, v]) => `  --ui-${k}: ${v};`).join('\n');
  return [
    '/* Generated from src/app/tokens.ts by scripts/gen-tokens.ts (pnpm -F @demo-studio/ui gen:tokens): do not edit. */\n',
    fonts,
    `:root {\n${statics}\n}\n`,
    "html[data-titlebar='overlay'] {\n" + `  --ui-titlebar-inset: ${TITLEBAR_INSET_OVERLAY};\n}\n`,
    '/* Dark by default (no preference, or dark). */\n',
    block(":root,\n[data-appearance='dark']", 'dark', colourTokens('dark')),
    '/* The system asks for light. */\n',
    `@media (prefers-color-scheme: light) {\n${block(':root', 'light', colourTokens('light'), '  ')}}\n`,
    '/* Scopes inside the page (the gallery): after the media block, so a scope always wins. */\n',
    block("[data-appearance='light']", 'light', colourTokens('light')),
    block("[data-appearance='dark']", 'dark', colourTokens('dark')),
    '/* ::backdrop inherits no custom property in Safari 17 and Firefox 120 (UI_TARGETS): the veils are declared on it. */\n',
    veils('::backdrop', 'dark'),
    `@media (prefers-color-scheme: light) {\n${veils('::backdrop', 'light', '  ')}}\n`,
    veils("[data-appearance='light'] ::backdrop", 'light'),
    veils("[data-appearance='dark'] ::backdrop", 'dark'),
  ].join('');
}
