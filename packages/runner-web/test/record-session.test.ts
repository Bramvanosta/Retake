/**
 * The recorder's capture (L3.4 part 1, R-MCP-24): `recordSession` on the fixture's recording lab (fixtures/wholesale
 * /record-lab), the window played by Playwright input — trusted events through CDP Input, so it stands in for the
 * person (headless here; the real window is MACOS-CHECKLIST 12f). Covers the event per control with verified targets,
 * a page that tries to forge the recorder's input (refused, and the recorder invisible to it), sentinel secrets typed
 * every way the lab allows (absent from every byte written and returned), a foreign origin, a sign-in landing, the
 * write guard of a read-only environment, the stop / cancel / maximum-duration paths and the cost of a press on a page
 * of 10,000 controls.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, statSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import type { Page } from 'playwright-core';
import { RecordedEventSchema, draftFromRecording, resolveEnvironment, resolvePersonas, PERSON_POLICY } from '@retake/core';
import type { LoadedProject, RecordedEvent } from '@retake/core';
import { CancelledError, disableAutofill, looksLikeSecretSegment, looksLikeToken, maskPathSecrets, recordSession, secretHash, signIn } from '../src/index.js';
import type { RecordSessionOptions, RecordSessionResult } from '../src/index.js';
import { makeProject, tempDir } from './helpers.js';
import { startServer } from '@retake/test-support/capture';
import type { TestServer } from '@retake/test-support/capture';
import { retakeHome } from '@retake/core/io';
// Calibrated on the Mac Retake is made for (frame rates, freezes, paint and wait timings): skipped on a shared CI
// runner, where ci.yml sets RETAKE_TEST_SHARED_RUNNER=1 (fewer cores, no GPU).
const MAC_TIMING = process.env.RETAKE_TEST_SHARED_RUNNER !== '1';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
/** The fixture's invented buyer account (fixtures/wholesale/README.md). */
const BUYER = { email: 'orders@demo-cafe.example', password: 'filter-bloom-2026' };
const SUPPLIER_PASSWORD = 'roast-lot-2026';

interface Fixture {
  urls: { console: string; shop: string; signedIn?: { console: string; shop: string } };
  close(): Promise<void>;
}

let fixture: Fixture;
let foreign: TestServer;
/** An app of its own (an environment page) whose API is on another host (`foreign`), with a closed shadow root. */
let app: TestServer;
let dir: string;
let home: string;
let csv: string;

beforeAll(async () => {
  home = await tempDir('ds-record-home-');
  process.env.RETAKE_HOME = home;
  const mod = (await import(join(REPO, 'fixtures/wholesale/server.mjs'))) as {
    startFixture(o: { consolePort: number; shopPort: number; host: string; auth: { consolePort: number; shopPort: number } }): Promise<Fixture>;
  };
  fixture = await mod.startFixture({ consolePort: 0, shopPort: 0, host: '127.0.0.1', auth: { consolePort: 0, shopPort: 0 } });
  foreign = await startServer({
    '/elsewhere.html': '<!doctype html><html><body><h1>Another app</h1><label>Code <input id="other"></label><button>Elsewhere</button></body></html>',
  });
  const api = foreign.url;
  app = await startServer({
    '/app.html': `<!doctype html><html><body><h1>Orders</h1>
<button id="order">Place order</button><button id="leave">Leave</button><button id="save">Save</button>
<label>Notes <input id="notes"></label><div id="closed"></div><p id="s"></p>
<script>
document.getElementById('order').onclick = async () => { await fetch('${api}/orders/Q7xLm2Rt9KfZp4Vw8NcY3sJd', { method: 'POST', mode: 'no-cors', body: 'x' }).catch(() => null); document.getElementById('s').textContent = 'Order placed'; };
document.getElementById('leave').onclick = () => { navigator.sendBeacon('${api}/collect', 'bye'); document.getElementById('s').textContent = 'Left'; };
const root = document.getElementById('closed').attachShadow({ mode: 'closed' });
root.innerHTML = '<label>PIN code <input type="password" id="cpw"></label>';
</script></body></html>`,
  });
  dir = await tempDir('rw-record-');
  csv = join(dir, 'prices.csv');
  await writeFile(csv, 'lot,price\nA,10\n');
}, 60_000);

afterAll(async () => {
  await fixture?.close();
  await foreign?.close();
  await app?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
  if (home) await rm(home, { recursive: true, force: true });
});

/** A project on the fixture: `test` (read-write) plus what a test changes. */
function projectWith(over: (p: LoadedProject) => void = () => undefined): LoadedProject {
  const p = makeProject(dir, { console: fixture.urls.console, shop: fixture.urls.shop }, { width: 1280, height: 800 });
  over(p);
  return p;
}

async function mutations(): Promise<number> {
  const r = await fetch(`${fixture.urls.console}/api/health`);
  return ((await r.json()) as { mutations: number }).mutations;
}

interface Recorded {
  r: RecordSessionResult;
  file: string;
  bytes: string;
  logs: string;
}

