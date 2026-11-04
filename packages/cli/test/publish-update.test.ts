/**
 * L5.16d — scripts/publish-update.mjs, the person's release step for the app's updates (DESIGN §4p (d), README
 * "Releasing"): the archive's minisign signature checked in Node before anything is uploaded (Ed25519 over the
 * BLAKE2b-512 prehash, the global signature over the trusted comment, the comment's `version:` equal to the version),
 * https only, no default host (every URL from the environment), the feed rebuilt from the platform files present (a
 * re-run heals), rc.json for every version and latest.json for stable ones, never moved back.
 * Nothing is uploaded anywhere: `publish()` gets a fetch bound to a local server on 127.0.0.1 standing in for the
 * person's host (its https URLs rewritten), and the keys are test keys made here (Node's Ed25519, and once the Tauri
 * CLI's own `signer generate` in a temp folder when the pinned CLI is in the pnpm store).
 */
import { spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync, sign as edSign } from 'node:crypto';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
// @ts-expect-error — a plain .mjs script (no types)
import * as pub from '../../../scripts/publish-update.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const base = mkdtempSync(join(tmpdir(), 'retake-publish-'));
afterAll(() => rmSync(base, { recursive: true, force: true }));

/** A test key in Tauri's format (base64 of minisign's text) and a signer of files with it. */
function testKey() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const keyId = Buffer.from(createHash('sha256').update(String(Math.random())).digest().subarray(0, 8));
  const pk = Buffer.from(publicKey.export({ format: 'jwk' }).x as string, 'base64url');
  const pubText = `untrusted comment: minisign public key: ${Buffer.from(keyId).reverse().toString('hex').toUpperCase()}\n${Buffer.concat([Buffer.from('Ed'), keyId, pk]).toString('base64')}\n`;
  const signFile = (data: Buffer, trusted: string, o: { legacy?: boolean; tamperComment?: string } = {}) => {
    const sig = edSign(null, o.legacy ? data : createHash('blake2b512').update(data).digest(), privateKey);
    const global = edSign(null, Buffer.concat([sig, Buffer.from(trusted)]), privateKey);
    const text = `untrusted comment: signature from tauri secret key\n${Buffer.concat([Buffer.from(o.legacy ? 'Ed' : 'ED'), keyId, sig]).toString('base64')}\ntrusted comment: ${o.tamperComment ?? trusted}\n${global.toString('base64')}\n`;
    return Buffer.from(text).toString('base64');
  };
  return { pub: Buffer.from(pubText).toString('base64'), signFile };
}

const key = testKey();
const other = testKey();
const archive = gzipSync(Buffer.from('a fake Retake.app tar'));
const tc = (v: string) => `timestamp:1762000000\tfile:Retake.app.tar.gz\tversion:${v}`;

/** The stand-in for the person's update host: PUT with the bearer token, GET (404 when absent). */
let server: Server;
let origin = '';
const store = new Map<string, { body: Buffer; type: string }>();
const requests: string[] = [];
beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      requests.push(`${req.method} ${req.url}`);
      if (req.headers.authorization !== 'Bearer test-token') return void res.writeHead(401).end();
      const path = decodeURIComponent((req.url ?? '/').slice(1));
      if (req.method === 'PUT') {
        store.set(path, { body: Buffer.concat(chunks), type: String(req.headers['content-type']) });
        return void res.writeHead(201).end();
      }
      const f = store.get(path);
      if (!f) return void res.writeHead(404).end();
      res.writeHead(200, { 'content-type': f.type }).end(f.body);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const a = server.address();
  origin = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => {
  store.clear();
  requests.length = 0;
});

