/**
 * What a project archive holds (export.ts writes it): the project folder walked — no link followed, the never-list
 * left out (core project-archive.ts), runs, renders and reviews only with `with_runs` — plus, so that the archive is
 * self-contained, the workspace themes and workspace components the project uses, under the project's own
 * `templates/<name>/` and `components/<namespace>/<name>/` (where the import writes them: they become the project's).
 * Starters and built-in components ship with every Retake: named (`uses`), not embedded.
 *
 * Left out by path too: the files project.yaml names as a sign-in's saved state or profile, and the secrets, configs and
 * env files of the compose files its sandboxes name. What the project needs on the machine it goes to is said by name
 * only (`needs`): its `{{env:…}}` and `{{keychain:…}}` references, the variables passed on, the personas to sign in.
 * What looks like a literal token in its files is warned about (file and lines, never the value), never removed.
 * A theme named by a path outside the project is refused: copy it into the project (a workspace theme: retake project
 * adopt) and name it by its name.
 */
import { isUtf8 } from 'node:buffer';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { collectSecretRefs, foldedArchiveKey, parseYaml, pathInside, showHiddenCharsLine } from '@retake/core/base';
import { PROJECT_DIRS, literalTokenLines, neverArchived, projectOutputPath, projectRef, scenarioFile } from '@retake/core/project';
import { recordProblem } from './import.js';
import { resolvePersonas } from '@retake/core/environment';
import { retakeHome, nodeFileFacts } from '@retake/core/io';
import { realPathOf } from '@retake/core/policy';
import type { LoadedProject } from '@retake/core/project';
import { ZIP_ENTRIES_MAX } from '../archive/limits.js';
import { projectRegistry } from '../components.js';
import type { EngineEnv } from '../env.js';
import { EngineError } from '../errors.js';
import { namesComponent, themeRefsOf } from '../project-uses.js';
import type { OpenedWorkspace } from '../workspace.js';
import type { ArchiveExcluded, ArchiveNeeds, ArchiveOrigin, TokenWarning } from './manifest.js';

/** One file the archive takes: its project path, where it is read from, its size, mode and time, and its origin. */
export interface PlannedFile {
  path: string;
  from: string;
  size: number;
  mode: 0o644 | 0o755;
  mtime: Date;
  origin: ArchiveOrigin;
}

export interface ArchivePlan {
  slug: string;
  name: string;
  withRuns: boolean;
  files: PlannedFile[];
  bytes: number;
  embedded: { themes: string[]; components: string[] };
  uses: { starters: string[]; builtin_components: string[] };
  needs: ArchiveNeeds;
  excluded: ArchiveExcluded;
  warnings: { literal_tokens: TokenWarning[] };
}

const posix = (p: string): string => p.split(sep).join('/');
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const byPath = <T extends { path: string }>(a: T, b: T): number => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

/** What a walk gathers. */
interface Walk {
  files: PlannedFile[];
  excluded: ArchiveExcluded;
  /** Project paths left out by name (a sign-in's state, a compose secret): files and folders. */
  skip: (rel: string) => boolean;
  withRuns: boolean;
}

/** Walk `dir` into the archive under the project path `base` (`''`: the project itself), the never-list left out. */
async function walkInto(w: Walk, dir: string, base: string, origin: ArchiveOrigin): Promise<void> {
  const walk = async (sub: string): Promise<void> => {
    const entries = await readdir(sub ? join(dir, ...sub.split('/')) : dir, { withFileTypes: true });
    for (const e of entries) {
      const local = sub ? `${sub}/${e.name}` : e.name;
      const rel = base ? `${base}/${local}` : local;
      const never = neverArchived(rel);
      if (never === 'env' || never === 'sensitive') w.excluded[never].push(rel);
      if (never) continue;
      if (origin === 'project' && !w.withRuns && projectOutputPath(rel)) continue;
      if (w.skip(rel)) {
        w.excluded.sensitive.push(rel);
        continue;
      }
      if (e.isSymbolicLink()) w.excluded.links.push(rel);
      else if (e.isDirectory()) await walk(local);
      else if (!e.isFile()) w.excluded.special.push(rel);
      else {
        const abs = join(dir, ...local.split('/'));
        const st = await lstat(abs);
        w.files.push({ path: rel, from: abs, size: st.size, mode: st.mode & 0o111 ? 0o755 : 0o644, mtime: st.mtime, origin });
        if (w.files.length >= ZIP_ENTRIES_MAX) throw new EngineError('refused', `the project holds more than ${ZIP_ENTRIES_MAX - 1} files: a project archive holds at most that many`);
      }
    }
  };
  await walk('');
}

