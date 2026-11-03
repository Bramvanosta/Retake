/**
 * L5.13 (critique H4): the canary of the test environment — vitest.config.ts gives every run a scratch RETAKE_HOME
 * (never the person's ~/.retake, which holds their signed-in profiles) and drops the variables of the name before L5.13.
 * L5.13a reviews: the home of before L5.13 (or a link to a real home) is refused as RETAKE_HOME too (A M3), and no test
 * file leaves RETAKE_HOME unset for the tests after it (A M2: a later `main()` would look at the real home).
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OLD_DIR, OLD_ENV_PREFIX, oldEnvNames, retakeHome } from '../src/index.js';

const REPO = join(import.meta.dirname, '..', '..', '..');

describe('the test environment (vitest.config.ts)', () => {
  it('a test never runs on the real ~/.retake, and sees no variable of the old name', () => {
    expect(process.env.RETAKE_HOME?.trim()).toBeTruthy();
    expect(retakeHome()).not.toBe(join(homedir(), '.retake'));
    expect(oldEnvNames(process.env)).toEqual([]);
    expect(Object.keys(process.env).filter((k) => k.startsWith(OLD_ENV_PREFIX))).toEqual([]);
  });

  it('vitest refuses a RETAKE_HOME that is a real home: ~/.retake, the home of before L5.13, or a link to one (review A M3)', () => {
    const home = mkdtempSync(join(tmpdir(), 'retake-canary-home-'));
    try {
      mkdirSync(join(home, '.retake'));
      mkdirSync(join(home, OLD_DIR));
      symlinkSync(join(home, OLD_DIR), join(home, 'linked-home'));
      for (const named of [join(home, '.retake'), join(home, OLD_DIR), join(home, 'linked-home'), '~/.retake']) {
        // Only the first test of this file: the run must stop at the config, before any test.
        const r = spawnSync(process.execPath, [join(REPO, 'node_modules', 'vitest', 'vitest.mjs'), 'run', 'packages/core/test/retake-home.test.ts', '-t', 'a test never runs on the real'], {
          cwd: REPO,
          env: { PATH: process.env.PATH ?? '', HOME: home, RETAKE_HOME: named },
          encoding: 'utf8',
          timeout: 60_000,
        });
        expect(r.status, named).not.toBe(0);
        expect(`${r.stdout}${r.stderr}`, named).toContain('a real Retake home: tests use a scratch one');
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('no test file deletes RETAKE_HOME without restoring a saved value (review A M2)', () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name === 'dist') continue;
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(?:ts|tsx|mjs)$/.test(e.name)) files.push(p);
      }
    };
    for (const pkg of readdirSync(join(REPO, 'packages'))) {
      try {
        walk(join(REPO, 'packages', pkg, 'test'));
      } catch {
        /* no test folder */
      }
    }
    expect(files.length).toBeGreaterThan(100);
    // Allowed: a delete under `if (<saved> === undefined)`, or on a line saying HOME is a scratch folder there (the
    // legacy tests: the old home is looked at under a scratch HOME, and the value is restored after).
    const ok = /if \([\w.]+ === undefined\) delete process\.env\.RETAKE_HOME|\/\/ scratch HOME:/;
    const bare = files.flatMap((f) =>
      readFileSync(f, 'utf8')
        .split('\n')
        .map((l, i) => [l, i] as const)
        .filter(([l]) => /delete process\.env(?:\.RETAKE_HOME|\[['"]RETAKE_HOME['"]\])/.test(l) && !ok.test(l))
        .map(([l, i]) => `${f.slice(REPO.length + 1)}:${i + 1}: ${l.trim()}`),
    );
    expect(bare).toEqual([]);
  });
});
