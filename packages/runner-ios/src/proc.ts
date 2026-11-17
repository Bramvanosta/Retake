/**
 * The programs an iOS run starts (xcrun: simctl, xcodebuild, plutil): run to their end with their output collected
 * (`run`), or started and streamed (`start`: the driver's xcodebuild, the screen recording) — in a process group of
 * their own (a stop reaches what they start), with a time limit, the run's cancel, and their output streamed to a log
 * file when asked. Everything that starts a program goes through an `Exec` (procExec here; the tests hand a fake).
 */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import type { WriteStream } from 'node:fs';

/** How a program run to its end went. */
export interface ProcResult {
  /** Its exit status (null: it did not exit by itself — killed, not started). */
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  /** It could not be started (ENOENT…), or was killed here: its time limit, the cancel. */
  error?: 'start' | 'timeout' | 'cancelled';
  /** The system's error message when it could not be started. */
  message?: string;
}

export interface RunOpts {
  timeoutMs?: number;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  /** Most bytes of stdout kept (default 16 MiB). */
  maxOutput?: number;
}

export interface StartOpts {
  env?: NodeJS.ProcessEnv;
  /** Each line of stdout and stderr, as it comes (after `redact`), is appended to this file. */
  logFile?: string;
  /** What a line becomes before it reaches the log and `onLine` (the run's secrets masked). */
  redact?: (line: string) => string;
  /**
   * Each line of its output, as it comes (stdout and stderr), with the monotonic time (process.hrtime, ns) its chunk
   * was read at — taken before anything else is done with it.
   */
  onLine?: (line: string, stream: 'stdout' | 'stderr', at: bigint) => void;
}

/** A program started and streamed. */
export interface ProcHandle {
  readonly pid: number | undefined;
  /** Settles once it ended (never rejects). */
  readonly exited: Promise<ProcResult>;
  /** Whether it ended. */
  readonly done: boolean;
  /** A signal to its process group (it and what it started). */
  signal(sig: NodeJS.Signals): void;
}

/** What starts programs: the machine's (procExec), or a test's. */
export interface Exec {
  run(program: string, args: readonly string[], o?: RunOpts): Promise<ProcResult>;
  start(program: string, args: readonly string[], o?: StartOpts): ProcHandle;
  /** A watch that stops the process group `pid` leads if this process dies first (orphanWatch); its end. */
  watch?(pid: number): () => void;
}

/** The watch's shell script: $1 the host's pid, $2 the watched group's leader. */
const WATCH_SCRIPT = [
  'while kill -0 "$1" 2>/dev/null; do sleep 1; done',
  'kill -INT -- "-$2" 2>/dev/null || exit 0',
  'i=0; while [ $i -lt 15 ] && kill -0 -- "-$2" 2>/dev/null; do sleep 1; i=$((i+1)); done',
  'kill -KILL -- "-$2" 2>/dev/null',
].join('\n');

/**
 * A small watcher (`/bin/sh`, detached, unreferenced) that sends SIGINT to the process group `pid` leads once `host`
 * (this process) is gone, then SIGKILL 15 s later — a recording outlives no host that died hard (SIGKILL, a crash:
 * nothing of this process runs then). Its end stops the watcher.
 */
export function orphanWatch(pid: number, host: number = process.pid): () => void {
  let watcher: ChildProcess;
  try {
    watcher = spawn('/bin/sh', ['-c', WATCH_SCRIPT, 'retake-watch', String(host), String(pid)], { stdio: 'ignore', detached: true });
  } catch {
    return () => undefined;
  }
  watcher.on('error', () => undefined);
  watcher.unref();
  return () => signalGroup(watcher.pid, 'SIGKILL');
}

/** A signal to the process group `pid` leads (a group already gone: nothing). */
export function signalGroup(pid: number | undefined, sig: NodeJS.Signals): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, sig);
  } catch {
    try {
      process.kill(pid, sig);
    } catch {
      /* gone */
    }
  }
}

/** Lines out of a stream's chunks (the last, unfinished one kept for the next chunk). */
function lineSplitter(onLine: (line: string, at: bigint) => void): { push(chunk: Buffer, at: bigint): void; end(): void } {
  let rest = '';
  return {
    push(chunk, at) {
      const text = rest + chunk.toString('utf8');
      const lines = text.split('\n');
      rest = lines.pop() ?? '';
      for (const l of lines) onLine(l.replace(/\r$/, ''), at);
    },
    end() {
      if (rest) onLine(rest, process.hrtime.bigint());
      rest = '';
    },
  };
}

