/**
 * L5.16d — the updater's build side (apps/desktop/scripts/bundle.mjs; DESIGN §4p (d)), fast, no app built (the gated
 * end-to-end update is app-update-e2e.test.ts): the feed and the key from RETAKE_UPDATE_FEED + RETAKE_UPDATE_PUBKEY
 * only (both or neither, https, a .json feed, a real minisign key), the overlay's `plugins.updater` (signed versions,
 * no downgrade, never `dangerous*` — the e2e test's overlay alone is http on 127.0.0.1), `--features updater` for cargo
 * only then; the update archive made by us (critique H3: links kept, no AppleDouble entry, nothing outside the app)
 * and signed by the Tauri CLI with the private key given to that one command only, then checked against the key.
 */
import { spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync, sign as edSign } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { afterAll, describe, expect, it } from 'vitest';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const APP = join(REPO, 'apps', 'desktop');
const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'retake-app-update-')));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const MAC = process.platform === 'darwin';
/* eslint-disable @typescript-eslint/no-explicit-any */
const bundle = async () => (await import(pathToFileURL(join(APP, 'scripts', 'bundle.mjs')).href)) as any;

/** A test key in Tauri's format and a signer (the same format `tauri signer` writes; publish-update.test.ts checks one of the CLI's own). */
function testKey() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const keyId = createHash('sha256').update(String(Math.random())).digest().subarray(0, 8);
  const pk = Buffer.from(publicKey.export({ format: 'jwk' }).x as string, 'base64url');
  const pub = Buffer.from(`untrusted comment: minisign public key: 0\n${Buffer.concat([Buffer.from('Ed'), keyId, pk]).toString('base64')}\n`).toString('base64');
  const sig = (data: Buffer, version: string) => {
    const tc = `timestamp:1\tfile:Retake.app.tar.gz\tversion:${version}`;
    const s = edSign(null, createHash('blake2b512').update(data).digest(), privateKey);
    const g = edSign(null, Buffer.concat([s, Buffer.from(tc)]), privateKey);
    return Buffer.from(`untrusted comment: signature from tauri secret key\n${Buffer.concat([Buffer.from('ED'), keyId, s]).toString('base64')}\ntrusted comment: ${tc}\n${g.toString('base64')}\n`).toString('base64');
  };
  return { pub, sig };
}
const key = testKey();
const FEED = 'https://downloads.example.test/retake/latest.json';
let n = 0;
const dir = (name: string) => {
  const d = join(tmp, `${name}-${n++}`);
  mkdirSync(d, { recursive: true });
  return d;
};

