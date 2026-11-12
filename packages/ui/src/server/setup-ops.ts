/**
 * The installed app's Set-up sheet (L5.16c, DESIGN §4p (c), docs/reference/studio-ui.md): the Studio's own ops that
 * read and make the integrations — the `retake` command's link, the Claude Code plugin route, the Claude Desktop
 * entry, the notification permission — each on the person's click. The rules are @retake/engine/integrations
 * (app-setup.ts, config-snippet.ts); here, who may call them and with what:
 *
 * - **Studio only, never MCP tools** (OWN_OPS, the `ui` client's allow-list; a static test checks the MCP list has none):
 *   no MCP tool can install a command or register Retake with Claude (an agent with a shell of its own still can).
 * - **The installed app's own server only:** supervised (`retake ui --supervised`, the desktop shell's pipe attached)
 *   AND run from an app bundle (`….app/Contents/Resources`). Any other server answers setup_status with
 *   `available: false` and refuses every other op (409, reason `not_supervised` / `not_bundled`).
 * - **Where the app runs from** (critique H1): translocated, a read-only volume or /Volumes — the command and both Claude
 *   registrations are refused (409, reason `location`) with "Move Retake to Applications, then open it again".
 * - **Paths are the server's:** the page sends choices, never a path. Another folder for the command is chosen in the
 *   shell's native panel (`setup_cli_choose` writes a pipe line; the shell answers on the server's stdin: ui.ts →
 *   `SetupState.chose`), checked here (absolute, the person's, writable, outside the workspace and the app).
 * - **Rate-capped:** SETUP_WRITES_PER_MIN writes a minute (busy, 423), like the quit question's acks; one Claude Code
 *   run at a time (409, reason `busy`: review c A-L5).
 * - **Claude Desktop running:** `ps` decides; when it cannot tell (it failed), Add is refused too (review c A-L3). The
 *   status reads `ps` only when the page asks (`processes`: the Claude Desktop step in view, or the window focused),
 *   at most every PS_EVERY_MS (review c A-L8).
 * - **The command's link the app made** is recorded in `<home>/app.json`: the status, Install and Uninstall read it
 *   beside the default folder (review c B-M1: a link in a chosen folder survives a restart; a second one elsewhere is
 *   refused until it is uninstalled).
 * - What other programs wrote (Claude Code's output, Claude Desktop's current entry) is under `untrusted`: the page
 *   shows it as text.
 */
import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { z } from 'zod';
import { RETAKE_VERSION } from '@retake/core/base';
import { bundleInfoOrNull, bundleNodeArgs, retakeHome } from '@retake/core/io';
import type { BundleInfo } from '@retake/core/io';
import type { UpdateState } from './update-ops.js';
import { readFileSync, existsSync } from 'node:fs';
import { EngineError } from '@retake/engine';
import {
  CLI_NAME,
  LAUNCHER_REL,
  MOVE_TO_APPLICATIONS,
  SetupError,
  ZSH_PROFILE,
  checkCliFolder,
  claudeCandidates,
  claudeDesktopConfigFile,
  claudeDesktopIn,
  claudeEnv,
  cliLinkState,
  desktopBackupDir,
  cliOnPath,
  defaultCliDir,
  findClaude,
  installCliLink,
  installLocation,
  installLocationWords,
  mcpConfigJson,
  onReadOnlyVolume,
  planDesktopEntry,
  pluginInstallCommands,
  pluginInstallSteps,
  pluginMarketplaceRoot,
  readAppSettings,
  removeCliLink,
  runClaudeSteps,
  setupSeen,
  writeAppSettings,
  writeDesktopEntry,
  zshPathLine,
} from '@retake/engine/integrations';
import type { ClaudeStep, InstallLocation } from '@retake/engine/integrations';
import { defineTool } from '@retake/engine/contract';
import type { ToolOutput } from '@retake/engine/contract';
import { parseShellLine } from './shell-line.js';
import type { DesktopPipe } from './desktop.js';

/** Setup writes a minute at most (every op but setup_status). */
export const SETUP_WRITES_PER_MIN = 12;
/** The process list (is Claude Desktop running?) is read at most this often by the status. */
export const PS_EVERY_MS = 5000;

export const SETUP_OPS = [
  'setup_status',
  'setup_cli_install',
  'setup_cli_choose',
  'setup_cli_remove',
  'setup_claude_code_run',
  'setup_claude_desktop_add',
  'setup_notifications',
  'setup_done',
] as const;

