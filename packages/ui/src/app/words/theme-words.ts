/**
 * The theme screens' pure rules (L4.7 part D2, R-UI-07 / R-DEC-04): the edit each control sends through `theme_edit`
 * (never anything else writes a theme: the server splices template.yaml, verifies it and keeps its comments), the
 * compound edits (critique B7: the background's type with its colours in one write, a kind's component with its old
 * params kept or dropped), the values a control may offer (the theme's own font and image files, the components that
 * serve a kind, zoom in steps of 0.01), undo / redo of exact earlier bytes (critique B14: only versions the server
 * served — the view's text before a write and after it), the draft throttle (colours being dragged: at most five
 * previews a second, written on release), "Use in this scenario" (the scenario's `template` field through
 * scenario_edit, critique B1), the site panel's "New theme from this" and which events re-read what.
 *
 * Nothing here builds YAML or HTML. Names that reach a prompt or an address are checked against their patterns
 * (library-words.ts); every other string from the server is shown through `Txt`.
 */
import type { ThemeEditView } from '@retake/engine';
import type { ThemeCreateInput, ThemeEditInput } from '../data/themes.js';
import type { SiteListAnswer, ThemeListAnswer } from '../../server/theme-ops.js';
import { visibleControls } from '../bits.js';
import type { StudioEvent } from '../events.js';
import { NEW_THEME_NAME, okNewThemeName } from '../id-words.js';
import { KIND_ORDER, KIND_WORDS, NEW_THEME_TOO_LONG, isKind, okId, okTheme } from './library-words.js';
import type { Kind } from './library-words.js';

/** core HEX_COLOR_RE (mirrored: the app imports no runtime code from core; a test pins them equal). */
export const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
export const okHex = (v: unknown): v is string => typeof v === 'string' && HEX_RE.test(v);

/** A hex colour as a colour input takes it (`#rrggbb`, lower-case), or null. */
export function pickerHex(v: unknown): string | null {
  if (!okHex(v)) return null;
  const h = v.toLowerCase();
  return h.length === 4 ? `#${h[1]}${h[1]}${h[2]}${h[2]}${h[3]}${h[3]}` : h;
}

/**
 * L5.12c: what a colour input shows — the hex as `#rrggbb`, else white (a colour input always holds a value; the kit's
 * ColorField draws the well hatched while nothing is written). Theme data: the kit holds no colour of its own.
 */
export const pickerValue = (v: unknown): string => pickerHex(v) ?? '#ffffff';

/** L5.12c: a theme's sample accent for the UI gallery's colour field (the gallery holds no colour literal). */
export const SAMPLE_ACCENT = '#8c1d2c';

/** Previews of colours being dragged: at most one per this many milliseconds (five a second). */
export const DRAFT_INTERVAL_MS = 200;

/** Zoom bounds and step (core theme-edits: 1–3 in steps of 0.01). */
export const ZOOM_MIN = 1;
export const ZOOM_MAX = 3;
export const ZOOM_STEP = 0.01;

/** Longest text of a text field (core theme-edits' caps). */
export const TEXT_MAX: Record<string, number> = { 'brand.name': 80, 'outro.tagline': 120, 'brand.url': 200, 'outro.url': 200 };

/** The fields `set_field` may remove (core THEME_REMOVABLE_FIELDS, mirrored; pinned by a test). */
export const REMOVABLE = ['colors.dark', 'wordmark', 'brand.name', 'brand.url', 'outro.url', 'outro.tagline', 'motion.default_zoom'] as const;
export const isRemovable = (f: string): boolean => (REMOVABLE as readonly string[]).includes(f);

export type ColorKey = 'accent' | 'text' | 'muted' | 'paper' | 'dark';

/** The colour fields, in the editor's order, with what each colours. */
export const COLOR_FIELDS: ReadonlyArray<{ key: ColorKey; field: string; label: string; hint: string }> = [
  { key: 'accent', field: 'colors.accent', label: 'Accent', hint: 'kicker, rules, clock hand, cursor ripple' },
  { key: 'text', field: 'colors.text', label: 'Text', hint: 'titles and caption lines' },
  { key: 'muted', field: 'colors.muted', label: 'Muted', hint: 'taglines, the URL' },
  { key: 'paper', field: 'colors.paper', label: 'Paper', hint: 'cards; text on dark screens' },
  { key: 'dark', field: 'colors.dark', label: 'Dark', hint: 'dark cards and waiting screens (optional)' },
];

