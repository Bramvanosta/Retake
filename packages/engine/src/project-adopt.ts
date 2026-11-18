/**
 * A project adopts what it uses of the workspace (R-SHR-14): a workspace theme copied or moved into the
 * project's own `templates/`, workspace components into its `components/` (R-SHR-25), brand files into its `brand/` —
 * so the project folder alone carries its look.
 *
 * - Copy (`retake project adopt --copy`, MCP `project_adopt`): the theme folder verbatim, its provenance kept (a theme
 *   MCP made can still be updated through MCP, a person's never), through the project's store (staged, checked,
 *   journaled); the workspace theme stays, now hidden for this project only. A workspace theme of a starter's name keeps
 *   it (it already hid that starter; the project's copy does so for the project).
 * - Move (`retake project adopt`, a person only): refused while another project or scenario uses the workspace theme
 *   (listed: `slug (project.yaml)`, `slug/scenario`), while a project does not open (its use cannot be told), while the
 *   adopting project names the folder by its path (a path never finds the project's copy), or while a job is queued or
 *   running in the workspace; the copy made, then — under the write lock of its template.yaml (a Studio save racing it
 *   waits, then finds it gone), the job queue read again (a job appeared: the copy removed, refused) and the source
 *   re-hashed (changed since: refused, the copy kept and said) — the workspace folder set aside under
 *   `<workspace>/.retake/adopted/<stamp>-theme-<name>/` (journaled `move`; from a templates_dir outside the workspace,
 *   a rename or, across volumes, a copy then a removal). Nothing is deleted: a person removes the folder set aside.
 * - Brand files (a person only): one regular file per `--brand`, a brand file's extension, never from a project, the
 *   workspace's themes or components folder, its state folder.
 * - Never: a starter (no workspace theme: `theme copy` / a new theme makes one), a name the project already has
 *   (conflict), a theme serving a file from outside its folder, MCP moving anything or touching brand files (a person
 *   moves brand files: `<project>/brand/` is no agent's folder).
 * - A component (`--component <id>`, MCP `project_adopt {components}`: copy only through MCP): the workspace component's
 *   folder verbatim (its sources, README, committed preview; no hidden entry, no node_modules, no link) into
 *   `<project>/components/<namespace>/<name>/`, its files hashed and checked as they are copied; refused for a built-in
 *   id, an id the project already holds, a component that does not validate. A move is refused while a workspace theme
 *   picks it, while another project (its themes, project.yaml, scenarios) names it without a component of its own of
 *   that id, while a project or a workspace theme does not open, or while a job is queued or running; set aside as a
 *   theme is (`.retake/adopted/<stamp>-component-<namespace>-<name>/`, under the write lock of its component.yaml).
 * - project.yaml and the scenarios are not rewritten: the project's own theme of that name is found first. Earlier
 *   renders keep the workspace folder's identity, and still match: their theme name resolves to the project's copy,
 *   whose content hash is the one they hold (the board, an export). Other projects' renders of a moved theme are named.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { Stats } from 'node:fs';
import { lstat, readFile, readdir, rm } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { PROJECT_LIBRARY_DIRS, projectLibraryRef, statePath, stateRef } from '@retake/core/project';
import type { LoadedProject } from '@retake/core/project';
import { TEMPLATE_FILE } from '@retake/core/theme';
import type { LoadedTemplate } from '@retake/core/theme';
import { nodeFileFacts } from '@retake/core/io';
import { insideFolder } from '@retake/core/scenario';
import { realPathOf } from '@retake/core/policy';
import { copyThemeFolder } from './brand/copy.js';
import { THEME_PROVENANCE_FILE } from './brand/create.js';
import { dateOf } from './clock.js';
import type { CallerTrust } from './caller.js';
import { EngineError, toEngineError } from './errors.js';
import { openProjectBySlug } from './projects.js';
import { rendersOfThemeFolder, usersOfWorkspaceComponent, usersOfWorkspaceTheme } from './project-uses.js';
import { checkComponentId, projectComponentTarget, workspaceRegistry } from './components.js';
import type { ComponentTarget } from './components.js';
import { FONT_EXTENSIONS, LOGO_EXTENSIONS, TOKENS_EXTENSIONS } from './brand/files.js';
import { checkProjectSlug } from './refs.js';
import type { ProjectStore, StoreScope } from './store/store.js';
import { checkNewThemeName, checkTemplateName } from './templates.js';
import { projectThemeTarget } from './theme-target.js';
import type { OpenedWorkspace } from './workspace.js';

/** Brand files one adopt copies, at most (a folder named whole). */
export const ADOPT_BRAND_FILES_MAX = 500;
/** The built-in library's namespace (components create.ts BUILTIN_NAMESPACE): never a project's to adopt. */
const BUILTIN_NAMESPACE = 'studio';
/** The files and bytes of one component an adopt copies, at most. */
export const ADOPT_COMPONENT_FILES_MAX = 500;
export const ADOPT_COMPONENT_BYTES_MAX = 50 * 1024 * 1024;

