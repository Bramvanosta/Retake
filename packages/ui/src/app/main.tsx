/**
 * The Studio app (L4.1): the session bootstrap (session.ts), the hash router (route.ts), live updates (events.ts: one
 * event stream per browser) and the screens inside the shell — Welcome (L5.10a: the projects, search and recent activity), a project's productions (L5.10a: the poster grid, its smart groups and locations; the Cast),
 * its README editor, a scenario as blocks with its run's pictures (L4.2), its Shoot screens (L4.4; L5.11a: Prepare a take and one run live), its timeline (L4.5; L5.12a: Edit in the shell), its Review report (L5.12a), its frame comments and the preview of a proposed change (L4.6), its component library and its themes (L4.7), the Record screen (L4.8). Every string from the server is a React text node: no HTML from data,
 * ever (a source lint test bans the raw-HTML APIs); the strict CSP (no inline script, no eval, same-origin connections)
 * is the second line. L5.9: the screens sit in the design system's shell (shell/AppShell.tsx: title bar with the mode
 * switch, browser, centre pane, inspector, status bar), the `#/ui` gallery shows every component of the kit (ui-kit/);
 * the desktop app's overlay title bar (`window.__studioShell`, a main-frame init script of the shell) moves the title
 * bar's content clear of the window buttons (`html[data-titlebar]`), nothing else; the product's name is brand.ts's.
 */
