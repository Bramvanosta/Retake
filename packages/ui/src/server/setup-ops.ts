/**
 * The installed app's Set-up sheet (DESIGN §4p (c), docs/reference/studio-ui.md): the Studio's own ops that
 * read and make the integrations — the `retake` command's link, the Claude Code plugin route, the Claude Desktop
 * entry, the notification permission — each on the person's click. The rules are @retake/engine/integrations
 * (app-setup.ts, config-snippet.ts); here, who may call them and with what:
 *
 * - **Studio only, never MCP tools** (OWN_OPS, the `ui` client's allow-list; a static test checks the MCP list has none):
 *   no MCP tool can install a command or register Retake with Claude (an agent with a shell of its own still can).
 * - **The installed app's own server only:** supervised (`retake ui --supervised`, the desktop shell's pipe attached)
 *   AND run from an app bundle (`….app/Contents/Resources`). Any other server answers setup_status with
 *   `available: false` and refuses every other op (409, reason `not_supervised` / `not_bundled`).
 * - **Where the app runs from**: translocated, a read-only volume or /Volumes — the command and both Claude
 *   registrations are refused (409, reason `location`) with "Move Retake to Applications, then open it again".
 * - **Paths are the server's:** the page sends choices, never a path. Another folder for the command is chosen in the
 *   shell's native panel (`setup_cli_choose` writes a pipe line; the shell answers on the server's stdin: ui.ts →
 *   `SetupState.chose`), checked here (absolute, the person's, writable, outside the workspace and the app).
 * - **Rate-capped:** SETUP_WRITES_PER_MIN writes a minute (busy, 423), like the quit question's acks; one Claude Code
 *   run at a time (409, reason `busy`).
 * - **Claude Desktop running:** `ps` decides; when it cannot tell (it failed), Add is refused too. The
 *   status reads `ps` only when the page asks (`processes`: the Claude Desktop step in view, or the window focused),
 *   at most every PS_EVERY_MS.
 * - **The command's link the app made** is recorded in `<home>/app.json`: the status, Install and Uninstall read it
 *   beside the default folder (a link in a chosen folder survives a restart; a second one elsewhere is refused until it
 *   is uninstalled).
 * - **The shell's Help items follow the command's link:** setup_status (read-only, but it re-reads the disk), Install
 *   and Uninstall (done or refused: the disk may have changed) write the link's state on the pipe when it changed
 *   (setup-context.ts writeCliState: an enum, never the page's).
 * - What other programs wrote (Claude Code's output, Claude Desktop's current entry) is under `untrusted`: the page
 *   shows it as text.
 */
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { z } from 'zod';
import { RETAKE_VERSION } from '@retake/core/base';
import { bundleInfoOrNull } from '@retake/core/io';
import type { BundleInfo } from '@retake/core/io';
import { readFileSync, existsSync } from 'node:fs';
import {
  CLI_NAME,
  LAUNCHER_REL,
  MOVE_TO_APPLICATIONS,
  claudeCandidates,
  claudeDesktopConfigFile,
  claudeEnv,
  desktopBackupDir,
  defaultCliDir,
  findClaude,
  installCliLink,
  installLocationWords,
  onReadOnlyVolume,
  pluginInstallCommands,
  pluginInstallSteps,
  pluginMarketplaceRoot,
  readAppSettings,
  removeCliLink,
  runClaudeSteps,
  setupSeen,
  writeAppSettings,
  writeDesktopEntry,
} from '@retake/engine/integrations';
import type { ClaudeStep, ClaudeRunResult, CliInstallResult, DesktopWriteResult } from '@retake/engine/integrations';
import { defineTool } from '@retake/engine/contract';
import type { ToolOutput } from '@retake/engine/contract';
import { PS_EVERY_MS, READ_ANN, WRITE_ANN, appBundle, desktopEntry, gate, homeOf, installedLink, locationOf, readRunning, refused, registration, setupError, writeCliState } from './setup-context.js';
import type { SetupContext, SetupOpsOptions } from './setup-context.js';
import { cliStatus, desktopPlan } from './setup-status.js';
import type { SetupStatus } from './setup-status.js';

