/**
 * L5.16e fixes — the release's last half and what the build pins (fast, no network, never a real identity, keychain
 * or notarisation): apps/desktop/scripts/release.mjs (`finishApp` from an ad hoc app: refusals first, the version the
 * app must carry, the update archive with no stale file, the DMG's folder, the Developer ID re-signature inside-out
 * through recording stand-ins; the `--out` folder; the command line), bundle.mjs's pins (the Node.js binary, the
 * browsers' tree digests), the Tauri CLI folder checked file by file before the sign job runs it, hdiutil tried again
 * on "Resource busy" only, and `build --app-only`.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const APP = join(REPO, 'apps', 'desktop');
const RELEASE = join(APP, 'scripts', 'release.mjs');
const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'retake-app-release-sign-')));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const MAC = process.platform === 'darwin';

/* eslint-disable @typescript-eslint/no-explicit-any */
const bundleModule = async () => (await import(pathToFileURL(join(APP, 'scripts', 'bundle.mjs')).href)) as any;
const releaseModule = async () => (await import(pathToFileURL(RELEASE).href)) as any;

const THIN = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x0c, 0, 0, 1, 0, 0, 0, 0]);
let n = 0;
const dir = (name: string) => {
  const d = join(tmp, `${name}-${n++}`);
  mkdirSync(d, { recursive: true });
  return d;
};
const put = (root: string, rel: string, data: string | Buffer = '', mode = 0o644) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), data);
  chmodSync(join(root, rel), mode);
};
const ID = 'Developer ID Application: Example Maker (ABCDE12345)';
const APPLE = { APPLE_SIGNING_IDENTITY: ID, APPLE_TEAM_ID: 'ABCDE12345', APPLE_API_KEY: 'key-id', APPLE_API_ISSUER: 'issuer', APPLE_API_KEY_PATH: '/keys/AuthKey.p8' };
const NODE_ENTRY = [{ id: 'node', kind: 'file', path: 'node/bin/node', entitlements: 'node', dryDLV: false }];

/** Recording stand-ins on a scratch PATH: each call `<tool> <args>` appended to calls.log, then the tool's body. */
function fakeTools(tools: Record<string, string>) {
  const bin = dir('fake-tools');
  const log = join(bin, 'calls.log');
  for (const [tool, body] of Object.entries(tools)) {
    writeFileSync(join(bin, tool), `#!/bin/sh\necho "${tool} $*" >> ${JSON.stringify(log)}\n${body}\n`);
    chmodSync(join(bin, tool), 0o755);
  }
  return { bin, calls: () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : []) };
}

/** An ad hoc app as bundle.mjs lays it out (small): its folder holds the app only. */
function miniApp({ version = '0.2.0', updates = 'off' } = {}) {
  const appDir = dir('app');
  const app = join(appDir, 'Retake.app');
  put(app, 'Contents/Info.plist', `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>${version}</string></dict></plist>\n`);
  put(app, 'Contents/MacOS/retake-desktop', THIN, 0o755);
  put(app, 'Contents/Resources/node/bin/node', THIN, 0o755);
  put(app, 'Contents/Resources/bundle.json', JSON.stringify({ v: 1, app: version, ffmpeg: null, paths: { node: 'node/bin/node', ffmpeg: null }, sha256: { node: 'stale' } }));
  put(app, 'Contents/Resources/launch.json', JSON.stringify({ version: 2, bundled: true, updates }));
  symlinkSync('node/bin/node', join(app, 'Contents', 'Resources', 'node-link'));
  return { appDir, app };
}

