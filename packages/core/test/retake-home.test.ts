/**
 * L5.13 (critique H4): the canary of the test environment — vitest.config.ts gives every run a scratch RETAKE_HOME
 * (never the person's ~/.retake, which holds their signed-in profiles) and drops the variables of the name before L5.13.
 * L5.13a reviews: the home of before L5.13 (or a link to a real home) is refused as RETAKE_HOME too (A M3), and no test
 * file leaves RETAKE_HOME unset for the tests after it (A M2: a later `main()` would look at the real home).
 * L5.16 Library hygiene: an MCP server a test starts gets CFFIXED_USER_HOME too — the SDK's stdio transport passes only
 * the variables it is given, and a server without it starts workers whose Chromium writes its crash reporter's
 * settings.dat into the account's ~/Library (the leak of the lot-end run).
 * L5.15 fixes (review B M3): those processes get the render pin of vitest.setup.ts too (child-env.ts testChildEnv).
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OLD_DIR, OLD_ENV_PREFIX, oldEnvNames } from '../src/index.js';
import { retakeHome } from '../src/io/index.js';
import { testChildEnv } from './child-env.js';

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
  it('L5.14: every test file films its takes in a marker folder of its own (0700, under the run\'s scratch parent), which its children inherit', () => {
    const dir = process.env.RETAKE_CAPTURES_DIR?.trim();
    const parent = process.env.RETAKE_TEST_CAPTURES?.trim();
    expect(dir).toBeTruthy();
    expect(parent).toBeTruthy();
    expect(dirname(dir!)).toBe(parent);
    expect(dir).not.toMatch(/\/retake-captures$/);
    const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(process.env.RETAKE_CAPTURES_DIR || "")'], { env: process.env, encoding: 'utf8' });
    expect(child.stdout).toBe(dir);
  });

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
          env: { PATH: process.env.PATH ?? '', HOME: home, RETAKE_CAPTURES_DIR: process.env.RETAKE_CAPTURES_DIR ?? '', RETAKE_HOME: named },
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
    expect(starts.filter((s) => !/CFFIXED_USER_HOME: process\.env\.CFFIXED_USER_HOME|\.\.\.process\.env\b|^testChildEnv$/.test(s.env)).map((s) => `${s.at}: ${s.env}`)).toEqual([]);
  });

  it('L5.14a fixes (review B M2): every process environment a test builds by hand carries RETAKE_CAPTURES_DIR (a take there never writes the person\'s markers folder)', () => {
    // A process started with an explicit environment (spawn / spawnSync / execFile / an MCP transport): an `env` literal
    // that names RETAKE_HOME (a scratch home) without spreading process.env must name RETAKE_CAPTURES_DIR too — directly, or
    // through the object it spreads (a file's `env` / `runEnv` set once and spread per start).
    const missing: string[] = [];
    for (const f of testFiles()) {
      const text = readFileSync(f, 'utf8');
      const defs = new Map<string, string>();
      for (const m of text.matchAll(/\b(env|runEnv)\s*=\s*(\{[^}]*\})/g)) defs.set(m[1]!, m[2]!);
      const ok = (lit: string, depth = 0): boolean => {
        if (/RETAKE_CAPTURES_DIR/.test(lit) || /\.\.\.process\.env\b/.test(lit)) return true;
        const spread = /\.\.\.(env|runEnv)\b/.exec(lit);
        return depth < 3 && spread !== null && defs.has(spread[1]!) && ok(defs.get(spread[1]!)!, depth + 1);
      };
      for (const m of text.matchAll(/(?:new StdioClientTransport|\bspawn|\bspawnSync|\bexecFile|\bexecFileSync)\(/g)) {
        const window = text.slice(m.index, m.index + 1500);
        const env = /\benv:\s*(\{[^}]*\}|[\w.]+)/.exec(window)?.[1];
        if (!env || env.startsWith('process.env') || env === 'testChildEnv') continue;
        const lit = env.startsWith('{') ? env : defs.get(env);
        if (!lit || !/RETAKE_HOME/.test(lit)) continue;
        if (!ok(lit)) missing.push(`${f.slice(REPO.length + 1)}:${text.slice(0, m.index).split('\n').length}: ${lit.replace(/\s+/g, ' ').slice(0, 120)}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('L5.15 fixes (review B M3): the render pin reaches every process a test starts with its own environment (MCP servers, CLI commands): testChildEnv carries it', () => {
    // The helper carries the pin of vitest.setup.ts (and the rules above) — whatever this run pinned.
    const env = testChildEnv({ RETAKE_HOME: '/scratch/h' });
    expect(process.env.RETAKE_RENDER_GL?.trim()).toBeTruthy();
    expect(env).toMatchObject({
      RETAKE_RENDER_GL: process.env.RETAKE_RENDER_GL,
      RETAKE_RENDER_ENCODER: process.env.RETAKE_RENDER_ENCODER,
      CFFIXED_USER_HOME: process.env.CFFIXED_USER_HOME,
      RETAKE_CAPTURES_DIR: process.env.RETAKE_CAPTURES_DIR ?? '',
      RETAKE_HOME: '/scratch/h',
    });
    if (process.env.RETAKE_TEST_RENDER_POLICY !== 'keep') expect(env).toMatchObject({ RETAKE_RENDER_GL: 'software', RETAKE_RENDER_ENCODER: 'libx264' });
    // Every environment built by hand that names RETAKE_HOME (a Retake process: an MCP server, a CLI command) goes
    // through it, spreads process.env, or names the pin itself. Not needed: `--version`, a vitest of its own (its setup
    // pins), and the app's own acceptances, which run the shipped default on purpose.
    const exempt = /app-bundle-acceptance\.test\.ts$|app-update-e2e\.test\.ts$/;
    const unpinned: string[] = [];
    for (const f of testFiles()) {
      if (exempt.test(f)) continue;
      const text = readFileSync(f, 'utf8');
      const defs = new Map<string, string>();
      for (const m of text.matchAll(/\b(env|runEnv)\s*=\s*(\{[^}]*\})/g)) defs.set(m[1]!, m[2]!);
      for (const m of text.matchAll(/(?:new StdioClientTransport|\bspawn|\bspawnSync|\bexecFile|\bexecFileSync)\(/g)) {
        const window = text.slice(m.index, m.index + 1500);
        const env = /\benv:\s*(\{[^}]*\}|[\w.]+)/.exec(window)?.[1];
        if (!env || env.startsWith('process.env') || env === 'testChildEnv') continue;
        if (/'--version'|vitest\.mjs/.test(window.slice(0, window.indexOf('env:')))) continue;
        const lit = env.startsWith('{') ? env : defs.get(env);
        if (!lit || !/RETAKE_HOME/.test(lit) || /\.\.\.process\.env\b|RETAKE_RENDER_GL/.test(lit)) continue;
        unpinned.push(`${f.slice(REPO.length + 1)}:${text.slice(0, m.index).split('\n').length}: ${lit.replace(/\s+/g, ' ').slice(0, 120)}`);
      }
    }
    expect(unpinned).toEqual([]);
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
