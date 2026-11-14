/**
 * The product's reviewer: the review package behind the Reviewer port, loaded through the engine's loader on a
 * member's first call. Two entries, as before the port: the frames of a video and the thumbnails of an image come from
 * its light entry (lazy.ts `thumbs`: sharp and ffmpeg, never the editor), everything else from its root (lazy.ts
 * `review`). Each member calls the package's function with the same arguments: the review's artefacts, the sizes and
 * the qualities are the package's, unchanged. Made by the composition roots only (ports.ts enginePorts).
 */
import { review, thumbs } from '../lazy.js';
import type { Reviewer } from './reviewer.js';

export function packageReviewer(): Reviewer {
  return {
    review: async (o) => (await review()).reviewRender(o),
    recover: async (dir) => (await review()).recoverReviewDir(dir),
    frames: {
      load: async () => void (await thumbs()),
      at: async (input, seconds, o) => (await thumbs()).videoFramesAt(input, seconds, o),
      thumb: async (bytes, o) => (await thumbs()).thumbJpeg(bytes, o),
      thumbnailOf: async (file, maxPx) => (await review()).thumbnailOf(file, maxPx),
      still: async (video, frame, out, o) => (await review()).extractStill(video, frame, out, o),
      marks: async (png, boxes, out, o) => (await review()).drawMarks(png, boxes, out, o),
    },
  };
}
