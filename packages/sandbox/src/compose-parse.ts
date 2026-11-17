/** What docker and docker compose print, read: the compose config, `ps`, labels, published ports, and what is wrong with them. */
import type { LoadedSandbox } from '@retake/core/sandbox';
import type { Listener } from './ports.js';

/** A line of `docker compose up --build` that says the build is over: it creates or starts something. */
export const STARTING_LINE = /^\s*(?:[\u2714\u2800-\u28ff]\s*)?(?:Network|Volume|Container)\s+\S+\s+(?:Creat|Recreat|Start|Running|Waiting|Healthy)/;
/** Default seconds a compose service has to become healthy (`--wait-timeout`, then the manifest's checks). */
export const COMPOSE_HEALTH_TIMEOUT_S = 120;
/** Lines of a failing service's `docker compose logs` quoted in an error. */
export const COMPOSE_LOG_TAIL = 30;
/** Program names of the container runtimes' port forwarders (OrbStack Helper, com.docker.backend, vpnkit…). */
export const DOCKER_HELPER = /orbstack|docker|vpnkit|rootlesskit|slirp4netns|limactl|colima|gvproxy|podman/i;

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
  /** service → the services it depends on (`depends_on`, list or map form). */
  depends: Record<string, string[]>;
  /**
   * service → the ids of the build secrets its `build.secrets` mounts, for the services with a `build:` (an empty
   * list when it mounts none).
   */
  builds: Record<string, string[]>;
  /** service → its `pull_policy` when it has one (`build`: built at every up, the image present or not). */
  pulls: Record<string, string>;
  /** service → the ids of the secrets mounted in its running container (its own `secrets:`), for the services with some. */
  runtimeSecrets: Record<string, string[]>;
  /** secret id → the variable it is read from (top-level `secrets.<id>.environment`); file secrets are not listed. */
  secretEnv: Record<string, string>;
}

/** `docker compose config --format json` → services, published TCP ports (ranges expanded), images. */
export function parseComposeConfig(text: string, projectName: string): ComposeConfig {
  const doc = JSON.parse(text) as {
    services?: Record<
      string,
      {
        image?: string;
        pull_policy?: string;
        secrets?: Array<string | { source?: string }>;
        build?: { secrets?: Array<string | { source?: string }> };
        depends_on?: string[] | Record<string, unknown>;
        ports?: Array<{ published?: string | number; host_ip?: string; protocol?: string }>;
      }
    >;
    secrets?: Record<string, { environment?: string }>;
  };
  const services = Object.keys(doc.services ?? {});
  const ports: PublishedPort[] = [];
  const images: Record<string, string> = {};
  const depends: Record<string, string[]> = {};
  const builds: Record<string, string[]> = {};
  const secretEnv: Record<string, string> = {};
  const pulls: Record<string, string> = {};
  const runtimeSecrets: Record<string, string[]> = {};
  const ids = (list: unknown): string[] => [
    ...new Set((Array.isArray(list) ? list : []).map((x: string | { source?: string }) => (typeof x === 'string' ? x : x?.source)).filter((x): x is string => typeof x === 'string' && x !== '')),
  ];
  for (const [id, sec] of Object.entries(doc.secrets ?? {})) {
    if (sec && typeof sec.environment === 'string' && sec.environment) secretEnv[id] = sec.environment;
  }
  for (const [service, svc] of Object.entries(doc.services ?? {})) {
    images[service] = svc.image ?? `${projectName}-${service}`;
    if (typeof svc.pull_policy === 'string' && svc.pull_policy) pulls[service] = svc.pull_policy;
    if (svc.build && typeof svc.build === 'object') builds[service] = ids(svc.build.secrets);
    const mounted = ids(svc.secrets);
    if (mounted.length) runtimeSecrets[service] = mounted;
    const on = Array.isArray(svc.depends_on) ? svc.depends_on : svc.depends_on && typeof svc.depends_on === 'object' ? Object.keys(svc.depends_on) : [];
    if (on.length) depends[service] = on.map(String);
    for (const p of svc.ports ?? []) {
      if ((p.protocol ?? 'tcp') !== 'tcp' || p.published === undefined || p.published === '') continue;
      const m = /^(\d+)(?:-(\d+))?$/.exec(String(p.published));
      if (!m) continue;
      const from = Number(m[1]);
      const to = Number(m[2] ?? m[1]);
      for (let port = from; port <= to && port - from < 1000; port++) ports.push({ service, port, host: p.host_ip ?? '' });
    }
  }
  return { services, ports, images, depends, builds, pulls, runtimeSecrets, secretEnv };
}

