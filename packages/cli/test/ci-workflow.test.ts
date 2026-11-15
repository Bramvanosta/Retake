/**
 * The CI workflow (.github/workflows/ci.yml, BACKLOG BL-144) read as data: when it runs, what a pull request's code
 * may reach (no secret, no environment, a read-only token, no cache), every action pinned like release.yml's, the
 * pinned Node.js first, the guards after the build, then the deterministic tier of the tests and nothing more of the
 * suite (BL-163: no browser, no render, no gated test on the runner), the shell's Rust from its toolchain file. And
 * the weekly shuffled run (.github/workflows/shuffled.yml): the same tier in a shuffled order, on a schedule or by hand.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (p: string) => readFileSync(join(REPO, p), 'utf8');
const YAML = createRequire(join(REPO, 'packages', 'core', 'package.json'))('yaml') as { parse: (t: string) => any };
type Step = { name?: string; uses?: string; run?: string; env?: Record<string, string>; with?: Record<string, unknown> };
type Job = { steps: Step[]; env?: Record<string, string>; permissions?: Record<string, string>; environment?: string; 'runs-on'?: string };

const raw = read('.github/workflows/ci.yml');
const wf = YAML.parse(raw);
/** The workflow without its comment lines (they name what it never does). */
const code = raw
  .split('\n')
  .filter((l) => !/^\s*#/.test(l))
  .join('\n');
const jobs = wf.jobs as Record<string, Job>;
const names = (job: string) => jobs[job]!.steps.map((s) => s.name ?? s.uses);
const step = (job: string, name: string) => {
  const s = jobs[job]!.steps.find((x) => x.name === name);
  if (!s) throw new Error(`no step "${name}" in ${job}`);
  return s;
};

describe('the CI workflow (ci.yml)', () => {
  it('runs on pull requests and pushes to main only; one run per pull request or branch, the older one cancelled', () => {
    expect(Object.keys(wf.on).sort()).toEqual(['pull_request', 'push']);
    expect(wf.on.push).toEqual({ branches: ['main'] });
    expect(code).not.toMatch(/pull_request_target|workflow_run|workflow_dispatch/);
    expect(wf.concurrency).toEqual({ group: 'ci-${{ github.event.pull_request.number || github.ref }}', 'cancel-in-progress': true });
  });

  it("a pull request's code reaches no secret, no environment, no write permission and no cache", () => {
    expect(wf.permissions).toEqual({ contents: 'read' });
    for (const [name, job] of Object.entries(jobs)) {
      expect(job.permissions, name).toEqual({ contents: 'read' });
      expect(job.environment, name).toBeUndefined();
    }
    expect(code).not.toMatch(/secrets\.|github\.token|GITHUB_TOKEN|actions\/cache|^\s+cache:/m);
    for (const job of Object.values(jobs)) {
      const checkout = job.steps[0]!;
      expect(checkout.uses).toMatch(/^actions\/checkout@/);
      expect(checkout.with).toEqual({ 'persist-credentials': false });
    }
  });

  it("every action pinned to a commit, the same pin and tag as release.yml's", () => {
    const pins = new Map([...read('.github/workflows/release.yml').matchAll(/uses: ([\w/-]+)@([0-9a-f]{40}) # (v[\d.]+)/g)].map((m) => [m[1]!, `${m[2]} # ${m[3]}`]));
    const uses = [...raw.matchAll(/uses: (\S+)(.*)/g)];
    expect(uses.length).toBeGreaterThan(0);
    for (const [, spec, rest] of uses) {
      const [action, ref] = spec!.split('@');
      expect(pins.get(action!), spec).toBe(`${ref}${rest}`);
    }
  });

  it('the pinned Node.js first in each job; the guards after the build; then the CI tier of the tests only (BL-163)', () => {
    for (const job of Object.keys(jobs)) expect(names(job)[1], job).toBe('Node.js, the pinned build');
    for (const job of Object.keys(jobs)) expect(step(job, 'Node.js, the pinned build').run).toBe('bash apps/desktop/scripts/ci-node.sh');
    const order = ["pnpm (corepack, at package.json's packageManager)", 'Dependencies', 'Build the packages', "The repository's guards", 'The deterministic tests'];
    const at = order.map((n) => names('checks').indexOf(n));
    expect(at.every((i) => i > 1)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(step('checks', 'Dependencies').run).toBe('pnpm install --frozen-lockfile');
    expect(step('checks', 'Build the packages').run).toBe('pnpm build');
    // The guards: these lines and no other, each a command of its own under `set -eu` (no `|| true`, no `#` in front of
    // one), in a step that is its name and its script (no `if:`, no `continue-on-error`).
    const guards = step('checks', "The repository's guards");
    expect(Object.keys(guards).sort()).toEqual(['name', 'run']);
    expect(guards.run!.trim().split('\n')).toEqual([
      'set -eu',
      'node scripts/set-version.mjs --check',
      'node scripts/audit/rules.mjs . --check',
      'node scripts/requirements.mjs --untested 1',
      'node scripts/requirements.mjs --check-cites',
      'npx tsc -p tsconfig.test.json',
      'node scripts/lint.mjs',
    ]);
    expect(Object.keys(step('checks', 'Build the packages')).sort()).toEqual(['name', 'run']);
    // The deterministic tier last (scripts/test-ci.mjs strips the tools and the gates itself), as a step of its own
    // without `if:` or `continue-on-error`; the rest of the suite runs on the Mac (BL-163): no other test command, no
    // browser, no gated test, no variable set for the tests here.
    expect(names('checks').at(-1)).toBe('The deterministic tests');
    expect(step('checks', 'The deterministic tests')).toEqual({ name: 'The deterministic tests', run: 'pnpm test:ci' });
    expect(code.match(/pnpm test\S*/g)).toEqual(['pnpm test:ci']);
    expect(code).not.toMatch(/vitest|playwright|ffmpeg|RETAKE_TEST_/);
    expect(JSON.parse(read('package.json')).scripts['test:ci']).toBe('node scripts/test-ci.mjs');
    expect((jobs.checks as unknown as Record<string, unknown>)['timeout-minutes']).toBe(45);
    expect(jobs.checks!.env).toBeUndefined();
    // Every script the workflow names exists.
    for (const [p] of raw.matchAll(/(?:apps\/desktop\/)?scripts\/[\w/.-]+\.(?:mjs|sh)|packages\/[\w-]+\/node_modules\/[\w-]+\/[\w.-]+\.js/g)) {
      if (p.includes('/node_modules/')) {
        const [, pkg, dep] = /^packages\/([\w-]+)\/node_modules\/([\w-]+)\//.exec(p)!;
        expect(JSON.parse(read(`packages/${pkg}/package.json`)).dependencies, p).toHaveProperty(dep!);
      } else expect(() => read(p), p).not.toThrow();
    }
  });

  it('RETAKE_TEST_SHARED_RUNNER skips Mac-calibrated timings only, in the files listed here (a new one is a decision; for a shared runner, BL-163)', () => {
    const files = execFileSync('git', ['grep', '-l', 'RETAKE_TEST_SHARED_RUNNER', '--', 'packages'], { cwd: REPO, encoding: 'utf8' }).trim().split('\n').sort();
    expect(files).toEqual([
      'packages/cli/test/ci-workflow.test.ts',
      'packages/cli/test/e2e.test.ts',
      ...['acceptance', 'capture-pause', 'capture-sizes', 'clock', 'kit', 'look', 'navigation', 'record-session', 'reliability', 'run'].map((f) => `packages/runner-web/test/${f}.test.ts`),
    ]);
    for (const f of files.filter((x) => !x.endsWith('ci-workflow.test.ts'))) {
      const text = read(f);
      expect(text.match(/RETAKE_TEST_SHARED_RUNNER/g), f).toHaveLength(2);
      expect(text, f).toContain("const MAC_TIMING = process.env.RETAKE_TEST_SHARED_RUNNER !== '1';");
    }
  });

  it("the desktop job: the shell's rules on apps/desktop/rust-toolchain.toml's Rust", () => {
    const channel = /^channel = "([^"]+)"$/m.exec(read('apps/desktop/rust-toolchain.toml'))![1]!;
    const rust = step('desktop', "Rust, apps/desktop/rust-toolchain.toml's").run!;
    expect(rust).toContain(`sed -n 's/^channel = "\\(.*\\)"$/\\1/p' apps/desktop/rust-toolchain.toml`);
    expect(rust).toContain('rustup toolchain install "$V" --profile minimal');
    expect(rust).toContain('echo "RUSTUP_TOOLCHAIN=$V" >> "$GITHUB_ENV"');
    expect(step('desktop', "The shell's rules").run).toBe('node apps/desktop/scripts/desktop.mjs test');
    // What the sed line prints for the file as it is: its channel.
    const printed = /^channel = "(.*)"$/m.exec(read('apps/desktop/rust-toolchain.toml'))![1];
    expect(printed).toBe(channel);
    expect(channel).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('the weekly shuffled run (shuffled.yml): on a schedule or by hand only, read-only, the checks setup step for step, then the CI tier shuffled with a printed seed', () => {
    const sraw = read('.github/workflows/shuffled.yml');
    const s = YAML.parse(sraw);
    const scode = sraw
      .split('\n')
      .filter((l) => !/^\s*#/.test(l))
      .join('\n');
    // When: a weekly cron, or started by hand (no input), nothing else (no pull request's code, no chained trigger).
    expect(Object.keys(s.on)).toEqual(['schedule', 'workflow_dispatch']);
    expect(s.on.schedule).toHaveLength(1);
    expect(s.on.schedule[0].cron).toMatch(/^\d{1,2} \d{1,2} \* \* [0-6]$/);
    expect(s.on.workflow_dispatch).toBeNull();
    // One run per branch: a run started by hand on a branch does not cancel the weekly one on main.
    expect(s.concurrency).toEqual({ group: 'shuffled-tests-${{ github.ref }}', 'cancel-in-progress': true });
    expect(scode).not.toMatch(/pull_request|push:|workflow_run|workflow_call|repository_dispatch|inputs:/);
    // What it may reach: a read-only token, no secret, no environment, no cache; nothing pushed, published or merged.
    expect(s.permissions).toEqual({ contents: 'read' });
    const sjobs = s.jobs as Record<string, Job & Record<string, unknown>>;
    expect(Object.keys(sjobs)).toEqual(['shuffled']);
    const job = sjobs.shuffled!;
    expect(job.permissions).toEqual({ contents: 'read' });
    expect(job.environment).toBeUndefined();
    expect(job.env).toBeUndefined();
    expect(scode).not.toMatch(/secrets\.|github\.token|GITHUB_TOKEN|actions\/cache|^\s+cache:|git push|gh |npm publish|pnpm publish|merge/m);
    // Pinned as release.yml pins (and so as ci.yml).
    const pins = new Map([...read('.github/workflows/release.yml').matchAll(/uses: ([\w/-]+)@([0-9a-f]{40}) # (v[\d.]+)/g)].map((m) => [m[1]!, `${m[2]} # ${m[3]}`]));
    const uses = [...sraw.matchAll(/uses: (\S+)(.*)/g)];
    expect(uses.length).toBeGreaterThan(0);
    for (const [, spec, rest] of uses) {
      const [action, ref] = spec!.split('@');
      expect(pins.get(action!), spec).toBe(`${ref}${rest}`);
    }
    // The setup: the checks job's steps up to the build, the same ones (ci.yml's guards stay there), on the same machine.
    expect(job['runs-on']).toBe(jobs.checks!['runs-on']);
    expect(job['timeout-minutes']).toBe((jobs.checks as unknown as Record<string, unknown>)['timeout-minutes']);
    const build = names('checks').indexOf('Build the packages');
    expect(job.steps.slice(0, -1)).toEqual(jobs.checks!.steps.slice(0, build + 1));
    // Then the tier, shuffled (files and cases) with the run's date as the seed, printed first; no other test command.
    const last = job.steps.at(-1)!;
    expect(Object.keys(last).sort()).toEqual(['name', 'run']);
    expect(last.name).toBe('The deterministic tests, shuffled');
    expect(last.run!.trim().split('\n')).toEqual([
      'set -eu',
      'SEED=$(date -u +%Y%m%d)',
      'echo "seed $SEED (again: pnpm test:ci -- --sequence.shuffle --sequence.seed=$SEED)"',
      'pnpm test:ci -- --sequence.shuffle --sequence.seed="$SEED"',
    ]);
    expect(scode.match(/pnpm test\S*/g)).toEqual(['pnpm test:ci', 'pnpm test:ci']);
    expect(scode).not.toMatch(/vitest|playwright|ffmpeg|RETAKE_TEST_/);
    // scripts/test-ci.mjs hands what follows `--` to vitest.
    expect(read('scripts/test-ci.mjs')).toContain("const args = process.argv.slice(2).filter((a) => a !== '--');");
  });

  it('release.yml says the CI exists and that the release does not wait for it', () => {
    const release = read('.github/workflows/release.yml');
    expect(release).not.toMatch(/No CI workflow/);
    expect(release).toContain('ci.yml');
  });
});
