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
}

/** `docker compose config --format json` → services, published TCP ports (ranges expanded), images. */
export function parseComposeConfig(text: string, projectName: string): ComposeConfig {
  const doc = JSON.parse(text) as {
    services?: Record<string, { image?: string; depends_on?: string[] | Record<string, unknown>; ports?: Array<{ published?: string | number; host_ip?: string; protocol?: string }> }>;
  };
  const services = Object.keys(doc.services ?? {});
  const ports: PublishedPort[] = [];
  const images: Record<string, string> = {};
  const depends: Record<string, string[]> = {};
  for (const [service, svc] of Object.entries(doc.services ?? {})) {
    images[service] = svc.image ?? `${projectName}-${service}`;
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
  return { services, ports, images, depends };
}

/** Where a database container keeps its data, from `docker inspect --format '{{json .Mounts}}'` (the volume's compose project read by the caller). */
export function dataMount(mountsJson: string): { type: 'bind' | 'volume'; name: string } | null {
  let mounts: Array<{ Type?: string; Name?: string; Source?: string; Destination?: string }>;
  try {
    mounts = JSON.parse(mountsJson) as typeof mounts;
  } catch {
    return null;
  }
  if (!Array.isArray(mounts)) return null;
  const m = mounts.find((x) => typeof x.Destination === 'string' && /^\/var\/lib\/postgresql(\/|$)/.test(x.Destination));
  if (!m) return null;
  if (m.Type === 'bind') return { type: 'bind', name: String(m.Source ?? '') };
  if (m.Type === 'volume') return { type: 'volume', name: String(m.Name ?? '') };
  return null;
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

/** What a project archive needs of one compose service (share.ts): its image, its build context, its bind mounts and env files. */
export interface ShareService {
  name: string;
  /** `image:`, else the name a build gives it (`<project>-<service>`). */
  image: string;
  /** Its build context, absolute, when it is built (never copied: the image is saved instead). */
  build?: string;
  /** Its bind mounts: host source (absolute, as compose resolved it) and container target. */
  binds: Array<{ source: string; target: string }>;
  /** Its `env_file`s, absolute. */
  envFiles: string[];
}

/** `docker compose config --format json` → what a project archive needs of it: the services, and the files of its secrets and configs. */
export function parseShareConfig(text: string, projectName: string): { services: ShareService[]; secretFiles: string[]; configFiles: string[] } {
  type Svc = {
    image?: string;
    build?: string | { context?: string };
    volumes?: Array<{ type?: string; source?: string; target?: string }>;
    env_file?: Array<string | { path?: string }>;
  };
  const doc = JSON.parse(text) as { services?: Record<string, Svc>; secrets?: Record<string, { file?: string }>; configs?: Record<string, { file?: string }> };
  const services: ShareService[] = [];
  for (const [name, svc] of Object.entries(doc.services ?? {})) {
    const build = typeof svc.build === 'string' ? svc.build : svc.build?.context;
    const binds = (svc.volumes ?? []).filter((v) => v.type === 'bind' && typeof v.source === 'string').map((v) => ({ source: String(v.source), target: String(v.target ?? '') }));
    const envFiles = (svc.env_file ?? []).map((e) => (typeof e === 'string' ? e : e?.path)).filter((p): p is string => typeof p === 'string' && p !== '');
    services.push({ name, image: svc.image ?? `${projectName}-${name}`, ...(build ? { build } : {}), binds, envFiles });
  }
  const files = (m: Record<string, { file?: string }> | undefined) =>
    Object.values(m ?? {})
      .map((x) => x?.file)
      .filter((f): f is string => typeof f === 'string' && f !== '');
  return { services, secretFiles: files(doc.secrets), configFiles: files(doc.configs) };
}
