/**
 * A project's code files: what of a project folder runs, or is run by a renderer, a browser or a tool a person opens on
 * the folder — the list a person reads before `retake project trust` (and what an import records, from the files it
 * wrote, never from an archive's manifest). A file is listed for the first reason it meets:
 *
 * - `settings` — project.yaml itself, always (browser program and switches, sign-in profiles, environment variables
 *   passed on, reset hooks: settingsNotes says which);
 * - `tool-config` — every hidden file or file of a hidden folder (`.vscode/`, `.claude/`, `.idea/`, `.npmrc`…: what an
 *   editor, a shell prompt, git or an agent reads on opening the folder), and the files tools read by name anywhere
 *   (`CLAUDE.md`, `AGENTS.md`, `package.json`, `Makefile`…);
 * - `hooks` — every file under `hooks/` (shell, sql and http hooks, their scripts and data);
 * - `component` — every file under `components/` (a project's own components are rendered: their code runs);
 * - `sandbox` — each sandbox.yaml project.yaml names (`sandboxes:`) and every file of its folder (compose files, seed
 *   steps);
 * - `code` — any file with a code extension (scripts of every kind, `.sql`) or an executable bit, anywhere;
 * - `theme` — a theme's Lottie (`.json`: the renderer decides by extension, core media.ts) and SVG files under
 *   `templates/`, `assets/` and `brand/`, and any JSON file shaped like a Lottie (`v` and `layers`) anywhere;
 * - `scenario` — a scenario that names hooks, page code or a Lottie (setup, teardown, hooks, a hook / eval / js / sql
 *   step, `lottie:`);
 * - `named` — any file of the project (outputs included) that a scenario, a hooks file, project.yaml or a theme names by
 *   a file key (`file`, `lottie`, `script`, `path`, `src`): a sql hook's file in `data/`, a Lottie under `review/`.
 * Nothing in the folder is hidden from the walk but the state folder, `.env*` files and exports (never archived) and the
 * outputs (runs/, renders/, review/), whose named files only are listed. Links are listed as links, never followed.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { foldedArchiveKey, parseYaml, showHiddenCharsLine } from '@retake/core/base';
import { neverArchived, projectOutputPath, projectPath } from '@retake/core/project';
import { personaPaths } from '@retake/core/environment';
import { retakeHome } from '@retake/core/io';
import type { EngineEnv } from '../env.js';

/** Why a file is a code file (the module's list). */
export type CodeReason = 'settings' | 'tool-config' | 'hooks' | 'component' | 'sandbox' | 'code' | 'theme' | 'scenario' | 'named' | 'link';

/** One code file of a project: its project path (`/`), why it is one, its size and sha256 (a link: its target, no hash). */
export interface CodeFile {
  path: string;
  why: CodeReason;
  size: number;
  sha256: string;
}

/** The most files a listing walks (a project with more is refused by the export's caps first). */
export const CODE_WALK_MAX = 100_000;

const CODE_EXTENSIONS = [
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.mts',
  '.cts',
  '.tsx',
  '.jsx',
  '.sh',
  '.bash',
  '.zsh',
  '.fish',
  '.py',
  '.rb',
  '.pl',
  '.php',
  '.command',
  '.wasm',
  '.node',
  '.dylib',
  '.so',
  '.sql',
  '.ps1',
  '.bat',
  '.cmd',
  '.applescript',
  '.scpt',
];
const THEME_CODE_EXTENSIONS = ['.json', '.svg'];
const SCENARIO_CODE = /^\s*-?\s*(setup|teardown|hooks|hook|eval|js|shell|sql|http|lottie)\s*:/m;
/** Files tools read by name wherever they lie (an agent's instructions, a package's scripts, a build's recipes). */
const TOOL_FILES: readonly string[] = ['claude.md', 'agents.md', 'gemini.md', 'package.json', 'makefile', 'justfile', 'dockerfile', 'pyproject.toml', 'gemfile', 'procfile'];
/** The keys whose text value names a file a step, a hook or a theme opens. */
const FILE_KEYS: readonly string[] = ['file', 'lottie', 'script', 'path', 'src'];
/** The largest JSON file read to tell a Lottie. */
const LOTTIE_READ_MAX = 8 * 1024 * 1024;

