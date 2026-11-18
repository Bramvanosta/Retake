/**
 * The Studio's Tools ops (tools-ops.ts; DESIGN §4p), through the Studio server's HTTP API, on a fake app (the
 * engine's `tools.bundle`: three small fixture Tools) and a fake download (tools-fake.ts: never the network):
 * - Studio only, never MCP tools; the status answers on any server (a checkout: `available: false`), never acts;
 * - every write is the installed app's own server's (supervised AND an app bundle; a download also from
 *   Applications); Install, Check and Remove count in the set-up's writes a minute, Pause and Cancel do not;
 * - the install runs in the server: started, followed by the status (downloading → ready), never twice; paused (what
 *   arrived kept) and resumed; a digest mismatch says the Tool, the digests and the URL; no connection says so, with
 *   the system's words under `untrusted`; Check again; the older folders and Remove…; Show in Finder's pipe line;
 * - the Studio's start downloads nothing (a fetch that throws is never called).
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BundleInfo } from '@retake/core/io';
import { TOOLS } from '@retake/mcp';
import { OWN_OPS } from '../src/server/ops.js';
import { TOOLS_OPS, ToolsServerState, wakeOnReady } from '../src/server/tools-ops.js';
import type { Engine } from '@retake/engine';
import { liveJobView } from '../src/server/run-stream.js';
import { FileJobQueue } from '@retake/engine/testing';
import { SETUP_WRITES_PER_MIN } from '../src/server/setup-ops.js';
import { UI_OPS } from '../src/server/studio.js';
import { startStudioServer } from '../src/index.js';
import type { SetupContext } from '../src/server/setup-ops.js';
import type { StudioServer } from '../src/index.js';
import { fixtureWorkspace } from '@retake/test-support/workspace';
import { raw } from '@retake/test-support/http';
import { scratchHome } from '@retake/test-support/home';
import { fakeTools } from './tools-fake.js';
import type { FakeNet } from './tools-fake.js';

// biome-ignore lint/suspicious/noExplicitAny: the answers' JSON is read as data
type Untyped = any;

const POLL = { timeout: 20_000, interval: 50 };
const base = realpathSync(mkdtempSync(join(tmpdir(), 'tools-ops-')));
const ws = join(base, 'ws');
const rhome = join(base, 'retake-home');
const testHome = scratchHome();
let studio: StudioServer;
let net: FakeNet;
let ctx: SetupContext;
const lines: string[] = [];

/** A fake installed app's set-up view (its path decides the location: Applications, or a translocated copy). */
function appAt(dir: string): BundleInfo {
  const sealed = join(dir, 'Retake.app');
  const root = join(sealed, 'Contents', 'Resources');
  mkdirSync(root, { recursive: true });
  return { root, sealed, manifest: {} as BundleInfo['manifest'], paths: { node: '', engine: '', ffmpeg: null, templates: '', plugin: '' } };
}
const placed = appAt(join(base, 'Applications'));
const moved = appAt(join(base, 'AppTranslocation', '0A1B', 'd'));
const machine = (bundle: BundleInfo): SetupContext => ({
  bundle,
  home: join(base, 'home'),
  env: { PATH: '/usr/bin:/bin', RETAKE_HOME: rhome },
  uid: process.getuid!(),
  readOnly: () => false,
  processes: async () => '',
  desktopConfig: join(base, 'home', 'claude.json'),
});

/** Remove a folder the installer made read-only. */
function wipe(dir: string): void {
  spawnSync('/bin/chmod', ['-R', 'u+w', dir]);
  rmSync(dir, { recursive: true, force: true });
}

const call = async (op: string, args: Record<string, unknown> = {}) => {
  const r = await raw(studio.port, 'POST', `/v1/call/${op}`, { authorization: `Bearer ${studio.token}`, 'content-type': 'application/json' }, JSON.stringify(args));
  return { status: r.status, body: r.json<{ data: Untyped; error: { code: string; message: string; details?: { reason?: string } } }>() };
};
const status = async () => (await call('tools_status')).body.data;
const freshWindow = () => ((studio.setup.state as unknown as { window: { start: number; count: number } }).window = { start: 0, count: 0 });
const settled = async () => {
  await expect.poll(async () => (await status()).running, POLL).toBe(false);
};

beforeAll(async () => {
  mkdirSync(ws);
  testHome.use(rhome);
  await fixtureWorkspace(ws);
  const t = await fakeTools(base);
  net = t.net;
  ctx = machine(placed);
  studio = await startStudioServer({ root: ws, startWorker: false, setup: () => ctx, tools: t.engineTools });
}, 60_000);

afterAll(async () => {
  await studio?.close();
  testHome.restore();
  wipe(base);
});

