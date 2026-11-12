/**
 * Theme edits from the Studio's theme editor (L4.7, R-UI-07; critique B7 and D A1): one value of a theme's template.yaml
 * changed as a splice of its text (map-edits.ts `setMapPath`, the editor of L4.5's scenario field edits), never a
 * re-serialisation — comments, quoting and every byte outside the lines it touches stay. Pure; the engine
 * (templates.edit) checks the hash the page read (if_match), re-parses the result and refuses it unless its value is
 * exactly `intended` (core verifyEditText), validates the theme (parseTemplateYaml, the registry, its files) and writes it
 * under the write lock. MCP never edits a theme.
 *
 * - `set_field`: one path of the allow-list (THEME_FIELD_PATHS) — colours, the background's colours of its own type, the
 *   cursor, brand name / URL, the outro's URL / tagline, style bias, zoom, the logo / wordmark / font files (relative
 *   paths of the theme folder: the engine checks they are real files inside it). Removable only where the theme stays
 *   whole without it (THEME_REMOVABLE_FIELDS). `colors.accent` with `ripple` writes the cursor ripple too (same alpha).
 * - `set_background`: the type with its colours in one write (critique B7a: a solid background without `color` does not
 *   parse, so a type switch is never a sequence of single fields).
 * - `set_component`: a kind's component, its old `params` kept or dropped (`keep` | `drop`: the engine checks kept params
 *   against the new component); a legacy field that now contradicts the entry (`frame.style`, `intro.layout`,
 *   `transitions.between_scenes`… — core legacyContradictions) is removed by the same write and named (critique B7c), so
 *   a copied starter never warns after its first change. A theme's own file (`{video | image | lottie}`) is never
 *   replaced from here.
 * - Every edit applies only while the file holds `from` there (stale otherwise); values are checked and normalised (hex
 *   lower-case, `rgba(r, g, b, a)`) before anything is written; text values take no hidden character, no line break.
 */
import { isDeepStrictEqual } from 'node:util';
import { setMapPath } from './map-edits.js';
import type { SetMapPathOptions } from './map-edits.js';
import { editValueProblem, verifyEditText } from './scenario-edit.js';
import { COMPONENT_ID_RE } from './schemas/primitives.js';
import { StepEditError } from './step-edits.js';
import { legacyContradictions } from './template.js';
import { COMPONENT_KINDS } from './types.js';
import type { ComponentKind } from './types.js';
import { parseYaml } from './validation/yaml-source.js';

/** The only paths `set_field` takes in a theme (each at most two keys deep). */
export const THEME_FIELD_PATHS = [
  'colors.accent',
  'colors.text',
  'colors.muted',
  'colors.paper',
  'colors.dark',
  'background.from',
  'background.to',
  'background.color',
  'cursor.style',
  'cursor.ripple_color',
  'brand.name',
  'brand.url',
  'outro.url',
  'outro.tagline',
  'style_bias',
  'motion.max_zoom',
  'motion.default_zoom',
  'logo',
  'wordmark',
  'fonts.display',
  'fonts.body',
] as const;
export type ThemeField = (typeof THEME_FIELD_PATHS)[number];

/** The fields `set_field` may remove (`to` absent): the theme stays whole without them. */
export const THEME_REMOVABLE_FIELDS: readonly ThemeField[] = ['colors.dark', 'wordmark', 'brand.name', 'brand.url', 'outro.url', 'outro.tagline', 'motion.default_zoom'];

/** A value `set_field` writes: a scalar, or the body font files (a list). */
export type ThemeFieldValue = string | number | string[];

/** What a theme field's value is. */
/** A string naming a resource by a scheme or scheme-relative (the ui preview scan's URL_LIKE). */
const SCHEME_LIKE = /^(?:[a-z][a-z0-9+.-]*:\/\/|\/\/|(?:file|blob|data|javascript|about|filesystem|mailto):)/i;

