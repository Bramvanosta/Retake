/**
 * L5.16a — the relocatable engine's rules outside core: every ffmpeg / ffprobe spawn goes through the resolver (a source
 * lint), the bundle setup runs first in both entry points, one version number, the stage's layout check (on a small
 * fake stage), `retake init`, the plugin marketplace and the preview writes of an app bundle.
 */
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir, userInfo } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { RETAKE_VERSION, PERSON_POLICY, workPolicyFrom } from '@retake/core';
import type { WorkPolicy } from '@retake/core';
import { BUNDLE_GUARD, BundleError, bundleNodeArgs, overrideBundleInfo, readBundleManifest } from '@retake/core/io';
import type { BundleInfo } from '@retake/core/io';
import { HEADLESS_SHELL_ENV, assertRenderBrowser, ensureBundle, planEdit, renderBrowser, renderBundleRestriction, renderComponentPreviews, renderStills } from '@retake/editor';
import { loadComponentRegistry } from '@retake/components';
import { fixtureProject, realTimeline, template } from '../../editor/test/helpers.js';
import type { RenderPreviewsOptions } from '@retake/editor';
import { mcpServerEntry, pluginInstallCommands, pluginMarketplaceRoot } from '@retake/engine/integrations';
import { main, memoryIo } from '../src/index.js';
import { componentsPreviewCommand } from '../src/commands/components.js';
import { initWorkspace } from '../src/commands/init.js';
import { Ui } from '../src/ui.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

// The bundler stood in for one case (ensureBundle's restriction): the library's own otherwise.
const bundler = vi.hoisted(() => ({ bundle: undefined as undefined | ((o: never) => Promise<string>) }));
// The asset servers the editor starts, counted (the render-browser refusal comes before any).
const servers = vi.hoisted(() => ({ started: 0 }));
vi.mock('../../editor/src/render/asset-server.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../editor/src/render/asset-server.js')>();
  return { ...real, startAssetServer: (...a: Parameters<typeof real.startAssetServer>) => ((servers.started += 1), real.startAssetServer(...a)) };
});
vi.mock('../../editor/src/render/library.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../editor/src/render/library.js')>();
  return { ...real, bundlerLibrary: async () => (bundler.bundle ? { bundle: bundler.bundle } : real.bundlerLibrary()) };
});
const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'retake-app-bundle-cli-')));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
afterEach(() => overrideBundleInfo(undefined));

