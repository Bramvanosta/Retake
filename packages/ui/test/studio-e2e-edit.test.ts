/**
 * L4.3 part 2: step edits on the Blocks tab, end to end in headless Chromium (the installed browser, no download)
 * against an in-process Studio server on a scratch workspace. The file on disk is checked after each action with
 * independent facts (critique B11: never a golden made by the code under test) — its parsed value against the edit
 * applied to the value before, the lines that moved, its bytes where they must be exact:
 * native drag & drop within a scene (the moved step keeps its run picture, says "moved since this run", and no
 * thumbnail is asked again), across scenes and into an empty scene; the keyboard path (Alt+↓ / Alt+↑ within and across
 * a scene edge, Delete, ⌘Z / Ctrl+Z → the original bytes, Shift+⌘Z redo), on a CR LF file without a final line break
 * too; Duplicate from the inspector (a capture's `as` renamed, said in the live region); a 409 → "Apply it to the new
 * version" applies the edit, a step that moved meanwhile is refused as stale; an outside write clears the undo history;
 * editing off while a YAML draft is open and for a file the Studio does not write (no request sent); hardened drop
 * handlers (a foreign drag carrying the step type, a file from the Finder: nothing sent, no navigation).
 * `RETAKE_UI_SHOTS=<folder>` saves screenshots.
 */
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import type { Browser, Page, Request, Route } from 'playwright-core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { parseYaml } from '@retake/core';
import { startStudioServer } from '../src/index.js';
import type { StudioServer } from '../src/index.js';
import { fixtureWorkspace } from '../../engine/test/helpers.js';
import { BLOCKS_YAML, GREEN, capture, colourName, near, writeRun } from '../../engine/test/synthetic-runs.js';
import type { Rgb } from '../../engine/test/synthetic-runs.js';

const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const POLL = { timeout: 15_000 };
const P = 'northfield-fixture';
const SHOTS = process.env.RETAKE_UI_SHOTS;
const CAPTURE = '20261020-100000-blocks';
const EMPTY = 'video: empty\nscenes:\n  - id: a\n    page: shop\n    open: /\n    steps:\n      # the only step\n      - click: Alone\n  - id: b\n    steps: []  # nothing yet\n';
const KEYS =
  'video: keys\nscenes:\n  - id: a\n    page: shop\n    open: /\n    steps:\n      - click: A1\n      - click: A2\n  - card: {slots: {title: Between}, duration: 1}\n  - id: b\n    steps:\n      - click: B1\n      - hold: 0.5\n';

let ws: string;
let studio: StudioServer;
let browser: Browser;
let page: Page;
const savedHome = process.env.RETAKE_HOME;
const requests: Array<{ op: string; at: number; body: Record<string, unknown> }> = [];
const file = (name: string) => join(ws, 'projects', P, 'scenarios', `${name}.yaml`);
const value = (text: string) => parseYaml(text).value as { scenes: Array<{ id?: string; steps?: unknown[] }> };
const ops = (op: string, since = 0) => requests.filter((r) => r.op === op && r.at >= since);
const row = (key: string) => page.locator(`[data-testid="step"][data-key="${key}"]`);
const live = () => page.getByTestId('edit-live').innerText();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Review B M3 (the flake's cascade): every route a test installs is removed after it — passed or failed — and the requests
 * it held go on, so a failed test never leaves the next ones' reads held forever.
 */
const installed: Array<{ url: string; held: Route[] }> = [];
async function holdRoute(url: string, handler?: (r: Route) => Promise<void>): Promise<{ held: Route[]; release: () => Promise<void> }> {
  const entry = { url, held: [] as Route[] };
  installed.push(entry);
  await page.route(url, handler ?? ((r) => void entry.held.push(r)));
  const release = async () => {
    const i = installed.indexOf(entry);
    if (i < 0) return;
    installed.splice(i, 1);
    await page.unroute(url);
    for (const r of entry.held.splice(0)) await r.continue().catch(() => undefined);
  };
  return { held: entry.held, release };
}
/** `scenario_blocks` reads in flight and when the last one was asked. */
const blocksInFlight = new Set<Request>();
let blocksAskedAt = 0;
/**
 * Review B M3 (the flake's first failure): wait until no `scenario_blocks` read is on its way and none was asked for
 * `ms` — a read already in flight when the test holds the reads would land after an outside write and show that version.
 */
async function readsQuiet(ms = 400): Promise<void> {
  await expect.poll(() => blocksInFlight.size === 0 && Date.now() - blocksAskedAt >= ms, POLL).toBe(true);
}
/** Hold the screen's reads (once they are quiet) so it keeps showing the version it shows. */
async function holdReads(): Promise<{ held: Route[]; release: () => Promise<void> }> {
  await readsQuiet();
  return holdRoute('**/v1/call/scenario_blocks');
}

async function shot(name: string): Promise<void> {
  if (!SHOTS) return;
  await mkdir(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: false });
}

/** The value of `before` with step `i` of scene `a` moved to index `j` of scene `b` (the edit applied to the JS value). */
function moved(before: string, a: string, i: number, b: string, j: number) {
  const v = value(before);
  const sa = v.scenes.find((s) => s.id === a)!.steps!;
  const [st] = sa.splice(i, 1);
  v.scenes.find((s) => s.id === b)!.steps!.splice(j, 0, st);
  return v;
}

