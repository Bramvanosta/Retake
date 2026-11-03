/**
 * L3.2 network guard of a render's Chromium (network-guard.ts): the allow-list (asset server URLs, Remotion's bundle
 * server, its /proxy only for asset-server sources), the CSP meta of the bundle, and real renders of a workspace
 * component that evades the compile-time scan (`globalThis['fe' + 'tch']`) and reaches for a second local server B:
 * fetch, a localhost alias, an image, Remotion's /proxy with a source on B, a WebSocket, and an `<Audio>` source on B
 * (downloaded by Remotion in Node, never through Chromium). Guarded: B gets no request, the render warns with B's
 * origin (or fails, for the audio download). Open (the CLI's renders): B gets them — the positive control.
 * Needs ffmpeg/ffprobe and a Chromium headless shell.
 */
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { scaffoldDir } from '@retake/components';
import { BUNDLE_CSP, allowedDownload, allowedRequest, originOf, planRun, renderPlan, withCspMeta } from '@retake/editor';
import type { EditPlan, RenderNetwork } from '@retake/editor';
import { SHARED_CACHE, hasTool, renderWorkspace } from './render-helpers.js';
import type { RenderWorkspace } from './render-helpers.js';

const ALLOW = { assetPrefix: 'http://127.0.0.1:4100/tok3n/', bundlePort: 3007 };

describe('the allow-list', () => {
  it('lets the asset server, the bundle server and data:/blob: through; nothing else', () => {
    expect(allowedRequest('http://127.0.0.1:4100/tok3n/0/capture.mp4', ALLOW)).toBe(true);
    expect(allowedRequest('http://localhost:3007/index.html', ALLOW)).toBe(true);
    expect(allowedRequest('http://localhost:3007/bundle.js', ALLOW)).toBe(true);
    expect(allowedRequest('data:image/png;base64,AAAA', ALLOW)).toBe(true);
    expect(allowedRequest('blob:http://localhost:3007/x', ALLOW)).toBe(true);
    for (const url of [
      'http://127.0.0.1:4100/other/0/x.png', // the asset server without its token
      'http://127.0.0.1:4101/tok3n/0/x.png', // another port
      'http://localhost:4100/tok3n/0/x.png', // another host name of the asset server
      'http://127.0.0.1:3007/index.html', // the bundle port under another host
      'http://localhost:3008/index.html',
      'https://localhost:3007/index.html',
      'http://user:pw@localhost:3007/index.html',
      'https://example.com/a.png',
      'http://10.0.0.1/',
      'file:///etc/hosts',
    ]) {
      expect(allowedRequest(url, ALLOW), url).toBe(false);
    }
  });

  it("Remotion's /proxy passes only for a source on the asset server (its Node side would download anything)", () => {
    const proxy = (src: string) => `http://localhost:3007/proxy?src=${encodeURIComponent(src)}&time=0.5&transparent=false`;
    expect(allowedRequest(proxy('http://127.0.0.1:4100/tok3n/0/capture.mp4'), ALLOW)).toBe(true);
    expect(allowedRequest(proxy('http://127.0.0.1:5555/secret'), ALLOW)).toBe(false);
    expect(allowedRequest(proxy('https://example.com/v.mp4'), ALLOW)).toBe(false);
    expect(allowedRequest(proxy('http://127.0.0.1:4100/other/x.mp4'), ALLOW)).toBe(false);
    expect(allowedRequest('http://localhost:3007/proxy', ALLOW)).toBe(false);
  });

  it('Node-side downloads: asset server and data: only', () => {
    expect(allowedDownload('http://127.0.0.1:4100/tok3n/2/music.mp3', ALLOW)).toBe(true);
    expect(allowedDownload('data:audio/wav;base64,AAAA', ALLOW)).toBe(true);
    expect(allowedDownload('http://127.0.0.1:5555/x.mp3', ALLOW)).toBe(false);
    expect(allowedDownload('http://localhost:3007/proxy?src=http%3A%2F%2F127.0.0.1%3A4100%2Ftok3n%2F0%2Fa.mp4', ALLOW)).toBe(false);
  });

  it('origins only in warnings', () => {
    expect(originOf('http://127.0.0.1:5555/a/b?c=d')).toBe('http://127.0.0.1:5555');
    expect(originOf('data:image/png;base64,AAAA')).toBe('data:');
  });

  it('the bundle CSP: connect-src without ws: (CDP Fetch does not see WebSockets); one meta, first in the head', () => {
    expect(BUNDLE_CSP).toContain('connect-src');
    expect(BUNDLE_CSP).not.toMatch(/\bws:|wss:|\*/);
    const html = withCspMeta('<!DOCTYPE html><html><head><title>x</title></head><body></body></html>');
    expect(html).toContain(`<head><meta http-equiv="Content-Security-Policy" content="${BUNDLE_CSP}"><title>`);
    expect(withCspMeta(html)).toBe(html);
  });
});

