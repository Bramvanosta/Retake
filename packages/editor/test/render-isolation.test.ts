/**
 * The render browser and Remotion's bundle server as patches/@remotion__renderer@4.0.534.patch leaves them, in both
 * builds of @remotion/renderer (the ESM one the editor imports, and the CommonJS one):
 * - on macOS the render browser keeps Chromium's OS sandbox and site isolation: its command line has none of the
 *   switches that turn them off, its renderers run sandboxed (seatbelt), a cross-site iframe is a target of its own;
 *   one whose executable adds such a switch itself is refused (openRenderBrowser reads its command line);
 * - the bundle server listens on 127.0.0.1 and ::1 only (the render page loads http://localhost:<port>, which resolves
 *   to either); a local address that is not loopback is refused (skipped on a machine without one); a port whose ::1
 *   another listener holds is never served: a given port fails (a guarded render fails), a picked one moves on;
 * - it answers 421 to a Host other than localhost, 127.0.0.1 or [::1] with its port, and 403 to a cross-origin request
 *   (an Origin other than its own, a Sec-Fetch-Site other than same-origin or none), /proxy included.
 * Ports: free ones, taken when a test starts (test-support freePort). The browser part needs a Chromium headless shell; the render part ffmpeg / ffprobe too.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { Server as HttpServer, createServer, request } from 'node:http';
import { createRequire } from 'node:module';
import { createServer as createNetServer, connect } from 'node:net';
import type { Server as NetServer } from 'node:net';
import { networkInterfaces, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openRenderBrowser, planRun, playwrightHeadlessShell, renderPlan } from '@retake/editor';
import type { EditPlan } from '@retake/editor';
import { SHARED_CACHE, renderWorkspace } from '@retake/test-support/render';
import { hasTool } from '@retake/test-support/repo';
import { freePort } from '@retake/test-support/http';
import type { RenderWorkspace } from '@retake/test-support/render';
import { PERSON_POLICY } from '@retake/core';

type Renderer = typeof import('@remotion/renderer');
interface Served {
  port: number;
  close: () => Promise<void>;
}
interface Internals {
  serveStatic(path: string | null, options: Record<string, unknown>): Promise<Served>;
  makeDownloadMap(sampleRate: number): unknown;
  getPortConfig(preferIpv4: boolean): { host: string; hostsToTry: string[] };
}
interface Cdp {
  send(method: string, params?: unknown): Promise<unknown>;
}

const require = createRequire(import.meta.url);
const CJS = require('@remotion/renderer') as Renderer;
const ESM = (await import(pathToFileURL(join(dirname(require.resolve('@remotion/renderer')), 'esm', 'index.mjs')).href)) as Renderer;
const BUILDS: Array<[string, Renderer]> = [
  ['ESM', ESM],
  ['CommonJS', CJS],
];
const internals = (r: Renderer) => r.RenderInternals as unknown as Internals;
const SHELL = playwrightHeadlessShell();
const LONG = 400_000;
const tmp = mkdtempSync(join(tmpdir(), 'retake-render-isolation-'));
writeFileSync(join(tmp, 'index.html'), '<p>bundle</p>');
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const unwrap = (r: unknown) => ((r as { value?: unknown })?.value ?? r) as Record<string, unknown>;

/** Serve `body` on `port` at each of `hosts` (closed by the returned function). */
async function serveOn(port: number, hosts: string[], body: string): Promise<() => Promise<void>> {
  const servers: HttpServer[] = [];
  for (const host of hosts) {
    const s = createServer((_q, r) => r.writeHead(200, { 'content-type': 'text/html' }).end(body));
    await new Promise<void>((ok, ko) => s.once('error', ko).listen(port, host, () => ok()));
    servers.push(s);
  }
  return async () => {
    for (const s of servers) await new Promise<void>((r) => s.close(() => r()));
  };
}

