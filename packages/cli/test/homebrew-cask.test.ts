/**
 * The Homebrew casks a release writes into the owner's tap (scripts/homebrew-cask.mjs; release.yml › publish, its last
 * two steps, in release-workflow.test.ts): the cask's text, `retake` for stable versions and `retake@beta` for every
 * version, none moved back; the DMG's line of the sums; the tap's place from the run's context; the command line.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SCRIPT = join(REPO, 'scripts', 'homebrew-cask.mjs');
const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'retake-homebrew-cask-')));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const dir = (name: string) => {
  const d = join(tmp, `${name}-${n++}`);
  mkdirSync(d, { recursive: true });
  return d;
};

/* eslint-disable @typescript-eslint/no-explicit-any */
const cask = async () => (await import(pathToFileURL(SCRIPT).href)) as any;
const bundle = async () => (await import(pathToFileURL(join(REPO, 'apps', 'desktop', 'scripts', 'bundle.mjs')).href)) as any;
const SHA = 'f0'.repeat(32);
const where = { server: 'https://github.example.test', repository: 'example-owner/example-repo' };
const opts = (version: string, extra: Record<string, unknown> = {}) => ({ version, dmg: `Retake_${version}_aarch64.dmg`, sha256: SHA, ...where, ...extra });
const cli = (args: string[], env: Record<string, string> = {}) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', ...env } });

