/**
 * The pipeline shared by the CLI and the worker's jobs (src/pipeline.ts) and the in-process functions of the CLI
 * (src/in-process.ts). The heavy calls are replaced at their package boundary (the editor's renderVideo and
 * exportRender, the review's reviewRender) to see what each caller hands them:
 * - a render, export or review job passes the trust of work submitted through MCP, the network guard, its reserved id
 *   and its signal through the pipeline's call, and builds its result from what that call returned;
 * - a pipeline call writes no history line; an in-process function writes exactly one, of its kind, as the CLI's; an export
 *   that only transcoded writes none;
 * - every call of appendHistory in the sources lies in one of the history's writers (one writer per kind of line).
 * No ffmpeg, no browser: a job is planned for real (the editor's planRun), never rendered.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExportJobInput, RenderJobInput, ReviewJobInput } from '@retake/core';

const seen = vi.hoisted(() => ({ calls: [] as Array<{ call: string; options: Record<string, unknown> }>, record: undefined as unknown, exportMethod: 'render' as 'render' | 'transcode', editorLoads: 0 }));

// The engine's loader of the editor, counted (the real one loads it): a renderer refused is refused before any load.
vi.mock('../src/lazy.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/lazy.js')>();
  return { ...real, editor: () => ((seen.editorLoads += 1), real.editor()) };
});

vi.mock('@retake/editor', async (importOriginal) => {
  const real = await importOriginal<typeof import('@retake/editor')>();
  return {
    ...real,
    renderVideo: async (o: Record<string, unknown>) => (seen.calls.push({ call: 'renderVideo', options: o }), seen.record),
    renderStill: async (o: Record<string, unknown>) => (seen.calls.push({ call: 'renderStill', options: o }), '/still.png'),
    renderComponentPreviews: async (o: Record<string, unknown>) => (seen.calls.push({ call: 'renderComponentPreviews', options: o }), []),
    renderComponentLoops: async (o: Record<string, unknown>) => (seen.calls.push({ call: 'renderComponentLoops', options: o }), { items: [] }),
    exportRender: async (o: Record<string, unknown>) => {
      seen.calls.push({ call: 'exportRender', options: o });
      const formats = o.formats as string[];
      return {
        render: o.render,
        dir: '/exports',
        manifest: '/exports/manifest.json',
        master: { width: 1920, height: 1080, duration_s: 2 },
        outputs: formats.map((format) => ({ format, file: `/exports/${format}`, method: seen.exportMethod, width: 1, height: 1, duration_s: 2, size_bytes: 1, ms: 1, warnings: [] })),
        failures: [],
      };
    },
  };
});
vi.mock('@retake/review', async (importOriginal) => {
  const real = await importOriginal<typeof import('@retake/review')>();
  return {
    ...real,
    reviewRender: async (o: Record<string, unknown>) => {
      seen.calls.push({ call: 'reviewRender', options: o });
      return { render: { id: o.render, duration_s: 2 }, files: { dir: '/review', report_json: '/review/report.json' }, clean: true, counts: { error: 0, warning: 0, info: 0 }, review: { ms: 5 } };
    },
  };
});

import { createEngine, executeExportJob, executeRenderJob, executeReviewJob, exportInProcess, historyFile, openProject, renderInProcess, enginePorts } from '../src/index.js';
import { exportWork, renderWork } from '../src/pipeline.js';
import { diskFullWork, loopsWork, previewsWork, stillWork } from '../src/render/work.js';
import { MemoryRenderer } from '../src/render/memory-renderer.js';
import type { Engine } from '../src/index.js';
import { ManualClock } from '../src/clock.js';
import { synthTimeline } from '../../editor/test/helpers.js';
import { TEMPLATES, syntheticRunRecord } from '../../editor/test/render-helpers.js';
import { PERSON_POLICY } from '@retake/core';

const SCENARIO = 'steps';
const RUN = '20260101-120000-steps';
const SRC = fileURLToPath(new URL('../../', import.meta.url));
let root: string;
let dir: string;
let engine: Engine;
const savedHome = process.env.RETAKE_HOME;

const historyLines = async (): Promise<string[]> => (await readFile(historyFile(root), 'utf8').catch(() => '')).split('\n').filter(Boolean);
/** The renderer every caller here hands: the editor's use cases are replaced above, so nothing is asked of it. */
const renderer = new MemoryRenderer();
const ctx = <I>(input: I) => ({ ...enginePorts(), ws: engine.workspace, cli: 'retake', input, signal: new AbortController().signal, event: () => undefined, progress: () => undefined, browser: () => undefined, renderer });

