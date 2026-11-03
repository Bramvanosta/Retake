/**
 * Automated fixture acceptance (R-ACC-05, slow: gated by RETAKE_TEST_SLOW=1 — `pnpm test:slow`, about 1.5 min).
 * The committed `catalogue` scenario of projects/northfield-fixture, unchanged, captured on the fixture product (free
 * ports, in case `pnpm fixture` runs) at 1920×1080 with the debug cursor (a 6×6 magenta square on the hotspot), with
 * its real setup / teardown hooks. Checked: the run and its files, every frame's size, the duration, the scroll
 * durations, the drawn hotspot at every click (≤ 3 px from the click point, inside the target), the popups the clicks
 * opened, no hesitation between steps and the setup rollback. Nothing is written into the repository: the project is read, its local
 * environment pointed at the fixture's ports in memory, the run goes to a temp folder.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RunRecordSchema, TimelineSchema, loadProject, loadScenario } from '@retake/core';
import type { BBox, LoadedProject, RunProgress, RunRecord, Timeline, TimelineEvent } from '@retake/core';
import { runScenario } from '@retake/runner-web';
import { debugTemplate, execFileP, ffprobeDuration, frameAt, magentaCentroid } from '../../runner-web/test/helpers.js';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const W = 1920;
const H = 1080;

function chromiumAvailable(): boolean {
  if (process.env.RETAKE_CHROMIUM) return existsSync(process.env.RETAKE_CHROMIUM);
  try {
    const require = createRequire(join(REPO, 'packages/runner-web/package.json'));
    const { chromium } = require('playwright-core') as { chromium: { executablePath(): string } };
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
}

const ENABLED =
  process.env.RETAKE_TEST_SLOW === '1' &&
  chromiumAvailable() &&
  spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0 &&
  spawnSync('ffprobe', ['-version'], { stdio: 'ignore' }).status === 0;

interface Fixture {
  urls: { console: string; shop: string };
  store: { products: Array<{ slug: string; registry_refs: string[] }> };
  close(): Promise<void>;
}

/** One click of the run: an event-level click or a click of a composite step (`data.clicks`). */
interface Click {
  where: string;
  t: number;
  point: { x: number; y: number };
  bbox: BBox;
}

function clicksOf(tl: Timeline): Click[] {
  const out: Click[] = [];
  for (const e of tl.events) {
    const at = `${e.scene}.${e.step} ${e.action}`;
    if (e.t_click !== undefined && e.point && e.target?.bbox) out.push({ where: `${at} ${e.target.desc}`, t: e.t_click, point: e.point, bbox: e.target.bbox });
    const sub = (e.data as { clicks?: Array<{ role: string; t_click: number; point: { x: number; y: number }; bbox?: BBox; desc: string }> } | undefined)?.clicks ?? [];
    for (const c of sub) {
      // An `outside` click lands on a neutral area (no target box); the event-level click of a plain click is listed once.
      if (c.role === 'outside' || !c.bbox || (e.t_click !== undefined && Math.abs(c.t_click - e.t_click) < 1e-6)) continue;
      out.push({ where: `${at} ${c.role} ${c.desc}`, t: c.t_click, point: c.point, bbox: c.bbox });
    }
  }
  return out;
}

