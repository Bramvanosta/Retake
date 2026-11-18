/**
 * Rendering (DESIGN-phase2 §2.2): an EditPlan → an MP4 (h264, yuv420p, faststart, an audio track always present: silent
 * without music) or a PNG still, with Remotion. The plan's assets are served by a local HTTP server for the duration of
 * the render, the compositions come from a cached bundle (./bundle.ts), and the browser is
 * $RETAKE_CHROMIUM_HEADLESS_SHELL or Playwright's headless shell (./browser.ts). How that browser draws, which encoder
 * writes the video and how many frames render at a time is the render policy's (./policy.ts): on a Mac with a
 * GPU, ANGLE (Metal) + VideoToolbox at 3 frames at a time; elsewhere today's software raster + libx264 CRF 16.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { RenderSettings } from '@retake/core/model';
import type { WorkPolicy } from '@retake/core/policy';
import type { ComponentRegistry } from '@retake/components/geometry';
import type { EditPlan } from '../plan-types.js';
import { guardedPageFailed, guardedPageFailure } from './network-guard.js';
import { chooseEncode, ownEncodeFailure, defaultConcurrency, encodingRecord, gpuPathFailureOf, remotionEncoding, renderGpuInfo, rendererWords } from './policy.js';
import type { EncodeChoice, RenderPolicy } from './policy.js';
import { noteOwnEncodeFailed, rewritePreStitcher } from './encode-tools.js';
import { VIDEO_COMPOSITIONS, videoProps } from '../remotion/contract.js';
import { RENDER_ENCODING } from '../render-fields.js';
import { RenderCancelledError, RenderError } from './types.js';
import { probeMedia } from './probe.js';
import type { RenderRecord } from '../render-record.js';
import { errorMessage } from '@retake/core/base';
import { handedDriver } from './driver-guard.js';
import { libraryBinaries, rendererLibrary } from './library.js';
import type { RenderDriver } from './driver-types.js';
import { COMMON, cancelled, guardEncoderPipe, openSession } from './render-session.js';
import type { Session } from './render-session.js';
import type { RenderPlanOptions, RenderPlanResult, RenderSeams } from './render-options.js';
import { renderStills } from './render-stills.js';

import { GpuPathFailed, emitProgress, ensureAudioTrack, pathOf, removeLeftovers, softwarePolicy, startRender } from './render-state.js';
import type { Attempt, MediaProgress, RenderRun } from './render-state.js';
export { probeMedia } from './probe.js';
export { guardEncoderPipe, handedProject } from './render-session.js';
export type { RenderNetwork, RenderPathRecord, RenderPlanOptions, RenderPlanResult, RenderSeams } from './render-options.js';
export { renderStills } from './render-stills.js';
export type { RenderStillsOptions } from './render-stills.js';

/** What every render encodes (the encoder and its rate are the policy's: ./policy.ts `remotionEncoding`). */
export { RENDER_ENCODING };
/** JPEG quality of the frames Remotion captures before encoding (high: captures are full of small text). */
export const FRAME_JPEG_QUALITY = 95;
/** Composition ids by variant (written once, in ../remotion/contract.ts). */
export const COMPOSITION_IDS = VIDEO_COMPOSITIONS;

/** The software path's default concurrency (./policy.ts; the GPU path's is GPU_CONCURRENCY). */
export { defaultConcurrency };

/** The session of an attempt; a cancel while it opens is a cancel. */
function openAttemptSession(st: RenderRun, asked: RenderPolicy): Promise<Session> {
  const { opts, root } = st;
  return openSession({
    plan: opts.plan,
    workPolicy: opts.workPolicy,
    root,
    registry: opts.registry,
    cacheDir: opts.cacheDir,
    signal: opts.signal,
    onBundleProgress: (q, cached) => emitProgress(st, { stage: 'bundling', progress: q, overall: 0.1 * q, cached }),
    ...(opts.network ? { network: opts.network } : {}),
    ...(opts.onBrowser ? { onBrowser: opts.onBrowser } : {}),
    policy: asked,
    ...(opts.seams ? { seams: opts.seams } : {}),
  }).catch((e: unknown) => {
    if (cancelled(opts.signal)) throw new RenderCancelledError();
    throw e;
  });
}