/** The lines of a text, sorted: a move changes their order only. */
const sortedLines = (t: string) => t.split('\n').sort();

/** Open a scenario's Blocks tab afresh (through the project page: the screen mounts anew). */
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

async function centreColour(key: string): Promise<Rgb | null> {
  return row(key).evaluate((li) => {
    const img = li.querySelector('img');
    if (!img || !img.complete || img.naturalWidth === 0) return null;
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const g = c.getContext('2d')!;
    g.drawImage(img, 0, 0);
    const d = g.getImageData(Math.floor(c.width / 2), Math.floor(c.height / 2), 1, 1).data;
    return [d[0], d[1], d[2]] as [number, number, number];
  });
}

/** Drag a frame onto the left or right half of another (native HTML5 DnD driven by Playwright's mouse; L5.10b: a grid). */
async function dragRow(from: string, to: string, side: 'left' | 'right'): Promise<void> {
  const box = await row(to).boundingBox();
  await row(from).dragTo(row(to), { targetPosition: { x: side === 'left' ? 8 : box!.width - 8, y: box!.height / 2 } });
}

beforeAll(async () => {
  ws = await mkdtemp(join(tmpdir(), 'studio-ui-e2e-edit-'));
  process.env.RETAKE_HOME = join(ws, '.home');
  await fixtureWorkspace(ws);
  const dir = join(ws, 'projects', P);
  await writeFile(file('blocks'), BLOCKS_YAML);
  await writeRun(dir, capture(CAPTURE, { video: false }));
  await writeFile(file('empty'), EMPTY);
  await writeFile(file('keys'), KEYS);
  await writeFile(file('crlf'), KEYS.replace(/\n/g, '\r\n').replace(/\r\n$/, ''));
  await writeFile(file('owned'), KEYS.replace('      - click: B1', '      - type: {into: {label: Name}, text: "{{env:SHOP_TOKEN}}"}'));
  studio = await startStudioServer({ root: ws, pollMs: 100, startWorker: false });
  const executablePath = process.env.RETAKE_CHROMIUM;
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : { channel: 'chromium' }) });
  const context = await browser.newContext({ viewport: { width: 1360, height: 900 } });
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
    if (m[1] === 'scenario_blocks') {
      blocksInFlight.add(r);
      blocksAskedAt = Date.now();
    }
  });
  const done = (r: Request) => void blocksInFlight.delete(r);
  page.on('requestfinished', done);
  page.on('requestfailed', done);
  await page.goto(studio.launchUrl());
  await page.getByRole('heading', { level: 2, name: 'Projects' }).waitFor(POLL);
}, 60_000);

afterEach(async () => {
  for (const e of [...installed].reverse()) {
    installed.splice(installed.indexOf(e), 1);
    await page.unroute(e.url).catch(() => undefined);
    for (const r of e.held.splice(0)) await r.continue().catch(() => undefined);
  }
});

afterAll(async () => {
  await browser?.close();
  await studio?.close();
  if (savedHome === undefined) delete process.env.RETAKE_HOME;
  else process.env.RETAKE_HOME = savedHome;
  if (ws) await rm(ws, { recursive: true, force: true });
});

