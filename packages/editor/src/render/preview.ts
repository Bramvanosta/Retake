/**
 * Rendering component previews (R-CMP-12/13/14): `renderComponentPreviews` renders the ComponentPreview composition of
 * each component with a theme (the editorial theme for the committed previews) — one bundle, one asset server and one
 * browser for all of them (≈ 0.5 s per preview once the bundle is cached) — into `<component dir>/preview.png`
 * (960×540: the 1920×1080 frame at half scale; palette-quantised when the full-colour PNG would exceed 200 KB), its
 * sidecar `preview.json` (source hash: see @retake/components `previewStatus`) and the generated block of the
 * component's README.md. With `outDir`, only the images are written there (`<outDir>/<namespace>/<name>.png`).
 *
 * Previews of the jobs worker (MCP `component_preview` / `template_preview`) take `outDir` (never a component folder),
 * slot / param overrides per target, `network: 'guard'` (the render's network guard: only the asset server and the
 * bundle server) and a cancel signal checked between targets.
 *
 * `renderComponentLoops` (the Studio library) renders a poster (the still above) and / or a looping GIF (640×360,
 * 15 fps, at most 6 s, motion mode for transitions; re-rendered at 480×270 when over 1.5 MB, else "too large") per item
 * into the files the caller names. Its items are isolated: one component that fails to build or render is reported in
 * `failed` and the others go on; a full disk stops the session (RenderDiskFullError, no further item). Both functions
 * share one session (asset server, bundle, browser, guard); `bundle: 'registry'` bundles every usable component of the
 * registry and the scaffolds — one bundle per registry state, shared by every library job — instead of the components
 * shown. The Remotion part is a `PreviewBackend` (tests inject their own).
 */
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { STARTER_TEMPLATES_DIR, assertOutsideBundle, ffmpegBin, loadTemplate, runMediaTool } from '@retake/core/io';
import { errorMessage, pathInside } from '@retake/core/base';
import type { LoadedTemplate } from '@retake/core/theme';
import type { WorkFileFacts } from '@retake/core/model';
import type { WorkPolicy } from '@retake/core/policy';
import {
  PREVIEW_FILE,
  PREVIEW_FORMAT,
  PREVIEW_MAX_BYTES,
  PREVIEW_META_FILE,
  PREVIEW_SIZE,
  componentSourceFiles,
  componentSourceHash,
  mergePreviewReadme,
  previewReadmeBlock,
  writePreviewReadme,
} from '@retake/components';
import type { PreviewMeta } from '@retake/components';
import type { BuiltPreview, ComponentPreviewSpec } from '../preview.js';
import { PREVIEW_COMPOSITION } from '../remotion/contract.js';
import { previewSession } from './preview-session.js';
import type { PreviewBundleMode, PreviewFailure, PreviewSessionOptions, SessionContext, SessionItem, Variant } from './preview-session.js';
import { RenderError, isDiskFullError } from './types.js';
import type { PreviewComponentTarget, PreviewReadmeWriter, LoopItem, RenderedLoop, RenderedLoopItem } from '../work-types.js';
export { REMOTION_PREVIEW_BACKEND, previewDriver } from './preview-backend.js';
export type { PreviewBackend, PreviewRenderer } from './preview-backend.js';
export { previewBundleComponents } from './preview-session.js';
export type { PreviewBundleMode, PreviewFailure } from './preview-session.js';
export type { PreviewComponentTarget, PreviewReadmeWriter, LoopItem, RenderedPoster, RenderedLoop, RenderedLoopItem } from '../work-types.js';

/** The starter templates shipped with Retake (default, editorial, motion). */
export { STARTER_TEMPLATES_DIR };

/**
 * The theme of previews: a template of the project (`projectDir`: its own themes first), of the workspace (name or
 * path), else — for a bare name — the starter template of
 * that name shipped with Retake (the committed previews use the starter `editorial`): `loadTemplate` falls back
 * to the starters itself.
 */
export async function loadPreviewTheme(nameOrDir: string, root: string, files: WorkFileFacts, projectDir?: string): Promise<LoadedTemplate> {
  return loadTemplate(nameOrDir, root, { files, ...(projectDir !== undefined ? { projectDir } : {}) });
}

/** Composition id of component previews (written once, in ../remotion/contract.ts). */
export { PREVIEW_COMPOSITION };

/**
 * The looping previews of the Studio library (R-UI-06b): GIF 640×360 at 15 fps (every second frame of the 30 fps
 * composition), playing forever, at most 6 s of the component (long cards loop their first 6 s); over 1.5 MB it is
 * rendered again at 480×270, still over → no loop ("too large").
 */
