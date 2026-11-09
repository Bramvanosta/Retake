/**
 * Transparent cursor layer of a raw export (L2.13, R-RAW-02 `--cursor layer`): the in-page cursor and its click
 * ripples drawn alone, frame-aligned with a clip, as ProRes 4444 (.mov) or VP9 with alpha (.webm).
 *
 * The look is the kit's own: Chromium draws the kit's cursor overlay (its stylesheet and markup, `api.cursorLook`)
 * into an atlas — every icon at every press scale, and the ripple at every age (1/120 s) — screenshotted with a
 * transparent background at the capture's device scale; Node then composites the sprites frame by frame from the
 * cursor track (`cursorFrames`) and pipes raw RGBA to ffmpeg.
 */
import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { chromium } from 'playwright-core';
import type { BrowserConfig, CursorIcon, RawLayerFormat } from '@retake/core';
import { EncodeError } from '../errors.js';
import { kitSource } from '../kit/source.js';
import type { KitConfig } from '../kit/types.js';
import { launchOptions, refuseUnsandboxed } from '../launch.js';
import { DEFAULT_BROWSER_ARGS, launchTarget } from '../session.js';
import { CURSOR_LOOK, type CursorFrame } from './cursor.js';
import { ffmpegBin } from '@retake/core';

/** Atlas geometry (CSS px): each sprite in a cell, its hotspot (the cursor point / ripple centre) at `hot`. */
export const ATLAS = { cell: 128, hot: 64, columns: 12, ripple_step_s: 1 / 120, scale_steps: 10 } as const;

/** One sprite: the opaque part of its cell (RGBA, straight alpha) and where that part sits relative to the hotspot. */
export interface Sprite {
  /** Offset of the sprite's top-left from the hotspot (device px). */
  dx: number;
  dy: number;
  w: number;
  h: number;
  data: Buffer;
}

export interface CursorAtlas {
  /** Device scale factor the sprites were drawn at. */
  scale: number;
  /** icon → sprite per press-scale step (index 0 = scale 1, last = 0.9). */
  cursor: Record<CursorIcon, Sprite[]>;
  /** Ripple sprite per age step (`ripple_step_s`). */
  ripple: Sprite[];
}

const ICONS: CursorIcon[] = ['arrow', 'hand', 'ibeam'];

/** Press-scale step of a scale (1 → 0, 0.9 → `scale_steps`). */
export function scaleStep(scale: number): number {
  const u = (1 - scale) / (1 - CURSOR_LOOK.press_scale);
  return Math.max(0, Math.min(ATLAS.scale_steps, Math.round(u * ATLAS.scale_steps)));
}

function run(bin: string, args: string[], input?: Buffer): Promise<Buffer> {
  return new Promise((ok, fail) => {
    const child = execFile(bin, args, { encoding: 'buffer', maxBuffer: 512 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) fail(new EncodeError(`${bin} failed: ${String(stderr).trim().split('\n').slice(-3).join(' | ') || err.message}`));
      else ok(stdout as unknown as Buffer);
    });
    if (input) child.stdin?.end(input);
  });
}

