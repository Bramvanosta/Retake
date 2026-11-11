/**
 * Hotfix v0.2.6 — the loading indicators a take records (LoadingWatch → timeline.loading_ui): skeletons, shimmers,
 * spinners and aria-busy regions in the viewport, as spans of capture time; nothing for a loaded page, for an indicator
 * scrolled out of view or hidden.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser } from 'playwright-core';
import { chromium } from 'playwright-core';
import { LoadingSpans, LoadingWatch } from '../src/loading-watch.js';
import { PERSON_POLICY } from '@retake/core';
import { launchTarget } from '../src/index.js';

let browser: Browser;
beforeAll(async () => {
  const t = launchTarget({}, { headless: true, policy: PERSON_POLICY });
  browser = await chromium.launch({ headless: true, executablePath: t.executablePath, channel: t.channel });
});
afterAll(async () => {
  await browser?.close();
});

describe('loading indicators in the filmed page (hotfix v0.2.6)', () => {
  it('spans: one per indicator shown, closed when it goes or changes', () => {
    const s = new LoadingSpans();
    s.note(0, null);
    s.note(0.25, 'skeleton ×3');
    s.note(0.5, 'skeleton ×3');
    s.note(0.75, 'spinner');
    s.note(1, null);
    s.note(1.25, 'busy');
    s.close(1.5);
    expect(s.spans).toEqual([
      { t_start: 0.25, t_end: 0.75, what: 'skeleton ×3' },
      { t_start: 0.75, t_end: 1, what: 'spinner' },
      { t_start: 1.25, t_end: 1.5, what: 'busy' },
    ]);
  });

  it('a skeleton in view is recorded until the content replaces it; one below the fold or hidden is not', async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    try {
      await page.setContent(`<style>.skeleton-card{height:120px;margin:8px;background:#eee}</style>
        <main id="m"><div class="skeleton-card"></div><div class="skeleton-card"></div><div class="skeleton-card"></div></main>
        <div class="skeleton-row" style="position:absolute;top:3000px;height:200px;width:800px"></div>
        <div class="loading-shimmer" style="visibility:hidden;height:200px;width:800px"></div>`);
      const t0 = Date.now();
      const w = new LoadingWatch(() => page, () => (Date.now() - t0) / 1000);
      w.start();
      await page.waitForTimeout(900);
      await page.evaluate(() => (document.getElementById('m')!.innerHTML = '<h1>Catalogue</h1><p>42 films</p>'));
      await page.waitForTimeout(700);
      const spans = w.stop();
      expect(spans).toHaveLength(1);
      expect(spans[0].what).toBe('skeleton ×3');
      expect(spans[0].t_end - spans[0].t_start).toBeGreaterThan(0.4);
      expect(spans[0].t_end).toBeLessThan(1.6);
    } finally {
      await page.close();
    }
  });
});
