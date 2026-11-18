/**
 * The untrusted state of a project imported from a project archive, and the gate that keeps it inert.
 *
 * An import leaves two halves of one mark, with one `import_id`:
 * - the workspace's mark `<root>/.retake/imports/<slug>.json` — written before the imported folder is renamed into
 *   place (a crash in between leaves a mark and no folder, never a trusted folder); outside the project folder and
 *   every agent-writable path; `trusted` (once a person trusted it) is signed with the Retake home's key (core
 *   home-key.ts) over the slug, the import id, the time and the code files then listed;
 * - the marker inside the project `<project>/.retake/import.json` — it travels with a moved or copied folder and is
 *   never archived (an archive that holds one is refused).
 *
 * The rule fails closed (importTrust): a folder with neither is an ordinary project (`none`); it is `trusted` only when
 * both halves exist, name the same import id and the workspace's mark holds a `trusted` stanza signed with this home's
 * key for that slug and id; anything else — a marker with no mark (a folder moved or copied into another workspace, a
 * stale slug), a mark with no marker (the marker removed), two ids, an unreadable or unsigned mark, another home's key —
 * is `untrusted`. Whoever can read the Retake home can sign: the boundary is that only `retake project import` and
 * `retake project trust` (a person's commands) write the marks.
 *
 * An untrusted project is inert: of the catalogue's operations only reads and the allow-list (catalogue
 * `allowedOnUntrusted`) run on it, through every channel (invoke, the worker's handleJob, the CLI's commands), and the
 * product's ports refuse its hooks, sandboxes, browsers and renders below them (guard.ts).
 */
import { randomBytes } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { canonicalJson, showHiddenCharsLine } from '@retake/core/base';
import { homeKey, homeKeyFile, homeSign, homeSigned, nodeFileFacts, readHomeKey } from '@retake/core/io';
import { realPathOf } from '@retake/core/policy';
import { IMPORT_MARKER_FILE, PROJECT_SLUG_RE, statePath } from '@retake/core/project';
import { CATALOGUE, allowedOnUntrusted, catalogueOperation } from '../catalogue.js';
import type { Operation } from '../catalogue.js';
import type { EngineEnv } from '../env.js';
import { EngineError } from '../errors.js';
import { storedJson } from '../stored-json.js';

/** The version of the marks this Retake writes. */
const MARK_VERSION = 1;

const hex64 = z.string().regex(/^[0-9a-f]{64}$/);
const importId = z.string().regex(/^[0-9a-f]{32}$/);
const codeTable = z.record(z.string(), z.string());

/** The workspace's half of an import's mark. */
const MarkSchema = z.object({
  v: z.literal(MARK_VERSION),
  slug: z.string().regex(PROJECT_SLUG_RE),
  import_id: importId,
  imported_at: z.string(),
  archive: z.object({ name: z.string(), sha256: hex64 }),
  from_retake: z.string(),
  code_files: codeTable,
  trusted: z.object({ at: z.string(), files: codeTable, sig: hex64 }).optional(),
});
export type ImportMark = z.infer<typeof MarkSchema>;

/** The project's half (its state folder). */
const MarkerSchema = z.object({ v: z.literal(MARK_VERSION), import_id: importId });
export type ImportMarker = z.infer<typeof MarkerSchema>;

/** Where a project's half and the workspace's half of an import's mark lie. */
export interface ImportPlace {
  /** The workspace root. */
  root: string;
  /** The project folder. */
  dir: string;
  slug: string;
}

/** The workspace's mark of an imported slug. */
export function importMarkFile(root: string, slug: string): string {
  if (!PROJECT_SLUG_RE.test(slug) || slug.length > 100) throw new EngineError('invalid', `not a project slug: ${JSON.stringify(slug.slice(0, 80))} (lower-case letters, digits and "-")`);
  return statePath(root, 'imports', `${slug}.json`);
}

/** The marker inside an imported project. */
export function importMarkerFile(projectDir: string): string {
  return statePath(projectDir, undefined, IMPORT_MARKER_FILE);
}

/** A new import id (32 hex). */
export function newImportId(): string {
  return randomBytes(16).toString('hex');
}

/** Whether a project is an ordinary one, an import not trusted (and why, in fixed words), or an import a person trusted. */
export type ImportTrust = { state: 'none' } | { state: 'untrusted'; why: string; mark?: ImportMark } | { state: 'trusted'; mark: ImportMark };

/** A file's text, `missing` when it is not there, `unreadable` otherwise (a folder, a link, no permission). */
async function textOf(file: string): Promise<string | 'missing' | 'unreadable'> {
  const st = await lstat(file).catch((e: NodeJS.ErrnoException) => (e.code === 'ENOENT' || e.code === 'ENOTDIR' ? 'missing' : 'unreadable'));
  if (st === 'missing' || st === 'unreadable') return st;
  if (!st.isFile() || st.size > 4 * 1024 * 1024) return 'unreadable';
  return readFile(file, 'utf8').catch(() => 'unreadable' as const);
}

