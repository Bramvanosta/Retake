/**
 * The work that renders, on a renderer the caller hands (the port of renderer.ts): a video, a still, an export's
 * re-rendered formats, component previews and loops. A video is the engine's own use case (render-video.ts: the plan,
 * the version reserved, the record, where the files go, on the Outputs port's renders); a still, an export's
 * transcodes and the previews are the editor's, given the renderer to draw with (an export's re-rendered formats come
 * back to the engine's render use case). Results and errors come back unchanged. No function here picks a renderer:
 * the composition roots do (the composition package's editor-renderer.ts, or a test's own).
 */
import type { ExportRenderOptions, ExportResult, RenderLoopsOptions, RenderLoopsResult, RenderPreviewsOptions, RenderStillOptions, RenderedPreview } from '@retake/editor';
import type { RenderRecord } from '@retake/editor/plan';
import { EngineError } from '../errors.js';
import { editor } from '../lazy.js';
import { renderVideoWork } from './render-video.js';
import type { RenderPlace, RenderVideoOptions } from './render-video.js';
import type { OutputFolder } from '../outputs/outputs.js';
import type { Renderer } from './renderer.js';
import { versionLockFile } from './versions.js';
import { exportPlace, writeExportManifest } from './export-manifest.js';

export type { RenderVideoOptions } from './render-video.js';

/**
 * An editor use case's options with the renderer it runs on, required. What belongs to the editor's own driver is not
 * the engine's to say — its bundle cache folder, its test seams, a preview backend: a renderer was made with them, so
 * they are not options of work that is handed one (the editor refuses the mix too: render/driver-guard.ts there).
 */
export type OnRenderer<T> = Omit<T, 'renderer' | 'cacheDir' | 'seams' | 'backend'> & { renderer: Renderer };

/** The renderer of a request, or a refusal that names the work: a caller outside the type checker forgot it. */
function rendererOf(o: { renderer?: Renderer }, work: string): Renderer {
  const r = o.renderer;
  if (!r || typeof r.video !== 'function' || typeof r.stills !== 'function' || typeof r.previews !== 'object' || r.previews === null) {
    throw new EngineError('internal', `${work}: no renderer was handed to the engine`);
  }
  return r;
}

type Editor = Awaited<ReturnType<typeof editor>>;

/**
 * The one way this file reaches an editor use case: the request's renderer is checked first (no renderer, no work —
 * the editor is not even loaded), and the use case is handed that renderer by name, after the request's own fields.
 */
async function onRenderer<O extends { renderer: Renderer }, R>(work: string, o: O, run: (ed: Editor, o: O) => Promise<R>): Promise<R> {
  const renderer = rendererOf(o, work);
  return run(await editor(), { ...o, renderer });
}

/** The lock of a version reserved before, removed after a refusal that comes before the render (best effort). */
async function releaseReserved(o: Partial<Pick<RenderVideoOptions, 'reserved' | 'ws' | 'project'>>): Promise<void> {
  const { reserved, project } = o;
  const renders = o.ws?.outputs?.renders;
  if (!reserved || !renders || typeof renders.remove !== 'function' || typeof project?.dir !== 'string') return;
  try {
    await renders.remove(versionLockFile(renders.dirOf(project.dir), reserved.scenario, reserved.version));
  } catch {
    // A version no reservation hands out has no lock (the render refuses it by name).
  }
}

/** Render a run into renders/<scenario>-v<N>.mp4 + .json (render-video.ts, on the renderer and the renders handed). */
export async function renderWork(o: RenderVideoOptions): Promise<RenderRecord> {
  let renderer: Renderer;
  try {
    renderer = rendererOf(o, 'render');
  } catch (e) {
    await releaseReserved(o);
    throw e;
  }
  return renderVideoWork({ ...o, renderer });
}

/** Render one output frame of a plan to a PNG (the editor's renderStill). */
export async function stillWork(o: OnRenderer<RenderStillOptions>): Promise<string> {
  return onRenderer('still', o, (ed, on) => ed.renderStill(on));
}

/**
 * What an export is asked: the editor's options, the renderer its re-rendered formats are drawn with, the workspace
 * they are placed in (its exports and renders), the clock that stamps their records and its manifest, and `out`, an
 * output folder instead of exports/<render-id>/.
 */
export type ExportWorkOptions = Omit<OnRenderer<ExportRenderOptions>, 'rerender' | 'place'> &
  Pick<RenderVideoOptions, 'clock'> & { ws: RenderPlace & { outputs: { exports: OutputFolder } }; out?: string };

/**
 * Export a render's delivery files into exports/<render-id>/ (the editor's exportRender writes the formats where the
 * engine places them; export-manifest.ts writes the manifest): a format rendered again from the master is the engine's
 * render use case, on the renderer and the renders handed (its version, its record).
 */
export async function exportWork(o: ExportWorkOptions): Promise<ExportResult> {
  return onRenderer('export', o, async (ed, on) => {
    const { renderer, ws, clock, out, ...rest } = on;
    const made = await ed.exportRender({
      ...rest,
      // Asked once the editor checked what it was handed (a loaded project): exports/<name>/ of it, or `out`.
      place: (name) => exportPlace(ws.outputs.exports, on.project.dir, out)(name),
      rerender: (r) =>
        renderVideoWork({
          ...r,
          workPolicy: on.workPolicy,
          project: on.project,
          ...(on.root !== undefined ? { root: on.root } : {}),
          renderer,
          ws,
          clock,
        }),
    });
    return writeExportManifest(ws.outputs.exports, made, clock);
  });
}

/** Stills of components or of a theme (the editor's renderComponentPreviews). */
export async function previewsWork(o: OnRenderer<RenderPreviewsOptions>): Promise<RenderedPreview[]> {
  return onRenderer('preview', o, (ed, on) => ed.renderComponentPreviews(on));
}

/** Posters and loops of components (the editor's renderComponentLoops). */
export async function loopsWork(o: OnRenderer<RenderLoopsOptions>): Promise<RenderLoopsResult> {
  return onRenderer('preview', o, (ed, on) => ed.renderComponentLoops(on));
}

/** True when `e` says the disk was full (the editor's isDiskFullError: a field of the failure, an ENOSPC code or its words). */
export async function diskFullWork(e: unknown): Promise<boolean> {
  return (await editor()).isDiskFullError(e);
}