const posixOf = (rel: string): string => rel.split(sep).join('/');
const hasExt = (name: string, list: readonly string[]): boolean => list.some((e) => foldedArchiveKey(name).endsWith(e));

/** The sha256 of a file, streamed. */
export async function fileSha256(file: string): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(file)) h.update(chunk as Buffer);
  return h.digest('hex');
}

/** The folders of the sandboxes project.yaml names (`sandboxes: {env: path/to/sandbox.yaml}`), project-relative, inside the project only. */
async function sandboxFolders(projectDir: string): Promise<string[]> {
  const text = await readFile(join(projectDir, 'project.yaml'), 'utf8').catch(() => '');
  const v = parseYaml(text).value as { sandboxes?: unknown } | undefined;
  const map = v && typeof v === 'object' ? v.sandboxes : undefined;
  if (!map || typeof map !== 'object' || Array.isArray(map)) return [];
  const out: string[] = [];
  for (const p of Object.values(map as Record<string, unknown>)) {
    if (typeof p !== 'string') continue;
    const rel = posixOf(relative(projectDir, join(projectDir, p)));
    if (rel.startsWith('..') || rel === '') continue;
    out.push(posixOf(dirname(rel)) === '.' ? '' : posixOf(dirname(rel)));
  }
  return out;
}

/** Whether a JSON text is shaped like a Lottie animation (a version and its layers). */
function lottieShaped(text: string): boolean {
  try {
    const v = JSON.parse(text) as unknown;
    return isObj(v) && 'v' in v && Array.isArray(v.layers);
  } catch {
    return false;
  }
}

/** Why the project file `rel` (of name `name`, mode `mode`) is a code file, or undefined. */
async function reasonOf(rel: string, name: string, st: { mode: number; size: number }, sandboxes: readonly string[], text: () => Promise<string>): Promise<CodeReason | undefined> {
  const { mode, size } = st;
  const segments = rel.split('/');
  const first = foldedArchiveKey(segments[0] ?? '');
  if (rel === 'project.yaml') return 'settings';
  if (segments.some((s) => s.startsWith('.')) || TOOL_FILES.includes(foldedArchiveKey(name))) return 'tool-config';
  if (first === 'hooks') return 'hooks';
  if (first === 'components') return 'component';
  if (sandboxes.some((d) => (d === '' ? foldedArchiveKey(name) === 'sandbox.yaml' : rel.startsWith(`${d}/`)))) return 'sandbox';
  if (hasExt(name, CODE_EXTENSIONS) || (mode & 0o111) !== 0) return 'code';
  if ((first === 'templates' || first === 'assets' || first === 'brand') && hasExt(name, THEME_CODE_EXTENSIONS)) return 'theme';
  if (hasExt(name, ['.json']) && size <= LOTTIE_READ_MAX && lottieShaped(await text())) return 'theme';
  if (first === 'scenarios' && hasExt(name, ['.yaml', '.yml']) && SCENARIO_CODE.test(await text())) return 'scenario';
  return undefined;
}

/** Every text value under a file key (FILE_KEYS) in a parsed YAML value. */
function fileRefs(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) for (const x of v) fileRefs(x, out);
  else if (isObj(v))
    for (const [k, x] of Object.entries(v)) {
      if (FILE_KEYS.includes(k) && typeof x === 'string') out.push(x);
      else fileRefs(x, out);
    }
  return out;
}

/**
 * The project paths the project's files name by a file key, inside the project: the scenarios', the hooks files' and
 * project.yaml's (relative to the project), and each theme's template.yaml (relative to the theme, else the project).
 */
