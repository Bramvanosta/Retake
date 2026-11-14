/**
 * The editor's work the engine asks for outside a render, behind names of its own: planning a run's edit, the run and
 * render lookups of a terminal, the versions of a renders folder, a render's paths checked against its project, the
 * plan of an export, the files an edit reads, the theme hashes, a media probe, what component previews are made of,
 * and which of the editor's errors a failure is. The engine loads the editor here, in the render folder, and nowhere
 * else (the import-rules ratchet's `loader-use`); the planner's pure values (`@retake/editor/plan`) are free.
 */
import { mkdir, rm } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { LoadedProject, LoadedTemplate, WorkFileFacts } from '@retake/core/model';
import type { WorkPolicy } from '@retake/core/policy';
import type { ComponentRegistry } from '@retake/components/geometry';
import type { Timeline } from '@retake/core/model';
import type { FoundRender, PlanRunOptions, PlannedRun, RenderRecord, RunRef } from '@retake/editor';
import { editor } from '../lazy.js';

type Editor = Awaited<ReturnType<typeof editor>>;

// The editor's types the engine's callers name: the render home hands them on, so that no file outside it imports
// the editor's root (types included).
export type {
  ExportFormat,
  ExportRenderOptions,
  ExportResult,
  FoundRender,
  PlanRunOptions,
  PlannedRun,
  PreviewBackend,
  RenderLoopsOptions,
  RenderPreviewsOptions,
  RenderStillOptions,
  RenderVideoOptions,
  RunRef,
} from '@retake/editor';

// ── planning and lookups ──

/** Plan a run's edit (the editor's planRun: no browser). */
export async function planWork(o: PlanRunOptions): Promise<PlannedRun> {
  return (await editor()).planRun(o);
}

/** The run a render works on: a run id, a run directory or `latest` of `scenario` (the editor's findRun; RenderError otherwise). */
export async function findRunOf(project: LoadedProject, arg: string, scenario?: string): Promise<RunRef> {
  return (await editor()).findRun(project, arg, scenario);
}

/**
 * The render named at a terminal: `latest` (of `scenario`), an id, or a .json / .mp4 path (the editor's
 * locateRenderRecord; ExportError otherwise) — the record, the FILE it was read from (`entry.name`: what a command then
 * names, never the id the record says) and, with `latest`, what it passed over.
 */
export async function findRenderOf(project: LoadedProject, arg: string, scenario?: string): Promise<FoundRender> {
  return (await editor()).locateRenderRecord(project, arg, scenario);
}

/** The theme a shell's component previews are drawn with, read with the workspace's file facts. */
export async function previewThemeOf(theme: string, root: string, facts: WorkFileFacts): Promise<LoadedTemplate> {
  return (await editor()).loadPreviewTheme(theme, root, facts);
}

// ── the renders folder ──

/** The version the next render of `scenario` takes in the project's renders folder (none reserved: a preview's guess). */
export async function nextRenderVersion(project: Pick<LoadedProject, 'dir'>, scenario: string): Promise<number> {
  const ed = await editor();
  return ed.nextVersion(ed.rendersDir(project), scenario);
}

/** Reserve the next version of `scenario` (its lock file, holding `owner`); `release` frees it again. */
export async function reserveRenderVersion(project: Pick<LoadedProject, 'dir'>, scenario: string, owner: string): Promise<{ version: number; release: () => Promise<void> }> {
  const ed = await editor();
  const dir = ed.rendersDir(project);
  await mkdir(dir, { recursive: true });
  return ed.reserveVersion(dir, scenario, owner);
}

/** Free a version reserved before, by its number (a render job cancelled before it started, or failed early). */
export async function releaseRenderVersion(project: Pick<LoadedProject, 'dir'>, scenario: string, version: number): Promise<void> {
  const ed = await editor();
  await rm(ed.versionLockFile(ed.rendersDir(project), scenario, version), { force: true });
}

/** Why a render may not be read by work an agent submitted (its video or run folder outside the project), or null. */
export async function renderPathProblem(projectDir: string, record: Pick<RenderRecord, 'id' | 'file' | 'run_dir'>): Promise<string | null> {
  return (await editor()).recordPathProblem(projectDir, record);
}

