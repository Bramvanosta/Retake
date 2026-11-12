/**
 * Step structure edits from the Studio's Blocks tab (L4.3 part 2, R-UI-11 / R-UI-12): move a step (within its scene or
 * to another one, an empty one included), delete it, duplicate it — as splices of the file's text, never a
 * re-serialisation: every byte outside the lines an edit touches stays as it was (comments, quoting, blank lines, line
 * breaks, a missing final line break). Pure; the engine (scenarios.edit) re-parses the result and refuses it unless its
 * value is exactly `intended` (core verifyEditText) — the splice model may refuse an unusual file, never corrupt it.
 *
 * - A step's span: its dash line to the end of its last content line (an inline comment on it included), plus the
 *   comment lines that belong to it (critique B6, by column, never a line regex alone): the contiguous `#` lines just
 *   above the dash line at the dash's own column (not past the previous step's end or the `steps:` line), and the
 *   contiguous `#` lines just after it indented deeper than the dash (a commented-out modifier). A comment at another
 *   column (a section header at column 0) and blank lines stay where they are.
 * - Moving to a list whose dash sits at another column re-indents the span by the difference (a line less indented
 *   than its dash is refused). The only step moved out or deleted leaves `steps: []`; a step moved into `steps: []`
 *   turns it into a block list.
 * - Not editable (each with why, also shown on the block — blocks.ts `locked`): a step or scene written as a YAML alias,
 *   steps written as a non-empty flow list (`steps: [a, b]`), the steps of a scene with a dash item not written plainly
 *   (stepsDashWhy: an anchor, a tag or a comment after the dash is fine), a duplicate of a step holding an anchor (`&x`
 *   would be defined twice), removing a key of a flow map written over several lines or holding comments.
 * - Duplicate (critique B8): the copy (without the comments around the original) drops `id` (ids are unique) and
 *   `mark` (a mark names one moment), and a capture's `as` (capture_text, download, wait_for_email: names are unique)
 *   gets the first free `-2`, `-3`… suffix; each change is a notice.
 * - Steps are addressed by scene id + index + `guard` (critique B2: stepGuard, the canonical JSON of the step as
 *   written, modifiers included): an edit re-sent on a newer version ("Apply it to the new version") is refused as
 *   stale when that place now holds another step, instead of moving a neighbour.
 */
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { CST, Composer, Document, Parser, isAlias, isCollection, isMap, isScalar, isSeq, visit } from 'yaml';
import type { Node, Pair, Scalar, YAMLMap, YAMLSeq } from 'yaml';
import { canonicalJson } from './canonical-json.js';
import { editValueProblem, verifyEditText } from './scenario-edit.js';
import { actionFormOf, expandShorthand, fieldKindProblem, fieldOf, readField, shorthandOf, stepFormValues } from './step-forms.js';
import type { FormValue } from './step-forms.js';
import { stepActionKeys } from './steps.js';
import { ACTION_NAMES } from './types.js';
import type { ActionName } from './types.js';
import { parseYaml } from './validation/yaml-source.js';

/** Where a step is: its scene's id, its index in that scene, and its guard (stepGuard of the step the client showed). */
export interface StepAt {
  scene: string;
  index: number;
  guard: string;
}

/**
 * One field of a step changed (critique B2: a patch, never the whole step): `path` is the field's key in object form
 * (step-forms.ts: "type.text", "click.in", "caption.text", "hold"); `from` the value the form showed (absent: none),
 * `to` the new one (absent: removed). Applied only while the step still holds `from` there — a field changed meanwhile
 * is never reverted.
 */
export interface FieldChange {
  path: string[];
  from?: FormValue;
  to?: FormValue;
}

export type StepEdit =
  /** `to.index`: the step's index in the destination scene once moved (in its own scene: counted without it). */
  | { kind: 'move_step'; from: StepAt; to: { scene: string; index: number } }
  | { kind: 'delete_step'; at: StepAt }
  | { kind: 'duplicate_step'; at: StepAt }
  /** Change fields of a step (the inspector's form). */
  | { kind: 'set_step'; at: StepAt; changes: FieldChange[] }
  /**
   * Add a step (the palette): `action` with its form `values`, at `to.index` of `to.scene`; `after` is the guard of the
   * step just before that place as the client showed it (null at the start of the scene).
   */
  | { kind: 'insert_step'; to: { scene: string; index: number }; after: string | null; action: ActionName; values: Record<string, FormValue> };

export const STEP_EDIT_KINDS = ['move_step', 'delete_step', 'duplicate_step', 'set_step', 'insert_step'] as const;

export interface StepEditApplied {
  text: string;
  /** The value the text must parse to (the edit applied to the parsed file): what the engine verifies. */
  intended: unknown;
  /** "Moved step 3 of request to position 1". */
  label: string;
  /** The step to select after the edit ("<scene>.<index>"), or null. */
  select: string | null;
  notices: string[];
}

