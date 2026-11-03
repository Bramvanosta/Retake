/**
 * L4.3 part 3: the step's form and the palette, end to end in headless Chromium (the installed browser, no download)
 * against an in-process Studio server on a scratch workspace. The file on disk is checked after each action with facts
 * independent of the edit code (critique B11): its parsed value against the change applied to the value before, the
 * lines that changed, its bytes after undo. The form: a typed text saved (exactly its line), said as a filmed change; a
 * caption as an edit change (L5.5); ⌘Z back to the original bytes; the schema's rules at the field before any request
 * (a negative cps); a `{{env:…}}` typed in refused by the server with the reason at the field; markup typed in saved as
 * text, inert. The palette: a click with a target text and `in: dialog` after the selected step (one flow line), the
 * new row "New since this run". Critique B2: a caption changed outside while the screen showed the old version → 409 →
 * "Apply it to the new version" applies the typed text and keeps the outside caption. Part 4: the inspector folds the
 * empty optional fields ("More: …", a set target's other keys) by the file's values; a hold step's seconds come first.
 * `RETAKE_UI_SHOTS=<folder>` saves screenshots.
 */
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import type { Browser, Page, Request, Route } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseYaml } from '@retake/core';
import { startStudioServer } from '../src/index.js';
import type { StudioServer } from '../src/index.js';
import { fixtureWorkspace } from '../../engine/test/helpers.js';
import { BLOCKS_YAML, capture, writeRun } from '../../engine/test/synthetic-runs.js';

const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const POLL = { timeout: 15_000 };
const P = 'northfield-fixture';
const SHOTS = process.env.RETAKE_UI_SHOTS;
const CAPTURE = '20261020-100000-blocks';
const FORMS = `video: forms
scenes:
  - id: a
    page: console
    open: /
    steps:
      - click: First
      - type: {into: {label: Message}, text: "Light roast", cps: 18}
        caption: {kicker: Note, text: "Leave a note"}
      - hold: 1
`;

let ws: string;
let studio: StudioServer;
let browser: Browser;
let page: Page;
const savedHome = process.env.RETAKE_HOME;
const requests: Array<{ op: string; at: number; body: Record<string, unknown> }> = [];
const file = (name: string) => join(ws, 'projects', P, 'scenarios', `${name}.yaml`);
const value = (text: string) => parseYaml(text).value as { scenes: Array<{ id?: string; steps?: Array<Record<string, unknown>> }> };
const ops = (op: string, since = 0) => requests.filter((r) => r.op === op && r.at >= since);
const row = (key: string) => page.locator(`[data-testid="step"][data-key="${key}"]`);
const live = () => page.getByTestId('edit-live').innerText();
const form = () => page.getByTestId('step-form');
const input = (key: string, scope = form()) => scope.locator(`[data-field="${key}"]`);
const changed = (a: string, b: string) => a.split('\n').flatMap((l, i) => (l === b.split('\n')[i] ? [] : [b.split('\n')[i]]));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function shot(name: string): Promise<void> {
  if (!SHOTS) return;
  await mkdir(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: false });
}

async function openBlocks(name: string): Promise<void> {
  await page.goto(`${studio.url}#/p/${P}`);
  await page.getByRole('heading', { level: 1 }).waitFor(POLL);
  await page.goto(`${studio.url}#/p/${P}/s/${name}`);
  await page.getByTestId('blocks').waitFor(POLL);
  await page.getByTestId('edit-bar').waitFor(POLL);
}

/** Wait until the screen shows the file as it is on disk and no edit is on its way. */
async function settled(name: string): Promise<string> {
  const text = await readFile(file(name), 'utf8');
  await expect.poll(() => page.getByTestId('blocks').getAttribute('aria-busy'), POLL).toBe('false');
  await expect.poll(async () => (await page.locator('[data-testid="step"]').count()) === value(text).scenes.reduce((n, s) => n + (s.steps?.length ?? 0), 0), POLL).toBe(true);
  return text;
}

