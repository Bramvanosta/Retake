/**
 * The installed app's first run and integrations (L5.16c, DESIGN §4p (c)): where the app runs from, the `retake`
 * command's link, the Claude Code plugin run and the Claude Desktop entry. Pure rules and small file operations, each
 * with its paths injected — the Studio's setup ops (ui setup-ops.ts: Studio-only, supervised + bundled only, never MCP
 * tools) and doctor call them, through @retake/engine/integrations; tests run them on scratch folders only.
 *
 * - **Where the app runs from** (critique H1): a quarantined app opened from Downloads or a disk image runs from a
 *   random read-only copy (`…/AppTranslocation/<uuid>/d/Retake.app`, gone after a restart) or from the mounted image
 *   under /Volumes. Anything recorded with such a path (the command's link, the Claude registrations) would break, so
 *   every integration waits until the app was moved to Applications.
 * - **The command:** a symbolic link (default `~/.local/bin/retake`) to the launcher inside the app
 *   (`Contents/Resources/bin/retake`). Never replaces a file that is not a link into an app's launcher; a link into
 *   another copy of the app is replaced only when asked; removal touches such links only. The shell profile is never
 *   edited and the person's login shell is never run: the PATH said is the one the app sees, with the zsh line to copy.
 * - **Claude Code:** the plugin route's two lines (config-snippet.ts pluginInstallSteps) run as argv — no shell, the
 *   `cd` as the working folder — with a `claude` found in a fixed list, a small environment, a time limit; its output
 *   is the caller's to show as untrusted text.
 * - **Claude Desktop:** `mcpServers.retake` merged into its config after the person saw the change — a symlinked
 *   config written at its real path, its mode kept, every other key kept, a backup first (a capped number), an atomic
 *   rename, the file read back; unparsable JSON or a non-object `mcpServers` refused; a different `retake` entry
 *   replaced only when asked.
 */
