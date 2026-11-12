/**
 * L3.4 `record` jobs (engine jobs/record-job.ts, R-MCP-24) on the fixture product, the worker run in this process
 * (`once`) with an injected driver: Playwright stands in for the person in a headless "headed" window (the worker
 * port `recordWindow`, which a worker process cannot receive). Refusals at submit (another origin, a template, an
 * unknown page, a bad name, a protected host); a recording of the lab (a sentinel typed in its password field, a note):
 * the job succeeds with counts only in job.json, its events and the history (one line, the worker's), the draft read
 * back from the folder with a {{vars.password_1}} placeholder and the note, the sentinel nowhere. On the in-memory
 * capture runner (the job's own logic; the window's is the runner package's): a worker signal stops and KEEPS the
 * recording (draft saved, check skipped); job_cancel while the window is open discards it (folder removed); pruning never removes the folder of a queued or running record job; an interrupted record job says what
 * was lost and names `retake record`.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FileJobQueue, RECORD_KEEP, createEngine, historyFile, jobsDir, newRecordId, openProject, openWorkspace, pruneRecords, recordsRoot, runWorker } from '../src/index.js';
import type { Engine, EngineError, JobRecord, RecordJobResult, RecordWindow } from '../src/index.js';
import { systemClock } from '../src/clock.js';
import { MemoryCaptureRunner } from '../src/capture/memory-capture.js';
import { memoryRecord } from '../src/capture/memory-sessions.js';
import type { MemoryRecordOptions } from '../src/capture/memory-sessions.js';
import { REPO, fixtureWorkspace } from './helpers.js';
import { oneButtonPress } from './recorded-events.js';

type Page = Parameters<NonNullable<RecordWindow['drive']>>[0];

interface Fixture {
  urls: { console: string; shop: string; signedIn?: { console: string; shop: string } };
  close(): Promise<void>;
}

const PROJECT = 'northfield-fixture';
let fixture: Fixture;
let root: string;
let engine: Engine;
const saved = { home: process.env.RETAKE_HOME, max: process.env.RETAKE_RECORD_MAX_MIN };

/** The in-process worker, Playwright playing the person; the window closes after `drive`. */
function work(drive: (page: Page) => Promise<void>): Promise<number> {
  return runWorker({
    root,
    once: true,
    idleExitMs: 0,
    pollMs: 50,
    log: () => undefined,
    ports: {
      recordWindow: {
        headless: true,
        windowSize: { width: 1400, height: 1000 },
        drive: async (page) => {
          await page.waitForLoadState('domcontentloaded');
          await page.waitForTimeout(800);
          await drive(page);
          await page.waitForTimeout(400).catch(() => undefined);
          await page.close().catch(() => undefined);
        },
      },
    },
  });
}

/**
 * The in-process worker on the in-memory capture runner (the engine's logic of a record job): its window "presses"
 * Request a quote on the shop's first page, then `during` runs while it is still open.
 */
function workInMemory(during: NonNullable<MemoryRecordOptions['during']>): Promise<number> {
  const capture = new MemoryCaptureRunner({ record: memoryRecord({ events: oneButtonPress({ pageKey: 'shop', button: 'Request a quote' }), during }) });
  return runWorker({ root, once: true, idleExitMs: 0, pollMs: 50, log: () => undefined, ports: { capture, recordWindow: { headless: true, drive: async () => undefined } } });
}

/** Resolves once `signal` is aborted. */
const aborted = (signal: AbortSignal | undefined): Promise<void> => new Promise((done) => (!signal || signal.aborted ? done() : signal.addEventListener('abort', () => done(), { once: true })));

async function refusal(p: Promise<unknown>): Promise<EngineError> {
  const e = await p.then(
    () => null,
    (x: unknown) => x as EngineError,
  );
  expect(e, 'expected a refusal').not.toBeNull();
  return e!;
}

async function files(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string) => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      if (e.isDirectory()) await walk(join(d, e.name));
      else out.push(join(d, e.name));
    }
  };
  if (existsSync(dir)) await walk(dir);
  return out;
}

