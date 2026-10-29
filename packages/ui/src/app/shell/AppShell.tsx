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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { ProjectSummary } from '@demo-studio/engine';
import { call, useConnection } from '../api.js';
import type { Connection, Loaded } from '../api.js';
import { Txt } from '../bits.js';
import { APP_NAME } from '../brand.js';
import { readmeKey, useDirty } from '../drafts.js';
import { useEventMode, useEvents } from '../events.js';
import type { EventMode } from '../events.js';
import { hrefTo } from '../route.js';
import type { Route } from '../route.js';
import { Button, CommandPalette, COMMAND_EVENT, IconButton, LinkButton, SegmentedLinks, SourceList, StatusBar, StatusMark, isMenuCommand, modalOpen, studioShell } from '../ui-kit/index.js';
import type { Command, MarkState, MenuCommand, SourceItem } from '../ui-kit/index.js';
import { MODES, modeOf, modeTarget, scenarioInContext, screenKey, slugOf } from './modes.js';
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

const PROJECT_ROUTES = new Set<Route['name']>(['project', 'readme', 'scenario', 'run', 'timeline', 'comments', 'proposal', 'library', 'themes', 'record']);

/** The browser's items: Projects, the projects of the workspace, and the open one's pages. */
function browserItems(route: Route, projects: ProjectSummary[], readmeDirty: boolean): SourceItem[] {
  const open = PROJECT_ROUTES.has(route.name) ? slugOf(route) : null;
  const page = (key: string, to: Route, label: string, current: boolean, flag?: ReactNode): SourceItem => ({ key, to, label, current, className: 'nav-link', ...(flag ? { flag } : {}) });
  return [
    {
      key: 'projects',
      to: { name: 'projects' },
      label: 'Projects',
      current: route.name === 'projects',
      className: 'nav-link',
      childrenLabel: 'Projects of the workspace',
      children: projects.map((p) => ({
        key: p.slug,
        to: { name: 'project', slug: p.slug },
        label: <Txt text={p.name} />,
        // Open, its Overview child is the current page (one aria-current: review A-L9).
        current: false,
        className: 'nav-link',
        ...(p.error ? { flag: 'does not load' } : {}),
        ...(open === p.slug
          ? {
              children: [
                page('overview', { name: 'project', slug: p.slug }, 'Overview', route.name === 'project'),
                page('readme', { name: 'readme', slug: p.slug }, 'README', route.name === 'readme', readmeDirty ? 'unsaved' : undefined),
                page('library', { name: 'library', slug: p.slug }, 'Components', route.name === 'library'),
                page('themes', { name: 'themes', slug: p.slug }, 'Themes', route.name === 'themes'),
                page('record', { name: 'record', slug: p.slug }, 'Record', route.name === 'record'),
              ],
            }
          : {}),
      })),
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
  const [claims, setClaims] = useState<Record<SlotName, number>>({ inspector: 0, context: 0, actions: 0 });
  const claim = useCallback((name: SlotName) => {
    setClaims((c) => ({ ...c, [name]: c[name] + 1 }));
    return () => setClaims((c) => ({ ...c, [name]: c[name] - 1 }));
  }, []);
  const host = useMemo<SlotHost>(() => ({ targets, claim }), [targets, claim]);
  // One stable ref callback per slot (a new function each render would detach and re-attach it every time).
  const slotRefs = useMemo(() => {
    const at = (name: SlotName) => (el: HTMLElement | null) => setTargets((t) => (t[name] === el ? t : { ...t, [name]: el }));
    return { inspector: at('inspector'), context: at('context'), actions: at('actions') };
  }, []);
  const hasInspector = claims.inspector > 0;
  const [inspectorOff, setInspectorOff] = useState(false);
  const inspectorShown = hasInspector && !inspectorOff;
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
    const out: Command[] = [{ id: 'go-projects', label: 'Projects', group: 'Go to', run: go({ name: 'projects' }) }];
    if (ctx) {
      for (const m of MODES) out.push({ id: `mode-${m.mode}`, label: m.label, hint: ctx.scenario, group: 'Go to', ...(inApp ? { kbd: ['⌘', String(MODES.indexOf(m) + 1)] } : {}), run: go(modeTarget(m.mode, ctx)) });
    }
    if (project) {
      for (const [id, label, r] of [
        ['overview', 'Overview', { name: 'project', slug: project.slug }],
        ['readme', 'README', { name: 'readme', slug: project.slug }],
        ['library', 'Components', { name: 'library', slug: project.slug }],
        ['themes', 'Themes', { name: 'themes', slug: project.slug }],
        ['record', 'Record', { name: 'record', slug: project.slug }],
      ] as Array<[string, string, Route]>) {
        out.push({ id: `page-${id}`, label, hint: project.name, group: 'Go to', run: go(r) });
      }
    }
    for (const p of projects) out.push({ id: `project-${p.slug}`, label: p.name, hint: 'project', group: 'Projects', run: go({ name: 'project', slug: p.slug }) });
    out.push({ id: 'go-ui', label: 'UI gallery', hint: 'every component of the design system', group: 'Go to', run: go({ name: 'ui' }) });
    if (hasInspector) out.push({ id: 'inspector', label: inspectorOff ? 'Show inspector' : 'Hide inspector', group: 'Commands', ...(inApp ? { kbd: ['⌥', '⌘', 'I'] } : {}), run: toggleInspector });
    return out;
  }, [ctx, project, projects, hasInspector, inspectorOff, inApp, toggleInspector]);

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
                <LinkButton to={{ name: 'project', slug: project.slug }} variant="ghost" size="sm">
                  <Txt text={project.name} />
                </LinkButton>
                {ctx && 'scenario' in route && (
                  <>
                    <span className="sh-crumb-sep" aria-hidden="true">
                      ›
                    </span>
                    <Txt className="sh-crumb-current" text={ctx.scenario} />
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
          <SourceList label="Studio" groups={[{ key: 'studio', items: browserItems(route, projects, readmeDirty) }]} />
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
