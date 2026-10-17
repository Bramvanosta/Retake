/**
 * Production across projects (L3.1, trust `mcp`). A project's own production / read-only environments are guarded by
 * its runs (core access.ts); through MCP an agent can also create a project (project_create) whose environment points at
 * another project's production hosts, then run read-write hooks and captures on it. So, for work submitted through MCP,
 * the protected hosts are those of the production and read-only environments of EVERY project of the workspace: a new
 * project may not point at them, and a run, hooks or an environment reset on a read-write environment that does is
 * refused (a human runs it from a terminal, where project.yaml is theirs).
 */
import { environmentAccess, hostMatches, listProjects, normalizeAllowEntry, normalizeHost, resolveEnvironment } from '@demo-studio/core';
import type { LoadedProject, WorkspaceConfig } from '@demo-studio/core';
import { EngineError } from './errors.js';
import { openProject } from './workspace.js';

/** A host of a production or read-only environment of a project of the workspace. */
export interface WorkspaceProtectedHost {
  project: string;
  env: string;
  /** Normalised host (loopback names as `loopback`), or a `read_only.hosts` pattern (`*.example.com`). */
  host: string;
  /** A page's port (default ports included); absent for a pattern: any port. */
  port?: string;
  production: boolean;
}

const LOOPBACK = /^(?:localhost|.+\.localhost|127(?:\.\d{1,3}){3}|::1|0\.0\.0\.0)$/;

/** Host and port of a page URL, loopback names folded into one; null when it is not an http(s) URL. */
function origin(url: string): { host: string; port: string } | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const h = normalizeHost(u.hostname);
  return { host: LOOPBACK.test(h) ? 'loopback' : h, port: u.port || (u.protocol === 'https:' ? '443' : '80') };
}

/** Whether an environment is protected: production (MCP never passes --allow-writes) or read-only in project.yaml. */
function isProtected(env: Parameters<typeof environmentAccess>[0]): boolean {
  return env.production === true || environmentAccess(env) === 'read-only';
}

/** The protected hosts of every project of the workspace but `except` (a project that does not load protects nothing). */
export async function workspaceProtectedHosts(ws: WorkspaceConfig, except?: string): Promise<WorkspaceProtectedHost[]> {
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
        if (o) out.push({ project: p.slug, env: name, host: o.host, port: o.port, production });
      }
      for (const entry of env.read_only?.hosts ?? []) {
        if (entry.trim() !== '*') out.push({ project: p.slug, env: name, host: normalizeAllowEntry(entry), production });
      }
    }
  }
  return out;
}

/** The protected host a page URL points at, or null. */
export function protectedHostOf(url: string, hosts: readonly WorkspaceProtectedHost[]): WorkspaceProtectedHost | null {
  const o = origin(url);
  if (!o) return null;
  return hosts.find((h) => (h.port !== undefined ? h.host === o.host && h.port === o.port : o.host !== 'loopback' && hostMatches(o.host, h.host))) ?? null;
}

function describe(h: WorkspaceProtectedHost): string {
  return `${h.production ? 'production' : 'read-only'} environment ${h.env} of project ${h.project}`;
}

/** project_create: refuse pages that point at the hosts of another project's production or read-only environment. */
export async function checkNewProjectHosts(ws: WorkspaceConfig, environments: Record<string, Record<string, string>> | undefined): Promise<void> {
  if (!environments || !Object.keys(environments).length) return;
  const hosts = await workspaceProtectedHosts(ws);
  for (const [env, pages] of Object.entries(environments)) {
    for (const [page, url] of Object.entries(pages ?? {})) {
      const hit = protectedHostOf(url, hosts);
      if (hit) {
        throw new EngineError(
          'refused',
          `environment ${env}, page ${page} (${url}) points at a host of ${describe(hit)}: a project created through MCP may not reach production or read-only hosts read-write — a human adds such an environment to project.yaml (marked production)`,
        );
      }
    }
  }
}

/**
 * Work submitted through MCP on environment `envName`: refused when the environment is read-write and one of its pages
 * points at a host of another project's production or read-only environment. A protected environment itself is not
 * concerned (its run is read-only, or refuses what writes).
 */
export async function checkWorkspaceProtection(ws: WorkspaceConfig, project: LoadedProject, envName: string | undefined, fix?: string): Promise<void> {
  const env = resolveEnvironment(project, envName);
  if (isProtected(env) || env.sandbox !== undefined) return;
  const hosts = await workspaceProtectedHosts(ws, project.slug);
  if (!hosts.length) return;
  for (const [page, url] of Object.entries(env.pages)) {
    const hit = protectedHostOf(url, hosts);
    if (hit) {
      throw new EngineError(
        'refused',
        `environment ${env.name} of project ${project.slug} is read-write and its page ${page} (${url}) points at a host of ${describe(hit)}: through MCP nothing runs read-write on another project's production or read-only hosts — mark the environment production / read-only in project.yaml, or a human runs it in a terminal`,
        fix ? { fix } : undefined,
      );
    }
  }
}
