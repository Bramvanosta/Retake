/**
 * L4.9 part C (R-UI-03): the screen tour, part 2, and the keyboard-only path — headless Chromium against a real Studio
 * server (a11y-tour.ts), the fixture product on free ports (the project's environments rewritten to them) for a recording:
 * - the checker (a11y.ts) at 1280 and 1440 wide with its Tab walk at 1280 on: the component library (every card's
 *   controls walked) and its "Create with Claude" dialog (walked inside), a component's detail (once its About, Slots and
 *   Params have loaded), the themes, ⚑ the theme editor on the workspace's own editable theme (its fields enabled,
 *   measured and walked; no sideways scroll at either width — its hidden legend once widened the page), the Record start
 *   form, a recording live with its draft (the `record` job run in this process, Playwright playing the person in the
 *   recording window — no headed window), the recording done and its Discard dialog (walked inside); L5.11b: the start
 *   form and the live recording (a row selected: its alternatives and the Insert toolbar; the status bar the
 *   recording's) also in dark at 900 px, the shell's narrowest window, beside light 1280;
 * - the native dialogs' keyboard contract (modal, focus moves in, Escape closes, focus returns to the opener): Create
 *   with Claude, Discard the recording;
 * - ⚑ a keyboard-only path (no pointer event at all): Skip to content → the demo project → bits → the steps listbox
 *   (arrows select, the inspector follows) → Alt+ArrowDown moves a step (the file changes exactly) → once the move has
 *   landed (Undo enabled), ⌘Z (the exact bytes back) → Open timeline → `]` / `[` select a segment → the Layout radios (arrows, Space writes one line, the preview
 *   re-plans) → ⌘Z → the Comments tab → the thread → a reply typed and sent (an entry of the channel `studio`).
 * No CSP violation, no console error. `DEMO_STUDIO_UI_SHOTS=<folder>` saves full-page screenshots of every state.
 */
import { join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CommentThread } from '@demo-studio/core';
import { runWorker } from '@demo-studio/engine';
import type { RecordJobTestHooks } from '@demo-studio/engine';
import { hasTool } from '../../editor/test/render-helpers.js';
import { dialogCheck } from './a11y.js';
import { N, POLL, REPO, THREAD, TOUR_THEME, go, settle, startTour, station, tabTo } from './a11y-tour.js';
import type { Tour } from './a11y-tour.js';
import { BITS_TEXT } from './timeline-take.js';

type RecordWindow = Parameters<NonNullable<RecordJobTestHooks['drive']>>[0];

interface Fixture {
  urls: { console: string; shop: string; signedIn?: { console: string; shop: string } };
  close(): Promise<void>;
}

const canRun = hasTool('ffmpeg') && hasTool('ffprobe');
const saved = { max: process.env.DEMO_STUDIO_RECORD_MAX_MIN };
let fixture: Fixture;
let t: Tour;
const workerLogs: string[] = [];

beforeAll(async () => {
  if (!canRun) return;
  const mod = (await import(join(REPO, 'fixtures/wholesale/server.mjs'))) as { startFixture(o: Record<string, unknown>): Promise<Fixture> };
  // Free ports (no fixed origin is needed: the project's environments are rewritten to the fixture's own URLs).
  fixture = await mod.startFixture({ consolePort: 0, shopPort: 0, host: '127.0.0.1', auth: { consolePort: 0, shopPort: 0 } });
  delete process.env.DEMO_STUDIO_RECORD_MAX_MIN;
  t = await startTour({
    prefix: 'ds-e2e-a11y-keys-',
    prepare: async (ws) => {
      const file = join(ws, 'projects', N, 'project.yaml');
      const strip = (u: string) => u.replace(/\/$/, '');
      const yaml = await readFile(file, 'utf8');
      await writeFile(
        file,
        yaml
          .replaceAll('http://localhost:4401', strip(fixture.urls.console))
          .replaceAll('http://localhost:4402', strip(fixture.urls.shop))
          .replaceAll('http://localhost:4403', strip(fixture.urls.signedIn!.console))
          .replaceAll('http://localhost:4404', strip(fixture.urls.signedIn!.shop)),
      );
    },
  });
}, 240_000);