export interface AdoptRequest {
  project: string;
  /** Workspace themes, by name. */
  themes?: string[];
  /** Brand files or folders, relative to the workspace root (a person only). */
  brand?: string[];
  /** Workspace components, by id ("namespace/name"). */
  components?: string[];
  /** `copy` leaves the workspace's; `move` sets it aside (a person only). */
  mode: 'copy' | 'move';
}

export interface AdoptedTheme {
  name: string;
  /** The project's copy (`<project>/templates/<name>`). */
  dir: string;
  files: string[];
  /** A move: where the workspace folder was set aside. */
  moved_to?: string;
}

export interface AdoptedBrand {
  /** As given (relative to the workspace root). */
  from: string;
  /** Files copied, relative to the project folder (`brand/…`). */
  files: string[];
  /** A move: where the original was set aside. */
  moved_to?: string;
}

export interface AdoptedComponent {
  id: string;
  /** The project's copy (`<project>/components/<namespace>/<name>`). */
  dir: string;
  files: string[];
  /** A move: where the workspace folder was set aside. */
  moved_to?: string;
}

export interface AdoptResult {
  project: string;
  mode: 'copy' | 'move';
  themes: AdoptedTheme[];
  brand: AdoptedBrand[];
  /** Present when the request named components. */
  components?: AdoptedComponent[];
  /** What a person should know (themes whose provenance names a moved brand file, renders made before…). */
  notes: string[];
}

export interface AdoptOptions {
  scope: StoreScope;
  /** `mcp`: copy only, no brand files. */
  trust: CallerTrust;
  /** The workspace's jobs queued or running (a move is refused while there is one): `kind (id)` each. */
  activeJobs: () => Promise<string[]>;
}

/** A stamp for a folder set aside, from the scope's clock (`20261118T001500Z`). */
const stampOf = (scope: StoreScope): string =>
  dateOf(scope.clock)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');

