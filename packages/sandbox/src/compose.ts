/**
 * The docker-compose provider (L1.8): the sandbox's services are the compose files' (`compose.files`, default
 * compose.yaml next to sandbox.yaml), run through the `docker compose` CLI under a project name of their own —
 * `compose.project`, else `retake-<project>-<environment>-<hash of the folder>` (two checkouts of one project never
 * share containers or volumes). Every call names the project, its folder and its files (`-p`, `--project-directory`,
 * `-f`) and its env file (`--env-file`, L5.8: the image versions and settings of `${VAR}`s — the names it sets are left
 * out of the shell's environment, which would win over it), with `COMPOSE_*` variables of the shell left out, and every
 * command reads the project's containers first (`ps`): containers of that name made from another folder (another
 * checkout sharing a `compose.project`) refuse it.
 *
 * up: the compose files read (`config --format json`); a name an earlier up used (compose.project changed since) still
 * running refused; no container of another project may publish one of the ports, on any address (`docker ps --filter
 * publish=`: OrbStack lets one publish [::1] / [::] next to the sandbox's 127.0.0.1, and `localhost` reaches ::1
 * first); every port the files publish free (any listener refuses: OrbStack lets a container publish a busy port, and
 * the other program then answers part of the traffic) except those the project's own running containers hold, then
 * `up -d --wait --wait-timeout <s> --remove-orphans [--build]` (output in logs/compose-up.log). Its exit code is not
 * trusted — `--wait` can exit 0 on a timeout —: `ps --all --format json` must then show every service running, healthy
 * or without a healthcheck. The published ports must be held by the container runtime alone (lsof) and by no other
 * project's container (docker ps again), every manifest service must pass its health check (default a GET of its url,
 * 120 s) and every Postgres database of sandbox.yaml must answer — health checks, pg, the mailbox clear and sql seed
 * steps connect to the address Docker publishes the port on (127.0.0.1, ::1), never to `localhost`. down: `down
 * --remove-orphans [--volumes]` (never `--rmi`), the earlier names too (kept in the state until their volumes are
 * gone). exec seeds: `exec -T`. logs: `logs --tail`. An interrupted or failed up stops the services that call started
 * (`stop`: their logs stay).
 */
import { spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { join, resolve } from 'node:path';
import { DEFAULT_COMPOSE_FILES, envFileKeys, interpolateDeep, policyProgram, resolveEnvironment, sandboxNames } from '@retake/core';
import { composeEnvFile, prefetchSecrets, programLookup } from '@retake/core/io';
import type { ExecStepSpec, LoadedProject, LoadedSandbox, WorkPolicy } from '@retake/core';
import { dockerEnv, dockerReady, findDocker, firstErrorLine, runDocker } from './docker.js';
import type { DockerExec, DockerInfo, DockerResult, DockerRunOptions } from './docker.js';
import { checkExecHosts, masker, sandboxSecrets } from './seed.js';
import { SandboxError, errorMessage, interrupted } from './errors.js';
import { healthNow, pinHealth, serviceHealth, waitHealthy } from './health.js';
import { shownPath } from './paths.js';
import { busyPorts, describeListeners, listeners, portLabel, sandboxPorts } from './ports.js';
import type { Listener, SandboxPort } from './ports.js';
import type { DownOptions, DownResult, OwnerUse, Provider, ProviderContext, ProviderLogs, ServiceLogFile, ServiceStatus, UpOptions, UpResult } from './provider.js';
import { pgAnswers, pgEndpoint, resolveDatabaseUrl } from './snapshot-postgres.js';

/** Default seconds a compose service has to become healthy (`--wait-timeout`, then the manifest's checks). */
export const COMPOSE_HEALTH_TIMEOUT_S = 120;
/** Default seconds of an `exec` seed step. */
export const EXEC_TIMEOUT_S = 300;
/** The variable every process of an exec seed step carries in its container (`RETAKE_EXEC=<token>`). */
export const EXEC_MARK = 'RETAKE_EXEC';
/**
 * Run inside a container as `sh -c <script> sh <token> TERM|KILL`: signals every process whose environment carries
 * RETAKE_EXEC=<token> (read from /proc/<pid>/environ) — SIGTERM, up to 3 s, then SIGKILL; KILL at once.
 */
export const KILL_EXEC_SCRIPT = [
  `mark="${EXEC_MARK}=$1"`,
  'pids() { for d in /proc/[0-9]*; do p=${d#/proc/}; [ "$p" = "$$" ] && continue; tr \'\\000\' \'\\n\' < "$d/environ" 2>/dev/null | grep -qx "$mark" && echo "$p"; done; }',
  'l=$(pids); [ -z "$l" ] && exit 0',
  'if [ "$2" = KILL ]; then kill -9 $l 2>/dev/null; exit 0; fi',
  'kill -15 $l 2>/dev/null',
  'for i in 1 2 3; do sleep 1; l=$(pids); [ -z "$l" ] && exit 0; done',
  'kill -9 $l 2>/dev/null; exit 0',
].join('\n');
/** Lines of a failing service's `docker compose logs` quoted in an error. */
export const COMPOSE_LOG_TAIL = 30;
/** Program names of the container runtimes' port forwarders (OrbStack Helper, com.docker.backend, vpnkit…). */
export const DOCKER_HELPER = /orbstack|docker|vpnkit|rootlesskit|slirp4netns|limactl|colima|gvproxy|podman/i;

/** The compose project of a sandbox: name, folder (real path), files (absolute), env file. */
export interface ComposeProjectRef {
  name: string;
  dir: string;
  files: string[];
  /** The env file every command reads (`--env-file`, L5.8: core composeEnvFile), absolute; absent: none. */
  envFile?: string;
  /** The names it sets: left out of the environment docker runs with (a shell's value would win over the file's). */
  envKeys?: string[];
  /** project.yaml `pass_env:`: passed on to docker under the agent policy besides core childEnv's base. */
  pass?: string[];
}

function realDir(dir: string): string {
  try {
    return realpathSync(dir);
  } catch {
    return resolve(dir);
  }
}

/**
 * `retake-<project slug>-<environment>-<8 hex of the folder's path>`, lower-case letters, digits, `-` and `_`,
 * at most 63 characters (the slug and environment are shortened, never the hash).
 */
export function composeProjectName(slug: string, env: string, dir: string): string {
  const hash = createHash('sha256').update(dir).digest('hex').slice(0, 8);
  const clean = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/-{2,}/g, '-')
      .replace(/^[-_]+|[-_]+$/g, '');
  const prefix = 'retake-';
  const suffix = `-${hash}`;
  let middle = [clean(slug), clean(env)].filter(Boolean).join('-');
  const room = 63 - prefix.length - suffix.length;
  if (middle.length > room) middle = middle.slice(0, room).replace(/[-_]+$/, '');
  return `${prefix}${middle || 'sandbox'}${suffix}`;
}

/** What the state file keeps of a sandbox's compose project (`provider_state.compose`). */
export interface ComposeRecord {
  project: string;
  dir: string;
  /**
   * Names an earlier `up` used (compose.project changed since), with their folder: `up` refuses while one runs, `down`
   * takes them down too, and each is forgotten once it has neither containers nor volumes left.
   */
  previous?: Array<{ project: string; dir: string }>;
}

/** The compose record of a state (undefined when no up recorded one). */
export function composeRecord(state: { provider_state?: Record<string, unknown> }): ComposeRecord | undefined {
  const c = state.provider_state?.compose as Partial<ComposeRecord> | undefined;
  return c && typeof c.project === 'string' ? { project: c.project, dir: typeof c.dir === 'string' ? c.dir : '', ...(Array.isArray(c.previous) ? { previous: c.previous } : {}) } : undefined;
}

