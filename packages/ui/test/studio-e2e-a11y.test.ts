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
 * L5.12d: the desktop app's quit sheet (unsaved text; jobs only) and the not-found screen, dark at 1280 / 1440 / 900 and
 * light at 1280.
 * `RETAKE_UI_SHOTS=<folder>` saves screenshots of every state (the viewport: the shell's panes scroll themselves).
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
      // L5.12b (M4): the README on the kit — dark at 1280, 1440 and 900, light at 1280.
    }, { schemes: [{ scheme: 'dark', widths: [1280, 1440, 900] }, { scheme: 'light', widths: [1280] }] });
    expect(r.findings, r.report).toEqual([]);
  }, 180_000);

  it('⚑ L5.9 (review A-L2): the steps while a write is in flight — the text keeps its contrast (a dashed edge, no fade)', async () => {
    const { page } = t;
    // The write is held until the audits are done (then it goes through: the step moves back on the next station's reload).
    await go(page, at(`/p/${N}/s/quote`), '[data-testid="step"]');
    // A step's words without its number (the numbers follow the order). L5.10b: each frame's title as text — a scene off
    // screen is not painted (content-visibility), its words are there all the same.
    const titles = () => page.locator('[data-testid="step"] .k-frame-title').allTextContents();
    const before = await titles();
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
      // L5.10b: the frames wait with a dashed edge, never a fade.
      expect(await page.locator('[data-testid="step"]').first().evaluate((el) => [getComputedStyle(el).outlineStyle, getComputedStyle(el.closest('.k-frames')!).opacity])).toEqual(['dashed', '1']);
    } finally {
      release();
      await passed;
      await page.unroute('**/v1/call/scenario_edit', hold);
    }
    // The step moved; moved back where it was (the next stations read the scenario as written).
    const order = titles;
    await expect.poll(async () => (await order())[2] === before[1], POLL).toBe(true);
    await expect.poll(() => page.locator('[data-testid="blocks"]').getAttribute('aria-busy'), POLL).toBe('false');
    await page.keyboard.press('Alt+ArrowUp');
    await expect.poll(order, POLL).toEqual(before);
  }, 180_000);

  // L5.10b: the board with a step selected (and at 900), a row card selected, YAML read and editing, a file that does
  // not parse on the board and in YAML (the title kept: the guard compares titles with HEAD).
  it('blocks with a step selected, YAML, a YAML file that does not parse', async () => {
    const { page } = t;
    const selectStep = async () => {
      await go(page, at(`/p/${N}/s/quote`), '[data-testid="step"]');
      await page.locator('[data-testid="step"]').nth(1).click();
      await page.getByTestId('inspector').waitFor(POLL);
      await page.getByTestId('inspector-step').waitFor(POLL);
    };
    let r = await station(t, 'blocks', selectStep);
    expect(r.findings, r.report).toEqual([]);
    // L5.10b: the desktop app's narrowest window — two frames a row, the title bar's Location without its label.
    r = await station(t, 'blocks-900', selectStep, { schemes: [{ scheme: 'dark', widths: [900] }, { scheme: 'light', widths: [900] }] });
    expect(r.findings, r.report).toEqual([]);
    r = await station(t, 'blocks-row-card', async () => {
      await go(page, at(`/p/${N}/s/quote`), '[data-testid="before-filming"]');
      await page.getByTestId('before-filming').click();
      await page.getByTestId('hooks').waitFor(POLL);
    });
    expect(r.findings, r.report).toEqual([]);
    r = await station(t, 'yaml', () => go(page, at(`/p/${N}/s/quote/yaml`), '[data-testid="yaml"]'));
    expect(r.findings, r.report).toEqual([]);
    r = await station(t, 'yaml-editing', async () => {
      await go(page, at(`/p/${N}/s/quote/yaml`), '[data-testid="yaml-edit"]');
      await page.getByTestId('yaml-edit').click();
      await page.getByTestId('yaml-editor').waitFor(POLL);
    });
    expect(r.findings, r.report).toEqual([]);
    await page.getByRole('button', { name: 'Close the editor' }).click();
    r = await station(t, 'blocks-invalid', () => go(page, at('/p/demo/s/broken'), '[data-testid="invalid-yaml"]'));
    expect(r.findings, r.report).toEqual([]);
    r = await station(t, 'yaml-error', () => go(page, at('/p/demo/s/broken/yaml'), 'main :text("YAML: Flow sequence")'));
    expect(r.findings, r.report).toEqual([]);
  }, 240_000);

  it('the run preflight, a failed dry run, the sessions confirmation (a dialog: focus in, Escape, focus back)', async () => {
    const { page } = t;
    let r = await station(t, 'run-preflight', () => go(page, at(`/p/${N}/s/quote/run`), '[data-testid="start-capture"]'));
    expect(r.findings, r.report).toEqual([]);
    r = await station(t, 'run-failed', () => go(page, at(`/p/${N}/s/quote/run/20261017-120000-quote`), '[data-testid="run-outcome"]'));
    expect(r.findings, r.report).toEqual([]);
    // L5.11a: Prepare with nothing blocking (its Start buttons enabled), the status bar's actions with a blocker line —
    // at 900 too (the overflow rule: nothing scrolls sideways), and in the light appearance.
    r = await station(t, 'run-preflight-ready', () => go(page, at('/p/demo/s/bits/run'), '[data-testid="start-dry"]'));
    expect(r.findings, r.report).toEqual([]);
    r = await station(t, 'status-actions', () => go(page, at(`/p/${N}/s/quote`), '[data-testid="blockers-capture"]'), { schemes: [{ scheme: 'dark', widths: [900, 1280, 1440] }, { scheme: 'light', widths: [900, 1280] }] });
    expect(r.findings, r.report).toEqual([]);
    r = await station(
      t,
      'confirm-sessions',
      async () => {
        await go(page, at('/p/board/s/members/run'), '[data-testid="preflight-sessions"]');
        await expect.poll(() => page.getByTestId('preflight-sessions').innerText(), POLL).toContain('Missing session');
        await page.getByTestId('start-capture').click();
        await page.getByTestId('confirm-sessions').waitFor(POLL);
      },
    );
    expect(r.findings, r.report).toEqual([]);
    expect(r.result.walk!.stops).toBeGreaterThanOrEqual(2);
    await page.keyboard.press('Escape');
    // L5.11a: the shell's one sheet stays in the document, closed.
    await page.getByTestId('confirm-sessions').waitFor({ state: 'hidden' });
    expect(await dialogCheck(page, page.getByTestId('start-capture'), () => page.keyboard.press('Enter'))).toEqual([]);
  }, 180_000);

  it('blocks of a take with its inspector, Edit with a segment selected, the Review report with a check selected', async () => {
    const { page } = t;
    let r = await station(t, 'blocks-take', async () => {
      await go(page, at('/p/demo/s/bits'), '[data-testid="step"]');
      await page.locator('[data-testid="step"]').first().click();
      await page.getByTestId('inspector').waitFor(POLL);
    });
    expect(r.findings, r.report).toEqual([]);
    // L5.12a (M4): Edit with a segment selected — dark at 1280, 1440 and 900, light at 1280.
    r = await station(
      t,
      'timeline',
      async () => {
        await go(page, at(`/p/demo/s/bits/timeline/${RUN}`), '[data-testid="tracks"]');
        await page.locator('[data-testid="tl-segment"][data-id="a"]').click();
        await page.locator('[data-testid="switch"]').first().waitFor(POLL);
      },
      { schemes: [{ scheme: 'dark', widths: [1280, 1440, 900] }, { scheme: 'light', widths: [1280] }] },
    );
    expect(r.findings, r.report).toEqual([]);
    // L5.12a (M4): the Review report with a check selected (its frame in the inspector) — the same widths.
    r = await station(
      t,
      'review-report',
      async () => {
        await go(page, at('/p/demo/s/bits/review'), '[data-testid="review-sheet"][data-state="ok"]');
        await page.getByRole('listbox').focus();
        await page.keyboard.press('ArrowDown');
        await page.locator('[data-testid="review-frame"][data-state="ok"]').waitFor(POLL);
      },
      { schemes: [{ scheme: 'dark', widths: [1280, 1440, 900] }, { scheme: 'light', widths: [1280] }] },
    );
    expect(r.findings, r.report).toEqual([]);
  }, 240_000);

  it('Comments: the list, a thread with Claude\'s proposal (its diff), none yet; the timeline previewing the proposal', async () => {
    const { page } = t;
    let r = await station(t, 'comments', () => go(page, at('/p/demo/s/bits/comments'), '[data-testid="viewer"][data-shown]'));
    expect(r.findings, r.report).toEqual([]);
    // L5.12b (M4): a thread with Claude's proposal in the inspector (the list in the browser pane, the frame in the centre)
    // — dark at 1280, 1440 and 900, light at 1280.
    r = await station(
      t,
      'thread-proposal',
      async () => {
        await go(page, at(`/p/demo/s/bits/comments/${THREAD}`), '[data-testid="proposal"] [data-testid="diff-row"]');
        await page.getByTestId('viewer-region').waitFor(POLL);
        expect(await page.locator('[data-testid="proposal"] .k-diff-mark').count()).toBeGreaterThan(0);
        await page.getByTestId('proposal').scrollIntoViewIfNeeded();
      },
      { schemes: [{ scheme: 'dark', widths: [1280, 1440, 900] }, { scheme: 'light', widths: [1280] }] },
    );
    expect(r.findings, r.report).toEqual([]);
    r = await station(t, 'comments-none', () => go(page, at(`/p/${N}/s/quote/comments`), '[data-testid="no-render"]'));
    expect(r.findings, r.report).toEqual([]);
    // L5.12b (M4): the ⌘K palette open on Edit (a modal: the walk stays in it — its list is no tab stop of its own).
    r = await station(
      t,
      'palette-edit',
      async () => {
        await go(page, at(`/p/demo/s/bits/timeline/${RUN}`), '[data-testid="tracks"]');
        await page.evaluate(() => window.dispatchEvent(new CustomEvent('studio:command', { detail: { id: 'palette' } })));
        await page.locator('dialog.k-palette[open] [role="option"]').first().waitFor(POLL);
      },
      { schemes: [{ scheme: 'dark', widths: [1280, 1440, 900] }, { scheme: 'light', widths: [1280] }], exemptMax: 45 },
    );
    await page.keyboard.press('Escape');
    await page.locator('dialog.k-palette[open]').waitFor({ state: 'detached' });
    expect(r.findings, r.report).toEqual([]);
    expect(r.result.walk!.stops).toBe(1);
    // L5.12b fixes (review B-L6): the palette open on the Scenario screen — the storyboard's frames listbox beneath the modal
    // is inert, and the checker now skips what lies behind an open modal (its reachable rule and the families' walk).
    r = await station(
      t,
      'palette-scenario',
      async () => {
        await go(page, at('/p/demo/s/bits'), '[data-testid="step"]');
        await page.evaluate(() => window.dispatchEvent(new CustomEvent('studio:command', { detail: { id: 'palette' } })));
        await page.locator('dialog.k-palette[open] [role="option"]').first().waitFor(POLL);
      },
      { schemes: [{ scheme: 'dark', widths: [1280, 1440, 900] }, { scheme: 'light', widths: [1280] }], exemptMax: 45 },
    );
    await page.keyboard.press('Escape');
    await page.locator('dialog.k-palette[open]').waitFor({ state: 'detached' });
    expect(r.findings, r.report).toEqual([]);
    expect(r.result.walk!.stops).toBe(1);
    r = await station(t, 'timeline-preview-change', async () => {
      await go(page, at(`/p/demo/s/bits/proposal/${THREAD}/${t.entry}`), '[data-testid="proposal-banner"]');
      await page.locator('[data-testid="tl-segment"][data-id="a"]').click();
      await page.locator('[data-testid="inspector"] [role="radiogroup"][aria-disabled="true"]').first().waitFor(POLL);
    }, { exemptMax: 45 });
    expect(r.findings, r.report).toEqual([]);
    expect(await page.evaluate(() => (window as unknown as { __csp: number }).__csp)).toBe(0);
    expect(t.consoleErrors).toEqual([]);
  }, 180_000);

  it('⚑ L5.12d: the desktop app\'s quit sheet (its event dispatched in a page with the app\'s flag) and the not-found screen, in dark and light', async () => {
    const tab = t.page;
    // An app page: the shell's init-script flag, desktop_answer answered here (this server is not supervised).
    const app = await tab.context().newPage();
    const errors: string[] = [];
    app.on('pageerror', (e) => errors.push(String(e)));
    await app.addInitScript(() => ((window as unknown as { __studioShell: unknown }).__studioShell = Object.freeze({ titleBar: 'standard' })));
    await app.route('**/v1/call/desktop_answer', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true,"summary":"ok","data":{"ok":true}}' }));
    await app.goto(t.studio.launchUrl());
    await app.getByRole('heading', { level: 2, name: 'Projects' }).waitFor(POLL);
    t.page = app;
    try {
      const SCHEMES_D = [{ scheme: 'dark' as const, widths: [1280, 1440, 900] }, { scheme: 'light' as const, widths: [1280] }];
      for (const [name, detail] of [
        ['quit-sheet-unsaved', { id: 'quitQuestionTour000000', action: 'quit', title: 'Quit Retake?', text: 'Unsaved text in the Studio (this window, or a browser tab on it) can no longer be saved:\n• README.md of northfield-fixture\n• A comment being written (northfield-fixture · quote)', buttons: ['Cancel', 'Quit Anyway'], proceed: 1, cancel: 0, destructive: true }],
        ['quit-sheet-jobs', { id: 'quitQuestionTour000001', action: 'quit', title: 'Quit Retake?', text: 'These jobs keep running after the app quits, but it will not tell you when they end:\n• Render of northfield-fixture · quote (running)', buttons: ['Quit Anyway', 'Cancel'], proceed: 0, cancel: 1, destructive: false }],
      ] as const) {
        const r = await station(
          t,
          name,
          async () => {
            await app.evaluate((d) => window.dispatchEvent(new CustomEvent('studio:quit', { detail: d })), detail);
            await app.locator('dialog[data-testid="quit-sheet"][open]').waitFor(POLL);
          },
          { schemes: SCHEMES_D },
        );
        expect(r.findings, r.report).toEqual([]);
        // A modal: the walk stays inside it — its two answers.
        expect(r.result.walk!.stops).toBe(2);
        await app.keyboard.press('Escape');
        await app.locator('dialog[data-testid="quit-sheet"][open]').waitFor({ state: 'detached' });
      }
      const r = await station(t, 'not-found', () => go(app, `${t.studio.url}#/no/such/place`, 'h1:has-text("Nothing here")'), { schemes: SCHEMES_D });
      expect(r.findings, r.report).toEqual([]);
      expect(errors).toEqual([]);
    } finally {
      t.page = tab;
      await app.close();
    }
  }, 180_000);

  it('⚑ L5.9: the UI gallery in dark and light at both widths; its sheet, menu and palette open in each scope', async () => {
    const { page } = t;
    const both = [
      { scheme: 'dark' as const, widths: WIDTHS },
      { scheme: 'light' as const, widths: WIDTHS },
    ];
    // (L5.12a: the budgets are the counts measured, not a margin — 26 texts exempt as disabled at the gallery, its sheet and
    // its palette (the disabled choice chip, its label and its reason, in both scopes: shown on purpose), 27 with the menu
    // open (its own disabled item is one more). L5.12a fixes, review B-L6.)
    let r = await station(t, 'gallery', () => go(page, at('/ui'), '[data-testid="gallery"]'), { schemes: both, exemptMax: 26 });
    expect(r.findings, r.report).toEqual([]);
    expect(r.result.audits[1280].stats.texts).toBeGreaterThan(150);
    expect(r.result.walk!.stops).toBeGreaterThan(80);
    for (const scope of ['dark', 'light'] as const) {
      const col = page.getByTestId(`scope-${scope}`);
      r = await station(t, `gallery-sheet-${scope}`, async () => {
        await col.getByRole('button', { name: 'Discard the take…' }).click();
        await page.locator('dialog.k-sheet[open]').waitFor(POLL);
      }, { schemes: both, exemptMax: 26 });
      expect(r.findings, r.report).toEqual([]);
      expect(r.result.walk!.stops).toBe(2);
      await page.keyboard.press('Escape');
      await page.locator('dialog.k-sheet[open]').waitFor({ state: 'detached' });
      expect(await dialogCheck(page, col.getByRole('button', { name: 'Discard the take…' }), () => page.keyboard.press('Enter'))).toEqual([]);
      r = await station(t, `gallery-menu-${scope}`, async () => {
        await col.getByRole('button', { name: 'Take', exact: true }).click();
        await col.getByRole('menuitem', { name: 'Duplicate' }).waitFor(POLL);
      }, { schemes: both, walk: false, exemptMax: 27 });
      expect(r.findings, r.report).toEqual([]);
      await page.keyboard.press('Escape');
      r = await station(t, `gallery-palette-${scope}`, async () => {
        await col.getByRole('button', { name: 'Open the palette' }).click();
        await page.locator('dialog.k-palette[open]').waitFor(POLL);
      }, { schemes: both, exemptMax: 26 });
      expect(r.findings, r.report).toEqual([]);
      expect(r.result.walk!.stops).toBe(1);
      await page.keyboard.press('Escape');
      await page.locator('dialog.k-palette[open]').waitFor({ state: 'detached' });
    }
    expect(await page.evaluate(() => (window as unknown as { __csp: number }).__csp)).toBe(0);
    expect(t.consoleErrors).toEqual([]);
  }, 240_000);
});
