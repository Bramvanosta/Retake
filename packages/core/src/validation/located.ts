import type { IssuePath } from '../issues.js';
import type { ValidationIssue } from '../types.js';

/** Internal issue: `loc` says which YAML node to point at when it differs from `path`. */
export interface LocatedIssue extends ValidationIssue {
  loc?: { path: IssuePath; key?: boolean };
}

/** Strip internal fields, drop exact duplicates, sort by position (unpositioned last, stable). */
export function finalizeIssues(issues: LocatedIssue[]): ValidationIssue[] {
  const seen = new Set<string>();
  const out: ValidationIssue[] = [];
  for (const { loc: _loc, ...issue } of issues) {
    const key = `${issue.severity}|${JSON.stringify(issue.path)}|${issue.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(issue);
  }
  const pos = (i: ValidationIssue) => (i.line === undefined ? Infinity : i.line * 1e5 + (i.col ?? 0));
  return out
    .map((issue, idx) => ({ issue, idx }))
    .sort((a, b) => pos(a.issue) - pos(b.issue) || a.idx - b.idx)
    .map((x) => x.issue);
}

export function issue(
  severity: ValidationIssue['severity'],
  path: IssuePath,
  message: string,
  loc?: LocatedIssue['loc'],
): LocatedIssue {
  return loc ? { severity, path, message, loc } : { severity, path, message };
}