beforeAll(async () => {
  ws = await mkdtemp(join(tmpdir(), 'studio-ui-e2e-forms-'));
  process.env.RETAKE_HOME = join(ws, '.home');
  await fixtureWorkspace(ws);
  await writeFile(file('forms'), FORMS);
  await writeFile(file('blocks'), BLOCKS_YAML);
  await writeRun(join(ws, 'projects', P), capture(CAPTURE, { video: false }));
  studio = await startStudioServer({ root: ws, pollMs: 100, startWorker: false });
  const executablePath = process.env.RETAKE_CHROMIUM;
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : { channel: 'chromium' }) });
  const context = await browser.newContext({ viewport: { width: 1360, height: 1000 } });
  page = await context.newPage();
  page.on('dialog', (d) => void d.dismiss());
  page.on('request', (r: Request) => {
    const m = /\/v1\/call\/([a-z_]+)$/.exec(r.url());
    if (!m) return;
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(r.postData() ?? '{}') as Record<string, unknown>;
    } catch {
      /* not JSON */
    }
    requests.push({ op: m[1], at: Date.now(), body });
  });
  await page.goto(studio.launchUrl());
  await page.getByRole('heading', { level: 2, name: 'Projects' }).waitFor(POLL);
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await studio?.close();
  if (savedHome === undefined) delete process.env.RETAKE_HOME;
  else process.env.RETAKE_HOME = savedHome;
  if (ws) await rm(ws, { recursive: true, force: true });
});

