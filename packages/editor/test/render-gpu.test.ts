/**
 * L5.15 renders on the GPU — real renders on this Mac (darwin only: skipped elsewhere), opted in to the GPU path
 * through `settings` (the suite pins the software path, vitest.setup.ts):
 * - the default policy: ANGLE (Metal) + VideoToolbox — the record says so, no x264 in the file, a key frame every 2 s,
 *   SSIM ≥ 0.995 on every frame against the software render of the same plan (never bytes: the GPU is not
 *   frame-identical run to run);
 * - the VideoToolbox probe: the compositor's ffmpeg as Remotion spawns it, in place and from a relinked copy (the app
 *   bundle's layout), and its measured size limit;
 * - an oversize render (scale 3) in a process with no handler of its own: libx264, said; VideoToolbox forced there
 *   breaks the encoder's pipe (EPIPE) — the process does not crash and the render falls back to software;
 * - no GPU found (an injected SystemInfo reply) and the GPU path failing (an injected failure): the browser that renders
 *   instead is reported again (`onBrowser`) and guarded again (a request outside the allow-list refused), progress
 *   never goes back, one fallback only, a cancel during it cancels, nothing half-written is kept.
 * L5.15 fixes: a reopen in software renders at the software default concurrency (what doctor says); a page of a guarded
 * GPU render that fails gets our one software retry, guarded, and Remotion never opens a browser of its own; a render
 * failing on both paths keeps the GPU story in its record; the Library's preview backend on the GPU path — its check,
 * its reopen, the browser reported and guarded after it, drawn as the policy says.
 * Needs ffmpeg/ffprobe and a Chromium headless shell.
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { scaffoldDir } from '@retake/components';
import { loadTemplate, fileFacts } from '@retake/core/io';
import { loadComponentRegistry } from '@retake/components';
import { PERSON_POLICY } from '@retake/core';
import {
  REMOTION_PREVIEW_BACKEND,
  RenderCancelledError,
  RenderError,
  defaultConcurrency,
  planRun,
  probeRenderPath,
  renderComponentLoops,
  renderPlan,
  renderStills,
  renderVideo,
  resetVideotoolboxProbes,
  videotoolboxRenderWorks,
} from '@retake/editor';
import type { BrowserProcessInfo, EditPlan, PreviewBackend, RenderProgress } from '@retake/editor';
import { SHARED_CACHE, hasTool, renderWorkspace } from './render-helpers.js';
import type { RenderWorkspace } from './render-helpers.js';

const canRender = process.platform === 'darwin' && hasTool('ffmpeg') && hasTool('ffprobe');
const HERE = fileURLToPath(new URL('.', import.meta.url));
const LONG = 400_000;
const GPU = { gl: 'auto', encoder: 'auto' } as const;
const SWIFTSHADER = async () => ({ accelerated: false, renderer: 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device), SwiftShader driver)' });

let ws: RenderWorkspace;
let b: Server;
let port: number;
let hits: string[] = [];

/** A workspace intro that asks B for a file (past the compile-time scan): a guarded render must refuse it. */
function reachingIntro(p: number): string {
  return `import { useEffect } from 'react';
import { AbsoluteFill, continueRender, delayRender } from 'remotion';

export default function Reaching() {
  useEffect(() => {
    const get = (globalThis as unknown as Record<string, (u: string) => Promise<unknown>>)['fe' + 'tch'];
    const handle = delayRender('reaching');
    const timeout = new Promise((done) => (globalThis as unknown as { setTimeout: (f: () => void, ms: number) => void }).setTimeout(() => done(undefined), 3000));
    Promise.race([get('http://127.0.0.1:${p}/fetch').catch(() => undefined), timeout]).then(() => continueRender(handle));
  }, []);
  return <AbsoluteFill style={{ background: '#204060' }} />;
}
`;
}

/** A workspace intro whose page fails once its request to B is refused. */
function closingIntro(p: number): string {
  return `import { useEffect } from 'react';
import { AbsoluteFill, continueRender, delayRender } from 'remotion';

export default function Closing() {
  useEffect(() => {
    const get = (globalThis as unknown as Record<string, (u: string) => Promise<unknown>>)['fe' + 'tch'];
    const handle = delayRender('closing');
    get('http://127.0.0.1:${p}/closing')
      .then(() => continueRender(handle))
      .catch(() => delayRender('Target closed', { timeoutInMilliseconds: 1500 }));
  }, []);
  return <AbsoluteFill style={{ background: '#206040' }} />;
}
`;
}