/** sha256 of every regular file of a folder (relative path → hex), hidden entries included: what a move compares. */
async function folderHashes(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (rel: string): Promise<void> => {
    for (const e of await readdir(join(dir, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(r);
      else
        out[r] = e.isFile()
          ? createHash('sha256')
              .update(await readFile(join(dir, ...r.split('/'))))
              .digest('hex')
          : `(${e.isSymbolicLink() ? 'link' : 'special'})`;
    }
  };
  await walk('');
  return out;
}

const sameHashes = (a: Record<string, string>, b: Record<string, string>): boolean => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());

/** The workspace theme `name` an adopt takes: a folder of templates_dir (never a starter), loaded. */
async function workspaceTheme(ws: OpenedWorkspace, name: string): Promise<LoadedTemplate> {
  const entry = (await ws.reads.listTemplates(ws.root)).find((e) => e.name === name);
  if (!entry) throw new EngineError('not_found', `no workspace theme ${name} (template_list names them)`);
  if (entry.source !== 'workspace') {
    throw new EngineError('refused', `${name} is a starter theme shipped with Retake, not a workspace theme: make the project its own with a copy (theme copy, or a new theme with project)`);
  }
  try {
    return await ws.reads.loadTemplate(entry.dir, undefined, { files: ws.reads.fileFacts(ws.policy) });
  } catch (e) {
    throw toEngineError(e);
  }
}

/**
 * A workspace folder or file set aside under the workspace's `.retake/adopted/<stamp>-<what>-<name>` (decision M2: one
 * place, the workspace's, whatever folder it came from): inside the workspace, the root store's moveAside under the
 * write lock of `lockFile` (a theme's template.yaml: a Studio save racing it waits, then finds it gone); from a
 * templates_dir configured outside the workspace, its takeIn — a rename, else (another volume) a copy then a removal.
 * `check` runs last, under that lock. Answers the place set aside, workspace-relative.
 */
async function setAside(
  ws: OpenedWorkspace,
  path: string,
  a: { what: 'theme' | 'brand' | 'component'; name: string; stamp: string; scope: StoreScope; check: () => Promise<void>; lockFile?: string },
): Promise<string> {
  const realRoot = realPathOf(resolve(ws.root), nodeFileFacts);
  const real = realPathOf(path, nodeFileFacts);
  const to = stateRef('adopted', `${a.stamp}-${a.what}-${a.name}`);
  const store = a.scope.stores.at(realRoot, a.scope);
  try {
    if (insideFolder(realRoot, real, nodeFileFacts)) {
      const ref = relative(realRoot, real).split(sep).join('/');
      await store.moveAside(ref, to, { what: a.what, check: a.check, ...(a.lockFile !== undefined ? { lockRef: `${ref}/${a.lockFile}` } : {}) });
    } else await store.takeIn(real, to, { what: a.what, check: a.check });
  } catch (e) {
    throw toEngineError(e);
  }
  return to;
}

/** What one adopt hands each item: the workspace, the project, the request, its options, the stamp of what it sets aside, its notes. */
interface AdoptPass {
  ws: OpenedWorkspace;
  project: LoadedProject;
  req: AdoptRequest;
  o: AdoptOptions;
  stamp: string;
  notes: string[];
}

/** The refusal of a move while jobs are queued or running (they may read the workspace's folder). */
function busyError(jobs: string[]): EngineError {
  return new EngineError(
    'busy',
    `${jobs.length === 1 ? 'a job is' : `${jobs.length} jobs are`} queued or running in the workspace (${jobs.slice(0, 5).join(', ')}): nothing is moved while one may read the workspace's files — wait for them, or adopt a copy (--copy)`,
    { details: { jobs } },
  );
}

/** Why a workspace theme is not moved: who else reaches it, a project that does not open, the adopting project's own paths. */
async function moveUsersCheck(ws: OpenedWorkspace, project: LoadedProject, name: string): Promise<void> {
  const u = await usersOfWorkspaceTheme(ws, name, { except: project.slug });
  const list = (l: string[]) => `${l.slice(0, 10).join(', ')}${l.length > 10 ? ` and ${l.length - 10} more` : ''}`;
  if (u.users.length) {
    throw new EngineError('refused', `the workspace theme ${name} is used by ${list(u.users)}: it is not moved — adopt a copy (--copy), or adopt it into those projects first`, {
      details: { users: u.users },
    });
  }
  if (u.own_paths.length) {
    throw new EngineError(
      'refused',
      `${list(u.own_paths)} names the workspace theme ${name} by its path: it is not moved (a path never finds the project's copy) — name it by its name (template: ${name}), then adopt`,
      { details: { users: u.own_paths } },
    );
  }
  if (u.unreadable.length) {
    throw new EngineError('refused', `project ${list(u.unreadable)} does not open: whether it uses the workspace theme ${name} cannot be told — fix it, or adopt a copy (--copy)`, {
      details: { unreadable: u.unreadable },
    });
  }
}

/** What an adopt of the theme `name` needs, every refusal checked (run for every item before any is done). */
async function themeSourceOf(pass: AdoptPass, name: string): Promise<{ source: LoadedTemplate; target: ReturnType<typeof projectThemeTarget> }> {
  const { ws, project, req } = pass;
  checkTemplateName(name);
  const source = await workspaceTheme(ws, name);
  const target = projectThemeTarget(ws, project, 'an adopted theme');
  if ((await readdir(target.dir).catch(() => [] as string[])).some((e) => e.toLowerCase() === name.toLowerCase()))
    throw new EngineError('conflict', `project ${project.slug} already has a theme folder ${name} (${PROJECT_LIBRARY_DIRS.templates}/${name}): nothing adopted — remove or rename one of them by hand`);
  if (req.mode === 'move') await moveUsersCheck(ws, project, name);
  return { source, target };
}

/** One workspace theme into the project (see the header). */
async function adoptTheme(pass: AdoptPass, name: string): Promise<AdoptedTheme> {
  const { ws, project, req, o, stamp, notes } = pass;
  const { source, target } = await themeSourceOf(pass, name);
  const before = req.mode === 'move' ? await folderHashes(source.dir) : undefined;
  // The workspace theme of a starter's name already hides that starter: the project's copy keeps that for itself.
  const files = await copyThemeFolder(ws, { source, from: name }, target, checkNewThemeName(name), { provenance: 'keep', scope: o.scope, keepStarterName: true });
  const out: AdoptedTheme = { name, dir: join(target.dir, name), files };
  if (req.mode === 'move') {
    const others = await rendersOfThemeFolder(ws, ws.reads.templateFolderId(source.dir, ws.root), { except: project.slug });
    let jobs: string[] = [];
    try {
      out.moved_to = await setAside(ws, source.dir, {
        what: 'theme',
        name,
        stamp,
        scope: o.scope,
        lockFile: TEMPLATE_FILE,
        check: async () => {
          // Read again under the lock: a job queued while the folder was copied may read it.
          jobs = await o.activeJobs();
          if (jobs.length) throw busyError(jobs);
          if (!sameHashes(before!, await folderHashes(source.dir))) {
            throw new EngineError(
              'conflict',
              `the workspace theme ${name} changed while it was adopted: the project's copy is made (${projectLibraryRef('templates', name)}), the workspace theme stays — compare them and remove one by hand`,
            );
          }
        },
      });
    } catch (e) {
      // A job appeared: nothing is adopted — the copy this call made a moment ago goes again.
      if (jobs.length) await rm(out.dir, { recursive: true, force: true });
      throw e;
    }
    if (others.length) notes.push(`older renders of other projects name the workspace theme ${name}: ${others.join(', ')} — they read as made with another theme until rendered again`);
  }
  return out;
}

/** The extensions of a brand file: what a theme takes as its logo, wordmark or fonts, and a design-token file. */
const BRAND_FILE_EXTENSIONS: readonly string[] = [...LOGO_EXTENSIONS, ...FONT_EXTENSIONS, ...TOKENS_EXTENSIONS];

/**
 * A brand file a person names: relative to the workspace root, inside it, a regular file (never a folder nor a link)
 * whose extension a brand reader takes; never in a project, the workspace's templates or components folder, a hidden
 * folder (`.retake/`) or the workspace's own configuration — a move of it sets nothing aside but that one file.
 */
async function brandSource(ws: OpenedWorkspace, ref: string): Promise<{ abs: string; real: string }> {
  if (typeof ref !== 'string' || ref === '' || ref.includes('\0') || isAbsolute(ref) || ref.split(/[\\/]/).some((s) => s === '..' || s === '' || s === '.' || s.startsWith('.'))) {
    throw new EngineError('invalid', `--brand ${String(ref).slice(0, 120)}: a brand file relative to the workspace root, no hidden part (e.g. brand/logo.svg)`);
  }
  if (!BRAND_FILE_EXTENSIONS.includes(extname(ref).toLowerCase())) {
    throw new EngineError(
      'refused',
      `--brand ${ref}: not a brand file — an image (${LOGO_EXTENSIONS.join(', ')}), a font (${FONT_EXTENSIONS.join(', ')}) or a design-token file (${TOKENS_EXTENSIONS.join(', ')}), one per --brand`,
    );
  }
  const abs = resolve(ws.root, ref);
  let st: Stats;
  try {
    st = await lstat(abs);
  } catch {
    throw new EngineError('not_found', `--brand ${ref}: not found in the workspace`);
  }
  if (st.isSymbolicLink()) throw new EngineError('refused', `--brand ${ref} is a symbolic link: name the file itself`);
  if (!st.isFile()) throw new EngineError('refused', `--brand ${ref} is not a file: name each brand file`);
  const real = realPathOf(abs, nodeFileFacts);
  const inside = (dir: string) => insideFolder(realPathOf(resolve(dir), nodeFileFacts), real, nodeFileFacts);
  if (!inside(ws.root)) throw new EngineError('refused', `--brand ${ref} leaves the workspace`);
  if (inside(ws.projectsDir)) throw new EngineError('refused', `--brand ${ref} lies in a project: brand files are adopted from the workspace`);
  if (inside(ws.templatesDir)) throw new EngineError('refused', `--brand ${ref} lies in the workspace's themes folder: a theme is adopted whole (--theme)`);
  if (inside(ws.componentsDir)) throw new EngineError('refused', `--brand ${ref} lies in the workspace's components folder: no brand file is taken from there`);
  if (inside(statePath(ws.root))) throw new EngineError('refused', `--brand ${ref} lies in the workspace's state folder`);
  return { abs, real };
}

/** The workspace themes whose provenance records an input under `ref` (they hold copies: nothing breaks; said). */
async function themesFromBrand(ws: OpenedWorkspace, ref: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await ws.reads.listTemplates(ws.root)) {
    if (e.source !== 'workspace') continue;
    try {
      const prov = JSON.parse(await readFile(join(e.dir, THEME_PROVENANCE_FILE), 'utf8')) as { inputs?: Record<string, unknown> };
      const text = JSON.stringify(prov.inputs ?? {});
      if (text.includes(`"${ref}"`) || text.includes(`"${ref}/`)) out.push(e.name);
    } catch {
      /* no provenance: not made from brand inputs */
    }
  }
  return out;
}

