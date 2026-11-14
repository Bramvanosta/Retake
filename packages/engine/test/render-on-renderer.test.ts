/**
 * The engine renders through its port (src/render/renderer.ts): render jobs run by the worker in this process on the
 * in-memory renderer (WorkerOptions.ports.renderer), a still and a render asked in process on the same one. No bundle, no
 * browser, and no ffmpeg / ffprobe: both tools are pointed at a path that does not exist for the whole file, so a call
 * to either would fail the job. What still runs around the renderer is the product's: the submit, the claim, the plan
 * (the editor's planner), the version reserved, the render record, the job's state and the history line.
 * - a render job succeeds: the record of the render (no `probe`: the renderer measured nothing), the file the renderer
 *   wrote, the renderer's process recorded for the job, one history line;
 * - a job cancelled while the renderer draws ends `cancelled` (not `failed`), nothing is left;
 * - a renderer's failure ends the job `failed`;
 * - a still and a render in process ask the same renderer, with no network guard (a person's work); a failure or a
 *   cancel there comes back as the editor's error, whose record keeps the policy and the warnings the failure carried.
 * - the options of the editor's own driver are refused beside the renderer, and a worker is handed a renderer or a
 *   preview backend, never both.
 * No job asks for a review here: a review reads the video's frames with ffmpeg.
 */
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PERSON_POLICY } from '@retake/core';
import type { RenderJobInput } from '@retake/engine';
import { JobFiles, createEngine, editorErrorOf, historyFile, jobsDir, openProject, planWork, renderInProcess, runWorker, stillInProcess, withPreviewBackend } from '../src/index.js';
import type { Engine, JobRecord, RenderRecord } from '../src/index.js';
import { ManualClock, systemClock } from '../src/clock.js';
import { MEMORY_PNG, MEMORY_VIDEO, MemoryRenderer } from '../src/render/memory-renderer.js';
import type { MemoryRendererOptions } from '../src/render/memory-renderer.js';
import type { RenderVideoRequest } from '../src/render/renderer.js';
import { bundleHash } from '@retake/editor';
import type { PreviewBackend } from '@retake/editor';
import { synthTimeline } from '@retake/test-support/timeline';
import { TEMPLATES } from '@retake/test-support/repo';
import { syntheticRunRecord } from '@retake/test-support/render';
import { scratchHome } from '@retake/test-support/home';

const SCENARIO = 'steps';
const RUN = '20260101-120000-steps';
let root: string;
let dir: string;
let engine: Engine;
const retakeHome = scratchHome('RETAKE_FFMPEG', 'RETAKE_FFPROBE');

const historyLines = async (): Promise<Array<Record<string, unknown>>> =>
  (await readFile(historyFile(root), 'utf8').catch(() => ''))
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
const recordOf = async (id: string): Promise<RenderRecord> => JSON.parse(await readFile(join(dir, 'renders', `${id}.json`), 'utf8')) as RenderRecord;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'retake-render-port-'));
  retakeHome.use(join(root, '.home'));
  process.env.RETAKE_FFMPEG = join(root, 'no-such-tool', 'ffmpeg');
  process.env.RETAKE_FFPROBE = join(root, 'no-such-tool', 'ffprobe');
  await writeFile(join(root, 'retake.yaml'), `projects_dir: projects\ntemplates_dir: ${JSON.stringify(TEMPLATES)}\n`);
  dir = join(root, 'projects', 'demo');
  const runDir = join(dir, 'runs', RUN);
  await mkdir(runDir, { recursive: true });
  await writeFile(join(dir, 'project.yaml'), 'name: Demo\nenvironments:\n  local: {app: "http://app.test"}\ntemplate: editorial\n');
  const t = synthTimeline({
    duration: 2,
    entries: [{ id: 'a', t_start: 0.5, t_end: 1.5, steps: [{ action: 'hold', t_start: 0.5, t_end: 1.5 }] }],
    video: { intro: false, outro: false, template: 'editorial' },
  });
  t.run_id = RUN;
  t.project = 'demo';
  t.scenario = SCENARIO;
  await writeFile(join(runDir, 'timeline.json'), JSON.stringify(t));
  // A run `latest` takes has its record (L7.6a: a folder without a readable run.json is never the latest capture).
  await writeFile(join(runDir, 'run.json'), JSON.stringify(syntheticRunRecord(runDir, { id: RUN, scenario: SCENARIO, project: 'demo' })));
  await writeFile(join(runDir, 'capture.mp4'), 'never read');
  engine = await createEngine({ root, client: 'test', autoStartWorker: false });
});