/** What the signature of a trust covers. */
function trustedText(mark: Pick<ImportMark, 'slug' | 'import_id'>, at: string, files: Record<string, string>): string {
  return canonicalJson({ v: MARK_VERSION, what: 'project-trust', slug: mark.slug, import_id: mark.import_id, at, files });
}

/** The workspace's mark of `slug`, or `missing`, or `unreadable` (bad JSON, another shape, another slug). */
export async function readImportMark(root: string, slug: string): Promise<ImportMark | 'missing' | 'unreadable'> {
  // A folder whose name is no slug has no mark of its own (its marker alone then makes it untrusted).
  if (!PROJECT_SLUG_RE.test(slug) || slug.length > 100) return 'missing';
  const text = await textOf(importMarkFile(root, slug));
  if (text === 'missing' || text === 'unreadable') return text;
  const v = storedJson(MarkSchema, text) as ImportMark | undefined;
  return v && v.slug === slug ? v : 'unreadable';
}

/** The marker inside a project, or `missing`, or `unreadable`. */
export async function readImportMarker(projectDir: string): Promise<ImportMarker | 'missing' | 'unreadable'> {
  const text = await textOf(importMarkerFile(projectDir));
  if (text === 'missing' || text === 'unreadable') return text;
  return (storedJson(MarkerSchema, text) as ImportMarker | undefined) ?? 'unreadable';
}

/** Whether the mark's `trusted` stanza is signed with this home's key (`env`: whose RETAKE_HOME). */
async function signedTrust(mark: ImportMark, env: EngineEnv): Promise<boolean> {
  if (!mark.trusted) return false;
  const key = await readHomeKey(homeKeyFile(env));
  return homeSigned(key, trustedText(mark, mark.trusted.at, mark.trusted.files), mark.trusted.sig);
}

/** The import trust of a project (the module's rule; fails closed). */
export async function importTrust(at: ImportPlace, env: EngineEnv): Promise<ImportTrust> {
  const [mark, marker] = await Promise.all([readImportMark(at.root, at.slug), readImportMarker(at.dir)]);
  if (mark === 'missing' && marker === 'missing') return { state: 'none' };
  const m = typeof mark === 'object' ? mark : undefined;
  const untrusted = (why: string): ImportTrust => ({ state: 'untrusted', why, ...(m ? { mark: m } : {}) });
  if (marker === 'missing') return untrusted('its import marker (.retake/import.json) is missing');
  if (marker === 'unreadable') return untrusted('its import marker (.retake/import.json) does not read');
  if (mark === 'missing') return untrusted("this workspace holds no mark of its import (a folder moved or copied here, or another workspace's)");
  if (mark === 'unreadable') return untrusted("the workspace's mark of its import does not read");
  if (mark.import_id !== marker.import_id) return untrusted("its import marker names another import than the workspace's mark");
  if (!mark.trusted) return untrusted('nobody trusted it yet');
  if (!(await signedTrust(mark, env))) return untrusted('its trust is not signed by this Retake home (trusted elsewhere, or edited by hand): run trust here');
  return { state: 'trusted', mark };
}

/** The refusal of an untrusted project's work, in one sentence (the fix: the trust command, in a terminal). */
export function untrustedError(slug: string, why: string): EngineError {
  const s = showHiddenCharsLine(slug);
  return new EngineError(
    'refused',
    `${s} was imported from a project archive and is not trusted (${why}): nothing of it runs — hooks, sandboxes, components, browser settings — until a person reads its code files and runs \`retake project trust ${s}\` in a terminal`,
    { fix: `retake project trust ${s}`, details: { imported: { project: s, trusted: false } } },
  );
}

/** Throws untrustedError when the project is an import not trusted; nothing for an ordinary or a trusted project. */
export async function checkProjectTrusted(at: ImportPlace, env: EngineEnv): Promise<void> {
  const t = await importTrust(at, env);
  if (t.state === 'untrusted') throw untrustedError(at.slug, t.why);
}

/** The place of a project of a workspace named by slug (its folder under projects_dir). */
export function projectPlace(ws: { root: string; projectsDir: string }, slug: string): ImportPlace {
  return { root: ws.root, dir: join(ws.projectsDir, slug), slug };
}

/**
 * The refusal of an operation of the catalogue named `name`, called with `args`, when it names (`project`) an imported
 * project not trusted and is not allowed on one (catalogue allowedOnUntrusted: reads and the allow-list); undefined
 * otherwise. An operation the catalogue does not hold is refused like any other (default deny).
 */
export async function untrustedOperationRefusal(name: string, args: unknown, ws: { root: string; projectsDir: string }, env: EngineEnv): Promise<EngineError | undefined> {
  const op = catalogueOperation(name);
  if (op && allowedOnUntrusted(op)) return undefined;
  const slug = args && typeof args === 'object' ? (args as { project?: unknown }).project : undefined;
  if (typeof slug !== 'string' || !PROJECT_SLUG_RE.test(slug)) return undefined;
  const t = await importTrust(projectPlace(ws, slug), env);
  return t.state === 'untrusted' ? untrustedError(slug, t.why) : undefined;
}

