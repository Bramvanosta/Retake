/**
 * L5.10a: the Project screen (B32-Projet; `#/p/<slug>`, a smart group `#/p/<slug>/g/<group>`, a location
 * `#/p/<slug>/loc/<env>`) — the project's productions as a poster grid: ONE listbox (critique M6: the arrows move, Enter
 * opens, one tab stop), each poster its last pictured step (run_thumbs through Thumb.tsx, the app's one image source),
 * its title, its state as a shape AND a word (board-words.ts) and its length; a search and a sort; New scenario (the
 * Record screen). Nothing is selected at first: the inspector shows the project (facts, README, recent runs, Lately); a
 * selected production shows its facts (length, content, last take, render, review, location), Open and Render (L5.11a:
 * the status bar's Render on it — it is the scenario in context) and its Lately; a location shows its pages, display URLs, flags and personas.
 * Reads: the shared project entries (project-data.ts: one project_get, one project_board per open project); a take
 * running is followed by `run_status` (never the whole board at each step). Every value from data is text.
 * L5.10a fixes: a location route shows the location (it clears the selection; selecting a production afterwards shows
 * it: the newest wins — review B-M1); a production the search hides is no longer selected (review A-L1); with the
 * inspector hidden, what it holds is shown under the grid (ShellSlot inline).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { BoardScenario, ProjectBoardView, ProjectView, RunListItem, RunStatusWithJob } from '@demo-studio/engine';
import { call, useCall } from './api.js';
import { Lately } from './Activity.js';
import { Txt, When, plural, shown } from './bits.js';
import { APP_NAME } from './brand.js';
import { GROUP_LABEL, SORT_LABEL, contentWords, envFlagWords, filterSort, lastTakeWords, lengthWords, posterTitle, productionState, reviewState } from './board-words.js';
import type { BoardSort } from './board-words.js';
import { useEvents, useProjectEvents } from './events.js';
import { useBoard, useProjectView } from './project-data.js';
import { hrefTo } from './route.js';
import type { ProductionGroup, Route } from './route.js';
import { runShellCommand } from './shell/command-bus.js';
import { rememberScenario } from './shell/modes.js';
import { ShellSlot } from './shell/slots.js';
import { NoThumb, Thumb, ThumbsProvider } from './Thumb.js';
import type { ThumbAnswer } from './thumbs.js';
import { Button, Disclosure, EmptyState, Facts, InspectorSection, LinkButton, PosterGrid, Progress, Select, StatusMark, TextField, Toolbar } from './ui-kit/index.js';

const README_PREVIEW_LINES = 40;
const SORTS: BoardSort[] = ['activity', 'name', 'length'];

/** Progress of the takes the board shows running: `run_status` on their progress events and job changes (critique M2). */
function useRunning(slug: string, board: ProjectBoardView | null): Map<string, Pick<RunStatusWithJob, 'status' | 'steps_done' | 'steps_total'>> {
  const [live, setLive] = useState(new Map<string, Pick<RunStatusWithJob, 'status' | 'steps_done' | 'steps_total'>>());
  const running = useMemo(() => new Map((board?.scenarios ?? []).filter((s) => s.running).map((s) => [s.running!.id, s.running!.job])), [board]);
  const asked = useRef(new Map<string, number>());
  const ask = (run: string) => {
    const now = Date.now();
    if (now - (asked.current.get(run) ?? 0) < 400) return;
    asked.current.set(run, now);
    call<RunStatusWithJob>('run_status', { project: slug, run_id: run }).then(
      (r) => setLive((m) => new Map(m).set(run, { status: r.status, steps_done: r.steps_done, steps_total: r.steps_total })),
      () => undefined,
    );
  };
  useEvents((e) => {
    if (e.type === 'workspace') for (const r of e.runs ?? []) if (r.project === slug && r.change === 'progress' && running.has(r.run)) ask(r.run);
    if (e.type === 'jobs') for (const [run, job] of running) if (job && e.changed.includes(job)) ask(run);
  });
  // A board read replaces what run_status said.
  useEffect(() => setLive(new Map()), [board]);
  return live;
}

