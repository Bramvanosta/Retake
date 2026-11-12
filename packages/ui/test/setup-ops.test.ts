/**
 * L5.16c — the installed app's setup ops (setup-ops.ts; DESIGN §4p (c)), through the Studio server's HTTP API with an
 * injected machine (a fake app, a scratch HOME, a fake `claude`, scratch Claude Desktop configs, a fake process list —
 * never the person's): Studio only (own ops in the `ui` allow-list, never MCP tools: no MCP tool can install the command
 * or register Retake), the installed app's own server only (supervised AND bundled), refused from a translocated copy /
 * a disk image / /Volumes (critique H1), paths the server's (the folder from the shell's panel, checked), the command's
 * link (a foreign file refused), the Claude Code run (argv, untrusted output), the Claude Desktop merge (running Claude
 * Desktop, unparsable JSON, a symlinked config, Replace), the rate cap, `setup_done` and the shell's stdin lines.
 * L5.16c fixes: the link the app recorded survives a restart (review c B-M1: no second link elsewhere, Uninstall takes
 * the recorded one), Claude Code's environment is the small one at the op too, one run at a time, a folder inside the app
 * refused when it arrives, Uninstall from a misplaced app, `ps` failing refuses Add (A-L3) and is read only when asked,
 * at most every 5 s (A-L8), the folder panel's open / cancelled lines (A-L7), the line cap in bytes (B-L8).
 */
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RETAKE_VERSION } from '@retake/core';
import { readAppSettings } from '@retake/engine/integrations';
import type { BundleInfo } from '@retake/core/io';
import { TOOLS } from '@retake/mcp';
import { OWN_OPS, PS_EVERY_MS, SETUP_OPS, SETUP_WRITES_PER_MIN, SHELL_LINE_MAX, UI_OPS, applyShellLine, parseShellLine, startStudioServer } from '../src/index.js';
import type { SetupContext, StudioServer } from '../src/index.js';
import { fixtureWorkspace } from '@retake/test-support/workspace';
import { raw } from '@retake/test-support/http';
import { shellLineReader } from '../../cli/src/commands/ui.js';
import { scratchHome } from '@retake/test-support/home';

const base = realpathSync(mkdtempSync(join(tmpdir(), 'setup-ops-')));
const ws = join(base, 'ws');
const retakeHome = scratchHome();
let studio: StudioServer;
let ctx: SetupContext;
const lines: string[] = [];
let running: string | null = '';
let psCalls = 0;

/** A fake installed app under `dir`: launcher, Node.js, guard, engine entry, plugin marketplace. */
function fakeApp(dir: string): BundleInfo {
  const sealed = join(dir, 'Retake.app');
  const root = join(sealed, 'Contents', 'Resources');
  for (const d of ['bin', 'node/bin', 'engine/dist', 'plugin/.claude-plugin', 'plugin/skills/.claude-plugin']) mkdirSync(join(root, d), { recursive: true });
  for (const [f, text] of [
    ['bin/retake', '#!/bin/sh\n'],
    ['node/bin/node', '#!/bin/sh\n'],
    ['node/guard.cjs', ''],
    ['engine/dist/bin.js', ''],
    ['plugin/.claude-plugin/marketplace.json', '{}'],
    ['plugin/skills/.claude-plugin/plugin.json', '{}'],
  ] as const)
    writeFileSync(join(root, f), text);
  chmodSync(join(root, 'bin/retake'), 0o755);
  return {
    root,
    sealed,
    manifest: {} as BundleInfo['manifest'],
    paths: { node: join(root, 'node/bin/node'), engine: join(root, 'engine'), browsers: join(root, 'browsers'), ffmpeg: null, templates: join(root, 'engine/templates'), plugin: join(root, 'plugin') },
  };
}

const home = join(base, 'home');
const app = fakeApp(join(base, 'Applications'));
const desktopConfig = join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
const machine = (o: Partial<SetupContext> = {}): SetupContext => ({
  bundle: app,
  home,
  env: { PATH: '/usr/bin:/bin', RETAKE_HOME: join(base, 'retake-home'), CLAUDE_CONFIG_DIR: join(base, 'claude-cfg') },
  uid: process.getuid!(),
  readOnly: () => false,
  processes: async () => (psCalls++, running),
  desktopConfig,
  ...o,
});