function sources(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) sources(p, out);
    else if (/\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

describe('every ffmpeg / ffprobe spawn goes through the resolver (core mediaTools)', () => {
  // A command literal where a program is started or defaulted: spawn('ffmpeg', …), x ?? 'ffmpeg', ffmpeg = 'ffmpeg'.
  const SPAWN = /\b(?:spawn|spawnSync|execFile|execFileSync|exec|run|runFfmpeg)\(\s*(['"`])ff(?:mpeg|probe)\1|(?:\?\?|\|\|)\s*(['"`])ff(?:mpeg|probe)\2|=\s*(['"`])ff(?:mpeg|probe)\3\s*[,)]/;

  it('no source names ffmpeg / ffprobe as a command outside core/src/io/bundle.ts', () => {
    const offenders: string[] = [];
    for (const pkg of readdirSync(join(REPO, 'packages'))) {
      let files: string[];
      try {
        files = sources(join(REPO, 'packages', pkg, 'src'));
      } catch {
        continue;
      }
      for (const f of files) {
        if (f.endsWith(join('core', 'src', 'io', 'bundle.ts'))) continue;
        readFileSync(f, 'utf8')
          .split('\n')
          .forEach((line, i) => {
            if (!/^\s*(\*|\/\/)/.test(line) && SPAWN.test(line)) offenders.push(`${relative(REPO, f)}:${i + 1}: ${line.trim().slice(0, 100)}`);
          });
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the lint itself catches the four forms', () => {
    for (const bad of ["run('ffmpeg', args)", "spawn(o.ffprobe ?? 'ffprobe', a)", "function f(ffmpeg = 'ffmpeg') {", "execFileSync('ffprobe', [])"]) expect(SPAWN.test(bad), bad).toBe(true);
    for (const ok of ["name: 'ffmpeg' | 'ffprobe'", "whichOnPath('ffmpeg', env)", 'spawn(ffmpegBin(PERSON_POLICY, o.ffmpeg), a)']) expect(SPAWN.test(ok), ok).toBe(false);
  });
});

describe('the bundle setup runs first in both entry points (M2: before anything loads playwright-core)', () => {
  it('bin.ts loads bundle-env.js before main.js; worker-main.ts imports it first', () => {
    const bin = readFileSync(join(REPO, 'packages', 'cli', 'src', 'bin.ts'), 'utf8');
    const code = bin.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
    expect(code.indexOf("'bundle-env.js'")).toBeGreaterThan(0);
    expect(code.indexOf("'bundle-env.js'")).toBeLessThan(code.indexOf("'main.js'"));
    const worker = readFileSync(join(REPO, 'packages', 'engine', 'src', 'worker-main.ts'), 'utf8');
    expect(worker.split('\n').find((l) => l.startsWith('import '))).toBe("import './bundle-env.js';");
    for (const pkg of ['cli', 'engine']) expect(readFileSync(join(REPO, 'packages', pkg, 'src', 'bundle-env.ts'), 'utf8')).toMatch(/^prepareBundle\(\);$/m);
  });
});

describe('the render browser is checked before the asset server starts (review B L2: nothing left open on a refusal)', () => {
  it('render.ts: renderBrowser / assertRenderBrowser come before startAssetServer() in openSession', () => {
    const code = readFileSync(join(REPO, 'packages', 'editor', 'src', 'render', 'render.ts'), 'utf8');
    const session = code.slice(code.indexOf('async function openSession('));
    // L7.34 (finding C4, review fix): the order of the two calls, the check handed the work's own policy; the
    // refusal itself is the behaviour case below.
    const check = /\bassertRenderBrowser\(browser, opts\.workPolicy\)/;
    expect(session.search(check)).toBeGreaterThan(0);
    expect(session.search(check)).toBeLessThan(session.search(/\bstartAssetServer\(/));
  });

  it("an agent's render with a render browser inside the workspace is refused before the asset server starts", async () => {
    // The bundler stood in (as for ensureBundle's case), $RETAKE_CHROMIUM_HEADLESS_SHELL pointed at a file of the
    // workspace, the work under an agent policy of that workspace: the still is refused with the policy's words and no
    // asset server is started; a person's policy takes the same browser past the check (to the server).
    bundler.bundle = async (o: { outDir: string }) => {
      mkdirSync(o.outDir, { recursive: true });
      writeFileSync(join(o.outDir, 'index.html'), '<!doctype html><html><head></head><body></body></html>');
      return o.outDir;
    };
    const ws = realpathSync(mkdtempSync(join(tmp, 'render-agent-')));
    const shell = join(ws, 'bin', 'headless-shell');
    mkdirSync(dirname(shell), { recursive: true });
    writeFileSync(shell, '#!/bin/sh\nexit 1\n');
    chmodSync(shell, 0o755);
    const was = process.env[HEADLESS_SHELL_ENV];
    process.env[HEADLESS_SHELL_ENV] = shell;
    servers.started = 0;
    try {
      const plan = planEdit({ timeline: realTimeline('quote'), template: await template('editorial'), project: await fixtureProject(), registry: await loadComponentRegistry({ root: ws }), captureFile: '/captures/capture.mp4' });
      const still = (workPolicy: WorkPolicy) => renderStills({ workPolicy, plan, frames: [{ frame: 0, out: join(ws, 'f.png') }], root: ws, cacheDir: join(ws, 'cache') });
      await expect(still(workPolicyFrom([ws]))).rejects.toThrow(/lies inside the workspace/);
      expect(servers.started).toBe(0);
      await expect(still(PERSON_POLICY)).rejects.toThrow();
      expect(servers.started).toBe(1);
    } finally {
      if (was === undefined) delete process.env[HEADLESS_SHELL_ENV];
      else process.env[HEADLESS_SHELL_ENV] = was;
      bundler.bundle = undefined;
    }
  });
});

describe('one version number (L3)', () => {
  it('root package.json = RETAKE_VERSION = every package = tauri.conf.json = the plugin = Cargo.toml (+ its lock entry)', () => {
    const json = (p: string) => JSON.parse(readFileSync(join(REPO, p), 'utf8')) as { version: string };
    const v = json('package.json').version;
    expect(v).toMatch(/^\d+\.\d+\.\d+$/);
    expect(RETAKE_VERSION).toBe(v);
    for (const pkg of readdirSync(join(REPO, 'packages'))) expect(json(`packages/${pkg}/package.json`).version, pkg).toBe(v);
    expect(json('apps/desktop/tauri.conf.json').version).toBe(v);
    expect(json('skills/.claude-plugin/plugin.json').version).toBe(v);
    expect(/^version = "([^"]+)"/m.exec(readFileSync(join(REPO, 'apps/desktop/Cargo.toml'), 'utf8'))?.[1]).toBe(v);
    expect(/name = "retake-desktop"\nversion = "([^"]+)"/.exec(readFileSync(join(REPO, 'apps/desktop/Cargo.lock'), 'utf8'))?.[1]).toBe(v);
    // Not checked: apps/desktop/core (the `desktop-core` crate, internal to the shell, never shipped or named alone) keeps
    // its own version; fixtures/wholesale is a fixture; component manifests carry component versions.
  });
});

interface StageModule {
  checkStage(dir: string, opts?: { machinePaths?: string[] }): { problems: string[]; machO: Array<{ path: string; kind: string }> };
  bareInstallNames(otool: string): string[];
  machOKind(file: string): string | null;
  deployEngine(repo: string, engine: string, filter?: string): { unlinked: number };
  breakHardLinks(dir: string): number;
  repoSnapshot(repo: string): string;
  trackedFiles(repo: string, rel: string, o?: { untracked?: boolean }): string[];
  buildEnv(env?: NodeJS.ProcessEnv, extra?: Record<string, string>): Record<string, string>;
  useBuildEnv(env: Record<string, string>): void;
  RENDERER_PATCH_MARKS: Record<string, Record<string, number>>;
  rendererPatchProblems(dir: string): string[];
  scrubDeployedEngine(engine: string): void;
  staleBuildOutputs(repo: string): string[];
}
const stageModule = async () => (await import(pathToFileURL(join(REPO, 'apps', 'desktop', 'scripts', 'bundle.mjs')).href)) as StageModule;

describe('the stage layout check (bundle.mjs checkStage, a small fake stage)', () => {
  let n = 0;
  const THIN = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x0c, 0, 0, 1]);
  const FAT = Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 2]);
  let marks: Record<string, Record<string, number>> = {};
  function fakeStage(): string {
    const root = join(tmp, `stage${n++}`);
    const file = (rel: string, data: string | Buffer = '', mode = 0o644) => {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), data);
      chmodSync(join(root, rel), mode);
    };
    file('node/bin/node', FAT, 0o755);
    file('engine/dist/bin.js', '#!/usr/bin/env node\n');
    file('engine/package.json', JSON.stringify({ name: '@retake/cli', version: '0.2.0', dependencies: { '@retake/core': '0.2.0' } }));
    file('engine/node_modules/playwright-core/package.json', '{"name":"playwright-core"}');
    for (const [rel, want] of Object.entries(marks)) file(`engine/node_modules/@remotion/renderer/${rel}`, Object.entries(want).map(([m, k]) => `// ${m}\n`.repeat(k)).join(''));
    file('engine/node_modules/@remotion/compositor-darwin-arm64/libavutil.dylib', THIN);
    file('engine/templates/default/template.yaml', 'name: default\n');
    file('plugin/.claude-plugin/marketplace.json', '{}');
    for (const rev of ['chromium-1194', 'chromium_headless_shell-1194']) for (const m of ['INSTALLATION_COMPLETE', 'DEPENDENCIES_VALIDATED']) file(`browsers/${rev}/${m}`);
    symlinkSync('Versions/Current/Resources', join(root, 'browsers', 'chromium-1194', 'Resources'));
    file('bundle.json', JSON.stringify({ v: 1, app: '0.2.0', playwright: { core: '1.56.1', chromium: '1194', headless_shell: '1194' }, ffmpeg: null, paths: { node: 'node/bin/node', engine: 'engine', browsers: 'browsers', ffmpeg: null, templates: 'engine/templates', plugin: 'plugin' } }));
    return root;
  }
  const machinePaths = ['/Users/someone/projects/retake'];

  it('a sound stage passes; its Mach-O files (thin and FAT) are listed', async () => {
    const { checkStage, RENDERER_PATCH_MARKS } = await stageModule();
    marks = RENDERER_PATCH_MARKS;
    const r = checkStage(fakeStage(), { machinePaths });
    expect(r.problems).toEqual([]);
    expect(r.machO).toEqual(expect.arrayContaining([{ path: 'node/bin/node', kind: 'fat' }, { path: 'engine/node_modules/@remotion/compositor-darwin-arm64/libavutil.dylib', kind: 'thin' }]));
    expect(readBundleManifest(fakeStage()).paths.ffmpeg).toBeNull();
  });

  it('each rule: links absolute or leaving, a machine path, a marker with content, two playwright-cores, a path out, the renderer unpatched', async () => {
    const { checkStage, RENDERER_PATCH_MARKS } = await stageModule();
    marks = RENDERER_PATCH_MARKS;
    const cases: Array<[string, (root: string) => void, RegExp]> = [
      ['absolute link', (r) => symlinkSync('/usr/lib', join(r, 'engine', 'abs')), /engine\/abs: link to an absolute path/],
      ['link out', (r) => symlinkSync('../../..', join(r, 'engine', 'up')), /engine\/up: link leaves the stage/],
      ['machine path', (r) => writeFileSync(join(r, 'engine', 'package.json'), JSON.stringify({ dependencies: { x: `file://${machinePaths[0]}/packages/core` } })), /engine\/package\.json names a path of the build machine/],
      ['marker', (r) => writeFileSync(join(r, 'browsers', 'chromium-1194', 'DEPENDENCIES_VALIDATED'), 'x'), /DEPENDENCIES_VALIDATED is not empty/],
      ['two playwright-cores', (r) => {
        mkdirSync(join(r, 'engine', 'node_modules', '@retake', 'ui', 'node_modules', 'playwright-core'), { recursive: true });
      }, /2 copies of playwright-core/],
      ['path out', (r) => {
        const m = JSON.parse(readFileSync(join(r, 'bundle.json'), 'utf8'));
        m.paths.plugin = '../plugin';
        writeFileSync(join(r, 'bundle.json'), JSON.stringify(m));
      }, /paths\.plugin \(\.\.\/plugin\) leaves the stage/],
      ['hard link', (r) => linkSync(join(r, 'engine', 'package.json'), join(tmp, `outside-${n}.json`)), /engine\/package\.json: 2 hard links/],
      ['machine path in a script', (r) => writeFileSync(join(r, 'engine', 'dist', 'bin.js'), `import x from '${machinePaths[0]}/packages/core/dist/index.js';\n`), /engine\/dist\/bin\.js names a path of the build machine/],
      ['machine path in a skill', (r) => {
        mkdirSync(join(r, 'plugin', 'skills', 'x'), { recursive: true });
        writeFileSync(join(r, 'plugin', 'skills', 'x', 'SKILL.md'), `see ${machinePaths[0]}/docs\n`);
      }, /plugin\/skills\/x\/SKILL\.md names a path of the build machine/],
      ['renderer unpatched', (r) => writeFileSync(join(r, 'engine', 'node_modules', '@remotion', 'renderer', 'dist', 'esm', 'index.mjs'), '// as published\n'), /@remotion\/renderer\/dist\/esm\/index\.mjs carries "retake-patch: render-sandbox" 0 times, not 1: the engine lacks/],
      ['renderer half patched', (r) => writeFileSync(join(r, 'engine', 'node_modules', '@remotion', 'renderer', 'dist', 'esm', 'index.mjs'), '// retake-patch: render-sandbox\n// retake-patch: loopback-server\n'), /dist\/esm\/index\.mjs carries "retake-patch: loopback-server" 1 times, not 2/],
      ['renderer file gone', (r) => rmSync(join(r, 'engine', 'node_modules', '@remotion', 'renderer', 'dist', 'serve-static.js')), /@remotion\/renderer\/dist\/serve-static\.js is missing/],
    ];
    for (const [what, spoil, problem] of cases) {
      const root = fakeStage();
      spoil(root);
      expect(checkStage(root, { machinePaths }).problems.join('\n'), what).toMatch(problem);
    }
  });

  it("the compositor's licence notice names the Remotion compositor the engine deploys (the stage refuses a stale one)", () => {
    const pkg = JSON.parse(readFileSync(join(realpathSync(join(REPO, 'packages', 'editor', 'node_modules', '@remotion', 'renderer')), '..', 'compositor-darwin-arm64', 'package.json'), 'utf8')) as { version: string };
    const notice = readFileSync(join(REPO, 'apps', 'desktop', 'licenses', 'remotion-compositor', 'README.md'), 'utf8');
    expect(notice).toContain(`@remotion/compositor-darwin-arm64 ${pkg.version}`);
    expect(notice).toMatch(/GNU General Public\s+License, version 2 or later/);
    expect(notice).toContain('../ffmpeg/COPYING.GPLv2');
  });

  it('install names: the bare ones (what @loader_path replaces) are found', async () => {
    const { bareInstallNames } = await stageModule();
    const otool = 'remotion:\n\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0)\n\tlibavcodec.dylib (compatibility version 61.0.0)\n\t@loader_path/libavutil.dylib (compatibility version 59.0.0)\n';
    expect(bareInstallNames(otool)).toEqual(['libavcodec.dylib']);
  });
});

/**
 * pnpm through corepack, the same under any HOME (L5.16c fixes, review c — B's note: under a scratch HOME corepack found
 * no cache and fetched a pnpm): never a download (COREPACK_ENABLE_NETWORK=0), corepack's cache found from the account's
 * home rather than $HOME (unless COREPACK_HOME / XDG_CACHE_HOME name it), nothing pinned into a package.json; the mini
 * workspace pins the repository's pnpm (packageManager). No pnpm in that cache: the test is skipped.
 */
const PNPM_ENV = {
  COREPACK_ENABLE_NETWORK: '0',
  COREPACK_ENABLE_AUTO_PIN: '0',
  COREPACK_HOME: process.env.COREPACK_HOME?.trim() || join(process.env.XDG_CACHE_HOME?.trim() || join(userInfo().homedir, '.cache'), 'node', 'corepack'),
};
const PACKAGE_MANAGER = (JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as { packageManager: string }).packageManager;
const hasPnpm = spawnSync('pnpm', ['--version'], { cwd: REPO, env: { ...process.env, ...PNPM_ENV }, stdio: 'ignore' }).status === 0;

describe('the stage never writes the checkout (H1: pnpm deploy hard-links injected workspace packages)', () => {
  /** A two-package workspace in git (a depends on b, workspace:*), offline: no external dependency. */
  function miniRepo(): string {
    const repo = join(tmp, `mini${Math.random().toString(36).slice(2, 8)}`);
    const file = (rel: string, text: string) => {
      mkdirSync(dirname(join(repo, rel)), { recursive: true });
      writeFileSync(join(repo, rel), text);
    };
    file('package.json', `{ "name": "mini", "private": true, "packageManager": "${PACKAGE_MANAGER}" }\n`);
    file('pnpm-workspace.yaml', 'packages:\n  - packages/*\n');
    file('packages/a/package.json', '{ "name": "@m/a", "version": "1.0.0", "dependencies": { "@m/b": "workspace:*" } }\n');
    file('packages/a/dist/index.js', 'export const a = 1;\n');
    file('packages/b/package.json', '{ "name": "@m/b", "version": "1.0.0", "files": ["dist"], "dependencies": { "@m/c": "workspace:*" } }\n');
    file('packages/b/dist/index.js', 'export const b = 2;\n');
    file('packages/c/package.json', '{ "name": "@m/c", "version": "1.0.0" }\n');
    file('.gitignore', 'node_modules/\n');
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { cwd: repo, stdio: 'pipe' });
    git('init', '-q');
    git('add', '-A');
    git('commit', '-qm', 'mini');
    return repo;
  }

  it.runIf(hasPnpm)('deployEngine: the injected packages get their own inodes before their specs are rewritten; the repository is byte-identical', async () => {
    const { deployEngine, checkStage, repoSnapshot, buildEnv, useBuildEnv } = await stageModule();
    const repo = miniRepo();
    const before = repoSnapshot(repo);
    const bPkg = readFileSync(join(repo, 'packages', 'b', 'package.json'));
    const engine = join(tmp, `deploy-${Date.now()}`);
    useBuildEnv(buildEnv({ ...process.env, ...PNPM_ENV }));
    let unlinked: number;
    try {
      ({ unlinked } = deployEngine(repo, engine, '@m/a'));
    } finally {
      useBuildEnv(buildEnv(process.env));
    }
    expect(unlinked).toBeGreaterThan(0);
    const deployed = join(engine, 'node_modules', '@m', 'b');
    expect(JSON.parse(readFileSync(join(deployed, 'package.json'), 'utf8')).dependencies).toEqual({ '@m/c': '1.0.0' });
    expect(readFileSync(join(repo, 'packages', 'b', 'package.json'))).toEqual(bPkg);
    for (const f of ['package.json', 'dist/index.js']) {
      expect(statSync(join(deployed, f)).nlink, f).toBe(1);
      expect(statSync(join(deployed, f)).ino).not.toBe(statSync(join(repo, 'packages', 'b', f)).ino);
    }
    expect(statSync(join(repo, 'packages', 'b', 'package.json')).nlink).toBe(1);
    expect(checkStage(engine, { machinePaths: [repo] }).problems.filter((p) => /hard links/.test(p))).toEqual([]);
    expect(repoSnapshot(repo)).toBe(before);
  });

  /** The store this checkout was installed from (pnpm records it in node_modules/.modules.yaml). */
  const storeDir = /^storeDir: (.+)$/m.exec((() => {
    try {
      return readFileSync(join(REPO, 'node_modules', '.modules.yaml'), 'utf8');
    } catch {
      return '';
    }
  })())?.[1];

  it.runIf(hasPnpm && !!storeDir)("the engine's pnpm deploy carries the @remotion/renderer patch (offline, from the checkout's store); the installed copy has it too", async () => {
    const { rendererPatchProblems, buildEnv, scrubDeployedEngine } = await stageModule();
    const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as { pnpm: { patchedDependencies: Record<string, string> } };
    const editor = JSON.parse(readFileSync(join(REPO, 'packages', 'editor', 'package.json'), 'utf8')) as { dependencies: Record<string, string> };
    // A Remotion upgrade without the patch ported to it fails here (and pnpm refuses an unused patch).
    expect(Object.keys(pkg.pnpm.patchedDependencies)).toEqual([`@remotion/renderer@${editor.dependencies['@remotion/renderer']}`]);
    expect(rendererPatchProblems(join(REPO, 'packages', 'editor', 'node_modules', '@remotion', 'renderer'))).toEqual([]);
    const engine = join(tmp, `engine-${Date.now()}`);
    const workspaceManifests = readdirSync(join(REPO, 'packages')).map((p) => join(REPO, 'packages', p, 'package.json')).filter((f) => existsSync(f)).map((f) => [f, readFileSync(f, 'utf8')] as const);
    const r = spawnSync('pnpm', ['--config.inject-workspace-packages=true', '--config.node-linker=hoisted', `--config.store-dir=${storeDir}`, '--filter', '@retake/cli', '--prod', '--offline', 'deploy', engine], { cwd: REPO, encoding: 'utf8', env: buildEnv({ ...process.env, ...PNPM_ENV }) });
    try {
      expect(r.status, r.stderr || r.stdout).toBe(0);
      expect(rendererPatchProblems(join(engine, 'node_modules', '@remotion', 'renderer'))).toEqual([]);
      // The deployed manifest names no file of the build machine once scrubbed (the patches are applied already).
      scrubDeployedEngine(engine);
      const manifest = readFileSync(join(engine, 'package.json'), 'utf8');
      expect(JSON.parse(manifest).pnpm).toBeUndefined();
      expect(manifest).not.toContain(REPO);
      // The deploy's injected workspace packages are hard links to the checkout's files: the scrub never writes through them.
      for (const [file, text] of workspaceManifests) expect(readFileSync(file, 'utf8'), file).toBe(text);
    } finally {
      rmSync(engine, { recursive: true, force: true });
    }
  }, 120_000);

  it('repoSnapshot tells a modified file written again (same status line, other bytes) and an untracked one', async () => {
    const { repoSnapshot } = await stageModule();
    const repo = miniRepo();
    writeFileSync(join(repo, 'packages', 'a', 'package.json'), '{ "name": "@m/a", "version": "1.0.1" }\n');
    const modified = repoSnapshot(repo);
    expect(modified).toMatch(/^ M packages\/a\/package\.json [0-9a-f]{64}$/m);
    writeFileSync(join(repo, 'packages', 'a', 'package.json'), '{ "name": "@m/a", "version": "1.0.2" }\n');
    expect(repoSnapshot(repo)).not.toBe(modified);
    writeFileSync(join(repo, 'packages', 'a', 'notes.txt'), 'x');
    expect(repoSnapshot(repo)).toMatch(/^\?\? packages\/a\/notes\.txt /m);
  });

  it("a build output whose source is gone is found, and the stage refuses it before it deploys anything", async () => {
    const { staleBuildOutputs } = await stageModule();
    const repo = join(tmp, `stale-${Date.now()}`);
    const put = (rel: string) => {
      mkdirSync(dirname(join(repo, rel)), { recursive: true });
      writeFileSync(join(repo, rel), '');
    };
    for (const f of ['a/src/index.ts', 'a/src/sub/view.tsx', 'a/src/kit.mts', 'a/src/plain.js']) put(`packages/${f}`);
    for (const f of ['a/dist/index.js', 'a/dist/index.d.ts', 'a/dist/index.js.map', 'a/dist/sub/view.js', 'a/dist/kit.mjs', 'a/dist/plain.js', 'a/dist/moved.js', 'a/dist/moved.d.ts', 'a/dist/old/gone.cjs', 'b/dist/x.js']) put(`packages/${f}`);
    put('packages/c/src/only.ts');
    expect(staleBuildOutputs(repo)).toEqual(['packages/a/dist/moved.js', 'packages/a/dist/old/gone.cjs', 'packages/b/dist/x.js']);
    rmSync(join(repo, 'packages', 'a', 'dist', 'moved.js'));
    rmSync(join(repo, 'packages', 'a', 'dist', 'old'), { recursive: true });
    rmSync(join(repo, 'packages', 'b'), { recursive: true });
    expect(staleBuildOutputs(repo)).toEqual([]);
    // The check runs before the engine is deployed (and after the build is known to exist).
    const js = readFileSync(join(REPO, 'apps', 'desktop', 'scripts', 'bundle.mjs'), 'utf8');
    const stage = js.slice(js.indexOf('function stageInto('));
    expect(stage.indexOf('staleBuildOutputs(REPO)')).toBeGreaterThan(stage.indexOf("throw new StageError('run pnpm build first')"));
    expect(stage.indexOf('staleBuildOutputs(REPO)')).toBeLessThan(stage.indexOf('deployEngine(REPO, engine)'));
  });

  it('breakHardLinks keeps bytes and mode; templates / skills are copied from git-tracked files only', async () => {
    const { breakHardLinks, trackedFiles } = await stageModule();
    const dir = join(tmp, `links-${Date.now()}`);
    mkdirSync(dir);
    writeFileSync(join(dir, 'tool'), '#!/bin/sh\n');
    chmodSync(join(dir, 'tool'), 0o755);
    linkSync(join(dir, 'tool'), join(tmp, `tool-${Date.now()}`));
    expect(breakHardLinks(dir)).toBe(1);
    expect(statSync(join(dir, 'tool')).nlink).toBe(1);
    expect(statSync(join(dir, 'tool')).mode & 0o777).toBe(0o755);
    expect(readFileSync(join(dir, 'tool'), 'utf8')).toBe('#!/bin/sh\n');
    const repo = miniRepo();
    writeFileSync(join(repo, 'packages', 'a', '.env'), 'TOKEN=x\n');
    writeFileSync(join(repo, 'packages', 'a', 'notes.md'), 'x');
    expect(trackedFiles(repo, 'packages/a').sort()).toEqual(['packages/a/dist/index.js', 'packages/a/package.json']);
    expect(trackedFiles(repo, 'packages/a', { untracked: true }).sort()).toEqual(['packages/a/dist/index.js', 'packages/a/notes.md', 'packages/a/package.json']);
  });
});

describe('retake init (a workspace folder of your own)', () => {
  it('new folder → workspace; existing workspace left; non-empty folder refused; never inside the app', async () => {
    const dir = join(tmp, 'ws-new');
    expect(await initWorkspace(dir)).toEqual({ root: dir, created: true });
    expect(readFileSync(join(dir, 'retake.yaml'), 'utf8')).toMatch(/^version: 1$/m);
    // The bytes written, pinned (the workspace's files go through the project store since).
    expect(createHash('sha256').update(readFileSync(join(dir, 'retake.yaml'))).digest('hex')).toBe('00a93f8141ad48a6a45b9b2fafbaa659b998525e5c92506dccfc765e0263f0e1');
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toBe('.retake/\n');
    expect(readdirSync(join(dir, 'projects'))).toEqual([]);
    writeFileSync(join(dir, 'retake.yaml'), 'version: 1\nprojects_dir: mine\n');
    expect(await initWorkspace(dir)).toEqual({ root: dir, created: false });
    expect(readFileSync(join(dir, 'retake.yaml'), 'utf8')).toContain('projects_dir: mine');
    const full = join(tmp, 'ws-full');
    mkdirSync(full);
    writeFileSync(join(full, 'notes.txt'), 'x');
    await expect(initWorkspace(full)).rejects.toThrow(/is not empty and is not a workspace/);
    const hidden = join(tmp, 'ws-hidden');
    mkdirSync(hidden);
    writeFileSync(join(hidden, '.DS_Store'), '');
    expect((await initWorkspace(hidden)).created).toBe(true);
    const app = appBundle();
    overrideBundleInfo(app);
    await expect(initWorkspace(join(app.root, 'ws'))).rejects.toThrow(BundleError);
  });
});

/** A fake app bundle (Retake.app/Contents/Resources) with its plugin folder. */
function appBundle(): BundleInfo {
  const root = join(mkdtempSync(join(tmp, 'app-')), 'Retake.app', 'Contents', 'Resources');
  for (const d of ['node/bin', 'engine/node_modules/@retake/components/library/studio/card', 'browsers', 'engine/templates', 'plugin/.claude-plugin', 'plugin/skills/.claude-plugin']) mkdirSync(join(root, d), { recursive: true });
  writeFileSync(join(root, 'bundle.json'), JSON.stringify({ v: 1, app: '0.2.0', ffmpeg: null, paths: { node: 'node/bin/node', engine: 'engine', browsers: 'browsers', ffmpeg: null, templates: 'engine/templates', plugin: 'plugin' } }));
  return readBundleManifest(root);
}

describe('an app bundle: the plugin marketplace and the preview writes', () => {
  it("the plugin marketplace is the bundle's plugin/ folder (once its files are there)", () => {
    const app = appBundle();
    expect(pluginMarketplaceRoot(join(app.paths.engine, 'dist', 'bin.js'), () => false, app)).toBeUndefined();
    writeFileSync(join(app.paths.plugin, '.claude-plugin', 'marketplace.json'), '{}');
    writeFileSync(join(app.paths.plugin, 'skills', '.claude-plugin', 'plugin.json'), '{}');
    expect(pluginMarketplaceRoot(join(app.paths.engine, 'dist', 'bin.js'), undefined, app)).toBe(app.paths.plugin);
  });

  it('a preview written next to a component inside the bundle is refused before any rendering (M3)', async () => {
    const app = appBundle();
    overrideBundleInfo(app);
    const dir = join(app.paths.engine, 'node_modules/@retake/components/library/studio/card');
    const opts = { root: tmp, targets: [{ id: 'studio/card', dir, entry: join(dir, 'index.tsx'), manifest: {} }] } as unknown as RenderPreviewsOptions;
    await expect(renderComponentPreviews(opts)).rejects.toThrow(/refused: the preview of studio\/card .* inside the Retake app/);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("renders use the bundle's headless shell; without it a bundle refuses (no Remotion download, into the app or elsewhere)", () => {
    const app = appBundle();
    const shell = join(app.paths.browsers, 'chromium_headless_shell-1194', 'chrome-mac', 'headless_shell');
    expect(renderBrowser({}, app, () => shell)).toEqual({ path: shell, source: 'bundled' });
    expect(renderBrowser({}, null, () => '/cache/headless_shell')).toEqual({ path: '/cache/headless_shell', source: 'playwright' });
    const missing = renderBrowser({}, app, () => null);
    expect(missing).toMatchObject({ path: null, source: 'none', note: expect.stringMatching(/reinstall Retake/) });
    expect(() => assertRenderBrowser(missing, PERSON_POLICY, app)).toThrow(/headless shell is missing/);
    // Outside an app too: Remotion never downloads a browser of its own.
    expect(() => assertRenderBrowser(renderBrowser({}, null, () => null), PERSON_POLICY, null)).toThrow(/playwright-core install chromium-headless-shell/);
  });

  it("every command's --out inside the app is refused before the command starts (review A L4)", async () => {
    const app = appBundle();
    overrideBundleInfo(app);
    const io = memoryIo();
    const code = await main(['node', 'retake', '-C', tmp, 'export-capture', 'nothing', 'latest', '--out', join(app.root, 'pkg')], io);
    expect(code).toBe(1);
    expect(io.stderr()).toMatch(/refused: --out .* inside the Retake app/);
    expect(readdirSync(app.root)).not.toContain('pkg');
  });

  it('components preview --all from a bundle means --workspace (the built-ins ship sealed inside it)', async () => {
    overrideBundleInfo(appBundle());
    const ws = join(tmp, 'ws-preview');
    mkdirSync(ws);
    writeFileSync(join(ws, 'retake.yaml'), 'version: 1\n');
    const io = memoryIo();
    expect(await componentsPreviewCommand(new Ui(io), { root: ws }, undefined, { all: true })).toBe(0);
    expect(io.stderr() + io.stdout()).toMatch(/built-in components ship inside the Retake app/);
    expect(io.stderr() + io.stdout()).toMatch(/every preview is up to date/);
  });
});

describe('every Node.js started on the bundle\'s code loads its module lookup guard first (review A H1)', () => {
  it('bundleNodeArgs: --require <Resources>/node/guard.cjs from a bundle, nothing from a checkout; a bundle without it is damaged', () => {
    expect(BUNDLE_GUARD).toBe('node/guard.cjs');
    expect(bundleNodeArgs(null)).toEqual([]);
    const app = appBundle();
    expect(() => bundleNodeArgs(app)).toThrow(/node\/guard\.cjs is missing: this copy of Retake is damaged — install it again from its disk image/);
    writeFileSync(join(app.root, BUNDLE_GUARD), '');
    expect(bundleNodeArgs(app)).toEqual(['--require', join(app.root, 'node', 'guard.cjs')]);
  });

  it('the MCP registration of a bundle starts its server with the guard before the entry point; the plugin route still names the entry point', () => {
    const app = appBundle();
    writeFileSync(join(app.root, BUNDLE_GUARD), '');
    overrideBundleInfo(app);
    const bin = join(app.paths.engine, 'dist', 'bin.js');
    const e = mcpServerEntry({ root: '/w', bin, node: join(app.root, 'node', 'bin', 'node'), env: { PATH: '/usr/bin' } });
    expect(e.args).toEqual(['--require', join(app.root, 'node', 'guard.cjs'), bin, '--root', '/w', 'mcp']);
    expect(pluginInstallCommands({ root: '/w', bin, node: join(app.root, 'node', 'bin', 'node'), env: { PATH: '/usr/bin' }, repo: app.paths.plugin }).join('\n')).toContain(`cli=${bin}`);
    overrideBundleInfo(null);
    expect(mcpServerEntry({ root: '/w', bin, node: '/n/node', env: { PATH: '/usr/bin' } }).args).toEqual([bin, '--root', '/w', 'mcp']);
  });

  it('the jobs worker of a bundle (the built engine) starts with the guard before its entry', () => {
    const app = appBundle();
    writeFileSync(join(app.root, BUNDLE_GUARD), '');
    const core = pathToFileURL(join(REPO, 'packages', 'core', 'dist', 'io', 'index.js')).href;
    const spawn = pathToFileURL(join(REPO, 'packages', 'engine', 'dist', 'jobs', 'spawn.js')).href;
    const script = `const core = await import(${JSON.stringify(core)});
const { workerCommand } = await import(${JSON.stringify(spawn)});
core.overrideBundleInfo(core.readBundleManifest(${JSON.stringify(app.root)}));
const a = workerCommand('/w').args;
core.overrideBundleInfo(null);
console.log(JSON.stringify([a, workerCommand('/w').args]));`;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', cwd: REPO });
    expect(r.status, r.stderr).toBe(0);
    const [bundled, plain] = JSON.parse(r.stdout) as [string[], string[]];
    const entry = join(REPO, 'packages', 'engine', 'dist', 'worker-main.js');
    expect(bundled).toEqual(['--require', join(app.root, 'node', 'guard.cjs'), entry, '--root', '/w']);
    expect(plain).toEqual([entry, '--root', '/w']);
  });
});

describe('the render bundle takes no module from above the app (review A H1, the render half)', () => {
  it('renderBundleRestriction: webpack\'s resolver (the same enhanced-resolve) finds a planted package above the roots without it, never with it; inside the roots, resolution is unchanged', async () => {
    const base = mkdtempSync(join(tmp, 'restrict-'));
    const res = join(base, 'Retake.app', 'Contents', 'Resources');
    const ws = join(base, 'ws');
    const put = (rel: string, text: string) => {
      mkdirSync(dirname(join(base, rel)), { recursive: true });
      writeFileSync(join(base, rel), text);
    };
    put('node_modules/@remotion/video-matting/package.json', '{"name":"@remotion/video-matting","main":"index.js"}');
    put('node_modules/@remotion/video-matting/index.js', 'planted');
    put('Retake.app/Contents/Resources/engine/node_modules/@remotion/studio/dist/x.js', '');
    put('Retake.app/Contents/Resources/engine/node_modules/react/package.json', '{"name":"react","main":"index.js"}');
    put('Retake.app/Contents/Resources/engine/node_modules/react/index.js', '');
    put('ws/node_modules/local/package.json', '{"name":"local","main":"index.js"}');
    put('ws/node_modules/local/index.js', '');
    put('ws/components/card/index.tsx', '');
    const webpack = createRequire(join(REPO, 'packages', 'editor', 'package.json')).resolve('webpack/package.json');
    const { ResolverFactory, CachedInputFileSystem } = createRequire(webpack)('enhanced-resolve') as any;
    const fs = new CachedInputFileSystem(createRequire(import.meta.url)('node:fs'), 0);
    const resolver = (restrictions?: RegExp[]) => {
      const r = ResolverFactory.createResolver({ fileSystem: fs, extensions: ['.js'], modules: ['node_modules', join(res, 'engine', 'node_modules')], ...(restrictions ? { restrictions } : {}) });
      return (from: string, request: string) => new Promise<string | false>((ok) => r.resolve({}, from, request, {}, (err: Error | null, p?: string) => ok(err ? false : p ?? false)));
    };
    const studio = join(res, 'engine', 'node_modules', '@remotion', 'studio', 'dist');
    const open = resolver();
    expect(await open(studio, '@remotion/video-matting')).toBe(join(base, 'node_modules', '@remotion', 'video-matting', 'index.js'));
    const guarded = resolver([renderBundleRestriction([res, ws, join(ws, '.retake', 'cache')])]);
    expect(await guarded(studio, '@remotion/video-matting')).toBe(false);
    expect(await guarded(studio, 'react')).toBe(join(res, 'engine', 'node_modules', 'react', 'index.js'));
    expect(await guarded(join(ws, 'components', 'card'), 'react')).toBe(join(res, 'engine', 'node_modules', 'react', 'index.js'));
    expect(await guarded(join(ws, 'components', 'card'), 'local')).toBe(join(ws, 'node_modules', 'local', 'index.js'));
    // A root's neighbour with the same prefix is not inside it.
    expect(renderBundleRestriction(['/a/ws']).test('/a/ws-other/x.js')).toBe(false);
    expect(renderBundleRestriction(['/a/ws']).test('/a/ws/x.js')).toBe(true);
    expect(renderBundleRestriction(['/a/ws']).test('/planted/a/ws/x.js')).toBe(false);
  });

  it('ensureBundle passes the restriction to the bundler when Retake runs from an app bundle (only then)', async () => {
    // L7.34 (finding C4): held by what the bundler is handed instead of the statements that hand it — the bundler is
    // stood in (it reads the webpack configuration it is given and writes a page), once outside an app, once inside.
    const seen: Array<Record<string, unknown> | undefined> = [];
    bundler.bundle = async (o: { outDir: string; webpackOverride: (c: Record<string, unknown>) => { resolve?: Record<string, unknown> } }) => {
      seen.push(o.webpackOverride({ resolve: {}, plugins: [] }).resolve);
      mkdirSync(o.outDir, { recursive: true });
      writeFileSync(join(o.outDir, 'index.html'), '<!doctype html><html><head></head><body></body></html>');
      return o.outDir;
    };
    try {
      const ws = mkdtempSync(join(tmp, 'bundle-ws-'));
      await ensureBundle({ root: ws, components: [], cacheDir: join(ws, 'cache-plain') });
      const app = appBundle();
      overrideBundleInfo(app);
      // A cache folder outside the workspace (a test's override): allowed on its own.
      const cache = mkdtempSync(join(tmp, 'bundle-cache-'));
      await ensureBundle({ root: ws, components: [], cacheDir: cache });
      expect(seen).toHaveLength(2);
      expect(seen[0]).not.toHaveProperty('restrictions');
      const [only, ...more] = (seen[1]?.restrictions ?? []) as RegExp[];
      expect(more).toEqual([]);
      // The app's folder, the workspace and the cache are allowed; a module from above them is not.
      expect([join(app.root, 'engine', 'x.js'), join(ws, 'components', 'x.js'), join(cache, 'x.js'), join(dirname(app.root), 'x.js')].map((f) => only!.test(f))).toEqual([true, true, true, false]);
    } finally {
      bundler.bundle = undefined;
    }
  });
});
