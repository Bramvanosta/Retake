/**
 * Older Tools removed (the decisions' "Prune" rule): a folder of the Tools folder goes only when nothing that
 * may still need it names it —
 * - the running version's Tools (its bundle.json);
 * - the Tools named by each Retake that recorded a successful start in `.started.json` within KEEP_DAYS (read from its
 *   own bundle.json when it is still there, else from its record): two copies of the app on one home never prune each
 *   other's current Tools;
 * - the Tools an update downloaded before its restart (`.pending.json`, written by the updater, removed once the new
 *   version started or the update was abandoned) — for KEEP_DAYS at most: an update that never started (the app was
 *   quit during it, the swap failed, a later version came first) keeps nothing for good;
 * - the Tools a live process of another copy uses (`.in-use/<pid>.json`, written by the jobs worker of an app).
 * `force` keeps the running version's and those of the update under way (`keepPending`: the Studio's) only; the
 * pending records it no longer honours, and the expired ones, are removed from `.pending.json`. A removal is a rename to `.trash-<rand>` first (a
 * running browser keeps its open files), under the install lock (never beside an install).
 *
 * `recordStarted` is what the Studio calls once every Tool of its version is ready ("after the new version's first
 * successful start"), then `pruneTools`.
 */
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import { lockAlive, toolsDir } from '@retake/core/io';
import type { LockRecord, ToolEntry } from '@retake/core/io';
import type { Clock } from '../clock.js';
import type { EngineEnv } from '../env.js';
import { processStart } from '../jobs/proc.js';
import { removeTree } from './extract.js';
import { folderBytes, readJsonFile, takeToolsLock, toolFolders, toolsFiles, writeJsonFile } from './state.js';
import type { ToolsLockRecord } from './state.js';
import { partFiles } from './download.js';

/** How long a recorded start keeps its Tools (days). */
export const KEEP_DAYS = 30;
const DAY_MS = 86_400_000;
const STARTED_MAX = 20;

/** A start recorded in `.started.json`: which copy (its folder), which version, its Tools' folders, when. */
export interface StartedRecord {
  app: string;
  location: string;
  folders: string[];
  at: string;
}

/** A pre-downloaded update's Tools (`.pending.json`). */
export interface PendingRecord {
  app: string;
  folders: string[];
  at: string;
}

const FOLDER_RE = /^(?:browsers\/)?[a-z0-9][a-z0-9_.-]{0,63}$/;
const folderList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((f): f is string => typeof f === 'string' && FOLDER_RE.test(f)) : []);

function readList<T>(file: string): T[] {
  const v = readJsonFile<unknown>(file);
  return Array.isArray(v) ? (v as T[]) : [];
}

/** Record that `app` (at `location`) started with every Tool of `entries` ready. */
export function recordStarted(env: EngineEnv, o: { app: string; location: string; entries: readonly ToolEntry[]; clock: Pick<Clock, 'now'> }): void {
  const dir = toolsDir(env as NodeJS.ProcessEnv);
  if (!existsSync(dir)) return;
  const file = toolsFiles(dir).started;
  const at = new Date(o.clock.now()).toISOString();
  const rest = readList<StartedRecord>(file).filter((r) => !(r.location === o.location && r.app === o.app));
  writeJsonFile(file, [...rest, { app: o.app, location: o.location, folders: o.entries.map((e) => e.folder), at }].slice(-STARTED_MAX));
}

/** Keep an update's Tools (`folders`) until the new version starts (`removePending`) or the update is abandoned. */
export function addPending(env: EngineEnv, o: { app: string; folders: readonly string[]; clock: Pick<Clock, 'now'> }): void {
  const dir = toolsDir(env as NodeJS.ProcessEnv);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = toolsFiles(dir).pending;
  const rest = readList<PendingRecord>(file).filter((r) => r.app !== o.app);
  writeJsonFile(file, [...rest, { app: o.app, folders: [...o.folders], at: new Date(o.clock.now()).toISOString() }]);
}

/** Forget an update's pending Tools (it started, or it was abandoned). */
export function removePending(env: EngineEnv, app: string): void {
  const file = toolsFiles(toolsDir(env as NodeJS.ProcessEnv)).pending;
  if (!existsSync(file)) return;
  writeJsonFile(
    file,
    readList<PendingRecord>(file).filter((r) => r.app !== app),
  );
}

/**
 * Record that this process (a jobs worker of an app at `location`) uses `folders` until it exits: prune keeps them
 * while it lives. Returns the release (also run at exit).
 */
export async function registerInUse(env: EngineEnv, o: { location: string; folders: readonly string[]; clock: Pick<Clock, 'now'> }): Promise<() => void> {
  const dir = join(toolsFiles(toolsDir(env as NodeJS.ProcessEnv)).inUse);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `${process.pid}.json`);
  const start = await processStart(process.pid);
  writeJsonFile(file, {
    pid: process.pid,
    ...(start !== null ? { started_at: new Date(start).toISOString() } : {}),
    command: 'worker',
    since: new Date(o.clock.now()).toISOString(),
    engine: o.location,
    folders: [...o.folders],
  });
  const release = () => rmSync(file, { force: true });
  process.once('exit', release);
  return () => {
    process.off('exit', release);
    release();
  };
}

