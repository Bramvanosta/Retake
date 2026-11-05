/**
 * L5.14b measured acceptance of captures first (heavy: gated by RETAKE_TEST_CAPTURES_FIRST=1, run once by hand with the
 * machine otherwise quiet) — from the Studio's own submits (`scenario_run`, `scenario_render` over its HTTP API) with
 * the real worker it starts, on a copy of projects/northfield-fixture whose shop is the fixture product on ports
 * 4941–4942. The scenario is `quote` without the two hooks the Studio cannot approve (the console tab's js hook and a
 * DELETE rollback): the same 47 s of filmed motion.
 * - 3 takes alone (their spread), then a render of the first alone, unpaused: the reference frames;
 * - 3 times: a render queued and running, then a take submitted — the take starts at once (the render does not hold
 *   it), the render runs at background priority while the take films (its job's `yield`, its job process at `ps -o pri`
 *   4), at normal priority again after it, and finishes with the reference's frames — identical (framemd5) on the
 *   software path, SSIM ≥ 0.995 on every frame on the GPU path (L5.15: ANGLE + VideoToolbox are not frame-identical run
 *   to run); the reference and every render beside a take use the same resolved policy, none fell back (else the
 *   comparison would not mean anything: a refusal, not a pass);
 * - a quiet machine first (review B M2): the 1-minute load average at the start at most half the cores, each alone
 *   take's highest load at most 1.5 × the cores and the alone takes' motion fps within QUIET_SPREAD_FPS of each other —
 *   else the test FAILS "machine not quiet — re-run" (it never passes on a noisy machine);
 * - fixed bars, independent of the noise: every take beside a render films motion at ≥ the alone median − 2 fps; the
 *   beside takes' median dropped and kicked frames ≤ the alone takes' most; freezes ≤ the alone takes' most;
 * - the render's speed (frames per second) measured before the take, during it and after it: after ≥ 0.8 × before.
 *   "Slower during" is reported, not asserted (L5.15, decided before the run, DESIGN §4q): on the GPU path most of the
 *   render's work is the GPU's and VideoToolbox's, which background QoS does not reach — the take's bars are what
 *   protects the take. The job process and at least half of its tree are at `ps -o pri` 4 during the take (a few
 *   Chromium processes keep a priority of their own, 46 / 47); every process that was at 4 and is still alive is not
 *   after it.
 * - L5.15: the renders run the shipped default policy (this file sets RETAKE_RENDER_GL / _ENCODER back to `auto`).
 * The numbers are printed (and written to RETAKE_CAPTURES_FIRST_OUT when set) for the requirement's evidence.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { cpus, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FileJobQueue, readWorkerLock } from '@retake/engine';
import type { JobRecord } from '@retake/engine';
import { startStudioServer } from '../src/index.js';
import type { StudioServer } from '../src/index.js';
import { REPO } from '../../engine/test/helpers.js';
import { raw } from './http.js';

const ENABLED = process.env.RETAKE_TEST_CAPTURES_FIRST === '1';
const P = 'northfield-fixture';
const S = 'quote-studio';
const FIXTURE_PROJECT = join(REPO, 'projects', P);
const GENERATED = new Set(['runs', 'renders', 'review', 'exports', '.retake', 'frames', 'comments']);
const FINISHED = new Set(['succeeded', 'failed', 'cancelled', 'interrupted']);
/** The alone takes' motion fps may differ by this much on a quiet machine (the spike: 1.0 on a quiet one, 9.1 and 33 on busy ones). */
// The spike's alone takes on a quiet M4 spread 9.1 fps (51.4–60.5, DESIGN §4q): a quiet set stays within 10.
const QUIET_SPREAD_FPS = 10;
const CORES = cpus().length;

/** The 1-minute load average (sysctl vm.loadavg). */
function load1(): number {
  return Number(spawnSync('sysctl', ['-n', 'vm.loadavg'], { encoding: 'utf8' }).stdout.replace(/[{}]/g, '').trim().split(/\s+/)[0]);
}

