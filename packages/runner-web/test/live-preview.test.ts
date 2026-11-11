/**
 * L4.4: the live picture (live-preview.ts) — its own screencast of the page the run acts on, handed to a sink in memory:
 * only while someone watches, only while the run is on camera (capture time 0 to the start of `finally`: never during
 * the teardown), at most 10 frames a second with the newest frame of a burst always handed on (a page that changes once
 * and goes still shows its final state), following the page the run acts on. Review A L4: what watching cost is
 * counted (`watched()`), and a capture filmed while someone watched says so (run.json `perf.live_preview`, a warning).
 */
import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Scenario } from '@retake/core';
import { LivePreview, kitConfigFor, openSession, runScenario } from '../src/index.js';
import type { LiveFrame, LiveSink, RunOptions } from '../src/index.js';
import { FAST, makeProject, makeScenario, readTimeline, startServer, tempDir } from './helpers.js';
import type { TestServer } from './helpers.js';
import { PERSON_POLICY } from '@retake/core';

/** A page that paints a new colour on every animation frame. */
const ANIMATED = `<!doctype html><html><body style="margin:0"><div id="box" style="width:100vw;height:100vh"></div>
<script>let n = 0; const box = document.getElementById('box');
function tick() { n++; box.style.background = 'hsl(' + (n * 7) % 360 + ',70%,50%)'; requestAnimationFrame(tick); } tick();</script></body></html>`;
/** A still page whose colour the test sets. */
const STILL = `<!doctype html><html><body style="margin:0;background:#ff0000"><div style="width:100vw;height:100vh"></div></body></html>`;

let server: TestServer;
let dir: string;

beforeAll(async () => {
  server = await startServer({
    '/anim.html': ANIMATED,
    '/still.html': STILL,
    // A teardown hook that takes 800 ms: the animated page stays open (and painting) meanwhile.
    '/slow-reset': { body: '{"reset":true}', type: 'application/json', delay_ms: 800 },
  });
  dir = await tempDir('rw-live-');
});