import { spawn } from 'node:child_process';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { constants, accessSync, chmodSync, closeSync, copyFileSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { isUnder } from '@retake/core/base';
import { nodeFileFacts } from '@retake/core/io';

/** A refusal of a setup step: `reason` is a stable word the Studio keys its words by. */
export class SetupError extends Error {
  constructor(
    readonly reason: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'SetupError';
  }
}

// ── Where the app runs from ───────────────────────────────────────────────────

/** Where an app bundle sits: `ok`, or a place that makes every integration point at a folder that goes away. */
export type InstallLocation = 'ok' | 'translocated' | 'read_only' | 'volumes';

/** What the person does about a location that is not `ok` (the Studio, doctor and the shell say these words). */
export const MOVE_TO_APPLICATIONS = 'Move Retake to Applications, then open it again';

/**
 * Where `app` (the `.app` folder) runs from — pure: the path marker of App Translocation first, then a read-only
 * volume (`readOnly`: the caller's fact — MNT_RDONLY in the shell, EROFS here), then anything under /Volumes (a disk
 * image or an external disk: it comes and goes).
 */
export function installLocation(app: string, facts: { readOnly: boolean }): InstallLocation {
  if (app.includes('/AppTranslocation/')) return 'translocated';
  if (facts.readOnly) return 'read_only';
  if (app === '/Volumes' || app.startsWith('/Volumes/')) return 'volumes';
  return 'ok';
}

/** Why a location stops the integrations, in a sentence (followed by MOVE_TO_APPLICATIONS). */
export function installLocationWords(loc: InstallLocation): string {
  switch (loc) {
    case 'translocated':
      return 'Retake runs from a temporary copy macOS made when it was opened from Downloads or a disk image';
    case 'read_only':
      return 'Retake runs from a read-only disk (its disk image)';
    case 'volumes':
      return 'Retake runs from a disk under /Volumes, which can go away';
    case 'ok':
      return 'Retake runs from where it was installed';
  }
}

/** Whether a folder is on a read-only volume (EROFS; a folder this user cannot write to is not read-only). */
export function onReadOnlyVolume(p: string): boolean {
  try {
    accessSync(p, constants.W_OK);
    return false;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EROFS';
  }
}

// ── The retake command ────────────────────────────────────────────────────────

/** The command's name on the PATH, and its launcher inside the app (relative to `Contents/Resources`). */
export const CLI_NAME = 'retake';
export const LAUNCHER_REL = 'bin/retake';
/**
 * The installed app's bundle identifier (apps/desktop tauri.conf.json `identifier`; a test build adds `.<suffix>`: the
 * bundle script's --id) — a test compares the two.
 */
export const APP_BUNDLE_ID = 'local.retake.desktop';
/** The launcher's exact place in an app: `<X>.app/Contents/Resources/bin/retake` (the `.app` folder captured). */
const APP_LAUNCHER_RE = /^(\/.+\.app)\/Contents\/Resources\/bin\/retake$/;
/** An Info.plist larger than this is no app's of ours (the read stays small). */
const INFO_PLIST_MAX = 256 * 1024;

/** The bundle identifier in an app's `Contents/Info.plist` (XML, as the bundler writes it), or null. */
export function appBundleId(app: string): string | null {
  const file = join(app, 'Contents', 'Info.plist');
  try {
    const st = statSync(file);
    if (!st.isFile() || st.size > INFO_PLIST_MAX) return null;
    const m = /<key>CFBundleIdentifier<\/key>\s*<string>([A-Za-z0-9.-]{1,255})<\/string>/.exec(readFileSync(file, 'utf8'));
    return m ? m[1]! : null;
  } catch {
    return null;
  }
}

/** Is this the identifier of a copy of Retake (the app's, or a test build's `<id>.<suffix>`)? */
export function isRetakeBundleId(id: string | null): boolean {
  return id !== null && (id === APP_BUNDLE_ID || id.startsWith(`${APP_BUNDLE_ID}.`));
}

/**
 * Whether a link's target is another copy of Retake's launcher (review c B-M3 / A-L7): the exact layout
 * `<X>.app/Contents/Resources/bin/retake` AND an app there whose Info.plist names Retake's identifier — or no app there
 * any more (a dangling link in that exact layout runs nothing, and its app cannot be asked). Anything else (a formula's
 * `…/bin/retake`, a checkout's wrapper, another app's `bin/retake`) is the person's file: never replaced, never removed.
 */
function otherAppLauncher(target: string): { dangling: boolean } | null {
  const m = APP_LAUNCHER_RE.exec(target);
  if (!m) return null;
  const app = m[1]!;
  if (!existsSync(app)) return { dangling: true };
  if (!isRetakeBundleId(appBundleId(app))) return null;
  return { dangling: !existsSync(target) };
}

/** The default folder of the command (no admin; Claude Code's own installer puts `claude` there). */
export function defaultCliDir(home: string): string {
  return join(home, '.local', 'bin');
}

/** What lies at the command's place. */
export type CliLink =
  | { state: 'absent' }
  /** A link to this app's launcher. */
  | { state: 'ours'; target: string }
  /** A link to another app's launcher (`dangling`: that app is gone or moved). */
  | { state: 'other_app'; target: string; dangling: boolean }
  /** Anything else: a file, a folder, a link elsewhere — never replaced, never removed. */
  | { state: 'foreign'; what: 'file' | 'folder' | 'link'; target?: string };

function linkTarget(link: string): string {
  return resolve(dirname(link), readlinkSync(link));
}

function samePath(a: string, b: string): boolean {
  if (resolve(a) === resolve(b)) return true;
  try {
    return realpathSync.native(a) === realpathSync.native(b);
  } catch {
    return false;
  }
}

/** What lies at `link` (the command's place), compared with `launcher` (this app's). */
export function cliLinkState(link: string, launcher: string): CliLink {
  let st;
  try {
    st = lstatSync(link);
  } catch {
    return { state: 'absent' };
  }
  if (!st.isSymbolicLink()) return { state: 'foreign', what: st.isDirectory() ? 'folder' : 'file' };
  const target = linkTarget(link);
  if (samePath(target, launcher)) return { state: 'ours', target };
  const other = otherAppLauncher(target);
  if (other) return { state: 'other_app', target, dangling: other.dangling };
  return { state: 'foreign', what: 'link', target };
}

export interface CliInstallResult {
  path: string;
  result: 'created' | 'kept' | 'replaced';
}

/**
 * Link `<dir>/retake` to `launcher`. The default folder (`createDir`) is created (0755) when missing; a chosen one must
 * exist. A link to this launcher is kept; a link to another app's launcher is replaced only with `replace`; anything
 * else is refused (SetupError `foreign`). The replacement is atomic (a new link renamed over the old one).
 */
export function installCliLink(dir: string, launcher: string, o: { replace?: boolean; createDir?: boolean } = {}): CliInstallResult {
  if (!isAbsolute(dir)) throw new SetupError('not_absolute', `${dir} is not an absolute folder`);
  if (!existsSync(dir)) {
    if (!o.createDir) throw new SetupError('no_folder', `${dir} does not exist`);
    mkdirSync(dir, { recursive: true, mode: 0o755 });
  }
  const link = join(dir, CLI_NAME);
  const now = cliLinkState(link, launcher);
  if (now.state === 'ours') return { path: link, result: 'kept' };
  if (now.state === 'foreign') {
    throw new SetupError('foreign', `${link} already exists and is not Retake's command (${now.what}${now.target ? ` → ${now.target}` : ''}): it is left as it is — remove or rename it yourself, or choose another folder`, { what: now.what });
  }
  if (now.state === 'other_app' && !o.replace) {
    throw new SetupError('other_app', `${link} runs another copy of Retake (${now.target}${now.dangling ? ', which is gone' : ''}): Replace points it at this one`, { target: now.target, dangling: now.dangling });
  }
  if (now.state === 'absent') {
    symlinkSync(launcher, link);
    return { path: link, result: 'created' };
  }
  const temp = join(dir, `.${CLI_NAME}.${process.pid}.${randomBytes(4).toString('hex')}`);
  symlinkSync(launcher, temp);
  try {
    renameSync(temp, link);
  } catch (e) {
    rmSync(temp, { force: true });
    throw e;
  }
  return { path: link, result: 'replaced' };
}

/** Remove the command's link when it points into an app's launcher (this one or another); anything else is refused. */
export function removeCliLink(link: string, launcher: string): 'removed' | 'absent' {
  const now = cliLinkState(link, launcher);
  if (now.state === 'absent') return 'absent';
  if (now.state === 'foreign') throw new SetupError('foreign', `${link} is not Retake's command (${now.what}${now.target ? ` → ${now.target}` : ''}): it is left as it is`, { what: now.what });
  unlinkSync(link);
  return 'removed';
}

function executable(p: string): boolean {
  try {
    accessSync(p, constants.X_OK);
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Which `retake` the PATH `path` finds first, and whether `dir` is on it (no shell: the PATH as given). */
export function cliOnPath(dir: string, path: string, exists: (p: string) => boolean = executable): { onPath: boolean; first: string | null } {
  const entries = path.split(delimiter).filter((e) => e && isAbsolute(e));
  const onPath = entries.some((e) => samePath(e, dir));
  const firstDir = entries.find((e) => exists(join(e, CLI_NAME)));
  return { onPath, first: firstDir ? join(firstDir, CLI_NAME) : null };
}

/** The zsh profile the PATH line goes into (the person adds it: the tool never edits a shell profile). */
export const ZSH_PROFILE = '~/.zprofile';

/** A folder name a zsh line may hold unquoted inside double quotes (nothing zsh expands or ends there). */
const ZSH_PLAIN = /^[A-Za-z0-9._/@%+,=-]*$/;

/** `s` in zsh single quotes (nothing inside expands; a single quote is closed, escaped and reopened). */
export function zshQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * The zsh line that puts `dir` first on the PATH of new Terminal windows (to copy into ZSH_PROFILE). A folder under the
 * home is written `$HOME/…`; a name with anything zsh would expand or end on (`$`, a backtick, a quote, a backslash, a
 * space…) is single-quoted (review c A-L1 / B-L6: a folder named `$(cmd)` never runs cmd at each login).
 */
export function zshPathLine(dir: string, home: string): string {
  const abs = resolve(dir);
  const h = resolve(home);
  if (abs.startsWith(`${h}/`)) {
    const rest = abs.slice(h.length + 1);
    return ZSH_PLAIN.test(rest) ? `export PATH="$HOME/${rest}:$PATH"` : `export PATH="$HOME/"${zshQuote(rest)}":$PATH"`;
  }
  return ZSH_PLAIN.test(abs) ? `export PATH="${abs}:$PATH"` : `export PATH=${zshQuote(abs)}":$PATH"`;
}

/**
 * A folder the person chose for the command (through the shell's native panel): absolute, a folder (links followed),
 * theirs (owned by `uid`) and writable, outside the workspace and the app. Its real path, or SetupError.
 */
export function checkCliFolder(dir: string, o: { uid: number; workspace: string; sealed?: string }): string {
  if (!isAbsolute(dir) || dir.includes('\0')) throw new SetupError('not_absolute', 'the folder must be an absolute path');
  let real: string;
  try {
    real = realpathSync.native(dir);
  } catch {
    throw new SetupError('no_folder', `${dir} does not exist`);
  }
  const st = statSync(real);
  if (!st.isDirectory()) throw new SetupError('no_folder', `${dir} is not a folder`);
  if (st.uid !== o.uid) throw new SetupError('not_owned', `${dir} is not your folder (another user owns it): choose a folder of yours — or link it yourself with sudo ln -s`);
  try {
    accessSync(real, constants.W_OK);
  } catch {
    throw new SetupError('not_writable', `${dir} cannot be written to`);
  }
  if (isUnder(real, o.workspace, nodeFileFacts)) throw new SetupError('inside_workspace', `${dir} lies inside the workspace: choose a folder outside it`);
  if (o.sealed && isUnder(real, o.sealed, nodeFileFacts)) throw new SetupError('inside_app', `${dir} lies inside the app: choose a folder outside it`);
  return real;
}

// ── The app's own settings (<Retake home>/app.json) ───────────────────────────

/** `<home>/app.json`: what the installed app remembers of its set-up. */
export interface AppSettings {
  /** The version whose Set-up sheet the person closed (the sheet comes back at the next major). */
  setup_seen?: string;
  /** The command's link, when the app made it. */
  cli?: { path: string; at: string };
}

export const APP_SETTINGS_FILE = 'app.json';

/** The settings in `home` ({} when absent or unreadable). */
export function readAppSettings(home: string): AppSettings {
  try {
    const v = JSON.parse(readFileSync(join(home, APP_SETTINGS_FILE), 'utf8')) as unknown;
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
    const o = v as Record<string, unknown>;
    const out: AppSettings = {};
    if (typeof o.setup_seen === 'string' && /^\d+\.\d+\.\d+$/.test(o.setup_seen)) out.setup_seen = o.setup_seen;
    const cli = o.cli as Record<string, unknown> | undefined;
    if (cli && typeof cli.path === 'string' && isAbsolute(cli.path) && typeof cli.at === 'string') out.cli = { path: cli.path, at: cli.at };
    return out;
  } catch {
    return {};
  }
}

/**
 * L5.16d: what the desktop app remembers of its update checks — `<home>/desktop-updates.json`, written by the shell
 * (desktop_core update_flow `write_remembered`; a static test compares the file name): the last successful check
 * (seconds since 1970) and an install that failed (said by the app's next launch, and kept until a newer check, an
 * install or the person's Later: review d B-L2). Doctor shows both (critique L7: a feed that stopped moving is
 * visible). Unreadable or foreign: nothing.
 */
export const UPDATES_FILE = 'desktop-updates.json';
/** Turns the app's update checks off (desktop_core update_flow DISABLE_ENV). */
export const UPDATE_DISABLE_ENV = 'RETAKE_DISABLE_UPDATE_CHECK';
export interface UpdateChecks {
  checked: number | null;
  failed: { failure: string; version: string } | null;
}
export function readUpdateChecks(home: string): UpdateChecks {
  const none: UpdateChecks = { checked: null, failed: null };
  try {
    const v = JSON.parse(readFileSync(join(home, UPDATES_FILE), 'utf8')) as Record<string, unknown> | null;
    if (!v || typeof v !== 'object' || Array.isArray(v) || v.version !== 1) return none;
    const checked = typeof v.checked === 'number' && Number.isSafeInteger(v.checked) && v.checked >= 0 ? v.checked : null;
    const f = v.failed as Record<string, unknown> | null | undefined;
    const failed = f && typeof f === 'object' && ['check', 'download', 'install', 'not_writable'].includes(f.failure as string) && typeof f.version === 'string' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(f.version) && f.version.length <= 64 ? { failure: f.failure as string, version: f.version } : null;
    return { checked, failed };
  } catch {
    return none;
  }
}

/** RETAKE_DISABLE_UPDATE_CHECK's value turns the checks off (1, true or yes: update_flow `disabled`). */
export function updateChecksOff(v: string | undefined): boolean {
  const t = (v ?? '').trim().toLowerCase();
  return t === '1' || t === 'true' || t === 'yes';
}

/** Merge `patch` into the settings (`null` removes a key), written whole and atomically (0600; the home 0700). */
export function writeAppSettings(home: string, patch: { [K in keyof AppSettings]?: AppSettings[K] | null }): AppSettings {
  const next: Record<string, unknown> = { ...readAppSettings(home) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete next[k];
    else if (v !== undefined) next[k] = v;
  }
  mkdirSync(home, { recursive: true, mode: 0o700 });
  atomicWrite(join(home, APP_SETTINGS_FILE), `${JSON.stringify(next, null, 2)}\n`, 0o600);
  return next as AppSettings;
}

/** Has the person closed the Set-up sheet of this major version (`version`: the app's)? */
export function setupSeen(s: AppSettings, version: string): boolean {
  const major = (v: string) => Number(v.split('.')[0]);
  return s.setup_seen !== undefined && major(s.setup_seen) >= major(version);
}

/** Write `text` to `file` through a temporary file beside it (fsync, the mode set, renamed over). */
function atomicWrite(file: string, text: string, mode: number): void {
  const temp = join(dirname(file), `.${basename(file)}.retake-${process.pid}-${randomBytes(4).toString('hex')}.tmp`);
  const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, mode);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    chmodSync(temp, mode);
    renameSync(temp, file);
  } catch (e) {
    rmSync(temp, { force: true });
    throw e;
  }
}

// ── Claude Desktop ────────────────────────────────────────────────────────────

/** Claude Desktop's config file under `home` (macOS). */
export function claudeDesktopConfigFile(home: string): string {
  return join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
}

/** Backups of the config kept (the oldest go first). */
export const DESKTOP_BACKUPS_MAX = 5;
const BACKUP_INFIX = '.retake-backup-';

/**
 * Where the config's backups go (review c A-L2): a folder of Retake's own, `<Retake home>/backups/claude-desktop` (0700,
 * each backup 0600) — never beside the file nor beside a symlinked config's target (a dotfiles repository would get
 * copies of every MCP server's `env`, tokens included, that a later `git add -A` commits).
 */
export function desktopBackupDir(retakeHome: string): string {
  return join(retakeHome, 'backups', 'claude-desktop');
}

export interface DesktopPlan {
  /** create: no file yet · add: no `retake` entry · same: the entry is there as it would be written · replace: a different one. */
  kind: 'create' | 'add' | 'same' | 'replace';
  /** The `retake` entry there now (replace, same). */
  current?: unknown;
  /** The whole file as it would be written (two-space JSON, every other key kept). */
  text: string;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => sameJson(x, b[i]));
  if (!isPlainObject(a) || !isPlainObject(b)) return false;
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => Object.hasOwn(b, k) && sameJson(a[k], b[k]));
}

