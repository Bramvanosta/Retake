/**
 * The Homebrew tap's casks (scripts/homebrew-cask.mjs; docs/RELEASING.md › The Homebrew tap), against scratch tap folders
 * only — no network, no `brew`: `retake.rb` follows the stable versions, `retake@beta.rb` every version (never behind),
 * a cask never moved back to an older version nor overwritten when its version cannot be read; the release's location
 * from the run's context (GITHUB_SERVER_URL, GITHUB_REPOSITORY), never from the script; every value checked before it
 * reaches the Ruby (no injection); the DMG's sha256 from SHA256SUMS-macos.txt; zap removes what macOS and the shell keep
 * under ~/Library, never ~/.retake; the command linked through the app's launcher (which resolves links).
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { APP_BUNDLE_ID } from '@retake/core';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SCRIPT = join(REPO, 'scripts', 'homebrew-cask.mjs');
const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'retake-homebrew-cask-')));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const tap = () => {
  const d = join(tmp, `tap-${n++}`);
  mkdirSync(d);
  return d;
};

/* eslint-disable @typescript-eslint/no-explicit-any */
const cask = async () => (await import(pathToFileURL(SCRIPT).href)) as any;
const SHA = 'a'.repeat(64);
const SHA2 = 'b'.repeat(64);
const location = { server: 'https://github.example.test', repository: 'example-owner/example-repo' };
const env = { GITHUB_SERVER_URL: location.server, GITHUB_REPOSITORY: location.repository };
const cli = (args: string[], e: Record<string, string> = env) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', ...e } });

