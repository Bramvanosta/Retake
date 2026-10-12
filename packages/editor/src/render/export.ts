/**
 * Export a render to delivery formats (R-EXP-*, DESIGN-phase2 §2): what can be derived from the master video is
 * transcoded with ffmpeg (1080p from a 4K master, WebM VP9 + Opus, an animated GIF preview), and what needs another
 * framing is RE-RENDERED through the planner from the same run, theme and overrides (vertical 9:16 and square 1:1 are
 * reframed on the cursor and the targets; 4K from a 1080p master renders everything at 4K — the capture itself is
 * upscaled, with a warning, unless it was captured at scale 2). Outputs go to `<project>/exports/<render-id>/` with a
 * `manifest.json` describing each file (format, method, size, duration, codecs, the ffprobe of the file).
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { loadProject } from '@demo-studio/core';
import type { LoadedProject } from '@demo-studio/core';
import type { ComponentRegistry } from '@demo-studio/components';
import type { PlanVariant } from '../plan-types.js';
import { probeMedia, renderVideo } from './render.js';
import { listRenders, rendersDir } from './runs.js';
import { RenderError } from './types.js';
import type { RenderRecord } from './types.js';

/** Delivery formats. */
export const EXPORT_FORMATS = ['mp4_1080p', 'mp4_4k', 'webm', 'vertical_9x16', 'square_1x1', 'gif_preview'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];
/** Formats exported when none are named (the ones derived from the master, no re-render). */
export const DEFAULT_EXPORT_FORMATS: readonly ExportFormat[] = ['mp4_1080p', 'webm', 'gif_preview'];

/** GIF preview settings (R-EXP-05): palette, 480 px wide, 12 fps, 15 s. */
export const GIF_PREVIEW = { width: 480, fps: 12, seconds: 15, colors: 128, lead_s: 5 } as const;

/** Base (scale 1) and 4K sizes of each variant. */
const SIZES: Record<PlanVariant, { base: [number, number]; k4: [number, number] }> = {
  landscape: { base: [1920, 1080], k4: [3840, 2160] },
  vertical: { base: [1080, 1920], k4: [2160, 3840] },
  square: { base: [1080, 1080], k4: [2160, 2160] },
};

export interface ExportOutput {
  format: ExportFormat;
  /** Absolute path. */
  file: string;
  /** copy: the master as is; transcode: ffmpeg from the master; render: re-rendered through the planner. */
  method: 'copy' | 'transcode' | 'render';
  width: number;
  height: number;
  duration_s: number;
  fps: number;
  video_codec?: string;
  audio_codec?: string;
  audio_streams: number;
  size_bytes: number;
  ms: number;
  /** GIF: the window of the master it shows (seconds) and why. */
  window?: { start_s: number; duration_s: number; reason: 'first' | 'highlight' | 'asked' };
  /** Re-rendered formats: the render record written next to the file. */
  record?: string;
  warnings: string[];
}

export interface ExportResult {
  version: 1;
  project: string;
  render: string;
  scenario: string;
  run_id: string;
  /** The master render. */
  master: { file: string; record: string; variant: PlanVariant; width: number; height: number; duration_s: number; fps: number };
  dir: string;
  manifest: string;
  created_at: string;
  outputs: ExportOutput[];
  /** Formats that failed (the others are still written). */
  failures: Array<{ format: ExportFormat; error: string }>;
}

export interface ExportProgress {
  format: ExportFormat;
  stage: 'start' | 'progress' | 'done' | 'failed';
  /** 0..1 within the format (re-renders report their render progress). */
  progress: number;
  message?: string;
}

export interface ExportRenderOptions {
  project: LoadedProject | string;
  /** Render id (renders/<id>.json), a path to a record / video, or `latest` (of `scenario` when given). */
  render: string;
  scenario?: string;
  formats?: readonly ExportFormat[];
  /** Output folder (default `<project>/exports/<render-id>/`). */
  out?: string;
  /** GIF window (default: around the first marker, else the first 15 s). */
  gif?: { start_s?: number; duration_s?: number };
  root?: string;
  registry?: ComponentRegistry;
  concurrency?: number;
  signal?: AbortSignal;
  onProgress?: (p: ExportProgress) => void;
  ffmpeg?: string;
}

