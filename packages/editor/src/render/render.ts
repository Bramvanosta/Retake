/**
 * Rendering (DESIGN-phase2 §2.2): an EditPlan → an MP4 (h264, yuv420p, faststart, an audio track always present: silent
 * without music) or a PNG still, with Remotion. The plan's assets are served by a local HTTP server for the duration of
 * the render, the compositions come from a cached bundle (./bundle.ts), and the browser is
 * $RETAKE_CHROMIUM_HEADLESS_SHELL or Playwright's headless shell (./browser.ts). How that browser draws, which encoder
 * writes the video and how many frames render at a time is the render policy's (./policy.ts, L5.15): on a Mac with a
 * GPU, ANGLE (Metal) + VideoToolbox at 3 frames at a time; elsewhere today's software raster + libx264 CRF 16.
 */
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { findWorkspaceRoot, loadProject, ffmpegBin } from '@retake/core/io';
import type { GpuInfo, LoadedProject, LoadedTemplate, RenderSettings, Timeline, WorkPolicy } from '@retake/core';
import { loadComponentRegistry } from '@retake/components';
import type { ComponentRegistry } from '@retake/components';
import type { EditOverrides, EditPlan, PlanVariant } from '../plan-types.js';
import { resolvePlanAssets } from '../summary.js';
import { startAssetServer } from './asset-server.js';
import { assertRenderBrowser, renderBrowser } from './browser.js';
import type { RenderBrowser } from './browser.js';
import { bundleComponentsFor, ensureBundle } from './bundle.js';
import type { RenderBundle } from './bundle.js';
import { GUARDED_NO_OTHER_BROWSER, armNetworkGuard, browserProcessInfo, guardedPageFailed, guardedPageFailure, pickFreePort } from './network-guard.js';
import type { BrowserProcessInfo, NetworkGuard } from './network-guard.js';
import { planRun } from './plan-run.js';
import {
  chooseEncode,
  ownEncodeFailure,
  defaultConcurrency,
  encodingRecord,
  gpuPathFailureOf,
  openRenderBrowser,
  remotionEncoding,
  renderGpuInfo,
  renderPolicy,
  rendererWords,
  withGl,
} from './policy.js';
import type { ChooseEncodeOptions, EncodeChoice, EncodeFfmpegChoice, RenderEncoder, RenderGl, RenderPolicy, VideotoolboxProbe } from './policy.js';
import { noteOwnEncodeFailed, rewritePreStitcher } from './encode-tools.js';
import type { PlanTrust } from './plan-run.js';
import { rendersDir, reserveVersion, versionLockFile } from './runs.js';
import { themeContentHash } from './theme-hash.js';
import { VIDEO_COMPOSITIONS, videoProps } from '../remotion/contract.js';
import { playsSound } from '../remotion/frames.js';
import { RenderCancelledError, RenderError } from './types.js';
import { probeMedia, run } from './probe.js';
import type { RenderRecord } from '../render-record.js';
import type { RenderProgress } from './types.js';
import { errorKindOf, formatRenderId } from '@retake/core';
import { handedDriver } from './driver-guard.js';
import { rendererLibrary } from './library.js';
import type { LibraryBrowser, RenderBrowserHandle } from './library.js';
import type { RenderDriver } from './driver-types.js';

export { probeMedia } from './probe.js';

/** What every render encodes (the encoder and its rate are the policy's: ./policy.ts `remotionEncoding`). */
export const RENDER_ENCODING = { codec: 'h264', pixel_format: 'yuv420p' } as const;
/** JPEG quality of the frames Remotion captures before encoding (high: captures are full of small text). */
export const FRAME_JPEG_QUALITY = 95;
/** Composition ids by variant (written once, in ../remotion/contract.ts). */
export const COMPOSITION_IDS = VIDEO_COMPOSITIONS;

/** The software path's default concurrency (./policy.ts; the GPU path's is GPU_CONCURRENCY). */
export { defaultConcurrency };

/**
 * Remotion's encoder pipe rejects with EPIPE, unhandled, when the encoder dies under it (a failed render; a hardware
 * encoder refusing its session): the render itself fails with that error, the process must not die of it. Installed
 * once per process by the first render or still (a `retake render`, an export, the Studio, the worker — whose own
 * handlers do the same); any other unhandled rejection is left as it was: thrown when no other handler decides.
 */
let pipeGuarded = false;
export function guardEncoderPipe(): void {
  if (pipeGuarded) return;
  pipeGuarded = true;
  process.on('unhandledRejection', (reason) => {
    if ((reason as NodeJS.ErrnoException | undefined)?.code === 'EPIPE') return;
    if (process.listenerCount('unhandledRejection') > 1) return;
    throw reason;
  });
}

/** Seams of the render path, for tests only (a GPU that is not there, a GPU path that fails). */
export interface RenderSeams {
  /** The render browser's GPU status (default: CDP SystemInfo.getInfo, ./policy.ts renderGpuInfo). */
  gpuInfo?: (browser: RenderBrowserHandle) => Promise<GpuInfo | undefined>;
  /** The VideoToolbox probe (default: the compositor's ffmpeg at the render's size). */
  videotoolbox?: VideotoolboxProbe;
  /** The encoder of the first attempt, past the choice (a hardware encoder failing for real: an oversize session). */
  encoder?: RenderEncoder;
  /** Called before each renderMedia attempt (1, then 2 for the fallback): a test throws to fail one. */
  beforeRender?: (attempt: number, path: { gl: RenderGl; encoder: RenderEncoder }) => void | Promise<void>;
  /** Fail attempt `attempt` with `message` once `frames` frames are rendered (a failure mid-render: progress made, a partial file). */
  failAfter?: { attempt: number; frames: number; message: string };
  /** This machine's ffmpeg for the frame encode (default: the work's, read from the binary; ./encode-tools.ts). */
  ownFfmpeg?: ChooseEncodeOptions['own'];
  /** The frame-encode probe of that ffmpeg (default: the command itself on three frames). */
  ownEncodes?: ChooseEncodeOptions['ownEncodes'];
}

/** What a render record says of its policy (types.ts RenderRecord.policy). */
export interface RenderPathRecord {
  gl: { asked: RenderPolicy['gl']['asked']; source: RenderPolicy['gl']['source']; resolved: RenderGl; used: RenderGl; renderer?: string };
  encoder: { asked: RenderPolicy['encoder']['asked']; source: RenderPolicy['encoder']['source']; used: RenderEncoder };
  concurrency_source: RenderPolicy['concurrencySource'];
  /** The GPU path failed and the video was rendered again, in software with libx264 (its first error line). */
  fallback?: { reason: string };
  /**
   * Which ffmpeg encoded the frames (L7.3): the setting, what was used, our ffmpeg's version when it was looked at,
   * why the library's encoded although the setting is not `library` (`note`: one of our own sentences — the rule of
   * `auto` on this path, why ours did not qualify, the second attempt) and what the first attempt failed with while
   * ours encoded (`failed`: the failure's own words; the video was rendered again with the library's).
   */
  ffmpeg?: { asked: RenderPolicy['ffmpeg']['asked']; source: RenderPolicy['ffmpeg']['source']; used: 'own' | 'library'; version?: string; note?: string; failed?: string };
}

