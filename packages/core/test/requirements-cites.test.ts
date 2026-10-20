/**
 * docs/requirements.json quotes test titles as evidence (`'<file> > <describe> > <it>'`): `node scripts/requirements.mjs
 * --check-cites` fails while one no longer names a test of its file (L3.8 review M3: a renamed test left three stale).
 */
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SCRIPT = join(ROOT, 'scripts', 'requirements.mjs');
const check = (...args: string[]) => spawnSync(process.execPath, [SCRIPT, '--check-cites', ...args], { cwd: ROOT, encoding: 'utf8' });

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ds-cites-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('quoted test titles in docs/requirements.json', () => {
  it('every quoted title names a test of its file', () => {
    const r = check();
    expect(r.stdout + r.stderr).toBe('');
    expect(r.status).toBe(0);
  });

  it('a stale title, a missing file and a wrong describe are named; a shortened or elided title passes', async () => {
    // another file: this one holds the bad titles too, in its expectations
    const file = 'packages/core/test/fixture-names.test.ts';
    const items = [
      { id: 'R-OK-01', evidence: `Test '${file} > fixture names are invented (R-ISS-10, R-PRIN-01) > every lot, product, producer, award and café of the seed avoids them'.` },
      { id: 'R-OK-02', evidence: `Tests '${file} > fixture names are invented > no former real farm, station …', and more.` },
      { id: 'R-OK-03', gap: `Not quoted as a title: ${file} (a file path only).` },
      { id: 'R-BAD-01', evidence: `Test '${file} > fixture names are invented (R-ISS-10, R-PRIN-01) > every seed name was renamed'.` },
      { id: 'R-BAD-02', evidence: `Test 'packages/core/test/no-such.test.ts > anything'.` },
      { id: 'R-BAD-03', gap: `Test '${file} > the fixture product > every lot, product, producer, award and café of the seed avoids them'.` },
    ];
    const json = join(dir, 'requirements.json');
    await writeFile(json, JSON.stringify({ items }));
    const r = check(json);
    expect(r.status).toBe(1);
    expect(r.stdout.trim().split('\n')).toEqual([
      `R-BAD-01 (evidence): ${file} has no test titled 'every seed name was renamed'`,
      'R-BAD-02 (evidence): packages/core/test/no-such.test.ts does not exist',
      `R-BAD-03 (gap): ${file} has no test titled 'the fixture product'`,
    ]);
  });
});
