/**
 * Synthetic renders for the review tests: a temp workspace (repo templates, built-in component library) with project
 * "demo"; each case is a synthetic run (timeline + a static test-pattern capture) planned with the real planner at
 * quarter size, and a "render" drawn with ffmpeg from the plan — background, the capture rect filled with a pattern
 * during clips, a dark bar in the caption area while a cue is on, a box on intro/outro/cards — plus its
 * RenderRecord in renders/. Defects are drawn on purpose (blank screen) or written into the plan (overlapping cues).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadProject, loadTemplate } from '@demo-studio/core';
import type { LoadedProject, LoadedTemplate, Timeline } from '@demo-studio/core';
import { loadComponentRegistry } from '@demo-studio/components';
import type { ComponentRegistry } from '@demo-studio/components';
import { planEdit } from '@demo-studio/editor';
import type { EditOverrides, EditPlan, RenderRecord } from '@demo-studio/editor';
import { segmentSpans } from '../src/spans.js';
import { synthTimeline } from '../../editor/test/helpers.js';
import type { SceneSpec } from '../../editor/test/helpers.js';

export { synthTimeline };
export const REPO = fileURLToPath(new URL('../../../', import.meta.url));

export function hasTool(name: string): boolean {
  return spawnSync(name, ['-version'], { stdio: 'ignore' }).status === 0;
}

export interface Workspace {
  root: string;
  project: LoadedProject;
  registry: ComponentRegistry;
  editorial: LoadedTemplate;
  cleanup: () => Promise<void>;
}

export async function workspace(): Promise<Workspace> {
  const root = await mkdtemp(join(tmpdir(), 'demo-studio-review-'));
  await writeFile(join(root, 'studio.yaml'), `projects_dir: projects\ntemplates_dir: ${JSON.stringify(join(REPO, 'templates'))}\n`);
  const dir = join(root, 'projects', 'demo');
  await mkdir(join(dir, 'renders'), { recursive: true });
  await writeFile(join(dir, 'project.yaml'), 'name: Demo\nenvironments:\n  local: {app: "http://app.test"}\ntemplate: editorial\n');
  const project = await loadProject('demo', root);
  const registry = await loadComponentRegistry({ root });
  const editorial = await loadTemplate('editorial', REPO);
  return { root, project, registry, editorial, cleanup: () => rm(root, { recursive: true, force: true }) };
}

export interface DrawOptions {
  /** Output frames [from, to) whose screen rect is drawn white (a blank screen), or a function of the plan. */
  blank?: Array<[number, number]> | ((plan: EditPlan) => Array<[number, number]>);
  /** Capture seconds [from, to) drawn white in the capture too. */
  blankCapture?: Array<[number, number]>;
  /** Pattern of the screen: SMPTE bars (default) or the RGB test pattern (a visible change for diffs). */
  pattern?: 'bars' | 'rgb';
  /** Clips (segment ids) drawn with the other pattern. */
  otherPattern?: string[];
  /** Leave the boxes of non-clip segments out (empty cards). */
  emptyCards?: boolean;
}

const between = (ranges: Array<[number, number]>, fps: number) =>
  ranges.length ? ranges.map(([a, b]) => `between(t\\,${(a / fps).toFixed(4)}\\,${((b - 0.5) / fps).toFixed(4)})`).join('+') : '0';

/** A static test-pattern capture of `seconds` (white where `blank`). */
export function drawCapture(file: string, seconds: number, blank: Array<[number, number]> = []): void {
  const filters = blank.map(([a, b]) => `drawbox=x=0:y=0:w=iw:h=ih:color=white:t=fill:enable='between(t\\,${a}\\,${b})'`);
  execFileSync('ffmpeg', [
    '-v', 'error', '-y',
    '-f', 'lavfi', '-i', `smptehdbars=s=320x180:r=30:d=${seconds}`,
    ...(filters.length ? ['-vf', filters.join(',')] : []),
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '30', '-crf', '18',
    file,
  ]);
}

