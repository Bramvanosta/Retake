/**
 * Rendering component previews (R-CMP-12/13/14): `renderComponentPreviews` renders the ComponentPreview composition of
 * each component with a theme (the editorial theme for the committed previews) — one bundle, one asset server and one
 * browser for all of them (≈ 0.5 s per preview once the bundle is cached) — into `<component dir>/preview.png`
 * (960×540: the 1920×1080 frame at half scale; palette-quantised when the full-colour PNG would exceed 200 KB), its
 * sidecar `preview.json` (source hash: see @demo-studio/components `previewStatus`) and the generated block of the
 * component's README.md. With `outDir`, only the images are written there (`<outDir>/<namespace>/<name>.png`).
 *
 * Previews of the jobs worker (MCP `component_preview` / `template_preview`) take `outDir` (never a component folder),
 * slot / param overrides per target, `network: 'guard'` (the render's network guard: only the asset server and the
 * bundle server) and a cancel signal checked between targets.
 *
 * `renderComponentLoops` (L4.7, the Studio library) renders a poster (the still above) and / or a looping GIF (640×360,
 * 15 fps, at most 6 s, motion mode for transitions; re-rendered at 480×270 when over 1.5 MB, else "too large") per item
 * into the files the caller names. Its items are isolated: one component that fails to build or render is reported in
 * `failed` and the others go on; a full disk stops the session (RenderDiskFullError, no further item). Both functions
 * share one session (asset server, bundle, browser, guard); `bundle: 'registry'` bundles every usable component of the
 * registry and the scaffolds — one bundle per registry state, shared by every library job — instead of the components
 * shown. The Remotion part is a `PreviewBackend` (tests inject their own).
 */
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { STARTER_TEMPLATES_DIR, loadTemplate } from '@demo-studio/core';
import type { LoadedTemplate } from '@demo-studio/core';
import {
  PREVIEW_FILE,
  PREVIEW_FORMAT,
  PREVIEW_MAX_BYTES,
  PREVIEW_META_FILE,
  PREVIEW_SIZE,
  componentSourceFiles,
  componentSourceHash,
  loadComponentRegistry,
  paramDefaults,
  themeTokens,
  writePreviewReadme,
} from '@demo-studio/components';
import type { ComponentManifest, ComponentRegistry, JsonSchemaNode, PreviewMeta } from '@demo-studio/components';
import { buildComponentPreview, loadPreviewSamples } from '../preview.js';
import type { BuiltPreview, ComponentPreviewSpec, PreviewSamples } from '../preview.js';
import { startAssetServer } from './asset-server.js';
import { renderBrowser } from './browser.js';
import { ensureBundle, registryBundleComponents, scaffoldComponents } from './bundle.js';
import type { BundleComponent } from './bundle.js';
import { armNetworkGuard, browserProcessInfo, pickFreePort } from './network-guard.js';
import type { BrowserProcessInfo, NetworkGuard } from './network-guard.js';
import type { RenderNetwork } from './render.js';
import { RenderCancelledError, RenderDiskFullError, RenderError, isDiskFullError } from './types.js';

/** The starter templates shipped with Demo Studio (default, editorial, motion). */
export { STARTER_TEMPLATES_DIR };

/**
 * The theme of previews: a template of the workspace (name or path), else — for a bare name — the starter template of
 * that name shipped with Demo Studio (the committed previews use the starter `editorial`): `loadTemplate` falls back
 * to the starters itself.
 */
export async function loadPreviewTheme(nameOrDir: string, root: string): Promise<LoadedTemplate> {
  return loadTemplate(nameOrDir, root);
}

/** Composition id of component previews (see ../remotion/Root.tsx). */
export const PREVIEW_COMPOSITION = 'ComponentPreview';

