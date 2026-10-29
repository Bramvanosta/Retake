/**
 * Projects: every project of the workspace (`project_list`, from the files) with its scenario count, and — in ONE call
 * for all the cards (`projects_overview`, review B L2: not two per card at every focus and reconnection) — its
 * environments with their production / read-only / sandbox flags and its last run. A project whose project.yaml does
 * not load is listed with the error. Above, the search box; below, the workspace's recent activity (both from the
 * index: Activity.tsx). The overview is read again when any project's files change (events.ts).
 */
import type { ProjectSummary, RunListItem } from '@demo-studio/engine';
import { useCall } from './api.js';
import { ActivityPanel, SearchBox } from './Activity.js';
import { useEvents } from './events.js';
import type { Loaded } from './api.js';
import { Badge, EnvFlags, Loading, Notice, plural, RunState, Txt, When } from './bits.js';
import { hrefTo } from './route.js';
import type { ProjectList } from './shell/AppShell.js';
import { APP_NAME } from './brand.js';

/** projects_overview's answer: per project, its environment flags and last run (or why it does not open). */
interface Overview {
  projects: Array<{ slug: string; environments: Array<{ name: string; production: boolean; access: 'read-only' | 'read-write'; sandbox: boolean }>; last_run: RunListItem | null; error?: string }>;
}
type CardExtras = Overview['projects'][number];

function LastRun({ extras }: { extras: CardExtras | undefined }) {
  if (!extras || extras.error) return null;
  const r = extras.last_run;
  if (!r) return <span className="muted">No run yet</span>;
  if (r.newer) return <span className="muted">Last run written by a newer {APP_NAME}</span>;
  return (
    <span className="last-run">
      Last {r.mode === 'dry' ? 'dry run' : 'capture'}: <Txt text={r.scenario} /> <RunState status={r.status} /> <When iso={r.finished_at ?? r.started_at} />
    </span>
  );
}

function Environments({ names, extras }: { names: string[]; extras: CardExtras | undefined }) {
  if (names.length === 0) return <span className="muted">No environment</span>;
  if (extras?.error) return <span className="muted">{extras.error}</span>;
  const envs = extras ? extras.environments : names.map((name) => ({ name, production: false, access: 'read-write' as const, sandbox: false }));
  return (
    <ul className="env-list" aria-label="Environments">
      {envs.map((e) => (
        <li key={e.name} className="env-chip">
          <Txt text={e.name} />
          <EnvFlags env={e} />
        </li>
      ))}
    </ul>
  );
}

function ProjectCard({ p, extras }: { p: ProjectSummary; extras: CardExtras | undefined }) {
  return (
    <li className="card project-card" data-testid="project-card">
      <div className="card-head">
        <h2 className="card-title">
          <a href={hrefTo({ name: 'project', slug: p.slug })}>
            <Txt text={p.name} />
          </a>
        </h2>
        <Txt className="slug" text={p.slug} />
      </div>
      {p.error ? (
        <Notice tone="danger" role="note" title="This project does not load">
          <p className="pre-line">
            <Txt text={p.error} />
          </p>
          <p className="small">Open the project to see every error.</p>
        </Notice>
      ) : (
        <>
          <p className="meta">
            <Badge>{plural(p.scenarios.length, 'scenario')}</Badge>
            <LastRun extras={extras} />
          </p>
          <Environments names={p.environments} extras={extras} />
        </>
      )}
    </li>
  );
}

export function ProjectsScreen({ list }: { list: Loaded<ProjectList> }) {
  const [overview, reload] = useCall<Overview>('projects_overview', {}, 'all');
  useEvents((e) => {
    if ((e.type === 'workspace' && e.projects.length > 0) || e.type === 'resync') reload();
  });
  const extras = new Map(overview.state === 'ready' ? overview.data.projects.map((x) => [x.slug, x]) : []);
  return (
    <div className="screen">
      <header className="screen-head">
        <h1>Projects</h1>
        {list.state === 'ready' && (
          <p className="muted">
            {plural(list.data.projects.length, 'project')} in <Txt className="path" text={list.data.projects_dir} />
          </p>
        )}
      </header>
      <SearchBox />
      {list.state === 'loading' && <Loading what="the projects" />}
      {list.state === 'error' && (
        <Notice tone="danger" role="alert" title="The projects could not be listed">
          <p>{list.error}</p>
        </Notice>
      )}
      {list.state === 'ready' && list.data.projects.length === 0 && (
        <Notice tone="info" title="No project yet">
          <p>
            Create one with <code>studio new &lt;slug&gt;</code> in a terminal, or ask Claude (<code>project_create</code>).
          </p>
        </Notice>
      )}
      {list.state === 'ready' && list.data.projects.length > 0 && (
        <ul className="project-grid" aria-label="Projects">
          {list.data.projects.map((p) => (
            <ProjectCard key={p.slug} p={p} extras={extras.get(p.slug)} />
          ))}
        </ul>
      )}
      <ActivityPanel />
    </div>
  );
}