function Poster({ s, size }: { s: BoardScenario; size: 'poster' | 'inspector' }) {
  if (!s.poster) return <NoThumb size={size}>{s.last_run || s.running ? 'No picture yet' : 'Not shot yet'}</NoThumb>;
  return <Thumb run={s.poster.run} runKey={s.poster.key} size={size} alt={`The last pictured step of ${s.name}`} />;
}

function RunMark({ r }: { r: RunListItem }) {
  const w = lastTakeWords({ id: r.id, mode: r.mode === 'dry' ? 'dry' : 'capture', status: r.status, started_at: r.started_at, steps_done: r.steps_done, steps_total: r.steps_total });
  return <StatusMark state={w.state} word={w.words} />;
}

function RecentRuns({ slug }: { slug: string }) {
  const [runs, reload] = useCall<{ runs: RunListItem[] }>('run_list', { project: slug, limit: 5 }, slug);
  useProjectEvents(slug, reload);
  if (runs.state === 'loading') return <p className="sc-quiet">Loading the runs…</p>;
  if (runs.state === 'error') return <Txt className="sc-quiet" text={runs.error} />;
  if (runs.data.runs.length === 0) return <p className="sc-quiet">No run yet.</p>;
  return (
    <ul className="pr-runs">
      {runs.data.runs.map((r) =>
        r.newer ? (
          <li key={r.id} className="sc-quiet">
            <Txt className="k-mono" text={r.id} />
            {shown(`: written by a newer ${APP_NAME}`)}
          </li>
        ) : (
          <li key={r.id} className="pr-run">
            <RunMark r={r} />
            <span className="sc-quiet">
              <Txt text={r.scenario} /> · <Txt text={r.env} /> · {shown(`${r.steps_done}/${r.steps_total} steps`)} · <When iso={r.started_at} /> · <Txt className="k-mono" text={r.id} />
            </span>
          </li>
        ),
      )}
    </ul>
  );
}

/** The inspector with nothing selected: the project. */
function ProjectInspector({ p }: { p: ProjectView }) {
  const lines = p.readme?.split('\n') ?? [];
  return (
    <>
      <InspectorSection title="Project">
        <Facts
          rows={[
            { key: 'name', label: 'Name', value: <Txt text={p.name} /> },
            { key: 'slug', label: 'Slug', value: <Txt className="k-mono" text={p.slug} /> },
            { key: 'folder', label: 'Folder', value: <Txt className="k-mono pr-path" text={p.dir} title={p.dir} /> },
            { key: 'scenarios', label: 'Productions', value: plural(p.scenarios.length, 'scenario') },
            { key: 'env', label: 'Location', value: p.default_env ? <Txt text={p.default_env} /> : 'none' },
          ]}
        />
      </InspectorSection>
      <InspectorSection title="README">
        {p.readme_error && (
          <div className="pr-alert" role="note">
            <StatusMark state="warn" word="Locked: README.md cannot be edited here" />
            <p className="pr-alert-text">
              <Txt text={p.readme_error} />
            </p>
          </div>
        )}
        {p.readme === null ? (
          !p.readme_error && <p className="sc-quiet">No README.md yet. It tells Claude the product, the audience, the goals and the tone.</p>
        ) : (
          <>
            {/* A scroller with a tab stop of its own (review A-L6: older engines do not focus scrollers). */}
            <pre className="pr-readme k-mono" data-testid="readme-preview" tabIndex={0} role="region" aria-label="README.md, the first lines">
              {shown(lines.slice(0, README_PREVIEW_LINES).join('\n'))}
            </pre>
            {lines.length > README_PREVIEW_LINES && <p className="sc-quiet">{shown(`${plural(lines.length - README_PREVIEW_LINES, 'more line')} in the editor.`)}</p>}
          </>
        )}
        <div>
          <LinkButton to={{ name: 'readme', slug: p.slug }} size="sm">
            {p.readme_error ? 'Open the README' : p.readme === null ? 'Write the README' : 'Edit the README'}
          </LinkButton>
        </div>
      </InspectorSection>
      <InspectorSection title="Recent runs">
        <RecentRuns slug={p.slug} />
      </InspectorSection>
      <InspectorSection title="Lately">
        <Lately project={p.slug} limit={6} label="Recent activity of the project" />
      </InspectorSection>
    </>
  );
}

