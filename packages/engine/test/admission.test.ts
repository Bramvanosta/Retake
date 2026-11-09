/**
 * The engine's admission rules (packages/engine/src/admission.ts), for the callers they hold (caller.ts `admits`: the
 * Studio `ui` and MCP `mcp`) — the refusals, codes and messages the Studio gave when they were its own, now for both;
 * the engine's tests (`test`) and the CLI (`cli`) are not held. Each rule checks and submits under its own key, so two
 * calls at once queue one job.
 *
 * - one_run_per_scenario: a run of the scenario queued or running → conflict naming it; nothing queued.
 * - sessions_ack: a capture of a scenario whose persona's session is not valid and that no run signs in by itself →
 *   conflict with `details.sessions` until `sessions_ack` names it; a dry run needs none.
 * - one_render_per_scenario: a render of the scenario queued or running → conflict naming it, before anything is planned.
 * - export_cap: an export of the render queued or running → conflict; two exports of the workspace → conflict; a
 *   `latest` is held to the rule once resolved.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { JOB_INPUT_VERSION } from '@retake/core';
import { EXPORTS_OPEN_MAX, EngineError, FileJobQueue, confirmWhy, createEngine, sessionsToConfirm } from '../src/index.js';
import type { Engine, EngineClient, JobRecord } from '../src/index.js';
import { fixtureWorkspace } from './helpers.js';

const P = 'northfield-fixture';
const UNSET = 'RETAKE_TEST_ADMISSION_UNSET_PW';
const SUPPLIER_VAR = 'NORTHFIELD_SUPPLIER_PASSWORD';
const savedHome = process.env.RETAKE_HOME;
let ws: string;
let queue: FileJobQueue;
const engines = {} as Record<EngineClient, Engine>;
const project = () => join(ws, 'projects', P);

const plain = (video: string, env?: string) =>
  [`video: ${video}`, ...(env ? [`env: ${env}`] : []), 'scenes:', '  - id: a', '    page: console', '    open: /', '    steps:', '      - hold: 1', ''].join('\n');

/** What a call threw, as an EngineError (or the value it returned). */
const outcome = <T>(p: Promise<T>): Promise<EngineError | T> => p.catch((e: unknown) => e as EngineError);
const open = async () => (await queue.list({ states: ['queued', 'running'], limit: 200 })).map((j) => j.id).sort();

async function plantRender(scenario: string, renderId: string): Promise<JobRecord> {
  return queue.enqueue({
    version: JOB_INPUT_VERSION, kind: 'render', project: P, scenario, run_id: `20261017-130000-${scenario}`, timeline_sha256: 'a'.repeat(64), render_id: renderId, overrides: {}, submitted_by: 'test',
  });
}
async function plantExport(renderId: string): Promise<JobRecord> {
  return queue.enqueue({ version: JOB_INPUT_VERSION, kind: 'export', project: P, render_id: renderId, formats: ['mp4_1080p'], submitted_by: 'test' });
}

beforeAll(async () => {
  ws = await mkdtemp(join(tmpdir(), 'engine-admission-'));
  process.env.RETAKE_HOME = join(ws, '.home');
  await fixtureWorkspace(ws);
  // The supplier's login steps use a variable no worker has: no run signs it in by itself (never signed in either).
  const yaml = await readFile(join(project(), 'project.yaml'), 'utf8');
  expect(yaml).toContain(`{{env:${SUPPLIER_VAR}}}`);
  delete process.env[UNSET];
  await writeFile(join(project(), 'project.yaml'), yaml.replace(`{{env:${SUPPLIER_VAR}}}`, `{{env:${UNSET}}}`));
  for (const n of ['one-a', 'one-b', 'one-c', 'race']) await writeFile(join(project(), 'scenarios', `${n}.yaml`), plain(n));
  await writeFile(join(project(), 'scenarios', 'signed.yaml'), plain('signed', 'signed-in'));
  for (const client of ['cli', 'mcp', 'test', 'ui'] as const) engines[client] = await createEngine({ root: ws, client, autoStartWorker: false });
  queue = new FileJobQueue(ws);
}, 60_000);

afterEach(async () => {
  for (const id of await open()) await queue.cancel(id, 'test');
});

afterAll(async () => {
  if (savedHome === undefined) delete process.env.RETAKE_HOME;
  else process.env.RETAKE_HOME = savedHome;
  if (ws) await rm(ws, { recursive: true, force: true });
});

