/**
 * U8.0 (L7.21): what the commands U8 moves onto engine operations print, exit with, record and write — `retake plan`,
 * `hooks run`, `hooks rollback`, `env reset`, `sandbox init | up | down | reset | status | logs`, `components list |
 * validate | create | preview`, `export-capture` and their `--help` — held byte for byte against
 * fixtures/operations-cli.json, on pipeline-cli.test.ts's method. Each case records stdout, stderr, the exit code, the
 * lines it adds to the workspace's history and journal (.retake/history.jsonl, .retake/journal.jsonl), the files it
 * added, changed or removed in the workspace (with the content of the hook journals, the sandbox manifests, the marker
 * files and the workspace components' manifests; the rest by name), and the options of the replaced calls.
 *
 * The heavy calls are replaced at their boundary: the engine's Sandboxes port (`packageSandboxes`, what `cliPorts`
 * is made of; L7.28 — before it, @retake/sandbox's `openSandbox`, with the same records) opens a fake handle (the real
 * one's env, kind, paths and capabilities; up / down / reset / status / logs answer fixed results and journal a seed
 * step as the caller's), @retake/runner-web's `exportCapture` writes a small fake package (its folder and settings from the
 * runner's own `rawPackageDir` / `rawSettings`; `rawExportRun`, the gate, stays real), and the engine's `editorRenderer`
 * is the memory renderer (no bundle, no browser: 1 × 1 previews). The planner (`planEdit`), the hook runner (harmless
 * `shell: echo …` hooks, run for real in the temp workspace), the hook journals, the sandbox scaffold (`initSandbox`),
 * the component registry, validation and scaffold are the real code.
 *
 * Normalised, and only these: clocks (ISO stamps other than the fixture's own 2026-01-01 ones, a run id's stamp made
 * now, HH:MM:SS, durations), ids made at run time (jobs' and journals'), the workspace and repository paths, the host
 * name as a whole word, Node's and Retake's versions, journal signatures (keyed by the home's secret: their shape). The
 * test also holds that the fixture names nothing of this machine. After an intended change: RETAKE_WRITE_SNAPSHOTS=1 on
 * this file, then review the diff. Recorded on 596f693 (before U8; L7.21's removal of `callTool` touches nothing the
 * CLI runs): no U8 lot starts without it green on the commit before it. Cases marked `pins:` hold today's output where it looks wrong (listed in the lot's notes), unfixed.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir, hostname, tmpdir, userInfo } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// The sandbox status prints local times of the fixed results: one zone for every machine.
process.env.TZ = 'UTC';

const fakes = vi.hoisted(() => ({
  /** The options each replaced call was made with, in order. */
  calls: [] as Array<{ call: string; options: Record<string, unknown> }>,
  /** The fake sandboxes' state, per project and env. */
  up: new Map<string, boolean>(),
  renderer: undefined as unknown,
  /** The run ids' clock (core newRunId): one second later per id, from 2026-01-02 00:00:00 UTC; `repeat` gives the last stamp again once. */
  stamps: { next: Date.UTC(2026, 0, 2), last: 0, repeat: false },
}));

// The stamp of a run or journal id is a clock read (second resolution): a fixed clock, one tick per id, so that two
// commands never share an id by the timing of the machine (L7.21: they would — see "hooks run twice in one second").
vi.mock('@retake/core', async (importOriginal) => {
  const real = await importOriginal<typeof import('@retake/core')>();
  return {
    ...real,
    newRunId: (label: string, date?: Date) => {
      if (date) return real.newRunId(label, date);
      const st = fakes.stamps;
      if (st.repeat) st.repeat = false;
      else st.last = (st.next += 1000);
      return real.newRunId(label, new Date(st.last));
    },
  };
});

// The port's adapter as the CLI's composition root builds it (engine ports.ts imports it by this path).
vi.mock('../../engine/src/sandboxes/package-sandboxes.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../engine/src/sandboxes/package-sandboxes.ts')>();
  const { SandboxError } = await import('@retake/core');
  type Handle = import('../../engine/src/sandboxes/sandboxes.ts').SandboxHandle;
  type Project = Parameters<import('../../engine/src/sandboxes/sandboxes.ts').Sandboxes['open']>[0];
  /** A handle with the real one's env, kind, paths and capabilities; its work answers fixed results. */
  function fakeSandbox(project: Project, sb: Handle): Handle {
    const key = `${project.slug}/${sb.env}`;
    const record = (call: string, options: Record<string, unknown>) => fakes.calls.push({ call: `sandbox.${call}`, options: { env: sb.env, kind: sb.kind, ...options } });
    const resetResult = (steps: number) => ({
      strategy: sb.strategy,
      restored: false,
      ms: 240,
      hash: 'a1b2c3d4e5f6',
      at: '2026-01-01T09:00:00.000Z',
      seed: { steps, ms: 120 },
      mailbox: 'none' as const,
      restarted: [],
      superseded: 0,
      hooks: { steps: 1, ms: 30 },
    });
    type Opts = Record<string, unknown> & { progress?: { step(n: string, d?: string): void; note(t: string): void }; recordSeedRun?: (r: Record<string, unknown>) => Promise<void>; log?: (l: string, m: string) => void };
    const seedRun = async (o: Opts) => {
      await o.recordSeedRun?.({ index: 0, name: 'mark', kind: 'shell', phase: 'seed', status: 'ok', ms: 5 });
    };
    const file = project.sandboxes?.[sb.env]?.file ?? '';
    return {
      env: sb.env,
      paths: sb.paths,
      kind: sb.kind,
      strategy: sb.strategy,
      capabilities: sb.capabilities,
      async up(o: Opts = {}) {
        record('up', o);
        o.progress?.step('services', 'app');
        o.progress?.note('app: starting');
        o.progress?.step('health');
        const was = fakes.up.get(key) === true;
        fakes.up.set(key, true);
        const seeding = o.seed !== 'never' && !was;
        if (seeding) {
          o.progress?.step('seed', '1 step');
          await seedRun(o);
        }
        o.log?.('warn', 'a warning of the fake sandbox');
        return { started: was ? [] : ['app'], kept: was ? ['app'] : [], changed: [], ms: 410, ...(seeding ? { reset: resetResult(1) } : {}) };
      },
      async down(o: Opts = {}) {
        record('down', o);
        const was = fakes.up.get(key) === true;
        fakes.up.set(key, false);
        return { stopped: was ? ['app'] : [], dataGone: true };
      },
      async reset(o: Opts = {}) {
        record('reset', o);
        if (fakes.up.get(key) !== true) throw new SandboxError(`sandbox ${sb.env} is not running: retake sandbox up ${project.slug}`);
        o.progress?.step('seed', '1 step');
        await seedRun(o);
        return resetResult(1);
      },
      async checkRunning(o: Opts = {}) {
        record('checkRunning', o);
        return {};
      },
      async status(o: Opts = {}) {
        record('status', o);
        const isUp = fakes.up.get(key) === true;
        return {
          env: sb.env,
          provider: sb.kind,
          file,
          state: isUp ? 'up' : 'down',
          services: [
            isUp
              ? { name: 'app', state: 'running', pid: 4242, started_at: '2026-01-01T09:00:00.000Z', command: 'node service.mjs', health: 'ok', healthy: true }
              : { name: 'app', state: 'stopped', health: null },
          ],
          ...(isUp ? { seed: { hash: 'a1b2c3d4e5f6', at: '2026-01-01T09:00:00.000Z', ms: 120, current: true }, last_reset: { strategy: sb.strategy, at: '2026-01-01T09:00:00.000Z', ms: 240, by: 'cli' } } : {}),
          logs: sb.paths.logs,
          notes: isUp ? [] : ['a note of the fake sandbox'],
        };
      },
      async logs(o: { service?: string; lines?: number } = {}) {
        record('logs', o);
        if (o.service !== undefined && o.service !== 'app') throw new SandboxError(`unknown service "${o.service}" (services: app)`);
        return [{ service: 'app', file: join(sb.paths.logs, 'app.log'), exists: true, text: 'listening\nGET /health 200' }];
      },
      async followLogs(o: Record<string, unknown>) {
        record('followLogs', o);
      },
      killStartedSync() {
        fakes.calls.push({ call: 'sandbox.killStartedSync', options: {} });
      },
    } as unknown as Handle;
  }
  return {
    ...real,
    packageSandboxes: () => {
      const sandboxes = real.packageSandboxes();
      return {
        // The real open (its refusals: no sandbox, an unknown env), then the fake handle.
        open: async (project: Project, env: string | undefined, policy: Parameters<typeof sandboxes.open>[2]) => fakeSandbox(project, await sandboxes.open(project, env, policy)),
        // The scaffold is the real one; only the machine's ports are not probed (every port is free: 4600 on).
        init: (project: Project, o: Parameters<typeof sandboxes.init>[1]) => {
          fakes.calls.push({ call: 'initSandbox', options: { project, ...o } });
          return sandboxes.init(project, { ...o, isFree: o.isFree ?? (async () => true) });
        },
      };
    },
  };
});

