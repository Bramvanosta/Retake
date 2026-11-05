/**
 * L5.16e fixes — the release's last half and what the build pins (fast, no network, never a real identity, keychain
 * or notarisation): apps/desktop/scripts/release.mjs (`finishApp` from an ad hoc app: refusals first, the version the
 * app must carry, the update archive with no stale file, the DMG's folder, the Developer ID re-signature inside-out
 * through recording stand-ins; the `--out` folder; the command line), bundle.mjs's pins (the Node.js binary, the
 * browsers' tree digests), the Tauri CLI folder checked file by file and run from a fresh copy of its checked bytes
 * (made right before the update archive is signed, removed right after, HOME in it, its module lookup checked), the
 * build job's archive read member by member and unpacked to its two parts only (crafted archives: other members, `..`,
 * absolute names, AppleDouble names, hard links, devices, links out of the app, damaged headers), hdiutil tried again
 * on "Resource busy" only, and `build --app-only`.
 */
import { spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
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

/**
 * A gzipped ustar archive of exactly these members, written byte by byte (so a test can hold names and types no tar
 * would write from a folder: `..`, absolute names, links where folders belong).
 */
type Member = { name: string; type?: 'file' | 'dir' | 'link' | 'hardlink' | 'char' | 'fifo' | 'pax' | 'gnu-long-name'; data?: string; link?: string; mode?: number; size?: number; checksum?: 'damaged' };
/** A pax extended header's records (`<length> <key>=<value>\n`, the length counting itself). */
const paxOf = (records: Record<string, string>) => Object.entries(records).map(([k, v]) => {
  const body = ` ${k}=${v}\n`;
  let len = body.length + 1;
  while (String(len).length + body.length !== len) len++;
  return `${len}${body}`;
}).join('');
function tarRaw(members: Member[], { end = Buffer.alloc(1024) } = {}): Buffer {
  const blocks: Buffer[] = [];
  for (const m of members) {
    const type = m.type ?? (m.name.endsWith('/') ? 'dir' : 'file');
    const data = Buffer.from(type === 'file' || type === 'pax' || type === 'gnu-long-name' ? (m.data ?? '') : '');
    const h = Buffer.alloc(512);
    const field = (at: number, len: number, value: string) => h.write(value, at, len, 'utf8');
    const octal = (at: number, len: number, v: number) => field(at, len, `${v.toString(8).padStart(len - 1, '0')}\0`);
    field(0, 100, m.name);
    octal(100, 8, m.mode ?? (type === 'file' ? 0o644 : 0o755));
    octal(108, 8, 501);
    octal(116, 8, 20);
    octal(124, 12, m.size ?? data.length);
    octal(136, 12, 1_700_000_000);
    field(148, 8, '        ');
    field(156, 1, { file: '0', dir: '5', link: '2', hardlink: '1', char: '3', fifo: '6', pax: 'x', 'gnu-long-name': 'L' }[type]);
    if (m.link) field(157, 100, m.link);
    field(257, 6, 'ustar\0');
    field(263, 2, '00');
    let sum = 0;
    for (const b of h) sum += b;
    field(148, 8, `${(sum + (m.checksum ? 1 : 0)).toString(8).padStart(6, '0')}\0 `);
    blocks.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(end);
  return Buffer.concat(blocks);
}
const tarOf = (members: Member[]) => gzipSync(tarRaw(members));
/** The build job's archive as it packs it: the app's folder, the app, the Tauri CLI's folder. */
const BUILD: Member[] = [
  { name: 'app/' },
  { name: 'app/Retake.app/' },
  { name: 'app/Retake.app/Contents/' },
  { name: 'app/Retake.app/Contents/Info.plist', data: '<plist/>' },
  { name: 'app/Retake.app/Contents/Frameworks/Current', type: 'link', link: 'A' },
  { name: 'tauri-cli/' },
  { name: 'tauri-cli/node_modules/@tauri-apps/cli/tauri.js', data: 'console.log(1)' },
];

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

/** Pins (tauri-cli.json's shape) for these packages' files. */
const pinsFor = (files: Record<string, Record<string, string>>) => {
  const packages: any = {};
  for (const [pkg, fs] of Object.entries(files)) packages[pkg] = Object.fromEntries(Object.entries(fs).map(([f, data]) => [f, `sha512-${createHash('sha512').update(data).digest('base64')}`]));
  return { v: 1, version: '2.12.4', packages };
};

describe('the Tauri CLI folder the sign job runs: every file its pinned sha512, nothing else (review e A-H1)', () => {
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

  it('freshTauriCli: the CLI runs from a fresh copy of its checked bytes in a temporary folder of its own — a package planted beside the handed folder is never found; a link, a changed byte or an extra file is refused', async () => {
    const { freshTauriCli } = await bundleModule();
    // tauri.js loads its platform package as the real one does (darwin-universal first): what it found, and where it runs.
    const probe = "let which = 'none'; try { which = require('@tauri-apps/cli-darwin-universal').who; } catch {}\nrequire('node:fs').writeFileSync(process.argv[2], JSON.stringify({ which, self: __filename, paths: require.resolve.paths('x') }));\n";
    const files = { '@tauri-apps/cli': { 'tauri.js': probe, 'package.json': '{"name":"@tauri-apps/cli"}' }, '@tauri-apps/cli-darwin-arm64': { 'cli.darwin-arm64.node': 'native' } };
    const pins = pinsFor(files);
    const handed = dir('handed');
    const cli = join(handed, 'tauri-cli');
    for (const [pkg, fs] of Object.entries(files)) for (const [f, data] of Object.entries(fs)) put(cli, `node_modules/${pkg}/${f}`, data);
    // Beside the handed folder (where the archive could have put it): a package the CLI would load first.
    put(handed, 'node_modules/@tauri-apps/cli-darwin-universal/index.js', "exports.who = 'planted';\n");
    put(handed, 'node_modules/@tauri-apps/cli-darwin-universal/package.json', '{"name":"@tauri-apps/cli-darwin-universal","main":"index.js"}');
    const ran = (cliJs: string, home = tmp) => {
      const report = join(dir('ran'), 'r.json');
      const r = spawnSync(process.execPath, [cliJs, report], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: home } });
      expect(r.status, r.stderr).toBe(0);
      return JSON.parse(readFileSync(report, 'utf8')) as { which: string; self: string; paths: string[] };
    };
    // The canary: run in place, the CLI finds the planted package.
    expect(ran(join(cli, 'node_modules', '@tauri-apps', 'cli', 'tauri.js')).which).toBe('planted');
    const base = dir('fresh-base');
    const fresh = freshTauriCli(cli, pins, base);
    expect(dirname(fresh.root)).toBe(base);
    expect(fresh.root).toMatch(/\/retake-tauri-cli-[^/]+$/);
    expect(fresh.cliJs).toBe(join(fresh.root, 'node_modules', '@tauri-apps', 'cli', 'tauri.js'));
    const got = ran(fresh.cliJs);
    expect({ which: got.which, self: got.self }).toEqual({ which: 'none', self: realpathSync(fresh.cliJs) });
    expect(relative(handed, got.self).startsWith('..')).toBe(true);
    // Where Node.js looks for a package by name, run with HOME in the copy (as signUpdateArchive runs it): exactly the
    // folders cliLookupPaths names — the copy's own, every folder above it, the copy's HOME ones, the prefix's lib/node.
    const { cliLookupPaths } = await bundleModule();
    const home = realpathSync(fresh.root);
    expect(ran(fresh.cliJs, home).paths).toEqual(cliLookupPaths(fresh.cliJs, home));
    // The copy holds the pinned files, those bytes, nothing else.
    for (const [pkg, fs] of Object.entries(files)) for (const [f, data] of Object.entries(fs)) expect(readFileSync(join(fresh.root, 'node_modules', pkg, f), 'utf8')).toBe(data);
    rmSync(fresh.root, { recursive: true, force: true });
    // Refused, and no copy left behind: a link for the folder, a changed byte, an extra file.
    const link = join(dir('link'), 'tauri-cli');
    symlinkSync(cli, link);
    expect(() => freshTauriCli(link, pins, base)).toThrow(/tauri-cli: not the Tauri CLI's folder \(a link\)/);
    writeFileSync(join(cli, 'node_modules/@tauri-apps/cli/tauri.js'), `${probe}stealKeys();\n`);
    expect(() => freshTauriCli(cli, pins, base)).toThrow(/tauri\.js: not its pinned sha512/);
    writeFileSync(join(cli, 'node_modules/@tauri-apps/cli/tauri.js'), probe);
    put(cli, 'node_modules/@tauri-apps/cli-darwin-universal/index.js', '');
    expect(() => freshTauriCli(cli, pins, base)).toThrow(/cli-darwin-universal: not a file of the pinned CLI/);
    expect(readdirSync(base)).toEqual([]);
  });

  it('freshTauriCli, its own checks (the folder check stood in for): each byte read is checked again, a link put in after the check is never followed, the copy is checked last', async () => {
    const { freshTauriCli, checkTauriCliDir } = await bundleModule();
    const pins = pinsFor(FILES);
    const base = dir('fresh-own');
    // The folder check passes, then a file is changed: the bytes read for the copy are checked themselves.
    const changed = layOut();
    const thenChange = () => writeFileSync(join(changed, 'node_modules/@tauri-apps/cli/tauri.js'), 'stealKeys()');
    // (The copy's own check stood in for too: only the read can catch it.)
    expect(() => freshTauriCli(changed, pins, base, { check: (d: string) => (d === changed ? thenChange() : null) })).toThrow(/node_modules\/@tauri-apps\/cli\/tauri\.js is not its pinned sha512/);
    expect(readdirSync(base)).toEqual([]);
    // The folder check passes, then a file is swapped for a link to the very same bytes: refused, not followed.
    const swapped = layOut();
    const same = join(dir('elsewhere'), 'tauri.js');
    writeFileSync(same, FILES['@tauri-apps/cli']['tauri.js']);
    const thenSwap = () => {
      rmSync(join(swapped, 'node_modules/@tauri-apps/cli/tauri.js'));
      symlinkSync(same, join(swapped, 'node_modules/@tauri-apps/cli/tauri.js'));
    };
    expect(() => freshTauriCli(swapped, pins, base, { check: (d: string) => (d === swapped ? thenSwap() : null) })).toThrow(/node_modules\/@tauri-apps\/cli\/tauri\.js is a link, not a file/);
    expect(readdirSync(base)).toEqual([]);
    // The check runs on the handed folder first, on the copy last (its result is the copy's tauri.js).
    const seen: string[] = [];
    const ok = layOut();
    const fresh = freshTauriCli(ok, pins, base, { check: (d: string, p: unknown) => (seen.push(d), checkTauriCliDir(d, p)) });
    expect(seen).toEqual([ok, fresh.root]);
    expect(fresh.cliJs).toBe(join(fresh.root, 'node_modules', '@tauri-apps', 'cli', 'tauri.js'));
    rmSync(fresh.root, { recursive: true, force: true });
    // A copy the last check refuses is removed.
    expect(() => freshTauriCli(ok, pins, base, { check: (d: string, p: unknown) => (d === ok ? checkTauriCliDir(d, p) : (() => { throw new Error('copy refused'); })()) })).toThrow(/copy refused/);
    expect(readdirSync(base)).toEqual([]);
  });
});

describe('tarMembers: the build job\'s archive read strictly, as tar walks it', () => {
  it('reads what tar writes — long names through pax headers and the ustar prefix, links with their targets — as tar lists it', async () => {
    const { tarMembers } = await releaseModule();
    const src = dir('real-tar');
    const deep = `app/Retake.app/Contents/${'a'.repeat(120)}/${'b'.repeat(90)}`;
    put(src, deep, 'deep');
    put(src, `app/Retake.app/Contents/${'c'.repeat(60)}/${'d'.repeat(60)}/e.txt`, 'prefix');
    put(src, 'app/Retake.app/Contents/Frameworks/X.framework/Versions/A/X', 'x');
    symlinkSync('A', join(src, 'app/Retake.app/Contents/Frameworks/X.framework/Versions/Current'));
    put(src, 'tauri-cli/node_modules/@tauri-apps/cli/tauri.js', 'cli');
    const f = join(dir('real-tar-out'), 'a.tar');
    expect(spawnSync('/usr/bin/tar', ['--no-mac-metadata', '--no-xattrs', '-cf', f, '-C', src, 'app', 'tauri-cli']).status).toBe(0);
    const members = tarMembers(readFileSync(f));
    const listed = spawnSync('/usr/bin/tar', ['-tf', f], { encoding: 'utf8' }).stdout.trim().split('\n');
    expect(members.map((m: any) => m.name)).toEqual(listed);
    expect(members.find((m: any) => m.name === deep)).toEqual({ name: deep, type: 'file', link: null, size: 4 });
    expect(members.find((m: any) => m.name.endsWith('Versions/Current'))).toMatchObject({ type: 'link', link: 'A', size: 0 });
    expect(members.filter((m: any) => m.type === 'dir').length).toBeGreaterThan(5);
  });

  it('anything tar would read otherwise, or that is not a file, folder or link, is refused: a damaged header, data after the end, a GNU long name, a sparse pax record, a folder with data, an archive cut short', async () => {
    const { tarMembers } = await releaseModule();
    const cases: Array<[Buffer, RegExp]> = [
      [tarRaw([{ name: 'app/', checksum: 'damaged' }]), /a damaged header \(its checksum\) \(at byte 0\)/],
      [tarRaw([{ name: 'app/' }], { end: Buffer.concat([Buffer.alloc(1024), Buffer.from('more')]) }), /data after the end marker/],
      [tarRaw([{ name: '././@LongLink', type: 'gnu-long-name', data: 'tauri-cli/x' }, { name: 'app/' }]), /a member of type "L"/],
      [tarRaw([{ name: 'PaxHeader/x', type: 'pax', data: paxOf({ 'GNU.sparse.size': '9' }) }, { name: 'app/x', data: 'x' }]), /a pax GNU\.sparse\.size record/],
      [tarRaw([{ name: 'PaxHeader/x', type: 'pax', data: paxOf({ hdrcharset: 'BINARY' }) }, { name: 'app/x', data: 'x' }]), /a pax hdrcharset record/],
      [tarRaw([{ name: 'PaxHeader/x', type: 'pax', data: '99 path=x\n' }, { name: 'app/x', data: 'x' }]), /a damaged pax header/],
      [tarRaw([{ name: 'app/', size: 3 }]), /a dir with data \(app\/\)/],
      [tarRaw([{ name: 'app/x', data: 'x'.repeat(600) }]).subarray(0, 1024), /a member longer than the archive|no end marker/],
      [tarRaw([{ name: 'app/' }], { end: Buffer.alloc(0) }), /no end marker/],
    ];
    for (const [buf, msg] of cases) expect(() => tarMembers(buf), String(msg)).toThrow(msg);
    // A pax path names the member (tar reads it so): the name the checks see is that one, not the header's.
    const viaPax = tarMembers(tarRaw([{ name: 'PaxHeader/x', type: 'pax', data: paxOf({ path: 'node_modules/x.js' }) }, { name: 'app/x.js', data: 'x' }]));
    expect(viaPax).toEqual([{ name: 'node_modules/x.js', type: 'file', link: null, size: 1 }]);
    expect(tarMembers(tarRaw([{ name: 'a', type: 'hardlink', link: 'b' }, { name: 'c', type: 'char' }, { name: 'd', type: 'fifo' }])).map((m: any) => m.type)).toEqual(['hardlink', 'device', 'fifo']);
  });
});

describe.runIf(MAC)('unpackBuild: the build job\'s archive, only its two parts (release.mjs unpack)', () => {
  const archive = (members: Member[] | Buffer) => {
    const f = join(dir('archive'), 'retake-app.tar.gz');
    writeFileSync(f, Buffer.isBuffer(members) ? gzipSync(members) : tarOf(members));
    return f;
  };
  it('the build\'s archive: app/Retake.app (its links kept) and tauri-cli — nothing else in the folder', async () => {
    const { unpackBuild } = await releaseModule();
    const into = join(dir('unpack'), 'adhoc');
    const parts = unpackBuild(archive(BUILD), into);
    expect(parts).toEqual({ app: join(into, 'app', 'Retake.app'), tauriCli: join(into, 'tauri-cli') });
    expect(readdirSync(into).sort()).toEqual(['app', 'tauri-cli']);
    expect(readdirSync(join(into, 'app'))).toEqual(['Retake.app']);
    expect(readFileSync(join(into, 'app/Retake.app/Contents/Info.plist'), 'utf8')).toBe('<plist/>');
    expect(lstatSync(join(into, 'app/Retake.app/Contents/Frameworks/Current')).isSymbolicLink()).toBe(true);
    // The folder the workflow made by hand before is fine empty; one holding anything is refused, left as it is.
    const empty = dir('empty');
    expect(unpackBuild(archive(BUILD), empty).app).toBe(join(empty, 'app', 'Retake.app'));
    const busy = dir('busy');
    writeFileSync(join(busy, 'mine.txt'), 'mine');
    expect(() => unpackBuild(archive(BUILD), busy)).toThrow(/an empty folder of its own/);
    expect(readdirSync(busy)).toEqual(['mine.txt']);
  });

  it('any other member refuses the whole archive before anything is written: node_modules beside the parts, another file, a second app, the report, .., absolute names, AppleDouble names, hard links, devices, fifos, a name given twice; a missing part too', async () => {
    const { unpackBuild } = await releaseModule();
    const cases: Array<[Member[] | Buffer, RegExp]> = [
      [[...BUILD, { name: 'node_modules/' }, { name: 'node_modules/@tauri-apps/cli-darwin-universal/index.js', data: 'stealKeys()' }], /"node_modules\/" \(not a part of the build/],
      [[...BUILD, { name: 'run.sh', data: 'x' }], /"run\.sh" \(not a part of the build/],
      [[...BUILD, { name: 'bundle-report.json', data: '{}' }], /"bundle-report\.json" \(not a part of the build/],
      [[...BUILD, { name: 'app/Other.app/' }], /"app\/Other\.app\/" \(not a part of the build/],
      [[...BUILD, { name: 'tauri-cli/../node_modules/x.js', data: 'x' }], /\(an empty, \. or \.\. part\)/],
      [[...BUILD, { name: '../outside.txt', data: 'x' }], /"\.\.\/outside\.txt" \(an empty, \. or \.\. part\)/],
      [[...BUILD, { name: '/tmp/outside.txt', data: 'x' }], /\(an empty or absolute name\)/],
      [[...BUILD, { name: './app/Retake.app/x', data: 'x' }], /\(an empty, \. or \.\. part\)/],
      [[...BUILD, { name: 'tauri-cli/node_modules/@tauri-apps/cli/._tauri.js', data: 'metadata' }], /"tauri-cli\/node_modules\/@tauri-apps\/cli\/\._tauri\.js" \(an AppleDouble name\)/],
      [[...BUILD, { name: 'app/Retake.app/Contents/x', type: 'hardlink', link: 'app/Retake.app/Contents/Info.plist' }], /"app\/Retake\.app\/Contents\/x" \(a hardlink \(only files, folders and links inside the app\)\)/],
      [[...BUILD, { name: 'app/Retake.app/Contents/tty', type: 'char' }], /\(a device \(only files, folders and links inside the app\)\)/],
      [[...BUILD, { name: 'app/Retake.app/Contents/pipe', type: 'fifo' }], /\(a fifo /],
      [[...BUILD, { name: 'app/Retake.app/Contents/Info.plist', data: 'again' }], /"app\/Retake\.app\/Contents\/Info\.plist" \(a name given twice\)/],
      [tarRaw([...BUILD, { name: 'PaxHeader/x', type: 'pax', data: paxOf({ path: 'node_modules/x.js' }) }, { name: 'app/Retake.app/x.js', data: 'x' }]), /"node_modules\/x\.js" \(not a part of the build/],
      [tarRaw([...BUILD.slice(0, 2), { name: 'app/Retake.app/x', checksum: 'damaged', data: 'x' }, ...BUILD.slice(2)]), /is not the build job's archive: a damaged header/],
      [BUILD.filter((m) => !m.name.startsWith('tauri-cli')), /holds no tauri-cli — nothing was unpacked/],
      [BUILD.filter((m) => m.name !== 'app/Retake.app/'), /holds no app\/Retake\.app — nothing was unpacked/],
    ];
    for (const [members, msg] of cases) {
      const into = join(dir('refused'), 'adhoc');
      expect(() => unpackBuild(archive(members), into), String(msg)).toThrow(msg);
      expect(existsSync(into), String(msg)).toBe(false);
    }
  });

  it('links: a part that is a link is refused before anything is written; so is a link in the app to an absolute path or out of it, and any link in the Tauri CLI', async () => {
    const { unpackBuild } = await releaseModule();
    const cases: Array<[Member[], RegExp]> = [
      [[...BUILD.filter((m) => !m.name.startsWith('tauri-cli')), { name: 'tauri-cli', type: 'link', link: 'app/Retake.app/Contents' }], /"tauri-cli" \(a link, not a folder\)/],
      [[{ name: 'app', type: 'link', link: '../elsewhere' }, ...BUILD.filter((m) => m.name !== 'app/')], /"app" \(a link, not a folder\)/],
      [[{ name: 'app/' }, { name: 'app/Retake.app', type: 'link', link: '/Applications/Retake.app' }, ...BUILD.filter((m) => !m.name.startsWith('app'))], /"app\/Retake\.app" \(a link, not a folder\)/],
      [[...BUILD, { name: 'app/Retake.app/Contents/key', type: 'link', link: '/runner/temp/signing/updater.key' }], /\(a link to an absolute path \("\/runner\/temp\/signing\/updater\.key"\)\)/],
      [[...BUILD, { name: 'app/Retake.app/Contents/up', type: 'link', link: '../../../signing' }], /\(a link out of Retake\.app \("\.\.\/\.\.\/\.\.\/signing"\)\)/],
      [[...BUILD, { name: 'app/Retake.app/Contents/self', type: 'link', link: '../../Retake.app2' }], /a link out of Retake\.app/],
      [[...BUILD, { name: 'tauri-cli/node_modules/x', type: 'link', link: '../../app' }], /"tauri-cli\/node_modules\/x" \(a link \(only files, folders\)\)/],
    ];
    for (const [members, msg] of cases) {
      const into = join(dir('linked'), 'adhoc');
      expect(() => unpackBuild(archive(members), into), String(msg)).toThrow(msg);
      expect(existsSync(into), String(msg)).toBe(false);
    }
    // A link inside the app, to a file of the app: kept.
    const ok = join(dir('linked'), 'adhoc');
    unpackBuild(archive([...BUILD, { name: 'app/Retake.app/Contents/Info-link', type: 'link', link: 'Info.plist' }]), ok);
    expect(readFileSync(join(ok, 'app/Retake.app/Contents/Info-link'), 'utf8')).toBe('<plist/>');
  });

  it('whatever tar writes, the folder is then checked: exactly the two parts, real folders, every link of the app resolving inside it — or nothing of the archive is left', async () => {
    const { unpackBuild } = await releaseModule();
    /** A tar that unpacks, then does `after` in the folder it unpacked into (its -C). */
    const tarThen = (after: string) => join(fakeTools({ tar: `/usr/bin/tar "$@" || exit $?\nfor a; do [ "\${prev:-}" = -C ] && d=$a; prev=$a; done\ncd "$d" || exit 1\n${after}\nexit 0` }).bin, 'tar');
    const cases: Array<[string, RegExp]> = [
      ['mkdir node_modules', /holds app, node_modules, tauri-cli once unpacked, not app, tauri-cli/],
      ['mv app/Retake.app app/Real.app && ln -s Real.app app/Retake.app', /holds Real\.app, Retake\.app, not Retake\.app alone/],
      ['mv app real-app && ln -s real-app app', /holds app, real-app, tauri-cli once unpacked/],
      ['mv tauri-cli ../cli && ln -s ../cli tauri-cli', /tauri-cli is a link, not a real folder/],
      ['mv app/Retake.app ../Real.app && ln -s ../../Real.app app/Retake.app', /app\/Retake\.app is a link, not a real folder/],
      ['ln -s /etc/hosts app/Retake.app/Contents/hosts', /app\/Retake\.app\/Contents\/hosts links out of Retake\.app \(\/etc\/hosts\)/],
      ['mkdir ../outside && ln -s ../../../outside app/Retake.app/Contents/out', /Contents\/out links out of Retake\.app/],
      // Inside the app as written (D/../../tauri-cli from Contents is Retake.app/tauri-cli), out of it once D is followed.
      ['ln -s .. app/Retake.app/Contents/D && ln -s D/../../tauri-cli app/Retake.app/Contents/L1', /app\/Retake\.app\/Contents\/L1 links out of Retake\.app \(D\/\.\.\/\.\.\/tauri-cli\)/],
    ];
    for (const [after, msg] of cases) {
      const into = join(dir('after'), 'adhoc');
      expect(() => unpackBuild(archive(BUILD), into, { tar: tarThen(after) }), after).toThrow(msg);
      expect(existsSync(into), after).toBe(false);
    }
    // tar reads the very bytes read here (its standard input, never the file again) and writes no metadata of the archive.
    const tools = fakeTools({ tar: 'exec /usr/bin/tar "$@"' });
    const into = join(dir('after'), 'adhoc');
    unpackBuild(archive(BUILD), into, { tar: join(tools.bin, 'tar') });
    expect(tools.calls()).toEqual([`tar -x -f - --no-mac-metadata --no-xattrs --no-acls --no-fflags -C ${into} app/Retake.app tauri-cli`]);
  });

  it('buildMemberProblem: the names of the parts only; the command line: unpack <archive> --into <dir>', async () => {
    const { buildMemberProblem } = await releaseModule();
    for (const ok of ['app', 'app/', 'app/Retake.app', 'app/Retake.app/', 'app/Retake.app/Contents/MacOS/retake-desktop', 'tauri-cli/', 'tauri-cli/node_modules/@tauri-apps/cli/tauri.js']) expect(buildMemberProblem(ok), ok).toBeNull();
    for (const bad of ['', '/', '/app', 'node_modules', 'node_modules/x', 'app/Retake.app2', 'app/x', 'app//Retake.app', 'app/./Retake.app', 'tauri-cli/../x', '..', './tauri-cli', 'bundle-report.json', 'Retake.app', '._app', 'app/Retake.app/._Contents']) expect(buildMemberProblem(bad), bad).not.toBeNull();
    const run = (...args: string[]) => spawnSync(process.execPath, [RELEASE, ...args], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: tmp } });
    const into = join(dir('cli-unpack'), 'adhoc');
    const ok = run('unpack', archive(BUILD), '--into', into);
    expect(ok.status, ok.stderr).toBe(0);
    expect(JSON.parse(ok.stdout).app).toBe(join(into, 'app', 'Retake.app'));
    const bad = run('unpack', archive([...BUILD, { name: 'node_modules/' }]), '--into', join(dir('cli-unpack'), 'adhoc'));
    expect(bad.status).toBe(1);
    expect(bad.stderr).toMatch(/^release: \S+ is not the build job's archive: "node_modules\/" \(not a part of the build .* — nothing was unpacked\n$/);
    const notGzip = join(dir('cli-unpack'), 'x.tar.gz');
    writeFileSync(notGzip, 'secret-canary words');
    const unreadable = run('unpack', notGzip, '--into', join(dir('cli-unpack'), 'adhoc'));
    expect(unreadable.stderr).toMatch(/^release: \S+: not a readable archive \(Z_DATA_ERROR\)\n$/);
    for (const args of [['unpack'], ['unpack', 'a.tar.gz'], ['unpack', 'a.tar.gz', '--to', 'x'], ['unpack', '--into', 'x', 'a']]) {
      const r = run(...args);
      expect(r.status, args.join(' ')).toBe(1);
      expect(r.stderr, args.join(' ')).toMatch(/^release: usage: release\.mjs unpack <archive> --into <dir>\n$/);
    }
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

  it('bundle.json\'s version (it names the DMG) must be a version and the app\'s own — Info.plist\'s, so --app-version\'s — or nothing is signed', async () => {
    const { finishApp } = await releaseModule();
    const withManifestApp = (v: unknown, plist = '0.2.0') => {
      const m = miniApp({ version: plist });
      const f = join(m.app, 'Contents', 'Resources', 'bundle.json');
      writeFileSync(f, JSON.stringify({ ...JSON.parse(readFileSync(f, 'utf8')), app: v }));
      return m;
    };
    const tools = fakeTools({ codesign: 'exit 0', xcrun: 'exit 1', hdiutil: 'exit 1' });
    const recorded = { ...env, PATH: `${tools.bin}:/usr/bin:/bin` };
    // Another version than Info.plist's, with --app-version (the sign job) or with a DMG to name: refused first.
    expect(() => finishApp({ app: withManifestApp('0.1.9').app, out: dir('out'), mode: 'dry', env: recorded, entries: NODE_ENTRY, dmg: false, verified: true, appVersion: '0.2.0' })).toThrow(/bundle\.json says version 0\.1\.9, Info\.plist 0\.2\.0: not one build — nothing was signed/);
    expect(() => finishApp({ app: withManifestApp('0.1.9').app, out: dir('out'), mode: 'dry', env: recorded, entries: NODE_ENTRY, verified: true })).toThrow(/bundle\.json says version 0\.1\.9, Info\.plist 0\.2\.0/);
    for (const bad of ['../x', '0.2.0/../../x', '', null, 2]) {
      const m = withManifestApp(bad, typeof bad === 'string' && bad ? bad : '0.2.0');
      expect(() => finishApp({ app: m.app, out: dir('out'), mode: 'dry', env: recorded, entries: NODE_ENTRY, verified: true }), String(bad)).toThrow(/bundle\.json's app is not a version .* — nothing was signed/);
    }
    // Nothing ran: no signature, no DMG.
    expect(tools.calls()).toEqual([]);
    // Without either (a build with no DMG, no --app-version): a version is enough.
    expect(finishApp({ app: withManifestApp('0.1.9').app, out: dir('out'), mode: 'dry', env, entries: NODE_ENTRY, dmg: false, verified: true }).version).toBe('0.2.0');
  });

  it('bundle.json and launch.json are read as JSON whose words are never repeated; bundle.json\'s paths stay inside Resources (no .., no absolute path, no link out) — or nothing is signed', async () => {
    const { finishApp } = await releaseModule();
    const tools = fakeTools({ codesign: 'exit 0', xattr: 'exit 0' });
    const recorded = { ...env, PATH: `${tools.bin}:/usr/bin:/bin` };
    const finish = (app: string) => () => finishApp({ app, out: dir('out'), mode: 'dry', env: recorded, entries: NODE_ENTRY, dmg: false, verified: true });
    for (const f of ['bundle.json', 'launch.json']) {
      const { app } = miniApp();
      writeFileSync(join(app, 'Contents', 'Resources', f), 'secret-canary {');
      expect(finish(app)).toThrow(new RegExp(`Contents/Resources/${f.replace('.', '\\.')} is not JSON — nothing was signed$`));
      try {
        finish(app)();
      } catch (e) {
        expect((e as Error).message).not.toMatch(/canary/);
      }
    }
    const withPaths = (paths: Record<string, unknown>, extra: (res: string) => void = () => {}) => {
      const m = miniApp();
      const res = join(m.app, 'Contents', 'Resources');
      writeFileSync(join(res, 'bundle.json'), JSON.stringify({ v: 1, app: '0.2.0', paths, sha256: {} }));
      extra(res);
      return m.app;
    };
    const outside = dir('outside');
    writeFileSync(join(outside, 'node'), 'not ours');
    const cases: Array<[string, RegExp]> = [
      [withPaths({ node: '../../MacOS/retake-desktop', ffmpeg: null }), /paths\.node is not a relative path inside the folder \("\.\.\/\.\.\/MacOS\/retake-desktop"\)/],
      [withPaths({ node: '/usr/bin/true', ffmpeg: null }), /paths\.node is not a relative path inside the folder/],
      [withPaths({ node: 'node/./bin/node', ffmpeg: null }), /paths\.node is not a relative path inside the folder/],
      [withPaths({ node: 'node/bin/node', ffmpeg: '../x' }), /paths\.ffmpeg is not a relative path inside the folder/],
      [withPaths({ node: 'node/bin/node' }), /paths\.ffmpeg is not a relative path inside the folder/],
      [withPaths({ node: 'node/bin/elsewhere', ffmpeg: null }, (res) => symlinkSync(join(outside, 'node'), join(res, 'node', 'bin', 'elsewhere'))), /paths\.node \(node\/bin\/elsewhere\) leads out of the folder/],
      // Inside as written, out once its links are followed (the system's realpath, not a lexical one).
      [withPaths({ node: 'up/../node', ffmpeg: null }, (res) => symlinkSync(outside, join(res, 'up'))), /paths\.node is not a relative path/],
      [withPaths({ node: 'node/bin/hop/node', ffmpeg: null }, (res) => (symlinkSync('../..', join(res, 'node', 'bin', 'up')), symlinkSync(`up/../${relative(dirname(res), outside)}`, join(res, 'node', 'bin', 'hop')))), /paths\.node \(node\/bin\/hop\/node\) leads out of the folder/],
      [withPaths({ node: 'node/bin/none', ffmpeg: null }), /paths\.node \(node\/bin\/none\) is missing/],
    ];
    for (const [app, msg] of cases) expect(finish(app), String(msg)).toThrow(msg);
    expect(tools.calls()).toEqual([]);
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
    expect(src).toMatch(/if \(updates && key && !tauriCli\) throw new StageError\('the update archive is signed by the pinned Tauri CLI/);
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

/**
 * A stand-in Tauri CLI laid out as `bundle.mjs build` lays it out (pinned by `pins`), whose `signer sign` signs the
 * archive as the real one does (minisign, a key of its own: `pub`) and leaves, beside it, where it ran and with what
 * (`<archive>.report.json`); TAURI_SIGNING_PRIVATE_KEY=fail makes it fail. A package that tauri.js would load is
 * planted beside the handed folder.
 */
function signingCli() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const keyId = randomBytes(8);
  const pk = Buffer.from(publicKey.export({ format: 'jwk' }).x as string, 'base64url');
  const pub = Buffer.from(`untrusted comment: minisign public key: 0\n${Buffer.concat([Buffer.from('Ed'), keyId, pk]).toString('base64')}\n`).toString('base64');
  const pem = privateKey.export({ format: 'pem', type: 'pkcs8' }) as string;
  const tauriJs = `const fs = require('node:fs');
const c = require('node:crypto');
let planted = 'none';
try { planted = require('@tauri-apps/cli-darwin-universal').who; } catch {}
const archive = process.argv.at(-1);
const version = process.argv[process.argv.indexOf('--app-version') + 1];
fs.writeFileSync(archive + '.report.json', JSON.stringify({ self: __filename, home: process.env.HOME, paths: require.resolve.paths('x'), planted, argv: process.argv.slice(2), key: process.env.TAURI_SIGNING_PRIVATE_KEY }));
if (process.env.TAURI_SIGNING_PRIVATE_KEY === 'fail') { console.error('signing failed'); process.exit(3); }
const k = c.createPrivateKey(${JSON.stringify(pem)});
const id = Buffer.from('${keyId.toString('hex')}', 'hex');
const tc = 'timestamp:1\\tfile:Retake.app.tar.gz\\tversion:' + version;
const s = c.sign(null, c.createHash('blake2b512').update(fs.readFileSync(archive)).digest(), k);
const g = c.sign(null, Buffer.concat([s, Buffer.from(tc)]), k);
fs.writeFileSync(archive + '.sig', Buffer.from('untrusted comment: signature from tauri secret key\\n' + Buffer.concat([Buffer.from('ED'), id, s]).toString('base64') + '\\ntrusted comment: ' + tc + '\\n' + g.toString('base64') + '\\n').toString('base64'));
`;
  const files = { '@tauri-apps/cli': { 'tauri.js': tauriJs, 'package.json': '{"name":"@tauri-apps/cli"}' }, '@tauri-apps/cli-darwin-arm64': { 'cli.darwin-arm64.node': 'native' } };
  const handed = dir('handed');
  const cli = join(handed, 'tauri-cli');
  for (const [pkg, fs] of Object.entries(files)) for (const [f, data] of Object.entries(fs)) put(cli, `node_modules/${pkg}/${f}`, data);
  put(handed, 'node_modules/@tauri-apps/cli-darwin-universal/index.js', "exports.who = 'planted';\n");
  return { pub, pins: pinsFor(files), cli, handed };
}
type CliReport = { self: string; home: string; paths: string[]; planted: string; argv: string[]; key: string };

describe.runIf(MAC)('the update archive, signed by a fresh copy of the pinned CLI made right before and removed right after (finishApp, release.mjs sign)', () => {
  const env = { PATH: '/usr/bin:/bin', HOME: tmp };
  /** The folders above `d` where Node.js would look for a package (`<folder>/node_modules`). */
  const above = (d: string) => {
    const out: string[] = [];
    for (let x = d; ; x = dirname(x)) {
      if (!x.endsWith('/node_modules')) out.push(join(x, 'node_modules'));
      if (dirname(x) === x) return out;
    }
  };
  it('signed: the copy under tmp ran (never the handed folder, nothing planted beside it found) with HOME in the copy, its module lookup outside the copy only the folders that do not exist; gone once signed, before the DMG', async () => {
    const { finishApp } = await releaseModule();
    const c = signingCli();
    const { app } = miniApp({ updates: 'on' });
    const out = dir('out');
    const base = dir('fresh-base');
    const atUpdate: string[][] = [];
    const r = finishApp({ app, out, mode: 'dry', env: { ...env, TAURI_SIGNING_PRIVATE_KEY: 'key-canary' }, pubkey: c.pub, tauriCli: c.cli, tauriPins: c.pins, tmp: base, entries: NODE_ENTRY, dmg: false, verified: true, say: (step: string) => step === 'update' && atUpdate.push(readdirSync(base)) });
    expect(r.update.signature).toBe(join(out, 'Retake.app.tar.gz.sig'));
    const got = JSON.parse(readFileSync(join(out, 'Retake.app.tar.gz.report.json'), 'utf8')) as CliReport;
    const root = dirname(dirname(dirname(dirname(got.self))));
    expect(dirname(root)).toBe(base);
    expect(root).toMatch(/\/retake-tauri-cli-[^/]+$/);
    expect([got.home, got.planted, got.key, got.argv]).toEqual([root, 'none', 'key-canary', ['signer', 'sign', '--app-version', '0.2.0', join(out, 'Retake.app.tar.gz')]]);
    expect(got.paths.filter((p) => !p.startsWith(`${root}/`))).toEqual([...above(dirname(root)), resolve(process.execPath, '..', '..', 'lib', 'node')]);
    for (const p of got.paths) expect(p.startsWith(`${c.handed}/`), p).toBe(false);
    expect(atUpdate).toEqual([[]]);
    expect(readdirSync(base)).toEqual([]);
  });

  it('refused or failed: a folder that is not the pinned CLI before anything is made; a folder of the lookup path outside the copy before the CLI starts; a failing CLI or DMG — the copy removed every time', async () => {
    const { finishApp } = await releaseModule();
    const c = signingCli();
    const keyed = { ...env, TAURI_SIGNING_PRIVATE_KEY: 'k' };
    const base = dir('fresh-base');
    // Not the pinned CLI: refused before the update archive (or anything else) is made.
    const notCli = join(dir('o'), 'out');
    expect(() => finishApp({ app: miniApp({ updates: 'on' }).app, out: notCli, mode: 'dry', env: keyed, pubkey: c.pub, tauriCli: dir('not-cli'), tauriPins: c.pins, tmp: base, entries: NODE_ENTRY, dmg: false, verified: true })).toThrow(/is not the Tauri CLI 2\.12\.4 apps\/desktop\/bundle\/tauri-cli\.json pins/);
    expect(existsSync(notCli)).toBe(false);
    // A node_modules above the copy (where Node.js would look): refused, the CLI never started, the copy removed.
    const nest = dir('nest');
    mkdirSync(join(nest, 'node_modules'));
    const nested = join(nest, 'base');
    mkdirSync(nested);
    const out = dir('out');
    expect(() => finishApp({ app: miniApp({ updates: 'on' }).app, out, mode: 'dry', env: keyed, pubkey: c.pub, tauriCli: c.cli, tauriPins: c.pins, tmp: nested, entries: NODE_ENTRY, dmg: false, verified: true })).toThrow(new RegExp(`the Tauri CLI would look for packages in ${join(nest, 'node_modules')} \\(outside its own folder .*\\): remove it — nothing was signed`));
    expect(readdirSync(out)).toEqual(['Retake.app.tar.gz']);
    expect(readdirSync(nested)).toEqual([]);
    // The CLI fails: said, the copy removed.
    expect(() => finishApp({ app: miniApp({ updates: 'on' }).app, out: dir('out'), mode: 'dry', env: { ...env, TAURI_SIGNING_PRIVATE_KEY: 'fail' }, pubkey: c.pub, tauriCli: c.cli, tauriPins: c.pins, tmp: base, entries: NODE_ENTRY, dmg: false, verified: true })).toThrow(/tauri signer sign failed \(3\): signing failed/);
    expect(readdirSync(base)).toEqual([]);
    // Signed, then the DMG fails: the copy was gone already.
    const tools = fakeTools({ hdiutil: 'exit 1' });
    expect(() => finishApp({ app: miniApp({ updates: 'on' }).app, out: dir('out'), mode: 'dry', env: { ...keyed, PATH: `${tools.bin}:/usr/bin:/bin` }, pubkey: c.pub, tauriCli: c.cli, tauriPins: c.pins, tmp: base, entries: NODE_ENTRY, verified: true })).toThrow(/hdiutil create/);
    expect(readdirSync(base)).toEqual([]);
    // The prefix's lib/node (a global folder of the Node.js that runs the CLI): refused before it starts.
    const { signUpdateArchive } = await bundleModule();
    const prefix = dir('prefix');
    mkdirSync(join(prefix, 'lib', 'node'), { recursive: true });
    const cliRoot = dir('cli-root');
    put(cliRoot, 'node_modules/@tauri-apps/cli/tauri.js', '');
    const archive = join(dir('a'), 'Retake.app.tar.gz');
    writeFileSync(archive, 'x');
    expect(() => signUpdateArchive({ cliJs: join(cliRoot, 'node_modules/@tauri-apps/cli/tauri.js'), cliRoot, archive, version: '0.2.0', pubkey: c.pub, env: keyed, node: join(prefix, 'bin', 'node') })).toThrow(new RegExp(`would look for packages in ${join(prefix, 'lib', 'node')}`));
    expect(existsSync(`${archive}.sig`)).toBe(false);
  });

  it('release.mjs sign (signCommand): --tauri-cli checked before --out is claimed; the archive signed by a copy under tmp, removed after — and after a failure', async () => {
    const { signCommand } = await releaseModule();
    const c = signingCli();
    const base = dir('fresh-base');
    const opts = (key: string) => ({ env: { ...env, TAURI_SIGNING_PRIVATE_KEY: key, RETAKE_UPDATE_PUBKEY: c.pub }, pins: c.pins, tmp: base, finish: { entries: NODE_ENTRY, verified: true, dmg: false }, log: () => {} });
    const out = join(dir('cmd'), 'out');
    const report = signCommand(['--app', miniApp({ updates: 'on' }).app, '--out', out, '--tauri-cli', c.cli, '--app-version', '0.2.0'], opts('k'));
    expect(report.update).toMatchObject({ archive: 'Retake.app.tar.gz', signature: 'Retake.app.tar.gz.sig' });
    expect(JSON.parse(readFileSync(join(out, 'release-report.json'), 'utf8')).update.signature).toBe('Retake.app.tar.gz.sig');
    const got = JSON.parse(readFileSync(join(out, 'Retake.app.tar.gz.report.json'), 'utf8')) as CliReport;
    expect(dirname(dirname(dirname(dirname(dirname(got.self)))))).toBe(base);
    expect(readdirSync(base)).toEqual([]);
    expect(() => signCommand(['--app', miniApp({ updates: 'on' }).app, '--out', join(dir('cmd'), 'out'), '--tauri-cli', c.cli], opts('fail'))).toThrow(/tauri signer sign failed \(3\)/);
    expect(readdirSync(base)).toEqual([]);
    const unclaimed = join(dir('cmd'), 'out');
    expect(() => signCommand(['--app', miniApp({ updates: 'on' }).app, '--out', unclaimed, '--tauri-cli', dir('not-cli')], opts('k'))).toThrow(/is not the Tauri CLI 2\.12\.4/);
    expect(existsSync(unclaimed)).toBe(false);
    // The copy is made only to sign, after the app's own signature and notarisation.
    const src = readFileSync(RELEASE, 'utf8');
    expect(src.indexOf('freshTauriCli(tauriCli, tauriPins, tmp)')).toBeGreaterThan(src.indexOf('notarizeApp(s, app'));
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
    expect(existsSync(out)).toBe(false);
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