afterAll(async () => {
  await t?.close();
  await fixture?.close();
  if (saved.max === undefined) delete process.env.DEMO_STUDIO_RECORD_MAX_MIN;
  else process.env.DEMO_STUDIO_RECORD_MAX_MIN = saved.max;
});

const at = (hash: string) => `${t.studio.url}#${hash}`;
/** L5.11b: the Record screen in dark at 1280 / 1440 and the 900 px window, and light at 1280. */
const RECORD_SCHEMES = [
  { scheme: 'dark' as const, widths: [1280, 1440, 900] },
  { scheme: 'light' as const, widths: [1280] },
];
const stateOf = () => t.page.getByTestId('record-state').first().getAttribute('data-state');

/** The in-process worker (one job), Playwright playing the person; the window closes after `drive` if still open. */
function work(drive: (w: RecordWindow) => Promise<void>): Promise<number> {
  return runWorker({
    root: t.ws,
    once: true,
    idleExitMs: 0,
    pollMs: 50,
    log: (m) => workerLogs.push(m),
    recordTest: {
      headless: true,
      windowSize: { width: 1400, height: 1000 },
      drive: async (w) => {
        await w.waitForLoadState('domcontentloaded');
        await w.waitForTimeout(800);
        await drive(w);
        await w.close().catch(() => undefined);
      },
    },
  });
}

