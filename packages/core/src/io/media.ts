/**
 * The media probes (core media.ts reads their answers): ffprobe of a video file, cached by path, size, modification
 * time and the ffprobe that read it, and the metadata of a Lottie file on the disk.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import type { WorkPolicy } from '../agent-policy.js';
import { ffprobeBin } from './media-tools.js';
import { MediaProbeError, readLottieMeta, videoProbeFromJson } from '../media.js';
import type { LottieMeta, VideoProbe } from '../media.js';

const probeCache = new Map<string, VideoProbe | MediaProbeError>();

/** A work's ffprobe (bundle.ts: retake.yaml `ffmpeg`'s folder → $RETAKE_FFPROBE / $RETAKE_FFMPEG's → the app's → PATH). */
export function ffprobeCommand(policy: WorkPolicy): string {
  return ffprobeBin(policy);
}

/**
 * ffprobe a video file (synchronous, cached by path + size + mtime + the ffprobe run): codec, size, length, sound,
 * alpha. Throws MediaProbeError (`no-ffprobe` when ffprobe is missing, `unreadable` / `no-video` for a file it cannot
 * use); the ffprobe is the work's (`policy`: ffprobeBin — its refusal, a BundleError, is thrown as it is).
 */
export function probeVideoFile(file: string, policy: WorkPolicy): VideoProbe {
  let st;
  try {
    st = statSync(file);
  } catch {
    throw new MediaProbeError(`${file} not found`, 'unreadable');
  }
  const ffprobe = ffprobeCommand(policy);
  // Another ffprobe (another workspace's, another policy's) may read the file otherwise: its answer is its own.
  const key = `${file}\0${st.size}\0${st.mtimeMs}\0${ffprobe}`;
  const hit = probeCache.get(key);
  if (hit instanceof MediaProbeError) throw hit;
  if (hit) return hit;
  const r = spawnSync(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (r.error) {
    // Not cached: installing ffmpeg fixes it.
    throw new MediaProbeError(`ffprobe is not available (${(r.error as NodeJS.ErrnoException).code ?? r.error.message}): install ffmpeg`, 'no-ffprobe');
  }
  let result: VideoProbe | MediaProbeError;
  if (r.status !== 0) {
    const why = String(r.stderr || '').trim().split('\n')[0] || `exit ${r.status}`;
    result = new MediaProbeError(`ffprobe cannot read it (${why})`, 'unreadable');
  } else {
    try {
      result = videoProbeFromJson(JSON.parse(r.stdout));
    } catch (e) {
      result = e instanceof MediaProbeError ? e : new MediaProbeError(`ffprobe output not understood (${(e as Error).message})`, 'unreadable');
    }
  }
  probeCache.set(key, result);
  if (result instanceof MediaProbeError) throw result;
  return result;
}

/** readLottieMeta of a file (throws an Error saying what is wrong). */
export function readLottieFile(file: string): LottieMeta {
  return readLottieMeta(readFileSync(file, 'utf8'));
}
