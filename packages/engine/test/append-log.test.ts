/**
 * The workspace's two line logs, one discipline (L7.26, U15 — finding P8): the journal (`.retake/journal.jsonl`) and the
 * job history (`.retake/history.jsonl`) are appended by store/append-log.ts with the same guarantee — a line written
 * whole under the log's lock, a torn last line closed before the next one, synced before the append returns, never
 * through a symbolic link — and read by the same reader, each log's parser skipping a torn or foreign line. Real
 * processes write them (test/fixtures/log-writer.mts): one killed mid-append holding the lock, one slow writer holding
 * it, several appending at once. A normal line's bytes are its writer's, unchanged.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { HISTORY_VERSION, ManualClock, appendHistory, appendJournal, historyFile, journalFile, journalLine, readJournal, stampOf, usageCounts } from '../src/index.js';

const REPO = resolve(import.meta.dirname, '../../..');
const WRITER = join(REPO, 'packages', 'engine', 'test', 'fixtures', 'log-writer.mts');
const by = { client: 'test', channel: 'cli', trust: 'author' } as const;
const savedHome = process.env.RETAKE_HOME;
let base: string;
let n = 0;

/** A new workspace folder of its own. */
async function workspace(): Promise<string> {
  const root = join(base, `ws-${n++}`);
  await mkdir(root, { recursive: true });
  return root;
}

/** Start the log writer; `exited`: its exit code and signal; `line()`: its next stdout line. */
function writer(...args: string[]) {
  const child = spawn(process.execPath, ['--conditions=source', '--import', 'tsx', WRITER, ...args], { cwd: REPO, stdio: ['pipe', 'pipe', 'pipe'] });
  let err = '';
  child.stderr.on('data', (d: Buffer) => (err += d.toString()));
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null; err: string }>((r) => child.on('exit', (code, signal) => r({ code, signal, err })));
  return { child, exited, line: async () => (await lines.next()).value as string | undefined };
}

const journalEntry = (path: string) => ({ by, op: 'write' as const, what: 'scenario' as const, path, outcome: 'ok' });
const historyEntry = (job: string) => ({ job, kind: 'render', submitted_by: 'test' as const, state: 'succeeded', counted: { captures: 0, dry_runs: 0, renders: 1 } });
const LOGS = [
  { name: 'journal.jsonl', file: journalFile, append: (root: string, tag: string, clock: ManualClock) => appendJournal(root, journalEntry(`p/${tag}`), clock) },
  { name: 'history.jsonl', file: historyFile, append: (root: string, tag: string, clock: ManualClock) => appendHistory(root, historyEntry(tag), clock) },
] as const;

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), 'engine-append-log-'));
  process.env.RETAKE_HOME = join(base, '.home');
});

afterAll(async () => {
  if (savedHome === undefined) delete process.env.RETAKE_HOME;
  else process.env.RETAKE_HOME = savedHome;
  await rm(base, { recursive: true, force: true });
});