/** What an adopt of the brand file `ref` needs, every refusal checked (run for every item before any is done). */
async function brandTargetOf(pass: AdoptPass, ref: string): Promise<{ src: { abs: string; real: string }; posix: string; target: string; store: ProjectStore }> {
  const { ws, project, o } = pass;
  const src = await brandSource(ws, ref);
  const posix = ref.split(/[\\/]/).join('/');
  // Below the workspace's brand/: the same place under the project's; elsewhere: brand/<its name>.
  const below = posix.startsWith(`${PROJECT_LIBRARY_DIRS.brand}/`) ? posix.slice(PROJECT_LIBRARY_DIRS.brand.length + 1) : basename(posix);
  const store = o.scope.stores.of(project, o.scope);
  const target = `${PROJECT_LIBRARY_DIRS.brand}/${below}`;
  if (
    await lstat(store.resolve(target)).then(
      () => true,
      () => false,
    )
  )
    throw new EngineError('conflict', `project ${project.slug} already has ${target}: nothing adopted from ${ref} — remove or rename one of them by hand`);
  return { src, posix, target, store };
}

/** One brand file into `<project>/brand/` (see the header). */
async function adoptBrand(pass: AdoptPass, ref: string): Promise<AdoptedBrand> {
  const { ws, req, o, stamp, notes } = pass;
  const { src, posix, target, store } = await brandTargetOf(pass, ref);
  const hashOf = async () =>
    createHash('sha256')
      .update(await readFile(src.abs))
      .digest('hex');
  const before = req.mode === 'move' ? await hashOf() : undefined;
  const copied = [(await store.copyFileIn(target, src.abs, { what: 'brand' })).ref];
  const used = await themesFromBrand(ws, posix);
  if (used.length) notes.push(`${ref}: workspace themes made from it hold their own copies (${used.join(', ')}): nothing of theirs changes`);
  const out: AdoptedBrand = { from: ref, files: copied };
  if (req.mode === 'move') {
    out.moved_to = await setAside(ws, src.abs, {
      what: 'brand',
      name: basename(posix),
      stamp,
      scope: o.scope,
      check: async () => {
        if ((await hashOf()) !== before) throw new EngineError('conflict', `${ref} changed while it was adopted: the project's copy is made, the original stays — compare them and remove one by hand`);
      },
    });
  }
  return out;
}

