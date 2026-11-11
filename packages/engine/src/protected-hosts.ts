/**
 * Production across projects (L3.1, trust `mcp`). A project's own production / read-only environments are guarded by
 * its runs (core access.ts); through MCP an agent can also create a project (project_create) whose environment points at
 * another project's production hosts, then run read-write hooks and captures on it. So, for work submitted through MCP,
 * the protected hosts are those of the production and read-only environments of EVERY project of the workspace: a new
 * project may not point at them, and a run, hooks or an environment reset on a read-write environment that does is
 * refused (a human runs it from a terminal, where project.yaml is theirs).
 *
 * Hosts are compared as addresses (core canonicalAddress): an IPv4-mapped IPv6 address is its IPv4 form, loopback —
 * `localhost`, `*.localhost`, 127.0.0.0/8, ::1 and the unspecified addresses — is one address, and when one side is an
 * address (loopback included) and the other a name, the name's resolved addresses are compared with it — a name that
 * does not resolve in time counts as a match (failing closed). The names of one check are resolved together, under one
 * deadline (2 s). Residue: two different names that resolve to one address, and an IP literal behind a `*.domain`
 * pattern, are not compared.
 */
import { lookup } from 'node:dns/promises';
import { canonicalAddress, canonicalIp, channelWords, environmentAccess, hostMatches, normalizeAllowEntry, resolveEnvironment } from '@retake/core';
import { listProjects } from '@retake/core/io';
import type { AgentChannel, LoadedProject } from '@retake/core';
import { EngineError } from './errors.js';
import { openProject } from './workspace.js';
import type { OpenedWorkspace } from './workspace.js';

/** A host of a production or read-only environment of a project of the workspace. */
export interface WorkspaceProtectedHost {
  project: string;
  env: string;
  /**
   * Host in canonical form (core canonicalAddress: an IPv4-mapped IPv6 address as its IPv4 form; loopback names and
   * addresses, the unspecified ones included, as `loopback`), or a `read_only.hosts` pattern (`*.example.com`).
   */
  host: string;
  /** A page's port (default ports included); absent for a pattern: any port. */
  port?: string;
  /** Whether `host` is an address: an IP literal, or `loopback` (from a loopback address or name). */
  ip?: boolean;
  production: boolean;
}

/** A protected host a URL points at; `reason` says how when only a name's addresses tell (its resolution). */
export type ProtectedHostHit = WorkspaceProtectedHost & { reason?: string };

/** Loopback hosts, folded into one: names, 127.0.0.0/8, ::1 and the unspecified addresses (which reach this machine). */
const LOOPBACK = /^(?:localhost|.+\.localhost|127(?:\.\d{1,3}){3}|::1|::|0\.0\.0\.0)$/;

const fold = (host: string): string => (LOOPBACK.test(host) ? 'loopback' : host);

/**
 * Host and port of a page URL in canonical form, loopback folded into one — an address, however it was written (a
 * loopback name too); null when it is not an http(s) URL.
 */
function origin(url: string): { host: string; port: string; ip: boolean } | null {
  const a = canonicalAddress(url);
  if (!a) return null;
  const host = fold(a.host);
  return { host, port: a.port, ip: a.ip || host === 'loopback' };
}

/** Resolves a name to its addresses (the system resolver, /etc/hosts included). */
export type HostLookup = (name: string) => Promise<readonly string[]>;

const systemLookup: HostLookup = async (name) => (await lookup(name, { all: true, verbatim: true })).map((a) => a.address);

/** How names are resolved next to an IP literal: the system resolver, at most 2 s a name. */
let resolver: { lookup: HostLookup; timeoutMs: number } = { lookup: systemLookup, timeoutMs: 2000 };

/** Replace the resolver (tests: no real DNS); returns the one it replaced. No argument: the system resolver again. */
export function setProtectedHostResolver(r?: { lookup?: HostLookup; timeoutMs?: number }): { lookup: HostLookup; timeoutMs: number } {
  const before = resolver;
  resolver = { lookup: r?.lookup ?? systemLookup, timeoutMs: r?.timeoutMs ?? 2000 };
  return before;
}

/** A name's addresses (canonical, loopback folded), or null when it does not resolve in time; once per name and check. */
type Lookups = Map<string, Promise<string[] | null>>;

function addressesOf(name: string, lookups: Lookups): Promise<string[] | null> {
  let p = lookups.get(name);
  if (!p) {
    const { lookup: look, timeoutMs } = resolver;
    p = new Promise<string[] | null>((done) => {
      const timer = setTimeout(() => done(null), timeoutMs);
      timer.unref?.();
      look(name).then(
        (list) => {
          clearTimeout(timer);
          done(list.length ? list.map((a) => fold(canonicalIp(a) ?? a)) : null);
        },
        () => {
          clearTimeout(timer);
          done(null);
        },
      );
    });
    lookups.set(name, p);
  }
  return p;
}

/** Whether an environment is protected: production (MCP never passes --allow-writes) or read-only in project.yaml. */
function isProtected(env: Parameters<typeof environmentAccess>[0]): boolean {
  return env.production === true || environmentAccess(env) === 'read-only';
}