export interface RenderPlanOptions {
  plan: EditPlan;
  /** Output .mp4 (written to a temporary name first, renamed on success). */
  out: string;
  /** Workspace root (bundle cache); default: the workspace of the cwd. */
  root?: string;
  /** Registry to find the plan's component implementations (default: the workspace's). */
  registry?: ComponentRegistry;
  /** Bundle cache folder (default <root>/.retake/cache). */
  cacheDir?: string;
  concurrency?: number;
  signal?: AbortSignal;
  onProgress?: (p: RenderProgress) => void;
  /** Only these output frames [first, last] (inclusive; previews, tests). */
  frameRange?: [number, number];
  /** `guard`: the render's Chromium loads only the plan's files (network-guard.ts; renders of the jobs worker). */
  network?: RenderNetwork;
  /** Called once the render browser runs, with its process (the jobs worker records it to kill it after a crash). */
  onBrowser?: (b: BrowserProcessInfo) => void;
  /** Render settings over the process's (./policy.ts: an explicit option wins over retake.yaml and the environment). */
  settings?: RenderSettings;
  /** What the work runs under (core WorkPolicy): which ffmpeg, ffprobe and render browser, its workspace's render settings. */
  workPolicy: WorkPolicy;
  /** Tests only. */
  seams?: RenderSeams;
}

/** `open`: the render's Chromium has the machine's network (a `retake` command); `guard`: network-guard.ts. */
export type RenderNetwork = 'open' | 'guard';

export interface RenderPlanResult {
  file: string;
  bundle: RenderBundle;
  browser: RenderBrowser;
  concurrency: number;
  bundle_ms: number;
  render_ms: number;
  size_bytes: number;
  warnings: string[];
  /** The policy asked, resolved and used (the record's `policy`). */
  path: RenderPathRecord;
  /** The record's encoding fields of the encoder used. */
  encoding: ReturnType<typeof encodingRecord>;
}

function cancelled(signal?: AbortSignal): boolean {
  return signal?.aborted === true;
}

interface Session {
  serveUrl: string;
  bundle: RenderBundle;
  browser: RenderBrowser;
  served: EditPlan;
  close: () => Promise<void>;
  puppeteer: LibraryBrowser;
  warnings: string[];
  /** Options every Remotion call of a guarded session takes: the bundle server's port and the download check. */
  remotion: { port?: number; onDownload?: (src: string) => undefined };
  guard?: NetworkGuard;
  /** How this browser draws (after the GPU check), and what it reported. */
  gl: RenderGl;
  gpu?: GpuInfo;
  /** `chromiumOptions` of its Remotion calls (a browser Remotion replaces after a crash draws the same way). */
  chromium: { gl?: 'angle' };
  /**
   * The `browserExecutable` of its Remotion calls: the render browser's, or — guarded — one that is no program
   * (network-guard.ts GUARDED_NO_OTHER_BROWSER: Remotion never opens a browser of its own for a guarded render).
   */
  executable: string | null;
  /** The policy this session renders with: the one asked, its GL as the browser draws (a reopen in software takes the software default concurrency unless set). */
  policy: RenderPolicy;
}

/**
 * Asset server + bundle + browser for one render or still; `close()` releases the server and the browser. The browser
 * draws as `policy` resolves it; with ANGLE its GPU is checked first (CDP SystemInfo): none under `auto` → closed and
 * reopened in software, `gpu` → kept, with a warning. Only the browser that will render is reported (`onBrowser`) and
 * guarded — after that check, so a reopened one is too (critique H3).
 */
async function openSession(opts: {
  plan: EditPlan;
  workPolicy: WorkPolicy;
  root: string;
  registry?: ComponentRegistry;
  cacheDir?: string;
  signal?: AbortSignal;
  onBundleProgress?: (p: number, cached: boolean) => void;
  network?: RenderNetwork;
  onBrowser?: (b: BrowserProcessInfo) => void;
  policy: RenderPolicy;
  seams?: RenderSeams;
}): Promise<Session> {
  const warnings: string[] = [];
  const registry = opts.registry ?? (await loadComponentRegistry({ root: opts.root }));
  const components = await bundleComponentsFor(opts.plan, registry);
  const bundle = await ensureBundle({
    root: opts.root,
    components,
    cacheDir: opts.cacheDir,
    signal: opts.signal,
    onProgress: (p) => opts.onBundleProgress?.(p, false),
  });
  opts.onBundleProgress?.(1, bundle.cached);
  // The browser first: without a headless shell (or with one the agent policy refuses) no server is started.
  const browser = renderBrowser();
  const executable = assertRenderBrowser(browser, opts.workPolicy);
  if (browser.note) warnings.push(browser.note);
  const server = await startAssetServer();
  const missing = Object.values(opts.plan.assets).filter((f) => !existsSync(f));
  if (missing.length > 0) {
    await server.close();
    throw new RenderError(`files of the plan are missing: ${missing.join(', ')}`);
  }
  const served = resolvePlanAssets(opts.plan, (_url, file) => server.urlFor(file));
  const { openBrowser } = await rendererLibrary();
  let opened: Awaited<ReturnType<typeof openRenderBrowser<Session['puppeteer']>>>;
  try {
    opened = await openRenderBrowser({
      policy: opts.policy,
      launch: (chromium) => openBrowser('chrome', { browserExecutable: executable, chromeMode: 'headless-shell', logLevel: 'error', ...(chromium.gl ? { chromiumOptions: chromium } : {}) }),
      ...(opts.seams?.gpuInfo ? { gpuInfo: opts.seams.gpuInfo } : {}),
    });
  } catch (e) {
    await server.close();
    throw new RenderError(`the render browser did not start (${browser.path ?? 'Remotion headless shell'}): ${(e as Error).message.split('\n')[0]}`);
  }
  const { puppeteer, gl, gpu } = opened;
  warnings.push(...opened.warnings);
  const close = async () => {
    await puppeteer.close({ silent: true }).catch(() => undefined);
    await server.close();
  };
  if (opts.onBrowser) {
    const info = await browserProcessInfo(puppeteer);
    if (info) opts.onBrowser(info);
  }
  let guard: NetworkGuard | undefined;
  let remotion: Session['remotion'] = {};
  if (opts.network === 'guard') {
    try {
      const port = await pickFreePort();
      guard = await armNetworkGuard(puppeteer, { assetPrefix: server.prefix, bundlePort: port });
      remotion = { port, onDownload: (src: string) => guard!.onDownload(src) };
    } catch (e) {
      await close();
      throw new RenderError(`the render cannot run with its network guard: ${(e as Error).message}`);
    }
  }
  return {
    serveUrl: bundle.serveUrl,
    bundle,
    browser,
    served,
    puppeteer,
    warnings,
    remotion,
    ...(guard ? { guard } : {}),
    close,
    gl,
    ...(gpu ? { gpu } : {}),
    chromium: opened.chromium,
    executable: guard ? GUARDED_NO_OTHER_BROWSER : executable,
    // Review A M1 / B M1: a reopen in software renders at the software default (what doctor says), not the GPU's 3.
    policy: gl === opts.policy.gl.resolved ? opts.policy : withGl(opts.policy, gl),
  };
}

