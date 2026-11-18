/**
 * `retake project import <zip> [--as <slug>]`: a project archive (export.ts) made a project of this workspace — a
 * person's act only (trust `author`; MCP never imports). Nothing of the archive is believed:
 *
 * - the ZIP reader (archive/zip-read.ts) reads only what our writer writes, within the limits (the free space of the
 *   projects folder less 1 GB for the total);
 * - the manifest (`retake-project.json`, the last entry, at most ZIP_MANIFEST_MAX_BYTES) must be ours, of a version
 *   this Retake reads; every other entry lies under `project/`, is listed in it exactly once (and every file it lists
 *   is an entry), never a state folder (`.retake/`), a `.env*` file, an export or a key file (core project-archive.ts);
 * - every record of its runs, renders and reviews is read before it is taken: a path one names must be relative and
 *   stay inside its own folder (a run's) or its project (a render's, a review's) — a record that names any other is
 *   refused with what it belongs to (the run folder, the render's files, the review folder), and listed;
 * - each file is streamed into a stage beside the final folder (FolderStage.writeFrom: folders made one at a time,
 *   files opened exclusively, never through a link, mode 0644 / 0755) and its sha256 checked against the manifest's;
 * - the code files a person reads before trusting it are computed from the files written (code-files.ts), never taken
 *   from the manifest (a difference is only a warning line); every string an answer shows is shown with its hidden
 *   characters written out.
 *
 * The slug: `as`, else the manifest's; a project of that slug already here is a conflict (never replaced). The marker
 * (`.retake/import.json`) is written into the stage and the workspace's mark (trust.ts) before the stage is renamed
 * into place (removed again when the import fails), so the project lands untrusted: inert until `retake project trust`.
 * Journaled as a new project with its authored files (not its runs).
 */
import { readdir, statfs } from 'node:fs/promises';
import { basename, posix } from 'node:path';
import { Readable } from 'node:stream';
import { FORMAT_VERSIONS, RETAKE_VERSION, newerFormatMessage, showHiddenCharsLine, writtenRecordPaths } from '@retake/core/base';
import type { RecordKind } from '@retake/core/base';
import { IMPORT_MARKER_FILE, PROJECT_ARCHIVE_MANIFEST, PROJECT_ARCHIVE_ROOT, PROJECT_DIRS, PROJECT_SLUG_RE, STATE_DIR, layoutSpellingProblem, neverArchived, projectOutputPath, projectRef, stateRef } from '@retake/core/project';
import { ZIP_MANIFEST_MAX_BYTES } from '../archive/limits.js';
import { openZip } from '../archive/zip-read.js';
import type { ZipArchive, ZipEntry } from '../archive/zip-read.js';
import type { CallerTrust } from '../caller.js';
import type { EngineEnv } from '../env.js';
import { EngineError } from '../errors.js';
import type { FolderStage, StoreScope } from '../store/store.js';
import type { OpenedWorkspace } from '../workspace.js';
import { codeFileTable, projectCodeFiles, savedSessionsOf, settingsNotes } from './code-files.js';
import type { CodeFile } from './code-files.js';
import { ManifestSchema } from './manifest.js';
import type { ProjectManifest } from './manifest.js';
import { importMarkerText, newImportId, removeImportMark, writeImportMark } from './trust.js';

/** The largest record of a run, a render or a review read at import. */
const RECORD_MAX_BYTES = 16 * 1024 * 1024;
/** The free space an import leaves on the projects folder's disk. */
const IMPORT_SPARE_BYTES = 1024 * 1024 * 1024;

export interface ProjectImportResult {
  project: string;
  dir: string;
  files: number;
  bytes: number;
  /** The slug the archive's manifest names (when it differs from the project's: `--as`). */
  exported_as: string;
  embedded: ProjectManifest['embedded'];
  uses: ProjectManifest['uses'];
  needs: ProjectManifest['needs'];
  /** What the archive left out, as its manifest says (paths shown). */
  excluded: ProjectManifest['excluded'];
  /** The records refused (their run, render or review left out), each with why. */
  refused_records: string[];
  /** The code files written (computed here), what `retake project trust` lists. */
  code_files: CodeFile[];
  /** What project.yaml asks of this machine (code-files.ts settingsNotes). */
  settings: string[];
  /** The saved sessions this machine already holds for the slug (the project would use them). */
  sessions_here: string[];
  warnings: string[];
  trust_command: string;
}

