/**
 * What the production commands print, exit with and record — `retake render`, `still`, `export`, `review`, `run` and
 * `inspect` — held byte for byte against fixtures/production-cli.json: stdout, stderr, the exit code and the lines each
 * one adds to the workspace's history and journal (.retake/history.jsonl, .retake/journal.jsonl). The heavy steps are
 * replaced at their package boundary (the editor's renderVideo / renderStill / planRun / exportRender, the review's
 * reviewRender, the runner's runScenario) with fixed results, so no browser, capture or render runs; everything between
 * the command line and those steps (the options, the run and render lookups, the summaries, the errors, the history
 * lines) is the real code. A refactor of the CLI or of the engine operations it calls keeps every case; a change of what
 * a command prints or records changes some. After an intended change: RETAKE_WRITE_SNAPSHOTS=1 on this file, then
 * review the diff. Times (`… ms`, `… s` of a clock), the workspace path and the time of a history line are normalised.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const fakes = vi.hoisted(() => ({
  renderVideo: undefined as unknown as (o: Record<string, unknown>) => Promise<unknown>,
  renderStill: undefined as unknown as (o: Record<string, unknown>) => Promise<void>,
  planRun: undefined as unknown as (o: Record<string, unknown>) => Promise<unknown>,
  exportRender: undefined as unknown as (o: Record<string, unknown>) => Promise<unknown>,
  reviewRender: undefined as unknown as (o: Record<string, unknown>) => Promise<unknown>,
  runScenario: undefined as unknown as (o: Record<string, unknown>) => Promise<unknown>,
  /** The options each replaced step was called with, in order (paths normalised by the test). */
  calls: [] as Array<{ step: string; options: Record<string, unknown> }>,
  /** Names made at run time (an inspection's id), replaced by a placeholder. */
  volatile: [] as string[],
}));

vi.mock('@retake/editor', async (importOriginal) => {
  const real = await importOriginal<typeof import('@retake/editor')>();
  return {
    ...real,
    renderVideo: (o: Record<string, unknown>) => fakes.renderVideo(o),
    renderStill: (o: Record<string, unknown>) => fakes.renderStill(o),
    planRun: (o: Record<string, unknown>) => fakes.planRun(o),
    exportRender: (o: Record<string, unknown>) => fakes.exportRender(o),
  };
});
vi.mock('@retake/review', async (importOriginal) => {
  const real = await importOriginal<typeof import('@retake/review')>();
  return { ...real, reviewRender: (o: Record<string, unknown>) => fakes.reviewRender(o) };
});
vi.mock('@retake/runner-web', async (importOriginal) => {
  const real = await importOriginal<typeof import('@retake/runner-web')>();
  return { ...real, runScenario: (o: Record<string, unknown>) => fakes.runScenario(o) };
});

import { RenderCancelledError, RenderError } from '@retake/editor';
import { EXIT, main, memoryIo } from '../src/index.js';

const FILE = fileURLToPath(new URL('./fixtures/production-cli.json', import.meta.url));
const TEMPLATES = fileURLToPath(new URL('../../../templates', import.meta.url));
const RUN_ID = '20260101-120000-tour';
let ws: string;
let projectDir: string;

interface Case {
  code: number;
  out: string;
  err: string;
  history: string[];
  journal: string[];
  calls: Array<{ step: string; options: Record<string, unknown> }>;
}
const results: Record<string, Case> = {};

const lines = async (file: string): Promise<string[]> => {
  try {
    return (await readFile(file, 'utf8')).split('\n').filter(Boolean);
  } catch {
    return [];
  }
};

/** The workspace path, clock times and the time of a history line, made stable. */
function normalise(text: string): string {
  let t = text.split(ws).join('<ws>');
  for (const v of fakes.volatile) t = t.split(v).join('<id>');
  return t
    .replace(/\b\d+ ms\b/g, '<t>')
    .replace(/\b\d+\.\d s\b/g, '<t>')
    .replace(/\b\d+ m \d\d s\b/g, '<t>');
}

/** A history line with its time (and, for the steps timed by the command itself, its duration) made stable. */
function normaliseHistory(line: string): string {
  const kind = /"kind":"([a-z]+)"/.exec(line)?.[1];
  let l = normalise(line);
  if (kind !== 'run') l = l.replace(/"at":"[^"]+"/, '"at":"<at>"');
  if (kind === 'still' || kind === 'inspect') l = l.replace(/"ms":\d+/, '"ms":"<ms>"');
  return l;
}

