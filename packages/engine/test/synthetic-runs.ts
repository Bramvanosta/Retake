/**
 * Synthetic runs for the scenario view and the thumbnails (L4.2): run folders written by hand — run.json, the scenario
 * snapshot, timeline.json, dry-run screenshots, kept frames (solid-colour PNGs, one colour per step) and capture.mp4
 * encoded from those frames by the runner's own encoder (runner-web encodeFrames: the same CFR schedule as a capture).
 * Pixel colours are read back with ffmpeg (sharp is not a dependency of the engine).
 */
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { encodeFrames } from '@retake/runner-web';
import { PERSON_POLICY } from '@retake/core';

export type Rgb = [number, number, number];
export const RED: Rgb = [220, 30, 30];
export const GREEN: Rgb = [30, 200, 60];
export const BLUE: Rgb = [40, 60, 220];
export const CYAN: Rgb = [40, 200, 210];
export const YELLOW: Rgb = [230, 210, 40];
export const MAGENTA: Rgb = [200, 40, 200];
export const ORANGE: Rgb = [240, 130, 20];
export const GREY: Rgb = [128, 128, 128];

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
}

/** A solid-colour RGB PNG (or one declaring another size than its pixels: `declare`). */
export function png(w: number, h: number, rgb: Rgb, declare?: { w: number; h: number }): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(declare?.w ?? w, 0);
  ihdr.writeUInt32BE(declare?.h ?? h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.alloc(1 + w * 3);
  for (let x = 0; x < w; x++) row.set(rgb, 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** A valid 1-bit greyscale PNG of w × h black pixels (tiny on disk, huge once decoded: a decompression bomb). */
export function pngBits(w: number, h: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 1;
  ihdr[9] = 0;
  const raw = Buffer.alloc((1 + Math.ceil(w / 8)) * h);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** An RGB PNG of deterministic noise (a picture JPEG cannot shrink much). */
export function noisePng(w: number, h: number, seed: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc((1 + w * 3) * h);
  let x = seed * 2654435761;
  for (let i = 0; i < raw.length; i++) {
    if (i % (1 + w * 3) === 0) continue;
    x = (x * 1103515245 + 12345) >>> 0;
    raw[i] = x >>> 24;
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 1 })), chunk('IEND', Buffer.alloc(0))]);
}