beforeAll(async () => {
  mkdirSync(ws);
  mkdirSync(home);
  retakeHome.use(join(base, 'retake-home'));
  await fixtureWorkspace(ws);
  ctx = machine();
  await startServer();
});

afterAll(async () => {
  await studio?.close();
  retakeHome.restore();
  rmSync(base, { recursive: true, force: true });
});

const call = async (op: string, args: Record<string, unknown> = {}) => {
  const r = await raw(studio.port, 'POST', `/v1/call/${op}`, { authorization: `Bearer ${studio.token}`, 'content-type': 'application/json' }, JSON.stringify(args));
  return { status: r.status, body: r.json<{ data: Record<string, any>; error: { code: string; message: string; details?: { reason?: string } } }>() };
};
const reason = (r: Awaited<ReturnType<typeof call>>) => r.body.error?.details?.reason;
/** Writes are capped a minute: a fresh window for each test. */
const freshWindow = () => ((studio.setup.state as unknown as { window: { start: number; count: number } }).window = { start: 0, count: 0 });
/** The process list is read at most every 5 s: forget the last read. */
const freshPs = () => (studio.setup.state.ps = undefined);
const startServer = async () => {
  studio = await startStudioServer({ root: ws, startWorker: false, setup: () => ctx });
};

describe('who may call them', () => {
  it('Studio-only own ops in the ui allow-list; never MCP tools', () => {
    for (const op of SETUP_OPS) {
      expect(OWN_OPS as readonly string[]).toContain(op);
      expect(UI_OPS as readonly string[]).toContain(op);
    }
    const mcp = TOOLS.map((t) => t.name);
    expect(mcp.filter((n) => n.startsWith('setup') || (SETUP_OPS as readonly string[]).includes(n))).toEqual([]);
    expect(SETUP_OPS).toEqual(['setup_status', 'setup_cli_install', 'setup_cli_choose', 'setup_cli_remove', 'setup_claude_code_run', 'setup_claude_desktop_add', 'setup_notifications', 'setup_done']);
  });

  it("not the desktop app's server (not supervised): status says so, every other op is refused", async () => {
    expect((await call('setup_status')).body.data).toEqual({ available: false, reason: 'not_supervised' });
    for (const op of SETUP_OPS.slice(1)) {
      const r = await call(op);
      expect(r.status, op).toBe(409);
      expect(reason(r), op).toBe('not_supervised');
    }
    expect(lines).toEqual([]);
  });

  it('supervised but no installed app (a checkout, a staged tree): not_bundled', async () => {
    studio.desktop.attach((l) => (lines.push(l), true));
    for (const bundle of [null, { ...app, sealed: join(base, 'stage') }]) {
      ctx = machine({ bundle });
      expect((await call('setup_status')).body.data).toEqual({ available: false, reason: 'not_bundled' });
      expect(reason(await call('setup_cli_install'))).toBe('not_bundled');
      expect(reason(await call('setup_done'))).toBe('not_bundled');
    }
    ctx = machine();
  });

  it('critique H1: from a translocated copy, its disk image or /Volumes, the command and Claude are refused; notifications and Done are not', async () => {
    freshWindow();
    const trans = fakeApp(join(base, 'AppTranslocation', '0A1B', 'd'));
    for (const [bundle, ro, loc] of [
      [trans, false, 'translocated'],
      [app, true, 'read_only'],
    ] as const) {
      ctx = machine({ bundle, readOnly: () => ro });
      const s = (await call('setup_status')).body.data;
      expect(s).toMatchObject({ available: true, location: loc });
      expect(s.location_words).toMatch(/Move Retake to Applications, then open it again$/);
      for (const op of ['setup_cli_install', 'setup_cli_choose', 'setup_claude_code_run', 'setup_claude_desktop_add']) {
        const r = await call(op);
        expect(r.status, op).toBe(409);
        expect(reason(r), op).toBe('location');
      }
    }
    expect(existsSync(join(home, '.local'))).toBe(false);
    expect((await call('setup_notifications')).status).toBe(200);
    expect(lines.at(-1)).toBe('{"type":"setup","action":"notifications"}');
    ctx = machine();
  });
});

