/**
 * The render driver handed to the use cases (no Remotion, no browser, no ffmpeg / ffprobe): renderVideo writes its
 * record from what a driver answers and reads a driver's failure by what it says — its kind (a cancel that is not this
 * package's class is still recorded `cancelled`), its `renderPath` and `renderWarnings`, `diskFull` —, renderStill goes
 * through the driver's stills, and a preview session renders on a driver's previews. Which driver renders is read
 * from the `renderer` key (render/driver-guard.ts): a key that holds nothing is refused, never replaced by this
 * package's own driver, and the own driver's options (`cacheDir`, `seams`, a preview `backend`) are refused beside it.
 */
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PERSON_POLICY } from '@retake/core';
import { fileFacts, loadProject, loadTemplate } from '@retake/core/io';
import type { LoadedProject, LoadedTemplate } from '@retake/core';
import { loadComponentRegistry } from '@retake/components';
import type { ComponentRegistry } from '@retake/components';
import { RenderCancelledError, RenderDiskFullError, RenderError, exportRender, isDiskFullError, planRun, previewDriver, renderComponentLoops, renderComponentPreviews, renderStill, renderVideo, versionLockFile } from '@retake/editor';
import type { DriverVideoRequest, DriverVideoResult, LoopItem, PreviewBackend, RenderDriver, RenderRecord } from '@retake/editor';
import { RUN_ID, TEMPLATES, syntheticTimeline } from './render-helpers.js';

let root: string;
let project: LoadedProject;
let registry: ComponentRegistry;
let editorial: LoadedTemplate;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'retake-render-driver-'));
  await writeFile(join(root, 'retake.yaml'), `projects_dir: projects\ntemplates_dir: ${JSON.stringify(TEMPLATES)}\n`);
  const dir = join(root, 'projects', 'demo');
  const runDir = join(dir, 'runs', RUN_ID);
  await mkdir(runDir, { recursive: true });
  await writeFile(join(dir, 'project.yaml'), 'name: Demo\nenvironments:\n  local: {app: "http://app.test"}\ntemplate: editorial\n');
  await writeFile(join(runDir, 'timeline.json'), JSON.stringify(syntheticTimeline(), null, 2));
  // Never decoded here: the driver below draws nothing.
  await writeFile(join(runDir, 'capture.mp4'), 'not a video');
  project = await loadProject('demo', root);
  registry = await loadComponentRegistry({ root });
  editorial = await loadTemplate('editorial', root, { files: fileFacts(PERSON_POLICY) });
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const PATH: DriverVideoResult['renderPath'] = { gl: { asked: 'auto', source: 'default', resolved: 'software', used: 'software' }, encoder: { asked: 'auto', source: 'default', used: 'libx264' }, concurrency_source: 'default' };

/** A driver that writes a marker and answers `result`, or rejects with what `fail` gives. */
function driver(o: { fail?: () => unknown; probe?: DriverVideoResult['probe'] } = {}): RenderDriver & { videos: DriverVideoRequest[]; stillFrames: number[] } {
  const videos: DriverVideoRequest[] = [];
  const stillFrames: number[] = [];
  return {
    videos,
    stillFrames,
    async video(req) {
      videos.push(req);
      req.onProcess?.({ pid: 4242 });
      req.onProgress?.({ stage: 'rendering', progress: 0, overall: 0.1 });
      if (o.fail) throw o.fail();
      await mkdir(dirname(req.out), { recursive: true });
      await writeFile(req.out, 'marker');
      return { file: req.out, size_bytes: 6, concurrency: 3, bundle: { hash: 'h', cached: true, ms: 7 }, browser: { path: null, source: 'none' }, bundle_ms: 7, render_ms: 9, warnings: ['a driver warning'], renderPath: PATH, encoding: { encoder: 'libx264', crf: 16 }, ...(o.probe ? { probe: o.probe } : {}) };
    },
    async stills(req) {
      for (const f of req.frames) {
        stillFrames.push(f.frame);
        await mkdir(dirname(f.out), { recursive: true });
        await writeFile(f.out, 'png');
      }
      return req.frames.map((f) => f.out);
    },
    previews: previewDriver(memoryBackend()),
  };
}

/** A preview backend that writes small files (`fail` may throw instead). */
function memoryBackend(fail?: () => unknown, seen: string[] = []): PreviewBackend {
  return {
    async bundle({ components }) {
      seen.push(`bundle ${components.length > 0}`);
      return { serveUrl: join(root, 'no-bundle'), hash: 'memory', cached: false };
    },
    async open(o) {
      seen.push(`open ${o.serveUrl === join(root, 'no-bundle')} ${o.assetPrefix.startsWith('http://127.0.0.1:')}`);
      return {
        async still(_spec, file) {
          if (fail) throw fail();
          await writeFile(file, Buffer.from('\x89PNG\r\n\x1a\nposter', 'binary'));
        },
        async gif(_spec, file) {
          await writeFile(file, Buffer.alloc(1000, 0x47));
        },
        warnings: () => [],
        close: async () => undefined,
      };
    },
  };
}