vi.mock('@retake/runner-web', async (importOriginal) => {
  const real = await importOriginal<typeof import('@retake/runner-web')>();
  const { mkdir: mk, writeFile: wf } = await import('node:fs/promises');
  return {
    ...real,
    /** A small package: its folder and settings the runner's own; a clip per scene, markers, cursor data, manifest, README. */
    exportCapture: async (o: Parameters<typeof real.exportCapture>[0]) => {
      fakes.calls.push({ call: 'exportCapture', options: o as unknown as Record<string, unknown> });
      const { recorded: timeline } = await real.rawExportRun(o.runDir);
      const s = real.rawSettings(o.project, timeline, o);
      const dir = o.out ?? real.rawPackageDir(o.project, timeline.run_id, s);
      await mk(dir, { recursive: true });
      o.onProgress?.({ stage: 'clip', done: 1, total: 2 });
      const ext = s.format === 'prores' ? 'mov' : 'mp4';
      const clips = timeline.scenes.slice(0, 2).map((sc, i) => ({
        file: `${String(i + 1).padStart(2, '0')}-${sc.id}.${ext}`,
        scene: sc.id,
        width: 1920,
        height: 1080,
        frames: 90,
        duration_s: 3,
        seq_start_tc: `00:00:0${i * 3}:00`,
        size_bytes: 2_097_152,
        primary: i === 0,
        cuts: i === 0 && s.cuts ? [{ seconds: 0.8, reason: 'page load' }] : [],
        ...(s.cursor === 'layer' ? { layer: { file: `${String(i + 1).padStart(2, '0')}-${sc.id}.cursor.${s.layer === 'webm' ? 'webm' : 'mov'}`, codec: s.layer === 'webm' ? 'vp9' : 'prores_4444', pix_fmt: s.layer === 'webm' ? 'yuva420p' : 'yuva444p10le', size_bytes: 65_536 } } : {}),
      }));
      const manifest = {
        version: 1,
        kind: 'retake/raw-capture',
        created_at: '2026-01-01T12:10:00.000Z',
        project: { slug: o.project.slug, name: o.project.config.name },
        scenario: timeline.scenario,
        run: { id: timeline.run_id, dir: o.runDir, captured_at: '2026-01-01T12:00:00.000Z', capture: { width: 1920, height: 1080, scale: 1, fps: 30, duration_s: 6, frames: 180 }, cursor: 'visible' },
        settings: { format: s.format, codec: s.format === 'prores' ? 'prores_hq' : 'h264', fps: s.fps, cursor: s.cursor, ...(s.cursor === 'layer' ? { layer: s.layer, layer_codec: s.layer === 'webm' ? 'vp9' : 'prores_4444' } : {}), cuts: s.cuts, selects: s.selects, frames_from: 'capture video' },
        sequence: { fps: s.fps, frames: 180, duration_s: 6, start_tc: '00:00:00:00', end_tc: '00:00:06:00' },
        clips,
        ...(s.selects ? { selects: { file: `selects.${ext}`, frames: 180, duration_s: 6, codec: 'h264', size_bytes: 4_194_304 } } : {}),
        cursor: { mode: s.cursor, data: { json: 'cursor.json', csv: 'cursor.csv', clicks_csv: 'clicks.csv' }, icons: 'recorded', look: { style: 'arrow', size: 1, ripple_color: '#000' }, layers: [] },
        markers: { fcpxml: 'markers.fcpxml', edl: 'markers.edl', otio: 'markers.otio', json: 'markers.json', csv: 'markers.csv', count: { scene: 2, step: 3, caption: 0, click: 1 }, colors: {} },
        edit_files: o.editFiles ?? [],
        notes: [],
        warnings: o.template ? [] : ['the cursor layer uses the default look'],
      };
      for (const f of [...clips.flatMap((k) => [k.file, ...(k.layer ? [k.layer.file] : [])]), ...(s.selects ? [`selects.${ext}`] : []), 'cursor.json', 'cursor.csv', 'clicks.csv', 'markers.fcpxml', 'markers.edl', 'markers.otio', 'markers.json', 'markers.csv']) await wf(join(dir, f), 'fake');
      await wf(join(dir, 'manifest.json'), JSON.stringify(manifest));
      await wf(join(dir, 'README.md'), '# raw package\n');
      o.onProgress?.({ stage: 'done', done: 2, total: 2 });
      return { dir, manifest, manifestFile: join(dir, 'manifest.json'), readme: join(dir, 'README.md') } as unknown as Awaited<ReturnType<typeof real.exportCapture>>;
    },
  };
});

vi.mock('@retake/engine', async (importOriginal) => {
  const real = await importOriginal<typeof import('@retake/engine')>();
  return { ...real, editorRenderer: () => fakes.renderer };
});

