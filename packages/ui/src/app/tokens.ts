/**
 * L5.9: the Studio's tokens, the ONE file for both appearances (docs/reference/studio-ui.md, DESIGN §4k). Pure data;
 * `tokensCss()` writes `tokens.css` from it (`pnpm -F @demo-studio/ui gen:tokens`; a test fails when the committed file
 * differs). Dark is the default and follows the system: no preference or `dark` → dark, `prefers-color-scheme: light` →
 * light; a `data-appearance` scope (the gallery's columns, a legacy route kept light) forces one inside the page.
 * - `UI_COLOURS` — the design system's semantic set (`--ui-*`), read by the kit (`ui-kit/`) and the shell only.
 * - `LEGACY_COLOURS` — the L4.1 – L4.9 palette (`--bg`, `--fg` …), read by app.css only; its light values are exactly the
 *   L4.9 ones (the light appearance of an existing screen is unchanged), its dark values map onto the semantic set. It
 *   goes when the last legacy screen is rebuilt (L5.10 – L5.12; the lint "every token used" removes stragglers).
 * - `UI_STATIC` / `LEGACY_STATIC` — appearance-free tokens: type, spacing, radii, sizes, the font stacks.
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

/** The L4.9 palette: light exactly as L4.9 shipped it, dark mapped onto the semantic set. */
export const LEGACY_COLOURS: Record<string, Pair> = {
  // Surfaces and neutral tints
  bg: { light: '#f6f7f9', dark: '#111214' },
  surface: { light: '#ffffff', dark: '#18191c' },
  subtle: { light: '#fafbfc', dark: '#1b1c20' },
  'field-off': { light: '#f9fafb', dark: '#1f2024' },
  'link-hover': { light: '#f6f8fb', dark: '#222428' },
  'code-bg': { light: '#f4f5f7', dark: '#222428' },
  faint: { light: '#f3f4f6', dark: '#1f2024' },
  hover: { light: '#f1f3f6', dark: '#25272b' },
  'thumb-stripe': { light: '#f1f2f5', dark: '#222428' },
  tint: { light: '#eef0f3', dark: '#25272b' },
  'thumb-bg': { light: '#eceef2', dark: '#222428' },
  'hook-tint': { light: '#e9edf1', dark: '#23272c' },
  // Text
  fg: { light: '#16181d', dark: '#ececef' },
  'fg-soft': { light: '#262a31', dark: '#dcdee3' },
  'hook-fg': { light: '#2f3b47', dark: '#c3cdd7' },
  'tint-fg': { light: '#3c4350', dark: '#c9ccd3' },
  muted: { light: '#565d69', dark: '#a3a8b3' },
  // Lines
  line: { light: '#e2e5ea', dark: '#2e3035' },
  'line-strong': { light: '#cfd4dc', dark: '#43464d' },
  'hook-line': { light: '#9aa6b2', dark: '#5d6874' },
  // Steps while a write is in flight (review A-L2: a dashed edge, a mark at 3:1 — the text keeps its colours).
  'busy-edge': { light: '#7d828c', dark: '#80858f' },
  // The one accent: text and rings (--accent, --accent-strong) and fills under white text (--accent-fill,
  // --accent-strong-fill; split in L5.9: one value cannot be both in dark).
  accent: { light: '#2357d9', dark: '#7aaaff' },
  'accent-strong': { light: '#1b45ad', dark: '#a3c4ff' },
  'accent-fill': { light: '#2357d9', dark: '#2f6fe0' },
  'accent-strong-fill': { light: '#1b45ad', dark: '#2a62c9' },
  'accent-soft': { light: '#eaf0fd', dark: '#1d2a44' },
  'accent-line': { light: '#b8cbf5', dark: '#34508a' },
  'on-accent': { light: '#ffffff', dark: '#ffffff' },
  // Status families (always with words)
  danger: { light: '#b42318', dark: '#ff7b72' },
  'danger-soft': { light: '#fdecea', dark: '#3a2422' },
  'danger-line': { light: '#f2c3bd', dark: '#6b3430' },
  'danger-line-strong': { light: '#e7b4ae', dark: '#82403a' },
  warning: { light: '#8a5300', dark: '#f2b84b' },
  'warning-soft': { light: '#fdf3e1', dark: '#33291a' },
  'warning-faint': { light: '#fffdf8', dark: '#221d14' },
  'warning-line': { light: '#efd6a8', dark: '#5e4a24' },
  'warning-mark': { light: '#e8b04a', dark: '#e8b04a' },
  info: { light: '#1f5fae', dark: '#8bb8f0' },
  'info-soft': { light: '#e8f1fb', dark: '#192b3f' },
  'info-line': { light: '#c4d9f3', dark: '#2f4a72' },
  success: { light: '#1d6b3a', dark: '#6fd394' },
  'success-soft': { light: '#e6f4ea', dark: '#1b2e22' },
  // The categorical tint: input actions, card segments (always with words)
  'input-tint': { light: '#f1ebfb', dark: '#2a2340' },
  'input-fg': { light: '#5b3a99', dark: '#c9b5f5' },
  // Video surfaces, tooltips, dialogs (video stays dark in both appearances)
  ink: { light: '#16181d', dark: '#0a0a0b' },
  'ink-soft': { light: '#1c1f24', dark: '#141518' },
  'ink-veil': { light: 'rgba(22, 24, 29, 0.75)', dark: 'rgba(10, 10, 11, 0.75)' },
  'on-ink': { light: '#ffffff', dark: '#ffffff' },
  'on-ink-muted': { light: '#c9ced8', dark: '#c9ced8' },
  veil: { light: 'rgba(255, 255, 255, 0.92)', dark: 'rgba(24, 25, 28, 0.92)' },
  backdrop: { light: 'rgba(22, 24, 29, 0.35)', dark: 'rgba(6, 7, 8, 0.55)' },
  'mark-on-video': { light: '#ffd43b', dark: '#ffd43b' },
  'mark-edge': { light: 'rgba(0, 0, 0, 0.6)', dark: 'rgba(0, 0, 0, 0.6)' },
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
  /** The window buttons' room at the title bar's left (0 on the web; 80px under the desktop's overlay title bar). */
  'titlebar-inset': '0px',
};

