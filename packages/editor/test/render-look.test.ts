/**
 * Measurement of the reference look (docs/reference/look.md) on REAL renders: stills of the quote fixture plan
 * (editorial theme, built-in library, over a generated colour-coded capture of the run's length) and of the tiny
 * synthetic plan at half size, analysed pixel by pixel — the accent rules, the card edges, the caption kicker and
 * line, the brand mark, the logo rows, the clock and the texts — against the measured positions, with tolerances of a
 * few px (fonts differ from the reference's; geometry does not). Also: the staggered motion at a few instants, layout
 * geometry following params on screen, and determinism (the same frame rendered twice is the same image).
 * Needs ffmpeg/ffprobe and a Chromium headless shell (Playwright's or $RETAKE_CHROMIUM_HEADLESS_SHELL).
 */
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadComponentRegistry } from '@retake/components';
import type { ComponentRegistry } from '@retake/components';
import { loadProjectTemplate, readJson, fileFacts } from '@retake/core/io';
import type { LoadedProject, LoadedTemplate, Timeline } from '@retake/core';
import { planEdit, renderStills } from '@retake/editor';
import type { EditOverrides, EditPlan, PlanSegment } from '@retake/editor';
import { REPO, fixtureProject, realTimeline, template } from './helpers.js';
import { SHARED_CACHE, hasTool, makeColourCapture, renderWorkspace } from './render-helpers.js';
import type { RenderWorkspace } from './render-helpers.js';
import { PERSON_POLICY } from '@retake/core';

const canRender = hasTool('ffmpeg') && hasTool('ffprobe');
const LONG = 400_000;

// ── Pixel analysis ────────────────────────────────────────────────────────────

type RGB = [number, number, number];

interface Image {
  w: number;
  h: number;
  px: Buffer;
}

function readImage(file: string): Image {
  const probe = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file], { encoding: 'utf8' }).trim();
  const [w, h] = probe.split(',').map(Number);
  const px = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: w * h * 3 + 1024 });
  return { w, h, px };
}

const at = (img: Image, x: number, y: number): RGB => {
  const i = (y * img.w + x) * 3;
  return [img.px[i], img.px[i + 1], img.px[i + 2]];
};

const hex = (c: string): RGB => [1, 3, 5].map((i) => Number.parseInt(c.slice(i, i + 2), 16)) as RGB;
const dist = (a: RGB, b: RGB) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
const near = (c: RGB, tol: number) => (p: RGB) => dist(p, c) <= tol;

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  count: number;
}

/**
 * Cap band of a line of text in region [x0, x1) × [y0, y1): the most frequent top and bottom of its columns — the flat
 * tops and the baseline, leaving out diacritics (É), round overshoots and descenders, which platforms rasterise
 * differently.
 */
function capBand(img: Image, region: [number, number, number, number], pred: (p: RGB) => boolean): { y0: number; y1: number } | undefined {
  const [rx0, ry0, rx1, ry1] = region;
  const tops = new Map<number, number>();
  const bottoms = new Map<number, number>();
  for (let x = rx0; x < rx1; x++) {
    let top = -1;
    let bottom = -1;
    for (let y = ry0; y < ry1; y++) {
      if (!pred(at(img, x, y))) continue;
      if (top < 0) top = y;
      bottom = y;
    }
    if (top < 0) continue;
    tops.set(top, (tops.get(top) ?? 0) + 1);
    bottoms.set(bottom, (bottoms.get(bottom) ?? 0) + 1);
  }
  const mode = (m: Map<number, number>) => [...m].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0];
  const y0 = mode(tops);
  const y1 = mode(bottoms);
  return y0 === undefined || y1 === undefined ? undefined : { y0, y1 };
}

/** Bounding box (inclusive) of the pixels of region [x0, x1) × [y0, y1) matching `pred`. */
function bbox(img: Image, region: [number, number, number, number], pred: (p: RGB) => boolean): Box | undefined {
  const [rx0, ry0, rx1, ry1] = region;
  let b: Box | undefined;
  for (let y = ry0; y < ry1; y++) {
    for (let x = rx0; x < rx1; x++) {
      if (!pred(at(img, x, y))) continue;
      if (!b) b = { x0: x, y0: y, x1: x, y1: y, count: 0 };
      b.x0 = Math.min(b.x0, x);
      b.x1 = Math.max(b.x1, x);
      b.y0 = Math.min(b.y0, y);
      b.y1 = Math.max(b.y1, y);
      b.count++;
    }
  }
  return b;
}

