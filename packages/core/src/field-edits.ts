/**
 * Field edits of a scenario's edit part from the Studio's timeline (L4.5, R-UI-23): one value of the video, a scene, a
 * card or an interstitial changed in one click — a layout, the caption component, a speed, a transition, a component, a
 * duration, the intro / outro switch — as a splice of the file's text, never a re-serialisation (step-edits.ts's rules:
 * every byte outside the lines it touches stays). Pure; the engine (scenarios.edit) re-parses the result and refuses it
 * unless its value is exactly `intended` (core verifyEditText), then validates and writes it under L4.3's rules.
 *
 * - The allow-list (FIELD_PATHS) is the only set of paths `set_field` takes: all of them are edit values (core
 *   filmedChanges: a render of the same take re-plans them, no new capture). Hooks, vars, env, capture, pacing and steps
 *   are never reached from here.
 * - A value is changed only while the file still holds `from` there (stale otherwise), and a scene, card or
 *   interstitial is addressed by its id plus its guard (stepGuard of the entry as written): an edit sent on a newer
 *   version that moved or changed the entry is refused, never applied to a neighbour.
 * - Its own small editor (critique B10: L4.3's step operations untouched; since L4.7 map-edits.ts `setMapPath`, shared
 *   with theme edits): a scalar set (CST, its quoting kept), a value replaced (a flow value, or a block map written over
 *   by `intro: false`), a pair added — a new top-level key just before `scenes:`, a new scene key just before `steps:`,
 *   else after the map's last pair or into a flow map —, a pair removed with the comment lines that belong to it;
 *   removing the last key of a nested map (`intro: {component: x}` → the theme's intro) removes the parent pair.
 * - `template` (L4.7, critique B1): the scenario's theme by name (a render of every existing take re-plans it, L5.5);
 *   the engine accepts only a theme the workspace lists.
 */
import { isDeepStrictEqual } from 'node:util';
import { TEMPLATE_NAME_RE } from './jobs.js';
import { setMapPath } from './map-edits.js';
import { editValueProblem } from './scenario-edit.js';
import { StepEditError, stepGuard } from './step-edits.js';
import { COMPONENT_ID_RE } from './schemas/primitives.js';
import { sceneId } from './steps.js';
import type { Scenario } from './types.js';
import { parseYaml } from './validation/yaml-source.js';

/** A value `set_field` writes: a scalar (a map such as `{component, params}` is changed in the YAML tab). */
export type FieldValue = string | number | boolean;

/** Where a field is: the scenario's top level, or a scene / card / interstitial by id with its guard (stepGuard of the entry). */
export type FieldAt = { entry: 'top' } | { entry: 'scene' | 'card' | 'interstitial'; id: string; guard: string };

/**
 * One field set (`to`) or removed (`to` absent: the theme's default), applied only while the file holds `from` there
 * (absent: not written). The `intro` / `outro` switch reads `true` when written as a map, takes `false` or nothing —
 * refused over a map with more than a component and a duration (its own text or files are never dropped by a click).
 */
export interface FieldEdit {
  kind: 'set_field';
  at: FieldAt;
  field: string;
  from?: FieldValue;
  to?: FieldValue;
}

/** The only paths `set_field` takes, per entry kind (each an edit value: core filmedChanges). */
export const FIELD_PATHS = {
  top: ['frame', 'intro', 'intro.component', 'intro.duration', 'outro', 'outro.component', 'outro.duration', 'caption_component', 'template'],
  scene: ['frame', 'transition', 'speed'],
  card: ['card.component', 'card.duration', 'card.transition'],
  interstitial: ['interstitial.component', 'interstitial.duration'],
} as const satisfies Record<FieldAt['entry'], readonly string[]>;

/** What a field's value is: checked before anything is written (the engine checks components against the registry). */
export type FieldKind = 'frame' | 'transition' | 'speed' | 'duration' | 'component' | 'switch' | 'theme';

/** The kind of the value at a field path ("card.component" → component). */
export function fieldKindOf(field: string): FieldKind {
  if (field === 'frame') return 'frame';
  if (field === 'transition' || field.endsWith('.transition')) return 'transition';
  if (field === 'speed') return 'speed';
  if (field.endsWith('.duration')) return 'duration';
  if (field === 'intro' || field === 'outro') return 'switch';
  if (field === 'template') return 'theme';
  return 'component';
}

/** The component kind a component field names (caption_component → caption, card.component → card…). */
export function fieldComponentKind(field: string): 'intro' | 'outro' | 'card' | 'interstitial' | 'caption' | undefined {
  if (field === 'caption_component') return 'caption';
  const m = /^(intro|outro|card|interstitial)\.component$/.exec(field);
  return m ? (m[1] as 'intro' | 'outro' | 'card' | 'interstitial') : undefined;
}