describe('drag & drop', () => {
  it('within a scene: the file has the step moved (value, same lines), the live region says so, the step keeps its picture and says it moved, no thumbnail asked again', async () => {
    await openBlocks('blocks');
    const before = await settled('blocks');
    // The capture's picture of "Second" (one.1) is green; wait for it before the move.
    await row('one.1').scrollIntoViewIfNeeded();
    await expect
      .poll(async () => {
        const c = await centreColour('one.1');
        return c ? colourName(c) : 'none';
      }, POLL)
      .toBe(colourName(GREEN));
    const t0 = Date.now();
    await dragRow('one.1', 'one.0', 'left');
    await expect.poll(() => live(), POLL).toBe('Moved step 2 of one to position 1. Saved.');
    const after = await settled('blocks');
    expect(value(after)).toEqual(moved(before, 'one', 1, 'one', 0));
    expect(sortedLines(after)).toEqual(sortedLines(before));
    expect(after.split('\n').slice(6, 8)).toEqual(['      - click: Second', '      - click: First']);
    // The selection follows the moved step; its picture (still green) says it moved; no run_thumbs for it.
    await expect.poll(() => row('one.0').getAttribute('aria-selected'), POLL).toBe('true');
    await expect.poll(() => row('one.0').getByTestId('step-state').innerText(), POLL).toContain('moved since this run');
    expect(await row('one.1').getByTestId('step-state').innerText()).not.toContain('moved');
    await expect
      .poll(async () => {
        const c = await centreColour('one.0');
        return c && near(c, GREEN, 40) ? 'green' : 'other';
      }, POLL)
      .toBe('green');
    expect(ops('run_thumbs', t0).filter((r) => (r.body.keys as string[]).includes('one.1'))).toEqual([]);
    expect(ops('scenario_edit', t0).map((r) => (r.body.edit as { kind: string }).kind)).toEqual(['move_step']);
    await shot('edit-1-moved');
  });

  it('across scenes and into an empty scene (steps: [] becomes a list; the scene left empty becomes steps: [])', async () => {
    await openBlocks('blocks');
    const before = await settled('blocks');
    await dragRow('two.0', 'one.2', 'right');
    await expect.poll(() => live(), POLL).toBe('Moved step 1 of two to position 4 of one. Saved.');
    const after = await settled('blocks');
    expect(value(after)).toEqual(moved(before, 'two', 0, 'one', 3));
    expect(sortedLines(after)).toEqual(sortedLines(before));

    await openBlocks('empty');
    const e0 = await settled('empty');
    // Both the step and the empty scene on screen (Playwright's drag does not scroll while dragging).
    await page.getByTestId('drop-empty').evaluate((el) => el.scrollIntoView({ block: 'end' }));
    await row('a.0').dragTo(page.getByTestId('drop-empty'));
    await expect.poll(() => live(), POLL).toMatch(/^Moved step 1 of a to position 1 of b\. Saved\./);
    const e1 = await settled('empty');
    expect(value(e1)).toEqual(moved(e0, 'a', 0, 'b', 0));
    expect(e1).toBe('video: empty\nscenes:\n  - id: a\n    page: shop\n    open: /\n    steps: []\n  - id: b\n    steps:  # nothing yet\n      # the only step\n      - click: Alone\n');
    await shot('edit-2-empty-scene');
    // Undo restores the exact bytes.
    await page.getByTestId('undo').click();
    await expect.poll(() => live(), POLL).toMatch(/^Undone: Moved step 1 of a to position 1 of b\./);
    await expect.poll(() => readFile(file('empty'), 'utf8'), POLL).toBe(e0);
  });

  it('the insertion line shows where the step goes while dragging (screenshot looked at)', async () => {
    await openBlocks('keys');
    await settled('keys');
    const dt = await page.evaluateHandle(() => new DataTransfer());
    await row('a.0').dispatchEvent('dragstart', { dataTransfer: dt });
    const box = await row('b.1').boundingBox();
    await row('b.1').dispatchEvent('dragover', { dataTransfer: dt, clientX: box!.x + box!.width - 8, clientY: box!.y + box!.height / 2 });
    await expect.poll(() => row('b.1').getAttribute('class'), POLL).toContain('drop-after');
    expect(await row('a.0').getAttribute('class')).toContain('dragging');
    await row('b.1').scrollIntoViewIfNeeded();
    await shot('edit-3-insertion-line');
    await row('a.0').dispatchEvent('dragend', { dataTransfer: dt });
    await expect.poll(() => row('b.1').getAttribute('class'), POLL).not.toContain('drop-after');
  });

  it('hardened drop handlers: a drop with no drag started here (the step type set by another page) and a file from the Finder send nothing and never navigate', async () => {
    await openBlocks('keys');
    const before = await settled('keys');
    const url = page.url();
    const t0 = Date.now();
    // Each event in its own evaluate: the screen re-renders between a dragover and the drop, as with a real drag.
    const fire = (type: string, kind: 'foreign' | 'file') =>
      page.evaluate(
        ([type, kind]) => {
          const w = window as unknown as { __dt?: Record<string, DataTransfer> };
          w.__dt ??= {};
          if (!w.__dt[kind]) {
            const dt = new DataTransfer();
            if (kind === 'foreign') dt.setData('application/x-retake-step', 'a.0');
            else dt.items.add(new File(['x'], 'evil.yaml', { type: 'text/yaml' }));
            w.__dt[kind] = dt;
          }
          const dt = w.__dt[kind];
          const target = document.querySelector('[data-testid="step"][data-key="b.0"]')!;
          const r = target.getBoundingClientRect();
          const ev = new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.x + 40, clientY: r.y + 4 });
          target.dispatchEvent(ev);
          return { prevented: ev.defaultPrevented, effect: dt.dropEffect };
        },
        [type, kind] as const,
      );
    const lines = () => page.locator('.k-frame.is-drop-before, .k-frame.is-drop-after').count();
    // Refused: the window guard cancels the default (a file would open in place of the page) with dropEffect none,
    // and no insertion line shows for a drag that did not start here.
    expect(await fire('dragover', 'foreign')).toEqual({ prevented: true, effect: 'none' });
    await sleep(150);
    expect(await lines()).toBe(0);
    expect((await fire('drop', 'foreign')).prevented).toBe(true);
    expect(await fire('dragover', 'file')).toEqual({ prevented: true, effect: 'none' });
    await sleep(150);
    expect(await lines()).toBe(0);
    expect((await fire('drop', 'file')).prevented).toBe(true);
    await sleep(300);
    expect(ops('scenario_edit', t0)).toEqual([]);
    expect(page.url()).toBe(url);
    expect(await readFile(file('keys'), 'utf8')).toBe(before);
  });
});

