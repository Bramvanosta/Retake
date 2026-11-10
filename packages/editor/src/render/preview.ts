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
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { STARTER_TEMPLATES_DIR, assertOutsideBundle, ffmpegBin, loadTemplate } from '@retake/core/io';
import { pathInside } from '@retake/core';
import type { GpuInfo, LoadedTemplate, RenderSettings, WorkPolicy, WorkFileFacts } from '@retake/core';
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
  mergePreviewReadme,
  previewReadmeBlock,
  themeTokens,
  writePreviewReadme,
} from '@retake/components';
import type { ComponentManifest, ComponentRegistry, JsonSchemaNode, PreviewMeta } from '@retake/components';
import { buildComponentPreview, loadPreviewSamples } from '../preview.js';
import type { BuiltPreview, ComponentPreviewSpec, PreviewSamples } from '../preview.js';
import { startAssetServer } from './asset-server.js';
import { assertRenderBrowser, renderBrowser } from './browser.js';
import { ensureBundle, registryBundleComponents, scaffoldComponents } from './bundle.js';
import type { BundleComponent } from './bundle.js';
import { GUARDED_NO_OTHER_BROWSER, armNetworkGuard, browserProcessInfo, guardedPageFailed, guardedPageFailure, pickFreePort } from './network-guard.js';
import type { BrowserProcessInfo, NetworkGuard } from './network-guard.js';
import { guardEncoderPipe } from './render.js';
import type { RenderNetwork } from './render.js';
import { openRenderBrowser, renderPolicy } from './policy.js';
import { RenderCancelledError, RenderDiskFullError, RenderError, isDiskFullError } from './types.js';
import { errorKindOf } from '@retake/core';
import { handedDriver } from './driver-guard.js';
import type { DriverPreviewBundle, DriverPreviewSession, DriverPreviews, RenderDriver } from './driver-types.js';

/** The starter templates shipped with Retake (default, editorial, motion). */
export { STARTER_TEMPLATES_DIR };

/**
 * The theme of previews: a template of the workspace (name or path), else — for a bare name — the starter template of
 * that name shipped with Retake (the committed previews use the starter `editorial`): `loadTemplate` falls back
 * to the starters itself.
 */
export async function loadPreviewTheme(nameOrDir: string, root: string, files: WorkFileFacts): Promise<LoadedTemplate> {
  return loadTemplate(nameOrDir, root, { files });
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
  /**
   * Start the renderer on that bundle (default: the render browser as the render policy draws — the GPU checked before it
   * is reported or guarded; no fallback mid-way: a failure is said as it is —, guarded when asked).
   */
  open(o: {
    serveUrl: string;
    assetPrefix: string;
    network?: RenderNetwork;
    signal?: AbortSignal;
    onBrowser?: (b: BrowserProcessInfo) => void;
    settings?: RenderSettings;
    /** What the work runs under (core WorkPolicy). */
    workPolicy: WorkPolicy;
    /** Tests: the browser's GPU status. */
    gpuInfo?: (browser: { connection: unknown }) => Promise<GpuInfo | undefined>;
  }): Promise<PreviewRenderer>;
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
  /** What the work runs under (core WorkPolicy): which ffmpeg and render browser, its workspace's render settings. */
  workPolicy: WorkPolicy;
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
  /** What renders the previews (no such key: this package's driver — Remotion, with `cacheDir`; with one, `cacheDir` and `backend` are refused: driver-guard.ts). */
  renderer?: Pick<RenderDriver, 'previews'>;
  /** Tests of this package, standalone: render with this instead of Remotion. Never beside `renderer` (refused). */
  backend?: PreviewBackend;
  /** Render settings over the process's (./policy.ts). */
  settings?: RenderSettings;
}

/** How the README of a component folder is written (RenderPreviewsOptions.readmes). */
export interface PreviewReadmeWriter {
  /** The folder whose components' READMEs go through `write` (a workspace's components folder). */
  root: string;
  /**
   * Write `file` (a component's README.md under `root`) with `text`, merged into `previous`: the README as it was read —
   * the write is made on that version (`if_match` its hash) — or null when there was none (`if_match` null: created,
   * never over a README made in between). The engine's project store: an authored write, journaled.
   */
  write(file: string, text: string, previous: string | null): Promise<void>;
}

