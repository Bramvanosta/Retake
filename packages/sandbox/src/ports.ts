/**
 * The ports a sandbox's own services listen on, and who listens on a port. A port of a service about to start must be
 * free — any listener refuses the start, named (lsof: program and pid) —; once a service is healthy, every listener of
 * its ports must be one of its processes. A second program on the same port would answer part of the traffic (and the
 * health checks) without anyone noticing: OrbStack, for one, lets a container publish a port another program holds.
 */
import { execFile } from 'node:child_process';
import { connect } from 'node:net';
import type { SandboxManifest } from '@retake/core';

export interface SandboxPort {
  port: number;
  /** The service that serves it. */
  service: string;
  /** What names it: "url", "page console", "health". */
  what: string[];
}

function portOf(url: string): number | null {
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return null;
    return Number(u.port || (u.protocol === 'https:' ? 443 : 80));
  } catch {
    return null;
  }
}

/**
 * The ports the services of a manifest listen on (their `url`, `pages`, health url / tcp), each with the service that
 * declares it first. The mailbox and the databases are not counted: they may be programs the sandbox does not start.
 */
export function sandboxPorts(manifest: SandboxManifest): SandboxPort[] {
  const out = new Map<number, SandboxPort>();
  const add = (port: number | null, service: string, what: string) => {
    if (port === null) return;
    const p = out.get(port) ?? { port, service, what: [] };
    if (p.service === service && !p.what.includes(what)) p.what.push(what);
    out.set(port, p);
  };
  for (const [name, svc] of Object.entries(manifest.services)) {
    if (svc.url) add(portOf(svc.url), name, 'url');
    for (const [key, v] of Object.entries(svc.pages ?? {})) add(portOf(typeof v === 'string' ? v : v.url), name, `page ${key}`);
    const h = svc.health;
    if (typeof h === 'string' && /^https?:\/\//i.test(h)) add(portOf(h), name, 'health');
    else if (h && typeof h === 'object') {
      if (h.url) add(portOf(h.url), name, 'health');
      if (h.tcp !== undefined) add(h.tcp, name, 'health');
    }
  }
  return [...out.values()];
}

/** "port 4501 (service fixture, page console)". */
export function portLabel(p: SandboxPort): string {
  return `port ${p.port} (service ${p.service}${p.what.length ? `, ${p.what.join(', ')}` : ''})`;
}

/** Does something accept a TCP connection on this port, on 127.0.0.1 or ::1? */
export async function probePort(port: number, timeoutMs = 400): Promise<boolean> {
  const one = (host: string) =>
    new Promise<boolean>((resolve) => {
      const s = connect({ host, port });
      const done = (ok: boolean) => {
        s.destroy();
        resolve(ok);
      };
      s.setTimeout(timeoutMs, () => done(false));
      s.once('connect', () => done(true));
      s.once('error', () => done(false));
    });
  const [v4, v6] = await Promise.all([one('127.0.0.1'), one('::1')]);
  return v4 || v6;
}

export interface Listener {
  pid: number;
  pgid: number;
  command: string;
  port: number;
}

/** `lsof -F pgcn` output → the listeners of each port (a process listening on several addresses counts once per port). */
export function parseLsof(text: string): Listener[] {
  const out: Listener[] = [];
  let cur: { pid: number; pgid: number; command: string } | null = null;
  for (const line of text.split('\n')) {
    if (!line) continue;
    const tag = line[0];
    const v = line.slice(1);
    if (tag === 'p') cur = { pid: Number(v), pgid: Number.NaN, command: '' };
    else if (cur && tag === 'g') cur.pgid = Number(v);
    else if (cur && tag === 'c') cur.command = v;
    else if (cur && tag === 'n') {
      const m = /:(\d+)$/.exec(v);
      if (!m) continue;
      const port = Number(m[1]);
      if (!out.some((l) => l.pid === cur!.pid && l.port === port)) out.push({ ...cur, port });
    }
  }
  return out;
}

/**
 * The programs listening on these ports (TCP, any address) — null when lsof is not available. lsof lists the current
 * user's processes; a port held by another user's program shows no listener but still accepts connections (probePort).
 */
export function listeners(ports: readonly number[]): Promise<Listener[] | null> {
  if (!ports.length) return Promise.resolve([]);
  return new Promise((resolve) => {
    execFile('lsof', ['-nP', `-iTCP:${ports.join(',')}`, '-sTCP:LISTEN', '-Fpgcn'], { timeout: 10_000 }, (err, stdout) => {
      if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') return resolve(null);
      // Exit status 1 with no output: nothing listens.
      resolve(parseLsof(String(stdout ?? '')));
    });
  });
}

/** "node, pid 81234" / "node, pid 81234 and python3, pid 81300". */
export function describeListeners(ls: readonly Listener[]): string {
  return ls.map((l) => `${l.command || '?'}, pid ${l.pid}`).join(' and ');
}

/**
 * The ports among `ports` that something listens on, with who (null when lsof cannot tell: another user's program,
 * or no lsof). Empty when all are free.
 */
export async function busyPorts(ports: readonly SandboxPort[]): Promise<Array<{ port: SandboxPort; by: Listener[] | null }>> {
  const found = await listeners(ports.map((p) => p.port));
  const out: Array<{ port: SandboxPort; by: Listener[] | null }> = [];
  for (const p of ports) {
    const by = found?.filter((l) => l.port === p.port) ?? [];
    if (by.length) out.push({ port: p, by });
    else if (await probePort(p.port)) out.push({ port: p, by: null });
  }
  return out;
}
