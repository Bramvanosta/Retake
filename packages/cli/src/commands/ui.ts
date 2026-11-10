/**
 * `retake ui` (L4.1): the Studio web app of the workspace, served on 127.0.0.1 until Ctrl-C (or SIGTERM). One server
 * per workspace: when one already runs (`.retake/ui.json` names it; its token record is in the Retake home), this opens
 * it again and exits. The URL it opens carries a one-time bootstrap code (valid 60 s), never the session token;
 * `retake ui` again gives a new one. On macOS the browser gets that URL through osascript's stdin (openBrowser), never
 * through a program's arguments.
 * `--json` prints one line `{"type":"ui","v":1,"url","port","pid","reused","player"}` on stdout and nothing else (a
 * warning — `--port` naming another port than the running server's — goes to stderr); `player` is the preview frame's
 * origin (absent when an older running server does not say it).
 * `--supervised` (L5.2, the desktop shell): `--json --no-open`, and the server also stops when its stdin closes — the
 * parent that holds the pipe died or quit, so no orphan server keeps `ui.json`. The stdin watcher is installed before
 * the server starts (an EOF during the start closes it right after). L5.16c: stdin carries the shell's lines for the
 * Set-up sheet (ui desktop.ts parseShellLine: the folder picked in its native panel for the command, the notification
 * state), at most SHELL_LINE_MAX bytes each; anything else read there is dropped (L5.12d: the window page's answer to the
 * quit question comes through the op `desktop_answer` and goes out on stdout). Its line says `"v":2` (L5.2b): after it, a server this process serves
 * writes the `pending` and `job_end` lines of the shell's quit question and notifications (ui supervise.ts: enums and
 * checked slugs only, ≤ 8 KB a line, coalesced) and, L5.12d, the window page's `shown` / `answer` lines (desktop.ts),
 * and nothing else — console.log / info / debug go to stderr, the lines
 * through stdout's own write captured first (critique M4); a reader gone is seen as stdin's end (EPIPE is ignored). A
 * reused server gets no such lines (no pipe reaches it: the shell says so). A folder that is no workspace prints
 * `{"type":"error","v":2,"code":"no_workspace"}` on stdout before exiting 2, so the shell tells it from a usage error
 * (an older CLI without `--supervised` exits 2 with no line). On stopping it says why on stderr: `stopped: SIGTERM`,
 * `stopped: stdin closed`… — never a URL, a code or the token.
 */
import { spawn } from 'node:child_process';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EngineError } from '@retake/engine';
import { EXIT, UsageError, errorText } from '../errors.js';
import type { ExitCode } from '../errors.js';
import type { Ui } from '../ui.js';
import type { GlobalOptions } from '../workspace.js';
import { workspaceRoot } from './mcp.js';

export interface UiCommandOptions {
  port?: string;
  /** `--no-open` → false. */
  open?: boolean;
  json?: boolean;
  supervised?: boolean;
}

/** The `--json` line's format version (unchanged by L5.2b: a script reading it keeps working). */
export const UI_LINE_VERSION = 1;
/**
 * The supervised line's format version (the desktop shell refuses another one: the app and the CLI drift apart). 2
 * (L5.2b): the `pending` / `job_end` lines follow the line.
 */
export const SUPERVISED_LINE_VERSION = 2;

/**
 * The reader of the shell's stdin lines: bytes in, each whole line (UTF-8) out to `onLine`; a line longer than `max`
 * BYTES is dropped whole (review c B-L8: the cap counts bytes, as the shell writes them — a multi-byte character split
 * between two chunks is joined first).
 */
export function shellLineReader(onLine: (line: string) => void, max: number): (chunk: Buffer) => void {
  let buf = Buffer.alloc(0);
  let over = false;
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (let i = buf.indexOf(10); i >= 0; i = buf.indexOf(10)) {
      const line = buf.subarray(0, i);
      buf = buf.subarray(i + 1);
      if (over) over = false;
      else if (line.length <= max) onLine(line.toString('utf8'));
    }
    if (buf.length > max) {
      buf = Buffer.alloc(0);
      over = true;
    }
  };
}

/**
 * Resolves when stdin reaches its end (or fails): the supervising parent closed the pipe or died. Each whole line read
 * meanwhile goes to `onLine` (L5.16c: the shell's set-up answers); a line longer than `max` bytes is dropped whole.
 */
