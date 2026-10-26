/**
 * Step forms on the Blocks tab (L4.3 part 3, R-UI-12): the pure parts of the inspector's form and the palette — a
 * field's input read and checked against its schema-derived rules (scenario_forms), the changes a form makes (field
 * patches `{path, from, to}`, critique B2), the issue of a refused save placed at its field, and where an edit goes
 * again after the file changed ("Apply it to the new version"). Nothing here builds YAML: the server writes the file.
 */
import type { ActionForm, ActionName, FormField, FormValue, StepBlock, StepForms } from '@demo-studio/core';
import type { StepEditOp } from './step-edit.js';
import type { View } from './scenario-words.js';

/** A field change as `scenario_edit` takes it. */
export interface FieldChange {
  path: string[];
  from?: FormValue;
  to?: FormValue;
}

/** What an input holds: a text input's text, a select's choice ('' = not set). */
export type Inputs = Record<string, string>;

/** Every field of a step of `action`: its arguments, then the modifiers (a `hold` step has no hold modifier). */
export function fieldsOf(forms: StepForms, action: ActionName): FormField[] {
  const form = forms.actions.find((a) => a.action === action);
  return form ? [...form.fields, ...forms.modifiers.filter((m) => m.key !== action)] : [];
}

export function actionForm(forms: StepForms, action: ActionName): ActionForm | undefined {
  return forms.actions.find((a) => a.action === action);
}

/** A value as its input shows it. */
export function inputOf(v: FormValue | undefined): string {
  return v === undefined ? '' : String(v);
}

/** The inputs of a set of values. */
export function inputsOf(fields: readonly FormField[], values: Record<string, FormValue>): Inputs {
  return Object.fromEntries(fields.map((f) => [f.key, inputOf(values[f.key])]));
}

/** "type.into" → "into"; the inline target of a click → "target"; "caption" → "caption". */
export function groupLabel(group: string, action: ActionName): string {
  return group === action ? 'target' : group.split('.').pop()!.replace(/_/g, ' ');
}

/**
 * An input read as its field's value: `{value}` (undefined: not set) or `{error}` — the schema's rules (a number, a
 * whole number, its bounds, a pattern, at least one character, one of the options, one line). `required`: the field
 * must be set (a top-level required field, or one of a group that has a value). `held`: the value the file holds — an
 * empty input of a text field that holds "" (and allows it) reads as "" (review B M2: `type: {text: "", clear: true}`).
 */
export function readInput(f: FormField, input: string, required: boolean, held?: FormValue): { value: FormValue | undefined } | { error: string } {
  if (input === '' && held === '' && f.kind === 'text' && f.min_length === undefined) return { value: '' };
  if (input === '') return required ? { error: 'needs a value' } : { value: undefined };
  switch (f.kind) {
    case 'boolean':
      return input === 'true' ? { value: true } : input === 'false' ? { value: false } : { error: 'yes or no' };
    case 'enum':
      return (f.options ?? []).includes(input) ? { value: input } : { error: `one of ${(f.options ?? []).join(', ')}` };
    case 'number':
    case 'integer': {
      const t = input.trim();
      const n = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(t) ? Number(t) : NaN;
      if (!Number.isFinite(n)) return { error: f.kind === 'integer' ? 'a whole number' : 'a number' };
      if (f.kind === 'integer' && !Number.isInteger(n)) return { error: 'a whole number' };
      if (f.min !== undefined && n < f.min) return { error: `at least ${f.min}` };
      if (f.exclusive_min !== undefined && n <= f.exclusive_min) return { error: `more than ${f.exclusive_min}` };
      if (f.max !== undefined && n > f.max) return { error: `at most ${f.max}` };
      return { value: n };
    }
    case 'text': {
      if (/[\r\n]/.test(input)) return { error: 'one line only' };
      if (input.length > 10_000) return { error: 'at most 10,000 characters' };
      if (f.min_length !== undefined && input.length < f.min_length) return { error: 'needs a value' };
      if (f.pattern !== undefined) {
        let ok = true;
        try {
          ok = new RegExp(f.pattern, 'u').test(input);
        } catch {
          ok = true; // the server checks it
        }
        if (!ok) return { error: 'letters, digits, "-" or "_", starting with a letter or a digit' };
      }
      return { value: input };
    }
  }
}

/** Whether a field must be set: a required field of its own, or a required one of a group where something is set. */
export function isRequired(f: FormField, fields: readonly FormField[], inputs: Inputs): boolean {
  if (!f.required) return false;
  if (f.group === undefined) return true;
  return fields.some((g) => g.group === f.group && (inputs[g.key] ?? '') !== '');
}

/** Each input read (`held`: the values the file holds, readInput): the values, and the errors by field key. */
export function readInputs(
  fields: readonly FormField[],
  inputs: Inputs,
  skip: ReadonlySet<string> = new Set(),
  held: Record<string, FormValue> = {},
): { values: Record<string, FormValue>; errors: Record<string, string> } {
  const values: Record<string, FormValue> = {};
  const errors: Record<string, string> = {};
  for (const f of fields) {
    if (skip.has(f.key)) continue;
    const r = readInput(f, inputs[f.key] ?? '', isRequired(f, fields, inputs), held[f.key]);
    if ('error' in r) errors[f.key] = r.error;
    else if (r.value !== undefined) values[f.key] = r.value;
  }
  return { values, errors };
}