export interface RenderPreviewsOptions extends PreviewSessionOptions {
  targets: PreviewComponentTarget[];
  /** Write only the images, to `<outDir>/<namespace>/<name>.png`, instead of updating the component folders. */
  outDir?: string;
  /**
   * The READMEs of the components under `readmes.root` are written through `readmes.write`; any other README (the
   * built-in library's, the scaffolds', every one without this option) is written directly (writePreviewReadme).
   */
  readmes?: PreviewReadmeWriter;
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
async function quantizePng(src: string, out: string, work: WorkPolicy): Promise<boolean> {
  const r = await run(ffmpegBin(work), [
    '-v', 'error', '-y', '-i', src,
    '-vf', 'split[a][b];[a]palettegen=max_colors=256:stats_mode=full[p];[b][p]paletteuse=dither=bayer:bayer_scale=4',
    '-frames:v', '1', out,
  ]);
  return r.code === 0;
}

function bundleComponentOf(t: Pick<PreviewComponentTarget, 'id' | 'dir' | 'entry' | 'manifest'>): BundleComponent {
  return { id: t.id, kind: t.manifest.kind, dir: t.dir, entry: t.entry, defaults: paramDefaults(t.manifest.params as JsonSchemaNode | undefined) };
}

/**
 * The bundle components of the previews: every component shown (targets + context) and the per-kind scaffolds. A target
 * that IS a package scaffold (same id, same folder) is bundled once, as the scaffold (flagged: the bundle guard's
 * "belongs to no component" holder check does not apply to the package's own kit imports); any other target — a
 * workspace component reusing a scaffold's id from another folder — stays unflagged, under the holder check. Exported
 * for its test (editor preview-scaffold.test.ts, L5.13a review B M3).
 */
export async function previewBundleComponents(targets: readonly PreviewComponentTarget[], ids: readonly string[], registry: ComponentRegistry): Promise<BundleComponent[]> {
  const out = new Map<string, BundleComponent>();
  for (const t of targets) out.set(t.id, bundleComponentOf(t));
  for (const id of ids) {
    if (out.has(id)) continue;
    const info = registry.get(id);
    out.set(id, bundleComponentOf({ id, dir: info.dir, entry: info.entry, manifest: info.manifest }));
  }
  // A scaffold shown as a target is the scaffold itself: once, flagged (its kit imports are the package's own — L5.13a,
  // the first run that previewed every scaffold at once met the bundle guard's "belongs to no component").
  const scaffolds = await scaffoldComponents();
  for (const s of scaffolds) if (out.has(s.id) && resolve(out.get(s.id)!.dir) === resolve(s.dir)) out.delete(s.id);
  return [...out.values(), ...scaffolds];
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
    const browserExe = assertRenderBrowser(browser, o.workPolicy);
    const { openBrowser, renderMedia, renderStill, selectComposition, makeCancelSignal } = await import('@remotion/renderer');
    const policy = renderPolicy(o.workPolicy, o.settings);
    guardEncoderPipe();
    let opened: Awaited<ReturnType<typeof openRenderBrowser<Awaited<ReturnType<typeof openBrowser>>>>>;
    try {
      opened = await openRenderBrowser({
        policy,
        launch: (chromium) => openBrowser('chrome', { browserExecutable: browserExe, chromeMode: 'headless-shell', logLevel: 'error', ...(chromium.gl ? { chromiumOptions: chromium } : {}) }),
        ...(o.gpuInfo ? { gpuInfo: o.gpuInfo } : {}),
      });
    } catch (e) {
      throw new RenderError(`the render browser did not start (${browser.path ?? 'Remotion headless shell'}): ${(e as Error).message.split('\n')[0]}`);
    }
    const puppeteer = opened.puppeteer;
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
    // Guarded: a browser that is no program for every Remotion call — a page that fails ends that preview, never a
    // browser Remotion opens itself (network-guard.ts).
    const executable = guard ? GUARDED_NO_OTHER_BROWSER : browserExe;
    const plainly = async (run: () => Promise<unknown>): Promise<void> => {
      try {
        await run();
      } catch (e) {
        if (guard && !(e instanceof RenderError) && guardedPageFailure(e)) throw new RenderError(guardedPageFailed('preview'));
        throw e;
      }
    };
    const select = (spec: ComponentPreviewSpec) =>
      selectComposition({
        ...common,
        serveUrl: o.serveUrl,
        id: PREVIEW_COMPOSITION,
        inputProps: { preview: spec },
        puppeteerInstance: puppeteer,
        browserExecutable: executable,
        ...(remotion.port !== undefined ? { port: remotion.port } : {}),
      });
    return {
      async still(spec, out, scale) {
        const composition = await select(spec);
        await plainly(() => renderStill({
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
          browserExecutable: executable,
          ...remotion,
        }));
      },
      async gif(spec, out, g) {
        const composition = await select(spec);
        const { cancelSignal, cancel } = makeCancelSignal();
        const onAbort = () => cancel();
        o.signal?.addEventListener('abort', onAbort);
        try {
          await plainly(() => renderMedia({
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
            browserExecutable: executable,
            ...(opened.chromium.gl ? { chromiumOptions: opened.chromium } : {}),
            ...remotion,
          }));
        } finally {
          o.signal?.removeEventListener('abort', onAbort);
        }
      },
      warnings: () => [...opened.warnings, ...(guard?.warnings() ?? [])],
      close: () => puppeteer.close({ silent: true }).catch(() => undefined),
    };
  },
};

/**
 * A preview backend as the previews of a render driver: the bundle's serve URL stays here (a bundle of another driver
 * is refused), `cacheDir` and `gpuInfo` are the driver's own, and a closed session refuses to render.
 */
