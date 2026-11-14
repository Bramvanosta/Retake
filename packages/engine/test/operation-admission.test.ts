/**
 * Admission stays inside the submits (L7.15): every operation the catalogue holds to admission rules is an engine
 * operation, and one call of it through `invoke` — an MCP engine for MCP's, a Studio (`ui`) engine for the Studio's —
 * enters the engine's admission exactly once, before its job is queued (a run's checks from inside the submit too, once
 * each and before the job: `prepared` on the scenario it parsed, then `reserve`; never invoke itself), and a call the
 * rule refuses queues nothing. The engine's admission (admission.ts `admission`) is instrumented in place: each check
 * logs the open jobs it finds when it starts.
 */
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { CATALOGUE, OPERATIONS_BY_NAME, invoke } from '@retake/engine/contract';
import type { Shell, ToolDef } from '@retake/engine/contract';
import { synthTimeline } from '@retake/test-support/timeline';
import { hasTool } from '@retake/test-support/repo';
import { writeTake } from '@retake/test-support/take';
import { FileJobQueue, createEngine } from '../src/index.js';
import type { Engine } from '../src/index.js';
import type { Admission, AdmissionDeps } from '../src/admission.js';
import { fixtureWorkspace } from '@retake/test-support/workspace';
import { scratchHome } from '@retake/test-support/home';

/** What the instrumented admission saw, in order: a check entered (with the open jobs then), a run's reserve, a submit. */
const seen = vi.hoisted(() => [] as Array<{ step: 'admit' | 'prepared' | 'reserve' | 'submit'; kind: string; open: number }>);

vi.mock('../src/admission.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/admission.js')>();
  return {
    ...actual,
    admission(d: AdmissionDeps): Admission {
      const a = actual.admission(d);
      const open = async () => (await d.queue.list({ states: ['queued', 'running'] })).length;
      const log = async (step: 'admit' | 'prepared' | 'reserve' | 'submit', kind: string) => {
        seen.push({ step, kind, open: await open() });
      };
      return {
        run: async (req, submit) => {
          await log('admit', 'run');
          return a.run(req, (admit) =>
            submit({
              prepared: async (take) => {
                await log('prepared', 'run');
                return admit.prepared(take);
              },
              reserve: async (queue) => {
                await log('reserve', 'run');
                return admit.reserve(queue);
              },
            }).then(async (r) => (await log('submit', 'run'), r)),
          );
        },
        render: async (req, submit) => {
          await log('admit', 'render');
          return a.render(req, () => submit().then(async (r) => (await log('submit', 'render'), r)));
        },
        export: async (req, submit) => {
          await log('admit', 'export');
          return a.export(req, (recheck) => submit(recheck).then(async (r) => (await log('submit', 'export'), r)));
        },
      };
    },
  };
});

const P = 'northfield-fixture';
const D = 'demo';
const TAKE = '20260101-120000-tl';
const TEXT = 'video: Timeline\nintro: false\noutro: false\nscenes:\n  - id: a\n    page: app\n    open: /\n    steps:\n      - hold: 1\n';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const canRun = hasTool('ffmpeg') && hasTool('ffprobe');
const signal = new AbortController().signal;
const retakeHome = scratchHome();

/** One call per admitted operation: its shell, and arguments that queue a job on a quiet queue. */
const CASES: Record<string, { shell: Shell; args: Record<string, unknown>; kind: 'run' | 'render' | 'export' }> = {
  run_dry: { shell: 'mcp', args: { project: P, scenario: 'one-a', wait_s: 0 }, kind: 'run' },
  run_capture: { shell: 'mcp', args: { project: P, scenario: 'one-a' }, kind: 'run' },
  render: { shell: 'mcp', args: { project: D, scenario: 'tl' }, kind: 'render' },
  export: { shell: 'mcp', args: { project: D, render_id: 'tl-v7', formats: ['mp4_1080p'] }, kind: 'export' },
  scenario_run: { shell: 'studio', args: { project: P, name: 'one-a', mode: 'capture' }, kind: 'run' },
  scenario_render: { shell: 'studio', args: { project: D, name: 'tl', run: TAKE, expect_edit_sha256: sha(TEXT) }, kind: 'render' },
  review_export: { shell: 'studio', args: { project: D, render_id: 'tl-v7' }, kind: 'export' },
};

let ws: string;
let queue: FileJobQueue;
const engines = {} as Record<'mcp' | 'ui', Engine>;