/** The words of a palette check (components PALETTE_THRESHOLDS' names). */
export const CHECK_WORDS: Record<string, string> = {
  text_on_paper: 'Text on paper',
  text_on_background: 'Text on the background',
  muted_on_paper: 'Muted on paper',
  light_on_dark: 'Paper on dark',
  accent_on_paper: 'Accent on paper',
  accent_on_dark: 'Accent on dark',
};

/** theme_edit's edits as the page sends them (the server pins each shape). */
export type FieldValue = string | number | string[];
/** An edit of a theme (theme_edit's `edit`: its input, as the page sends it). */
export type ThemeEdit = ThemeEditInput;
export type SetFieldEdit = Extract<ThemeEdit, { kind: 'set_field' }>;
export type Background = SetBackgroundEdit['to'];
export type SetBackgroundEdit = Extract<ThemeEdit, { kind: 'set_background' }>;
export type SetComponentEdit = Extract<ThemeEdit, { kind: 'set_component' }>;
export type RestoreEdit = Extract<ThemeEdit, { kind: 'restore' }>;

/** A field's value as written (absent: undefined). */
export function written(view: Pick<ThemeEditView, 'fields'>, field: string): FieldValue | undefined {
  const v = (view.fields as Record<string, unknown>)[field];
  if (typeof v === 'string' || typeof v === 'number') return v;
  if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v as string[];
  return undefined;
}

const same = (a: FieldValue | undefined, b: FieldValue | undefined): boolean => (Array.isArray(a) && Array.isArray(b) ? a.length === b.length && a.every((x, i) => x === b[i]) : a === b);

/**
 * The `set_field` a control sends: `from` what the editor showed there (absent when not written — a value changed
 * meanwhile is refused as stale, never overwritten), `to` the new value (absent: removed — removable fields only).
 * Null when nothing changes, or a value the field cannot take is asked (`why`).
 */
export function fieldEdit(view: Pick<ThemeEditView, 'fields' | 'editable'>, field: string, to: FieldValue | undefined, o: { ripple?: boolean } = {}): { edit: SetFieldEdit } | { why: string } | null {
  if (view.editable !== true) return { why: view.editable.why };
  const from = written(view, field);
  if (to === undefined && !isRemovable(field)) return { why: 'this value cannot be removed: give another one' };
  if (same(from, to)) return null;
  if (typeof to === 'string' && field.startsWith('colors.') && !okHex(to)) return { why: 'a colour is a hex value: #rgb or #rrggbb' };
  if (typeof to === 'number' && zoomProblem(to)) return { why: zoomProblem(to)! };
  if (typeof to === 'string' && field in TEXT_MAX) {
    const p = textProblem(field, to);
    if (p) return { why: p };
  }
  // The editor's fields are theme_view's (core THEME_FIELD_PATHS; the view types them as strings): the server checks it.
  return { edit: { kind: 'set_field', field: field as SetFieldEdit['field'], ...(from !== undefined ? { from } : {}), ...(to !== undefined ? { to } : {}), ...(o.ripple ? { ripple: true } : {}) } };
}

/** Why a zoom value cannot be written (null: it can). */
export function zoomProblem(n: number): string | null {
  if (!Number.isFinite(n) || n < ZOOM_MIN || n > ZOOM_MAX) return `a zoom from ${ZOOM_MIN} to ${ZOOM_MAX}`;
  if (Math.abs(n / ZOOM_STEP - Math.round(n / ZOOM_STEP)) > 1e-6) return 'a zoom in steps of 0.01';
  return null;
}

/** Why a text value cannot be written (null: it can): one line, no control or direction character, within its cap. */
export function textProblem(field: string, v: string): string | null {
  const max = TEXT_MAX[field] ?? 200;
  if (v.length > max) return `at most ${max} characters`;
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(v)) return 'one line, no control character';
  if (/[\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/.test(v)) return 'no invisible or direction character';
  if (v.trim() === '') return 'give a value (or remove it)';
  return null;
}

/** The background as the editor shows it: its type and colours (editable as a map), or why it is not. */
export function backgroundOf(view: Pick<ThemeEditView, 'background'>): { value: Background | null; why?: string } {
  const b = view.background as Record<string, unknown> | string | undefined | null;
  if (b === undefined || b === null) return { value: null };
  if (typeof b !== 'object' || Array.isArray(b)) return { value: null, why: 'the background is written as one value, not a map: edit template.yaml by hand' };
  if (b.type === 'solid' && okHex(b.color)) return { value: { type: 'solid', color: (b.color as string).toLowerCase() } };
  if ((b.type === 'radial' || b.type === 'linear') && okHex(b.from) && okHex(b.to)) return { value: { type: b.type, from: (b.from as string).toLowerCase(), to: (b.to as string).toLowerCase() } };
  return { value: null, why: 'the background is written in a form the editor does not change: edit template.yaml by hand' };
}

