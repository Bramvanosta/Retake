/**
 * The Tools' installer: what a person's click (the Studio's set-up), `retake tools install` and the updater run
 * — never a job, never an MCP tool. One install at a time per home (state.ts `.lock`); a second one is told who holds it
 * (`busy`) and may follow its progress (`waitForTools`).
 *
 * Per Tool not ready, in install order (render browser, compositor, browser: renders and stills unblock first): its
 * archive from its source — the publisher's URL (download.ts), a folder of archives (`--from-archives`: the same path
 * minus the network) or, for a browser, Playwright's cache (`--from-playwright-cache`: a developer's copy, digested as
 * copied) — then its **sha256 checked on the whole file before anything is extracted** (a mismatch: the archive is
 * deleted, nothing extracted, `mismatch` with both digests and the URL), then extraction, the tree rules and the tree
 * digest, and the atomic rename (extract.ts). Free space is checked first (download + extracted + 10 %). Pause keeps
 * what arrived (`.partial`), cancel removes it; both are asked through `signal` (the holder's own process) or
 * `.control.json` (another process), read every PROGRESS_MS.
 */
import { createHash } from 'node:crypto';
import { constants, copyFileSync, createReadStream, existsSync, lstatSync, mkdirSync, readdirSync, rmSync, statfsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { megabytes } from '@retake/core/base';
import { toolState, toolsDir, treeDigest } from '@retake/core/io';
import type { ToolEntry, ToolId } from '@retake/core/io';
import { stampOf } from '../clock.js';
import type { Clock } from '../clock.js';
import type { EngineEnv } from '../env.js';
import { ArchiveRefused } from './archive.js';
import { DownloadOffline, DownloadRefused, DownloadStopped, downloadArchive, partFiles } from './download.js';
import type { RetryPolicy, ToolsFetch } from './download.js';
import { DITTO, TreeMismatch, extractArchive, freshTmp, placeTree, removeTree, sweepLeftovers, verifyTree } from './extract.js';
import { PROGRESS_MS, askHolder, ensureToolsDir, liveHolder, takeControl, takeToolsLock, toolsFiles, writeJsonFile } from './state.js';
import type { ToolsControl, ToolsInstaller, ToolsLockRecord, ToolsRunFile } from './state.js';
import { execFile } from 'node:child_process';

/** Where the archives come from. */
export type ToolsSource = { from: 'network' } | { from: 'archives'; dir: string } | { from: 'playwright-cache'; dir: string };

export interface InstallToolsOptions {
  env: EngineEnv;
  /** The Tools of this version (bundle.json's), in install order. */
  entries: readonly ToolEntry[];
  /** The app's version (the lock and `.state.json` say it). */
  version: string;
  by: ToolsInstaller;
  clock: Clock;
  source?: ToolsSource;
  /** Only these Tools (the updater's new ones); default all. */
  only?: readonly ToolId[];
  /** The download allow-list (core TOOL_HOSTS; tests hand theirs). */
  hosts?: readonly string[];
  fetch?: ToolsFetch;
  retry?: RetryPolicy;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Free bytes of the volume of a folder (default statfs). */
  freeBytes?: (dir: string) => number;
  /** A pause asked in this process (keeps what arrived). */
  signal?: AbortSignal;
  /** The run's state, as written to `.state.json` (at most every PROGRESS_MS, and at each step). */
  onProgress?: (run: ToolsRunFile) => void;
  log?: (line: string) => void;
  /** Tests: called after a Tool's tree is checked, before it is renamed into place (a crash there). */
  beforePlace?: (entry: ToolEntry) => void | Promise<void>;
  /** Tests: the extractor (default extract.ts extractArchive), to see it never runs before the sha256 is checked. */
  extract?: (entry: ToolEntry, archive: string, into: string) => Promise<void>;
}

export type InstallOutcome = 'ready' | 'paused' | 'cancelled' | 'busy' | 'offline' | 'mismatch' | 'failed';

export interface InstallResult {
  outcome: InstallOutcome;
  /** The Tools placed by this install. */
  installed: ToolId[];
  /** `busy`: who installs now. */
  holder?: ToolsLockRecord;
  /** Why it stopped (one sentence). */
  message?: string;
  run?: ToolsRunFile;
}

/** The sha256 of a file, streamed. */
export async function fileSha256(file: string): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(file)) h.update(chunk as Buffer);
  return h.digest('hex');
}

/** Free bytes of the volume holding `dir` (statfs). */
export function volumeFree(dir: string): number {
  const s = statfsSync(dir);
  return Number(s.bavail) * Number(s.bsize);
}

const mb = megabytes;