/** Draw a video for `plan` (see the file comment). */
export function drawRender(plan: EditPlan, file: string, opts: DrawOptions = {}): void {
  const fps = plan.fps;
  const D = plan.durationInFrames;
  const spans = segmentSpans(plan);
  const L = plan.layout;
  const cx = Math.round(L.capture.x);
  const cy = Math.round(L.capture.y);
  const cw = Math.round(L.capture.w / 2) * 2;
  const ch = Math.round(L.capture.h / 2) * 2;
  const clipsA = spans.filter((s) => s.segment.kind === 'clip' && !(opts.otherPattern ?? []).includes(s.segment.id)).map((s) => [s.from, s.to] as [number, number]);
  const clipsB = spans.filter((s) => s.segment.kind === 'clip' && (opts.otherPattern ?? []).includes(s.segment.id)).map((s) => [s.from, s.to] as [number, number]);
  const cards = spans.filter((s) => s.segment.kind !== 'clip').map((s) => [s.from, s.to] as [number, number]);
  const cues = plan.captions.map((c) => [c.from, c.to] as [number, number]);
  const cap = L.caption ?? { x: cx, y: cy + ch + 4, w: cw, h: 20 };
  const [a, b] = opts.pattern === 'rgb' ? ['rgbtestsrc', 'smptehdbars'] : ['smptehdbars', 'rgbtestsrc'];
  const dur = (D / fps).toFixed(4);
  const graph = [
    `[0:v][1:v]overlay=x=${cx}:y=${cy}:enable='${between(clipsA, fps)}'[v1]`,
    `[v1][2:v]overlay=x=${cx}:y=${cy}:enable='${between(clipsB, fps)}'[v2]`,
    `[v2]drawbox=x=${cx}:y=${cy}:w=${cw}:h=${ch}:color=white:t=fill:enable='${between(typeof opts.blank === 'function' ? opts.blank(plan) : (opts.blank ?? []), fps)}'[v3]`,
    `[v3]drawbox=x=${Math.round(cap.x + 2)}:y=${Math.round(cap.y + cap.h * 0.45)}:w=${Math.round(cap.w * 0.5)}:h=${Math.max(3, Math.round(cap.h * 0.15))}:color=0x1f1413:t=fill:enable='${between(cues, fps)}'[v4]`,
    `[v4]drawbox=x=${Math.round(plan.width * 0.35)}:y=${Math.round(plan.height * 0.4)}:w=${Math.round(plan.width * 0.3)}:h=${Math.round(plan.height * 0.12)}:color=0x8a2332:t=fill:enable='${opts.emptyCards ? '0' : between(cards, fps)}'[v5]`,
  ].join(';');
  execFileSync('ffmpeg', [
    '-v', 'error', '-y',
    '-f', 'lavfi', '-i', `color=c=0xece6df:s=${plan.width}x${plan.height}:r=${fps}:d=${dur}`,
    '-f', 'lavfi', '-i', `${a}=s=${cw}x${ch}:r=${fps}:d=${dur}`,
    '-f', 'lavfi', '-i', `${b}=s=${cw}x${ch}:r=${fps}:d=${dur}`,
    '-filter_complex', graph, '-map', '[v5]',
    '-frames:v', String(D),
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '30', '-crf', '18',
    file,
  ]);
}

let clock = Date.parse('2026-01-01T12:00:00.000Z');

export interface CaseOptions {
  /** Version of the render (default 1). */
  version?: number;
  overrides?: EditOverrides;
  /** Change the plan after planning (a bad plan). */
  mutate?: (plan: EditPlan) => void;
  draw?: DrawOptions;
  /** Reuse the run of an earlier case (same scenario). */
  run?: { id: string; dir: string; timeline: Timeline };
}

export interface Case {
  record: RenderRecord;
  plan: EditPlan;
  timeline: Timeline;
  run: { id: string; dir: string; timeline: Timeline };
}

