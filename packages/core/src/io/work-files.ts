/**
 * The FileFacts of a work (core file-facts.ts): node:fs answers, and its videos probed with the ffprobe of its policy.
 */
import type { WorkPolicy } from '../agent-policy.js';
import type { FileFacts } from '../file-facts.js';
import { nodeFileFacts } from './file-facts.js';
import { probeVideoFile } from './media.js';

/**
 * FileFacts read from this machine's file system, its videos probed with the ffprobe of `policy` (its workspace's
 * ffmpeg, under its agent policy): what validation of a work's files is given.
 */
export function fileFacts(policy: WorkPolicy): FileFacts {
  return Object.freeze({ ...nodeFileFacts, probeVideo: (file: string) => probeVideoFile(file, policy) });
}