describe('the retake command', () => {
  it('status, install into ~/.local/bin (recorded in app.json), a second install kept, uninstall; a foreign file refused', async () => {
    freshWindow();
    const s = (await call('setup_status')).body.data;
    expect(s).toMatchObject({
      available: true,
      version: RETAKE_VERSION,
      seen: false,
      location: 'ok',
      workspace: realpathSync(ws),
      home: join(base, 'retake-home'),
      home_from_env: true,
      app: app.sealed,
    });
    expect(s.cli).toMatchObject({
      dir: join(home, '.local', 'bin'),
      state: 'absent',
      installed: null,
      on_path: false,
      first: null,
      path_line: 'export PATH="$HOME/.local/bin:$PATH"',
      profile: '~/.zprofile',
      launcher: join(app.root, 'bin', 'retake'),
    });
    const r = await call('setup_cli_install', { folder: 'default' });
    expect(r.body.data).toMatchObject({ ok: true, result: 'created', path: join(home, '.local', 'bin', 'retake') });
    expect(readlinkSync(join(home, '.local', 'bin', 'retake'))).toBe(join(app.root, 'bin', 'retake'));
    expect(readAppSettings(join(base, 'retake-home')).cli?.path).toBe(join(home, '.local', 'bin', 'retake'));
    expect((await call('setup_cli_install')).body.data.result).toBe('kept');
    expect((await call('setup_status')).body.data.cli).toMatchObject({ state: 'ours', installed: join(home, '.local', 'bin', 'retake') });
    // The page sends no path: an extra field is a 400.
    expect((await call('setup_cli_install', { folder: '/tmp' })).status).toBe(400);
    expect((await call('setup_cli_install', { dir: '/tmp' })).status).toBe(400);
    expect((await call('setup_cli_remove')).body.data).toMatchObject({ result: 'removed' });
    expect(existsSync(join(home, '.local', 'bin', 'retake'))).toBe(false);
    expect(readAppSettings(join(base, 'retake-home')).cli).toBeUndefined();
    writeFileSync(join(home, '.local', 'bin', 'retake'), '#!/bin/sh\nexec pnpm retake "$@"\n');
    const f = await call('setup_cli_install');
    expect(f.status).toBe(409);
    expect(reason(f)).toBe('foreign');
    expect(reason(await call('setup_cli_remove'))).toBe('foreign');
    expect(readFileSync(join(home, '.local', 'bin', 'retake'), 'utf8')).toContain('pnpm retake');
    expect((await call('setup_status')).body.data.cli).toMatchObject({ state: 'foreign', what: 'file' });
    rmSync(join(home, '.local', 'bin', 'retake'));
  });

  it("another folder: the shell's panel (a pipe line), its answer on stdin checked, then installed there; a bad one said", async () => {
    freshWindow();
    expect((await call('setup_cli_choose')).status).toBe(200);
    expect(lines.at(-1)).toBe('{"type":"setup","action":"cli_folder"}');
    const tools = join(home, 'tools');
    mkdirSync(tools);
    expect(applyShellLine(studio.setup, ws, JSON.stringify({ type: 'cli_folder', path: tools }))).toBe(true);
    expect((await call('setup_status')).body.data.cli).toMatchObject({ dir: tools, chosen: true, link: join(tools, 'retake') });
    expect((await call('setup_cli_install', { folder: 'chosen' })).body.data).toMatchObject({ result: 'created', path: join(tools, 'retake') });
    expect(lstatSync(join(tools, 'retake')).isSymbolicLink()).toBe(true);
    // A folder inside the workspace: refused when it arrives, said in the status; nothing chosen.
    await call('setup_cli_choose');
    applyShellLine(studio.setup, ws, JSON.stringify({ type: 'cli_folder', path: join(ws, 'projects') }));
    const s = (await call('setup_status')).body.data.cli;
    expect(s.chosen).toBe(false);
    expect(s.chosen_error).toMatch(/inside the workspace/);
    expect(reason(await call('setup_cli_install', { folder: 'chosen' }))).toBe('no_choice');
    // The other lines: the notification state; anything else dropped.
    expect(applyShellLine(studio.setup, ws, '{"type":"notifications","state":"on"}')).toBe(true);
    expect((await call('setup_status')).body.data.notifications).toBe('on');
    expect(applyShellLine(studio.setup, ws, '{"type":"cli_folder","path":"relative"}')).toBe(false);
  });
});