export type ThemeValueKind = 'color' | 'ripple' | 'cursor' | 'text' | 'url' | 'bias' | 'zoom' | 'default_zoom' | 'image' | 'font' | 'fonts';

export function themeFieldKind(field: ThemeField): ThemeValueKind {
  if (field.startsWith('colors.') || field.startsWith('background.')) return 'color';
  switch (field) {
    case 'cursor.ripple_color':
      return 'ripple';
    case 'cursor.style':
      return 'cursor';
    case 'brand.name':
    case 'outro.tagline':
      return 'text';
    case 'brand.url':
    case 'outro.url':
      return 'url';
    case 'style_bias':
      return 'bias';
    case 'motion.max_zoom':
      return 'zoom';
    case 'motion.default_zoom':
      return 'default_zoom';
    case 'logo':
    case 'wordmark':
      return 'image';
    case 'fonts.display':
      return 'font';
    case 'fonts.body':
      return 'fonts';
  }
  return 'text';
}

/** The edit kinds of `theme_edit` (`restore`: the engine's byte-exact undo / redo of a version it showed or wrote). */
export const THEME_EDIT_KINDS = ['set_field', 'set_background', 'set_component', 'restore'] as const;

export interface ThemeFieldEdit {
  kind: 'set_field';
  field: string;
  /** What the page showed there (absent: not written). */
  from?: ThemeFieldValue;
  /** The new value (absent: removed — only THEME_REMOVABLE_FIELDS). */
  to?: ThemeFieldValue;
  /** With `colors.accent`: the cursor ripple follows (the accent at the ripple's alpha). */
  ripple?: boolean;
}

export type ThemeBackground = { type: 'solid'; color: string } | { type: 'radial' | 'linear'; from: string; to: string };

export interface ThemeBackgroundEdit {
  kind: 'set_background';
  /** The `background` value the page showed (absent: not written). */
  from?: unknown;
  to: ThemeBackground;
}

export interface ThemeComponentEdit {
  kind: 'set_component';
  component: ComponentKind;
  /** The id the page showed for that kind (null: none; absent: not written — the legacy field's or the default). */
  from?: string | null;
  /** The new component, or null (no captions / a cut: caption and transition only). */
  id: string | null;
  /** The old entry's params: kept (checked by the engine against the new component) or dropped. */
  params: 'keep' | 'drop';
}

export type ThemeEdit = ThemeFieldEdit | ThemeBackgroundEdit | ThemeComponentEdit | { kind: 'restore'; text: string; text_hash: string };

export interface ThemeEditApplied {
  text: string;
  /** The value the text must parse to (the edit applied to the parsed file): what the engine verifies. */
  intended: unknown;
  /** "Set the accent colour to #8a2332". */
  label: string;
  /** Legacy fields the same write removed because they contradicted the new component (critique B7c). */
  removed: string[];
  /** set_component: the params carried over to the new component (the engine checks them). */
  kept_params?: Record<string, unknown>;
  /** set_component: the names of the params the edit dropped. */
  dropped_params?: string[];
}

/** The largest template.yaml the Studio edits (characters). */
export const THEME_EDIT_MAX_CHARS = 100_000;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);