/** Record with `drive` playing the person on the lab (or `url`); the window closes after it. */
async function record(drive: (page: Page) => Promise<void>, over: Partial<RecordSessionOptions> = {}): Promise<Recorded> {
  const file = join(dir, `events-${randomBytes(4).toString('hex')}.jsonl`);
  const logs: string[] = [];
  const project = over.project ?? projectWith();
  const r = await recordSession({
    policy: PERSON_POLICY,
    project,
    env: resolveEnvironment(project, 'test'),
    url: `${fixture.urls.shop}/record-lab`,
    eventsFile: file,
    headless: true,
    windowSize: { width: 1400, height: 1000 },
    log: (l, m) => logs.push(`${l} ${m}`),
    drive: async (page) => {
      await page.waitForLoadState('domcontentloaded');
      if (!over.url) await page.getByRole('heading', { name: 'Recording lab' }).waitFor();
      // A person needs a moment before the first action (the page's own scripts run, the recorder is told where it is).
      await page.waitForTimeout(400);
      await drive(page);
      await page.waitForTimeout(300).catch(() => undefined);
      await page.close().catch(() => undefined);
    },
    ...over,
  });
  return { r, file, bytes: await readFile(file, 'utf8'), logs: logs.join('\n') };
}

/** What the person did (presses, typing, keys, selects, files). */
const actions = (r: RecordSessionResult) => r.events.filter((e) => ['pointer', 'type', 'key', 'select_native', 'file'].includes(e.kind));
type WithEl = Extract<RecordedEvent, { el: unknown }>;
const withEl = (r: RecordSessionResult) => r.events.filter((e): e is WithEl => 'el' in e);