// ── exports and raw packages ──

/** What an export needs of the editor: how each format is made from a render, and the theme a re-render plans with. */
export interface ExportPlanning {
  method: Editor['exportMethod'];
  themeRef: Editor['exportThemeRef'];
}

export async function exportPlanning(): Promise<ExportPlanning> {
  const ed = await editor();
  return { method: ed.exportMethod, themeRef: ed.exportThemeRef };
}

/** The files an edit of `timeline` with `template` reads: the plan's (absolute, from the project folder) and the theme's. */
export async function editFilesOf(projectDir: string, timeline: Pick<Timeline, 'scenes' | 'events'> & Partial<Pick<Timeline, 'video'>>, template: LoadedTemplate | undefined): Promise<string[]> {
  const ed = await editor();
  return [...ed.planFileRefs(timeline).map((f) => (isAbsolute(f) ? f : join(projectDir, f))), ...ed.themeFileRefs(template)];
}

// ── hashes and probes ──

/** A theme folder's content hash (a render record's template_sha256) and the signature of its files (names, sizes, mtimes). */
export interface ThemeHashes {
  contentHash: Editor['themeContentHash'];
  statSignature: Editor['themeStatSignature'];
}

export async function themeHashes(): Promise<ThemeHashes> {
  const ed = await editor();
  return { contentHash: ed.themeContentHash, statSignature: ed.themeStatSignature };
}

/** What ffprobe says of a media file (undefined when it cannot be read), under the work's policy. */
export async function probeMediaFile(file: string, policy: WorkPolicy): ReturnType<Editor['probeMedia']> {
  return (await editor()).probeMedia(file, policy);
}

// ── component previews ──

/**
 * What a component preview is made of outside its render: the sample screens, the spec of one component in a theme,
 * the loop format, the identity of what draws it (the composition, the browser and its GL) and the hashes of the
 * component folders and of the registry's bundle. The Studio's library keys its cache on these.
 */
export interface PreviewMaking {
  loadSamples: Editor['loadPreviewSamples'];
  build: Editor['buildComponentPreview'];
  /** The refusal of a preview's plan (the editor's PreviewPlanError: a file it cannot serve). */
  planError(message: string): Error;
  loopFormat: Editor['LOOP_FORMAT'];
  compositionHash: Editor['compositionHash'];
  /** The browser and the GL the previews are drawn with under `policy`. */
  browserIdentity(policy: WorkPolicy): string;
  folderHash: Editor['componentFolderHash'];
  registryHash(registry: ComponentRegistry): Promise<string>;
}

export async function previewMaking(): Promise<PreviewMaking> {
  const ed = await editor();
  return {
    loadSamples: ed.loadPreviewSamples,
    build: ed.buildComponentPreview,
    planError: (message) => new ed.PreviewPlanError(message),
    loopFormat: ed.LOOP_FORMAT,
    compositionHash: ed.compositionHash,
    browserIdentity: (policy) => `${ed.renderBrowserIdentity()} gl=${ed.previewGlKey(policy)}`,
    folderHash: ed.componentFolderHash,
    registryHash: async (registry) => ed.bundleHash(await ed.registryBundleComponents(registry)),
  };
}

// ── the editor's errors ──

/** The problems of a plan refused by the trust rules of agent work (the editor's PlanTrustError), or undefined. */
export async function planTrustProblems(e: unknown): Promise<{ message: string; problems: string[] } | undefined> {
  const ed = await editor();
  return e instanceof ed.PlanTrustError ? { message: e.message, problems: e.problems } : undefined;
}

/**
 * Which of the editor's own errors `e` is: a cancelled render (`render_cancelled`), another render error (`render`: a
 * failed render, an unknown run, a plan refused…), an export error (`export`); undefined for anything else.
 */
export async function editorErrorOf(e: unknown): Promise<'render_cancelled' | 'render' | 'export' | undefined> {
  if (!(e instanceof Error)) return undefined;
  const ed = await editor();
  if (e instanceof ed.RenderCancelledError) return 'render_cancelled';
  if (e instanceof ed.RenderError) return 'render';
  if (e instanceof ed.ExportError) return 'export';
  return undefined;
}