/** One install's running state: the run file, the stop asked, the progress writes. */
class Run {
  readonly file: ToolsRunFile;
  readonly stop = new AbortController();
  asked: ToolsControl | undefined;
  private lastWrite = -Infinity;
  private readonly samples: Array<[number, number]> = [];
  private readonly poll: NodeJS.Timeout;

  constructor(
    private readonly o: InstallToolsOptions,
    private readonly dir: string,
    todo: readonly ToolEntry[],
  ) {
    this.file = { v: 1, pid: process.pid, by: o.by, version: o.version, phase: 'downloading', at: stampOf(o.clock), tools: {} };
    for (const e of o.entries) this.file.tools[e.id] = { state: todo.includes(e) ? 'waiting' : 'ready', received: todo.includes(e) ? 0 : e.bytes, bytes: e.bytes };
    o.signal?.addEventListener('abort', () => this.ask('pause'), { once: true });
    this.poll = setInterval(() => {
      const c = takeControl(dir);
      if (c) this.ask(c);
    }, PROGRESS_MS);
    this.poll.unref();
  }

  ask(c: ToolsControl): void {
    if (this.asked !== 'cancel') this.asked = c;
    this.stop.abort();
  }

  step(id: ToolId, patch: Partial<ToolsRunFile['tools'][ToolId]>, force = true): void {
    this.file.tools[id] = { ...this.file.tools[id]!, ...patch };
    this.write(force);
  }

  write(force: boolean): void {
    const now = this.o.clock.monotonic();
    if (!force && now - this.lastWrite < PROGRESS_MS) return;
    this.lastWrite = now;
    const received = Object.values(this.file.tools).reduce((n, t) => n + (t.state === 'ready' ? 0 : t.received), 0);
    const left = Object.values(this.file.tools).reduce((n, t) => n + (t.state === 'ready' ? 0 : t.bytes - t.received), 0);
    this.samples.push([now, received]);
    while (this.samples.length > 2 && now - this.samples[0]![0] > 5_000) this.samples.shift();
    const [t0, r0] = this.samples[0]!;
    const rate = now - t0 > 500 ? ((received - r0) * 1000) / (now - t0) : undefined;
    if (rate !== undefined && rate > 0) {
      this.file.rate = Math.round(rate);
      this.file.eta_s = Math.round(left / rate);
    }
    this.file.at = stampOf(this.o.clock);
    writeJsonFile(toolsFiles(this.dir).state, this.file);
    this.o.onProgress?.(this.file);
  }

  /** Stop reading `.control.json` (the install ends). */
  close(): void {
    clearInterval(this.poll);
  }

  end(phase: ToolsRunFile['phase'], message?: string): void {
    this.close();
    this.file.phase = phase;
    delete this.file.rate;
    delete this.file.eta_s;
    if (message) this.file.message = message;
    this.write(true);
  }
}

/** The archive of `entry` in a folder of archives: `<dir>/<file name of its URL>`, or one folder below. */
function archiveIn(dir: string, entry: ToolEntry): string | undefined {
  const name = basename(new URL(entry.url).pathname);
  const direct = join(dir, name);
  if (existsSync(direct)) return direct;
  for (const sub of readdirSync(dir, { withFileTypes: true })) if (sub.isDirectory() && existsSync(join(dir, sub.name, name))) return join(dir, sub.name, name);
  return undefined;
}

function copyProgram(from: string, to: string): Promise<void> {
  return new Promise((ok, fail) => execFile(DITTO, [from, to], { env: { PATH: '/usr/bin:/bin' } }, (e, _o, err) => (e ? fail(new Error(`ditto failed: ${String(err || e.message).trim()}`)) : ok())));
}

/** The archive of a Tool on disk, in `.partial` (downloaded, or copied from a folder of archives). */
async function acquire(o: InstallToolsOptions, run: Run, entry: ToolEntry, partial: string): Promise<string> {
  const source = o.source ?? { from: 'network' };
  mkdirSync(partial, { recursive: true, mode: 0o700 });
  if (source.from === 'archives') {
    const found = archiveIn(source.dir, entry);
    if (!found) throw new ArchiveRefused(`${source.dir} holds no ${basename(new URL(entry.url).pathname)} (${entry.label})`);
    if (lstatSync(found).size !== entry.bytes) throw new DownloadRefused(`${found} is ${lstatSync(found).size} bytes, not the ${entry.bytes} this version records`);
    const { part } = partFiles(entry, partial);
    // A copy (a clone on APFS) is what is hashed and extracted: the folder's file may change after the check.
    copyFileSync(found, part, constants.COPYFILE_FICLONE);
    run.step(entry.id, { state: 'downloading', received: entry.bytes });
    return part;
  }
  if (!o.fetch) throw new DownloadRefused('no download was asked for (this install has no fetch)');
  run.step(entry.id, { state: 'downloading' });
  return downloadArchive({
    entry,
    partial,
    fetch: o.fetch,
    ...(o.hosts ? { hosts: o.hosts } : {}),
    signal: run.stop.signal,
    ...(o.retry ? { retry: o.retry } : {}),
    ...(o.sleep ? { sleep: o.sleep } : {}),
    clock: o.clock,
    onBytes: (received) => run.step(entry.id, { received }, false),
    ...(o.log ? { log: o.log } : {}),
  });
}