describe('scripts/homebrew-cask.mjs: the casks', () => {
  it('the stable cask: the version, the DMG\'s sha256, its url on this repository\'s releases, the command linked, Apple silicon, the app\'s minimum macOS, the beta in conflict, the latest release for livecheck, zap', async () => {
    const { buildCask } = await cask();
    const { file, content } = buildCask({ ...opts('0.2.0'), beta: false, homepage: 'https://www.example.com/' });
    expect(file).toBe('retake.rb');
    expect(content).toBe(`cask "retake" do
  version "0.2.0"
  sha256 "${SHA}"

  url "https://github.example.test/example-owner/example-repo/releases/download/v#{version}/Retake_#{version}_aarch64.dmg"
  name "Retake"
  desc "Product videos of a web app from a written scenario, with an MCP server for agents"
  homepage "https://www.example.com/"

  livecheck do
    url :url
    strategy :github_latest
  end

  auto_updates true
  conflicts_with cask: "retake@beta"
  depends_on arch: :arm64
  depends_on macos: ">= :sequoia"

  app "Retake.app"
  binary "#{appdir}/Retake.app/Contents/Resources/bin/retake"

  zap trash: [
    "~/Library/Caches/local.retake.desktop",
    "~/Library/Preferences/local.retake.desktop.plist",
    "~/Library/Saved Application State/local.retake.desktop.savedState",
    "~/Library/WebKit/local.retake.desktop",
  ]
end
`);
  });

  it('the beta cask: the same app, every release for livecheck (pre-releases too), the stable cask in conflict; a candidate goes to the beta only', async () => {
    const { buildCask, buildCasks } = await cask();
    const stable = buildCask({ ...opts('0.2.0'), beta: false }).content;
    const beta = buildCask({ ...opts('0.2.0'), beta: true });
    expect(beta.file).toBe('retake@beta.rb');
    expect(beta.content).toBe(stable
      .replace('cask "retake" do', 'cask "retake@beta" do')
      .replace('    strategy :github_latest', '    regex(/^v?(\\d+(?:\\.\\d+)+(?:-[0-9A-Za-z.-]+)?)$/i)\n    strategy :github_releases')
      .replace('conflicts_with cask: "retake@beta"', 'conflicts_with cask: "retake"'));
    // Without a homepage: the repository's page.
    expect(stable).toMatch(/^ {2}homepage "https:\/\/github\.example\.test\/example-owner\/example-repo"$/m);
    // The livecheck regex, as Ruby reads it, takes the version out of a candidate's tag.
    const regex = /regex\(\/(.+)\/i\)/.exec(beta.content)![1]!;
    expect(new RegExp(regex, 'i').exec('v0.3.0-rc.1')?.[1]).toBe('0.3.0-rc.1');
    expect(buildCasks(opts('0.2.0')).map((c: any) => c.file)).toEqual(['retake.rb', 'retake@beta.rb']);
    expect(buildCasks(opts('0.3.0-rc.1')).map((c: any) => c.file)).toEqual(['retake@beta.rb']);
    expect(buildCasks(opts('0.3.0-rc.1'))[0].content).toMatch(/version "0\.3\.0-rc\.1"[\s\S]*\/v#\{version\}\/Retake_#\{version\}_aarch64\.dmg"/);
    expect(() => buildCask({ ...opts('0.3.0-rc.1'), beta: false })).toThrow(/0\.3\.0-rc\.1 is a pre-release: only retake@beta follows it/);
  });

  it('the app\'s own facts: its name, the launcher\'s place in Resources, its bundle identifier, its minimum macOS', async () => {
    const { buildCask, IDENTIFIER, macosRequirement } = await cask();
    const { LAUNCHER, MINIMUM_MACOS, PRODUCT } = await bundle();
    const conf = JSON.parse(readFileSync(join(REPO, 'apps', 'desktop', 'tauri.conf.json'), 'utf8'));
    expect(IDENTIFIER).toBe(conf.identifier);
    const { content } = buildCask({ ...opts('0.2.0'), beta: false });
    expect(content).toContain(`app "${PRODUCT}.app"`);
    expect(content).toContain(`binary "#{appdir}/${PRODUCT}.app/Contents/Resources/${LAUNCHER}"`);
    expect(content).toContain(`depends_on macos: "${macosRequirement(MINIMUM_MACOS)}"`);
    expect(macosRequirement('15.0')).toBe('>= :sequoia');
    expect(macosRequirement('26.1')).toBe('>= :tahoe');
    expect(() => macosRequirement('99.0')).toThrow(/no Homebrew name known for macOS 99\.0/);
  });

  it('refuses what is not a version, a sha256, a disk image of that version or an https homepage', async () => {
    const { buildCask } = await cask();
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ version: 'v0.2.0' }, /"v0\.2\.0" is not a version/],
      [{ sha256: 'F0'.repeat(32) }, /is not a sha256/],
      [{ sha256: 'f0' }, /is not a sha256/],
      [{ dmg: 'Retake_0.1.0_aarch64.dmg' }, /"Retake_0\.1\.0_aarch64\.dmg" is not a disk image named with 0\.2\.0/],
      [{ dmg: 'Retake_0.2.0_aarch64.zip' }, /is not a disk image/],
      [{ dmg: 'a "b" 0.2.0.dmg' }, /is not a disk image/],
      [{ homepage: 'http://www.example.com/' }, /the homepage is not an https address/],
      [{ homepage: 'https://www.example.com/"; system "x' }, /the homepage is not an https address/],
    ];
    for (const [extra, msg] of cases) expect(() => buildCask({ ...opts('0.2.0'), beta: true, ...extra }), JSON.stringify(extra)).toThrow(msg);
  });

  it('writes into <tap>/Casks: a newer version moves the casks on, an older one leaves them alone (a final version is newer than its candidates)', async () => {
    const { writeCasks, caskVersion } = await cask();
    const tap = dir('tap');
    const read = (f: string) => caskVersion(readFileSync(join(tap, 'Casks', f), 'utf8'));
    expect(writeCasks({ tap, ...opts('0.3.0-rc.1') })).toEqual(['Casks/retake@beta.rb → 0.3.0-rc.1']);
    expect(writeCasks({ tap, ...opts('0.2.0') })).toEqual(['Casks/retake.rb → 0.2.0', 'Casks/retake@beta.rb is at 0.3.0-rc.1: left alone (this is 0.2.0)']);
    expect([read('retake.rb'), read('retake@beta.rb')]).toEqual(['0.2.0', '0.3.0-rc.1']);
    expect(writeCasks({ tap, ...opts('0.3.0') })).toEqual(['Casks/retake.rb → 0.3.0', 'Casks/retake@beta.rb → 0.3.0']);
    expect(writeCasks({ tap, ...opts('0.3.0') })).toEqual(['Casks/retake.rb → 0.3.0', 'Casks/retake@beta.rb → 0.3.0']);
    expect(writeCasks({ tap, ...opts('0.2.1') })).toEqual(['Casks/retake.rb is at 0.3.0: left alone (this is 0.2.1)', 'Casks/retake@beta.rb is at 0.3.0: left alone (this is 0.2.1)']);
    // A cask whose version cannot be read is replaced.
    writeFileSync(join(tap, 'Casks', 'retake.rb'), 'cask "retake" do\nend\n');
    expect(writeCasks({ tap, ...opts('0.2.1') })[0]).toBe('Casks/retake.rb → 0.2.1');
    expect(caskVersion(null)).toBeNull();
  });
});

