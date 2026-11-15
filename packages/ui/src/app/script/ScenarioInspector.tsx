/**
 * The scenario's inspector (B32-Scenario; replaces Inspector.tsx) — what the board's selection is:
 * - a **step** (B32's order): its picture (the inspector's width, 16:9), "Step 3 · Click", its scene and how long it took
 *   in the run shown, its form (StepForm.tsx: the action's fields in words, other ways to find its target, the modifiers
 *   as switches) or its target, what the action does (the language's description), its edit buttons (Move up / Move
 *   down / Duplicate / Delete, the same edits as the keys and drag & drop) or why it is read-only, then "In this run" (its
 *   state, length, moved / changed words, Show in timeline, and — in a box titled "From the page" — the target as the run
 *   found it, its error and the URL: text the filmed site controls) and "As written" (its arguments, its comment, its
 *   lines in the file); Show in the file;
 * - a **scene**: its caption, flags, facts (page and URL — or each page of a multi-page scene —, persona, speed,
 *   layout, captured length, transition, cursor, still, tutorial), its note, comment and issues;
 * - a **card** or an **interstitial** (component, file, length, slots or kicker and text, transition, issues);
 * - **Before filming** / **After filming**: the hooks (kind, name, flags as words, what they run, rollback, a person
 *   needed, issues; the named hooks run during the take, off camera) and this run's outcome;
 * - the **video**: its facts (its location: the file's own, and the tab's choice for Dry run and Capture beside it) and
 *   the notes from the file.
 * Every value from the file or the filmed site is a text node (`Txt` / a kit slot).
 */
import type { ReactNode } from 'react';
import type { EntryBlock, SceneBlock, StepBlock, StepForms } from '@retake/core/scenario';
import type { StepBinding } from '@retake/engine';
import { Txt, shown, visibleControls } from '../bits.js';
import { hrefTo } from '../route.js';
import { IssueLines } from './StepEditing.js';
import type { StepEditor } from './StepEditing.js';
import { StepForm } from './StepForm.js';
import { NoThumb, Thumb } from '../Thumb.js';
import { bindingMark, keyWords, missingWords, seconds, verbWords } from '../words/scenario-words.js';
import type { View } from '../words/scenario-words.js';
import { Button, Facts, InspectorSection, StatusMark, Toolbar } from '../ui-kit/index.js';
import { EntryInspector, HooksInspector, SceneInspector, ShowInFile, VideoInspector } from './entry-inspectors.js';
import type { Range, VideoLocation } from './entry-inspectors.js';

export { SceneFlags } from './entry-inspectors.js';
export type { VideoLocation } from './entry-inspectors.js';

/** A value as compact text (strings as they are; anything else as JSON), capped. */
function valueText(v: unknown): string {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s === undefined ? String(v) : s.length > 2000 ? `${s.slice(0, 2000)}…` : s;
}

function Args({ args }: { args: unknown }) {
  if (args === undefined || args === null) return <p className="sc-quiet">No arguments.</p>;
  if (typeof args !== 'object' || Array.isArray(args)) return <Txt className="k-mono" text={valueText(args)} />;
  const entries = Object.entries(args as Record<string, unknown>);
  if (entries.length === 0) return <p className="sc-quiet">No arguments.</p>;
  return (
    <div data-testid="inspector-args">
      <Facts rows={entries.map(([k, v]) => ({ key: k, label: <Txt className="k-mono" text={k} />, value: <Txt className="k-mono" text={valueText(v)} /> }))} />
    </div>
  );
}

/** The step's edit buttons (the same edits as the keyboard and drag & drop). */
export interface StepMoves {
  up: boolean;
  down: boolean;
  move: (dir: -1 | 1) => void;
  act: (kind: 'delete_step' | 'duplicate_step') => void;
}

function StepActions({ disabled, locked, moves }: { disabled: boolean; locked: string | undefined; moves: StepMoves }) {
  return (
    <div className="sb-step-actions" data-testid="step-actions">
      <Toolbar label="Step">
        {/* No aria-keyshortcuts: Alt+arrows and Delete act in the frames, not on these buttons. `data-step-action`:
            the button keeps the focus once its edit's view is here (a second Enter works). */}
        <Button size="sm" disabled={disabled || !moves.up} onClick={() => moves.move(-1)} data-step-action="up">
          Move up
        </Button>
        <Button size="sm" disabled={disabled || !moves.down} onClick={() => moves.move(1)} data-step-action="down">
          Move down
        </Button>
        <Button size="sm" disabled={disabled} onClick={() => moves.act('duplicate_step')} data-step-action="duplicate">
          Duplicate
        </Button>
        <Button size="sm" variant="destructive" disabled={disabled} onClick={() => moves.act('delete_step')} data-step-action="delete">
          Delete
        </Button>
      </Toolbar>
      {locked !== undefined && (
        <p className="sc-quiet">
          {'Not movable here: '}
          <Txt text={locked} />
        </p>
      )}
    </div>
  );
}