/**
 * The looping previews of the Studio library (R-UI-06b): GIF 640×360 at 15 fps (every second frame of the 30 fps
 * composition), playing forever, at most 6 s of the component (long cards loop their first 6 s); over 1.5 MB it is
 * rendered again at 480×270, still over → no loop ("too large").
 */
export const LOOP_FORMAT = { width: 640, height: 360, fps: 15, max_s: 6, max_bytes: 1_500_000, fallback_width: 480 } as const;

/** A component to preview: a registry entry, a scaffold (`scaffolds/<kind>`) or any component folder. */
export interface PreviewComponentTarget {
  id: string;
  dir: string;
  entry: string;
  manifest: ComponentManifest;
  /** Slot values over the manifest's preview samples (checked by the caller). */
  slots?: Record<string, string>;
  /** Params over the manifest's preview params (validated by the caller). */
  params?: Record<string, unknown>;
  /** Second shown (default: the manifest's preview moment). */
  at?: number;
  /** With outDir: the image's file name (default `<namespace>/<name>.png`). */
  file?: string;
}

/** Which components a preview session bundles. */
export type PreviewBundleMode =
  /** The targets and the context components their specs use (one bundle per set: the default). */
  | 'used'
  /** Every usable registry component and the scaffolds: one bundle per registry state, whatever the targets. */
  | 'registry';

/** What renders a session's frames: Remotion in the render browser (the default), or a test's stand-in. */
export interface PreviewBackend {
  /** The bundle of these components (default: ensureBundle in the workspace cache). */
  bundle(o: { root: string; components: BundleComponent[]; cacheDir?: string; signal?: AbortSignal }): Promise<{ serveUrl: string; hash: string; cached: boolean }>;
  /** Start the renderer on that bundle (default: the render browser, guarded when asked). */
  open(o: { serveUrl: string; assetPrefix: string; network?: RenderNetwork; signal?: AbortSignal; onBrowser?: (b: BrowserProcessInfo) => void }): Promise<PreviewRenderer>;
}

export interface PreviewRenderer {
  /** A PNG of `spec` at `spec.frame`, scaled. */
  still(spec: ComponentPreviewSpec, out: string, scale: number): Promise<void>;
  /** A GIF of `spec` over the composition frames `frames` [first, last], every `everyNthFrame`, scaled, looping forever. */
  gif(spec: ComponentPreviewSpec, out: string, o: { scale: number; everyNthFrame: number; frames: [number, number] }): Promise<void>;
  /** The guard's blocked origins so far. */
  warnings(): string[];
  close(): Promise<void>;
}

/** What every preview session takes. */
interface PreviewSessionOptions {
  /** Workspace root (bundle cache). */
  root: string;
  /** Theme of the previews (the committed built-in previews use the editorial theme). */
  template: LoadedTemplate;
  /** Context components (the theme's layout, caption, card) come from it (default: the workspace's). */
  registry?: ComponentRegistry;
  cacheDir?: string;
  samples?: PreviewSamples;
  /** Checked between previews: an abort stops before the next one (RenderCancelledError). */
  signal?: AbortSignal;
  /** `guard`: the previews' Chromium loads only the asset and bundle servers (network-guard.ts; the jobs worker). */
  network?: RenderNetwork;
  /** Called once the browser runs, with its process (the jobs worker records it to kill it after a crash). */
  onBrowser?: (b: BrowserProcessInfo) => void;
  /** Receives the guard's blocked-origin warnings once the previews are done. */
  onWarnings?: (warnings: string[]) => void;
  /** Bundle the components shown (default) or the whole registry. */
  bundle?: PreviewBundleMode;
  /** Tests: render with this instead of Remotion. */
  backend?: PreviewBackend;
}

