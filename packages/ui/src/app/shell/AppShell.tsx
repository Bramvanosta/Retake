/**
 * The Studio's shell (DESIGN §4k, docs/reference/studio-ui.md) — a fixed window of panes: the title bar (the app,
 * the project › scenario, the mode switch Script · Shoot · Edit · Review centred, the screen's context control, the
 * inspector toggle), the browser on the left (the projects of the workspace and the open one's pages; the workspace,
 * version and worker at its foot), the centre pane (the current screen: the one scroller), the inspector on the right
 * (only while a screen fills it), the status bar (the connection and its live updates, the worker, a line for what a
 * command answers, the screen's actions). Built from the kit only (a lint). DOM order is Tab order: Skip to content,
 * title bar, browser, centre, inspector, status bar.
 * Commands: the palette (⌘K), the modes (⌘1 – 4) and the inspector (⌥⌘I) come from the desktop app's menu as
 * `studio:command` events (ids of MENU_COMMANDS only); in a browser tab the page binds ⌘K itself on a Mac (Ctrl+K
 * elsewhere, outside a text field) and nothing else (the browser keeps its own keys). While a modal dialog
 * is open the shell's commands wait — but Stop (⌘.), which closes the palette and acts.
 * The status bar's actions for the scenario in context (StatusActions.tsx: its state, Rehearse, Capture, Render,
 * Pause / Stop, the confirmation sheet) — the default owner of the Scenario menu's commands (Rehearse ⌘R, Capture ⇧⌘R,
 * Render ⌘B, Stop ⌘. from the app's menu; the palette's Scenario group in a browser tab, which binds none of the four),
 * routed through the command bus (command-bus.ts: a screen or a live recording outranks the defaults by priority).
 * In the desktop app, the quit question as a kit Sheet (QuitSheet.tsx: `studio:quit`, answered through
 * `desktop_answer`); a browser tab has none (only the app's window is ever asked). In the app's window, the
 * update's button in the status bar and its sheet (UpdateSheet.tsx).
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import type { HeldWork, ProjectSummary, ProjectView } from '@retake/engine';
import { useConnection } from '../api.js';
import type { Connection, Loaded } from '../api.js';
import { engineInfo } from '../data/projects.js';
import type { EngineInfoAnswer, ProjectList } from '../data/ops.js';
import { Txt } from '../bits.js';
import { APP_NAME } from '../brand.js';
import { readmeKey, useDirty } from '../drafts.js';
import { useEventMode, useEvents } from '../events.js';
import type { EventMode } from '../events.js';
import { heldShortWords, heldWords } from '../words/render-words.js';
import { hrefTo } from '../route.js';
import type { Route } from '../route.js';
import { AppMark, Button, CommandPalette, IconButton, Menu, SegmentedLinks, StatusBar, StatusMark, studioShell } from '../ui-kit/index.js';
import type { Command, IconName, MarkState } from '../ui-kit/index.js';
import { BOARD_GROUPS, GROUP_LABEL } from '../words/board-words.js';
import { useBoard, useCast, useProjectDataEvents, useProjectView } from '../project-data.js';
import { paletteGroup, runShellCommand } from './command-bus.js';
import type { PaletteSlot } from './command-bus.js';
import type { ShellCommand } from './command-bus.js';
import { MODES, contextWatch, modeOf, modeTarget, noteReviewView, scenarioInContext, screenKey, slugOf } from './modes.js';
import type { Mode, ScenarioContext } from './modes.js';
import { SlotContext } from './slots.js';
import { useStatusActions } from './StatusActions.js';
import { QuitSheet } from './QuitSheet.js';
import { SetupSheet } from './SetupSheet.js';
import { UpdateControl } from './UpdateSheet.js';
import { BrowserPane } from './browser-pane.js';
import type { OpenProject } from './browser-pane.js';
import { useMenuCommands } from './menu-commands.js';
import type { CommandInput } from './menu-commands.js';
import { useHeld, useSaid, useScreenTop, useSlots } from './shell-hooks.js';

const CONNECTION: Record<Connection, { word: string; state: MarkState }> = {
  connecting: { word: 'Connecting…', state: 'running' },
  online: { word: 'Connected', state: 'ok' },
  offline: { word: 'Not connected', state: 'fail' },
  ended: { word: 'Session ended', state: 'idle' },
};
const UPDATES: Record<EventMode, string> = { connecting: '', stream: 'live updates', relay: 'live updates', polling: 'updates every 3 s', off: '' };
const MODE_ICON: Record<Mode, IconName> = { script: 'report', shoot: 'record', edit: 'film', review: 'check' };
/** The Scenario menu's commands in the palette (a browser tab binds none of their keys). */
const SCENARIO_COMMANDS: Array<{ id: ShellCommand; label: string; kbd: string[]; icon: IconName }> = [
  { id: 'rehearse', label: 'Rehearse', kbd: ['⌘', 'R'], icon: 'play' },
  { id: 'capture', label: 'Capture', kbd: ['⇧', '⌘', 'R'], icon: 'record' },
  { id: 'render', label: 'Render', kbd: ['⌘', 'B'], icon: 'export' },
  { id: 'stop', label: 'Stop', kbd: ['⌘', '.'], icon: 'stop' },
];
/**
 * The palette's groups, in this order — Commands (the Scenario menu's, or a live recording's own;
 * Review's "Comment at this frame"; the inspector), Go to (the modes, the Review report, the project's pages, the
 * workspace), Scenes (the screen's scenes), Themes (the theme set for the scenario shown, the project's, all themes),
 * Scenarios, Projects. An entry goes somewhere or selects something; it never writes (a test counts the ops).
 */
