/**
 * L5.16c — the installed app's first run and integrations (@retake/engine/integrations, app-setup.ts), on scratch
 * folders only (a scratch HOME, fake apps, a fake `claude`, scratch Claude Desktop configs — never the person's): where
 * the app runs from (critique H1), the `retake` command's link (plan §4, critique L1), `<home>/app.json`, the Claude
 * Desktop merge (critique M7) and the Claude Code runner (argv, no shell, a small environment, the time limit), and
 * which copy of Retake an engine is (critique M6). L5.16c fixes: the runner answers on its process's exit (a helper
 * holding the pipes never keeps it waiting), another copy's launcher is told by its app's identifier (look-alikes are
 * the person's files), the zsh line single-quotes odd names (evaluated by zsh), the Claude Desktop backups go to
 * Retake's own folder, and every `install_location` case of desktop_core is replayed here.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  APP_BUNDLE_ID,
  CLAUDE_DRAIN_MS,
  CLAUDE_OUTPUT_MAX,
  DESKTOP_BACKUPS_MAX,
  MOVE_TO_APPLICATIONS,
  SetupError,
  checkCliFolder,
  claudeCandidates,
  claudeDesktopConfigFile,
  claudeDesktopIn,
  claudeEnv,
  cliLinkState,
  cliOnPath,
  defaultCliDir,
  desktopBackupDir,
  findClaude,
  installCliLink,
  installLocation,
  installLocationWords,
  onReadOnlyVolume,
  planDesktopEntry,
  plainOutput,
  readAppSettings,
  removeCliLink,
  runClaudeSteps,
  setupSeen,
  writeAppSettings,
  writeDesktopEntry,
  zshPathLine,
} from '@retake/engine/integrations';
import { engineLocation } from '@retake/core/io';
import type { BundleInfo } from '@retake/core/io';

const base = realpathSync(mkdtempSync(join(tmpdir(), 'app-setup-')));
afterAll(() => rmSync(base, { recursive: true, force: true }));
let n = 0;
const scratch = (name: string) => {
  const d = join(base, `${name}-${++n}`);
  mkdirSync(d, { recursive: true });
  return d;
};

/**
 * A fake app: `<dir>/<name>.app/Contents/Resources/bin/retake`, a script that prints its arguments, and an Info.plist
 * naming `id` (Retake's by default; null: none).
 */
