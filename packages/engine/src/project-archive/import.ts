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
 *
 * With a sandbox (`--with-sandbox` at export): an env file is taken only when the manifest says a person carried it
 * (`with_env`, its origin `env`); each image entry (`images/sha256-<hex>.tar.gz`, listed in the manifest both ways) is
 * streamed — its sha256 checked — to `<root>/.retake/imports/images/<slug>/` (workspace state, outside the project),
 * and recorded in the mark with the services that run it. Nothing is loaded: `retake project trust` loads them
 * (trust-work.ts). What the manifest says of the sandbox (copies, host mounts, env keys, what it does not carry) is
 * kept in the mark as shown lines, for the trust listing — never believed.
 */
import { createReadStream, createWriteStream } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { mkdir, readdir, rm, statfs } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, join, posix } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { FORMAT_VERSIONS, RETAKE_VERSION, errorMessage, newerFormatMessage, showHiddenCharsLine, writtenRecordPaths } from '@retake/core/base';
import type { RecordKind } from '@retake/core/base';
import {
  IMPORT_MARKER_FILE,
  PROJECT_ARCHIVE_MANIFEST,
  PROJECT_ARCHIVE_ROOT,
  PROJECT_DIRS,
  PROJECT_SLUG_RE,
  STATE_DIR,
  layoutSpellingProblem,
  neverArchived,
  projectOutputPath,
  projectRef,
  stateRef,
} from '@retake/core/project';
import type { WorkPolicy } from '@retake/core/policy';
import type { SandboxShare } from '@retake/sandbox/types';
import { ZIP_IMAGES_PREFIX, ZIP_MANIFEST_MAX_BYTES, archiveEntryMax } from '../archive/limits.js';
import { openZip } from '../archive/zip-read.js';
import type { ZipArchive, ZipEntry } from '../archive/zip-read.js';
import type { CallerTrust } from '../caller.js';
import type { EngineEnv } from '../env.js';
import { EngineError } from '../errors.js';
import type { FolderStage, StoreScope } from '../store/store.js';
import type { OpenedWorkspace } from '../workspace.js';
import { codeFileTable, projectCodeFiles, savedSessionsOf, settingsNotes } from './code-files.js';
import { readProjectSubsets, subsetLines, subsetProblems, usesProblem } from './compose-read.js';
import type { CodeFile } from './code-files.js';
import { ManifestSchema } from './manifest.js';
import type { ProjectManifest } from './manifest.js';
import { SHARE_NAME_RE, importImagesDir, importMarkerText, newImportId, removeImportMark, writeImportMark } from './trust.js';
import type { MarkImage } from './trust.js';

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
  /** The sandbox's images extracted (not loaded: trust loads them), and what the archive says of its sandbox (shown). */
  images: Array<{ id: string; platform: string; size: number; services: string[] }>;
  /** What the archive's manifest says of its sandbox (the exporter's words, shown). */
  sandbox_notes: string[];
  /** What its sandboxes will do, read from the compose files written (compose-read.ts): never the manifest's word. */
  sandbox_settings: string[];
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
    if (e.name.startsWith(ZIP_IMAGES_PREFIX)) continue;
    if (!e.name.startsWith(PROJECT_ARCHIVE_ROOT)) throw refused(`an entry outside ${PROJECT_ARCHIVE_ROOT} (${shown(e.name)})`);
    const rel = e.name.slice(PROJECT_ARCHIVE_ROOT.length).replace(/\/$/, '');
    if (e.dir || rel === '') continue;
    const f = listed.get(rel);
    const never = neverArchived(rel);
    // An env file only when a person carried the sandbox's (the manifest says so, and lists it as such).
    const carriedEnv = never === 'env' && manifest.options.with_env === true && f?.origin === 'env';
    if (never && !carriedEnv) throw refused(`it holds ${NEVER_WORDS[never]}: ${shown(rel)}`);
    if (f?.origin === 'env' && manifest.options.with_env !== true) throw refused(`it holds ${NEVER_WORDS.env}: ${shown(rel)} (its manifest does not say a person carried it)`);
    const spelt = layoutSpellingProblem(rel);
    if (spelt) throw refused(`it spells a name of the project's layout otherwise than Retake does: ${shown(spelt)}`);
    if (!f) throw refused(`${shown(rel)} is not listed in ${PROJECT_ARCHIVE_MANIFEST}`);
    if (f.size !== e.size) throw refused(`${shown(rel)} is ${e.size} bytes, its manifest says ${f.size}`);
    if ((f.mode === '755') !== (e.mode === 0o755)) throw refused(`${shown(rel)} has another mode than its manifest says`);
    out.set(rel, e);
  }
  for (const p of listed.keys()) if (!out.has(p)) throw refused(`${PROJECT_ARCHIVE_MANIFEST} lists ${shown(p)}, which the archive does not hold`);
  return out;
}

