/** The value edits of a step (step-edits.ts): a field change from the inspector's form, a new step from the palette. */
import { isDeepStrictEqual } from 'node:util';
import { CST, Composer, Document, Parser, isAlias, isCollection, isMap, isScalar, isSeq, visit } from 'yaml';
import type { Node, Pair, Scalar, YAMLMap, YAMLSeq } from 'yaml';
import { editValueProblem, verifyEditText } from './scenario-edit.js';
import { StepEditError, stepGuard } from './step-edit-model.js';
import type { StepEdit, StepEditApplied } from './step-edit-model.js';
import { applySplices, cloneValue, finish, insertLines, insertion, itemLines, lineEndOf, lineStartOf, pairRemoval, sceneSteps, stepAt } from './step-edit-text.js';
import type { Ctx } from './step-edit-text.js';
import { actionFormOf, expandShorthand, fieldKindProblem, fieldOf, readField, shorthandOf, stepFormValues } from './step-forms.js';
import type { FormValue } from './step-forms.js';
import { ACTION_NAMES } from './types/language.js';
import type { ActionName } from './types/language.js';

// ── Value edits (part 3: the inspector's form, the palette) ────────────────
//
// A field change becomes one raw operation on the step as written (no step-local document, no re-render):
// - `scalar`: an existing scalar takes the new value through yaml's CST.setScalarValue — only its own characters
//   change, its quoting kept; when the re-parsed value is not the intended one (a plain `123`, `yes`, `a, b` in a flow
//   map…), it is written again double-quoted (a number or yes / no: plain);
// - `replace`: a shorthand that must become an object (`click: Save` + `in: dialog`) → a rendered flow map in its place;
// - `add`: a new key — `, key: value` in a flow map, one `key: value` line in a block map (the map's indentation, the
//   file's line break);
// - `remove`: a key with its comment lines (pairRemoval), the commas of a flow map; a target left empty goes with it.
// Values are rendered by yaml (never concatenated); each operation is re-parsed and must give the intended step, and
// the engine verifies the whole file (verifyEditText).

export type RawOp =
  | { op: 'scalar'; path: string[]; value: FormValue }
  | { op: 'replace'; path: string[]; value: Record<string, unknown> }
  | { op: 'add'; path: string[]; key: string; value: unknown }
  | { op: 'remove'; path: string[]; key: string };

export const isPlainObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
export const isFormValue = (v: unknown): v is FormValue => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';

/** The value at `path` of a raw value (undefined when absent). */
export function getAt(v: unknown, path: readonly string[]): unknown {
  let cur = v;
  for (const k of path) cur = isPlainObj(cur) ? cur[k] : undefined;
  return cur;
}

/** `{a: {b: v}}` for path [a, b]. */
export function nest(path: readonly string[], v: unknown): unknown {
  return path.reduceRight<unknown>((acc, k) => ({ [k]: acc }), v);
}

/** A raw operation applied to a JS value (in place): the intended step. */
export function applyRawOp(step: Record<string, unknown>, op: RawOp): void {
  const parentOf = (path: readonly string[]) => (path.length ? getAt(step, path) : step) as Record<string, unknown>;
  switch (op.op) {
    case 'scalar':
    case 'replace':
      parentOf(op.path.slice(0, -1))[op.path[op.path.length - 1]] = structuredClone(op.value);
      return;
    case 'add':
      parentOf(op.path)[op.key] = structuredClone(op.value);
      return;
    case 'remove':
      delete parentOf(op.path)[op.key];
      return;
  }
}

/**
 * The raw operations that set field `segs` of `step` to `to` (absent: remove), shorthands kept when only their own
 * field changes. Throws StepEditError when the step is written in a way a field cannot change.
 */