describe('one_run_per_scenario', () => {
  for (const client of ['ui', 'mcp'] as const) {
    it(`${client}: a run of the scenario queued → conflict naming it, nothing queued; another scenario runs`, async () => {
      const first = await engines.test.runs.submit({ project: P, scenario: 'one-a', mode: 'dry' });
      const before = await open();
      for (const mode of ['dry', 'capture'] as const) {
        const e = await outcome(engines[client].runs.submit({ project: P, scenario: 'one-a', mode }));
        expect(e).toBeInstanceOf(EngineError);
        expect(e).toMatchObject({ code: 'conflict', message: `a rehearsal of one-a is queued (${first.run_id}): wait for it to end, or stop it`, details: { run_id: first.run_id, job: first.job.id } });
      }
      expect(await open()).toEqual(before);
      const other = await engines[client].runs.submit({ project: P, scenario: 'one-b', mode: 'capture' });
      expect(other.job.state).toBe('queued');
      // A capture of it, queued, is named as a capture.
      const e = await outcome(engines[client].runs.submit({ project: P, scenario: 'one-b', mode: 'dry' }));
      expect((e as EngineError).message).toBe(`a capture of one-b is queued (${other.run_id}): wait for it to end, or stop it`);
      // Once the run ended, the scenario runs again.
      await queue.cancel(first.job.id, 'test');
      expect((await engines[client].runs.submit({ project: P, scenario: 'one-a', mode: 'dry' })).job.state).toBe('queued');
    });
  }

  it('two calls at once queue one run: the second finds the first one’s job', async () => {
    for (const client of ['ui', 'mcp'] as const) {
      const both = await Promise.all([1, 2].map(() => outcome(engines[client].runs.submit({ project: P, scenario: 'race', mode: 'dry' }))));
      const refused = both.filter((x) => x instanceof EngineError) as EngineError[];
      expect(refused, client).toHaveLength(1);
      expect(refused[0]!.code).toBe('conflict');
      for (const id of await open()) await queue.cancel(id, 'test');
    }
  });

  it('the engine’s tests and the CLI are not held to it', async () => {
    await engines.test.runs.submit({ project: P, scenario: 'one-c', mode: 'dry' });
    expect((await engines.test.runs.submit({ project: P, scenario: 'one-c', mode: 'dry' })).job.state).toBe('queued');
    expect((await engines.cli.runs.submit({ project: P, scenario: 'one-c', mode: 'dry' })).job.state).toBe('queued');
  });
});

describe('sessions_ack', () => {
  const SUPPLIER = [{ persona: 'supplier', status: 'never', checked_first: true }];

  for (const client of ['ui', 'mcp'] as const) {
    it(`${client}: a capture without the personas to confirm → conflict with details.sessions, nothing queued; with them queued; a dry run needs none`, async () => {
      const before = await open();
      for (const ack of [undefined, [], ['buyer']]) {
        const e = await outcome(engines[client].runs.submit({ project: P, scenario: 'signed', mode: 'capture', ...(ack ? { sessions_ack: ack } : {}) }));
        expect(e, JSON.stringify(ack)).toBeInstanceOf(EngineError);
        expect(e).toMatchObject({ code: 'conflict', details: { sessions: SUPPLIER } });
        expect((e as EngineError).message).toBe(
          'supplier (never signed in): its session is not valid and no run signs it in by itself. The run checks it first and stops before filming if still not valid: sign in first, or confirm the capture',
        );
      }
      expect(await open()).toEqual(before);
      const dry = await engines[client].runs.submit({ project: P, scenario: 'signed', mode: 'dry' });
      await queue.cancel(dry.job.id, 'test');
      const ok = await engines[client].runs.submit({ project: P, scenario: 'signed', mode: 'capture', sessions_ack: ['supplier'] });
      expect(ok.job.state).toBe('queued');
    });
  }

  it('the engine’s tests are not held to it', async () => {
    expect((await engines.test.runs.submit({ project: P, scenario: 'signed', mode: 'capture' })).job.state).toBe('queued');
  });

  it('sessionsToConfirm and confirmWhy: the personas no run signs in by itself, and what the capture does with them', () => {
    const p = (persona: string, status: string, o: Record<string, boolean> = {}) => ({ persona, status, auto: false, has_check: true, ...o });
    expect(sessionsToConfirm({ personas: [p('a', 'valid'), p('b', 'expired'), p('c', 'never', { has_check: false }), p('d', 'error', { auto: true }), p('e', 'expired', { sandbox: true }), p('f', 'never', { legacy: true }), p('g', 'error', { has_check: false })] })).toEqual([
      { persona: 'b', status: 'expired', checked_first: true },
      { persona: 'c', status: 'never', checked_first: true },
      { persona: 'g', status: 'error', checked_first: false },
    ]);
    expect(confirmWhy([{ persona: 'b', status: 'expired', checked_first: true }])).toBe('The run checks it first and stops before filming if still not valid');
    expect(confirmWhy([{ persona: 'b', status: 'expired', checked_first: true }, { persona: 'c', status: 'never', checked_first: true }])).toBe('The run checks each first and stops before filming if still not valid');
    expect(confirmWhy([{ persona: 'b', status: 'expired', checked_first: true }, { persona: 'g', status: 'error', checked_first: false }])).toBe(
      'The run checks b first and stops before filming if still not valid. Persona g cannot be checked first (no `check`): the run uses its saved session as it is and fails only when a page lands on the sign-in page — after its setup hooks ran',
    );
  });
});