describe('recordSession: what is recorded', () => {
  it('one event per control, each with a target verified at the time of the action; the file is the stream of them', async () => {
    const { r, file, bytes } = await record(async (page) => {
      await page.getByLabel('Email').click();
      await page.keyboard.type('maja@example.test');
      await page.keyboard.press('Enter');
      // Radix select: opens on pointerdown; the option chosen in its listbox.
      await page.getByRole('combobox', { name: 'Bag size' }).click();
      await page.waitForTimeout(400);
      await page.getByRole('option', { name: '5 kg' }).click();
      // Native select: typeahead on the focused control (a trusted change).
      await page.getByLabel('Roast level').focus();
      await page.keyboard.press('d');
      // A file chosen in the chooser the zone opens (names only).
      const chooser = page.waitForEvent('filechooser');
      await page.getByText('Drop a price list here').click();
      await (await chooser).setFiles(csv);
      await page.getByLabel('Note').click();
      await page.keyboard.type('Two bags');
      await page.getByRole('textbox', { name: 'Message' }).click();
      await page.keyboard.type('Hello there');
      // A Radix dialog opened from the keyboard (Enter on the focused button: its click has detail 0).
      await page.getByRole('button', { name: 'Edit address' }).focus();
      await page.keyboard.press('Enter');
      await page.getByLabel('Street').waitFor();
      await page.getByLabel('Street').click();
      await page.keyboard.type('Main street 1');
      await page.getByRole('button', { name: 'Save address' }).click();
      await page.waitForTimeout(400);
      // A row's menu, an item that asks to confirm, the confirmation.
      await page
        .getByRole('row', { name: /Cerro Alto/ })
        .getByRole('button', { name: 'Row actions' })
        .click();
      await page.waitForTimeout(400);
      await page.getByRole('menuitem', { name: 'Archive' }).click();
      await page.waitForTimeout(400);
      await page.getByRole('button', { name: 'Archive lot' }).click();
      await page.waitForTimeout(400);
      // Keys: a shortcut, a printable key outside a field (never), Escape.
      await page.keyboard.press('Control+k');
      await page.keyboard.press('Escape');
      await page.locator('body').click({ position: { x: 5, y: 5 } });
      await page.keyboard.press('z');
      // The person scrolls, then follows an in-app link.
      await page.mouse.move(700, 500);
      await page.mouse.wheel(0, -300);
      await page.waitForTimeout(700);
      await page.mouse.wheel(0, 300);
      await page.waitForTimeout(700);
      await page.getByRole('link', { name: 'Browse coffees' }).click();
      await page.waitForURL(/coffees/);
    });
    expect(r.stop).toBe('closed');
    expect(r.window).toEqual({ width: 1400, height: expect.any(Number) });
    // Every event passes the schema, in order, and the file holds exactly them.
    r.events.forEach((e, i) => {
      expect(RecordedEventSchema.safeParse(e).success).toBe(true);
      expect(e.seq).toBe(i);
    });
    expect(
      bytes
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as RecordedEvent),
    ).toEqual(r.events);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(r.counts.dropped).toEqual({ sign_in: 0, frame: 0, invalid: 0, new_page: 0 });
    // The lab's script set the Email field before the person typed in it: that initial value is never sent.
    expect(bytes).not.toContain('FORGED');

    const ev = r.events;
    expect(ev[0]).toMatchObject({ kind: 'navigation', cause: 'start', where: 'environment', page_key: 'shop', path: '/record-lab' });
    const find = <K extends RecordedEvent['kind']>(kind: K, pred: (e: Extract<RecordedEvent, { kind: K }>) => boolean) =>
      ev.find((e): e is Extract<RecordedEvent, { kind: K }> => e.kind === kind && pred(e as Extract<RecordedEvent, { kind: K }>));
    const target = (e: WithEl | undefined) => e?.el?.target;
    // Typing: committed by Enter, the text and its field, never the field's initial value.
    expect(find('type', (e) => e.el?.label === 'Email')).toMatchObject({ text: 'maja@example.test', enter: true, clear: false, secret: false, field_kind: 'text' });
    // Radix select: the trigger (a verified `select {field}`), then the option inside the listbox.
    const trigger = find('pointer', (e) => e.el?.role === 'combobox');
    expect(trigger?.el).toMatchObject({ target: { label: 'Bag size' }, action: { kind: 'select', field: 'Bag size', verified: true } });
    expect(find('pointer', (e) => e.el?.text === '5 kg')?.el).toMatchObject({ target: { text: '5 kg' }, in: 'listbox', appeared: true });
    expect(find('select_native', () => true)).toMatchObject({ option: 'Dark', el: { target: { label: 'Roast level' } } });
    expect(find('file', () => true)).toMatchObject({ via: 'input', names: ['prices.csv'] });
    expect(find('pointer', (e) => e.el?.text === 'Drop a price list here')?.el?.action.kind).toBe('drop_file');
    expect(find('type', (e) => e.el?.label === 'Note')).toMatchObject({ text: 'Two bags', field_kind: 'multiline' });
    expect(find('type', (e) => e.field_kind === 'contenteditable')).toMatchObject({ text: 'Hello there' });
    // The keyboard activation is a press (via keyboard); the dialog's field and button are scoped to it.
    expect(target(find('pointer', (e) => e.via === 'keyboard'))).toEqual({ text: 'Edit address' });
    expect(find('type', (e) => e.el?.label === 'Street')).toMatchObject({ text: 'Main street 1', el: { in: 'dialog' } });
    expect(find('pointer', (e) => e.el?.text === 'Save address')?.el).toMatchObject({ in: 'dialog', action: { verified: true } });
    // The row menu: its trigger verified as `menu {row}`, the item in the menu, the confirmation in its dialog.
    expect(find('pointer', (e) => e.el?.name === 'Row actions')?.el).toMatchObject({ in: 'row', action: { kind: 'menu', row: 'Cerro Alto', verified: true } });
    expect(find('pointer', (e) => e.el?.text === 'Archive')?.el).toMatchObject({ target: { text: 'Archive' }, in: 'menu' });
    expect(find('pointer', (e) => e.el?.text === 'Archive lot')?.el?.in).toBe('dialog');
    // Keys: the shortcut and Escape; never the printable key.
    expect(find('key', (e) => e.key === 'k')).toMatchObject({ modifiers: ['Control'] });
    expect(find('key', (e) => e.key === 'Escape')).toBeTruthy();
    expect(ev.some((e) => e.kind === 'key' && e.key === 'z')).toBe(false);
    expect(ev.filter((e) => e.kind === 'scroll' && e.container === 'document' && e.dy !== 0).length).toBeGreaterThan(0);
    const link = find('pointer', (e) => e.el?.href_path === '/coffees');
    expect(link?.el?.target).toEqual({ text: 'Browse coffees' });
    expect(ev.findIndex((e) => e.kind === 'navigation' && e.cause === 'spa' && e.path === '/coffees')).toBeGreaterThan(ev.indexOf(link!));
    // Every target the recorder kept was verified in the page: none is a bare guess.
    for (const e of withEl(r)) if (e.el?.target) expect(e.el.matches).toBeGreaterThanOrEqual(1);
    expect(r.counts.actions).toBe(actions(r).length);
    expect(ev.at(-1)).toMatchObject({ kind: 'stop', reason: 'closed' });
  }, 90_000);
});

describe('recordSession: the page cannot see or feed the recorder', () => {
  it('forged events, bindings called by name, the kit and the recorder looked up: nothing seen, nothing recorded', async () => {
    let report: Record<string, unknown> = {};
    let mainWorld: Record<string, unknown> = {};
    const { r, bytes } = await record(async (page) => {
      await page.getByRole('button', { name: 'Run the forgery script' }).click();
      await page.waitForTimeout(300);
      report = JSON.parse((await page.getByTestId('forge-report').textContent()) ?? '{}') as Record<string, unknown>;
      // The page's main world, as any script of it sees it.
      mainWorld = await page.evaluate(() => {
        const w = window as unknown as Record<string, unknown>;
        return {
          names: Object.getOwnPropertyNames(window).filter((n) => /dsrec|__demo|playwright__binding/i.test(n)),
          kit: typeof w.__retake,
          cursor: document.querySelectorAll('retake-cursor').length,
          patched: typeof w.__retakeNotifyPatched,
        };
      });
    });
    expect(report).toMatchObject({ kit: 'undefined', verdict: 'undefined', flush: 'undefined', raw: 'undefined', called: 0 });
    expect((report.found as string[]).filter((n) => /dsrec|binding__|demo/i.test(n))).toEqual([]);
    expect(report.dispatched).toBeGreaterThan(0);
    expect(mainWorld).toEqual({ names: [], kit: 'undefined', cursor: 0, patched: 'undefined' });
    // The one real press is recorded; nothing the script forged (twice: on load, and by the button).
    expect(actions(r).map((e) => e.kind)).toEqual(['pointer']);
    expect(bytes).not.toContain('FORGED');
    expect(r.counts.dropped.invalid).toBe(0);
  }, 60_000);
});