describe('the feed and the key (build-time environment only)', () => {
  it('both or neither; https, no user / query / fragment, the .json feed itself; a real minisign public key', async () => {
    const { updaterSettings } = await bundle();
    expect(updaterSettings({})).toBeNull();
    expect(updaterSettings({ RETAKE_UPDATE_FEED: ' ', RETAKE_UPDATE_PUBKEY: '' })).toBeNull();
    expect(updaterSettings({ RETAKE_UPDATE_FEED: FEED, RETAKE_UPDATE_PUBKEY: key.pub })).toEqual({ feed: FEED, pubkey: key.pub });
    expect(() => updaterSettings({ RETAKE_UPDATE_FEED: FEED })).toThrow(/go together/);
    expect(() => updaterSettings({ RETAKE_UPDATE_PUBKEY: key.pub })).toThrow(/go together/);
    const feed = (f: string) => () => updaterSettings({ RETAKE_UPDATE_FEED: f, RETAKE_UPDATE_PUBKEY: key.pub });
    expect(feed('http://downloads.example.test/retake/latest.json')).toThrow(/must be https/);
    expect(feed('https://u:p@downloads.example.test/retake/latest.json')).toThrow(/user, a query/);
    expect(feed('https://downloads.example.test/retake/latest.json?x=1')).toThrow(/user, a query/);
    expect(feed('https://downloads.example.test/retake/')).toThrow(/feed file itself/);
    expect(feed('not a url')).toThrow(/not a URL/);
    expect(() => updaterSettings({ RETAKE_UPDATE_FEED: FEED, RETAKE_UPDATE_PUBKEY: 'bm90IGEga2V5' })).toThrow(/RETAKE_UPDATE_PUBKEY/);
    // Review d B-L3: the channel follows the version — a stable app reads latest.json, a pre-release rc.json.
    const RC = 'https://downloads.example.test/retake/rc.json';
    expect(() => updaterSettings({ RETAKE_UPDATE_FEED: RC, RETAKE_UPDATE_PUBKEY: key.pub }, '0.2.0')).toThrow(/must end in \/latest\.json for version 0\.2\.0/);
    expect(() => updaterSettings({ RETAKE_UPDATE_FEED: FEED, RETAKE_UPDATE_PUBKEY: key.pub }, '0.3.0-rc.1')).toThrow(/must end in \/rc\.json for version 0\.3\.0-rc\.1/);
    expect(updaterSettings({ RETAKE_UPDATE_FEED: RC, RETAKE_UPDATE_PUBKEY: key.pub }, '0.3.0-rc.1')).toEqual({ feed: RC, pubkey: key.pub });
    expect(() => updaterSettings({ RETAKE_UPDATE_FEED: 'https://downloads.example.test/retake/beta.json', RETAKE_UPDATE_PUBKEY: key.pub })).toThrow(/must end in \/latest\.json/);
    // By default the version is the app's own (tauri.conf.json).
    expect(updaterSettings({ RETAKE_UPDATE_FEED: FEED, RETAKE_UPDATE_PUBKEY: key.pub })).toEqual({ feed: FEED, pubkey: key.pub });
  });

  it('the overlay: signed versions, no downgrade, the one feed — never dangerous*; the test overlay alone is http on 127.0.0.1', async () => {
    const { updaterOverlay, testUpdaterOverlay } = await bundle();
    const o = updaterOverlay({ feed: FEED, pubkey: key.pub });
    expect(o).toEqual({ plugins: { updater: { pubkey: key.pub, endpoints: [FEED], requireSignedVersion: true, allowDowngrades: false } } });
    expect(JSON.stringify(o)).not.toMatch(/dangerous/i);
    expect(() => updaterOverlay({ feed: 'http://downloads.example.test/retake/latest.json', pubkey: key.pub })).toThrow(/https/);
    const t = testUpdaterOverlay({ port: 4990, pubkey: key.pub, version: '0.2.1' });
    expect(t).toEqual({ version: '0.2.1', plugins: { updater: { pubkey: key.pub, endpoints: ['http://127.0.0.1:4990/retake/latest.json'], requireSignedVersion: true, allowDowngrades: false, dangerousInsecureTransportProtocol: true } } });
    expect(() => testUpdaterOverlay({ port: 80, pubkey: key.pub })).toThrow(/port/);
    // Only the gated test uses the test overlay; the command line has no way to it.
    const src = readFileSync(join(APP, 'scripts', 'bundle.mjs'), 'utf8');
    expect([...src.matchAll(/dangerousInsecureTransportProtocol/g)].length).toBe(1);
    expect(src).toMatch(/const report = build\(\{ out: flag\('--out'\) \?\? process\.env\.RETAKE_BUNDLE_OUT, mode: [^}]*\}\);/);
    expect(/const report = build\(\{[^}]*\}\);/.exec(src)?.[0]).not.toMatch(/updater|dmg/);
    for (const f of readdirSync(join(REPO, 'packages', 'cli', 'test'))) {
      if (f.endsWith('.ts') && f !== 'app-update.test.ts' && f !== 'app-update-e2e.test.ts') expect(readFileSync(join(REPO, 'packages', 'cli', 'test', f), 'utf8'), f).not.toContain('testUpdaterOverlay');
    }
  });

  it('cargo gets --features updater only when the build has a feed and a key', async () => {
    const { tauriBuildArgs } = await bundle();
    expect(tauriBuildArgs('/o.json', true, ['updater'])).toEqual(['build', '--bundles', 'app', '--no-sign', '--ci', '--config', '/o.json', '--features', 'updater', '--', '--locked', '--offline']);
    expect(tauriBuildArgs('/o.json', false)).toEqual(['build', '--bundles', 'app', '--no-sign', '--ci', '--config', '/o.json', '--', '--locked']);
    const src = readFileSync(join(APP, 'scripts', 'bundle.mjs'), 'utf8');
    expect(src).toContain("built = tauriBuild({ cliJs, overlay, targetDir: ownTarget, env, offline, features: updates ? ['updater'] : [] });");
  });

  it('a build given one variable alone refuses before anything is made (the --out folder stays empty)', async () => {
    const { build } = await bundle();
    const out = dir('out');
    expect(() => build({ out, env: { PATH: '/usr/bin:/bin', HOME: tmp, RETAKE_UPDATE_FEED: FEED } })).toThrow(/go together/);
    expect(() => build({ out, env: { PATH: '/usr/bin:/bin', HOME: tmp, RETAKE_UPDATE_FEED: 'http://downloads.example.test/retake/latest.json', RETAKE_UPDATE_PUBKEY: key.pub } })).toThrow(/must be https/);
    expect(readdirSync(out)).toEqual([]);
  });
});