export { PS_EVERY_MS, SETUP_WRITES_PER_MIN, SetupState, applyShellLine, cliMenuState, writeCliState } from './setup-context.js';
export type { SetupContext } from './setup-context.js';
export type { CliStatus, SetupStatus } from './setup-status.js';

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

function claudeSteps(b: BundleInfo, ctx: SetupContext, workspace: string): { steps: ClaudeStep[]; lines: string[] } | null {
  const repo = pluginMarketplaceRoot(join(b.paths.engine, 'dist', 'bin.js'), existsSync, b);
  if (!repo) return null;
  const o = { ...registration(b, ctx, workspace), repo };
  return { steps: pluginInstallSteps(o), lines: pluginInstallCommands(o) };
}

function readText(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** setup_status's answer on the installed app's own server. */
async function readStatus(o: SetupOpsOptions, ctx: SetupContext, b: BundleInfo, processes: boolean): Promise<ToolOutput<SetupStatus>> {
  const { state, workspace } = o;
  const home = homeOf(ctx);
  const settings = readAppSettings(home);
  const location = locationOf(b, ctx);
  const cli = cliStatus(ctx, b, home, state);
  const claude = findClaude(ctx.home, ctx.isExec);
  const steps = claudeSteps(b, ctx, workspace);
  const entry = desktopEntry(b, ctx, workspace);
  const desktop = desktopPlan(readText(ctx.desktopConfig), entry);
  // `ps` only when asked (the step in view, the window focused), at most every PS_EVERY_MS.
  if (processes && (!state.ps || state.now() - state.ps.at >= PS_EVERY_MS)) await readRunning(ctx, state);
  const running = state.ps?.running;
  const untrusted: NonNullable<SetupStatus['untrusted']> = {};
  if (desktop.current !== undefined) untrusted.desktop_current = JSON.stringify({ mcpServers: { retake: desktop.current } }, null, 2);
  if (desktop.problem) untrusted.desktop_problem = desktop.problem;
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
      cli,
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
        state: desktop.state,
        entry: JSON.stringify({ mcpServers: { retake: entry } }, null, 2),
        // true / false; null: `ps` could not tell; absent: not read yet.
        ...(running !== undefined ? { running } : {}),
        backups: desktopBackupDir(home),
      },
      notifications: state.notifications,
      ...(Object.keys(untrusted).length ? { untrusted } : {}),
    },
  };
}

function statusOp(o: SetupOpsOptions) {
  return defineTool({
    name: 'setup_status',
    title: 'Set-up of the installed app',
    description: "The installed app's set-up: where it runs from, the retake command, Claude Code and Claude Desktop, notifications. The desktop app's own server only.",
    input: z.strictObject({ processes: z.boolean().default(false).describe('Read the process list too (is Claude Desktop running?), at most every 5 s.') }),
    annotations: READ_ANN,
    async run(a: { processes: boolean }): Promise<ToolOutput<SetupStatus>> {
      const ctx = o.ctx();
      if (!o.pipe.supervised) return { summary: "set-up: not the desktop app's server", data: { available: false, reason: 'not_supervised' } };
      const b = appBundle(ctx);
      if (!b) return { summary: 'set-up: not an installed app', data: { available: false, reason: 'not_bundled' } };
      // The shell's Help items follow what this read finds (a line only when it changed).
      writeCliState(o.pipe, ctx);
      return readStatus(o, ctx, b, a.processes);
    },
  });
}

function cliInstallOp(o: SetupOpsOptions) {
  const { pipe, state } = o;
  return defineTool({
    name: 'setup_cli_install',
    title: 'Install the retake command',
    description: "Link the retake command to this app (the default folder, or the folder chosen in the app's panel). The desktop app's own server only.",
    input: z.strictObject({ folder: z.enum(['default', 'chosen']).default('default'), replace: z.boolean().default(false).describe('Replace a link to another copy of Retake.') }),
    annotations: WRITE_ANN,
    async run(a: { folder: 'default' | 'chosen'; replace: boolean }) {
      const ctx = o.ctx();
      const b = gate(pipe, ctx, state, true);
      // Done or refused, the shell's Help items follow the disk.
      try {
        return installCli(o, ctx, b, a);
      } finally {
        writeCliState(pipe, ctx);
      }
    },
  });
}

