/**
 * The media probes (core media.ts reads their answers): ffprobe of a video file, cached by path, size, modification
 * time and the ffprobe that read it.
 */
import { statSync } from 'node:fs';
import type { WorkPolicy } from '../agent-policy.js';
import { ffprobeBin } from './media-tools.js';
import { readFfprobeJson, videoFileArgs, videoProbeFromJson } from '../ffprobe.js';
import { MediaToolError, runMediaToolSync, stderrLines } from './media-run.js';
import { MediaProbeError } from '../media.js';
import type { VideoProbe } from '../media.js';

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
      result = e instanceof MediaProbeError ? e : new MediaProbeError(`ffprobe output not understood (${(e as Error).message})`, 'unreadable');
    }
  }
  probeCache.set(key, result);
  if (result instanceof MediaProbeError) throw result;
  return result;
}