describe.skipIf(!canRun)('the screen tour, part 2: library, themes, Record (L4.9 part C)', () => {
  it('the Record start form; a recording live with its draft; done; the Discard dialog (focus in, Escape, focus back)', async () => {
    const { page } = t;
    let r = await station(t, 'record-start', () => go(page, at(`/p/${N}/record`), '[data-testid="record-start-form"]'), { schemes: RECORD_SCHEMES });
    expect(r.findings, r.report).toEqual([]);
    expect(Object.keys(r.result.all).sort()).toEqual(['dark@1280', 'dark@1440', 'dark@900', 'light@1280']);
    await page.getByTestId('record-page').selectOption('shop');
    await page.getByTestId('record-path').fill('/record-lab');
    await page.getByTestId('record-name').fill('a11y-draft');
    await page.getByTestId('record-start').click();
    await expect.poll(() => /#\/p\/[^/]+\/record\/(rec_[^/]+)$/.test(page.url()), POLL).toBe(true);
    let live: Awaited<ReturnType<typeof station>> | null = null;
    await work(async (w) => {
      await w.getByRole('heading', { name: 'Recording lab' }).waitFor();
      await expect.poll(stateOf, POLL).toBe('recording');
      await w.locator('#lab-email').click();
      await w.keyboard.type('buyer@example.com');
      await w.getByLabel('Note').click();
      await w.keyboard.type('Two words');
      await w.getByLabel('Note').blur();
      await expect.poll(() => page.getByTestId('record-draft').textContent(), POLL).toContain('Two words');
      await page.getByTestId('record-insert-caption').click();
      await page.getByTestId('record-caption-text').fill('Pick a bag size');
      await page.getByTestId('record-caption-text').press('Enter');
      await page.getByTestId('record-pending').waitFor(POLL);
      // L5.11b: a row with alternatives selected — its radio group and the Insert toolbar right after it.
      const row = page.locator('[data-testid=record-step]', { has: page.locator('.k-rowcard-aside') }).first();
      await row.waitFor(POLL);
      await row.getByTestId('record-insert-after').click();
      await page.getByTestId('record-alternatives').waitFor(POLL);
      await page.getByTestId('status-recording').waitFor(POLL);
      live = await station(t, 'record-live', async () => undefined, { schemes: RECORD_SCHEMES });
      await page.getByTestId('record-stop').click();
      await w.waitForEvent('close', { timeout: 15_000 }).catch(() => undefined);
    });
    expect(workerLogs.filter((l) => /: failed \(/.test(l))).toEqual([]);
    expect(live, workerLogs.join('\n')).not.toBeNull();
    expect(live!.findings, live!.report).toEqual([]);
    await expect.poll(stateOf, { timeout: 60_000 }).toBe('done');
    r = await station(t, 'record-done', () => page.getByTestId('record-check').waitFor(POLL));
    expect(r.findings, r.report).toEqual([]);
    // The Discard dialog itself: audited, and walked inside (Tab stays in a modal dialog).
    r = await station(t, 'record-discard', async () => {
      await page.getByTestId('record-discard').click();
      await page.getByTestId('record-discard-confirm').waitFor(POLL);
    });
    expect(r.findings, r.report).toEqual([]);
    expect(r.result.walk!.stops).toBeGreaterThanOrEqual(2);
    await page.keyboard.press('Escape');
    await page.locator('dialog[open]').waitFor({ state: 'detached' });
    expect(await dialogCheck(page, page.getByTestId('record-discard'), () => page.keyboard.press('Enter'))).toEqual([]);
    expect(await stateOf()).toBe('done');
    expect(await page.evaluate(() => (window as unknown as { __csp: number }).__csp)).toBe(0);
    expect(t.consoleErrors).toEqual([]);
  }, 240_000);

  it('the library and its Create with Claude dialog (focus in, Escape, focus back); a component\'s detail', async () => {
    const { page } = t;
    let r = await station(t, 'library', () => go(page, at(`/p/${N}/library`), '[data-testid="lib-card"]'));
    expect(r.findings, r.report).toEqual([]);
    // The walk went round the whole page (every card's controls): it came back to its first stop, far from the cap.
    expect(r.result.walk!.stops).toBeGreaterThan(80);
    r = await station(t, 'library-create', async () => {
      await page.getByTestId('lib-create-open').click();
      await page.getByTestId('lib-create').waitFor(POLL);
    });
    expect(r.findings, r.report).toEqual([]);
    expect(r.result.walk!.stops).toBeGreaterThanOrEqual(2);
    await page.keyboard.press('Escape');
    await page.getByTestId('lib-create').waitFor({ state: 'detached' });
    expect(await dialogCheck(page, page.getByTestId('lib-create-open'), () => page.keyboard.press('Enter'))).toEqual([]);
    // The detail once loaded: its About, Slots and Params cards (reached by a hash change, it answers after the list).
    r = await station(t, 'component', async () => {
      await go(page, at(`/p/${N}/library/editorial/studio/card-cta`), 'h1');
      for (const h of ['About', 'Slots', 'Params']) await page.locator(`main h2:text-is("${h}")`).waitFor(POLL);
    });
    expect(r.findings, r.report).toEqual([]);
    expect(r.result.audits[1280].stats.texts).toBeGreaterThan(80);
  }, 180_000);

  it('the themes; ⚑ the theme editor on an editable workspace theme (fields enabled) with no sideways scroll at 1280 and 1440', async () => {
    const { page } = t;
    let r = await station(t, 'themes', () => go(page, at(`/p/${N}/themes`), 'h1:has-text("Themes")'));
    expect(r.findings, r.report).toEqual([]);
    // The workspace's own theme: every field enabled — measured (nearly nothing exempt) and walked (a stop per field).
    r = await station(
      t,
      'theme-editor',
      async () => {
        await go(page, at(`/p/${N}/themes/${TOUR_THEME}`), `h1:has-text("${TOUR_THEME}")`);
        await page.locator('[data-testid="theme-editor"][data-editable="yes"]').waitFor(POLL);
      },
      // (L5.9: + the shell's four Mode buttons, disabled with no scenario in context.)
      { exemptMax: 8 },
    );
    expect(r.findings, r.report).toEqual([]);
    expect(await page.getByTestId('theme-editor').getAttribute('data-editable')).toBe('yes');
    expect(r.result.audits[1280].stats.texts).toBeGreaterThan(100);
    // (read-only, the same editor showed 77 texts, 76 of them exempt, and 26 Tab stops)
    expect(r.result.walk!.stops).toBeGreaterThan(50);
    for (const width of [1280, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await settle(page);
      const m = await page.evaluate(() => ({ sw: document.scrollingElement!.scrollWidth, cw: document.documentElement.clientWidth, legend: Math.max(...[...document.querySelectorAll('legend.sr-only')].map((l) => l.getBoundingClientRect().width)) }));
      expect(m.sw, `@${width}`).toBeLessThanOrEqual(m.cw);
      expect(m.legend, `@${width}: a hidden legend stays 1 px wide`).toBeLessThanOrEqual(1);
    }
  }, 180_000);

});

describe.skipIf(!canRun)('⚑ the keyboard-only path (L4.9 part C)', () => {
  it('Skip to content → demo → bits → select and move a step, undo → timeline → a layout switch, undo → Comments → a reply', async () => {
    const { page } = t;
    const file = join(t.dir, 'scenarios', 'bits.yaml');
    expect(await readFile(file, 'utf8')).toBe(BITS_TEXT);
    // Every pointer press from here on is counted (a trusted event: the test's own mouse would be one).
    await page.goto(at('/'));
    await page.reload();
    await page.getByRole('heading', { level: 2, name: 'Projects' }).waitFor(POLL);
    await page.evaluate(() => {
      (window as unknown as { __pointer: number }).__pointer = 0;
      window.addEventListener('pointerdown', (e) => e.isTrusted && (window as unknown as { __pointer: number }).__pointer++, true);
      window.addEventListener('mousedown', (e) => e.isTrusted && (window as unknown as { __pointer: number }).__pointer++, true);
    });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => document.activeElement?.textContent?.trim())).toBe('Skip to content');
    await page.keyboard.press('Enter');
    expect(await page.evaluate(() => document.activeElement?.tagName)).toBe('MAIN');

    // The demo project, then bits.
    await tabTo(page, 'main a[href="#/p/demo"]');
    await page.keyboard.press('Enter');
    await page.waitForURL('**#/p/demo');
    // L5.10a: the productions are ONE listbox (one tab stop): Home selects the first poster (bits: the newest
    // activity), Enter opens it.
    await tabTo(page, 'ul.k-posters[role="listbox"]');
    await page.keyboard.press('Home');
    await expect.poll(() => page.evaluate(() => document.querySelector('[role="option"][aria-selected="true"]')?.getAttribute('data-id') ?? null), POLL).toBe('bits');
    await page.keyboard.press('Enter');
    await page.waitForURL('**#/p/demo/s/bits');

    // L5.10b: the frames listbox (a grid): one tab stop; the arrows select, the inspector follows.
    await tabTo(page, 'ul.k-frames[role="listbox"]');
    const selected = () => page.evaluate(() => document.querySelector('[data-testid="step"][aria-selected="true"]')?.getAttribute('data-key') ?? null);
    // The first arrow selects (the list may already hold the first step as its current option); ↑ comes back to it.
    await page.keyboard.press('ArrowDown');
    await expect.poll(selected, POLL).not.toBeNull();
    for (let i = 0; i < 3 && (await selected()) !== 'a.0'; i++) {
      await page.keyboard.press('Home');
      await expect.poll(selected, { timeout: 2000 }).not.toBe(null);
    }
    await expect.poll(selected, POLL).toBe('a.0');
    await page.getByTestId('inspector').waitFor(POLL);
    // Alt+ArrowDown moves it below the next step: the two steps swap in the file, nothing else changes.
    await page.keyboard.press('Alt+ArrowDown');
    const moved = BITS_TEXT.replace('      - hold: 1\n        mark: first\n      - hold: 0.9\n        camera: {zoom: 1.4, target: cursor, until: step_end}\n', '      - hold: 0.9\n        camera: {zoom: 1.4, target: cursor, until: step_end}\n      - hold: 1\n        mark: first\n');
    expect(moved).not.toBe(BITS_TEXT);
    await expect.poll(() => readFile(file, 'utf8'), POLL).toBe(moved);
    // ⌘Z once the move has landed in the view (the file is written before the answer: until the view reloads, an edit
    // is in flight and ⌘Z waits for it — review B-H1), the focus on the listbox, not a field: the exact bytes back.
    await expect.poll(() => page.getByTestId('undo').isEnabled(), POLL).toBe(true);
    await page.keyboard.press('ControlOrMeta+z');
    await expect.poll(() => readFile(file, 'utf8'), POLL).toBe(BITS_TEXT);

    // The Edit mode (the title bar, above the steps: Shift+Tab; L5.11a: the strip's Open timeline went), `]` selects the next segment.
    await tabTo(page, 'a[href$="/s/bits/timeline"]', 120, 'Shift+Tab');
    await page.keyboard.press('Enter');
    await page.getByTestId('tracks').waitFor(POLL);
    // The playhead starts in scene a: `]` selects the next segment (the card), `[` the one before (scene a).
    const segment = () => page.locator('[data-testid="tl-segment"][aria-pressed="true"]').getAttribute('data-id');
    await page.keyboard.press(']');
    await expect.poll(segment, POLL).toBe('c1');
    await page.keyboard.press('[');
    await expect.poll(segment, POLL).toBe('a');
    // The Layout radios: Tab into the group, the arrows move, Space writes one line; the preview re-plans.
    const radio = '[data-testid="switch"][data-key="scene:a:frame"] [role="radio"]';
    await tabTo(page, `${radio}[tabindex="0"]`);
    const hash0 = await page.getByTestId('timeline').getAttribute('data-hash');
    for (let i = 0; i < 6 && (await page.evaluate(() => document.activeElement?.getAttribute('data-value'))) !== 'browser'; i++) await page.keyboard.press('ArrowRight');
    expect(await page.evaluate(() => document.activeElement?.getAttribute('data-value'))).toBe('browser');
    await page.keyboard.press(' ');
    await expect.poll(() => readFile(file, 'utf8'), POLL).toBe(BITS_TEXT.replace('    caption: Every frame carries its number.\n', '    caption: Every frame carries its number.\n    frame: browser\n'));
    await expect.poll(() => page.getByTestId('timeline').getAttribute('data-hash'), POLL).not.toBe(hash0);
    await expect.poll(() => page.getByTestId('preview').getAttribute('data-loading'), POLL).toBe('no');
    await expect.poll(() => page.getByTestId('tl-undo').isEnabled(), POLL).toBe(true);
    await page.keyboard.press('ControlOrMeta+z');
    await expect.poll(() => readFile(file, 'utf8'), POLL).toBe(BITS_TEXT);

    // The Comments tab, the thread, a reply typed and sent with the keyboard.
    await tabTo(page, 'a[data-testid="comments-tab"]', 120, 'Shift+Tab');
    await page.keyboard.press('Enter');
    await page.waitForURL('**#/p/demo/s/bits/comments');
    await tabTo(page, `[data-testid="thread-item"] a[href$="${THREAD}"]`, 120);
    await page.keyboard.press('Enter');
    await page.getByTestId('thread').waitFor(POLL);
    await tabTo(page, '[data-testid="reply-text"]', 120);
    await page.keyboard.type('Thanks: the keyboard got me here.');
    await tabTo(page, 'button[data-testid="reply"]', 5);
    await page.keyboard.press('Enter');
    const threadFile = join(t.dir, 'comments', 'bits', `${THREAD}.json`);
    await expect.poll(async () => (JSON.parse(await readFile(threadFile, 'utf8')) as CommentThread).entries.at(-1)?.text ?? '', POLL).toBe('Thanks: the keyboard got me here.');
    expect((JSON.parse(await readFile(threadFile, 'utf8')) as CommentThread).entries.at(-1)).toMatchObject({ kind: 'reply', author: { via: 'studio' } });
    expect(await page.evaluate(() => (window as unknown as { __pointer: number }).__pointer)).toBe(0);
    expect(t.consoleErrors).toEqual([]);
  }, 180_000);
});
