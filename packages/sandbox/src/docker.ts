/**
 * The `docker` CLI for the docker-compose provider (L1.8): where it is (`$RETAKE_DOCKER`, PATH, then the usual
 * install places of Docker Desktop, OrbStack and Homebrew), the environment it runs with (Retake's own — an
 * allow-list of it under the agent policy — minus every `COMPOSE_*` variable: a shell's COMPOSE_PROFILES or
 * COMPOSE_FILE would change which services a sandbox starts), how it is run (output captured, a timeout, an abort
 * signal), and the version checks: Compose v2.17 or later (`--wait-timeout`), a running daemon. No Docker SDK: the CLI
 * is the contract.
 */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { policyChildEnv } from '@retake/core';
import { SandboxError } from './errors.js';

/** Oldest Compose this provider runs (`up --wait-timeout`). */
export const MIN_COMPOSE_VERSION: readonly number[] = [2, 17, 0];
/** Seconds the version / daemon probes may take. */
export const DOCKER_PROBE_TIMEOUT_MS = 10_000;

/**
 * The usual install places of `docker` besides PATH (a GUI-launched shell, a minimal PATH): Docker Desktop, OrbStack,
 * Homebrew, Linux packages. `retake doctor` looks in the same places.
 */
export function dockerPlaces(home: string = homedir()): string[] {
  return [
    '/usr/local/bin/docker',
    '/opt/homebrew/bin/docker',
    join(home, '.orbstack', 'bin', 'docker'),
    '/Applications/OrbStack.app/Contents/MacOS/xbin/docker',
    '/Applications/Docker.app/Contents/Resources/bin/docker',
    '/usr/bin/docker',
  ];
}

/** Where a `docker` binary may be: PATH, then the usual install places (dockerPlaces). */
export function dockerCandidates(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string[] {
  const out: string[] = [];
  for (const dir of (env.PATH ?? '').split(delimiter)) if (dir) out.push(join(dir, 'docker'));
  out.push(...dockerPlaces(home));
  return [...new Set(out)];
}

function isExecutable(p: string): boolean {
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The docker binary: `$RETAKE_DOCKER` (as given), else the first candidate that is executable; null when none. */
export function findDocker(env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = isExecutable, home?: string): string | null {
  if (env.RETAKE_DOCKER) return env.RETAKE_DOCKER;
  return dockerCandidates(env, home).find(exists) ?? null;
}

/**
 * The environment docker runs with: this process's — under the agent policy (a job of the Studio, the desktop app or an
 * MCP client) only core childEnv's allow-list of it for docker (the shell's own variables, DOCKER_* and BUILDKIT_*, the
 * names of `pass`: project.yaml `pass_env:`) —, without `COMPOSE_*` (sandbox.yaml alone says what is started) nor the
 * names of `unset` (L5.8: those a sandbox's env file sets — a shell's value would win over the file's).
 */
export function dockerEnv(base: NodeJS.ProcessEnv = process.env, unset: readonly string[] = [], pass: readonly string[] = []): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  const inherited = policyChildEnv(base, { docker: true, pass }) ?? base;
  for (const [k, v] of Object.entries(inherited)) if (v !== undefined && !/^COMPOSE_/i.test(k) && !unset.includes(k)) out[k] = v;
  return out;
}

/** "5.1.2", "v2.29.1", "2.29.1-desktop.1", "Docker Compose version v2.20.0" → [5, 1, 2]; null when there is none. */
export function parseVersion(text: string): number[] | null {
  const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(text);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : null;
}

/** a ≥ b, numerically, part by part. */
export function versionAtLeast(a: readonly number[], b: readonly number[]): boolean {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

export interface DockerResult {
  /** Exit code (null when killed by a signal or not started). */
  code: number | null;
  stdout: string;
  stderr: string;
  ms: number;
  /** It could not be started (ENOENT…). */
  error?: string;
  /** Killed by the timeout. */
  timedOut?: boolean;
  /** Killed because the signal aborted. */
  aborted?: boolean;
}

export interface DockerRunOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  cwd?: string;
  /** Variables added to dockerEnv() (an exec step's `-e NAME` values). */
  env?: Record<string, string>;
  /** Names left out of this process's environment (the ones the sandbox's env file sets, L5.8). */
  unset?: readonly string[];
  /** Names passed on under the agent policy besides childEnv's base (project.yaml `pass_env:`). */
  pass?: readonly string[];
  /** Each line of output as it comes (stdout and stderr). */
  onLine?: (line: string) => void;
  /** The child, once spawned (a second Ctrl-C kills it synchronously). */
  onSpawn?: (child: ChildProcess) => void;
}

/** How docker is run: `args` after the binary. Injectable (tests run the provider on a fake). */
export type DockerExec = (args: string[], opts?: DockerRunOptions) => Promise<DockerResult>;

/** Run `bin args…` with dockerEnv, output captured (and streamed by line), killed on timeout / abort. */
export function runDocker(bin: string, args: string[], opts: DockerRunOptions = {}): Promise<DockerResult> {
  const t0 = Date.now();
  return new Promise((resolve) => {
    if (opts.signal?.aborted) return resolve({ code: null, stdout: '', stderr: '', ms: 0, aborted: true });
    let child: ChildProcess;
    try {
      child = spawn(bin, args, { cwd: opts.cwd, env: { ...dockerEnv(process.env, opts.unset, opts.pass), ...(opts.env ?? {}) }, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return resolve({ code: null, stdout: '', stderr: '', ms: 0, error: (e as Error).message });
    }
    opts.onSpawn?.(child);
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let aborted = false;
    const partial = { out: '', err: '' };
    const feed = (which: 'out' | 'err', chunk: string) => {
      if (!opts.onLine) return;
      const text = partial[which] + chunk;
      const lines = text.split(/\r?\n/);
      partial[which] = lines.pop() ?? '';
      for (const l of lines) if (l.trim()) opts.onLine(l);
    };
    child.stdout?.setEncoding('utf8').on('data', (d: string) => {
      stdout += d;
      feed('out', d);
    });
    child.stderr?.setEncoding('utf8').on('data', (d: string) => {
      stderr += d;
      feed('err', d);
    });
    const kill = () => {
      try {
        child.kill('SIGTERM');
      } catch {
        /* gone */
      }
      setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* gone */
        }
      }, 5000).unref();
    };
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          kill();
        }, opts.timeoutMs)
      : null;
    const onAbort = () => {
      aborted = true;
      kill();
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    let error: string | undefined;
    child.once('error', (e) => (error = e.message));
    child.once('close', (code) => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      for (const which of ['out', 'err'] as const) if (partial[which].trim() && opts.onLine) opts.onLine(partial[which]);
      resolve({ code, stdout, stderr, ms: Date.now() - t0, ...(error ? { error } : {}), ...(timedOut ? { timedOut } : {}), ...(aborted ? { aborted } : {}) });
    });
  });
}

