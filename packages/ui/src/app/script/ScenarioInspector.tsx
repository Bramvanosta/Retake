/**
 * L5.10b: the scenario's inspector (B32-Scenario; replaces Inspector.tsx) — what the board's selection is:
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
import type { EntryBlock, HookBlock, SceneBlock, StepBlock, StepForms, VideoBlock } from '@retake/core';
import type { StepBinding } from '@retake/engine';
import { Txt, plural, shown, visibleControls } from '../bits.js';
import { hrefTo } from '../route.js';
import { IssueLines } from './StepEditing.js';
import type { StepEditor } from './StepEditing.js';
import { StepForm } from './StepForm.js';
import { NoThumb, Thumb } from '../Thumb.js';
import { bindingMark, keyWords, layoutWords, missingWords, seconds, verbWords } from '../words/scenario-words.js';
import type { View } from '../words/scenario-words.js';
import { Button, Facts, InspectorSection, StatusMark, Toolbar } from '../ui-kit/index.js';

type Range = { line: number; end_line: number };

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

/** "Show in the file · line 37" (→ the YAML view, its lines outlined). */
function ShowInFile({ range, onShowYaml }: { range: Range | undefined; onShowYaml: (r: Range) => void }) {
  if (!range) return <p className="sc-quiet">Its place in the file is not known.</p>;
  return (
    <div>
      <Button variant="ghost" size="sm" onClick={() => onShowYaml(range)}>
        {shown(range.line === range.end_line ? `Show in the file · line ${range.line}` : `Show in the file · lines ${range.line}–${range.end_line}`)}
      </Button>
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
        {/* No aria-keyshortcuts (review A L2): Alt+arrows and Delete act in the frames, not on these buttons. `data-step-action`:
            the button keeps the focus once its edit's view is here (review A L1: a second Enter works). */}
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
export function StepPicture({ binding, source, step, scene, size }: { binding: StepBinding | undefined; source: { run: string; mode: string } | null; step: StepBlock; scene: string; size: 'frame' | 'inspector' }) {
  if (!source) return <NoThumb size={size}>No run with pictures yet</NoThumb>;
  if (!binding) return <NoThumb size={size}>Not in this run</NoThumb>;
  if ('missing' in binding) return <NoThumb size={size}>{shown(missingWords(binding))}</NoThumb>;
  if (binding.picture === null) return <NoThumb size={size}>{shown(binding.status === 'skipped' ? 'Skipped in this run' : (binding.why ?? 'No picture in this run'))}</NoThumb>;
  // An attribute cannot be isolated (no <bdi>): the alt's direction controls are made visible (review A #8).
  return <Thumb run={source.run} runKey={binding.run_key} size={size} alt={visibleControls(altOf(step, scene, source.run, source.mode))} />;
}


function StepInspector({ v, slug, name, scene, step, sceneNo, ed, forms, moves, onShowYaml }: { v: View; slug: string; name: string; scene: SceneBlock; step: StepBlock; sceneNo: number | undefined; ed: StepEditor; forms: StepForms | null; moves: StepMoves; onShowYaml: (r: Range) => void }) {
  const b = v.steps[step.key];
  const bound = b && !('missing' in b) ? b : undefined;
  const page = v.untrusted.steps[step.key];
  const hint = step.action ? v.hints?.[step.action] : undefined;
  const r = step.range;
  const editing = ed.enabled;
  const form = editing && forms && step.form && step.locked === undefined;
  // Review B L8: the run's own words — a dry run is not "the last take".
  const inRun = v.source ? `in this ${v.source.mode === 'dry' ? 'rehearsal' : 'capture'}` : '';
  const length = bound?.ms !== undefined ? `took ${seconds(bound.ms)} ${inRun}` : v.source ? 'no length in this run' : 'not shot yet';
  // B32's order (review B L4): the picture, the title and its line, then the form (Action, Modifiers) — the rest after it.
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
      <InspectorSection title="As written" collapsible defaultOpen={!form}>
        <Args args={step.args} />
        {step.chips.length > 0 && (
          <Facts label="Modifiers" rows={step.chips.map((c, i) => ({ key: String(i), label: shown(c.kind), value: <Txt text={c.label} /> }))} />
        )}
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
      <div className="sb-inspector-foot">
        <ShowInFile range={r} onShowYaml={onShowYaml} />
      </div>
    </>
  );
}

/** A multi-page scene's pages (review B M1): each with its environment page and full URL, or the scene it continues from. */
function PagesFact({ e, f }: { e: SceneBlock; f: View['scenes'][string] }) {
  const facts = new Map((f.pages ?? []).map((p) => [p.id, p]));
  return (
    <ul className="sb-pages" data-testid="scene-pages">
      {(e.pages ?? []).map((p) => {
        const pf = facts.get(p.id);
        const page = pf?.page ?? p.page;
        const where = pf?.continues_from !== undefined ? `continues from ${pf.continues_from}` : pf?.url !== undefined ? `${pf.url}${pf.display !== undefined ? ` shown as ${pf.display}` : ''}` : (p.open ?? '—');
        const parts = [p.id + (p.label !== undefined ? ` (${p.label})` : ''), ...(page !== undefined ? [`page ${page}`] : []), where, ...(p.viewport !== undefined ? [p.viewport] : []), ...(p.persona !== undefined ? [`persona ${p.persona}`] : [])];
        return (
          <li key={p.id}>
            <Txt text={parts.join(' · ')} />
          </li>
        );
      })}
    </ul>
  );
}

/** A scene's flags in words beside its title (and in its inspector). */
export function SceneFlags({ e }: { e: SceneBlock }) {
  return (
    <>
      {e.skip && <StatusMark state="idle" word="skipped" />}
      {e.offscreen && <StatusMark state="idle" word="off camera: played, not in the video" />}
      {e.irreversible && <StatusMark state="idle" word="irreversible" />}
    </>
  );
}

function SceneInspector({ v, e, sceneNo, onShowYaml }: { v: View; e: SceneBlock; sceneNo: number | undefined; onShowYaml: (r: Range) => void }) {
  const f = v.scenes[e.id] ?? {};
  const url =
    f.continues_from !== undefined ? `continues from ${f.continues_from}` : f.url !== undefined ? `${f.url}${f.display !== undefined ? ` shown as ${f.display}` : ''}` : (e.open ?? '—');
  const rows: Array<{ key: string; label: ReactNode; value: ReactNode }> = e.pages
    ? [{ key: 'pages', label: 'Pages', value: <PagesFact e={e} f={f} /> }]
    : [
        { key: 'page', label: 'Page', value: <Txt text={e.page !== undefined ? `${e.page}${e.page_inherited ? ' (from the scene before)' : ''}` : 'the first page'} /> },
        { key: 'url', label: 'URL', value: <Txt className="k-mono" text={url} /> },
      ];
  rows.push(
    ...(e.persona !== undefined ? [{ key: 'persona', label: 'Persona', value: <Txt text={e.persona} /> }] : []),
    { key: 'speed', label: 'Speed', value: shown(e.speed !== undefined ? `×${e.speed}` : 'normal') },
    { key: 'layout', label: 'Layout', value: <Txt text={e.pages || e.frame !== undefined ? layoutWords(e.frame, v.blocks.video.frame, e.pages?.length ?? 1) : "the video's"} /> },
    {
      key: 'duration',
      label: 'Duration',
      value: (
        <span>
          {shown(f.captured_s !== undefined ? `${f.captured_s.toFixed(1)} s captured` : 'not captured yet')}
          {f.run_status && f.run_status !== 'ok' && (
            <>
              {' · '}
              <StatusMark state={f.run_status === 'failed' ? 'fail' : 'warn'} word={`${f.run_status} in this run`} />
            </>
          )}
        </span>
      ),
    },
    ...(e.transition !== undefined ? [{ key: 'transition', label: 'Transition', value: <Txt text={e.transition} /> }] : []),
    ...(e.cursor !== undefined ? [{ key: 'cursor', label: 'Cursor', value: <Txt text={e.cursor} /> }] : []),
    ...(e.still !== undefined ? [{ key: 'still', label: 'Still', value: shown(`${e.still} s`) }] : []),
    ...(e.tutorial !== undefined ? [{ key: 'tutorial', label: 'Tutorial', value: <Txt text={e.tutorial} /> }] : []),
  );
  return (
    <>
      <InspectorSection title={<span data-testid="inspector-scene">{shown(`Scene ${sceneNo ?? '—'} · ${e.caption?.kicker ?? e.id}`)}</span>}>
        <div className="sb-scene-facts" data-testid="scene-facts" data-scene={e.id}>
          <Txt className="k-mono sc-quiet" text={e.id} />
          {e.caption && (
            <p>
              <Txt text={e.caption.text} />
            </p>
          )}
          <SceneFlags e={e} />
          <Facts rows={rows} />
          {e.note !== undefined && <Txt className="sc-quiet" text={`Note: ${e.note}`} />}
          {e.comment && (
            <p className="sb-pre sc-quiet">
              <Txt text={e.comment} />
            </p>
          )}
          {e.steps_locked !== undefined && <Txt className="sc-quiet" text={`Steps not movable here: ${e.steps_locked}`} />}
          <IssueLines issues={e.issues} />
        </div>
      </InspectorSection>
      <div className="sb-inspector-foot">
        <ShowInFile range={e.range} onShowYaml={onShowYaml} />
      </div>
    </>
  );
}

function EntryInspector({ e, onShowYaml }: { e: Exclude<EntryBlock, SceneBlock>; onShowYaml: (r: Range) => void }) {
  if (e.type === 'unknown') {
    return (
      <InspectorSection title={`Entry ${e.index + 1}`}>
        <StatusMark state="fail" word="Unreadable entry" />
        <IssueLines issues={e.issues} />
        <ShowInFile range={e.range} onShowYaml={onShowYaml} />
      </InspectorSection>
    );
  }
  const rows: Array<{ key: string; label: ReactNode; value: ReactNode }> = [
    { key: 'id', label: 'Id', value: <Txt className="k-mono" text={e.id} /> },
    ...(e.component !== undefined ? [{ key: 'component', label: 'Component', value: <Txt text={e.component} /> }] : []),
    ...(e.file ? [{ key: 'file', label: 'File', value: <Txt className="k-mono" text={`${e.file.kind} ${e.file.path}`} /> }] : []),
    { key: 'duration', label: 'Length', value: shown(e.duration !== undefined ? `${e.duration} s` : "the theme's default") },
    ...(e.type === 'card' && e.slots ? Object.entries(e.slots).map(([k, s]) => ({ key: `slot-${k}`, label: <Txt className="k-mono" text={k} />, value: <Txt text={s} /> })) : []),
    ...(e.type === 'interstitial' && e.kicker !== undefined ? [{ key: 'kicker', label: 'Kicker', value: <Txt text={e.kicker} /> }] : []),
    ...(e.type === 'interstitial' && e.text !== undefined ? [{ key: 'text', label: 'Text', value: <Txt text={e.text} /> }] : []),
    ...(e.type === 'card' && e.transition !== undefined ? [{ key: 'transition', label: 'Transition', value: <Txt text={e.transition} /> }] : []),
  ];
  return (
    <InspectorSection title={e.type === 'card' ? 'Card' : 'Text between scenes'}>
      <Facts rows={rows} />
      {e.comment && (
        <p className="sb-pre sc-quiet">
          <Txt text={e.comment} />
        </p>
      )}
      <IssueLines issues={e.issues} />
      <ShowInFile range={e.range} onShowYaml={onShowYaml} />
    </InspectorSection>
  );
}

function HookItem({ h }: { h: HookBlock }) {
  return (
    <li className="sb-hook" data-testid="hook">
      <p className="sb-hook-head">
        <Txt className="sb-hook-kind" text={h.kind ?? 'unknown'} />
        {h.name !== undefined ? <Txt className="sb-hook-name" text={h.name} /> : <span className="sc-quiet">{shown(`hook ${h.index + 1}`)}</span>}
      </p>
      {h.flags.length > 0 && (
        <p className="sb-hook-flags">
          {h.flags.map((f) => (
            <Txt key={f.kind} className={f.kind === 'destructive' ? 'sb-hook-flag is-strong' : 'sb-hook-flag'} text={f.label} />
          ))}
        </p>
      )}
      <Txt className="k-mono sb-hook-summary" text={h.summary} />
      {h.rollback && <Txt className="sc-quiet" text={`Rollback: ${h.rollback}`} />}
      {h.needs_person && (
        <p>
          <strong className="sb-strong">Needs a person</strong>
          {': '}
          <Txt text={h.needs_person} />
        </p>
      )}
      <IssueLines issues={h.issues} />
    </li>
  );
}

function HooksInspector({ v, phase }: { v: View; phase: 'before' | 'after' }) {
  const { setup, teardown, named } = v.blocks.hooks;
  const outcome = v.source?.hooks;
  const list = phase === 'before' ? setup : teardown;
  return (
    <div data-testid="hooks">
      <InspectorSection title={phase === 'before' ? 'Before filming' : 'After filming'}>
        <p className="sc-quiet">
          {shown(phase === 'before' ? 'The setup hooks, run before the take (not by a rehearsal).' : 'The teardown hooks, run after the take (not by a rehearsal).')}
          {outcome && shown(` In this run: ${phase === 'before' ? outcome.setup : outcome.teardown}.`)}
        </p>
        {list.length === 0 ? (
          <p className="sc-quiet">None.</p>
        ) : (
          <ol className="sb-hooks">
            {list.map((h) => (
              <HookItem key={h.index} h={h} />
            ))}
          </ol>
        )}
      </InspectorSection>
      {phase === 'before' && named.length > 0 && (
        <InspectorSection title="During the take, off camera">
          <div data-testid="named-hooks">
            <p className="sc-quiet">{shown(`Named hooks: run during the take by a hook step, off camera${outcome?.steps ? ` · in this run: ${outcome.steps}` : ''}.`)}</p>
            <ol className="sb-hooks">
              {named.map((h) => (
                <HookItem key={`${h.hook}-${h.index}`} h={h} />
              ))}
            </ol>
          </div>
        </InspectorSection>
      )}
    </div>
  );
}

function endCard(c: VideoBlock['intro']): string {
  if (c.mode === 'theme') return "the theme's";
  if (c.mode === 'off') return 'none';
  return [c.component, c.file ? `${c.file.kind} ${c.file.path}` : undefined, c.duration !== undefined ? `${c.duration} s` : undefined, c.tagline ? `“${c.tagline}”` : undefined, c.url].filter(Boolean).join(' · ') || 'custom';
}

/** The Video inspector's location (review A L6): the file's own, and the tab's choice for Dry run and Capture when it differs. */
export interface VideoLocation {
  file: string | undefined;
  fileFlags: string;
  chosen?: string;
}

function VideoInspector({ v, comments, location }: { v: View; comments: ReactNode; location: VideoLocation }) {
  const b = v.blocks.video;
  const own = location.file !== undefined ? `${location.file}${location.fileFlags ? ` · ${location.fileFlags}` : ''}${b.env === undefined ? " (the project's default)" : ''}` : 'none';
  const rows: Array<{ key: string; label: ReactNode; value: ReactNode }> = [
    ...(b.name !== undefined ? [{ key: 'name', label: 'Name', value: <Txt text={b.name} /> }] : []),
    ...(b.title ? [{ key: 'title', label: 'Title', value: <Txt text={[b.title.kicker, b.title.text].filter(Boolean).join(' — ')} /> }] : []),
    { key: 'env', label: 'Location', value: <Txt text={`${own}${location.chosen !== undefined ? ` (Rehearse and Capture: ${location.chosen})` : ''}`} /> },
    ...(b.template !== undefined ? [{ key: 'template', label: 'Template', value: <Txt text={b.template} /> }] : []),
    ...(b.frame !== undefined ? [{ key: 'frame', label: 'Frame', value: <Txt text={b.frame} /> }] : []),
    { key: 'intro', label: 'Intro', value: <Txt text={endCard(b.intro)} /> },
    { key: 'outro', label: 'Outro', value: <Txt text={endCard(b.outro)} /> },
    ...(b.music ? [{ key: 'music', label: 'Music', value: <Txt text={[b.music.file, b.music.volume !== undefined ? `volume ${b.music.volume}` : undefined].filter(Boolean).join(' · ')} /> }] : []),
    ...(b.tutorial !== undefined ? [{ key: 'tutorial', label: 'Tutorial', value: <Txt text={b.tutorial} /> }] : []),
    ...(b.clock !== undefined ? [{ key: 'clock', label: 'Clock', value: <Txt text={b.clock} /> }] : []),
    ...(b.capture
      ? [{ key: 'capture', label: 'Capture', value: <Txt text={[b.capture.width && b.capture.height ? `${b.capture.width} × ${b.capture.height}` : undefined, b.capture.fps ? `${b.capture.fps} fps` : undefined, b.capture.scale ? `scale ${b.capture.scale}` : undefined, b.capture.keep_frames === true ? 'frames kept' : undefined].filter(Boolean).join(' · ')} /> }]
      : []),
    ...(b.pacing ? [{ key: 'pacing', label: 'Pacing', value: <Txt text={b.pacing.join(', ')} /> }] : []),
    ...(b.vars ? [{ key: 'vars', label: 'Variables', value: <Txt text={b.vars.join(', ')} /> }] : []),
    ...(b.mocks !== undefined ? [{ key: 'mocks', label: 'Mocks', value: plural(b.mocks, 'mock') }] : []),
  ];
  return (
    <div data-testid="video-block">
      <InspectorSection title="Video">
        <Facts rows={rows} />
        {shown(comments)}
      </InspectorSection>
      {b.comment && (
        <InspectorSection title="Notes from the file">
          <p className="sb-pre">
            <Txt text={b.comment} />
          </p>
        </InspectorSection>
      )}
    </div>
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
