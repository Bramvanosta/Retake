/** Words the operations' summaries share (moved from the MCP server in L7.13). */
import type { ValidationIssue } from '@retake/core/model';

/** "3 scenarios" / "1 scenario". */
export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** "7:9 error scenes.0.steps.0: unknown action…" */
export function issueLine(i: ValidationIssue): string {
  const at = i.line !== undefined ? `${i.line}:${i.col ?? 1} ` : '';
  return `${at}${i.severity}${i.path.length ? ` ${i.path.join('.')}` : ''}: ${i.message}`;
}
