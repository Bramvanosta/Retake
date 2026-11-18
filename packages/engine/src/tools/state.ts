/**
 * What every process of this home knows of the Tools: who installs them now (`.lock`), how far it got
 * (`.state.json`, written by the holder at most every PROGRESS_MS), what another process asks of it (`.control.json`:
 * pause or cancel, read by the holder), and the status every reader shows — the Studio, `retake tools`, doctor,
 * engine_info — from those files and the cheap state of the installed folders (core toolsState). A CLI download shows in
 * the Studio and the reverse; a holder that died reads as paused (what arrived is kept).
 *
 * The lock is core's (createExclusive / breakStale / lockAlive: a pid whose start time is not the holder's is not the
 * holder), so two installers never both hold it.
 */
import { chmodSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TOOLS_FILES, breakStale, createExclusive, lockAlive, readLock, toolFolder, toolsDir, toolsState } from '@retake/core/io';
import type { LockRecord, ToolEntry, ToolId, ToolReadiness } from '@retake/core/io';
import { stampOf } from '../clock.js';
import type { Clock } from '../clock.js';
import type { EngineEnv } from '../env.js';
import { processStart } from '../jobs/proc.js';

/** How often the holder writes `.state.json` at most (ms). */
export const PROGRESS_MS = 250;

/** Who installs: the Studio's server, `retake tools install`, the updater (an update's own Tools). */
export type ToolsInstaller = 'studio' | 'cli' | 'update';

/** One Tool's step in a running (or the last) install. */
export type ToolStep = 'waiting' | 'downloading' | 'checking' | 'extracting' | 'ready' | 'paused' | 'offline' | 'mismatch' | 'failed';

export interface ToolRunState {
  state: ToolStep;
  received: number;
  bytes: number;
  /** A mismatch: the digest recorded, the one received, the URL (the manifest's text). */
  expected?: string;
  got?: string;
  url?: string;
  /** What did not match: the archive's sha256 (nothing extracted), or the extracted tree's digest (discarded). */
  mismatch?: 'archive' | 'tree';
  /** Why it failed (one line; a system's message: shown as text). */
  error?: string;
}

/** The outcome of a whole install, as `.state.json` keeps it. */
export type ToolsPhase = 'downloading' | 'paused' | 'offline' | 'mismatch' | 'failed' | 'cancelled' | 'done';

/** `.state.json`. */
export interface ToolsRunFile {
  v: 1;
  pid: number;
  by: ToolsInstaller;
  version: string;
  phase: ToolsPhase;
  at: string;
  tools: Partial<Record<ToolId, ToolRunState>>;
  /** Bytes per second over the last seconds, and the seconds left at that rate (while downloading). */
  rate?: number;
  eta_s?: number;
  /** Why the install stopped (offline, failed: one sentence). */
  message?: string;
}

/** What a holder of `.lock` does: an install (the default), or a short step that never downloads. */
export type ToolsLockCommand = 'tools install' | 'tools check' | 'tools prune' | 'tools cancel';

/** The holder of `.lock`. */
export interface ToolsLockRecord extends LockRecord {
  by: ToolsInstaller;
  version: string;
}

/** Does the holder install (download)? A check, a prune or a cancel holds the lock too, but downloads nothing. */
export function installs(h: ToolsLockRecord | null): h is ToolsLockRecord {
  return h !== null && (h.command === undefined || h.command === 'tools install');
}

/** The Tools folder's own files. */
export function toolsFiles(dir: string) {
  return {
    lock: join(dir, TOOLS_FILES.lock),
    state: join(dir, TOOLS_FILES.state),
    partial: join(dir, TOOLS_FILES.partial),
    control: join(dir, TOOLS_FILES.control),
    started: join(dir, TOOLS_FILES.started),
    pending: join(dir, TOOLS_FILES.pending),
    inUse: join(dir, TOOLS_FILES.inUse),
  };
}

/**
 * The Tools folder made (0700, the browsers folder in it too). Either one of this user's that others may write loses
 * that write (core ownerProblem reads such a folder's Tools as damaged: an install repairs it here).
 */
export function ensureToolsDir(dir: string): void {
  mkdirSync(join(dir, 'browsers'), { recursive: true, mode: 0o700 });
  const uid = process.getuid?.();
  for (const d of [dir, join(dir, 'browsers')]) {
    const st = lstatSync(d);
    if (st.isDirectory() && (uid === undefined || st.uid === uid) && st.mode & 0o022) chmodSync(d, st.mode & 0o755);
  }
}