export interface RenderPreviewsOptions extends PreviewSessionOptions {
  targets: PreviewComponentTarget[];
  /** Write only the images, to `<outDir>/<namespace>/<name>.png`, instead of updating the component folders. */
  outDir?: string;
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

/** One component of `renderComponentLoops` and the files it writes (absolute; their folder exists). */
export interface LoopItem {
  target: PreviewComponentTarget;
  /** The poster (PNG 960×540, the still of `renderComponentPreviews`). */
  poster?: string;
  /** The loop (GIF, LOOP_FORMAT). */
  loop?: string;
}

export interface RenderedPoster {
  file: string;
  bytes: number;
  width: number;
  height: number;
  /** Second shown. */
  at: number;
  quantized: boolean;
}

export type RenderedLoop =
  | { file: string; bytes: number; width: number; height: number; fps: number; frames: number; duration_s: number }
  /** Over LOOP_FORMAT.max_bytes even at the fallback width: no file written. */
  | { too_large: true; bytes: number };

export interface RenderedLoopItem {
  id: string;
  poster?: RenderedPoster;
  loop?: RenderedLoop;
}

/** A component of a session that could not be built or rendered. `reason` may carry the component's own words: untrusted text. */
export interface PreviewFailure {
  id: string;
  reason: string;
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

function run(cmd: string, args: string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((ok) => {
    execFile(cmd, args, { maxBuffer: 8 * 1024 * 1024 }, (err, _stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 127) : 0;
      ok({ code, stderr: String(stderr) });
    });
  });
}

/**
 * A 256-colour PNG of `src` (ffmpeg palettegen + paletteuse, light ordered dithering: no banding on the theme
 * gradients). Returns false when ffmpeg is not available.
 */
async function quantizePng(src: string, out: string): Promise<boolean> {
  const r = await run('ffmpeg', [
    '-v', 'error', '-y', '-i', src,
    '-vf', 'split[a][b];[a]palettegen=max_colors=256:stats_mode=full[p];[b][p]paletteuse=dither=bayer:bayer_scale=4',
    '-frames:v', '1', out,
  ]);
  return r.code === 0;
}

function bundleComponentOf(t: Pick<PreviewComponentTarget, 'id' | 'dir' | 'entry' | 'manifest'>): BundleComponent {
  return { id: t.id, kind: t.manifest.kind, dir: t.dir, entry: t.entry, defaults: paramDefaults(t.manifest.params as JsonSchemaNode | undefined) };
}

/** The bundle components of the previews: every component shown (targets + context) and the per-kind scaffolds. */
async function previewBundleComponents(targets: readonly PreviewComponentTarget[], ids: readonly string[], registry: ComponentRegistry): Promise<BundleComponent[]> {
  const out = new Map<string, BundleComponent>();
  for (const t of targets) out.set(t.id, bundleComponentOf(t));
  for (const id of ids) {
    if (out.has(id)) continue;
    const info = registry.get(id);
    out.set(id, bundleComponentOf({ id, dir: info.dir, entry: info.entry, manifest: info.manifest }));
  }
  return [...out.values(), ...(await scaffoldComponents())];
}

/**
 * The whole registry's bundle components; a target outside the registry (a scaffold, a folder) is added, and a target
 * whose folder differs from its registry entry's replaces it (the bundle then is that set's own).
 */
async function registryPreviewComponents(targets: readonly PreviewComponentTarget[], registry: ComponentRegistry): Promise<BundleComponent[]> {
  const all = await registryBundleComponents(registry);
  const byId = new Map(all.map((c) => [c.id, c]));
  for (const t of targets) {
    const have = byId.get(t.id);
    if (!have || resolve(have.dir) !== resolve(t.dir) || resolve(have.entry) !== resolve(t.entry)) byId.set(t.id, bundleComponentOf(t));
  }
  return [...byId.values()];
}

/** `<outDir>/<namespace>/<name>.png` for an id ("scaffolds/layout" → scaffolds/layout.png). */
function outFile(outDir: string, id: string): string {
  const [ns, name] = id.includes('/') ? id.split('/') : ['_', id];
  return join(resolve(outDir), ns, `${name}.png`);
}

function cancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new RenderCancelledError();
}