describe('the command after a restart (review c B-M1) and the other fixes', () => {
  it('the link the app made in a chosen folder survives a restart: shown as installed, no second link elsewhere, Uninstall takes the recorded one', async () => {
    freshWindow();
    const tools = join(home, 'tools');
    const recorded = join(tools, 'retake');
    const fallback = join(home, '.local', 'bin', 'retake');
    // The test before installed into ~/tools (app.json names it). A new server knows nothing of that choice.
    expect(readAppSettings(join(base, 'retake-home')).cli?.path).toBe(recorded);
    await studio.close();
    await startServer();
    studio.desktop.attach((l) => (lines.push(l), true));
    const s = (await call('setup_status')).body.data.cli;
    expect(s).toMatchObject({ dir: tools, link: recorded, state: 'ours', installed: recorded, chosen: false });
    // Install into the default folder: refused, the recorded one named; nothing made there.
    const r = await call('setup_cli_install', { folder: 'default' });
    expect(r.status).toBe(409);
    expect(reason(r)).toBe('installed_elsewhere');
    // (Paths outside the workspace are shortened in an error's words.)
    expect(r.body.error.message).toMatch(/^the command is installed already: .*\/retake — Uninstall it first/);
    expect(existsSync(fallback)).toBe(false);
    // A link of this app in the default folder too (made by hand): Uninstall takes the recorded one, the other stays.
    mkdirSync(join(fallback, '..'), { recursive: true });
    symlinkSync(join(app.root, 'bin', 'retake'), fallback);
    expect((await call('setup_cli_remove')).body.data).toMatchObject({ result: 'removed', path: recorded });
    expect(existsSync(recorded)).toBe(false);
    expect(lstatSync(fallback).isSymbolicLink()).toBe(true);
    // Then the default folder's link is this app's command; Uninstall again takes it.
    expect((await call('setup_status')).body.data.cli).toMatchObject({ dir: join(home, '.local', 'bin'), state: 'ours', installed: fallback });
    expect((await call('setup_cli_remove')).body.data).toMatchObject({ result: 'removed', path: fallback });
    expect(existsSync(fallback)).toBe(false);
  });

  it('a folder inside the app is refused when it arrives; the panel is said only once the shell opened it (review c A-L7)', async () => {
    freshWindow();
    await call('setup_cli_choose');
    expect((await call('setup_status')).body.data.cli.panel).toBeUndefined();
    expect(applyShellLine(studio.setup, ws, '{"type":"cli_folder_open"}')).toBe(true);
    expect((await call('setup_status')).body.data.cli.panel).toBe('open');
    applyShellLine(studio.setup, ws, JSON.stringify({ type: 'cli_folder', path: join(app.root, 'bin') }));
    const s = (await call('setup_status')).body.data.cli;
    expect(s).toMatchObject({ chosen: false });
    expect(s.panel).toBeUndefined();
    expect(s.chosen_error).toMatch(/inside the app/);
    // Cancelled (or another question was up): said; a new Choose forgets it.
    applyShellLine(studio.setup, ws, '{"type":"cli_folder_cancelled"}');
    expect((await call('setup_status')).body.data.cli.panel).toBe('cancelled');
    await call('setup_cli_choose');
    expect((await call('setup_status')).body.data.cli.panel).toBeUndefined();
  });

  it('Uninstall works from a misplaced app (it only takes a link away)', async () => {
    freshWindow();
    const trans = fakeApp(join(base, 'AppTranslocation', '9F9F', 'd'));
    const link = join(home, '.local', 'bin', 'retake');
    symlinkSync(join(trans.root, 'bin', 'retake'), link);
    ctx = machine({ bundle: trans });
    expect(reason(await call('setup_cli_install'))).toBe('location');
    const r = await call('setup_cli_remove');
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ result: 'removed', path: link });
    expect(existsSync(link)).toBe(false);
    ctx = machine();
  });

  it('the process list: read only when asked, at most every PS_EVERY_MS (review c A-L8)', async () => {
    freshPs();
    const before = psCalls;
    await call('setup_status');
    expect(psCalls).toBe(before);
    expect((await call('setup_status')).body.data.claude_desktop.running).toBeUndefined();
    for (let i = 0; i < 3; i++) await call('setup_status', { processes: true });
    expect(psCalls).toBe(before + 1);
    // PS_EVERY_MS later: read again.
    studio.setup.state.ps!.at -= PS_EVERY_MS;
    await call('setup_status', { processes: true });
    expect(psCalls).toBe(before + 2);
    // Add always reads it afresh.
    freshWindow();
    await call('setup_claude_desktop_add');
    expect(psCalls).toBe(before + 3);
  });

  it("Claude Code at the op: the small environment (nothing of the server's), one run at a time (409 busy)", async () => {
    freshWindow();
    const bin = join(home, '.local', 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'claude'), '#!/bin/sh\nenv | sort\nsleep 1\n');
    chmodSync(join(bin, 'claude'), 0o755);
    ctx = machine({ env: { ...machine().env, SECRET_X: 'leak-me', NODE_OPTIONS: '--require /evil.js', HOME: home } });
    const first = call('setup_claude_code_run');
    await new Promise((r) => setTimeout(r, 300));
    const second = await call('setup_claude_code_run');
    expect(second.status).toBe(409);
    expect(reason(second)).toBe('busy');
    const r = await first;
    expect(r.body.data.ok).toBe(true);
    const out = r.body.data.untrusted.steps[0].output as string;
    expect(out).toContain(`CLAUDE_CONFIG_DIR=${join(base, 'claude-cfg')}`);
    expect(out).toContain(`HOME=${home}`);
    expect(out).not.toMatch(/SECRET_X|leak-me|NODE_OPTIONS|RETAKE_HOME/);
    // Free again once it answered.
    writeFileSync(join(bin, 'claude'), '#!/bin/sh\nexit 0\n');
    expect((await call('setup_claude_code_run')).body.data.ok).toBe(true);
    rmSync(join(bin, 'claude'));
    ctx = machine();
  });
});

