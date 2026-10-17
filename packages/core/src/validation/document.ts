import type { z } from 'zod';
import { newerFormatMessage } from '../formats.js';
import type { FormatVersion } from '../formats.js';
import { hasErrors } from '../issues.js';
import type { ValidationIssue } from '../types.js';
import { finalizeIssues } from './located.js';
import type { LocatedIssue } from './located.js';
import { attachPositions, parseYaml } from './yaml-source.js';
import { zodIssues } from './zod-issues.js';

export interface CheckedDocument {
  /** Plain JS value of the document (undefined on YAML syntax errors). */
  value: unknown;
  /** Sorted issues with line/col. */
  issues: ValidationIssue[];
}

export interface CheckDocumentOptions {
  /**
   * The file's format (R-PRIN-13): a `version` above `supported` is refused before the schema — one error at the
   * `version` key, the file was made for a newer Demo Studio — instead of the unknown keys of a format this one
   * does not know.
   */
  formatVersion?: FormatVersion;
}

/**
 * YAML text → syntax check → (newer format check) → schema check → optional semantic checks → positions.
 * `semantic` receives the value and the structural issues found so far (to skip broken parts).
 */
export function checkYamlDocument(
  text: string,
  schema: z.ZodType,
  semantic?: (value: unknown, structural: readonly LocatedIssue[]) => LocatedIssue[],
  emptyValue: unknown = {},
  opts: CheckDocumentOptions = {},
): CheckedDocument {
  const parsed = parseYaml(text);
  const located: LocatedIssue[] = [...parsed.issues];
  if (hasErrors(located)) return { value: undefined, issues: finalizeIssues(located) };
  const value = parsed.value === null || parsed.value === undefined ? emptyValue : parsed.value;
  const newer = opts.formatVersion ? newerFormatMessage(value, opts.formatVersion) : undefined;
  if (newer) {
    const issues: LocatedIssue[] = [...located, { severity: 'error', path: ['version'], message: newer }];
    attachPositions(issues, parsed.source);
    return { value: undefined, issues: finalizeIssues(issues) };
  }
  const structural = zodIssues(schema, value);
  located.push(...structural);
  if (semantic) located.push(...semantic(value, structural));
  attachPositions(located, parsed.source);
  return { value, issues: finalizeIssues(located) };
}

/** True when an error-level issue lies at or under `prefix` (or points into it). */
export function brokenUnder(issues: readonly LocatedIssue[], prefix: ReadonlyArray<string | number>): boolean {
  const under = (p: ReadonlyArray<string | number>) =>
    p.length >= prefix.length && prefix.every((seg, i) => p[i] === seg);
  return issues.some((i) => i.severity === 'error' && (under(i.path) || (i.loc !== undefined && under(i.loc.path))));
}
