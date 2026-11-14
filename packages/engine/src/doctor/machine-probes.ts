/**
 * The product's probes of `retake doctor` (types.ts DoctorProbes): this machine's PATH, programs, files and network,
 * and what the ports know of it — the capture browser (CaptureRunner `probe`), the render path and browser (Renderer
 * `machine`), a sandbox's status (Sandboxes `open`). Made by a composition root with its ports (the CLI: `cliPorts`);
 * nothing here is started before a check asks.
 */
import { execFile } from 'node:child_process';
import { accessSync, closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readSync, readdirSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { errorMessage } from '@retake/core/base';
import { bundleInfoOrNull, bundleProblems } from '@retake/core/io';
import type { LoadedProject } from '@retake/core/model';
import type { WorkPolicy } from '@retake/core/policy';
import type { EngineEnv } from '../env.js';
import { FilmingWatch, capMinutes, capturesDir, capturesLocation, isTakeOwnerCommand } from '../jobs/captures.js';
import { liveWorker } from '../jobs/lock.js';
import type { EnginePorts } from '../ports.js';
import type { Sandboxes } from '../sandboxes/sandboxes.js';
import type { CapturesProbe, DoctorProbes, ExecResult, SandboxProbe, WorkerProbe } from './types.js';

/** The largest file the `read` probe reads (a `.gitignore`, the app's launch.json). */
const READ_MAX_BYTES = 64 * 1024;

/** The text of a small regular file (≤ 64 KB), never through a link; null otherwise (the `read` probe). */
export function readSmallFile(file: string): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > READ_MAX_BYTES) return null;
    const buf = Buffer.alloc(st.size);
    const n = readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n).toString('utf8');
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** An executable on `env`'s PATH (PATHEXT on Windows), or a path with a slash that is executable; null otherwise. */
export function whichOnPath(cmd: string, env: Record<string, string | undefined>, platform: NodeJS.Platform): string | null {
  if (cmd.includes('/')) return isExecutable(cmd) ? cmd : null;
  const exts = platform === 'win32' ? (env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = join(dir, cmd + ext);
      if (isExecutable(p)) return p;
    }
  }
  return null;
}

function isExecutable(p: string): boolean {
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Run a command; null when it cannot be started (not found). */
function execProbe(cmd: string, args: string[], timeoutMs: number): Promise<ExecResult | null> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') return resolve(null);
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

/** The names in a real folder (not a link), or null. */
function listProbe(dir: string): string[] | null {
  try {
    return lstatSync(dir).isDirectory() ? readdirSync(dir) : null;
  } catch {
    return null;
  }
}

/** A sandbox of the project as `retake sandbox status` sees it (no lock, nothing started). */
function sandboxProbe(sandboxes: Sandboxes): (project: LoadedProject, env: string, policy: WorkPolicy) => Promise<SandboxProbe> {
  return async (project, env, policy) => {
    try {
      const st = await (await sandboxes.open(project, env, policy)).status();
      const problems = st.services
        .filter((x) => !x.orphan && (x.state !== 'running' || x.healthy === false))
        .map((x) => `${x.name}: ${x.state === 'stopped' ? 'not running' : x.state === 'starting' ? 'starting' : `not healthy (${x.health})`}`);
      return { state: st.state, provider: st.provider, problems, services: st.services.filter((x) => !x.orphan).length, ...(st.seed ? { seed: st.seed.hash } : {}) };
    } catch (e) {
      return { state: 'down', provider: project.sandboxes?.[env]?.manifest.provider ?? '?', problems: [], services: 0, error: errorMessage(e) };
    }
  };
}

/** This user's filming markers on this Mac, as the "Captures first" line counts them (nothing made). */
function capturesProbe(env: EngineEnv): (root: string) => Promise<CapturesProbe> {
  return async (root) => {
    const loc = capturesLocation(env);
    const exists = existsSync(loc.dir);
    // Nothing is made: an absent folder is read as "no take yet" (capturesDir would make it).
    const usable = exists ? capturesDir(env) : { dir: null, ...(loc.problem ? { problem: loc.problem } : {}) };
    const st = usable.dir ? await new FilmingWatch({ root, env }).scan() : { takes: [] };
    const takes = [];
    for (const t of st.takes) {
      const cmd = await new Promise<string>((r) => execFile('ps', ['-ww', '-o', 'command=', '-p', String(t.pid)], { timeout: 5000, encoding: 'utf8' }, (err, out) => r(err ? '' : String(out))));
      // A Retake worker or `retake run` only (any other node process is not one).
      takes.push({ here: t.here, paused: t.paused, capped: t.capped, retake: isTakeOwnerCommand(cmd.trim()) });
    }
    return {
      dir: loc.dir,
      override: loc.override,
      exists,
      ...(usable.problem ? { problem: usable.problem } : {}),
      takes,
      qos: process.platform === 'darwin' && existsSync('/usr/sbin/taskpolicy'),
      capMin: capMinutes(env),
    };
  };
}

/** The jobs worker serving a workspace (its lock), or null. */
async function workerProbe(root: string): Promise<WorkerProbe | null> {
  const w = await liveWorker(root);
  return w ? { pid: w.pid, since: w.since, ...(w.started_by ? { started_by: w.started_by } : {}), version: w.version, ...(w.engine ? { engine: w.engine } : {}) } : null;
}

/** A HEAD request: an HTTP status (reachable), or the network error. */
async function headProbe(url: string, timeoutMs: number): Promise<{ status?: number; error?: string; ms: number }> {
  const t0 = performance.now();
  try {
    const res = await fetch(url, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    return { status: res.status, ms: Math.round(performance.now() - t0) };
  } catch (e) {
    const err = e as Error & { cause?: { code?: string; message?: string } };
    const why = err.name === 'TimeoutError' ? `no answer within ${timeoutMs / 1000} s` : (err.cause?.code ?? err.cause?.message ?? err.message);
    return { error: why, ms: Math.round(performance.now() - t0) };
  }
}

/** The probes of this machine, with what `ports` know of it (the composition root's: their env is the one read). */
export function machineProbes(ports: Pick<EnginePorts, 'env' | 'capture' | 'renderer' | 'sandboxes'>): DoctorProbes {
  const env = ports.env as Record<string, string | undefined>;
  return {
    platform: process.platform,
    nodeVersion: process.versions.node,
    env,
    which: (cmd) => whichOnPath(cmd, env, process.platform),
    exec: execProbe,
    exists: (p) => existsSync(p),
    list: listProbe,
    read: readSmallFile,
    sandbox: sandboxProbe(ports.sandboxes),
    chromium: (browser, policy) => ports.capture.probe(browser, policy),
    execPath: process.execPath,
    bundle: bundleInfoOrNull(),
    bundleProblems,
    renderBrowser: () => ports.renderer.machine.browser(),
    renders: (policy) => ports.renderer.machine.path(policy),
    captures: capturesProbe(ports.env),
    worker: workerProbe,
    head: headProbe,
  };
}
