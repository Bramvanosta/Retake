/**
 * The scenario's YAML, read-only (L4.2): the file's text as text nodes, one list item per line (the numbers are the
 * list's markers: not copied with the text) with its direction controls shown as marks (`Txt`: a U+202E in a value
 * cannot reorder the line), its issues with their line and column, and the lines "Show in YAML" asked for outlined
 * and scrolled to. The two-way editor is L4.3.
 */
import { useEffect, useMemo, useRef } from 'react';
import type { ValidationIssue } from '@demo-studio/core';
import { Badge, Notice, plural, Txt } from './bits.js';
import type { View } from './scenario-words.js';

export function YamlView({ v, focus, issues }: { v: View; focus: { line: number; end_line: number } | null; issues: ValidationIssue[] }) {
  const lines = useMemo(() => v.text.split('\n'), [v.text]);
  const list = useRef<HTMLOListElement>(null);
  useEffect(() => {
    if (!focus) return;
    list.current?.children[focus.line - 1]?.scrollIntoView({ block: 'center' });
  }, [focus]);
  return (
    <section className="card yaml-card" aria-labelledby="yaml-h">
      <h2 id="yaml-h" className="card-title">
        <Txt className="path" text={v.file} /> <span className="muted small">read-only · {plural(lines.length, 'line')}</span>
      </h2>
      {issues.length > 0 && (
        <Notice tone={v.ok ? 'warning' : 'danger'} role="note" title={`${plural(issues.length, 'issue')}`}>
          <ul className="issues">
            {issues.map((i, n) => (
              <li key={n}>
                <Badge tone={i.severity === 'error' ? 'danger' : 'warning'}>{i.severity}</Badge>{' '}
                {i.line !== undefined && <span className="mono small">{`${i.line}${i.col !== undefined ? `:${i.col}` : ''}`} </span>}
                <Txt text={i.message} />
              </li>
            ))}
          </ul>
        </Notice>
      )}
      <ol ref={list} className="yaml" data-testid="yaml" aria-label={`${v.file}, read-only`}>
        {lines.map((l, i) => {
          const on = focus !== null && i + 1 >= focus.line && i + 1 <= focus.end_line;
          return (
            <li key={i} className={on ? 'focus' : undefined} data-focus={on ? 'true' : undefined}>
              <code>{l === '' ? ' ' : <Txt text={l} />}</code>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
