/**
 * L5.9: the Studio's shell (DESIGN §4k, docs/reference/studio-ui.md) — a fixed window of panes: the title bar (the app,
 * the project › scenario, the mode switch Script · Shoot · Edit · Review centred, the screen's context control, the
 * inspector toggle), the browser on the left (the projects of the workspace and the open one's pages; the workspace,
 * version and worker at its foot), the centre pane (the current screen: the one scroller), the inspector on the right
 * (only while a screen fills it), the status bar (the connection and its live updates, the worker, a line for what a
 * command answers, the screen's actions). Built from the kit only (a lint). DOM order is Tab order: Skip to content,
 * title bar, browser, centre, inspector, status bar.
 * Commands: the palette (⌘K), the modes (⌘1 – 4) and the inspector (⌥⌘I) come from the desktop app's menu as
 * `studio:command` events (ids of MENU_COMMANDS only); in a browser tab the page binds ⌘K itself on a Mac (Ctrl+K
 * elsewhere, outside a text field: review B-L3) and nothing else (the browser keeps its own keys). While a modal dialog
 * is open the shell's commands wait (critique M5).
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import type { AuthStatus, ProjectBoardView, ProjectSummary, ProjectView } from '@demo-studio/engine';
import { call, useConnection } from '../api.js';
import type { Connection, Loaded } from '../api.js';
import { Txt } from '../bits.js';
import { APP_NAME } from '../brand.js';
import { readmeKey, useDirty } from '../drafts.js';
import { useEventMode, useEvents } from '../events.js';
import type { EventMode } from '../events.js';
import { hrefTo } from '../route.js';
import type { Route } from '../route.js';
import { Button, CommandPalette, COMMAND_EVENT, IconButton, Menu, SegmentedLinks, SourceList, StatusBar, StatusMark, isMenuCommand, modalOpen, studioShell } from '../ui-kit/index.js';
import type { Command, MarkState, MenuCommand, SourceGroup, SourceItem } from '../ui-kit/index.js';
import { BOARD_GROUPS, GROUP_LABEL, castState, envFlagWord, groupCounts } from '../board-words.js';
import { useBoard, useCast, useProjectDataEvents, useProjectView } from '../project-data.js';
import { MODES, contextWatch, modeOf, modeTarget, scenarioInContext, screenKey, slugOf } from './modes.js';
import type { Mode } from './modes.js';
import { SlotContext } from './slots.js';
import type { SlotHost, SlotName } from './slots.js';

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

const CONNECTION: Record<Connection, { word: string; state: MarkState }> = {
  connecting: { word: 'Connecting…', state: 'running' },
  online: { word: 'Connected', state: 'ok' },
  offline: { word: 'Not connected', state: 'fail' },
  ended: { word: 'Session ended', state: 'idle' },
};
const UPDATES: Record<EventMode, string> = { connecting: '', stream: 'live updates', relay: 'live updates', polling: 'updates every 3 s', off: '' };
const MODE_COMMAND: Record<Mode, MenuCommand> = { script: 'mode-script', shoot: 'mode-shoot', edit: 'mode-edit', review: 'mode-review' };

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

/** A Mac (its shortcuts use ⌘; Ctrl+K edits text there). */
const MAC = typeof navigator !== 'undefined' && /^(?:mac|iphone|ipad)/i.test((navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform);

/** A field that takes typed text (its own Ctrl+K, if any, stays its own). */
function inTextField(t: EventTarget | null): boolean {
  return t instanceof HTMLElement && (t.isContentEditable || t.matches('textarea, select, input:not([type="button"], [type="checkbox"], [type="radio"], [type="submit"], [type="reset"], [type="image"], [type="color"], [type="file"], [type="range"])'));
}

const PROJECT_ROUTES = new Set<Route['name']>(['project', 'group', 'location', 'cast', 'readme', 'scenario', 'run', 'timeline', 'comments', 'proposal', 'library', 'themes', 'record']);

interface OpenProject {
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
          current: route.name === 'projects',
          className: 'nav-link',
          childrenLabel: 'Projects of the workspace',
          children: projects.map((p) => ({ key: p.slug, to: { name: 'project', slug: p.slug }, label: <Txt text={p.name} />, current: false, className: 'nav-link', ...(p.error ? { flag: 'does not load' } : {}) })),
        },
      ],
    },
  ];
}

/**
 * L5.10a: an open project's browser (B32): Productions and its smart groups, the Library, the Locations (environments
 * with their flags in words), the Cast (each persona's session: a shape and a word), the Project's README and Record.
 */