const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const RGBA_RE = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*(\d(?:\.\d{1,4})?|\.\d{1,4})\s*)?\)$/;
/** A path inside the theme folder: up to four segments, none hidden, no `..`, no backslash. */
const THEME_PATH_RE = /^(?:[A-Za-z0-9_][A-Za-z0-9._-]{0,99}\/){0,3}[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/;
const IMAGE_EXT_RE = /\.(svg|png|jpe?g|webp)$/i;
const FONT_EXT_RE = /\.(ttf|otf|woff2?)$/i;
const BODY_FONTS_MAX = 4;
const ZOOM_STEP = 0.01;

const LABELS: Record<ThemeField, string> = {
  'colors.accent': 'the accent colour',
  'colors.text': 'the text colour',
  'colors.muted': 'the muted colour',
  'colors.paper': 'the paper colour',
  'colors.dark': 'the dark colour',
  'background.from': "the background's first colour",
  'background.to': "the background's second colour",
  'background.color': 'the background colour',
  'cursor.style': 'the cursor style',
  'cursor.ripple_color': 'the cursor ripple colour',
  'brand.name': 'the brand name',
  'brand.url': 'the brand URL',
  'outro.url': "the outro's URL",
  'outro.tagline': "the outro's tagline",
  style_bias: 'the motion bias',
  'motion.max_zoom': 'the maximum zoom',
  'motion.default_zoom': 'the default zoom',
  logo: 'the logo',
  wordmark: 'the wordmark',
  'fonts.display': 'the display font',
  'fonts.body': 'the body fonts',
};

const BY_HAND = 'edit template.yaml by hand';

function isThemeField(field: unknown): field is ThemeField {
  return typeof field === 'string' && (THEME_FIELD_PATHS as readonly string[]).includes(field);
}

/** A hex colour lower-cased, or undefined when `v` is not `#rgb` / `#rrggbb`. */
function hexOf(v: unknown): string | undefined {
  return typeof v === 'string' && HEX_RE.test(v) ? v.toLowerCase() : undefined;
}

/** `rgba(r, g, b, a)` normalised (or a hex lower-cased), or undefined. */
function rippleOf(v: unknown): string | undefined {
  const hex = hexOf(v);
  if (hex) return hex;
  if (typeof v !== 'string') return undefined;
  const m = RGBA_RE.exec(v);
  if (!m) return undefined;
  const [r, g, b] = [m[1], m[2], m[3]].map(Number);
  if (r > 255 || g > 255 || b > 255) return undefined;
  const a = m[4] === undefined ? 1 : Number(m[4]);
  if (!(a >= 0 && a <= 1)) return undefined;
  return `rgba(${r}, ${g}, ${b}, ${Number(a.toFixed(4))})`;
}

/** The r, g, b of a hex colour. */
function rgbOf(hex: string): [number, number, number] {
  const h = hex.slice(1);
  const full = h.length === 3 ? [...h].map((c) => c + c).join('') : h;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)) as [number, number, number];
}