/** Every string value under a key named one of `keys`, anywhere in a YAML value. */
function valuesOf(v: unknown, keys: ReadonlySet<string>, out: string[] = []): string[] {
  if (Array.isArray(v)) for (const x of v) valuesOf(x, keys, out);
  else if (isObj(v))
    for (const [k, x] of Object.entries(v)) {
      if (keys.has(k) && typeof x === 'string') out.push(x);
      else valuesOf(x, keys, out);
    }
  return out;
}

const yamlOf = async (file: string): Promise<unknown> => parseYaml(await readFile(file, 'utf8').catch(() => '')).value;

/** A path a project file names, as a project path (`/`), when it lies inside the project. */
function insideProject(project: LoadedProject, base: string, p: string): string | undefined {
  const abs = resolve(base, p);
  return pathInside(abs, project.dir) ? posix(relative(project.dir, abs)) : undefined;
}

/** The compose files' secrets, configs and env files, and sandbox.yaml's env file, as project paths. */
async function composeSecrets(project: LoadedProject): Promise<string[]> {
  const out: string[] = [];
  const sandboxes = isObj(project.config.sandboxes) ? Object.values(project.config.sandboxes) : [];
  for (const s of sandboxes) {
    if (typeof s !== 'string') continue;
    const file = resolve(project.dir, s);
    const sb = await yamlOf(file);
    const compose = isObj(sb) && isObj(sb.compose) ? sb.compose : {};
    if (typeof compose.env_file === 'string') out.push(insideProject(project, dirname(file), compose.env_file) ?? '');
    const files = Array.isArray(compose.files) ? compose.files.filter((f): f is string => typeof f === 'string') : ['compose.yaml'];
    for (const f of files) {
      const cf = resolve(dirname(file), f);
      const c = await yamlOf(cf);
      if (!isObj(c)) continue;
      const named = [...valuesOf(c.secrets, new Set(['file'])), ...valuesOf(c.configs, new Set(['file'])), ...valuesOf(c.services, new Set(['env_file', 'path']))];
      if (isObj(c.services)) for (const svc of Object.values(c.services)) if (isObj(svc) && Array.isArray(svc.env_file)) named.push(...svc.env_file.filter((x): x is string => typeof x === 'string'));
      for (const n of named) out.push(insideProject(project, dirname(cf), n) ?? '');
    }
  }
  return out.filter(Boolean);
}

/** The project paths the never-list misses but a project file names as secret: a sign-in's saved state or profile, the sandboxes' secrets. */
async function namedSecrets(project: LoadedProject): Promise<(rel: string) => boolean> {
  const yaml = await yamlOf(join(project.dir, 'project.yaml'));
  const auth = valuesOf(yaml, new Set(['storage_state', 'profile'])).map((p) => insideProject(project, project.dir, p.replace(/^~(?=\/)/, '/nonexistent')) ?? '');
  const all = [...auth, ...(await composeSecrets(project))].filter(Boolean).map(foldedArchiveKey);
  return (rel) => {
    const k = foldedArchiveKey(rel);
    return all.some((s) => k === s || k.startsWith(`${s}/`));
  };
}

/** The workspace themes the project uses (embedded) and the starters it names; a path theme outside the project refused. */
async function themesOf(ws: OpenedWorkspace, project: LoadedProject): Promise<{ embed: Array<{ name: string; dir: string }>; starters: string[]; dirs: string[] }> {
  const embed = new Map<string, string>();
  const starters = new Set<string>();
  const dirs = new Set<string>();
  for (const r of themeRefsOf(project)) {
    const f = await ws.reads.projectTemplateFolder(project, r.ref);
    dirs.add(f.dir);
    if (f.via === 'starter') starters.add(r.ref);
    else if (f.via === 'workspace') embed.set(r.ref, f.dir);
    else if (f.via === 'path' && !pathInside(realPathOf(f.dir, nodeFileFacts), realPathOf(project.dir, nodeFileFacts))) {
      const where = r.scenario === undefined ? 'project.yaml' : `scenario ${showHiddenCharsLine(r.scenario)}`;
      throw new EngineError(
        'refused',
        `${where} names the theme ${showHiddenCharsLine(r.ref)} by a path outside the project: a project archive holds the project's own themes and the workspace's it uses by name — copy the theme into projects/${project.slug}/templates/<name>/ (a workspace theme: retake project adopt ${project.slug} --theme <name>) and name it by its name, then export again`,
        { fix: `retake project adopt ${project.slug} --theme <name>` },
      );
    }
  }
  return { embed: [...embed].map(([name, dir]) => ({ name, dir })), starters: [...starters].sort(), dirs: [...dirs] };
}