/** Write a JSON file whole (a reader sees the old one or the new one). */
export function writeJsonFile(file: string, value: unknown): void {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value)}\n`);
  renameSync(tmp, file);
}

export function readJsonFile<T>(file: string): T | undefined {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

/** The live holder of the Tools folder's lock, or null (none, or one whose process is gone). */
export function liveHolder(dir: string): ToolsLockRecord | null {
  const held = readLock(toolsFiles(dir).lock) as ToolsLockRecord | null;
  return held && lockAlive(held) ? held : null;
}

/** Take the Tools folder's lock: the lock, or the live holder (a stale one is broken, under core's breaker). */
export async function takeToolsLock(
  dir: string,
  by: ToolsInstaller,
  version: string,
  clock: Pick<Clock, 'now'>,
  command: ToolsLockCommand = 'tools install',
): Promise<{ release(): void } | { holder: ToolsLockRecord }> {
  ensureToolsDir(dir);
  const file = toolsFiles(dir).lock;
  const start = await processStart(process.pid);
  const record: ToolsLockRecord = { pid: process.pid, ...(start !== null ? { started_at: new Date(start).toISOString() } : {}), command, by, version, since: stampOf(clock) };
  const text = JSON.stringify(record);
  for (let tries = 0; tries < 50; tries++) {
    if (createExclusive(file, text)) {
      return {
        release: () => {
          const now = readLock(file);
          if (now?.pid === process.pid && now.since === record.since) rmSync(file, { force: true });
        },
      };
    }
    let seen: string;
    try {
      seen = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const held = readLock(file) as ToolsLockRecord | null;
    if (held && lockAlive(held)) return { holder: held };
    breakStale(file, seen);
  }
  const held = liveHolder(dir);
  if (held) return { holder: held };
  throw new Error(`the Tools' lock (${file}) keeps changing: another install is starting — try again`);
}

/** What another process asks of the holder: pause (keep what arrived) or cancel (remove it). */
export type ToolsControl = 'pause' | 'cancel';

/** Ask the holder to pause or cancel (it reads `.control.json` while it runs). */
export function askHolder(dir: string, action: ToolsControl, clock: Pick<Clock, 'now'>): void {
  ensureToolsDir(dir);
  writeJsonFile(toolsFiles(dir).control, { action, at: stampOf(clock) });
}

/** What was asked of the holder since it started, then forgotten (read once). */
export function takeControl(dir: string): ToolsControl | undefined {
  const file = toolsFiles(dir).control;
  const c = readJsonFile<{ action?: unknown }>(file);
  if (!c) return undefined;
  rmSync(file, { force: true });
  return c.action === 'pause' || c.action === 'cancel' ? c.action : undefined;
}

// ── The status every reader shows ────────────────────────────────────────────────

/** The overall state the Studio and the CLI show. */
export type ToolsOverall = 'checkout' | 'needed' | 'downloading' | 'paused' | 'offline' | 'mismatch' | 'failed' | 'damaged' | 'ready';

export interface ToolStatus {
  id: ToolId;
  label: string;
  name: string;
  version: string;
  publisher: string;
  licence: string;
  url: string;
  bytes: number;
  disk: number;
  folder: string;
  /** Installed state (the cheap check), or the running install's step when it is not ready. */
  state: ToolReadiness | ToolStep;
  received: number;
  problem?: string;
  expected?: string;
  got?: string;
  /** A mismatch: of the archive (its sha256) or of the extracted tree (its tree digest). */
  mismatch?: 'archive' | 'tree';
}

export interface ToolsStatus {
  /** False in a checkout (no Tools: Playwright's cache and node_modules). */
  available: boolean;
  state: ToolsOverall;
  /** `<RETAKE_HOME>/tools`, and whether $RETAKE_HOME chose the home. */
  folder: string;
  home_from_env: boolean;
  /** Download bytes of the Tools not ready (what the button says), what arrived of them, and the seconds left. */
  total_bytes: number;
  received_bytes: number;
  eta_s?: number;
  /** Who downloads now (a live holder). */
  by?: { by: ToolsInstaller; pid: number; version: string };
  /** Why the last install stopped (offline, failed). */
  message?: string;
  tools: ToolStatus[];
  /** Folders of the Tools folder this version does not name (prune.ts decides which may go). */
  older: { folders: string[]; bytes: number };
}

/** The tool folders under `dir` (browsers/<x>, compositor-<v>, any other top-level folder but the dot ones). */
export function toolFolders(dir: string): string[] {
  const out: string[] = [];
  const list = (d: string) => {
    try {
      return readdirSync(d, { withFileTypes: true });
    } catch {
      return [];
    }
  };
  for (const e of list(dir)) {
    if (e.name.startsWith('.') || !e.isDirectory()) continue;
    if (e.name === 'browsers') for (const b of list(join(dir, 'browsers'))) if (b.isDirectory() && !b.name.startsWith('.')) out.push(`browsers/${b.name}`);
    if (e.name !== 'browsers') out.push(e.name);
  }
  return out.sort();
}