async function namedFiles(projectDir: string, yamls: readonly string[]): Promise<string[]> {
  const out = new Set<string>();
  for (const rel of yamls) {
    const text = await readFile(join(projectDir, rel), 'utf8').catch(() => '');
    const bases = [projectDir, ...(rel.startsWith('templates/') ? [join(projectDir, dirname(rel))] : [])];
    for (const ref of fileRefs(parseYaml(text).value)) {
      if (ref.startsWith('/') || ref.startsWith('~') || ref.includes('{{') || /^[a-z]+:/i.test(ref)) continue;
      for (const base of bases) {
        const at = posixOf(relative(projectDir, join(base, ref)));
        if (at && !at.startsWith('..')) out.add(at);
      }
    }
  }
  return [...out];
}

/** One file of the walk, judged. */
async function judged(projectDir: string, r: string, name: string, sandboxes: readonly string[]): Promise<CodeFile | undefined> {
  const abs = join(projectDir, r);
  const st = await lstat(abs);
  const why = await reasonOf(r, name, st, sandboxes, () => readFile(abs, 'utf8').catch(() => ''));
  return why ? { path: r, why, size: st.size, sha256: await fileSha256(abs) } : undefined;
}

/**
 * The code files of the project folder `projectDir`, sorted by path: what `retake project trust` lists and an import
 * records (from the files it wrote). The state folder, `.env*` files and exports are skipped, and the outputs but for
 * the files a project file names.
 */
