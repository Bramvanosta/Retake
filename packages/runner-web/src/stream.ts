/**
 * capture.mp4 encoded during the take (L5.7, R-FLD-21): the screencast frames are piped to ffmpeg on the CFR schedule as
 * they come, so a take ends without a long encode and writes no frame to disk (unless `capture.keep_frames`). The
 * schedule is the one `cfrSchedule` computes after the fact (encode.ts): output frame n shows the latest captured frame
 * stamped at or before n / fps; the first captured frame also covers the time before it; the last one holds until the
 * end. Ticks are emitted only once nothing earlier can still arrive: a frame reaches node ≈ 20–60 ms after its paint, so
 * the stream lags STREAM_LAG_S behind the capture clock — and a page load the recorder holds (R-ISS-08, frames released
 * later with their own paint time) stops the ticks at the hold's start until it ends.
 */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { H264_VIDEOTOOLBOX_QUALITY, ffmpegBin, ffmpegEncoders } from '@retake/core';
import type { CaptureEncoder } from '@retake/core';
import { EncodeError } from './errors.js';

/** How far behind the capture clock the encoder's ticks stay (s): later frames are counted `late`. */
export const STREAM_LAG_S = 0.5;
/** How often the encoder's ticks catch up with the capture clock (ms). */
export const STREAM_TICK_MS = 100;
/** A frame stamped this close after an output tick still counts for that tick (as in cfrSchedule). */
const TICK_EPS_S = 0.0005;

/** One captured frame for the stream: capture time (s) and its encoded bytes (JPEG or PNG). */
export interface StreamFrame {
  t: number;
  data: Buffer;
}

/**
 * The CFR schedule, computed as frames arrive (pure). `push` frames in any order (they are kept sorted until their tick
 * passed), `advance(h)` emits every tick whose time is at most `h`, `finish(endT)` the rest up to round(endT · fps).
 */
export class CfrStream<F extends { t: number }> {
  /** Next output frame index. */
  next = 0;
  /** Frames that arrived after the tick they belong to had been emitted (they show from the next tick). */
  late = 0;
  private cur: F | null = null;
  private pending: F[] = [];
  private done = false;

  constructor(
    private readonly fps: number,
    private readonly emit: (n: number, f: F) => void,
  ) {
    if (!(fps > 0)) throw new EncodeError(`invalid frame rate ${fps}`);
  }

  private tickTime(n: number): number {
    return n / this.fps + TICK_EPS_S;
  }

  /** At least one frame came. */
  get started(): boolean {
    return this.cur !== null || this.pending.length > 0;
  }

  push(f: F): void {
    if (this.done) return;
    if (this.next > 0 && this.cur && f.t <= this.tickTime(this.next - 1)) {
      // Its tick is gone: it shows from the next one, unless a later frame already does.
      this.late++;
      if (f.t >= this.cur.t) this.cur = f;
      return;
    }
    // Sorted insert (frames come in order nearly always: a scan from the end).
    let i = this.pending.length;
    while (i > 0 && this.pending[i - 1].t > f.t) i--;
    this.pending.splice(i, 0, f);
  }

  /** Emit the ticks whose time is at most `horizon` (capture seconds), up to `limit` ticks in all. */
  advance(horizon: number, limit = Infinity): void {
    if (this.done) return;
    for (;;) {
      if (this.next >= limit) return;
      const t = this.tickTime(this.next);
      if (t > horizon + TICK_EPS_S) return;
      // The first captured frame also covers the time before it.
      if (!this.cur) {
        if (!this.pending.length) return;
        this.cur = this.pending.shift()!;
      }
      while (this.pending.length && this.pending[0].t <= t) this.cur = this.pending.shift()!;
      this.emit(this.next, this.cur);
      this.next++;
    }
  }

  /** Emit every tick up to round(endT · fps) (at least one); frames after endT are left out. Returns the tick count. */
  finish(endT: number): number {
    const count = Math.max(1, Math.round(endT * this.fps));
    this.pending = this.pending.filter((f) => f.t <= endT);
    if (!this.cur && !this.pending.length) throw new EncodeError('no frames were captured before the end of the recording');
    this.advance(Infinity, count);
    this.done = true;
    return count;
  }
}

export interface StreamEncoderOptions {
  out: string;
  fps: number;
  /** Output size in pixels (rounded to even). */
  width: number;
  height: number;
  /** Frames are JPEG (full-range BT.601 → limited-range BT.709) or PNG. */
  format: 'jpeg' | 'png';
  encoder: Exclude<CaptureEncoder, 'auto'>;
  /** libx264 CRF. */
  crf: number;
  ffmpeg?: string;
  /** The tick horizon (capture seconds), read every STREAM_TICK_MS: the capture clock less STREAM_LAG_S, a held load's start. */
  horizon: () => number;
  /**
   * Activity of every output frame (L5.7, R-FLD-23/26): ffmpeg also writes a 96×54 grey copy of each output frame to
   * its stdout, handed here in order.
   */
  onThumb?: (n: number, gray: Buffer) => void;
}

