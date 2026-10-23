/**
 * `studio ui` (L4.1): the Studio web app of the workspace, served on 127.0.0.1 until Ctrl-C (or SIGTERM). One server
 * per workspace: when one already runs (`.demo-studio/ui.json`), this opens it again and exits. The URL it opens
 * carries a one-time bootstrap code (valid 60 s), never the session token; `studio ui` again gives a new one.
 * `--json` prints one line `{"type":"ui","url","port","pid","reused"}` on stdout and nothing else (a warning — `--port`
 * naming another port than the running server's — goes to stderr).
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

function stopSignal(): Promise<NodeJS.Signals> {
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
  const root = workspaceRoot(global);
  if (!root) {
    ui.error('studio ui: no workspace here (no studio.yaml or projects/ folder): pass --root <workspace folder> or set DEMO_STUDIO_ROOT');
    return EXIT.usage;
  }
  // Loaded only now: a broken app source breaks `studio ui`, never the other commands.
  const { launchStudio } = await import('@demo-studio/ui');
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
  const { url, reused } = launched;
  const base = url.replace(/#.*$/, '');
  // The running server keeps its port (review B L4): say so instead of silently ignoring --port.
  if (reused && opts.port !== undefined && port !== 0 && launched.port !== port) {
    ui.warn(`a Studio server already serves this workspace on port ${launched.port}: --port ${port} is not used (stop that server — Ctrl-C in its terminal, or kill ${launched.pid} — then run studio ui --port ${port} again)`);
  }
  if (opts.json) ui.result(JSON.stringify({ type: 'ui', url, port: launched.port, pid: launched.pid, reused }));
  else {
    ui.line(reused ? `Demo Studio already serves ${root} at ${base} (pid ${launched.pid}).` : `Demo Studio serves ${root} at ${base} — Ctrl-C stops it.`);
    ui.line(`Open (once, within 60 s): ${url}`);
    ui.line('  `studio ui` again gives a new link; the session stays in the tab that opened it.');
  }
  if (opts.open !== false && !(await openBrowser(url)) && !opts.json) ui.line('No browser could be opened: open the link above.');
  if (launched.reused) return EXIT.ok;
  const signal = await stopSignal();
  await launched.server.close();
  if (!opts.json) ui.line(`Demo Studio stopped (${signal}).`);
  return EXIT.ok;
}