const canRender = hasTool('ffmpeg') && hasTool('ffprobe');
const HERE = fileURLToPath(new URL('.', import.meta.url));
const LONG = 400_000;

let ws: RenderWorkspace;
let b: Server;
let bOrigin: string;
let hits: string[] = [];

/** A workspace intro component that reaches for B in every way a page can, past the compile-time scan. */
function reachingIntro(port: number): string {
  return `import { useEffect } from 'react';
import { AbsoluteFill, continueRender, delayRender } from 'remotion';

export default function Reaching() {
  useEffect(() => {
    const g = globalThis as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
    const get = g['fe' + 'tch'];
    const handle = delayRender('reaching');
    const tries: Array<Promise<unknown>> = [
      get('http://127.0.0.1:${port}/fetch'),
      get('http://localhost:${port}/fetch-localhost'),
      get(window.location.origin + '/proxy?src=' + encodeURIComponent('http://127.0.0.1:${port}/proxy-src.mp4') + '&time=0&transparent=false&toneMapped=false'),
      new Promise((done) => {
        const img = new Image();
        img.onload = done;
        img.onerror = done;
        img.src = 'http://127.0.0.1:${port}/img.png';
      }),
      new Promise((done) => {
        try {
          const Ws = (globalThis as unknown as Record<string, new (u: string) => { onopen: unknown; onerror: unknown; onclose: unknown }>)['Web' + 'Socket'];
          const s = new Ws('ws://127.0.0.1:${port}/ws');
          s.onopen = done;
          s.onerror = done;
          s.onclose = done;
        } catch {
          done(undefined);
        }
      }),
    ];
    const timeout = new Promise((done) => (globalThis as unknown as { setTimeout: (f: () => void, ms: number) => void }).setTimeout(() => done(undefined), 3000));
    Promise.race([Promise.allSettled(tries), timeout]).then(() => continueRender(handle));
  }, []);
  return <AbsoluteFill style={{ background: '#204060' }} />;
}
`;
}

/** A workspace intro component playing an audio file of B: Remotion downloads it in Node. */
function audioIntro(port: number): string {
  return `import { AbsoluteFill, Audio } from 'remotion';

export default function Sounding() {
  return (
    <AbsoluteFill style={{ background: '#402060' }}>
      <Audio src="http://127.0.0.1:${port}/sound.wav" />
    </AbsoluteFill>
  );
}
`;
}

async function addIntro(name: string, code: string): Promise<void> {
  const dir = join(ws.root, 'components', 'acme', name);
  await rm(dir, { recursive: true, force: true });
  await mkdir(join(ws.root, 'components', 'acme'), { recursive: true });
  await cp(scaffoldDir('intro'), dir, { recursive: true });
  const manifest = (await readFile(join(dir, 'component.yaml'), 'utf8')).replace(/^id: .*$/m, `id: acme/${name}`);
  await writeFile(join(dir, 'component.yaml'), manifest);
  await writeFile(join(dir, 'index.tsx'), code);
}

async function introPlan(component: string): Promise<EditPlan> {
  const planned = await planRun({ project: ws.project, run: 'latest', root: ws.root, overrides: { intro: true, components: { intro: component } } });
  expect(planned.plan.segments[0]?.component.id).toBe(component);
  return planned.plan;
}

