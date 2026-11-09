/**
 * L5.10a: Welcome (`#/`, R4-Welcome) — no project open. The app (its name from brand.ts, its version, one sentence),
 * how to start a project (a command to copy: the page has no write path for projects), the workspace folder; the
 * projects of the workspace (`project_list`) with — in ONE call for all of them (`projects_overview`, review B L2) —
 * their scenario count, last run (a shape and a word, and when), environment flags in words and folder; a project whose
 * project.yaml does not load says so with its first error line. Then the search and "Lately" (the index: Activity.tsx).
 * The inspector: the workspace (folder, version, worker) and Claude (the MCP registration command to copy). Posters of
 * projects are cut (critique H2: they span projects; BL-128). Every value from data is text (Txt / a kit slot).
 * L5.10a fixes: R4-Welcome's layout — an identity column (the app's mark, name, version, New project, the projects
 * folder) beside "Recent projects", one column in a narrow centre (review B-L6); a step of a take re-reads nothing here
 * (review A-L5: `onlyRunProgress`); with the inspector hidden, the workspace and Claude show under Lately.
 */
import { useEngineInfo, useProjectsOverview } from './data/projects.js';
import type { ProjectList } from './data/ops.js';
import type { ProjectOverview } from '../server/ops.js';
import type { Loaded } from './api.js';
import { Lately, SearchBox } from './Activity.js';
import { Txt, When, plural, shown } from './bits.js';
import { APP_NAME } from './brand.js';
import { otherCopyOf, otherCopyWords } from './other-copy.js';
import { onlyRunProgress, useEvents } from './events.js';
import { envFlagWords } from './board-words.js';
import { hrefTo } from './route.js';
import { ShellSlot } from './shell/slots.js';
import { AppMark, Blocker, EmptyState, Facts, InspectorSection, StatusMark } from './ui-kit/index.js';
import type { MarkState } from './ui-kit/index.js';

type Extras = ProjectOverview;

const RUN_STATE: Record<string, [MarkState, string]> = {
  succeeded: ['ok', 'succeeded'],
  failed: ['fail', 'failed'],
  cancelled: ['idle', 'cancelled'],
  interrupted: ['fail', 'interrupted'],
  running: ['running', 'running'],
  queued: ['waiting', 'queued'],
};

function LastRun({ extras }: { extras: Extras | undefined }) {
  if (!extras || extras.error) return null;
  const r = extras.last_run;
  if (!r) return <span className="sc-quiet">No run yet</span>;
  if (r.newer) return <span className="sc-quiet">{shown(`Last run written by a newer ${APP_NAME}`)}</span>;
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

function ProjectRow({ p, extras }: { p: ProjectList['projects'][number]; extras: Extras | undefined }) {
  const flags = (extras?.environments ?? []).map((e) => ({ name: e.name, words: envFlagWords(e, false) })).filter((e) => e.words);
  return (
    <li className="wl-project" data-testid="project-card">
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
  return (
    <div className="sc-screen wl">
      <div className="wl-top">
        <section className="wl-intro" aria-labelledby="wl-h1">
          <AppMark variant="full" size={128} />
          <h1 id="wl-h1" className="sc-h1">
            {shown(APP_NAME)}
          </h1>
          {info.state === 'ready' && <p className="wl-version">{shown(`Version ${info.data.version}`)}</p>}
          <p className="wl-lede">Write a scenario: the Studio films your product, edits the video and films it again when the product changes.</p>
          <Blocker fix={{ copy: 'retake new <slug>' }}>
            New project: create one in a terminal; it shows here at once.
          </Blocker>
          {projectsDir && (
            <p className="sc-quiet">
              {'Projects live in '}
              <Txt className="k-mono" text={projectsDir} />
            </p>
          )}
        </section>
        <section className="wl-projects" aria-labelledby="wl-projects-h">
          <h2 id="wl-projects-h" className="sc-h2">
            Recent projects
          </h2>
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
          {list.state === 'ready' && list.data.projects.length > 0 && (
            <ul className="wl-list" aria-label="Projects">
              {list.data.projects.map((p) => (
                <ProjectRow key={p.slug} p={p} extras={extras.get(p.slug)} />
              ))}
            </ul>
          )}
        </section>
      </div>
      <SearchBox />
      <section className="wl-lately" aria-labelledby="wl-lately-h">
        <h2 id="wl-lately-h" className="sc-h2">
          Lately
        </h2>
        <Lately label="Recent activity of the workspace" />
      </section>
      <ShellSlot name="inspector" inline="Workspace details">
        <InspectorSection title="Workspace">
          <Facts
            rows={[
              { key: 'folder', label: 'Folder', value: <Txt className="k-mono" text={info.state === 'ready' ? info.data.root : list.state === 'ready' ? list.data.root : ''} /> },
              { key: 'projects', label: 'Projects', value: list.state === 'ready' ? plural(list.data.projects.length, 'project') : '…' },
              { key: 'version', label: 'Version', value: info.state === 'ready' ? info.data.version : '…' },
              { key: 'worker', label: 'Worker', value: info.state === 'ready' ? (info.data.worker ? <Txt text={`running (pid ${info.data.worker.pid})${otherCopyWords(otherCopyOf(info.data, 'worker_other_copy'))}`} /> : 'idle: it starts with the next job') : '…' },
            ]}
          />
        </InspectorSection>
        <InspectorSection title="Claude">
          <p className="sc-quiet">Claude writes scenarios, runs them and reads the review through the MCP server; what it does shows up here too.</p>
          <Blocker fix={{ copy: 'retake mcp --print-config', label: 'Copy command' }}>
            Register the MCP server with Claude.
          </Blocker>
        </InspectorSection>
      </ShellSlot>
    </div>
  );
}
