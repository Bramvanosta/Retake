/**
 * L4.5 part B: the player origin (src/server/player.ts) over raw HTTP — the second loopback listener that serves the
 * sandboxed preview frame, its scripts, preview plans and media under one session capability:
 * - ⚑ the gate: Host exactly 127.0.0.1 / localhost:<Q> (421), GET / HEAD only, Origin absent / null / own (403);
 * - ⚑ the frame document's exact CSP (sandbox, no connect beyond the capability's /m/, frame-ancestors = the Studio),
 *   its companions, no inline script; CORS only on /m/;
 * - ⚑ registration only of files inside the given folders, never through a link; ⚑ a registered file swapped for a
 *   link, a FIFO or other bytes since → 404; Range, HEAD, ETag, immutable caching;
 * - stable file URLs across plans (critique B6), the plan served from memory without a path (B4); unknown capability,
 *   file, hash or name → 404, traversal included; rotate / close revoke every URL;
 * - ⚑ the error log names the route family only (never the capability or a path: critique B16);
 * - L4.5 fixes: ⚑ Trusted Types in the frame CSP (review A H1 b); ⚑ CORS for the opaque frame only (`null`), a
 *   capability per scope (project) that `release` revokes (review A L3); ⚑ no hard link registered or served (A N4);
 * - the Studio frames the player origin and only it (frame-src), and never sends an Access-Control-* header.
 */
import { execFileSync } from 'node:child_process';
import { link, mkdir, mkdtemp, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { studioCsp } from '@retake/engine';
import type { EditPlan } from '@retake/editor';
import { startStudioServer } from '../src/index.js';
import { frameCsp, startPlayerServer } from '../src/server/player.js';
import type { PlayerServer } from '../src/server/player.js';
import type { PlayerBundle } from '../src/player/bundle-player.js';
import { raw } from '@retake/test-support/http';
import { scratchHome } from '@retake/test-support/home';

const STUDIO_PORT = 4999;
const BUNDLE: PlayerBundle = { hash: '0123456789abcdef', js: Buffer.from('/* the frame bundle */'), boot: Buffer.from('/* boot */'), components: [], excluded: [], held: [], ms: 0 };
let root: string;
let dirs: { project: string; run: string; theme: string; outside: string };
let player: PlayerServer;
const logs: string[] = [];
let failBundle = false;
const CAPTURE = randomBytes(10_000);

const capOf = (url: string) => /\/(?:s|m)\/([A-Za-z0-9_-]{43})\//.exec(url)![1];
const pathOf = (url: string) => new URL(url).pathname;
const get = (path: string, headers: Record<string, string> = {}, method = 'GET') => raw(player.port, method, path, headers);

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'ds-player-'));
  dirs = { project: join(root, 'p'), run: join(root, 'p', 'runs', 'r1'), theme: join(root, 'theme'), outside: join(root, 'outside') };
  for (const d of Object.values(dirs)) await mkdir(d, { recursive: true });
  await writeFile(join(dirs.run, 'capture.mp4'), CAPTURE);
  await writeFile(join(dirs.theme, 'Display Font (1).ttf'), 'font bytes');
  await writeFile(join(dirs.project, 'anim.json'), '{"v":"5"}');
  await writeFile(join(dirs.outside, 'secret.txt'), 'SECRET-OUTSIDE');
  await symlink(join(dirs.outside, 'secret.txt'), join(dirs.run, 'out-link.mp4'));
  await symlink(join(dirs.run, 'capture.mp4'), join(dirs.run, 'in-link.mp4'));
  player = await startPlayerServer({
    studioPort: STUDIO_PORT,
    bundle: async () => {
      if (failBundle) throw new Error(`cannot read ${root}/components`);
      return BUNDLE;
    },
    log: (m) => logs.push(m),
  });
});

afterAll(async () => {
  await player?.close();
  await rm(root, { recursive: true, force: true });
});