describe("the Run screen's waiting words follow the queue", () => {
  it('the job event says waits_for only while the queue holds the job for the Tools (a project on its own browser: never)', () => {
    expect(liveJobView({ state: 'queued', yield: { state: 'waiting', cause: 'tools', needs: 'browser' } })).toEqual({
      state: 'queued',
      pause_requested: false,
      cancel_requested: false,
      waits_for: 'browser',
    });
    expect(liveJobView({ state: 'queued', yield: { state: 'waiting', cause: 'tools', needs: 'render' } }).waits_for).toBe('render');
    expect(liveJobView({ state: 'queued' })).toEqual({ state: 'queued', pause_requested: false, cancel_requested: false });
    expect(liveJobView({ state: 'queued', yield: { state: 'waiting', cause: 'here' } }).waits_for).toBeUndefined();
  });
});

describe("the Studio server's open", () => {
  it('in the app, a claimable job left queued starts the worker (the engine of a terminal or an MCP client never does)', async () => {
    const ws2 = join(base, 'ws-open');
    mkdirSync(ws2);
    await fixtureWorkspace(ws2);
    const q = new FileJobQueue(ws2, 'retake', { now: () => Date.now(), monotonic: () => performance.now() }, process.env);
    await q.enqueue({ version: 1, kind: 'hooks', project: 'northfield-fixture', source: 'reset', dry: true, journal_id: '20261117-170000-hooks-reset', submitted_by: 'test', approvals: [] } as never);
    const spawned: string[] = [];
    const workerSpawn = ((cmd: string) => (spawned.push(cmd), { pid: 4243, on: () => undefined, unref: () => undefined })) as never;
    const t = await fakeTools(join(base, 'open-tools'));
    const s2 = await startStudioServer({ root: ws2, workerSpawn, setup: () => ctx, tools: t.engineTools });
    try {
      await expect.poll(() => spawned.length, POLL).toBe(1);
    } finally {
      await s2.close();
    }
  });
});

describe('the wake once the Tools turn ready', () => {
  it('a turn to ready is remembered only once the wake resolved: a failed wake is tried again on the next status', async () => {
    const st = new ToolsServerState();
    let calls = 0;
    let fail = true;
    const engine = { tools: { wake: async () => (calls++, fail ? Promise.reject(new Error('the queue could not be read')) : true) } } as unknown as Engine;
    wakeOnReady(st, engine, 'downloading');
    expect([st.seen, calls]).toEqual(['downloading', 0]);
    wakeOnReady(st, engine, 'ready');
    // One wake at a time while it runs.
    wakeOnReady(st, engine, 'ready');
    await new Promise((r) => setTimeout(r, 10));
    expect([st.seen, calls]).toEqual(['downloading', 1]);
    fail = false;
    wakeOnReady(st, engine, 'ready');
    await new Promise((r) => setTimeout(r, 10));
    expect([st.seen, calls]).toEqual(['ready', 2]);
    wakeOnReady(st, engine, 'ready');
    expect(calls).toBe(2);
  });
});

