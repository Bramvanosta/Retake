/**
 * The one reader of ffprobe's answers (L7.31, finding X3; the summary since L6.8 / L6.10). Pure: the arguments of the
 * probes and what each answer says; the probes are run through `@retake/core/io` media-run.ts.
 *
 * - the summary of a media file (`ffprobeSummaryArgs` / `parseFfprobeSummary`): its first video stream's size, frame
 *   rate and frame count, its audio streams, the codecs and the file's length — the render's record and the review;
 * - a user's video file (`videoProbeFromJson`): container, codec, size, length, sound, alpha — the checks and the plan;
 * - a raw export's clip (`clipProbeFromJson`): codec, pixel format, frames, timecode, alpha, size on disk;
 * - an open render video (`openVideoFromJson`): frame rates, first frame's time, frames — the Studio's frame server;
 * - a picture's size (`pictureSizeArgs` / `pictureSizeFromJson`) and a take's packets (`ffprobePackets`).
 *
 * Every answer is JSON (`-of json`), read by `readFfprobeJson`.
 */
import { MediaProbeError } from './media.js';
import type { VideoProbe } from './media.js';

/** ffprobe's JSON answer as a value (JSON.parse: a text that is no JSON throws its SyntaxError). */
export function readFfprobeJson(text: string): unknown {
  return JSON.parse(text);
}

/** A `num/den` rate rounded to 3 decimals; 0 when it has no denominator (the summary's and the open video's). */
function roundedRate(v: unknown): number {
  const [num, den] = String(v ?? '0/1')
    .split('/')
    .map(Number);
  return den ? Math.round((num / den) * 1000) / 1000 : 0;
}

/** A `num/den` rate as a number; a lone number as itself; 0 when it is not text (a user's video). */
function ratio(v: unknown): number {
  if (typeof v !== 'string') return 0;
  const [a, b] = v.split('/').map(Number);
  return b ? a / b : Number(a) || 0;
}

/** What ffprobe says of a media file (`ffprobeSummaryArgs`). */
export interface FfprobeSummary {
  duration_s: number;
  frames?: number;
  width: number;
  height: number;
  /** The video stream's `r_frame_rate`, to 3 decimals (0 when it has none). */
  fps: number;
  audio_streams: number;
  video_codec?: string;
  audio_codec?: string;
}

/** ffprobe's arguments for the summary of `file`, as JSON on stdout. */
export function ffprobeSummaryArgs(file: string): string[] {
  return ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height,r_frame_rate,nb_frames:format=duration', '-of', 'json', file];
}