/** What an archive holds that no archive may, as the refusal says it. */
const NEVER_WORDS = {
  state: `a state folder (${STATE_DIR}/)`,
  env: 'an env file (.env*)',
  exports: `an export (${PROJECT_DIRS.exports} folder)`,
  sensitive: 'a key or credential file',
  noise: 'a git folder, node_modules or a Finder file (Retake never writes one into an archive)',
} as const;

const refused = (why: string): EngineError => new EngineError('refused', `the project archive is refused: ${why}`);
const shown = showHiddenCharsLine;

/** The manifest, parsed and checked (format, version, shape). */
async function readManifest(zip: ZipArchive): Promise<ProjectManifest> {
  const last = zip.entries[zip.entries.length - 1];
  if (!last || last.name !== PROJECT_ARCHIVE_MANIFEST) throw refused(`its last entry is not ${PROJECT_ARCHIVE_MANIFEST} (not a project archive of Retake)`);
  let value: unknown;
  try {
    value = JSON.parse((await zip.readAll(last, ZIP_MANIFEST_MAX_BYTES)).toString('utf8'));
  } catch (e) {
    if (e instanceof EngineError) throw e;
    throw refused(`${PROJECT_ARCHIVE_MANIFEST} is not JSON`);
  }
  const newer = newerFormatMessage(value, { file: 'project archive', supported: FORMAT_VERSIONS.project_archive });
  if (newer) throw new EngineError('refused', newer);
  const m = ManifestSchema.safeParse(value);
  if (!m.success) throw refused(`${PROJECT_ARCHIVE_MANIFEST} is not a manifest this Retake reads (${shown(m.error.issues[0]?.path.join('.') ?? '')}: ${shown(m.error.issues[0]?.message ?? '')})`);
  return m.data;
}

/** The project path of an entry (`project/<path>`), every entry and manifest file listed once both ways, the never-list refused. */
function projectEntries(zip: ZipArchive, manifest: ProjectManifest): Map<string, ZipEntry> {
  const listed = new Map(manifest.files.map((f) => [f.path, f]));
  if (listed.size !== manifest.files.length) throw refused(`${PROJECT_ARCHIVE_MANIFEST} lists a file twice`);
  const out = new Map<string, ZipEntry>();
  for (const e of zip.entries.slice(0, -1)) {
    if (!e.name.startsWith(PROJECT_ARCHIVE_ROOT)) throw refused(`an entry outside ${PROJECT_ARCHIVE_ROOT} (${shown(e.name)})`);
    const rel = e.name.slice(PROJECT_ARCHIVE_ROOT.length).replace(/\/$/, '');
    if (e.dir || rel === '') continue;
    const never = neverArchived(rel);
    if (never) throw refused(`it holds ${NEVER_WORDS[never]}: ${shown(rel)}`);
    const spelt = layoutSpellingProblem(rel);
    if (spelt) throw refused(`it spells a name of the project's layout otherwise than Retake does: ${shown(spelt)}`);
    const f = listed.get(rel);
    if (!f) throw refused(`${shown(rel)} is not listed in ${PROJECT_ARCHIVE_MANIFEST}`);
    if (f.size !== e.size) throw refused(`${shown(rel)} is ${e.size} bytes, its manifest says ${f.size}`);
    if ((f.mode === '755') !== (e.mode === 0o755)) throw refused(`${shown(rel)} has another mode than its manifest says`);
    out.set(rel, e);
  }
  for (const p of listed.keys()) if (!out.has(p)) throw refused(`${PROJECT_ARCHIVE_MANIFEST} lists ${shown(p)}, which the archive does not hold`);
  return out;
}

/** The kind of record a project path is, and the folder its paths are bounded by (project-relative), or undefined. */
function recordOf(rel: string): { kind: RecordKind; folder: string; bound: string; owner: string } | undefined {
  const s = rel.split('/');
  const [top, id, file] = s;
  if (s.length === 3 && top === PROJECT_DIRS.runs && file === 'run.json') return { kind: 'run', folder: projectRef('runs', id!), bound: projectRef('runs', id!), owner: `${projectRef('runs', id!)}/` };
  if (s.length === 2 && top === PROJECT_DIRS.renders && id!.endsWith('.json')) return { kind: 'render', folder: PROJECT_DIRS.renders, bound: '', owner: `${projectRef('renders', id!.slice(0, -'.json'.length))}.` };
  if (s.length === 3 && top === PROJECT_DIRS.review && file === 'report.json') return { kind: 'report', folder: projectRef('review', id!), bound: '', owner: `${projectRef('review', id!)}/` };
  return undefined;
}

