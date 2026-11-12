import { copyFile, link, mkdir, rm } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { ffmpegBin, h264CodecArgs, h264Encoder, startMediaTool, stderrLines } from '@retake/core/io';
import type { WorkPolicy } from '@retake/core/policy';
import { EncodeError } from './errors.js';
import type { FrameIndexEntry } from './recorder.js';

export interface EncodeOptions {
  fps: number;
  crf: number;
  /** Capture time (s) the video ends at: the last frame holds until then. */
  endT: number;
  /** Output size in pixels (default: the frames' own size). */
  width?: number;
  height?: number;
  /** ffmpeg binary (default: core `ffmpegBin(policy)` — retake.yaml, $RETAKE_FFMPEG, the app's, PATH). */
  ffmpeg?: string;
  /** What the work runs under (core WorkPolicy): which ffmpeg, under its agent policy. */
  policy: WorkPolicy;
  preset?: string;
  /** Frames are JPEG (full-range BT.601) → convert to limited-range BT.709 for HD players. */
  jpeg?: boolean;
  signal?: AbortSignal;
}

/** A frame stamped this close after an output tick still counts for that tick (timestamp rounding). */
const TICK_EPS_S = 0.0005;

/**
 * CFR schedule of a VFR frame sequence: for each output frame n (capture time n / fps), the captured frame on
 * screen at that time — the latest one stamped at or before it. The first captured frame also covers the time
 * before it, the last one holds until `endT`. Returns round(endT · fps) file names (at least one).
 */
export function cfrSchedule(index: readonly FrameIndexEntry[], endT: number, fps: number): string[] {
  if (!(fps > 0)) throw new EncodeError(`invalid frame rate ${fps}`);
  const frames = [...index].filter((f) => f.t <= endT).sort((a, b) => a.t - b.t);
  if (!frames.length) throw new EncodeError('no frames were captured before the end of the recording');
  const count = Math.max(1, Math.round(endT * fps));
  const out = new Array<string>(count);
  let j = 0;
  for (let n = 0; n < count; n++) {
    const t = n / fps + TICK_EPS_S;
    while (j + 1 < frames.length && frames[j + 1].t <= t) j++;
    out[n] = frames[j].file;
  }
  return out;
}

/** Link (or copy, across devices) every scheduled frame to <dir>/<n>.<ext> so ffmpeg reads a plain CFR sequence. */
export async function materialize(framesDir: string, schedule: readonly string[], dir: string, ext: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const BATCH = 64;
  for (let i = 0; i < schedule.length; i += BATCH) {
    await Promise.all(
      schedule.slice(i, i + BATCH).map(async (file, k) => {
        const src = join(framesDir, file);
        const dst = join(dir, `${String(i + k).padStart(6, '0')}.${ext}`);
        try {
          await link(src, dst);
        } catch {
          await copyFile(src, dst);
        }
      }),
    );
  }
}

export function runFfmpeg(bin: string, args: string[], signal?: AbortSignal): Promise<void> {
  return run(bin, args, signal);
}

async function run(bin: string, args: string[], signal?: AbortSignal): Promise<void> {
  const tool = startMediaTool(bin, args, { stdio: ['ignore', 'ignore', 'pipe'], ...(signal ? { signal, abortedAtStart: 'run' as const } : {}), stderr: { keep: 'tail', max: 4000 } });
  const end = await tool.exited;
  if (end.error) throw new EncodeError(end.error.code === 'ENOENT' ? `${bin} not found: install ffmpeg or set "ffmpeg" in retake.yaml` : end.error.message);
  if (end.code !== 0) throw new EncodeError(`${bin} exited with code ${end.code}: ${stderrLines(tool.stderr, 6)}`);
}

/**
 * Encode captured frames (VFR, real timestamps) to a CFR H.264 mp4 of round(endT · fps) frames. The VFR → CFR
 * choice is made here (cfrSchedule), so ffmpeg only encodes: exact to the millisecond, whatever the frame sizes.
 */
export async function encodeFrames(framesDir: string, index: FrameIndexEntry[], out: string, opts: EncodeOptions): Promise<void> {
  const schedule = cfrSchedule(index, opts.endT, opts.fps);
  const ext = extname(schedule[0]).slice(1) || 'jpg';
  const seqDir = join(framesDir, '.cfr');
  await materialize(framesDir, schedule, seqDir, ext);
  const size = opts.width && opts.height ? `${Math.round(opts.width / 2) * 2}:${Math.round(opts.height / 2) * 2}` : 'trunc(iw/2)*2:trunc(ih/2)*2';
  const range = opts.jpeg === false ? '' : ':in_range=full:in_color_matrix=bt601';
  const filters = [`scale=${size}:flags=lanczos${range}:out_range=tv:out_color_matrix=bt709`, 'format=yuv420p'];
  const bin = ffmpegBin(opts.policy, opts.ffmpeg);
  const codec = h264CodecArgs(await h264Encoder(bin), ['-c:v', 'libx264', '-preset', opts.preset ?? 'medium', '-crf', String(opts.crf)]);
  const args = [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-framerate', String(opts.fps), '-start_number', '0', '-i', join(seqDir, `%06d.${ext}`),
    '-vf', filters.join(','),
    ...codec,
    '-color_range', 'tv', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
    '-frames:v', String(schedule.length),
    '-movflags', '+faststart', '-an',
    out,
  ];
  try {
    await run(bin, args, opts.signal);
  } finally {
    await rm(seqDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
