/**
 * Rendering (DESIGN-phase2 §2.2): an EditPlan → an MP4 (h264 crf 16, yuv420p, faststart, an audio track always
 * present: silent without music) or a PNG still, with Remotion. The plan's assets are served by a local HTTP server
 * for the duration of the render, the compositions come from a cached bundle (./bundle.ts), and the browser is
 * $DEMO_STUDIO_CHROMIUM_HEADLESS_SHELL or Playwright's headless shell (./browser.ts).
 */
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { availableParallelism, cpus } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { findWorkspaceRoot, loadProject, loadProjectTemplate, readJson } from '@demo-studio/core';
import type { LoadedProject, LoadedTemplate, Timeline } from '@demo-studio/core';
import { loadComponentRegistry } from '@demo-studio/components';
import type { ComponentRegistry } from '@demo-studio/components';
import { planEdit } from '../plan.js';
import type { EditOverrides, EditPlan } from '../plan-types.js';
import { resolvePlanAssets } from '../summary.js';
import { startAssetServer } from './asset-server.js';
import { renderBrowser } from './browser.js';
import type { RenderBrowser } from './browser.js';
import { bundleComponentsFor, ensureBundle } from './bundle.js';
import type { RenderBundle } from './bundle.js';
import { findRun, rendersDir, reserveVersion, runScenario } from './runs.js';
import { RenderCancelledError, RenderError } from './types.js';
import type { RenderProgress, RenderRecord } from './types.js';

/** Encoding of every render. */
export const RENDER_ENCODING = { codec: 'h264', crf: 16, pixel_format: 'yuv420p' } as const;
/** JPEG quality of the frames Remotion captures before encoding (high: captures are full of small text). */
export const FRAME_JPEG_QUALITY = 95;
/** Composition ids by variant (see ../remotion/Root.tsx). */
export const COMPOSITION_IDS = { landscape: 'DemoVideo', vertical: 'DemoVertical' } as const;

/**
 * Default concurrency: three quarters of the CPUs, 1–8 (frame capture, the frame extractor and the encoder share the
 * machine: 3 on a 4-CPU machine, measured ≈ 12 % faster than 2 and as fast as 4).
 */
export function defaultConcurrency(): number {
  const n = typeof availableParallelism === 'function' ? availableParallelism() : cpus().length;
  return Math.max(1, Math.min(8, Math.floor(n * 0.75)));
}

export interface RenderPlanOptions {
  plan: EditPlan;
  /** Output .mp4 (written to a temporary name first, renamed on success). */
  out: string;
  /** Workspace root (bundle cache); default: the workspace of the cwd. */
  root?: string;
  /** Registry to find the plan's component implementations (default: the workspace's). */
  registry?: ComponentRegistry;
  /** Bundle cache folder (default <root>/.demo-studio/cache). */
  cacheDir?: string;
  concurrency?: number;
  signal?: AbortSignal;
  onProgress?: (p: RenderProgress) => void;
  /** Only these output frames [first, last] (inclusive; previews, tests). */
  frameRange?: [number, number];
}

export interface RenderPlanResult {
  file: string;
  bundle: RenderBundle;
  browser: RenderBrowser;
  concurrency: number;
  bundle_ms: number;
  render_ms: number;
  size_bytes: number;
  warnings: string[];
}

function cancelled(signal?: AbortSignal): boolean {
  return signal?.aborted === true;
}

/** Lazy: @remotion/renderer pulls in a lot (keep `studio plan` fast). */
async function remotionRenderer() {
  return import('@remotion/renderer');
}

interface Session {
  serveUrl: string;
  bundle: RenderBundle;
  browser: RenderBrowser;
  served: EditPlan;
  close: () => Promise<void>;
  puppeteer: Awaited<ReturnType<Awaited<ReturnType<typeof remotionRenderer>>['openBrowser']>>;
  warnings: string[];
}

