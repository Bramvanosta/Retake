/**
 * Health checks of a sandbox's services: the manifest's `health` (an http GET — ok on 200–399, or the statuses it
 * lists, optionally containing a text — or a TCP connect), by default a GET of the service's `url`, none with `false`;
 * plus each page the service serves must answer HTTP (any status: a sign-in redirect is fine) — a page port nobody
 * serves would only show in the take. Errors say which check failed, how, and how often it was tried.
 */
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { LookupFunction } from 'node:net';
import { connect, isIP } from 'node:net';
import { isLoopbackHost } from '@retake/core/environment';
import type { SandboxService } from '@retake/core/model';
import { SandboxError, interrupted } from './errors.js';
import { bestEffort } from '@retake/core/base';

/** Default seconds before a process service counts as not healthy. */
export const PROCESS_HEALTH_TIMEOUT_S = 60;
export const HEALTH_INTERVAL_MS = 250;
/** Each try's own limit. */
export const HEALTH_TRY_MS = 2000;

export type HealthTarget =
  | {
      kind: 'http';
      url: string;
      status?: number[];
      text?: string;
      /** any HTTP answer is fine (page probes) */
      anyStatus?: boolean;
      /** The address to connect to instead of the URL's host name (pinnedRequest): the one Docker publishes the port on. */
      address?: string;
    }
  | { kind: 'tcp'; port: number };

export interface ServiceHealth {
  service: string;
  targets: HealthTarget[];
  timeoutMs: number;
  intervalMs: number;
}

/** A health path on the service's url: always on that origin ("//host/up" or "/\\host" would name another host). */
function join(base: string, path: string): string {
  return new URL(path.replace(/^[/\\]+/, '/'), base).href;
}

/** What "healthy" means for one service (no targets: nothing to wait for). */
export function serviceHealth(name: string, svc: SandboxService, defaultTimeoutS = PROCESS_HEALTH_TIMEOUT_S): ServiceHealth {
  const targets: HealthTarget[] = [];
  const h = svc.health;
  let timeoutS = defaultTimeoutS;
  let intervalMs = HEALTH_INTERVAL_MS;
  if (h === false) {
    // No health check of the service itself; its pages are still probed below.
  } else if (typeof h === 'string') {
    if (/^https?:\/\//i.test(h)) targets.push({ kind: 'http', url: h });
    else if (svc.url) targets.push({ kind: 'http', url: join(svc.url, h) });
  } else if (h && typeof h === 'object') {
    if (h.timeout_s !== undefined) timeoutS = h.timeout_s;
    if (h.interval_ms !== undefined) intervalMs = h.interval_ms;
    const status = h.status === undefined ? undefined : Array.isArray(h.status) ? h.status : [h.status];
    if (h.tcp !== undefined) targets.push({ kind: 'tcp', port: h.tcp });
    else {
      const url = h.url ?? (svc.url ? join(svc.url, h.path ?? '/') : undefined);
      if (url) targets.push({ kind: 'http', url, ...(status ? { status } : {}), ...(h.text !== undefined ? { text: h.text } : {}) });
    }
  } else if (svc.url) {
    targets.push({ kind: 'http', url: svc.url });
  }
  for (const v of Object.values(svc.pages ?? {})) {
    const url = typeof v === 'string' ? v : v.url;
    if (!targets.some((t) => t.kind === 'http' && t.url === url)) targets.push({ kind: 'http', url, anyStatus: true });
  }
  return { service: name, targets, timeoutMs: timeoutS * 1000, intervalMs };
}

/** "GET http://localhost:4501/api/health" / "TCP port 4632". */
export function targetLabel(t: HealthTarget): string {
  return t.kind === 'http' ? `GET ${t.url}${t.address ? ` (on ${t.address})` : ''}` : `TCP port ${t.port}`;
}

function networkReason(e: unknown, ms: number): string {
  const err = e as Error & { cause?: { code?: string; message?: string } };
  if (err.name === 'TimeoutError' || err.name === 'AbortError') return `no answer within ${ms / 1000} s`;
  const code = err.cause?.code ?? (err as NodeJS.ErrnoException).code;
  if (code === 'ECONNREFUSED') return 'connection refused';
  if (code === 'ECONNRESET') return 'connection reset';
  return err.cause?.message ?? code ?? err.message;
}

function tcpOnce(port: number, ms: number): Promise<string | null> {
  const one = (host: string) =>
    new Promise<string | null>((resolve) => {
      const s = connect({ host, port });
      const done = (why: string | null) => {
        s.destroy();
        resolve(why);
      };
      s.setTimeout(ms, () => done(`no answer within ${ms / 1000} s`));
      s.once('connect', () => done(null));
      s.once('error', (e) => done(networkReason(e, ms)));
    });
  return one('127.0.0.1').then((v4) => (v4 === null ? null : one('::1').then((v6) => (v6 === null ? null : v4))));
}

/**
 * The http targets of a health on a loopback host *name* (localhost, *.localhost) whose port has an address in
 * `addresses` (the one Docker publishes it on), pinned to that address: the request keeps its URL (its Host header)
 * but never goes where `localhost` resolves first (::1: another container may publish the same port there).
 */
export function pinHealth(h: ServiceHealth, addresses: ReadonlyMap<number, string>): ServiceHealth {
  const targets = h.targets.map((t) => {
    if (t.kind !== 'http') return t;
    const address = pinnedAddress(t.url, addresses);
    return address ? { ...t, address } : t;
  });
  return { ...h, targets };
}

/** The pinned address of an http(s) URL on a loopback host name, from `addresses` by port; undefined otherwise. */
export function pinnedAddress(url: string, addresses: ReadonlyMap<number, string>): string | undefined {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (!/^https?:$/.test(u.protocol) || isIP(host) || !isLoopbackHost(host)) return undefined;
    return addresses.get(Number(u.port || (u.protocol === 'https:' ? 443 : 80)));
  } catch {
    return undefined;
  }
}

