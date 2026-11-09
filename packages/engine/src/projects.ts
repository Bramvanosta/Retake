/** Projects of a workspace for clients outside the CLI: list, view (no secret values, no session paths), create, README. */
import { realpath } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { PROJECT_FILE, README_FILE, environmentAccess, loadProject, planNewProject, listProjects, resolveEnvironment, resolvePersonas, pathInside } from '@retake/core';
import type { CreateProjectInput, LoadedProject, ProjectConfig, ValidationIssue, WorkspaceConfig } from '@retake/core';
import { EngineError } from './errors.js';
import { checkProjectSlug } from './refs.js';
import { LocalStorage, READ_TEXT_MAX_BYTES } from './storage.js';
import { openProject } from './workspace.js';
import { ProjectStore } from './store/project-store.js';
import type { StoreScope } from './store/project-store.js';
import { checkNewProjectHosts } from './protected-hosts.js';

export interface ProjectSummary {
  slug: string;
  name: string;
  /** Absolute project folder. */
  dir: string;
  scenarios: string[];
  environments: string[];
  /** project.yaml (or a sandbox.yaml) does not load: the first line of why (with its first problem when that line only counts them). */
  error?: string;
}

/** README.md's cap in characters, its final line break included (project_create / project_update_readme). */
export const README_MAX_CHARS = 200_000;

/**
 * The first line of an error for a one-line display: "project.yaml has 1 error:" alone says nothing (review B L5), so a
 * first line that ends with a colon gets the next non-empty line.
 */
export function firstErrorLine(message: string): string {
  const lines = message.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return message;
  return lines[0].endsWith(':') && lines[1] ? `${lines[0]} ${lines[1]}` : lines[0];
}

/**
 * project.yaml must be a file of the project once symbolic links are followed (review B M5): one leading out is never
 * read through the engine (MCP, the Studio) — its content would come back in errors and views. The CLI reads what the
 * person points it at.
 */
async function checkProjectFile(dir: string): Promise<void> {
  let real: string;
  let realDir: string;
  try {
    [realDir, real] = await Promise.all([realpath(dir), realpath(join(dir, PROJECT_FILE))]);
  } catch {
    return; // no project.yaml (or no folder): core says so in its own words
  }
  if (!pathInside(real, realDir, { self: false, dotDotPrefix: true })) {
    throw new EngineError('refused', `${join(dir, PROJECT_FILE)} leads out of the project folder (a symbolic link): not read`, { fix: `replace the link with a regular file inside ${dir}` });
  }
}

/** Every project of the workspace with its scenarios and environments (a broken one is listed with its error). */
export async function listProjectSummaries(ws: WorkspaceConfig): Promise<ProjectSummary[]> {
  const projects = await listProjects(ws.root);
  return Promise.all(
    projects.map(async (p) => {
      try {
        await checkProjectFile(p.dir);
        const loaded = await openProject(ws, p.dir);
        return { ...p, scenarios: loaded.scenarios, environments: Object.keys(loaded.config.environments) };
      } catch (e) {
        return { ...p, scenarios: [], environments: [], error: firstErrorLine((e as Error).message) };
      }
    }),
  );
}

/** A project by slug (never a path: core would resolve one outside the workspace). */
export async function openProjectBySlug(ws: WorkspaceConfig, slug: string): Promise<LoadedProject> {
  await checkProjectFile(join(ws.projectsDir, checkProjectSlug(slug)));
  return openProject(ws, slug);
}

