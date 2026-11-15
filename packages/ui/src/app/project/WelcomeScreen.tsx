/**
 * Welcome (`#/`) — no project open, the whole window (the browser pane is collapsed: this page IS the list of
 * projects; no inspector). A greeting (the app's mark, its name from brand.ts, one sentence) and the search; the
 * projects of the workspace (`project_list`) as cards that fill the width — in ONE call for all of them
 * (`projects_overview`) their picture (the last pictured step of the newest capture, run_thumbs through Thumb.tsx),
 * scenario and location counts, last run (a shape and a word, and when), environment flags in words and folder; a
 * project whose project.yaml does not load says so with its first error line. Then a New project card (a command to
 * copy: the page has no write path for projects). Under them, "Lately" (the index: Activity.tsx) beside "Set up": Claude
 * (the MCP registration command to copy) and the workspace (folder, projects folder, version, worker). Every value from
 * data is text (Txt / a kit slot); a step of a take re-reads nothing here (`onlyRunProgress`).
 */
import { useMemo } from 'react';
import { useEngineInfo, useProjectsOverview } from '../data/projects.js';
import type { ProjectList } from '../data/ops.js';
import type { ProjectOverview } from '../../server/ops.js';
import type { Loaded } from '../api.js';
import { Lately, SearchBox } from './Activity.js';
import { Txt, When, plural, shown } from '../bits.js';
import { APP_NAME } from '../brand.js';
import { otherCopyOf, otherCopyWords } from '../other-copy.js';
import { onlyRunProgress, useEvents } from '../events.js';
import { envFlagWords } from '../words/board-words.js';
import { hrefTo } from '../route.js';
import { BrowserCollapsed } from '../shell/slots.js';
import { runThumbs } from '../data/scenarios.js';
import { NoThumb, Thumb, ThumbsProvider } from '../Thumb.js';
import { AppMark, Blocker, EmptyState, Facts, Icon, StatusMark } from '../ui-kit/index.js';
import type { MarkState } from '../ui-kit/index.js';

type Extras = ProjectOverview;

const RUN_STATE: Record<string, [MarkState, string]> = {
  succeeded: ['ok', 'succeeded'],
  failed: ['fail', 'failed'],
  cancelled: ['idle', 'cancelled'],
  interrupted: ['fail', 'interrupted'],
  running: ['running', 'running'],
  queued: ['waiting', 'queued'],
};

/** The last run of a project, in a few words (a row that is no run says why in fixed words). */
export function LastRun({ extras }: { extras: Extras | undefined }) {
  if (!extras || extras.error) return null;
  const r = extras.last_run;
  if (!r) return <span className="sc-quiet">No run yet</span>;
  if (r.newer) return <span className="sc-quiet">{shown(`Last run written by a newer ${APP_NAME}`)}</span>;
  if (r.unread) return <span className="sc-quiet">{shown('Last run: its run.json does not read as a record')}</span>;
  const [state, word] = RUN_STATE[r.status] ?? ['attention', 'status unknown'];
  return (
    <span className="wl-run">
      <StatusMark state={state} word={`Last ${r.mode === 'dry' ? 'rehearsal' : 'capture'} ${word}`} />
      <span className="sc-quiet">
        {' · '}
        <Txt text={r.scenario} /> · <When iso={r.finished_at ?? r.started_at} />
      </span>
    </span>
  );
}

/** A project card's picture: its newest pictured take (a loader per card: the fetch closes over its project). */
function CardPicture({ slug, name, extras }: { slug: string; name: string; extras: Extras | undefined }) {
  const fetch = useMemo(() => (run: string, keys: string[], signal: AbortSignal) => runThumbs({ project: slug, run, keys }, { signal }), [slug]);
  const poster = extras?.poster;
  if (!poster) return <NoThumb size="poster">{extras?.last_run ? 'No picture yet' : 'Not shot yet'}</NoThumb>;
  return (
    <ThumbsProvider fetch={fetch}>
      <Thumb run={poster.run} runKey={poster.key} size="poster" alt={`The last pictured step of ${name}`} />
    </ThumbsProvider>
  );
}

function ProjectCard({ p, extras }: { p: ProjectList['projects'][number]; extras: Extras | undefined }) {
  const flags = (extras?.environments ?? []).map((e) => ({ name: e.name, words: envFlagWords(e, false) })).filter((e) => e.words);
  return (
    <li className="wl-project" data-testid="project-card">
      {p.error ? <NoThumb size="poster">Does not load</NoThumb> : <CardPicture slug={p.slug} name={p.name} extras={extras} />}
      <div className="wl-project-body">
        <h3 className="wl-project-name">
          <a href={hrefTo({ name: 'project', slug: p.slug })}>
            <Txt text={p.name} />
          </a>
        </h3>
        <Txt className="wl-project-path k-mono" text={p.slug} />
        {p.error ? (
          <p className="wl-project-line">
            <StatusMark state="fail" word="Does not load" />
            <span className="wl-project-error">
              {' · This project does not load: '}
              <Txt text={p.error} />
            </span>
          </p>
        ) : (
          <>
            <p className="wl-project-line">
              {shown(plural(p.scenarios.length, 'scenario'))}
              {' · '}
              {shown(plural(p.environments.length, 'location'))}
              {extras?.error && (
                <>
                  {' · '}
                  <Txt text={extras.error} />
                </>
              )}
            </p>
            <p className="wl-project-line">
              <LastRun extras={extras} />
            </p>
            {flags.length > 0 && (
              <p className="wl-project-line sc-quiet">
                {flags.map((f, i) => (
                  <span key={f.name}>
                    {i > 0 && ' · '}
                    <Txt text={f.name} />
                    {': '}
                    {shown(f.words)}
                  </span>
                ))}
              </p>
            )}
          </>
        )}
        <Txt className="wl-project-path k-mono" text={p.dir} />
      </div>
    </li>
  );
}

