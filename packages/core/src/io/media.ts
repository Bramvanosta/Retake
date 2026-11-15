/**
 * The media probes (core media.ts reads their answers): ffprobe of a video file, cached by path, size, modification
 * time and the ffprobe that read it — at most PROBE_CACHE_MAX answers, the least recently used dropped first.
 */
import { statSync } from 'node:fs';
import type { Stats } from 'node:fs';
import type { WorkPolicy } from '../agent-policy.js';
import { ffprobeBin } from './media-tools.js';
import { readFfprobeJson, videoFileArgs, videoProbeFromJson } from '../ffprobe.js';
import { MediaToolError, runMediaToolSync, stderrLines } from './media-run.js';
import { MediaProbeError } from '../media.js';
import type { VideoProbe } from '../media.js';
import { errorMessage } from '../util.js';

/** How many probe answers the cache keeps (a file version each): past it, the least recently used is dropped. */
export const PROBE_CACHE_MAX = 256;

/** Answers by key, least recently used first (a hit moves its key to the end). */
const probeCache = new Map<string, VideoProbe | MediaProbeError>();

function remember(key: string, result: VideoProbe | MediaProbeError): void {
  probeCache.delete(key);
  probeCache.set(key, result);
  while (probeCache.size > PROBE_CACHE_MAX) probeCache.delete(probeCache.keys().next().value as string);
}

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
  let st: Stats;
  try {
    st = statSync(file);
  } catch {
    throw new MediaProbeError(`${file} not found`, 'unreadable');
  }
  const ffprobe = ffprobeCommand(policy);
  // Another ffprobe (another workspace's, another policy's) may read the file otherwise: its answer is its own.
  const key = `${file}\0${st.size}\0${st.mtimeMs}\0${ffprobe}`;
  const hit = probeCache.get(key);
  if (hit) remember(key, hit);
  if (hit instanceof MediaProbeError) throw hit;
  if (hit) return hit;
  let stdout: string | null = null;
  let failed: MediaToolError | null = null;
  try {
    stdout = runMediaToolSync(ffprobe, videoFileArgs(file), { maxBuffer: 16 * 1024 * 1024 });
  } catch (e) {
    if (!(e instanceof MediaToolError)) throw e;
    // Not cached: installing ffmpeg fixes it.
    if (e.errno !== undefined) throw new MediaProbeError(`ffprobe is not available (${e.errno}): install ffmpeg`, 'no-ffprobe');
    failed = e;
  }
  let result: VideoProbe | MediaProbeError;
  if (failed) {
    const why = stderrLines(failed.stderr, 1, 'first') || `exit ${failed.code}`;
    result = new MediaProbeError(`ffprobe cannot read it (${why})`, 'unreadable');
  } else {
    try {
      result = videoProbeFromJson(readFfprobeJson(stdout ?? ''));
    } catch (e) {
      result = e instanceof MediaProbeError ? e : new MediaProbeError(`ffprobe output not understood (${errorMessage(e)})`, 'unreadable');
    }
  }
  remember(key, result);
  if (result instanceof MediaProbeError) throw result;
  return result;
}