/** VideoToolbox's constant quality for capture.mp4: SSIM 0.9985 vs the screencast frames (libx264 medium CRF 16: 0.9989). */
export const VIDEOTOOLBOX_QUALITY = H264_VIDEOTOOLBOX_QUALITY;
/** Thumbnail size of `onThumb` (16 × 9 cells of 6 × 6 pixels). */
export const THUMB_W = 96;
export const THUMB_H = 54;

/** What the encoder writes with (codec and its quality setting), for run.json `perf.encode`. */
export function encoderLabel(o: Pick<StreamEncoderOptions, 'encoder' | 'crf'>): { codec: string; quality: string } {
  return o.encoder === 'videotoolbox' ? { codec: 'h264_videotoolbox', quality: `q:v ${VIDEOTOOLBOX_QUALITY}` } : { codec: 'libx264 veryfast', quality: `crf ${o.crf}` };
}

/** ffmpeg arguments of a stream encoder (exported for tests). */
export function streamArgs(o: Omit<StreamEncoderOptions, 'horizon' | 'onThumb'> & { thumbs: boolean }): string[] {
  const size = `${Math.round(o.width / 2) * 2}:${Math.round(o.height / 2) * 2}`;
  const range = o.format === 'jpeg' ? ':in_range=full:in_color_matrix=bt601' : '';
  const main = `scale=${size}:flags=lanczos${range}:out_range=tv:out_color_matrix=bt709,format=yuv420p`;
  const codec =
    o.encoder === 'videotoolbox'
      ? ['-c:v', 'h264_videotoolbox', '-q:v', String(VIDEOTOOLBOX_QUALITY), '-profile:v', 'high']
      : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(o.crf)];
  const graph = o.thumbs ? `[0:v]split=2[m][s];[m]${main}[v];[s]scale=${THUMB_W}:${THUMB_H}:flags=area,format=gray[g]` : `[0:v]${main}[v]`;
  return [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'image2pipe', '-c:v', o.format === 'png' ? 'png' : 'mjpeg', '-framerate', String(o.fps), '-i', 'pipe:0',
    '-filter_complex', graph,
    '-map', '[v]', ...codec,
    '-color_range', 'tv', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
    '-movflags', '+faststart', '-an', o.out,
    ...(o.thumbs ? ['-map', '[g]', '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1'] : []),
  ];
}

const encoderChecks = new Map<string, Promise<boolean>>();

/**
 * Can this ffmpeg encode with VideoToolbox here? A one-frame encode, checked once per binary (a Mac without the
 * hardware encoder, or an ffmpeg built without it, falls back to libx264).
 */
export function videotoolboxWorks(ffmpeg: string = ffmpegBin()): Promise<boolean> {
  let p = encoderChecks.get(ffmpeg);
  if (!p) {
    p = new Promise<boolean>((resolve) => {
      if (process.platform !== 'darwin') return resolve(false);
      const child = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=256x144:r=30', '-frames:v', '2', '-c:v', 'h264_videotoolbox', '-f', 'null', '-'], {
        stdio: 'ignore',
      });
      const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
      child.on('error', () => resolve(false));
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve(code === 0);
      });
    });
    encoderChecks.set(ffmpeg, p);
  }
  return p;
}

/**
 * The encoder `capture.encoder` names (auto: VideoToolbox when it works here, else libx264). An ffmpeg without
 * libx264 (L5.16: a foreign build, the system's when the app carries none) never gets libx264: VideoToolbox when it
 * works, else an error naming that ffmpeg.
 */
export async function resolveEncoder(want: CaptureEncoder | undefined, ffmpeg?: string): Promise<Exclude<CaptureEncoder, 'auto'>> {
  const bin = ffmpegBin(ffmpeg);
  const list = await ffmpegEncoders(bin);
  const noX264 = list !== null && !list.has('libx264');
  if (want === 'libx264' && !noX264) return 'libx264';
  if (await videotoolboxWorks(bin)) return 'videotoolbox';
  if (noX264) throw new EncodeError(`${bin} has no libx264 and cannot encode with VideoToolbox here: use an ffmpeg built with libx264 (retake.yaml "ffmpeg", or $RETAKE_FFMPEG)`);
  return 'libx264';
}

/**
 * ffmpeg fed during the take (see the module comment). `push` every frame the recorder keeps; `finish(endT)` writes the
 * remaining ticks and waits for ffmpeg; `abort()` stops it and removes the file. Never throws from `push`: an encoder
 * that died is reported by `finish`.
 */
