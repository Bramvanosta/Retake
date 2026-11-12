/**
 * Export a render to delivery formats (R-EXP-*, DESIGN-phase2 §2): what can be derived from the master video is
 * transcoded with ffmpeg (1080p from a 4K master, WebM VP9 + Opus, an animated GIF preview), and what needs another
 * framing is RE-RENDERED through the planner from the same run, theme and overrides (vertical 9:16 and square 1:1 are
 * reframed on the cursor and the targets; 4K from a 1080p master renders everything at 4K — the capture itself is
 * upscaled, with a warning, unless it was captured at scale 2). Outputs go to `<project>/exports/<render-id>/` with a
 * `manifest.json` describing each file (format, method, size, duration, codecs, the ffprobe of the file).
 */
import { existsSync, realpathSync } from 'node:fs';
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import { GUIDE, missingOrInvalid, printableText } from '@retake/core/base';
import { isThemeName } from '@retake/core/ids';
import { projectPath } from '@retake/core/project';
import { insideFolder, isTemplatePath } from '@retake/core/scenario';
import { DEFAULT_EXPORT_FORMAT_NAMES, EXPORT_FORMAT_NAMES } from '@retake/core/render';
import {
  STARTER_FOLDER_ID_PREFIX,
  STARTER_TEMPLATES_DIR,
  ffmpegBin,
  findNamedRender,
  h264CodecArgs,
  h264Encoder,
  loadProject,
  nodeFileFacts,
  projectTemplateFolderId,
  runMediaTool,
  stderrLines,
  templateFolderId,
} from '@retake/core/io';
import type { ErrorKind } from '@retake/core/base';
import type { LoadedProject } from '@retake/core/model';
import type { WorkPolicy } from '@retake/core/policy';
import type { H264Encoder, NamedRenderFound } from '@retake/core/io';
import type { ComponentRegistry } from '@retake/components';
import type { PlanVariant } from '../plan-types.js';
import type { BrowserProcessInfo } from './network-guard.js';
import { PlanTrustError } from './plan-run.js';
import type { PlanTrust } from './plan-run.js';
import { probeMedia, renderVideo } from './render.js';
import { handedDriver } from './driver-guard.js';
import type { RenderDriver } from './driver-types.js';
import type { RenderNetwork } from './render.js';
import { rendersDir } from './runs.js';
import { RenderError } from './types.js';
import { withPlan } from '../render-record.js';
import type { NamedRender, RenderRecord } from '../render-record.js';

/** Delivery formats (one list with core's job input). */
export const EXPORT_FORMATS = EXPORT_FORMAT_NAMES;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];
/** Formats exported when none are named (the ones derived from the master, no re-render): core's one list. */
export const DEFAULT_EXPORT_FORMATS: readonly ExportFormat[] = DEFAULT_EXPORT_FORMAT_NAMES;

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
  /** What the work runs under (core WorkPolicy): which ffmpeg and ffprobe, under its agent policy. */
  workPolicy: WorkPolicy;
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
  /**
   * `mcp` (an export job of the worker): the render is named by its id only, its video and run must lie in the project
   * folder, and re-rendered formats pass planRun's trust gates. Default `author`.
   */
  trust?: PlanTrust;
  /** The network of re-rendered formats (export jobs: `guard`). */
  network?: RenderNetwork;
  /** Called once a re-render's browser runs, with its process. */
  onBrowser?: (b: BrowserProcessInfo) => void;
  /** What renders a re-rendered format (renderVideo `renderer`; no such key: this package's driver). */
  renderer?: Pick<RenderDriver, 'video'>;
}

/** An export that cannot start (message written for the user). */
export class ExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExportError';
  }

  /** What a client outside the CLI is told (core error-kind.ts). */
  get errorKind(): ErrorKind {
    return missingOrInvalid(this.message);
  }

  get errorDocs(): string {
    return GUIDE.editing;
  }
}

