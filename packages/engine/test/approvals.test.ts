/**
 * Human approvals of hooks for work submitted through MCP (L3.1, R-MCP-35, safety S1), without a browser: the
 * preflight at submit, the approval matrix (approved, declined, dismissed, timed out, failed, no approver), approvals
 * bound to the raw hook (a hook changed between submit and run is refused by the executor), `confirm: true` ignored
 * through MCP and honoured by the CLI, a shell hook's `writes: false` ignored on production, dry runs that ask nobody,
 * and the `hooks` / `env_reset` executors the worker runs — on a copy of the fixture project, the fixture product on
 * free ports. The cases about the engine's own logic (what an approver's answer gives, what a dry submit asks) run on the
 * in-memory hook runner (`fake`, an engine handed it); one case of each rule stays on the hooks package (`engine`).
 */
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadScenario, fileFacts } from '@retake/core/io';
import type { HookStep } from '@retake/core';
import type { HooksJobInput, EnvResetJobInput, RunJobInput } from '@retake/engine';
import { hookFiles, hookFingerprint, standaloneJournalFile } from '@retake/hooks';
import { EXIT, main, memoryIo } from '../../cli/src/index.js';
import {
  APPROVAL_FORM_MAX_CHARS,
  APPROVAL_HOOK_MAX_CHARS,
  EngineError,
  approvalFormText,
  FileJobQueue,
  createEngine,
  executeEnvResetJob,
  executeHooksJob,
  openProjectBySlug,
  openWorkspace,
  sha256Hex,
  takeApprovals,
  enginePorts,
  ManualClock,
  diskWorkspaceReads,
} from '../src/index.js';
import type { ApprovalOutcome, ApprovalRequest, Approver, Engine, JobEventBody } from '../src/index.js';
import { MemoryHookRunner } from '../src/hook-run/memory-hooks.js';
import { REPO } from '@retake/test-support/repo';
import { fixtureWorkspace } from '@retake/test-support/workspace';
import { PERSON_POLICY } from '@retake/core';
import { scratchHome } from '@retake/test-support/home';

interface Fixture {
  urls: { console: string; shop: string };
  close(): Promise<void>;
}

let fixture: Fixture;
let ws: string;
let engine: Engine;
/** The same workspace on the in-memory hook runner: the DELETE of catalogue's setup needs a human, as the package says. */
let fake: Engine;
const memory = new MemoryHookRunner({ needsHuman: (h) => (h.name === 'free-registry-ref' ? 'HTTP DELETE' : undefined) });
let project: string;
const retakeHome = scratchHome();

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
  const result = await executeHooksJob({
    ...enginePorts(),
    ws: await openWorkspace({ root: ws, agent: false, reads: diskWorkspaceReads }),
    cli: `retake -C ${ws}`,
    input,
    signal,
    event: (e) => events.push(e),
  });
  return { result, events };
}

beforeAll(async () => {
  const mod = (await import(join(REPO, 'fixtures/wholesale/server.mjs'))) as {
    startFixture(o: { consolePort: number; shopPort: number; host?: string }): Promise<Fixture>;
  };
  fixture = await mod.startFixture({ consolePort: 0, shopPort: 0, host: '127.0.0.1' });
  ws = await mkdtemp(join(tmpdir(), 'studio-approvals-'));
  retakeHome.use(join(ws, '.home'));
  await fixtureWorkspace(ws);
  project = join(ws, 'projects', 'northfield-fixture');
  const yaml = (await readFile(join(project, 'project.yaml'), 'utf8')).replaceAll('http://localhost:4401', fixture.urls.console).replaceAll('http://localhost:4402', fixture.urls.shop);
  await writeFile(join(project, 'project.yaml'), yaml);
  await mkdir(join(project, 'hooks'), { recursive: true });
  await writeFile(join(project, 'hooks', 'echo.yaml'), '- name: echo\n  shell: {run: "echo hello"}\n  writes: false\n');
  engine = await createEngine({ root: ws, client: 'mcp', autoStartWorker: false });
  fake = await createEngine({ root: ws, client: 'mcp', autoStartWorker: false, ports: { hooks: memory } });
});