/** The cursor ripple that follows an accent: the accent at the current ripple's alpha (0.45 when it has none). */
export function rippleForAccent(accent: string, currentRipple: unknown): string {
  const m = typeof currentRipple === 'string' ? RGBA_RE.exec(currentRipple) : null;
  const alpha = m?.[4] !== undefined && Number(m[4]) >= 0 && Number(m[4]) <= 1 ? Number(Number(m[4]).toFixed(4)) : 0.45;
  const [r, g, b] = rgbOf(accent);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

const onZoomStep = (n: number) => Math.abs(n / ZOOM_STEP - Math.round(n / ZOOM_STEP)) < 1e-6;

/** Why `to` is not a value of `field`, or null (values are normalised by themeFieldValue after this). */
export function themeValueProblem(field: ThemeField, to: unknown): string | null {
  const kind = themeFieldKind(field);
  const name = field;
  switch (kind) {
    case 'color':
      return hexOf(to) ? null : `${name} takes a hex colour (#rgb or #rrggbb)`;
    case 'ripple':
      return rippleOf(to) ? null : `${name} takes a hex colour or rgba(r, g, b, a) with numbers only`;
    case 'cursor':
      return to === 'arrow-dark' || to === 'arrow-light' ? null : `${name} takes arrow-dark or arrow-light`;
    case 'bias':
      return to === 'real' || to === 'balanced' || to === 'motion' ? null : `${name} takes real, balanced or motion`;
    case 'zoom':
    case 'default_zoom': {
      if (kind === 'default_zoom' && to === 'none') return null;
      if (typeof to !== 'number' || !Number.isFinite(to) || to < 1 || to > 3 || !onZoomStep(to)) {
        return `${name} takes ${kind === 'default_zoom' ? 'none or ' : ''}a number from 1 to 3 in steps of 0.01`;
      }
      return null;
    }
    case 'text':
    case 'url': {
      if (typeof to !== 'string') return `${name} takes text`;
      const max = field === 'brand.name' ? 80 : field === 'outro.tagline' ? 120 : 200;
      if (to.trim() === '' || to !== to.trim()) return `${name} takes text without leading or trailing spaces (not empty)`;
      if (to.length > max) return `${name}: at most ${max} characters (${to.length})`;
      const hidden = editValueProblem(to, { field: name });
      if (hidden) return hidden;
      if (kind === 'url' && /[\s<>"'`\\]/.test(to)) return `${name} takes an address as shown (example.com/path): no space, quote, angle bracket or backslash`;
      // Shown as typed, never opened: no scheme and no `//` (the Studio's preview scan refuses such a string as a URL it
      // does not serve — L4.7 review A M2).
      if (kind === 'url' && SCHEME_LIKE.test(to)) return `${name} takes an address as shown (example.com/path): no scheme (https://) and no leading //`;
      return null;
    }
    case 'image':
    case 'font': {
      const ext = kind === 'image' ? IMAGE_EXT_RE : FONT_EXT_RE;
      if (typeof to !== 'string' || !THEME_PATH_RE.test(to) || !ext.test(to)) {
        return `${name} takes a file of the theme folder (a relative path, no hidden folder, ending in ${kind === 'image' ? '.svg, .png, .jpg or .webp' : '.ttf, .otf, .woff or .woff2'})`;
      }
      return null;
    }
    case 'fonts': {
      if (!Array.isArray(to) || to.length < 1 || to.length > BODY_FONTS_MAX) return `${name} takes 1 to ${BODY_FONTS_MAX} font files of the theme folder`;
      for (const f of to) {
        const p = themeValueProblem('fonts.display', f);
        if (p) return p.replace('fonts.display', name);
      }
      if (new Set(to).size !== to.length) return `${name} names a font file twice`;
      return null;
    }
  }
}

/** The value written for `to` (hex lower-case, rgba normalised; others as given). */
function themeFieldValue(field: ThemeField, to: ThemeFieldValue): ThemeFieldValue {
  const kind = themeFieldKind(field);
  if (kind === 'color') return hexOf(to)!;
  if (kind === 'ripple') return rippleOf(to)!;
  if (kind === 'fonts') return [...(to as string[])];
  return to;
}

const sayValue = (v: ThemeFieldValue | undefined): string => (v === undefined ? 'nothing' : Array.isArray(v) ? v.join(', ') : String(v));

function getAt(v: unknown, path: readonly string[]): unknown {
  let cur = v;
  for (const k of path) cur = isObj(cur) ? cur[k] : undefined;
  return cur;
}

/** The splice options of a theme: new top-level keys before `components:`, block maps with comments never rewritten. */
const spliceOptions = (what: string): SetMapPathOptions => ({ insertBefore: 'components', keepComments: true, what, byHand: BY_HAND });

/** A StepEditError's wording for a theme (the scenario editor's "YAML view" is template.yaml by hand here). */
function themeWords<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof StepEditError) throw new StepEditError(e.code, e.message.replace(/(?:change|edit|make) it in the YAML view|in the YAML view/g, BY_HAND), e.field);
    throw e;
  }
}

/** The parsed root map of a theme's text, or a not_editable refusal. */
function rootOf(text: string): Obj {
  const parsed = parseYaml(text);
  if (parsed.value === undefined || parsed.issues.some((i) => i.severity === 'error')) throw new StepEditError('not_editable', `template.yaml is not valid YAML: ${BY_HAND} first`);
  if (!isObj(parsed.value)) throw new StepEditError('not_editable', `template.yaml is not a map of settings: ${BY_HAND}`);
  return parsed.value;
}