export function planField(step: Record<string, unknown>, action: ActionName, segs: readonly string[], to: FormValue | undefined): RawOp[] {
  const f = segs[segs.length - 1];
  let cur: Record<string, unknown> = step;
  for (let i = 0; i < segs.length - 1; i++) {
    const containerPath = segs.slice(0, i + 1);
    const next = cur[segs[i]];
    if (next === undefined) {
      if (to === undefined) return [];
      // The container is not written yet (`type.into`, `caption`): added whole — as its shorthand when that reads the same.
      const value = nest(segs.slice(i + 1), to) as Record<string, unknown>;
      const short = shorthandOf(action, containerPath.join('.'), value);
      return [{ op: 'add', path: segs.slice(0, i), key: segs[i], value: short ?? value }];
    }
    if (isFormValue(next)) {
      // A shorthand (`click: Save`): changed in place when the new value still reads as that one field, else an object.
      const expanded = expandShorthand(action, containerPath.join('.'), next);
      if (!expanded) throw new StepEditError('not_editable', `${containerPath.join('.')} is written in a form these fields cannot change: edit it in the YAML view`);
      const obj = structuredClone(expanded);
      let o: Record<string, unknown> = obj;
      const rest = segs.slice(i + 1);
      for (const k of rest.slice(0, -1)) {
        if (o[k] === undefined) o[k] = {};
        if (!isPlainObj(o[k])) throw new StepEditError('not_editable', `${segs.join('.')} cannot be changed here: edit it in the YAML view`);
        o = o[k] as Record<string, unknown>;
      }
      if (to === undefined) delete o[rest[rest.length - 1]];
      else o[rest[rest.length - 1]] = to;
      if (Object.keys(obj).length === 0) throw new StepEditError('invalid', `${containerPath.join('.')} needs a value`);
      const only = shorthandOf(action, containerPath.join('.'), obj);
      if (only !== undefined) return [{ op: 'scalar', path: containerPath, value: only }];
      return [{ op: 'replace', path: containerPath, value: obj }];
    }
    if (!isPlainObj(next)) throw new StepEditError('not_editable', `${containerPath.join('.')} is written in a form these fields cannot change: edit it in the YAML view`);
    cur = next;
  }
  const existing = cur[f];
  if (to === undefined) {
    if (existing === undefined) return [];
    // The last value of a target or a caption: the whole key goes with it (never the action itself).
    let n = segs.length - 1;
    while (n >= 1 && Object.keys(getAt(step, segs.slice(0, n)) as object).length === 1) {
      if (n === 1 && segs[0] === action) throw new StepEditError('invalid', `${action} needs at least one value`);
      n--;
    }
    return [{ op: 'remove', path: segs.slice(0, n), key: segs[n] }];
  }
  if (existing === undefined) return [{ op: 'add', path: segs.slice(0, -1), key: f, value: to }];
  if (isFormValue(existing)) return [{ op: 'scalar', path: [...segs], value: to }];
  throw new StepEditError('not_editable', `${segs.join('.')} is written in a form these fields cannot change: edit it in the YAML view`);
}

/** The text and composed document of a file, with each node's source token (CST edits). */
export function composeWithTokens(text: string): { tokens: CST.Token[]; contents: Node | null } {
  const tokens = [...new Parser().parse(text)];
  const [doc] = [...new Composer({ keepSourceTokens: true, uniqueKeys: true }).compose(tokens)];
  return { tokens, contents: (doc?.contents ?? null) as Node | null };
}

/** The node of a map path under `from` (a key's value), refusing aliases. */
export function nodeIn(from: Node | null, path: readonly string[], what: string): Node | null {
  let cur: Node | null = from;
  for (const k of path) {
    if (isAlias(cur)) throw new StepEditError('not_editable', `${what} is written with a YAML alias: edit it in the YAML view`);
    if (!isMap(cur)) return null;
    cur = ((cur as YAMLMap).items.find((p) => isScalar(p.key) && (p.key as Scalar).value === k)?.value ?? null) as Node | null;
  }
  if (isAlias(cur)) throw new StepEditError('not_editable', `${what} is written with a YAML alias: edit it in the YAML view`);
  return cur;
}

/** The step node `index` of scene entry `entry` in a composed document. */
export function stepNodeOf(contents: Node | null, entry: number, index: number): Node | null {
  const scenes = nodeIn(contents, ['scenes'], 'scenes');
  const e = isSeq(scenes) ? ((scenes as YAMLSeq).items[entry] as Node | null) : null;
  const steps = nodeIn(e, ['steps'], 'the steps');
  return isSeq(steps) ? ((steps as YAMLSeq).items[index] as Node | null) : null;
}

export const FLOW_OPTIONS = { lineWidth: 0, flowCollectionPadding: false } as const;

/** A value rendered by yaml on one line: a scalar as yaml writes it, an object as a flow map. */
export function renderFlow(v: unknown): string {
  const doc = new Document(v);
  visit(doc, {
    Map: (_k, n) => {
      n.flow = true;
    },
    Seq: (_k, n) => {
      n.flow = true;
    },
  });
  return doc.toString(FLOW_OPTIONS).replace(/\n$/, '');
}

