/**
 * The one place that starts the media tools (ffmpeg, ffprobe; L7.31, finding X3): a run to its end with its output
 * collected (`runMediaTool`, `runMediaToolSync`) or a process the caller streams through (`startMediaTool`) — with the
 * arguments as given, a time limit, a cancel, the signal each sends, what the tool wrote on stderr kept, and one error
 * type for what went wrong (`MediaToolError`). Which tool runs is media-tools.ts's (ffmpegBin / ffprobeBin, under the
 * work's policy); what a site says about a failure stays the site's own sentence, built from the error's facts.
 */
import { execFile, spawn, spawnSync } from 'node:child_process';
import type { ChildProcess, StdioOptions } from 'node:child_process';
import type { ErrorKind } from '../error-kind.js';

/**
 * How a media tool's run went wrong: `start` (it could not be started: missing, not executable), `exit` (a status other
 * than 0), `killed` (a signal it was not sent here), `timeout` / `cancelled` (killed here: its time limit, its cancel),
 * `output` (more output than the limit).
 */
export type MediaToolFailure = 'start' | 'exit' | 'killed' | 'timeout' | 'cancelled' | 'output';

/** A media tool that did not do its work: what was run, how it ended and what it said on stderr. */
export class MediaToolError extends Error {
  readonly program: string;
  readonly reason: MediaToolFailure;
  /** Its exit status (null: it did not exit by itself). */
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  /** The system's error code when it could not be started (`ENOENT`, `EACCES`, …). */
  readonly errno: string | undefined;
  /** What it wrote on stderr (as kept: see each call's limit). */
  readonly stderr: string;

  constructor(message: string, o: { program: string; reason: MediaToolFailure; code?: number | null; signal?: NodeJS.Signals | null; errno?: string; stderr?: string; cause?: unknown }) {
    super(message, o.cause !== undefined ? { cause: o.cause } : undefined);
    this.name = 'MediaToolError';
    this.program = o.program;
    this.reason = o.reason;
    this.code = o.code ?? null;
    this.signal = o.signal ?? null;
    this.errno = o.errno;
    this.stderr = o.stderr ?? '';
  }

  /** What a client outside the CLI is told (core error-kind.ts): a tool of the machine, not the person's input. */
  get errorKind(): ErrorKind {
    return 'internal';
  }
}

/** The first or last `n` lines of a tool's stderr, trimmed, joined by " | " ('' when it said nothing). Pure. */
export function stderrLines(stderr: string, n: number, from: 'first' | 'last' = 'last'): string {
  const lines = stderr.trim().split('\n');
  return (from === 'first' ? lines.slice(0, n) : lines.slice(-n)).join(' | ');
}

/** What a run to its end gave: the exit status (0; null when it did not exit by itself), its output, the error. */
export interface MediaRunResult<T extends string | Buffer> {
  code: number | null;
  stdout: T;
  stderr: string;
  /** Null when it exited 0. */
  error: MediaToolError | null;
}

export interface MediaRunOptions {
  /** stdout as text (default) or bytes. */
  encoding?: 'utf8' | 'buffer';
  /** Written to its stdin, which is then closed (a tool that quits before reading it: its exit says why). */
  input?: Buffer | string;
  /** Killed with `killSignal` past this many ms (none by default). */
  timeoutMs?: number;
  /** The signal of the time limit (default SIGTERM). */
  killSignal?: NodeJS.Signals;
  /** A cancel: the tool gets SIGTERM. */
  signal?: AbortSignal;
  /** Most bytes of stdout or stderr (default: Node's, 1 MiB); past it the tool is killed (`output`). */
  maxBuffer?: number;
}

/** The error of a finished run (execFile's), as MediaToolError: its message is the system's own. */
function runError(program: string, err: Error & { code?: string | number | null; signal?: NodeJS.Signals | null }, stderr: string, o: MediaRunOptions, timedOut: boolean): MediaToolError {
  const code = typeof err.code === 'number' ? err.code : null;
  const errno = typeof err.code === 'string' ? err.code : undefined;
  const reason: MediaToolFailure =
    errno === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? 'output' : errno !== undefined ? 'start' : o.signal?.aborted ? 'cancelled' : timedOut ? 'timeout' : code !== null ? 'exit' : 'killed';
  return new MediaToolError(err.message, { program, reason, code, signal: err.signal ?? null, ...(errno !== undefined ? { errno } : {}), stderr, cause: err });
}

