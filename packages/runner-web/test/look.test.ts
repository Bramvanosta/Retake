import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from 'playwright-core';
import { kitConfigFor, openSession } from '../src/index.js';
import type { BrowserSession } from '../src/index.js';
import { LOOK_PAGE } from './pages.js';
import { decodePng, startServer } from './helpers.js';
import type { RgbImage, TestServer } from './helpers.js';

/**
 * The cursor and file-chip look (L1.4: R-KIT-06, R-LOOK-23, R-LOOK-24), in two layers: structural checks that carry the
 * assertion (fill, outline, size, shadow, the ripple's colour and alpha, the chip's card, badge colour and tilt), and
 * a golden image compared with a tolerance (a Chromium update or another rasteriser moves a few pixels, not the look).
 * The chip's golden is compared on macOS only: its text uses the system UI font. Goldens are written only on request:
 * DEMO_STUDIO_UPDATE_GOLDEN=1 npx vitest run packages/runner-web/test/look.test.ts — then look at the PNGs.
 */
const GOLDEN = fileURLToPath(new URL('./golden/', import.meta.url));
const UPDATE = process.env.DEMO_STUDIO_UPDATE_GOLDEN === '1';
/** The default template's ripple (templates/default/template.yaml): the accent at alpha .45. */
const RIPPLE = 'rgba(59, 94, 201, 0.45)';
const ACCENT = [59, 94, 201];
/** LOOK_PAGE's background. */
const BG = [154, 163, 173];
const HOT = { x: 200, y: 150 };

let server: TestServer;
let dark: BrowserSession;
let light: BrowserSession;
let darkPage: Page;
let lightPage: Page;

beforeAll(async () => {
  server = await startServer({ '/look.html': LOOK_PAGE });
  // The kit configuration is per browser: one session per cursor style (launched together).
  [dark, light] = await Promise.all([
    openSession({ width: 900, height: 500, scale: 1, kit: kitConfigFor(undefined, { style: 'arrow-dark', ripple_color: RIPPLE }) }),
    openSession({ width: 900, height: 500, scale: 1, kit: kitConfigFor(undefined, { style: 'arrow-light' }) }),
  ]);
  [darkPage, lightPage] = await Promise.all([dark.page('main'), light.page('main')]);
  await Promise.all([darkPage.goto(`${server.url}/look.html`), lightPage.goto(`${server.url}/look.html`)]);
});

afterAll(async () => {
  await dark?.close();
  await light?.close();
  await server?.close();
});

/** Two animation frames and 100 ms: what was set is painted. */
async function painted(p: Page): Promise<void> {
  await p.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
  await p.waitForTimeout(100);
}

async function shot(p: Page, clip: { x: number; y: number; width: number; height: number }): Promise<{ png: Buffer; img: RgbImage }> {
  const png = await p.screenshot({ clip, type: 'png' });
  return { png, img: await decodePng(png) };
}

const px = (img: RgbImage, x: number, y: number): [number, number, number] => {
  const i = (y * img.w + x) * 3;
  return [img.data[i], img.data[i + 1], img.data[i + 2]];
};
const lum = ([r, g, b]: readonly number[]): number => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const BG_LUM = lum(BG);
/** Largest channel difference from the page background. */
const fromBg = (c: readonly number[]): number => Math.max(Math.abs(c[0] - BG[0]), Math.abs(c[1] - BG[1]), Math.abs(c[2] - BG[2]));

/** Bounding box of the pixels matching `test`. */
function bbox(img: RgbImage, test: (c: [number, number, number], x: number, y: number) => boolean): { x: number; y: number; w: number; h: number; n: number } {
  let x0 = img.w;
  let y0 = img.h;
  let x1 = -1;
  let y1 = -1;
  let n = 0;
  for (let y = 0; y < img.h; y++) {
    for (let x = 0; x < img.w; x++) {
      if (!test(px(img, x, y), x, y)) continue;
      n++;
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      y0 = Math.min(y0, y);
      y1 = Math.max(y1, y);
    }
  }
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1, n };
}