/** Plan `timeline` as scenario `name`, draw its render and write renders/<name>-v<N>.{mp4,json}. */
export async function makeCase(ws: Workspace, name: string, timeline: Timeline, opts: CaseOptions = {}): Promise<Case> {
  const version = opts.version ?? 1;
  let run = opts.run;
  if (!run) {
    const id = `20260101-120000-${name}`;
    const dir = join(ws.project.dir, 'runs', id);
    await mkdir(dir, { recursive: true });
    timeline.run_id = id;
    timeline.project = 'demo';
    timeline.scenario = name;
    await writeFile(join(dir, 'timeline.json'), JSON.stringify(timeline, null, 2));
    drawCapture(join(dir, 'capture.mp4'), timeline.capture.duration, opts.draw?.blankCapture);
    run = { id, dir, timeline };
  }
  const plan = planEdit({
    timeline: run.timeline,
    template: ws.editorial,
    project: ws.project,
    registry: ws.registry,
    captureFile: join(run.dir, 'capture.mp4'),
    overrides: { scale: 0.25, ...opts.overrides },
  });
  opts.mutate?.(plan);
  const renders = join(ws.project.dir, 'renders');
  const id = `${name}-v${version}`;
  const file = join(renders, `${id}.mp4`);
  drawRender(plan, file, opts.draw);
  clock += 60_000;
  const record: RenderRecord = {
    version: 1,
    id,
    project: 'demo',
    scenario: name,
    run_id: run.id,
    run_dir: run.dir,
    template: 'editorial',
    overrides: { scale: 0.25, ...opts.overrides },
    variant: plan.variant,
    status: 'succeeded',
    file,
    record: join(renders, `${id}.json`),
    render_version: version,
    created_at: new Date(clock).toISOString(),
    finished_at: new Date(clock + 1000).toISOString(),
    duration_s: plan.durationInFrames / plan.fps,
    frames: plan.durationInFrames,
    fps: plan.fps,
    width: plan.width,
    height: plan.height,
    size_bytes: 0,
    encoding: { codec: 'h264', crf: 16, pixel_format: 'yuv420p', faststart: true, audio: 'silent' },
    concurrency: 1,
    bundle: { hash: 'synthetic', cached: true, ms: 0 },
    browser: { path: null, source: 'playwright' },
    timings: { plan_ms: 0, bundle_ms: 0, render_ms: 0, total_ms: 0 },
    warnings: [],
    plan,
  };
  await writeFile(record.record, JSON.stringify(record, null, 2));
  return { record, plan, timeline: run.timeline, run };
}

/** Scenes of `seconds` each (page loads of 0.5 s, a 1.5 s opening still, a caption, one click in the middle, a final hold). */
export function scenesTimeline(seconds: number[], opts: { captions?: string[]; steps?: Record<number, NonNullable<SceneSpec['steps']>>; hold?: boolean } = {}): Timeline {
  let t = 0;
  const entries: SceneSpec[] = seconds.map((len, i) => {
    const start = t;
    t += len;
    const mid = start + len / 2;
    const steps: NonNullable<SceneSpec['steps']> = [
      { action: 'click', t_start: mid - 0.6, t_end: mid + 0.4, t_click: mid, point: { x: 960, y: 540 }, target: { desc: 'button "Go"', bbox: { x: 900, y: 520, w: 120, h: 40 } } },
      ...(opts.steps?.[i] ?? []),
    ];
    steps.sort((a, b) => a.t_start - b.t_start);
    // A deliberate hold to the end of the scene (as scenarios end their scenes), so the screen is not "waiting".
    const lastEnd = Math.max(...steps.map((x) => x.t_end));
    if (opts.hold !== false && start + len - 0.05 - (lastEnd + 0.1) >= 0.5) steps.push({ action: 'hold', t_start: lastEnd + 0.1, t_end: start + len - 0.05 });
    return {
      id: `s${i + 1}`,
      t_start: start,
      t_end: start + len,
      open_end: start + 0.5,
      still: [start + 0.5, start + 2] as [number, number],
      caption: { kicker: `Scene ${i + 1}`, text: opts.captions?.[i] ?? `Scene number ${i + 1} shows one thing.` },
      steps,
    };
  });
  return synthTimeline({ entries, duration: t, cursor: [[0, 960, 540]], video: { title: { kicker: 'Kicker', text: 'Synthetic video' }, frame: 'card', template: 'editorial' } });
}
