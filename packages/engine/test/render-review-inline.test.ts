/**
 * L4.5 part E: a render with its inline review (critique B12), through the worker — the Studio's Render: submitted
 * like `scenario_render` (the scenario file's edit, `review: {fps: 1}`, `expect_edit_sha256`), rendered and reviewed
 * in the same job; then the engine's reads the Studio shows: renders.ofScenario (path-free: the render, its review's
 * verdict) and reviews.image (a contact sheet as a JPEG). L7.11: on the ports — the in-memory renderer and reviewer
 * (WorkerOptions.ports; the engine's `ports.reviewer` for the image), no bundle, no browser and no ffmpeg / ffprobe
 * (both pointed at a path that does not exist): what runs around them is the product's (the submit, the plan, the
 * render record, the review job's own execution inside the render job, the job's result, the views). The real review
 * of a render runs end to end in review-export-jobs.test.ts and pipeline.test.ts.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REVIEW_IMAGE_BASE64_MAX, createEngine, runWorker } from '../src/index.js';
import type { Engine, RenderJobResult } from '../src/index.js';
import { MemoryRenderer } from '../src/render/memory-renderer.js';
import { MemoryReviewer } from '../src/review/memory-reviewer.js';
import { synthTimeline } from '@retake/test-support/timeline';
import { TEMPLATES } from '@retake/test-support/repo';
import { syntheticRunRecord } from '@retake/test-support/render';
import { scratchHome } from '@retake/test-support/home';

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
const reviewer = new MemoryReviewer({ findings: [{ severity: 'warning', code: 'long-wait', message: 'a wait of the take' }] });
const retakeHome = scratchHome('RETAKE_FFMPEG', 'RETAKE_FFPROBE');

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'ds-render-review-'));
  retakeHome.use(join(root, '.home'));
  process.env.RETAKE_FFMPEG = join(root, 'no-such-tool', 'ffmpeg');
  process.env.RETAKE_FFPROBE = join(root, 'no-such-tool', 'ffprobe');
  await writeFile(join(root, 'retake.yaml'), `projects_dir: projects\ntemplates_dir: ${JSON.stringify(TEMPLATES)}\n`);
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
  await writeFile(join(runDir, 'run.json'), JSON.stringify(syntheticRunRecord(runDir, { id: RUN, scenario: SCENARIO, project: 'demo' })));
  await writeFile(join(runDir, 'scenario.yaml'), TEXT);
  await writeFile(join(dir, 'scenarios', `${SCENARIO}.yaml`), TEXT);
  await writeFile(join(runDir, 'capture.mp4'), 'never read');
  engine = await createEngine({ root, client: 'test', autoStartWorker: false, ports: { reviewer } });
});

afterAll(async () => {
  retakeHome.restore();
  if (root) await rm(root, { recursive: true, force: true });
});

describe('a render reviewed inline, through the worker (L4.5 part E)', () => {
  it('renders the shown version, reviews it in the same job; the render list and a contact sheet, path-free', async () => {
    const sub = await engine.renders.submit({ project: 'demo', scenario: SCENARIO, run_id: RUN, overrides: { scale: 0.5 }, review: { fps: 1 }, expect_edit_sha256: sha(TEXT) });
    expect(sub).toMatchObject({ render_id: `${SCENARIO}-v1`, edit: 'scenario' });
    const queued = await engine.renders.ofScenario('demo', SCENARIO);
    expect(queued.jobs).toMatchObject([{ id: sub.job.id, render_id: sub.render_id, state: 'queued', edit_sha256: sha(TEXT), reviewing: false, queue: { ahead: 0 } }]);
    expect(queued.renders).toEqual([]);

    const renderer = new MemoryRenderer();
    expect(await runWorker({ root, once: true, idleExitMs: 0, pollMs: 50, log: () => undefined, heavyInProcess: true, ports: { renderer, reviewer } })).toBe(0);
    const job = await engine.jobs.get(sub.job.id);
    expect(job.state, JSON.stringify(job.error)).toBe('succeeded');
    const result = job.result as RenderJobResult;
    expect(result.review).toMatchObject({ state: 'succeeded', clean: false, counts: { error: 0, warning: 1, info: 0 } });
    // The render job's review is the review job's own execution: the render named by its id, no thumbnails, its signal.
    const asked = reviewer.calls.filter((c) => c.op === 'review');
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ op: 'review', o: { render: sub.render_id, fps: 1, previous: false, thumbnails: false, signal: expect.any(AbortSignal) } });
    expect(renderer.calls.map((c) => c.op)).toEqual(['video']);
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
    expect(r.review.state).toBe('warnings');
    const report = JSON.parse(await readFile(join(reviewDir, 'report.json'), 'utf8')) as { counts: { error: number; warning: number } };
    expect(r.review).toMatchObject({ counts: { error: report.counts.error, warning: report.counts.warning } });
    const text = JSON.stringify(after);
    for (const needle of [root, homedir(), '.mp4', 'report.json']) expect(text.includes(needle), needle).toBe(false);

    // A contact sheet as a JPEG within the cap, drawn by the engine's reviewer.
    const img = await engine.reviews.image('demo', sub.render_id, sheets[0]);
    expect(Buffer.from(img.base64, 'base64').subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
    expect(img.base64.length).toBeLessThanOrEqual(REVIEW_IMAGE_BASE64_MAX);
    expect(Math.max(img.width, img.height)).toBeLessThanOrEqual(1600);
    expect(reviewer.calls.at(-1)).toMatchObject({ op: 'frames.thumb', o: { maxPx: 1600, quality: 80 } });
  });
});
