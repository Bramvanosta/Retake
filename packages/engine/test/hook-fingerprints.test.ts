/**
 * The fingerprints human approvals are bound to (L3.1, R-MCP-35; a signed approval names one), through the HookRunner
 * port (L7.11): the hooks package behind it gives every fingerprint, and the files it binds, exactly as before the port.
 * The table's values were computed on the build before the port (2537130: .private/l7/L7.11-differential/fp.mjs), for
 * the same project files: a changed formula, field or order fails here, whichever side moved.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { HookStep } from '@retake/core';
import { hookFiles, hookFingerprint } from '@retake/hooks';
import { packageHookRunner } from '../src/hook-run/package-hooks.js';
import type { HookPlace } from '../src/hook-run/runner.js';

// The hooks as their files declare them (a fingerprint hashes the raw hook, whatever it holds: `confirm` on an http
// spec included).
const ROWS: Array<[object, Omit<HookPlace, 'files'>, Record<string, string>, string]> = [
  [{ 'shell': 'echo hello' }, { 'phase': 'setup', 'index': 0, 'env': 'staging' }, {}, 'a10c7ad451b18908cd9fb5f701a6eb0c8626075498a9ee87b5680fe26f9612f6'],
  [{ 'shell': 'echo hello' }, { 'phase': 'setup', 'index': 1, 'env': 'staging' }, {}, '437b43fb74cf106d06b42b39f0fd0f7805bdedf7489211020ea919ec7905ffa4'],
  [{ 'shell': 'echo hello' }, { 'phase': 'teardown', 'index': 0, 'env': 'staging' }, {}, '08f00e7072a35a8759c3e544109dd1fc8cbd1f777785bb738c0e3139912e4be9'],
  [{ 'shell': 'echo hello' }, { 'phase': 'setup', 'index': 0, 'env': 'local' }, {}, '30dd6cc83e3cd885d22fe13ac3e4afb9360120ab106e5010f3dc08203b7b42a8'],
  [
    { 'name': 'seed', 'shell': { 'run': 'sh scripts/seed.sh', 'rollback': 'echo undo' } },
    { 'phase': 'setup', 'index': 0, 'env': 'staging' },
    { 'scripts/seed.sh': '0fcabd7c97e9866df13df0867d5786569a6854b4598f5949f95355d521397d5e' },
    '92517dfd6dd983a5e91ca8c35421da14cd5ab59dd95845c2333ad493f5e87021',
  ],
  [
    { 'shell': { 'run': './seed.sh --fast', 'cwd': 'scripts' } },
    { 'phase': 'seed', 'index': 2, 'env': 'sandbox' },
    { 'scripts/./seed.sh': '0fcabd7c97e9866df13df0867d5786569a6854b4598f5949f95355d521397d5e' },
    '7c9a8302cb4a97a0ee236bf0b562574b2ad4fd7f68aa830fef7540790aaec3b1',
  ],
  [
    { 'sql': { 'db': '{{env:DB}}', 'file': 'hooks/sql/seed.sql', 'rollback': { 'file': 'hooks/sql/undo.sql' } } },
    { 'phase': 'setup', 'index': 0, 'env': 'staging' },
    { 'hooks/sql/seed.sql': '09777820b7522a91b900d8ab618a42c17c60ce4aed0423365c9fde67aa3091be', 'hooks/sql/undo.sql': '5f5139d9416eb5ee15a084e7bd8e4b92528a1fc56486280c7ce7b43d3c84b2a8' },
    '2e4c646721eafe532e520f67258185abeb9909b70b1c0bd3bb622b39649ba227',
  ],
  [
    { 'http': { 'method': 'DELETE', 'url': '{{api}}/items/{{vars.id}}', 'confirm': true } },
    { 'phase': 'reset', 'index': 0, 'env': 'staging' },
    {},
    '7a091fd37e3a542902c257f2d9eafa3c22193ea7c1b07a959a7bcd9afc47161e',
  ],
  [
    { 'js': { 'file': 'hooks/page.js', 'page': 'app' } },
    { 'phase': 'step', 'index': 3, 'env': 'staging' },
    { 'hooks/page.js': 'a4688a271f970bc9d4bd5ad3a736ff802730df3b5aa1024e49aa2b286ede3312' },
    '86f2b3e71fdf500a1f7bfaec515e42ddad7fab5f97709c9026731fedefcacc5f',
  ],
  [{ 'shell': 'rm -rf build' }, { 'phase': 'reset', 'index': 1, 'env': 'sandbox' }, {}, '699eb90415a9599ea9d1015777fcd999c9430fd5d9314c49b59f83ee38bbd51e'],
];
const TABLE = ROWS.map(([hook, ...rest]) => [hook as HookStep, ...rest] as const);

const dir = mkdtempSync(join(tmpdir(), 'retake-fingerprints-'));
mkdirSync(join(dir, 'hooks', 'sql'), { recursive: true });
mkdirSync(join(dir, 'scripts'), { recursive: true });
writeFileSync(join(dir, 'hooks', 'sql', 'seed.sql'), 'insert into t values (1);\n');
writeFileSync(join(dir, 'hooks', 'sql', 'undo.sql'), 'delete from t;\n');
writeFileSync(join(dir, 'scripts', 'seed.sh'), '#!/bin/sh\necho seeded\n');
writeFileSync(join(dir, 'hooks', 'page.js'), 'return 1;\n');
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('approval fingerprints through the HookRunner port', () => {
  const runner = packageHookRunner();

  it.each(TABLE.map((row, i) => [i, ...row] as const))('row %i: the files bound and the fingerprint are the ones of the build before the port', async (_i, hook, place, files, fingerprint) => {
    const viaPort = await runner.approval.files(hook, { projectDir: dir });
    expect(viaPort.files).toEqual(files);
    expect(viaPort.problems).toEqual([]);
    expect(await runner.approval.fingerprint(hook, { ...place, files: viaPort.files })).toBe(fingerprint);
    // The package itself, beside the port: the same values.
    expect(hookFiles(hook, { projectDir: dir }).files).toEqual(files);
    expect(hookFingerprint(hook, { ...place, files })).toBe(fingerprint);
  });

  it('a change of phase, position, environment or bound file is another fingerprint', async () => {
    const [hook, place, files, fingerprint] = TABLE[4]!;
    const other = new Set([
      await runner.approval.fingerprint(hook, { ...place, files, phase: 'teardown' }),
      await runner.approval.fingerprint(hook, { ...place, files, index: place.index + 1 }),
      await runner.approval.fingerprint(hook, { ...place, files, env: 'other' }),
      await runner.approval.fingerprint(hook, { ...place, files: { ...files, 'scripts/seed.sh': '0'.repeat(64) } }),
      await runner.approval.fingerprint(hook, { ...place }),
    ]);
    expect(other.size).toBe(5);
    expect(other.has(fingerprint)).toBe(false);
  });
});