import { StrictMode, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { info, setToken, useConnection } from './api.js';
import { useProjectList } from './data/projects.js';
import { onlyRunProgress, startEvents, useEvents } from './events.js';
import { Txt } from './bits.js';
import { APP_NAME } from './brand.js';
import { dirtyDrafts, guardUnload } from './drafts.js';
import { startUnsavedReport } from './unsaved-report.js';
import { CommentsScreen } from './review/CommentsScreen.js';
import { LibraryScreen } from './library/LibraryScreen.js';
import { CastScreen } from './project/CastScreen.js';
import { ProductionsScreen } from './project/ProductionsScreen.js';
import { WelcomeScreen } from './project/WelcomeScreen.js';
import { ReadmeEditor } from './project/ReadmeEditor.js';
import { RecordScreen } from './record/RecordScreen.js';
import { ScenarioScreen } from './script/ScenarioScreen.js';
import { ShootLive } from './shoot/ShootLive.js';
import { ShootPrepare } from './shoot/ShootPrepare.js';
import { ThemesScreen } from './themes/ThemesScreen.js';
import { TimelineScreen } from './edit/TimelineScreen.js';
import { ReviewScreen } from './review/ReviewScreen.js';
import { parseRoute } from './route.js';
import type { Route } from './route.js';
import { SessionEnded, openSession, takeCodeFromUrl } from './session.js';
import { AppShell } from './shell/AppShell.js';
import { GalleryScreen } from './project/GalleryScreen.js';
import { Callout, EmptyState, LinkButton, Progress, TextArea, studioShell } from './ui-kit/index.js';
import './tokens.css';
import './base.css';
import './ui-kit/kit.css';
import './shell/shell.css';
import './screens.css';

function useRoute(): Route {
  const [route, set] = useState(() => parseRoute(location.hash));
  useEffect(() => {
    const on = () => set(parseRoute(location.hash));
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}

const TITLES: Record<Route['name'], string> = { projects: 'Welcome', project: 'Productions', group: 'Productions', location: 'Location', cast: 'Cast', readme: 'README', scenario: 'Scenario', run: 'Shoot', timeline: 'Timeline', comments: 'Comments', proposal: 'Proposal preview', review: 'Review report', library: 'Components', themes: 'Themes', record: 'Record', ui: 'UI gallery', setup: 'Set up', 'not-found': 'Not found' };

function Studio() {
  const route = useRoute();
  const [list, reloadList] = useProjectList({}, 'all');
  const connection = useConnection();
  useEffect(() => guardUnload(), []);
  // L5.2b: what the tab holds unsaved, for the desktop app's quit question (kinds and names only).
  useEffect(() => startUnsavedReport(), []);
  // A project added, removed or changed on disk (or a reconnection): the list and the sidebar read it again — not a
  // step of a take (L5.10a fixes: nothing the list holds changed; the shell re-rendered at every step).
  useEvents((e) => {
    if ((e.type === 'workspace' && e.projects.length > 0 && !onlyRunProgress(e)) || e.type === 'resync') reloadList();
  });
  const first = useRef(true);
  useEffect(() => {
    document.title = `${route.name === 'themes' && route.theme ? `${route.theme} · ` : ''}${route.name === 'scenario' || route.name === 'run' || route.name === 'timeline' || route.name === 'comments' || route.name === 'proposal' || route.name === 'review' ? `${route.scenario} · ` : ''}${TITLES[route.name]} · ${APP_NAME}`;
    // Back on the projects: read them again (the first load is useCall's own).
    if (route.name === 'projects' && !first.current) reloadList();
    first.current = false;
  }, [route, reloadList]);
  if (connection === 'ended') return <Ended />;
  return (
    <AppShell route={route} list={list}>
      {(route.name === 'projects' || route.name === 'setup') && <WelcomeScreen list={list} />}
      {(route.name === 'project' || route.name === 'group' || route.name === 'location') && (
        // One element for the three (keyed by the project): a smart group or a location keeps the search and the selection.
        <ProductionsScreen key={route.slug} slug={route.slug} {...(route.name === 'group' ? { group: route.group } : {})} {...(route.name === 'location' ? { env: route.env } : {})} />
      )}
      {route.name === 'cast' && <CastScreen key={route.slug} slug={route.slug} />}
      {route.name === 'readme' && <ReadmeEditor key={route.slug} slug={route.slug} />}
      {route.name === 'scenario' && <ScenarioScreen key={`${route.slug}/${route.scenario}`} slug={route.slug} name={route.scenario} tab={route.tab} />}
      {route.name === 'run' && !route.run && <ShootPrepare key={`${route.slug}/${route.scenario}`} slug={route.slug} name={route.scenario} />}
      {route.name === 'run' && route.run && <ShootLive key={`${route.slug}/${route.scenario}/${route.run}`} slug={route.slug} name={route.scenario} runId={route.run} />}
      {route.name === 'timeline' && (
        <TimelineScreen key={`${route.slug}/${route.scenario}`} slug={route.slug} name={route.scenario} {...(route.run ? { run: route.run } : {})} {...(route.step ? { step: route.step } : {})} />
      )}
      {route.name === 'proposal' && (
        <TimelineScreen key={`${route.slug}/${route.scenario}/proposal/${route.thread}/${route.entry}`} slug={route.slug} name={route.scenario} proposal={{ comment_id: route.thread, entry_id: route.entry }} />
      )}
      {route.name === 'review' && <ReviewScreen key={`${route.slug}/${route.scenario}`} slug={route.slug} name={route.scenario} {...(route.render ? { render: route.render } : {})} />}
      {route.name === 'comments' && (
        <CommentsScreen key={`${route.slug}/${route.scenario}`} slug={route.slug} name={route.scenario} {...(route.thread ? { thread: route.thread } : {})} {...(route.at ? { at: route.at } : {})} />
      )}
      {route.name === 'library' && <LibraryScreen key={route.slug} slug={route.slug} {...(route.theme ? { theme: route.theme } : {})} {...(route.component ? { component: route.component } : {})} />}
      {route.name === 'themes' && <ThemesScreen key={route.slug} slug={route.slug} {...(route.theme ? { theme: route.theme } : {})} />}
      {route.name === 'record' && <RecordScreen key={route.slug} slug={route.slug} {...(route.rec ? { rec: route.rec } : {})} />}
      {route.name === 'ui' && <GalleryScreen />}
      {route.name === 'not-found' && (
        <div className="sc-screen">
          <EmptyState level={1} title="Nothing here" actions={<LinkButton to={{ name: 'projects' }}>Back to the projects</LinkButton>}>
            This address is not a place of the Studio.
          </EmptyState>
        </div>
      )}
    </AppShell>
  );
}

/**
 * The session ended (the server restarted or stopped answering this tab's token). Unsaved text (a README, a scenario's YAML) stays on screen,
 * read-only, to copy into the new session (review B H1: the editor is gone, the text must not go with it); closing the
 * tab still asks first while there is some. L5.12d: on the kit (Callout, read-only TextArea), as are Connecting, the
 * start error and the not-found screen.
 */
function Ended() {
  const drafts = dirtyDrafts();
  return (
    <main className="sc-ended" data-testid="session-ended">
      <h1 className="sc-h1">{APP_NAME}</h1>
      <Callout state="warn" role="alert" title="This Studio session ended">
        <p className="sc-ended-p">
          Run <code className="k-mono">retake ui</code> again in a terminal: it opens a new session. A Studio link works once, in one tab.
        </p>
      </Callout>
      {drafts.length > 0 && (
        <section className="sc-ended-drafts" aria-labelledby="kept-h" data-testid="unsaved-drafts">
          <h2 id="kept-h" className="sc-h2">
            Your unsaved text
          </h2>
          <p className="sc-ended-p">It was not saved. Copy it before you close this tab, then paste it into the editor of the new session.</p>
          {drafts.map((d) => (
            <TextArea key={d.key} label={<Txt text={d.label} />} value={d.text} onChange={keep} unsaved={null} readOnly mono rows={10} testId="unsaved-draft" />
          ))}
        </section>
      )}
    </main>
  );
}

/** A kept draft is read-only: nothing to change. */
const keep = () => undefined;

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
      <main className="sc-ended" data-testid="session-error">
        <h1 className="sc-h1">{APP_NAME}</h1>
        <Callout state="fail" role="alert" title="The Studio could not start">
          <Txt text={boot.message} />
        </Callout>
      </main>
    );
  }
  if (boot.kind === 'loading') {
    return (
      <main className="sc-ended" data-testid="session-connecting">
        <h1 className="sc-h1">{APP_NAME}</h1>
        <Progress label="Connecting…" />
      </main>
    );
  }
  return <Studio />;
}

// Under the desktop app's overlay title bar (DESIGN §4j): the title bar keeps the window buttons' room.
if (studioShell()?.titleBar === 'overlay') document.documentElement.dataset.titlebar = 'overlay';

const code = takeCodeFromUrl();
const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App code={code} />
    </StrictMode>,
  );
}