import { RETAKE_VERSION } from '@retake/core';
import { EXIT, main, memoryIo } from '../src/index.js';
import { MemoryRenderer } from '../../engine/src/render/memory-renderer.js';
import type { MemoryRendererCall } from '../../engine/src/render/memory-renderer.js';
import { syntheticRunRecord } from '../../editor/test/render-helpers.js';

const FILE = fileURLToPath(new URL('./fixtures/operations-cli.json', import.meta.url));
const REPO = fileURLToPath(new URL('../../..', import.meta.url)).replace(/\/$/, '');
const TEMPLATES = join(REPO, 'templates');
const FIXTURES = join(REPO, 'packages', 'editor', 'test', 'fixtures');
const RUN = '20260101-120000-signup';
const OLDER = '20260101-110000-signup';
const DRY = '20260101-130000-signup';
const BARE = '20260101-140000-signup';
const GHOST = '20260101-100000-signup';
const PLACED = '20260101-090000-placed';
/** A capture whose edit names a file of the project (a card's image): the raw package lists it among its edit files. */
const CARDED = '20260101-115000-signup';
const savedHome = process.env.RETAKE_HOME;

let ws = '';
let paths: Array<[string, string]> = [];
const renderer = new MemoryRenderer();
fakes.renderer = renderer;

interface Case {
  args: string[];
  code: number;
  out: string;
  err: string;
  history: string[];
  journal: string[];
  files: Record<string, string>;
  calls: Array<{ call: string; options: unknown }>;
}
const results: Record<string, Case> = {};
/** Ids made at run time, numbered by order of appearance. */
const ids = new Map<string, string>();

/** A time as formatMs prints it ("850 ms", "1.7 s", "2 m 05 s"). */
const SPAN = String.raw`(?:\d+ ms|\d+\.\d s|\d+ m \d\d s)`;
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function byOrder(kind: string, id: string): string {
  const k = `${kind}:${id}`;
  if (!ids.has(k)) ids.set(k, `<${kind}-${[...ids.keys()].filter((x) => x.startsWith(`${kind}:`)).length + 1}>`);
  return ids.get(k)!;
}

/** Text with the workspace and repository paths, clocks, run-time ids, host and versions made stable (see the header). */
function normalise(text: string): string {
  let t = text;
  for (const [from, to] of paths) t = t.split(from).join(to);
  t = t.replace(new RegExp(`(?<![\\w.-])${escape(hostname())}(?![\\w-])`, 'g'), '<host>');
  t = t.split(RETAKE_VERSION).join('<version>').split(process.versions.node).join('<node>');
  // ISO stamps: the fixture's own (2026-01-01) are kept, a clock's are not.
  t = t.replace(/\b(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/g, (m, day: string) => (day === '2026-01-01' ? m : '<at>'));
  // A run or journal id's stamp made now (20261112-031536-hooks-…); the fixture's runs are of 2026-01-01.
  t = t.replace(/\b(\d{8})-(\d{6})(?=-[a-z])/g, (m, day: string, time: string) => (day === '20260101' || day === '20260102' ? m : byOrder('stamp', `${day}-${time}`)));
  t = t.replace(/\bj_[0-9A-HJKMNP-TV-Z]{26}\b/g, (m) => byOrder('job', m));
  // The step lines' local time (StepDisplay: "  12:34:56  services"), not a timecode (00:00:03:00).
  t = t.replace(/^( +)\d{2}:\d{2}:\d{2}(?=  )/gm, '$1<clock>');
  // Hashes of what was written (a journal's sha256 / if_match, a preview's source hash): some files name the
  // repository by a relative path, so their bytes are this checkout's. Numbered by order (equal hashes stay equal).
  t = t.replace(/\b[0-9a-f]{16,64}\b/g, (m) => byOrder('hash', m));
  // A scaffold's `$schema` reaches the repository by a relative path from the workspace (its depth is the temp folder's).
  t = t.replace(/(?:\.\.\/)*\.\.<repo>/g, '<relative>/<repo>');
  t = t.replace(new RegExp(`\\b${SPAN}`, 'g'), '<t>');
  return t;
}

/** A JSON value normalised as text, durations and signatures by key. */
function normaliseValue(v: unknown, key?: string): unknown {
  if (typeof v === 'string' && key === 'sig') return /^[0-9a-f]{64}$/.test(v) ? '<sig: 64 hex>' : `<sig: ${v.length} characters>`;
  if (typeof v === 'string') return normalise(v);
  if (typeof v === 'number' && (key === 'ms' || (key ?? '').endsWith('_ms'))) return '<ms>';
  if (Array.isArray(v)) return v.map((x) => normaliseValue(x));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [normalise(k), normaliseValue(x, k)]));
  return v;
}

const jsonLine = (line: string): string => {
  try {
    const v = JSON.parse(line) as Record<string, unknown>;
    // The size of a file that names the repository (a scaffold's `$schema`) is this checkout's.
    if (typeof v.path === 'string' && /(^|\/)(component|sandbox)\.yaml$/.test(v.path) && typeof v.bytes === 'number') v.bytes = '<bytes>';
    return JSON.stringify(normaliseValue(v));
  } catch {
    return normalise(line);
  }
};

const lines = async (file: string): Promise<string[]> => {
  try {
    return (await readFile(file, 'utf8')).split('\n').filter(Boolean);
  } catch {
    return [];
  }
};

/** Every file of the workspace (but the home and the two logs read apart) with a hash of its bytes. */
async function tree(dir = ws, out = new Map<string, string>()): Promise<Map<string, string>> {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    const rel = relative(ws, p);
    if (rel === '.home' || rel === join('.retake', 'history.jsonl') || rel === join('.retake', 'journal.jsonl')) continue;
    if (e.isDirectory()) await tree(p, out);
    else out.set(rel, createHash('sha256').update(await readFile(p)).digest('hex'));
  }
  return out;
}

/** Files whose content the fixture holds: hook journals, sandbox manifests and project files, markers, component manifests. */
const shown = (rel: string): boolean =>
  /(^|\/)\.retake\/journals\/[^/]+\.json$/.test(rel) ||
  /\/hooks-journal\.json$/.test(rel) ||
  /(^|\/)sandbox(\/[^/]+)?\/sandbox\.yaml$/.test(rel) ||
  /\/project\.yaml$/.test(rel) ||
  /-marker\.txt$/.test(rel) ||
  /^components\/[^/]+\/[^/]+\/component\.yaml$/.test(rel) ||
  /\/preview\.json$/.test(rel);

async function fileShape(rel: string, hash: string | undefined): Promise<string> {
  if (hash === undefined) return '<removed>';
  if (!shown(rel)) return '<written>';
  const text = await readFile(join(ws, rel), 'utf8');
  return rel.endsWith('.json') ? JSON.stringify(normaliseValue(JSON.parse(text)), null, 1) : normalise(text);
}

