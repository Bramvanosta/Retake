/**
 * The still of a frame comment (L3.6): one exact frame of a render (`extractFrames`' frame-number select, the review's
 * own extraction — no seek arithmetic), as a JPEG no larger than 1920 px on its long side (4K masters are scaled), with
 * the commented region outlined when there is one (`drawMarks`: one box, no numbered badge). One image per thread.
 */
import { stat, writeFile } from 'node:fs/promises';
import sharp from 'sharp';
import type { WorkPolicy } from '@retake/core/policy';
import type { CommentRegion } from '@retake/core/comments';
import { regionProblem } from '@retake/core/comments';
import { extractFrames, probeVideo } from './ffmpeg.js';
import { ReviewError } from './load.js';
import type { RgbImage } from './pixels.js';
import { drawMarks } from './sheets.js';

/** Long side of a still, at most. */
export const STILL_MAX_PX = 1920;

export interface StillOptions {
  /** What the work runs under (core WorkPolicy): which ffmpeg and ffprobe, under its agent policy. */
  policy: WorkPolicy;

  /** Outlined on the still (0..1 of the frame). */
  region?: CommentRegion;
  /** Long side at most (default STILL_MAX_PX). */
  maxPx?: number;
  /** JPEG quality (default 85). */
  quality?: number;
  signal?: AbortSignal;
}

/** Write the still of output frame `frame` of `video` to `out` (a JPEG). Throws a ReviewError when the frame cannot be read. */
export async function extractStill(video: string, frame: number, out: string, opts: StillOptions): Promise<{ width: number; height: number; bytes: number }> {
  if (!Number.isInteger(frame) || frame < 0) throw new ReviewError(`frame ${frame} is not a frame number`);
  if (opts.region) {
    const p = regionProblem(opts.region);
    if (p) throw new ReviewError(p);
  }
  const info = await probeVideo(video, opts.policy);
  const max = opts.maxPx ?? STILL_MAX_PX;
  const k = Math.min(1, max / Math.max(info.width, info.height));
  const width = Math.max(2, Math.round(info.width * k));
  const height = Math.max(2, Math.round(info.height * k));
  let img: RgbImage | undefined;
  await extractFrames(video, [frame], { width, height, videoWidth: info.width, videoHeight: info.height, policy: opts.policy, signal: opts.signal }, (_f, i) => {
    img = { width: i.width, height: i.height, data: Buffer.from(i.data) };
  });
  if (!img) throw new ReviewError(`frame ${frame} is past the end of ${video}${info.frames ? ` (${info.frames} frames)` : ''}`);
  const raw = sharp(img.data, { raw: { width: img.width, height: img.height, channels: 3 } });
  const quality = opts.quality ?? 85;
  if (opts.region) {
    const r = opts.region;
    const png = await raw.png().toBuffer();
    // The outline only (no numbered badge: the video has its own), its stroke sized from the long side for the 1280 px
    // thumbnail the MCP shows.
    await drawMarks(png, [{ mark: 1, x: r.x * width, y: r.y * height, w: r.w * width, h: r.h * height }], out, { scale: Math.max(1, Math.max(width, height) / 1280), quality, badge: false });
  } else {
    await writeFile(out, await raw.jpeg({ quality, mozjpeg: true }).toBuffer());
  }
  return { width, height, bytes: (await stat(out)).size };
}