export const LOOP_FORMAT = { width: 640, height: 360, fps: 15, max_s: 6, max_bytes: 1_500_000, fallback_width: 480 } as const;

export interface RenderPreviewsOptions extends PreviewSessionOptions {
  targets: PreviewComponentTarget[];
  /** Write only the images, to `<outDir>/<namespace>/<name>.png`, instead of updating the component folders. */
  outDir?: string;
  /**
   * The READMEs of the components under a writer's `root` are written through its `write` (the workspace's components
   * folder, a project's own); any other README (the built-in library's, the scaffolds', every one without this
   * option) is written directly (writePreviewReadme).
   */
  readmes?: PreviewReadmeWriter | readonly PreviewReadmeWriter[];
  onProgress?: (done: number, total: number, id: string) => void;
}

export interface RenderedPreview {
  id: string;
  /** The image written. */
  file: string;
  bytes: number;
  /** Second shown. */
  at: number;
  screen?: string;
  /** Palette-quantised to stay under PREVIEW_MAX_BYTES. */
  quantized: boolean;
  /** Written in the component folder (without outDir). */
  meta?: PreviewMeta;
  readme?: string;
}

export interface RenderLoopsOptions extends PreviewSessionOptions {
  items: LoopItem[];
  /** After each item's files are written (the jobs worker moves them into its cache): awaited, its errors are the item's. */
  onItem?: (item: RenderedLoopItem, index: number) => Promise<void> | void;
  onProgress?: (done: number, total: number, id: string) => void;
}

export interface RenderLoopsResult {
  rendered: RenderedLoopItem[];
  failed: PreviewFailure[];
  /** The bundle used (null when no item could be built). */
  bundle: { hash: string; cached: boolean } | null;
  warnings: string[];
}

/**
 * A 256-colour PNG of `src` (ffmpeg palettegen + paletteuse, light ordered dithering: no banding on the theme
 * gradients). Returns false when ffmpeg is not available.
 */
async function quantizePng(src: string, out: string, work: WorkPolicy): Promise<boolean> {
  const r = await runMediaTool(
    ffmpegBin(work),
    ['-v', 'error', '-y', '-i', src, '-vf', 'split[a][b];[a]palettegen=max_colors=256:stats_mode=full[p];[b][p]paletteuse=dither=bayer:bayer_scale=4', '-frames:v', '1', out],
    { maxBuffer: 8 * 1024 * 1024 },
  );
  return r.code === 0;
}

/** `<outDir>/<namespace>/<name>.png` for an id ("scaffolds/layout" → scaffolds/layout.png). */
function outFile(outDir: string, id: string): string {
  const [ns, name] = id.includes('/') ? id.split('/') : ['_', id];
  return join(resolve(outDir), ns, `${name}.png`);
}

/** The poster of a built still: rendered at half scale, quantised over PREVIEW_MAX_BYTES; RenderError when still over. */
async function renderPoster(ctx: SessionContext, id: string, preview: BuiltPreview, tag: string): Promise<{ image: string; bytes: number; quantized: boolean }> {
  const raw = join(ctx.scratch, `${tag}-raw.png`);
  await ctx.renderer.still(preview.spec, raw, PREVIEW_SIZE.width / preview.spec.width);
  let image = raw;
  let quantized = false;
  if ((await stat(raw)).size > PREVIEW_MAX_BYTES) {
    const q = join(ctx.scratch, `${tag}-q.png`);
    if (await quantizePng(raw, q, ctx.workPolicy)) {
      image = q;
      quantized = true;
    }
  }
  const bytes = (await stat(image)).size;
  if (bytes > PREVIEW_MAX_BYTES) {
    throw new RenderError(`preview of ${id} is ${Math.round(bytes / 1024)} KB, over ${PREVIEW_MAX_BYTES / 1024} KB${quantized ? ' even with 256 colours' : ' (ffmpeg is needed to reduce it)'}`);
  }
  return { image, bytes, quantized };
}

/** The frames a loop covers ([0, last]) and its GIF frame count, for a spec. */
export function loopFrames(spec: Pick<ComponentPreviewSpec, 'durationInFrames' | 'fps'>): { frames: [number, number]; everyNthFrame: number; count: number; fps: number } {
  const everyNthFrame = Math.max(1, Math.round(spec.fps / LOOP_FORMAT.fps));
  const last = Math.max(0, Math.min(spec.durationInFrames, Math.round(LOOP_FORMAT.max_s * spec.fps)) - 1);
  return { frames: [0, last], everyNthFrame, count: Math.ceil((last + 1) / everyNthFrame), fps: spec.fps / everyNthFrame };
}