function fakeApp(dir: string, name = 'Retake', id: string | null = APP_BUNDLE_ID): { app: string; launcher: string } {
  const res = join(dir, `${name}.app`, 'Contents', 'Resources');
  mkdirSync(join(res, 'bin'), { recursive: true });
  const launcher = join(res, 'bin', 'retake');
  writeFileSync(launcher, `#!/bin/sh\necho "${name} $*"\n`);
  chmodSync(launcher, 0o755);
  if (id !== null) writeFileSync(join(dir, `${name}.app`, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict>\n\t<key>CFBundleIdentifier</key>\n\t<string>${id}</string>\n</dict></plist>\n`);
  return { app: join(dir, `${name}.app`), launcher };
}

describe('where the app runs from (critique H1)', () => {
  it('a translocated copy, a read-only volume and /Volumes are told apart from an installed app — the same cases as desktop_core', () => {
    expect(installLocation('/private/var/folders/xy/T/AppTranslocation/0A1B-2C3D/d/Retake.app', { readOnly: false })).toBe('translocated');
    expect(installLocation('/private/var/folders/xy/T/AppTranslocation/0A1B-2C3D/d/Retake.app', { readOnly: true })).toBe('translocated');
    expect(installLocation('/Volumes/Retake/Retake.app', { readOnly: true })).toBe('read_only');
    expect(installLocation('/Applications/Retake.app', { readOnly: true })).toBe('read_only');
    expect(installLocation('/Volumes/External/Apps/Retake.app', { readOnly: false })).toBe('volumes');
    expect(installLocation('/Volumes', { readOnly: false })).toBe('volumes');
    expect(installLocation('/Applications/Retake.app', { readOnly: false })).toBe('ok');
    expect(installLocation('/Users/me/Applications/Retake.app', { readOnly: false })).toBe('ok');
    expect(installLocation('/Users/me/VolumesOld/Retake.app', { readOnly: false })).toBe('ok');
    expect(installLocation('/VolumesOld/Retake.app', { readOnly: false })).toBe('ok');
    expect(installLocation('/VolumesX/Apps/Retake.app', { readOnly: false })).toBe('ok');
    expect(installLocation('/Users/me/AppTranslocationNotes/Retake.app', { readOnly: false })).toBe('ok');
    for (const l of ['translocated', 'read_only', 'volumes'] as const) expect(installLocationWords(l)).toMatch(/^Retake runs from/);
    expect(MOVE_TO_APPLICATIONS).toBe('Move Retake to Applications, then open it again');
    // The desktop shell's words are the same (desktop_core setup.rs).
    const rs = readFileSync(join(__dirname, '..', '..', '..', 'apps', 'desktop', 'core', 'src', 'setup.rs'), 'utf8');
    expect(rs).toContain(`pub const MOVE_TO_APPLICATIONS: &str = "${MOVE_TO_APPLICATIONS}";`);
    for (const l of ['translocated', 'read_only', 'volumes'] as const) expect(rs).toContain(`"${installLocationWords(l)}"`);
    // Review c B-L2: every `install_location` assert of desktop_core's tests, replayed on this side.
    const LOC = { Translocated: 'translocated', ReadOnly: 'read_only', Volumes: 'volumes', Ok: 'ok' } as const;
    const cases = [...rs.matchAll(/assert_eq!\(install_location\(&p\("([^"]+)"\), (true|false)\), InstallLocation::(\w+)\);/g)];
    expect(cases.length).toBeGreaterThanOrEqual(12);
    for (const [, path, ro, loc] of cases) expect(installLocation(path!, { readOnly: ro === 'true' }), path).toBe(LOC[loc as keyof typeof LOC]);
    // A writable scratch folder is no read-only volume.
    expect(onReadOnlyVolume(base)).toBe(false);
  });
});

describe('the retake command (plan §4)', () => {
  it('links the default folder (created), keeps its own link, runs the app through the link, removes only its own', () => {
    const home = scratch('home');
    const { launcher } = fakeApp(scratch('apps'));
    const dir = defaultCliDir(home);
    expect(dir).toBe(join(home, '.local', 'bin'));
    expect(() => installCliLink(dir, launcher)).toThrow(expect.objectContaining({ reason: 'no_folder' }));
    const r = installCliLink(dir, launcher, { createDir: true });
    expect(r).toEqual({ path: join(dir, 'retake'), result: 'created' });
    expect(statSync(dir).mode & 0o777).toBe(0o755);
    expect(lstatSync(r.path).isSymbolicLink()).toBe(true);
    expect(readlinkSync(r.path)).toBe(launcher);
    expect(cliLinkState(r.path, launcher)).toEqual({ state: 'ours', target: launcher });
    // Again: kept (idempotent).
    expect(installCliLink(dir, launcher, { createDir: true }).result).toBe('kept');
    // The link runs the app's own script (its real path decides).
    const run = spawnSync(r.path, ['--version'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
    expect(run.stdout.trim()).toBe('Retake --version');
    expect(removeCliLink(r.path, launcher)).toBe('removed');
    expect(existsSync(r.path)).toBe(false);
    expect(removeCliLink(r.path, launcher)).toBe('absent');
    expect(() => installCliLink('relative/bin', launcher)).toThrow(expect.objectContaining({ reason: 'not_absolute' }));
  });

  it('never replaces nor removes a file that is not a link into an app; another app\'s link only with Replace', () => {
    const home = scratch('home');
    const dir = defaultCliDir(home);
    mkdirSync(dir, { recursive: true });
    const { launcher } = fakeApp(scratch('apps'));
    const link = join(dir, 'retake');
    // A file of the person's (a repository retake, an alias script).
    writeFileSync(link, '#!/bin/sh\nexec pnpm retake "$@"\n');
    expect(cliLinkState(link, launcher)).toEqual({ state: 'foreign', what: 'file' });
    expect(() => installCliLink(dir, launcher, { replace: true })).toThrow(expect.objectContaining({ reason: 'foreign' }));
    expect(() => removeCliLink(link, launcher)).toThrow(expect.objectContaining({ reason: 'foreign' }));
    expect(readFileSync(link, 'utf8')).toContain('pnpm retake');
    rmSync(link);
    // A link elsewhere (the repository's bin) is the person's too.
    symlinkSync('/usr/bin/true', link);
    expect(cliLinkState(link, launcher)).toEqual({ state: 'foreign', what: 'link', target: '/usr/bin/true' });
    expect(() => installCliLink(dir, launcher, { replace: true })).toThrow(SetupError);
    expect(() => removeCliLink(link, launcher)).toThrow(/not Retake's command/);
    expect(readlinkSync(link)).toBe('/usr/bin/true');
    rmSync(link);
    // A folder in the way.
    mkdirSync(link);
    expect(cliLinkState(link, launcher)).toEqual({ state: 'foreign', what: 'folder' });
    rmSync(link, { recursive: true });
    // Another copy of the app: Replace only; a removed copy is said (dangling).
    const other = fakeApp(scratch('other'), 'Retake Old');
    symlinkSync(other.launcher, link);
    expect(cliLinkState(link, launcher)).toEqual({ state: 'other_app', target: other.launcher, dangling: false });
    expect(() => installCliLink(dir, launcher)).toThrow(expect.objectContaining({ reason: 'other_app' }));
    rmSync(other.app, { recursive: true });
    expect(cliLinkState(link, launcher)).toMatchObject({ state: 'other_app', dangling: true });
    expect(installCliLink(dir, launcher, { replace: true }).result).toBe('replaced');
    expect(readlinkSync(link)).toBe(launcher);
    // No temporary link left beside it.
    expect(readdirSync(dir)).toEqual(['retake']);
    // Removing another copy's link is allowed (it is a Retake command).
    rmSync(link);
    symlinkSync(other.launcher, link);
    expect(removeCliLink(link, launcher)).toBe('removed');
  });

  it('review c B-M3: a look-alike of an app launcher is the person\'s file — the exact layout AND Retake\'s identifier make another copy', () => {
    const home = scratch('home');
    const dir = defaultCliDir(home);
    mkdirSync(dir, { recursive: true });
    const { launcher } = fakeApp(scratch('apps'));
    const link = join(dir, 'retake');
    const looks = scratch('looks');
    const formula = join(looks, 'opt', 'x', 'bin', 'retake');
    const macos = join(looks, 'Tool.app', 'Contents', 'MacOS', 'retake');
    for (const f of [formula, macos]) {
      mkdirSync(join(f, '..'), { recursive: true });
      writeFileSync(f, '#!/bin/sh\n');
    }
    const otherId = fakeApp(join(looks, 'Applications'), 'Other', 'example.other.tool');
    const noPlist = fakeApp(join(looks, 'Applications'), 'Plain', null);
    // Retake's identifier outside the exact layout (no `.app/Contents/Resources`): still not an app's launcher.
    const weird = join(looks, 'Weird', 'bin', 'retake');
    mkdirSync(join(weird, '..'), { recursive: true });
    writeFileSync(weird, '#!/bin/sh\n');
    mkdirSync(join(looks, 'Weird', 'Contents'), { recursive: true });
    writeFileSync(join(looks, 'Weird', 'Contents', 'Info.plist'), `<plist><dict><key>CFBundleIdentifier</key><string>${APP_BUNDLE_ID}</string></dict></plist>`);
    for (const target of [formula, macos, otherId.launcher, noPlist.launcher, weird]) {
      symlinkSync(target, link);
      expect(cliLinkState(link, launcher), target).toEqual({ state: 'foreign', what: 'link', target });
      expect(() => installCliLink(dir, launcher, { replace: true }), target).toThrow(expect.objectContaining({ reason: 'foreign' }));
      expect(() => removeCliLink(link, launcher), target).toThrow(expect.objectContaining({ reason: 'foreign' }));
      expect(readlinkSync(link)).toBe(target);
      rmSync(link);
    }
    // A test build's identifier (`<id>.<suffix>`) is a copy of Retake; a prefix look-alike is not.
    const test = fakeApp(join(looks, 'Builds'), 'Retake Test', `${APP_BUNDLE_ID}.t1`);
    symlinkSync(test.launcher, link);
    expect(cliLinkState(link, launcher)).toMatchObject({ state: 'other_app', dangling: false });
    rmSync(link);
    const prefix = fakeApp(join(looks, 'Builds'), 'Lookalike', `${APP_BUNDLE_ID}x`);
    symlinkSync(prefix.launcher, link);
    expect(cliLinkState(link, launcher)).toMatchObject({ state: 'foreign' });
    rmSync(link);
    // The identifier is the app's (apps/desktop tauri.conf.json).
    const conf = JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'apps', 'desktop', 'tauri.conf.json'), 'utf8')) as { identifier: string };
    expect(conf.identifier).toBe(APP_BUNDLE_ID);
  });

  it('says which retake the given PATH finds first and gives the zsh line to copy (never a profile edit)', () => {
    const a = scratch('a');
    const b = scratch('b');
    writeFileSync(join(b, 'retake'), '#!/bin/sh\n');
    chmodSync(join(b, 'retake'), 0o755);
    expect(cliOnPath(a, `${b}:/usr/bin`)).toEqual({ onPath: false, first: join(b, 'retake') });
    expect(cliOnPath(a, `/usr/bin:${a}:${b}`)).toEqual({ onPath: true, first: join(b, 'retake') });
    expect(cliOnPath(a, 'relative:/usr/bin')).toEqual({ onPath: false, first: null });
    expect(zshPathLine('/Users/me/.local/bin', '/Users/me')).toBe('export PATH="$HOME/.local/bin:$PATH"');
    expect(zshPathLine('/opt/tools/bin', '/Users/me')).toBe('export PATH="/opt/tools/bin:$PATH"');
    expect(zshPathLine('/Users/me/my "bin"', '/Users/me')).toBe(`export PATH="$HOME/"'my "bin"'":$PATH"`);
    expect(zshPathLine('/Users/me/tools/$(cmd)', '/Users/me')).toBe(`export PATH="$HOME/"'tools/$(cmd)'":$PATH"`);
    expect(zshPathLine("/opt/it's", '/Users/me')).toBe(`export PATH='/opt/it'\\''s'":$PATH"`);
  });

  it('review c A-L1 / B-L6: the zsh line, evaluated by zsh, puts the folder first and runs nothing — $(cmd), backticks, quotes, a backslash, a space', () => {
    const home = scratch('zhome');
    const marker = join(home, 'PWNED');
    const names = ['tools/$(touch PWNED)', 'a`touch PWNED`b', "it's", 'my "bin"', 'back\\slash', 'with space', 'a$b', '${HOME}x', 'plain/bin'];
    for (const name of names) {
      const dir = join(home, name);
      const line = zshPathLine(dir, home);
      const r = spawnSync('/bin/zsh', ['-f', '-c', `${line}\nprint -r -- "\${PATH%%:*}"`], { encoding: 'utf8', cwd: home, env: { HOME: home, PATH: '/usr/bin:/bin' } });
      expect(r.status, line).toBe(0);
      expect(r.stdout, line).toBe(`${dir}\n`);
      expect(existsSync(marker), line).toBe(false);
    }
    // Outside the home too.
    const out = zshPathLine('/opt/$(touch PWNED)', home);
    expect(spawnSync('/bin/zsh', ['-f', '-c', `${out}\nprint -r -- "\${PATH%%:*}"`], { encoding: 'utf8', cwd: home, env: { HOME: home, PATH: '/usr/bin:/bin' } }).stdout).toBe('/opt/$(touch PWNED)\n');
    expect(existsSync(marker)).toBe(false);
  });

  it('a chosen folder must be absolute, a folder, the person\'s, writable, outside the workspace and the app', () => {
    const uid = process.getuid!();
    const ws = scratch('ws');
    const { app } = fakeApp(scratch('apps'));
    const ok = scratch('bin');
    expect(checkCliFolder(ok, { uid, workspace: ws, sealed: app })).toBe(ok);
    expect(() => checkCliFolder('bin', { uid, workspace: ws })).toThrow(expect.objectContaining({ reason: 'not_absolute' }));
    expect(() => checkCliFolder(join(base, 'missing'), { uid, workspace: ws })).toThrow(expect.objectContaining({ reason: 'no_folder' }));
    writeFileSync(join(ok, 'f'), '');
    expect(() => checkCliFolder(join(ok, 'f'), { uid, workspace: ws })).toThrow(expect.objectContaining({ reason: 'no_folder' }));
    expect(() => checkCliFolder(ok, { uid: uid + 1, workspace: ws })).toThrow(expect.objectContaining({ reason: 'not_owned' }));
    mkdirSync(join(ws, 'bin'));
    expect(() => checkCliFolder(join(ws, 'bin'), { uid, workspace: ws })).toThrow(expect.objectContaining({ reason: 'inside_workspace' }));
    expect(() => checkCliFolder(join(app, 'Contents', 'Resources', 'bin'), { uid, workspace: ws, sealed: app })).toThrow(expect.objectContaining({ reason: 'inside_app' }));
    const ro = scratch('ro');
    chmodSync(ro, 0o555);
    expect(() => checkCliFolder(ro, { uid, workspace: ws })).toThrow(expect.objectContaining({ reason: 'not_writable' }));
    chmodSync(ro, 0o755);
    // A link to a folder inside the workspace is judged by where it leads.
    symlinkSync(join(ws, 'bin'), join(ok, 'to-ws'));
    expect(() => checkCliFolder(join(ok, 'to-ws'), { uid, workspace: ws })).toThrow(expect.objectContaining({ reason: 'inside_workspace' }));
  });
});