const COMMON = { chromeMode: 'headless-shell', logLevel: 'error', timeoutInMilliseconds: 90_000 } as const;

/** The fallback's policy: today's software path (no `--use-gl`, libx264 CRF 16) at the same concurrency (critique M2). */
function softwarePolicy(p: RenderPolicy): RenderPolicy {
  return { ...withGl(p, 'software', { keepConcurrency: true }), encoder: { asked: 'libx264', source: p.encoder.source } };
}

/**
 * Render a plan to `out` (.mp4). The video is encoded under a temporary name next to `out` and renamed when complete:
 * a failure or a cancellation (AbortSignal → Remotion cancel signal) leaves nothing under `out`.
 *
 * The policy (./policy.ts) picks the GL, the encoder (before the render: VideoToolbox's size limit and probe) and the
 * concurrency. One fallback (L5.15): when the GPU path itself fails (`gpuPathFailure`: the GPU process, the GL context,
 * the hardware encoder or its pipe — never a cancel, a timeout, a full disk or an error of the plan), the video is
 * rendered once more from frame 0 in software with libx264, to a fresh temporary file, through a new session (its
 * browser reported and guarded again); progress never goes back (stage `retrying`, clamped), a cancel still cancels.
 */
export async function renderPlan(opts: RenderPlanOptions): Promise<RenderPlanResult> {
  const out = resolve(opts.out);
  if (extname(out).toLowerCase() !== '.mp4') throw new RenderError(`render output must be an .mp4 file: ${out}`);
  const root = opts.root ? resolve(opts.root) : findWorkspaceRoot();
  const asked = renderPolicy(opts.workPolicy, opts.settings);
  const policy: RenderPolicy =
    opts.concurrency !== undefined ? { ...asked, concurrency: Math.max(1, Math.round(opts.concurrency)), concurrencySource: 'option' } : asked;
  const range = opts.frameRange;
  if (range && !(range[0] >= 0 && range[1] >= range[0] && range[1] < opts.plan.durationInFrames)) {
    throw new RenderError(`frame range ${range[0]}–${range[1]} is outside the video (0–${opts.plan.durationInFrames - 1})`);
  }
  const total = range ? range[1] - range[0] + 1 : opts.plan.durationInFrames;
  const size = { width: opts.plan.width, height: opts.plan.height, fps: opts.plan.fps };
  guardEncoderPipe();
  // Progress never goes back: a fallback starts again from frame 0 under `retrying`, clamped to what was reached.
  const report = opts.onProgress ?? (() => undefined);
  let high = 0;
  let highFrames = 0;
  let retrying = false;
  const emit = (p: RenderProgress) => {
    const overall = Math.max(high, p.overall);
    high = overall;
    const next: RenderProgress = { ...p, overall };
    if (p.renderedFrames !== undefined) {
      highFrames = Math.max(highFrames, p.renderedFrames);
      next.renderedFrames = highFrames;
    }
    if (retrying && (p.stage === 'bundling' || p.stage === 'rendering')) next.stage = 'retrying';
    report(next);
  };
  if (cancelled(opts.signal)) throw new RenderCancelledError();
  emit({ stage: 'bundling', progress: 0, overall: 0 });
  await mkdir(dirname(out), { recursive: true });
  const warnings: string[] = [];
  let bundleMs = 0;
  let fallback: { reason: string } | undefined;
  /** What the last attempt tried (a failed render's record keeps it, review B L1). */
  let tried: RenderPathRecord | undefined;
  /** The policy attempt 1 rendered with (its concurrency is the fallback's). */
  let first: RenderPolicy | undefined;
  /** The ffmpeg the current attempt encodes with, and what the first attempt failed with while ours encoded. */
  let ff: EncodeFfmpegChoice | undefined;
  let ownFailed: string | undefined;
  /** The version of our ffmpeg while it encoded the first attempt (the record of a retry keeps it). */
  let ownVersion: string | undefined;
  const pathOf = (used: RenderGl, encoder: RenderEncoder, renderer?: string): RenderPathRecord => ({
    gl: { asked: policy.gl.asked, source: policy.gl.source, resolved: policy.gl.resolved, used, ...(renderer && used === 'angle' ? { renderer } : {}) },
    encoder: { asked: policy.encoder.asked, source: policy.encoder.source, used: encoder },
    concurrency_source: policy.concurrencySource,
    ...(fallback ? { fallback } : {}),
    ...(ff
      ? { ffmpeg: { asked: policy.ffmpeg.asked, source: policy.ffmpeg.source, used: ff.used, ...((ff.version ?? (ownFailed ? ownVersion : undefined)) ? { version: ff.version ?? ownVersion } : {}), ...(ff.note ? { note: ff.note } : {}), ...(ownFailed ? { failed: ownFailed } : {}) } }
      : {}),
  });
  const attempt = async (asked: RenderPolicy, n: 1 | 2): Promise<RenderPlanResult> => {
    const t0 = performance.now();
    const session = await openSession({
      plan: opts.plan,
      workPolicy: opts.workPolicy,
      root,
      registry: opts.registry,
      cacheDir: opts.cacheDir,
      signal: opts.signal,
      onBundleProgress: (q, cached) => emit({ stage: 'bundling', progress: q, overall: 0.1 * q, cached }),
      ...(opts.network ? { network: opts.network } : {}),
      ...(opts.onBrowser ? { onBrowser: opts.onBrowser } : {}),
      policy: asked,
      ...(opts.seams ? { seams: opts.seams } : {}),
    }).catch((e: unknown) => {
      if (cancelled(opts.signal)) throw new RenderCancelledError();
      throw e;
    });
    if (n === 1) bundleMs = Math.round(performance.now() - t0);
    const p = session.policy;
    if (n === 1) first = p;
    const partial = join(dirname(out), `.${basename(out, '.mp4')}.partial-${randomBytes(4).toString('hex')}.mp4`);
    const { renderMedia, selectComposition, makeCancelSignal } = await rendererLibrary();
    const { cancelSignal, cancel } = makeCancelSignal();
    const onAbort = () => cancel();
    let injected: Error | undefined;
    opts.signal?.addEventListener('abort', onAbort);
    let encoder: RenderEncoder = 'libx264';
    const tr = performance.now();
    try {
      if (cancelled(opts.signal)) throw new RenderCancelledError();
      // Nothing of the attempt before is said of this one until its own choice is made.
      ff = undefined;
      tried = pathOf(session.gl, encoder, rendererWords(session.gpu));
      const choice: EncodeChoice =
        n === 1 && opts.seams?.encoder
          ? { encoder: opts.seams.encoder, ffmpeg: { used: 'library' } }
          : await chooseEncode(p, session.gl, size, {
              workPolicy: opts.workPolicy,
              // The second attempt follows the setting's rule for the path it runs on (software: `auto` takes the
              // library's, `own` ours) — unless the first failed while ours encoded: then the library's, whatever was asked.
              ...(n === 2 && ownFailed !== undefined ? { library: true } : {}),
              ...(opts.seams?.videotoolbox ? { videotoolbox: opts.seams.videotoolbox } : {}),
              ...(opts.seams?.ownFfmpeg ? { own: opts.seams.ownFfmpeg } : {}),
              ...(opts.seams?.ownEncodes ? { ownEncodes: opts.seams.ownEncodes } : {}),
              ...(opts.signal ? { signal: opts.signal } : {}),
            });
      encoder = choice.encoder;
      ff = choice.ffmpeg;
      if (ff.used === 'own') ownVersion = ff.version;
      tried = pathOf(session.gl, encoder, rendererWords(session.gpu));
      if (choice.note) session.warnings.push(choice.note);
      // Asked by name and not used: said. Under `auto` the record's note is enough (a machine without one is ordinary),
      // unless a program or the system said something about it: those words go here, never into the record.
      if (ff.used === 'library' && ff.note && !ff.byRule) {
        const said = ff.detail ? ` — ${ff.detail}` : '';
        if (p.ffmpeg.asked === 'own') session.warnings.push(`this machine's ffmpeg was asked for the encode (render.ffmpeg: own) and the rendering library's was used: ${ff.note}${said}`);
        else if (said) session.warnings.push(`this machine's ffmpeg does not encode this render (${ff.note})${said}`);
      }
      const own = ff.used === 'own' && ff.binariesDirectory ? ff.binariesDirectory : undefined;
      const inputProps = videoProps(session.served);
      const composition = await selectComposition({
        ...COMMON,
        serveUrl: session.serveUrl,
        id: COMPOSITION_IDS[opts.plan.variant],
        inputProps,
        puppeteerInstance: session.puppeteer,
        browserExecutable: session.executable,
        ...(session.remotion.port !== undefined ? { port: session.remotion.port } : {}),
      });
      if (composition.durationInFrames !== opts.plan.durationInFrames) {
        throw new RenderError(`composition has ${composition.durationInFrames} frames, the plan ${opts.plan.durationInFrames}`);
      }
      emit({ stage: 'rendering', progress: 0, overall: 0.1, totalFrames: total, renderedFrames: 0, encodedFrames: 0 });
      await opts.seams?.beforeRender?.(n, { gl: session.gl, encoder });
      if (cancelled(opts.signal)) throw new RenderCancelledError();
      await renderMedia({
        ...COMMON,
        composition,
        serveUrl: session.serveUrl,
        codec: RENDER_ENCODING.codec,
        ...remotionEncoding(encoder, size),
        pixelFormat: RENDER_ENCODING.pixel_format,
        // Limited-range BT.709 (plain yuv420p, tagged): what players and platforms expect from an h264 MP4.
        colorSpace: 'bt709',
        imageFormat: 'jpeg',
        jpegQuality: FRAME_JPEG_QUALITY,
        enforceAudioTrack: true,
        outputLocation: partial,
        overwrite: true,
        inputProps,
        concurrency: p.concurrency,
        ...(range ? { frameRange: range } : {}),
        cancelSignal,
        puppeteerInstance: session.puppeteer,
        // Guarded: no program — a page that fails ends the render, never a browser Remotion opens itself.
        browserExecutable: session.executable,
        ...(session.chromium.gl ? { chromiumOptions: session.chromium } : {}),
        ...session.remotion,
        // Our ffmpeg encodes the frames (./encode-tools.ts): the folder that dispatches to it, its arguments rewritten,
        // and frames over the pipe it reads (no shared-memory capture, which only the library's ffmpeg knows).
        ...(own ? { binariesDirectory: own, ffmpegOverride: rewritePreStitcher, disableSharedMemoryCapture: true } : {}),
        onProgress: (q) => {
          const f = opts.seams?.failAfter;
          if (f && f.attempt === n && !injected && q.renderedFrames >= f.frames) {
            injected = new Error(f.message);
            cancel();
          }
          if (q.renderedFrames < total) {
            emit({
              stage: 'rendering',
              progress: q.renderedFrames / total,
              overall: 0.1 + 0.85 * (q.renderedFrames / total),
              totalFrames: total,
              renderedFrames: q.renderedFrames,
              encodedFrames: q.encodedFrames,
              eta_s: q.renderEstimatedTime > 0 ? Math.round(q.renderEstimatedTime / 1000) : undefined,
            });
          } else {
            emit({ stage: 'encoding', progress: q.encodedFrames / total, overall: 0.95 + 0.05 * (q.encodedFrames / total), totalFrames: total, renderedFrames: total, encodedFrames: q.encodedFrames });
          }
        },
      });
      if (cancelled(opts.signal)) throw new RenderCancelledError();
      // What drew it, read again at the end (critique L2): Chromium leaves the GPU by itself when its GPU process keeps failing.
      let used = session.gl;
      let gpu = session.gpu;
      if (used === 'angle') {
        const end = await (opts.seams?.gpuInfo ?? renderGpuInfo)(session.puppeteer);
        if (end) gpu = end;
        if (end && !end.accelerated) {
          used = 'software';
          session.warnings.push(`the render browser left the GPU during the render (${rendererWords(end) ?? 'no renderer reported'}): part of it was drawn in software`);
        }
      }
      await ensureAudioTrack(partial, opts.workPolicy);
      await rename(partial, out);
      const sizeBytes = (await stat(out)).size;
      const renderer = rendererWords(gpu);
      warnings.push(...session.warnings, ...(session.guard?.warnings() ?? []));
      return {
        file: out,
        bundle: session.bundle,
        browser: session.browser,
        concurrency: p.concurrency,
        bundle_ms: bundleMs,
        render_ms: Math.round(performance.now() - tr),
        size_bytes: sizeBytes,
        warnings: [...new Set(warnings)],
        path: pathOf(used, encoder, renderer),
        encoding: encodingRecord(encoder, size),
      };
    } catch (caught) {
      const e = injected ?? caught;
      // Nothing half-written is kept, whatever comes next (a fallback writes a fresh temporary file).
      await rm(partial, { force: true }).catch(() => undefined);
      warnings.push(...session.warnings, ...(session.guard?.warnings() ?? []));
      if (cancelled(opts.signal) || e instanceof RenderCancelledError) throw new RenderCancelledError();
      // A guarded render whose page failed: Remotion was refused a browser of its own (session.executable). On the GPU
      // path that is our one software retry (guarded, a new session); otherwise the render fails, plainly.
      if (session.guard && !(e instanceof RenderError) && guardedPageFailure(e)) {
        if (n === 1 && session.gl === 'angle') throw new GpuPathFailed(guardedPageFailed());
        throw new RenderError(`render failed: ${guardedPageFailed()}`);
      }
      const gpu = n === 1 ? gpuPathFailureOf(e, { gl: session.gl, encoder }) : null;
      // The hardware encoder's signs (its lines, its pipe closing) are also how the ffmpeg that runs it fails: when
      // ours was encoding, the record says both, and the retry takes the library's.
      if (gpu) throw new GpuPathFailed(gpu.reason, { gpu: true, own: gpu.sign === 'encoder' && ff?.used === 'own' ? ff.path ?? '' : undefined });
      // Our ffmpeg failed at the encode: the one retry, with the library's (in software, the path that must work).
      const ownReason = n === 1 && ff?.used === 'own' ? ownEncodeFailure(e, { ...(ff.version ? { version: ff.version } : {}), ...(ff.binariesDirectory ? { folder: ff.binariesDirectory } : {}) }) : null;
      if (ownReason) throw new GpuPathFailed(ownReason, { gpu: false, own: ff?.path ?? '' });
      if (e instanceof RenderError) throw e;
      throw new RenderError(`render failed: ${(e as Error).message}`);
    } finally {
      opts.signal?.removeEventListener('abort', onAbort);
      await session.close();
      // Remotion may leave its in-progress fast-start file behind when cancelled mid-mux.
      await removeLeftovers(dirname(out), basename(partial));
    }
  };
  /** A failure carries what was tried and the warnings so far (the failed record keeps them, review B L1). */
  const failed = (e: unknown): never => {
    if (e instanceof RenderError && !(e instanceof RenderCancelledError)) {
      e.path = tried;
      e.renderWarnings = [...new Set(warnings)];
    }
    throw e;
  };
  try {
    return await attempt(policy, 1);
  } catch (e) {
    if (!(e instanceof GpuPathFailed)) return failed(e);
    if (cancelled(opts.signal)) throw new RenderCancelledError();
    if (e.own !== undefined) {
      // Ours was encoding: not taken again by this process (a render after this one keeps its path, with the library's).
      ownFailed = e.reason;
      if (e.own) noteOwnEncodeFailed(e.own);
    }
    if (e.gpu) {
      fallback = { reason: e.reason };
      warnings.push(`the render failed on the GPU path (${e.reason})${e.own !== undefined ? " while this machine's ffmpeg was encoding" : ''} and was rendered again in software${e.own !== undefined ? " with the rendering library's" : ''}`);
    } else warnings.push(`the encode failed with this machine's ffmpeg (${e.reason}) and the video was rendered again in software with the rendering library's`);
    retrying = true;
    emit({ stage: 'retrying', progress: 0, overall: high, totalFrames: total, renderedFrames: highFrames });
    try {
      return await attempt(softwarePolicy(first ?? policy), 2);
    } catch (e2) {
      // The software attempt failed too: said with the GPU path's reason (the error is the software attempt's).
      if (e2 instanceof RenderError && !(e2 instanceof RenderCancelledError)) e2.message = `render failed in software, after ${e.gpu ? 'the GPU path failed' : "this machine's ffmpeg failed at the encode"} (${e.reason}): ${e2.message.replace(/^render failed: /, '')}`;
      return failed(e2);
    }
  }
}

