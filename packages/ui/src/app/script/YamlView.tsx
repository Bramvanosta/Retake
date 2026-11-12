/**
 * The scenario's YAML, read-only (L4.2; L5.10b: R4-Source on the kit): the file's text as text nodes, one list item per
 * line (the numbers are the list's markers: not copied with the text) with its direction controls shown as marks
 * (`Txt`: a U+202E in a value cannot reorder the line), each issue under its line (its severity as a shape and a word),
 * the issues without a line above, and the lines "Show in the file" asked for outlined and scrolled to. Syntax colours
 * are not drawn (BL-129).
 */
import { useEffect, useMemo, useRef } from 'react';
import type { ValidationIssue } from '@retake/core/model';
import { Txt, shown } from '../bits.js';
import { IssueLines } from './StepEditing.js';
import type { View } from '../words/scenario-words.js';
import { StatusMark } from '../ui-kit/index.js';

export function YamlView({ v, focus, issues }: { v: View; focus: { line: number; end_line: number } | null; issues: ValidationIssue[] }) {
  const lines = useMemo(() => v.text.split('\n'), [v.text]);
  const byLine = useMemo(() => {
    const m = new Map<number, ValidationIssue[]>();
    for (const i of issues) if (i.line !== undefined && i.line >= 1 && i.line <= lines.length) m.set(i.line, [...(m.get(i.line) ?? []), i]);
    return m;
  }, [issues, lines.length]);
  const loose = issues.filter((i) => i.line === undefined || i.line < 1 || i.line > lines.length);
  const list = useRef<HTMLOListElement>(null);
  useEffect(() => {
    if (!focus) return;
    list.current?.children[focus.line - 1]?.scrollIntoView({ block: 'center', behavior: 'auto' });
  }, [focus]);
  return (
    <div className="yv">
      {loose.length > 0 && <IssueLines issues={loose} />}
      <ol ref={list} className="yv-lines k-mono" data-testid="yaml" aria-label={`${v.file}, read-only`}>
        {lines.map((l, i) => {
          const on = focus !== null && i + 1 >= focus.line && i + 1 <= focus.end_line;
          const here = byLine.get(i + 1);
          return (
            <li key={i} className={on ? 'yv-line is-focus' : 'yv-line'} data-focus={on ? 'true' : undefined}>
              <code className="yv-code">{l === '' ? ' ' : <Txt text={l} />}</code>
              {here?.map((x, n) => (
                <span key={n} className="yv-issue">
                  <StatusMark state={x.severity === 'error' ? 'fail' : 'warn'} word={x.severity === 'error' ? 'error' : 'warning'} />
                  {x.col !== undefined && <span className="sc-quiet">{shown(`col ${x.col}`)}</span>}
                  <Txt text={x.message} />
                </span>
              ))}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