const kinded = (kind: string, message: string, more: object = {}): Error => Object.assign(new Error(message), { errorKind: kind }, more);

describe('renderVideo on a driver handed to it', () => {
  it('writes the record from what the driver answers: no probe when the driver has none, the process and the progress passed on', async () => {
    const d = driver();
    const stages: string[] = [];
    const processes: number[] = [];
    const record = await renderVideo({ workPolicy: PERSON_POLICY, project, root, run: RUN_ID, renderer: d, onProgress: (p) => stages.push(p.stage), onBrowser: (b) => processes.push(b.pid) });
    expect(d.videos).toHaveLength(1);
    expect(d.videos[0].out).toBe(record.file);
    expect(d.videos[0].plan).toEqual(record.plan);
    expect(d.videos[0]).not.toHaveProperty('cacheDir');
    expect(d.videos[0]).not.toHaveProperty('seams');
    expect(record).toMatchObject({ status: 'succeeded', size_bytes: 6, concurrency: 3, bundle: { hash: 'h', cached: true, ms: 7 }, browser: { path: null, source: 'none' }, policy: PATH, encoding: { codec: 'h264', encoder: 'libx264', crf: 16 }, timings: { bundle_ms: 7, render_ms: 9 } });
    expect(record).not.toHaveProperty('probe');
    expect(record.warnings).toContain('a driver warning');
    expect(JSON.parse(await readFile(record.record, 'utf8'))).toEqual(record);
    expect(stages).toEqual(['planning', 'planning', 'rendering', 'done']);
    expect(processes).toEqual([4242]);
  });

  it('keeps the driver\'s probe and warns when the file does not last what the plan says', async () => {
    const { plan } = await planRun({ workPolicy: PERSON_POLICY, project, root, run: RUN_ID });
    const probe = { duration_s: plan.durationInFrames / plan.fps + 1, width: plan.width, height: plan.height, fps: plan.fps, audio_streams: 1 };
    const record = await renderVideo({ workPolicy: PERSON_POLICY, project, root, run: RUN_ID, renderer: driver({ probe }) });
    expect(record.probe).toEqual(probe);
    expect(record.warnings.some((w) => /^the file lasts .* s, the plan .* s$/.test(w))).toBe(true);
  });

  it('a driver\'s cancel is read by its kind: the record says `cancelled`, this package\'s cancel error is thrown', async () => {
    const e = await renderVideo({ workPolicy: PERSON_POLICY, project, root, run: RUN_ID, renderer: driver({ fail: () => kinded('cancelled', 'stopped by the driver') }) }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(RenderCancelledError);
    const record = (e as RenderCancelledError).record as RenderRecord;
    expect(record.status).toBe('cancelled');
    expect(record.error).toBe('stopped by the driver');
    expect(existsSync(record.file)).toBe(false);
    expect(existsSync(record.record)).toBe(false);
  });

  it('a driver\'s failure keeps the path it tried and its warnings, whatever its class', async () => {
    const path = { ...PATH, fallback: { reason: 'the GPU went away' } };
    const e = await renderVideo({ workPolicy: PERSON_POLICY, project, root, run: RUN_ID, renderer: driver({ fail: () => Object.assign(new Error('the encoder stopped'), { renderPath: path, renderWarnings: ['blocked: example.com'] }) }) }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(RenderError);
    expect(e).not.toBeInstanceOf(RenderCancelledError);
    expect((e as Error).message).toBe('the encoder stopped');
    const record = (e as RenderError).record as RenderRecord;
    expect(record.status).toBe('failed');
    expect(record.policy).toEqual(path);
    expect(record.warnings).toContain('blocked: example.com');
  });

  it('a failure\'s `path` is never read as a render path: a system error\'s file, or an object under that name, leaves the record without a policy', async () => {
    for (const path of ['/somewhere/video.mp4', { ...PATH }]) {
      const e = await renderVideo({ workPolicy: PERSON_POLICY, project, root, run: RUN_ID, renderer: driver({ fail: () => Object.assign(new Error('ENOTDIR: not a directory'), { code: 'ENOTDIR', path }) }) }).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(RenderError);
      expect(((e as RenderError).record as RenderRecord).policy).toBeUndefined();
    }
    // …and a `renderPath` that is not an object is not one either.
    const e = await renderVideo({ workPolicy: PERSON_POLICY, project, root, run: RUN_ID, renderer: driver({ fail: () => Object.assign(new Error('odd'), { renderPath: 'software' }) }) }).catch((x: unknown) => x);
    expect(((e as RenderError).record as RenderRecord).policy).toBeUndefined();
  });
});

describe('renderStill on a driver handed to it', () => {
  it('asks the driver for that one frame and returns its file', async () => {
    const d = driver();
    const { plan } = await planRun({ workPolicy: PERSON_POLICY, project, root, run: RUN_ID });
    const out = join(root, 'stills', 'f3.png');
    expect(await renderStill({ workPolicy: PERSON_POLICY, plan, frame: 3, out, root, registry, renderer: d })).toBe(out);
    expect(d.stillFrames).toEqual([3]);
  });
});

describe('a renderer named in the options and not handed, or handed beside the own driver\'s options', () => {
  // Untyped on purpose: these are the callers the type checker never saw (a spread that lost the value, plain JS).
  const loose = <T,>(o: Record<string, unknown>): T => o as T;
  const refusal = async (p: Promise<unknown>): Promise<string> => {
    const e = await p.then(() => new Error('it rendered'), (x: unknown) => x);
    expect(e).toBeInstanceOf(RenderError);
    return (e as Error).message;
  };

  it('renderVideo: a `renderer` key that holds nothing, or no video, is refused before the plan — the reserved version is released, nothing falls back to this package\'s driver', async () => {
    const base = { workPolicy: PERSON_POLICY, project, root, run: RUN_ID };
    for (const renderer of [undefined, null, {}, { video: 'not a function' }]) {
      expect(await refusal(renderVideo(loose({ ...base, renderer })))).toBe('render: a renderer was named but none was handed (nothing to render video with)');
    }
    const { timeline, plan } = await planRun(base);
    const lock = versionLockFile(join(root, 'projects', 'demo', 'renders'), timeline.scenario, 41);
    await mkdir(dirname(lock), { recursive: true });
    await writeFile(lock, '');
    expect(await refusal(renderVideo(loose({ ...base, renderer: undefined, reserved: { scenario: timeline.scenario, version: 41, variant: plan.variant } })))).toMatch(/^render: a renderer was named but none was handed/);
    expect(existsSync(lock)).toBe(false);
  });

  it('renderVideo: `cacheDir` and `seams` are refused beside a renderer, which is asked nothing', async () => {
    const d = driver();
    const base = { workPolicy: PERSON_POLICY, project, root, run: RUN_ID, renderer: d };
    expect(await refusal(renderVideo(loose({ ...base, cacheDir: join(root, 'cache') })))).toBe('render: cacheDir is an option of the editor\'s own renderer and cannot go with a renderer that is handed');
    expect(await refusal(renderVideo(loose({ ...base, cacheDir: join(root, 'cache'), seams: {} })))).toBe('render: cacheDir, seams are options of the editor\'s own renderer and cannot go with a renderer that is handed');
    expect(d.videos).toEqual([]);
    // An option that is there and says nothing is no option.
    await renderVideo(loose({ ...base, cacheDir: undefined, seams: undefined }));
    expect(d.videos).toHaveLength(1);
  });

  it('renderStill, exportRender and the previews read the same rule, each for the part it renders with', async () => {
    const { plan } = await planRun({ workPolicy: PERSON_POLICY, project, root, run: RUN_ID });
    const out = join(root, 'stills', 'refused.png');
    expect(await refusal(renderStill(loose({ workPolicy: PERSON_POLICY, plan, frame: 0, out, root, registry, renderer: { video: async () => undefined } })))).toBe('still: a renderer was named but none was handed (nothing to render stills with)');
    expect(await refusal(renderStill(loose({ workPolicy: PERSON_POLICY, plan, frame: 0, out, root, registry, renderer: driver(), cacheDir: join(root, 'cache') })))).toMatch(/^still: cacheDir is an option/);
    expect(existsSync(out)).toBe(false);
    // The export checks it first: before it even looks for the render (which does not exist).
    expect(await refusal(exportRender(loose({ workPolicy: PERSON_POLICY, project, root, render: 'no-such-render', formats: ['webm'], renderer: undefined })))).toBe('export: a renderer was named but none was handed (nothing to render video with)');
    for (const renderer of [undefined, { previews: null }, { previews: 'x' }, { video: async () => undefined }]) {
      expect(await refusal(renderComponentLoops(loose({ workPolicy: PERSON_POLICY, root, registry, template: editorial, items: [], renderer })))).toBe('preview: a renderer was named but none was handed (nothing to render previews with)');
      expect(await refusal(renderComponentPreviews(loose({ workPolicy: PERSON_POLICY, root, registry, template: editorial, targets: [], renderer })))).toBe('preview: a renderer was named but none was handed (nothing to render previews with)');
    }
    expect(await refusal(renderComponentLoops(loose({ workPolicy: PERSON_POLICY, root, registry, template: editorial, items: [], renderer: driver(), cacheDir: join(root, 'cache') })))).toMatch(/^preview: cacheDir is an option/);
  });
});

describe('a preview session on a driver handed to it', () => {
  const items = async (): Promise<LoopItem[]> => {
    const out = join(root, 'previews');
    await rm(out, { recursive: true, force: true });
    await mkdir(out, { recursive: true });
    const i = registry.get('studio/card-title');
    return [{ target: { id: i.manifest.id, dir: i.dir, entry: i.entry, manifest: i.manifest }, poster: join(out, 'card.png'), loop: join(out, 'card.gif') }];
  };

  it('renders on the driver\'s previews: the bundle stays the driver\'s, the session is told where the assets are served', async () => {
    const seen: string[] = [];
    const r = await renderComponentLoops({ workPolicy: PERSON_POLICY, root, registry, template: editorial, items: await items(), renderer: { previews: previewDriver(memoryBackend(undefined, seen)) } });
    expect(r.failed).toEqual([]);
    expect(r.rendered).toHaveLength(1);
    expect(seen).toEqual(['bundle true', 'open true true']);
  });

  it('`backend` alone (no `renderer` key) is this package\'s own driver on that backend; beside a renderer it is refused, and neither renders', async () => {
    const alone: string[] = [];
    const r = await renderComponentLoops({ workPolicy: PERSON_POLICY, root, registry, template: editorial, items: await items(), backend: memoryBackend(undefined, alone) });
    expect(r.rendered).toHaveLength(1);
    expect(alone).toHaveLength(2);
    const viaBackend: string[] = [];
    const viaRenderer: string[] = [];
    const e = await renderComponentLoops({ workPolicy: PERSON_POLICY, root, registry, template: editorial, items: await items(), backend: memoryBackend(undefined, viaBackend), renderer: { previews: previewDriver(memoryBackend(undefined, viaRenderer)) } }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(RenderError);
    expect((e as Error).message).toBe('preview: backend is an option of the editor\'s own renderer and cannot go with a renderer that is handed');
    expect([viaBackend, viaRenderer]).toEqual([[], []]);
  });

  it('a session failure that says `diskFull` stops the session as a full disk; one that says `cancelled` as a cancel', async () => {
    const full = await renderComponentLoops({ workPolicy: PERSON_POLICY, root, registry, template: editorial, items: await items(), renderer: { previews: previewDriver(memoryBackend(() => Object.assign(new Error('no room'), { diskFull: true }))) } }).catch((x: unknown) => x);
    expect(full).toBeInstanceOf(RenderDiskFullError);
    expect(isDiskFullError(full)).toBe(true);
    const cancelled = await renderComponentLoops({ workPolicy: PERSON_POLICY, root, registry, template: editorial, items: await items(), renderer: { previews: previewDriver(memoryBackend(() => kinded('cancelled', 'stopped'))) } }).catch((x: unknown) => x);
    expect(cancelled).toBeInstanceOf(RenderCancelledError);
  });

  it('a driver that cannot open its session because it was cancelled (its kind, no signal of ours) ends the previews cancelled', async () => {
    const inner = previewDriver(memoryBackend());
    const refused = { previews: { bundle: inner.bundle, open: async () => Promise.reject(kinded('cancelled', 'stopped before it opened')) } };
    const e = await renderComponentLoops({ workPolicy: PERSON_POLICY, root, registry, template: editorial, items: await items(), renderer: refused }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(RenderCancelledError);
  });

  it('a preview bundle of another driver is refused, a closed session renders nothing', async () => {
    const a = previewDriver(memoryBackend());
    const b = previewDriver(memoryBackend());
    const bundle = await a.bundle({ root, components: [] });
    await expect(b.open(bundle, { workPolicy: PERSON_POLICY, assets: 'http://127.0.0.1:1/' })).rejects.toThrow('this preview bundle was made by another renderer');
    const session = await a.open(bundle, { workPolicy: PERSON_POLICY, assets: 'http://127.0.0.1:1/' });
    await session.close();
    await session.close();
    await expect(session.still({} as never, join(root, 'late.png'), 1)).rejects.toThrow('this preview session is closed');
  });
});