describe("the step's form", () => {
  it('a typed text saved changes exactly its line (a filmed change); a caption is an edit change; ⌘Z twice → the original bytes', async () => {
    await writeFile(file('forms'), FORMS);
    await openBlocks('forms');
    const t0 = await settled('forms');
    await row('a.1').click();
    await form().waitFor(POLL);
    expect(await input('type.text').inputValue()).toBe('Light roast');
    expect(await input('type.into.label').inputValue()).toBe('Message');
    expect(await input('caption.text').inputValue()).toBe('Leave a note');
    await input('type.text').fill('Dark roast, please');
    await expect.poll(() => page.getByTestId('form-save').innerText(), POLL).toBe('Save type text');
    const t = Date.now();
    await page.getByTestId('form-save').click();
    await expect.poll(() => live(), POLL).toBe('Changed type text of step 2 of a. Saved. What the browser does changed: a rehearsal shows it, a capture films it.');
    const t1 = await settled('forms');
    expect(changed(t0, t1)).toEqual(['      - type: {into: {label: Message}, text: "Dark roast, please", cps: 18}']);
    const want = value(t0);
    (want.scenes[0].steps![1].type as { text: string }).text = 'Dark roast, please';
    expect(value(t1)).toEqual(want);
    expect(ops('scenario_edit', t).map((r) => r.body.edit)).toEqual([
      { kind: 'set_step', at: { scene: 'a', index: 1, guard: expect.stringMatching(/^[0-9a-f]{16}$/) }, changes: [{ path: ['type', 'text'], from: 'Light roast', to: 'Dark roast, please' }] },
    ]);
    // The form shows the saved value; then the caption: an edit change.
    await expect.poll(() => input('type.text').inputValue(), POLL).toBe('Dark roast, please');
    await input('caption.text').fill('A note for the roaster');
    await page.getByTestId('form-save').click();
    await expect.poll(() => live(), POLL).toBe('Changed caption text of step 2 of a. Saved. Only the edit changed: a render of the last capture shows it, no new capture needed.');
    const t2 = await settled('forms');
    expect(changed(t1, t2)).toEqual(['        caption: {kicker: Note, text: "A note for the roaster"}']);
    await shot('form-1-saved');
    for (let n = 0; n < 2; n++) {
      await page.getByTestId('undo').click();
      await expect.poll(() => live(), POLL).toMatch(/^Undone: /);
      await settled('forms');
    }
    expect(sha(await readFile(file('forms')))).toBe(sha(t0));
  });

  it('the inspector folds the empty optional fields by the values on disk ("More: …"); one opened and filled saves and leaves the fold; a hold step\'s seconds come before the modifiers', async () => {
    await writeFile(file('forms'), FORMS);
    await openBlocks('forms');
    const t0 = await settled('forms');
    await row('a.1').click();
    await form().waitFor(POLL);
    const folds = () => form().getByTestId('form-more').locator('summary').allInnerTexts();
    const visible = () => form().locator('[data-field]:visible').evaluateAll((els) => els.map((e) => e.getAttribute('data-field')));
    // L5.10b: the modifiers are switches (on: their fields; off: emptied) — no "More:" fold for them.
    expect(await folds()).toEqual(['Other ways to find it (10)', 'More: clear, enter']);
    expect(await visible()).toEqual(['type.into.label', 'type.text', 'type.cps', 'caption.text', 'caption.kicker']);
    expect(await form().locator('[data-switch]').evaluateAll((els) => els.map((e) => `${e.getAttribute('data-switch')}:${(e as HTMLInputElement).checked}`))).toEqual(['caption:true', 'hold:false', 'speed:false', 'mark:false']);
    await shot('form-0-folded');
    await form().locator('[data-switch="hold"]').check();
    await input('hold').fill('0.5');
    expect(await input('hold').isVisible()).toBe(true);
    await page.getByTestId('form-save').click();
    await expect.poll(() => live(), POLL).toMatch(/^Changed .* of step 2 of a\. Saved\./);
    const t1 = await settled('forms');
    expect(value(t1).scenes[0].steps![1]).toEqual({ ...value(t0).scenes[0].steps![1], hold: 0.5 });
    await expect.poll(() => folds(), POLL).toEqual(['Other ways to find it (10)', 'More: clear, enter']);
    expect(await visible()).toContain('hold');
    expect(await form().locator('[data-switch="hold"]').isChecked()).toBe(true);
    // A modifier switched off empties its fields: Save sends their removal — the same set_step changes as before.
    const tOff = Date.now();
    await form().locator('[data-switch="caption"]').uncheck();
    expect(await input('caption.text').count()).toBe(0);
    await expect.poll(() => page.getByTestId('form-save').innerText(), POLL).toBe('Save 2 changes');
    await page.getByTestId('form-save').click();
    await expect.poll(() => live(), POLL).toMatch(/^Changed caption.* of step 2 of a\. Saved\./);
    const t2 = await settled('forms');
    expect(value(t2).scenes[0].steps![1].caption).toBeUndefined();
    expect(ops('scenario_edit', tOff).map((r) => r.body.edit)).toEqual([
      { kind: 'set_step', at: { scene: 'a', index: 1, guard: expect.stringMatching(/^[0-9a-f]{16}$/) }, changes: [{ path: ['caption', 'text'], from: 'Leave a note' }, { path: ['caption', 'kicker'], from: 'Note' }] },
    ]);
    expect(await form().locator('[data-switch="caption"]').isChecked()).toBe(false);
    // A hold step: its `hold` (seconds) is the action's own field, above the Modifiers heading.
    await row('a.2').click();
    await expect.poll(async () => (await form().innerText()).toLowerCase().indexOf('seconds'), POLL).toBeGreaterThan(-1);
    const text = (await form().innerText()).toLowerCase();
    expect(text.indexOf('seconds')).toBeLessThan(text.indexOf('modifiers'));
    await writeFile(file('forms'), FORMS);
  });

  it("the schema's rules at the field before any request (a negative cps); a {{env:…}} typed in is refused by the server with the reason at the field; markup typed in is saved as text, inert", async () => {
    await writeFile(file('forms'), FORMS);
    await openBlocks('forms');
    const t0 = await settled('forms');
    await row('a.1').click();
    await form().waitFor(POLL);
    const t = Date.now();
    await input('type.cps').fill('-3');
    await expect.poll(() => form().getByTestId('field-error').innerText(), POLL).toBe('more than 0');
    expect(await input('type.cps').getAttribute('aria-invalid')).toBe('true');
    expect(await page.getByTestId('form-save').isDisabled()).toBe(true);
    await form().locator('input[data-field="type.cps"]').press('Enter');
    await sleep(300);
    expect(ops('scenario_edit', t)).toEqual([]);
    await shot('form-2-field-error');
    await input('type.cps').fill('18');
    // A secret reference: the server refuses it (agent trust worded for the Studio), shown at the field.
    await input('type.text').fill('{{env:SHOP_TOKEN}}');
    await page.getByTestId('form-save').click();
    await expect.poll(() => form().getByTestId('field-error').innerText(), POLL).toContain('from the Studio a scenario never resolves a secret');
    await expect.poll(() => page.getByTestId('edit-error').innerText(), POLL).toContain('from the Studio');
    expect(await readFile(file('forms'), 'utf8')).toBe(t0);
    await shot('form-3-secret-refused');
    // Markup: a value like any other, shown as text.
    const markup = '<img src=x onerror="window.__pwned=1">';
    await input('type.text').fill(markup);
    await page.getByTestId('form-save').click();
    await expect.poll(() => live(), POLL).toMatch(/^Changed type text of step 2 of a\. Saved\./);
    const t1 = await settled('forms');
    expect((value(t1).scenes[0].steps![1].type as { text: string }).text).toBe(markup);
    expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
    expect(await page.locator('[data-testid="blocks"] img[src="x"], [data-testid="inspector"] img[src="x"]').count()).toBe(0);
    // Its line as written (in the inspector's "As written", folded while the form shows the values): opened, the rendered
    // text holds the markup as text (review B L8: innerText, not textContent — what the page shows).
    await page.getByTestId('inspector').locator('summary', { hasText: 'As written' }).click();
    await expect.poll(() => page.getByTestId('inspector').innerText(), POLL).toContain(markup);
    await writeFile(file('forms'), FORMS);
  });

  it('critique B2: a caption changed outside while the screen showed the old version → 409 → "Apply it to the new version" saves the typed text and keeps the outside caption', async () => {
    await writeFile(file('forms'), FORMS);
    await openBlocks('forms');
    const t0 = await settled('forms');
    await row('a.1').click();
    await form().waitFor(POLL);
    await input('type.text').fill('Mine');
    // Hold the screen's reads so it keeps showing the version before the outside write.
    const held: Route[] = [];
    await page.route('**/v1/call/scenario_blocks', (r) => void held.push(r));
    // L5.10b fixes (review B M3's lesson): the reads are let go whatever happens, so a failure here never holds the next tests'.
    const release = async () => {
      await page.unroute('**/v1/call/scenario_blocks').catch(() => undefined);
      for (const r of held.splice(0)) await r.continue().catch(() => undefined);
    };
    const outside = t0.replace('text: "Leave a note"', 'text: "Their caption"');
    try {
      await writeFile(file('forms'), outside);
      await page.getByTestId('form-save').click();
      await page.getByTestId('edit-conflict').waitFor(POLL);
      expect(await page.getByTestId('edit-conflict').innerText()).toBe('Your edit (Change type text of step 2 of a) was not applied. The board now shows the new version.');
      expect(await readFile(file('forms'), 'utf8')).toBe(outside);
    } finally {
      await release();
    }
    await expect.poll(() => page.getByTestId('inspector').innerText(), POLL).toContain('Their caption');
    await shot('form-4-conflict');
    await page.getByRole('button', { name: 'Apply it to the new version' }).click();
    await expect.poll(() => live(), POLL).toMatch(/^Changed type text of step 2 of a\. Saved\./);
    const t1 = await settled('forms');
    expect(value(t1).scenes[0].steps![1]).toEqual({ type: { into: { label: 'Message' }, text: 'Mine', cps: 18 }, caption: { kicker: 'Note', text: 'Their caption' } });
    expect(changed(outside, t1)).toEqual(['      - type: {into: {label: Message}, text: "Mine", cps: 18}']);
    await writeFile(file('forms'), FORMS);
  });
});

