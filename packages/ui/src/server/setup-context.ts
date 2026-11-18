/**
 * What the setup ops (setup-ops.ts) share: the machine they read (SetupContext), the state the server keeps between
 * them (SetupState), the shell's lines that feed it, and the gate and helpers every op goes through.
 */
import { join } from 'node:path';
import { bestEffort, errorMessage } from '@retake/core/base';
import { bundleNodeArgs, retakeHome } from '@retake/core/io';
import type { BundleInfo } from '@retake/core/io';
import type { UpdateState } from './update-ops.js';
import { EngineError } from '@retake/engine';
import {
  CLI_NAME,
  LAUNCHER_REL,
  MOVE_TO_APPLICATIONS,
  SetupError,
  checkCliFolder,
  claudeDesktopIn,
  cliLinkState,
  defaultCliDir,
  installLocation,
  installLocationWords,
  mcpConfigJson,
  readAppSettings,
} from '@retake/engine/integrations';
import type { InstallLocation } from '@retake/engine/integrations';
import { parseShellLine } from './shell-line.js';
import type { CliState, DesktopPipe } from './desktop.js';

/** Setup writes a minute at most (every op but setup_status). */
export const SETUP_WRITES_PER_MIN = 12;
/** The process list (is Claude Desktop running?) is read at most this often by the status. */
export const PS_EVERY_MS = 5000;

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
      this.chosen = e instanceof SetupError ? { error: e.message, reason: e.reason } : { error: errorMessage(e), reason: 'invalid' };
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
export function applyShellLine(setup: { state: SetupState; context(): SetupContext; pipe?: DesktopPipe }, workspace: string, line: string, update?: UpdateState): boolean {
  const m = parseShellLine(line);
  if (!m) return false;
  // The shell's window became key: the command's link read again (the shell's Help items; a change is written).
  if (m.type === 'cli_refresh') {
    if (setup.pipe) writeCliState(setup.pipe, setup.context());
    return setup.pipe !== undefined;
  }
  // The update's state (update-ops.ts), kept for desktop_update_status; a state that leaves the update's Tools step
  // gives its download up (update-tools.ts).
  if (m.type === 'update') {
    update?.apply(m);
    update?.tools?.follow(m);
    return update !== undefined;
  }
  // the update downloaded and verified — its Tools, before the restart (the answer goes back on the pipe).
  if (m.type === 'update_archive') {
    if (!update?.tools) return false;
    void update.tools.prepare(m);
    return true;
  }
  if (m.type === 'cli_folder') setup.state.chose(m.path, setup.context(), workspace);
  else if (m.type === 'cli_folder_open') setup.state.chosen = { panel: 'open' };
  else if (m.type === 'cli_folder_cancelled') setup.state.chosen = { panel: 'cancelled' };
  else if (m.type === 'notifications') setup.state.notifications = m.state;
  return true;
}

/** The bundle of an installed app (a `.app` around it), else null: a staged tree or a checkout has no set-up. */
export function appBundle(ctx: SetupContext): BundleInfo | null {
  return ctx.bundle?.sealed.endsWith('.app') ? ctx.bundle : null;
}

export function locationOf(b: BundleInfo, ctx: SetupContext): InstallLocation {
  return installLocation(b.sealed, { readOnly: ctx.readOnly(b.sealed) });
}

export function refused(reason: string, message: string, extra: Record<string, unknown> = {}): EngineError {
  return new EngineError('conflict', message, { details: { reason, ...extra } });
}

/**
 * The ops' common gate: the installed app's own server (and, `placed`, an app moved to Applications); `rate` false
 * for a write that only stops something (the Tools' Pause and Cancel): not counted in the minute's writes.
 */
export function gate(pipe: DesktopPipe, ctx: SetupContext, state: SetupState, placed: boolean, rate = true): BundleInfo {
  if (!pipe.supervised) throw refused('not_supervised', "set-up is the installed app's: this Studio server is not the desktop app's");
  const b = appBundle(ctx);
  if (!b) throw refused('not_bundled', "set-up is the installed app's: this Retake runs from a repository checkout (use retake mcp --print-config there)");
  if (placed) {
    const loc = locationOf(b, ctx);
    if (loc !== 'ok') throw refused('location', `${installLocationWords(loc)}: ${MOVE_TO_APPLICATIONS}`, { location: loc });
  }
  if (rate && !state.take()) throw new EngineError('busy', `too many set-up requests this minute (at most ${SETUP_WRITES_PER_MIN}): wait a moment`, { details: { reason: 'rate' } });
  return b;
}

