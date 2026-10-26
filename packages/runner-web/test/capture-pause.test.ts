/**
 * L4.4 part D (R-UI-19): a capture paused between steps does not film the pause. The capture clock converts every wall
 * time through its list of pauses (critique B1: a time recorded before a pause and converted after it — a held page
 * load — stays right); the take's CPU sampler leaves the pause out (its CPU, its seconds, the unfilmed time of a persona's
 * browser). For real, on an animated board of this test's own (a block sweeps the screen all the time, so a filmed pause
 * would be a run of repeated frames): a capture paused 2.5 s right after a click is as long as the same take unpaused,
 * capture.mp4 is as long as the timeline says, the pause left the wall time of the take and nothing else, no frame lies
 * inside it, the first fresh frame after the resume lands at the pause instant (no frameless gap, no stall — B3), the
 * click's ripple played out before it, the page loads held before and after it are where the frames show them, and the
 * perf report counts the take without it. A multi-page scene pauses both its tracks; a capture paused longer than its
 * maximum stops with the reason. Review B L10: the clock stops before the recorders do (no frameless span filmed per
 * pause), one length for a pause in run.json and the timeline, and checks bound to the timeline, not to two takes.
 *
 * `DEMO_STUDIO_PAUSE_SHOTS=<folder>` saves the frames around the pause point there (to look at them).
 */
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Page } from 'playwright-core';
import type { RunProgress, RunRecord, Timeline, TimelineLoading, TimelinePause } from '@demo-studio/core';
import { CaptureClock, PerfSampler, RunPauser, runScenario } from '../src/index.js';
import type { FrameIndexEntry, RunOptions, ScreencastRecorder } from '../src/index.js';
import { FAST, ffprobeDuration, makeProject, makeScenario, readTimeline, startServer, tempDir } from './helpers.js';
import type { TestServer } from './helpers.js';

const SHOTS = process.env.DEMO_STUDIO_PAUSE_SHOTS;
const FPS = 30;
const PAUSE_MS = 2500;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const STYLE = `body{margin:0;font:20px sans-serif;background:#eef1f5}
#bar{position:absolute;left:0;top:420px;width:120px;height:120px;background:#2050c0;animation:sweep 1s linear infinite}
@keyframes sweep{from{transform:translateX(0)}to{transform:translateX(calc(100vw - 120px))}}
button,a{position:absolute;top:80px;font:20px sans-serif;padding:14px 22px;background:#fff;border:1px solid #889;color:#000;text-decoration:none}`;
/** The board: a block sweeping the screen, a counter button and a link to the report. */
const BOARD = `<!doctype html><html><head><meta charset="utf-8"><title>Board</title><style>${STYLE}</style></head><body>
<button id="count" style="left:60px">Count 0</button><a id="go" href="/report.html" style="left:320px">Report</a><div id="bar"></div>
<script>let n = 0; document.getElementById('count').onclick = (e) => { e.target.textContent = 'Count ' + (++n); };</script></body></html>`;
/**
 * The report: the sweeping block only (no text: no first contentful paint, so the capture holds the load) for 700 ms,
 * then its text, a counter and a link to itself.
 */
const REPORT = `<!doctype html><html><head><meta charset="utf-8"><title>Report</title><style>${STYLE}</style></head><body><div id="bar"></div>
<script>let n = 0; setTimeout(() => { document.body.insertAdjacentHTML('afterbegin', '<h1 style="position:absolute;left:60px;top:200px;margin:0">Report ready</h1><button id="tally" style="left:60px">Tally 0</button><a id="again" href="/report.html" style="left:320px">Again</a>'); document.getElementById('tally').onclick = (e) => { e.target.textContent = 'Tally ' + (++n); }; }, 700);</script></body></html>`;

let server: TestServer;
let dir: string;

beforeAll(async () => {
  server = await startServer({ '/board.html': BOARD, '/report.html': REPORT });
  dir = await tempDir('rw-capture-pause-');
});

