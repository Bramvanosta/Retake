/**
 * Keyboard shortcuts as key caps (studio/overlay-shortcut, L2.10): a Playwright key combination ("Meta+K",
 * "ControlOrMeta+Shift+P", "Enter", "ArrowDown") → the caps to draw, in the platform's conventions (macOS glyphs ⌘ ⌥ ⇧ ⌃,
 * or Ctrl / Alt / Shift words). Pure (no React).
 */

import { capTextLayout } from './metrics.js';
import type { CapTextLayout } from './metrics.js';
import { clearOf } from './place.js';
import type { Box } from './place.js';

export type KeyPlatform = 'mac' | 'windows' | 'linux';

/**
 * Key symbols drawn as line icons (24 × 24, stroke) rather than font glyphs, so they look the same with every theme font
 * and on every machine.
 */
export const KEY_GLYPHS: Readonly<Record<string, string>> = {
  command: 'M9 9H6.5A2.5 2.5 0 1 1 9 6.5V17.5A2.5 2.5 0 1 1 6.5 15H17.5A2.5 2.5 0 1 1 15 17.5V6.5A2.5 2.5 0 1 1 17.5 9H9z',
  option: 'M3.5 6.5h5l7 11h5M14 6.5h6.5',
  shift: 'M12 4 4 12.5h4.5V20h7v-7.5H20z',
  control: 'M6 14.5l6-6 6 6',
  return: 'M19 5v7a3 3 0 0 1-3 3H6m0 0 4-4m-4 4 4 4',
  tab: 'M4 12h14m0 0-5-5m5 5-5 5M20 6v12',
  delete: 'M9 5h11v14H9l-6-7zM12 9.5l5 5m0-5-5 5',
  forward_delete: 'M15 5H4v14h11l6-7zM7 9.5l5 5m0-5-5 5',
  up: 'M12 19V5m0 0-6 6m6-6 6 6',
  down: 'M12 5v14m0 0-6-6m6 6 6-6',
  left: 'M19 12H5m0 0 6-6m-6 6 6 6',
  right: 'M5 12h14m0 0-6-6m6 6-6 6',
  caps_lock: 'M12 4 4 12.5h4.5V16h7v-3.5H20zM8.5 19.5h7',
};

export interface KeyCap {
  /** What the cap shows as text: a letter ("K"), a short word ("esc", "Ctrl"), or the symbol ("⌘") of a glyph cap. */
  label: string;
  /** A symbol drawn as a line icon (KEY_GLYPHS), when the cap shows one. */
  glyph?: string;
  /** A word under the glyph on macOS named keys ("return", "tab"), when the style shows one. */
  hint?: string;
  modifier: boolean;
  /** The cap is wider than a letter (a word, a space bar). */
  wide: boolean;
  /** The key as written. */
  key: string;
}

const MODIFIERS = ['Control', 'Alt', 'Shift', 'Meta', 'ControlOrMeta'] as const;
type Modifier = (typeof MODIFIERS)[number];

/** Display order of the modifiers: macOS ⌃ ⌥ ⇧ ⌘; Windows / Linux Ctrl, Alt, Shift, Win. */
const ORDER: Record<KeyPlatform, Modifier[]> = {
  mac: ['Control', 'Alt', 'Shift', 'Meta', 'ControlOrMeta'],
  windows: ['Control', 'ControlOrMeta', 'Meta', 'Alt', 'Shift'],
  linux: ['Control', 'ControlOrMeta', 'Meta', 'Alt', 'Shift'],
};

const MAC_MODIFIERS: Record<Modifier, { label: string; hint: string; glyph: string }> = {
  Control: { label: '⌃', hint: 'control', glyph: 'control' },
  Alt: { label: '⌥', hint: 'option', glyph: 'option' },
  Shift: { label: '⇧', hint: 'shift', glyph: 'shift' },
  Meta: { label: '⌘', hint: 'command', glyph: 'command' },
  ControlOrMeta: { label: '⌘', hint: 'command', glyph: 'command' },
};

const PC_MODIFIERS: Record<KeyPlatform, Record<Modifier, string>> = {
  mac: { Control: 'Ctrl', Alt: 'Alt', Shift: 'Shift', Meta: 'Cmd', ControlOrMeta: 'Ctrl' },
  windows: { Control: 'Ctrl', Alt: 'Alt', Shift: 'Shift', Meta: 'Win', ControlOrMeta: 'Ctrl' },
  linux: { Control: 'Ctrl', Alt: 'Alt', Shift: 'Shift', Meta: 'Super', ControlOrMeta: 'Ctrl' },
};

