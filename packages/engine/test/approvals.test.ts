/**
 * Human approvals of hooks for work submitted through MCP (L3.1, R-MCP-35, safety S1), without a browser: the
 * preflight at submit, the approval matrix (approved, declined, dismissed, timed out, failed, no approver), approvals
 * bound to the raw hook (a hook changed between submit and run is refused by the executor), `confirm: true` ignored
 * through MCP and honoured by the CLI, a shell hook's `writes: false` ignored on production, dry runs that ask nobody,
 * and the `hooks` / `env_reset` executors the worker runs — on a copy of the fixture project, the fixture product on
 * free ports.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadScenario } from '@demo-studio/core';
import type { HookStep, HooksJobInput, EnvResetJobInput } from '@demo-studio/core';
import { hookFingerprint } from '@demo-studio/hooks';
import { EXIT, main, memoryIo } from '../../cli/src/index.js';
import { EngineError, FileJobQueue, createEngine, executeEnvResetJob, executeHooksJob, openProjectBySlug, openWorkspace } from '../src/index.js';
import type { ApprovalOutcome, ApprovalRequest, Approver, Engine, JobEventBody } from '../src/index.js';
import { REPO, fixtureWorkspace } from './helpers.js';

interface Fixture {
  urls: { console: string; shop: string };
  close(): Promise<void>;
}

let fixture: Fixture;
let ws: string;
let engine: Engine;
let project: string;
const savedHome = process.env.DEMO_STUDIO_HOME;

/** An approver that answers `outcome` and records what it was asked. */
function approver(outcome: ApprovalOutcome | (() => Promise<ApprovalOutcome>)): Approver & { asked: ApprovalRequest[] } {
  const asked: ApprovalRequest[] = [];
  return {
    asked,
    approve: async (req) => {
      asked.push(req);
      return typeof outcome === 'function' ? outcome() : outcome;
    },
  };
}

const accept = (): Approver & { asked: ApprovalRequest[] } => approver({ approved: true });