/** Why a record's paths are refused (one leaves its bound, or is absolute), or undefined. */
export function recordProblem(kind: RecordKind, value: unknown, folder: string, bound: string): string | undefined {
  for (const p of writtenRecordPaths(kind, value)) {
    if (p.startsWith('/') || p.startsWith('~') || /^[A-Za-z]:/.test(p) || p.includes('\\')) return 'it names an absolute path';
    const at = posix.normalize(posix.join(folder, p));
    if (at === '..' || at.startsWith('../') || (bound !== '' && at !== bound && !at.startsWith(`${bound}/`))) return 'it names a path outside its folder';
  }
  return undefined;
}

/** The records of runs, renders and reviews refused, as the prefixes of what they own (left out) and words. */
async function refusedRecords(zip: ZipArchive, entries: Map<string, ZipEntry>): Promise<{ prefixes: string[]; words: string[] }> {
  const out = { prefixes: [] as string[], words: [] as string[] };
  for (const [rel, e] of entries) {
    const r = recordOf(rel);
    if (!r) continue;
    let problem: string | undefined;
    try {
      problem = recordProblem(r.kind, JSON.parse((await zip.readAll(e, RECORD_MAX_BYTES)).toString('utf8')), r.folder, r.bound);
    } catch (err) {
      if (err instanceof EngineError && !/too large|over/.test(err.message)) throw err;
      problem = 'it does not read as JSON';
    }
    if (problem) {
      out.prefixes.push(r.owner);
      // A render left out takes its review with it (a review of a render that is not there).
      if (r.kind === 'render') out.prefixes.push(`${projectRef('review', r.owner.slice(projectRef('renders', '').length, -1))}/`);
      out.words.push(`${shown(rel)}: ${problem} — ${shown(r.owner.replace(/[./]$/, ''))} left out`);
    }
  }
  return out;
}

/** The free space of the projects folder's disk less the spare an import leaves. */
async function freeFor(dir: string): Promise<number> {
  const s = await statfs(dir).catch(() => undefined);
  return s ? Math.max(0, Number(s.bavail) * Number(s.bsize) - IMPORT_SPARE_BYTES) : Number.MAX_SAFE_INTEGER;
}

/** The slug the project takes here: `as`, else the manifest's; refused when it is not a slug or is taken. */
async function slugOf(ws: OpenedWorkspace, manifest: ProjectManifest, as: string | undefined): Promise<string> {
  const slug = as ?? manifest.project.slug;
  if (!PROJECT_SLUG_RE.test(slug) || slug.length > 100) throw new EngineError('invalid', `not a project slug: ${shown(slug)} (lower-case letters, digits and "-")`);
  const taken = (await readdir(ws.projectsDir).catch(() => [] as string[])).some((n) => n.toLowerCase() === slug);
  if (taken)
    throw new EngineError('conflict', `a project ${slug} exists already in this workspace: import it under another slug (--as <slug>)`, { fix: `retake project import <archive> --as ${slug}-2` });
  return slug;
}

/** The difference between the code files computed and those the manifest lists: warning lines (the manifest is never believed). */
function codeWarnings(computed: readonly CodeFile[], manifest: ProjectManifest): string[] {
  const listed = new Set(manifest.code_files);
  const here = new Set(computed.map((c) => c.path));
  const out: string[] = [];
  const missing = [...here].filter((p) => !listed.has(p));
  const extra = [...listed].filter((p) => !here.has(p));
  if (missing.length) out.push(`the archive's manifest does not list ${missing.length} code file(s) found in it: ${missing.slice(0, 10).map(shown).join(', ')}`);
  if (extra.length) out.push(`the archive's manifest lists ${extra.length} code file(s) it does not hold: ${extra.slice(0, 10).map(shown).join(', ')}`);
  return out;
}

/** What the import builds in its stage: every file checked against the manifest, then the marker and the workspace's mark. */
interface Build {
  zip: ZipArchive;
  manifest: ProjectManifest;
  entries: Map<string, ZipEntry>;
  skip: string[];
  slug: string;
  archive: { name: string; sha256: string };
  root: string;
  now: string;
}

