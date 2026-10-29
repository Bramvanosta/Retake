/**
 * L4.1 part 1: the Studio server over HTTP — static app from memory, `/v1/info`, the one-time bootstrap code →
 * session token, `/v1/call/<op>` limited to UI_OPS through the MCP tool layer (README round trip and conflict, error
 * statuses), hostile requests WITH the valid token refused before any op runs (README bytes unchanged, op counter 0),
 * the bundle (no eval, no node built-in, size budget), one server per workspace through the discovery file, and the
 * MCP package's independence from this one (R-UI-01).
 */
import { readFile, readdir, rm, stat, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { discoveryFile, readDiscovery, sha256Hex, studioCsp } from '@demo-studio/engine';
import { TOOLS } from '@demo-studio/mcp';
import { CALL_BODY_MAX, INDEX_HTML, INDEX_OPS, OWN_OPS, UI_OPS, buildUi, launchStudio, startStudioServer, uiTools } from '../src/index.js';
import type { StudioServer } from '../src/index.js';
import { REPO, fixtureWorkspace } from '../../engine/test/helpers.js';
import { raw } from './http.js';

let ws: string;
let studio: StudioServer;
const savedHome = process.env.DEMO_STUDIO_HOME;
const README = () => join(ws, 'projects', 'northfield-fixture', 'README.md');

beforeAll(async () => {
  ws = await mkdtemp(join(tmpdir(), 'studio-ui-server-'));
  process.env.DEMO_STUDIO_HOME = join(ws, '.home');
  await fixtureWorkspace(ws);
  studio = await startStudioServer({ root: ws });
});

afterAll(async () => {
  await studio?.close();
  if (savedHome === undefined) delete process.env.DEMO_STUDIO_HOME;
  else process.env.DEMO_STUDIO_HOME = savedHome;
  if (ws) await rm(ws, { recursive: true, force: true });
});

const auth = () => ({ authorization: `Bearer ${studio.token}` });
const json = { 'content-type': 'application/json' };
const call = (op: string, args: unknown = {}, headers: Record<string, string> = {}) => raw(studio.port, 'POST', `/v1/call/${op}`, { ...auth(), ...json, ...headers }, JSON.stringify(args));

describe('static app from memory', () => {
  it('serves /, /app.js and /app.css with the CSP and an ETag; nothing else maps to a file', async () => {
    expect(studio.url).toBe(`http://127.0.0.1:${studio.port}/`);
    const index = await raw(studio.port, 'GET', '/');
    expect(index.status).toBe(200);
    expect(index.headers['content-type']).toBe('text/html; charset=utf-8');
    // L4.5: the CSP frames the player origin, and only it.
    expect(index.headers['content-security-policy']).toBe(studioCsp(studio.player.origin));
    expect(index.body).toBe(INDEX_HTML);
    expect((await raw(studio.port, 'GET', '/', { 'if-none-match': String(index.headers.etag) })).status).toBe(304);
    const js = await raw(studio.port, 'GET', '/app.js');
    expect(js.status).toBe(200);
    expect(js.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(js.headers['cache-control']).toBe('no-cache');
    expect((await raw(studio.port, 'GET', '/app.css')).headers['content-type']).toBe('text/css; charset=utf-8');
    expect((await raw(studio.port, 'GET', '/app.js?v=1')).status).toBe(200);
    for (const path of ['/../../etc/passwd', '/app.js%00', '/%2e%2e/package.json', '/src/app/main.tsx', '/index.html', '//app.js', '/app.js/']) {
      expect((await raw(studio.port, 'GET', path)).status, path).toBe(404);
    }
    expect(Object.keys(index.headers).filter((k) => k.startsWith('access-control-'))).toEqual([]);
  });

  it('the bundle: no eval, no node built-in, under 700 KB; the document has no inline script or style', async () => {
    const t = Date.now();
    const assets = await buildUi();
    expect(Date.now() - t).toBeLessThan(5000);
    const js = assets.get('/app.js')!.bytes.toString('utf8');
    // L4.5 part E: the render queue and review (≈ 15 KB minified) took the app past 400 KB (413 KB then).
    // L4.5 review: tightened to 430 KB (≈ 415 KB after the fixes).
    // L4.6 part D1: the Comments screen (list, frame viewer, region, composer, thread) — 455.5 KB; room for the proposal view.
    // L4.7 part D2: the theme screens (list, editor, New theme, site panel) — ≈ 569 KB.
    expect(js.length).toBeLessThan(700_000);
    expect(js).not.toMatch(/\beval\(|new Function\(/);
    expect(js).not.toMatch(/(?:from|import)\s*\(?\s*["']node:/);
    expect(INDEX_HTML).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>|<style|\sstyle=|\son[a-z]+=/i);
  });
});

describe('/v1/info and the session', () => {
  it('/v1/info: engine info, HTTP API 1, the allowed ops; client ui; 401 without the token', async () => {
    const r = await raw(studio.port, 'GET', '/v1/info', auth());
    expect(r.status).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    const data = r.json<{ data: { ops: string[]; http_api: number; client: string; root: string } }>().data;
    expect(data.ops).toEqual([...UI_OPS]);
    expect(data.http_api).toBe(1);
    expect(data.client).toBe('ui');
    expect(data.root).toBe(studio.engine.root);
    expect((await raw(studio.port, 'GET', '/v1/info')).status).toBe(401);
  });

  it('/v1/info counters (L5.2, critique H3): sessions redeemed, streams open, player media — numbers only, a redeemed code counts once', async () => {
    type Counters = { sessions: number; streams: number; player_media_bytes_read: number; player_range_requests: number };
    const counters = async () => (await raw(studio.port, 'GET', '/v1/info', auth())).json<{ data: { counters: Counters } }>().data.counters;
    const before = await counters();
    expect(Object.keys(before).sort()).toEqual(['player_media_bytes_read', 'player_range_requests', 'sessions', 'streams']);
    for (const v of Object.values(before)) expect(Number.isInteger(v) && v >= 0).toBe(true);
    const code = studio.mintCode();
    expect((await raw(studio.port, 'POST', '/v1/session', json, JSON.stringify({ code }))).status).toBe(200);
    expect((await raw(studio.port, 'POST', '/v1/session', json, JSON.stringify({ code }))).status).toBe(401);
    expect((await counters()).sessions).toBe(before.sessions + 1);
    expect(studio.sessions).toBe(before.sessions + 1);
  });

  it('a bootstrap code gives the token once; a cross-site attempt is refused before the code is spent', async () => {
    const code = studio.mintCode();
    const site = await raw(studio.port, 'POST', '/v1/session', { ...json, 'sec-fetch-site': 'same-site', origin: `http://127.0.0.1:${studio.port + 1}` }, JSON.stringify({ code }));
    expect(site.status).toBe(403);
    expect(site.body).not.toContain(studio.token);
    const ok = await raw(studio.port, 'POST', '/v1/session', { ...json, 'sec-fetch-site': 'same-origin', origin: `http://127.0.0.1:${studio.port}` }, JSON.stringify({ code }));
    expect(ok.status).toBe(200);
    expect(ok.json<{ token: string }>().token).toBe(studio.token);
    const again = await raw(studio.port, 'POST', '/v1/session', json, JSON.stringify({ code }));
    expect(again.status).toBe(401);
    expect(again.body).not.toContain(studio.token);
    for (const body of [JSON.stringify({ code: 'nope' }), '{}', JSON.stringify({ code: studio.token })]) {
      expect((await raw(studio.port, 'POST', '/v1/session', json, body)).status).toBe(401);
    }
    expect((await raw(studio.port, 'POST', '/v1/session', { 'content-type': 'text/plain' }, JSON.stringify({ code: studio.mintCode() }))).status).toBe(415);
    const launch = studio.launchUrl();
    expect(launch).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${studio.port}/#c=[A-Za-z0-9_-]{43}$`));
  });

  it('/v1/bootstrap mints a code for a token holder only', async () => {
    expect((await raw(studio.port, 'POST', '/v1/bootstrap', json, '{}')).status).toBe(401);
    const r = await raw(studio.port, 'POST', '/v1/bootstrap', { ...auth(), ...json }, '{}');
    expect(r.status).toBe(200);
    const { code, url, player } = r.json<{ code: string; url: string; player: string }>();
    expect(url).toBe(`${studio.url}#c=${code}`);
    expect(player).toBe(studio.player.origin);
    expect((await raw(studio.port, 'POST', '/v1/session', json, JSON.stringify({ code }))).status).toBe(200);
  });
});

describe('/v1/call/<op>: the allow-list through the MCP tool layer', () => {
  it("every UI op is an MCP tool or one of the Studio's own reads (never an MCP name); any other tool is 404 unknown op and runs nothing", async () => {
    const names = new Set(TOOLS.map((t) => t.name));
    for (const op of UI_OPS) expect(names.has(op) !== (OWN_OPS as readonly string[]).includes(op), op).toBe(true);
    expect([...INDEX_OPS]).toEqual(['activity_list', 'search']);
    expect([...OWN_OPS]).toEqual(['activity_list', 'search', 'projects_overview', 'scenario_blocks', 'run_thumbs', 'scenario_forms', 'scenario_run', 'scenario_edit', 'run_pause', 'scenario_sessions', 'sign_in_cancel', 'timeline_view', 'timeline_leave', 'preview_allow', 'scenario_render', 'scenario_renders', 'render_cancel', 'render_review', 'review_image', 'threads_list', 'threads_counts', 'thread_get', 'thread_still', 'render_outline', 'render_frame', 'frame_anchor', 'thread_add', 'thread_reply', 'thread_resolve', 'thread_reopen', 'thread_apply', 'library_view', 'library_images', 'library_render', 'library_component', 'theme_list', 'theme_view', 'theme_edit', 'theme_copy', 'theme_create', 'brand_files', 'site_list', 'theme_preview', 'record_options', 'record_start', 'record_view', 'record_annotate', 'record_stop', 'record_discard', 'record_save']);
    expect(() => uiTools([{ ...TOOLS.find((t) => t.name === 'run_capture')! }])).toThrow(/shadow/);
    const before = studio.calls;
    for (const op of ['run_capture', 'run_dry', 'hooks_run', 'job_cancel', 'project_create', 'scenario_save', 'sandbox_reset', 'template_from_site', 'comment_reply', 'template_create_from_brand', 'component_preview', 'scenario_record']) {
      const r = await call(op, {});
      expect(r.status, op).toBe(404);
      expect(r.json<{ error: { message: string } }>().error.message).toContain('unknown op');
    }
    expect((await call('Project_List')).status).toBe(404);
    expect((await call('project_list/x')).status).toBe(404);
    expect(studio.calls).toBe(before);
  });

  it('project_list, project_get, job_list, engine_info answer like the MCP tools (data, untrusted caps)', async () => {
    const list = await call('project_list');
    expect(list.status).toBe(200);
    expect(list.json<{ ok: boolean; data: { projects: Array<{ slug: string }> } }>().data.projects.map((p) => p.slug)).toEqual(['northfield-fixture']);
    const p = await call('project_get', { project: 'northfield-fixture' });
    expect(p.json<{ data: { readme_hash: string } }>().data.readme_hash).toBe(sha256Hex(await readFile(README())));
    expect((await call('job_list')).status).toBe(200);
    expect((await call('engine_info')).json<{ data: { client: string } }>().data.client).toBe('ui');
  });

  it('errors map to statuses: invalid 400 (per argument), not_found 404, conflict 409 with the current hash', async () => {
    const bad = await call('project_get', { project: '../x' });
    expect(bad.status).toBe(400);
    expect(bad.json<{ error: { code: string; details: { arguments: string[] } } }>().error).toMatchObject({ code: 'invalid', details: { arguments: [expect.stringContaining('project:')] } });
    expect((await call('project_get', { project: 'northfield-fixture', extra: 1 })).status).toBe(400);
    expect((await call('project_get', { project: 'nope' })).status).toBe(404);
    const stale = await call('project_update_readme', { project: 'northfield-fixture', markdown: '# x', if_match: 'a'.repeat(64) });
    expect(stale.status).toBe(409);
    expect(stale.json<{ error: { code: string; details: { current: string } } }>().error).toMatchObject({ code: 'conflict', details: { current: sha256Hex(await readFile(README())) } });
    expect((await raw(studio.port, 'POST', '/v1/call/project_list', { ...auth(), ...json }, '{not json')).status).toBe(400);
    expect((await raw(studio.port, 'POST', '/v1/call/project_list', { ...auth(), ...json }, '[]')).status).toBe(400);
    expect((await raw(studio.port, 'POST', '/v1/call/project_list', { ...auth(), ...json }, '')).status).toBe(200);
  });

  it('project_update_readme: if_match, atomic write, hash returned; the worst-case README fits the body cap', async () => {
    const before = sha256Hex(await readFile(README()));
    const r = await call('project_update_readme', { project: 'northfield-fixture', markdown: '# Northfield\n\nEdited from the Studio.\n', if_match: before });
    expect(r.status).toBe(200);
    const hash = r.json<{ data: { hash: string } }>().data.hash;
    expect(await readFile(README(), 'utf8')).toBe('# Northfield\n\nEdited from the Studio.\n');
    expect(hash).toBe(sha256Hex('# Northfield\n\nEdited from the Studio.\n'));
    expect((await readdir(join(ws, 'projects', 'northfield-fixture'))).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    // 200,000 characters (the cap, final line break included) of control characters: each escapes to 6 bytes of JSON
    // (≈ 1.2 MB) — under the 2 MiB cap.
    const worst = `${'\u0001'.repeat(199_999)}\n`;
    const body = JSON.stringify({ project: 'northfield-fixture', markdown: worst, if_match: hash });
    expect(body.length).toBeGreaterThan(1_000_000);
    expect(body.length).toBeLessThan(CALL_BODY_MAX);
    expect((await raw(studio.port, 'POST', '/v1/call/project_update_readme', { ...auth(), ...json }, body)).status).toBe(200);
    const over = JSON.stringify({ project: 'northfield-fixture', markdown: 'x'.repeat(CALL_BODY_MAX), if_match: hash });
    expect((await raw(studio.port, 'POST', '/v1/call/project_update_readme', { ...auth(), ...json }, over)).status).toBe(413);
  });

  it('the README cap holds for the file as written, its final line break included (review B L6)', async () => {
    const hash = sha256Hex(await readFile(README()));
    // 200,000 characters without a final line break would be written as 200,001 and could not be sent back unchanged.
    const r = await call('project_update_readme', { project: 'northfield-fixture', markdown: 'x'.repeat(200_000), if_match: hash });
    expect(r.status).toBe(400);
    expect(r.json<{ error: { code: string; message: string } }>().error).toMatchObject({ code: 'invalid', message: expect.stringContaining('200,001 characters with its final line break') });
    expect(sha256Hex(await readFile(README()))).toBe(hash);
    const ok = await call('project_update_readme', { project: 'northfield-fixture', markdown: 'x'.repeat(199_999), if_match: hash });
    expect(ok.status).toBe(200);
    expect((await readFile(README(), 'utf8')).length).toBe(200_000);
    const back = await call('project_update_readme', { project: 'northfield-fixture', markdown: await readFile(README(), 'utf8'), if_match: ok.json<{ data: { hash: string } }>().data.hash });
    expect(back.status).toBe(200);
  });

  it('projects_overview: the environment flags and last run of every card in one call (review B L2)', async () => {
    const before = studio.calls;
    const r = await call('projects_overview');
    expect(r.status).toBe(200);
    expect(studio.calls).toBe(before + 1);
    const [p] = r.json<{ data: { projects: Array<{ slug: string; environments: Array<{ name: string; production: boolean; access: string; sandbox: boolean }>; last_run: { id: string; scenario: string } | null }> } }>().data.projects;
    expect(p.slug).toBe('northfield-fixture');
    expect(p.environments.some((e) => e.production && e.access === 'read-only')).toBe(true);
    expect(p.environments.some((e) => e.sandbox)).toBe(true);
    expect(Object.keys(p.environments[0]).sort()).toEqual(['access', 'name', 'production', 'sandbox']);
    expect(p.last_run).toMatchObject({ id: '20261017-120000-quote', scenario: 'quote' });
    expect((await call('projects_overview', { project: 'x' })).status).toBe(400);
  });

  it('hostile requests holding the valid token run no op and leave the README as it is (B3)', async () => {
    const file = await readFile(README());
    const hash = sha256Hex(file);
    const args = { project: 'northfield-fixture', markdown: '# pwned', if_match: hash };
    const before = studio.calls;
    const cases: Array<[Record<string, string>, number]> = [
      [{ host: `rebind.test:${studio.port}` }, 421],
      [{ origin: `http://127.0.0.1:${studio.port + 1}` }, 403],
      [{ origin: 'null' }, 403],
      [{ 'sec-fetch-site': 'same-site' }, 403],
      [{ 'sec-fetch-site': 'cross-site' }, 403],
      [{ 'content-type': 'text/plain' }, 415],
      [{ 'content-type': 'application/x-www-form-urlencoded' }, 415],
    ];
    for (const [headers, status] of cases) {
      const r = await call('project_update_readme', args, headers);
      expect(r.status, JSON.stringify(headers)).toBe(status);
      expect(r.headers['content-security-policy']).toBe(studioCsp(studio.player.origin));
    }
    // A CORS preflight never succeeds: refused at the Origin layer (another page), or 405 (OPTIONS) for this origin.
    expect((await raw(studio.port, 'OPTIONS', '/v1/call/project_update_readme', { ...auth(), origin: `http://127.0.0.1:${studio.port + 1}`, 'access-control-request-method': 'POST' })).status).toBe(403);
    expect((await raw(studio.port, 'OPTIONS', '/v1/call/project_update_readme', { ...auth(), origin: `http://127.0.0.1:${studio.port}`, 'access-control-request-method': 'POST' })).status).toBe(405);
    expect(studio.calls).toBe(before);
    expect(sha256Hex(await readFile(README()))).toBe(hash);
  });
});

describe('one server per workspace (discovery file)', () => {
  it('a second launch reuses the first with a fresh code; close removes ui.json', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'studio-ui-launch-'));
    try {
      await fixtureWorkspace(dir);
      const first = await launchStudio({ root: dir });
      expect(first.reused).toBe(false);
      const file = discoveryFile(dir);
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      const rec = await readDiscovery(file);
      expect(rec).toMatchObject({ kind: 'ui', port: first.port, pid: process.pid, url: `http://127.0.0.1:${first.port}/` });
      expect(JSON.stringify(rec)).not.toContain('#c=');
      const second = await launchStudio({ root: dir });
      expect(second).toMatchObject({ reused: true, port: first.port, pid: process.pid });
      expect(second.url).not.toBe(first.url);
      const code = /#c=(.+)$/.exec(second.url)![1];
      expect((await raw(first.port, 'POST', '/v1/session', json, JSON.stringify({ code }))).status).toBe(200);
      if (!first.reused) await first.server.close();
      expect(await readDiscovery(file)).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('the MCP server does not depend on the Studio (R-UI-01)', () => {
  it('packages/mcp names no @demo-studio/ui, in its manifest or its sources', async () => {
    const pkg = JSON.parse(await readFile(join(REPO, 'packages', 'mcp', 'package.json'), 'utf8')) as Record<string, Record<string, string> | undefined>;
    expect({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies }).not.toHaveProperty('@demo-studio/ui');
    const files = (await readdir(join(REPO, 'packages', 'mcp', 'src'), { recursive: true })).filter((f) => f.endsWith('.ts'));
    for (const f of files) expect(await readFile(join(REPO, 'packages', 'mcp', 'src', f), 'utf8'), f).not.toContain('@demo-studio/ui');
  });
});
