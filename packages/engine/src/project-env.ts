/**
 * Environments of an existing project changed in project.yaml (R-ENV-06; MCP project_env_set / project_env_remove,
 * `retake env add | set | remove`). core project-env-edit edits the text (only the edited node's range moves); this
 * checks and writes it:
 * - refused everywhere: a name that is not an environment name (checkEnvName), a sandbox environment (its pages are
 *   its sandbox.yaml's), a result project.yaml with errors (each issue named), a file changed since it was read (`if_match` on the
 *   text read: a conflict, never overwritten);
 * - an agent's change (MCP, the Studio): refused when a read-write environment would reach a production or read-only
 *   host of any project — this one's other environments included — and asked to a person (R-ENV-07, the approval form)
 *   when core says it needs one: a new origin, a protection lowered, the default moved onto a protected environment, a
 *   page URL's `user:password@` changed. The file is read again after the answer: a byte changed is a conflict;
 * - a person's command (the CLI) is their own act: nothing is asked, a protected host is a warning.
 * The answer never holds a page URL's `user:password@`. After a removal it names the scenarios whose `env:` still
 * names the environment and the personas whose saved sessions stay in the Retake home (neither is deleted).
 */
import { hasErrors } from '@retake/core/base';
import { dirname } from 'node:path';
import { environmentAccess, personaPaths, resolveEnvironment, withoutCredentials } from '@retake/core/environment';
import { EnvironmentEditError, PROJECT_FILE, editEnvironment, environmentEditAsks, environmentEditLines, pageOrigin, parseProjectYaml, readmeEnvironmentLine, removeEnvironment, scenarioRef, topLevelString } from '@retake/core/project';
import type { EnvironmentChange, EnvironmentEdit, EnvironmentEditMode, LoadedProject } from '@retake/core/project';
import { retakeHome } from '@retake/core/io';
import { takeProjectChangeApproval } from './approvals.js';
import type { Approver } from './approvals.js';
import { EngineError } from './errors.js';
import { checkEnvName } from './refs.js';
import type { JobClient } from './jobs/job-input.js';
import { describeProtectedHit, firstProtectedPage, projectProtectedHosts, workspaceProtectedHosts } from './protected-hosts.js';
import type { HostResolver } from './protected-hosts.js';
import { projectView } from './projects.js';
import type { ProjectView } from './projects.js';
import { storeOf } from './store/store.js';
import type { StoreScope } from './store/store.js';
import { openProject } from './workspace.js';
import type { OpenedWorkspace } from './workspace.js';

/** An environment as a change wrote it: its pages without `user:password@`. */
export interface WrittenEnvironmentView {
  name: string;
  pages: Record<string, string>;
  display?: Record<string, string>;
  production: boolean;
  access: 'read-only' | 'read-write';
  /** Page keys whose URL carries sign-in details (never shown). */
  credentials?: string[];
}

export interface EnvironmentChangeView {
  project: string;
  env: string;
  action: EnvironmentEdit['action'];
  /** project.yaml, project-relative, and the sha256 of what is there now. */
  file: string;
  hash: string;
  /** The environment as written (null once removed). */
  environment: WrittenEnvironmentView | null;
  /** The environment a scenario without `env:` uses, before and after. */
  default_env: { before: string | null; after: string | null };
  /** The change in words (no `user:password@`). */
  lines: string[];
  /** Why it needed a person, when it did (and the person approved it). */
  approved?: string[];
  /** A protected host a read-write environment reaches (a person's command: written, with this warning). */
  warnings: string[];
  /** README.md › "Environments & links" no longer matching (project_update_readme). */
  readme_environments?: ProjectView['readme_environments'];
  /**
   * After a removal: scenarios whose `env:` names it; how many personas have a saved session or profile of it left in
   * the Retake home (their names: `untrusted.sessions`, read from disk) and the command a person runs to remove them.
   */
  removed?: { scenarios: string[]; sessions: number; remove_sessions?: string };
  untrusted?: { sessions: string[] };
}

export interface EnvironmentChangeContext {
  ws: OpenedWorkspace;
  scope: StoreScope;
  hosts: HostResolver;
  /** An agent's change (MCP, the Studio): protected hosts refuse, what needs a person is asked. */
  agent: boolean;
  /** The `retake -C <root>` a human's command starts with. */
  cli: string;
  approver?: Approver;
  client?: JobClient;
}

export type EnvironmentChangeRequest = { kind: 'set'; mode: EnvironmentEditMode; env: string; change: EnvironmentChange } | { kind: 'remove'; env: string };