/** The render browsers (headless shells with a profile under this run's temp folder) alive now, by pid. */
function renderBrowsers(): number[] {
  const out = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' });
  const tmp = tmpdir().replace(/\/$/, '');
  return out
    .split('\n')
    .filter((l) => l.includes('puppeteer_dev_chrome_profile') && l.includes(tmp) && !l.includes('--type='))
    .map((l) => Number(l.trim().split(/\s+/)[0]));
}

/** The command line of a process. */
const commandOf = (pid: number) => execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' });

async function reachingPlan(): Promise<EditPlan> {
  const planned = await planRun({ workPolicy: PERSON_POLICY, project: ws.project, run: 'latest', root: ws.root, overrides: { scale: 0.25, intro: true, components: { intro: 'acme/reaching' } } });
  expect(planned.plan.segments[0]?.component.id).toBe('acme/reaching');
  return planned.plan;
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** The SSIM of every frame of `a` against `b` (ffmpeg's ssim filter). */
function ssimFrames(a: string, b: string): number[] {
  const out = spawnSync('ffmpeg', ['-v', 'error', '-i', a, '-i', b, '-lavfi', '[0:v][1:v]ssim=stats_file=-', '-f', 'null', '-'], { encoding: 'utf8', maxBuffer: 64e6 }).stdout;
  return out
    .split('\n')
    .map((l) => /All:([\d.]+)/.exec(l)?.[1])
    .filter((x): x is string => !!x)
    .map(Number);
}

function keyFrames(file: string): number {
  const out = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'frame=key_frame', '-of', 'csv=p=0', file], { encoding: 'utf8' });
  return out.split('\n').filter((l) => l.trim().split(',')[0] === '1').length;
}

beforeAll(async () => {
  if (!canRender) return;
  ws = await renderWorkspace();
  const dir = join(ws.root, 'components', 'acme', 'reaching');
  await mkdir(dirname(dir), { recursive: true });
  await cp(scaffoldDir('intro'), dir, { recursive: true });
  await writeFile(join(dir, 'component.yaml'), (await readFile(join(dir, 'component.yaml'), 'utf8')).replace(/^id: .*$/m, 'id: acme/reaching'));
  b = createServer((req, res) => {
    hits.push(req.url ?? '');
    res.writeHead(200, { 'Access-Control-Allow-Origin': '*' }).end('x');
  });
  await new Promise<void>((r) => b.listen(0, '127.0.0.1', () => r()));
  port = (b.address() as AddressInfo).port;
  await writeFile(join(dir, 'index.tsx'), reachingIntro(port));
  const closing = join(ws.root, 'components', 'acme', 'closing');
  await cp(scaffoldDir('intro'), closing, { recursive: true });
  await writeFile(join(closing, 'component.yaml'), (await readFile(join(closing, 'component.yaml'), 'utf8')).replace(/^id: .*$/m, 'id: acme/closing'));
  await writeFile(join(closing, 'index.tsx'), closingIntro(port));
}, LONG);
afterAll(async () => {
  await new Promise<void>((r) => (b ? b.close(() => r()) : r()));
  await ws?.cleanup();
});

