/**
 * The Studio's frame: a sidebar (the app, the projects of the workspace with the open one's pages, the workspace
 * folder, the connection, version and jobs worker) and the main area of the current screen. Later lots add their
 * screens (scenario blocks, timeline, comments, library, themes) to the open project's pages.
 */
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { ProjectSummary } from '@demo-studio/engine';
import { call, useConnection } from './api.js';
import { useEventMode, useEvents } from './events.js';
import type { EventMode } from './events.js';
import type { Connection, Loaded } from './api.js';
import { readmeKey, useDirty } from './drafts.js';
import { Txt } from './bits.js';
import { hrefTo } from './route.js';
import type { Route } from './route.js';

export interface ProjectList {
  root: string;
  projects_dir: string;
  projects: ProjectSummary[];
}

interface EngineInfoData {
  version: string;
  root: string;
  worker: { pid: number; started_by?: string } | null;
}

const CONNECTION: Record<Connection, string> = { connecting: 'Connecting…', online: 'Connected', offline: 'Not connected', ended: 'Session ended' };
const UPDATES: Record<EventMode, string> = { connecting: '', stream: 'live updates', relay: 'live updates', polling: 'updates every 3 s', off: '' };

/** Worker state and version: `engine_info` now, at every job change and every 15 s (an idle worker exits quietly). */
function useEngineInfo(): EngineInfoData | null {
  const [v, set] = useState<EngineInfoData | null>(null);
  const [tick, setTick] = useState(0);
  useEvents((e) => {
    if (e.type === 'jobs' || e.type === 'resync') setTick((t) => t + 1);
  });
  useEffect(() => {
    let live = true;
    const load = () => call<EngineInfoData>('engine_info').then((d) => live && set(d), () => undefined);
    load();
    const t = window.setInterval(load, 15_000);
    return () => {
      live = false;
      window.clearInterval(t);
    };
  }, [tick]);
  return v;
}

function NavLink({ to, current, children }: { to: Route; current: boolean; children: ReactNode }) {
  return (
    <a href={hrefTo(to)} aria-current={current ? 'page' : undefined} className={current ? 'nav-link current' : 'nav-link'}>
      {children}
    </a>
  );
}

function ProjectNav({ p, route }: { p: ProjectSummary; route: Route }) {
  const open = (route.name === 'project' || route.name === 'readme' || route.name === 'scenario' || route.name === 'run' || route.name === 'timeline' || route.name === 'comments' || route.name === 'proposal' || route.name === 'library' || route.name === 'themes') && route.slug === p.slug;
  const dirty = useDirty(readmeKey(p.slug));
  return (
    <li>
      <NavLink to={{ name: 'project', slug: p.slug }} current={open && route.name === 'project'}>
        <Txt className="nav-name" text={p.name} />
        {p.error && <span className="nav-flag">does not load</span>}
      </NavLink>
      {open && (
        <ul className="nav-sub">
          <li>
            <NavLink to={{ name: 'project', slug: p.slug }} current={route.name === 'project'}>
              Overview
            </NavLink>
          </li>
          <li>
            <NavLink to={{ name: 'readme', slug: p.slug }} current={route.name === 'readme'}>
              README
              {dirty && <span className="nav-flag">unsaved</span>}
            </NavLink>
          </li>
          <li>
            <NavLink to={{ name: 'library', slug: p.slug }} current={route.name === 'library'}>
              Components
            </NavLink>
          </li>
          <li>
            <NavLink to={{ name: 'themes', slug: p.slug }} current={route.name === 'themes'}>
              Themes
            </NavLink>
          </li>
        </ul>
      )}
    </li>
  );
}

export function Shell({ route, list, children }: { route: Route; list: Loaded<ProjectList>; children: ReactNode }) {
  const connection = useConnection();
  const updates = useEventMode();
  const info = useEngineInfo();
  const main = useRef<HTMLElement>(null);
  useEffect(() => {
    main.current?.scrollTo?.(0, 0);
  }, [route]);
  const projects = list.state === 'ready' ? list.data.projects : [];
  return (
    <div className="app">
      <button type="button" className="skip" onClick={() => main.current?.focus()}>
        Skip to content
      </button>
      <aside className="sidebar">
        <p className="brand">
          <span className="brand-mark" aria-hidden="true" />
          Demo Studio
        </p>
        <nav aria-label="Studio">
          <ul className="nav">
            <li>
              <NavLink to={{ name: 'projects' }} current={route.name === 'projects'}>
                Projects
              </NavLink>
              {projects.length > 0 && (
                <ul className="nav-projects" aria-label="Projects of the workspace">
                  {projects.map((p) => (
                    <ProjectNav key={p.slug} p={p} route={route} />
                  ))}
                </ul>
              )}
            </li>
          </ul>
        </nav>
        <div className="sidebar-foot">
          <p className="workspace">
            <span className="label">Workspace</span>
            <Txt className="path" text={info?.root ?? (list.state === 'ready' ? list.data.root : '')} />
          </p>
          <p className="status" data-testid="connection" data-updates={updates}>
            <span className={`dot dot-${connection}`} aria-hidden="true" />
            {CONNECTION[connection]}
            {info && (
              <>
                {' · '}
                <span>v{info.version}</span>
                {' · '}
                <span>{info.worker ? `worker running (pid ${info.worker.pid}${info.worker.started_by ? `, started by ${info.worker.started_by === 'ui' ? 'the Studio' : info.worker.started_by}` : ''})` : 'worker idle'}</span>
              </>
            )}
            {connection === 'online' && UPDATES[updates] && <> · {UPDATES[updates]}</>}
          </p>
        </div>
      </aside>
      <main id="main" ref={main} tabIndex={-1}>
        {children}
      </main>
    </div>
  );
}