/**
 * An http(s) request to `url` connecting to `address` (the URL's host name is not resolved; the Host header stays the
 * URL's). Answers its status and, when `read`, its body (redirects are not followed). Rejects like fetch does on a
 * network error (`code` ECONNREFUSED…), or with a TimeoutError.
 */
export function pinnedRequest(url: string, opts: { address: string; method?: string; headers?: Record<string, string>; timeoutMs: number; read?: boolean }): Promise<{ status: number; body: string }> {
  const u = new URL(url);
  const family = isIP(opts.address) === 6 ? 6 : 4;
  const lookup: LookupFunction = (_host, o, cb) => {
    if ((o as { all?: boolean }).all) (cb as unknown as (e: null, a: Array<{ address: string; family: number }>) => void)(null, [{ address: opts.address, family }]);
    else cb(null, opts.address, family);
  };
  const send = u.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = send(u, { method: opts.method ?? 'GET', headers: opts.headers, lookup, signal: AbortSignal.timeout(opts.timeoutMs) }, (res) => {
      let body = '';
      if (opts.read) res.setEncoding('utf8').on('data', (d: string) => (body += d));
      else res.resume();
      res.once('end', () => resolve({ status: res.statusCode ?? 0, body }));
      res.once('error', reject);
    });
    req.once('error', (e) => reject(e.name === 'AbortError' ? Object.assign(new Error('timeout'), { name: 'TimeoutError' }) : e));
    req.end();
  });
}

/** One try of a target: null when healthy, else why not ("connection refused", "HTTP 503", "no \"ready\" in the answer"). */
export async function checkOnce(t: HealthTarget, ms = HEALTH_TRY_MS): Promise<string | null> {
  if (t.kind === 'tcp') return tcpOnce(t.port, ms);
  const statusOk = (s: number) => t.anyStatus || (t.status ? t.status.includes(s) : s >= 200 && s < 400);
  let status: number;
  let body = '';
  try {
    if (t.address) {
      const res = await pinnedRequest(t.url, { address: t.address, timeoutMs: ms, read: t.text !== undefined });
      status = res.status;
      body = res.body;
    } else {
      const res = await fetch(t.url, { redirect: 'manual', signal: AbortSignal.timeout(ms) });
      status = res.status;
      if (t.text !== undefined && statusOk(status)) body = await bestEffort(res.text(), 'a body that cannot be read does not contain the expected text', '');
      else await res.body?.cancel().catch(() => undefined);
    }
  } catch (e) {
    return networkReason(e, ms);
  }
  if (!statusOk(status)) return `HTTP ${status}${t.status ? ` (expected ${t.status.join(' or ')})` : ''}`;
  if (t.text === undefined) return null;
  return body.includes(t.text) ? null : `HTTP ${status} without "${t.text}" in the answer`;
}

export interface WaitHealthyOptions {
  signal?: AbortSignal;
  /** Why the service cannot become healthy any more (its process exited), or null. Checked between tries. */
  gone?: () => string | null;
}

/**
 * Wait until every target of a service answers (each one is tried until it does). Throws SandboxError: unhealthy
 * (timeout — the last failure of the first target still failing and the number of tries —, or `gone`), interrupted.
 */
export async function waitHealthy(h: ServiceHealth, opts: WaitHealthyOptions = {}): Promise<{ ms: number; tries: number }> {
  const t0 = Date.now();
  const pending = new Set(h.targets);
  const last = new Map<HealthTarget, string>();
  let tries = 0;
  for (;;) {
    if (opts.signal?.aborted) throw interrupted(`service ${h.service} was not healthy yet`);
    const gone = opts.gone?.();
    if (gone) throw new SandboxError(`service ${h.service} ${gone}`, 'unhealthy');
    tries++;
    for (const t of [...pending]) {
      const why = await checkOnce(t, Math.min(HEALTH_TRY_MS, Math.max(250, h.timeoutMs)));
      if (why === null) pending.delete(t);
      else {
        last.set(t, why);
        break; // in order: the next target once this one answers
      }
    }
    if (!pending.size) return { ms: Date.now() - t0, tries };
    if (Date.now() - t0 >= h.timeoutMs) {
      const t = [...pending][0];
      throw new SandboxError(
        `service ${h.service} is not healthy after ${Math.round(h.timeoutMs / 1000)} s — ${targetLabel(t)}: ${last.get(t) ?? 'no answer'} (${tries} ${tries === 1 ? 'try' : 'tries'})`,
        'unhealthy',
      );
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, h.intervalMs);
      function done() {
        clearTimeout(timer);
        opts.signal?.removeEventListener('abort', done);
        resolve();
      }
      opts.signal?.addEventListener('abort', done, { once: true });
    });
  }
}

/** One pass over a service's targets (status: no waiting): null when all answer, else the first failure. */
export async function healthNow(h: ServiceHealth): Promise<string | null> {
  for (const t of h.targets) {
    const why = await checkOnce(t);
    if (why !== null) return `${targetLabel(t)}: ${why}`;
  }
  return null;
}