afterAll(async () => {
  await server?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe('the capture clock with pauses', () => {
  it('converts wall times before, inside and after pauses; stands still while paused; t0 never moves', async () => {
    const t0 = 1_000_000;
    const c = new CaptureClock(t0);
    expect(c.at(t0 + 1500)).toBe(1.5);
    expect(c.paused).toBe(false);
    expect(c.pause(t0 + 1000)).toBe(1);
    expect(c.paused).toBe(true);
    // Inside an open pause: the pause instant (a frame painted meanwhile lands there).
    expect(c.at(t0 + 1200)).toBe(1);
    expect(c.at(t0 + 999_999)).toBe(1);
    expect(() => c.pause(t0 + 1300)).toThrow(/paused already/);
    expect(c.resume(t0 + 3000)).toBe(2000);
    expect(c.paused).toBe(false);
    // B1: a wall time before the pause converts as it did before it.
    expect(c.at(t0 + 500)).toBe(0.5);
    expect(c.at(t0 + 1000)).toBe(1);
    // Inside the closed pause, and at its end: the pause instant.
    expect(c.at(t0 + 2000)).toBe(1);
    expect(c.at(t0 + 3000)).toBe(1);
    // After it: the pause left out.
    expect(c.at(t0 + 3500)).toBe(1.5);
    c.pause(t0 + 4000);
    c.resume(t0 + 4500);
    expect(c.at(t0 + 4200)).toBe(2);
    expect(c.at(t0 + 5000)).toBe(2.5);
    expect(c.at(t0 + 3999)).toBe(1.999);
    expect(c.pausedMs).toBe(2500);
    expect(c.t0Wall).toBe(t0);
    // Monotonic over any wall times.
    let prev = -Infinity;
    for (let w = t0 - 200; w < t0 + 6000; w += 37) {
      expect(c.at(w)).toBeGreaterThanOrEqual(prev);
      prev = c.at(w);
    }
    // A resume never goes before its pause; resuming a clock that is not paused is a bug.
    c.pause(t0 + 6000);
    expect(c.resume(t0 + 5000)).toBe(0);
    expect(() => c.resume(t0 + 7000)).toThrow(/not paused/);
    // A pause never begins inside the previous one.
    expect(c.pause(t0 + 5500)).toBe(c.at(t0 + 6000));
  });

  it('now() stands still while paused and goes on from the pause instant', async () => {
    const c = new CaptureClock(performance.timeOrigin + performance.now() - 1000);
    const at = c.pause();
    await sleep(120);
    expect(c.now()).toBe(at);
    c.resume();
    await sleep(50);
    expect(c.now() - at).toBeGreaterThanOrEqual(0.04);
    expect(c.now() - at).toBeLessThan(0.5);
  });

  it('the pause closes at the paint time of the first fresh frame after the recorders re-attach: a slow re-attach leaves no gap (B3)', async () => {
    const wall = () => performance.timeOrigin + performance.now();
    /** A recorder whose re-attach takes `attachMs`, then sends its first frame 5 ms later. */
    const fake = (attachMs: number) => {
      const r = {
        lastFrameAt: 0,
        firstWall: 0,
        pauses: 0,
        recordingPage: {},
        async pause() {
          r.pauses++;
        },
        async switchTo() {
          await sleep(attachMs);
          r.firstWall = wall() + 5;
          setTimeout(() => (r.lastFrameAt = r.firstWall), 5);
        },
        waitFrameAfter(after: number, timeoutMs: number): Promise<boolean> {
          const t0 = Date.now();
          return new Promise((resolve) => {
            const poll = () => (r.lastFrameAt > after ? resolve(true) : Date.now() - t0 > timeoutMs ? resolve(false) : setTimeout(poll, 2));
            poll();
          });
        },
      };
      return r;
    };
    const a = fake(200);
    const b = fake(350);
    const clock = new CaptureClock(wall() - 5000);
    const gate = { requested: true };
    const notes: TimelinePause[] = [];
    const record = { warnings: [] } as unknown as RunRecord;
    const pauser = new RunPauser({
      gate,
      signal: new AbortController().signal,
      record,
      emit: () => undefined,
      save: () => undefined,
      log: () => undefined,
      take: {
        clock,
        filming: () => [a, b].map((r) => ({ recorder: r as unknown as ScreencastRecorder, page: r.recordingPage as Page })),
        lastPress: () => null,
        settleEffects: async () => undefined,
        sampler: () => null,
        note: (p) => notes.push(p),
      },
    });
    setTimeout(() => (gate.requested = false), 300);
    await pauser.before('s', 1);
    expect([a.pauses, b.pauses]).toEqual([1, 1]);
    expect(clock.paused).toBe(false);
    const P = notes[0].t;
    // The earliest track's first frame lands at the pause instant; capture time runs on from its paint time.
    expect(clock.at(a.firstWall)).toBe(P);
    expect(clock.at(a.firstWall + 16)).toBeCloseTo(P + 0.016, 3);
    // Wall times carry fractional milliseconds and capture times are rounded to the millisecond: 2 decimals (10 ms)
    // still catch a resume gap (≥ 150 ms) without failing on rounding.
    expect(clock.at(b.firstWall)).toBeCloseTo(P + (b.firstWall - a.firstWall) / 1000, 2);
    expect(record.pauses).toEqual([expect.objectContaining({ scene: 's', step: 1 })]);
  });

  it('the CPU sampler leaves a pause out: its CPU, its seconds and the unfilmed time of a browser', async () => {
    // The sampler's wall clock is the test's (review B: real sleeps made the bounds machine-dependent).
    vi.useFakeTimers({ toFake: ['Date'], now: 1_000_000 });
    try {
      let cpuA = 0;
      let cpuB = 0;
      const s = new PerfSampler({
        chromium: async () => [
          { realm: 'a', type: 'renderer', pid: 1, cpu: cpuA },
          { realm: 'b', type: 'renderer', pid: 2, cpu: cpuB },
        ],
        filmed: () => new Set(['a']),
        intervalMs: 60_000,
      });
      s.start();
      await sleep(20);
      vi.setSystemTime(1_000_300);
      cpuA = 1;
      cpuB = 1;
      await s.pause();
      // What both browsers burn during the pause (the page keeps running) counts for nothing.
      cpuA = 11;
      cpuB = 11;
      vi.setSystemTime(1_000_800);
      await s.resume();
      vi.setSystemTime(1_001_100);
      cpuA = 12;
      cpuB = 12;
      const out = await s.stop();
      expect(out?.renderer).toBe(4);
      const b = out?.browsers?.find((x) => x.persona === 'b');
      expect(b?.cpu).toBe(2);
      expect(b?.unfilmed?.cpu).toBe(2);
      // 300 ms before the pause, 300 ms after it: the 500 ms pause left out.
      expect(b?.unfilmed?.seconds).toBeCloseTo(0.6, 2);
      // cores = total / seconds: the seconds of the take without the pause.
      expect(out!.total / out!.cores).toBeCloseTo(0.6, 2);
    } finally {
      vi.useRealTimers();
    }
  });
});

/** Every frame of a video as 160×90 grey pixels. */
function grayFrames(file: string): Buffer[] {
  const out = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-vf', 'scale=160:90:flags=area,format=gray', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 30 });
  const n = 160 * 90;
  return Array.from({ length: Math.floor(out.length / n) }, (_, i) => out.subarray(i * n, (i + 1) * n));
}

const meanDiff = (a: Buffer, b: Buffer) => {
  let d = 0;
  for (let i = 0; i < a.length; i++) d += Math.abs(a[i] - b[i]);
  return d / a.length;
};

/** Runs of identical consecutive output frames (≥ 2 frames): [first index, length]. */
function repeatedRuns(frames: Buffer[]): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let start = 0;
  for (let i = 1; i <= frames.length; i++) {
    if (i < frames.length && meanDiff(frames[i - 1], frames[i]) < 0.3) continue;
    if (i - start >= 2) out.push([start, i - start]);
    start = i;
  }
  return out;
}

/**
 * A frame index in capture order: the order the recorder received the frames, which its file numbers keep. The lines of
 * frames.jsonl come in the order the frame files finished writing (recorder.ts: asynchronous writes, a busy disk can
 * finish 000036 before 000035) — every reader sorts them, so must this one.
 */
async function frameIndex(file: string): Promise<FrameIndexEntry[]> {
  const seq = (f: FrameIndexEntry) => Number.parseInt(f.file, 10);
  return (await readFile(file, 'utf8'))
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as FrameIndexEntry)
    .sort((a, b) => seq(a) - seq(b));
}

