/**
 * L3.4 recordings (engine record.ts, R-MCP-24): record → draft → validate → save → check replay, on the fixture, with
 * Playwright standing in for the person (trusted input; the "headed" window runs headless here — the real window is
 * MACOS-CHECKLIST 12f). The quote flow (shop: select, date clicks, typing, a write) and the catalogue flow (console:
 * select, drop_file, an address-bar navigation, a row menu with its confirm, a pick) round trip: the drafts validate, are
 * saved, the check replay passes up to the step before the first write, and a full dry run of the saved draft succeeds
 * on a reset fixture. Also: a taken name (kept, not saved), stop and keep / cancel and discard, the maximum duration,
 * nothing recorded, a read-only environment (writes mocked, the whole draft checked), refusals before the window opens
 * (a persona that cannot sign in, another origin, a bad RETAKE_RECORD_MAX_MIN), and a secret typed in the
 * recording lab absent from every file and result.
 */
import { existsSync, statSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseScenario, PERSON_POLICY } from '@retake/core';
import { loadScenario, fileFacts } from '@retake/core/io';
import type { LoadedProject } from '@retake/core';
import { runScenario } from '@retake/runner-web';
import { EngineError, FileJobQueue, historyFile, openProject, openWorkspace, recordScenario, recordsRoot, enginePorts } from '../src/index.js';
import type { OpenedWorkspace, RecordOutcome, RecordPorts, RecordRequest } from '../src/index.js';
import { ManualClock } from '../src/clock.js';
import { MemoryCaptureRunner } from '../src/capture/memory-capture.js';
import { MemorySessions, memoryRecord } from '../src/capture/memory-sessions.js';
import type { MemoryRecordOptions, MemorySessionsOptions } from '../src/capture/memory-sessions.js';
import { REPO, fixtureWorkspace } from './helpers.js';
import { oneButtonPress } from './recorded-events.js';

type Page = Parameters<NonNullable<RecordPorts['drive']>>[0];

interface Fixture {
  urls: { console: string; shop: string; signedIn?: { console: string; shop: string } };
  close(): Promise<void>;
}

const PROJECT = 'northfield-fixture';
let fixture: Fixture;
let root: string;
let ws: OpenedWorkspace;
let csv: string;
const saved = { home: process.env.RETAKE_HOME, max: process.env.RETAKE_RECORD_MAX_MIN, buyer: process.env.NORTHFIELD_BUYER_PASSWORD };

beforeAll(async () => {
  const mod = (await import(join(REPO, 'fixtures/wholesale/server.mjs'))) as {
    startFixture(o: { consolePort: number; shopPort: number; host: string; auth: { consolePort: number; shopPort: number } }): Promise<Fixture>;
  };
  fixture = await mod.startFixture({ consolePort: 0, shopPort: 0, host: '127.0.0.1', auth: { consolePort: 0, shopPort: 0 } });
  root = await mkdtemp(join(tmpdir(), 'studio-record-'));
  process.env.RETAKE_HOME = join(root, '.home');
  delete process.env.RETAKE_RECORD_MAX_MIN;
  delete process.env.NORTHFIELD_BUYER_PASSWORD;
  await fixtureWorkspace(root);
  const projectDir = join(root, 'projects', PROJECT);
  const strip = (u: string) => u.replace(/\/$/, '');
  const yaml = (await readFile(join(projectDir, 'project.yaml'), 'utf8'))
    .replaceAll('http://localhost:4401', strip(fixture.urls.console))
    .replaceAll('http://localhost:4402', strip(fixture.urls.shop))
    .replaceAll('http://localhost:4403', strip(fixture.urls.signedIn!.console))
    .replaceAll('http://localhost:4404', strip(fixture.urls.signedIn!.shop));
  await writeFile(join(projectDir, 'project.yaml'), yaml);
  csv = join(root, 'prices.csv');
  await writeFile(csv, 'lot,price\nA,10\n');
  ws = await openWorkspace({ root, agent: false });
}, 120_000);

