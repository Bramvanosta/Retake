/**
 * L5.16e — releases from GitHub Actions, their rules without GitHub (fast, no network, never the real `security` or a
 * keychain): .github/workflows/release.yml read as data (its triggers, permissions, environments, pinned actions,
 * where each secret and the job token go, which job runs dependency code — never the one holding the keys) and its
 * step scripts run in bash against stand-ins (gh, security) — the preflight, the artifact's check, the signing
 * material, the files collected, the attach to a draft only, the update fetched and published with the job token alone
 * (L5.16f: the feed is the repository's update-feed release, no update host); scripts/release.mjs (the tag is the
 * version, the notes, the feed publish-update.mjs accepts, the preflight's sets, the files' names);
 * apps/desktop/scripts/ci-keychain.sh against a recording `security` (the temporary keychain, the search list put
 * back, no password on a command line, the files removed whatever security says); the sign entry's import graph
 * (Node.js built-ins and repository files only); the release signer's CI path (APPLE_KEYCHAIN → codesign --keychain).
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const WORKFLOW_FILE = join(REPO, '.github', 'workflows', 'release.yml');
const KEYCHAIN_SCRIPT = join(REPO, 'apps', 'desktop', 'scripts', 'ci-keychain.sh');
const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'retake-release-workflow-')));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const MAC = process.platform === 'darwin';
let n = 0;
const dir = (name: string) => {
  const d = join(tmp, `${name}-${n++}`);
  mkdirSync(d, { recursive: true });
  return d;
};

/* eslint-disable @typescript-eslint/no-explicit-any */
// The repository's YAML parser (a dependency of @retake/core), as the core package resolves it.
const YAML = createRequire(join(REPO, 'packages', 'core', 'package.json'))('yaml') as { parse: (t: string) => any };
const releaseModule = async () => (await import(pathToFileURL(join(REPO, 'scripts', 'release.mjs')).href)) as any;
const publishModule = async () => (await import(pathToFileURL(join(REPO, 'scripts', 'publish-update.mjs')).href)) as any;
const signModule = async () => (await import(pathToFileURL(join(REPO, 'apps', 'desktop', 'scripts', 'sign.mjs')).href)) as any;
const bundleModule = async () => (await import(pathToFileURL(join(REPO, 'apps', 'desktop', 'scripts', 'bundle.mjs')).href)) as any;

const raw = readFileSync(WORKFLOW_FILE, 'utf8');
const wf = YAML.parse(raw);
type Step = { name?: string; uses?: string; run?: string; env?: Record<string, string>; with?: Record<string, unknown>; if?: string; id?: string };
type Job = { steps: Step[]; permissions?: Record<string, string>; needs?: string | string[]; outputs?: Record<string, string>; environment?: string; 'runs-on'?: string };
const jobs = wf.jobs as Record<string, Job>;
const allSteps = Object.entries(jobs).flatMap(([job, j]) => j.steps.map((s) => ({ job, ...s })));
const label = (s: Step & { job: string }) => `${s.job} › ${s.name ?? s.uses ?? s.id}`;
const step = (job: string, name: string) => {
  const s = jobs[job]!.steps.find((x) => x.name === name);
  if (!s) throw new Error(`no step "${name}" in ${job}`);
  return s;
};
/** The secrets a step's environment binds by value: variable → secret name. */
const secretsOf = (s: Step) => Object.fromEntries(Object.entries(s.env ?? {}).flatMap(([k, v]) => {
  const m = /^\$\{\{\s*secrets\.([A-Z0-9_]+)\s*\}\}$/.exec(String(v));
  return m ? [[k, m[1]!]] : [];
}));
/** A secret's presence only (`secrets.X != ''`: true or false, never its value). */
const PRESENCE = /^\$\{\{ (secrets|vars)\.([A-Z0-9_]+) != '' \}\}$/;
const usesToken = (s: Step) => Object.values(s.env ?? {}).some((v) => /github\.token|secrets\.GITHUB_TOKEN/.test(String(v)));
/** A step that runs dependency or build code: pnpm (and every package script it starts), cargo, rustup, corepack, Homebrew, the ffmpeg build, Playwright's installer. */
const BUILD_TOOL = /\b(?:pnpm|cargo|rustup|corepack|npx|npm|brew)\b|build-ffmpeg\.mjs|playwright-core\/cli\.js/;
const CALLS_GH = /(?:^|[\s;|&(])gh\s/m;

/** Every action, pinned to the commit of an exact upstream tag (resolved read-only: gh api repos/<o>/<r>/git/ref/tags/<tag>). */
const PINS: Record<string, [string, string]> = {
  'actions/checkout': ['fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09', 'v5.1.0'],
  'actions/setup-node': ['a0853c24544627f65ddf259abe73b1d18a591444', 'v5.0.0'],
  'actions/upload-artifact': ['b7c566a772e6b6bfb58ed0dc250532a479d7789f', 'v6.0.0'],
  'actions/download-artifact': ['018cc2cf5baa6db3ef3c5f8a56943fffe632ef53', 'v6.0.0'],
};
/** Key material: written to files / a keychain by one step that runs no build tool and no `gh`. */
const MATERIAL_SECRETS = ['APPLE_API_KEY_P8', 'APPLE_CERTIFICATE', 'APPLE_CERTIFICATE_PASSWORD', 'TAURI_SIGNING_PRIVATE_KEY'];

/**
 * A workflow step's script run as GitHub runs it (bash --noprofile --norc -eo pipefail), in the checkout, with
 * RUNNER_TEMP / GITHUB_OUTPUT of a scratch folder and `bin` (stand-ins) first on PATH. Returns the run and its outputs.
 */
function runStep(s: Step, env: Record<string, string>, bin?: string, cwd = REPO) {
  const temp = env.RUNNER_TEMP ?? dir('runner-temp');
  const output = join(temp, 'github-output');
  writeFileSync(output, '', { flag: 'a' });
  const r = spawnSync('/bin/bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', s.run!], {
    cwd,
    encoding: 'utf8',
    env: { PATH: `${bin ? `${bin}:` : ''}${dirname(process.execPath)}:/usr/bin:/bin`, HOME: tmp, RUNNER_TEMP: temp, GITHUB_OUTPUT: output, GITHUB_REF_NAME: 'v0.2.0', GITHUB_ACTIONS: 'true', ...env },
  });
  const outputs = Object.fromEntries(readFileSync(output, 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  return { ...r, temp, outputs };
}

/**
 * A recording `gh` on a scratch PATH: each call one JSON line in calls.log; `release view --json isDraft` answers
 * FAKE_DRAFT, `--json assets` the names in FAKE_ASSETS (comma-separated); `release download` copies each --pattern
 * file of FAKE_RELEASE_DIR into --dir; `api` prints FAKE_API (what its --jq would print).
 */
function fakeGh() {
  const bin = dir('fake-gh');
  const log = join(bin, 'calls.log');
  writeFileSync(join(bin, 'gh'), `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(a) + '\\n');
const opt = (f) => a.filter((x, i) => a[i - 1] === f);
if (a[0] === 'release' && a[1] === 'view' && a.includes('isDraft')) console.log(process.env.FAKE_DRAFT);
else if (a[0] === 'release' && a[1] === 'view' && a.includes('assets')) for (const x of (process.env.FAKE_ASSETS || '').split(',').filter(Boolean)) console.log(x);
else if (a[0] === 'api') process.stdout.write(process.env.FAKE_API || '');
else if (a[0] === 'release' && a[1] === 'download') for (const p of opt('--pattern')) { const f = path.join(process.env.FAKE_RELEASE_DIR, p); if (fs.existsSync(f)) fs.copyFileSync(f, path.join(opt('--dir')[0], p)); }
`);
  chmodSync(join(bin, 'gh'), 0o755);
  return { bin, calls: () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as string[]) : []) };
}