/**
 * What renderPlan's one fallback is taken for (internal): a failure of the GPU path (`gpu`), of our ffmpeg at the
 * encode, or one that is either (`gpu` with `own`: the hardware encoder's signs while ours ran it). `own` is our
 * ffmpeg's path when it was encoding ('' when a test gave none).
 */
class GpuPathFailed extends Error {
  readonly gpu: boolean;
  readonly own: string | undefined;
  constructor(
    readonly reason: string,
    o: { gpu: boolean; own?: string | undefined } = { gpu: true },
  ) {
    super(reason);
    this.gpu = o.gpu;
    this.own = o.own;
  }
}

async function removeLeftovers(dir: string, partialName: string): Promise<void> {
  const { readdir } = await import('node:fs/promises');
  try {
    for (const f of await readdir(dir)) if (f.startsWith(partialName)) await rm(join(dir, f), { force: true });
  } catch {
    // nothing to clean
  }
}

/**
 * Remotion's `enforceAudioTrack` adds a silent track to a video without audio; this checks it (when ffprobe is
 * available) and adds one with ffmpeg if a file ever comes out without (players and platforms expect one).
 */
async function ensureAudioTrack(file: string, work: WorkPolicy): Promise<void> {
  const p = await probeMedia(file, work);
  if (!p || p.audio_streams > 0) return;
  const tmp = `${file}.audio-${randomBytes(3).toString('hex')}.mp4`;
  const r = await run(ffmpegBin(work), ['-v', 'error', '-y', '-i', file, '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000', '-shortest', '-c:v', 'copy', '-c:a', 'aac', '-movflags', '+faststart', tmp]);
  if (r.code !== 0) {
    await rm(tmp, { force: true });
    throw new RenderError(`the render has no audio track and ffmpeg could not add a silent one: ${r.stderr.split('\n')[0]}`);
  }
  await rename(tmp, file);
}

