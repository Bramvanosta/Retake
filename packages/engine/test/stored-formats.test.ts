/**
 * The engine's stored formats are each read through one schema (stored-json.ts): a file that is not one is skipped or
 * refused the way its reader always did — a torn history or journal line is skipped, a job file that is not a job reads
 * as no job, a claim that is not one as a dead worker's, a provenance file that is not this tool's says so, a token, a
 * lock, a marker, a browser record, an inspection report, a live file or a frame header that is not one reads as none.
 */
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { scratchHome } from '@retake/test-support/home';
import { FileJobQueue, HISTORY_VERSION, JOURNAL_VERSION, THEME_PROVENANCE_FILE, readJournal, readStudioToken, readWorkerLock, replaceProblem, usageCounts } from '../src/index.js';
import { readHistoryLine } from '../src/history.js';
import { readJournalLine } from '../src/store/journal.js';
import { workerLockFile } from '../src/jobs/lock.js';
import { readMarker } from '../src/jobs/captures.js';
import { readInspectReport } from '../src/jobs/inspect-job.js';
import { diskOutputs } from '../src/outputs/disk-outputs.js';
import { liveFrameHeaderOf, readLiveChannel } from '../src/jobs/live-channel.js';
import { killRecordedBrowser } from '../src/jobs/render-job.js';
import { libraryReason } from '../src/library.js';
import { RECORD_META_FILE, readRecordMeta } from '../src/record-files.js';
import { UPDATES_FILE, readUpdateChecks } from '../src/integrations/app-setup.js';
import { storedJson } from '../src/stored-json.js';
import { RUN_INPUT } from './job-queue-contract.js';
import { z } from 'zod';

let ws: string;
const retakeHome = scratchHome();
const TOKEN = 'a'.repeat(40);

beforeAll(async () => {
  ws = await mkdtemp(join(tmpdir(), 'retake-stored-formats-'));
  retakeHome.use(join(ws, '.home'));
});

afterAll(async () => {
  retakeHome.restore();
  await rm(ws, { recursive: true, force: true });
});

async function folder(name: string): Promise<string> {
  const dir = join(ws, name);
  await mkdir(dir, { recursive: true });
  return dir;
}

describe('storedJson', () => {
  it('the value as the file holds it when the schema accepts it; undefined when it is not JSON or refused', () => {
    const s = z.object({ a: z.number() });
    expect(storedJson(s, '{"a":1,"b":"kept"}')).toEqual({ a: 1, b: 'kept' });
    expect(storedJson(s, '{"a":"1"}')).toBeUndefined();
    expect(storedJson(s, '{"a":1')).toBeUndefined();
    expect(storedJson(s, 'null')).toBeUndefined();
  });
});

describe('history lines: a torn, foreign or other-version line is skipped', () => {
  const line = (e: Record<string, unknown>) => JSON.stringify({ v: HISTORY_VERSION, at: '2026-11-13T10:00:00Z', kind: 'run', counted: { captures: 1, dry_runs: 0, renders: 0 }, ...e });

  it('readHistoryLine', () => {
    expect(readHistoryLine(line({}))).toMatchObject({ kind: 'run' });
    for (const bad of [line({ v: 2 }), line({ kind: 3 }), line({ at: null }), '{"v":1', '[]', '']) expect(readHistoryLine(bad), bad).toBeUndefined();
  });

  it('usageCounts counts the lines that read only', async () => {
    const root = await folder('history');
    await mkdir(join(root, '.retake'), { recursive: true });
    await writeFile(join(root, '.retake', 'history.jsonl'), [line({}), line({ kind: null }), '{"torn', line({ counted: { captures: 'x' } })].join('\n') + '\n');
    expect(await usageCounts(root)).toMatchObject({ captures: 1, entries: 2 });
  });
});

describe('journal lines: a torn, foreign or other-version line is skipped', () => {
  it('readJournalLine and readJournal', async () => {
    const ok = JSON.stringify({ v: JOURNAL_VERSION, op: 'write', at: '2026-11-13T10:00:00Z', by: 'cli' });
    expect(readJournalLine(ok)).toMatchObject({ op: 'write' });
    for (const bad of [JSON.stringify({ v: JOURNAL_VERSION + 1, op: 'write', at: 'x' }), JSON.stringify({ v: JOURNAL_VERSION, at: 'x' }), '{', ' ']) expect(readJournalLine(bad), bad).toBeUndefined();
    const root = await folder('journal');
    await mkdir(join(root, '.retake'), { recursive: true });
    await writeFile(join(root, '.retake', 'journal.jsonl'), `${ok}\n{"v":1\n${JSON.stringify({ v: JOURNAL_VERSION, op: 7, at: 'x' })}\n`);
    expect((await readJournal(root)).map((e) => e.op)).toEqual(['write']);
  });
});

