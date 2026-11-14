/**
 * The Reviewer port (L7.11, U6): how the engine reviews a render (its contact sheets, key frames, checks and report in
 * review/<render id>/), puts a review folder back in order after a review that died, and draws the frames and
 * thumbnails the façade serves (a run's thumbnails, a render's frame, a review's images, a comment's still, an
 * inspection's marked screenshot). The review's vocabulary comes from its domain entry (`@retake/review/checks`); the
 * frames' options are written here. It names no adapter otherwise, types included (the import-rules ratchet's
 * `port-types`). Adapters: the review package (`packageReviewer`, review-package.ts) and an in-memory one for tests
 * (`MemoryReviewer`, memory-reviewer.ts).
 *
 * Which earlier render a review compares with is not the reviewer's: a records rule, run by the engine over core.
 */
import type { WorkPolicy } from '@retake/core/policy';
import type { CommentRegion } from '@retake/core/comments';
import type { ReviewOptions, ReviewResult } from '@retake/review/checks';

/** A video to take frames from: a path (file protocol only), or one open descriptor per time (fd protocol only). */
export type FrameInput = string | { fds: readonly number[] };

export interface FramesAtOptions {
  /** Long side of each frame, at most (never enlarged). */
  maxPx?: number;
  signal?: AbortSignal;
  /** The process is killed after this long. */
  timeoutMs?: number;
  /** The ffmpeg binary (default: the policy's). */
  ffmpeg?: string;
  /** What the work runs under (core WorkPolicy): which ffmpeg, under its agent policy. */
  policy: WorkPolicy;
}

/** A JPEG in memory. */
export interface FrameThumb {
  data: Buffer;
  width: number;
  height: number;
}

export interface FrameThumbOptions {
  maxPx?: number;
  quality?: number;
}

export interface StillOptions {
  /** What the work runs under (core WorkPolicy): which ffmpeg and ffprobe. */
  policy: WorkPolicy;
  /** Outlined on the still (0..1 of the frame). */
  region?: CommentRegion;
  /** Long side at most. */
  maxPx?: number;
  /** JPEG quality. */
  quality?: number;
  signal?: AbortSignal;
}

/** A numbered box drawn on an image, in its pixels. */
export interface MarkBox {
  mark: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface MarksOptions {
  /** The image's device pixels per CSS px. */
  scale?: number;
  quality?: number;
  /** false: the outlines only. */
  badge?: boolean;
}

/** The frames and pictures the façade serves. */
export interface FrameTools {
  /**
   * Make `at` and `thumb` ready (the package adapter loads its thumbnail entry): a caller that turns a failed `at` or
   * `thumb` into a missing or undecodable picture awaits this first, outside its catch, so that a tool that cannot be
   * loaded fails the whole call with its own error, as before the port — never a quiet blank.
   */
  load(): Promise<void>;
  /** The frames of a video at `seconds` (PNGs; null for a time it does not reach), one process for the batch. */
  at(input: FrameInput, seconds: readonly number[], o: FramesAtOptions): Promise<Array<Buffer | null>>;
  /** A JPEG fitting inside `maxPx` of an encoded image (throws on an unreadable or oversized one). */
  thumb(bytes: Buffer, o?: FrameThumbOptions): Promise<FrameThumb>;
  /** A JPEG ≤ `maxPx` on its long side (base64) of an image file. */
  thumbnailOf(file: string, maxPx: number): Promise<{ base64: string; width: number; height: number; bytes: number }>;
  /** The still of output frame `frame` of `video`, written to `out` (a JPEG). */
  still(video: string, frame: number, out: string, o: StillOptions): Promise<{ width: number; height: number; bytes: number }>;
  /** `png` (a file or an encoded image) with each box outlined and numbered, written to `out` (a JPEG). */
  marks(png: string | Buffer, boxes: readonly MarkBox[], out: string, o?: MarksOptions): Promise<{ width: number; height: number; marks: number }>;
}

export interface Reviewer {
  /** Review a render: its review folder written (replacing the previous one only when it is complete). */
  review(o: ReviewOptions): Promise<ReviewResult>;
  /** Put a review folder back in order after a review that died: the review set aside comes back, leftovers go. */
  recover(dir: string): Promise<void>;
  readonly frames: FrameTools;
}
