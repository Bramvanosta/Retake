/**
 * One map path of a YAML file set or removed as a splice of its text (L4.7, critique D A1): the small editor of L4.5's
 * timeline field edits (field-edits.ts), extracted so that a theme's template.yaml (theme-edits.ts) is edited by the same
 * code — never a re-serialisation (step-edits.ts's rules: every byte outside the lines it touches stays). Pure.
 *
 * - The container is the root map, or one item of a top-level sequence (a scenario's `scenes:` entry); a path is one or
 *   two keys below it.
 * - A scalar is set in place (CST, its quoting kept when the value still reads the same, else double-quoted / plain); a
 *   value replaced (a flow value or a scalar rewritten, a block collection written over by a flow one — refused with
 *   `keepComments` when that block holds a comment); a pair added — a new key of the container just before its anchor key
 *   (`insertBefore`, above that key's comment lines), else after the map's last pair, or into a flow map —; a pair removed
 *   with the comment lines that belong to it; removing the last key of a nested map removes the parent pair.
 * - Every step is checked against the whole file's value it must give (core verifyEditText): an anchored value changed
 *   under an alias elsewhere, or any other side effect, is refused, never written.
 */
import { CST, Lexer, isCollection, isMap, isScalar, isSeq } from 'yaml';
import type { Node, Pair, Scalar, YAMLMap, YAMLSeq } from 'yaml';
import { verifyEditText } from './scenario-edit.js';
import { StepEditError, stepEditText } from './step-edits.js';

const { lineStartOf, lineEndOf, lineAt, commentColumn, eolOf, applySplices, insertLines, itemLines, pairRemoval, composeWithTokens, nodeIn, renderFlow, renderPair, pairEnd } = stepEditText;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);
const isScalarValue = (v: unknown): v is string | number | boolean => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';

/** Where the container map is: item `index` of the top-level sequence `seq` (absent: the root map). */
export interface MapEntry {
  seq: string;
  index: number;
}

export interface SetMapPathOptions {
  /** The container: an item of a top-level sequence (a scenario's scene), else the root. */
  entry?: MapEntry;
  /** A new key of the container goes just before this key (with its comment lines); else after its last pair. */
  insertBefore?: string;
  /** A key whose last child cannot be removed (its parent pair would go): refused, naming it. */
  protectedKey?: string;
  /** A block collection holding a comment is never written over (its comments would go): refused. */
  keepComments?: boolean;
  /** Words for refusals ("the layout of scene request"). */
  what: string;
  /** Where the person changes it instead ("change it in the YAML view"). */
  byHand?: string;
}

export interface SetMapPathResult {
  text: string;
  /** The whole file's value the text parses to (the edit applied to the parsed file). */
  intended: Obj;
}

/** A raw operation on the container map (paths relative to it). */
type Op =
  | { op: 'scalar'; path: string[]; value: string | number | boolean }
  | { op: 'replace'; path: string[]; value: unknown }
  | { op: 'add'; path: string[]; key: string; value: unknown }
  | { op: 'remove'; path: string[]; key: string };

function getAt(v: unknown, path: readonly string[]): unknown {
  let cur = v;
  for (const k of path) cur = isObj(cur) ? cur[k] : undefined;
  return cur;
}

function applyOp(container: Obj, op: Op): void {
  const parent = (path: readonly string[]) => (path.length ? getAt(container, path) : container) as Obj;
  switch (op.op) {
    case 'scalar':
    case 'replace':
      parent(op.path.slice(0, -1))[op.path[op.path.length - 1]] = structuredClone(op.value);
      return;
    case 'add':
      parent(op.path)[op.key] = structuredClone(op.value);
      return;
    case 'remove':
      delete parent(op.path)[op.key];
      return;
  }
}

/**
 * The raw operations that set `segs` (one or two keys of the container) to `to` (absent: remove). A collection written
 * there, or a collection given, is replaced whole; a scalar parent of a two-key path (`intro: false`) becomes a map.
 */
