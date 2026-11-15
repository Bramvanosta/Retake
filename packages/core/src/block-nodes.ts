/** The YAML nodes behind a scenario's block values (blocks.ts): a node or its alias, its range, its comment lines, the file's top comment. */
import { isAlias, isMap, isScalar, isSeq } from 'yaml';
import type { Node } from 'yaml';
import { stripUrlUserinfo } from './block-words.js';
import type { SourceRange } from './blocks-model.js';
import type { YamlSource } from './validation/yaml-source.js';

// ── The YAML nodes behind the values ────────────────────────────────────────

/** A node of the document, or the alias a value was reached through (then everything under it is that alias). */
export interface At {
  node?: Node;
  aliased: boolean;
}

export function childAt(at: At, key: string | number): At {
  if (at.aliased || !at.node) return at;
  const n = at.node;
  let c: unknown;
  if (isMap(n)) c = n.items.find((p) => isScalar(p.key) && String(p.key.value) === String(key))?.value;
  else if (isSeq(n) && typeof key === 'number') c = n.items[key];
  if (c === null || c === undefined) return { aliased: false };
  return { node: c as Node, aliased: isAlias(c) };
}

/** The parsed document and its text. */
export interface Src {
  yaml: YamlSource;
  text: string;
}

/** A node's range, its end moved back over trailing blank space (a block mapping's range runs to the next line). */
export function rangeOf(at: At, src: Src): SourceRange | undefined {
  const r = at.node?.range;
  if (!Array.isArray(r)) return undefined;
  const start = r[0];
  let end = r[1];
  while (end > start && /\s/.test(src.text[end - 1] ?? '')) end--;
  const lc = src.yaml.lineCounter;
  return { line: lc.linePos(start).line, end_line: lc.linePos(Math.max(start, end - 1)).line, start, end };
}

/** The comment lines above item `i` of a sequence (the first item's are the sequence's own). */
export function commentOf(seq: At, item: At, i: number): string | undefined {
  if (item.aliased) return undefined;
  const own = item.node?.commentBefore ?? (i === 0 && !seq.aliased && isSeq(seq.node) ? seq.node.commentBefore : undefined);
  return typeof own === 'string' && own !== ''
    ? stripUrlUserinfo(
        own
          .split('\n')
          .map((l) => l.replace(/^ /, ''))
          .join('\n'),
      )
    : undefined;
}

/** An editor's directive line: `yaml-language-server: $schema=…`, an Emacs `-*- … -*-` or a vim / vi / ex modeline. */
export const EDITOR_DIRECTIVE = /^\s*(?:yaml-language-server:|.*-\*-.*-\*-|(?:vim?|ex):)/;

/**
 * The file's top comment as a person reads it: the editor directives that lead it left out (and one blank
 * line after them), URLs without their `user:password@`, the comment's hard wraps joined into paragraphs (a blank line
 * starts a new one; a line opening a list item keeps its own line). The comment as written stays in the file, at
 * `comment_lines`.
 */
export function topCommentWords(raw: string): string | undefined {
  const lines = raw.split('\n').map((l) => l.replace(/^ /, ''));
  let i = 0;
  while (i < lines.length && EDITOR_DIRECTIVE.test(lines[i])) i++;
  if (i > 0 && i < lines.length && lines[i].trim() === '') i++;
  const paragraphs: string[] = [];
  let cur: string[] = [];
  for (const line of lines.slice(i)) {
    const t = line.trim();
    if (t === '') {
      if (cur.length) paragraphs.push(cur.join(' '));
      cur = [];
    } else if (cur.length && /^(?:[-*•]|\d+[.)])\s/.test(t)) {
      cur[cur.length - 1] += `\n${t}`;
    } else cur.push(t);
  }
  if (cur.length) paragraphs.push(cur.join(' '));
  const text = stripUrlUserinfo(paragraphs.join('\n\n'));
  return text === '' ? undefined : text;
}