/** The summary in ffprobe's answer to `ffprobeSummaryArgs`; undefined when it is not JSON of that shape. */
export function parseFfprobeSummary(stdout: string): FfprobeSummary | undefined {
  try {
    const j = readFfprobeJson(stdout) as { streams: Array<Record<string, string | number>>; format: { duration?: string } };
    const v = j.streams.find((s) => s.codec_type === 'video');
    const a = j.streams.filter((s) => s.codec_type === 'audio');
    const out: FfprobeSummary = {
      duration_s: Number(j.format.duration ?? 0),
      width: Number(v?.width ?? 0),
      height: Number(v?.height ?? 0),
      fps: roundedRate(v?.r_frame_rate),
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

/** ffprobe's arguments for a user's video file (`videoProbeFromJson`): every stream and the format. */
export function videoFileArgs(file: string): string[] {
  return ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file];
}

/** Interpret ffprobe's JSON (`-show_streams -show_format`) — pure, exported for tests. */
export function videoProbeFromJson(json: unknown): VideoProbe {
  const j = json as { streams?: Array<Record<string, unknown>>; format?: Record<string, unknown> };
  const streams = j.streams ?? [];
  const v = streams.find((s) => s.codec_type === 'video' && !(s.disposition as Record<string, number> | undefined)?.attached_pic);
  if (!v) throw new MediaProbeError('the file has no video stream', 'no-video');
  const tags = (v.tags ?? {}) as Record<string, string>;
  const codec = String(v.codec_name ?? '');
  const pix = typeof v.pix_fmt === 'string' ? v.pix_fmt : undefined;
  const profile = typeof v.profile === 'string' ? v.profile : undefined;
  const alphaTag = Object.entries(tags).some(([k, x]) => k.toLowerCase() === 'alpha_mode' && String(x) === '1');
  const alpha = alphaTag || (pix !== undefined && /^(yuva|rgba|bgra|argb|abgr|gbrap|ya)/.test(pix));
  const duration = Number(v.duration ?? j.format?.duration ?? 0);
  const out: VideoProbe = {
    container: String(j.format?.format_name ?? ''),
    codec,
    width: Number(v.width ?? 0),
    height: Number(v.height ?? 0),
    duration_s: Number.isFinite(duration) ? Math.round(duration * 1000) / 1000 : 0,
    fps: Math.round((ratio(v.avg_frame_rate) || ratio(v.r_frame_rate)) * 1000) / 1000,
    audio: streams.some((s) => s.codec_type === 'audio'),
    alpha,
  };
  if (profile) out.profile = profile;
  if (pix) out.pix_fmt = pix;
  return out;
}

/** What ffprobe says about a clip's picture stream (a raw export's; `clipProbeArgs`). */
export interface ClipProbe {
  codec: string;
  profile?: string;
  pix_fmt: string;
  width: number;
  height: number;
  /** r_frame_rate as a number. */
  fps: number;
  /** Frames (the container's count; `count: true` decodes them all). */
  frames: number;
  duration_s: number;
  timecode?: string;
  /** An alpha channel: a yuva / rgba pixel format, or VP9's side-channel alpha (`alpha_mode` 1, decoded as yuv420p). */
  alpha: boolean;
  size_bytes: number;
}

/** ffprobe's arguments for a clip's picture stream (`count`: decode and count every frame instead of trusting the container). */
export function clipProbeArgs(file: string, count = false): string[] {
  return [
    '-v',
    'error',
    ...(count ? ['-count_frames'] : []),
    '-select_streams',
    'v:0',
    '-show_entries',
    'stream=codec_name,profile,pix_fmt,width,height,r_frame_rate,nb_frames,nb_read_frames,duration:stream_tags=timecode,alpha_mode:format=duration,size:format_tags=timecode',
    '-of',
    'json',
    file,
  ];
}

/** The clip in ffprobe's answer to `clipProbeArgs` (`count`: as asked there); null when it has no picture stream. */
export function clipProbeFromJson(json: unknown, count = false): ClipProbe | null {
  const j = json as { streams?: Array<Record<string, unknown> & { tags?: Record<string, string> }>; format?: { duration?: string; size?: string; tags?: Record<string, string> } };
  const s = j.streams?.[0];
  if (!s) return null;
  const [a, b] = String(s.r_frame_rate ?? '0/1')
    .split('/')
    .map(Number);
  const frames = Number(count ? s.nb_read_frames : s.nb_frames);
  return {
    codec: String(s.codec_name),
    ...(s.profile !== undefined ? { profile: String(s.profile) } : {}),
    pix_fmt: String(s.pix_fmt),
    width: Number(s.width),
    height: Number(s.height),
    fps: b ? a / b : a,
    frames: Number.isFinite(frames) ? frames : 0,
    duration_s: Number(s.duration ?? j.format?.duration ?? 0),
    ...((s.tags?.timecode ?? j.format?.tags?.timecode) ? { timecode: s.tags?.timecode ?? j.format?.tags?.timecode } : {}),
    alpha: /^(yuva|rgba|argb|bgra|abgr|gbrap|ya)/.test(String(s.pix_fmt)) || s.tags?.alpha_mode === '1',
    size_bytes: Number(j.format?.size ?? 0),
  };
}

/** What ffprobe reads of an open video (the frame server's: `openVideoArgs`). */
export interface OpenVideoProbe {
  fps: number;
  /** The average frame rate (frames over duration): ≠ fps for a variable frame rate. */
  avg_fps?: number;
  /** The first frame's time, in seconds (0 for every render the tool writes). */
  start_s?: number;
  frames?: number;
  width: number;
  height: number;
}

/** ffprobe's arguments for an mp4 open on the child's descriptor 3 (the fd protocol only: it opens no path). */
export function openVideoArgs(): string[] {
  return [
    '-v',
    'error',
    '-protocol_whitelist',
    'fd',
    '-f',
    'mp4',
    '-fd',
    '3',
    '-select_streams',
    'v:0',
    '-show_entries',
    'stream=r_frame_rate,avg_frame_rate,start_time,nb_frames,width,height',
    '-of',
    'json',
    'fd:',
  ];
}

/** The open video in ffprobe's answer to `openVideoArgs`; null without a frame rate and a size. */
export function openVideoFromJson(json: unknown): OpenVideoProbe | null {
  const s = (json as { streams?: Array<Record<string, unknown>> }).streams?.[0];
  const fps = roundedRate(s?.r_frame_rate);
  const avg = roundedRate(s?.avg_frame_rate);
  const start = s?.start_time !== undefined ? Number(s.start_time) : undefined;
  const width = Number(s?.width ?? 0);
  const height = Number(s?.height ?? 0);
  const frames = s?.nb_frames !== undefined ? Number(s.nb_frames) : undefined;
  if (!(fps > 0) || !(width > 0) || !(height > 0)) return null;
  return {
    fps,
    width,
    height,
    ...(avg > 0 ? { avg_fps: avg } : {}),
    ...(start !== undefined && Number.isFinite(start) ? { start_s: start } : {}),
    ...(frames !== undefined && Number.isInteger(frames) && frames > 0 ? { frames } : {}),
  };
}

/** ffprobe's arguments for the size of a picture (an image, or a video's first picture stream). */
export function pictureSizeArgs(file: string): string[] {
  return ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'json', file];
}

/** The size in ffprobe's answer to `pictureSizeArgs` (NaN when it says none). */
export function pictureSizeFromJson(json: unknown): { width: number; height: number } {
  const s = (json as { streams?: Array<{ width?: unknown; height?: unknown }> } | null)?.streams?.[0];
  return { width: Number(s?.width), height: Number(s?.height) };
}

/** ffprobe's arguments for a take's codec, B-frames and packets over its first `seconds`, from descriptor 3 (no path). */
export function packetsArgs(seconds: number): string[] {
  return [
    '-v',
    'error',
    '-protocol_whitelist',
    'fd',
    '-f',
    'mp4',
    '-fd',
    '3',
    '-i',
    'fd:',
    '-select_streams',
    'v:0',
    '-read_intervals',
    `%+${seconds}`,
    '-show_entries',
    'stream=codec_name,has_b_frames:packet=pts_time,flags',
    '-of',
    'json',
  ];
}

/** The stream and the packets of ffprobe's answer to `packetsArgs`. */
export function ffprobePackets(json: unknown): { stream?: { codec_name?: string; has_b_frames?: number }; packets: Array<{ pts_time?: string; flags?: string }> } {
  const j = json as { streams?: Array<{ codec_name?: string; has_b_frames?: number }>; packets?: Array<{ pts_time?: string; flags?: string }> };
  const stream = j.streams?.[0];
  return { ...(stream !== undefined ? { stream } : {}), packets: j.packets ?? [] };
}
