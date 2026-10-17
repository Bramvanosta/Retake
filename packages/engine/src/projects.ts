/** Projects of a workspace for clients outside the CLI: list, view (no secret values, no session paths), create, README. */
import { README_FILE, createProject, environmentAccess, listProjects, resolveEnvironment, resolvePersonas } from '@demo-studio/core';
import type { CreateProjectInput, LoadedProject, ProjectConfig, ValidationIssue, WorkspaceConfig } from '@demo-studio/core';
import { EngineError } from './errors.js';
import { checkProjectSlug } from './refs.js';
import { LocalStorage } from './storage.js';
import { openProject } from './workspace.js';
import { checkNewProjectHosts } from './protected-hosts.js';

export interface ProjectSummary {
  slug: string;
  name: string;
  /** Absolute project folder. */
  dir: string;
  scenarios: string[];
  environments: string[];
  /** project.yaml (or a sandbox.yaml) does not load: the first line of why. */
  error?: string;
}

/** Every project of the workspace with its scenarios and environments (a broken one is listed with its error). */
export async function listProjectSummaries(ws: WorkspaceConfig): Promise<ProjectSummary[]> {
  const projects = await listProjects(ws.root);
  return Promise.all(
    projects.map(async (p) => {
      try {
        const loaded = await openProject(ws, p.dir);
        return { ...p, scenarios: loaded.scenarios, environments: Object.keys(loaded.config.environments) };
      } catch (e) {
        return { ...p, scenarios: [], environments: [], error: (e as Error).message.split('\n')[0] };
      }
    }),
  );
}

/** A project by slug (never a path: core would resolve one outside the workspace). */
export async function openProjectBySlug(ws: WorkspaceConfig, slug: string): Promise<LoadedProject> {
  return openProject(ws, checkProjectSlug(slug));
}

export interface PersonaView {
  name: string;
  /** Environment page keys it is signed into by default. */
  pages: string[];
  /** It has `login:` steps (`studio login --auto` and sandbox takes sign it in by them). */
  login_steps: boolean;
  /** An account of a sandbox: signed in automatically by a take. */
  sandbox?: true;
}

export interface EnvironmentView {
  name: string;
  /** Page key → base URL. */
  pages: Record<string, string>;
  /** Page key → the URL the video shows instead. */
  display?: Record<string, string>;
  production: boolean;
  /** Effective access: read-only stops every write to its hosts (and refuses hooks that write). */
  access: 'read-only' | 'read-write';
  sandbox: boolean;
  personas: PersonaView[];
}

export interface ProjectView {
  slug: string;
  name: string;
  dir: string;
  /** project.yaml, as a project-relative ref. */
  file: string;
  readme: string | null;
  /** sha256 of README.md (the `if_match` of project_update_readme); null when there is none. */
  readme_hash: string | null;
  scenarios: string[];
  default_env?: string;
  environments: EnvironmentView[];
  /**
   * project.yaml with its defaults applied, without `auth` (see `environments[].personas`: names only — no login steps,
   * no session paths) and with any password written in a URL masked.
   */
  config: Omit<ProjectConfig, 'auth'>;
  /** Warnings of project.yaml. */
  warnings: ValidationIssue[];
}

/** "postgres://user:secret@host/db" → "postgres://user:***@host/db" (whatever a user wrote in clear). */
export function maskUrlCredentials<T>(value: T): T {
  if (typeof value === 'string') return value.replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]*:)[^\s/@]+@/gi, '$1***@') as T;
  if (Array.isArray(value)) return value.map((v) => maskUrlCredentials(v)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, maskUrlCredentials(v)])) as T;
  }
  return value;
}

export async function projectView(project: LoadedProject): Promise<ProjectView> {
  const storage = new LocalStorage(project.dir);
  const readme = await storage.readText(README_FILE);
  const environments: EnvironmentView[] = Object.keys(project.config.environments ?? {}).map((name) => {
    const env = resolveEnvironment(project, name);
    return {
      name,
      pages: env.pages,
      ...(env.display ? { display: env.display } : {}),
      production: env.production === true,
      access: environmentAccess(env),
      sandbox: env.sandbox !== undefined,
      personas: resolvePersonas(project, name).map((p) => ({
        name: p.name,
        pages: p.pages,
        login_steps: (p.login?.length ?? 0) > 0,
        ...(p.sandbox ? { sandbox: true as const } : {}),
      })),
    };
  });
  const { auth: _auth, ...config } = project.config;
  return {
    slug: project.slug,
    name: project.config.name,
    dir: project.dir,
    file: storage.refOf(project.file),
    readme: readme?.text ?? null,
    readme_hash: readme?.sha256 ?? null,
    scenarios: project.scenarios,
    ...(project.config.default_env !== undefined ? { default_env: project.config.default_env } : {}),
    environments,
    config: maskUrlCredentials(config),
    warnings: project.issues ?? [],
  };
}

export type CreateProjectRequest = Pick<CreateProjectInput, 'name' | 'slug' | 'readme' | 'environments' | 'template'>;

/** README.md, project.yaml, scenarios/, hooks/, assets/ and .gitignore of a new project; refuses an existing slug. */
export async function createProjectFromRequest(ws: WorkspaceConfig, input: CreateProjectRequest): Promise<LoadedProject> {
  if (input.slug !== undefined) checkProjectSlug(input.slug);
  // Never a page on another project's production or read-only hosts (they would run read-write here).
  await checkNewProjectHosts(ws, input.environments);
  const created = await createProject(ws.root, {
    name: input.name,
    ...(input.slug !== undefined ? { slug: input.slug } : {}),
    ...(input.readme !== undefined ? { readme: input.readme } : {}),
    ...(input.environments !== undefined ? { environments: input.environments } : {}),
    ...(input.template !== undefined ? { template: input.template } : {}),
  });
  return openProject(ws, created.dir);
}

/**
 * Replace README.md. An existing README needs `ifMatch` (its readme_hash): a conflict otherwise, naming the current hash;
 * a missing one is created (ifMatch absent or null).
 */
export async function updateProjectReadme(project: LoadedProject, markdown: string, ifMatch: string | null | undefined): Promise<{ file: string; path: string; hash: string }> {
  const storage = new LocalStorage(project.dir);
  const current = await storage.readText(README_FILE);
  if (current && (ifMatch === undefined || ifMatch === null)) {
    throw new EngineError('conflict', `${README_FILE} of ${project.slug} exists: pass if_match with the readme_hash you read (project_get), so a change made meanwhile is not lost`, {
      details: { current: current.sha256 },
      fix: `if_match: "${current.sha256}"`,
    });
  }
  const text = markdown.endsWith('\n') ? markdown : `${markdown}\n`;
  const res = await storage.writeText(README_FILE, text, { ifMatch: ifMatch ?? null });
  project.readme = text;
  return { file: res.ref, path: res.path, hash: res.sha256 };
}
