/**
 * A scenario (L4.2, R-UI-08..10, R-UI-13, R-UI-14; L5.10b: « Épure » — B32-Scenario, R4-Source) — one
 * `scenario_blocks` read gives the file, its blocks (video header, setup / teardown hooks, scenes with their steps,
 * cards, interstitials), its issues, what would stop a run from the Studio (`run_blockers`), the scenario's runs (the
 * "Pictures from" picker), the source run and every step's binding to it.
 *
 * The screen in the shell: the scenario's name is the page's (visually hidden) h1 — the title bar names it; the title
 * bar's context holds the View (Board · YAML) and the Location (critique M1: the environment Rehearse and Capture use,
 * remembered per scenario in this tab only, sent as `env` only when it is not the file's own; L5.11a: one choice shared
 * with Prepare and the status bar — run-location.ts); the browser shows the scenario's entries (ScenesBrowser.tsx); the
 * inspector what is selected (ScenarioInspector.tsx — the File in the YAML view). Above both views: a run of this
 * scenario queued or running (TakeStrip.tsx `Running`: review B M1) and, once, a remembered location project.yaml no
 * longer has (dropped: review A M1). L5.11a: Rehearse, Capture and Render are the status bar's; this screen feeds it
 * what it read (its view, its run_status, its renders: no second read — critique H2) and the hash it shows. One resolved selection drives the board, the browser and the inspector (`resolveSelection`: review B M2). The
 * centre: the take strip (TakeStrip.tsx), the file's notices
 * (not valid YAML, its issues, the steps limit, a YAML draft open), the edit bar (StepEditing.tsx), the palette, the
 * storyboard (Storyboard.tsx) and, closed at its end, the renders (Renders.tsx; L5.12a: their reviews are the Review report's).
 *
 * Events (critique B1): the view is read again only for this scenario's own file, a run of this scenario that appears,
 * changes status or goes away, the picker, a reconnection or the window's focus — a running run's progress is a
 * `run_status` read, never the whole view. Every string from the file or the filmed site is a text node (`Txt` / a kit
 * slot); page text stays in boxes titled "From the page".
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { EntryBlock, SceneBlock, StepForms } from '@demo-studio/core';
import { call, useCall } from './api.js';
import { Txt, plural } from './bits.js';
import { envFlagWords } from './board-words.js';
import { useScenarioEvents } from './events.js';
import { useProjectView } from './project-data.js';
import { RenderJobs, RenderOutcome, RendersList, useRenders, useReportEntry } from './Renders.js';
import type { RendersState } from './Renders.js';
import { chooseLocation, useRunLocation } from './run-location.js';
import { useFeedActions, useRunChanged, useRunProgress, useShownFile } from './shoot-data.js';
import type { FedActions } from './shoot-data.js';
import { hrefTo } from './route.js';
import type { ScenarioTab } from './route.js';
import { ShellSlot } from './shell/slots.js';
import { ThumbsProvider } from './Thumb.js';
import type { ThumbAnswer } from './thumbs.js';
import { FileInspector, YamlTab } from './YamlTab.js';
import { scenarioKey, useDirty } from './drafts.js';
import { keyboardMove } from './step-edit.js';
import type { SceneSlots } from './step-edit.js';
import { EditBar, IssueLines, useStepEditor } from './StepEditing.js';
import { Palette } from './StepForm.js';
import { ScenarioInspector } from './ScenarioInspector.js';
import type { Selected, StepMoves } from './ScenarioInspector.js';
import { ScenesBrowser } from './ScenesBrowser.js';
import { usePaletteGroup } from './shell/command-bus.js';
import { Storyboard } from './Storyboard.js';
import type { BoardMoves, Subject } from './Storyboard.js';
import { CommentsCount, Running, TakeStrip } from './TakeStrip.js';
import type { RunLocation } from './TakeStrip.js';
import { timelineRun } from './scenario-words.js';
import type { View } from './scenario-words.js';
import { Button, Callout, Disclosure, LinkButton, Select, SegmentedLinks } from './ui-kit/index.js';

export { timelineRun };

/** Every issue of the file, wherever its block is. */
export function allIssues(v: View) {
  const out = [...v.blocks.issues];
  for (const h of [...v.blocks.hooks.setup, ...v.blocks.hooks.teardown, ...v.blocks.hooks.named]) out.push(...h.issues);
  for (const e of v.blocks.entries) {
    out.push(...e.issues);
    if (e.type === 'scene') for (const s of e.steps) out.push(...s.issues);
  }
  return out;
}