/** The files of a component folder a copy takes (relative, `/`): hidden entries and node_modules left out; a link, a hard link or a special file refuses it. */
async function componentFiles(dir: string, id: string): Promise<string[]> {
  const out: string[] = [];
  let bytes = 0;
  const walk = async (rel: string) => {
    for (const e of await readdir(join(dir, rel), { withFileTypes: true })) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) throw new EngineError('refused', `component ${id} holds a symbolic link (${r}): copy it by hand`);
      if (e.isDirectory()) await walk(r);
      else if (e.isFile()) {
        const st = await lstat(join(dir, r));
        if (st.nlink > 1) throw new EngineError('refused', `component ${id} holds a file with another name (a hard link: ${r}): copy it by hand`);
        bytes += st.size;
        out.push(r);
        if (out.length > ADOPT_COMPONENT_FILES_MAX) throw new EngineError('refused', `component ${id} holds more than ${ADOPT_COMPONENT_FILES_MAX} files: copy it by hand`);
        if (bytes > ADOPT_COMPONENT_BYTES_MAX) throw new EngineError('refused', `component ${id} is larger than ${ADOPT_COMPONENT_BYTES_MAX / 1024 / 1024} MB: copy it by hand`);
      } else throw new EngineError('refused', `component ${id} holds a special file (${r}): copy it by hand`);
    }
  };
  await walk('');
  return out.sort();
}