const q = (s: string): string => {
  const v = s.replace(/[^\x21-\x7e]/g, (c) => encodeURIComponent(c));
  return /^[\w@%+=:,./-]+$/.test(v) ? v : `'${v.replace(/'/g, `'\\''`)}'`;
};

/** A URL for a command a person runs, trimmed: its `user:password@` as USER:PASSWORD@ (they type their own). */
function commandUrl(url: string): string {
  const w = withoutCredentials(url.trim());
  return w.credentials ? w.url.replace(/^([a-z][a-z0-9+.-]*:\/\/)/i, '$1USER:PASSWORD@') : w.url;
}

/** The `retake env …` command a person runs for the same change (checked names and URLs only). */
export function envCommandLine(cli: string, slug: string, req: EnvironmentChangeRequest, exists: boolean): string {
  if (req.kind === 'remove') return `${cli} env remove ${slug} ${q(req.env)}`;
  const c = req.change;
  const pages = Object.entries(c.pages ?? {}).map(([k, p]) => {
    const page = typeof p === 'string' ? { url: p } : p;
    return `--page ${q(`${k}=${commandUrl(page.url)}${page.display !== undefined ? `,display=${page.display}` : ''}`)}`;
  });
  return [
    cli,
    'env',
    exists ? 'set' : 'add',
    slug,
    q(req.env),
    ...pages,
    ...(c.remove_pages ?? []).map((k) => `--remove-page ${q(k)}`),
    // `env add` has no --no-… flags: a new environment is neither production nor the default unless told.
    ...(c.production === true ? ['--production'] : c.production === false && exists ? ['--no-production'] : []),
    ...(c.access === 'read-only' ? ['--read-only'] : c.access === 'read-write' ? ['--read-write'] : []),
    ...(c.default === true ? ['--default'] : c.default === false && exists ? ['--no-default'] : []),
  ].join(' ');
}

function editOf(text: string, req: EnvironmentChangeRequest): EnvironmentEdit {
  try {
    return req.kind === 'remove' ? removeEnvironment(text, req.env) : editEnvironment(text, req.env, req.change, req.mode);
  } catch (e) {
    if (e instanceof EnvironmentEditError) throw new EngineError(e.kind, e.message);
    throw e;
  }
}

/** The project's page origins (every environment, the sandboxes' too), as core pageOrigin writes them. */
function projectOrigins(project: LoadedProject): string[] {
  return Object.values(project.config.environments ?? {}).flatMap((pages) => Object.values(pages).flatMap((u) => pageOrigin(u) ?? []));
}

/** A read-write environment of the result that reaches a protected host: its words, or null. */
async function protectedReach(cx: EnvironmentChangeContext, slug: string, after: Pick<LoadedProject, 'config'>, env: string): Promise<string | null> {
  const resolved = resolveEnvironment(after, env);
  if (resolved.production === true || environmentAccess(resolved) === 'read-only') return null;
  const hosts = [...(await workspaceProtectedHosts(cx.ws, slug)), ...projectProtectedHosts(after, slug, env)];
  if (!hosts.length) return null;
  const found = await firstProtectedPage(
    Object.entries(resolved.pages).map(([page, url]) => ({ page, url })),
    hosts,
    cx.hosts,
  );
  return found ? `environment ${env} is read-write and its page ${found.page} (${found.url}) points at a host of ${describeProtectedHit(found.hit)}` : null;
}

/** The scenarios whose top-level `env:` names `env` (read as text: a scenario that does not read is left out). */
async function scenariosNaming(project: LoadedProject, folder: ReturnType<typeof storeOf>, env: string): Promise<string[]> {
  const out: string[] = [];
  for (const name of project.scenarios) {
    for (const ext of ['.yaml', '.yml'] as const) {
      let text: string | undefined;
      try {
        text = (await folder.readText(scenarioRef(name, ext)))?.text;
      } catch {
        text = undefined;
      }
      if (text === undefined) continue;
      if (topLevelString(text, 'env') === env) out.push(name);
      break;
    }
  }
  return out;
}

/** The personas with a saved session or profile of `env` in the Retake home (names only: never a path). */
async function savedSessions(ws: OpenedWorkspace, slug: string, env: string): Promise<string[]> {
  const names = new Set<string>();
  const home = retakeHome();
  const { snapshot, profileDir } = personaPaths(home, slug, env, 'x');
  for (const [dir, file] of [
    [dirname(snapshot), true],
    [dirname(profileDir), false],
  ] as const) {
    let entries: Awaited<ReturnType<OpenedWorkspace['reads']['disk']['list']>> = [];
    try {
      entries = await ws.reads.disk.list(dir);
    } catch {
      continue;
    }
    for (const e of entries) {
      if (file && e.name.endsWith('.json') && !e.name.endsWith('.status.json')) names.add(e.name.slice(0, -'.json'.length));
      if (!file) names.add(e.name);
    }
  }
  return [...names].sort();
}

/** README.md's drift, when its lines concern this environment (a page of it missing, a line of it gone). */
function readmeOf(drift: ProjectView['readme_environments'], env: string): { readme_environments?: NonNullable<ProjectView['readme_environments']> } {
  if (!drift) return {};
  const missing = drift.missing.filter((l) => l.startsWith(`- ${env} · `));
  const gone = drift.gone.filter((l) => readmeEnvironmentLine(l)?.env === env);
  return missing.length || gone.length ? { readme_environments: { missing, gone } } : {};
}

/** What a removal leaves: the scenarios naming it, the saved sessions (names under untrusted) and how to remove them. */
async function removedOf(cx: EnvironmentChangeContext, before: LoadedProject, store: ReturnType<typeof storeOf>, env: string): Promise<Pick<EnvironmentChangeView, 'removed' | 'untrusted'>> {
  const sessions = await savedSessions(cx.ws, before.slug, env);
  const home = '"${RETAKE_HOME:-$HOME/.retake}"';
  return {
    removed: {
      scenarios: await scenariosNaming(before, store, env),
      sessions: sessions.length,
      ...(sessions.length ? { remove_sessions: `rm -r ${home}/sessions/${before.slug}/${env} ${home}/profiles/${before.slug}/${env}` } : {}),
    },
    ...(sessions.length ? { untrusted: { sessions } } : {}),
  };
}

function writtenView(project: LoadedProject, env: string): WrittenEnvironmentView {
  const r = resolveEnvironment(project, env);
  const raw = project.config.environments[env] ?? {};
  const credentials = Object.entries(raw)
    .filter(([, u]) => withoutCredentials(u).credentials)
    .map(([k]) => k);
  return {
    name: env,
    pages: r.pages,
    ...(r.display ? { display: r.display } : {}),
    production: r.production === true,
    access: environmentAccess(r),
    ...(credentials.length ? { credentials } : {}),
  };
}

/**
 * Add, change or remove one environment of project.yaml (the rules: the module comment). Throws EngineError —
 * `invalid`, `not_found`, `conflict`, `refused`, `needs_approval` — with nothing written.
 */
export async function changeProjectEnvironment(cx: EnvironmentChangeContext, project: LoadedProject, req: EnvironmentChangeRequest): Promise<EnvironmentChangeView> {
  checkEnvName(req.env);
  const slug = project.slug;
  if (Object.hasOwn(project.config.sandboxes ?? {}, req.env)) {
    throw new EngineError('refused', `environment ${req.env} is a sandbox: its pages and accounts are in its sandbox.yaml — edit that file, or edit or remove \`sandboxes.${req.env}\` in project.yaml by hand`);
  }
  const store = storeOf(project, cx.scope);
  const read = await store.readText(PROJECT_FILE);
  if (!read) throw new EngineError('not_found', `${PROJECT_FILE} of ${slug} is gone`);
  const edit = editOf(read.text, req);
  const fix = envCommandLine(cx.cli, slug, req, edit.before !== null);
  const base = { project: slug, env: req.env, action: edit.action, file: store.refOf(project.file), default_env: { before: edit.default_before, after: edit.default_after }, lines: environmentEditLines(edit) };
  if (edit.action === 'unchanged') {
    return { ...base, hash: read.sha256, environment: writtenView(project, req.env), warnings: [] };
  }
  const parsed = parseProjectYaml(edit.text, project.file, cx.ws.reads.disk.facts);
  if (!parsed.config || hasErrors(parsed.issues)) {
    const errors = parsed.issues.filter((i) => i.severity === 'error');
    throw new EngineError('refused', `nothing was written: project.yaml would not be valid — ${errors.map((i) => `${i.path.length ? `${i.path.join('.')}: ` : ''}${i.message}`).join('; ')}`, {
      details: { issues: errors },
      fix: 'change what still names it first (auth, personas, default_env), or edit project.yaml by hand',
    });
  }
  // project.yaml's own warnings after the change (an unused auth key, a display URL…).
  const warnings: string[] = parsed.issues.filter((i) => i.severity === 'warning').map((i) => `project.yaml: ${i.path.length ? `${i.path.join('.')}: ` : ''}${i.message}`);
  if (edit.after) {
    const reach = await protectedReach(cx, slug, { config: parsed.config }, req.env);
    if (reach && cx.agent) {
      throw new EngineError('refused', `nothing was written: ${reach} — through this client nothing runs read-write on a production or read-only host: mark the environment production / read-only, or a human writes it in a terminal`, { fix });
    }
    if (reach) warnings.push(`${reach}: runs on it write there — mark it production or read-only if it is`);
  }
  const asks = cx.agent ? environmentEditAsks(edit, projectOrigins(project)) : [];
  if (asks.length) {
    await takeProjectChangeApproval({ what: 'environment change', project: slug, env: req.env, lines: base.lines, asks: asks.map((a) => a.line), fix }, cx.approver, cx.client);
    const again = await store.readText(PROJECT_FILE);
    if (again?.sha256 !== read.sha256) {
      throw new EngineError('conflict', `nothing was written: ${PROJECT_FILE} of ${slug} changed while the user was asked — read the project again (project_get) and ask again`, { fix });
    }
  }
  const before = req.kind === 'remove' ? project : undefined;
  const written = await store.writeText(PROJECT_FILE, edit.text, { ifMatch: read.sha256, what: 'project' });
  const now = await openProject(cx.ws, project.dir);
  const view = await projectView(now, cx.scope.stores.folder(now.dir));
  return {
    ...base,
    hash: written.sha256,
    environment: edit.after ? writtenView(now, req.env) : null,
    ...(asks.length ? { approved: asks.map((a) => a.line) } : {}),
    warnings,
    ...readmeOf(view.readme_environments, req.env),
    ...(before ? await removedOf(cx, before, store, req.env) : {}),
  };
}
