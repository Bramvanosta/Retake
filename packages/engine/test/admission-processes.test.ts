/**
 * The admission rules across processes (L7.26, U15 — finding P9): two processes on one workspace — an MCP server's
 * engine and the Studio's — submit at once, and a rule passes once. Each check and its submit hold the job queue's lock
 * of the rule's key (JobQueue `exclusive`: a lock file of the workspace), so of two runs of one scenario, two renders of
 * one scenario or two exports of one render submitted at the same moment by two processes, exactly one job is queued
 * and the other call is refused `conflict` naming it, as one process's second call is. A run's loser reserves no run
 * folder. The processes are real (test/fixtures/admission-submitter.mts), released together after a barrier.
 */
import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RunJobInput } from '@retake/engine';
import { synthTimeline } from '../../editor/test/helpers.js';
import { hasTool } from '../../editor/test/render-helpers.js';
import { writeTake } from '../../ui/test/timeline-take.js';
import { FileJobQueue } from '../src/index.js';
import { fixtureWorkspace } from './helpers.js';

const REPO = resolve(import.meta.dirname, '../../..');
const SUBMITTER = join(REPO, 'packages', 'engine', 'test', 'fixtures', 'admission-submitter.mts');
const P = 'northfield-fixture';
const D = 'demo';
const TAKE = '20260101-120000-tl';
const TEXT = 'video: Timeline\nintro: false\noutro: false\nscenes:\n  - id: a\n    page: app\n    open: /\n    steps:\n      - hold: 1\n';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const canRender = hasTool('ffmpeg') && hasTool('ffprobe');
const savedHome = process.env.RETAKE_HOME;
const ROUNDS = 4;

type Answer = { ok: true; job: string } | { ok: false; code: string; message: string; details?: { job?: string; run_id?: string } };

/** A submitter process: its answers in order. */
interface Submitter {
  child: ChildProcessWithoutNullStreams;
  next(): Promise<Answer | 'ready'>;
}

function submitter(root: string, client: 'mcp' | 'ui'): Submitter {
  const child = spawn(process.execPath, ['--conditions=source', '--import', 'tsx', SUBMITTER, root, client], { cwd: REPO, stdio: ['pipe', 'pipe', 'pipe'] });
  let err = '';
  child.stderr.on('data', (d: Buffer) => (err += d.toString()));
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  return {
    child,
    next: async () => {
      const r = await lines.next();
      if (r.done) throw new Error(`the ${client} submitter ended: ${err}`);
      return JSON.parse(r.value) as Answer | 'ready';
    },
  };
}

let ws: string;
let queue: FileJobQueue;
let mcp: Submitter;
let ui: Submitter;

/** Both processes get the same request in the same tick (the barrier: each waits on its stdin); their answers. */
async function race(op: 'run' | 'render' | 'export', req: Record<string, unknown>, first: Submitter, second: Submitter): Promise<Answer[]> {
  const line = `${JSON.stringify({ op, req })}\n`;
  first.child.stdin.write(line);
  second.child.stdin.write(line);
  return (await Promise.all([first.next(), second.next()])) as Answer[];
}

const open = async () => (await queue.list({ states: ['queued', 'running'], limit: 200 })).map((j) => j.id).sort();
const cancelAll = async () => {
  for (const id of await open()) await queue.cancel(id, 'test');
};

/** One answer queued a job, the other is `conflict` naming that job; that job is the only one queued since `before`. */
async function expectOneQueued(answers: Answer[], before: string[], what: string): Promise<string> {
  const won = answers.filter((a): a is Extract<Answer, { ok: true }> => a.ok);
  const lost = answers.filter((a): a is Extract<Answer, { ok: false }> => !a.ok);
  expect(won, `${what}: ${JSON.stringify(answers)}`).toHaveLength(1);
  expect(lost[0], what).toMatchObject({ code: 'conflict', details: { job: won[0]!.job } });
  expect((await open()).filter((id) => !before.includes(id)), what).toEqual([won[0]!.job]);
  return won[0]!.job;
}

