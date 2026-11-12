/**
 * Human approval of hooks through MCP elicitation (L3.1, R-MCP-33/34/35): `retake mcp` spawned from the sources over
 * stdio, driven by SDK clients that answer elicitation (accept, decline, never) or do not declare it. hooks_run and
 * env_reset are jobs the workspace's worker (a separate process) runs, with the approvals taken at submit; the fixture
 * product runs on free ports (no browser is needed).
 */
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { readWorkerLock } from '@retake/engine';
import { REPO, fixtureWorkspace } from '../../engine/test/helpers.js';
import { testChildEnv } from '../../core/test/child-env.js';

const BIN = join(REPO, 'packages', 'cli', 'src', 'bin.ts');
const SOURCE_ARGS = ['--conditions=source', '--import', 'tsx', BIN];

interface Fixture {
  urls: { console: string; shop: string };
  close(): Promise<void>;
}

type Result = { content: Array<{ type: string; text: string }>; structuredContent?: Record<string, unknown>; isError?: boolean };
type Answer = 'accept' | 'decline' | 'never';

let fixture: Fixture;
let ws: string;
let home: string;
const sessions: Client[] = [];
const protocolErrors: Error[] = [];

/** A client; `answer` set: it declares form elicitation and answers every question so (recorded in `asked`). */
async function connect(answer?: Answer): Promise<{ client: Client; asked: Array<{ message: string; requestedSchema: unknown }> }> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [...SOURCE_ARGS, '--root', ws, 'mcp'],
    cwd: REPO,
    env: testChildEnv({
      RETAKE_HOME: home,
      RETAKE_WORKER_IDLE_MS: '1500',
      // A human who never answers: refused after 1.5 s here (10 min by default).
      RETAKE_MCP_APPROVAL_TIMEOUT_MS: '1500',
    }),
    stderr: 'pipe',
  });
  const client = new Client({ name: 'retake-test', version: '0' }, { capabilities: answer ? { elicitation: { form: {} } } : {} });
  const asked: Array<{ message: string; requestedSchema: unknown }> = [];
  if (answer) {
    client.setRequestHandler(ElicitRequestSchema, async (req) => {
      const p = req.params as { message: string; requestedSchema: unknown };
      asked.push({ message: p.message, requestedSchema: p.requestedSchema });
      if (answer === 'never') return new Promise(() => undefined);
      return answer === 'accept' ? { action: 'accept', content: { approve: true } } : { action: 'decline' };
    });
  }
  client.onerror = (e) => protocolErrors.push(e);
  await client.connect(transport);
  sessions.push(client);
  return { client, asked };
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<Result> {
  return (await client.callTool({ name, arguments: args }, undefined, { timeout: 60_000 })) as Result;
}

function errorOf(r: Result): { code: string; message: string; fix?: string } {
  expect(r.isError, JSON.stringify(r)).toBe(true);
  return (r.structuredContent as { error: { code: string; message: string; fix?: string } }).error;
}

