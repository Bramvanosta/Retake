/**
 * The Outputs port's contract (outputs/outputs.ts), its run folders: what the engine reads back of what it and a runner
 * wrote, whichever storage the adapter holds them on — the disk's (diskOutputs, a temp folder) and the memory's
 * (MemoryOutputs) run the same cases with the same expected values, the root aside. Each case works in its own
 * project folder under the root.
 */
import { createHash } from 'node:crypto';
import { basename, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FORMAT_VERSIONS } from '@retake/core/base';
import { newRunId } from '@retake/core/ids';
import type { RunId } from '@retake/core/ids';
import { queuedRun } from '@retake/core/run';
import { parseRenderRecord } from '@retake/core/render';
import type { OutputFolder, Outputs } from '../src/index.js';
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
      expect(a).toEqual({
        id: newRunId('quote', AT),
        dir: join(runsDir, newRunId('quote', AT)),
      });
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
      expect(read.ok && read.value).toMatchObject({
        id,
        status: 'queued',
        scenario: 'quote',
      });
      const facts = await runs.folder(runsDir, id);
      expect(facts).toMatchObject({
        name: id,
        folder: 'dir',
        timeline: { ok: false, problem: 'missing' },
        film: 'missing',
        recordLink: false,
        timelineLink: false,
      });
      expect(facts.record.ok).toBe(true);
      expect(await runs.folder(runsDir, '20261114-000000-gone')).toMatchObject({
        folder: 'gone',
      });
      const named = await runs.named(dir);
      expect(named.facts.folder).toBe('dir');
      expect(named.timeline).toEqual({ ok: false, problem: 'missing' });
      // A run.json that is no record says so, as the reader says it on any storage.
      await runs.write(dir, 'run.json', '[]');
      expect((await runs.record(dir)).ok).toBe(false);
      await runs.write(dir, 'run.json', '{');
      expect(await runs.record(dir)).toEqual({
        ok: false,
        problem: 'not-json',
      });
    });

    it('describes a file by its size and, asked, its sha256; a folder as present with no size; nothing as undefined', async () => {
      const { f, runs, runsDir } = await project();
      const { dir } = await runs.reserve(runsDir, 'quote', AT);
      await runs.write(dir, 'capture.mp4', 'film bytes');
      expect(await runs.describe(dir, 'capture.mp4')).toEqual({ bytes: 10 });
      expect(await runs.describe(dir, 'capture.mp4', { hash: true })).toEqual({
        bytes: 10,
        sha256: createHash('sha256').update('film bytes').digest('hex'),
      });
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

    it('names every entry of runs/, reads a capped text, sizes, removes and unreserves a run folder', async () => {
      const { f, runs, runsDir } = await project();
      expect(await runs.names(runsDir)).toEqual([]);
      const { dir } = await runs.reserve(runsDir, 'quote', AT);
      await f.seed(join(runsDir, 'by-hand.txt'), 'x');
      expect((await runs.names(runsDir)).sort()).toEqual([basename(dir), 'by-hand.txt'].sort());
      // A reserved folder that is still empty goes; one that holds anything stays.
      await runs.unreserve(dir);
      expect(await runs.ids(runsDir)).toEqual([]);
      const held = await runs.reserve(runsDir, 'quote', AT);
      await runs.write(held.dir, 'run.json', '{"id":"x"}');
      await runs.write(held.dir, 'capture.mp4', 'film bytes');
      await runs.unreserve(held.dir);
      expect(await runs.ids(runsDir)).toEqual([held.id]);
      expect(await runs.readCapped(held.dir, 'run.json', { max: 100, follow: false })).toEqual({ ok: true, text: '{"id":"x"}', link: false });
      expect(await runs.readCapped(held.dir, 'run.json', { max: 4, follow: false })).toMatchObject({ ok: false, problem: 'too-big' });
      expect(await runs.readCapped(held.dir, 'log.jsonl', { max: 100, follow: true })).toMatchObject({ ok: false, problem: 'missing' });
      expect(await runs.size(held.dir)).toBe(20);
      expect(await runs.size(join(held.dir, 'capture.mp4'))).toBe(10);
      await runs.remove(held.dir);
      expect(await runs.ids(runsDir)).toEqual([]);
      expect(await runs.size(held.dir)).toBe(0);
      await runs.remove(held.dir);
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

  describe(`Outputs contract (generated folders): ${name}`, () => {
    let n = 0;
    const project = async () => {
      const f = await make();
      const dir = join(f.root, `g${++n}`);
      await f.folder(dir);
      return { f, o: f.outputs, dir };
    };
    const members = (o: Outputs): Array<[string, OutputFolder, string]> => [
      ['renders', o.renders, 'renders'],
      ['reviews', o.reviews, 'review'],
      ['exports', o.exports, 'exports'],
      ['inspections', o.inspections, join('.retake', 'inspect')],
    ];

    it('places each kind in its project folder: renders/, review/, exports/, .retake/inspect/', async () => {
      const { o, dir } = await project();
      for (const [kind, member, folder] of members(o)) expect(member.dirOf(dir), kind).toBe(join(dir, folder));
    });

    it('writes, lists, reads, sizes, signs and removes the files of a generated folder', async () => {
      const { o, dir } = await project();
      for (const [kind, member] of members(o)) {
        const at = member.dirOf(dir);
        expect(await member.names(at), kind).toEqual([]);
        expect(await member.kind(at), kind).toBeUndefined();
        expect(await member.size(at), kind).toBe(0);
        await member.write(join(at, 'b', 'one.txt'), 'four');
        await member.writeJson(join(at, 'a.json'), { a: 1 });
        expect((await member.names(at)).sort(), kind).toEqual(['a.json', 'b']);
        expect(await member.kind(at), kind).toBe('folder');
        expect(await member.kind(join(at, 'a.json')), kind).toBe('file');
        expect(await member.readText(join(at, 'a.json')), kind).toBe('{\n  "a": 1\n}\n');
        expect(await member.readText(join(at, 'gone.json')), kind).toBeUndefined();
        expect(await member.readText(join(at, 'b')), `${kind}: a folder`).toBeUndefined();
        expect(await member.size(join(at, 'b')), kind).toBe(4);
        expect(await member.size(join(at, 'a.json')), kind).toBe(13);
        const sig = await member.signature(join(at, 'a.json'));
        expect(sig, kind).not.toBe('-');
        await member.writeJson(join(at, 'a.json'), { a: 22 });
        expect(await member.signature(join(at, 'a.json')), kind).not.toBe(sig);
        await member.remove(join(at, 'b'));
        await member.remove(join(at, 'never'));
        expect(await member.names(at), kind).toEqual(['a.json']);
        expect(await member.signature(join(at, 'b')), kind).toBe('-');
      }
    });

    it('reads renders/ through the one reader: the records of their own file, one by its id, a file too big for a listing', async () => {
      const { f, o, dir } = await project();
      const at = o.renders.dirOf(dir);
      expect(await o.renders.entries(at)).toEqual([]);
      await o.renders.writeJson(join(at, 'quote-v1.json'), {
        id: 'quote-v1',
        scenario: 'quote',
      });
      await f.seed(join(at, 'quote-v2.json'), '{');
      await f.seed(join(at, 'notes.txt'), 'not a record');
      const entries = await o.renders.entries(at);
      // What the one reader says of each (core parseRenderRecord on the JSON it holds), whatever the storage.
      expect(entries.map((e) => [e.name, e.link, e.read])).toEqual([
        ['quote-v1', false, parseRenderRecord({ id: 'quote-v1', scenario: 'quote' })],
        ['quote-v2', false, { ok: false, problem: 'not-json' }],
      ]);
      expect((await o.renders.entries(at, (name) => name === 'quote-v2')).map((e) => e.name)).toEqual(['quote-v2']);
      const one = await o.renders.byId(at, 'quote-v1');
      expect(one).toEqual(entries[0]);
      expect((await o.renders.byId(at, 'quote-v9')).read).toMatchObject({
        ok: false,
        problem: 'missing',
      });
      await f.seed(join(at, 'big-v1.json'), `"${'x'.repeat(17 * 1024 * 1024)}"`);
      expect((await o.renders.entries(at, (name) => name === 'big-v1'))[0]!.read).toMatchObject({ ok: false, problem: 'too-big' });
    });

    it("takes a render version's lock once: its folder made, its text kept, a second take refused (EEXIST) and nothing changed", async () => {
      const { o, dir } = await project();
      const lock = join(o.renders.dirOf(dir), '.quote-v1.lock');
      await o.renders.lock(lock, 'job 1\n');
      expect(await o.renders.readText(lock)).toBe('job 1\n');
      const again = await o.renders.lock(lock, 'job 2\n').then(
        () => 'taken twice',
        (e: NodeJS.ErrnoException) => e.code,
      );
      expect([again, await o.renders.readText(lock)]).toEqual(['EEXIST', 'job 1\n']);
      // A folder in its place is no free lock either.
      const folder = join(o.renders.dirOf(dir), '.quote-v2.lock');
      await o.renders.write(join(folder, 'x'), 'x');
      expect(
        await o.renders.lock(folder, 'job 3\n').then(
          () => 'taken',
          (e: NodeJS.ErrnoException) => e.code,
        ),
      ).toBe('EEXIST');
      await o.renders.unlock(lock);
      await o.renders.lock(lock, 'job 4\n');
      expect(await o.renders.readText(lock)).toBe('job 4\n');
      // Unlocking removes a lock file only: a folder in its place stays, with what it holds, and the release fails.
      expect(await o.renders.unlock(folder).then(() => 'removed', () => 'refused')).toBe('refused');
      expect(await o.renders.readText(join(folder, 'x'))).toBe('x');
      await o.renders.unlock(join(o.renders.dirOf(dir), '.quote-v9.lock'));
    });

    it('finds a render someone named through the one finder: an id, `latest` of a scenario, or why none is', async () => {
      const { o, dir } = await project();
      const at = o.renders.dirOf(dir);
      const rec = (id: string, at_: string) => ({
        version: 1,
        id,
        scenario: 'quote',
        status: 'succeeded',
        created_at: at_,
        file: join(at, `${id}.mp4`),
        record: join(at, `${id}.json`),
        plan: { version: 1 },
      });
      await o.renders.writeJson(join(at, 'quote-v1.json'), rec('quote-v1', '2026-11-14T09:00:00.000Z'));
      await o.renders.writeJson(join(at, 'quote-v2.json'), rec('quote-v2', '2026-11-14T10:00:00.000Z'));
      const byId = await o.renders.named(at, 'quote-v1', { verb: 'export', slug: 'demo' });
      expect(byId.ok && [byId.render.entry.name, byId.render.record.id]).toEqual(['quote-v1', 'quote-v1']);
      const latest = await o.renders.named(at, 'latest', { verb: 'export', slug: 'demo', scenario: 'quote' });
      expect(latest.ok && latest.render.record.id).toBe('quote-v2');
      const none = await o.renders.named(at, 'quote-v9', { verb: 'export', slug: 'demo', trust: 'mcp' });
      expect(none.ok).toBe(false);
    });
  });
}
