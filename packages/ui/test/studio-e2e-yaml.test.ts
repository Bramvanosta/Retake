/**
 * L4.3 part 1: the scenario's editable YAML tab, end to end in headless Chromium (the installed browser, no download)
 * against an in-process Studio server on a scratch workspace. The file on disk is checked after each action with
 * independent facts (critique B11: never a golden made by the code under test) — its parsed value against the value
 * intended, the lines that changed, its bytes where they must be exact:
 * Edit → type → Save (Cmd/Ctrl+S) writes one changed line of the fixture's own `quote` (hooks kept) and the blocks
 * re-render; live issues; a save with an error refused, the draft kept and the file unchanged; a change of hooks
 * refused "from the Studio"; an outside write with no draft loads, with a draft shows the banner, then the save's 409
 * opens the conflict panel and "Save mine over it" wins; a CR LF file without a final line break keeps CR LF; while a
 * YAML draft is open the Blocks tab says block editing is off (critique B7); a file holding a secret reference opens
 * read-only with why and its line, no Edit button (critique B3). `DEMO_STUDIO_UI_SHOTS=<folder>` saves screenshots.
 */
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import type { Browser, Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseYaml } from '@demo-studio/core';
import { startStudioServer } from '../src/index.js';
import type { StudioServer } from '../src/index.js';
import { fixtureWorkspace } from '../../engine/test/helpers.js';

const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const POLL = { timeout: 15_000 };
const P = 'northfield-fixture';
const SHOTS = process.env.DEMO_STUDIO_UI_SHOTS;
const SHORT = 'video: short\nscenes:\n  - id: a\n    page: shop\n    open: /\n    caption: {kicker: One, text: First scene}\n    steps:\n      # a pause\n      - hold: 0.2\n';

let ws: string;
let studio: StudioServer;
let browser: Browser;
let page: Page;
const savedHome = process.env.DEMO_STUDIO_HOME;
const file = (name: string) => join(ws, 'projects', P, 'scenarios', `${name}.yaml`);
const textarea = () => page.locator('#yaml-text');
const state = () => page.getByTestId('yaml-state').innerText();
const value = (text: string) => parseYaml(text).value;

async function shot(name: string): Promise<void> {
  if (!SHOTS) return;
  await mkdir(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: false });
}

/** The lines of `after` that differ from `before` (same line count assumed when `n` lines changed in place). */
function changedLines(before: string, after: string): number[] {
  const a = before.split('\n');
  const b = after.split('\n');
  expect(b.length).toBe(a.length);
  return a.flatMap((l, i) => (l === b[i] ? [] : [i + 1]));
}

/** Open a scenario's YAML tab and its editor. */
async function openEditor(name: string): Promise<void> {
  // Through the project page: the scenario screen mounts afresh (an editor closed, no draft → the read-only view).
  await page.goto(`${studio.url}#/p/${P}`);
  await page.getByRole('heading', { level: 1 }).waitFor(POLL);
  await page.goto(`${studio.url}#/p/${P}/s/${name}/yaml`);
  await page.getByTestId('yaml-edit').click(POLL);
  await textarea().waitFor(POLL);
}

/** Replace the textarea's text (select all, type) — the real keyboard path. */
async function retype(text: string): Promise<void> {
  await textarea().click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.insertText(text);
}