/** Speeds a scene takes from the timeline (×). */
export const FIELD_SPEED_MAX = 16;
/** Seconds a card, an interstitial, an intro or an outro takes from the timeline. */
export const FIELD_DURATION_MAX = 600;

const FRAME_WORDS = new Set(['raw', 'card', 'browser', 'laptop', 'phone', 'tablet', 'split', 'pip']);
const TRANSITION_KINDS = new Set(['crossfade', 'cut', 'fade-black']);

/** Why `to` is not a value of `field` (its kind and range), or null. */
export function fieldValueProblem(field: string, to: unknown): string | null {
  const kind = fieldKindOf(field);
  if (kind === 'switch') return to === false ? null : `${field} takes false (no ${field} card) or nothing (the theme's ${field})`;
  if (kind === 'speed' || kind === 'duration') {
    const max = kind === 'speed' ? FIELD_SPEED_MAX : FIELD_DURATION_MAX;
    if (typeof to !== 'number' || !Number.isFinite(to) || to <= 0 || to > max) return `${field} takes a number above 0 and at most ${max}${kind === 'duration' ? ' (seconds)' : ''}`;
    return null;
  }
  if (typeof to !== 'string') return `${field} takes a name (text)`;
  const hidden = editValueProblem(to, { field });
  if (hidden) return hidden;
  if (kind === 'frame' && !FRAME_WORDS.has(to) && !COMPONENT_ID_RE.test(to)) {
    return `${field} takes raw, card, browser, laptop, phone, tablet, split, pip or a layout component "namespace/name"`;
  }
  if (kind === 'transition' && !TRANSITION_KINDS.has(to) && !COMPONENT_ID_RE.test(to)) {
    return `${field} takes crossfade, cut, fade-black or a transition component "namespace/name"`;
  }
  if (kind === 'component' && !COMPONENT_ID_RE.test(to)) return `${field} takes a component "namespace/name"`;
  // L4.7 (critique B1): a theme of the workspace by its name (templates.list) — never a path; the engine checks it is listed.
  if (kind === 'theme' && (!TEMPLATE_NAME_RE.test(to) || to.length > 100)) return `${field} takes a theme name (the themes list names them), never a path`;
  return null;
}

/** "the layout of scene request", "the caption component", "the duration of card card-1". */
export function fieldWhat(at: FieldAt, field: string): string {
  const leaf = field.split('.').at(-1)!;
  const word =
    field === 'caption_component'
      ? 'caption component'
      : field === 'template'
        ? 'theme'
        : field === 'frame'
          ? 'layout'
          : field === 'intro' || field === 'outro'
            ? field
            : field.startsWith('intro.') || field.startsWith('outro.')
              ? `${field.split('.')[0]} ${leaf}`
              : leaf;
  return at.entry === 'top' ? `the ${word}` : `the ${word} of ${at.entry} ${at.id}`;
}

export interface FieldEditApplied {
  text: string;
  /** The value the text must parse to (the edit applied to the parsed file): what the engine verifies. */
  intended: unknown;
  /** "Set the layout of scene request to laptop". */
  label: string;
  /** The value now written there (absent: removed — the theme's default). */
  value?: FieldValue;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);
const isFieldValue = (v: unknown): v is FieldValue => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';

function getAt(v: unknown, path: readonly string[]): unknown {
  let cur = v;
  for (const k of path) cur = isObj(cur) ? cur[k] : undefined;
  return cur;
}

interface Located {
  /** Index of the entry in `scenes:` (undefined: the top level). */
  entry?: number;
  /** The entry's (or the root's) value. */
  value: Obj;
}

function locate(root: Obj, at: FieldAt): Located {
  if (at.entry === 'top') return { value: root };
  if (typeof at.id !== 'string' || typeof at.guard !== 'string') throw new StepEditError('invalid', 'at needs the entry id and its guard');
  const scenes = root.scenes as unknown[];
  const k = scenes.findIndex((e, i) => {
    if (!isObj(e)) return false;
    const type = e.card !== undefined ? 'card' : e.interstitial !== undefined ? 'interstitial' : 'scene';
    return type === at.entry && sceneId(e as unknown as Scenario['scenes'][number], i) === at.id;
  });
  if (k < 0) throw new StepEditError('stale', `the file has no ${at.entry} "${at.id}" (any more): read it again`);
  const value = scenes[k] as Obj;
  if (stepGuard(value) !== at.guard) throw new StepEditError('stale', `${at.entry} ${at.id} is not the one the edit was made on (it changed or moved): read the file again`);
  return { entry: k, value };
}