/** The image's alt: the step from the scenario's own words (never page text) and the run. */
export function altOf(step: StepBlock, scene: string, run: string, mode: string): string {
  return `${step.label}${step.target ? ` ${step.target}` : ''} — step ${step.index + 1} of scene ${scene}, at the end of the step in ${mode === 'dry' ? 'rehearsal' : 'capture'} ${run}`;
}

/** A step's picture from the source run, or why there is none — in words, in the same box. */
export function StepPicture({
  binding,
  source,
  step,
  scene,
  size,
}: {
  binding: StepBinding | undefined;
  source: { run: string; mode: string } | null;
  step: StepBlock;
  scene: string;
  size: 'frame' | 'inspector';
}) {
  if (!source) return <NoThumb size={size}>No run with pictures yet</NoThumb>;
  if (!binding) return <NoThumb size={size}>Not in this run</NoThumb>;
  if ('missing' in binding) return <NoThumb size={size}>{shown(missingWords(binding))}</NoThumb>;
  if (binding.picture === null) return <NoThumb size={size}>{shown(binding.status === 'skipped' ? 'Skipped in this run' : (binding.why ?? 'No picture in this run'))}</NoThumb>;
  // An attribute cannot be isolated (no <bdi>): the alt's direction controls are made visible.
  return <Thumb run={source.run} runKey={binding.run_key} size={size} alt={visibleControls(altOf(step, scene, source.run, source.mode))} />;
}

function StepInspector({
  v,
  slug,
  name,
  scene,
  step,
  sceneNo,
  ed,
  forms,
  moves,
  onShowYaml,
}: {
  v: View;
  slug: string;
  name: string;
  scene: SceneBlock;
  step: StepBlock;
  sceneNo: number | undefined;
  ed: StepEditor;
  forms: StepForms | null;
  moves: StepMoves;
  onShowYaml: (r: Range) => void;
}) {
  const b = v.steps[step.key];
  const bound = b && !('missing' in b) ? b : undefined;
  const hint = step.action ? v.hints?.[step.action] : undefined;
  const r = step.range;
  const editing = ed.enabled;
  const form = editing && forms && step.form && step.locked === undefined;
  // The run's own words — a dry run is not "the last take".
  const inRun = v.source ? `in this ${v.source.mode === 'dry' ? 'rehearsal' : 'capture'}` : '';
  const length = bound?.ms !== undefined ? `took ${seconds(bound.ms)} ${inRun}` : v.source ? 'no length in this run' : 'not shot yet';
  // B32's order: the picture, the title and its line, then the form (Action, Modifiers) — the rest after it.
  return (
    <>
      <div className="sb-inspector-picture">
        <StepPicture binding={b} source={v.source ? { run: v.source.run, mode: v.source.mode } : null} step={step} scene={scene.id} size="inspector" />
      </div>
      <InspectorSection title={<span data-testid="inspector-step">{shown(`Step ${step.index + 1} · ${verbWords(step.category)}`)}</span>}>
        <p className="sc-quiet">
          <Txt text={`${sceneNo !== undefined ? `Scene ${sceneNo} · ` : ''}${scene.caption?.kicker ?? scene.id}`} />
          {shown(` · ${length}`)}
        </p>
        {form && forms && <StepForm key={step.key} slug={slug} name={name} forms={forms} scene={scene} step={step} ed={ed} />}
        {step.target && !form && (
          <p>
            <span className="sc-quiet">{'Target '}</span>
            <Txt text={step.target} />
          </p>
        )}
        {hint && (
          <p className="sc-quiet" data-testid="inspector-hint">
            <Txt text={hint} />
          </p>
        )}
        {editing && <StepActions disabled={!ed.enabled || ed.busy || step.locked !== undefined} locked={step.locked} moves={moves} />}
        <p className="sc-quiet" data-testid="edit-hint">
          {shown(
            editing && step.locked === undefined
              ? step.form
                ? 'Change its values in the form, move, duplicate or delete it here; change anything else'
                : 'Move, duplicate or delete it here; change its values'
              : 'Read-only here: change this step',
          )}
          {' in '}
          <Txt className="k-mono" text={v.file} />
          {shown(`${r ? ` (line ${r.line})` : ''} or the YAML view, or ask Claude to change it.`)}
        </p>
        <IssueLines issues={step.issues} />
      </InspectorSection>
      <StepRun v={v} step={step} />
      <AsWritten v={v} step={step} form={!!form} />
      <div className="sb-inspector-foot">
        <ShowInFile range={r} onShowYaml={onShowYaml} />
      </div>
    </>
  );
}