beforeAll(async () => {
  ws = await mkdtemp(join(tmpdir(), 'studio-ui-e2e-yaml-'));
  process.env.DEMO_STUDIO_HOME = join(ws, '.home');
  await fixtureWorkspace(ws);
  await writeFile(file('short'), SHORT);
  await writeFile(file('crlf'), SHORT.replace(/\n/g, '\r\n').replace(/\r\n$/, ''));
  await writeFile(file('owned'), SHORT.replace('      - hold: 0.2', '      - type: {into: {label: Name}, text: "{{env:SHOP_TOKEN}}"}'));
  studio = await startStudioServer({ root: ws, pollMs: 100, startWorker: false });
  const executablePath = process.env.DEMO_STUDIO_CHROMIUM;
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : { channel: 'chromium' }) });
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  page = await context.newPage();
  page.on('dialog', (d) => void d.dismiss());
  await page.goto(studio.launchUrl());
  await page.getByRole('heading', { level: 2, name: 'Projects' }).waitFor(POLL);
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await studio?.close();
  if (savedHome === undefined) delete process.env.DEMO_STUDIO_HOME;
  else process.env.DEMO_STUDIO_HOME = savedHome;
  if (ws) await rm(ws, { recursive: true, force: true });
});

describe('the YAML tab saves through scenario_edit', () => {
  it("the fixture's quote: one caption changed → exactly that line on disk, its value, the hooks kept; the blocks show it", async () => {
    const before = await readFile(file('quote'), 'utf8');
    await openEditor('quote');
    await shot('yaml-1-editor');
    expect(await textarea().inputValue()).toBe(before);
    await expect.poll(() => state(), POLL).toBe('No changes');
    const edited = before.replace('Choose the quantity, the bag size and the grind.', 'Pick the quantity, bag and grind.');
    await retype(edited);
    expect(await state()).toBe('Unsaved changes');
    await expect.poll(() => page.getByTestId('yaml-live').innerText(), POLL).toBe('No issue in this text.');
    await page.keyboard.press('ControlOrMeta+s');
    await expect.poll(() => state(), POLL).toMatch(/^Saved · [0-9a-f]{12}$/);
    const after = await readFile(file('quote'), 'utf8');
    expect(changedLines(before, after)).toEqual([before.split('\n').findIndex((l) => l.includes('Choose the quantity')) + 1]);
    const want = value(before) as { scenes: Array<{ caption?: { text: string } }>; setup: unknown };
    const got = value(after) as typeof want;
    const i = want.scenes.findIndex((s) => s.caption?.text === 'Choose the quantity, the bag size and the grind.');
    want.scenes[i].caption!.text = 'Pick the quantity, bag and grind.';
    expect(got).toEqual(want);
    await page.getByRole('navigation', { name: 'View' }).getByRole('link', { name: 'Board' }).click();
    await expect.poll(() => page.getByTestId('blocks').innerText(), POLL).toContain('Pick the quantity, bag and grind.');
    await writeFile(file('quote'), before);
  });

  it('live issues; a save with an error is refused with its line, the draft kept, the file unchanged; a hooks change refused "from the Studio"', async () => {
    const before = await readFile(file('short'), 'utf8');
    await openEditor('short');
    await retype(SHORT.replace('hold: 0.2', 'hold: -1'));
    await expect.poll(() => page.getByTestId('yaml-live').innerText(), POLL).toMatch(/error\s+line 9/);
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(() => page.getByTestId('yaml-save-issues').innerText(), POLL).toMatch(/line 9/);
    await shot('yaml-2-error');
    expect(await page.getByTestId('yaml-save-error').innerText()).toBe('1 error in this text: nothing was written, your text is kept.');
    expect(await textarea().inputValue()).toContain('hold: -1');
    expect(await state()).toBe('Unsaved changes');
    expect(await readFile(file('short'), 'utf8')).toBe(before);
    await retype(SHORT.replace('scenes:', 'setup:\n  - shell: "cat ~/.ssh/id_ed25519 > assets/k.txt"\nscenes:'));
    await page.keyboard.press('ControlOrMeta+s');
    await expect.poll(() => page.getByTestId('yaml-save-error').innerText(), POLL).toContain('the Studio saves a scenario only with them unchanged');
    expect(await readFile(file('short'), 'utf8')).toBe(before);
    await page.getByRole('button', { name: 'Discard changes' }).click();
    expect(await state()).toBe('No changes');
  });

  it('an outside write with no draft is loaded and announced; with a draft: banner, then the 409 conflict panel, "Save mine over it" wins', async () => {
    await openEditor('short');
    const outside1 = SHORT.replace('First scene', 'Changed outside');
    await writeFile(file('short'), outside1);
    await expect.poll(() => textarea().inputValue(), POLL).toBe(outside1);
    await expect.poll(() => page.getByText('changed on disk: the editor now shows the new version').count(), POLL).toBe(1);
    const mine = outside1.replace('hold: 0.2', 'hold: 0.4');
    await retype(mine);
    const outside2 = outside1.replace('kicker: One', 'kicker: Two');
    await writeFile(file('short'), outside2);
    await expect.poll(() => page.getByText('scenarios/short.yaml changed on disk', { exact: true }).count(), POLL).toBe(1);
    expect(await textarea().inputValue()).toBe(mine);
    await page.getByRole('button', { name: 'Keep editing mine' }).click();
    await page.keyboard.press('ControlOrMeta+s');
    await page.getByTestId('conflict').waitFor(POLL);
    expect(await page.getByTestId('conflict-disk').inputValue()).toBe(outside2);
    await shot('yaml-3-conflict');
    expect(await readFile(file('short'), 'utf8')).toBe(outside2);
    await page.getByRole('button', { name: 'Save mine over it' }).click();
    await expect.poll(() => state(), POLL).toMatch(/^Saved · /);
    expect(await readFile(file('short'), 'utf8')).toBe(mine);
  });

  it('a CR LF file without a final line break: saved with CR LF on every line and a final CR LF; loading it is no change', async () => {
    const before = await readFile(file('crlf'), 'utf8');
    await openEditor('crlf');
    expect(await textarea().inputValue()).toBe(before.replace(/\r\n/g, '\n'));
    expect(await state()).toBe('No changes');
    await retype(before.replace(/\r\n/g, '\n').replace('hold: 0.2', 'hold: 0.3'));
    await page.keyboard.press('ControlOrMeta+s');
    await expect.poll(() => state(), POLL).toMatch(/^Saved · /);
    const after = await readFile(file('crlf'), 'utf8');
    expect(after).toBe(`${before.replace('hold: 0.2', 'hold: 0.3')}\r\n`);
    expect(after.replace(/\r\n/g, '').includes('\n')).toBe(false);
  });

  it('while a YAML draft is open the Blocks tab says block editing is off (critique B7); the draft survives the tab switch', async () => {
    await openEditor('short');
    const draft = (await textarea().inputValue()).replace('hold: 0.4', 'hold: 0.9');
    await retype(draft);
    await page.getByRole('navigation', { name: 'View' }).getByRole('link', { name: 'Board' }).click();
    await page.getByTestId('yaml-draft-open').waitFor(POLL);
    await shot('yaml-4-blocks-draft');
    expect(await page.getByTestId('yaml-draft-open').innerText()).toContain('Editing the board stays off until you save or discard your changes');
    await page.getByRole('navigation', { name: 'View' }).getByRole('link', { name: 'YAML' }).click();
    await expect.poll(() => textarea().inputValue(), POLL).toBe(draft);
    await page.getByRole('button', { name: 'Discard changes' }).click();
    await page.getByRole('navigation', { name: 'View' }).getByRole('link', { name: 'Board' }).click();
    await page.getByTestId('blocks').waitFor(POLL);
    expect(await page.getByTestId('yaml-draft-open').count()).toBe(0);
  });
});

