/**
 * L4.9 part C: the screen tour's shared set-up (a test helper): a scratch workspace holding a copy of
 * projects/northfield-fixture (with the fixture workspace's failed dry run and capture, engine test helpers) and the
 * synthetic `demo` project with the bits take (timeline-take.ts: VP9, two comment threads at one frame, Claude's proposal
 * on the first — an in-process engine of client `mcp`, as `comment_reply` makes one — whose diff holds a trailing space
 * and right-to-left text), a scenario file that does not parse, an editable workspace theme `tour-theme` (a copy of editorial in the
 * workspace's own templates folder: the theme editor is toured with its fields enabled); the Studio server with no
 * worker; headless Chromium. `station()` visits one state at 1280 then 1440 wide once nothing is loading (a station still
 * loading after 30 s is a finding) and runs the checker on it: every rule, a budget of unmeasured and of exempt texts,
 * the Tab walk at 1280 (its cap per station; a truncated walk is a finding) and the arrows across a shared tab stop.
 * L5.9: in both appearances — dark (the default, following the system) at 1280 and 1440 with the walk, then light at
 * 1280 (its values are L4.9's, proven at both widths then) — and the colour-only rule must have status tokens to watch.
 * Whatever `startTour` started is closed again when it throws.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import type { Browser, Page } from 'playwright-core';
import type { Appearance } from '../src/app/tokens.js';
import { createEngine } from '@demo-studio/engine';
import type { Engine } from '@demo-studio/engine';
import type { EditPlan } from '@demo-studio/editor';
import { startStudioServer } from '../src/index.js';
import type { StudioServer } from '../src/index.js';
import { REPO, fixtureWorkspace } from '../../engine/test/helpers.js';
import { WALK_MAX, auditPage, familyWalk, formatFindings, settle, tabWalk } from './a11y.js';
import type { Audit, Finding, TabWalk } from './a11y.js';
import { BITS_TEXT, bitsTimeline, bitsVideo, takeWorkspace, writeTake, writeThread } from './timeline-take.js';

export const N = 'northfield-fixture';
export const RUN = '20260101-120000-bits';
export const THREAD = 'c_01JAAAAAAAAAAAAAAAAAAAAAAA';
export const THREAD2 = 'c_01JBBBBBBBBBBBBBBBBBBBBBBB';
export const WIDTHS = [1280, 1440] as const;
/** The appearances a station is checked in, each at its widths (the walk: the first width of the first). */
export const SCHEMES: Array<{ scheme: Appearance; widths: readonly number[] }> = [
  { scheme: 'dark', widths: WIDTHS },
  { scheme: 'light', widths: [1280] },
];
export const POLL = { timeout: 30_000 };
const SHOTS = process.env.DEMO_STUDIO_UI_SHOTS;
/** The workspace's own theme (editable in the Studio). */
export const TOUR_THEME = 'tour-theme';
/** Claude's proposal on the thread: a caption change, a trailing space and an added line of right-to-left text. */
export const PROPOSED = BITS_TEXT.replace('caption: Every frame carries its number.', 'caption: Every frame shows its number. ').replace('  - card: {slots: {title: Chapter two}}', '  - card: {slots: {title: Chapter two}}\n    # עברית: a note in right-to-left text');