describe('one_render_per_scenario', () => {
  for (const client of ['ui', 'mcp'] as const) {
    it(`${client}: a render of the scenario queued → conflict naming it, before anything is planned`, async () => {
      const busy = await plantRender('quote', 'quote-v3');
      const before = await open();
      const e = await outcome(engines[client].renders.submit({ project: P, scenario: 'quote' }));
      expect(e).toMatchObject({ code: 'conflict', message: 'render quote-v3 of quote is queued: wait for it to end, or cancel it', details: { render_id: 'quote-v3', job: busy.id } });
      expect(await open()).toEqual(before);
      // Another scenario's render is not refused by the rule (it fails later: the fixture has no capture of it).
      const other = await outcome(engines[client].renders.submit({ project: P, scenario: 'catalogue' }));
      expect((other as EngineError).message).not.toMatch(/wait for it to end/);
    });
  }

  it('the engine’s tests and the CLI are not held to it', async () => {
    await plantRender('quote', 'quote-v3');
    for (const client of ['test', 'cli'] as const) expect(((await outcome(engines[client].renders.submit({ project: P, scenario: 'quote' }))) as EngineError).message, client).not.toMatch(/wait for it to end/);
  });
});

describe('export_cap', () => {
  for (const client of ['ui', 'mcp'] as const) {
    it(`${client}: an export of the render queued → conflict; ${EXPORTS_OPEN_MAX} exports of the workspace → conflict; nothing queued`, async () => {
      const busy = await plantExport('quote-v1');
      const before = await open();
      const e = await outcome(engines[client].exports.submit({ project: P, render_id: 'quote-v1', formats: ['mp4_1080p'] }));
      expect(e).toMatchObject({ code: 'conflict', message: `an export of quote-v1 is queued (job ${busy.id}): wait for it to end`, details: { job: busy.id } });
      // One export of the workspace: another render's is not refused by the cap (it fails later: no such render).
      expect(((await outcome(engines[client].exports.submit({ project: P, render_id: 'quote-v5' }))) as EngineError).code).toBe('not_found');
      await plantExport('quote-v2');
      const cap = await outcome(engines[client].exports.submit({ project: P, render_id: 'quote-v5' }));
      expect(cap).toMatchObject({ code: 'conflict', message: '2 exports are already queued or running: wait for one to end', details: { open: 2 } });
      // The render's own export is named first.
      expect(((await outcome(engines[client].exports.submit({ project: P, render_id: 'quote-v2' }))) as EngineError).message).toMatch(/^an export of quote-v2 is queued/);
      // Only the two planted exports are queued.
      expect((await queue.list({ kinds: ['export'], states: ['queued', 'running'] })).map((j) => j.input.kind === 'export' && j.input.render_id).sort()).toEqual(['quote-v1', 'quote-v2']);
      expect(before).toHaveLength(1);
    });
  }

  it('a `latest` is held to the rule once resolved', async () => {
    // A finished render of quote, as a render writes it, with its video.
    const renders = join(project(), 'renders');
    await mkdir(renders, { recursive: true });
    const id = 'quote-v4';
    await writeFile(join(renders, `${id}.mp4`), 'video');
    await writeFile(
      join(renders, `${id}.json`),
      JSON.stringify({
        version: 1, id, project: P, scenario: 'quote', run_id: '20261017-130000-quote', run_dir: join(project(), 'runs', '20261017-130000-quote'), template: 'editorial', overrides: {},
        variant: 'landscape', status: 'succeeded', file: join(renders, `${id}.mp4`), record: join(renders, `${id}.json`), render_version: 4, created_at: '2026-10-18T10:00:00.000Z',
        finished_at: '2026-10-18T10:00:00.000Z', duration_s: 3, frames: 90, fps: 30, width: 1920, height: 1080, size_bytes: 5, plan: {}, warnings: [],
      }),
    );
    const busy = await plantExport(id);
    for (const client of ['ui', 'mcp'] as const) {
      const e = await outcome(engines[client].exports.submit({ project: P, render_id: 'latest', scenario: 'quote', formats: ['mp4_1080p'] }));
      expect(e, client).toMatchObject({ code: 'conflict', message: `an export of ${id} is queued (job ${busy.id}): wait for it to end` });
    }
    // Not held: the engine's tests queue it.
    expect((await engines.test.exports.submit({ project: P, render_id: 'latest', scenario: 'quote', formats: ['mp4_1080p'] })).render_id).toBe(id);
  });
});
