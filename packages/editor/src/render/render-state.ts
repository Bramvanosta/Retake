/**
 * A render in progress: its checked inputs and progress, the shape of an attempt, the error its one fallback is
 * taken for, and the file chores around the video (leftover temporary files, the audio track).
 */
import { randomBytes } from 'node:crypto';
import { rename, rm } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { ffmpegBin, runMediaTool } from '@retake/core/io';
import type { WorkPolicy } from '@retake/core/policy';
import { renderPolicy, withGl } from './policy.js';
import type { EncodeFfmpegChoice, RenderEncoder, RenderGl, RenderPolicy } from './policy.js';
import { RenderError } from './types.js';
import { probeMedia } from './probe.js';
import type { RenderProgress } from './types.js';
import type { rendererLibrary } from './library.js';
import { handedRoot } from './render-session.js';
import type { RenderPathRecord, RenderPlanOptions } from './render-options.js';

/** The fallback's policy: today's software path (no `--use-gl`, libx264 CRF 16) at the same concurrency. */
export function softwarePolicy(p: RenderPolicy): RenderPolicy {
  return { ...withGl(p, 'software', { keepConcurrency: true }), encoder: { asked: 'libx264', source: p.encoder.source } };
}

export type Library = Awaited<ReturnType<typeof rendererLibrary>>;
export type MediaProgress = Parameters<NonNullable<Parameters<Library['renderMedia']>[0]['onProgress']>>[0];

/** A render in progress: its options and checked inputs, its progress so far, and what its attempts tried. */
export interface RenderRun {
  opts: RenderPlanOptions;
  out: string;
  root: string;
  /** The policy asked (an explicit concurrency option over it). */
  policy: RenderPolicy;
  range: [number, number] | undefined;
  total: number;
  size: { width: number; height: number; fps: number };
  report: (p: RenderProgress) => void;
  /** The progress reached (it never goes back) and whether the fallback runs. */
  high: number;
  highFrames: number;
  retrying: boolean;
  warnings: string[];
  bundleMs: number;
  fallback: { reason: string } | undefined;
  /** What the last attempt tried (a failed render's record keeps it). */
  tried: RenderPathRecord | undefined;
  /** The policy attempt 1 rendered with (its concurrency is the fallback's). */
  first: RenderPolicy | undefined;
  /** The ffmpeg the current attempt encodes with, and what the first attempt failed with while ours encoded. */
  ff: EncodeFfmpegChoice | undefined;
  ownFailed: string | undefined;
  /** The version of our ffmpeg while it encoded the first attempt (the record of a retry keeps it). */
  ownVersion: string | undefined;
}

/** One attempt: its number, the policy its session renders with, its temporary file, its cancel signal and encoder. */
export interface Attempt {
  n: 1 | 2;
  p: RenderPolicy;
  lib: Library;
  partial: string;
  cancelSignal: ReturnType<Library['makeCancelSignal']>['cancelSignal'];
  cancel: () => void;
  /** A failure a test seam made mid-render. */
  injected: Error | undefined;
  encoder: RenderEncoder;
  /** When the attempt's rendering started (performance.now()). */
  tr: number;
}

/** A render's checked inputs: the output file, the root, the policy, the frame range. */
export function startRender(opts: RenderPlanOptions): RenderRun {
  const out = resolve(opts.out);
  if (extname(out).toLowerCase() !== '.mp4') throw new RenderError(`render output must be an .mp4 file: ${out}`);
  const root = handedRoot(opts.root);
  const asked = renderPolicy(opts.workPolicy, opts.settings);
  const policy: RenderPolicy = opts.concurrency !== undefined ? { ...asked, concurrency: Math.max(1, Math.round(opts.concurrency)), concurrencySource: 'option' } : asked;
  const range = opts.frameRange;
  if (range && !(range[0] >= 0 && range[1] >= range[0] && range[1] < opts.plan.durationInFrames)) {
    throw new RenderError(`frame range ${range[0]}–${range[1]} is outside the video (0–${opts.plan.durationInFrames - 1})`);
  }
  const total = range ? range[1] - range[0] + 1 : opts.plan.durationInFrames;
  const size = { width: opts.plan.width, height: opts.plan.height, fps: opts.plan.fps };
  return {
    opts,
    out,
    root,
    policy,
    range,
    total,
    size,
    report: opts.onProgress ?? (() => undefined),
    high: 0,
    highFrames: 0,
    retrying: false,
    warnings: [],
    bundleMs: 0,
    fallback: undefined,
    tried: undefined,
    first: undefined,
    ff: undefined,
    ownFailed: undefined,
    ownVersion: undefined,
  };
}