/**
 * The background a type switch writes (critique B7a: type and colours in one write): solid keeps the first colour,
 * a gradient goes from the solid colour (or the old gradient's) to the paper.
 */
export function switchedBackground(cur: Background | null, type: Background['type'], paper: string): Background {
  const first = cur ? (cur.type === 'solid' ? cur.color : cur.from) : paper;
  const second = cur && cur.type !== 'solid' ? cur.to : paper;
  return type === 'solid' ? { type: 'solid', color: first } : { type, from: first, to: second };
}

/** The `set_background` for a new background (`from` what the editor showed; refused when it is not a map). */
export function backgroundEdit(view: Pick<ThemeEditView, 'background' | 'editable'>, to: Background): { edit: SetBackgroundEdit } | { why: string } | null {
  if (view.editable !== true) return { why: view.editable.why };
  const b = backgroundOf(view);
  if (b.why) return { why: b.why };
  if (b.value && JSON.stringify(b.value) === JSON.stringify(to)) return null;
  if (!okHex(to.type === 'solid' ? to.color : to.from) || (to.type !== 'solid' && !okHex(to.to))) return { why: 'a colour is a hex value: #rgb or #rrggbb' };
  const from = view.background as Record<string, string | number> | undefined;
  return { edit: { kind: 'set_background', ...(from !== undefined ? { from } : {}), to } };
}

/** A kind's component in words ("Intro", "Transition"). */
export const kindLabel = (k: string): string => (isKind(k) ? KIND_WORDS[k][0] : k);

/** The words of "no component" for the kinds that can have none. */
export const NONE_WORDS: Partial<Record<Kind, string>> = { caption: 'No captions', transition: 'A cut (no transition)' };

/** The components a theme may pick for a kind (its own kind or one it can serve), in the registry's order. */
export function componentChoices(components: ThemeListAnswer['components'], kind: Kind): string[] {
  return components.filter((c) => okId(c.id) && (c.kind === kind || (c.kinds ?? []).includes(kind))).map((c) => c.id);
}

/**
 * The words of a component `<option>`: a listed choice as it is (a checked id); a written id that is not one is the
 * file's words — its direction controls made visible and "(as written)": an option holds no `<bdi>` (review A N3).
 */
export function componentOptionWords(id: string, choices: readonly string[]): string {
  return choices.includes(id) ? id : `${visibleControls(id)} (as written)`;
}

/** How the editor shows a kind's entry: what is picked, whether params are written, or why it cannot be changed here. */
export function componentRow(view: Pick<ThemeEditView, 'components'>, kind: Kind): { picked: string | null; params: string[]; why?: string } {
  const c = (view.components as Partial<ThemeEditView['components']>)[kind];
  if (!c) return { picked: null, params: [], why: `the theme has no ${kind} entry the editor can read` };
  if (c.written === 'file') return { picked: null, params: [], why: `the theme's ${kind} is its own video, image or Lottie file: replace it in template.yaml by hand` };
  if (c.written === 'other') return { picked: null, params: [], why: `the theme's ${kind} is written in a form the editor does not change: edit template.yaml by hand` };
  return { picked: c.written === 'none' ? null : (c.resolved?.id ?? c.id ?? null), params: c.params ? Object.keys(c.params) : [] };
}

/**
 * The `set_component` a pick sends (critique B7b): `from` what the view shows written there (absent → omitted, none →
 * null, an id → it), the new id or null (captions / transitions only), the old entry's params kept (the server checks
 * them against the new component) or dropped. Null when nothing changes.
 */
export function componentEdit(view: Pick<ThemeEditView, 'components' | 'editable'>, kind: Kind, id: string | null, params: 'keep' | 'drop'): { edit: SetComponentEdit } | { why: string } | null {
  if (view.editable !== true) return { why: view.editable.why };
  if (id !== null && !okId(id)) return { why: 'not a component id' };
  if (id === null && !NONE_WORDS[kind]) return { why: `a theme always has a ${kind}` };
  const row = componentRow(view, kind);
  if (row.why) return { why: row.why };
  const c = view.components[kind];
  if (row.picked === id && c.written !== 'absent') return null;
  const from = c.written === 'absent' ? undefined : c.written === 'none' ? null : (c.id ?? undefined);
  return { edit: { kind: 'set_component', component: kind, ...(from !== undefined ? { from } : {}), id, params } };
}