describe('<home>/app.json', () => {
  it('merges, removes keys, writes 0600 atomically, and the sheet comes back at the next major only', () => {
    const home = join(scratch('h'), 'retake-home');
    expect(readAppSettings(home)).toEqual({});
    writeAppSettings(home, { setup_seen: '0.2.0' });
    writeAppSettings(home, { cli: { path: '/Users/me/.local/bin/retake', at: '2026-11-03T00:00:00.000Z' } });
    expect(readAppSettings(home)).toEqual({ setup_seen: '0.2.0', cli: { path: '/Users/me/.local/bin/retake', at: '2026-11-03T00:00:00.000Z' } });
    expect(statSync(join(home, 'app.json')).mode & 0o777).toBe(0o600);
    expect(statSync(home).mode & 0o777).toBe(0o700);
    writeAppSettings(home, { cli: null });
    expect(readAppSettings(home)).toEqual({ setup_seen: '0.2.0' });
    expect(readdirSync(home)).toEqual(['app.json']);
    expect(setupSeen(readAppSettings(home), '0.2.0')).toBe(true);
    expect(setupSeen(readAppSettings(home), '0.9.1')).toBe(true);
    expect(setupSeen(readAppSettings(home), '1.0.0')).toBe(false);
    expect(setupSeen({}, '0.2.0')).toBe(false);
    // Garbage is ignored, field by field.
    writeFileSync(join(home, 'app.json'), JSON.stringify({ setup_seen: 'yes', cli: { path: 'relative', at: 'x' } }));
    expect(readAppSettings(home)).toEqual({});
    writeFileSync(join(home, 'app.json'), '[1]');
    expect(readAppSettings(home)).toEqual({});
  });
});

