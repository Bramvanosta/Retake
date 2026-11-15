/**
 * The Outputs port (outputs/outputs.ts), its run folders: one contract on the disk's adapter and the memory's, what only
 * the disk has (a link), and the engine on the memory's — a run submitted, filmed by the in-memory runner and listed
 * with no run folder on the disk.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { link, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { MemoryOutputs } from '../src/outputs/memory-outputs.js';
import { createEngine } from '../src/index.js';
import { diskOutputs } from '../src/outputs/disk-outputs.js';
import { pruneInspections } from '../src/jobs/inspect-job.js';
import { runWorker } from '../src/jobs/worker.js';
import { runsDirOf } from '../src/outputs/outputs.js';
import type { LoadedProject } from '@retake/core/model';
import { MemoryCaptureRunner } from '../src/capture/memory-capture.js';
import { MemoryHookRunner } from '../src/hook-run/memory-hooks.js';
import { fixtureWorkspace } from '@retake/test-support/workspace';
import { outputsContract } from './outputs-contract.js';
import { nodeOutputFs } from '../src/outputs/disk-outputs.js';
import { outputsOn } from '../src/outputs/output-files.js';
import type { OutputFs } from '../src/outputs/output-files.js';

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
  it('a plain read never follows a link, and refuses a file of another name when asked; what a folder holds is judged once links are followed', async () => {
    const project = join(temp, 'plain-links');
    const review = join(project, 'review', 'quote-v1');
    const away = join(temp, 'plain-away');
    await mkdir(join(review, 'keyframes'), { recursive: true });
    await mkdir(join(review, '..x'), { recursive: true });
    await mkdir(away, { recursive: true });
    await writeFile(join(away, 'secret.jpg'), 'secret');
    await writeFile(join(review, 'sheet.jpg'), 'sheet');
    await symlink(join(away, 'secret.jpg'), join(review, 'linked.jpg'));
    await link(join(away, 'secret.jpg'), join(review, 'hard.jpg'));
    await symlink(away, join(review, 'out'));
    await writeFile(join(review, '..x', 'in.jpg'), 'in');
    await symlink(join(review, 'sheet.jpg'), join(review, 'keyframes', 'in.png'));
    const reviews = diskOutputs.reviews;
    expect(await reviews.readPlain(join(review, 'sheet.jpg'), { max: 10, oneName: true })).toMatchObject({ ok: true });
    expect(await reviews.readPlain(join(review, 'linked.jpg'), { max: 10 })).toEqual({ ok: false, reason: 'link' });
    // A hard link is read as the file it is, unless asked for one name only.
    const hard = await reviews.readPlain(join(review, 'hard.jpg'), { max: 10 });
    expect(hard.ok && Buffer.from(hard.bytes).toString('utf8')).toBe('secret');
    expect(await reviews.readPlain(join(review, 'hard.jpg'), { max: 10, oneName: true })).toEqual({ ok: false, reason: 'link' });
    // Held: the folder's own files and links within it (a name that begins with `..` too); not a link out, nor what lies under it.
    expect(await reviews.holds(review, join(review, 'sheet.jpg'))).toBe(true);
    expect(await reviews.holds(review, join(review, '..x', 'in.jpg'))).toBe(true);
    expect(await reviews.holds(join(review, 'keyframes'), join(review, 'keyframes', 'in.png'))).toBe(false);
    expect(await reviews.holds(review, join(review, 'keyframes', 'in.png'))).toBe(true);
    expect(await reviews.holds(review, join(review, 'linked.jpg'))).toBe(false);
    expect(await reviews.holds(review, join(review, 'out'))).toBe(false);
    expect(await reviews.holds(review, join(review, 'out', 'never.jpg'))).toBe(false);
    expect(await reviews.holds(project, review)).toBe(true);
  });

  it('a folder made is checked again once made: a .retake/inspect swapped for a link out between the look and the mkdir is refused', async () => {
    const project = join(temp, 'swapped-inspect');
    const elsewhere = join(temp, 'swapped-elsewhere');
    await mkdir(join(project, '.retake', 'inspect'), { recursive: true });
    await mkdir(elsewhere, { recursive: true });
    const root = join(project, '.retake', 'inspect');
    const swapping: OutputFs = {
      ...nodeOutputFs,
      mkdir: async (path, opts) => {
        await rm(root, { recursive: true });
        await symlink(elsewhere, root);
        return nodeOutputFs.mkdir(path, opts);
      },
    };
    const inspections = outputsOn(swapping).inspections;
    expect(
      await inspections.makeFolder(join(root, 'i_x'), project).then(
        () => 'made',
        (e: { code?: string }) => e.code,
      ),
    ).toBe('refused');
  });

  it('an inspection never writes or prunes through a .retake/inspect linked out of the project: refused, nothing made or removed there', async () => {
    const project = join(temp, 'linked-inspect');
    const elsewhere = join(temp, 'inspect-elsewhere');
    const ids = Array.from({ length: 25 }, (_, i) => `i_${String(i).padStart(26, '0')}`);
    for (const id of ids) await mkdir(join(elsewhere, id), { recursive: true });
    await mkdir(join(project, '.retake'), { recursive: true });
    const root = diskOutputs.inspections.dirOf(project);
    await symlink(elsewhere, root);
    const fresh = `i_${'Z'.repeat(26)}`;
    expect(
      await diskOutputs.inspections.makeFolder(join(root, fresh), project).then(
        () => 'made',
        (e: { code?: string }) => e.code,
      ),
    ).toBe('refused');
    expect(existsSync(join(elsewhere, fresh))).toBe(false);
    expect(await pruneInspections(diskOutputs.inspections, { dir: project, slug: 'linked-inspect' } as LoadedProject, 20)).toEqual([]);
    for (const id of ids) expect(existsSync(join(elsewhere, id)), id).toBe(true);
    // An inspection's own folder linked out, under a real .retake/inspect: refused too.
    const own = join(temp, 'linked-inspect-own');
    const ownRoot = diskOutputs.inspections.dirOf(own);
    await mkdir(ownRoot, { recursive: true });
    await symlink(elsewhere, join(ownRoot, fresh));
    expect(
      await diskOutputs.inspections.makeFolder(join(ownRoot, fresh, 'shots'), own).then(
        () => 'made',
        (e: { code?: string }) => e.code,
      ),
    ).toBe('refused');
    expect(existsSync(join(elsewhere, 'shots'))).toBe(false);
  });

  it("a generated folder linked out of the project is not within it; one file removed is the link, never what it leads to; a followed signature is the target's", async () => {
    const project = join(temp, 'linked-renders');
    const elsewhere = join(temp, 'renders-elsewhere');
    await mkdir(elsewhere, { recursive: true });
    await mkdir(project, { recursive: true });
    await symlink(elsewhere, diskOutputs.renders.dirOf(project));
    expect(await diskOutputs.renders.within(project)).toBe(false);
    await mkdir(diskOutputs.reviews.dirOf(project));
    expect(await diskOutputs.reviews.within(project)).toBe(true);
    const target = join(elsewhere, 'kept.mp4');
    await writeFile(target, 'kept');
    const review = diskOutputs.reviews.dirOf(project);
    await symlink(target, join(review, '.a.partial-1.mp4'));
    expect(await diskOutputs.reviews.signature(join(review, '.a.partial-1.mp4'), { follow: true })).toBe(await diskOutputs.reviews.signature(target));
    expect(await diskOutputs.reviews.signature(join(review, '.a.partial-1.mp4'))).not.toBe(await diskOutputs.reviews.signature(target));
    await diskOutputs.reviews.removeFile(join(review, '.a.partial-1.mp4'));
    expect([await diskOutputs.reviews.kind(join(review, '.a.partial-1.mp4')), await diskOutputs.reviews.readText(target)]).toEqual([undefined, 'kept']);
  });

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

  it('describes a file that has another name (a hard link) as a refused link (no size, no sha256), and through a link that stays in the run folder too', async () => {
    const runsDir = runsDirOf(join(temp, 'hard-linked'));
    const dir = join(runsDir, '20261114-093000-quote');
    await mkdir(dir, { recursive: true });
    const secret = join(temp, 'hard-outside.bin');
    await writeFile(secret, 'bytes kept elsewhere');
    await link(secret, join(dir, 'capture.mp4'));
    await symlink(join(dir, 'capture.mp4'), join(dir, 'log.jsonl'));
    await writeFile(join(dir, 'timeline.json'), '{}');
    expect(await diskOutputs.runs.describe(dir, 'capture.mp4', { hash: true })).toEqual({ link: 'refused' });
    expect(await diskOutputs.runs.describe(dir, 'capture.mp4'), 'not hashed: still no size').toEqual({ link: 'refused' });
    expect(await diskOutputs.runs.describe(dir, 'log.jsonl', { hash: true }), 'a link in the folder to a hard-linked file').toEqual({ link: 'refused' });
    expect(await diskOutputs.runs.describe(dir, 'timeline.json', { hash: true }), 'a file of one name').toEqual({
      bytes: 2,
      sha256: createHash('sha256').update('{}').digest('hex'),
    });
  });

  it('describes a file given another name between the look and the hash (a hard link swapped in) as a refused link, plain or through a link inside the run folder', async () => {
    const dir = join(runsDirOf(join(temp, 'hard-race')), '20261114-093000-quote');
    await mkdir(dir, { recursive: true });
    const secret = join(temp, 'hard-race-outside.bin');
    await writeFile(secret, 'bytes kept elsewhere');
    await writeFile(join(dir, 'capture.mp4'), 'the film');
    await writeFile(join(dir, 'timeline.json'), '{}');
    await symlink(join(dir, 'timeline.json'), join(dir, 'log.jsonl'));
    // The layer of the disk, but its look at `swap` is followed by `swap` made another name of a file elsewhere.
    let swap = '';
    const fs: OutputFs = {
      ...nodeOutputFs,
      lstat: async (path) => {
        const st = await nodeOutputFs.lstat(path);
        if (path === swap && st.isFile()) {
          swap = '';
          await rm(path);
          await link(secret, path);
        }
        return st;
      },
    };
    const runs = outputsOn(fs).runs;
    swap = join(dir, 'capture.mp4');
    expect(await runs.describe(dir, 'capture.mp4', { hash: true })).toEqual({ link: 'refused' });
    swap = join(dir, 'timeline.json');
    expect(await runs.describe(dir, 'log.jsonl', { hash: true }), 'through a link that stays in the run folder').toEqual({ link: 'refused' });
  });

  it('run_status shows a run file that has another name (a hard link) as a refused link, with no size and no sha256', async () => {
    const ws = join(temp, 'ws-hard-link');
    await mkdir(ws, { recursive: true });
    await fixtureWorkspace(ws);
    const project = join(ws, 'projects', 'northfield-fixture');
    const engine = await createEngine({ root: ws, client: 'mcp', autoStartWorker: false });
    const sub = await engine.runs.submit({ project: 'northfield-fixture', scenario: 'quote', mode: 'dry', until: 'discover.1' });
    const dir = join(runsDirOf(project), sub.run_id);
    const secret = join(temp, 'hard-status.bin');
    await writeFile(secret, 'not the run');
    await link(secret, join(dir, 'log.jsonl'));
    const status = await engine.runs.status('northfield-fixture', sub.run_id);
    expect(status.outputs.find((o) => o.ref === `runs/${sub.run_id}/log.jsonl`)).toEqual({
      ref: `runs/${sub.run_id}/log.jsonl`,
      path: join(dir, 'log.jsonl'),
      kind: 'run',
      link: 'refused',
    });
    const record = status.outputs.find((o) => o.ref === `runs/${sub.run_id}/run.json`);
    expect(record?.bytes, "the run folder's own files are still described").toBeGreaterThan(0);
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
