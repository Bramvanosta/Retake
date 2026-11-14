/**
 * The Outputs port's contract (outputs/outputs.ts), its run folders: what the engine reads back of what it and a runner
 * wrote, whichever storage the adapter holds them on — the disk's (diskOutputs, a temp folder) and the memory's
 * (MemoryOutputs) run the same cases with the same expected values, the root aside. Each case works in its own
 * project folder under the root.
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FORMAT_VERSIONS } from '@retake/core/base';
import { newRunId } from '@retake/core/ids';
import type { RunId } from '@retake/core/ids';
import { queuedRun } from '@retake/core/run';
import type { Outputs } from '../src/index.js';
import { runsDirOf } from '../src/index.js';

/** An adapter and where its cases work: `root`, an absolute folder no file is under yet. */
export interface OutputsFixture {
  outputs: Outputs;
  root: string;
  /** Put a file in place behind the port's back (a runner's write, a person's). */
  seed(path: string, data: string): Promise<void>;
  folder(path: string): Promise<void>;
}

const AT = new Date('2026-11-14T09:30:00Z');

function record(dir: string, id: RunId) {
  return queuedRun({
    version: FORMAT_VERSIONS.run,
    id,
    project: 'demo',
    scenario: 'quote',
    mode: 'dry',
    started_at: AT.toISOString(),
    dir,
    env: 'local',
    options: { hooks: 'skip', headed: false },
    steps_total: 2,
    steps_done: 0,
    screenshots: [],
    hooks: { setup: 'none', teardown: 'none' },
    warnings: [],
  });
}

