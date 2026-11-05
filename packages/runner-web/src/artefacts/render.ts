/**
 * Artefact rendering in a clean headless Chromium (no profile, no kit), after the capture so it never competes with
 * the screencast: email HTML → PNG (600 px layout width, full height, sandboxed: JavaScript off, offline, a CSP that
 * blocks scripts and remote loads), PDF → one PNG per page with pdf.js (2× A4: ≈ 1587 × 2245 px), icons → PNG.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, extname, join, normalize, sep } from 'node:path';
import { chromium } from 'playwright-core';
import type { Browser, BrowserContext } from 'playwright-core';
import type { BrowserConfig } from '@retake/core';
import { launchOptions, refuseUnsandboxed } from '../launch.js';
import { launchTarget } from '../session.js';

/** Layout width of a rendered email (CSS px). */
export const EMAIL_WIDTH = 600;
/** Device scale of rendered emails (the PNG is 1200 px wide: crisp in a mail card, also at 4K). */
export const EMAIL_SCALE = 2;
/** Tallest email rendered (CSS px); longer ones are cut. */
export const EMAIL_MAX_HEIGHT = 8000;
/** PDF pages are rasterised at 2× CSS px (96 dpi): an A4 page (595.28 × 841.89 pt) becomes 1587 × 2245 px. */
export const PDF_SCALE = 2 * (96 / 72);
/** At most this many pages are rasterised. */
export const PDF_MAX_PAGES = 30;
/** Icons are rasterised to a square PNG of this size. */
export const ICON_SIZE = 192;

const PDFJS_ORIGIN = 'http://pdfjs.local';

function pdfjsDir(): string {
  const require = createRequire(import.meta.url);
  return dirname(require.resolve('pdfjs-dist/package.json'));
}

const MIME: Record<string, string> = {
  '.mjs': 'text/javascript',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.bcmap': 'application/octet-stream',
  '.pfb': 'application/octet-stream',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.html': 'text/html',
};

export interface RenderedImage {
  width: number;
  height: number;
}

export interface RenderedPage extends RenderedImage {
  width_pt: number;
  height_pt: number;
}

/** A clean browser for artefact rendering, launched on first use. */
export class ArtefactRenderer {
  private browser: Browser | null = null;

  constructor(private readonly config: BrowserConfig = {}) {}

  private async open(): Promise<Browser> {
    if (!this.browser) {
      const { executablePath, channel } = launchTarget(this.config);
      const browser = await chromium.launch({ headless: true, executablePath, channel, ...launchOptions({ args: ['--hide-scrollbars', '--force-color-profile=srgb'] }) });
      await refuseUnsandboxed(browser, () => browser.close(), 'The artefact browser');
      this.browser = browser;
    }
    return this.browser;
  }

  async close(): Promise<void> {
    await this.browser?.close().catch(() => undefined);
    this.browser = null;
  }

  /** Email HTML → PNG at EMAIL_WIDTH × full height (×EMAIL_SCALE). JavaScript off, offline, remote content blocked. */
  async email(html: string, out: string): Promise<RenderedImage> {
    const browser = await this.open();
    const ctx = await browser.newContext({
      viewport: { width: EMAIL_WIDTH, height: 100 },
      deviceScaleFactor: EMAIL_SCALE,
      javaScriptEnabled: false,
      offline: true,
      colorScheme: 'light',
    });
    try {
      await ctx.route('**/*', (r) => (r.request().url().startsWith('data:') ? r.continue() : r.abort()));
      const page = await ctx.newPage();
      await page.setContent(sandboxedEmail(html), { waitUntil: 'load', timeout: 15_000 }).catch(() => undefined);
      const h = await page.evaluate(() => Math.ceil(Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0)));
      const height = Math.max(1, Math.min(EMAIL_MAX_HEIGHT, h));
      await page.setViewportSize({ width: EMAIL_WIDTH, height });
      await page.screenshot({ path: out, clip: { x: 0, y: 0, width: EMAIL_WIDTH, height }, timeout: 30_000 });
      return { width: EMAIL_WIDTH * EMAIL_SCALE, height: height * EMAIL_SCALE };
    } finally {
      await ctx.close().catch(() => undefined);
    }
  }

  /** Icon bytes (png, jpeg, svg, ico, webp…) → a square PNG of ICON_SIZE (contained, transparent background). */
  async icon(bytes: Buffer, mime: string, out: string): Promise<RenderedImage> {
    const browser = await this.open();
    const ctx = await browser.newContext({ viewport: { width: ICON_SIZE, height: ICON_SIZE }, javaScriptEnabled: false, offline: true });
    try {
      const page = await ctx.newPage();
      const src = `data:${mime};base64,${bytes.toString('base64')}`;
      await page.setContent(
        `<!doctype html><html><body style="margin:0;background:transparent"><img src="${src}" style="width:${ICON_SIZE}px;height:${ICON_SIZE}px;object-fit:contain;display:block"></body></html>`,
        { waitUntil: 'load', timeout: 10_000 },
      );
      await page.screenshot({ path: out, omitBackground: true, clip: { x: 0, y: 0, width: ICON_SIZE, height: ICON_SIZE } });
      return { width: ICON_SIZE, height: ICON_SIZE };
    } finally {
      await ctx.close().catch(() => undefined);
    }
  }

  /** PDF → documents/<name>/page-<n>.png with pdf.js inside Chromium (no system tools). */
  async pdf(file: string, outDir: string): Promise<Array<RenderedPage & { file: string }>> {
    const browser = await this.open();
    const bytes = await readFile(file);
    const ctx = await browser.newContext({ viewport: { width: 800, height: 600 } });
    try {
      await servePdfjs(ctx, bytes);
      const page = await ctx.newPage();
      await page.goto(`${PDFJS_ORIGIN}/index.html`, { waitUntil: 'load' });
      await page.waitForFunction(() => (window as unknown as { pdfReady?: boolean }).pdfReady === true, undefined, { timeout: 30_000 });
      const count = await page.evaluate(async () => (window as unknown as { openPdf: () => Promise<number> }).openPdf());
      const pages: Array<RenderedPage & { file: string }> = [];
      for (let i = 1; i <= Math.min(count, PDF_MAX_PAGES); i++) {
        const r = await page.evaluate(
          async ([n, scale]) => (window as unknown as { renderPage: (n: number, s: number) => Promise<RenderedPage & { data: string }> }).renderPage(n, scale),
          [i, PDF_SCALE] as [number, number],
        );
        const out = join(outDir, `page-${i}.png`);
        await writeFile(out, Buffer.from(r.data.slice(r.data.indexOf(',') + 1), 'base64'));
        pages.push({ file: out, width: r.width, height: r.height, width_pt: r.width_pt, height_pt: r.height_pt });
      }
      return pages;
    } finally {
      await ctx.close().catch(() => undefined);
    }
  }
}