describe.skipIf(!ENABLED)('catalogue scenario on the fixture, 1920×1080, debug cursor (R-ACC-05, RETAKE_TEST_SLOW=1)', () => {
  let fixture: Fixture;
  let tmp: string;
  const savedHome = process.env.RETAKE_HOME;
  let rec: RunRecord;
  let tl: Timeline;
  const events: RunProgress[] = [];

  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'studio-catalogue-'));
    process.env.RETAKE_HOME = join(tmp, 'home'); // never the user's ~/.retake
    const mod = (await import(join(REPO, 'fixtures/wholesale/server.mjs'))) as {
      startFixture(o: { consolePort: number; shopPort: number; host?: string }): Promise<Fixture>;
    };
    fixture = await mod.startFixture({ consolePort: 0, shopPort: 0, host: '127.0.0.1' });
  });

  afterAll(async () => {
    await fixture?.close();
    if (savedHome === undefined) delete process.env.RETAKE_HOME;
    else process.env.RETAKE_HOME = savedHome;
    if (tmp) await rm(tmp, { recursive: true, force: true });
  });

  it('captures the committed scenario with its hooks: succeeded, valid files, the scenes and marks', async () => {
    const project: LoadedProject = await loadProject(join(REPO, 'projects/northfield-fixture'), REPO);
    // The local environment on the fixture's ports (its display URLs unchanged); the file is not touched.
    project.config.environments = { ...project.config.environments, local: { console: fixture.urls.console, shop: fixture.urls.shop } };
    const scenario = await loadScenario(project, 'catalogue');
    expect(scenario.issues.filter((i) => i.severity === 'error')).toEqual([]);
    rec = await runScenario({
      project,
      scenario,
      env: 'local',
      template: debugTemplate(),
      mode: 'capture',
      runsDir: join(tmp, 'runs'),
      onProgress: (e) => events.push(e),
    });
    expect(rec.error?.message ?? '').toBe('');
    expect(rec.status).toBe('succeeded');
    expect(rec.hooks).toEqual({ setup: 'ok', teardown: 'ok' });
    const record = RunRecordSchema.parse(JSON.parse(await readFile(join(rec.dir, 'run.json'), 'utf8')));
    expect(record).toMatchObject({ version: 1, status: 'succeeded', steps_done: rec.steps_total });
    tl = TimelineSchema.parse(JSON.parse(await readFile(rec.timeline!, 'utf8'))) as Timeline;
    expect(tl.scenes.map((s) => [s.id, s.status])).toEqual([
      ['import', 'ok'],
      ['availability', 'ok'],
      ['add-product', 'ok'],
    ]);
    expect(tl.events.filter((e) => e.step >= 0).every((e) => e.status === 'ok')).toBe(true);
    expect(tl.markers.map((m) => m.name)).toEqual(['import-done', 'reveal']);
    // Only the known dialog-close ripple stall may freeze the capture (R-ISS-12): never while the cursor moves.
    const rippleOnly = (w: string): boolean => w.startsWith('the capture froze') && !w.includes('cursor moving');
    expect(tl.warnings.filter((w) => !w.includes('captured below') && !rippleOnly(w))).toEqual([]);
  });

  it('the setup rollback ran after the teardown: the registry ref is back, nothing pending', async () => {
    const hooks = events.filter((e): e is Extract<RunProgress, { type: 'hook' }> => e.type === 'hook');
    const rollback = hooks.filter((e) => e.phase === 'rollback' && e.status !== 'start');
    expect(rollback.map((e) => [e.name, e.status])).toEqual([['free-registry-ref', 'ok']]);
    const lastTeardown = hooks.map((e) => e.phase).lastIndexOf('teardown');
    expect(lastTeardown).toBeGreaterThanOrEqual(0);
    expect(hooks.indexOf(rollback[0])).toBeGreaterThan(lastTeardown);
    const journal = JSON.parse(await readFile(join(rec.dir, 'hooks-journal.json'), 'utf8')) as {
      entries: Array<{ name?: string; status: string; rollback?: unknown }>;
    };
    expect(journal.entries.filter((x) => x.status === 'ok' && x.rollback)).toEqual([]); // nothing pending
    expect(journal.entries.filter((x) => x.status === 'rolled_back').map((x) => x.name)).toEqual(['free-registry-ref']);
    expect(fixture.store.products.find((p) => p.slug === 'finca-quenaro')?.registry_refs.length).toBeGreaterThan(0);
  });

  it('the run folder holds the capture, its frame index, the timeline, the record (with what the take cost), the log, the journal and the scenario', async () => {
    const files = await readdir(rec.dir);
    for (const f of ['capture.mp4', 'frames.jsonl', 'timeline.json', 'run.json', 'log.jsonl', 'hooks-journal.json', 'scenario.yaml']) {
      expect(files, f).toContain(f);
    }
    // L5.7: capture.mp4 was encoded during the take; no frame is kept by default.
    expect(files).not.toContain('frames');
    expect(rec.perf).toMatchObject({ frame_rate_limit: true, disk: { frames_kept: false } });
    expect(rec.perf!.cpu!.cores).toBeGreaterThan(0);
    const log = (await readFile(join(rec.dir, 'log.jsonl'), 'utf8')).trim().split('\n');
    expect(JSON.parse(log.at(-1)!)).toMatchObject({ type: 'run_end' });
  });

  it('scrolls for the durations the scenario sets (1.5 s, 2.2 s), down the page', () => {
    const scrolls = tl.events.filter((e) => e.action === 'scroll');
    expect(scrolls.map((e) => e.scene)).toEqual(['availability', 'add-product']);
    scrolls.forEach((e, i) => {
      const want = [1.5, 2.2][i];
      // The step is the eased scroll, then the wait for the capture to show it (awaitFreshFrame: at most 0.9 s, when
      // the screencast stalls after a scroll on the Mac).
      expect(e.t_end - e.t_start, `${e.scene}.${e.step}`).toBeGreaterThanOrEqual(want - 0.02);
      expect(e.t_end - e.t_start, `${e.scene}.${e.step}`).toBeLessThan(want + 1);
      const d = e.data as { from: number; to: number };
      expect(d.to, `${e.scene}.${e.step}`).toBeGreaterThan(d.from);
    });
    console.info(`catalogue scrolls: ${scrolls.map((e) => `${(e.t_end - e.t_start).toFixed(2)} s`).join(', ')}`);
  });

  it('1920×1080 at 30 fps: every frame, the video, a duration in range that matches the timeline', async () => {
    expect(tl.capture).toMatchObject({ file: 'capture.mp4', width: W, height: H, fps: 30 });
    expect(tl.capture.frames).toBeGreaterThan(1000);
    const { stdout } = await execFileP('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', rec.capture!]);
    expect(stdout.trim()).toBe(`${W},${H}`);
    // About 64 s on the Mac (L1.3); the range catches a stuck wait or a skipped scene, not pacing tweaks.
    expect(tl.capture.duration).toBeGreaterThan(55);
    expect(tl.capture.duration).toBeLessThan(80);
    expect(Math.abs((await ffprobeDuration(rec.capture!)) - tl.capture.duration)).toBeLessThanOrEqual(0.2);
  });

  it('the drawn hotspot is within 3 px of every click point and inside its target', async () => {
    const clicks = clicksOf(tl);
    // New import, the select (trigger + option), the drop zone, Start import, two menus (trigger, item, confirm), three
    // picks (trigger, option), Save, Add a coffee, the search field, the registry result.
    expect(clicks.length).toBeGreaterThanOrEqual(20);
    let worst = 0;
    for (const c of clicks) {
      const where = `${c.where} @${c.t.toFixed(3)}`;
      const m = magentaCentroid(await frameAt(rec.capture!, c.t, W, H), W, H);
      expect(m, where).not.toBeNull();
      const d = Math.hypot(m!.x - c.point.x, m!.y - c.point.y);
      worst = Math.max(worst, d);
      expect(d, where).toBeLessThanOrEqual(3);
      expect(m!.x, where).toBeGreaterThanOrEqual(c.bbox.x);
      expect(m!.x, where).toBeLessThanOrEqual(c.bbox.x + c.bbox.w);
      expect(m!.y, where).toBeGreaterThanOrEqual(c.bbox.y);
      expect(m!.y, where).toBeLessThanOrEqual(c.bbox.y + c.bbox.h);
    }
    console.info(`catalogue: ${tl.capture.duration.toFixed(1)} s, ${tl.capture.frames} frames, ${clicks.length} clicks, hotspot ≤ ${worst.toFixed(2)} px from the click point`);
  });

  it('the clicks that open a popup record popup_opened', () => {
    const step = (scene: string, action: string, n = 0): TimelineEvent => tl.events.filter((e) => e.scene === scene && e.action === action)[n];
    const trigger = (e: TimelineEvent) => (e.data as { clicks: Array<{ role: string; popup_opened: boolean }> }).clicks.find((c) => c.role === 'trigger');
    expect(step('import', 'click').popup_opened).toBe(true); // New import opens its dialog
    expect(trigger(step('import', 'select'))?.popup_opened).toBe(true);
    for (const n of [0, 1]) expect(trigger(step('availability', 'menu', n))?.popup_opened, `menu ${n}`).toBe(true);
    for (const n of [0, 1, 2]) expect(trigger(step('availability', 'pick', n))?.popup_opened, `pick ${n}`).toBe(true);
  });

  it('has no hesitation (< 80 ms) between steps, the scene opening still included', () => {
    for (const scene of tl.scenes) {
      const steps = tl.events.filter((e) => e.scene === scene.id && e.step >= 0).sort((a, b) => a.t_start - b.t_start);
      const still = tl.events.find((e) => e.scene === scene.id && e.action === 'scene_still')!;
      expect(steps[0].t_start - still.t_end, `${scene.id}: still → first step`).toBeLessThan(0.08);
      for (let i = 1; i < steps.length; i++) {
        const prev = steps[i - 1];
        expect(steps[i].t_start - (prev.hold?.t_end ?? prev.t_end), `${scene.id}: ${prev.step} → ${steps[i].step}`).toBeLessThan(0.08);
      }
    }
  });
});