async function renderIntro(plan: EditPlan, network: RenderNetwork, out: string) {
  return renderPlan({ plan, out: join(ws.root, out), root: ws.root, cacheDir: SHARED_CACHE, network, frameRange: [0, 5], concurrency: 2 });
}

describe.skipIf(!canRender)('a guarded render loads only the files of its plan', () => {
  beforeAll(async () => {
    ws = await renderWorkspace();
    // B answers a real sound for /sound.wav (the open render then mixes it), a byte for the rest.
    const wav = join(ws.root, 'sound.wav');
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', wav]);
    const sound = await readFile(wav);
    b = createServer((req, res) => {
      hits.push(req.url ?? '');
      if (req.url === '/sound.wav') res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': sound.length }).end(sound);
      else res.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/octet-stream' }).end('x');
    });
    b.on('upgrade', (req, socket) => {
      hits.push(req.url ?? '');
      socket.destroy();
    });
    await new Promise<void>((r) => b.listen(0, '127.0.0.1', () => r()));
    const port = (b.address() as AddressInfo).port;
    bOrigin = `http://127.0.0.1:${port}`;
    await addIntro('reaching', reachingIntro(port));
    await addIntro('sounding', audioIntro(port));
  }, LONG);
  afterAll(async () => {
    await new Promise<void>((r) => (b ? b.close(() => r()) : r()));
    await ws?.cleanup();
  });

  it('guarded: B gets nothing (fetch, localhost alias, image, /proxy source, WebSocket); the render warns with its origin only', async () => {
    const plan = await introPlan('acme/reaching');
    hits = [];
    const res = await renderIntro(plan, 'guard', 'guarded.mp4');
    expect(hits).toEqual([]);
    const blocked = res.warnings.filter((w) => w.startsWith('the render blocked'));
    expect(blocked.join('\n')).toContain(bOrigin);
    expect(blocked.join('\n')).toContain(`http://localhost:${new URL(bOrigin).port}`);
    expect(blocked.join('\n')).not.toMatch(/\/fetch|\/img|proxy-src/);
  }, LONG);

  it('open (a `retake render`): B gets the page requests and the /proxy download — the positive control', async () => {
    const plan = await introPlan('acme/reaching');
    hits = [];
    const res = await renderIntro(plan, 'open', 'open.mp4');
    expect(hits).toEqual(expect.arrayContaining(['/fetch', '/fetch-localhost', '/img.png', '/proxy-src.mp4']));
    // The CSP of the bundle holds for every render: no WebSocket leaves the page.
    expect(hits).not.toContain('/ws');
    expect(res.warnings.filter((w) => w.startsWith('the render blocked'))).toEqual([]);
  }, LONG);

  it("guarded: an <Audio> source on B is refused before Remotion's Node side downloads it (the render fails)", async () => {
    // In a process of its own: the failed render's encoder pipe rejects with EPIPE afterwards (fixtures/render-intro.mts).
    const renderIn = (network: RenderNetwork, out: string): Promise<{ ok: boolean; error?: string }> =>
      new Promise((done, fail) => {
        // Asynchronous: B answers from this process while the child renders.
        const child = spawn(process.execPath, ['--conditions=source', '--import', 'tsx', join(HERE, 'fixtures', 'render-intro.mts'), ws.root, 'acme/sounding', network, join(ws.root, out), SHARED_CACHE], {
          cwd: join(HERE, '..'),
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
        child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
        child.on('error', fail);
        child.on('exit', () => {
          const line = stdout.trim().split('\n').pop() ?? '';
          if (!line.startsWith('{')) fail(new Error(`no result from the render process: ${stderr.slice(-2000)}`));
          else done(JSON.parse(line) as { ok: boolean; error?: string });
        });
      });
    hits = [];
    const guarded = await renderIn('guard', 'audio-guarded.mp4');
    expect(guarded.ok).toBe(false);
    expect(guarded.error).toMatch(/blocked download of http:\/\/127\.0\.0\.1:\d+: a render through MCP loads only the files of its plan/);
    expect(hits).toEqual([]);
    hits = [];
    expect((await renderIn('open', 'audio-open.mp4')).ok).toBe(true);
    expect(hits).toContain('/sound.wav');
  }, LONG);
});