/** Named keys: [macOS symbol, macOS word, Windows / Linux label, glyph on macOS, glyph everywhere]. */
const NAMED: Record<string, [string, string, string, string?, string?]> = {
  Enter: ['↩', 'return', 'Enter', 'return'],
  Tab: ['⇥', 'tab', 'Tab', 'tab'],
  Escape: ['esc', '', 'Esc'],
  Backspace: ['⌫', 'delete', 'Backspace', 'delete'],
  Delete: ['⌦', 'del', 'Delete', 'forward_delete'],
  ArrowUp: ['↑', '', '↑', 'up', 'up'],
  ArrowDown: ['↓', '', '↓', 'down', 'down'],
  ArrowLeft: ['←', '', '←', 'left', 'left'],
  ArrowRight: ['→', '', '→', 'right', 'right'],
  PageUp: ['pg up', '', 'PgUp'],
  PageDown: ['pg dn', '', 'PgDn'],
  Home: ['home', '', 'Home'],
  End: ['end', '', 'End'],
  CapsLock: ['⇪', 'caps lock', 'Caps', 'caps_lock'],
  Space: ['space', '', 'Space'],
  ' ': ['space', '', 'Space'],
  Insert: ['ins', '', 'Ins'],
};

/** Split a Playwright combination on "+" (a trailing "+" is the plus key: "Control++"). */
export function splitKeys(keys: string): string[] {
  const s = keys.trim();
  if (s === '+') return ['+'];
  const parts = s.split('+');
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === '' && i === parts.length - 1 && out.length > 0) out.push('+');
    else if (parts[i] !== '') out.push(parts[i].trim());
  }
  return out;
}

function keyLabel(key: string, platform: KeyPlatform): { label: string; hint?: string; glyph?: string; wide: boolean } {
  const named = NAMED[key];
  if (named) {
    const [sym, word, pc, macGlyph, anyGlyph] = named;
    if (platform === 'mac') return { label: sym, ...(word ? { hint: word } : {}), ...(macGlyph ? { glyph: macGlyph } : {}), wide: !macGlyph && sym.length > 1 };
    return { label: pc, ...(anyGlyph ? { glyph: anyGlyph } : {}), wide: !anyGlyph && pc.length > 1 };
  }
  const k = /^Key([A-Z])$/.exec(key)?.[1] ?? /^Digit(\d)$/.exec(key)?.[1] ?? /^Numpad(\d)$/.exec(key)?.[1];
  if (k) return { label: k, wide: false };
  if ([...key].length === 1) return { label: key.toUpperCase(), wide: false };
  return { label: key, wide: true };
}

/** The caps of a key combination: modifiers first (in the platform's order), then the key. */
export function parseShortcut(keys: string, platform: KeyPlatform = 'mac'): KeyCap[] {
  const parts = splitKeys(keys);
  const mods = parts.filter((p): p is Modifier => (MODIFIERS as readonly string[]).includes(p));
  const rest = parts.filter((p) => !(MODIFIERS as readonly string[]).includes(p));
  const seen = new Set<string>();
  const caps: KeyCap[] = [];
  for (const m of ORDER[platform]) {
    if (!mods.includes(m)) continue;
    const label = platform === 'mac' ? MAC_MODIFIERS[m].label : PC_MODIFIERS[platform][m];
    if (seen.has(label)) continue;
    seen.add(label);
    caps.push(
      platform === 'mac' ? { label, hint: MAC_MODIFIERS[m].hint, glyph: MAC_MODIFIERS[m].glyph, modifier: true, wide: false, key: m } : { label, modifier: true, wide: label.length > 1, key: m },
    );
  }
  for (const r of rest) caps.push({ ...keyLabel(r, platform), modifier: false, key: r });
  return caps;
}

/** The combination as one line of text ("⌘K", "Ctrl + K"), e.g. for review messages. */
export function shortcutText(keys: string, platform: KeyPlatform = 'mac'): string {
  const caps = parseShortcut(keys, platform);
  return platform === 'mac' ? caps.map((c) => c.label).join('') : caps.map((c) => c.label).join(' + ');
}

/** Sizes of the key-cap plate of studio/overlay-shortcut (cap height `size` design px; a little larger in vertical / square). */
export function shortcutPlateMetrics(
  size: number,
  unit: number,
  variant: 'landscape' | 'vertical' | 'square',
): { u: number; capH: number; pad: number; gap: number; height: number; inset: number; clearance: number } {
  const u = unit * (variant === 'landscape' ? 1 : 1.12);
  const capH = size * u;
  const pad = capH * 0.22;
  return { u, capH, pad, gap: capH * 0.14, height: capH + 2 * pad + capH * 0.06, inset: 26 * u, clearance: 14 * u };
}

