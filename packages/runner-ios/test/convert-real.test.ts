/**
 * The conversion with a real ffmpeg (src/convert.ts, src/overlay.ts): a synthetic variable-rate recording (a frame
 * only when the screen changes, a long idle gap, nothing held at its end) and a tap become a constant-rate capture of
 * round(endT · fps) frames — each frame the recording's latest at or before its time, the last one held to the end, the
 * touch disc drawn at the tap's point from 150 ms before its touch-down and not before, BT.709 TV range tags; a
 * recording that runs ahead of the capture clock shifted onto it (the film and the touch-down's crops); a take with
 * the overlay not burnt (`--cursor none`) still writes its touches to the timeline.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PERSON_POLICY } from '@retake/core/policy';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { convertTake, probeMov, readCrops } from '../src/convert.js';
import { finishTake } from '../src/take.js';
import type { TouchRecord } from '../src/touch-track.js';
import { writeOverlay } from '../src/overlay.js';
import { DEFAULT_RIPPLE } from '../src/touch-look.js';
import type { Touch } from '../src/touch-track.js';

const dir = mkdtempSync(join(tmpdir(), 'retake-convert-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** 40 × 80 pt at 3: 120 × 240 px. */
const SCREEN = { width: 40, height: 80, scale: 3 };
const FPS = 30;
const END = 3.0;
/** The recording: [time, colour]: grey, red at 0.5, an idle gap, blue at 2.0, green at 2.03 — nothing after. */
const FRAMES: Array<[number, string]> = [
  [0, '0x808080'],
  [0.5, '0xd02020'],
  [2.0, '0x2020d0'],
  [2.03, '0x20a020'],
];
const TAP: Touch = { t_down: 1.0, t_up: 1.075, path: [{ t: 1.0, x: 20, y: 40 }], how: 'video' };
const mov = join(dir, 'capture.mov');
const out = join(dir, 'capture.mp4');

/** The pixel (RGB) at (x, y) px of output frame `n`. */
function pixel(n: number, x: number, y: number): number[] {
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', out, '-vf', `select=eq(n\\,${n}),format=rgb24,crop=1:1:${x}:${y}`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1']);
  return [...raw];
}

beforeAll(async () => {
  // A variable-rate mov: one frame per change (picked out of a 600 fps source), its own times, the sRGB transfer tag.
  const box = (c: string, from: number, to: number) => `drawbox=c=${c}:t=fill:enable='between(t,${from},${to})'`;
  const graph = [
    'color=c=0x808080:s=120x240:r=600:d=2.1',
    box('0xd02020', 0.5, 1.999),
    box('0x2020d0', 2.0, 2.0299),
    box('0x20a020', 2.03, 9),
    `select='${FRAMES.map(([t]) => `eq(n\\,${Math.round(t * 600)})`).join('+')}'`,
  ].join(',');
  execFileSync('ffmpeg', [
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    graph,
    '-fps_mode',
    'passthrough',
    '-video_track_timescale',
    '600',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-color_trc',
    'iec61966-2-1',
    mov,
  ]);
  const overlayDir = join(dir, 'touches');
  mkdirSync(overlayDir);
  const overlay = await writeOverlay({ touches: [TAP], frames: Math.round(END * FPS), fps: FPS, screen: SCREEN, ripple: DEFAULT_RIPPLE, dir: overlayDir });
  await convertTake(PERSON_POLICY, { mov, list: overlay.list, out, endT: END, fps: FPS, width: 120, height: 240, crf: 10 });
}, 60_000);