function projectTree(route: Route, slug: string, d: OpenProject, readmeDirty: boolean): SourceGroup[] {
  const board = d.board.state === 'ready' ? d.board.data : null;
  const view = d.view.state === 'ready' ? d.view.data : null;
  const counts = board ? groupCounts(board.scenarios) : null;
  const total = board ? (board.truncated?.total ?? board.scenarios.length) : view?.scenarios.length;
  const row = (key: string, to: Route, label: ReactNode, current: boolean, extra: Partial<SourceItem> = {}): SourceItem => ({ key, to, label, current, className: 'nav-link', ...extra });
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
      items: [row('library', { name: 'library', slug }, 'Components', route.name === 'library', { icon: 'components', testId: 'library-link' }), row('themes', { name: 'themes', slug }, 'Themes', route.name === 'themes', { icon: 'theme' })],
    },
    {
      key: 'locations',
      heading: 'Locations',
      label: 'Locations',
      items: view
        ? view.environments.map((e) => {
            const flags = envFlagWord(e, e.name === view.default_env);
            return row(`loc-${e.name}`, { name: 'location', slug, env: e.name }, <Txt text={e.name} />, route.name === 'location' && route.env === e.name, { icon: 'location', ...(flags ? { flag: flags } : {}) });
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
            // Several locations: each one under its persona's name, on a line that wraps (review B-L1: never cut off).
            return row(`p-${p.env}-${p.persona}`, { name: 'cast', slug }, <Txt text={p.persona} />, false, { quiet: true, flag: <StatusMark state={c.state} word={c.word} />, ...(manyEnvs ? { detail: <Txt text={p.env} /> } : {}) });
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

export function AppShell({ route, list, children }: { route: Route; list: Loaded<ProjectList>; children: ReactNode }) {
  const connection = useConnection();
  const updates = useEventMode();
  const info = useEngineInfo();
  const main = useRef<HTMLElement>(null);
  const projects = list.state === 'ready' ? list.data.projects : [];
  const openSlug = PROJECT_ROUTES.has(route.name) ? slugOf(route) : null;
  const readmeDirty = useDirty(readmeKey(openSlug ?? ''));
  const project = openSlug !== null ? projects.find((p) => p.slug === openSlug) : undefined;
  // L5.10a: the open project's shared reads (the browser and the screens read the same entries).
  // L5.10b (critique M2): no board read behind a scenario screen (its browser shows the scenes, not the smart groups).
  const open: OpenProject = { view: useProjectView(openSlug), board: useBoard(route.name === 'scenario' ? null : openSlug), cast: useCast(openSlug) };
  useProjectDataEvents(openSlug);
  useSyncExternalStore(contextWatch.subscribe, contextWatch.version);
  const ctx = scenarioInContext(route, undefined, project?.scenarios);
  const mode = modeOf(route, ctx);
  const inApp = useMemo(() => studioShell() !== null, []);

  // The centre pane scrolls back to the top when the screen changes, not when a screen moves inside itself (M2).
  const key = screenKey(route);
  const firstScreen = useRef(true);
  useEffect(() => {
    main.current?.scrollTo?.(0, 0);
    if (firstScreen.current) {
      firstScreen.current = false;
      return;
    }
    // A new screen whose old one took the focused control with it (a link, a palette command): the focus lands on the
    // centre pane, not the document (review A-L6). The first screen of a load leaves it alone (Tab starts at the top).
    if (!document.activeElement || document.activeElement === document.body) main.current?.focus({ preventScroll: true });
  }, [key]);

  // Slots: the panes a screen fills.
  const [targets, setTargets] = useState<Partial<Record<SlotName, HTMLElement | null>>>({});
  const [claims, setClaims] = useState<Record<SlotName, number>>({ inspector: 0, context: 0, actions: 0, browser: 0 });
  const claim = useCallback((name: SlotName) => {
    setClaims((c) => ({ ...c, [name]: c[name] + 1 }));
    return () => setClaims((c) => ({ ...c, [name]: c[name] - 1 }));
  }, []);
  // One stable ref callback per slot (a new function each render would detach and re-attach it every time).
  const slotRefs = useMemo(() => {
    const at = (name: SlotName) => (el: HTMLElement | null) => setTargets((t) => (t[name] === el ? t : { ...t, [name]: el }));
    return { inspector: at('inspector'), context: at('context'), actions: at('actions'), browser: at('browser') };
  }, []);
  const hasInspector = claims.inspector > 0;
  const [inspectorOff, setInspectorOff] = useState(false);
  const inspectorShown = hasInspector && !inspectorOff;
  const host = useMemo<SlotHost>(() => ({ targets, claim, hidden: { inspector: inspectorOff } }), [targets, claim, inspectorOff]);
  const inspector = useRef<HTMLElement>(null);
  /** Shows or hides the inspector; hiding it with the focus inside moves the focus to the centre pane (review A-L6). */
  const toggleInspector = useCallback(() => {
    if (inspector.current?.contains(document.activeElement)) main.current?.focus({ preventScroll: true });
    setInspectorOff((v) => !v);
  }, []);

  // What a command answers when it cannot act (a polite line in the status bar).
  const [said, setSaid] = useState('');
  const say = useCallback((s: string) => {
    setSaid('');
    window.setTimeout(() => setSaid(s), 30);
  }, []);
  const [palette, setPalette] = useState(false);

  const run = useCallback(
    (id: MenuCommand) => {
      if (modalOpen()) {
        // A modal waits for its answer; the palette's own ⌘K closes it.
        if (id === 'palette' && palette) setPalette(false);
        return;
      }
      if (id === 'palette') setPalette(true);
      else if (id === 'inspector') {
        if (hasInspector) toggleInspector();
        else say('This screen has no inspector');
      } else {
        const m = (Object.keys(MODE_COMMAND) as Mode[]).find((k) => MODE_COMMAND[k] === id)!;
        if (ctx) location.hash = hrefTo(modeTarget(m, ctx));
        else say('Open a scenario first');
      }
    },
    [ctx, hasInspector, palette, say, toggleInspector],
  );

  // The desktop app's menu sends commands; a browser tab binds ⌘K / Ctrl+K only.
  useEffect(() => {
    const onCommand = (e: Event) => {
      const id = (e as CustomEvent<{ id?: unknown } | null>).detail?.id;
      if (isMenuCommand(id)) run(id);
    };
    window.addEventListener(COMMAND_EVENT, onCommand);
    const onKey = (e: KeyboardEvent) => {
      if (inApp || e.isComposing || e.altKey || e.shiftKey || e.key.toLowerCase() !== 'k') return;
      // ⌘K on a Mac — never Ctrl+K there (a text field's "delete to the end of the line"); Ctrl+K elsewhere, outside a
      // text field (review B-L3).
      if (MAC ? !e.metaKey || e.ctrlKey : !e.ctrlKey || e.metaKey || inTextField(e.target)) return;
      // A modal waiting for its answer keeps the key (the browser's own ⌘K too), but the palette's own ⌘K closes it.
      if (modalOpen() && !document.querySelector('dialog.k-palette[open]')) return;
      e.preventDefault();
      run('palette');
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener(COMMAND_EVENT, onCommand);
      window.removeEventListener('keydown', onKey);
    };
  }, [run, inApp]);

  const commands = useMemo<Command[]>(() => {
    const go = (r: Route) => () => {
      location.hash = hrefTo(r);
    };
    const out: Command[] = [{ id: 'go-projects', label: 'All projects', hint: 'the Welcome screen', group: 'Go to', run: go({ name: 'projects' }) }];
    if (ctx) {
      for (const m of MODES) out.push({ id: `mode-${m.mode}`, label: m.label, hint: ctx.scenario, group: 'Go to', ...(inApp ? { kbd: ['⌘', String(MODES.indexOf(m) + 1)] } : {}), run: go(modeTarget(m.mode, ctx)) });
    }
    if (project) {
      const slug = project.slug;
      const pages: Array<[string, string, Route]> = [
        ['productions', 'Productions', { name: 'project', slug }],
        ...BOARD_GROUPS.map((g): [string, string, Route] => [`g-${g}`, GROUP_LABEL[g], { name: 'group', slug, group: g }]),
        ['library', 'Components', { name: 'library', slug }],
        ['themes', 'Themes', { name: 'themes', slug }],
        ['cast', 'Cast', { name: 'cast', slug }],
        ['readme', 'README', { name: 'readme', slug }],
        ['record', 'Record a scenario', { name: 'record', slug }],
      ];
      if (open.view.state === 'ready') for (const e of open.view.data.environments) pages.push([`loc-${e.name}`, `Location ${e.name}`, { name: 'location', slug, env: e.name }]);
      for (const [id, label, r] of pages) out.push({ id: `page-${id}`, label, hint: project.name, group: 'Go to', run: go(r) });
      for (const name of project.scenarios) out.push({ id: `open-${name}`, label: `Open ${name}`, hint: 'scenario', group: 'Scenarios', run: go({ name: 'scenario', slug, scenario: name, tab: 'blocks' }) });
    }
    for (const p of projects) out.push({ id: `project-${p.slug}`, label: p.name, hint: 'project', group: 'Projects', run: go({ name: 'project', slug: p.slug }) });
    out.push({ id: 'go-ui', label: 'UI gallery', hint: 'every component of the design system', group: 'Go to', run: go({ name: 'ui' }) });
    if (hasInspector) out.push({ id: 'inspector', label: inspectorOff ? 'Show inspector' : 'Hide inspector', group: 'Commands', ...(inApp ? { kbd: ['⌥', '⌘', 'I'] } : {}), run: toggleInspector });
    return out;
  }, [ctx, project, projects, hasInspector, inspectorOff, inApp, toggleInspector, open.view]);

  const conn = CONNECTION[connection];
  return (
    <SlotContext.Provider value={host}>
      <div className="sh-app" data-inspector={inspectorShown ? 'shown' : 'none'}>
        <div className="sh-skip">
          <Button size="sm" onClick={() => main.current?.focus()}>
            Skip to content
          </Button>
        </div>
        <header className="sh-titlebar">
          <div className="sh-titlebar-start">
            <span className="sh-appmark" aria-hidden="true" />
            <span className="sh-appname">{APP_NAME}</span>
            {project && (
              <span className="sh-crumbs">
                <span className="sh-crumb-sep" aria-hidden="true">
                  ›
                </span>
                <Menu
                  label="Projects"
                  text={<Txt text={project.name} />}
                  items={[...projects.map((p) => ({ id: `p:${p.slug}`, label: p.name })), 'separator', { id: 'all', label: 'All projects' }]}
                  onSelect={(id) => {
                    location.hash = hrefTo(id === 'all' ? { name: 'projects' } : { name: 'project', slug: id.slice(2) });
                  }}
                />
                {ctx && 'scenario' in route && (
                  <>
                    <span className="sh-crumb-sep" aria-hidden="true">
                      ›
                    </span>
                    <Txt className="sh-crumb-current" text={ctx.scenario} title={ctx.scenario} />
                  </>
                )}
              </span>
            )}
          </div>
          <div className="sh-titlebar-centre">
            <SegmentedLinks label="Mode" hint="Open a scenario to choose a mode" items={MODES.map((m) => ({ key: m.mode, label: m.label, to: ctx ? modeTarget(m.mode, ctx) : null, current: mode === m.mode }))} />
          </div>
          <div className="sh-titlebar-end">
            <div className="sh-slot-context" ref={slotRefs.context} />
            {hasInspector && <IconButton icon="inspector" label="Inspector" pressed={inspectorShown} onClick={toggleInspector} />}
          </div>
        </header>
        <aside className="sh-browser sidebar" aria-label="Browser">
          {claims.browser === 0 && <SourceList label="Studio" groups={openSlug !== null ? projectTree(route, openSlug, open, readmeDirty) : workspaceTree(route, projects)} />}
          <div className="sh-slot-browser" ref={slotRefs.browser} hidden={claims.browser === 0} />
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
        <main id="main" ref={main} className="sh-main" tabIndex={-1}>
          {children}
        </main>
        <aside ref={inspector} className="sh-inspector" aria-label="Inspector" hidden={!inspectorShown}>
          <h2 className="k-sr">Inspector</h2>
          <div className="sh-slot-inspector" ref={slotRefs.inspector} />
        </aside>
        <div className="sh-statusbar-wrap">
          <StatusBar
            state={
              <span className="sh-connection" data-testid="connection" data-updates={updates}>
                <StatusMark state={conn.state} word={conn.word} />
                {info && <span>{info.worker ? ' · worker running' : ' · worker idle'}</span>}
                {connection === 'online' && UPDATES[updates] && <span> · {UPDATES[updates]}</span>}
              </span>
            }
            info={
              <span role="status" className="sh-said">
                {said}
              </span>
            }
            actions={<div className="sh-slot-actions" ref={slotRefs.actions} />}
          />
        </div>
        <CommandPalette open={palette} onClose={() => setPalette(false)} commands={commands} />
      </div>
    </SlotContext.Provider>
  );
}