afterAll(async () => {
  retakeHome.restore();
  if (root) await rm(root, { recursive: true, force: true });
});

/** Submit a render (no review) and let a worker of this process run it on `o`'s renderer. */
async function renderJob(o: MemoryRendererOptions | ((job: JobRecord) => MemoryRendererOptions) = {}): Promise<{ job: JobRecord; input: RenderJobInput; fake: MemoryRenderer }> {
  const sub = await engine.renders.submit({ project: 'demo', scenario: SCENARIO });
  const fake = new MemoryRenderer(typeof o === 'function' ? o(sub.job) : o);
  await runWorker({ root, once: true, idleExitMs: 0, pollMs: 20, log: () => undefined, heavyInProcess: true, ports: { renderer: fake } });
  return { job: await engine.jobs.get(sub.job.id), input: sub.job.input as RenderJobInput, fake };
}

describe('render jobs on the renderer the worker was handed', () => {
  it('a render job succeeds with no browser and no ffmpeg / ffprobe: record, file, process, history line', async () => {
    const before = await historyLines();
    // The renderer's process is recorded for the job while it renders (what a crashed worker's successor kills).
    let recorded: { pid?: number } = {};
    const { job, input, fake } = await renderJob((submitted) => ({
      process: { pid: process.pid },
      warnings: ['said by the renderer'],
      duringVideo: async () => {
        const file = new JobFiles(jobsDir(root)).browser(submitted.id);
        for (let i = 0; i < 200 && !existsSync(file); i++) await new Promise((r) => setTimeout(r, 25));
        recorded = JSON.parse(await readFile(file, 'utf8')) as { pid: number };
      },
    }));
    expect(job.error).toBeUndefined();
    expect(recorded.pid).toBe(process.pid);
    expect(existsSync(new JobFiles(jobsDir(root)).browser(job.id))).toBe(false);
    expect(job.state).toBe('succeeded');
    // The renderer was asked once, for the job's plan, guarded like every job's render.
    expect(fake.calls.map((c) => c.op)).toEqual(['video']);
    const req = fake.calls[0].req as RenderVideoRequest;
    expect(req.network).toBe('guard');
    expect(req.plan.durationInFrames).toBeGreaterThan(0);
    expect(req.signal).toBeInstanceOf(AbortSignal);
    // The record is the editor's, filled with what the renderer said; nothing was probed.
    const record = await recordOf(input.render_id);
    expect(record).toMatchObject({ id: input.render_id, status: 'succeeded', run_id: RUN, scenario: SCENARIO, size_bytes: MEMORY_VIDEO.length, frames: req.plan.durationInFrames });
    expect(record.policy).toMatchObject({ gl: { used: 'software' }, encoder: { used: 'libx264' } });
    expect(record.encoding.encoder).toBe('libx264');
    expect(record.browser.source).toBe('none');
    expect(record.warnings).toContain('said by the renderer');
    expect(record).not.toHaveProperty('probe');
    expect(await readFile(record.file)).toEqual(MEMORY_VIDEO);
    expect(job.result).toMatchObject({ kind: 'render', render_id: input.render_id, run_id: RUN, size_bytes: MEMORY_VIDEO.length, bundle_cached: false });
    // The progress the renderer reported is the job's.
    expect(job.progress).toMatchObject({ phase: 'done', fraction: 1, steps_total: req.plan.durationInFrames });
    // One history line, the worker's.
    const added = (await historyLines()).slice(before.length);
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ kind: 'render', project: 'demo', state: 'succeeded', counted: { captures: 0, dry_runs: 0, renders: 1 } });
  });

  it('the worker stamps a job with the clock it was handed: started_at, finished_at, the progress and the history line', async () => {
    const at = '2030-01-02T03:04:05.006Z';
    const before = await historyLines();
    const sub = await engine.renders.submit({ project: 'demo', scenario: SCENARIO });
    await runWorker({ root, once: true, idleExitMs: 0, pollMs: 20, log: () => undefined, heavyInProcess: true, ports: { renderer: new MemoryRenderer(), clock: new ManualClock(at) } });
    const job = await engine.jobs.get(sub.job.id);
    expect(job.state, JSON.stringify(job.error)).toBe('succeeded');
    expect([job.started_at, job.finished_at, job.progress?.updated_at]).toEqual([at, at, at]);
    // created_at is the submitting engine's (its own clock, the system's here).
    expect(job.created_at).not.toBe(at);
    const added = (await historyLines()).slice(before.length);
    expect(added).toEqual([expect.objectContaining({ kind: 'render', job: sub.job.id, at })]);
  });

  it('a job cancelled while the renderer draws ends cancelled, not failed: no file and no record are left', async () => {
    const { job, input, fake } = await renderJob((submitted) => ({
      duringVideo: async (req) => {
        await engine.jobs.cancel(submitted.id);
        // The worker sees the cancel and aborts the job's signal: the renderer's own.
        await new Promise<void>((done) => (req.signal!.aborted ? done() : req.signal!.addEventListener('abort', () => done(), { once: true })));
      },
    }));
    expect(fake.calls).toHaveLength(1);
    expect(job.state).toBe('cancelled');
    expect(job.error?.code).toBe('cancelled');
    expect(existsSync(join(dir, 'renders', `${input.render_id}.mp4`))).toBe(false);
    expect(existsSync(join(dir, 'renders', `${input.render_id}.json`))).toBe(false);
  });

  it("a renderer's failure ends the job failed, nothing left", async () => {
    const { job, input } = await renderJob({
      duringVideo: () => {
        throw new Error('the renderer lost its GPU');
      },
    });
    expect(job.state).toBe('failed');
    expect(job.error?.message).toContain('the renderer lost its GPU');
    expect(existsSync(join(dir, 'renders', `${input.render_id}.mp4`))).toBe(false);
  });
});

