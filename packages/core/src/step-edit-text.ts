/** The text geometry of the step edits (step-edits.ts): a step's span, splices, and the file's scenes. */
import { isAlias, isCollection, isMap, isScalar, isSeq, visit } from 'yaml';
import type { Node, Pair, YAMLMap, YAMLSeq } from 'yaml';
import { StepEditError, stepGuard } from './step-edit-model.js';
import type { StepAt } from './step-edit-model.js';
import { parseYaml } from './validation/yaml-source.js';

// ── Text geometry ───────────────────────────────────────────────────────────

export const lineStartOf = (text: string, off: number): number => text.lastIndexOf('\n', off - 1) + 1;
export const lineEndOf = (text: string, off: number): number => {
  const e = text.indexOf('\n', off);
  return e < 0 ? text.length : e + 1;
};
/** The line holding `off` without its line break. */
export const lineAt = (text: string, start: number): string => text.slice(start, lineEndOf(text, start)).replace(/\r?\n$/, '');
/** A comment line's column (its `#`), or -1 when the line is not a comment line indented with spaces only. */
export function commentColumn(line: string): number {
  const m = /^( *)#/.exec(line);
  return m ? m[1].length : -1;
}

export interface Span {
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
export function eolOf(text: string): string {
  const crlf = text.match(/\r\n/g)?.length ?? 0;
  const all = text.match(/\n/g)?.length ?? 0;
  return crlf > 0 && crlf * 2 >= all ? '\r\n' : '\n';
}

/**
 * Where the dash of a block sequence's item is (offset of the `-`), else why it is not a "- " item: the dash may be
 * followed by the value's anchor or tag and by a comment (`- &s` or `- # note`, then the keys on the next lines — the
 * value's range starts after them), which travel with the dash line.
 */
export function dashOf(text: string, node: Node): { at: number } | { why: string } {
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
 * Why the steps of a block list take no block edit because of how one of them is written (dashOf), or
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
export function itemLines(text: string, seq: YAMLSeq, i: number, what: string): Pick<Span, 'dashLine' | 'dashCol' | 'contentEnd'> {
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
export function itemSpan(text: string, seq: YAMLSeq, i: number, lower0: number, what: string): Span {
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
export function reindent(block: string, from: number, to: number): string {
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
export interface Splice {
  at: number;
  remove: number;
  insert: string;
}

export function applySplices(text: string, splices: Splice[]): string {
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
export function insertLines(text: string, at: number, block: string, eol: string): Splice {
  const body = block.endsWith('\n') ? block : `${block}${eol}`;
  return { at, remove: 0, insert: at > 0 && text[at - 1] !== '\n' ? `${eol}${body}` : body };
}

// ── The file's scenes ───────────────────────────────────────────────────────

export interface SceneSteps {
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

export interface Ctx {
  text: string;
  eol: string;
  value: { scenes: unknown[] } & Record<string, unknown>;
  scenesSeq: YAMLSeq;
}

export function context(text: string): Ctx {
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

export function sceneSteps(ctx: Ctx, id: string): SceneSteps {
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
export function stepAt(ctx: Ctx, at: StepAt): { scene: SceneSteps; span: Span; node: Node; raw: unknown } {
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
export function removal(scene: SceneSteps, span: Span): Splice[] {
  const out: Splice[] = [{ at: span.start, remove: span.end - span.start, insert: '' }];
  if (scene.values.length === 1) out.push({ at: scene.colon, remove: 0, insert: ' []' });
  return out;
}

/** The step's block as it moves: whole lines ending with a line break. */
export function blockOf(ctx: Ctx, span: Span, from = span.start, to = span.end): string {
  const b = ctx.text.slice(from, to);
  return b.endsWith('\n') ? b : `${b}${ctx.eol}`;
}

/**
 * Inserting `block` (dash at `dashCol`; `keyColFrom`: the column of its source's `steps:` key) as step `index` of `scene`
 * (index counted on the scene as it is in the file).
 */
export function insertion(ctx: Ctx, scene: SceneSteps, index: number, moved: { block: string; dashCol: number; keyColFrom: number }): Splice[] {
  const { block, dashCol, keyColFrom } = moved;
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
export function finish(ctx: Ctx, splices: Splice[]): string {
  let out = applySplices(ctx.text, splices);
  const had = ctx.text === '' || ctx.text.endsWith('\n');
  if (!had && out.endsWith('\n')) out = out.slice(0, out.endsWith(`${ctx.eol}`) ? -ctx.eol.length : -1);
  return out;
}

export function cloneValue<T>(v: T): T {
  return structuredClone(v);
}

/** The end of the last value written in a node (a scalar, an alias, a flow collection): trailing comment lines left out. */
export function lastValueEnd(n: Node): number {
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
export function holdsAnchor(n: unknown): string | undefined {
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

/** Removing a pair from a step's mapping, as offsets of the original text. */
export function pairRemoval(text: string, map: YAMLMap, pair: Pair<Node, Node | null>, dashLine: number): [number, number] {
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
    // What lies between the tokens (a scalar value's own characters left out) must hold no comment and no
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