describe('the keyboard path and undo / redo', () => {
  it('Alt+↓ / Alt+↑ within a scene and across the scene edge (the card skipped); Delete; ⌘Z back to the original bytes; Shift+⌘Z redoes', async () => {
    await writeFile(file('keys'), KEYS);
    await openBlocks('keys');
    const k0 = await settled('keys');
    const h0 = sha(k0);
    await row('a.0').click();
    await page.keyboard.press('Alt+ArrowDown');
    await expect.poll(() => live(), POLL).toBe('Moved step 1 of a to position 2. Saved.');
    const k1 = await settled('keys');
    expect(value(k1)).toEqual(moved(k0, 'a', 0, 'a', 1));
    await expect.poll(() => row('a.1').getAttribute('aria-selected'), POLL).toBe('true');
    // At the end of scene a: to the start of b (the card between is not a scene).
    await page.keyboard.press('Alt+ArrowDown');
    await expect.poll(() => live(), POLL).toBe('Moved step 2 of a to position 1 of b. Saved.');
    const k2 = await settled('keys');
    expect(value(k2)).toEqual(moved(k1, 'a', 1, 'b', 0));
    await expect.poll(() => row('b.0').getAttribute('aria-selected'), POLL).toBe('true');
    expect(await page.evaluate(() => document.activeElement?.getAttribute('role'))).toBe('listbox');
    await page.keyboard.press('Alt+ArrowUp');
    await expect.poll(() => live(), POLL).toBe('Moved step 1 of b to position 2 of a. Saved.');
    const k3 = await settled('keys');
    expect(k3).toBe(k1);
    await page.keyboard.press('Delete');
    await expect.poll(() => live(), POLL).toBe('Deleted step 2 of a. Saved.');
    const k4 = await settled('keys');
    const want = value(k3);
    want.scenes[0].steps!.splice(1, 1);
    expect(value(k4)).toEqual(want);
    await shot('edit-4-deleted');
    // Undo four times: the original bytes.
    for (let n = 0; n < 4; n++) {
      await page.keyboard.press('ControlOrMeta+z');
      await expect.poll(() => live(), POLL).toMatch(/^Undone: /);
      await settled('keys');
    }
    expect(sha(await readFile(file('keys')))).toBe(h0);
    // Redo once: the first move again, byte for byte.
    await page.keyboard.press('Shift+ControlOrMeta+z');
    await expect.poll(() => live(), POLL).toBe('Redone: Moved step 1 of a to position 2.');
    expect(await settled('keys')).toBe(k1);
    // ⌘Z on the YAML tab is not a block undo.
    await page.getByRole('navigation', { name: 'View' }).getByRole('link', { name: 'YAML' }).click();
    await page.getByTestId('yaml-edit').waitFor(POLL);
    const t1 = Date.now();
    await page.keyboard.press('ControlOrMeta+z');
    await sleep(300);
    expect(ops('scenario_edit', t1)).toEqual([]);
    expect(await readFile(file('keys'), 'utf8')).toBe(k1);
  });

  it('the input lock (critique B7): keys pressed while an edit is on its way send nothing; a held key (repeat) never edits', async () => {
    await writeFile(file('keys'), KEYS);
    await openBlocks('keys');
    await settled('keys');
    const slow = await holdRoute('**/v1/call/scenario_edit', async (r) => {
      await sleep(700);
      await r.continue();
    });
    const t0 = Date.now();
    await row('a.0').click();
    await page.keyboard.press('Alt+ArrowDown');
    await expect.poll(() => page.getByTestId('blocks').getAttribute('aria-busy'), POLL).toBe('true');
    await page.keyboard.press('Alt+ArrowDown');
    await page.keyboard.press('Delete');
    await page.getByTestId('step-actions').getByRole('button', { name: 'Duplicate' }).click({ force: true });
    await expect.poll(() => live(), POLL).toBe('Moved step 1 of a to position 2. Saved.');
    await settled('keys');
    await slow.release();
    expect(ops('scenario_edit', t0)).toHaveLength(1);
    const t1 = Date.now();
    await page.locator('[role="listbox"][aria-label="Steps of scene a"]').dispatchEvent('keydown', { key: 'ArrowUp', altKey: true, repeat: true });
    await page.locator('[role="listbox"][aria-label="Steps of scene a"]').dispatchEvent('keydown', { key: 'Delete', repeat: true });
    await sleep(300);
    expect(ops('scenario_edit', t1)).toEqual([]);
    await writeFile(file('keys'), KEYS);
  });

  it("an edit's selection applies once: a step picked after it stays picked when the same version is read again (part 4)", async () => {
    await writeFile(file('keys'), KEYS);
    await openBlocks('keys');
    await settled('keys');
    await row('a.0').click();
    await page.keyboard.press('Alt+ArrowDown');
    await expect.poll(() => live(), POLL).toBe('Moved step 1 of a to position 2. Saved.');
    const k1 = await settled('keys');
    await expect.poll(() => row('a.1').getAttribute('aria-selected'), POLL).toBe('true');
    await row('b.1').click();
    await expect.poll(() => row('b.1').getAttribute('aria-selected'), POLL).toBe('true');
    // The same bytes written again: a file event, the screen reads the same version again (a new view, same hash).
    const t = Date.now();
    await writeFile(file('keys'), k1);
    await expect.poll(() => ops('scenario_blocks', t).length, POLL).toBeGreaterThan(0);
    await sleep(500);
    expect(await row('b.1').getAttribute('aria-selected')).toBe('true');
    expect(await page.getByTestId('undo').isDisabled()).toBe(false);
    await writeFile(file('keys'), KEYS);
  });

  it('a CR LF file without a final line break: Delete then undo give the exact bytes; the edit keeps CR LF and no final break', async () => {
    await openBlocks('crlf');
    const c0 = await settled('crlf');
    await row('b.1').click();
    await page.keyboard.press('Delete');
    await expect.poll(() => live(), POLL).toMatch(/^Deleted step 2 of b\. Saved\./);
    const c1 = await settled('crlf');
    expect(c1.endsWith('\n')).toBe(false);
    expect(c1.replace(/\r\n/g, '').includes('\n')).toBe(false);
    expect(c1).toBe(c0.replace('\r\n      - hold: 0.5', ''));
    await page.keyboard.press('ControlOrMeta+z');
    await expect.poll(() => readFile(file('crlf'), 'utf8'), POLL).toBe(c0);
    await settled('crlf');
  });

  it("Duplicate from the inspector on the fixture's quote: the copy's `as` renamed and its mark dropped, said in the live region", async () => {
    await openBlocks('quote');
    const q0 = await settled('quote');
    const v0 = value(q0);
    const scene = v0.scenes.find((s) => s.id === 'proposal')!;
    const i = scene.steps!.findIndex((s) => typeof s === 'object' && s !== null && 'download' in s);
    await row(`proposal.${i}`).click();
    await page.getByTestId('step-actions').getByRole('button', { name: 'Duplicate' }).click();
    await expect.poll(() => live(), POLL).toBe(`Duplicated step ${i + 1} of proposal. Saved. The copy saves its document as "quote-2": names of captures are unique (the original keeps "quote").`);
    const q1 = await settled('quote');
    const want = value(q0);
    const copy = structuredClone(scene.steps![i]) as { download: { as: string } };
    copy.download.as = 'quote-2';
    want.scenes.find((s) => s.id === 'proposal')!.steps!.splice(i + 1, 0, copy);
    expect(value(q1)).toEqual(want);
    // One line added, right after the original's.
    const a = q0.split('\n');
    const b = q1.split('\n');
    const at = a.findIndex((l) => l.includes('download:'));
    expect(b).toEqual([...a.slice(0, at + 1), a[at].replace('as: quote}', 'as: quote-2}'), ...a.slice(at + 1)]);
    await expect.poll(() => row(`proposal.${i + 1}`).getAttribute('aria-selected'), POLL).toBe('true');
    await page.keyboard.press('ControlOrMeta+z');
    await expect.poll(() => readFile(file('quote'), 'utf8'), POLL).toBe(q0);
    await settled('quote');
  });
});

