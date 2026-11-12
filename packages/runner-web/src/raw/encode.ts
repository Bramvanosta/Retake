/**
 * Encoding of a raw export's clips (L2.13, R-RAW-01): each clip frame is the screencast frame on screen at its capture
 * time (`cfrSchedule` at the export rate over the run's frame index — 60 fps by real frame timing, never
 * interpolated), linked into a plain sequence and encoded once from the captured JPEG / PNG frames (no generation
 * loss from capture.mp4): H.264 high profile CRF 14 yuv420p + faststart (.mp4) or ProRes 422 HQ yuv422p10le (.mov),
 * BT.709 limited range, 1-second GOP, start timecode = the clip's place on the sequence. A run whose frames were not
 * kept falls back to its CFR video (frames decoded once, repeated — not interpolated — for a higher rate).
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { clipProbeArgs, clipProbeFromJson, readFfprobeJson } from '@retake/core/render';
import type { RawFormat } from '@retake/core/model';
import type { WorkPolicy } from '@retake/core/policy';
import type { ClipProbe } from '@retake/core/render';
import type { H264Encoder } from '@retake/core/io';
import { H264_VIDEOTOOLBOX_QUALITY, ffmpegBin, ffprobeBin, h264CodecArgs, h264Encoder, runMediaTool } from '@retake/core/io';
import { cfrSchedule, materialize, runFfmpeg } from '../encode.js';
import { EncodeError } from '../errors.js';
import type { FrameIndexEntry } from '../recorder.js';
import { gridFrameOf, type RawClipPlan, type RawSource } from './plan.js';

/** Codec settings of the clips. */
export const RAW_ENCODING = {
  mp4: { ext: '.mp4', codec: 'h264', profile: 'High', pix_fmt: 'yuv420p', crf: 14, preset: 'medium', label: 'H.264 high profile, CRF 14, yuv420p, faststart' },
  prores: { ext: '.mov', codec: 'prores', profile: 'HQ', pix_fmt: 'yuv422p10le', label: 'Apple ProRes 422 HQ (prores_ks profile 3), yuv422p10le' },
} as const;
/**
 * The codec label of a package's clips as they were really encoded: an ffmpeg without libx264 encodes the MP4 clips
 * with VideoToolbox (core h264.ts), whose files the label must not call CRF 14.
 */
export function rawCodecLabel(format: RawFormat, h264?: H264Encoder): string {
  if (format === 'mp4' && h264 === 'h264_videotoolbox') return `H.264 high profile (VideoToolbox q:v ${H264_VIDEOTOOLBOX_QUALITY}), yuv420p, faststart`;
  return RAW_ENCODING[format].label;
}
/**
 * Codec settings of the cursor layers. `pix_fmt` is what the encoder is fed; the manifest reports each layer's pixel
 * format as ffprobe reads it back (ProRes 4444 decodes as yuva444p12le; VP9 keeps its alpha in a side channel that
 * only libvpx-vp9 decodes), so the labels name no pixel format.
 */
export const LAYER_ENCODING = {
  prores: { ext: '.mov', codec: 'prores', profile: '4444', pix_fmt: 'yuva444p10le', label: 'Apple ProRes 4444 with alpha (prores_aw profile 4), straight alpha, start timecode' },
  webm: { ext: '.webm', codec: 'vp9', profile: 'Profile 0', pix_fmt: 'yuva420p', label: 'VP9 with alpha (libvpx-vp9 CRF 18), no timecode' },
} as const;

/** The screencast frames of a source (VFR, capture timestamps) and where their files are. */
export interface FrameSource {
  dir: string;
  frames: FrameIndexEntry[];
  ext: string;
  /** Captured JPEG (full-range BT.601) — converted to limited BT.709. */
  jpeg: boolean;
  /** Decoded from the CFR video (frames not kept by the run). */
  fromVideo: boolean;
}