const PALETTE_GROUPS = ['Commands', 'Go to', 'Scenes', 'Themes', 'Scenarios', 'Projects'] as const;

/**
 * Worker state and version: `engine_info` now, when a job the page never saw appears (a new job may start a worker), on a
 * reconnection and every 15 s (an idle worker exits quietly). A job rewritten at each step of its run is not a worker
 * change: no re-read (17 reads in 30 s of a run before).
 */
function useEngineInfo(): EngineInfoAnswer | null {
  const [v, set] = useState<EngineInfoAnswer | null>(null);
  const [tick, setTick] = useState(0);
  const seen = useRef(new Set<string>());
  useEvents((e) => {
    if (e.type === 'resync') setTick((t) => t + 1);
    else if (e.type === 'jobs') {
      const fresh = e.changed.filter((id) => !seen.current.has(id));
      for (const id of fresh) seen.current.add(id);
      if (fresh.length > 0) setTick((t) => t + 1);
    }
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: `tick` (a resync or a new job) is the trigger to read the engine info again
  useEffect(() => {
    let live = true;
    const load = () =>
      engineInfo().then(
        (d) => live && set(d),
        () => undefined,
      );
    load();
    const t = window.setInterval(load, 15_000);
    return () => {
      live = false;
      window.clearInterval(t);
    };
  }, [tick]);
  return v;
}

const PROJECT_ROUTES = new Set<Route['name']>(['project', 'group', 'location', 'cast', 'readme', 'scenario', 'run', 'timeline', 'comments', 'proposal', 'review', 'library', 'themes', 'record']);

interface PaletteInput extends CommandInput {
  project: ProjectSummary | undefined;
  projects: ProjectSummary[];
  inspectorOff: boolean;
  view: Loaded<ProjectView>;
}

/** The palette's entries, rebuilt when a screen adds or removes commands. */
function usePaletteCommands({ ctx, project, projects, hasInspector, inspectorOff, inApp, toggleInspector, view, say }: PaletteInput): Command[] {
  useSyncExternalStore(paletteGroup.subscribe, paletteGroup.version);
  const slotVersion = paletteGroup.version();
  // biome-ignore lint/correctness/useExhaustiveDependencies: the palette group's version is the trigger to rebuild the list when a screen adds or removes commands
  return useMemo<Command[]>(
    () => paletteCommands({ ctx, project, projects, hasInspector, inspectorOff, inApp, toggleInspector, view, say }),
    // slotVersion: a screen's group changed (the entries are read from the registry).
    [ctx, project, projects, hasInspector, inspectorOff, inApp, toggleInspector, view, say, slotVersion],
  );
}

/** The palette's entries, in PALETTE_GROUPS order: the screens' groups read from the registry, the rest from the context. */
function paletteCommands({ ctx, project, projects, hasInspector, inspectorOff, inApp, toggleInspector, view, say }: PaletteInput): Command[] {
  const go = (r: Route) => () => {
    location.hash = hrefTo(r);
  };
  const screen = (slot: PaletteSlot) => paletteGroup.get(slot);
  const out: Command[] = [];
  const add = (group: (typeof PALETTE_GROUPS)[number], c: Omit<Command, 'group'>) => out.push({ ...c, group });
  // Commands. A live recording's own entries (Stop recording, Discard…, named after
  // it) take the Scenario menu's place — with or without a scenario in context, never naming that scenario.
  const recording = screen('scenario');
  if (recording)
    for (const c of recording)
      add('Commands', { id: c.id, label: c.label, ...(c.hint ? { hint: c.hint } : {}), icon: c.icon ?? 'record', ...(inApp && c.id === 'record-stop' ? { kbd: ['⌘', '.'] } : {}), run: c.run });
  // The Scenario menu (the palette closes as it runs: the bus, not the modal-waiting `run`).
  else if (ctx)
    for (const c of SCENARIO_COMMANDS)
      add('Commands', { id: c.id, label: c.label, hint: ctx.scenario, icon: c.icon, ...(inApp ? { kbd: c.kbd } : {}), run: () => void (runShellCommand(c.id) || say('Open a scenario first')) });
  for (const c of screen('review') ?? []) add('Commands', { id: c.id, label: c.label, ...(c.hint ? { hint: c.hint } : {}), icon: c.icon ?? 'plus', run: c.run });
  if (hasInspector)
    add('Commands', { id: 'inspector', label: inspectorOff ? 'Show inspector' : 'Hide inspector', icon: 'inspector', ...(inApp ? { kbd: ['⌥', '⌘', 'I'] } : {}), run: toggleInspector });
  // Go to: the modes, the Review report, the project's pages, the workspace.
  if (ctx)
    for (const m of MODES)
      add('Go to', {
        id: `mode-${m.mode}`,
        label: m.label,
        hint: ctx.scenario,
        icon: MODE_ICON[m.mode],
        ...(inApp ? { kbd: ['⌘', String(MODES.indexOf(m) + 1)] } : {}),
        run: go(modeTarget(m.mode, ctx)),
      });
  if (ctx) {
    // The report's entry with the last render's words when a screen holds the renders (never "passed": review-words).
    const report = screen('report')?.[0];
    add('Go to', {
      id: 'go-report',
      label: 'Review report',
      hint: report?.hint ?? ctx.scenario,
      icon: 'report',
      run: report ? report.run : go({ name: 'review', slug: ctx.slug, scenario: ctx.scenario }),
    });
  }
  if (project) {
    const slug = project.slug;
    const pages: Array<[string, string, Route, IconName]> = [
      ['productions', 'Productions', { name: 'project', slug }, 'film'],
      ...BOARD_GROUPS.map((g): [string, string, Route, IconName] => [`g-${g}`, GROUP_LABEL[g], { name: 'group', slug, group: g }, 'folder']),
      ['library', 'Components', { name: 'library', slug }, 'components'],
      ['cast', 'Cast', { name: 'cast', slug }, 'person'],
      ['readme', 'README', { name: 'readme', slug }, 'report'],
      ['record', 'Record a scenario', { name: 'record', slug }, 'record'],
    ];
    if (view.state === 'ready') for (const e of view.data.environments) pages.push([`loc-${e.name}`, `Location ${e.name}`, { name: 'location', slug, env: e.name }, 'location']);
    for (const [id, label, r, icon] of pages) add('Go to', { id: `page-${id}`, label, hint: project.name, icon, run: go(r) });
  }
  add('Go to', { id: 'go-projects', label: 'All projects', hint: 'the Welcome screen', icon: 'folder', run: go({ name: 'projects' }) });
  add('Go to', { id: 'go-ui', label: 'UI gallery', hint: 'every component of the design system', icon: 'components', run: go({ name: 'ui' }) });
  // Scenes: the screen's own (a pick or a seek).
  for (const c of screen('scenes') ?? []) add('Scenes', { id: c.id, label: c.label, ...(c.hint ? { hint: c.hint } : {}), icon: c.icon ?? 'scene', run: c.run });
  // Themes: the one set for the scenario shown (a screen's), the project's, every theme — each opens the theme editor.
  if (project) {
    const slug = project.slug;
    const seen = new Set<string>();
    for (const c of screen('themes') ?? []) {
      seen.add(c.id);
      add('Themes', { id: `theme-${c.id}`, label: c.label, ...(c.hint ? { hint: c.hint } : {}), icon: 'theme', run: c.run });
    }
    const own = view.state === 'ready' ? view.data.config.template : undefined;
    if (own && !seen.has(own)) add('Themes', { id: `theme-${own}`, label: own, hint: "the project's theme", icon: 'theme', run: go({ name: 'themes', slug, theme: own }) });
    add('Themes', { id: 'page-themes', label: 'All themes', hint: project.name, icon: 'theme', run: go({ name: 'themes', slug }) });
  }
  if (project)
    for (const name of project.scenarios)
      add('Scenarios', { id: `open-${name}`, label: `Open ${name}`, hint: 'scenario', icon: 'scene', run: go({ name: 'scenario', slug: project.slug, scenario: name, tab: 'blocks' }) });
  for (const p of projects) add('Projects', { id: `project-${p.slug}`, label: p.name, hint: 'project', icon: 'folder', run: go({ name: 'project', slug: p.slug }) });
  return PALETTE_GROUPS.flatMap((g) => out.filter((c) => c.group === g));
}

/** The title bar: the app, the project › scenario, the mode switch, the screen's context slot and the inspector toggle. */
function TitleBar({
  route,
  ctx,
  mode,
  project,
  projects,
  contextRef,
  hasInspector,
  inspectorShown,
  toggleInspector,
}: {
  route: Route;
  ctx: ScenarioContext | null;
  mode: Mode | null;
  project: ProjectSummary | undefined;
  projects: ProjectSummary[];
  contextRef: (el: HTMLElement | null) => void;
  hasInspector: boolean;
  inspectorShown: boolean;
  toggleInspector: () => void;
}) {
  return (
    <header className="sh-titlebar">
      <div className="sh-titlebar-start">
        <AppMark variant="tiny" size={18} />
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
        <SegmentedLinks
          label="Mode"
          hint="Open a scenario to choose a mode"
          items={MODES.map((m) => ({ key: m.mode, label: m.label, to: ctx ? modeTarget(m.mode, ctx) : null, current: mode === m.mode }))}
        />
      </div>
      <div className="sh-titlebar-end">
        <div className="sh-slot-context" ref={contextRef} />
        {hasInspector && <IconButton icon="inspector" label="Inspector" pressed={inspectorShown} onClick={toggleInspector} />}
      </div>
    </header>
  );
}

/** The status bar's state: the connection, the worker, what a take holds, the live updates, the app's update. */
function ShellState({ connection, updates, info, held, inApp }: { connection: Connection; updates: EventMode; info: EngineInfoAnswer | null; held: HeldWork | null; inApp: boolean }) {
  const conn = CONNECTION[connection];
  return (
    <span className="sh-connection" data-testid="connection" data-updates={updates}>
      <StatusMark state={conn.state} word={conn.word} />
      {info && <span>{info.worker ? ' · worker running' : ' · worker idle'}</span>}
      {held && (
        <span className="sh-seg" data-testid="held" data-held={held.state}>
          {' · '}
          {/* The long words, or at 1000 px and less their short form (shell.css). */}
          <span className="sh-held-long">{heldWords(held)}</span>
          <span className="sh-held-short">{heldShortWords(held)}</span>
        </span>
      )}
      {connection === 'online' && UPDATES[updates] && (
        <span className="sh-seg" data-drop="updates">
          {' · '}
          {UPDATES[updates]}
        </span>
      )}
      {inApp && <UpdateControl />}
    </span>
  );
}

export function AppShell({ route, list, children }: { route: Route; list: Loaded<ProjectList>; children: ReactNode }) {
  const connection = useConnection();
  const updates = useEventMode();
  const info = useEngineInfo();
  const held = useHeld(info);
  const main = useRef<HTMLElement>(null);
  const projects = list.state === 'ready' ? list.data.projects : [];
  const openSlug = PROJECT_ROUTES.has(route.name) ? slugOf(route) : null;
  const readmeDirty = useDirty(readmeKey(openSlug ?? ''));
  const project = openSlug !== null ? projects.find((p) => p.slug === openSlug) : undefined;
  // The open project's shared reads (the browser and the screens read the same entries).
  // No board read behind a scenario screen (its browser shows the scenes, not the smart groups).
  const open: OpenProject = { view: useProjectView(openSlug), board: useBoard(route.name === 'scenario' ? null : openSlug), cast: useCast(openSlug) };
  useProjectDataEvents(openSlug);
  useSyncExternalStore(contextWatch.subscribe, contextWatch.version);
  const ctx = scenarioInContext(route, undefined, project?.scenarios);
  noteReviewView(route);
  const mode = modeOf(route, ctx);
  const inApp = useMemo(() => studioShell() !== null, []);

  // The centre pane scrolls back to the top when the screen changes, not when a screen moves inside itself.
  const key = screenKey(route);
  // The screen a polite line was said on (read by `say`: a screen's own mount effect runs after this render) — a run's
  // live screen is another screen than Prepare (the same screenKey), a recording another than the start form.
  const saidKey = `${key}|${route.name === 'run' ? (route.run ?? '') : route.name === 'record' ? (route.rec ?? '') : ''}`;
  const keyNow = useRef(saidKey);
  keyNow.current = saidKey;
  useScreenTop(main, key);
  const { claims, slotRefs, collapsed, hasInspector, inspectorOff, inspectorShown, host, inspector, toggleInspector } = useSlots(main);
  const { said, say } = useSaid(keyNow, saidKey);
  const { palette, setPalette } = useMenuCommands({ ctx, hasInspector, say, toggleInspector, inApp });
  const commands = usePaletteCommands({ ctx, project, projects, hasInspector, inspectorOff, inApp, toggleInspector, view: open.view, say });
  // The scenario in context's state and actions (the buttons hide while a screen claims the slot).
  const shoot = useStatusActions({ route, ctx, say, claimed: claims.actions > 0, inApp });
  return (
    <SlotContext.Provider value={host}>
      <div className="sh-app" data-inspector={inspectorShown ? 'shown' : 'none'} data-browser={collapsed > 0 ? 'none' : 'shown'}>
        <div className="sh-skip">
          <Button size="sm" onClick={() => main.current?.focus()}>
            Skip to content
          </Button>
        </div>
        <TitleBar
          route={route}
          ctx={ctx}
          mode={mode}
          project={project}
          projects={projects}
          contextRef={slotRefs.context}
          hasInspector={hasInspector}
          inspectorShown={inspectorShown}
          toggleInspector={toggleInspector}
        />
        <BrowserPane
          route={route}
          list={list}
          projects={projects}
          openSlug={openSlug}
          open={open}
          readmeDirty={readmeDirty}
          info={info}
          claimed={claims.browser !== 0}
          collapsed={collapsed > 0}
          browserRef={slotRefs.browser}
        />
        <main id="main" ref={main} className="sh-main" tabIndex={-1}>
          {children}
        </main>
        <aside ref={inspector} className="sh-inspector" aria-label="Inspector" hidden={!inspectorShown}>
          <h2 className="k-sr">Inspector</h2>
          <div className="sh-slot-inspector" ref={slotRefs.inspector} />
        </aside>
        <div className="sh-statusbar-wrap">
          <StatusBar
            state={<ShellState connection={connection} updates={updates} info={info} held={held} inApp={inApp} />}
            info={
              <>
                {shoot.info}
                <span role="status" className="sh-said" data-testid="said">
                  {said && <Txt text={said} />}
                </span>
              </>
            }
            actions={
              <>
                <div className="sh-slot-actions" ref={slotRefs.actions} />
                {shoot.actions}
              </>
            }
          />
        </div>
        {shoot.overlay}
        <CommandPalette open={palette} onClose={() => setPalette(false)} commands={commands} {...(inApp ? { footnote: 'Commands with a key are also in the menu bar' } : {})} />
        {inApp && <QuitSheet />}
        {inApp && <SetupSheet route={route} />}
      </div>
    </SlotContext.Provider>
  );
}
