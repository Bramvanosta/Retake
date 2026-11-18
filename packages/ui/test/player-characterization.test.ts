/**
 * The player origin and the preview's held components, pinned as they answer (characterization, written before the
 * Studio's player stopped reading the editor and the components itself; nothing here may change with that move):
 * - ⚑ every answer's exact headers and body — the frame, its scripts, a plan, a file (200, 206, HEAD, 304, 416), a
 *   refusal of the gate (421, 405, 403), an unknown URL (404) and a failure (500);
 * - ⚑ the content type of every extension the player serves, `application/octet-stream` for any other;
 * - ⚑ the Range forms (one range, a suffix, an open end, past the end, several ranges, another unit);
 * - ⚑ who may fetch what: a capability of the wrong length or characters, an absolute path, an encoded or plain `..`,
 *   a doubled slash, a released (expired) capability, another scope's capability — 404 each, with no CORS header;
 * - ⚑ the held components: a workspace component's hash is the editor's folder content hash of its id, entry and
 *   defaults; the allow decision is asked for workspace components only, with (id, hash); built-ins and the per-kind
 *   scaffolds are always in the set; `held` is sorted;
 * - ⚑ a preview plan that names a file the scope cannot serve is refused with the editor's PreviewPlanError, and so is a
 *   component preview naming a path of this Mac.
 */
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingHttpHeaders } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadComponentRegistry, paramDefaults, scaffoldDir } from '@retake/components';
import type { JsonSchemaNode } from '@retake/components';
import { componentFolderHash } from '@retake/editor';
import type { ComponentPreviewSpec, EditPlan } from '@retake/editor/plan';
import { checkPreviewSpec, startPlayerServer } from '../src/server/player.js';
import type { PlayerServer } from '../src/server/player.js';
import { playerComponentSet, workspaceComponents } from '../src/player/bundle-player.js';
import type { PlayerBundle } from '../src/player/bundle-player.js';
import { raw } from '@retake/test-support/http';

const STUDIO_PORT = 4998;
const BUNDLE: PlayerBundle = { hash: 'fedcba9876543210', js: Buffer.from('/* b */'), boot: Buffer.from('/* boot */'), components: [], excluded: [], held: [], ms: 0 };
const COMMON = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-dns-prefetch-control': 'off', 'cross-origin-resource-policy': 'cross-origin' };
const MEDIA = {
  'access-control-allow-origin': 'null',
  'access-control-expose-headers': 'Content-Length, Content-Range, Accept-Ranges',
  'cache-control': 'private, max-age=86400, immutable',
  'content-security-policy': "default-src 'none'; sandbox",
};
const NOT_FOUND = { ...COMMON, 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'content-length': '9' };
/** Every extension the player names a type for (anything else: application/octet-stream). */
const TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.json': 'application/json',
};

let root: string;
let run: string;
let outside: string;
let player: PlayerServer;
let failBundle = false;
const logs: string[] = [];

const capOf = (url: string) => /\/(?:s|m)\/([A-Za-z0-9_-]{43})\//.exec(url)![1];
const pathOf = (url: string) => new URL(url).pathname;
const get = (path: string, headers: Record<string, string> = {}, method = 'GET') => raw(player.port, method, path, headers);
/** The headers this server chose: the transport's own (date, connection, keep-alive) left out. */
const own = (h: IncomingHttpHeaders) => Object.fromEntries(Object.entries(h).filter(([k]) => !['date', 'connection', 'keep-alive', 'transfer-encoding'].includes(k)));

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'retake-player-char-'));
  run = join(root, 'run');
  outside = join(root, 'outside');
  await mkdir(run, { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(run, 'capture.mp4'), Buffer.alloc(1000, 7));
  await writeFile(join(outside, 'secret.txt'), 'SECRET');
  player = await startPlayerServer({
    studioPort: STUDIO_PORT,
    bundle: async () => {
      if (failBundle) throw new Error('no bundle');
      return BUNDLE;
    },
    log: (m) => logs.push(m),
  });
});

afterAll(async () => {
  await player?.close();
  if (root) await rm(root, { recursive: true, force: true });
});