function plan(layout: string): EditPlan {
  return {
    assets: { 'ds-asset:capture': join(dirs.run, 'capture.mp4'), 'ds-asset:font': join(dirs.theme, 'Display Font (1).ttf') },
    source: { file: join(dirs.run, 'capture.mp4'), url: 'ds-asset:capture', fps: 30, width: 320, height: 180 },
    brand: { tokens: { font_faces: [{ family: 'Display', url: 'ds-asset:font', weight: 400, style: 'normal' }] } },
    segments: [
      { id: 'a', kind: 'clip', from: 0, durationInFrames: 30, component: { id: layout, kind: 'layout', params: {} }, urls: [{ frame: 0, url: 'http://localhost:4402/private', hidden: true }] },
    ],
    display: [{ note: `display of ${dirs.project}` }],
    notes: [`a note naming ${dirs.run}`],
    warnings: [`a warning naming ${root}`],
    durationInFrames: 30,
    fps: 30,
    width: 320,
    height: 180,
  } as unknown as EditPlan;
}

describe('the player origin', () => {
  it('⚑ the frame document: exact CSP with sandbox, its companions, no inline script, the Studio origins it may be framed by', async () => {
    const url = player.frameUrl();
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/s\/[A-Za-z0-9_-]{43}\/frame$/);
    const cap = capOf(url);
    const o = player.origin;
    const r = await get(pathOf(url));
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('text/html; charset=utf-8');
    const csp = `default-src 'none'; script-src ${o}/s/${cap}/; style-src 'unsafe-inline'; img-src ${o}/m/${cap}/ data:; media-src ${o}/m/${cap}/ data:; font-src ${o}/m/${cap}/ data:; connect-src ${o}/m/${cap}/; worker-src 'none'; frame-src 'none'; child-src 'none'; object-src 'none'; manifest-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors http://127.0.0.1:${STUDIO_PORT} http://localhost:${STUDIO_PORT}; sandbox allow-scripts; require-trusted-types-for 'script'; trusted-types 'none'`;
    expect(r.headers['content-security-policy']).toBe(csp);
    expect(frameCsp(o, cap, STUDIO_PORT)).toBe(csp);
    expect(r.headers).toMatchObject({ 'x-dns-prefetch-control': 'off', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' });
    expect(r.headers['x-frame-options']).toBeUndefined();
    expect(Object.keys(r.headers).filter((k) => k.startsWith('access-control-'))).toEqual([]);
    // Two scripts, both by URL under the capability; no inline script, no event handler attribute.
    expect([...r.body.matchAll(/<script([^>]*)>/g)].map((m) => m[1].trim())).toEqual([`src="/s/${cap}/boot.${BUNDLE.hash}.js"`, `src="/s/${cap}/b.${BUNDLE.hash}.js" defer`]);
    expect(r.body).not.toMatch(/<script[^>]*>[^<]+<\/script>|\son\w+=/);
    expect(r.body).toContain(`<meta name="ds-parent" content="http://127.0.0.1:${STUDIO_PORT} http://localhost:${STUDIO_PORT}">`);
    for (const name of ['boot', 'b']) {
      const s = await get(`/s/${cap}/${name}.${BUNDLE.hash}.js`, { origin: 'null', 'sec-fetch-site': 'cross-site' });
      expect(s.status).toBe(200);
      expect(s.body).toBe(name === 'b' ? '/* the frame bundle */' : '/* boot */');
      expect(s.headers).toMatchObject({ 'content-type': 'text/javascript; charset=utf-8', 'cross-origin-resource-policy': 'cross-origin', 'cache-control': 'private, max-age=86400, immutable' });
      expect(Object.keys(s.headers).filter((k) => k.startsWith('access-control-'))).toEqual([]);
    }
    expect((await get(`/s/${cap}/b.fedcba9876543210.js`)).status).toBe(404);
    expect((await get(pathOf(url), {}, 'HEAD')).status).toBe(200);
  });

  it('⚑ the gate: Host 421, methods 405, a foreign Origin 403; null and no Origin pass', async () => {
    const path = pathOf(player.frameUrl());
    expect((await get(path, { host: `rebind.test:${player.port}` })).status).toBe(421);
    expect((await get(path, { host: `127.0.0.1:${player.port + 1}` })).status).toBe(421);
    expect((await get(path, { host: `localhost:${player.port}` })).status).toBe(200);
    for (const m of ['POST', 'PUT', 'DELETE', 'OPTIONS']) expect((await get(path, { 'content-type': 'application/json' }, m)).status, m).toBe(405);
    for (const origin of [`http://127.0.0.1:${STUDIO_PORT}`, 'http://evil.example', 'NULL']) expect((await get(path, { origin })).status, origin).toBe(403);
    expect((await get(path, { origin: 'null' })).status).toBe(200);
    expect((await get('/v1/info')).status).toBe(404);
    expect((await get('/')).status).toBe(404);
  });

  it('⚑ registers only files inside the given folders, never a link, never a directory or a FIFO', async () => {
    const within = [dirs.project, dirs.run, dirs.theme];
    expect(player.register(join(dirs.run, 'capture.mp4'), within)).toMatch(/\/m\/[A-Za-z0-9_-]{43}\/[A-Za-z0-9_-]{22}\/capture\.mp4$/);
    expect(player.register(join(dirs.outside, 'secret.txt'), within)).toBeUndefined();
    expect(player.register(join(dirs.run, 'out-link.mp4'), within)).toBeUndefined();
    expect(player.register(join(dirs.run, 'in-link.mp4'), within)).toBeUndefined();
    expect(player.register(join(dirs.run, '..', '..', '..', 'outside', 'secret.txt'), within)).toBeUndefined();
    expect(player.register(dirs.run, [dirs.project])).toBeUndefined();
    expect(player.register(join(dirs.run, 'missing.mp4'), within)).toBeUndefined();
    execFileSync('mkfifo', [join(dirs.run, 'pipe.mp4')]);
    expect(player.register(join(dirs.run, 'pipe.mp4'), within)).toBeUndefined();
    await unlink(join(dirs.run, 'pipe.mp4'));
    // ⚑ Review A N4: a hard link inside the folders to a file outside them (two names, one file) is refused.
    await link(join(dirs.outside, 'secret.txt'), join(dirs.run, 'hard.mp4'));
    expect(player.register(join(dirs.run, 'hard.mp4'), within)).toBeUndefined();
    await unlink(join(dirs.run, 'hard.mp4'));
  });

  it('media: Range, HEAD, ETag, immutable caching, CORS only here; unknown capability / id / name and traversal 404', async () => {
    const url = player.register(join(dirs.run, 'capture.mp4'), [dirs.run])!;
    const path = pathOf(url);
    const [bytes0, ranges0] = [player.mediaBytesRead, player.rangeRequests];
    const full = await get(path, { origin: 'null' });
    expect(full.status).toBe(200);
    expect(Buffer.from(full.body, 'latin1').length).toBeGreaterThan(0);
    expect(full.headers).toMatchObject({
      'content-type': 'video/mp4',
      'accept-ranges': 'bytes',
      'access-control-allow-origin': 'null',
      'cache-control': 'private, max-age=86400, immutable',
      'content-length': '10000',
      'cross-origin-resource-policy': 'cross-origin',
    });
    expect(full.headers['access-control-expose-headers']).toBe('Content-Length, Content-Range, Accept-Ranges');
    expect(full.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
    const part = await get(path, { range: 'bytes=100-199' });
    expect(part.status).toBe(206);
    expect(part.headers['content-range']).toBe('bytes 100-199/10000');
    expect(part.headers['content-length']).toBe('100');
    const tail = await get(path, { range: 'bytes=-10' });
    expect(tail.headers['content-range']).toBe('bytes 9990-9999/10000');
    expect((await get(path, { range: 'bytes=20000-' })).status).toBe(416);
    const head = await get(path, {}, 'HEAD');
    expect([head.status, head.body]).toEqual([200, '']);
    expect((await get(path, { range: 'bytes=0-9' }, 'HEAD')).status).toBe(206);
    expect((await get(path, { 'if-none-match': String(full.headers.etag) })).status).toBe(304);
    // L5.2 (critique H3, review B L9): the bytes read for GET answers and the GET 206 answers are counted (HEAD — even
    // with a Range —, 304 and 416 read no media).
    expect([player.mediaBytesRead - bytes0, player.rangeRequests - ranges0]).toEqual([10000 + 100 + 10, 2]);
    const cap = capOf(url);
    const id = path.split('/')[3];
    const other = 'A'.repeat(43);
    for (const p of [
      path.replace(cap, other),
      path.replace(id, 'B'.repeat(22)),
      path.replace('capture.mp4', 'secret.txt'),
      `/m/${cap}/${id}/../../s/${cap}/frame`,
      `/m/${cap}/${id}/..%2f..%2fsecret.txt`,
      `/m/${cap}/../outside/secret.txt`,
      `/s/${other}/frame`,
      `/s/${cap}/frame/`,
      `/m/${cap}/plan/${'C'.repeat(22)}.json`,
    ]) {
      const r = await get(p);
      expect(r.status, p).toBe(404);
      expect(r.headers['access-control-allow-origin'], p).toBeUndefined();
    }
  });

  it('⚑ a registered file swapped for a link, a FIFO or other bytes since → 404 (and a new registration is a new URL)', async () => {
    const file = join(dirs.run, 'swap.mp4');
    await writeFile(file, 'first bytes');
    const url = player.register(file, [dirs.run])!;
    expect((await get(pathOf(url))).body).toBe('first bytes');
    await unlink(file);
    await symlink(join(dirs.outside, 'secret.txt'), file);
    const linked = await get(pathOf(url));
    expect(linked.status).toBe(404);
    expect(linked.body).not.toContain('SECRET');
    await unlink(file);
    execFileSync('mkfifo', [file]);
    expect((await get(pathOf(url))).status).toBe(404);
    await unlink(file);
    await writeFile(file, 'other bytes, other size');
    expect((await get(pathOf(url))).status).toBe(404);
    // ⚑ A registered file that gained a second name (a hard link made since) → 404.
    const kept = player.register(file, [dirs.run])!;
    expect((await get(pathOf(kept))).status).toBe(200);
    await link(file, join(dirs.outside, 'second-name.mp4'));
    expect((await get(pathOf(kept))).status).toBe(404);
    await unlink(join(dirs.outside, 'second-name.mp4'));
    const again = player.register(file, [dirs.run])!;
    expect(again).not.toBe(url);
    expect((await get(pathOf(again))).body).toBe('other bytes, other size');
  });

  it('publish: stable media URLs across plans, the plan from memory with no path, no hidden URL, no display / notes / warnings', async () => {
    const forbid = [root];
    const a = await player.publish({ plan: plan('studio/layout-card'), folders: { project: dirs.project, run: dirs.run, theme: dirs.theme } }, { forbid });
    const b = await player.publish({ plan: plan('studio/layout-laptop'), folders: { project: dirs.project, run: dirs.run, theme: dirs.theme } }, { forbid });
    expect(a.frame_url).toBe(player.frameUrl());
    expect(a.plan_url).toMatch(/\/m\/[A-Za-z0-9_-]{43}\/plan\/[A-Za-z0-9_-]{22}\.json$/);
    expect(b.plan_url).not.toBe(a.plan_url);
    const ra = await get(pathOf(a.plan_url), { origin: 'null', 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'cors' });
    expect(ra.status).toBe(200);
    // Review A L3: readable by the frame's opaque origin only (`null`), never by a page of a real origin (`*`).
    expect(ra.headers['access-control-allow-origin']).toBe('null');
    const pa = ra.json<{ source: { url: string; file?: string }; brand: { tokens: { font_faces: Array<{ url: string }> } }; segments: Array<{ urls: Array<{ url: string }> }> }>();
    const pb = (await get(pathOf(b.plan_url))).json<typeof pa>();
    // The same files: the same URLs (no <video> reloads on a switch).
    expect(pb.source.url).toBe(pa.source.url);
    expect(pa.source.url.startsWith(`${player.origin}/m/${capOf(a.plan_url)}/`)).toBe(true);
    expect(pa.brand.tokens.font_faces[0].url).toMatch(/\/Display_Font_1_\.ttf$/);
    expect(pa.source.file).toBeUndefined();
    expect(pa.segments[0].urls[0].url).toBe('');
    for (const bad of [root, 'ds-asset:', '"display"', '"notes"', '"warnings"', '"assets"', 'localhost:4402']) expect(ra.body, bad).not.toContain(bad);
    expect((await get(pathOf(pa.source.url), { range: 'bytes=0-9' })).status).toBe(206);
  });

  it('⚑ the error log names the route family only — never the capability or a path', async () => {
    failBundle = true;
    const url = player.frameUrl();
    const r = await get(pathOf(url));
    failBundle = false;
    expect(r.status).toBe(500);
    expect(logs.length).toBeGreaterThan(0);
    for (const line of logs) {
      expect(line).toBe('retake player: a frame request failed: Error');
      expect(line).not.toContain(capOf(url));
      expect(line).not.toContain(root);
    }
  });

  it("⚑ review A L3: a capability per scope (project) — one scope never reaches another's files; release revokes its URLs", async () => {
    const a = player.register(join(dirs.run, 'capture.mp4'), [dirs.run], 'proj-a')!;
    const b = player.register(join(dirs.theme, 'Display Font (1).ttf'), [dirs.theme], 'proj-b')!;
    expect(capOf(a)).not.toBe(capOf(b));
    expect(capOf(player.frameUrl('proj-a'))).toBe(capOf(a));
    expect((await get(pathOf(a), { range: 'bytes=0-9' })).status).toBe(206);
    // B's file under A's capability (and the other way round): 404.
    const idB = pathOf(b).split('/')[3];
    expect((await get(pathOf(b).replace(capOf(b), capOf(a)))).status).toBe(404);
    expect((await get(pathOf(a).replace(capOf(a), capOf(b)))).status).toBe(404);
    expect(idB).toMatch(/^[A-Za-z0-9_-]{22}$/);
    // A plan published in a scope is served under that scope's capability only.
    const pub = await player.publish({ plan: plan('studio/layout-card'), folders: { project: dirs.project, run: dirs.run, theme: dirs.theme } }, { forbid: [root], scope: 'proj-a' });
    expect(capOf(pub.plan_url)).toBe(capOf(a));
    expect(pub.frame_url).toBe(player.frameUrl('proj-a'));
    // release: every URL of the scope answers 404 (frame, plan, media); the other scope is untouched.
    const before = player.scopes;
    player.release('proj-a');
    expect(player.scopes).toBe(before - 1);
    for (const u of [a, pub.plan_url, pub.frame_url]) expect((await get(pathOf(u))).status, u).toBe(404);
    expect((await get(pathOf(b))).status).toBe(200);
    // Its next use is a new capability.
    expect(capOf(player.frameUrl('proj-a'))).not.toBe(capOf(a));
    player.release('proj-a');
    player.release('proj-b');
  });

  it('rotate and close revoke every URL', async () => {
    const before = player.frameUrl();
    const media = player.register(join(dirs.run, 'capture.mp4'), [dirs.run])!;
    player.rotate();
    expect(player.frameUrl()).not.toBe(before);
    expect((await get(pathOf(before))).status).toBe(404);
    expect((await get(pathOf(media))).status).toBe(404);
    expect((await get(pathOf(player.frameUrl()))).status).toBe(200);
    const p2 = await startPlayerServer({ studioPort: STUDIO_PORT, bundle: async () => BUNDLE });
    const f2 = p2.frameUrl();
    expect(capOf(f2)).not.toBe(capOf(player.frameUrl()));
    await p2.close();
    await expect(raw(p2.port, 'GET', pathOf(f2))).rejects.toThrow(/ECONNREFUSED/);
  });
});

describe('the Studio and its player origin', () => {
  it('⚑ the Studio frames exactly its player origin, never sends Access-Control-*, and closes the player with it', async () => {
    const ws = await mkdtemp(join(tmpdir(), 'ds-player-studio-'));
    const retakeHome = scratchHome();
    retakeHome.use(join(ws, '.home'));
    await writeFile(join(ws, 'retake.yaml'), 'version: 1\nprojects_dir: projects\n');
    const studio = await startStudioServer({ root: ws, startWorker: false });
    try {
      expect(studio.player.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(studio.player.port).not.toBe(studio.port);
      for (const r of [
        await raw(studio.port, 'GET', '/'),
        await raw(studio.port, 'GET', '/app.js'),
        await raw(studio.port, 'GET', '/v1/info'),
        await raw(studio.port, 'GET', '/v1/info', { origin: 'null' }),
      ]) {
        expect(r.headers['content-security-policy']).toBe(studioCsp(studio.player.origin));
        expect(r.headers['content-security-policy']).toContain(`frame-src ${studio.player.origin};`);
        expect(Object.keys(r.headers).filter((k) => k.startsWith('access-control-'))).toEqual([]);
      }
      // A request from another site is counted (and refused by the gate).
      expect(studio.crossSite).toBe(1);
      const frame = new URL(studio.player.frameUrl());
      // The frame of the Studio's player names the Studio's port as the only one allowed to frame it.
      const r = await raw(studio.player.port, 'HEAD', frame.pathname);
      expect(r.status).toBe(200);
      expect(r.headers['content-security-policy']).toContain(`frame-ancestors http://127.0.0.1:${studio.port} http://localhost:${studio.port};`);
    } finally {
      await studio.close();
      retakeHome.restore();
    }
    await expect(raw(studio.player.port, 'GET', '/')).rejects.toThrow(/ECONNREFUSED/);
    await rm(ws, { recursive: true, force: true });
  }, 60_000);
});