/** The encoder and ffmpeg of an attempt, chosen for its session's path; what was asked and not used is said. */
async function chooseAttemptEncode(st: RenderRun, session: Session, a: Attempt): Promise<void> {
  const { opts, size } = st;
  const { n, p } = a;
  // Nothing of the attempt before is said of this one until its own choice is made.
  st.ff = undefined;
  st.tried = pathOf(st, session.gl, a.encoder, rendererWords(session.gpu));
  const choice: EncodeChoice =
    n === 1 && opts.seams?.encoder
      ? { encoder: opts.seams.encoder, ffmpeg: { used: 'library' } }
      : await chooseEncode(p, session.gl, size, {
          workPolicy: opts.workPolicy,
          // The second attempt follows the setting's rule for the path it runs on (software: `auto` takes the
          // library's, `own` ours) — unless the first failed while ours encoded: then the library's, whatever was asked.
          ...(n === 2 && st.ownFailed !== undefined ? { library: true } : {}),
          ...(opts.seams?.videotoolbox ? { videotoolbox: opts.seams.videotoolbox } : {}),
          ...(opts.seams?.ownFfmpeg ? { own: opts.seams.ownFfmpeg } : {}),
          ...(opts.seams?.ownEncodes ? { ownEncodes: opts.seams.ownEncodes } : {}),
          ...(opts.signal ? { signal: opts.signal } : {}),
        });
  a.encoder = choice.encoder;
  const ff = choice.ffmpeg;
  st.ff = ff;
  if (ff.used === 'own') st.ownVersion = ff.version;
  st.tried = pathOf(st, session.gl, a.encoder, rendererWords(session.gpu));
  if (choice.note) session.warnings.push(choice.note);
  // Asked by name and not used: said. Under `auto` the record's note is enough (a machine without one is ordinary),
  // unless a program or the system said something about it: those words go here, never into the record.
  if (ff.used === 'library' && ff.note && !ff.byRule) {
    const said = ff.detail ? ` — ${ff.detail}` : '';
    if (p.ffmpeg.asked === 'own') session.warnings.push(`this machine's ffmpeg was asked for the encode (render.ffmpeg: own) and the rendering library's was used: ${ff.note}${said}`);
    else if (said) session.warnings.push(`this machine's ffmpeg does not encode this render (${ff.note})${said}`);
  }
}

/** Remotion's progress of an attempt as the render's (a test seam may fail the attempt here). */
function onAttemptProgress(st: RenderRun, a: Attempt, q: MediaProgress): void {
  const { opts, total } = st;
  const f = opts.seams?.failAfter;
  if (f && f.attempt === a.n && !a.injected && q.renderedFrames >= f.frames) {
    a.injected = new Error(f.message);
    a.cancel();
  }
  if (q.renderedFrames < total) {
    emitProgress(st, {
      stage: 'rendering',
      progress: q.renderedFrames / total,
      overall: 0.1 + 0.85 * (q.renderedFrames / total),
      totalFrames: total,
      renderedFrames: q.renderedFrames,
      encodedFrames: q.encodedFrames,
      eta_s: q.renderEstimatedTime > 0 ? Math.round(q.renderEstimatedTime / 1000) : undefined,
    });
  } else {
    emitProgress(st, {
      stage: 'encoding',
      progress: q.encodedFrames / total,
      overall: 0.95 + 0.05 * (q.encodedFrames / total),
      totalFrames: total,
      renderedFrames: total,
      encodedFrames: q.encodedFrames,
    });
  }
}

/** The composition selected and its frames rendered and encoded to the attempt's temporary file. */
async function renderAttemptMedia(st: RenderRun, session: Session, a: Attempt): Promise<void> {
  const { opts, total, range, size } = st;
  const { renderMedia, selectComposition } = a.lib;
  const { n, encoder } = a;
  const own = st.ff?.used === 'own' && st.ff.binariesDirectory ? st.ff.binariesDirectory : undefined;
  const bin = libraryBinaries();
  const inputProps = videoProps(session.served);
  const composition = await selectComposition({
    ...COMMON,
    binariesDirectory: bin,
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
  emitProgress(st, { stage: 'rendering', progress: 0, overall: 0.1, totalFrames: total, renderedFrames: 0, encodedFrames: 0 });
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
    outputLocation: a.partial,
    overwrite: true,
    inputProps,
    concurrency: a.p.concurrency,
    ...(range ? { frameRange: range } : {}),
    cancelSignal: a.cancelSignal,
    puppeteerInstance: session.puppeteer,
    // Guarded: no program — a page that fails ends the render, never a browser Remotion opens itself.
    browserExecutable: session.executable,
    ...(session.chromium.gl ? { chromiumOptions: session.chromium } : {}),
    ...session.remotion,
    // The library's compositor (the app's downloaded one); our ffmpeg encodes the frames when it is used
    // (./encode-tools.ts): the folder that dispatches to it, its arguments rewritten, and frames over the pipe it reads
    // (no shared-memory capture, which only the library's ffmpeg knows).
    binariesDirectory: own ?? bin,
    ...(own ? { ffmpegOverride: rewritePreStitcher, disableSharedMemoryCapture: true } : {}),
    onProgress: (q) => onAttemptProgress(st, a, q),
  });
}

