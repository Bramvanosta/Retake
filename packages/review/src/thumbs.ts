/**
 * Small JPEG thumbnails of a run's pictures for the Studio's scenario screen (L4.2, critique B7) — the `./thumbs` entry
 * of this package: sharp and one ffmpeg process, nothing else. It never imports the editor (Remotion: the first import
 * of the package root costs ≈ 350 ms and ≈ 90 MB), never writes a file, never reads a path it was not given.
 *
 * - `thumbJpeg(bytes)`: an image in memory (a dry-run screenshot, a kept frame) → a JPEG fitting inside `maxPx`.
 * - `videoFramesAt(input, seconds[])`: one ffmpeg process for a batch — one input per time (`-ss t -i …`, an input
 *   seek: decodes from the keyframe before t, not from the start), each written as a PNG to its own pipe, so a time past
 *   the end gives `null` for that time and never shifts the others. The input is a path (file protocol only) or, as the
 *   Studio passes it, one open descriptor per time (`fd` protocol only: ffmpeg opens no path at all, review A #7).
 */
import type { Readable } from 'node:stream';
import sharp from 'sharp';
import { ffmpegBin, startMediaTool } from '@retake/core/io';
import type { WorkPolicy } from '@retake/core/policy';

/** Long side of a thumbnail, at most (240 CSS px on a 2× screen). */
export const THUMB_MAX_PX = 480;
/** JPEG quality of a thumbnail. */
export const THUMB_QUALITY = 75;
/** A source image larger than this many pixels is refused (a decompression bomb declares a huge size). */
export const THUMB_INPUT_PIXELS_MAX = 100_000_000;
/** One frame's PNG out of ffmpeg, at most (a 480 px PNG is ≈ 100–300 KB). */
const FRAME_PNG_MAX = 8 * 1024 * 1024;
/** Inputs of one ffmpeg process, at most. */
export const VIDEO_FRAMES_MAX = 32;

export interface Thumb {
  data: Buffer;
  width: number;
  height: number;
}

export interface ThumbOptions {
  maxPx?: number;
  quality?: number;
}

/** A JPEG fitting inside maxPx × maxPx (never enlarged) of an encoded image; throws on an unreadable or oversized one. */
export async function thumbJpeg(bytes: Buffer, o: ThumbOptions = {}): Promise<Thumb> {
  const max = o.maxPx ?? THUMB_MAX_PX;
  const { data, info } = await sharp(bytes, { limitInputPixels: THUMB_INPUT_PIXELS_MAX, failOn: 'error' })
    .rotate()
    .resize(max, max, { fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#ffffff' })
    .jpeg({ quality: o.quality ?? THUMB_QUALITY, mozjpeg: true })
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

export interface VideoFramesOptions {
  /** Long side of each frame, at most (scaled with an area filter, never enlarged). */
  maxPx?: number;
  signal?: AbortSignal;
  /** The process is killed after this long (default 10 s). */
  timeoutMs?: number;
  /** ffmpeg binary (default: core `ffmpegBin(policy)` — retake.yaml, $RETAKE_FFMPEG, the app's, PATH). */
  ffmpeg?: string;
  /** What the work runs under (core WorkPolicy): which ffmpeg and ffprobe, under its agent policy. */
  policy: WorkPolicy;
}

/** Collect a stream into one Buffer, refusing more than `max` bytes (the stream is then drained and dropped). */
function collect(stream: Readable, max: number): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const parts: Buffer[] = [];
    let size = 0;
    let over = false;
    stream.on('data', (c: Buffer) => {
      if (over) return;
      size += c.length;
      if (size > max) {
        over = true;
        parts.length = 0;
        return;
      }
      parts.push(c);
    });
    let ended = false;
    stream.on('error', () => resolve(null));
    stream.on('end', () => {
      ended = true;
      resolve(over || size === 0 ? null : Buffer.concat(parts));
    });
    // Closed before its end (destroyed): what it held is not a whole picture.
    stream.on('close', () => resolve(ended && !over && size > 0 ? Buffer.concat(parts) : null));
  });
}