/** The workspace components the project uses (by a project file naming them, or a theme it uses picking them), and the built-in ones. */
async function componentsOf(ws: OpenedWorkspace, project: LoadedProject, themeDirs: readonly string[]): Promise<{ embed: Array<{ id: string; dir: string }>; builtin: string[] }> {
  const registry = await projectRegistry(ws, project);
  const texts: string[] = [await readFile(join(project.dir, 'project.yaml'), 'utf8').catch(() => '')];
  for (const s of project.scenarios) texts.push(await readFile(scenarioFile(project.dir, s), 'utf8').catch(() => ''));
  const picked = new Set<string>();
  for (const dir of themeDirs) {
    texts.push(await readFile(join(dir, 'template.yaml'), 'utf8').catch(() => ''));
    try {
      const t = await ws.reads.loadTemplate(dir, undefined, { files: ws.reads.fileFacts(ws.policy) });
      for (const c of Object.values(registry.resolveTheme(t.template))) if (c) picked.add(c.id);
    } catch {
      /* a theme that does not load picks nothing more than its text names */
    }
  }
  const embed: Array<{ id: string; dir: string }> = [];
  const builtin: string[] = [];
  for (const c of registry.list()) {
    const id = c.manifest.id;
    if (!picked.has(id) && !texts.some((t) => namesComponent(t, id))) continue;
    if (c.source === 'workspace') embed.push({ id, dir: c.dir });
    else if (c.source === 'builtin') builtin.push(id);
  }
  return { embed, builtin: builtin.sort() };
}

/** The secret references and personas of the project (names only). */
async function needsOf(project: LoadedProject, files: readonly PlannedFile[], env: EngineEnv): Promise<ArchiveNeeds> {
  const refs = new Set<string>();
  for (const f of files) {
    if (!/\.(ya?ml|json|sql|sh|txt)$/i.test(f.path) || f.size > 1024 * 1024 || f.origin !== 'project') continue;
    const text = await readFile(f.from, 'utf8').catch(() => '');
    collectSecretRefs(/\.ya?ml$/i.test(f.path) ? (parseYaml(text).value ?? text) : text, refs);
  }
  const sessions: ArchiveNeeds['sessions'] = [];
  const envs = new Set([...Object.keys(project.config.environments ?? {}), ...Object.keys(project.sandboxes ?? {})]);
  for (const e of envs) {
    try {
      for (const p of resolvePersonas(project, e, { home: retakeHome(env) })) sessions.push({ env: e, persona: p.name });
    } catch {
      /* an environment whose personas do not resolve needs none we can name */
    }
  }
  const list = [...refs].sort();
  return {
    env_vars: list.filter((r) => r.startsWith('env:')).map((r) => r.slice(4)),
    keychain: list.filter((r) => r.startsWith('keychain:')).map((r) => r.slice(9)),
    pass_env: Array.isArray(project.config.pass_env) ? project.config.pass_env.map(String) : [],
    sessions,
  };
}