export const READ_ANN = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
export const WRITE_ANN = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

export function setupError(e: unknown): never {
  if (e instanceof SetupError) throw new EngineError('conflict', e.message, { details: { reason: e.reason, ...e.details } });
  throw e;
}

/** The registration's inputs: the bundle's Node.js (with its guard), its CLI, the workspace, RETAKE_HOME when set. */
export function registration(b: BundleInfo, ctx: SetupContext, workspace: string) {
  const bin = join(b.paths.engine, 'dist', 'bin.js');
  return { root: workspace, bin, node: b.paths.node, nodeArgs: bundleNodeArgs(b), env: ctx.env };
}

export function desktopEntry(b: BundleInfo, ctx: SetupContext, workspace: string): Record<string, unknown> {
  return mcpConfigJson(registration(b, ctx, workspace)).mcpServers.retake as unknown as Record<string, unknown>;
}

/** The command's link the app recorded (app.json), when it still runs this app. */
export function recordedLink(home: string, launcher: string): string | null {
  const p = readAppSettings(home).cli?.path;
  return p && cliLinkState(p, launcher).state === 'ours' ? p : null;
}

/** This app's command: the link the app recorded, else the default folder's when it runs this app; null: none. */
export function installedLink(ctx: SetupContext, home: string, launcher: string): string | null {
  const fallback = join(defaultCliDir(ctx.home), CLI_NAME);
  return recordedLink(home, launcher) ?? (cliLinkState(fallback, launcher).state === 'ours' ? fallback : null);
}

/**
 * The command's link for the shell's Help items (desktop.ts CLI_STATES), read now from the disk: this app's (`ours`:
 * the recorded link, else the default folder's), else the state of the link the app recorded, else the default
 * folder's.
 */
export function cliMenuState(ctx: SetupContext, b: BundleInfo, home: string): CliState {
  const launcher = join(b.root, LAUNCHER_REL);
  if (installedLink(ctx, home, launcher)) return 'ours';
  return cliLinkState(readAppSettings(home).cli?.path ?? join(defaultCliDir(ctx.home), CLI_NAME), launcher).state;
}

let saidCliUnread = false;

/**
 * Tell the shell the command's link as read now — the installed app's supervised server only (nothing otherwise),
 * written when it changed (DesktopPipe.cli). Truly best effort: whatever goes wrong (a pipe that closed, a link that
 * cannot be read) writes nothing, throws nothing — it runs from the shell's stdin listener, at start and in the
 * `finally` of install / uninstall, none of which it may fail — and says so once on stderr (`log`).
 */
export function writeCliState(pipe: DesktopPipe, ctx: SetupContext, log: (m: string) => void = (m) => void process.stderr.write(`${m}\n`)): void {
  try {
    if (!pipe.supervised) return;
    const b = appBundle(ctx);
    if (!b) return;
    pipe.cli(cliMenuState(ctx, b, retakeHome(ctx.env)));
  } catch (e) {
    if (e instanceof EngineError) return;
    if (!saidCliUnread) log("retake ui: the command's link could not be read: the app's Help items keep their last state");
    saidCliUnread = true;
  }
}

/** Is Claude Desktop running: true / false, null when `ps` could not tell (a fresh read, remembered). */
export async function readRunning(ctx: SetupContext, state: SetupState): Promise<boolean | null> {
  const list = await bestEffort(ctx.processes(), 'processes that cannot be listed: null, the sheet says it cannot tell', null);
  const running = list === null ? null : claudeDesktopIn(list);
  state.ps = { at: state.now(), running };
  return running;
}

/** What the setup ops close over: the desktop pipe, the server's set-up state, the machine (read on each call), the workspace. */
export interface SetupOpsOptions {
  pipe: DesktopPipe;
  state: SetupState;
  ctx: () => SetupContext;
  workspace: string;
}

export const homeOf = (ctx: SetupContext) => retakeHome(ctx.env);