/** Everything the setup ops read from the machine — injected by tests (scratch folders, fake programs). */
export interface SetupContext {
  /** The app bundle this server runs from (core bundleInfo), or null. */
  bundle: BundleInfo | null;
  /** The person's home folder. */
  home: string;
  /** The server's environment (PATH, RETAKE_HOME, CLAUDE_CONFIG_DIR). */
  env: NodeJS.ProcessEnv;
  uid: number;
  /** Is this folder on a read-only volume? */
  readOnly(p: string): boolean;
  /** The process list, one executable path a line (`ps -axo comm=`); null when it could not be read. */
  processes(): Promise<string | null>;
  /** Claude Desktop's config file. */
  desktopConfig: string;
  /** Is this an executable file (the `claude` candidates, the PATH's `retake`)? */
  isExec?(p: string): boolean;
  /** The Claude Code run's time limit (ms; default core CLAUDE_RUN_MS). */
  claudeTimeoutMs?: number;
}

/** The machine as it is (the real home, `ps`, Claude Desktop's real config path). */
export function systemSetupContext(): SetupContext {
  const home = homedir();
  return {
    bundle: bundleInfoOrNull(),
    home,
    env: process.env,
    uid: process.getuid?.() ?? -1,
    readOnly: onReadOnlyVolume,
    processes: () =>
      new Promise((resolve) => {
        execFile('/bin/ps', ['-axo', 'comm='], { timeout: 5000, maxBuffer: 4 * 1024 * 1024 }, (err, out) => resolve(err ? null : String(out)));
      }),
    desktopConfig: claudeDesktopConfigFile(home),
  };
}

/**
 * What the server keeps between ops: the folder panel's state and the folder it gave, the notification state the
 * shell said, whether a Claude Code run is in flight, the last process list's answer.
 */
export class SetupState {
  /** `panel`: the shell said it opened its folder panel (`open`), or that no folder came back (`cancelled`). */
  chosen: { dir: string } | { error: string; reason: string } | { panel: 'open' | 'cancelled' } | undefined;
  notifications: 'on' | 'off' | 'unknown' = 'unknown';
  /** A Claude Code run is in flight (one at a time). */
  claudeRunning = false;
  /** Is Claude Desktop running, as `ps` said at `at` (null: it could not tell). */
  ps: { at: number; running: boolean | null } | undefined;
  private window = { start: 0, count: 0 };

  constructor(readonly now: () => number = Date.now) {}

  /** The shell's answer to `setup_cli_choose`: the folder the person picked, checked now. */
  chose(dir: string, ctx: SetupContext, workspace: string): void {
    try {
      this.chosen = { dir: checkCliFolder(dir, { uid: ctx.uid, workspace, ...(ctx.bundle ? { sealed: ctx.bundle.sealed } : {}) }) };
    } catch (e) {
      this.chosen = e instanceof SetupError ? { error: e.message, reason: e.reason } : { error: (e as Error).message, reason: 'invalid' };
    }
  }

  /** One write more this minute: false past the cap. */
  take(): boolean {
    const t = this.now();
    if (t - this.window.start >= 60_000) this.window = { start: t, count: 0 };
    if (this.window.count >= SETUP_WRITES_PER_MIN) return false;
    this.window.count++;
    return true;
  }
}

/**
 * One line the desktop shell wrote on the supervised server's stdin (cli ui.ts → here): the folder picked in its
 * native panel (checked now: SetupState.chose), the notification state; anything else is dropped. True when taken.
 */
export function applyShellLine(setup: { state: SetupState; context(): SetupContext }, workspace: string, line: string, update?: UpdateState): boolean {
  const m = parseShellLine(line);
  if (!m) return false;
  // L5.16d: the update's state (update-ops.ts), kept for desktop_update_status.
  if (m.type === 'update') {
    update?.apply(m);
    return update !== undefined;
  }
  if (m.type === 'cli_folder') setup.state.chose(m.path, setup.context(), workspace);
  else if (m.type === 'cli_folder_open') setup.state.chosen = { panel: 'open' };
  else if (m.type === 'cli_folder_cancelled') setup.state.chosen = { panel: 'cancelled' };
  else if (m.type === 'notifications') setup.state.notifications = m.state;
  return true;
}

/** The bundle of an installed app (a `.app` around it), else null: a staged tree or a checkout has no set-up. */
function appBundle(ctx: SetupContext): BundleInfo | null {
  return ctx.bundle && ctx.bundle.sealed.endsWith('.app') ? ctx.bundle : null;
}