/** Why a step edit cannot be made: `stale` (the file no longer has that step there), `not_editable`, `invalid`. */
export class StepEditError extends Error {
  constructor(
    readonly code: 'stale' | 'not_editable' | 'invalid',
    message: string,
    /** The form field it is about ("type.cps"), when it is about one. */
    readonly field?: string,
  ) {
    super(message);
    this.name = 'StepEditError';
  }
}

/** A step's guard (critique B2): the first 16 hex characters of the sha256 of its canonical JSON as written. */
export function stepGuard(raw: unknown): string {
  return createHash('sha256').update(canonicalJson(raw)).digest('hex').slice(0, 16);
}

/** The actions whose `as` names a capture that must be unique (checks/scenario: a duplicate is an error). */
const CAPTURE_AS: Record<string, string> = { capture_text: 'text', download: 'document', wait_for_email: 'email' };

// ── Text geometry ───────────────────────────────────────────────────────────

const lineStartOf = (text: string, off: number): number => text.lastIndexOf('\n', off - 1) + 1;
const lineEndOf = (text: string, off: number): number => {
  const e = text.indexOf('\n', off);
  return e < 0 ? text.length : e + 1;
};
/** The line holding `off` without its line break. */
const lineAt = (text: string, start: number): string => text.slice(start, lineEndOf(text, start)).replace(/\r?\n$/, '');
/** A comment line's column (its `#`), or -1 when the line is not a comment line indented with spaces only. */
function commentColumn(line: string): number {
  const m = /^( *)#/.exec(line);
  return m ? m[1].length : -1;
}

interface Span {
  /** First line of the comment lines it owns above (or its dash line). */
  start: number;
  dashLine: number;
  dashCol: number;
  /** End of its last content line (line break included, when there is one). */
  contentEnd: number;
  /** End of the deeper comment lines that follow it (or contentEnd). */
  end: number;
}

/** The text's line break (CR LF when most of its line breaks are). */
function eolOf(text: string): string {
  const crlf = text.match(/\r\n/g)?.length ?? 0;
  const all = text.match(/\n/g)?.length ?? 0;
  return crlf > 0 && crlf * 2 >= all ? '\r\n' : '\n';
}

/**
 * Where the dash of a block sequence's item is (offset of the `-`), else why it is not a "- " item: the dash may be
 * followed by the value's anchor or tag and by a comment (review B L4: `- &s` or `- # note`, then the keys on the next
 * lines — the value's range starts after them), which travel with the dash line.
 */
function dashOf(text: string, node: Node): { at: number } | { why: string } {
  let p = node.range![0] - 1;
  while (p >= 0 && (text[p] === ' ' || text[p] === '\n' || text[p] === '\r')) p--;
  const line = p >= 0 ? lineStartOf(text, p) : 0;
  if (p >= 0 && text[p] === '-' && /^ *$/.test(text.slice(line, p))) return { at: p };
  // The dash, then only anchors / tags up to the value (`- &s {click: Save}`, `- &s⏎`), or a comment ending the line.
  const head = /^( *)-(?: +[&!][^\s,{}[\]]*)*$/.exec(text.slice(line, p + 1));
  const commented = /^( *)-(?: +[&!][^\s,{}[\]]*)* +#[^\r\n]*$/.exec(text.slice(line, lineEndOf(text, Math.max(p, 0))).replace(/\r?\n$/, ''));
  const m = head ?? commented;
  if (m && p >= 0) return { at: line + m[1].length };
  return { why: 'is not written as a plain "- " item (a tab after the dash or its anchor, something before it on the line)' };
}

/**
 * Why the steps of a block list take no block edit because of how one of them is written (dashOf; review B L4), or
 * undefined: an edit of a step also needs where its neighbours are, so one such step locks its scene's steps.
 */
export function stepsDashWhy(text: string, stepsNode: unknown): string | undefined {
  if (!isSeq(stepsNode) || stepsNode.flow) return undefined;
  for (let i = 0; i < stepsNode.items.length; i++) {
    const node = stepsNode.items[i] as Node | null;
    if (!node || isAlias(node) || !node.range) continue;
    const d = dashOf(text, node);
    if ('why' in d) return `step ${i + 1} of its scene ${d.why}: edit these steps in the YAML view`;
  }
  return undefined;
}