/** Asset server + bundle + browser for one render or still; `close()` releases the server and the browser. */
async function openSession(opts: {
  plan: EditPlan;
  root: string;
  registry?: ComponentRegistry;
  cacheDir?: string;
  signal?: AbortSignal;
  onBundleProgress?: (p: number, cached: boolean) => void;
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
  const server = await startAssetServer();
  const missing = Object.values(opts.plan.assets).filter((f) => !existsSync(f));
  if (missing.length > 0) {
    await server.close();
    throw new RenderError(`files of the plan are missing: ${missing.join(', ')}`);
  }
  const served = resolvePlanAssets(opts.plan, (_url, file) => server.urlFor(file));
  const browser = renderBrowser();
  if (browser.note) warnings.push(browser.note);
  const { openBrowser } = await remotionRenderer();
  let puppeteer: Session['puppeteer'];
  try {
    puppeteer = await openBrowser('chrome', { browserExecutable: browser.path, chromeMode: 'headless-shell', logLevel: 'error' });
  } catch (e) {
    await server.close();
    throw new RenderError(`the render browser did not start (${browser.path ?? 'Remotion headless shell'}): ${(e as Error).message.split('\n')[0]}`);
  }
  return {
    serveUrl: bundle.serveUrl,
    bundle,
    browser,
    served,
    puppeteer,
    warnings,
    close: async () => {
      await puppeteer.close({ silent: true }).catch(() => undefined);
      await server.close();
    },
  };
}

const COMMON = { chromeMode: 'headless-shell', logLevel: 'error', timeoutInMilliseconds: 90_000 } as const;

/**
 * Render a plan to `out` (.mp4). The video is encoded under a temporary name next to `out` and renamed when complete:
 * a failure or a cancellation (AbortSignal → Remotion cancel signal) leaves nothing under `out`.
 */
export async function renderPlan(opts: RenderPlanOptions): Promise<RenderPlanResult> {
  const out = resolve(opts.out);
  if (extname(out).toLowerCase() !== '.mp4') throw new RenderError(`render output must be an .mp4 file: ${out}`);
  const root = opts.root ? resolve(opts.root) : findWorkspaceRoot();
  const concurrency = Math.max(1, Math.round(opts.concurrency ?? defaultConcurrency()));
  const range = opts.frameRange;
  if (range && !(range[0] >= 0 && range[1] >= range[0] && range[1] < opts.plan.durationInFrames)) {
    throw new RenderError(`frame range ${range[0]}–${range[1]} is outside the video (0–${opts.plan.durationInFrames - 1})`);
  }
  const total = range ? range[1] - range[0] + 1 : opts.plan.durationInFrames;
  const emit = opts.onProgress ?? (() => undefined);
  if (cancelled(opts.signal)) throw new RenderCancelledError();
  const tb = performance.now();
  emit({ stage: 'bundling', progress: 0, overall: 0 });
  const session = await openSession({
    plan: opts.plan,
    root,
    registry: opts.registry,
    cacheDir: opts.cacheDir,
    signal: opts.signal,
    onBundleProgress: (p, cached) => emit({ stage: 'bundling', progress: p, overall: 0.1 * p, cached }),
  }).catch((e: unknown) => {
    if (cancelled(opts.signal)) throw new RenderCancelledError();
    throw e;
  });
  const bundleMs = Math.round(performance.now() - tb);
  await mkdir(dirname(out), { recursive: true });
  const partial = join(dirname(out), `.${basename(out, '.mp4')}.partial-${randomBytes(4).toString('hex')}.mp4`);
  const { renderMedia, selectComposition, makeCancelSignal } = await remotionRenderer();
  const { cancelSignal, cancel } = makeCancelSignal();
  const onAbort = () => cancel();
  opts.signal?.addEventListener('abort', onAbort);
  const tr = performance.now();
  try {
    if (cancelled(opts.signal)) throw new RenderCancelledError();
    const inputProps = { plan: session.served };
    const composition = await selectComposition({
      ...COMMON,
      serveUrl: session.serveUrl,
      id: COMPOSITION_IDS[opts.plan.variant],
      inputProps,
      puppeteerInstance: session.puppeteer,
      browserExecutable: session.browser.path,
    });
    if (composition.durationInFrames !== opts.plan.durationInFrames) {
      throw new RenderError(`composition has ${composition.durationInFrames} frames, the plan ${opts.plan.durationInFrames}`);
    }
    emit({ stage: 'rendering', progress: 0, overall: 0.1, totalFrames: total, renderedFrames: 0, encodedFrames: 0 });
    await renderMedia({
      ...COMMON,
      composition,
      serveUrl: session.serveUrl,
      codec: RENDER_ENCODING.codec,
      crf: RENDER_ENCODING.crf,
      pixelFormat: RENDER_ENCODING.pixel_format,
      // Limited-range BT.709 (plain yuv420p, tagged): what players and platforms expect from an h264 MP4.
      colorSpace: 'bt709',
      imageFormat: 'jpeg',
      jpegQuality: FRAME_JPEG_QUALITY,
      enforceAudioTrack: true,
      outputLocation: partial,
      overwrite: true,
      inputProps,
      concurrency,
      ...(range ? { frameRange: range } : {}),
      cancelSignal,
      puppeteerInstance: session.puppeteer,
      browserExecutable: session.browser.path,
      onProgress: (p) => {
        if (p.renderedFrames < total) {
          emit({
            stage: 'rendering',
            progress: p.renderedFrames / total,
            overall: 0.1 + 0.85 * (p.renderedFrames / total),
            totalFrames: total,
            renderedFrames: p.renderedFrames,
            encodedFrames: p.encodedFrames,
            eta_s: p.renderEstimatedTime > 0 ? Math.round(p.renderEstimatedTime / 1000) : undefined,
          });
        } else {
          emit({ stage: 'encoding', progress: p.encodedFrames / total, overall: 0.95 + 0.05 * (p.encodedFrames / total), totalFrames: total, renderedFrames: total, encodedFrames: p.encodedFrames });
        }
      },
    });
    if (cancelled(opts.signal)) throw new RenderCancelledError();
    await ensureAudioTrack(partial);
    await rename(partial, out);
    const size = (await stat(out)).size;
    return {
      file: out,
      bundle: session.bundle,
      browser: session.browser,
      concurrency,
      bundle_ms: bundleMs,
      render_ms: Math.round(performance.now() - tr),
      size_bytes: size,
      warnings: session.warnings,
    };
  } catch (e) {
    await rm(partial, { force: true }).catch(() => undefined);
    if (cancelled(opts.signal) || e instanceof RenderCancelledError) throw new RenderCancelledError();
    if (e instanceof RenderError) throw e;
    throw new RenderError(`render failed: ${(e as Error).message}`);
  } finally {
    opts.signal?.removeEventListener('abort', onAbort);
    await session.close();
    // Remotion may leave its in-progress fast-start file behind when cancelled mid-mux.
    await removeLeftovers(dirname(out), basename(partial));
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

// ── ffprobe (optional: the record says what the file holds when ffprobe is on PATH) ──

interface Probe {
  duration_s: number;
  frames?: number;
  width: number;
  height: number;
  fps: number;
  audio_streams: number;
  video_codec?: string;
  audio_codec?: string;
}

function run(cmd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((ok) => {
    execFile(cmd, args, { maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : 127) : 0;
      ok({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

/** ffprobe of a media file; undefined when ffprobe is not available. */
export async function probeMedia(file: string): Promise<Probe | undefined> {
  const r = await run('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height,r_frame_rate,nb_frames:format=duration', '-of', 'json', file]);
  if (r.code !== 0) return undefined;
  try {
    const j = JSON.parse(r.stdout) as { streams: Array<Record<string, string | number>>; format: { duration?: string } };
    const v = j.streams.find((s) => s.codec_type === 'video');
    const a = j.streams.filter((s) => s.codec_type === 'audio');
    const [num, den] = String(v?.r_frame_rate ?? '0/1').split('/').map(Number);
    const out: Probe = {
      duration_s: Number(j.format.duration ?? 0),
      width: Number(v?.width ?? 0),
      height: Number(v?.height ?? 0),
      fps: den ? Math.round((num / den) * 1000) / 1000 : 0,
      audio_streams: a.length,
    };
    if (v?.nb_frames !== undefined) out.frames = Number(v.nb_frames);
    if (v?.codec_name) out.video_codec = String(v.codec_name);
    if (a[0]?.codec_name) out.audio_codec = String(a[0].codec_name);
    return out;
  } catch {
    return undefined;
  }
}

/**
 * Remotion's `enforceAudioTrack` adds a silent track to a video without audio; this checks it (when ffprobe is
 * available) and adds one with ffmpeg if a file ever comes out without (players and platforms expect one).
 */
async function ensureAudioTrack(file: string): Promise<void> {
  const p = await probeMedia(file);
  if (!p || p.audio_streams > 0) return;
  const tmp = `${file}.audio-${randomBytes(3).toString('hex')}.mp4`;
  const r = await run('ffmpeg', ['-v', 'error', '-y', '-i', file, '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000', '-shortest', '-c:v', 'copy', '-c:a', 'aac', '-movflags', '+faststart', tmp]);
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
  /** Explicit output .mp4 (default renders/<scenario>-v<N>[-vertical].mp4 with the next free N). */
  out?: string;
  onProgress?: (p: RenderProgress) => void;
  signal?: AbortSignal;
  concurrency?: number;
  /** Workspace root (default: the project's). */
  root?: string;
  registry?: ComponentRegistry;
  /** Bundle cache folder (default <root>/.demo-studio/cache). */
  cacheDir?: string;
}

/**
 * Plan and render a run: renders/<scenario>-v<N>.mp4 (+ "-vertical" for the vertical variant) and the RenderRecord
 * renders/<scenario>-v<N>.json (plan, overrides, theme, run, duration, frames, size, status). N is the next free
 * version. Nothing is written under the final names when the render fails or is cancelled.
 */
export async function renderVideo(opts: RenderVideoOptions): Promise<RenderRecord> {
  const t0 = performance.now();
  const createdAt = new Date().toISOString();
  const emit = opts.onProgress ?? (() => undefined);
  emit({ stage: 'planning', progress: 0, overall: 0 });
  const project = typeof opts.project === 'string' ? await loadProject(opts.project, opts.root) : opts.project;
  const root = resolve(opts.root ?? project.root);
  const run = findRun(project, opts.run, opts.scenario);
  const timelineFile = join(run.dir, 'timeline.json');
  if (!existsSync(timelineFile)) throw new RenderError(`run ${run.id} has no timeline.json (${run.dir})`);
  const timeline = await readJson<Timeline>(timelineFile);
  if (opts.scenario && timeline.scenario !== opts.scenario) throw new RenderError(`run ${run.id} is a run of scenario "${timeline.scenario}", not "${opts.scenario}"`);
  if (timeline.mode === 'dry') throw new RenderError(`run ${run.id} is a dry run: there is no capture to render`);
  const overrides: EditOverrides = { ...(opts.overrides ?? {}) };
  let template: LoadedTemplate;
  if (opts.template && typeof opts.template === 'object') template = opts.template;
  else template = await loadProjectTemplate(project, opts.template ?? overrides.theme ?? timeline.video?.template ?? project.config.template);
  if (opts.template || overrides.theme) overrides.theme = template.name;
  const registry = opts.registry ?? (await loadComponentRegistry({ root }));
  const captureFile = join(run.dir, timeline.capture.file || 'capture.mp4');
  if (!existsSync(captureFile)) throw new RenderError(`run ${run.id} has no capture video (${captureFile})`);
  const plan = planEdit({ timeline, template, project, registry, captureFile, scenario: await runScenario(run.dir), overrides });
  const planMs = Math.round(performance.now() - t0);
  emit({ stage: 'planning', progress: 1, overall: 0 });

  const scenario = timeline.scenario;
  const suffix = plan.variant === 'vertical' ? '-vertical' : '';
  let file: string;
  let version: number | undefined;
  let release = async () => undefined as void;
  if (opts.out) {
    file = resolve(opts.out);
    if (extname(file).toLowerCase() !== '.mp4') throw new RenderError(`--out must name an .mp4 file: ${file}`);
  } else {
    const dir = rendersDir(project);
    await mkdir(dir, { recursive: true });
    const r = await reserveVersion(dir, scenario);
    version = r.version;
    release = r.release;
    file = join(dir, `${scenario}-v${version}${suffix}.mp4`);
  }
  const recordFile = file.replace(/\.mp4$/i, '.json');
  const id = basename(file, extname(file));
  const base = (): RenderRecord => ({
    version: 1,
    id,
    project: project.slug,
    scenario,
    run_id: timeline.run_id,
    run_dir: run.dir,
    template: template.name,
    overrides,
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
    encoding: { ...RENDER_ENCODING, faststart: true, audio: plan.music ? 'music' : 'silent' },
    concurrency: opts.concurrency ?? defaultConcurrency(),
    bundle: { hash: '', cached: false, ms: 0 },
    browser: { path: null, source: 'remotion' },
    timings: { plan_ms: planMs, bundle_ms: 0, render_ms: 0, total_ms: 0 },
    warnings: [...plan.warnings],
    plan,
  });
  try {
    const res = await renderPlan({
      plan,
      out: file,
      root,
      registry,
      cacheDir: opts.cacheDir,
      concurrency: opts.concurrency,
      signal: opts.signal,
      onProgress: emit,
    });
    const record = base();
    record.size_bytes = res.size_bytes;
    record.concurrency = res.concurrency;
    record.bundle = { hash: res.bundle.hash, cached: res.bundle.cached, ms: res.bundle.ms };
    record.browser = { path: res.browser.path, source: res.browser.source };
    record.warnings.push(...res.warnings);
    const probe = await probeMedia(file);
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
    const record = base();
    record.status = e instanceof RenderCancelledError ? 'cancelled' : 'failed';
    record.error = (e as Error).message;
    record.finished_at = new Date().toISOString();
    record.timings.total_ms = Math.round(performance.now() - t0);
    if (e instanceof RenderCancelledError) throw new RenderCancelledError(record);
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
}

/** Render one output frame of a plan to a PNG; returns the file. */
export async function renderStill(opts: RenderStillOptions): Promise<string> {
  const out = resolve(opts.out);
  const frame = Math.round(opts.frame);
  if (!(frame >= 0 && frame < opts.plan.durationInFrames)) {
    throw new RenderError(`frame ${opts.frame} is outside the video (0–${opts.plan.durationInFrames - 1})`);
  }
  const root = opts.root ? resolve(opts.root) : findWorkspaceRoot();
  const session = await openSession({ plan: opts.plan, root, registry: opts.registry, cacheDir: opts.cacheDir });
  try {
    const { renderStill: still, selectComposition } = await remotionRenderer();
    const inputProps = { plan: session.served };
    const composition = await selectComposition({
      ...COMMON,
      serveUrl: session.serveUrl,
      id: COMPOSITION_IDS[opts.plan.variant],
      inputProps,
      puppeteerInstance: session.puppeteer,
      browserExecutable: session.browser.path,
    });
    await mkdir(dirname(out), { recursive: true });
    await still({
      ...COMMON,
      composition,
      serveUrl: session.serveUrl,
      frame,
      output: out,
      imageFormat: 'png',
      overwrite: true,
      inputProps,
      puppeteerInstance: session.puppeteer,
      browserExecutable: session.browser.path,
    });
    return out;
  } catch (e) {
    if (e instanceof RenderError) throw e;
    throw new RenderError(`still failed: ${(e as Error).message}`);
  } finally {
    await session.close();
  }
}