/**
 * The config with `mcpServers[name] = entry` — pure. `text` null: no file yet. SetupError: unparsable JSON
 * (`unparsable`), a top level that is no object (`not_object`), an `mcpServers` that is no object (`servers_not_object`).
 */
export function planDesktopEntry(text: string | null, entry: Record<string, unknown>, name = 'retake'): DesktopPlan {
  if (text === null) return { kind: 'create', text: `${JSON.stringify({ mcpServers: { [name]: entry } }, null, 2)}\n` };
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    throw new SetupError('unparsable', `Claude Desktop's config is not valid JSON (${(e as Error).message}): it is left as it is — fix it, or add the entry by hand`);
  }
  if (!isPlainObject(doc)) throw new SetupError('not_object', "Claude Desktop's config is not a JSON object: it is left as it is");
  const servers = doc.mcpServers;
  if (servers !== undefined && !isPlainObject(servers)) throw new SetupError('servers_not_object', "Claude Desktop's config has an mcpServers that is not an object: it is left as it is");
  const current = isPlainObject(servers) && Object.hasOwn(servers, name) ? servers[name] : undefined;
  const next = { ...doc, mcpServers: { ...(servers ?? {}), [name]: entry } };
  const out = `${JSON.stringify(next, null, 2)}\n`;
  if (current === undefined) return { kind: 'add', text: out };
  return { kind: sameJson(current, entry) ? 'same' : 'replace', current, text: out };
}