/** `key: value` rendered by yaml (a flow map for an object). */
export function renderPair(key: string, v: unknown): string {
  const flow = renderFlow({ [key]: v });
  return flow.slice(1, -1);
}

/** The end of a pair's last character (its value, else its key), trailing spaces left out. */
export function pairEnd(text: string, p: Pair<Node, Node | null>): number {
  let e = (p.value ?? p.key).range![1];
  while (e > p.key.range![0] && /\s/.test(text[e - 1] ?? '')) e--;
  return e;
}

/**
 * One raw operation applied to the text (the step at `entry` / `index`); `want`: the step it must parse to — the whole
 * file must then parse to the file's value with that step (an anchored value changed under an alias elsewhere: refused).
 */
export function applyRawOpText(ctx: Ctx, text: string, o: { entry: number; index: number; op: RawOp; want: unknown; what: string }): string {
  const { entry, index, op, want, what } = o;
  const whole = cloneValue(ctx.value);
  (whole.scenes[entry] as { steps: unknown[] }).steps[index] = want;
  const check = (out: string): boolean => verifyStepText(out, whole);
  const refuse = () => new StepEditError('not_editable', `${what} cannot be written here without changing other parts of the file: change it in the YAML view`);
  const { tokens, contents } = composeWithTokens(text);
  const step = stepNodeOf(contents, entry, index);
  if (!step) throw refuse();
  if (op.op === 'scalar') {
    const node = nodeIn(step, op.path, what);
    if (!isScalar(node) || !node.srcToken) throw refuse();
    const str = String(op.value);
    const types: Array<Scalar.Type | undefined> = [undefined, typeof op.value === 'string' ? 'QUOTE_DOUBLE' : 'PLAIN'];
    for (const type of types) {
      const { tokens: t2, contents: c2 } = type === undefined ? { tokens, contents } : composeWithTokens(text);
      const n2 = nodeIn(stepNodeOf(c2, entry, index), op.path, what) as Scalar;
      CST.setScalarValue(n2.srcToken!, str, type ? { type } : {});
      const out = t2.map((t) => CST.stringify(t)).join('');
      if (check(out)) return out;
    }
    throw refuse();
  }
  if (op.op === 'replace') {
    const node = nodeIn(step, op.path, what);
    if (!node?.range || (isCollection(node) && !node.flow)) throw refuse();
    const out = text.slice(0, node.range[0]) + renderFlow(op.value) + text.slice(node.range[1]);
    if (check(out)) return out;
    throw refuse();
  }
  const map = op.path.length ? nodeIn(step, op.path, what) : step;
  if (!isMap(map)) throw refuse();
  const items = (map as YAMLMap).items as Array<Pair<Node, Node | null>>;
  let out: string;
  if (op.op === 'add') {
    const pair = renderPair(op.key, op.value);
    if ((map as YAMLMap).flow) {
      if (items.length === 0) {
        const open = text.indexOf('{', map.range![0]);
        out = `${text.slice(0, open + 1)}${pair}${text.slice(open + 1)}`;
      } else {
        const at = pairEnd(text, items[items.length - 1]);
        out = `${text.slice(0, at)}, ${pair}${text.slice(at)}`;
      }
    } else {
      const first = items[0]?.key.range?.[0];
      if (first === undefined) throw refuse();
      const col = first - lineStartOf(text, first);
      const at = lineEndOf(text, pairEnd(text, items[items.length - 1]) - 1);
      const s = insertLines(text, at, `${' '.repeat(col)}${pair}${ctx.eol}`, ctx.eol);
      out = applySplices(text, [s]);
    }
  } else {
    const pair = items.find((p) => isScalar(p.key) && (p.key as Scalar).value === op.key);
    if (!pair || items.length < 2) throw refuse();
    const dashLine = map === step ? itemLines(text, stepsSeqOf(contents, entry) as YAMLSeq, index, what).dashLine : lineStartOf(text, map.range![0]);
    const [a, b] = pairRemoval(text, map as YAMLMap, pair, dashLine);
    out = text.slice(0, a) + text.slice(b);
  }
  if (check(out)) return out;
  throw refuse();
}

/** The text re-parses (core parseYaml: aliases checked) to exactly `intended`. */
export const verifyStepText = (text: string, intended: unknown): boolean => verifyEditText(text, intended) === null;