describe('conflicts and outside changes', () => {
  it('a 409: "your edit was not applied" → Apply it to the new version applies it; a step that moved meanwhile is refused as stale', async () => {
    await writeFile(file('keys'), KEYS);
    await openBlocks('keys');
    const k0 = await settled('keys');
    // Hold the screen's reads so it keeps showing the version before the outside write.
    let reads = await holdReads();
    const outside = k0.replace('      - hold: 0.5', '      - hold: 0.6');
    await writeFile(file('keys'), outside);
    await row('a.0').click();
    await page.keyboard.press('Alt+ArrowDown');
    await page.getByTestId('edit-conflict').waitFor(POLL);
    expect(await page.getByTestId('edit-conflict').innerText()).toBe('Your edit (Move step 1 of a to position 2) was not applied. The board now shows the new version.');
    await shot('edit-5-conflict');
    expect(await readFile(file('keys'), 'utf8')).toBe(outside);
    await reads.release();
    await expect.poll(() => page.getByTestId('blocks').innerText(), POLL).toContain('0.6');
    await page.getByRole('button', { name: 'Apply it to the new version' }).click();
    await expect.poll(() => live(), POLL).toBe('Moved step 1 of a to position 2. Saved.');
    const k1 = await settled('keys');
    expect(value(k1)).toEqual(moved(outside, 'a', 0, 'a', 1));
    expect(k1.includes('hold: 0.6')).toBe(true);

    // Stale: held reads again; outside, the step at a.0 is replaced; Apply → refused, nothing written.
    reads = await holdReads();
    expect(k1.includes('      - click: A2\n      - click: A1')).toBe(true);
    const outside2 = k1.replace('      - click: A2\n      - click: A1', '      - click: A3\n      - click: A1');
    await writeFile(file('keys'), outside2);
    await row('a.0').click();
    await page.keyboard.press('Alt+ArrowDown');
    await page.getByTestId('edit-conflict').waitFor(POLL);
    await reads.release();
    await expect.poll(() => page.getByTestId('blocks').innerText(), POLL).toContain('A3');
    await page.getByRole('button', { name: 'Apply it to the new version' }).click();
    await expect.poll(() => page.getByTestId('edit-error').innerText(), POLL).toContain('step 1 of a is not the step the edit was made on');
    expect(await readFile(file('keys'), 'utf8')).toBe(outside2);
    await writeFile(file('keys'), KEYS);
  });

  it('an outside write clears the undo history, with a notice', async () => {
    await writeFile(file('keys'), KEYS);
    await openBlocks('keys');
    await settled('keys');
    await row('a.0').click();
    await page.keyboard.press('Alt+ArrowDown');
    await expect.poll(() => live(), POLL).toBe('Moved step 1 of a to position 2. Saved.');
    const k1 = await settled('keys');
    expect(await page.getByTestId('undo').innerText()).toBe('Undo: Moved step 1 of a to position 2');
    await writeFile(file('keys'), k1.replace('hold: 0.5', 'hold: 0.7'));
    await expect.poll(() => live(), POLL).toBe('The file changed outside this screen: the undo history was cleared.');
    expect(await page.getByTestId('undo').isDisabled()).toBe(true);
    expect(await page.getByTestId('undo').innerText()).toBe('Undo');
    await writeFile(file('keys'), KEYS);
  });
});