/**
 * Run a media tool to its end, its output collected (never rejects: the answer's `error` says what went wrong). Its
 * exit status is `code` (null when it did not exit by itself: not started, killed, too much output).
 */
export function runMediaTool(program: string, args: readonly string[], o: MediaRunOptions & { encoding: 'buffer' }): Promise<MediaRunResult<Buffer>>;
export function runMediaTool(program: string, args: readonly string[], o?: MediaRunOptions & { encoding?: 'utf8' }): Promise<MediaRunResult<string>>;
export function runMediaTool(program: string, args: readonly string[], o: MediaRunOptions = {}): Promise<MediaRunResult<string | Buffer>> {
  return new Promise((done) => {
    let timedOut = false;
    const child = execFile(
      program,
      [...args],
      { encoding: o.encoding === 'buffer' ? 'buffer' : 'utf8', ...(o.maxBuffer !== undefined ? { maxBuffer: o.maxBuffer } : {}) },
      (err, stdout, stderr) => {
        if (timer) clearTimeout(timer);
        o.signal?.removeEventListener('abort', onAbort);
        const text = String(stderr ?? '');
        const out = o.encoding === 'buffer' ? (stdout as unknown as Buffer) : String(stdout ?? '');
        if (!err) return done({ code: 0, stdout: out, stderr: text, error: null });
        const error = runError(program, err, text, o, timedOut);
        done({ code: error.code, stdout: out, stderr: text, error });
      },
    );
    // execFile's own `timeout`, as it does it: the signal, the error then marked `killed`.
    const timer =
      o.timeoutMs !== undefined
        ? setTimeout(() => {
            timedOut = true;
            child.kill(o.killSignal ?? 'SIGTERM');
          }, o.timeoutMs)
        : null;
    const onAbort = () => child.kill('SIGTERM');
    o.signal?.addEventListener('abort', onAbort, { once: true });
    if (o.input !== undefined) {
      // A tool that quits before reading closes the pipe: its exit says why, not this write.
      child.stdin?.on('error', () => undefined);
      child.stdin?.end(o.input);
    }
  });
}

/**
 * Run a media tool to its end, synchronously (stdout as text or bytes). A failure throws MediaToolError, whose message
 * is execFileSync's (`Command failed: <program> <args>` and its stderr); unlike execFileSync, the tool's stderr is not
 * copied to this process's.
 */
export function runMediaToolSync(program: string, args: readonly string[], o: { encoding: 'buffer'; maxBuffer?: number }): Buffer;
export function runMediaToolSync(program: string, args: readonly string[], o?: { encoding?: 'utf8'; maxBuffer?: number }): string;
export function runMediaToolSync(program: string, args: readonly string[], o: { encoding?: 'utf8' | 'buffer'; maxBuffer?: number } = {}): string | Buffer {
  const r = spawnSync(program, [...args], { ...(o.encoding === 'buffer' ? {} : { encoding: 'utf8' as const }), ...(o.maxBuffer !== undefined ? { maxBuffer: o.maxBuffer } : {}) });
  const stderr = String(r.stderr ?? '');
  if (r.error) {
    const e = r.error as NodeJS.ErrnoException;
    const errno = typeof e.code === 'string' ? e.code : undefined;
    throw new MediaToolError(e.message, { program, reason: errno === 'ENOBUFS' ? 'output' : 'start', code: r.status, signal: r.signal, ...(errno !== undefined ? { errno } : {}), stderr, cause: e });
  }
  if (r.status !== 0) {
    const message = `Command failed: ${[program, ...args].join(' ')}${stderr.length > 0 ? `\n${stderr}` : ''}`;
    throw new MediaToolError(message, { program, reason: r.status !== null ? 'exit' : 'killed', code: r.status, signal: r.signal, stderr });
  }
  return r.stdout as string | Buffer;
}