/**
 * Compare with a committed golden PNG: mean |Δ| ≤ 3 levels and at most 1 % of the channel values more than 48 levels
 * apart. A missing golden fails (written only with DEMO_STUDIO_UPDATE_GOLDEN=1).
 */
async function matchesGolden(name: string, png: Buffer, img: RgbImage): Promise<void> {
  const file = join(GOLDEN, name);
  if (UPDATE) {
    await mkdir(GOLDEN, { recursive: true });
    await writeFile(file, png);
    return;
  }
  if (!existsSync(file)) {
    throw new Error(`golden image ${name} is missing: run \`DEMO_STUDIO_UPDATE_GOLDEN=1 npx vitest run packages/runner-web/test/look.test.ts\` and look at the PNGs in ${GOLDEN}`);
  }
  const want = await decodePng(await readFile(file));
  expect([img.w, img.h], `${name}: size`).toEqual([want.w, want.h]);
  let sum = 0;
  let far = 0;
  for (let i = 0; i < img.data.length; i++) {
    const d = Math.abs(img.data[i] - want.data[i]);
    sum += d;
    if (d > 48) far++;
  }
  const mean = sum / img.data.length;
  expect(mean, `${name}: mean difference`).toBeLessThanOrEqual(3);
  expect(far / img.data.length, `${name}: share of values more than 48 levels apart`).toBeLessThanOrEqual(0.01);
}