// ── renderVideo ───────────────────────────────────────────────────────────────

export interface RenderVideoOptions {
  /** A loaded project, or a project slug / directory (resolved in `root`). */
  project: LoadedProject | string;
  /** Run id, run directory, or "latest" (of `scenario` when given). */
  run: string;
  /** Scenario name: required to match the run's; picks the run with "latest". */
  scenario?: string;
  /** Theme to use instead of the one the run was captured with (name, ./path or a loaded template). */
  template?: string | LoadedTemplate;
  overrides?: EditOverrides;
  /** Explicit output .mp4 (default renders/<scenario>-v<N>[-vertical|-square].mp4 with the next free N). */
  out?: string;
  onProgress?: (p: RenderProgress) => void;
  signal?: AbortSignal;
  concurrency?: number;
  /** Workspace root (default: the project's). */
  root?: string;
  registry?: ComponentRegistry;
  /** Bundle cache folder (default <root>/.retake/cache). */
  cacheDir?: string;
  /** `mcp`: the plan passes planRun's trust gates first (work submitted through the MCP server). Default `author`. */
  trust?: PlanTrust;
  /** The render's network (default `open`; renders of the jobs worker: `guard`). */
  network?: RenderNetwork;
  /** Called once the render browser runs, with its process. */
  onBrowser?: (b: BrowserProcessInfo) => void;
  /**
   * A version reserved before (a render job: `.<scenario>-v<N>.lock` taken at submit): the render writes
   * `<scenario>-v<N><suffix>` and removes the lock at the end, whatever happens. The plan must still be of that
   * scenario and variant (the id's suffix), else the render is refused.
   */
  reserved?: { scenario: string; version: number; variant: PlanVariant };
  /** Where the edit comes from (L5.5, planRun `edit`): default `auto`. */
  edit?: 'auto' | 'run';
  /**
   * The sha256 of the scenario file the edit must come from (null: the run as captured), as planned before (a render
   * job at submit, an export of a master): a plan of another edit is refused. Undefined: no check.
   */
  editSha256?: string | null;
  /** The scenario text to plan the edit from instead of today's file (a render job's snapshot, L4.5: planRun `editText`). */
  editText?: string;
  /** Render settings over the process's (renderPlan `settings`). */
  settings?: RenderSettings;
  /** What the work runs under (core WorkPolicy): which ffmpeg, ffprobe and render browser, its workspace's render settings. */
  workPolicy: WorkPolicy;
  /** Tests only (renderPlan `seams`). */
  seams?: RenderSeams;
  /** What renders the plan (no such key: this package's driver — Remotion, with `cacheDir` and `seams`; with one, those two are refused: driver-guard.ts). */
  renderer?: Pick<RenderDriver, 'video'>;
}