/** The step "In this run": its state, length, moved / changed words, Show in timeline, and what the page said. */
function StepRun({ v, step }: { v: View; step: StepBlock }) {
  const b = v.steps[step.key];
  const bound = b && !('missing' in b) ? b : undefined;
  const page = v.untrusted.steps[step.key];
  return (
    <InspectorSection title="In this run" collapsible>
      {!v.source ? (
        <p className="sc-quiet">No run with pictures yet.</p>
      ) : !b ? (
        <p className="sc-quiet">Not in this run.</p>
      ) : 'missing' in b ? (
        <p data-testid="inspector-run">
          <StatusMark state={bindingMark(b, true)} word={missingWords(b)} />
          {b.run_key && b.run_key !== step.key && <Txt className="sc-quiet" text={` (${keyWords(b.run_key)} in that run)`} />}
        </p>
      ) : (
        <p data-testid="inspector-run">
          {b.moved && shown('Moved since this run: the picture shows it at its old place · ')}
          {shown(b.status)}
          {b.ms !== undefined && shown(` · ${seconds(b.ms)}`)}
          {b.picture && shown(` · picture from ${b.picture.replace('_', ' ')}`)}
          {b.run_key !== step.key && <Txt text={` · ${keyWords(b.run_key)} in that run`} />}
          {b.why && <Txt text={` · ${b.why}`} />}
          {v.source.mode === 'capture' && (
            <>
              {' · '}
              <a href={hrefTo({ name: 'timeline', slug: v.project, scenario: v.name, run: v.source.run, step: b.run_key })} data-testid="show-in-timeline">
                Show in timeline
              </a>
            </>
          )}
        </p>
      )}
      {bound && v.source?.notice === 'cannot_tell' && <p className="sc-quiet">Matched by position: cannot tell whether it changed.</p>}
      {page && (page.target !== undefined || page.error !== undefined || page.url !== undefined) && (
        <div className="sb-from-page" data-testid="from-page">
          <p className="sb-from-page-title">From the page (text the site controls)</p>
          {page.target !== undefined && (
            <p>
              {'Found: '}
              <Txt text={page.target} />
            </p>
          )}
          {page.error !== undefined && (
            <p className="sb-pre">
              {'Error: '}
              <Txt text={page.error} />
            </p>
          )}
          {page.url !== undefined && (
            <p>
              {'At: '}
              <Txt className="k-mono" text={page.url} />
            </p>
          )}
        </div>
      )}
    </InspectorSection>
  );
}

/** The step "As written": its arguments, modifiers, comment and lines in the file. */
function AsWritten({ v, step, form }: { v: View; step: StepBlock; form: boolean }) {
  const r = step.range;
  return (
    <InspectorSection title="As written" collapsible defaultOpen={!form}>
      <Args args={step.args} />
      {step.chips.length > 0 && <Facts label="Modifiers" rows={step.chips.map((c, i) => ({ key: String(i), label: shown(c.kind), value: <Txt text={c.label} /> }))} />}
      {step.comment && (
        <p className="sb-pre sc-quiet">
          <Txt text={step.comment} />
        </p>
      )}
      {r && (
        <pre className="sb-slice k-mono" data-testid="inspector-source">
          <Txt text={v.text.slice(r.start, r.end)} />
        </pre>
      )}
      {step.aliased && <p className="sc-quiet">Written as a YAML alias: it repeats another step.</p>}
    </InspectorSection>
  );
}

export type Selected =
  | { kind: 'step'; scene: SceneBlock; step: StepBlock; sceneNo: number | undefined }
  | { kind: 'scene'; scene: SceneBlock; sceneNo: number | undefined }
  | { kind: 'entry'; entry: Exclude<EntryBlock, SceneBlock> }
  | { kind: 'video' }
  | { kind: 'before' }
  | { kind: 'after' }
  | { kind: 'none' };

export function ScenarioInspector({
  v,
  slug,
  name,
  sel,
  ed,
  forms,
  moves,
  onShowYaml,
  comments,
  location,
}: {
  v: View;
  slug: string;
  name: string;
  sel: Selected;
  ed: StepEditor;
  forms: StepForms | null;
  moves: StepMoves;
  onShowYaml: (r: Range) => void;
  /** The open comments' link (the Video inspector shows it too). */
  comments: ReactNode;
  location: VideoLocation;
}) {
  return (
    <div className="sb-inspector" data-testid="inspector">
      {sel.kind === 'step' && <StepInspector v={v} slug={slug} name={name} scene={sel.scene} step={sel.step} sceneNo={sel.sceneNo} ed={ed} forms={forms} moves={moves} onShowYaml={onShowYaml} />}
      {sel.kind === 'scene' && <SceneInspector v={v} e={sel.scene} sceneNo={sel.sceneNo} onShowYaml={onShowYaml} />}
      {sel.kind === 'entry' && <EntryInspector e={sel.entry} onShowYaml={onShowYaml} />}
      {(sel.kind === 'before' || sel.kind === 'after') && <HooksInspector v={v} phase={sel.kind} />}
      {sel.kind === 'video' && <VideoInspector v={v} comments={comments} location={location} />}
      {sel.kind === 'none' && (
        <InspectorSection title="Nothing selected">
          <p className="sc-quiet">Select a frame, a scene or a card to see it here.</p>
        </InspectorSection>
      )}
    </div>
  );
}
