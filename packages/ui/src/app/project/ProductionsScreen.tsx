/**
 * The Project screen (B32-Projet; `#/p/<slug>`, a smart group `#/p/<slug>/g/<group>`) — the project's productions as a poster grid: ONE listbox (the arrows move, Enter opens, one
 * tab stop), each poster its last pictured step (run_thumbs through Thumb.tsx, the app's one image source),
 * its title, its state as a shape AND a word (board-words.ts) and its length; a search and a sort; New scenario (the
 * Record screen). Nothing is selected at first: the inspector shows the project (facts, README, recent runs, Lately); a
 * selected production shows its facts (length, content, last take, render, review, location), Open and Render (the
 * status bar's Render on it — it is the scenario in context) and its Lately (a location has a page of its own:
 * LocationScreen.tsx).
 * Reads: the shared project entries (project-data.ts: one project_get, one project_board per open project); a take
 * running is followed by `run_status` (never the whole board at each step). Every value from data is text.
 * A production the search hides is no longer selected; with the
 * inspector hidden, what it holds is shown under the grid (ShellSlot inline).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { BoardScenario, ProjectBoardView, ProjectView, RunStatusWithJob } from '@retake/engine';
import { runThumbs } from '../data/scenarios.js';
import { runStatus } from '../data/shoot.js';
import { Txt, plural, shown } from '../bits.js';
import { GROUP_LABEL, SORT_LABEL, filterSort, lengthWords, posterTitle, productionState } from '../words/board-words.js';
import type { BoardSort } from '../words/board-words.js';
import { useEvents } from '../events.js';
import { useBoard, useProjectView } from '../project-data.js';
import { hrefTo } from '../route.js';
import type { ProductionGroup, Route } from '../route.js';
import { requestContextMenu } from '../shell/context-menu.js';
import { rememberScenario } from '../shell/modes.js';
import { ShellSlot } from '../shell/slots.js';
import { ThumbsProvider } from '../Thumb.js';
import { Disclosure, EmptyState, LinkButton, PosterGrid, Select, StatusMark, TextField, Toolbar } from '../ui-kit/index.js';
import { Poster, ProductionInspector, ProjectInspector } from './production-inspectors.js';

export { RunRows } from './production-inspectors.js';

const SORTS: BoardSort[] = ['activity', 'name', 'length'];

/** Progress of the takes the board shows running: `run_status` on their progress events and job changes. */
function useRunning(slug: string, board: ProjectBoardView | null): Map<string, Pick<RunStatusWithJob, 'status' | 'steps_done' | 'steps_total'>> {
  const [live, setLive] = useState(new Map<string, Pick<RunStatusWithJob, 'status' | 'steps_done' | 'steps_total'>>());
  const running = useMemo(() => new Map((board?.scenarios ?? []).filter((s) => s.running).map((s) => [s.running!.id, s.running!.job])), [board]);
  const asked = useRef(new Map<string, number>());
  const ask = (run: string) => {
    const now = Date.now();
    if (now - (asked.current.get(run) ?? 0) < 400) return;
    asked.current.set(run, now);
    runStatus({ project: slug, run_id: run }).then(
      (r) => setLive((m) => new Map(m).set(run, { status: r.status, steps_done: r.steps_done, steps_total: r.steps_total })),
      () => undefined,
    );
  };
  useEvents((e) => {
    if (e.type === 'workspace') for (const r of e.runs ?? []) if (r.project === slug && r.change === 'progress' && running.has(r.run)) ask(r.run);
    if (e.type === 'jobs') for (const [run, job] of running) if (job && e.changed.includes(job)) ask(run);
  });
  // A board read replaces what run_status said.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new board read is the trigger to drop what run_status said
  useEffect(() => setLive(new Map()), [board]);
  return live;
}