/** The loop of a built motion spec into `out` (LOOP_FORMAT, the fallback width when over the cap). */
async function renderLoop(ctx: SessionContext, preview: BuiltPreview, out: string, tag: string): Promise<RenderedLoop> {
  const spec = preview.spec;
  const f = loopFrames(spec);
  let bytes = 0;
  for (const width of [LOOP_FORMAT.width, LOOP_FORMAT.fallback_width]) {
    const file = join(ctx.scratch, `${tag}-${width}.gif`);
    await ctx.renderer.gif(spec, file, { scale: width / spec.width, everyNthFrame: f.everyNthFrame, frames: f.frames });
    bytes = (await stat(file)).size;
    if (bytes <= LOOP_FORMAT.max_bytes) {
      await copyFile(file, out);
      const height = Math.round((spec.height * width) / spec.width);
      return { file: out, bytes, width, height, fps: f.fps, frames: f.count, duration_s: Math.round(((f.frames[1] + 1) / spec.fps) * 1000) / 1000 };
    }
  }
  return { too_large: true, bytes };
}

/**
 * A component's README.md with its generated block for `meta`: through `readmes` when it lies under its root (on the
 * README as read, or created when there was none), else directly. Written after the image and preview.json: a refusal
 * of the README (the project store's: a link out of the components folder, a README changed meanwhile) says that
 * those two were written.
 */
async function writeReadmeOf(target: PreviewComponentTarget, meta: PreviewMeta, writers: PreviewReadmeWriter | readonly PreviewReadmeWriter[] | undefined): Promise<string> {
  const file = join(target.dir, 'README.md');
  const readmes = (writers === undefined ? [] : Array.isArray(writers) ? (writers as readonly PreviewReadmeWriter[]) : [writers as PreviewReadmeWriter]).find((w) => pathInside(file, w.root));
  if (!readmes) return writePreviewReadme(target.dir, target.manifest, meta);
  const existing = existsSync(file) ? await readFile(file, 'utf8') : null;
  try {
    await readmes.write(file, mergePreviewReadme(existing ?? undefined, previewReadmeBlock(target.manifest, meta)), existing);
  } catch (e) {
    if (isDiskFullError(e)) throw e;
    throw new RenderError(`preview of ${target.id}: its ${PREVIEW_FILE} and ${PREVIEW_META_FILE} were written, its README.md was not — ${errorMessage(e)}`);
  }
  return file;
}

/** Render the previews of `targets` with one theme (see the module comment): the first failure throws. */
export async function renderComponentPreviews(opts: RenderPreviewsOptions): Promise<RenderedPreview[]> {
  // Written next to each component unless --out: never inside the app bundle (core bundle.ts), checked before rendering.
  if (!opts.outDir) for (const t of opts.targets) assertOutsideBundle(t.dir, `the preview of ${t.id}`);
  const tpl = opts.template;
  const jobs = opts.targets.map((target) => ({ target, variants: ['still'] as const }));
  let done = 0;
  const { results } = await previewSession(opts, jobs, false, async (ctx, { job, previews }, i) => {
    const target = job.target;
    const preview = previews.still!;
    const { image, bytes, quantized } = await renderPoster(ctx, target.id, preview, String(i));
    let out: RenderedPreview;
    if (opts.outDir) {
      const file = target.file ? join(resolve(opts.outDir), target.file) : outFile(opts.outDir, target.id);
      await mkdir(join(file, '..'), { recursive: true });
      await writeFile(file, await readFile(image));
      out = { id: target.id, file, bytes, at: preview.at, ...(preview.screen ? { screen: preview.screen } : {}), quantized };
    } else {
      const file = join(target.dir, PREVIEW_FILE);
      const tmp = `${file}.tmp-${randomBytes(3).toString('hex')}`;
      await writeFile(tmp, await readFile(image));
      await rename(tmp, file);
      const files = componentSourceFiles(target.dir, target.manifest);
      const meta: PreviewMeta = {
        format: PREVIEW_FORMAT,
        component: target.id,
        version: target.manifest.version,
        kind: target.manifest.kind,
        theme: tpl.name,
        at: preview.at,
        ...(preview.screen ? { screen: preview.screen } : {}),
        files,
        source_hash: componentSourceHash(target.dir, files),
        image: { file: PREVIEW_FILE, width: PREVIEW_SIZE.width, height: PREVIEW_SIZE.height },
      };
      await writeFile(join(target.dir, PREVIEW_META_FILE), `${JSON.stringify(meta, null, 2)}\n`);
      const readme = await writeReadmeOf(target, meta, opts.readmes);
      out = { id: target.id, file, bytes, at: preview.at, ...(preview.screen ? { screen: preview.screen } : {}), quantized, meta, readme };
    }
    done++;
    opts.onProgress?.(done, jobs.length, target.id);
    return out;
  });
  return results.map((r) => r.value);
}