/** The centre pixel of an encoded image (base64), decoded by ffmpeg. */
export function centre(base64: string, width: number, height: number): Rgb {
  const out = execFileSync('ffmpeg', ['-v', 'error', '-i', 'pipe:0', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { input: Buffer.from(base64, 'base64') });
  const i = (Math.floor(height / 2) * width + Math.floor(width / 2)) * 3;
  return [out[i], out[i + 1], out[i + 2]];
}

/** Whether two colours are within `tol` on every channel (JPEG and the video's YUV round trip move them a little). */
export function near(a: Rgb, b: Rgb, tol = 24): boolean {
  return a.every((v, i) => Math.abs(v - b[i]) <= tol);
}

/** The name of the colour closest to `c` (for readable failures). */
export function colourName(c: Rgb): string {
  const all: Record<string, Rgb> = { RED, GREEN, BLUE, CYAN, YELLOW, MAGENTA, ORANGE, GREY };
  let best = '?';
  let d = Infinity;
  for (const [n, v] of Object.entries(all)) {
    const x = v.reduce((s, k, i) => s + (k - c[i]) ** 2, 0);
    if (x < d) {
      d = x;
      best = n;
    }
  }
  return best;
}

export interface SynthEvent {
  scene: string;
  step: number;
  action: string;
  t_start: number;
  t_end: number;
  hold?: [number, number];
  status?: 'ok' | 'failed' | 'skipped' | 'dry';
  page?: string;
  target?: string;
  error?: string;
  url?: string;
}

export interface SynthTrack {
  id: string;
  frames: Array<[number, Rgb]>;
}

export interface SynthRun {
  id: string;
  scenario: string;
  mode: 'capture' | 'dry';
  status?: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  /** The scenario snapshot (absent: none written). */
  snapshot?: string;
  scenes?: Array<{ id: string; status?: string; t_start?: number; t_end?: number; pages?: Array<{ id: string; track: string }> }>;
  events?: SynthEvent[];
  /** No timeline.json at all. */
  noTimeline?: boolean;
  fps?: number;
  duration?: number;
  /** Main capture's kept frames: [t, colour]. */
  frames?: Array<[number, Rgb]>;
  tracks?: SynthTrack[];
  /** Encode capture.mp4 (and the tracks' videos) from the frames. */
  video?: boolean;
  /** Dry-run / error screenshots: name → colour. */
  screenshots?: Record<string, Rgb>;
  error?: { scene: string; step: number; message: string };
  stopped_at?: { scene: string; step: number; reason: 'irreversible' | 'until' };
  hooks?: { setup: string; teardown: string };
  steps_total?: number;
}

const W = 64;
const H = 36;

async function writeFrames(dir: string, folder: string, frames: Array<[number, Rgb]>): Promise<Array<{ file: string; t: number }>> {
  await mkdir(join(dir, folder), { recursive: true });
  const index = frames.map(([t], i) => ({ file: `${String(i + 1).padStart(6, '0')}.png`, t }));
  await Promise.all(frames.map(([, c], i) => writeFile(join(dir, folder, index[i].file), png(W, H, c))));
  return index;
}

/** Write a run folder runs/<id> of a project. */
export async function writeRun(projectDir: string, r: SynthRun): Promise<string> {
  const dir = join(projectDir, 'runs', r.id);
  await mkdir(join(dir, 'screenshots'), { recursive: true });
  const fps = r.fps ?? 10;
  const duration = r.duration ?? 5;
  const status = r.status ?? 'succeeded';
  const finished = status === 'succeeded' || status === 'failed' || status === 'cancelled';
  await writeFile(
    join(dir, 'run.json'),
    JSON.stringify({
      version: 1,
      id: r.id,
      project: 'northfield-fixture',
      scenario: r.scenario,
      mode: r.mode,
      status,
      started_at: '2026-10-20T10:00:00.000Z',
      ...(finished ? { finished_at: '2026-10-20T10:01:00.000Z' } : {}),
      dir,
      env: 'local',
      options: { hooks: r.mode === 'dry' ? 'skip' : 'run', headed: false },
      steps_total: r.steps_total ?? r.events?.length ?? 0,
      steps_done: r.events?.length ?? 0,
      screenshots: [],
      hooks: r.hooks ?? { setup: 'none', teardown: 'none' },
      warnings: [],
      // A failed or cancelled record always holds its error (the runner writes one; a record without is no run record).
      ...(r.error ? { error: r.error } : status === 'failed' || status === 'cancelled' ? { error: { message: status } } : {}),
      ...(r.stopped_at ? { stopped_at: r.stopped_at } : {}),
    }),
  );
  if (r.snapshot !== undefined) await writeFile(join(dir, 'scenario.yaml'), r.snapshot);
  for (const [name, c] of Object.entries(r.screenshots ?? {})) await writeFile(join(dir, 'screenshots', name), png(W, H, c));
  let mainFrames = 0;
  if (r.frames) {
    const index = await writeFrames(dir, 'frames', r.frames);
    mainFrames = index.length;
    await writeFile(join(dir, 'frames.jsonl'), index.map((e) => JSON.stringify(e)).join('\n') + '\n');
    if (r.video)
      await encodeFrames(join(dir, 'frames'), index, join(dir, 'capture.mp4'), { policy: PERSON_POLICY, fps, crf: 12, endT: duration, width: W, height: H, jpeg: false, preset: 'ultrafast' });
  }
  const tracks = [];
  for (const t of r.tracks ?? []) {
    const index = await writeFrames(dir, `frames-${t.id}`, t.frames);
    await writeFile(join(dir, `frames-${t.id}.jsonl`), index.map((e) => JSON.stringify(e)).join('\n') + '\n');
    if (r.video)
      await encodeFrames(join(dir, `frames-${t.id}`), index, join(dir, `capture-${t.id}.mp4`), {
        policy: PERSON_POLICY,
        fps,
        crf: 12,
        endT: duration,
        width: W,
        height: H,
        jpeg: false,
        preset: 'ultrafast',
      });
    tracks.push({
      id: t.id,
      file: `capture-${t.id}.mp4`,
      frames_file: `frames-${t.id}.jsonl`,
      width: W,
      height: H,
      scale: 1,
      fps,
      frames: index.length,
      recording: [{ t_start: 0, t_end: duration }],
      pages: [],
      cursor: [],
    });
  }
  if (!r.noTimeline) {
    await writeFile(
      join(dir, 'timeline.json'),
      JSON.stringify({
        version: 1,
        run_id: r.id,
        project: 'northfield-fixture',
        scenario: r.scenario,
        created_at: '2026-10-20T10:00:00.000Z',
        mode: r.mode,
        capture: { file: r.video ? 'capture.mp4' : '', width: W, height: H, scale: 1, fps, duration: r.mode === 'dry' ? 0 : duration, t0_wall: 0, frames: mainFrames },
        scenes: (r.scenes ?? []).map((s, index) => ({
          id: s.id,
          index,
          kind: 'scene',
          t_start: s.t_start ?? 0,
          t_end: s.t_end ?? 0,
          status: s.status ?? 'ok',
          ...(s.pages ? { pages: s.pages.map((p) => ({ id: p.id, viewport: { width: W, height: H }, track: p.track })) } : {}),
        })),
        events: [
          ...(r.scenes ?? []).map((s, i) => ({ scene: s.id, scene_index: i, step: -1, action: 'scene_still', t_start: 0, t_end: 0, status: 'ok' })),
          ...(r.events ?? []).map((e) => ({
            scene: e.scene,
            scene_index: 0,
            step: e.step,
            action: e.action,
            t_start: e.t_start,
            t_end: e.t_end,
            status: e.status ?? 'ok',
            ...(e.hold ? { hold: { t_start: e.hold[0], t_end: e.hold[1] } } : {}),
            ...(e.page ? { page: e.page } : {}),
            ...(e.target ? { target: { desc: e.target } } : {}),
            ...(e.error ? { error: e.error } : {}),
            ...(e.url ? { url: e.url } : {}),
          })),
        ],
        markers: [],
        pages: [],
        cursor: [],
        idle: [],
        warnings: [],
        ...(tracks.length ? { tracks } : {}),
      }),
    );
  }
  return dir;
}

/** A scenario of two scenes and five steps (one colour per step in `capture`). */
export const BLOCKS_YAML = `video: blocks
scenes:
  - id: one
    page: console
    open: /
    steps:
      - click: First
      - click: Second
      - hold: 1
  - id: two
    open: /catalog
    steps:
      - click: Third
      - click: Fourth
        hold: 0.8
`;

/** A capture of BLOCKS_YAML: 10 fps, 5 s; kept frames stamped so each step end shows one colour. */
export const capture = (id: string, extra: Partial<SynthRun> = {}): SynthRun => ({
  id,
  scenario: 'blocks',
  mode: 'capture',
  snapshot: BLOCKS_YAML,
  scenes: [
    { id: 'one', t_start: 0, t_end: 2 },
    { id: 'two', t_start: 2, t_end: 5 },
  ],
  events: [
    { scene: 'one', step: 0, action: 'click', t_start: 0.2, t_end: 0.95, target: 'button "First"' }, // mid-interval: frame 9 → red
    { scene: 'one', step: 1, action: 'click', t_start: 0.95, t_end: 1.0 }, // on a frame boundary: frame 10 → green
    { scene: 'one', step: 2, action: 'hold', t_start: 1.0, t_end: 1.2, hold: [1.2, 1.96] }, // cyan stamped 1.93 > tick 1.9: green
    { scene: 'two', step: 0, action: 'click', t_start: 2.0, t_end: 3.05 }, // frame 30 → yellow
    { scene: 'two', step: 1, action: 'click', t_start: 3.05, t_end: 4.2, hold: [4.2, 5.0] }, // the last step: frame 49 → magenta
  ],
  frames: [
    [0, RED],
    [1.0, GREEN],
    [1.93, CYAN],
    [2.0, BLUE],
    [3.0, YELLOW],
    [4.5, MAGENTA],
  ],
  video: true,
  ...extra,
});
