/**
 * A review's findings and verdict as lines of text (pure: part of `@retake/review/checks`; report.md and the CLI's
 * summary print them).
 */
import { timecode } from './spans.js';
import type { Finding, ReviewResult } from './types.js';

/** One finding on one line: "[00:12.5 · f375 · scene · step 2] message (code)" — the code in backticks for Markdown. */
export function findingLine(f: Finding, markdown = true): string {
  const where: string[] = [];
  if (f.at?.time !== undefined) where.push(timecode(f.at.time));
  if (f.at?.frame !== undefined) where.push(`f${f.at.frame}`);
  if (f.at?.segment) where.push(f.at.segment);
  if (f.at?.step !== undefined) where.push(`step ${f.at.step}`);
  return `${where.length ? `[${where.join(' · ')}] ` : ''}${f.message} (${markdown ? `\`${f.code}\`` : f.code})`;
}

export function summaryLine(r: Pick<ReviewResult, 'clean' | 'counts'>): string {
  if (r.clean) return `clean: no error, no warning${r.counts.info ? ` (${r.counts.info} info)` : ''}`;
  const parts: string[] = [];
  if (r.counts.error) parts.push(`${r.counts.error} error${r.counts.error > 1 ? 's' : ''}`);
  if (r.counts.warning) parts.push(`${r.counts.warning} warning${r.counts.warning > 1 ? 's' : ''}`);
  if (r.counts.info) parts.push(`${r.counts.info} info`);
  return `not clean: ${parts.join(', ')}`;
}
