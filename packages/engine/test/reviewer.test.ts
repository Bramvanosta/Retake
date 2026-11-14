/**
 * The Reviewer port (L7.11): its contract (reviewer-contract.ts) on the review package — synthetic renders drawn with
 * ffmpeg (the review tests' helpers), skipped without ffmpeg / ffprobe — and on the in-memory reviewer (renders whose
 * files are empty: no tool runs). Then the façade's use of the reviewer it is handed (createEngine `ports.reviewer`):
 * a run's thumbnails, a render's frame, a review's image and a workspace thumbnail all come from that reviewer's
 * frames — both the run thumbnails and the render frames, never the product's default beside it.
 */
import { mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PERSON_POLICY } from '@retake/core';
import { RENDER_FRAME_MAX_PX, REVIEW_IMAGE_BASE64_MAX, REVIEW_IMAGE_MAX_PX, createEngine, packageReviewer } from '../src/index.js';
import { RENDER_FRAME_QUALITY } from '../src/render-frames.js';
import { findPrevious, findRender } from '@retake/review';
import { previousOfRender } from '../src/render-records.js';
import { MEMORY_JPEG, MemoryReviewer } from '../src/review/memory-reviewer.js';
import type { MemoryReviewerCall } from '../src/review/memory-reviewer.js';
import { hasTool } from '@retake/test-support/repo';
import { makeCase, scenesTimeline, workspace } from '@retake/test-support/review';
import type { Case, Workspace } from '@retake/test-support/review';
import { fixtureWorkspace } from '@retake/test-support/workspace';
import { BLOCKS_YAML, RED, writeRun } from '@retake/test-support/runs';
import { reviewerContract } from './reviewer-contract.js';
import { scratchHome } from '@retake/test-support/home';

const can = hasTool('ffmpeg') && hasTool('ffprobe');
const retakeHome = scratchHome();
const spaces: Workspace[] = [];
const dirs: string[] = [];

/** One workspace per adapter, made on first use: the case's render drawn (real) or left empty (memory). */
function caseOnce(noVideo: boolean): () => Promise<{ ws: Workspace; c: Case }> {
  let made: Promise<{ ws: Workspace; c: Case }> | undefined;
  return () =>
    (made ??= (async () => {
      const ws = await workspace();
      spaces.push(ws);
      const c = await makeCase(ws, 'quote', scenesTimeline([2, 2]), { noVideo });
      return { ws, c };
    })());
}

const real = caseOnce(false);
const memory = caseOnce(true);

beforeAll(async () => {
  const home = await mkdtemp(join(tmpdir(), 'retake-reviewer-home-'));
  dirs.push(home);
  retakeHome.use(home);
});

