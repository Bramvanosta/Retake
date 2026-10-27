/**
 * L4.7 part C: component previews on the player origin (player.ts publishPreview, frame-main.tsx's `component-preview`
 * branch, theme-ops.ts theme_preview):
 * - ⚑ the `forbid` scan of a preview spec (checkPreviewSpec): a `file:` URL, an absolute path, a folder of this Mac, a URL
 *   the scope does not serve (a tracker, a `data:` URL) are refused — the sample address a browser layout draws is text;
 *   a refused spec is never served; ⚑ display text is a fixed list (review A M2: the bar's and each pane's sample address,
 *   the theme's brand url, a slot equal to it), and every registry component × the three starters is previewed;
 * - in Chromium, the Studio page framing the sandboxed preview: the frame loads a theme's intro as a `component-preview`
 *   (ComponentPreview, looping), settles, and draws the theme — a draft background colour shows in its pixels;
 * - ⚑ a workspace component the person has not allowed is not in the frame's bundle (its bytes absent) and the frame says
 *   its stand-in draws instead.
 */
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import type { Browser, Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { scaffoldDir } from '@demo-studio/components';
import { memoRegistry } from '@demo-studio/engine';
import { COMPONENT_PREVIEW_FORMAT, checkPreviewSpec, startStudioServer } from '../src/index.js';
import type { StudioServer, ThemePreviewAnswer } from '../src/index.js';
import { fixtureWorkspace } from '../../engine/test/helpers.js';
import { hasTool } from '../../editor/test/render-helpers.js';
import { raw } from './http.js';

const canRun = hasTool('ffmpeg') && hasTool('ffprobe');
/** A folder to keep the framed previews' screenshots in (looked at by hand), or none. */
const SHOTS = process.env.DEMO_STUDIO_UI_SHOTS;
const P = 'northfield-fixture';
const MARK = 'HELD-PREVIEW-COMPONENT-8b1f';
const MEDIA = 'http://127.0.0.1:1/m/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/';
let ws: string;
let studio: StudioServer;
let browser: Browser | undefined;
let page: Page;
const savedHome = process.env.DEMO_STUDIO_HOME;
const call = (op: string, args: unknown = {}) => raw(studio.port, 'POST', `/v1/call/${op}`, { authorization: `Bearer ${studio.token}`, 'content-type': 'application/json' }, JSON.stringify(args));
async function preview(args: Record<string, unknown>): Promise<Extract<ThemePreviewAnswer, { frame_url: string }>> {
  const r = await call('theme_preview', { project: P, lease: 'player-preview-lease-01', ...args });
  expect(r.status, r.body.slice(0, 300)).toBe(200);
  const d = r.json<{ data: ThemePreviewAnswer }>().data;
  if (!('frame_url' in d)) throw new Error(`no preview: ${JSON.stringify(d)}`);
  return d;
}

/** A minimal spec: a card with a served font and the browser bar's sample address. */
const spec = (extra: Record<string, unknown> = {}) => ({
  width: 1920,
  height: 1080,
  fps: 30,
  durationInFrames: 60,
  frame: 30,
  theme: { name: 't', font_faces: [{ family: 'x', url: `${MEDIA}id/font.ttf` }] },
  main: { id: 'studio/card-title', kind: 'card', slots: { title: 'Hello' }, params: {}, durationInFrames: 60 },
  scene: { url: 'https://shop.northfield.example/products/a' },
  ...extra,
});

beforeAll(async () => {
  ws = await mkdtemp(join(tmpdir(), 'ds-player-preview-'));
  process.env.DEMO_STUDIO_HOME = join(ws, '.home');
  await fixtureWorkspace(ws);
  const comp = join(ws, 'components', 'acme', 'held');
  await mkdir(comp, { recursive: true });
  await cp(scaffoldDir('card'), comp, { recursive: true });
  await writeFile(join(comp, 'component.yaml'), (await readFile(join(comp, 'component.yaml'), 'utf8')).replace(/^id: .*$/m, 'id: acme/held'));
  await writeFile(join(comp, 'index.tsx'), `import { AbsoluteFill } from 'remotion';\nexport default function H() { return <AbsoluteFill style={{ background: '#ff00ff' }}>{${JSON.stringify(MARK)}}</AbsoluteFill>; }\n`);
  studio = await startStudioServer({ root: ws, startWorker: false });
  if (!canRun) return;
  const executablePath = process.env.DEMO_STUDIO_CHROMIUM;
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : { channel: 'chromium' }) });
  page = await (await browser.newContext({ viewport: { width: 900, height: 600 } })).newPage();
  // The Studio's own page (its CSP frames the player origin only); no session is needed to frame a preview URL.
  await page.goto(studio.url);
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await studio?.close();
  if (savedHome === undefined) delete process.env.DEMO_STUDIO_HOME;
  else process.env.DEMO_STUDIO_HOME = savedHome;
  if (ws) await rm(ws, { recursive: true, force: true });
});