describe('the player origin, answer by answer', () => {
  it('⚑ the frame, its scripts and a plan: exact headers and bodies', async () => {
    const url = player.frameUrl();
    const cap = capOf(url);
    const frame = await get(pathOf(url));
    expect(frame.status).toBe(200);
    expect(own(frame.headers)).toEqual({
      ...COMMON,
      'content-security-policy': expect.stringMatching(/^default-src 'none'; script-src /),
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': String(Buffer.byteLength(frame.body)),
    });
    const head = await get(pathOf(url), {}, 'HEAD');
    expect([head.status, head.body, own(head.headers)]).toEqual([200, '', own(frame.headers)]);
    for (const [name, body] of [
      ['b', '/* b */'],
      ['boot', '/* boot */'],
    ] as const) {
      const s = await get(`/s/${cap}/${name}.${BUNDLE.hash}.js`, { origin: 'null' });
      expect([s.status, s.body]).toEqual([200, body]);
      expect(own(s.headers)).toEqual({ ...COMMON, 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'private, max-age=86400, immutable', 'content-length': String(body.length) });
    }
    const plan = { assets: { 'retake-asset:capture': join(run, 'capture.mp4') }, source: { file: join(run, 'capture.mp4'), url: 'retake-asset:capture' }, segments: [] } as unknown as EditPlan;
    const pub = await player.publish({ plan, folders: { project: root, run, theme: run } }, { forbid: [root] });
    const p = await get(pathOf(pub.plan_url), { origin: 'null' });
    expect(p.status).toBe(200);
    expect(own(p.headers)).toEqual({ ...COMMON, ...MEDIA, 'content-type': 'application/json; charset=utf-8', 'content-length': String(Buffer.byteLength(p.body)) });
    expect(Object.keys(p.json()).sort()).toEqual(['segments', 'source']);
  });

  it('⚑ a file: 200, HEAD, 206, 304, 416 — exact headers', async () => {
    const url = player.register(join(run, 'capture.mp4'), [run])!;
    const path = pathOf(url);
    const id = path.split('/')[3];
    const base = { ...COMMON, ...MEDIA, 'content-type': 'video/mp4', 'accept-ranges': 'bytes', etag: `"${id}"` };
    const full = await get(path);
    expect([full.status, own(full.headers)]).toEqual([200, { ...base, 'content-length': '1000' }]);
    const head = await get(path, {}, 'HEAD');
    expect([head.status, head.body, own(head.headers)]).toEqual([200, '', { ...base, 'content-length': '1000' }]);
    const part = await get(path, { range: 'bytes=10-19' });
    expect([part.status, own(part.headers)]).toEqual([206, { ...base, 'content-length': '10', 'content-range': 'bytes 10-19/1000' }]);
    const same = await get(path, { 'if-none-match': `"${id}"` });
    expect([same.status, same.body, own(same.headers)]).toEqual([304, '', base]);
    const past = await get(path, { range: 'bytes=5000-' });
    expect([past.status, own(past.headers)]).toEqual([416, { ...base, 'content-range': 'bytes */1000', 'content-length': '0' }]);
  });

  it('⚑ the Range forms', async () => {
    const path = pathOf(player.register(join(run, 'capture.mp4'), [run])!);
    const cases: Array<[string, number, string | undefined, string]> = [
      ['bytes=0-0', 206, 'bytes 0-0/1000', '1'],
      ['bytes=-10', 206, 'bytes 990-999/1000', '10'],
      ['bytes=-5000', 206, 'bytes 0-999/1000', '1000'],
      ['bytes=990-', 206, 'bytes 990-999/1000', '10'],
      ['bytes=990-5000', 206, 'bytes 990-999/1000', '10'],
      ['bytes=0-1,5-6', 416, 'bytes */1000', '0'],
      ['items=0-1', 200, undefined, '1000'],
      ['bytes=-0', 416, 'bytes */1000', '0'],
      ['bytes=-', 416, 'bytes */1000', '0'],
      ['bytes=9-2', 416, 'bytes */1000', '0'],
      ['bytes=1000-', 416, 'bytes */1000', '0'],
      ['bytes=x-y', 416, 'bytes */1000', '0'],
    ];
    for (const [range, status, contentRange, length] of cases) {
      const r = await get(path, { range });
      expect([r.status, r.headers['content-range'], r.headers['content-length']], range).toEqual([status, contentRange, length]);
    }
  });

  it('⚑ the content type of every served extension; any other is application/octet-stream', async () => {
    const files = { ...TYPES, '.txt': 'application/octet-stream', '.html': 'application/octet-stream', '.js': 'application/octet-stream', '': 'application/octet-stream' };
    for (const [ext, type] of Object.entries(files)) {
      const file = join(run, `f${ext.replace('.', '-')}${ext.toUpperCase()}`);
      await writeFile(file, 'x');
      const url = player.register(file, [run])!;
      const r = await get(pathOf(url));
      expect([r.status, r.headers['content-type']], ext).toEqual([200, type]);
    }
  });

  it('⚑ refusals of the gate and unknown URLs: exact headers and bodies', async () => {
    const path = pathOf(player.frameUrl());
    const gate = { ...COMMON, 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' };
    // The gate's refusals are written whole, with no length (chunked) and `Connection: close`.
    const host = await get(path, { host: `elsewhere.test:${player.port}` });
    expect([host.status, own(host.headers), host.headers.connection]).toEqual([421, gate, 'close']);
    const method = await get(path, {}, 'POST');
    expect([method.status, own(method.headers)]).toEqual([405, { ...gate, allow: 'GET, HEAD' }]);
    const origin = await get(path, { origin: 'http://elsewhere.test' });
    expect([origin.status, origin.body, own(origin.headers)]).toEqual([403, 'a request from another page is refused', gate]);
    // Outside /s/ and /m/: the gate's own 404; inside: the player's.
    for (const p of ['/', '/v1/info', '/frame', '/x/m/']) {
      const r = await get(p);
      expect([r.status, r.body, own(r.headers)], p).toEqual([404, 'no such route', gate]);
    }
    for (const p of ['/s/', '/m/', '/s/x/frame', '/m/plan/x.json']) {
      const r = await get(p);
      expect([r.status, r.body, own(r.headers)], p).toEqual([404, 'not found', NOT_FOUND]);
    }
  });

  it('⚑ a failure: 500, exact headers, the route family only in the log', async () => {
    failBundle = true;
    try {
      const r = await get(pathOf(player.frameUrl()));
      expect([r.status, r.body, own(r.headers)]).toEqual([500, 'internal error', { ...COMMON, 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }]);
      expect(logs.at(-1)).toBe('retake player: a frame request failed: Error');
    } finally {
      failBundle = false;
    }
  });

  it('⚑ who may fetch what: wrong, released or foreign capabilities, absolute paths, traversal, links → 404 with no CORS', async () => {
    await symlink(join(outside, 'secret.txt'), join(run, 'link.mp4'));
    expect(player.register(join(run, 'link.mp4'), [run])).toBeUndefined();
    expect(player.register(join(outside, 'secret.txt'), [run])).toBeUndefined();
    expect(player.register(join(run, '..', 'outside', 'secret.txt'), [run])).toBeUndefined();
    expect(player.register(join(run, 'capture.mp4'), [])).toBeUndefined();
    const url = player.register(join(run, 'capture.mp4'), [run], 'scope-a')!;
    const path = pathOf(url);
    const cap = capOf(url);
    const id = path.split('/')[3];
    const other = pathOf(player.register(join(run, 'capture.mp4'), [run], 'scope-b')!);
    expect((await get(path)).status).toBe(200);
    // Outside /s/ and /m/ (an absolute path, a doubled slash first): the gate's 404.
    for (const p of [join(outside, 'secret.txt'), `//${root}/outside/secret.txt`]) {
      const r = await get(p);
      expect([r.status, r.body], p).toEqual([404, 'no such route']);
      expect(r.headers['access-control-allow-origin'], p).toBeUndefined();
    }
    for (const p of [
      path.replace(cap, cap.slice(0, 42)),
      path.replace(cap, `${cap.slice(0, 42)}!`),
      path.replace(cap, `${cap}A`),
      path.replace(cap, capOf(other)),
      other.replace(capOf(other), cap),
      `/m/${cap}/${id}/${join(outside, 'secret.txt')}`,
      `/m/${cap}/${encodeURIComponent(join(outside, 'secret.txt'))}`,
      `/m/${cap}//${id}/capture.mp4`,
      `/m/${cap}/${id}//capture.mp4`,
      `/m/${cap}/${id}/%2e%2e%2fsecret.txt`,
      `/m/${cap}/${id}/..`,
      `/m/${cap}/${id}/capture.mp4/`,
      `/m/${cap}/${id}/CAPTURE.mp4`,
      `/s/${cap}/../m/${cap}/${id}/capture.mp4`,
    ]) {
      const r = await get(p);
      expect([r.status, r.body], p).toEqual([404, 'not found']);
      expect(r.headers['access-control-allow-origin'], p).toBeUndefined();
    }
    // A query string does not change what is served.
    expect((await get(`${path}?x=1`)).status).toBe(200);
    // Released: the capability has expired, every URL of the scope answers 404; the other scope still serves.
    player.release('scope-a');
    for (const p of [path, `/s/${cap}/frame`, `/s/${cap}/b.${BUNDLE.hash}.js`]) expect((await get(p)).status, p).toBe(404);
    expect((await get(other)).status).toBe(200);
    player.release('scope-b');
  });

  it("⚑ a plan naming a file the scope cannot serve, a spec naming this Mac's path: the editor's PreviewPlanError", async () => {
    const plan = { assets: { 'retake-asset:secret': join(outside, 'secret.txt') }, source: { url: 'retake-asset:secret' }, segments: [] } as unknown as EditPlan;
    const e = await player.publish({ plan, folders: { project: run, run, theme: run } }, { forbid: [root] }).then(
      () => new Error('published'),
      (x: unknown) => x as Error,
    );
    expect([e.name, e.message]).toEqual(['PreviewPlanError', 'no preview URL for retake-asset:secret']);
    const spec = { a: join(outside, 'secret.txt') } as unknown as ComponentPreviewSpec;
    const s = await checkPreviewSpec(spec, `${player.origin}/m/x/`, []).catch((x: unknown) => x as Error);
    expect([s?.name, s?.message]).toEqual(['PreviewPlanError', 'spec.a is a path of this Mac']);
    const pub = await player.publishPreview(spec, { forbid: [] }).catch((x: unknown) => x as Error);
    expect((pub as Error).name).toBe('PreviewPlanError');
  });
});

describe('the held components', () => {
  let ws: string;
  beforeAll(async () => {
    ws = await mkdtemp(join(tmpdir(), 'retake-player-held-'));
    await writeFile(join(ws, 'retake.yaml'), 'version: 1\nprojects_dir: projects\n');
    for (const name of ['zeta', 'alpha']) {
      const dir = join(ws, 'components', 'acme', name);
      await mkdir(dir, { recursive: true });
      await cp(scaffoldDir('card'), dir, { recursive: true });
      await writeFile(join(dir, 'component.yaml'), (await readFile(join(dir, 'component.yaml'), 'utf8')).replace(/^id: .*$/m, `id: acme/${name}`));
    }
  });
  afterAll(async () => {
    if (ws) await rm(ws, { recursive: true, force: true });
  });

  it("⚑ a workspace component's hash is the editor's folder content hash; the allow decision is asked of workspace components only", async () => {
    const registry = await loadComponentRegistry({ root: ws });
    const listed = await workspaceComponents(registry);
    const expected = await Promise.all(
      registry
        .list()
        .filter((i) => i.source === 'workspace')
        .map(async (i) => ({
          id: i.manifest.id,
          kind: i.manifest.kind,
          hash: await componentFolderHash({ id: i.manifest.id, dir: i.dir, entry: i.entry, defaults: paramDefaults(i.manifest.params as JsonSchemaNode | undefined) }),
          // Where it comes from (the Allow callout words it by origin).
          source: 'workspace',
        })),
    );
    expect(listed).toEqual(expected);
    expect(listed.map((c) => c.id).sort()).toEqual(['acme/alpha', 'acme/zeta']);
    const asked: Array<[string, string]> = [];
    const set = await playerComponentSet(registry, (id, hash) => {
      asked.push([id, hash]);
      return id === 'acme/alpha';
    });
    expect(asked.sort()).toEqual(listed.map((c) => [c.id, c.hash] as [string, string]).sort());
    expect(set.held).toEqual(['acme/zeta']);
    const ids = set.components.map((c) => c.id);
    expect(ids).toContain('acme/alpha');
    expect(ids).not.toContain('acme/zeta');
    expect(ids.filter((i) => i.startsWith('studio/')).length).toBe(registry.list().filter((i) => i.source !== 'workspace').length);
    expect(set.components.filter((c) => c.scaffold).map((c) => c.id)).toEqual(expect.arrayContaining(['scaffolds/card', 'scaffolds/layout']));
    expect(set.components.slice(-set.components.filter((c) => c.scaffold).length).every((c) => c.scaffold)).toBe(true);
    const all = await playerComponentSet(registry);
    expect(all.held).toEqual([]);
    expect(all.components.map((c) => c.id)).toEqual(expect.arrayContaining(['acme/alpha', 'acme/zeta']));
    const none = await playerComponentSet(registry, () => false);
    expect(none.held).toEqual(['acme/alpha', 'acme/zeta']);
  });
});
