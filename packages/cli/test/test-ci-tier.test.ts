/**
 * The CI tier (scripts/test-ci.json, scripts/test-ci.mjs: `pnpm test:ci`, run by the CI's checks job) cannot rot
 * silently: every test file of the repository is listed once — in the tier, or out of it under a reason —, so a new
 * file is a decision; the tier runs without browsers, ffmpeg, Docker and the RETAKE_TEST_* gates whatever the machine
 * has, so a tier file that starts to need one fails on the Mac as it would on the runner; and none of its files holds a
 * timing calibrated on the Mac.
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, relative } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { REPO } from '@retake/test-support/repo';
import { pathToFileURL } from 'node:url';

/** scripts/test-ci.mjs (a plain .mjs script without types), as this file uses it. */
const { TOOLS, TOOL_VARIABLES, ciEnv, readTiers } = (await import(pathToFileURL(join(REPO, 'scripts', 'test-ci.mjs')).href)) as {
  TOOLS: string[];
  TOOL_VARIABLES: string[];
  ciEnv(env: Record<string, string | undefined>, o: { nodeDir: string; browsers: string }): Record<string, string>;
  readTiers(): { ci: string[]; out: Record<string, string[]> };
};

const MAC_CALIBRATED = new RegExp(`${['RETAKE', 'TEST', 'SHARED', 'RUNNER'].join('_')}|${['MAC', 'TIMING'].join('_')}`);
const tiers = readTiers();
const listed = [...tiers.ci, ...Object.values(tiers.out).flat()];

/** Every vitest file of the repository: vitest.config.ts's include (every .test.ts / .test.tsx under packages/<package>/test), exactly. */
function testFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules') continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.test\.tsx?$/.test(e.name)) out.push(relative(REPO, p));
    }
  };
  for (const pkg of readdirSync(join(REPO, 'packages'), { withFileTypes: true })) {
    if (!pkg.isDirectory()) continue;
    try {
      walk(join(REPO, 'packages', pkg.name, 'test'));
    } catch {
      // A package without tests.
    }
  }
  return out.sort();
}

const tmp = mkdtempSync(join(tmpdir(), 'retake-test-ci-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('the CI tier (scripts/test-ci.json)', () => {
  it('lists every test file exactly once: in the tier, or out of it under a reason', () => {
    // The walk below is vitest's include (and its default exclude, node_modules), nothing narrower.
    expect(readFileSync(join(REPO, 'vitest.config.ts'), 'utf8')).toContain("include: ['packages/*/test/**/*.test.ts', 'packages/*/test/**/*.test.tsx'],");
    const files = testFiles();
    expect(files.length).toBeGreaterThan(500);
    const unlisted = files.filter((f) => !listed.includes(f));
    expect(unlisted, 'add each to scripts/test-ci.json: under "ci" when it passes in `pnpm test:ci`, else under "out" with its reason').toEqual([]);
    expect(
      listed.filter((f) => !files.includes(f)),
      'listed but not a test file (renamed or removed?)',
    ).toEqual([]);
    expect(
      listed.filter((f, i) => listed.indexOf(f) !== i),
      'listed twice',
    ).toEqual([]);
    expect(tiers.ci).toEqual([...tiers.ci].sort());
    for (const [reason, list] of Object.entries(tiers.out)) {
      expect(reason.length, reason).toBeGreaterThan(30);
      expect(list.length, reason).toBeGreaterThan(0);
      expect(list, reason).toEqual([...list].sort());
    }
  });

  it('holds most of the suite, and none of the Studio-in-a-browser, app, updater or Docker files', () => {
    expect(tiers.ci.length).toBeGreaterThan(300);
    for (const f of tiers.ci) {
      expect(f, f).not.toMatch(/\/studio-e2e-|\/app-bundle-acceptance|\/app-update-e2e|\/desktop-shell|\/sandbox-docker|\/compose\.test/);
      // A timing calibrated on the Mac (the shared-runner switch, ci-workflow.test.ts's list) has no place on a shared
      // runner. The words are built here so that this file does not name them itself.
      if (f !== 'packages/cli/test/ci-workflow.test.ts') expect(readFileSync(join(REPO, f), 'utf8'), f).not.toMatch(MAC_CALIBRATED);
    }
  });

  it('pnpm test:ci runs scripts/test-ci.mjs', () => {
    expect(JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).scripts['test:ci']).toBe('node scripts/test-ci.mjs');
  });

  it('runs without the tools whatever the machine has: PATH without their folders, no browser of Playwright, no gate, no tool variable', () => {
    const dirs = ['ffmpeg', 'docker', 'chromium', 'plain'].map((name) => {
      const d = join(tmp, name);
      mkdirSync(d, { recursive: true });
      if (name !== 'plain') {
        writeFileSync(join(d, name), '#!/bin/sh\nexit 0\n');
        chmodSync(join(d, name), 0o755);
      }
      writeFileSync(join(d, 'git'), '#!/bin/sh\nexit 0\n');
      chmodSync(join(d, 'git'), 0o755);
      return d;
    });
    // A file named like a tool but not executable does not count.
    writeFileSync(join(dirs[3]!, 'ffprobe'), 'not a program');
    const env = ciEnv(
      {
        PATH: [...dirs, '/node/bin'].join(delimiter),
        HOME: '/home/x',
        RETAKE_HOME: '/scratch/home',
        RETAKE_TEST_SLOW: '1',
        RETAKE_TEST_DOCKER: '1',
        RETAKE_TEST_PG: 'postgres://x@127.0.0.1/y',
        RETAKE_FFMPEG: '/opt/ffmpeg',
        RETAKE_CHROMIUM: '/opt/chromium',
        PLAYWRIGHT_BROWSERS_PATH: '/real/browsers',
      },
      { nodeDir: '/node/bin', browsers: '/empty/browsers' },
    );
    expect(env.PATH).toBe(['/node/bin', dirs[3]].join(delimiter));
    expect(env.PLAYWRIGHT_BROWSERS_PATH).toBe('/empty/browsers');
    expect(env.RETAKE_TEST_PG).toBe('off');
    expect(Object.keys(env).filter((k) => k.startsWith('RETAKE_TEST_'))).toEqual(['RETAKE_TEST_PG']);
    // Each tool variable names a program that does not exist (read before PATH by every resolver, so a child process
    // that puts the Homebrew folders back on its PATH finds no real tool either).
    expect(TOOL_VARIABLES).toEqual(['RETAKE_FFMPEG', 'RETAKE_FFPROBE', 'RETAKE_CHROMIUM', 'RETAKE_CHROMIUM_HEADLESS_SHELL', 'RETAKE_DOCKER']);
    for (const v of TOOL_VARIABLES) expect(env[v], v).toBe(`/empty/browsers/not-in-the-ci-tier/${v.slice('RETAKE_'.length).toLowerCase()}`);
    expect(env).toMatchObject({ HOME: '/home/x', RETAKE_HOME: '/scratch/home' });
    expect(TOOLS).toEqual(expect.arrayContaining(['ffmpeg', 'ffprobe', 'docker', 'chromium']));
  });
});
