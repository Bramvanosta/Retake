/**
 * L5.7 on a real capture: by default (`capture.keep_frames: false`) capture.mp4 is encoded during the take and no frame
 * is written; run.json reports what the take cost (perf); a click whose content shows after a skeleton is a slow
 * transition and its wait is in timeline.busy; step pictures come from the video. With the frames kept, the video the
 * encoder wrote during the take is, frame for frame, the CFR schedule of the screencast frames (frame-accurate edit).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { RunRecord, Timeline } from '@retake/core';
import { cfrSchedule, runScenario } from '../src/index.js';
import type { FrameIndexEntry } from '../src/index.js';
import { FAST, execFileP, makeProject, makeScenario, readTimeline, startServer, tempDir } from './helpers.js';
import type { TestServer } from './helpers.js';
import { PERSON_POLICY } from '@retake/core';

/** A list that loads after a click: a skeleton (no motion) for 1.2 s, then the rows; a counter button for motion. */
const PAGE = `<!doctype html><html><head><style>
  body{margin:0;font:16px system-ui;background:#fafafa}
  main{padding:40px}
  button{font:16px system-ui;padding:10px 18px;margin-right:12px}
  .sk{height:28px;margin:14px 0;border-radius:8px;background:#e8e8e8;width:900px}
  .row{height:28px;margin:14px 0;font-size:20px;color:#222;background:#cfe3ff;width:900px}
  #big{position:absolute;left:0;top:300px;width:100%;height:500px}
</style></head><body><main>
  <button id="load">Load orders</button><button id="count">Count 0</button>
  <div id="list"></div>
</main><div id="big"></div>
<script>
  let n = 0;
  document.getElementById('count').onclick = (e) => { e.target.textContent = 'Count ' + (++n); document.getElementById('big').style.background = n % 2 ? '#202020' : '#f0f0f0'; };
  document.getElementById('load').onclick = () => {
    const list = document.getElementById('list');
    list.innerHTML = '<div class="sk"></div><div class="sk"></div><div class="sk"></div><div class="sk"></div>';
    setTimeout(() => { list.innerHTML = ['Order 1041','Order 1042','Order 1043','Order 1044'].map((t) => '<div class="row">' + t + '</div>').join(''); document.getElementById('big').style.background = '#dfe9ff'; }, 1200);
  };
</script></body></html>`;

let server: TestServer;
let dir: string;

beforeAll(async () => {
  server = await startServer({ '/orders.html': PAGE });
  dir = await tempDir('ds-capture-perf-');
});

