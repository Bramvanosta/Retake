/**
 * The render use case (engine render/render-video.ts): it writes the record from what the renderer answers and reads a
 * renderer's failure by what it says — its kind (a cancel that is not the editor's class is still recorded
 * `cancelled`), its `renderPath` and `renderWarnings` —; the record's members and bytes; an export's re-rendered format
 * goes through it; a render without its renderer, or with the options of the editor's own driver beside one, is refused
 * (a reserved version released); a project slug or folder is refused.
 * The renderer here draws nothing (no Remotion, no browser, no ffmpeg / ffprobe); the renders go to the disk's outputs.
 */
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PERSON_POLICY } from '@retake/core';
import { loadProject, projectTemplateFolderId } from '@retake/core/io';
import type { LoadedProject } from '@retake/core';
import { RenderCancelledError, RenderError, planRun } from '@retake/editor';
import type { RenderAttempt } from '@retake/editor';
import { RUN_ID, syntheticTimeline } from '@retake/test-support/render';
import { TEMPLATES } from '@retake/test-support/repo';
import { systemClock } from '../src/clock.js';
import { diskOutputs } from '../src/outputs/disk-outputs.js';
import { diskWorkspaceReads } from '../src/workspace-reads/disk-reads.js';
import { MemoryRenderer } from '../src/render/memory-renderer.js';
import type { RenderVideoRequest, RenderVideoResult, Renderer } from '../src/render/renderer.js';
import { versionLockFile } from '../src/render/versions.js';
import { exportWork, renderWork } from '../src/render/work.js';
import { loadComponentRegistry } from '@retake/components';
import { packageRegistries } from '../src/registries/package-registries.js';

let root: string;
let project: LoadedProject;
/** Where the renders here go (the disk's outputs and reads) and what stamps their records. */
const place = { ws: { outputs: diskOutputs, reads: diskWorkspaceReads, registries: packageRegistries() }, clock: systemClock };

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'retake-render-use-case-'));
  await writeFile(join(root, 'retake.yaml'), `projects_dir: projects\ntemplates_dir: ${JSON.stringify(TEMPLATES)}\n`);
  const dir = join(root, 'projects', 'demo');
  const runDir = join(dir, 'runs', RUN_ID);
  await mkdir(runDir, { recursive: true });
  await writeFile(join(dir, 'project.yaml'), 'name: Demo\nenvironments:\n  local: {app: "http://app.test"}\ntemplate: editorial\n');
  await writeFile(join(runDir, 'timeline.json'), JSON.stringify(syntheticTimeline(), null, 2));
  // Never decoded here: the renderer below draws nothing.
  await writeFile(join(runDir, 'capture.mp4'), 'not a video');
  project = await loadProject('demo', root);
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const PATH: RenderVideoResult['renderPath'] = {
  gl: { asked: 'auto', source: 'default', resolved: 'software', used: 'software' },
  encoder: { asked: 'auto', source: 'default', used: 'libx264' },
  concurrency_source: 'default',
};

/** A renderer that writes a marker and answers a result, or rejects with what `fail` gives. */
function driver(o: { fail?: () => unknown; probe?: RenderVideoResult['probe'] } = {}): Renderer & { videos: RenderVideoRequest[] } {
  const videos: RenderVideoRequest[] = [];
  const memory = new MemoryRenderer();
  return {
    videos,
    async video(req) {
      videos.push(req);
      req.onProcess?.({ pid: 4242 });
      req.onProgress?.({ stage: 'rendering', progress: 0, overall: 0.1 });
      if (o.fail) throw o.fail();
      await mkdir(dirname(req.out), { recursive: true });
      await writeFile(req.out, 'marker');
      return {
        file: req.out,
        size_bytes: 6,
        concurrency: 3,
        bundle: { hash: 'h', cached: true, ms: 7 },
        browser: { path: null, source: 'none' },
        bundle_ms: 7,
        render_ms: 9,
        warnings: ['a driver warning'],
        renderPath: PATH,
        encoding: { encoder: 'libx264', crf: 16 },
        ...(o.probe ? { probe: o.probe } : {}),
      };
    },
    stills: (req) => memory.stills(req),
    previews: memory.previews,
    machine: memory.machine,
  };
}

const kinded = (kind: string, message: string, more: object = {}): Error => Object.assign(new Error(message), { errorKind: kind }, more);