/** The last card: how a project starts (a command to copy — the page writes no project). */
function NewProjectCard() {
  return (
    <li className="wl-project wl-new">
      <span className="wl-new-icon">
        <Icon name="plus" />
      </span>
      <h3 className="wl-project-name">New project</h3>
      <p className="wl-project-line">Create one in a terminal, or ask Claude: it shows here at once.</p>
      <Blocker fix={{ copy: 'retake new <slug>' }}>Point it at your product, then write the first scenario.</Blocker>
    </li>
  );
}

export function WelcomeScreen({ list }: { list: Loaded<ProjectList> }) {
  const [overview, reload] = useProjectsOverview({}, 'all');
  const [info] = useEngineInfo({}, 'info');
  useEvents((e) => {
    if ((e.type === 'workspace' && e.projects.length > 0 && !onlyRunProgress(e)) || e.type === 'resync') reload();
  });
  const extras = new Map(overview.state === 'ready' ? overview.data.projects.map((x) => [x.slug, x]) : []);
  const projectsDir = list.state === 'ready' ? list.data.projects_dir : '';
  const count = list.state === 'ready' ? list.data.projects.length : null;
  return (
    <div className="sc-screen wl">
      <BrowserCollapsed />
      <div className="wl-hero">
        <section className="wl-intro" aria-labelledby="wl-h1">
          <AppMark variant="full" size={64} />
          <h1 id="wl-h1" className="wl-title">
            {shown(`Welcome to ${APP_NAME}`)}
          </h1>
          <p className="wl-lede">Write a scenario: the Studio films your product, edits the video and films it again when the product changes.</p>
        </section>
        <SearchBox />
      </div>
      <section className="wl-projects" aria-labelledby="wl-projects-h">
        <div className="wl-section-head">
          <h2 id="wl-projects-h" className="wl-h2">
            Projects
          </h2>
          {count !== null && count > 0 && <span className="wl-count">{shown(String(count))}</span>}
        </div>
        {list.state === 'loading' && <p className="sc-quiet">Loading the projects…</p>}
        {list.state === 'error' && (
          <p role="alert">
            {'The projects could not be listed: '}
            <Txt text={list.error} />
          </p>
        )}
        {list.state === 'ready' && list.data.projects.length === 0 && (
          <EmptyState title="No project yet" level={3}>
            Create one with retake new in a terminal, or ask Claude (project_create).
          </EmptyState>
        )}
        {list.state === 'ready' && (
          <ul className="wl-list" aria-label="Projects">
            {list.data.projects.map((p) => (
              <ProjectCard key={p.slug} p={p} extras={extras.get(p.slug)} />
            ))}
            <NewProjectCard />
          </ul>
        )}
      </section>
      <div className="wl-bottom">
        <section className="wl-lately" aria-labelledby="wl-lately-h">
          <h2 id="wl-lately-h" className="wl-h2">
            Lately
          </h2>
          <Lately label="Recent activity of the workspace" />
        </section>
        <section className="wl-setup" aria-labelledby="wl-setup-h">
          <h2 id="wl-setup-h" className="wl-h2">
            Set up
          </h2>
          <div className="wl-panel">
            <h3 className="wl-project-name">Work with Claude</h3>
            <p className="sc-quiet">Claude writes scenarios, runs them and reads the review through the MCP server; what it does shows up here too.</p>
            <Blocker fix={{ copy: 'retake mcp --print-config', label: 'Copy command' }}>Register the MCP server with Claude.</Blocker>
          </div>
          <div className="wl-panel">
            <h3 className="wl-project-name">Workspace</h3>
            <Facts
              rows={[
                { key: 'folder', label: 'Folder', value: <Txt className="k-mono" text={info.state === 'ready' ? info.data.root : list.state === 'ready' ? list.data.root : ''} /> },
                ...(projectsDir ? [{ key: 'projects', label: 'Projects', value: <Txt className="k-mono" text={projectsDir} /> }] : []),
                { key: 'version', label: 'Version', value: info.state === 'ready' ? info.data.version : '…' },
                {
                  key: 'worker',
                  label: 'Worker',
                  value:
                    info.state === 'ready' ? (
                      info.data.worker ? (
                        <Txt text={`running (pid ${info.data.worker.pid})${otherCopyWords(otherCopyOf(info.data, 'worker_other_copy'))}`} />
                      ) : (
                        'idle: it starts with the next job'
                      )
                    ) : (
                      '…'
                    ),
                },
              ]}
            />
          </div>
        </section>
      </div>
    </div>
  );
}