/** The image files a logo / wordmark may be (the theme folder's own, checked; listed by name — never shown, B9). */
export function imageChoices(view: Pick<ThemeEditView, 'images'>): string[] {
  return view.images.filter((i) => !i.problem).map((i) => i.file);
}

/** The font files of the type pair (the theme folder's own, checked: critique Q4), with their weight in words. */
export function fontChoices(view: Pick<ThemeEditView, 'fonts'>): Array<{ file: string; words: string }> {
  return view.fonts.filter((f) => !f.problem).map((f) => ({ file: f.file, words: `${f.weight ?? '?'}${f.italic ? ' italic' : ''}` }));
}

/** The body files after one is ticked or unticked (1 to 4, in the theme folder's order), or why not. */
export function bodyFonts(current: readonly string[], file: string, on: boolean, order: readonly string[]): string[] | { why: string } {
  const set = new Set(current);
  if (on) set.add(file);
  else set.delete(file);
  const next = order.filter((f) => set.has(f));
  for (const f of current) if (set.has(f) && !next.includes(f)) next.push(f);
  if (next.length === 0) return { why: 'the body needs at least one font file' };
  if (next.length > 4) return { why: 'at most four body font files (one per weight or style)' };
  return next;
}

/** The palette checks in words (the server's, after each write). */
export function paletteRows(view: Pick<ThemeEditView, 'palette'>): Array<{ check: string; words: string; ratio: number; min: number; ok: boolean }> {
  return (view.palette?.checks ?? []).map((c) => ({ check: c.check, words: CHECK_WORDS[c.check] ?? c.check, ratio: c.ratio, min: c.min, ok: c.ok }));
}

/** One version of template.yaml the server served (its bytes and sha256). */
export interface Version {
  text: string;
  sha256: string;
}

/** The step undo or redo sends: theme_edit `restore` of a served version, on the version now shown. */
export interface HistoryStep {
  if_match: string;
  edit: RestoreEdit;
  label: string;
}

const HISTORY_MAX = 50;

/**
 * Undo / redo of a theme's writes (critique B14): each entry holds the bytes before and after one write, both versions
 * the server served (the view before the write; the view read again after it) — restore sends those bytes and their
 * sha256, never text the page made. The file changing under the editor (another window, Claude, a person) clears it.
 */
export class ThemeHistory {
  private entries: Array<{ label: string; before: Version; after: Version }> = [];
  private at = 0;

  /** A write the editor made, once its new version was read back. */
  push(label: string, before: Version, after: Version): void {
    this.entries = this.entries.slice(0, this.at);
    this.entries.push({ label, before, after });
    if (this.entries.length > HISTORY_MAX) this.entries.shift();
    this.at = this.entries.length;
  }

  /** The sha256 the file should have now (null: no history). */
  expected(): string | null {
    if (this.entries.length === 0) return null;
    return this.at > 0 ? this.entries[this.at - 1].after.sha256 : this.entries[0].before.sha256;
  }

  /** The view read again: another version than the history's (someone else wrote) clears it. */
  sync(sha256: string): void {
    const e = this.expected();
    if (e !== null && e !== sha256) this.clear();
  }

  clear(): void {
    this.entries = [];
    this.at = 0;
  }

  undoStep(): HistoryStep | null {
    const e = this.entries[this.at - 1];
    return e ? { if_match: e.after.sha256, edit: { kind: 'restore', text: e.before.text, text_hash: e.before.sha256 }, label: e.label } : null;
  }

  redoStep(): HistoryStep | null {
    const e = this.entries[this.at];
    return e ? { if_match: e.before.sha256, edit: { kind: 'restore', text: e.after.text, text_hash: e.after.sha256 }, label: e.label } : null;
  }

  undone(): void {
    if (this.at > 0) this.at--;
  }

  redone(): void {
    if (this.at < this.entries.length) this.at++;
  }
}

/**
 * Colours being dragged (an `input` event per move): the latest value is previewed at most once per interval — the
 * first at once, then one per interval with the newest value (a trailing send: the last move is always previewed).
 * The write happens on release (the input's `change`), not here.
 */
export class DraftThrottle<T> {
  private last = -Infinity;
  private timer: unknown = null;
  private pending: T | undefined;
  private readonly interval: number;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (t: unknown) => void;