/** The default backend: the workspace's bundle cache and Remotion in the render browser (guarded when asked). */
export const REMOTION_PREVIEW_BACKEND: PreviewBackend = {
  async bundle(o) {
    const b = await ensureBundle({ root: o.root, components: o.components, ...(o.cacheDir ? { cacheDir: o.cacheDir } : {}), ...(o.signal ? { signal: o.signal } : {}) });
    return { serveUrl: b.serveUrl, hash: b.hash, cached: b.cached };
  },
  async open(o) {
    const browser = renderBrowser();
    const { openBrowser, renderMedia, renderStill, selectComposition, makeCancelSignal } = await import('@remotion/renderer');
    let puppeteer: Awaited<ReturnType<typeof openBrowser>>;
    try {
      puppeteer = await openBrowser('chrome', { browserExecutable: browser.path, chromeMode: 'headless-shell', logLevel: 'error' });
    } catch (e) {
      throw new RenderError(`the render browser did not start (${browser.path ?? 'Remotion headless shell'}): ${(e as Error).message.split('\n')[0]}`);
    }
    let guard: NetworkGuard | undefined;
    let remotion: { port?: number; onDownload?: (src: string) => undefined } = {};
    try {
      if (o.onBrowser) {
        const info = await browserProcessInfo(puppeteer);
        if (info) o.onBrowser(info);
      }
      if (o.network === 'guard') {
        try {
          const port = await pickFreePort();
          guard = await armNetworkGuard(puppeteer, { assetPrefix: o.assetPrefix, bundlePort: port });
          remotion = { port, onDownload: (src: string) => guard!.onDownload(src) };
        } catch (e) {
          throw new RenderError(`the previews cannot run with their network guard: ${(e as Error).message}`);
        }
      }
    } catch (e) {
      await puppeteer.close({ silent: true }).catch(() => undefined);
      throw e;
    }
    const common = { chromeMode: 'headless-shell', logLevel: 'error', timeoutInMilliseconds: 60_000 } as const;
    const select = (spec: ComponentPreviewSpec) =>
      selectComposition({
        ...common,
        serveUrl: o.serveUrl,
        id: PREVIEW_COMPOSITION,
        inputProps: { preview: spec },
        puppeteerInstance: puppeteer,
        browserExecutable: browser.path,
        ...(remotion.port !== undefined ? { port: remotion.port } : {}),
      });
    return {
      async still(spec, out, scale) {
        const composition = await select(spec);
        await renderStill({
          ...common,
          composition,
          serveUrl: o.serveUrl,
          frame: spec.frame,
          output: out,
          imageFormat: 'png',
          scale,
          overwrite: true,
          inputProps: { preview: spec },
          puppeteerInstance: puppeteer,
          browserExecutable: browser.path,
          ...remotion,
        });
      },
      async gif(spec, out, g) {
        const composition = await select(spec);
        const { cancelSignal, cancel } = makeCancelSignal();
        const onAbort = () => cancel();
        o.signal?.addEventListener('abort', onAbort);
        try {
          await renderMedia({
            ...common,
            composition,
            serveUrl: o.serveUrl,
            codec: 'gif',
            scale: g.scale,
            everyNthFrame: g.everyNthFrame,
            numberOfGifLoops: null,
            frameRange: g.frames,
            outputLocation: out,
            overwrite: true,
            inputProps: { preview: spec },
            cancelSignal,
            puppeteerInstance: puppeteer,
            browserExecutable: browser.path,
            ...remotion,
          });
        } finally {
          o.signal?.removeEventListener('abort', onAbort);
        }
      },
      warnings: () => guard?.warnings() ?? [],
      close: () => puppeteer.close({ silent: true }).catch(() => undefined),
    };
  },
};

type Variant = 'still' | 'motion';

interface SessionJob {
  target: PreviewComponentTarget;
  variants: readonly Variant[];
}