/** What a replaced call was made with: plain data (functions, signals and objects named; paths normalised). */
function callShape(options: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(options).sort(([a], [b]) => a.localeCompare(b))) {
    if (typeof v === 'function') out[k] = '<function>';
    else if (v instanceof AbortSignal) out[k] = '<signal>';
    else if (k === 'progress' && v && typeof v === 'object') out[k] = '<progress>';
    else if (k === 'project' && v && typeof v === 'object') out[k] = `<project ${(v as { slug: string }).slug}>`;
    else if (k === 'template' && v && typeof v === 'object') out[k] = `<template ${(v as { name: string }).name}>`;
    else if (k === 'policy' && v && typeof v === 'object') out[k] = '<policy>';
    else if (k === 'ffmpeg') out[k] = v === undefined ? '<undefined>' : '<ffmpeg>';
    else out[k] = v === undefined ? '<undefined>' : normaliseValue(JSON.parse(JSON.stringify(v)));
  }
  return out;
}

/** The memory renderer's requests: what was asked of it, without the bundle's inner objects. */
function rendererShape(c: MemoryRendererCall): { call: string; options: unknown } {
  if (c.op === 'previews.bundle') {
    const req = c.req as unknown as { components: Array<{ id: string; kind: string }> };
    return { call: 'renderer.previews.bundle', options: { components: req.components.map((x) => `${x.id} ${x.kind}`) } };
  }
  return { call: `renderer.${c.op}`, options: { keys: Object.keys(c.req).sort() } };
}

async function retake(name: string, ...rest: Array<string | { answers: string[] }>): Promise<Case> {
  const last = rest[rest.length - 1];
  const answers = typeof last === 'object' ? (rest.pop() as { answers: string[] }).answers : undefined;
  const args = rest as string[];
  const history = join(ws, '.retake', 'history.jsonl');
  const journal = join(ws, '.retake', 'journal.jsonl');
  const h0 = (await lines(history)).length;
  const j0 = (await lines(journal)).length;
  const before = await tree();
  fakes.calls.length = 0;
  renderer.calls.length = 0;
  const io = memoryIo(answers ? { answers } : {});
  const code = await main(['node', 'retake', '--root', ws, '--no-color', ...args], io);
  const after = await tree();
  const files: Record<string, string> = {};
  for (const rel of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    if (before.get(rel) === after.get(rel)) continue;
    files[normalise(rel)] = await fileShape(rel, after.get(rel));
  }
  const c: Case = {
    args: args.map(normalise),
    code,
    out: normalise(io.stdout()),
    err: normalise(io.stderr()),
    history: (await lines(history)).slice(h0).map(jsonLine),
    journal: (await lines(journal)).slice(j0).map(jsonLine),
    files,
    calls: [...fakes.calls.map((x) => ({ call: x.call, options: callShape(x.options) })), ...renderer.calls.map(rendererShape)],
  };
  expect(results[name], `case "${name}" twice`).toBeUndefined();
  results[name] = c;
  return c;
}

const scenario = (video: string, page: string, extra: string[] = []) => [`video: ${video}`, ...extra, 'scenes:', '  - id: home', `    page: ${page}`, '    open: /', '    steps:', '      - hold: 1', ''].join('\n');

async function runFolder(id: string, o: { timeline?: (t: Record<string, unknown>) => Record<string, unknown>; record?: Record<string, unknown> } = {}): Promise<string> {
  const dir = join(ws, 'projects', 'film', 'runs', id);
  await mkdir(dir, { recursive: true });
  if (o.timeline) {
    const t = JSON.parse(await readFile(join(FIXTURES, 'signup.timeline.json'), 'utf8')) as Record<string, unknown>;
    await writeFile(join(dir, 'timeline.json'), JSON.stringify(o.timeline({ ...t, run_id: id, project: 'film' })));
  }
  await writeFile(join(dir, 'run.json'), JSON.stringify({ ...syntheticRunRecord(dir, { id, scenario: 'signup', project: 'film' }), engine: { retake: '0.0.0', node: '0.0.0', os: 'test' }, ...o.record }));
  await writeFile(join(dir, 'capture.mp4'), 'never read');
  return dir;
}

/** A journal entry Retake did not sign with this home (written by hand). */
function placed(): string {
  return JSON.stringify({
    version: 1,
    created_at: '2026-01-01T09:00:00.000Z',
    updated_at: '2026-01-01T09:00:00.000Z',
    entries: [
      {
        seq: 1,
        kind: 'shell',
        phase: 'setup',
        description: 'shell "true"',
        env: 'local',
        started_at: '2026-01-01T09:00:00.000Z',
        finished_at: '2026-01-01T09:00:01.000Z',
        status: 'ok',
        rollback: { kind: 'shell', run: 'echo placed >> placed-marker.txt', description: 'shell "echo placed >> placed-marker.txt"', data: {} },
      },
    ],
  });
}

