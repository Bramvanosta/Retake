/**
 * `retake project export` / MCP `project_export`: a project in one ZIP (a project archive) — the files plan.ts takes,
 * each under `project/<path>`, then the manifest (`retake-project.json`, last), written by the engine's own ZIP writer
 * (archive/zip-write.ts) to a `.partial` file renamed into place once whole, never over a file. Default place: the
 * project's `exports/<slug>-project-<YYYYMMDD-HHMMSS>.zip`; a person may name another (`out`: a file or a folder),
 * never inside the project but in its `exports/`. The free space of the target folder must exceed the total plus 1 GB.
 *
 * Through MCP (trust `mcp`): never `out`, never the runs (`with_runs` is a person's option at a terminal), at most
 * MCP_EXPORT_MAX_BYTES; synchronous (no job). A seam for a later lot: the sandbox's files and images (`options`).
 */
import { randomBytes } from 'node:crypto';
import { constants, existsSync } from 'node:fs';
import { copyFile, link, mkdir, rm, stat, statfs } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { RETAKE_VERSION, FORMAT_VERSIONS, errorMessage, pathInside, showHiddenCharsLine } from '@retake/core/base';
import { PROJECT_ARCHIVE_FORMAT, PROJECT_ARCHIVE_MANIFEST, PROJECT_ARCHIVE_ROOT } from '@retake/core/project';
import type { LoadedProject } from '@retake/core/project';
import { createZip } from '../archive/zip-write.js';
import type { CallerTrust } from '../caller.js';
import type { EngineEnv } from '../env.js';
import { EngineError } from '../errors.js';
import type { OpenedWorkspace } from '../workspace.js';
import { projectCodeFiles } from './code-files.js';
import type { ManifestFile, ProjectManifest } from './manifest.js';
import { planProjectArchive } from './plan.js';
import type { ArchivePlan } from './plan.js';

/** The largest archive an export through MCP writes (a person exports a larger one at a terminal). */
export const MCP_EXPORT_MAX_BYTES = 1024 * 1024 * 1024;
/** The free space an export leaves on the target's disk. */
export const EXPORT_SPARE_BYTES = 1024 * 1024 * 1024;

export interface ProjectExportRequest {
  project: string;
  /** Runs, renders and reviews too (a person's option). */
  withRuns?: boolean;
  /** The archive's file or folder (a person's option). */
  out?: string;
  /** Plan only: what would go in, nothing written. */
  dryRun?: boolean;
}

/** What an export wrote (or would write): the archive, its counts, and the manifest's sections a person reads. */
export interface ProjectExportResult {
  project: string;
  dry_run: boolean;
  /** The archive written (absent on a dry run). */
  file?: string;
  files: number;
  /** The bytes of the files taken (the archive is smaller: most are deflated). */
  bytes: number;
  /** The archive's size on disk. */
  archive_bytes?: number;
  with_runs: boolean;
  embedded: ProjectManifest['embedded'];
  uses: ProjectManifest['uses'];
  needs: ProjectManifest['needs'];
  excluded: ProjectManifest['excluded'];
  warnings: ProjectManifest['warnings'];
  code_files: string[];
}

/**
 * The code files the archive holds, as the import will list them: the project's own (code-files.ts) and those of the
 * embedded workspace items — every file of a component, a theme's Lottie, SVG and code files.
 */
async function archiveCodeFiles(projectDir: string, plan: ArchivePlan): Promise<string[]> {
  // (A link is never archived: not one of its code files.)
  const own = (await projectCodeFiles(projectDir)).filter((c) => c.why !== 'link').map((c) => c.path);
  const embedded = plan.files.filter((f) => f.origin === 'workspace-component' || (f.origin === 'workspace-theme' && (embeddedThemeCode(f.path) || f.mode === 0o755))).map((f) => f.path);
  return [...new Set([...own, ...embedded])].sort();
}

/** A theme file the renderer or a browser runs (core media.ts decides Lottie by extension). */
const embeddedThemeCode = (path: string): boolean => /\.(json|svg|m?js|cjs|ts|tsx|jsx)$/i.test(path);

/** `<project>/exports/<slug>-project-<YYYYMMDD-HHMMSS>.zip`. */
function defaultFile(exportsDir: string, project: LoadedProject, now: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return join(exportsDir, `${project.slug}-project-${stamp}.zip`);
}

/** The archive's file: `out` (a folder: the default name in it; a file: as named), never inside the project but its exports/. */
async function targetOf(exportsDir: string, project: LoadedProject, out: string | undefined, now: Date): Promise<string> {
  if (out === undefined) return defaultFile(exportsDir, project, now);
  const abs = resolve(out);
  const isDir = await stat(abs).then(
    (s) => s.isDirectory(),
    () => false,
  );
  const file = isDir ? join(abs, basename(defaultFile(exportsDir, project, now))) : abs;
  if (pathInside(file, project.dir) && !pathInside(file, exportsDir))
    throw new EngineError('refused', `the archive would be written inside the project it holds (${relative(project.dir, file)}): name a file outside it, or in its exports/`);
  if (!file.toLowerCase().endsWith('.zip')) throw new EngineError('invalid', `a project archive is a .zip file: ${showHiddenCharsLine(basename(file))}`);
  if (existsSync(file)) throw new EngineError('conflict', `${file} exists already: a project archive is never written over a file`);
  return file;
}

/** Refused when the target's disk would keep less than EXPORT_SPARE_BYTES free. */
async function checkSpace(dir: string, bytes: number): Promise<void> {
  const s = await statfs(dir).catch(() => undefined);
  if (!s) return;
  const free = Number(s.bavail) * Number(s.bsize);
  if (free < bytes + EXPORT_SPARE_BYTES)
    throw new EngineError('refused', `not enough free space for the archive: ${Math.ceil(bytes / 1e6)} MB to write, ${Math.floor(free / 1e6)} MB free (an export leaves 1 GB free)`);
}

