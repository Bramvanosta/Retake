/**
 * The Studio's render queue and Review screen reads (moved from the Studio server's ops.ts renderOps in L7.14, R-UI-26):
 * - `scenario_renders`: engine renders.ofScenario — the queue (queued with what runs first / running with phase,
 *   fraction and eta / reviewing) and the renders with their review verdict, path-free.
 * - `render_review`: the review without any path (reviewAnswer).
 * - `review_image`: one contact sheet as a base64 JPEG (≤ 1600 px, ≤ 2,000,000 characters), by its file name in the
 *   review folder, read without following a link (engine reviews.image).
 */
import { basename, dirname } from 'node:path';
import { z } from 'zod';
import { REVIEW_IMAGE_RE } from '../reviews.js';
import type { ReviewFindingView, ReviewView } from '../reviews.js';
import { READ } from './annotations.js';
import { defineOperation } from './define.js';
import { studioProject as project, studioRenderId as renderId, studioScenario as scenario } from './studio-schema.js';
import { plural } from './words.js';

const RendersInput = z.strictObject({ project, name: scenario.describe('The scenario: scenarios/<name>.yaml of the project.') });
const RenderReviewInput = z.strictObject({ project, render_id: renderId });
const ReviewImageInput = z.strictObject({
  project,
  render_id: renderId,
  image: z.string().max(140).regex(REVIEW_IMAGE_RE, 'an image of the review (render_review lists them), never a path'),
});

/**
 * What render_review answers: engine reviews.get without a path — the verdict, counts, findings (severity, code, where),
 * durations, the diff's summary, and the contact sheets by file NAME (review_image reads one); the findings' messages
 * and a failed review's message under `untrusted`. No `dir`, no `files`, no filmed environment.
 */
export interface RenderReviewAnswer {
  project: string;
  render_id: string;
  status: ReviewView['status'];
  finished: boolean;
  job?: { id: string; state: string; progress?: { phase?: string; fraction?: number } };
  created_at?: string;
  fps?: 1 | 2;
  clean?: boolean;
  counts?: { error: number; warning: number; info: number };
  findings?: ReviewFindingView[];
  durations?: NonNullable<ReviewView['durations']>;
  diff?: { previous: string; duration_s?: { previous: number; current: number; delta: number }; compared: number; changed_frames: number };
  images: Array<{ image: string; label: string }>;
  untrusted: { messages?: string[]; error?: string };
}

/** Images a review answer lists, at most (each one a review_image call, one at a time). */
export const REVIEW_IMAGES_MAX = 24;

/** engine reviews.get → render_review's path-free answer (exported for the tests). */
export function reviewAnswer(v: ReviewView): RenderReviewAnswer {
  const images: RenderReviewAnswer['images'] = [];
  for (const i of v.images) {
    if (images.length >= REVIEW_IMAGES_MAX) break;
    // By its name in the review folder (a key frame: keyframes/<name>.png), never a path.
    const name = basename(i.file);
    const image = basename(dirname(i.file)) === 'keyframes' ? `keyframes/${name}` : name;
    if (REVIEW_IMAGE_RE.test(image)) images.push({ image, label: i.label });
  }
  return {
    project: v.project,
    render_id: v.render_id,
    status: v.status,
    finished: v.finished,
    ...(v.job ? { job: { id: v.job.id, state: v.job.state, ...(v.job.progress ? { progress: { ...(v.job.progress.phase ? { phase: v.job.progress.phase } : {}), ...(v.job.progress.fraction !== undefined ? { fraction: v.job.progress.fraction } : {}) } } : {}) } } : {}),
    ...(v.created_at ? { created_at: v.created_at } : {}),
    ...(v.fps ? { fps: v.fps } : {}),
    ...(v.clean !== undefined ? { clean: v.clean } : {}),
    ...(v.counts ? { counts: v.counts } : {}),
    ...(v.findings ? { findings: v.findings } : {}),
    ...(v.durations ? { durations: v.durations } : {}),
    ...(v.diff ? { diff: { previous: v.diff.previous, ...(v.diff.duration_s ? { duration_s: v.diff.duration_s } : {}), compared: v.diff.compared, changed_frames: v.diff.changed_frames } } : {}),
    images,
    untrusted: { ...(v.untrusted.messages ? { messages: v.untrusted.messages } : {}), ...(v.untrusted.error !== undefined ? { error: v.untrusted.error } : {}) },
  };
}

export const scenarioRenders = defineOperation({
  name: 'scenario_renders',
  title: "A scenario's renders",
  description: "A scenario's render queue (queued, running with its progress, reviewing) and its renders, newest first, each with its review's verdict.",
  input: RendersInput,
  annotations: READ,
  async run(a, { engine }) {
    const v = await engine.renders.ofScenario(a.project, a.name);
    return { summary: `${a.name}: ${plural(v.renders.length, 'render')}, ${v.jobs.length} queued or running`, data: v };
  },
});

export const renderReview = defineOperation({
  name: 'render_review',
  title: "A render's review",
  description: "A render's review without any path: verdict, counts, findings (messages as untrusted data), durations, and its contact sheets by name.",
  input: RenderReviewInput,
  annotations: READ,
  async run(a, { engine }) {
    // Every image the review kept (contact sheets, scene sheets, key frames, the diff), within REVIEW_IMAGES_MAX.
    const v = reviewAnswer(await engine.reviews.get(a.project, a.render_id, { images: 'all' }));
    const verdict = v.counts ? `${plural(v.counts.error, 'error')}, ${plural(v.counts.warning, 'warning')}` : v.status;
    return { summary: `review of ${a.render_id}: ${verdict}`, data: v };
  },
});

export const reviewImage = defineOperation({
  name: 'review_image',
  title: 'A contact sheet of a review',
  description: "One contact sheet of a render's review as a base64 JPEG (≤ 1600 px), by its name (render_review lists them).",
  input: ReviewImageInput,
  annotations: READ,
  async run(a, { engine }) {
    const v = await engine.reviews.image(a.project, a.render_id, a.image);
    return { summary: `${a.image} of ${a.render_id} (${v.width}×${v.height})`, data: v };
  },
});