/** Bounding box of the run of pixels around (x, y) whose colour stays within `tol` of the pixel at (x, y), scanning the row and the column. */
function solidRect(img: Image, x: number, y: number, tol: number): { left: number; right: number; top: number; bottom: number } {
  const c = at(img, x, y);
  let left = x;
  while (left > 0 && dist(at(img, left - 1, y), c) <= tol) left--;
  let right = x;
  while (right < img.w - 1 && dist(at(img, right + 1, y), c) <= tol) right++;
  let top = y;
  while (top > 0 && dist(at(img, x, top - 1), c) <= tol) top--;
  let bottom = y;
  while (bottom < img.h - 1 && dist(at(img, x, bottom + 1), c) <= tol) bottom++;
  return { left, right, top, bottom };
}

const centre = (a: number, b: number) => (a + b + 1) / 2; // continuous centre of inclusive pixel rows a..b

// ── Fixture plan over a generated capture ────────────────────────────────────

let tmp: string;
let registry: ComponentRegistry;
let project: LoadedProject;
let editorial: LoadedTemplate;
let timeline: Timeline;
let capture: string;
const stills = new Map<string, Image>();
const files = new Map<string, string>();

function planQuote(overrides?: EditOverrides): EditPlan {
  return planEdit({ timeline, template: editorial, project, registry, captureFile: capture, overrides });
}

const segOf = (plan: EditPlan, pred: (s: PlanSegment) => boolean) => plan.segments.find(pred)!;

beforeAll(async () => {
  if (!canRender) return;
  tmp = await mkdtemp(join(tmpdir(), 'retake-look-'));
  registry = await loadComponentRegistry({ root: REPO });
  project = await fixtureProject();
  editorial = await template('editorial');
  timeline = realTimeline('quote');
  capture = join(tmp, 'capture.mp4');
  makeColourCapture(capture, Math.ceil(timeline.capture.duration), 30);
  const plan = planQuote();
  const narrow = planQuote({ components: { layout: { id: 'studio/layout-card', params: { width: 1400 } } } });
  const intro = segOf(plan, (s) => s.kind === 'intro');
  const discover = segOf(plan, (s) => s.id === 'discover');
  const inter = segOf(plan, (s) => s.kind === 'interstitial');
  const outro = segOf(plan, (s) => s.kind === 'outro');
  const mid = discover.from + Math.round(discover.durationInFrames / 2);
  // Three sessions: the main plan, the clip frame again in a fresh browser session (determinism), the narrow card.
  const sessions: Array<[EditPlan, Array<[string, number]>]> = [
    [
      plan,
      [
        ['intro-0.4', intro.from + 12],
        ['intro-1.0', intro.from + 30],
        ['intro-1.3', intro.from + 39],
        ['intro-2.6', intro.from + 78],
        ['intro-2.6-again', intro.from + 78],
        ['clip', mid],
        ['interstitial', inter.from + 45],
        ['outro', outro.from + 84],
      ],
    ],
    [plan, [['clip-again', mid]]],
    [narrow, [['narrow-clip', mid]]],
  ];
  for (const [p, frames] of sessions) {
    const out = await renderStills({ workPolicy: PERSON_POLICY, plan: p, frames: frames.map(([name, frame]) => ({ frame, out: join(tmp, `${name}.png`) })), root: REPO, registry, cacheDir: SHARED_CACHE });
    out.forEach((f, i) => {
      files.set(frames[i][0], f);
      stills.set(frames[i][0], readImage(f));
    });
  }
}, LONG);

afterAll(async () => {
  if (tmp) await rm(tmp, { recursive: true, force: true });
});

const ACCENT = hex('#8a2332');
const INK = hex('#1f1413');
const RING = hex('#544b48');
const accentish = near(ACCENT, 60);
const inky = (p: RGB) => p[0] + p[1] + p[2] < 250;
const light = (p: RGB) => p[0] + p[1] + p[2] > 600;

