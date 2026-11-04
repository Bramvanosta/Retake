/**
 * L5.16d, moved to a GitHub release by L5.16f — scripts/publish-update.mjs, the release step for the app's updates
 * (DESIGN §4p (d), docs/RELEASING.md): the archive's minisign signature checked in Node before anything is written
 * (Ed25519 over the BLAKE2b-512 prehash, the global signature over the trusted comment, the comment's `version:` equal
 * to the version); then, still before any write, a public repository, the version's published release and what it
 * holds being these very bits; then only what that release lacks (archive, .sig, platform file), and the channels on
 * the fixed `update-feed` release (created once, a pre-release never "latest"): rebuilt from the platform files (a
 * re-run heals), rc.json for every version and latest.json for stable ones, never moved back, replaced through a
 * temporary name so a channel is missing for no longer than the old one's DELETE and the rename.
 * Nothing reaches GitHub: `publish()` gets a fetch bound to a stand-in of GitHub's REST API on 127.0.0.1 (its https
 * hosts — api, uploads, the download storage — rewritten; any other address throws), and the keys are test keys made
 * here (Node's Ed25519, and once the Tauri CLI's own `signer generate` in a temp folder when the pinned CLI is in the
 * pnpm store).
 */
import { spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync, sign as edSign } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
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
const REPOSITORY = 'example-owner/example-repo';
const SERVER = 'https://github.example.test';
const dl = (tag: string, name: string) => `${SERVER}/${REPOSITORY}/releases/download/${tag}/${name}`;

// ---- a stand-in of GitHub's REST API (the calls publish-update makes, as GitHub answers them) ----------------------

type Asset = { id: number; release: number; name: string; body: Buffer; type: string; state?: string };
type Release = { id: number; tag_name: string; draft: boolean; prerelease: boolean; fields: Record<string, unknown> };
type Req = { method: string; path: string; auth?: string; host: 'api' | 'uploads' | 'objects' | 'elsewhere' };
/** What `gh.before` may answer instead of the stand-in: a status (headers, body), or no answer at all. */
type Canned = { status: number; headers?: Record<string, string>; body?: unknown } | 'hang' | undefined;
const gh = {
  repo: { private: false, visibility: 'public' } as Record<string, unknown>,
  releases: [] as Release[],
  assets: [] as Asset[],
  created: [] as Record<string, unknown>[],
  requests: [] as Req[],
  /** After each request: whether update-feed holds each channel (what an app checking then would find). */
  timeline: [] as { req: string; rc: boolean; latest: boolean }[],
  digests: true,
  location: 'https://objects.github.test',
  /** Called after a DELETE, until it returns true (a concurrent run's move). */
  onDelete: null as null | ((a: Asset) => boolean),
  /** Called before the stand-in answers a request (a concurrent run's move, or an answer of its own: an error, none). */
  before: null as null | ((q: Req) => Canned),
  /** The storage's redirects to itself before it serves a file (GitHub: none today). */
  hops: 0,
  /** The storage serves a file without Content-Length (chunked). */
  chunked: false,
  /** The upload address a release names. */
  uploads: 'https://uploads.github.test',
  /** The pauses the script asked for (its `sleep`, injected: no test waits). */
  sleeps: [] as number[],
  logs: [] as string[],
  nextId: 1,
};
function reset() {
  Object.assign(gh, { repo: { private: false, visibility: 'public' }, releases: [], assets: [], created: [], requests: [], timeline: [], digests: true, location: 'https://objects.github.test', onDelete: null, before: null, hops: 0, chunked: false, uploads: 'https://uploads.github.test', sleeps: [], logs: [], nextId: 1 });
}
const releaseOf = (tag: string) => gh.releases.find((r) => r.tag_name === tag);
function addRelease(tag: string, o: { draft?: boolean; prerelease?: boolean } = {}) {
  const r = { id: gh.nextId++, tag_name: tag, draft: o.draft ?? false, prerelease: o.prerelease ?? false, fields: {} };
  gh.releases.push(r);
  return r;
}
function addAsset(tag: string, name: string, body: Buffer | string, type = 'application/octet-stream', state?: string) {
  const a: Asset = { id: gh.nextId++, release: releaseOf(tag)!.id, name, body: Buffer.from(body), type, ...(state ? { state } : {}) };
  gh.assets.push(a);
  return a;
}
const names = (tag: string) => gh.assets.filter((a) => a.release === releaseOf(tag)?.id).map((a) => a.name).sort();
const assetJson = (tag: string, name: string) => JSON.parse(gh.assets.find((a) => a.release === releaseOf(tag)?.id && a.name === name)!.body.toString('utf8'));
const releaseJson = (r: Release) => ({ id: r.id, tag_name: r.tag_name, draft: r.draft, prerelease: r.prerelease, upload_url: `${gh.uploads}/repos/${REPOSITORY}/releases/${r.id}/assets{?name,label}` });
const assetOut = (a: Asset) => ({ id: a.id, name: a.name, size: a.body.length, state: a.state ?? 'uploaded', content_type: a.type, ...(gh.digests ? { digest: `sha256:${createHash('sha256').update(a.body).digest('hex')}` } : {}) });
const writes = () => gh.requests.filter((q) => q.method !== 'GET').map((q) => `${q.method} ${q.path}`);

