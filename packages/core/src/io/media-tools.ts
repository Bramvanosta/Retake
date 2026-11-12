/**
 * Which ffmpeg and ffprobe a process runs (bundle.ts resolveMediaTools: retake.yaml `ffmpeg` → `$RETAKE_FFMPEG` /
 * `$RETAKE_FFPROBE` → the app's → PATH), under the agent policy (core agent-policy.ts policyProgram): a program inside
 * the workspace or named by a relative path is refused, and the one checked is started by its real path.
 */
import { policyProgram } from '../agent-policy.js';
import type { WorkPolicy } from '../agent-policy.js';
import { BundleError, bundleInfo, resolveMediaTools } from './bundle.js';
import type { MediaToolSource, MediaTools } from './bundle.js';
import { programLookup } from './file-facts.js';

/** A work's ffmpeg and ffprobe (resolveMediaTools with its workspace's setting, this process's environment and the bundle). */
export function mediaTools(policy: WorkPolicy): MediaTools {
  return resolveMediaTools({ configured: policy.ffmpeg, env: process.env, bundle: bundleInfo() });
}

/** How a refusal names where a tool came from (ffprobe beside retake.yaml's ffmpeg: that setting). */
const SOURCE_NAMES: Record<MediaToolSource, string> = {
  'retake.yaml': '`ffmpeg:` of retake.yaml',
  RETAKE_FFMPEG: '$RETAKE_FFMPEG',
  RETAKE_FFPROBE: '$RETAKE_FFPROBE',
  bundled: 'ffmpeg',
  PATH: 'ffmpeg',
};

/**
 * The ffmpeg or ffprobe to run: `explicit` (an option naming one), else the work's — under its agent policy (core
 * agent-policy.ts policyProgram) by the real path that was checked, and refused (BundleError) when it lies inside the
 * workspace or is a relative path.
 */
function mediaBin(policy: WorkPolicy, tool: 'ffmpeg' | 'ffprobe', explicit?: string): string {
  const given = explicit?.trim();
  let bin: string;
  let what: string;
  if (given) {
    bin = given;
    what = tool;
  } else {
    const t = mediaTools(policy);
    bin = t[tool];
    const source = tool === 'ffmpeg' ? t.ffmpegSource : t.ffprobeSource;
    what = source === 'PATH' || source === 'bundled' ? tool : SOURCE_NAMES[source];
  }
  const checked = policyProgram(policy, bin, what, programLookup());
  if (checked.problem) throw new BundleError(checked.problem);
  return checked.program;
}

/** The ffmpeg a work runs: `explicit` (an option naming one), else its workspace's or this process's (mediaBin). */
export function ffmpegBin(policy: WorkPolicy, explicit?: string): string {
  return mediaBin(policy, 'ffmpeg', explicit);
}

/** The ffprobe a work runs: `explicit`, else its workspace's or this process's (mediaBin). */
export function ffprobeBin(policy: WorkPolicy, explicit?: string): string {
  return mediaBin(policy, 'ffprobe', explicit);
}