/** The compose project a sandbox runs as. */
export function composeProject(project: Pick<LoadedProject, 'slug'> & { config?: Pick<LoadedProject['config'], 'pass_env'> }, sandbox: Pick<LoadedSandbox, 'env' | 'dir' | 'manifest'>): ComposeProjectRef {
  const dir = realDir(sandbox.dir);
  const files = (sandbox.manifest.compose?.files ?? DEFAULT_COMPOSE_FILES).map((f) => resolve(dir, f));
  const envFile = composeEnvFile({ dir, manifest: sandbox.manifest });
  let envKeys: string[] = [];
  if (envFile) {
    try {
      envKeys = envFileKeys(readFileSync(envFile, 'utf8'));
    } catch {
      /* a missing file: docker compose says so */
    }
  }
  const pass = project.config?.pass_env;
  return {
    name: sandbox.manifest.compose?.project ?? composeProjectName(project.slug, sandbox.env, dir),
    dir,
    files,
    ...(envFile ? { envFile, envKeys } : {}),
    ...(pass?.length ? { pass: [...pass] } : {}),
  };
}

/** `compose --ansi never -p <name> --project-directory <dir> -f <file>… [--env-file <file>]`: the start of every compose call. */
export function composeArgs(ref: ComposeProjectRef): string[] {
  return ['compose', '--ansi', 'never', '-p', ref.name, '--project-directory', ref.dir, ...ref.files.flatMap((f) => ['-f', f]), ...(ref.envFile ? ['--env-file', ref.envFile] : [])];
}

/** A port a compose service publishes on the host. */
export interface PublishedPort {
  service: string;
  port: number;
  /** "" (every interface), "127.0.0.1"… */
  host: string;
}

export interface ComposeConfig {
  /** The services of the compose files (active profiles only). */
  services: string[];
  ports: PublishedPort[];
  /** service → its image (`image:`, else the name a build gives it: `<project>-<service>`). */
  images: Record<string, string>;
}

/** `docker compose config --format json` → services, published TCP ports (ranges expanded), images. */
export function parseComposeConfig(text: string, projectName: string): ComposeConfig {
  const doc = JSON.parse(text) as { services?: Record<string, { image?: string; ports?: Array<{ published?: string | number; host_ip?: string; protocol?: string }> }> };
  const services = Object.keys(doc.services ?? {});
  const ports: PublishedPort[] = [];
  const images: Record<string, string> = {};
  for (const [service, svc] of Object.entries(doc.services ?? {})) {
    images[service] = svc.image ?? `${projectName}-${service}`;
    for (const p of svc.ports ?? []) {
      if ((p.protocol ?? 'tcp') !== 'tcp' || p.published === undefined || p.published === '') continue;
      const m = /^(\d+)(?:-(\d+))?$/.exec(String(p.published));
      if (!m) continue;
      const from = Number(m[1]);
      const to = Number(m[2] ?? m[1]);
      for (let port = from; port <= to && port - from < 1000; port++) ports.push({ service, port, host: p.host_ip ?? '' });
    }
  }
  return { services, ports, images };
}

/** A container `docker ps --filter publish=<port>` lists: its compose project and folder, the TCP ports it publishes. */
export interface PortContainer {
  name: string;
  /** `com.docker.compose.project` ('' for a container compose did not create). */
  project: string;
  /** `com.docker.compose.project.working_dir` ('' when it has none). */
  dir: string;
  /** Published TCP ports and the host address of each ("0.0.0.0", "::", "127.0.0.1"…). */
  ports: Array<{ port: number; host: string }>;
}

/** `docker ps --format '{{json .}}'` output → the containers, their compose project and folder, their published TCP ports. */
export function parseDockerPs(text: string): PortContainer[] {
  const out: PortContainer[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const r = JSON.parse(line) as Record<string, unknown>;
    const labels = parseLabels(r.Labels);
    const ports: PortContainer['ports'] = [];
    // "0.0.0.0:5432->5432/tcp, [::]:5432->5432/tcp, 127.0.0.1:9000-9001->9000-9001/tcp, 1110/tcp"
    for (const part of String(r.Ports ?? '').split(',')) {
      const m = /^(?:(\[[^\]]*\]|[^\s[\]]+):)?(\d+)(?:-(\d+))?->\d+(?:-\d+)?\/tcp$/.exec(part.trim());
      if (!m) continue;
      const from = Number(m[2]);
      const to = Number(m[3] ?? m[2]);
      for (let port = from; port <= to && port - from < 1000; port++) ports.push({ port, host: (m[1] ?? '').replace(/^\[|\]$/g, '') });
    }
    out.push({
      name: String(r.Names ?? r.Name ?? r.ID ?? '?'),
      project: labels['com.docker.compose.project'] ?? '',
      dir: labels['com.docker.compose.project.working_dir'] ?? '',
      ports,
    });
  }
  return out;
}

/**
 * Where to connect to a port Docker publishes on these host addresses: 127.0.0.1 for 0.0.0.0 (or none), ::1 for ::, the
 * address itself otherwise — IPv4 first. Undefined when there is none. `localhost` is never used: another container may
 * publish the same port on [::1] or [::] (OrbStack allows it), and Node tries ::1 first.
 */
export function connectAddress(hosts: readonly string[]): string | undefined {
  const mapped = hosts.map((h) => (h === '' || h === '0.0.0.0' ? '127.0.0.1' : h === '::' ? '::1' : h));
  return mapped.find((h) => !h.includes(':')) ?? mapped[0];
}

/** One container of `docker compose ps --all --format json`. */
export interface PsEntry {
  service: string;
  name: string;
  id: string;
  /** running, exited, created, restarting, paused, dead… */
  state: string;
  /** healthy, unhealthy, starting, or "" (no healthcheck). */
  health: string;
  exitCode: number;
  /** "Up 5 minutes (healthy)". */
  status: string;
  publishers: Array<{ port: number; target: number; host: string; protocol: string }>;
  labels: Record<string, string>;
}

/**
 * Docker's `Labels` text ("k=v,k=v") → a map. A value may contain commas (`config_files` lists paths): the text is cut
 * only before a comma followed by `key=`.
 */
export function parseLabels(text: unknown): Record<string, string> {
  if (text && typeof text === 'object') return { ...(text as Record<string, string>) };
  if (typeof text !== 'string' || !text) return {};
  const out: Record<string, string> = {};
  for (const part of text.split(/,(?=[A-Za-z0-9][A-Za-z0-9._-]*=)/)) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i)] = part.slice(i + 1);
  }
  return out;
}

/** `ps --format json` output: one JSON object per line (Compose 2.21+) or one JSON array (before). One-off containers left out. */
export function parsePs(text: string): PsEntry[] {
  const t = text.trim();
  if (!t) return [];
  let rows: Array<Record<string, unknown>>;
  if (t.startsWith('[')) rows = JSON.parse(t) as Array<Record<string, unknown>>;
  else rows = t.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as Record<string, unknown>);
  const out: PsEntry[] = [];
  for (const r of rows) {
    const labels = parseLabels(r.Labels);
    if (labels['com.docker.compose.oneoff'] === 'True') continue;
    const pubs = Array.isArray(r.Publishers) ? (r.Publishers as Array<Record<string, unknown>>) : [];
    out.push({
      service: String(r.Service ?? labels['com.docker.compose.service'] ?? ''),
      name: String(r.Name ?? r.Names ?? ''),
      id: String(r.ID ?? ''),
      state: String(r.State ?? '').toLowerCase(),
      health: String(r.Health ?? '').toLowerCase(),
      exitCode: Number(r.ExitCode ?? 0),
      status: String(r.Status ?? ''),
      publishers: pubs
        .filter((p) => Number(p.PublishedPort) > 0)
        .map((p) => ({ port: Number(p.PublishedPort), target: Number(p.TargetPort), host: String(p.URL ?? ''), protocol: String(p.Protocol ?? 'tcp') })),
      labels,
    });
  }
  return out;
}