describe('cursor look (R-KIT-06, R-LOOK-23)', () => {
  /** The 40×40 clip around the hotspot (it sits at 10, 10 in it). */
  const CLIP = { x: HOT.x - 10, y: HOT.y - 10, width: 40, height: 40 };

  async function arrow(s: BrowserSession, p: Page): Promise<{ png: Buffer; img: RgbImage }> {
    await s.kit(p).cursorSet(HOT.x, HOT.y, true);
    await painted(p);
    return shot(p, CLIP);
  }

  it('arrow-dark: a dark arrow with a white outline and a soft shadow, about 26 px tall', async () => {
    const { png, img } = await arrow(dark, darkPage);
    // Interior, 3 px right and 10 px below the hotspot: dark.
    expect(lum(px(img, 13, 20))).toBeLessThan(40);
    // The outline along the left edge (the hotspot's column and the one left of it): white, far brighter than the page.
    let outline = 0;
    for (let y = 14; y <= 24; y++) outline = Math.max(outline, ...[8, 9, 10].map((x) => lum(px(img, x, y))));
    expect(outline).toBeGreaterThan(235);
    // Size: what differs clearly from the page (arrow and outline) — 17 × 23 px for 26 px (20 px: 13 × 18; 32: 21 × 28).
    const box = bbox(img, (c) => fromBg(c) > 30);
    expect(box).toMatchObject({ x: 9, y: 9 }); // starts at the hotspot (its outline 1 px before)
    expect(box.w).toBeGreaterThanOrEqual(15);
    expect(box.w).toBeLessThanOrEqual(19);
    expect(box.h).toBeGreaterThanOrEqual(21);
    expect(box.h).toBeLessThanOrEqual(26);
    // A soft shadow under the tail: a few levels darker than the page, fading out (no hard edge, not missing).
    const darker = (y: number) => Math.max(...Array.from({ length: 15 }, (_, i) => BG_LUM - lum(px(img, 12 + i, y))));
    const near = Math.max(darker(33), darker(34));
    expect(near).toBeGreaterThan(4);
    expect(near).toBeLessThan(40);
    expect(darker(38)).toBeLessThan(near / 2);
    await matchesGolden('cursor-arrow-dark.png', png, img);
  });

  it('arrow-light: a light arrow with a dark outline, the same shape', async () => {
    const { png, img } = await arrow(light, lightPage);
    expect(lum(px(img, 13, 20))).toBeGreaterThan(235);
    let outline = 255;
    for (let y = 14; y <= 24; y++) outline = Math.min(outline, ...[8, 9, 10].map((x) => lum(px(img, x, y))));
    expect(outline).toBeLessThan(60);
    const box = bbox(img, (c) => fromBg(c) > 30);
    expect(box).toMatchObject({ x: 9, y: 9 });
    expect(box.w).toBeGreaterThanOrEqual(15);
    expect(box.w).toBeLessThanOrEqual(19);
    expect(box.h).toBeGreaterThanOrEqual(21);
    expect(box.h).toBeLessThanOrEqual(26);
    await matchesGolden('cursor-arrow-light.png', png, img);
  });

  it("the click ripple is the template's accent at alpha ≈ .45 (paused mid-animation through CDP)", async () => {
    const C = { x: 600, y: 300 }; // away from the cursor
    const cdp = await darkPage.context().newCDPSession(darkPage);
    await cdp.send('Animation.enable');
    const started: Array<{ id: string; name: string }> = [];
    cdp.on('Animation.animationStarted', (e: { animation: { id: string; name: string } }) => started.push(e.animation));
    await dark.kit(darkPage).ripple(C.x, C.y);
    for (let i = 0; i < 50 && started.length < 2; i++) await darkPage.waitForTimeout(10);
    const ids = started.map((a) => a.id);
    expect(started.map((a) => a.name).sort()).toEqual(['dsr-o', 'dsr-t']);
    await cdp.send('Animation.setPaused', { animations: ids, paused: true });
    await cdp.send('Animation.seekAnimations', { animations: ids, currentTime: 200 });
    // The disc's own opacity at that time (the dsr-o fade), read on the animation's target in the closed shadow root.
    const { remoteObject } = (await cdp.send('Animation.resolveAnimation', { animationId: ids[0] })) as { remoteObject: { objectId: string } };
    const { result } = (await cdp.send('Runtime.callFunctionOn', {
      objectId: remoteObject.objectId,
      functionDeclaration: 'function () { return Number(getComputedStyle(this.effect.target).opacity); }',
      returnByValue: true,
    })) as { result: { value: number } };
    const opacity = result.value;
    await darkPage.waitForTimeout(50);
    const { img } = await shot(darkPage, { x: C.x - 3, y: C.y - 3, width: 7, height: 7 });
    await cdp.detach();
    // The disc's centre: the page blended with one colour at one alpha — least squares along (accent − page).
    const mean = [0, 1, 2].map((ch) => {
      let s = 0;
      for (let i = ch; i < img.data.length; i += 3) s += img.data[i];
      return s / (img.data.length / 3);
    });
    const v = ACCENT.map((a, i) => a - BG[i]);
    const d = mean.map((m, i) => m - BG[i]);
    const k = (d[0] * v[0] + d[1] * v[1] + d[2] * v[2]) / (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
    const residual = Math.max(...d.map((x, i) => Math.abs(x - k * v[i])));
    // 200 ms into the .55 s ease-out fade, the disc is about half opaque.
    expect(opacity).toBeGreaterThan(0.2);
    expect(opacity).toBeLessThan(0.95);
    expect(mean[2]).toBeGreaterThan(BG[2]); // bluer than the page: the accent's hue, not a grey shade
    expect(residual).toBeLessThanOrEqual(4); // one colour: the accent (a grey or another hue leaves a residual)
    // Its alpha: what the page shows divided by the disc's opacity (± .05: integer pixels at about a fifth of the way).
    expect(k / opacity).toBeGreaterThan(0.4);
    expect(k / opacity).toBeLessThan(0.5);
  });
});

describe('file chip (R-LOOK-24)', () => {
  it('a white card with the type badge, name and detail, tilted −3°, following the cursor, with a soft shadow', async () => {
    await darkPage.goto(`${server.url}/look.html`); // a fresh page: no ripple left from the test above
    const kit = dark.kit(darkPage);
    await kit.cursorSet(400, 300, true);
    await kit.ghostShow('Northfield - Price list 2027.xlsx', '48 KB');
    await darkPage.waitForTimeout(400); // the card fades in over .25 s
    await painted(darkPage);
    const clip = { x: 350, y: 240, width: 340, height: 150 };
    const { png, img } = await shot(darkPage, clip);
    // It follows the cursor: moved by (−20, −10), the card moves by as much.
    await kit.cursorSet(380, 290, true);
    await painted(darkPage);
    const moved = (await shot(darkPage, clip)).img;
    await kit.ghostHide();
    const white = (c: readonly number[]) => Math.min(...c) > 245;
    const card = bbox(img, white);
    const card2 = bbox(moved, white);
    expect([card2.x - card.x, card2.y - card.y, card2.w, card2.h]).toEqual([-20, -10, card.w, card.h]);
    // The badge in the colour of .xlsx (kit EXT_COLORS #1f8a4c), 36×44 px turned by 3°.
    const badge = bbox(img, (c) => Math.hypot(c[0] - 0x1f, c[1] - 0x8a, c[2] - 0x4c) < 40);
    // Tilt: the card's top edge 20 px in from each end (the first card pixel from the top of the column).
    const topAt = (x: number) => {
      for (let y = 0; y < img.h; y++) if (white(px(img, x, y))) return y;
      return -1;
    };
    const xl = card.x + 20;
    const xr = card.x + card.w - 21;
    const slope = (topAt(xr) - topAt(xl)) / (xr - xl);
    const bottomAt = (x: number) => {
      for (let y = img.h - 1; y >= 0; y--) if (white(px(img, x, y))) return y;
      return -1;
    };
    // Shadow: under the card's middle, 4–20 px below its bottom edge, darker than the page.
    const mid = card.x + Math.round(card.w / 2);
    let shadow = 0;
    for (let y = bottomAt(mid) + 4; y <= bottomAt(mid) + 20; y++) shadow = Math.max(shadow, BG_LUM - lum(px(img, mid, y)));
    // The card's middle band, right of the badge: mostly white (the rest is the name and detail text).
    const band = { x0: badge.x + badge.w + 10, x1: card.x + card.w - 30 };
    let inBand = 0;
    let whiteInBand = 0;
    let ink = 0;
    for (let x = band.x0; x <= band.x1; x++) {
      const top = topAt(x);
      const bottom = bottomAt(x);
      for (let y = top + 4; y <= bottom - 4; y++) {
        inBand++;
        const c = px(img, x, y);
        if (white(c)) whiteInBand++;
        if (lum(c) < 90) ink++;
      }
    }
    expect(badge.w).toBeGreaterThanOrEqual(34);
    expect(badge.w).toBeLessThanOrEqual(41);
    expect(badge.h).toBeGreaterThanOrEqual(41);
    expect(badge.h).toBeLessThanOrEqual(48);
    expect(badge.n).toBeGreaterThan(800); // a filled badge, not an outline (the fold and "XLSX" take the rest)
    // The card is about 300 × 66 px: turned by 3°, its bounding box is about 15 px taller than the card.
    expect(card.w).toBeGreaterThan(260);
    expect(card.h).toBeGreaterThan(70);
    expect(card.h).toBeLessThan(90);
    expect(Math.abs(slope + Math.tan((3 * Math.PI) / 180))).toBeLessThanOrEqual(0.015);
    expect(shadow).toBeGreaterThan(8);
    expect(shadow).toBeLessThan(60);
    expect(whiteInBand / inBand).toBeGreaterThan(0.6);
    expect(ink).toBeGreaterThan(300); // the name, in dark ink
    // The chip's text uses the system UI font: its golden is compared on macOS only (the checks above hold everywhere).
    if (process.platform === 'darwin') await matchesGolden('file-chip-darwin.png', png, img);
  });
});
