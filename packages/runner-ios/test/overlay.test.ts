/**
 * The touch overlay's pictures (src/overlay.ts): one PNG per distinct picture — the same marks again (a second tap at
 * the same place, its disc held) reuse the picture already written; the list still names a picture for every change.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { overlayPlan, writeOverlay } from '../src/overlay.js';
import { DEFAULT_RIPPLE } from '../src/touch-look.js';
import type { Touch } from '../src/touch-track.js';

const dir = mkdtempSync(join(tmpdir(), 'retake-overlay-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const tap = (t: number): Touch => ({ t_down: t, t_up: t + 0.075, path: [{ t, x: 20, y: 40 }], how: 'video' });

describe('the overlay pictures', () => {
  it('two taps at the same place, a whole number of frames apart: their pictures written once', async () => {
    const touches = [tap(1.0), tap(2.0)];
    const plan = overlayPlan(touches, 90, 30);
    const keys = new Set(plan.map((p) => p.key).filter(Boolean));
    const o = await writeOverlay({ touches, frames: 90, fps: 30, screen: { width: 40, height: 80, scale: 3 }, ripple: DEFAULT_RIPPLE, dir });
    const pngs = readdirSync(dir).filter((f) => f.startsWith('touch-'));
    expect(pngs.length).toBe(keys.size);
    expect(plan.filter((p) => p.key).length).toBe(2 * keys.size);
    const list = readFileSync(o.list, 'utf8');
    expect(list.match(/^file /gm)?.length).toBeGreaterThanOrEqual(plan.length);
  });
});