/** An export that cannot start (message written for the user). */
export class ExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExportError';
  }
}

async function readRecord(file: string): Promise<RenderRecord> {
  let r: RenderRecord;
  try {
    r = JSON.parse(await readFile(file, 'utf8')) as RenderRecord;
  } catch (e) {
    throw new ExportError(`cannot read the render record ${file}: ${(e as Error).message}`);
  }
  if (!r || r.version !== 1 || typeof r.id !== 'string' || !r.plan) throw new ExportError(`${file} is not a render record (renders/<id>.json)`);
  return r;
}

/** The render to export: `latest` (most recent succeeded, of `scenario` when given), an id, or a .json / .mp4 path. */
export async function findRenderRecord(project: LoadedProject, arg: string, scenario?: string): Promise<RenderRecord> {
  if (arg === 'latest') {
    const all = (await listRenders(project)).filter((r) => r.status === 'succeeded' && (!scenario || r.scenario === scenario));
    const last = all[all.length - 1];
    if (!last) throw new ExportError(`no render${scenario ? ` of scenario "${scenario}"` : ''} in ${rendersDir(project)}: render one with \`studio render ${project.slug} ${scenario ?? '<scenario>'}\``);
    return last;
  }
  const byId = join(rendersDir(project), `${arg}.json`);
  if (!/[\\/]/.test(arg) && existsSync(byId)) return readRecord(byId);
  if (isAbsolute(arg) || arg.startsWith('.') || /[\\/]/.test(arg) || /\.(json|mp4)$/.test(arg)) {
    const file = resolve(arg);
    const json = extname(file) === '.json' ? file : join(dirname(file), `${basename(file, extname(file))}.json`);
    if (existsSync(json)) return readRecord(json);
  }
  const ids = (await listRenders(project)).map((r) => r.id);
  throw new ExportError(`render "${arg}" not found in ${rendersDir(project)}${ids.length ? ` (renders: ${ids.slice(-8).join(', ')})` : ''}; use a render id, a .json/.mp4 path or "latest"`);
}

