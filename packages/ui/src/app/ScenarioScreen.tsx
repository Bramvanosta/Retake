/**
 * A scenario as blocks (L4.2, R-UI-08..10, R-UI-13, R-UI-14) — read-only: one `scenario_blocks` read gives the file,
 * its blocks (video header, setup / teardown hooks, scenes with their steps, cards, interstitials), its issues, what
 * would stop a run from the Studio (`run_blockers`, beside the Dry run / Capture buttons), the scenario's runs (the "Pictures from" picker), the source run
 * and every step's binding to it. Steps show their run's picture (Thumb.tsx, asked for the rows on screen only) or why
 * there is none, in words. The inspector shows the selected step (arguments, edit hints, its lines, what the run
 * found); the YAML tab shows the file as text and edits it (L4.3, YamlTab.tsx).
 *
 * Events (critique B1): the view is read again only for this scenario's own file, a run of this scenario that
 * appears, changes status or goes away, the picker, a reconnection or the window's focus — a running run's progress
 * is a `run_status` read, never the whole view. Every string from the file or the filmed site is a text node (`Txt`
 * for names, URLs and page text); page text stays in boxes titled "From the page".
 *
 * Keyboard (critique B9): each scene's steps are a `listbox` of `option`s (aria-selected, aria-activedescendant); the
 * step area is one tab stop (the listbox holding the selection); Up / Down / Home / End / Page Up / Page Down move the
 * selection across scenes and the inspector follows it. No live region: the option's name carries the step.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent, KeyboardEvent, ReactNode } from 'react';
import type { Chip, EntryBlock, HookBlock, SceneBlock, StepBlock, StepForms, ValidationIssue, VideoBlock } from '@demo-studio/core';
import type { RunBlocker, ScenarioRunChoice, StepBinding } from '@demo-studio/engine';
import { CallError, call, errorText, useCall } from './api.js';
import { Badge, EnvFlags, Loading, Notice, plural, RunState, Txt, visibleControls, When } from './bits.js';
import { useScenarioEvents } from './events.js';
import { Inspector } from './Inspector.js';
import { hrefTo } from './route.js';
import type { ScenarioTab } from './route.js';
import { NoThumb, Thumb, ThumbsProvider } from './Thumb.js';
import type { ThumbAnswer } from './thumbs.js';
import { YamlTab } from './YamlTab.js';
import { scenarioKey, useDirty } from './drafts.js';
import { dropMove, keyboardMove } from './step-edit.js';
import type { SceneSlots, StepRef } from './step-edit.js';
import { EditBar, useStepEditor } from './StepEditing.js';
import type { StepEditor } from './StepEditing.js';
import { Palette, StepForm } from './StepForm.js';
import { MODE, RUN_STATUS_WORDS, STATUS_WORDS, bindingWords, layoutWords, missingWords, runErrorWords, seconds, stepWords } from './scenario-words.js';
import type { View } from './scenario-words.js';

/** A running run as `run_status` tells it. */
interface LiveRun {
  id: string;
  mode: string;
  status: string;
  steps_done: number;
  steps_total: number;
  current?: { scene: string; step: number; action: string };
  finished: boolean;
}

function Breadcrumb({ slug, name }: { slug: string; name: string }) {
  return (
    <nav aria-label="Breadcrumb" className="breadcrumb">
      <a href={hrefTo({ name: 'projects' })}>Projects</a>
      <span aria-hidden="true"> / </span>
      <a href={hrefTo({ name: 'project', slug })}>
        <Txt text={slug} />
      </a>
      <span aria-hidden="true"> / </span>
      <Txt aria-current="page" text={name} />
    </nav>
  );
}

function Tabs({ slug, name, tab }: { slug: string; name: string; tab: ScenarioTab }) {
  return (
    <nav aria-label="Scenario views" className="tabs">
      <a href={hrefTo({ name: 'scenario', slug, scenario: name, tab: 'blocks' })} aria-current={tab === 'blocks' ? 'page' : undefined} className={tab === 'blocks' ? 'tab current' : 'tab'}>
        Blocks
      </a>
      <a href={hrefTo({ name: 'scenario', slug, scenario: name, tab: 'yaml' })} aria-current={tab === 'yaml' ? 'page' : undefined} className={tab === 'yaml' ? 'tab current' : 'tab'}>
        YAML
      </a>
    </nav>
  );
}

function IssueList({ issues }: { issues: ValidationIssue[] }) {
  if (issues.length === 0) return null;
  return (
    <ul className="issues" data-testid="issues">
      {issues.map((i, n) => (
        <li key={n}>
          <Badge tone={i.severity === 'error' ? 'danger' : 'warning'}>{i.severity}</Badge> {i.line !== undefined && <span className="muted small">line {i.line}{i.col !== undefined ? `:${i.col}` : ''} · </span>}
          <Txt text={i.message} />
        </li>
      ))}
    </ul>
  );
}

/** Every issue of the file, wherever its block is. */
function allIssues(v: View): ValidationIssue[] {
  const out = [...v.blocks.issues];
  for (const h of [...v.blocks.hooks.setup, ...v.blocks.hooks.teardown]) out.push(...h.issues);
  for (const e of v.blocks.entries) {
    out.push(...e.issues);
    if (e.type === 'scene') for (const s of e.steps) out.push(...s.issues);
  }
  return out;
}

/** What the last Dry run / Capture click came to: queued (its run id), or the server's refusal and its command. */
type Submitted = { mode: 'dry' | 'capture'; run_id: string } | { mode: 'dry' | 'capture'; error: string; fix?: string };

const FINISHED_RUN = new Set(['succeeded', 'failed', 'cancelled', 'interrupted', 'unknown']);

/** What run_status says of a finished run (its error is text the site controls). */
interface RunOutcome {
  id: string;
  status: string;
  untrusted?: { error_message?: string };
}

/** The first line of a run's error, at most 300 characters. */
function firstLine(s: string): string {
  const l = s.split('\n')[0];
  return l.length > 300 ? `${l.slice(0, 300)}…` : l;
}

/** "In a terminal: …" and, for a person without `studio` on their PATH, the same command through node. */
function Commands({ fix, fixNode }: { fix?: string; fixNode?: string }) {
  if (!fix) return null;
  return (
    <>
      <p className="small">
        In a terminal: <code className="copyable" data-testid="blocker-fix">{fix}</code>
      </p>
      {fixNode && (
        <p className="small muted">
          Without <code>studio</code> on your PATH: <code className="copyable" data-testid="blocker-fix-node">{fixNode}</code>
        </p>
      )}
    </>
  );
}

/**
 * The outcome of the run this screen started, once it ends (review B H1): its status and, from run_status, the first
 * line of its error — a run that failed before its first step (the site down) leaves no picture and would otherwise
 * vanish without a word.
 */
