/**
 * The Outputs port (outputs/outputs.ts), its run folders: one contract on the disk's adapter and the memory's, what only
 * the disk has (a link), and the engine on the memory's — a run submitted, filmed by the in-memory runner and listed
 * with no run folder on the disk.
 */
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { MemoryOutputs, createEngine, diskOutputs, runWorker, runsDirOf } from '../src/index.js';
import { MemoryCaptureRunner } from '../src/capture/memory-capture.js';
import { MemoryHookRunner } from '../src/hook-run/memory-hooks.js';
import { fixtureWorkspace } from '@retake/test-support/workspace';
import { outputsContract } from './outputs-contract.js';

const temp = await realpath(await mkdtemp(join(tmpdir(), 'retake-outputs-')));
afterAll(() => rm(temp, { recursive: true, force: true }));

let disks = 0;
outputsContract('disk', async () => {
  const root = join(temp, `disk-${++disks}`);
  await mkdir(root, { recursive: true });
  return {
    outputs: diskOutputs,
    root,
    seed: async (path, data) => {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, data);
    },
    folder: async (path) => void (await mkdir(path, { recursive: true })),
  };
});

outputsContract('memory', async () => {
  const m = new MemoryOutputs();
  return { outputs: m, root: '/memory/ws', seed: async (path, data) => void m.seed(path, data), folder: async (path) => void m.folder(path) };
});

describe('what only the disk has: a link', () => {
  it('a runs/ linked out of the project holds no run folder that lies in it, and a listing does not follow a linked run folder', async () => {
    const project = join(temp, 'linked');
    const elsewhere = join(temp, 'elsewhere');
    await mkdir(join(elsewhere, '20261114-093000-quote'), { recursive: true });
    await mkdir(project, { recursive: true });
    await symlink(elsewhere, runsDirOf(project));
    expect(await diskOutputs.runs.inside(project, '20261114-093000-quote')).toBe(false);
    const own = join(temp, 'own');
    await mkdir(runsDirOf(own), { recursive: true });
    await symlink(join(elsewhere, '20261114-093000-quote'), join(runsDirOf(own), '20261114-093000-quote'));
    expect(await diskOutputs.runs.ids(runsDirOf(own))).toEqual([]);
    expect(await diskOutputs.runs.folder(runsDirOf(own), '20261114-093000-quote')).toMatchObject({ folder: 'link' });
  });
});

describe('the engine on the memory outputs', () => {
  it('a run job reserves, films and finishes its run folder in memory: the run list and its status read it there (not the run folders on the disk), and none is made on the disk', async () => {
    const ws = join(temp, 'ws');
    await mkdir(ws, { recursive: true });
    await fixtureWorkspace(ws);
    const project = join(ws, 'projects', 'northfield-fixture');
    const outputs = new MemoryOutputs();
    const engine = await createEngine({ root: ws, client: 'mcp', autoStartWorker: false, ports: { outputs } });
    const sub = await engine.runs.submit({ project: 'northfield-fixture', scenario: 'quote', mode: 'dry', until: 'discover.1' });
    // Reserved at submit, in memory: the queued record is listed.
    expect(outputs.paths()).toEqual([join(runsDirOf(project), sub.run_id, 'run.json')]);
    expect((await engine.runs.list('northfield-fixture')).map((r) => [r.id, r.status])).toEqual([[sub.run_id, 'queued']]);
    const capture = new MemoryCaptureRunner();
    await runWorker({ root: ws, once: true, idleExitMs: 0, pollMs: 50, log: () => undefined, heavyInProcess: true, ports: { capture, hooks: new MemoryHookRunner(), outputs } });
    const job = await engine.jobs.get(sub.job.id);
    expect(job.state, JSON.stringify(job.error)).toBe('succeeded');
    const status = await engine.runs.status('northfield-fixture', sub.run_id);
    expect(status).toMatchObject({ id: sub.run_id, status: 'succeeded', mode: 'dry', steps_done: 2, steps_total: 2, finished: true });
    expect(status.outputs.map((o) => o.ref)).toEqual([`runs/${sub.run_id}/run.json`, `runs/${sub.run_id}/timeline.json`]);
    expect(status.outputs[1]!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect((await engine.runs.list('northfield-fixture')).map((r) => [r.id, r.status])).toEqual([[sub.run_id, 'succeeded']]);
    expect(outputs.paths()).toEqual(['run.json', 'scenario.yaml', 'timeline.json'].map((f) => join(runsDirOf(project), sub.run_id, f)));
    // The fixture's run folders on the disk are not the engine's: none is listed, and the new one is not there.
    expect(existsSync(join(runsDirOf(project), sub.run_id))).toBe(false);
  });
});
