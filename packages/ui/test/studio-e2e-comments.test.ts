/**
 * L4.6 part D1 (T14a): the Comments screen end to end in headless Chromium against a real Studio server, on the bits
 * take (timeline-take.ts: every frame shows its own index in white blocks) and two renders of it whose videos do the
 * same — a landscape render of the version the timeline shows (its plan and theme files: its frame f is the preview's
 * frame f) encoded as a real render is (libx264 with B-frames, an AAC track), and a vertical one:
 * - the scenario screen's "Comments (N open)" tab; the timeline's Comment (and key C) lands on the Comments screen at the
 *   playhead's frame of that render: the frame the viewer shows (read from its pixels) is that frame, and so are the
 *   thread's frame and its still (viewer = still = thread);
 * - the viewer: one render_frame request in flight at a time, one random session id per tab;
 * - a region dragged on the frame → the four % fields follow; the chips read before posting are the anchor stored;
 * - ⚑ Post writes the channel `studio` under the Studio's name (the page names no author: a page-chosen author is a
 *   400 and nothing is written); ⚑ the comment's injected markup is shown literally (no element made);
 * - reply, an MCP reply with a proposal arriving by event (its summary in the thread, its state in the list), a 409 on
 *   resolve read again and said (nothing re-sent), resolve, the Open / Resolved filters and the counts, reopen;
 * - a timeline pin's tooltip opens its thread;
 * - ⚑ a drag on the vertical render: the fields are the drag's shares of the frame (the image's own box), and a drag
 *   past the frame's edge is clamped inside it (x + w = 100 %).
 * L4.6 part D2 (T14b), on the same thread: Claude's newer proposal (an MCP reply) —
 * - ⚑ its diff is the server's rows drawn code-safe and literally: a trailing space is a visible `·`, an added line of
 *   markup and right-to-left text is text (no element made), ⚑ drawn in byte order and marked "right-to-left text"
 *   (review A L6); ⚑ every row on the page, Apply after the whole diff, no inner scroll (review A M1); ⚑ the frame
 *   ≥ 300 px wide at 1280 and 1440 with the proposal open (review B M1); the older proposal reads superseded;
 * - ⚑ the buttons come from the server's offer only (an offer changed in transit changes the buttons, its `why` said);
 *   ⚑ a page-sent proposal is a 400, nothing written;
 * - Apply writes exactly the proposed bytes, ⚑ its problems and warnings said (review B M2); Undo apply restores the
 *   file byte for byte (state "Applied, then undone", offered again);
 * - Preview change: the timeline's banner (⚑ no Apply there: review A M1), the caption track shows the proposed text,
 *   Render off, the file untouched; Back to the comment opens the thread scrolled to its proposal, whose Apply and
 *   re-render writes the file, queues the render of the thread's take on it (the worker run in this process renders
 *   and reviews it), the thread follows it, "Resolve with v3" resolves with that render; the Resolved filter; Reopen
 *   (the applied proposal offers nothing, said why).
 * No CSP violation, no console error. `DEMO_STUDIO_UI_SHOTS=<folder>` saves screenshots there.
 */
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import type { Browser, Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CommentThread } from '@demo-studio/core';
import { createEngine, planRenderRequest, runWorker } from '@demo-studio/engine';
import type { Engine } from '@demo-studio/engine';
import type { EditPlan, RenderRecord } from '@demo-studio/editor';
import { startStudioServer } from '../src/index.js';
import type { StudioServer } from '../src/index.js';
import { hasTool, linkSharedCache } from '../../editor/test/render-helpers.js';
import { BITS_TEXT, bitsTimeline, bitsVideo, readBits, takeWorkspace, writeTake } from './timeline-take.js';
import { parseTimecode, timeExample } from '../src/app/comment-words.js';

const canRun = hasTool('ffmpeg') && hasTool('ffprobe');
const SHOTS = process.env.DEMO_STUDIO_UI_SHOTS;
const POLL = { timeout: 30_000 };
const RUN = '20260101-120000-bits';
const AUTHOR = 'Studio Person';
const INJECTED = '<img src=x onerror=alert(1)> The zoom starts too early';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
let ws: string;
let dir: string;
let studio: StudioServer;
let mcp: Engine;
let browser: Browser;
let page: Page;
let land: RenderRecord;
let vert: RenderRecord;
const saved = { home: process.env.DEMO_STUDIO_HOME, author: process.env.DEMO_STUDIO_AUTHOR };
const consoleErrors: string[] = [];
/** render_frame requests: their session ids and how many were in flight at once (at most). */
const frames = { sessions: new Set<string>(), inFlight: 0, maxInFlight: 0, count: 0 };

async function shot(name: string): Promise<void> {
  if (!SHOTS) return;
  await mkdir(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `comments-${name}.png`), fullPage: true });
}

/** The render's video: the bits take as a real render is encoded (B-frames, a fixed GOP, an AAC track), `frames` long. */
function bitsRender(file: string, n: number, width: number, height: number, fps: number): void {
  const src = `${file}.src.mp4`;
  bitsVideo(src, Math.ceil(n / fps) + 1, 'h264-x264', `${width}x${height}`);
  execFileSync('ffmpeg', [
    '-v', 'error', '-y', '-i', src,
    '-f', 'lavfi', '-t', (n / fps).toFixed(4), '-i', 'anullsrc=r=48000:cl=stereo',
    '-map', '0:v:0', '-map', '1:a:0', '-frames:v', String(n),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-bf', '2', '-g', '60', '-keyint_min', '60', '-sc_threshold', '0',
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', file,
  ]);
  spawnSync('rm', ['-f', src]);
}