/** The script's https upload URL, served by the local stand-in. */
const fetchLocal = (url: string, init?: RequestInit) => fetch(url.replace('https://upload.example.test/base', origin), init);
const env = (over: Record<string, string | undefined> = {}) => ({
  UPDATES_UPLOAD_TOKEN: 'test-token',
  UPDATES_UPLOAD_URL: 'https://upload.example.test/base/',
  UPDATES_PUBLIC_URL: 'https://downloads.example.test/',
  RETAKE_UPDATE_PUBKEY: key.pub,
  ...over,
});
function files(version: string, o: { sig?: string; data?: Buffer } = {}) {
  const dir = mkdtempSync(join(base, 'rel-'));
  const artifact = join(dir, 'Retake.app.tar.gz');
  writeFileSync(artifact, o.data ?? archive);
  writeFileSync(`${artifact}.sig`, o.sig ?? key.signFile(archive, tc(version)));
  return { version, artifact, signature: `${artifact}.sig`, platforms: ['darwin-aarch64'], notes: null };
}
const changelog = join(base, 'CHANGELOG.md');
writeFileSync(changelog, '# Changelog\n\n## [0.2.1] — 2026-11-10\n\nFaster renders and a **clearer** `doctor`.\n\n### Fixed\n- **A thing.** Details.\n');
const run = (args: ReturnType<typeof files>, over: Record<string, string | undefined> = {}) => pub.publish({ args, env: env(over), fetchImpl: fetchLocal, changelog, now: () => new Date('2026-11-10T12:00:00Z') });
const json = (path: string) => JSON.parse(store.get(path)!.body.toString('utf8'));