/** Why a workspace component is not moved: who else uses it, a project or a workspace theme that does not open. */
async function componentMoveCheck(ws: OpenedWorkspace, project: LoadedProject, id: string): Promise<void> {
  const u = await usersOfWorkspaceComponent(ws, id, { except: project.slug });
  const list = (l: string[]) => `${l.slice(0, 10).join(', ')}${l.length > 10 ? ` and ${l.length - 10} more` : ''}`;
  if (u.users.length) {
    throw new EngineError('refused', `the workspace component ${id} is used by ${list(u.users)}: it is not moved — adopt a copy (--copy), or adopt it into those projects first`, {
      details: { users: u.users },
    });
  }
  if (u.unreadable.length) {
    throw new EngineError('refused', `${list(u.unreadable)} does not open: whether it uses the workspace component ${id} cannot be told — fix it, or adopt a copy (--copy)`, {
      details: { unreadable: u.unreadable },
    });
  }
}

/** What an adopt of the component `id` needs, every refusal checked (run for every item before any is done). */
async function componentSourceOf(pass: AdoptPass, id: string): Promise<{ dir: string; target: ComponentTarget; ns: string; name: string; nsDir: string; files: string[] }> {
  const { ws, project, req } = pass;
  checkComponentId(id);
  // A studio/ id is the built-in library's namespace: a workspace component there overrides a built-in for every
  // project (starter themes and defaults pick it): it stays the workspace's, whoever asks and however.
  if (id.split('/')[0] === BUILTIN_NAMESPACE) {
    throw new EngineError(
      'refused',
      `component id "${id}": the "${BUILTIN_NAMESPACE}/" namespace belongs to the built-in library — a workspace component of that id overrides the built-in one for every project and stays a workspace item: nothing adopted`,
    );
  }
  const reg = await workspaceRegistry(ws);
  const broken = reg.notices.find((n) => n.id === id && n.severity === 'error');
  if (!reg.has(id) && !broken) {
    try {
      reg.get(id);
    } catch (e) {
      throw toEngineError(e);
    }
  }
  const source = reg.has(id) ? reg.get(id) : undefined;
  if (source?.source === 'builtin') throw new EngineError('refused', `${id} is a built-in component shipped with Retake: every project uses it already — nothing to adopt`);
  const dir = source?.dir ?? broken!.dir;
  const valid = await ws.registries.catalogue.validate(dir);
  if (!valid.ok) throw new EngineError('refused', `the workspace component ${id} does not validate (retake components validate ${id}): fix it before a project adopts it`);
  const target = projectComponentTarget(ws, project, 'an adopted component');
  const [ns, name] = id.split('/') as [string, string];
  const nsDir = join(target.dir, ns);
  if ((await readdir(nsDir).catch(() => [] as string[])).some((e) => e.toLowerCase() === name.toLowerCase()))
    throw new EngineError(
      'conflict',
      `project ${project.slug} already has a component folder ${id} (${PROJECT_LIBRARY_DIRS.components}/${id}): nothing adopted — remove or rename one of them by hand`,
    );
  if (req.mode === 'move') await componentMoveCheck(ws, project, id);
  const files = await componentFiles(dir, id);
  return { dir, target, ns, name, nsDir, files };
}