/** The bundle.json of a recorded copy of Retake (its `.app` or its stage folder), or undefined. */
function foldersOfCopy(location: string): string[] | undefined {
  const file = location.endsWith('.app') ? join(location, 'Contents', 'Resources', 'bundle.json') : join(location, 'bundle.json');
  try {
    const m = JSON.parse(readFileSync(file, 'utf8')) as { tools?: Array<{ folder?: unknown }> };
    return Array.isArray(m.tools) ? folderList(m.tools.map((t) => t?.folder)) : undefined;
  } catch {
    return undefined;
  }
}

/** The pending records still honoured: within KEEP_DAYS, and under `force` the update under way's (`keepPending`) only. */
function livePending(list: readonly PendingRecord[], o: { now: number; force?: boolean; keepPending?: string }): PendingRecord[] {
  return list.filter((p) => {
    const at = Date.parse(String(p?.at));
    if (!Number.isFinite(at) || o.now - at > KEEP_DAYS * DAY_MS) return false;
    return !o.force || (o.keepPending !== undefined && p.app === o.keepPending);
  });
}

/** Why each folder is kept: the running version, a recent start, a pending update, a live process. */
export function keptFolders(env: EngineEnv, entries: readonly ToolEntry[], o: { now: number; force?: boolean; keepPending?: string }): Map<string, string> {
  const dir = toolsDir(env as NodeJS.ProcessEnv);
  const files = toolsFiles(dir);
  const kept = new Map<string, string>();
  const keep = (folders: readonly string[], why: string) => {
    for (const f of folders) if (!kept.has(f)) kept.set(f, why);
  };
  keep(
    entries.map((e) => e.folder),
    'this version',
  );
  for (const p of livePending(readList<PendingRecord>(files.pending), o)) keep(folderList(p.folders), `an update to ${String(p.app).slice(0, 40)} downloaded them`);
  if (o.force) return kept;
  for (const r of readList<StartedRecord>(files.started)) {
    const at = Date.parse(r.at);
    if (!Number.isFinite(at) || o.now - at > KEEP_DAYS * DAY_MS) continue;
    keep(foldersOfCopy(String(r.location)) ?? folderList(r.folders), `Retake ${String(r.app).slice(0, 40)} started with them within ${KEEP_DAYS} days`);
  }
  let users: string[] = [];
  try {
    users = readdirSync(files.inUse);
  } catch {
    users = [];
  }
  for (const name of users) {
    const rec = readJsonFile<LockRecord & { folders?: unknown }>(join(files.inUse, name));
    if (rec && typeof rec.pid === 'number' && lockAlive(rec)) keep(folderList(rec.folders), `a running process (pid ${rec.pid}) uses them`);
    else rmSync(join(files.inUse, name), { force: true });
  }
  return kept;
}

export interface ToolsPruneResult {
  /** `busy`: an install holds the Tools folder now (nothing removed). */
  busy?: ToolsLockRecord;
  removed: Array<{ folder: string; bytes: number }>;
  kept: Array<{ folder: string; why: string }>;
}

/** Remove the Tools folders nothing keeps (see the module comment), and the partial downloads of other versions. */
export async function pruneTools(env: EngineEnv, o: { entries: readonly ToolEntry[]; version: string; clock: Clock; force?: boolean; keepPending?: string }): Promise<ToolsPruneResult> {
  const dir = toolsDir(env as NodeJS.ProcessEnv);
  if (!existsSync(dir)) return { removed: [], kept: [] };
  const lock = await takeToolsLock(dir, 'cli', o.version, o.clock, 'tools prune');
  if ('holder' in lock) return { busy: lock.holder, removed: [], kept: [] };
  try {
    const at = { now: o.clock.now(), ...(o.force ? { force: true } : {}), ...(o.keepPending !== undefined ? { keepPending: o.keepPending } : {}) };
    const pending = readList<PendingRecord>(toolsFiles(dir).pending);
    const honoured = livePending(pending, at);
    if (honoured.length !== pending.length) writeJsonFile(toolsFiles(dir).pending, honoured);
    const kept = keptFolders(env, o.entries, at);
    const removed: ToolsPruneResult['removed'] = [];
    const keptOut: ToolsPruneResult['kept'] = [];
    for (const folder of toolFolders(dir)) {
      const why = kept.get(folder);
      if (why) {
        if (!o.entries.some((e) => e.folder === folder)) keptOut.push({ folder, why });
        continue;
      }
      const p = join(dir, ...folder.split('/'));
      const bytes = folderBytes(p);
      const trash = join(dir, `.trash-${randomBytes(6).toString('hex')}`);
      // A read-only folder moves to another parent only once it is writable (its `..` entry changes).
      chmodSync(p, 0o700);
      renameSync(p, trash);
      removeTree(trash);
      removed.push({ folder, bytes });
    }
    // Partial downloads of archives this version does not name (its own paused ones stay).
    const own = new Set(o.entries.flatMap((e) => Object.values(partFiles(e, toolsFiles(dir).partial)).map((f) => basename(f))));
    try {
      for (const f of readdirSync(toolsFiles(dir).partial)) if (!own.has(f)) rmSync(join(toolsFiles(dir).partial, f), { force: true });
    } catch {
      /* no partial downloads */
    }
    return { removed, kept: keptOut };
  } finally {
    lock.release();
  }
}
