/**
 * L4.5 part C test helpers: a scratch workspace with a synthetic take whose capture shows its own frame number — ten
 * white-or-black blocks across the middle of every frame, block k white when bit k of the source frame index is set,
 * and a reference block above them always white (a blank or unloaded preview reads as nothing, never as frame 0) —
 * so a screenshot of the preview tells which source frame it shows (robust to scaling and lossy coding). Encoders:
 * VP9 (Playwright's Chromium plays it), and the capture's own H.264 encoders — VideoToolbox (keyframes every 12
 * frames, no B-frames) and the libx264 fallback (250-frame GOP, B-frames).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { cp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Timeline } from '@retake/core';
import { synthTimeline } from '../../editor/test/helpers.js';
import { REPO } from '../../editor/test/render-helpers.js';

export const BITS = 10;
/** The blocks' band, as fractions of the frame: block k spans x ∈ [X0 + k·STEP, X0 + k·STEP + W), y ∈ [Y0, Y1). */
const X0 = 0.05;
const STEP = 0.09;
const W = 0.08;
const Y0 = 0.3;
const Y1 = 0.6;
/** The reference block: above block REF, always white. */
const REF = 4;
const REF_Y0 = 0.12;
const REF_Y1 = 0.24;

export type TakeCodec = 'vp9' | 'h264-videotoolbox' | 'h264-x264';

/** Whether this ffmpeg has the encoder (VideoToolbox: macOS only). */
export function hasEncoder(name: string): boolean {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=256x144:r=30', '-frames:v', '2', '-c:v', name, '-f', 'null', '-'], { stdio: 'ignore' });
  return r.status === 0;
}

