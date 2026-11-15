/**
 * What a review reads before it decodes anything (the render, its plan, registry, timeline, run, the previous render,
 * the video's probe) and the shape of a review under way, shared by its passes and its writers.
 */
import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { ComponentRegistry } from '@retake/components/geometry';
import { printableText, errorMessage } from '@retake/core/base';
import type { EditPlan } from '@retake/editor/plan';
import { planFontFiles } from './checks.js';
import type { CheckContext } from './checks.js';
import { probeVideo } from './ffmpeg.js';
import type { VideoInfo } from './ffmpeg.js';
import { fontFileMeasurer } from './fonts.js';
import { ReviewError, findPrevious, handedProject, handedRegistry, locateRender, renderRun, renderTimeline } from './load.js';
import type { FrameAnalysis } from './pixel-checks.js';
import { segmentSpans, transitionSpans } from './spans.js';
import { outputClicks } from './timeline.js';
import { DEFAULT_RULES, DEFAULT_SHEET } from './types.js';
import type { Finding, ReviewOptions, ReviewProgress, ReviewRules } from './types.js';

/** The rules of a review: the defaults, the scenario's target length (R-FLD-05), then the caller's. */
export function reviewRules(plan: Pick<EditPlan, 'target_length'>, given: Partial<ReviewRules> = {}): ReviewRules {
  const rules: ReviewRules = { ...DEFAULT_RULES, ...given };
  if (plan.target_length && given.video_min_s === undefined && given.video_max_s === undefined) {
    rules.video_min_s = plan.target_length.min_s;
    rules.video_max_s = plan.target_length.max_s;
    rules.video_target = 'scenario';
  }
  return rules;
}

/** A review under way: what was loaded, the frames it samples, where it writes, and how it reports and stops. */
export type ReviewRun = LoadedReview & {
  opts: ReviewOptions;
  started: number;
  progress: (p: ReviewProgress) => void;
  signal?: AbortSignal;
  /** Stop between stages (and ffmpeg at once: it gets the signal) when cancelled. */
  check: () => void;
  samples: ReviewSamples;
  finalDir: string;
  tmpDir: string;
};

export type LoadedReview = Awaited<ReturnType<typeof loadReview>>;

/** The output frames a review looks at. */
export interface ReviewSamples {
  mainFrames: number[];
  sceneSamples: Map<string, number[]>;
  mainSet: Set<number>;
  sceneSet: Set<number>;
  keyByFrame: Map<number, string[]>;
  wanted: Set<number>;
}

export type FrameTile = { data: Buffer; width: number; height: number };

/** What the decoding of the render gave: contact sheet tiles, frame analyses, key frame files. */
export interface RenderFrames {
  tiles: Map<number, FrameTile>;
  analyses: Map<number, FrameAnalysis>;
  keyFiles: Record<string, string>;
}

/** Load what a review reads: the render, its plan, registry, timeline, run, the previous render and the video's probe. */
export async function loadReview(opts: ReviewOptions) {
  const project = handedProject(opts.project);
  const source = handedRegistry(opts.registry);
  const found = await locateRender(project, opts.render, opts.scenario);
  const record = found.record;
  // The name of its folder of review/ (never an empty name or a path: an id written by hand is any text).
  const name = found.output;
  const plan = record.plan;
  if (!existsSync(record.file)) throw new ReviewError(`the video of render ${printableText(name)} is missing: ${record.file ? printableText(record.file) : 'no "file" in its record'}`);
  const fps = opts.fps ?? 1;
  if (fps !== 1 && fps !== 2) throw new ReviewError(`fps ${String(fps)}: the contact sheet takes 1 or 2 frames per second`);
  const rules = reviewRules(plan, opts.rules);
  const layout = { ...DEFAULT_SHEET, ...opts.sheet };
  const thumbPx = Math.max(64, Math.min(1280, Math.round(opts.thumbnail_px ?? 1280)));
  // Findings about the review itself (what could not be loaded or read), in the order they were met.
  const notes: Finding[] = [];

  let registry: ComponentRegistry | undefined = typeof source === 'function' ? undefined : source;
  if (typeof source === 'function') {
    try {
      registry = await source(project.root);
    } catch (e) {
      notes.push({ severity: 'info', code: 'registry-unavailable', message: `component registry not loaded (${errorMessage(e)}): text slot limits not checked` });
    }
  }
  const { timeline } = await renderTimeline(project, record);
  if (!timeline) notes.push({ severity: 'info', code: 'timeline-missing', message: `the run ${record.run_id} (timeline.json) is not available: clicks, cursor and capture captions not checked` });
  const previous = await findPrevious(project, record, opts.previous);
  const probed = await probeVideo(record.file, opts.policy);

  const spans = segmentSpans(plan);
  const transitions = transitionSpans(plan);
  const clicks = outputClicks(plan, timeline);
  const run = await renderRun(project, record);
  const ctx: CheckContext = { record, plan, timeline, rules, spans, transitions, clicks, registry, measure: fontFileMeasurer(planFontFiles(plan)), ...(run ? { run } : {}) };
  return {
    project,
    record,
    name,
    plan,
    fps,
    rules,
    layout,
    thumbPx,
    notes,
    ...(timeline ? { timeline } : {}),
    ...(previous ? { previous } : {}),
    probed,
    spans,
    transitions,
    ctx,
  };
}

/** The decoding options of a video, at the size a pass reads it. */
export function decodeOptions(r: ReviewRun, width: number, height: number, info: VideoInfo) {
  return { width, height, videoWidth: info.width, videoHeight: info.height, policy: r.opts.policy, ...(r.signal ? { signal: r.signal } : {}) };
}

/** A file of the review's temporary folder, at its place in the final one. */
export function finalPath(r: Pick<ReviewRun, 'finalDir' | 'tmpDir'>, p: string): string {
  return join(r.finalDir, relative(r.tmpDir, p));
}
