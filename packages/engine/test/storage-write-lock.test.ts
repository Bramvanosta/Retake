/**
 * L4.3 (critique B1, B11): `writeText`'s `if_match` is check-then-rename, so two writers that read the same version
 * both passed their check and the last rename silently won (221 of 300 concurrent pairs in the critique's probe). A
 * write that checks a hash now holds the target's lock (`.retake/locks/write-*.lock`, the L3.6 TakeLock) from the
 * check to the rename: of two writers of one version exactly one succeeds and the other gets its `conflict` — in one
 * process (the Studio's own ops, MCP over HTTP) and across processes (`retake mcp` beside `retake ui`). And a save keeps
 * the replaced file's permissions, set explicitly (writeFile's `mode` is masked by the umask: 0664 became 0644).
 */
import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { Interface } from 'node:readline';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EngineError, LocalStorage, sha256Hex } from '../src/index.js';
import { REPO } from './helpers.js';

const LONG = 60_000;
let dir: string;
let storage: LocalStorage;

const outcome = (p: Promise<unknown>) =>
  p.then(
    () => 'ok' as const,
    (e: unknown) => (e instanceof EngineError ? e.code : String(e)),
  );

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ds-write-lock-'));
  storage = new LocalStorage(dir);
});

afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe('two writers of one version (critique B1)', () => {
  it('in one process: of two concurrent if_match writes exactly one succeeds, the other is a conflict, 100 times out of 100', async () => {
    const ref = 'scenarios/race.yaml';
    let current = (await storage.writeText(ref, 'v: 0\n', { ifMatch: null })).sha256;
    const tally = { both: 0, one: 0, none: 0 };
    for (let i = 1; i <= 100; i++) {
      const a = `v: ${i}a\n`;
      const b = `v: ${i}b\n`;
      const [ra, rb] = await Promise.all([outcome(storage.writeText(ref, a, { ifMatch: current })), outcome(storage.writeText(ref, b, { ifMatch: current }))]);
      const wins = [ra, rb].filter((r) => r === 'ok').length;
      tally[wins === 2 ? 'both' : wins === 1 ? 'one' : 'none']++;
      expect([ra, rb].sort()).toEqual(['conflict', 'ok']);
      const text = await readFile(join(dir, ref), 'utf8');
      expect(text).toBe(ra === 'ok' ? a : b);
      current = sha256Hex(text);
    }
    expect(tally).toEqual({ both: 0, one: 100, none: 0 });
    expect((await readdir(join(dir, 'scenarios'))).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    expect((await readdir(join(dir, '.retake', 'locks'))).filter((f) => !f.endsWith('.tmp'))).toEqual([]);
  }, LONG);

  it('review A M1: two spellings of one file on a case-insensitive disk share one lock — exactly one succeeds, 50 times', async () => {
    const ref = 'scenarios/case.yaml';
    let current = (await storage.writeText(ref, 'v: 0\n', { ifMatch: null })).sha256;
    let insensitive = true;
    try {
      await stat(join(dir, 'scenarios', 'CASE.yaml'));
    } catch {
      insensitive = false;
    }
    if (!insensitive) return; // a case-sensitive disk: two spellings are two files
    for (let i = 1; i <= 50; i++) {
      const [ra, rb] = await Promise.all([outcome(storage.writeText(ref, `v: ${i}a\n`, { ifMatch: current })), outcome(storage.writeText('scenarios/CASE.yaml', `v: ${i}b\n`, { ifMatch: current }))]);
      expect([ra, rb].sort()).toEqual(['conflict', 'ok']);
      current = sha256Hex(await readFile(join(dir, ref), 'utf8'));
    }
  }, LONG);

  it('across processes: a writer in a child process and one here, at the same moment, 40 times — never both', async () => {
    const ref = 'scenarios/cross.yaml';
    let current = (await storage.writeText(ref, 'v: 0\n', { ifMatch: null })).sha256;
    const child: ChildProcessWithoutNullStreams = spawn(process.execPath, ['--conditions=source', '--import', 'tsx', join(REPO, 'packages', 'engine', 'test', 'fixtures', 'text-writer.mts'), dir], { cwd: REPO });
    let err = '';
    child.stderr.on('data', (d: Buffer) => (err += d.toString()));
    const lines: Interface = createInterface({ input: child.stdout });
    const queue: string[] = [];
    const waiters: Array<(l: string) => void> = [];
    lines.on('line', (l) => {
      const w = waiters.shift();
      if (w) w(l);
      else queue.push(l);
    });
    const next = () => new Promise<string>((r) => (queue.length ? r(queue.shift()!) : waiters.push(r)));
    try {
      expect(await next(), err).toBe('ready');
      let both = 0;
      for (let i = 1; i <= 40; i++) {
        const mine = `v: ${i} here\n`;
        const theirs = `v: ${i} child\n`;
        const at = Date.now() + 60;
        child.stdin.write(`${JSON.stringify({ at, ref, text: theirs, ifMatch: current })}\n`);
        while (Date.now() < at) {
          /* spin to the agreed moment */
        }
        const here = await outcome(storage.writeText(ref, mine, { ifMatch: current }));
        const there = JSON.parse(await next()) as { ok: boolean; code?: string };
        const results = [here, there.ok ? 'ok' : there.code];
        if (results.every((r) => r === 'ok')) both++;
        expect(results.sort(), err).toEqual(['conflict', 'ok']);
        const text = await readFile(join(dir, ref), 'utf8');
        expect(text).toBe(here === 'ok' ? mine : theirs);
        current = sha256Hex(text);
      }
      expect(both).toBe(0);
    } finally {
      child.stdin.end();
      child.kill();
    }
  }, LONG);
});

describe('a save keeps the replaced file\'s permissions (critique B11)', () => {
  it('0600 stays 0600 and 0664 stays 0664 whatever the umask; a new file takes the default; through a link the target keeps its own', async () => {
    const secret = 'scenarios/private.yaml';
    const first = await storage.writeText(secret, 'a: 1\n', { ifMatch: null });
    await chmod(join(dir, secret), 0o600);
    const second = await storage.writeText(secret, 'a: 2\n', { ifMatch: first.sha256 });
    expect((await stat(join(dir, secret))).mode & 0o777).toBe(0o600);
    await chmod(join(dir, secret), 0o664);
    await storage.writeText(secret, 'a: 3\n', { ifMatch: second.sha256 });
    expect((await stat(join(dir, secret))).mode & 0o777).toBe(0o664);
    // No hash check (a plain write) keeps it too.
    await storage.writeText(secret, 'a: 4\n');
    expect((await stat(join(dir, secret))).mode & 0o777).toBe(0o664);

    const fresh = await storage.writeText('scenarios/new.yaml', 'b: 1\n', { ifMatch: null });
    expect(fresh.bytes).toBe(5);
    await writeFile(join(dir, 'probe.txt'), 'x');
    expect((await stat(join(dir, 'scenarios', 'new.yaml'))).mode & 0o777).toBe((await stat(join(dir, 'probe.txt'))).mode & 0o777);

    await mkdir(join(dir, 'docs'), { recursive: true });
    await writeFile(join(dir, 'docs', 'target.yaml'), 'c: 1\n', { mode: 0o640 });
    await chmod(join(dir, 'docs', 'target.yaml'), 0o640);
    await symlink('../docs/target.yaml', join(dir, 'scenarios', 'linked.yaml'));
    await storage.writeText('scenarios/linked.yaml', 'c: 2\n', { ifMatch: sha256Hex('c: 1\n') });
    expect(await readFile(join(dir, 'docs', 'target.yaml'), 'utf8')).toBe('c: 2\n');
    expect((await stat(join(dir, 'docs', 'target.yaml'))).mode & 0o777).toBe(0o640);
  });

  it('a write through a link and one to its target share one lock: of the two, one conflicts', async () => {
    await writeFile(join(dir, 'docs', 'shared.yaml'), 'd: 0\n');
    await symlink('../docs/shared.yaml', join(dir, 'scenarios', 'shared.yaml'));
    let current = sha256Hex('d: 0\n');
    for (let i = 1; i <= 50; i++) {
      const [a, b] = await Promise.all([
        outcome(storage.writeText('scenarios/shared.yaml', `d: ${i}a\n`, { ifMatch: current })),
        outcome(storage.writeText('docs/shared.yaml', `d: ${i}b\n`, { ifMatch: current })),
      ]);
      expect([a, b].sort()).toEqual(['conflict', 'ok']);
      current = sha256Hex(await readFile(join(dir, 'docs', 'shared.yaml')));
    }
  });
});