/** The literal-token warnings: lines of the project's text files (any extension) shaped like a token, and `headers:` values that are not templated. */
async function tokenWarnings(files: readonly PlannedFile[]): Promise<TokenWarning[]> {
  const out: TokenWarning[] = [];
  for (const f of files) {
    // Every text file of the project's own under the cap, whatever its extension (bytes that are not UTF-8: no text).
    if (f.origin !== 'project' || f.size > 1024 * 1024 || projectOutputPath(f.path)) continue;
    const bytes = await readFile(f.from).catch(() => Buffer.alloc(0));
    if (!isUtf8(bytes)) continue;
    const text = bytes.toString('utf8');
    const lines = literalTokenLines(text);
    if (lines.length) out.push({ file: f.path, lines: lines.slice(0, 100), what: 'a value shaped like a key or a token' });
    if (f.path === 'project.yaml') {
      const literal = valuesOf(parseYaml(text).value, new Set(['headers'])).length;
      const headers = text.split('\n').flatMap((l, i) => (/^\s+[A-Za-z][\w-]*:\s*\S/.test(l) && !/\{\{/.test(l) && inHeaders(text, i) ? [i + 1] : []));
      if (headers.length || literal) out.push({ file: f.path, lines: headers.slice(0, 100), what: 'a literal value under headers: (a token belongs in {{env:…}} or {{keychain:…}})' });
    }
  }
  return out.filter((w) => w.lines.length);
}

/** Whether line `i` of a YAML text lies in a `headers:` block (by indentation). */
function inHeaders(text: string, i: number): boolean {
  const lines = text.split('\n');
  const ind = (l: string) => l.length - l.trimStart().length;
  const mine = ind(lines[i]!);
  for (let j = i - 1; j >= 0; j--) {
    const l = lines[j]!;
    if (!l.trim() || l.trimStart().startsWith('#')) continue;
    if (ind(l) < mine) return /^\s*headers:\s*$/.test(l);
  }
  return false;
}

/**
 * The files without the renders whose record names a file outside the project (its plan's theme assets: a starter's or
 * a workspace theme's), nor their videos, stills and reviews: an import refuses such a record (import.ts
 * recordProblem), so they are left out here and said (`excluded.outside_renders`: re-render after the import).
 */
async function withoutOutsideRenders(files: PlannedFile[], excluded: ArchiveExcluded): Promise<PlannedFile[]> {
  const prefixes: string[] = [];
  for (const f of files) {
    const m = /^renders\/([^/]+)\.json$/.exec(f.path);
    if (!m || f.size > 16 * 1024 * 1024) continue;
    let value: unknown;
    try {
      value = JSON.parse(await readFile(f.from, 'utf8'));
    } catch {
      continue;
    }
    if (!recordProblem('render', value, PROJECT_DIRS.renders, '')) continue;
    excluded.outside_renders.push(m[1]!);
    prefixes.push(projectRef('renders', `${m[1]}.`), `${projectRef('review', m[1]!)}/`);
  }
  excluded.outside_renders.sort();
  return prefixes.length ? files.filter((f) => !prefixes.some((p) => f.path.startsWith(p))) : files;
}

/** The plan of a project's archive (the module's header). */
export async function planProjectArchive(ws: OpenedWorkspace, project: LoadedProject, o: { withRuns: boolean; env: EngineEnv }): Promise<ArchivePlan> {
  const excluded: ArchiveExcluded = { env: [], sensitive: [], links: [], special: [], outside_renders: [] };
  const w: Walk = { files: [], excluded, skip: await namedSecrets(project), withRuns: o.withRuns };
  await walkInto(w, project.dir, '', 'project');
  const themes = await themesOf(ws, project);
  for (const t of themes.embed) await walkInto(w, t.dir, `templates/${t.name}`, 'workspace-theme');
  const components = await componentsOf(ws, project, themes.dirs);
  for (const c of components.embed) await walkInto(w, c.dir, `components/${c.id}`, 'workspace-component');
  const files = (await withoutOutsideRenders(w.files, excluded)).sort(byPath);
  for (let i = 1; i < files.length; i++)
    if (foldedArchiveKey(files[i]!.path) === foldedArchiveKey(files[i - 1]!.path))
      throw new EngineError('refused', `two files of the archive would be one on a Mac's disk: ${showHiddenCharsLine(files[i - 1]!.path)} and ${showHiddenCharsLine(files[i]!.path)} — rename one`);
  for (const k of ['env', 'sensitive', 'links', 'special'] as const) excluded[k].sort();
  return {
    slug: project.slug,
    name: project.config.name ?? project.slug,
    withRuns: o.withRuns,
    files,
    bytes: files.reduce((n, f) => n + f.size, 0),
    embedded: { themes: themes.embed.map((t) => t.name).sort(), components: components.embed.map((c) => c.id).sort() },
    uses: { starters: themes.starters, builtin_components: components.builtin },
    needs: await needsOf(project, files, o.env),
    excluded,
    warnings: { literal_tokens: await tokenWarnings(files) },
  };
}