/** The first meaningful line of a docker error ("Error response from daemon: …"). */
export function firstErrorLine(r: Pick<DockerResult, 'stderr' | 'stdout' | 'error'>): string {
  const text = `${r.stderr}\n${r.stdout}`;
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  return r.error ?? lines.find((l) => /error|cannot|denied|not found|no such|invalid|failed/i.test(l)) ?? lines[lines.length - 1] ?? 'no output';
}

export interface DockerInfo {
  bin: string;
  /** `docker compose version --short`. */
  compose: string;
  /** The daemon's version. */
  server: string;
}

/**
 * Docker ready for a docker-compose sandbox: the binary, Compose v2.17+, a running daemon. Throws SandboxError with what
 * to do otherwise.
 */
export async function dockerReady(exec: DockerExec, bin: string, signal?: AbortSignal): Promise<DockerInfo> {
  const need = `docker-compose sandboxes need Docker with Compose v${MIN_COMPOSE_VERSION.slice(0, 2).join('.')} or later`;
  const v = await exec(['compose', 'version', '--short'], { timeoutMs: DOCKER_PROBE_TIMEOUT_MS, signal });
  if (v.error) throw new SandboxError(`${need}: ${bin} could not be run (${v.error}) — install Docker Desktop or OrbStack, or set RETAKE_DOCKER`);
  if (v.code !== 0) throw new SandboxError(`${need}: \`docker compose\` is not available (${firstErrorLine(v)}) — install the Compose v2 plugin`);
  const compose = v.stdout.trim().replace(/^v/, '');
  const parsed = parseVersion(compose);
  if (parsed && !versionAtLeast(parsed, MIN_COMPOSE_VERSION)) throw new SandboxError(`${need}: this one is ${compose} — update Docker`);
  const info = await exec(['info', '--format', '{{.ServerVersion}}'], { timeoutMs: DOCKER_PROBE_TIMEOUT_MS, signal });
  const server = info.stdout.trim();
  if (info.code !== 0 || !server || server === '<no value>') {
    throw new SandboxError(`the Docker daemon is not running (start Docker Desktop or OrbStack): ${info.timedOut ? `docker info did not answer within ${DOCKER_PROBE_TIMEOUT_MS / 1000} s` : firstErrorLine(info)}`);
  }
  return { bin, compose, server };
}
