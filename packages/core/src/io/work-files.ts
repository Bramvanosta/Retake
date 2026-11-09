/**
 * The ports of a work (core file-facts.ts): node:fs answers (nodeFileFacts), and its VideoProber runs the ffprobe of its
 * policy.
 */
import type { WorkPolicy } from '../agent-policy.js';
import type { WorkFileFacts } from '../file-facts.js';
import { MediaProbeError } from '../media.js';
import type { VideoProbe } from '../media.js';
import { BundleError } from './bundle.js';
import { nodeFileFacts } from './file-facts.js';
import { probeVideoFile } from './media.js';

/**
 * FileFacts read from this machine's file system, and a VideoProber running the ffprobe of `policy` (its workspace's
 * ffmpeg, under its agent policy): what validation of a work's files is given.
 */
export function fileFacts(policy: WorkPolicy): WorkFileFacts {
  return Object.freeze({ ...nodeFileFacts, probeVideo: (file: string) => probeVideo(file, policy) });
}

/**
 * probeVideoFile for a check: a policy that refuses the work's ffprobe (a BundleError) means the file could not be read
 * by it — a MediaProbeError `unreadable` in the refusal's words, as the check reports it.
 */
function probeVideo(file: string, policy: WorkPolicy): VideoProbe {
  try {
    return probeVideoFile(file, policy);
  } catch (e) {
    if (e instanceof BundleError) throw new MediaProbeError(e.message, 'unreadable');
    throw e;
  }
}