/**
 * renderPlan's failure as a driver's: what it tried leaves `path` (this package's name, RenderError.path) for
 * `renderPath` (the driver's and the port's) — the one place the two names meet. Anything else passes as it is: a
 * system error's `path` is a file, a string, and stays one.
 */
function driverFailure(e: unknown): unknown {
  // The error is renamed in place, not copied: it is renderPlan's own, thrown to this one catch (nobody else holds
  // it), and the same object keeps its class, stack, record and warnings.
  if (e instanceof RenderError && e.path && typeof e.path === 'object') {
    (e as RenderError & { renderPath?: RenderRecord['policy'] }).renderPath = e.path;
    delete e.path;
  }
  return e;
}

/**
 * The video and stills of this package's render driver (./driver.ts adds the previews): renderPlan and the probe of
 * the file it wrote, renderStills. `cacheDir` and `seams` are the driver's own, no request names them.
 */
export function planDriver(o: { cacheDir?: string; seams?: RenderSeams } = {}): Pick<RenderDriver, 'video' | 'stills'> {
  return {
    async video(req) {
      const res = await renderPlan({
        workPolicy: req.workPolicy,
        plan: req.plan,
        out: req.out,
        root: req.root,
        registry: req.registry,
        cacheDir: o.cacheDir,
        concurrency: req.concurrency,
        signal: req.signal,
        onProgress: req.onProgress,
        ...(req.frameRange ? { frameRange: req.frameRange } : {}),
        ...(req.network ? { network: req.network } : {}),
        ...(req.onProcess ? { onBrowser: req.onProcess } : {}),
        ...(req.settings ? { settings: req.settings } : {}),
        ...(o.seams ? { seams: o.seams } : {}),
      }).catch((e: unknown) => {
        throw driverFailure(e);
      });
      const probe = await probeMedia(res.file, req.workPolicy);
      return {
        file: res.file,
        size_bytes: res.size_bytes,
        concurrency: res.concurrency,
        bundle: { hash: res.bundle.hash, cached: res.bundle.cached, ms: res.bundle.ms },
        browser: { path: res.browser.path, source: res.browser.source },
        bundle_ms: res.bundle_ms,
        render_ms: res.render_ms,
        warnings: res.warnings,
        renderPath: res.path,
        encoding: res.encoding,
        ...(probe ? { probe } : {}),
      };
    },
    stills(req) {
      return renderStills({
        workPolicy: req.workPolicy,
        plan: req.plan,
        frames: req.frames,
        root: req.root,
        registry: req.registry,
        cacheDir: o.cacheDir,
        ...(req.network ? { network: req.network } : {}),
        ...(req.onProcess ? { onBrowser: req.onProcess } : {}),
        ...(req.onWarnings ? { onWarnings: req.onWarnings } : {}),
        ...(req.settings ? { settings: req.settings } : {}),
        ...(o.seams?.gpuInfo ? { seams: { gpuInfo: o.seams.gpuInfo } } : {}),
      });
    },
  };
}

/**
 * Plan and render a run: renders/<scenario>-v<N>.mp4 (+ "-vertical" / "-square" for those variants) and the RenderRecord
 * renders/<scenario>-v<N>.json (plan, overrides, theme, run, duration, frames, size, status). N is the next free
 * version. Nothing is written under the final names when the render fails or is cancelled.
 */
/** The caption texts of each scene of a timeline (its own and its steps'): what a review expects a clip to show. */
function sceneCaptions(timeline: Timeline): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const s of timeline.scenes) if (s.kind === 'scene' && s.caption?.text) (out[s.id] ??= []).push(s.caption.text);
  for (const ev of timeline.events) if (ev.step >= 0 && ev.caption?.text) (out[ev.scene] ??= []).push(ev.caption.text);
  return out;
}