async function buildStage(b: Build, stage: FolderStage, marked: { done: boolean }): Promise<{ files: string[]; bytes: number; code: CodeFile[] }> {
  const sha = new Map(b.manifest.files.map((f) => [f.path, f.sha256]));
  const files: string[] = [];
  let bytes = 0;
  for (const [rel, e] of b.entries) {
    if (b.skip.some((p) => rel.startsWith(p))) continue;
    const r = await stage.writeFrom(rel, b.zip.read(e), { mode: e.mode });
    if (r.sha256 !== sha.get(rel)) throw refused(`${shown(rel)} does not hold the bytes its manifest lists (sha256)`);
    files.push(rel);
    bytes += r.bytes;
  }
  const code = await projectCodeFiles(stage.dir);
  const id = newImportId();
  await stage.writeFrom(stateRef(undefined, IMPORT_MARKER_FILE), Readable.from([Buffer.from(importMarkerText(id))]), { mode: 0o644 });
  // The workspace's mark before the rename (fails closed: a crash after it leaves a mark and no folder, or an untrusted one).
  marked.done = true;
  await writeImportMark(b.root, { slug: b.slug, import_id: id, imported_at: b.now, archive: b.archive, from_retake: b.manifest.retake_version, code_files: codeFileTable(code) });
  return { files, bytes, code };
}

/** Import a project archive (the module's header). `archiveSha256`: of the archive file (the caller hashed it). */
export async function importProjectArchive(
  ws: OpenedWorkspace,
  file: string,
  o: { as?: string; trust: CallerTrust; scope: StoreScope; env: EngineEnv; now: string; archiveSha256: string },
): Promise<ProjectImportResult> {
  if (o.trust !== 'author') throw new EngineError('refused', 'a project archive is imported by a person, in a terminal: retake project import <archive>');
  const zip = await openZip(file, { totalMax: await freeFor(ws.projectsDir) });
  try {
    const manifest = await readManifest(zip);
    const entries = projectEntries(zip, manifest);
    const slug = await slugOf(ws, manifest, o.as);
    const skip = await refusedRecords(zip, entries);
    const b: Build = { zip, manifest, entries, skip: skip.prefixes, slug, archive: { name: basename(file), sha256: o.archiveSha256 }, root: ws.root, now: o.now };
    const marked = { done: false };
    const store = o.scope.stores.at(ws.projectsDir, o.scope, { project: slug, label: '<project>' });
    let made: Awaited<ReturnType<typeof store.createFolder<{ files: string[]; bytes: number; code: CodeFile[] }>>>;
    try {
      made = await store.createFolder(ws.projectsDir, slug, {
        what: 'project',
        build: (stage) => buildStage(b, stage, marked),
        recheck: async () => {
          if ((await readdir(ws.projectsDir).catch(() => [] as string[])).some((n) => n.toLowerCase() === slug)) throw new EngineError('conflict', `a project ${slug} appeared while it was imported: nothing replaced`);
          return { existing: false };
        },
        files: (r) => r.files.filter((f) => !projectOutputPath(f)),
      });
    } catch (e) {
      if (marked.done) await removeImportMark(ws.root, slug);
      throw e;
    }
    const r = made.result;
    return {
      project: slug,
      dir: made.dir,
      files: r.files.length,
      bytes: r.bytes,
      exported_as: manifest.project.slug,
      embedded: { themes: manifest.embedded.themes.map(shown), components: manifest.embedded.components.map(shown) },
      uses: { starters: manifest.uses.starters.map(shown), builtin_components: manifest.uses.builtin_components.map(shown) },
      needs: {
        env_vars: manifest.needs.env_vars.map(shown),
        keychain: manifest.needs.keychain.map(shown),
        pass_env: manifest.needs.pass_env.map(shown),
        sessions: manifest.needs.sessions.map((s) => ({ env: shown(s.env), persona: shown(s.persona) })),
      },
      excluded: {
        env: manifest.excluded.env.map(shown),
        sensitive: manifest.excluded.sensitive.map(shown),
        links: manifest.excluded.links.map(shown),
        special: manifest.excluded.special.map(shown),
        outside_renders: manifest.excluded.outside_renders.map(shown),
      },
      refused_records: skip.words,
      code_files: r.code.map((c) => ({ ...c, path: shown(c.path) })),
      settings: await settingsNotes(made.dir),
      sessions_here: await savedSessionsOf(slug, o.env),
      warnings: [
        ...codeWarnings(r.code, manifest),
        ...(manifest.retake_version !== RETAKE_VERSION ? [`made by Retake ${shown(manifest.retake_version)} (this one is ${RETAKE_VERSION})`] : []),
      ],
      trust_command: `retake project trust ${slug}`,
    };
  } finally {
    await zip.close();
  }
}