describe('recordSession: secrets', () => {
  it('sentinel secrets typed every way the lab allows appear in no byte written or returned', async () => {
    const s = randomBytes(3).toString('hex');
    const sentinel = { password: `Pw-${s}-Sentinel`, otp: '482913', card: '4242 4242 4242 4242', key: `sk_Live-${s}AbCdEf0123456789`, get: `Get-${s}-Sentinel`, typed: `tok-${s}-Sentinel` };
    const { r, bytes, logs } = await record(async (page) => {
      await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
      // A password field shown in plain text half-way through ("Show"): the classification is sticky.
      await page.locator('#lab-password').click();
      await page.keyboard.type(sentinel.password.slice(0, 6));
      await page.getByRole('button', { name: 'Show' }).click();
      await page.locator('#lab-password').click();
      await page.keyboard.press('End');
      await page.keyboard.type(sentinel.password.slice(6));
      // Revealed as page text, then clicked: the element's text is masked.
      await page.getByRole('button', { name: 'Reveal' }).click();
      await page.getByRole('button', { name: sentinel.password }).click();
      // Re-mounted as a new, plain field holding the value: the memory knows the value.
      await page.getByRole('button', { name: 'Re-mount the field' }).click();
      await page.locator('#lab-field').click();
      await page.keyboard.press('End');
      await page.keyboard.type('Q');
      // One-time-code boxes, a card number, a pasted key.
      await page.getByLabel('Digit 1').click();
      await page.keyboard.type(sentinel.otp);
      await page.getByLabel('Card').click();
      await page.keyboard.type(sentinel.card);
      await page.evaluate((k) => navigator.clipboard.writeText(k), sentinel.key);
      await page.getByLabel('Integration').click();
      await page.keyboard.press('ControlOrMeta+V');
      // The password pasted into a plain field.
      await page.evaluate((k) => navigator.clipboard.writeText(k), sentinel.password);
      await page.getByLabel('Email').click();
      await page.keyboard.press('ControlOrMeta+V');
      // A GET form with a password: its values would be in the URL.
      await page.getByLabel('Legacy user').click();
      await page.keyboard.type('legacy');
      await page.getByLabel('Legacy password').click();
      await page.keyboard.type(sentinel.get);
      await page.getByRole('button', { name: 'Legacy sign in' }).click();
      await page.waitForURL(/results/);
      // A navigation typed in the address bar with a token in its query.
      await page.goto(`${fixture.urls.shop}/record-lab?tab=lots&token=${sentinel.typed}&q=${encodeURIComponent(sentinel.password)}`);
      await page.getByRole('heading', { name: 'Recording lab' }).waitFor();
    });
    const everything = [bytes, JSON.stringify(r), logs].join('\n');
    for (const [name, value] of Object.entries(sentinel)) {
      expect(everything.includes(value), `${name} leaked`).toBe(false);
      expect(everything.includes(value.replace(/ /g, '')), `${name} leaked`).toBe(false);
    }
    expect(everything).not.toContain(sentinel.password.slice(6));
    const types = r.events.filter((e): e is Extract<RecordedEvent, { kind: 'type' }> => e.kind === 'type');
    const kinds = types.map((t) => [t.el?.label ?? t.el?.name ?? '', t.secret, t.field_kind]);
    expect(kinds).toEqual([
      ['Password', true, 'password'],
      ['Password', true, 'password'],
      ['Field', true, 'secret'],
      ['Digit 1', true, 'one_time_code'],
      ['Digit 2', true, 'one_time_code'],
      ['Digit 3', true, 'one_time_code'],
      ['Digit 4', true, 'one_time_code'],
      ['Digit 5', true, 'one_time_code'],
      ['Digit 6', true, 'one_time_code'],
      ['Card', true, 'card_number'],
      ['Integration', true, 'api_key'],
      ['Email', true, 'secret'],
      ['Legacy user', false, 'text'],
      ['Legacy password', true, 'password'],
    ]);
    for (const t of types) if (t.secret) expect(t.text).toBeUndefined();
    // The revealed password, clicked: masked (and counted).
    expect(r.events.some((e) => e.kind === 'pointer' && e.redacted)).toBe(true);
    expect(r.counts.redacted).toBeGreaterThan(0);
    // Paths without a query; the typed navigation keeps its harmless keys only.
    expect(r.events.find((e) => e.kind === 'navigation' && e.cause === 'form')).toMatchObject({ path: '/record-lab/results' });
    const typed = r.events.find((e) => e.kind === 'navigation' && e.cause === 'typed');
    // A slow machine may record the typed navigation late or not at all; when it is there, it keeps its harmless keys only.
    if (MAC_TIMING || typed) expect(typed).toMatchObject({ path: '/record-lab', query: '?tab=lots' });
  }, 90_000);

  it('a password typed key by key: only its committed value is remembered — a word it starts with is not masked elsewhere', async () => {
    const pw = `Browse-${randomBytes(3).toString('hex')}!`;
    const { r, bytes } = await record(async (page) => {
      await page.locator('#lab-password').click();
      await page.keyboard.type(pw);
      await page.getByLabel('Note').click();
      await page.keyboard.type('Browse later');
      await page.getByRole('link', { name: 'Browse coffees' }).click();
      await page.waitForURL(/coffees/);
    });
    expect(bytes).not.toContain(pw);
    const note = r.events.find((e): e is Extract<RecordedEvent, { kind: 'type' }> => e.kind === 'type' && e.el?.label === 'Note');
    expect(note).toMatchObject({ secret: false, text: 'Browse later' });
    expect(r.events.find((e) => e.kind === 'pointer' && e.el?.href_path === '/coffees')).toMatchObject({ el: { target: { text: 'Browse coffees' } } });
    expect(r.events.some((e) => e.kind === 'pointer' && e.redacted)).toBe(false);
  }, 60_000);

  it('a known secret retyped in a plain field, its typing split by a blur (a visit to the Studio): no part of it is sent, one placeholder (review A-L2)', async () => {
    // Letters only, none of them a vowel: no 4-character run of it is in an event by chance.
    const letters = 'BCDFGHJKLMNPQRSTVWXZ';
    const secret = `Q${Array.from(randomBytes(15), (b) => letters[b % letters.length]).join('')}`;
    const { r, bytes } = await record(async (page) => {
      await page.locator('#lab-password').click();
      await page.keyboard.type(secret);
      const note = page.getByLabel('Note');
      await note.click();
      await page.keyboard.type(secret.slice(0, 8));
      await note.blur();
      await page.waitForTimeout(200);
      await note.focus();
      await page.keyboard.type(secret.slice(8));
      await page.getByRole('button', { name: 'Edit address' }).click();
    });
    for (let i = 0; i + 4 <= secret.length; i++) expect(bytes.includes(secret.slice(i, i + 4)), secret.slice(i, i + 4)).toBe(false);
    const notes = r.events.filter((e): e is Extract<RecordedEvent, { kind: 'type' }> => e.kind === 'type' && e.el?.label === 'Note');
    expect(notes.map((n) => n.secret)).toEqual([true, true]);
    const d = draftFromRecording(r.events, { name: 'split', env: 'test', envIsDefault: true, pages: { shop: fixture.urls.shop, console: fixture.urls.console }, persona: null, access: 'read-write' });
    expect(d.placeholders.map((p) => p.kind)).toEqual(['password', 'secret']);
    for (let i = 0; i + 4 <= secret.length; i++) expect(d.yaml.includes(secret.slice(i, i + 4))).toBe(false);
  }, 60_000);

  it('a token dropped as text into a plain field is a secret (as a paste is)', async () => {
    const token = `sk_Live-${randomBytes(4).toString('hex')}AbCdEf0123456789`;
    const { r, bytes } = await record(async (page) => {
      const cdp = await page.context().newCDPSession(page);
      const b = (await page.getByLabel('Note').boundingBox())!;
      const data = { items: [{ mimeType: 'text/plain', data: token }], dragOperationsMask: 1 };
      for (const type of ['dragEnter', 'dragOver', 'drop'] as const) await cdp.send('Input.dispatchDragEvent', { type, x: b.x + 10, y: b.y + 5, data });
      await page.waitForTimeout(200);
      expect(await page.getByLabel('Note').inputValue()).toBe(token);
      await page.getByRole('button', { name: 'Edit address' }).click();
    });
    expect(bytes).not.toContain(token);
    expect(r.events.find((e) => e.kind === 'type')).toMatchObject({ secret: true, field_kind: 'api_key', pasted: true });
  }, 60_000);

  it('a typed address with a token or an e-mail in its path or query: masked in the path, dropped from the query', async () => {
    const jwt = `eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJub2EifQ.Q7xLm2Rt${randomBytes(4).toString('hex')}Vw8NcY3sJd`;
    const invite = `Q7xLm2Rt9KfZp4Vw8N${randomBytes(3).toString('hex')}`;
    const { r, bytes } = await record(async (page) => {
      await page.getByRole('button', { name: 'Edit address' }).click();
      await page.waitForTimeout(1500);
      await page.goto(`${fixture.urls.shop}/record-lab/${jwt}?invite=${invite}&email=noa%40cafe.example&tab=lots`);
      await page.waitForTimeout(500);
      await page.goto(`${fixture.urls.shop}/record-lab/noa%40cafe.example`);
      await page.waitForTimeout(500);
    });
    for (const v of [jwt, invite, 'noa@cafe.example', 'noa%40cafe.example', 'cafe.example']) expect(bytes, v).not.toContain(v);
    const typed = r.events.filter((e) => e.kind === 'navigation' && e.cause === 'typed');
    expect(typed).toEqual([expect.objectContaining({ path: '/record-lab/•••', query: '?tab=lots' }), expect.objectContaining({ path: '/record-lab/•••' })]);
  }, 60_000);

  it('the hash the page and the runner share; tokens told from words', () => {
    expect(secretHash('hunter22', 7)).toBe(secretHash('hunter22', 7));
    expect(secretHash('hunter22', 7)).not.toBe(secretHash('hunter22', 8));
    expect(looksLikeToken('sk_live-AbCdEf0123456789')).toBe(true);
    expect(looksLikeToken('https://shop.example/coffees')).toBe(false);
    expect(looksLikeToken('a fine sentence with spaces in it')).toBe(false);
    // Path segments and query values: credentials and addresses, not slugs or ids.
    for (const v of [
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJub2EifQ.Q7xLm2Rt9KfZp4Vw8NcY3sJd',
      'Q7xLm2Rt9KfZp4Vw8NcY3sJd',
      '0f8e2b6c4a1d4e7f9b3c5a7d1e2f3a4b',
      '3f2c7a9e-1b4d-4c8e-9f0a-6d5e4c3b2a1f',
      'noa@cafe.example',
      'noa%40cafe.example',
      'a8f3k2j9d0s8f7g6h5j4k3l2',
    ]) {
      expect(looksLikeSecretSegment(v), v).toBe(true);
    }
    for (const v of ['products', 'single-origin-ethiopia-yirgacheffe-2024', 'how-to-brew-coffee-2024', '12345', 'Selowa_Ridge', 'lots']) expect(looksLikeSecretSegment(v), v).toBe(false);
    expect(maskPathSecrets('/reset/Q7xLm2Rt9KfZp4Vw8NcY3sJd/confirm')).toBe('/reset/•••/confirm');
    expect(maskPathSecrets('POST shop:/api/orders/42')).toBe('POST shop:/api/orders/42');
  });

  it('a password field in a closed shadow root: Space, Backspace and Delete typed there are never sent', async () => {
    const project = projectWith((p) => {
      p.config.environments = { test: { app: app.url } };
    });
    const { r } = await record(
      async (page) => {
        const b = (await page.locator('#closed').boundingBox())!;
        // The field sits after its label: the host has the focus, the field inside it cannot be seen from the page.
        await page.mouse.click(b.x + 100, b.y + b.height / 2);
        expect(await page.evaluate(() => document.activeElement?.id)).toBe('closed');
        await page.keyboard.type('correct horse battery staple');
        await page.keyboard.press('Backspace');
        await page.keyboard.press('Delete');
        // Outside it, a Space on a focused button is still a press.
        await page.getByRole('button', { name: 'Save' }).focus();
        await page.keyboard.press('Space');
      },
      { project, url: `${app.url}/app.html` },
    );
    expect(r.events.filter((e) => e.kind === 'key')).toEqual([]);
    expect(r.events.filter((e) => e.kind === 'pointer' && e.via === 'keyboard').map((e) => (e.kind === 'pointer' ? e.el?.text : null))).toEqual(['Save']);
  }, 60_000);
});

