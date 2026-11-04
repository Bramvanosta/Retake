/**
 * Captures first (L5.14, BL-116): the filming markers of this user on this Mac. A take writes one marker while it films
 * (from capture time 0 to the end of its scenes, not around its setup or teardown hooks, and not while it is paused);
 * every heavy job of every workspace — the jobs workers' and the `retake render` / `still` / `export` / `review` /
 * `export-capture` commands' — waits to start while one holds, and a running one yields (background priority, yield.ts).
 *
 * - Where: one folder per user, not per Retake home — the app on its home and a terminal with another RETAKE_HOME see
 *   the same takes: on macOS `<getconf DARWIN_USER_TEMP_DIR>/retake-captures` (the user's own 0700 temp folder, whatever
 *   TMPDIR says); elsewhere `<RETAKE_HOME>/captures` (BL-147). `RETAKE_CAPTURES_DIR` (absolute) replaces it — the test
 *   runner gives every test file its own. The folder must be a real directory of this user, 0700: anything else is not
 *   used (nothing holds: renders go on rather than wait on a folder another account could write). Under a test run
 *   (VITEST, or any RETAKE_TEST_* variable) the per-user folder is never used: only RETAKE_CAPTURES_DIR (review B M2).
 * - One file per take, `k_<26 Crockford base32>.json` (created whole: tmp + rename), so two takes never share one.
 *   Content: `{v, pid, started_at, ws, source, paused?}` — the owner process (the worker of a queued take, the `retake`
 *   process of a CLI take) and a random id of its workspace (`<ws>/.retake/capture-id`), so a reader tells "this
 *   workspace" from "elsewhere" without the marker naming one: never a path, slug, scenario, run or job id.
 * - Liveness (critique M1): the owner rewrites the file's time every BEAT_MS; a marker counts while its time is within
 *   STALE_MS of now — either way: a time in the future is no fresher (review A L2) — AND its pid runs with the recorded
 *   start time (a marker without one counts only where ps cannot read that pid's start either). A take suspended with
 *   Ctrl-Z stops beating: stale within STALE_MS. A stale marker is removed by the reader that saw it. Read with core
 *   readPlainFile (no link followed, never blocking on a FIFO, at most MARKER_MAX_BYTES: review A L1).
 * - Cap: a marker's owner (its pid and start time, not the file's name) holds heavy work for at most
 *   RETAKE_CAPTURE_HOLD_MAX_MIN (default 60) of holding time counted by each reader from its first sight of it; neither a
 *   rewritten file, a renamed one, nor one removed as stale and written again restarts it while that owner runs (review
 *   A L2, B L4). A paused take does not count.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync, writeSync } from 'node:fs';
import { readdir, rm } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { readPlainFile, retakeHome, ulid } from '@retake/core';
import type { ProcessIdentity } from './proc.js';
import { processStart } from './proc.js';
import { stateDir } from './queue.js';

/** How often an owner rewrites its marker's time (ms). */
export const BEAT_MS = 2_000;
/** A marker whose time is older than this is stale (ms): five missed beats. */
export const STALE_MS = 10_000;
/** The default cap (min) of the time one marker holds heavy work. */
export const HOLD_MAX_MIN = 60;
/** The marker format this build writes; a reader counts any version ≥ 1 whose owner is alive (a newer copy's take). */
export const MARKER_VERSION = 1;
/** A marker is a few dozen bytes: a larger file is not one (never read whole). */
export const MARKER_MAX_BYTES = 4096;

export const MARKER_NAME_RE = /^k_[0-9A-HJKMNP-TV-Z]{26}\.json$/;
const WS_ID_RE = /^[0-9a-f]{32}$/;

export interface MarkerRecord {
  v: number;
  pid: number;
  started_at?: string;
  /** The random id of the take's workspace (capture-id), never its path. */
  ws: string;
  source: 'job' | 'cli';
  /** The take is paused (L4.4): it films nothing, so it holds nothing. */
  paused?: boolean;
}