export function stepsSeqOf(contents: Node | null, entry: number): Node | null {
  const scenes = nodeIn(contents, ['scenes'], 'scenes');
  const e = isSeq(scenes) ? ((scenes as YAMLSeq).items[entry] as Node | null) : null;
  return nodeIn(e, ['steps'], 'the steps');
}

/** "type text", "click in", "caption text". */
export const fieldWords = (key: string) => key.replace(/\./g, ' ').replace(/_/g, ' ');

export function setStep(ctx: Ctx, edit: Extract<StepEdit, { kind: 'set_step' }>): StepEditApplied {
  const { scene, raw } = stepAt(ctx, edit.at);
  const what = `step ${edit.at.index + 1} of ${scene.id}`;
  const form = stepFormValues(raw);
  if (!form || !isPlainObj(raw)) throw new StepEditError('not_editable', `${what} has no form (not one action, or an action edited in the YAML view)`);
  const action = form.action;
  if (!Array.isArray(edit.changes) || edit.changes.length === 0) throw new StepEditError('invalid', 'no change to make');
  const seen = new Set<string>();
  const expected: Record<string, FormValue> = { ...form.values };
  const work = structuredClone(raw) as Record<string, unknown>;
  const ops: RawOp[] = [];
  for (const c of edit.changes) {
    const key = c.path.join('.');
    const field = fieldOf(action, key);
    if (!field) throw new StepEditError('invalid', `${key} is not a value the Studio edits on a ${action} step: change it in the YAML view`);
    if (seen.has(key)) throw new StepEditError('invalid', `${key} is changed twice in one edit`);
    seen.add(key);
    if (form.locked[key]) throw new StepEditError('not_editable', `${key} ${form.locked[key]}`, key);
    const now = readField(raw, action, key);
    const current = 'value' in now ? now.value : undefined;
    // Applied only while the step still holds what the form showed — a value changed meanwhile is kept.
    if (!isDeepStrictEqual(current, c.from)) {
      throw new StepEditError('stale', `${key} of ${what} changed meanwhile (it is now ${current === undefined ? 'not set' : JSON.stringify(current)}): read the file again`, key);
    }
    if (c.to !== undefined) {
      const kind = fieldKindProblem(field, c.to);
      if (kind) throw new StepEditError('invalid', kind, key);
      if (typeof c.to === 'string') {
        const p = editValueProblem(c.to, { field: key });
        if (p) throw new StepEditError('invalid', p, key);
      }
    } else if (field.required && field.group === undefined) throw new StepEditError('invalid', `${key} needs a value`, key);
    if (isDeepStrictEqual(c.to, c.from)) continue;
    if (c.to === undefined) delete expected[key];
    else expected[key] = c.to;
    for (const op of planField(work, action, c.path, c.to)) {
      applyRawOp(work, op);
      ops.push(op);
    }
  }
  if (ops.length === 0) throw new StepEditError('invalid', `nothing to change: ${what} already holds these values`);
  // The written step must read back as the form's values with the changes, and nothing else (a shorthand kept only
  // when it still means the same thing).
  const after = stepFormValues(work);
  if (!after || !isDeepStrictEqual(after.values, expected)) {
    throw new StepEditError('not_editable', `${what} cannot take these values without changing what else it says: change it in the YAML view`);
  }
  // Apply the operations one by one to the text, each checked against the step it must give.
  let text = ctx.text;
  const step = structuredClone(raw) as Record<string, unknown>;
  for (const op of ops) {
    applyRawOp(step, op);
    text = applyRawOpText(ctx, text, { entry: scene.entry, index: edit.at.index, op, want: step, what });
  }
  // A file without a final line break keeps it so (a line added at its end brought one).
  if (!ctx.text.endsWith('\n') && text.endsWith('\n')) text = text.slice(0, text.endsWith(ctx.eol) ? -ctx.eol.length : -1);
  const intended = cloneValue(ctx.value);
  (intended.scenes[scene.entry] as { steps: unknown[] }).steps[edit.at.index] = work;
  const keys = [...seen].filter((k) => !isDeepStrictEqual(form.values[k], expected[k]));
  return {
    text,
    intended,
    label: `Changed ${keys.map(fieldWords).join(', ')} of step ${edit.at.index + 1} of ${scene.id}`,
    select: `${scene.id}.${edit.at.index}`,
    notices: [],
  };
}