beforeAll(async () => {
  // A path under the current folder prints relative to it (the built-in library's): the suite runs from the repository root.
  expect(process.cwd(), 'run this file from the repository root').toBe(REPO);
  ws = await mkdtemp(join(tmpdir(), 'retake-operations-cli-'));
  process.env.RETAKE_HOME = join(ws, '.home');
  paths = [
    [await realpath(ws), '<ws>'],
    [ws, '<ws>'],
    [REPO, '<repo>'],
  ].sort((a, b) => b[0].length - a[0].length) as Array<[string, string]>;
  await writeFile(join(ws, 'retake.yaml'), `projects_dir: projects\ntemplates_dir: ${JSON.stringify(TEMPLATES)}\n`);

  // film: captures of `signup` (the editor's fixture timeline) — plan and export-capture.
  const film = join(ws, 'projects', 'film');
  await mkdir(join(film, 'scenarios'), { recursive: true });
  await writeFile(join(film, 'project.yaml'), 'name: Film\nenvironments:\n  local: {shop: "http://shop.example.test", console: "http://console.example.test"}\ntemplate: editorial\n');
  await runFolder(OLDER, { timeline: (t) => t });
  await runFolder(RUN, { timeline: (t) => t });
  await runFolder(CARDED, {
    timeline: (t) => ({ ...t, scenes: (t.scenes as Array<Record<string, unknown>>).map((sc, i) => (i === 0 ? { ...sc, card: { component: 'studio/card-figure', slots: { image: 'assets/figure.png', title: 'A figure' } } } : sc)) }),
  });
  await mkdir(join(film, 'assets'), { recursive: true });
  await writeFile(join(film, 'assets', 'figure.png'), 'not read');
  await runFolder(GHOST, { timeline: (t) => ({ ...t, video: { ...(t.video as object), template: 'ghost' } }) });
  await runFolder(DRY, { timeline: (t) => ({ ...t, mode: 'dry' }), record: { mode: 'dry' } });
  await runFolder(BARE);

  // ops: shell echo hooks everywhere, production environments, a process sandbox.
  const ops = join(ws, 'projects', 'ops');
  for (const d of ['scenarios', 'hooks', 'sandbox']) await mkdir(join(ops, d), { recursive: true });
  await writeFile(
    join(ops, 'project.yaml'),
    [
      'name: Ops',
      'environments:',
      '  local: {app: "http://app.example.test"}',
      '  production:',
      '    production: true',
      '    pages:',
      '      app: {url: "http://live.example.test"}',
      '  live:',
      '    production: true',
      '    access: read-write',
      '    pages:',
      '      app: {url: "http://live.example.test"}',
      'sandboxes:',
      '  sandbox: sandbox/sandbox.yaml',
      'default_env: local',
      'template: editorial',
      'reset:',
      '  - name: wipe',
      '    shell: {run: "echo reset >> reset-marker.txt"}',
      '',
    ].join('\n'),
  );
  await writeFile(
    join(ops, 'scenarios', 'tour.yaml'),
    scenario('tour', 'app', ['setup:', '  - name: prepare', '    shell: {run: "echo setup >> setup-marker.txt", rollback: "echo undone >> undo-marker.txt"}', 'teardown:', '  - name: tidy', '    shell: "touch teardown-marker.txt"']),
  );
  await writeFile(join(ops, 'scenarios', 'broken.yaml'), scenario('broken', 'app', ['setup:', '  - name: drop', '    shell: "echo drop"', '    destructive: true']));
  await writeFile(join(ops, 'hooks', 'mark.yaml'), '- name: mark\n  shell: {run: "echo mark >> mark-marker.txt", rollback: "echo unmark >> unmark-marker.txt"}\n');
  await writeFile(join(ops, 'hooks', 'peek.yaml'), '- name: peek\n  shell: {run: "echo peek >> peek-marker.txt"}\n  writes: false\n');
  await writeFile(join(ops, 'hooks', 'fail.yaml'), '- name: ok first\n  shell: "echo first >> fail-marker.txt"\n- name: boom\n  shell: "exit 3"\n- name: never\n  shell: "echo never >> fail-marker.txt"\n');
  await writeFile(join(ops, 'hooks', 'drop.yaml'), '- name: drop\n  shell: "echo dropped >> drop-marker.txt"\n  destructive: true\n');
  await writeFile(join(ops, 'sandbox', 'service.mjs'), 'process.stdin.resume();\n');
  await writeFile(
    join(ops, 'sandbox', 'sandbox.yaml'),
    [
      'version: 1',
      'provider: process',
      'services:',
      '  app:',
      '    command: [node, service.mjs, "4599"]',
      '    url: http://localhost:4599',
      '    health: /health',
      '    pages:',
      '      app: {url: "http://localhost:4599", display: app.example}',
      'seed:',
      '  - name: mark',
      '    shell: {run: "echo seeded >> seed-marker.txt"}',
      '',
    ].join('\n'),
  );

  // fresh: no sandbox, no hooks, no journal.
  await mkdir(join(ws, 'projects', 'fresh'), { recursive: true });
  await writeFile(join(ws, 'projects', 'fresh', 'project.yaml'), 'name: Fresh\nenvironments:\n  local: {app: "http://app.example.test"}\n');
}, 120_000);

afterAll(async () => {
  if (savedHome === undefined) delete process.env.RETAKE_HOME;
  else process.env.RETAKE_HOME = savedHome;
  if (ws) await rm(ws, { recursive: true, force: true });
});

