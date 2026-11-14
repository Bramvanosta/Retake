/**
 * L5.14b: captures first through MCP — a render a filming take holds is said in words and an enum (`yield`) by
 * job_status, job_list, render_status and engine_info (`held`), and nothing of the workspace where the take films is
 * ever named (its path, slug, scenario, run or job id).
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FileJobQueue, FilmingMarker, createEngine, selfIdentity } from '@retake/engine';
import type { Engine, JobRecord } from '@retake/engine';
import { TOOLS } from '../src/index.js';
import type { ToolDef, ToolOutput } from '../src/index.js';
import { fixtureWorkspace } from '@retake/test-support/workspace';
import { scratchHome } from '@retake/test-support/home';

let root: string;
let other: string;
let engine: Engine;
let queue: FileJobQueue;
const retakeHome = scratchHome();

/** One tool by its name, called with loose arguments: its answer's data as a plain record (each test reads the keys it expects). */
const tool = (name: string, args: Record<string, unknown>) => {
  const t: ToolDef = TOOLS.find((x) => x.name === name)!;
  return t.run(args, { engine, signal: new AbortController().signal }) as Promise<ToolOutput<Record<string, unknown>>>;
};

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'retake-mcp-captures-'));
  other = await mkdtemp(join(tmpdir(), 'retake-mcp-captures-secret-ws-'));
  retakeHome.use(join(root, '.home'));
  await fixtureWorkspace(root);
  engine = await createEngine({ root, client: 'mcp', autoStartWorker: false });
  queue = new FileJobQueue(root);
});

afterAll(async () => {
  retakeHome.restore();
  for (const d of [root, other]) if (d) await rm(d, { recursive: true, force: true });
});

describe('captures first through MCP (L5.14b)', () => {
  it("waiting, then slowed: words and an enum, never another workspace's names", async () => {
    const job = await queue.enqueue({
      version: 1,
      kind: 'render',
      project: 'northfield-fixture',
      scenario: 'quote',
      run_id: '20261104-120000-quote',
      render_id: 'quote-v1',
      timeline_sha256: 'a'.repeat(64),
      overrides: {},
      submitted_by: 'mcp',
    } as never);
    const quiet = await tool('engine_info', {});
    expect(quiet.data.held).toBeNull();
    const m = FilmingMarker.open({ env: process.env, root: other, source: 'job', owner: await selfIdentity() })!;
    try {
      const st = await tool('job_status', { job_id: job.id });
      expect((st.data as { yield?: unknown }).yield).toEqual({ state: 'waiting', cause: 'elsewhere' });
      expect(st.summary).toContain(': queued · waiting for a take to finish (elsewhere on this Mac)');
      const list = await tool('job_list', { project: 'northfield-fixture' });
      expect(list.summary).toContain('waiting for a take to finish (elsewhere on this Mac)');
      const rs = await tool('render_status', { project: 'northfield-fixture', render_id: 'quote-v1' });
      expect(rs.summary).toContain('queued: waiting for a take to finish (elsewhere on this Mac)');
      const info = await tool('engine_info', {});
      expect(info.data.held).toEqual({ state: 'waiting', cause: 'elsewhere', kind: 'render', count: 1 });
      expect(info.summary).toContain('Captures first: a render waits for a take to finish (elsewhere on this Mac).');

      // Running at background priority (its worker's yield.json).
      const me = { ...(await selfIdentity()), host: hostname() };
      const rec = (await queue.stored(job.id))!;
      await queue.write({
        ...rec,
        state: 'running',
        started_at: new Date().toISOString(),
        worker: me,
        supervisor: me,
        progress: { phase: 'rendering', fraction: 0.25, steps_done: 0, steps_total: 0 },
      } as JobRecord);
      await writeFile(queue.files.yield(job.id), JSON.stringify({ v: 1, state: 'background', since: '2026-11-04T14:02:00.000Z', cause: 'elsewhere' }));
      const run = await tool('job_status', { job_id: job.id });
      expect((run.data as { yield?: unknown }).yield).toEqual({ state: 'background', cause: 'elsewhere', since: '2026-11-04T14:02:00.000Z' });
      expect(run.summary).toContain(': running · slowed during a take (elsewhere on this Mac) · 25 %');
      const rr = await tool('render_status', { project: 'northfield-fixture', render_id: 'quote-v1' });
      expect(rr.summary).toContain('running: rendering 25 % · slowed during a take (elsewhere on this Mac)');
      const info2 = await tool('engine_info', {});
      expect(info2.summary).toContain('Captures first: a render is slowed during a take (elsewhere on this Mac).');
      // Nothing of the other workspace, in any answer.
      for (const r of [st, list, rs, info, run, rr, info2]) {
        const text = JSON.stringify(r);
        expect(text).not.toContain(other);
        expect(text).not.toContain('secret-ws');
      }
      await queue.write({ ...rec, state: 'cancelled', finished_at: new Date().toISOString() } as JobRecord);
    } finally {
      m.closeSync();
    }
  });
});