function planOps(value: Obj, segs: readonly string[], to: unknown, protectedKey: string | undefined): Op[] {
  const [a, b] = segs;
  if (to === undefined) {
    if (segs.length === 2 && isObj(value[a]) && Object.keys(value[a] as Obj).length === 1) {
      if (a === protectedKey) throw new StepEditError('invalid', `the ${a} needs ${b}: set another one instead`);
      return [{ op: 'remove', path: [], key: a }];
    }
    return [{ op: 'remove', path: segs.slice(0, -1) as string[], key: segs[segs.length - 1] }];
  }
  const setOrReplace = (path: string[], cur: unknown): Op => (isScalarValue(to) && !(cur !== null && typeof cur === 'object') ? { op: 'scalar', path, value: to } : { op: 'replace', path, value: to });
  if (segs.length === 1) {
    const cur = value[a];
    if (cur === undefined) return [{ op: 'add', path: [], key: a, value: to }];
    return [setOrReplace([a], cur)];
  }
  const parent = value[a];
  if (parent === undefined) return [{ op: 'add', path: [], key: a, value: { [b]: to } }];
  // `intro: false` (or `intro:` left empty) → `intro: {component: x}`.
  if (!isObj(parent)) return [{ op: 'replace', path: [a], value: { [b]: to } }];
  if (parent[b] === undefined) return [{ op: 'add', path: [a], key: b, value: to }];
  return [setOrReplace([a, b], parent[b])];
}

interface TextCtx {
  eol: string;
  entry?: MapEntry;
  insertBefore?: string;
  keepComments: boolean;
  byHand: string;
}

/** The container node (root map, or the entry's map) of a composed document. */
function containerNode(contents: Node | null, c: TextCtx): Node | null {
  if (c.entry === undefined) return contents;
  const seq = nodeIn(contents, [c.entry.seq], c.entry.seq);
  return isSeq(seq) ? ((seq as YAMLSeq).items[c.entry.index] as Node | null) : null;
}

/** Where a new key goes in a block map: before the anchor key, above its comment lines. */
function anchorBefore(text: string, map: YAMLMap, key: string, dashLine: number): number | undefined {
  const pair = (map.items as Array<Pair<Node, Node | null>>).find((p) => isScalar(p.key) && (p.key as Scalar).value === key);
  const ks = pair?.key.range?.[0];
  if (ks === undefined) return undefined;
  const line = lineStartOf(text, ks);
  if (line === dashLine || !/^ *$/.test(text.slice(line, ks))) return undefined;
  const col = ks - line;
  let start = line;
  while (start > 0 && start > dashLine) {
    const prev = lineStartOf(text, start - 1);
    if (commentColumn(lineAt(text, prev)) !== col) break;
    start = prev;
  }
  return start;
}

/** Whether a stretch of YAML text holds a comment (its tokens, so a `#` inside a quoted value is not one). */
function holdsComment(text: string): boolean {
  for (const t of new Lexer().lex(text)) if (t.startsWith('#')) return true;
  return false;
}