describe('the Tools ops', () => {
  it('Studio-only own ops in the ui allow-list; never MCP tools', () => {
    expect(TOOLS_OPS).toEqual(['tools_status', 'tools_install', 'tools_control', 'tools_check', 'tools_prune', 'tools_reveal']);
    for (const op of TOOLS_OPS) {
      expect(OWN_OPS as readonly string[]).toContain(op);
      expect(UI_OPS as readonly string[]).toContain(op);
    }
    expect(TOOLS.map((t) => t.name).filter((n) => n.startsWith('tools') || n.includes('download'))).toEqual([]);
  });

  it("the Studio's start downloads nothing; the status says what is needed and that an unsupervised server cannot act", async () => {
    expect(net.calls).toEqual([]);
    const s = await status();
    expect(s).toMatchObject({ available: true, state: 'needed', can: 'not_supervised', running: false, folder: join(rhome, 'tools') });
    expect(s.total_bytes).toBe(s.tools.reduce((n: number, t: Untyped) => n + t.bytes, 0));
    expect(s.tools.map((t: Untyped) => t.id)).toEqual(['render-browser', 'compositor', 'browser']);
    const r = await call('tools_install');
    expect([r.status, r.body.error.details?.reason]).toEqual([409, 'not_supervised']);
    expect(net.calls).toEqual([]);
  });

  it('a translocated copy may not download (location), the pipe attached', async () => {
    studio.desktop.attach((l) => (lines.push(l), true));
    ctx = machine(moved);
    freshWindow();
    expect((await status()).can).toBe('location');
    const r = await call('tools_install');
    expect([r.status, r.body.error.details?.reason]).toEqual([409, 'location']);
    expect(net.calls).toEqual([]);
    ctx = machine(placed);
    expect((await status()).can).toBe('ok');
  });

  it('Install starts the download in the server; the status follows it to ready; a second Install starts nothing', async () => {
    freshWindow();
    net.hold = true;
    const r = await call('tools_install');
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual({ started: true, state: 'downloading' });
    await expect.poll(async () => (await status()).state, POLL).toBe('downloading');
    const during = await status();
    expect(during.running).toBe(true);
    expect(during.by).toMatchObject({ by: 'studio' });
    // One at a time.
    expect((await call('tools_install')).body.data.started).toBe(false);
    net.hold = false;
    await settled();
    const s = await status();
    expect(s.state).toBe('ready');
    expect(s.tools.every((t: Untyped) => t.state === 'ready')).toBe(true);
    expect(s.last).toEqual({ outcome: 'ready' });
    // Each folder's own licence files, once ready (the render browser's).
    expect(s.tools.find((t: Untyped) => t.id === 'render-browser').licences).toEqual(['chrome-headless-shell-mac-arm64/LICENSE.headless_shell']);
    expect((await call('tools_install')).body.data).toEqual({ started: false, state: 'ready' });
  });

  it('Check again reads every file; the older folders are listed and Remove… takes them; Show in Finder is a pipe line', async () => {
    freshWindow();
    const c = await call('tools_check');
    expect(c.body.data.ok).toBe(true);
    expect((await status()).checked.tools.map((t: Untyped) => t.state)).toEqual(['ready', 'ready', 'ready']);
    const old = join(rhome, 'tools', 'browsers', 'chromium-1');
    mkdirSync(old, { recursive: true });
    writeFileSync(join(old, 'x'), 'old');
    expect((await status()).older.folders).toEqual(['browsers/chromium-1']);
    const p = await call('tools_prune');
    expect(p.body.data.removed.map((x: Untyped) => x.folder)).toEqual(['browsers/chromium-1']);
    expect((await status()).older.folders).toEqual([]);
    lines.length = 0;
    expect((await call('tools_reveal')).status).toBe(200);
    expect(lines).toEqual(['{"type":"setup","action":"tools_folder"}']);
  });

  it('Check again while another process installs (a terminal holds the lock): busy, nothing read or stamped', async () => {
    freshWindow();
    const lock = join(rhome, 'tools', '.lock');
    writeFileSync(lock, JSON.stringify({ pid: process.pid, command: 'tools install', by: 'cli', version: '0.0.1', since: new Date().toISOString() }));
    try {
      expect((await status()).by).toMatchObject({ by: 'cli' });
      const c = await call('tools_check');
      expect([c.body.error.code, c.body.error.details?.reason]).toEqual(['busy', 'busy']);
    } finally {
      rmSync(lock, { force: true });
    }
    expect((await call('tools_check')).body.data.ok).toBe(true);
  });

  it('Pause keeps what arrived (paused), Install resumes it; the rate cap counts Install, never Pause', async () => {
    wipe(join(rhome, 'tools'));
    freshWindow();
    net.hold = true;
    expect((await call('tools_install')).body.data.started).toBe(true);
    await expect.poll(async () => (await status()).state, POLL).toBe('downloading');
    // The minute's writes used up: Pause still answers (it only stops).
    (studio.setup.state as unknown as { window: { start: number; count: number } }).window = { start: Date.now(), count: SETUP_WRITES_PER_MIN };
    expect((await call('tools_control', { action: 'pause' })).status).toBe(200);
    await settled();
    net.hold = false;
    expect((await status()).state).toBe('paused');
    expect((await status()).last).toEqual({ outcome: 'paused' });
    const capped = await call('tools_install');
    expect([capped.status, capped.body.error.details?.reason]).toEqual([423, 'rate']);
    freshWindow();
    expect((await call('tools_install')).body.data.started).toBe(true);
    await settled();
    expect((await status()).state).toBe('ready');
  });

  it("a digest mismatch says the Tool, both digests and the URL; no connection says so, the system's words as untrusted", async () => {
    wipe(join(rhome, 'tools'));
    freshWindow();
    net.wrong = true;
    expect((await call('tools_install')).body.data.started).toBe(true);
    await settled();
    const m = await status();
    expect(m.state).toBe('mismatch');
    const b = m.tools.find((t: Untyped) => t.id === 'browser');
    expect(b.state).toBe('mismatch');
    expect(b.expected).toMatch(/^[0-9a-f]{64}$/);
    expect(b.got).toMatch(/^[0-9a-f]{64}$/);
    expect(b.got).not.toBe(b.expected);
    expect(b.url).toMatch(/^https:\/\/storage\.googleapis\.com\//);
    net.wrong = false;
    net.offline = true;
    freshWindow();
    expect((await call('tools_install')).body.data.started).toBe(true);
    await settled();
    const o = await status();
    expect(o.state).toBe('offline');
    expect(o.message).toBeUndefined();
    expect(o.untrusted.message).toBeTruthy();
    net.offline = false;
    freshWindow();
    await call('tools_install');
    await settled();
    expect((await status()).state).toBe('ready');
  });
});
