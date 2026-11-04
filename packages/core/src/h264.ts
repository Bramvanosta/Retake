/**
 * Which H.264 encoder an ffmpeg has (L5.16): libx264 (today's encoder everywhere: the repository's ffmpeg and the app's
 * own build have it), else the Mac's VideoToolbox (`h264_videotoolbox`) — an ffmpeg built without libx264, the
 * system's one when the app carries none. The sites that encode H.264 (the capture, the frames encode, the raw export's
 * MP4 clips, the 1080p export) ask here once per ffmpeg path.
 */
import { execFile } from 'node:child_process';

export type H264Encoder = 'libx264' | 'h264_videotoolbox';

/** VideoToolbox's constant quality where libx264 is missing (the capture's: SSIM 0.9985 vs the frames, libx264 CRF 16: 0.9989). */
export const H264_VIDEOTOOLBOX_QUALITY = 85;

export class H264EncoderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'H264EncoderError';
  }
}

/** The encoder names of `ffmpeg -encoders` output (the lines after the `------` rule). Pure. */
export function parseEncoders(text: string): Set<string> {
  const out = new Set<string>();
  let body = false;
  for (const line of text.split('\n')) {
    if (!body) {
      if (/^\s*-{6,}\s*$/.test(line)) body = true;
      continue;
    }
    const m = /^\s*[VAS][A-Z.]{5}\s+(\S+)/.exec(line);
    if (m) out.add(m[1]);
  }
  return out;
}

/** The H.264 encoder of an encoder list: libx264, else h264_videotoolbox, else null. Pure. */
export function pickH264(encoders: ReadonlySet<string>): H264Encoder | null {
  if (encoders.has('libx264')) return 'libx264';
  if (encoders.has('h264_videotoolbox')) return 'h264_videotoolbox';
  return null;
}

const encoderLists = new Map<string, Promise<Set<string> | null>>();

/** `ffmpeg -encoders` once per path (null when it cannot run). */
export function ffmpegEncoders(ffmpeg: string): Promise<Set<string> | null> {
  let p = encoderLists.get(ffmpeg);
  if (!p) {
    p = new Promise((resolve) => {
      execFile(ffmpeg, ['-hide_banner', '-encoders'], { maxBuffer: 4 * 1024 * 1024, timeout: 15_000 }, (err, stdout) => {
        resolve(err ? null : parseEncoders(String(stdout)));
      });
    });
    encoderLists.set(ffmpeg, p);
  }
  return p;
}

/**
 * The H.264 encoder to use with `ffmpeg`: libx264 when it has it, else h264_videotoolbox; H264EncoderError when it
 * has neither. An ffmpeg that cannot list its encoders is left to fail on the encode itself (libx264, today's
 * arguments, its own error message).
 */
export async function h264Encoder(ffmpeg: string): Promise<H264Encoder> {
  const list = await ffmpegEncoders(ffmpeg);
  if (!list) return 'libx264';
  const pick = pickH264(list);
  if (!pick) throw new H264EncoderError(`${ffmpeg} has no H.264 encoder (neither libx264 nor h264_videotoolbox): use an ffmpeg built with libx264 (retake.yaml "ffmpeg", or $RETAKE_FFMPEG)`);
  return pick;
}

/**
 * The codec arguments of an H.264 encode: `libx264` (the site's own: `-c:v libx264 …`) as given, else VideoToolbox at
 * H264_VIDEOTOOLBOX_QUALITY, profile high. The site keeps its other arguments (scale, pixel format, colour tags, `-g`).
 */
export function h264CodecArgs(enc: H264Encoder, libx264: readonly string[]): string[] {
  return enc === 'libx264' ? [...libx264] : ['-c:v', 'h264_videotoolbox', '-q:v', String(H264_VIDEOTOOLBOX_QUALITY), '-profile:v', 'high'];
}

/** Forget the cached encoder lists (tests). */
export function resetFfmpegEncoders(): void {
  encoderLists.clear();
}
