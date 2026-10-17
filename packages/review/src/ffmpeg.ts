/**
 * Frame extraction with ffmpeg: ONE decoding pass per video for any set of frames (a `select` filter on the frame
 * numbers), streamed as raw RGB to a callback one frame at a time (back-pressure: the next frame is read once the
 * callback resolved). Frame numbers are exact for the CFR videos the renderer and the runner write.
 */
import { spawn } from 'node:child_process';
import { probeMedia } from '@demo-studio/editor';
import type { RgbImage } from './pixels.js';
import { ReviewError } from './load.js';

export interface VideoInfo {
  width: number;
  height: number;
  fps: number;
  duration_s: number;
  frames?: number;
}

export async function probeVideo(file: string): Promise<VideoInfo> {
  const p = await probeMedia(file);
  if (!p || !p.width || !p.height) throw new ReviewError(`cannot read the video ${file} (ffprobe failed: is ffmpeg installed and the file a video?)`);
  return { width: p.width, height: p.height, fps: p.fps, duration_s: p.duration_s, frames: p.frames };
}

export interface ExtractOptions {
  /** Decoded size (scaled with an area filter when it differs from the video's). */
  width: number;
  height: number;
  /** Size of the video (skip the scale filter when equal). */
  videoWidth: number;
  videoHeight: number;
  signal?: AbortSignal;
}

/**
 * The `select` expression true on `frames`: a balanced sum of `eq(n,f)` terms. ffmpeg 9 refuses expressions nested
 * more than 100 deep, and a flat `a+b+c…` nests one level per term; the balanced form nests log2(n) levels.
 */
export function selectExpr(frames: number[]): string {
  const terms = frames.map((f) => `eq(n\\,${f})`);
  if (terms.length === 0) return '0';
  const sum = (from: number, to: number): string => {
    if (to - from === 1) return terms[from];
    const mid = (from + to) >> 1;
    return `(${sum(from, mid)}+${sum(mid, to)})`;
  };
  return sum(0, terms.length);
}

/**
 * Decode `frames` (output frame numbers; sorted and de-duplicated here) of `file` in one ffmpeg pass and hand each
 * to `onFrame` in increasing order. Returns the frames delivered (fewer than asked when some lie past the end).
 */
export async function extractFrames(
  file: string,
  frames: number[],
  opts: ExtractOptions,
  onFrame: (frame: number, img: RgbImage) => Promise<void> | void,
): Promise<number[]> {
  const wanted = [...new Set(frames.filter((f) => Number.isInteger(f) && f >= 0))].sort((a, b) => a - b);
  if (wanted.length === 0) return [];
  const filters = [`select='${selectExpr(wanted)}'`];
  if (opts.width !== opts.videoWidth || opts.height !== opts.videoHeight) filters.push(`scale=${opts.width}:${opts.height}:flags=area`);
  const args = ['-v', 'error', '-nostdin', '-i', file, '-vf', filters.join(','), '-fps_mode', 'passthrough', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'];
  const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'], signal: opts.signal });
  let stderr = '';
  proc.stderr.on('data', (c: Buffer) => {
    if (stderr.length < 4000) stderr += c.toString();
  });
  const exited = new Promise<number | null>((resolve, reject) => {
    proc.on('error', reject);
    proc.on('close', (code) => resolve(code));
  });
  // Handled below once the output is read; a cancel (the signal) rejects it while frames are still being handled.
  exited.catch(() => undefined);
  const size = opts.width * opts.height * 3;
  const delivered: number[] = [];
  let buf = Buffer.allocUnsafe(size);
  let filled = 0;
  try {
    for await (const chunk of proc.stdout as AsyncIterable<Buffer>) {
      let off = 0;
      while (off < chunk.length) {
        const n = Math.min(size - filled, chunk.length - off);
        chunk.copy(buf, filled, off, off + n);
        filled += n;
        off += n;
        if (filled === size) {
          const frame = wanted[delivered.length];
          if (frame !== undefined) {
            delivered.push(frame);
            await onFrame(frame, { width: opts.width, height: opts.height, data: buf });
          }
          buf = Buffer.allocUnsafe(size);
          filled = 0;
        }
      }
    }
  } catch (e) {
    proc.kill('SIGKILL');
    throw e;
  }
  const code = await exited.catch((e: Error) => {
    if (opts.signal?.aborted) throw new ReviewError('frame extraction cancelled');
    throw new ReviewError(`ffmpeg could not be started (${e.message}): is ffmpeg on PATH?`);
  });
  if (code !== 0 && delivered.length === 0) throw new ReviewError(`ffmpeg failed on ${file}: ${stderr.trim().split('\n')[0] ?? `exit ${code}`}`);
  return delivered;
}