export class StreamEncoder {
  private readonly stream: CfrStream<StreamFrame>;
  private child: ChildProcess | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private exited: Promise<number | null> | null = null;
  private stderr = '';
  private failed: string | null = null;
  private thumbBuf: Buffer = Buffer.alloc(0);
  private thumbs = 0;
  /** Bytes waiting in the pipe at most (ffmpeg slower than the take). */
  backlogMax = 0;
  /** ms between the end of the take and the end of the encode. */
  finishMs = 0;
  /** Output frames the timer may write at most (set by `endAt`: never past the end of the take). */
  private limit = Infinity;

  constructor(private readonly opts: StreamEncoderOptions) {
    this.stream = new CfrStream<StreamFrame>(opts.fps, (_n, f) => this.write(f.data));
  }

  get pid(): number | undefined {
    return this.child?.pid ?? undefined;
  }

  get late(): number {
    return this.stream.late;
  }

  /** Output frames written so far. */
  get written(): number {
    return this.stream.next;
  }

  start(): void {
    if (this.child) return;
    const args = streamArgs({ ...this.opts, thumbs: this.opts.onThumb !== undefined });
    const child = spawn(ffmpegBin(this.opts.ffmpeg), args, { stdio: ['pipe', this.opts.onThumb ? 'pipe' : 'ignore', 'pipe'] });
    this.child = child;
    child.stderr?.on('data', (d: Buffer) => {
      this.stderr = (this.stderr + d.toString()).slice(-4000);
    });
    child.stdout?.on('data', (d: Buffer) => this.thumbData(d));
    child.stdin?.on('error', (e: NodeJS.ErrnoException) => {
      this.failed ??= e.code === 'EPIPE' ? 'ffmpeg stopped reading the frames' : e.message;
    });
    this.exited = new Promise((resolve) => {
      child.on('error', (e: NodeJS.ErrnoException) => {
        this.failed ??= e.code === 'ENOENT' ? `${ffmpegBin(this.opts.ffmpeg)} not found: install ffmpeg or set "ffmpeg" in retake.yaml` : e.message;
        resolve(null);
      });
      child.on('close', (code) => resolve(code));
    });
    this.timer = setInterval(() => {
      try {
        this.stream.advance(this.opts.horizon(), this.limit);
      } catch {
        /* never break a take */
      }
    }, STREAM_TICK_MS);
  }

  private thumbData(d: Buffer): void {
    const size = THUMB_W * THUMB_H;
    this.thumbBuf = this.thumbBuf.length ? Buffer.concat([this.thumbBuf, d]) : d;
    while (this.thumbBuf.length >= size) {
      const frame = Buffer.from(this.thumbBuf.subarray(0, size));
      this.thumbBuf = this.thumbBuf.subarray(size);
      try {
        this.opts.onThumb?.(this.thumbs++, frame);
      } catch {
        /* an analysis error never breaks the encode */
      }
    }
  }

  private write(data: Buffer): void {
    const stdin = this.child?.stdin;
    if (!stdin || this.failed || stdin.destroyed) return;
    stdin.write(data);
    this.backlogMax = Math.max(this.backlogMax, stdin.writableLength);
  }

  push(f: StreamFrame): void {
    this.stream.push(f);
  }

  /** The take ends at capture time `endT`: no tick past it (the rest is written by `finish`). */
  endAt(endT: number): void {
    this.limit = Math.max(1, Math.round(endT * this.opts.fps));
  }

  /** Write the ticks left up to round(endT · fps), close the pipe and wait for ffmpeg. */
  async finish(endT: number): Promise<{ frames: number }> {
    const t0 = Date.now();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    let count: number;
    try {
      count = this.stream.finish(endT);
    } catch (e) {
      await this.abort();
      throw e;
    }
    this.child?.stdin?.end();
    const code = await this.exited;
    this.finishMs = Date.now() - t0;
    if (this.failed || code !== 0) {
      const why = this.failed ?? `exited with code ${code}`;
      await rm(this.opts.out, { force: true }).catch(() => undefined);
      throw new EncodeError(`${ffmpegBin(this.opts.ffmpeg)} ${why}: ${this.stderr.trim().split('\n').slice(-6).join(' | ')}`.trim());
    }
    return { frames: count };
  }

  /** Stop the encoder and remove its file (a cancelled or discarded take). */
  async abort(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const child = this.child;
    if (child && child.exitCode === null) {
      child.stdin?.destroy();
      child.kill('SIGKILL');
      await this.exited;
    }
    await rm(this.opts.out, { force: true }).catch(() => undefined);
  }
}
