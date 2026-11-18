/**
 * A project adopts what it uses of the workspace (R-SHR-14): a workspace theme copied or moved into the
 * project's own `templates/`, brand files into its `brand/` — so the project folder alone carries its look. Components
 * can join the same request.
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
 * - project.yaml and the scenarios are not rewritten: the project's own theme of that name is found first. Earlier
 *   renders keep the workspace folder's identity, and still match: their theme name resolves to the project's copy,
 *   whose content hash is the one they hold (the board, an export). Other projects' renders of a moved theme are named.
 */
import { createHash } from 'node:crypto';
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
import { rendersOfThemeFolder, usersOfWorkspaceTheme } from './project-uses.js';
import { FONT_EXTENSIONS, LOGO_EXTENSIONS, TOKENS_EXTENSIONS } from './brand/files.js';
import { checkProjectSlug } from './refs.js';
import type { StoreScope } from './store/store.js';
import { checkNewThemeName, checkTemplateName } from './templates.js';
import { projectThemeTarget } from './theme-target.js';
import type { OpenedWorkspace } from './workspace.js';

/** Brand files one adopt copies, at most (a folder named whole). */
export const ADOPT_BRAND_FILES_MAX = 500;

export interface AdoptRequest {
  project: string;
  /** Workspace themes, by name. */
  themes?: string[];
  /** Brand files or folders, relative to the workspace root (a person only). */
  brand?: string[];
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

export interface AdoptResult {
  project: string;
  mode: 'copy' | 'move';
  themes: AdoptedTheme[];
  brand: AdoptedBrand[];
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
  a: { what: 'theme' | 'brand'; name: string; stamp: string; scope: StoreScope; check: () => Promise<void>; lockFile?: string },
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

/** One workspace theme into the project (see the header). */
async function adoptTheme(pass: AdoptPass, name: string): Promise<AdoptedTheme> {
  const { ws, project, req, o, stamp, notes } = pass;
  checkTemplateName(name);
  const source = await workspaceTheme(ws, name);
  const target = projectThemeTarget(ws, project, 'an adopted theme');
  if ((await readdir(target.dir).catch(() => [] as string[])).some((e) => e.toLowerCase() === name.toLowerCase()))
    throw new EngineError('conflict', `project ${project.slug} already has a theme folder ${name} (${PROJECT_LIBRARY_DIRS.templates}/${name}): nothing adopted — remove or rename one of them by hand`);
  if (req.mode === 'move') await moveUsersCheck(ws, project, name);
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

/** One brand file into `<project>/brand/` (see the header). */
async function adoptBrand(pass: AdoptPass, ref: string): Promise<AdoptedBrand> {
  const { ws, project, req, o, stamp, notes } = pass;
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

/** A project adopts workspace themes and brand files (see the header). Errors: invalid, not_found, refused, conflict. */
export async function adoptIntoProject(ws: OpenedWorkspace, req: AdoptRequest, o: AdoptOptions): Promise<AdoptResult> {
  const project = await openProjectBySlug(ws, checkProjectSlug(req.project));
  const themes = [...new Set(req.themes ?? [])];
  const brand = [...new Set(req.brand ?? [])];
  if (req.mode !== 'copy' && req.mode !== 'move') throw new EngineError('invalid', 'mode is copy or move');
  if (o.trust === 'mcp' && req.mode === 'move')
    throw new EngineError('refused', 'through MCP a workspace theme is only copied into a project (project_adopt): a person moves it with retake project adopt');
  if (o.trust === 'mcp' && brand.length) throw new EngineError('refused', 'brand files are never adopted through MCP: a person moves them with retake project adopt --brand <path>');
  if (!themes.length && !brand.length) throw new EngineError('invalid', 'name what the project adopts: a workspace theme (--theme) or brand files (--brand)');
  for (const t of themes) checkTemplateName(t);
  if (req.mode === 'move') {
    const jobs = await o.activeJobs();
    if (jobs.length) throw busyError(jobs);
  }
  const stamp = stampOf(o.scope);
  const notes: string[] = [];
  const out: AdoptResult = { project: project.slug, mode: req.mode, themes: [], brand: [], notes };
  const pass: AdoptPass = { ws, project, req, o, stamp, notes };
  for (const name of themes) out.themes.push(await adoptTheme(pass, name));
  for (const ref of brand) out.brand.push(await adoptBrand(pass, ref));
  if (out.themes.length) {
    notes.push("the project's earlier renders made with it still match: their theme name now finds the project's copy, of the same content");
  }
  return out;
}