const STEPS = [
  { click: { css: '#count' } },
  { click: { css: '#go' } },
  { wait_for: { text: 'Report ready' } },
  { click: { css: '#tally' } },
  { hold: 1 },
  { click: { css: '#again' } },
  { wait_for: { text: 'Report ready' } },
  { hold: 0.5 },
];

interface Take {
  rec: RunRecord;
  tl: Timeline;
  events: Array<{ e: RunProgress; wall: number }>;
}

async function take(name: string, opts: Partial<RunOptions> & { pauseBefore?: number; pauseMs?: number } = {}): Promise<Take> {
  const events: Take['events'] = [];
  const gate = { requested: false };
  const { pauseBefore, pauseMs, ...rest } = opts;
  const rec = await runScenario({
    project: makeProject(dir, { app: server.url }),
    mode: 'capture',
    runId: `${name}-${Date.now()}`,
    scenario: makeScenario(name, { pacing: { ...FAST, scene_start_still: 0.3 }, scenes: [{ id: 'board', open: '/board.html', steps: STEPS }] }),
    ...(pauseBefore !== undefined ? { pause: gate } : {}),
    onProgress: (e) => {
      events.push({ e, wall: Date.now() });
      if (pauseBefore !== undefined && e.type === 'step_end' && e.step === pauseBefore - 1) gate.requested = true;
      if (e.type === 'pause' && e.state === 'paused') setTimeout(() => (gate.requested = false), pauseMs ?? PAUSE_MS);
    },
    ...rest,
  });
  expect(rec.status, rec.error?.message).toBe('succeeded');
  return { rec, tl: await readTimeline(rec.timeline!), events };
}