describe('scripts/homebrew-cask.mjs: the casks', () => {
  it('a stable version: the retake cask — the release\'s DMG by Homebrew\'s #{version}, GitHub\'s latest release, the other cask in conflict, macOS 15 on Apple silicon, the app and its command', async () => {
    const { buildCask } = await cask();
    const { file, content } = buildCask({ version: '0.2.1', sha256: SHA, location, id: APP_BUNDLE_ID, autoUpdates: true });
    expect(file).toBe('retake.rb');
    expect(content.split('\n').slice(0, 9)).toEqual([
      'cask "retake" do',
      '  version "0.2.1"',
      `  sha256 "${SHA}"`,
      '',
      '  url "https://github.example.test/example-owner/example-repo/releases/download/v#{version}/Retake_#{version}_aarch64.dmg"',
      '  name "Retake"',
      '  desc "Product videos of web apps, written as scenarios and edited automatically"',
      '  homepage "https://github.example.test/example-owner/example-repo"',
      '',
    ]);
    expect(content).toMatch(/ {2}livecheck do\n {4}url :url\n {4}strategy :github_latest\n {2}end\n/);
    // macOS 15 or later in the DSL's own form (a symbol: this version or later) — the string comparison is deprecated.
    expect(content).toMatch(/^ {2}auto_updates true\n {2}conflicts_with cask: "retake@beta"\n {2}depends_on macos: :sequoia\n {2}depends_on arch: :arm64\n$/m);
    expect(content).not.toMatch(/depends_on macos: "/);
    expect(content).toMatch(/^ {2}app "Retake\.app"\n {2}binary "#\{appdir\}\/Retake\.app\/Contents\/Resources\/bin\/retake"\n\n {2}uninstall quit: "local\.retake\.desktop"\n$/m);
    expect(content.endsWith('end\n')).toBe(true);
    // The DMG is the one the release attaches (scripts/release.mjs dmgName), the launcher the one the app carries.
    const { dmgName } = (await import(pathToFileURL(join(REPO, 'scripts', 'release.mjs')).href)) as any;
    expect(dmgName('0.2.1')).toBe('Retake_0.2.1_aarch64.dmg');
    expect(readFileSync(join(REPO, 'apps', 'desktop', 'bundle', 'retake.sh'), 'utf8')).toMatch(/self=\$\(\/bin\/realpath -- "\$0"\)/);
  });

  it('a pre-release: the retake@beta cask alone, its livecheck seeing every release whose tag is a version; the stable cask refuses it', async () => {
    const { buildCask, buildCasks } = await cask();
    const { file, content } = buildCask({ version: '0.3.0-rc.1', sha256: SHA, location, id: APP_BUNDLE_ID, autoUpdates: true });
    expect(file).toBe('retake@beta.rb');
    expect(content).toMatch(/^cask "retake@beta" do\n {2}version "0\.3\.0-rc\.1"\n/);
    // Homebrew's github_releases strategy skips pre-releases by itself: a block keeps them (drafts skipped).
    expect(content).toContain([
      '  livecheck do',
      '    url :url',
      '    regex(/^v?(\\d+(?:\\.\\d+)+(?:-[0-9A-Za-z.-]+)?)$/i)',
      '    strategy :github_releases do |json, regex|',
      '      json.map do |release|',
      '        next if release["draft"]',
      '',
      '        match = release["tag_name"]&.match(regex)',
      '        next if match.blank?',
      '',
      '        match[1]',
      '      end',
      '    end',
      '  end',
    ].join('\n'));
    expect(content).toMatch(/conflicts_with cask: "retake"\n/);
    // The livecheck's pattern takes the version tags, not the update feed's release.
    const re = /^v?(\d+(?:\.\d+)+(?:-[0-9A-Za-z.-]+)?)$/i;
    expect(['v0.3.0-rc.1', 'v0.2.1'].map((t) => re.exec(t)?.[1])).toEqual(['0.3.0-rc.1', '0.2.1']);
    expect(re.test('update-feed')).toBe(false);
    expect(buildCasks({ version: '0.3.0-rc.1', sha256: SHA, location, id: APP_BUNDLE_ID, autoUpdates: true }).map((c: any) => c.file)).toEqual(['retake@beta.rb']);
    expect(() => buildCask({ version: '0.3.0-rc.1', sha256: SHA, beta: false, location, id: APP_BUNDLE_ID, autoUpdates: true })).toThrow(/is a pre-release: only retake@beta follows it/);
    // A stable version moves both: the beta is never behind.
    const both = buildCasks({ version: '0.3.0', sha256: SHA, location, id: APP_BUNDLE_ID, autoUpdates: true });
    expect(both.map((c: any) => c.file)).toEqual(['retake.rb', 'retake@beta.rb']);
    expect(both[1].content).toMatch(/^cask "retake@beta" do\n {2}version "0\.3\.0"\n[\s\S]*strategy :github_releases do/);
    expect(both[0].content).not.toMatch(/github_releases|prerelease|draft/);
  });

  it('auto_updates only for a build with the updater (`brew upgrade` skips an auto-updating cask unless --greedy); not given → refused', async () => {
    const { buildCask, buildCasks } = await cask();
    const off = buildCasks({ version: '0.2.1', sha256: SHA, location, id: APP_BUNDLE_ID, autoUpdates: false });
    for (const c of off) expect(c.content, c.file).not.toMatch(/auto_updates/);
    expect(off[0].content).toMatch(/^ {2}conflicts_with cask: "retake@beta"\n {2}depends_on macos: :sequoia\n/m);
    for (const c of buildCasks({ version: '0.2.1', sha256: SHA, location, id: APP_BUNDLE_ID, autoUpdates: true })) expect(c.content, c.file).toMatch(/^ {2}auto_updates true\n/m);
    for (const autoUpdates of [undefined, 'on', 1]) expect(() => buildCask({ version: '0.2.1', sha256: SHA, location, id: APP_BUNDLE_ID, autoUpdates }), String(autoUpdates)).toThrow(/whether the build updates itself is not given/);
  });

  it('zap: what macOS and the shell keep under ~/Library, named by the app\'s bundle identifier (tauri.conf.json) — never ~/.retake', async () => {
    const { buildCask, bundleId, zapPaths } = await cask();
    expect(bundleId()).toBe(APP_BUNDLE_ID);
    const id = APP_BUNDLE_ID;
    expect(zapPaths(id)).toEqual([`~/Library/Application Support/${id}`, `~/Library/Caches/${id}`, `~/Library/Cookies/${id}.binarycookies`, `~/Library/HTTPStorages/${id}`, `~/Library/HTTPStorages/${id}.binarycookies`, `~/Library/Preferences/${id}.plist`, `~/Library/Saved Application State/${id}.savedState`, `~/Library/WebKit/${id}`]);
    const { content } = buildCask({ version: '0.2.1', sha256: SHA, location, id, autoUpdates: true });
    expect(content).toContain(`  zap trash: [\n${zapPaths(id).map((p: string) => `    "${p}",\n`).join('')}  ]\n`);
    const zap = content.slice(content.indexOf('zap trash:'));
    expect(zap).not.toMatch(/\.retake["/]|~\/\.retake/);
    expect(content).toMatch(/# ~\/\.retake is kept on purpose/);
    // A bundle identifier that is not one is refused.
    const fake = join(tmp, 'fake-repo');
    mkdirSync(join(fake, 'apps', 'desktop'), { recursive: true });
    writeFileSync(join(fake, 'apps', 'desktop', 'tauri.conf.json'), JSON.stringify({ identifier: 'local.retake"; system("x")' }));
    expect(() => bundleId(fake)).toThrow(/is not a bundle identifier/);
  });

  it('odd input never reaches the Ruby: a version, a sha256, a location or an identifier that is not one is refused', async () => {
    const { buildCask, releaseLocation } = await cask();
    const ok = { version: '0.2.1', sha256: SHA, location, id: APP_BUNDLE_ID, autoUpdates: true };
    for (const version of ['latest', 'v0.2.1', '0.2.1"; system("x")', '0.2.1-#{x}', '0.2.1\nend', '0.2.1-rc.1 ', '', `0.2.1-${'a'.repeat(70)}`]) expect(() => buildCask({ ...ok, version }), version).toThrow(/is not a version/);
    for (const sha256 of ['abc', SHA.toUpperCase(), `${SHA}0`, `${SHA.slice(1)}"`, '']) expect(() => buildCask({ ...ok, sha256 }), sha256).toThrow(/is not a sha256/);
    for (const loc of [{ ...location, server: 'http://github.example.test' }, { ...location, server: 'https://github.example.test/x"' }, { ...location, repository: 'o/r"; x' }, { ...location, repository: 'o/#{x}' }, undefined]) expect(() => buildCask({ ...ok, location: loc }), JSON.stringify(loc)).toThrow(/no release location/);
    for (const id of ['x', 'a.b"', 'a.b\nc', '#{x}.y']) expect(() => buildCask({ ...ok, id }), id).toThrow(/is not a bundle identifier/);
    // The context: GITHUB_REPOSITORY required, <owner>/<repo>; GITHUB_SERVER_URL https, an origin (GitHub's when unset).
    expect(releaseLocation(env)).toEqual(location);
    expect(releaseLocation({ ...env, GITHUB_SERVER_URL: 'https://github.example.test/' })).toEqual(location);
    expect(releaseLocation({ GITHUB_REPOSITORY: location.repository }).repository).toBe(location.repository);
    expect(() => releaseLocation({})).toThrow(/GITHUB_REPOSITORY is not set/);
    expect(() => releaseLocation({ GITHUB_REPOSITORY: 'o/r/x' })).toThrow(/is not <owner>\/<repo>/);
    expect(() => releaseLocation({ ...env, GITHUB_SERVER_URL: 'http://github.example.test' })).toThrow(/must be https/);
    expect(() => releaseLocation({ ...env, GITHUB_SERVER_URL: 'https://github.example.test/a/b' })).toThrow(/is not an https origin/);
  });

  it('names no account and no repository: the script carries none, a cask names only the location it was given', async () => {
    const { buildCask } = await cask();
    const src = readFileSync(SCRIPT, 'utf8');
    expect(src).not.toMatch(/https?:\/\/|github\.com|\b[\w-]+\/(?:homebrew-)?tap\b/i);
    const other = { server: 'https://git.example.net', repository: 'someone-else/video-tool' };
    const { content } = buildCask({ version: '0.2.1', sha256: SHA, location: other, id: APP_BUNDLE_ID, autoUpdates: true });
    expect([...content.matchAll(/https:\/\/[^\s"/]+\/[^\s"/]+\/[^\s"/]+/g)].map((m) => m[0])).toEqual(['https://git.example.net/someone-else/video-tool', 'https://git.example.net/someone-else/video-tool']);
    // GitHub's name only in livecheck's strategy (Homebrew's own word for where releases are listed).
    expect(content.replace(/strategy :github_latest\n/, '')).not.toMatch(/example-owner|github/i);
  });
});

describe('scripts/homebrew-cask.mjs: the tap folder', () => {
  it('a stable version writes both casks; a pre-release the beta only; never back to an older version; a re-run of the same version changes nothing', async () => {
    const { writeCasks, caskVersion } = await cask();
    const t = tap();
    expect(writeCasks({ version: '0.2.0', sha256: SHA, tap: t, env, autoUpdates: true })).toEqual({ 'retake.rb': 'written', 'retake@beta.rb': 'written' });
    expect(readdirSync(join(t, 'Casks')).sort()).toEqual(['retake.rb', 'retake@beta.rb']);
    const read = (f: string) => caskVersion(readFileSync(join(t, 'Casks', f), 'utf8'));
    expect(writeCasks({ version: '0.3.0-rc.1', sha256: SHA2, tap: t, env, autoUpdates: true })).toEqual({ 'retake@beta.rb': 'written' });
    expect([read('retake.rb'), read('retake@beta.rb')]).toEqual(['0.2.0', '0.3.0-rc.1']);
    // An older version (a re-run of an old tag): both kept, nothing written.
    const before = readFileSync(join(t, 'Casks', 'retake@beta.rb'), 'utf8');
    expect(writeCasks({ version: '0.1.9', sha256: SHA, tap: t, env, autoUpdates: true })).toEqual({ 'retake.rb': 'kept 0.2.0', 'retake@beta.rb': 'kept 0.3.0-rc.1' });
    // The final version passes its pre-release in the beta cask (a pre-release is older than its release).
    expect(writeCasks({ version: '0.3.0-rc.0', sha256: SHA, tap: t, env, autoUpdates: true })).toEqual({ 'retake@beta.rb': 'kept 0.3.0-rc.1' });
    expect(readFileSync(join(t, 'Casks', 'retake@beta.rb'), 'utf8')).toBe(before);
    expect(writeCasks({ version: '0.3.0', sha256: SHA, tap: t, env, autoUpdates: true })).toEqual({ 'retake.rb': 'written', 'retake@beta.rb': 'written' });
    expect(writeCasks({ version: '0.3.0', sha256: SHA, tap: t, env, autoUpdates: true })).toEqual({ 'retake.rb': 'unchanged', 'retake@beta.rb': 'unchanged' });
    expect(readdirSync(join(t, 'Casks')).sort()).toEqual(['retake.rb', 'retake@beta.rb']);
  });

  it('a cask whose version cannot be read is left alone and said; nothing of another tap\'s cask is touched', async () => {
    const { writeCasks } = await cask();
    const t = tap();
    mkdirSync(join(t, 'Casks'));
    writeFileSync(join(t, 'Casks', 'retake.rb'), 'cask "retake" do\n  version :latest\nend\n');
    writeFileSync(join(t, 'Casks', 'other-app.rb'), 'cask "other-app" do\nend\n');
    expect(() => writeCasks({ version: '0.2.0', sha256: SHA, tap: t, env, autoUpdates: true })).toThrow(/Casks\/retake\.rb names no version this script can read/);
    expect(readFileSync(join(t, 'Casks', 'retake.rb'), 'utf8')).toBe('cask "retake" do\n  version :latest\nend\n');
    expect(readFileSync(join(t, 'Casks', 'other-app.rb'), 'utf8')).toBe('cask "other-app" do\nend\n');
  });

  it('the DMG\'s sha256 from SHA256SUMS-macos.txt: exactly one line naming the version\'s DMG', async () => {
    const { dmgSha256 } = await cask();
    const sums = `${'d'.repeat(64)}  Retake.app.tar.gz\n${SHA}  Retake_0.2.0_aarch64.dmg\n${'e'.repeat(64)}  Retake.app.tar.gz.sig\n`;
    expect(dmgSha256(sums, 'Retake_0.2.0_aarch64.dmg')).toBe(SHA);
    expect(dmgSha256(`${SHA} *Retake_0.2.0_aarch64.dmg\r\n`, 'Retake_0.2.0_aarch64.dmg')).toBe(SHA);
    expect(() => dmgSha256(sums, 'Retake_0.2.1_aarch64.dmg')).toThrow(/expected one line for Retake_0\.2\.1_aarch64\.dmg in SHA256SUMS-macos\.txt, found 0/);
    expect(() => dmgSha256(`${sums}${SHA2}  Retake_0.2.0_aarch64.dmg\n`, 'Retake_0.2.0_aarch64.dmg')).toThrow(/found 2/);
    expect(() => dmgSha256(`${SHA.toUpperCase()}  Retake_0.2.0_aarch64.dmg\n`, 'Retake_0.2.0_aarch64.dmg')).toThrow(/found 0/);
  });

  it('the command line the workflow runs: --sums or --sha256, --tap; a bad tag, a missing argument or no GITHUB_REPOSITORY refused with nothing written', () => {
    const t = tap();
    const sums = join(tmp, `sums-${n++}.txt`);
    writeFileSync(sums, `${SHA}  Retake_0.2.0_aarch64.dmg\n`);
    const ok = cli(['v0.2.0', '--sums', sums, '--updates', 'on', '--tap', t]);
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.stdout).toBe('Casks/retake.rb: 0.2.0\nCasks/retake@beta.rb: 0.2.0\n');
    expect(readFileSync(join(t, 'Casks', 'retake.rb'), 'utf8')).toContain(`sha256 "${SHA}"`);
    const again = cli(['v0.2.0', '--sha256', SHA, '--updates', 'on', '--tap', t]);
    expect(again.stdout).toBe('Casks/retake.rb: 0.2.0, unchanged\nCasks/retake@beta.rb: 0.2.0, unchanged\n');
    // --updates off: the next version's casks without auto_updates.
    expect(cli(['v0.2.1', '--sha256', SHA2, '--updates', 'off', '--tap', t]).status).toBe(0);
    expect(readFileSync(join(t, 'Casks', 'retake.rb'), 'utf8')).not.toMatch(/auto_updates/);
    expect(cli(['v0.1.0', '--sha256', SHA, '--updates', 'on', '--tap', t]).stdout).toBe('Casks/retake.rb: 0.2.1 kept (this is 0.1.0)\nCasks/retake@beta.rb: 0.2.1 kept (this is 0.1.0)\n');
    const empty = tap();
    for (const [args, e, msg] of [
      [['0.2.0', '--sha256', SHA, '--updates', 'on', '--tap', empty], env, /is not a release tag/],
      [['v0.2.0', '--updates', 'on', '--tap', empty], env, /usage: homebrew-cask\.mjs/],
      [['v0.2.0', '--sha256', SHA, '--sums', sums, '--updates', 'on', '--tap', empty], env, /usage: homebrew-cask\.mjs/],
      [['v0.2.0', '--sha256', SHA, '--tap', empty, '--updates', 'on', '--tap', empty], env, /unknown or repeated argument "--tap"/],
      [['v0.2.0', '--sha256', SHA, '--other', 'x', '--updates', 'on', '--tap', empty], env, /unknown or repeated argument "--other"/],
      [['v0.2.1', '--sums', sums, '--updates', 'on', '--tap', empty], env, /expected one line for Retake_0\.2\.1_aarch64\.dmg/],
      [['v0.2.0', '--sha256', SHA, '--tap', empty], env, /usage: homebrew-cask\.mjs .*--updates on\|off/],
      [['v0.2.0', '--sha256', SHA, '--updates', 'yes', '--tap', empty], env, /usage: homebrew-cask\.mjs/],
      [['v0.2.0', '--sha256', SHA, '--updates', 'on', '--tap', empty], {}, /GITHUB_REPOSITORY is not set/],
    ] as const) {
      const r = cli([...args], { ...e });
      expect(r.status, args.join(' ')).toBe(1);
      expect(r.stderr, args.join(' ')).toMatch(new RegExp(`^homebrew-cask: .*${msg.source}`));
      expect(readdirSync(empty), args.join(' ')).toEqual([]);
    }
  });
});