/** Where item `i` of a block sequence is written: its dash line and column, the end of its last content line. */
function itemLines(text: string, seq: YAMLSeq, i: number, what: string): Pick<Span, 'dashLine' | 'dashCol' | 'contentEnd'> {
  const node = seq.items[i] as Node | null;
  const range = node?.range;
  if (!node || !range) throw new StepEditError('not_editable', `${what} has no position in the file: edit it in the YAML view`);
  const d = dashOf(text, node);
  if ('why' in d) throw new StepEditError('not_editable', `${what} ${d.why}: edit it in the YAML view`);
  const p = d.at;
  const dashLine = lineStartOf(text, p);
  let e = range[1];
  while (e > range[0] && /\s/.test(text[e - 1] ?? '')) e--;
  return { dashLine, dashCol: p - dashLine, contentEnd: lineEndOf(text, Math.max(e - 1, p)) };
}

/** The span of item `i` of a block sequence; `lower0`: where comment lines above item 0 may start (after the key's line). */
function itemSpan(text: string, seq: YAMLSeq, i: number, lower0: number, what: string): Span {
  const { dashLine, dashCol, contentEnd } = itemLines(text, seq, i, what);
  // Deeper comment lines right after it (a commented-out modifier) are its own.
  let end = contentEnd;
  while (end < text.length && commentColumn(lineAt(text, end)) > dashCol) end = lineEndOf(text, end);
  // Comment lines just above, at the dash's column, after the previous item (or the `steps:` line).
  const lower = i > 0 ? itemLines(text, seq, i - 1, what).contentEnd : lower0;
  let start = dashLine;
  while (start > lower) {
    const prev = lineStartOf(text, start - 1);
    if (prev < lower || commentColumn(lineAt(text, prev)) !== dashCol) break;
    start = prev;
  }
  return { start, dashLine, dashCol, contentEnd, end };
}

/** `block` (whole lines) moved from dash column `from` to `to`. */
function reindent(block: string, from: number, to: number): string {
  if (from === to) return block;
  return block
    .split(/(?<=\n)/)
    .map((l) => {
      if (l.trim() === '') return l;
      const cur = /^ */.exec(l)![0].length;
      if (cur < from) throw new StepEditError('not_editable', 'a line of this step is less indented than its dash: move it in the YAML view');
      return ' '.repeat(cur - from + to) + l.slice(cur);
    })
    .join('');
}

/** One replacement of `[at, at + remove)` of the original text. */
interface Splice {
  at: number;
  remove: number;
  insert: string;
}

function applySplices(text: string, splices: Splice[]): string {
  const sorted = [...splices].sort((a, b) => b.at - a.at);
  let out = text;
  let limit = Infinity;
  for (const s of sorted) {
    if (s.at + s.remove > limit) throw new StepEditError('not_editable', 'this edit touches overlapping parts of the file: make it in the YAML view');
    out = out.slice(0, s.at) + s.insert + out.slice(s.at + s.remove);
    limit = s.at;
  }
  return out;
}

/** Whole lines to insert at `at`: after a last line without a line break, the break comes first. */
function insertLines(text: string, at: number, block: string, eol: string): Splice {
  const body = block.endsWith('\n') ? block : `${block}${eol}`;
  return { at, remove: 0, insert: at > 0 && text[at - 1] !== '\n' ? `${eol}${body}` : body };
}

// ── The file's scenes ───────────────────────────────────────────────────────

interface SceneSteps {
  /** Index among `scenes:` entries. */
  entry: number;
  id: string;
  /** The scene's steps as parsed (the value side). */
  values: unknown[];
  seq: YAMLSeq;
  /** `steps: []` written as a flow list (only an empty one is editable: a destination). */
  flow: boolean;
  /** Offset just after the `steps` key's colon. */
  colon: number;
  /** The `steps` key's column. */
  keyCol: number;
  /** Where comment lines above the first step may start: the line after `steps:`. */
  lower: number;
}

interface Ctx {
  text: string;
  eol: string;
  value: { scenes: unknown[] } & Record<string, unknown>;
  scenesSeq: YAMLSeq;
}

function context(text: string): Ctx {
  const parsed = parseYaml(text);
  if (parsed.value === undefined || parsed.issues.some((i) => i.severity === 'error')) {
    throw new StepEditError('not_editable', 'the file is not valid YAML: fix it in the YAML view first');
  }
  const doc = parsed.source.doc;
  const root = doc.contents;
  const value = parsed.value as Record<string, unknown>;
  if (!isMap(root) || !value || typeof value !== 'object' || !Array.isArray(value.scenes)) {
    throw new StepEditError('not_editable', 'the file has no `scenes:` list: edit it in the YAML view');
  }
  const pair = root.items.find((p) => isScalar(p.key) && p.key.value === 'scenes');
  const seq = pair?.value;
  if (!isSeq(seq)) throw new StepEditError('not_editable', '`scenes:` is written as a YAML alias: edit the file in the YAML view');
  return { text, eol: eolOf(text), value: value as Ctx['value'], scenesSeq: seq };
}

