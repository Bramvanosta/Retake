/**
 * L4.5 part E: a real render with its inline review (critique B12), through the worker, on a tiny synthetic take — the
 * Studio's Render: submitted like `scenario_render` (the scenario file's edit, `review: {fps: 1}`, `expect_edit_sha256`),
 * rendered (half scale, two seconds) and reviewed in the same job; then the engine's reads the Studio shows:
 * renders.ofScenario (path-free: the render, its review's verdict) and reviews.image (a contact sheet as a JPEG).
 * Needs ffmpeg and a headless shell; the bundle is the repository's shared cache.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REVIEW_IMAGE_BASE64_MAX, createEngine, runWorker } from '../src/index.js';
import type { Engine, RenderJobResult } from '../src/index.js';
import { synthTimeline } from '../../editor/test/helpers.js';
import { SHARED_CACHE, TEMPLATES, hasTool, makeColourCapture } from '../../editor/test/render-helpers.js';

const canRender = hasTool('ffmpeg') && hasTool('ffprobe');
const LONG = 400_000;
const SCENARIO = 'tiny';
const RUN = '20260101-120000-tiny';
const TEXT = `video: Tiny
title: {text: Tiny}
intro: false
outro: false
frame: card
scenes:
  - id: a
    page: app
    open: /
    caption: Every frame has its own colour.
    steps:
      - hold: 1
`;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
let root: string;
let dir: string;
let engine: Engine;
const savedHome = process.env.DEMO_STUDIO_HOME;

beforeAll(async () => {
  if (!canRender) return;
  root = await mkdtemp(join(tmpdir(), 'ds-render-review-'));
  process.env.DEMO_STUDIO_HOME = join(root, '.home');
  await writeFile(join(root, 'studio.yaml'), `projects_dir: projects\ntemplates_dir: ${JSON.stringify(TEMPLATES)}\n`);
  dir = join(root, 'projects', 'demo');
  const runDir = join(dir, 'runs', RUN);
  await mkdir(runDir, { recursive: true });
  await mkdir(join(dir, 'scenarios'), { recursive: true });
  await writeFile(join(dir, 'project.yaml'), 'name: Demo\nenvironments:\n  local: {app: "http://app.test"}\ntemplate: editorial\n');
  const t = synthTimeline({
    duration: 2,
    entries: [{ id: 'a', t_start: 0.3, t_end: 1.9, caption: { text: 'Every frame has its own colour.' }, steps: [{ action: 'hold', t_start: 0.4, t_end: 1.9 }] }],
    video: { title: { text: 'Tiny' }, intro: false, outro: false, frame: 'card', template: 'editorial' },
  });
  Object.assign(t, { run_id: RUN, project: 'demo', scenario: SCENARIO });
  await writeFile(join(runDir, 'timeline.json'), JSON.stringify(t));
  await writeFile(join(runDir, 'scenario.yaml'), TEXT);
  await writeFile(join(dir, 'scenarios', `${SCENARIO}.yaml`), TEXT);
  makeColourCapture(join(runDir, 'capture.mp4'), 2);
  await mkdir(join(root, '.demo-studio'), { recursive: true });
  await symlink(SHARED_CACHE, join(root, '.demo-studio', 'cache'));
  engine = await createEngine({ root, client: 'test', autoStartWorker: false });
}, LONG);

afterAll(async () => {
  if (savedHome === undefined) delete process.env.DEMO_STUDIO_HOME;
  else process.env.DEMO_STUDIO_HOME = savedHome;
  if (root) await rm(root, { recursive: true, force: true });
});

describe.skipIf(!canRender)('a render reviewed inline, through the worker (L4.5 part E)', () => {
  it('renders the shown version, reviews it in the same job; the render list and a contact sheet, path-free', async () => {
    const t0 = performance.now();
    const sub = await engine.renders.submit({ project: 'demo', scenario: SCENARIO, run_id: RUN, overrides: { scale: 0.5 }, review: { fps: 1 }, expect_edit_sha256: sha(TEXT) });
    expect(sub).toMatchObject({ render_id: `${SCENARIO}-v1`, edit: 'scenario' });
    const queued = await engine.renders.ofScenario('demo', SCENARIO);
    expect(queued.jobs).toMatchObject([{ id: sub.job.id, render_id: sub.render_id, state: 'queued', edit_sha256: sha(TEXT), reviewing: false, queue: { ahead: 0 } }]);
    expect(queued.renders).toEqual([]);

    expect(await runWorker({ root, once: true, idleExitMs: 0, pollMs: 50, log: () => undefined })).toBe(0);
    const job = await engine.jobs.get(sub.job.id);
    expect(job.state, JSON.stringify(job.error)).toBe('succeeded');
    const result = job.result as RenderJobResult;
    expect(result.review).toMatchObject({ state: 'succeeded' });
    const ms = Math.round(performance.now() - t0);
    console.log(`render + inline review of a 2 s take at half scale: ${ms} ms`);
    // The review wrote its package next to the render: a report and at least one contact sheet.
    const reviewDir = join(dir, 'review', sub.render_id);
    expect(existsSync(join(reviewDir, 'report.json'))).toBe(true);
    const sheets = (await readdir(reviewDir)).filter((f) => /^sheet_1fps(_p\d+)?\.jpg$/.test(f));
    expect(sheets.length).toBeGreaterThan(0);

    // The Studio's list: the render, from the edit it was planned from, its review's verdict — no path anywhere.
    const after = await engine.renders.ofScenario('demo', SCENARIO);
    expect(after.jobs).toEqual([]);
    expect(after.renders).toHaveLength(1);
    const r = after.renders[0];
    expect(r).toMatchObject({ render_id: sub.render_id, status: 'succeeded', run_id: RUN, theme: 'editorial', edit: { from: 'scenario', sha256: sha(TEXT) } });
    expect(['clean', 'warnings', 'errors']).toContain(r.review.state);
    const report = JSON.parse(await readFile(join(reviewDir, 'report.json'), 'utf8')) as { counts: { error: number; warning: number } };
    expect(r.review).toMatchObject({ counts: { error: report.counts.error, warning: report.counts.warning } });
    const text = JSON.stringify(after);
    for (const needle of [root, homedir(), '.mp4', 'report.json']) expect(text.includes(needle), needle).toBe(false);

    // A contact sheet as a JPEG within the cap.
    const img = await engine.reviews.image('demo', sub.render_id, sheets[0]);
    expect(Buffer.from(img.base64, 'base64').subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
    expect(img.base64.length).toBeLessThanOrEqual(REVIEW_IMAGE_BASE64_MAX);
    expect(Math.max(img.width, img.height)).toBeLessThanOrEqual(1600);
  }, LONG);
});