/**
 * Posters and / or loops of `items` with one theme (see the module comment): isolated per item (`failed`), a full disk
 * stops (RenderDiskFullError), a cancel stops (RenderCancelledError). An item's files are written only once both are
 * rendered; on its failure the files it named are removed. Progress counts every finished item, failed ones too.
 *
 * `bundle: 'registry'`: the whole registry shares one page, so one workspace component
 * that does not compile, or throws while its module loads, would fail every item. An item that fails to bundle or to
 * render there is rendered again with a bundle of only its own components (`used`) — a group at a time, a group whose
 * items all fail split in halves — until it fails alone: then the failure is its own.
 */
export async function renderComponentLoops(opts: RenderLoopsOptions): Promise<RenderLoopsResult> {
  type Job = { target: PreviewComponentTarget; item: LoopItem; index: number; variants: Variant[] };
  const jobs: Job[] = opts.items.map((item, index) => ({
    target: item.target,
    item,
    index,
    variants: [...(item.poster ? (['still'] as const) : []), ...(item.loop ? (['motion'] as const) : [])],
  }));
  let done = 0;
  const progress = (id: string) => {
    done++;
    opts.onProgress?.(done, jobs.length, id);
  };
  const each = async (ctx: SessionContext, { job, previews }: SessionItem<Job>): Promise<RenderedLoopItem> => {
    const { item, index } = job;
    const out: RenderedLoopItem = { id: item.target.id };
    try {
      let poster: { image: string; bytes: number; quantized: boolean } | undefined;
      if (item.poster) poster = await renderPoster(ctx, item.target.id, previews.still!, `${index}-poster`);
      if (item.loop) out.loop = await renderLoop(ctx, previews.motion!, item.loop, `${index}-loop`);
      if (item.poster && poster) {
        await copyFile(poster.image, item.poster);
        out.poster = { file: item.poster, bytes: poster.bytes, width: PREVIEW_SIZE.width, height: PREVIEW_SIZE.height, at: previews.still!.at, quantized: poster.quantized };
      }
      await opts.onItem?.(out, index);
    } catch (e) {
      for (const f of [item.poster, item.loop]) if (f) await rm(f, { force: true }).catch(() => undefined);
      throw e;
    }
    progress(item.target.id);
    return out;
  };
  const rendered: Array<{ index: number; value: RenderedLoopItem }> = [];
  const failed: Array<{ index: number; failure: PreviewFailure }> = [];
  const warnings = new Set<string>();
  let bundle: RenderLoopsResult['bundle'] = null;
  const { onWarnings, ...base } = opts;
  /** One session over `group`; `final`: its failures are the items' own (recorded, counted). Returns the others. */
  const round = async (group: readonly Job[], mode: PreviewBundleMode, final: boolean): Promise<Job[]> => {
    const again: Job[] = [];
    const session = await previewSession({ ...base, bundle: mode }, group, true, each, {
      bundleFailure: 'items',
      onFailure: (f) => {
        if (final || f.step === 'build') {
          failed.push({ index: f.job.index, failure: { id: f.id, reason: f.reason } });
          progress(f.id);
        } else again.push(f.job);
      },
    });
    for (const r of session.results) rendered.push({ index: r.job.index, value: r.value });
    for (const w of session.warnings) warnings.add(w);
    bundle ??= session.bundle;
    return again;
  };
  /** Items whose failure may be another component's: bundled with their own components, a group at a time. */
  const settle = async (group: Job[]): Promise<void> => {
    if (!group.length) return;
    const again = await round(group, 'used', group.length === 1);
    if (!again.length) return;
    if (again.length < group.length) return settle(again);
    const half = Math.ceil(again.length / 2);
    await settle(again.slice(0, half));
    await settle(again.slice(half));
  };
  if ((opts.bundle ?? 'used') === 'registry') await settle(await round(jobs, 'registry', false));
  else await round(jobs, 'used', true);
  onWarnings?.([...warnings]);
  return {
    rendered: rendered.sort((a, b) => a.index - b.index).map((r) => r.value),
    failed: failed.sort((a, b) => a.index - b.index).map((f) => f.failure),
    bundle,
    warnings: [...warnings],
  };
}