function sceneSteps(ctx: Ctx, id: string): SceneSteps {
  const k = ctx.value.scenes.findIndex((e) => e && typeof e === 'object' && (e as { id?: unknown }).id === id && Array.isArray((e as { steps?: unknown }).steps));
  if (k < 0) throw new StepEditError('stale', `the file has no scene "${id}" with steps (any more): read it again`);
  const node = ctx.scenesSeq.items[k] as Node | null;
  if (isAlias(node)) throw new StepEditError('not_editable', `scene ${id} is written as a YAML alias: edit it in the YAML view`);
  if (!isMap(node)) throw new StepEditError('not_editable', `scene ${id} is not a mapping: edit it in the YAML view`);
  const pair = (node as YAMLMap).items.find((p) => isScalar(p.key) && p.key.value === 'steps') as Pair<Node, Node | null> | undefined;
  const seq = pair?.value;
  if (!pair || isAlias(seq) || !isSeq(seq)) throw new StepEditError('not_editable', `the steps of scene ${id} are written as a YAML alias: edit them in the YAML view`);
  const key = pair.key as Node;
  const keyRange = key.range!;
  let c = keyRange[1];
  while (ctx.text[c] === ' ') c++;
  if (ctx.text[c] !== ':') throw new StepEditError('not_editable', `the \`steps\` key of scene ${id} is not written as \`steps:\`: edit it in the YAML view`);
  const keyLine = lineStartOf(ctx.text, keyRange[0]);
  const values = (ctx.value.scenes[k] as { steps: unknown[] }).steps;
  if (seq.flow && seq.items.length > 0) {
    throw new StepEditError('not_editable', `the steps of scene ${id} are written as a flow list ([…]): edit them in the YAML view`);
  }
  return { entry: k, id, values, seq, flow: !!seq.flow, colon: c + 1, keyCol: keyRange[0] - keyLine, lower: lineEndOf(ctx.text, c) };
}

/** The step at `at`, checked against the file (index in range, guard equal, not an alias). */
function stepAt(ctx: Ctx, at: StepAt): { scene: SceneSteps; span: Span; node: Node; raw: unknown } {
  const scene = sceneSteps(ctx, at.scene);
  const what = `step ${at.index + 1} of ${at.scene}`;
  if (!Number.isInteger(at.index) || at.index < 0 || at.index >= scene.values.length) {
    throw new StepEditError('stale', `scene ${at.scene} has no step ${at.index + 1} (any more): read the file again`);
  }
  const raw = scene.values[at.index];
  if (stepGuard(raw) !== at.guard) throw new StepEditError('stale', `${what} is not the step the edit was made on (it changed or moved): read the file again`);
  const node = scene.seq.items[at.index] as Node;
  if (isAlias(node)) throw new StepEditError('not_editable', `${what} is written as a YAML alias: edit it in the YAML view`);
  return { scene, span: itemSpan(ctx.text, scene.seq, at.index, scene.lower, what), node, raw };
}

/** Removing `span` from `scene`; its last step leaves `steps: []`. */
function removal(ctx: Ctx, scene: SceneSteps, span: Span): Splice[] {
  const out: Splice[] = [{ at: span.start, remove: span.end - span.start, insert: '' }];
  if (scene.values.length === 1) out.push({ at: scene.colon, remove: 0, insert: ' []' });
  return out;
}

/** The step's block as it moves: whole lines ending with a line break. */
function blockOf(ctx: Ctx, span: Span, from = span.start, to = span.end): string {
  const b = ctx.text.slice(from, to);
  return b.endsWith('\n') ? b : `${b}${ctx.eol}`;
}

/** Inserting `block` (dash at `dashCol`) as step `index` of `scene` (index counted on the scene as it is in the file). */
function insertion(ctx: Ctx, scene: SceneSteps, index: number, block: string, dashCol: number, keyColFrom: number): Splice[] {
  if (scene.values.length === 0) {
    // `steps: []` → a block list under the key, the source's indentation relative to its own key kept.
    const flowRange = scene.seq.range!;
    const lineStart = lineStartOf(ctx.text, flowRange[0]);
    let cut = flowRange[0];
    while (cut > lineStart && ctx.text[cut - 1] === ' ') cut--;
    const lineEnd = lineEndOf(ctx.text, Math.max(flowRange[0], flowRange[1] - 1));
    const rest = ctx.text.slice(flowRange[1], lineEnd);
    const to = scene.keyCol + Math.max(0, dashCol - keyColFrom);
    return [{ at: cut, remove: lineEnd - cut, insert: `${rest.endsWith('\n') ? rest : `${rest}${ctx.eol}`}${reindent(block, dashCol, to)}` }];
  }
  if (index < scene.values.length) {
    const t = itemSpan(ctx.text, scene.seq, index, scene.lower, `step ${index + 1} of ${scene.id}`);
    return [insertLines(ctx.text, t.start, reindent(block, dashCol, t.dashCol), ctx.eol)];
  }
  const last = itemSpan(ctx.text, scene.seq, scene.values.length - 1, scene.lower, `step ${scene.values.length} of ${scene.id}`);
  return [insertLines(ctx.text, last.end, reindent(block, dashCol, last.dashCol), ctx.eol)];
}