/** One workspace component into the project (see the header). */
async function adoptComponent(pass: AdoptPass, id: string): Promise<AdoptedComponent> {
  const { ws, req, o, stamp } = pass;
  const { dir, target, ns, name, nsDir, files } = await componentSourceOf(pass, id);
  const before = await folderHashes(dir);
  try {
    const store = target.store(o.scope);
    // Its namespace folder first (inside the project's own components/, through the project's store).
    await store.makeFolder(projectLibraryRef('components', ns));
    await store.createFolder(nsDir, name, {
      what: 'component',
      build: async (stage) => {
        for (const f of files) {
          await stage.copy(f, join(dir, ...f.split('/')));
          const copied = createHash('sha256')
            .update(await readFile(join(stage.dir, ...f.split('/'))))
            .digest('hex');
          // Copied bytes are the ones validated (a source file changed meanwhile refuses the copy).
          if (copied !== before[f]) throw new EngineError('conflict', `component ${id}: ${f} changed while it was copied — try again`);
        }
      },
      recheck: async () => ({ existing: existsSync(join(nsDir, name)) }),
    });
  } catch (e) {
    throw toEngineError(e);
  }
  const out: AdoptedComponent = { id, dir: join(nsDir, name), files };
  if (req.mode === 'move') {
    let jobs: string[] = [];
    try {
      out.moved_to = await setAside(ws, dir, {
        what: 'component',
        name: `${ns}-${name}`,
        stamp,
        scope: o.scope,
        lockFile: 'component.yaml',
        check: async () => {
          // Read again under the lock: a job queued while the folder was copied may read it.
          jobs = await o.activeJobs();
          if (jobs.length) throw busyError(jobs);
          if (!sameHashes(before, await folderHashes(dir))) {
            throw new EngineError(
              'conflict',
              `the workspace component ${id} changed while it was adopted: the project's copy is made (${projectLibraryRef('components', ns, name)}), the workspace component stays — compare them and remove one by hand`,
            );
          }
        },
      });
    } catch (e) {
      if (jobs.length) await rm(out.dir, { recursive: true, force: true });
      throw e;
    }
  }
  return out;
}