/**
 * The refusal of a copy whose source folder `dir` lies inside an imported project not trusted (a theme copied out of
 * it): its Lottie and code never leave it before a person trusted it. Undefined otherwise.
 */
export async function untrustedSourceRefusal(ws: { root: string; projectsDir: string }, dir: string, env: EngineEnv): Promise<EngineError | undefined> {
  const projects = realPathOf(ws.projectsDir, nodeFileFacts);
  const real = realPathOf(dir, nodeFileFacts);
  const rel = real.startsWith(`${projects}/`) ? real.slice(projects.length + 1) : undefined;
  const slug = rel?.split('/')[0];
  if (!slug || !PROJECT_SLUG_RE.test(slug)) return undefined;
  const t = await importTrust({ root: ws.root, dir: join(projects, slug), slug }, env);
  if (t.state !== 'untrusted') return undefined;
  const e = untrustedError(slug, t.why);
  return new EngineError('refused', `nothing is copied out of ${showHiddenCharsLine(slug)}: ${e.message}`, { ...(e.fix ? { fix: e.fix } : {}), ...(e.details ? { details: e.details } : {}) });
}

/** Write a file whole (a temporary file renamed over it), owner-only, its folder made. */
async function writeWhole(file: string, text: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmp, text, { flag: 'wx', mode: 0o600 });
  try {
    await rename(tmp, file);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}

/** The workspace's mark of a new import (untrusted): written by the import before its folder is renamed into place. */
export async function writeImportMark(root: string, mark: Omit<ImportMark, 'v' | 'trusted'>): Promise<void> {
  await writeWhole(importMarkFile(root, mark.slug), `${JSON.stringify({ v: MARK_VERSION, ...mark }, null, 2)}\n`);
}

/** The text of the marker inside an imported project (written into its stage). */
export function importMarkerText(id: string): string {
  return `${JSON.stringify({ v: MARK_VERSION, import_id: id } satisfies ImportMarker, null, 2)}\n`;
}

/** Remove the workspace's mark of `slug` (a failed import; a discarded one; a person's new project of a stale slug). */
export async function removeImportMark(root: string, slug: string): Promise<void> {
  await rm(importMarkFile(root, slug), { force: true });
}

/**
 * Mark an import trusted: the signed stanza over `files` (the code files a person was shown), and the marker inside the
 * project written again when it is missing or names another id (the person trusts this folder as it is now).
 */
export async function writeTrust(at: ImportPlace, mark: ImportMark, files: Record<string, string>, now: string, env: EngineEnv): Promise<ImportMark> {
  const key = await homeKey(homeKeyFile(env));
  const trusted = { at: now, files, sig: homeSign(key, trustedText(mark, now, files)) };
  const next: ImportMark = { ...mark, trusted };
  const marker = await readImportMarker(at.dir);
  if (typeof marker !== 'object' || marker.import_id !== mark.import_id) await writeWhole(importMarkerFile(at.dir), importMarkerText(mark.import_id));
  await writeWhole(importMarkFile(at.root, at.slug), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

/**
 * The refusal of a `retake` command on an imported project not trusted: `path` is the command's (`run`, `hooks run`),
 * `projectArg` its project argument (a slug, or a folder) or `--project`. Allowed when every operation the catalogue
 * says the command serves is allowed on an untrusted project; a command the catalogue does not name is refused like any
 * other (default deny). The folder is judged by its real path (a link to an import is the import). Without a workspace
 * (`ws` undefined: none opens), a folder holding an import marker is refused — its mark cannot be read (fails closed).
 */
export async function untrustedCommandRefusal(
  ws: { root: string; projectsDir: string } | undefined,
  path: string,
  projectArg: string,
  env: EngineEnv,
  catalogue: readonly Operation[] = CATALOGUE,
): Promise<EngineError | undefined> {
  const ops = catalogue.filter((o) => Array.isArray(o.cli) && (o.cli as readonly string[]).includes(path));
  if (ops.length && ops.every((o) => allowedOnUntrusted(o))) return undefined;
  const named = ws && PROJECT_SLUG_RE.test(projectArg) ? join(ws.projectsDir, projectArg) : resolve(projectArg);
  const real = await realpath(named).catch(() => undefined);
  if (!real || !(await stat(real).then((st) => st.isDirectory(), () => false))) return undefined;
  const slug = basename(real);
  if (!ws) {
    const marker = await readImportMarker(real);
    return marker === 'missing' ? undefined : untrustedError(slug, 'no workspace opens here, so its mark cannot be read');
  }
  const t = await importTrust({ root: ws.root, dir: real, slug }, env);
  return t.state === 'untrusted' ? untrustedError(slug, t.why) : undefined;
}