export async function renderVideo(opts: RenderVideoOptions): Promise<RenderRecord> {
  const t0 = performance.now();
  const createdAt = new Date().toISOString();
  const emit = opts.onProgress ?? (() => undefined);
  emit({ stage: 'planning', progress: 0, overall: 0 });
  const project = typeof opts.project === 'string' ? await loadProject(opts.project, opts.root) : opts.project;
  const dir = rendersDir(project);
  // A version reserved by someone else (a render job: its lock was taken at submit) is released here, whatever happens.
  // A version no reservation hands out (core renderLockName) has no lock: nothing is planned or rendered under it.
  let reservedLock: string | undefined;
  if (opts.reserved) {
    try {
      reservedLock = versionLockFile(dir, opts.reserved.scenario, opts.reserved.version);
    } catch (e) {
      throw new RenderError(`the reserved render version of ${opts.reserved.scenario} cannot be used: ${(e as Error).message}`);
    }
  }
  const reservedRelease = () => (reservedLock ? rm(reservedLock, { force: true }) : Promise.resolve());
  let planned: Awaited<ReturnType<typeof planRun>>;
  let handed: Pick<RenderDriver, 'video'> | undefined;
  try {
    // Before any work: a renderer named but not handed, or handed beside this driver's own options, is refused.
    handed = handedDriver('render', opts, 'video');
    planned = await planRun({
      workPolicy: opts.workPolicy,
      project,
      run: opts.run,
      ...(opts.scenario !== undefined ? { scenario: opts.scenario } : {}),
      ...(opts.template !== undefined ? { template: opts.template } : {}),
      ...(opts.overrides ? { overrides: opts.overrides } : {}),
      ...(opts.root !== undefined ? { root: opts.root } : {}),
      ...(opts.registry ? { registry: opts.registry } : {}),
      ...(opts.trust ? { trust: opts.trust } : {}),
      ...(opts.edit ? { edit: opts.edit } : {}),
      ...(opts.editText !== undefined ? { editText: opts.editText } : {}),
    });
    if (opts.editSha256 !== undefined && (planned.edit.sha256 ?? null) !== opts.editSha256) {
      throw new RenderError(
        `the scenario ${planned.timeline.scenario} changed since this render was planned (its edit ${planned.edit.from === 'scenario' ? 'is now re-planned from another version of the file' : 'now comes from the run as captured'}): plan or submit the render again`,
      );
    }
    if (opts.reserved && (planned.timeline.scenario !== opts.reserved.scenario || planned.plan.variant !== opts.reserved.variant)) {
      throw new RenderError(
        `the plan changed since the render was submitted (now ${planned.timeline.scenario}, ${planned.plan.variant}; reserved ${opts.reserved.scenario}, ${opts.reserved.variant}): submit the render again`,
      );
    }
  } catch (e) {
    await reservedRelease();
    throw e;
  }
  const { root, run, timeline, template, registry, overrides, plan, edit } = planned;
  const planMs = Math.round(performance.now() - t0);
  emit({ stage: 'planning', progress: 1, overall: 0 });

  const scenario = timeline.scenario;
  let file: string;
  let version: number | undefined;
  let release = async () => undefined as void;
  if (opts.reserved) {
    version = opts.reserved.version;
    release = reservedRelease;
    file = join(dir, `${formatRenderId(scenario, version, plan.variant)}.mp4`);
  } else if (opts.out) {
    file = resolve(opts.out);
    if (extname(file).toLowerCase() !== '.mp4') throw new RenderError(`--out must name an .mp4 file: ${file}`);
  } else {
    await mkdir(dir, { recursive: true });
    const r = await reserveVersion(dir, scenario);
    version = r.version;
    release = r.release;
    file = join(dir, `${formatRenderId(scenario, version, plan.variant)}.mp4`);
  }
  const recordFile = file.replace(/\.mp4$/i, '.json');
  const id = basename(file, extname(file));
  const templateSha256 = themeContentHash(template.dir);
  let plannedConcurrency = opts.concurrency ?? defaultConcurrency();
  try {
    if (opts.concurrency === undefined) plannedConcurrency = renderPolicy(opts.workPolicy, opts.settings).concurrency;
  } catch {
    /* renderPlan says why */
  }
  const base = (): RenderRecord => ({
    version: 1,
    id,
    project: project.slug,
    scenario,
    run_id: timeline.run_id,
    run_dir: run.dir,
    template: template.name,
    template_sha256: templateSha256,
    overrides,
    edit: { from: edit.from, ...(edit.sha256 ? { sha256: edit.sha256 } : {}), ...(edit.changes?.length ? { changes: edit.changes } : {}), ...(edit.from === 'scenario' ? { captions: sceneCaptions(timeline) } : {}) },
    variant: plan.variant,
    status: 'succeeded',
    file,
    record: recordFile,
    ...(version !== undefined ? { render_version: version } : {}),
    created_at: createdAt,
    finished_at: new Date().toISOString(),
    duration_s: Math.round((plan.durationInFrames / plan.fps) * 1000) / 1000,
    frames: plan.durationInFrames,
    fps: plan.fps,
    width: plan.width,
    height: plan.height,
    size_bytes: 0,
    encoding: { ...RENDER_ENCODING, faststart: true, audio: audioOf(plan) },
    concurrency: plannedConcurrency,
    bundle: { hash: '', cached: false, ms: 0 },
    browser: { path: null, source: 'none' },
    timings: { plan_ms: planMs, bundle_ms: 0, render_ms: 0, total_ms: 0 },
    warnings: [...plan.warnings],
    plan,
  });
  try {
    const renderer = handed ?? planDriver({ ...(opts.cacheDir ? { cacheDir: opts.cacheDir } : {}), ...(opts.seams ? { seams: opts.seams } : {}) });
    const res = await renderer.video({
      workPolicy: opts.workPolicy,
      plan,
      out: file,
      root,
      registry,
      concurrency: opts.concurrency,
      signal: opts.signal,
      onProgress: emit,
      ...(opts.network ? { network: opts.network } : {}),
      ...(opts.onBrowser ? { onProcess: opts.onBrowser } : {}),
      ...(opts.settings ? { settings: opts.settings } : {}),
    });
    const record = base();
    record.size_bytes = res.size_bytes;
    record.concurrency = res.concurrency;
    record.encoding = { ...record.encoding, ...res.encoding };
    record.policy = res.renderPath;
    record.bundle = { hash: res.bundle.hash, cached: res.bundle.cached, ms: res.bundle.ms };
    record.browser = { path: res.browser.path, source: res.browser.source };
    record.warnings.push(...res.warnings);
    // The driver's probe of the file it wrote (ffprobe for this package's; a driver that has none says nothing).
    const probe = res.probe;
    if (probe) {
      record.probe = probe;
      const expected = plan.durationInFrames / plan.fps;
      if (Math.abs(probe.duration_s - expected) > 1.5 / plan.fps) record.warnings.push(`the file lasts ${probe.duration_s.toFixed(3)} s, the plan ${expected.toFixed(3)} s`);
    }
    record.finished_at = new Date().toISOString();
    record.timings = { plan_ms: planMs, bundle_ms: res.bundle_ms, render_ms: res.render_ms, total_ms: Math.round(performance.now() - t0) };
    await writeFile(recordFile, `${JSON.stringify(record, null, 2)}\n`);
    emit({ stage: 'done', progress: 1, overall: 1, totalFrames: plan.durationInFrames });
    return record;
  } catch (e) {
    // The driver's failure, read by what it says (its kind, its fields), never by its class: another driver's counts too.
    const cancelled = errorKindOf(e) === 'cancelled';
    const said = (e ?? {}) as { renderPath?: RenderRecord['policy']; renderWarnings?: unknown };
    const record = base();
    record.status = cancelled ? 'cancelled' : 'failed';
    record.error = (e as Error).message;
    // What was tried (the GPU path, its fallback and why) and the warnings so far (review B L1).
    if (said.renderPath && typeof said.renderPath === 'object') record.policy = said.renderPath;
    if (Array.isArray(said.renderWarnings)) record.warnings.push(...said.renderWarnings.filter((w): w is string => typeof w === 'string'));
    record.finished_at = new Date().toISOString();
    record.timings.total_ms = Math.round(performance.now() - t0);
    if (cancelled) throw new RenderCancelledError(record);
    throw new RenderError((e as Error).message, record);
  } finally {
    await release();
  }
}

