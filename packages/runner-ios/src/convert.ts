/**
 * From the simulator's recording to capture.mp4. The recording (`.ios/capture.mov`) is variable-rate — a frame only
 * when the screen changes, none while it is idle, nothing held at its end — and tagged with the sRGB transfer. Its
 * frames' times come from ffprobe (packet times, sorted, less the first), then moved onto the capture clock (the start
 * stamp's lateness, onCaptureClock); its decode times are ignored (`-fflags
 * +igndts`: they lag behind and repeat, and ffmpeg would time frames by them). One ffmpeg pass makes the take's video: a
 * black base at the capture's rate and size held to the end of the take, the recording over it (its times from 0, read
 * as BT.709 TV range: the values as the simulator showed them), the touch overlay (overlay.ts) over that, encoded H.264
 * (core h264CodecArgs) tagged BT.709 TV range, round(endT · fps) frames. The recording must have the device's size.
 * The touch-down search reads small grey crops of the recording around each touch (touch-track.ts).
 */
import { ffmpegBin, ffprobeBin, h264CodecArgs, h264Encoder, runMediaTool, stderrLines } from '@retake/core/io';
import type { WorkPolicy } from '@retake/core/policy';
import type { CropFrame } from './touch-track.js';
import { TOUCH_DETECT } from './touch-track.js';

/** What ffprobe says of the recording. */
export interface MovProbe {
  width: number;
  height: number;
  /** Frame times (s), sorted: from the first frame (0), or on the capture clock once shifted (onCaptureClock). */
  frameTimes: number[];
  /** The first packet's time in the file (s). */
  first: number;
  /** How far the recording runs ahead of the capture clock (s): a frame at file time first + v is at capture time v − shift. */
  shift: number;
}

/**
 * The recording's frame times on the capture clock: its first frame `lateness` seconds before capture time 0 (the
 * start stamp's lateness, record-video.ts). The one place the shift is applied to times; the crops and the conversion
 * read the file at first + t + shift. Pure.
 */
export function onCaptureClock(probe: MovProbe, lateness: number): MovProbe {
  const shift = probe.shift + lateness;
  return { ...probe, shift, frameTimes: probe.frameTimes.map((t) => Math.round((t - lateness) * 1e6) / 1e6) };
}

/**
 * Frame times from capture time 0 (the frames before it, filmed before the take began, become one frame at 0). Pure.
 */
export function fromCaptureStart(frameTimes: readonly number[]): number[] {
  const after = frameTimes.filter((t) => t > 0);
  return frameTimes.length > after.length ? [0, ...after] : after;
}

/** Packet times (one per line) and the stream's size (`width,height`) of ffprobe's csv output. Pure. */
export function parseProbe(packets: string, stream: string): MovProbe {
  const times = packets
    .split('\n')
    .map((l) => Number.parseFloat(l.split(',')[0]))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);
  const [w, h] = stream.trim().split('\n')[0]?.split(',').map(Number) ?? [];
  const first = times[0] ?? 0;
  return { width: w || 0, height: h || 0, frameTimes: times.map((t) => Math.round((t - first) * 1e6) / 1e6), first, shift: 0 };
}