/** Progress never goes back: a fallback starts again from frame 0 under `retrying`, clamped to what was reached. */
export function emitProgress(st: RenderRun, p: RenderProgress): void {
  const overall = Math.max(st.high, p.overall);
  st.high = overall;
  const next: RenderProgress = { ...p, overall };
  if (p.renderedFrames !== undefined) {
    st.highFrames = Math.max(st.highFrames, p.renderedFrames);
    next.renderedFrames = st.highFrames;
  }
  if (st.retrying && (p.stage === 'bundling' || p.stage === 'rendering')) next.stage = 'retrying';
  st.report(next);
}

/** The record of the path a render took: its policy, what drew and encoded it, the fallback and the ffmpeg. */
export function pathOf(st: RenderRun, used: RenderGl, encoder: RenderEncoder, renderer?: string): RenderPathRecord {
  const { policy, fallback, ff, ownFailed, ownVersion } = st;
  return {
    gl: { asked: policy.gl.asked, source: policy.gl.source, resolved: policy.gl.resolved, used, ...(renderer && used === 'angle' ? { renderer } : {}) },
    encoder: { asked: policy.encoder.asked, source: policy.encoder.source, used: encoder },
    concurrency_source: policy.concurrencySource,
    ...(fallback ? { fallback } : {}),
    ...(ff
      ? {
          ffmpeg: {
            asked: policy.ffmpeg.asked,
            source: policy.ffmpeg.source,
            used: ff.used,
            ...((ff.version ?? (ownFailed ? ownVersion : undefined)) ? { version: ff.version ?? ownVersion } : {}),
            ...(ff.note ? { note: ff.note } : {}),
            ...(ownFailed ? { failed: ownFailed } : {}),
          },
        }
      : {}),
  };
}

/**
 * What renderPlan's one fallback is taken for (internal): a failure of the GPU path (`gpu`), of our ffmpeg at the
 * encode, or one that is either (`gpu` with `own`: the hardware encoder's signs while ours ran it). `own` is our
 * ffmpeg's path when it was encoding ('' when a test gave none).
 */
export class GpuPathFailed extends Error {
  readonly gpu: boolean;
  readonly own: string | undefined;
  constructor(
    readonly reason: string,
    o: { gpu: boolean; own?: string | undefined } = { gpu: true },
  ) {
    super(reason);
    this.gpu = o.gpu;
    this.own = o.own;
  }
}

export async function removeLeftovers(dir: string, partialName: string): Promise<void> {
  const { readdir } = await import('node:fs/promises');
  try {
    for (const f of await readdir(dir)) if (f.startsWith(partialName)) await rm(join(dir, f), { force: true });
  } catch {
    // nothing to clean
  }
}

/**
 * Remotion's `enforceAudioTrack` adds a silent track to a video without audio; this checks it (when ffprobe is
 * available) and adds one with ffmpeg if a file ever comes out without (players and platforms expect one).
 */
export async function ensureAudioTrack(file: string, work: WorkPolicy): Promise<void> {
  const p = await probeMedia(file, work);
  if (!p || p.audio_streams > 0) return;
  const tmp = `${file}.audio-${randomBytes(3).toString('hex')}.mp4`;
  const r = await runMediaTool(
    ffmpegBin(work),
    ['-v', 'error', '-y', '-i', file, '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000', '-shortest', '-c:v', 'copy', '-c:a', 'aac', '-movflags', '+faststart', tmp],
    { maxBuffer: 16 * 1024 * 1024 },
  );
  if (r.code !== 0) {
    await rm(tmp, { force: true });
    throw new RenderError(`the render has no audio track and ffmpeg could not add a silent one: ${r.stderr.split('\n')[0]}`);
  }
  await rename(tmp, file);
}