let darwinTemp: string | null | undefined;
/** The user's own temp folder on macOS (getconf DARWIN_USER_TEMP_DIR: 0700, independent of TMPDIR), read once. */
function darwinUserTemp(): string | null {
  if (darwinTemp !== undefined) return darwinTemp;
  try {
    const out = execFileSync('/usr/bin/getconf', ['DARWIN_USER_TEMP_DIR'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim();
    darwinTemp = isAbsolute(out) ? out : null;
  } catch {
    darwinTemp = null;
  }
  return darwinTemp;
}

/**
 * Where the markers of this user live (before the folder's own checks), and whether RETAKE_CAPTURES_DIR named it;
 * `refused` under a test run without RETAKE_CAPTURES_DIR (review B M2: the per-user folder is then never made nor read).
 */
export function capturesLocation(env: NodeJS.ProcessEnv = process.env): { dir: string; override: boolean; problem?: string; refused?: boolean } {
  const named = env.RETAKE_CAPTURES_DIR?.trim();
  if (named && isAbsolute(named)) return { dir: named, override: true };
  const dir = defaultDir(env);
  const refused = underTest(env);
  const problem = named
    ? `RETAKE_CAPTURES_DIR "${named.slice(0, 80)}" is not an absolute path: ignored`
    : refused
      ? 'a test run never uses the per-user captures folder (RETAKE_CAPTURES_DIR is not set): captures first is off'
      : undefined;
  return { dir, override: false, ...(problem ? { problem } : {}), ...(refused ? { refused: true } : {}) };
}

/** A test run (vitest, or a RETAKE_TEST_* variable in this environment or the process's): never the per-user folder. */
function underTest(env: NodeJS.ProcessEnv): boolean {
  for (const e of [env, process.env]) if (e.VITEST || Object.keys(e).some((k) => k.startsWith('RETAKE_TEST_'))) return true;
  return false;
}

function defaultDir(env: NodeJS.ProcessEnv): string {
  const t = process.platform === 'darwin' ? darwinUserTemp() : null;
  return t ? join(t, 'retake-captures') : join(retakeHome(env), 'captures');
}

/**
 * The markers' folder, made 0700 when missing — or null with the reason when it cannot be trusted: not a directory, a
 * link, another user's, or open to the group / others (then nothing holds and nothing is written).
 */
export function capturesDir(env: NodeJS.ProcessEnv = process.env): { dir: string | null; problem?: string } {
  const loc = capturesLocation(env);
  if (loc.refused) return { dir: null, ...(loc.problem ? { problem: loc.problem } : {}) };
  try {
    mkdirSync(loc.dir, { recursive: true, mode: 0o700 });
    const st = lstatSync(loc.dir);
    const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
    if (!st.isDirectory() || st.isSymbolicLink()) return { dir: null, problem: `the captures folder ${loc.dir} is not a directory: captures first is off` };
    if (uid !== undefined && st.uid !== uid) return { dir: null, problem: `the captures folder ${loc.dir} belongs to another user: captures first is off` };
    if ((st.mode & 0o077) !== 0) return { dir: null, problem: `the captures folder ${loc.dir} is open to other users (mode ${(st.mode & 0o777).toString(8)}): captures first is off` };
  } catch (e) {
    return { dir: null, problem: `the captures folder ${loc.dir} cannot be used (${(e as Error).message}): captures first is off` };
  }
  return { dir: loc.dir, ...(loc.problem ? { problem: loc.problem } : {}) };
}

/** The random id of a workspace for the markers (`<ws>/.retake/capture-id`, made once, 0600). */
export function workspaceCaptureId(root: string): string {
  const file = join(stateDir(root), 'capture-id');
  try {
    const t = readFileSync(file, 'utf8').trim();
    if (WS_ID_RE.test(t)) return t;
  } catch {
    /* made below */
  }
  const id = randomBytes(16).toString('hex');
  try {
    mkdirSync(stateDir(root), { recursive: true });
    const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
    writeFileSync(tmp, `${id}\n`, { mode: 0o600 });
    renameSync(tmp, file);
    // Two processes making it at once: the one written last wins; read it back so both use the same.
    const back = readFileSync(file, 'utf8').trim();
    return WS_ID_RE.test(back) ? back : id;
  } catch {
    return id;
  }
}

function writeWhole(dir: string, name: string, rec: MarkerRecord): void {
  const tmp = join(dir, `.${name}.${randomBytes(4).toString('hex')}.tmp`);
  const fd = openSync(tmp, 'wx', 0o600);
  try {
    writeSync(fd, `${JSON.stringify(rec)}\n`);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, join(dir, name));
}

const open = new Set<FilmingMarker>();
let exitHook = false;
function onExitRemoveAll(): void {
  for (const m of open) m.closeSync();
}

/** The marker of one filming take, written by its owner process; `close()` removes it (also on process exit). */
export class FilmingMarker {
  private beat: NodeJS.Timeout | undefined;
  private closed = false;
  private rec: MarkerRecord;

  private constructor(
    readonly dir: string,
    readonly name: string,
    rec: MarkerRecord,
  ) {
    this.rec = rec;
  }

  /**
   * Write a marker for a take of the workspace `root` owned by `owner` (this process: selfIdentity), synchronously —
   * heavy work is held from this call on; null when the folder cannot be used.
   */
  static open(opts: { root: string; source: 'job' | 'cli'; owner: ProcessIdentity; env?: NodeJS.ProcessEnv; beatMs?: number }): FilmingMarker | null {
    const { dir } = capturesDir(opts.env);
    if (!dir) return null;
    const owner = opts.owner;
    const rec: MarkerRecord = { v: MARKER_VERSION, pid: owner.pid, ...(owner.started_at ? { started_at: owner.started_at } : {}), ws: workspaceCaptureId(opts.root), source: opts.source };
    const name = `k_${ulid()}.json`;
    try {
      writeWhole(dir, name, rec);
    } catch {
      return null;
    }
    const m = new FilmingMarker(dir, name, rec);
    open.add(m);
    if (!exitHook) {
      exitHook = true;
      process.on('exit', onExitRemoveAll);
    }
    m.beat = setInterval(() => m.touch(), opts.beatMs ?? BEAT_MS);
    m.beat.unref();
    return m;
  }

  get file(): string {
    return join(this.dir, this.name);
  }

  get paused(): boolean {
    return this.rec.paused === true;
  }

  /** The heartbeat: a fresh time; the file written again when a reader removed it as stale (a long stall). */
  touch(): void {
    if (this.closed) return;
    const t = new Date();
    try {
      utimesSync(this.file, t, t);
    } catch {
      try {
        writeWhole(this.dir, this.name, this.rec);
      } catch {
        /* the next beat tries again */
      }
    }
  }

  /** The take paused (it films nothing: heavy work goes on) or resumed (it holds again, at once). */
  setPaused(paused: boolean): void {
    if (this.closed || this.paused === paused) return;
    const { paused: _p, ...rest } = this.rec;
    this.rec = paused ? { ...rest, paused: true } : rest;
    try {
      writeWhole(this.dir, this.name, this.rec);
    } catch {
      /* the next beat writes it */
    }
  }

  closeSync(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.beat) clearInterval(this.beat);
    open.delete(this);
    try {
      rmSync(this.file, { force: true });
    } catch {
      /* a reader removes it once stale */
    }
  }

  async close(): Promise<void> {
    this.closeSync();
  }
}

/** A live marker as a reader sees it: whether it is of this workspace, how long it held, whether it reached the cap. */
export interface LiveTake {
  name: string;
  here: boolean;
  paused: boolean;
  held_ms: number;
  capped: boolean;
  source: 'job' | 'cli' | 'other';
}

/** What holds heavy work now (FilmingWatch.scan). */
export interface FilmingState {
  takes: LiveTake[];
  /** A live, unpaused take below its cap. */
  holding: boolean;
  /** Where the takes that hold film: this workspace's, or only elsewhere. */
  cause?: 'here' | 'elsewhere';
  /** Takes that reached the cap this scan (one warning each, by name). */
  newlyCapped: string[];
  problem?: string;
}

export interface FilmingWatchOptions {
  /** The workspace whose takes are "here" (none: every take is elsewhere). */
  root?: string;
  env?: NodeJS.ProcessEnv;
  /** Markers of these owner pids do not hold (a hook of the take itself: its own `retake render`). */
  ignorePids?: () => Promise<ReadonlySet<number>> | ReadonlySet<number>;
  now?: () => number;
  /** A marker older than this is stale (ms, default STALE_MS; tests). */
  staleMs?: number;
  /** Process checks (tests). */
  signalState?: (pid: number) => 'alive' | 'gone' | 'foreign';
  processStart?: (pid: number) => Promise<number | null>;
}

/** A marker's owner as one reader counts it (keyed by pid and start time, never by the file's name). */
interface Owner {
  heldMs: number;
  /** The reader's time of the last scan that found one of its markers. */
  lastSeen: number;
  /** The first scan since then that found none (its take may have ended). */
  absentSince?: number;
  capped: boolean;
}

const START_TOLERANCE_MS = 2000;

function capMs(env: NodeJS.ProcessEnv): number {
  const raw = env.RETAKE_CAPTURE_HOLD_MAX_MIN?.trim();
  const n = raw ? Number(raw) : HOLD_MAX_MIN;
  return (Number.isFinite(n) && n > 0 ? Math.min(n, 24 * 60) : HOLD_MAX_MIN) * 60_000;
}

/** A gap between two scans counts at most this much holding time (a suspended reader does not cap a take). */
const MAX_GAP_MS = 5_000;
/**
 * An owner without a marker for longer than this ended its take: its next marker starts a new count. Shorter (a file
 * renamed, or removed as stale and written again by the owner's next beat) the count goes on. Two takes of one worker
 * less than this apart count as one.
 */
export const CAP_CARRY_MS = STALE_MS;

/** A reader of the markers, with its own memory of what it saw (first sight, holding time, owners' start times). */
export class FilmingWatch {
  private readonly owners = new Map<string, Owner>();
  /** ps's start time of each marker's pid, read once per file name (null: ps gave none). */
  private readonly starts = new Map<string, number | null>();
  private wsId: string | undefined;

  constructor(private readonly o: FilmingWatchOptions = {}) {}

  private here(ws: string): boolean {
    if (!this.o.root) return false;
    this.wsId ??= workspaceCaptureId(this.o.root);
    return ws === this.wsId;
  }

  /** Owners not found this scan: absent from now; forgotten once absent past CAP_CARRY_MS. */
  private forget(present: ReadonlySet<string>, now: number): void {
    for (const [key, o] of this.owners) {
      if (present.has(key)) continue;
      o.absentSince ??= now;
      if (now - o.absentSince > CAP_CARRY_MS) this.owners.delete(key);
    }
  }

  async scan(): Promise<FilmingState> {
    const env = this.o.env ?? process.env;
    const now = (this.o.now ?? Date.now)();
    const { dir, problem } = capturesDir(env);
    const out: FilmingState = { takes: [], holding: false, newlyCapped: [], ...(problem ? { problem } : {}) };
    if (!dir) return out;
    let names: string[];
    try {
      names = (await readdir(dir)).filter((n) => MARKER_NAME_RE.test(n));
    } catch {
      return out;
    }
    for (const k of [...this.starts.keys()]) if (!names.includes(k)) this.starts.delete(k);
    if (!names.length) {
      this.forget(new Set(), now);
      return out;
    }
    const sig = this.o.signalState ?? (await import('@retake/sandbox')).signalState;
    const startOf = this.o.processStart ?? processStart;
    const ignore = this.o.ignorePids ? await this.o.ignorePids() : undefined;
    const cap = capMs(env);
    const staleMs = this.o.staleMs ?? STALE_MS;
    const live: Array<{ name: string; rec: MarkerRecord; key: string; paused: boolean; ignored: boolean }> = [];
    for (const name of names) {
      const file = join(dir, name);
      let mtime = NaN;
      // No link followed, never blocked by a FIFO, never a large file read whole (review A L1).
      const read = readPlainFile(file, MARKER_MAX_BYTES, { verify: (st) => ((mtime = st.mtimeMs), true) });
      if (!read.ok) continue; // removed meanwhile, or not a marker
      let rec: MarkerRecord;
      try {
        rec = JSON.parse(read.bytes.toString('utf8')) as MarkerRecord;
      } catch {
        continue;
      }
      if (!rec || typeof rec !== 'object' || !(typeof rec.v === 'number' && rec.v >= 1) || !Number.isInteger(rec.pid) || rec.pid <= 0) continue;
      // A time in the future is no fresher than one in the past (review A L2: a forged or skewed marker goes stale too).
      const stale = !(Math.abs(now - mtime) <= staleMs);
      let alive = !stale && sig(rec.pid) === 'alive';
      let start: number | null = null;
      if (alive) {
        if (!this.starts.has(name)) this.starts.set(name, await startOf(rec.pid));
        start = this.starts.get(name) ?? null;
        const recorded = typeof rec.started_at === 'string' ? Date.parse(rec.started_at) : NaN;
        if (Number.isFinite(recorded)) alive = start === null ? sig(rec.pid) === 'alive' : Math.abs(start - recorded) <= START_TOLERANCE_MS;
        else alive = start === null; // no start time recorded: counts only where ps cannot tell this pid's start either
      }
      if (!alive) {
        this.starts.delete(name);
        await rm(file, { force: true }).catch(() => undefined); // stale: whoever sees it removes it (unique names)
        continue;
      }
      const key = `${rec.pid}:${start ?? (typeof rec.started_at === 'string' ? rec.started_at.slice(0, 40) : '-')}`;
      live.push({ name, rec, key, paused: rec.paused === true, ignored: ignore?.has(rec.pid) === true });
    }
    // Holding time per owner, once per scan: one of its markers filming (not paused, not ignored) counts the gap.
    const present = new Set(live.map((l) => l.key));
    for (const key of present) {
      let o = this.owners.get(key);
      if (o && o.absentSince !== undefined && now - o.absentSince > CAP_CARRY_MS) o = undefined;
      if (!o) o = { heldMs: 0, lastSeen: now, capped: false };
      const filming = live.some((l) => l.key === key && !l.paused && !l.ignored);
      if (filming) o.heldMs += Math.min(Math.max(0, now - o.lastSeen), MAX_GAP_MS);
      o.lastSeen = now;
      delete o.absentSince;
      const capped = o.heldMs >= cap;
      if (capped && !o.capped) out.newlyCapped.push(...live.filter((l) => l.key === key).map((l) => l.name));
      o.capped = capped;
      this.owners.set(key, o);
    }
    this.forget(present, now);
    for (const l of live) {
      const o = this.owners.get(l.key)!;
      const take: LiveTake = { name: l.name, here: typeof l.rec.ws === 'string' && this.here(l.rec.ws), paused: l.paused, held_ms: o.heldMs, capped: o.capped, source: l.rec.source === 'job' || l.rec.source === 'cli' ? l.rec.source : 'other' };
      out.takes.push(take);
      if (!l.paused && !o.capped && !l.ignored) {
        out.holding = true;
        if (take.here) out.cause = 'here';
        else out.cause ??= 'elsewhere';
      }
    }
    return out;
  }
}

/** The ancestors of this process (ppid chain, from one ps table): a take's own hooks do not wait for it. */
export async function ancestorPids(): Promise<ReadonlySet<number>> {
  const { processTable } = await import('@retake/sandbox');
  const byPid = new Map((await processTable()).map((p) => [p.pid, p.ppid]));
  const out = new Set<number>();
  for (let p = byPid.get(process.pid); p !== undefined && p > 1 && !out.has(p); p = byPid.get(p)) out.add(p);
  return out;
}
