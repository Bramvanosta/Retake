/**
 * The editor's work the engine asks for outside a render, behind names of its own: planning a run's edit, the run and
 * render lookups of a terminal, the plan of an export, the files an edit reads, a media probe, what component
 * previews are made of, the editor's render errors and which of them a failure is. The renders folder's versions are
 * on the Outputs port (versions.ts); a render's paths and the theme hashes are the planner entry's pure values. The engine loads the editor here, in the render folder, and nowhere
 * else (the import-rules ratchet's `loader-use`); the planner's pure values (`@retake/editor/plan`) are free.
 */
import { isAbsolute, join } from 'node:path';
import type { LoadedProject } from '@retake/core/project';
import type { LoadedTemplate } from '@retake/core/theme';
import type { WorkFileFacts } from '@retake/core/model';
import type { WorkPolicy } from '@retake/core/policy';
import type { ComponentRegistry } from '@retake/components/geometry';
import type { Timeline } from '@retake/core/run';
import type { FoundRender } from '@retake/editor';
import type { PlanRunOptions, PlannedRun, RenderAttempt, RunRef } from '@retake/editor/plan';
import type { RenderSettings } from '@retake/core/model';
import { withPlan } from '@retake/editor/plan';
import { editor } from '../lazy.js';
import type { RenderOutputs } from '../outputs/outputs.js';

type Editor = Awaited<ReturnType<typeof editor>>;

// The editor's types the engine's callers name: the planner entry's, and the few still declared beside the renderer
// (a found render's answer, a still's and the previews' options, a preview backend), which the render home hands on so
// that no file outside it imports the editor's root (types included). That list is pinned (core import-rules test).
export type { ExportFormat, ExportRenderOptions, ExportResult, PlanRunOptions, PlannedRun, RunRef } from '@retake/editor/plan';
export type { FoundRender, PreviewBackend, RenderLoopsOptions, RenderPreviewsOptions, RenderStillOptions } from '@retake/editor';

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
 * The render named at a terminal: `latest` (of `scenario`), an id, or a .json / .mp4 path, read through the renders of
 * the Outputs port (core io findNamedRender on its file layer; the editor's ExportError otherwise) — the record, the
 * FILE it was read from (`entry.name`: what a command then names, never the id the record says) and, with `latest`,
 * what it passed over.
 */
export async function findRenderOf(renders: RenderOutputs, project: LoadedProject, arg: string, scenario?: string): Promise<FoundRender> {
  const found = await renders.named(renders.dirOf(project.dir), arg, { verb: 'export', slug: project.slug, ...(scenario !== undefined ? { scenario } : {}) });
  if (!found.ok) throw new (await editor()).ExportError(found.message);
  // (findNamedRender refuses a record without its plan: this is the editor's type for what it read.)
  return { ...found.render, record: withPlan(found.render.record).value };
}

/** The theme a shell's component previews are drawn with, read with the workspace's file facts. */
export async function previewThemeOf(theme: string, root: string, facts: WorkFileFacts): Promise<LoadedTemplate> {
  return (await editor()).loadPreviewTheme(theme, root, facts);
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

/**
 * The editor's render errors, made here for the engine's render use case (render-video.ts, versions.ts): what a
 * client is told of a render, and how a shell reads it (editorErrorOf), stays the editor's classes.
 */
export const renderErrors = {
  /** A render that cannot start or failed (RenderError), with the attempt it carries. */
  async render(message: string, record?: RenderAttempt): Promise<Error> {
    return new (await editor()).RenderError(message, record);
  },
  /** A render cancelled through its signal (RenderCancelledError): nothing written under the final names. */
  async cancelled(record?: RenderAttempt): Promise<Error> {
    return new (await editor()).RenderCancelledError(record);
  },
};

/**
 * The concurrency a render's record says before the renderer answers: the one asked, else the render policy's under
 * `policy` and `settings` (its default when the policy cannot be read: the render then says why).
 */
export async function plannedConcurrency(policy: WorkPolicy, settings: RenderSettings | undefined, asked: number | undefined): Promise<number> {
  const ed = await editor();
  if (asked !== undefined) return asked;
  try {
    return ed.renderPolicy(policy, settings).concurrency;
  } catch {
    return ed.defaultConcurrency();
  }
}

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