/** The page loads held long enough to matter (the report's 700 ms without a paint). */
const heldLoads = (tl: Timeline): TimelineLoading[] => (tl.loading ?? []).filter((l) => l.until === 'paint' && l.t_end - l.t_start > 0.4);

describe('a capture paused between steps (real Chromium, an animated board)', () => {
  let plain: Take;
  let paused: Take;
  let frames: FrameIndexEntry[];
  let P: number;

  beforeAll(async () => {
    plain = await take('board-plain');
    paused = await take('board-paused', { pauseBefore: 4 });
    frames = await frameIndex(join(paused.rec.dir, 'frames.jsonl'));
    P = paused.tl.pauses?.[0]?.t ?? NaN;
    if (SHOTS) {
      await mkdir(SHOTS, { recursive: true });
      const sorted = [...frames].sort((a, b) => a.t - b.t);
      const i = sorted.findIndex((f) => f.t >= P);
      for (const f of sorted.slice(Math.max(0, i - 3), i + 4)) await copyFile(join(paused.rec.dir, 'frames', f.file), join(SHOTS, `t${f.t.toFixed(3)}-${f.file}`));
      for (const [k, t] of [['before', P - 0.1], ['at', P], ['after', P + 0.1]] as const) {
        execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', String(Math.max(0, t)), '-i', join(paused.rec.dir, 'capture.mp4'), '-frames:v', '1', join(SHOTS, `video-${k}.png`)]);
      }
    }
  }, 240_000);

  it('records the pause: run.json, the timeline (with its instant), the log and a run warning', () => {
    const { rec, tl, events } = paused;
    expect(rec.paused).toBeUndefined();
    expect(rec.pauses).toHaveLength(1);
    expect(rec.pauses![0]).toMatchObject({ scene: 'board', step: 4 });
    expect(rec.pauses![0].ms).toBeGreaterThanOrEqual(PAUSE_MS - 100);
    expect(tl.pauses).toHaveLength(1);
    expect(tl.pauses![0]).toMatchObject({ scene: 'board', step: 4 });
    // One length for the pause: run.json, the resumed event and the timeline (the time capture time stood still).
    expect(tl.pauses![0].ms).toBe(rec.pauses![0].ms);
    expect((events.find((x) => x.e.type === 'pause' && x.e.state === 'resumed')?.e as { ms?: number } | undefined)?.ms).toBe(rec.pauses![0].ms);
    expect(Math.abs(tl.pauses![0].ms - PAUSE_MS)).toBeLessThan(700);
    // Between step 3's end and step 4's start, inside the take.
    const ev = (step: number) => tl.events.find((e) => e.scene === 'board' && e.step === step)!;
    expect(P).toBeGreaterThanOrEqual(ev(3).t_end);
    expect(P).toBeLessThanOrEqual(ev(4).t_start);
    expect(events.filter((x) => x.e.type === 'pause').map((x) => (x.e as { state: string }).state)).toEqual(['paused', 'resumed']);
    expect(tl.warnings.some((w) => /^paused once \(2\.\d s, not filmed\): the video goes on where it paused/.test(w))).toBe(true);
    expect(rec.warnings.some((w) => w.startsWith('paused once'))).toBe(true);
  });

  it('the video does not show the pause: as long as the unpaused take and as the timeline; the pause left the wall time of the take only', async () => {
    const d = await ffprobeDuration(join(paused.rec.dir, 'capture.mp4'));
    const d0 = await ffprobeDuration(join(plain.rec.dir, 'capture.mp4'));
    expect(Math.abs(d - paused.tl.capture.duration), `video ${d} s, timeline ${paused.tl.capture.duration} s`).toBeLessThanOrEqual(1 / FPS + 0.01);
    // Two takes differ by the machine's load: a sanity bound only (the checks below hold the pause to the timeline).
    expect(Math.abs(d - d0), `paused ${d} s, unpaused ${d0} s`).toBeLessThan(1.2);
    // Wall time of the take (capture time 0 → the last step's end) − capture time = the pause (critique B16), to event
    // delivery's few ms: half of the 2.5 s pause filmed would be 1.25 s off.
    const lastEnd = paused.events.filter((x) => x.e.type === 'step_end').at(-1)!.wall;
    const wallTake = (lastEnd - paused.tl.capture.t0_wall) / 1000;
    const endT = paused.tl.events.at(-1)!.t_end;
    expect(Math.abs(wallTake - endT - paused.tl.pauses![0].ms / 1000), `wall ${wallTake} s, capture ${endT} s`).toBeLessThan(0.15);
    // In capture time, the span between the step before the pause and the step after it is the unpaused take's, plus the
    // click ripple the pause lets play out first (≤ 0.65 s) — never a part of the pause.
    const gap = (t: Take) => {
      const ev = (step: number) => t.tl.events.find((e) => e.scene === 'board' && e.step === step)!;
      return ev(4).t_start - ev(3).t_end;
    };
    expect(gap(paused) - gap(plain), `paused ${gap(paused)} s, unpaused ${gap(plain)} s`).toBeLessThan(0.8);
  });

  it('no frame inside the pause; the first fresh frame lands at the pause instant (no gap at the cut); frame times in order', () => {
    // In the order the recorder received them (file numbers, every one present): capture time never goes back — no
    // frame painted before the pause closed is stamped after a fresh one.
    expect(frames.map((f) => Number.parseInt(f.file, 10))).toEqual(frames.map((_, i) => i + 1));
    for (let i = 1; i < frames.length; i++) expect(frames[i].t, `${frames[i - 1].file} → ${frames[i].file}`).toBeGreaterThanOrEqual(frames[i - 1].t);
    const at = frames.filter((f) => f.t === P);
    expect(at.length, JSON.stringify(at)).toBeGreaterThanOrEqual(1);
    expect(at.length, JSON.stringify(at)).toBeLessThanOrEqual(2);
    const before = frames.filter((f) => f.t < P).at(-1)!;
    const after = frames.filter((f) => f.t > P)[0];
    // The board animates at 60 Hz: the last frame before the pause is one interval or so before it; after it, the next
    // frame comes one interval later as well.
    expect(P - before.t, `last frame before the pause at ${before.t}, pause at ${P}`).toBeLessThan(0.1);
    expect(after.t - P, `first frame after the pause instant at ${after.t}`).toBeLessThan(0.1);
  });

  it('capture.mp4 has no run of repeated frames for the pause (the board moves all the time; held loads aside)', () => {
    const v = grayFrames(join(paused.rec.dir, 'capture.mp4'));
    const loads = paused.tl.loading ?? [];
    const runs = repeatedRuns(v).filter(([i, n]) => {
      const a = i / FPS;
      const b = (i + n) / FPS;
      return a > 0.5 && !loads.some((l) => l.t_start - 0.1 < b && l.t_end + 0.1 > a);
    });
    const longest = Math.max(0, ...runs.map(([, n]) => n));
    expect(longest, JSON.stringify(runs)).toBeLessThan(10);
    const k = Math.round(P * FPS);
    const near = repeatedRuns(v.slice(k - 15, k + 15));
    expect(Math.max(0, ...near.map(([, n]) => n)), JSON.stringify(near)).toBeLessThan(4);
  });

  it('the click ripple played out before the pause, and the motion check reports no freeze there (B3)', () => {
    const presses = (paused.tl.cursor_effects ?? []).filter((e) => (e.type === 'press' || e.type === 'ripple') && e.t <= P);
    expect(presses.length).toBeGreaterThan(0);
    expect(P - Math.max(...presses.map((e) => e.t))).toBeGreaterThanOrEqual(0.55);
    expect((paused.tl.stalls ?? []).filter((s) => s.t_end > P - 0.7 && s.t_start < P + 0.7)).toEqual([]);
    expect(paused.tl.warnings.filter((w) => /froze|choppy/.test(w))).toEqual([]);
  });

  it('the page loads held before and after the pause are where the frames show them (B1)', () => {
    const loads = heldLoads(paused.tl);
    expect(loads, JSON.stringify(paused.tl.loading)).toHaveLength(2);
    const ev = (step: number) => paused.tl.events.find((e) => e.scene === 'board' && e.step === step)!;
    const [before, after] = loads;
    // Each begins with the click that navigated and ends before the next step.
    expect(before.t_start).toBeGreaterThanOrEqual(ev(1).t_start);
    expect(before.t_end).toBeLessThan(P);
    expect(after.t_start).toBeGreaterThanOrEqual(ev(5).t_start);
    for (const l of loads) {
      expect(frames.filter((f) => f.t >= l.t_start && f.t < l.t_end), JSON.stringify(l)).toEqual([]);
      // The previous frame stayed on screen until the first frame of the painted page.
      const first = frames.filter((f) => f.t >= l.t_end).sort((a, b) => a.t - b.t)[0];
      expect(first.t - l.t_end, JSON.stringify(l)).toBeLessThan(0.05);
    }
  });

  it('the perf report counts the take without the pause', () => {
    const perf = paused.rec.perf!;
    expect(perf.seconds).toBeCloseTo(paused.tl.capture.duration, 0);
    const cpu = perf.cpu;
    if (cpu && cpu.cores > 0) expect(Math.abs(cpu.total / cpu.cores - perf.seconds), JSON.stringify(cpu)).toBeLessThan(1.2);
    expect(perf.frames.fps).toBeGreaterThan(5);
  });
});