describe('one renderer, and nothing beside it', () => {
  it('a worker is handed one renderer (L7.29): with a preview backend made a renderer of its own (withPreviewBackend), a library preview draws on the backend while a render draws its video on the base renderer', async () => {
    const fake = new MemoryRenderer();
    const drawn: string[] = [];
    // A stand-in for the editor's preview driver (Remotion): bundle folders, small PNG / GIF files.
    const backend: PreviewBackend = {
      async bundle({ root: r, components }) {
        const hash = await bundleHash(components);
        const at = join(r, '.retake', 'cache', `remotion-${hash}`);
        await mkdir(at, { recursive: true });
        return { serveUrl: at, hash, cached: false };
      },
      async open() {
        return {
          still: async (spec, file) =>
            void (drawn.push(`still ${spec.main.id}`), await writeFile(file, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('poster')]))),
          gif: async (spec, file) => void (drawn.push(`gif ${spec.main.id}`), await writeFile(file, Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.from('loop')]))),
          warnings: () => [],
          close: async () => undefined,
        };
      },
    };
    const ports = { renderer: withPreviewBackend(fake, backend), freeBytes: async () => 50_000_000_000 };
    const work = () => runWorker({ root, once: true, idleExitMs: 0, pollMs: 20, log: () => undefined, heavyInProcess: true, ports });
    const states = await engine.components.library({ project: 'demo', template: 'editorial', components: ['studio/card-title'] });
    const library = await engine.components.libraryRender({ project: 'demo', template: 'editorial', items: [{ component: 'studio/card-title', loop: states.items[0].loop.key }] });
    await work();
    const previewed = await engine.jobs.get(library.job.id);
    expect(previewed.state, JSON.stringify(previewed.error)).toBe('succeeded');
    expect(drawn).toEqual(['gif studio/card-title']);
    const render = await engine.renders.submit({ project: 'demo', scenario: SCENARIO });
    await work();
    const rendered = await engine.jobs.get(render.job.id);
    expect(rendered.state, JSON.stringify(rendered.error)).toBe('succeeded');
    // The base renderer drew the video and nothing of the previews; the backend drew nothing more.
    expect(fake.calls.map((c) => c.op)).toEqual(['video']);
    expect(drawn).toEqual(['gif studio/card-title']);
  });

  it("the options of the editor's own driver (a cache folder, a preview backend) are refused beside the renderer, which is asked nothing", async () => {
    const project = await openProject(engine.workspace, 'demo');
    const fake = new MemoryRenderer();
    const planned = await planWork({ workPolicy: PERSON_POLICY, project, run: RUN, scenario: SCENARIO, root });
    const render = { renderer: fake, workPolicy: PERSON_POLICY, project, root, run: RUN, scenario: SCENARIO, cacheDir: join(root, 'cache') };
    await expect(renderInProcess(render as never)).rejects.toThrow("render: cacheDir is an option of the editor's own renderer and cannot go with a renderer that is handed");
    const still = { renderer: fake, workPolicy: PERSON_POLICY, plan: planned.plan, frame: 0, out: join(root, 'stills', 'refused.png'), root, project, cacheDir: join(root, 'cache') };
    await expect(stillInProcess(still as never)).rejects.toThrow('still: cacheDir is an option');
    expect(fake.calls).toEqual([]);
    expect(existsSync(join(root, 'stills', 'refused.png'))).toBe(false);
  });
});