/** The section map of a two-key path, refused when written as something else (`colors: x`). */
function sectionOf(root: Obj, section: string, what: string): Obj | undefined {
  const s = root[section];
  if (s === undefined || s === null) return undefined;
  if (!isObj(s)) throw new StepEditError('not_editable', `${what}: \`${section}\` is not written as a map: ${BY_HAND}`);
  return s;
}

function applyField(text: string, root: Obj, edit: ThemeFieldEdit): ThemeEditApplied {
  if (!isThemeField(edit.field)) {
    throw new StepEditError('invalid', `${String(edit.field).slice(0, 60)} is not a value the theme editor sets (it sets ${THEME_FIELD_PATHS.join(', ')}): ${BY_HAND}`);
  }
  const field = edit.field;
  const what = LABELS[field];
  if (edit.to === undefined && !THEME_REMOVABLE_FIELDS.includes(field)) throw new StepEditError('invalid', `${what} cannot be removed: set another value`, field);
  if (edit.to !== undefined) {
    const p = themeValueProblem(field, edit.to);
    if (p) throw new StepEditError('invalid', p, field);
  }
  if (edit.ripple !== undefined && (field !== 'colors.accent' || edit.to === undefined || typeof edit.ripple !== 'boolean')) {
    throw new StepEditError('invalid', 'ripple goes only with a new colors.accent', field);
  }
  const to = edit.to === undefined ? undefined : themeFieldValue(field, edit.to);
  const segs = field.split('.');
  if (segs.length === 2) sectionOf(root, segs[0], what);
  const raw = getAt(root, segs);
  const current = raw === null ? undefined : raw;
  const readable =
    current === undefined || typeof current === 'string' || typeof current === 'number' || (field === 'fonts.body' && Array.isArray(current) && current.every((x) => typeof x === 'string'));
  if (!readable) throw new StepEditError('not_editable', `${what} is written as ${Array.isArray(current) ? 'a list' : typeof current === 'boolean' ? 'true / false' : 'a map'}: ${BY_HAND}`, field);
  if (!isDeepStrictEqual(current, edit.from)) {
    throw new StepEditError('stale', `${what} changed meanwhile (it is now ${current === undefined ? 'not set' : JSON.stringify(current)}): read the theme again`, field);
  }
  if (segs[0] === 'background') {
    // Critique B7a: each type has its own colours — another type is switched with set_background (type and colours at once).
    const bg = sectionOf(root, 'background', what);
    const type = typeof bg?.type === 'string' ? bg.type : 'radial';
    const own = type === 'solid' ? ['color'] : ['from', 'to'];
    if (!own.includes(segs[1])) throw new StepEditError('invalid', `the background is ${type}: it has no ${segs[1]} — switch its type and colours together (set_background)`, field);
  }
  const rippleNow = edit.ripple === true ? rippleForAccent(to as string, getAt(root, ['cursor', 'ripple_color'])) : undefined;
  if (isDeepStrictEqual(current, to) && (rippleNow === undefined || rippleNow === getAt(root, ['cursor', 'ripple_color']))) {
    throw new StepEditError('invalid', `nothing to change: ${what} is already ${sayValue(to)}`, field);
  }
  let r = { text, intended: root as Obj };
  if (!isDeepStrictEqual(current, to)) r = themeWords(() => setMapPath(text, root, segs, to, spliceOptions(what)));
  let rippleLabel = '';
  if (rippleNow !== undefined && rippleNow !== getAt(r.intended, ['cursor', 'ripple_color'])) {
    const prev = r;
    sectionOf(prev.intended, 'cursor', LABELS['cursor.ripple_color']);
    r = themeWords(() => setMapPath(prev.text, prev.intended, ['cursor', 'ripple_color'], rippleNow, spliceOptions(LABELS['cursor.ripple_color'])));
    rippleLabel = `, the cursor ripple following (${rippleNow})`;
  }
  const label = to === undefined ? `Removed ${what}` : `Set ${what} to ${sayValue(to)}${rippleLabel}`;
  return { text: r.text, intended: r.intended, label: label[0].toUpperCase() + label.slice(1), removed: [] };
}