  constructor(
    private readonly send: (draft: T) => void,
    o: { intervalMs?: number; now?: () => number; setTimer?: (fn: () => void, ms: number) => unknown; clearTimer?: (t: unknown) => void } = {},
  ) {
    this.interval = o.intervalMs ?? DRAFT_INTERVAL_MS;
    this.now = o.now ?? (() => Date.now());
    this.setTimer = o.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = o.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  }

  push(draft: T): void {
    this.pending = draft;
    if (this.timer !== null) return;
    const wait = this.last + this.interval - this.now();
    if (wait <= 0) this.flush();
    else
      this.timer = this.setTimer(() => {
        this.timer = null;
        this.flush();
      }, wait);
  }

  /** Drop what is waiting (the value was written, the editor left). */
  cancel(): void {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    this.pending = undefined;
  }

  private flush(): void {
    if (this.pending === undefined) return;
    const d = this.pending;
    this.pending = undefined;
    this.last = this.now();
    this.send(d);
  }
}

/** What the live frame shows. */
export type PreviewTarget = 'intro' | 'clip' | 'outro';
export const TARGET_WORDS: Record<PreviewTarget, string> = { intro: 'Intro', clip: 'Clip with caption', outro: 'Outro' };

/** The theme list's badges, in words. */
export const SOURCE_BADGE: Record<ThemeListAnswer['themes'][number]['source'], string> = { workspace: 'Workspace', starter: 'Starter', project: 'Project folder' };

/** Whether a theme of the list opens in the editor (a listed name; the project's own folder theme is edited by hand). */
export const opensInEditor = (t: Pick<ThemeListAnswer['themes'][number], 'name' | 'source'>): boolean => t.source !== 'project' && okTheme(t.name);
/** Whether "Copy to edit" is offered: a listed theme the Studio does not edit (a starter, a theme of the package…). */
export const offersCopy = (t: Pick<ThemeListAnswer['themes'][number], 'name' | 'source' | 'editable'>): boolean => t.editable !== true && opensInEditor(t);

/** "used by the project, 2 scenarios" — what a change re-renders. */
export function usedByWords(u: ThemeEditView['used_by'], slug: string): string {
  const parts: string[] = [];
  const here = u.projects.includes(slug);
  const others = u.projects.filter((p) => p !== slug).length;
  if (here) parts.push("this project's theme");
  if (others) parts.push(`${others} other project${others === 1 ? '' : 's'}`);
  const sc = u.scenarios.length;
  if (sc) parts.push(`${sc} scenario${sc === 1 ? '' : 's'}`);
  return parts.length ? `Used by ${parts.join(', ')}` : 'Not used by a project or scenario yet';
}

/**
 * Whether an event re-reads a theme screen: a reconnection; a theme changed (the open one by name — or any, for the
 * list); a component (the pickers); the project's files (project.yaml names its theme); a site extraction (the list's
 * site panel).
 */
export function themeEventAction(e: StudioEvent, slug: string, theme?: string): boolean {
  if (e.type === 'resync') return true;
  if (e.type !== 'workspace') return false;
  const themes = Array.isArray(e.themes) ? e.themes : [];
  if (theme !== undefined) return themes.includes(theme) || (Array.isArray(e.components) && e.components.length > 0);
  return themes.length > 0 || (Array.isArray(e.components) && e.components.length > 0) || (Array.isArray(e.projects) && e.projects.includes(slug)) || e.site === true;
}

/** What scenario_blocks says about a scenario, as "Use in this scenario" needs it. */
export interface ScenarioFacts {
  hash: string;
  text: string;
  blocks: { parsed: boolean; video: { template?: string } };
  edit: { blocks: { ok: true } | { ok: false; why: string } };
}

/** The scenario_edit `set_field` of the scenario's `template` (critique B1). */
export interface TemplateFieldEdit {
  kind: 'set_field';
  at: { entry: 'top' };
  field: 'template';
  from?: string;
  to: string;
}

/** "Use in this scenario": the edit, or that it already uses it, or why not. */
export function planUseInScenario(s: ScenarioFacts, theme: string): { edit: TemplateFieldEdit } | { already: true } | { why: string } {
  if (!okTheme(theme)) return { why: 'not a theme name' };
  if (!s.blocks.parsed) return { why: 'the scenario does not read as YAML: fix it in its YAML view first' };
  if (!s.edit.blocks.ok) return { why: s.edit.blocks.why };
  const cur = s.blocks.video.template;
  if (cur === theme) return { already: true };
  return { edit: { kind: 'set_field', at: { entry: 'top' }, field: 'template', ...(cur !== undefined ? { from: cur } : {}), to: theme } };
}