/**
 * The changes from the values a form showed to the values it holds now (fields in form order; locked ones left out).
 * `typed`: the inputs and what they showed — a field whose input is as shown is no change (review B M2: an untouched
 * "" read as not set was sent as a removal).
 */
export function formChanges(
  fields: readonly FormField[],
  before: Record<string, FormValue>,
  after: Record<string, FormValue>,
  skip: ReadonlySet<string> = new Set(),
  typed?: { inputs: Inputs; shown: Inputs },
): FieldChange[] {
  const out: FieldChange[] = [];
  for (const f of fields) {
    if (skip.has(f.key)) continue;
    if (typed && (typed.inputs[f.key] ?? '') === (typed.shown[f.key] ?? '')) continue;
    const a = before[f.key];
    const b = after[f.key];
    if (a === b) continue;
    out.push({ path: f.key.split('.'), ...(a !== undefined ? { from: a } : {}), ...(b !== undefined ? { to: b } : {}) });
  }
  return out;
}

/**
 * The field a refused save's issue is about: its path inside the step (`scenes.<entry>.steps.<index>.…`), matched to
 * the longest field key it starts with. Undefined: not about a field of this step.
 */
export function issueField(path: ReadonlyArray<string | number> | undefined, entry: number, index: number, fields: readonly FormField[]): string | undefined {
  if (!path || path[0] !== 'scenes' || path[1] !== entry || path[2] !== 'steps' || path[3] !== index) return undefined;
  const rest = path.slice(4).map(String);
  let best: string | undefined;
  for (const f of fields) {
    const k = f.key.split('.');
    if (k.length <= rest.length && k.every((s, i) => s === rest[i]) && (!best || k.length > best.split('.').length)) best = f.key;
  }
  // A whole target or caption refused (`type.into` has no locator): its group's first field.
  if (!best && rest.length) best = fields.find((f) => f.group !== undefined && f.group === rest.join('.'))?.key;
  return best;
}

/** The scene blocks of a view. */
function scenesOf(v: View) {
  return v.blocks.entries.filter((e) => e.type === 'scene');
}

/**
 * Where an edit's step is, to find it again in a newer version: its scene, its fingerprint, which of the scene's steps
 * with it (`nth`) and how many there are (`count`).
 */
export interface StepAnchor {
  scene: string;
  fingerprint: string;
  nth: number;
  count: number;
}

export function anchorOf(v: View, scene: string, index: number): StepAnchor | null {
  const steps = scenesOf(v).find((s) => s.id === scene)?.steps;
  const st = steps?.[index];
  if (!steps || !st?.fingerprint) return null;
  const same = steps.filter((x) => x.fingerprint === st.fingerprint);
  return { scene, fingerprint: st.fingerprint, nth: steps.slice(0, index).filter((x) => x.fingerprint === st.fingerprint).length, count: same.length };
}

/**
 * The anchored step in a newer version, or undefined. A fingerprint leaves modifiers out, so when the scene now has
 * more or fewer steps with it (one deleted or changed, one added) the nth may be another step: none (review A L5).
 */
function findAnchor(v: View, a: StepAnchor): StepBlock | undefined {
  const same = (scenesOf(v).find((s) => s.id === a.scene)?.steps ?? []).filter((x) => x.fingerprint === a.fingerprint);
  return same.length === a.count ? same[a.nth] : undefined;
}

/**
 * The edit to send again on a newer version ("Apply it to the new version"), or why it cannot be: a form's changes go
 * to the same step found again by its fingerprint (a caption changed meanwhile keeps that step; the server applies each
 * change only while the step still holds what the form showed — critique B2); a new step goes after the same step as
 * before (by its guard). Moves, deletes and duplicates go as they were: their guard refuses a step that moved.
 */
export function editAgain(op: StepEditOp, anchor: StepAnchor | null, v: View): { op: StepEditOp } | { why: string } {
  if (op.kind === 'set_step') {
    const st = anchor ? findAnchor(v, anchor) : undefined;
    if (!st || st.guard === undefined) return { why: 'the step it changes is no longer in the file as it was, or its scene now has more or fewer steps like it' };
    return { op: { ...op, at: { scene: op.at.scene, index: st.index, guard: st.guard } } };
  }
  if (op.kind === 'insert_step') {
    if (op.after === null) return { op: { ...op, to: { ...op.to, index: 0 } } };
    const st = scenesOf(v)
      .find((s) => s.id === op.to.scene)
      ?.steps.find((x) => x.guard === op.after);
    if (!st) return { why: 'the step it was to follow changed or moved' };
    return { op: { ...op, to: { ...op.to, index: st.index + 1 } } };
  }
  return { op };
}

/** "type text", "caption kicker". */
export function fieldWords(key: string): string {
  return key.replace(/[._]/g, ' ');
}
