/**
 * L4.9 part C (R-UI-03): the screen tour, part 1 — the project and scenario screens in headless Chromium against a real
 * Studio server (a11y-tour.ts: the fixture project, the synthetic bits take with a thread and Claude's proposal), each
 * state checked once nothing is loading by the in-repo checker (a11y.ts) at 1280 and 1440 wide — contrast (over media
 * too), names, reachable roles, colour never alone, a selected state more than colour, headings, no sideways scroll —
 * and its Tab walk at 1280 (a real indicator on every stop): projects; a project (its Sessions panel loaded, its rows);
 * the README's 409 conflict; blocks with a step selected (the arrows cross the scenes' step lists); YAML; a YAML file
 * that does not parse; the run preflight; a failed dry run; the capture's sessions confirmation (a native modal dialog,
 * walked inside: focus moves in, Escape closes it, focus returns); blocks of a take with its inspector; the timeline with a segment selected;
 * Comments (a list, a thread with Claude's proposal and its diff, none yet); the timeline previewing the proposal
 * (switches greyed). Each must have no finding (the report printed otherwise). No CSP violation, no console error.
 * Part 2 (library, themes, Record, the keyboard path) is studio-e2e-a11y-keyboard.test.ts.
 * `DEMO_STUDIO_UI_SHOTS=<folder>` saves full-page screenshots of every state at both widths.
 */
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hasTool } from '../../editor/test/render-helpers.js';
import { dialogCheck } from './a11y.js';
import { N, POLL, RUN, THREAD, go, startTour, station } from './a11y-tour.js';
import type { Tour } from './a11y-tour.js';

const canRun = hasTool('ffmpeg') && hasTool('ffprobe');
let t: Tour;

beforeAll(async () => {
  if (!canRun) return;
  t = await startTour({ prefix: 'ds-e2e-a11y-' });
}, 240_000);

afterAll(async () => {
  await t?.close();
});

const at = (hash: string) => `${t.studio.url}#${hash}`;