/** Build a Tool's checked tree in a fresh `.tmp-*` from its source, then place it. */
async function build(o: InstallToolsOptions, run: Run, entry: ToolEntry, dir: string): Promise<void> {
  const tmp = freshTmp(dir);
  const built = join(tmp, entry.folder.split('/').pop()!);
  try {
    run.step(entry.id, { state: 'extracting' });
    if (o.source?.from === 'playwright-cache') {
      if (entry.id === 'compositor') throw new ArchiveRefused("Playwright's cache holds no compositor: download it (retake tools install) or install it from its archive (--from-archives <dir>)");
      const from = join(o.source.dir, entry.folder.split('/').pop()!);
      if (!existsSync(from)) throw new ArchiveRefused(`Playwright's cache holds no ${basename(from)} (${from})`);
      await copyProgram(from, built);
    } else {
      const { part, meta } = partFiles(entry, toolsFiles(dir).partial);
      run.step(entry.id, { state: 'checking' });
      const got = await fileSha256(part);
      if (got !== entry.sha256) {
        rmSync(part, { force: true });
        rmSync(meta, { force: true });
        throw new ArchiveMismatch(entry, got);
      }
      run.step(entry.id, { state: 'extracting' });
      await (o.extract ?? extractArchive)(entry, part, built);
    }
    await verifyTree(entry, built, o.clock);
    await o.beforePlace?.(entry);
    placeTree(entry, dir, built);
    if (o.source?.from !== 'playwright-cache') removeOwnPartials(dir, [entry]);
  } finally {
    removeTree(tmp);
  }
}

/**
 * Remove the partial downloads of `entries` only (their `.part` and its record), then `.partial` itself once it is
 * empty: another version's paused download (an update's, or this version's while an update installs) stays.
 */
function removeOwnPartials(dir: string, entries: readonly ToolEntry[]): void {
  const partial = toolsFiles(dir).partial;
  for (const e of entries) for (const f of Object.values(partFiles(e, partial))) rmSync(f, { force: true });
  try {
    if (readdirSync(partial).length === 0) rmSync(partial, { recursive: true, force: true });
  } catch {
    /* no partial downloads */
  }
}

/** The archive is not the one this version records (its sha256): deleted, nothing extracted. */
export class ArchiveMismatch extends Error {
  constructor(
    readonly entry: ToolEntry,
    readonly got: string,
  ) {
    super(`the ${entry.label.toLowerCase()}'s archive is not the one this version records (sha256 ${got}, recorded ${entry.sha256}, from ${entry.url}): it was deleted and nothing was extracted`);
    this.name = 'ArchiveMismatch';
  }
}

/** The Tools of `entries` that need an install: every one not ready, or whose folder's full digest is not the manifest's. */
async function toDo(o: InstallToolsOptions, dir: string): Promise<ToolEntry[]> {
  const out: ToolEntry[] = [];
  for (const e of o.entries) {
    if (o.only && !o.only.includes(e.id)) continue;
    const s = toolState(e, dir);
    // A stamp is a cache, not a proof: a ready folder is digested again before it is kept.
    if (s.state === 'ready' && (await treeDigest(s.path, e.markers ?? [])) === e.tree) continue;
    out.push(e);
  }
  return out;
}

/** Refuse an install the volume has no room for (download + extracted + 10 %, less what arrived). */
function spaceProblem(o: InstallToolsOptions, dir: string, todo: readonly ToolEntry[]): string | undefined {
  const partial = toolsFiles(dir).partial;
  const arrived = (e: ToolEntry) => {
    try {
      return lstatSync(partFiles(e, partial).part).size;
    } catch {
      return 0;
    }
  };
  const need = Math.ceil(todo.reduce((n, e) => n + (o.source?.from === 'playwright-cache' ? 0 : e.bytes - arrived(e)) + e.disk, 0) * 1.1);
  const free = (o.freeBytes ?? volumeFree)(dir);
  return free < need ? `not enough free space for the Tools in ${dir}: they need ${mb(need)} (download and extracted, +10 %), ${mb(free)} are free` : undefined;
}

