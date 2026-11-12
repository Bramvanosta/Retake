import { defineConfig } from 'vitest/config';
import { mkdtempSync, realpathSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// A test run never uses the person's own home (~/.retake: their signed-in profiles). RETAKE_HOME is a fresh temp
// folder unless the shell names one — never ~/.retake, even through a link —, removed at the end of the run
// (vitest.teardown.mjs); core test/retake-home.test.ts is the canary.
if (!process.env.RETAKE_HOME?.trim()) process.env.RETAKE_HOME = process.env.RETAKE_TEST_HOME_MADE = mkdtempSync(join(tmpdir(), 'retake-test-home-'));
const testHome = resolve(process.env.RETAKE_HOME.trim().replace(/^~(?=$|\/)/, homedir()));
const real = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};
const REAL_HOMES = [join(homedir(), '.retake')];
if (REAL_HOMES.some((h) => testHome === h || real(testHome) === real(h))) throw new Error(`RETAKE_HOME is ${testHome}, a real Retake home: tests use a scratch one (unset it, or name a temp folder)`);
// L5.16c fixes: Chromium on macOS finds ~/Library through NSHomeDirectory (the account's home, whatever HOME says) and
// its crash reporter writes ~/Library/Application Support/Chromium/Crashpad there; CFFIXED_USER_HOME moves that home
// for every process a test starts (the browsers of the e2e tests, captures, renders) to a scratch folder — made here
// unless the shell names one, removed at the end of the run (vitest.teardown.mjs). A child a test starts with an env of
// its own passes it on (core test/retake-home.test.ts checks the MCP servers'). It does not move what Chromium writes
// through cfprefsd (~/Library/Preferences/org.chromium.Chromium.plist): vitest.teardown.mjs warns when either changed.
if (!process.env.CFFIXED_USER_HOME?.trim()) process.env.CFFIXED_USER_HOME = process.env.RETAKE_TEST_CFHOME_MADE = mkdtempSync(join(tmpdir(), 'retake-test-cfhome-'));
const cfHome = process.env.CFFIXED_USER_HOME.trim();
if (real(cfHome) === real(userInfo().homedir)) throw new Error(`CFFIXED_USER_HOME is ${cfHome}, the account's home: tests use a scratch one (unset it)`);

// L5.14 (captures first): the filming markers live in one folder per user on this Mac (engine captures.ts). A test run
// never uses the person's: a scratch parent per run (removed by vitest.teardown.mjs) in which vitest.setup.ts gives every
// test file a folder of its own (RETAKE_CAPTURES_DIR), so a take filmed by one file never holds a render of another.
if (!process.env.RETAKE_TEST_CAPTURES?.trim()) process.env.RETAKE_TEST_CAPTURES = process.env.RETAKE_TEST_CAPTURES_MADE = mkdtempSync(join(tmpdir(), 'retake-test-captures-'));
const capturesRoot = process.env.RETAKE_TEST_CAPTURES.trim();