/** Bytes of a folder (lstat sizes, links not followed; 0 when it cannot be read). */
export function folderBytes(p: string): number {
  let total = 0;
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const c = join(d, e.name);
      if (e.isDirectory()) walk(c);
      else total += statSync(c, { throwIfNoEntry: false })?.size ?? 0;
    }
  };
  try {
    walk(p);
  } catch {
    /* as far as it could be read */
  }
  return total;
}

/** The bytes of each older folder, by its path, while its inode and mtime are the ones measured (a status per poll). */
const olderBytes = new Map<string, { key: string; bytes: number }>();

/**
 * Bytes of an older Tools folder, walked again only when the folder itself changed (an installed tree is read-only:
 * what is under it does not change while it stays; a prune or an install replaces the folder, its inode with it).
 */
function olderFolderBytes(p: string): number {
  let key: string;
  try {
    const st = lstatSync(p);
    key = `${st.ino}:${st.mtimeMs}`;
  } catch {
    olderBytes.delete(p);
    return 0;
  }
  const hit = olderBytes.get(p);
  if (hit?.key === key) return hit.bytes;
  const bytes = folderBytes(p);
  olderBytes.set(p, { key, bytes });
  return bytes;
}

function overall(tools: readonly ToolStatus[], run: ToolsRunFile | undefined, live: boolean): ToolsOverall {
  if (tools.every((t) => t.state === 'ready')) return 'ready';
  if (live) return 'downloading';
  if (run && run.phase !== 'done' && run.phase !== 'cancelled') return run.phase === 'downloading' ? 'paused' : run.phase;
  if (tools.some((t) => t.state === 'damaged')) return 'damaged';
  return 'needed';
}

/** The Tools' status for `entries` (the app's) under `env`'s home; `available: false` in a checkout (`entries` null). */
export function toolsStatus(env: EngineEnv, entries: readonly ToolEntry[] | null): ToolsStatus {
  const folder = toolsDir(env as NodeJS.ProcessEnv);
  const home_from_env = !!env.RETAKE_HOME?.trim();
  if (!entries) return { available: false, state: 'checkout', folder, home_from_env, total_bytes: 0, received_bytes: 0, tools: [], older: { folders: [], bytes: 0 } };
  // A check, a prune or a cancel holds the lock but downloads nothing: only an install's holder downloads.
  const held = liveHolder(folder);
  const holder = installs(held) ? held : null;
  const run = readJsonFile<ToolsRunFile>(toolsFiles(folder).state);
  const installed = toolsState(entries, folder);
  const tools: ToolStatus[] = entries.map((e, i) => {
    const s = installed[i]!;
    const step = s.state === 'ready' ? undefined : run?.tools[e.id];
    // The installed state, unless a running (or the last) install says more of a Tool not ready; a step of a holder
    // that died reads as paused (what arrived is kept).
    let shown: ToolStatus['state'] = s.state;
    if (step && step.state !== 'ready' && step.state !== 'waiting')
      shown = !holder && (step.state === 'downloading' || step.state === 'checking' || step.state === 'extracting') ? 'paused' : step.state;
    else if (step?.state === 'waiting' && holder) shown = 'waiting';
    return {
      id: e.id,
      label: e.label,
      name: e.name,
      version: e.version,
      publisher: e.publisher,
      licence: e.licence,
      url: e.url,
      bytes: e.bytes,
      disk: e.disk,
      folder: toolFolder(e, folder),
      state: shown,
      received: s.state === 'ready' ? e.bytes : (step?.received ?? 0),
      ...(s.problem ? { problem: s.problem } : step?.error ? { problem: step.error } : {}),
      ...(step?.expected ? { expected: step.expected, got: step.got, ...(step.mismatch ? { mismatch: step.mismatch } : {}) } : {}),
    };
  });
  const open = tools.filter((t) => t.state !== 'ready');
  const named = new Set(entries.map((e) => e.folder));
  const older = toolFolders(folder).filter((f) => !named.has(f));
  return {
    available: true,
    state: overall(tools, run, holder !== null),
    folder,
    home_from_env,
    total_bytes: open.reduce((n, t) => n + t.bytes, 0),
    received_bytes: open.reduce((n, t) => n + t.received, 0),
    ...(holder && run?.eta_s !== undefined ? { eta_s: run.eta_s } : {}),
    ...(holder ? { by: { by: holder.by, pid: holder.pid, version: holder.version } } : {}),
    ...(run?.message && !holder && run.phase !== 'done' ? { message: run.message } : {}),
    tools,
    older: { folders: older, bytes: older.reduce((n, f) => n + olderFolderBytes(join(folder, ...f.split('/'))), 0) },
  };
}