/**
 * Where the plate goes: centred `w` wide at the bottom (or the top) of `bounds`, moved clear of `avoid` (a caption band
 * over the screen). The composition asks the same row (full width) for a loupe showing at the same time.
 */
export function shortcutPlateBox(o: { bounds: Box; w: number; h: number; position: 'bottom' | 'top'; avoid?: readonly Box[]; gap: number }): Box {
  const start = { x: o.bounds.x + (o.bounds.w - o.w) / 2, y: o.position === 'top' ? o.bounds.y : o.bounds.y + o.bounds.h - o.h, w: o.w, h: o.h };
  return clearOf(start, o.avoid, { dir: o.position === 'top' ? 'down' : 'up', gap: o.gap, bounds: o.bounds });
}

/** A cap of the plate with its word layout (null for a glyph) and width (output px). */
export interface PlateCap {
  cap: KeyCap;
  word: CapTextLayout | null;
  w: number;
}

/** The measured content of a key-cap plate: its caps, separators, label and "× N" chip, and its size (output px). */
export interface ShortcutPlateLayout {
  caps: PlateCap[];
  plus: CapTextLayout | null;
  plusW: number;
  label: CapTextLayout | null;
  countLabel: CapTextLayout | null;
  capsW: number;
  labelW: number;
  countW: number;
  /** The plate's size. */
  W: number;
  H: number;
  metrics: ReturnType<typeof shortcutPlateMetrics>;
  /** Ctrl / Alt words with "+" separators (Windows, Linux) rather than macOS glyphs. */
  pc: boolean;
  times: number;
}

/**
 * The plate of studio/overlay-shortcut measured (caps, separators, label, count chip): the component draws it, the
 * composition and the review place it with the same numbers (`shortcutPlateBox`).
 */
export function shortcutPlateLayout(o: {
  keys: string;
  label?: string;
  times?: number;
  platform: KeyPlatform;
  size: number;
  unit: number;
  variant: 'landscape' | 'vertical' | 'square';
  fontFamily: string;
}): ShortcutPlateLayout {
  const caps = parseShortcut(o.keys, o.platform);
  const m = shortcutPlateMetrics(o.size, o.unit, o.variant);
  const u = m.u;
  const { capH, pad, gap } = m;
  const times = Math.max(1, Math.min(99, o.times ?? 1));
  const pc = o.platform !== 'mac';
  const font = o.fontFamily;
  const layouts = caps.map((c): PlateCap => {
    const word = c.glyph
      ? null
      : capTextLayout({
          text: c.label,
          width: 600 * u,
          maxFontSize: capH * (c.label.length > 1 ? 0.34 : 0.44),
          minFontSize: capH * 0.2,
          maxLines: 1,
          lineHeight: 1.1,
          fontFamily: font,
          fontWeight: 600,
        });
    const w = c.glyph || !c.wide ? capH : Math.max(capH, (word?.width ?? 0) + capH * 0.6);
    return { cap: c, word, w };
  });
  const plus = pc ? capTextLayout({ text: '+', width: 200, maxFontSize: capH * 0.36, minFontSize: capH * 0.2, maxLines: 1, fontFamily: font, fontWeight: 500 }) : null;
  const plusW = plus ? plus.width + gap * 2 : gap;
  const label = o.label ? capTextLayout({ text: o.label, width: 520 * u, maxFontSize: capH * 0.32, minFontSize: capH * 0.2, maxLines: 1, lineHeight: 1.1, fontFamily: font, fontWeight: 500 }) : null;
  const countLabel = times > 1 ? capTextLayout({ text: `× ${times}`, width: 200 * u, maxFontSize: capH * 0.3, minFontSize: capH * 0.18, maxLines: 1, fontFamily: font, fontWeight: 600 }) : null;
  const capsW = layouts.reduce((acc, l) => acc + l.w, 0) + Math.max(0, layouts.length - 1) * (pc ? plusW : gap);
  const labelW = label ? label.width + capH * 0.4 : 0;
  const countW = countLabel ? countLabel.width + capH * 0.5 + gap : 0;
  return { caps: layouts, plus, plusW, label, countLabel, capsW, labelW, countW, W: capsW + labelW + countW + 2 * pad, H: m.height, metrics: m, pc, times };
}