describe('recordSession: where it records', () => {
  it('a foreign origin: nothing of it is recorded, its host only; back on the environment, recording goes on', async () => {
    const secret = `Foreign-${randomBytes(3).toString('hex')}`;
    const { r, bytes } = await record(async (page) => {
      await page.goto(`${foreign.url}/elsewhere.html?x=${secret}`);
      await page.getByLabel('Code').click();
      await page.keyboard.type(secret);
      await page.getByRole('button', { name: 'Elsewhere' }).click();
      await page.goBack();
      await page.getByRole('heading', { name: 'Recording lab' }).waitFor();
      await page.waitForTimeout(300);
      await page.getByRole('button', { name: 'Edit address' }).click();
    });
    expect(bytes).not.toContain(secret);
    expect(bytes).not.toContain('elsewhere');
    expect(r.events.find((e) => e.kind === 'navigation' && e.where === 'foreign')).toMatchObject({ host: new URL(foreign.url).host, path: '' });
    expect(actions(r).map((e) => (e.kind === 'pointer' ? e.el?.text : e.kind))).toEqual(['Edit address']);
  }, 60_000);

  it('a sign-in page: nothing typed or clicked there is recorded (counted); the page it lands on is', async () => {
    const project = projectWith((p) => {
      p.config.environments = { test: { console: fixture.urls.signedIn!.console, shop: fixture.urls.signedIn!.shop } };
      p.config.auth = { test: { login_url: '/sign-in' } } as LoadedProject['config']['auth'];
    });
    const { r, bytes, logs } = await record(
      async (page) => {
        await page.waitForURL(/sign-in/);
        await page.getByLabel('Email').click();
        await page.keyboard.type(BUYER.email);
        await page.getByLabel('Password').click();
        await page.keyboard.type(BUYER.password);
        await page.getByRole('button', { name: 'Sign in' }).click();
        await page.getByRole('heading', { name: 'Recording lab' }).waitFor();
        await page.waitForTimeout(300);
        await page.getByRole('button', { name: 'Edit address' }).click();
      },
      { project, url: `${fixture.urls.signedIn!.shop}/record-lab` },
    );
    const everything = [bytes, JSON.stringify(r), logs].join('\n');
    expect(everything).not.toContain(BUYER.password);
    expect(everything).not.toContain(BUYER.email);
    expect(r.events[0]).toMatchObject({ kind: 'navigation', where: 'sign_in', path: '/sign-in' });
    expect(r.counts.dropped.sign_in).toBeGreaterThanOrEqual(3);
    expect(r.events.some((e) => e.kind === 'dropped' && e.reason === 'sign_in')).toBe(true);
    expect(r.events.filter((e) => e.path.startsWith('/sign-in') && e.kind !== 'navigation')).toEqual([]);
    expect(actions(r).map((e) => (e.kind === 'pointer' ? e.el?.text : e.kind))).toEqual(['Edit address']);
    expect(r.warnings.join(' ')).toMatch(/sign-in page were not recorded/);
  }, 60_000);
});