/** A Remotion bundle server of `build` on `port` (or one it picks), serving `tmp`. */
function bundleServer(build: Renderer, port?: number): Promise<Served> {
  const R = internals(build);
  return R.serveStatic(tmp, {
    ...(port ? { port } : {}),
    downloadMap: R.makeDownloadMap(48000),
    remotionRoot: tmp,
    offthreadVideoThreads: 1,
    logLevel: 'error',
    indent: false,
    offthreadVideoCacheSizeInBytes: null,
    binariesDirectory: null,
    forceIPv4: false,
  });
}

/** GET `path` from `address`:`port` with exactly these headers (no Host added): its status, or the error code. */
function get(address: string, port: number, headers: Record<string, string>, path = '/'): Promise<number | string> {
  return new Promise((ok) => {
    const r = request({ host: address, port, path, headers, setHost: false, agent: false }, (res) => {
      res.resume();
      ok(res.statusCode ?? 0);
    });
    r.on('error', (e: NodeJS.ErrnoException) => ok(e.code ?? e.message));
    r.end();
  });
}

/** Whether a TCP connection to `address`:`port` is accepted. */
function connects(address: string, port: number): Promise<boolean> {
  return new Promise((ok) => {
    const s = connect({ host: address, port });
    s.once('connect', () => {
      s.destroy();
      ok(true);
    });
    s.once('error', () => ok(false));
  });
}

/** The TCP addresses this process listens on for `port` ("127.0.0.1:<port>", "[::1]:<port>"), per lsof. */
function listeners(port: number): string[] {
  try {
    const out = execFileSync('lsof', ['-nP', '-a', '-p', String(process.pid), `-iTCP:${port}`, '-sTCP:LISTEN', '-Fn'], { encoding: 'utf8' });
    return out
      .split('\n')
      .filter((l) => l.startsWith('n'))
      .map((l) => l.slice(1))
      .sort();
  } catch {
    return [];
  }
}

/** An address of this machine that is not loopback (IPv4 first; IPv6 link-local ones need a scope: left out). */
function otherLocalAddress(): string | undefined {
  const all = Object.values(networkInterfaces()).flatMap((l) => l ?? []);
  return (all.find((a) => a.family === 'IPv4' && !a.internal) ?? all.find((a) => a.family === 'IPv6' && !a.internal && !a.address.startsWith('fe80')))?.address;
}

/**
 * Run `fn` while every HTTP server that starts listening on 127.0.0.1 at a given port finds ::1 of that port already
 * taken by another listener (taken just before its own listen: after any check of the port), for the first `limit`
 * ports. Returns how `fn` ended and the ports taken.
 */
async function withIpv6Taken<T>(fn: () => Promise<T>, limit = Infinity): Promise<{ outcome: PromiseSettledResult<T>; taken: number[] }> {
  const original = HttpServer.prototype.listen;
  const squatters: NetServer[] = [];
  const taken: number[] = [];
  HttpServer.prototype.listen = function (this: HttpServer, ...args: unknown[]) {
    const o = args[0] as { port?: number; host?: string } | undefined;
    if (o && typeof o === 'object' && o.host === '127.0.0.1' && typeof o.port === 'number' && o.port > 0 && squatters.length < limit) {
      const squatter = createNetServer();
      squatters.push(squatter);
      squatter.listen({ port: o.port, host: '::1' }, () => {
        taken.push(o.port!);
        original.apply(this, args as Parameters<typeof original>);
      });
      return this;
    }
    return original.apply(this, args as Parameters<typeof original>);
  } as typeof original;
  try {
    const [outcome] = await Promise.allSettled([fn()]);
    return { outcome, taken };
  } finally {
    HttpServer.prototype.listen = original;
    for (const s of squatters) await new Promise<void>((r) => s.close(() => r()));
  }
}