describe('Claude Code', () => {
  it("Run: the plugin route's two lines as argv with the claude of the fixed list; its output under untrusted; none found → copy only", async () => {
    freshWindow();
    expect(reason(await call('setup_claude_code_run'))).toBe('no_claude');
    const s = (await call('setup_status')).body.data.claude_code;
    expect(s).toMatchObject({ claude: null, config_dir: join(base, 'claude-cfg'), plugin: true });
    expect(s.lines).toEqual([
      `claude plugin marketplace add ${app.paths.plugin}`,
      expect.stringMatching(
        new RegExp(
          `^cd ${realpathSync(ws)} && claude plugin install retake@retake --scope local --config node=${app.paths.node} --config cli=${join(app.root, 'engine', 'dist', 'bin.js')} --config workspace=`,
        ),
      ),
    ]);
    const bin = join(home, '.local', 'bin');
    mkdirSync(bin, { recursive: true });
    const log = join(base, 'claude.log');
    writeFileSync(join(bin, 'claude'), `#!/bin/sh\necho "$@" >> '${log}'\necho "CLAUDE_CONFIG_DIR=$CLAUDE_CONFIG_DIR <b>ok</b>"\n`);
    chmodSync(join(bin, 'claude'), 0o755);
    const r = await call('setup_claude_code_run');
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ ok: true, timed_out: false, claude: join(bin, 'claude') });
    expect(r.body.data.untrusted.steps).toHaveLength(2);
    expect(r.body.data.untrusted.steps[0]).toMatchObject({ line: `claude plugin marketplace add ${app.paths.plugin}`, code: 0, output: `CLAUDE_CONFIG_DIR=${join(base, 'claude-cfg')} <b>ok</b>\n` });
    const calls = (await readFile(log, 'utf8')).trim().split('\n');
    expect(calls[0]).toBe(`plugin marketplace add ${app.paths.plugin}`);
    expect(calls[1]).toMatch(/^plugin install retake@retake --scope local --config node=/);
    rmSync(join(bin, 'claude'));
  });
});