export interface Tour {
  ws: string;
  /** The demo project's folder. */
  dir: string;
  studio: StudioServer;
  mcp: Engine;
  browser: Browser;
  page: Page;
  /** Claude's proposal entry on THREAD. */
  entry: string;
  consoleErrors: string[];
  /** Station → what the checker found and counted (logged at the end). */
  log: string[];
  close(): Promise<void>;
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/** bits-v1: a render of the version the timeline shows (its plan), its video the bits take as x264 (the viewer's frames). */
export async function writeRender(dir: string, plan: EditPlan, edit: string): Promise<void> {
  const renders = join(dir, 'renders');
  await mkdir(renders, { recursive: true });
  const file = join(renders, 'bits-v1.mp4');
  bitsVideo(file, Math.ceil(plan.durationInFrames / plan.fps), 'h264-x264', `${plan.width / 2}x${plan.height / 2}`);
  const at = '2026-01-01T13:00:00.000Z';
  const record = {
    version: 1, id: 'bits-v1', project: 'demo', scenario: 'bits', run_id: RUN, run_dir: join(dir, 'runs', RUN), template: 'editorial', overrides: {},
    edit: { from: 'scenario', sha256: edit }, variant: plan.variant, status: 'succeeded', file, record: join(renders, 'bits-v1.json'), render_version: 1,
    created_at: at, finished_at: at, duration_s: plan.durationInFrames / plan.fps, frames: plan.durationInFrames, fps: plan.fps, width: plan.width, height: plan.height,
    size_bytes: 0, encoding: { codec: 'h264', crf: 18, pixel_format: 'yuv420p', faststart: true, audio: 'silent' }, concurrency: 1,
    bundle: { hash: 'synthetic', cached: true, ms: 0 }, browser: { path: null, source: 'playwright' }, timings: { plan_ms: 0, bundle_ms: 0, render_ms: 0, total_ms: 0 }, warnings: [], plan,
  };
  await writeFile(record.record, JSON.stringify(record));
}

/** L5.12a: bits-v1's review (the Review report's station): a contact sheet, a scene sheet, three findings at frames. */
export async function writeReview(dir: string): Promise<void> {
  const rv = join(dir, 'review', 'bits-v1');
  await mkdir(rv, { recursive: true });
  for (const [f, c] of [['sheet_1fps.jpg', 'navy'], ['sheet_scene_a.jpg', 'teal']]) execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=${c}:s=960x270`, '-frames:v', '1', join(rv, f)]);
  await writeFile(
    join(rv, 'report.json'),
    JSON.stringify({
      version: 1,
      clean: false,
      counts: { error: 1, warning: 1, info: 1 },
      review: { created_at: '2026-01-01T13:01:00.000Z', fps: 1 },
      findings: [
        { severity: 'warning', code: 'caption-too-long', message: 'The caption of scene a is long for its 2 s on screen', at: { frame: 30, segment: 'a', scene: 'a', step: 1 } },
        { severity: 'info', code: 'video-length', message: 'the video lasts 6 s: shorter than the target of the reference look' },
        { severity: 'error', code: 'blank-screen', message: 'the screen is blank for 0.5 s', at: { frame: 120, segment: 'b', scene: 'b', step: 0 } },
      ],
      files: { sheets: [join(rv, 'sheet_1fps.jpg')], scene_sheets: { a: [join(rv, 'sheet_scene_a.jpg')] }, keyframes: {} },
    }),
  );
}

/** The tour's workspace, server and browser (`prepare`: the caller's own changes to the workspace, e.g. fixture ports). */
export async function startTour(o: { prefix: string; prepare?: (ws: string) => Promise<void> }): Promise<Tour> {
  const ws = await mkdtemp(join(tmpdir(), o.prefix));
  const saved = { home: process.env.DEMO_STUDIO_HOME, author: process.env.DEMO_STUDIO_AUTHOR };
  let studio: StudioServer | undefined;
  let browser: Browser | undefined;
  const restore = () => {
    for (const [k, val] of [['DEMO_STUDIO_HOME', saved.home], ['DEMO_STUDIO_AUTHOR', saved.author]] as const) {
      if (val === undefined) delete process.env[k];
      else process.env[k] = val;
    }
  };
  const cleanUp = async () => {
    await browser?.close().catch(() => undefined);
    await studio?.close().catch(() => undefined);
    restore();
    await rm(ws, { recursive: true, force: true });
  };
  try {
    process.env.DEMO_STUDIO_HOME = join(ws, '.home');
    process.env.DEMO_STUDIO_AUTHOR = 'Studio Person';
    const dir = await takeWorkspace(ws);
    // The fixture project (and the repository's templates: northfield uses editorial too).
    await fixtureWorkspace(ws);
    // The workspace's own templates folder holding an editable copy of editorial (the starters still resolve by name).
    await writeFile(join(ws, 'studio.yaml'), 'version: 1\nprojects_dir: projects\ntemplates_dir: templates\n');
    await cp(join(REPO, 'templates', 'editorial'), join(ws, 'templates', TOUR_THEME), { recursive: true });
    await writeTake(dir, 'bits', { run: RUN, text: BITS_TEXT, timeline: bitsTimeline(), codec: 'vp9', seconds: 8 });
    await writeFile(join(dir, 'scenarios', 'broken.yaml'), 'video: Broken\nscenes:\n  - id: a\n    steps: [click: Next\n');
    // A project whose persona cannot sign in by itself (no login steps): a capture asks first (the sessions dialog).
    const board = join(ws, 'projects', 'board');
    await mkdir(join(board, 'scenarios'), { recursive: true });
    await writeFile(join(board, 'project.yaml'), ['version: 1', 'name: Board', 'environments:', '  local: {app: "http://app.test"}', '  signed-in: {app: "http://app.test"}', 'auth:', '  signed-in:', '    login_url: /sign-in', '    personas:', '      owner: {pages: [app], check: {url: "app:/members", expect_text: Members}}', 'template: editorial', ''].join('\n'));
    await writeFile(join(board, 'scenarios', 'members.yaml'), ['version: 1', 'video: members', 'env: signed-in', 'scenes:', '  - id: list', '    page: app', '    open: /members', '    steps:', '      - hold: 0.5', ''].join('\n'));
    await o.prepare?.(ws);
    studio = await startStudioServer({ root: ws, startWorker: false, pollMs: 150, log: () => undefined });
    const v = await studio.engine.timeline.view({ project: 'demo', scenario: 'bits' });
    if (!('view' in v)) throw new Error(`blocked: ${JSON.stringify(v.blocked)}`);
    await writeRender(dir, v.plan as EditPlan, v.view.hash!);
    await writeReview(dir);
    await writeThread(dir, { id: THREAD, scenario: 'bits', run: RUN, frames: v.plan.durationInFrames, text: 'The zoom starts too early', anchor: { segment: 'a', kind: 'clip', scene: 'a', step: 1 } });
    // A second thread: the list has a row beside the current one (the current row's look is compared with it).
    await writeThread(dir, { id: THREAD2, scenario: 'bits', run: RUN, frames: v.plan.durationInFrames, text: 'The card could hold longer', anchor: { segment: 'c1', kind: 'card' } });
    // A region on the thread: the viewer draws it (a mark and its label over the frame).
    const threadFile = join(dir, 'comments', 'bits', `${THREAD}.json`);
    await writeFile(threadFile, JSON.stringify({ ...JSON.parse(await readFile(threadFile, 'utf8')), region: { x: 0.2, y: 0.6, w: 0.4, h: 0.25 } }));
    const mcp = await createEngine({ root: ws, client: 'mcp', autoStartWorker: false });
    const w = await mcp.comments.reply('demo', THREAD, 'A plainer caption, and a note for the team.', { proposal: { scenario_yaml: PROPOSED, scenario_hash: sha(BITS_TEXT) } });
    const executablePath = process.env.DEMO_STUDIO_CHROMIUM;
    browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : { channel: 'chromium' }) });
    const context = await browser.newContext({ viewport: { width: WIDTHS[0], height: 900 }, colorScheme: 'dark' });
    await context.addInitScript(() => {
      (window as unknown as { __csp: number }).__csp = 0;
      document.addEventListener('securitypolicyviolation', () => (window as unknown as { __csp: number }).__csp++);
    });
    const page = await context.newPage();
    const consoleErrors: string[] = [];
    page.on('console', (m) => {
      if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) consoleErrors.push(m.text());
    });
    page.on('pageerror', (e) => consoleErrors.push(String(e)));
    await page.goto(studio.launchUrl());
    await page.getByRole('heading', { level: 2, name: 'Projects' }).waitFor();
    const t: Tour = {
      ws,
      dir,
      studio,
      mcp,
      browser,
      page,
      entry: w.entry,
      consoleErrors,
      log: [],
      async close() {
        if (t.log.length) console.log(`a11y tour:\n  ${t.log.join('\n  ')}`);
        await cleanUp();
      },
    };
    return t;
  } catch (e) {
    await cleanUp();
    throw e;
  }
}

export async function go(page: Page, url: string, ready: string): Promise<void> {
  await page.goto(url);
  await page.locator(ready).first().waitFor(POLL);
}

export interface StationResult {
  /** The audits at the first appearance (dark), by width. */
  audits: Record<number, Audit>;
  /** Every audit, `<scheme>@<width>`. */
  all: Record<string, Audit>;
  walk?: TabWalk;
}

export interface StationOptions {
  /** Walk the Tab order at 1280 (default true; inside an open modal dialog the walk stays in it). */
  walk?: boolean;
  /** The walk's cap (default WALK_MAX): reaching it without coming back to the first stop is a finding. */
  walkMax?: number;
  /** Texts that may be unmeasured (an image background, a gradient thumbnail) — default 0. */
  unmeasuredMax?: number;
  /** Texts of disabled controls that may be exempt — default 10 (a state whose controls are off on purpose says more). */
  exemptMax?: number;
  /** The appearances and widths (default SCHEMES). */
  schemes?: Array<{ scheme: Appearance; widths: readonly number[] }>;
  /** A busy element the station holds on purpose (a write in flight): not waited for, and still busy at every audit. */
  busy?: string;
}

/**
 * One state of a screen: reached once by `reach` (at 1280), checked there (every rule + the Tab walk), then at 1440
 * (every rule but the walk), then the arrows across each shared tab stop. Returns the findings of both widths; the
 * caller asserts them empty (with the report).
 */
export async function station(t: Tour, name: string, reach: () => Promise<void>, o: StationOptions = {}): Promise<{ findings: Finding[]; report: string; result: StationResult }> {
  const { page } = t;
  const schemes = o.schemes ?? SCHEMES;
  await page.emulateMedia({ colorScheme: schemes[0].scheme });
  await page.setViewportSize({ width: schemes[0].widths[0], height: 900 });
  await reach();
  const result: StationResult = { audits: {}, all: {} };
  const findings: Finding[] = [];
  for (const [si, { scheme, widths }] of schemes.entries()) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const [wi, width] of widths.entries()) {
      const at = `${scheme}@${width}`;
      await page.setViewportSize({ width, height: 900 });
      const loading = await settle(page, POLL.timeout, o.busy ?? null);
      if (loading.length) findings.push({ rule: 'contrast', el: 'loading', detail: `${at} still loading after ${POLL.timeout / 1000} s: ${loading.join('; ')}` });
      if (o.busy && (await page.locator(`${o.busy}[aria-busy="true"]`).count()) === 0) findings.push({ rule: 'contrast', el: o.busy, detail: `${at} the busy state toured ended before its audit` });
      const a = await auditPage(page);
      result.all[at] = a;
      if (si === 0) result.audits[width] = a;
      findings.push(...a.findings.map((f) => ({ ...f, detail: `${at} ${f.detail}` })));
      if (a.stats.statusTokens === 0) findings.push({ rule: 'colour-only', el: 'document', detail: `${at} the colour-only rule found no status token to watch` });
      const over = a.stats.unmeasured.length - (o.unmeasuredMax ?? 0);
      if (over > 0) findings.push({ rule: 'contrast', el: 'unmeasured', detail: `${at} ${a.stats.unmeasured.length} texts unmeasured (budget ${o.unmeasuredMax ?? 0}): ${a.stats.unmeasured.slice(0, 6).join('; ')}` });
      if (a.stats.exempt > (o.exemptMax ?? 10)) findings.push({ rule: 'contrast', el: 'exempt', detail: `${at} ${a.stats.exempt} texts exempt as disabled (budget ${o.exemptMax ?? 10}): the state toured is not the one a person edits` });
      if (SHOTS) {
        await mkdir(SHOTS, { recursive: true });
        await page.screenshot({ path: join(SHOTS, `a11y-${name}-${scheme}-${width}.png`) });
      }
      if (si === 0 && wi === 0 && o.walk !== false) {
        result.walk = await tabWalk(page, { max: o.walkMax ?? WALK_MAX });
        findings.push(...result.walk.findings.map((f) => ({ ...f, detail: `${at} ${f.detail}` })));
      }
    }
  }
  await page.emulateMedia({ colorScheme: schemes[0].scheme });
  const first = Object.values(result.all)[0];
  const families = [...new Set(Object.values(result.all).flatMap((x) => x.stats.families))];
  for (const f of families) findings.push(...(await familyWalk(page, f)));
  t.log.push(`${name}: ${first.stats.texts} texts (${first.stats.overMedia} over media, ${first.stats.unmeasured.length} unmeasured, ${first.stats.exempt} exempt), ${first.stats.placeholders} placeholders, ${first.stats.controls} controls named, ${first.stats.selected} selected states compared (${first.stats.selectedAlone} alone), ${first.stats.statusTokens} status colours watched, ${result.walk ? `${result.walk.stops} Tab stops${result.walk.frames ? ` (${result.walk.frames} frames)` : ''}` : 'no walk'}${families.length ? `, ${families.length} shared tab stop${families.length > 1 ? 's' : ''} crossed` : ''}, ${Object.keys(result.all).join(' ')}; ${findings.length} findings`);
  return { findings, report: `${name}:\n${formatFindings(findings)}`, result };
}

/** Press Tab until the focused element matches `selector` (keyboard only); fails after `max` presses. */
export async function tabTo(page: Page, selector: string, max = 80, key = 'Tab'): Promise<void> {
  for (let i = 0; i < max; i++) {
    if (await page.evaluate((s) => document.activeElement?.matches(s) ?? false, selector)) return;
    await page.keyboard.press(key);
  }
  throw new Error(`Tab never reached ${selector} (on ${await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 120) ?? 'nothing')})`);
}

export const readText = (file: string) => readFile(file, 'utf8');
export { REPO, settle };
