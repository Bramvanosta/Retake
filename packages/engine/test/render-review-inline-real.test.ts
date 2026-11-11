/**
 * L7.11 fix pass: one real inline review through the worker in the default suite (render-review-inline.test.ts runs
 * the same job on the in-memory renderer and reviewer). The renderer is the in-memory one with its video drawn by
 * ffmpeg from the plan (review/test/helpers.ts drawRender: no bundle, no browser); the reviewer is the product's
 * (`packageReviewer`): its sheets, key frames and report are the review package's, written next to the render. Then a
 * cancel through the job: the job is cancelled while its review is about to run (the reviewer waits for the job's
 * signal, then the real review starts on it): the render stays the job's result, its review `cancelled`, the earlier
 * review kept. A cancel in the middle of a stage is the reviewer contract's (reviewer.test.ts, the real package on a
 * synthetic render). Skipped without ffmpeg and ffprobe.
 */
import { createHash } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEngine, packageReviewer, runWorker } from '../src/index.js';
import type { Engine, RenderJobResult, Renderer, Reviewer } from '../src/index.js';
import { MemoryRenderer } from '../src/render/memory-renderer.js';
import { synthTimeline } from '../../editor/test/helpers.js';
import { TEMPLATES, syntheticRunRecord } from '../../editor/test/render-helpers.js';
import { drawCapture, drawRender, hasTool } from '../../review/test/helpers.js';

const can = hasTool('ffmpeg') && hasTool('ffprobe');
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
const savedHome = process.env.RETAKE_HOME;

/** The in-memory renderer, its video drawn by ffmpeg from the plan: a real file for the real review to read. */
function drawingRenderer(): Renderer {
  const memory = new MemoryRenderer();
  return {
    video: async (req) => {
      const r = await memory.video(req);
      drawRender(req.plan, req.out);
      return { ...r, size_bytes: statSync(req.out).size };
    },
    stills: (req) => memory.stills(req),
    previews: memory.previews,
  };
}

const worker = (reviewer: Reviewer) => runWorker({ root, once: true, idleExitMs: 0, pollMs: 50, log: () => undefined, ports: { renderer: drawingRenderer(), reviewer } });

beforeAll(async () => {
  if (!can) return;
  root = await mkdtemp(join(tmpdir(), 'retake-render-review-real-'));
  process.env.RETAKE_HOME = join(root, '.home');
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
  drawCapture(join(runDir, 'capture.mp4'), 2);
  engine = await createEngine({ root, client: 'test', autoStartWorker: false });
}, 120_000);

afterAll(async () => {
  if (savedHome === undefined) delete process.env.RETAKE_HOME;
  else process.env.RETAKE_HOME = savedHome;
  if (root) await rm(root, { recursive: true, force: true });
});

describe.skipIf(!can)('a render reviewed inline by the review package, through the worker (L7.11 fix pass)', () => {
  it('the job renders, then the real review writes its report and sheets next to the render', async () => {
    const sub = await engine.renders.submit({ project: 'demo', scenario: SCENARIO, run_id: RUN, overrides: { scale: 0.5 }, review: { fps: 1 }, expect_edit_sha256: sha(TEXT) });
    expect(await worker(packageReviewer())).toBe(0);
    const job = await engine.jobs.get(sub.job.id);
    expect(job.state, JSON.stringify(job.error)).toBe('succeeded');
    const result = job.result as RenderJobResult;
    expect(result.review, JSON.stringify(result)).toMatchObject({ state: 'succeeded', counts: { error: expect.any(Number), warning: expect.any(Number), info: expect.any(Number) } });
    const reviewDir = join(dir, 'review', sub.render_id);
    const report = JSON.parse(await readFile(join(reviewDir, 'report.json'), 'utf8')) as { render: { id: string }; counts: unknown };
    expect(report.render.id).toBe(sub.render_id);
    expect(result.review).toMatchObject({ counts: report.counts });
    expect(existsSync(join(reviewDir, 'report.md'))).toBe(true);
    const sheets = (await readdir(reviewDir)).filter((f) => /^sheet_1fps(_p\d+)?\.jpg$/.test(f));
    expect(sheets.length).toBeGreaterThan(0);
    expect((await readFile(join(reviewDir, sheets[0]!))).subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
    // The engine's own reads of it: the verdict in the render list, a sheet through the product's frames.
    const img = await engine.reviews.image('demo', sub.render_id, sheets[0]!);
    expect(Buffer.from(img.base64, 'base64').subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
  }, 300_000);

  it('a cancel through the job: the render stays its result, its review cancelled, the earlier review of the id kept', async () => {
    const sub = await engine.renders.submit({ project: 'demo', scenario: SCENARIO, run_id: RUN, overrides: { scale: 0.5 }, review: { fps: 1 }, expect_edit_sha256: sha(TEXT) });
    // An earlier review folder of the same id: the cancelled review must leave it as it was.
    const reviewDir = join(dir, 'review', sub.render_id);
    await mkdir(reviewDir, { recursive: true });
    await writeFile(join(reviewDir, 'report.json'), '{"earlier":true}\n');
    const real = packageReviewer();
    let waited = false;
    const reviewer: Reviewer = {
      ...real,
      review: async (o) => {
        // The job is cancelled now, as a person would from the Studio; its signal reaches the review.
        await engine.jobs.cancel(sub.job.id);
        const deadline = Date.now() + 20_000;
        while (!o.signal?.aborted && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
        waited = o.signal?.aborted === true;
        return real.review(o);
      },
    };
    expect(await worker(reviewer)).toBe(0);
    expect(waited).toBe(true);
    const job = await engine.jobs.get(sub.job.id);
    const result = job.result as RenderJobResult | undefined;
    // The render is done and stays the job's result; the review says it was cancelled.
    expect(result?.review, JSON.stringify(job)).toEqual({ state: 'cancelled' });
    expect(await readFile(join(reviewDir, 'report.json'), 'utf8')).toBe('{"earlier":true}\n');
    expect((await readdir(join(dir, 'review'))).filter((n) => n.startsWith(`${sub.render_id}.`))).toEqual([]);
  }, 300_000);
});