/** The image entries (`images/sha256-<hex>.tar.gz`), each listed in the manifest's images exactly once both ways, its size the manifest's. */
function imageEntries(zip: ZipArchive, manifest: ProjectManifest): Map<string, ZipEntry> {
  const listed = new Map((manifest.images ?? []).map((i) => [i.entry, i]));
  if (listed.size !== (manifest.images ?? []).length) throw refused(`${PROJECT_ARCHIVE_MANIFEST} lists an image twice`);
  const out = new Map<string, ZipEntry>();
  for (const e of zip.entries.slice(0, -1)) {
    if (!e.name.startsWith(ZIP_IMAGES_PREFIX) || (e.dir && e.name === ZIP_IMAGES_PREFIX)) continue;
    const i = listed.get(e.name);
    if (!i || e.dir) throw refused(`${shown(e.name)} is not an image its manifest lists`);
    if (i.entry !== `images/sha256-${i.id.slice('sha256:'.length)}.tar.gz`) throw refused(`${shown(e.name)} is not named by its image's id`);
    if (i.bytes !== e.size) throw refused(`${shown(e.name)} is ${e.size} bytes, its manifest says ${i.bytes}`);
    out.set(e.name, e);
  }
  for (const p of listed.keys()) if (!out.has(p)) throw refused(`${PROJECT_ARCHIVE_MANIFEST} lists the image ${shown(p)}, which the archive does not hold`);
  return out;
}

/** The images of the mark: the manifest's, each with the services its sandbox parts say run it (names checked: they make tags). */
function markImages(manifest: ProjectManifest): Omit<MarkImage, 'sha256' | 'bytes' | 'tar_bytes'>[] {
  return (manifest.images ?? []).map((i) => {
    const uses = (manifest.sandbox ?? []).flatMap((p) => p.images.filter((x) => x.id === i.id).map((x) => ({ env: p.env, service: x.service, name: shown(x.name) })));
    for (const u of uses) if (!SHARE_NAME_RE.test(u.env) || !SHARE_NAME_RE.test(u.service)) throw refused(`a sandbox or service name of its images is not a name: ${shown(u.env)}/${shown(u.service)}`);
    return { id: i.id, file: basename(i.entry), platform: shown(i.platform), size: i.size, uses };
  });
}

/**
 * The sandboxes of the files written, read against the compose subset (compose-read.ts): an archive that hands its
 * sandbox over (`with_sandbox`) is refused when one is outside it; and each service the manifest says an image runs
 * must be a service of those files, with the image name its compose file gives it — an archive never puts its image on
 * a service of its choosing.
 */
async function checkSandboxes(manifest: ProjectManifest, dir: string): Promise<void> {
  const uses = manifestUses(manifest);
  const reads = await readProjectSubsets(dir, { mode: 'import', carried: (e, s) => uses.some((u) => u.env === e && u.service === s) });
  const p = manifest.options.with_sandbox ? subsetProblems(reads) : undefined;
  if (p) throw refused(`its sandbox is outside the compose subset an archive hands over: ${p}`);
  const u = usesProblem(uses, reads);
  if (u) throw refused(u);
}

/** The services the manifest puts its images on. */
const manifestUses = (manifest: ProjectManifest) => (manifest.sandbox ?? []).flatMap((p) => p.images.map((i) => ({ env: p.env, service: i.service, name: i.name })));

/** The carried image of a service, as a listing names it (12 hex of its id). */
const carriedBy =
  (manifest: ProjectManifest) =>
  (env: string, service: string): string | undefined =>
    (manifest.sandbox ?? [])
      .find((p) => p.env === env)
      ?.images.find((i) => i.service === service)
      ?.id.slice(7, 19);