/**
 * The theme a re-render of `record` plans with (an export's vertical or square format): the folder the master was
 * rendered with (its record's `template_folder`, L7.9), named so that the editor's folder rule (core io
 * projectTemplateFolderId) finds that very folder — the project's own `template:`, the record's theme name (a theme of
 * the workspace, or a starter's) or a starter's name, the first whose folder is the record's. At a terminal, else, the
 * folder itself (`/starter:<name>`: that starter's folder; a path: against the workspace root). Through MCP never a
 * path the record holds: a folder the project could not name is refused (PlanTrustError), in words that quote nothing
 * of the record. A record of before L7.9 (no folder) is re-rendered with its theme's name, as before.
 */
export async function exportThemeRef(project: LoadedProject, record: Pick<NamedRender, 'template'> & { template_folder?: unknown }, o: { trust?: PlanTrust } = {}): Promise<string> {
  const folder = record.template_folder;
  if (typeof folder !== 'string' || folder === '') return record.template;
  const starter = folder.startsWith(STARTER_FOLDER_ID_PREFIX) ? folder.slice(STARTER_FOLDER_ID_PREFIX.length) : undefined;
  const names = [record.template, ...(starter !== undefined ? [starter] : [])].filter((n) => typeof n === 'string' && isThemeName(n) && !isTemplatePath(n));
  const candidates = [...(typeof project.config.template === 'string' ? [project.config.template] : []), ...names];
  for (const ref of candidates) {
    const id = await projectTemplateFolderId(project, ref).catch(() => undefined);
    if (id === folder) return ref;
  }
  if (o.trust === 'mcp') {
    throw new PlanTrustError([
      'the theme folder this render was made with is not one the project names today (its project.yaml template:, a theme of the workspace or a starter): through MCP a re-render uses only those — re-render it from a terminal, or render the scenario again',
    ]);
  }
  const dir = starter !== undefined ? join(STARTER_TEMPLATES_DIR, starter) : resolve(realpathOf(project.root), ...folder.split('/'));
  // The folder rule both ways: the folder found is the one the record names (a starter's name that is no name, a path
  // of another spelling: refused, never another folder).
  if (templateFolderId(dir, project.root) !== folder)
    throw new RenderError(`the theme folder this render was made with cannot be found from the workspace (${printableText(folder)}): re-render the scenario`);
  return dir;
}

