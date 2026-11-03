/**
 * L4.5 part D: the timeline inspector end to end in headless Chromium, against a real Studio server, its player origin
 * and the real preview bundle, on the self-numbering VP9 take of part C (timeline-take.ts):
 * - a segment selected by a click and by ] (the inspector shows its switches); the radios sit in `role="radiogroup"`:
 *   arrows move the focus only — no seek, no write;
 * - one click switches scene a's layout to Laptop: the file gains exactly one line, the preview changes (the capture's
 *   numbered blocks no longer fill the frame: a bezel and the theme's background around it) in the same frame, the time
 *   from the click to the preview settled measured; ⌘Z restores the original bytes (compared byte for byte) and the
 *   preview shows exactly the plan's source frame again; Shift+⌘Z redoes; the buttons undo too;
 * - the caption component (the video's switch): the caption's pixels change, the capture's frame stays exact; undone;
 * - a speed chip, a transition and the default speed (`value: null`: no `to`, the line removed) on scene b, undone;
 * - critique B7: a card component the card cannot take is shown disabled with the engine's reason and writes nothing;
 * - another writer changes the file while the screen shows the old version: the switch is a 409 — "Your switch … was
 *   not applied" — the file keeps the other writer's bytes; Apply it to the new version writes it on them; a value the
 *   other writer changed is refused as stale (never overwritten).
 * - L5.12a (BL-122): ⌘Z pressed while a switch is still being written is queued and said, then undoes it once its view
 *   landed — never dropped; the selected segment is said in the inspector's own polite region. L5.12a fixes (review
 *   A-M2): behind a switch that fails, the queued ⌘Z is dropped and said — the switch before it stays.
 * `RETAKE_UI_SHOTS=<folder>` saves screenshots there.
 */
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import type { Browser, Page, Route } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TimelineViewResult } from '@retake/engine';
import { startStudioServer } from '../src/index.js';
import type { StudioServer } from '../src/index.js';
import { hasTool } from '../../editor/test/render-helpers.js';
import { BITS_TEXT, bitsTimeline, readBits, takeWorkspace, writeTake } from './timeline-take.js';

const canRun = hasTool('ffmpeg') && hasTool('ffprobe');
const SHOTS = process.env.RETAKE_UI_SHOTS;
const POLL = { timeout: 30_000 };
const RUN = '20260101-120000-bits';
let ws: string;
let dir: string;
let studio: StudioServer;
let browser: Browser;
let page: Page;
let plan: Extract<TimelineViewResult, { view: unknown }>;
const savedHome = process.env.RETAKE_HOME;
const consoleErrors: string[] = [];
const switchMs: Array<[string, number]> = [];
const file = () => join(dir, 'scenarios', 'bits.yaml');