function recordOf(id: string) {
  return {
    version: 1,
    id,
    status: 'succeeded',
    scenario: SCENARIO,
    run_id: RUN,
    run_dir: join(dir, 'runs', RUN),
    file: join(dir, 'renders', `${id}.mp4`),
    record: join(dir, 'renders', `${id}.json`),
    template: 'editorial',
    variant: 'landscape',
    overrides: {},
    duration_s: 2,
    frames: 60,
    fps: 30,
    width: 1920,
    height: 1080,
    size_bytes: 10,
    bundle: { cached: true, ms: 0 },
    timings: { total_ms: 4321 },
    created_at: '2026-01-01T12:00:00.000Z',
    warnings: ['a warning'],
    plan: { durationInFrames: 60, fps: 30, variant: 'landscape' },
  };
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'retake-pipeline-'));
  process.env.RETAKE_HOME = join(root, '.home');
  await writeFile(join(root, 'retake.yaml'), `projects_dir: projects\ntemplates_dir: ${JSON.stringify(TEMPLATES)}\n`);
  dir = join(root, 'projects', 'demo');
  const runDir = join(dir, 'runs', RUN);
  await mkdir(runDir, { recursive: true });
  await mkdir(join(dir, 'renders'), { recursive: true });
  await writeFile(join(dir, 'project.yaml'), 'name: Demo\nenvironments:\n  local: {app: "http://app.test"}\ntemplate: editorial\n');
  const t = synthTimeline({ duration: 2, entries: [{ id: 'a', t_start: 0.5, t_end: 1.5, steps: [{ action: 'hold', t_start: 0.5, t_end: 1.5 }] }], video: { intro: false, outro: false, template: 'editorial' } });
  t.run_id = RUN;
  t.project = 'demo';
  t.scenario = SCENARIO;
  await writeFile(join(runDir, 'timeline.json'), JSON.stringify(t));
  // A run `latest` takes has its record (L7.6a: a folder without a readable run.json is never the latest capture).
  await writeFile(join(runDir, 'run.json'), JSON.stringify(syntheticRunRecord(runDir, { id: RUN, scenario: SCENARIO, project: 'demo' })));
  await writeFile(join(runDir, 'capture.mp4'), 'never read');
  await writeFile(join(dir, 'renders', `${SCENARIO}-v1.json`), JSON.stringify(recordOf(`${SCENARIO}-v1`)));
  await writeFile(join(dir, 'renders', `${SCENARIO}-v1.mp4`), 'never read');
  engine = await createEngine({ root, client: 'test', autoStartWorker: false });
});

afterAll(async () => {
  if (savedHome === undefined) delete process.env.RETAKE_HOME;
  else process.env.RETAKE_HOME = savedHome;
  await rm(root, { recursive: true, force: true });
});

beforeEach(() => {
  seen.calls.length = 0;
  seen.exportMethod = 'render';
});

describe('the jobs run the shared pipeline with their own options', () => {
  it('a render job: trust mcp, the network guard, its reserved id, its signal; its result from the record', async () => {
    const sub = await engine.renders.submit({ project: 'demo', scenario: SCENARIO, overrides: { scale: 0.5 } });
    const input = sub.job.input as RenderJobInput;
    seen.record = recordOf(input.render_id);
    const c = ctx(input);
    const result = await executeRenderJob(c);
    expect(seen.calls.map((x) => x.call)).toEqual(['renderVideo']);
    expect(seen.calls[0].options).toMatchObject({ run: RUN, scenario: SCENARIO, overrides: { scale: 0.5 }, root, trust: 'mcp', network: 'guard', reserved: { scenario: SCENARIO, version: 2, variant: 'landscape' } });
    expect(seen.calls[0].options.signal).toBe(c.signal);
    // The job's renderer is the one the editor's use case draws with.
    expect(seen.calls[0].options.renderer).toBe(renderer);
    expect(seen.calls[0].options).not.toHaveProperty('out');
    expect(result).toMatchObject({ kind: 'render', render_id: input.render_id, run_id: RUN, bundle_cached: true, untrusted: { warnings: ['a warning'] } });
    await engine.jobs.cancel(sub.job.id);
  });

  it('an export job: trust mcp, the network guard, its formats; a review job: its fps and comparison, no thumbnails', async () => {
    const exp: ExportJobInput = { version: 1, kind: 'export', project: 'demo', render_id: `${SCENARIO}-v1`, formats: ['vertical_9x16'], submitted_by: 'test' };
    const e = ctx(exp);
    const exported = await executeExportJob(e);
    expect(seen.calls[0]).toMatchObject({ call: 'exportRender', options: { render: `${SCENARIO}-v1`, formats: ['vertical_9x16'], root, trust: 'mcp', network: 'guard' } });
    expect(seen.calls[0].options.signal).toBe(e.signal);
    expect(seen.calls[0].options.renderer).toBe(renderer);
    expect(exported).toMatchObject({ kind: 'export', rendered: 1, failed: [] });
    const rev: ReviewJobInput = { version: 1, kind: 'review', project: 'demo', render_id: `${SCENARIO}-v1`, fps: 2, previous: false, submitted_by: 'test' };
    const r = ctx(rev);
    const reviewed = await executeReviewJob(r);
    expect(seen.calls[1]).toMatchObject({ call: 'reviewRender', options: { render: `${SCENARIO}-v1`, fps: 2, previous: false, thumbnails: false, root } });
    expect(seen.calls[1].options.signal).toBe(r.signal);
    expect(reviewed).toMatchObject({ kind: 'review', clean: true, ms: 5 });
  });

  it('no job writes the history itself (the worker does, once the job is finished)', async () => {
    const before = await historyLines();
    await executeExportJob(ctx<ExportJobInput>({ version: 1, kind: 'export', project: 'demo', render_id: `${SCENARIO}-v1`, formats: ['vertical_9x16'], submitted_by: 'test' }));
    expect(await historyLines()).toEqual(before);
  });
});

