/**
 * Reading an image or a video frame as RGB, through ffmpeg (the side of the pixel helpers that runs a process). The
 * statistics themselves are pixel-maths.ts (pure), re-exported here so that every importer keeps its names.
 */
import { execFileSync } from 'node:child_process';
import { ffmpegBin, ffprobeBin } from '@retake/core/io';
import type { WorkPolicy } from '@retake/core';
import type { RgbImage } from './pixel-maths.js';

export * from './pixel-maths.js';

/** Any image or video file (its first frame) as RGB, through ffmpeg. */
export function readImage(file: string, policy: WorkPolicy, frame = 0): RgbImage {
  const probe = execFileSync(ffprobeBin(policy), ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file], { encoding: 'utf8' }).trim();
  const [width, height] = probe.split('\n')[0].split(',').map(Number);
  const args = ['-v', 'error', '-i', file];
  if (frame > 0) args.push('-vf', `select=eq(n\\,${frame})`, '-fps_mode', 'passthrough');
  args.push('-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-');
  const data = execFileSync(ffmpegBin(policy), args, { maxBuffer: width * height * 3 + 1024 });
  return { width, height, data };
}