describe.skipIf(!canRender)('the GPU path on this Mac', () => {
  it('the default policy draws with ANGLE (Metal) and encodes with VideoToolbox: said in the record, a key frame every 2 s, SSIM ≥ 0.995 against software', async () => {
    const gpu = await renderVideo({ workPolicy: PERSON_POLICY, project: ws.project, root: ws.root, run: 'latest', scenario: 'synthetic', overrides: { scale: 0.25 }, cacheDir: SHARED_CACHE, out: join(ws.root, 'gpu.mp4'), settings: GPU });
    expect(gpu.policy).toMatchObject({
      gl: { asked: 'auto', source: 'option', resolved: 'angle', used: 'angle', renderer: expect.stringMatching(/Metal/) },
      encoder: { asked: 'auto', used: 'h264_videotoolbox' },
    });
    expect(gpu.policy?.fallback).toBeUndefined();
    expect(gpu.encoding).toMatchObject({ codec: 'h264', encoder: 'h264_videotoolbox', bitrate: '1M', gop: 60 });
    expect(gpu.encoding.crf).toBeUndefined();
    expect(gpu.concurrency).toBe(3);
    expect(readFileSync(gpu.file).includes('x264 - core')).toBe(false);
    // 57 frames, a key frame every 60: one (ffmpeg's default of 12 without gopSize gives 5).
    expect(gpu.frames).toBe(57);
    expect(keyFrames(gpu.file)).toBe(1);
    const sw = await renderVideo({ workPolicy: PERSON_POLICY, project: ws.project, root: ws.root, run: 'latest', scenario: 'synthetic', overrides: { scale: 0.25 }, cacheDir: SHARED_CACHE, out: join(ws.root, 'sw.mp4'), settings: { gl: 'software', encoder: 'libx264' } });
    expect(sw.policy).toMatchObject({ gl: { used: 'software' }, encoder: { used: 'libx264' } });
    expect(readFileSync(sw.file).includes('x264 - core')).toBe(true);
    const ssim = ssimFrames(gpu.file, sw.file);
    expect(ssim).toHaveLength(57);
    expect(Math.min(...ssim)).toBeGreaterThanOrEqual(0.995);
  }, LONG);

  it("the VideoToolbox probe: the compositor's ffmpeg as Remotion spawns it — in place and relinked as in the app — and its size limit", async () => {
    resetVideotoolboxProbes();
    expect(await videotoolboxRenderWorks({ width: 1920, height: 1080, fps: 30 })).toEqual({ ok: true });
    expect(await videotoolboxRenderWorks({ width: 4096, height: 4096, fps: 30 })).toEqual({ ok: true });
    const over = await videotoolboxRenderWorks({ width: 4104, height: 2304, fps: 30 });
    expect(over.ok).toBe(false);
    expect(over.error).toMatch(/-12903|compression session/);
    // The app's layout (apps/desktop/scripts/bundle.mjs relinkCompositor): the dylibs found through @loader_path.
    const { RenderInternals } = await import('@remotion/renderer');
    const inPlace = dirname(RenderInternals.getExecutablePath({ type: 'ffmpeg', indent: false, logLevel: 'error', binariesDirectory: null }));
    const copy = mkdtempSync(join(tmpdir(), 'retake-compositor-'));
    try {
      cpSync(inPlace, copy, { recursive: true });
      for (const f of readdirSync(copy).filter((x) => x === 'ffmpeg' || x.endsWith('.dylib'))) {
        const file = join(copy, f);
        const names = execFileSync('otool', ['-L', file], { encoding: 'utf8' })
          .split('\n')
          .slice(1)
          .map((l) => l.trim().split(' (')[0])
          .filter((n) => n && !n.includes('/'));
        const args = [...(f.endsWith('.dylib') ? ['-id', `@loader_path/${f}`] : []), ...names.filter((n) => n !== f).flatMap((n) => ['-change', n, `@loader_path/${n}`])];
        if (args.length) execFileSync('install_name_tool', [...args, file], { stdio: 'ignore' });
        execFileSync('codesign', ['--force', '-s', '-', file], { stdio: 'ignore' });
      }
      expect(await videotoolboxRenderWorks({ width: 1920, height: 1080, fps: 30 }, { binariesDirectory: copy })).toEqual({ ok: true });
    } finally {
      rmSync(copy, { recursive: true, force: true });
    }
  }, LONG);

  it('scale 3 (5760×3240): libx264, said; VideoToolbox forced there breaks its pipe — no crash, rendered again in software', async () => {
    const renderIn = (mode: string, out: string): Promise<Record<string, unknown>> =>
      new Promise((done, fail) => {
        const child = spawn(process.execPath, ['--conditions=source', '--import', 'tsx', join(HERE, 'fixtures', 'render-oversize.mts'), ws.root, join(ws.root, out), SHARED_CACHE, mode], {
          cwd: join(HERE, '..'),
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
        child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
        child.on('error', fail);
        child.on('exit', (code) => {
          const line = stdout.trim().split('\n').pop() ?? '';
          if (!line.startsWith('{')) fail(new Error(`the render process died (exit ${code}): ${stderr.slice(-2000)}`));
          else done(JSON.parse(line) as Record<string, unknown>);
        });
      });
    const auto = await renderIn('auto', 'big-auto.mp4');
    expect(auto, JSON.stringify(auto)).toMatchObject({ ok: true, width: 5760, height: 3240, path: { gl: { used: 'angle' }, encoder: { used: 'libx264' } }, encoding: { encoder: 'libx264', crf: 16 } });
    expect((auto.warnings as string[]).join('\n')).toMatch(/at most 4096 pixels a side and this render is 5760×3240: encoded with libx264/);
    expect(auto.guarded, 'the render installed its encoder-pipe guard (the process has none of its own)').toBe(1);
    const forced = await renderIn('force-videotoolbox', 'big-forced.mp4');
    expect(forced, JSON.stringify(forced)).toMatchObject({ ok: true, path: { gl: { used: 'software' }, encoder: { used: 'libx264' }, fallback: { reason: expect.stringMatching(/EPIPE|compression session|videotoolbox/i) } } });
    expect((forced.warnings as string[]).join('\n')).toMatch(/failed on the GPU path \(.*(EPIPE|compression session|videotoolbox).*\) and was rendered again in software/i);
    expect(existsSync(join(ws.root, 'big-forced.mp4'))).toBe(true);
    expect(readdirSync(ws.root).filter((f) => f.includes('.partial-'))).toEqual([]);
  }, LONG);

  it('no GPU under auto: reopened in software before it is reported or guarded — the browser that renders is the one reported, and guarded', async () => {
    const plan = await reachingPlan();
    const browsers: BrowserProcessInfo[] = [];
    hits = [];
    const res = await renderPlan({ workPolicy: PERSON_POLICY,
      plan,
      out: join(ws.root, 'nogpu.mp4'),
      root: ws.root,
      cacheDir: SHARED_CACHE,
      network: 'guard',
      frameRange: [0, 5],
      settings: GPU,
      onBrowser: (x) => browsers.push(x),
      seams: { gpuInfo: SWIFTSHADER, beforeRender: () => expect(alive(browsers[0].pid)).toBe(true) },
    });
    expect(browsers).toHaveLength(1);
    expect(res.path).toMatchObject({ gl: { asked: 'auto', resolved: 'angle', used: 'software' }, encoder: { used: 'libx264' } });
    expect(res.path.gl.renderer).toBeUndefined();
    expect(res.warnings).toContain('no GPU for this render (ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device), SwiftShader driver)): rendered in software');
    expect(hits).toEqual([]);
    expect(res.warnings.join('\n')).toMatch(new RegExp(`the render blocked .*requests? to http://127\\.0\\.0\\.1:${port}`));
    // Review A M1 / B M1: in software at the software default (¾ of the CPUs), not the GPU path's 3 — what doctor says.
    expect(res.concurrency).toBe(defaultConcurrency());
    const saved = { gl: process.env.RETAKE_RENDER_GL, enc: process.env.RETAKE_RENDER_ENCODER };
    try {
      process.env.RETAKE_RENDER_GL = 'auto';
      process.env.RETAKE_RENDER_ENCODER = 'auto';
      const doctor = await probeRenderPath({ work: PERSON_POLICY, gpuInfo: SWIFTSHADER });
      expect(doctor).toMatchObject({ gl: 'software', encoder: 'libx264', concurrency: res.concurrency });
    } finally {
      process.env.RETAKE_RENDER_GL = saved.gl;
      process.env.RETAKE_RENDER_ENCODER = saved.enc;
    }
  }, LONG);

  it('stills: the same GPU check (no GPU → software, said), no fallback mid-way', async () => {
    const plan = await reachingPlan();
    const warnings: string[] = [];
    const browsers: BrowserProcessInfo[] = [];
    hits = [];
    const [file] = await renderStills({ workPolicy: PERSON_POLICY,
      plan,
      frames: [{ frame: 2, out: join(ws.root, 'still.png') }],
      root: ws.root,
      cacheDir: SHARED_CACHE,
      network: 'guard',
      settings: GPU,
      onBrowser: (x) => browsers.push(x),
      onWarnings: (w) => warnings.push(...w),
      seams: { gpuInfo: SWIFTSHADER },
    });
    expect(existsSync(file)).toBe(true);
    expect(browsers).toHaveLength(1);
    expect(warnings[0]).toMatch(/^no GPU for this render .*: rendered in software$/);
    expect(hits).toEqual([]);
  }, LONG);

  it('the GPU path failing: one fallback in software + libx264 through a new browser, reported and guarded again; progress never goes back', async () => {
    const plan = await reachingPlan();
    const browsers: BrowserProcessInfo[] = [];
    const progress: RenderProgress[] = [];
    const attempts: Array<{ n: number; gl: string; encoder: string }> = [];
    hits = [];
    const res = await renderPlan({
      plan,
      out: join(ws.root, 'fallback.mp4'),
      root: ws.root,
      cacheDir: SHARED_CACHE,
      network: 'guard',
      frameRange: [0, 5],
      settings: GPU,
      onBrowser: (x) => browsers.push(x),
      onProgress: (p) => progress.push(p),
      seams: {
        beforeRender: (n, path) => {
          attempts.push({ n, ...path });
          if (n === 1) throw new Error('GPU process exited unexpectedly: exit_code=15');
          // The retry's browser is the one the worker was told about (it can kill it); the first one is gone.
          expect(browsers).toHaveLength(2);
          expect(browsers[1].pid).not.toBe(browsers[0].pid);
          expect(alive(browsers[1].pid)).toBe(true);
          expect(alive(browsers[0].pid)).toBe(false);
        },
      },
    });
    expect(attempts).toEqual([
      { n: 1, gl: 'angle', encoder: 'h264_videotoolbox' },
      { n: 2, gl: 'software', encoder: 'libx264' },
    ]);
    expect(res.path).toMatchObject({ gl: { resolved: 'angle', used: 'software' }, encoder: { asked: 'auto', used: 'libx264' }, fallback: { reason: 'GPU process exited unexpectedly: exit_code=15' } });
    expect(res.encoding).toEqual({ encoder: 'libx264', crf: 16 });
    expect(res.concurrency).toBe(3); // kept (critique M2: never more memory after a failure)
    expect(res.warnings).toContain('the render failed on the GPU path (GPU process exited unexpectedly: exit_code=15) and was rendered again in software');
    // Guarded again: the retry's browser refused B (attempt 1 failed before any page loaded).
    expect(hits).toEqual([]);
    expect(res.warnings.join('\n')).toMatch(new RegExp(`the render blocked .*requests? to http://127\\.0\\.0\\.1:${port}`));
    expect(progress.some((p) => p.stage === 'retrying')).toBe(true);
    for (let i = 1; i < progress.length; i++) expect(progress[i].overall, `event ${i}`).toBeGreaterThanOrEqual(progress[i - 1].overall);
    const frames = progress.map((p) => p.renderedFrames).filter((x): x is number => x !== undefined);
    for (let i = 1; i < frames.length; i++) expect(frames[i]).toBeGreaterThanOrEqual(frames[i - 1]);
    expect(readdirSync(ws.root).filter((f) => f.includes('.partial-'))).toEqual([]);
  }, LONG);

  it('a failure mid-render: the partial file removed before the fallback starts from frame 0; progress clamped, said as retrying', async () => {
    const progress: RenderProgress[] = [];
    let atRetry: string[] = [];
    const res = await renderVideo({ workPolicy: PERSON_POLICY,
      project: ws.project,
      root: ws.root,
      run: 'latest',
      scenario: 'synthetic',
      overrides: { scale: 0.25 },
      cacheDir: SHARED_CACHE,
      out: join(ws.root, 'mid', 'mid.mp4'),
      settings: GPU,
      onProgress: (p) => progress.push(p),
      seams: {
        failAfter: { attempt: 1, frames: 20, message: 'GPU process exited unexpectedly: exit_code=15' },
        beforeRender: (n) => {
          if (n === 2) atRetry = readdirSync(join(ws.root, 'mid'));
        },
      },
    });
    expect(res.policy).toMatchObject({ gl: { used: 'software' }, encoder: { used: 'libx264' }, fallback: { reason: 'GPU process exited unexpectedly: exit_code=15' } });
    expect(atRetry.filter((f) => f.includes('.partial-'))).toEqual([]);
    const retry = progress.findIndex((p) => p.stage === 'retrying');
    expect(retry).toBeGreaterThan(0);
    const reached = Math.max(...progress.slice(0, retry).map((p) => p.renderedFrames ?? 0));
    expect(reached).toBeGreaterThanOrEqual(20);
    for (let i = 1; i < progress.length; i++) expect(progress[i].overall, `event ${i} (${progress[i].stage})`).toBeGreaterThanOrEqual(progress[i - 1].overall);
    for (const p of progress.slice(retry)) if (p.renderedFrames !== undefined) expect(p.renderedFrames).toBeGreaterThanOrEqual(reached);
    expect(readdirSync(join(ws.root, 'mid')).sort()).toEqual(['mid.json', 'mid.mp4']);
  }, LONG);

  it('one fallback only; a failure that is not the GPU path (a timeout) is not retried; a cancel during the fallback cancels', async () => {
    const plan = await reachingPlan();
    let n = 0;
    await expect(
      renderPlan({ workPolicy: PERSON_POLICY, plan, out: join(ws.root, 'twice.mp4'), root: ws.root, cacheDir: SHARED_CACHE, frameRange: [0, 5], settings: GPU, seams: { beforeRender: () => {
        n++;
        throw new Error('GPU process exited unexpectedly');
      } } }),
    ).rejects.toThrow('render failed in software, after the GPU path failed (GPU process exited unexpectedly): GPU process exited unexpectedly');
    expect(n).toBe(2);
    n = 0;
    await expect(
      renderPlan({ workPolicy: PERSON_POLICY, plan, out: join(ws.root, 'timeout.mp4'), root: ws.root, cacheDir: SHARED_CACHE, frameRange: [0, 5], settings: GPU, seams: { beforeRender: () => {
        n++;
        throw new Error('Timeout (90000ms) exceeded rendering the component at frame 3');
      } } }),
    ).rejects.toThrow(/Timeout/);
    expect(n).toBe(1);
    const ac = new AbortController();
    await expect(
      renderPlan({ workPolicy: PERSON_POLICY, plan, out: join(ws.root, 'cancel.mp4'), root: ws.root, cacheDir: SHARED_CACHE, frameRange: [0, 5], settings: GPU, signal: ac.signal, seams: { beforeRender: (k) => {
        if (k === 1) throw new Error('GPU process exited unexpectedly');
        ac.abort();
      } } }),
    ).rejects.toBeInstanceOf(RenderCancelledError);
    expect(existsSync(join(ws.root, 'cancel.mp4'))).toBe(false);
    expect(readdirSync(ws.root).filter((f) => f.includes('.partial-'))).toEqual([]);
  }, LONG);

  it('review B L1: a render failing on the GPU path and again in software keeps the GPU story in its record', async () => {
    const err = await renderVideo({ workPolicy: PERSON_POLICY,
      project: ws.project,
      root: ws.root,
      run: 'latest',
      scenario: 'synthetic',
      overrides: { scale: 0.25 },
      cacheDir: SHARED_CACHE,
      out: join(ws.root, 'both.mp4'),
      settings: GPU,
      seams: {
        beforeRender: (n) => {
          throw new Error(n === 1 ? 'GPU process exited unexpectedly: exit_code=15' : 'Cannot read properties of undefined (reading "x")');
        },
      },
    }).then(
      () => null,
      (e: unknown) => e as RenderError,
    );
    expect(err).toBeInstanceOf(RenderError);
    expect(err!.message).toBe('render failed in software, after the GPU path failed (GPU process exited unexpectedly: exit_code=15): Cannot read properties of undefined (reading "x")');
    expect(err!.record).toMatchObject({
      status: 'failed',
      error: err!.message,
      policy: { gl: { asked: 'auto', resolved: 'angle', used: 'software' }, encoder: { used: 'libx264' }, fallback: { reason: 'GPU process exited unexpectedly: exit_code=15' } },
    });
    expect(err!.record!.warnings).toContain('the render failed on the GPU path (GPU process exited unexpectedly: exit_code=15) and was rendered again in software');
    expect(existsSync(join(ws.root, 'both.mp4'))).toBe(false);
  }, LONG);

  it('a page of a guarded GPU render fails: our one software retry, guarded and reported; Remotion never opens a browser of its own (B gets nothing, none outlives it)', async () => {
    const planned = await planRun({ workPolicy: PERSON_POLICY, project: ws.project, run: 'latest', root: ws.root, overrides: { scale: 0.25, intro: true, components: { intro: 'acme/closing' } } });
    const before = renderBrowsers();
    const browsers: BrowserProcessInfo[] = [];
    const attempts: Array<{ n: number; gl: string }> = [];
    hits = [];
    const err = await renderPlan({ workPolicy: PERSON_POLICY,
      plan: planned.plan,
      out: join(ws.root, 'closing.mp4'),
      root: ws.root,
      cacheDir: SHARED_CACHE,
      network: 'guard',
      frameRange: [0, 5],
      settings: GPU,
      onBrowser: (x) => browsers.push(x),
      seams: { beforeRender: (n, path) => void attempts.push({ n, gl: path.gl }) },
    }).then(
      () => null,
      (e: unknown) => e as RenderError,
    );
    expect(attempts).toEqual([
      { n: 1, gl: 'angle' },
      { n: 2, gl: 'software' },
    ]);
    const words = 'a page of the render failed (its browser closed); a guarded render never continues in another browser';
    expect(err?.message).toBe(`render failed in software, after the GPU path failed (${words}): ${words}`);
    expect(err?.path).toMatchObject({ fallback: { reason: words } });
    expect(hits).toEqual([]);
    expect(browsers).toHaveLength(2);
    await new Promise((r) => setTimeout(r, 1000));
    expect(renderBrowsers().filter((p) => !before.includes(p))).toEqual([]);
  }, LONG);

  it("review B M4: the Library's preview backend on the GPU path — no GPU: reopened in software before it is reported or guarded; with one: drawn with ANGLE", async () => {
    const registry = await loadComponentRegistry({ root: ws.root });
    const template = await loadTemplate('editorial', ws.root, { files: fileFacts(PERSON_POLICY) });
    const info = registry.get('acme/reaching');
    const target = { id: info.manifest.id, dir: info.dir, entry: info.entry, manifest: info.manifest };
    const loops = async (gpuInfo: typeof SWIFTSHADER | undefined, tag: string) => {
      const browsers: Array<BrowserProcessInfo & { command: string }> = [];
      const warnings: string[] = [];
      // The real backend, with its GPU-status seam: what a library job runs.
      const backend: PreviewBackend = { bundle: (o) => REMOTION_PREVIEW_BACKEND.bundle(o), open: (o) => REMOTION_PREVIEW_BACKEND.open({ ...o, ...(gpuInfo ? { gpuInfo } : {}) }) };
      hits = [];
      const r = await renderComponentLoops({ workPolicy: PERSON_POLICY,
        root: ws.root,
        registry,
        template,
        cacheDir: SHARED_CACHE,
        network: 'guard',
        settings: GPU,
        backend,
        onBrowser: (b) => browsers.push({ ...b, command: commandOf(b.pid) }),
        onWarnings: (w) => warnings.push(...w),
        items: [{ target, poster: join(ws.root, `${tag}.png`), loop: join(ws.root, `${tag}.gif`) }],
      });
      return { r, browsers, warnings };
    };
    const none = await loops(SWIFTSHADER, 'loop-nogpu');
    expect(none.r.failed).toEqual([]);
    expect(none.r.rendered.map((x) => x.id)).toEqual(['acme/reaching']);
    expect(existsSync(join(ws.root, 'loop-nogpu.gif'))).toBe(true);
    // One browser reported — the software one that drew the still and the loop (the ANGLE one was closed first).
    expect(none.browsers).toHaveLength(1);
    expect(none.browsers[0]!.command).not.toContain('--use-gl=angle');
    expect(none.warnings).toContain('no GPU for this render (ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device), SwiftShader driver)): rendered in software');
    // Guarded after the reopen: B got nothing, the blocked origin is said.
    expect(hits).toEqual([]);
    expect(none.warnings.join('\n')).toMatch(new RegExp(`the render blocked .*requests? to http://127\\.0\\.0\\.1:${port}`));
    const gpu = await loops(undefined, 'loop-gpu');
    expect(gpu.r.failed).toEqual([]);
    expect(gpu.browsers).toHaveLength(1);
    expect(gpu.browsers[0]!.command).toContain('--use-gl=angle');
    expect(gpu.warnings.filter((w) => /GPU/.test(w))).toEqual([]);
    expect(hits).toEqual([]);
  }, LONG);

  it('a GPU left during the render (Chromium falls back by itself) is what the record says: read again at the end', async () => {
    let calls = 0;
    const res = await renderVideo({ workPolicy: PERSON_POLICY,
      project: ws.project,
      root: ws.root,
      run: 'latest',
      scenario: 'synthetic',
      overrides: { scale: 0.25 },
      cacheDir: SHARED_CACHE,
      out: join(ws.root, 'left.mp4'),
      settings: { gl: 'auto', encoder: 'libx264' },
      seams: { gpuInfo: async () => (++calls === 1 ? { accelerated: true, renderer: 'ANGLE Metal' } : { accelerated: false, renderer: 'SwiftShader' }) },
    });
    expect(calls).toBe(2);
    expect(res.policy?.gl).toMatchObject({ resolved: 'angle', used: 'software' });
    expect(res.warnings.join('\n')).toMatch(/left the GPU during the render \(SwiftShader\)/);
  }, LONG);
});