afterAll(async () => {
  await server?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

/** A sink a test controls: `wanted` toggled by `want()`, frames kept. */
function testSink(initial = true): LiveSink & { frames: LiveFrame[]; want(w: boolean): void } {
  let wanted = initial;
  const fns = new Set<(w: boolean) => void>();
  const frames: LiveFrame[] = [];
  return {
    get wanted() {
      return wanted;
    },
    onWanted(fn) {
      fns.add(fn);
      return () => fns.delete(fn);
    },
    frame(f) {
      frames.push(f);
    },
    frames,
    want(w) {
      wanted = w;
      for (const fn of fns) fn(w);
    },
  };
}

/** The RGB of a JPEG's centre pixel (ffmpeg decodes it: no image library in the runner's tests). */
async function centre(jpeg: Buffer, w: number, h: number): Promise<[number, number, number]> {
  const rgb = await new Promise<Buffer>((resolve, reject) => {
    const child = spawn('ffmpeg', ['-v', 'error', '-f', 'mjpeg', '-i', '-', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`ffmpeg exited ${code}`))));
    child.stdin.end(jpeg);
  });
  const i = (Math.floor(h / 2) * w + Math.floor(w / 2)) * 3;
  return [rgb[i], rgb[i + 1], rgb[i + 2]];
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function run(name: string, scenario: Omit<Scenario, 'video'>, opts: Partial<RunOptions> = {}) {
  const project = makeProject(dir, { app: server.url });
  return runScenario({ policy: PERSON_POLICY, project, scenario: makeScenario(name, { pacing: FAST, ...scenario }), mode: 'dry', runId: `${name}-${Date.now()}`, ...opts });
}

describe('the live picture of a run', () => {
  it('only while the run is on camera: every frame between capture time 0 and the end of the scenes, none during the teardown; ≤ 10 a second', async () => {
    const sink = testSink();
    const t = Date.now();
    const rec = await run(
      'live-window',
      {
        teardown: [{ name: 'slow-reset', http: { method: 'POST', url: '{{app}}/slow-reset' } }],
        scenes: [{ id: 'anim', open: '/anim.html', steps: [{ hold: 1 }, { hold: 0.5 }] }],
      },
      { live: sink, hooks: 'run' },
    );
    expect(rec.status, rec.error?.message).toBe('succeeded');
    expect(rec.hooks.teardown).toBe('ok');
    expect(Date.now() - t).toBeGreaterThan(800); // the teardown's 800 ms happened, the page painting all along
    const tl = await readTimeline(rec.timeline!);
    const t0 = tl.capture.t0_wall;
    const end = t0 + tl.capture.duration * 1000;
    const frames = sink.frames;
    expect(frames.length).toBeGreaterThanOrEqual(8);
    for (const f of frames) {
      expect(f.at).toBeGreaterThanOrEqual(t0);
      expect(f.at).toBeLessThanOrEqual(end + 1);
      expect(f.data.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))).toBe(true);
      // ≤ the viewport (a frame right after a navigation can be cropped: the live view draws what it gets).
      expect(f.width).toBeLessThanOrEqual(800);
      expect(f.height).toBeLessThanOrEqual(600);
      expect(f.page).toBe('app');
    }
    // At most 10 frames a second: consecutive frames ≥ 100 ms apart (a few ms of timer slack).
    for (let i = 1; i < frames.length; i++) expect(frames[i].at - frames[i - 1].at).toBeGreaterThanOrEqual(95);
    // The page painted every frame for ≈ 2 s: the limiter, not the page, set the pace (≈ 10 a second).
    expect(frames.length / ((frames.at(-1)!.at - frames[0].at) / 1000)).toBeGreaterThan(6);
  });

  it('nobody watching: no screencast at all; frames once someone watches, none again after', async () => {
    const session = await openSession({ policy: PERSON_POLICY, width: 800, height: 600, scale: 1, kit: kitConfigFor(undefined) });
    try {
      const page = await session.page('a');
      await page.goto(`${server.url}/anim.html`);
      const sink = testSink(false);
      const preview = new LivePreview({ sink, page: () => page, width: 800, height: 600 });
      preview.start();
      await wait(700);
      expect(preview.received).toBe(0);
      expect(sink.frames).toHaveLength(0);
      expect(preview.watched()).toEqual({ seconds: 0, frames_sent: 0 });
      sink.want(true);
      await wait(800);
      expect(sink.frames.length).toBeGreaterThan(3);
      sink.want(false);
      await wait(200);
      const n = sink.frames.length;
      const received = preview.received;
      await wait(600);
      expect(sink.frames.length).toBe(n);
      expect(preview.received).toBe(received);
      // The cost of watching: the ≈ 0.8 s the screencast ran (not the time nobody watched), the frames handed on.
      const w = preview.watched();
      expect(w.frames_sent).toBe(n);
      expect(w.seconds).toBeGreaterThan(0.5);
      expect(w.seconds).toBeLessThan(1.4);
      sink.want(true);
      await wait(400);
      await preview.stop();
      const k = sink.frames.length;
      expect(k).toBeGreaterThan(n);
      await wait(400);
      expect(sink.frames.length).toBe(k);
      expect(preview.watched().seconds).toBeGreaterThan(w.seconds);
    } finally {
      await session.close();
    }
  });

  it('a capture watched says so: perf.live_preview (seconds, frames) and a warning; unwatched, neither', async () => {
    const take = (name: string, sink: LiveSink) =>
      run(name, { scenes: [{ id: 'anim', open: '/anim.html', steps: [{ hold: 1.2 }] }] }, { live: sink, mode: 'capture' });
    const watched = testSink();
    const a = await take('live-perf-watched', watched);
    expect(a.status, a.error?.message).toBe('succeeded');
    expect(a.perf?.live_preview?.frames_sent).toBe(watched.frames.length);
    expect(a.perf!.live_preview!.frames_sent).toBeGreaterThan(3);
    expect(a.perf!.live_preview!.seconds).toBeGreaterThan(0.5);
    expect(a.perf!.live_preview!.seconds).toBeLessThanOrEqual(a.perf!.seconds + 0.5);
    expect(a.warnings.filter((x) => /^the live picture was watched for \d+\.\d s of the take \(\d+ frames sent\)/.test(x))).toHaveLength(1);
    const b = await take('live-perf-unwatched', testSink(false));
    expect(b.status, b.error?.message).toBe('succeeded');
    expect(b.perf).toBeDefined();
    expect(b.perf!.live_preview).toBeUndefined();
    expect(b.warnings.filter((x) => /live picture/.test(x))).toEqual([]);
  });

  it('a page that changes in a burst and goes still: the last frame handed on shows its final state (trailing edge)', async () => {
    const session = await openSession({ policy: PERSON_POLICY, width: 800, height: 600, scale: 1, kit: kitConfigFor(undefined) });
    try {
      const page = await session.page('a');
      await page.goto(`${server.url}/still.html`);
      const sink = testSink();
      const preview = new LivePreview({ sink, page: () => page, width: 800, height: 600 });
      preview.start();
      await wait(600);
      for (let round = 0; round < 3; round++) {
        // Four colours 25 ms apart, the last one blue; then the page stays still.
        await page.evaluate(async () => {
          for (const c of ['#00ff00', '#ffff00', '#00ffff', '#0000ff']) {
            document.body.style.background = c;
            await new Promise((r) => setTimeout(r, 25));
          }
        });
        // The newest frame handed on is the final state: within half a second on the Mac; a loaded machine's
        // screencast delivers its last frame later, so it is waited for (never a later frame of another colour).
        const lastColour = async () => {
          const last = sink.frames.at(-1)!;
          return centre(last.data, last.width, last.height);
        };
        await wait(500);
        await expect.poll(async () => { const [r, g, b] = await lastColour(); return b > 200 && r + g < 80; }, { timeout: 5000, interval: 100 }).toBe(true);
        await page.evaluate(() => (document.body.style.background = '#ff0000'));
        await wait(400);
      }
      await preview.stop();
    } finally {
      await session.close();
    }
  });

  it('follows the page the run acts on (a switch to another page or tab)', async () => {
    const session = await openSession({ policy: PERSON_POLICY, width: 800, height: 600, scale: 1, kit: kitConfigFor(undefined) });
    try {
      const a = await session.page('a');
      await a.goto(`${server.url}/anim.html`);
      const b = await session.page('b');
      await b.goto(`${server.url}/anim.html`);
      let acting = a;
      const sink = testSink();
      const preview = new LivePreview({ sink, page: () => acting, pageId: (p) => session.idOf(p), width: 800, height: 600 });
      preview.start();
      await wait(600);
      acting = b;
      await wait(900);
      await preview.stop();
      const ids = sink.frames.map((f) => f.page);
      expect(ids[0]).toBe('a');
      expect(ids.at(-1)).toBe('b');
      // Once on b, never back to a.
      expect(ids.slice(ids.indexOf('b'))).not.toContain('a');
    } finally {
      await session.close();
    }
  });
});