const ENTRY = { command: '/Applications/Retake.app/Contents/Resources/node/bin/node', args: ['--require', '/Applications/Retake.app/Contents/Resources/node/guard.cjs', '/Applications/Retake.app/Contents/Resources/engine/dist/bin.js', '--root', '/Users/me/Retake', 'mcp'], env: { PATH: '/usr/bin:/bin' } };

describe('Claude Desktop (critique M7)', () => {
  it('plans the change: created, added beside every other key, the same, a different entry — refusing unparsable JSON and a non-object mcpServers', () => {
    expect(planDesktopEntry(null, ENTRY).kind).toBe('create');
    expect(JSON.parse(planDesktopEntry(null, ENTRY).text)).toEqual({ mcpServers: { retake: ENTRY } });
    const others = JSON.stringify({ globalShortcut: 'Cmd+Space', mcpServers: { files: { command: 'x', args: [] } }, theme: 'dark' });
    const add = planDesktopEntry(others, ENTRY);
    expect(add.kind).toBe('add');
    expect(JSON.parse(add.text)).toEqual({ globalShortcut: 'Cmd+Space', mcpServers: { files: { command: 'x', args: [] }, retake: ENTRY }, theme: 'dark' });
    expect(planDesktopEntry(add.text, ENTRY)).toMatchObject({ kind: 'same', current: ENTRY });
    const diff = planDesktopEntry(JSON.stringify({ mcpServers: { retake: { command: 'node', args: ['/old/bin.js'] } } }), ENTRY);
    expect(diff).toMatchObject({ kind: 'replace', current: { command: 'node', args: ['/old/bin.js'] } });
    expect(planDesktopEntry('{}', ENTRY).kind).toBe('add');
    expect(() => planDesktopEntry('{"mcpServers": {', ENTRY)).toThrow(expect.objectContaining({ reason: 'unparsable' }));
    expect(() => planDesktopEntry('[]', ENTRY)).toThrow(expect.objectContaining({ reason: 'not_object' }));
    expect(() => planDesktopEntry('{"mcpServers": []}', ENTRY)).toThrow(expect.objectContaining({ reason: 'servers_not_object' }));
    expect(() => planDesktopEntry('{"mcpServers": "x"}', ENTRY)).toThrow(expect.objectContaining({ reason: 'servers_not_object' }));
  });

  it('writes on scratch configs: a backup first (capped, in Retake\'s own folder), the mode kept, other keys kept, read back; a different entry needs Replace; no folder, no file', () => {
    const home = scratch('desk');
    const file = claudeDesktopConfigFile(home);
    const backupDir = desktopBackupDir(join(home, '.retake'));
    expect(backupDir).toBe(join(home, '.retake', 'backups', 'claude-desktop'));
    expect(file).toBe(join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'));
    // No Claude folder: Claude Desktop never ran — nothing is created in ~/Library.
    expect(() => writeDesktopEntry(file, ENTRY, { backupDir })).toThrow(expect.objectContaining({ reason: 'no_claude' }));
    expect(existsSync(join(home, 'Library'))).toBe(false);
    mkdirSync(join(file, '..'), { recursive: true });
    // Absent: created 0600, no backup.
    expect(writeDesktopEntry(file, ENTRY, { backupDir })).toEqual({ kind: 'create', file });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    // Present 0644 with other keys: kept, mode kept, a backup copy of the old file.
    writeFileSync(file, `${JSON.stringify({ theme: 'dark', mcpServers: { files: { command: 'x' } } })}\n`);
    chmodSync(file, 0o644);
    const before = readFileSync(file, 'utf8');
    const r = writeDesktopEntry(file, ENTRY, { backupDir, now: new Date('2026-11-03T10:00:00Z') });
    expect(r.kind).toBe('add');
    expect(r.backup).toBe(join(backupDir, 'claude_desktop_config.json.retake-backup-2026-11-03T10-00-00-000Z'));
    expect(readFileSync(r.backup!, 'utf8')).toBe(before);
    // Retake's folder 0700, the copy 0600 (it holds every server's env); nothing beside the config.
    expect(statSync(backupDir).mode & 0o777).toBe(0o700);
    expect(statSync(r.backup!).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(file, '..'))).toEqual(['claude_desktop_config.json']);
    expect(statSync(file).mode & 0o777).toBe(0o644);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ theme: 'dark', mcpServers: { files: { command: 'x' }, retake: ENTRY } });
    // The same again: nothing written, no backup.
    expect(writeDesktopEntry(file, ENTRY, { backupDir, now: new Date('2026-11-03T10:00:01Z') })).toEqual({ kind: 'same', file });
    // A different entry: refused with the one there now, then Replace.
    const other = { ...ENTRY, args: ['/elsewhere/bin.js', 'mcp'] };
    expect(() => writeDesktopEntry(file, other, { backupDir })).toThrow(expect.objectContaining({ reason: 'needs_replace', details: { current: ENTRY } }));
    expect(writeDesktopEntry(file, other, { backupDir, replace: true, now: new Date('2026-11-03T10:00:02Z') }).kind).toBe('replace');
    // Two writes in the same millisecond: two backups, unique names (never a raw EEXIST).
    const same = new Date('2026-11-03T10:00:03Z');
    const b1 = writeDesktopEntry(file, ENTRY, { backupDir, replace: true, now: same }).backup!;
    const b2 = writeDesktopEntry(file, other, { backupDir, replace: true, now: same }).backup!;
    expect(b2).toBe(`${b1}-1`);
    // Backups are capped: the oldest go.
    for (let i = 0; i < DESKTOP_BACKUPS_MAX + 3; i++) writeDesktopEntry(file, i % 2 ? ENTRY : other, { backupDir, replace: true, now: new Date(Date.UTC(2026, 10, 4, 0, 0, i)) });
    const backups = readdirSync(backupDir).filter((f) => f.includes('.retake-backup-')).sort();
    expect(backups).toHaveLength(DESKTOP_BACKUPS_MAX);
    expect(backups[0]).toContain('2026-11-04T00-00-03');
    // Nothing temporary left, nothing beside the config.
    expect(readdirSync(join(file, '..'))).toEqual(['claude_desktop_config.json']);
    // Read back: a program that writes the file over right after (Claude Desktop from memory) is said, with the backup.
    expect(() => writeDesktopEntry(file, other, { backupDir, replace: true, now: new Date('2026-11-05T00:00:00Z'), afterWrite: (f) => writeFileSync(f, '{"theme":"dark"}') })).toThrow(expect.objectContaining({ reason: 'not_kept', message: expect.stringContaining(join(backupDir, 'claude_desktop_config.json.retake-backup-2026-11-05T00-00-00-000Z')) }));
    // Unparsable: refused, left byte for byte, no backup made.
    writeFileSync(file, '{ "theme": "dark", ');
    const count = readdirSync(backupDir).length;
    expect(() => writeDesktopEntry(file, ENTRY, { backupDir, replace: true })).toThrow(expect.objectContaining({ reason: 'unparsable' }));
    expect(readFileSync(file, 'utf8')).toBe('{ "theme": "dark", ');
    expect(readdirSync(backupDir).length).toBe(count);
    // A relative backup folder: refused before anything is written.
    writeFileSync(file, '{}');
    expect(() => writeDesktopEntry(file, ENTRY, { backupDir: 'backups' })).toThrow(expect.objectContaining({ reason: 'not_absolute' }));
    expect(readFileSync(file, 'utf8')).toBe('{}');
  });

  it('a symlinked config (dotfiles) is written at its real path: the link stays a link', () => {
    const home = scratch('desk-link');
    const file = claudeDesktopConfigFile(home);
    mkdirSync(join(file, '..'), { recursive: true });
    const dots = scratch('dotfiles');
    const real = join(dots, 'claude.json');
    writeFileSync(real, JSON.stringify({ theme: 'light' }));
    chmodSync(real, 0o600);
    symlinkSync(real, file);
    const backupDir = desktopBackupDir(join(home, '.retake'));
    const r = writeDesktopEntry(file, ENTRY, { backupDir, now: new Date('2026-11-03T11:00:00Z') });
    expect(r.file).toBe(real);
    expect(lstatSync(file).isSymbolicLink()).toBe(true);
    expect(readlinkSync(file)).toBe(real);
    expect(JSON.parse(readFileSync(real, 'utf8'))).toEqual({ theme: 'light', mcpServers: { retake: ENTRY } });
    // Review c A-L2: the backup is in Retake's folder — never in the dotfiles repository beside the target.
    expect(r.backup).toBe(join(backupDir, 'claude.json.retake-backup-2026-11-03T11-00-00-000Z'));
    expect(readdirSync(dots)).toEqual(['claude.json']);
    // The temporary file was beside the target, never beside the link (nothing left there either).
    expect(readdirSync(join(file, '..'))).toEqual(['claude_desktop_config.json']);
    // A link to nothing: refused.
    rmSync(real);
    expect(() => writeDesktopEntry(file, ENTRY, { backupDir })).toThrow(expect.objectContaining({ reason: 'dangling' }));
  });

  it('tells a running Claude Desktop from a process list', () => {
    expect(claudeDesktopIn('/sbin/launchd\n/Applications/Claude.app/Contents/MacOS/Claude\n')).toBe(true);
    expect(claudeDesktopIn('/Applications/Claude.app/Contents/Frameworks/Claude Helper.app/Contents/MacOS/Claude Helper\n/usr/bin/claude\n')).toBe(false);
    expect(claudeDesktopIn('')).toBe(false);
  });
});

