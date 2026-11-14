/**
 * The Outputs port (outputs/outputs.ts), its run folders: one contract on the disk's adapter and the memory's, what only
 * the disk has (a link), and the engine on the memory's — a run submitted, filmed by the in-memory runner and listed
 * with no run folder on the disk.
 */
import { createHash } from 'node:crypto';
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
  return {
    outputs: m,
    root: '/memory/ws',
    seed: async (path, data) => void m.seed(path, data),
    folder: async (path) => void m.folder(path),
  };
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
  it('describes a link that leaves the run folder as a refused link (no size, no sha256), and follows one that stays in it', async () => {
    const runsDir = runsDirOf(join(temp, 'described'));
    const dir = join(runsDir, '20261114-093000-quote');
    await mkdir(dir, { recursive: true });
    const secret = join(temp, 'outside.bin');
    await writeFile(secret, 'bytes outside the run folder');
    await writeFile(join(dir, 'timeline.json'), '{}');
    await symlink(secret, join(dir, 'capture.mp4'));
    await symlink(join(dir, 'timeline.json'), join(dir, 'log.jsonl'));
    await symlink(join(dir, 'nowhere'), join(dir, 'run.json'));
    await symlink('..', join(dir, 'up'));
    expect(await diskOutputs.runs.describe(dir, 'capture.mp4', { hash: true })).toEqual({ link: 'refused' });
    expect(await diskOutputs.runs.describe(dir, 'run.json', { hash: true }), 'a link that leads nowhere').toEqual({ link: 'refused' });
    expect(await diskOutputs.runs.describe(dir, 'up'), 'a link to the folder above').toEqual({ link: 'refused' });
    expect(await diskOutputs.runs.describe(dir, 'log.jsonl', { hash: true })).toEqual({
      bytes: 2,
      sha256: createHash('sha256').update('{}').digest('hex'),
    });
  });

  it('run_status shows a run file linked out of the run folder as a refused link, with no size and no sha256', async () => {
    const ws = join(temp, 'ws-link');
    await mkdir(ws, { recursive: true });
    await fixtureWorkspace(ws);
    const project = join(ws, 'projects', 'northfield-fixture');
    const engine = await createEngine({
      root: ws,
      client: 'mcp',
      autoStartWorker: false,
    });
    const sub = await engine.runs.submit({
      project: 'northfield-fixture',
      scenario: 'quote',
      mode: 'dry',
      until: 'discover.1',
    });
    const dir = join(runsDirOf(project), sub.run_id);
    const secret = join(temp, 'outside-status.bin');
    await writeFile(secret, 'not the run');
    await symlink(secret, join(dir, 'log.jsonl'));
    const status = await engine.runs.status('northfield-fixture', sub.run_id);
    const log = status.outputs.find((o) => o.ref === `runs/${sub.run_id}/log.jsonl`);
    expect(log).toEqual({
      ref: `runs/${sub.run_id}/log.jsonl`,
      path: join(dir, 'log.jsonl'),
      kind: 'run',
      link: 'refused',
    });
  });

  it('run_status reads no run folder that is a link out of runs/: neither its record nor its files', async () => {
    const ws = join(temp, 'ws-linked-run');
    await mkdir(ws, { recursive: true });
    await fixtureWorkspace(ws);
    const project = join(ws, 'projects', 'northfield-fixture');
    const outside = join(temp, 'outside-run');
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, 'run.json'), JSON.stringify({ id: 'handmade', status: 'succeeded' }));
    await writeFile(join(outside, 'capture.mp4'), 'not a take of the project');
    await mkdir(runsDirOf(project), { recursive: true });
    await symlink(outside, join(runsDirOf(project), 'handmade'));
    const engine = await createEngine({ root: ws, client: 'mcp', autoStartWorker: false });
    await expect(engine.runs.status('northfield-fixture', 'handmade')).rejects.toThrow(/a link out of it is not read/);
    await expect(engine.runs.status('northfield-fixture', 'nothing-here')).rejects.toThrow(/not found/);
  });
});

describe('the engine on the memory outputs', () => {
  it('a run job reserves, films and finishes its run folder in memory: the run list and its status read it there (not the run folders on the disk), and none is made on the disk', async () => {
    const ws = join(temp, 'ws');
    await mkdir(ws, { recursive: true });
    await fixtureWorkspace(ws);
    const project = join(ws, 'projects', 'northfield-fixture');
    const outputs = new MemoryOutputs();
    const engine = await createEngine({
      root: ws,
      client: 'mcp',
      autoStartWorker: false,
      ports: { outputs },
    });
    const sub = await engine.runs.submit({
      project: 'northfield-fixture',
      scenario: 'quote',
      mode: 'dry',
      until: 'discover.1',
    });
    // Reserved at submit, in memory: the queued record is listed.
    expect(outputs.paths()).toEqual([join(runsDirOf(project), sub.run_id, 'run.json')]);
    expect((await engine.runs.list('northfield-fixture')).map((r) => [r.id, r.status])).toEqual([[sub.run_id, 'queued']]);
    const capture = new MemoryCaptureRunner();
    await runWorker({
      root: ws,
      once: true,
      idleExitMs: 0,
      pollMs: 50,
      log: () => undefined,
      heavyInProcess: true,
      ports: { capture, hooks: new MemoryHookRunner(), outputs },
    });
    const job = await engine.jobs.get(sub.job.id);
    expect(job.state, JSON.stringify(job.error)).toBe('succeeded');
    const status = await engine.runs.status('northfield-fixture', sub.run_id);
    expect(status).toMatchObject({
      id: sub.run_id,
      status: 'succeeded',
      mode: 'dry',
      steps_done: 2,
      steps_total: 2,
      finished: true,
    });
    expect(status.outputs.map((o) => o.ref)).toEqual([`runs/${sub.run_id}/run.json`, `runs/${sub.run_id}/timeline.json`]);
    expect(status.outputs[1]!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect((await engine.runs.list('northfield-fixture')).map((r) => [r.id, r.status])).toEqual([[sub.run_id, 'succeeded']]);
    expect(outputs.paths()).toEqual(['run.json', 'scenario.yaml', 'timeline.json'].map((f) => join(runsDirOf(project), sub.run_id, f)));
    // The fixture's run folders on the disk are not the engine's: none is listed, and the new one is not there.
    expect(existsSync(join(runsDirOf(project), sub.run_id))).toBe(false);
  });
});