/** A px length of UI_STATIC, as a number. */
const px = (name: string): number => Number(/^(\d+)px$/.exec(UI_STATIC[name])![1]);

/**
 * The legacy screens' appearance-free tokens (app.css). `--main-h`: the shell's centre pane height — the window less the
 * title and status bars, written out from their tokens here (review B-L7: a bar's height changes it too; no CSS token
 * reads another).
 */
export const LEGACY_STATIC: Record<string, string> = {
  radius: '8px',
  font: SANS,
  mono: MONO,
  'main-h': `calc(100dvh - ${px('titlebar-h') + px('statusbar-h')}px)`,
};

/** The bundled fonts (packages/ui/fonts, SIL OFL 1.1 beside them), served at `/fonts/<file>`. */
export const FONT_FILES = [
  { family: 'Geist', file: 'Geist-Variable.woff2' },
  { family: 'Geist Mono', file: 'GeistMono-Variable.woff2' },
] as const;

/** The overlay title bar's inset (DESIGN §4j): the window buttons sit inside it. */
export const TITLEBAR_INSET_OVERLAY = '80px';

/** Every colour token of one appearance, `--name` → value (the kit's set and the legacy set). */
export function colourTokens(a: Appearance): Map<string, string> {
  return new Map([...Object.entries(UI_COLOURS).map(([k, v]) => [`--ui-${k}`, v[a]] as [string, string]), ...Object.entries(LEGACY_COLOURS).map(([k, v]) => [`--${k}`, v[a]] as [string, string])]);
}

/** Every token of one appearance, `--name` → value (colours and the appearance-free ones). */
export function tokenMap(a: Appearance): Map<string, string> {
  return new Map([...Object.entries(UI_STATIC).map(([k, v]) => [`--ui-${k}`, v] as [string, string]), ...Object.entries(LEGACY_STATIC).map(([k, v]) => [`--${k}`, v] as [string, string]), ...colourTokens(a)]);
}

const block = (selector: string, scheme: Appearance, decls: Map<string, string>, indent = '') =>
  `${indent}${selector} {\n${indent}  color-scheme: ${scheme};\n${[...decls].map(([k, v]) => `${indent}  ${k}: ${v};`).join('\n')}\n${indent}}\n`;

/** The dialogs' veils (the kit's and the legacy one) for one appearance, declared on `selector` (review A-L9). */
const veils = (selector: string, a: Appearance, indent = '') =>
  `${indent}${selector} {\n${[...colourTokens(a)].filter(([k]) => k === '--ui-backdrop' || k === '--backdrop').map(([k, v]) => `${indent}  ${k}: ${v};`).join('\n')}\n${indent}}\n`;

/** tokens.css, generated (scripts/gen-tokens.ts writes it; app-source.test.ts compares it). */
export function tokensCss(): string {
  const fonts = FONT_FILES.map((f) => `@font-face {\n  font-family: '${f.family}';\n  src: url('/fonts/${f.file}') format('woff2');\n  font-weight: 100 900;\n  font-style: normal;\n  font-display: swap;\n}\n`).join('');
  const statics = [...Object.entries(UI_STATIC).map(([k, v]) => `  --ui-${k}: ${v};`), ...Object.entries(LEGACY_STATIC).map(([k, v]) => `  --${k}: ${v};`)].join('\n');
  return [
    '/* Generated from src/app/tokens.ts by scripts/gen-tokens.ts (pnpm -F @demo-studio/ui gen:tokens): do not edit. */\n',
    fonts,
    `:root {\n${statics}\n}\n`,
    "html[data-titlebar='overlay'] {\n" + `  --ui-titlebar-inset: ${TITLEBAR_INSET_OVERLAY};\n}\n`,
    '/* Dark by default (no preference, or dark). */\n',
    block(":root,\n[data-appearance='dark']", 'dark', colourTokens('dark')),
    '/* The system asks for light. */\n',
    `@media (prefers-color-scheme: light) {\n${block(':root', 'light', colourTokens('light'), '  ')}}\n`,
    '/* Scopes inside the page (the gallery, a legacy route kept light): after the media block, so a scope always wins. */\n',
    block("[data-appearance='light']", 'light', colourTokens('light')),
    block("[data-appearance='dark']", 'dark', colourTokens('dark')),
    '/* ::backdrop inherits no custom property in Safari 17 and Firefox 120 (UI_TARGETS): the veils are declared on it. */\n',
    veils('::backdrop', 'dark'),
    `@media (prefers-color-scheme: light) {\n${veils('::backdrop', 'light', '  ')}}\n`,
    veils("[data-appearance='light'] ::backdrop", 'light'),
    veils("[data-appearance='dark'] ::backdrop", 'dark'),
  ].join('');
}
