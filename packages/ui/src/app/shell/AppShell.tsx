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
 * is open the shell's commands wait (critique M5) — but Stop (⌘.), which closes the palette and acts (L5.11a fixes).
 * L5.11a: the status bar's actions for the scenario in context (StatusActions.tsx: its state, Rehearse, Capture, Render,
 * Pause / Stop, the confirmation sheet) — the default owner of the Scenario menu's commands (Rehearse ⌘R, Capture ⇧⌘R,
 * Render ⌘B, Stop ⌘. from the app's menu; the palette's Scenario group in a browser tab, which binds none of the four),
 * routed through the command bus (command-bus.ts: a screen or a live recording outranks the defaults by priority).
 * L5.12d: in the desktop app, the quit question as a kit Sheet (QuitSheet.tsx: `studio:quit`, answered through
 * `desktop_answer`); a browser tab has none (only the app's window is ever asked). L5.16d: in the app's window, the
 * update's button in the status bar and its sheet (UpdateSheet.tsx).
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import type { AuthStatus, HeldWork, ProjectBoardView, ProjectSummary, ProjectView } from '@retake/engine';
import { call, useConnection } from '../api.js';
import type { Connection, Loaded } from '../api.js';
import { Txt } from '../bits.js';
import { APP_NAME } from '../brand.js';
import { readmeKey, useDirty } from '../drafts.js';
import { useEventMode, useEvents } from '../events.js';
import type { EventMode } from '../events.js';
import { heldShortWords, heldWords } from '../render-words.js';
import { hrefTo } from '../route.js';
import type { Route } from '../route.js';
import { AppMark, Button, CommandPalette, COMMAND_EVENT, IconButton, Menu, SegmentedLinks, SourceList, StatusBar, StatusMark, isMenuCommand, modalOpen, studioShell } from '../ui-kit/index.js';
import type { Command, IconName, MarkState, MenuCommand, SourceGroup, SourceItem } from '../ui-kit/index.js';
import { BOARD_GROUPS, GROUP_LABEL, castState, envFlagWord, groupCounts } from '../board-words.js';
import { useBoard, useCast, useProjectDataEvents, useProjectView } from '../project-data.js';
import { isShellCommand, paletteGroup, runShellCommand } from './command-bus.js';
import type { PaletteSlot } from './command-bus.js';
import type { ShellCommand } from './command-bus.js';
import { MODES, contextWatch, modeOf, modeTarget, noteReviewView, scenarioInContext, screenKey, slugOf } from './modes.js';
import type { Mode } from './modes.js';
import { SlotContext } from './slots.js';
import type { SlotHost, SlotName } from './slots.js';
import { setSay } from './say.js';
import { useStatusActions } from './StatusActions.js';
import { QuitSheet } from './QuitSheet.js';
import { SetupSheet } from './SetupSheet.js';
import { UpdateControl } from './UpdateSheet.js';

export interface ProjectList {
  root: string;
  projects_dir: string;
  projects: ProjectSummary[];
}

interface EngineInfoData {
  version: string;
  root: string;
  worker: { pid: number; started_by?: string } | null;
  /** L5.14: what a filming take holds of this workspace's jobs (absent from an older server). */
  held?: HeldWork | null;
  /** L5.13: the sign-ins of before the rename are left in the old home; old variables are set — neither is read. */
  legacy?: { old_home?: string; old_home_var?: string; old_vars?: string[] };
}

const CONNECTION: Record<Connection, { word: string; state: MarkState }> = {
  connecting: { word: 'Connecting…', state: 'running' },
  online: { word: 'Connected', state: 'ok' },
  offline: { word: 'Not connected', state: 'fail' },
  ended: { word: 'Session ended', state: 'idle' },
};
const UPDATES: Record<EventMode, string> = { connecting: '', stream: 'live updates', relay: 'live updates', polling: 'updates every 3 s', off: '' };
/** How long a polite line stays (ms). */
const SAID_MS = 6000;
const MODE_COMMAND: Record<Mode, MenuCommand> = { script: 'mode-script', shoot: 'mode-shoot', edit: 'mode-edit', review: 'mode-review' };
const MODE_ICON: Record<Mode, IconName> = { script: 'report', shoot: 'record', edit: 'film', review: 'check' };
/** The Scenario menu's commands in the palette (a browser tab binds none of their keys: critique M3). */
const SCENARIO_COMMANDS: Array<{ id: ShellCommand; label: string; kbd: string[]; icon: IconName }> = [
  { id: 'rehearse', label: 'Rehearse', kbd: ['⌘', 'R'], icon: 'play' },
  { id: 'capture', label: 'Capture', kbd: ['⇧', '⌘', 'R'], icon: 'record' },
  { id: 'render', label: 'Render', kbd: ['⌘', 'B'], icon: 'export' },
  { id: 'stop', label: 'Stop', kbd: ['⌘', '.'], icon: 'stop' },
];
/**
 * L5.12b (R4-Palette): the palette's groups, in this order — Commands (the Scenario menu's, or a live recording's own;
 * Review's "Comment at this frame"; the inspector), Go to (the modes, the Review report, the project's pages, the
 * workspace), Scenes (the screen's scenes), Themes (the theme set for the scenario shown, the project's, all themes),
 * Scenarios, Projects. An entry goes somewhere or selects something; it never writes (a test counts the ops).
 */
const PALETTE_GROUPS = ['Commands', 'Go to', 'Scenes', 'Themes', 'Scenarios', 'Projects'] as const;

/**
 * Worker state and version: `engine_info` now, when a job the page never saw appears (a new job may start a worker), on a
 * reconnection and every 15 s (an idle worker exits quietly). A job rewritten at each step of its run is not a worker
 * change: no re-read (L5.11a fixes, review A: 17 reads in 30 s of a run before).
 */
function useEngineInfo(): EngineInfoData | null {
  const [v, set] = useState<EngineInfoData | null>(null);
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

/**
 * L5.14 (captures first): what a filming take holds of this workspace's jobs — engine_info's `held`, then each jobs
 * event's (the server says it with every change of a job, a hold included: the job stream's signature has it).
 */
function useHeld(info: EngineInfoData | null): HeldWork | null {
  const [v, set] = useState<HeldWork | null>(null);
  useEffect(() => {
    if (info && info.held !== undefined) set(info.held ?? null);
  }, [info]);
  useEvents((e) => {
    if (e.type === 'jobs' && e.held !== undefined) set(e.held ?? null);
  });
  return v;
}

/** A Mac (its shortcuts use ⌘; Ctrl+K edits text there). */
const MAC = typeof navigator !== 'undefined' && /^(?:mac|iphone|ipad)/i.test((navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform);

/** A field that takes typed text (its own Ctrl+K, if any, stays its own). */
function inTextField(t: EventTarget | null): boolean {
  return t instanceof HTMLElement && (t.isContentEditable || t.matches('textarea, select, input:not([type="button"], [type="checkbox"], [type="radio"], [type="submit"], [type="reset"], [type="image"], [type="color"], [type="file"], [type="range"])'));
}

const PROJECT_ROUTES = new Set<Route['name']>(['project', 'group', 'location', 'cast', 'readme', 'scenario', 'run', 'timeline', 'comments', 'proposal', 'review', 'library', 'themes', 'record']);

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
          current: route.name === 'projects' || route.name === 'setup',
          childrenLabel: 'Projects of the workspace',
          children: projects.map((p) => ({ key: p.slug, to: { name: 'project', slug: p.slug }, label: <Txt text={p.name} />, current: false, ...(p.error ? { flag: 'does not load' } : {}) })),
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
  const held = useHeld(info);
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
  noteReviewView(route);
  const mode = modeOf(route, ctx);
  const inApp = useMemo(() => studioShell() !== null, []);

  // The centre pane scrolls back to the top when the screen changes, not when a screen moves inside itself (M2).
  const key = screenKey(route);
  // The screen a polite line was said on (read by `say`: a screen's own mount effect runs after this render) — a run's
  // live screen is another screen than Prepare (the same screenKey), a recording another than the start form (L5.11b).
  const saidKey = `${key}|${route.name === 'run' ? (route.run ?? '') : route.name === 'record' ? (route.rec ?? '') : ''}`;
  const keyNow = useRef(saidKey);
  keyNow.current = saidKey;
  const firstScreen = useRef(true);
  useEffect(() => {
    main.current?.scrollTo?.({ top: 0, left: 0, behavior: 'auto' });
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
  // L5.12a: a screen that hides the browser pane while mounted (Edit, the Review report).
  const [collapsed, setCollapsed] = useState(0);
  const collapseBrowser = useCallback(() => {
    setCollapsed((n) => n + 1);
    return () => setCollapsed((n) => n - 1);
  }, []);
  const hasInspector = claims.inspector > 0;
  const [inspectorOff, setInspectorOff] = useState(false);
  const inspectorShown = hasInspector && !inspectorOff;
  const host = useMemo<SlotHost>(() => ({ targets, claim, collapseBrowser, hidden: { inspector: inspectorOff } }), [targets, claim, collapseBrowser, inspectorOff]);
  const inspector = useRef<HTMLElement>(null);
  /** Shows or hides the inspector; hiding it with the focus inside moves the focus to the centre pane (review A-L6). */
  const toggleInspector = useCallback(() => {
    if (inspector.current?.contains(document.activeElement)) main.current?.focus({ preventScroll: true });
    setInspectorOff((v) => !v);
  }, []);

  // What a command answers (a polite line in the status bar): one line at a time — a new one replaces it —, gone after
  // SAID_MS (announced once anyway) and when the screen changes (L5.11a fixes, review B-M1 / A-L5: "queued" never stays
  // beside the run's own state). Said as text (Txt: engine and project words, review A-M4).
  const [said, setSaid] = useState('');
  const saidFor = useRef<string | null>(null);
  const saidTimer = useRef<number | null>(null);
  const say = useCallback((s: string) => {
    if (saidTimer.current !== null) window.clearTimeout(saidTimer.current);
    setSaid('');
    saidFor.current = keyNow.current;
    saidTimer.current = window.setTimeout(() => {
      setSaid(s);
      saidTimer.current = window.setTimeout(() => {
        saidTimer.current = null;
        setSaid('');
      }, SAID_MS);
    }, 30);
  }, []);
  useEffect(() => setSay(say), [say]);
  useEffect(() => {
    if (saidFor.current === null || saidFor.current === saidKey) return;
    if (saidTimer.current !== null) window.clearTimeout(saidTimer.current);
    saidTimer.current = null;
    saidFor.current = null;
    setSaid('');
  }, [saidKey]);
  useEffect(
    () => () => {
      if (saidTimer.current !== null) window.clearTimeout(saidTimer.current);
    },
    [],
  );
  const [palette, setPalette] = useState(false);

  const run = useCallback(
    (id: MenuCommand) => {
      if (modalOpen()) {
        // A modal waits for its answer; the palette's own ⌘K closes it. ⌘. always answers (review A-L3: a capture may be
        // running behind the sheet or the palette): the palette closes, then Stop's owner acts — it changes no page.
        if (id === 'palette' && palette) setPalette(false);
        if (id !== 'stop') return;
        if (palette) setPalette(false);
      }
      if (id === 'palette') setPalette(true);
      else if (isShellCommand(id)) {
        // L5.11a: whoever owns it acts (the status bar's defaults are always there; they say why when they cannot).
        if (!runShellCommand(id)) say('Open a scenario first');
      } else if (id === 'inspector') {
        if (hasInspector) toggleInspector();
        else say('This screen has no inspector');
      } else {
        const m = (Object.keys(MODE_COMMAND) as Mode[]).find((k) => MODE_COMMAND[k] === id);
        if (!m) return;
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

  useSyncExternalStore(paletteGroup.subscribe, paletteGroup.version);
  const slotVersion = paletteGroup.version();
  const commands = useMemo<Command[]>(() => {
    const go = (r: Route) => () => {
      location.hash = hrefTo(r);
    };
    const screen = (slot: PaletteSlot) => paletteGroup.get(slot);
    const out: Command[] = [];
    const add = (group: (typeof PALETTE_GROUPS)[number], c: Omit<Command, 'group'>) => out.push({ ...c, group });
    // Commands. L5.11b fixes (review A-M2 / A-L1): a live recording's own entries (Stop recording, Discard…, named after
    // it) take the Scenario menu's place — with or without a scenario in context, never naming that scenario.
    const recording = screen('scenario');
    if (recording) for (const c of recording) add('Commands', { id: c.id, label: c.label, ...(c.hint ? { hint: c.hint } : {}), icon: c.icon ?? 'record', ...(inApp && c.id === 'record-stop' ? { kbd: ['⌘', '.'] } : {}), run: c.run });
    // L5.11a: the Scenario menu (the palette closes as it runs: the bus, not the modal-waiting `run`).
    else if (ctx) for (const c of SCENARIO_COMMANDS) add('Commands', { id: c.id, label: c.label, hint: ctx.scenario, icon: c.icon, ...(inApp ? { kbd: c.kbd } : {}), run: () => void (runShellCommand(c.id) || say('Open a scenario first')) });
    for (const c of screen('review') ?? []) add('Commands', { id: c.id, label: c.label, ...(c.hint ? { hint: c.hint } : {}), icon: c.icon ?? 'plus', run: c.run });
    if (hasInspector) add('Commands', { id: 'inspector', label: inspectorOff ? 'Show inspector' : 'Hide inspector', icon: 'inspector', ...(inApp ? { kbd: ['⌥', '⌘', 'I'] } : {}), run: toggleInspector });
    // Go to: the modes, the Review report, the project's pages, the workspace.
    if (ctx) for (const m of MODES) add('Go to', { id: `mode-${m.mode}`, label: m.label, hint: ctx.scenario, icon: MODE_ICON[m.mode], ...(inApp ? { kbd: ['⌘', String(MODES.indexOf(m) + 1)] } : {}), run: go(modeTarget(m.mode, ctx)) });
    if (ctx) {
      // The report's entry with the last render's words when a screen holds the renders (never "passed": review-words).
      const report = screen('report')?.[0];
      add('Go to', { id: 'go-report', label: 'Review report', hint: report?.hint ?? ctx.scenario, icon: 'report', run: report ? report.run : go({ name: 'review', slug: ctx.slug, scenario: ctx.scenario }) });
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
      if (open.view.state === 'ready') for (const e of open.view.data.environments) pages.push([`loc-${e.name}`, `Location ${e.name}`, { name: 'location', slug, env: e.name }, 'location']);
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
      const own = open.view.state === 'ready' ? open.view.data.config.template : undefined;
      if (own && !seen.has(own)) add('Themes', { id: `theme-${own}`, label: own, hint: "the project's theme", icon: 'theme', run: go({ name: 'themes', slug, theme: own }) });
      add('Themes', { id: 'page-themes', label: 'All themes', hint: project.name, icon: 'theme', run: go({ name: 'themes', slug }) });
    }
    if (project) for (const name of project.scenarios) add('Scenarios', { id: `open-${name}`, label: `Open ${name}`, hint: 'scenario', icon: 'scene', run: go({ name: 'scenario', slug: project.slug, scenario: name, tab: 'blocks' }) });
    for (const p of projects) add('Projects', { id: `project-${p.slug}`, label: p.name, hint: 'project', icon: 'folder', run: go({ name: 'project', slug: p.slug }) });
    return PALETTE_GROUPS.flatMap((g) => out.filter((c) => c.group === g));
    // slotVersion: a screen's group changed (the entries are read from the registry above).
  }, [ctx, project, projects, hasInspector, inspectorOff, inApp, toggleInspector, open.view, say, slotVersion]);

  // L5.11a: the scenario in context's state and actions (the buttons hide while a screen claims the slot).
  const shoot = useStatusActions({ route, ctx, say, claimed: claims.actions > 0, inApp });

  const conn = CONNECTION[connection];
  return (
    <SlotContext.Provider value={host}>
      <div className="sh-app" data-inspector={inspectorShown ? 'shown' : 'none'} data-browser={collapsed > 0 ? 'none' : 'shown'}>
        <div className="sh-skip">
          <Button size="sm" onClick={() => main.current?.focus()}>
            Skip to content
          </Button>
        </div>
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
            <SegmentedLinks label="Mode" hint="Open a scenario to choose a mode" items={MODES.map((m) => ({ key: m.mode, label: m.label, to: ctx ? modeTarget(m.mode, ctx) : null, current: mode === m.mode }))} />
          </div>
          <div className="sh-titlebar-end">
            <div className="sh-slot-context" ref={slotRefs.context} />
            {hasInspector && <IconButton icon="inspector" label="Inspector" pressed={inspectorShown} onClick={toggleInspector} />}
          </div>
        </header>
        <aside className="sh-browser sidebar" aria-label="Browser" hidden={collapsed > 0}>
          {claims.browser === 0 && <SourceList label="Studio" groups={openSlug !== null ? projectTree(route, openSlug, open, readmeDirty) : workspaceTree(route, projects)} />}
          <div className="sh-slot-browser" ref={slotRefs.browser} hidden={claims.browser === 0} />
          <div className="sh-browser-foot">
            {info?.legacy?.old_home && (
              <p className="sh-foot-line sh-foot-legacy" role="note" data-testid="legacy-home">
                {/* The old home as the engine names it (core legacyInfo): the old default, or the folder the old home variable named (then set RETAKE_HOME to it, or move it). */}
                Sign-ins from before the rename are in <Txt className="k-mono" text={info.legacy.old_home} />
                {info.legacy.old_home_var ? (
                  <>
                    , set by <Txt className="k-mono" text={info.legacy.old_home_var} />, and not read: set <span className="k-mono">RETAKE_HOME</span> to it, or move it (<span className="k-mono">retake doctor</span> shows the command).
                  </>
                ) : (
                  <>
                    {' '}and not read: <span className="k-mono">retake doctor</span> shows the command to move them.
                  </>
                )}
              </p>
            )}
            {info?.legacy?.old_vars && (
              <p className="sh-foot-line sh-foot-legacy" role="note" data-testid="legacy-vars">
                Variables from before the rename are set but not read: <Txt className="k-mono" text={info.legacy.old_vars.join(', ')} /> — rename them <span className="k-mono">RETAKE_…</span> where they are set (shell profile, the MCP registration&apos;s env).
              </p>
            )}
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
                {held && (
                  <span className="sh-seg" data-testid="held" data-held={held.state}>
                    {' · '}
                    {/* Review B L6: the long words, or at 1000 px and less their short form (shell.css). */}
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
            }
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