describe('recordSession: a persona', () => {
  it("records on a copy of the persona's session (signed in), its master untouched", async () => {
    const project = projectWith((p) => {
      p.config.environments = { test: { console: fixture.urls.signedIn!.console, shop: fixture.urls.signedIn!.shop } };
      p.config.auth = {
        test: {
          login_url: '/sign-in',
          personas: {
            supplier: {
              pages: ['console'],
              check: { url: 'console:/products', expect_text: 'Maja Lindqvist' },
              login: [
                { open: 'console:/sign-in' },
                { type: { into: { label: 'Email' }, text: 'maja@northfield.example' } },
                { type: { into: { label: 'Password' }, text: '{{env:NF_TEST_SUPPLIER}}' } },
                { click: { role: 'button', name: 'Sign in' } },
                { wait_for: { text: 'Maja Lindqvist' } },
              ],
            },
          },
        },
      } as LoadedProject['config']['auth'];
    });
    const env = resolveEnvironment(project, 'test');
    const persona = resolvePersonas(project, 'test', { home: retakeHome() }).find((x) => x.name === 'supplier')!;
    await signIn({ policy: PERSON_POLICY, project, env, persona, mode: 'auto', resolveSecret: async () => SUPPLIER_PASSWORD });
    const prefs = join(persona.profileDir!, 'Default', 'Preferences');
    const before = await readFile(prefs, 'utf8');
    const { r, bytes } = await record(
      async (page) => {
        await page.getByText('Maja Lindqvist').first().waitFor();
        await page.waitForTimeout(300);
        await page.getByRole('button', { name: 'Product actions' }).first().click();
      },
      { project, persona, url: `${fixture.urls.signedIn!.console}/products` },
    );
    expect(r.persona).toBe('supplier');
    expect(r.events[0]).toMatchObject({ kind: 'navigation', where: 'environment', page_key: 'console', path: '/products' });
    expect(actions(r)).toEqual([expect.objectContaining({ kind: 'pointer', el: expect.objectContaining({ action: { kind: 'menu', row: expect.any(String), verified: true } }) })]);
    expect(bytes).not.toContain(SUPPLIER_PASSWORD);
    // The window ran on a copy: the master's Preferences are as signIn left them.
    expect(await readFile(prefs, 'utf8')).toBe(before);
  }, 90_000);

  it('the window profile: password manager and autofill off, other preferences kept', async () => {
    const d = await tempDir('ds-record-prefs-');
    try {
      await disableAutofill(d);
      await writeFile(join(d, 'Default', 'Preferences'), JSON.stringify({ browser: { theme: 1 }, autofill: { last_version: 3 } }));
      await disableAutofill(d);
      const p = JSON.parse(await readFile(join(d, 'Default', 'Preferences'), 'utf8')) as Record<string, unknown>;
      expect(p).toEqual({
        browser: { theme: 1 },
        credentials_enable_service: false,
        credentials_enable_autosignin: false,
        profile: { password_manager_enabled: false },
        autofill: { last_version: 3, enabled: false, profile_enabled: false, credit_card_enabled: false },
      });
      expect(statSync(join(d, 'Default', 'Preferences')).mode & 0o777).toBe(0o600);
    } finally {
      await rm(d, { recursive: true, force: true });
    }
  });
});

