import { LineCounter, isAlias, isMap, isNode, isPair, isScalar, isSeq, parseDocument, visit } from 'yaml';
import type { Alias, Document, Node } from 'yaml';
import type { IssuePath } from '../issues.js';
import type { LocatedIssue } from './located.js';

/** A parsed YAML document able to map a data path back to a line/column. */
export interface YamlSource {
  doc: Document.Parsed;
  lineCounter: LineCounter;
}

export interface ParsedYaml {
  source: YamlSource;
  /** Plain JS value (undefined when the document has syntax errors). */
  value: unknown;
  /** Syntax errors and warnings, with positions. */
  issues: LocatedIssue[];
}

export function parseYaml(text: string): ParsedYaml {
  const lineCounter = new LineCounter();
  const doc = parseDocument(text, { lineCounter, prettyErrors: false, uniqueKeys: true });
  const source: YamlSource = { doc, lineCounter };
  const issues: LocatedIssue[] = [];
  const add = (severity: 'error' | 'warning', e: { message: string; pos: [number, number] }) => {
    const { line, col } = lineCounter.linePos(e.pos[0]);
    issues.push({ severity, path: [], message: `YAML: ${firstLine(e.message)}`, line, col });
  };
  for (const e of doc.errors) add('error', e);
  for (const w of doc.warnings) add('warning', w);
  if (doc.errors.length > 0) return { source, value: undefined, issues };
  const loop = recursiveAlias(doc, text);
  if (loop !== undefined) {
    const { line, col } = lineCounter.linePos(loop);
    issues.push({ severity: 'error', path: [], message: 'YAML: an alias points back into the node that holds it (a recursive structure): repeat the values instead', line, col });
    return { source, value: undefined, issues };
  }
  let value: unknown;
  try {
    value = doc.toJS({ maxAliasCount: 1000 });
  } catch (e) {
    issues.push({ severity: 'error', path: [], message: `YAML: ${(e as Error).message}`, line: 1, col: 1 });
    return { source, value: undefined, issues };
  }
  return { source, value, issues };
}

/**
 * Each alias of the document → the node it names: the latest node anchored with its name before it in document order
 * (what `Alias.resolve` finds — but in one pass over the document: `resolve` walks the whole document for each alias,
 * so a file of many aliases cost O(aliases × nodes), review A #1). Computed once per document, on first use.
 */
const aliasTargetsOf = new WeakMap<Document.Parsed, Map<Alias, Node>>();
function aliasTargets(doc: Document.Parsed): Map<Alias, Node> {
  let targets = aliasTargetsOf.get(doc);
  if (targets) return targets;
  targets = new Map();
  const anchors = new Map<string, Node>();
  visit(doc, (_key, node) => {
    if (isAlias(node)) {
      const target = anchors.get(node.source);
      if (target) targets!.set(node, target);
    } else if (isNode(node) && node.anchor) anchors.set(node.anchor, node);
    return undefined;
  });
  aliasTargetsOf.set(doc, targets);
  return targets;
}

/**
 * Offset of the first alias that points at a node holding it (`a: &x {b: *x}`), or undefined. `toJS` would build a
 * cyclic value from it, which every walker of the data (the schema, fingerprints, the blocks) would follow forever. An
 * alias can only name an anchor defined before it, so a cycle always runs through an alias to one of its own
 * ancestors. One pass (aliasTargets), each alias checked against its path: linear in the document's size.
 */
function recursiveAlias(doc: Document.Parsed, text: string): number | undefined {
  if (!text.includes('*')) return undefined;
  const targets = aliasTargets(doc);
  if (targets.size === 0) return undefined;
  let found: number | undefined;
  visit(doc, {
    Alias(_key, node, path) {
      const target = targets.get(node);
      if (target && path.includes(target as never)) {
        found = node.range?.[0] ?? 0;
        return visit.BREAK;
      }
      return undefined;
    },
  });
  return found;
}

function firstLine(s: string): string {
  return s.split('\n')[0].replace(/\s+at line \d+, column \d+:?$/, '');
}

function keyOf(k: unknown): string {
  if (isScalar(k)) return String(k.value);
  return String(k);
}

function rangeStart(n: unknown): number | undefined {
  const r = (n as Node | null | undefined)?.range;
  return Array.isArray(r) ? r[0] : undefined;
}

/**
 * Offset of the node at `path` (or of its KEY when `key` is true). Falls back to the nearest
 * existing ancestor when the path does not exist in the document.
 */
export function locateOffset(source: YamlSource, path: IssuePath, key = false): number | undefined {
  let node: unknown = source.doc.contents;
  let best = rangeStart(node);
  for (let i = 0; i < path.length; i++) {
    const seg = path[i];
    if (isAlias(node)) node = aliasTargets(source.doc).get(node);
    if (isMap(node)) {
      const pair = node.items.find((p) => isPair(p) && keyOf(p.key) === String(seg));
      if (!pair) break;
      const last = i === path.length - 1;
      const keyStart = rangeStart(pair.key);
      if ((last && key) || pair.value === null || rangeStart(pair.value) === undefined) {
        return keyStart ?? best;
      }
      node = pair.value;
    } else if (isSeq(node) && typeof seg === 'number') {
      const item = node.items[seg];
      if (item === undefined || rangeStart(item) === undefined) break;
      node = item;
    } else {
      break;
    }
    best = rangeStart(node) ?? best;
  }
  return best;
}

/** Fill line/col of every issue that has none, from its `loc` (or its path). */
export function attachPositions(issues: LocatedIssue[], source: YamlSource): void {
  for (const issue of issues) {
    if (issue.line !== undefined) continue;
    const offset = locateOffset(source, issue.loc?.path ?? issue.path, issue.loc?.key ?? false);
    if (offset === undefined) continue;
    const { line, col } = source.lineCounter.linePos(offset);
    issue.line = line;
    issue.col = col;
  }
}