function SubmittedOutcome({ choice, mode, slug, isSource }: { choice: ScenarioRunChoice; mode: 'dry' | 'capture'; slug: string; isSource: boolean }) {
  const [out, setOut] = useState<RunOutcome | null>(null);
  useEffect(() => {
    let live = true;
    call<RunOutcome>('run_status', { project: slug, run_id: choice.id }).then(
      (d) => live && setOut({ id: d.id, status: d.status, ...(d.untrusted ? { untrusted: d.untrusted } : {}) }),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [slug, choice.id, choice.status]);
  const status = RUN_STATUS_WORDS[choice.status] ?? 'unknown';
  const ok = choice.status === 'succeeded' && choice.pictures !== null;
  const error = out?.id === choice.id ? out.untrusted?.error_message : undefined;
  return (
    <Notice tone={ok ? 'info' : 'warning'} role="status" title={`The ${MODE(mode)} ${choice.id} ${choice.partial && choice.status !== 'cancelled' && choice.status !== 'interrupted' ? choice.partial : status}`}>
      <div data-testid="run-outcome">
        {ok ? <p>{isSource ? 'Its pictures are shown below.' : 'Pick it in “Pictures from” to see its pictures.'}</p> : choice.pictures === null ? <p>It left no picture.</p> : null}
        {error !== undefined && (
          <div className="from-page" data-testid="run-outcome-error">
            <p className="from-page-title">Its error, from the page (text the site controls)</p>
            <p className="pre-line">
              <Txt text={runErrorWords(firstLine(error))} />
            </p>
          </div>
        )}
      </div>
    </Notice>
  );
}

/**
 * "Runs from the Studio" (critique B2, B11): a Dry run and a Capture button, each with what would stop it, shown
 * before any click — a blocked one is disabled, says "needs the terminal" with the reason and the exact `studio run …`
 * command to type there. A click asks `scenario_run` with pinned arguments (the scenario and the mode, nothing else);
 * the server checks again and its refusal is shown the same way. While a run of this scenario is queued or running,
 * both wait (Cancel is on the running banner).
 */
function RunActions({ v, slug, name, busy, onSubmitted }: { v: View; slug: string; name: string; busy: boolean; onSubmitted: () => void }) {
  const [sending, setSending] = useState<'dry' | 'capture' | null>(null);
  const [last, setLast] = useState<Submitted | null>(null);
  const start = (mode: 'dry' | 'capture') => {
    setSending(mode);
    setLast(null);
    // The file as this screen shows it (review A #6): a file changed since is refused (409) and the screen reads it again.
    call<{ run_id: string }>('scenario_run', { project: slug, name, mode, hash: v.hash })
      .then(
        (d) => {
          setLast({ mode, run_id: d.run_id });
          onSubmitted();
        },
        (e: unknown) => {
          setLast({ mode, error: errorText(e), ...(e instanceof CallError && e.error.fix ? { fix: e.error.fix } : {}) });
          if (e instanceof CallError && e.error.code === 'conflict') onSubmitted();
        },
      )
      .finally(() => setSending(null));
  };
  const row = (mode: 'dry' | 'capture', label: string, list: RunBlocker[]) => {
    const id = `blockers-${mode}`;
    const blocked = list.length > 0;
    // A file with errors: no command helps — the terminal refuses it too (review B M6).
    const fileFirst = list.some((b) => b.fix_file);
    return (
      <div className="blocker-row" data-testid={`blockers-${label.toLowerCase().replace(' ', '-')}`}>
        <p className="run-action">
          <button
            type="button"
            className={blocked ? 'button' : 'button primary'}
            data-testid={`run-${mode}`}
            disabled={blocked || busy || sending !== null}
            aria-describedby={id}
            onClick={() => start(mode)}
          >
            {sending === mode ? `Starting the ${MODE(mode)}…` : fileFirst ? `${label} — fix the file first` : blocked ? `${label} — needs the terminal` : label}
          </button>{' '}
          <span id={id}>
            {blocked ? (
              <span className="muted small">{fileFirst ? 'the file has errors' : list.some((b) => b.fix) ? 'why, and the command to type, below' : 'why below'}</span>
            ) : busy ? (
              <span className="muted small">waits for the run of this scenario to finish</span>
            ) : (
              <Badge tone="success">nothing stops it</Badge>
            )}
          </span>
        </p>
        {list.map((b, i) => (
          <div key={i} className="blocker">
            <p className="pre-line">
              <Txt text={b.message} />
            </p>
            <Commands {...(b.fix ? { fix: b.fix } : {})} {...(b.fix_node ? { fixNode: b.fix_node } : {})} />
          </div>
        ))}
      </div>
    );
  };
  const submitted = last && 'run_id' in last ? v.runs.find((r) => r.id === last.run_id) : undefined;
  const ended = submitted && FINISHED_RUN.has(submitted.status) && v.running?.id !== submitted.id ? submitted : undefined;
  const refusedFixNode = last && 'error' in last && last.fix ? [...v.run_blockers.dry, ...v.run_blockers.capture].find((b) => b.fix === last.fix)?.fix_node : undefined;
  return (
    <section className="card run-checks" aria-labelledby="checks-h">
      <h2 id="checks-h" className="card-title">
        Runs from the Studio
      </h2>
      {row('dry', 'Dry run', v.run_blockers.dry)}
      {row('capture', 'Capture', v.run_blockers.capture)}
      {/* Until the run it queued has ended: then its outcome (and the picker, the pictures) say the rest. */}
      {last && 'run_id' in last && !ended && (
        <p className="small" role="status" data-testid="run-submitted">
          {last.mode === 'dry' ? 'Dry run' : 'Capture'} <Txt className="mono" text={last.run_id} /> queued: its progress shows above, its pictures here when it ends.
        </p>
      )}
      {last && 'run_id' in last && ended && <SubmittedOutcome choice={ended} mode={last.mode} slug={slug} isSource={v.source?.run === ended.id} />}
      {last && 'error' in last && (
        <Notice tone="danger" role="alert" title={`The ${MODE(last.mode)} was not started`}>
          <p className="pre-line" data-testid="run-refused">
            <Txt text={last.error} />
          </p>
          <Commands {...(last.fix ? { fix: last.fix } : {})} {...(refusedFixNode ? { fixNode: refusedFixNode } : {})} />
        </Notice>
      )}
      <p className="muted small">A dry run skips the hooks and takes a screenshot per step; a capture runs the hooks and films the video. Both use the environment shown above.</p>
    </section>
  );
}

/** An option's text (no element can isolate it): run.json's words only through known statuses, controls made visible (review A #4). */
function runLabel(r: ScenarioRunChoice): string {
  const what = `${r.mode === 'dry' ? 'Dry run' : 'Capture'} ${r.id}`;
  const status = RUN_STATUS_WORDS[r.status] ?? 'unknown';
  const state = r.status === 'running' || r.status === 'queued' ? status : r.partial ?? status;
  return visibleControls(`${what} · ${state}${r.pictures ? '' : ' · no pictures'}`);
}

function SourceBar({ v, pick, onPick }: { v: View; pick: string | undefined; onPick: (run: string | undefined) => void }) {
  const s = v.source;
  return (
    <section className="source" aria-label="Pictures">
      <div className="source-head">
        <label className="source-pick">
          <span className="label">Pictures from</span>
          <select data-testid="run-picker" value={pick ?? ''} onChange={(e) => onPick(e.target.value || undefined)}>
            <option value="">The newest complete run (default)</option>
            {v.runs.map((r) => (
              <option key={r.id} value={r.id} disabled={r.status === 'running' || r.status === 'queued'}>
                {runLabel(r)}
              </option>
            ))}
          </select>
        </label>
        {s && (
          <p className="source-line" data-testid="source-line">
            {MODE(s.mode)} <Txt className="mono" text={s.run} /> <RunState status={RUN_STATUS_WORDS[s.status] ?? 'unknown'} /> <When iso={s.finished_at} />
            {s.hooks && (
              <span className="muted small">
                {' '}
                · hooks: setup {s.hooks.setup}, teardown {s.hooks.teardown}
              </span>
            )}
          </p>
        )}
      </div>
      {!s && v.runs.length === 0 && (
        <Notice tone="info" title="No run of this scenario yet">
          <p>A dry run or a capture shows each step's picture here.</p>
        </Notice>
      )}
      {!s && v.runs.length > 0 && (
        <Notice tone="info" title="No run of this scenario has pictures yet">
          <p>Steps show their words only.</p>
        </Notice>
      )}
      {s?.notice === 'changed' && (
        <Notice tone="warning" role="note" title="What the browser does changed since this run">
          {s.filmed_changes && s.filmed_changes.length > 0 && <p>Changed: {s.filmed_changes.join('; ')}.</p>}
          <p data-testid="changed-since">
            A render of this run shows the take as it was captured: capture again to film the change. The pictures show the run as it
            was: steps changed or added since have no picture, and a moved step shows its old place.
          </p>
        </Notice>
      )}
      {s?.notice === 'edit_changed' && (
        <Notice tone="info" role="note" title="Only the edit changed since this run">
          <p>Captions, cards, durations, overlays or the title changed: a render re-plans them on this take, no new capture needed.</p>
        </Notice>
      )}
      {s?.notice === 'cannot_tell' && (
        <Notice tone="warning" role="note" title="Cannot tell whether the scenario changed since this run">
          <p>This run kept no copy of the scenario: steps are matched by position, so a picture may belong to a step that changed.</p>
        </Notice>
      )}
      {s && s.newer_partial.length > 0 && !s.picked && (
        <Notice tone="info" role="note" title="Newer runs stopped early">
          <ul>
            {s.newer_partial.map((r) => (
              <li key={r.id}>
                {MODE(r.mode)} <Txt className="mono" text={r.id} /> (<Txt text={r.partial} />
                {r.pictures === null && r.partial !== 'no pictures' ? ', no pictures' : ''}){' '}
                <button type="button" className="button quiet small" onClick={() => onPick(r.id)}>
                  {r.pictures ? 'Show its pictures' : 'Show this run'}
                </button>
              </li>
            ))}
          </ul>
        </Notice>
      )}
      {v.untrusted.run_error !== undefined && (
        <div className="from-page" data-testid="run-error">
          <p className="from-page-title">This run's error, from the page (text the site controls)</p>
          <p className="pre-line">
            <Txt text={runErrorWords(v.untrusted.run_error)} />
          </p>
        </div>
      )}
    </section>
  );
}

function Running({ run, live, slug, onCancelled }: { run: ScenarioRunChoice | null; live: LiveRun | null; slug: string; onCancelled: () => void }) {
  const [cancel, setCancel] = useState<{ id: string; state: 'sending' | 'asked' | string } | null>(null);
  const r = live && !live.finished ? live : run;
  if (!r) return null;
  const cur = live && !live.finished ? live.current : undefined;
  const mine = cancel && cancel.id === r.id ? cancel : null;
  const stop = () => {
    setCancel({ id: r.id, state: 'sending' });
    call('run_cancel', { project: slug, run_id: r.id }).then(
      () => {
        setCancel({ id: r.id, state: 'asked' });
        // A queued run is cancelled at once (its run.json is finalised later by a worker, if one runs): read again now.
        onCancelled();
      },
      (e: unknown) => setCancel({ id: r.id, state: errorText(e) }),
    );
  };
  return (
    <Notice tone="info" title={`A ${MODE(r.mode)} of this scenario is ${r.status}`}>
      <p data-testid="running">
        <Txt className="mono" text={r.id} /> · {r.steps_done}/{r.steps_total} steps
        {cur && (
          <>
            {' '}
            · current <Txt text={stepWords(cur.scene, cur.step)} /> · {cur.action}
          </>
        )}
      </p>
      <p>
        <button type="button" className="button small" data-testid="run-cancel" disabled={mine?.state === 'sending' || mine?.state === 'asked'} onClick={stop}>
          {mine?.state === 'sending' ? 'Cancelling…' : mine?.state === 'asked' ? 'Cancel asked' : 'Cancel this run'}
        </button>
        {mine?.state === 'asked' && <span className="muted small"> A running run stops at its next step; its teardown and rollbacks still run.</span>}
        {mine && mine.state !== 'sending' && mine.state !== 'asked' && (
          <span className="small warn-text" role="alert">
            {' '}
            <Txt text={mine.state} />
          </span>
        )}
      </p>
    </Notice>
  );
}

function endCard(c: VideoBlock['intro']): string {
  if (c.mode === 'theme') return "the theme's";
  if (c.mode === 'off') return 'none';
  return [c.component, c.file ? `${c.file.kind} ${c.file.path}` : undefined, c.duration !== undefined ? `${c.duration} s` : undefined, c.tagline ? `“${c.tagline}”` : undefined, c.url].filter(Boolean).join(' · ') || 'custom';
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="fact">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function VideoCard({ v }: { v: View }) {
  const b = v.blocks.video;
  return (
    <section className="card video-block" aria-labelledby="video-h" data-testid="video-block">
      <h2 id="video-h" className="card-title">
        Video
      </h2>
      {b.comment && (
        <div className="video-notes">
          <p className="label">Notes from the file</p>
          <p className="comment pre-line">
            <Txt text={b.comment} />
          </p>
        </div>
      )}
      <dl className="facts">
        {b.name !== undefined && <Fact label="Name"><Txt text={b.name} /></Fact>}
        {b.title && <Fact label="Title"><Txt text={[b.title.kicker, b.title.text].filter(Boolean).join(' — ')} /></Fact>}
        <Fact label="Environment">
          {v.environment ? (
            <>
              <Txt text={v.environment.name} /> <EnvFlags env={v.environment} />
            </>
          ) : (
            <span className="muted">none</span>
          )}
        </Fact>
        {b.template !== undefined && <Fact label="Template"><Txt text={b.template} /></Fact>}
        {b.frame !== undefined && <Fact label="Frame"><Txt text={b.frame} /></Fact>}
        <Fact label="Intro"><Txt text={endCard(b.intro)} /></Fact>
        <Fact label="Outro"><Txt text={endCard(b.outro)} /></Fact>
        {b.music && <Fact label="Music"><Txt text={[b.music.file, b.music.volume !== undefined ? `volume ${b.music.volume}` : undefined].filter(Boolean).join(' · ')} /></Fact>}
        {b.tutorial !== undefined && <Fact label="Tutorial"><Txt text={b.tutorial} /></Fact>}
        {b.clock !== undefined && <Fact label="Clock"><Txt text={b.clock} /></Fact>}
        {b.capture && <Fact label="Capture"><Txt text={[b.capture.width && b.capture.height ? `${b.capture.width} × ${b.capture.height}` : undefined, b.capture.fps ? `${b.capture.fps} fps` : undefined, b.capture.scale ? `scale ${b.capture.scale}` : undefined, b.capture.keep_frames === true ? 'frames kept' : undefined].filter(Boolean).join(' · ')} /></Fact>}
        {b.pacing && <Fact label="Pacing"><Txt text={b.pacing.join(', ')} /></Fact>}
        {b.vars && <Fact label="Variables"><Txt text={b.vars.join(', ')} /></Fact>}
        {b.mocks !== undefined && <Fact label="Mocks">{plural(b.mocks, 'mock')}</Fact>}
      </dl>
    </section>
  );
}

function HookItem({ h }: { h: HookBlock }) {
  return (
    <li className="hook" data-testid="hook">
      <p className="hook-head">
        <Badge tone="info">{h.kind ?? 'unknown'}</Badge> {h.name !== undefined ? <Txt className="hook-name" text={h.name} /> : <span className="muted">hook {h.index + 1}</span>}
        {h.flags.map((f) => (
          <Badge key={f.kind} tone={f.kind === 'destructive' ? 'danger' : 'neutral'}>
            {f.label}
          </Badge>
        ))}
      </p>
      <p className="mono small">
        <Txt text={h.summary} />
      </p>
      {h.rollback && (
        <p className="small">
          Rollback: <Txt className="mono" text={h.rollback} />
        </p>
      )}
      {h.needs_person && (
        <p className="small warn-text">
          Needs a person: <Txt text={h.needs_person} />
        </p>
      )}
      <IssueList issues={h.issues} />
    </li>
  );
}

function HooksStrip({ v }: { v: View }) {
  const { setup, teardown } = v.blocks.hooks;
  const outcome = v.source?.hooks;
  return (
    <section className="card hooks" aria-labelledby="hooks-h" data-testid="hooks">
      <h2 id="hooks-h" className="card-title">
        Hooks
      </h2>
      <div className="hooks-strip">
        <div className="hooks-phase">
          <p className="label">
            Setup {outcome && <span className="muted">· in this run: {outcome.setup}</span>}
          </p>
          {setup.length === 0 ? <p className="muted small">None.</p> : <ol className="hook-list">{setup.map((h) => <HookItem key={h.index} h={h} />)}</ol>}
        </div>
        <p className="hooks-arrow" aria-hidden="true">
          → capture →
        </p>
        <div className="hooks-phase">
          <p className="label">
            Teardown {outcome && <span className="muted">· in this run: {outcome.teardown}</span>}
          </p>
          {teardown.length === 0 ? <p className="muted small">None.</p> : <ol className="hook-list">{teardown.map((h) => <HookItem key={h.index} h={h} />)}</ol>}
        </div>
      </div>
    </section>
  );
}

function Chips({ chips }: { chips: Chip[] }) {
  if (chips.length === 0) return null;
  return (
    <span className="chips">
      {chips.map((c, i) => (
        <span key={i} className={`chip chip-${c.kind}`} data-chip={c.kind}>
          <Txt text={c.label} />
        </span>
      ))}
    </span>
  );
}

/** The image's alt: the step from the scenario's own words (never page text) and the run. */
function altOf(step: StepBlock, scene: string, run: string, mode: string): string {
  // An attribute cannot be isolated (no <bdi>): direction controls made visible (review A #8).
  return visibleControls(`${step.label}${step.target ? ` ${step.target}` : ''} — step ${step.index + 1} of scene ${scene}, at the end of the step in ${MODE(mode)} ${run}`);
}

interface RowProps {
  step: StepBlock;
  scene: string;
  optId: string;
  binding: StepBinding | undefined;
  source: { run: string; mode: string } | null;
  cannotTell: boolean;
  selected: boolean;
  onPick: (key: string) => void;
  /** Its grip shows and it can be dragged (block edits on, not locked, no edit on its way). */
  canDrag: boolean;
  /** The insertion line: above or below this row (a drop there puts the step at that place). */
  drop: 'before' | 'after' | null;
  dragging: boolean;
  drag: DragHandlers;
}

/** Drag & drop of steps (native HTML5): the screen's handlers, stable across renders. */
interface DragHandlers {
  start: (ev: DragEvent<HTMLElement>, step: StepBlock, scene: string) => void;
  over: (ev: DragEvent<HTMLElement>, scene: string, gap: number | 'half', index: number) => void;
  drop: (ev: DragEvent<HTMLElement>) => void;
  end: () => void;
}

/** The MIME type a step's drag carries (its key only: drop handlers never read it — they use the drag state). */
const STEP_DRAG_TYPE = 'application/x-demo-studio-step';

const StepRow = memo(function StepRow({ step, scene, optId, binding, source, cannotTell, selected, onPick, canDrag, drop, dragging, drag }: RowProps) {
  const words = bindingWords(binding, source !== null);
  const bound = binding && !('missing' in binding) ? binding : undefined;
  const tone = bound ? STATUS_WORDS[bound.status]?.[1] ?? 'neutral' : 'warning';
  let picture;
  if (!source) picture = <NoThumb>No run with pictures yet</NoThumb>;
  else if (!binding) picture = <NoThumb>Not in this run</NoThumb>;
  else if ('missing' in binding) picture = <NoThumb>{missingWords(binding)}</NoThumb>;
  else if (binding.picture === null) picture = <NoThumb>{binding.status === 'skipped' ? 'Skipped in this run' : binding.why ?? 'No picture in this run'}</NoThumb>;
  else picture = <Thumb run={source.run} runKey={binding.run_key} alt={altOf(step, scene, source.run, source.mode)} />;
  return (
    <li
      id={optId}
      role="option"
      aria-selected={selected}
      aria-label={visibleControls(`Step ${step.index + 1}: ${step.label}${step.target ? ` ${step.target}` : ''}. ${words}`)}
      className={['step', selected ? 'selected' : '', canDrag ? 'can-drag' : '', drop ? `drop-${drop}` : '', dragging ? 'dragging' : ''].filter(Boolean).join(' ')}
      data-key={step.key}
      data-testid="step"
      onClick={() => onPick(step.key)}
      draggable={canDrag}
      onDragStart={canDrag ? (ev) => drag.start(ev, step, scene) : undefined}
      onDragOver={(ev) => drag.over(ev, scene, 'half', step.index)}
      onDrop={drag.drop}
      onDragEnd={drag.end}
    >
      {canDrag && (
        <span className="grip" aria-hidden="true" title="Drag to move (or Alt+↑ / Alt+↓)">
          ⋮⋮
        </span>
      )}
      {picture}
      <div className="step-body">
        <p className="step-head">
          <span className="step-n">{step.index + 1}</span>
          <span className={`action action-${step.category}`} data-testid="action-badge">
            {step.category === 'unknown' ? 'unknown' : step.category.replace('_', ' ')}
          </span>
          <Txt className="step-label" text={step.label} />
          {step.target && <Txt className="step-target" text={step.target} />}
        </p>
        {step.summary && (
          <p className="step-summary muted">
            <Txt text={step.summary} />
          </p>
        )}
        <p className="step-foot">
          <Chips chips={step.chips} />
          {source && (
            <span className="step-state" data-testid="step-state">
              <Badge tone={bound?.moved ? 'warning' : tone}>{words}</Badge>
              {bound?.ms !== undefined && <span className="muted small"> {seconds(bound.ms)}</span>}
              {bound && cannotTell && <span className="muted small"> · matched by position: cannot tell whether it changed</span>}
            </span>
          )}
          {step.issues.length > 0 && <Badge tone="danger">{plural(step.issues.length, 'issue')}</Badge>}
        </p>
      </div>
    </li>
  );
});

/** A multi-page scene's pages (review B M1): each with its environment page and full URL, or the scene it continues from. */
function PagesFact({ e, f }: { e: SceneBlock; f: View['scenes'][string] }) {
  const facts = new Map((f.pages ?? []).map((p) => [p.id, p]));
  return (
    <Fact label="Pages">
      <ul className="scene-pages small" data-testid="scene-pages">
        {(e.pages ?? []).map((p) => {
          const pf = facts.get(p.id);
          const page = pf?.page ?? p.page;
          return (
            <li key={p.id}>
              <Txt className="mono" text={p.id} />
              {p.label !== undefined && <> (<Txt text={p.label} />)</>}
              {page !== undefined && <> · page <Txt text={page} /></>}
              {' · '}
              {pf?.continues_from !== undefined ? (
                <span>
                  continues from <Txt className="mono" text={pf.continues_from} />
                </span>
              ) : pf?.url !== undefined ? (
                <>
                  <Txt className="url" text={pf.url} />
                  {pf.display !== undefined && (
                    <span className="muted">
                      {' '}
                      shown as <Txt className="url" text={pf.display} />
                    </span>
                  )}
                </>
              ) : p.open !== undefined ? (
                <Txt className="url" text={p.open} />
              ) : (
                <span className="muted">—</span>
              )}
              {p.viewport !== undefined && <> · <Txt text={p.viewport} /></>}
              {p.persona !== undefined && <> · persona <Txt text={p.persona} /></>}
            </li>
          );
        })}
      </ul>
    </Fact>
  );
}

function sceneFacts(e: SceneBlock, v: View) {
  const f = v.scenes[e.id] ?? {};
  return (
    <dl className="facts scene-facts">
      {e.pages ? (
        <PagesFact e={e} f={f} />
      ) : (
        <>
      <Fact label="Page">
        {e.page !== undefined ? <Txt text={e.page} /> : <span className="muted">the first page</span>}
        {e.page_inherited && <span className="muted small"> (from the scene before)</span>}
      </Fact>
      <Fact label="URL">
        {f.continues_from !== undefined ? (
          <span>
            continues from <Txt className="mono" text={f.continues_from} />
          </span>
        ) : f.url !== undefined ? (
          <>
            <Txt className="url" text={f.url} />
            {f.display !== undefined && (
              <span className="muted small">
                {' '}
                shown as <Txt className="url" text={f.display} />
              </span>
            )}
          </>
        ) : e.open !== undefined ? (
          <Txt className="url" text={e.open} />
        ) : (
          <span className="muted">—</span>
        )}
      </Fact>
        </>
      )}
      {e.persona !== undefined && <Fact label="Persona"><Txt text={e.persona} /></Fact>}
      <Fact label="Speed">{e.speed !== undefined ? `×${e.speed}` : <span className="muted">normal</span>}</Fact>
      <Fact label="Layout">
        {/* The scene's frame, else the video's, else what the render picks for several pages (review B M1). */}
        {e.pages || e.frame !== undefined ? <Txt text={layoutWords(e.frame, v.blocks.video.frame, e.pages?.length ?? 1)} /> : <span className="muted">the video's</span>}
      </Fact>
      <Fact label="Duration">
        {f.captured_s !== undefined ? `${f.captured_s.toFixed(1)} s captured` : <span className="muted">not captured yet</span>}
        {f.run_status && f.run_status !== 'ok' && <> <Badge tone={f.run_status === 'failed' ? 'danger' : 'warning'}>{f.run_status} in this run</Badge></>}
      </Fact>
      {e.transition !== undefined && <Fact label="Transition"><Txt text={e.transition} /></Fact>}
      {e.cursor !== undefined && <Fact label="Cursor"><Txt text={e.cursor} /></Fact>}
      {e.still !== undefined && <Fact label="Still">{e.still} s</Fact>}
      {e.tutorial !== undefined && <Fact label="Tutorial"><Txt text={e.tutorial} /></Fact>}
    </dl>
  );
}

interface EntryProps {
  e: EntryBlock;
  v: View;
  /** The filmed scene's number among the filmed scenes (cards and interstitials are not counted). */
  sceneNo: number | undefined;
  selected: string | null;
  optIds: Map<string, string>;
  onPick: (key: string) => void;
  onKey: (ev: KeyboardEvent<HTMLUListElement>) => void;
  listRef: (scene: string, el: HTMLUListElement | null) => void;
  firstScene: string | null;
  canEdit: boolean;
  dropAt: { scene: string; gap: number } | null;
  dragKey: string | null;
  drag: DragHandlers;
}

function Entry({ e, v, sceneNo, selected, optIds, onPick, onKey, listRef, firstScene, canEdit, dropAt, dragKey, drag }: EntryProps) {
  if (e.type === 'card' || e.type === 'interstitial') {
    return (
      <section className={`entry-small entry-${e.type}`} aria-label={`${e.type} ${e.id}`} data-testid={e.type}>
        <p>
          <Badge>{e.type}</Badge> <Txt className="mono" text={e.id} />
          {e.component !== undefined && <> · <Txt text={e.component} /></>}
          {e.file && <> · {e.file.kind} <Txt className="mono" text={e.file.path} /></>}
          {' · '}
          {e.duration !== undefined ? `${e.duration} s` : <span className="muted">default duration</span>}
        </p>
        {e.type === 'interstitial' && (e.kicker !== undefined || e.text !== undefined) && (
          <p className="muted">
            <Txt text={[e.kicker, e.text].filter(Boolean).join(' — ')} />
          </p>
        )}
        {e.type === 'card' && e.slots && (
          <p className="muted small">
            {Object.entries(e.slots).map(([k, s], i) => (
              <span key={k}>
                {i > 0 && ' · '}
                <Txt text={`${k}: ${s}`} />
              </span>
            ))}
          </p>
        )}
        <IssueList issues={e.issues} />
      </section>
    );
  }
  if (e.type === 'unknown') {
    return (
      <section className="entry-small entry-unknown" aria-label={`entry ${e.index + 1}`}>
        <p>
          <Badge tone="danger">unreadable entry</Badge> entry {e.index + 1}
          {e.range && <span className="muted small"> · line {e.range.line}</span>}
        </p>
        <IssueList issues={e.issues} />
      </section>
    );
  }
  const source = v.source ? { run: v.source.run, mode: v.source.mode } : null;
  const hasSel = selected !== null && e.steps.some((s) => s.key === selected);
  const headId = `scene-h-${e.index}`;
  return (
    <section className="scene card" aria-labelledby={headId} data-testid="scene" data-scene={e.id}>
      <h2 id={headId} className="scene-title">
        <span className="muted">Scene {sceneNo}</span> <Txt className="mono" text={e.id} />
        {e.skip && <Badge tone="warning">skipped</Badge>}
        {e.irreversible && <Badge tone="danger">irreversible</Badge>}
      </h2>
      {e.caption && (
        <p className="caption" data-testid="caption">
          {e.caption.kicker !== undefined && <Txt className="kicker" text={e.caption.kicker} />} <Txt text={e.caption.text} />
        </p>
      )}
      {e.comment && (
        <p className="comment pre-line">
          <Txt text={e.comment} />
        </p>
      )}
      {sceneFacts(e, v)}
      {e.note !== undefined && (
        <p className="small">
          Note: <Txt text={e.note} />
        </p>
      )}
      <IssueList issues={e.issues} />
      {e.steps.length === 0 ? (
        <p
          className={dropAt?.scene === e.id ? 'muted small drop-empty drop-here' : 'muted small drop-empty'}
          data-testid="drop-empty"
          onDragOver={(ev) => drag.over(ev, e.id, 0, 0)}
          onDrop={drag.drop}
        >
          No steps.{canEdit && !e.steps_locked ? ' Drop a step here to move it into this scene.' : ''}
        </p>
      ) : (
        <ul
          ref={(el) => listRef(e.id, el)}
          role="listbox"
          aria-label={`Steps of scene ${e.id}`}
          aria-activedescendant={hasSel ? optIds.get(selected!) : undefined}
          aria-describedby={canEdit ? 'steps-keys' : undefined}
          tabIndex={hasSel || (selected === null && e.id === firstScene) ? 0 : -1}
          className="steps"
          onKeyDown={onKey}
        >
          {e.steps.map((s) => (
            <StepRow
              key={s.key}
              step={s}
              scene={e.id}
              optId={optIds.get(s.key)!}
              binding={v.steps[s.key]}
              source={source}
              cannotTell={v.source?.notice === 'cannot_tell'}
              selected={s.key === selected}
              onPick={onPick}
              canDrag={canEdit && s.locked === undefined && s.guard !== undefined}
              drop={dropAt?.scene === e.id ? (dropAt.gap === s.index ? 'before' : dropAt.gap === e.steps.length && s.index === e.steps.length - 1 ? 'after' : null) : null}
              dragging={dragKey === s.key}
              drag={drag}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

/** The inspector's edit buttons for the selected step (the same edits as the keyboard and drag & drop). */
function StepActions({ disabled, locked, up, down, onMove, onAction }: { disabled: boolean; locked: string | undefined; up: boolean; down: boolean; onMove: (dir: -1 | 1) => void; onAction: (k: 'delete_step' | 'duplicate_step') => void }) {
  return (
    <div className="step-actions" data-testid="step-actions">
      <button type="button" className="button small" disabled={disabled || !up} onClick={() => onMove(-1)} aria-keyshortcuts="Alt+ArrowUp">
        Move up
      </button>
      <button type="button" className="button small" disabled={disabled || !down} onClick={() => onMove(1)} aria-keyshortcuts="Alt+ArrowDown">
        Move down
      </button>
      <button type="button" className="button small" disabled={disabled} onClick={() => onAction('duplicate_step')}>
        Duplicate
      </button>
      <button type="button" className="button small danger" disabled={disabled} onClick={() => onAction('delete_step')} aria-keyshortcuts="Delete">
        Delete
      </button>
      {locked !== undefined && (
        <p className="muted small">
          Not movable here: <Txt text={locked} />
        </p>
      )}
    </div>
  );
}

const PAGE = 10;

function Blocks({
  v,
  picked,
  setPicked,
  onShowYaml,
  ed,
  forms,
}: {
  v: View;
  picked: string | null;
  setPicked: (key: string) => void;
  onShowYaml: (r: { line: number; end_line: number }) => void;
  ed: StepEditor;
  forms: StepForms | null;
}) {
  const [palette, setPalette] = useState(false);
  const scenes = useMemo(() => v.blocks.entries.filter((e): e is SceneBlock => e.type === 'scene'), [v.blocks]);
  // Filmed scenes numbered 1, 2, 3… (review B L3: the entry index counted cards and interstitials).
  const sceneNo = useMemo(() => new Map(scenes.map((s, i) => [s.index, i + 1])), [scenes]);
  const order = useMemo(() => scenes.flatMap((s) => s.steps.map((st) => ({ key: st.key, scene: s.id }))), [scenes]);
  const index = useMemo(() => new Map(order.map((o, i) => [o.key, i])), [order]);
  const optIds = useMemo(() => new Map(order.map((o, i) => [o.key, `step-opt-${i}`])), [order]);
  const selected = picked !== null && index.has(picked) ? picked : (order[0]?.key ?? null);
  const lists = useRef(new Map<string, HTMLUListElement>());
  const listRef = useCallback((scene: string, el: HTMLUListElement | null) => {
    if (el) lists.current.set(scene, el);
    else lists.current.delete(scene);
  }, []);
  const go = useCallback(
    (i: number, focus: boolean) => {
      const o = order[Math.max(0, Math.min(order.length - 1, i))];
      if (!o) return;
      setPicked(o.key);
      if (focus) lists.current.get(o.scene)?.focus({ preventScroll: true });
      document.getElementById(optIds.get(o.key)!)?.scrollIntoView({ block: 'nearest' });
    },
    [order, optIds, setPicked],
  );
  const onPick = useCallback(
    (key: string) => {
      const i = index.get(key);
      if (i !== undefined) go(i, true);
    },
    [index, go],
  );
  const selRef = useRef(selected);
  selRef.current = selected;
  const canEdit = ed.enabled && !ed.busy;
  // The step of a key, as an edit names it (scene, index, guard).
  const refOf = useCallback(
    (key: string | null): (StepRef & { locked: boolean }) | null => {
      const o = key === null ? undefined : order[index.get(key) ?? -1];
      const st = o ? scenes.find((s) => s.id === o.scene)?.steps.find((x) => x.key === key) : undefined;
      return o && st && st.guard !== undefined ? { scene: o.scene, index: st.index, guard: st.guard, locked: st.locked !== undefined } : null;
    },
    [order, index, scenes],
  );
  const slots: SceneSlots[] = useMemo(() => scenes.map((s) => ({ id: s.id, count: s.steps.length, locked: s.steps_locked !== undefined })), [scenes]);
  const edRef = useRef(ed);
  edRef.current = ed;
  const keyMove = useCallback(
    (dir: -1 | 1) => {
      const at = refOf(selRef.current);
      if (!at || at.locked) return;
      const to = keyboardMove(slots, at, dir);
      if (to) edRef.current.send({ kind: 'move_step', from: { scene: at.scene, index: at.index, guard: at.guard }, to });
      // Review B L6: a key that moves nothing says so (the live region kept the last edit's words).
      else edRef.current.say(`Step ${at.index + 1} of ${at.scene} is already the ${dir < 0 ? 'first' : 'last'} step: it cannot move ${dir < 0 ? 'up' : 'down'}.`);
    },
    [refOf, slots],
  );
  const stepAction = useCallback(
    (kind: 'delete_step' | 'duplicate_step') => {
      const at = refOf(selRef.current);
      if (at && !at.locked) edRef.current.send({ kind, at: { scene: at.scene, index: at.index, guard: at.guard } });
    },
    [refOf],
  );
  const onKey = useCallback(
    (ev: KeyboardEvent<HTMLUListElement>) => {
      // Alt+↑ / Alt+↓ move the selected step, Delete / Backspace delete it (undoable); a held key does not repeat an edit.
      if (ev.altKey && (ev.key === 'ArrowUp' || ev.key === 'ArrowDown')) {
        ev.preventDefault();
        if (!ev.repeat && edRef.current.enabled && !edRef.current.busy) keyMove(ev.key === 'ArrowUp' ? -1 : 1);
        return;
      }
      if ((ev.key === 'Delete' || ev.key === 'Backspace') && !ev.altKey && !ev.metaKey && !ev.ctrlKey) {
        ev.preventDefault();
        if (!ev.repeat && edRef.current.enabled && !edRef.current.busy) stepAction('delete_step');
        return;
      }
      const cur = selRef.current === null ? 0 : (index.get(selRef.current) ?? 0);
      const to: Record<string, number> = { ArrowDown: cur + 1, ArrowUp: cur - 1, Home: 0, End: order.length - 1, PageDown: cur + PAGE, PageUp: cur - PAGE };
      if (!(ev.key in to)) return;
      ev.preventDefault();
      go(to[ev.key], true);
    },
    [index, order.length, go, keyMove, stepAction],
  );
  // After an edit, its view selects the moved step / the copy / the neighbour, and the focus stays in the steps — once:
  // the same version read again (a file event, a run ending) never takes the selection back from a step picked since.
  const selectFor = ed.select;
  const selectedFor = useRef<typeof selectFor>(null);
  useEffect(() => {
    if (!selectFor || selectFor.hash !== v.hash || selectedFor.current === selectFor) return;
    const i = index.get(selectFor.key);
    if (i === undefined) return;
    selectedFor.current = selectFor;
    go(i, document.activeElement === null || document.activeElement === document.body || !!(document.activeElement as HTMLElement).closest?.('.steps, .inspector, .edit-bar-wrap'));
  }, [selectFor, v.hash, index, go]);

  // Drag & drop (critique B11): the drag state lives in this document — a drop is acted on only for a drag that started
  // here (never from dataTransfer contents: a drag from another site can carry the same type); anything else dragged
  // over the blocks (a file from the Finder) is refused, so the page never navigates away.
  const dragState = useRef<StepRef | null>(null);
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [dropAt, setDropAt] = useState<{ scene: string; gap: number } | null>(null);
  const dropRef = useRef(dropAt);
  dropRef.current = dropAt;
  const lockedScenes = useMemo(() => new Set(scenes.filter((s) => s.steps_locked !== undefined).map((s) => s.id)), [scenes]);
  const drag: DragHandlers = useMemo(
    () => ({
      start: (ev, step, scene) => {
        if (!edRef.current.enabled || edRef.current.busy || step.guard === undefined || step.locked !== undefined) {
          ev.preventDefault();
          return;
        }
        dragState.current = { scene, index: step.index, guard: step.guard };
        ev.dataTransfer.effectAllowed = 'move';
        ev.dataTransfer.setData(STEP_DRAG_TYPE, step.key);
        setDragKey(step.key);
      },
      over: (ev, scene, gap, index) => {
        if (!dragState.current || lockedScenes.has(scene)) return;
        ev.preventDefault();
        ev.stopPropagation();
        ev.dataTransfer.dropEffect = 'move';
        let g = typeof gap === 'number' ? gap : index;
        if (gap === 'half') {
          const r = ev.currentTarget.getBoundingClientRect();
          g = ev.clientY < r.top + r.height / 2 ? index : index + 1;
        }
        const cur = dropRef.current;
        if (!cur || cur.scene !== scene || cur.gap !== g) setDropAt({ scene, gap: g });
      },
      drop: (ev) => {
        const from = dragState.current;
        const at = dropRef.current;
        if (!from) return;
        ev.preventDefault();
        ev.stopPropagation();
        dragState.current = null;
        setDragKey(null);
        setDropAt(null);
        if (!at) return;
        const to = dropMove(from, { scene: at.scene, index: at.gap });
        if (to) edRef.current.send({ kind: 'move_step', from, to });
      },
      end: () => {
        dragState.current = null;
        setDragKey(null);
        setDropAt(null);
      },
    }),
    [lockedScenes],
  );
  useEffect(() => {
    const over = (e: globalThis.DragEvent) => {
      if (dragState.current) {
        // Review B L5: over anything but a place to drop (rows stop the event), the insertion line goes away.
        if (dropRef.current) setDropAt(null);
        return;
      }
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'none';
    };
    const dropped = (e: globalThis.DragEvent) => {
      if (!dragState.current) e.preventDefault();
    };
    window.addEventListener('dragover', over);
    window.addEventListener('drop', dropped);
    return () => {
      window.removeEventListener('dragover', over);
      window.removeEventListener('drop', dropped);
    };
  }, []);
  const sel = selected === null ? undefined : order[index.get(selected)!];
  const scene = sel ? scenes.find((s) => s.id === sel.scene) : undefined;
  const step = scene?.steps.find((s) => s.key === selected);
  const issues = allIssues(v);
  return (
    <div className="scenario-grid">
      <div className="blocks" data-testid="blocks" aria-busy={ed.busy}>
        {!v.blocks.parsed && (
          <Notice tone="danger" role="alert" title="This file is not valid YAML">
            <p>The YAML tab shows the text and where it breaks.</p>
          </Notice>
        )}
        {issues.length > 0 && (
          <Notice tone={v.ok ? 'warning' : 'danger'} role="note" title={`${plural(v.limit?.issues_total ?? issues.length, 'issue')} in this file`}>
            <IssueList issues={issues} />
          </Notice>
        )}
        {v.limit && v.limit.steps_shown < v.limit.steps_total && (
          <Notice tone="info" role="note" title={`Showing the first ${plural(v.limit.steps_shown, 'step')} of ${v.limit.steps_total.toLocaleString('en')}`}>
            <p data-testid="steps-limit">The YAML tab shows the whole file.</p>
          </Notice>
        )}
        <VideoCard v={v} />
        <HooksStrip v={v} />
        {ed.enabled && (
          <div className="steps-edit-head">
            <p id="steps-keys" className="muted small steps-keys">
              Drag a step by its grip, or select it and press Alt+↑ / Alt+↓ to move it; Delete removes it; the inspector changes its values. ⌘Z / Ctrl+Z
              undoes.
            </p>
            {forms && !palette && (
              <button type="button" className="button small" data-testid="palette-open" onClick={() => setPalette(true)}>
                Add a step…
              </button>
            )}
          </div>
        )}
        {ed.enabled && forms && palette && <Palette forms={forms} scenes={scenes} selected={step && scene ? { scene, step } : null} ed={ed} onClose={() => setPalette(false)} />}
        {v.blocks.entries.map((e) => (
          <Entry
            key={`${e.type}-${e.index}`}
            e={e}
            v={v}
            sceneNo={sceneNo.get(e.index)}
            selected={selected}
            optIds={optIds}
            onPick={onPick}
            onKey={onKey}
            listRef={listRef}
            firstScene={scenes[0]?.id ?? null}
            canEdit={canEdit}
            dropAt={dropAt}
            dragKey={dragKey}
            drag={drag}
          />
        ))}
      </div>
      <Inspector
        v={v}
        scene={scene}
        step={step}
        onShowYaml={onShowYaml}
        editing={ed.enabled}
        form={step && scene && ed.enabled && forms && step.form && step.locked === undefined ? <StepForm key={step.key} forms={forms} scene={scene} step={step} ed={ed} /> : null}
        actions={
          step && scene && ed.enabled ? (
            <StepActions
              disabled={!canEdit || step.locked !== undefined}
              locked={step.locked}
              up={keyboardMove(slots, { scene: scene.id, index: step.index }, -1) !== null}
              down={keyboardMove(slots, { scene: scene.id, index: step.index }, 1) !== null}
              onMove={keyMove}
              onAction={stepAction}
            />
          ) : null
        }
      />
    </div>
  );
}

/**
 * At most one `run_status` read at a time; one more after it when progress came meanwhile. When the run the view shows
 * running is finished — interrupted included: a worker that died writes nothing more (review B M4) — `onEnded` reads
 * the view again (once per run).
 */
function useLiveRun(slug: string, runningId: string | null, onEnded: () => void): [LiveRun | null, (runs: string[]) => void] {
  const [live, setLive] = useState<LiveRun | null>(null);
  const busy = useRef(false);
  const again = useRef<string | null>(null);
  const endedFor = useRef<string | null>(null);
  const runningRef = useRef(runningId);
  runningRef.current = runningId;
  const endedRef = useRef(onEnded);
  endedRef.current = onEnded;
  const read = useCallback(
    (id: string) => {
      if (busy.current) {
        again.current = id;
        return;
      }
      busy.current = true;
      call<LiveRun>('run_status', { project: slug, run_id: id })
        .then(
          (d) => {
            setLive({ id: d.id, mode: d.mode, status: d.status, steps_done: d.steps_done, steps_total: d.steps_total, ...(d.current ? { current: d.current } : {}), finished: d.finished });
            if (d.finished && d.id === runningRef.current && endedFor.current !== d.id) {
              endedFor.current = d.id;
              endedRef.current();
            }
          },
          () => undefined,
        )
        .finally(() => {
          busy.current = false;
          const next = again.current;
          again.current = null;
          if (next) read(next);
        });
    },
    [slug],
  );
  useEffect(() => {
    if (runningId) read(runningId);
    else setLive(null);
  }, [runningId, read]);
  const progress = useCallback(
    (runs: string[]) => {
      // [] (a jobs event): the running run, if any — its job may have ended without a word from its run.json.
      const id = runningId && (runs.length === 0 || runs.includes(runningId)) ? runningId : runs[0];
      if (id) read(id);
    },
    [runningId, read],
  );
  return [live, progress];
}

/** The step forms (scenario_forms): static, read once per page; null until they are here (forms and palette hidden). */
let formsOnce: Promise<StepForms> | null = null;
function useStepForms(): StepForms | null {
  const [forms, setForms] = useState<StepForms | null>(null);
  useEffect(() => {
    let live = true;
    formsOnce ??= call<StepForms>('scenario_forms', {});
    formsOnce.then(
      (f) => {
        if (live) setForms(f);
      },
      () => {
        formsOnce = null;
      },
    );
    return () => {
      live = false;
    };
  }, []);
  return forms;
}

export function ScenarioScreen({ slug, name, tab }: { slug: string; name: string; tab: ScenarioTab }) {
  const [pick, setPick] = useState<string | undefined>(undefined);
  const [view, reload] = useCall<View>('scenario_blocks', { project: slug, name, ...(pick ? { run: pick } : {}) }, `${slug}/${name}`);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    reload();
  }, [pick, reload]);
  const runningId = view.state === 'ready' ? (view.data.running?.id ?? null) : null;
  const [live, progress] = useLiveRun(slug, runningId, reload);
  useScenarioEvents(slug, name, { reread: reload, progress, jobs: () => progress([]) });
  const [focus, setFocus] = useState<{ line: number; end_line: number } | null>(null);
  // The selected step (today's key): kept while the YAML tab is open and across re-reads.
  const [picked, setPicked] = useState<string | null>(null);
  const onShowYaml = useCallback(
    (r: { line: number; end_line: number }) => {
      setFocus({ line: r.line, end_line: r.end_line });
      location.hash = hrefTo({ name: 'scenario', slug, scenario: name, tab: 'yaml' });
    },
    [slug, name],
  );
  // Critique B7: while the YAML tab holds unsaved text, block edits are off (they would make its base stale).
  const yamlDraft = useDirty(scenarioKey(slug, name));
  // The Blocks tab's step edits (L4.3 part 2): kept across tab switches; a YAML save clears their history.
  const ed = useStepEditor(slug, name, view.state === 'ready' ? view.data : null, yamlDraft, reload, tab === 'blocks');
  const fetchThumbs = useCallback((run: string, keys: string[], signal: AbortSignal) => call<ThumbAnswer>('run_thumbs', { project: slug, run, keys }, { signal }), [slug]);
  const forms = useStepForms();

  if (view.state === 'loading') {
    return (
      <div className="screen">
        <Breadcrumb slug={slug} name={name} />
        <Loading what="the scenario" />
      </div>
    );
  }
  if (view.state === 'error') {
    return (
      <div className="screen">
        <Breadcrumb slug={slug} name={name} />
        <Notice tone="danger" role="alert" title="This scenario cannot be opened">
          <p className="pre-line">
            <Txt text={view.error} />
          </p>
          {pick && (
            <button type="button" className="button" onClick={() => setPick(undefined)}>
              Show the default run's pictures
            </button>
          )}
        </Notice>
      </div>
    );
  }
  const v = view.data;
  return (
    <div className="screen scenario-screen">
      <Breadcrumb slug={slug} name={name} />
      <header className="screen-head scenario-head">
        <h1>
          <Txt text={name} />
        </h1>
        <p className="muted">
          <Txt className="path" text={v.file} /> · {plural(v.blocks.step_count, 'step')}
          {v.environment && (
            <>
              {' '}
              · <Txt text={v.environment.name} /> <EnvFlags env={v.environment} />
            </>
          )}
        </p>
        <Tabs slug={slug} name={name} tab={tab} />
      </header>
      <Running run={v.running} live={live} slug={slug} onCancelled={reload} />
      {/* Around both tabs: the pictures already loaded stay while the YAML tab is open. */}
      <ThumbsProvider fetch={fetchThumbs}>
        {tab === 'blocks' ? (
          <>
            <div className="scenario-top">
              <SourceBar v={v} pick={pick} onPick={setPick} />
              <RunActions v={v} slug={slug} name={name} busy={v.running !== null || (live !== null && !live.finished)} onSubmitted={reload} />
            </div>
            {yamlDraft && (
              <Notice tone="info" role="note" title="Unsaved YAML changes">
                <p data-testid="yaml-draft-open">
                  The blocks show the file on disk. Block editing stays off until you save or discard your changes in the{' '}
                  <a href={hrefTo({ name: 'scenario', slug, scenario: name, tab: 'yaml' })}>YAML tab</a>.
                </p>
              </Notice>
            )}
            <EditBar ed={ed} />
            <Blocks v={v} picked={picked} setPicked={setPicked} onShowYaml={onShowYaml} ed={ed} forms={forms} />
          </>
        ) : (
          <YamlTab v={v} slug={slug} name={name} focus={focus} issues={allIssues(v)} reload={reload} onSaved={ed.ownSave} />
        )}
      </ThumbsProvider>
    </div>
  );
}
