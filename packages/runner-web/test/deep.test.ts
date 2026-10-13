import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rm } from 'node:fs/promises';
import type { Timeline, TimelineEvent } from '@demo-studio/core';
import { runScenario } from '../src/index.js';
import { FRAME_PAGE, deepPage } from './pages.js';
import { FAST, debugTemplate, frameAt, magentaCentroid, makeProject, makeScenario, readTimeline, startServer, tempDir } from './helpers.js';
import type { TestServer } from './helpers.js';

/**
 * R-ISS-07: a real capture through open shadow roots and same-origin frames — the drawn cursor lands on targets
 * inside web components and iframes, presses ripple there, a native <select> and typing work inside a frame, a frame
 * scrolls inside itself and the page scrolls to a frame below the fold.
 */
const W = 1280;
const H = 800;

let server: TestServer;
let cross: TestServer;
let dir: string;

beforeAll(async () => {
  cross = await startServer({ '/frame.html': FRAME_PAGE });
  server = await startServer({ '/deep.html': deepPage(cross.url), '/frame.html': FRAME_PAGE });
  dir = await tempDir('rw-deep-');
});

afterAll(async () => {
  await server?.close();
  await cross?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe('capture through web components and iframes (R-ISS-07)', () => {
  let tl: Timeline;
  let capture: string;
  let warnings: string[];

  it('runs a scenario whose targets live in shadow roots and frames', async () => {
    const project = makeProject(dir, { app: server.url }, { width: W, height: H });
    const rec = await runScenario({
      project,
      template: debugTemplate(),
      mode: 'capture',
      runId: 'deep',
      scenario: makeScenario('deep', {
        pacing: { ...FAST, hover_ms: 150, nudge_hover_ms: 120 },
        scenes: [
          {
            id: 'deep',
            open: '/deep.html',
            steps: [
              { click: 'Add bag' },
              { assert: { text: '4 bags' } },
              { type: { into: { label: 'Note' }, text: 'Washed' } },
              { select: { field: 'Destination', option: 'Norway' } },
              { assert: { text: 'dest=Norway' } },
              { type: { into: { label: 'Bags' }, text: '12', clear: true } },
              { click: 'Estimate' },
              { assert: { text: '12 bags to Norway' } },
              { click: 'Far in frame' },
              { click: 'Nested frame button' },
              { click: 'Embedded' },
              { hover: { text: 'Low button', ms: 300 } },
            ],
          },
        ],
      }),
    });
    expect(rec.error?.message).toBeUndefined();
    expect(rec.status).toBe('succeeded');
    tl = await readTimeline(rec.timeline!);
    capture = rec.capture!;
    warnings = tl.warnings;
  });

  it('every step succeeded, nothing was covered, the native <select> in the frame was set in place', () => {
    const steps = tl.events.filter((e) => e.step >= 0);
    expect(steps.length).toBe(12);
    for (const e of steps) expect(e.status, `${e.step} ${e.action}`).toBe('ok');
    expect(warnings.filter((w) => w.includes('covered by'))).toEqual([]);
    expect(steps.find((e) => e.action === 'select')?.strategy).toBe('native');
    // A freeze during a click ripple only is the known stall with the frame rate limiter on (R-ISS-12); low capture
    // rates depend on the machine's load.
    const rippleOnly = (w: string): boolean => w.startsWith('the capture froze') && !w.includes('cursor moving');
    expect(warnings.filter((w) => !w.includes('captured below') && !rippleOnly(w))).toEqual([]);
  });

  it('the drawn hotspot is within 3 px of every click point and inside the target', async () => {
    const clicks = tl.events.filter((e) => e.t_click !== undefined && e.point && e.target?.bbox && e.action !== 'hover');
    expect(clicks.length).toBeGreaterThanOrEqual(8);
    for (const e of clicks) {
      const rgb = await frameAt(capture, e.t_click!, W, H);
      const c = magentaCentroid(rgb, W, H);
      const where = `${e.step} ${e.action} ${e.target!.desc} @${e.t_click}`;
      expect(c, where).not.toBeNull();
      expect(Math.hypot(c!.x - e.point!.x, c!.y - e.point!.y), where).toBeLessThanOrEqual(3);
      const b = e.target!.bbox!;
      expect(c!.x, where).toBeGreaterThanOrEqual(b.x);
      expect(c!.x, where).toBeLessThanOrEqual(b.x + b.w);
      expect(c!.y, where).toBeGreaterThanOrEqual(b.y);
      expect(c!.y, where).toBeLessThanOrEqual(b.y + b.h);
    }
  });

  it('every click ripples at its point; the hand icon shows over a shadow button and over a button in a frame', () => {
    const effects = tl.cursor_effects ?? [];
    const byDesc = (s: string): TimelineEvent => tl.events.find((e) => e.step >= 0 && e.action === 'click' && e.target?.desc.includes(s))!;
    for (const e of tl.events.filter((x) => x.action === 'click')) {
      const rp = effects.find((f) => f.type === 'ripple' && f.t >= e.t_click! - 0.05 && f.t <= e.t_click! + 0.25);
      expect(rp, `${e.step} ${e.target?.desc}`).toBeDefined();
      expect(Math.hypot(rp!.x! - e.point!.x, rp!.y! - e.point!.y), `${e.step} ${e.target?.desc}`).toBeLessThanOrEqual(2);
    }
    // The icon shown when the button is pressed (icon changes are reported when they happen).
    for (const desc of ['Add bag', 'Estimate', 'Embedded']) {
      const e = byDesc(desc);
      const shown = effects.filter((f) => f.type === 'icon' && f.t <= e.t_click!).pop();
      expect(shown?.icon, `${desc} ${JSON.stringify(effects.filter((f) => f.t >= e.t_start - 0.5 && f.t <= e.t_click! + 0.3))}`).toBe('hand');
    }
    // Frame targets are reported in page px, inside the frame's content box (420 + 6 px border + 10 px padding).
    const est = byDesc('Estimate').target!.bbox!;
    expect(est.x).toBeGreaterThanOrEqual(436);
    expect(est.x + est.w).toBeLessThanOrEqual(436 + 360);
  });
});