/** The text after the splices, keeping the file's final-line-break state. */
function finish(ctx: Ctx, splices: Splice[]): string {
  let out = applySplices(ctx.text, splices);
  const had = ctx.text === '' || ctx.text.endsWith('\n');
  if (!had && out.endsWith('\n')) out = out.slice(0, out.endsWith(`${ctx.eol}`) ? -ctx.eol.length : -1);
  return out;
}

function cloneValue<T>(v: T): T {
  return structuredClone(v);
}

/** The end of the last value written in a node (a scalar, an alias, a flow collection): trailing comment lines left out. */
function lastValueEnd(n: Node): number {
  let end = n.range?.[0] ?? 0;
  const at = (x: { range?: [number, number, number] | null }) => {
    if (x.range) end = Math.max(end, x.range[1]);
  };
  if (isScalar(n) || isAlias(n) || (isCollection(n) && n.flow)) at(n);
  else
    visit(n, {
      Scalar: (_k, x) => at(x),
      Alias: (_k, x) => at(x),
      Map: (_k, x) => (x.flow ? (at(x), visit.SKIP) : undefined),
      Seq: (_k, x) => (x.flow ? (at(x), visit.SKIP) : undefined),
    });
  return end;
}

/** Every anchor (`&x`) defined in a node. */
function holdsAnchor(n: unknown): string | undefined {
  if (!n || typeof n !== 'object') return undefined;
  const node = n as { anchor?: string; items?: unknown[]; key?: unknown; value?: unknown };
  if (typeof node.anchor === 'string' && node.anchor) return node.anchor;
  if (Array.isArray(node.items))
    for (const it of node.items) {
      const a = holdsAnchor(it);
      if (a) return a;
    }
  if ('key' in node || 'value' in node) return holdsAnchor(node.key) ?? holdsAnchor(node.value);
  return undefined;
}

// ── The edits ───────────────────────────────────────────────────────────────

function moveStep(ctx: Ctx, edit: Extract<StepEdit, { kind: 'move_step' }>): StepEditApplied {
  const { scene: src, span } = stepAt(ctx, edit.from);
  const same = edit.to.scene === edit.from.scene;
  const dst = same ? src : sceneSteps(ctx, edit.to.scene);
  if (dst.flow && dst.values.length > 0) throw new StepEditError('not_editable', `the steps of scene ${dst.id} are written as a flow list: edit them in the YAML view`);
  const room = dst.values.length - (same ? 1 : 0);
  const j = edit.to.index;
  if (!Number.isInteger(j) || j < 0 || j > room) throw new StepEditError('stale', `scene ${dst.id} has no position ${j + 1} (any more): read the file again`);
  if (same && j === edit.from.index) throw new StepEditError('invalid', `step ${j + 1} of ${src.id} is already there: nothing to move`);
  const block = blockOf(ctx, span);
  // Index in the destination as it is in the file (the source still in it when moving within the scene).
  const target = same && j >= edit.from.index ? j + 1 : j;
  const splices = [...removal(ctx, src, span), ...insertion(ctx, dst, target, block, span.dashCol, src.keyCol)];
  const intended = cloneValue(ctx.value);
  const [moved] = (intended.scenes[src.entry] as { steps: unknown[] }).steps.splice(edit.from.index, 1);
  (intended.scenes[dst.entry] as { steps: unknown[] }).steps.splice(j, 0, moved);
  return {
    text: finish(ctx, splices),
    intended,
    label: same ? `Moved step ${edit.from.index + 1} of ${src.id} to position ${j + 1}` : `Moved step ${edit.from.index + 1} of ${src.id} to position ${j + 1} of ${dst.id}`,
    select: `${dst.id}.${j}`,
    notices: [],
  };
}

function deleteStep(ctx: Ctx, edit: Extract<StepEdit, { kind: 'delete_step' }>): StepEditApplied {
  const { scene, span } = stepAt(ctx, edit.at);
  const i = edit.at.index;
  const intended = cloneValue(ctx.value);
  (intended.scenes[scene.entry] as { steps: unknown[] }).steps.splice(i, 1);
  const left = scene.values.length - 1;
  const notices: string[] = [];
  if (span.start < span.dashLine || span.end > span.contentEnd) notices.push('Its comment lines went with it.');
  if (left === 0) notices.push(`Scene ${scene.id} has no step now (steps: []).`);
  return {
    text: finish(ctx, removal(ctx, scene, span)),
    intended,
    label: `Deleted step ${i + 1} of ${scene.id}`,
    select: left === 0 ? null : `${scene.id}.${Math.min(i, left - 1)}`,
    notices,
  };
}