function backgroundProblem(to: unknown): string | null {
  if (!isObj(to)) return 'set_background takes {type: solid, color} or {type: radial | linear, from, to}';
  const keys = Object.keys(to).sort().join(',');
  if (to.type === 'solid') {
    if (keys !== 'color,type') return 'a solid background takes type and color only';
    return hexOf(to.color) ? null : 'the background colour takes a hex colour (#rgb or #rrggbb)';
  }
  if (to.type === 'radial' || to.type === 'linear') {
    if (keys !== 'from,to,type') return `a ${to.type} background takes type, from and to only`;
    return hexOf(to.from) && hexOf(to.to) ? null : "the background's colours take hex colours (#rgb or #rrggbb)";
  }
  return 'the background type is solid, radial or linear';
}

function applyBackground(text: string, root: Obj, edit: ThemeBackgroundEdit): ThemeEditApplied {
  const what = 'the background';
  const p = backgroundProblem(edit.to);
  if (p) throw new StepEditError('invalid', p, 'background');
  const to: ThemeBackground = edit.to.type === 'solid' ? { type: 'solid', color: hexOf(edit.to.color)! } : { type: edit.to.type, from: hexOf(edit.to.from)!, to: hexOf(edit.to.to)! };
  const raw = root.background;
  const current = raw === null ? undefined : raw;
  if (current !== undefined && !isObj(current)) throw new StepEditError('not_editable', `${what} is not written as a map: ${BY_HAND}`, 'background');
  if (!isDeepStrictEqual(current, edit.from)) {
    throw new StepEditError('stale', `${what} changed meanwhile (it is now ${current === undefined ? 'not set' : JSON.stringify(current)}): read the theme again`, 'background');
  }
  if (isDeepStrictEqual(current, to)) throw new StepEditError('invalid', `nothing to change: ${what} is already that`, 'background');
  const r = themeWords(() => setMapPath(text, root, ['background'], to, spliceOptions(what)));
  const label = to.type === 'solid' ? `Set the background to solid ${to.color}` : `Set the background to ${to.type} ${to.from} → ${to.to}`;
  return { text: r.text, intended: r.intended, label, removed: [] };
}

/** The words of a kind's component ("the layout component", "the caption component"). */
const kindWords = (k: ComponentKind) => `the ${k} component`;