describe('when block editing is off', () => {
  it('a YAML draft is open (critique B7): no grip, Alt+↓ and Delete send nothing, the reason is said', async () => {
    await page.goto(`${studio.url}#/p/${P}/s/keys/yaml`);
    await page.getByTestId('yaml-edit').click(POLL);
    await page.locator('#yaml-text').click();
    await page.keyboard.press('End');
    await page.keyboard.type('# draft');
    await page.getByRole('navigation', { name: 'View' }).getByRole('link', { name: 'Board' }).click();
    await page.getByTestId('blocks-edit-off').waitFor(POLL);
    expect(await page.getByTestId('blocks-edit-off').innerText()).toBe('Editing the board is off (moves, copies, deletes, forms and new steps): Save or discard your changes in the YAML view first.');
    expect(await row('a.0').getAttribute('draggable')).toBe('false');
    expect(await page.locator('[data-testid="step"][draggable="true"]').count()).toBe(0);
    const t0 = Date.now();
    await row('a.0').click();
    await page.keyboard.press('Alt+ArrowDown');
    await page.keyboard.press('Delete');
    await sleep(300);
    expect(ops('scenario_edit', t0)).toEqual([]);
    await page.getByRole('navigation', { name: 'View' }).getByRole('link', { name: 'YAML' }).click();
    await page.getByRole('button', { name: 'Discard changes' }).click();
    await page.getByRole('button', { name: 'Close the editor' }).click();
  });

  it('a file the Studio does not write (a secret reference): the reason before any click, no grip, no request', async () => {
    const h0 = sha(await readFile(file('owned')));
    await openBlocks('owned');
    await page.getByTestId('blocks-edit-off').waitFor(POLL);
    await page.getByTestId('edit-bar').scrollIntoViewIfNeeded();
    expect(await page.getByTestId('blocks-edit-off').innerText()).toMatch(
      /^Editing the board is off \(moves, copies, deletes, forms and new steps\): scenarios\/owned\.yaml holds what the Studio never writes \(line 12\)/,
    );
    await shot('edit-6-blocked');
    expect(await page.locator('[data-testid="step"][draggable="true"]').count()).toBe(0);
    expect(await page.getByTestId('step-actions').count()).toBe(0);
    const t0 = Date.now();
    await row('a.0').click();
    await page.keyboard.press('Alt+ArrowDown');
    await page.keyboard.press('Delete');
    await sleep(300);
    expect(ops('scenario_edit', t0)).toEqual([]);
    expect(sha(await readFile(file('owned')))).toBe(h0);
  });
});