describe('retake mcp: hooks need a human, asked through elicitation', () => {
  beforeAll(async () => {
    const mod = (await import(join(REPO, 'fixtures/wholesale/server.mjs'))) as {
      startFixture(o: { consolePort: number; shopPort: number; host?: string }): Promise<Fixture>;
    };
    fixture = await mod.startFixture({ consolePort: 0, shopPort: 0, host: '127.0.0.1' });
    ws = await mkdtemp(join(tmpdir(), 'studio-mcp-approvals-'));
    home = join(ws, '.home');
    await fixtureWorkspace(ws);
    const project = join(ws, 'projects', 'northfield-fixture');
    const yaml = (await readFile(join(project, 'project.yaml'), 'utf8'))
      .replaceAll('http://localhost:4401', fixture.urls.console)
      .replaceAll('http://localhost:4402', fixture.urls.shop);
    await writeFile(join(project, 'project.yaml'), yaml);
    await mkdir(join(project, 'hooks'), { recursive: true });
    await writeFile(join(project, 'hooks', 'post.yaml'), `- name: post\n  shell: {run: "curl -s -X POST ${fixture.urls.console}/api/reset"}\n  writes: false\n`);
    // L7.15: a dry run whose setup hook runs a shell command (run_dry hooks: "run" needs a human for it), twice.
    for (const n of ['say-accept', 'say-decline']) {
      await writeFile(join(project, 'scenarios', `${n}.yaml`), `setup:\n  - name: say\n    shell: {run: "echo hello"}\nvideo: ${n}\nscenes:\n  - id: a\n    page: console\n    open: /\n    steps:\n      - hold: 0.2\n`);
    }
  });

  afterAll(async () => {
    for (const c of sessions) await c.close().catch(() => undefined);
    const w = ws ? readWorkerLock(ws) : null;
    if (w) {
      try {
        process.kill(w.pid, 'SIGKILL');
      } catch {
        /* gone */
      }
    }
    await fixture?.close();
    if (ws) await rm(ws, { recursive: true, force: true });
  });

  it('hooks_run dry (the default): nothing runs, nobody is asked; the hooks that would need approval are named', async () => {
    const { client, asked } = await connect('accept');
    const r = await call(client, 'hooks_run', { project: 'northfield-fixture', source: 'catalogue:setup', wait_s: 25 });
    expect(r.isError, JSON.stringify(r)).toBeFalsy();
    expect(asked).toEqual([]);
    expect(r.structuredContent).toMatchObject({ state: 'succeeded', input: { kind: 'hooks', dry: true }, result: { kind: 'hooks', dry: true, ok: true } });
    expect(r.content[0].text).toContain('2. free-registry-ref (free-registry-ref: http DELETE {{console}}/api/products/finca-quenaro/refs): checked, not executed — needs a human approval to run: HTTP DELETE');
    expect(r.content[0].text).toContain('A real run (dry: false) asks the user to approve the hooks marked above.');
  });

  it('accepted: the user reads each hook (kind, target, environment) and the terminal command; the worker runs them', async () => {
    const { client, asked } = await connect('accept');
    const r = await call(client, 'hooks_run', { project: 'northfield-fixture', source: 'catalogue:setup', dry: false, wait_s: 25 });
    expect(r.isError, JSON.stringify(r)).toBeFalsy();
    expect(asked).toHaveLength(1);
    const msg = asked[0].message;
    expect(msg).toContain('the agent asks to run hooks catalogue:setup in project northfield-fixture, environment local, read-write');
    expect(msg).toContain(
      `1. setup hook 2 "free-registry-ref" (http) — HTTP DELETE\n   method: DELETE\n   url: ${fixture.urls.console}/api/products/finca-quenaro/refs\n   rollback method: POST\n   rollback url: ${fixture.urls.console}/api/products/finca-quenaro/refs\n`,
    );
    expect(msg).toContain('"confirm: true" in a file written through MCP does not count');
    expect(msg).toContain(`retake -C ${ws} hooks run northfield-fixture catalogue:setup`);
    expect(asked[0].requestedSchema).toMatchObject({ type: 'object', properties: { approve: { type: 'boolean' } }, required: ['approve'] });
    const job = r.structuredContent as { state: string; input: { approvals: Array<{ by: string }> }; result: { ok: boolean; results: Array<{ name: string; status: string }>; journal: { pending: number } } };
    expect(job.state).toBe('succeeded');
    expect(job.input.approvals).toEqual([expect.objectContaining({ by: 'human-elicitation' })]);
    expect(job.result.results.map((x) => [x.name, x.status])).toEqual([
      ['reset', 'ok'],
      ['free-registry-ref', 'ok'],
    ]);
    expect(job.result.journal.pending).toBe(1);
    expect(r.content[0].text).toContain('1 rollback pending in journal');
  });

  it('declined, or not answered in time: refused with the command a human runs; nothing is queued', async () => {
    for (const answer of ['decline', 'never'] as const) {
      const { client, asked } = await connect(answer);
      const before = ((await call(client, 'job_list', {})).structuredContent as { jobs: unknown[] }).jobs.length;
      const e = errorOf(await call(client, 'hooks_run', { project: 'northfield-fixture', source: 'catalogue:setup', dry: false }));
      expect(asked).toHaveLength(1);
      expect(e.code).toBe('refused');
      expect(e.message).toContain(answer === 'decline' ? 'the user declined' : 'the user did not answer in time');
      expect(e.fix).toBe(`retake -C ${ws} hooks run northfield-fixture catalogue:setup`);
      expect(((await call(client, 'job_list', {})).structuredContent as { jobs: unknown[] }).jobs.length).toBe(before);
    }
  });

  it('a client without elicitation: needs_approval with the command, for hooks_run and run_capture alike', async () => {
    const { client } = await connect();
    const h = errorOf(await call(client, 'hooks_run', { project: 'northfield-fixture', source: 'hooks/post.yaml', dry: false }));
    expect(h.code).toBe('needs_approval');
    expect(h.message).toContain('setup hook 1 "post" (a shell command (runs local code))');
    expect(h.fix).toBe(`retake -C ${ws} hooks run northfield-fixture hooks/post.yaml`);
    const c = errorOf(await call(client, 'run_capture', { project: 'northfield-fixture', scenario: 'catalogue' }));
    expect(c.code).toBe('needs_approval');
    expect(c.fix).toBe(`retake -C ${ws} run northfield-fixture catalogue`);
  });

  it('a shell hook declared `writes: false` on production: refused before the user is asked', async () => {
    const { client, asked } = await connect('accept');
    const e = errorOf(await call(client, 'hooks_run', { project: 'northfield-fixture', source: 'hooks/post.yaml', env: 'production', dry: false }));
    expect(e.code).toBe('refused');
    expect(e.message).toContain('through MCP a shell hook always counts as writing');
    expect(asked).toEqual([]);
  });

  it('env_reset: replays the pending rollback, then the reset hooks (nothing there needs a human)', async () => {
    const { client, asked } = await connect('accept');
    const r = await call(client, 'env_reset', { project: 'northfield-fixture', dry: false, wait_s: 25 });
    expect(r.isError, JSON.stringify(r)).toBeFalsy();
    expect(asked).toEqual([]);
    const res = (r.structuredContent as { state: string; result: { ok: boolean; rollbacks: Array<{ results: Array<{ status: string }> }>; reset: Array<{ name: string; status: string }> } });
    expect(res.state).toBe('succeeded');
    expect(res.result.ok).toBe(true);
    expect(res.result.rollbacks.flatMap((j) => j.results.map((x) => x.status))).toEqual(['ok']);
    expect(res.result.reset.map((x) => [x.name, x.status])).toEqual([['reset-fixture', 'ok']]);
    expect(r.content[0].text).toContain('reset hooks:');
    expect(protocolErrors).toEqual([]);
  });

  it('project_prune {dry_run: false}: the user is asked (count, size, each item); no form or a decline deletes nothing', async () => {
    const runs = join(ws, 'projects', 'northfield-fixture', 'runs');
    const take = join(runs, '20261018-080000-quote');
    await mkdir(take, { recursive: true });
    await writeFile(join(take, 'run.json'), JSON.stringify({ version: 1, id: '20261018-080000-quote', project: 'northfield-fixture', scenario: 'quote', mode: 'capture', status: 'failed', started_at: '2026-10-18T08:00:00.000Z', dir: take, env: 'local', options: { hooks: 'run', headed: false }, steps_total: 1, steps_done: 0, screenshots: [], hooks: { setup: 'none', teardown: 'none' }, warnings: [] }));
    const left = async () => (await readdir(runs)).filter((n) => n.startsWith('2026')).sort();
    const before = await left();
    expect(before).toContain('20261018-080000-quote');
    const none = errorOf(await call((await connect()).client, 'project_prune', { project: 'northfield-fixture', dry_run: false }));
    expect(none.code).toBe('needs_approval');
    expect(none.fix).toBe(`retake -C ${ws} prune northfield-fixture --yes`);
    const no = await connect('decline');
    expect(errorOf(await call(no.client, 'project_prune', { project: 'northfield-fixture', dry_run: false })).code).toBe('refused');
    expect(await left()).toEqual(before);
    expect(no.asked).toHaveLength(1);
    expect(no.asked[0]!.message).toMatch(/the agent asks to delete 2 items from project northfield-fixture's runs\/, renders\/ and review\/, freeing \d+ kB: 2 takes/);
    expect(no.asked[0]!.message).toContain('\n- take 20261018-080000-quote — failed take, ');
    expect(no.asked[0]!.message).toContain(`run it yourself in a terminal: retake -C ${ws} prune northfield-fixture --yes`);
    const yes = await connect('accept');
    const r = await call(yes.client, 'project_prune', { project: 'northfield-fixture', dry_run: false });
    expect(r.isError, JSON.stringify(r)).toBeFalsy();
    expect(r.content[0].text).toMatch(/^2 items of northfield-fixture deleted \(\d+ kB freed\), as the user approved/);
    expect(await left()).toEqual(before.filter((n) => n !== '20261018-080000-quote' && n !== '20261017-120000-quote'));
    expect(protocolErrors).toEqual([]);
  });

  it("run_dry {hooks: 'run'} and run_capture: the client's user is asked once and the run is queued with the approval; a decline queues nothing (L7.15; last: its run folder would count for project_prune)", async () => {
    const yes = await connect('accept');
    const r = await call(yes.client, 'run_dry', { project: 'northfield-fixture', scenario: 'say-accept', hooks: 'run', wait_s: 0 });
    expect(r.isError, JSON.stringify(r)).toBeFalsy();
    expect(yes.asked).toHaveLength(1);
    expect(yes.asked[0].message).toContain('setup hook 1 "say"');
    const jobId = /\(job (j_[0-9A-Z]{26})\)/.exec(r.content[0].text)![1]!;
    const job = (await call(yes.client, 'job_status', { job_id: jobId })).structuredContent as { input: { kind: string; approvals?: Array<{ by: string }> } };
    expect(job.input.kind).toBe('run');
    expect(job.input.approvals).toEqual([expect.objectContaining({ by: 'human-elicitation' })]);
    await call(yes.client, 'job_cancel', { job_id: jobId });
    const no = await connect('decline');
    const before = ((await call(no.client, 'job_list', {})).structuredContent as { jobs: unknown[] }).jobs.length;
    const e = errorOf(await call(no.client, 'run_dry', { project: 'northfield-fixture', scenario: 'say-decline', hooks: 'run', wait_s: 0 }));
    expect(no.asked).toHaveLength(1);
    expect(e.code).toBe('refused');
    expect(e.message).toContain('the user declined');
    expect(e.fix).toBe(`retake -C ${ws} run northfield-fixture say-decline --dry --hooks run`);
    expect(((await call(no.client, 'job_list', {})).structuredContent as { jobs: unknown[] }).jobs.length).toBe(before);
    // run_capture takes the same approver: asked once, queued with the approval.
    const cap = await connect('accept');
    const c = await call(cap.client, 'run_capture', { project: 'northfield-fixture', scenario: 'say-decline' });
    expect(c.isError, JSON.stringify(c)).toBeFalsy();
    expect(cap.asked).toHaveLength(1);
    const capJob = /\(job (j_[0-9A-Z]{26})\)/.exec(c.content[0].text)![1]!;
    const cj = (await call(cap.client, 'job_status', { job_id: capJob })).structuredContent as { input: { mode: string; approvals?: Array<{ by: string }> } };
    expect(cj.input.mode).toBe('capture');
    expect(cj.input.approvals).toEqual([expect.objectContaining({ by: 'human-elicitation' })]);
    await call(cap.client, 'job_cancel', { job_id: capJob });
  });
});