describe('the in-process functions write one history line each; the pipeline none', () => {
  it('render: renderWork alone writes nothing, renderInProcess one line of a CLI render', async () => {
    const project = await openProject(engine.workspace, 'demo');
    seen.record = recordOf(`${SCENARIO}-v3`);
    const before = await historyLines();
    await renderWork({ renderer, workPolicy: PERSON_POLICY, project, root, run: RUN, scenario: SCENARIO });
    expect(await historyLines()).toEqual(before);
    // The line is stamped with the clock the caller hands (the CLI's cliPorts), never the system's.
    await renderInProcess({ renderer, workPolicy: PERSON_POLICY, project, root, run: RUN, scenario: SCENARIO, clock: new ManualClock('2026-02-03T04:05:06.789Z') });
    const added = (await historyLines()).slice(before.length).map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(added).toEqual([{ v: 1, at: '2026-02-03T04:05:06.789Z', kind: 'render', project: 'demo', submitted_by: 'cli', state: 'succeeded', ms: 4321, counted: { captures: 0, dry_runs: 0, renders: 1 } }]);
    // The CLI passes its own options through, untouched (no trust, no guard: a person's render).
    expect(seen.calls[1].options).not.toHaveProperty('trust');
    expect(seen.calls[1].options).not.toHaveProperty('network');
    expect(seen.calls.map((x) => x.options.renderer)).toEqual([renderer, renderer]);
  });

  it('work asked without a renderer is refused before the editor is called: nothing in the engine picks one', async () => {
    const project = await openProject(engine.workspace, 'demo');
    const bare = { workPolicy: PERSON_POLICY, project, root, run: RUN, scenario: SCENARIO } as unknown as Parameters<typeof renderWork>[0];
    seen.editorLoads = 0;
    await expect(renderWork(bare)).rejects.toThrow('render: no renderer was handed to the engine');
    await expect(renderInProcess(bare as Parameters<typeof renderInProcess>[0])).rejects.toThrow('no renderer was handed');
    await expect(exportWork({ workPolicy: PERSON_POLICY, project, root, render: `${SCENARIO}-v1`, formats: ['webm'] } as unknown as Parameters<typeof exportWork>[0])).rejects.toThrow('export: no renderer was handed to the engine');
    expect(seen.calls).toEqual([]);
    // Every work of render/work.ts, and whatever stands where the renderer should: nothing, or half of one.
    const half = { video: async () => undefined, stills: async () => [], previews: null };
    for (const lost of [undefined, null, {}, half]) {
      const o = { ...bare, renderer: lost } as never;
      await expect(renderWork(o)).rejects.toThrow('render: no renderer was handed to the engine');
      await expect(stillWork(o)).rejects.toThrow('still: no renderer was handed to the engine');
      await expect(exportWork(o)).rejects.toThrow('export: no renderer was handed to the engine');
      await expect(previewsWork(o)).rejects.toThrow('preview: no renderer was handed to the engine');
      await expect(loopsWork(o)).rejects.toThrow('preview: no renderer was handed to the engine');
    }
    expect(seen.calls).toEqual([]);
    // Refused before the editor is even loaded (review fix): the check comes first in the guarded helper.
    expect(seen.editorLoads).toBe(0);
  });

  it('every use case of the editor is reached through the one guarded helper of render/work.ts', async () => {
    // L7.34 (finding C4): held by behaviour instead of the helper's five statements — each work of render/work.ts calls
    // its own use case of the editor once, handing it the renderer it was given (the refusal before the editor loads
    // is the case above; that the editor's entries are named in work.ts only is the ratchet's `render-call`).
    const project = await openProject(engine.workspace, 'demo');
    const o = { workPolicy: PERSON_POLICY, project, root, run: RUN, scenario: SCENARIO, render: `${SCENARIO}-v1`, formats: ['webm'], renderer } as never;
    seen.editorLoads = 0;
    await renderWork(o);
    await stillWork(o);
    await exportWork(o);
    await previewsWork(o);
    await loopsWork(o);
    // One load per use case, through the engine's loader.
    expect(seen.editorLoads).toBe(5);
    expect(seen.calls.map((c) => c.call)).toEqual(['renderVideo', 'renderStill', 'exportRender', 'renderComponentPreviews', 'renderComponentLoops']);
    for (const c of seen.calls) expect(c.options.renderer, c.call).toBe(renderer);
    // After the request's own fields: what it asked is what the use case got, the renderer beside it.
    for (const c of seen.calls) expect(c.options, c.call).toMatchObject({ project, root, workPolicy: PERSON_POLICY });
    // The editor read a failure too (diskFullWork): its own rule.
    expect([await diskFullWork(Object.assign(new Error('write failed'), { code: 'ENOSPC' })), await diskFullWork(new Error('another'))]).toEqual([true, false]);
  });

  it('export: re-rendered formats count (one line), transcodes alone write none; exportWork alone none', async () => {
    const project = await openProject(engine.workspace, 'demo');
    const before = await historyLines();
    await exportWork({ renderer, workPolicy: PERSON_POLICY, project, root, render: `${SCENARIO}-v1`, formats: ['vertical_9x16'] });
    expect(await historyLines()).toEqual(before);
    const clock = new ManualClock('2026-02-03T04:05:06.789Z');
    await exportInProcess({ renderer, workPolicy: PERSON_POLICY, project, root, render: `${SCENARIO}-v1`, formats: ['vertical_9x16', 'square_1x1'], clock });
    seen.exportMethod = 'transcode';
    await exportInProcess({ renderer, workPolicy: PERSON_POLICY, project, root, render: `${SCENARIO}-v1`, formats: ['webm'], clock });
    const added = (await historyLines()).slice(before.length).map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(added).toEqual([{ v: 1, at: '2026-02-03T04:05:06.789Z', kind: 'export', project: 'demo', submitted_by: 'cli', state: 'succeeded', counted: { captures: 0, dry_runs: 0, renders: 2 } }]);
  });
});