describe('Claude Code (plan §4, critique L4)', () => {
  it('finds claude in the fixed list only, in order', () => {
    const home = '/Users/me';
    expect(claudeCandidates(home)).toEqual(['/Users/me/.local/bin/claude', '/opt/homebrew/bin/claude', '/usr/local/bin/claude', '/Users/me/.claude/local/claude']);
    expect(findClaude(home, (p) => p === '/usr/local/bin/claude' || p === '/Users/me/.claude/local/claude')).toBe('/usr/local/bin/claude');
    expect(findClaude(home, () => false)).toBe(null);
  });

  it('runs each line as argv (no shell), in its folder, with a small environment and CLAUDE_CONFIG_DIR, stopping at a failure; output made plain text', async () => {
    const dir = scratch('claude');
    const log = join(dir, 'calls.log');
    const claude = join(dir, 'claude');
    // A fake claude: records its argv (one per line), its folder and its environment; fails on "fail".
    writeFileSync(claude, `#!/bin/sh\n{ echo "cwd=$(pwd)"; for a in "$@"; do echo "arg=$a"; done; echo "env=$(env | sort | tr '\\n' ' ')"; } >> '${log}'\nprintf '\\033[32mdone\\033[0m\\r\\n'\n[ "$1" = fail ] && exit 3\nexit 0\n`);
    chmodSync(claude, 0o755);
    const ws = scratch('ws with space');
    const env = claudeEnv(claude, { HOME: dir, USER: 'me', CLAUDE_CONFIG_DIR: join(dir, 'cfg'), NODE_OPTIONS: '--require /evil.js', SECRET_TOKEN: 'x', PATH: '/evil/bin' }, '/App/node/bin');
    expect(env).toEqual({ PATH: `${dir}:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin:/App/node/bin`, HOME: dir, USER: 'me', CLAUDE_CONFIG_DIR: join(dir, 'cfg') });
    const evil = '$(touch pwned); `id` && echo hi; rm -rf ~';
    const r = await runClaudeSteps(claude, [{ argv: ['plugin', 'marketplace', 'add', '/Applications/Retake.app/Contents/Resources/plugin'] }, { argv: ['plugin', 'install', 'retake@retake', '--config', `workspace=${evil}`], cwd: ws }], { env });
    expect(r.ok).toBe(true);
    expect(r.timedOut).toBe(false);
    expect(r.steps.map((s) => s.code)).toEqual([0, 0]);
    expect(r.steps[0]!.output).toBe('done\n');
    const calls = readFileSync(log, 'utf8');
    expect(calls).toContain(`arg=workspace=${evil}`);
    expect(calls).toContain(`cwd=${realpathSync(ws)}`);
    expect(calls).toContain(`CLAUDE_CONFIG_DIR=${join(dir, 'cfg')}`);
    expect(calls).not.toMatch(/NODE_OPTIONS|SECRET_TOKEN|\/evil\/bin/);
    expect(existsSync(join(ws, 'pwned'))).toBe(false);
    // A failing line stops the run there.
    const f = await runClaudeSteps(claude, [{ argv: ['fail'] }, { argv: ['never'] }], { env });
    expect(f).toMatchObject({ ok: false, timedOut: false });
    expect(f.steps).toHaveLength(1);
    expect(f.steps[0]!.code).toBe(3);
  });

  it('a claude that waits is stopped at the time limit (then: run the lines in Terminal); output is capped', async () => {
    const dir = scratch('claude-slow');
    const claude = join(dir, 'claude');
    writeFileSync(claude, '#!/bin/sh\necho asking\nsleep 30\n');
    chmodSync(claude, 0o755);
    const t0 = Date.now();
    const r = await runClaudeSteps(claude, [{ argv: ['plugin', 'install'] }, { argv: ['never'] }], { env: { PATH: '/usr/bin:/bin' }, timeoutMs: 600 });
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(r).toMatchObject({ ok: false, timedOut: true });
    expect(r.steps).toHaveLength(1);
    expect(r.steps[0]!.output).toContain('asking');
    const big = join(dir, 'claude-big');
    writeFileSync(big, `#!/bin/sh\nhead -c ${CLAUDE_OUTPUT_MAX * 4} /dev/zero | tr '\\0' 'a'\n`);
    chmodSync(big, 0o755);
    const b = await runClaudeSteps(big, [{ argv: [] }], { env: { PATH: '/usr/bin:/bin' } });
    expect(b.steps[0]!.output.length).toBeLessThanOrEqual(CLAUDE_OUTPUT_MAX);
    expect(plainOutput('a\u001b]8;;http://x.test\u0007b\u0000c\u202e\td')).toBe('abc\u202e\td');
  });
});

