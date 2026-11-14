#!/usr/bin/env node
/**
 * The deterministic tier of the test suite — `pnpm test:ci`, what the CI's `checks` job runs on every pull request and
 * push to main: the test files `scripts/test-ci.json` lists under `ci` (no browser, no ffmpeg, no Docker, no Postgres,
 * no timing calibrated on the Mac), a few minutes.
 *
 * The tier runs without those tools whatever the machine has, so that a file which starts to need one fails here as it
 * would on the CI runner instead of passing on a Mac that happens to have it:
 *   - PATH loses every folder that holds ffmpeg, ffprobe, docker, a Chromium or a Chrome (the folder of this Node.js
 *     comes first, so the tests' child processes run the same Node);
 *   - PLAYWRIGHT_BROWSERS_PATH names an empty folder (no browser of Playwright's), and the variables that name a tool
 *     (RETAKE_FFMPEG, RETAKE_FFPROBE, RETAKE_CHROMIUM, RETAKE_CHROMIUM_HEADLESS_SHELL, RETAKE_DOCKER) name a program
 *     that does not exist in that folder: every resolver reads them before PATH, so the processes the tests start
 *     (the CLI, an MCP server, the Studio, a job worker), which put the Homebrew and system folders back on their PATH,
 *     find no real tool either;
 *   - every RETAKE_TEST_* gate is dropped, and RETAKE_TEST_PG=off: the SQL tests skip without asking Docker.
 * `scripts/test-ci.json` lists every other test file under `out` with the reason it is not in the tier; a test
 * (packages/cli/test/test-ci-tier.test.ts) fails when a test file is in neither list.
 *
 *   node scripts/test-ci.mjs                 # the tier
 *   node scripts/test-ci.mjs --list          # its files, one per line
 *   node scripts/test-ci.mjs -- <vitest args> (e.g. --sequence.shuffle); arguments without `--` go to vitest too
 */
import { spawn } from 'node:child_process';
import { accessSync, constants, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const TIERS_FILE = join(ROOT, 'scripts', 'test-ci.json');

/** The programs the tier runs without: a folder of PATH holding one of them is left out. */
export const TOOLS = ['ffmpeg', 'ffprobe', 'docker', 'chromium', 'Chromium', 'chrome', 'google-chrome', 'headless_shell', 'chrome-headless-shell'];
/** The variables that name a tool's program. */
export const TOOL_VARIABLES = ['RETAKE_FFMPEG', 'RETAKE_FFPROBE', 'RETAKE_CHROMIUM', 'RETAKE_CHROMIUM_HEADLESS_SHELL', 'RETAKE_DOCKER'];

/** scripts/test-ci.json: `ci` (the tier's files) and `out` (reason → files). */
export function readTiers(file = TIERS_FILE) {
  const t = JSON.parse(readFileSync(file, 'utf8'));
  return { ci: t.ci, out: t.out };
}

const executable = (p) => {
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/**
 * The environment of the tier: `env` without the tools (see the module comment); `nodeDir` first on PATH, `browsers`
 * the empty folder PLAYWRIGHT_BROWSERS_PATH names.
 */
export function ciEnv(env, { nodeDir, browsers, isTool = (dir, name) => executable(join(dir, name)) }) {
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (/^RETAKE_TEST_/.test(k) || TOOL_VARIABLES.includes(k) || k === 'PLAYWRIGHT_BROWSERS_PATH') continue;
    out[k] = v;
  }
  const kept = (env.PATH ?? '').split(delimiter).filter((dir) => dir && dir !== nodeDir && !TOOLS.some((name) => isTool(dir, name)));
  out.PATH = [nodeDir, ...kept].join(delimiter);
  out.PLAYWRIGHT_BROWSERS_PATH = browsers;
  for (const v of TOOL_VARIABLES) out[v] = join(browsers, 'not-in-the-ci-tier', v.slice('RETAKE_'.length).toLowerCase());
  out.RETAKE_TEST_PG = 'off';
  return out;
}

async function main() {
  const args = process.argv.slice(2).filter((a) => a !== '--');
  const { ci } = readTiers();
  const missing = ci.filter((f) => !existsSync(join(ROOT, f)));
  if (missing.length) {
    console.error(`test-ci: listed in scripts/test-ci.json but missing:\n  ${missing.join('\n  ')}`);
    process.exit(2);
  }
  if (args.includes('--list')) {
    console.log(ci.join('\n'));
    return;
  }
  const browsers = mkdtempSync(join(tmpdir(), 'retake-test-ci-browsers-'));
  const env = ciEnv(process.env, { nodeDir: dirname(process.execPath), browsers });
  const vitest = createRequire(join(ROOT, 'package.json')).resolve('vitest/vitest.mjs');
  const t0 = Date.now();
  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, [vitest, 'run', ...ci, ...args], { cwd: ROOT, env, stdio: 'inherit' });
    for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
    child.on('error', (e) => {
      console.error(`test-ci: cannot start vitest: ${e.message}`);
      resolve(1);
    });
    child.on('exit', (c, signal) => resolve(c ?? (signal ? 1 : 0)));
  });
  rmSync(browsers, { recursive: true, force: true });
  console.error(`test-ci: ${ci.length} files in ${Math.round((Date.now() - t0) / 1000)} s`);
  process.exitCode = code;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
