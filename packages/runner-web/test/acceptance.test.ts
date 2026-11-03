import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { RunRecordSchema, TimelineSchema } from '@retake/core';
import type { Timeline } from '@retake/core';
import { runScenario } from '../src/index.js';
import { ACCEPT_PAGE } from './pages.js';
import { debugTemplate, ffprobeDuration, frameAt, jpegSize, magentaCentroid, makeProject, makeScenario, readTimeline, startServer, tempDir } from './helpers.js';
import type { TestServer } from './helpers.js';

const W = 1920;
const H = 1080;

let server: TestServer;
let dir: string;

beforeAll(async () => {
  server = await startServer({ '/console.html': ACCEPT_PAGE });
  dir = await tempDir('rw-accept-');
});

afterAll(async () => {
  await server?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe('acceptance: 1920×1080 capture with the debug cursor', () => {
  let tl: Timeline;
  let capture: string;
  let runDir: string;

  it('captures a multi-step scenario to capture.mp4 + timeline.json', async () => {
    const project = makeProject(dir, { console: server.url }, { width: W, height: H });
    const rec = await runScenario({
      project,
      template: debugTemplate(),
      mode: 'capture',
      runId: 'acceptance',
      scenario: makeScenario('acceptance', {
        // Field-tested default pacing, only the opening still is shortened.
        pacing: { scene_start_still: 0.8 },
        scenes: [
          {
            id: 'import',
            open: '/console.html',
            steps: [
              { click: 'New import' },
              { click: 'Choose an organisation' },
              { click: { role: 'option', name: 'Northfield Roasters' } },
              { type: { into: { label: 'Import name' }, text: 'Spring list', cps: 22 } },
              { click: { label: 'Notify buyers' } },
              { menu: { row: 'Iceland', item: 'Pause' }, mark: 'pause' },
              { click: 'Save changes', hold: 0.6 },
            ],
          },
        ],
      }),
    });
    expect(rec.error?.message).toBeUndefined();
    expect(rec.status).toBe('succeeded');
    expect(() => RunRecordSchema.parse(rec)).not.toThrow();
    tl = await readTimeline(rec.timeline!);
    expect(() => TimelineSchema.parse(tl)).not.toThrow();
    capture = rec.capture!;
    runDir = rec.dir;
    expect(tl.capture).toMatchObject({ file: 'capture.mp4', width: W, height: H, fps: 30 });
    expect(tl.markers.map((m) => m.name)).toEqual(['pause']);
    expect(tl.cursor.length).toBeGreaterThan(100);
  });

  it('every captured frame has the full viewport size', async () => {
    const files = (await readdir(join(runDir, 'frames'))).filter((f) => f.endsWith('.jpg'));
    expect(files.length).toBeGreaterThan(100);
    for (const f of files) expect(jpegSize(await readFile(join(runDir, 'frames', f))), f).toEqual([W, H]);
  });

  it('video duration matches the timeline (±0.2 s)', async () => {
    const d = await ffprobeDuration(capture);
    expect(Math.abs(d - tl.capture.duration)).toBeLessThanOrEqual(0.2);
  });

  it('the drawn hotspot is within 3 px of every click point and inside the target', async () => {
    const clicks = tl.events.filter((e) => e.t_click !== undefined && e.point && e.target?.bbox);
    expect(clicks.length).toBeGreaterThanOrEqual(7);
    for (const e of clicks) {
      const rgb = await frameAt(capture, e.t_click!, W, H);
      const c = magentaCentroid(rgb, W, H);
      const where = `${e.scene}.${e.step} ${e.action} ${e.target!.desc} @${e.t_click}`;
      expect(c, where).not.toBeNull();
      expect(Math.hypot(c!.x - e.point!.x, c!.y - e.point!.y), where).toBeLessThanOrEqual(3);
      const b = e.target!.bbox!;
      expect(c!.x, where).toBeGreaterThanOrEqual(b.x);
      expect(c!.x, where).toBeLessThanOrEqual(b.x + b.w);
      expect(c!.y, where).toBeGreaterThanOrEqual(b.y);
      expect(c!.y, where).toBeLessThanOrEqual(b.y + b.h);
    }
  });

  it('popup-expecting clicks record popup_opened', () => {
    const org = tl.events.find((e) => e.action === 'click' && e.target?.desc.includes('Choose an organisation'));
    expect(org?.popup_opened).toBe(true);
    const menu = tl.events.find((e) => e.action === 'menu');
    expect(menu?.popup_opened).toBe(true);
  });

  it('has no hesitations between steps (< 80 ms)', () => {
    const steps = tl.events.filter((e) => e.step >= 0).sort((a, b) => a.t_start - b.t_start);
    const still = tl.events.find((e) => e.action === 'scene_still')!;
    expect(steps[0].t_start - still.t_end).toBeLessThan(0.08);
    for (let i = 1; i < steps.length; i++) {
      const prev = steps[i - 1];
      const end = prev.hold?.t_end ?? prev.t_end;
      expect(steps[i].t_start - end, `${prev.step} → ${steps[i].step}`).toBeLessThan(0.08);
    }
  });
});
