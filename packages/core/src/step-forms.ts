/**
 * Step forms for the Studio's inspector and palette (L4.3 part 3, R-UI-12): which values of a step a form edits, derived
 * from the scenario language's own schemas (z.toJSONSchema of ACTION_ARG_SCHEMAS — the conversion the published
 * scenario.schema.json uses, so forms and schema cannot drift), and a step's values in that shape.
 *
 * - Cut to scalars and a flat target (critique C2): a field is text, a number, an integer, yes / no or one of a list.
 *   A property that is a target (TargetSpec) becomes a group of flat fields — text, role, name, label, aria,
 *   placeholder, css, testid, `in` (the scope keywords), nth, exact. Anything else (lists, points, nested targets, `in`
 *   as a row or a target, `contains`, code) stays in the YAML tab: listed, shown read-only.
 * - Modifiers: caption (text, kicker), hold, speed, mark.
 * - Values are read in object form: a shorthand (`click: Save`, `caption: Hello`, `type.into: Message`) reads as the
 *   field it means (core normalizeStep / normalizeTarget), so the form shows `text: Save`; writing it back keeps the
 *   shorthand when only that field changes (step-edits.ts set_step).
 * - `eval`, `emit` and `cursor` take no form (code, custom events, points: the YAML tab); the palette offers the ≈ 15
 *   actions whose required values fit these fields.
 */
import { z } from 'zod';
import { firstHiddenChar, hiddenCharName } from './scenario-edit.js';
import { ACTION_ARG_SCHEMAS, ACTION_DESCRIPTIONS, stepCommonShape } from './schemas/steps.js';
import { normalizeStep, stepActionKeys } from './steps.js';
import { normalizeTarget } from './targets.js';
import { ACTION_NAMES } from './types.js';
import type { ActionName } from './types.js';

export type FormFieldKind = 'text' | 'number' | 'integer' | 'boolean' | 'enum';
/** A value a form field holds. */
export type FormValue = string | number | boolean;

export interface FormField {
  /** Its path from the step, dotted: "click.text", "type.into.label", "caption.text", "hold". */
  key: string;
  label: string;
  kind: FormFieldKind;
  required?: true;
  options?: string[];
  /** Number bounds: minimum, exclusive minimum, maximum. */
  min?: number;
  exclusive_min?: number;
  max?: number;
  min_length?: number;
  /** A regular expression the whole text must match (slug-like names). */
  pattern?: string;
  description?: string;
  /** The target it belongs to (dotted path: "click", "type.into"): its fields show as one group. */
  group?: string;
}

export interface ActionForm {
  action: ActionName;
  description: string;
  fields: FormField[];
  /** Its values the forms leave to the YAML tab (dotted paths: "click.outside", "click.offset"). */
  yaml_only: string[];
  /** Offered in the palette (new steps). */
  palette: boolean;
  /** The values a new step starts with: a required number at 1 (or its minimum), a required text empty. */
  defaults: Record<string, FormValue>;
}

export interface StepForms {
  actions: ActionForm[];
  /** The modifier fields (caption text / kicker, hold, speed, mark). A `hold` step has no hold modifier. */
  modifiers: FormField[];
  palette: ActionName[];
}

/** The actions of the palette (critique C3): those whose required values fit the form fields. */
export const PALETTE_ACTIONS: readonly ActionName[] = ['open', 'click', 'double_click', 'hover', 'type', 'press', 'select', 'wait', 'wait_for', 'hold', 'screenshot', 'scroll', 'menu', 'date', 'notify'];

/** Actions without a form: code, custom events, cursor points (the YAML tab). */
const NO_FORM: ReadonlySet<ActionName> = new Set<ActionName>(['eval', 'emit', 'cursor']);

/** The flat keys of a target in a form (critique C2). */
export const TARGET_FIELDS = ['text', 'role', 'name', 'label', 'aria', 'placeholder', 'css', 'testid', 'in', 'nth', 'exact'] as const;