function ffmpeg(bin: string, args: string[], signal?: AbortSignal): Promise<void> {
  return new Promise((ok, fail) => {
    const child = execFile(bin, ['-hide_banner', '-v', 'error', '-y', ...args], { maxBuffer: 16 * 1024 * 1024 }, (err, _o, stderr) => {
      signal?.removeEventListener('abort', onAbort);
      if (err) fail(new Error(signal?.aborted ? 'export cancelled' : `ffmpeg failed: ${String(stderr).trim().split('\n').slice(-3).join(' | ') || err.message}`));
      else ok();
    });
    const onAbort = () => child.kill('SIGTERM');
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** The GIF window: asked, else 15 s around the first marker (5 s before it), else the first 15 s. */
export function gifWindow(record: Pick<RenderRecord, 'plan'>, asked?: { start_s?: number; duration_s?: number }): { start_s: number; duration_s: number; reason: 'first' | 'highlight' | 'asked' } {
  const total = record.plan.durationInFrames / record.plan.fps;
  if (asked?.start_s !== undefined || asked?.duration_s !== undefined) {
    const s = Math.max(0, Math.min(asked.start_s ?? 0, Math.max(0, total - 0.5)));
    return { start_s: round3(s), duration_s: round3(Math.min(asked.duration_s ?? GIF_PREVIEW.seconds, total - s)), reason: 'asked' };
  }
  const d = Math.min(GIF_PREVIEW.seconds, total);
  const mark = record.plan.markers[0];
  if (mark && total > d) {
    const s = Math.max(0, Math.min(mark.frame / record.plan.fps - GIF_PREVIEW.lead_s, total - d));
    return { start_s: round3(s), duration_s: round3(d), reason: 'highlight' };
  }
  return { start_s: 0, duration_s: round3(d), reason: 'first' };
}

const round3 = (x: number) => Math.round(x * 1000) / 1000;

const SUFFIX: Record<ExportFormat, string> = {
  mp4_1080p: '-1080p.mp4',
  mp4_4k: '-4k.mp4',
  webm: '.webm',
  vertical_9x16: '-vertical.mp4',
  square_1x1: '-square.mp4',
  gif_preview: '-preview.gif',
};

/**
 * Export `render` to `formats` (default: mp4_1080p, webm, gif_preview). Each format is written under a temporary name
 * and renamed when complete; a format that fails is reported in `failures` and the others still go out. The manifest
 * (`manifest.json`) keeps the entries of formats exported earlier into the same folder.
 */
export async function exportRender(opts: ExportRenderOptions): Promise<ExportResult> {
  const project = typeof opts.project === 'string' ? await loadProject(opts.project, opts.root) : opts.project;
  const root = resolve(opts.root ?? project.root);
  const record = await findRenderRecord(project, opts.render, opts.scenario);
  if (record.status !== 'succeeded') throw new ExportError(`render ${record.id} ${record.status}: nothing to export`);
  if (!existsSync(record.file)) throw new ExportError(`the video of render ${record.id} is missing (${record.file})`);
  const formats = [...new Set(opts.formats && opts.formats.length > 0 ? opts.formats : DEFAULT_EXPORT_FORMATS)];
  for (const f of formats) if (!(EXPORT_FORMATS as readonly string[]).includes(f)) throw new ExportError(`unknown export format "${f}": use ${EXPORT_FORMATS.join(', ')}`);
  const bin = opts.ffmpeg ?? 'ffmpeg';
  const dir = resolve(opts.out ?? join(project.dir, 'exports', record.id));
  await mkdir(dir, { recursive: true });
  const emit = opts.onProgress ?? (() => undefined);
  const variant = record.variant ?? record.plan.variant;
  const master = { file: record.file, record: record.record, variant, width: record.width, height: record.height, duration_s: record.duration_s, fps: record.fps };
  const base = SIZES[variant].base;
  const isBase = record.width === base[0] && record.height === base[1];
  const is4k = record.width >= SIZES[variant].k4[0] && record.height >= SIZES[variant].k4[1];
  const outputs: ExportOutput[] = [];
  const failures: ExportResult['failures'] = [];

  const finish = async (format: ExportFormat, file: string, method: ExportOutput['method'], t0: number, extra: Partial<ExportOutput> = {}): Promise<ExportOutput> => {
    const probe = await probeMedia(file);
    const size = (await stat(file)).size;
    const out: ExportOutput = {
      format,
      file,
      method,
      width: probe?.width ?? 0,
      height: probe?.height ?? 0,
      duration_s: probe ? round3(probe.duration_s) : 0,
      fps: probe?.fps ?? 0,
      audio_streams: probe?.audio_streams ?? 0,
      size_bytes: size,
      ms: Math.round(performance.now() - t0),
      warnings: [],
      ...extra,
    };
    if (probe?.video_codec) out.video_codec = probe.video_codec;
    if (probe?.audio_codec) out.audio_codec = probe.audio_codec;
    return out;
  };

  // A re-render of the master's run, theme and overrides with another variant / scale; written to `file` (+ .json).
  const rerender = async (format: ExportFormat, file: string, over: { variant: PlanVariant; scale?: number }): Promise<ExportOutput> => {
    const t0 = performance.now();
    const overrides = { ...record.overrides, variant: over.variant };
    if (over.scale !== undefined) overrides.scale = over.scale;
    else delete overrides.scale;
    const r = await renderVideo({
      project,
      root,
      run: record.run_dir,
      scenario: record.scenario,
      template: record.template,
      overrides,
      out: file,
      registry: opts.registry,
      concurrency: opts.concurrency,
      signal: opts.signal,
      onProgress: (p) => emit({ format, stage: 'progress', progress: p.overall, message: p.stage }),
    });
    return finish(format, file, 'render', t0, { record: r.record, warnings: r.warnings.filter((w) => /upscaled|missing|not found/i.test(w)) });
  };

  for (const format of formats) {
    if (opts.signal?.aborted) break;
    const file = join(dir, `${record.id}${SUFFIX[format]}`);
    const tmp = join(dir, `.${basename(file, extname(file))}.partial-${process.pid}${extname(file)}`);
    emit({ format, stage: 'start', progress: 0 });
    const t0 = performance.now();
    try {
      let out: ExportOutput;
      if (format === 'mp4_1080p') {
        if (isBase) {
          await copyFile(record.file, tmp);
          await rename(tmp, file);
          out = await finish(format, file, 'copy', t0);
        } else {
          await ffmpeg(bin, ['-i', record.file, '-vf', `scale=${base[0]}:${base[1]}:flags=lanczos`, '-c:v', 'libx264', '-crf', '18', '-preset', 'medium', '-pix_fmt', 'yuv420p', '-color_range', 'tv', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-c:a', 'copy', '-movflags', '+faststart', tmp], opts.signal);
          await rename(tmp, file);
          out = await finish(format, file, 'transcode', t0);
        }
      } else if (format === 'mp4_4k') {
        if (is4k) {
          await copyFile(record.file, tmp);
          await rename(tmp, file);
          out = await finish(format, file, 'copy', t0);
        } else out = await rerender(format, file, { variant, scale: 2 });
      } else if (format === 'webm') {
        // VP9 (constant quality) + Opus at the variant's base size: the web / embed format.
        const scale = isBase ? [] : ['-vf', `scale=${base[0]}:${base[1]}:flags=lanczos`];
        await ffmpeg(bin, ['-i', record.file, ...scale, '-c:v', 'libvpx-vp9', '-crf', '32', '-b:v', '0', '-row-mt', '1', '-deadline', 'good', '-cpu-used', '4', '-pix_fmt', 'yuv420p', '-c:a', 'libopus', '-b:a', '128k', tmp], opts.signal);
        await rename(tmp, file);
        out = await finish(format, file, 'transcode', t0);
      } else if (format === 'gif_preview') {
        const w = gifWindow(record, opts.gif);
        const g = GIF_PREVIEW;
        const filter = `fps=${g.fps},scale=${g.width}:-2:flags=lanczos,split[a][b];[a]palettegen=max_colors=${g.colors}:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`;
        await ffmpeg(bin, ['-ss', String(w.start_s), '-t', String(w.duration_s), '-i', record.file, '-filter_complex', filter, '-loop', '0', tmp], opts.signal);
        await rename(tmp, file);
        out = await finish(format, file, 'transcode', t0, { window: w });
      } else {
        const v: PlanVariant = format === 'vertical_9x16' ? 'vertical' : 'square';
        if (variant === v && isBase) {
          await copyFile(record.file, tmp);
          await rename(tmp, file);
          out = await finish(format, file, 'copy', t0);
        } else out = await rerender(format, file, { variant: v });
      }
      outputs.push(out);
      emit({ format, stage: 'done', progress: 1, message: file });
    } catch (e) {
      await rm(tmp, { force: true }).catch(() => undefined);
      const message = (e as Error).message;
      failures.push({ format, error: message });
      emit({ format, stage: 'failed', progress: 1, message });
      if (opts.signal?.aborted || e instanceof RenderError && /cancel/i.test(message)) break;
    }
  }

  const manifest = join(dir, 'manifest.json');
  let previous: ExportOutput[] = [];
  try {
    const old = JSON.parse(await readFile(manifest, 'utf8')) as ExportResult;
    if (old.render === record.id) previous = (old.outputs ?? []).filter((o) => !outputs.some((n) => n.format === o.format) && existsSync(o.file));
  } catch {
    // no manifest yet
  }
  const result: ExportResult = {
    version: 1,
    project: project.slug,
    render: record.id,
    scenario: record.scenario,
    run_id: record.run_id,
    master,
    dir,
    manifest,
    created_at: new Date().toISOString(),
    outputs: [...previous, ...outputs].sort((a, b) => EXPORT_FORMATS.indexOf(a.format) - EXPORT_FORMATS.indexOf(b.format)),
    failures,
  };
  await writeFile(manifest, `${JSON.stringify(result, null, 2)}\n`);
  return result;
}