/** What the manifest says of its sandboxes, as lines shown at import and at trust (never believed). */
function sandboxNotes(manifest: ProjectManifest): string[] {
  const out: string[] = [];
  for (const p of manifest.sandbox ?? []) {
    const env = shown(p.env);
    for (const c of p.copied) out.push(`sandbox ${env}: ${shown(c.to)} copied from ${shown(c.from)} on the exporter's machine`);
    for (const m of p.host_mounts)
      out.push(
        `sandbox ${env}: service ${shown(m.service)} mounts ${shown(m.source)} at ${shown(m.target)} (not carried: put that folder at ${shown(m.expected_at ?? m.source)}, or the mount is empty)`,
      );
    if (p.env_file)
      out.push(
        `sandbox ${env}: its env file ${p.env_file.included ? `${shown(p.env_file.path)} is carried` : `is not carried: put it at ${shown(p.env_file.path)}`} (keys ${p.env_file.keys.map(shown).join(', ') || 'none'})`,
      );
    for (const f of p.service_env_files)
      out.push(
        `sandbox ${env}: service ${shown(f.service)} reads the env file ${shown(f.path)} (not carried: put it at ${shown(f.expected_at ?? f.path)}; keys ${f.keys.map(shown).join(', ') || 'none'})`,
      );
    for (const o of p.outside) out.push(`sandbox ${env}: ${shown(o.ref)} — ${shown(o.what)}`);
  }
  return out;
}

/** The kind of record a project path is, and the folder its paths are bounded by (project-relative), or undefined. */
function recordOf(rel: string): { kind: RecordKind; folder: string; bound: string; owner: string } | undefined {
  const s = rel.split('/');
  const [top, id, file] = s;
  if (s.length === 3 && top === PROJECT_DIRS.runs && file === 'run.json') return { kind: 'run', folder: projectRef('runs', id!), bound: projectRef('runs', id!), owner: `${projectRef('runs', id!)}/` };
  if (s.length === 2 && top === PROJECT_DIRS.renders && id!.endsWith('.json'))
    return { kind: 'render', folder: PROJECT_DIRS.renders, bound: '', owner: `${projectRef('renders', id!.slice(0, -'.json'.length))}.` };
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
  images: Map<string, ZipEntry>;
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
  await checkSandboxes(b.manifest, stage.dir);
  const images = await extractImages(b);
  const id = newImportId();
  await stage.writeFrom(stateRef(undefined, IMPORT_MARKER_FILE), Readable.from([Buffer.from(importMarkerText(id))]), { mode: 0o644 });
  // The workspace's mark before the rename (fails closed: a crash after it leaves a mark and no folder, or an untrusted one).
  marked.done = true;
  const notes = sandboxNotes(b.manifest);
  await writeImportMark(b.root, {
    slug: b.slug,
    import_id: id,
    imported_at: b.now,
    archive: b.archive,
    from_retake: b.manifest.retake_version,
    code_files: codeFileTable(code),
    ...(images.length ? { images } : {}),
    ...(notes.length ? { sandbox_notes: notes } : {}),
  });
  return { files, bytes, code };
}

/**
 * The image entries streamed to the import's images folder (workspace state: `<root>/.retake/imports/images/<slug>/`,
 * made afresh), each file's sha256 checked against the manifest's. Nothing is loaded.
 */
async function extractImages(b: Build): Promise<MarkImage[]> {
  if (!b.images.size) return [];
  const dir = importImagesDir(b.root, b.slug);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const out: MarkImage[] = [];
  for (const m of markImages(b.manifest)) {
    const listed = (b.manifest.images ?? []).find((i) => i.id === m.id);
    const e = listed ? b.images.get(listed.entry) : undefined;
    if (!listed || !e) throw refused(`the image ${shown(m.id)} is not in the archive`);
    const hash = createHash('sha256');
    let bytes = 0;
    const count = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        hash.update(chunk);
        bytes += chunk.length;
        cb(null, chunk);
      },
    });
    await pipeline(b.zip.read(e), count, createWriteStream(join(dir, m.file), { flags: 'wx', mode: 0o600 }));
    const sha256 = hash.digest('hex');
    if (sha256 !== listed.sha256) throw refused(`${shown(listed.entry)} does not hold the bytes its manifest lists (sha256)`);
    out.push({ ...m, sha256, bytes, tar_bytes: await tarBytes(join(dir, m.file), imageBytesCap(listed.size), listed.entry) });
  }
  return out;
}