/** What the replaced steps were called with: plain data only (functions and signals named, paths normalised). */
function callShape(options: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(options).sort(([a], [b]) => a.localeCompare(b))) {
    if (typeof v === 'function') out[k] = '<function>';
    else if (v instanceof AbortSignal) out[k] = '<signal>';
    else if (k === 'project' && v && typeof v === 'object') out[k] = `<project ${(v as { slug: string }).slug}>`;
    else if (k === 'scenario' && v && typeof v === 'object') out[k] = `<scenario ${(v as { name: string }).name}>`;
    else if (k === 'template' || k === 'registry' || k === 'plan' || k === 'ffmpeg') out[k] = v === undefined ? '<undefined>' : `<${k}>`;
    else if (k === 'inspect' && v && typeof v === 'object') out[k] = callShape(v as Record<string, unknown>);
    else out[k] = v === undefined ? '<undefined>' : JSON.parse(normalise(JSON.stringify(v)));
  }
  return out;
}

async function retake(name: string, ...args: string[]): Promise<Case> {
  const history = join(ws, '.retake', 'history.jsonl');
  const journal = join(ws, '.retake', 'journal.jsonl');
  const h0 = (await lines(history)).length;
  const j0 = (await lines(journal)).length;
  fakes.calls.length = 0;
  const io = memoryIo();
  const code = await main(['node', 'retake', '--root', ws, '--no-color', ...args], io);
  const c: Case = {
    code,
    out: normalise(io.stdout()),
    err: normalise(io.stderr()),
    history: (await lines(history)).slice(h0).map(normaliseHistory),
    journal: (await lines(journal)).slice(j0).map((l) => normalise(l).replace(/"at":"[^"]+"/, '"at":"<at>"')),
    calls: fakes.calls.map((x) => ({ step: x.step, options: callShape(x.options) })),
  };
  results[name] = c;
  return c;
}

const PLAN = {
  durationInFrames: 60,
  fps: 30,
  width: 1920,
  height: 1080,
  variant: 'landscape',
  warnings: [],
  segments: [
    { id: 'intro', kind: 'intro', from: 0 },
    { id: 'home', kind: 'scene', from: 20 },
  ],
};

function renderRecord(id: string, o: { warnings?: string[] } = {}) {
  return {
    version: 1,
    id,
    status: 'succeeded',
    scenario: 'tour',
    run_id: RUN_ID,
    run_dir: join(projectDir, 'runs', RUN_ID),
    file: join(projectDir, 'renders', `${id}.mp4`),
    record: join(projectDir, 'renders', `${id}.json`),
    template: 'editorial',
    variant: 'landscape',
    overrides: {},
    duration_s: 2,
    frames: 60,
    fps: 30,
    width: 1920,
    height: 1080,
    size_bytes: 123456,
    concurrency: 2,
    encoding: { codec: 'h264', pixel_format: 'yuv420p', faststart: true, audio: 'silent', encoder: 'libx264', crf: 16 },
    policy: { gl: { asked: 'auto', source: 'default', resolved: 'swangle', used: 'swangle' }, encoder: { asked: 'auto', source: 'default', used: 'libx264' }, concurrency_source: 'default' },
    probe: { duration_s: 2, width: 1920, height: 1080, audio_streams: 1 },
    bundle: { cached: true, ms: 0 },
    timings: { plan_ms: 5, bundle_ms: 0, render_ms: 1500, total_ms: 1700 },
    created_at: '2026-01-01T12:01:00.000Z',
    warnings: o.warnings ?? [],
    plan: PLAN,
  };
}

function reviewResult(id: string) {
  const dir = join(projectDir, 'review', id);
  return {
    render: { id, duration_s: 2 },
    durations: { segments: [{ id: 'intro' }, { id: 'home' }] },
    clean: false,
    counts: { error: 0, warning: 1, info: 1 },
    findings: [
      { code: 'video-length', severity: 'warning', message: 'the video is short (2.00 s)' },
      { code: 'scene-count', severity: 'info', message: 'two segments' },
    ],
    files: {
      dir,
      sheets: [join(dir, 'contact-sheet.png')],
      scene_sheets: { home: [join(dir, 'scene-home.png')] },
      keyframes: { home: join(dir, 'key-home.png') },
      report_md: join(dir, 'report.md'),
      report_json: join(dir, 'report.json'),
    },
    review: { ms: 900 },
    thumbnails: { sheet: 'data' },
  };
}

function runRecord(o: Record<string, unknown>) {
  return {
    version: 1,
    id: RUN_ID.replace('120000', '120500'),
    project: 'demo',
    scenario: 'tour',
    mode: 'dry',
    status: 'succeeded',
    started_at: '2026-01-01T12:05:00.000Z',
    finished_at: '2026-01-01T12:05:03.250Z',
    dir: join(projectDir, 'runs', RUN_ID.replace('120000', '120500')),
    env: 'staging',
    options: { hooks: 'skip', headed: false },
    steps_total: 1,
    steps_done: 1,
    screenshots: [],
    hooks: { setup: 'none', teardown: 'none' },
    warnings: [],
    ...o,
  };
}

/** The progress of a one-step run, as the runner reports it. */
function emitRun(onProgress: ((e: unknown) => void) | undefined, run: ReturnType<typeof runRecord>): void {
  if (!onProgress) return;
  onProgress({ type: 'run_start', run: { ...run, status: 'running', steps_done: 0 } });
  onProgress({ type: 'step_start', scene: 'home', step: 0, action: 'hold', desc: 'hold 1 s' });
  onProgress({ type: 'step_end', scene: 'home', step: 0, action: 'hold', status: 'ok', ms: 1000 });
  onProgress({ type: 'run_end', run });
}

function inspectReport(file: string) {
  return {
    version: 1,
    status: 'ok',
    at: 'end',
    page: 'app',
    persona: null,
    viewport: { width: 1280, height: 800 },
    scale: 1,
    screenshot: null,
    file,
    replay: { steps_done: 1, steps_total: 1, until: null, skipped_irreversible: 0, hooks: 'none', failed: null },
    counts: { interactive: 2, listed: 2, in_view: 2, suggested: 1, ambiguous: 1, partial: false, within_found: true, dropped: 0, targets_checked: 0 },
    popups: [],
    scrollers: [],
    elements: [
      { mark: 1, action: 'click', in: 'page', in_view: true, fragile: [], matches: 1, state: {}, bbox: { x: 0, y: 0, w: 10, h: 10 }, untrusted: { target_yaml: '{role: button, name: Save}' } },
      { mark: 2, action: 'type', in: 'dialog', in_view: true, fragile: ['nth'], matches: 2, state: { disabled: true }, bbox: { x: 0, y: 20, w: 10, h: 10 }, untrusted: {} },
    ],
    targets_checked: [],
    timings: { inspect_ms: 10, kit_ms: 5 },
    untrusted: { url: 'http://app.example.test/', title: 'Northfield console', headings: [], warnings: ['a warning of the page'] },
  };
}

beforeAll(async () => {
  ws = await mkdtemp(join(tmpdir(), 'retake-production-cli-'));
  await writeFile(join(ws, 'retake.yaml'), `projects_dir: projects\ntemplates_dir: ${JSON.stringify(TEMPLATES)}\n`);
  const made = await main(['node', 'retake', '--root', ws, 'new', 'demo', '--name', 'Demo product', '--env', 'staging=app:http://app.example.test'], memoryIo());
  expect(made).toBe(EXIT.ok);
  projectDir = join(ws, 'projects', 'demo');
  await writeFile(join(projectDir, 'scenarios', 'tour.yaml'), 'video: tour\nscenes:\n  - id: home\n    page: app\n    open: /\n    steps:\n      - hold: 1\n');
  const runDir = join(projectDir, 'runs', RUN_ID);
  await mkdir(runDir, { recursive: true });
  await writeFile(join(runDir, 'timeline.json'), JSON.stringify({ mode: 'capture', scenario: 'tour' }));
  await mkdir(join(projectDir, 'renders'), { recursive: true });
  await writeFile(join(projectDir, 'renders', 'tour-v1.json'), JSON.stringify(renderRecord('tour-v1')));
  fakes.renderVideo = async (o) => {
    fakes.calls.push({ step: 'renderVideo', options: o });
    const onProgress = o.onProgress as ((p: unknown) => void) | undefined;
    onProgress?.({ stage: 'planning', progress: 1, overall: 0.05 });
    onProgress?.({ stage: 'bundling', progress: 1, overall: 0.1, cached: true });
    onProgress?.({ stage: 'rendering', progress: 0.5, overall: 0.5, renderedFrames: 30, totalFrames: 60, eta_s: 1 });
    onProgress?.({ stage: 'encoding', progress: 1, overall: 0.95, encodedFrames: 60, totalFrames: 60 });
    onProgress?.({ stage: 'done', progress: 1, overall: 1 });
    return renderRecord('tour-v2', { warnings: ['music: none'] });
  };
  fakes.renderStill = async (o) => void fakes.calls.push({ step: 'renderStill', options: o });
  fakes.planRun = async (o) => {
    fakes.calls.push({ step: 'planRun', options: o });
    return { plan: PLAN, run: { id: RUN_ID, dir: runDir }, registry: {}, timeline: { scenario: 'tour' }, edit: { from: 'run' } };
  };
  fakes.exportRender = async (o) => {
    fakes.calls.push({ step: 'exportRender', options: o });
    const dir = join(projectDir, 'exports', String(o.render));
    const formats = o.formats as string[];
    const outputs = formats.map((format) => ({
      format,
      file: join(dir, `${String(o.render)}-${format}.mp4`),
      method: format === 'vertical_9x16' || format === 'square_1x1' ? 'render' : 'transcode',
      width: 1080,
      height: 1920,
      video_codec: 'h264',
      audio_codec: format === 'webm' ? undefined : 'aac',
      duration_s: 2,
      size_bytes: 2048,
      ms: 1200,
      warnings: format === 'webm' ? ['no audio track in the master'] : [],
    }));
    return { render: o.render, dir, manifest: join(dir, 'manifest.json'), master: { width: 1920, height: 1080, duration_s: 2 }, outputs, failures: [] };
  };
  fakes.reviewRender = async (o) => {
    fakes.calls.push({ step: 'reviewRender', options: o });
    return reviewResult(String(o.render));
  };
  fakes.runScenario = async (o) => {
    fakes.calls.push({ step: 'runScenario', options: o });
    const inspect = o.inspect as { onResult?: (r: unknown) => void } | undefined;
    if (inspect) {
      fakes.volatile.push(String(o.runId));
      const run = runRecord({ id: String(o.runId), dir: join(String(o.runsDir), String(o.runId)) });
      inspect.onResult?.(inspectReport(join(String(o.runsDir), String(o.runId), 'inspect.json')));
      return run;
    }
    const run = runRecord({});
    emitRun(o.onProgress as (e: unknown) => void, run);
    // A hook step of the run, journaled as the caller's (the CLI: the person).
    const recordHookRun = o.recordHookRun as ((r: Record<string, unknown>, run?: string) => Promise<void>) | undefined;
    await recordHookRun?.({ index: 0, name: 'seed', kind: 'http', phase: 'setup', status: 'ok', ms: 12 }, run.id);
    return run;
  };
}, 120_000);

afterAll(async () => {
  if (ws) await rm(ws, { recursive: true, force: true });
});

describe('the production commands, held against fixtures/production-cli.json', () => {
  it('render: the summary, --json with --review, an unknown run, a cancelled render', async () => {
    expect((await retake('render', 'render', 'demo', 'tour', '--concurrency', '2', '--no-music')).code).toBe(EXIT.ok);
    expect((await retake('render --json --review', 'render', 'demo', 'tour', '--json', '--review', '--vertical')).code).toBe(EXIT.ok);
    expect((await retake('render --run nope', 'render', 'demo', 'tour', '--run', 'nope')).code).toBe(EXIT.failure);
    expect((await retake('render --frame bad', 'render', 'demo', 'tour', '--frame', 'nowhere')).code).toBe(EXIT.usage);
    const keep = fakes.renderVideo;
    fakes.renderVideo = async () => {
      throw new RenderCancelledError();
    };
    expect((await retake('render cancelled', 'render', 'demo', 'tour')).code).toBe(EXIT.failure);
    fakes.renderVideo = async () => {
      throw new RenderError('the theme "ghost" does not exist');
    };
    expect((await retake('render failed', 'render', 'demo', 'tour')).code).toBe(EXIT.failure);
    fakes.renderVideo = keep;
  });

  it('still: a frame, --json, no frame, a frame past the end', async () => {
    expect((await retake('still', 'still', 'demo', 'tour', '--frame', '25')).code).toBe(EXIT.ok);
    expect((await retake('still --json', 'still', 'demo', 'tour', '--frame', '3', '--json', '--out', join(ws, 'frame.png'))).code).toBe(EXIT.ok);
    expect((await retake('still no frame', 'still', 'demo', 'tour')).code).toBe(EXIT.usage);
    expect((await retake('still past the end', 'still', 'demo', 'tour', '--frame', '60')).code).toBe(EXIT.failure);
  });

  it('export: a re-rendered format (a history line), transcodes only (none), --json, unknown formats and renders', async () => {
    expect((await retake('export rerender', 'export', 'demo', 'tour-v1', '--formats', 'vertical_9x16,webm')).code).toBe(EXIT.ok);
    expect((await retake('export transcode latest', 'export', 'demo', 'latest', '--scenario', 'tour', '--formats', 'webm', '--json')).code).toBe(EXIT.ok);
    expect((await retake('export bad format', 'export', 'demo', 'tour-v1', '--formats', 'bogus')).code).toBe(EXIT.usage);
    expect((await retake('export no render', 'export', 'demo', 'latest', '--scenario', 'ghost')).code).toBe(EXIT.failure);
  });

  it('review: the findings, --json --strict, bad options and unknown renders', async () => {
    expect((await retake('review', 'review', 'demo', 'tour-v1')).code).toBe(EXIT.ok);
    expect((await retake('review --json --strict', 'review', 'demo', 'latest', '--scenario', 'tour', '--json', '--strict', '--fps', '2', '--no-previous')).code).toBe(EXIT.failure);
    expect((await retake('review bad fps', 'review', 'demo', 'tour-v1', '--fps', '3')).code).toBe(EXIT.usage);
    expect((await retake('review no render', 'review', 'demo', 'latest', '--scenario', 'ghost')).code).toBe(EXIT.failure);
  });

  it('run: a dry run (human and JSON lines), an unknown scenario, --raw with --dry', async () => {
    expect((await retake('run --dry', 'run', 'demo', 'tour', '--dry')).code).toBe(EXIT.ok);
    expect((await retake('run --dry --json', 'run', 'demo', 'tour', '--dry', '--json')).code).toBe(EXIT.ok);
    const keep = fakes.runScenario;
    fakes.runScenario = async (o) => {
      fakes.calls.push({ step: 'runScenario', options: o });
      const run = runRecord({ status: 'failed', steps_done: 0, error: { message: 'target "Save" not found', scene: 'home', step: 0, action: 'hold' } });
      return run;
    };
    expect((await retake('run failed', 'run', 'demo', 'tour', '--dry')).code).toBe(EXIT.failure);
    fakes.runScenario = keep;
    expect((await retake('run unknown', 'run', 'demo', 'nope')).code).toBe(EXIT.failure);
    expect((await retake('run --raw --dry', 'run', 'demo', 'tour', '--raw', '--dry')).code).toBe(EXIT.usage);
  });

  it('inspect: a page (table and --json), an unknown page', async () => {
    expect((await retake('inspect', 'inspect', 'demo', 'app', '--images', 'none')).code).toBe(EXIT.ok);
    expect((await retake('inspect --json', 'inspect', 'demo', 'tour', '--images', 'none', '--json')).code).toBe(EXIT.ok);
    expect((await retake('inspect unknown', 'inspect', 'demo', 'nowhere')).code).toBe(EXIT.usage);
  });

  it('the help of each command', async () => {
    for (const cmd of ['render', 'still', 'export', 'review', 'run', 'inspect']) expect((await retake(`${cmd} --help`, cmd, '--help')).code).toBe(EXIT.ok);
  });

  it('every case matches the fixture', () => {
    const text = `${JSON.stringify(results, null, 1)}\n`;
    if (process.env.RETAKE_WRITE_SNAPSHOTS === '1') writeFileSync(FILE, text);
    expect(existsSync(FILE), 'no fixture yet: RETAKE_WRITE_SNAPSHOTS=1 on this file').toBe(true);
    const fixture = JSON.parse(readFileSync(FILE, 'utf8')) as Record<string, Case>;
    expect(Object.keys(results)).toEqual(Object.keys(fixture));
    for (const [name, c] of Object.entries(results)) expect(c, name).toEqual(fixture[name]);
  });
});