/** The modifiers a form edits. */
export const MODIFIER_KEYS = ['caption', 'hold', 'speed', 'mark'] as const;

type Json = Record<string, unknown>;

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isScalarValue = (v: unknown): v is FormValue => typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v)) || typeof v === 'boolean';

function jsonOf(schema: z.ZodType): Json {
  return z.toJSONSchema(schema, { target: 'draft-2020-12', unrepresentable: 'any' }) as Json;
}

/** A schema with its `$ref` followed (within its own `$defs`), and the def's name when it was one. */
function deref(s: Json, defs: Record<string, Json>): { s: Json; ref?: string } {
  let ref: string | undefined;
  let cur = s;
  for (let i = 0; i < 8 && typeof cur.$ref === 'string'; i++) {
    ref = (cur.$ref as string).replace(/^#\/\$defs\//, '');
    const next = defs[ref];
    if (!next) break;
    cur = { ...next, ...(cur.description !== undefined ? { description: cur.description } : {}) };
  }
  return { s: cur, ...(ref !== undefined ? { ref } : {}) };
}

const SAFE = Number.MAX_SAFE_INTEGER;

/** One scalar field from a schema node, or null when it is not one (a list, an object, a union of objects). */
function scalarField(key: string, s: Json, defs: Record<string, Json>, required: boolean, group?: string): FormField | null {
  const { s: n } = deref(s, defs);
  const base = {
    key,
    label: key.split('.').pop()!.replace(/_/g, ' '),
    ...(required ? { required: true as const } : {}),
    ...(typeof n.description === 'string' ? { description: n.description } : typeof s.description === 'string' ? { description: s.description } : {}),
    ...(group !== undefined ? { group } : {}),
  };
  if (Array.isArray(n.anyOf)) {
    // The scope of a target (`in`): its keywords; a row or a target as scope stays in the YAML tab.
    const branches = (n.anyOf as Json[]).map((b) => deref(b, defs).s);
    const scope = branches.find((b) => Array.isArray(b.enum) && (b.enum as unknown[]).includes('dialog'));
    if (scope) return { ...base, kind: 'enum', options: (scope.enum as string[]).slice() };
    // Otherwise the first plain scalar branch (`scroll.to` a number, `click.outside` yes / no, `menu.row` a text).
    const first = branches.find((b) => ['string', 'number', 'integer', 'boolean'].includes(b.type as string));
    return first ? scalarField(key, { ...first, ...(base.description ? { description: base.description } : {}) }, defs, required, group) : null;
  }
  if (Array.isArray(n.enum) && (n.enum as unknown[]).every((e) => typeof e === 'string')) return { ...base, kind: 'enum', options: (n.enum as string[]).slice() };
  const num = (k: 'minimum' | 'exclusiveMinimum' | 'maximum') => (typeof n[k] === 'number' && Math.abs(n[k] as number) < SAFE ? (n[k] as number) : undefined);
  switch (n.type) {
    case 'string':
      return {
        ...base,
        kind: 'text',
        ...(typeof n.minLength === 'number' && n.minLength > 0 ? { min_length: n.minLength } : {}),
        ...(typeof n.pattern === 'string' ? { pattern: n.pattern } : {}),
      };
    case 'number':
    case 'integer': {
      const min = num('minimum');
      const ex = num('exclusiveMinimum');
      const max = num('maximum');
      return { ...base, kind: n.type, ...(min !== undefined ? { min } : {}), ...(ex !== undefined ? { exclusive_min: ex } : {}), ...(max !== undefined ? { max } : {}) };
    }
    case 'boolean':
      return { ...base, kind: 'boolean' };
    default:
      return null;
  }
}

/** The fields of an object schema at `prefix` (an action's object form, a target group, a caption). */
function objectFields(prefix: string, obj: Json, defs: Record<string, Json>, out: { fields: FormField[]; yaml_only: string[] }, o: { group?: string; nested: boolean }): void {
  const props = (isObj(obj.properties) ? obj.properties : {}) as Record<string, Json>;
  const required = new Set(Array.isArray(obj.required) ? (obj.required as string[]) : []);
  // The object is itself a target (click / hover arguments: target keys next to the click's options).
  const inline = o.group === undefined && 'testid' in props && 'css' in props;
  for (const [k, ps] of Object.entries(props)) {
    const key = `${prefix}.${k}`;
    const targetKey = (TARGET_FIELDS as readonly string[]).includes(k);
    if (o.group !== undefined || (inline && (k === 'contains' || k === 'last_visible'))) {
      // Inside a target: its flat keys only.
      const f = targetKey ? scalarField(key, ps, defs, false, o.group ?? prefix) : null;
      if (f) out.fields.push(f);
      else out.yaml_only.push(key);
      continue;
    }
    const d = deref(ps, defs);
    if (d.ref === 'TargetSpec' && !o.nested) {
      // A target: its flat fields as one group (a target inside a target stays in the YAML tab).
      const tObj = deref((d.s.anyOf as Json[]).find((b) => typeof b.$ref === 'string') ?? {}, defs).s;
      objectFields(key, tObj, defs, out, { group: key, nested: true });
      continue;
    }
    const f = scalarField(key, ps, defs, required.has(k), inline && targetKey ? prefix : undefined);
    if (f) out.fields.push(f);
    else out.yaml_only.push(key);
  }
}

function actionForm(action: ActionName): ActionForm {
  const js = jsonOf(ACTION_ARG_SCHEMAS[action]);
  const defs = (isObj(js.$defs) ? js.$defs : {}) as Record<string, Json>;
  const out = { fields: [] as FormField[], yaml_only: [] as string[] };
  if (!NO_FORM.has(action)) {
    const branches = Array.isArray(js.anyOf) ? (js.anyOf as Json[]).map((b) => deref(b, defs).s) : [deref(js, defs).s];
    const obj = branches.find((b) => b.type === 'object');
    if (obj) objectFields(action, obj, defs, out, { nested: false });
    else {
      // The value itself is the field (`wait: 2`, `hold: 1.5`).
      const f = scalarField(action, branches[0], defs, true);
      if (f) out.fields.push({ ...f, label: 'seconds' });
      else out.yaml_only.push(action);
    }
  } else out.yaml_only.push(action);
  const defaults: Record<string, FormValue> = {};
  for (const f of out.fields) {
    if (!f.required) continue;
    if (f.kind === 'number' || f.kind === 'integer') defaults[f.key] = Math.max(1, f.min ?? 0);
    else if (f.kind === 'text') defaults[f.key] = '';
    else if (f.kind === 'enum' && f.options?.length) defaults[f.key] = f.options[0];
  }
  return { action, description: ACTION_DESCRIPTIONS[action], fields: out.fields, yaml_only: out.yaml_only, palette: PALETTE_ACTIONS.includes(action), defaults };
}

function modifierFields(): FormField[] {
  const shape = Object.fromEntries(MODIFIER_KEYS.map((k) => [k, (stepCommonShape as Record<string, z.ZodType>)[k]]));
  const js = jsonOf(z.object(shape));
  const defs = (isObj(js.$defs) ? js.$defs : {}) as Record<string, Json>;
  const props = js.properties as Record<string, Json>;
  const out = { fields: [] as FormField[], yaml_only: [] as string[] };
  for (const k of MODIFIER_KEYS) {
    const d = deref(props[k], defs).s;
    const obj = Array.isArray(d.anyOf) ? (d.anyOf as Json[]).map((b) => deref(b, defs).s).find((b) => b.type === 'object') : undefined;
    if (obj) {
      // caption: {kicker, text} (a plain string caption reads as its text) — text first.
      const sub = { fields: [] as FormField[], yaml_only: [] as string[] };
      for (const [sk, sp] of Object.entries((obj.properties ?? {}) as Record<string, Json>)) {
        const f = scalarField(`${k}.${sk}`, sp, defs, Array.isArray(obj.required) && (obj.required as string[]).includes(sk), k);
        if (f) sub.fields.push(f);
      }
      out.fields.push(...sub.fields.sort((a, b) => Number(b.key.endsWith('.text')) - Number(a.key.endsWith('.text'))));
      continue;
    }
    const f = scalarField(k, props[k], defs, false);
    if (f) out.fields.push(f);
  }
  return out.fields;
}

let memo: StepForms | undefined;

/** The forms of every action and the modifiers (computed once). */
export function stepForms(): StepForms {
  memo ??= { actions: ACTION_NAMES.map((a) => actionForm(a)), modifiers: modifierFields(), palette: [...PALETTE_ACTIONS] };
  return memo;
}

/** The form of one action. */
export function actionFormOf(action: ActionName): ActionForm {
  return stepForms().actions.find((f) => f.action === action)!;
}

/** Every field a step of `action` has in a form: its arguments, then the modifiers (a `hold` step: no hold modifier). */
export function stepFields(action: ActionName): FormField[] {
  const f = stepForms();
  return [...actionFormOf(action).fields, ...f.modifiers.filter((m) => m.key !== action)];
}

// ── A step's values ─────────────────────────────────────────────────────────

/** How a container written as a scalar reads in object form, or undefined (it is not a shorthand). */
export function expandShorthand(action: ActionName, container: string, v: FormValue): Record<string, unknown> | undefined {
  if (container === action) {
    try {
      const args = normalizeStep({ [action]: v } as never, 0).args as unknown;
      return isObj(args) ? args : undefined;
    } catch {
      return undefined;
    }
  }
  if (container === 'caption') return typeof v === 'string' ? { text: v } : undefined;
  // A target group written as a string: visible text, or a CSS selector (core normalizeTarget).
  const group = stepFields(action).some((f) => f.group === container && container !== 'caption');
  if (group && typeof v === 'string') return { ...normalizeTarget(v) };
  return undefined;
}

/**
 * The scalar a container's object form is written as when its shorthand says exactly the same and the schema takes
 * it (`click: Save`, `caption: Hello`, `into: Message` — never `type: x`, which the schema refuses), else undefined.
 */
export function shorthandOf(action: ActionName, container: string, obj: Record<string, unknown>): FormValue | undefined {
  const keys = Object.keys(obj);
  if (keys.length !== 1) return undefined;
  const v = obj[keys[0]];
  if (!isScalarValue(v)) return undefined;
  if (container === action ? !ACTION_ARG_SCHEMAS[action].safeParse(v).success : typeof v !== 'string' || v === '') return undefined;
  const exp = expandShorthand(action, container, v);
  return exp && JSON.stringify(exp) === JSON.stringify(obj) ? v : undefined;
}

/** What a step holds at a field's path: its value, nothing (`absent`), or something a field cannot show (`complex`). */
export type FieldRead = { value: FormValue } | { absent: true } | { complex: true };

export function readField(raw: unknown, action: ActionName, key: string): FieldRead {
  const segs = key.split('.');
  let cur: unknown = raw;
  for (let i = 0; i < segs.length; i++) {
    if (isObj(cur)) cur = cur[segs[i]];
    else if (isScalarValue(cur) && i > 0) {
      const exp = expandShorthand(action, segs.slice(0, i).join('.'), cur);
      if (!exp) return { complex: true };
      cur = exp[segs[i]];
    } else if (cur === undefined) return { absent: true };
    else return { complex: true };
  }
  if (cur === undefined) return { absent: true };
  return isScalarValue(cur) ? { value: cur } : { complex: true };
}

/** A URL holding `user:password@` (or `user@`): never shown in a form (stripped from blocks: blocks.ts stripUrlUserinfo). */
const USERINFO = /\b[a-z][a-z0-9+.-]*:\/\/[^\s/?#]*@/i;

export interface StepFormValues {
  action: ActionName;
  /** Each field's value (fields without a value are absent). */
  values: Record<string, FormValue>;
  /** Fields whose value a form cannot show (a list, a row scope, a URL with a password…): edited in the YAML tab. */
  locked: Record<string, string>;
  /** What else the step holds that no field edits (dotted paths: "overlay", "click.outside"). */
  yaml_only: string[];
}

/**
 * A step's values for its form (object form: a shorthand reads as the field it means), or undefined for a step a form
 * does not edit (not exactly one action, or an action without a form).
 */
export function stepFormValues(raw: unknown): StepFormValues | undefined {
  if (!isObj(raw)) return undefined;
  const keys = stepActionKeys(raw);
  if (keys.length !== 1 || NO_FORM.has(keys[0])) return undefined;
  const action = keys[0];
  const fields = stepFields(action);
  const values: Record<string, FormValue> = {};
  const locked: Record<string, string> = {};
  for (const f of fields) {
    const r = readField(raw, action, f.key);
    if ('value' in r) {
      if (fieldKindProblem(f, r.value)) locked[f.key] = 'written in a form these fields do not show: edit it in the YAML tab';
      else if (typeof r.value === 'string' && USERINFO.test(r.value)) locked[f.key] = 'holds a URL with sign-in details (user@): edit it in the YAML tab';
      else if (typeof r.value === 'string' && firstHiddenChar(r.value) !== undefined) {
        // An input would show it as nothing (review A): the YAML tab marks the line.
        locked[f.key] = `holds ${hiddenCharName(firstHiddenChar(r.value)!)}, which a form cannot show: edit it in the YAML tab`;
      } else values[f.key] = r.value;
    } else if ('complex' in r) locked[f.key] = 'written in a form these fields do not show: edit it in the YAML tab';
  }
  // What else it holds: keys of the step, of its action's object form and of its targets that no field covers.
  const known = new Set(fields.map((f) => f.key));
  const containers = new Set(fields.flatMap((f) => f.key.split('.').slice(0, -1).map((_, i, a) => a.slice(0, i + 1).join('.'))));
  const yaml_only: string[] = [];
  const walk = (v: unknown, path: string[]) => {
    const key = path.join('.');
    if (known.has(key)) return;
    const obj = !containers.has(key) ? undefined : isObj(v) ? v : isScalarValue(v) ? expandShorthand(action, key, v) : undefined;
    if (!obj) {
      yaml_only.push(key);
      return;
    }
    for (const [k, x] of Object.entries(obj)) walk(x, [...path, k]);
  };
  for (const [k, x] of Object.entries(raw)) walk(x, [k]);
  return { action, values, locked, yaml_only };
}

/** The field of a key, for a step of `action` (undefined: not a field a form edits). */
export function fieldOf(action: ActionName, key: string): FormField | undefined {
  return stepFields(action).find((f) => f.key === key);
}

/** Why a value does not fit its field's kind (the zod schema checks the rest: bounds, patterns), or null. */
export function fieldKindProblem(f: FormField, v: FormValue): string | null {
  switch (f.kind) {
    case 'text':
      return typeof v === 'string' ? null : `${f.key}: a text`;
    case 'number':
      return typeof v === 'number' && Number.isFinite(v) ? null : `${f.key}: a number`;
    case 'integer':
      return typeof v === 'number' && Number.isInteger(v) ? null : `${f.key}: a whole number`;
    case 'boolean':
      return typeof v === 'boolean' ? null : `${f.key}: yes or no`;
    case 'enum':
      return typeof v === 'string' && (f.options ?? []).includes(v) ? null : `${f.key}: one of ${(f.options ?? []).join(', ')}`;
  }
}