/** A render record of `plan` (as the render job writes one), its video drawn by bitsRender. */
async function writeRender(id: string, version: number, plan: EditPlan, o: { edit: string; themeSha?: string; minute: number }): Promise<RenderRecord> {
  const renders = join(dir, 'renders');
  await mkdir(renders, { recursive: true });
  const file = join(renders, `${id}.mp4`);
  bitsRender(file, plan.durationInFrames, plan.width, plan.height, plan.fps);
  const at = new Date(Date.parse('2026-01-01T13:00:00.000Z') + o.minute * 60_000).toISOString();
  const record: RenderRecord = {
    version: 1,
    id,
    project: 'demo',
    scenario: 'bits',
    run_id: RUN,
    run_dir: join(dir, 'runs', RUN),
    template: 'editorial',
    ...(o.themeSha ? { template_sha256: o.themeSha } : {}),
    overrides: plan.variant === 'landscape' ? {} : { variant: plan.variant },
    edit: { from: 'scenario', sha256: o.edit },
    variant: plan.variant,
    status: 'succeeded',
    file,
    record: join(renders, `${id}.json`),
    render_version: version,
    created_at: at,
    finished_at: at,
    duration_s: plan.durationInFrames / plan.fps,
    frames: plan.durationInFrames,
    fps: plan.fps,
    width: plan.width,
    height: plan.height,
    size_bytes: 0,
    encoding: { codec: 'h264', crf: 18, pixel_format: 'yuv420p', faststart: true, audio: 'silent' },
    concurrency: 1,
    bundle: { hash: 'synthetic', cached: true, ms: 0 },
    browser: { path: null, source: 'playwright' },
    timings: { plan_ms: 0, bundle_ms: 0, render_ms: 0, total_ms: 0 },
    warnings: [],
    plan,
  };
  await writeFile(record.record, JSON.stringify(record));
  return record;
}

const threadFile = (id: string) => join(dir, 'comments', 'bits', `${id}.json`);
const readThread = async (id: string) => JSON.parse(await readFile(threadFile(id), 'utf8')) as CommentThread;
const csp = () => page.evaluate(() => (window as unknown as { __csp: number }).__csp);
const blur = () => page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
const shownFrame = async () => Number(await page.getByTestId('viewer').getAttribute('data-shown'));

/** The frame index the viewer's picture shows (its pixels: the bits blocks). */
async function viewerBits(): Promise<number> {
  return readBits(await page.getByTestId('viewer-frame').screenshot());
}

const fields = async () => {
  const v: Record<string, number> = {};
  for (const k of ['x', 'y', 'w', 'h']) v[k] = Number(await page.getByTestId(`region-${k}`).inputValue());
  return v;
};
/** A drag on the viewer's frame between two points given as shares of its box (may lie outside it); returns once the region words changed. */
async function dragOnFrame(a: [number, number], b: [number, number]): Promise<void> {
  const before = await page.getByTestId('region-words').innerText();
  const beforeFields = JSON.stringify(await fields());
  const box = (await page.getByTestId('viewer-frame').boundingBox())!;
  await page.mouse.move(box.x + box.width * a[0], box.y + box.height * a[1]);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * ((a[0] + b[0]) / 2), box.y + box.height * ((a[1] + b[1]) / 2), { steps: 4 });
  await page.mouse.move(box.x + box.width * b[0], box.y + box.height * b[1], { steps: 4 });
  await page.mouse.up();
  await expect.poll(() => page.getByTestId('region-words').innerText(), POLL).not.toBe(before);
  // The fields follow the region on the next render.
  await expect.poll(async () => JSON.stringify(await fields()), POLL).not.toBe(beforeFields);
}
const chipTexts = async (scope: string) => {
  const out: Record<string, string> = {};
  for (const k of ['frame', 'segment', 'step', 'component']) {
    const c = page.locator(`${scope} [data-testid="chip-${k}"]`);
    if ((await c.count()) > 0) out[k] = (await c.innerText()).trim();
  }
  return out;
};

beforeAll(async () => {
  if (!canRun) return;
  ws = await mkdtemp(join(tmpdir(), 'ds-e2e-comments-'));
  process.env.DEMO_STUDIO_HOME = join(ws, '.home');
  process.env.DEMO_STUDIO_AUTHOR = AUTHOR;
  dir = await takeWorkspace(ws);
  await writeTake(dir, 'bits', { run: RUN, text: BITS_TEXT, timeline: bitsTimeline(), codec: 'vp9', seconds: 8 });
  // Part D2's Apply and re-render renders for real: the repository's bundle cache (no rebundle per test file).
  await linkSharedCache(ws);
  studio = await startStudioServer({ root: ws, startWorker: false, pollMs: 100 });
  const v = await studio.engine.timeline.view({ project: 'demo', scenario: 'bits' });
  if (!('view' in v)) throw new Error(`blocked: ${JSON.stringify(v.blocked)}`);
  // v1: the version the timeline shows (its plan and theme files); v2: the same take rendered vertical at half size.
  land = await writeRender('bits-v1', 1, v.plan as EditPlan, { edit: v.view.hash!, themeSha: v.view.theme_sha256, minute: 0 });
  const vp = await planRenderRequest(studio.engine.workspace, 'studio', { project: 'demo', scenario: 'bits', run_id: RUN, overrides: { variant: 'vertical', scale: 0.5 } });
  vert = await writeRender('bits-v2-vertical', 2, vp.planned.plan, { edit: v.view.hash!, minute: 1 });
  mcp = await createEngine({ root: ws, client: 'mcp', autoStartWorker: false });
  const executablePath = process.env.DEMO_STUDIO_CHROMIUM;
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : { channel: 'chromium' }) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addInitScript(() => {
    (window as unknown as { __csp: number }).__csp = 0;
    document.addEventListener('securitypolicyviolation', () => (window as unknown as { __csp: number }).__csp++);
  });
  page = await context.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) consoleErrors.push(m.text());
  });
  page.on('request', (r) => {
    if (!r.url().endsWith('/v1/call/render_frame')) return;
    frames.count++;
    frames.inFlight++;
    frames.maxInFlight = Math.max(frames.maxInFlight, frames.inFlight);
    const s = (JSON.parse(r.postData() ?? '{}') as { session?: string }).session;
    if (s !== undefined) frames.sessions.add(s);
  });
  const done = (r: { url(): string }) => {
    if (r.url().endsWith('/v1/call/render_frame')) frames.inFlight--;
  };
  page.on('requestfinished', done);
  page.on('requestfailed', done);
  await page.goto(studio.launchUrl());
  await page.getByRole('heading', { level: 1, name: 'Projects' }).waitFor();
}, 240_000);