// ── renderStill ───────────────────────────────────────────────────────────────

export interface RenderStillOptions {
  plan: EditPlan;
  /** Output frame (0-based). */
  frame: number;
  /** Output .png. */
  out: string;
  root?: string;
  registry?: ComponentRegistry;
  cacheDir?: string;
  settings?: RenderSettings;
  /** What the work runs under (core WorkPolicy): which ffmpeg, ffprobe and render browser, its workspace's render settings. */
  workPolicy: WorkPolicy;
  /** What renders the frame (no such key: this package's driver — Remotion, with `cacheDir`; with one, `cacheDir` is refused: driver-guard.ts). */
  renderer?: Pick<RenderDriver, 'stills'>;
}

/** Render one output frame of a plan to a PNG; returns the file. */
export async function renderStill(opts: RenderStillOptions): Promise<string> {
  const renderer = handedDriver('still', opts, 'stills') ?? planDriver(opts.cacheDir ? { cacheDir: opts.cacheDir } : {});
  // The request names what a still is made of, field by field. Before the driver, `{ ...opts }` went to renderStills:
  // every field of RenderStillOptions is still passed (`cacheDir` makes the driver above); what the spread could also
  // carry from an untyped caller — renderStills' `network`, `onBrowser`, `onWarnings`, `seams` — no caller ever named.
  const [file] = await renderer.stills({
    workPolicy: opts.workPolicy,
    plan: opts.plan,
    frames: [{ frame: opts.frame, out: opts.out }],
    root: opts.root,
    registry: opts.registry,
    ...(opts.settings ? { settings: opts.settings } : {}),
  });
  return file;
}

export interface RenderStillsOptions {
  plan: EditPlan;
  /** Output frames (0-based) and the .png each one goes to. */
  frames: Array<{ frame: number; out: string }>;
  root?: string;
  registry?: ComponentRegistry;
  cacheDir?: string;
  /** The stills' network (default `open`; previews of the jobs worker: `guard`). */
  network?: RenderNetwork;
  onBrowser?: (b: BrowserProcessInfo) => void;
  /** Receives the session's warnings (a guard's blocked origins, no GPU found) once the stills are done. */
  onWarnings?: (warnings: string[]) => void;
  /** Render settings over the process's (./policy.ts). Stills have no mid-render fallback: a failure is said as it is. */
  settings?: RenderSettings;
  /** What the work runs under (core WorkPolicy): which ffmpeg, ffprobe and render browser, its workspace's render settings. */
  workPolicy: WorkPolicy;

  /** Tests only. */
  seams?: Pick<RenderSeams, 'gpuInfo'>;
}

/**
 * Render several output frames of a plan to PNGs in ONE session (bundle, asset server and browser are opened once:
 * ≈ 0.3–0.6 s per extra frame instead of ≈ 1–2 s per `renderStill`). Returns the files in the order given.
 */
export async function renderStills(opts: RenderStillsOptions): Promise<string[]> {
  for (const f of opts.frames) {
    const frame = Math.round(f.frame);
    if (!(frame >= 0 && frame < opts.plan.durationInFrames)) {
      throw new RenderError(`frame ${f.frame} is outside the video (0–${opts.plan.durationInFrames - 1})`);
    }
  }
  const root = opts.root ? resolve(opts.root) : findWorkspaceRoot();
  const policy = renderPolicy(opts.workPolicy, opts.settings);
  guardEncoderPipe();
  const session = await openSession({
    plan: opts.plan,
    workPolicy: opts.workPolicy,
    root,
    registry: opts.registry,
    cacheDir: opts.cacheDir,
    ...(opts.network ? { network: opts.network } : {}),
    ...(opts.onBrowser ? { onBrowser: opts.onBrowser } : {}),
    policy,
    ...(opts.seams ? { seams: opts.seams } : {}),
  });
  try {
    const { renderStill: still, selectComposition } = await rendererLibrary();
    const inputProps = videoProps(session.served);
    const composition = await selectComposition({
      ...COMMON,
      serveUrl: session.serveUrl,
      id: COMPOSITION_IDS[opts.plan.variant],
      inputProps,
      puppeteerInstance: session.puppeteer,
      browserExecutable: session.executable,
      ...(session.remotion.port !== undefined ? { port: session.remotion.port } : {}),
    });
    const files: string[] = [];
    for (const f of opts.frames) {
      const out = resolve(f.out);
      await mkdir(dirname(out), { recursive: true });
      await still({
        ...COMMON,
        composition,
        serveUrl: session.serveUrl,
        frame: Math.round(f.frame),
        output: out,
        imageFormat: 'png',
        overwrite: true,
        inputProps,
        puppeteerInstance: session.puppeteer,
        browserExecutable: session.executable,
        ...session.remotion,
      });
      files.push(out);
    }
    opts.onWarnings?.([...session.warnings, ...(session.guard?.warnings() ?? [])]);
    return files;
  } catch (e) {
    if (e instanceof RenderError) throw e;
    if (session.guard && guardedPageFailure(e)) throw new RenderError(`still failed: ${guardedPageFailed()}`);
    throw new RenderError(`still failed: ${(e as Error).message}`);
  } finally {
    await session.close();
  }
}

/** What the audio track of a render carries: the music bed and / or the own sound of the plan's files (L2.12). */
export function audioOf(plan: Pick<EditPlan, 'music' | 'segments'>): RenderRecord['encoding']['audio'] {
  const files = plan.segments.some((s) => playsSound(s.component) || (s.kind === 'clip' && s.overlays.some((o) => playsSound(o.component))));
  return plan.music ? (files ? 'music+files' : 'music') : files ? 'files' : 'silent';
}
