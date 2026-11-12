/**
 * The ports a sandbox's own services listen on, and who listens on a port. A port of a service about to start must be
 * free — any listener refuses the start, named (lsof: program and pid) —; once a service is healthy, every listener of
 * its ports must be one of its processes. A second program on the same port would answer part of the traffic (and the
 * health checks) without anyone noticing: OrbStack, for one, lets a container publish a port another program holds.
 */
import type { SandboxManifest } from '@retake/core';
import { listeners, probePort } from '@retake/core/io';
import type { Listener } from '@retake/core/io';

// L7.25: who listens on a port is core's io side (io/listeners.ts); re-exported for this package's modules and users.
export { describeListeners, listeners, parseLsof, probePort } from '@retake/core/io';
export type { Listener } from '@retake/core/io';

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