function stdinClosed(onLine: (line: string) => void, max: number): Promise<string> {
  return new Promise((resolve) => {
    const done = () => resolve('stdin closed');
    process.stdin.on('data', shellLineReader(onLine, max));
    process.stdin.once('end', done);
    process.stdin.once('close', done);
    process.stdin.once('error', done);
    process.stdin.resume();
  });
}

/** What `openBrowser` starts programs with (tests pass a stand-in: no browser ever opens). */
export type Spawner = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

export interface OpenerOptions {
  spawn?: Spawner;
  platform?: NodeJS.Platform;
  /** Where the fallback `.webloc` gets a private folder of its own (default: the system's temp folder). */
  tmp?: string;
  /** How long the fallback `.webloc` stays after `open` handed it over, before it is removed (ms). */
  keepMs?: number;
}

/**
 * The AppleScript that opens `url` in the default browser: one `open location` line, the URL a string literal (`\` and
 * `"` escaped); null for a URL with a control character (it never reaches a script).
 */
export function openLocationScript(url: string): string | null {
  if (/[\x00-\x1f\x7f]/.test(url)) return null;
  return `open location "${url.replace(/[\\"]/g, (c) => `\\${c}`)}"\n`;
}

/** A `.webloc` (an Internet location file: a property list with one URL) for `url`, XML-escaped. */
export function weblocText(url: string): string {
  const esc = url.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n\t<key>URL</key>\n\t<string>${esc}</string>\n</dict>\n</plist>\n`;
}

/** Runs `command args` (with `input` on its stdin); true when it exits 0 within 15 s. */
function ran(spawnFn: Spawner, command: string, args: readonly string[], input?: string): Promise<boolean> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawnFn(command, args, { stdio: [input === undefined ? 'ignore' : 'pipe', 'ignore', 'ignore'] });
    } catch {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve(false);
    }, 15_000);
    const done = (ok: boolean) => {
      clearTimeout(timer);
      resolve(ok);
    };
    child.once('error', () => done(false));
    child.once('exit', (code) => done(code === 0));
    if (input !== undefined) {
      child.stdin?.on('error', () => undefined);
      child.stdin?.end(input);
    }
  });
}

/**
 * Open the Studio's URL in the default browser; false when nothing could open it (the caller prints the link). The URL
 * carries a one-time code, so on macOS it never goes into a program's arguments, which any process of the machine can
 * list (ps): `osascript` reads `open location "<url>"` from its stdin; when that fails, the URL is written to a 0600
 * `.webloc` in a private temporary folder, `open` gets that file's path, and the file is removed a few seconds later.
 * Both by their absolute paths (OSASCRIPT, OPEN): the PATH never picks the program the code goes to.
 * Elsewhere `xdg-open <url>` (its argument holds the code for the instant it runs; the code dies once the page redeemed
 * it, or after 60 s); Windows: none.
 */
/** macOS's own programs that open the Studio's URL, by absolute path. */
export const OSASCRIPT = '/usr/bin/osascript';
export const OPEN = '/usr/bin/open';

export async function openBrowser(url: string, o: OpenerOptions = {}): Promise<boolean> {
  const spawnFn = o.spawn ?? spawn;
  const platform = o.platform ?? process.platform;
  if (platform === 'darwin') {
    const script = openLocationScript(url);
    if (!script) return false;
    if (await ran(spawnFn, OSASCRIPT, ['-'], script)) return true;
    let dir: string | undefined;
    try {
      dir = await mkdtemp(join(o.tmp ?? tmpdir(), 'retake-open-'));
      await chmod(dir, 0o700);
      const file = join(dir, 'Retake Studio.webloc');
      await writeFile(file, weblocText(url), { mode: 0o600, flag: 'wx' });
      await chmod(file, 0o600);
      const ok = await ran(spawnFn, OPEN, [file]);
      if (ok) await new Promise((r) => setTimeout(r, o.keepMs ?? 3000));
      return ok;
    } catch {
      return false;
    } finally {
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
  if (platform === 'win32') return false;
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawnFn('xdg-open', [url], { stdio: 'ignore', detached: true });
    } catch {
      resolve(false);
      return;
    }
    child.once('error', () => resolve(false));
    child.once('spawn', () => {
      child.unref();
      resolve(true);
    });
  });
}

function stopSignal(): Promise<string> {
  return new Promise((resolve) => {
    const stop = (s: NodeJS.Signals) => {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      resolve(s);
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  });
}

export async function uiCommand(ui: Ui, global: GlobalOptions, opts: UiCommandOptions): Promise<ExitCode> {
  let port = 0;
  if (opts.port !== undefined) {
    port = Number(opts.port);
    if (!/^\d+$/.test(opts.port) || port > 65535) throw new UsageError(`--port must be a port number from 0 to 65535, got "${opts.port}"`);
  }
  const supervised = opts.supervised === true;
  const json = opts.json === true || supervised;
  // Installed first (critique M3): a parent that dies during the start still stops this server once it listens.
  // L5.16c: the shell's set-up lines go to the server once it serves (dropped before).
  let shellLine: (line: string) => void = () => undefined;
  // 8192: ui SHELL_LINE_MAX (@retake/ui loads only once the workspace is known; a test compares the two).
  const ended = supervised ? [stdinClosed((l) => shellLine(l), 8192)] : [];
  if (supervised) for (const s of [process.stdout, process.stderr]) s.on('error', () => undefined);
  const root = workspaceRoot(global);
  if (!root) {
    if (supervised) ui.result(JSON.stringify({ type: 'error', v: SUPERVISED_LINE_VERSION, code: 'no_workspace' }));
    ui.error('retake ui: no workspace here (no retake.yaml or projects/ folder): pass --root <workspace folder> or set RETAKE_ROOT');
    return EXIT.usage;
  }
  // Like `retake mcp` (critique B5): the Studio's PATH keeps absolute entries only, none a package manager added for the
  // script (`pnpm retake ui`: node_modules/.bin), none inside the workspace — the ffmpeg of the thumbnails and the
  // worker it starts (with a clean environment: studioWorkerEnv) never run a program an agent wrote.
  const { clientPath } = await import('@retake/mcp');
  process.env.PATH = clientPath(process.execPath, process.env.PATH ?? '', undefined, root);
  // Loaded only now: a broken app source breaks `retake ui`, never the other commands.
  const { applyShellLine, launchStudio, startSupervisor } = await import('@retake/ui');
  let launched;
  try {
    launched = await launchStudio({ root, port, log: (m) => ui.line(m) });
  } catch (e) {
    if (e instanceof EngineError) {
      ui.error(`retake ui: ${errorText(e)}`);
      return EXIT.failure;
    }
    throw e;
  }
  const { url, reused, player } = launched;
  // Before the line (L5.2b): a parent that reads it and signals at once meets the handler, not the default exit.
  const stopping = stopSignal();
  const base = url.replace(/#.*$/, '');
  // The running server keeps its port (review B L4): say so instead of silently ignoring --port.
  if (reused && opts.port !== undefined && port !== 0 && launched.port !== port) {
    ui.warn(`a Studio server already serves this workspace on port ${launched.port}: --port ${port} is not used (stop that server — Ctrl-C in its terminal, or kill ${launched.pid} — then run retake ui --port ${port} again)`);
  }
  if (json) ui.result(JSON.stringify({ type: 'ui', v: supervised ? SUPERVISED_LINE_VERSION : UI_LINE_VERSION, url, port: launched.port, pid: launched.pid, reused, ...(player ? { player } : {}) }));
  else {
    ui.line(reused ? `Retake already serves ${root} at ${base} (pid ${launched.pid}).` : `Retake serves ${root} at ${base} — Ctrl-C stops it.`);
    ui.line(`Open (once, within 60 s): ${url}`);
    ui.line('  `retake ui` again gives a new link; the session stays in the tab that opened it.');
  }
  if (!supervised && opts.open !== false && !(await openBrowser(url)) && !json) ui.line('No browser could be opened: open the link above.');
  if (launched.reused) {
    if (supervised) process.stdin.destroy();
    return EXIT.ok;
  }
  if (supervised) {
    // Critique M4: stdout carries the shell's lines only — a stray console.log of any module goes to stderr.
    const write = process.stdout.write.bind(process.stdout) as (text: string) => boolean;
    for (const k of ['log', 'info', 'debug'] as const) console[k] = (...a: unknown[]) => console.error(...a);
    startSupervisor({ server: launched.server, out: { write: (t) => write(t), once: (e, f) => process.stdout.once(e, f) }, log: (m) => ui.line(m) });
    const server = launched.server;
    // L5.16d: and the update's state (the Studio's status bar and update sheet).
    shellLine = (l) => void applyShellLine(server.setup, root, l, server.update);
  }
  const reason = await Promise.race([stopping, ...ended]);
  await launched.server.close();
  if (supervised) {
    process.stdin.destroy();
    ui.line(`stopped: ${reason}`);
  } else if (!json) ui.line(`Retake stopped (${reason}).`);
  return EXIT.ok;
}