describe('Claude Desktop', () => {
  it('status shows the exact entry; Add refused while it runs, on unparsable JSON; a symlinked config written at its real path; a different entry needs Replace', async () => {
    freshWindow();
    freshPs();
    let s = (await call('setup_status', { processes: true })).body.data.claude_desktop;
    expect(s).toMatchObject({ file: desktopConfig, folder: false, state: 'create', running: false, backups: join(base, 'retake-home', 'backups', 'claude-desktop') });
    const entry = JSON.parse(s.entry).mcpServers.retake;
    expect(entry).toMatchObject({ command: app.paths.node, args: ['--require', join(app.root, 'node', 'guard.cjs'), join(app.root, 'engine', 'dist', 'bin.js'), '--root', realpathSync(ws), 'mcp'] });
    // No Claude folder: nothing created under the scratch ~/Library.
    expect(reason(await call('setup_claude_desktop_add'))).toBe('no_claude');
    expect(existsSync(join(home, 'Library'))).toBe(false);
    mkdirSync(join(desktopConfig, '..'), { recursive: true });
    // Running: refused, the person quits it first.
    running = '/sbin/launchd\n/Applications/Claude.app/Contents/MacOS/Claude\n';
    freshPs();
    expect((await call('setup_status', { processes: true })).body.data.claude_desktop.running).toBe(true);
    expect(reason(await call('setup_claude_desktop_add'))).toBe('claude_running');
    // Review c A-L3: `ps` failing — it cannot tell: Add refused too, said in the status (null).
    running = null;
    expect(reason(await call('setup_claude_desktop_add'))).toBe('claude_unknown');
    expect((await call('setup_status')).body.data.claude_desktop.running).toBeNull();
    expect(existsSync(desktopConfig)).toBe(false);
    running = '';
    // Unparsable: refused, said in the status (under untrusted), left as it is.
    writeFileSync(desktopConfig, '{ "theme": ');
    s = (await call('setup_status')).body;
    expect(s.data.claude_desktop.state).toBe('unreadable');
    expect(s.data.untrusted.desktop_problem).toMatch(/not valid JSON/);
    expect(reason(await call('setup_claude_desktop_add'))).toBe('unparsable');
    expect(readFileSync(desktopConfig, 'utf8')).toBe('{ "theme": ');
    // A symlinked config (dotfiles): written at its real path, every other key kept, the link still a link.
    rmSync(desktopConfig);
    const real = join(base, 'dotfiles-claude.json');
    writeFileSync(real, JSON.stringify({ theme: 'dark', mcpServers: { files: { command: 'x' } } }));
    symlinkSync(real, desktopConfig);
    const r = await call('setup_claude_desktop_add');
    expect(r.body.data).toMatchObject({ ok: true, kind: 'add', file: real });
    // Review c A-L2: the backup went to Retake's folder, never beside the dotfiles' file.
    expect(r.body.data.backup).toMatch(new RegExp(`^${join(base, 'retake-home', 'backups', 'claude-desktop')}/dotfiles-claude\\.json\\.retake-backup-`));
    expect(existsSync(r.body.data.backup)).toBe(true);
    expect(readdirSync(base).filter((f) => f.startsWith('dotfiles-claude.json'))).toEqual(['dotfiles-claude.json']);
    expect(lstatSync(desktopConfig).isSymbolicLink()).toBe(true);
    expect(JSON.parse(readFileSync(real, 'utf8'))).toEqual({ theme: 'dark', mcpServers: { files: { command: 'x' }, retake: entry } });
    expect((await call('setup_status')).body.data.claude_desktop.state).toBe('same');
    // A different entry: refused without Replace, both shown (the one there now under untrusted).
    writeFileSync(real, JSON.stringify({ mcpServers: { retake: { command: 'node', args: ['/old/bin.js'] } } }));
    s = (await call('setup_status')).body;
    expect(s.data.claude_desktop.state).toBe('replace');
    expect(JSON.parse(s.data.untrusted.desktop_current)).toEqual({ mcpServers: { retake: { command: 'node', args: ['/old/bin.js'] } } });
    expect(reason(await call('setup_claude_desktop_add'))).toBe('needs_replace');
    expect((await call('setup_claude_desktop_add', { replace: true })).body.data.kind).toBe('replace');
  });
});