describe('the conversion of a variable-rate recording', () => {
  it('the recording probed: its size and its frame times from 0', async () => {
    const p = await probeMov(PERSON_POLICY, mov);
    expect([p.width, p.height]).toEqual([120, 240]);
    expect(p.frameTimes.map((t) => Math.round(t * 100) / 100)).toEqual([0, 0.5, 2, 2.03]);
  });

  it('round(endT · fps) frames at a constant rate, BT.709 TV range', () => {
    const info = JSON.parse(
      execFileSync(
        'ffprobe',
        [
          '-v',
          'error',
          '-count_frames',
          '-select_streams',
          'v:0',
          '-show_entries',
          'stream=nb_read_frames,r_frame_rate,color_range,color_space,color_transfer,color_primaries,width,height',
          '-of',
          'json',
          out,
        ],
        { encoding: 'utf8' },
      ),
    ).streams[0];
    expect(info).toMatchObject({ nb_read_frames: '90', r_frame_rate: '30/1', width: 120, height: 240, color_range: 'tv', color_space: 'bt709', color_transfer: 'bt709', color_primaries: 'bt709' });
  });

  it("each frame is the recording's latest at or before its time; the last one is held to the end", () => {
    const red = (p: number[]) => p[0] > 150 && p[1] < 80 && p[2] < 80;
    expect(pixel(14, 5, 5)[0]).toBeLessThan(150); // 0.467 s: still grey
    expect(red(pixel(15, 5, 5))).toBe(true); // 0.5 s
    expect(red(pixel(59, 5, 5))).toBe(true); // 1.967 s: the idle gap holds red
    const blue = pixel(60, 5, 5);
    expect(blue[2]).toBeGreaterThan(150); // 2.0 s
    const green = pixel(89, 5, 5);
    expect(green[1]).toBeGreaterThan(120); // 2.967 s: the last frame held
    expect(green[2]).toBeLessThan(80);
  });

  it('the touch disc at its point from 150 ms before the touch-down, not before; gone after', () => {
    const at = (n: number) => pixel(n, 60, 120);
    const [r, g] = at(20); // 0.667 s: red, no disc
    expect(r).toBeGreaterThan(150);
    expect(g).toBeLessThan(80);
    expect(at(25)[1]).toBeLessThan(80); // 0.833 s: before t_down − 150 ms
    // 1.0 s: the mid-grey disc (and the ripple) greys the red — less red, more green.
    expect(at(30)[0]).toBeLessThan(r - 60);
    expect(at(30)[1]).toBeGreaterThan(g + 20);
    expect(at(50)[1]).toBeLessThan(80); // 1.667 s: gone
    expect(pixel(30, 5, 5)[1]).toBeLessThan(80); // far from the touch: nothing
  });

  it('a recording ahead of the capture clock by 200 ms: each frame shows the recording 200 ms later', async () => {
    const shifted = join(dir, 'shifted.mp4');
    const overlayDir = join(dir, 'touches-shifted');
    mkdirSync(overlayDir);
    const overlay = await writeOverlay({ touches: [], frames: Math.round(END * FPS), fps: FPS, screen: SCREEN, ripple: DEFAULT_RIPPLE, dir: overlayDir });
    await convertTake(PERSON_POLICY, { mov, list: overlay.list, out: shifted, endT: END, fps: FPS, width: 120, height: 240, crf: 10, shift: 0.2 });
    const px = (n: number) => [
      ...execFileSync('ffmpeg', ['-v', 'error', '-i', shifted, '-vf', `select=eq(n\\,${n}),format=rgb24,crop=1:1:5:5`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1']),
    ];
    expect(px(0)[0]).toBeLessThan(150); // 0 s: video 0.2 s, grey
    expect(px(8)[0]).toBeLessThan(150); // 0.267 s: video 0.467 s, grey
    expect(px(9)[0]).toBeGreaterThan(150); // 0.3 s: video 0.5 s, red
    expect(px(54)[2]).toBeGreaterThan(150); // 1.8 s: video 2.0 s, blue
  });

  it("the touch-down's crops read the recording on the capture clock: a recording 500 ms ahead is read 500 ms later; a window from the first frame reads exactly its frames", async () => {
    const box = { x: 0, y: 0, w: 24, h: 24 };
    const probe = await probeMov(PERSON_POLICY, mov);
    // Capture time 0 is the recording's frame at 0.5 s (red) once it runs 500 ms ahead, not its first (grey).
    const crops = await readCrops(PERSON_POLICY, { mov, first: probe.first, shift: 0.5, times: [0], box, scale: 3 });
    expect(crops).toHaveLength(1);
    expect(crops![0].pixels[0]).toBeLessThan(110); // red in grey (about 85), not the grey (128)
    // A window from the recording's first frame to a frame: exactly its frames (the first, grey; the red at 0.5 s).
    const start = await readCrops(PERSON_POLICY, { mov, first: probe.first, times: [0, 0.5], box, scale: 3 });
    expect(start?.map((c) => c.pixels[0] > 115)).toEqual([true, false]);
  });

  it('the overlay not burnt (--cursor none): the touches still reach the timeline, no disc in the video', async () => {
    const plain = join(dir, 'plain.mp4');
    const copy = join(dir, 'plain.mov');
    execFileSync('cp', [mov, copy]);
    const cursor: unknown[] = [];
    const effects: unknown[] = [];
    const event = {} as { t_click?: number };
    const record: TouchRecord = { kind: 'tap', t_act: 0.9, t_end: 1.2, x: 20, y: 40, event: event as never };
    const done = await finishTake({
      policy: PERSON_POLICY,
      mov: copy,
      dir: join(dir, 'plain-ios'),
      out: plain,
      endT: END,
      fps: FPS,
      crf: 10,
      screen: SCREEN,
      touches: [record],
      burn: false,
      recording: { startedNs: null, stopNs: null },
      ripple: DEFAULT_RIPPLE,
      timeline: { sampleCursor: (c) => void cursor.push(c), cursorEffect: (e) => void effects.push(e) },
      log: () => undefined,
    });
    expect(done.touches).toHaveLength(1);
    expect(cursor.length).toBeGreaterThan(2);
    expect(effects).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'ripple' })]));
    expect(event.t_click).toBe(done.touches[0].t_down);
    const px = [
      ...execFileSync('ffmpeg', [
        '-v',
        'error',
        '-i',
        plain,
        '-vf',
        `select=eq(n\\,${Math.round(done.touches[0].t_down * FPS)}),format=rgb24,crop=1:1:60:120`,
        '-frames:v',
        '1',
        '-f',
        'rawvideo',
        '-pix_fmt',
        'rgb24',
        'pipe:1',
      ]),
    ];
    // The red as filmed (about 221, 48, 28), no disc over it (the disc gives about 160, 76, 66).
    expect(px[0]).toBeGreaterThan(200);
    expect(px[1]).toBeLessThan(60);
  });
});
