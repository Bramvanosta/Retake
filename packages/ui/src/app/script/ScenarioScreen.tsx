/**
 * A scenario (R-UI-08..10, R-UI-13, R-UI-14; « Épure » — B32-Scenario, R4-Source) — one
 * `scenario_blocks` read gives the file, its blocks (video header, setup / teardown hooks, scenes with their steps,
 * cards, interstitials), its issues, what would stop a run from the Studio (`run_blockers`), the scenario's runs (the
 * "Pictures from" picker), the source run and every step's binding to it.
 *
 * The screen in the shell: the scenario's name is the page's (visually hidden) h1 — the title bar names it; the title
 * bar's context holds the View (Board · YAML) and the Location (the environment Rehearse and Capture use, remembered
 * per scenario in this tab only, sent as `env` only when it is not the file's own; one choice shared with Prepare and
 * the status bar — run-location.ts); the browser shows the scenario's entries (ScenesBrowser.tsx); the inspector what
 * is selected (ScenarioInspector.tsx — the File in the YAML view). Above both views: a run of this scenario queued or
 * running (TakeStrip.tsx `Running`) and, once, a remembered location project.yaml no longer has (dropped). Rehearse,
 * Capture and Render are the status bar's; this screen feeds it what it read (its view, its run_status, its renders: no
 * second read) and the hash it shows. One resolved selection drives the board, the browser and the inspector
 * (`resolveSelection`). The centre: the take strip (TakeStrip.tsx), the file's notices (not valid YAML, its issues, the
 * steps limit, a YAML draft open), the edit bar (StepEditing.tsx), the palette, the storyboard (Storyboard.tsx) and,
 * closed at its end, the renders (Renders.tsx; their reviews are the Review report's).
 *
 * Events: the view is read again only for this scenario's own file, a run of this scenario that appears,
 * changes status or goes away, the picker, a reconnection or the window's focus — a running run's progress is a
 * `run_status` read, never the whole view. Every string from the file or the filmed site is a text node (`Txt` / a kit
 * slot); page text stays in boxes titled "From the page".
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { SceneBlock, StepForms } from '@retake/core/scenario';
import { runThumbs, scenarioForms, useScenarioBlocks } from '../data/scenarios.js';
import { Txt, plural } from '../bits.js';
import { envFlagWords } from '../words/board-words.js';
import { useScenarioEvents } from '../events.js';
import { useProjectView } from '../project-data.js';
import { RenderJobs, RenderOutcome, RendersList, useRenders, useReportEntry } from '../review/Renders.js';
import type { RendersState } from '../review/Renders.js';
import { chooseLocation, useRunLocation } from '../shoot/run-location.js';
import { useRunChanged, useRunProgress } from '../shoot/shoot-data.js';
import { hrefTo } from '../route.js';
import type { ScenarioTab } from '../route.js';
import { ShellSlot } from '../shell/slots.js';
import { ThumbsProvider } from '../Thumb.js';
import { FileInspector, YamlTab } from './YamlTab.js';
import { scenarioKey, useDirty } from '../drafts.js';
import { EditBar, IssueLines, useStepEditor } from './StepEditing.js';
import { Palette } from './StepForm.js';
import { ScenarioInspector } from './ScenarioInspector.js';
import type { Selected } from './ScenarioInspector.js';
import { ScenesBrowser } from './ScenesBrowser.js';
import { usePaletteGroup } from '../shell/command-bus.js';
import { Storyboard } from './Storyboard.js';
import type { Subject } from './Storyboard.js';
import { CommentsCount, Running, TakeStrip } from '../shoot/TakeStrip.js';
import { timelineRun } from '../words/scenario-words.js';
import type { View } from '../words/scenario-words.js';
import { Button, Callout, Disclosure, LinkButton, Select, SegmentedLinks } from '../ui-kit/index.js';
import { locationOf, rangeOf, stepMovesOf, useBoardMoves, useFeed, useResolvedSelection } from './scenario-state.js';
import type { ProjectData } from './scenario-state.js';

export { resolveSelection } from './scenario-state.js';

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
 * Renders (the card on the kit, R-UI-46) — the queue (Cancel), the newest failure, the newest three
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
    formsOnce ??= scenarioForms({});
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
  const { pick, setPick, project, envs, sentEnv, droppedEnv, view, reload, live } = useScenarioView(slug, name);
  // The renders (lifted from the Renders card: the status bar's Render reads its queue) and what the status bar
  // acts on, fed from this screen's own reads (the status bar reads nothing here).
  const renders = useRenders(slug, name, reload);
  useFeed({ slug, name, vNow: view.state === 'ready' ? view.data : null, renders, sentEnv, live });
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
  // While the YAML view holds unsaved text, board edits are off (they would make its base stale).
  const yamlDraft = useDirty(scenarioKey(slug, name));
  // The board's step edits: kept across view switches; a YAML save clears their history.
  const ed = useStepEditor({ slug, name, v: view.state === 'ready' ? view.data : null, yamlDraft, reload, active: tab === 'blocks' });
  const edRef = useRef(ed);
  edRef.current = ed;
  const fetchThumbs = useCallback((run: string, keys: string[], signal: AbortSignal) => runThumbs({ project: slug, run, keys }, { signal }), [slug]);
  const forms = useStepForms();
  const v = view.state === 'ready' ? view.data : null;
  const { resolved, effective } = useResolvedSelection(v, subject, setSubject);
  // The inspector's button an edit came from keeps the focus once the edit's view is here (Storyboard).
  const editFrom = useRef<string | null>(null);
  const { scenes, slots, boardMoves } = useBoardMoves(v, edRef);

  const browse = useScenesPalette(v);
  // ⌘K's Review report with the last render's words.
  useReportEntry(slug, name, renders);

  if (view.state === 'loading' || !v) return <ScenarioLoading error={view.state === 'error' ? view.error : null} pick={pick} onDefaultRun={() => setPick(undefined)} />;

  const sel = resolved!.sel;
  const stepMoves = stepMovesOf(sel, slots, boardMoves, editFrom);
  const where = locationOf(v, project.state === 'ready' ? project.data : null, envs, sentEnv);
  const setEnv = (next: string) => chooseLocation(slug, name, next === where.fileDefault ? undefined : next);
  const onBrowse = (s: Subject, at: string) => {
    setSubject(s);
    if (tab === 'yaml') {
      const r = rangeOf(v, s);
      if (r) setFocus(r);
    } else document.getElementById(at)?.scrollIntoView({ block: 'start', behavior: 'auto' });
  };
  browse.current = onBrowse;
  const issues = allIssues(v);
  const comments = <CommentsCount slug={slug} name={name} />;
  return (
    <div className="sc-screen sb-screen">
      <h1 className="k-sr">
        <Txt text={name} />
      </h1>
      <ScenarioContext slug={slug} name={name} tab={tab} envList={where.envList} current={where.current} fileDefault={where.fileDefault} onEnv={setEnv} />
      <ShellSlot name="browser">
        <ScenesBrowser v={v} current={sel.kind === 'step' || sel.kind === 'scene' ? `scene:${sel.scene.id}` : sel.kind === 'entry' ? `entry:${sel.entry.index}` : sel.kind} onPick={onBrowse} />
      </ShellSlot>
      {/* Around both views: the pictures already loaded stay while the YAML view is open. */}
      {droppedEnv !== null && (
        <Callout state="warn" role="status" title="A location chosen earlier is gone" testId="location-dropped">
          <Txt text={`The location ${droppedEnv} chosen earlier is no longer in project.yaml: Rehearse and Capture use the file's own${where.fileDefault ? `, ${where.fileDefault}` : ''}.`} />
        </Callout>
      )}
      {/* A run of this scenario queued or running (progress, Watch live) shows on both views; Stop is the status bar's. */}
      <Running run={v.running} live={live} slug={slug} name={name} />
      <ThumbsProvider fetch={fetchThumbs}>
        {tab === 'blocks' ? (
          <>
            <ShellSlot name="inspector" inline="Inspector">
              <ScenarioInspector v={v} slug={slug} name={name} sel={sel} ed={ed} forms={forms} moves={stepMoves} onShowYaml={onShowYaml} comments={comments} location={where.videoLocation} />
            </ShellSlot>
            <TakeStrip v={v} slug={slug} name={name} pick={pick} onPick={setPick} location={where.runLocation} />
            <FileNotices v={v} slug={slug} name={name} yamlDraft={yamlDraft} issues={issues} />
            <StepAdding ed={ed} forms={forms} palette={palette} onPalette={setPalette} scenes={scenes} sel={sel} />
            <Storyboard v={v} subject={effective} onSelect={setSubject} editFrom={editFrom} ed={ed} moves={boardMoves} canAdd={ed.enabled && forms !== null} onAddStep={(at) => setPalette({ at })} />
            <BoardFooter v={v} slug={slug} name={name} renders={renders} />
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

/** ⌘K's Scenes; returns the ref the browser's own pick is read from. */
function useScenesPalette(v: View | null) {
  // ⌘K's Scenes — each scene of the file (a pick selects it and brings it into view, as the browser does: on the
  // YAML view, the scene's lines). A pick only selects: the palette never writes. (The browser's own pick, onBrowse,
  // is defined after the loading return: read from a ref.)
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
  return browse;
}

/** The edit bar with Add a step…, and the palette once it is open. */
function StepAdding({
  ed,
  forms,
  palette,
  onPalette,
  scenes,
  sel,
}: {
  ed: ReturnType<typeof useStepEditor>;
  forms: StepForms | null;
  palette: { at?: string } | null;
  onPalette: (p: { at?: string } | null) => void;
  scenes: SceneBlock[];
  sel: Selected;
}) {
  return (
    <>
      <EditBar
        ed={ed}
        add={
          ed.enabled && forms && !palette ? (
            <Button size="sm" icon="plus" data-testid="palette-open" onClick={() => onPalette({})}>
              Add a step…
            </Button>
          ) : null
        }
      />
      {ed.enabled && forms && palette && (
        <Palette
          key={palette.at ?? ''}
          forms={forms}
          scenes={scenes}
          selected={sel.kind === 'step' ? { scene: sel.scene, step: sel.step } : null}
          ed={ed}
          onClose={() => onPalette(null)}
          {...(palette.at ? { at: palette.at } : {})}
        />
      )}
    </>
  );
}

/** The renders, closed at the board's end, and the link to record a new scenario. */
function BoardFooter({ v, slug, name, renders }: { v: View; slug: string; name: string; renders: RendersState }) {
  return (
    <>
      <Disclosure summary="Renders and review" testId="renders-section">
        <RendersCard v={v} slug={slug} name={name} r={renders} />
      </Disclosure>
      <p className="sc-quiet">
        <LinkButton size="sm" variant="ghost" to={{ name: 'record', slug }} testId="record-link">
          Record a new scenario
        </LinkButton>
      </p>
    </>
  );
}

/** The scenario's view (the run picked, the location sent), read again on its events, and the running run's progress. */
function useScenarioView(slug: string, name: string) {
  const key = `${slug}/${name}`;
  const [pick, setPick] = useState<string | undefined>(undefined);
  const project = useProjectView(slug);
  const envs = project.state === 'ready' ? project.data.environments : null;
  // A location remembered in this tab that project.yaml no longer has is never sent (it would blame the
  // file); it is dropped once the project is read and said once, above the take strip (run-location.ts).
  const loc = useRunLocation(slug, name, envs);
  const sentEnv = loc.sent;
  const droppedEnv = loc.dropped ?? null;
  const [view, reload] = useScenarioBlocks({ project: slug, name, ...(pick ? { run: pick } : {}), ...(sentEnv ? { env: sentEnv } : {}) }, key);
  const first = useRef(true);
  // biome-ignore lint/correctness/useExhaustiveDependencies: another run picked or another location sent is the trigger to read the view again
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
  // A run of this scenario this tab started or stopped (the status bar, ⌘R, ⌘.): read the view again now.
  useRunChanged(slug, name, reload);
  return { pick, setPick, project, envs, sentEnv, droppedEnv, view, reload, live };
}

/** The screen before its view is here: loading, or why the scenario cannot be opened. */
function ScenarioLoading({ error, pick, onDefaultRun }: { error: string | null; pick: string | undefined; onDefaultRun: () => void }) {
  return (
    // No h1 until the view is here (tests and assistive tech wait on the scenario's heading as the sign it loaded).
    <div className="sc-screen sb-screen">
      {error !== null ? (
        <Callout state="fail" role="alert" title="This scenario cannot be opened">
          <p className="sb-pre">
            <Txt text={error} />
          </p>
          {pick && (
            <div>
              <Button onClick={onDefaultRun}>Show the default run's pictures</Button>
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

/** The title bar's context: the View (Board · YAML) and the Location. */
function ScenarioContext({
  slug,
  name,
  tab,
  envList,
  current,
  fileDefault,
  onEnv,
}: {
  slug: string;
  name: string;
  tab: ScenarioTab;
  envList: ProjectData['environments'];
  current: string | undefined;
  fileDefault: string | undefined;
  onEnv: (next: string) => void;
}) {
  return (
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
              // A flag word that repeats the name is left out ("production · read-only", not "production · production
              // · …").
              const flags = envFlagWords(e, e.name === fileDefault, e.name);
              return { value: e.name, label: `${e.name}${flags ? ` · ${flags}` : ''}` };
            })}
            onChange={onEnv}
          />
        )}
      </div>
    </ShellSlot>
  );
}

/** The file's notices on the board: a YAML draft open, not valid YAML, its issues, the steps limit. */
function FileNotices({ v, slug, name, yamlDraft, issues }: { v: View; slug: string; name: string; yamlDraft: boolean; issues: ReturnType<typeof allIssues> }) {
  return (
    <>
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
    </>
  );
}