/** The protected hosts of every project of the workspace but `except` (a project that does not load protects nothing). */
export async function workspaceProtectedHosts(ws: OpenedWorkspace, except?: string): Promise<WorkspaceProtectedHost[]> {
  const out: WorkspaceProtectedHost[] = [];
  for (const p of await listProjects(ws.root)) {
    if (p.slug === except) continue;
    let project: LoadedProject;
    try {
      project = await openProject(ws, p.dir);
    } catch {
      continue;
    }
    for (const name of Object.keys(project.config.environments ?? {})) {
      const env = resolveEnvironment(project, name);
      if (!isProtected(env)) continue;
      const production = env.production === true;
      for (const url of Object.values(env.pages)) {
        const o = origin(url);
        if (o) out.push({ project: p.slug, env: name, host: o.host, port: o.port, ip: o.ip, production });
      }
      for (const entry of env.read_only?.hosts ?? []) {
        if (entry.trim() === '*') continue;
        const pattern = normalizeAllowEntry(entry);
        const ip = pattern.startsWith('*.') ? null : canonicalIp(pattern);
        out.push({ project: p.slug, env: name, host: ip ?? pattern, ip: ip !== null, production });
      }
    }
  }
  return out;
}

/**
 * The protected host a page URL points at, or null: the same canonical host (and port, for a page's), else — when one
 * side is an address (loopback included) and the other a name — the name's resolved addresses (core canonicalIp), a
 * name that does not resolve in time counting as a match. The names to resolve are looked up together; `lookups`
 * shares the resolutions of one check.
 */
export async function protectedHostOf(url: string, hosts: readonly WorkspaceProtectedHost[], lookups: Lookups = new Map()): Promise<ProtectedHostHit | null> {
  const o = origin(url);
  if (!o) return null;
  const portOk = (h: WorkspaceProtectedHost): boolean => h.port === undefined || h.port === o.port;
  const same = hosts.find((h) => portOk(h) && (h.port !== undefined ? h.host === o.host : o.host !== 'loopback' && hostMatches(o.host, h.host)));
  if (same) return same;
  const pairs: Array<{ h: WorkspaceProtectedHost; name: string; address: string }> = [];
  for (const h of hosts) {
    if (!portOk(h) || (h.port === undefined && (o.host === 'loopback' || h.host.startsWith('*.')))) continue;
    if ((h.ip === true) === o.ip) continue;
    const [name, address] = o.ip ? [h.host, o.host] : [o.host, h.host];
    pairs.push({ h, name, address });
  }
  // Every lookup starts now: one deadline for them all, not one after the other.
  const resolved = pairs.map((p) => addressesOf(p.name, lookups));
  for (const [i, { h, name, address }] of pairs.entries()) {
    const addresses = await resolved[i];
    const shown = address === 'loopback' ? 'a loopback address' : address;
    if (addresses === null) return { ...h, reason: `${name} did not resolve within ${resolver.timeoutMs / 1000} s, so it may be ${shown}` };
    if (addresses.includes(address)) return { ...h, reason: `${name} resolves to ${shown}` };
  }
  return null;
}

/** The first page of `pages` (in their order) that points at a protected host, its lookups all started together. */
async function firstProtectedPage<P extends { url: string }>(pages: readonly P[], hosts: readonly WorkspaceProtectedHost[]): Promise<(P & { hit: ProtectedHostHit }) | null> {
  const lookups: Lookups = new Map();
  const hits = await Promise.all(pages.map((p) => protectedHostOf(p.url, hosts, lookups)));
  const i = hits.findIndex((h) => h !== null);
  return i < 0 ? null : { ...pages[i], hit: hits[i]! };
}

function describe(h: ProtectedHostHit): string {
  return `${h.production ? 'production' : 'read-only'} environment ${h.env} of project ${h.project}${h.reason ? ` (${h.reason})` : ''}`;
}

/** project_create: refuse pages that point at the hosts of another project's production or read-only environment. */
export async function checkNewProjectHosts(ws: OpenedWorkspace, environments: Record<string, Record<string, string>> | undefined): Promise<void> {
  if (!environments || !Object.keys(environments).length) return;
  const hosts = await workspaceProtectedHosts(ws);
  const pages = Object.entries(environments).flatMap(([env, list]) => Object.entries(list ?? {}).map(([page, url]) => ({ env, page, url })));
  const found = await firstProtectedPage(pages, hosts);
  if (found) {
    throw new EngineError(
      'refused',
      `environment ${found.env}, page ${found.page} (${found.url}) points at a host of ${describe(found.hit)}: a project created through MCP may not reach production or read-only hosts read-write — a human adds such an environment to project.yaml (marked production)`,
    );
  }
}

/**
 * Work submitted through MCP on environment `envName`: refused when the environment is read-write and one of its pages
 * points at a host of another project's production or read-only environment. A protected environment itself is not
 * concerned (its run is read-only, or refuses what writes).
 */
export async function checkWorkspaceProtection(ws: OpenedWorkspace, project: LoadedProject, envName: string | undefined, fix?: string, via?: AgentChannel): Promise<void> {
  const env = resolveEnvironment(project, envName);
  if (isProtected(env) || env.sandbox !== undefined) return;
  const hosts = await workspaceProtectedHosts(ws, project.slug);
  if (!hosts.length) return;
  const found = await firstProtectedPage(Object.entries(env.pages).map(([page, url]) => ({ page, url })), hosts);
  if (found) {
    throw new EngineError(
      'refused',
      `environment ${env.name} of project ${project.slug} is read-write and its page ${found.page} (${found.url}) points at a host of ${describe(found.hit)}: ${channelWords(via)} nothing runs read-write on another project's production or read-only hosts — mark the environment production / read-only in project.yaml, or a human runs it in a terminal`,
      fix ? { fix } : undefined,
    );
  }
}