/** A rendered attempt: what drew it checked again, the audio track made sure of, the file moved to `out`. */
async function finishAttempt(st: RenderRun, session: Session, a: Attempt): Promise<RenderPlanResult> {
  const { opts, out, size, warnings } = st;
  // What drew it, read again at the end: Chromium leaves the GPU by itself when its GPU process keeps failing.
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
  await ensureAudioTrack(a.partial, opts.workPolicy);
  await rename(a.partial, out);
  const sizeBytes = (await stat(out)).size;
  const renderer = rendererWords(gpu);
  warnings.push(...session.warnings, ...(session.guard?.warnings() ?? []));
  return {
    file: out,
    bundle: session.bundle,
    browser: session.browser,
    concurrency: a.p.concurrency,
    bundle_ms: st.bundleMs,
    render_ms: Math.round(performance.now() - a.tr),
    size_bytes: sizeBytes,
    warnings: [...new Set(warnings)],
    path: pathOf(st, used, a.encoder, renderer),
    encoding: encodingRecord(a.encoder, size),
  };
}

/** A failed attempt: its temporary file removed, then a cancel, the one fallback (GpuPathFailed) or the render's error. */
async function attemptFailed(st: RenderRun, session: Session, a: Attempt, caught: unknown): Promise<never> {
  const { opts, warnings, ff } = st;
  const { n, encoder } = a;
  const e = a.injected ?? caught;
  // Nothing half-written is kept, whatever comes next (a fallback writes a fresh temporary file).
  await rm(a.partial, { force: true }).catch(() => undefined);
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
  if (gpu) throw new GpuPathFailed(gpu.reason, { gpu: true, own: gpu.sign === 'encoder' && ff?.used === 'own' ? (ff.path ?? '') : undefined });
  // Our ffmpeg failed at the encode: the one retry, with the library's (in software, the path that must work).
  const ownReason = n === 1 && ff?.used === 'own' ? ownEncodeFailure(e, { ...(ff.version ? { version: ff.version } : {}), ...(ff.binariesDirectory ? { folder: ff.binariesDirectory } : {}) }) : null;
  if (ownReason) throw new GpuPathFailed(ownReason, { gpu: false, own: ff?.path ?? '' });
  if (e instanceof RenderError) throw e;
  throw new RenderError(`render failed: ${errorMessage(e)}`);
}

/** One attempt of the render through its own session: the encode chosen, the frames rendered, the file moved to `out`. */
async function renderAttempt(st: RenderRun, asked: RenderPolicy, n: 1 | 2): Promise<RenderPlanResult> {
  const { opts, out } = st;
  const t0 = performance.now();
  const session = await openAttemptSession(st, asked);
  if (n === 1) st.bundleMs = Math.round(performance.now() - t0);
  const p = session.policy;
  if (n === 1) st.first = p;
  const partial = join(dirname(out), `.${basename(out, '.mp4')}.partial-${randomBytes(4).toString('hex')}.mp4`);
  const lib = await rendererLibrary();
  const { cancelSignal, cancel } = lib.makeCancelSignal();
  const onAbort = () => cancel();
  const a: Attempt = { n, p, lib, partial, cancelSignal, cancel, injected: undefined, encoder: 'libx264', tr: 0 };
  opts.signal?.addEventListener('abort', onAbort);
  a.tr = performance.now();
  try {
    if (cancelled(opts.signal)) throw new RenderCancelledError();
    await chooseAttemptEncode(st, session, a);
    await renderAttemptMedia(st, session, a);
    if (cancelled(opts.signal)) throw new RenderCancelledError();
    return await finishAttempt(st, session, a);
  } catch (caught) {
    return await attemptFailed(st, session, a, caught);
  } finally {
    opts.signal?.removeEventListener('abort', onAbort);
    await session.close();
    // Remotion may leave its in-progress fast-start file behind when cancelled mid-mux.
    await removeLeftovers(dirname(out), basename(partial));
  }
}