beforeAll(async () => {
  const mod = (await import(join(REPO, 'fixtures/wholesale/server.mjs'))) as {
    startFixture(o: { consolePort: number; shopPort: number; host: string; auth: { consolePort: number; shopPort: number } }): Promise<Fixture>;
  };
  fixture = await mod.startFixture({ consolePort: 0, shopPort: 0, host: '127.0.0.1', auth: { consolePort: 0, shopPort: 0 } });
  root = await mkdtemp(join(tmpdir(), 'studio-record-jobs-'));
  process.env.RETAKE_HOME = join(root, '.home');
  delete process.env.RETAKE_RECORD_MAX_MIN;
  await fixtureWorkspace(root);
  const projectDir = join(root, 'projects', PROJECT);
  const strip = (u: string) => u.replace(/\/$/, '');
  const yaml = (await readFile(join(projectDir, 'project.yaml'), 'utf8'))
    .replaceAll('http://localhost:4401', strip(fixture.urls.console))
    .replaceAll('http://localhost:4402', strip(fixture.urls.shop))
    .replaceAll('http://localhost:4403', strip(fixture.urls.signedIn!.console))
    .replaceAll('http://localhost:4404', strip(fixture.urls.signedIn!.shop));
  await writeFile(join(projectDir, 'project.yaml'), yaml);
  engine = await createEngine({ root, client: 'test', autoStartWorker: false });
}, 120_000);