describe('L5.10b: the storyboard grid', () => {
  /** A step's drag from the page itself: dragstart on a frame, dragover / drop on a scene's list at (x, y), dragend — each its own task (the screen re-renders between them, as with a real drag). */
  async function dropAt(from: string, list: string, at: (r: { left: number; right: number; top: number; bottom: number }[]) => { x: number; y: number }): Promise<void> {
    await page.evaluate((key) => {
      const w = window as unknown as { __gridDt?: DataTransfer };
      w.__gridDt = new DataTransfer();
      document.querySelector(`[data-testid="step"][data-key="${key}"]`)!.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: w.__gridDt }));
    }, from);
    const rects = await page.locator(`[role="listbox"][aria-label="${list}"] > [role="option"]`).evaluateAll((els) =>
      els.map((e) => {
        const r = e.getBoundingClientRect();
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
      }),
    );
    const p = at(rects);
    for (const type of ['dragover', 'drop']) {
      await page.evaluate(
        ([type, label, x, y]) => {
          const w = window as unknown as { __gridDt?: DataTransfer };
          document
            .querySelector(`[role="listbox"][aria-label="${label}"]`)!
            .dispatchEvent(new DragEvent(type as string, { bubbles: true, cancelable: true, dataTransfer: w.__gridDt, clientX: x as number, clientY: y as number }));
        },
        [type, list, p.x, p.y] as const,
      );
      if (type === 'dragover') await expect.poll(() => page.locator('.k-frame.is-drop-before, .k-frame.is-drop-after').count(), POLL).toBe(1);
    }
    await page.evaluate((key) => document.querySelector(`[data-testid="step"][data-key="${key}"]`)?.dispatchEvent(new DragEvent('dragend', { bubbles: true })), from);
  }

  it('⚑ the drop slot comes from the pointer over the whole list (critique M7): a drop in the gap between two frames and one in a trailing empty cell give the exact place', async () => {
    await writeFile(file('blocks'), BLOCKS_YAML);
    await openBlocks('blocks');
    const b0 = await settled('blocks');
    await row('one.0').scrollIntoViewIfNeeded();
    // The gap between one.1 and one.2 (in neither frame): after one.1 — step 1 goes to position 2.
    const t0 = Date.now();
    await dropAt('one.0', 'Steps of scene one', (r) => ({ x: (r[1].right + r[2].left) / 2, y: (r[1].top + r[1].bottom) / 2 }));
    await expect.poll(() => live(), POLL).toBe('Moved step 1 of one to position 2. Saved.');
    const b1 = await settled('blocks');
    expect(value(b1)).toEqual(moved(b0, 'one', 0, 'one', 1));
    expect(ops('scenario_edit', t0).map((r) => r.body.edit)).toEqual([
      { kind: 'move_step', from: { scene: 'one', index: 0, guard: expect.stringMatching(/^[0-9a-f]{16}$/) }, to: { scene: 'one', index: 1 } },
    ]);
    // Scene two's trailing empty cell (two frames in a row of three): the end of the scene.
    const t1 = Date.now();
    await dropAt('one.0', 'Steps of scene two', (r) => ({ x: r[1].right + (r[1].right - r[1].left) / 2 + 24, y: (r[1].top + r[1].bottom) / 2 }));
    await expect.poll(() => live(), POLL).toBe('Moved step 1 of one to position 3 of two. Saved.');
    const b2 = await settled('blocks');
    expect(value(b2)).toEqual(moved(b1, 'one', 0, 'two', 2));
    expect(ops('scenario_edit', t1).map((r) => (r.body.edit as { to: unknown }).to)).toEqual([{ scene: 'two', index: 2 }]);
    await writeFile(file('blocks'), BLOCKS_YAML);
  });

  it("⚑ the write path is unchanged: add, move, duplicate, delete, a form's change and undo are each one scenario_edit naming the version shown (the file's sha256: if_match)", async () => {
    await writeFile(file('keys'), KEYS);
    await openBlocks('keys');
    let text = await settled('keys');
    const sent: Array<{ kind: string; hash: unknown; shown: string }> = [];
    const step = async (act: () => Promise<void>, words: RegExp) => {
      const shown = sha(text);
      const t = Date.now();
      await act();
      await expect.poll(() => live(), POLL).toMatch(words);
      text = await settled('keys');
      const calls = ops('scenario_edit', t);
      expect(calls).toHaveLength(1);
      sent.push({ kind: (calls[0].body.edit as { kind: string }).kind, hash: calls[0].body.hash, shown });
    };
    // Add (the scene's own Add step: the palette placed at its end).
    await step(async () => {
      await page.locator('[data-scene="b"]').getByTestId('scene-add').click();
      await page.getByTestId('palette').locator('[data-palette="click"]').click();
      await page.getByTestId('palette-form').locator('[data-field="click.text"]').fill('B3');
      expect(await page.getByTestId('palette-where').locator('option:checked').innerText()).toBe('At the end of b');
      await page.getByTestId('palette-add').click();
    }, /^Added .*\. Saved\./);
    await page.getByTestId('palette').getByRole('button', { name: 'Close' }).click();
    // Move (Alt+→: one place later), duplicate (the inspector), delete (the key), a form's change, then undo.
    await step(async () => {
      await row('a.0').click();
      await page.keyboard.press('Alt+ArrowRight');
    }, /^Moved step 1 of a to position 2\. Saved\./);
    await step(() => page.getByTestId('step-actions').getByRole('button', { name: 'Duplicate' }).click(), /^Duplicated .*\. Saved\./);
    await step(async () => {
      await row('a.0').click();
      await page.keyboard.press('Delete');
    }, /^Deleted .*\. Saved\./);
    await step(async () => {
      await row('b.0').click();
      await page.getByTestId('step-form').locator('[data-field="click.text"]').fill('B one');
      await page.getByTestId('form-save').click();
    }, /^Changed .*\. Saved\./);
    await step(() => page.getByTestId('undo').click(), /^Undone: /);
    expect(sent.map((x) => x.kind)).toEqual(['insert_step', 'move_step', 'duplicate_step', 'delete_step', 'set_step', 'restore']);
    for (const x of sent) expect(x.hash, x.kind).toBe(x.shown);
    await writeFile(file('keys'), KEYS);
  });
});