describe('the pins: the Node.js binary and the browsers the stage copies (review e A-M3)', () => {
  it('checkNode: the pinned version and binary pass; another version, another binary or another platform is refused in one sentence that says what to do', async () => {
    const { checkNode, NODE_PIN } = await bundleModule();
    const bin = join(dir('node'), 'node');
    writeFileSync(bin, 'a node binary');
    const pin = { version: '22.16.0', sha256: { 'darwin-arm64': createHash('sha256').update('a node binary').digest('hex') } };
    expect(() => checkNode({ execPath: bin, version: '22.16.0', platform: 'darwin-arm64', pin })).not.toThrow();
    expect(() => checkNode({ execPath: bin, version: '22.17.0', platform: 'darwin-arm64', pin })).toThrow(/^run the stage with Node\.js 22\.16\.0, the version apps\/desktop\/bundle\/node\.json pins .* this is v22\.17\.0/);
    writeFileSync(bin, 'another binary');
    expect(() => checkNode({ execPath: bin, version: '22.16.0', platform: 'darwin-arm64', pin })).toThrow(/is not the official Node\.js 22\.16\.0 binary apps\/desktop\/bundle\/node\.json pins \(sha256 [0-9a-f]{64}, pinned [0-9a-f]{64}\): install Node\.js 22\.16\.0/);
    expect(() => checkNode({ execPath: bin, version: '22.16.0', platform: 'darwin-x64', pin })).toThrow(/pins no Node\.js binary for darwin-x64/);
    // The committed pin: one exact version and a sha256 per platform the release workflow runs on (the macOS jobs, the
    // ubuntu ones); the stage checks it before it copies anything.
    expect(NODE_PIN.version).toMatch(/^22\.\d+\.\d+$/);
    expect(Object.keys(NODE_PIN.sha256).sort()).toEqual(['darwin-arm64', 'linux-x64']);
    for (const v of Object.values(NODE_PIN.sha256)) expect(v).toMatch(/^[0-9a-f]{64}$/);
    expect(NODE_PIN.sha256['darwin-arm64']).not.toBe(NODE_PIN.sha256['linux-x64']);
    const src = readFileSync(join(APP, 'scripts', 'bundle.mjs'), 'utf8');
    const stageInto = src.slice(src.indexOf('function stageInto('));
    expect(stageInto.indexOf('checkNode();')).toBeGreaterThan(0);
    expect(stageInto.indexOf('checkNode();')).toBeLessThan(stageInto.indexOf('cpSync(process.execPath, nodeBin);'));
  });

  it('browserDigest: every path, link, size, executable bit and byte counts, Playwright\'s markers do not; checkBrowser refuses another tree or a revision with no pin', async () => {
    const { browserDigest, checkBrowser, BROWSER_PINS } = await bundleModule();
    const tree = () => {
      const d = join(dir('browser'), 'chromium-9999');
      put(d, 'chrome-mac/Chromium.app/Contents/MacOS/Chromium', THIN, 0o755);
      put(d, 'chrome-mac/Chromium.app/Contents/Resources/en.lproj/locale.pak', 'words');
      symlinkSync('Versions/A', join(d, 'chrome-mac', 'Current'));
      put(d, 'INSTALLATION_COMPLETE');
      return d;
    };
    const base = browserDigest(tree());
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    const variants: Array<(d: string) => void> = [
      (d) => writeFileSync(join(d, 'chrome-mac/Chromium.app/Contents/Resources/en.lproj/locale.pak'), 'wordz'),
      (d) => chmodSync(join(d, 'chrome-mac/Chromium.app/Contents/Resources/en.lproj/locale.pak'), 0o755),
      (d) => (rmSync(join(d, 'chrome-mac', 'Current')), symlinkSync('Versions/B', join(d, 'chrome-mac', 'Current'))),
      (d) => put(d, 'chrome-mac/extra', ''),
    ];
    for (const change of variants) {
      const d = tree();
      change(d);
      expect(browserDigest(d)).not.toBe(base);
    }
    const marked = tree();
    put(marked, 'DEPENDENCIES_VALIDATED', '');
    writeFileSync(join(marked, 'INSTALLATION_COMPLETE'), 'rewritten');
    expect(browserDigest(marked)).toBe(base);
    expect(() => checkBrowser(tree(), 'chromium-9999', { digests: { 'chromium-9999': base } })).not.toThrow();
    const other = tree();
    put(other, 'chrome-mac/extra', '');
    expect(() => checkBrowser(other, 'chromium-9999', { digests: { 'chromium-9999': base } })).toThrow(/is not the chromium-9999 apps\/desktop\/bundle\/browsers\.json pins \(digest [0-9a-f]{64}, pinned [0-9a-f]{64}\): reinstall it/);
    expect(() => checkBrowser(other, 'chromium-9999', { digests: {} })).toThrow(/pins no digest for chromium-9999: record it from a checked install \(node apps\/desktop\/scripts\/bundle\.mjs browser-digest /);
    // The committed pins cover exactly the revisions the repository's playwright-core pins; the stage checks each
    // folder before it copies it.
    const pw = JSON.parse(readFileSync(join(REPO, 'packages', 'runner-web', 'node_modules', 'playwright-core', 'browsers.json'), 'utf8')).browsers;
    const rev = (name: string) => pw.find((b: any) => b.name === name).revision;
    expect(Object.keys(BROWSER_PINS.digests).sort()).toEqual([`chromium-${rev('chromium')}`, `chromium_headless_shell-${rev('chromium-headless-shell')}`].sort());
    for (const v of Object.values(BROWSER_PINS.digests)) expect(v).toMatch(/^[0-9a-f]{64}$/);
    const src = readFileSync(join(APP, 'scripts', 'bundle.mjs'), 'utf8');
    expect(src).toMatch(/checkBrowser\(from, folder\);\n\s+run\('ditto', \[from, join\(browsers, folder\)\]\);/);
  });

  it('the command line: check-node, check-pins (what the release workflow\'s build job runs after the browsers\' install) and browser-digest', () => {
    const run = (...args: string[]) => spawnSync(process.execPath, [join(APP, 'scripts', 'bundle.mjs'), ...args], { encoding: 'utf8' });
    const d = join(dir('cli-browser'), 'chromium-1');
    put(d, 'a', 'b');
    const digest = run('browser-digest', d);
    expect(digest.status).toBe(0);
    expect(digest.stdout).toMatch(/^[0-9a-f]{64}\n$/);
    const node = run('check-node');
    // The suite may run on another Node.js than the pinned one: either way one sentence, never a stack.
    expect(node.status === 0 ? node.stdout : node.stderr).toMatch(node.status === 0 ? /^Node\.js 22\.\d+\.\d+, the pinned binary\n$/ : /^bundle: run the stage with Node\.js|^bundle: .* is not the official Node\.js/);
  });
});

describe('the Tauri CLI folder the sign job runs: every file its pinned sha512, nothing else (review e A-H1)', () => {
  const pinsFor = (files: Record<string, Record<string, string>>) => {
    const packages: any = {};
    for (const [pkg, fs] of Object.entries(files)) packages[pkg] = Object.fromEntries(Object.entries(fs).map(([f, data]) => [f, `sha512-${createHash('sha512').update(data).digest('base64')}`]));
    return { v: 1, version: '2.12.4', packages };
  };
  const FILES = { '@tauri-apps/cli': { 'tauri.js': 'console.log(1)', 'package.json': '{}' }, '@tauri-apps/cli-darwin-arm64': { 'cli.darwin-arm64.node': 'native' } };
  const layOut = () => {
    const d = dir('tauri-cli');
    for (const [pkg, fs] of Object.entries(FILES)) for (const [f, data] of Object.entries(fs)) put(d, `node_modules/${pkg}/${f}`, data);
    return d;
  };
  it('checkTauriCliDir: the laid-out pinned CLI passes; a changed byte, an extra file or package, a link or a missing file is refused', async () => {
    const { checkTauriCliDir } = await bundleModule();
    const pins = pinsFor(FILES);
    const ok = layOut();
    expect(checkTauriCliDir(ok, pins)).toBe(join(ok, 'node_modules', '@tauri-apps', 'cli', 'tauri.js'));
    const cases: Array<[(d: string) => void, RegExp]> = [
      [(d) => writeFileSync(join(d, 'node_modules/@tauri-apps/cli/tauri.js'), 'stealKeys()'), /node_modules\/@tauri-apps\/cli\/tauri\.js: not its pinned sha512/],
      [(d) => put(d, 'node_modules/@tauri-apps/cli/node_modules/x/index.js', ''), /cli\/node_modules: not a file of the pinned CLI/],
      [(d) => put(d, 'node_modules/other/index.js', ''), /node_modules\/other: not a file of the pinned CLI/],
      [(d) => (rmSync(join(d, 'node_modules/@tauri-apps/cli/package.json')), symlinkSync('/etc/hosts', join(d, 'node_modules/@tauri-apps/cli/package.json'))), /cli\/package\.json: not a file of the pinned CLI/],
      [(d) => rmSync(join(d, 'node_modules/@tauri-apps/cli-darwin-arm64/cli.darwin-arm64.node')), /cli\.darwin-arm64\.node: missing/],
    ];
    for (const [change, msg] of cases) {
      const d = layOut();
      change(d);
      expect(() => checkTauriCliDir(d, pins)).toThrow(msg);
    }
    expect(() => checkTauriCliDir(join(tmp, 'absent'), pins)).toThrow(/missing/);
  });
});

describe('hdiutil, tried again on "Resource busy" only (review e B-M4)', () => {
  const fake = (failures: number, message: string) => {
    const bin = dir('fake-hdiutil');
    const count = join(bin, 'count');
    writeFileSync(count, '0');
    writeFileSync(join(bin, 'hdiutil'), `#!/bin/sh\nc=$(cat ${JSON.stringify(count)}); c=$((c+1)); echo $c > ${JSON.stringify(count)}\nif [ "$c" -le ${failures} ]; then echo "hdiutil: $1 failed - ${message}" >&2; exit 1; fi\necho "created: $*"\n`);
    chmodSync(join(bin, 'hdiutil'), 0o755);
    return { env: { PATH: `${bin}:/usr/bin:/bin` }, tries: () => Number(readFileSync(count, 'utf8')) };
  };
  it('busy twice then made: three tries, the pause doubling; busy three times: the last failure said; any other failure: at once', async () => {
    const { hdiutil } = await bundleModule();
    const slept: number[] = [];
    const sleep = (ms: number) => slept.push(ms);
    const busy = fake(2, 'Resource busy');
    expect(hdiutil(['create', '-ov', '/o/x.dmg'], { env: busy.env, delayMs: 100, sleep })).toBe('created: create -ov /o/x.dmg\n');
    expect([busy.tries(), slept]).toEqual([3, [100, 200]]);
    const stuck = fake(9, 'Resource busy');
    slept.length = 0;
    expect(() => hdiutil(['attach', '/o/x.dmg'], { env: stuck.env, delayMs: 100, sleep })).toThrow(/^hdiutil attach \/o\/x\.dmg… failed \(1, try 3 of 3\): hdiutil: attach failed - Resource busy$/);
    expect([stuck.tries(), slept]).toEqual([3, [100, 200]]);
    const other = fake(9, 'no space left on device');
    slept.length = 0;
    expect(() => hdiutil(['create', '/o/x.dmg'], { env: other.env, delayMs: 100, sleep })).toThrow(/failed \(1\): hdiutil: create failed - no space left on device/);
    expect([other.tries(), slept]).toEqual([1, []]);
    // The DMG's create, attach and detach go through it (finishApp, verifyDmg).
    const rel = readFileSync(RELEASE, 'utf8');
    const src = readFileSync(join(APP, 'scripts', 'bundle.mjs'), 'utf8');
    expect(rel).toContain('hdiutil(dmgCreateArgs({ src: appDir, dmg }), { env: child, ...retry });');
    expect(src).toContain('hdiutil(dmgAttachArgs(dmg, mountpoint), { env, ...retry });');
    expect(src).toContain("hdiutil(['detach', mountpoint], { env, ...retry });");
    expect(`${rel}\n${src}`).not.toMatch(/run\('hdiutil', (?!\['imageinfo')|spawnSync\('hdiutil', \['(?:create|attach|detach', mountpoint)/);
  });
});

describe.runIf(MAC)('finishApp: from the ad hoc app to what a release ships (apps/desktop/scripts/release.mjs)', () => {
  const env = { PATH: '/usr/bin:/bin', HOME: tmp };
  it('the version the app must carry (review e B-L7: a pre-release, Info.plist = --app-version), or nothing is signed', async () => {
    const { finishApp } = await releaseModule();
    const { app } = miniApp({ version: '0.3.0-rc.1' });
    const ok = finishApp({ app, out: dir('out'), mode: 'dry', env, entries: NODE_ENTRY, dmg: false, verified: true, appVersion: '0.3.0-rc.1' });
    expect(ok).toMatchObject({ mode: 'dry', version: '0.3.0-rc.1', dmg: null, update: null });
    expect(() => finishApp({ app, out: dir('out'), mode: 'dry', env, entries: NODE_ENTRY, dmg: false, verified: true, appVersion: '0.3.0' })).toThrow(/Retake\.app is version 0\.3\.0-rc\.1 \(Info\.plist\), not 0\.3\.0: build the tagged commit — nothing was signed/);
  });

  it('the update archive: none from an app without the updater, unsigned (and said) without a key — never a stale file of an earlier run (review e B-L6); a key needs the public key and the pinned CLI', async () => {
    const { finishApp } = await releaseModule();
    const out = dir('out');
    for (const f of ['Retake.app.tar.gz', 'Retake.app.tar.gz.sig']) writeFileSync(join(out, f), 'stale');
    const off = miniApp();
    expect(finishApp({ app: off.app, out, mode: 'dry', env, entries: NODE_ENTRY, dmg: false, verified: true }).update).toBeNull();
    expect(readdirSync(out)).toEqual([]);
    writeFileSync(join(out, 'Retake.app.tar.gz.sig'), 'stale');
    const on = miniApp({ updates: 'on' });
    const said: string[] = [];
    const r = finishApp({ app: on.app, out, mode: 'dry', env, entries: NODE_ENTRY, dmg: false, verified: true, say: (_: string, m: string) => said.push(m) });
    expect(r.update).toMatchObject({ archive: join(out, 'Retake.app.tar.gz'), signature: null, links: 1 });
    expect(readdirSync(out)).toEqual(['Retake.app.tar.gz']);
    expect(said.join('\n')).toMatch(/update archive made, NOT signed: no TAURI_SIGNING_PRIVATE_KEY/);
    expect(() => finishApp({ app: on.app, out, mode: 'dry', env: { ...env, TAURI_SIGNING_PRIVATE_KEY: 'k' }, entries: NODE_ENTRY, dmg: false, verified: true })).toThrow(/RETAKE_UPDATE_PUBKEY is needed to check its signature — nothing was signed/);
    expect(() => finishApp({ app: on.app, out, mode: 'dry', env: { ...env, TAURI_SIGNING_PRIVATE_KEY: 'k' }, pubkey: 'not a key', entries: NODE_ENTRY, dmg: false, verified: true })).toThrow(/RETAKE_UPDATE_PUBKEY/);
    const src = readFileSync(RELEASE, 'utf8');
    expect(src).toMatch(/if \(updates && key && !cliJs\) throw new StageError\('the update archive is signed by the pinned Tauri CLI/);
  });

  it('the app\'s folder becomes the DMG: anything but the app (and its Applications link) is refused before anything runs', async () => {
    const { finishApp } = await releaseModule();
    const { appDir, app } = miniApp();
    writeFileSync(join(appDir, 'notes.txt'), 'x');
    expect(() => finishApp({ app, out: dir('out'), mode: 'dry', env, entries: NODE_ENTRY, verified: true })).toThrow(/becomes the DMG: it must hold Retake\.app only \(it holds notes\.txt\)/);
  });

  it('a release: refused without the whole APPLE_* set before any tool runs; with it, the ad hoc app re-signed inside-out with the Developer ID (its keychain, a timestamp), bundle.json\'s hashes refreshed, then checked — notarised only after the checks pass', async () => {
    const { finishApp } = await releaseModule();
    const tools = fakeTools({ codesign: 'exit 0', xcrun: 'exit 1', ditto: 'exit 1', hdiutil: 'exit 1', spctl: 'exit 1' });
    const { app } = miniApp();
    const out = dir('out');
    expect(() => finishApp({ app, out, mode: 'release', env: { PATH: `${tools.bin}:/usr/bin:/bin`, HOME: tmp, APPLE_SIGNING_IDENTITY: ID }, entries: NODE_ENTRY })).toThrow(/set APPLE_TEAM_ID, .* nothing was signed/);
    expect(tools.calls()).toEqual([]);
    const kc = '/runner/temp/signing/retake-signing.keychain-db';
    // The stand-in codesign signs nothing and answers no entitlement: the checks after the signature fail, so nothing
    // is notarised (no xcrun, no ditto) — and every signature before was the Developer ID's.
    expect(() => finishApp({ app, out, mode: 'release', env: { ...APPLE, APPLE_KEYCHAIN: kc, PATH: `${tools.bin}:/usr/bin:/bin`, HOME: tmp }, entries: NODE_ENTRY })).toThrow(/the app fails its checks after its Developer ID signature:\n {2}node\/bin\/node: entitlements \[\], the table says/);
    const calls = tools.calls();
    const signs = calls.filter((c) => c.startsWith('codesign --force'));
    expect(signs.map((c) => c.split(' ').pop())).toEqual([join(app, 'Contents', 'Resources', 'node', 'bin', 'node'), join(app, 'Contents', 'MacOS', 'retake-desktop'), app]);
    for (const c of signs) expect(c).toMatch(new RegExp(`^codesign --force --options runtime --timestamp --keychain ${kc} -s ${ID.replace(/[()]/g, '\\$&')} `));
    expect(signs[0]).toMatch(/--entitlements \S+node\.release\.plist /);
    expect(calls.some((c) => /^(?:xcrun|ditto|hdiutil|spctl)/.test(c))).toBe(false);
    expect(JSON.parse(readFileSync(join(app, 'Contents', 'Resources', 'bundle.json'), 'utf8')).sha256.node).toBe(createHash('sha256').update(THIN).digest('hex'));
    // The order of a release, after the checks: notarised and stapled, then the archive of the stapled app, then the DMG.
    const src = readFileSync(RELEASE, 'utf8');
    const at = (s: string) => src.indexOf(s);
    expect(at('notarizeApp(s, app')).toBeGreaterThan(at('the app fails its checks after its Developer ID signature'));
    expect(at('makeUpdateArchive(app, out')).toBeGreaterThan(at('notarizeApp(s, app'));
    expect(at('hdiutil(dmgCreateArgs(')).toBeGreaterThan(at('makeUpdateArchive(app, out'));
    expect(at('verifyRelease(app, dmg, s)')).toBeGreaterThan(at('notarizeDmg(s, dmg)'));
  });
});

describe('release.mjs sign: the command line and its --out folder', () => {
  it('claimReleaseOut: absent or empty is claimed; an earlier run\'s is emptied (no stale archive); a folder of the person\'s, or the app\'s own, is refused', async () => {
    const { claimReleaseOut, RELEASE_MARK } = await releaseModule();
    const { app, appDir } = miniApp();
    const fresh = join(dir('claim'), 'out');
    expect(claimReleaseOut(fresh, app)).toBe(fresh);
    expect(readdirSync(fresh)).toEqual([RELEASE_MARK]);
    writeFileSync(join(fresh, 'Retake.app.tar.gz.sig'), 'stale');
    mkdirSync(join(fresh, 'mnt'));
    claimReleaseOut(fresh, app);
    expect(readdirSync(fresh)).toEqual([RELEASE_MARK]);
    const mine = dir('mine');
    writeFileSync(join(mine, 'thesis.md'), 'mine');
    expect(() => claimReleaseOut(mine, app)).toThrow(/is not empty and holds no earlier run \(\.retake-release\)/);
    expect(readdirSync(mine)).toEqual(['thesis.md']);
    expect(() => claimReleaseOut(appDir, app)).toThrow(/a folder of its own, apart from the app's/);
    expect(() => claimReleaseOut(join(appDir, 'out'), app)).toThrow(/apart from the app's/);
    expect(() => claimReleaseOut(dirname(appDir), app)).toThrow(/apart from the app's/);
  });

  it('a release without the whole set is refused before anything is claimed; flags are checked; the Tauri CLI folder is checked before anything runs', async () => {
    const { parseSignArgs } = await releaseModule();
    const { app } = miniApp();
    const out = join(dir('cli'), 'out');
    const run = (args: string[], extra: Record<string, string> = {}) => spawnSync(process.execPath, [RELEASE, 'sign', ...args], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: tmp, ...extra } });
    const refused = run(['--app', app, '--out', out, '--release'], { APPLE_SIGNING_IDENTITY: ID, APPLE_PASSWORD: 'apple-pw-canary' });
    expect(refused.status).toBe(1);
    expect(refused.stderr).toMatch(/^release: a release build signs with your Developer ID and notarises: set APPLE_TEAM_ID, .* nothing was signed\n$/);
    expect(refused.stderr).not.toMatch(/canary/);
    expect(existsSync(out)).toBe(false);
    const badCli = run(['--app', app, '--out', out, '--tauri-cli', dir('not-the-cli')]);
    expect(badCli.status).toBe(1);
    expect(badCli.stderr).toMatch(/^release: \S+ is not the Tauri CLI 2\.12\.4 apps\/desktop\/bundle\/tauri-cli\.json pins: node_modules\/@tauri-apps\/cli\/[^:]+: missing/);
    expect(parseSignArgs(['--app', 'a', '--out', 'o', '--release', '--app-version', '0.2.0'])).toEqual({ app: 'a', out: 'o', release: true, appVersion: '0.2.0' });
    for (const bad of [['--app', 'a'], ['--app', 'a', '--out', 'o', '--force'], ['--app', '--out', 'o']]) expect(() => parseSignArgs(bad), bad.join(' ')).toThrow(/sign needs --out|unknown argument|sign needs --app/);
    expect(run([]).status).toBe(1);
  });

  it('build --app-only lays the ad hoc app out for the sign job: never with --release (refused before anything, the set or not)', async () => {
    const { build } = await bundleModule();
    const out = dir('app-only');
    expect(() => build({ out, mode: 'release', appOnly: true, env: { PATH: '/usr/bin:/bin', HOME: tmp } })).toThrow(/nothing was signed/);
    expect(() => build({ out, mode: 'release', appOnly: true, env: { ...APPLE, PATH: '/usr/bin:/bin', HOME: tmp } })).toThrow(/--app-only lays the ad hoc app out .* node apps\/desktop\/scripts\/release\.mjs sign --release/);
    expect(readdirSync(out)).toEqual([]);
    const src = readFileSync(join(APP, 'scripts', 'bundle.mjs'), 'utf8');
    expect(src).toContain("appOnly: rest.includes('--app-only')");
    // The layout is ad hoc in every mode: a release re-signs the finished app (finishApp), as the sign job does.
    expect(src).toContain("const s = signer('dry', env, child);");
    expect(src).toMatch(/verifyApp\(app, 'dry', \{ entries: table, env: child \}\)/);
  });
});