/** Fails the test (never passes it) when the machine is too busy to conclude. */
function notQuiet(why: string): never {
  throw new Error(`machine not quiet — re-run (on an otherwise idle machine): ${why}`);
}

interface Fixture {
  urls: { console: string; shop: string };
  close(): Promise<void>;
}
interface TakePerf {
  run: string;
  fps_min: number;
  dropped: number;
  kicked: number;
  stalls: number;
  load_max: number;
  takes_beside?: number;
  heavy_slowed?: boolean;
}

let fixture: Fixture;
let root: string;
let project: string;
let studio: StudioServer;
let queue: FileJobQueue;
let text: string;
const savedHome = process.env.RETAKE_HOME;
const savedRender = { gl: process.env.RETAKE_RENDER_GL, encoder: process.env.RETAKE_RENDER_ENCODER };
const workers = new Set<number>();

const call = async (op: string, args: unknown) => {
  const r = await raw(studio.port, 'POST', `/v1/call/${op}`, { authorization: `Bearer ${studio.token}`, 'content-type': 'application/json' }, JSON.stringify(args));
  if (r.status !== 200) throw new Error(`${op}: ${r.status} ${r.body.slice(0, 400)}`);
  return r.json<{ data: Record<string, unknown> }>().data;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

function noteWorker(): void {
  const w = readWorkerLock(root);
  if (w) workers.add(w.pid);
}

async function until<T>(what: string, fn: () => Promise<T | undefined | false> | T | undefined | false, ms: number, every = 250): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(every);
  }
}

const finished = (id: string) => until(`job ${id} to end`, async () => {
  const j = await queue.get(id);
  return j && FINISHED.has(j.state) ? j : undefined;
}, 15 * 60_000, 500);

/** A take from the Studio (scenario_run capture): its job and run id. */
async function submitTake(): Promise<{ job: string; run: string; at: number }> {
  const at = Date.now();
  const d = await call('scenario_run', { project: P, name: S, mode: 'capture' });
  noteWorker();
  return { job: String(d.job), run: String(d.run_id), at };
}

function perfOf(run: string): TakePerf {
  const rec = JSON.parse(readFileSync(join(project, 'runs', run, 'run.json'), 'utf8')) as { status: string; perf: { frames: { motion_fps_min: number; dropped: number; kicked: number }; stalls: unknown[]; machine: { load_max: number; takes_beside?: number; heavy_slowed?: true } } };
  expect(rec.status, run).toBe('succeeded');
  const p = rec.perf;
  // Frames of the take are not needed once measured (disk).
  spawnSync('rm', ['-rf', join(project, 'runs', run, 'frames')]);
  return { run, fps_min: p.frames.motion_fps_min, dropped: p.frames.dropped, kicked: p.frames.kicked, stalls: p.stalls.length, load_max: p.machine.load_max, ...(p.machine.takes_beside !== undefined ? { takes_beside: p.machine.takes_beside } : {}), ...(p.machine.heavy_slowed ? { heavy_slowed: true } : {}) };
}

/** A render of `run` from the Studio (scenario_render): its job and render id. */
async function submitRender(run: string): Promise<{ job: string; id: string }> {
  const d = await call('scenario_render', { project: P, name: S, run, expect_edit_sha256: createHash('sha256').update(text).digest('hex') });
  noteWorker();
  return { job: String(d.job), id: String(d.render_id) };
}

/** The record of a render: what drew it (L5.15 `policy`). */
function renderPolicyOf(id: string): { gl: string; encoder: string; fallback: boolean } {
  const r = JSON.parse(readFileSync(join(project, 'renders', `${id}.json`), 'utf8')) as { policy?: { gl: { used: string }; encoder: { used: string }; fallback?: unknown } };
  return { gl: r.policy?.gl.used ?? 'software', encoder: r.policy?.encoder.used ?? 'libx264', fallback: r.policy?.fallback !== undefined };
}