beforeAll(async () => {
  if (!canRun) return;
  ws = await mkdtemp(join(tmpdir(), 'engine-op-admission-'));
  retakeHome.use(join(ws, '.home'));
  await fixtureWorkspace(ws);
  await writeFile(join(ws, 'projects', P, 'scenarios', 'one-a.yaml'), 'video: one-a\nscenes:\n  - id: a\n    page: console\n    open: /\n    steps:\n      - hold: 1\n');
  const dir = join(ws, 'projects', D);
  await mkdir(join(dir, 'scenarios'), { recursive: true });
  await writeFile(join(dir, 'project.yaml'), 'version: 1\nname: Demo\nenvironments:\n  local: {app: "http://app.test"}\ntemplate: editorial\n');
  const t = synthTimeline({
    duration: 3,
    entries: [{ id: 'a', t_start: 0.5, t_end: 2.5, steps: [{ action: 'hold', t_start: 0.5, t_end: 2.5 }] }],
    video: { intro: false, outro: false, template: 'editorial' },
  });
  await writeTake(dir, 'tl', { run: TAKE, text: TEXT, timeline: t, codec: 'h264-x264', seconds: 3 });
  await mkdir(join(dir, 'renders'), { recursive: true });
  await writeFile(join(dir, 'renders', 'tl-v7.mp4'), 'video');
  await writeFile(
    join(dir, 'renders', 'tl-v7.json'),
    JSON.stringify({
      version: 1,
      id: 'tl-v7',
      project: D,
      scenario: 'tl',
      run_id: TAKE,
      run_dir: join(dir, 'runs', TAKE),
      template: 'editorial',
      overrides: {},
      edit: { from: 'scenario', sha256: sha(TEXT) },
      variant: 'landscape',
      status: 'succeeded',
      file: join(dir, 'renders', 'tl-v7.mp4'),
      record: join(dir, 'renders', 'tl-v7.json'),
      render_version: 7,
      created_at: '2026-01-02T10:00:00.000Z',
      finished_at: '2026-01-02T10:00:00.000Z',
      duration_s: 3,
      frames: 90,
      fps: 30,
      width: 1920,
      height: 1080,
      size_bytes: 1234,
      plan: {},
      warnings: [],
    }),
  );
  for (const client of ['mcp', 'ui'] as const) engines[client] = await createEngine({ root: ws, client, autoStartWorker: false });
  queue = new FileJobQueue(ws);
}, 60_000);

afterEach(async () => {
  if (!queue) return;
  for (const j of await queue.list({ states: ['queued', 'running'], limit: 200 })) await queue.cancel(j.id, 'test');
  seen.length = 0;
});

afterAll(async () => {
  retakeHome.restore();
  if (ws) await rm(ws, { recursive: true, force: true });
});

describe.skipIf(!canRun)('admission stays inside the submits: once per call, before the job (L7.15)', () => {
  it('every operation the catalogue holds to admission rules is an engine operation, with a case here', () => {
    const admitted = CATALOGUE.filter((o) => o.admission?.length).map((o) => o.name);
    expect([...admitted].sort()).toEqual(Object.keys(CASES).sort());
    for (const n of admitted) expect(OPERATIONS_BY_NAME[n as keyof typeof OPERATIONS_BY_NAME], n).toBeDefined();
  });

  for (const [name, c] of Object.entries(CASES)) {
    it(`${name}: one check of its rules before its job is queued; refused the second time, nothing queued`, async () => {
      const op = OPERATIONS_BY_NAME[name as keyof typeof OPERATIONS_BY_NAME] as unknown as ToolDef;
      const engine = engines[c.shell === 'mcp' ? 'mcp' : 'ui'];
      const before = (await queue.list({ states: ['queued', 'running'] })).length;
      const r = await invoke(op, engine, c.args, { shell: c.shell, signal });
      expect(r.ok, JSON.stringify(!r.ok && r.error)).toBe(true);
      const steps = seen.map((s) => `${s.step} ${s.kind} ${s.open - before}`);
      // The check, (a run's checks on the scenario it parsed — sessions_ack of a capture — and again just before its id
      // is reserved), then the job: one more open job only then.
      expect(steps).toEqual(c.kind === 'run' ? ['admit run 0', 'prepared run 0', 'reserve run 0', 'submit run 1'] : [`admit ${c.kind} 0`, `submit ${c.kind} 1`]);
      seen.length = 0;
      // The same call again: the rule finds the first one's job, nothing more is queued.
      const again = await invoke(op, engine, c.args, { shell: c.shell, signal });
      expect(!again.ok && again.error.code).toBe('conflict');
      expect(seen.map((s) => `${s.step} ${s.kind} ${s.open - before}`)).toEqual([`admit ${c.kind} 1`]);
      expect((await queue.list({ states: ['queued', 'running'] })).length).toBe(before + 1);
    });
  }
});