afterAll(async () => {
  await browser?.close();
  await studio?.close();
  for (const [k, val] of [['DEMO_STUDIO_HOME', saved.home], ['DEMO_STUDIO_AUTHOR', saved.author]] as const) {
    if (val === undefined) delete process.env[k];
    else process.env[k] = val;
  }
  if (ws) await rm(ws, { recursive: true, force: true });
});

/** The thread the D1 tests post, and its frame (the D2 tests go on with it). */
let id = '';
let at = 0;

describe.skipIf(!canRun)('the Comments screen in Chromium (L4.6 part D1, T14a)', () => {

  it('timeline Comment → the exact frame; a dragged region and the chips; Post writes studio under the Studio\'s name; viewer = still = thread', async () => {
    // The scenario screen: Comments (0 open).
    await page.goto(`${studio.url}#/p/demo/s/bits`);
    await expect.poll(() => page.getByTestId('comments-tab').innerText(), POLL).toBe('Comments (0 open)');

    // The timeline: v1 is a render of the version shown, so Comment is offered; at the second step of scene a.
    await page.goto(`${studio.url}#/p/demo/s/bits/timeline`);
    await page.getByTestId('tracks').waitFor();
    const comment = page.getByTestId('comment-here');
    await comment.waitFor(POLL);
    expect(await comment.getAttribute('data-render')).toBe('bits-v1');
    const step = page.locator('[data-testid="tl-step"][data-key="a.1"]').first();
    at = Number(await step.getAttribute('data-from'));
    await step.click();
    await expect.poll(async () => Number(await page.getByTestId('preview').getAttribute('data-frame')), POLL).toBe(at);
    // Key C (not while typing) lands on the same place as the button.
    await blur();
    await page.keyboard.press('c');
    await page.waitForURL(`**#/p/demo/s/bits/comments/at/bits-v1/${at}`);
    await page.goBack();
    await page.getByTestId('tracks').waitFor();
    await step.click();
    await expect.poll(async () => page.getByTestId('comment-here').getAttribute('href'), POLL).toBe(`#/p/demo/s/bits/comments/at/bits-v1/${at}`);
    await shot('0-timeline');
    await page.getByTestId('comment-here').click();
    await page.waitForURL(`**#/p/demo/s/bits/comments/at/bits-v1/${at}`);

    // The viewer shows exactly that frame of v1 (its pixels), the slider says it.
    await expect.poll(shownFrame, POLL).toBe(at);
    expect(await page.getByTestId('viewer').getAttribute('data-render')).toBe('bits-v1');
    expect(await viewerBits()).toBe(at);
    expect(Number(await page.getByTestId('frame-slider').inputValue())).toBe(at);
    expect(await page.getByTestId('no-threads').innerText()).toBe('No open comment on this scenario yet.');
    // The time field's example is a time of this render (part E: a fixed "00:12.40" lay past a 6 s render's end).
    const example = (await page.getByTestId('viewer-time-input').getAttribute('placeholder')) ?? '';
    expect(example).toBe(timeExample(land.frames, land.fps));
    expect(parseTimecode(example, land.fps, land.frames)).toHaveProperty('frame');

    // ← / → move one frame (never two: one request in flight, the newest wins).
    await blur();
    for (let i = 0; i < 6; i++) await page.keyboard.press('ArrowRight');
    await expect.poll(shownFrame, POLL).toBe(at + 6);
    expect(await viewerBits()).toBe(at + 6);
    for (let i = 0; i < 6; i++) await page.keyboard.press('ArrowLeft');
    await expect.poll(shownFrame, POLL).toBe(at);
    expect(await viewerBits()).toBe(at);
    expect(frames.maxInFlight).toBe(1);
    expect(frames.sessions.size).toBe(1);
    expect([...frames.sessions][0]).toMatch(/^[A-Za-z0-9_-]{1,64}$/);

    // A region dragged under the bits band: the four fields follow (shares of the frame, in %).
    await dragOnFrame([0.2, 0.7], [0.6, 0.9]);
    const f = await fields();
    expect(Math.abs(f.x - 20)).toBeLessThan(0.6);
    expect(Math.abs(f.y - 70)).toBeLessThan(0.6);
    expect(Math.abs(f.w - 40)).toBeLessThan(0.6);
    expect(Math.abs(f.h - 20)).toBeLessThan(0.6);
    expect(await page.getByTestId('viewer-region').count()).toBe(1);
    // A click (no drag) makes no region: the one drawn stays.
    const box = (await page.getByTestId('viewer-frame').boundingBox())!;
    await page.mouse.click(box.x + box.width * 0.9, box.y + box.height * 0.1);
    await new Promise((r) => setTimeout(r, 300));
    expect(await fields()).toEqual(f);
    // The chips: the anchor the server would store for that frame and region.
    await expect.poll(() => page.locator('[data-testid="composer"] [data-testid="chip-step"]').innerText(), POLL).toContain('Step a.1 · hold');
    await expect.poll(() => page.locator('[data-testid="composer"] [data-testid="chip-frame"]').innerText(), POLL).toContain(`Frame ${at} · `);
    const chips = await chipTexts('[data-testid="composer"]');
    expect(chips.segment).toBe('Segment clip a');
    await page.getByTestId('viewer').scrollIntoViewIfNeeded();
    await shot('1-composer');

    // Post: the thread opens; the file is the channel studio, named by the Studio; the text shown literally.
    const text = `${INJECTED}\nSecond line.`;
    await page.getByTestId('comment-text').fill(text);
    await page.getByTestId('post-comment').click();
    await page.waitForURL(/#\/p\/demo\/s\/bits\/comments\/c_[0-9A-HJKMNP-TV-Z]{26}$/, POLL);
    id = decodeURIComponent(page.url().split('/comments/')[1]);
    const thread = page.getByTestId('thread');
    await thread.waitFor(POLL);
    expect(await thread.getAttribute('data-status')).toBe('open');
    expect(await page.getByTestId('thread-text').innerText()).toBe(text);
    expect(await thread.locator('img').count()).toBe(0);
    expect(await page.locator('#root img').count()).toBe(1);
    const t = await readThread(id);
    expect(t.author).toEqual({ via: 'studio', name: AUTHOR });
    expect(t.frame).toBe(at);
    expect(t.render).toMatchObject({ id: 'bits-v1', created_at: land.created_at });
    expect(t.region).toEqual({ x: f.x / 100, y: f.y / 100, w: f.w / 100, h: f.h / 100 });
    expect(t.text).toBe(text);
    // The chips shown before posting are the anchor stored (the thread shows the stored one).
    expect(await chipTexts('[data-testid="thread"]')).toEqual(chips);
    // viewer = still = thread: the still (made after the thread) shows the same frame index.
    const view = await studio.engine.comments.get('demo', id);
    expect(view.still).not.toBeNull();
    expect(readBits(await readFile(view.still!))).toBe(at);
    // The viewer moved onto the thread's frame and shows its region; the list holds it; the tab counts it.
    await expect.poll(shownFrame, POLL).toBe(at);
    expect(await viewerBits()).toBe(at);
    expect(await page.locator('[data-testid="viewer-region"]').innerText()).toBe("The comment's region");
    await expect.poll(() => page.locator('[data-testid="thread-item"]').count(), POLL).toBe(1);
    expect(await page.locator('[data-testid="thread-item"] a').getAttribute('aria-current')).toBe('page');
    expect(await page.locator('[data-testid="thread-item"]').innerText()).toContain('Studio');
    await expect.poll(() => page.getByTestId('comments-tab').innerText(), POLL).toBe('Comments (1 open)');
    await shot('2-thread');
  }, 180_000);

  it('⚑ the page names no author: a page-sent author is a 400 and nothing is written', async () => {
    const before = (await readFile(threadFile(id), 'utf8')).length;
    const r = await page.evaluate(async (o) => {
      const res = await fetch('/v1/call/thread_add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${o.token}` },
        body: JSON.stringify({ project: 'demo', render_id: 'bits-v1', created_at: o.created, frame: 3, text: 'x', author: { via: 'cli', name: 'Someone' } }),
      });
      return res.status;
    }, { token: studio.token, created: land.created_at });
    expect(r).toBe(400);
    expect((await readFile(threadFile(id), 'utf8')).length).toBe(before);
    expect((await studio.engine.comments.list('demo', { scenario: 'bits', status: 'all' })).threads).toHaveLength(1);
  });

  it('reply; an MCP proposal by event; a 409 read again and said; resolve; the filters; reopen', async () => {
    await page.getByTestId('reply-text').fill('Thanks, <b>soon</b>.');
    await page.getByTestId('reply').click();
    await expect.poll(() => page.getByTestId('thread-entry').count(), POLL).toBe(1);
    expect(await page.getByTestId('thread-entry').first().getAttribute('data-via')).toBe('studio');
    expect(await page.getByTestId('thread-entry').first().innerText()).toContain('Thanks, <b>soon</b>.');
    expect((await readThread(id)).entries.at(-1)).toMatchObject({ kind: 'reply', author: { via: 'studio', name: AUTHOR } });

    // Claude replies with a proposal (MCP): the screen reads it by event — its summary, its state in the list.
    const proposed = BITS_TEXT.replace('caption: Every frame carries its number.', 'caption: Each frame shows its number.');
    await mcp.comments.reply('demo', id, 'A plainer caption.', { proposal: { scenario_yaml: proposed, scenario_hash: sha(BITS_TEXT) } });
    await expect.poll(() => page.getByTestId('thread-entry').count(), POLL).toBe(2);
    const mcpEntry = page.getByTestId('thread-entry').nth(1);
    expect(await mcpEntry.getAttribute('data-via')).toBe('mcp');
    expect(await mcpEntry.innerText()).toContain('Agent · MCP');
    // The channel alone for an MCP entry (its author is always the server's "agent": review B N2).
    expect((await mcpEntry.locator('.th-entry-head').textContent())!.replace(/\s+/g, ' ')).toMatch(/^Agent · MCP replied · /);
    expect(await mcpEntry.getByTestId('entry-proposal').getAttribute('data-state')).toBe('pending');
    expect(await mcpEntry.getByTestId('entry-proposal').innerText()).toContain('1 line added, 1 removed, in 1 place');
    await expect.poll(() => page.locator('[data-testid="thread-item"]').innerText(), POLL).toContain('Proposal pending');
    await shot('3-proposal');

    // A 409 (the thread changed since the page showed it): said, the thread read again, nothing re-sent.
    let resolves = 0;
    await page.route('**/v1/call/thread_resolve', async (route) => {
      resolves++;
      await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ ok: false, error: { code: 'conflict', message: 'the thread changed since you read it', details: { current: 'f'.repeat(64) } } }) });
    });
    await page.getByTestId('resolve-note').fill('The caption is shorter.');
    await page.getByTestId('resolve').click();
    await expect.poll(() => page.getByTestId('thread-write-error').innerText(), POLL).toContain('The thread changed since you opened it');
    expect(resolves).toBe(1);
    expect(await page.getByTestId('resolve-note').inputValue()).toBe('The caption is shorter.');
    await page.unroute('**/v1/call/thread_resolve');

    // Resolve on the hash shown: resolved by the channel studio; the filters and the counts follow.
    await page.getByTestId('resolve').click();
    await expect.poll(() => page.getByTestId('thread').getAttribute('data-status'), POLL).toBe('resolved');
    expect((await readThread(id)).entries.at(-1)).toMatchObject({ kind: 'resolve', author: { via: 'studio', name: AUTHOR } });
    await expect.poll(() => page.getByTestId('no-threads').count(), POLL).toBe(1);
    await page.getByTestId('filter-resolved').check();
    await expect.poll(() => page.locator('[data-testid="thread-item"][data-status="resolved"]').count(), POLL).toBe(1);
    await page.getByTestId('filter-all').check();
    await expect.poll(() => page.locator('[data-testid="thread-item"]').count(), POLL).toBe(1);
    await expect.poll(() => page.getByTestId('thread-counts').innerText(), POLL).toContain('0 open · 1 resolved');
    await expect.poll(() => page.getByTestId('comments-tab').innerText(), POLL).toBe('Comments (0 open)');
    await shot('4-resolved');

    // Reopen.
    await page.getByTestId('reopen-note').fill('Still too long.');
    await page.getByTestId('reopen').click();
    await expect.poll(() => page.getByTestId('thread').getAttribute('data-status'), POLL).toBe('open');
    expect((await readThread(id)).entries.at(-1)).toMatchObject({ kind: 'reopen', author: { via: 'studio', name: AUTHOR } });
    await expect.poll(() => page.getByTestId('comments-tab').innerText(), POLL).toBe('Comments (1 open)');
  }, 120_000);

  it("a timeline pin's tooltip opens its thread", async () => {
    await page.goto(`${studio.url}#/p/demo/s/bits/timeline`);
    const pin = page.locator(`[data-testid="tl-pin"][data-id="${id}"]`);
    await pin.waitFor(POLL);
    expect(Number(await pin.getAttribute('data-frame'))).toBe(at);
    await pin.hover();
    const open = page.locator('[data-testid="pin-open-thread"]');
    await open.waitFor({ state: 'visible', ...POLL });
    await shot('6-pin');
    await open.click();
    await page.waitForURL(`**#/p/demo/s/bits/comments/${id}`);
    await page.getByTestId('thread').waitFor(POLL);
  });

  it('⚑ a drag on the vertical render: the fields are the drag on the image itself; past the edge it is clamped inside', async () => {
    await page.goto(`${studio.url}#/p/demo/s/bits/comments`);
    await page.getByTestId('render-picker').waitFor(POLL);
    await page.getByTestId('render-picker').selectOption({ label: (await page.locator('[data-testid="render-picker"] option', { hasText: 'v2 vertical' }).innerText()).trim() });
    await expect.poll(() => page.getByTestId('viewer').getAttribute('data-variant'), POLL).toBe('vertical');
    await expect.poll(async () => (await page.getByTestId('viewer').getAttribute('data-shown')) !== '', POLL).toBe(true);
    const box = (await page.getByTestId('viewer-frame').boundingBox())!;
    // The frame's box is the render's own shape (9:16): no letterbox under the pointer.
    expect(Math.abs(box.width / box.height - vert.width / vert.height)).toBeLessThan(0.02);
    await dragOnFrame([0.25, 0.25], [0.75, 0.5]);
    const f = await fields();
    expect(Math.abs(f.x - 25)).toBeLessThan(0.6);
    expect(Math.abs(f.y - 25)).toBeLessThan(0.6);
    expect(Math.abs(f.w - 50)).toBeLessThan(0.6);
    expect(Math.abs(f.h - 25)).toBeLessThan(0.6);
    await page.getByTestId('viewer').scrollIntoViewIfNeeded();
    await shot('5-vertical');
    // Past the bottom-right edge: clamped inside the frame (x + w = 100 %, y + h = 100 %).
    await dragOnFrame([0.5, 0.6], [1.3, 1.4]);
    const g = await fields();
    expect(g.x + g.w).toBeCloseTo(100, 5);
    expect(g.y + g.h).toBeCloseTo(100, 5);
    // And the four fields drive the box (the keyboard alternative); Clear removes it.
    await page.getByTestId('region-x').fill('10');
    await expect.poll(() => page.getByTestId('region-words').innerText(), POLL).toContain('from 10 % left');
    await expect.poll(() => page.locator('[data-testid="composer"] [data-testid="chip-frame"]').count(), POLL).toBe(1);
    await page.getByTestId('region-clear').click();
    await expect.poll(() => page.getByTestId('viewer-region').count(), POLL).toBe(0);
    await expect.poll(async () => page.getByTestId('region-x').inputValue(), POLL).toBe('');
    expect(await page.getByTestId('region-words').innerText()).toBe('No region: the comment is about the whole frame.');

    expect(await csp()).toBe(0);
    expect(consoleErrors).toEqual([]);
  }, 60_000);
});