/** The SSIM of every frame of render `a` against render `b` (ffmpeg's ssim filter). */
function ssimFrames(a: string, b: string): number[] {
  const out = spawnSync('ffmpeg', ['-v', 'error', '-i', join(project, 'renders', `${a}.mp4`), '-i', join(project, 'renders', `${b}.mp4`), '-lavfi', '[0:v][1:v]ssim=stats_file=-', '-f', 'null', '-'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }).stdout;
  return out.split('\n').map((l) => /All:([\d.]+)/.exec(l)?.[1]).filter((x): x is string => !!x).map(Number);
}

function framemd5(id: string): string[] {
  const out = execFileSync('ffmpeg', ['-v', 'error', '-i', join(project, 'renders', `${id}.mp4`), '-map', '0:v', '-f', 'framemd5', '-'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return out.split('\n').filter((l) => l && !l.startsWith('#'));
}

/** `ps -o pri` of every process of a tree (its group and descendants by parent pid), by pid. */
function treePri(pid: number): Map<number, number> {
  const rows = spawnSync('ps', ['-A', '-o', 'pid=,ppid=,pgid=,pri='], { encoding: 'utf8' }).stdout.trim().split('\n').map((l) => l.trim().split(/\s+/).map(Number) as [number, number, number, number]);
  const tree = new Set<number>([pid]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const [p, pp, g] of rows) if (!tree.has(p) && (tree.has(pp) || g === pid)) (tree.add(p), (grew = true));
  }
  return new Map(rows.filter(([p]) => tree.has(p)).map(([p, , , pri]) => [p, pri]));
}

/** The `ps -o pri` of the given pids still alive. */
function priOfPids(pids: Iterable<number>): Map<number, number> {
  const want = new Set(pids);
  const rows = spawnSync('ps', ['-A', '-o', 'pid=,pri='], { encoding: 'utf8' }).stdout.trim().split('\n').map((l) => l.trim().split(/\s+/).map(Number) as [number, number]);
  return new Map(rows.filter(([p]) => want.has(p)));
}

/** Frames per second of a render's progress between two samples (steps_done: frames rendered). */
const rate = (a: { t: number; f: number }, b: { t: number; f: number }) => (b.f - a.f) / Math.max(0.001, (b.t - a.t) / 1000);

describe.skipIf(!ENABLED)('captures first, measured from the Studio (RETAKE_TEST_CAPTURES_FIRST=1)', () => {
  beforeAll(async () => {
    const mod = (await import(join(REPO, 'fixtures/wholesale/server.mjs'))) as { startFixture(o: { consolePort: number; shopPort: number; host?: string }): Promise<Fixture> };
    fixture = await mod.startFixture({ consolePort: 4941, shopPort: 4942, host: '127.0.0.1' });
    root = await mkdtemp(join(tmpdir(), 'retake-captures-first-acceptance-'));
    process.env.RETAKE_HOME = join(root, '.home');
    // The shipped default (the suite pins the software path, vitest.setup.ts): the Studio's worker inherits it.
    process.env.RETAKE_RENDER_GL = 'auto';
    process.env.RETAKE_RENDER_ENCODER = 'auto';
    await writeFile(join(root, 'retake.yaml'), `projects_dir: projects\ntemplates_dir: ${JSON.stringify(join(REPO, 'templates'))}\n`);
    project = join(root, 'projects', P);
    await cp(FIXTURE_PROJECT, project, { recursive: true, filter: (src) => !GENERATED.has(src.slice(FIXTURE_PROJECT.length + 1).split('/')[0]) });
    const yaml = await readFile(join(project, 'project.yaml'), 'utf8');
    await writeFile(join(project, 'project.yaml'), yaml.replaceAll('http://localhost:4401', fixture.urls.console.replace(/\/$/, '')).replaceAll('http://localhost:4402', fixture.urls.shop.replace(/\/$/, '')));
    // quote without the hooks a Studio submit cannot approve (no approver: the console tab's js hook, a DELETE rollback).
    const quote = await readFile(join(project, 'scenarios', 'quote.yaml'), 'utf8');
    text = quote
      .replace(/^video: quote$/m, 'video: quote-studio')
      .replace(/\n      rollback: \{method: DELETE, url: "\{\{shop\}\}\/api\/quotes\/auto-proposal"\}/, '')
      .replace(/\n {2}- name: open-console\n {4}js: \{page: console, code: "return location\.href"\}/, '');
    expect(text).not.toMatch(/- name: open-console/);
    expect(text).not.toMatch(/rollback: \{method: DELETE/);
    expect(text).toMatch(/^video: quote-studio$/m);
    await writeFile(join(project, 'scenarios', `${S}.yaml`), text);
    await symlink(join(REPO, 'fixtures'), join(root, 'fixtures'));
    studio = await startStudioServer({ root, workerIdleExitMs: 20_000 });
    queue = new FileJobQueue(root);
  }, 180_000);

  afterAll(async () => {
    await studio?.close();
    if (root) noteWorker();
    for (const pid of workers) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        /* exited on its own */
      }
    }
    await sleep(2000);
    for (const pid of workers) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* gone */
      }
    }
    await fixture?.close();
    if (savedHome === undefined) delete process.env.RETAKE_HOME;
    else process.env.RETAKE_HOME = savedHome;
    for (const [k, v] of [['RETAKE_RENDER_GL', savedRender.gl], ['RETAKE_RENDER_ENCODER', savedRender.encoder]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('takes beside a render are within the alone spread; the render is at background priority during each take, back after, its frames unchanged', async () => {
    const t0 = Date.now();
    // 0. A quiet machine, or no conclusion (review B M2).
    const startLoad = load1();
    if (!(startLoad <= CORES / 2)) notQuiet(`load average ${startLoad} at the start on ${CORES} cores (at most ${CORES / 2})`);
    // 1. Takes alone.
    const alone: TakePerf[] = [];
    for (let i = 0; i < 3; i++) {
      const t = await submitTake();
      expect((await finished(t.job)).state).toBe('succeeded');
      alone.push(perfOf(t.run));
    }
    const aloneFps = alone.map((x) => x.fps_min);
    const spread = Math.max(...aloneFps) - Math.min(...aloneFps);
    if (spread > QUIET_SPREAD_FPS) notQuiet(`the alone takes filmed motion at ${aloneFps.join(' / ')} fps (spread ${spread.toFixed(1)}, at most ${QUIET_SPREAD_FPS})`);
    const busiest = Math.max(...alone.map((x) => x.load_max));
    if (busiest > CORES * 1.5) notQuiet(`load up to ${busiest} during the alone takes on ${CORES} cores (at most ${CORES * 1.5})`);
    const base = alone[0]!.run;
    // 2. The reference render, unpaused: its frames and its speed.
    const ref = await submitRender(base);
    const refSamples: Array<{ t: number; f: number }> = [];
    for (;;) {
      const j = await queue.get(ref.job);
      if (j?.state === 'running' && j.progress?.phase === 'rendering' && typeof j.progress.steps_done === 'number') refSamples.push({ t: Date.now(), f: j.progress.steps_done });
      if (j && FINISHED.has(j.state)) break;
      await sleep(250);
    }
    expect((await queue.get(ref.job))?.state).toBe('succeeded');
    const refFps = refSamples.length >= 2 ? Math.round(rate(refSamples[0]!, refSamples[refSamples.length - 1]!) * 10) / 10 : null;
    const refFrames = framemd5(ref.id);
    expect(refFrames.length).toBeGreaterThan(100);
    const refPolicy = renderPolicyOf(ref.id);
    // A GPU-path failure of the shipped default is a finding, not noise (review B L4): its own failure, never "re-run".
    expect(refPolicy.fallback, `the reference render (${ref.id}) failed on the GPU path and was rendered again in software — a failure of the default render path on this Mac, not a busy machine`).toBe(false);
    const gpuPath = refPolicy.gl === 'angle' || refPolicy.encoder === 'h264_videotoolbox';

    // 3. Takes beside a render.
    const beside: TakePerf[] = [];
    const renders: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 3; i++) {
      const r = await submitRender(base);
      const samples: Array<{ t: number; f: number; held: boolean }> = [];
      let sampling = true;
      const sampler = (async () => {
        while (sampling) {
          const j = await queue.get(r.job).catch(() => undefined);
          if (j?.state === 'running' && j.progress?.phase === 'rendering' && typeof j.progress.steps_done === 'number') samples.push({ t: Date.now(), f: j.progress.steps_done, held: j.yield?.state === 'background' });
          if (j && FINISHED.has(j.state)) break;
          await sleep(250);
        }
      })();
      // Rendering for 4 s at least (its speed before the take: review B M3), then the take.
      await until('the render rendering for 4 s', () => samples.length >= 2 && samples[samples.length - 1]!.t - samples[0]!.t >= 4000, 10 * 60_000);
      const take = await submitTake();
      // It starts at once: the render does not hold it (a capture slot of its own).
      const started = await until('the take running', async () => {
        const j = await queue.get(take.job);
        return j?.started_at ? j : undefined;
      }, 60_000, 100);
      const startDelay = Date.parse(started.started_at!) - take.at;
      // Slowed while the take films: its yield, and every process of its job process at background QoS.
      const held: JobRecord = await until('the render slowed', async () => {
        const j = await queue.get(r.job);
        return j?.yield?.state === 'background' ? j : undefined;
      }, 120_000);
      // Its worker writes yield.json, then lowers the tree (one walk, then a walk every 2 s for new processes).
      const priOf = (pid: number) => Number(spawnSync('ps', ['-o', 'pri=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim() || NaN);
      await until('the job process at background QoS', () => priOf(held.worker!.pid) === 4, 15_000, 100);
      await sleep(2500);
      const priMap = treePri(held.worker!.pid);
      const pri = [...priMap.values()];
      // The processes the worker set to background (Chromium's own helpers keep a priority of their own).
      const lowered = [...priMap].filter(([, v]) => v === 4).map(([p]) => p);
      const takeEnd = await finished(take.job);
      expect(takeEnd.state).toBe('succeeded');
      beside.push(perfOf(take.run));
      // Back to normal priority after it.
      await until('the render at normal priority again', async () => {
        const j = await queue.get(r.job);
        return j && (FINISHED.has(j.state) || j.yield === undefined) ? j : undefined;
      }, 60_000);
      const after = (await queue.get(r.job))!;
      // Each process lowered during the take and still alive: back from 4 (review B M3: per process, not "any").
      await sleep(500);
      const backFrom = after.state === 'running' ? priOfPids(lowered) : new Map<number, number>();
      const priAfter = [...backFrom.values()];
      const end = await finished(r.job);
      sampling = false;
      await sampler;
      expect(end.state).toBe('succeeded');
      const same = framemd5(r.id);
      const policy = renderPolicyOf(r.id);
      // The same resolved policy as the reference, no fallback (critique M3): else the comparison means nothing.
      expect(policy, `the render beside the take drew as the reference did (${r.id})`).toEqual(refPolicy);
      const ssim = gpuPath ? ssimFrames(r.id, ref.id) : [];
      const before = samples.filter((s) => !s.held && s.t < take.at);
      const during = samples.filter((s) => s.held);
      const afterS = samples.filter((s) => !s.held && s.t > Date.parse(takeEnd.finished_at!));
      const fps = (xs: typeof samples) => (xs.length >= 2 ? Math.round(rate(xs[0]!, xs[xs.length - 1]!) * 10) / 10 : null);
      const speed = { before: fps(before), during: fps(during), after: fps(afterS) };
      renders.push({ render: r.id, take_start_delay_ms: startDelay, pri_during: pri.join(','), pri_after: priAfter.join(','), fps_before: speed.before, fps_during: speed.during, fps_after: speed.after, frames: same.length, identical: same.length === refFrames.length && same.every((l, k) => l === refFrames[k]), gl: policy.gl, encoder: policy.encoder, slower_during: speed.during !== null && speed.before !== null && speed.during < speed.before, ...(gpuPath ? { ssim_min: Math.min(...ssim) } : {}) });
      expect(startDelay).toBeLessThan(5000);
      // The job process and most of its tree at background QoS (`ps -o pri` 4); a few Chromium processes keep a priority
      // of their own (46 / 47, seen by the spike too): counted, not failed.
      expect(pri.filter((p) => p === 4).length / pri.length, `pri during the take: ${pri.join(',')}`).toBeGreaterThanOrEqual(0.5);
      expect(lowered).toContain(held.worker!.pid);
      if (after.state === 'running') {
        expect(backFrom.get(held.worker!.pid), 'the job process after the take').not.toBe(4);
        for (const [p, v] of backFrom) expect(v, `pid ${p} lowered during the take, after it`).not.toBe(4);
      }
      // Back to its speed after the take. Slower during it is reported (renders[].slower_during), not asserted (L5.15).
      expect(speed.before, 'the render\'s speed before the take').not.toBeNull();
      expect(speed.during).not.toBeNull();
      expect(speed.after, 'the render\'s speed after the take').not.toBeNull();
      expect(speed.after!).toBeGreaterThanOrEqual(0.8 * speed.before!);
      if (gpuPath) {
        expect(same.length).toBe(refFrames.length);
        expect(ssim).toHaveLength(refFrames.length);
        expect(Math.min(...ssim), `the frames beside the take against the reference (${r.id})`).toBeGreaterThanOrEqual(0.995);
      } else expect(same).toEqual(refFrames);
    }

    const a = { fps: aloneFps, kicked: alone.map((x) => x.kicked), dropped: alone.map((x) => x.dropped), stalls: alone.map((x) => x.stalls) };
    // Fixed bars (review B M2): never widened by the alone takes' noise (the quiet gate refused a noisy machine above).
    const bar = median(a.fps) - 2;
    const out = { start_load: startLoad, cores: CORES, alone, beside, renders, ref_render_fps: refFps, alone_median: { fps_min: median(a.fps), kicked: median(a.kicked), dropped: median(a.dropped) }, alone_max: { kicked: Math.max(...a.kicked), dropped: Math.max(...a.dropped) }, alone_spread: spread, bar, beside_min_fps: Math.min(...beside.map((x) => x.fps_min)), beside_median: { fps_min: median(beside.map((x) => x.fps_min)), kicked: median(beside.map((x) => x.kicked)), dropped: median(beside.map((x) => x.dropped)) }, minutes: Math.round((Date.now() - t0) / 6000) / 10 };
    console.log(`captures first acceptance: ${JSON.stringify(out, null, 1)}`);
    if (process.env.RETAKE_CAPTURES_FIRST_OUT) writeFileSync(process.env.RETAKE_CAPTURES_FIRST_OUT, `${JSON.stringify(out, null, 1)}\n`);
    // The take's report says what ran beside it.
    for (const b of beside) expect(b).toMatchObject({ takes_beside: 0, heavy_slowed: true });
    // Every take beside a render films motion at the alone median − 2 fps at least.
    expect(out.beside_min_fps).toBeGreaterThanOrEqual(bar);
    // Dropped and kicked frames: the beside takes' median within what the alone takes did at most.
    expect(out.beside_median.kicked).toBeLessThanOrEqual(out.alone_max.kicked);
    expect(out.beside_median.dropped).toBeLessThanOrEqual(out.alone_max.dropped);
    expect(median(beside.map((x) => x.stalls))).toBeLessThanOrEqual(Math.max(...a.stalls));
    expect(existsSync(join(project, 'renders', `${ref.id}.mp4`))).toBe(true);
  }, 45 * 60_000);
});