/** The recording's size and frame times. */
export async function probeMov(policy: WorkPolicy, mov: string, signal?: AbortSignal): Promise<MovProbe> {
  const bin = ffprobeBin(policy);
  const o = { timeoutMs: 120_000, maxBuffer: 64 * 1024 * 1024, ...(signal ? { signal } : {}) };
  const packets = await runMediaTool(bin, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time', '-of', 'csv=p=0', mov], o);
  if (packets.error) throw new Error(`ffprobe could not read the recording: ${stderrLines(packets.stderr, 3) || packets.error.message}`);
  const stream = await runMediaTool(bin, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', mov], o);
  if (stream.error) throw new Error(`ffprobe could not read the recording: ${stderrLines(stream.stderr, 3) || stream.error.message}`);
  return parseProbe(packets.stdout, stream.stdout);
}

export interface ConvertArgs {
  mov: string;
  /** The overlay's ffconcat list. */
  list: string;
  out: string;
  endT: number;
  fps: number;
  /** The device's pixels. */
  width: number;
  height: number;
  /** The encoder's arguments (core h264CodecArgs). */
  codec: string[];
  /** The recording's lead on the capture clock (MovProbe.shift, s): its frames are moved this much earlier. */
  shift?: number;
}

/** The number of frames of a take of `endT` seconds at `fps`. Pure. */
export function takeFrames(endT: number, fps: number): number {
  return Math.max(1, Math.round(endT * fps));
}

/** ffmpeg's arguments of the conversion. Pure. */
export function convertArgs(a: ConvertArgs): string[] {
  const even = (n: number) => Math.round(n / 2) * 2;
  const w = even(a.width);
  const h = even(a.height);
  const graph = [
    `color=c=black:s=${w}x${h}:r=${a.fps}:d=${a.endT.toFixed(3)},format=yuv420p[base]`,
    `[0:v]setpts=PTS-STARTPTS${a.shift ? `-${a.shift.toFixed(4)}/TB` : ''},scale=${w}:${h}:in_range=tv:out_range=tv:in_color_matrix=bt709:out_color_matrix=bt709,format=yuv420p[screen]`,
    '[base][screen]overlay=eof_action=repeat:format=yuv420[filmed]',
    `[1:v]format=rgba,scale=${w}:${h}:out_range=tv:out_color_matrix=bt709,format=yuva420p[touches]`,
    // The colour tags on the frames themselves: the -color_* options of an encode alone are dropped by newer ffmpegs.
    '[filmed][touches]overlay=eof_action=repeat:format=yuv420,format=yuv420p,setparams=range=tv:color_primaries=bt709:color_trc=bt709:colorspace=bt709[out]',
  ].join(';');
  return [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    // The recording's decode times are unusable (squeezed, and its repeated times make ffmpeg trust them over the
    // presentation times): ignored, every frame is timed by its own presentation time.
    '-fflags',
    '+igndts',
    '-i',
    a.mov,
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    a.list,
    '-filter_complex',
    graph,
    '-map',
    '[out]',
    ...a.codec,
    '-r',
    String(a.fps),
    '-color_range',
    'tv',
    '-colorspace',
    'bt709',
    '-color_primaries',
    'bt709',
    '-color_trc',
    'bt709',
    '-frames:v',
    String(takeFrames(a.endT, a.fps)),
    '-movflags',
    '+faststart',
    '-an',
    a.out,
  ];
}

/** Encode capture.mp4 (convertArgs) with the work's ffmpeg. */
export async function convertTake(policy: WorkPolicy, a: Omit<ConvertArgs, 'codec'> & { crf: number; signal?: AbortSignal }): Promise<void> {
  const bin = ffmpegBin(policy);
  const codec = h264CodecArgs(await h264Encoder(bin), ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(a.crf)]);
  const r = await runMediaTool(bin, convertArgs({ ...a, codec }), { timeoutMs: 30 * 60_000, ...(a.signal ? { signal: a.signal } : {}) });
  if (r.error) throw new Error(`the conversion of the recording failed: ${stderrLines(r.stderr, 4) || r.error.message}`);
}

/** The box (device pixels) around a touch point, inside the picture. Pure. */
export function touchBox(x: number, y: number, scale: number, size: { width: number; height: number }): { x: number; y: number; w: number; h: number } {
  const side = Math.round(TOUCH_DETECT.boxPt * scale);
  const half = side / 2;
  const cx = Math.min(Math.max(x * scale, half), size.width - half);
  const cy = Math.min(Math.max(y * scale, half), size.height - half);
  return { x: Math.round(cx - half), y: Math.round(cy - half), w: side, h: side };
}

/**
 * The grey crops around a touch point of the recording's frames timed `times` (seconds from 0, sorted, all inside
 * one window): decoded as they are (no frame made or dropped), scaled to TOUCH_DETECT.decodeScale pixels per point.
 * Null when the decode gives another number of frames than asked (the caller falls back).
 */
export async function readCrops(
  policy: WorkPolicy,
  o: { mov: string; first: number; shift?: number; times: readonly number[]; box: { x: number; y: number; w: number; h: number }; scale: number; signal?: AbortSignal },
): Promise<CropFrame[] | null> {
  if (!o.times.length) return [];
  const side = Math.max(4, Math.round((o.box.w / o.scale) * TOUCH_DETECT.decodeScale));
  const at = o.first + (o.shift ?? 0);
  const from = at + o.times[0] - 0.0005;
  const to = at + o.times[o.times.length - 1] + 0.0005;
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    // A seek near the window (fast), but its frames picked by their own times: the input's -ss / -to trim by times
    // this recording's decode times (ignored, negative at its start) make wrong — a window at its first frame read
    // the whole file, one ending at a frame lost it.
    '-ss',
    Math.max(0, from).toFixed(4),
    '-copyts',
    '-fflags',
    '+igndts',
    '-i',
    o.mov,
    '-vf',
    `select=between(t\\,${from.toFixed(4)}\\,${to.toFixed(4)}),crop=${o.box.w}:${o.box.h}:${o.box.x}:${o.box.y},scale=${side}:${side}:flags=area,format=gray`,
    '-fps_mode',
    'passthrough',
    '-frames:v',
    String(o.times.length),
    '-f',
    'rawvideo',
    'pipe:1',
  ];
  const r = await runMediaTool(ffmpegBin(policy), args, { encoding: 'buffer', timeoutMs: 60_000, maxBuffer: 64 * 1024 * 1024, ...(o.signal ? { signal: o.signal } : {}) });
  if (r.error) return null;
  const size = side * side;
  if (r.stdout.length !== size * o.times.length) return null;
  return o.times.map((t, i) => ({ t, pixels: new Uint8Array(r.stdout.subarray(i * size, (i + 1) * size)) }));
}