describe('the writers of the history', () => {
  /** Where appendHistory is called: the line of a finished job, of a CLI command, of `retake record`. */
  const WRITERS = ['packages/engine/src/in-process.ts', 'packages/engine/src/jobs/run-job-record.ts', 'packages/engine/src/jobs/worker-finish.ts', 'packages/engine/src/record.ts'];

  function sources(d: string): string[] {
    return readdirSync(d).flatMap((n) => {
      const p = join(d, n);
      if (statSync(p).isDirectory()) return n === 'node_modules' || n === 'dist' || n === 'test' ? [] : sources(p);
      return /\.(ts|tsx)$/.test(n) && !n.endsWith('.d.ts') ? [p] : [];
    });
  }

  it('only they call appendHistory: no shell writes a line itself', () => {
    const callers = readdirSync(SRC)
      .flatMap((pkg) => {
        try {
          return sources(join(SRC, pkg, 'src'));
        } catch {
          return [];
        }
      })
      .filter((f) => /\bappendHistory\(/.test(readFileSync(f, 'utf8').replace(/export async function appendHistory\(/, '')))
      .map((f) => relative(join(SRC, '..'), f).split('\\').join('/'))
      .sort();
    expect(callers).toEqual(WRITERS);
    // The CLI's own lines: one in-process function per kind.
    const inProcess = readFileSync(join(SRC, 'engine/src/in-process.ts'), 'utf8');
    expect([...inProcess.matchAll(/kind: '([a-z]+)'/g)].map((m) => m[1])).toEqual(['render', 'still', 'export', 'run', 'inspect']);
  });
});
