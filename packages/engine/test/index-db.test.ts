/**
 * L4.1 part 3: the workspace index (node:sqlite, .retake/index.sqlite) — built from a scratch copy of the fixture
 * project, reconciled incrementally from a stat poll, history.jsonl read from its last whole line (appended, torn,
 * truncated, replaced), rebuilt when missing / garbage / truncated / of another schema (with its -wal and -shm), absent
 * on a Node.js without node:sqlite, FTS queries that cannot carry FTS syntax, and the activity feed: unfinished jobs
 * live from the queue (a SIGKILLed worker's job reads interrupted with no file changed; a finished job's file is read
 * once), finished ones from history. Files linked out of the project are never indexed and a FIFO never opened; an
 * index file that is a symbolic link is removed and rebuilt, never followed (review A L3, L4; review B L1).
 */
import { execFile, spawn, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { appendFile, lstat, mkdir, mkdtemp, readFile, rename, rm, stat, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadWorkspaceConfig } from '@retake/core/io';
import type { OpenedWorkspace } from '../src/index.js';
import { FileJobQueue, JobsWatch, WorkspaceIndex, ftsQuery, historyFile, indexFile, isCorruptionError, newJobId, processStart, scanSources, diffSources, workspaceChanges } from '../src/index.js';
import { REPO, fixtureWorkspace } from './helpers.js';
import { PERSON_POLICY } from '@retake/core';

let ws: string;
let cfg: OpenedWorkspace;
const P = 'northfield-fixture';
const project = () => join(ws, 'projects', P);
const savedHome = process.env.RETAKE_HOME;

const line = (o: Record<string, unknown>) => `${JSON.stringify({ v: 1, submitted_by: 'cli', state: 'succeeded', counted: { captures: 0, dry_runs: 0, renders: 0 }, ...o })}\n`;

beforeAll(async () => {
  ws = await mkdtemp(join(tmpdir(), 'studio-index-'));
  process.env.RETAKE_HOME = join(ws, '.home');
  await fixtureWorkspace(ws);
  await writeFile(join(project(), 'README.md'), '# Northfield\n\nA wholesale console for coffee importers and their roasters.\n');
  await mkdir(join(project(), 'renders'), { recursive: true });
  await writeFile(join(project(), 'renders', 'quote-v1.json'), JSON.stringify({ version: 1, id: 'quote-v1', scenario: 'quote', run_id: '20261016-090000-catalogue', status: 'succeeded', template: 'editorial', created_at: '2026-10-16T08:00:00.000Z', plan: {} }));
  await mkdir(join(ws, '.retake'), { recursive: true });
  await writeFile(
    historyFile(ws),
    line({ at: '2026-10-16T07:01:00.000Z', kind: 'run', project: P, run: { id: '20261016-090000-catalogue', scenario: 'catalogue', mode: 'capture', status: 'succeeded' } }) +
      line({ at: '2026-10-16T08:00:00.000Z', kind: 'render', project: P, job: newJobId(), submitted_by: 'mcp', render: { id: 'quote-v1', scenario: 'quote' } }),
  );
  cfg = { ...(await loadWorkspaceConfig(ws)), policy: PERSON_POLICY };
});

afterAll(async () => {
  if (savedHome === undefined) delete process.env.RETAKE_HOME;
  else process.env.RETAKE_HOME = savedHome;
  if (ws) await rm(ws, { recursive: true, force: true });
});

/** Overwrite the body of the index's last page (its header and the file header stay): a b-tree page SQLite still reads. */
async function ix0Pages(file: string): Promise<void> {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(file);
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.close();
  await rm(`${file}-wal`, { force: true });
  await rm(`${file}-shm`, { force: true });
  const buf = await readFile(file);
  const page = buf.readUInt16BE(16) === 1 ? 65536 : buf.readUInt16BE(16);
  for (let i = buf.length - page + 100; i < buf.length - 100; i++) buf[i] = 0xff;
  await writeFile(file, buf);
}

async function fresh(): Promise<WorkspaceIndex> {
  const ix = await WorkspaceIndex.open(cfg, { queue: new FileJobQueue(cfg.root) });
  if (!ix) throw new Error('node:sqlite is missing on this Node.js');
  return ix;
}

describe('the workspace index', () => {
  it('builds from the files: projects, README, scenarios, runs, renders, history; search by prefix words', async () => {
    await rm(indexFile(ws), { force: true });
    const ix = await fresh();
    try {
      expect(ix.rebuilt).toBe('missing');
      const first = await ix.reconcile();
      expect(first.keys).toEqual(expect.arrayContaining([`project:${P}`, `readme:${P}`, `runs:${P}`, `renders:${P}`, 'history']));
      expect(ix.counts()).toMatchObject({ projects: 1, runs: 2, renders: 1, history: 2 });
      expect(ix.search('roast')).toEqual([expect.objectContaining({ kind: 'project', project: P, ref: P, title: 'Northfield (fixture)', snippet: expect.stringContaining('roasters') })]);
      expect(ix.search('quo').map((h) => [h.kind, h.ref])).toEqual(expect.arrayContaining([['scenario', 'quote'], ['run', '20261017-120000-quote'], ['render', 'quote-v1']]));
      expect(ix.search('20261016').map((h) => h.ref)).toEqual(['20261016-090000-catalogue']);
      expect(ix.search('catalogue capture').map((h) => h.ref)).toContain('20261016-090000-catalogue');
      expect(ix.search('')).toEqual([]);
      // Nothing changed: nothing re-read, the generation stays.
      const again = await ix.reconcile();
      expect(again).toEqual({ keys: [], runs: [], generation: first.generation });
      expect(ix.history().map((h) => h.kind)).toEqual(['render', 'run']);
      expect(ix.history({ project: 'nope' })).toEqual([]);
    } finally {
      ix.close();
    }
  });

  it('reconciles what changed only: a README edit, a new run, a removed project', async () => {
    const ix = await fresh();
    try {
      expect(ix.rebuilt).toBeUndefined();
      await ix.reconcile();
      await writeFile(join(project(), 'README.md'), '# Northfield\n\nNow about tea blenders.\n');
      expect((await ix.reconcile()).keys).toEqual([`readme:${P}`]);
      expect(ix.search('roasters')).toEqual([]);
      expect(ix.search('blend').map((h) => h.ref)).toEqual([P]);
      // A run being written: its run.json is re-read while it is unfinished.
      const run = join(project(), 'runs', '20261018-100000-quote');
      await mkdir(run, { recursive: true });
      // A record as the runner writes it (a run.json that is no run record is not a run of the lists: L7.6a).
      const rec = (status: 'running' | 'succeeded') =>
        JSON.stringify({ version: 1, id: '20261018-100000-quote', project: P, scenario: 'quote', mode: 'capture', status, started_at: '2026-10-18T10:00:00.000Z', dir: run, env: 'local', options: { hooks: 'run', headed: false }, steps_total: 3, steps_done: 1, screenshots: [], hooks: { setup: 'none', teardown: 'none' }, warnings: [], ...(status === 'succeeded' ? { finished_at: '2026-10-18T10:01:00.000Z' } : {}) });
      await writeFile(join(run, 'run.json'), rec('running'));
      expect((await ix.reconcile()).keys).toEqual([`runs:${P}`]);
      expect(ix.search('20261018').map((h) => h.title)).toEqual(['quote · capture · running']);
      await new Promise((r) => setTimeout(r, 20));
      await writeFile(join(run, 'run.json'), rec('succeeded'));
      expect((await ix.reconcile()).keys).toEqual([`runs:${P}`]);
      expect(ix.search('20261018').map((h) => h.title)).toEqual(['quote · capture · succeeded']);
      // A second project appears, then goes.
      const other = join(ws, 'projects', 'other');
      await mkdir(other, { recursive: true });
      await writeFile(join(other, 'project.yaml'), 'version: 1\nname: Other shop\nenvironments: {}\n');
      await ix.reconcile();
      expect(ix.search('other').map((h) => [h.kind, h.ref])).toEqual([['project', 'other']]);
      await rm(other, { recursive: true });
      const gone = await ix.reconcile();
      expect(gone.keys).toEqual(expect.arrayContaining(['project:other', 'readme:other']));
      expect(ix.search('other')).toEqual([]);
      expect(ix.counts().projects).toBe(1);
    } finally {
      ix.close();
    }
  });

  it('history.jsonl: appended lines only, a torn last line waits, a truncated or replaced file is read again', async () => {
    const ix = await fresh();
    try {
      await ix.reconcile();
      const n = ix.counts().history;
      await appendFile(historyFile(ws), line({ at: '2026-10-18T11:00:00.000Z', kind: 'run', project: P, run: { id: 'r1', scenario: 'quote', mode: 'dry', status: 'failed' } }));
      expect((await ix.reconcile()).keys).toEqual(['history']);
      expect(ix.counts().history).toBe(n + 1);
      // A line being written: nothing until its newline.
      const torn = line({ at: '2026-10-18T12:00:00.000Z', kind: 'render', project: P });
      await appendFile(historyFile(ws), torn.slice(0, 20));
      await ix.reconcile();
      expect(ix.counts().history).toBe(n + 1);
      await appendFile(historyFile(ws), torn.slice(20));
      await ix.reconcile();
      expect(ix.counts().history).toBe(n + 2);
      expect(ix.history({ limit: 1 })[0]).toMatchObject({ kind: 'render', at: '2026-10-18T12:00:00.000Z' });
      // Truncated: read again from the start.
      const text = await readFile(historyFile(ws), 'utf8');
      const firstLine = text.slice(0, text.indexOf('\n') + 1);
      await truncate(historyFile(ws), firstLine.length);
      await ix.reconcile();
      expect(ix.counts().history).toBe(1);
      // Replaced by another file (another inode) of the same size: read again.
      const tmp = `${historyFile(ws)}.new`;
      await writeFile(tmp, firstLine.replace('"run"', '"rnd"'));
      await rename(tmp, historyFile(ws));
      await ix.reconcile();
      expect(ix.history().map((h) => h.kind)).toEqual(['rnd']);
      // Gone: no history.
      await rm(historyFile(ws));
      await ix.reconcile();
      expect(ix.counts().history).toBe(0);
    } finally {
      ix.close();
    }
  });

  it('rebuilt when garbage, truncated or of another schema (its -wal and -shm with it); reused otherwise', async () => {
    const file = indexFile(ws);
    (await fresh()).close();
    // Garbage: SQLite opens it; the first query fails with errcode 26 (SQLITE_NOTADB).
    await writeFile(file, 'not a database at all, just text that is long enough to have a header.....');
    await writeFile(`${file}-wal`, 'stale');
    await writeFile(`${file}-shm`, 'stale');
    let ix = await fresh();
    expect(ix.rebuilt).toBe('corrupt');
    await ix.reconcile();
    expect(ix.counts().projects).toBe(1);
    ix.close();
    // Truncated to half: corrupt.
    const size = (await stat(file)).size;
    await truncate(file, Math.floor(size / 2));
    await rm(`${file}-wal`, { force: true });
    ix = await fresh();
    expect(ix.rebuilt).toBe('corrupt');
    await ix.reconcile();
    expect(ix.search('blend').map((h) => h.ref)).toEqual([P]);
    ix.close();
    // A damaged page that opens and reads (quick_check lists the damage instead of throwing): corrupt.
    await writeFile(historyFile(ws), Array.from({ length: 400 }, (_, n) => line({ at: `2026-10-19T10:00:${String(n % 60).padStart(2, '0')}.000Z`, kind: 'run', project: P, job: `j${n}` })).join(''));
    ix = await fresh();
    await ix.reconcile();
    expect(ix.counts().history).toBe(400);
    ix.close();
    await ix0Pages(file);
    ix = await fresh();
    expect(ix.rebuilt).toBe('corrupt');
    await ix.reconcile();
    ix.close();
    // Another schema: rebuilt.
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(file);
    db.prepare("UPDATE meta SET value = '0' WHERE key = 'schema'").run();
    db.close();
    ix = await fresh();
    expect(ix.rebuilt).toBe('schema');
    ix.close();
    ix = await fresh();
    expect(ix.rebuilt).toBeUndefined();
    ix.close();
    expect(isCorruptionError({ errcode: 26 })).toBe(true);
    expect(isCorruptionError({ errcode: 11 })).toBe(true);
    expect(isCorruptionError({ code: 'ERR_SQLITE_ERROR', errcode: 1 })).toBe(false);
  });

  it('an index file (or its -wal) that is a symbolic link is removed and rebuilt, never followed: the target is never created (review A L4)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'studio-index-link-'));
    try {
      await fixtureWorkspace(dir);
      const c = { ...(await loadWorkspaceConfig(dir)), policy: PERSON_POLICY };
      const file = indexFile(dir);
      await mkdir(join(dir, '.retake'), { recursive: true });
      const target = join(dir, 'elsewhere', 'planted.sqlite');
      await symlink(target, file);
      let ix = await WorkspaceIndex.open(c, { queue: new FileJobQueue(c.root) });
      expect(ix?.rebuilt).toBe('not_a_file');
      await ix!.reconcile();
      expect(ix!.counts().projects).toBe(1);
      ix!.close();
      expect((await lstat(file)).isFile()).toBe(true);
      for (const f of [target, `${target}-wal`, `${target}-shm`]) await expect(lstat(f)).rejects.toThrow(/ENOENT/);
      // A planted -wal link next to a sound db: the same.
      await rm(`${file}-wal`, { force: true });
      await symlink(`${target}-wal`, `${file}-wal`);
      ix = await WorkspaceIndex.open(c, { queue: new FileJobQueue(c.root) });
      expect(ix?.rebuilt).toBe('not_a_file');
      ix!.close();
      expect((await lstat(`${file}-wal`).catch(() => null))?.isSymbolicLink() ?? false).toBe(false);
      await expect(lstat(`${target}-wal`)).rejects.toThrow(/ENOENT/);
      ix = await WorkspaceIndex.open(c, { queue: new FileJobQueue(c.root) });
      expect(ix?.rebuilt).toBeUndefined();
      ix!.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('render records, run records and READMEs linked out of the project are never indexed; a FIFO is never opened (review A L3)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'studio-index-out-'));
    try {
      await fixtureWorkspace(dir);
      const proj = join(dir, 'projects', P);
      const outside = join(dir, 'outside');
      await mkdir(outside, { recursive: true });
      await writeFile(join(outside, 'r.json'), JSON.stringify({ version: 1, id: 'outsidernine', scenario: 'outsiderscene', status: 'succeeded', template: 'x', created_at: '2026-10-16T08:00:00.000Z' }));
      await writeFile(join(outside, 'run.json'), JSON.stringify({ version: 1, id: '20261018-080000-outsiderrun', project: P, scenario: 'outsiderrun', mode: 'dry', status: 'succeeded', started_at: '2026-10-18T08:00:00.000Z', env: 'local', steps_total: 1, steps_done: 1 }));
      await writeFile(join(outside, 'readme.md'), '# outsidertext\n');
      await mkdir(join(proj, 'renders'), { recursive: true });
      await writeFile(join(proj, 'renders', 'quote-v1.json'), JSON.stringify({ version: 1, id: 'quote-v1', scenario: 'quote', status: 'succeeded', template: 'editorial', created_at: '2026-10-16T08:00:00.000Z' }));
      await symlink(join(outside, 'r.json'), join(proj, 'renders', 'leak-v1.json'));
      await mkdir(join(proj, 'runs', '20261018-080000-outsiderrun'), { recursive: true });
      await symlink(join(outside, 'run.json'), join(proj, 'runs', '20261018-080000-outsiderrun', 'run.json'));
      await rm(join(proj, 'README.md'), { force: true });
      await symlink(join(outside, 'readme.md'), join(proj, 'README.md'));
      // FIFOs: a read would block for ever (no writer).
      expect(spawnSync('mkfifo', [join(proj, 'renders', 'pipe-v1.json')]).status).toBe(0);
      await mkdir(join(proj, 'runs', '20261018-090000-pipe'), { recursive: true });
      expect(spawnSync('mkfifo', [join(proj, 'runs', '20261018-090000-pipe', 'run.json')]).status).toBe(0);
      const ix = await WorkspaceIndex.open({ ...(await loadWorkspaceConfig(dir)), policy: PERSON_POLICY }, { queue: new FileJobQueue(dir) });
      try {
        const done = await Promise.race([ix!.reconcile().then(() => 'reconciled'), new Promise((r) => setTimeout(() => r('blocked on a FIFO'), 5000))]);
        expect(done).toBe('reconciled');
        expect(ix!.search('outsider')).toEqual([]);
        expect(ix!.search('quote').map((h) => `${h.kind}:${h.ref}`)).toContain('render:quote-v1');
        expect(ix!.counts().renders).toBe(1);
      } finally {
        ix!.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('a Node.js without node:sqlite: no index (null), nothing written', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'studio-index-nosqlite-'));
    try {
      await fixtureWorkspace(dir);
      const ix = await WorkspaceIndex.open({ ...(await loadWorkspaceConfig(dir)), policy: PERSON_POLICY }, { queue: new FileJobQueue(dir), loader: async () => null });
      expect(ix).toBeNull();
      await expect(stat(indexFile(dir))).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('the loader swallows only the experimental notice of node:sqlite, matched by its message (B11)', async () => {
    const src = pathToFileURL(join(REPO, 'packages', 'engine', 'src', 'index-db', 'sqlite.ts')).href;
    const code = [
      `const { loadSqlite } = await import(${JSON.stringify(src)});`,
      'const p = loadSqlite();',
      "process.emitWarning('another notice in the same window', 'ExperimentalWarning');",
      "console.log('loaded', (await p) !== null);",
    ].join('\n');
    const { stdout, stderr } = await promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], { cwd: REPO });
    expect(stdout.trim()).toBe('loaded true');
    expect(stderr).toContain('another notice in the same window');
    expect(stderr).not.toContain('SQLite');
  });

  it('a search query never carries FTS syntax: quoted prefix terms, bound as a parameter', async () => {
    expect(ftsQuery('tea blend')).toBe('"tea"* "blend"*');
    expect(ftsQuery('say "hi"')).toBe('"say"* "hi"*');
    expect(ftsQuery('  ')).toBeNull();
    expect(ftsQuery('a"b')).toBe('"a"* "b"*');
    const ix = await fresh();
    try {
      await ix.reconcile();
      for (const q of ['"', '*', 'NEAR(tea blend)', '-tea', 'tea OR x', 'title:tea', "'; DROP TABLE runs; --", '^tea', 'tea AND', '(((', '"\u0000"', 'é'.repeat(300)]) {
        expect(() => ix.search(q), q).not.toThrow();
      }
      expect(ix.search('tea OR zzz')).toEqual([]);
      // NEAR is a word to find, not an operator.
      expect(ix.search('NEAR(tea blend)')).toEqual([]);
      expect(ix.search('(tea) blend').map((h) => h.ref)).toEqual([P]);
      expect(ix.counts().runs).toBeGreaterThan(0);
    } finally {
      ix.close();
    }
  });
});

describe('the activity feed and the job watch (critique B2)', () => {
  it('unfinished jobs live from the queue — a SIGKILLed worker reads interrupted at once — then history, newest first', async () => {
    const ix = await fresh();
    const queue = new FileJobQueue(ws);
    const watch = new JobsWatch(queue);
    expect(await watch.poll()).toEqual([]);
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    try {
      await ix.reconcile();
      const started = await processStart(child.pid!);
      const id = newJobId();
      await mkdir(join(queue.files.dir, id), { recursive: true });
      const job = {
        version: 1,
        id,
        kind: 'run',
        input: { v: 1, kind: 'run', project: P, scenario: 'quote', mode: 'capture', run_id: '20261018-100000-quote', submitted_by: 'ui' },
        state: 'running',
        created_at: '2026-10-18T10:00:00.000Z',
        started_at: '2026-10-18T10:00:01.000Z',
        worker: { pid: child.pid, ...(started !== null ? { started_at: new Date(started).toISOString() } : {}), host: 'x' },
        progress: { steps_done: 1, steps_total: 3 },
      };
      await writeFile(join(queue.files.dir, id, 'job.json'), JSON.stringify(job));
      expect(await watch.poll()).toEqual([id]);
      expect(await watch.poll()).toEqual([]);
      const a = await ix.activity({ limit: 5 });
      expect(a[0]).toMatchObject({ source: 'queue', job: id, state: 'running', kind: 'run', project: P, submitted_by: 'ui', run: { id: '20261018-100000-quote', scenario: 'quote', mode: 'capture' }, progress: { steps_done: 1 } });
      expect(a.slice(1).every((x) => x.source === 'history')).toBe(true);
      const kill = new Promise((r) => child.once('exit', r));
      child.kill('SIGKILL');
      await kill;
      const b = await ix.activity({ limit: 5 });
      expect(b[0]).toMatchObject({ source: 'queue', job: id, state: 'interrupted' });
      expect(await watch.poll()).toEqual([id]);
      expect(await watch.poll()).toEqual([]);
      expect((await ix.activity({ project: 'nope' }))).toEqual([]);
      expect(JSON.parse(await readFile(join(queue.files.dir, id, 'job.json'), 'utf8')).state).toBe('running');
    } finally {
      child.kill('SIGKILL');
      ix.close();
    }
  });

  it('a job folder listed before its job.json is looked at again: its later states are never missed (L5.10 flake fix)', async () => {
    // enqueue() makes the folder, then writes job.json atomically: a poll in between lists the id with nothing to read.
    const queue = new FileJobQueue(ws);
    const watch = new JobsWatch(queue);
    await watch.poll();
    const job = await queue.enqueue({ version: 1, kind: 'render', project: P, scenario: 'quote', run_id: '20261016-090000-catalogue', timeline_sha256: 'a'.repeat(64), render_id: 'quote-v9', overrides: {}, submitted_by: 'test' });
    const file = join(queue.files.dir, job.id, 'job.json');
    const text = await readFile(file, 'utf8');
    await rm(file);
    try {
      expect(await watch.poll()).toEqual([]);
      expect(await watch.poll()).toEqual([]);
      // job.json lands, already failed (queued and failed between two polls): told once, then history.
      await writeFile(file, JSON.stringify({ ...JSON.parse(text), state: 'failed', finished_at: '2026-10-18T10:00:02.000Z', error: { code: 'internal', message: 'failed' } }));
      expect(await watch.poll()).toEqual([job.id]);
      expect(watch.record(job.id)?.state).toBe('failed');
      expect(await watch.poll()).toEqual([]);
    } finally {
      await rm(join(queue.files.dir, job.id), { recursive: true, force: true });
    }
  });
});

describe('the activity feed reads a finished job once (review B L1)', () => {
  it('a second call reads only the files of unfinished jobs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'studio-index-jobs-'));
    try {
      await fixtureWorkspace(dir);
      const queue = new FileJobQueue(dir);
      const write = async (state: string) => {
        const id = newJobId();
        await mkdir(join(queue.files.dir, id), { recursive: true });
        await writeFile(join(queue.files.dir, id, 'job.json'), JSON.stringify({ version: 1, id, kind: 'run', input: { v: 1, kind: 'run', project: P, scenario: 'quote', mode: 'dry', run_id: '20261018-100000-quote', submitted_by: 'mcp' }, state, created_at: new Date().toISOString(), ...(state === 'queued' ? {} : { finished_at: new Date().toISOString() }) }));
        return id;
      };
      for (let i = 0; i < 40; i++) await write(i % 2 ? 'succeeded' : 'failed');
      const queued = await write('queued');
      const ix = await WorkspaceIndex.open({ ...(await loadWorkspaceConfig(dir)), policy: PERSON_POLICY }, { queue: new FileJobQueue(dir) });
      const spy = vi.spyOn(FileJobQueue.prototype, 'stored');
      try {
        expect((await ix!.activity({ limit: 5 }))[0]).toMatchObject({ source: 'queue', job: queued });
        expect(spy.mock.calls.length).toBe(41);
        spy.mockClear();
        expect((await ix!.activity({ limit: 5 }))[0]).toMatchObject({ source: 'queue', job: queued });
        expect(spy.mock.calls.map((c) => c[0])).toEqual([queued]);
      } finally {
        spy.mockRestore();
        ix!.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('the bounded stat poll', () => {
  it('signatures per source; a README edit is a readme change of its project', async () => {
    const a = await scanSources(cfg);
    expect([...a.keys()]).toEqual(expect.arrayContaining([`project:${P}`, `readme:${P}`, `runs:${P}`, `renders:${P}`, 'history']));
    expect(diffSources(a, await scanSources(cfg))).toEqual([]);
    await new Promise((r) => setTimeout(r, 20));
    await writeFile(join(project(), 'README.md'), '# Northfield\n\nAgain.\n');
    const keys = diffSources(a, await scanSources(cfg));
    expect(keys).toEqual([`readme:${P}`]);
    expect(workspaceChanges(keys)).toEqual({ projects: [P], readme: [P], scenarios: [], history: false });
  });
});