describe('the palette', () => {
  it('a click with a target text and in: dialog after the selected step: one flow line there, the new row "New since this run"; Close hides it', async () => {
    await writeFile(file('blocks'), BLOCKS_YAML);
    await openBlocks('blocks');
    const t0 = await settled('blocks');
    await row('one.0').click();
    await page.getByTestId('palette-open').click();
    const pal = page.getByTestId('palette');
    await pal.waitFor(POLL);
    expect(await pal.locator('[data-palette]').count()).toBe(16); // hook since L5.8
    await pal.locator('[data-palette="click"]').click();
    const pf = page.getByTestId('palette-form');
    await pf.waitFor(POLL);
    // Nothing filled: Add says so and sends nothing.
    const t = Date.now();
    await page.getByTestId('palette-add').click();
    await expect.poll(() => pf.innerText(), POLL).toContain('Fill at least one value.');
    expect(ops('scenario_edit', t)).toEqual([]);
    await input('click.text', pf).fill('Save');
    await input('click.in', pf).selectOption('dialog');
    expect(await page.getByTestId('palette-where').locator('option:checked').innerText()).toBe('After step 1 of one (the selected step)');
    await shot('palette-1-form');
    await page.getByTestId('palette-add').click();
    await expect.poll(() => live(), POLL).toBe('Added a click step at position 2 of one. Saved.');
    const t1 = await settled('blocks');
    const a = t0.split('\n');
    expect(t1.split('\n')).toEqual([...a.slice(0, 7), '      - click: {text: Save, in: dialog}', ...a.slice(7)]);
    expect(value(t1).scenes[0].steps![1]).toEqual({ click: { text: 'Save', in: 'dialog' } });
    await expect.poll(() => row('one.1').getAttribute('aria-selected'), POLL).toBe('true');
    await expect.poll(() => row('one.1').getByTestId('step-state').innerText(), POLL).toContain('New since this run');
    await shot('palette-2-added');
    await pal.getByRole('button', { name: 'Close' }).click();
    await expect.poll(() => page.getByTestId('palette').count(), POLL).toBe(0);
    await writeFile(file('blocks'), BLOCKS_YAML);
  });
});