function runProc(program: string, args: readonly string[], o: RunOpts = {}): Promise<ProcResult> {
  return new Promise((done) => {
    const max = o.maxOutput ?? 16 * 1024 * 1024;
    let stdout = '';
    let stderr = '';
    let killed: 'timeout' | 'cancelled' | undefined;
    let child: ChildProcess;
    try {
      child = spawn(program, [...args], { stdio: ['ignore', 'pipe', 'pipe'], detached: true, ...(o.env ? { env: o.env } : {}) });
    } catch (e) {
      done({ code: null, signal: null, stdout: '', stderr: '', error: 'start', message: (e as Error).message });
      return;
    }
    child.stdout?.on('data', (d: Buffer) => {
      if (stdout.length < max) stdout += d.toString('utf8');
    });
    child.stderr?.on('data', (d: Buffer) => {
      if (stderr.length < 65536) stderr += d.toString('utf8');
    });
    const kill = (why: 'timeout' | 'cancelled') => {
      killed ??= why;
      signalGroup(child.pid, 'SIGTERM');
      setTimeout(() => signalGroup(child.pid, 'SIGKILL'), 2000).unref();
    };
    const timer = o.timeoutMs !== undefined ? setTimeout(() => kill('timeout'), o.timeoutMs) : null;
    const onAbort = () => kill('cancelled');
    if (o.signal?.aborted) onAbort();
    else o.signal?.addEventListener('abort', onAbort, { once: true });
    let startError: string | undefined;
    child.on('error', (e) => {
      startError = e.message;
    });
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      o.signal?.removeEventListener('abort', onAbort);
      const error = startError !== undefined && code === null ? 'start' : killed;
      done({ code, signal, stdout, stderr, ...(error ? { error } : {}), ...(startError !== undefined ? { message: startError } : {}) });
    });
  });
}

function startProc(program: string, args: readonly string[], o: StartOpts = {}): ProcHandle {
  const log: WriteStream | null = o.logFile ? createWriteStream(o.logFile, { flags: 'a', mode: 0o600 }) : null;
  let stdout = '';
  let stderr = '';
  let done = false;
  const child = spawn(program, [...args], { stdio: ['ignore', 'pipe', 'pipe'], detached: true, ...(o.env ? { env: o.env } : {}) });
  const line = (stream: 'stdout' | 'stderr') => (raw: string, at: bigint) => {
    const l = o.redact ? o.redact(raw) : raw;
    // The line's own business first (the recording's start is stamped by `at`, read before the log is written).
    o.onLine?.(l, stream, at);
    log?.write(`${l}\n`);
    if (stream === 'stderr' && stderr.length < 65536) stderr += `${l}\n`;
    if (stream === 'stdout' && stdout.length < 65536) stdout += `${l}\n`;
  };
  const out = lineSplitter(line('stdout'));
  const err = lineSplitter(line('stderr'));
  child.stdout?.on('data', (d: Buffer) => out.push(d, process.hrtime.bigint()));
  child.stderr?.on('data', (d: Buffer) => err.push(d, process.hrtime.bigint()));
  let startError: string | undefined;
  child.on('error', (e) => {
    startError = e.message;
  });
  const exited = new Promise<ProcResult>((resolve) => {
    child.on('close', (code, signal) => {
      out.end();
      err.end();
      done = true;
      const finish = () => resolve({ code, signal, stdout, stderr, ...(startError !== undefined && code === null ? { error: 'start' as const, message: startError } : {}) });
      if (log) log.end(finish);
      else finish();
    });
  });
  return {
    get pid() {
      return child.pid;
    },
    exited,
    get done() {
      return done;
    },
    signal: (sig) => signalGroup(child.pid, sig),
  };
}

/** The machine's Exec. */
export const procExec: Exec = { run: runProc, start: startProc, watch: (pid) => orphanWatch(pid) };

/** A finished run's failure in a few words (its stderr's last line), or null when it exited 0. */
export function procProblem(r: ProcResult, what: string): string | null {
  if (r.error === 'start') return `${what} could not be started (${r.message ?? 'not found'})`;
  if (r.error === 'timeout') return `${what} did not finish in time`;
  if (r.error === 'cancelled') return `${what} was cancelled`;
  if (r.code === 0) return null;
  const last = r.stderr.trim().split('\n').filter(Boolean).slice(-2).join(' | ');
  return `${what} failed (exit ${r.code ?? r.signal})${last ? `: ${last}` : ''}`;
}