/** Said after "Use in this scenario" (L5.5: an edit value — and the one filmed part a theme has, critique B1). */
export const USE_IN_SCENARIO_WORDS = 'A render of each existing take uses it — no new capture. The cursor style is filmed: existing takes keep theirs.';

/** New theme's form (theme_create = core BrandInputSchema without `replace`). */
export interface NewThemeForm {
  name: string;
  base: string;
  accent: string;
  text: string;
  paper: string;
  muted: string;
  logo: string;
  wordmark: string;
  display: string;
  body: string;
  brandName: string;
  brandUrl: string;
}

export const EMPTY_FORM: NewThemeForm = { name: '', base: 'editorial', accent: '#2357d9', text: '', paper: '', muted: '', logo: '', wordmark: '', display: '', body: '', brandName: '', brandUrl: '' };

/** The form prefilled from a site extraction ("New theme from this"): its hex roles and its first logo candidate. */
export function formFromSite(site: SiteListAnswer['sites'][number], name: string): NewThemeForm {
  const r = site.palette?.roles;
  const accent = r && okHex(r.accent) ? r.accent : r && okHex(r.text) ? r.text : EMPTY_FORM.accent;
  return {
    ...EMPTY_FORM,
    name,
    accent: accent.toLowerCase(),
    text: r && okHex(r.text) ? r.text.toLowerCase() : '',
    paper: r && okHex(r.paper) ? r.paper.toLowerCase() : '',
    logo: site.candidates[0]?.ref ?? '',
  };
}

/** A free name for a new theme ("site-theme", "site-theme-2"…; "my-theme"…). */
export function freeThemeName(base: 'site-theme' | 'my-theme', taken: Iterable<string>): string {
  const names = new Set(taken);
  for (let n = 1; n < 1000; n++) {
    const name = n === 1 ? base : `${base}-${n}`;
    if (!names.has(name)) return name;
  }
  return `${base}-x`;
}

/** Why the form cannot be sent (null: it can). */
export function newThemeProblem(f: NewThemeForm, taken: Iterable<string>): string | null {
  if (!f.name) return 'Give the theme a name.';
  if (!NEW_THEME_NAME.test(f.name)) return 'A theme name is lower-case letters, digits and "-", starting with a letter or a digit.';
  if (!okNewThemeName(f.name)) return NEW_THEME_TOO_LONG;
  if (new Set(taken).has(f.name)) return 'A theme of that name exists.';
  if (!okTheme(f.base)) return 'Pick a base theme.';
  for (const [k, v] of [
    ['accent', f.accent],
    ['text', f.text],
    ['paper', f.paper],
    ['muted', f.muted],
  ] as const)
    if (v !== '' && !okHex(v)) return `The ${k} colour is a hex value: #rgb or #rrggbb.`;
  if (!f.accent) return 'Give the accent colour.';
  if (!f.logo) return 'Pick a logo file (an image of the workspace, or a site candidate).';
  if (f.brandName.length > 80 || f.brandUrl.length > 120) return 'The brand name takes at most 80 characters, its URL 120.';
  return null;
}

/** theme_create's input from the form (empty fields left out: the base theme's or derived). */
export function createInput(f: NewThemeForm): ThemeCreateInput {
  const colors: ThemeCreateInput['colors'] = {
    accent: f.accent.toLowerCase(),
    ...(f.text ? { text: f.text.toLowerCase() } : {}),
    ...(f.paper ? { paper: f.paper.toLowerCase() } : {}),
    ...(f.muted ? { muted: f.muted.toLowerCase() } : {}),
  };
  const fonts = { ...(f.display ? { display: f.display } : {}), ...(f.body ? { body: [f.body] } : {}) };
  const brand = { ...(f.brandName.trim() ? { name: f.brandName.trim() } : {}), ...(f.brandUrl.trim() ? { url: f.brandUrl.trim() } : {}) };
  return {
    name: f.name,
    base: f.base,
    colors,
    logo: f.logo,
    ...(f.wordmark ? { wordmark: f.wordmark } : {}),
    ...(Object.keys(fonts).length ? { fonts } : {}),
    ...(Object.keys(brand).length ? { brand } : {}),
  };
}

/** The kinds in the editor's order. */
export const EDITOR_KINDS: readonly Kind[] = KIND_ORDER;
