import { LineCounter, isAlias, isMap, isPair, isScalar, isSeq, parseDocument } from 'yaml';
import type { Document, Node } from 'yaml';
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
  let value: unknown;
  try {
    value = doc.toJS({ maxAliasCount: 1000 });
  } catch (e) {
    issues.push({ severity: 'error', path: [], message: `YAML: ${(e as Error).message}`, line: 1, col: 1 });
    return { source, value: undefined, issues };
  }
  return { source, value, issues };
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
    if (isAlias(node)) node = node.resolve(source.doc);
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