describe('the forbid scan of a component preview (checkPreviewSpec)', () => {
  const forbid = ['/Users/someone/work', '/Users/someone'];
  it('a spec of served URLs passes; the browser bar\'s sample address is text', async () => {
    await expect(checkPreviewSpec(spec(), MEDIA, forbid)).resolves.toBeUndefined();
  });

  it('⚑ a file: URL, an absolute path, a folder of this Mac, a URL the scope does not serve, a data: URL → refused', async () => {
    const bad: Array<[string, Record<string, unknown>]> = [
      ['file URL', { main: { id: 'a/b', slots: { image: 'file:///etc/hosts' } } }],
      ['absolute path', { main: { id: 'a/b', slots: { image: '/Users/someone/work/logo.png' } } }],
      ['folder', { main: { id: 'a/b', slots: { title: 'see /Users/someone/work/notes' } } }],
      ['tracker', { main: { id: 'a/b', slots: { image: 'https://tracker.example/pixel.png' } } }],
      ['scheme-relative', { theme: { font_faces: [{ url: '//tracker.example/f.ttf' }] } }],
      ['data URL', { theme: { logo: { url: 'data:image/svg+xml,<svg onload=alert(1)>' } } }],
      ['another scope', { theme: { logo: { url: 'http://127.0.0.1:1/m/BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB/id/logo.png' } } }],
      ['a URL beside the bar', { scene: { url: 'https://shop.northfield.example/', screen: { url: 'https://tracker.example/s.png' } } }],
    ];
    for (const [what, extra] of bad) await expect(checkPreviewSpec(spec(extra), MEDIA, forbid), what).rejects.toMatchObject({ name: 'PreviewPlanError' });
  });

  it('⚑ L4.7 review A M2: display text is a fixed list (panes[*].url, the theme\'s brand url, a slot equal to it); nothing else', async () => {
    const panes = { scene: { url: 'https://shop.northfield.example/', rects: { panes: [{ url: 'https://shop.northfield.example/a' }, { url: 'https://shop.northfield.example/b' }] } } };
    await expect(checkPreviewSpec(spec(panes), MEDIA, forbid)).resolves.toBeUndefined();
    const brand = { theme: { name: 't', brand: { url: 'https://example.com' } } };
    await expect(checkPreviewSpec(spec(brand), MEDIA, forbid)).resolves.toBeUndefined();
    // A slot filled from default_from: theme.brand.url (the same text) is display text too…
    const cta = { ...brand, main: { id: 'acme/cta', kind: 'card', slots: { url: 'https://example.com' }, params: {}, durationInFrames: 60 } };
    await expect(checkPreviewSpec(spec(cta), MEDIA, forbid)).resolves.toBeUndefined();
    // …but any other URL in a slot, a pane's other key, a brand key beside url, or a URL inside an array elsewhere is not.
    const bad: Array<[string, Record<string, unknown>]> = [
      ['slot URL', { ...brand, main: { id: 'a/b', slots: { x: 'https://tracker.example/p.png' } } }],
      ['slot without a brand url', { main: { id: 'a/b', slots: { url: 'https://example.com' } } }],
      ['pane image', { scene: { rects: { panes: [{ url: 'https://shop.northfield.example/', image: 'https://tracker.example/s.png' }] } } }],
      ['brand logo', { theme: { brand: { url: 'https://example.com', logo: 'https://tracker.example/l.png' } } }],
      ['array at scene.url', { scene: { url: ['https://tracker.example/s.png'] } }],
      ['params', { ...brand, main: { id: 'a/b', slots: {}, params: { src: 'https://example.com' } } }],
    ];
    for (const [what, extra] of bad) await expect(checkPreviewSpec(spec(extra), MEDIA, forbid), what).rejects.toMatchObject({ name: 'PreviewPlanError' });
  });

  it('every component of the registry × the three starters is previewed by theme_preview (layout-pip / layout-split too)', async () => {
    const { registry } = await memoRegistry(studio.engine.workspace);
    const ids = registry.list().map((i) => i.manifest.id);
    expect(ids).toEqual(expect.arrayContaining(['studio/layout-pip', 'studio/layout-split', 'studio/card-cta', 'studio/outro-stack']));
    const refused: string[] = [];
    let served = 0;
    for (const theme of ['default', 'editorial', 'motion']) {
      for (const id of ids) {
        const r = await call('theme_preview', { project: P, theme, target: { component: id }, lease: 'scan-all-lease-0001' });
        expect(r.status, `${theme} ${id}: ${r.body.slice(0, 200)}`).toBe(200);
        const d = r.json<{ data: ThemePreviewAnswer }>().data;
        if ('frame_url' in d) served++;
        else refused.push(`${theme} ${id}: ${JSON.stringify(d).slice(0, 200)}`);
      }
    }
    expect(refused).toEqual([]);
    expect(served).toBe(ids.length * 3);
    await call('timeline_leave', { project: P, lease: 'scan-all-lease-0001' });
  }, 120_000);

  it('publishPreview serves {format, spec} under the scope; a refused spec is never served', async () => {
    const media = `${studio.player.origin}/m/`;
    const ok = await studio.player.publishPreview(spec({ theme: { name: 't' } }) as never, { forbid: [ws, homedir()], scope: 'probe' });
    expect(ok.plan_url.startsWith(media)).toBe(true);
    const u = new URL(ok.plan_url);
    const r = await raw(Number(u.port), 'GET', u.pathname);
    expect(r.status).toBe(200);
    expect(r.json<{ format: string }>().format).toBe(COMPONENT_PREVIEW_FORMAT);
    await expect(studio.player.publishPreview(spec({ theme: { name: join(ws, 'x') } }) as never, { forbid: [ws, homedir()], scope: 'probe' })).rejects.toMatchObject({ name: 'PreviewPlanError' });
    studio.player.release('probe');
  });
});