describe('job files', () => {
  it('a job.json that is not a job reads as no job; a claim that is not one as a dead worker’s; a junk event line is skipped', async () => {
    const root = await folder('queue');
    const q = new FileJobQueue(root);
    const job = await q.enqueue(RUN_INPUT);
    expect((await q.get(job.id))?.state).toBe('queued');
    // A claim file that is no claim: the job reads as interrupted (no live worker holds it), as before.
    await writeFile(join(q.files.job(job.id), 'claim'), '{"pid":"me"}');
    expect(await q.claimOf(job.id)).toEqual({ pid: 0, at: '' });
    expect((await q.get(job.id))?.state).toBe('interrupted');
    await rm(join(q.files.job(job.id), 'claim'));
    await q.append(job.id, 0, [{ type: 'log', level: 'info', message: 'one' }]);
    await writeFile(q.files.events(job.id), `{"seq":"x","t":"y","type":"log"}\n{"torn`, { flag: 'a' });
    expect((await q.events(job.id)).map((e) => e.seq)).toEqual([1]);
    for (const bad of [
      { ...job, state: 'paused' },
      { ...job, input: 'run' },
      { ...job, created_at: undefined },
      { ...job, id: 'j_other' },
    ]) {
      await writeFile(q.files.record(job.id), JSON.stringify(bad));
      expect(await q.get(job.id), JSON.stringify(bad).slice(0, 60)).toBeUndefined();
    }
    await writeFile(q.files.record(job.id), '{"id":');
    expect(await q.get(job.id)).toBeUndefined();
  });

  it('a browser.json that is not one: nothing is killed', async () => {
    const q = new FileJobQueue(await folder('browser'));
    const job = await q.enqueue(RUN_INPUT);
    await writeFile(q.files.browser(job.id), JSON.stringify({ pid: String(process.pid) }));
    expect(await q.recordedBrowser(job.id)).toBeUndefined();
    const logs: string[] = [];
    await expect(killRecordedBrowser(q, job, (m) => logs.push(m))).resolves.toBeUndefined();
    expect(logs).toEqual([]);
  });
});

describe('the worker lock: no pid, no lock; an odd shown member is repaired', () => {
  it('readWorkerLock', async () => {
    const root = await folder('lock');
    await mkdir(join(root, '.retake', 'workers'), { recursive: true });
    await writeFile(workerLockFile(root), JSON.stringify({ pid: String(process.pid), build: 'b', since: 'x', host: 'h' }));
    expect(readWorkerLock(root)).toBeNull();
    await writeFile(workerLockFile(root), JSON.stringify({ pid: process.pid, build: 'b1', since: '2026-11-13T10:00:00.000Z', host: 'a\u202eb' }));
    expect(readWorkerLock(root)).toMatchObject({ pid: process.pid, build: 'b1', host: '?' });
    // Any hidden character (core hidden-chars.ts), not only the ones the former list named.
    await writeFile(workerLockFile(root), JSON.stringify({ pid: process.pid, build: 'b1', since: '2026-11-13T10:00:00.000Z', host: 'mac\u00adbook' }));
    expect(readWorkerLock(root)).toMatchObject({ host: '?' });
  });
});

describe('a filming marker that is not one is skipped', () => {
  it('readMarker', () => {
    expect(readMarker(JSON.stringify({ v: 1, pid: 42, ws: 'w', source: 'job' }))).toMatchObject({ pid: 42 });
    for (const bad of [{ v: 0, pid: 42 }, { v: 1, pid: 0 }, { v: 1, pid: 4.2 }, { v: '1', pid: 42 }, null]) expect(readMarker(JSON.stringify(bad)), JSON.stringify(bad)).toBeUndefined();
    expect(readMarker('{')).toBeUndefined();
  });
});

