/**
 * L5.13 (critique H4): the canary of the test environment — vitest.config.ts gives every run a scratch RETAKE_HOME
 * (never the person's ~/.retake, which holds their signed-in profiles) and drops the variables of the name before L5.13.
 * L5.13a reviews: the home of before L5.13 (or a link to a real home) is refused as RETAKE_HOME too (A M3), and no test
 * file leaves RETAKE_HOME unset for the tests after it (A M2: a later `main()` would look at the real home).
 * L5.16 Library hygiene: an MCP server a test starts gets CFFIXED_USER_HOME too — the SDK's stdio transport passes only
 * the variables it is given, and a server without it starts workers whose Chromium writes its crash reporter's
 * settings.dat into the account's ~/Library (the leak of the lot-end run).
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OLD_DIR, OLD_ENV_PREFIX, oldEnvNames, retakeHome } from '../src/index.js';

const REPO = join(import.meta.dirname, '..', '..', '..');

/** Every .ts / .tsx / .mjs file under packages/<name>/test. */
function testFiles(): string[] {
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
  return files;
}

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
    const files = testFiles();
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

  it('every MCP server a test starts over stdio gets CFFIXED_USER_HOME, a scratch one (L5.16 Library hygiene)', () => {
    expect(process.env.CFFIXED_USER_HOME?.trim()).toBeTruthy();
    expect(process.env.CFFIXED_USER_HOME).not.toBe(userInfo().homedir);
    const starts = testFiles().flatMap((f) => {
      const text = readFileSync(f, 'utf8');
      return [...text.matchAll(/new StdioClientTransport\(/g)].map((m) => {
        // The transport's env object: from `env:` to its closing brace (no nested braces in these literals).
        const env = /\benv:\s*(\{[^}]*\}|[\w.]+)/.exec(text.slice(m.index, m.index + 1500))?.[1] ?? '(no env)';
        return { at: `${f.slice(REPO.length + 1)}:${text.slice(0, m.index).split('\n').length}`, env };
      });
    });
    expect(starts.length).toBeGreaterThan(15);
    expect(starts.filter((s) => !/CFFIXED_USER_HOME: process\.env\.CFFIXED_USER_HOME|\.\.\.process\.env\b/.test(s.env)).map((s) => `${s.at}: ${s.env}`)).toEqual([]);
  });

  it("the run's Library guard (vitest.teardown.mjs): the account's two Chromium files, a change reported, none when untouched", async () => {
    type Guard = {
      libraryFiles(home?: string): string[];
      libraryStamps(files: string[]): Array<number | null>;
      libraryChanges(files: string[], before: Array<number | null>, after: Array<number | null>): string[];
    };
    const g = (await import(join(REPO, 'vitest.teardown.mjs'))) as Guard;
    // By the account's home, whatever HOME says (Chromium finds ~/Library through the account).
    expect(g.libraryFiles()).toEqual([
      join(userInfo().homedir, 'Library', 'Application Support', 'Chromium', 'Crashpad', 'settings.dat'),
      join(userInfo().homedir, 'Library', 'Preferences', 'org.chromium.Chromium.plist'),
    ]);
    const home = mkdtempSync(join(tmpdir(), 'retake-canary-library-'));
    try {
      const files = g.libraryFiles(home);
      mkdirSync(dirname(files[0]!), { recursive: true });
      writeFileSync(files[0]!, 'x');
      const before = g.libraryStamps(files);
      expect(before[0]).toBeTypeOf('number');
      expect(before[1]).toBeNull();
      expect(g.libraryChanges(files, before, g.libraryStamps(files))).toEqual([]);
      utimesSync(files[0]!, new Date(), new Date(Date.now() + 60_000));
      mkdirSync(dirname(files[1]!), { recursive: true });
      writeFileSync(files[1]!, 'y');
      const lines = g.libraryChanges(files, before, g.libraryStamps(files));
      expect(lines).toHaveLength(2);
      expect(lines[0]).toContain('settings.dat: 20');
      expect(lines[1]).toMatch(/org\.chromium\.Chromium\.plist: absent → 20/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