/** The manifest of a plan, once its files are written (their sha256: the bytes streamed). */
function manifestOf(plan: ArchivePlan, files: ManifestFile[], codeFiles: string[], now: Date): ProjectManifest {
  return {
    format: PROJECT_ARCHIVE_FORMAT,
    version: FORMAT_VERSIONS.project_archive,
    retake_version: RETAKE_VERSION,
    created_at: now.toISOString(),
    project: { slug: plan.slug, name: plan.name },
    options: { with_runs: plan.withRuns },
    files,
    embedded: plan.embedded,
    uses: plan.uses,
    needs: plan.needs,
    excluded: plan.excluded,
    warnings: plan.warnings,
    code_files: codeFiles,
  };
}

/** The file calls placeArchive makes (a seam for tests: a volume without hard links). */
export interface PlaceFs {
  link(from: string, to: string): Promise<void>;
  copyFile(from: string, to: string, mode: number): Promise<void>;
}

/** The link errors of a volume or share without hard links (exFAT, FAT, some network shares). */
const NO_LINKS: readonly string[] = ['ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'ENOSYS', 'EXDEV'];

/**
 * The whole archive `partial` put at `file`, never over a file: a hard link (fails on an existing name), else — on a
 * volume without hard links — an exclusive copy (COPYFILE_EXCL); then the partial file removed. An existing name is a
 * conflict; any other failure is said in words, with the file's place.
 */
export async function placeArchive(partial: string, file: string, fs: PlaceFs = { link, copyFile }): Promise<void> {
  try {
    try {
      await fs.link(partial, file);
    } catch (e) {
      if (!NO_LINKS.includes((e as NodeJS.ErrnoException).code ?? '')) throw e;
      await fs.copyFile(partial, file, constants.COPYFILE_EXCL);
    }
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') throw new EngineError('conflict', `${file} exists already: a project archive is never written over a file`);
    throw new EngineError('refused', `the archive could not be put at ${file} (${code ?? 'error'}: ${errorMessage(e)}): choose another place with --out`);
  } finally {
    await rm(partial, { force: true });
  }
}

/** Write the archive of a plan to `file` (a `.partial` beside it, renamed into place). */
async function writeArchive(plan: ArchivePlan, file: string, codeFiles: string[], now: Date, onFile?: (done: number, total: number) => void): Promise<number> {
  const partial = join(dirname(file), `.${basename(file)}.${randomBytes(4).toString('hex')}.partial`);
  const zip = await createZip(partial);
  try {
    const files: ManifestFile[] = [];
    for (const [i, f] of plan.files.entries()) {
      const added = await zip.add(`${PROJECT_ARCHIVE_ROOT}${f.path}`, { file: f.from }, { mode: f.mode, mtime: f.mtime });
      files.push({ path: f.path, size: added.size, sha256: added.sha256, mode: f.mode === 0o755 ? '755' : '644', origin: f.origin });
      onFile?.(i + 1, plan.files.length);
    }
    const manifest = Buffer.from(`${JSON.stringify(manifestOf(plan, files, codeFiles, now), null, 1)}\n`);
    await zip.add(PROJECT_ARCHIVE_MANIFEST, { data: manifest }, { mode: 0o644, mtime: now });
    const r = await zip.close();
    await placeArchive(partial, file);
    return r.bytes;
  } catch (e) {
    await zip.abort().catch(() => undefined);
    await rm(partial, { force: true });
    throw e;
  }
}

/** Export a project (the module's header): `trust` is the caller's; `now` stamps the name and the manifest. */
export async function exportProjectArchive(
  ws: OpenedWorkspace,
  project: LoadedProject,
  req: ProjectExportRequest,
  o: { trust: CallerTrust; env: EngineEnv; now: Date; onFile?: (done: number, total: number) => void },
): Promise<ProjectExportResult> {
  if (o.trust !== 'author' && (req.withRuns || req.out !== undefined))
    throw new EngineError('refused', 'through MCP a project is exported without its runs and into its own exports/ folder: a person runs retake project export --with-runs / --out in a terminal');
  const plan = await planProjectArchive(ws, project, { withRuns: req.withRuns === true, env: o.env });
  if (o.trust !== 'author' && plan.bytes > MCP_EXPORT_MAX_BYTES)
    throw new EngineError(
      'refused',
      `the project's files come to ${Math.ceil(plan.bytes / 1e6)} MB: through MCP an export holds at most ${MCP_EXPORT_MAX_BYTES / 1e6} MB — a person runs retake project export in a terminal`,
    );
  const codeFiles = await archiveCodeFiles(project.dir, plan);
  const base: ProjectExportResult = {
    project: project.slug,
    dry_run: req.dryRun === true,
    files: plan.files.length,
    bytes: plan.bytes,
    with_runs: plan.withRuns,
    embedded: plan.embedded,
    uses: plan.uses,
    needs: plan.needs,
    excluded: plan.excluded,
    warnings: plan.warnings,
    code_files: codeFiles,
  };
  if (req.dryRun) return base;
  const file = await targetOf(ws.outputs.exports.dirOf(project.dir), project, req.out, o.now);
  await mkdir(dirname(file), { recursive: true });
  await checkSpace(dirname(file), plan.bytes);
  const archiveBytes = await writeArchive(plan, file, codeFiles, o.now, o.onFile);
  return { ...base, file, archive_bytes: archiveBytes };
}