describe('scripts/homebrew-cask.mjs: the sums and the tap\'s place', () => {
  it('the DMG\'s sha256: exactly one line of the shasum listing names it (text or binary mode)', async () => {
    const { dmgSha256 } = await cask();
    const dmg = 'Retake_0.2.0_aarch64.dmg';
    expect(dmgSha256(`${'ab'.repeat(32)}  Retake.app.tar.gz\n${SHA}  ${dmg}\n`, dmg)).toBe(SHA);
    expect(dmgSha256(`${SHA} *${dmg}`, dmg)).toBe(SHA);
    expect(() => dmgSha256(`${SHA}  Retake.app.tar.gz\n`, dmg)).toThrow(/the sums name Retake_0\.2\.0_aarch64\.dmg nowhere: one line expected/);
    expect(() => dmgSha256(`${SHA}  ${dmg}\n${SHA}  ${dmg}\n`, dmg)).toThrow(/2 times/);
    expect(() => dmgSha256(`${SHA}  x${dmg}\n`, dmg)).toThrow(/nowhere/);
  });

  it('the tap: <owner>/homebrew-tap on the run\'s server over SSH, that host with GitHub\'s pinned key, GitHub Actions\' bot as the author', async () => {
    const { tapPlace, HOST_KEY } = await cask();
    expect(HOST_KEY).toMatch(/^ssh-ed25519 [A-Za-z0-9+/]+$/);
    expect(tapPlace({ GITHUB_SERVER_URL: 'https://github.example.test/', GITHUB_REPOSITORY: 'example-owner/example-repo' })).toEqual({
      remote: 'git@github.example.test:example-owner/homebrew-tap.git',
      known_host: `github.example.test ${HOST_KEY}`,
      author: 'github-actions[bot]',
      email: '41898282+github-actions[bot]@users.noreply.github.example.test',
    });
    expect(() => tapPlace({ GITHUB_REPOSITORY: 'example-owner/example-repo' })).toThrow(/GITHUB_SERVER_URL is not an https origin/);
    expect(() => tapPlace({ GITHUB_SERVER_URL: 'http://github.example.test', GITHUB_REPOSITORY: 'example-owner/example-repo' })).toThrow(/GITHUB_SERVER_URL is not an https origin/);
    expect(() => tapPlace({ GITHUB_SERVER_URL: 'https://github.example.test' })).toThrow(/GITHUB_REPOSITORY is not set/);
    expect(() => tapPlace({ GITHUB_SERVER_URL: 'https://github.example.test', GITHUB_REPOSITORY: 'a/b/c' })).toThrow(/GITHUB_REPOSITORY is not <owner>\/<repo>: "a\/b\/c"/);
  });
});

describe('scripts/homebrew-cask.mjs: the command line', () => {
  const env = { GITHUB_SERVER_URL: 'https://github.example.test', GITHUB_REPOSITORY: 'example-owner/example-repo' };

  it('tap and sha256 print key=value lines for $GITHUB_OUTPUT; write writes the casks and says each', () => {
    const tap = cli(['tap'], env);
    expect(tap.status, tap.stderr).toBe(0);
    expect(tap.stdout.split('\n').filter(Boolean).map((l) => l.slice(0, l.indexOf('=')))).toEqual(['remote', 'known_host', 'author', 'email']);
    const d = dir('cli');
    writeFileSync(join(d, 'sums'), `${SHA}  Retake_0.2.0_aarch64.dmg\n`);
    expect(cli(['sha256', join(d, 'sums'), 'Retake_0.2.0_aarch64.dmg']).stdout).toBe(`sha256=${SHA}\n`);
    const tapDir = join(d, 'tap');
    const w = cli(['write', '0.2.0', '--dmg', 'Retake_0.2.0_aarch64.dmg', '--sha256', SHA, '--homepage', '', '--tap', tapDir], env);
    expect(w.status, w.stderr).toBe(0);
    expect(w.stdout).toBe('Casks/retake.rb → 0.2.0\nCasks/retake@beta.rb → 0.2.0\n');
    expect(readFileSync(join(tapDir, 'Casks', 'retake.rb'), 'utf8')).toMatch(/homepage "https:\/\/github\.example\.test\/example-owner\/example-repo"/);
  });

  it('refuses a missing or unknown argument, a missing context, a bad value — naming it, nothing written', () => {
    const d = dir('cli-bad');
    const cases: Array<[string[], Record<string, string>, RegExp]> = [
      [[], env, /^homebrew-cask: usage: /],
      [['tap', 'x'], env, /^homebrew-cask: usage: /],
      [['tap'], {}, /^homebrew-cask: GITHUB_SERVER_URL is not an https origin/],
      [['write', '0.2.0', '--dmg', 'Retake_0.2.0_aarch64.dmg', '--sha256', SHA], env, /^homebrew-cask: --tap is required/],
      [['write', '0.2.0', '--dmg', 'Retake_0.2.0_aarch64.dmg', '--sha256', SHA, '--tap', d, '--force', 'x'], env, /^homebrew-cask: unknown or repeated argument "--force"/],
      [['write', '0.2.0', '--dmg', 'Retake_0.2.0_aarch64.dmg', '--sha256', SHA, '--tap', d, '--tap', d], env, /^homebrew-cask: unknown or repeated argument "--tap"/],
      [['write', '0.2.0', '--dmg', 'Retake_0.2.0_aarch64.dmg', '--sha256', 'nope', '--tap', d], env, /^homebrew-cask: "nope" is not a sha256/],
      [['write', '0.2.0', '--dmg', 'Retake_0.2.0_aarch64.dmg', '--sha256', SHA, '--tap', d], {}, /^homebrew-cask: GITHUB_SERVER_URL is not an https origin/],
    ];
    for (const [args, e, msg] of cases) {
      const r = cli(args, e);
      expect(r.status, args.join(' ')).toBe(1);
      expect(r.stderr, args.join(' ')).toMatch(msg);
    }
    expect(spawnSync('ls', [d], { encoding: 'utf8' }).stdout).toBe('');
  });
});