/** What is wrong with one container: null when it runs and is healthy (or has no healthcheck). */
export function containerProblem(e: PsEntry): string | null {
  if (e.state !== 'running') return `${e.state || 'not running'}${e.state === 'exited' || e.state === 'dead' ? ` (exit code ${e.exitCode})` : ''}`;
  if (e.health === 'starting') return 'running, health starting (not healthy yet)';
  if (e.health === 'unhealthy') return 'running, unhealthy';
  return null;
}

/** The services among `expected` that are not running and healthy, with why (every container of a scaled service counts). */
export function serviceProblems(expected: readonly string[], ps: readonly PsEntry[]): Array<{ service: string; problem: string }> {
  const out: Array<{ service: string; problem: string }> = [];
  for (const service of expected) {
    const mine = ps.filter((e) => e.service === service);
    if (!mine.length) {
      out.push({ service, problem: 'no container' });
      continue;
    }
    const bad = mine.map(containerProblem).find((p) => p !== null);
    if (bad) out.push({ service, problem: bad });
  }
  return out;
}

/**
 * Listeners of the published ports that are not the container runtime: a program named like one (DOCKER_HELPER), or,
 * when none is, the one program listening on every published port. Others share a port with the sandbox.
 */
export function foreignListeners(ports: readonly number[], ls: readonly Listener[]): Array<{ port: number; by: Listener[] }> {
  const on = ls.filter((l) => ports.includes(l.port));
  const named = on.some((l) => DOCKER_HELPER.test(l.command));
  const pids = [...new Set(on.map((l) => l.pid))];
  const everywhere = pids.filter((pid) => ports.every((p) => !on.some((l) => l.port === p) || on.some((l) => l.port === p && l.pid === pid)));
  const helper = (l: Listener) => DOCKER_HELPER.test(l.command) || (!named && everywhere.length === 1 && everywhere[0] === l.pid);
  const out: Array<{ port: number; by: Listener[] }> = [];
  for (const port of ports) {
    const by = on.filter((l) => l.port === port && !helper(l));
    if (by.length) out.push({ port, by });
  }
  return out;
}