export function ProductionsScreen({ slug, group }: { slug: string; group?: ProductionGroup }) {
  const view = useProjectView(slug);
  const boardState = useBoard(slug);
  const board = boardState.state === 'ready' ? boardState.data : null;
  const live = useRunning(slug, board);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<BoardSort>('activity');
  const [selected, setSelected] = useState<string | null>(null);
  const fetchThumbs = useMemo(() => (run: string, keys: string[], signal: AbortSignal) => runThumbs({ project: slug, run, keys }, { signal }), [slug]);
  const all = board?.scenarios ?? [];
  const inGroup = group ? all.filter((s) => productionState(s).group === group) : all;
  const shownList = filterSort(inGroup, query, sort);
  const current = selected !== null ? (shownList.find((s) => s.name === selected) ?? null) : null;
  // A production that left the grid (renamed, deleted, out of the group, hidden by the search) is no longer selected.
  const gone = selected !== null && board !== null && current === null;
  useEffect(() => {
    if (gone) setSelected(null);
  }, [gone]);
  const select = (name: string | null) => {
    setSelected(name);
    if (name !== null) rememberScenario(slug, name);
  };
  const open = (name: string) => {
    location.hash = hrefTo(productionRoute(slug, name));
  };

  if (view.state === 'loading')
    return (
      <div className="sc-screen">
        <p className="sc-quiet" role="status">
          Loading the project…
        </p>
      </div>
    );
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
        <ProductionsHead title={title} count={shownList.length} query={query} onQuery={setQuery} sort={sort} onSort={setSort} slug={slug} />
        <BoardNotices p={p} board={board} boardState={boardState} all={all} shownList={shownList} query={query} slug={slug} />
        {shownList.length > 0 && (
          <PosterGrid
            label={title}
            selected={current ? current.name : null}
            onSelect={select}
            onOpen={open}
            // In the app: the scenario's native menu (its modes, its report, its comments) — only the menu's id goes out.
            onContext={(name, e) => requestContextMenu('scenario', { slug, scenario: name }, e)}
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
        <ShellSlot name="inspector" inline={current ? 'Production details' : 'Project details'}>
          {current ? <ProductionInspector s={current} p={p} live={live} {...(board?.imported ? { imported: board.imported.command } : {})} /> : <ProjectInspector p={p} />}
        </ShellSlot>
      </div>
    </ThumbsProvider>
  );
}

/** The screen's head: its title and count, the search, the sort and New scenario. */
function ProductionsHead({
  title,
  count,
  query,
  onQuery,
  sort,
  onSort,
  slug,
}: {
  title: string;
  count: number;
  query: string;
  onQuery: (q: string) => void;
  sort: BoardSort;
  onSort: (s: BoardSort) => void;
  slug: string;
}) {
  return (
    <header className="pr-head">
      <h1 className="sc-h1">{shown(title)}</h1>
      <span className="pr-count k-mono">
        {shown(count)}
        <span className="k-sr"> {count === 1 ? 'production' : 'productions'}</span>
      </span>
      <div className="pr-tools">
        <Toolbar label="Productions">
          <TextField
            label="Search productions"
            type="search"
            value={query}
            onChange={onQuery}
            unsaved={null}
            placeholder="Search"
            layout="inline"
            labelHidden
            maxLength={200}
            autoComplete="off"
            spellCheck={false}
          />
          <Select label="Sort" value={sort} options={SORTS.map((s) => ({ value: s, label: SORT_LABEL[s] }))} onChange={(v) => onSort(v as BoardSort)} layout="inline" />
          <LinkButton to={{ name: 'record', slug }} variant="primary" icon="plus" testId="record-link">
            New scenario
          </LinkButton>
        </Toolbar>
      </div>
    </header>
  );
}

/** The id of the imported-project banner (the Render button of a production names it). */
export const IMPORTED_BANNER_ID = 'pr-imported';

/**
 * A project imported from a project archive and not trusted: nothing of it runs until a person trusts it, in a
 * terminal. A region with its heading (a lasting state, not a live announcement).
 */
export function ImportedBanner({ imported }: { imported: NonNullable<ProjectBoardView['imported']> }) {
  return (
    <section className="pr-warnings" id={IMPORTED_BANNER_ID} aria-labelledby={`${IMPORTED_BANNER_ID}-h`} data-testid="imported-banner">
      <h2 id={`${IMPORTED_BANNER_ID}-h`} className="sc-h3">
        <StatusMark state="warn" word="Imported — not trusted" />
      </h2>
      <p>
        {'Its hooks, sandboxes and components do not run, and nothing of it is filmed or rendered, until a person reads its code files and trusts it, in a terminal: '}
        <code>
          <Txt text={imported.command} />
        </code>
      </p>
    </section>
  );
}

/** What the grid says above it: an import not trusted, project.yaml's warnings, a board shown in part, loading, an error, nothing to show. */
function BoardNotices({
  p,
  board,
  boardState,
  all,
  shownList,
  query,
  slug,
}: {
  p: ProjectView;
  board: ProjectBoardView | null;
  boardState: ReturnType<typeof useBoard>;
  all: BoardScenario[];
  shownList: BoardScenario[];
  query: string;
  slug: string;
}) {
  return (
    <>
      {p.warnings.length > 0 && (
        <div className="pr-warnings">
          <StatusMark state="warn" word={`project.yaml: ${plural(p.warnings.length, 'warning')}`} />
          <Disclosure summary={p.warnings.length === 1 ? 'Show the warning' : `Show the ${plural(p.warnings.length, 'warning')}`}>
            <ul className="pr-warning-list">
              {p.warnings.map((w, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: project.yaml's warnings, replaced whole on each read, text only: the index is the identity
                <li key={i}>
                  <Txt text={w.message} />
                </li>
              ))}
            </ul>
          </Disclosure>
        </div>
      )}
      {board?.imported && <ImportedBanner imported={board.imported} />}
      {board?.truncated && <p className="sc-quiet">{shown(`The first ${board.truncated.shown} of ${board.truncated.total} scenarios are shown.`)}</p>}
      {boardState.state === 'loading' && (
        <p className="sc-quiet" role="status">
          Loading the productions…
        </p>
      )}
      {boardState.state === 'error' && (
        <p role="alert">
          {'The productions could not be read: '}
          <Txt text={boardState.error} />
        </p>
      )}
      {board && all.length === 0 && (
        <EmptyState
          title="No scenario yet"
          actions={
            <LinkButton to={{ name: 'record', slug }} variant="primary">
              Record a scenario
            </LinkButton>
          }
        >
          Record one in the browser, or ask Claude to write it.
        </EmptyState>
      )}
      {board && all.length > 0 && shownList.length === 0 && (
        <p className="sc-quiet" data-testid="productions-empty">
          {query ? 'No production matches the search.' : 'No production in this group.'}
        </p>
      )}
    </>
  );
}

/** Where a production's Open goes (for tests and the palette). */
export const productionRoute = (slug: string, name: string): Route => ({ name: 'scenario', slug, scenario: name, tab: 'blocks' });