describe('renderVideo on a driver handed to it', () => {
  it('writes the record from what the driver answers: no probe when the driver has none, the process and the progress passed on', async () => {
    const d = driver();
    const stages: string[] = [];
    const processes: number[] = [];
    const record = await renderWork({ ...place, workPolicy: PERSON_POLICY, project, root, run: RUN_ID, renderer: d, onProgress: (p) => stages.push(p.stage), onBrowser: (b) => processes.push(b.pid) });
    expect(d.videos).toHaveLength(1);
    expect(d.videos[0].out).toBe(record.file);
    expect(d.videos[0].plan).toEqual(record.plan);
    expect(d.videos[0]).not.toHaveProperty('cacheDir');
    expect(d.videos[0]).not.toHaveProperty('seams');
    expect(record).toMatchObject({
      status: 'succeeded',
      size_bytes: 6,
      concurrency: 3,
      bundle: { hash: 'h', cached: true, ms: 7 },
      browser: { path: null, source: 'none' },
      policy: PATH,
      encoding: { codec: 'h264', encoder: 'libx264', crf: 16 },
      timings: { bundle_ms: 7, render_ms: 9 },
    });
    expect(record).not.toHaveProperty('probe');
    expect(record.warnings).toContain('a driver warning');
    expect(JSON.parse(await readFile(record.record, 'utf8'))).toEqual(record);
    expect(stages).toEqual(['planning', 'planning', 'rendering', 'done']);
    expect(processes).toEqual([4242]);
  });

  it("keeps the driver's probe and warns when the file does not last what the plan says", async () => {
    const { plan } = await planRun({ registry: (root: string) => loadComponentRegistry({ root }), workPolicy: PERSON_POLICY, project, root, run: RUN_ID });
    const probe = { duration_s: plan.durationInFrames / plan.fps + 1, width: plan.width, height: plan.height, fps: plan.fps, audio_streams: 1 };
    const record = await renderWork({ ...place, workPolicy: PERSON_POLICY, project, root, run: RUN_ID, renderer: driver({ probe }) });
    expect(record.probe).toEqual(probe);
    expect(record.warnings.some((w) => /^the file lasts .* s, the plan .* s$/.test(w))).toBe(true);
  });

  it("a driver's cancel is read by its kind: the record says `cancelled`, this package's cancel error is thrown", async () => {
    const e = await renderWork({ ...place, workPolicy: PERSON_POLICY, project, root, run: RUN_ID, renderer: driver({ fail: () => kinded('cancelled', 'stopped by the driver') }) }).catch(
      (x: unknown) => x,
    );
    expect(e).toBeInstanceOf(RenderCancelledError);
    const record = (e as RenderCancelledError).record as RenderAttempt;
    expect(record.status).toBe('cancelled');
    expect(record.error).toBe('stopped by the driver');
    expect(existsSync(record.file)).toBe(false);
    expect(existsSync(record.record)).toBe(false);
  });

  it("a driver's failure keeps the path it tried and its warnings, whatever its class", async () => {
    const path = { ...PATH, fallback: { reason: 'the GPU went away' } };
    const e = await renderWork({
      ...place,
      workPolicy: PERSON_POLICY,
      project,
      root,
      run: RUN_ID,
      renderer: driver({ fail: () => Object.assign(new Error('the encoder stopped'), { renderPath: path, renderWarnings: ['blocked: example.com'] }) }),
    }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(RenderError);
    expect(e).not.toBeInstanceOf(RenderCancelledError);
    expect((e as Error).message).toBe('the encoder stopped');
    const record = (e as RenderError).record as RenderAttempt;
    expect(record.status).toBe('failed');
    expect(record.policy).toEqual(path);
    expect(record.warnings).toContain('blocked: example.com');
  });

  it("a failure's `path` is never read as a render path: a system error's file, or an object under that name, leaves the record without a policy", async () => {
    for (const path of ['/somewhere/video.mp4', { ...PATH }]) {
      const e = await renderWork({
        ...place,
        workPolicy: PERSON_POLICY,
        project,
        root,
        run: RUN_ID,
        renderer: driver({ fail: () => Object.assign(new Error('ENOTDIR: not a directory'), { code: 'ENOTDIR', path }) }),
      }).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(RenderError);
      expect(((e as RenderError).record as RenderAttempt).policy).toBeUndefined();
    }
    // …and a `renderPath` that is not an object is not one either.
    const e = await renderWork({
      ...place,
      workPolicy: PERSON_POLICY,
      project,
      root,
      run: RUN_ID,
      renderer: driver({ fail: () => Object.assign(new Error('odd'), { renderPath: 'software' }) }),
    }).catch((x: unknown) => x);
    expect(((e as RenderError).record as RenderAttempt).policy).toBeUndefined();
  });
});

describe("a renderer named in the options and not handed, or handed beside the own driver's options", () => {
  // Untyped on purpose: these are the callers the type checker never saw (a spread that lost the value, plain JS).
  const loose = <T>(o: Record<string, unknown>): T => o as T;
  const refusal = async (p: Promise<unknown>): Promise<string> => {
    const e = await p.then(
      () => new Error('it rendered'),
      (x: unknown) => x,
    );
    expect(e).toBeInstanceOf(Error);
    return (e as Error).message;
  };

  it("renderVideo: a `renderer` key that holds nothing, or no video, is refused before the plan — the reserved version is released, nothing falls back to this package's driver", async () => {
    const base = { ...place, workPolicy: PERSON_POLICY, project, root, run: RUN_ID };
    // The engine's refusal (render/work.ts rendererOf): before the editor is even loaded.
    for (const renderer of [undefined, null, {}, { video: 'not a function' }]) {
      expect(await refusal(renderWork(loose({ ...base, renderer })))).toBe('render: no renderer was handed to the engine');
    }
    const { timeline, plan } = await planRun({ registry: (root: string) => loadComponentRegistry({ root }), workPolicy: PERSON_POLICY, project, root, run: RUN_ID });
    const lock = versionLockFile(join(root, 'projects', 'demo', 'renders'), timeline.scenario, 41);
    await mkdir(dirname(lock), { recursive: true });
    await writeFile(lock, '');
    expect(await refusal(renderWork(loose({ ...base, renderer: undefined, reserved: { scenario: timeline.scenario, version: 41, variant: plan.variant } })))).toMatch(
      /^render: no renderer was handed to the engine/,
    );
    expect(existsSync(lock)).toBe(false);
  });

  it('renderVideo: `cacheDir` and `seams` are refused beside a renderer, which is asked nothing', async () => {
    const d = driver();
    const base = { ...place, workPolicy: PERSON_POLICY, project, root, run: RUN_ID, renderer: d };
    expect(await refusal(renderWork(loose({ ...base, cacheDir: join(root, 'cache') })))).toBe(
      "render: cacheDir is an option of the editor's own renderer and cannot go with a renderer that is handed",
    );
    expect(await refusal(renderWork(loose({ ...base, cacheDir: join(root, 'cache'), seams: {} })))).toBe(
      "render: cacheDir, seams are options of the editor's own renderer and cannot go with a renderer that is handed",
    );
    expect(d.videos).toEqual([]);
    // An option that is there and says nothing is no option.
    await renderWork(loose({ ...base, cacheDir: undefined, seams: undefined }));
    expect(d.videos).toHaveLength(1);
  });
});

// ── The bytes of a record (pinned before the record becomes a union) ──

describe('the record renderVideo writes, and the one a failure carries: their members, in order', () => {
  // `template_folder` (the theme's folder, core io templateFolderId) after `template_sha256`.
  const BASE = [
    'version',
    'id',
    'project',
    'scenario',
    'run_id',
    'run_dir',
    'template',
    'template_sha256',
    'template_folder',
    'overrides',
    'edit',
    'variant',
    'status',
    'file',
    'record',
    'render_version',
    'created_at',
    'finished_at',
    'duration_s',
    'frames',
    'fps',
    'width',
    'height',
    'size_bytes',
    'encoding',
    'concurrency',
    'bundle',
    'browser',
    'timings',
    'warnings',
  ];

  it('a succeeded record: `policy` and `probe` come after `plan`; the file is the record as JSON, two spaces, a final newline', async () => {
    const probe = { duration_s: 1, frames: 30, width: 1920, height: 1080, fps: 30, audio_streams: 1 };
    const record = await renderWork({ ...place, workPolicy: PERSON_POLICY, project, root, run: RUN_ID, renderer: driver({ probe }) });
    const text = await readFile(record.record, 'utf8');
    expect(text).toBe(`${JSON.stringify(record, null, 2)}\n`);
    expect(Object.keys(JSON.parse(text) as object)).toEqual([...BASE, 'plan', 'policy', 'probe']);
    expect(Object.keys(record.encoding)).toEqual(['codec', 'pixel_format', 'faststart', 'audio', 'encoder', 'crf']);
    expect([record.status, 'error' in record]).toEqual(['succeeded', false]);
    // The theme's folder as the board reads today's (core io projectTemplateFolderId): one rule on both sides.
    expect([record.template_folder, await projectTemplateFolderId(project, project.config.template)]).toEqual(['/starter:editorial', '/starter:editorial']);
    // Without a probe from the driver: no `probe` member at all.
    const bare = await renderWork({ ...place, workPolicy: PERSON_POLICY, project, root, run: RUN_ID, renderer: driver() });
    expect(Object.keys(JSON.parse(await readFile(bare.record, 'utf8')) as object)).toEqual([...BASE, 'plan', 'policy']);
  });

  it('a failed or cancelled render writes no record: the attempt rides on the error, `error` after `plan`, then the path it tried', async () => {
    const failed = await renderWork({
      ...place,
      workPolicy: PERSON_POLICY,
      project,
      root,
      run: RUN_ID,
      renderer: driver({ fail: () => kinded('render', 'the driver broke', { renderPath: PATH }) }),
    }).catch((x: unknown) => x);
    expect(failed).toBeInstanceOf(RenderError);
    const attempt = (failed as RenderError).record as RenderAttempt;
    expect(Object.keys(attempt)).toEqual([...BASE, 'plan', 'error', 'policy']);
    expect([attempt.status, attempt.error, attempt.size_bytes, attempt.bundle, attempt.browser, 'probe' in attempt]).toEqual([
      'failed',
      'the driver broke',
      0,
      { hash: '', cached: false, ms: 0 },
      { path: null, source: 'none' },
      false,
    ]);
    expect([existsSync(attempt.record), existsSync(attempt.file)]).toEqual([false, false]);
    const cancelled = await renderWork({ ...place, workPolicy: PERSON_POLICY, project, root, run: RUN_ID, renderer: driver({ fail: () => kinded('cancelled', 'stopped') }) }).catch((x: unknown) => x);
    expect(cancelled).toBeInstanceOf(RenderCancelledError);
    const stopped = (cancelled as RenderCancelledError).record as RenderAttempt;
    expect(Object.keys(stopped)).toEqual([...BASE, 'plan', 'error']);
    expect([stopped.status, stopped.error, existsSync(stopped.record)]).toEqual(['cancelled', 'stopped', false]);
  });
});

// An export's re-rendered format plans with the master's theme folder (editor exportThemeRef). Before,
// with its theme's name: a project on `./themes/brand` failed "not found" (or took the workspace's `brand`).
describe("an export's re-rendered format uses the master's theme folder", () => {
  it('a project on a theme folder: the vertical is rendered with that folder, as the master was', async () => {
    const dir = join(root, 'projects', 'pathy');
    await mkdir(join(dir, 'runs'), { recursive: true });
    await cp(join(project.dir, 'runs', RUN_ID), join(dir, 'runs', RUN_ID), { recursive: true });
    // The take names no theme of its own: a plan of it uses the project's.
    const tl = syntheticTimeline();
    if (tl.video) delete tl.video.template;
    await writeFile(join(dir, 'runs', RUN_ID, 'timeline.json'), JSON.stringify(tl, null, 2));
    await cp(join(TEMPLATES, 'editorial'), join(dir, 'themes', 'brand'), { recursive: true });
    await writeFile(join(dir, 'project.yaml'), 'name: Pathy\nenvironments:\n  local: {app: "http://app.test"}\ntemplate: ./themes/brand\n');
    const pathy = await loadProject('pathy', root);
    const master = await renderWork({ ...place, workPolicy: PERSON_POLICY, project: pathy, root, run: RUN_ID, renderer: driver() });
    expect([master.template, master.template_folder]).toEqual(['brand', 'projects/pathy/themes/brand']);
    for (const trust of ['author', 'mcp'] as const) {
      const r = await exportWork({
        ...place,
        workPolicy: PERSON_POLICY,
        project: pathy,
        root,
        render: master.id,
        formats: ['vertical_9x16'],
        renderer: driver(),
        trust,
        out: join(root, `out-${trust}`),
      });
      expect(r.failures).toEqual([]);
      const out = r.outputs.find((o) => o.format === 'vertical_9x16');
      expect(out?.method).toBe('render');
      const rec = JSON.parse(await readFile(out!.record!, 'utf8')) as { template_folder?: string };
      expect(rec.template_folder).toBe('projects/pathy/themes/brand');
    }
  });
});

describe('nothing here loads a project by itself', () => {
  // Untyped on purpose: callers the type checker never saw (plain JS, a spread that lost the value).
  const loose = <T>(o: Record<string, unknown>): T => o as T;
  const refused = async (p: Promise<unknown>): Promise<string> => {
    const e = await p.then(
      () => new Error('it ran'),
      (x: unknown) => x,
    );
    expect(e).toBeInstanceOf(RenderError);
    return (e as Error).message;
  };

  it('renderVideo and exportRender refuse a project slug or folder, before any plan or driver call', async () => {
    const d = driver();
    for (const p of ['demo', join(root, 'projects', 'demo'), undefined]) {
      expect(await refused(renderWork(loose({ ...place, workPolicy: PERSON_POLICY, project: p, root, run: RUN_ID, renderer: d })))).toMatch(/no loaded project was handed/);
      expect(await refused(exportWork(loose({ ...place, workPolicy: PERSON_POLICY, project: p, root, render: 'latest', renderer: d })))).toMatch(/no loaded project was handed/);
    }
    expect(d.videos).toEqual([]);
  });
});
