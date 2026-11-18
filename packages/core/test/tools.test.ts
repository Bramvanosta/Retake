/**
 * The downloaded Tools' model (core io tools.ts): the manifest's checks (the host allow-list, the digests, the
 * folders), tools.json, the tree digest (pinned against the stage's own walk, apps/desktop/scripts/bundle.mjs treeDigest)
 * and the cheap state read at each use.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { megabytes } from '@retake/core/base';
import { BundleError, TOOL_HOSTS, launchTool, parseToolEntries, readToolsManifest, toolProblem, toolState, toolsState, treeDigest, treeSummary, urlProblem, VERIFIED_FILE } from '@retake/core/io';
import type { ToolEntry } from '@retake/core/io';
import { FIXTURE_MARKERS, toolFixtures } from '@retake/test-support/tools';
import type { FixtureTools } from '@retake/test-support/tools';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'retake-tools-model-')));
afterAll(() => {
  spawnSync('/bin/chmod', ['-R', 'u+w', tmp]);
  rmSync(tmp, { recursive: true, force: true });
});

let fx: FixtureTools;
beforeAll(async () => {
  fx = await toolFixtures(join(tmp, 'fx'));
});

const one = (over: Partial<ToolEntry>, id: ToolEntry['id'] = 'render-browser'): unknown[] => fx.entries.map((e) => (e.id === id ? { ...e, ...over } : e));

describe('the manifest: every entry checked, in one sentence', () => {
  it('the fixture entries pass, in install order whatever the file’s (render browser, compositor, browser)', () => {
    const parsed = parseToolEntries([...fx.entries].reverse(), 'test');
    expect(parsed.map((e) => e.id)).toEqual(['render-browser', 'compositor', 'browser']);
  });

  it('downloads come from the allow-list only: https, one of its hosts, no port, user, query or fragment', () => {
    expect(TOOL_HOSTS).toEqual(['storage.googleapis.com', 'registry.npmjs.org']);
    expect(urlProblem('https://storage.googleapis.com/a/b.zip')).toBeUndefined();
    expect(urlProblem('https://registry.npmjs.org/x/-/x-1.0.0.tgz')).toBeUndefined();
    expect(urlProblem('http://storage.googleapis.com/a.zip')).toMatch(/https only/);
    expect(urlProblem('https://cdn.example/a.zip')).toMatch(/cdn\.example is not one of the hosts/);
    expect(urlProblem('https://storage.googleapis.com.example/a.zip')).toMatch(/is not one of the hosts/);
    expect(urlProblem('https://storage.googleapis.com:8443/a.zip')).toMatch(/no port/);
    expect(urlProblem('https://u:p@storage.googleapis.com/a.zip')).toMatch(/no port, user/);
    expect(urlProblem('https://storage.googleapis.com/a.zip?x=1')).toMatch(/query/);
    expect(urlProblem('file:///etc/passwd')).toMatch(/https only/);
    expect(urlProblem('https://tools.example/a.zip', ['tools.example'])).toBeUndefined();
    expect(() => parseToolEntries(one({ url: 'http://storage.googleapis.com/x.zip' }), 'tools.json')).toThrow(/tools\.json: tools\[0\] \(render-browser\): url .*: https only/);
    expect(() => parseToolEntries(one({ url: 'https://elsewhere.example/x.zip' }), 'tools.json')).toThrow(BundleError);
  });

  it('digests, sizes, folders and paths: each refused when it is not one', () => {
    expect(() => parseToolEntries(one({ sha256: 'abc' }), 't')).toThrow(/sha256 must be a sha256/);
    expect(() => parseToolEntries(one({ tree: 'A'.repeat(64) }), 't')).toThrow(/tree must be a sha256/);
    expect(() => parseToolEntries(one({ bytes: 0 }), 't')).toThrow(/bytes must be the archive size/);
    expect(() => parseToolEntries(one({ folder: '../escape' }), 't')).toThrow(/folder must be a plain folder name/);
    expect(() => parseToolEntries(one({ folder: 'browsers/../../x' }), 't')).toThrow(/folder must be a plain folder name/);
    expect(() => parseToolEntries(one({ folder: 'chromium_headless_shell-1' }), 't')).toThrow(/the browsers go under browsers\//);
    expect(() => parseToolEntries(one({ folder: 'browsers/compositor-1' }, 'compositor'), 't')).toThrow(/the compositor does not/);
    expect(() => parseToolEntries(one({ executable: '../../bin/sh' }), 't')).toThrow(/executable must be a relative path/);
    expect(() => parseToolEntries(one({ executable: '/bin/sh' }), 't')).toThrow(/executable must be a relative path/);
    expect(() => parseToolEntries(one({ prune: ['a/../../b'] }, 'browser'), 't')).toThrow(/prune must list relative paths/);
    expect(() => parseToolEntries(one({ root: 'package' }), 't')).toThrow(/root is a plain folder name of a tgz/);
    expect(() => parseToolEntries(one({ markers: ['../x'] }), 't')).toThrow(/markers/);
    expect(() => parseToolEntries(one({ label: 'Render‮browser' }), 't')).toThrow(/label must be a short line of text/);
  });

  it('each Tool once, each folder once, all three listed', () => {
    expect(() => parseToolEntries([...fx.entries, fx.entries[0]], 't')).toThrow(/render-browser is listed twice/);
    expect(() => parseToolEntries(one({ folder: fx.entries[2]!.folder }), 't')).toThrow(/is listed twice/);
    expect(() => parseToolEntries(fx.entries.slice(1), 't')).toThrow(/tools lacks render-browser/);
    expect(() => parseToolEntries({}, 't')).toThrow(/tools must be a list/);
  });

  it('tools.json: version 1, one list per platform', () => {
    const file = join(tmp, 'tools.json');
    writeFileSync(file, JSON.stringify({ v: 1, platforms: { 'darwin-arm64': fx.entries } }));
    expect(readToolsManifest(file, 'darwin-arm64').map((e) => e.folder)).toEqual(fx.entries.map((e) => e.folder));
    expect(() => readToolsManifest(file, 'linux-x64')).toThrow(/lists no Tools for linux-x64/);
    writeFileSync(file, JSON.stringify({ v: 2, platforms: {} }));
    expect(() => readToolsManifest(file)).toThrow(/is not a version 1 tools manifest/);
  });
});

describe('the tree digest', () => {
  it("is the stage's tree walk (bundle.mjs treeDigest), hashed line by line: links, executable bits, the markers and top-level dot entries left out", async () => {
    const { treeDigest: stageWalk } = (await import(join(REPO, 'apps', 'desktop', 'scripts', 'bundle.mjs'))) as { treeDigest(dir: string, o: { skip: string[] }): Map<string, string> };
    const browserDigest = (dir: string) => {
      const walk = stageWalk(dir, { skip: [...FIXTURE_MARKERS] });
      const h = createHash('sha256');
      for (const k of [...walk.keys()].sort()) h.update(`${k}\t${walk.get(k)}\n`);
      return h.digest('hex');
    };
    for (const t of fx.tools) {
      const dir = join(tmp, `parity-${t.entry.id}`);
      spawnSync('/usr/bin/ditto', [t.source, dir]);
      for (const m of FIXTURE_MARKERS) writeFileSync(join(dir, m), '');
      writeFileSync(join(dir, VERIFIED_FILE), '{}');
      expect(await treeDigest(dir, FIXTURE_MARKERS), t.entry.id).toBe(browserDigest(dir));
      expect(await treeDigest(dir, FIXTURE_MARKERS)).toBe(t.entry.tree);
    }
  });

  it('changes with a byte, a mode bit or a link target', async () => {
    const dir = join(tmp, 'digest-change');
    spawnSync('/usr/bin/ditto', [fx.byId('browser').source, dir]);
    const before = await treeDigest(dir);
    const exe = join(dir, 'chrome-mac-arm64', 'Fixture Browser.app', 'Contents', 'MacOS', 'Fixture Browser');
    chmodSync(exe, 0o644);
    const noExec = await treeDigest(dir);
    expect(noExec).not.toBe(before);
    chmodSync(exe, 0o755);
    expect(await treeDigest(dir)).toBe(before);
    appendFileSync(exe, ' ');
    expect(await treeDigest(dir)).not.toBe(before);
  });
});

describe('the cheap state (toolState): a stamp, the markers and a walk of lstat calls', () => {
  /** An installed copy of a fixture Tool under `dir` (as the installer leaves it, before its read-only modes). */
  async function installed(dir: string, id: ToolEntry['id']): Promise<string> {
    const t = fx.byId(id);
    const folder = join(dir, ...t.entry.folder.split('/'));
    spawnSync('/bin/mkdir', ['-p', dirname(folder)]);
    spawnSync('/usr/bin/ditto', [t.source, folder]);
    for (const m of t.entry.markers ?? []) writeFileSync(join(folder, m), '');
    const sum = treeSummary(folder, t.entry.markers ?? []);
    writeFileSync(join(folder, VERIFIED_FILE), JSON.stringify({ v: 1, tree: t.entry.tree, entries: sum.entries, bytes: sum.bytes, at: new Date(0).toISOString() }));
    return folder;
  }

  it('missing, ready, then damaged by each cause', async () => {
    const dir = join(tmp, 'state1');
    const e = fx.byId('render-browser').entry;
    expect(toolState(e, dir)).toMatchObject({ state: 'missing', path: join(dir, 'browsers', 'chromium_headless_shell-001') });
    const folder = await installed(dir, 'render-browser');
    expect(toolState(e, dir).state).toBe('ready');
    // A file added: the walk sees it (its stamp's figures no longer match); `walk: false` (the queue's gate) does not.
    writeFileSync(join(folder, 'chrome-headless-shell-mac-arm64', 'extra'), 'x');
    expect(toolState(e, dir)).toMatchObject({ state: 'damaged', problem: expect.stringMatching(/its files changed since they were checked/) });
    expect(toolState(e, dir, { walk: false }).state).toBe('ready');
    rmSync(join(folder, 'chrome-headless-shell-mac-arm64', 'extra'));
    expect(toolState(e, dir).state).toBe('ready');
    // A marker gone.
    rmSync(join(folder, 'INSTALLATION_COMPLETE'));
    expect(toolState(e, dir)).toMatchObject({ state: 'damaged', problem: 'its marker INSTALLATION_COMPLETE is missing' });
    writeFileSync(join(folder, 'INSTALLATION_COMPLETE'), '');
    // A stamp of another tree digest (the manifest re-recorded): damaged, never ready.
    expect(toolState({ ...e, tree: 'f'.repeat(64) }, dir)).toMatchObject({ state: 'damaged', problem: expect.stringMatching(/checked against another tree digest/) });
    // No stamp.
    rmSync(join(folder, VERIFIED_FILE));
    expect(toolState(e, dir)).toMatchObject({ state: 'damaged', problem: expect.stringMatching(/never checked/) });
  });

  it('a folder others may write, or the Tools folder itself, is not trusted', async () => {
    const dir = join(tmp, 'state2');
    const folder = await installed(dir, 'compositor');
    const e = fx.byId('compositor').entry;
    expect(toolState(e, dir).state).toBe('ready');
    chmodSync(folder, 0o777);
    expect(toolState(e, dir)).toMatchObject({ state: 'damaged', problem: expect.stringMatching(/may be written by other users/) });
    chmodSync(folder, 0o755);
    chmodSync(dir, 0o775);
    expect(toolState(e, dir)).toMatchObject({ state: 'damaged', problem: `${dir} may be written by other users` });
    chmodSync(dir, 0o755);
    expect(toolsState(fx.entries, dir).map((s) => s.state)).toEqual(['missing', 'ready', 'missing']);
  });

  it('in a checkout no Tool is ever a problem (Playwright cache and node_modules, as before)', () => {
    expect(toolProblem('browser', { RETAKE_HOME: join(tmp, 'nowhere') }, null)).toBeUndefined();
  });
});

describe('the words every reader shares', () => {
  it('one megabytes rule, decimal (the Studio, retake tools, the installer): 315 358 794 bytes read "315 MB"', () => {
    expect(megabytes(315_358_794)).toBe('315 MB');
    expect(megabytes(8_389_003)).toBe('8.4 MB');
  });

  it("launchTool: a browser of the person's own needs no Tool; the headless shell is the render browser, a window the browser", () => {
    expect(launchTool(undefined, true)).toBe('browser');
    expect(launchTool({ channel: 'chromium' }, true)).toBe('browser');
    expect(launchTool({ channel: 'chrome' }, true)).toBeNull();
    expect(launchTool({ executable: '/opt/own/chrome' }, false)).toBeNull();
    expect(launchTool({ channel: 'headless-shell' }, true)).toBe('render-browser');
    expect(launchTool({ channel: 'headless-shell' }, false)).toBe('browser');
  });
});