/**
 * Renders (L4.5 part E; L5.12a: the card on the kit, R-UI-46) — the queue (Cancel), the newest failure, the newest three
 * renders (version, when, the verdict, whether it shows this file) and the Review report; Render is the status bar's.
 */
function RendersCard({ v, slug, name, r }: { v: View; slug: string; name: string; r: RendersState }) {
  const run = timelineRun(v);
  const shown = { ...(run ? { run } : {}), hash: v.hash };
  return (
    <section className="sb-renders" aria-label="Renders" data-testid="renders-card">
      <RenderOutcome r={r} />
      <RenderJobs r={r} shown={shown} />
      <RendersList r={r} slug={slug} name={name} shown={shown} limit={3} />
      <p className="sc-quiet">
        <LinkButton size="sm" variant="ghost" to={{ name: 'review', slug, scenario: name }} testId="open-review-report">
          Open the review report
        </LinkButton>
      </p>
    </section>
  );
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

/**
 * What the board's selection is, resolved against the view — ONE value drives the board's marks, the browser's row and
 * the inspector (review B M2). Nothing picked yet: the first step. A picked step, scene or card that is no longer in the
 * file is never replaced by another step (whose Delete the person would not expect): a gone step leaves its scene
 * selected, else the video; a gone scene or card, the video. `subject` is the resolved selection as a Subject.
 */
export function resolveSelection(v: View, subject: Subject | null): { sel: Selected; subject: Subject } {
  const scenes = v.blocks.entries.filter((e): e is SceneBlock => e.type === 'scene');
  const no = (s: SceneBlock) => scenes.indexOf(s) + 1;
  const video = { sel: { kind: 'video' } as Selected, subject: { kind: 'video' } as Subject };
  const sceneOf = (s: SceneBlock) => ({ sel: { kind: 'scene', scene: s, sceneNo: no(s) } as Selected, subject: { kind: 'scene', id: s.id } as Subject });
  if (subject === null) {
    const s = scenes.find((x) => x.steps.length > 0);
    return s ? { sel: { kind: 'step', scene: s, step: s.steps[0], sceneNo: no(s) }, subject: { kind: 'step', key: s.steps[0].key } } : video;
  }
  switch (subject.kind) {
    case 'step': {
      for (const s of scenes) {
        const st = s.steps.find((x) => x.key === subject.key);
        if (st) return { sel: { kind: 'step', scene: s, step: st, sceneNo: no(s) }, subject };
      }
      // The step's key is "<scene>.<index>": its scene, when it is still there.
      const gone = scenes.find((s) => subject.key.startsWith(`${s.id}.`) && /^\d+$/.test(subject.key.slice(s.id.length + 1)));
      return gone ? sceneOf(gone) : video;
    }
    case 'scene': {
      const s = scenes.find((x) => x.id === subject.id);
      return s ? { ...sceneOf(s), subject } : video;
    }
    case 'entry': {
      const e = v.blocks.entries.find((x): x is Exclude<EntryBlock, SceneBlock> => x.index === subject.index && x.type !== 'scene');
      return e ? { sel: { kind: 'entry', entry: e }, subject } : video;
    }
    default:
      return { sel: { kind: subject.kind }, subject };
  }
}

/** Two selections are the same. */
function sameSubject(a: Subject, b: Subject): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The lines a browser row stands for in the YAML view. */
function rangeOf(v: View, s: Subject): { line: number; end_line: number } | null {
  if (s.kind === 'video') return { line: 1, end_line: 1 };
  if (s.kind === 'before' || s.kind === 'after') {
    const hs = s.kind === 'before' ? v.blocks.hooks.setup : v.blocks.hooks.teardown;
    const first = hs.find((h) => h.range)?.range;
    const last = [...hs].reverse().find((h) => h.range)?.range;
    return first && last ? { line: first.line, end_line: last.end_line } : null;
  }
  const e = s.kind === 'scene' ? v.blocks.entries.find((x) => x.type === 'scene' && x.id === s.id) : s.kind === 'entry' ? v.blocks.entries.find((x) => x.index === s.index) : undefined;
  return e?.range ? { line: e.range.line, end_line: e.range.end_line } : null;
}

export function ScenarioScreen({ slug, name, tab }: { slug: string; name: string; tab: ScenarioTab }) {
  const key = `${slug}/${name}`;
  const [pick, setPick] = useState<string | undefined>(undefined);
  const project = useProjectView(slug);
  const envs = project.state === 'ready' ? project.data.environments : null;
  // Review A M1: a location remembered in this tab that project.yaml no longer has is never sent (it would blame the
  // file); it is dropped once the project is read and said once, above the take strip (run-location.ts).
  const loc = useRunLocation(slug, name, envs);
  const sentEnv = loc.sent;
  const droppedEnv = loc.dropped ?? null;
  const [view, reload] = useCall<View>('scenario_blocks', { project: slug, name, ...(pick ? { run: pick } : {}), ...(sentEnv ? { env: sentEnv } : {}) }, key);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    reload();
  }, [pick, sentEnv, reload]);
  const runningId = view.state === 'ready' ? (view.data.running?.id ?? null) : null;
  const [live, progress] = useRunProgress(slug, runningId, reload);
  useScenarioEvents(slug, name, { reread: reload, progress, jobs: () => progress([]) });
  // L5.11a: a run of this scenario this tab started or stopped (the status bar, ⌘R, ⌘.): read the view again now.
  useRunChanged(slug, name, reload);
  // L5.11a: the renders (lifted from the Renders card: the status bar's Render reads its queue) and what the status bar
  // acts on, fed from this screen's own reads (critique H2: the status bar reads nothing here).
  const renders = useRenders(slug, name, reload);
  const vNow = view.state === 'ready' ? view.data : null;
  const renderJob = renders.loaded.state === 'ready' ? renders.loaded.data.jobs[0] : undefined;
  const fedData = useMemo<FedActions | null>(() => {
    if (!vNow) return null;
    const cap = timelineRun(vNow);
    const capRun = cap ? vNow.runs.find((r) => r.id === cap) : undefined;
    return {
      hash: vNow.hash,
      ok: vNow.ok,
      environment: vNow.environment,
      run_blockers: vNow.run_blockers,
      runs: vNow.runs,
      running: vNow.running,
      ...(cap ? { capture: { id: cap, ...(capRun?.finished_at ? { finished_at: capRun.finished_at } : {}) } } : {}),
      ...(renderJob ? { render_job: { job: renderJob.id, state: renderJob.state, ...(renderJob.fraction !== undefined ? { fraction: renderJob.fraction } : {}) } } : {}),
      env: sentEnv,
      live,
    };
  }, [vNow, renderJob, sentEnv, live]);
  useFeedActions(slug, name, fedData);
  useShownFile(slug, name, vNow?.hash ?? null);
  const [focus, setFocus] = useState<{ line: number; end_line: number } | null>(null);
  // The selection (a step by its key, a scene, a card, the hooks, the video): kept while the YAML view is open and across re-reads.
  const [subject, setSubject] = useState<Subject | null>(null);
  const [palette, setPalette] = useState<{ at?: string } | null>(null);
  const onShowYaml = useCallback(
    (r: { line: number; end_line: number }) => {
      setFocus({ line: r.line, end_line: r.end_line });
      location.hash = hrefTo({ name: 'scenario', slug, scenario: name, tab: 'yaml' });
    },
    [slug, name],
  );
  // Critique B7: while the YAML view holds unsaved text, board edits are off (they would make its base stale).
  const yamlDraft = useDirty(scenarioKey(slug, name));
  // The board's step edits (L4.3 part 2): kept across view switches; a YAML save clears their history.
  const ed = useStepEditor(slug, name, view.state === 'ready' ? view.data : null, yamlDraft, reload, tab === 'blocks');
  const edRef = useRef(ed);
  edRef.current = ed;
  const fetchThumbs = useCallback((run: string, keys: string[], signal: AbortSignal) => call<ThumbAnswer>('run_thumbs', { project: slug, run, keys }, { signal }), [slug]);
  const forms = useStepForms();
  const v = view.state === 'ready' ? view.data : null;
  // The one resolved selection (review B M2): what the board marks and the inspector shows. A picked subject that went
  // away is replaced by its resolution in the state too — unless something else was picked meanwhile.
  const resolved = useMemo(() => (v ? resolveSelection(v, subject) : null), [v, subject]);
  const effective = resolved?.subject ?? null;
  useEffect(() => {
    if (subject === null || effective === null || sameSubject(subject, effective)) return;
    setSubject((cur) => (cur === subject ? effective : cur));
  }, [subject, effective]);
  // Review A L1: the inspector's button an edit came from keeps the focus once the edit's view is here (Storyboard).
  const editFrom = useRef<string | null>(null);

  // The step edits the keys, drag & drop and the inspector's buttons send (one place: the verified write path).
  const scenes = useMemo(() => (v ? v.blocks.entries.filter((e): e is SceneBlock => e.type === 'scene') : []), [v]);
  const slots: SceneSlots[] = useMemo(() => scenes.map((s) => ({ id: s.id, count: s.steps.length, locked: s.steps_locked !== undefined })), [scenes]);
  const refOf = useCallback(
    (k: string) => {
      for (const s of scenes) {
        const st = s.steps.find((x) => x.key === k);
        if (st) return st.guard !== undefined ? { scene: s.id, index: st.index, guard: st.guard, locked: st.locked !== undefined } : null;
      }
      return null;
    },
    [scenes],
  );
  const boardMoves: BoardMoves = useMemo(
    () => ({
      move: (k, dir) => {
        const at = refOf(k);
        if (!at || at.locked) return;
        const to = keyboardMove(slots, at, dir);
        if (to) edRef.current.send({ kind: 'move_step', from: { scene: at.scene, index: at.index, guard: at.guard }, to });
        // Review B L6: a key that moves nothing says so (the live region kept the last edit's words).
        else edRef.current.say(`Step ${at.index + 1} of ${at.scene} is already the ${dir < 0 ? 'first' : 'last'} step: it cannot move ${dir < 0 ? 'up' : 'down'}.`);
      },
      act: (k, kind) => {
        const at = refOf(k);
        if (at && !at.locked) edRef.current.send({ kind, at: { scene: at.scene, index: at.index, guard: at.guard } });
      },
    }),
    [refOf, slots],
  );

  // L5.12b: ⌘K's Scenes — each scene of the file (a pick selects it and brings it into view, as the browser does: on the
  // YAML view, the scene's lines — review B-L3) — and the Review report with the last render's words. A pick only selects:
  // the palette never writes. (The browser's own pick, onBrowse, is defined after the loading return: read from a ref.)
  const browse = useRef<((s: Subject, at: string) => void) | null>(null);
  usePaletteGroup(
    'scenes',
    v
      ? v.blocks.entries.flatMap((e) =>
          e.type === 'scene'
            ? [
                {
                  id: `scene-${e.index}`,
                  label: e.caption?.kicker ?? e.id,
                  hint: `scene ${e.id}`,
                  icon: 'scene' as const,
                  run: () => browse.current?.({ kind: 'scene', id: e.id }, `entry-${e.index}`),
                },
              ]
            : [],
        )
      : null,
  );
  useReportEntry(slug, name, renders);

  if (view.state === 'loading' || !v) {
    return (
      // No h1 until the view is here (tests and assistive tech wait on the scenario's heading as the sign it loaded).
      <div className="sc-screen sb-screen">
        {view.state === 'error' ? (
          <Callout state="fail" role="alert" title="This scenario cannot be opened">
            <p className="sb-pre">
              <Txt text={view.error} />
            </p>
            {pick && (
              <div>
                <Button onClick={() => setPick(undefined)}>Show the default run's pictures</Button>
              </div>
            )}
          </Callout>
        ) : (
          <p className="sc-quiet" role="status">
            Loading the scenario…
          </p>
        )}
      </div>
    );
  }

  const sel = resolved!.sel;
  const stepMoves: StepMoves =
    sel.kind === 'step'
      ? {
          up: keyboardMove(slots, { scene: sel.scene.id, index: sel.step.index }, -1) !== null,
          down: keyboardMove(slots, { scene: sel.scene.id, index: sel.step.index }, 1) !== null,
          move: (dir) => {
            editFrom.current = dir < 0 ? 'up' : 'down';
            boardMoves.move(sel.step.key, dir);
          },
          act: (kind) => {
            editFrom.current = kind === 'delete_step' ? 'delete' : 'duplicate';
            boardMoves.act(sel.step.key, kind);
          },
        }
      : { up: false, down: false, move: () => undefined, act: () => undefined };
  // The location (critique M1): the file's own, else the project's default; a choice is sent only when it differs. Only a
  // location project.yaml has is ever shown or sent (review A M1): the select and the strip say the same one.
  const p = project.state === 'ready' ? project.data : null;
  // A project without default_env runs on its first environment (core resolveEnvironment): that is the file's own then.
  const fileDefault = v.blocks.video.env ?? p?.default_env ?? p?.environments[0]?.name;
  const envList = envs ?? [];
  const known = (n: string | undefined): n is string => n !== undefined && (envList.length === 0 || envList.some((e) => e.name === n));
  const current = [sentEnv, v.environment?.name, fileDefault].find(known);
  const currentEnv = envList.find((e) => e.name === current);
  const chosen = sentEnv !== undefined && sentEnv !== fileDefault;
  const runLocation: RunLocation | null = current ? { name: current, flags: currentEnv ? envFlagWords(currentEnv, false, current) : '', chosen, ...(fileDefault ? { fileDefault } : {}) } : null;
  // The Video inspector's Location row: the file's own (review A L6), and the tab's choice beside it when it differs.
  const fileEnv = fileDefault ?? (sentEnv === undefined ? v.environment?.name : undefined);
  const fileEnvFlags = envList.find((e) => e.name === fileEnv);
  const videoLocation = { file: fileEnv, fileFlags: fileEnvFlags ? envFlagWords(fileEnvFlags, false, fileEnv) : '', ...(chosen && current ? { chosen: current } : {}) };
  const setEnv = (next: string) => chooseLocation(slug, name, next === fileDefault ? undefined : next);
  const onBrowse = (s: Subject, at: string) => {
    setSubject(s);
    if (tab === 'yaml') {
      const r = rangeOf(v, s);
      if (r) setFocus(r);
    } else document.getElementById(at)?.scrollIntoView({ block: 'start' });
  };
  browse.current = onBrowse;
  const issues = allIssues(v);
  const comments = <CommentsCount slug={slug} name={name} />;
  return (
    <div className="sc-screen sb-screen">
      <h1 className="k-sr">
        <Txt text={name} />
      </h1>
      <ShellSlot name="context">
        <div className="sb-context">
          <SegmentedLinks
            label="View"
            items={[
              { key: 'board', label: 'Board', to: { name: 'scenario', slug, scenario: name, tab: 'blocks' }, current: tab === 'blocks' },
              { key: 'yaml', label: 'YAML', to: { name: 'scenario', slug, scenario: name, tab: 'yaml' }, current: tab === 'yaml' },
            ]}
          />
          {envList.length > 0 && current && (
            <Select
              layout="inline"
              label="Location"
              testId="location-select"
              value={current}
              options={envList.map((e) => {
                // Review A L7: a flag word that repeats the name is left out ("production · read-only", not "production · production · …").
                const flags = envFlagWords(e, e.name === fileDefault, e.name);
                return { value: e.name, label: `${e.name}${flags ? ` · ${flags}` : ''}` };
              })}
              onChange={setEnv}
            />
          )}
        </div>
      </ShellSlot>
      <ShellSlot name="browser">
        <ScenesBrowser v={v} current={sel.kind === 'step' || sel.kind === 'scene' ? `scene:${sel.scene.id}` : sel.kind === 'entry' ? `entry:${sel.entry.index}` : sel.kind} onPick={onBrowse} />
      </ShellSlot>
      {/* Around both views: the pictures already loaded stay while the YAML view is open. */}
      {droppedEnv !== null && (
        <Callout state="warn" role="status" title="A location chosen earlier is gone" testId="location-dropped">
          <Txt text={`The location ${droppedEnv} chosen earlier is no longer in project.yaml: Rehearse and Capture use the file's own${fileDefault ? `, ${fileDefault}` : ''}.`} />
        </Callout>
      )}
      {/* Review B M1: a run of this scenario queued or running (progress, Watch live) shows on both views; Stop is the status bar's. */}
      <Running run={v.running} live={live} slug={slug} name={name} />
      <ThumbsProvider fetch={fetchThumbs}>
        {tab === 'blocks' ? (
          <>
            <ShellSlot name="inspector" inline="Inspector">
              <ScenarioInspector v={v} slug={slug} name={name} sel={sel} ed={ed} forms={forms} moves={stepMoves} onShowYaml={onShowYaml} comments={comments} location={videoLocation} />
            </ShellSlot>
            <TakeStrip v={v} slug={slug} name={name} pick={pick} onPick={setPick} location={runLocation} />
            {yamlDraft && (
              <Callout state="warn" role="note" title="Unsaved YAML changes">
                <p data-testid="yaml-draft-open">
                  {'The board shows the file on disk. Editing the board stays off until you save or discard your changes in the '}
                  <a href={hrefTo({ name: 'scenario', slug, scenario: name, tab: 'yaml' })}>YAML view</a>
                  {'.'}
                </p>
              </Callout>
            )}
            {!v.blocks.parsed && (
              <Callout state="fail" role="alert" title="This file is not valid YAML" testId="invalid-yaml">
                The YAML view shows the text and where it breaks.
              </Callout>
            )}
            {issues.length > 0 && (
              <Callout state={v.ok ? 'warn' : 'fail'} role="note" title={`${v.ok ? 'Warnings' : 'Errors'}: ${plural(v.limit?.issues_total ?? issues.length, 'issue')} in this file`}>
                <IssueLines issues={issues} testId="issues" />
              </Callout>
            )}
            {v.limit && v.limit.steps_shown < v.limit.steps_total && (
              <Callout state="idle" role="note" title={`Note: showing the first ${plural(v.limit.steps_shown, 'step')} of ${v.limit.steps_total.toLocaleString('en')}`}>
                <p data-testid="steps-limit">The YAML view shows the whole file.</p>
              </Callout>
            )}
            <EditBar
              ed={ed}
              add={
                ed.enabled && forms && !palette ? (
                  <Button size="sm" icon="plus" data-testid="palette-open" onClick={() => setPalette({})}>
                    Add a step…
                  </Button>
                ) : null
              }
            />
            {ed.enabled && forms && palette && (
              <Palette key={palette.at ?? ''} forms={forms} scenes={scenes} selected={sel.kind === 'step' ? { scene: sel.scene, step: sel.step } : null} ed={ed} onClose={() => setPalette(null)} {...(palette.at ? { at: palette.at } : {})} />
            )}
            <Storyboard v={v} subject={effective} onSelect={setSubject} editFrom={editFrom} ed={ed} moves={boardMoves} canAdd={ed.enabled && forms !== null} onAddStep={(at) => setPalette({ at })} />
            <Disclosure summary="Renders and review" testId="renders-section">
              <RendersCard v={v} slug={slug} name={name} r={renders} />
            </Disclosure>
            <p className="sc-quiet">
              <LinkButton size="sm" variant="ghost" to={{ name: 'record', slug }} testId="record-link">
                Record a new scenario
              </LinkButton>
            </p>
          </>
        ) : (
          <>
            <ShellSlot name="inspector" inline="File">
              <FileInspector v={v} slug={slug} name={name} issues={issues} />
            </ShellSlot>
            <YamlTab v={v} slug={slug} name={name} focus={focus} issues={issues} reload={reload} onSaved={ed.ownSave} />
          </>
        )}
      </ThumbsProvider>
    </div>
  );
}
