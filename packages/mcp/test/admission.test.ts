/**
 * The engine's admission rules through the MCP tools (invoke with shell `mcp`, the path the protocol layer runs every call through,
 * with an engine of client `mcp`): the refusals and codes the Studio gives, worded for MCP (the glossary's words, the
 * tools that follow up) — one run of a scenario at a
 * time (run_dry, run_capture), the sessions acknowledgement of a capture (run_capture `sessions_ack`), one render of a
 * scenario at a time (render), one export of a render and two of the workspace at once (export). Each refused call
 * queues nothing.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { JOB_INPUT_VERSION } from '@retake/core';
import { FileJobQueue, createEngine } from '@retake/engine';
import type { Engine, EngineError } from '@retake/engine';
import { catalogueOperation } from '@retake/engine/catalogue';
import { TOOLS, invoke } from '../src/index.js';
import type { ToolDef } from '../src/index.js';
import { fixtureWorkspace } from '../../engine/test/helpers.js';

const P = 'northfield-fixture';
const UNSET = 'RETAKE_TEST_MCP_ADMISSION_UNSET_PW';
const savedHome = process.env.RETAKE_HOME;
let ws: string;
let engine: Engine;
let queue: FileJobQueue;
const project = () => join(ws, 'projects', P);
const open = async () => (await queue.list({ states: ['queued', 'running'], limit: 200 })).map((j) => j.id).sort();

/** One tool call as the MCP server makes it: served by MCP, the tool's own argument parse, its caller rules, then the handler on the engine. */
async function call(name: string, args: Record<string, unknown>): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; error: EngineError }> {
  const tool: ToolDef = TOOLS.find((t) => t.name === name)!;
  const r = await invoke(tool, async () => engine, args, { shell: 'mcp', signal: new AbortController().signal });
  return r.ok ? { ok: true, data: r.output.data as Record<string, unknown> } : { ok: false, error: r.error };
}
const refusal = async (name: string, args: Record<string, unknown>) => {
  const r = await call(name, args);
  expect(r.ok, JSON.stringify(r)).toBe(false);
  return (r as { error: EngineError }).error;
};

const plain = (video: string, env?: string) =>
  [`video: ${video}`, ...(env ? [`env: ${env}`] : []), 'scenes:', '  - id: a', '    page: console', '    open: /', '    steps:', '      - hold: 1', ''].join('\n');

beforeAll(async () => {
  ws = await mkdtemp(join(tmpdir(), 'mcp-admission-'));
  process.env.RETAKE_HOME = join(ws, '.home');
  await fixtureWorkspace(ws);
  const yaml = await readFile(join(project(), 'project.yaml'), 'utf8');
  delete process.env[UNSET];
  await writeFile(join(project(), 'project.yaml'), yaml.replace('{{env:NORTHFIELD_SUPPLIER_PASSWORD}}', `{{env:${UNSET}}}`));
  await writeFile(join(project(), 'scenarios', 'twice.yaml'), plain('twice'));
  await writeFile(join(project(), 'scenarios', 'signed.yaml'), plain('signed', 'signed-in'));
  engine = await createEngine({ root: ws, client: 'mcp', autoStartWorker: false });
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

describe('the admission rules through MCP', () => {
  it('the catalogue names them on the tools that meet them', () => {
    expect(['run_dry', 'run_capture', 'render', 'export'].map((n) => catalogueOperation(n)?.admission)).toEqual([['one_run_per_scenario'], ['one_run_per_scenario', 'sessions_ack'], ['one_render_per_scenario'], ['export_cap']]);
  });

  it('run_dry / run_capture: one run of a scenario at a time — a second call is a conflict naming the run, nothing queued', async () => {
    const first = await call('run_dry', { project: P, scenario: 'twice', wait_s: 0 });
    expect(first.ok).toBe(true);
    if (!first.ok) throw first.error;
    const runId = first.data.id as string;
    const before = await open();
    for (const tool of ['run_dry', 'run_capture']) {
      const e = await refusal(tool, { project: P, scenario: 'twice' });
      expect(e.code).toBe('conflict');
      expect(e.message).toBe(`a dry run of twice is queued (${runId}): wait for it to end (run_status), or stop it (run_cancel)`);
      expect(e.details).toMatchObject({ run_id: runId });
    }
    expect(await open()).toEqual(before);
  });

  it('run_capture: a persona whose session is not valid needs sessions_ack naming it; a dry run needs none', async () => {
    const before = await open();
    for (const ack of [undefined, ['buyer']]) {
      const e = await refusal('run_capture', { project: P, scenario: 'signed', ...(ack ? { sessions_ack: ack } : {}) });
      expect(e.code).toBe('conflict');
      expect(e.details).toEqual({ sessions: [{ persona: 'supplier', status: 'never', checked_first: true }] });
      expect(e.message).toBe(
        'supplier (never signed in): its session is not valid and no run signs it in by itself. The run checks it first and stops before filming if still not valid: sign in first (auth_login), or confirm the capture (sessions_ack naming it)',
      );
    }
    expect((await refusal('run_capture', { project: P, scenario: 'signed', sessions_ack: ['../x'] })).code).toBe('invalid');
    expect(await open()).toEqual(before);
    const dry = await call('run_dry', { project: P, scenario: 'signed', wait_s: 0 });
    expect(dry.ok, JSON.stringify(dry)).toBe(true);
    for (const id of await open()) await queue.cancel(id, 'test');
    const ok = await call('run_capture', { project: P, scenario: 'signed', sessions_ack: ['supplier'] });
    expect(ok.ok, JSON.stringify(ok)).toBe(true);
  });

  it('run_capture {sandbox: true}: the sessions are those of the sandbox the take uses (its accounts sign in by themselves) — queued', async () => {
    const r = await call('run_capture', { project: P, scenario: 'signed', sandbox: true });
    expect(r.ok, JSON.stringify(r)).toBe(true);
  });

  it('render: one render of a scenario at a time — a conflict naming the render queued', async () => {
    const busy = await queue.enqueue({
      version: JOB_INPUT_VERSION, kind: 'render', project: P, scenario: 'quote', run_id: '20261017-130000-quote', timeline_sha256: 'a'.repeat(64), render_id: 'quote-v3', overrides: {}, submitted_by: 'test',
    });
    const e = await refusal('render', { project: P, scenario: 'quote' });
    expect(e).toMatchObject({ code: 'conflict', message: 'render quote-v3 of quote is queued: wait for it to end (render_status), or cancel it (job_cancel)', details: { render_id: 'quote-v3', job: busy.id } });
  });

  it('export: one export of a render at a time, at most two of the workspace', async () => {
    const plant = (render_id: string) => queue.enqueue({ version: JOB_INPUT_VERSION, kind: 'export', project: P, render_id, formats: ['mp4_1080p'], submitted_by: 'test' });
    const busy = await plant('quote-v1');
    expect(await refusal('export', { project: P, render_id: 'quote-v1' })).toMatchObject({ code: 'conflict', message: `an export of quote-v1 is queued (job ${busy.id}): wait for it to end (job_status)` });
    await plant('quote-v2');
    expect(await refusal('export', { project: P, render_id: 'quote-v7' })).toMatchObject({ code: 'conflict', message: '2 exports are already queued or running: wait for one to end', details: { open: 2 } });
  });
});