afterAll(async () => {
  retakeHome.restore();
  for (const ws of spaces) await ws.cleanup();
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

reviewerContract(
  'the review package (packageReviewer)',
  async () => {
    const { ws, c } = await real();
    return { reviewer: packageReviewer(), project: ws.project, render: c.record.id, video: c.record.file, durationS: c.record.duration_s };
  },
  { skip: !can, timeout: 300_000 },
);

reviewerContract('the in-memory reviewer (MemoryReviewer)', async () => {
  const { ws, c } = await memory();
  return { reviewer: new MemoryReviewer({ videoS: c.record.duration_s }), project: ws.project, render: c.record.id, video: c.record.file, durationS: c.record.duration_s };
});

const ops = (calls: MemoryReviewerCall[]) => calls.map((x) => x.op);

describe('the façade draws with the reviewer it is handed (ports.reviewer)', () => {
  it('run thumbnails, a workspace thumbnail and a review image: the handed reviewer frames, no other', async () => {
    const root = await mkdtemp(join(tmpdir(), 'retake-reviewer-facade-'));
    dirs.push(root);
    await fixtureWorkspace(root);
    const projectDir = join(root, 'projects', 'northfield-fixture');
    await writeFile(join(projectDir, 'scenarios', 'blocks.yaml'), BLOCKS_YAML);
    await writeRun(projectDir, {
      id: '20261020-110000-blocks',
      scenario: 'blocks',
      mode: 'dry',
      snapshot: BLOCKS_YAML,
      scenes: [{ id: 'one' }],
      events: [{ scene: 'one', step: 0, action: 'click', t_start: 0, t_end: 0.5 }],
      screenshots: { 'one-00-click.png': RED },
    });
    const fake = new MemoryReviewer();
    const engine = await createEngine({ root, client: 'ui', autoStartWorker: false, ports: { reviewer: fake } });
    const v = await engine.runs.thumbs('northfield-fixture', '20261020-110000-blocks', ['one.0']);
    expect(v.thumbs).toMatchObject([{ key: 'one.0', from: 'screenshot', width: 1, height: 1, base64: MEMORY_JPEG.toString('base64') }]);
    expect(ops(fake.calls)).toEqual(['frames.thumb']);
    const shot = join(projectDir, 'runs', '20261020-110000-blocks', 'screenshots', 'one-00-click.png');
    expect(await engine.thumbnail(shot, 4000)).toMatchObject({ width: 1, height: 1 });
    // The façade's clamp (64–1280) is the engine's, whatever reviewer draws.
    expect(fake.calls.at(-1)).toEqual({ op: 'frames.thumbnailOf', file: shot, maxPx: 1280 });
    await engine.thumbnail(shot, 1);
    expect(fake.calls.at(-1)).toEqual({ op: 'frames.thumbnailOf', file: shot, maxPx: 64 });
  });

  it.skipIf(!can)(
    'a render frame and a review image: the handed reviewer frames (the render probed by the engine)',
    async () => {
      const { ws, c } = await real();
      const fake = new MemoryReviewer();
      const engine = await createEngine({ root: ws.root, client: 'ui', autoStartWorker: false, ports: { reviewer: fake } });
      const f = await engine.renders.frame('demo', { render_id: c.record.id, created_at: c.record.created_at, frame: 3 });
      expect(f).toMatchObject({ render_id: c.record.id, frame: 3, width: 1, height: 1, base64: MEMORY_JPEG.toString('base64') });
      expect(ops(fake.calls)).toEqual(['frames.at', 'frames.thumb']);
      expect(fake.calls[0]).toMatchObject({ op: 'frames.at', o: { maxPx: RENDER_FRAME_MAX_PX } });
      expect(fake.calls[1]).toMatchObject({ op: 'frames.thumb', o: { maxPx: RENDER_FRAME_MAX_PX, quality: RENDER_FRAME_QUALITY } });
      // A real review folder, its sheet then shown through the handed reviewer.
      await packageReviewer().review({ policy: PERSON_POLICY, project: ws.project, render: c.record.id, thumbnails: false });
      const img = await engine.reviews.image('demo', c.record.id, 'sheet_1fps.jpg');
      expect(img).toMatchObject({ mime: 'image/jpeg', width: 1, height: 1 });
      expect(fake.calls.at(-1)).toMatchObject({ op: 'frames.thumb', o: { maxPx: REVIEW_IMAGE_MAX_PX, quality: 80 } });
    },
    300_000,
  );
});

describe("a review image: the engine's caps around the reviewer's thumb (reviews.image)", () => {
  it('a JPEG over REVIEW_IMAGE_BASE64_MAX is made again smaller (1100 px, quality 70); one still too large is refused', async () => {
    const { ws, c } = await memory();
    const fake = new MemoryReviewer();
    await fake.review({ policy: PERSON_POLICY, project: ws.project, render: c.record.id, thumbnails: false });
    const big = { data: Buffer.alloc(Math.ceil((REVIEW_IMAGE_BASE64_MAX * 3) / 4) + 3, 1), width: 1600, height: 900 };
    const small = { data: MEMORY_JPEG, width: 1100, height: 619 };
    const asked: unknown[] = [];
    let answers = [big, small];
    const reviewer = {
      review: (o: Parameters<MemoryReviewer['review']>[0]) => fake.review(o),
      recover: (d: string) => fake.recover(d),
      frames: { ...fake.frames, thumb: async (_b: Buffer, o?: unknown) => (asked.push(o), answers.shift()!) },
    };
    const engine = await createEngine({ root: ws.root, client: 'ui', autoStartWorker: false, ports: { reviewer } });
    const img = await engine.reviews.image('demo', c.record.id, 'sheet_1fps.jpg');
    expect(asked).toEqual([
      { maxPx: REVIEW_IMAGE_MAX_PX, quality: 80 },
      { maxPx: 1100, quality: 70 },
    ]);
    expect(img).toMatchObject({ width: 1100, height: 619, base64: MEMORY_JPEG.toString('base64') });
    // Within the cap the first time: no second pass.
    asked.length = 0;
    answers = [small];
    expect(await engine.reviews.image('demo', c.record.id, 'sheet_1fps.jpg')).toMatchObject({ width: 1100 });
    expect(asked).toHaveLength(1);
    // Too large twice: refused, never answered whole.
    answers = [big, big];
    await expect(engine.reviews.image('demo', c.record.id, 'sheet_1fps.jpg')).rejects.toMatchObject({ code: 'refused', message: expect.stringMatching(/stays too large once scaled/) });
  });

  it('frames that cannot be loaded fail the call with their own error, never as an image that cannot be decoded (L7.11 fix pass)', async () => {
    const { ws, c } = await memory();
    const fake = new MemoryReviewer();
    await fake.review({ policy: PERSON_POLICY, project: ws.project, render: c.record.id, thumbnails: false });
    const broken = new Error('the thumbnail entry cannot be loaded');
    const reviewer = {
      review: (o: Parameters<MemoryReviewer['review']>[0]) => fake.review(o),
      recover: (d: string) => fake.recover(d),
      frames: { ...fake.frames, load: () => Promise.reject(broken) },
    };
    const engine = await createEngine({ root: ws.root, client: 'ui', autoStartWorker: false, ports: { reviewer } });
    await expect(engine.reviews.image('demo', c.record.id, 'sheet_1fps.jpg')).rejects.toBe(broken);
    expect(fake.calls.filter((x) => x.op === 'frames.thumb')).toEqual([]);
  });
});

describe("the render a review job compares with (the engine's previousOfRender, over core)", () => {
  it("is the review package's default (findPrevious): the last succeeded render of the scenario and variant before it, whose video is there", async () => {
    const ws = await workspace();
    spaces.push(ws);
    const t = () => scenesTimeline([2, 2]);
    const v1 = await makeCase(ws, 'quote', t(), { noVideo: true });
    const run = v1.run;
    const v2 = await makeCase(ws, 'quote', t(), { noVideo: true, version: 2, run });
    const v3 = await makeCase(ws, 'quote', t(), { noVideo: true, version: 3, run });
    const v4 = await makeCase(ws, 'quote', t(), { noVideo: true, version: 4, run, overrides: { variant: 'vertical' } });
    await makeCase(ws, 'other', t(), { noVideo: true });
    // v3's video gone: v4 (another variant) has none before it, v3 is passed over by a later one.
    const v5 = await makeCase(ws, 'quote', t(), { noVideo: true, version: 5, run });
    await unlink(v3.record.file);
    const seen: Record<string, string> = {};
    for (const c of [v1, v2, v3, v4, v5]) {
      const engine = (await previousOfRender(ws.project.dir, c.record))?.id ?? 'none';
      const pkg = (await findPrevious(ws.project, await findRender(ws.project, c.record.id), undefined))?.id ?? 'none';
      expect(engine, c.record.id).toBe(pkg);
      seen[c.record.id] = engine;
    }
    expect(seen).toEqual({ 'quote-v1': 'none', 'quote-v2': 'quote-v1', 'quote-v3': 'quote-v2', 'quote-v4': 'none', 'quote-v5': 'quote-v2' });
  });
});