describe('review fixes (L4.3 review B)', () => {
  it('L5: the insertion line goes away while dragging over what is not a place to drop', async () => {
    await writeFile(file('keys'), KEYS);
    await openBlocks('keys');
    await settled('keys');
    const dt = await page.evaluateHandle(() => new DataTransfer());
    await row('a.0').dispatchEvent('dragstart', { dataTransfer: dt });
    const box = await row('b.1').boundingBox();
    await row('b.1').dispatchEvent('dragover', { dataTransfer: dt, clientX: box!.x + box!.width - 8, clientY: box!.y + box!.height / 2 });
    await expect.poll(() => page.locator('.k-frame.is-drop-before, .k-frame.is-drop-after').count(), POLL).toBe(1);
    await page.getByTestId('edit-bar').dispatchEvent('dragover', { dataTransfer: dt });
    await expect.poll(() => page.locator('.k-frame.is-drop-before, .k-frame.is-drop-after').count(), POLL).toBe(0);
    await row('a.0').dispatchEvent('dragend', { dataTransfer: dt });
  });

  it('L6: Alt+↑ on the first step and Alt+↓ on the last say they cannot move (nothing sent)', async () => {
    await writeFile(file('keys'), KEYS);
    await openBlocks('keys');
    await settled('keys');
    const t0 = Date.now();
    await row('a.0').click();
    await page.keyboard.press('Alt+ArrowUp');
    await expect.poll(() => live(), POLL).toBe('Step 1 of a is already the first step: it cannot move up.');
    await row('b.1').click();
    await page.keyboard.press('Alt+ArrowDown');
    await expect.poll(() => live(), POLL).toBe('Step 2 of b is already the last step: it cannot move down.');
    expect(ops('scenario_edit', t0)).toEqual([]);
  });

  it("L7: a save from this screen's own YAML tab clears the undo history in its own words", async () => {
    await writeFile(file('keys'), KEYS);
    await openBlocks('keys');
    await settled('keys');
    await row('a.0').click();
    await page.keyboard.press('Alt+ArrowDown');
    await expect.poll(() => live(), POLL).toBe('Moved step 1 of a to position 2. Saved.');
    await settled('keys');
    const nav = (n: string) => page.getByRole('navigation', { name: 'View' }).getByRole('link', { name: n });
    await nav('YAML').click();
    await page.getByTestId('yaml-edit').click(POLL);
    await page.locator('#yaml-text').click();
    await page.keyboard.press('Meta+ArrowDown');
    await page.keyboard.type('# saved from the tab');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(() => readFile(file('keys'), 'utf8'), POLL).toContain('# saved from the tab');
    await page.getByRole('button', { name: 'Close the editor' }).click();
    await nav('Board').click();
    await expect.poll(() => live(), POLL).toBe('Saved from the YAML view: the undo history of block edits was cleared.');
    expect(await page.getByTestId('undo').isDisabled()).toBe(true);
    await writeFile(file('keys'), KEYS);
  });

  it('L9: after a 409, Apply is off with why when the new version turns block editing off (invalid YAML)', async () => {
    await writeFile(file('keys'), KEYS);
    await openBlocks('keys');
    const k0 = await settled('keys');
    const reads = await holdReads();
    await writeFile(file('keys'), `${k0}  - id: [broken\n`);
    await row('a.0').click();
    await page.keyboard.press('Alt+ArrowDown');
    await page.getByTestId('edit-conflict').waitFor(POLL);
    await reads.release();
    await page.getByTestId('edit-conflict-off').waitFor(POLL);
    expect(await page.getByTestId('edit-conflict-off').innerText()).toBe('It cannot be applied to the new version: This file is not valid YAML: fix it in the YAML view first.');
    expect(await page.getByRole('button', { name: 'Apply it to the new version' }).isDisabled()).toBe(true);
    await writeFile(file('keys'), KEYS);
  });
});

describe('L5.10b fixes: the selection and the focus', () => {
  it('B-M2: the selected step deleted from outside — nothing is selected in its place: no step inspector, no enabled Delete (the key does nothing), the scene shown instead', async () => {
    await writeFile(file('keys'), KEYS);
    await openBlocks('keys');
    await settled('keys');
    await row('b.1').click();
    await expect.poll(() => page.getByTestId('inspector-step').innerText(), POLL).toBe('Step 2 · Hold');
    const outside = KEYS.replace('      - hold: 0.5\n', '');
    await writeFile(file('keys'), outside);
    await expect.poll(() => page.locator('[data-testid="step"]').count(), POLL).toBe(3);
    await expect.poll(() => page.getByTestId('scene-facts').getAttribute('data-scene'), POLL).toBe('b');
    expect(await page.getByTestId('inspector-step').count()).toBe(0);
    expect(await page.getByTestId('step-actions').count()).toBe(0);
    expect(await page.getByTestId('inspector').getByRole('button', { name: 'Delete' }).count()).toBe(0);
    expect(await page.locator('[role="option"][aria-selected="true"]').count()).toBe(0);
    // The board and the browser say the same: scene b is the selection.
    expect(await page.locator('[data-testid="scene"][data-scene="b"]').getByTestId('scene-meta').getAttribute('aria-pressed')).toBe('true');
    const t0 = Date.now();
    await page.locator('[role="listbox"][aria-label="Steps of scene b"]').dispatchEvent('keydown', { key: 'Delete' });
    await sleep(300);
    expect(ops('scenario_edit', t0)).toEqual([]);
    expect(await readFile(file('keys'), 'utf8')).toBe(outside);
    await writeFile(file('keys'), KEYS);
  });

  it('A-L1, A-L2: an inspector button keeps the focus after its edit (a second Enter moves the step again); its buttons promise no key that does nothing on them', async () => {
    await writeFile(file('keys'), KEYS);
    await openBlocks('keys');
    await settled('keys');
    await row('a.0').click();
    const actions = page.getByTestId('step-actions');
    await actions.waitFor(POLL);
    expect(await actions.locator('[aria-keyshortcuts]').count()).toBe(0);
    const t0 = Date.now();
    await actions.getByRole('button', { name: 'Move down' }).focus();
    await page.keyboard.press('Enter');
    await expect.poll(() => live(), POLL).toBe('Moved step 1 of a to position 2. Saved.');
    await settled('keys');
    await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute('data-step-action')), POLL).toBe('down');
    await page.keyboard.press('Enter');
    await expect.poll(() => ops('scenario_edit', t0).length, POLL).toBe(2);
    await expect.poll(() => live(), POLL).not.toBe('Moved step 1 of a to position 2. Saved.');
    const k2 = await settled('keys');
    // A1 moved down twice: below A2, then across the card to the start of scene b.
    expect(value(k2)).toEqual(moved(KEYS, 'a', 0, 'b', 0));
    await writeFile(file('keys'), KEYS);
  });
});