/** A new step's raw value from its form values (object form; its shorthand when that reads the same). */
export function newStepValue(action: ActionName, values: Record<string, FormValue>): Record<string, unknown> {
  if (!(ACTION_NAMES as readonly string[]).includes(action)) throw new StepEditError('invalid', `unknown action "${String(action).slice(0, 40)}"`);
  const form = actionFormOf(action);
  if (!form.palette) throw new StepEditError('invalid', `a ${action} step is added in the YAML view (it is not in the palette)`);
  const entries = Object.entries(values ?? {});
  for (const [key, v] of entries) {
    const field = form.fields.find((f) => f.key === key);
    if (!field) throw new StepEditError('invalid', `${key} is not a value of a ${action} step the Studio sets`);
    const kind = fieldKindProblem(field, v);
    if (kind) throw new StepEditError('invalid', kind, key);
    if (typeof v === 'string') {
      const p = editValueProblem(v, { field: key });
      if (p) throw new StepEditError('invalid', p, key);
    }
  }
  for (const f of form.fields) if (f.required && f.group === undefined && values[f.key] === undefined) throw new StepEditError('invalid', `${f.key} needs a value`, f.key);
  const scalar = form.fields.find((f) => f.key === action);
  if (scalar) return { [action]: values[action] };
  if (entries.length === 0) throw new StepEditError('invalid', `a ${action} step needs at least one value`);
  const obj: Record<string, unknown> = {};
  const order = (k: string) => form.fields.findIndex((f) => f.key === k);
  for (const [key, v] of [...entries].sort((a, b) => order(a[0]) - order(b[0]))) {
    const segs = key.split('.').slice(1);
    let o = obj;
    for (const k of segs.slice(0, -1)) o = (o[k] ??= {}) as Record<string, unknown>;
    o[segs[segs.length - 1]] = v;
  }
  // A target with one value that its string form says the same: written as that string (`into: Message`).
  for (const [k, v] of Object.entries(obj)) {
    const short = isPlainObj(v) ? shorthandOf(action, `${action}.${k}`, v) : undefined;
    if (short !== undefined) obj[k] = short;
  }
  const short = shorthandOf(action, action, obj);
  return { [action]: short ?? obj };
}

/** A new step as whole lines (dash at column 0, `\n` line breaks): one flow line up to 120 characters, else a block. */
export function renderNewStep(step: Record<string, unknown>): string {
  const [action] = Object.keys(step);
  const line = `- ${renderPair(action, step[action])}`;
  if (line.length <= 120 && !line.includes('\n')) return `${line}\n`;
  const block = new Document(step).toString({ lineWidth: 0 });
  return block
    .replace(/\n$/, '')
    .split('\n')
    .map((l, i) => `${i === 0 ? '- ' : '  '}${l}`)
    .join('\n')
    .concat('\n');
}

export function insertStep(ctx: Ctx, edit: Extract<StepEdit, { kind: 'insert_step' }>): StepEditApplied {
  const scene = sceneSteps(ctx, edit.to.scene);
  const j = edit.to.index;
  if (!Number.isInteger(j) || j < 0 || j > scene.values.length) throw new StepEditError('stale', `scene ${scene.id} has no position ${j + 1} (any more): read the file again`);
  // The step it goes after must still be the one the client showed there (a step added or moved meanwhile: stale).
  const before = j > 0 ? stepGuard(scene.values[j - 1]) : null;
  if (before !== edit.after) throw new StepEditError('stale', `scene ${scene.id} changed around position ${j + 1} since it was read: read the file again`);
  const step = newStepValue(edit.action, edit.values);
  const block = renderNewStep(step).replace(/\n/g, ctx.eol);
  const splices = insertion(ctx, scene, j, { block, dashCol: 0, keyColFrom: -2 });
  const intended = cloneValue(ctx.value);
  (intended.scenes[scene.entry] as { steps: unknown[] }).steps.splice(j, 0, step);
  return {
    text: finish(ctx, splices),
    intended,
    label: `Added a ${edit.action.replace(/_/g, ' ')} step at position ${j + 1} of ${scene.id}`,
    select: `${scene.id}.${j}`,
    notices: [],
  };
}

/**
 * One step edit applied to a scenario's text (see the header): the new text, the value it must parse to, the label,
 * the step to select and the notices. Throws StepEditError (stale, not editable, invalid). The caller verifies the
 * text (verifyEditText) before writing it.
 */