/** A failure carries what was tried and the warnings so far (the failed record keeps them). */
function failedRender(st: RenderRun, e: unknown): never {
  if (e instanceof RenderError && !(e instanceof RenderCancelledError)) {
    e.path = st.tried;
    e.renderWarnings = [...new Set(st.warnings)];
  }
  throw e;
}

/** The one fallback after the GPU path or our ffmpeg failed: rendered again from frame 0 in software. */
async function retryInSoftware(st: RenderRun, e: GpuPathFailed): Promise<RenderPlanResult> {
  const { opts, warnings } = st;
  if (cancelled(opts.signal)) throw new RenderCancelledError();
  if (e.own !== undefined) {
    // Ours was encoding: not taken again by this process (a render after this one keeps its path, with the library's).
    st.ownFailed = e.reason;
    if (e.own) noteOwnEncodeFailed(e.own);
  }
  if (e.gpu) {
    st.fallback = { reason: e.reason };
    warnings.push(
      `the render failed on the GPU path (${e.reason})${e.own !== undefined ? " while this machine's ffmpeg was encoding" : ''} and was rendered again in software${e.own !== undefined ? " with the rendering library's" : ''}`,
    );
  } else warnings.push(`the encode failed with this machine's ffmpeg (${e.reason}) and the video was rendered again in software with the rendering library's`);
  st.retrying = true;
  emitProgress(st, { stage: 'retrying', progress: 0, overall: st.high, totalFrames: st.total, renderedFrames: st.highFrames });
  try {
    return await renderAttempt(st, softwarePolicy(st.first ?? st.policy), 2);
  } catch (e2) {
    // The software attempt failed too: said with the GPU path's reason (the error is the software attempt's).
    if (e2 instanceof RenderError && !(e2 instanceof RenderCancelledError))
      e2.message = `render failed in software, after ${e.gpu ? 'the GPU path failed' : "this machine's ffmpeg failed at the encode"} (${e.reason}): ${e2.message.replace(/^render failed: /, '')}`;
    return failedRender(st, e2);
  }
}

/**
 * Render a plan to `out` (.mp4). The video is encoded under a temporary name next to `out` and renamed when complete:
 * a failure or a cancellation (AbortSignal → Remotion cancel signal) leaves nothing under `out`.
 *
 * The policy (./policy.ts) picks the GL, the encoder (before the render: VideoToolbox's size limit and probe) and the
 * concurrency. One fallback: when the GPU path itself fails (`gpuPathFailure`: the GPU process, the GL context,
 * the hardware encoder or its pipe — never a cancel, a timeout, a full disk or an error of the plan), the video is
 * rendered once more from frame 0 in software with libx264, to a fresh temporary file, through a new session (its
 * browser reported and guarded again); progress never goes back (stage `retrying`, clamped), a cancel still cancels.
 */
export async function renderPlan(opts: RenderPlanOptions): Promise<RenderPlanResult> {
  const st = startRender(opts);
  guardEncoderPipe();
  if (cancelled(opts.signal)) throw new RenderCancelledError();
  emitProgress(st, { stage: 'bundling', progress: 0, overall: 0 });
  await mkdir(dirname(st.out), { recursive: true });
  try {
    return await renderAttempt(st, st.policy, 1);
  } catch (e) {
    if (!(e instanceof GpuPathFailed)) return failedRender(st, e);
    return await retryInSoftware(st, e);
  }
}

// ── this package's driver ──────────────────────────────────────────────────────

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

// ── renderStill ───────────────────────────────────────────────────────────────

export interface RenderStillOptions {
  plan: EditPlan;
  /** Output frame (0-based). */
  frame: number;
  /** Output .png. */
  out: string;
  /** Workspace root (bundle cache). */
  root: string;
  /** Registry to find the plan's component implementations: required, a still loads none by itself. */
  registry: ComponentRegistry;
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