async function shot(name: string): Promise<void> {
  if (!SHOTS) return;
  await mkdir(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

function srcAt(frame: number): number | undefined {
  for (const s of plan.plan.segments) if (s.kind === 'clip' && s.from <= frame && frame < s.from + s.durationInFrames) return s.srcFrames[frame - s.from];
  return undefined;
}

const shown = async () => Number(await page.getByTestId('preview').getAttribute('data-frame'));
/** The live region's words, without the file's warning count L4.3 adds ("1 warning in the file."). */
const live = async () => (await page.getByTestId('switch-live').innerText()).replace(/ \d+ warnings? in the file\.$/, '');
const hashShown = () => page.getByTestId('timeline').getAttribute('data-hash');
const sha = (s: string) => execFileSync('shasum', ['-a', '256'], { input: s }).toString().slice(0, 64);
const option = (key: string, value: string) => page.locator(`[data-testid="switch"][data-key="${key}"] [data-testid="switch-option"][data-value="${value}"]`);
const checked = (key: string) => page.locator(`[data-testid="switch"][data-key="${key}"] [role="radio"][aria-checked="true"]`).getAttribute('data-value');
const blur = () => page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
/** timeline_view reads the page sent and not yet answered (a held one counts until it is let go). */
let viewsInFlight = 0;
/** Until every read sent before the hold is answered (L5.12a fixes: a read in flight while the test writes the file would show that write). */
const readsSettled = (held: Route[]) => expect.poll(() => viewsInFlight - held.length, POLL).toBe(0);

/** The preview settled at the frame shown: its picture (PNG) and the source frame it reads. */
async function settled(): Promise<{ frame: number; png: Buffer; src: number }> {
  await expect.poll(async () => page.getByTestId('preview').getAttribute('data-loading'), POLL).toBe('no');
  const png = await page.getByTestId('preview-frame').screenshot();
  return { frame: await shown(), png, src: readBits(png) };
}

/** Raw RGB of a PNG (ffmpeg), with its size. */
function rgbOf(png: Buffer): { w: number; h: number; rgb: Buffer } {
  const [w, h] = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', '-i', 'pipe:0'], { input: png }).toString().trim().split(',').map(Number);
  return { w, h, rgb: execFileSync('ffmpeg', ['-v', 'error', '-i', 'pipe:0', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { input: png, maxBuffer: 64 * 1024 * 1024 }) };
}

/** Mean absolute difference (0–255) of two same-size pictures over a band of rows (fractions of the height). */
function diff(a: Buffer, b: Buffer, y0 = 0, y1 = 1): number {
  const A = rgbOf(a);
  const B = rgbOf(b);
  expect([A.w, A.h]).toEqual([B.w, B.h]);
  let sum = 0;
  let n = 0;
  for (let y = Math.floor(A.h * y0); y < Math.floor(A.h * y1); y++) for (let i = y * A.w * 3; i < (y + 1) * A.w * 3; i++) {
    sum += Math.abs(A.rgb[i] - B.rgb[i]);
    n++;
  }
  return sum / n;
}

/** The mean colour of a small square at (fx, fy) of a picture. */
function colourAt(png: Buffer, fx: number, fy: number): [number, number, number] {
  const { w, h, rgb } = rgbOf(png);
  const c = [0, 0, 0];
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
    const i = ((Math.floor(h * fy) + dy) * w + Math.floor(w * fx) + dx) * 3;
    for (let k = 0; k < 3; k++) c[k] += rgb[i + k] / 25;
  }
  return c.map(Math.round) as [number, number, number];
}

/**
 * Click an option and measure, in the page, the time until the preview is settled on the new version (the view's
 * hash changed, the frame asked settled): what the person waits after a switch.
 */
async function clickAndSettle(what: string, key: string, value: string): Promise<number> {
  const before = await hashShown();
  await option(key, value).scrollIntoViewIfNeeded();
  const ms = await page.evaluate(
    ([k, val, h]) =>
      new Promise<number>((resolve, reject) => {
        const el = document.querySelector<HTMLButtonElement>(`[data-testid="switch"][data-key="${k}"] [data-testid="switch-option"][data-value="${val}"]`);
        if (!el) return reject(new Error(`no option ${k} = ${val}`));
        const t0 = performance.now();
        el.click();
        const tick = () => {
          const root = document.querySelector<HTMLElement>('[data-testid="timeline"]');
          const pv = document.querySelector<HTMLElement>('[data-testid="preview"]');
          if (root?.dataset.hash && root.dataset.hash !== h && pv?.dataset.loading === 'no') return resolve(performance.now() - t0);
          if (performance.now() - t0 > 30_000) return reject(new Error('the preview did not settle within 30 s'));
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
    [key, value, before] as const,
  );
  switchMs.push([what, Math.round(ms)]);
  return ms;
}

/** The lines added to and removed from the original text. */
function lineDiff(a: string, b: string): { added: string[]; removed: string[] } {
  const A = a.split('\n');
  const B = b.split('\n');
  return { added: B.filter((l) => !A.includes(l)), removed: A.filter((l) => !B.includes(l)) };
}

/** ⌘Z (Ctrl+Z off a Mac) with the focus on no field; then the original bytes are back. */
async function undoKey(label: string): Promise<void> {
  await blur();
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => live(), POLL).toBe(`Undone: ${label}.`);
}

beforeAll(async () => {
  if (!canRun) return;
  ws = await mkdtemp(join(tmpdir(), 'ds-e2e-switch-'));
  process.env.RETAKE_HOME = join(ws, '.home');
  dir = await takeWorkspace(ws);
  await writeTake(dir, 'bits', { run: RUN, text: BITS_TEXT, timeline: bitsTimeline(), codec: 'vp9', seconds: 8 });
  studio = await startStudioServer({ root: ws, startWorker: false, pollMs: 100 });
  const v = await studio.engine.timeline.view({ project: 'demo', scenario: 'bits' });
  if (!('view' in v)) throw new Error(`blocked: ${JSON.stringify(v.blocked)}`);
  plan = v;
  const executablePath = process.env.RETAKE_CHROMIUM;
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : { channel: 'chromium' }) });
  const context = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  await context.addInitScript(() => {
    (window as unknown as { __csp: number }).__csp = 0;
    document.addEventListener('securitypolicyviolation', () => (window as unknown as { __csp: number }).__csp++);
  });
  page = await context.newPage();
  const isView = (r: { url(): string }) => r.url().includes('/v1/call/timeline_view');
  page.on('request', (r) => void (isView(r) && viewsInFlight++));
  page.on('requestfinished', (r) => void (isView(r) && viewsInFlight--));
  page.on('requestfailed', (r) => void (isView(r) && viewsInFlight--));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) consoleErrors.push(m.text());
  });
  await page.goto(studio.launchUrl());
  await page.getByRole('heading', { level: 2, name: 'Projects' }).waitFor();
  await page.goto(`${studio.url}#/p/demo/s/bits/timeline`);
  await page.getByTestId('tracks').waitFor();
}, 180_000);