afterAll(async () => {
  await server?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

function capture(runId: string, keepFrames: boolean): Promise<RunRecord> {
  return runScenario({ policy: PERSON_POLICY,
    project: makeProject(dir, { app: server.url }, { keepFrames }),
    mode: 'capture',
    runId,
    scenario: makeScenario('orders', {
      pacing: { ...FAST, scene_start_still: 0.4 },
      capture: { step_shots: true },
      scenes: [
        {
          id: 'orders',
          open: '/orders.html',
          steps: [{ click: 'Load orders' }, { wait_for: { text: 'Order 1044' } }, { click: 'Count 0' }, { click: 'Count 1' }, { click: 'Count 2', hold: 0.4 }],
        },
      ],
    }),
  });
}

/** Every frame of a video (or of an image sequence) as 160×90 grey pixels. */
async function grayFrames(args: string[]): Promise<Buffer[]> {
  const { stdout } = await execFileP('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args, '-vf', 'scale=160:90:flags=area,format=gray', '-f', 'rawvideo', '-'], {
    encoding: 'buffer',
    maxBuffer: 1 << 30,
  } as never);
  const buf = stdout as unknown as Buffer;
  const out: Buffer[] = [];
  for (let i = 0; i + 14400 <= buf.length; i += 14400) out.push(buf.subarray(i, i + 14400));
  return out;
}

function diff(a: Buffer, b: Buffer): number {
  let n = 0;
  for (let i = 0; i < a.length; i++) n += Math.abs(a[i] - b[i]);
  return n / a.length;
}

describe('capture performance and disk (L5.7)', () => {
  let rec: RunRecord;
  let tl: Timeline;

  it('by default: capture.mp4 encoded during the take, no frames/ — its frame count is the CFR length', async () => {
    rec = await capture('default', false);
    expect(rec.error?.message).toBeUndefined();
    expect(rec.status).toBe('succeeded');
    tl = await readTimeline(join(rec.dir, 'timeline.json'));
    expect(existsSync(join(rec.dir, 'frames'))).toBe(false);
    expect(existsSync(join(rec.dir, 'frames.jsonl'))).toBe(true);
    const { stdout } = await execFileP('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', join(rec.dir, 'capture.mp4')]);
    expect(Number(stdout.trim())).toBe(Math.round(tl.capture.duration * tl.capture.fps));
  });

  it('run.json perf: CPU per group, the GPU, frames, the encoder, the disk; the run result carries it', async () => {
    const p = rec.perf!;
    expect(p).toBeDefined();
    expect(p.cpu!.browser).toBeGreaterThan(0);
    expect(p.cpu!.retake).toBeGreaterThan(0);
    expect(p.cpu!.cores).toBeGreaterThan(0);
    expect(p.machine.cpus).toBeGreaterThan(0);
    expect(p.frames.received).toBe(tl.capture.frames);
    expect(p.frames.fps).toBeGreaterThan(0);
    expect(p.frame_rate_limit).toBe(true);
    expect(['h264_videotoolbox', 'libx264 veryfast']).toContain(p.encode!.codec);
    expect(p.disk).toMatchObject({ frames_kept: false });
    expect(p.disk!.run_mb).toBeGreaterThan(0);
    const onDisk = JSON.parse(await readFile(join(rec.dir, 'run.json'), 'utf8')) as RunRecord;
    expect(onDisk.perf?.seconds).toBe(p.seconds);
  });

  it('the click whose rows came after a skeleton is a slow transition, its wait is in timeline.busy', async () => {
    const load = tl.events.find((e) => e.step === 0)!;
    const p = rec.perf!;
    expect(p.transitions!.measured).toBe(4);
    const slow = p.transitions!.slow.find((x) => x.step === 0);
    expect(slow, JSON.stringify(p.transitions)).toBeDefined();
    expect(slow!.ms).toBeGreaterThan(1100);
    expect(slow!.ms).toBeLessThan(2500);
    expect(p.transitions!.slow.some((x) => x.step >= 2)).toBe(false);
    expect(tl.busy?.length, JSON.stringify(tl.busy)).toBe(1);
    const b = tl.busy![0];
    expect(b.click).toBeCloseTo(load.t_click!, 2);
    expect(b.t_start).toBeGreaterThan(load.t_click!);
    expect(b.t_end - b.t_start).toBeGreaterThan(0.8);
    expect(b.t_end).toBeLessThan(load.t_click! + 1.6);
  });

  it('step pictures come from the video when the frames are not kept: one JPEG per step, showing its end', async () => {
    const shots = (await readdir(join(rec.dir, 'screenshots'))).filter((f) => f.endsWith('.jpg')).sort();
    expect(shots).toEqual(['orders-00-click.jpg', 'orders-01-wait_for.jpg', 'orders-02-click.jpg', 'orders-03-click.jpg', 'orders-04-click.jpg']);
    expect(rec.screenshots).toHaveLength(5);
    // Each picture is the video frame at its step's end (and not the one before the step).
    const video = await grayFrames(['-i', join(rec.dir, 'capture.mp4')]);
    for (const [i, f] of shots.entries()) {
      const [pic] = await grayFrames(['-i', join(rec.dir, 'screenshots', f)]);
      const ev = tl.events.find((e) => e.step === i)!;
      const n = Math.floor(ev.t_end * tl.capture.fps);
      // The video decodes in limited range, the JPEG in full: a few grey levels apart when they are the same picture.
      const d = [n - 2, n - 1, n, n + 1, n + 2].map((k) => (video[k] ? diff(pic, video[k]) : Infinity));
      expect(d[2], `${f}: ${d.map((x) => x.toFixed(2)).join(' ')}`).toBeLessThan(10);
      expect(d[2], `${f}: ${d.map((x) => x.toFixed(2)).join(' ')}`).toBeLessThanOrEqual(Math.min(...d) + 0.5);
    }
  });

  it('frame-accurate: with the frames kept, every video frame is the CFR schedule of the screencast frames', async () => {
    const kept = await capture('kept', true);
    expect(kept.status).toBe('succeeded');
    const ktl = await readTimeline(join(kept.dir, 'timeline.json'));
    const index = (await readFile(join(kept.dir, 'frames.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as FrameIndexEntry);
    const schedule = cfrSchedule(index, ktl.capture.duration, ktl.capture.fps);
    const video = await grayFrames(['-i', join(kept.dir, 'capture.mp4')]);
    expect(video.length).toBe(schedule.length);
    const files = [...new Set(schedule)];
    const pics = new Map<string, Buffer>();
    for (const f of files) pics.set(f, (await grayFrames(['-i', join(kept.dir, 'frames', f)]))[0]);
    let compared = 0;
    for (let n = 1; n + 1 < schedule.length; n++) {
      const own = pics.get(schedule[n])!;
      for (const other of [schedule[n - 1], schedule[n + 1]]) {
        if (other === schedule[n]) continue;
        const o = pics.get(other)!;
        // Neighbours that look different (a panel changing colour): the video frame is its own. (The video decodes in
        // limited range, the JPEG frames in full: the same picture is a few grey levels apart.)
        if (diff(own, o) < 8) continue;
        expect(diff(video[n], own), `frame ${n}: ${schedule[n]} vs ${other}`).toBeLessThan(diff(video[n], o));
        compared++;
      }
    }
    expect(compared).toBeGreaterThanOrEqual(4);
    expect(kept.perf?.disk?.frames_kept).toBe(true);
    expect(existsSync(join(kept.dir, 'frames'))).toBe(true);
  });
});