/** The files a script runs with node, and the import graph of a module: every specifier, bare ones apart. */
function importGraph(entry: string) {
  const files = new Set<string>();
  const bare: string[] = [];
  const dynamic: string[] = [];
  const visit = (file: string) => {
    if (files.has(file)) return;
    files.add(file);
    const src = readFileSync(file, 'utf8');
    const specs = [
      ...[...src.matchAll(/^\s*(?:import|export)\s[^;]*?\sfrom\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]!),
      ...[...src.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]!),
      ...[...src.matchAll(/\b(?:import|require)\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]!),
    ];
    for (const m of src.matchAll(/\b(?:import|require)\(\s*(?!['"])([^)]*)\)/g)) dynamic.push(`${relative(REPO, file)}: ${m[0]}`);
    if (/\bcreateRequire\b/.test(src)) dynamic.push(`${relative(REPO, file)}: createRequire`);
    for (const spec of specs) {
      if (spec.startsWith('node:')) continue;
      if (spec.startsWith('./') || spec.startsWith('../')) visit(resolve(dirname(file), spec));
      else bare.push(`${relative(REPO, file)}: ${spec}`);
    }
  };
  visit(entry);
  return { files: [...files].map((f) => relative(REPO, f)).sort(), bare, dynamic };
}

describe('release.yml: triggers, permissions, environments, pinned actions (L5.16e)', () => {
  it('runs on a pushed v* tag only — no pull request (least of all pull_request_target), no other event', () => {
    expect(Object.keys(wf.on)).toEqual(['push']);
    expect(wf.on.push).toEqual({ tags: ['v*'] });
    expect(raw).not.toMatch(/pull_request|workflow_run|workflow_dispatch|repository_dispatch|schedule:/);
  });

  it('five jobs in a chain; reads by default, contents: write only on the jobs that call gh; one run per tag at a time, never cancelled', () => {
    expect(Object.keys(jobs)).toEqual(['release', 'build', 'sign', 'attach', 'publish']);
    expect([jobs.build!.needs, jobs.sign!.needs, jobs.attach!.needs, jobs.publish!.needs]).toEqual(['release', ['release', 'build'], ['release', 'sign'], ['release', 'attach']]);
    expect(wf.permissions).toEqual({ contents: 'read' });
    for (const [name, j] of Object.entries(jobs)) {
      const gh = j.steps.some((s) => CALLS_GH.test(s.run ?? ''));
      expect(j.permissions, name).toEqual({ contents: gh ? 'write' : 'read' });
    }
    expect(Object.entries(jobs).filter(([, j]) => j.permissions?.contents === 'write').map(([k]) => k)).toEqual(['release', 'attach', 'publish']);
    expect(wf.concurrency).toEqual({ group: 'release-${{ github.ref }}', 'cancel-in-progress': false });
  });

  it('the release environment (its secrets, its v*-only deployment rule) on release (presence only) and sign, and on publish as the gate before the release goes public — publish binds no secret', () => {
    expect(Object.entries(jobs).filter(([, j]) => j.environment).map(([k, j]) => `${k}:${j.environment}`)).toEqual(['release:release', 'sign:release', 'publish:release']);
    for (const [name, j] of Object.entries(jobs)) if (!j.environment || name === 'publish') expect(JSON.stringify(j), name).not.toMatch(/secrets\./);
    // The release job reads no secret's value: presence only.
    for (const s of jobs.release!.steps) for (const v of Object.values(s.env ?? {})) if (/secrets\./.test(String(v))) expect(String(v), label({ job: 'release', ...s })).toMatch(PRESENCE);
  });

  it('every action is GitHub\'s own, pinned to the commit of an exact upstream tag, the tag written beside it (# vX.Y.Z)', () => {
    const lines = raw.split('\n').filter((l) => /^\s*-?\s*uses:/.test(l));
    expect(lines.length).toBeGreaterThanOrEqual(14);
    const used = new Set<string>();
    for (const line of lines) {
      const m = /uses:\s*([\w.-]+\/[\w.-]+)@([0-9a-f]{40})\s+#\s+(v\d+\.\d+\.\d+)\s*$/.exec(line);
      expect(m, line).not.toBeNull();
      expect(PINS[m![1]!], line).toEqual([m![2], m![3]]);
      used.add(m![1]!);
    }
    expect([...used].sort()).toEqual(Object.keys(PINS).sort());
  });

  it('every checkout keeps no credential (persist-credentials: false); no `${{ }}` inside a script (values come through env); no failure hidden (|| true)', () => {
    const checkouts = allSteps.filter((s) => s.uses?.startsWith('actions/checkout@'));
    expect(checkouts.map((s) => s.job).sort()).toEqual(['attach', 'build', 'publish', 'release', 'sign']);
    for (const s of checkouts) expect((s.with as any)?.['persist-credentials'], label(s)).toBe(false);
    for (const s of allSteps) if (s.run) expect(s.run, label(s)).not.toContain('${{');
    expect(raw).not.toMatch(/\|\|\s*true\b|continue-on-error/);
  });

  it('macOS 15 on Apple silicon for both macOS jobs; Node.js exactly the pinned one everywhere (apps/desktop/bundle/node.json)', async () => {
    const { NODE_PIN } = await bundleModule();
    expect(Object.fromEntries(Object.entries(jobs).map(([k, j]) => [k, j['runs-on']]))).toEqual({ release: 'ubuntu-24.04', build: 'macos-15', sign: 'macos-15', attach: 'ubuntu-24.04', publish: 'ubuntu-24.04' });
    expect(raw).not.toMatch(/macos-1[34]\b|macos-latest/);
    const nodes = allSteps.filter((s) => s.uses?.startsWith('actions/setup-node@'));
    expect(nodes.length).toBe(5);
    for (const s of nodes) expect(String((s.with as any)['node-version']), label(s)).toBe(NODE_PIN.version);
  });

  it('no cache anywhere: no actions/cache step, and every setup-node has package-manager-cache: false and no cache key', () => {
    expect(allSteps.filter((s) => s.uses?.startsWith('actions/cache')).map(label)).toEqual([]);
    expect(raw).not.toMatch(/actions\/cache\b|restore-keys|cache-hit|CACHE_HIT/);
    const nodes = allSteps.filter((s) => s.uses?.startsWith('actions/setup-node@'));
    expect(nodes.length).toBe(5);
    for (const s of nodes) {
      expect(s.with, label(s)).toEqual({ 'node-version': expect.anything(), 'package-manager-cache': false });
      expect(Object.keys(s.with ?? {}).some((k) => /cache/.test(k) && k !== 'package-manager-cache'), label(s)).toBe(false);
    }
  });
});

describe('release.yml: every job checks its Node.js in the shell before its first node call', () => {
  const CHECK = 'Node.js is the pinned binary';
  /** A scratch checkout holding only apps/desktop/bundle/node.json (these pins), and a stand-in `node` (these bytes) first on PATH. */
  const scene = (pins: Record<string, string>, bytes = 'a node binary') => {
    const cwd = dir('node-check');
    mkdirSync(join(cwd, 'apps', 'desktop', 'bundle'), { recursive: true });
    writeFileSync(join(cwd, 'apps', 'desktop', 'bundle', 'node.json'), `${JSON.stringify({ v: 1, version: '22.16.0', sha256: pins }, null, 1)}\n`);
    const bin = dir('fake-node');
    writeFileSync(join(bin, 'node'), bytes);
    chmodSync(join(bin, 'node'), 0o755);
    return { cwd, bin, sha: createHash('sha256').update(bytes).digest('hex') };
  };
  const sha = (t: string) => createHash('sha256').update(t).digest('hex');

  it('in each job: checkout, setup-node, then the check (the same script everywhere) — no step before it runs anything, and it runs no node itself', () => {
    const scripts = new Set<string>();
    for (const [name, j] of Object.entries(jobs)) {
      const at = j.steps.findIndex((s) => s.name === CHECK);
      expect(at, name).toBe(2);
      expect(j.steps.slice(0, 2).map((s) => s.uses?.split('@')[0]), name).toEqual(['actions/checkout', 'actions/setup-node']);
      for (const s of j.steps.slice(0, at)) expect(s.run, label({ job: name, ...s })).toBeUndefined();
      // Every later node call comes after it.
      expect(j.steps.findIndex((s) => /(?:^|[\s;|&(`$])node\s/m.test(s.run ?? '') || BUILD_TOOL.test(s.run ?? '')), name).toBeGreaterThan(at);
      scripts.add(j.steps[at]!.run!);
    }
    expect(scripts.size).toBe(1);
    const run = [...scripts][0]!;
    expect(run).not.toMatch(/(?:^|[\s;|&(`$])node\s/m);
    expect(run).toMatch(/shasum -a 256 "\$bin"/);
    expect(run).toMatch(/bin=\$\(command -v node\)/);
  });

  it('run: the pinned binary of the runner\'s platform passes; another binary, another platform\'s pin, a platform with no pin or no node at all fails, naming both sums', () => {
    const s = step('publish', CHECK);
    const linux = { RUNNER_OS: 'Linux', RUNNER_ARCH: 'X64' };
    const mac = { RUNNER_OS: 'macOS', RUNNER_ARCH: 'ARM64' };
    const ok = scene({ 'darwin-arm64': sha('other'), 'linux-x64': sha('a node binary') });
    const pass = runStep(s, linux, ok.bin, ok.cwd);
    expect(pass.status, pass.stderr + pass.stdout).toBe(0);
    expect(pass.stdout).toMatch(/: the pinned binary for linux-x64\n$/);
    const asMac = runStep(s, mac, ok.bin, ok.cwd);
    expect(asMac.status).not.toBe(0);
    expect(asMac.stdout).toContain(`::error::${join(ok.bin, 'node')} is not the Node.js binary apps/desktop/bundle/node.json pins for darwin-arm64 (sha256 ${ok.sha}, pinned ${sha('other')})`);
    const tampered = scene({ 'linux-x64': sha('a node binary') }, 'a node binary, changed');
    expect(runStep(s, linux, tampered.bin, tampered.cwd).status).not.toBe(0);
    const unpinned = runStep(s, mac, ok.bin, scene({ 'linux-x64': ok.sha }).cwd);
    expect(unpinned.status).not.toBe(0);
    expect(unpinned.stdout).toMatch(/::error::apps\/desktop\/bundle\/node\.json pins no Node\.js binary for darwin-arm64\n/);
    const other = runStep(s, { RUNNER_OS: 'Windows', RUNNER_ARCH: 'X64' }, ok.bin, ok.cwd);
    expect(other.status).not.toBe(0);
    expect(other.stdout).toMatch(/pins no Node\.js binary for Windows-X64/);
    const none = runStep(s, { ...linux, PATH: '/usr/bin:/bin' }, undefined, ok.cwd);
    expect(none.status).not.toBe(0);
    expect(none.stdout).toMatch(/::error::no Node\.js on PATH/);
  });

  it('run against the committed node.json: it reads the pin of each platform the jobs run on (darwin-arm64, linux-x64)', async () => {
    const { NODE_PIN } = await bundleModule();
    expect(Object.keys(NODE_PIN.sha256).sort()).toEqual(['darwin-arm64', 'linux-x64']);
    const fake = scene({});
    for (const [env, platform] of [[{ RUNNER_OS: 'macOS', RUNNER_ARCH: 'ARM64' }, 'darwin-arm64'], [{ RUNNER_OS: 'Linux', RUNNER_ARCH: 'X64' }, 'linux-x64']] as const) {
      const r = runStep(step('release', CHECK), env, fake.bin);
      expect(r.status).not.toBe(0);
      expect(r.stdout).toContain(`pins for ${platform} (sha256 ${fake.sha}, pinned ${NODE_PIN.sha256[platform]})`);
    }
    // The runners: the macOS jobs on Apple silicon, the others on x64 ubuntu — each with its pin.
    for (const j of Object.values(jobs)) expect(['macos-15', 'ubuntu-24.04']).toContain(j['runs-on']);
  });
});

describe('release.yml: the keys never share a runner with dependency code (review e A-H1)', () => {
  it('the build job runs the dependency code and holds no secret, no variable, no token, no environment', () => {
    const b = jobs.build!;
    expect(b.steps.filter((s) => BUILD_TOOL.test(s.run ?? '')).length).toBeGreaterThanOrEqual(6);
    expect(JSON.stringify(b)).not.toMatch(/secrets\.|vars\.|github\.token/);
    expect(b.environment).toBeUndefined();
    expect(b.permissions).toEqual({ contents: 'read' });
  });

  it('no other job runs a build tool; the sign job uses checkout, setup-node and the artifact actions only, runs bash on the keychain script and node on repository files only', () => {
    for (const s of allSteps.filter((x) => x.job !== 'build')) expect(BUILD_TOOL.test(s.run ?? ''), label(s)).toBe(false);
    const sign = jobs.sign!;
    expect(sign.steps.filter((s) => s.uses).map((s) => s.uses!.split('@')[0]).sort()).toEqual(['actions/checkout', 'actions/download-artifact', 'actions/setup-node', 'actions/upload-artifact']);
    const script = sign.steps.map((s) => s.run ?? '').join('\n');
    expect([...script.matchAll(/\bbash (\S+)/g)].map((m) => m[1])).toEqual(['apps/desktop/scripts/ci-keychain.sh', 'apps/desktop/scripts/ci-keychain.sh']);
    expect([...script.matchAll(/\bnode (\S+ \S+)/g)].map((m) => m[1])).toEqual(['apps/desktop/scripts/release.mjs unpack', 'apps/desktop/scripts/release.mjs sign', 'apps/desktop/scripts/release.mjs sign']);
    // Nothing of the app it was handed runs there: the unpacked folder is only named to release.mjs.
    expect(script).not.toMatch(/adhoc\/[^"\s]*\/(?:MacOS|bin)\//);
  });

  it('the sign entry\'s whole import graph is Node.js built-ins and files of this repository — no package, no dynamic import (the sign job installs none)', () => {
    for (const entry of ['apps/desktop/scripts/release.mjs', 'scripts/release.mjs', 'scripts/publish-update.mjs']) {
      const g = importGraph(join(REPO, entry));
      expect(g.bare, entry).toEqual([]);
      // One dynamic import in the graph: desktop.mjs build() (`pnpm desktop:build`, the developer app — its own command,
      // started by its own main guard only) loads packages/mcp; bundle.mjs takes words and the icon maker from desktop.mjs.
      expect(g.dynamic, entry).toEqual(g.files.includes('apps/desktop/scripts/desktop.mjs') ? ["apps/desktop/scripts/desktop.mjs: import(pathToFileURL(join(REPO, 'packages', 'mcp', 'dist', 'index.js')"] : []);
      for (const f of g.files) expect(f.startsWith('..') || f.includes('node_modules'), f).toBe(false);
      if (entry === 'apps/desktop/scripts/release.mjs') expect(g.files).toEqual(['apps/desktop/scripts/bundle.mjs', 'apps/desktop/scripts/desktop.mjs', 'apps/desktop/scripts/release.mjs', 'apps/desktop/scripts/sign.mjs', 'scripts/publish-update.mjs']);
    }
    // The walk itself finds a package import, a dynamic one and a nested one (canaries).
    const d = dir('graph');
    writeFileSync(join(d, 'a.mjs'), "import { x } from './b.mjs';\nimport fs from 'node:fs';\n");
    writeFileSync(join(d, 'b.mjs'), "export const x = 1;\nimport 'yaml';\nconst m = await import(name);\n");
    const g = importGraph(join(d, 'a.mjs'));
    expect(g.bare.map((b) => b.split(': ')[1])).toEqual(['yaml']);
    expect(g.dynamic.length).toBe(1);
    const desktop = readFileSync(join(REPO, 'apps', 'desktop', 'scripts', 'desktop.mjs'), 'utf8');
    const fn = desktop.slice(desktop.indexOf('async function build() {'), desktop.indexOf('\nfunction dev() {'));
    expect(fn).toContain("await import(pathToFileURL(join(REPO, 'packages', 'mcp', 'dist', 'index.js')).href)");
    expect(desktop.match(/\bbuild\(\)/g)?.length).toBe(2);
    expect(desktop).toMatch(/if \(resolve\(process\.argv\[1\] \?\? ''\) === fileURLToPath\(import\.meta\.url\)\) \{[^]*\bbuild\(\)/);
  });

  it('the build job hands its app over packed with its sha256; the sign job checks that sha256 before it unpacks anything', () => {
    expect(jobs.build!.outputs).toEqual({ sha256: '${{ steps.pack.outputs.sha256 }}' });
    const pack = step('build', 'Pack the app').run!;
    expect(pack).toMatch(/\/usr\/bin\/tar --no-mac-metadata --no-xattrs -czf "\$A\/retake-app\.tar\.gz" -C "\$RUNNER_TEMP\/bundle" app tauri-cli bundle-report\.json/);
    expect(pack).toMatch(/echo "sha256=\$\(shasum -a 256 "\$A\/retake-app\.tar\.gz" \| cut -d' ' -f1\)" >> "\$GITHUB_OUTPUT"/);
    const up = allSteps.filter((s) => s.uses?.startsWith('actions/upload-artifact@'));
    const down = allSteps.filter((s) => s.uses?.startsWith('actions/download-artifact@'));
    expect(up.map((s) => `${s.job}:${(s.with as any).name}`)).toEqual(['build:retake-app-adhoc', 'sign:retake-release']);
    expect(down.map((s) => `${s.job}:${(s.with as any).name}`)).toEqual(['sign:retake-app-adhoc', 'attach:retake-release']);
    expect(step('sign', 'The build job\'s app').env).toEqual({ SHA256: '${{ needs.build.outputs.sha256 }}' });
  });

  it('the sign job\'s check, run: the packed app with its sha256 is unpacked — its three parts only (release.mjs unpack); another sha256 or none fails before anything is unpacked, an archive with anything else fails and leaves nothing', () => {
    const s = step('sign', 'The build job\'s app');
    expect(s.run).toMatch(/echo "\$SHA256 {2}\$A" \| shasum -a 256 -c\n[^]*node apps\/desktop\/scripts\/release\.mjs unpack "\$A" --into "\$D"\n?$/);
    expect(s.run).not.toMatch(/(?:^|[\s;|&(])(?:\/usr\/bin\/)?tar\s/m);
    /** The build job's pack (the same tar line) of a folder holding the parts, and `extra` beside them. */
    const pack = (temp: string, extra: string[] = []) => {
      const src = dir('packed');
      mkdirSync(join(src, 'app', 'Retake.app', 'Contents'), { recursive: true });
      writeFileSync(join(src, 'app', 'Retake.app', 'Contents', 'Info.plist'), '<plist/>');
      mkdirSync(join(src, 'tauri-cli', 'node_modules', '@tauri-apps', 'cli'), { recursive: true });
      writeFileSync(join(src, 'tauri-cli', 'node_modules', '@tauri-apps', 'cli', 'tauri.js'), '');
      writeFileSync(join(src, 'bundle-report.json'), '{}');
      for (const e of extra) {
        mkdirSync(dirname(join(src, e)), { recursive: true });
        writeFileSync(join(src, e), 'planted');
      }
      mkdirSync(join(temp, 'artifact'), { recursive: true });
      const tar = join(temp, 'artifact', 'retake-app.tar.gz');
      const tops = [...new Set(['app', 'tauri-cli', 'bundle-report.json', ...extra.map((e) => e.split('/')[0]!)])];
      expect(spawnSync('/usr/bin/tar', ['--no-mac-metadata', '--no-xattrs', '-czf', tar, '-C', src, ...tops]).status).toBe(0);
      return createHash('sha256').update(readFileSync(tar)).digest('hex');
    };
    const temp = dir('sign-temp');
    const sha = pack(temp);
    for (const bad of ['0'.repeat(64), '', 'not-a-sum']) {
      const r = runStep(s, { RUNNER_TEMP: temp, SHA256: bad });
      expect(r.status, bad).not.toBe(0);
      expect(existsSync(join(temp, 'adhoc')), bad).toBe(false);
    }
    const ok = runStep(s, { RUNNER_TEMP: temp, SHA256: sha });
    expect(ok.status, ok.stderr).toBe(0);
    expect(readdirSync(join(temp, 'adhoc')).sort()).toEqual(['app', 'bundle-report.json', 'tauri-cli']);
    expect(readFileSync(join(temp, 'adhoc', 'app', 'Retake.app', 'Contents', 'Info.plist'), 'utf8')).toBe('<plist/>');
    // A node_modules beside the parts (where a module lookup from tauri-cli/ would find it), or anything else: refused.
    for (const extra of [['node_modules/@tauri-apps/cli-darwin-universal/index.js'], ['app/Other.app/x'], ['notes.txt']]) {
      const t = dir('sign-temp');
      const r = runStep(s, { RUNNER_TEMP: t, SHA256: pack(t, extra) });
      expect(r.status, extra.join()).not.toBe(0);
      expect(r.stderr, extra.join()).toMatch(/release: \S+ is not the build job's archive: .*not a part of the build/);
      expect(existsSync(join(t, 'adhoc')), extra.join()).toBe(false);
    }
  });
});

describe('release.yml: secrets and the job token go only where they are used', () => {
  it('secrets appear in steps\' env only (never in the workflow\'s or a job\'s env, a `with`, an `if` or a script)', () => {
    expect(JSON.stringify(wf.env ?? {})).not.toMatch(/secrets\./);
    for (const j of Object.values(jobs)) expect(JSON.stringify((j as any).env ?? {})).not.toMatch(/secrets\./);
    for (const s of allSteps) {
      expect(JSON.stringify({ with: s.with ?? {}, if: s.if ?? '', run: s.run ?? '' }), label(s)).not.toMatch(/secrets\./);
      for (const [k, v] of Object.entries(s.env ?? {})) if (/secrets\./.test(String(v))) expect(Object.keys(secretsOf(s)).includes(k) || PRESENCE.test(String(v)), `${label(s)} ${k}`).toBe(true);
    }
    expect(raw).not.toMatch(/secrets\.GITHUB_TOKEN|toJSON\(secrets\)/);
  });

  it('key material only in sign › Signing material, which runs no build tool and no gh, writes with umask 077, checks the whole set first', () => {
    const material = allSteps.filter((s) => Object.values(secretsOf(s)).some((x) => MATERIAL_SECRETS.includes(x)));
    expect(material.map(label)).toEqual(['sign › Signing material']);
    const m = material[0]!;
    expect(BUILD_TOOL.test(m.run!) || CALLS_GH.test(m.run!) || usesToken(m)).toBe(false);
    expect(m.run).toMatch(/umask 077/);
    expect(m.run!.indexOf('missing="$missing')).toBeLessThan(m.run!.indexOf('ci-keychain.sh import'));
    // The sign job's first steps: checkout, setup-node, the Node.js check, then the set (review e B-L4).
    expect(jobs.sign!.steps.findIndex((s) => s.name === 'Signing material')).toBe(3);
  });

  it('the job token only in the steps that call gh and in publish › Publish the update (publish-update.mjs, no build tool), holding no secret; no update-host setting anywhere (L5.16f)', () => {
    const withToken = allSteps.filter(usesToken);
    expect(withToken.map(label)).toEqual(['release › The repository\'s visibility', 'release › Create the release (draft)', 'attach › Attach to the draft release', 'publish › Publish the release', 'publish › Fetch the signed update archive', 'publish › Publish the update']);
    for (const s of withToken) {
      expect(CALLS_GH.test(s.run ?? '') || label(s) === 'publish › Publish the update', label(s)).toBe(true);
      expect(secretsOf(s), label(s)).toEqual({});
      expect(BUILD_TOOL.test(s.run ?? ''), label(s)).toBe(false);
    }
    for (const s of allSteps) if (CALLS_GH.test(s.run ?? '')) expect(usesToken(s), label(s)).toBe(true);
    // The publication: the job token as GITHUB_TOKEN (what publish-update.mjs reads), our script only.
    const p = step('publish', 'Publish the update');
    expect(p.env!.GITHUB_TOKEN).toBe('${{ github.token }}');
    expect(p.run!.split('\n').filter((l) => /\bnode\b/.test(l)).map((l) => l.trim().split(' ').slice(0, 2).join(' '))).toEqual(['RETAKE_UPDATE_FEED=$(node scripts/release.mjs', 'node scripts/publish-update.mjs']);
    expect(raw).not.toMatch(/UPDATES_|update host/);
    // One publication at a time across tags: two runs never rewrite the feed together.
    expect((jobs.publish as any).concurrency).toEqual({ group: 'release-publish', 'cancel-in-progress': false });
  });

  it('every secret a step binds, its script (or the script it runs) uses; the sign step unsets the empty ones (an unset secret arrives as "")', () => {
    const scriptOf = (s: Step) => [s.run ?? '', ...[...(s.run ?? '').matchAll(/(?:bash|node) ((?:apps\/desktop\/)?scripts\/[\w.-]+\.(?:sh|mjs))/g)].map((m) => readFileSync(join(REPO, m[1]!), 'utf8'))].join('\n');
    for (const s of allSteps) for (const k of Object.keys(secretsOf(s))) expect(scriptOf(s), `${label(s)} ${k}`).toContain(k);
    const sign = step('sign', 'Sign, notarise, the update archive and the DMG');
    const loop = /for v in ([\s\S]*?); do/.exec(sign.run!)?.[1]?.replace(/\\\n/g, ' ').split(/\s+/).filter(Boolean) ?? [];
    for (const k of Object.keys(sign.env!)) if (!['SIGNED', 'UPDATES', 'VERSION'].includes(k)) expect(loop, k).toContain(k);
    expect(sign.run).toMatch(/if \[ "\$UPDATES" != on \]; then\n\s+unset TAURI_SIGNING_PRIVATE_KEY TAURI_SIGNING_PRIVATE_KEY_PASSWORD RETAKE_UPDATE_PUBKEY/);
    // An ad hoc build gets no Apple variable at all; --release only with the Apple set.
    expect(sign.run).toMatch(/if \[ "\$SIGNED" = true \]; then\n\s+node apps\/desktop\/scripts\/release\.mjs sign "\$@" --release\n\s*else\n\s+unset APPLE_SIGNING_IDENTITY APPLE_TEAM_ID APPLE_API_KEY APPLE_API_ISSUER APPLE_API_KEY_PATH APPLE_KEYCHAIN\n/);
    expect(sign.run!.match(/release\.mjs sign "\$@"( --release)?\n/g)).toEqual(['release.mjs sign "$@" --release\n', 'release.mjs sign "$@"\n']);
    expect(sign.run).toMatch(/--app "\$RUNNER_TEMP\/adhoc\/app\/Retake\.app" --tauri-cli "\$RUNNER_TEMP\/adhoc\/tauri-cli" \\\n\s+--out "\$RUNNER_TEMP\/out" --app-version "\$VERSION"/);
  });

  it('the temporary keychain is removed in an always() step at the sign job\'s end; its files go even when security fails (review e A-L2)', () => {
    const steps = jobs.sign!.steps;
    const del = steps.findIndex((s) => /ci-keychain\.sh delete/.test(s.run ?? ''));
    expect(del).toBe(steps.length - 1);
    expect(steps[del]!.if).toBe('always()');
    const sec = fakeSecurity('x', { fail: 'delete-keychain' });
    const temp = dir('cleanup');
    const S = join(temp, 'signing');
    mkdirSync(S);
    for (const f of ['retake-signing.keychain-db', 'AuthKey.p8', 'updater.key', 'search-list.txt']) writeFileSync(join(S, f), 'x');
    const r = runStep(steps[del]!, { RUNNER_TEMP: temp }, sec.bin);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/security failed while the keychain was removed/);
    expect(existsSync(S)).toBe(false);
  });
});

describe('release.yml: what it runs', () => {
  it('every script it names exists; the pnpm scripts are the repository\'s; Rust through rustup at least the MSRV', () => {
    const paths = new Set([...raw.matchAll(/(?:apps\/desktop\/)?scripts\/[\w.-]+\.(?:mjs|sh|json)|apps\/desktop\/bundle\/[\w.-]+\.json|packages\/[\w-]+\/node_modules\/[\w-]+\/[\w.-]+\.js/g)].map((m) => m[0]));
    expect(paths.size).toBeGreaterThanOrEqual(9);
    for (const p of paths) {
      if (p.includes('/node_modules/')) {
        const [, pkg, dep] = /^packages\/([\w-]+)\/node_modules\/([\w-]+)\//.exec(p)!;
        expect(JSON.parse(readFileSync(join(REPO, 'packages', pkg!, 'package.json'), 'utf8')).dependencies, p).toHaveProperty(dep!);
      } else expect(existsSync(join(REPO, p)), p).toBe(true);
    }
    const scripts = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).scripts;
    for (const [, name] of raw.matchAll(/pnpm (desktop:\w+|build)\b/g)) expect(scripts, name).toHaveProperty(name!);
    const rust = step('build', 'Rust 1.99.1').run!;
    const msrv = /^rust-version = "(\d+)\.(\d+)"/m.exec(readFileSync(join(REPO, 'apps', 'desktop', 'Cargo.toml'), 'utf8'))!;
    const [, maj, min] = /rustup toolchain install (\d+)\.(\d+)\.\d+ --profile minimal --target aarch64-apple-darwin\n/.exec(rust)!.map(Number);
    expect(maj! * 1000 + min!).toBeGreaterThanOrEqual(Number(msrv[1]) * 1000 + Number(msrv[2]));
    expect(rust).toMatch(/echo "RUSTUP_TOOLCHAIN=1\.99\.1" >> "\$GITHUB_ENV"/);
  });

  it('the build job: Node.js checked first, the browsers checked after their install, ffmpeg built at every run, the app laid out ad hoc by desktop:bundle --app-only; Homebrew never updates itself, pkg-config\'s version said', () => {
    const names = jobs.build!.steps.map((s) => s.name ?? s.uses);
    expect(names.indexOf('Node.js is the pinned binary')).toBeLessThan(names.indexOf('pnpm (corepack, at package.json\'s packageManager)'));
    expect(names.indexOf('pnpm (corepack, at package.json\'s packageManager)')).toBeLessThan(names.indexOf('Dependencies'));
    expect(step('build', 'Chromium and the headless shell').run).toMatch(/cli\.js install chromium chromium-headless-shell\nnode apps\/desktop\/scripts\/bundle\.mjs check-pins\n/);
    const lay = step('build', 'Lay out the app (ad hoc)');
    expect(lay.run).toMatch(/pnpm desktop:bundle --app-only --ffmpeg "\$RUNNER_TEMP\/ffmpeg"/);
    expect(lay.env).toEqual({ UPDATES: '${{ needs.release.outputs.updates }}', FEED: '${{ needs.release.outputs.feed }}', PUBKEY: '${{ needs.release.outputs.pubkey }}' });
    const ff = step('build', 'ffmpeg');
    expect(ff.env!.HOMEBREW_NO_AUTO_UPDATE).toBe('1');
    expect(ff.run).toMatch(/brew install pkgconf\n\s*echo "pkg-config \$\(pkg-config --version\)/);
    // Built at every run: the fetch, the build and the check are the step's own lines, under no condition.
    expect(ff.run).toMatch(/^node scripts\/build-ffmpeg\.mjs --fetch --sources "\$RUNNER_TEMP\/ffmpeg-sources" --out "\$RUNNER_TEMP\/ffmpeg"\nnode scripts\/build-ffmpeg\.mjs --check "\$RUNNER_TEMP\/ffmpeg"\n?$/m);
    expect(ff.run).not.toMatch(/\bif\b|\bfi\b|&&/);
    expect(ff.if).toBeUndefined();
    expect(raw.match(/\bbrew\b/g)?.length).toBe(1);
  });

  it('pnpm is corepack\'s, at package.json\'s packageManager, which carries the sha512 corepack checks the download against', () => {
    const pm = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).packageManager;
    expect(pm).toMatch(/^pnpm@\d+\.\d+\.\d+\+sha512\.[0-9a-f]{128}$/);
    const p = step('build', 'pnpm (corepack, at package.json\'s packageManager)');
    expect(p.run).toMatch(/^set -eu\ncorepack enable\npnpm --version\n?$/);
    expect(p.env).toEqual({ COREPACK_ENABLE_DOWNLOAD_PROMPT: '0' });
    expect(p.id).toBeUndefined();
  });

  it('the release job: the version files agree and the tag is that version, the tagged commit is on main, what is configured; a pre-release tag makes a pre-release', () => {
    const v = step('release', 'The tag is the version');
    expect(v.run).toMatch(/node scripts\/set-version\.mjs --check\n/);
    expect(v.run).toMatch(/node scripts\/release\.mjs tag "\$GITHUB_REF_NAME" >> "\$GITHUB_OUTPUT"/);
    const config = ['signed', 'updates', 'feed', 'pubkey', 'dmg', 'archive', 'signature'];
    expect(jobs.release!.outputs).toEqual({ version: '${{ steps.version.outputs.version }}', prerelease: '${{ steps.version.outputs.prerelease }}', ...Object.fromEntries(config.map((k) => [k, `\${{ steps.config.outputs.${k} }}`])) });
    expect(step('release', 'The tagged commit is on main').run).toMatch(/git merge-base --is-ancestor "\$GITHUB_SHA" origin\/main/);
    expect((jobs.release!.steps[0]!.with as any)['fetch-depth']).toBe(0);
    const names = jobs.release!.steps.map((s) => s.name);
    expect(names.indexOf('What is configured')).toBeLessThan(names.indexOf('Create the release (draft)'));
    expect(step('release', 'Create the release (draft)').run).toMatch(/gh release create "\$GITHUB_REF_NAME" --verify-tag --draft .*--prerelease="\$PRERELEASE"/s);
    const pub = step('publish', 'Publish the release');
    expect(pub.env!.PRERELEASE).toBe('${{ needs.release.outputs.prerelease }}');
    expect(pub.run).toMatch(/--draft=false --prerelease\n[\s\S]*--draft=false --latest/);
    // No job but the release job's checks rewrites a version file.
    expect(JSON.stringify({ ...jobs, release: undefined })).not.toMatch(/set-version\.mjs/);
  });

  it('what is configured: the step binds each name of the two sets as it must (a secret\'s presence, a variable\'s value, each in the other store\'s presence too) and runs the preflight', async () => {
    const { CONFIG_SETS } = await releaseModule();
    const s = step('release', 'What is configured');
    const want: Record<string, string> = { VERSION: '${{ steps.version.outputs.version }}', REPO_PRIVATE: '${{ steps.repository.outputs.private }}', REPO_VISIBILITY: '${{ steps.repository.outputs.visibility }}' };
    for (const { names } of Object.values(CONFIG_SETS) as Array<{ names: Record<string, string> }>) {
      for (const [name, kind] of Object.entries(names)) {
        if (kind === 'secret') {
          want[`HAS_SECRET_${name}`] = `\${{ secrets.${name} != '' }}`;
          want[`HAS_VAR_${name}`] = `\${{ vars.${name} != '' }}`;
        } else {
          want[name] = `\${{ vars.${name} }}`;
          want[`HAS_SECRET_${name}`] = `\${{ secrets.${name} != '' }}`;
        }
      }
    }
    expect(s.env).toEqual(want);
    expect(s.run).toBe('set -eu\nnode scripts/release.mjs preflight "$VERSION" --output "$GITHUB_OUTPUT"\nnode scripts/release.mjs files "$VERSION" >> "$GITHUB_OUTPUT"\n');
  });

  it('the repository\'s visibility, run (review f A-L3): read with the job token through gh api, handed to the preflight as private= / visibility=', () => {
    const s = step('release', 'The repository\'s visibility');
    expect(s.id).toBe('repository');
    expect(s.env).toEqual({ GH_TOKEN: '${{ github.token }}' });
    const steps = jobs.release!.steps.map((x) => x.name);
    expect(steps.indexOf('The repository\'s visibility')).toBe(steps.indexOf('What is configured') - 1);
    const gh = fakeGh();
    const r = runStep(s, { GH_REPO: 'example-owner/example-repo', FAKE_API: 'private=false\nvisibility=public\n' }, gh.bin);
    expect(r.status, r.stderr).toBe(0);
    expect(r.outputs).toEqual({ private: 'false', visibility: 'public' });
    expect(gh.calls()).toEqual([['api', 'repos/example-owner/example-repo', '--jq', '"private=\\(.private)", "visibility=\\(.visibility)"']]);
  });

  it('what is configured, run: nothing → an ad hoc build without updates (each said); a partial set fails naming what is missing, a variable entered as a secret said so', async () => {
    const { CONFIG_SETS } = await releaseModule();
    const s = step('release', 'What is configured');
    const none = Object.fromEntries(Object.keys(s.env!).filter((k) => k.startsWith('HAS_')).map((k) => [k, 'false']));
    const off = runStep(s, { ...none, VERSION: '0.2.0' });
    expect(off.status, off.stderr).toBe(0);
    expect(off.outputs).toEqual({ signed: 'false', updates: 'off', dmg: 'Retake_0.2.0_aarch64.dmg', archive: 'Retake.app.tar.gz', signature: 'Retake.app.tar.gz.sig' });
    expect(off.stdout).toMatch(/::warning::No Apple signing set[\s\S]*::warning::Updates are off in this build/);
    const apple = Object.fromEntries(Object.keys(CONFIG_SETS.apple.names).map((k) => [`HAS_SECRET_${k}`, 'true']));
    const signed = runStep(s, { ...none, ...apple, VERSION: '0.2.0' });
    expect(signed.outputs.signed).toBe('true');
    const partial = runStep(s, { ...none, ...apple, HAS_SECRET_APPLE_API_KEY_P8: 'false', HAS_SECRET_RETAKE_UPDATE_PUBKEY: 'true', VERSION: '0.2.0' });
    expect(partial.status).toBe(1);
    expect(partial.stdout).toMatch(/::error::A Developer ID build, notarised needs all of .* — or none: missing APPLE_API_KEY_P8 \(a secret, not set\)/);
    expect(partial.stdout).toMatch(/::error::An app that updates itself .* missing TAURI_SIGNING_PRIVATE_KEY \(a secret, not set\), .*RETAKE_UPDATE_PUBKEY \(set as a secret: it must be a variable\)/);
    expect(partial.outputs.signed).toBeUndefined();
    // The updater set: its feed is this repository's update-feed release, from the run's own context (L5.16f).
    const { generateKeyPairSync } = await import('node:crypto');
    const raw32 = (generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }) as Buffer).subarray(12);
    const pubkey = Buffer.from(`untrusted comment: minisign public key\n${Buffer.concat([Buffer.from('Ed'), Buffer.alloc(8, 7), raw32]).toString('base64')}\n`).toString('base64');
    const updater = { ...none, HAS_SECRET_TAURI_SIGNING_PRIVATE_KEY: 'true', HAS_SECRET_TAURI_SIGNING_PRIVATE_KEY_PASSWORD: 'true', RETAKE_UPDATE_PUBKEY: pubkey, VERSION: '0.3.0-rc.1' };
    const here = { GITHUB_REPOSITORY: 'example-owner/example-repo', GITHUB_SERVER_URL: 'https://github.example.test', REPO_PRIVATE: 'false', REPO_VISIBILITY: 'public' };
    const on = runStep(s, { ...updater, ...here });
    expect(on.status, on.stdout).toBe(0);
    expect(on.outputs).toMatchObject({ updates: 'on', feed: 'https://github.example.test/example-owner/example-repo/releases/download/update-feed/rc.json', pubkey });
    const nowhere = runStep(s, { ...updater, REPO_PRIVATE: 'false', REPO_VISIBILITY: 'public' });
    expect(nowhere.status).toBe(1);
    expect(nowhere.stdout).toMatch(/::error::The update feed: GITHUB_REPOSITORY is not set/);
    // Review f A-L3: a repository that is not public is refused here, before anything is built — not after the release.
    const hidden = runStep(s, { ...updater, ...here, REPO_PRIVATE: 'true', REPO_VISIBILITY: 'private' });
    expect(hidden.status).toBe(1);
    expect(hidden.stdout).toMatch(/::error::The update feed: the repository is not public \(private: true, visibility: private\) — an installed app downloads its updates with no credentials/);
    expect(hidden.outputs.updates).toBeUndefined();
    // Without the updater, the visibility does not matter.
    expect(runStep(s, { ...none, VERSION: '0.2.0', REPO_PRIVATE: 'true', REPO_VISIBILITY: 'private' }).status).toBe(0);
  });
});

describe('release.yml: the files — made, attached to a draft only, fetched for the update', () => {
  const files = { DMG: 'Retake_0.2.0_aarch64.dmg', ARCHIVE: 'Retake.app.tar.gz', SIGNATURE: 'Retake.app.tar.gz.sig' };
  it('the names come from the release job (scripts/release.mjs files: bundle.mjs\'s own names), in Collect and in the fetch', async () => {
    const { releaseFiles } = await releaseModule();
    const { PRODUCT, UPDATE_ARCHIVE } = await bundleModule();
    expect(releaseFiles('0.3.0-rc.1')).toEqual({ dmg: `${PRODUCT}_0.3.0-rc.1_aarch64.dmg`, archive: UPDATE_ARCHIVE, signature: `${UPDATE_ARCHIVE}.sig` });
    // finishApp names the DMG the same way.
    expect(readFileSync(join(REPO, 'apps', 'desktop', 'scripts', 'release.mjs'), 'utf8')).toContain('dmg = join(out, `${PRODUCT}_${manifest.app}_aarch64.dmg`);');
    for (const [job, name] of [['sign', 'Collect the files'], ['publish', 'Fetch the signed update archive'], ['publish', 'Publish the update']] as const) {
      const env = step(job, name).env!;
      for (const k of name === 'Collect the files' ? ['DMG', 'ARCHIVE', 'SIGNATURE'] : ['ARCHIVE', 'SIGNATURE']) expect(env[k], `${name} ${k}`).toBe(`\${{ needs.release.outputs.${k.toLowerCase()} }}`);
    }
  });

  it('Collect, run: the DMG always, the archive and its .sig when updates are on — a missing one fails; SHA256SUMS and its own sum', () => {
    const s = step('sign', 'Collect the files');
    const make = (names: string[]) => {
      const temp = dir('collect');
      mkdirSync(join(temp, 'out'));
      for (const f of [...names, 'release-report.json', '.retake-release']) writeFileSync(join(temp, 'out', f), `bytes of ${f}`);
      return temp;
    };
    const adhoc = runStep(s, { ...files, UPDATES: 'off', RUNNER_TEMP: make([files.DMG, files.ARCHIVE]) });
    expect(adhoc.status, adhoc.stderr).toBe(0);
    expect(readdirSync(join(adhoc.temp, 'release')).sort()).toEqual(['Retake_0.2.0_aarch64.dmg', 'SHA256SUMS-macos.txt']);
    expect(adhoc.outputs.sums).toBe(createHash('sha256').update(readFileSync(join(adhoc.temp, 'release', 'SHA256SUMS-macos.txt'))).digest('hex'));
    const on = runStep(s, { ...files, UPDATES: 'on', RUNNER_TEMP: make([files.DMG, files.ARCHIVE, files.SIGNATURE]) });
    expect(readdirSync(join(on.temp, 'release')).sort()).toEqual(['Retake.app.tar.gz', 'Retake.app.tar.gz.sig', 'Retake_0.2.0_aarch64.dmg', 'SHA256SUMS-macos.txt']);
    expect(readFileSync(join(on.temp, 'release', 'SHA256SUMS-macos.txt'), 'utf8')).toMatch(/^[0-9a-f]{64}  Retake\.app\.tar\.gz\n[0-9a-f]{64}  Retake\.app\.tar\.gz\.sig\n[0-9a-f]{64}  Retake_0\.2\.0_aarch64\.dmg\n$/);
    const unsigned = runStep(s, { ...files, UPDATES: 'on', RUNNER_TEMP: make([files.DMG, files.ARCHIVE]) });
    expect(unsigned.status).toBe(1);
    expect(unsigned.stdout).toMatch(/::error::Retake\.app\.tar\.gz\.sig was not made \(updates: on\)/);
    expect(runStep(s, { ...files, UPDATES: 'off', RUNNER_TEMP: make([]) }).status).toBe(1);
  });

  it('the signing material, run: a partial Apple set fails before any keychain call, naming each missing name; the updater key into a 0600 file', () => {
    const s = step('sign', 'Signing material');
    const sec = fakeSecurity('x');
    const r = runStep(s, { SIGNED: 'true', UPDATES: 'off', APPLE_CERTIFICATE: 'c', APPLE_CERTIFICATE_PASSWORD: 'p', APPLE_SIGNING_IDENTITY: 'i', APPLE_API_KEY_P8: '', HAS_APPLE_TEAM_ID: 'true', HAS_APPLE_API_KEY: 'false', HAS_APPLE_API_ISSUER: 'true' }, sec.bin);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/::error::The release environment lacks APPLE_API_KEY_P8 APPLE_API_KEY \(/);
    expect(sec.calls()).toEqual([]);
    const key = runStep(s, { SIGNED: 'false', UPDATES: 'on', TAURI_SIGNING_PRIVATE_KEY: 'updater-key-canary', HAS_TAURI_SIGNING_PRIVATE_KEY_PASSWORD: 'true' }, sec.bin);
    expect(key.status, key.stderr).toBe(0);
    expect(key.outputs.updater_key).toBe(join(key.temp, 'signing', 'updater.key'));
    expect(readFileSync(key.outputs.updater_key!, 'utf8')).toBe('updater-key-canary\n');
    expect(statSync(key.outputs.updater_key!).mode & 0o777).toBe(0o600);
    expect(key.stdout + key.stderr).not.toMatch(/canary/);
    const nopass = runStep(s, { SIGNED: 'false', UPDATES: 'on', TAURI_SIGNING_PRIVATE_KEY: 'k', HAS_TAURI_SIGNING_PRIVATE_KEY_PASSWORD: 'false' }, sec.bin);
    expect(nopass.status).toBe(1);
    expect(nopass.stdout).toMatch(/lacks TAURI_SIGNING_PRIVATE_KEY_PASSWORD/);
  });

  it('attach, run: a public release is refused before anything is uploaded (review e A-M4, B-M2); a draft loses the files this build does not make, then gets its own', () => {
    const s = step('attach', 'Attach to the draft release');
    const gh = fakeGh();
    const temp = dir('attach');
    mkdirSync(join(temp, 'release'));
    for (const f of [files.DMG, 'SHA256SUMS-macos.txt']) writeFileSync(join(temp, 'release', f), f);
    const env = { RUNNER_TEMP: temp, VERSION: '0.2.0', SIGNED: 'false', UPDATES: 'off', FAKE_ASSETS: `${files.DMG},${files.ARCHIVE},${files.SIGNATURE},SHA256SUMS-macos.txt` };
    const pub = runStep(s, { ...env, FAKE_DRAFT: 'false' }, gh.bin);
    expect(pub.status).toBe(1);
    expect(pub.stdout).toMatch(/::error::v0\.2\.0 is public already: its files are not replaced — tag a new version/);
    expect(gh.calls()).toEqual([['release', 'view', 'v0.2.0', '--json', 'isDraft', '--jq', '.isDraft']]);
    const draft = runStep(s, { ...env, FAKE_DRAFT: 'true' }, gh.bin);
    expect(draft.status, draft.stderr).toBe(0);
    const calls = gh.calls().slice(1).map((c) => c.slice(0, 2).join(' ') + (c[1] === 'delete-asset' ? ` ${c[3]}` : ''));
    expect(calls).toEqual(['release view', 'release view', 'release delete-asset Retake.app.tar.gz', 'release delete-asset Retake.app.tar.gz.sig', 'release upload', 'release edit']);
    const upload = gh.calls().find((c) => c[1] === 'upload')!;
    expect(upload.slice(2).sort()).toEqual(['--clobber', join(temp, 'release', 'Retake_0.2.0_aarch64.dmg'), join(temp, 'release', 'SHA256SUMS-macos.txt'), 'v0.2.0'].sort());
    expect(readFileSync(join(temp, 'notes.md'), 'utf8')).toMatch(/Not notarised[\s\S]*Updates are off/);
  });

  it('the fetch, run (review e B-M3): with updates on, the archive and its .sig come from the release — a missing one fails the job; the publish step builds the feed of the version\'s channel on this repository and hands it to publish-update.mjs', () => {
    const s = step('publish', 'Fetch the signed update archive');
    expect(s.if).toBe("needs.release.outputs.updates == 'on'");
    const gh = fakeGh();
    const rel = dir('release-assets');
    writeFileSync(join(rel, files.ARCHIVE), 'archive');
    const missing = runStep(s, { ...files, FAKE_RELEASE_DIR: rel }, gh.bin);
    expect(missing.status).toBe(1);
    expect(missing.stdout).toMatch(/::error::Retake\.app\.tar\.gz\.sig is not on the release, though this build has the updater/);
    writeFileSync(join(rel, files.SIGNATURE), 'sig');
    const ok = runStep(s, { ...files, FAKE_RELEASE_DIR: rel }, gh.bin);
    expect(ok.status, ok.stderr).toBe(0);
    expect(readdirSync(join(ok.temp, 'update')).sort()).toEqual([files.ARCHIVE, files.SIGNATURE]);
    expect(gh.calls().pop()).toEqual(['release', 'download', 'v0.2.0', '--dir', join(ok.temp, 'update'), '--pattern', files.ARCHIVE, '--pattern', files.SIGNATURE]);
    const publish = step('publish', 'Publish the update');
    expect(publish.if).toBe("needs.release.outputs.updates == 'on'");
    expect(publish.env).toEqual({ VERSION: '${{ needs.release.outputs.version }}', ARCHIVE: '${{ needs.release.outputs.archive }}', SIGNATURE: '${{ needs.release.outputs.signature }}', RETAKE_UPDATE_PUBKEY: '${{ needs.release.outputs.pubkey }}', GITHUB_TOKEN: '${{ github.token }}' });
    expect(publish.run).toMatch(/RETAKE_UPDATE_FEED=\$\(node scripts\/release\.mjs feed "\$VERSION"\)\n\s*export RETAKE_UPDATE_FEED\n[\s\S]*node scripts\/publish-update\.mjs "\$VERSION" --artifact "\$D\/\$ARCHIVE" --signature "\$D\/\$SIGNATURE"/);
    expect(() => step('publish', 'The update is not published')).toThrow(/no step/);
    // Run (no network: it stops before any request): the feed of the version's channel on the run's repository passes
    // publish-update's check, then the archive (no gzip here) is refused; without GITHUB_REPOSITORY, no feed.
    writeFileSync(join(ok.temp, 'update', files.ARCHIVE), 'not a gzip');
    const ctx = { ...files, VERSION: '0.2.0', RUNNER_TEMP: ok.temp, RETAKE_UPDATE_PUBKEY: 'k', GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'example-owner/example-repo', GITHUB_SERVER_URL: 'https://github.example.test', GITHUB_API_URL: 'https://api.github.example.test' };
    const pubRun = runStep(publish, ctx);
    expect(pubRun.status).toBe(1);
    expect(pubRun.stderr).toMatch(/^publish-update: .*Retake\.app\.tar\.gz is not a gzip archive/m);
    const noRepo = runStep(publish, { ...ctx, GITHUB_REPOSITORY: '' });
    expect(noRepo.status).toBe(1);
    expect(noRepo.stderr).toMatch(/^release: GITHUB_REPOSITORY is not set/m);
  });
});

/** sha256 of words that must never appear in the release files (a reference app, an account): only their hashes here. */
const DENIED = new Set(['a1d648cffa6e2ba0f94c51f51e0cb8f2be4fa6c3d227176016291f9ce64e90e7', '73562ffe71a5ff592fad20a1ffbd06c0bee1cb5106de93e23643188f2fda0690']);
const RELEASE_FILES = ['.github/workflows/release.yml', 'apps/desktop/scripts/ci-keychain.sh', 'apps/desktop/scripts/release.mjs', 'scripts/release.mjs', 'docs/RELEASING.md', 'apps/desktop/bundle/node.json', 'apps/desktop/bundle/browsers.json'];

describe('the release files stay generic', () => {
  it('no host, domain, account or repository of anyone in the workflow, the keychain script, the helper or RELEASING.md', () => {
    for (const f of RELEASE_FILES) {
      const text = readFileSync(join(REPO, f), 'utf8');
      for (const word of text.toLowerCase().split(/[^a-z0-9]+/)) expect(DENIED.has(createHash('sha256').update(word).digest('hex')), `${f}: a denied word`).toBe(false);
      for (const m of text.matchAll(/\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|dev|co|me|cloud)\b/gi)) expect(m[0], f).toMatch(/(?:^|\.)example\.(?:com|net|org)$/i);
      for (const m of text.matchAll(/https?:\/\/[^\s)`'"]+/g)) expect(m[0], f).toMatch(/^https:\/\/(?:[a-z0-9-]+\.)*example\.(?:com|net|org)(?:\/|$)/);
    }
    // The workflow names its repository only through github.repository; its actions' owners are GitHub's and the toolchain's.
    expect(raw).not.toMatch(/github\.com|ghcr\.io|@users\.noreply/);
    for (const m of raw.matchAll(/uses:\s*([\w.-]+)\//g)) expect(m[1]).toBe('actions');
  });

  it('the deny list holds hashes only, and the word scan finds a listed word (a canary)', () => {
    for (const h of DENIED) expect(h).toMatch(/^[0-9a-f]{64}$/);
    const listed = new Set([...DENIED, createHash('sha256').update('canaryword').digest('hex')]);
    const found = 'Built by CanaryWord, see notes.'.toLowerCase().split(/[^a-z0-9]+/).some((w) => listed.has(createHash('sha256').update(w).digest('hex')));
    expect(found).toBe(true);
  });
});

describe('scripts/release.mjs', () => {
  const versions = (v: string, other = v) => [{ path: 'package.json', version: v }, { path: 'apps/desktop/tauri.conf.json', version: other }];

  it('tag: v<version> of a repository that agrees with itself; prerelease from the version; anything else refused, naming the fix', async () => {
    const { tagVersion } = await releaseModule();
    expect(tagVersion('v0.2.1', versions('0.2.1'))).toEqual({ version: '0.2.1', prerelease: false });
    expect(tagVersion('v0.3.0-rc.1', versions('0.3.0-rc.1'))).toEqual({ version: '0.3.0-rc.1', prerelease: true });
    for (const bad of ['0.2.1', 'v0.2', 'vv0.2.1', 'v0.2.1 ', 'release-0.2.1', 'v0.2.1+build', '']) expect(() => tagVersion(bad, versions('0.2.1')), bad).toThrow(/is not a release tag/);
    expect(() => tagVersion('v0.2.2', versions('0.2.1'))).toThrow(/the tag v0\.2\.2 is not the repository's version \(0\.2\.1\): node scripts\/set-version\.mjs 0\.2\.2/);
    expect(() => tagVersion('v0.2.1', versions('0.2.1', '0.2.0'))).toThrow(/version files disagree \(apps\/desktop\/tauri\.conf\.json: 0\.2\.0; package\.json: 0\.2\.1\)/);
    // The repository's own files, through the command line the workflow runs.
    const own = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).version;
    const ok = spawnSync(process.execPath, [join(REPO, 'scripts', 'release.mjs'), 'tag', `v${own}`], { encoding: 'utf8' });
    expect(ok.status).toBe(0);
    expect(ok.stdout).toBe(`version=${own}\nprerelease=${own.includes('-')}\n`);
    const off = spawnSync(process.execPath, [join(REPO, 'scripts', 'release.mjs'), 'tag', 'v99.0.0'], { encoding: 'utf8' });
    expect(off.status).toBe(1);
    expect(off.stdout).toBe('');
    expect(off.stderr).toMatch(/^release: the tag v99\.0\.0 is not the repository's version/);
  });

  it('notes: the CHANGELOG paragraph, how to install, what the build is (notarised or Open Anyway, updates on or off)', async () => {
    const { releaseNotes } = await releaseModule();
    const changelog = join(dir('changelog'), 'CHANGELOG.md');
    writeFileSync(changelog, '# Changelog\n\n## [0.2.1] — 2026-11-10\n\nFaster renders and a clearer Set-up sheet.\n\n### Fixed\n- **A thing.** Detail.\n');
    const env = { GITHUB_SERVER_URL: 'https://git.example.com', GITHUB_REPOSITORY: 'someone/retake' };
    const signed = releaseNotes('0.2.1', { signed: true, updates: 'on', changelog, env });
    expect(signed).toMatch(/^Faster renders and a clearer Set-up sheet\.\n\n## Install\n\n1\. .*`Retake_0\.2\.1_aarch64\.dmg`.*drag \*\*Retake\*\* onto \*\*Applications\*\*/);
    expect(signed).toMatch(/2\. The `retake` command: Help › Set Up Retake…/);
    expect(signed).toMatch(/notarised by Apple/);
    expect(signed).toMatch(/It updates itself/);
    expect(signed).toMatch(/\[CHANGELOG\.md\]\(https:\/\/git\.example\.com\/someone\/retake\/blob\/v0\.2\.1\/CHANGELOG\.md\)/);
    const adhoc = releaseNotes('0.2.1', { signed: false, updates: 'off', changelog, env: {} });
    expect(adhoc).toMatch(/\*\*Not notarised\*\*.*Open Anyway/);
    expect(adhoc).toMatch(/Updates are off in this build/);
    expect(adhoc).not.toMatch(/notarised by Apple|It updates itself/);
    expect(adhoc).toMatch(/What changed: CHANGELOG\.md\.\n$/);
    const draft = releaseNotes('0.2.2', { changelog, env: {} });
    expect(draft).toMatch(/^Retake 0\.2\.2\n/);
    expect(draft).toMatch(/attached when the release workflow's `attach` job ends/);
  });

  it('notes on the command line: --signed true|false and --updates on|off only', async () => {
    const run = (...args: string[]) => spawnSync(process.execPath, [join(REPO, 'scripts', 'release.mjs'), 'notes', ...args], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '' } });
    expect(run('0.2.0', '--signed', 'false', '--updates', 'off').stdout).toMatch(/Not notarised[\s\S]*Updates are off/);
    for (const bad of [['0.2.0', '--signed', 'yes'], ['0.2.0', '--updates', 'maybe'], ['0.2.0', '--other', 'x'], ['v0.2.0']]) expect(run(...bad).status, bad.join(' ')).toBe(1);
  });

  it('preflight (review e B-M1): each set all or nothing — none: off and said; all: on (the feed of the channel on this repository, the key checked); some: an error naming each missing name and its store', async () => {
    const { preflight, CONFIG_SETS } = await releaseModule();
    const { generateKeyPairSync } = await import('node:crypto');
    // A minisign public key as `tauri signer generate` writes it: base64 of its text file (algorithm Ed, key id, key).
    const raw32 = (generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }) as Buffer).subarray(12);
    const pub = Buffer.from(`untrusted comment: minisign public key\n${Buffer.concat([Buffer.from('Ed'), Buffer.alloc(8, 7), raw32]).toString('base64')}\n`).toString('base64');
    const secrets = (set: string, v = 'true') => Object.fromEntries(Object.entries(CONFIG_SETS[set].names as Record<string, string>).filter(([, k]) => k === 'secret').map(([n]) => [`HAS_SECRET_${n}`, v]));
    const repo = { GITHUB_REPOSITORY: 'example-owner/example-repo', GITHUB_SERVER_URL: 'https://github.example.test', REPO_PRIVATE: 'false', REPO_VISIBILITY: 'public' };
    const updater = { ...secrets('updater'), RETAKE_UPDATE_PUBKEY: pub, ...repo };
    // L5.16f: two sets — the update host's upload set is gone, the feed needs no setting of its own.
    expect(Object.keys(CONFIG_SETS)).toEqual(['apple', 'updater']);
    expect(CONFIG_SETS.updater.names).toEqual({ TAURI_SIGNING_PRIVATE_KEY: 'secret', TAURI_SIGNING_PRIVATE_KEY_PASSWORD: 'secret', RETAKE_UPDATE_PUBKEY: 'variable' });
    const none = preflight('0.2.0', {});
    expect(none).toEqual({ outputs: { signed: 'false', updates: 'off' }, warnings: [CONFIG_SETS.apple.off, CONFIG_SETS.updater.off], errors: [] });
    const all = preflight('0.3.0-rc.1', { ...secrets('apple'), ...updater });
    expect(all).toEqual({ outputs: { signed: 'true', updates: 'on', feed: 'https://github.example.test/example-owner/example-repo/releases/download/update-feed/rc.json', pubkey: pub }, warnings: [], errors: [] });
    expect(preflight('0.2.0', updater)).toMatchObject({ outputs: { feed: 'https://github.example.test/example-owner/example-repo/releases/download/update-feed/latest.json' }, warnings: [CONFIG_SETS.apple.off] });
    const cases: Array<[Record<string, string>, RegExp]> = [
      [{ ...secrets('apple'), HAS_SECRET_APPLE_API_KEY_P8: 'false' }, /^A Developer ID build, notarised needs all of APPLE_CERTIFICATE, .* — or none: missing APPLE_API_KEY_P8 \(a secret, not set\)$/],
      [{ HAS_SECRET_TAURI_SIGNING_PRIVATE_KEY: 'true' }, /^An app that updates itself needs .* missing TAURI_SIGNING_PRIVATE_KEY_PASSWORD \(a secret, not set\), RETAKE_UPDATE_PUBKEY \(a variable, not set\)$/],
      [{ ...secrets('updater'), ...repo, HAS_SECRET_RETAKE_UPDATE_PUBKEY: 'true' }, /missing RETAKE_UPDATE_PUBKEY \(set as a secret: it must be a variable\)$/],
      [{ HAS_VAR_TAURI_SIGNING_PRIVATE_KEY_PASSWORD: 'true' }, /^An app that updates itself needs .* missing TAURI_SIGNING_PRIVATE_KEY \(a secret, not set\), TAURI_SIGNING_PRIVATE_KEY_PASSWORD \(set as a variable: it must be a secret\), RETAKE_UPDATE_PUBKEY \(a variable, not set\)$/],
      [{ ...updater, RETAKE_UPDATE_PUBKEY: 'not a key' }, /^RETAKE_UPDATE_PUBKEY is not a public key .*one line of base64 expected/],
      [{ ...updater, RETAKE_UPDATE_PUBKEY: Buffer.from('untrusted comment: x\nRWQnotakey\n').toString('base64') }, /^RETAKE_UPDATE_PUBKEY is not a public key/],
      [{ ...updater, GITHUB_REPOSITORY: '' }, /^The update feed: GITHUB_REPOSITORY is not set/],
      [{ ...updater, GITHUB_REPOSITORY: 'example-owner/example-repo/x' }, /^The update feed: GITHUB_REPOSITORY "example-owner\/example-repo\/x" is not <owner>\/<repo>/],
      [{ ...updater, GITHUB_SERVER_URL: 'http://github.example.test' }, /^The update feed: GITHUB_SERVER_URL must be https/],
      // Review f A-L3: the repository must be public (the API's description, read with the job token) — unknown is refused.
      [{ ...updater, REPO_PRIVATE: 'true', REPO_VISIBILITY: 'private' }, /^The update feed: the repository is not public \(private: true, visibility: private\)/],
      [{ ...updater, REPO_VISIBILITY: 'internal' }, /^The update feed: the repository is not public \(private: false, visibility: internal\)/],
      [{ ...updater, REPO_PRIVATE: '', REPO_VISIBILITY: '' }, /^The update feed: the repository is not public \(its visibility unknown\)/],
    ];
    expect(preflight('0.2.0', { ...updater, REPO_VISIBILITY: '' }).errors).toEqual([]);
    for (const [env, msg] of cases) {
      const r = preflight('0.2.0', env);
      expect(r.errors.length, JSON.stringify(env)).toBe(1);
      expect(r.errors[0], JSON.stringify(env)).toMatch(msg);
    }
    // The command line: outputs appended to --output only when there is no error; annotations on stdout.
    const out = join(dir('preflight'), 'out');
    const cli = (env: Record<string, string>) => spawnSync(process.execPath, [join(REPO, 'scripts', 'release.mjs'), 'preflight', '0.2.0', '--output', out], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', ...env } });
    const ok = cli({});
    expect(ok.status).toBe(0);
    expect(readFileSync(out, 'utf8')).toBe('signed=false\nupdates=off\n');
    const bad = cli({ HAS_SECRET_APPLE_CERTIFICATE: 'true' });
    expect(bad.status).toBe(1);
    expect(bad.stdout).toMatch(/^::warning::Updates are off[^\n]*\n::error::A Developer ID build/m);
    expect(readFileSync(out, 'utf8')).toBe('signed=false\nupdates=off\n');
  });

  it('feed: the very feed publish-update.mjs accepts for that version — the channel\'s file on the repository\'s update-feed release (GITHUB_SERVER_URL, else GitHub\'s), refused without GITHUB_REPOSITORY', async () => {
    const { feedFor } = await releaseModule();
    const { publish } = await publishModule();
    const repo = { GITHUB_REPOSITORY: 'example-owner/example-repo' };
    expect(feedFor('0.2.1', { ...repo, GITHUB_SERVER_URL: 'https://github.example.test/' })).toBe('https://github.example.test/example-owner/example-repo/releases/download/update-feed/latest.json');
    expect(feedFor('0.3.0-rc.1', { ...repo, GITHUB_SERVER_URL: 'https://github.example.test//' })).toBe('https://github.example.test/example-owner/example-repo/releases/download/update-feed/rc.json');
    expect(feedFor('0.2.1', repo)).toBe('https://github.com/example-owner/example-repo/releases/download/update-feed/latest.json');
    expect(() => feedFor('0.2.1', { GITHUB_REPOSITORY: ' ' })).toThrow(/GITHUB_REPOSITORY is not set/);
    expect(() => feedFor('0.2.1', { GITHUB_REPOSITORY: 'example-owner' })).toThrow(/is not <owner>\/<repo>/);
    expect(() => feedFor('0.2.1', { ...repo, GITHUB_SERVER_URL: 'http://github.example.test' })).toThrow(/must be https/);
    expect(() => feedFor('v0.2.1', repo)).toThrow(/not a version/);
    // The command: what the workflow's publish step runs.
    const cli = spawnSync(process.execPath, [join(REPO, 'scripts', 'release.mjs'), 'feed', '0.2.1'], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', ...repo, GITHUB_SERVER_URL: 'https://github.example.test' } });
    expect(cli.stdout).toBe('https://github.example.test/example-owner/example-repo/releases/download/update-feed/latest.json\n');
    // publish() gets past its feed check with feedFor's value (and stops at the archive, which is no gzip here);
    // with the other channel's feed it stops at the feed check.
    const artifact = join(dir('publish'), 'Retake.app.tar.gz');
    writeFileSync(artifact, 'not a gzip');
    const fetchImpl = async () => {
      throw new Error('no network in this test');
    };
    for (const version of ['0.2.1', '0.3.0-rc.1']) {
      const env = { GITHUB_TOKEN: 't', ...repo, GITHUB_SERVER_URL: 'https://github.example.test/', RETAKE_UPDATE_PUBKEY: 'k' };
      const args = { version, platforms: ['darwin-aarch64'], artifact, signature: artifact, notes: null };
      await expect(publish({ args, env: { ...env, RETAKE_UPDATE_FEED: feedFor(version, env) }, fetchImpl })).rejects.toThrow(/is not a gzip archive/);
      const other = feedFor(version.includes('-') ? '0.2.1' : '0.3.0-rc.1', env);
      await expect(publish({ args, env: { ...env, RETAKE_UPDATE_FEED: other }, fetchImpl })).rejects.toThrow(/RETAKE_UPDATE_FEED is .* but .* belongs to/);
    }
  });
});

/**
 * A recording `security` on a scratch PATH. Each process's command line is one line of argv.log; each command it runs
 * one line of calls.log — `-i` (interactive) runs each line of its standard input as a command, printing a prompt as
 * security does. The search list kept in a file; create-keychain makes the file; import checks the .p12 opens with
 * -P's password; find-identity answers `identity`; set-key-partition-list prints a key dump. `fail`: that command says
 * an error ("security: …") and — outside -i — exits 1.
 */
function fakeSecurity(identity: string, { fail = '' } = {}) {
  const root = dir('fake-security');
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const state = join(root, 'list.txt');
  writeFileSync(state, '/Users/runner/Library/Keychains/login.keychain-db\n/Library/Keychains/System.keychain\n');
  const log = join(root, 'calls.log');
  const argvLog = join(root, 'argv.log');
  writeFileSync(join(bin, 'security'), `#!${process.execPath}
const fs = require('node:fs');
const argv = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(argvLog)}, JSON.stringify(argv) + '\\n');
const record = (x) => fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(x) + '\\n');
function run(a) {
  record(a);
  const last = a[a.length - 1];
  if (a[0] === ${JSON.stringify(fail)}) { console.error('security: ' + a.join(' ') + ': The specified item could not be found in the keychain.'); return 1; }
  if (a[0] === 'list-keychains') {
    const i = a.indexOf('-s');
    if (i < 0) { for (const k of fs.readFileSync(${JSON.stringify(state)}, 'utf8').split('\\n').filter(Boolean)) console.log('    "' + k + '"'); }
    else fs.writeFileSync(${JSON.stringify(state)}, a.slice(i + 1).map((k) => k + '\\n').join(''));
  } else if (a[0] === 'create-keychain') { fs.writeFileSync(last, 'keychain'); console.log('(what security may say)'); }
  else if (a[0] === 'delete-keychain') fs.rmSync(last);
  else if (a[0] === 'import') {
    const pass = a[a.indexOf('-P') + 1];
    const r = require('node:child_process').spawnSync('/usr/bin/openssl', ['pkcs12', '-in', a[1], '-passin', 'env:P', '-nokeys', '-noout'], { env: { P: pass } });
    record(['(the wrapped .p12 opens with -P)', r.status === 0]);
    if (r.status !== 0) { console.error('security: SecKeychainItemImport: MAC verification failed during PKCS12 import (wrong password?)'); return 1; }
    console.log('1 identity imported.');
  } else if (a[0] === 'set-key-partition-list') console.log('keychain: "' + last + '"\\nversion: 512\\nclass: 0x00000010\\nattributes:\\n    0x00000007 <blob>="Developer ID Application"');
  else if (a[0] === 'find-identity') console.log('  1) 0123456789ABCDEF0123456789ABCDEF01234567 "' + ${JSON.stringify(identity)} + '"\\n     1 valid identities found');
  return 0;
}
if (argv[0] === '-i') {
  // security's interactive mode: a prompt, a command per line; an error is said, the exit status stays 0.
  for (const line of fs.readFileSync(0, 'utf8').split('\\n').filter((l) => l.trim())) { process.stdout.write('security> '); run(['(stdin)', ...line.trim().split(/\\s+/)].slice(1)); }
  process.stdout.write('security> ');
} else process.exit(run(argv));
`);
  chmodSync(join(bin, 'security'), 0o755);
  const lines = (f: string) => (existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as unknown[]) : []);
  const list = () => readFileSync(state, 'utf8').split('\n').filter(Boolean);
  return { bin, calls: () => lines(log), argvs: () => lines(argvLog) as string[][], list };
}

/** A self-signed certificate and key as a .p12 (real openssl, no keychain), base64, with `password`. */
function testCertificate(password: string): string {
  const d = dir('cert');
  const ssl = (...args: string[]) => {
    const r = spawnSync('/usr/bin/openssl', args, { cwd: d, encoding: 'utf8', env: { PATH: '/usr/bin:/bin', P: password } });
    if (r.status !== 0) throw new Error(`openssl ${args[0]}: ${r.stderr}`);
  };
  ssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'k.pem', '-out', 'c.pem', '-subj', '/CN=Retake Test Signing', '-days', '1');
  ssl('pkcs12', '-export', '-inkey', 'k.pem', '-in', 'c.pem', '-passout', 'env:P', '-out', 'c.p12');
  return readFileSync(join(d, 'c.p12')).toString('base64');
}

const OPENSSL = MAC && existsSync('/usr/bin/openssl');

describe('ci-keychain.sh: a temporary keychain, the search list put back (a recording security; never the real one)', () => {
  const PASSWORD = 'cert-password-canary-7f3';
  const IDENTITY = 'Developer ID Application: Example Maker (ABCDE12345)';
  const runScript = (sec: ReturnType<typeof fakeSecurity>, args: string[], env: Record<string, string> = {}) =>
    spawnSync('/bin/bash', [KEYCHAIN_SCRIPT, ...args], { encoding: 'utf8', env: { PATH: `${sec.bin}:/usr/bin:/bin`, HOME: tmp, ...env } });

  it('the script calls `security` through PATH only (so the tests\' stand-in is the one it runs) and never sets a default keychain', () => {
    const text = readFileSync(KEYCHAIN_SCRIPT, 'utf8');
    expect(text).not.toMatch(/\/usr\/bin\/security|default-keychain|login\.keychain/);
    expect(statSync(KEYCHAIN_SCRIPT).mode & 0o111).not.toBe(0);
    // The certificate's password reaches openssl through its environment only (never expanded into a command line).
    expect(text).toContain('-passin env:APPLE_CERTIFICATE_PASSWORD');
    expect(text).not.toMatch(/\$\{?APPLE_CERTIFICATE_PASSWORD\}?(?!:-)/);
  });

  it('refuses outside GitHub Actions, without a certificate, or with a relative folder — before any security call', () => {
    const sec = fakeSecurity(IDENTITY);
    const d = join(dir('kc'), 'signing');
    const cases: Array<[string[], Record<string, string>, RegExp]> = [
      [['import', d], { APPLE_CERTIFICATE: 'x', APPLE_CERTIFICATE_PASSWORD: 'y' }, /GitHub Actions runner only/],
      [['delete', d], {}, /GitHub Actions runner only/],
      [['import', d], { GITHUB_ACTIONS: 'true', APPLE_CERTIFICATE_PASSWORD: 'y' }, /APPLE_CERTIFICATE is empty/],
      [['import', d], { GITHUB_ACTIONS: 'true', APPLE_CERTIFICATE: 'x' }, /APPLE_CERTIFICATE_PASSWORD is empty/],
      [['import', 'signing'], { GITHUB_ACTIONS: 'true', APPLE_CERTIFICATE: 'x', APPLE_CERTIFICATE_PASSWORD: 'y' }, /absolute path/],
      [['export', d], { GITHUB_ACTIONS: 'true' }, /usage/],
    ];
    for (const [args, env, msg] of cases) {
      const r = runScript(sec, args, env);
      expect(r.status, args.join(' ')).toBe(1);
      expect(r.stderr, args.join(' ')).toMatch(msg);
    }
    expect(sec.calls()).toEqual([]);
  });

  it.runIf(OPENSSL)('import: the list saved first, a keychain of its own (random password, locked after 6 h), the identity re-wrapped and imported non-extractable for codesign, the keychain first on the list; no password on any command line (review e A-L1)', () => {
    const sec = fakeSecurity(IDENTITY);
    const d = join(dir('kc'), 'signing');
    const kc = join(d, 'retake-signing.keychain-db');
    const r = runScript(sec, ['import', d], { GITHUB_ACTIONS: 'true', APPLE_CERTIFICATE: testCertificate(PASSWORD), APPLE_CERTIFICATE_PASSWORD: PASSWORD, APPLE_SIGNING_IDENTITY: IDENTITY });
    // stdout is the step's $GITHUB_OUTPUT: the keychain line only (what security says goes to stderr, its prompts and
    // the partition list's key dump left out).
    expect(r.stderr).toBe('(what security may say)\n1 identity imported.\n');
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(`keychain=${kc}\n`);
    const calls = sec.calls();
    expect(calls.map((c) => c[0])).toEqual(['list-keychains', 'create-keychain', 'set-keychain-settings', 'unlock-keychain', 'import', '(the wrapped .p12 opens with -P)', 'set-key-partition-list', 'list-keychains', 'find-identity']);
    expect(calls[0]).toEqual(['list-keychains', '-d', 'user']);
    const kcPass = calls[1]![2] as string;
    expect(calls[1]).toEqual(['create-keychain', '-p', kcPass, kc]);
    expect(kcPass).toMatch(/^[0-9a-f]{48}$/);
    expect(calls[2]).toEqual(['set-keychain-settings', '-lut', '21600', kc]);
    expect(calls[3]).toEqual(['unlock-keychain', '-p', kcPass, kc]);
    const wrapPass = calls[4]![8] as string;
    expect(calls[4]).toEqual(['import', join(d, 'wrapped.p12'), '-k', kc, '-f', 'pkcs12', '-x', '-P', wrapPass, '-T', '/usr/bin/codesign']);
    expect(wrapPass).toMatch(/^[0-9a-f]{48}$/);
    expect(wrapPass).not.toBe(kcPass);
    expect(calls[5]).toEqual(['(the wrapped .p12 opens with -P)', true]);
    expect(calls[6]).toEqual(['set-key-partition-list', '-S', 'apple-tool:,apple:,codesign:', '-s', '-k', kcPass, kc]);
    expect(calls[7]).toEqual(['list-keychains', '-d', 'user', '-s', kc, '/Users/runner/Library/Keychains/login.keychain-db', '/Library/Keychains/System.keychain']);
    expect(calls[8]).toEqual(['find-identity', '-v', '-p', 'codesigning', kc]);
    expect(JSON.stringify(calls)).not.toContain(PASSWORD);
    // The four commands that hold a password reached security on its standard input: no command line names one.
    const argvs = sec.argvs();
    expect(argvs.map((a) => a[0])).toEqual(['list-keychains', '-i', 'set-keychain-settings', '-i', '-i', '-i', 'list-keychains', 'find-identity']);
    for (const a of argvs) for (const secret of [kcPass, wrapPass, PASSWORD]) expect(a.join(' '), a[0]).not.toContain(secret);
    // Every call but the search list's targets the temporary keychain; no file of the certificate is left.
    for (const c of calls.filter((x) => !['list-keychains', 'import'].includes(String(x[0])) && !String(x[0]).startsWith('('))) expect(c[c.length - 1], String(c[0])).toBe(kc);
    expect(readdirSync(d).sort()).toEqual(['retake-signing.keychain-db', 'search-list.txt']);
    expect(statSync(d).mode & 0o777).toBe(0o700);
    expect(sec.list()[0]).toBe(kc);

    // delete: the list as it was, the keychain gone; a second delete does nothing.
    const del = runScript(sec, ['delete', d], { GITHUB_ACTIONS: 'true' });
    expect(del.status).toBe(0);
    expect(sec.calls().slice(9)).toEqual([['list-keychains', '-d', 'user', '-s', '/Users/runner/Library/Keychains/login.keychain-db', '/Library/Keychains/System.keychain'], ['delete-keychain', kc]]);
    expect(sec.list()).toEqual(['/Users/runner/Library/Keychains/login.keychain-db', '/Library/Keychains/System.keychain']);
    expect(readdirSync(d)).toEqual([]);
    expect(runScript(sec, ['delete', d], { GITHUB_ACTIONS: 'true' }).status).toBe(0);
    expect(sec.calls().length).toBe(11);
  });

  it.runIf(OPENSSL)('an error security says in its interactive mode (exit status 0) fails the import, its words printed with the passwords taken out; a folder with a space is refused first', () => {
    const sec = fakeSecurity(IDENTITY, { fail: 'unlock-keychain' });
    const d = join(dir('kc'), 'signing');
    const r = runScript(sec, ['import', d], { GITHUB_ACTIONS: 'true', APPLE_CERTIFICATE: testCertificate(PASSWORD), APPLE_CERTIFICATE_PASSWORD: PASSWORD });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/^security: unlock-keychain -p <redacted> .*retake-signing\.keychain-db: The specified item could not be found in the keychain\.\nci-keychain: security unlock-keychain failed\n$/m);
    const kcPass = sec.calls()[1]![2] as string;
    expect(r.stderr).not.toContain(kcPass);
    expect(sec.calls().map((c) => c[0])).not.toContain('import');
    const spaced = fakeSecurity(IDENTITY);
    const bad = runScript(spaced, ['import', join(dir('kc'), 'with space')], { GITHUB_ACTIONS: 'true', APPLE_CERTIFICATE: 'x', APPLE_CERTIFICATE_PASSWORD: 'y' });
    expect(bad.status).toBe(1);
    expect(bad.stderr).toMatch(/no space, quote or backslash/);
    expect(spaced.calls()).toEqual([]);
  });

  it('delete removes every file of the folder even when security fails, then says so (review e A-L2)', () => {
    const sec = fakeSecurity(IDENTITY, { fail: 'delete-keychain' });
    const d = join(dir('kc'), 'signing');
    mkdirSync(d);
    for (const f of ['retake-signing.keychain-db', 'AuthKey.p8', 'updater.key']) writeFileSync(join(d, f), 'x');
    writeFileSync(join(d, 'search-list.txt'), '/Users/runner/Library/Keychains/login.keychain-db\n');
    const r = runScript(sec, ['delete', d], { GITHUB_ACTIONS: 'true' });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/security failed while the keychain was removed \(its files are gone/);
    expect(readdirSync(d)).toEqual([]);
    expect(sec.list()).toEqual(['/Users/runner/Library/Keychains/login.keychain-db']);
  });

  it.runIf(OPENSSL)('import fails on a wrong password or an identity the certificate does not hold; delete then still puts the list back', () => {
    const sec = fakeSecurity(IDENTITY);
    const d = join(dir('kc'), 'signing');
    const cert = testCertificate(PASSWORD);
    const wrong = runScript(sec, ['import', d], { GITHUB_ACTIONS: 'true', APPLE_CERTIFICATE: cert, APPLE_CERTIFICATE_PASSWORD: 'not-it' });
    expect(wrong.status).toBe(1);
    expect(wrong.stderr).toMatch(/could not be read with APPLE_CERTIFICATE_PASSWORD/);
    expect(sec.calls()).toEqual([]);
    expect(existsSync(join(d, 'certificate.p12'))).toBe(false);
    const other = runScript(sec, ['import', d], { GITHUB_ACTIONS: 'true', APPLE_CERTIFICATE: cert, APPLE_CERTIFICATE_PASSWORD: PASSWORD, APPLE_SIGNING_IDENTITY: 'Developer ID Application: Someone Else (ZZZZZ99999)' });
    expect(other.status).toBe(1);
    expect(other.stderr).toMatch(/no valid code-signing identity named as APPLE_SIGNING_IDENTITY/);
    expect(other.stderr).not.toMatch(/Someone Else/);
    expect(sec.list()[0]).toBe(join(d, 'retake-signing.keychain-db'));
    expect(runScript(sec, ['delete', d], { GITHUB_ACTIONS: 'true' }).status).toBe(0);
    expect(sec.list()).toEqual(['/Users/runner/Library/Keychains/login.keychain-db', '/Library/Keychains/System.keychain']);
    expect(existsSync(join(d, 'retake-signing.keychain-db'))).toBe(false);
    // A delete after nothing was imported touches nothing.
    const fresh = fakeSecurity(IDENTITY);
    expect(runScript(fresh, ['delete', join(dir('kc'), 'none')], { GITHUB_ACTIONS: 'true' }).status).toBe(0);
    expect(fresh.calls()).toEqual([]);
  });
});

describe('the release signer in CI: the temporary keychain, the workflow\'s names (sign.mjs)', () => {
  const ID = 'Developer ID Application: Example Maker (ABCDE12345)';
  const KEY = { APPLE_SIGNING_IDENTITY: ID, APPLE_TEAM_ID: 'ABCDE12345', APPLE_API_KEY: 'key-id', APPLE_API_ISSUER: 'issuer', APPLE_API_KEY_PATH: '/runner/temp/signing/AuthKey.p8' };

  it('the sign step\'s APPLE_* names are exactly what releaseConfig reads on the API-key route, the keychain included', async () => {
    const { releaseConfig } = await signModule();
    const build = step('sign', 'Sign, notarise, the update archive and the DMG');
    const names = Object.keys(build.env!).filter((k) => k.startsWith('APPLE_')).sort();
    expect(names).toEqual(['APPLE_API_ISSUER', 'APPLE_API_KEY', 'APPLE_API_KEY_PATH', 'APPLE_KEYCHAIN', 'APPLE_SIGNING_IDENTITY', 'APPLE_TEAM_ID']);
    const s = releaseConfig({ ...KEY, APPLE_KEYCHAIN: '/runner/temp/signing/retake-signing.keychain-db' });
    expect(s).toEqual({ identity: ID, team: 'ABCDE12345', notary: { key: 'key-id', issuer: 'issuer', keyPath: '/runner/temp/signing/AuthKey.p8' }, keychain: '/runner/temp/signing/retake-signing.keychain-db' });
    // Without it (a person's own run): no keychain named; an empty one counts as absent; a relative or odd one is refused.
    expect(releaseConfig(KEY)).not.toHaveProperty('keychain');
    expect(releaseConfig({ ...KEY, APPLE_KEYCHAIN: ' ' })).not.toHaveProperty('keychain');
    for (const bad of ['signing.keychain-db', '/runner/temp/signing/AuthKey.p8']) expect(() => releaseConfig({ ...KEY, APPLE_KEYCHAIN: bad }), bad).toThrow(/APPLE_KEYCHAIN must be the absolute path of a keychain file .* nothing was signed/);
    // The keychain script prints the path the build step reads (keychain=…), into the step's outputs.
    expect(build.env!.APPLE_KEYCHAIN).toBe('${{ steps.material.outputs.keychain }}');
    expect(readFileSync(KEYCHAIN_SCRIPT, 'utf8')).toMatch(/keychain="\$dir\/retake-signing\.keychain-db"[\s\S]*echo "keychain=\$keychain"\n$/);
  });

  it('codesign takes the identity from that keychain (--keychain) in a release only; a failure names no keychain', async () => {
    const { codesignArgs, signer, signDmg, redactArgs } = await signModule();
    const kc = '/runner/temp/signing/retake-signing.keychain-db';
    const rel = signer('release', { ...KEY, APPLE_KEYCHAIN: kc }, {});
    expect(codesignArgs(rel, '/o/x', '/e.plist')).toEqual(['--force', '--options', 'runtime', '--timestamp', '--keychain', kc, '-s', ID, '--entitlements', '/e.plist', '/o/x']);
    expect(codesignArgs(signer('release', KEY, {}), '/o/x')).toEqual(['--force', '--options', 'runtime', '--timestamp', '-s', ID, '/o/x']);
    expect(codesignArgs({ ...signer('dry'), keychain: kc }, '/o/x')).toEqual(['--force', '--options', 'runtime', '--timestamp=none', '-s', '-', '/o/x']);
    expect(redactArgs(codesignArgs(rel, '/o/x'))).toContain('<redacted>');
    expect(redactArgs(codesignArgs(rel, '/o/x')).join(' ')).not.toContain(kc);
    if (!MAC) return;
    // signDmg, through a recording codesign (no real signing).
    const bin = dir('fake-codesign');
    const log = join(bin, 'calls');
    writeFileSync(join(bin, 'codesign'), `#!/bin/sh\necho "$*" >> ${JSON.stringify(log)}\n[ -z "$FAIL" ] || { echo "no identity found" >&2; exit 1; }\n`);
    chmodSync(join(bin, 'codesign'), 0o755);
    signDmg(signer('release', { ...KEY, APPLE_KEYCHAIN: kc }, { PATH: `${bin}:/usr/bin:/bin` }), '/o/Retake.dmg');
    expect(readFileSync(log, 'utf8')).toBe(`--force --timestamp --keychain ${kc} -s ${ID} /o/Retake.dmg\n`);
    let message = '';
    try {
      signDmg(signer('release', { ...KEY, APPLE_KEYCHAIN: kc }, { PATH: `${bin}:/usr/bin:/bin`, FAIL: '1' }), '/o/Retake.dmg');
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/codesign --force --timestamp --keychain <redacted> -s .* failed \(1\): no identity found/);
  });
});