interface SessionItem<J extends SessionJob> {
  job: J;
  previews: Partial<Record<Variant, BuiltPreview>>;
}

interface SessionContext {
  renderer: PreviewRenderer;
  /** A scratch folder of this session (removed at its end). */
  scratch: string;
}

/** A failed item of a session and the step it failed at (a `bundle` / `render` failure may be another component's). */
interface SessionFailure<J> extends PreviewFailure {
  job: J;
  step: 'build' | 'bundle' | 'render';
}

/**
 * One preview session: specs built with the asset server's URLs, one bundle, one renderer; `each` per item. `isolate`:
 * an item that fails to build or render becomes a failure and the next goes on (else the first failure throws) — and
 * the renderer is opened afresh before the next item (a failed composition select can leave its pinned port taken:
 * every later item would fail for that alone, review B M1); `o.bundleFailure: 'items'`: a bundle that does not build
 * fails every item instead of the session. A full disk and a cancel always stop the session.
 */
async function previewSession<J extends SessionJob, R>(
  opts: PreviewSessionOptions,
  jobs: readonly J[],
  isolate: boolean,
  each: (ctx: SessionContext, item: SessionItem<J>, index: number) => Promise<R>,
  o: { bundleFailure?: 'throw' | 'items'; onFailure?: (f: SessionFailure<J>) => void } = {},
): Promise<{ results: Array<{ job: J; value: R }>; failed: Array<SessionFailure<J>>; bundle: { hash: string; cached: boolean } | null; warnings: string[] }> {
  const failed: Array<SessionFailure<J>> = [];
  const results: Array<{ job: J; value: R }> = [];
  if (jobs.length === 0) return { results, failed, bundle: null, warnings: [] };
  cancelled(opts.signal);
  const root = resolve(opts.root);
  const backend = opts.backend ?? REMOTION_PREVIEW_BACKEND;
  const registry = opts.registry ?? (await loadComponentRegistry({ root }));
  const samples = opts.samples ?? loadPreviewSamples();
  const server = await startAssetServer();
  const tpl = opts.template;
  const tokens = themeTokens(tpl, {
    logo: server.urlFor(tpl.assets.logo),
    wordmark: tpl.assets.wordmark ? server.urlFor(tpl.assets.wordmark) : undefined,
    fonts: { display: server.urlFor(tpl.assets.display), body: tpl.assets.body.map((f) => server.urlFor(f)) },
  });
  const fail = (job: J, e: unknown, what: string, step: SessionFailure<J>['step']): void => {
    const id = job.target.id;
    const reason = `${what}: ${(e as Error)?.message ?? String(e)}`;
    if (!isolate) throw e instanceof RenderError ? e : new RenderError(`preview of ${id}: ${(e as Error)?.message ?? String(e)}`);
    const f = { id, reason, job, step };
    failed.push(f);
    o.onFailure?.(f);
  };
  const built: Array<SessionItem<J>> = [];
  for (const job of jobs) {
    const { target } = job;
    try {
      const previews: SessionItem<J>['previews'] = {};
      for (const v of job.variants) {
        previews[v] = buildComponentPreview({
          target,
          template: tpl,
          tokens,
          registry,
          samples,
          sampleUrl: (f) => server.urlFor(f),
          ...(target.slots ? { slots: target.slots } : {}),
          ...(target.params ? { params: target.params } : {}),
          ...(target.at !== undefined ? { at: target.at } : {}),
          ...(v === 'motion' ? { motion: true } : {}),
        });
      }
      built.push({ job, previews });
    } catch (e) {
      fail(job, e, 'its preview could not be built', 'build');
    }
  }
  if (built.length === 0) {
    await server.close();
    return { results, failed, bundle: null, warnings: [] };
  }
  let renderer: PreviewRenderer | undefined;
  const scratch = join(tmpdir(), `demo-studio-preview-${process.pid}-${randomBytes(4).toString('hex')}`);
  try {
    const targets = built.map((b) => b.job.target);
    const components =
      opts.bundle === 'registry'
        ? await registryPreviewComponents(targets, registry)
        : await previewBundleComponents(targets, [...new Set(built.flatMap((b) => Object.values(b.previews).flatMap((p) => p!.components)))], registry);
    let bundle: Awaited<ReturnType<PreviewBackend['bundle']>>;
    try {
      bundle = await backend.bundle({ root, components, ...(opts.cacheDir ? { cacheDir: opts.cacheDir } : {}), ...(opts.signal ? { signal: opts.signal } : {}) });
    } catch (e) {
      if (o.bundleFailure !== 'items' || e instanceof RenderCancelledError || opts.signal?.aborted || isDiskFullError(e)) throw e;
      for (const b of built) fail(b.job, e, 'its preview could not be bundled', 'bundle');
      return { results, failed, bundle: null, warnings: [] };
    }
    const open = () =>
      backend.open({
        serveUrl: bundle.serveUrl,
        assetPrefix: server.prefix,
        ...(opts.network ? { network: opts.network } : {}),
        ...(opts.signal ? { signal: opts.signal } : {}),
        ...(opts.onBrowser ? { onBrowser: opts.onBrowser } : {}),
      });
    renderer = await open();
    await mkdir(scratch, { recursive: true });
    const warnings = new Set<string>();
    for (let i = 0; i < built.length; i++) {
      cancelled(opts.signal);
      const item = built[i];
      try {
        results.push({ job: item.job, value: await each({ renderer, scratch }, item, i) });
      } catch (e) {
        if (e instanceof RenderCancelledError || opts.signal?.aborted) throw new RenderCancelledError();
        if (isDiskFullError(e)) throw new RenderDiskFullError(`preview of ${item.job.target.id}: ${(e as Error).message}`);
        fail(item.job, e, 'its preview failed', 'render');
        if (i < built.length - 1) {
          for (const w of renderer.warnings()) warnings.add(w);
          const old = renderer;
          renderer = undefined;
          await old.close().catch(() => undefined);
          renderer = await open();
        }
      }
    }
    for (const w of renderer.warnings()) warnings.add(w);
    opts.onWarnings?.([...warnings]);
    return { results, failed, bundle: { hash: bundle.hash, cached: bundle.cached }, warnings: [...warnings] };
  } catch (e) {
    if (e instanceof RenderError) throw e;
    if (opts.signal?.aborted) throw new RenderCancelledError();
    if (isDiskFullError(e)) throw new RenderDiskFullError(`component previews: ${(e as Error).message}`);
    throw new RenderError(`component previews failed: ${(e as Error).message}`);
  } finally {
    await renderer?.close().catch(() => undefined);
    await server.close();
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** The poster of a built still: rendered at half scale, quantised over PREVIEW_MAX_BYTES; RenderError when still over. */
async function renderPoster(ctx: SessionContext, id: string, preview: BuiltPreview, tag: string): Promise<{ image: string; bytes: number; quantized: boolean }> {
  const raw = join(ctx.scratch, `${tag}-raw.png`);
  await ctx.renderer.still(preview.spec, raw, PREVIEW_SIZE.width / preview.spec.width);
  let image = raw;
  let quantized = false;
  if ((await stat(raw)).size > PREVIEW_MAX_BYTES) {
    const q = join(ctx.scratch, `${tag}-q.png`);
    if (await quantizePng(raw, q)) {
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

/** Render the previews of `targets` with one theme (see the module comment): the first failure throws. */
export async function renderComponentPreviews(opts: RenderPreviewsOptions): Promise<RenderedPreview[]> {
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
      const readme = await writePreviewReadme(target.dir, target.manifest, meta);
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
 * `bundle: 'registry'` (L4.7 review fixes A M3 / B H1): the whole registry shares one page, so one workspace component
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