beforeAll(async () => {
  ws = await mkdtemp(join(tmpdir(), 'engine-admission-processes-'));
  process.env.RETAKE_HOME = join(ws, '.home');
  await fixtureWorkspace(ws);
  for (let i = 0; i < ROUNDS; i++) {
    await writeFile(join(ws, 'projects', P, 'scenarios', `race-${i}.yaml`), `video: race-${i}\nscenes:\n  - id: a\n    page: console\n    open: /\n    steps:\n      - hold: 1\n`);
  }
  if (canRender) {
    const dir = join(ws, 'projects', D);
    await mkdir(join(dir, 'scenarios'), { recursive: true });
    await writeFile(join(dir, 'project.yaml'), 'version: 1\nname: Demo\nenvironments:\n  local: {app: "http://app.test"}\ntemplate: editorial\n');
    const t = synthTimeline({ duration: 3, entries: [{ id: 'a', t_start: 0.5, t_end: 2.5, steps: [{ action: 'hold', t_start: 0.5, t_end: 2.5 }] }], video: { intro: false, outro: false, template: 'editorial' } });
    await writeTake(dir, 'tl', { run: TAKE, text: TEXT, timeline: t, codec: 'h264-x264', seconds: 3 });
    await mkdir(join(dir, 'renders'), { recursive: true });
    await writeFile(join(dir, 'renders', 'tl-v7.mp4'), 'video');
    await writeFile(
      join(dir, 'renders', 'tl-v7.json'),
      JSON.stringify({
        version: 1, id: 'tl-v7', project: D, scenario: 'tl', run_id: TAKE, run_dir: join(dir, 'runs', TAKE), template: 'editorial', overrides: {}, edit: { from: 'scenario', sha256: sha(TEXT) }, variant: 'landscape', status: 'succeeded',
        file: join(dir, 'renders', 'tl-v7.mp4'), record: join(dir, 'renders', 'tl-v7.json'), render_version: 7, created_at: '2026-01-02T10:00:00.000Z', finished_at: '2026-01-02T10:00:00.000Z', duration_s: 3, frames: 90, fps: 30, width: 1920, height: 1080, size_bytes: 1234, plan: {}, warnings: [],
      }),
    );
  }
  queue = new FileJobQueue(ws);
  mcp = submitter(ws, 'mcp');
  ui = submitter(ws, 'ui');
  expect(await mcp.next()).toBe('ready');
  expect(await ui.next()).toBe('ready');
}, 120_000);

afterAll(async () => {
  for (const s of [mcp, ui]) s?.child.kill();
  if (savedHome === undefined) delete process.env.RETAKE_HOME;
  else process.env.RETAKE_HOME = savedHome;
  if (ws) await rm(ws, { recursive: true, force: true });
});

describe('the admission rules hold across processes: two processes submitting at once queue one job (L7.26)', () => {
  it('one_run_per_scenario: an MCP server and the Studio start a run of one scenario at the same moment — one run queued, the other refused naming it, no run folder for it', async () => {
    const runs = join(ws, 'projects', P, 'runs');
    for (let i = 0; i < ROUNDS; i++) {
      const before = await open();
      const folders = new Set(await readdir(runs).catch(() => [] as string[]));
      const [a, b] = i % 2 ? [ui, mcp] : [mcp, ui];
      const answers = await race('run', { project: P, scenario: `race-${i}`, mode: 'dry' }, a, b);
      const job = await expectOneQueued(answers, before, `round ${i}`);
      const input = (await queue.get(job))!.input as RunJobInput;
      const lost = answers.find((x) => !x.ok) as Extract<Answer, { ok: false }>;
      expect(lost.details?.run_id).toBe(input.run_id);
      // The loser reserved no run folder: one new folder, the winner's.
      expect((await readdir(runs)).filter((d) => !folders.has(d))).toEqual([input.run_id]);
      await cancelAll();
    }
  }, 120_000);

  it.skipIf(!canRender)('one_render_per_scenario: two processes render one scenario at the same moment — one render queued, the other refused naming it', async () => {
    for (let i = 0; i < 2; i++) {
      const before = await open();
      const [a, b] = i % 2 ? [ui, mcp] : [mcp, ui];
      await expectOneQueued(await race('render', { project: D, scenario: 'tl', run_id: TAKE }, a, b), before, `round ${i}`);
      await cancelAll();
    }
  }, 120_000);

  it.skipIf(!canRender)('export_cap: two processes export one render at the same moment — one export queued, the other refused naming it', async () => {
    for (let i = 0; i < 2; i++) {
      const before = await open();
      const [a, b] = i % 2 ? [ui, mcp] : [mcp, ui];
      await expectOneQueued(await race('export', { project: D, render_id: 'tl-v7', formats: ['mp4_1080p'] }, a, b), before, `round ${i}`);
      await cancelAll();
    }
  }, 120_000);
});