describe('the commands U8 moves, held against fixtures/operations-cli.json (U8.0)', () => {
  it('plan: the summary, --json, --out, a bad --frame, latest --scenario, a dry run, no timeline, a changed scenario', async () => {
    expect.soft((await retake('plan', 'plan', 'film', RUN)).code).toBe(EXIT.ok);
    expect.soft((await retake('plan --json --vertical', 'plan', 'film', RUN, '--json', '--vertical')).code).toBe(EXIT.ok);
    expect.soft((await retake('plan --out --theme --frame', 'plan', 'film', RUN, '--out', join(ws, 'plan.json'), '--theme', 'motion', '--frame', 'raw')).code).toBe(EXIT.ok);
    expect.soft((await retake('plan --frame bad', 'plan', 'film', RUN, '--frame', 'Fancy Frame')).code).toBe(EXIT.usage);
    expect.soft((await retake('plan latest --scenario', 'plan', 'film', 'latest', '--scenario', 'signup', '--square')).code).toBe(EXIT.ok);
    expect.soft((await retake('plan latest --scenario ghost', 'plan', 'film', 'latest', '--scenario', 'ghost')).code).toBe(EXIT.failure);
    expect.soft((await retake('plan a dry run', 'plan', 'film', DRY)).code).toBe(EXIT.failure);
    expect.soft((await retake('plan no timeline', 'plan', 'film', BARE)).code).toBe(EXIT.failure);
    expect.soft((await retake('plan unknown run', 'plan', 'film', 'nope')).code).toBe(EXIT.failure);
    expect.soft((await retake('plan unknown theme', 'plan', 'film', RUN, '--theme', 'ghost')).code).toBe(EXIT.failure);
    // The filmed part of the scenario changed since the run: the plan is the run's, a warning on stderr (--json too).
    const snapshot = scenario('signup', 'shop');
    const today = join(ws, 'projects', 'film', 'scenarios', 'signup.yaml');
    await writeFile(join(ws, 'projects', 'film', 'runs', RUN, 'scenario.yaml'), snapshot);
    await writeFile(today, snapshot.replace('hold: 1', 'hold: 3'));
    try {
      expect.soft((await retake('plan scenario changed', 'plan', 'film', RUN)).code).toBe(EXIT.ok);
      expect.soft((await retake('plan scenario changed --json', 'plan', 'film', RUN, '--json')).code).toBe(EXIT.ok);
    } finally {
      await rm(today, { force: true });
      await rm(join(ws, 'projects', 'film', 'runs', RUN, 'scenario.yaml'), { force: true });
    }
  });

  it('plan: the registry error notices, printed as warnings', async () => {
    const broken = join(ws, 'components', 'acme', 'broken');
    await mkdir(broken, { recursive: true });
    await writeFile(join(broken, 'component.yaml'), 'id: acme/broken\nkind: nonsense\n');
    expect.soft((await retake('plan registry notices', 'plan', 'film', RUN, '--frame', 'acme/broken')).code).toBe(EXIT.ok);
  });

  it('hooks run: dry, real, failing, unknown sources, destructive, --replay-unsigned, production with and without --allow-writes', async () => {
    expect.soft((await retake('hooks run --dry', 'hooks', 'run', 'ops', 'tour:setup', '--dry')).code).toBe(EXIT.ok);
    expect.soft((await retake('hooks run', 'hooks', 'run', 'ops', 'tour:setup')).code).toBe(EXIT.ok);
    expect.soft((await retake('hooks run teardown', 'hooks', 'run', 'ops', 'tour:teardown')).code).toBe(EXIT.ok);
    expect.soft((await retake('hooks run reset --dry', 'hooks', 'run', 'ops', 'reset', '--dry')).code).toBe(EXIT.ok);
    expect.soft((await retake('hooks run failing', 'hooks', 'run', 'ops', 'hooks/fail.yaml')).code).toBe(EXIT.failure);
    expect.soft((await retake('hooks run not a source', 'hooks', 'run', 'ops', 'nope')).code).toBe(EXIT.usage);
    // A person may name any hooks file, by an absolute path too (an agent's job may not: projectFilesOnly).
    await writeFile(join(ws, 'outside-hooks.yaml'), '- name: outside\n  shell: {run: "echo outside >> outside-marker.txt"}\n');
    expect.soft((await retake('hooks run an absolute file', 'hooks', 'run', 'ops', join(ws, 'outside-hooks.yaml'))).code).toBe(EXIT.ok);
    expect.soft((await retake('hooks run file not found', 'hooks', 'run', 'ops', 'hooks/none.yaml')).code).toBe(EXIT.failure);
    expect.soft((await retake('hooks run unknown scenario', 'hooks', 'run', 'ops', 'nope:setup')).code).toBe(EXIT.failure);
    expect.soft((await retake('hooks run a scenario that does not load', 'hooks', 'run', 'ops', 'broken:setup')).code).toBe(EXIT.failure);
    expect.soft((await retake('hooks run no reset hooks', 'hooks', 'run', 'fresh', 'reset')).code).toBe(EXIT.failure);
    expect.soft((await retake('hooks run unknown env', 'hooks', 'run', 'ops', 'reset', '--env', 'nowhere')).code).toBe(EXIT.failure);
    // pins: `--yes` "approves destructive hooks that lack confirm: true", but a hooks file with one does not load
    // (core's check refuses it first): the flag and the question are never reached from a hooks file.
    expect.soft((await retake('hooks run destructive without --yes', 'hooks', 'run', 'ops', 'hooks/drop.yaml')).code).toBe(EXIT.failure);
    expect.soft((await retake('hooks run destructive --yes', 'hooks', 'run', 'ops', 'hooks/drop.yaml', '--yes')).code).toBe(EXIT.failure);
    expect.soft((await retake('hooks run destructive in a terminal', 'hooks', 'run', 'ops', 'hooks/drop.yaml', { answers: ['y'] })).code).toBe(EXIT.failure);
    // hooks run takes no --replay-unsigned (rollback and env reset do): commander's usage error.
    expect.soft((await retake('hooks run --replay-unsigned', 'hooks', 'run', 'ops', 'reset', '--replay-unsigned')).code).toBe(EXIT.usage);
    expect.soft((await retake('hooks run production', 'hooks', 'run', 'ops', 'hooks/mark.yaml', '--env', 'production')).code).toBe(EXIT.failure);
    expect.soft((await retake('hooks run production writes: false', 'hooks', 'run', 'ops', 'hooks/peek.yaml', '--env', 'production')).code).toBe(EXIT.ok);
    expect.soft((await retake('hooks run production --allow-writes', 'hooks', 'run', 'ops', 'hooks/mark.yaml', '--env', 'production', '--allow-writes')).code).toBe(EXIT.usage);
    expect.soft((await retake('hooks run live without --allow-writes', 'hooks', 'run', 'ops', 'hooks/mark.yaml', '--env', 'live')).code).toBe(EXIT.failure);
    expect.soft((await retake('hooks run live --allow-writes', 'hooks', 'run', 'ops', 'hooks/mark.yaml', '--env', 'live', '--allow-writes')).code).toBe(EXIT.ok);
  });

  it('hooks rollback: none pending, one run, a run without a journal, an unsigned entry, all', async () => {
    expect.soft((await retake('hooks rollback none pending', 'hooks', 'rollback', 'fresh')).code).toBe(EXIT.ok);
    expect.soft((await retake('hooks rollback no journal', 'hooks', 'rollback', 'ops', '20260101-080000-nothing')).code).toBe(EXIT.failure);
    const journals = async (label: string) => (await readdir(join(ws, 'projects', 'ops', '.retake', 'journals'))).filter((f) => f.includes(label)).sort().map((f) => f.replace(/\.json$/, ''));
    // The journal of `hooks run ops tour:setup` (the first real run above).
    const [one] = await journals('hooks-tour-setup');
    expect(one).toBeDefined();
    expect.soft((await retake('hooks rollback one run --dry', 'hooks', 'rollback', 'ops', one!, '--dry')).code).toBe(EXIT.ok);
    expect.soft((await retake('hooks rollback one run', 'hooks', 'rollback', 'ops', one!)).code).toBe(EXIT.ok);
    expect.soft((await retake('hooks rollback one run again', 'hooks', 'rollback', 'ops', one!)).code).toBe(EXIT.ok);
    await mkdir(join(ws, 'projects', 'ops', 'runs', PLACED), { recursive: true });
    await writeFile(join(ws, 'projects', 'ops', 'runs', PLACED, 'hooks-journal.json'), placed());
    expect.soft((await retake('hooks rollback unsigned --dry', 'hooks', 'rollback', 'ops', PLACED, '--dry')).code).toBe(EXIT.ok);
    expect.soft((await retake('hooks rollback --replay-unsigned without a terminal', 'hooks', 'rollback', 'ops', '--replay-unsigned')).code).toBe(EXIT.usage);
    expect.soft((await retake('hooks rollback --replay-unsigned answered no', 'hooks', 'rollback', 'ops', PLACED, '--replay-unsigned', { answers: [''] })).code).toBe(EXIT.failure);
    // Every pending journal: the production one (env live) is refused without --allow-writes, the unsigned one is not replayed.
    expect.soft((await retake('hooks rollback all', 'hooks', 'rollback', 'ops')).code).toBe(EXIT.failure);
    const live = (await journals('hooks-mark')).at(-1)!;
    expect.soft((await retake('hooks rollback --env live --allow-writes', 'hooks', 'rollback', 'ops', live, '--env', 'live', '--allow-writes')).code).toBe(EXIT.ok);
    expect.soft((await retake('hooks rollback --replay-unsigned answered yes', 'hooks', 'rollback', 'ops', '--replay-unsigned', { answers: ['y'] })).code).toBe(EXIT.ok);
    expect.soft((await retake('hooks rollback all, nothing left', 'hooks', 'rollback', 'ops')).code).toBe(EXIT.ok);
  });

  it('hooks run twice in one second: both runs share one id and one journal (pins: the id is a stamp of the second)', async () => {
    expect.soft((await retake('hooks run in a second', 'hooks', 'run', 'ops', 'hooks/mark.yaml')).code).toBe(EXIT.ok);
    fakes.stamps.repeat = true;
    expect.soft((await retake('hooks run in the same second', 'hooks', 'run', 'ops', 'hooks/mark.yaml')).code).toBe(EXIT.ok);
  });

  it('env reset: no reset hooks, with reset hooks (dry, real: the pending rollbacks first), on a sandbox env, a production env', async () => {
    expect.soft((await retake('env reset no reset hooks', 'env', 'reset', 'fresh')).code).toBe(EXIT.ok);
    expect.soft((await retake('env reset --dry', 'env', 'reset', 'ops', '--dry')).code).toBe(EXIT.ok);
    expect.soft((await retake('env reset', 'env', 'reset', 'ops')).code).toBe(EXIT.ok);
    expect.soft((await retake('env reset --env sandbox', 'env', 'reset', 'ops', '--env', 'sandbox')).code).toBe(EXIT.ok);
    expect.soft((await retake('env reset --env production', 'env', 'reset', 'ops', '--env', 'production')).code).toBe(EXIT.failure);
    expect.soft((await retake('env reset --env production --allow-writes', 'env', 'reset', 'ops', '--env', 'production', '--allow-writes')).code).toBe(EXIT.usage);
    expect.soft((await retake('env reset --env live --allow-writes --yes', 'env', 'reset', 'ops', '--env', 'live', '--allow-writes', '--yes')).code).toBe(EXIT.ok);
    expect.soft((await retake('env reset unknown env', 'env', 'reset', 'ops', '--env', 'nowhere')).code).toBe(EXIT.failure);
    expect.soft((await retake('env reset unknown project', 'env', 'reset', 'nope')).code).toBe(EXIT.failure);
  });

  it('sandbox: init (± --force), up (± --no-seed, --build), reset (--reseed), down (--volumes), status (--json), logs', async () => {
    expect.soft((await retake('sandbox init', 'sandbox', 'init', 'fresh')).code).toBe(EXIT.ok);
    expect.soft((await retake('sandbox init again', 'sandbox', 'init', 'fresh')).code).toBe(EXIT.usage);
    expect.soft((await retake('sandbox init --force --json', 'sandbox', 'init', 'fresh', '--force', '--json')).code).toBe(EXIT.ok);
    expect.soft((await retake('sandbox init --env taken', 'sandbox', 'init', 'fresh', '--env', 'local')).code).toBe(EXIT.usage);
    expect.soft((await retake('sandbox status down', 'sandbox', 'status', 'ops')).code).toBe(EXIT.failure);
    expect.soft((await retake('sandbox status --json down', 'sandbox', 'status', 'ops', '--json')).code).toBe(EXIT.failure);
    expect.soft((await retake('sandbox reset not up', 'sandbox', 'reset', 'ops')).code).toBe(EXIT.failure);
    expect.soft((await retake('sandbox up --build on a process sandbox', 'sandbox', 'up', 'ops', '--build')).code).toBe(EXIT.usage);
    expect.soft((await retake('sandbox up --no-seed', 'sandbox', 'up', 'ops', '--no-seed')).code).toBe(EXIT.ok);
    expect.soft((await retake('sandbox up again', 'sandbox', 'up', 'ops')).code).toBe(EXIT.ok);
    expect.soft((await retake('sandbox status up', 'sandbox', 'status', 'ops')).code).toBe(EXIT.ok);
    expect.soft((await retake('sandbox status --json up', 'sandbox', 'status', 'ops', '--json', '--env', 'sandbox')).code).toBe(EXIT.ok);
    expect.soft((await retake('sandbox reset', 'sandbox', 'reset', 'ops')).code).toBe(EXIT.ok);
    expect.soft((await retake('sandbox reset --reseed', 'sandbox', 'reset', 'ops', '--reseed')).code).toBe(EXIT.ok);
    expect.soft((await retake('sandbox logs', 'sandbox', 'logs', 'ops')).code).toBe(EXIT.ok);
    expect.soft((await retake('sandbox logs app --lines 5', 'sandbox', 'logs', 'ops', 'app', '--lines', '5')).code).toBe(EXIT.ok);
    expect.soft((await retake('sandbox logs unknown service', 'sandbox', 'logs', 'ops', 'nope')).code).toBe(EXIT.usage);
    expect.soft((await retake('sandbox logs --lines 0', 'sandbox', 'logs', 'ops', '--lines', '0')).code).toBe(EXIT.usage);
    expect.soft((await retake('sandbox logs --follow on a process sandbox', 'sandbox', 'logs', 'ops', '--follow')).code).toBe(EXIT.usage);
    expect.soft((await retake('sandbox down --volumes on a process sandbox', 'sandbox', 'down', 'ops', '--volumes')).code).toBe(EXIT.usage);
    expect.soft((await retake('sandbox down', 'sandbox', 'down', 'ops')).code).toBe(EXIT.ok);
    expect.soft((await retake('sandbox down again', 'sandbox', 'down', 'ops')).code).toBe(EXIT.ok);
    expect.soft((await retake('sandbox status unknown env', 'sandbox', 'status', 'ops', '--env', 'nowhere')).code).toBe(EXIT.usage);
    expect.soft((await retake('sandbox status no sandbox', 'sandbox', 'status', 'film')).code).toBe(EXIT.failure);
    // The docker-compose sandbox `init` wrote: its own flags pass.
    expect.soft((await retake('sandbox up --build compose', 'sandbox', 'up', 'fresh', '--build')).code).toBe(EXIT.ok);
    expect.soft((await retake('sandbox down --volumes compose', 'sandbox', 'down', 'fresh', '--volumes')).code).toBe(EXIT.ok);
  });

  it('components: list (--json, --kind), validate (built-in, workspace, all, a bad path), create, preview (one, all, --workspace)', async () => {
    expect.soft((await retake('components list', 'components', 'list')).code).toBe(EXIT.ok);
    expect.soft((await retake('components list --json --kind intro', 'components', 'list', '--json', '--kind', 'intro')).code).toBe(EXIT.ok);
    expect.soft((await retake('components validate built-in', 'components', 'validate', 'studio/intro-stack')).code).toBe(EXIT.ok);
    expect.soft((await retake('components validate broken', 'components', 'validate', 'acme/broken')).code).toBe(EXIT.failure);
    expect.soft((await retake('components validate a bad path', 'components', 'validate', join(ws, 'nowhere'))).code).toBe(EXIT.failure);
    expect.soft((await retake('components validate unknown id', 'components', 'validate', 'acme/nope')).code).toBe(EXIT.failure);
    expect.soft((await retake('components create', 'components', 'create', 'acme/badge', '--kind', 'overlay', '--description', 'A small badge in a corner.')).code).toBe(EXIT.ok);
    expect.soft((await retake('components create --json --no-preview', 'components', 'create', 'acme/plain-card', '--kind', 'card', '--no-preview', '--json')).code).toBe(EXIT.ok);
    expect.soft((await retake('components create taken', 'components', 'create', 'acme/badge', '--kind', 'overlay')).code).toBe(EXIT.failure);
    expect.soft((await retake('components create bad id', 'components', 'create', 'Badge', '--kind', 'overlay')).code).toBe(EXIT.failure);
    expect.soft((await retake('components validate workspace folder', 'components', 'validate', join(ws, 'components', 'acme', 'badge'))).code).toBe(EXIT.ok);
    expect.soft((await retake('components validate all --json', 'components', 'validate', '--json')).code).toBe(EXIT.failure);
    expect.soft((await retake('components list after create', 'components', 'list', '--kind', 'overlay')).code).toBe(EXIT.ok);
    expect.soft((await retake('components preview one', 'components', 'preview', 'acme/plain-card')).code).toBe(EXIT.ok);
    expect.soft((await retake('components preview one --json --out', 'components', 'preview', 'acme/badge', '--json', '--out', join(ws, 'one-preview'))).code).toBe(EXIT.ok);
    expect.soft((await retake('components preview --all --workspace', 'components', 'preview', '--all', '--workspace')).code).toBe(EXIT.ok);
    expect.soft((await retake('components preview --all --workspace --stale', 'components', 'preview', '--all', '--workspace', '--stale')).code).toBe(EXIT.ok);
    // Every component and scaffold: into --out only (the built-in library's folders are the repository's).
    expect.soft((await retake('components preview --all --out', 'components', 'preview', '--all', '--out', join(ws, 'all-previews'))).code).toBe(EXIT.ok);
    expect.soft((await retake('components preview nothing named', 'components', 'preview')).code).toBe(EXIT.failure);
    expect.soft((await retake('components preview broken', 'components', 'preview', 'acme/broken')).code).toBe(EXIT.failure);
  });

  it('export-capture: formats, cursor modes, the template note, latest, an unknown run, a dry run', async () => {
    expect.soft((await retake('export-capture', 'export-capture', 'film', RUN)).code).toBe(EXIT.ok);
    expect.soft((await retake('export-capture prores 60 layer webm --selects --no-cuts --json', 'export-capture', 'film', RUN, '--format', 'prores', '--fps', '60', '--cursor', 'layer', '--layer', 'webm', '--selects', '--no-cuts', '--json')).code).toBe(EXIT.ok);
    expect.soft((await retake('export-capture --cursor none --out', 'export-capture', 'film', RUN, '--cursor', 'none', '--out', join(ws, 'raw'), '--no-wait')).code).toBe(EXIT.ok);
    expect.soft((await retake('export-capture --cursor layer', 'export-capture', 'film', RUN, '--cursor', 'layer')).code).toBe(EXIT.ok);
    expect.soft((await retake('export-capture a run whose edit names a file', 'export-capture', 'film', CARDED, '--json')).code).toBe(EXIT.ok);
    expect.soft((await retake('export-capture the template note', 'export-capture', 'film', GHOST)).code).toBe(EXIT.ok);
    expect.soft((await retake('export-capture the template note --json', 'export-capture', 'film', GHOST, '--json')).code).toBe(EXIT.ok);
    expect.soft((await retake('export-capture latest --scenario', 'export-capture', 'film', 'latest', '--scenario', 'signup')).code).toBe(EXIT.ok);
    expect.soft((await retake('export-capture unknown run', 'export-capture', 'film', 'nope')).code).toBe(EXIT.failure);
    expect.soft((await retake('export-capture a dry run', 'export-capture', 'film', DRY)).code).toBe(EXIT.failure);
    expect.soft((await retake('export-capture no timeline', 'export-capture', 'film', BARE)).code).toBe(EXIT.failure);
    expect.soft((await retake('export-capture bad format', 'export-capture', 'film', RUN, '--format', 'avi')).code).toBe(EXIT.usage);
  });

  it('hooks trust (L7.27): no terminal, answered no, --yes, again, no shell hooks, unknown scenario', async () => {
    // trusty: scenarios saved through MCP (an agent's), one with shell hooks and one without.
    const trusty = join(ws, 'projects', 'trusty');
    await mkdir(join(trusty, 'scenarios'), { recursive: true });
    await writeFile(join(trusty, 'project.yaml'), 'name: Trusty\nenvironments:\n  local: {app: "http://app.example.test"}\n');
    const { createEngine } = await import('@retake/engine');
    const agent = await createEngine({ root: ws, client: 'mcp', autoStartWorker: false });
    await agent.scenarios.save('trusty', 'agentmade', scenario('agentmade', 'app', ['vars:', '  file: made.txt', 'setup:', '  - name: make', '    shell: {run: "touch {{vars.file}}", env: {MODE: "{{app}}"}, rollback: "rm -f {{vars.file}}"}']));
    await agent.scenarios.save('trusty', 'plainmade', scenario('plainmade', 'app', []));
    expect.soft((await retake('hooks trust no terminal', 'hooks', 'trust', 'trusty', 'agentmade')).code).toBe(EXIT.failure);
    expect.soft((await retake('hooks trust answered no', 'hooks', 'trust', 'trusty', 'agentmade', { answers: ['n'] })).code).toBe(EXIT.failure);
    expect.soft((await retake('hooks trust --yes', 'hooks', 'trust', 'trusty', 'agentmade', '--yes')).code).toBe(EXIT.ok);
    expect.soft((await retake('hooks trust again', 'hooks', 'trust', 'trusty', 'agentmade')).code).toBe(EXIT.ok);
    expect.soft((await retake('hooks trust no shell hooks', 'hooks', 'trust', 'trusty', 'plainmade')).code).toBe(EXIT.ok);
    expect.soft((await retake('hooks trust unknown scenario', 'hooks', 'trust', 'trusty', 'nope')).code).toBe(EXIT.failure);
  });

  it('the help of each command', async () => {
    for (const cmd of [
      ['plan'],
      ['export-capture'],
      ['hooks', 'run'],
      ['hooks', 'rollback'],
      ['hooks', 'trust'],
      ['env', 'reset'],
      ['sandbox', 'init'],
      ['sandbox', 'up'],
      ['sandbox', 'down'],
      ['sandbox', 'reset'],
      ['sandbox', 'status'],
      ['sandbox', 'logs'],
      ['components', 'list'],
      ['components', 'validate'],
      ['components', 'create'],
      ['components', 'preview'],
    ]) {
      expect.soft((await retake(`${cmd.join(' ')} --help`, ...cmd, '--help')).code).toBe(EXIT.ok);
    }
  });

  it('every case matches the fixture', () => {
    const text = `${JSON.stringify(results, null, 1)}\n`;
    if (process.env.RETAKE_WRITE_SNAPSHOTS === '1') writeFileSync(FILE, text);
    expect(existsSync(FILE), 'no fixture yet: RETAKE_WRITE_SNAPSHOTS=1 on this file').toBe(true);
    const fixture = JSON.parse(readFileSync(FILE, 'utf8')) as Record<string, Case>;
    expect(Object.keys(results)).toEqual(Object.keys(fixture));
    for (const [name, c] of Object.entries(results)) expect(c, name).toEqual(fixture[name]);
  });

  it('the fixture names nothing of this machine: no host name, account, home, temp folder, repository path or Node version', () => {
    const text = readFileSync(FILE, 'utf8');
    const words = [hostname(), userInfo().username, homedir(), tmpdir(), REPO, process.versions.node].filter((w) => w.length >= 3);
    for (const w of words) expect(text.includes(w), `the fixture holds ${JSON.stringify(w)}`).toBe(false);
    expect(text).not.toMatch(/\/(?:Users|home|private|var\/folders)\//);
  });
});