/** A video as videoFramesAt reads it: a path, or one open descriptor (of the same file) per time asked. */
export type VideoInput = string | { fds: readonly number[] };

/**
 * The frames of an mp4 at `seconds` (input seeks: the first frame whose time is at or after each), as PNGs fitting inside
 * maxPx — `null` for a time that gives no frame. One ffmpeg process for all of them (≤ VIDEO_FRAMES_MAX); the video is
 * read as mp4 only (`-f mp4`), through the file protocol only (a path) or the fd protocol only (descriptors: the child's
 * fd 3, 4, … — never a path, never a playlist, never the network). Throws when ffmpeg cannot start or is cancelled /
 * timed out.
 */
export async function videoFramesAt(input: VideoInput, seconds: readonly number[], o: VideoFramesOptions): Promise<Array<Buffer | null>> {
  if (seconds.length === 0) return [];
  if (seconds.length > VIDEO_FRAMES_MAX) throw new Error(`at most ${VIDEO_FRAMES_MAX} frames per ffmpeg process (asked ${seconds.length})`);
  const fds = typeof input === 'string' ? null : input.fds;
  if (fds && fds.length !== seconds.length) throw new Error(`one descriptor per time (${fds.length} for ${seconds.length})`);
  const max = o.maxPx ?? THUMB_MAX_PX;
  const args = ['-v', 'error', '-nostdin'];
  seconds.forEach((s, i) => {
    const t = Number.isFinite(s) && s > 0 ? s : 0;
    if (fds) args.push('-protocol_whitelist', 'fd', '-f', 'mp4', '-fd', String(3 + i), '-ss', t.toFixed(6), '-i', 'fd:');
    else args.push('-protocol_whitelist', 'file', '-f', 'mp4', '-ss', t.toFixed(6), '-i', input as string);
  });
  // Outputs after the inputs' descriptors.
  const out0 = 3 + (fds ? fds.length : 0);
  const scale = `scale=w='min(${max},iw)':h='min(${max},ih)':force_original_aspect_ratio=decrease:flags=area`;
  seconds.forEach((_s, i) => {
    args.push('-map', `${i}:v:0`, '-frames:v', '1', '-vf', scale, '-f', 'image2pipe', '-c:v', 'png', `pipe:${out0 + i}`);
  });
  const stdio: Array<'ignore' | 'pipe' | number> = ['ignore', 'ignore', 'pipe', ...(fds ?? []), ...seconds.map(() => 'pipe' as const)];
  // `exit`, not `close`: a process killed while something it started still holds its pipes must not hold this call.
  const tool = startMediaTool(ffmpegBin(o.policy, o.ffmpeg), args, {
    stdio,
    ...(o.signal ? { signal: o.signal } : {}),
    cancelSignal: 'SIGKILL',
    timeoutMs: o.timeoutMs ?? 10_000,
    timeoutSignal: 'SIGKILL',
    stderr: { keep: 'head', max: 2000 },
    settle: 'exit',
  });
  const proc = tool.child;
  const outputs = seconds.map((_s, i) => {
    const out = proc.stdio[out0 + i] as Readable | null | undefined;
    return out ? collect(out, FRAME_PNG_MAX) : Promise.resolve(null);
  });
  const end = await tool.exited;
  if (end.error) throw new Error(`ffmpeg could not be started (${end.error.message}): is ffmpeg on PATH?`);
  const code = end.code;
  const killedWhy = end.killed === 'timeout' ? 'timed out' : end.killed;
  const drop = () => {
    for (const s of proc.stdio) s?.destroy();
  };
  if (killedWhy) {
    drop();
    throw new Error(`ffmpeg ${killedWhy}`);
  }
  // The pipes end right after a normal exit; whatever has not ended 2 s later is dropped (that frame: null).
  const grace = setTimeout(drop, 2000);
  const frames = await Promise.all(outputs);
  clearTimeout(grace);
  if (code !== 0 && frames.every((f) => f === null)) throw new Error(`ffmpeg failed: ${tool.stderr.trim().split('\n')[0] || `exit ${code}`}`);
  return frames;
}