const pkg = (name: string) => fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));
const kit = fileURLToPath(new URL('./packages/components/src/kit/index.ts', import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      // Before '@retake/core', as for the kit: the side of core that touches the machine.
      '@retake/core/io': fileURLToPath(new URL('./packages/core/src/io/index.ts', import.meta.url)),
      // Before '@retake/core', as for io: core's entries, one per context (L7.35).
      '@retake/core/base': fileURLToPath(new URL('./packages/core/src/entries/base.ts', import.meta.url)),
      '@retake/core/model': fileURLToPath(new URL('./packages/core/src/entries/model.ts', import.meta.url)),
      '@retake/core/ids': fileURLToPath(new URL('./packages/core/src/entries/ids.ts', import.meta.url)),
      '@retake/core/language': fileURLToPath(new URL('./packages/core/src/entries/language.ts', import.meta.url)),
      '@retake/core/environment': fileURLToPath(new URL('./packages/core/src/entries/environment.ts', import.meta.url)),
      '@retake/core/policy': fileURLToPath(new URL('./packages/core/src/entries/policy.ts', import.meta.url)),
      '@retake/core/hooks': fileURLToPath(new URL('./packages/core/src/entries/hooks.ts', import.meta.url)),
      '@retake/core/project': fileURLToPath(new URL('./packages/core/src/entries/project.ts', import.meta.url)),
      '@retake/core/sandbox': fileURLToPath(new URL('./packages/core/src/entries/sandbox.ts', import.meta.url)),
      '@retake/core/scenario': fileURLToPath(new URL('./packages/core/src/entries/scenario.ts', import.meta.url)),
      '@retake/core/comments': fileURLToPath(new URL('./packages/core/src/entries/comments.ts', import.meta.url)),
      '@retake/core/run': fileURLToPath(new URL('./packages/core/src/entries/run.ts', import.meta.url)),
      '@retake/core/render': fileURLToPath(new URL('./packages/core/src/entries/render.ts', import.meta.url)),
      '@retake/core/theme': fileURLToPath(new URL('./packages/core/src/entries/theme.ts', import.meta.url)),
      '@retake/core/schema': fileURLToPath(new URL('./packages/core/src/entries/schema.ts', import.meta.url)),
      '@retake/core': pkg('core'),
      // Before '@retake/hooks', as for the kit: the hooks described without running them (a domain entry).
      '@retake/hooks/describe': fileURLToPath(new URL('./packages/hooks/src/describe-entry.ts', import.meta.url)),
      '@retake/hooks': pkg('hooks'),
      // Before '@retake/sandbox', as for the kit: a sandbox's vocabulary as types only (a domain entry, L7.25).
      '@retake/sandbox/types': fileURLToPath(new URL('./packages/sandbox/src/types-entry.ts', import.meta.url)),
      '@retake/sandbox': pkg('sandbox'),
      // Before '@retake/components': the first matching alias wins and that one would also match '…/kit' and '…/geometry'.
      '@retake/components/kit': kit,
      '@retake/components/geometry': fileURLToPath(new URL('./packages/components/src/geometry-entry.ts', import.meta.url)),
      // Before '@retake/runner-web', as for the kit: the capture's vocabulary as types only (a domain entry).
      '@retake/runner-web/types': fileURLToPath(new URL('./packages/runner-web/src/types-entry.ts', import.meta.url)),
      '@retake/runner-web': pkg('runner-web'),
      '@retake/components': pkg('components'),
      // Before '@retake/editor', as for the kit: the planner's own entry (no renderer).
      '@retake/editor/plan': fileURLToPath(new URL('./packages/editor/src/plan-entry.ts', import.meta.url)),
      '@retake/editor': pkg('editor'),
      // Before '@retake/review', as for the kit: the thumbnails' own entry (no editor import) and the pure checks'.
      '@retake/review/thumbs': fileURLToPath(new URL('./packages/review/src/thumbs.ts', import.meta.url)),
      '@retake/review/checks': fileURLToPath(new URL('./packages/review/src/checks-entry.ts', import.meta.url)),
      '@retake/review': pkg('review'),
      // Before '@retake/engine', as for the kit: the operation contract's, the catalogue's and the integrations' own entries.
      '@retake/engine/contract': fileURLToPath(new URL('./packages/engine/src/contract.ts', import.meta.url)),
      '@retake/engine/catalogue': fileURLToPath(new URL('./packages/engine/src/catalogue.ts', import.meta.url)),
      '@retake/engine/integrations': fileURLToPath(new URL('./packages/engine/src/integrations.ts', import.meta.url)),
      '@retake/engine': pkg('engine'),
      '@retake/mcp': pkg('mcp'),
      '@retake/ui': pkg('ui'),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'packages/*/test/**/*.test.tsx'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // A nearly full disk is the machine's state, not a regression: captures keep measuring it but do not warn.
    env: { RETAKE_DISK_WARN: 'off', RETAKE_HOME: testHome, CFFIXED_USER_HOME: cfHome, RETAKE_TEST_CAPTURES: capturesRoot },
    setupFiles: ['./vitest.setup.ts'],
    // Removes the temp home this config made (review A L5 / B L4: one per run, in a tight TMPDIR); warns when the run
    // changed Chromium's files in the account's ~/Library (L5.16 Library hygiene).
    globalSetup: ['./vitest.teardown.mjs'],
    pool: 'forks',
    // Browser + ffmpeg tests are timing-sensitive: cap parallel files so a 4-CPU machine is not saturated.
    poolOptions: { forks: { maxForks: 2 } },
  },
});