/** The inspector of a selected production. */
function ProductionInspector({ s, p, live }: { s: BoardScenario; p: ProjectView; live: ReturnType<typeof useRunning> }) {
  const st = productionState(s);
  const env = p.environments.find((e) => e.name === s.env);
  const last = s.last_run ? lastTakeWords(s.last_run) : null;
  const running = s.running ? { ...s.running, ...(live.get(s.running.id) ?? {}) } : null;
  const review = s.render ? reviewState(s.render.review) : null;
  return (
    <>
      <InspectorSection title="Production">
        <div className="pr-poster-large">
          <Poster s={s} size="inspector" />
        </div>
        <div className="pr-title">
          <h3 className="sc-h3">
            <Txt text={posterTitle(s)} />
          </h3>
          <Txt className="k-mono sc-quiet" text={`${s.name}.yaml`} />
        </div>
        <StatusMark state={st.state} word={st.word} />
        {running && (
          <>
            <Progress label={running.mode === 'dry' ? 'Rehearsal' : 'Capture'} value={running.steps_done} max={Math.max(1, running.steps_total)} valueText={`${running.steps_done} of ${running.steps_total} steps`} />
            <div>
              <LinkButton to={{ name: 'run', slug: p.slug, scenario: s.name, run: running.id }} size="sm">
                Watch live
              </LinkButton>
            </div>
          </>
        )}
        <Facts
          rows={[
            { key: 'length', label: 'Length', value: s.length ? <span className="k-mono">{shown(lengthWords(s.length.seconds))}</span> : 'not shot yet' },
            { key: 'content', label: 'Content', value: contentWords(s.content) },
            ...(s.file.errors + s.file.warnings > 0 || !s.file.parsed ? [{ key: 'file', label: 'File', value: s.file.parsed ? `${plural(s.file.errors, 'error')}, ${plural(s.file.warnings, 'warning')}` : 'not valid YAML' }] : []),
            { key: 'take', label: 'Last take', value: last && s.last_run ? <span><StatusMark state={last.state} word={last.words} />{' · '}<When iso={s.last_run.finished_at ?? s.last_run.started_at} /></span> : 'none yet' },
            { key: 'capture', label: 'Capture', value: s.capture ? <span>{shown(s.capture.current === true ? 'current' : s.capture.current === false ? 'the file changed since' : 'cannot tell')}{' · '}<When iso={s.capture.finished_at} /></span> : 'none yet' },
            { key: 'render', label: 'Render', value: s.render ? <span><When iso={s.render.created_at} />{' · '}<Txt text={s.render.theme} /></span> : s.render_failed ? 'the last one failed' : 'none yet' },
            { key: 'review', label: 'Review', value: review ? <StatusMark state={review.state} word={review.words} /> : 'none yet' },
            {
              key: 'location',
              label: 'Location',
              value: s.env ? (
                <span>
                  <Txt text={s.env} />
                  {env && envFlagWords(env, false) ? <span className="sc-quiet">{shown(` · ${envFlagWords(env, false)}`)}</span> : null}
                </span>
              ) : s.untrusted.env !== undefined ? (
                // The file names an environment the project does not have (review A-M2: as written, capped, said so).
                <span>
                  <Txt text={s.untrusted.env} />
                  <span className="sc-quiet">{' · not a location of this project'}</span>
                </span>
              ) : (
                'none'
              ),
            },
          ]}
        />
        <div className="pr-actions">
          <LinkButton to={{ name: 'scenario', slug: p.slug, scenario: s.name, tab: 'blocks' }} variant="primary" testId="scenario-link">
            Open
          </LinkButton>
          {s.capture ? (
            // L5.11a (BL-128): Render acts — the status bar's own action on this production (the scenario in context).
            <Button data-testid="production-render" onClick={() => runShellCommand('render')}>
              Render
            </Button>
          ) : (
            <Button disabled why="No capture yet: a capture films the take a render edits.">
              Render
            </Button>
          )}
        </div>
      </InspectorSection>
      <InspectorSection title="Lately">
        <Lately project={p.slug} scenario={s.name} limit={5} label={`Recent activity of ${s.name}`} />
      </InspectorSection>
    </>
  );
}

