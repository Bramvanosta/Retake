/**
 * Reading an image or a video frame as RGB, through ffmpeg (the side of the pixel helpers that runs a process). The
 * statistics themselves are pixel-maths.ts (pure), re-exported here so that every importer keeps its names.
 */
import { pictureSizeArgs, pictureSizeFromJson, readFfprobeJson } from '@retake/core';
import type { WorkPolicy } from '@retake/core';
import { ffmpegBin, ffprobeBin, runMediaToolSync } from '@retake/core/io';
import type { RgbImage } from './pixel-maths.js';

export * from './pixel-maths.js';

/** Any image or video file (its first frame) as RGB, through ffmpeg. */
export function readImage(file: string, policy: WorkPolicy, frame = 0): RgbImage {
  const { width, height } = pictureSizeFromJson(readFfprobeJson(runMediaToolSync(ffprobeBin(policy), pictureSizeArgs(file))));
  const args = ['-v', 'error', '-i', file];
  if (frame > 0) args.push('-vf', `select=eq(n\\,${frame})`, '-fps_mode', 'passthrough');
  args.push('-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-');
  const data = runMediaToolSync(ffmpegBin(policy), args, { encoding: 'buffer', maxBuffer: width * height * 3 + 1024 });
  return { width, height, data };
}