/** Opaque bounding box of a cell → sprite (null when the cell is empty). */
function cutSprite(rgba: Buffer, stride: number, x0: number, y0: number, size: number, hot: number): Sprite | null {
  let minX = size;
  let minY = size;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < size; y++) {
    const row = ((y0 + y) * stride + x0) * 4;
    for (let x = 0; x < size; x++) {
      if (rgba[row + x * 4 + 3] !== 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  const w = maxX - minX + 1;
  const h = maxY - minY + 1;
  const data = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) rgba.copy(data, y * w * 4, ((y0 + minY + y) * stride + x0 + minX) * 4, ((y0 + minY + y) * stride + x0 + minX + w) * 4);
  return { dx: minX - hot, dy: minY - hot, w, h, data };
}

/**
 * Draw the atlas with Chromium: the kit's cursor look (`kitSource(kit)` evaluated in a blank page, its `cursorLook`
 * reused in open shadow roots) for each icon × press scale and the ripple at each age, transitions off, the ripple's
 * animations paused at that age; one transparent screenshot at `scale`, decoded with ffmpeg.
 */
export async function renderCursorAtlas(opts: { kit: KitConfig; scale: number; browser?: BrowserConfig; ffmpeg?: string }): Promise<CursorAtlas> {
  const { cell, hot, columns } = ATLAS;
  const rippleCount = Math.ceil(CURSOR_LOOK.ripple_ms / 1000 / ATLAS.ripple_step_s);
  const specs: Array<{ icon?: CursorIcon; scale?: number; age_ms?: number }> = [];
  for (const icon of ICONS) for (let k = 0; k <= ATLAS.scale_steps; k++) specs.push({ icon, scale: 1 - (k / ATLAS.scale_steps) * (1 - CURSOR_LOOK.press_scale) });
  for (let k = 0; k < rippleCount; k++) specs.push({ age_ms: k * ATLAS.ripple_step_s * 1000 });
  const rows = Math.ceil(specs.length / columns);
  const target = launchTarget(opts.browser);
  const browser = await chromium.launch({ headless: true, ...target, ...launchOptions({ args: [...DEFAULT_BROWSER_ARGS, ...(opts.browser?.args ?? [])] }) });
  await refuseUnsandboxed(browser, () => browser.close(), 'The cursor layer browser');
  let png: Buffer;
  try {
    const page = await browser.newPage({ viewport: { width: columns * cell, height: rows * cell }, deviceScaleFactor: opts.scale });
    await page.setContent('<!doctype html><html><head><style>html,body{margin:0;background:transparent}</style></head><body></body></html>');
    await page.addScriptTag({ content: kitSource({ ...opts.kit, cursor: { ...opts.kit.cursor, hidden: false } }) });
    await page.evaluate(
      ({ specs, cell, hot, columns }) => {
        const api = (window as unknown as { __retake: { cursorLook: { css: string; html: string }; cursor: { hide(): void } } }).__retake;
        api.cursor.hide();
        const { css, html } = api.cursorLook;
        specs.forEach((s, i) => {
          const box = document.createElement('div');
          box.setAttribute('style', `position:absolute;left:${(i % columns) * cell}px;top:${Math.floor(i / columns) * cell}px;width:${cell}px;height:${cell}px;overflow:hidden`);
          const host = document.createElement('div');
          box.appendChild(host);
          document.body.appendChild(box);
          const root = host.attachShadow({ mode: 'open' });
          root.innerHTML = `<style>${css}.s{transition:none!important}.rp{animation-play-state:paused!important}</style>${html}`;
          const c = root.querySelector('.c') as HTMLElement;
          if (s.icon) {
            c.classList.add('on');
            c.dataset.k = s.icon;
            c.style.transform = `translate3d(${hot}px,${hot}px,0)`;
            (root.querySelector('.s') as HTMLElement).style.transform = `scale(${s.scale})`;
          } else {
            const d = document.createElement('div');
            d.className = 'rp';
            d.style.setProperty('--p', `translate(${hot}px,${hot}px)`);
            d.style.transform = `translate(${hot}px,${hot}px)`;
            d.style.animationDelay = `-${s.age_ms}ms, -${s.age_ms}ms`;
            (root.querySelector('.rps') as HTMLElement).appendChild(d);
          }
        });
      },
      { specs, cell, hot, columns },
    );
    await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
    png = await page.screenshot({ type: 'png', omitBackground: true, fullPage: false });
  } finally {
    await browser.close().catch(() => undefined);
  }
  const W = columns * cell * opts.scale;
  const H = rows * cell * opts.scale;
  const rgba = await run(ffmpegBin(opts.ffmpeg), ['-v', 'error', '-f', 'png_pipe', '-i', 'pipe:0', '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1'], png);
  if (rgba.length !== W * H * 4) throw new EncodeError(`cursor atlas: decoded ${rgba.length} bytes, expected ${W}×${H} RGBA`);
  const empty: Sprite = { dx: 0, dy: 0, w: 0, h: 0, data: Buffer.alloc(0) };
  const sprite = (i: number) => cutSprite(rgba, W, (i % columns) * cell * opts.scale, Math.floor(i / columns) * cell * opts.scale, cell * opts.scale, hot * opts.scale) ?? empty;
  const atlas: CursorAtlas = { scale: opts.scale, cursor: { arrow: [], hand: [], ibeam: [] }, ripple: [] };
  let i = 0;
  for (const icon of ICONS) for (let k = 0; k <= ATLAS.scale_steps; k++) atlas.cursor[icon].push(sprite(i++));
  for (let k = 0; k < rippleCount; k++) atlas.ripple.push(sprite(i++));
  if (ICONS.some((ic) => atlas.cursor[ic][0].w === 0)) throw new EncodeError('cursor atlas: the kit drew no cursor (its look could not be rendered)');
  return atlas;
}

/** Straight-alpha "over" of a sprite onto an RGBA frame at device point (px, py) = the sprite's hotspot. */
export function blit(frame: Buffer, width: number, height: number, s: Sprite, px: number, py: number): { x: number; y: number; w: number; h: number } | null {
  if (s.w === 0) return null;
  const x0 = Math.round(px) + s.dx;
  const y0 = Math.round(py) + s.dy;
  const ax = Math.max(0, x0);
  const ay = Math.max(0, y0);
  const bx = Math.min(width, x0 + s.w);
  const by = Math.min(height, y0 + s.h);
  if (bx <= ax || by <= ay) return null;
  for (let y = ay; y < by; y++) {
    let si = ((y - y0) * s.w + (ax - x0)) * 4;
    let di = (y * width + ax) * 4;
    for (let x = ax; x < bx; x++, si += 4, di += 4) {
      const sa = s.data[si + 3];
      if (sa === 0) continue;
      const da = frame[di + 3];
      if (sa === 255 || da === 0) {
        frame[di] = s.data[si];
        frame[di + 1] = s.data[si + 1];
        frame[di + 2] = s.data[si + 2];
        frame[di + 3] = sa;
        continue;
      }
      // out_a = sa + da·(1 − sa); out_c = (sc·sa + dc·da·(1 − sa)) / out_a (×255 fixed point).
      const inv = 255 - sa;
      const oa = sa * 255 + da * inv;
      for (let c = 0; c < 3; c++) frame[di + c] = Math.round((s.data[si + c] * sa * 255 + frame[di + c] * da * inv) / oa);
      frame[di + 3] = Math.round(oa / 255);
    }
  }
  return { x: ax, y: ay, w: bx - ax, h: by - ay };
}

/** Draw one cursor frame (ripples under the icon, as the kit stacks them) onto a cleared RGBA frame. */
export function drawCursorFrame(frame: Buffer, width: number, height: number, atlas: CursorAtlas, c: CursorFrame, pxScale: number): Array<{ x: number; y: number; w: number; h: number }> {
  const dirty: Array<{ x: number; y: number; w: number; h: number }> = [];
  for (const r of c.ripples) {
    const k = Math.min(atlas.ripple.length - 1, Math.max(0, Math.round(r.age / ATLAS.ripple_step_s)));
    const d = blit(frame, width, height, atlas.ripple[k], r.x * pxScale, r.y * pxScale);
    if (d) dirty.push(d);
  }
  if (c.visible) {
    const d = blit(frame, width, height, atlas.cursor[c.icon][scaleStep(c.scale)], c.x * pxScale, c.y * pxScale);
    if (d) dirty.push(d);
  }
  return dirty;
}

/** ffmpeg arguments of a layer: raw RGBA in, ProRes 4444 (prores_aw, straight alpha, BT.709) or VP9 + alpha out. */
export function layerArgs(format: RawLayerFormat, width: number, height: number, fps: number, frames: number, out: string, timecode: string): string[] {
  const input = ['-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${width}x${height}`, '-framerate', String(fps), '-i', 'pipe:0'];
  const tags = ['-color_range', 'tv', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709'];
  if (format === 'webm') {
    return [
      '-y', '-hide_banner', '-loglevel', 'error', ...input,
      '-vf', 'scale=out_color_matrix=bt709:out_range=tv,format=yuva420p',
      '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-b:v', '0', '-crf', '18', '-deadline', 'good', '-cpu-used', '4', '-row-mt', '1', '-auto-alt-ref', '0',
      ...tags, '-frames:v', String(frames), '-an', out,
    ];
  }
  return [
    '-y', '-hide_banner', '-loglevel', 'error', ...input,
    '-vf', 'scale=out_color_matrix=bt709:out_range=tv,format=yuva444p10le',
    // prores_aw: ≈ 5× faster than prores_ks on these mostly empty frames, alpha kept within 1/255 (measured).
    '-c:v', 'prores_aw', '-profile:v', '4', '-pix_fmt', 'yuva444p10le', '-vendor', 'apl0',
    ...tags, '-timecode', timecode, '-frames:v', String(frames), '-an', out,
  ];
}

/**
 * Encode a clip's cursor layer: one RGBA frame per clip frame (the frame buffer is reused — only the drawn boxes are
 * cleared), written to ffmpeg's stdin with back-pressure.
 */
export async function encodeCursorLayer(opts: {
  atlas: CursorAtlas;
  frames: readonly CursorFrame[];
  width: number;
  height: number;
  /** Device px per CSS px of the clip's page. */
  pxScale: number;
  fps: number;
  format: RawLayerFormat;
  out: string;
  timecode: string;
  ffmpeg?: string;
  signal?: AbortSignal;
}): Promise<void> {
  const { width, height } = opts;
  const bin = ffmpegBin(opts.ffmpeg);
  const child = spawn(bin, layerArgs(opts.format, width, height, opts.fps, opts.frames.length, opts.out, opts.timecode), { stdio: ['pipe', 'ignore', 'pipe'] });
  let err = '';
  child.stderr.on('data', (d: Buffer) => {
    err = (err + d.toString()).slice(-4000);
  });
  const done = new Promise<void>((ok, fail) => {
    child.on('error', (e: NodeJS.ErrnoException) => fail(new EncodeError(e.code === 'ENOENT' ? `${bin} not found: install ffmpeg` : e.message)));
    child.on('close', (code) => (code === 0 ? ok() : fail(new EncodeError(`${bin} exited with code ${code} (cursor layer): ${err.trim().split('\n').slice(-4).join(' | ')}`))));
  });
  const onAbort = () => child.kill('SIGTERM');
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  const frame = Buffer.alloc(width * height * 4);
  let dirty: Array<{ x: number; y: number; w: number; h: number }> = [];
  try {
    for (const c of opts.frames) {
      if (opts.signal?.aborted) break;
      for (const d of dirty) for (let y = d.y; y < d.y + d.h; y++) frame.fill(0, (y * width + d.x) * 4, (y * width + d.x + d.w) * 4);
      dirty = drawCursorFrame(frame, width, height, opts.atlas, c, opts.pxScale);
      const ok = await new Promise<boolean>((res) => {
        if (!child.stdin.writable) return res(false);
        child.stdin.write(frame, (e) => res(!e));
      });
      if (!ok) break;
    }
  } finally {
    child.stdin.end();
    opts.signal?.removeEventListener('abort', onAbort);
  }
  await done;
}