describe('the rest', () => {
  it('rate cap: SETUP_WRITES_PER_MIN writes a minute, then busy (423); status is not capped', async () => {
    freshWindow();
    for (let i = 0; i < SETUP_WRITES_PER_MIN; i++) expect((await call('setup_notifications')).status).toBe(200);
    const r = await call('setup_notifications');
    expect(r.status).toBe(423);
    expect(reason(r)).toBe('rate');
    expect((await call('setup_status')).status).toBe(200);
  });

  it('Done remembers this version; the sheet then stays closed at start', async () => {
    freshWindow();
    expect((await call('setup_done')).status).toBe(200);
    expect(readAppSettings(join(base, 'retake-home')).setup_seen).toBe(RETAKE_VERSION);
    expect((await call('setup_status')).body.data.seen).toBe(true);
  });

  it("the shell's stdin lines are strict, and the CLI reads them with the same cap", async () => {
    expect(parseShellLine('{"type":"cli_folder","path":"/Users/me/bin"}')).toEqual({ type: 'cli_folder', path: '/Users/me/bin' });
    expect(parseShellLine('{"type":"cli_folder_cancelled"}')).toEqual({ type: 'cli_folder_cancelled' });
    expect(parseShellLine('{"type":"notifications","state":"off"}')).toEqual({ type: 'notifications', state: 'off' });
    for (const bad of [
      '{"type":"cli_folder","path":"bin"}',
      '{"type":"cli_folder","path":"/a\\nb"}',
      '{"type":"cli_folder","path":"/a\\u0000b"}',
      '{"type":"cli_folder","path":"/a","extra":1}',
      `{"type":"cli_folder","path":"/${'a'.repeat(4096)}"}`,
      '{"type":"notifications","state":"maybe"}',
      '{"type":"install","path":"/x"}',
      '[1]',
      'not json',
      `{"type":"cli_folder_cancelled","x":"${'a'.repeat(SHELL_LINE_MAX)}"}`,
      // Review c B-L1: a valid shape past the cap (JSON spaces) — the cap alone refuses it.
      `{"type":"cli_folder_cancelled"${' '.repeat(SHELL_LINE_MAX)}}`,
      // Review c B-L8: the cap counts bytes — a path of 3000 three-byte characters (9000 bytes, 3000 UTF-16 units).
      `{"type":"cli_folder","path":"/${'\u20ac'.repeat(3000)}"}`,
    ]) {
      expect(parseShellLine(bad), bad.slice(0, 80)).toBeNull();
    }
    expect(parseShellLine(`{"type":"cli_folder_cancelled"${' '.repeat(100)}}`)).toEqual({ type: 'cli_folder_cancelled' });
    expect(parseShellLine('{"type":"cli_folder_open"}')).toEqual({ type: 'cli_folder_open' });
    expect(parseShellLine(`{"type":"cli_folder","path":"/${'\u20ac'.repeat(2000)}"}`)).toEqual({ type: 'cli_folder', path: `/${'\u20ac'.repeat(2000)}` });
    // L7.34: the CLI's reader at this cap — a line of exactly SHELL_LINE_MAX bytes reaches the parser, one byte more is
    // dropped whole (and the next line is read again), across chunks.
    const got: string[] = [];
    const read = shellLineReader((l) => got.push(l), SHELL_LINE_MAX);
    const at = `{"type":"cli_folder_cancelled"${' '.repeat(SHELL_LINE_MAX - 31)}}`;
    expect(Buffer.byteLength(at)).toBe(SHELL_LINE_MAX);
    for (const line of [at, `${at} `, '{"type":"cli_folder_open"}']) {
      const b = Buffer.from(`${line}\n`);
      read(b.subarray(0, 5000));
      read(b.subarray(5000));
    }
    expect(got.map((l) => parseShellLine(l))).toEqual([{ type: 'cli_folder_cancelled' }, { type: 'cli_folder_open' }]);
    // Kept as source checks: the cap is a literal at the call site of a function `retake ui` does not export (stdin of
    // the supervised process), so only the supervised CLI itself could show it — the number it passes is this cap.
    const cli = await readFile(join(__dirname, '..', '..', 'cli', 'src', 'commands', 'ui.ts'), 'utf8');
    expect([...cli.matchAll(/\bstdinClosed\([^;]*?,\s*(\d+)\)/g)].map((m) => Number(m[1]))).toEqual([SHELL_LINE_MAX]);
    // L5.16d: the update's state goes through the same reader (update-ops.test.ts): the line handler hands it on.
    expect(cli).toMatch(/\bshellLine = \(\w+\) => void applyShellLine\([^)]*, server\.update\);/);
  });
});