describe('recordSession: writes', () => {
  it("a read-only environment: the write guard stops the window's writes, listed; nothing reaches the app", async () => {
    const project = projectWith((p) => {
      p.config.environment_settings = { test: { production: true } };
    });
    const before = await mutations();
    const { r } = await record(
      async (page) => {
        await page.getByRole('button', { name: 'Mark notifications read' }).click();
        await page.getByText('Could not mark them read').waitFor();
      },
      { project },
    );
    expect(await mutations()).toBe(before);
    expect(r.access).toBe('read-only');
    expect(r.events.filter((e) => e.kind === 'write')).toEqual([expect.objectContaining({ method: 'POST', label: 'POST shop:/api/notifications/read', outcome: 'blocked' })]);
    expect(r.warnings.join(' ')).toMatch(/read-only/);
  }, 60_000);

  it('a read-write environment: the write happens and is listed after the press that sent it', async () => {
    const before = await mutations();
    const { r } = await record(async (page) => {
      await page.getByRole('button', { name: 'Mark notifications read' }).click();
      await page.getByText('Notifications marked read').waitFor();
    });
    expect(await mutations()).toBe(before + 1);
    expect(r.counts.writes).toBe(1);
    const i = r.events.findIndex((e) => e.kind === 'write');
    expect(r.events[i]).toMatchObject({ label: 'POST shop:/api/notifications/read', outcome: 'passed' });
    expect(r.events[i - 1]).toMatchObject({ kind: 'pointer', el: { text: 'Mark notifications read' } });
  }, 60_000);
});