export interface DesktopWriteResult {
  kind: DesktopPlan['kind'];
  /** The file written (a symlinked config: its real path). */
  file: string;
  /** The copy of the file as it was (in `backupDir`). */
  backup?: string;
}

/**
 * Merge the entry into the config at `file` (its folder must exist: Claude Desktop made it). A link is followed to the
 * real file, which is written in place through a temporary file beside it with the mode it had (0600 for a new file);
 * a backup is copied first into `backupDir` (desktopBackupDir: Retake's own folder; a unique name; DESKTOP_BACKUPS_MAX
 * kept); the file is read back and must hold the entry. A different entry needs `replace` (SetupError `needs_replace`,
 * with the one there now).
 */
export function writeDesktopEntry(file: string, entry: Record<string, unknown>, o: { backupDir: string; replace?: boolean; now?: Date; name?: string; backupsMax?: number; /** Tests: another program writes between the write and the read-back. */ afterWrite?: (file: string) => void }): DesktopWriteResult {
  const name = o.name ?? 'retake';
  let real = file;
  let text: string | null = null;
  if (existsSync(file) || isLink(file)) {
    try {
      real = realpathSync.native(file);
    } catch {
      throw new SetupError('dangling', `${file} is a link to a file that does not exist: it is left as it is`);
    }
    if (!statSync(real).isFile()) throw new SetupError('not_file', `${file} is not a file`);
    text = readFileSync(real, 'utf8');
  }
  if (!existsSync(dirname(real))) throw new SetupError('no_claude', `${dirname(real)} does not exist: open Claude Desktop once, then try again`);
  const plan = planDesktopEntry(text, entry, name);
  if (plan.kind === 'same') return { kind: 'same', file: real };
  if (plan.kind === 'replace' && !o.replace) throw new SetupError('needs_replace', `Claude Desktop already has a different "${name}" entry: Replace overwrites it`, { current: plan.current });
  const mode = text === null ? 0o600 : statSync(real).mode & 0o777;
  let backup: string | undefined;
  if (text !== null) {
    backup = backupCopy(real, o.backupDir, o.now ?? new Date());
    pruneBackups(o.backupDir, basename(real), o.backupsMax ?? DESKTOP_BACKUPS_MAX);
  }
  atomicWrite(real, plan.text, mode);
  o.afterWrite?.(real);
  let back: unknown;
  try {
    back = JSON.parse(readFileSync(real, 'utf8'));
  } catch {
    back = undefined;
  }
  const kept = isPlainObject(back) && isPlainObject(back.mcpServers) && sameJson(back.mcpServers[name], entry);
  if (!kept) throw new SetupError('not_kept', `${real} does not hold the entry after writing it (another program rewrote it?)${backup ? `: the backup is ${backup}` : ''}`);
  return { kind: plan.kind, file: real, ...(backup ? { backup } : {}) };
}