type Msg = { type: string; frames?: number; frame?: number; warnings?: string[]; missing?: string[]; message?: string };

/** Frame a preview URL in the Studio page, load its plan, and collect the frame's messages (the protocol's parent side). */
async function frameIt(d: { frame_url: string; plan_url: string }, frame = 0): Promise<void> {
  await page.evaluate(
    ({ frameUrl, planUrl, at }) => {
      document.querySelector('iframe#probe')?.remove();
      const w = window as unknown as { __msgs: unknown[]; __port?: MessagePort };
      w.__msgs = [];
      const iframe = document.createElement('iframe');
      iframe.id = 'probe';
      iframe.setAttribute('sandbox', 'allow-scripts');
      iframe.setAttribute('referrerpolicy', 'no-referrer');
      iframe.style.cssText = 'position:fixed;left:0;top:0;width:640px;height:360px;border:0;z-index:99999';
      const onHello = (e: MessageEvent) => {
        if (e.source !== iframe.contentWindow || (e.data as { type?: string })?.type !== 'hello' || e.ports.length !== 1) return;
        window.removeEventListener('message', onHello);
        w.__port = e.ports[0];
        w.__port.onmessage = (m) => w.__msgs.push(m.data);
        w.__port.postMessage({ v: 1, type: 'load', plan_url: planUrl, frame: at });
      };
      window.addEventListener('message', onHello);
      iframe.src = frameUrl;
      document.body.appendChild(iframe);
    },
    { frameUrl: d.frame_url, planUrl: d.plan_url, at: frame },
  );
}

