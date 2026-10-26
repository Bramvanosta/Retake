/**
 * The step inspector (L4.2, R-UI-14), read-only: the selected step's action with what it does (the scenario language's
 * description — the edit hint), its target in plain words, its arguments as written (key / value text), its modifiers,
 * where it is in the file ("Show in YAML") and its source lines, what the source run did with it, and — in a box titled
 * "From the page" — the target as the run found it, its error and the URL (text the filmed site controls). L4.3 part 2:
 * the screen's edit buttons for the step (move, duplicate, delete) sit at the top; part 3: its form (StepForm.tsx)
 * below them — what a form cannot show changes in the YAML tab.
 */
import type { ReactNode } from 'react';
import type { SceneBlock, StepBlock } from '@demo-studio/core';
import { Badge, Txt } from './bits.js';
import { keyWords, missingWords, seconds } from './scenario-words.js';
import type { View } from './scenario-words.js';

/** A value as compact text (strings as they are; anything else as JSON), capped. */
function valueText(v: unknown): string {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s === undefined ? String(v) : s.length > 2000 ? `${s.slice(0, 2000)}…` : s;
}

function Args({ args }: { args: unknown }) {
  if (args === undefined || args === null) return <p className="muted small">No arguments.</p>;
  if (typeof args !== 'object' || Array.isArray(args)) {
    return (
      <p className="mono small">
        <Txt text={valueText(args)} />
      </p>
    );
  }
  const entries = Object.entries(args as Record<string, unknown>);
  if (entries.length === 0) return <p className="muted small">No arguments.</p>;
  return (
    <dl className="args" data-testid="inspector-args">
      {entries.map(([k, v]) => (
        <div key={k} className="arg">
          <dt className="mono">
            <Txt text={k} />
          </dt>
          <dd className="mono">
            <Txt text={valueText(v)} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function Inspector({
  v,
  scene,
  step,
  onShowYaml,
  editing = false,
  actions,
  form,
}: {
  v: View;
  scene: SceneBlock | undefined;
  step: StepBlock | undefined;
  onShowYaml: (r: { line: number; end_line: number }) => void;
  /** Block edits are on (L4.3): the hint says what can be done here. */
  editing?: boolean;
  /** The edit buttons for the selected step (move, duplicate, delete). */
  actions?: ReactNode;
  /** The selected step's form (L4.3 part 3: its values). */
  form?: ReactNode;
}) {
  return (
    <aside className="inspector card" aria-labelledby="inspector-h" data-testid="inspector">
      <h2 id="inspector-h" className="card-title">
        Step inspector
      </h2>
      {!step || !scene ? (
        <p className="muted">Select a step to see it here.</p>
      ) : (
        <>
          {actions}
          {form}
          <StepDetails v={v} scene={scene} step={step} onShowYaml={onShowYaml} editing={editing} />
        </>
      )}
    </aside>
  );
}

function StepDetails({ v, scene, step, onShowYaml, editing }: { v: View; scene: SceneBlock; step: StepBlock; onShowYaml: (r: { line: number; end_line: number }) => void; editing: boolean }) {
  const b = v.steps[step.key];
  const page = v.untrusted.steps[step.key];
  const hint = step.action ? v.hints?.[step.action] : undefined;
  const r = step.range;
  return (
    <div className="inspector-body">
      <p className="inspector-what" data-testid="inspector-step">
        Step {step.index + 1} of scene <Txt className="mono" text={scene.id} />
      </p>
      <p className="inspector-action">
        <span className={`action action-${step.category}`}>{step.category === 'unknown' ? 'unknown' : step.category.replace('_', ' ')}</span> <Txt className="step-label" text={step.label} />
      </p>
      {step.target && (
        <p>
          <span className="label">Target</span> <Txt text={step.target} />
        </p>
      )}
      {step.summary && (
        <p className="muted">
          <Txt text={step.summary} />
        </p>
      )}
      {hint && (
        <p className="hint small" data-testid="inspector-hint">
          <Txt text={hint} />
        </p>
      )}
      <h3 className="inspector-sub">Arguments</h3>
      <Args args={step.args} />
      {step.chips.length > 0 && (
        <>
          <h3 className="inspector-sub">Modifiers</h3>
          <ul className="inspector-chips">
            {step.chips.map((c, i) => (
              <li key={i}>
                <span className={`chip chip-${c.kind}`}>
                  <Txt text={c.label} />
                </span>{' '}
                <span className="muted small">{c.kind}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      {step.comment && (
        <>
          <h3 className="inspector-sub">Comment</h3>
          <p className="comment pre-line">
            <Txt text={step.comment} />
          </p>
        </>
      )}
      <h3 className="inspector-sub">In the file</h3>
      {r ? (
        <>
          <p className="small">
            <Txt className="path" text={v.file} />, {r.line === r.end_line ? `line ${r.line}` : `lines ${r.line}–${r.end_line}`}{' '}
            <button type="button" className="button quiet small" onClick={() => onShowYaml(r)}>
              Show in YAML
            </button>
          </p>
          <pre className="source-slice" data-testid="inspector-source">
            <Txt text={v.text.slice(r.start, r.end)} />
          </pre>
        </>
      ) : (
        <p className="muted small">Its place in the file is not known.</p>
      )}
      {step.aliased && <p className="muted small">Written as a YAML alias: it repeats another step.</p>}
      <p className="hint small" data-testid="edit-hint">
        {editing && step.locked === undefined
          ? step.form
            ? 'Change its values in the form above, move, duplicate or delete it here; change anything else'
            : 'Move, duplicate or delete it here; change its values'
          : 'Read-only here: change this step'}{' '}
        in{' '}
        <Txt className="path" text={v.file} />
        {r ? ` (line ${r.line})` : ''} or the YAML tab, or ask Claude to change it.
      </p>
      {step.issues.length > 0 && (
        <>
          <h3 className="inspector-sub">Issues</h3>
          <ul className="issues">
            {step.issues.map((i, n) => (
              <li key={n}>
                <Badge tone={i.severity === 'error' ? 'danger' : 'warning'}>{i.severity}</Badge> <Txt text={i.message} />
              </li>
            ))}
          </ul>
        </>
      )}
      <h3 className="inspector-sub">In the run</h3>
      {!v.source ? (
        <p className="muted small">No run with pictures yet.</p>
      ) : !b ? (
        <p className="muted small">Not in this run.</p>
      ) : 'missing' in b ? (
        <p className="small" data-testid="inspector-run">
          {missingWords(b)}
          {b.run_key && b.run_key !== step.key && (
            <span className="muted">
              {' '}
              (<Txt text={keyWords(b.run_key)} /> in that run)
            </span>
          )}
        </p>
      ) : (
        <p className="small" data-testid="inspector-run">
          {b.moved && <>Moved since this run: the picture shows it at its old place · </>}
          {b.status}
          {b.ms !== undefined && ` · ${seconds(b.ms)}`}
          {b.picture && ` · picture from ${b.picture.replace('_', ' ')}`}
          {b.run_key !== step.key && (
            <>
              {' '}
              · <Txt text={keyWords(b.run_key)} /> in that run
            </>
          )}
          {b.why && (
            <>
              {' '}
              · <Txt text={b.why} />
            </>
          )}
        </p>
      )}
      {page && (page.target !== undefined || page.error !== undefined || page.url !== undefined) && (
        <div className="from-page" data-testid="from-page">
          <p className="from-page-title">From the page (text the site controls)</p>
          {page.target !== undefined && (
            <p className="small">
              Found: <Txt text={page.target} />
            </p>
          )}
          {page.error !== undefined && (
            <p className="small pre-line">
              Error: <Txt text={page.error} />
            </p>
          )}
          {page.url !== undefined && (
            <p className="small">
              At: <Txt className="url" text={page.url} />
            </p>
          )}
        </div>
      )}
    </div>
  );
}