/** The email's HTML with a CSP (no scripts, no remote loads: only inline styles and data: images) and a white page. */
export function sandboxedEmail(html: string): string {
  const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:">`;
  const base = '<style>html{background:#ffffff}body{margin:0}</style>';
  const body = html.trim() ? html : '<p></p>';
  if (/<head[^>]*>/i.test(body)) return body.replace(/<head[^>]*>/i, (m) => `${m}${csp}${base}`);
  if (/<html[^>]*>/i.test(body)) return body.replace(/<html[^>]*>/i, (m) => `${m}<head>${csp}${base}</head>`);
  return `<!doctype html><html><head><meta charset="utf-8">${csp}${base}</head><body>${body}</body></html>`;
}

/** pdf.js (module build + worker + fonts/cmaps) and the document, served from memory and node_modules. */
async function servePdfjs(ctx: BrowserContext, pdf: Buffer): Promise<void> {
  const root = pdfjsDir();
  const index = `<!doctype html><html><body><script type="module">
import * as pdfjs from '/build/pdf.mjs';
pdfjs.GlobalWorkerOptions.workerSrc = '/build/pdf.worker.mjs';
let doc = null;
window.openPdf = async () => {
  doc = await pdfjs.getDocument({ url: '/document.pdf', standardFontDataUrl: '/standard_fonts/', cMapUrl: '/cmaps/', cMapPacked: true, isEvalSupported: false }).promise;
  return doc.numPages;
};
window.renderPage = async (n, scale) => {
  const page = await doc.getPage(n);
  const base = page.getViewport({ scale: 1 });
  const vp = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(vp.width);
  canvas.height = Math.round(vp.height);
  const g = canvas.getContext('2d');
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: g, canvas, viewport: vp, background: '#ffffff' }).promise;
  const data = canvas.toDataURL('image/png');
  page.cleanup();
  return { data, width: canvas.width, height: canvas.height, width_pt: Math.round(base.width * 100) / 100, height_pt: Math.round(base.height * 100) / 100 };
};
window.pdfReady = true;
</script></body></html>`;
  await ctx.route(`${PDFJS_ORIGIN}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/index.html') return route.fulfill({ status: 200, contentType: 'text/html', body: index });
    if (path === '/document.pdf') return route.fulfill({ status: 200, contentType: 'application/pdf', body: pdf });
    const file = normalize(join(root, decodeURIComponent(path)));
    if (!file.startsWith(root + sep)) return route.fulfill({ status: 403, body: '' });
    try {
      const body = await readFile(file);
      return route.fulfill({ status: 200, contentType: MIME[extname(file)] ?? 'application/octet-stream', body });
    } catch {
      return route.fulfill({ status: 404, body: '' });
    }
  });
  await ctx.route((url) => !url.href.startsWith(PDFJS_ORIGIN) && !url.href.startsWith('data:') && !url.href.startsWith('blob:'), (r) => r.abort());
}