describe.skipIf(!canRender)('reference look on real renders (quote fixture plan, editorial, 1920×1080)', () => {
  it('intro (2.6 s): logo row ≈ 417, kicker ≈ 529, title cap centre ≈ 612, accent rule 120 × 2 at ≈ 694, all centred', () => {
    const img = stills.get('intro-2.6')!;
    const logo = bbox(img, [700, 360, 1220, 470], accentish)!;
    expect(logo.y1 - logo.y0 + 1).toBeGreaterThanOrEqual(63);
    expect(logo.y1 - logo.y0 + 1).toBeLessThanOrEqual(65);
    expect(Math.abs(centre(logo.y0, logo.y1) - 417)).toBeLessThanOrEqual(3);
    const kicker = bbox(img, [600, 500, 1320, 560], accentish)!;
    const kickerCaps = capBand(img, [600, 500, 1320, 560], accentish)!; // "FOR CAFÉS": the accent is not the cap band
    expect(Math.abs(centre(kickerCaps.y0, kickerCaps.y1) - 528.5)).toBeLessThanOrEqual(3);
    expect(Math.abs(centre(kicker.x0, kicker.x1) - 960)).toBeLessThanOrEqual(4);
    const rule = bbox(img, [600, 650, 1320, 760], near(ACCENT, 20))!;
    expect(rule.y1 - rule.y0 + 1).toBe(2);
    expect(Math.abs(rule.y0 - 694)).toBeLessThanOrEqual(3);
    expect([rule.x0, rule.x1]).toEqual([900, 1019]);
    const title = bbox(img, [200, 560, 1720, 690], inky)!;
    // Cap top ≈ 578 (look.md: cap centre 612 for a 96 px display face; descenders below).
    expect(Math.abs(title.y0 - 578)).toBeLessThanOrEqual(4);
    expect(Math.abs(centre(title.x0, title.x1) - 960)).toBeLessThanOrEqual(4);
  });

  it('intro motion: the logo row first (kicker not yet at 0.4 s), the title still fading in at 1.0 s, the rule drawing from the centre', () => {
    const early = stills.get('intro-0.4')!;
    expect(bbox(early, [700, 360, 1220, 470], accentish)!.count).toBeGreaterThan(2000);
    expect(bbox(early, [600, 500, 1320, 560], accentish)).toBeUndefined();
    expect(bbox(early, [200, 560, 1720, 690], (p) => p[0] + p[1] + p[2] < 600)).toBeUndefined();
    // 1.0 s: kicker in, title half-way (no pixel as dark as the ink yet), rule barely started.
    const one = stills.get('intro-1.0')!;
    expect(bbox(one, [600, 500, 1320, 560], accentish)).toBeDefined();
    expect(bbox(one, [200, 560, 1720, 690], (p) => dist(p, INK) < 40)).toBeUndefined();
    expect(bbox(one, [200, 560, 1720, 690], (p) => p[0] + p[1] + p[2] < 600)).toBeDefined();
    const ruleAt = (img: Image) => bbox(img, [600, 650, 1320, 760], (p) => p[0] - p[1] > 40);
    const r1 = ruleAt(one);
    expect(r1 === undefined || r1.x1 - r1.x0 + 1 < 40).toBe(true);
    // 1.3 s: drawing, symmetric around the centre.
    const r2 = ruleAt(stills.get('intro-1.3')!)!;
    expect(r2.x1 - r2.x0 + 1).toBeGreaterThan(30);
    expect(r2.x1 - r2.x0 + 1).toBeLessThan(120);
    expect(Math.abs(centre(r2.x0, r2.x1) - 960)).toBeLessThanOrEqual(1);
  });

  it('clip: card x 180, y 40, 1560 × 878; caption rule 36 × 2 at (186, 957), kicker at x ≈ 234, line cap top ≈ 981; brand mark right-aligned at y ≈ 985', () => {
    const img = stills.get('clip')!;
    const card = solidRect(img, 960, 480, 24);
    expect(Math.abs(card.left - 180)).toBeLessThanOrEqual(1);
    expect(Math.abs(card.right - 1739)).toBeLessThanOrEqual(1);
    expect(Math.abs(card.top - 40)).toBeLessThanOrEqual(1);
    expect(Math.abs(card.bottom - 917)).toBeLessThanOrEqual(1);
    const rule = bbox(img, [150, 940, 228, 975], near(ACCENT, 20))!;
    expect([rule.x0, rule.x1, rule.y0, rule.y1]).toEqual([186, 221, 957, 958]);
    const kicker = bbox(img, [226, 940, 800, 975], accentish)!;
    expect(Math.abs(kicker.x0 - 234)).toBeLessThanOrEqual(3);
    expect(Math.abs(centre(kicker.y0, kicker.y1) - 958)).toBeLessThanOrEqual(2);
    const line = bbox(img, [150, 970, 1440, 1035], inky)!;
    expect(Math.abs(line.x0 - 186)).toBeLessThanOrEqual(3);
    expect(Math.abs(line.y0 - 981)).toBeLessThanOrEqual(3);
    expect(line.y1).toBeLessThan(1035);
    const mark = bbox(img, [1400, 955, 1760, 1015], accentish)!;
    expect(mark.y1 - mark.y0 + 1).toBeGreaterThanOrEqual(29);
    expect(Math.abs(centre(mark.y0, mark.y1) - 985)).toBeLessThanOrEqual(1.5);
    const word = bbox(img, [mark.x1 + 1, 955, 1760, 1015], inky)!;
    expect(word.x0 - mark.x1 - 1).toBeGreaterThanOrEqual(8);
    expect(word.x0 - mark.x1 - 1).toBeLessThanOrEqual(14);
    expect(word.x1).toBeLessThanOrEqual(1740);
    expect(word.x1).toBeGreaterThanOrEqual(1730);
  });

  it('interstitial (1.5 s): full night card, 100 px clock centred at (960, 480), text cap centre ≈ 612 in the paper colour', () => {
    const img = stills.get('interstitial')!;
    expect(dist(at(img, 100, 100), INK)).toBeLessThanOrEqual(6);
    expect(dist(at(img, 1800, 1000), INK)).toBeLessThanOrEqual(6);
    const ring = bbox(img, [850, 380, 1070, 580], near(RING, 14))!;
    expect(ring.x1 - ring.x0 + 1).toBeGreaterThanOrEqual(99);
    expect(ring.x1 - ring.x0 + 1).toBeLessThanOrEqual(101);
    expect(Math.abs(centre(ring.x0, ring.x1) - 960)).toBeLessThanOrEqual(1);
    expect(Math.abs(centre(ring.y0, ring.y1) - 480)).toBeLessThanOrEqual(1);
    const text = bbox(img, [300, 550, 1620, 720], light)!;
    expect(Math.abs(centre(text.y0, text.y1) - 612)).toBeLessThanOrEqual(4);
    expect(Math.abs(centre(text.x0, text.x1) - 960)).toBeLessThanOrEqual(4);
    // The hour hand is accent, the minute hand and hub paper-coloured, inside the ring.
    expect(bbox(img, [912, 432, 1008, 528], near(ACCENT, 70))).toBeDefined();
    expect(bbox(img, [912, 432, 1008, 528], light)).toBeDefined();
  });

  it('outro (2.8 s): logo 150 px at y ≈ 333–483, rule at ≈ 647, tagline ≈ 690, url ≈ 737, centred', () => {
    const img = stills.get('outro')!;
    const logo = bbox(img, [700, 280, 1220, 520], accentish)!;
    expect(logo.y1 - logo.y0 + 1).toBeGreaterThanOrEqual(149);
    expect(logo.y1 - logo.y0 + 1).toBeLessThanOrEqual(151);
    expect(Math.abs(logo.y0 - 333)).toBeLessThanOrEqual(3);
    expect(Math.abs(centre(logo.x0, logo.x1) - 960)).toBeLessThanOrEqual(1);
    const rule = bbox(img, [600, 625, 1320, 665], near(ACCENT, 20))!;
    expect(Math.abs(rule.y0 - 646)).toBeLessThanOrEqual(3);
    expect([rule.x0, rule.x1]).toEqual([900, 1019]);
    const tagline = bbox(img, [300, 668, 1620, 718], (p) => p[0] + p[1] + p[2] < 520)!;
    expect(Math.abs(centre(tagline.y0, tagline.y1) - 692)).toBeLessThanOrEqual(5);
    expect(Math.abs(centre(tagline.x0, tagline.x1) - 960)).toBeLessThanOrEqual(4);
    const url = bbox(img, [300, 722, 1620, 760], (p) => p[0] + p[1] + p[2] < 600)!;
    expect(Math.abs(centre(url.y0, url.y1) - 737)).toBeLessThanOrEqual(4);
    expect(Math.abs(centre(url.x0, url.x1) - 960)).toBeLessThanOrEqual(4);
  });

  it('layout-card width 1400 on screen: the card, the caption and the brand mark move together', () => {
    const img = stills.get('narrow-clip')!;
    const card = solidRect(img, 960, 480, 24);
    expect([card.left, card.right]).toEqual([260, 1659]);
    expect(Math.abs(card.top - 85)).toBeLessThanOrEqual(1);
    expect(Math.abs(card.bottom - 872)).toBeLessThanOrEqual(1);
    const rule = bbox(img, [230, 890, 310, 925], near(ACCENT, 20))!;
    expect([rule.x0, rule.x1, rule.y0, rule.y1]).toEqual([266, 301, 912, 913]);
    const mark = bbox(img, [1300, 910, 1700, 970], accentish)!;
    expect(Math.abs(centre(mark.y0, mark.y1) - 940)).toBeLessThanOrEqual(1.5);
    const word = bbox(img, [mark.x1 + 1, 910, 1700, 970], inky)!;
    expect(word.x1).toBeLessThanOrEqual(1660);
    expect(word.x1).toBeGreaterThanOrEqual(1650);
  });

  it('deterministic: the same frame rendered twice (same session, and a fresh browser session) is the same image', () => {
    expect(stills.get('intro-2.6-again')!.px.equals(stills.get('intro-2.6')!.px)).toBe(true);
    expect(stills.get('clip-again')!.px.equals(stills.get('clip')!.px)).toBe(true);
  });
});