afterAll(async () => {
  await fixture?.close();
  if (root) await rm(root, { recursive: true, force: true });
  for (const [k, v] of [
    ['RETAKE_HOME', saved.home],
    ['RETAKE_RECORD_MAX_MIN', saved.max],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('record jobs: refusals at submit', () => {
  it('another origin, a template, an unknown page or persona, a path as a name — nothing queued', async () => {
    const otherPort = new URL(fixture.urls.signedIn!.console).port;
    for (const url of ['http://elsewhere.example/', `http://localhost:${otherPort}/`, 'file:///etc/hosts']) {
      expect((await refusal(engine.record.submit({ project: PROJECT, url }))).code, url).toBe('refused');
    }
    expect((await refusal(engine.record.submit({ project: PROJECT, page: 'shop', path: '/{{env:HOME}}' }))).code).toBe('refused');
    expect((await refusal(engine.record.submit({ project: PROJECT, page: 'nowhere' }))).code).toBe('not_found');
    expect((await refusal(engine.record.submit({ project: PROJECT, page: 'shop', persona: 'nobody' }))).code).toBe('not_found');
    expect((await refusal(engine.record.submit({ project: PROJECT, page: 'shop', scenario: '../x' }))).code).toBe('invalid');
    expect((await refusal(engine.record.submit({ project: PROJECT, page: 'shop', path: 'products' }))).code).toBe('invalid');
    expect(await engine.jobs.list()).toEqual([]);
  });

  it('a read-write environment pointing at a host another project protects is refused, with the `retake record` command', async () => {
    const other = join(root, 'projects', 'other');
    await mkdir(other, { recursive: true });
    await writeFile(join(other, 'project.yaml'), `name: Other\nenvironments:\n  live:\n    production: true\n    pages: {app: "${fixture.urls.shop}"}\n`);
    try {
      const e = await refusal(engine.record.submit({ project: PROJECT, page: 'shop', scenario: 'mine' }));
      expect(e.code).toBe('refused');
      expect(e.fix).toMatch(/record northfield-fixture mine --page shop$/);
    } finally {
      await rm(other, { recursive: true, force: true });
    }
    expect(await engine.jobs.list()).toEqual([]);
  });
});

describe('record jobs: run by the worker', () => {
  it('the lab: counts only in job.json, events and history; the draft from the folder; the sentinel nowhere', async () => {
    const sentinel = `Sentinel-${randomBytes(6).toString('hex')}`;
    const sub = await engine.record.submit({ project: PROJECT, page: 'shop', path: '/record-lab', scenario: 'lab-job' });
    expect(sub).toMatchObject({ env: 'local', page: 'shop', path: '/record-lab', persona: null, warnings: [] });
    expect(sub.job.input).toMatchObject({ kind: 'record', rec_id: sub.rec_id, source: { page: 'shop', path: '/record-lab' }, scenario: 'lab-job', check: true, submitted_by: 'test' });
    await work(async (page) => {
      await page.getByRole('heading', { name: 'Recording lab' }).waitFor();
      await page.locator('#lab-password').click();
      await page.keyboard.type(sentinel);
      await page.getByLabel('Note').click();
      await page.keyboard.type('Two bags');
    });
    const job = await engine.jobs.get(sub.job.id);
    expect(job.state, JSON.stringify(job.error)).toBe('succeeded');
    const r = job.result as RecordJobResult;
    expect(r).toMatchObject({
      kind: 'record',
      rec_id: sub.rec_id,
      name: 'lab-job',
      saved: { file: 'scenarios/lab-job.yaml' },
      access: 'read-write',
      stop: 'closed',
      check: { status: 'passed', scope: 'all' },
    });
    expect(r.counts.actions).toBeGreaterThanOrEqual(3);
    expect(r.stats.secrets).toBe(1);
    expect(r.issues.codes).toContain('secret_field');
    expect(r.untrusted.issues.map((i) => i.code)).toContain('secret_field');
    expect(r.dir).toBe(join(recordsRoot(await openProject(await openWorkspace({ root, agent: false }), PROJECT)), sub.rec_id));

    const got = await engine.record.get(PROJECT, sub.rec_id);
    expect(got.draft).toContain('text: "{{vars.password_1}}"');
    expect(got.draft).toContain('Two bags');
    // Typed text stays in the recording's folder and the scenario: never in the job's files nor the history.
    const jobFiles = await files(join(jobsDir(root), job.id));
    expect(jobFiles.length).toBeGreaterThan(0);
    for (const f of jobFiles) {
      const text = await readFile(f, 'utf8');
      expect(text, f).not.toContain(sentinel);
      expect(text, f).not.toContain('Two bags');
    }
    const lines = (await readFile(historyFile(root), 'utf8'))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const mine = lines.filter((l) => (l.record as { id?: string } | undefined)?.id === sub.rec_id);
    expect(mine).toEqual([
      expect.objectContaining({
        job: job.id,
        kind: 'record',
        submitted_by: 'test',
        state: 'succeeded',
        record: { id: sub.rec_id, steps: r.stats.steps, saved: true },
        counted: { captures: 0, dry_runs: 0, renders: 0 },
      }),
    ]);
    const p = await openProject(await openWorkspace({ root, agent: false }), PROJECT);
    for (const f of [...(await files(r.dir!)), join(p.dir, 'scenarios', 'lab-job.yaml'), historyFile(root)]) {
      expect((await readFile(f)).includes(sentinel), f).toBe(false);
    }
  }, 120_000);

  it('a worker signal while the window is open stops it and KEEPS the recording (draft saved, no check replay)', async () => {
    const sub = await engine.record.submit({ project: PROJECT, page: 'shop', scenario: 'kept-on-signal' });
    await workInMemory(async (o) => {
      process.emit('SIGTERM');
      await aborted(o.stop);
    });
    const job = await engine.jobs.get(sub.job.id);
    expect(job.state).toBe('succeeded');
    const r = job.result as RecordJobResult;
    expect(r).toMatchObject({ stop: 'stopped', saved: { file: 'scenarios/kept-on-signal.yaml' }, check: { status: 'skipped', reason: 'stopped' } });
    expect(r.counts.actions).toBe(1);
  });

  it('job_cancel while the window is open discards the recording: cancelled, its folder removed, nothing saved', async () => {
    const sub = await engine.record.submit({ project: PROJECT, page: 'shop', scenario: 'discarded' });
    await workInMemory(async (o) => {
      await engine.jobs.cancel(sub.job.id);
      await aborted(o.signal);
    });
    const job = await engine.jobs.get(sub.job.id);
    expect(job.state).toBe('cancelled');
    expect(job.error?.message).toMatch(/nothing was kept/);
    const p = await openProject(await openWorkspace({ root, agent: false }), PROJECT);
    expect(existsSync(join(recordsRoot(p), sub.rec_id))).toBe(false);
    expect(existsSync(join(p.dir, 'scenarios', 'discarded.yaml'))).toBe(false);
    expect((await engine.record.get(PROJECT, sub.rec_id)).draft).toBeNull();
  });
});

describe('record jobs: folders and interruptions', () => {
  it('pruning keeps the folder of a queued record job, even the oldest', async () => {
    const sub = await engine.record.submit({ project: PROJECT, page: 'shop' });
    const p = await openProject(await openWorkspace({ root, agent: false }), PROJECT);
    const mine = join(recordsRoot(p), sub.rec_id);
    await mkdir(mine, { recursive: true });
    for (let i = 0; i < RECORD_KEEP + 2; i++) await mkdir(join(recordsRoot(p), newRecordId()), { recursive: true });
    const removed = await pruneRecords(p, systemClock, RECORD_KEEP, [], new FileJobQueue(root));
    expect(removed).not.toContain(sub.rec_id);
    expect(existsSync(mine)).toBe(true);
    // Once its job is cancelled, it is the oldest folder: pruned.
    await engine.jobs.cancel(sub.job.id);
    expect(await pruneRecords(p, systemClock, RECORD_KEEP, [], new FileJobQueue(root))).toContain(sub.rec_id);
  });

  it('an interrupted record job says the window closed with it and names `retake record`', async () => {
    const q = new FileJobQueue(join(root, 'q-int'), 'retake -C /ws');
    const job = await q.enqueue({
      version: 1,
      kind: 'record',
      project: PROJECT,
      rec_id: newRecordId(),
      env: 'local',
      source: { page: 'shop', path: '/products' },
      scenario: 'mine',
      check: true,
      submitted_by: 'mcp',
    });
    const dead = spawnSync(process.execPath, ['-e', '0']).pid!;
    const running: JobRecord = { ...job, state: 'running', started_at: new Date().toISOString(), worker: { pid: dead, host: 'h' } };
    await q.write(running);
    const got = await q.get(job.id);
    expect(got?.state).toBe('interrupted');
    expect(got?.error?.message).toMatch(/The recording stopped with it: no draft was made/);
    expect(got?.error?.fix).toBe('retake -C /ws record northfield-fixture mine --env local --page shop --path /products');
  });

  it('interrupted after the window closed: the message names the draft that was made (check) or being made (draft)', async () => {
    const q = new FileJobQueue(join(root, 'q-int2'), 'studio');
    const dead = spawnSync(process.execPath, ['-e', '0']).pid!;
    for (const [phase, re] of [
      ['check', /The recording had ended and its draft was made: \.retake\/records\/rec_\w+\/draft\.yaml .*only its check replay was cut/],
      ['draft', /its draft was being made: \.retake\/records\/rec_\w+\/draft\.yaml if it was written/],
      ['recording · 3 actions', /no draft was made/],
    ] as const) {
      const job = await q.enqueue({ version: 1, kind: 'record', project: PROJECT, rec_id: newRecordId(), env: 'local', source: { page: 'shop', path: '/' }, check: true, submitted_by: 'mcp' });
      await q.write({
        ...job,
        state: 'running',
        started_at: new Date().toISOString(),
        worker: { pid: dead, host: 'h' },
        progress: { steps_done: 0, steps_total: 0, phase, updated_at: new Date().toISOString() },
      });
      const got = await q.get(job.id);
      expect(got?.state).toBe('interrupted');
      expect(got?.error?.message, phase).toMatch(re);
      if (phase !== 'recording · 3 actions') expect(got?.error?.message).not.toMatch(/no draft was made/);
    }
  });
});