/** The run's own frames of a source, or null when they were not kept (capture.keep_frames false) or are incomplete. */
export async function readFrameSource(runDir: string, src: RawSource): Promise<FrameSource | null> {
  const index = join(runDir, src.frames_index);
  const dir = join(runDir, src.frames_dir);
  if (!existsSync(index) || !existsSync(dir)) return null;
  const frames: FrameIndexEntry[] = [];
  for (const line of (await readFile(index, 'utf8')).split('\n')) {
    if (!line.trim()) continue;
    try {
      const f = JSON.parse(line) as FrameIndexEntry;
      if (typeof f.file === 'string' && typeof f.t === 'number') frames.push(f);
    } catch {
      /* a torn last line */
    }
  }
  if (frames.length === 0) return null;
  frames.sort((a, b) => a.t - b.t);
  const present = new Set(await readdir(dir));
  if (frames.some((f) => !present.has(f.file))) return null;
  const ext = extname(frames[0].file).slice(1) || 'jpg';
  return { dir, frames, ext, jpeg: ext === 'jpg' || ext === 'jpeg', fromVideo: false };
}

/** Fallback: decode the source's CFR video once (JPEG q 2), frame m stamped at m / fps. */
export async function decodeVideoFrames(runDir: string, src: RawSource, fps: number, tmp: string, ffmpeg: string, signal?: AbortSignal): Promise<FrameSource> {
  const video = join(runDir, src.video);
  if (!existsSync(video)) throw new EncodeError(`the run has neither its frames nor its video for ${src.track === 'main' ? 'the capture' : `page ${src.track}`} (${video})`);
  const dir = join(tmp, `decoded-${src.track}`);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  // The video's own matrix and range (capture.mp4 is tagged limited BT.709) → full-range BT.601 JPEG, i.e. what the
  // screencast writes: read back like capture frames.
  const vf = 'scale=out_color_matrix=bt601:out_range=pc,format=yuvj420p';
  await runFfmpeg(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-i', video, '-vf', vf, '-q:v', '2', '-start_number', '0', join(dir, '%06d.jpg')], signal);
  const files = (await readdir(dir)).filter((f) => f.endsWith('.jpg')).sort();
  return { dir, frames: files.map((file, m) => ({ file, t: m / fps })), ext: 'jpg', jpeg: true, fromVideo: true };
}

/** The source frame file shown on each clip frame (`schedule` = cfrSchedule of the source at the export rate). */
export function clipFrameFiles(clip: Pick<RawClipPlan, 'spans' | 'frames'>, schedule: readonly string[]): string[] {
  const out = new Array<string>(clip.frames);
  for (let k = 0; k < clip.frames; k++) out[k] = schedule[Math.min(schedule.length - 1, gridFrameOf(clip, k))];
  return out;
}

/** The export-grid schedule of a source (one file per frame n of round(duration · fps)). */
export function exportSchedule(source: FrameSource, duration: number, fps: number): string[] {
  return cfrSchedule(source.frames, duration, fps);
}

/** ffmpeg arguments of a clip encoded from a numbered frame sequence. */
export function clipArgs(opts: {
  seq: string;
  ext: string;
  jpeg: boolean;
  fps: number;
  frames: number;
  width: number;
  height: number;
  format: RawFormat;
  timecode: string;
  out: string;
  h264?: H264Encoder;
}): string[] {
  const enc = RAW_ENCODING[opts.format];
  const w = Math.max(2, Math.round(opts.width / 2) * 2);
  const h = opts.format === 'mp4' ? Math.max(2, Math.round(opts.height / 2) * 2) : opts.height;
  const range = opts.jpeg ? ':in_range=full:in_color_matrix=bt601' : '';
  const vf = `scale=${w}:${h}:flags=lanczos${range}:out_range=tv:out_color_matrix=bt709,format=${enc.pix_fmt}`;
  const tags = ['-color_range', 'tv', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709'];
  const codec =
    opts.format === 'mp4'
      ? [
          ...h264CodecArgs(opts.h264 ?? 'libx264', ['-c:v', 'libx264', '-profile:v', 'high', '-preset', RAW_ENCODING.mp4.preset, '-crf', String(RAW_ENCODING.mp4.crf)]),
          '-g',
          String(opts.fps),
          '-pix_fmt',
          'yuv420p',
          '-movflags',
          '+faststart',
        ]
      : ['-c:v', 'prores_ks', '-profile:v', '3', '-vendor', 'apl0', '-pix_fmt', 'yuv422p10le'];
  return [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-framerate',
    String(opts.fps),
    '-start_number',
    '0',
    '-i',
    join(opts.seq, `%06d.${opts.ext}`),
    '-vf',
    vf,
    ...codec,
    ...tags,
    '-timecode',
    opts.timecode,
    '-frames:v',
    String(opts.frames),
    '-an',
    opts.out,
  ];
}

/**
 * Encode a clip: link its frames into a numbered sequence under `tmp`, encode, remove the sequence. Returns the H.264
 * encoder used for an MP4 clip (libx264, or VideoToolbox with an ffmpeg without it), undefined for ProRes.
 */
export async function encodeClip(opts: {
  source: FrameSource;
  files: readonly string[];
  fps: number;
  width: number;
  height: number;
  format: RawFormat;
  timecode: string;
  out: string;
  tmp: string;
  ffmpeg?: string;
  /** What the work runs under (core WorkPolicy): which ffmpeg, under its agent policy. */
  policy: WorkPolicy;
  signal?: AbortSignal;
}): Promise<H264Encoder | undefined> {
  const seq = join(opts.tmp, 'seq');
  await materialize(opts.source.dir, opts.files, seq, opts.source.ext);
  try {
    const bin = ffmpegBin(opts.policy, opts.ffmpeg);
    const h264 = opts.format === 'mp4' ? await h264Encoder(bin) : undefined;
    await runFfmpeg(
      bin,
      clipArgs({
        seq,
        ext: opts.source.ext,
        jpeg: opts.source.jpeg,
        fps: opts.fps,
        frames: opts.files.length,
        width: opts.width,
        height: opts.height,
        format: opts.format,
        timecode: opts.timecode,
        out: opts.out,
        ...(h264 ? { h264 } : {}),
      }),
      opts.signal,
    );
    return h264;
  } finally {
    await rm(seq, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** One continuous file of clips of one size and codec (stream copy; each clip starts on a key frame), timecode 0. */
export async function concatClips(files: readonly string[], out: string, tmp: string, ffmpeg: string, signal?: AbortSignal): Promise<void> {
  const list = join(tmp, 'selects.txt');
  await writeFile(list, files.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join('\n') + '\n');
  const faststart = out.endsWith('.mp4') ? ['-movflags', '+faststart'] : [];
  await runFfmpeg(
    ffmpeg,
    ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-map', '0:v:0', '-c', 'copy', ...faststart, '-timecode', '00:00:00:00', '-an', out],
    signal,
  );
}

/** What ffprobe says about a video's picture stream (core's reader: clipProbeFromJson). */
export type ProbedVideo = ClipProbe;

/** ffprobe a clip (`count`: decode and count every frame instead of trusting the container). */
export async function probeVideo(file: string, opts: { ffprobe?: string; count?: boolean; policy: WorkPolicy }): Promise<ProbedVideo> {
  const r = await runMediaTool(ffprobeBin(opts.policy, opts.ffprobe), clipProbeArgs(file, opts.count === true), { maxBuffer: 4 * 1024 * 1024 });
  if (r.error) throw new EncodeError(`ffprobe failed on ${file}: ${r.stderr.trim() || r.error.message}`);
  let clip: ClipProbe | null;
  try {
    clip = clipProbeFromJson(readFfprobeJson(r.stdout), opts.count === true);
  } catch (e) {
    throw new EncodeError(`ffprobe output of ${file} unreadable: ${(e as Error).message}`);
  }
  if (!clip) throw new EncodeError(`${file} has no video stream`);
  return clip;
}
