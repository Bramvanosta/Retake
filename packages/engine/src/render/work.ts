/**
 * The work that renders, on a renderer the caller hands (the port of renderer.ts): a video, a still, an export's
 * re-rendered formats, component previews and loops. Each is the editor's use case — planning, the version reserved,
 * the render record, where files go — given the renderer to draw with; the editor's result and errors come back
 * unchanged. No function here picks a renderer: the composition roots do (editor-renderer.ts, or a test's own).
 */
import type {
  ExportRenderOptions,
  ExportResult,
  RenderLoopsOptions,
  RenderLoopsResult,
  RenderPreviewsOptions,
  RenderRecord,
  RenderStillOptions,
  RenderVideoOptions,
  RenderedPreview,
} from '@retake/editor';
import { EngineError } from '../errors.js';
import { editor } from '../lazy.js';
import type { Renderer } from './renderer.js';

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

/** Render a run into renders/<scenario>-v<N>.mp4 + .json (the editor's renderVideo). */
export async function renderWork(o: OnRenderer<RenderVideoOptions>): Promise<RenderRecord> {
  return onRenderer('render', o, (ed, on) => ed.renderVideo(on));
}

/** Render one output frame of a plan to a PNG (the editor's renderStill). */
export async function stillWork(o: OnRenderer<RenderStillOptions>): Promise<string> {
  return onRenderer('still', o, (ed, on) => ed.renderStill(on));
}

/** Export a render's delivery files into exports/<render-id>/ (the editor's exportRender; the renderer draws its re-rendered formats). */
export async function exportWork(o: OnRenderer<ExportRenderOptions>): Promise<ExportResult> {
  return onRenderer('export', o, (ed, on) => ed.exportRender(on));
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