/** The inspector of a location (an environment): its pages, display URLs, flags and personas. URLs are text. */
function LocationInspector({ p, env }: { p: ProjectView; env: string }) {
  const e = p.environments.find((x) => x.name === env);
  if (!e) {
    return (
      <InspectorSection title="Location">
        <p className="sc-quiet">
          {'No location named '}
          <Txt text={env} />
          {' in this project.'}
        </p>
      </InspectorSection>
    );
  }
  const flags = envFlagWords(e, e.name === p.default_env);
  return (
    <>
      <InspectorSection title="Location">
        <div className="pr-title">
          <h3 className="sc-h3">
            <Txt text={e.name} />
          </h3>
          <span className="sc-quiet">{shown(flags || 'read-write')}</span>
        </div>
      </InspectorSection>
      <InspectorSection title="Pages">
        <div className="pr-pages" data-testid="location-pages">
          {Object.entries(e.pages).map(([key, url]) => (
            <Facts
              key={key}
              label={`Page ${key}`}
              rows={[
                { key: 'page', label: 'Page', value: <Txt text={key} /> },
                { key: 'url', label: 'URL', value: <Txt className="k-mono" text={url} /> },
                { key: 'shown', label: 'Shown as', value: e.display?.[key] ? <Txt className="k-mono" text={e.display[key]} /> : '—' },
              ]}
            />
          ))}
        </div>
      </InspectorSection>
      <InspectorSection title="Personas">
        {e.personas.length === 0 ? (
          <p className="sc-quiet">No persona.</p>
        ) : (
          <ul className="pr-personas">
            {e.personas.map((x) => (
              <li key={x.name}>
                <LinkButton to={{ name: 'cast', slug: p.slug }} variant="ghost" size="sm">
                  <Txt text={x.name} />
                </LinkButton>
              </li>
            ))}
          </ul>
        )}
      </InspectorSection>
    </>
  );
}

