/**
 * The Studio app (L4.1): the session bootstrap (session.ts), the hash router (route.ts), live updates (events.ts: one
 * event stream per browser) and the screens inside the shell — Projects (with search and recent activity), a project,
 * its README editor. Every string from the server is a React text node: no HTML from data,
 * ever (a source lint test bans the raw-HTML APIs); the strict CSP (no inline script, no eval, same-origin connections)
 * is the second line.
 */
import { StrictMode, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { info, setToken, useCall, useConnection } from './api.js';
import { startEvents, useEvents } from './events.js';
import { Notice, Txt } from './bits.js';
import { dirtyDrafts, guardUnload } from './drafts.js';
import { ProjectPage } from './ProjectPage.js';
import { ProjectsScreen } from './ProjectsScreen.js';
import { ReadmeEditor } from './ReadmeEditor.js';
import { hrefTo, parseRoute } from './route.js';
import type { Route } from './route.js';
import { SessionEnded, openSession, takeCodeFromUrl } from './session.js';
import { Shell } from './Shell.js';
import type { ProjectList } from './Shell.js';
import './app.css';

function useRoute(): Route {
  const [route, set] = useState(() => parseRoute(location.hash));
  useEffect(() => {
    const on = () => set(parseRoute(location.hash));
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}

const TITLES: Record<Route['name'], string> = { projects: 'Projects', project: 'Project', readme: 'README', 'not-found': 'Not found' };

function Studio() {
  const route = useRoute();
  const [list, reloadList] = useCall<ProjectList>('project_list', {}, 'all');
  const connection = useConnection();
  useEffect(() => guardUnload(), []);
  // A project added, removed or changed on disk (or a reconnection): the list and the sidebar read it again.
  useEvents((e) => {
    if ((e.type === 'workspace' && e.projects.length > 0) || e.type === 'resync') reloadList();
  });
  const first = useRef(true);
  useEffect(() => {
    document.title = `${TITLES[route.name]} · Demo Studio`;
    // Back on the projects: read them again (the first load is useCall's own).
    if (route.name === 'projects' && !first.current) reloadList();
    first.current = false;
  }, [route, reloadList]);
  if (connection === 'ended') return <Ended />;
  return (
    <Shell route={route} list={list}>
      {route.name === 'projects' && <ProjectsScreen list={list} />}
      {route.name === 'project' && <ProjectPage key={route.slug} slug={route.slug} />}
      {route.name === 'readme' && <ReadmeEditor key={route.slug} slug={route.slug} />}
      {route.name === 'not-found' && (
        <div className="screen">
          <h1>Nothing here</h1>
          <p>
            <a href={hrefTo({ name: 'projects' })}>Back to the projects</a>
          </p>
        </div>
      )}
    </Shell>
  );
}

/**
 * The session ended (the server restarted or stopped answering this tab's token). Unsaved README text stays on screen,
 * read-only, to copy into the new session (review B H1: the editor is gone, the text must not go with it); closing the
 * tab still asks first while there is some.
 */
function Ended() {
  const drafts = dirtyDrafts();
  return (
    <main className="ended" data-testid="session-ended">
      <h1>Demo Studio</h1>
      <Notice tone="warning" role="alert" title="This Studio session ended">
        <p>
          Run <code>studio ui</code> again in a terminal: it opens a new session. A Studio link works once, in one tab.
        </p>
      </Notice>
      {drafts.length > 0 && (
        <section className="kept-drafts" aria-labelledby="kept-h" data-testid="unsaved-drafts">
          <h2 id="kept-h">Your unsaved text</h2>
          <p>It was not saved. Copy it before you close this tab, then paste it into the editor of the new session.</p>
          {drafts.map((d) => (
            <label key={d.slug} className="field">
              <span className="label">
                README.md of <Txt text={d.slug} />
              </span>
              <textarea className="kept" readOnly value={d.text} rows={10} data-testid="unsaved-draft" />
            </label>
          ))}
        </section>
      )}
    </main>
  );
}

type Boot = { kind: 'loading' } | { kind: 'ended' } | { kind: 'error'; message: string } | { kind: 'ready' };

function App({ code }: { code: string | null }) {
  const [boot, setBoot] = useState<Boot>({ kind: 'loading' });
  useEffect(() => {
    let live = true;
    (async () => {
      const token = await openSession(code);
      setToken(token);
      await info();
      if (!live) return;
      startEvents(token);
      setBoot({ kind: 'ready' });
    })().catch((e: unknown) => {
      if (!live) return;
      setBoot(e instanceof SessionEnded ? { kind: 'ended' } : { kind: 'error', message: e instanceof Error ? e.message : String(e) });
    });
    return () => {
      live = false;
    };
  }, [code]);
  if (boot.kind === 'ended') return <Ended />;
  if (boot.kind === 'error') {
    return (
      <main className="ended">
        <h1>Demo Studio</h1>
        <Notice tone="danger" role="alert" title="The Studio could not start">
          <p>{boot.message}</p>
        </Notice>
      </main>
    );
  }
  if (boot.kind === 'loading') {
    return (
      <main className="ended">
        <p role="status">Connecting…</p>
      </main>
    );
  }
  return <Studio />;
}

const code = takeCodeFromUrl();
const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App code={code} />
    </StrictMode>,
  );
}
