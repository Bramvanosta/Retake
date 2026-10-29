/**
 * `studio ui` (L4.1): the Studio web app of the workspace, served on 127.0.0.1 until Ctrl-C (or SIGTERM). One server
 * per workspace: when one already runs (`.demo-studio/ui.json`), this opens it again and exits. The URL it opens
 * carries a one-time bootstrap code (valid 60 s), never the session token; `studio ui` again gives a new one.
 * `--json` prints one line `{"type":"ui","v":1,"url","port","pid","reused","player"}` on stdout and nothing else (a
 * warning — `--port` naming another port than the running server's — goes to stderr); `player` is the preview frame's
 * origin (absent when an older running server does not say it).
 * `--supervised` (L5.2, the desktop shell): `--json --no-open`, and the server also stops when its stdin closes — the
 * parent that holds the pipe died or quit, so no orphan server keeps `ui.json`. The stdin watcher is installed before
 * the server starts (an EOF during the start closes it right after). Bytes read on stdin are discarded (BL-106's
 * confirm will be the first inbound message). Its line says `"v":2` (L5.2b): after it, a server this process serves
 * writes the `pending` and `job_end` lines of the shell's quit question and notifications (ui supervise.ts: enums and
 * checked slugs only, ≤ 8 KB a line, coalesced), and nothing else — console.log / info / debug go to stderr, the lines
 * through stdout's own write captured first (critique M4); a reader gone is seen as stdin's end (EPIPE is ignored). A
 * reused server gets no such lines (no pipe reaches it: the shell says so). A folder that is no workspace prints
 * `{"type":"error","v":2,"code":"no_workspace"}` on stdout before exiting 2, so the shell tells it from a usage error
 * (an older CLI without `--supervised` exits 2 with no line). On stopping it says why on stderr: `stopped: SIGTERM`,
 * `stopped: stdin closed`… — never a URL, a code or the token.
 */
import { spawn } from 'node:child_process';
import { EngineError } from '@demo-studio/engine';
import { EXIT, UsageError } from '../errors.js';
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

/** Resolves when stdin reaches its end (or fails): the supervising parent closed the pipe or died. Reads and discards. */
function stdinClosed(): Promise<string> {
  return new Promise((resolve) => {
    const done = () => resolve('stdin closed');
    process.stdin.on('data', () => undefined);
    process.stdin.once('end', done);
    process.stdin.once('close', done);
    process.stdin.once('error', done);
    process.stdin.resume();
  });
}

/** Open a URL in the default browser (macOS `open`, elsewhere `xdg-open`); false when it could not start. */
export function openBrowser(url: string): Promise<boolean> {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? undefined : 'xdg-open';
  if (!cmd) return Promise.resolve(false);
  return new Promise((resolve) => {
    const child = spawn(cmd, [url], { stdio: 'ignore', detached: true });
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
  const ended = supervised ? [stdinClosed()] : [];
  if (supervised) for (const s of [process.stdout, process.stderr]) s.on('error', () => undefined);
  const root = workspaceRoot(global);
  if (!root) {
    if (supervised) ui.result(JSON.stringify({ type: 'error', v: SUPERVISED_LINE_VERSION, code: 'no_workspace' }));
    ui.error('studio ui: no workspace here (no studio.yaml or projects/ folder): pass --root <workspace folder> or set DEMO_STUDIO_ROOT');
    return EXIT.usage;
  }
  // Like `studio mcp` (critique B5): the Studio's PATH keeps absolute entries only, none a package manager added for the
  // script (`pnpm studio ui`: node_modules/.bin), none inside the workspace — the ffmpeg of the thumbnails and the
  // worker it starts (with a clean environment: studioWorkerEnv) never run a program an agent wrote.
  const { clientPath } = await import('@demo-studio/mcp');
  process.env.PATH = clientPath(process.execPath, process.env.PATH ?? '', undefined, root);
  // Loaded only now: a broken app source breaks `studio ui`, never the other commands.
  const { launchStudio, startSupervisor } = await import('@demo-studio/ui');
  let launched;
  try {
    launched = await launchStudio({ root, port, log: (m) => ui.line(m) });
  } catch (e) {
    if (e instanceof EngineError) {
      ui.error(`studio ui: ${e.message}${e.fix ? `\nfix: ${e.fix}` : ''}`);
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
    ui.warn(`a Studio server already serves this workspace on port ${launched.port}: --port ${port} is not used (stop that server — Ctrl-C in its terminal, or kill ${launched.pid} — then run studio ui --port ${port} again)`);
  }
  if (json) ui.result(JSON.stringify({ type: 'ui', v: supervised ? SUPERVISED_LINE_VERSION : UI_LINE_VERSION, url, port: launched.port, pid: launched.pid, reused, ...(player ? { player } : {}) }));
  else {
    ui.line(reused ? `Demo Studio already serves ${root} at ${base} (pid ${launched.pid}).` : `Demo Studio serves ${root} at ${base} — Ctrl-C stops it.`);
    ui.line(`Open (once, within 60 s): ${url}`);
    ui.line('  `studio ui` again gives a new link; the session stays in the tab that opened it.');
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
  }
  const reason = await Promise.race([stopping, ...ended]);
  await launched.server.close();
  if (supervised) {
    process.stdin.destroy();
    ui.line(`stopped: ${reason}`);
  } else if (!json) ui.line(`Demo Studio stopped (${reason}).`);
  return EXIT.ok;
}