describe('review fixes (L4.3 review B)', () => {
  it('M2: an untouched "" is never sent as a removal; a required text holding "" needs no value; typed text dropped by an outside change is listed', async () => {
    const EMPTIES = 'video: empties\nscenes:\n  - id: a\n    page: console\n    open: /\n    steps:\n      - click: Save\n        caption: {kicker: "", text: Saved}\n      - type: {into: {label: Name}, text: "", clear: true}\n';
    await writeFile(file('empties'), EMPTIES);
    await openBlocks('empties');
    const t0 = await settled('empties');
    await row('a.0').click();
    await form().waitFor(POLL);
    await input('caption.text').fill('Saved!');
    await expect.poll(() => page.getByTestId('form-save').innerText(), POLL).toBe('Save caption text');
    const t = Date.now();
    await page.getByTestId('form-save').click();
    await expect.poll(() => live(), POLL).toMatch(/^Changed caption text of step 1 of a\. Saved\./);
    const t1 = await settled('empties');
    expect(changed(t0, t1)).toEqual(['        caption: {kicker: "", text: Saved!}']);
    expect((ops('scenario_edit', t)[0].body.edit as { changes: unknown[] }).changes).toEqual([{ path: ['caption', 'text'], from: 'Saved', to: 'Saved!' }]);
    // type {text: "", clear: true}: no "needs a value", nothing to save until something is typed.
    await row('a.1').click();
    await expect.poll(async () => input('type.into.label').inputValue(), POLL).toBe('Name');
    expect(await form().getByTestId('field-error').count()).toBe(0);
    expect(await page.getByTestId('form-save').isDisabled()).toBe(true);
    // Typed, then the step changes on disk: the form takes the new values and lists what was typed.
    await input('type.into.label').fill('Full name');
    await writeFile(file('empties'), t1.replace('{label: Name}', '{label: Your name}'));
    await expect.poll(async () => input('type.into.label').inputValue(), POLL).toBe('Your name');
    expect(await page.getByTestId('form-dropped').innerText()).toBe('type into label: Full name');
  });
});

describe('L5.10b fixes B-L4: the step inspector as B32 lays it out', () => {
  it('at 1440 × 900: the picture, the title, then the form — the Action fields and the Modifiers on the first screen of the inspector, unscrolled; field labels in words', async () => {
    await writeFile(file('forms'), FORMS);
    await page.setViewportSize({ width: 1440, height: 900 });
    try {
      await openBlocks('forms');
      await settled('forms');
      await row('a.1').click();
      await form().waitFor(POLL);
      const m = await page.getByTestId('inspector').evaluate((el) => {
        let pane: HTMLElement | null = el;
        while (pane && !/(auto|scroll)/.test(getComputedStyle(pane).overflowY)) pane = pane.parentElement;
        const bottom = Math.min(window.innerHeight, pane ? pane.getBoundingClientRect().bottom : window.innerHeight);
        const top = (q: string) => el.querySelector(q)?.getBoundingClientRect() ?? null;
        const switches = [...el.querySelectorAll<HTMLElement>('[data-switch]')].map((s) => (s.closest('.sb-modifier') ?? s).getBoundingClientRect().bottom);
        const labels = [...el.querySelectorAll('[data-testid="step-form"] .k-field-label')].map((l) => ({ text: (l as HTMLElement).innerText, mono: l.querySelector('.k-mono') !== null }));
        return { scrolled: pane?.scrollTop ?? 0, bottom, picture: top('.sb-inspector-picture')?.top ?? 0, title: top('[data-testid="inspector-step"]')?.top ?? 0, form: top('[data-testid="step-form"]')?.top ?? 0, actions: top('[data-testid="step-actions"]')?.top ?? 0, switches, labels };
      });
      if (SHOTS) await writeFile(join(SHOTS, 'inspector-1440.json'), JSON.stringify(m));
      expect(m.scrolled).toBe(0);
      // B32's order: picture, title, form; the edit buttons after the form.
      expect(m.picture).toBeLessThan(m.title);
      expect(m.title).toBeLessThan(m.form);
      expect(m.form).toBeLessThan(m.actions);
      expect(m.switches).toHaveLength(4);
      for (const b of m.switches) expect(b, `a modifier's row ends at ${b}, the inspector at ${m.bottom}`).toBeLessThanOrEqual(m.bottom);
      expect(m.labels.map((l) => l.text)).toContain('Typing speed (characters a second)');
      expect(m.labels.some((l) => l.mono)).toBe(false);
      await shot('form-1440-inspector');
    } finally {
      await page.setViewportSize({ width: 1360, height: 1000 });
    }
  });
});