// ── Tiny synthetic plan, half size ────────────────────────────────────────────

let ws: RenderWorkspace;

describe.skipIf(!canRender)('reference look scales with unit (synthetic plan, 960×540)', () => {
  beforeAll(async () => {
    ws = await renderWorkspace();
  }, LONG);
  afterAll(async () => {
    await ws?.cleanup();
  });

  it('card, caption rule and brand mark at half the 1920×1080 positions', async () => {
    const timeline = await readJson<Timeline>(join(ws.runDir, 'timeline.json'));
    const reg = await loadComponentRegistry({ root: ws.root });
    const plan = planEdit({
      timeline,
      template: await loadProjectTemplate(ws.project, 'editorial', { files: fileFacts(PERSON_POLICY) }),
      project: ws.project,
      registry: reg,
      captureFile: join(ws.runDir, 'capture.mp4'),
      overrides: { scale: 0.5 },
    });
    expect([plan.width, plan.height, plan.unit]).toEqual([960, 540, 0.5]);
    const [file] = await renderStills({ workPolicy: PERSON_POLICY, plan, frames: [{ frame: 20, out: join(ws.root, 'half.png') }], root: ws.root, registry: reg, cacheDir: SHARED_CACHE });
    const img = readImage(file);
    const card = solidRect(img, 480, 240, 24);
    expect([card.left, card.right]).toEqual([90, 869]);
    // Top / bottom: the 16:9 capture is 438.75 px tall in the 439 px card, so the edge rows are mixed (±1).
    expect(Math.abs(card.top - 20)).toBeLessThanOrEqual(1);
    expect(Math.abs(card.bottom - 458)).toBeLessThanOrEqual(1);
    const rule = bbox(img, [70, 465, 115, 490], (p) => p[0] - p[1] > 40)!;
    expect([rule.x0, rule.x1]).toEqual([93, 110]);
    expect(rule.y0).toBeGreaterThanOrEqual(477);
    expect(rule.y1).toBeLessThanOrEqual(480);
    const mark = bbox(img, [700, 475, 880, 510], accentish)!;
    expect(Math.abs(centre(mark.y0, mark.y1) - 492.5)).toBeLessThanOrEqual(1.5);
    expect(mark.y1 - mark.y0 + 1).toBeGreaterThanOrEqual(14);
  }, LONG);
});