afterAll(async () => {
  retakeHome.restore();
  await fixture?.close();
  if (ws) await rm(ws, { recursive: true, force: true });
});

describe('approvals at submit', () => {
  it('a capture: the preflight lists the hooks that need a human (templated, with the environment); an accept binds fingerprints of the raw hooks', async () => {
    const a = accept();
    const sub = await engine.runs.submit({ project: 'northfield-fixture', scenario: 'catalogue', mode: 'capture' }, { approver: a });
    expect(a.asked).toHaveLength(1);
    const req = a.asked[0];
    expect(req).toMatchObject({
      what: 'the capture of scenario catalogue',
      project: 'northfield-fixture',
      env: { name: 'local', production: false, access: 'read-write' },
      fix: `retake -C ${ws} run northfield-fixture catalogue`,
    });
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
    const sc = (await loadScenario(await openProjectBySlug(engine.workspace, 'northfield-fixture'), 'catalogue', { files: fileFacts(PERSON_POLICY) })).scenario;
    const fp = hookFingerprint(sc.setup![1], { phase: 'setup', index: 1, env: 'local' });
    // Signed at enqueue with the Retake home's key (the worker ignores an approval without a valid signature).
    expect((sub.job.input as RunJobInput).approvals).toEqual([{ fingerprint: fp, by: 'human-elicitation', at: expect.any(String), sig: expect.stringMatching(/^[0-9a-f]{64}$/) }]);
    await engine.runs.cancel('northfield-fixture', sub.run_id);
  });

  it("a capture with a `hook:` step (L5.8): the named hook's shell entry is asked about once, bound to the step phase and its position; no approver: needs_approval", async () => {
    const a = accept();
    const sub = await engine.runs.submit({ project: 'northfield-fixture', scenario: 'off-camera', mode: 'capture' }, { approver: a });
    expect(a.asked).toHaveLength(1);
    expect(a.asked[0].items).toEqual([
      expect.objectContaining({ phase: 'step', index: 1, name: 'queue', kind: 'shell', reason: 'a shell command (runs local code)', description: 'queue: shell "sleep 1.5"' }),
    ]);
    const sc = (await loadScenario(await openProjectBySlug(engine.workspace, 'northfield-fixture'), 'off-camera', { files: fileFacts(PERSON_POLICY) })).scenario;
    const entry = (sc.hooks!['cafe-requests-a-quote'] as HookStep[])[1];
    expect((sub.job.input as RunJobInput).approvals?.map((x) => x.fingerprint)).toEqual([hookFingerprint(entry, { phase: 'step', index: 1, env: 'local' })]);
    await engine.runs.cancel('northfield-fixture', sub.run_id);
    const none = await refusal(engine.runs.submit({ project: 'northfield-fixture', scenario: 'off-camera', mode: 'capture' }));
    expect(none.code).toBe('needs_approval');
    expect(none.message).toContain('step hook 2 "queue" (a shell command (runs local code))');
  });

  it('declined, dismissed, timed out, failed: refused with the CLI command, nothing queued; no approver: needs_approval', async () => {
    const before = (await engine.jobs.list()).length;
    // On the hooks package: a decline refuses.
    const real = await refusal(engine.hooks.submit({ project: 'northfield-fixture', source: 'catalogue:setup', dry: false }, { approver: approver({ approved: false, reason: 'declined' }) }));
    expect(real.code).toBe('refused');
    expect(real.message).toContain('the user declined');
    expect(real.message).toContain('free-registry-ref');
    // Every answer, on the in-memory runner: the preflight ran through the port, a dry run of the agent's hooks.
    memory.calls.splice(0);
    const cases: Array<[ApprovalOutcome | (() => Promise<ApprovalOutcome>), string]> = [
      [{ approved: false, reason: 'declined' }, 'the user declined'],
      [{ approved: false, reason: 'cancelled' }, 'the user dismissed the question'],
      [{ approved: false, reason: 'timeout' }, 'the user did not answer in time'],
      [() => Promise.reject(new Error('connection closed')), 'the question failed (connection closed)'],
    ];
    for (const [outcome, why] of cases) {
      const e = await refusal(fake.hooks.submit({ project: 'northfield-fixture', source: 'catalogue:setup', dry: false }, { approver: approver(outcome) }));
      expect(e.code, why).toBe('refused');
      expect(e.message).toContain(why);
      expect(e.message).toContain('Do not retry on your own');
      expect(e.fix).toBe(`retake -C ${ws} hooks run northfield-fixture catalogue:setup`);
    }
    const none = await refusal(fake.env.reset({ project: 'northfield-fixture', dry: false }).then(() => fake.hooks.submit({ project: 'northfield-fixture', source: 'catalogue:setup', dry: false })));
    expect(none.code).toBe('needs_approval');
    expect(none.message).toContain('cannot ask its user (no elicitation support)');
    expect(none.fix).toBe(`retake -C ${ws} hooks run northfield-fixture catalogue:setup`);
    // A scenario's hooks are the agent's (trust `mcp`); project.yaml's reset is a person's.
    const runs = memory.calls.flatMap((c) => (c.op === 'run' ? [[c.phase, c.dry, c.agentWritten, c.hooks.map((h) => h.name)]] : []));
    expect(runs).toEqual([
      ...Array.from({ length: 4 }, () => ['setup', true, true, ['reset', 'free-registry-ref']]),
      ['reset', true, undefined, ['reset-fixture']],
      ['setup', true, true, ['reset', 'free-registry-ref']],
    ]);
    expect(memory.executed).toEqual([]);
    // The reset (no hook needing a human) was queued without asking; nothing else.
    expect((await engine.jobs.list()).length).toBe(before + 1);
  });

  it("a hook the dry run cannot template is still asked about, from its file: its approval binds the files it references, as the worker's check does", async () => {
    await mkdir(join(project, 'scripts'), { recursive: true });
    await writeFile(join(project, 'scripts', 'warm.sh'), 'echo warm\n');
    // A variable the preflight cannot read: the dry run fails to template the hook, the backstop (its file) asks.
    const hook = { name: 'warm', shell: { run: 'sh scripts/warm.sh {{env:RETAKE_APPROVALS_TEST_UNSET}}' } };
    await writeFile(join(project, 'hooks', 'warm.yaml'), `- name: warm\n  shell: {run: "${hook.shell.run}"}\n`);
    const a = accept();
    const sub = await engine.hooks.submit({ project: 'northfield-fixture', source: 'hooks/warm.yaml', dry: false }, { approver: a });
    expect(a.asked[0].items).toEqual([expect.objectContaining({ name: 'warm', reason: 'a shell command (runs local code)' })]);
    const files = hookFiles(hook, { projectDir: project }).files;
    expect(Object.keys(files)).toEqual(['scripts/warm.sh']);
    expect((sub.job.input as HooksJobInput).approvals?.map((x) => x.fingerprint)).toEqual([hookFingerprint(hook, { phase: 'setup', index: 0, env: 'local', files })]);
  });

  it('dry runs ask nobody; names that are paths are refused before anything is read', async () => {
    const a = accept();
    memory.calls.splice(0);
    const dry = await fake.hooks.submit({ project: 'northfield-fixture', source: 'catalogue:setup' }, { approver: a });
    expect(dry.job.input).toMatchObject({ kind: 'hooks', dry: true, source: 'catalogue:setup' });
    expect((dry.job.input as HooksJobInput).approvals).toBeUndefined();
    expect(a.asked).toEqual([]);
    // A dry submit runs no preflight: nothing reached the hook runner.
    expect(memory.calls).toEqual([]);
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
    const scenario_sha256 = sha256Hex(await readFile(join(project, 'scenarios', 'catalogue.yaml')));
    const { result } = await execHooks({
      version: 1,
      kind: 'hooks',
      project: 'northfield-fixture',
      source: 'catalogue:setup',
      scenario_sha256,
      dry: true,
      journal_id: '20261017-140000-hooks-dry',
      submitted_by: 'mcp',
    });
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
    const r = await executeEnvResetJob({
      ...enginePorts(),
      ws: await openWorkspace({ root: ws, agent: false, reads: diskWorkspaceReads }),
      cli: 'retake',
      input: reset.job.input as EnvResetJobInput,
      signal: new AbortController().signal,
      event: () => undefined,
    });
    expect(r.ok).toBe(true);
    expect(r.rollbacks.find((j) => j.journal === sub.journal_id)?.results.map((x) => x.status)).toEqual(['ok']);
    expect(r.reset?.map((x) => [x.name, x.status])).toEqual([['reset-fixture', 'ok']]);
  });

  it('a hook changed between submit and run is refused: the approval is bound to the raw hook', async () => {
    const sub = await engine.hooks.submit({ project: 'northfield-fixture', source: 'catalogue:setup', dry: false }, { approver: accept() });
    const file = join(project, 'scenarios', 'catalogue.yaml');
    const original = await readFile(file, 'utf8');
    try {
      const changed = original.replace('finca-quenaro/refs"', 'finca-quenaro"');
      await writeFile(file, changed);
      // The job's scenario bytes are pinned: other bytes are a conflict before any hook (scenario-pinning test below).
      await expect(execHooks(sub.job.input as HooksJobInput)).rejects.toMatchObject({ code: 'conflict' });
      // With the changed bytes' hash, the approval of the hook as submitted does not fit the changed hook.
      const { result } = await execHooks({ ...(sub.job.input as HooksJobInput), scenario_sha256: sha256Hex(changed) });
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

describe('a hooks job runs the scenario bytes it was submitted with', () => {
  it('the sha256 of the bytes asked about is in the job; a scenario whose vars changed after the question is a conflict, nothing run', async () => {
    const file = join(project, 'scenarios', 'vars-hook.yaml');
    const asked = (sku: string) =>
      `video: vars-hook\nvars: {sku: ${sku}}\nsetup:\n  - name: free-ref\n    http: {method: DELETE, url: "{{console}}/api/products/{{vars.sku}}/refs"}\n    confirm: true\nscenes:\n  - id: home\n    page: console\n    open: /\n    steps:\n      - hold: 0.2\n`;
    await writeFile(file, asked('finca-quenaro'));
    try {
      const a = accept();
      const sub = await engine.hooks.submit({ project: 'northfield-fixture', source: 'vars-hook:setup', dry: false }, { approver: a });
      expect(a.asked).toHaveLength(1);
      expect(a.asked[0].items[0].description).toContain('finca-quenaro');
      expect((sub.job.input as HooksJobInput).scenario_sha256).toBe(sha256Hex(asked('finca-quenaro')));
      // The hook itself is unchanged (its fingerprint too); only what it is rendered with differs.
      await writeFile(file, asked('another-product'));
      const journal = standaloneJournalFile(project, sub.journal_id);
      const e = await refusal(execHooks(sub.job.input as HooksJobInput));
      expect(e.code).toBe('conflict');
      expect(e.message).toBe('scenarios/vars-hook changed since the hooks were submitted: submit them again (what was approved is what runs)');
      expect(e.details).toEqual({ submitted: sha256Hex(asked('finca-quenaro')), current: sha256Hex(asked('another-product')) });
      expect(existsSync(journal)).toBe(false);
    } finally {
      await rm(file, { force: true });
    }
  });

  it('a scenario hooks job without the sha256 (queued before it was carried, or by hand) is refused: submit it again', async () => {
    const e = await refusal(
      execHooks({ version: 1, kind: 'hooks', project: 'northfield-fixture', source: 'catalogue:setup', dry: true, journal_id: '20261017-170000-hooks-nosha', submitted_by: 'mcp' }),
    );
    expect(e.code).toBe('conflict');
    expect(e.message).toBe('this hooks job does not say which version of scenarios/catalogue was submitted: submit it again (what was approved is what runs)');
    // Sources that are not a scenario carry none and need none.
    const reset = await engine.hooks.submit({ project: 'northfield-fixture', source: 'reset' });
    expect(reset.job.input).not.toHaveProperty('scenario_sha256');
    const echo = await engine.hooks.submit({ project: 'northfield-fixture', source: 'hooks/echo.yaml' });
    expect(echo.job.input).not.toHaveProperty('scenario_sha256');
    expect((await execHooks(echo.job.input as HooksJobInput)).result.ok).toBe(true);
  });
});

describe('what a person is asked shows every hook in full', () => {
  const scenario = (name: string, extra: string) => `video: ${name}\n${extra}scenes:\n  - id: home\n    page: console\n    open: /\n    steps:\n      - hold: 0.2\n`;

  it('a long command, its cwd and each env entry, whole; the same hook written by the agent that sets a loader variable is refused before anyone is asked', async () => {
    await mkdir(join(project, 'scripts'), { recursive: true });
    const long = `echo ${'z'.repeat(300)}`;
    await writeFile(
      join(project, 'hooks', 'tooling.yaml'),
      `- name: tooling\n  shell:\n    run: "PATH=/usr/bin:/bin ${long}"\n    cwd: scripts\n    env: {NODE_OPTIONS: "--max-old-space-size=512", MODE: demo}\n`,
    );
    const file = join(project, 'scenarios', 'loader-hook.yaml');
    await writeFile(file, scenario('loader-hook', `setup:\n  - name: tooling\n    shell:\n      run: "PATH=/usr/bin:/bin ${long}"\n      cwd: scripts\n      env: {MODE: demo}\n`));
    try {
      // A person's file (hooks/<name>.yaml): asked about, shown whole — never cut.
      const a = accept();
      await engine.hooks.submit({ project: 'northfield-fixture', source: 'hooks/tooling.yaml', dry: false }, { approver: a });
      expect(a.asked[0].items[0]).toMatchObject({
        name: 'tooling',
        kind: 'shell',
        lines: [`run: PATH=/usr/bin:/bin ${long}`, 'cwd: scripts', 'env NODE_OPTIONS: --max-old-space-size=512', 'env MODE: demo'],
      });
      // The scenario's own hook (the agent's): refused at submit, nobody asked, nothing queued.
      const before = (await engine.jobs.list()).length;
      const b = accept();
      const e = await refusal(engine.hooks.submit({ project: 'northfield-fixture', source: 'loader-hook:setup', dry: false }, { approver: b }));
      expect(e.code).toBe('refused');
      expect(e.message).toContain('setup hook 1 "tooling": refusing shell hook: it uses `PATH=` (it sets PATH, a loader variable)');
      expect(e.fix).toBe(`retake -C ${ws} hooks run northfield-fixture loader-hook:setup`);
      expect(b.asked).toEqual([]);
      expect((await engine.jobs.list()).length).toBe(before);
    } finally {
      await rm(file, { force: true });
    }
  });

  it("a scenario's shell hook using what an agent-written hook may not (cd, $…) is refused at submit and by the worker; the same hook in hooks/<name>.yaml is asked about and runs", async () => {
    await mkdir(join(project, 'scripts'), { recursive: true });
    const marker = join(project, 'scripts', 'ran-cd.txt');
    const hook = 'shell: {run: "cd scripts && touch ran-cd.txt"}';
    await writeFile(join(project, 'hooks', 'mark-cd.yaml'), `- name: mark\n  ${hook}\n`);
    const file = join(project, 'scenarios', 'agent-cd.yaml');
    await writeFile(file, scenario('agent-cd', `setup:\n  - name: mark\n    ${hook}\n`));
    try {
      const before = (await engine.jobs.list()).length;
      const b = accept();
      const e = await refusal(engine.hooks.submit({ project: 'northfield-fixture', source: 'agent-cd:setup', dry: false }, { approver: b }));
      expect(e.code).toBe('refused');
      expect(e.message).toContain('setup hook 1 "mark": refusing shell hook: it uses `cd` (it changes the folder its paths resolve from: set the hook\'s `cwd` instead)');
      expect(e.message).toContain('have a person put it in hooks/<name>.yaml');
      const c = accept();
      const run = await refusal(engine.runs.submit({ project: 'northfield-fixture', scenario: 'agent-cd', mode: 'capture' }, { approver: c }));
      expect(run.code).toBe('refused');
      expect(run.message).toContain('refusing shell hook: it uses `cd`');
      expect([...b.asked, ...c.asked]).toEqual([]);
      expect((await engine.jobs.list()).length).toBe(before);
      // A job queued without the submit (its scenario's bytes pinned): the worker refuses the hook before anything runs.
      const { result } = await execHooks({
        version: 1,
        kind: 'hooks',
        project: 'northfield-fixture',
        source: 'agent-cd:setup',
        scenario_sha256: sha256Hex(await readFile(file)),
        dry: false,
        journal_id: '20261105-100000-hooks-agent-cd',
        submitted_by: 'mcp',
      });
      expect(result.results[0]).toMatchObject({ name: 'mark', status: 'refused' });
      expect(result.results[0].untrusted.error).toContain('refusing shell hook: it uses `cd`');
      expect(existsSync(marker)).toBe(false);
      // A person's file: asked about, approved, run by the worker.
      const a = accept();
      const sub = await engine.hooks.submit({ project: 'northfield-fixture', source: 'hooks/mark-cd.yaml', dry: false }, { approver: a });
      expect(a.asked[0].items).toEqual([expect.objectContaining({ name: 'mark', lines: ['run: cd scripts && touch ran-cd.txt'] })]);
      const ran = await execHooks(sub.job.input as HooksJobInput);
      expect(ran.result.results[0]).toMatchObject({ name: 'mark', status: 'ok' });
      expect(existsSync(marker)).toBe(true);
    } finally {
      await rm(file, { force: true });
      await rm(marker, { force: true });
    }
  });

  it("a capture: a project.yaml hook rendered with the scenario's vars is the agent's (refused); with project.yaml's own vars it is a person's (asked)", async () => {
    const yamlFile = join(project, 'project.yaml');
    const original = await readFile(yamlFile, 'utf8');
    const steps = `scenes:\n  - id: home\n    page: console\n    open: /\n    steps:\n      - hook: warm\n      - hold: 0.2\n`;
    const own = join(project, 'scenarios', 'warm-own.yaml');
    const agents = join(project, 'scenarios', 'warm-agent.yaml');
    await writeFile(yamlFile, `${original}\nvars: {prefix: "PATH=/usr/bin:/bin"}\nhooks:\n  warm: {shell: {run: "{{vars.prefix}} echo warm"}}\n`);
    await writeFile(own, `video: warm-own\n${steps}`);
    await writeFile(agents, `video: warm-agent\nvars: {prefix: "PATH=/usr/bin:/bin"}\n${steps}`);
    try {
      const a = accept();
      const sub = await engine.runs.submit({ project: 'northfield-fixture', scenario: 'warm-own', mode: 'capture' }, { approver: a });
      expect(a.asked[0].items).toEqual([expect.objectContaining({ phase: 'step', name: 'warm', lines: ['run: PATH=/usr/bin:/bin echo warm'] })]);
      await engine.runs.cancel('northfield-fixture', sub.run_id);
      const b = accept();
      const e = await refusal(engine.runs.submit({ project: 'northfield-fixture', scenario: 'warm-agent', mode: 'capture' }, { approver: b }));
      expect(e.code).toBe('refused');
      expect(e.message).toContain('step hook 1 "warm": refusing shell hook: it uses `PATH=` (it sets PATH, a loader variable)');
      expect(b.asked).toEqual([]);
    } finally {
      await writeFile(yamlFile, original);
      await rm(own, { force: true });
      await rm(agents, { force: true });
    }
  });

  it('a hook over 4,000 characters, or a form over 16,000, is refused before anyone is asked: run it in a terminal', async () => {
    const item = (index: number, chars: number) => ({
      fingerprint: String(index).repeat(64).slice(0, 64),
      phase: 'setup' as const,
      index,
      name: `h${index}`,
      kind: 'shell',
      description: 'd',
      reason: 'a shell command (runs local code)',
      lines: [`run: ${'x'.repeat(chars)}`],
    });
    const req = (items: ApprovalRequest['items']): ApprovalRequest => ({
      what: 'hooks x:setup',
      project: 'p',
      env: { name: 'local', production: false, access: 'read-write' },
      items,
      fix: 'retake hooks run p x:setup',
    });
    // A hook's text in the form: its numbered heading and why, then its lines indented (engine approvalFormText).
    const head = '1. setup hook 1 "h0" (shell) — a shell command (runs local code)\n'.length + '   run: '.length;
    // Exactly at the limit: asked.
    const ok = accept();
    // Each approval is stamped with the clock handed (the engine's), never the system's.
    const clock = new ManualClock('2026-03-04T05:06:07.890Z');
    expect(await takeApprovals(req([item(0, APPROVAL_HOOK_MAX_CHARS - head)]), ok, undefined, clock)).toEqual([
      { fingerprint: '0'.repeat(64), by: 'human-elicitation', at: '2026-03-04T05:06:07.890Z' },
    ]);
    expect(ok.asked).toHaveLength(1);
    const one = accept();
    const long = await refusal(takeApprovals(req([item(0, APPROVAL_HOOK_MAX_CHARS - head + 1)]), one, undefined, clock));
    expect(long.code).toBe('refused');
    expect(long.message).toBe(
      'hooks x:setup was not started: setup hook 1 "h0" (shell) is 4,001 characters long (a form shows at most 4,000 per hook) — too long to approve in a form: run it in a terminal',
    );
    expect(long.fix).toBe('retake hooks run p x:setup');
    expect(one.asked).toEqual([]);
    // Without an approver too: the same refusal, not needs_approval.
    expect((await refusal(takeApprovals(req([item(0, 5_000)]), undefined, undefined, clock))).code).toBe('refused');
    // Five hooks of 3,500 characters each: every one under its limit, the form over 16,000.
    const many = accept();
    const form = await refusal(takeApprovals(req([0, 1, 2, 3, 4].map((i) => item(i, 3_500))), many, undefined, clock));
    expect(form.message).toMatch(/^hooks x:setup was not started: its 5 hooks make a form of 18,\d{3} characters \(at most 16,000\) — too long to approve in a form: run it in a terminal$/);
    expect(many.asked).toEqual([]);
    const four = accept();
    expect(await takeApprovals(req([0, 1, 2, 3].map((i) => item(i, 3_500))), four, undefined, clock)).toHaveLength(4);
    // The whole form counts — its opening and closing lines too: four hooks at their limit make a form over 16,000.
    const full = req([0, 1, 2, 3].map((i) => item(i, APPROVAL_HOOK_MAX_CHARS - head)));
    expect(approvalFormText(full).length).toBeGreaterThan(APPROVAL_FORM_MAX_CHARS);
    const atLimit = accept();
    expect((await refusal(takeApprovals(full, atLimit, undefined, clock))).message).toContain(
      `its 4 hooks make a form of ${approvalFormText(full).length.toLocaleString('en-US')} characters (at most 16,000)`,
    );
    expect(atLimit.asked).toEqual([]);
  });
});

describe('the CLI keeps its trust rules', () => {
  it("`retake hooks run` honours `confirm: true` (no prompt, no --yes) and a shell hook's `writes: false`", async () => {
    const io = memoryIo();
    expect(await main(['node', 'retake', '--root', ws, 'hooks', 'run', 'northfield-fixture', 'catalogue:setup'], io), io.stdout() + io.stderr()).toBe(EXIT.ok);
    expect(io.stdout() + io.stderr()).toContain('catalogue-setup: done');
    const prod = memoryIo();
    expect(await main(['node', 'retake', '--root', ws, 'hooks', 'run', 'northfield-fixture', 'hooks/echo.yaml', '--env', 'production'], prod), prod.stdout() + prod.stderr()).toBe(EXIT.ok);
    expect(prod.stdout() + prod.stderr()).toContain('echo: done');
    const reset = memoryIo();
    expect(await main(['node', 'retake', '--root', ws, 'env', 'reset', 'northfield-fixture'], reset)).toBe(EXIT.ok);
  });

  it("`retake hooks rollback` of an id with no journal says the two places it looked, the run's first", async () => {
    const io = memoryIo();
    expect(await main(['node', 'retake', '--root', ws, 'hooks', 'rollback', 'northfield-fixture', '20990101-000000-none'], io)).toBe(EXIT.failure);
    expect(io.stderr()).toContain(
      `"20990101-000000-none" has no hooks journal (looked for ${join(project, 'runs', '20990101-000000-none', 'hooks-journal.json')} and ${join(project, '.retake', 'journals', '20990101-000000-none.json')})`,
    );
  });
});