describe.skipIf(!canRun)('the screen tour, part 1: projects and scenarios (L4.9 part C)', () => {
  it('projects, a project with its Sessions panel, the README\'s conflict panel', async () => {
    const { page } = t;
    let r = await station(t, 'projects', () => go(page, at('/'), 'h1:text("Projects")'));
    expect(r.findings, r.report).toEqual([]);
    r = await station(t, 'project', () => go(page, at(`/p/${N}`), '[data-testid="sessions-panel"] [data-testid="session-row"]'));
    expect(r.findings, r.report).toEqual([]);
    r = await station(t, 'readme-conflict', async () => {
      await go(page, at(`/p/${N}/readme`), 'main textarea');
      await page.locator('main textarea').first().fill('# Mine\n\nMy version.\n');
      await writeFile(join(t.ws, 'projects', N, 'README.md'), '# Theirs\n\nWritten meanwhile.\n');
      await page.getByRole('alert').filter({ hasText: 'README.md changed on disk' }).waitFor(POLL);
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await page.getByTestId('conflict').waitFor(POLL);
    });
    expect(r.findings, r.report).toEqual([]);
  }, 180_000);

  it('blocks with a step selected, YAML, a YAML file that does not parse', async () => {
    const { page } = t;
    let r = await station(t, 'blocks', async () => {
      await go(page, at(`/p/${N}/s/quote`), '[data-testid="step"]');
      await page.locator('[data-testid="step"]').nth(1).click();
      await page.getByTestId('inspector').waitFor(POLL);
    });
    expect(r.findings, r.report).toEqual([]);
    r = await station(t, 'yaml', () => go(page, at(`/p/${N}/s/quote/yaml`), '[data-testid="yaml"]'));
    expect(r.findings, r.report).toEqual([]);
    r = await station(t, 'yaml-error', () => go(page, at('/p/demo/s/broken/yaml'), 'main :text("YAML: Flow sequence")'));
    expect(r.findings, r.report).toEqual([]);
  }, 180_000);

  it('the run preflight, a failed dry run, the sessions confirmation (a dialog: focus in, Escape, focus back)', async () => {
    const { page } = t;
    let r = await station(t, 'run-preflight', () => go(page, at(`/p/${N}/s/quote/run`), '[data-testid="start-capture"]'));
    expect(r.findings, r.report).toEqual([]);
    r = await station(t, 'run-failed', () => go(page, at(`/p/${N}/s/quote/run/20261017-120000-quote`), '[data-testid="run-outcome"]'));
    expect(r.findings, r.report).toEqual([]);
    r = await station(
      t,
      'confirm-sessions',
      async () => {
        await go(page, at('/p/board/s/members/run'), '[data-testid="preflight-sessions"]');
        await expect.poll(() => page.getByTestId('preflight-sessions').innerText(), POLL).toContain('never signed in');
        await page.getByTestId('start-capture').click();
        await page.getByTestId('confirm-sessions').waitFor(POLL);
      },
    );
    expect(r.findings, r.report).toEqual([]);
    expect(r.result.walk!.stops).toBeGreaterThanOrEqual(2);
    await page.keyboard.press('Escape');
    await page.getByTestId('confirm-sessions').waitFor({ state: 'detached' });
    expect(await dialogCheck(page, page.getByTestId('start-capture'), () => page.keyboard.press('Enter'))).toEqual([]);
  }, 180_000);

  it('blocks of a take with its inspector, the timeline with a segment selected', async () => {
    const { page } = t;
    let r = await station(t, 'blocks-take', async () => {
      await go(page, at('/p/demo/s/bits'), '[data-testid="step"]');
      await page.locator('[data-testid="step"]').first().click();
      await page.getByTestId('inspector').waitFor(POLL);
    });
    expect(r.findings, r.report).toEqual([]);
    r = await station(t, 'timeline', async () => {
      await go(page, at(`/p/demo/s/bits/timeline/${RUN}`), '[data-testid="tracks"]');
      await page.locator('[data-testid="tl-segment"][data-id="a"]').click();
      await page.locator('[data-testid="switch"]').first().waitFor(POLL);
    });
    expect(r.findings, r.report).toEqual([]);
  }, 180_000);

  it('Comments: the list, a thread with Claude\'s proposal (its diff), none yet; the timeline previewing the proposal', async () => {
    const { page } = t;
    let r = await station(t, 'comments', () => go(page, at('/p/demo/s/bits/comments'), '[data-testid="viewer"][data-shown]'));
    expect(r.findings, r.report).toEqual([]);
    r = await station(t, 'thread-proposal', async () => {
      await go(page, at(`/p/demo/s/bits/comments/${THREAD}`), '[data-testid="proposal"] [data-testid="diff-row"]');
      await page.getByTestId('viewer-region').waitFor(POLL);
      expect(await page.locator('[data-testid="proposal"] .pd-mark').count()).toBeGreaterThan(0);
    });
    expect(r.findings, r.report).toEqual([]);
    r = await station(t, 'comments-none', () => go(page, at(`/p/${N}/s/quote/comments`), '[data-testid="no-render"]'));
    expect(r.findings, r.report).toEqual([]);
    r = await station(t, 'timeline-preview-change', async () => {
      await go(page, at(`/p/demo/s/bits/proposal/${THREAD}/${t.entry}`), '[data-testid="proposal-banner"]');
      await page.locator('[data-testid="tl-segment"][data-id="a"]').click();
      await page.locator('[data-testid="inspector"] [role="radiogroup"][aria-disabled="true"]').first().waitFor(POLL);
    }, { exemptMax: 45 });
    expect(r.findings, r.report).toEqual([]);
    expect(await page.evaluate(() => (window as unknown as { __csp: number }).__csp)).toBe(0);
    expect(t.consoleErrors).toEqual([]);
  }, 180_000);
});