describe('versions, notes, the feed', () => {
  it('semver precedence: a release is newer than its pre-releases; garbage does not parse', () => {
    expect(['0.2.0', '0.2.0-rc.10', '0.10.0', '0.2.0-rc.2', '0.2.1-rc.1'].sort(pub.compareVersions)).toEqual(['0.2.0-rc.2', '0.2.0-rc.10', '0.2.0', '0.2.1-rc.1', '0.10.0']);
    for (const bad of ['v0.2.1', '0.2', 'latest', '', undefined, `0.2.1-${'a'.repeat(64)}`]) expect(pub.parseVersion(bad), String(bad)).toBeNull();
    expect(() => pub.compareVersions('0.2.0', 'soon')).toThrow(/cannot compare/);
  });

  it('release notes: the summary paragraph as plain text, else the bullets\' leads; the repository\'s CHANGELOG has one for 0.2.0', () => {
    expect(pub.extractNotes(readFileSync(changelog, 'utf8'), '0.2.1')).toBe('Faster renders and a clearer doctor.');
    expect(pub.extractNotes('## [0.3.0]\n\n### Fixed\n- **One.** x\n- two: y\n', '0.3.0')).toBe('• One\n• two');
    expect(pub.extractNotes('## [0.2.1]\n', '0.2.10')).toBeNull();
    expect(pub.extractNotes('## [0x2x1]\n\nNo.', '0.2.1')).toBeNull();
    const ours = pub.extractNotes(readFileSync(join(REPO, 'CHANGELOG.md'), 'utf8'), '0.2.0');
    expect(ours).toMatch(/^The first installable version/);
    expect(ours).not.toMatch(/\*\*|`|^- /m);
  });

  it('https only, no user, query or fragment; no default host', () => {
    expect(pub.checkUrl('https://downloads.example.test/a/', 'X')).toBe('https://downloads.example.test/a');
    expect(() => pub.checkUrl('http://downloads.example.test', 'X')).toThrow(/must be https/);
    expect(() => pub.checkUrl('https://u:p@downloads.example.test', 'X')).toThrow(/user, a query/);
    expect(() => pub.checkUrl('https://downloads.example.test/?t=1', 'X')).toThrow(/user, a query/);
    expect(() => pub.checkUrl('', 'X')).toThrow(/not a URL/);
    for (const v of ['UPDATES_UPLOAD_TOKEN', 'UPDATES_UPLOAD_URL', 'UPDATES_PUBLIC_URL', 'RETAKE_UPDATE_PUBKEY']) expect(() => pub.settings(env({ [v]: undefined })), v).toThrow(new RegExp(`${v} is not set`));
    expect(pub.settings(env()).app).toBe('retake');
    expect(() => pub.settings(env({ UPDATES_APP: '../etc' }))).toThrow(/not a folder name/);
    expect(readFileSync(join(REPO, 'scripts', 'publish-update.mjs'), 'utf8')).not.toMatch(/\?\? ['"]https?:/);
  });

  it('arguments: the version first, the default platform, an unknown flag refused', () => {
    expect(pub.parseArgs(['0.2.1', '--artifact', 'a', '--signature', 'a.sig'])).toEqual({ version: '0.2.1', platforms: ['darwin-aarch64'], artifact: 'a', signature: 'a.sig', notes: null, force: false });
    expect(pub.parseArgs(['0.2.1', '--force', '--artifact', 'a', '--signature', 'a.sig']).force).toBe(true);
    expect(() => pub.parseArgs(['0.2.1', '--upload-to', 'x'])).toThrow(/unknown argument/);
  });
});

describe('the signature, checked in Node before anything is uploaded', () => {
  it('good: prehashed (tauri signer) and legacy; refused: a changed archive, another key, another version, no version, a forged comment', () => {
    const sig = key.signFile(archive, tc('0.2.1'));
    expect(pub.verifyMinisign({ data: archive, signatureB64: sig, pubkeyB64: key.pub, version: '0.2.1' })).toBe(tc('0.2.1'));
    expect(() => pub.verifyMinisign({ data: archive, signatureB64: key.signFile(archive, tc('0.2.1'), { legacy: true }), pubkeyB64: key.pub, version: '0.2.1' })).not.toThrow();
    const bad = (o: Partial<{ data: Buffer; signatureB64: string; pubkeyB64: string; version: string }>, re: RegExp) =>
      expect(() => pub.verifyMinisign({ data: archive, signatureB64: sig, pubkeyB64: key.pub, version: '0.2.1', ...o })).toThrow(re);
    bad({ data: Buffer.concat([archive, Buffer.from('x')]) }, /does not match the archive/);
    bad({ pubkeyB64: other.pub }, /another key/);
    bad({ signatureB64: other.signFile(archive, tc('0.2.1')) }, /another key/);
    bad({ version: '0.2.2' }, /signed for version 0\.2\.1, not 0\.2\.2/);
    bad({ signatureB64: key.signFile(archive, 'timestamp:1\tfile:Retake.app.tar.gz') }, /carries no version/);
    bad({ signatureB64: key.signFile(archive, tc('0.2.0'), { tamperComment: tc('0.2.1') }) }, /trusted comment does not match/);
    bad({ pubkeyB64: 'bm90IGEga2V5' }, /not a minisign public key/);
    bad({ signatureB64: Buffer.from('untrusted comment: x\nAAAA\n').toString('base64') }, /not an Ed25519 minisign signature/);
  });

  it('a signature made by the pinned Tauri CLI (`signer generate` + `signer sign --app-version`) checks with its public key', async () => {
    const { tauriCli } = await import('../../../apps/desktop/scripts/bundle.mjs');
    let cliJs: string;
    try {
      cliJs = tauriCli(join(base, 'tauri-cli'));
    } catch (e) {
      console.warn(`skipped: the pinned Tauri CLI is not in the pnpm store (${(e as Error).message})`);
      return;
    }
    const dir = mkdtempSync(join(base, 'cli-'));
    const cliEnv = { PATH: process.env.PATH ?? '', HOME: dir, CI: 'true' };
    const g = spawnSync(process.execPath, [cliJs, 'signer', 'generate', '--ci', '-p', 'test-password', '-w', join(dir, 'test.key')], { encoding: 'utf8', env: cliEnv, cwd: dir });
    expect(g.status, g.stderr).toBe(0);
    writeFileSync(join(dir, 'Retake.app.tar.gz'), archive);
    const s = spawnSync(process.execPath, [cliJs, 'signer', 'sign', '--app-version', '0.2.1', join(dir, 'Retake.app.tar.gz')], { encoding: 'utf8', cwd: dir, env: { ...cliEnv, TAURI_SIGNING_PRIVATE_KEY: readFileSync(join(dir, 'test.key'), 'utf8'), TAURI_SIGNING_PRIVATE_KEY_PASSWORD: 'test-password' } });
    expect(s.status, s.stderr).toBe(0);
    const trusted = pub.verifyMinisign({ data: archive, signatureB64: readFileSync(join(dir, 'Retake.app.tar.gz.sig'), 'utf8'), pubkeyB64: readFileSync(join(dir, 'test.key.pub'), 'utf8'), version: '0.2.1' });
    expect(trusted).toMatch(/\tversion:0\.2\.1$/);
    expect(() => pub.verifyMinisign({ data: archive, signatureB64: readFileSync(join(dir, 'Retake.app.tar.gz.sig'), 'utf8'), pubkeyB64: readFileSync(join(dir, 'test.key.pub'), 'utf8'), version: '0.2.2' })).toThrow(/signed for version/);
  });

  it('refusals happen before any request: no token, an http URL, a bad signature, another version, not a gzip', async () => {
    await expect(run(files('0.2.1'), { UPDATES_UPLOAD_TOKEN: undefined })).rejects.toThrow(/UPDATES_UPLOAD_TOKEN is not set/);
    await expect(run(files('0.2.1'), { UPDATES_UPLOAD_URL: 'http://upload.example.test/base' })).rejects.toThrow(/UPDATES_UPLOAD_URL must be https/);
    await expect(run(files('0.2.1'), { UPDATES_PUBLIC_URL: 'http://downloads.example.test' })).rejects.toThrow(/UPDATES_PUBLIC_URL must be https/);
    await expect(run(files('0.2.1', { sig: other.signFile(archive, tc('0.2.1')) }))).rejects.toThrow(/not published: the archive was signed with another key/);
    await expect(run(files('0.2.2', { sig: key.signFile(archive, tc('0.2.1')) }))).rejects.toThrow(/not published: the archive was signed for version 0\.2\.1, not 0\.2\.2/);
    await expect(run(files('0.2.1', { data: Buffer.from('plain'), sig: key.signFile(Buffer.from('plain'), tc('0.2.1')) }))).rejects.toThrow(/not a gzip archive/);
    await expect(run({ ...files('0.2.1'), version: 'v0.2.1' })).rejects.toThrow(/not a version/);
    // Review d A-L8: the archive is the Apple-silicon app — no other platform.
    await expect(run({ ...files('0.2.1'), platforms: ['darwin-x86_64'] })).rejects.toThrow(/cannot be published for darwin-x86_64 \(only darwin-aarch64 for now\)/);
    await expect(run({ ...files('0.2.1'), platforms: ['darwin-aarch64', 'windows-x86_64'] })).rejects.toThrow(/cannot be published for windows-x86_64/);
    // Review d B-L3: the feed the apps were built with must be this version's channel.
    await expect(run(files('0.2.1'), { RETAKE_UPDATE_FEED: 'https://downloads.example.test/retake/rc.json' })).rejects.toThrow(/RETAKE_UPDATE_FEED is https:\/\/downloads\.example\.test\/retake\/rc\.json, but 0\.2\.1 belongs to https:\/\/downloads\.example\.test\/retake\/latest\.json/);
    await expect(run(files('0.3.0-rc.1'), { RETAKE_UPDATE_FEED: 'https://downloads.example.test/retake/latest.json' })).rejects.toThrow(/belongs to https:\/\/downloads\.example\.test\/retake\/rc\.json/);
    await expect(run(files('0.2.1'), { RETAKE_UPDATE_FEED: 'https://elsewhere.example.test/retake/latest.json' })).rejects.toThrow(/belongs to/);
    expect(requests).toEqual([]);
    expect(pub.channelOf('0.2.1')).toBe('latest.json');
    expect(pub.channelOf('0.3.0-rc.1')).toBe('rc.json');
  });
});

describe('publishing to the stand-in host', () => {
  it('a stable version: the archive, its platform file, then rc.json and latest.json rebuilt — notes from the CHANGELOG, URLs from the environment', async () => {
    const r = await run(files('0.2.1'));
    expect(r.puts).toEqual(['retake/v0.2.1/Retake.app.tar.gz', 'retake/v0.2.1/platforms/darwin-aarch64.json', 'retake/rc.json', 'retake/latest.json']);
    expect(store.get('retake/v0.2.1/Retake.app.tar.gz')!.body.equals(archive)).toBe(true);
    const feed = json('retake/latest.json');
    expect(feed).toEqual({
      version: '0.2.1',
      notes: 'Faster renders and a clearer doctor.',
      pub_date: '2026-11-10T12:00:00.000Z',
      // Ed25519 is deterministic: the .sig text written for this archive and version.
      platforms: { 'darwin-aarch64': { signature: key.signFile(archive, tc('0.2.1')), url: 'https://downloads.example.test/retake/v0.2.1/Retake.app.tar.gz' } },
    });
    expect(json('retake/rc.json')).toEqual(feed);
    // The signature published is the one checked (the .sig file's text).
    expect(() => pub.verifyMinisign({ data: archive, signatureB64: feed.platforms['darwin-aarch64'].signature, pubkeyB64: key.pub, version: '0.2.1' })).not.toThrow();
    expect(requests.every((q) => q.startsWith('PUT /retake/') || q.startsWith('GET /retake/'))).toBe(true);
  });

  it('a pre-release moves rc.json only; latest.json stays where it was', async () => {
    await run(files('0.2.1'));
    const r = await run(files('0.3.0-rc.1'));
    expect(r.channels).toEqual({ 'rc.json': 'written' });
    expect(json('retake/rc.json').version).toBe('0.3.0-rc.1');
    expect(json('retake/latest.json').version).toBe('0.2.1');
    expect(json('retake/rc.json').notes).toBe('Retake 0.3.0-rc.1');
  });

  it('never backwards: an older version re-published leaves both channels alone; the same version again heals them', async () => {
    await run(files('0.3.0'));
    const r = await run(files('0.2.1'));
    expect(r.channels).toEqual({ 'rc.json': 'kept 0.3.0', 'latest.json': 'kept 0.3.0' });
    expect(json('retake/latest.json').version).toBe('0.3.0');
    store.set('retake/latest.json', { body: Buffer.from('{"version":"0.3.0","platforms":{}}'), type: 'application/json' });
    const again = await run(files('0.3.0'));
    expect(again.channels).toEqual({ 'rc.json': 'written', 'latest.json': 'written' });
    expect(Object.keys(json('retake/latest.json').platforms)).toEqual(['darwin-aarch64']);
  });

  it('review d A-L8: a version published with another archive is not replaced without --force; the same bits again heal; the matching feed variable passes', async () => {
    await run(files('0.2.1'), { RETAKE_UPDATE_FEED: 'https://downloads.example.test/retake/latest.json' });
    const otherData = gzipSync(Buffer.from('another build of 0.2.1'));
    const otherFiles = files('0.2.1', { data: otherData, sig: key.signFile(otherData, tc('0.2.1')) });
    const puts = requests.filter((q) => q.startsWith('PUT')).length;
    await expect(run(otherFiles)).rejects.toThrow(/0\.2\.1 is published already for darwin-aarch64 with another archive: --force replaces it/);
    // Nothing was written by the refused run.
    expect(requests.filter((q) => q.startsWith('PUT')).length).toBe(puts);
    expect(store.get('retake/v0.2.1/Retake.app.tar.gz')!.body.equals(archive)).toBe(true);
    // The same bits again: allowed (a re-run heals).
    await expect(run(files('0.2.1'))).resolves.toMatchObject({ channels: { 'rc.json': 'written', 'latest.json': 'written' } });
    // --force replaces them.
    await run({ ...otherFiles, force: true });
    expect(store.get('retake/v0.2.1/Retake.app.tar.gz')!.body.equals(otherData)).toBe(true);
    expect(json('retake/latest.json').platforms['darwin-aarch64'].signature).toBe(key.signFile(otherData, tc('0.2.1')));
  });

  it('the feed is rebuilt from every platform file of the version (a re-run heals a lost race); --notes wins; UPDATES_APP names the folder', async () => {
    store.set('_probe/v0.2.1/platforms/darwin-x86_64.json', { body: Buffer.from(JSON.stringify({ signature: 'c2ln', url: 'https://downloads.example.test/_probe/v0.2.1/Retake.app.tar.gz', extra: 'dropped' })), type: 'application/json' });
    const notes = join(base, 'notes.txt');
    writeFileSync(notes, 'Hand-written notes.\n');
    await run({ ...files('0.2.1'), notes }, { UPDATES_APP: '_probe' });
    const feed = json('_probe/latest.json');
    expect(Object.keys(feed.platforms).sort()).toEqual(['darwin-aarch64', 'darwin-x86_64']);
    expect(feed.platforms['darwin-x86_64']).toEqual({ signature: 'c2ln', url: 'https://downloads.example.test/_probe/v0.2.1/Retake.app.tar.gz' });
    expect(feed.notes).toBe('Hand-written notes.');
    expect(store.has('retake/latest.json')).toBe(false);
  });

  it('the command refuses without its environment and touches no network', () => {
    const f = files('0.2.1');
    const r = spawnSync(process.execPath, [join(REPO, 'scripts', 'publish-update.mjs'), '0.2.1', '--artifact', f.artifact, '--signature', f.signature], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '' } });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/^publish-update: UPDATES_UPLOAD_TOKEN is not set/);
  });
});