describe('other capture pauses', () => {
  it('a multi-page scene pauses both tracks: each video as long as the take, no frame inside the pause', async () => {
    const gate = { requested: false };
    const rec = await runScenario({
      project: makeProject(dir, { app: server.url }),
      mode: 'capture',
      runId: `pages-${Date.now()}`,
      scenario: makeScenario('pages', {
        pacing: { ...FAST, scene_start_still: 0.3, page_switch_ms: 200 },
        scenes: [
          {
            id: 'both',
            pages: { left: { page: 'app', open: '/board.html' }, right: { page: 'app', open: '/board.html', viewport: { width: 400, height: 600 } } },
            steps: [{ click: { css: '#count' } }, { hold: 0.5 }, { on: 'right', click: { css: '#count' } }, { hold: 0.5 }],
          },
        ],
      }),
      pause: gate,
      onProgress: (e) => {
        if (e.type === 'step_end' && e.step === 1) gate.requested = true;
        if (e.type === 'pause' && e.state === 'paused') setTimeout(() => (gate.requested = false), 1500);
      },
    });
    expect(rec.status, rec.error?.message).toBe('succeeded');
    const tl = await readTimeline(rec.timeline!);
    const p = tl.pauses?.[0];
    expect(p).toMatchObject({ scene: 'both', step: 2 });
    expect(p!.ms).toBeGreaterThanOrEqual(1400);
    for (const id of ['left', 'right']) {
      const track = tl.tracks!.find((t) => t.id === id)!;
      const d = await ffprobeDuration(join(rec.dir, track.file));
      expect(Math.abs(d - tl.capture.duration), `${id}: video ${d} s, timeline ${tl.capture.duration} s`).toBeLessThanOrEqual(1 / FPS + 0.01);
      const fr = await frameIndex(join(rec.dir, track.frames_file!));
      expect(fr.filter((f) => f.t === p!.t).length, id).toBeLessThanOrEqual(2);
      const after = fr.filter((f) => f.t >= p!.t).sort((a, b) => a.t - b.t)[0];
      expect(after.t - p!.t, id).toBeLessThan(0.1);
      const v = grayFrames(join(rec.dir, track.file));
      const k = Math.round(p!.t * FPS);
      expect(Math.max(0, ...repeatedRuns(v.slice(k - 15, k + 15)).map(([, n]) => n)), id).toBeLessThan(4);
    }
  }, 120_000);

  it('a capture paused longer than its maximum stops (cancelled, with the reason)', async () => {
    const t0 = Date.now();
    const rec = await runScenario({
      project: makeProject(dir, { app: server.url }),
      mode: 'capture',
      runId: `max-${Date.now()}`,
      scenario: makeScenario('max', { pacing: FAST, scenes: [{ id: 'board', open: '/board.html', steps: [{ hold: 0.2 }, { hold: 0.2 }] }] }),
      pause: { requested: true, maxMs: 400 },
    });
    expect(Date.now() - t0).toBeLessThan(30_000);
    expect(rec.status).toBe('cancelled');
    expect(rec.error?.message).toMatch(/^paused longer than 0\.4 s before step board\.0: the run was stopped/);
    expect(rec.paused).toBeUndefined();
    expect(rec.pauses![0].ms).toBeGreaterThanOrEqual(400);
  }, 60_000);
});
