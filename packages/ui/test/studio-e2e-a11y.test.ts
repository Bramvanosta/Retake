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
 * (switches greyed); L5.9 (review A-L2): the steps while a write is in flight (held, audited busy). Each must have no
 * finding (the report printed otherwise). No CSP violation, no console error.
 * Part 2 (library, themes, Record, the keyboard path) is studio-e2e-a11y-keyboard.test.ts.
 * L5.9: every state in dark (the default, following the system) at 1280 and 1440, and in light at 1280; ⚑ the UI gallery
 * (every component of the design system, both appearances side by side) in dark and light at both widths, and its
 * sheet (a modal alertdialog walked inside: focus in, Escape, focus back), menu (a popover: items named and reached)
 * and command palette (a modal dialog walked inside; its options reached through the combobox) open in each scope.
 * `DEMO_STUDIO_UI_SHOTS=<folder>` saves screenshots of every state (the viewport: the shell's panes scroll themselves).
 */
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import type { Route } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hasTool } from '../../editor/test/render-helpers.js';
import { dialogCheck } from './a11y.js';
import { N, POLL, RUN, THREAD, WIDTHS, go, startTour, station } from './a11y-tour.js';
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
    // L5.10a: Welcome; the Project screen with nothing selected (the project inspector), a production selected, a
    // smart group, a location in the inspector; the Cast (the Sessions panel).
    let r = await station(t, 'welcome', () => go(page, at('/'), 'h2:text("Projects")'));
    expect(r.findings, r.report).toEqual([]);
    r = await station(t, 'productions', () => go(page, at('/p/demo'), '[role="option"] [data-testid="thumb"][data-state="ok"]'));
    expect(r.findings, r.report).toEqual([]);
    r = await station(t, 'production-selected', async () => {
      await go(page, at('/p/demo'), '[role="option"][data-id="bits"]');
      await page.locator('[role="option"][data-id="bits"]').click();
      await page.getByTestId('scenario-link').waitFor(POLL);
    });
    expect(r.findings, r.report).toEqual([]);
    // L5.10a fixes (review B-M2): the desktop app's narrowest window, 900 px — the posters reflow beside the inspector.
    r = await station(
      t,
      'production-selected-900',
      async () => {
        await go(page, at('/p/demo'), '[role="option"][data-id="bits"]');
        await page.locator('[role="option"][data-id="bits"]').click();
        await page.getByTestId('scenario-link').waitFor(POLL);
      },
      { schemes: [{ scheme: 'dark', widths: [900] }, { scheme: 'light', widths: [900] }] },
    );
    expect(r.findings, r.report).toEqual([]);
    r = await station(t, 'group', () => go(page, at(`/p/${N}/g/shoot`), '[role="option"]'));
    expect(r.findings, r.report).toEqual([]);
    r = await station(t, 'location', () => go(page, at(`/p/${N}/loc/local`), '[data-testid="location-pages"]'));
    expect(r.findings, r.report).toEqual([]);
    r = await station(t, 'project', () => go(page, at(`/p/${N}/cast`), '[data-testid="sessions-panel"] [data-testid="session-row"]'));
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

  it('⚑ L5.9 (review A-L2): the steps while a write is in flight — the text keeps its contrast (a dashed edge, no fade)', async () => {
    const { page } = t;
    // The write is held until the audits are done (then it goes through: the step moves back on the next station's reload).
    await go(page, at(`/p/${N}/s/quote`), '[data-testid="step"]');
    // A step's words without its number (the numbers follow the order).
    const unnumbered = (text: string) => text.split('\n').filter((l) => !/^\d+$/.test(l.trim())).join('|');
    const before = (await page.locator('[data-testid="step"]').allInnerTexts()).map(unnumbered);
    let release: () => void = () => undefined;
    const held = new Promise<void>((r) => (release = r));
    let passed: Promise<void> = Promise.resolve();
    const hold = (route: Route) => {
      passed = held.then(() => route.continue());
      return passed;
    };
    await page.route('**/v1/call/scenario_edit', hold);
    try {
      const r = await station(
        t,
        'blocks-in-flight',
        async () => {
          await go(page, at(`/p/${N}/s/quote`), '[data-testid="step"]');
          await page.locator('[data-testid="step"]').nth(1).click();
          await page.getByTestId('inspector').waitFor(POLL);
          await page.keyboard.press('Alt+ArrowDown');
          await page.locator('[data-testid="blocks"][aria-busy="true"]').waitFor(POLL);
        },
        // Every control is off while the write is in flight (that is the state): their texts are exempt.
        { busy: '[data-testid="blocks"]', walk: false, exemptMax: 40 },
      );
      expect(r.findings, r.report).toEqual([]);
      expect(await page.locator('[data-testid="step"]').first().evaluate((el) => [getComputedStyle(el).borderTopStyle, getComputedStyle(el.closest('.steps')!).opacity])).toEqual(['dashed', '1']);
    } finally {
      release();
      await passed;
      await page.unroute('**/v1/call/scenario_edit', hold);
    }
    // The step moved; moved back where it was (the next stations read the scenario as written).
    const order = async () => (await page.locator('[data-testid="step"]').allInnerTexts()).map(unnumbered);
    await expect.poll(async () => (await order())[2] === before[1], POLL).toBe(true);
    await expect.poll(() => page.locator('[data-testid="blocks"]').getAttribute('aria-busy'), POLL).toBe('false');
    await page.keyboard.press('Alt+ArrowUp');
    await expect.poll(order, POLL).toEqual(before);
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

  it('⚑ L5.9: the UI gallery in dark and light at both widths; its sheet, menu and palette open in each scope', async () => {
    const { page } = t;
    const both = [
      { scheme: 'dark' as const, widths: WIDTHS },
      { scheme: 'light' as const, widths: WIDTHS },
    ];
    let r = await station(t, 'gallery', () => go(page, at('/ui'), '[data-testid="gallery"]'), { schemes: both, exemptMax: 24 });
    expect(r.findings, r.report).toEqual([]);
    expect(r.result.audits[1280].stats.texts).toBeGreaterThan(150);
    expect(r.result.walk!.stops).toBeGreaterThan(80);
    for (const scope of ['dark', 'light'] as const) {
      const col = page.getByTestId(`scope-${scope}`);
      r = await station(t, `gallery-sheet-${scope}`, async () => {
        await col.getByRole('button', { name: 'Discard the take…' }).click();
        await page.locator('dialog.k-sheet[open]').waitFor(POLL);
      }, { schemes: both, exemptMax: 24 });
      expect(r.findings, r.report).toEqual([]);
      expect(r.result.walk!.stops).toBe(2);
      await page.keyboard.press('Escape');
      await page.locator('dialog.k-sheet[open]').waitFor({ state: 'detached' });
      expect(await dialogCheck(page, col.getByRole('button', { name: 'Discard the take…' }), () => page.keyboard.press('Enter'))).toEqual([]);
      r = await station(t, `gallery-menu-${scope}`, async () => {
        await col.getByRole('button', { name: 'Take', exact: true }).click();
        await col.getByRole('menuitem', { name: 'Duplicate' }).waitFor(POLL);
      }, { schemes: both, walk: false, exemptMax: 24 });
      expect(r.findings, r.report).toEqual([]);
      await page.keyboard.press('Escape');
      r = await station(t, `gallery-palette-${scope}`, async () => {
        await col.getByRole('button', { name: 'Open the palette' }).click();
        await page.locator('dialog.k-palette[open]').waitFor(POLL);
      }, { schemes: both, exemptMax: 24 });
      expect(r.findings, r.report).toEqual([]);
      expect(r.result.walk!.stops).toBe(1);
      await page.keyboard.press('Escape');
      await page.locator('dialog.k-palette[open]').waitFor({ state: 'detached' });
    }
    expect(await page.evaluate(() => (window as unknown as { __csp: number }).__csp)).toBe(0);
    expect(t.consoleErrors).toEqual([]);
  }, 240_000);
});