/** Removing a pair from a step's mapping, as offsets of the original text. */
function pairRemoval(text: string, map: YAMLMap, pair: Pair<Node, Node | null>, dashLine: number): [number, number] {
  const items = map.items as Array<Pair<Node, Node | null>>;
  const k = items.indexOf(pair);
  const endOf = (p: Pair<Node, Node | null>) => {
    let e = (p.value ?? p.key).range![1];
    while (e > p.key.range![0] && /\s/.test(text[e - 1] ?? '')) e--;
    return e;
  };
  const keyStart = pair.key.range![0];
  if (map.flow) {
    const cut: [number, number] = k < items.length - 1 ? [keyStart, items[k + 1].key.range![0]] : [endOf(items[k - 1]), endOf(pair)];
    // Review B M3: what lies between the tokens (a scalar value's own characters left out) must hold no comment and no
    // line break — a comment there would go with the cut, though it belongs to the keys that stay.
    const v = pair.value;
    const between = isScalar(v) && v.range ? text.slice(cut[0], v.range[0]) + text.slice(v.range[1], cut[1]) : text.slice(cut[0], cut[1]);
    if (/[#\r\n]/.test(between)) throw new StepEditError('not_editable', 'this {…} map is written over several lines or holds comments: change it in the YAML view');
    return cut;
  }
  if (lineStartOf(text, keyStart) === dashLine) {
    // The pair on the dash line: the next key takes its place there.
    if (k + 1 >= items.length) throw new StepEditError('not_editable', 'this step cannot be copied without its id or mark: duplicate it in the YAML view');
    return [keyStart, items[k + 1].key.range![0]];
  }
  const col = keyStart - lineStartOf(text, keyStart);
  let start = lineStartOf(text, keyStart);
  while (start > dashLine) {
    const prev = lineStartOf(text, start - 1);
    if (commentColumn(lineAt(text, prev)) !== col) break;
    start = prev;
  }
  return [start, lineEndOf(text, endOf(pair) - 1)];
}

function duplicateStep(ctx: Ctx, edit: Extract<StepEdit, { kind: 'duplicate_step' }>): StepEditApplied {
  const { scene, span, node, raw } = stepAt(ctx, edit.at);
  const i = edit.at.index;
  const anchor = holdsAnchor(node);
  if (anchor) throw new StepEditError('not_editable', `step ${i + 1} of ${scene.id} defines the YAML anchor &${anchor}: a copy would define it twice — duplicate it in the YAML view`);
  const copy = cloneValue(raw) as Record<string, unknown>;
  const notices: string[] = [];
  const cuts: Splice[] = [];
  if (isMap(node) && copy && typeof copy === 'object') {
    const map = node as YAMLMap;
    const pairOf = (k: string) => map.items.find((p) => isScalar(p.key) && p.key.value === k) as Pair<Node, Node | null> | undefined;
    for (const [k, why] of [
      ['id', 'step ids are unique'],
      ['mark', 'a mark names one moment'],
    ] as const) {
      const p = pairOf(k);
      if (!p || copy[k] === undefined) continue;
      const [a, b] = pairRemoval(ctx.text, map, p, span.dashLine);
      cuts.push({ at: a, remove: b - a, insert: '' });
      notices.push(`The copy has no ${k}: ${why} (the original keeps "${String(copy[k])}").`);
      delete copy[k];
    }
    const action = stepActionKeys(copy)[0];
    const kind = action ? CAPTURE_AS[action] : undefined;
    const args = action ? copy[action] : undefined;
    const argsNode = action ? pairOf(action)?.value : undefined;
    if (kind && args && typeof args === 'object' && typeof (args as { as?: unknown }).as === 'string' && isMap(argsNode)) {
      const old = (args as { as: string }).as;
      const asNode = (argsNode as YAMLMap).items.find((p) => isScalar(p.key) && p.key.value === 'as')?.value;
      const taken = new Set<string>();
      for (const e of ctx.value.scenes) {
        const steps = e && typeof e === 'object' ? (e as { steps?: unknown }).steps : undefined;
        if (!Array.isArray(steps)) continue;
        for (const s of steps) {
          if (!s || typeof s !== 'object') continue;
          for (const a of Object.keys(CAPTURE_AS)) {
            const v = (s as Record<string, unknown>)[a];
            if (v && typeof v === 'object' && typeof (v as { as?: unknown }).as === 'string') taken.add((v as { as: string }).as);
          }
        }
      }
      let n = 2;
      while (taken.has(`${old}-${n}`)) n++;
      const name = `${old}-${n}`;
      if (!isScalar(asNode) || !asNode.range) throw new StepEditError('not_editable', "this capture's `as` is not a plain value: duplicate it in the YAML view");
      const [s, e] = asNode.range;
      const at = asNode.type === 'PLAIN' ? e : asNode.type === 'QUOTE_DOUBLE' || asNode.type === 'QUOTE_SINGLE' ? e - 1 : -1;
      if (at < 0 || (asNode.type === 'PLAIN' && ctx.text.slice(s, e) !== old)) throw new StepEditError('not_editable', "this capture's `as` is not written on one line: duplicate it in the YAML view");
      cuts.push({ at, remove: 0, insert: `-${n}` });
      (copy[action!] as { as: string }).as = name;
      notices.push(`The copy saves its ${kind} as "${name}": names of captures are unique (the original keeps "${old}").`);
    }
  }
  // The copy: the step's own lines (not the comments around it, nor a comment line after its last value that the node's
  // range takes in: review B), with the cuts above, inserted after the original's span.
  const base = span.dashLine;
  const own = ctx.text.slice(base, Math.min(span.contentEnd, lineEndOf(ctx.text, Math.max(lastValueEnd(node), base + 1) - 1)));
  const copied = applySplices(
    own,
    cuts.map((c) => ({ ...c, at: c.at - base })),
  );
  const intended = cloneValue(ctx.value);
  (intended.scenes[scene.entry] as { steps: unknown[] }).steps.splice(i + 1, 0, copy);
  return {
    text: finish(ctx, [insertLines(ctx.text, span.end, copied, ctx.eol)]),
    intended,
    label: `Duplicated step ${i + 1} of ${scene.id}`,
    select: `${scene.id}.${i + 1}`,
    notices,
  };
}

// ── Value edits (part 3: the inspector's form, the palette) ────────────────
//
// A field change becomes one raw operation on the step as written (critique B4: no step-local document, no re-render):
// - `scalar`: an existing scalar takes the new value through yaml's CST.setScalarValue — only its own characters
//   change, its quoting kept; when the re-parsed value is not the intended one (a plain `123`, `yes`, `a, b` in a flow
//   map…), it is written again double-quoted (a number or yes / no: plain);
// - `replace`: a shorthand that must become an object (`click: Save` + `in: dialog`) → a rendered flow map in its place;
// - `add`: a new key — `, key: value` in a flow map, one `key: value` line in a block map (the map's indentation, the
//   file's line break);
// - `remove`: a key with its comment lines (pairRemoval), the commas of a flow map; a target left empty goes with it.
// Values are rendered by yaml (never concatenated); each operation is re-parsed and must give the intended step, and
// the engine verifies the whole file (verifyEditText).

type RawOp =
  | { op: 'scalar'; path: string[]; value: FormValue }
  | { op: 'replace'; path: string[]; value: Record<string, unknown> }
  | { op: 'add'; path: string[]; key: string; value: unknown }
  | { op: 'remove'; path: string[]; key: string };

const isPlainObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isFormValue = (v: unknown): v is FormValue => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';

/** The value at `path` of a raw value (undefined when absent). */
function getAt(v: unknown, path: readonly string[]): unknown {
  let cur = v;
  for (const k of path) cur = isPlainObj(cur) ? cur[k] : undefined;
  return cur;
}

/** `{a: {b: v}}` for path [a, b]. */
function nest(path: readonly string[], v: unknown): unknown {
  return path.reduceRight<unknown>((acc, k) => ({ [k]: acc }), v);
}

/** A raw operation applied to a JS value (in place): the intended step. */
function applyRawOp(step: Record<string, unknown>, op: RawOp): void {
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
function planField(step: Record<string, unknown>, action: ActionName, segs: readonly string[], to: FormValue | undefined): RawOp[] {
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
function composeWithTokens(text: string): { tokens: CST.Token[]; contents: Node | null } {
  const tokens = [...new Parser().parse(text)];
  const [doc] = [...new Composer({ keepSourceTokens: true, uniqueKeys: true }).compose(tokens)];
  return { tokens, contents: (doc?.contents ?? null) as Node | null };
}

/** The node of a map path under `from` (a key's value), refusing aliases. */
function nodeIn(from: Node | null, path: readonly string[], what: string): Node | null {
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
function stepNodeOf(contents: Node | null, entry: number, index: number): Node | null {
  const scenes = nodeIn(contents, ['scenes'], 'scenes');
  const e = isSeq(scenes) ? ((scenes as YAMLSeq).items[entry] as Node | null) : null;
  const steps = nodeIn(e, ['steps'], 'the steps');
  return isSeq(steps) ? ((steps as YAMLSeq).items[index] as Node | null) : null;
}

const FLOW_OPTIONS = { lineWidth: 0, flowCollectionPadding: false } as const;

/** A value rendered by yaml on one line: a scalar as yaml writes it, an object as a flow map. */
function renderFlow(v: unknown): string {
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
function renderPair(key: string, v: unknown): string {
  const flow = renderFlow({ [key]: v });
  return flow.slice(1, -1);
}

/** The end of a pair's last character (its value, else its key), trailing spaces left out. */
function pairEnd(text: string, p: Pair<Node, Node | null>): number {
  let e = (p.value ?? p.key).range![1];
  while (e > p.key.range![0] && /\s/.test(text[e - 1] ?? '')) e--;
  return e;
}

/**
 * One raw operation applied to the text (the step at `entry` / `index`); `want`: the step it must parse to — the whole
 * file must then parse to the file's value with that step (an anchored value changed under an alias elsewhere: refused).
 */
function applyRawOpText(ctx: Ctx, text: string, entry: number, index: number, op: RawOp, want: unknown, what: string): string {
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
const verifyStepText = (text: string, intended: unknown): boolean => verifyEditText(text, intended) === null;

function stepsSeqOf(contents: Node | null, entry: number): Node | null {
  const scenes = nodeIn(contents, ['scenes'], 'scenes');
  const e = isSeq(scenes) ? ((scenes as YAMLSeq).items[entry] as Node | null) : null;
  return nodeIn(e, ['steps'], 'the steps');
}

/** "type text", "click in", "caption text". */
const fieldWords = (key: string) => key.replace(/\./g, ' ').replace(/_/g, ' ');

function setStep(ctx: Ctx, edit: Extract<StepEdit, { kind: 'set_step' }>): StepEditApplied {
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
    // Critique B2: applied only while the step still holds what the form showed — a value changed meanwhile is kept.
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
    text = applyRawOpText(ctx, text, scene.entry, edit.at.index, op, step, what);
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
function renderNewStep(step: Record<string, unknown>): string {
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

function insertStep(ctx: Ctx, edit: Extract<StepEdit, { kind: 'insert_step' }>): StepEditApplied {
  const scene = sceneSteps(ctx, edit.to.scene);
  const j = edit.to.index;
  if (!Number.isInteger(j) || j < 0 || j > scene.values.length) throw new StepEditError('stale', `scene ${scene.id} has no position ${j + 1} (any more): read the file again`);
  // The step it goes after must still be the one the client showed there (a step added or moved meanwhile: stale).
  const before = j > 0 ? stepGuard(scene.values[j - 1]) : null;
  if (before !== edit.after) throw new StepEditError('stale', `scene ${scene.id} changed around position ${j + 1} since it was read: read the file again`);
  const step = newStepValue(edit.action, edit.values);
  const block = renderNewStep(step).replace(/\n/g, ctx.eol);
  const splices = insertion(ctx, scene, j, block, 0, -2);
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
export function applyStepEdit(text: string, edit: StepEdit): StepEditApplied {
  const ctx = context(text);
  switch (edit.kind) {
    case 'move_step':
      return moveStep(ctx, edit);
    case 'delete_step':
      return deleteStep(ctx, edit);
    case 'duplicate_step':
      return duplicateStep(ctx, edit);
    case 'set_step':
      return setStep(ctx, edit);
    case 'insert_step':
      return insertStep(ctx, edit);
    default: {
      const unknown: never = edit;
      throw new StepEditError('invalid', `unknown step edit "${String((unknown as { kind?: unknown }).kind)}"`);
    }
  }
}

/**
 * Why the steps of a scene (the `steps` node) take no block edit, or undefined (blocks.ts `locked`): written as an
 * alias, or as a non-empty flow list.
 */
export function stepsLockedWhy(stepsNode: unknown, aliased: boolean): string | undefined {
  if (aliased || isAlias(stepsNode)) return 'written as a YAML alias: edit it in the YAML view';
  if (isSeq(stepsNode) && stepsNode.flow && stepsNode.items.length > 0) return 'its scene writes its steps as a flow list ([…]): edit them in the YAML view';
  return undefined;
}

/**
 * The low-level text helpers of this module, shared by field-edits.ts (L4.5, `set_field`: critique B10 — reused by
 * export only, nothing here changed). Not meant for other callers.
 */
export const stepEditText = Object.freeze({
  lineStartOf,
  lineEndOf,
  lineAt,
  commentColumn,
  eolOf,
  applySplices,
  insertLines,
  itemLines,
  pairRemoval,
  composeWithTokens,
  nodeIn,
  renderFlow,
  renderPair,
  pairEnd,
});