describe('work in process on the renderer its caller hands', () => {
  it('a still and a render ask that renderer, unguarded, and write their history lines', async () => {
    const project = await openProject(engine.workspace, 'demo');
    const fake = new MemoryRenderer();
    const before = await historyLines();
    const planned = await planWork({ workPolicy: PERSON_POLICY, project, run: RUN, scenario: SCENARIO, root });
    const out = join(root, 'stills', 'frame.png');
    expect(await stillInProcess({ renderer: fake, workPolicy: PERSON_POLICY, plan: planned.plan, frame: 3, out, root, project, clock: systemClock })).toBe(out);
    expect(await readFile(out)).toEqual(MEMORY_PNG);
    const record = await renderInProcess({ renderer: fake, workPolicy: PERSON_POLICY, project, root, run: RUN, scenario: SCENARIO, clock: systemClock });
    expect(record.status).toBe('succeeded');
    expect(await readFile(record.file)).toEqual(MEMORY_VIDEO);
    expect(fake.calls.map((c) => c.op)).toEqual(['stills', 'video']);
    expect(fake.calls[0].req).toMatchObject({ frames: [{ frame: 3, out }] });
    expect(fake.calls[0].req).not.toHaveProperty('network');
    expect(fake.calls[1].req).not.toHaveProperty('network');
    expect((await historyLines()).slice(before.length).map((l) => [l.kind, l.submitted_by, l.state])).toEqual([
      ['still', 'cli', 'succeeded'],
      ['render', 'cli', 'succeeded'],
    ]);
  });

  it("a failure and a cancel of the renderer come back as the editor's errors, the record on them: its policy, its warnings, its status; no history line", async () => {
    const project = await openProject(engine.workspace, 'demo');
    const before = await historyLines();
    const path = {
      gl: { asked: 'angle', source: 'option', resolved: 'angle', used: 'angle' },
      encoder: { asked: 'auto', source: 'default', used: 'h264_videotoolbox' },
      concurrency_source: 'default',
    };
    const failing = new MemoryRenderer({
      duringVideo: () => {
        throw Object.assign(new Error('the renderer lost its GPU'), { renderPath: path, renderWarnings: ['seen before it failed'] });
      },
    });
    const failed = (await renderInProcess({ renderer: failing, workPolicy: PERSON_POLICY, project, root, run: RUN, scenario: SCENARIO, clock: systemClock }).catch((e: unknown) => e)) as Error & {
      record: RenderRecord;
    };
    expect(await editorErrorOf(failed)).toBe('render');
    expect(failed.message).toBe('the renderer lost its GPU');
    expect(failed.record).toMatchObject({ status: 'failed', error: 'the renderer lost its GPU', policy: path });
    expect(failed.record.warnings).toContain('seen before it failed');
    const stop = new AbortController();
    const stopped = new MemoryRenderer({ duringVideo: () => stop.abort() });
    const cancelled = (await renderInProcess({ renderer: stopped, workPolicy: PERSON_POLICY, project, root, run: RUN, scenario: SCENARIO, signal: stop.signal, clock: systemClock }).catch(
      (e: unknown) => e,
    )) as Error & { record: RenderRecord };
    expect(await editorErrorOf(cancelled)).toBe('render_cancelled');
    expect(cancelled.record.status).toBe('cancelled');
    expect(existsSync(cancelled.record.file)).toBe(false);
    expect(await historyLines()).toEqual(before);
  });
});