export async function projectCodeFiles(projectDir: string): Promise<CodeFile[]> {
  const sandboxes = await sandboxFolders(projectDir);
  const out = new Map<string, CodeFile>();
  const yamls: string[] = [];
  let seen = 0;
  const walk = async (rel: string): Promise<void> => {
    const entries = await readdir(rel ? join(projectDir, rel) : projectDir, { withFileTypes: true }).catch(() => []);
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      const never = neverArchived(r);
      if (never === 'state' || never === 'env' || never === 'exports' || projectOutputPath(r)) continue;
      if (++seen > CODE_WALK_MAX) return;
      if (e.isSymbolicLink()) out.set(r, { path: r, why: 'link', size: 0, sha256: '' });
      else if (e.isDirectory()) await walk(r);
      else if (e.isFile()) {
        if (/\.ya?ml$/i.test(e.name) && /^(scenarios|hooks|templates)\/|^project\.yaml$/i.test(r)) yamls.push(r);
        const f = await judged(projectDir, r, e.name, sandboxes);
        if (f) out.set(r, f);
      }
    }
  };
  await walk('');
  for (const r of await namedFiles(projectDir, yamls)) {
    if (out.has(r) || neverArchived(r) === 'state') continue;
    const st = await lstat(join(projectDir, r)).catch(() => undefined);
    if (st?.isFile()) out.set(r, { path: r, why: 'named', size: st.size, sha256: await fileSha256(join(projectDir, r)) });
  }
  return [...out.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** The code files as a table `{path: sha256}` (a link: `link`): what an import's mark records. */
export function codeFileTable(files: readonly CodeFile[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of files) out[f.path] = f.why === 'link' ? 'link' : f.sha256;
  return out;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const shown = (v: unknown): string => showHiddenCharsLine(typeof v === 'string' ? v : JSON.stringify(v));
/** A path that leaves the project folder: absolute, `~`, or climbing out. */
const leaves = (p: unknown): boolean => typeof p === 'string' && (p.startsWith('/') || p.startsWith('~') || /^[A-Za-z]:/.test(p) || p.split(/[\\/]/).includes('..'));

/**
 * The notes of every browser block and every sign-in profile or saved state, at any depth of a YAML value (project.yaml's
 * `browser:`, `render.browser`, an environment's own, `auth.profile`, `auth.<env>.storage_state`…), each with its key
 * path: the browser program a run, a sign-in or a render starts and its switches; a person's browser profile copied,
 * cookies read.
 */
function deepNotes(v: unknown, at: string, out: string[]): string[] {
  if (Array.isArray(v)) v.forEach((x, i) => deepNotes(x, `${at}[${i}]`, out));
  else if (isObj(v))
    for (const [k, x] of Object.entries(v)) {
      const path = at ? `${at}.${shown(k)}` : shown(k);
      if (k === 'executable' && at.endsWith('browser')) out.push(`${path}: ${shown(x)} — the browser program a run, a sign-in or a render starts`);
      else if (k === 'args' && at.endsWith('browser') && Array.isArray(x) && x.length) out.push(`${path}: ${x.map(shown).join(' ')}`);
      else if ((k === 'profile' || k === 'storage_state') && at.split('.')[0] === 'auth' && typeof x === 'string')
        out.push(`${path}: ${shown(x)}${leaves(x) ? ' (outside the project)' : ''} — a sign-in's ${k === 'profile' ? 'browser profile, copied for each run' : 'saved cookies'}`);
      else deepNotes(x, path, out);
    }
  return out;
}

/** The scenarios' own theme references that leave the project (an archive not made by our export may hold one). */
async function scenarioThemeNotes(projectDir: string): Promise<string[]> {
  const out: string[] = [];
  const names = (await readdir(projectPath(projectDir, 'scenarios')).catch(() => [] as string[])).filter((n) => /\.ya?ml$/i.test(n)).sort();
  for (const n of names) {
    const v = parseYaml(await readFile(projectPath(projectDir, 'scenarios', n), 'utf8').catch(() => '')).value;
    const refs = isObj(v) ? [v.template, isObj(v.video) ? v.video.template : undefined] : [];
    for (const r of refs) if (leaves(r)) out.push(`scenario ${shown(n)}: template ${shown(r)} (outside the project)`);
  }
  return out;
}

/**
 * What project.yaml asks of this machine that runs or reads something — the browser programs and their switches, the
 * sign-in profiles and saved cookies (at every level), the environment variables passed on to hooks, the reset hooks,
 * the sandboxes and the themes it names outside the project — and the scenarios' themes outside it, one line each,
 * every value shown with its hidden characters written out.
 */
export async function settingsNotes(projectDir: string): Promise<string[]> {
  const text = await readFile(join(projectDir, 'project.yaml'), 'utf8').catch(() => '');
  const v = parseYaml(text).value;
  if (!isObj(v)) return [...(text ? ['project.yaml does not read as YAML: it is listed whole'] : []), ...(await scenarioThemeNotes(projectDir))];
  const out = deepNotes(v, '', []);
  if (Array.isArray(v.pass_env) && v.pass_env.length) out.push(`pass_env: ${v.pass_env.map(shown).join(', ')} — passed on to its hooks`);
  if (Array.isArray(v.reset) && v.reset.length) out.push(`reset: ${v.reset.length} hook(s) — run by \`retake env reset\``);
  if (isObj(v.sandboxes)) for (const [env, p] of Object.entries(v.sandboxes)) if (leaves(p)) out.push(`sandboxes.${shown(env)}: ${shown(p)} (outside the project)`);
  if (leaves(v.template)) out.push(`template: ${shown(v.template)} (outside the project)`);
  return [...out, ...(await scenarioThemeNotes(projectDir))];
}

/** The saved sessions this machine holds for a project slug (`env/persona`, from the Retake home): a project imported under that slug would use them. */
export async function savedSessionsOf(slug: string, env: EngineEnv): Promise<string[]> {
  const home = retakeHome(env);
  const out = new Set<string>();
  for (const base of [dirname(personaPaths(home, slug, 'e', 'p').snapshot), dirname(personaPaths(home, slug, 'e', 'p').profileDir)]) {
    const projectFolder = dirname(base);
    for (const e of await readdir(projectFolder, { withFileTypes: true }).catch(() => [])) {
      if (!e.isDirectory()) continue;
      for (const p of await readdir(join(projectFolder, e.name)).catch(() => [] as string[])) out.add(`${e.name}/${p.replace(/(\.status)?\.json$/, '')}`);
    }
  }
  return [...out].sort().map(showHiddenCharsLine);
}
