/**
 * The small helpers written once (core base: errorMessage, decodeOrKeep, sleep; core io: realpathOr, realTarget,
 * processTree, pidExists, lstatOrNull, realFolderState), each with the rule its former copies held.
 */
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decodeOrKeep, errorMessage, sleep } from '../src/entries/base.js';
import { groupTree, lstatOrNull, pidExists, processTree, realFolderState, realTarget, realpathOr } from '../src/io/index.js';
import type { ProcInfo } from '../src/io/index.js';

let dir: string;
beforeAll(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'retake-helpers-')));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('core base', () => {
  it('errorMessage: an Error’s message, any other throw as text', () => {
    expect(errorMessage(new TypeError('bad'))).toBe('bad');
    expect(errorMessage('plain')).toBe('plain');
    expect(errorMessage(42)).toBe('42');
    expect(errorMessage(undefined)).toBe('undefined');
    expect(errorMessage({ message: 'not an Error' })).toBe('[object Object]');
  });

  it('decodeOrKeep: decoded, or as written when it is no valid percent-encoding', () => {
    expect(decodeOrKeep('a%20b')).toBe('a b');
    expect(decodeOrKeep('100%')).toBe('100%');
    expect(decodeOrKeep('%E0%A4%A')).toBe('%E0%A4%A');
  });

  it('sleep settles after its time', async () => {
    const t = performance.now();
    await sleep(20);
    expect(performance.now() - t).toBeGreaterThanOrEqual(15);
  });
});

describe('core io', () => {
  it('realpathOr: the real path, else the fallback given', async () => {
    await mkdir(join(dir, 'real'));
    await symlink(join(dir, 'real'), join(dir, 'link'));
    expect(realpathOr(join(dir, 'link'), 'x')).toBe(join(dir, 'real'));
    expect(realpathOr(join(dir, 'missing'), undefined)).toBeUndefined();
    expect(realpathOr(join(dir, 'missing'), 'as given')).toBe('as given');
  });

  it('realTarget: the part that exists resolved, a missing tail kept under its real parent', () => {
    expect(realTarget(join(dir, 'link', 'a', 'b.txt'))).toBe(join(dir, 'real', 'a', 'b.txt'));
    expect(realTarget(join(dir, 'link'))).toBe(join(dir, 'real'));
  });

  it('lstatOrNull and realFolderState', async () => {
    await writeFile(join(dir, 'file'), 'x');
    expect(await lstatOrNull(join(dir, 'missing'))).toBeNull();
    expect(await lstatOrNull(join(dir, 'file', 'below'))).toBeNull(); // ENOTDIR
    expect((await lstatOrNull(join(dir, 'link')))?.isSymbolicLink()).toBe(true);
    expect(await realFolderState(join(dir, 'real'))).toBe('ok');
    expect(await realFolderState(join(dir, 'link'))).toBe('a symbolic link');
    expect(await realFolderState(join(dir, 'file'))).toBe('not a folder');
    expect(await realFolderState(join(dir, 'missing'))).toBe('missing');
  });

  it('processTree: the picked processes and every descendant by parent pid, once each', () => {
    const p = (pid: number, ppid: number, pgid: number): ProcInfo => ({ pid, ppid, pgid, start: 0 }) as ProcInfo;
    const table = [p(10, 1, 10), p(11, 10, 10), p(12, 11, 99), p(13, 12, 99), p(20, 1, 20), p(21, 20, 10)];
    const pids = (ps: ProcInfo[]) => ps.map((x) => x.pid).sort((a, b) => a - b);
    expect(pids(processTree(table, (x) => x.pid === 11))).toEqual([11, 12, 13]);
    // A group's members and the children that left it (12 under 11, then 13).
    expect(pids(groupTree(table, 10))).toEqual([10, 11, 12, 13, 21]);
    expect(processTree(table, () => false)).toEqual([]);
  });

  it('pidExists: this process, a live one; not a pid that is gone', () => {
    expect(pidExists(process.pid)).toBe(true);
    expect(pidExists(process.ppid)).toBe(true);
    expect(pidExists(2 ** 22 + 12345)).toBe(false);
  });
});