describe.skipIf(process.platform !== 'darwin' || !SHELL)('the render browser keeps the OS sandbox and site isolation (macOS)', () => {
  let closePages: () => Promise<void>;
  let pagePort: number;
  beforeAll(async () => {
    // A page on 127.0.0.1 with a cross-site iframe on localhost (another site: another host).
    pagePort = await freePort();
    const framePort = await freePort(['127.0.0.1', '::1']);
    const page = await serveOn(pagePort, ['127.0.0.1'], `<iframe src="http://localhost:${framePort}/frame"></iframe>`);
    const frame = await serveOn(framePort, ['127.0.0.1', '::1'], '<p>frame</p>');
    closePages = async () => {
      await page();
      await frame();
    };
  });
  afterAll(() => closePages?.());

  it('a headless shell whose executable adds --no-sandbox itself is refused and closed, before anything renders', async () => {
    const wrapper = join(tmp, 'shell-wrapper.sh');
    writeFileSync(wrapper, `#!/bin/sh\nexec ${JSON.stringify(SHELL)} --no-sandbox "$@"\n`, { mode: 0o755 });
    let opened: { close(o: { silent: boolean }): Promise<unknown> } | undefined;
    await expect(
      openRenderBrowser({
        policy: { gl: { resolved: 'software', asked: 'auto', source: 'default' } } as never,
        launch: async () => (opened = await ESM.openBrowser('chrome', { browserExecutable: wrapper, chromeMode: 'headless-shell', logLevel: 'error' })),
      }),
    ).rejects.toThrow(/the render browser runs with --no-sandbox\b.* on its command line, which turns its sandbox or site isolation off/);
    expect(opened).toBeDefined();
  }, 60_000);

  for (const [name, build] of BUILDS) {
    it(`${name}: no sandbox or site-isolation switch on its command line; its renderers sandboxed; a cross-site iframe its own target`, async () => {
      const browser = await build.openBrowser('chrome', { browserExecutable: SHELL, chromeMode: 'headless-shell', logLevel: 'error' });
      const conn = (browser as unknown as { connection: Cdp }).connection;
      try {
        const args = unwrap(await conn.send('Browser.getBrowserCommandLine')).arguments as string[];
        expect(args.length).toBeGreaterThan(10);
        for (const off of ['--no-sandbox', '--disable-setuid-sandbox', '--disable-site-isolation-trials', '--disable-gpu-sandbox', '--single-process']) expect(args, off).not.toContain(off);
        const disabled = args.filter((a) => a.startsWith('--disable-features=')).flatMap((a) => a.slice('--disable-features='.length).split(','));
        expect(disabled).not.toContain('IsolateOrigins');
        expect(disabled).not.toContain('site-per-process');
        expect(args).toContain('--site-per-process');

        // Its pages, through a CDP connection of our own (flat sessions: an iframe in another process attaches as a target).
        const dir = args.find((a) => a.startsWith('--user-data-dir='))!.slice('--user-data-dir='.length);
        const [cdpPort, cdpPath] = readFileSync(join(dir, 'DevToolsActivePort'), 'utf8').split('\n');
        const ws = new WebSocket(`ws://127.0.0.1:${cdpPort}${cdpPath}`);
        await new Promise((ok, ko) => {
          ws.addEventListener('open', ok);
          ws.addEventListener('error', ko);
        });
        let id = 0;
        const pending = new Map<number, (m: { result?: Record<string, unknown> }) => void>();
        const attached: string[] = [];
        ws.addEventListener('message', (m) => {
          const d = JSON.parse(String(m.data)) as { id?: number; method?: string; params?: { targetInfo?: { type: string } } };
          if (d.id && pending.has(d.id)) {
            pending.get(d.id)!(d as { result?: Record<string, unknown> });
            pending.delete(d.id);
          } else if (d.method === 'Target.attachedToTarget') attached.push(d.params!.targetInfo!.type);
        });
        const send = (method: string, params: unknown = {}, sessionId?: string) =>
          new Promise<Record<string, unknown>>((ok) => {
            const i = ++id;
            pending.set(i, (m) => ok(m.result ?? {}));
            ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) }));
          });
        try {
          const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
          const { sessionId } = (await send('Target.attachToTarget', { targetId, flatten: true })) as { sessionId: string };
          await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sessionId);
          await send('Page.enable', {}, sessionId);
          await send('Page.navigate', { url: `http://127.0.0.1:${pagePort}/` }, sessionId);
          for (let i = 0; i < 40 && !attached.includes('iframe'); i++) await new Promise((r) => setTimeout(r, 250));
          expect(attached).toContain('iframe');

          const procs = unwrap(await conn.send('SystemInfo.getProcessInfo')).processInfo as Array<{ type: string; id: number }>;
          const renderers = new Set(procs.filter((p) => p.type === 'renderer').map((p) => p.id));
          expect(renderers.size).toBeGreaterThanOrEqual(2);
          const lines = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' })
            .split('\n')
            .filter((l) => renderers.has(Number(l.trim().split(/\s+/)[0])));
          expect(lines).toHaveLength(renderers.size);
          for (const l of lines) {
            expect(l).toMatch(/--seatbelt-client=\d+/);
            expect(l).not.toContain('--no-sandbox');
          }
        } finally {
          ws.close();
        }
      } finally {
        await browser.close({ silent: true });
      }
    }, 60_000);
  }
});