/** Where a Postgres container keeps its data (dataLocation). */
export type DataLocation = { type: 'bind' | 'volume'; name: string } | { type: 'tmpfs'; dir: string } | { type: 'container'; dir: string };

/** The official image's data folder when the container says none (no PGDATA). */
const DEFAULT_PGDATA = '/var/lib/postgresql/data';

/**
 * Where a database container keeps its data, from `docker inspect <id>` (its JSON array; the volume's compose project
 * read by the caller): what is mounted over its data folder (PGDATA, else the official image's), the deepest mount
 * winning — a volume, a folder of this machine, or a tmpfs (`tmpfs:` of compose, listed in `HostConfig.Tmpfs`, or a
 * `type: tmpfs` mount): in memory, gone with the container. Nothing over a PGDATA the container declares: its own
 * layer, gone when the container is removed (every down). Without PGDATA (a custom image), only a mount under
 * /var/lib/postgresql is read, and nothing there is not known (null).
 */
export function dataLocation(inspectJson: string): DataLocation | null {
  let doc: unknown;
  try {
    doc = JSON.parse(inspectJson);
  } catch {
    return null;
  }
  const c = (Array.isArray(doc) ? doc[0] : doc) as
    | { Mounts?: Array<{ Type?: string; Name?: string; Source?: string; Destination?: string }>; HostConfig?: { Tmpfs?: Record<string, string> | null }; Config?: { Env?: string[] | null } }
    | undefined;
  if (!c || typeof c !== 'object') return null;
  const env = Array.isArray(c.Config?.Env) ? c.Config.Env : [];
  const pgdata =
    env
      .find((e) => typeof e === 'string' && e.startsWith('PGDATA='))
      ?.slice('PGDATA='.length)
      .replace(/\/+$/, '') || null;
  const over: Array<{ dest: string; at: () => DataLocation | null }> = [];
  for (const m of Array.isArray(c.Mounts) ? c.Mounts : []) {
    if (typeof m?.Destination !== 'string') continue;
    const dest = m.Destination.replace(/\/+$/, '') || '/';
    over.push({
      dest,
      at: () =>
        m.Type === 'bind'
          ? { type: 'bind', name: String(m.Source ?? '') }
          : m.Type === 'volume'
            ? { type: 'volume', name: String(m.Name ?? '') }
            : m.Type === 'tmpfs'
              ? { type: 'tmpfs', dir: dest }
              : null,
    });
  }
  const tmpfs = c.HostConfig?.Tmpfs;
  if (tmpfs && typeof tmpfs === 'object') for (const d of Object.keys(tmpfs)) over.push({ dest: d.replace(/\/+$/, '') || '/', at: () => ({ type: 'tmpfs', dir: d }) });
  const covers = (dest: string, dir: string) => dir === dest || dest === '/' || dir.startsWith(`${dest}/`);
  const dir = pgdata ?? DEFAULT_PGDATA;
  // The deepest wins; at the same depth a tmpfs (it hides what is under it).
  const tmpfsFirst = (o: (typeof over)[number]) => (o.at()?.type === 'tmpfs' ? 0 : 1);
  const hit = over.filter((o) => covers(o.dest, dir)).sort((a, b) => b.dest.length - a.dest.length || tmpfsFirst(a) - tmpfsFirst(b))[0];
  if (hit) return hit.at();
  if (pgdata) return { type: 'container', dir: pgdata };
  const under = over.find((o) => /^\/var\/lib\/postgresql(\/|$)/.test(o.dest));
  return under ? under.at() : null;
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
  else
    rows = t
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as Record<string, unknown>);
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

export function indent(text: string, by = '    '): string {
  return text
    .replace(/\n+$/, '')
    .split('\n')
    .map((l) => `${by}${l}`)
    .join('\n');
}