function installCli(o: SetupOpsOptions, ctx: SetupContext, b: BundleInfo, a: { folder: 'default' | 'chosen'; replace: boolean }) {
  let dir = defaultCliDir(ctx.home);
  if (a.folder === 'chosen') {
    const c = o.state.chosen;
    if (!c || !('dir' in c)) throw refused('no_choice', 'no folder was chosen: Choose a Folder… first');
    dir = c.dir;
  }
  const home = homeOf(ctx);
  const launcher = join(b.root, LAUNCHER_REL);
  // One command per app: a second link elsewhere would be forgotten by Uninstall.
  const there = installedLink(ctx, home, launcher);
  if (there && there !== join(dir, CLI_NAME))
    throw refused('installed_elsewhere', `the command is installed already: ${there} — Uninstall it first, then install it in the other folder`, { installed: there });
  let r: CliInstallResult;
  try {
    r = installCliLink(dir, launcher, { replace: a.replace, createDir: a.folder === 'default' });
  } catch (e) {
    setupError(e);
  }
  writeAppSettings(home, { cli: { path: r.path, at: new Date().toISOString() } });
  return { summary: `retake command ${r.result}: ${r.path}`, data: { ok: true, path: r.path, result: r.result } };
}

function cliChooseOp(o: SetupOpsOptions) {
  const { pipe, state } = o;
  return defineTool({
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
}

function cliRemoveOp(o: SetupOpsOptions) {
  const { pipe, state } = o;
  return defineTool({
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
        // Refused: the shell's Help items follow the disk all the same.
        writeCliState(pipe, ctx);
        setupError(e);
      }
      writeAppSettings(home, { cli: null });
      writeCliState(pipe, ctx);
      return { summary: `retake command ${r}: ${link}`, data: { ok: true, path: link, result: r } };
    },
  });
}

function claudeCodeRunOp(o: SetupOpsOptions) {
  const { pipe, state, workspace } = o;
  return defineTool({
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
      // One run at a time: two would write the same Claude Code settings.
      if (state.claudeRunning) throw refused('busy', 'a Claude Code run is in flight: wait for its answer');
      state.claudeRunning = true;
      let r: ClaudeRunResult;
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
}

function claudeDesktopAddOp(o: SetupOpsOptions) {
  const { pipe, state, workspace } = o;
  return defineTool({
    name: 'setup_claude_desktop_add',
    title: 'Add to Claude Desktop',
    description: "Merge the retake entry into Claude Desktop's config (a backup first; a different entry needs replace). The desktop app's own server only.",
    input: z.strictObject({ replace: z.boolean().default(false).describe('Replace a different retake entry.') }),
    annotations: WRITE_ANN,
    async run(a: { replace: boolean }) {
      const ctx = o.ctx();
      const b = gate(pipe, ctx, state, true);
      // Claude Desktop rewrites its config from memory while it runs: it quits first — and when `ps`
      // cannot tell, the write waits too.
      const running = await readRunning(ctx, state);
      if (running === null) throw refused('claude_unknown', 'Retake could not check whether Claude Desktop is running: quit it (⌘Q in Claude), then Add again — or copy the entry');
      if (running) throw refused('claude_running', 'Claude Desktop is running and may write its config over the change: quit it (⌘Q in Claude), then Add again');
      let r: DesktopWriteResult;
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
}

function notificationsOp(o: SetupOpsOptions) {
  const { pipe, state } = o;
  return defineTool({
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
}

function doneOp(o: SetupOpsOptions) {
  const { pipe, state } = o;
  return defineTool({
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
}

/** The Studio's setup ops. `ctx` is read on each call (tests swap it). */
export function setupOps(o: SetupOpsOptions) {
  return [statusOp(o), cliInstallOp(o), cliChooseOp(o), cliRemoveOp(o), claudeCodeRunOp(o), claudeDesktopAddOp(o), notificationsOp(o), doneOp(o)];
}