/** One raw operation applied to the text, checked against the whole file's value it must give (`want`). */
function applyOpText(text: string, c: TextCtx, op: Op, want: unknown, what: string): string {
  const check = (out: string): boolean => verifyEditText(out, want) === null;
  const refuse = () => new StepEditError('not_editable', `${what} cannot be written here without changing other parts of the file: ${c.byHand}`);
  const { tokens, contents } = composeWithTokens(text);
  const box = containerNode(contents, c);
  if (!isMap(box)) throw refuse();
  if (op.op === 'scalar') {
    const node = nodeIn(box, op.path, what);
    if (!isScalar(node) || !node.srcToken) throw refuse();
    const str = String(op.value);
    const types: Array<Scalar.Type | undefined> = [undefined, typeof op.value === 'string' ? 'QUOTE_DOUBLE' : 'PLAIN'];
    for (const type of types) {
      const { tokens: t2, contents: c2 } = type === undefined ? { tokens, contents } : composeWithTokens(text);
      const n2 = nodeIn(containerNode(c2, c), op.path, what) as Scalar;
      CST.setScalarValue(n2.srcToken!, str, type ? { type } : {});
      const out = t2.map((t) => CST.stringify(t)).join('');
      if (check(out)) return out;
    }
    throw refuse();
  }
  const dashLine = c.entry === undefined ? 0 : itemLines(text, nodeIn(contents, [c.entry.seq], c.entry.seq) as YAMLSeq, c.entry.index, what).dashLine;
  if (op.op === 'replace') {
    const parent = op.path.length > 1 ? nodeIn(box, op.path.slice(0, -1), what) : box;
    const key = op.path[op.path.length - 1];
    if (!isMap(parent)) throw refuse();
    const pair = ((parent as YAMLMap).items as Array<Pair<Node, Node | null>>).find((p) => isScalar(p.key) && (p.key as Scalar).value === key);
    const node = pair?.value ?? null;
    let out: string;
    if (node?.range && (isScalar(node) || (isCollection(node) && node.flow))) {
      out = text.slice(0, node.range[0]) + renderFlow(op.value) + text.slice(node.range[1]);
    } else if (pair && node?.range && isCollection(node)) {
      // A block collection written over by a flow value (`intro:` with its keys → `intro: false`): the pair's lines, rewritten.
      const ks = pair.key.range![0];
      const line = lineStartOf(text, ks);
      if (line === dashLine || !/^ *$/.test(text.slice(line, ks))) throw refuse();
      const end = lineEndOf(text, pairEnd(text, pair) - 1);
      if (c.keepComments && holdsComment(text.slice(ks, end))) {
        throw new StepEditError('not_editable', `${what} is written over several lines with comments (they would go): ${c.byHand}`);
      }
      out = `${text.slice(0, ks)}${renderPair(key, op.value)}${c.eol}${text.slice(end)}`;
    } else throw refuse();
    if (check(out)) return out;
    throw refuse();
  }
  const map = op.path.length ? nodeIn(box, op.path, what) : box;
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
      // A new key of the container goes before its anchor key (a scenario's `scenes:`, a scene's `steps:`, a theme's
      // `components:`): never after a long list.
      const before = map === box && op.path.length === 0 && c.insertBefore !== undefined ? anchorBefore(text, map as YAMLMap, c.insertBefore, dashLine) : undefined;
      const at = before ?? lineEndOf(text, pairEnd(text, items[items.length - 1]) - 1);
      out = applySplices(text, [insertLines(text, at, `${' '.repeat(col)}${pair}${c.eol}`, c.eol)]);
    }
  } else {
    const pair = items.find((p) => isScalar(p.key) && (p.key as Scalar).value === op.key);
    if (!pair || items.length < 2) throw refuse();
    const dash = map === box ? dashLine : lineStartOf(text, map.range![0]);
    const [a, b] = pairRemoval(text, map as YAMLMap, pair, dash);
    out = text.slice(0, a) + text.slice(b);
  }
  if (check(out)) return out;
  throw refuse();
}

/**
 * Set (`to`) or remove (`to` undefined) one path of one or two keys below the container in a YAML text whose parsed value
 * is `root` (see the header). The caller checks the path is one it may write and what is there now (stale values);
 * this splices, verifies every step and keeps a file without a final line break so. Throws StepEditError
 * (`not_editable`: the text cannot be changed there without touching other parts; `invalid`).
 */
export function setMapPath(text: string, root: Obj, path: readonly string[], to: unknown, o: SetMapPathOptions): SetMapPathResult {
  if (path.length < 1 || path.length > 2) throw new StepEditError('invalid', `${o.what}: a path of one or two keys`);
  const container = structuredClone(o.entry === undefined ? root : ((root[o.entry.seq] as unknown[])[o.entry.index] as Obj));
  const ctx: TextCtx = {
    eol: eolOf(text),
    ...(o.entry !== undefined ? { entry: o.entry } : {}),
    ...(o.insertBefore !== undefined ? { insertBefore: o.insertBefore } : {}),
    keepComments: o.keepComments === true,
    byHand: o.byHand ?? 'change it in the YAML view',
  };
  /** The whole file's value with the container as it is now. */
  const wholeWith = (): Obj => {
    if (o.entry === undefined) return structuredClone(container);
    const w = structuredClone(root);
    (w[o.entry.seq] as unknown[])[o.entry.index] = structuredClone(container);
    return w;
  };
  let out = text;
  for (const op of planOps(container, path, to, o.protectedKey)) {
    applyOp(container, op);
    out = applyOpText(out, ctx, op, wholeWith(), o.what);
  }
  // A file without a final line break keeps it so (a line added at its end brought one).
  if (!text.endsWith('\n') && out.endsWith('\n')) out = out.slice(0, out.endsWith(ctx.eol) ? -ctx.eol.length : -1);
  return { text: out, intended: wholeWith() };
}