describe('a theme’s provenance file', () => {
  it('not JSON: not made by this tool; JSON this tool did not write: not this tool’s', async () => {
    const dir = await folder('theme');
    expect(await replaceProblem(dir)).toMatch(/was not made by this tool \(no readable/);
    await writeFile(join(dir, THEME_PROVENANCE_FILE), '{"made_by":');
    expect(await replaceProblem(dir)).toMatch(/was not made by this tool \(no readable/);
    for (const bad of [{ made_by: 'retake' }, { made_by: 'other', files: {} }, { made_by: 'retake', files: { 'a.yaml': 1 } }]) {
      await writeFile(join(dir, THEME_PROVENANCE_FILE), JSON.stringify(bad));
      expect(await replaceProblem(dir), JSON.stringify(bad)).toMatch(/is not this tool's$/);
    }
    await writeFile(join(dir, THEME_PROVENANCE_FILE), JSON.stringify({ made_by: 'retake', trust: 'author', files: {} }));
    expect(await replaceProblem(dir)).toBeNull();
  });
});

describe('the Studio’s token record', () => {
  it('a record of another shape reads as none', async () => {
    const dir = await folder('token');
    const file = join(dir, 'x.token');
    const write = async (r: Record<string, unknown>) => {
      await writeFile(file, JSON.stringify({ version: 1, root: await realpath(ws), pid: process.pid, port: 4120, token: TOKEN, ...r }), { mode: 0o600 });
      await chmod(file, 0o600);
    };
    await write({});
    expect(await readStudioToken(file, ws)).toMatchObject({ port: 4120, token: TOKEN });
    for (const bad of [{ token: 'short' }, { port: 70000 }, { pid: -1 }, { version: 2 }, { started_at: 5 }]) {
      await write(bad);
      expect(await readStudioToken(file, ws), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe('an inspection’s report that is not one reads as none', () => {
  it('readInspectReport', async () => {
    const dir = await folder('inspect');
    const file = join(dir, 'inspect.json');
    expect(await readInspectReport(diskOutputs.inspections, file)).toBeNull();
    const ok = { version: 1, status: 'ok', screenshot: null, elements: [], counts: {}, untrusted: { warnings: [] } };
    await writeFile(file, JSON.stringify(ok));
    expect(await readInspectReport(diskOutputs.inspections, file)).toMatchObject({ status: 'ok' });
    for (const bad of [
      { ...ok, version: 2 },
      { ...ok, status: 'odd' },
      { ...ok, elements: {} },
      { ...ok, screenshot: 3 },
    ]) {
      await writeFile(file, JSON.stringify(bad));
      expect(await readInspectReport(diskOutputs.inspections, file), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe('the live channel', () => {
  it('a live file that is not one reads as none', async () => {
    const dir = await folder('live');
    const file = join(dir, 'live.json');
    const queue = { claimOf: async () => ({ pid: process.pid, at: 'x' }), liveRecord: async () => readFile(file, 'utf8') };
    const write = async (r: Record<string, unknown>) => {
      await writeFile(file, JSON.stringify({ v: 1, job: 'j_x', run: '20261113-100000-quote', port: 4400, token: TOKEN, pid: process.pid, ...r }), { mode: 0o600 });
      await chmod(file, 0o600);
    };
    await write({});
    expect(await readLiveChannel(queue, 'j_x')).toMatchObject({ port: 4400, job: 'j_x' });
    for (const bad of [{ job: 'j_y' }, { run: '../x' }, { port: 0 }, { token: 'x' }, { pid: 'me' }, { v: 2 }]) {
      await write(bad);
      expect(await readLiveChannel(queue, 'j_x'), JSON.stringify(bad)).toBeNull();
    }
  });

  it('a frame header that is not one is refused', () => {
    const ok = { v: 1, kind: 'frame', seq: 1, w: 640, h: 360, at: 1 };
    expect(liveFrameHeaderOf(JSON.stringify(ok))).toEqual(ok);
    for (const bad of [
      { ...ok, w: 0 },
      { ...ok, h: 5000 },
      { ...ok, kind: 'other' },
      { ...ok, seq: 1.5 },
      { ...ok, page: 'p'.repeat(201) },
      { ...ok, at: '1' },
    ]) {
      expect(liveFrameHeaderOf(JSON.stringify(bad)), JSON.stringify(bad)).toBeUndefined();
    }
    expect(liveFrameHeaderOf('{')).toBeUndefined();
  });
});

describe('a library failure reason: one printable line', () => {
  it('libraryReason', () => {
    expect(libraryReason('Bad\nthing\u202e\u00ad happened\t ')).toBe('Bad thing happened');
  });
});

describe('a recording’s meta.json: a member out of shape, or another recording’s, reads as none', () => {
  it('readRecordMeta', async () => {
    const dir = await folder('record-meta');
    const id = 'rec_01JABCDEFGHJKMNPQRSTVWXYZ0';
    const ok = {
      v: 1,
      rec_id: id,
      job_id: null,
      submitted_by: 'mcp',
      name: 'quote',
      env: 'local',
      persona: null,
      access: 'read-only',
      page: 'console',
      path: '/',
      started_at: '2026-11-13T10:00:00.000Z',
      max_ms: null,
      owner: { pid: 42 },
      extra: 'dropped',
    };
    const write = (m: Record<string, unknown>) => writeFile(join(dir, RECORD_META_FILE), JSON.stringify(m));
    await write(ok);
    const { extra: _x, ...members } = ok;
    expect(readRecordMeta(dir, id)).toEqual(members);
    for (const bad of [
      { v: 2 },
      { name: 'Bad Name' },
      { access: 'all' },
      { started_at: 'yesterday' },
      { max_ms: 0 },
      { owner: { pid: -1 } },
      { submitted_by: 'other' },
      { rec_id: 'rec_01JABCDEFGHJKMNPQRSTVWXYZ1' },
    ]) {
      await write({ ...ok, ...bad });
      expect(readRecordMeta(dir, id), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe('the app’s update checks: another version or not JSON reads as none', () => {
  it('readUpdateChecks', async () => {
    const home = await folder('updates');
    const file = join(home, UPDATES_FILE);
    await writeFile(file, JSON.stringify({ version: 1, checked: 5, failed: null }));
    expect(readUpdateChecks(home)).toEqual({ checked: 5, failed: null });
    for (const bad of ['{"version":2,"checked":5}', '[1]', '{']) {
      await writeFile(file, bad);
      expect(readUpdateChecks(home), bad).toEqual({ checked: null, failed: null });
    }
  });
});