afterAll(async () => {
  if (switchMs.length) console.log(`timeline switch → preview settled (ms): ${switchMs.map(([w, ms]) => `${w} ${ms}`).join(', ')}`);
  await browser?.close();
  await studio?.close();
  if (savedHome === undefined) delete process.env.RETAKE_HOME;
  else process.env.RETAKE_HOME = savedHome;
  if (ws) await rm(ws, { recursive: true, force: true });
});

describe.skipIf(!canRun)('the timeline inspector in Chromium', () => {
  it('select a segment; Laptop in one click: one line, the preview changes; ⌘Z gives the exact bytes back and the exact frame; redo', async () => {
    expect(await page.getByTestId('inspector-hint').innerText()).toContain('Select a segment on the timeline');
    // A click on scene a's segment selects it (and seeks to its first frame); a step into it shows the capture.
    await page.locator('[data-testid="tl-segment"][data-id="a"]').click();
    expect(await page.locator('[data-testid="tl-segment"][data-id="a"]').getAttribute('aria-pressed')).toBe('true');
    expect(await page.locator('#tl-insp-seg').innerText()).toBe('scene a');
    expect(await page.getByTestId('inspector-draws').innerText()).toBe('Drawn by layout-raw');
    const a0 = plan.view.model.steps.find((s) => s.key === 'a.0')!.from + 6;
    for (let f = await shown(); f < a0; f++) await page.keyboard.press('ArrowRight');
    const before = await settled();
    expect(before.src).toBe(srcAt(before.frame));
    // The video's frame is `raw`: scene a's default says so; Full screen is not checked (scene a writes no frame).
    expect(await checked('scene:a:frame')).toBe('');
    expect(await option('scene:a:frame', '').innerText()).toBe('As the video (Full screen)');
    // The radios are a radio group: arrows move the focus only — no seek, nothing written.
    await option('scene:a:frame', '').focus();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    expect(await page.evaluate(() => document.activeElement?.getAttribute('data-value'))).toBe('browser');
    await shot('switch-1-selected');
    await page.keyboard.press(' ');
    expect(await shown()).toBe(before.frame);
    await page.keyboard.press('ArrowLeft');
    expect(await page.evaluate(() => document.activeElement?.getAttribute('data-value'))).toBe('card');

    // Space on Browser wrote it (Space / Enter pick): undo it first, so Laptop is the next switch.
    await expect.poll(() => checked('scene:a:frame'), POLL).toBe('browser');
    await expect.poll(() => page.getByTestId('preview').getAttribute('data-loading'), POLL).toBe('no');
    await undoKey('Set the layout of scene a to browser');
    await expect.poll(async () => Buffer.compare(await readFile(file()), Buffer.from(BITS_TEXT)), POLL).toBe(0);
    await expect.poll(() => checked('scene:a:frame'), POLL).toBe('');

    // One click: Laptop.
    const ms = await clickAndSettle('layout → laptop', 'scene:a:frame', 'laptop');
    const t1 = await readFile(file(), 'utf8');
    expect(lineDiff(BITS_TEXT, t1)).toEqual({ added: ['    frame: laptop'], removed: [] });
    expect(t1.split('\n').length).toBe(BITS_TEXT.split('\n').length + 1);
    expect(await checked('scene:a:frame')).toBe('laptop');
    expect(await live()).toBe('Set the layout of scene a to Laptop. Saved: ⌘Z undoes. Only the edit changed: a render of this take shows it, no new capture.');
    expect(await page.getByTestId('inspector-draws').innerText()).toBe('Drawn by layout-laptop');
    const laptop = await settled();
    expect(laptop.frame).toBe(before.frame);
    // The preview changed: the capture no longer fills the frame (its corner is the theme's, not the capture's grey).
    expect(laptop.src).not.toBe(before.src);
    expect(diff(before.png, laptop.png)).toBeGreaterThan(12);
    const cornerRaw = colourAt(before.png, 0.02, 0.03);
    const cornerLaptop = colourAt(laptop.png, 0.02, 0.03);
    expect(cornerRaw.every((c) => Math.abs(c - 0x20) < 12), `raw corner ${cornerRaw}`).toBe(true);
    expect(cornerLaptop.some((c, k) => Math.abs(c - cornerRaw[k]) > 40), `laptop corner ${cornerLaptop}`).toBe(true);
    expect(await page.locator('iframe').count()).toBe(1);
    console.log(`switch: layout → laptop settled in ${Math.round(ms)} ms; corner ${cornerRaw} → ${cornerLaptop}`);
    await shot('switch-2-laptop');

    // ⌘Z: the original bytes, the exact frame again.
    await undoKey('Set the layout of scene a to laptop');
    await expect.poll(async () => Buffer.compare(await readFile(file()), Buffer.from(BITS_TEXT)), POLL).toBe(0);
    await expect.poll(() => hashShown(), POLL).toBe(sha(BITS_TEXT));
    const back = await settled();
    expect(back.src).toBe(srcAt(back.frame));
    expect(back.frame).toBe(before.frame);
    // Shift+⌘Z redoes (the bytes of the switch), the Undo button undoes again.
    await blur();
    await page.keyboard.press('ControlOrMeta+Shift+z');
    await expect.poll(() => live(), POLL).toBe('Redone: Set the layout of scene a to laptop.');
    await expect.poll(() => readFile(file(), 'utf8'), POLL).toBe(t1);
    await expect.poll(() => checked('scene:a:frame'), POLL).toBe('laptop');
    await page.getByTestId('tl-undo').click();
    await expect.poll(() => live(), POLL).toBe('Undone: Set the layout of scene a to laptop.');
    await expect.poll(async () => Buffer.compare(await readFile(file()), Buffer.from(BITS_TEXT)), POLL).toBe(0);
    await expect.poll(() => checked('scene:a:frame'), POLL).toBe('');
    expect((await settled()).src).toBe(srcAt(before.frame));
  }, 180_000);

  it('the caption component: the caption changes in the preview, the capture stays exact; undone to the exact bytes', async () => {
    const cap = plan.view.model.captions[0];
    const drawn = plan.view.model.segments.find((s) => s.id === 'a')!.caption?.id;
    const choice = plan.view.choices.video.find((c) => c.field === 'caption_component')!;
    const other = choice.options.find((o) => o.value !== null && o.usable === true && o.value !== drawn);
    expect(other, JSON.stringify(choice.options)).toBeDefined();
    // A frame of scene a with its caption on screen.
    const at = Math.min(cap.to - 1, cap.from + 30);
    const from = await shown();
    for (let f = from; f < at; f++) await page.keyboard.press('ArrowRight');
    for (let f = from; f > at; f--) await page.keyboard.press('ArrowLeft');
    const before = await settled();
    expect(before.frame).toBe(at);
    await clickAndSettle('caption component', 'top:caption_component', String(other!.value));
    const t1 = await readFile(file(), 'utf8');
    expect(lineDiff(BITS_TEXT, t1)).toEqual({ added: [`caption_component: ${other!.value}`], removed: [] });
    const after = await settled();
    expect(after.frame).toBe(at);
    // The capture's numbered blocks still read exactly; the caption's band of the picture changed.
    expect(after.src).toBe(srcAt(at));
    const band = Math.max(diff(before.png, after.png, 0.6, 1), diff(before.png, after.png, 0, 0.3));
    expect(band, 'the caption band changed').toBeGreaterThan(1.5);
    console.log(`switch: caption ${drawn} → ${other!.value}: band difference ${band.toFixed(1)}`);
    await shot('switch-3-caption');
    await undoKey(`Set the caption component to ${other!.value}`);
    await expect.poll(async () => Buffer.compare(await readFile(file()), Buffer.from(BITS_TEXT)), POLL).toBe(0);
  }, 120_000);

  it('] selects scene b; a speed chip, a transition and the default speed are one line each; undone', async () => {
    await blur();
    await page.keyboard.press('Home');
    await page.keyboard.press(']');
    await page.keyboard.press(']');
    expect(await page.locator('[data-testid="tl-segment"][data-id="b"]').getAttribute('aria-pressed')).toBe('true');
    expect(await page.locator('#tl-insp-seg').innerText()).toBe('scene b');
    expect(await checked('scene:b:speed')).toBe('2');
    await clickAndSettle('speed → 1.5×', 'scene:b:speed', '1.5');
    expect(lineDiff(BITS_TEXT, await readFile(file(), 'utf8'))).toEqual({ added: ['    speed: 1.5'], removed: ['    speed: 2'] });
    await clickAndSettle('transition → fade-black', 'scene:b:transition', 'fade-black');
    expect(lineDiff(BITS_TEXT, await readFile(file(), 'utf8'))).toEqual({ added: ['    speed: 1.5', '    transition: fade-black'], removed: ['    speed: 2'] });
    await shot('switch-4-speed-transition');
    // The default (`value: null`): set_field without `to` — the key removed.
    await clickAndSettle('speed → default', 'scene:b:speed', '');
    expect(lineDiff(BITS_TEXT, await readFile(file(), 'utf8'))).toEqual({ added: ['    transition: fade-black'], removed: ['    speed: 2'] });
    expect(await checked('scene:b:speed')).toBe('');
    await undoKey("Reset the speed of scene b to the theme's default");
    await undoKey('Set the transition of scene b to fade-black');
    await undoKey('Set the speed of scene b to 1.5');
    await expect.poll(async () => Buffer.compare(await readFile(file()), Buffer.from(BITS_TEXT)), POLL).toBe(0);
  }, 120_000);

  it('critique B7: a card component the card cannot take is disabled with the reason, and writes nothing', async () => {
    await page.locator('[data-testid="tl-segment"][data-id="c1"]').click();
    expect(await page.locator('#tl-insp-seg').innerText()).toBe('card c1');
    const key = 'card:c1:card.component';
    const off = page.locator(`[data-testid="switch"][data-key="${key}"] [data-testid="switch-option"][aria-disabled="true"]`);
    expect(await off.count()).toBeGreaterThan(0);
    const choice = plan.view.choices.segments.c1.find((c) => c.field === 'card.component')!;
    const unusable = choice.options.filter((o) => o.usable !== true);
    expect(await off.count()).toBe(unusable.length);
    const first = unusable[0];
    const why = (first.usable as { why: string }).why;
    const el = option(key, String(first.value));
    expect(await el.getAttribute('aria-disabled')).toBe('true');
    expect(await el.getByTestId('switch-why').innerText()).toBe(` — ${why}`);
    console.log(`disabled: ${first.value}: ${why}`);
    const calls: string[] = [];
    page.on('request', (r) => r.url().includes('/v1/call/scenario_edit') && calls.push(r.url()));
    await el.click({ force: true });
    await new Promise((r) => setTimeout(r, 400));
    expect(calls).toEqual([]);
    expect(Buffer.compare(await readFile(file()), Buffer.from(BITS_TEXT))).toBe(0);
    await el.scrollIntoViewIfNeeded();
    await shot('switch-5-disabled');
  }, 60_000);

  it('⚑ L5.12a (BL-122): ⌘Z while a switch is in flight is queued and said, then undoes it; the selected segment is said', async () => {
    await page.locator('[data-testid="tl-segment"][data-id="a"]').click();
    await expect.poll(() => page.getByTestId('inspector-selected').innerText(), POLL).toMatch(/^Selected scene a: \d+:\d\d\.\d\d – \d+:\d\d\.\d\d · \d+ steps?\.$/);
    await expect.poll(() => hashShown(), POLL).toBe(sha(BITS_TEXT));
    // Hold the write: the switch is in flight while ⌘Z is pressed.
    const held: Route[] = [];
    await page.route('**/v1/call/scenario_edit', (r) => void held.push(r));
    await option('scene:a:frame', 'laptop').click();
    await expect.poll(() => held.length, POLL).toBe(1);
    await blur();
    await page.keyboard.press('ControlOrMeta+z');
    await expect.poll(async () => (await live()).replace(/\s+/g, ' '), POLL).toBe('Saving… Undo in a moment: the switch is still saving.');
    await page.unroute('**/v1/call/scenario_edit');
    await held[0].continue().catch(() => undefined);
    // The switch lands, then the queued undo runs: the original bytes again.
    await expect.poll(() => live(), POLL).toBe('Undone: Set the layout of scene a to laptop.');
    await expect.poll(async () => Buffer.compare(await readFile(file()), Buffer.from(BITS_TEXT)), POLL).toBe(0);
    await expect.poll(() => checked('scene:a:frame'), POLL).toBe('');
  }, 60_000);

  it('⚑ L5.12a fixes (review A-M2 / B-M2): a ⌘Z queued behind a switch that fails is dropped and said once — the switch before it stays', async () => {
    await page.locator('[data-testid="tl-segment"][data-id="a"]').click();
    await expect.poll(() => hashShown(), POLL).toBe(sha(BITS_TEXT));
    // Switch A lands: Laptop.
    await option('scene:a:frame', 'laptop').click();
    await expect.poll(() => checked('scene:a:frame'), POLL).toBe('laptop');
    await expect.poll(async () => (await hashShown()) !== sha(BITS_TEXT), POLL).toBe(true);
    const a = await readFile(file(), 'utf8');
    expect(a).not.toBe(BITS_TEXT);
    // Switch B (back to the video's) is held, ⌘Z is queued behind it ("undo B"), then B is refused.
    const held: Route[] = [];
    await page.route('**/v1/call/scenario_edit', (r) => void held.push(r));
    await option('scene:a:frame', '').click();
    await expect.poll(() => held.length, POLL).toBe(1);
    await blur();
    await page.keyboard.press('ControlOrMeta+z');
    await expect.poll(async () => (await live()).replace(/\s+/g, ' '), POLL).toBe('Saving… Undo in a moment: the switch is still saving.');
    await held[0].fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ ok: false, error: { code: 'invalid', message: 'not saved: the scenario was refused' } }) });
    await page.getByTestId('switch-error').waitFor(POLL);
    await expect.poll(() => live(), POLL).toBe('Undo cancelled: the switch was not saved, so there is nothing to undo.');
    // Nothing undone: A's bytes stay (no restore was sent), and it is said once.
    await page.waitForTimeout(600);
    expect(held).toHaveLength(1);
    expect(await readFile(file(), 'utf8')).toBe(a);
    expect(await checked('scene:a:frame')).toBe('laptop');
    await page.unroute('**/v1/call/scenario_edit');
    // A itself still undoes: the original bytes again.
    await page.getByRole('complementary', { name: 'Inspector' }).getByRole('button', { name: 'Dismiss' }).click();
    await undoKey('Set the layout of scene a to laptop');
    await expect.poll(async () => Buffer.compare(await readFile(file()), Buffer.from(BITS_TEXT)), POLL).toBe(0);
  }, 60_000);

  it('another writer changed the file: a 409, "Apply it to the new version" writes on their bytes; a value they changed is stale', async () => {
    await page.locator('[data-testid="tl-segment"][data-id="a"]').click();
    await expect.poll(() => hashShown(), POLL).toBe(sha(BITS_TEXT));
    // Hold the screen's reads so it keeps showing the version before the outside write.
    const held: Route[] = [];
    await page.route('**/v1/call/timeline_view', (r) => void held.push(r));
    await readsSettled(held);
    const outside = BITS_TEXT.replace('caption: Every frame carries its number.', 'caption: Every frame, numbered.');
    await writeFile(file(), outside);
    await option('scene:a:frame', 'laptop').click();
    await page.getByTestId('switch-conflict').waitFor(POLL);
    expect(await page.getByTestId('switch-conflict').innerText()).toBe('Your switch (Set the layout of scene a to Laptop) was not applied. The timeline now shows the new version.');
    expect(await readFile(file(), 'utf8')).toBe(outside);
    // The offer is in sight, though the switches scrolled (the inspector's top stays). L5.12a: the inspector is the
    // shell's pane (the scroller), taller than the old card — scrolled to its end here, the offer still in sight.
    const pane = page.getByRole('complementary', { name: 'Inspector' });
    await pane.evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
    expect(await pane.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
    const box = (await pane.boundingBox())!;
    const offer = (await page.getByTestId('switch-conflict').boundingBox())!;
    expect(offer.y >= box.y && offer.y + offer.height <= box.y + box.height, JSON.stringify({ box, offer })).toBe(true);
    await shot('switch-6-conflict');
    await page.unroute('**/v1/call/timeline_view');
    for (const r of held) await r.continue().catch(() => undefined);
    await expect.poll(() => hashShown(), POLL).toBe(sha(outside));
    await page.getByRole('button', { name: 'Apply it to the new version' }).click();
    await expect.poll(() => live(), POLL).toMatch(/^Set the layout of scene a to (Laptop|laptop)\. Saved/);
    await expect.poll(() => readFile(file(), 'utf8'), POLL).toBe(outside.replace('    caption: Every frame, numbered.\n', '    caption: Every frame, numbered.\n    frame: laptop\n'));
    await expect.poll(() => checked('scene:a:frame'), POLL).toBe('laptop');

    // Stale: held reads again; outside, scene a's layout becomes phone; Browser → 409 → Apply → refused, nothing written.
    held.length = 0;
    await page.route('**/v1/call/timeline_view', (r) => void held.push(r));
    await readsSettled(held);
    const t2 = await readFile(file(), 'utf8');
    const outside2 = t2.replace('    frame: laptop\n', '    frame: phone\n');
    await writeFile(file(), outside2);
    await option('scene:a:frame', 'browser').click();
    await page.getByTestId('switch-conflict').waitFor(POLL);
    await page.unroute('**/v1/call/timeline_view');
    for (const r of held) await r.continue().catch(() => undefined);
    await expect.poll(() => hashShown(), POLL).toBe(sha(outside2));
    await page.getByRole('button', { name: 'Apply it to the new version' }).click();
    await expect.poll(() => page.getByTestId('switch-error').innerText(), POLL).toMatch(/^the layout of scene a changed meanwhile/);
    console.log(`stale: ${await page.getByTestId('switch-error').innerText()}`);
    expect(await readFile(file(), 'utf8')).toBe(outside2);
    expect(await checked('scene:a:frame')).toBe('phone');
    await shot('switch-7-stale');
    await writeFile(file(), BITS_TEXT);
    expect(consoleErrors).toEqual([]);
    expect(await page.evaluate(() => (window as unknown as { __csp: number }).__csp)).toBe(0);
  }, 120_000);
});