const msgs = () => page.evaluate(() => (window as unknown as { __msgs: Msg[] }).__msgs);
async function waitFor(type: string, ms = 30_000): Promise<Msg> {
  const end = Date.now() + ms;
  for (;;) {
    const all = await msgs();
    const errors = all.filter((m) => m.type === 'error');
    if (errors.length) throw new Error(`the frame reported: ${errors.map((e) => e.message).join('; ')}`);
    const m = all.find((x) => x.type === type);
    if (m) return m;
    if (Date.now() > end) throw new Error(`no ${type} within ${ms} ms (got ${JSON.stringify(all).slice(0, 400)})`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** The mean colour of a region of the framed preview (fractions of its size), from a screenshot. */
async function colourAt(fx: number, fy: number, shot?: string): Promise<[number, number, number]> {
  const png = await page.locator('iframe#probe').screenshot();
  if (SHOTS && shot) {
    await mkdir(SHOTS, { recursive: true });
    await writeFile(join(SHOTS, `${shot}.png`), png);
  }
  const [w, h] = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', '-i', 'pipe:0'], { input: png }).toString().trim().split(',').map(Number);
  const rgb = execFileSync('ffmpeg', ['-v', 'error', '-i', 'pipe:0', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { input: png, maxBuffer: 64 * 1024 * 1024 });
  const x = Math.floor(w * fx);
  const y = Math.floor(h * fy);
  const i = (y * w + x) * 3;
  return [rgb[i], rgb[i + 1], rgb[i + 2]];
}

describe.skipIf(!canRun)('the preview frame plays a component preview (Chromium)', () => {
  it("a theme's intro loads as a component-preview, settles and draws the theme; a draft background shows", async () => {
    const d = await preview({ theme: 'editorial', target: 'intro', draft: { background: { type: 'solid', color: '#00c000' } } });
    // At the still's moment: the intro is drawn (its text over the draft background).
    await frameIt(d, d.frame);
    const loaded = await waitFor('loaded');
    expect(loaded.frames).toBe(d.frames);
    expect(loaded.missing).toEqual([]);
    expect((await waitFor('settled')).frame).toBe(d.frame);
    // The draft background, drawn by ComponentPreview over the whole frame (a corner: no text there).
    const [r, g, b] = await colourAt(0.03, 0.05, 'intro-draft');
    expect(g).toBeGreaterThan(150);
    expect(r).toBeLessThan(60);
    expect(b).toBeLessThan(60);
  });

  it('a split layout (panes[*].url, display text) loads and settles in the frame: the frame indexes arrays as the server does', async () => {
    const d = await preview({ theme: 'default', target: { component: 'studio/layout-split' } });
    await frameIt(d, d.frame);
    expect((await waitFor('loaded')).missing).toEqual([]);
    expect((await waitFor('settled')).frame).toBe(d.frame);
  });

  it('⚑ a workspace component not allowed is absent from the frame\'s bundle; the frame says its stand-in draws', async () => {
    const d = await preview({ theme: 'editorial', target: { component: 'acme/held' } });
    expect(d.preview_held?.map((h) => h.id)).toEqual(['acme/held']);
    const bundle = await studio.bundles.get((await memoRegistry(studio.engine.workspace)).registry, (id, hash) => studio.previewAllow.has(id, hash));
    expect(bundle.held).toContain('acme/held');
    expect(bundle.js.includes(MARK)).toBe(false);
    await frameIt(d, 30);
    const loaded = await waitFor('loaded');
    expect(loaded.missing).toEqual(['acme/held']);
    expect(loaded.warnings?.join(' ')).toMatch(/workspace component acme\/held is not run in the preview until you allow it/);
    await waitFor('settled');
    // Its own magenta never shows: the card scaffold draws.
    const [r, g, b] = await colourAt(0.5, 0.5, 'held');
    expect(r > 200 && g < 80 && b > 200).toBe(false);
  });
});