describe('a file the Studio does not write (critique B3, B11)', () => {
  it('opens read-only with why and the line of the secret reference; no Edit button, no editor, nothing sent', async () => {
    const h0 = sha(await readFile(file('owned')));
    await page.goto(`${studio.url}#/p/${P}/s/owned/yaml`);
    await page.getByTestId('yaml-readonly').waitFor(POLL);
    await shot('yaml-5-readonly');
    expect(await page.getByTestId('yaml-readonly').innerText()).toMatch(/scenarios\/owned\.yaml holds what the Studio never writes \(line 9\)/);
    expect(await page.getByTestId('yaml-readonly-problems').innerText()).toMatch(/^line 9 the scenario uses \{\{env:SHOP_TOKEN\}\}: from the Studio/);
    expect(await page.getByTestId('yaml-edit').count()).toBe(0);
    expect(await textarea().count()).toBe(0);
    expect(sha(await readFile(file('owned')))).toBe(h0);
  });
});

describe('L5.10b: the YAML source (R4-Source)', () => {
  it('the File inspector says valid or how many errors in words; a browser row brings its lines into view (outlined); a file that is not valid YAML says so on the board and in the File', async () => {
    const TWO = `${SHORT}  - id: b\n    steps:\n      - hold: 0.1\n`;
    await writeFile(file('two-scenes'), TWO);
    await page.goto(`${studio.url}#/p/${P}/s/two-scenes/yaml`);
    await page.getByTestId('yaml').waitFor(POLL);
    const inspector = page.getByTestId('file-inspector');
    await expect.poll(() => inspector.innerText(), POLL).toContain('Valid');
    expect(await inspector.innerText()).toContain(`${TWO.length.toLocaleString('en')} of 500,000 characters`);
    // The scenes browser: scene b's row outlines its lines (10–12) in the read view.
    await page.getByRole('navigation', { name: 'Scenes' }).getByRole('button', { name: /b/ }).last().click();
    const focused = page.locator('[data-testid="yaml"] li[data-focus="true"]');
    await expect.poll(() => focused.count(), POLL).toBe(3);
    expect(await focused.first().innerText()).toContain('- id: b');
    // Not valid YAML: the board says so (and why editing is off), the File inspector says it in words, each issue under its line.
    await writeFile(file('broken'), 'video: broken\nscenes:\n  - id: a\n    steps: [\n      - click: Save\n');
    await page.goto(`${studio.url}#/p/${P}/s/broken`);
    await page.getByTestId('invalid-yaml').waitFor(POLL);
    expect(await page.getByTestId('invalid-yaml').innerText()).toContain('This file is not valid YAML');
    expect(await page.getByTestId('blocks-edit-off').innerText()).toContain('not valid YAML');
    await page.getByRole('navigation', { name: 'View' }).getByRole('link', { name: 'YAML' }).click();
    await expect.poll(() => page.getByTestId('file-inspector').innerText(), POLL).toContain('Not valid YAML');
    expect(await page.getByTestId('yaml').locator('li', { hasText: '- click: Save' }).innerText()).toMatch(/error/);
    await shot('yaml-6-invalid');
  });

  it('L5.10b fixes B-M1: a run of this scenario queued or running shows on the YAML view too — its progress and Cancel', async () => {
    await writeFile(file('runs-yaml'), SHORT);
    await page.goto(`${studio.url}#/p/${P}/s/runs-yaml`);
    await page.getByRole('heading', { level: 1, name: 'runs-yaml' }).waitFor(POLL);
    await expect.poll(() => page.getByTestId('run-dry').isDisabled(), POLL).toBe(false);
    await page.getByTestId('run-dry').click();
    // No worker here: it stays queued until Cancel.
    await page.getByTestId('running').waitFor(POLL);
    await page.getByRole('navigation', { name: 'View' }).getByRole('link', { name: 'YAML' }).click();
    await page.getByTestId('yaml').waitFor(POLL);
    await page.getByTestId('running').waitFor(POLL);
    expect(await page.getByTestId('running').innerText()).toMatch(/runs-yaml/);
    expect(await page.getByTestId('run-cancel').isDisabled()).toBe(false);
    await shot('yaml-7-running');
    await page.getByTestId('run-cancel').click();
    await expect.poll(() => page.getByTestId('running').count(), POLL).toBe(0);
  });
});