// ── Part D2 (T14b): Claude's proposal, previewed, applied, undone, applied and re-rendered, resolved ─────────────
describe.skipIf(!canRun)("Claude's proposal in Chromium (L4.6 part D2, T14b)", () => {
  const scenarioFile = () => join(dir, 'scenarios', 'bits.yaml');
  const HOSTILE = '# <img src=x onerror=alert(1)> עברית: a';
  const PROPOSED = BITS_TEXT.replace('title: {text: Bits}\n', 'title: {text: Bits} \n')
    .replace('outro: false\n', `outro: false\n${HOSTILE}\n`)
    .replace('caption: Every frame carries its number.', 'caption: Each frame shows its number.');
  let entry = '';
  const proposal = () => page.getByTestId('proposal');
  const buttonsShown = async () => {
    const out: string[] = [];
    for (const t of ['proposal-apply', 'proposal-preview', 'proposal-apply-render']) if ((await page.getByTestId(t).count()) > 0) out.push(t.replace('proposal-', ''));
    return out;
  };
  const focus = () => page.evaluate(() => window.dispatchEvent(new Event('focus')));

  it("⚑ Claude's newer proposal: its diff drawn code-safe and literally; ⚑ the buttons from the offer only; ⚑ a page-sent proposal is a 400", async () => {
    expect(PROPOSED).not.toBe(BITS_TEXT);
    const w = await mcp.comments.reply('demo', id, 'A plainer caption, and a note for the team.', { proposal: { scenario_yaml: PROPOSED, scenario_hash: sha(BITS_TEXT) } });
    entry = w.entry;
    await page.goto(`${studio.url}#/p/demo/s/bits/comments/${id}`);
    await expect.poll(() => proposal().getAttribute('data-entry'), POLL).toBe(entry);
    expect(await proposal().getAttribute('data-state')).toBe('pending');
    expect(await proposal().getAttribute('data-verified')).toBe('yes');
    const view = await studio.engine.comments.proposal('demo', id, entry);
    expect(view).toMatchObject({ added: 3, removed: 2, hunks: 3 });
    expect(await page.getByTestId('proposal-summary').innerText()).toBe('A change to the scenario file bits: 3 lines added, 2 removed, in 3 places.');
    // The table is the server's rows, one for one; the older proposal is superseded.
    const rows = page.locator('[data-testid="proposal"] [data-testid="diff-row"]');
    expect(await rows.count()).toBe(view.rows.length);
    expect(await page.locator('[data-testid="entry-proposal"]').first().getAttribute('data-state')).toBe('superseded');
    const lineOf = async (kind: string, start: string) => {
      const texts = await page.locator(`[data-testid="proposal"] [data-testid="diff-row"][data-kind="${kind}"] [data-testid="diff-line"]`).allInnerTexts();
      return texts.filter((t) => t.startsWith(start));
    };
    // ⚑ A trailing space is a visible mark: the removed and the added line differ on screen.
    expect(await lineOf('del', 'title:')).toEqual(['title: {text: Bits}']);
    expect(await lineOf('add', 'title:')).toEqual(['title: {text: Bits}·']);
    // ⚑ Markup and right-to-left text are text: shown literally, no element made, in an isolated left-to-right cell.
    expect(await lineOf('add', '#')).toEqual([HOSTILE]);
    expect(await proposal().locator('img').count()).toBe(0);
    expect(await page.locator('#root img').count()).toBe(1);
    const cell = page.locator('[data-testid="proposal"] [data-testid="diff-row"][data-kind="add"] [data-testid="diff-line"]').filter({ hasText: 'onerror' });
    expect(await cell.evaluate((el) => [el.getAttribute('dir'), getComputedStyle(el).unicodeBidi, getComputedStyle(el).whiteSpace])).toEqual(['ltr', 'bidi-override', 'pre-wrap']);
    // ⚑ Byte order on screen (review A L6): the Hebrew letters and the text after them are drawn left to right as the
    // bytes go — first letter leftmost, the final "a" rightmost — and the row says it holds right-to-left text.
    const xs = await cell.evaluate((el) => {
      const node = el.querySelector('span')!.firstChild as Text;
      const x = (i: number) => {
        const r = document.createRange();
        r.setStart(node, i);
        r.setEnd(node, i + 1);
        return r.getBoundingClientRect().left;
      };
      const t = node.data;
      return [x(t.indexOf('ע')), x(t.indexOf('ת')), x(t.lastIndexOf('a'))];
    });
    expect(xs[0]).toBeLessThan(xs[1]);
    expect(xs[1]).toBeLessThan(xs[2]);
    expect(await page.locator('[data-testid="proposal"] [data-testid="diff-row"][data-kind="add"]').filter({ hasText: 'onerror' }).getByTestId('diff-rtl').innerText()).toBe('right-to-left text');
    // ⚑ Every row is on the page, Apply after the whole diff (review A M1): the box has no inner scroll.
    const box = page.getByTestId('proposal-diff-box');
    expect(await box.evaluate((el) => [getComputedStyle(el).overflowY, el.scrollHeight <= el.clientHeight + 1])).toEqual(['visible', true]);
    expect((await page.getByTestId('proposal-apply').boundingBox())!.y).toBeGreaterThan((await box.boundingBox())!.y + (await box.boundingBox())!.height - 1);
    expect(await page.getByTestId('diff-all').count()).toBe(0);
    // ⚑ With a proposal open the frame stays readable at laptop widths (review B M1): ≥ 300 px wide at 1280 and 1440.
    for (const width of [1280, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await expect.poll(async () => (await page.getByTestId('viewer-frame').boundingBox())!.width, POLL).toBeGreaterThanOrEqual(300);
      await shot(`7-proposal-${width}`);
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    // The caption's indentation is drawn (YAML's meaning is indentation).
    expect(await lineOf('add', '····caption:')).toEqual(['····caption: Each frame shows its number.']);
    // The offer: a landscape thread on a render with the files' theme and no option — all three, nothing said.
    expect(await buttonsShown()).toEqual(['apply', 'preview', 'apply-render']);
    expect(await page.getByTestId('proposal-why').count()).toBe(0);
    await page.getByTestId('thread').scrollIntoViewIfNeeded();
    await shot('7-proposal-diff');

    // ⚑ The buttons follow the offer only: the same proposal with another offer (changed in transit) shows other buttons.
    let offer: Record<string, unknown> = { apply: false, preview: false, apply_render: false, why: 'Held by the test' };
    await page.route('**/v1/call/thread_get', async (route) => {
      const res = await route.fetch();
      const body = (await res.json()) as { ok: boolean; data: { proposal?: { offer: unknown } } };
      if (body.data.proposal) body.data.proposal.offer = offer;
      await route.fulfill({ response: res, json: body });
    });
    await focus();
    await expect.poll(buttonsShown, POLL).toEqual([]);
    expect(await page.getByTestId('proposal-why').innerText()).toBe('Held by the test.');
    expect(await proposal().getAttribute('data-state')).toBe('pending');
    offer = { apply: true, preview: false, apply_render: false, why: 'Only Apply, says the test' };
    await focus();
    await expect.poll(buttonsShown, POLL).toEqual(['apply']);
    expect(await page.getByTestId('proposal-why').innerText()).toBe('Only Apply, says the test.');
    await page.unroute('**/v1/call/thread_get');
    await focus();
    await expect.poll(buttonsShown, POLL).toEqual(['apply', 'preview', 'apply-render']);

    // ⚑ The page makes no proposal: thread_reply with one is a 400 and nothing is written.
    const before = await readFile(threadFile(id), 'utf8');
    const status = await page.evaluate(async (o) => {
      const res = await fetch('/v1/call/thread_reply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${o.token}` },
        body: JSON.stringify({ project: 'demo', comment_id: o.id, text: 'mine', proposal: { scenario_yaml: o.text, scenario_hash: o.hash } }),
      });
      return res.status;
    }, { token: studio.token, id, text: PROPOSED.replace('Each frame', 'Any frame'), hash: sha(BITS_TEXT) });
    expect(status).toBe(400);
    expect(await readFile(threadFile(id), 'utf8')).toBe(before);
  }, 120_000);

  it('Apply writes exactly the proposed bytes, ⚑ its problems and warnings said; Undo apply restores the file byte for byte and offers it again', async () => {
    // ⚑ What the apply said beside its write is shown (review B M2): here added to the real answer in transit.
    await page.route('**/v1/call/thread_apply', async (route) => {
      const res = await route.fetch();
      const body = (await res.json()) as { ok: boolean; data: { problems: string[]; warnings: unknown[] } };
      if (body.ok) {
        body.data.problems = ['the apply was written to scenarios/bits.yaml but not recorded in the thread (a test)'];
        body.data.warnings = [{ message: 'a warning from the test' }];
      }
      await route.fulfill({ response: res, json: body });
    });
    await page.getByTestId('proposal-apply').click();
    await page.getByTestId('proposal-applied').waitFor(POLL);
    await expect.poll(() => page.getByTestId('proposal-said').innerText(), POLL).toBe(
      'Applied, but: the apply was written to scenarios/bits.yaml but not recorded in the thread (a test)\nThe scenario has 1 warning: a warning from the test',
    );
    await page.unroute('**/v1/call/thread_apply');
    expect(await readFile(scenarioFile(), 'utf8')).toBe(PROPOSED);
    await expect.poll(() => proposal().getAttribute('data-state'), POLL).toBe('applied');
    expect(await buttonsShown()).toEqual([]);
    expect(await page.getByTestId('proposal-why').innerText()).toBe('Applied: the scenario holds it.');
    expect((await readThread(id)).entries.at(-1)).toMatchObject({ kind: 'apply', applies: entry, author: { via: 'studio', name: AUTHOR } });
    await shot('8-applied');
    await page.getByTestId('proposal-undo').click();
    await expect.poll(() => proposal().getAttribute('data-state'), POLL).toBe('undone');
    expect(await readFile(scenarioFile(), 'utf8')).toBe(BITS_TEXT);
    expect(await proposal().innerText()).toContain('Applied, then undone');
    await page.getByTestId('proposal-undone').waitFor(POLL);
    expect(await page.getByTestId('proposal-applied').count()).toBe(0);
    await expect.poll(buttonsShown, POLL).toEqual(['apply', 'preview', 'apply-render']);
  }, 60_000);

  it('Preview change → the banner (⚑ no Apply there), the proposed caption, Render off; Back to the comment → the proposal; Apply and re-render → v3 rendered → Resolve with v3; Reopen', async () => {
    await page.getByTestId('proposal-preview').click();
    await page.waitForURL(`**#/p/demo/s/bits/proposal/${id}/${entry}`);
    await page.getByTestId('proposal-banner').waitFor(POLL);
    expect(await page.getByTestId('proposal-banner').getAttribute('data-shown')).toBe('yes');
    await expect.poll(() => page.getByTestId('tl-caption').first().innerText(), POLL).toBe('Each frame shows its number.');
    expect(await page.getByTestId('timeline-source').innerText()).toContain('proposed edit');
    expect(await page.getByTestId('render').isDisabled()).toBe(true);
    // ⚑ The banner never applies (review A M1): no diff is shown there.
    await page.getByTestId('banner-back').waitFor(POLL);
    expect(await page.locator('[data-testid="proposal-banner"] button').count()).toBe(0);
    expect(await page.getByTestId('banner-apply').count()).toBe(0);
    expect(await page.getByTestId('banner-apply-render').count()).toBe(0);
    // The playhead goes to the comment's pin.
    const pin = page.locator(`[data-testid="tl-pin"][data-id="${id}"]`);
    await pin.waitFor(POLL);
    await expect.poll(async () => page.getByTestId('preview').getAttribute('data-frame'), POLL).toBe(await pin.getAttribute('data-frame'));
    // Previewing writes nothing.
    expect(await readFile(scenarioFile(), 'utf8')).toBe(BITS_TEXT);
    await shot('9-preview');

    // Back to the comment: the thread, scrolled to its proposal (its heading focused); Apply and re-render there.
    await page.getByTestId('banner-back').click();
    await page.waitForURL(`**#/p/demo/s/bits/comments/${id}`);
    await page.getByTestId('proposal-apply-render').waitFor(POLL);
    await expect.poll(() => page.evaluate(() => document.activeElement?.classList.contains('pp-head') ?? false), POLL).toBe(true);
    const head = (await page.locator('[data-testid="proposal"] .pp-head').boundingBox())!;
    expect(head.y).toBeGreaterThanOrEqual(-1);
    expect(head.y).toBeLessThan(1000);
    expect(await readFile(scenarioFile(), 'utf8')).toBe(BITS_TEXT);
    await page.getByTestId('proposal-apply-render').click();
    await expect.poll(() => readFile(scenarioFile(), 'utf8'), POLL).toBe(PROPOSED);
    await expect.poll(() => page.getByTestId('proposal-render').getAttribute('data-state'), POLL).toBe('queued');
    expect(await page.getByTestId('proposal-render').innerText()).toContain('v3');
    expect(await page.getByTestId('proposal-undo').count()).toBe(1);
    await page.getByTestId('thread').scrollIntoViewIfNeeded();
    await shot('10-queued');
    const t0 = Date.now();
    expect(await runWorker({ root: ws, once: true, idleExitMs: 0, pollMs: 50, log: () => undefined })).toBe(0);
    console.log(`Apply and re-render: render + review ${Date.now() - t0} ms`);
    const resolveWith = page.getByTestId('resolve-with');
    await resolveWith.waitFor({ state: 'visible', timeout: 120_000 });
    expect(await resolveWith.getAttribute('data-render')).toBe('bits-v3');
    expect(await resolveWith.innerText()).toBe('Resolve with v3');
    const rec = JSON.parse(await readFile(join(dir, 'renders', 'bits-v3.json'), 'utf8')) as RenderRecord;
    expect(rec).toMatchObject({ status: 'succeeded', run_id: RUN, variant: 'landscape', edit: { from: 'scenario', sha256: sha(PROPOSED) } });
    await shot('11-rendered');
    await resolveWith.click();
    await expect.poll(() => page.getByTestId('thread').getAttribute('data-status'), POLL).toBe('resolved');
    expect((await readThread(id)).entries.at(-1)).toMatchObject({ kind: 'resolve', render_id: 'bits-v3', render_created_at: rec.created_at, author: { via: 'studio', name: AUTHOR } });
    await page.getByTestId('filter-resolved').check();
    await expect.poll(() => page.locator(`[data-testid="thread-item"][data-id="${id}"][data-status="resolved"]`).count(), POLL).toBe(1);
    expect(await page.getByTestId('proposal-why').innerText()).toBe('The thread is resolved: reopen it to apply a proposal.');
    // A resolved thread offers no Undo apply (the file stays what resolved it).
    expect(await page.getByTestId('proposal-undo').count()).toBe(0);
    await shot('12-resolved');

    // Reopen: the applied proposal offers nothing, and says why.
    await page.getByTestId('reopen').click();
    await expect.poll(() => page.getByTestId('thread').getAttribute('data-status'), POLL).toBe('open');
    await expect.poll(() => page.getByTestId('proposal-why').innerText(), POLL).toBe('Applied: the scenario holds it.');
    expect(await buttonsShown()).toEqual([]);

    expect(await csp()).toBe(0);
    expect(consoleErrors).toEqual([]);
  }, 300_000);
});