function locationOf(b: BundleInfo, ctx: SetupContext): InstallLocation {
  return installLocation(b.sealed, { readOnly: ctx.readOnly(b.sealed) });
}

function refused(reason: string, message: string, extra: Record<string, unknown> = {}): EngineError {
  return new EngineError('conflict', message, { details: { reason, ...extra } });
}

/** The ops' common gate: the installed app's own server (and, `placed`, an app moved to Applications). */
function gate(pipe: DesktopPipe, ctx: SetupContext, state: SetupState, placed: boolean): BundleInfo {
  if (!pipe.supervised) throw refused('not_supervised', "set-up is the installed app's: this Studio server is not the desktop app's");
  const b = appBundle(ctx);
  if (!b) throw refused('not_bundled', "set-up is the installed app's: this Retake runs from a repository checkout (use retake mcp --print-config there)");
  if (placed) {
    const loc = locationOf(b, ctx);
    if (loc !== 'ok') throw refused('location', `${installLocationWords(loc)}: ${MOVE_TO_APPLICATIONS}`, { location: loc });
  }
  if (!state.take()) throw new EngineError('busy', `too many set-up requests this minute (at most ${SETUP_WRITES_PER_MIN}): wait a moment`, { details: { reason: 'rate' } });
  return b;
}

const READ_ANN = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const WRITE_ANN = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

function setupError(e: unknown): never {
  if (e instanceof SetupError) throw new EngineError('conflict', e.message, { details: { reason: e.reason, ...e.details } });
  throw e;
}

/** The registration's inputs: the bundle's Node.js (with its guard), its CLI, the workspace, RETAKE_HOME when set. */
function registration(b: BundleInfo, ctx: SetupContext, workspace: string) {
  const bin = join(b.paths.engine, 'dist', 'bin.js');
  return { root: workspace, bin, node: b.paths.node, nodeArgs: bundleNodeArgs(b), env: ctx.env };
}

function claudeSteps(b: BundleInfo, ctx: SetupContext, workspace: string): { steps: ClaudeStep[]; lines: string[] } | null {
  const repo = pluginMarketplaceRoot(join(b.paths.engine, 'dist', 'bin.js'), existsSync, b);
  if (!repo) return null;
  const o = { ...registration(b, ctx, workspace), repo };
  return { steps: pluginInstallSteps(o), lines: pluginInstallCommands(o) };
}

function desktopEntry(b: BundleInfo, ctx: SetupContext, workspace: string): Record<string, unknown> {
  return mcpConfigJson(registration(b, ctx, workspace)).mcpServers.retake as unknown as Record<string, unknown>;
}