/** What an install's error says, and the run's phase for it. */
function stopped(run: Run, entry: ToolEntry, e: unknown): { outcome: InstallOutcome; message?: string } {
  if (e instanceof DownloadStopped || run.asked) {
    const cancel = run.asked === 'cancel';
    run.step(entry.id, { state: cancel ? 'waiting' : 'paused' });
    return { outcome: cancel ? 'cancelled' : 'paused' };
  }
  if (e instanceof ArchiveMismatch) {
    run.step(entry.id, { state: 'mismatch', mismatch: 'archive', expected: entry.sha256, got: e.got, url: entry.url, received: 0 });
    return { outcome: 'mismatch', message: e.message };
  }
  const message = e instanceof Error ? e.message : String(e);
  if (e instanceof DownloadOffline) {
    run.step(entry.id, { state: 'offline', received: e.received, error: message });
    return { outcome: 'offline', message: `the connection was lost — what arrived is kept (${message}); Node.js downloads use no proxy` };
  }
  if (e instanceof TreeMismatch) run.step(entry.id, { state: 'mismatch', mismatch: 'tree', expected: e.expected, got: e.got, url: entry.url, error: message });
  else run.step(entry.id, { state: 'failed', error: message });
  return { outcome: e instanceof TreeMismatch ? 'mismatch' : 'failed', message };
}

/**
 * Install the Tools not ready (see the module comment). Never throws for what a person can act on: the outcome says
 * it (busy, paused, cancelled, offline, mismatch, failed — with one sentence), and `.state.json` keeps it for every reader.
 */
export async function installTools(o: InstallToolsOptions): Promise<InstallResult> {
  const dir = toolsDir(o.env as NodeJS.ProcessEnv);
  ensureToolsDir(dir);
  const lock = await takeToolsLock(dir, o.by, o.version, o.clock);
  if ('holder' in lock) return { outcome: 'busy', installed: [], holder: lock.holder };
  const installed: ToolId[] = [];
  let run: Run | undefined;
  try {
    sweepLeftovers(dir);
    takeControl(dir);
    const todo = await toDo(o, dir);
    run = new Run(o, dir, todo);
    const space = todo.length ? spaceProblem(o, dir, todo) : undefined;
    if (space) {
      run.end('failed', space);
      return { outcome: 'failed', installed, message: space, run: run.file };
    }
    for (const entry of todo) {
      try {
        if (run.asked) throw new DownloadStopped(0);
        if (o.source?.from !== 'playwright-cache') await acquire(o, run, entry, toolsFiles(dir).partial);
        if (run.asked) throw new DownloadStopped(0);
        await build(o, run, entry, dir);
        installed.push(entry.id);
        run.step(entry.id, { state: 'ready', received: entry.bytes });
      } catch (e) {
        const r = stopped(run, entry, e);
        if (r.outcome === 'cancelled') removeOwnPartials(dir, todo);
        run.end(r.outcome === 'paused' ? 'paused' : r.outcome === 'cancelled' ? 'cancelled' : r.outcome === 'offline' ? 'offline' : r.outcome === 'mismatch' ? 'mismatch' : 'failed', r.message);
        return { outcome: r.outcome, installed, ...(r.message ? { message: r.message } : {}), run: run.file };
      }
    }
    removeOwnPartials(dir, todo);
    run.end('done');
    return { outcome: 'ready', installed, run: run.file };
  } finally {
    run?.close();
    lock.release();
  }
}

/**
 * Pause or cancel the install under way: the live holder is asked (`.control.json`). With none, a pause has nothing to
 * do (a stopped install is paused already) and a cancel clears what a stopped one left (`.partial` and `.state.json`)
 * under the lock — so it never removes the file an install that started meanwhile writes; that one is asked instead.
 */
export async function controlTools(env: EngineEnv, action: ToolsControl, clock: Pick<Clock, 'now'>, version: string): Promise<void> {
  const dir = toolsDir(env as NodeJS.ProcessEnv);
  if (action === 'pause') {
    if (liveHolder(dir)) askHolder(dir, action, clock);
    return;
  }
  const lock = await takeToolsLock(dir, 'cli', version, clock, 'tools cancel');
  if ('holder' in lock) {
    askHolder(dir, action, clock);
    return;
  }
  try {
    rmSync(toolsFiles(dir).partial, { recursive: true, force: true });
    rmSync(toolsFiles(dir).state, { force: true });
  } finally {
    lock.release();
  }
}