/** What the file says at a field: its scalar, `true` for an intro / outro written as a map, undefined when absent. */
function currentOf(value: Obj, segs: readonly string[], kind: FieldKind, what: string): FieldValue | undefined {
  const v = getAt(value, segs);
  if (v === undefined || v === null) {
    // A parent written as a scalar (`intro: false`) has no `component`: absent.
    return undefined;
  }
  if (isFieldValue(v)) return v;
  if (kind === 'switch' && isObj(v)) return true;
  throw new StepEditError('not_editable', `${what} is written as ${Array.isArray(v) ? 'a list' : 'a map (with params)'}: change it in the YAML tab`);
}

/** A value for a label. */
const say = (v: FieldValue | undefined): string => (v === undefined ? "the theme's default" : typeof v === 'string' ? v : String(v));

/**
 * One field edit applied to a scenario's text (see the header): the new text, the value it must parse to, the label.
 * Throws StepEditError (`stale`: the entry or the value changed since the client read it; `not_editable`; `invalid`).
 */
export function applyFieldEdit(text: string, edit: FieldEdit): FieldEditApplied {
  const parsed = parseYaml(text);
  if (parsed.value === undefined || parsed.issues.some((i) => i.severity === 'error')) throw new StepEditError('not_editable', 'the file is not valid YAML: fix it in the YAML tab first');
  const root = parsed.value as Obj;
  if (!isObj(root) || !Array.isArray(root.scenes)) throw new StepEditError('not_editable', 'the file has no `scenes:` list: edit it in the YAML tab');
  const at = edit.at;
  if (!at || !Object.hasOwn(FIELD_PATHS, at.entry)) throw new StepEditError('invalid', 'at.entry is one of top, scene, card, interstitial');
  const allowed = FIELD_PATHS[at.entry] as readonly string[];
  if (typeof edit.field !== 'string' || !allowed.includes(edit.field)) {
    throw new StepEditError('invalid', `${String(edit.field).slice(0, 60)} is not a value the timeline sets on ${at.entry === 'top' ? 'the video' : `a ${at.entry}`} (it sets ${allowed.join(', ')}): change it in the YAML tab`);
  }
  const field = edit.field;
  const kind = fieldKindOf(field);
  const what = fieldWhat(at, field);
  if (edit.to !== undefined) {
    const p = fieldValueProblem(field, edit.to);
    if (p) throw new StepEditError('invalid', p, field);
  }
  const loc = locate(root, at);
  const segs = field.split('.');
  const current = currentOf(loc.value, segs, kind, what);
  // Applied only while the file still holds what the client showed there (a value changed meanwhile is kept).
  if (!isDeepStrictEqual(current, edit.from)) {
    throw new StepEditError('stale', `${what} changed meanwhile (it is now ${current === undefined ? 'not set' : JSON.stringify(current)}): read the file again`, field);
  }
  if (isDeepStrictEqual(current, edit.to)) throw new StepEditError('invalid', `nothing to change: ${what} is already ${say(edit.to)}`, field);
  // Review B H2: the intro / outro switch replaces or removes the whole map — never over its own content (a title, a
  // tagline, an image): only a map of component / duration is switched; the YAML tab changes the rest.
  if (kind === 'switch') {
    const v = getAt(loc.value, segs);
    const content = isObj(v) ? Object.keys(v).filter((k) => k !== 'component' && k !== 'duration') : [];
    if (content.length) {
      const named = content.filter((k) => /^[a-z_]{1,40}$/.test(k)).slice(0, 6);
      throw new StepEditError('not_editable', `the ${field} has its own ${named.length ? named.join(', ') : 'content'}: turn it off or back to the theme's in the YAML tab (a switch would drop it)`, field);
    }
  }
  const protectedKey = at.entry === 'card' || at.entry === 'interstitial' ? at.entry : undefined;
  // The splice (map-edits.ts setMapPath, shared with theme edits): a new top-level key before `scenes:`, a scene's before `steps:`.
  const { text: out, intended } = setMapPath(text, root, segs, edit.to, {
    ...(loc.entry !== undefined ? { entry: { seq: 'scenes', index: loc.entry } } : {}),
    insertBefore: loc.entry === undefined ? 'scenes' : 'steps',
    ...(protectedKey ? { protectedKey } : {}),
    what,
  });
  const label =
    kind === 'switch'
      ? edit.to === false
        ? `Turned the ${field} off`
        : `Turned the ${field} back on (the theme's)`
      : edit.to === undefined
        ? kind === 'theme'
          ? `Reset ${what} to the project's theme`
          : `Reset ${what} to the theme's default`
        : `Set ${what} to ${say(edit.to)}`;
  return { text: out, intended, label: label[0].toUpperCase() + label.slice(1), ...(edit.to !== undefined ? { value: edit.to } : {}) };
}