describe('recordSession: writes to another host', () => {
  it('a read-write environment whose API is on another host: its writes (a fetch, a beacon) are listed, token-like path segments masked', async () => {
    const project = projectWith((p) => {
      p.config.environments = { test: { app: app.url } };
    });
    const hits = foreign.hits.length;
    const { r, bytes } = await record(
      async (page) => {
        await page.getByRole('button', { name: 'Place order' }).click();
        await page.getByText('Order placed').waitFor();
        await page.getByRole('button', { name: 'Leave' }).click();
        await page.getByText('Left').waitFor();
        await page.waitForTimeout(300);
      },
      { project, url: `${app.url}/app.html` },
    );
    // Both writes reached the other host, and both are listed (the check replay stops before the first).
    expect(foreign.hits.slice(hits).map((h) => h.method)).toEqual(['POST', 'POST']);
    const host = new URL(foreign.url).host;
    expect(r.events.filter((e) => e.kind === 'write').map((e) => (e.kind === 'write' ? [e.label, e.outcome] : null))).toEqual([
      [`POST ${host}/orders/•••`, 'passed'],
      [`POST ${host}/collect`, 'passed'],
    ]);
    expect(r.counts.writes).toBe(2);
    expect(bytes).not.toContain('Q7xLm2Rt9KfZp4Vw8NcY3sJd');
  }, 60_000);
});

describe('recordSession: how it ends', () => {
  it('stop: the field being typed in is committed, the window closes, everything is kept', async () => {
    const stop = new AbortController();
    const { r } = await record(
      async (page) => {
        await page.getByLabel('Note').click();
        await page.keyboard.type('Half a sentence');
        stop.abort();
        await page.waitForEvent('close').catch(() => undefined);
      },
      { stop: stop.signal },
    );
    expect(r.stop).toBe('stopped');
    expect(r.events.find((e) => e.kind === 'type')).toMatchObject({ text: 'Half a sentence' });
    expect(r.events.at(-1)).toMatchObject({ kind: 'stop', reason: 'stopped' });
  }, 60_000);

  it('the maximum duration stops it and keeps it', async () => {
    const { r } = await record(
      async (page) => {
        await page.waitForEvent('close').catch(() => undefined);
      },
      { maxMs: 2500 },
    );
    expect(r.stop).toBe('max_duration');
  }, 60_000);

  it('cancel: the window closes, the events file is removed, a CancelledError', async () => {
    const cancel = new AbortController();
    const file = join(dir, 'cancelled.jsonl');
    const project = projectWith();
    const p = recordSession({
      policy: PERSON_POLICY,
      project,
      env: resolveEnvironment(project, 'test'),
      url: `${fixture.urls.shop}/record-lab`,
      eventsFile: file,
      headless: true,
      windowSize: { width: 1200, height: 900 },
      signal: cancel.signal,
      drive: async (page) => {
        await page.getByRole('heading', { name: 'Recording lab' }).waitFor();
        await page.waitForTimeout(300);
        await page.getByRole('button', { name: 'Edit address' }).click();
        cancel.abort();
      },
    });
    await expect(p).rejects.toBeInstanceOf(CancelledError);
    expect(existsSync(file)).toBe(false);
  }, 60_000);

  it('a window narrower than the capture is warned about', async () => {
    const project = projectWith((p) => {
      p.config.capture = { ...p.config.capture, width: 1920, height: 1080 };
    });
    const { r } = await record(async () => undefined, { project, windowSize: { width: 1000, height: 800 } });
    expect(r.warnings.join(' ')).toMatch(/narrower than the capture \(1920×1080\)/);
  }, 60_000);
});

describe('recordSession: cost of a press', () => {
  it('a page of 10,000 controls: the press is recorded, its in-page cost measured', async () => {
    const { r } = await record(
      async (page) => {
        await page.getByRole('heading', { name: 'Inventory' }).waitFor();
        const row = page.getByRole('row', { name: /^Item 2500 / });
        await row.scrollIntoViewIfNeeded();
        await row.getByRole('button', { name: 'Save' }).click();
      },
      { url: `${fixture.urls.shop}/inspect-lab?rows=5000` },
    );
    const press = r.events.find((e): e is Extract<RecordedEvent, { kind: 'pointer' }> => e.kind === 'pointer');
    expect(press).toBeTruthy();
    // Either a verified target or the description fallback; `ms` is the app's wait at pointerdown.
    expect(press!.el?.target ?? press!.el?.desc).toBeTruthy();
    console.log(`record: a press on a 5,000-row page took ${press!.ms} ms in the page (target ${JSON.stringify(press!.el?.target ?? null)})`);
    expect(press!.ms).toBeLessThan(3000);
  }, 90_000);
});