afterAll(async () => {
  await fixture?.close();
  if (root) await rm(root, { recursive: true, force: true });
  for (const [k, v] of [
    ['RETAKE_HOME', saved.home],
    ['RETAKE_RECORD_MAX_MIN', saved.max],
    ['NORTHFIELD_BUYER_PASSWORD', saved.buyer],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const project = (): Promise<LoadedProject> => openProject(ws, PROJECT);

async function reset(): Promise<void> {
  await fetch(`${fixture.urls.console}/api/reset`, { method: 'POST' });
}

/** Record with `drive` playing the person; the window closes after it. */
async function record(req: RecordRequest, drive: (page: Page) => Promise<void>, ports: Partial<RecordPorts> = {}): Promise<{ o: RecordOutcome; logs: string[] }> {
  const logs: string[] = [];
  const o = await recordScenario(ws, await project(), req, { ...enginePorts(),
    queue: new FileJobQueue(ws.root),
    headless: true,
    windowSize: { width: 1400, height: 1000 },
    log: (l, m) => logs.push(`${l} ${m}`),
    drive: async (page) => {
      await page.waitForLoadState('domcontentloaded');
      // A person needs a moment before the first action (the page renders, the recorder is told where it is).
      await page.waitForTimeout(800);
      await drive(page);
      await page.waitForTimeout(400).catch(() => undefined);
      await page.close().catch(() => undefined);
    },
    ...ports,
  });
  return { o, logs };
}

/**
 * Record through the in-memory capture runner (the engine's logic: preflight, folders, draft, save, history): its window
 * "presses" Request a quote on the shop's first page, then closes, unless `m` says otherwise. `memoryWindows` counts
 * the windows it opened.
 */
let memoryWindows = 0;
async function recordInMemory(
  req: RecordRequest,
  m: MemoryRecordOptions & { sessions?: MemorySessionsOptions } = {},
  ports: Partial<RecordPorts> = {},
): Promise<{ o: RecordOutcome; logs: string[] }> {
  const logs: string[] = [];
  const window = memoryRecord({ events: oneButtonPress({ pageKey: 'shop', button: 'Request a quote' }), ...m });
  const capture = new MemoryCaptureRunner({ sessions: new MemorySessions(m.sessions), record: async (o) => (memoryWindows++, window(o)) });
  // `drive` stands for the person (no display needed); the in-memory window never reads it.
  const o = await recordScenario(ws, await project(), req, { ...enginePorts({ capture }), queue: new FileJobQueue(ws.root), drive: async () => undefined, log: (l, msg) => logs.push(`${l} ${msg}`), ...ports });
  return { o, logs };
}

/** A full dry run of a saved scenario on a reset fixture (hooks skipped): the draft replays from the start. */
async function dryRun(name: string): Promise<{ status: string; error?: string }> {
  await reset();
  const p = await project();
  const r = await runScenario({ policy: PERSON_POLICY, project: p, scenario: await loadScenario(p, name, { files: fileFacts(PERSON_POLICY) }), mode: 'dry', runsDir: join(root, 'dry-runs') });
  return { status: r.status, ...(r.error ? { error: r.error.message } : {}) };
}

async function quoteFlow(page: Page): Promise<void> {
  await page.mouse.wheel(0, 900);
  await page.waitForTimeout(800);
  await page.getByText('Selowa Ridge').first().click();
  await page.getByRole('button', { name: 'Request a quote' }).waitFor();
  await page.waitForTimeout(1800);
  await page.getByRole('button', { name: 'Request a quote' }).click();
  await page.waitForTimeout(500);
  await page.getByRole('dialog').getByLabel('Increase').click();
  await page.getByRole('dialog').getByLabel('Increase').click();
  await page.getByRole('combobox', { name: 'Bag size' }).click();
  await page.waitForTimeout(400);
  await page.getByRole('option', { name: '5 kg' }).click();
  await page.waitForTimeout(300);
  await page.getByRole('combobox', { name: 'Grind' }).click();
  await page.waitForTimeout(400);
  await page.getByRole('option', { name: 'Whole bean' }).click();
  await page.waitForTimeout(300);
  // The date picker is recorded as clicks (its mapping to `date:` is BL-74); the product's clock makes them replay.
  await page.getByLabel('Delivery window').click();
  await page.waitForTimeout(400);
  await page.getByLabel('Next month').click();
  await page.waitForTimeout(300);
  await page.getByLabel('10 January 2027').click();
  await page.waitForTimeout(200);
  await page.getByLabel('24 January 2027').click();
  // The popover closes 420 ms after the second date and gives the focus back to its trigger: a person waits for it to
  // go before clicking the next field (else, on a loaded machine, the focus can land on the trigger after the click).
  await page.getByLabel('Choose a delivery window').waitFor({ state: 'hidden' });
  await page.getByLabel('Message').click();
  await page.waitForFunction(() => document.activeElement?.id === 'quote-message', null, { timeout: 5000 });
  await page.keyboard.type('Light roast for filter, please.');
  await page.getByRole('dialog').getByText('Send request').click();
  await page.getByText('Quote request sent').waitFor();
  await page.waitForTimeout(500);
}

async function catalogueFlow(page: Page): Promise<void> {
  await page.getByText('New import').click();
  await page.waitForTimeout(500);
  await page.locator('#import-organization').click();
  await page.waitForTimeout(400);
  await page.getByRole('option', { name: 'Northfield Roasters' }).click();
  await page.waitForTimeout(300);
  const chooser = page.waitForEvent('filechooser');
  await page.getByText('Click to choose a file').click();
  await (await chooser).setFiles(csv);
  await page.waitForTimeout(300);
  await page.getByRole('dialog').getByText('Start import').click();
  await page.getByText('921 offers created').waitFor({ timeout: 15_000 });
  await page.waitForTimeout(600);
  // The address bar: a new scene that opens its page.
  await page.goto(new URL('/availability/products/finca-lirandel-geisha', page.url()).href);
  await page.waitForTimeout(800);
  await page.getByRole('row', { name: /Iceland/ }).getByRole('button').last().click();
  await page.waitForTimeout(400);
  await page.getByRole('menuitem', { name: 'Pause' }).click();
  await page.waitForTimeout(400);
  await page.getByRole('alertdialog').getByRole('button', { name: 'Pause' }).click();
  await page.waitForTimeout(500);
  await page.getByRole('row', { name: /Sweden/ }).getByRole('button').last().click();
  await page.waitForTimeout(400);
  await page.getByRole('menuitem', { name: 'Edit' }).click();
  await page.waitForTimeout(500);
  await page.locator('#edit-bag-sizes').click();
  await page.waitForTimeout(400);
  await page.getByRole('option', { name: '1 kg' }).click();
  await page.waitForTimeout(300);
  await page.getByRole('option', { name: '5 kg' }).click();
  await page.waitForTimeout(300);
  // Closes the popover: a press outside it, on the dialog's title.
  await page.getByRole('dialog').getByRole('heading').first().click();
  await page.waitForTimeout(400);
  await page.getByRole('dialog').getByText('Save').click();
  await page.waitForTimeout(800);
}

type Steps = Array<Record<string, unknown>>;
function scenesOf(yaml: string): Array<{ id: string; page?: string; open?: string; steps: Steps }> {
  const { scenario, issues } = parseScenario(yaml);
  expect(issues.filter((i) => i.severity === 'error')).toEqual([]);
  return scenario!.scenes as unknown as Array<{ id: string; page?: string; open?: string; steps: Steps }>;
}
const mode = (p: string) => statSync(p).mode & 0o777;

describe('recordScenario: round trips on the fixture', () => {
  it('the quote flow: a draft that validates, saved under the default name, checked up to the step before the write, and a full dry run succeeds', async () => {
    await reset();
    const { o } = await record({ page: 'shop' }, quoteFlow);
    expect(o.stop).toBe('closed');
    expect(o.name).toMatch(/^recorded-\d{8}-\d{4}(-\d+)?$/);
    expect(o.saved?.file).toBe(`scenarios/${o.name}.yaml`);
    expect(o.access).toBe('read-write');
    expect(o.persona).toBeNull();
    expect(o.writes).toEqual({ total: 1, by_steps: 1, ambient: 0, first: { scene: 'products', step: expect.any(Number) } });
    expect(o.check).toMatchObject({ status: 'passed', scope: 'until_write' });
    expect(o.check.until).toBe(`products.${o.writes.first!.step - 1}`);
    expect(o.check.steps_passed).toBe(o.check.steps_total);
    expect(o.check.steps_total).toBeGreaterThan(8);

    const text = await readFile(join((await project()).dir, 'scenarios', `${o.name}.yaml`), 'utf8');
    expect(text).toBe(await readFile(o.draft!, 'utf8'));
    const scenes = scenesOf(text);
    expect(scenes.map((s) => [s.id, s.page, s.open])).toEqual([
      ['home', 'shop', '/'],
      ['products', undefined, undefined],
    ]);
    const steps = scenes.flatMap((s) => s.steps);
    expect(steps.filter((s) => 'select' in s)).toEqual([{ select: { field: 'Bag size', option: '5 kg' } }, { select: { field: 'Grind', option: 'Whole bean' } }]);
    expect(steps.filter((s) => JSON.stringify(s).includes('Increase'))).toHaveLength(2);
    expect(steps).toContainEqual({ wait_for: { target: 'Request a quote', timeout: 15 } });
    expect(steps).toContainEqual({ type: { into: { label: 'Message' }, text: 'Light roast for filter, please.' } });
    expect(steps.at(-1)).toEqual({ click: 'Send request', note: 'sends POST shop:/api/quotes' });
    expect(text).not.toMatch(/^\s*- (wait|hold):/m);
    expect(text).not.toMatch(/https?:/);
    expect(text).toMatch(/^version: 1$/m);

    // The folder: private, the events streamed, the record.json without page text in its summary fields.
    expect(mode(o.dir!)).toBe(0o700);
    for (const f of ['events.jsonl', 'draft.yaml', 'record.json']) expect(mode(join(o.dir!, f)), f).toBe(0o600);
    expect(existsSync(join(o.dir!, 'check', 'run.json'))).toBe(true);
    expect(existsSync(join(o.dir!, 'check', 'screenshots'))).toBe(false);
    const rj = JSON.parse(await readFile(join(o.dir!, 'record.json'), 'utf8')) as { saved: string; check: { status: string }; writes: Array<{ label: string }> };
    expect(rj.saved).toBe(o.saved!.file);
    expect(rj.check.status).toBe('passed');
    expect(rj.writes.map((w) => w.label)).toEqual(['POST shop:/api/quotes']);
    // History: counts only.
    const last = JSON.parse((await readFile(historyFile(root), 'utf8')).trim().split('\n').at(-1)!) as Record<string, unknown>;
    expect(last).toMatchObject({ kind: 'record', project: PROJECT, submitted_by: 'cli', state: 'succeeded', record: { id: o.rec_id, saved: true }, counted: { captures: 0, dry_runs: 0, renders: 0 } });
    expect(JSON.stringify(last)).not.toContain('Light roast');

    expect(await dryRun(o.name)).toEqual({ status: 'succeeded' });
  }, 180_000);

  it('the catalogue flow: select, drop_file, an address-bar scene, a row menu with its confirm, a pick — validates, checked, dry run succeeds', async () => {
    await reset();
    const { o } = await record({ page: 'console', path: '/imports', name: 'my-catalogue' }, catalogueFlow);
    expect(o.saved?.file).toBe('scenarios/my-catalogue.yaml');
    const scenes = scenesOf(await readFile(o.draft!, 'utf8'));
    expect(scenes.map((s) => [s.id, s.page, s.open])).toEqual([
      ['imports', 'console', '/imports'],
      ['availability', undefined, '/availability/products/finca-lirandel-geisha'],
    ]);
    const steps = scenes.flatMap((s) => s.steps);
    expect(steps).toContainEqual({ select: { field: 'Organisation', option: 'Northfield Roasters' } });
    expect(steps).toContainEqual({ drop_file: { zone: expect.anything(), name: 'prices.csv', fake: true } });
    expect(steps).toContainEqual(expect.objectContaining({ menu: { row: 'Iceland', item: 'Pause', confirm: 'Pause' } }));
    expect(steps).toContainEqual({ menu: { row: 'Sweden', item: 'Edit' } });
    expect(steps).toContainEqual({ pick: { field: 'Bag sizes', option: ['1 kg', '5 kg'], close: 'outside' } });
    expect(o.issues.map((i) => i.code)).toEqual(expect.arrayContaining(['fake_file', 'opened_by_address']));
    // The first write is the import's start: the check replays the three steps before it.
    expect(o.writes.first).toEqual({ scene: 'imports', step: 3 });
    expect(o.check).toMatchObject({ status: 'passed', scope: 'until_write', until: 'imports.2', steps_passed: 3, steps_total: 3 });
    expect(await dryRun('my-catalogue')).toEqual({ status: 'succeeded' });
  }, 180_000);
});

describe('recordScenario: names, stop, cancel, limits', () => {
  const oneClick = async (page: Page) => {
    await page.getByText('Selowa Ridge').first().click();
    await page.getByRole('button', { name: 'Request a quote' }).waitFor();
  };

  it('a taken name: the draft is kept in the recording\'s folder, never saved over the scenario; the check still runs', async () => {
    const p = await project();
    const before = await readFile(join(p.dir, 'scenarios', 'quote.yaml'), 'utf8');
    const { o } = await record({ page: 'shop', name: 'quote' }, oneClick);
    expect(o.saved).toBeNull();
    expect(o.not_saved).toBe('name_taken');
    expect(o.warnings.join('\n')).toMatch(/scenario quote exists/);
    expect(existsSync(o.draft!)).toBe(true);
    expect(await readFile(join(p.dir, 'scenarios', 'quote.yaml'), 'utf8')).toBe(before);
    expect(o.check).toMatchObject({ status: 'passed', scope: 'all' });
  }, 120_000);

  it('stop keeps what was recorded; cancel discards it (the folder removed); nothing done = nothing recorded', async () => {
    const stop = new AbortController();
    // The recording's stamps come from the clock of its ports (the engine's), never the system's.
    const at = '2030-06-15T10:20:30.000Z';
    const { o } = await recordInMemory({ page: 'shop', check: false }, { during: async () => stop.abort() }, { stop: stop.signal, clock: new ManualClock(at) });
    expect(o.stop).toBe('stopped');
    expect(o.saved).not.toBeNull();
    expect(o.check).toMatchObject({ status: 'skipped', reason: 'disabled' });
    expect((JSON.parse(await readFile(join(o.dir!, 'meta.json'), 'utf8')) as { started_at: string }).started_at).toBe(at);
    const local = new Date(at);
    const two = (n: number) => String(n).padStart(2, '0');
    expect(o.name).toMatch(new RegExp(`^recorded-${local.getFullYear()}${two(local.getMonth() + 1)}${two(local.getDate())}-${two(local.getHours())}${two(local.getMinutes())}(-\\d+)?$`));
    const line = JSON.parse((await readFile(historyFile(root), 'utf8')).trim().split('\n').at(-1)!) as Record<string, unknown>;
    expect(line).toMatchObject({ kind: 'record', at, record: { id: basename(o.dir!) } });

    const p = await project();
    const folders = await readdir(recordsRoot(p));
    const cancel = new AbortController();
    const e = await recordInMemory({ page: 'shop' }, { during: async () => cancel.abort() }, { signal: cancel.signal }).then(
      () => null,
      (x: unknown) => x as EngineError,
    );
    expect(e).toBeInstanceOf(EngineError);
    expect(e!.code).toBe('cancelled');
    expect(await readdir(recordsRoot(p))).toEqual(folders);

    const { o: none } = await recordInMemory({ page: 'shop' }, { events: [] });
    expect(none).toMatchObject({ dir: null, draft: null, saved: null, not_saved: 'nothing_recorded', check: { status: 'skipped', reason: 'nothing_recorded' } });
    expect(await readdir(recordsRoot(p))).toEqual(folders);
  });

  it('RETAKE_RECORD_MAX_MIN: the recording stops at it and keeps what it has; a bad value is refused before the window opens', async () => {
    process.env.RETAKE_RECORD_MAX_MIN = '0.05';
    try {
      const { o } = await record({ page: 'shop', check: false }, async (page) => {
        await oneClick(page);
        await page.waitForEvent('close', { timeout: 15_000 }).catch(() => undefined);
      });
      expect(o.stop).toBe('max_duration');
      expect(o.counts.actions).toBe(1);
      expect(o.issues.map((i) => i.code)).toContain('max_duration');
      process.env.RETAKE_RECORD_MAX_MIN = 'soon';
      const e = await recordScenario(ws, await project(), { page: 'shop' }, { ...enginePorts(), queue: new FileJobQueue(ws.root), headless: true, drive: async () => undefined }).then(
        () => null,
        (x: unknown) => x as EngineError,
      );
      expect(e?.code).toBe('invalid');
    } finally {
      delete process.env.RETAKE_RECORD_MAX_MIN;
    }
  }, 120_000);
});

describe('recordScenario: access, sign-in, secrets', () => {
  it('a read-only environment: the window\'s writes are answered by a mock, noted on their step; the whole draft is checked', async () => {
    const { o } = await record({ env: 'production', page: 'shop', path: '/record-lab', name: 'bell' }, async (page) => {
      await page.getByRole('heading', { name: 'Recording lab' }).waitFor();
      await page.getByRole('button', { name: 'Mark notifications read' }).click();
      await page.waitForTimeout(800);
    });
    expect(o.access).toBe('read-only');
    expect(o.writes.total).toBe(1);
    const text = await readFile(o.draft!, 'utf8');
    expect(text).toContain('env: production');
    expect(text).toContain('note: "sends POST shop:/api/notifications/read (answered by a mock: read-only)"');
    expect(o.check).toMatchObject({ status: 'passed', scope: 'all' });
  }, 120_000);

  it('refused before any window opens: a persona that cannot sign in (with the command that signs it in), another origin, an unknown page', async () => {
    const p = await project();
    const folders = existsSync(recordsRoot(p)) ? await readdir(recordsRoot(p)) : [];
    // The buyer's saved session is expired and its login steps fail (its password is not set here).
    const sessions: MemorySessionsOptions = {
      checks: { buyer: { status: 'expired', detail: 'shop:/account landed on the sign-in page', ms: 0 } },
      signIn: () => new Error('{{env:NORTHFIELD_BUYER_PASSWORD}} is not set'),
    };
    const windows = memoryWindows;
    const refusal = (req: RecordRequest) =>
      recordInMemory(req, { sessions }).then(
        () => null,
        (x: unknown) => x as EngineError,
      );
    const buyer = await refusal({ env: 'signed-in', page: 'shop' });
    expect(buyer?.code).toBe('refused');
    expect(buyer?.message).toMatch(/persona buyer could not be signed in/);
    expect(buyer?.fix).toMatch(/retake login northfield-fixture --env signed-in --persona buyer/);
    expect((await refusal({ url: 'http://elsewhere.example/' }))?.code).toBe('refused');
    expect((await refusal({ page: 'nowhere' }))?.code).toBe('not_found');
    expect((await refusal({ page: 'shop', persona: 'nobody' }))?.code).toBe('not_found');
    expect((await refusal({ page: 'shop', name: '../x' }))?.code).toBe('invalid');
    expect(existsSync(recordsRoot(p)) ? await readdir(recordsRoot(p)) : []).toEqual(folders);
    expect(memoryWindows).toBe(windows);
  });

  it('a persona whose saved session expired is signed in by its login steps (headless) before the window opens, signed in as it', async () => {
    const sessions = new MemorySessions({ checks: { buyer: { status: 'expired', detail: 'shop:/account landed on the sign-in page', ms: 0 } } });
    const capture = new MemoryCaptureRunner({ sessions, record: memoryRecord({ events: oneButtonPress({ pageKey: 'shop', button: 'Request a quote' }) }) });
    const logs: string[] = [];
    const o = await recordScenario(ws, await project(), { env: 'signed-in', page: 'shop', check: false }, { ...enginePorts({ capture }), queue: new FileJobQueue(ws.root), drive: async () => undefined, log: (l, m) => logs.push(`${l} ${m}`) });
    expect(sessions.calls).toEqual([
      { member: 'check', persona: 'buyer' },
      { member: 'signIn', persona: 'buyer', mode: 'auto' },
    ]);
    expect(logs).toContain('info persona buyer: session expired — signing in with its login steps (headless)');
    expect(o.persona).toBe('buyer');
    expect(o.counts.actions).toBe(1);
  });

  it('text typed with a {{…}} template (submitted through MCP): left out with an issue at its place, so the draft is saved under agent trust and its check resolves nothing', async () => {
    const { o, logs } = await record({ page: 'shop', path: '/record-lab', name: 'lab-template', agent: true }, async (page) => {
      await page.getByRole('heading', { name: 'Recording lab' }).waitFor();
      await page.getByLabel('Note').click();
      await page.keyboard.type('Hi {{env:HOME}} and {{vars.first_name}}');
      await page.getByRole('button', { name: 'Edit address' }).click();
      await page.waitForTimeout(300);
    });
    const text = await readFile(o.draft!, 'utf8');
    expect(text).not.toContain('{{');
    expect(o.saved?.file).toBe('scenarios/lab-template.yaml');
    expect(o.issues.find((i) => i.code === 'template_text')).toMatchObject({ severity: 'warning', scene: 'record-lab', step: 1 });
    expect(scenesOf(text)[0].steps).toEqual([{ click: { label: 'Note' } }, { click: 'Edit address' }]);
    expect(o.check).toMatchObject({ status: 'passed' });
    expect(JSON.stringify(o) + logs.join('\n')).not.toMatch(/env:HOME|first_name/);
  }, 120_000);

  it('a draft that cannot be saved (a file error): an error issue with a fixed message, the log never quotes the error', async () => {
    const p = await project();
    const dir = join(p.dir, 'scenarios');
    const { chmod } = await import('node:fs/promises');
    await chmod(dir, 0o500);
    let o: RecordOutcome;
    let logs: string[];
    try {
      ({ o, logs } = await recordInMemory({ page: 'shop', name: 'cannot-save', check: false }));
    } finally {
      await chmod(dir, 0o755);
    }
    expect(o.saved).toBeNull();
    expect(o.not_saved).toBe('refused');
    expect(o.issues.find((i) => i.code === 'not_saved')).toMatchObject({ severity: 'error', message: expect.stringMatching(/^the draft was not saved: .* — it is kept in the recording's folder/) });
    const all = [JSON.stringify(o.issues), ...logs].join('\n');
    expect(all).not.toMatch(/EACCES|permission denied|cannot-save\.yaml|\/scenarios\//i);
    expect(logs.join('\n')).toMatch(/the draft was not saved: saving it was refused/);
  });

  it('a secret typed in the recording lab: a {{vars.password_1}} placeholder; the value is in no file, result or history', async () => {
    const sentinel = `Sentinel-${randomBytes(6).toString('hex')}`;
    const { o, logs } = await record({ page: 'shop', path: '/record-lab', name: 'lab' }, async (page) => {
      await page.getByRole('heading', { name: 'Recording lab' }).waitFor();
      await page.locator('#lab-password').click();
      await page.keyboard.type(sentinel);
      await page.getByLabel('Note').click();
      await page.keyboard.type('Two bags');
    });
    const text = await readFile(o.draft!, 'utf8');
    expect(text).toContain('text: "{{vars.password_1}}"');
    expect(text).toContain('password_1: CHANGE-ME');
    expect(o.issues.find((i) => i.code === 'secret_field')?.message).toMatch(/showable demo value/);
    const p = await project();
    const files: string[] = [];
    const walk = async (d: string) => {
      for (const e of await readdir(d, { withFileTypes: true })) {
        if (e.isDirectory()) await walk(join(d, e.name));
        else files.push(join(d, e.name));
      }
    };
    await walk(o.dir!);
    for (const f of [...files, join(p.dir, 'scenarios', 'lab.yaml'), historyFile(root)]) {
      expect((await readFile(f)).includes(sentinel), f).toBe(false);
    }
    expect(JSON.stringify(o)).not.toContain(sentinel);
    expect(logs.join('\n')).not.toContain(sentinel);
  }, 120_000);
});