let server: Server;
let origin = '';
function answer(req: IncomingMessage, res: ServerResponse, body: Buffer) {
  const url = new URL(req.url ?? '/', 'http://x');
  const [, host, ...rest] = url.pathname.split('/');
  const path = `/${rest.join('/')}`;
  const q: Req = { method: req.method!, path: `${path}${url.search}`, auth: req.headers.authorization, host: host as Req['host'] };
  gh.requests.push(q);
  const json = (status: number, v?: unknown) => void res.writeHead(status, { 'content-type': 'application/json' }).end(v === undefined ? '' : JSON.stringify(v));
  const canned = gh.before?.(q);
  if (canned === 'hang') return;
  if (canned) return void res.writeHead(canned.status, { 'content-type': 'application/json', ...canned.headers }).end(canned.body === undefined ? '' : JSON.stringify(canned.body));
  if (host === 'objects') {
    const a = gh.assets.find((x) => x.id === Number(rest[0]));
    if (!a) return json(404);
    const hops = Number(url.searchParams.get('hops') ?? 0);
    if (hops > 0) return void res.writeHead(302, { location: `https://objects.github.test/${a.id}?sig=signed-by-storage&hops=${hops - 1}` }).end();
    if (gh.chunked) return void res.writeHead(200, { 'content-type': a.type }).end(a.body);
    return void res.writeHead(200, { 'content-type': a.type, 'content-length': String(a.body.length) }).end(a.body);
  }
  if (host === 'elsewhere') return json(404);
  if (req.headers.authorization !== 'Bearer test-token') return json(401, { message: 'Bad credentials' });
  const R = `/repos/${REPOSITORY}`;
  if (host === 'uploads') {
    const m = new RegExp(`^${R}/releases/(\\d+)/assets$`).exec(path);
    const rel = m && gh.releases.find((r) => r.id === Number(m[1]));
    const name = url.searchParams.get('name') ?? '';
    if (req.method !== 'POST' || !rel || !name) return json(404);
    if (gh.assets.some((a) => a.release === rel.id && a.name === name)) return json(422, { errors: [{ code: 'already_exists' }] });
    const a = { id: gh.nextId++, release: rel.id, name, body, type: String(req.headers['content-type']) };
    gh.assets.push(a);
    return json(201, assetOut(a));
  }
  if (path === R && req.method === 'GET') return json(200, gh.repo);
  let m = new RegExp(`^${R}/releases/tags/([^/]+)$`).exec(path);
  if (m && req.method === 'GET') {
    const r = releaseOf(decodeURIComponent(m[1]!));
    return r && !r.draft ? json(200, releaseJson(r)) : json(404, { message: 'Not Found' });
  }
  if (path === `${R}/releases` && req.method === 'POST') {
    const f = JSON.parse(body.toString('utf8'));
    if (releaseOf(f.tag_name)) return json(422, { errors: [{ code: 'already_exists' }] });
    gh.created.push(f);
    const r = addRelease(f.tag_name, { draft: f.draft, prerelease: f.prerelease });
    r.fields = f;
    return json(201, releaseJson(r));
  }
  m = new RegExp(`^${R}/releases/(\\d+)/assets$`).exec(path);
  if (m && req.method === 'GET') {
    const all = gh.assets.filter((a) => a.release === Number(m![1])).map(assetOut);
    const per = Number(url.searchParams.get('per_page') ?? 30);
    const page = Number(url.searchParams.get('page') ?? 1);
    return json(200, all.slice((page - 1) * per, page * per));
  }
  m = new RegExp(`^${R}/releases/assets/(\\d+)$`).exec(path);
  const a = m && gh.assets.find((x) => x.id === Number(m![1]));
  if (m && req.method === 'GET') {
    if (!a) return json(404);
    if (req.headers.accept !== 'application/octet-stream') return json(200, assetOut(a));
    return void res.writeHead(302, { location: `${gh.location}/${a.id}?sig=signed-by-storage&hops=${gh.hops}` }).end();
  }
  if (m && req.method === 'DELETE') {
    if (!a) return json(404);
    gh.assets = gh.assets.filter((x) => x !== a);
    if (gh.onDelete?.(a)) gh.onDelete = null;
    return void res.writeHead(204).end();
  }
  if (m && req.method === 'PATCH') {
    if (!a) return json(404);
    const { name } = JSON.parse(body.toString('utf8'));
    if (gh.assets.some((x) => x.release === a.release && x.name === name && x !== a)) return json(422, { errors: [{ code: 'already_exists' }] });
    a.name = name;
    return json(200, assetOut(a));
  }
  json(404, { message: 'Not Found' });
}
beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      answer(req, res, Buffer.concat(chunks));
      const feed = releaseOf('update-feed');
      const has = (n: string) => !!feed && gh.assets.some((x) => x.release === feed.id && x.name === n);
      const q = gh.requests.at(-1)!;
      gh.timeline.push({ req: `${q.method} ${q.path}`, rc: has('rc.json'), latest: has('latest.json') });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const a = server.address();
  origin = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
});
afterAll(() => new Promise<void>((r) => {
  server.closeAllConnections();
  server.close(() => r());
}));
beforeEach(reset);

/** The script's https addresses, served by the local stand-in; any other address is refused (no network). */
const fetchLocal = (url: string, init?: RequestInit) => {
  const m = /^https:\/\/(api|uploads|objects|elsewhere)\.github\.test(\/.*)$/.exec(url);
  if (!m) throw new Error(`outside the stand-in: ${url}`);
  return fetch(`${origin}/${m[1]}${m[2]}`, init);
};
const env = (over: Record<string, string | undefined> = {}) => ({
  GITHUB_TOKEN: 'test-token',
  GITHUB_REPOSITORY: REPOSITORY,
  GITHUB_API_URL: 'https://api.github.test',
  GITHUB_SERVER_URL: `${SERVER}/`,
  RETAKE_UPDATE_PUBKEY: key.pub,
  ...over,
});
function files(version: string, o: { sig?: string; data?: Buffer } = {}) {
  const dir = mkdtempSync(join(base, 'rel-'));
  const artifact = join(dir, 'Retake.app.tar.gz');
  writeFileSync(artifact, o.data ?? archive);
  writeFileSync(`${artifact}.sig`, o.sig ?? key.signFile(o.data ?? archive, tc(version)));
  return { version, artifact, signature: `${artifact}.sig`, platforms: ['darwin-aarch64'], notes: null as string | null };
}
/** A published release of `version` as the workflow's attach job leaves it: the archive and its .sig. */
function attached(version: string, f = files(version)) {
  addRelease(`v${version}`, { prerelease: version.includes('-') });
  addAsset(`v${version}`, 'Retake.app.tar.gz', readFileSync(f.artifact));
  addAsset(`v${version}`, 'Retake.app.tar.gz.sig', readFileSync(f.signature), 'text/plain');
  return f;
}
const changelog = join(base, 'CHANGELOG.md');
writeFileSync(changelog, '# Changelog\n\n## [0.2.1] — 2026-11-10\n\nFaster renders and a **clearer** `doctor`.\n\n### Fixed\n- **A thing.** Details.\n');
/** No test waits: the script's pauses are recorded; a request answers within 2 s here (a hang: 200 ms). */
const net = (o: Record<string, unknown> = {}) => ({ sleep: async (ms: number) => void gh.sleeps.push(ms), timeoutMs: 2000, ...o });
const run = (args: ReturnType<typeof files>, over: Record<string, string | undefined> = {}, o: Record<string, unknown> = {}) =>
  pub.publish({ args, env: env(over), fetchImpl: fetchLocal, net: net(o), log: (m: string) => void gh.logs.push(m), changelog, now: () => new Date('2026-11-10T12:00:00Z') });