function readText(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** The command's link the app recorded (app.json), when it still runs this app. */
function recordedLink(home: string, launcher: string): string | null {
  const p = readAppSettings(home).cli?.path;
  return p && cliLinkState(p, launcher).state === 'ours' ? p : null;
}

/** This app's command: the link the app recorded, else the default folder's when it runs this app; null: none. */
function installedLink(ctx: SetupContext, home: string, launcher: string): string | null {
  const fallback = join(defaultCliDir(ctx.home), CLI_NAME);
  return recordedLink(home, launcher) ?? (cliLinkState(fallback, launcher).state === 'ours' ? fallback : null);
}

/** Is Claude Desktop running: true / false, null when `ps` could not tell (a fresh read, remembered). */
async function readRunning(ctx: SetupContext, state: SetupState): Promise<boolean | null> {
  const list = await ctx.processes().catch(() => null);
  const running = list === null ? null : claudeDesktopIn(list);
  state.ps = { at: state.now(), running };
  return running;
}

/** The Studio's setup ops. `ctx` is read on each call (tests swap it). */
/** The retake command's part of setup_status: the folder shown, its link's state, and where the shell finds it. */
export interface CliStatus {
  dir: string;
  default_dir: string;
  link: string;
  launcher: string;
  state: 'absent' | 'ours' | 'other_app' | 'foreign';
  target?: string;
  dangling?: boolean;
  what?: string;
  chosen: boolean;
  chosen_error?: string;
  /** The shell's folder panel: up (`open`), or no folder came back (`cancelled`: cancelled, or another question was up). */
  panel?: 'open' | 'cancelled';
  /** This app's command (the link the app recorded, else the default folder's), when it runs this app. */
  installed: string | null;
  on_path: boolean;
  first: string | null;
  first_is_this: boolean;
  path_line: string;
  profile: string;
}

/** What setup_status answers (the Studio's Set-up sheet reads it: app/shell/setup.ts), or why there is no set-up. */
export interface SetupStatus {
  available: boolean;
  reason?: 'not_supervised' | 'not_bundled';
  version?: string;
  seen?: boolean;
  location?: InstallLocation;
  location_words?: string;
  workspace?: string;
  home?: string;
  home_from_env?: boolean;
  app?: string;
  cli?: CliStatus;
  claude_code?: { claude: string | null; candidates: string[]; config_dir: string; lines: string[]; plugin: boolean };
  /** `running`: true / false, null when the process list could not be read, absent until it was read. */
  claude_desktop?: { file: string; folder: boolean; state: 'create' | 'add' | 'same' | 'replace' | 'unreadable'; entry: string; running?: boolean | null; backups: string };
  notifications?: 'on' | 'off' | 'unknown';
  untrusted?: { desktop_current?: string; desktop_problem?: string };
}

export function setupOps(o: { pipe: DesktopPipe; state: SetupState; ctx: () => SetupContext; workspace: string }) {
  const { pipe, state, workspace } = o;
  const homeOf = (ctx: SetupContext) => retakeHome(ctx.env);

  const status = defineTool({
    name: 'setup_status',
    title: 'Set-up of the installed app',
    description: "The installed app's set-up: where it runs from, the retake command, Claude Code and Claude Desktop, notifications. The desktop app's own server only.",
    input: z.strictObject({ processes: z.boolean().default(false).describe('Read the process list too (is Claude Desktop running?), at most every 5 s.') }),
    annotations: READ_ANN,
    async run(a: { processes: boolean }): Promise<ToolOutput<SetupStatus>> {
      const ctx = o.ctx();
      if (!pipe.supervised) return { summary: "set-up: not the desktop app's server", data: { available: false, reason: 'not_supervised' } };
      const b = appBundle(ctx);
      if (!b) return { summary: 'set-up: not an installed app', data: { available: false, reason: 'not_bundled' } };
      const home = homeOf(ctx);
      const settings = readAppSettings(home);
      const location = locationOf(b, ctx);
      const launcher = join(b.root, LAUNCHER_REL);
      const defaultDir = defaultCliDir(ctx.home);
      const chosen = state.chosen;
      // The folder shown: a fresh choice, else the one of the link the app made (app.json), else the default.
      const recorded = recordedLink(home, launcher);
      const dir = chosen && 'dir' in chosen ? chosen.dir : recorded ? dirname(recorded) : defaultDir;
      const link = join(dir, CLI_NAME);
      const now = cliLinkState(link, launcher);
      const installed = installedLink(ctx, home, launcher);
      const path = cliOnPath(dir, ctx.env.PATH ?? '', ctx.isExec);
      const claude = findClaude(ctx.home, ctx.isExec);
      const steps = claudeSteps(b, ctx, workspace);
      const entry = desktopEntry(b, ctx, workspace);
      const text = readText(ctx.desktopConfig);
      let desktopState: 'create' | 'add' | 'same' | 'replace' | 'unreadable' = 'create';
      let problem: string | undefined;
      let current: unknown;
      try {
        const plan = planDesktopEntry(text, entry);
        desktopState = plan.kind;
        current = plan.current;
      } catch (e) {
        desktopState = 'unreadable';
        problem = (e as Error).message;
      }
      // `ps` only when asked (the step in view, the window focused), at most every PS_EVERY_MS.
      if (a.processes && (!state.ps || state.now() - state.ps.at >= PS_EVERY_MS)) await readRunning(ctx, state);
      const running = state.ps?.running;
      const untrusted: NonNullable<SetupStatus['untrusted']> = {};
      if (current !== undefined) untrusted.desktop_current = JSON.stringify({ mcpServers: { retake: current } }, null, 2);
      if (problem) untrusted.desktop_problem = problem;
      return {
        summary: `set-up: ${location}`,
        data: {
          available: true,
          version: RETAKE_VERSION,
          seen: setupSeen(settings, RETAKE_VERSION),
          location,
          ...(location !== 'ok' ? { location_words: `${installLocationWords(location)}: ${MOVE_TO_APPLICATIONS}` } : {}),
          workspace,
          home,
          home_from_env: !!ctx.env.RETAKE_HOME?.trim(),
          app: b.sealed,
          cli: {
            dir,
            default_dir: defaultDir,
            link,
            launcher,
            state: now.state,
            ...('target' in now && now.target ? { target: now.target } : {}),
            ...(now.state === 'other_app' ? { dangling: now.dangling } : {}),
            ...(now.state === 'foreign' ? { what: now.what } : {}),
            ...(chosen && 'error' in chosen ? { chosen_error: chosen.error } : {}),
            ...(chosen && 'panel' in chosen ? { panel: chosen.panel } : {}),
            chosen: !!(chosen && 'dir' in chosen),
            installed,
            on_path: path.onPath,
            first: path.first,
            first_is_this: path.first !== null && path.first === link && now.state === 'ours',
            path_line: zshPathLine(dir, ctx.home),
            profile: ZSH_PROFILE,
          },
          claude_code: {
            claude,
            candidates: claudeCandidates(ctx.home),
            config_dir: ctx.env.CLAUDE_CONFIG_DIR?.trim() || join(ctx.home, '.claude'),
            lines: steps?.lines ?? [],
            plugin: steps !== null,
          },
          claude_desktop: {
            file: ctx.desktopConfig,
            folder: existsSync(join(ctx.desktopConfig, '..')),
            state: desktopState,
            entry: JSON.stringify({ mcpServers: { retake: entry } }, null, 2),
            // true / false; null: `ps` could not tell; absent: not read yet.
            ...(running !== undefined ? { running } : {}),
            backups: desktopBackupDir(home),
          },
          notifications: state.notifications,
          ...(Object.keys(untrusted).length ? { untrusted } : {}),
        },
      };
    },
  });

  const install = defineTool({
    name: 'setup_cli_install',
    title: 'Install the retake command',
    description: "Link the retake command to this app (the default folder, or the folder chosen in the app's panel). The desktop app's own server only.",
    input: z.strictObject({ folder: z.enum(['default', 'chosen']).default('default'), replace: z.boolean().default(false).describe('Replace a link to another copy of Retake.') }),
    annotations: WRITE_ANN,
    async run(a: { folder: 'default' | 'chosen'; replace: boolean }) {
      const ctx = o.ctx();
      const b = gate(pipe, ctx, state, true);
      let dir = defaultCliDir(ctx.home);
      if (a.folder === 'chosen') {
        const c = state.chosen;
        if (!c || !('dir' in c)) throw refused('no_choice', 'no folder was chosen: Choose a Folder… first');
        dir = c.dir;
      }
      const home = homeOf(ctx);
      const launcher = join(b.root, LAUNCHER_REL);
      // One command per app (review c B-M1): a second link elsewhere would be forgotten by Uninstall.
      const there = installedLink(ctx, home, launcher);
      if (there && there !== join(dir, CLI_NAME))
        throw refused('installed_elsewhere', `the command is installed already: ${there} — Uninstall it first, then install it in the other folder`, { installed: there });
      let r;
      try {
        r = installCliLink(dir, launcher, { replace: a.replace, createDir: a.folder === 'default' });
      } catch (e) {
        setupError(e);
      }
      writeAppSettings(home, { cli: { path: r.path, at: new Date().toISOString() } });
      return { summary: `retake command ${r.result}: ${r.path}`, data: { ok: true, path: r.path, result: r.result } };
    },
  });

  const choose = defineTool({
    name: 'setup_cli_choose',
    title: "Choose the command's folder",
    description: "Ask the desktop app to show its folder panel (the folder never comes from the page). The desktop app's own server only.",
    input: z.strictObject({}),
    annotations: WRITE_ANN,
    async run() {
      gate(pipe, o.ctx(), state, true);
      state.chosen = undefined;
      pipe.setup('cli_folder');
      return { summary: 'the folder panel is open in the app', data: { ok: true } };
    },
  });

  const remove = defineTool({
    name: 'setup_cli_remove',
    title: 'Uninstall the retake command',
    description: "Remove the retake command's link when it points into a Retake app (anything else is left). The desktop app's own server only.",
    input: z.strictObject({}),
    annotations: { ...WRITE_ANN, destructiveHint: true },
    async run() {
      const ctx = o.ctx();
      // Uninstall works from a misplaced app too: it only takes away a link (a test pins it).
      const b = gate(pipe, ctx, state, false);
      const home = homeOf(ctx);
      const launcher = join(b.root, LAUNCHER_REL);
      // This app's link (the recorded one first), else the recorded place, else the default folder's.
      const link = installedLink(ctx, home, launcher) ?? readAppSettings(home).cli?.path ?? join(defaultCliDir(ctx.home), CLI_NAME);
      let r: 'removed' | 'absent';
      try {
        r = removeCliLink(link, launcher);
      } catch (e) {
        setupError(e);
      }
      writeAppSettings(home, { cli: null });
      return { summary: `retake command ${r}: ${link}`, data: { ok: true, path: link, result: r } };
    },
  });

  const claudeRun = defineTool({
    name: 'setup_claude_code_run',
    title: 'Register with Claude Code',
    description: "Run the plugin route's two lines with the claude found in a fixed list (no shell). The desktop app's own server only.",
    input: z.strictObject({}),
    annotations: { ...WRITE_ANN, openWorldHint: true },
    async run() {
      const ctx = o.ctx();
      const b = gate(pipe, ctx, state, true);
      const claude = findClaude(ctx.home, ctx.isExec);
      if (!claude) throw refused('no_claude', `Claude Code was not found (${claudeCandidates(ctx.home).join(', ')}): copy the lines into Terminal`);
      const steps = claudeSteps(b, ctx, workspace);
      if (!steps) throw refused('no_plugin', 'this copy of Retake has no Claude plugin: install it again from its disk image');
      // One run at a time (review c A-L5): two would write the same Claude Code settings.
      if (state.claudeRunning) throw refused('busy', 'a Claude Code run is in flight: wait for its answer');
      state.claudeRunning = true;
      let r;
      try {
        r = await runClaudeSteps(claude, steps.steps, { env: claudeEnv(claude, ctx.env, join(b.paths.node, '..')), ...(ctx.claudeTimeoutMs ? { timeoutMs: ctx.claudeTimeoutMs } : {}) });
      } finally {
        state.claudeRunning = false;
      }
      return {
        summary: r.ok ? 'registered with Claude Code' : r.timedOut ? 'Claude Code did not finish in time: run the lines in Terminal' : 'Claude Code refused: see its output',
        data: { ok: r.ok, timed_out: r.timedOut, claude, untrusted: { steps: r.steps.map((s) => ({ line: ['claude', ...s.argv].join(' '), code: s.code, output: s.output, ms: s.ms })) } },
      };
    },
  });

  const desktopAdd = defineTool({
    name: 'setup_claude_desktop_add',
    title: 'Add to Claude Desktop',
    description: "Merge the retake entry into Claude Desktop's config (a backup first; a different entry needs replace). The desktop app's own server only.",
    input: z.strictObject({ replace: z.boolean().default(false).describe('Replace a different retake entry.') }),
    annotations: WRITE_ANN,
    async run(a: { replace: boolean }) {
      const ctx = o.ctx();
      const b = gate(pipe, ctx, state, true);
      // Claude Desktop rewrites its config from memory while it runs (critique M7): it quits first — and when `ps`
      // cannot tell, the write waits too (review c A-L3).
      const running = await readRunning(ctx, state);
      if (running === null) throw refused('claude_unknown', 'Retake could not check whether Claude Desktop is running: quit it (⌘Q in Claude), then Add again — or copy the entry');
      if (running) throw refused('claude_running', 'Claude Desktop is running and may write its config over the change: quit it (⌘Q in Claude), then Add again');
      let r;
      try {
        r = writeDesktopEntry(ctx.desktopConfig, desktopEntry(b, ctx, workspace), { replace: a.replace, backupDir: desktopBackupDir(homeOf(ctx)) });
      } catch (e) {
        setupError(e);
      }
      return {
        summary: r.kind === 'same' ? 'Claude Desktop already has this entry' : `added to Claude Desktop (${r.file})`,
        data: { ok: true, kind: r.kind, file: r.file, ...(r.backup ? { backup: r.backup } : {}) },
      };
    },
  });

  const notifications = defineTool({
    name: 'setup_notifications',
    title: 'Allow notifications',
    description: "Ask the desktop app to request the notification permission. The desktop app's own server only.",
    input: z.strictObject({}),
    annotations: WRITE_ANN,
    async run() {
      gate(pipe, o.ctx(), state, false);
      pipe.setup('notifications');
      return { summary: 'the app asks macOS for the notification permission', data: { ok: true } };
    },
  });

  const done = defineTool({
    name: 'setup_done',
    title: 'Close the set-up',
    description: "Remember that the person closed the Set-up sheet of this version. The desktop app's own server only.",
    input: z.strictObject({}),
    annotations: WRITE_ANN,
    async run() {
      const ctx = o.ctx();
      gate(pipe, ctx, state, false);
      writeAppSettings(homeOf(ctx), { setup_seen: RETAKE_VERSION });
      return { summary: 'set-up closed', data: { ok: true } };
    },
  });

  return [status, install, choose, remove, claudeRun, desktopAdd, notifications, done];
}