export function ProductionsScreen({ slug, group, env }: { slug: string; group?: ProductionGroup; env?: string }) {
  const view = useProjectView(slug);
  const boardState = useBoard(slug);
  const board = boardState.state === 'ready' ? boardState.data : null;
  const live = useRunning(slug, board);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<BoardSort>('activity');
  const [selected, setSelected] = useState<string | null>(null);
  const fetchThumbs = useMemo(() => (run: string, keys: string[], signal: AbortSignal) => call<ThumbAnswer>('run_thumbs', { project: slug, run, keys }, { signal }), [slug]);
  const all = board?.scenarios ?? [];
  const inGroup = group ? all.filter((s) => productionState(s).group === group) : all;
  const shownList = filterSort(inGroup, query, sort);
  const current = selected !== null ? (shownList.find((s) => s.name === selected) ?? null) : null;
  // A production that left the grid (renamed, deleted, out of the group, hidden by the search) is no longer selected.
  const gone = selected !== null && board !== null && current === null;
  useEffect(() => {
    if (gone) setSelected(null);
  }, [gone]);
  // A location route shows its location: it clears the selection (review B-M1); a production selected afterwards wins.
  useEffect(() => {
    if (env !== undefined) setSelected(null);
  }, [env]);
  const select = (name: string | null) => {
    setSelected(name);
    if (name !== null) rememberScenario(slug, name);
  };
  const open = (name: string) => {
    location.hash = hrefTo(productionRoute(slug, name));
  };

  if (view.state === 'loading') return <div className="sc-screen"><p className="sc-quiet" role="status">Loading the project…</p></div>;
  if (view.state === 'error') {
    return (
      <div className="sc-screen">
        <h1 className="sc-h1">Productions</h1>
        <div role="alert" className="pr-alert">
          <StatusMark state="fail" word="This project cannot be opened" />
          <p className="pr-alert-text">
            <Txt text={view.error} />
          </p>
        </div>
      </div>
    );
  }
  const p = view.data;
  const title = group ? GROUP_LABEL[group] : 'Productions';
  return (
    <ThumbsProvider fetch={fetchThumbs}>
      <div className="sc-screen pr">
        <header className="pr-head">
          <h1 className="sc-h1">{shown(title)}</h1>
          <span className="pr-count k-mono" aria-label={plural(shownList.length, 'production')}>
            {shown(shownList.length)}
          </span>
          <div className="pr-tools">
            <Toolbar label="Productions">
              <TextField label="Search productions" type="search" value={query} onChange={setQuery} unsaved={null} placeholder="Search" layout="inline" labelHidden maxLength={200} autoComplete="off" spellCheck={false} />
              <Select label="Sort" value={sort} options={SORTS.map((s) => ({ value: s, label: SORT_LABEL[s] }))} onChange={(v) => setSort(v as BoardSort)} layout="inline" />
              <LinkButton to={{ name: 'record', slug }} variant="primary" icon="plus" testId="record-link">
                New scenario
              </LinkButton>
            </Toolbar>
          </div>
        </header>
        {p.warnings.length > 0 && (
          <div className="pr-warnings">
            <StatusMark state="warn" word={`project.yaml: ${plural(p.warnings.length, 'warning')}`} />
            <Disclosure summary={p.warnings.length === 1 ? 'Show the warning' : `Show the ${plural(p.warnings.length, 'warning')}`}>
              <ul className="pr-warning-list">
                {p.warnings.map((w, i) => (
                  <li key={i}>
                    <Txt text={w.message} />
                  </li>
                ))}
              </ul>
            </Disclosure>
          </div>
        )}
        {board?.truncated && <p className="sc-quiet">{shown(`The first ${board.truncated.shown} of ${board.truncated.total} scenarios are shown.`)}</p>}
        {boardState.state === 'loading' && <p className="sc-quiet" role="status">Loading the productions…</p>}
        {boardState.state === 'error' && (
          <p role="alert">
            {'The productions could not be read: '}
            <Txt text={boardState.error} />
          </p>
        )}
        {board && all.length === 0 && (
          <EmptyState title="No scenario yet" actions={<LinkButton to={{ name: 'record', slug }} variant="primary">Record a scenario</LinkButton>}>
            Record one in the browser, or ask Claude to write it.
          </EmptyState>
        )}
        {board && all.length > 0 && shownList.length === 0 && <p className="sc-quiet" data-testid="productions-empty">{query ? 'No production matches the search.' : 'No production in this group.'}</p>}
        {shownList.length > 0 && (
          <PosterGrid
            label={title}
            selected={current ? current.name : null}
            onSelect={select}
            onOpen={open}
            describedBy="pr-keys"
            items={shownList.map((s) => {
              const st = productionState(s);
              const run = s.running ? { ...s.running, ...(live.get(s.running.id) ?? {}) } : null;
              const word = run && st.state === 'running' && s.running ? productionState({ ...s, running: { ...s.running, ...run } }).word : st.word;
              return {
                id: s.name,
                picture: <Poster s={s} size="poster" />,
                title: <Txt text={posterTitle(s)} />,
                meta: (
                  <>
                    <StatusMark state={st.state} word={word} />
                    {s.length && <span className="k-mono pr-length">{shown(lengthWords(s.length.seconds))}</span>}
                  </>
                ),
              };
            })}
          />
        )}
        <p id="pr-keys" className="k-sr">
          Arrow keys move between productions, Enter opens the selected one, Escape clears the selection.
        </p>
        <ShellSlot name="inspector" inline={current ? 'Production details' : env !== undefined ? 'Location details' : 'Project details'}>
          {current ? <ProductionInspector s={current} p={p} live={live} /> : env !== undefined ? <LocationInspector p={p} env={env} /> : <ProjectInspector p={p} />}
        </ShellSlot>
      </div>
    </ThumbsProvider>
  );
}

/** Where a production's Open goes (for tests and the palette). */
export const productionRoute = (slug: string, name: string): Route => ({ name: 'scenario', slug, scenario: name, tab: 'blocks' });