export function outputsContract(name: string, make: () => Promise<OutputsFixture>): void {
  describe(`Outputs contract (runs): ${name}`, () => {
    let n = 0;
    /** A fresh project folder of the case, and the adapter. */
    const project = async () => {
      const f = await make();
      const dir = join(f.root, `p${++n}`);
      await f.folder(dir);
      return { f, runs: f.outputs.runs, dir, runsDir: runsDirOf(dir) };
    };

    it('lists no run of a project without runs/, then its run folders in the one order of runs (dated ids newest first), not its files nor names that are no run id', async () => {
      const { f, runs, runsDir } = await project();
      expect(await runs.ids(runsDir)).toEqual([]);
      await f.folder(join(runsDir, '20261113-100000-quote'));
      await f.folder(join(runsDir, '20261114-100000-quote'));
      await f.folder(join(runsDir, 'by-hand'));
      await f.folder(join(runsDir, '.hidden'));
      await f.seed(join(runsDir, '20261115-100000-quote'), 'a file');
      expect(await runs.ids(runsDir)).toEqual(['20261114-100000-quote', '20261113-100000-quote', 'by-hand']);
    });

    it('reserves a run folder named after the time given, and the next second when that one is taken', async () => {
      const { runs, runsDir } = await project();
      const a = await runs.reserve(runsDir, 'quote', AT);
      const b = await runs.reserve(runsDir, 'quote', AT);
      // Named after the time as core names a run (newRunId: the local time), the next second when taken.
      expect(a).toEqual({ id: newRunId('quote', AT), dir: join(runsDir, newRunId('quote', AT)) });
      expect(b.id).toBe(newRunId('quote', new Date(AT.getTime() + 1000)));
      expect(await runs.ids(runsDir)).toEqual([b.id, a.id]);
      await expect(runs.reserve(runsDir, 'q'.repeat(200), AT)).rejects.toThrow(/too long for a run folder/);
    });

    it('writes a run folder and reads it back: a text, a JSON file, a record through the one reader, the folder facts', async () => {
      const { runs, runsDir } = await project();
      const { id, dir } = await runs.reserve(runsDir, 'quote', AT);
      expect(await runs.record(dir)).toEqual({ ok: false, problem: 'missing' });
      const rec = record(dir, id);
      await runs.writeJson(dir, 'run.json', rec);
      await runs.write(dir, 'scenario.yaml', 'video: one\n');
      expect(await runs.readText(dir, 'run.json')).toBe(`${JSON.stringify(rec, null, 2)}\n`);
      expect(await runs.readText(dir, 'scenario.yaml')).toBe('video: one\n');
      expect(await runs.readText(dir, 'timeline.json')).toBeUndefined();
      const read = await runs.record(dir);
      expect(read.ok && read.value).toMatchObject({ id, status: 'queued', scenario: 'quote' });
      const facts = await runs.folder(runsDir, id);
      expect(facts).toMatchObject({ name: id, folder: 'dir', timeline: { ok: false, problem: 'missing' }, film: 'missing', recordLink: false, timelineLink: false });
      expect(facts.record.ok).toBe(true);
      expect(await runs.folder(runsDir, '20261114-000000-gone')).toMatchObject({ folder: 'gone' });
      const named = await runs.named(dir);
      expect(named.facts.folder).toBe('dir');
      expect(named.timeline).toEqual({ ok: false, problem: 'missing' });
      // A run.json that is no record says so, as the reader says it on any storage.
      await runs.write(dir, 'run.json', '[]');
      expect((await runs.record(dir)).ok).toBe(false);
      await runs.write(dir, 'run.json', '{');
      expect(await runs.record(dir)).toEqual({ ok: false, problem: 'not-json' });
    });

    it('describes a file by its size and, asked, its sha256; a folder as present with no size; nothing as undefined', async () => {
      const { f, runs, runsDir } = await project();
      const { dir } = await runs.reserve(runsDir, 'quote', AT);
      await runs.write(dir, 'capture.mp4', 'film bytes');
      expect(await runs.describe(dir, 'capture.mp4')).toEqual({ bytes: 10 });
      expect(await runs.describe(dir, 'capture.mp4', { hash: true })).toEqual({ bytes: 10, sha256: createHash('sha256').update('film bytes').digest('hex') });
      await f.folder(join(dir, 'frames'));
      expect(await runs.describe(dir, 'frames')).toEqual({});
      expect(await runs.describe(dir, 'log.jsonl')).toBeUndefined();
    });

    it('signs a path: `-` when nothing is there, another text once it is written again', async () => {
      const { runs, runsDir } = await project();
      const { dir } = await runs.reserve(runsDir, 'quote', AT);
      const file = join(dir, 'run.json');
      expect(await runs.signature(file)).toBe('-');
      await runs.write(dir, 'run.json', '{}');
      const one = await runs.signature(file);
      expect(one).not.toBe('-');
      await runs.write(dir, 'run.json', '{"a":1}');
      expect(await runs.signature(file)).not.toBe(one);
    });

    it('says a run folder lies in its project when runs/<id> is a folder there; not when it is missing or a file', async () => {
      const { f, runs, dir, runsDir } = await project();
      const { id } = await runs.reserve(runsDir, 'quote', AT);
      expect(await runs.inside(dir, id)).toBe(true);
      expect(await runs.inside(dir, '20261114-000000-gone')).toBe(false);
      await f.seed(join(runsDir, '20261114-000001-file'), 'x');
      expect(await runs.inside(dir, '20261114-000001-file')).toBe(false);
      await f.seed(join(runsDir, '.hidden', 'run.json'), '{}');
      expect(await runs.inside(dir, '.hidden'), 'a folder whose name is no run id').toBe(false);
    });

    it('refuses a file name that is not one plain name of the run folder', async () => {
      const { runs, runsDir } = await project();
      const { dir } = await runs.reserve(runsDir, 'quote', AT);
      for (const bad of ['', '.', '..', 'a/b', '../run.json', 'a\\b']) {
        await expect(runs.write(dir, bad, 'x'), bad).rejects.toThrow(/invalid run file name/);
        await expect(runs.readText(dir, bad), bad).rejects.toThrow(/invalid run file name/);
      }
    });
  });
}