/** How a started tool ended (`startMediaTool`). */
export interface MediaExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** It could not be started (the system's error), or an error of its process. */
  error: NodeJS.ErrnoException | null;
  /** Killed here: its time limit or its cancel. */
  killed?: 'timeout' | 'cancelled';
}

export interface MediaStartOptions {
  /** As spawn's: pipes, fds handed to the tool (`fd:` protocols), ignored streams. */
  stdio: StdioOptions;
  /** A cancel: the tool gets `cancelSignal` (default SIGTERM) when it aborts. */
  signal?: AbortSignal;
  cancelSignal?: NodeJS.Signals;
  /** A signal aborted before the start: the tool is killed at once (`kill`, the default) or left to run (`run`: the caller stops it its own way). */
  abortedAtStart?: 'kill' | 'run';
  /** Killed with `timeoutSignal` (default SIGKILL) past this many ms. */
  timeoutMs?: number;
  timeoutSignal?: NodeJS.Signals;
  /** What of stderr is kept: its first `max` characters (`head`, a chunk at a time) or its last `max` (`tail`). */
  stderr?: { keep: 'head' | 'tail'; max: number };
  /**
   * When `exited` settles: `close` (default: the process ended and its pipes closed) or `exit` (the process ended: a
   * process killed while something it started still holds its pipes does not hold the caller).
   */
  settle?: 'close' | 'exit';
}

/** A media tool started for its caller to stream through. */
export interface MediaProcess {
  readonly child: ChildProcess;
  /** What it wrote on stderr, as kept. */
  readonly stderr: string;
  /** Why it was killed here, if it was. */
  readonly killed: 'timeout' | 'cancelled' | undefined;
  /** Settles once (see `settle`); never rejects. */
  readonly exited: Promise<MediaExit>;
  /** Kill it now, saying why (the first reason given is kept). */
  kill(why: 'timeout' | 'cancelled', sig?: NodeJS.Signals): void;
}

/**
 * Start a media tool (spawn): its stderr kept, its time limit and cancel armed and released when it ends. A tool that
 * cannot be started answers through `exited` (`error`), never by a throw (but for arguments spawn itself refuses).
 */
export function startMediaTool(program: string, args: readonly string[], o: MediaStartOptions): MediaProcess {
  const child = spawn(program, [...args], { stdio: o.stdio });
  let stderr = '';
  let killed: 'timeout' | 'cancelled' | undefined;
  let error: NodeJS.ErrnoException | null = null;
  const keep = o.stderr;
  if (keep) {
    child.stderr?.on('data', (d: Buffer) => {
      if (keep.keep === 'tail') stderr = (stderr + d.toString()).slice(-keep.max);
      else if (stderr.length < keep.max) stderr += d.toString();
    });
  }
  const kill = (why: 'timeout' | 'cancelled', sig?: NodeJS.Signals) => {
    killed ??= why;
    child.kill(sig ?? (why === 'timeout' ? (o.timeoutSignal ?? 'SIGKILL') : (o.cancelSignal ?? 'SIGTERM')));
  };
  const onAbort = () => kill('cancelled');
  const timer = o.timeoutMs !== undefined ? setTimeout(() => kill('timeout'), o.timeoutMs) : null;
  if (o.signal?.aborted) {
    if (o.abortedAtStart !== 'run') onAbort();
  } else o.signal?.addEventListener('abort', onAbort, { once: true });
  const exited = new Promise<MediaExit>((resolve) => {
    const settle = (code: number | null, signal: NodeJS.Signals | null) => {
      if (timer) clearTimeout(timer);
      o.signal?.removeEventListener('abort', onAbort);
      resolve({ code, signal, error, ...(killed ? { killed } : {}) });
    };
    // The first of its error (it could not be started, or its process failed) and its end settles.
    child.on('error', (e: NodeJS.ErrnoException) => {
      error ??= e;
      settle(null, null);
    });
    child.on(o.settle === 'exit' ? 'exit' : 'close', (code: number | null, signal: NodeJS.Signals | null) => settle(code, signal));
  });
  return {
    child,
    get stderr() {
      return stderr;
    },
    get killed() {
      return killed;
    },
    exited,
    kill,
  };
}