/** A small app tree with links like Chromium's framework (versioned, Current, top-level links). */
function miniApp(): string {
  const root = dir('app');
  const app = join(root, 'Retake.app');
  const fw = join(app, 'Contents', 'Resources', 'browsers', 'Chromium.app', 'Contents', 'Frameworks', 'X.framework');
  mkdirSync(join(fw, 'Versions', 'A', 'Resources'), { recursive: true });
  writeFileSync(join(fw, 'Versions', 'A', 'X'), 'binary');
  writeFileSync(join(fw, 'Versions', 'A', 'Resources', 'Info.plist'), '<plist/>');
  symlinkSync('A', join(fw, 'Versions', 'Current'));
  symlinkSync('Versions/Current/X', join(fw, 'X'));
  symlinkSync('Versions/Current/Resources', join(fw, 'Resources'));
  mkdirSync(join(app, 'Contents', 'MacOS'), { recursive: true });
  writeFileSync(join(app, 'Contents', 'MacOS', 'retake-desktop'), 'shell');
  writeFileSync(join(app, 'Contents', 'Resources', 'with space.txt'), 'x');
  return app;
}

describe.skipIf(!MAC)('the update archive (critique H3)', () => {
  it('made with /usr/bin/tar and COPYFILE_DISABLE: every link kept, no AppleDouble entry, everything under Retake.app/; extracted as the plugin does it equals the app', async () => {
    const { makeUpdateArchive, linkCount, treeDigest } = await bundle();
    const app = miniApp();
    // An extended attribute that macOS tar would turn into a ._ entry without COPYFILE_DISABLE.
    expect(spawnSync('xattr', ['-w', 'com.example.test', 'x', join(app, 'Contents', 'Resources', 'with space.txt')]).status).toBe(0);
    const out = dir('archive');
    const archive = makeUpdateArchive(app, out);
    expect(archive).toBe(join(out, 'Retake.app.tar.gz'));
    const listing = spawnSync('/usr/bin/tar', ['-tvzf', archive], { encoding: 'utf8' }).stdout;
    expect(listing.split('\n').filter((l) => l.startsWith('l')).length).toBe(3);
    expect(linkCount(app)).toBe(3);
    expect(listing).not.toMatch(/\/\._|^\._/m);
    // No extended attribute travels either (macOS 26's bsdtar writes them as pax headers unless told not to).
    expect(gunzipSync(readFileSync(archive)).toString('latin1')).not.toMatch(/LIBARCHIVE\.xattr|SCHILY\.xattr|com\.example\.test/);
    // The plugin skips the first path component and unpacks into a fresh folder that becomes the app.
    const x = join(dir('extract'), 'Retake.app');
    mkdirSync(x);
    expect(spawnSync('/usr/bin/tar', ['-xzf', archive, '-C', x, '--strip-components', '1']).status).toBe(0);
    const want = treeDigest(app);
    const got = treeDigest(x);
    expect([...got.entries()]).toEqual([...want.entries()]);
  });

  it('archiveProblems: an AppleDouble entry, a path outside the app, a lost link — each caught', async () => {
    const { archiveProblems } = await bundle();
    const row = (t: string, p: string) => `${t}rwxr-xr-x  0 me     staff       0 Nov  3 21:05 ${p}`;
    const ok = [row('d', 'Retake.app/'), row('-', 'Retake.app/Contents/Resources/with space.txt'), `${row('l', 'Retake.app/X.framework/X')} -> Versions/Current/X`].join('\n');
    expect(archiveProblems(ok, 1)).toEqual([]);
    expect(archiveProblems(ok, 2)).toEqual(['1 links in the archive, 2 in the app']);
    expect(archiveProblems(`${ok}\n${row('-', 'Retake.app/Contents/._Info.plist')}`, 1)).toEqual(['Retake.app/Contents/._Info.plist: an AppleDouble entry']);
    expect(archiveProblems(`${ok}\n${row('-', '../evil')}`, 1)).toEqual(['../evil: outside Retake.app/']);
    expect(archiveProblems(`${ok}\n${row('-', 'Other.app/x')}`, 1)).toEqual(['Other.app/x: outside Retake.app/']);
    // An older date shows a year instead of a time.
    expect(archiveProblems(`-rw-r--r--  0 me staff 3 Nov  3  2025 Retake.app/old.txt`, 0)).toEqual([]);
  });

  it('signUpdateArchive: the private key reaches the signer only (a stand-in CLI dumps its environment), the signature is checked against the public key; none: unsigned', async () => {
    const { signUpdateArchive, buildEnv } = await bundle();
    const d = dir('sign');
    const archive = join(d, 'Retake.app.tar.gz');
    writeFileSync(archive, 'archive bytes');
    const dump = join(d, 'dump.json');
    const goodSig = key.sig(readFileSync(archive), '0.2.1');
    const cliJs = join(d, 'tauri.js');
    // The stand-in writes the .sig the real one would (made here with the test key) and dumps what it was given.
    writeFileSync(cliJs, `const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(dump)}, JSON.stringify({ argv: process.argv.slice(2), env: process.env })); fs.writeFileSync(process.argv.at(-1) + '.sig', process.env.SIG_FOR_TEST || ${JSON.stringify(goodSig)});\n`);
    const env = { PATH: '/usr/bin:/bin', HOME: tmp, TAURI_SIGNING_PRIVATE_KEY: 'private-key-canary', TAURI_SIGNING_PRIVATE_KEY_PASSWORD: 'password-canary', APPLE_PASSWORD: 'apple-canary', UPDATES_UPLOAD_TOKEN: 'upload-canary' };
    expect(signUpdateArchive({ cliJs, archive, version: '0.2.1', pubkey: key.pub, env })).toBe(`${archive}.sig`);
    const got = JSON.parse(readFileSync(dump, 'utf8'));
    expect(got.argv).toEqual(['signer', 'sign', '--app-version', '0.2.1', archive]);
    expect(got.env.TAURI_SIGNING_PRIVATE_KEY).toBe('private-key-canary');
    expect(got.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD).toBe('password-canary');
    expect(JSON.stringify(got.env)).not.toMatch(/apple-canary|upload-canary/);
    // Every other child of a build gets buildEnv: no signing key.
    expect(JSON.stringify(buildEnv(env))).not.toMatch(/canary/);
    // A key file's path works too (its text is passed).
    writeFileSync(join(d, 'test.key'), 'key-file-canary\n');
    signUpdateArchive({ cliJs, archive, version: '0.2.1', pubkey: key.pub, env: { ...env, TAURI_SIGNING_PRIVATE_KEY: join(d, 'test.key') } });
    expect(JSON.parse(readFileSync(dump, 'utf8')).env.TAURI_SIGNING_PRIVATE_KEY).toBe('key-file-canary');
    // A signature for another version (or another key) is refused; no key: unsigned (null), the CLI never started.
    expect(() => signUpdateArchive({ cliJs, archive, version: '0.2.2', pubkey: key.pub, env })).toThrow(/does not check against RETAKE_UPDATE_PUBKEY: the archive was signed for version 0\.2\.1/);
    expect(() => signUpdateArchive({ cliJs, archive, version: '0.2.1', pubkey: testKey().pub, env })).toThrow(/another key/);
    rmSync(dump);
    expect(signUpdateArchive({ cliJs, archive, version: '0.2.1', pubkey: key.pub, env: { PATH: '/usr/bin:/bin' } })).toBeNull();
    expect(existsSync(dump)).toBe(false);
  });
});