async function refusal(p: Promise<unknown>): Promise<EngineError> {
  const e = await p.then(
    () => undefined,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(EngineError);
  return e as EngineError;
}

async function execHooks(input: HooksJobInput, signal = new AbortController().signal) {
  const events: JobEventBody[] = [];
  const result = await executeHooksJob({ ws: await openWorkspace({ root: ws }), cli: `studio -C ${ws}`, input, signal, event: (e) => events.push(e) });
  return { result, events };
}

beforeAll(async () => {
  const mod = (await import(join(REPO, 'fixtures/wholesale/server.mjs'))) as {
    startFixture(o: { consolePort: number; shopPort: number; host?: string }): Promise<Fixture>;
  };
  fixture = await mod.startFixture({ consolePort: 0, shopPort: 0, host: '127.0.0.1' });
  ws = await mkdtemp(join(tmpdir(), 'studio-approvals-'));
  process.env.DEMO_STUDIO_HOME = join(ws, '.home');
  await fixtureWorkspace(ws);
  project = join(ws, 'projects', 'northfield-fixture');
  const yaml = (await readFile(join(project, 'project.yaml'), 'utf8'))
    .replaceAll('http://localhost:4401', fixture.urls.console)
    .replaceAll('http://localhost:4402', fixture.urls.shop);
  await writeFile(join(project, 'project.yaml'), yaml);
  await mkdir(join(project, 'hooks'), { recursive: true });
  await writeFile(join(project, 'hooks', 'echo.yaml'), '- name: echo\n  shell: {run: "echo hello"}\n  writes: false\n');
  engine = await createEngine({ root: ws, client: 'mcp', autoStartWorker: false });
});

afterAll(async () => {
  if (savedHome === undefined) delete process.env.DEMO_STUDIO_HOME;
  else process.env.DEMO_STUDIO_HOME = savedHome;
  await fixture?.close();
  if (ws) await rm(ws, { recursive: true, force: true });
});

describe('approvals at submit', () => {
  it('a capture: the preflight lists the hooks that need a human (templated, with the environment); an accept binds fingerprints of the raw hooks', async () => {
    const a = accept();
    const sub = await engine.runs.submit({ project: 'northfield-fixture', scenario: 'catalogue', mode: 'capture' }, { approver: a });
    expect(a.asked).toHaveLength(1);
    const req = a.asked[0];
    expect(req).toMatchObject({ what: 'the capture of scenario catalogue', project: 'northfield-fixture', env: { name: 'local', production: false, access: 'read-write' }, fix: `studio -C ${ws} run northfield-fixture catalogue` });
    // `confirm: true` in the file does not count: the DELETE is listed, with its real target.
    expect(req.items).toEqual([
      // Its rollback is shown too: approving the hook approves it (it runs later without asking).
      expect.objectContaining({
        phase: 'setup',
        index: 1,
        name: 'free-registry-ref',
        kind: 'http',
        reason: 'HTTP DELETE',
        description: `free-registry-ref: http DELETE ${fixture.urls.console}/api/products/finca-quenaro/refs; rollback: http POST ${fixture.urls.console}/api/products/finca-quenaro/refs`,
        rollback: `http POST ${fixture.urls.console}/api/products/finca-quenaro/refs`,
      }),
    ]);
    const sc = (await loadScenario(await openProjectBySlug(engine.workspace, 'northfield-fixture'), 'catalogue')).scenario;
    const fp = hookFingerprint(sc.setup![1], { phase: 'setup', index: 1, env: 'local' });
    // Signed at enqueue with the studio home's key (the worker ignores an approval without a valid signature).
    expect(sub.job.input.approvals).toEqual([{ fingerprint: fp, by: 'human-elicitation', at: expect.any(String), sig: expect.stringMatching(/^[0-9a-f]{64}$/) }]);
    await engine.runs.cancel('northfield-fixture', sub.run_id);
  });

  it('a capture with a `hook:` step (L5.8): the named hook\'s shell entry is asked about once, bound to the step phase and its position; no approver: needs_approval', async () => {
    const a = accept();
    const sub = await engine.runs.submit({ project: 'northfield-fixture', scenario: 'off-camera', mode: 'capture' }, { approver: a });
    expect(a.asked).toHaveLength(1);
    expect(a.asked[0].items).toEqual([expect.objectContaining({ phase: 'step', index: 1, name: 'queue', kind: 'shell', reason: 'a shell command (runs local code)', description: 'queue: shell "sleep 1.5"' })]);
    const sc = (await loadScenario(await openProjectBySlug(engine.workspace, 'northfield-fixture'), 'off-camera')).scenario;
    const entry = (sc.hooks!['cafe-requests-a-quote'] as HookStep[])[1];
    expect(sub.job.input.approvals?.map((x) => x.fingerprint)).toEqual([hookFingerprint(entry, { phase: 'step', index: 1, env: 'local' })]);
    await engine.runs.cancel('northfield-fixture', sub.run_id);
    const none = await refusal(engine.runs.submit({ project: 'northfield-fixture', scenario: 'off-camera', mode: 'capture' }));
    expect(none.code).toBe('needs_approval');
    expect(none.message).toContain('step hook 2 "queue" (a shell command (runs local code))');
  });

  it('declined, dismissed, timed out, failed: refused with the CLI command, nothing queued; no approver: needs_approval', async () => {
    const before = (await engine.jobs.list()).length;
    const cases: Array<[ApprovalOutcome | (() => Promise<ApprovalOutcome>), string]> = [
      [{ approved: false, reason: 'declined' }, 'the user declined'],
      [{ approved: false, reason: 'cancelled' }, 'the user dismissed the question'],
      [{ approved: false, reason: 'timeout' }, 'the user did not answer in time'],
      [() => Promise.reject(new Error('connection closed')), 'the question failed (connection closed)'],
    ];
    for (const [outcome, why] of cases) {
      const e = await refusal(engine.hooks.submit({ project: 'northfield-fixture', source: 'catalogue:setup', dry: false }, { approver: approver(outcome) }));
      expect(e.code, why).toBe('refused');
      expect(e.message).toContain(why);
      expect(e.message).toContain('Do not retry on your own');
      expect(e.fix).toBe(`studio -C ${ws} hooks run northfield-fixture catalogue:setup`);
    }
    const none = await refusal(engine.env.reset({ project: 'northfield-fixture', dry: false }).then(() => engine.hooks.submit({ project: 'northfield-fixture', source: 'catalogue:setup', dry: false })));
    expect(none.code).toBe('needs_approval');
    expect(none.message).toContain('cannot ask its user (no elicitation support)');
    expect(none.fix).toBe(`studio -C ${ws} hooks run northfield-fixture catalogue:setup`);
    // The reset (no hook needing a human) was queued without asking; nothing else.
    expect((await engine.jobs.list()).length).toBe(before + 1);
  });

  it('dry runs ask nobody; names that are paths are refused before anything is read', async () => {
    const a = accept();
    const dry = await engine.hooks.submit({ project: 'northfield-fixture', source: 'catalogue:setup' }, { approver: a });
    expect(dry.job.input).toMatchObject({ kind: 'hooks', dry: true, source: 'catalogue:setup' });
    expect(dry.job.input.approvals).toBeUndefined();
    expect(a.asked).toEqual([]);
    for (const source of ['/etc/hosts.yaml', '../x.yaml', 'hooks/../../x.yaml', 'scenarios/quote.yaml', 'x:y']) {
      expect((await refusal(engine.hooks.submit({ project: 'northfield-fixture', source }))).code, source).toBe('invalid');
    }
    expect((await refusal(engine.hooks.submit({ project: 'northfield-fixture', source: 'hooks/none.yaml' }))).code).toBe('not_found');
    expect((await refusal(engine.env.reset({ project: 'northfield-fixture', env: '../prod' }))).code).toBe('invalid');
    const q = new FileJobQueue(join(ws, 'q-contract'));
    const base = { version: 1, kind: 'hooks', project: 'northfield-fixture', dry: true, journal_id: '20261017-130000-hooks-reset', submitted_by: 'mcp' } as const;
    await expect(q.enqueue({ ...base, source: '/abs/hooks.yaml' } as HooksJobInput)).rejects.toThrow(EngineError);
    await expect(q.enqueue({ ...base, source: 'reset', approvals: [{ fingerprint: 'x', by: 'human-elicitation', at: '' }] } as HooksJobInput)).rejects.toThrow(EngineError);
    expect((await q.enqueue({ ...base, source: 'reset' })).kind).toBe('hooks');
  });
});

describe('hooks executed by the worker (trust mcp)', () => {
  it('a dry job runs nothing and says which hooks would need approval', async () => {
    const { result } = await execHooks({ version: 1, kind: 'hooks', project: 'northfield-fixture', source: 'catalogue:setup', dry: true, journal_id: '20261017-140000-hooks-dry', submitted_by: 'mcp' });
    expect(result).toMatchObject({ kind: 'hooks', phase: 'setup', env: 'local', dry: true, ok: true });
    expect(result.results.map((r) => [r.name, r.status, r.approval?.reason])).toEqual([
      ['reset', 'dry', undefined],
      ['free-registry-ref', 'dry', 'HTTP DELETE'],
    ]);
    expect(result.results[1].declared).toBe('free-registry-ref: http DELETE {{console}}/api/products/finca-quenaro/refs');
    expect(result.journal).toBeUndefined();
  });

  it('approved at submit: runs, journals its rollback; env_reset replays it, then the reset hooks', async () => {
    const a = accept();
    const sub = await engine.hooks.submit({ project: 'northfield-fixture', source: 'catalogue:setup', dry: false }, { approver: a });
    const { result } = await execHooks(sub.job.input as HooksJobInput);
    expect(result.ok).toBe(true);
    expect(result.results.map((r) => [r.name, r.status])).toEqual([
      ['reset', 'ok'],
      ['free-registry-ref', 'ok'],
    ]);
    expect(result.results[1].approval).toEqual({ reason: 'HTTP DELETE' });
    expect(result.journal).toEqual({ id: sub.journal_id, pending: 1 });

    const reset = await engine.env.reset({ project: 'northfield-fixture', dry: false }, { approver: accept() });
    const r = await executeEnvResetJob({ ws: await openWorkspace({ root: ws }), cli: 'studio', input: reset.job.input as EnvResetJobInput, signal: new AbortController().signal, event: () => undefined });
    expect(r.ok).toBe(true);
    expect(r.rollbacks.find((j) => j.journal === sub.journal_id)?.results.map((x) => x.status)).toEqual(['ok']);
    expect(r.reset?.map((x) => [x.name, x.status])).toEqual([['reset-fixture', 'ok']]);
  });

  it('a hook changed between submit and run is refused: the approval is bound to the raw hook', async () => {
    const sub = await engine.hooks.submit({ project: 'northfield-fixture', source: 'catalogue:setup', dry: false }, { approver: accept() });
    const file = join(project, 'scenarios', 'catalogue.yaml');
    const original = await readFile(file, 'utf8');
    try {
      await writeFile(file, original.replace('finca-quenaro/refs"', 'finca-quenaro"'));
      const { result } = await execHooks(sub.job.input as HooksJobInput);
      expect(result.ok).toBe(false);
      expect(result.results.find((x) => x.name === 'free-registry-ref')).toMatchObject({ status: 'refused' });
      expect(result.results.find((x) => x.name === 'free-registry-ref')?.untrusted.error).toContain('without a human approval');
    } finally {
      await writeFile(file, original);
    }
    // No approvals at all (a job queued without going through submit): refused the same way, `confirm: true` or not.
    const { result } = await execHooks({ ...(sub.job.input as HooksJobInput), approvals: undefined, journal_id: '20261017-150000-hooks-catalogue-setup' });
    expect(result.results.find((x) => x.name === 'free-registry-ref')).toMatchObject({ status: 'refused' });
  });

  it('a shell hook needs approval even with `writes: false`, and never runs on production, approved or not', async () => {
    const a = accept();
    const sub = await engine.hooks.submit({ project: 'northfield-fixture', source: 'hooks/echo.yaml', dry: false }, { approver: a });
    expect(a.asked[0].items).toEqual([expect.objectContaining({ kind: 'shell', reason: 'a shell command (runs local code)', description: 'echo: shell "echo hello"' })]);
    const { result } = await execHooks(sub.job.input as HooksJobInput);
    expect(result.results[0]).toMatchObject({ status: 'ok', approval: { reason: 'a shell command (runs local code)' } });

    const prod = accept();
    const e = await refusal(engine.hooks.submit({ project: 'northfield-fixture', source: 'hooks/echo.yaml', env: 'production', dry: false }, { approver: prod }));
    expect(e.code).toBe('refused');
    expect(e.message).toContain('through MCP a shell hook always counts as writing');
    expect(prod.asked).toEqual([]);
    // Queued directly with an approval of that very hook: the executor still refuses it on production.
    const shell = { name: 'echo', shell: { run: 'echo hello' }, writes: false };
    const { result: r } = await execHooks({
      version: 1,
      kind: 'hooks',
      project: 'northfield-fixture',
      source: 'hooks/echo.yaml',
      env: 'production',
      dry: false,
      journal_id: '20261017-160000-hooks-echo',
      submitted_by: 'test',
      approvals: [{ fingerprint: hookFingerprint(shell, { phase: 'setup', index: 0, env: 'production' }), by: 'test', at: new Date().toISOString() }],
    });
    expect(r.results[0].status).toBe('refused');
    expect(r.results[0].untrusted.error).toContain('on read-only environment production');
  });
});

describe('the CLI keeps its trust rules', () => {
  it('`studio hooks run` honours `confirm: true` (no prompt, no --yes) and a shell hook\'s `writes: false`', async () => {
    const io = memoryIo();
    expect(await main(['node', 'studio', '--root', ws, 'hooks', 'run', 'northfield-fixture', 'catalogue:setup'], io), io.stdout() + io.stderr()).toBe(EXIT.ok);
    expect(io.stdout() + io.stderr()).toContain('catalogue-setup: done');
    const prod = memoryIo();
    expect(await main(['node', 'studio', '--root', ws, 'hooks', 'run', 'northfield-fixture', 'hooks/echo.yaml', '--env', 'production'], prod), prod.stdout() + prod.stderr()).toBe(EXIT.ok);
    expect(prod.stdout() + prod.stderr()).toContain('echo: done');
    const reset = memoryIo();
    expect(await main(['node', 'studio', '--root', ws, 'env', 'reset', 'northfield-fixture'], reset)).toBe(EXIT.ok);
  });
});