describe('versions, notes, where the feed lives', () => {
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

  it('GitHub\'s own addresses by default, https only, <owner>/<repo> checked; the feed of each channel on the update-feed release', () => {
    expect(pub.checkUrl('https://github.example.test/a/', 'X')).toBe('https://github.example.test/a');
    expect(() => pub.checkUrl('http://github.example.test', 'X')).toThrow(/must be https/);
    expect(() => pub.checkUrl('https://u:p@github.example.test', 'X')).toThrow(/user, a query/);
    expect(() => pub.checkUrl('https://github.example.test/?t=1', 'X')).toThrow(/user, a query/);
    expect(() => pub.checkUrl('', 'X')).toThrow(/not a URL/);
    for (const good of ['o/r', 'a-b/c.d_e', `${'a'.repeat(39)}/${'r'.repeat(100)}`]) expect(pub.checkRepository(good), good).toBe(good);
    for (const bad of ['o', 'o/r/x', '-o/r', 'o/..', 'o/.', 'o/r?x', 'o /r', `${'a'.repeat(40)}/r`, 'https://github.example.test/o/r', '']) expect(() => pub.checkRepository(bad), bad).toThrow(/is not <owner>\/<repo>/);
    for (const v of ['GITHUB_TOKEN', 'GITHUB_REPOSITORY', 'RETAKE_UPDATE_PUBKEY']) expect(() => pub.settings(env({ [v]: undefined })), v).toThrow(new RegExp(`${v} is not set`));
    const s = pub.settings(env({ GITHUB_API_URL: undefined, GITHUB_SERVER_URL: ' ' }));
    expect([s.api, s.server, s.repository]).toEqual(['https://api.github.com', 'https://github.com', REPOSITORY]);
    expect(() => pub.settings(env({ GITHUB_API_URL: 'http://api.github.test' }))).toThrow(/GITHUB_API_URL must be https/);
    expect(() => pub.settings(env({ GITHUB_SERVER_URL: 'http://github.example.test' }))).toThrow(/GITHUB_SERVER_URL must be https/);
    const loc = pub.feedLocation(env());
    expect(pub.feedUrl('0.2.1', loc)).toBe(dl('update-feed', 'latest.json'));
    expect(pub.feedUrl('0.3.0-rc.1', loc)).toBe(dl('update-feed', 'rc.json'));
    expect(pub.channelsFor('0.3.0-rc.1')).toEqual(['rc.json']);
    expect(pub.channelsFor('0.3.0')).toEqual(['rc.json', 'latest.json']);
    expect(pub.uploadUrl('https://uploads.github.test/repos/o/r/releases/7/assets{?name,label}', 'rc.json.tmp-1', 'https://api.github.test')).toBe('https://uploads.github.test/repos/o/r/releases/7/assets?name=rc.json.tmp-1');
    expect(() => pub.uploadUrl('http://uploads.github.test/x{?name}', 'a', 'https://api.github.test')).toThrow(/not https/);
    // Review f A-L4: the token goes to the API's own upload host only — GitHub's, or a server's own (Enterprise Server).
    expect(pub.uploadOrigin('https://api.github.com')).toBe('https://uploads.github.com');
    expect(pub.uploadOrigin('https://git.example.test/api/v3')).toBe('https://git.example.test');
    expect(pub.uploadUrl('https://git.example.test/api/uploads/repos/o/r/releases/7/assets{?name,label}', 'a', 'https://git.example.test/api/v3')).toBe('https://git.example.test/api/uploads/repos/o/r/releases/7/assets?name=a');
    for (const elsewhere of ['https://uploads.example.test/x{?name}', 'https://github.test/x{?name}', 'https://uploads.github.test:8443/x{?name}', 'https://api.github.test/x{?name}']) expect(() => pub.uploadUrl(elsewhere, 'a', 'https://api.github.test'), elsewhere).toThrow(/is not on https:\/\/uploads\.github\.test, the API's upload host/);
  });

  it('arguments: the version first, the default platform; --force is gone (a public release\'s files are never replaced); an unknown flag refused', () => {
    expect(pub.parseArgs(['0.2.1', '--artifact', 'a', '--signature', 'a.sig'])).toEqual({ version: '0.2.1', platforms: ['darwin-aarch64'], artifact: 'a', signature: 'a.sig', notes: null });
    expect(() => pub.parseArgs(['0.2.1', '--force', '--artifact', 'a', '--signature', 'a.sig'])).toThrow(/--force is gone: a public release's files are never replaced — a fixed build is a new version/);
    expect(() => pub.parseArgs(['0.2.1', '--upload-to', 'x'])).toThrow(/unknown argument/);
  });
});

describe('the signature, checked in Node before anything is written', () => {
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


  it('refusals happen before any request: no token, no or a bad repository, an http API or server, a bad signature, another version, not a gzip, another platform, the other channel\'s feed', async () => {
    attached('0.2.1');
    await expect(run(files('0.2.1'), { GITHUB_TOKEN: undefined })).rejects.toThrow(/GITHUB_TOKEN is not set/);
    await expect(run(files('0.2.1'), { GITHUB_REPOSITORY: ' ' })).rejects.toThrow(/GITHUB_REPOSITORY is not set/);
    await expect(run(files('0.2.1'), { GITHUB_REPOSITORY: 'example-owner/example-repo/../other' })).rejects.toThrow(/is not <owner>\/<repo>/);
    await expect(run(files('0.2.1'), { GITHUB_API_URL: 'http://api.github.test' })).rejects.toThrow(/GITHUB_API_URL must be https/);
    await expect(run(files('0.2.1'), { GITHUB_SERVER_URL: 'http://github.example.test' })).rejects.toThrow(/GITHUB_SERVER_URL must be https/);
    await expect(run(files('0.2.1', { sig: other.signFile(archive, tc('0.2.1')) }))).rejects.toThrow(/not published: the archive was signed with another key/);
    await expect(run(files('0.2.2', { sig: key.signFile(archive, tc('0.2.1')) }))).rejects.toThrow(/not published: the archive was signed for version 0\.2\.1, not 0\.2\.2/);
    await expect(run(files('0.2.1', { data: Buffer.from('plain'), sig: key.signFile(Buffer.from('plain'), tc('0.2.1')) }))).rejects.toThrow(/not a gzip archive/);
    await expect(run({ ...files('0.2.1'), version: 'v0.2.1' })).rejects.toThrow(/not a version/);
    // Review d A-L8: the archive is the Apple-silicon app — no other platform.
    await expect(run({ ...files('0.2.1'), platforms: ['darwin-x86_64'] })).rejects.toThrow(/cannot be published for darwin-x86_64 \(only darwin-aarch64 for now\)/);
    await expect(run({ ...files('0.2.1'), platforms: ['darwin-aarch64', 'windows-x86_64'] })).rejects.toThrow(/cannot be published for windows-x86_64/);
    // Review d B-L3: the feed the apps were built with must be this version's channel on this repository.
    await expect(run(files('0.2.1'), { RETAKE_UPDATE_FEED: dl('update-feed', 'rc.json') })).rejects.toThrow(new RegExp(`RETAKE_UPDATE_FEED is ${dl('update-feed', 'rc.json').replace(/[./]/g, '\\$&')}, but 0\\.2\\.1 belongs to ${dl('update-feed', 'latest.json').replace(/[./]/g, '\\$&')}`));
    await expect(run(files('0.3.0-rc.1'), { RETAKE_UPDATE_FEED: dl('update-feed', 'latest.json') })).rejects.toThrow(/belongs to .*\/update-feed\/rc\.json/);
    await expect(run(files('0.2.1'), { RETAKE_UPDATE_FEED: `${SERVER}/someone-else/example-repo/releases/download/update-feed/latest.json` })).rejects.toThrow(/belongs to/);
    expect(gh.requests).toEqual([]);
  });
});

describe('publishing to a stand-in of GitHub\'s REST API', () => {
  it('a stable version as the workflow leaves it: its archive and .sig kept, its platform file added, update-feed created (a pre-release, never latest), rc.json and latest.json written — the notes from the CHANGELOG', async () => {
    attached('0.2.1');
    const kept = gh.assets.map((a) => `${a.id} ${a.name}`);
    const r = await run(files('0.2.1'));
    expect(r.writes).toEqual(['v0.2.1/platform-darwin-aarch64.json', 'update-feed/rc.json', 'update-feed/latest.json']);
    expect(r.channels).toEqual({ 'rc.json': 'written', 'latest.json': 'written' });
    const entry = { signature: key.signFile(archive, tc('0.2.1')), url: dl('v0.2.1', 'Retake.app.tar.gz') };
    expect(assetJson('v0.2.1', 'platform-darwin-aarch64.json')).toEqual(entry);
    const feed = assetJson('update-feed', 'latest.json');
    // Ed25519 is deterministic: the .sig text written for this archive and version.
    expect(feed).toEqual({ version: '0.2.1', notes: 'Faster renders and a clearer doctor.', pub_date: '2026-11-10T12:00:00.000Z', platforms: { 'darwin-aarch64': entry } });
    expect(assetJson('update-feed', 'rc.json')).toEqual(feed);
    expect(() => pub.verifyMinisign({ data: archive, signatureB64: feed.platforms['darwin-aarch64'].signature, pubkeyB64: key.pub, version: '0.2.1' })).not.toThrow();
    // The feed release: created once, a published pre-release, never "latest"; its two files only (no temporary one).
    expect(gh.created).toHaveLength(1);
    expect(gh.created[0]).toMatchObject({ tag_name: 'update-feed', draft: false, prerelease: true, make_latest: 'false' });
    expect(names('update-feed')).toEqual(['latest.json', 'rc.json']);
    expect(names('v0.2.1')).toEqual(['Retake.app.tar.gz', 'Retake.app.tar.gz.sig', 'platform-darwin-aarch64.json']);
    // The version's release only gained a file (the attached ones are the same assets); the token went to the API and
    // the uploads, never to the storage.
    expect(gh.assets.filter((a) => a.release === releaseOf('v0.2.1')!.id && a.name !== 'platform-darwin-aarch64.json').map((a) => `${a.id} ${a.name}`)).toEqual(kept);
    expect(writes().filter((w) => w.includes(`/releases/${releaseOf('v0.2.1')!.id}/`))).toEqual([`POST /repos/${REPOSITORY}/releases/${releaseOf('v0.2.1')!.id}/assets?name=platform-darwin-aarch64.json`]);
    expect(gh.requests.filter((q) => q.host !== 'objects').every((q) => q.auth === 'Bearer test-token')).toBe(true);
    expect(gh.requests.filter((q) => q.host === 'objects').length).toBeGreaterThan(0);
    expect(gh.requests.filter((q) => q.host === 'objects').every((q) => q.auth === undefined)).toBe(true);
    // The second publication finds update-feed: not created again.
    await run(files('0.2.1'));
    expect(gh.created).toHaveLength(1);
  });

  it('by hand: the archive and its .sig uploaded when the published release lacks them (the same bytes), then the feed', async () => {
    addRelease('v0.2.1');
    const f = files('0.2.1');
    const r = await run(f);
    expect(r.writes).toEqual(['v0.2.1/Retake.app.tar.gz', 'v0.2.1/Retake.app.tar.gz.sig', 'v0.2.1/platform-darwin-aarch64.json', 'update-feed/rc.json', 'update-feed/latest.json']);
    expect(gh.assets.find((a) => a.name === 'Retake.app.tar.gz')!.body.equals(archive)).toBe(true);
    expect(gh.assets.find((a) => a.name === 'Retake.app.tar.gz.sig')!.body.equals(readFileSync(f.signature))).toBe(true);
    expect(assetJson('update-feed', 'latest.json').platforms['darwin-aarch64'].url).toBe(dl('v0.2.1', 'Retake.app.tar.gz'));
  });

  it('a pre-release moves rc.json only; latest.json stays where it was', async () => {
    attached('0.2.1');
    await run(files('0.2.1'));
    attached('0.3.0-rc.1');
    const r = await run(files('0.3.0-rc.1'));
    expect(r.channels).toEqual({ 'rc.json': 'written' });
    expect(assetJson('update-feed', 'rc.json').version).toBe('0.3.0-rc.1');
    expect(assetJson('update-feed', 'rc.json').notes).toBe('Retake 0.3.0-rc.1');
    expect(assetJson('update-feed', 'rc.json').platforms['darwin-aarch64'].url).toBe(dl('v0.3.0-rc.1', 'Retake.app.tar.gz'));
    expect(assetJson('update-feed', 'latest.json').version).toBe('0.2.1');
  });

  it('never backwards: an older version re-published leaves both channels alone; the same version again heals them', async () => {
    attached('0.3.0');
    await run(files('0.3.0'));
    attached('0.2.1');
    const r = await run(files('0.2.1'));
    expect(r.channels).toEqual({ 'rc.json': 'kept 0.3.0', 'latest.json': 'kept 0.3.0' });
    expect(assetJson('update-feed', 'latest.json').version).toBe('0.3.0');
    // A feed that lost its platforms: the same version again rewrites it.
    gh.assets.find((a) => a.name === 'latest.json')!.body = Buffer.from('{"version":"0.3.0","platforms":{}}');
    const again = await run(files('0.3.0'));
    expect(again.channels).toEqual({ 'rc.json': 'written', 'latest.json': 'written' });
    expect(again.writes).toEqual(['update-feed/rc.json', 'update-feed/latest.json']);
    expect(Object.keys(assetJson('update-feed', 'latest.json').platforms)).toEqual(['darwin-aarch64']);
  });

  it('a re-run heals a feed that lost a race: rebuilt from every platform file the release holds; --notes wins; a channel that is not JSON is rewritten', async () => {
    attached('0.2.1');
    addAsset('v0.2.1', 'platform-darwin-x86_64.json', JSON.stringify({ signature: 'c2ln', url: dl('v0.2.1', 'Retake-x64.app.tar.gz'), extra: 'dropped' }), 'application/json');
    addRelease('update-feed', { prerelease: true });
    addAsset('update-feed', 'rc.json', JSON.stringify({ version: '0.2.1', platforms: { 'darwin-x86_64': {} } }), 'application/json');
    addAsset('update-feed', 'latest.json', 'not json', 'application/json');
    const notes = join(base, 'notes.txt');
    writeFileSync(notes, 'Hand-written notes.\n');
    await run({ ...files('0.2.1'), notes });
    const feed = assetJson('update-feed', 'latest.json');
    expect(Object.keys(feed.platforms).sort()).toEqual(['darwin-aarch64', 'darwin-x86_64']);
    expect(feed.platforms['darwin-x86_64']).toEqual({ signature: 'c2ln', url: dl('v0.2.1', 'Retake-x64.app.tar.gz') });
    expect(feed.notes).toBe('Hand-written notes.');
    expect(assetJson('update-feed', 'rc.json')).toEqual(feed);
    expect(gh.created).toEqual([]);
  });

  it('other bits are refused before any write, with no override: another archive or .sig on the release, a platform file naming another signature — the same bits again are a re-run', async () => {
    attached('0.2.1');
    await run(files('0.2.1'));
    const before = writes().length;
    const otherData = gzipSync(Buffer.from('another build of 0.2.1'));
    const otherFiles = files('0.2.1', { data: otherData, sig: key.signFile(otherData, tc('0.2.1')) });
    await expect(run(otherFiles)).rejects.toThrow(/v0\.2\.1's Retake\.app\.tar\.gz is not the archive checked here \(\d+ bytes on the release, \d+ here\): a public release's files are never replaced — a fixed build is a new version/);
    // Same size, other bytes: GitHub's sha256 digest tells them apart.
    const twin = Buffer.from(archive);
    twin[twin.length - 1] ^= 1;
    const twinFiles = files('0.2.1', { data: twin, sig: key.signFile(twin, tc('0.2.1')) });
    await expect(run(twinFiles)).rejects.toThrow(/is not the archive checked here/);
    // The release's .sig is another one (the same archive, signed again: another trusted comment).
    const resigned = files('0.2.1', { sig: key.signFile(archive, `timestamp:1762000999\tfile:Retake.app.tar.gz\tversion:0.2.1`) });
    await expect(run(resigned)).rejects.toThrow(/v0\.2\.1's Retake\.app\.tar\.gz\.sig is not the signature checked here/);
    // A platform file naming another signature (the archive and .sig themselves absent: a by-hand release).
    addRelease('v0.2.2');
    addAsset('v0.2.2', 'platform-darwin-aarch64.json', JSON.stringify({ signature: 'b3RoZXI=', url: dl('v0.2.2', 'Retake.app.tar.gz') }), 'application/json');
    await expect(run(files('0.2.2'))).rejects.toThrow(/0\.2\.2 is published already for darwin-aarch64 with another archive \(v0\.2\.2\/platform-darwin-aarch64\.json\): a public release's files are never replaced/);
    expect(writes().length).toBe(before);
    expect(gh.assets.find((a) => a.name === 'Retake.app.tar.gz' && a.release === releaseOf('v0.2.1')!.id)!.body.equals(archive)).toBe(true);
    // Without digests (an older API): the size still tells another archive apart; the same bits pass.
    gh.digests = false;
    await expect(run(otherFiles)).rejects.toThrow(/is not the archive checked here/);
    await expect(run(files('0.2.1'))).resolves.toMatchObject({ channels: { 'rc.json': 'written', 'latest.json': 'written' } });
  });

  it('refused before any write: a repository that is not public, a version with no published release (a draft does not count)', async () => {
    attached('0.2.1');
    gh.repo = { private: true, visibility: 'private' };
    await expect(run(files('0.2.1'))).rejects.toThrow(/example-owner\/example-repo is not public: the installed apps download their updates without credentials/);
    gh.repo = { private: false, visibility: 'internal' };
    await expect(run(files('0.2.1'))).rejects.toThrow(/is not public/);
    gh.repo = { visibility: 'public' };
    await expect(run(files('0.2.1'))).rejects.toThrow(/is not public/);
    gh.repo = { private: false, visibility: 'public' };
    addRelease('v0.2.2', { draft: true });
    await expect(run(files('0.2.2'))).rejects.toThrow(/has no published release v0\.2\.2: publish it first \(a draft's files answer 404 to the apps\)/);
    await expect(run(files('0.2.3'))).rejects.toThrow(/has no published release v0\.2\.3/);
    expect(writes()).toEqual([]);
    expect(releaseOf('update-feed')).toBeUndefined();
  });

  it('a channel is never missing longer than the old one\'s DELETE and the rename: the new feed uploaded whole first; an interrupted run\'s temporary file removed', async () => {
    attached('0.2.0');
    await run(files('0.2.0'));
    addAsset('update-feed', 'rc.json.tmp-123-dead', '{"half":', 'application/json');
    attached('0.2.1');
    gh.timeline.length = 0;
    gh.requests.length = 0;
    await run(files('0.2.1'));
    // While this run worked, an app checking found each channel at every moment but one request's span.
    for (const ch of ['rc', 'latest'] as const) {
      const gaps = gh.timeline.map((t, i) => (t[ch] ? -1 : i)).filter((i) => i >= 0);
      expect(gaps.length, ch).toBe(1);
      expect(gh.timeline[gaps[0]!]!.req, ch).toMatch(/^DELETE /);
      expect(gh.timeline[gaps[0]! + 1]!.req, ch).toMatch(/^PATCH /);
    }
    // rc.json's replacement: the temporary upload, then the old one deleted, then the rename onto its name.
    const w = writes();
    const up = w.findIndex((x) => /\?name=rc\.json\.tmp-[0-9a-f]{8}$/.test(x));
    expect(up).toBeGreaterThanOrEqual(0);
    expect(w.slice(up + 1, up + 3)).toEqual([expect.stringMatching(/^DELETE \/repos\/.*\/releases\/assets\/\d+$/), expect.stringMatching(/^PATCH \/repos\/.*\/releases\/assets\/\d+$/)]);
    expect(names('update-feed')).toEqual(['latest.json', 'rc.json']);
    expect(assetJson('update-feed', 'rc.json').version).toBe('0.2.1');
    // In the workflow the temporary name carries the run's id.
    attached('0.2.2');
    gh.requests.length = 0;
    await run(files('0.2.2'), { GITHUB_RUN_ID: '4242' });
    expect(writes().some((x) => /\?name=latest\.json\.tmp-4242-[0-9a-f]{8}$/.test(x))).toBe(true);
  });

  it('a rename that loses to another run is tried again (theirs deleted, ours renamed); reading a file follows GitHub\'s redirect with no token, and only to https', async () => {
    attached('0.2.0');
    await run(files('0.2.0'));
    attached('0.2.1');
    // Just after this run deletes the old rc.json, another run puts its own there.
    gh.onDelete = (a) => {
      if (a.name !== 'rc.json') return false;
      addAsset('update-feed', 'rc.json', '{"version":"0.2.0","platforms":{}}', 'application/json');
      return true;
    };
    gh.requests.length = 0;
    await run(files('0.2.1'));
    expect(writes().filter((x) => x.startsWith('PATCH')).length).toBe(3); // rc.json: refused once, then renamed; latest.json
    expect(assetJson('update-feed', 'rc.json').version).toBe('0.2.1');
    expect(names('update-feed')).toEqual(['latest.json', 'rc.json']);
    // A download address that is not https: refused (the file is read before anything is written).
    gh.location = 'http://objects.github.test';
    gh.requests.length = 0;
    await expect(run(files('0.2.1'))).rejects.toThrow(/platform-darwin-aarch64\.json: GitHub redirected its download to a non-https address/);
    expect(writes()).toEqual([]);
  });

  it('the command refuses without its environment and touches no network', () => {
    const f = files('0.2.1');
    const r = spawnSync(process.execPath, [join(REPO, 'scripts', 'publish-update.mjs'), '0.2.1', '--artifact', f.artifact, '--signature', f.signature], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '' } });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/^publish-update: GITHUB_TOKEN is not set/);
    const forced = spawnSync(process.execPath, [join(REPO, 'scripts', 'publish-update.mjs'), '0.2.1', '--force'], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '' } });
    expect(forced.stderr).toMatch(/^publish-update: --force is gone/);
  });
});

describe('the feed under races and failures (review f)', () => {
  /** The update-feed release after a publication of `version`: both channels at it. */
  async function feedAt(version: string) {
    attached(version);
    await run(files(version));
    gh.requests.length = 0;
    gh.sleeps.length = 0;
    gh.logs.length = 0;
  }
  const feedNames = () => names('update-feed');
  const isTmp = (n: string) => /\.tmp-[0-9a-f]{8}$/.test(n);

  it('a newer feed another publication writes between the check and the delete is kept — before the first delete, or after it (the rename refused); an older one is replaced (A-M1)', async () => {
    await feedAt('0.2.0');
    attached('0.2.1');
    attached('0.3.0-rc.1');
    const theirs = '{"version":"0.3.0-rc.1","platforms":{}}';
    // Between this run's check of rc.json (0.2.0) and its delete: another run puts 0.3.0-rc.1 there.
    gh.before = (q) => {
      if (q.method === 'POST' && /\?name=rc\.json\.tmp-/.test(q.path)) {
        gh.assets = gh.assets.filter((a) => a.name !== 'rc.json');
        addAsset('update-feed', 'rc.json', theirs, 'application/json');
        gh.before = null;
      }
      return undefined;
    };
    const r = await run(files('0.2.1'));
    expect(r.channels).toEqual({ 'rc.json': 'kept 0.3.0-rc.1', 'latest.json': 'written' });
    expect(assetJson('update-feed', 'rc.json').version).toBe('0.3.0-rc.1');
    expect(assetJson('update-feed', 'latest.json').version).toBe('0.2.1');
    expect(feedNames()).toEqual(['latest.json', 'rc.json']);
    expect(r.writes).toEqual(['v0.2.1/platform-darwin-aarch64.json', 'update-feed/latest.json']);
    expect(r.warnings).toEqual([]);
    expect(gh.logs.join('\n')).toMatch(/update-feed\/rc\.json holds 0\.3\.0-rc\.1 now \(another publication wrote it meanwhile\): kept — this run's feed of 0\.2\.1 dropped/);
    // Just after this run deletes the old rc.json, another run puts a newer one there: the rename is refused, the
    // newer one is looked at and kept — never "theirs deleted, ours renamed" (the channel would go back).
    reset();
    await feedAt('0.2.0');
    attached('0.2.1');
    attached('0.3.0-rc.1');
    gh.onDelete = (a) => {
      if (a.name !== 'rc.json') return false;
      addAsset('update-feed', 'rc.json', theirs, 'application/json');
      return true;
    };
    const r2 = await run(files('0.2.1'));
    expect(r2.channels['rc.json']).toBe('kept 0.3.0-rc.1');
    expect(assetJson('update-feed', 'rc.json').version).toBe('0.3.0-rc.1');
    expect(feedNames()).toEqual(['latest.json', 'rc.json']);
    // The same version written meanwhile by another run is kept too (it is that version's feed, rebuilt the same way).
    reset();
    await feedAt('0.2.0');
    attached('0.2.1');
    gh.onDelete = (a) => {
      if (a.name !== 'latest.json') return false;
      addAsset('update-feed', 'latest.json', '{"version":"0.2.1","platforms":{"darwin-aarch64":{}}}', 'application/json');
      return true;
    };
    expect((await run(files('0.2.1'))).channels).toEqual({ 'rc.json': 'written', 'latest.json': 'kept 0.2.1' });
  });

  it('the rename window survives a server error, a rate limit (Retry-After, capped), a network error; a permission error is not asked again (A-M2)', async () => {
    await feedAt('0.2.0');
    attached('0.2.1');
    // A 502 on the first rename, a 429 (Retry-After: 3) on a DELETE, a 403 rate limit with no request left.
    const seen: string[] = [];
    gh.before = (q) => {
      const k = `${q.method} ${q.path.replace(/\d+/g, 'N')}`;
      seen.push(k);
      const n = seen.filter((x) => x === k).length;
      if (q.method === 'PATCH' && n === 1) return { status: 502, body: { message: 'Server Error' } };
      if (q.method === 'DELETE' && n === 1) return { status: 429, headers: { 'retry-after': '3' } };
      if (q.method === 'DELETE' && n === 2) return { status: 403, headers: { 'x-ratelimit-remaining': '0' }, body: { message: 'API rate limit exceeded' } };
      return undefined;
    };
    const r = await run(files('0.2.1'));
    expect(r.channels).toEqual({ 'rc.json': 'written', 'latest.json': 'written' });
    expect(feedNames()).toEqual(['latest.json', 'rc.json']);
    expect(gh.sleeps).toEqual([3000, 2000, 1000]);
    expect(gh.logs.join('\n')).toMatch(/PATCH \/repos\/.*: 502 — asked again in 1 s/);
    // Retry-After as a date, and a long one capped at a minute; no header: the backoff.
    const res = (h: Record<string, string>) => new Response(null, { status: 429, headers: h });
    expect(pub.retryDelay(res({ 'retry-after': '600' }), 1000)).toBe(60_000);
    expect(pub.retryDelay(res({ 'retry-after': new Date(Date.now() + 5000).toUTCString() }), 1000)).toBeGreaterThan(3000);
    expect(pub.retryDelay(res({}), 1000)).toBe(1000);
    expect(pub.retryDelay(res({ 'retry-after': 'soon' }), 1000)).toBe(1000);
    expect([500, 502, 503, 429].map((status) => pub.retryable(new Response(null, { status })))).toEqual([true, true, true, true]);
    expect([400, 401, 403, 404, 422].map((status) => pub.retryable(new Response(null, { status })))).toEqual([false, false, false, false, false]);
    expect(pub.retryable(new Response(null, { status: 403, headers: { 'retry-after': '1' } }))).toBe(true);
    // A 403 that is no rate limit (the token may not write): one request, the error.
    reset();
    await feedAt('0.2.0');
    attached('0.2.1');
    gh.before = (q) => (q.method === 'DELETE' ? { status: 403, body: { message: 'Resource not accessible by integration' } } : undefined);
    await expect(run(files('0.2.1'))).rejects.toThrow(/DELETE \/repos\/.*: 403 .*Resource not accessible by integration.* — while replacing update-feed\/rc\.json: it may be MISSING/);
    expect(gh.requests.filter((q) => q.method === 'DELETE')).toHaveLength(1);
    // A server error on the temporary upload: an upload is never sent twice — the run stops, the channel untouched.
    reset();
    await feedAt('0.2.0');
    attached('0.2.1');
    gh.before = (q) => (q.method === 'POST' && /\?name=rc\.json\.tmp-/.test(q.path) ? { status: 502 } : undefined);
    await expect(run(files('0.2.1'))).rejects.toThrow(/^POST \/repos\/.*\/assets: 502$/);
    expect(gh.requests.filter((q) => q.method === 'POST' && /\?name=rc\.json\.tmp-/.test(q.path))).toHaveLength(1);
    expect(assetJson('update-feed', 'rc.json').version).toBe('0.2.0');
    // A network error on a DELETE: asked again.
    reset();
    await feedAt('0.2.0');
    attached('0.2.1');
    let cut = 1;
    const flaky = (url: string, init?: RequestInit) => {
      if (init?.method === 'DELETE' && cut-- > 0) throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } });
      return fetchLocal(url, init);
    };
    await pub.publish({ args: files('0.2.1'), env: env(), fetchImpl: flaky, net: net(), log: (m: string) => void gh.logs.push(m), changelog });
    expect(assetJson('update-feed', 'rc.json').version).toBe('0.2.1');
    expect(gh.logs.join('\n')).toMatch(/DELETE .*: no answer — asked again in 1 s/);
  });

  it('a rename that never succeeds: the temporary file is kept and the error says the channel is MISSING and what to re-run; a re-run heals and removes it (A-M2, B-L3, B-L6)', async () => {
    await feedAt('0.2.0');
    attached('0.2.1');
    // GitHub's list lags: every rename is refused though nothing holds the name.
    gh.before = (q) => (q.method === 'PATCH' ? { status: 422, body: { errors: [{ code: 'already_exists' }] } } : undefined);
    const err = await run(files('0.2.1')).catch((e: Error) => e);
    expect(err).toBeInstanceOf(pub.PublishError);
    expect((err as Error).message).toMatch(/^could not rename update-feed\/rc\.json\.tmp-[0-9a-f]{8} to rc\.json \(4 tries, the name refused though no file holds it\): update-feed\/rc\.json is MISSING — every app's check fails until it is back\. This run's feed of 0\.2\.1 is kept as update-feed\/rc\.json\.tmp-[0-9a-f]{8}: re-run this publication \(the workflow: the run's publish job › Re-run failed jobs; by hand: the same command\) — it writes rc\.json again and removes the temporary file$/);
    expect(gh.requests.filter((q) => q.method === 'PATCH')).toHaveLength(4);
    expect(gh.sleeps).toEqual([1000, 2000, 4000]);
    const left = feedNames();
    expect(left.filter(isTmp)).toHaveLength(1);
    expect(left).not.toContain('rc.json');
    expect(JSON.parse(gh.assets.find((a) => isTmp(a.name))!.body.toString('utf8')).version).toBe('0.2.1');
    // The re-run it asks for.
    gh.before = null;
    const again = await run(files('0.2.1'));
    expect(again.channels).toEqual({ 'rc.json': 'written', 'latest.json': 'written' });
    expect(feedNames()).toEqual(['latest.json', 'rc.json']);
    // A hang after the delete (every try times out): the same — kept, MISSING, re-run.
    reset();
    await feedAt('0.2.0');
    attached('0.2.1');
    gh.before = (q) => (q.method === 'PATCH' ? 'hang' : undefined);
    await expect(run(files('0.2.1'), {}, { timeoutMs: 200, retryDelays: [0] })).rejects.toThrow(/PATCH \/repos\/.*: no answer in 0\.2 s — while replacing update-feed\/rc\.json: it may be MISSING .* kept as update-feed\/rc\.json\.tmp-[0-9a-f]{8}: re-run this publication/);
    expect(feedNames().filter(isTmp)).toHaveLength(1);
    // Another publication keeps writing an older feed onto the name: ours kept, and the error says so.
    reset();
    await feedAt('0.2.0');
    attached('0.2.1');
    gh.onDelete = (a) => {
      if (a.name === 'rc.json') addAsset('update-feed', 'rc.json', '{"version":"0.1.0","platforms":{}}', 'application/json');
      return false;
    };
    await expect(run(files('0.2.1'))).rejects.toThrow(/^could not replace update-feed\/rc\.json: another publication keeps writing an older feed there \(4 tries\)\. This run's feed of 0\.2\.1 is kept as update-feed\/rc\.json\.tmp-[0-9a-f]{8}: re-run/);
    expect(feedNames().filter(isTmp)).toHaveLength(1);
  });

  it('this version\'s feed entry is the one checked: its platform file read back must equal it (A-L1); a platform file raced at upload passes when the same, fails when not (B-L3)', async () => {
    attached('0.2.1');
    // Read back with another signature (a concurrent writer): nothing written to the feed.
    gh.before = (q) => {
      if (q.method === 'GET' && q.host === 'objects') {
        const a = gh.assets.find((x) => x.name === 'platform-darwin-aarch64.json');
        if (a && Number(q.path.split(/[/?]/)[1]) === a.id) a.body = Buffer.from(JSON.stringify({ signature: 'b3RoZXI=', url: dl('v0.2.1', 'Retake.app.tar.gz') }));
      }
      return undefined;
    };
    await expect(run(files('0.2.1'))).rejects.toThrow(/^v0\.2\.1\/platform-darwin-aarch64\.json read back is not the platform file checked here \(changed meanwhile\?\): nothing written to the feed — run this again$/);
    expect(releaseOf('update-feed')).toBeUndefined();
    // Read back as something that is not JSON: the same.
    reset();
    attached('0.2.1');
    gh.before = (q) => {
      const a = gh.assets.find((x) => x.name === 'platform-darwin-aarch64.json');
      if (q.method === 'GET' && q.host === 'objects' && a) a.body = Buffer.from('<html>');
      return undefined;
    };
    await expect(run(files('0.2.1'))).rejects.toThrow(/read back is not the platform file checked here/);
    expect(releaseOf('update-feed')).toBeUndefined();
    // Another run uploads the platform file between this run's check and its upload: the same entry passes ...
    reset();
    const f = attached('0.2.1');
    const same = JSON.stringify({ signature: readFileSync(f.signature, 'utf8').trim(), url: dl('v0.2.1', 'Retake.app.tar.gz') }, null, 2);
    gh.before = (q) => {
      if (q.method === 'POST' && q.path.endsWith('?name=platform-darwin-aarch64.json')) addAsset('v0.2.1', 'platform-darwin-aarch64.json', same, 'application/json');
      return undefined;
    };
    const r = await run(files('0.2.1'));
    expect(r.writes).toEqual(['update-feed/rc.json', 'update-feed/latest.json']);
    expect(assetJson('update-feed', 'latest.json').platforms['darwin-aarch64'].signature).toBe(readFileSync(f.signature, 'utf8').trim());
    // ... another one fails, before the feed.
    reset();
    attached('0.2.1');
    gh.before = (q) => {
      if (q.method === 'POST' && q.path.endsWith('?name=platform-darwin-aarch64.json')) addAsset('v0.2.1', 'platform-darwin-aarch64.json', '{"signature":"b3RoZXI=","url":"x"}', 'application/json');
      return undefined;
    };
    await expect(run(files('0.2.1'))).rejects.toThrow(/^0\.2\.1 was published meanwhile for darwin-aarch64 with another archive \(v0\.2\.1\/platform-darwin-aarch64\.json\)/);
    expect(releaseOf('update-feed')).toBeUndefined();
  });

  it('a half-uploaded file (GitHub\'s `starter` state) on the version\'s release is deleted and uploaded again; another one is left alone (A-L7)', async () => {
    addRelease('v0.2.1');
    const half = addAsset('v0.2.1', 'Retake.app.tar.gz', 'half an archi', 'application/octet-stream', 'starter');
    addAsset('v0.2.1', 'notes.txt', 'half', 'text/plain', 'starter');
    const r = await run(files('0.2.1'));
    expect(r.writes).toEqual(['v0.2.1/Retake.app.tar.gz', 'v0.2.1/Retake.app.tar.gz.sig', 'v0.2.1/platform-darwin-aarch64.json', 'update-feed/rc.json', 'update-feed/latest.json']);
    expect(writes()[0]).toBe(`DELETE /repos/${REPOSITORY}/releases/assets/${half.id}`);
    expect(gh.assets.find((a) => a.name === 'Retake.app.tar.gz')!.body.equals(archive)).toBe(true);
    expect(names('v0.2.1')).toEqual(['Retake.app.tar.gz', 'Retake.app.tar.gz.sig', 'notes.txt', 'platform-darwin-aarch64.json']);
    expect(gh.logs.join('\n')).toMatch(/removed v0\.2\.1\/Retake\.app\.tar\.gz: a half-uploaded file \(an interrupted upload, never downloadable\) — uploaded again/);
  });

  it('reading a file follows up to three redirects, https only, never with the token; the release\'s upload address must be the API\'s upload host (B-L1, A-L4)', async () => {
    attached('0.2.1');
    gh.hops = 2;
    await run(files('0.2.1'));
    const storage = gh.requests.filter((q) => q.host === 'objects');
    expect(storage.some((q) => q.path.endsWith('hops=0'))).toBe(true);
    expect(storage.every((q) => q.auth === undefined)).toBe(true);
    gh.hops = 3;
    gh.requests.length = 0;
    await expect(run(files('0.2.1'))).rejects.toThrow(/platform-darwin-aarch64\.json: GitHub redirected its download more than 3 times/);
    expect(writes()).toEqual([]);
    // An http hop after an https one: refused.
    gh.hops = 1;
    gh.before = (q) => (q.host === 'objects' && q.path.endsWith('hops=0') ? { status: 302, headers: { location: 'http://objects.github.test/1' } } : undefined);
    await expect(run(files('0.2.1'))).rejects.toThrow(/redirected its download to a non-https address/);
    // A release naming another upload host: refused before the token goes there.
    reset();
    addRelease('v0.2.1');
    gh.uploads = 'https://elsewhere.github.test';
    await expect(run(files('0.2.1'))).rejects.toThrow(/the release's upload address is not on https:\/\/uploads\.github\.test, the API's upload host \(https:\/\/elsewhere\.github\.test\): refused/);
    expect(gh.requests.filter((q) => q.host === 'elsewhere')).toEqual([]);
  });

  it('creating update-feed: a 422 is "exists" only when GitHub says already_exists (then a draft is said), any other is the error (B-L2); a feed release that is not a pre-release is warned about', async () => {
    attached('0.2.1');
    gh.before = (q) => (q.method === 'POST' && q.path === `/repos/${REPOSITORY}/releases` ? { status: 422, body: { message: 'Validation Failed', errors: [{ resource: 'Release', code: 'invalid', field: 'make_latest' }] } } : undefined);
    await expect(run(files('0.2.1'))).rejects.toThrow(/^POST \/repos\/example-owner\/example-repo\/releases: 422 \{"message":"Validation Failed","errors":\[\{"resource":"Release","code":"invalid","field":"make_latest"\}\]\}$/);
    gh.before = null;
    addRelease('update-feed', { draft: true });
    await expect(run(files('0.2.1'))).rejects.toThrow(/a release update-feed exists but is not published \(a draft\?\)/);
    reset();
    attached('0.2.1');
    addRelease('update-feed', { prerelease: false });
    await run(files('0.2.1'));
    expect(gh.logs.join('\n')).toMatch(/warning: the update-feed release is not a pre-release — GitHub may show it as the latest release/);
  });

  it('assets past the first hundred are seen (pagination); a file read back over 1 MiB is refused, announced or not (B-L3)', async () => {
    addRelease('v0.2.1');
    for (let i = 0; i < 120; i++) addAsset('v0.2.1', `extra-${i}.txt`, 'x', 'text/plain');
    const f = files('0.2.1');
    addAsset('v0.2.1', 'Retake.app.tar.gz', readFileSync(f.artifact));
    addAsset('v0.2.1', 'Retake.app.tar.gz.sig', readFileSync(f.signature), 'text/plain');
    const r = await run(f);
    expect(r.writes).toEqual(['v0.2.1/platform-darwin-aarch64.json', 'update-feed/rc.json', 'update-feed/latest.json']);
    expect(gh.requests.some((q) => /\/assets\?per_page=100&page=2$/.test(q.path))).toBe(true);
    // An oversized platform file: refused by its Content-Length, and without one by what arrives.
    reset();
    attached('0.2.1');
    addAsset('v0.2.1', 'platform-darwin-aarch64.json', Buffer.alloc(pub.JSON_MAX + 1, 0x20), 'application/json');
    await expect(run(files('0.2.1'))).rejects.toThrow(/^platform-darwin-aarch64\.json is larger than 1048576 bytes \(1048577 announced\)$/);
    gh.chunked = true;
    await expect(run(files('0.2.1'))).rejects.toThrow(/^platform-darwin-aarch64\.json is larger than 1048576 bytes$/);
    expect(writes()).toEqual([]);
  });

  it('a channel kept at a version with no published release (a feed that freezes every app) is a ::warning:: of a green run; a real newer version is not (A-L2)', async () => {
    attached('0.2.1');
    addRelease('update-feed', { prerelease: true });
    addAsset('update-feed', 'rc.json', '{"version":"999.0.0","platforms":{}}', 'application/json');
    addAsset('update-feed', 'latest.json', '{"version":"999.0.0","platforms":{}}', 'application/json');
    const r = await run(files('0.2.1'));
    expect(r.channels).toEqual({ 'rc.json': 'kept 999.0.0', 'latest.json': 'kept 999.0.0' });
    expect(r.warnings).toHaveLength(2);
    expect(r.warnings[0]).toBe(pub.frozen('rc.json', '999.0.0', REPOSITORY));
    expect(r.warnings[0]).toMatch(/^update-feed\/rc\.json names 999\.0\.0, newer than this version, but example-owner\/example-repo has no published release v999\.0\.0: every app reading rc\.json is stuck .* stays green .* delete the wrong rc\.json, then re-run the publish job of the newest real version$/);
    expect(gh.logs.filter((l) => l.startsWith('::warning::update-feed/'))).toHaveLength(2);
    // The command line prints it at the start of a line (GitHub's annotation) and exits 0: tested through publish's log.
    reset();
    attached('0.3.0');
    await run(files('0.3.0'));
    attached('0.2.1');
    expect((await run(files('0.2.1'))).warnings).toEqual([]);
  });
});