describe('the journal and the history: one append discipline (L7.26)', () => {
  it("a normal line's bytes are its writer's: the journal's journalLine, the history's JSON line; both created owner-only (an existing history keeps its mode)", async () => {
    const root = await workspace();
    const clock = new ManualClock('2026-03-04T05:06:07.008Z');
    await appendJournal(root, journalEntry('p/a'), clock);
    await appendJournal(root, { ...journalEntry('p/b'), project: 'p', if_match: null, sha256: 'a'.repeat(64), bytes: 3 }, clock);
    expect(await readFile(journalFile(root), 'utf8')).toBe(
      journalLine(journalEntry('p/a'), clock) + journalLine({ ...journalEntry('p/b'), project: 'p', if_match: null, sha256: 'a'.repeat(64), bytes: 3 }, clock),
    );
    expect(await readFile(journalFile(root), 'utf8')).toBe(
      '{"v":1,"at":"2026-03-04T05:06:07.008Z","by":{"client":"test","channel":"cli","trust":"author"},"op":"write","what":"scenario","path":"p/a","outcome":"ok"}\n' +
        `{"v":1,"at":"2026-03-04T05:06:07.008Z","by":{"client":"test","channel":"cli","trust":"author"},"op":"write","what":"scenario","path":"p/b","outcome":"ok","project":"p","if_match":null,"sha256":"${'a'.repeat(64)}","bytes":3}\n`,
    );
    await appendHistory(root, historyEntry('j1'), clock);
    await appendHistory(root, { ...historyEntry('j2'), at: '2026-01-01T00:00:00.000Z' }, clock);
    expect(await readFile(historyFile(root), 'utf8')).toBe(
      `{"v":${HISTORY_VERSION},"at":"2026-03-04T05:06:07.008Z","job":"j1","kind":"render","submitted_by":"test","state":"succeeded","counted":{"captures":0,"dry_runs":0,"renders":1}}\n` +
        `{"v":${HISTORY_VERSION},"at":"2026-01-01T00:00:00.000Z","job":"j2","kind":"render","submitted_by":"test","state":"succeeded","counted":{"captures":0,"dry_runs":0,"renders":1}}\n`,
    );
    expect((await stat(journalFile(root))).mode & 0o777).toBe(0o600);
    expect((await stat(historyFile(root))).mode & 0o777).toBe(0o600);
    // An existing history keeps its mode: nothing chmods it.
    const older = await workspace();
    await mkdir(join(older, '.retake'), { recursive: true });
    await writeFile(historyFile(older), '', { mode: 0o644 });
    await chmod(historyFile(older), 0o644);
    await appendHistory(older, historyEntry('j3'), clock);
    expect((await stat(historyFile(older))).mode & 0o777).toBe(0o644);
    // Each append released its lock.
    for (const lock of ['journal.lock', 'history.lock']) expect(existsSync(join(root, '.retake', 'locks', lock))).toBe(false);
  });

  for (const log of LOGS) {
    it(`a writer killed mid-append holding the lock leaves a torn line the readers skip; the next append breaks the stale lock, closes the torn line and is whole (${log.name})`, async () => {
      const root = await workspace();
      const clock = new ManualClock('2026-03-04T05:06:07.008Z');
      await log.append(root, 'before', clock);
      const first = await readFile(log.file(root), 'utf8');
      const killed = await writer('torn', root, log.name).exited;
      expect(killed.signal, killed.err).toBe('SIGKILL');
      const torn = await readFile(log.file(root), 'utf8');
      expect(torn.startsWith(first) && torn.length > first.length && !torn.endsWith('\n')).toBe(true);
      // The killed writer's lock is left behind.
      expect(existsSync(join(root, '.retake', 'locks', log.name.replace('.jsonl', '.lock')))).toBe(true);
      // The readers skip the torn line: the journal (whole, and from its end) and the history's counters.
      expect((await readJournal(root)).map((e) => ('path' in e ? e.path : ''))).toEqual(log.name === 'journal.jsonl' ? ['p/before'] : []);
      expect((await readJournal(root, { limit: 5 })).length).toBe(log.name === 'journal.jsonl' ? 1 : 0);
      expect((await usageCounts(root)).entries).toBe(log.name === 'history.jsonl' ? 1 : 0);
      // The next append: the dead holder's lock is broken (no wait), the torn line closed, the new line whole.
      const t0 = Date.now();
      await log.append(root, 'after', clock);
      expect(Date.now() - t0).toBeLessThan(4_000);
      const text = await readFile(log.file(root), 'utf8');
      expect(text.startsWith(torn + '\n')).toBe(true);
      expect(text.slice(torn.length + 1)).toBe(first.replace(/before/g, 'after'));
      if (log.name === 'journal.jsonl') expect((await readJournal(root)).map((e) => ('path' in e ? e.path : ''))).toEqual(['p/before', 'p/after']);
      else expect((await usageCounts(root)).entries).toBe(2);
      expect(existsSync(join(root, '.retake', 'locks', log.name.replace('.jsonl', '.lock')))).toBe(false);
    }, 60_000);

    it(`an append waits for a live writer holding the lock — the other line is never split (${log.name})`, async () => {
      const root = await workspace();
      const clock = new ManualClock('2026-03-04T05:06:07.008Z');
      const slow = writer('slow', root, log.name, '800');
      expect(await slow.line()).toBe('locked');
      await log.append(root, 'mine', clock);
      expect((await slow.exited).code).toBe(0);
      const lines = (await readFile(log.file(root), 'utf8')).split('\n');
      // The slow writer's line whole, then this one: nothing in between, no empty line.
      expect(lines).toHaveLength(3);
      expect(lines[2]).toBe('');
      expect(JSON.parse(lines[0]!)).toMatchObject(log.name === 'journal.jsonl' ? { path: 'p/slow' } : { job: 'slow' });
      expect(JSON.parse(lines[1]!)).toMatchObject(log.name === 'journal.jsonl' ? { path: 'p/mine', at: stampOf(clock) } : { job: 'mine', at: stampOf(clock) });
    }, 60_000);
  }

  it("processes appending at once after a torn line: every line whole and once, each writer's in order, the torn line closed once (no empty line)", async () => {
    const root = await workspace();
    await mkdir(join(root, '.retake'), { recursive: true });
    await writeFile(journalFile(root), '{"v":1,"at":"2026-');
    await writeFile(historyFile(root), '{"v":1,"at":"2026-');
    const tags = ['a', 'b', 'c', 'd'];
    const count = 15;
    const writers = tags.map((t) => writer('append', root, t, String(count)));
    // Released together once every process is up (each waits on its stdin).
    await new Promise((r) => setTimeout(r, 1_500));
    for (const w of writers) w.child.stdin.end('go\n');
    for (const w of writers) {
      const r = await w.exited;
      expect(r.code, r.err).toBe(0);
    }
    for (const file of [journalFile(root), historyFile(root)]) {
      const text = await readFile(file, 'utf8');
      expect(text.endsWith('\n')).toBe(true);
      const lines = text.slice(0, -1).split('\n');
      expect(lines[0]).toBe('{"v":1,"at":"2026-');
      expect(lines.slice(1).every((l) => l !== '')).toBe(true);
      const names = lines.slice(1).map((l) => {
        const e = JSON.parse(l) as { path?: string; job?: string };
        return (e.path ?? e.job)!.replace(/^p\//, '');
      });
      expect(names).toHaveLength(tags.length * count);
      expect(new Set(names).size).toBe(names.length);
      for (const t of tags) expect(names.filter((x) => x.startsWith(`${t}-`))).toEqual(Array.from({ length: count }, (_, i) => `${t}-${i}`));
    }
    expect((await readJournal(root)).length).toBe(tags.length * count);
    expect((await usageCounts(root)).renders).toBe(tags.length * count);
  }, 120_000);

  it('the appends of one process queue in memory, in the order they were made (only another process meets the lock file)', async () => {
    const root = await workspace();
    const clock = new ManualClock('2026-03-04T05:06:07.008Z');
    await Promise.all(Array.from({ length: 60 }, (_, i) => appendJournal(root, journalEntry(`p/${i}`), clock)));
    expect((await readJournal(root)).map((e) => ('path' in e ? e.path : ''))).toEqual(Array.from({ length: 60 }, (_, i) => `p/${i}`));
    expect(existsSync(join(root, '.retake', 'locks', 'journal.lock'))).toBe(false);
  });

  it('never through a symbolic link: a linked log is left as it is and the failure is said on stderr (the work is not failed)', async () => {
    const root = await workspace();
    await mkdir(join(root, '.retake'), { recursive: true });
    const elsewhere = join(base, `elsewhere-${n++}`);
    await writeFile(elsewhere, 'kept\n');
    await symlink(elsewhere, historyFile(root));
    const said = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await appendHistory(root, historyEntry('j1'), new ManualClock('2026-03-04T05:06:07.008Z'));
      expect(said.mock.calls.map((c) => String(c[0])).join('')).toContain('retake: the job history (.retake/history.jsonl) could not be written');
    } finally {
      said.mockRestore();
    }
    expect(await readFile(elsewhere, 'utf8')).toBe('kept\n');
    expect((await lstat(historyFile(root))).isSymbolicLink()).toBe(true);
  });
});
