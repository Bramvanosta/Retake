/**
 * Human approval of hooks through MCP elicitation (L3.1, R-MCP-33/34/35): `retake mcp` spawned from the sources over
 * stdio, driven by SDK clients that answer elicitation (accept, decline, never) or do not declare it. hooks_run and
 * env_reset are jobs the workspace's worker (a separate process) runs, with the approvals taken at submit; the fixture
 * product runs on free ports (no browser is needed).
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { readWorkerLock } from '@retake/engine';
import { REPO, fixtureWorkspace } from '../../engine/test/helpers.js';

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
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      RETAKE_HOME: home,
      RETAKE_WORKER_IDLE_MS: '1500',
      // A human who never answers: refused after 1.5 s here (10 min by default).
      RETAKE_MCP_APPROVAL_TIMEOUT_MS: '1500',
    },
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
    expect(msg).toContain(`1. setup hook 2 "free-registry-ref": free-registry-ref: http DELETE ${fixture.urls.console}/api/products/finca-quenaro/refs; rollback: http POST ${fixture.urls.console}/api/products/finca-quenaro/refs — HTTP DELETE`);
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
});