function isLink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Copy `real` into `dir` (made 0700) as `<name>.retake-backup-<stamp>[-n]`, 0600: a unique name, never an EEXIST. */
function backupCopy(real: string, dir: string, now: Date): string {
  if (!isAbsolute(dir)) throw new SetupError('not_absolute', `${dir} is not an absolute folder`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stem = join(dir, `${basename(real)}${BACKUP_INFIX}${now.toISOString().replace(/[:.]/g, '-')}`);
  for (let i = 0; i < 100; i++) {
    const name = i === 0 ? stem : `${stem}-${i}`;
    try {
      copyFileSync(real, name, constants.COPYFILE_EXCL);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw e;
    }
    chmodSync(name, 0o600);
    return name;
  }
  throw new SetupError('backup', `could not name a backup of ${real} in ${dir}: nothing was written`);
}

function pruneBackups(dir: string, name: string, max: number): void {
  const prefix = `${name}${BACKUP_INFIX}`;
  const all = readdirSync(dir)
    .filter((n) => n.startsWith(prefix))
    .sort();
  for (const n of all.slice(0, Math.max(0, all.length - max))) rmSync(join(dir, n), { force: true });
}

/** Whether Claude Desktop runs, from a process list (`ps -axo comm=`: one executable path a line). */
export function claudeDesktopIn(processes: string): boolean {
  return processes.split('\n').some((l) => /\/Claude\.app\/Contents\/MacOS\/Claude$/.test(l.trim()));
}

// ── Claude Code ───────────────────────────────────────────────────────────────

/** Where `claude` is looked for, in order (never the person's shell PATH: a Finder app does not have it). */
export function claudeCandidates(home: string): string[] {
  return [join(home, '.local', 'bin', 'claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude', join(home, '.claude', 'local', 'claude')];
}

/** The first `claude` of the fixed list, or null. */
export function findClaude(home: string, isExec: (p: string) => boolean = executable): string | null {
  return claudeCandidates(home).find((p) => isExec(p)) ?? null;
}

/** One line of the plugin route, as argv: `cwd` replaces the line's `cd`. */
export interface ClaudeStep {
  argv: string[];
  cwd?: string;
}

export interface ClaudeStepResult {
  argv: string[];
  code: number | null;
  /** stdout and stderr together, ANSI sequences and control characters (but newlines and tabs) removed, capped. */
  output: string;
  ms: number;
}

export interface ClaudeRunResult {
  ok: boolean;
  /** The time limit passed (Claude Code may be waiting for an answer): run the lines in Terminal. */
  timedOut: boolean;
  steps: ClaudeStepResult[];
}

export const CLAUDE_RUN_MS = 60_000;
export const CLAUDE_OUTPUT_MAX = 16 * 1024;

/**
 * The environment `claude` runs with: a fixed PATH (its own folder, the system's, Homebrew's, then the app's Node.js
 * last), the home and user, the locale, and CLAUDE_CONFIG_DIR when set — nothing else of the app's environment.
 */
export function claudeEnv(claude: string, env: NodeJS.ProcessEnv, nodeDir?: string): NodeJS.ProcessEnv {
  const path = [...new Set([dirname(claude), '/usr/bin', '/bin', '/usr/sbin', '/sbin', '/opt/homebrew/bin', '/usr/local/bin', ...(nodeDir ? [nodeDir] : [])])].join(delimiter);
  const out: NodeJS.ProcessEnv = { PATH: path };
  for (const k of ['HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TMPDIR', 'CLAUDE_CONFIG_DIR']) if (env[k]) out[k] = env[k];
  return out;
}

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

/** Output made plain text: escape sequences and control characters out (newlines and tabs kept). */
export function plainOutput(s: string): string {
  return s.replace(ANSI_RE, '').replace(/\r\n?/g, '\n').replace(CONTROL_RE, '');
}

type SpawnFn = (cmd: string, args: string[], o: SpawnOptions) => ChildProcess;

/** After a step's process exited, how long its pipes may still drain (a helper it left may hold them open). */
export const CLAUDE_DRAIN_MS = 200;
/** After SIGTERM at the time limit, how long before SIGKILL (the answer comes then, whatever the pipes do). */
export const CLAUDE_KILL_MS = 2000;

/**
 * Run the steps one after the other with `claude` (argv, no shell; stdin closed), stopping at the first that fails.
 * A step ends when its process exits — judged by its exit code — plus CLAUDE_DRAIN_MS for the last output, then its
 * pipes are destroyed (review c A-M1: a helper `claude` starts in a session of its own may hold them open for ever; the
 * answer never waits for it). The whole run has `timeoutMs`: then the step's process group gets SIGTERM, SIGKILL
 * CLAUDE_KILL_MS later, and the step answers at once with `timedOut` set.
 */
export async function runClaudeSteps(claude: string, steps: ClaudeStep[], o: { env: NodeJS.ProcessEnv; timeoutMs?: number; outputMax?: number; spawn?: SpawnFn; drainMs?: number; killMs?: number }): Promise<ClaudeRunResult> {
  const deadline = Date.now() + (o.timeoutMs ?? CLAUDE_RUN_MS);
  const max = o.outputMax ?? CLAUDE_OUTPUT_MAX;
  const out: ClaudeStepResult[] = [];
  for (const step of steps) {
    const t0 = Date.now();
    const r = await new Promise<{ code: number | null; output: string; timedOut: boolean }>((done) => {
      let text = '';
      let timedOut = false;
      let settled = false;
      let exited = false;
      let exitCode: number | null = null;
      const timers: NodeJS.Timeout[] = [];
      const child = (o.spawn ?? spawn)(claude, step.argv, { cwd: step.cwd, env: o.env, stdio: ['ignore', 'pipe', 'pipe'], detached: true, shell: false });
      const finish = (code: number | null, extra = '') => {
        if (settled) return;
        settled = true;
        for (const t of timers) clearTimeout(t);
        child.stdout?.destroy();
        child.stderr?.destroy();
        done({ code, output: `${text}${extra}`, timedOut });
      };
      const add = (b: Buffer) => {
        if (text.length < max) text += b.toString('utf8');
      };
      child.stdout?.on('data', add);
      child.stderr?.on('data', add);
      const kill = (sig: NodeJS.Signals) => {
        try {
          if (child.pid) process.kill(-child.pid, sig);
        } catch {
          child.kill(sig);
        }
      };
      timers.push(
        setTimeout(() => {
          // Exited already (its pipes draining): its exit code decides, not the clock.
          if (exited) return finish(exitCode);
          timedOut = true;
          kill('SIGTERM');
          timers.push(
            setTimeout(() => {
              kill('SIGKILL');
              finish(exitCode);
            }, o.killMs ?? CLAUDE_KILL_MS),
          );
        }, Math.max(0, deadline - Date.now())),
      );
      child.once('error', (e) => finish(null, e.message));
      child.once('exit', (code) => {
        exited = true;
        exitCode = code;
        timers.push(setTimeout(() => finish(code), o.drainMs ?? CLAUDE_DRAIN_MS));
      });
      // Every pipe closed after the exit: the output is whole, no need to wait the drain.
      child.once('close', (code) => finish(code ?? exitCode));
    });
    out.push({ argv: step.argv, code: r.code, output: plainOutput(r.output).slice(0, max), ms: Date.now() - t0 });
    if (r.timedOut) return { ok: false, timedOut: true, steps: out };
    if (r.code !== 0) return { ok: false, timedOut: false, steps: out };
  }
  return { ok: true, timedOut: false, steps: out };
}
