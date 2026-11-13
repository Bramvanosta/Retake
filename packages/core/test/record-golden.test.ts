/**
 * The golden files' recorder (test-support golden.ts): RETAKE_WRITE_SNAPSHOTS=1 writes the new fixture and then fails
 * the test that changed it — a shell exporting it never turns a golden green whatever the code does.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { recordGolden } from '@retake/test-support/golden';
import { REPO } from '@retake/test-support/repo';

const dir = mkdtempSync(join(tmpdir(), 'retake-golden-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('recordGolden', () => {
  it('without RETAKE_WRITE_SNAPSHOTS: writes nothing, throws nothing', () => {
    const file = join(dir, 'untouched.json');
    writeFileSync(file, 'old\n');
    expect(() => recordGolden(file, 'new\n', {})).not.toThrow();
    expect(() => recordGolden(file, 'new\n', { RETAKE_WRITE_SNAPSHOTS: '0' })).not.toThrow();
    expect(readFileSync(file, 'utf8')).toBe('old\n');
  });

  it('with RETAKE_WRITE_SNAPSHOTS=1: writes a changed fixture, then fails asking for a review and a rerun', () => {
    const file = join(dir, 'changed.json');
    writeFileSync(file, 'old\n');
    expect(() => recordGolden(file, 'new\n', { RETAKE_WRITE_SNAPSHOTS: '1' })).toThrow(/^recorded .*changed\.json: review the diff and rerun without RETAKE_WRITE_SNAPSHOTS$/);
    expect(readFileSync(file, 'utf8')).toBe('new\n');
    // The same output again: nothing recorded, nothing to review.
    expect(() => recordGolden(file, 'new\n', { RETAKE_WRITE_SNAPSHOTS: '1' })).not.toThrow();
  });

  it('an image golden (bytes): written when its bytes changed, its folder made; the same bytes again: nothing to review', () => {
    const file = join(dir, 'images', 'cursor.png');
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    expect(() => recordGolden(file, png, { RETAKE_WRITE_SNAPSHOTS: '1' })).toThrow(/cursor\.png \(new\): review the diff/);
    expect(readFileSync(file).equals(png)).toBe(true);
    expect(() => recordGolden(file, Buffer.from(png), { RETAKE_WRITE_SNAPSHOTS: '1' })).not.toThrow();
    expect(() => recordGolden(file, Buffer.from([0x89, 0x50, 0x4e, 0x47, 9]), { RETAKE_WRITE_SNAPSHOTS: '1' })).toThrow(/^recorded .*cursor\.png: review/);
  });

  it('a fixture that did not exist is written and named new', () => {
    const file = join(dir, 'first.json');
    expect(() => recordGolden(file, '{}\n', { RETAKE_WRITE_SNAPSHOTS: '1' })).toThrow(/first\.json \(new\): review the diff/);
    expect(existsSync(file)).toBe(true);
  });

  it('is the only reader of RETAKE_WRITE_SNAPSHOTS in the tests: no golden writes its fixture by itself', () => {
    // git grep -l: the files that name `needle` (exit 1 when none); untracked files too (a new test before its commit).
    const grep = (needle: string, path: string) => {
      const r = spawnSync('git', ['grep', '--untracked', '-l', '-F', needle, '--', path], { cwd: REPO, encoding: 'utf8' });
      expect(r.status === 0 || r.status === 1, r.stderr).toBe(true);
      return r.stdout.trim().split('\n').filter(Boolean);
    };
    expect(grep(['process', 'env', 'RETAKE_WRITE_SNAPSHOTS'].join('.'), 'packages')).toEqual([]);
    // One switch for every golden: no other variable that records one (the image and JSON goldens' former
    // RETAKE_UPDATE_GOLDEN, or any RETAKE_*GOLDEN* / RETAKE_*SNAPSHOT* a test reads by itself), in the tests or the guide.
    const r = spawnSync('git', ['grep', '--untracked', '-n', '-E', ['process[.]env[.]RETAKE_[A-Z_]*(GOLDEN|SNAPSHOT)', 'RETAKE_UPDATE_GOLDEN'].join('|'), '--', 'packages', 'docs/guide'], {
      cwd: REPO,
      encoding: 'utf8',
    });
    expect(r.status === 0 || r.status === 1, r.stderr).toBe(true);
    expect(r.stdout.split('\n').filter((l) => l && !l.startsWith('packages/core/test/record-golden.test.ts:'))).toEqual([]);
    const users = grep('recordGolden(', 'packages').filter((f) => !/record-golden\.test\.ts$|test-support\/src\/golden\.ts$/.test(f));
    expect(users.length).toBeGreaterThanOrEqual(17);
  });
});