export function previewDriver(backend: PreviewBackend = REMOTION_PREVIEW_BACKEND, d: { cacheDir?: string; gpuInfo?: Parameters<PreviewBackend['open']>[0]['gpuInfo'] } = {}): DriverPreviews {
  const served = new WeakMap<DriverPreviewBundle, string>();
  return {
    async bundle(o) {
      const b = await backend.bundle({ root: o.root, components: o.components, ...(d.cacheDir ? { cacheDir: d.cacheDir } : {}), ...(o.signal ? { signal: o.signal } : {}) });
      const bundle: DriverPreviewBundle = Object.freeze({ hash: b.hash, cached: b.cached });
      served.set(bundle, b.serveUrl);
      return bundle;
    },
    async open(bundle, o) {
      const serveUrl = served.get(bundle);
      if (serveUrl === undefined) throw new RenderError('this preview bundle was made by another renderer');
      const session = await backend.open({
        serveUrl,
        assetPrefix: o.assets,
        ...(o.network ? { network: o.network } : {}),
        ...(o.signal ? { signal: o.signal } : {}),
        ...(o.onProcess ? { onBrowser: o.onProcess } : {}),
        ...(o.settings ? { settings: o.settings } : {}),
        workPolicy: o.workPolicy,
        ...(d.gpuInfo ? { gpuInfo: d.gpuInfo } : {}),
      });
      let closed = false;
      const ready = (): void => {
        if (closed) throw new RenderError('this preview session is closed');
      };
      return {
        still: async (spec, out, scale) => {
          ready();
          await session.still(spec, out, scale);
        },
        gif: async (spec, out, g) => {
          ready();
          await session.gif(spec, out, g);
        },
        warnings: () => session.warnings(),
        close: async () => {
          if (closed) return;
          closed = true;
          await session.close();
        },
      };
    },
  };
}

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
  renderer: DriverPreviewSession;
  /** A scratch folder of this session (removed at its end). */
  scratch: string;
  /** What the work runs under (core WorkPolicy): the ffmpeg that quantizes a poster. */
  workPolicy: WorkPolicy;
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
  // A renderer handed renders the previews, alone (with `backend` or `cacheDir` beside it the session is refused:
  // driver-guard.ts); standalone, the previews are this package's, on `backend` when a test hands one.
  const previews = handedDriver('preview', opts, 'previews')?.previews ?? previewDriver(opts.backend ?? REMOTION_PREVIEW_BACKEND, opts.cacheDir ? { cacheDir: opts.cacheDir } : {});
  if (jobs.length === 0) return { results, failed, bundle: null, warnings: [] };
  cancelled(opts.signal);
  const root = resolve(opts.root);
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
  let renderer: DriverPreviewSession | undefined;
  const scratch = join(tmpdir(), `retake-preview-${process.pid}-${randomBytes(4).toString('hex')}`);
  try {
    const targets = built.map((b) => b.job.target);
    const components =
      opts.bundle === 'registry'
        ? await registryPreviewComponents(targets, registry)
        : await previewBundleComponents(targets, [...new Set(built.flatMap((b) => Object.values(b.previews).flatMap((p) => p!.components)))], registry);
    let bundle: DriverPreviewBundle;
    try {
      bundle = await previews.bundle({ root, components, ...(opts.signal ? { signal: opts.signal } : {}) });
    } catch (e) {
      if (o.bundleFailure !== 'items' || errorKindOf(e) === 'cancelled' || opts.signal?.aborted || isDiskFullError(e)) throw e;
      for (const b of built) fail(b.job, e, 'its preview could not be bundled', 'bundle');
      return { results, failed, bundle: null, warnings: [] };
    }
    const open = () =>
      previews.open(bundle, {
        assets: server.prefix,
        ...(opts.network ? { network: opts.network } : {}),
        ...(opts.signal ? { signal: opts.signal } : {}),
        ...(opts.onBrowser ? { onProcess: opts.onBrowser } : {}),
        ...(opts.settings ? { settings: opts.settings } : {}),
        workPolicy: opts.workPolicy,
      });
    renderer = await open();
    await mkdir(scratch, { recursive: true });
    const warnings = new Set<string>();
    for (let i = 0; i < built.length; i++) {
      cancelled(opts.signal);
      const item = built[i];
      try {
        results.push({ job: item.job, value: await each({ renderer, scratch, workPolicy: opts.workPolicy }, item, i) });
      } catch (e) {
        if (errorKindOf(e) === 'cancelled' || opts.signal?.aborted) throw new RenderCancelledError();
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
    if (opts.signal?.aborted || errorKindOf(e) === 'cancelled') throw new RenderCancelledError();
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
async function writeReadmeOf(target: PreviewComponentTarget, meta: PreviewMeta, readmes: PreviewReadmeWriter | undefined): Promise<string> {
  const file = join(target.dir, 'README.md');
  if (!readmes || !pathInside(file, readmes.root)) return writePreviewReadme(target.dir, target.manifest, meta);
  const existing = existsSync(file) ? await readFile(file, 'utf8') : null;
  try {
    await readmes.write(file, mergePreviewReadme(existing ?? undefined, previewReadmeBlock(target.manifest, meta)), existing);
  } catch (e) {
    if (isDiskFullError(e)) throw e;
    throw new RenderError(`preview of ${target.id}: its ${PREVIEW_FILE} and ${PREVIEW_META_FILE} were written, its README.md was not — ${(e as Error).message}`);
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