export interface PersonaView {
  name: string;
  /** Environment page keys it is signed into by default. */
  pages: string[];
  /** It has `login:` steps (`retake login --auto` and sandbox takes sign it in by them). */
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
  /**
   * Why README.md cannot be edited as text, when it cannot: a symbolic link leading out of the project (readme and
   * readme_hash null: never read), or bytes that are not UTF-8 (readme shows U+FFFD in their place). The project itself
   * still opens.
   */
  readme_error?: string;
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

/** README.md as project_get shows it: the text, or why it cannot be edited (review B M1, M3). */
async function readmeOf(storage: LocalStorage): Promise<{ text: string; sha256: string; error?: string } | { text: null; sha256: null; error: string } | undefined> {
  let r;
  try {
    r = await storage.readText(README_FILE);
  } catch (e) {
    if (e instanceof EngineError) {
      const reason = e.details?.reason;
      if (reason === 'link_out') return { text: null, sha256: null, error: `${README_FILE} is a symbolic link leading out of the project folder: not read (replace it with a regular file)` };
      if (reason === 'not_file') return { text: null, sha256: null, error: `${README_FILE} is not a regular file (a FIFO, a device, a folder…): not read (replace it with a regular file)` };
      if (reason === 'too_large') return { text: null, sha256: null, error: `${README_FILE} is too large to show here (over ${READ_TEXT_MAX_BYTES.toLocaleString('en')} bytes): shorten it in an editor` };
    }
    throw e;
  }
  if (!r) return undefined;
  if (!r.utf8) return { text: r.text, sha256: r.sha256, error: `${README_FILE} is not UTF-8 text (another encoding, or binary): shown with U+FFFD in place of the bytes that do not decode; convert it to UTF-8 in an editor before changing it here` };
  return { text: r.text, sha256: r.sha256 };
}

export async function projectView(project: LoadedProject): Promise<ProjectView> {
  const storage = new LocalStorage(project.dir);
  const readme = await readmeOf(storage);
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
    ...(readme?.error ? { readme_error: readme.error } : {}),
    scenarios: project.scenarios,
    ...(project.config.default_env !== undefined ? { default_env: project.config.default_env } : {}),
    environments,
    config: maskUrlCredentials(config),
    warnings: project.issues ?? [],
  };
}

export type CreateProjectRequest = Pick<CreateProjectInput, 'name' | 'slug' | 'readme' | 'environments' | 'template'>;

/**
 * Write a new project (core planNewProject: scenarios/, hooks/ and assets/ with their .gitkeep, project.yaml, README.md,
 * .gitignore) through the project store — each file created (`if_match` null: never over one) and journaled — then load
 * it. Refuses what core refuses (a taken slug, a folder that is not empty, an invalid project.yaml). `retake new` and
 * engine.projects.create both write a project this way.
 */
export async function writeNewProject(root: string, input: CreateProjectInput, scope: StoreScope): Promise<LoadedProject> {
  const plan = await planNewProject(root, input);
  const store = new ProjectStore(plan.dir, scope, plan.slug);
  for (const f of plan.files) await store.writeText(f.ref, f.text, { ifMatch: null, what: 'project' });
  return loadProject(plan.dir, plan.wsRoot);
}

/** README.md, project.yaml, scenarios/, hooks/, assets/ and .gitignore of a new project; refuses an existing slug. */
export async function createProjectFromRequest(ws: WorkspaceConfig, input: CreateProjectRequest, scope: StoreScope): Promise<LoadedProject> {
  if (input.slug !== undefined) checkProjectSlug(input.slug);
  // Never a page on another project's production or read-only hosts (they would run read-write here).
  await checkNewProjectHosts(ws, input.environments);
  const created = await writeNewProject(ws.root, {
    name: input.name,
    ...(input.slug !== undefined ? { slug: input.slug } : {}),
    ...(input.readme !== undefined ? { readme: input.readme } : {}),
    ...(input.environments !== undefined ? { environments: input.environments } : {}),
    ...(input.template !== undefined ? { template: input.template } : {}),
  }, scope);
  return openProject(ws, created.dir);
}

/**
 * Replace README.md. An existing README needs `ifMatch` (its readme_hash): a conflict otherwise, naming the current hash;
 * a missing one is created (ifMatch absent or null). The file ends with a line break and holds README_MAX_CHARS at most;
 * a README.md linked to another file of the project is written through the link.
 */
export async function updateProjectReadme(project: LoadedProject, markdown: string, ifMatch: string | null | undefined, scope: StoreScope): Promise<{ file: string; path: string; hash: string }> {
  const store = ProjectStore.of(project, scope);
  const current = await store.readText(README_FILE);
  if (current && (ifMatch === undefined || ifMatch === null)) {
    throw new EngineError('conflict', `${README_FILE} of ${project.slug} exists: pass if_match with the readme_hash you read (project_get), so a change made meanwhile is not lost`, {
      details: { current: current.sha256 },
      fix: `if_match: "${current.sha256}"`,
    });
  }
  const text = markdown.endsWith('\n') ? markdown : `${markdown}\n`;
  // The cap holds for the file as written (review B L6): a text at the cap without its final line break would be
  // written one character over it, and could not be sent back unchanged.
  if (text.length > README_MAX_CHARS) {
    throw new EngineError('invalid', `${README_FILE} would be ${text.length.toLocaleString('en')} characters with its final line break: at most ${README_MAX_CHARS.toLocaleString('en')}`, { fix: 'shorten it' });
  }
  const res = await store.writeText(README_FILE, text, { ifMatch: ifMatch ?? null, what: 'readme' });
  project.readme = text;
  return { file: res.ref, path: res.path, hash: res.sha256 };
}
