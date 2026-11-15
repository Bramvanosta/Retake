/**
 * The shell's browser pane (AppShell.tsx): Welcome's tree (the projects of the workspace), an open project's tree (its
 * pages, Locations, Cast, README and Record) and the workspace foot.
 */
import type { ReactNode } from 'react';
import type { AuthStatus, ProjectBoardView, ProjectSummary, ProjectView } from '@retake/engine';
import type { Loaded } from '../api.js';
import type { EngineInfoAnswer, ProjectList } from '../data/ops.js';
import { Txt } from '../bits.js';
import { hrefTo } from '../route.js';
import type { Route } from '../route.js';
import { SourceList, StatusMark } from '../ui-kit/index.js';
import type { SourceGroup, SourceItem } from '../ui-kit/index.js';
import { BOARD_GROUPS, GROUP_LABEL, castState, envFlagWord, groupCounts } from '../words/board-words.js';

export interface OpenProject {
  view: Loaded<ProjectView>;
  board: Loaded<ProjectBoardView>;
  cast: Loaded<AuthStatus>;
}

/** Welcome's browser: Projects and the projects of the workspace. */
function workspaceTree(route: Route, projects: ProjectSummary[]): SourceGroup[] {
  return [
    {
      key: 'workspace',
      items: [
        {
          key: 'projects',
          to: { name: 'projects' },
          label: 'Projects',
          icon: 'folder',
          current: route.name === 'projects' || route.name === 'setup',
          childrenLabel: 'Projects of the workspace',
          children: projects.map((p) => ({ key: p.slug, to: { name: 'project', slug: p.slug }, label: <Txt text={p.name} />, current: false, ...(p.error ? { flag: 'does not load' } : {}) })),
        },
      ],
    },
  ];
}

/**
 * An open project's browser: Productions and its smart groups, the Library, the Locations (environments
 * with their flags in words), the Cast (each persona's session: a shape and a word), the Project's README and Record.
 */
function projectTree(route: Route, slug: string, d: OpenProject, readmeDirty: boolean): SourceGroup[] {
  const board = d.board.state === 'ready' ? d.board.data : null;
  const view = d.view.state === 'ready' ? d.view.data : null;
  const counts = board ? groupCounts(board.scenarios) : null;
  const total = board ? (board.truncated?.total ?? board.scenarios.length) : view?.scenarios.length;
  const row = (key: string, to: Route, label: ReactNode, current: boolean, extra: Partial<SourceItem> = {}): SourceItem => ({ key, to, label, current, ...extra });
  const personas = d.cast.state === 'ready' ? d.cast.data.personas : [];
  const manyEnvs = new Set(personas.map((p) => p.env)).size > 1;
  return [
    {
      key: 'productions',
      label: 'Productions',
      items: [
        row('productions', { name: 'project', slug }, 'Productions', route.name === 'project', {
          icon: 'film',
          ...(total !== undefined ? { count: total } : {}),
          childrenLabel: 'Smart groups',
          children: BOARD_GROUPS.map((g) => row(`g-${g}`, { name: 'group', slug, group: g }, GROUP_LABEL[g], route.name === 'group' && route.group === g, counts ? { count: counts[g] } : {})),
        }),
      ],
    },
    {
      key: 'library',
      heading: 'Library',
      label: 'Library',
      items: [
        row('library', { name: 'library', slug }, 'Components', route.name === 'library', { icon: 'components', testId: 'library-link' }),
        row('themes', { name: 'themes', slug }, 'Themes', route.name === 'themes', { icon: 'theme' }),
      ],
    },
    {
      key: 'locations',
      heading: 'Locations',
      label: 'Locations',
      items: view
        ? view.environments.map((e) => {
            const flags = envFlagWord(e, e.name === view.default_env);
            return row(`loc-${e.name}`, { name: 'location', slug, env: e.name }, <Txt text={e.name} />, route.name === 'location' && route.env === e.name, {
              icon: 'location',
              ...(flags ? { flag: flags } : {}),
            });
          })
        : [],
    },
    {
      key: 'cast',
      heading: 'Cast',
      label: 'Cast',
      items: [
        row('cast', { name: 'cast', slug }, 'Sessions', route.name === 'cast', {
          icon: 'person',
          ...(d.cast.state === 'ready' ? { count: personas.length } : {}),
          childrenLabel: 'Personas',
          children: personas.map((p) => {
            const c = castState(p);
            // Several locations: each one under its persona's name, on a line that wraps (never cut off).
            return row(`p-${p.env}-${p.persona}`, { name: 'cast', slug }, <Txt text={p.persona} />, false, {
              quiet: true,
              flag: <StatusMark state={c.state} word={c.word} />,
              ...(manyEnvs ? { detail: <Txt text={p.env} /> } : {}),
            });
          }),
        }),
      ],
    },
    {
      key: 'project',
      heading: 'Project',
      label: 'Project',
      items: [
        row('readme', { name: 'readme', slug }, 'README', route.name === 'readme', { icon: 'report', ...(readmeDirty ? { flag: 'unsaved' } : {}) }),
        row('record', { name: 'record', slug }, 'Record a scenario', route.name === 'record', { icon: 'record' }),
      ],
    },
  ];
}

/** The browser pane: the source list (unless a screen fills the slot), the screen's slot, the workspace foot. */
export function BrowserPane({
  route,
  list,
  projects,
  openSlug,
  open,
  readmeDirty,
  info,
  claimed,
  collapsed,
  browserRef,
}: {
  route: Route;
  list: Loaded<ProjectList>;
  projects: ProjectSummary[];
  openSlug: string | null;
  open: OpenProject;
  readmeDirty: boolean;
  info: EngineInfoAnswer | null;
  claimed: boolean;
  collapsed: boolean;
  browserRef: (el: HTMLElement | null) => void;
}) {
  return (
    <aside className="sh-browser sidebar" aria-label="Browser" hidden={collapsed}>
      {!claimed && <SourceList label="Studio" groups={openSlug !== null ? projectTree(route, openSlug, open, readmeDirty) : workspaceTree(route, projects)} />}
      <div className="sh-slot-browser" ref={browserRef} hidden={!claimed} />
      <div className="sh-browser-foot">
        <p className="sh-foot-line">
          <span className="sh-foot-label">Workspace</span>
          <Txt className="sh-foot-path k-mono" text={info?.root ?? (list.state === 'ready' ? list.data.root : '')} />
        </p>
        {info && (
          <p className="sh-foot-line sh-foot-meta">
            <span className="k-mono">v{info.version}</span>
            {info.worker && (
              <span className="k-mono">
                {` · worker pid ${info.worker.pid}`}
                {info.worker.started_by && <>, started by {info.worker.started_by === 'ui' ? 'the Studio' : <Txt text={info.worker.started_by} />}</>}
              </span>
            )}
          </p>
        )}
        <a href={hrefTo({ name: 'ui' })} className="sh-foot-link" aria-current={route.name === 'ui' ? 'page' : undefined}>
          UI gallery
        </a>
      </div>
    </aside>
  );
}