function applyComponent(text: string, root: Obj, edit: ThemeComponentEdit): ThemeEditApplied {
  const kind = edit.component;
  if (!(COMPONENT_KINDS as readonly string[]).includes(kind)) throw new StepEditError('invalid', `component is one of ${COMPONENT_KINDS.join(', ')}`);
  const what = kindWords(kind);
  if (edit.params !== 'keep' && edit.params !== 'drop') throw new StepEditError('invalid', 'params is keep or drop', kind);
  if (edit.id === null) {
    if (kind !== 'caption' && kind !== 'transition') throw new StepEditError('invalid', `${what} cannot be none here (only captions and transitions can: no captions, a cut)`, kind);
  } else if (typeof edit.id !== 'string' || !COMPONENT_ID_RE.test(edit.id)) {
    throw new StepEditError('invalid', `${what} takes a component "namespace/name"`, kind);
  }
  const comps = sectionOf(root, 'components', what);
  const cur = comps?.[kind];
  let curId: string | null | undefined;
  let curParams: Obj | undefined;
  if (cur === undefined) curId = undefined;
  else if (cur === null) curId = null;
  else if (typeof cur === 'string') curId = cur;
  else if (isObj(cur) && typeof cur.id === 'string' && Object.keys(cur).every((k) => k === 'id' || k === 'params') && (cur.params === undefined || isObj(cur.params))) {
    curId = cur.id;
    curParams = cur.params as Obj | undefined;
  } else if (isObj(cur) && !('id' in cur)) {
    throw new StepEditError('not_editable', `${what} is the theme's own file (a video, image or Lottie): it is not replaced from here — ${BY_HAND}`, kind);
  } else {
    throw new StepEditError('not_editable', `${what} is written in a form the editor does not change: ${BY_HAND}`, kind);
  }
  if (curId !== edit.from) {
    throw new StepEditError('stale', `${what} changed meanwhile (it is now ${curId === undefined ? 'not set' : curId === null ? 'none' : curId}): read the theme again`, kind);
  }
  const params = curParams && Object.keys(curParams).length ? curParams : undefined;
  const keep = edit.params === 'keep' && params !== undefined && edit.id !== null;
  const value: unknown = edit.id === null ? null : keep ? { id: edit.id, params: structuredClone(params) } : edit.id;
  if (isDeepStrictEqual(cur, value)) throw new StepEditError('invalid', `nothing to change: ${what} is already ${edit.id ?? 'none'}`, kind);
  let r = themeWords(() => setMapPath(text, root, ['components', kind], value, spliceOptions(what)));
  // Critique B7c: a legacy field this entry now contradicts goes in the same write (named; undo restores it).
  const removed: string[] = [];
  for (const c of legacyContradictions(r.intended).filter((x) => x.kind === kind)) {
    for (const f of c.written) {
      const prev = r;
      r = themeWords(() => setMapPath(prev.text, prev.intended, f.split('.'), undefined, spliceOptions(`the legacy field ${f}`)));
      removed.push(f);
    }
  }
  const none = kind === 'caption' ? 'none (no captions)' : 'none (a cut)';
  let label = `Set ${what} to ${edit.id ?? none}`;
  if (keep) label += ' (its params kept)';
  else if (params && edit.id !== null) label += ` (params ${Object.keys(params).slice(0, 8).join(', ')} dropped)`;
  if (removed.length) label += `; removed ${removed.join(', ')} (they contradicted it)`;
  return {
    text: r.text,
    intended: r.intended,
    label: label[0].toUpperCase() + label.slice(1),
    removed,
    ...(keep ? { kept_params: structuredClone(params) } : {}),
    ...(!keep && params && edit.id !== null ? { dropped_params: Object.keys(params) } : {}),
  };
}

/**
 * One theme edit applied to template.yaml's text (see the header): the new text, the value it must parse to, the label
 * and the legacy fields removed. Throws StepEditError (`stale`: the value changed since the page read it;
 * `not_editable`: written in a form this editor does not change — by hand; `invalid`). `restore` is the engine's.
 */
export function applyThemeEdit(text: string, edit: Exclude<ThemeEdit, { kind: 'restore' }>): ThemeEditApplied {
  if (typeof text !== 'string' || text.length > THEME_EDIT_MAX_CHARS)
    throw new StepEditError('not_editable', `template.yaml holds more than ${THEME_EDIT_MAX_CHARS.toLocaleString('en')} characters: ${BY_HAND}`);
  const root = rootOf(text);
  let out: ThemeEditApplied;
  switch (edit?.kind) {
    case 'set_field':
      out = applyField(text, root, edit);
      break;
    case 'set_background':
      out = applyBackground(text, root, edit);
      break;
    case 'set_component':
      out = applyComponent(text, root, edit);
      break;
    default:
      throw new StepEditError('invalid', `unknown theme edit kind "${String((edit as { kind?: unknown } | undefined)?.kind).slice(0, 40)}"`);
  }
  // The splices verified every step; the whole edit is checked once more against its final value.
  const wrong = verifyEditText(out.text, out.intended);
  if (wrong) throw new StepEditError('not_editable', `${wrong.replace(/change it in the YAML view/, BY_HAND)}`);
  return out;
}