/** The most bytes an image's file may hold once decompressed: its size as the archive says, plus a tenth and 64 MB. */
export const imageBytesCap = (size: number): number => Math.floor(size * 1.1) + 64 * 1024 * 1024;

/** An image file's bytes once decompressed, counted up to `cap` (refused beyond: a bomb, or not the image it says). */
async function tarBytes(file: string, cap: number, what: string): Promise<number> {
  let n = 0;
  const count = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      n += chunk.length;
      cb(n > cap ? refused(`${shown(what)} holds more than ${cap} bytes once decompressed (more than its image's size)`) : null);
    },
  });
  await pipeline(createReadStream(file), createGunzip(), count).catch((e: unknown) => {
    throw e instanceof EngineError ? e : refused(`${shown(what)} is not a gzipped image (${errorMessage(e)})`);
  });
  return n;
}

/** A warning for each image built for another platform than this machine's Docker (when docker answers). */
async function platformWarnings(manifest: ProjectManifest, share: SandboxShare | undefined, policy: WorkPolicy | undefined): Promise<string[]> {
  if (!manifest.images?.length || !share || !policy) return [];
  const here = await share.docker(policy).then(
    (d) => d.platform,
    () => undefined,
  );
  if (!here) return [];
  const base = (p: string) => p.split('/').slice(0, 2).join('/');
  return manifest.images
    .filter((i) => base(i.platform) !== base(here))
    .map((i) => `the image ${i.id.slice(7, 19)} is built for ${shown(i.platform)}, this machine's Docker runs ${here}: it runs under emulation, slowly, or not at all`);
}

/** Import a project archive (the module's header). `archiveSha256`: of the archive file (the caller hashed it). */
export async function importProjectArchive(
  ws: OpenedWorkspace,
  file: string,
  o: { as?: string; trust: CallerTrust; scope: StoreScope; env: EngineEnv; now: string; archiveSha256: string; share?: SandboxShare; policy?: WorkPolicy },
): Promise<ProjectImportResult> {
  if (o.trust !== 'author') throw new EngineError('refused', 'a project archive is imported by a person, in a terminal: retake project import <archive>');
  const zip = await openZip(file, { totalMax: await freeFor(ws.projectsDir), entryMax: archiveEntryMax });
  try {
    const manifest = await readManifest(zip);
    const entries = projectEntries(zip, manifest);
    const images = imageEntries(zip, manifest);
    const slug = await slugOf(ws, manifest, o.as);
    const skip = await refusedRecords(zip, entries);
    const b: Build = { zip, manifest, entries, images, skip: skip.prefixes, slug, archive: { name: basename(file), sha256: o.archiveSha256 }, root: ws.root, now: o.now };
    const marked = { done: false };
    const store = o.scope.stores.at(ws.projectsDir, o.scope, { project: slug, label: '<project>' });
    let made: Awaited<ReturnType<typeof store.createFolder<{ files: string[]; bytes: number; code: CodeFile[] }>>>;
    try {
      made = await store.createFolder(ws.projectsDir, slug, {
        what: 'project',
        build: (stage) => buildStage(b, stage, marked),
        recheck: async () => {
          if ((await readdir(ws.projectsDir).catch(() => [] as string[])).some((n) => n.toLowerCase() === slug))
            throw new EngineError('conflict', `a project ${slug} appeared while it was imported: nothing replaced`);
          return { existing: false };
        },
        files: (r) => r.files.filter((f) => !projectOutputPath(f)),
      });
    } catch (e) {
      if (marked.done) await removeImportMark(ws.root, slug);
      if (images.size) await rm(importImagesDir(ws.root, slug), { recursive: true, force: true });
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
        ...(await platformWarnings(manifest, o.share, o.policy)),
      ],
      trust_command: `retake project trust ${slug}`,
      images: markImages(manifest).map((i) => ({ id: i.id, platform: i.platform, size: i.size, services: i.uses.map((u) => `${u.env}/${u.service}`) })),
      sandbox_notes: sandboxNotes(manifest),
      sandbox_settings: subsetLines(
        await readProjectSubsets(made.dir, { mode: 'import', carried: (e, sv) => manifestUses(manifest).some((u) => u.env === e && u.service === sv) }),
        carriedBy(manifest),
      ),
    };
  } finally {
    await zip.close();
  }
}