/** Seconds `up --wait` waits: the longest `health.timeout_s` the manifest's services give, else 120. */
export function waitTimeoutS(sandbox: Pick<LoadedSandbox, 'manifest'>): number {
  const given = Object.values(sandbox.manifest.services)
    .map((svc) => (svc.health && typeof svc.health === 'object' ? svc.health.timeout_s : undefined))
    .filter((t): t is number => t !== undefined);
  return given.length ? Math.max(...given) : COMPOSE_HEALTH_TIMEOUT_S;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function indent(text: string, by = '    '): string {
  return text
    .replace(/\n+$/, '')
    .split('\n')
    .map((l) => `${by}${l}`)
    .join('\n');
}

export interface ComposeProviderOptions {
  /** What the work runs under (core WorkPolicy): docker is checked against its agent policy and gets its environment. */
  policy: WorkPolicy;
  /** The docker binary (default findDocker(): $RETAKE_DOCKER, PATH, the usual install places). */
  docker?: string;
  /** How docker is run (default runDocker; tests pass a fake). */
  exec?: DockerExec;
  /** Who listens on ports (default lsof). */
  listeners?: (ports: readonly number[]) => Promise<Listener[] | null>;
}

export class ComposeProvider implements Provider {
  readonly kind = 'docker-compose' as const;
  private readonly bin: string | null;
  /** How a refusal names the binary (`$RETAKE_DOCKER` when it came from there). */
  private readonly binWhat: string;
  private readonly policy: WorkPolicy;
  private readonly run: DockerExec;
  private readonly listen: (ports: readonly number[]) => Promise<Listener[] | null>;
  private ready: Promise<DockerInfo> | null = null;
  /** Services this instance started (this call): stopped when the call fails or is interrupted. */
  private started: string[] = [];
  /** The `docker compose` process running now (a second Ctrl-C kills it). */
  private child: ChildProcess | null = null;
  private lastRef: ComposeProjectRef | null = null;
  /** The exec seed step running now (a second Ctrl-C stops its processes in the container). */
  private running: { ref: ComposeProjectRef; service: string; token: string } | null = null;
  /** The compose files' services (an exec step may name them as hosts), read once per instance. */
  private composeServices: string[] | undefined;
  /** port → the address Docker publishes it on, for the sandbox's own running containers (remember()). */
  private readonly addresses = new Map<number, string>();

  constructor(opts: ComposeProviderOptions) {
    this.policy = opts.policy;
    this.bin = opts.docker ?? (opts.exec ? 'docker' : findDocker());
    this.binWhat = opts.docker === undefined && process.env.RETAKE_DOCKER ? '$RETAKE_DOCKER' : 'docker';
    this.run =
      opts.exec ??
      ((args, o) => {
        const bin = this.program();
        return bin ? runDocker(bin, args, { ...o, policy: this.policy }) : Promise.resolve({ code: null, stdout: '', stderr: '', ms: 0, error: 'not found' });
      });
    this.listen = opts.listeners ?? listeners;
  }

  /**
   * The docker binary to start: under the agent policy (core policyProgram: a job of the Studio, the desktop app or an
   * MCP client) by the real path that was checked, and refused (SandboxError) when it is a relative path or lies inside
   * the workspace — `$RETAKE_DOCKER` and the PATH's docker alike. Null when there is none.
   */
  private program(): string | null {
    if (!this.bin) return null;
    const checked = policyProgram(this.policy, this.bin, this.binWhat, programLookup());
    if (checked.problem) throw new SandboxError(`docker-compose sandboxes: ${checked.problem}`);
    return checked.program;
  }

  /** The compose project of this sandbox. */
  ref(ctx: Pick<ProviderContext, 'project' | 'sandbox'>): ComposeProjectRef {
    this.lastRef = composeProject(ctx.project, ctx.sandbox);
    return this.lastRef;
  }

  private where(ctx: ProviderContext): string {
    return `sandbox ${ctx.sandbox.env}`;
  }

  /** Docker found, Compose recent enough, the daemon running (checked once per instance). */
  async docker(ctx: ProviderContext): Promise<DockerInfo> {
    if (!this.bin) {
      throw new SandboxError(`${this.where(ctx)}: docker-compose sandboxes need Docker with Compose v2.17 or later: \`docker\` was not found (install Docker Desktop or OrbStack, or set RETAKE_DOCKER)`);
    }
    try {
      this.ready ??= dockerReady(this.run, this.program() ?? this.bin, ctx.signal);
      return await this.ready;
    } catch (e) {
      this.ready = null;
      if (e instanceof SandboxError) throw new SandboxError(`${this.where(ctx)}: ${e.message}`, e.code);
      throw e;
    }
  }

  /** A compose command of this project. */
  private compose(ref: ComposeProjectRef, args: string[], opts: DockerRunOptions = {}): Promise<DockerResult> {
    return this.run([...composeArgs(ref), ...args], {
      ...opts,
      ...(ref.envKeys?.length ? { unset: ref.envKeys } : {}),
      ...(ref.pass?.length ? { pass: ref.pass } : {}),
      onSpawn: (c) => {
        this.child = c;
        opts.onSpawn?.(c);
      },
    }).finally(() => {
      this.child = null;
    });
  }

  /** The compose files as docker reads them. Throws SandboxError when docker refuses them. */
  async config(ctx: ProviderContext, ref: ComposeProjectRef = this.ref(ctx)): Promise<ComposeConfig> {
    const r = await this.compose(ref, ['config', '--format', 'json'], { timeoutMs: 30_000, signal: ctx.signal });
    if (r.aborted) throw interrupted(this.where(ctx));
    if (r.code !== 0) throw new SandboxError(`${this.where(ctx)}: docker compose cannot read ${ref.files.map((f) => shownPath(f)).join(', ')}: ${firstErrorLine(r)}`);
    try {
      return parseComposeConfig(r.stdout, ref.name);
    } catch (e) {
      throw new SandboxError(`${this.where(ctx)}: unexpected output of docker compose config: ${errorMessage(e)}`);
    }
  }

  /**
   * The project's containers (stopped ones too). Every command reads them first: containers of this project name made
   * from another folder (another checkout sharing a `compose.project`) refuse it — never read, reset or touched.
   */
  async ps(ctx: ProviderContext, ref: ComposeProjectRef = this.ref(ctx)): Promise<PsEntry[]> {
    const r = await this.compose(ref, ['ps', '--all', '--format', 'json'], { timeoutMs: 30_000, signal: ctx.signal });
    if (r.aborted) throw interrupted(this.where(ctx));
    if (r.code !== 0) throw new SandboxError(`${this.where(ctx)}: docker compose ps failed: ${firstErrorLine(r)}`);
    let ps: PsEntry[];
    try {
      ps = parsePs(r.stdout);
    } catch (e) {
      throw new SandboxError(`${this.where(ctx)}: unexpected output of docker compose ps: ${errorMessage(e)}`);
    }
    this.checkOwnFolder(ctx, ref, ps);
    return ps;
  }

  /** Containers of this project name made from another folder (another checkout): refused, never touched. */
  private checkOwnFolder(ctx: ProviderContext, ref: ComposeProjectRef, ps: readonly PsEntry[]): void {
    for (const e of ps) {
      const wd = e.labels['com.docker.compose.project.working_dir'];
      if (wd && realDir(wd) !== ref.dir) {
        throw new SandboxError(
          `${this.where(ctx)}: compose project ${ref.name} belongs to another folder (${wd}): give this sandbox its own name (compose.project in ${shownPath(ctx.sandbox.file)}), or remove the other one (docker compose -p ${ref.name} down, from that folder)`,
        );
      }
    }
  }

  /** Is this container one of the sandbox's own: its compose project, made from its folder? */
  private ownContainer(ref: ComposeProjectRef, project: string, dir: string | undefined): boolean {
    return project === ref.name && !!dir && realDir(dir) === ref.dir;
  }

  /** The compose projects an earlier up of this sandbox used under another name (compose.project changed since). */
  private previousRefs(ctx: ProviderContext, ref: ComposeProjectRef): ComposeProjectRef[] {
    const rec = composeRecord(ctx.state);
    const out: ComposeProjectRef[] = [];
    const add = (project: string, dir: string) => {
      if (project !== ref.name && !out.some((p) => p.name === project)) out.push({ name: project, dir: dir ? realDir(dir) : ref.dir, files: [] });
    };
    for (const p of rec?.previous ?? []) add(p.project, p.dir);
    if (rec) add(rec.project, rec.dir);
    return out;
  }

  /** "retake sandbox down <project> [--env <env>]": the command that takes this sandbox down. */
  private downCommand(ctx: ProviderContext): string {
    return `retake sandbox down ${ctx.project.slug}${sandboxNames(ctx.project)[0] === ctx.sandbox.env ? '' : ` --env ${ctx.sandbox.env}`}`;
  }

  /**
   * The containers of other projects publishing these host ports, on any address: OrbStack lets another container
   * publish a port next to the sandbox's 127.0.0.1 (on [::1] or [::]) — lsof then shows the runtime's helper alone, and
   * `localhost` may reach that container. `docker ps --filter publish=<port>` sees them.
   */
  private async otherPublishers(ctx: ProviderContext, ref: ComposeProjectRef, ports: readonly number[]): Promise<Array<{ port: number; by: PortContainer }>> {
    const wanted = [...new Set(ports)];
    if (!wanted.length) return [];
    const r = await this.run(['ps', ...wanted.flatMap((p) => ['--filter', `publish=${p}`]), '--format', '{{json .}}'], { timeoutMs: 30_000, signal: ctx.signal });
    if (r.aborted) throw interrupted(this.where(ctx));
    if (r.code !== 0) throw new SandboxError(`${this.where(ctx)}: docker ps failed: ${firstErrorLine(r)}`);
    let containers: PortContainer[];
    try {
      containers = parseDockerPs(r.stdout);
    } catch (e) {
      throw new SandboxError(`${this.where(ctx)}: unexpected output of docker ps: ${errorMessage(e)}`);
    }
    const out: Array<{ port: number; by: PortContainer }> = [];
    for (const c of containers) {
      if (this.ownContainer(ref, c.project, c.dir)) continue;
      for (const port of wanted) if (c.ports.some((p) => p.port === port)) out.push({ port, by: c });
    }
    return out;
  }

  /** Throws SandboxError port when a container of another project publishes one of these ports (otherPublishers). */
  private async checkOtherPublishers(ctx: ProviderContext, ref: ComposeProjectRef, ports: ReadonlyArray<{ port: number; label: string }>, why: string): Promise<void> {
    const found = await this.otherPublishers(
      ctx,
      ref,
      ports.map((p) => p.port),
    );
    if (!found.length) return;
    const previous = this.previousRefs(ctx, ref).map((p) => p.name);
    const lines = found.map(({ port, by }) => {
      const label = ports.find((p) => p.port === port)?.label ?? `port ${port}`;
      const on = [...new Set(by.ports.filter((p) => p.port === port).map((p) => (p.host.includes(':') ? `[${p.host}]` : p.host || '*')))].join(', ');
      const project = !by.project
        ? ''
        : previous.includes(by.project)
          ? ` of compose project ${by.project} — the name an earlier up of this sandbox used (compose.project changed since): ${this.downCommand(ctx)} takes it down`
          : ` of compose project ${by.project}`;
      return `${label} is also published by container ${by.name}${project} (on ${on})`;
    });
    throw new SandboxError(`${this.where(ctx)}: ${lines.join('; ')} — ${why}: stop it or change the port in ${filesText(ref)}`, 'port');
  }

  /** Every port of the manifest's services (url, pages, health) must be one the compose files publish. */
  private checkDeclaredPorts(ctx: ProviderContext, cfg: ComposeConfig): void {
    const published = new Set(cfg.ports.map((p) => p.port));
    const missing = sandboxPorts(ctx.sandbox.manifest).filter((p) => !published.has(p.port));
    if (!missing.length) return;
    const list = [...published].sort((a, b) => a - b).join(', ') || 'none';
    throw new SandboxError(
      `${this.where(ctx)}: ${missing.map(portLabel).join('; ')} ${missing.length === 1 ? 'is' : 'are'} not published by the compose files (they publish: ${list}) — publish ${missing.length === 1 ? 'it' : 'them'} ("127.0.0.1:<port>:<container port>"), or change the URL in ${shownPath(ctx.sandbox.file)}`,
      'port',
    );
  }

  /** Before up: the published ports not held by this project's running containers must be free. */
  private async checkFree(ctx: ProviderContext, ref: ComposeProjectRef, cfg: ComposeConfig, ps: readonly PsEntry[]): Promise<void> {
    const ours = new Set(ps.filter((e) => e.state === 'running').flatMap((e) => e.publishers.map((p) => p.port)));
    const ports: SandboxPort[] = [];
    for (const p of cfg.ports) {
      if (ours.has(p.port) || ports.some((x) => x.port === p.port)) continue;
      ports.push({ port: p.port, service: p.service, what: ['published'] });
    }
    const busy = await busyPorts(ports);
    if (!busy.length) return;
    const lines = busy.map(({ port, by }) => {
      if (!by) return `${portLabel(port)} is in use by another program (lsof cannot see it: another user's?)`;
      // The container runtime's forwarder: a container of another project publishes it (docker ps shows which).
      if (by.every((l) => DOCKER_HELPER.test(l.command))) return `${portLabel(port)} is published by another container (${describeListeners(by)}; docker ps shows which)`;
      return `${portLabel(port)} is in use by another program (${describeListeners(by)})`;
    });
    throw new SandboxError(`${this.where(ctx)}: ${lines.join('; ')} — stop it or change the port in ${filesText(ref)}`, 'port');
  }

  /** After up: the runtime alone listens on the project's published ports. */
  private async checkOwned(ctx: ProviderContext, ref: ComposeProjectRef, ps: readonly PsEntry[]): Promise<void> {
    const ports = [...new Set(ps.filter((e) => e.state === 'running').flatMap((e) => e.publishers.filter((p) => p.protocol === 'tcp').map((p) => p.port)))];
    if (!ports.length) return;
    const ls = await this.listen(ports);
    if (ls === null) return; // no lsof: the pre-check still ran
    const foreign = foreignListeners(ports, ls);
    if (!foreign.length) return;
    const lines = foreign.map(({ port, by }) => {
      const svc = ps.find((e) => e.publishers.some((p) => p.port === port))?.service ?? '?';
      return `port ${port} (service ${svc}, published) is also used by another program (${describeListeners(by)})`;
    });
    throw new SandboxError(`${this.where(ctx)}: ${lines.join('; ')} — part of the traffic would not reach the sandbox: stop it or change the port in ${filesText(ref)}`, 'port');
  }

  /** The last lines of a service's logs (indented), or ''. */
  private async logTail(ref: ComposeProjectRef, service: string, lines = COMPOSE_LOG_TAIL): Promise<string> {
    const r = await this.compose(ref, ['logs', '--no-color', '--no-log-prefix', '--tail', String(lines), service], { timeoutMs: 20_000 });
    return `${r.stdout}${r.stderr}`.trim();
  }

  /** A message with one service's log tail and where to read more. */
  private async withTail(ctx: ProviderContext, ref: ComposeProjectRef, message: string, service: string): Promise<string> {
    const tail = await this.logTail(ref, service).catch(() => '');
    const more = `(retake sandbox logs ${ctx.project.slug} --env ${ctx.sandbox.env} shows more)`;
    return tail ? `${message}\n— last lines of docker compose logs ${service}:\n${indent(tail)}\n${more}` : `${message} ${more}`;
  }

  private async failure(ctx: ProviderContext, ref: ComposeProjectRef, head: string, problems: Array<{ service: string; problem: string }>): Promise<string> {
    const parts = [`${head}:`, ...problems.map((p) => `  ${p.service}: ${p.problem}`)];
    for (const p of problems.slice(0, 3)) {
      const tail = await this.logTail(ref, p.service).catch(() => '');
      if (tail) parts.push(`— last lines of docker compose logs ${p.service}:\n${indent(tail)}`);
    }
    parts.push(`(retake sandbox logs ${ctx.project.slug} --env ${ctx.sandbox.env} shows more)`);
    return parts.join('\n');
  }

  /**
   * The server of every Postgres database of sandbox.yaml answers `SELECT 1` on it (pg_isready can say ready while init
   * scripts run). A database that does not exist yet (the seed creates it; an interrupted restore dropped it) or allows
   * no connections (an interrupted reset) counts: its server answers, and the reset repairs it.
   */
  private async waitDatabases(ctx: ProviderContext, timeoutS: number): Promise<void> {
    for (const [key, db] of Object.entries(ctx.sandbox.manifest.databases ?? {})) {
      if (!/^postgres(ql)?:/i.test(db.url)) continue;
      const url = await resolveDatabaseUrl(ctx.project, db.url);
      const named = pgEndpoint(url, `${this.where(ctx)}: database ${key}`);
      // A port the project publishes, named by a host name: on the address Docker publishes it on, never `localhost`.
      const address = db.external || isIP(named.host) ? undefined : this.addresses.get(named.port);
      const endpoint = address ? { ...named, host: address } : named;
      const { host, port, database } = endpoint;
      const t0 = Date.now();
      let tries = 0;
      for (;;) {
        if (ctx.signal?.aborted) throw interrupted(`${this.where(ctx)}: database ${key} was not ready yet`);
        tries++;
        const why = await pgAnswers(endpoint);
        if (why === null) break;
        if (Date.now() - t0 >= timeoutS * 1000) {
          throw new SandboxError(`${this.where(ctx)}: database ${key} (${database} on ${host}:${port}) does not answer SELECT 1 after ${timeoutS} s: ${why} (${tries} tries)`, 'unhealthy');
        }
        await sleep(500);
      }
    }
  }

  async up(ctx: ProviderContext, opts: UpOptions = {}): Promise<UpResult> {
    const t0 = Date.now();
    await this.docker(ctx);
    const ref = this.ref(ctx);
    const cfg = await this.config(ctx, ref);
    const before = await this.ps(ctx, ref);
    this.checkDeclaredPorts(ctx, cfg);
    // A name an earlier up used (compose.project changed since) still running: its containers hold the ports and data.
    const previous: ComposeProjectRef[] = [];
    for (const old of this.previousRefs(ctx, ref)) {
      const ps = await this.ps(ctx, old);
      if (ps.some((e) => e.state === 'running')) {
        throw new SandboxError(
          `${this.where(ctx)}: compose project ${old.name} — the name an earlier up of this sandbox used (compose.project changed since) — is still running: ${this.downCommand(ctx)} takes it down (its volumes stay unless --volumes), then up`,
          'port',
        );
      }
      // Kept in the state until its containers and volumes are gone (down removes them).
      if (ps.length || (await this.volumesOf(ctx, old.name)).length) previous.push(old);
    }
    const runningBefore = new Map(before.filter((e) => e.state === 'running').map((e) => [e.service, e.id]));
    const published = cfg.ports.map((p) => ({ port: p.port, label: `port ${p.port} (service ${p.service}, published)` }));
    await this.checkOtherPublishers(ctx, ref, published, 'localhost could reach it instead of the sandbox');
    await this.checkFree(ctx, ref, cfg, before);
    // On disk before anything starts: a crash leaves a project `down` can still find (and the earlier names, until
    // their volumes are gone).
    const record: ComposeRecord = { project: ref.name, dir: ref.dir, ...(previous.length ? { previous: previous.map((p) => ({ project: p.name, dir: p.dir })) } : {}) };
    ctx.state.provider_state = { ...(ctx.state.provider_state ?? {}), compose: record };
    ctx.save();
    this.started = cfg.services.filter((s) => !runningBefore.has(s));
    const timeoutS = waitTimeoutS(ctx.sandbox);
    mkdirSync(ctx.paths.logs, { recursive: true });
    const upLog = join(ctx.paths.logs, 'compose-up.log');
    const args = ['up', '-d', '--wait', '--wait-timeout', String(timeoutS), '--remove-orphans', ...(opts.build ? ['--build'] : [])];
    writeFileSync(upLog, `── ${new Date().toISOString()} · retake sandbox ${ctx.sandbox.env} · docker ${composeArgs(ref).join(' ')} ${args.join(' ')}\n`);
    const r = await this.compose(ref, args, {
      signal: ctx.signal,
      onLine: (line) => {
        appendFileSync(upLog, `${line}\n`);
        ctx.log('debug', line);
      },
    });
    if (r.aborted || ctx.signal?.aborted) throw interrupted(this.where(ctx));
    if (r.error) throw new SandboxError(`${this.where(ctx)}: docker compose up could not be run: ${r.error}`);
    // Not the exit code: `--wait` may exit 0 when it times out.
    const after = await this.ps(ctx, ref);
    const problems = serviceProblems(cfg.services, after);
    if (problems.length) {
      const why = r.code === 0 ? `not every service is running and healthy after ${timeoutS} s` : `docker compose up failed (${firstErrorLine(r)})`;
      throw new SandboxError(await this.failure(ctx, ref, `${this.where(ctx)}: ${why}`, problems), 'unhealthy');
    }
    if (r.code !== 0) throw new SandboxError(`${this.where(ctx)}: docker compose up failed: ${firstErrorLine(r)} (log: ${shownPath(upLog)})`);
    const started = cfg.services.filter((s) => !after.some((e) => e.service === s && e.id === runningBefore.get(s)));
    this.started = started;
    await this.checkOwned(ctx, ref, after);
    // A container of another project started meanwhile next to ours (on [::1] / [::]).
    await this.checkOtherPublishers(ctx, ref, published, 'part of the traffic would reach it, not the sandbox');
    this.remember(after);
    for (const [name, svc] of Object.entries(ctx.sandbox.manifest.services)) {
      try {
        await waitHealthy(pinHealth(serviceHealth(name, svc, COMPOSE_HEALTH_TIMEOUT_S), this.addresses), { signal: ctx.signal });
      } catch (e) {
        if (e instanceof SandboxError && e.code === 'unhealthy') throw new SandboxError(await this.withTail(ctx, ref, `${this.where(ctx)}: ${e.message}`, name), 'unhealthy');
        throw e;
      }
    }
    await this.waitDatabases(ctx, timeoutS);
    return { started, kept: cfg.services.filter((s) => !started.includes(s)), changed: [], ms: Date.now() - t0 };
  }

  async down(ctx: ProviderContext, opts: DownOptions = {}): Promise<DownResult> {
    await this.docker(ctx);
    const ref = this.ref(ctx);
    const before = await this.ps(ctx, ref);
    // The names an earlier up used (compose.project changed since), each from its own folder: taken down too.
    const previous: Array<{ ref: ComposeProjectRef; ps: PsEntry[] }> = [];
    for (const old of this.previousRefs(ctx, ref)) previous.push({ ref: old, ps: await this.ps(ctx, old) });
    const stopped = [...new Set(before.filter((e) => e.state === 'running').map((e) => e.service))];
    const flags = ['--remove-orphans', ...(opts.volumes ? ['--volumes'] : [])];
    const r = await this.compose(ref, ['down', ...flags], { timeoutMs: 180_000, onLine: (l) => ctx.log('debug', l) });
    if (r.code !== 0) throw new SandboxError(`${this.where(ctx)}: docker compose down failed: ${firstErrorLine(r)}`);
    const left: Array<{ project: string; dir: string }> = [];
    for (const { ref: old, ps } of previous) {
      const res = await this.compose(old, ['down', ...flags], { timeoutMs: 180_000, onLine: (l) => ctx.log('debug', l) });
      if (res.code === 0 && ps.length) ctx.log('info', `also took down compose project ${old.name} (the name an earlier up of this sandbox used)`);
      // Forgotten once nothing of it is left; its volumes stay (and so does its name) unless --volumes.
      const volumes = res.code === 0 ? await this.volumesOf(ctx, old.name) : ['?'];
      if (volumes.length) {
        left.push({ project: old.name, dir: old.dir });
        ctx.log('warn', `${this.where(ctx)}: compose project ${old.name} (the name an earlier up of this sandbox used) still has ${res.code === 0 ? `its volumes (${volumes.join(', ')})` : `resources (docker compose down failed: ${firstErrorLine(res)})`}: ${this.downCommand(ctx)} --volumes removes them`);
      }
    }
    const ps = { ...(ctx.state.provider_state ?? {}) };
    delete ps.compose;
    if (left.length) ps.compose = { project: ref.name, dir: ref.dir, previous: left } satisfies ComposeRecord;
    if (opts.volumes) delete ps.snapshot;
    ctx.state.provider_state = ps;
    ctx.save();
    return { stopped, dataGone: !!opts.volumes };
  }

  /** The volumes of a compose project (by its label). */
  private async volumesOf(ctx: ProviderContext, project: string): Promise<string[]> {
    const r = await this.run(['volume', 'ls', '--filter', `label=com.docker.compose.project=${project}`, '--format', '{{.Name}}'], { timeoutMs: 30_000, signal: ctx.signal });
    if (r.aborted) throw interrupted(this.where(ctx));
    if (r.code !== 0) throw new SandboxError(`${this.where(ctx)}: docker volume ls failed: ${firstErrorLine(r)}`);
    return r.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
  }

  async status(ctx: ProviderContext): Promise<ServiceStatus[]> {
    await this.docker(ctx);
    const ref = this.ref(ctx);
    const [cfg, ps] = await Promise.all([this.config(ctx, ref), this.ps(ctx, ref)]);
    this.remember(ps);
    await this.notePrevious(ctx, ref);
    const declared = Object.keys(ctx.sandbox.manifest.services);
    const names = [...declared, ...cfg.services.filter((s) => !declared.includes(s))];
    for (const s of ps) if (!names.includes(s.service)) names.push(s.service);
    const out: ServiceStatus[] = [];
    for (const name of names) {
      const mine = ps.filter((e) => e.service === name);
      const s: ServiceStatus = { name, state: 'stopped', ...(cfg.services.includes(name) ? {} : { orphan: true }) };
      const e = mine.find((x) => x.state === 'running') ?? mine[0];
      if (e) {
        s.container = e.name;
        s.docker = e.status;
      }
      if (e?.state === 'running') {
        s.state = e.health === 'starting' ? 'starting' : 'running';
        const problem = containerProblem(e);
        const svc = ctx.sandbox.manifest.services[name];
        const why = problem ?? (svc ? await healthNow(pinHealth(serviceHealth(name, svc, COMPOSE_HEALTH_TIMEOUT_S), this.addresses)) : null);
        s.health = why ?? 'ok';
        s.healthy = why === null;
      } else if (e) {
        s.note = containerProblem(e) ?? e.state;
      }
      out.push(s);
    }
    return out;
  }

  /** status: a name an earlier up used (compose.project changed since) that still has containers or volumes, as a note. */
  private async notePrevious(ctx: ProviderContext, ref: ComposeProjectRef): Promise<void> {
    for (const old of this.previousRefs(ctx, ref)) {
      const ps = await this.ps(ctx, old);
      const volumes = await this.volumesOf(ctx, old.name);
      if (!ps.length && !volumes.length) continue;
      const what = [ps.length ? `${ps.length} container${ps.length === 1 ? '' : 's'}${ps.some((e) => e.state === 'running') ? ' (running)' : ''}` : '', volumes.length ? `its volumes (${volumes.join(', ')})` : '']
        .filter(Boolean)
        .join(' and ');
      ctx.log('warn', `compose project ${old.name} — the name an earlier up of this sandbox used (compose.project changed since) — still has ${what}: ${this.downCommand(ctx)}${volumes.length ? ' --volumes' : ''} removes them`);
    }
  }

  /** The address Docker publishes each port of these (own, running) containers on: where pg and health checks connect. */
  private remember(ps: readonly PsEntry[]): void {
    const hosts = new Map<number, string[]>();
    for (const e of ps) {
      if (e.state !== 'running') continue;
      for (const p of e.publishers) if (p.protocol === 'tcp') hosts.set(p.port, [...(hosts.get(p.port) ?? []), p.host]);
    }
    for (const [port, h] of hosts) {
      const address = connectAddress(h);
      if (address) this.addresses.set(port, address);
    }
  }

  /** Where to connect to a port the sandbox's own containers publish (127.0.0.1, ::1…), or undefined when none does. */
  async address(ctx: ProviderContext, port: number): Promise<string | undefined> {
    if (!this.addresses.has(port)) {
      await this.docker(ctx);
      this.remember(await this.ps(ctx, this.ref(ctx)));
    }
    return this.addresses.get(port);
  }

  /** Wait until these services run and are healthy again (after a restart). */
  private async waitRunning(ctx: ProviderContext, ref: ComposeProjectRef, services: string[], timeoutS: number): Promise<void> {
    const t0 = Date.now();
    for (;;) {
      if (ctx.signal?.aborted) throw interrupted(this.where(ctx));
      const ps = await this.ps(ctx, ref);
      const problems = serviceProblems(services, ps);
      if (!problems.length) {
        this.remember(ps);
        return;
      }
      if (Date.now() - t0 >= timeoutS * 1000) throw new SandboxError(await this.failure(ctx, ref, `${this.where(ctx)}: not healthy ${timeoutS} s after a restart`, problems), 'unhealthy');
      await sleep(500);
    }
  }

  async restart(ctx: ProviderContext, service: string): Promise<void> {
    await this.docker(ctx);
    const ref = this.ref(ctx);
    await this.ps(ctx, ref);
    const r = await this.compose(ref, ['restart', service], { timeoutMs: 180_000, signal: ctx.signal, onLine: (l) => ctx.log('debug', l) });
    if (r.aborted) throw interrupted(this.where(ctx));
    if (r.code !== 0) throw new SandboxError(`${this.where(ctx)}: docker compose restart ${service} failed: ${firstErrorLine(r)}`);
    await this.waitRunning(ctx, ref, [service], waitTimeoutS(ctx.sandbox));
    const svc = ctx.sandbox.manifest.services[service];
    if (svc) await waitHealthy(pinHealth(serviceHealth(service, svc, COMPOSE_HEALTH_TIMEOUT_S), this.addresses), { signal: ctx.signal });
  }

  /**
   * An `exec` seed step: the command inside a running service (`exec -T`), its output returned and kept in
   * logs/seed.log — secrets masked (the values it resolved, the sandbox's plain passwords). The hosts it names are
   * checked first, like a shell hook's (checkExecHosts). Every process it starts in the container carries
   * RETAKE_EXEC=<token>: an interrupt or a timeout stops them there too (killExec), not only the docker client.
   */
  async exec(ctx: ProviderContext, step: ExecStepSpec): Promise<string> {
    await this.docker(ctx);
    const ref = this.ref(ctx);
    const values = { command: step.command, env: step.env ?? {} };
    const { resolver } = await prefetchSecrets(values);
    const resolved: string[] = [];
    const secrets = (key: string) => {
      const v = resolver(key);
      if (v !== undefined) resolved.push(v);
      return v;
    };
    const pages = resolveEnvironment(ctx.project, ctx.sandbox.env).pages;
    const { command, env } = interpolateDeep(values, { pages, vars: ctx.project.config.vars ?? {}, secrets });
    const mask = masker([...resolved, ...sandboxSecrets(ctx.sandbox)]);
    if (!this.composeServices) {
      await this.ps(ctx, ref); // the project's folder (never a step in another checkout's container)
      this.composeServices = (await this.config(ctx, ref)).services;
    }
    checkExecHosts(ctx, typeof command === 'string' ? command : command.join(' '), env, this.composeServices);
    const argv = typeof command === 'string' ? ['sh', '-c', command] : command;
    const token = randomBytes(8).toString('hex');
    // Values travel in docker's own environment (-e NAME), never on its command line.
    const args = ['exec', '-T', '-e', EXEC_MARK, ...Object.keys(env).flatMap((k) => ['-e', k]), step.service, ...argv];
    const timeoutS = step.timeout_s ?? EXEC_TIMEOUT_S;
    mkdirSync(ctx.paths.logs, { recursive: true });
    const seedLog = join(ctx.paths.logs, 'seed.log');
    const shown = typeof step.command === 'string' ? step.command : step.command.join(' ');
    appendFileSync(seedLog, `── ${new Date().toISOString()} · exec in ${step.service}: ${mask(shown)}\n`);
    this.running = { ref, service: step.service, token };
    let r: DockerResult;
    try {
      r = await this.compose(ref, args, {
        timeoutMs: timeoutS * 1000,
        signal: ctx.signal,
        env: { ...env, [EXEC_MARK]: token },
        onLine: (l) => {
          appendFileSync(seedLog, `${mask(l)}\n`);
          ctx.log('debug', `${step.service}: ${mask(l)}`);
        },
      });
      if (r.aborted || r.timedOut) {
        const left = await this.killExec(ref, step.service, token, 'TERM');
        if (left) ctx.log('warn', `${this.where(ctx)}: ${left}`);
      }
    } finally {
      this.running = null;
    }
    const output = mask(`${r.stdout}${r.stderr}`);
    if (r.aborted) throw interrupted(`exec in ${step.service}`);
    if (r.timedOut) throw new Error(`did not finish within ${timeoutS} s (timeout_s): stopped`);
    if (r.error) throw new Error(`docker could not be run: ${r.error}`);
    if (r.code !== 0) {
      const tail = output.trim().split('\n').slice(-20).join('\n');
      throw new Error(`exited with code ${r.code}${tail ? ` — last lines:\n${indent(tail)}` : ''}`);
    }
    return output;
  }

  /**
   * Stop, inside the service's container, every process an exec step started (they carry its token): SIGTERM, up to
   * 3 s, then SIGKILL (`KILL`: SIGKILL at once). A container without sh / /proc cannot be reached: null on success,
   * else what is left to do.
   */
  private async killExec(ref: ComposeProjectRef, service: string, token: string, how: 'TERM' | 'KILL'): Promise<string | null> {
    const r = await this.compose(ref, ['exec', '-T', service, 'sh', '-c', KILL_EXEC_SCRIPT, 'sh', token, how], { timeoutMs: 20_000 });
    return r.code === 0 ? null : `the exec step's processes could not be stopped inside service ${service} (${firstErrorLine(r)}): docker compose -p ${ref.name} restart ${service} stops them`;
  }

  async stopStarted(ctx: ProviderContext): Promise<string[]> {
    const names = this.started;
    this.started = [];
    if (!names.length) return [];
    const ref = this.lastRef ?? this.ref(ctx);
    await this.compose(ref, ['stop', ...names], { timeoutMs: 120_000 }).catch(() => undefined);
    return names;
  }

  killStartedSync(ctx: ProviderContext): void {
    try {
      this.child?.kill('SIGKILL');
    } catch {
      /* gone */
    }
    // An exec step running in a container: its processes there too (the docker client alone would leave them).
    const exec = this.running;
    this.running = null;
    const bin = this.bin ? policyProgram(this.policy, this.bin, this.binWhat, programLookup()) : null;
    if (exec && bin && !bin.problem) {
      spawnSync(bin.program, [...composeArgs(exec.ref), 'exec', '-T', exec.service, 'sh', '-c', KILL_EXEC_SCRIPT, 'sh', exec.token, 'KILL'], { env: dockerEnv(this.policy, process.env, exec.ref.envKeys, exec.ref.pass), timeout: 10_000, stdio: 'ignore' });
    }
    const names = this.started;
    this.started = [];
    if (!names.length || !bin || bin.problem) return;
    const ref = this.lastRef ?? this.ref(ctx);
    spawnSync(bin.program, [...composeArgs(ref), 'kill', ...names], { env: dockerEnv(this.policy, process.env, ref.envKeys, ref.pass), timeout: 10_000, stdio: 'ignore' });
  }

  /** Docker keeps the logs: no files (logs() reads them through docker compose logs). */
  logFiles(): ServiceLogFile[] {
    return [];
  }

  async logs(ctx: ProviderContext, opts: { service?: string; lines: number }): Promise<ProviderLogs[]> {
    await this.docker(ctx);
    const ref = this.ref(ctx);
    await this.ps(ctx, ref);
    const cfg = await this.config(ctx, ref);
    const declared = Object.keys(ctx.sandbox.manifest.services);
    const names = [...declared, ...cfg.services.filter((s) => !declared.includes(s))];
    if (opts.service !== undefined && !names.includes(opts.service)) {
      throw new SandboxError(`unknown service "${opts.service}" (sandbox ${ctx.sandbox.env}: ${names.join(', ')})`);
    }
    const out: ProviderLogs[] = [];
    for (const service of opts.service === undefined ? names : [opts.service]) {
      const r = await this.compose(ref, ['logs', '--no-color', '--no-log-prefix', '--tail', String(opts.lines), service], { timeoutMs: 30_000 });
      out.push({ service, source: `docker compose -p ${ref.name} logs ${service}`, text: `${r.stdout}${r.stderr}`.replace(/\n+$/, '') });
    }
    return out;
  }

  /** `docker compose logs --follow` until the signal aborts, each line written as it comes. */
  async followLogs(ctx: ProviderContext, opts: { service?: string; lines: number; signal: AbortSignal; write: (line: string) => void }): Promise<void> {
    await this.docker(ctx);
    const ref = this.ref(ctx);
    await this.ps(ctx, ref);
    if (opts.service !== undefined) {
      const cfg = await this.config(ctx, ref);
      if (!cfg.services.includes(opts.service)) throw new SandboxError(`unknown service "${opts.service}" (sandbox ${ctx.sandbox.env}: ${cfg.services.join(', ')})`);
    }
    await this.compose(ref, ['logs', '--follow', '--no-color', '--tail', String(opts.lines), ...(opts.service ? [opts.service] : [])], { signal: opts.signal, onLine: opts.write });
  }

  /**
   * The compose service publishing this host port (a snapshot's database by default; `use` names another: the
   * mailbox, a seed's database): a running service of the sandbox's own project, made from its folder, and no other
   * program listening on it nor another container publishing it (on [::1] / [::]: `docker ps --filter publish`).
   * Throws SandboxError otherwise.
   */
  async publishedBy(ctx: ProviderContext, port: number, use: OwnerUse = SNAPSHOT_USE): Promise<string> {
    await this.docker(ctx);
    const ref = this.ref(ctx);
    const ps = await this.ps(ctx, ref);
    const e = ps.find((x) => x.state === 'running' && x.publishers.some((p) => p.port === port && p.protocol === 'tcp'));
    if (!e) {
      throw new SandboxError(`${this.where(ctx)}: port ${port} (${use.what}) is not published by a running service of compose project ${ref.name} — ${use.why}`);
    }
    const wd = e.labels['com.docker.compose.project.working_dir'];
    if (!this.ownContainer(ref, ref.name, wd)) {
      throw new SandboxError(`${this.where(ctx)}: port ${port} (${use.what}) is published by container ${e.name}, which was not made from this sandbox's folder (${wd || 'no folder label'}) — ${use.why}`, 'port');
    }
    const ls = await this.listen([port]);
    const foreign = ls ? foreignListeners([port], ls) : [];
    if (foreign.length) {
      throw new SandboxError(`${this.where(ctx)}: port ${port} (${use.what}) is also used by another program (${describeListeners(foreign[0].by)}) — ${use.why}`, 'port');
    }
    await this.checkOtherPublishers(ctx, ref, [{ port, label: `port ${port} (${use.what})` }], 'localhost could reach it instead of the sandbox');
    this.remember(ps);
    return e.service;
  }

  /** What a reset empties or a seed rewrites must be published by the project (publishedBy). */
  servedBy(ctx: ProviderContext, port: number, use: OwnerUse): Promise<string> {
    return this.publishedBy(ctx, port, use);
  }

  /**
   * The image of every service (`service=<image id>`, or `missing`): part of the seed hash, so a rebuilt app (new
   * migrations) makes the snapshot stale.
   */
  async hashInputs(ctx: ProviderContext): Promise<string[]> {
    await this.docker(ctx);
    const cfg = await this.config(ctx);
    const names = [...new Set(Object.values(cfg.images))];
    const ids = new Map<string, string>();
    const all = await this.run(['image', 'inspect', '--format', '{{.Id}}', ...names], { timeoutMs: 30_000 });
    const lines = all.stdout.trim().split('\n').filter(Boolean);
    if (all.code === 0 && lines.length === names.length) names.forEach((n, i) => ids.set(n, lines[i].trim()));
    else {
      for (const n of names) {
        const one = await this.run(['image', 'inspect', '--format', '{{.Id}}', n], { timeoutMs: 30_000 });
        if (one.code === 0 && one.stdout.trim()) ids.set(n, one.stdout.trim());
      }
    }
    const out = cfg.services.map((s) => `image ${s}=${ids.get(cfg.images[s]) ?? 'missing'}`).sort();
    // The env file's settings (L5.8): another value there is another product.
    const ref = this.ref(ctx);
    if (ref.envFile) {
      try {
        out.push(`env-file ${createHash('sha256').update(readFileSync(ref.envFile)).digest('hex')}`);
      } catch {
        out.push('env-file missing');
      }
    }
    return out;
  }
}

/** publishedBy's default: the snapshot's database. */
const SNAPSHOT_USE: OwnerUse = {
  what: "the snapshot's database",
  why: "a snapshot reset drops and recreates that database, so it must be the sandbox's own: publish the database's port in the compose file, or use strategy reseed",
};

/** "compose.yaml" (the project's compose files), for messages. */
function filesText(ref: ComposeProjectRef): string {
  return ref.files.map((f) => shownPath(f)).join(', ');
}