/** A capture of `seconds` at 30 fps whose every frame shows its index in binary (see the module comment). */
export function bitsVideo(file: string, seconds: number, codec: TakeCodec, size = '640x360'): void {
  const boxes = [
    `drawbox=x=iw*${(X0 + REF * STEP).toFixed(3)}:y=ih*${REF_Y0}:w=iw*${W}:h=ih*${(REF_Y1 - REF_Y0).toFixed(2)}:color=white:t=fill`,
    ...Array.from({ length: BITS }, (_x, k) => `drawbox=x=iw*${(X0 + k * STEP).toFixed(3)}:y=ih*${Y0}:w=iw*${W}:h=ih*${(Y1 - Y0).toFixed(2)}:color=white:t=fill:enable='eq(mod(floor(n/${2 ** k})\\,2)\\,1)'`),
  ].join(',');
  const enc =
    codec === 'vp9'
      ? ['-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '800k']
      : codec === 'h264-videotoolbox'
        ? ['-c:v', 'h264_videotoolbox', '-q:v', '65', '-profile:v', 'high']
        : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18'];
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=0x202020:s=${size}:r=30`, '-t', String(seconds), '-vf', boxes, ...enc, '-pix_fmt', 'yuv420p', '-movflags', '+faststart', file]);
}

/** The source frame index a PNG screenshot of the preview shows (the blocks' centres, thresholded), or -1 (unreadable). */
export function readBits(png: Buffer): number {
  const probe = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', '-i', 'pipe:0'], { input: png }).toString().trim();
  const [w, h] = probe.split(',').map(Number);
  const rgb = execFileSync('ffmpeg', ['-v', 'error', '-i', 'pipe:0', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { input: png, maxBuffer: 64 * 1024 * 1024 });
  const level = (fx: number, fy: number) => {
    const x = Math.floor(w * fx);
    const y = Math.floor(h * fy);
    let sum = 0;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const i = ((y + dy) * w + (x + dx)) * 3;
      sum += (rgb[i] + rgb[i + 1] + rgb[i + 2]) / 3;
    }
    return sum / 25;
  };
  if (level(X0 + REF * STEP + W / 2, (REF_Y0 + REF_Y1) / 2) < 150) return -1;
  let n = 0;
  for (let k = 0; k < BITS; k++) {
    const v = level(X0 + k * STEP + W / 2, (Y0 + Y1) / 2);
    if (v > 90 && v < 150) return -1;
    if (v >= 150) n |= 1 << k;
  }
  return n;
}

export interface Take {
  run: string;
  dir: string;
}

/** A workspace with the editorial template copied and a project `demo` (environment local), its music bed. */
export async function takeWorkspace(ws: string, project = 'demo'): Promise<string> {
  await mkdir(join(ws, 'templates'), { recursive: true });
  await cp(join(REPO, 'templates', 'editorial'), join(ws, 'templates', 'editorial'), { recursive: true });
  await writeFile(join(ws, 'retake.yaml'), 'version: 1\nprojects_dir: projects\ntemplates_dir: templates\n');
  const dir = join(ws, 'projects', project);
  await mkdir(join(dir, 'scenarios'), { recursive: true });
  await mkdir(join(dir, 'assets'), { recursive: true });
  await writeFile(join(dir, 'project.yaml'), 'version: 1\nname: Demo\nenvironments:\n  local: {app: "http://app.test"}\ntemplate: editorial\n');
  return dir;
}

/** A finished capture of scenario `name`: its timeline, its scenario snapshot (= today's file), run.json, the capture. */
export async function writeTake(projectDir: string, name: string, o: { run: string; text: string; timeline: Timeline; codec: TakeCodec; seconds: number; project?: string }): Promise<Take> {
  const runDir = join(projectDir, 'runs', o.run);
  await mkdir(runDir, { recursive: true });
  const project = o.project ?? 'demo';
  Object.assign(o.timeline, { run_id: o.run, project, scenario: name });
  await writeFile(join(runDir, 'timeline.json'), JSON.stringify(o.timeline));
  await writeFile(join(runDir, 'scenario.yaml'), o.text);
  await writeFile(
    join(runDir, 'run.json'),
    JSON.stringify({ version: 1, id: o.run, project, scenario: name, mode: 'capture', status: 'succeeded', started_at: '2026-01-01T12:00:00.000Z', finished_at: '2026-01-01T12:01:00.000Z', dir: runDir, env: 'local', options: { hooks: 'run', headed: false }, steps_total: 3, steps_done: 3, screenshots: [], hooks: { setup: 'ok', teardown: 'ok' }, warnings: [] }),
  );
  bitsVideo(join(runDir, 'capture.mp4'), o.seconds, o.codec);
  await writeFile(join(projectDir, 'scenarios', `${name}.yaml`), o.text);
  return { run: o.run, dir: runDir };
}

/** A comment thread file on a render of the take (core CommentThreadSchema), anchored at a step. */
export async function writeThread(projectDir: string, o: { id: string; scenario: string; run: string; frames: number; text: string; anchor: { segment: string; kind: 'clip' | 'card'; scene?: string; step?: number } }): Promise<void> {
  const dir = join(projectDir, 'comments', o.scenario);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, `${o.id}.json`),
    JSON.stringify({
      version: 1,
      id: o.id,
      scenario: o.scenario,
      render: { id: `${o.scenario}-v1`, created_at: '2026-01-01T13:00:00.000Z', run_id: o.run, variant: 'landscape', fps: 30, frames: o.frames, width: 1920, height: 1080 },
      frame: 10,
      time_s: 10 / 30,
      text: o.text,
      author: { via: 'cli', name: 'Reviewer' },
      created_at: '2026-01-01T13:05:00.000Z',
      anchor: o.anchor,
      entries: [],
    }),
  );
}

export const BITS_TEXT = `video: Bits
title: {text: Bits}
intro: false
outro: false
frame: raw
scenes:
  - id: a
    page: app
    open: /
    caption: Every frame carries its number.
    steps:
      - hold: 1
        mark: first
      - hold: 0.9
        camera: {zoom: 1.4, target: cursor, until: step_end}
  - card: {slots: {title: Chapter two}}
    id: c1
  - id: b
    speed: 2
    steps:
      - click: Next
      - click: Done
`;

/** The synthetic take of BITS_TEXT: scene a (a zoom on its second step), a card, scene b at 2× with an idle gap cut. */
export function bitsTimeline() {
  return synthTimeline({
    duration: 8,
    idle: [[3.8, 6.6]],
    cursor: [[0, 960, 540]],
    entries: [
      {
        id: 'a',
        t_start: 0.2,
        t_end: 2.9,
        caption: { text: 'Every frame carries its number.' },
        steps: [
          { action: 'hold', t_start: 0.4, t_end: 1.4, mark: 'first' },
          { action: 'hold', t_start: 2.0, t_end: 2.9, camera: { zoom: 1.4, target: 'cursor', until: 'step_end', point: { x: 960, y: 540 } } },
        ],
      },
      { card: { id: 'c1', slots: { title: 'Chapter two' } } },
      {
        id: 'b',
        t_start: 3.2,
        t_end: 7.9,
        speed: 2,
        steps: [
          { action: 'click', t_start: 3.4, t_end: 3.6, target: { desc: 'button "Next"' } },
          { action: 'click', t_start: 6.8, t_end: 7.0, target: { desc: 'button "Done"' } },
        ],
      },
    ],
    video: { title: { text: 'Bits' }, intro: false, outro: false, frame: 'raw', template: 'editorial' },
  });
}