/**
 * A refusal met after some items were done (a race since the check pass: a job, a change): its words and `details.done`
 * name what was already copied or moved, so the person knows the workspace's may be gone.
 */
function partialError(e: EngineError, out: AdoptResult): EngineError {
  const verb = out.mode === 'move' ? 'moved' : 'copied';
  const done = [
    ...out.themes.map((t) => `theme ${t.name} ${verb}${t.moved_to ? ` (the workspace's set aside in ${t.moved_to})` : ''}`),
    ...out.brand.map((b) => `${b.from} ${verb}${b.moved_to ? ` (set aside in ${b.moved_to})` : ''}`),
    ...(out.components ?? []).map((c) => `component ${c.id} ${verb}${c.moved_to ? ` (the workspace's set aside in ${c.moved_to})` : ''}`),
  ];
  if (!done.length) return e;
  const details = { ...((e.details as Record<string, unknown> | undefined) ?? {}), done: { themes: out.themes, brand: out.brand, components: out.components ?? [] } };
  return new EngineError(e.code, `${e.message} — done before it stopped, into project ${out.project}: ${done.join('; ')}`, { details, ...(e.fix ? { fix: e.fix } : {}) });
}

/** A project adopts workspace themes, components and brand files (see the header). Errors: invalid, not_found, refused, conflict. */
export async function adoptIntoProject(ws: OpenedWorkspace, req: AdoptRequest, o: AdoptOptions): Promise<AdoptResult> {
  const project = await openProjectBySlug(ws, checkProjectSlug(req.project));
  const themes = [...new Set(req.themes ?? [])];
  const brand = [...new Set(req.brand ?? [])];
  const components = [...new Set(req.components ?? [])];
  if (req.mode !== 'copy' && req.mode !== 'move') throw new EngineError('invalid', 'mode is copy or move');
  if (o.trust === 'mcp' && req.mode === 'move')
    throw new EngineError('refused', 'through MCP a workspace theme or component is only copied into a project (project_adopt): a person moves it with retake project adopt');
  if (o.trust === 'mcp' && brand.length) throw new EngineError('refused', 'brand files are never adopted through MCP: a person moves them with retake project adopt --brand <path>');
  if (!themes.length && !brand.length && !components.length) {
    throw new EngineError(
      'invalid',
      o.trust === 'mcp'
        ? 'name what the project adopts: workspace themes (themes) or workspace components (components)'
        : 'name what the project adopts: a workspace theme (--theme), a workspace component (--component) or brand files (--brand)',
    );
  }
  for (const t of themes) checkTemplateName(t);
  for (const c of components) checkComponentId(c);
  if (req.mode === 'move') {
    const jobs = await o.activeJobs();
    if (jobs.length) throw busyError(jobs);
  }
  const stamp = stampOf(o.scope);
  const notes: string[] = [];
  const out: AdoptResult = { project: project.slug, mode: req.mode, themes: [], brand: [], notes };
  const pass: AdoptPass = { ws, project, req, o, stamp, notes };
  // Every item checked first (users, validity, name clashes): one refused, nothing is done.
  for (const name of themes) await themeSourceOf(pass, name);
  for (const ref of brand) await brandTargetOf(pass, ref);
  for (const id of components) await componentSourceOf(pass, id);
  if (components.length) out.components = [];
  try {
    for (const name of themes) out.themes.push(await adoptTheme(pass, name));
    for (const ref of brand) out.brand.push(await adoptBrand(pass, ref));
    for (const id of components) out.components!.push(await adoptComponent(pass, id));
  } catch (e) {
    throw partialError(toEngineError(e), out);
  }
  if (out.themes.length) {
    notes.push("the project's earlier renders made with it still match: their theme name now finds the project's copy, of the same content");
  }
  return out;
}
