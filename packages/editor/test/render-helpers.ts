/**
 * Fixtures of the render tests: a temp workspace (repo templates, built-in library) with one project whose run is a
 * synthetic timeline over a generated capture whose frames are colour-coded (frame n has a solid colour that encodes
 * n), so a rendered frame tells which source frame it shows.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadProject } from '@demo-studio/core';
import type { LoadedProject, Timeline } from '@demo-studio/core';
import { synthTimeline } from './helpers.js';

export const REPO = fileURLToPath(new URL('../../../', import.meta.url));
export const TEMPLATES = join(REPO, 'templates');
/** Bundles shared by the render tests and real renders of the repo (git-ignored). */
export const SHARED_CACHE = join(REPO, '.demo-studio', 'cache');

export const RUN_ID = '20260101-120000-synthetic';
export const CAPTURE_SECONDS = 4;
export const CAPTURE_FPS = 30;

export function hasTool(name: string): boolean {
  return spawnSync(name, ['-version'], { stdio: 'ignore' }).status === 0;
}

/** Colour of capture frame n: three base-6 digits on 6 levels (16 + 40 k). */
export function frameColour(n: number): [number, number, number] {
  return [16 + 40 * (n % 6), 16 + 40 * (Math.floor(n / 6) % 6), 16 + 40 * Math.floor(n / 36)];
}

/** The capture frame a colour encodes (nearest levels). */
export function frameOfColour([r, g, b]: [number, number, number]): number {
  const level = (v: number) => Math.max(0, Math.min(5, Math.round((v - 16) / 40)));
  return level(r) + 6 * level(g) + 36 * level(b);
}

/** A 320×180 CFR capture of `seconds` whose frame n is a solid frameColour(n). */
export function makeColourCapture(file: string, seconds = CAPTURE_SECONDS, fps = CAPTURE_FPS): void {
  execFileSync('ffmpeg', [
    '-v', 'error', '-y',
    '-f', 'lavfi', '-i', `color=c=black:s=320x180:r=${fps}:d=${seconds}`,
    '-vf', "geq=r='16+40*mod(N\\,6)':g='16+40*mod(floor(N/6)\\,6)':b='16+40*floor(N/36)'",
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '30', '-crf', '12',
    file,
  ]);
}

/** RGB of pixel (x, y) of frame `frame` of a video (or of a PNG with frame 0). */
export function pixelAt(file: string, frame: number, x: number, y: number): [number, number, number] {
  const out = execFileSync('ffmpeg', [
    '-v', 'error', '-i', file,
    '-vf', `select=eq(n\\,${frame}),format=rgb24,crop=1:1:${Math.round(x)}:${Math.round(y)}`,
    '-fps_mode', 'passthrough', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
  ]);
  return [out[0], out[1], out[2]];
}

/** The synthetic timeline: scene "a" (1.0–2.0 s, captioned), scene "b" opening a page (3.0–4.0 s, load until 3.1). */
export function syntheticTimeline(): Timeline {
  const t = synthTimeline({
    duration: CAPTURE_SECONDS,
    fps: CAPTURE_FPS,
    entries: [
      { id: 'a', t_start: 1.0, t_end: 2.0, caption: { kicker: 'Colours', text: 'Every frame has its own colour.' } },
      { id: 'b', t_start: 3.0, t_end: 4.0, open_end: 3.1, url: 'http://app.test/b' },
    ],
    video: { title: { text: 'Synthetic' }, intro: false, outro: false, frame: 'card', template: 'editorial' },
  });
  t.run_id = RUN_ID;
  t.project = 'demo';
  t.scenario = 'synthetic';
  return t;
}

export interface RenderWorkspace {
  root: string;
  project: LoadedProject;
  runDir: string;
  cleanup: () => Promise<void>;
}

/** A temp workspace with project "demo" and the synthetic run (timeline + colour-coded capture). */
export async function renderWorkspace(): Promise<RenderWorkspace> {
  const root = await mkdtemp(join(tmpdir(), 'demo-studio-render-'));
  await writeFile(join(root, 'studio.yaml'), `projects_dir: projects\ntemplates_dir: ${JSON.stringify(TEMPLATES)}\n`);
  const dir = join(root, 'projects', 'demo');
  const runDir = join(dir, 'runs', RUN_ID);
  await mkdir(runDir, { recursive: true });
  await writeFile(join(dir, 'project.yaml'), 'name: Demo\nenvironments:\n  local: {app: "http://app.test"}\ntemplate: editorial\n');
  await writeFile(join(runDir, 'timeline.json'), JSON.stringify(syntheticTimeline(), null, 2));
  makeColourCapture(join(runDir, 'capture.mp4'));
  const project = await loadProject('demo', root);
  return { root, project, runDir, cleanup: () => rm(root, { recursive: true, force: true }) };
}
