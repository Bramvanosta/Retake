/**
 * L5.16a — the relocatable engine's rules outside core: every ffmpeg / ffprobe spawn goes through the resolver (a source
 * lint), the bundle setup runs first in both entry points, one version number, the stage's layout check (on a small
 * fake stage), `retake init`, the plugin marketplace and the preview writes of an app bundle.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { BUNDLE_GUARD, BundleError, RETAKE_VERSION, bundleNodeArgs, overrideBundleInfo, readBundleManifest } from '@retake/core';
import type { BundleInfo } from '@retake/core';
import { assertRenderBrowser, renderBrowser, renderBundleRestriction, renderComponentPreviews } from '@retake/editor';
import type { RenderPreviewsOptions } from '@retake/editor';
import { mcpServerEntry, pluginInstallCommands, pluginMarketplaceRoot } from '@retake/mcp';
import { main, memoryIo } from '../src/index.js';
import { componentsPreviewCommand } from '../src/commands/components.js';
import { initWorkspace } from '../src/commands/init.js';
import { Ui } from '../src/ui.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
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

  it('no source names ffmpeg / ffprobe as a command outside core/src/bundle.ts', () => {
    const offenders: string[] = [];
    for (const pkg of readdirSync(join(REPO, 'packages'))) {
      let files: string[];
      try {
        files = sources(join(REPO, 'packages', pkg, 'src'));
      } catch {
        continue;
      }
      for (const f of files) {
        if (f.endsWith(join('core', 'src', 'bundle.ts'))) continue;
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
    for (const ok of ["name: 'ffmpeg' | 'ffprobe'", "whichOnPath('ffmpeg', env)", 'spawn(ffmpegBin(o.ffmpeg), a)']) expect(SPAWN.test(ok), ok).toBe(false);
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
    expect(session.indexOf('assertRenderBrowser(browser)')).toBeGreaterThan(0);
    expect(session.indexOf('assertRenderBrowser(browser)')).toBeLessThan(session.indexOf('startAssetServer()'));
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
}
const stageModule = async () => (await import(pathToFileURL(join(REPO, 'apps', 'desktop', 'scripts', 'bundle.mjs')).href)) as StageModule;

describe('the stage layout check (bundle.mjs checkStage, a small fake stage)', () => {
  let n = 0;
  const THIN = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x0c, 0, 0, 1]);
  const FAT = Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 2]);
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
    const { checkStage } = await stageModule();
    const r = checkStage(fakeStage(), { machinePaths });
    expect(r.problems).toEqual([]);
    expect(r.machO).toEqual(expect.arrayContaining([{ path: 'node/bin/node', kind: 'fat' }, { path: 'engine/node_modules/@remotion/compositor-darwin-arm64/libavutil.dylib', kind: 'thin' }]));
    expect(readBundleManifest(fakeStage()).paths.ffmpeg).toBeNull();
  });

  it('each rule: links absolute or leaving, a machine path, a marker with content, two playwright-cores, a path out', async () => {
    const { checkStage } = await stageModule();
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

const hasPnpm = spawnSync('pnpm', ['--version'], { stdio: 'ignore' }).status === 0;

describe('the stage never writes the checkout (H1: pnpm deploy hard-links injected workspace packages)', () => {
  /** A two-package workspace in git (a depends on b, workspace:*), offline: no external dependency. */
  function miniRepo(): string {
    const repo = join(tmp, `mini${Math.random().toString(36).slice(2, 8)}`);
    const file = (rel: string, text: string) => {
      mkdirSync(dirname(join(repo, rel)), { recursive: true });
      writeFileSync(join(repo, rel), text);
    };
    file('package.json', '{ "name": "mini", "private": true }\n');
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
    const { deployEngine, checkStage, repoSnapshot } = await stageModule();
    const repo = miniRepo();
    const before = repoSnapshot(repo);
    const bPkg = readFileSync(join(repo, 'packages', 'b', 'package.json'));
    const engine = join(tmp, `deploy-${Date.now()}`);
    const { unlinked } = deployEngine(repo, engine, '@m/a');
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

  it("renders use the bundle's headless shell; without it a bundle refuses (no Remotion download into the app)", () => {
    const app = appBundle();
    const shell = join(app.paths.browsers, 'chromium_headless_shell-1194', 'chrome-mac', 'headless_shell');
    expect(renderBrowser({}, app, () => shell)).toEqual({ path: shell, source: 'bundled' });
    expect(renderBrowser({}, null, () => '/cache/headless_shell')).toEqual({ path: '/cache/headless_shell', source: 'playwright' });
    const missing = renderBrowser({}, app, () => null);
    expect(missing).toMatchObject({ path: null, source: 'remotion', note: expect.stringMatching(/reinstall Retake/) });
    expect(() => assertRenderBrowser(missing, app)).toThrow(/headless shell is missing/);
    expect(() => assertRenderBrowser(renderBrowser({}, null, () => null), null)).not.toThrow();
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
    const core = pathToFileURL(join(REPO, 'packages', 'core', 'dist', 'index.js')).href;
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

  it('ensureBundle passes the restriction to the bundler when Retake runs from an app bundle (only then)', () => {
    const src = readFileSync(join(REPO, 'packages', 'editor', 'src', 'render', 'bundle.ts'), 'utf8');
    expect(src).toContain('const app = bundleInfoOrNull();');
    expect(src).toContain('...(app ? { restrictions: [renderBundleRestriction([app.root, opts.root, cacheDir])] } : {}),');
  });
});