describe('the bundle server listens on loopback only, and answers its own origin only', () => {
  it('the port configuration: bind 127.0.0.1, try only loopback addresses', () => {
    for (const [, build] of BUILDS) {
      const c = internals(build).getPortConfig(false);
      expect(c.host).toBe('127.0.0.1');
      expect(c.hostsToTry.length).toBeGreaterThan(0);
      for (const h of c.hostsToTry) expect(['127.0.0.1', '::1']).toContain(h);
    }
  });

  for (const [name, build] of BUILDS) {
    it(`${name}: 127.0.0.1 and ::1, nothing else; closed with the render`, async () => {
      const port = await freePort(['127.0.0.1', '::1']);
      const s = await bundleServer(build, port);
      try {
        expect(s.port).toBe(port);
        expect(listeners(port)).toEqual([`127.0.0.1:${port}`, `[::1]:${port}`]);
        expect(await get('127.0.0.1', port, { host: `localhost:${port}` })).toBe(200);
        expect(await get('::1', port, { host: `localhost:${port}` })).toBe(200);
        const other = otherLocalAddress();
        if (other) expect(await connects(other, port), other).toBe(false);
        else console.warn('no address other than loopback on this machine: the non-loopback refusal is not checked');
      } finally {
        await s.close();
      }
      expect(listeners(port)).toEqual([]);
    }, 60_000);

    it(`${name}: Host other than its own → 421; a cross-origin request → 403 (/proxy included); its own → served`, async () => {
      const p = await freePort(['127.0.0.1', '::1']);
      const s = await bundleServer(build, p);
      try {
        const status = (headers: Record<string, string>, path?: string) => get('127.0.0.1', p, headers, path);
        for (const host of [`localhost:${p}`, `127.0.0.1:${p}`, `[::1]:${p}`, `LOCALHOST:${p}`]) expect(await status({ host }), host).toBe(200);
        for (const host of ['evil.example', `evil.example:${p}`, 'localhost', `localhost:${p + 1}`, `localhost.:${p}`, `127.0.0.2:${p}`, `0.0.0.0:${p}`, `[::]:${p}`, `localhost:${p}@evil.example`]) {
          expect(await status({ host }), host).toBe(421);
        }
        // No Host at all: Node's HTTP server refuses it before the handler (400).
        expect(await status({})).toBe(400);
        const own = { host: `localhost:${p}` };
        expect(await status({ ...own, origin: `http://localhost:${p}` })).toBe(200);
        expect(await status({ ...own, 'sec-fetch-site': 'same-origin' })).toBe(200);
        expect(await status({ ...own, 'sec-fetch-site': 'none' })).toBe(200);
        const crossOrigin: Array<Record<string, string>> = [
          { origin: 'http://evil.example' },
          { origin: 'null' },
          { origin: `http://127.0.0.1:${p}` },
          { origin: `https://localhost:${p}` },
          { 'sec-fetch-site': 'cross-site' },
          { 'sec-fetch-site': 'same-site' },
        ];
        for (const extra of crossOrigin) {
          expect(await status({ ...own, ...extra }), JSON.stringify(extra)).toBe(403);
          expect(await status({ ...own, ...extra }, `/proxy?src=${encodeURIComponent(`http://127.0.0.1:${p + 1}/x.mp4`)}&time=0&transparent=false`), JSON.stringify(extra)).toBe(403);
        }
        expect(await status({ host: 'evil.example' }, '/proxy?src=x')).toBe(421);
      } finally {
        await s.close();
      }
    }, 60_000);

    it(`${name}: ::1 of the port held by another listener — a given port fails, nothing served on 127.0.0.1; a picked port moves on`, async () => {
      // Taken before the server starts: refused at the port check.
      const held = await freePort(['127.0.0.1', '::1']);
      const squatter = createNetServer();
      await new Promise<void>((r) => squatter.listen({ port: held, host: '::1' }, () => r()));
      try {
        await expect(bundleServer(build, held)).rejects.toThrow(new RegExp(String(held)));
        expect(await connects('127.0.0.1', held)).toBe(false);
      } finally {
        await new Promise<void>((r) => squatter.close(() => r()));
      }
      // Taken between the port check and the listen.
      const racedPort = await freePort(['127.0.0.1', '::1']);
      const raced = await withIpv6Taken(() => bundleServer(build, racedPort));
      expect(raced.taken).toEqual([racedPort]);
      expect(raced.outcome.status).toBe('rejected');
      expect(listeners(racedPort)).toEqual([]);
      expect(await connects('127.0.0.1', racedPort)).toBe(false);
      // No port given (a CLI render): the server takes another one, on both addresses.
      const picked = await withIpv6Taken(() => bundleServer(build), 1);
      expect(picked.outcome.status).toBe('fulfilled');
      const s = (picked.outcome as PromiseFulfilledResult<Served>).value;
      try {
        expect(picked.taken).toHaveLength(1);
        expect(picked.taken).not.toContain(s.port);
        expect(listeners(s.port)).toEqual([`127.0.0.1:${s.port}`, `[::1]:${s.port}`]);
        for (const t of picked.taken) expect(listeners(t)).toEqual([]);
      } finally {
        await s.close();
      }
    }, 60_000);
  }
});

const canRender = !!SHELL && hasTool('ffmpeg') && hasTool('ffprobe');

describe.skipIf(!canRender)('a guarded render whose bundle port has ::1 taken fails closed', () => {
  let ws: RenderWorkspace;
  let plan: EditPlan;
  beforeAll(async () => {
    ws = await renderWorkspace();
    plan = (await planRun({ workPolicy: PERSON_POLICY, project: ws.project, run: 'latest', root: ws.root })).plan;
  }, LONG);
  afterAll(() => ws?.cleanup());

  const render = (out: string) => renderPlan({ workPolicy: PERSON_POLICY, plan, out: join(ws.root, out), root: ws.root, cacheDir: SHARED_CACHE, network: 'guard', frameRange: [0, 2], concurrency: 1 });

  it(
    'the same render passes without the other listener, fails with it (no file written)',
    async () => {
      const ok = await render('control.mp4');
      expect(ok.warnings.filter((w) => w.startsWith('the render blocked'))).toEqual([]);
      expect(existsSync(join(ws.root, 'control.mp4'))).toBe(true);
      const raced = await withIpv6Taken(() => render('raced.mp4'));
      expect(raced.taken.length).toBeGreaterThanOrEqual(1);
      expect(raced.outcome.status).toBe('rejected');
      expect(String((raced.outcome as PromiseRejectedResult).reason?.message)).toMatch(/port/);
      expect(existsSync(join(ws.root, 'raced.mp4'))).toBe(false);
      for (const t of raced.taken) expect(listeners(t)).toEqual([]);
    },
    LONG,
  );
});