/** A folder's real path, or the path as given when it cannot be read. */
function realpathOf(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/**
 * The render `arg` names, found as a terminal (or, `trust: 'mcp'`, an export job) names it — core/io findNamedRender:
 * `latest` (the newest succeeded record of renders/, of `scenario` when given, whatever its file is called: then the
 * record OF THAT FILE), a render id, or a .json / .mp4 path. A file that is there is a record or one sentence says what
 * it is; a record that lacks its plan is refused, one that lacks its scenario or its creation time works; a record
 * renamed by hand works, but when the video it names is now another render's.
 */
export async function locateRenderRecord(project: LoadedProject, arg: string, scenario?: string, o: { trust?: PlanTrust } = {}): Promise<FoundRender> {
  const found = await findNamedRender(rendersDir(project), arg, {
    verb: 'export',
    slug: project.slug,
    ...(scenario !== undefined ? { scenario } : {}),
    ...(o.trust === 'mcp' ? { trust: 'mcp' as const } : {}),
  });
  if (!found.ok) throw new ExportError(found.message);
  // (findNamedRender refuses a record without its plan: this is the editor's type for what it read.)
  return { ...found.render, record: withPlan(found.render.record).value };
}

/** A render found (locateRenderRecord): what core/io findNamedRender answered, with its plan as an edit plan. */
export type FoundRender = Omit<NamedRenderFound, 'record'> & { record: NamedRender };

/** The render to export: `latest` (most recent succeeded, of `scenario` when given), an id, or a .json / .mp4 path (locateRenderRecord). */
export async function findRenderRecord(project: LoadedProject, arg: string, scenario?: string): Promise<NamedRender> {
  return (await locateRenderRecord(project, arg, scenario)).record;
}

async function ffmpeg(bin: string, args: string[], signal?: AbortSignal): Promise<void> {
  const r = await runMediaTool(bin, ['-hide_banner', '-v', 'error', '-y', ...args], { maxBuffer: 16 * 1024 * 1024, ...(signal ? { signal } : {}) });
  if (r.error) throw new Error(signal?.aborted ? 'export cancelled' : `ffmpeg failed: ${stderrLines(r.stderr, 3) || r.error.message}`);
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

/**
 * The variant an export makes its sizes from: the record's (a record without one: its plan's). A variant this version
 * does not write (a record edited by hand) is refused in one sentence — there is no size for it: at a terminal its word
 * made printable; through MCP (`trust: 'mcp'`) in fixed words only (the word is text anyone who can write renders/ chose).
 */
function knownVariant(record: Pick<NamedRender, 'variant' | 'plan'>, label: string, trust: 'author' | 'mcp' = 'author'): PlanVariant {
  const variant: string = record.variant ?? record.plan.variant;
  if (!isPlanVariant(variant)) {
    const said = trust === 'mcp' ? 'its record says a variant this Retake does not export' : `its record says variant "${printableText(String(variant))}", which this Retake does not export`;
    throw new ExportError(`render ${label}: ${said} (landscape, vertical or square)`);
  }
  return variant;
}

const isPlanVariant = (v: string): v is PlanVariant => Object.hasOwn(SIZES, v);

/**
 * How each format of an export is made from a master: `copy` (the master as is), `transcode` (ffmpeg) or `render` (a
 * re-render through the planner: another framing, or 4K from a smaller master).
 */
export function exportMethod(record: Pick<NamedRender, 'id' | 'variant' | 'width' | 'height' | 'plan'>, format: ExportFormat, o: { trust?: 'author' | 'mcp' } = {}): ExportOutput['method'] {
  const variant = knownVariant(record, printableText(record.id), o.trust);
  const base = SIZES[variant].base;
  const isBase = record.width === base[0] && record.height === base[1];
  if (format === 'mp4_1080p') return isBase ? 'copy' : 'transcode';
  if (format === 'mp4_4k') return record.width >= SIZES[variant].k4[0] && record.height >= SIZES[variant].k4[1] ? 'copy' : 'render';
  if (format === 'webm' || format === 'gif_preview') return 'transcode';
  const v: PlanVariant = format === 'vertical_9x16' ? 'vertical' : 'square';
  return variant === v && isBase ? 'copy' : 'render';
}

/**
 * The warnings of a re-render (a square or vertical export) an export passes on: files upscaled, missing or blocked,
 * and how it was drawn and encoded (L5.15: no GPU found, VideoToolbox's size limit or probe, the GPU path failing and
 * the video rendered again in software). Pure.
 */
export function exportRenderWarnings(warnings: readonly string[]): string[] {
  return warnings.filter((w) => /upscaled|missing|not found|blocked|\bGPU\b|VideoToolbox|in software/i.test(w));
}

/**
 * Why a render may not be exported (or reviewed) by work submitted through MCP, or null: its video and its run folder
 * must lie in the project folder, symbolic links resolved (a record's paths are absolute: one edited by hand, or of a
 * moved workspace, could name any file).
 */
export function recordPathProblem(projectDir: string, record: Pick<RenderRecord, 'id' | 'file' | 'run_dir'>): string | null {
  for (const [what, p] of [
    ['video', record.file],
    ['run folder', record.run_dir],
  ] as const) {
    if (typeof p !== 'string' || !insideFolder(projectDir, p, nodeFileFacts)) {
      return `the ${what} of render ${record.id} (${String(p)}) is outside the project folder: through MCP a render is read only from the project`;
    }
  }
  return null;
}

const SUFFIX: Record<ExportFormat, string> = {
  mp4_1080p: '-1080p.mp4',
  mp4_4k: '-4k.mp4',
  webm: '.webm',
  vertical_9x16: '-vertical.mp4',
  square_1x1: '-square.mp4',
  gif_preview: '-preview.gif',
};

/**
 * The 1080p MP4 transcode of a master at another size: H.264 (libx264 CRF 18 medium; VideoToolbox when the ffmpeg has no
 * libx264 — core h264.ts), yuv420p, BT.709 tags, the audio copied. Exported for tests.
 */
export function mp4TranscodeArgs(input: string, size: readonly [number, number], enc: H264Encoder, out: string): string[] {
  const codec = h264CodecArgs(enc, ['-c:v', 'libx264', '-crf', '18', '-preset', 'medium']);
  return [
    '-i',
    input,
    '-vf',
    `scale=${size[0]}:${size[1]}:flags=lanczos`,
    ...codec,
    '-pix_fmt',
    'yuv420p',
    '-color_range',
    'tv',
    '-colorspace',
    'bt709',
    '-color_primaries',
    'bt709',
    '-color_trc',
    'bt709',
    '-c:a',
    'copy',
    '-movflags',
    '+faststart',
    out,
  ];
}

/** The 1080p MP4 transcode itself, with the H.264 encoder `bin` has (core h264Encoder). Returns it. Exported for tests. */
export async function transcodeMp4(bin: string, input: string, size: readonly [number, number], out: string, signal?: AbortSignal): Promise<H264Encoder> {
  const enc = await h264Encoder(bin);
  await ffmpeg(bin, mp4TranscodeArgs(input, size, enc, out), signal);
  return enc;
}

/**
 * Export `render` to `formats` (default: mp4_1080p, webm, gif_preview). Each format is written under a temporary name
 * and renamed when complete; a format that fails is reported in `failures` and the others still go out. The manifest
 * (`manifest.json`) keeps the entries of formats exported earlier into the same folder.
 */
export async function exportRender(opts: ExportRenderOptions): Promise<ExportResult> {
  // Before any work: a renderer named but not handed is refused (driver-guard.ts), whatever the formats need.
  const handed = handedDriver('export', opts, 'video');
  const project = typeof opts.project === 'string' ? await loadProject(opts.project, opts.root) : opts.project;
  const root = resolve(opts.root ?? project.root);
  const trust = opts.trust ?? 'author';
  // Through MCP: a render id, its own file (core/io findNamedRender). At a terminal: as a person names it.
  const found = await locateRenderRecord(project, opts.render, opts.scenario, { trust });
  const record = found.record;
  // The render as the sentences name it, and the name of its folder of exports/ (never an empty name or a path).
  const name = found.output;
  const label = printableText(name);
  if (trust === 'mcp') {
    const problem = recordPathProblem(project.dir, record);
    if (problem) throw new ExportError(problem);
  }
  if (record.status !== 'succeeded')
    throw new ExportError(
      `render ${label} ${trust === 'mcp' && record.status !== 'failed' && record.status !== 'cancelled' ? 'has a status Retake never writes' : printableText(record.status)}: nothing to export`,
    );
  if (!existsSync(record.file))
    throw new ExportError(`the video of render ${label} is missing (${record.file ? (trust === 'mcp' ? 'the file its record names' : printableText(record.file)) : 'no "file" in its record'})`);
  const variant = knownVariant(record, label, trust);
  const formats = [...new Set(opts.formats && opts.formats.length > 0 ? opts.formats : DEFAULT_EXPORT_FORMATS)];
  for (const f of formats) if (!(EXPORT_FORMATS as readonly string[]).includes(f)) throw new ExportError(`unknown export format "${f}": use ${EXPORT_FORMATS.join(', ')}`);
  const bin = ffmpegBin(opts.workPolicy, opts.ffmpeg);
  const dir = resolve(opts.out ?? projectPath(project.dir, 'exports', name));
  await mkdir(dir, { recursive: true });
  const emit = opts.onProgress ?? (() => undefined);
  const master = { file: record.file, record: record.record, variant, width: record.width, height: record.height, duration_s: record.duration_s, fps: record.fps };
  const base = SIZES[variant].base;
  const isBase = record.width === base[0] && record.height === base[1];
  const outputs: ExportOutput[] = [];
  const failures: ExportResult['failures'] = [];

  const finish = async (format: ExportFormat, file: string, method: ExportOutput['method'], t0: number, extra: Partial<ExportOutput> = {}): Promise<ExportOutput> => {
    const probe = await probeMedia(file, opts.workPolicy);
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
    // The master's theme folder, named as the project can name it (exportThemeRef).
    const theme = await exportThemeRef(project, record, { trust });
    const overrides = { ...record.overrides, variant: over.variant };
    if (over.scale !== undefined) overrides.scale = over.scale;
    else delete overrides.scale;
    const r = await renderVideo({
      workPolicy: opts.workPolicy,
      project,
      root,
      run: record.run_dir,
      scenario: record.scenario,
      template: theme,
      overrides,
      // The master's edit (L5.5): the same version of the scenario file, or the run as captured (renders before L5.5).
      ...(record.edit?.from === 'scenario' ? { editSha256: record.edit.sha256 ?? null } : { edit: 'run' as const }),
      out: file,
      registry: opts.registry,
      concurrency: opts.concurrency,
      signal: opts.signal,
      trust,
      ...(opts.network ? { network: opts.network } : {}),
      ...(opts.onBrowser ? { onBrowser: opts.onBrowser } : {}),
      // The caller's `renderer` key as it came (checked at the start: a key that holds nothing never gets here).
      ...(handed ? { renderer: handed } : {}),
      onProgress: (p) => emit({ format, stage: 'progress', progress: p.overall, message: p.stage }),
    });
    return finish(format, file, 'render', t0, { record: r.record, warnings: exportRenderWarnings(r.warnings) });
  };

  for (const format of formats) {
    if (opts.signal?.aborted) break;
    const file = join(dir, `${name}${SUFFIX[format]}`);
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
          await transcodeMp4(bin, record.file, base, tmp, opts.signal);
          await rename(tmp, file);
          out = await finish(format, file, 'transcode', t0);
        }
      } else if (format === 'mp4_4k') {
        if (exportMethod(record, format, { trust }) === 'copy') {
          await copyFile(record.file, tmp);
          await rename(tmp, file);
          out = await finish(format, file, 'copy', t0);
        } else out = await rerender(format, file, { variant, scale: 2 });
      } else if (format === 'webm') {
        // VP9 (constant quality) + Opus at the variant's base size: the web / embed format.
        const scale = isBase ? [] : ['-vf', `scale=${base[0]}:${base[1]}:flags=lanczos`];
        await ffmpeg(
          bin,
          [
            '-i',
            record.file,
            ...scale,
            '-c:v',
            'libvpx-vp9',
            '-crf',
            '32',
            '-b:v',
            '0',
            '-row-mt',
            '1',
            '-deadline',
            'good',
            '-cpu-used',
            '4',
            '-pix_fmt',
            'yuv420p',
            '-c:a',
            'libopus',
            '-b:a',
            '128k',
            tmp,
          ],
          opts.signal,
        );
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
        if (exportMethod(record, format, { trust }) === 'copy') {
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
      if (opts.signal?.aborted || (e instanceof RenderError && /cancel/i.test(message))) break;
    }
  }

  const manifest = join(dir, 'manifest.json');
  let previous: ExportOutput[] = [];
  try {
    const old = JSON.parse(await readFile(manifest, 'utf8')) as ExportResult;
    if (old.render === name) previous = (old.outputs ?? []).filter((o) => !outputs.some((n) => n.format === o.format) && existsSync(o.file));
  } catch {
    // no manifest yet
  }
  const result: ExportResult = {
    version: 1,
    project: project.slug,
    render: name,
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
