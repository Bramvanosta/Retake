/**
 * The inspector for what is not a step (ScenarioInspector.tsx picks one): a scene (its facts, pages and flags), a card
 * or an interstitial, the hooks before and after filming, and the video; and "Show in the file", which all of them share.
 * Every value from the file or the filmed site is a text node (`Txt` / a kit slot).
 */
import type { ReactNode } from 'react';
import type { EntryBlock, HookBlock, SceneBlock, VideoBlock } from '@retake/core/scenario';
import { Txt, plural, shown } from '../bits.js';
import { IssueLines } from './StepEditing.js';
import { layoutWords } from '../words/scenario-words.js';
import type { View } from '../words/scenario-words.js';
import { Button, Facts, InspectorSection, StatusMark } from '../ui-kit/index.js';

export type Range = { line: number; end_line: number };

/** "Show in the file · line 37" (→ the YAML view, its lines outlined). */
export function ShowInFile({ range, onShowYaml }: { range: Range | undefined; onShowYaml: (r: Range) => void }) {
  if (!range) return <p className="sc-quiet">Its place in the file is not known.</p>;
  return (
    <div>
      <Button variant="ghost" size="sm" onClick={() => onShowYaml(range)}>
        {shown(range.line === range.end_line ? `Show in the file · line ${range.line}` : `Show in the file · lines ${range.line}–${range.end_line}`)}
      </Button>
    </div>
  );
}

/** A multi-page scene's pages: each with its environment page and full URL, or the scene it continues from. */
function PagesFact({ e, f }: { e: SceneBlock; f: View['scenes'][string] }) {
  const facts = new Map((f.pages ?? []).map((p) => [p.id, p]));
  return (
    <ul className="sb-pages" data-testid="scene-pages">
      {(e.pages ?? []).map((p) => {
        const pf = facts.get(p.id);
        const page = pf?.page ?? p.page;
        const where =
          pf?.continues_from !== undefined ? `continues from ${pf.continues_from}` : pf?.url !== undefined ? `${pf.url}${pf.display !== undefined ? ` shown as ${pf.display}` : ''}` : (p.open ?? '—');
        const parts = [
          p.id + (p.label !== undefined ? ` (${p.label})` : ''),
          ...(page !== undefined ? [`page ${page}`] : []),
          where,
          ...(p.viewport !== undefined ? [p.viewport] : []),
          ...(p.persona !== undefined ? [`persona ${p.persona}`] : []),
        ];
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

export function SceneInspector({ v, e, sceneNo, onShowYaml }: { v: View; e: SceneBlock; sceneNo: number | undefined; onShowYaml: (r: Range) => void }) {
  const f = v.scenes[e.id] ?? {};
  const url = f.continues_from !== undefined ? `continues from ${f.continues_from}` : f.url !== undefined ? `${f.url}${f.display !== undefined ? ` shown as ${f.display}` : ''}` : (e.open ?? '—');
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

export function EntryInspector({ e, onShowYaml }: { e: Exclude<EntryBlock, SceneBlock>; onShowYaml: (r: Range) => void }) {
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

export function HooksInspector({ v, phase }: { v: View; phase: 'before' | 'after' }) {
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
  return (
    [c.component, c.file ? `${c.file.kind} ${c.file.path}` : undefined, c.duration !== undefined ? `${c.duration} s` : undefined, c.tagline ? `“${c.tagline}”` : undefined, c.url]
      .filter(Boolean)
      .join(' · ') || 'custom'
  );
}

/** The Video inspector's location: the file's own, and the tab's choice for Dry run and Capture when it differs. */
export interface VideoLocation {
  file: string | undefined;
  fileFlags: string;
  chosen?: string;
}

export function VideoInspector({ v, comments, location }: { v: View; comments: ReactNode; location: VideoLocation }) {
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
      ? [
          {
            key: 'capture',
            label: 'Capture',
            value: (
              <Txt
                text={[
                  b.capture.width && b.capture.height ? `${b.capture.width} × ${b.capture.height}` : undefined,
                  b.capture.fps ? `${b.capture.fps} fps` : undefined,
                  b.capture.scale ? `scale ${b.capture.scale}` : undefined,
                  b.capture.keep_frames === true ? 'frames kept' : undefined,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              />
            ),
          },
        ]
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