describe('Claude Code: a helper that holds the pipes (review c A-M1)', () => {
  /** A fake claude that leaves a helper in a session of its own holding stdout and stderr; `then`: the script's end. */
  function withHelper(dir: string, then: string): { claude: string; pidFile: string } {
    const pidFile = join(dir, 'helper.pid');
    const helper = join(dir, 'helper.cjs');
    // The helper: its own session (detached: setsid), the step's stdout / stderr inherited, writing a dot every 100 ms
    // for 30 s — once the runner lets the pipes go, a write fails (EPIPE) and it dies.
    const body = 'setInterval(() => process.stdout.write("."), 100); setTimeout(() => process.exit(0), 30000);';
    writeFileSync(helper, `const { spawn } = require('node:child_process');\nconst c = spawn(process.execPath, ['-e', ${JSON.stringify(body)}], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] });\nrequire('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(c.pid));\nc.unref();\n`);
    const claude = join(dir, 'claude');
    writeFileSync(claude, `#!/bin/sh\necho $$ > '${join(dir, 'claude.pid')}'\necho registered\n'${process.execPath}' '${helper}'\n${then}\n`);
    chmodSync(claude, 0o755);
    return { claude, pidFile };
  }
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const gone = async (pid: number, ms: number) => {
    const end = Date.now() + ms;
    while (alive(pid) && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
    return !alive(pid);
  };
  const killHelper = (pidFile: string) => {
    const pid = Number(readFileSync(pidFile, 'utf8'));
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* gone */
    }
  };

  it('claude exits 0 at once: ok within the drain, judged by its exit code — the helper never keeps the answer waiting', async () => {
    const dir = scratch('claude-helper');
    const { claude, pidFile } = withHelper(dir, 'exit 0');
    try {
      const t0 = Date.now();
      const r = await runClaudeSteps(claude, [{ argv: ['plugin', 'install'] }], { env: { PATH: '/usr/bin:/bin' }, timeoutMs: 20_000 });
      const ms = Date.now() - t0;
      expect(r).toMatchObject({ ok: true, timedOut: false });
      expect(r.steps[0]).toMatchObject({ code: 0 });
      expect(r.steps[0]!.output).toContain('registered');
      expect(ms).toBeLessThan(3000 + CLAUDE_DRAIN_MS);
      // The runner let the pipes go (destroyed): the helper's next write fails and it dies — never held for 30 s.
      expect(await gone(Number(readFileSync(pidFile, 'utf8')), 5000)).toBe(true);
    } finally {
      killHelper(pidFile);
    }
  });

  it('claude waits with the helper and ignores SIGTERM: timed out within the limit and the kill grace (SIGKILL), not when the helper ends', async () => {
    const dir = scratch('claude-helper-slow');
    const { claude, pidFile } = withHelper(dir, "trap '' TERM\nsleep 30");
    try {
      const t0 = Date.now();
      const r = await runClaudeSteps(claude, [{ argv: ['plugin', 'install'] }, { argv: ['never'] }], { env: { PATH: '/usr/bin:/bin' }, timeoutMs: 1500 });
      const ms = Date.now() - t0;
      expect(r).toMatchObject({ ok: false, timedOut: true });
      expect(r.steps).toHaveLength(1);
      expect(ms).toBeLessThan(1500 + 2000 + 1500);
      // The claude that ignored SIGTERM got SIGKILL: gone.
      expect(await gone(Number(readFileSync(join(dir, 'claude.pid'), 'utf8')), 3000)).toBe(true);
    } finally {
      killHelper(pidFile);
    }
  });
});

describe('which copy of Retake an engine is (critique M6)', () => {
  it('the app it runs from, else the checkout holding it', () => {
    const b = { sealed: '/Applications/Retake.app' } as BundleInfo;
    expect(engineLocation(b)).toBe('/Applications/Retake.app');
    expect(engineLocation(null, '/repo/packages/core/dist/io/bundle.js', (p) => p === '/repo/pnpm-workspace.yaml')).toBe('/repo');
    expect(engineLocation(null, '/x/node_modules/@retake/core/dist/io/bundle.js', () => false)).toBe('/x/node_modules/@retake/core');
    // This checkout.
    expect(existsSync(join(engineLocation(null), 'pnpm-workspace.yaml'))).toBe(true);
  });
});
