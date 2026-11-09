/**
 * old-name: this whole file (the guard test, core old-name.test.ts, allows it).
 *
 * L5.13: Retake was called Demo Studio before it. Every name of that time the code still knows lives here, and nowhere
 * else (DESIGN "L5.13"). The rule: configuration and state under the old names are never read — the old home, the old
 * workspace file, the old variables and tool folders are only detected (a stat, or a bounded read where said) so the
 * person is told what to move; nothing is moved. The exceptions, each for a reason:
 * - markers the tool wrote itself into folders a person keeps (a theme's provenance file, a raw package's manifest) are
 *   recognised under the old name too, so a theme or a package the tool made can still be replaced; a session
 *   snapshot's metadata key too, for the "made on another computer" warning;
 * - the old tool folder stays in the agent-writable list (its files are never run as code: critique H1), and the old
 *   token variable stays in a worker's dropped list (a shell may still export it: R-REN-04);
 * - the variables the tool writes for the person's own code (hook and seed shells, sandbox process services) are
 *   written under both names (critique H2) — and never read.
 */
import { closeSync, existsSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { defaultRetakeHome, statePath } from './layout.js';

/** The product's name before L5.13. */
export const OLD_PRODUCT_NAME = 'Demo Studio';
/** The home before L5.13 (`~/.demo-studio`), and the name of a workspace's or a project's tool folder then. */
export const OLD_DIR = '.demo-studio';
/** The workspace file before L5.13. */
export const OLD_WORKSPACE_FILE = 'studio.yaml';
/** The prefix of the variables before L5.13. */
export const OLD_ENV_PREFIX = 'DEMO_STUDIO_';
/** The kit's module specifier before L5.13 (imported by a person's own components). */
export const OLD_KIT_MODULE = '@demo-studio/components/kit';
/** A tool-made theme's provenance file, and its `made_by`, before L5.13 (still recognised). */
export const OLD_THEME_PROVENANCE_FILE = '.demo-studio-theme.json';
export const OLD_MADE_BY = 'demo-studio';
/** A raw package's manifest `kind` before L5.13 (still recognised). */
export const OLD_RAW_KIND = 'demo-studio/raw-capture';

/** A session snapshot's metadata key before L5.13 (still read, for the "made on another computer" warning only). */
export const OLD_SNAPSHOT_META_KEY = 'demo_studio';

/**
 * The computer a session snapshot says it was made on — under its metadata key of today (`retake`) or of before L5.13
 * (review A L4: snapshots moved with the old home keep the old key, and the warning would go silent). Undefined when
 * neither names one.
 */
export function snapshotMachine(snapshot: unknown): string | undefined {
  if (!snapshot || typeof snapshot !== 'object') return undefined;
  const s = snapshot as Record<string, unknown>;
  const meta = (s.retake ?? s[OLD_SNAPSHOT_META_KEY]) as { machine?: unknown } | undefined;
  return meta && typeof meta === 'object' && typeof meta.machine === 'string' && meta.machine ? meta.machine : undefined;
}

/** Agent-writable folders of a project under the old name: their files are never run as code either (critique H1). */
export const OLD_AGENT_WRITABLE_PATHS: readonly string[] = [`${OLD_DIR}/`];

/** Secret variables of the old name a worker never gets: a shell may still export the old HTTP token (R-REN-04). */
export const OLD_SECRET_ENV: readonly RegExp[] = [/^DEMO_STUDIO_MCP_TOKEN$/];

/** The variables the tool writes for the person's own code, after `RETAKE_` (critique H2). */
export const OUTGOING_ENV = ['SANDBOX', 'RUN_ID', 'ENV', 'PROJECT_DIR', 'ALLOWED_HOSTS'] as const;

/**
 * Each outgoing `RETAKE_*` variable of `env` (hook shells, seed shells, sandbox process services) also under its old
 * name, so a product's script or server that still reads the old one keeps working. Written only — the tool never reads
 * an old name (BACKLOG BL-136: drop them later).
 */
export function withOldOutgoingEnv<T extends Record<string, string | undefined>>(env: T): T {
  const out: Record<string, string | undefined> = { ...env };
  for (const k of OUTGOING_ENV) {
    const v = env[`RETAKE_${k}`];
    if (v !== undefined) out[`${OLD_ENV_PREFIX}${k}`] = v;
  }
  return out as T;
}

/** The names of the old variables set in `env`, sorted. */
export function oldEnvNames(env: Record<string, string | undefined>): string[] {
  return Object.keys(env)
    .filter((k) => k.startsWith(OLD_ENV_PREFIX) && env[k] !== undefined)
    .sort();
}

/**
 * The old variables set in `env` whose `RETAKE_*` twin is not (L5.13a reviews A M4 / B M4): the tool read them before
 * (DEMO_STUDIO_HOME, DEMO_STUDIO_ROOT…) and now runs without them, on another home or workspace — so it says so at CLI
 * start, in engine_info and in the sign-in preflight. Names only, never their values; the outgoing names (written for
 * the person's code) are not counted.
 */
export function oldVarsUnread(env: Record<string, string | undefined> = process.env): string[] {
  const outgoing: readonly string[] = OUTGOING_ENV;
  return oldEnvNames(env).filter((k) => {
    const rest = k.slice(OLD_ENV_PREFIX.length);
    return /^[A-Z0-9_]+$/.test(rest) && !outgoing.includes(rest) && env[`RETAKE_${rest}`] === undefined;
  });
}

/** The new name of an old variable (DEMO_STUDIO_HOME → RETAKE_HOME). */
export function newVarName(old: string): string {
  return `RETAKE_${old.slice(OLD_ENV_PREFIX.length)}`;
}

/** The one stderr line at CLI start for old variables still set (oldVarsUnread), and the preflight's hint. */
export function oldVarsLine(names: readonly string[]): string {
  const one = names.length === 1;
  return `${names.join(', ')} ${one ? 'is' : 'are'} set but no longer read: rename ${one ? 'it' : 'them'} ${names.map(newVarName).join(', ')} where ${one ? 'it is' : 'they are'} set — shell profile, the MCP registration's env`;
}

/** The message of a component that imports the kit under its old specifier. */
export function oldKitImportMessage(spec: string, kit: string): string | undefined {
  return spec === OLD_KIT_MODULE ? `import "${spec}" is the kit's name before L5.13: import "${kit}"` : undefined;
}

// ── the home ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The variable that named the home before L5.13 (DEMO_STUDIO_HOME). */
export const OLD_HOME_VAR = `${OLD_ENV_PREFIX}HOME`;

/** Where the sign-ins of before L5.13 are: `~/.demo-studio`, or the folder DEMO_STUDIO_HOME names. */
export interface OldHomeDir {
  /** Absolute. */
  dir: string;
  /** As told to the person: `~/.demo-studio`, or the variable's folder (`~/…` under the home). */
  shown: string;
  /** `shown` as a shell word for a command (single-quoted absolute path when it needs quoting). */
  word: string;
  /** Set when the folder is the one DEMO_STUDIO_HOME names (the person had moved the home then). */
  byVar?: typeof OLD_HOME_VAR;
}

/**
 * The home of before L5.13 for `env` (the L5.13a leftover): with DEMO_STUDIO_HOME set (and RETAKE_HOME not) the old
 * build kept the sign-ins in THAT folder — resolved as the old build did (`~` expanded, then made absolute) — so that
 * folder is the one to look at and to name, never `~/.demo-studio`; otherwise `~/.demo-studio`. Null when RETAKE_HOME is
 * set (the person chose a home). Computes paths only, touches nothing.
 */
export function oldHomeDir(env: Record<string, string | undefined> = process.env, home: string = homedir()): OldHomeDir | null {
  if (env.RETAKE_HOME?.trim()) return null;
  const v = env[OLD_HOME_VAR]?.trim();
  if (!v) return { dir: join(home, OLD_DIR), shown: `~/${OLD_DIR}`, word: `~/${OLD_DIR}` };
  const dir = resolve(v === '~' || v.startsWith('~/') ? home + v.slice(1) : v);
  const shown = dir === home ? '~' : dir.startsWith(`${home}/`) ? `~/${dir.slice(home.length + 1)}` : dir;
  return { dir, shown, word: shellWord(shown, dir), byVar: OLD_HOME_VAR };
}

/** A path as a shell word: as it is when it needs no quoting (a leading `~/` kept), single-quoted (absolute) otherwise. */
function shellWord(shown: string, dir: string): string {
  if (/^(?:~\/)?[\w@%+=:,./-]+$/.test(shown)) return shown;
  return `'${dir.replace(/'/g, `'\\''`)}'`;
}

/** The sign-ins left in the home of before L5.13. */
export interface OldHome {
  /** The old home (`~/.demo-studio`, or DEMO_STUDIO_HOME's folder) and `~/.retake` (absolute). */
  old: string;
  home: string;
  /** The old home as told (oldHomeDir `shown`). */
  shown: string;
  /** Set when the old home is DEMO_STUDIO_HOME's folder. */
  byVar?: typeof OLD_HOME_VAR;
  /** The new home exists already (files the tool recreated by itself: approvals.key, mcp-http.token, desktop.json). */
  homeExists: boolean;
  /** The command that moves it (a swap when the new home exists). */
  command: string;
}

/** Files the tool recreates by itself in a new home (a new approval key, a new HTTP token, the desktop app's settings). */
export const RECREATED_HOME_FILES = ['approvals.key', 'mcp-http.token', 'desktop.json'] as const;

/**
 * The sign-ins of before L5.13 that are not read (critique H3): the old home (oldHomeDir: DEMO_STUDIO_HOME's folder
 * when that is set, `~/.demo-studio` otherwise) holds `profiles/` or `sessions/` and the new one holds neither. Stats
 * only, and none at all when RETAKE_HOME is set (the person chose a home; every test sets it, so tests never look at the
 * real home: critique L10).
 */
export function oldHomeState(env: Record<string, string | undefined> = process.env, home: string = homedir(), exists: (p: string) => boolean = existsSync): OldHome | null {
  const where = oldHomeDir(env, home);
  if (!where) return null;
  const old = where.dir;
  const now = defaultRetakeHome(home);
  const signIns = (dir: string) => exists(join(dir, 'profiles')) || exists(join(dir, 'sessions'));
  if (old === now || !signIns(old) || signIns(now)) return null;
  const homeExists = exists(now);
  const command = homeExists ? `mv ~/.retake ~/.retake.after-upgrade && mv ${where.word} ~/.retake` : `mv ${where.word} ~/.retake`;
  return { old, home: now, shown: where.shown, ...(where.byVar ? { byVar: where.byVar } : {}), homeExists, command };
}

/** The one stderr line at CLI start (and the persona-missing preflight's hint). */
export function oldHomeLine(s: OldHome): string {
  const stop = `stop the Studio, MCP clients and the worker, then: ${s.command} (retake doctor says more)`;
  if (s.byVar) return `Sign-ins from before the rename are in ${s.shown}, set by ${s.byVar}, and not read (Retake keeps them in ~/.retake): set RETAKE_HOME to it, or move it — ${stop}`;
  return `Retake keeps sign-ins in ~/.retake; ${s.shown} (from before the rename) is not read — ${stop}`;
}

/**
 * The hints a sign-in preflight adds when a persona was never signed in (critique H3, review A M4): the old home still
 * holding the sign-ins, and an old DEMO_STUDIO_HOME naming a home that is no longer read.
 */
export function oldSignInHints(env: Record<string, string | undefined> = process.env, home: string = homedir(), exists: (p: string) => boolean = existsSync): string[] {
  const out: string[] = [];
  const old = oldHomeState(env, home, exists);
  if (old) out.push(oldHomeLine(old));
  const homeVar = oldVarsUnread(env).filter((k) => k === `${OLD_ENV_PREFIX}HOME`);
  if (homeVar.length) out.push(oldVarsLine(homeVar));
  return out;
}

/** What engine_info's `legacy` field says (the Studio's note, MCP's engine_info): absent when nothing old is left. */
export interface LegacyInfo {
  /** The old home still holds the only sign-ins (`~/.demo-studio`, or DEMO_STUDIO_HOME's folder: then `old_home_var`). */
  old_home?: string;
  /** `DEMO_STUDIO_HOME` when `old_home` is the folder it names (set RETAKE_HOME to it, or move it). */
  old_home_var?: string;
  /** Old variables set whose new twin is not (oldVarsUnread): an MCP client never shows the CLI's stderr line. */
  old_vars?: string[];
}

export function legacyInfo(env: Record<string, string | undefined> = process.env): LegacyInfo | undefined {
  const old = oldHomeState(env);
  const vars = oldVarsUnread(env);
  if (!old && !vars.length) return undefined;
  return { ...(old ? { old_home: old.shown, ...(old.byVar ? { old_home_var: old.byVar } : {}) } : {}), ...(vars.length ? { old_vars: vars } : {}) };
}

// ── the workspace file ──────────────────────────────────────────────────────────────────────────────────────────────

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** The first `max` bytes of a file as text ('' when it cannot be read). */
function head(file: string, max: number): string {
  let fd: number | undefined;
  try {
    fd = openSync(file, 'r');
    const buf = Buffer.alloc(max);
    const n = readSync(fd, buf, 0, max, 0);
    return buf.subarray(0, n).toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** `a` and `b` name the same folder (as written, or once links are resolved). */
function sameDir(a: string, b: string): boolean {
  if (resolve(a) === resolve(b)) return true;
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

/**
 * Whether `<dir>/studio.yaml` is this tool's workspace file from before L5.13 — not another tool's file of that
 * generic name (critique M3): it sits next to `projects/` or an old tool folder, or its first 4 KB carry `version:` and
 * one of the workspace keys. Read only to decide that (never parsed, never used). Never in the person's home folder
 * itself (L5.13a review A L2): the old home `~/.demo-studio` and a `~/Projects` sit there on most machines, so another
 * tool's `~/studio.yaml` would stop every lookup at `~`.
 */
export function oldWorkspaceFileAt(dir: string, home: string = homedir()): boolean {
  const file = join(dir, OLD_WORKSPACE_FILE);
  if (!isFile(file)) return false;
  if (home && sameDir(dir, home)) return false;
  if (isDir(join(dir, 'projects')) || isDir(join(dir, OLD_DIR))) return true;
  const text = head(file, 4096);
  return /^\s*version\s*:/m.test(text) && /^\s*(?:projects_dir|templates_dir|components_dir)\s*:/m.test(text);
}

/** A path for a shell command line (quoted when it needs to be). */
function shellArg(s: string): string {
  return /^[\w./~@%+=:,-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/** The refusal of a workspace whose only workspace file is the old one. */
export function oldWorkspaceFileMessage(root: string): { message: string; fix: string } {
  const old = join(root, OLD_WORKSPACE_FILE);
  return {
    message: `${old} is the workspace file from before L5.13 (${OLD_PRODUCT_NAME}): it is not read any more`,
    fix: `rename it: mv ${shellArg(old)} ${shellArg(join(root, 'retake.yaml'))}`,
  };
}

/**
 * Whether a `.gitignore` text names the old tool folder and not the new one (L5.13a review B M1): every project the
 * tool made carries one listing `.demo-studio/`, so once the folder is moved `git add .` would take `.retake/` (stills
 * of the product, journals, sandbox state).
 */
export function gitignoreNamesOldDirOnly(text: string): boolean {
  const names = new Set(text.split(/\r?\n/).map((l) => l.trim().replace(/^\//, '').replace(/\/+$/, '')));
  return names.has(OLD_DIR) && !names.has('.retake');
}

/** The one-line fix of such a `.gitignore` (the old line may stay: it still ignores a folder not moved yet). */
export function gitignoreFix(file: string): string {
  return `printf '.retake/\\n' >> ${shellArg(file)}`;
}

/** `mv <dir>/.demo-studio <dir>/.retake`, for a workspace's or a project's tool folder. */
export function oldDirMove(dir: string): string {
  return `mv ${shellArg(join(dir, OLD_DIR))} ${shellArg(statePath(dir))}`;
}
