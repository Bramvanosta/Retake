/**
 * L7.33: the jobs that run a scenario's hooks (a capture, `hooks <scenario>:setup|teardown`) ask a person about every
 * sql hook of the scenario — setup, teardown, the named hooks its `hook:` steps run — as about its shell hooks, each
 * bound to its fingerprint (its sql file's bytes included). A person's hooks (hooks/<name>.yaml, project.yaml's reset)
 * keep the destructive rule only. On the hooks package (`engine`) and on the in-memory hook runner (`fake`).
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AGENT_SQL_REASON, PERSON_POLICY, stepHookList } from '@retake/core';
import type { HookContext } from '@retake/core';
import type { HooksJobInput, RunJobInput } from '@retake/engine';
import { fileFacts, loadScenario } from '@retake/core/io';
import { hookFiles, hookFingerprint } from '@retake/hooks';
import { EngineError, createEngine, openProjectBySlug } from '../src/index.js';
import type { ApprovalRequest, Approver, Engine } from '../src/index.js';
import { MemoryHookRunner } from '../src/hook-run/memory-hooks.js';
import { fixtureWorkspace } from './helpers.js';

let ws: string;
let project: string;
let engine: Engine;
let fake: Engine;
const memory = new MemoryHookRunner();
const savedHome = process.env.RETAKE_HOME;

function accept(): Approver & { asked: ApprovalRequest[] } {
  const asked: ApprovalRequest[] = [];
  return { asked, approve: async (req) => (asked.push(req), { approved: true }) };
}

async function refusal(p: Promise<unknown>): Promise<EngineError> {
  const e = await p.then(
    () => undefined,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(EngineError);
  return e as EngineError;
}

const SCENARIO = `version: 1
video: sql-hooks
title: {kicker: For roasters, text: Data set up by statements}
setup:
  - name: seed
    sql: {query: "INSERT INTO replies (text) VALUES ('hi')", rollback: "INSERT INTO undone (text) VALUES ('hi')"}
  - name: ping
    http: {method: GET, url: "{{console}}/api/products"}
teardown:
  - name: tidy
    sql: hooks/tidy.sql
hooks:
  count:
    sql: "SELECT count(*) FROM replies"
scenes:
  - id: list
    page: console
    open: /products
    steps:
      - hook: count
      - wait_for: {text: Products}
`;

beforeAll(async () => {
  ws = await mkdtemp(join(tmpdir(), 'retake-agent-sql-'));
  process.env.RETAKE_HOME = join(ws, '.home');
  await fixtureWorkspace(ws);
  project = join(ws, 'projects', 'northfield-fixture');
  const yaml = await readFile(join(project, 'project.yaml'), 'utf8');
  // A database nobody listens on: nothing here executes a statement.
  // A person's named hook whose file renders the scenario's vars.
  await writeFile(join(project, 'project.yaml'), `${yaml}\ndatabases:\n  main: {url: "postgres://app@127.0.0.1:1/northfield"}\nhooks:\n  add:\n    sql: hooks/add.sql\n`);
  await mkdir(join(project, 'hooks'), { recursive: true });
  await writeFile(join(project, 'hooks', 'tidy.sql'), "SELECT 'tidy';\n");
  await writeFile(join(project, 'hooks', 'add.sql'), "INSERT INTO users (name) VALUES ('{{vars.name}}');\n");
  await writeFile(
    join(project, 'scenarios', 'sql-vars.yaml'),
    `version: 1\nvideo: sql-vars\nvars:\n  name: "x'); SELECT ('y"\nscenes:\n  - id: list\n    page: console\n    open: /products\n    steps:\n      - hook: add\n      - wait_for: {text: Products}\n`,
  );
  await writeFile(join(project, 'hooks', 'mine.yaml'), '- name: mine\n  sql: "SELECT 1"\n');
  await writeFile(join(project, 'scenarios', 'sql-hooks.yaml'), SCENARIO);
  // Its database is not declared: the dry run cannot prepare it, the backstop (its file) still asks.
  await writeFile(
    join(project, 'scenarios', 'sql-other-db.yaml'),
    SCENARIO.replace('video: sql-hooks', 'video: sql-other-db').replace('sql: hooks/tidy.sql', 'sql: {query: "SELECT \'tidy\'", db: reports}'),
  );
  engine = await createEngine({ root: ws, client: 'mcp', autoStartWorker: false });
  fake = await createEngine({ root: ws, client: 'mcp', autoStartWorker: false, ports: { hooks: memory } });
});

afterAll(async () => {
  if (savedHome === undefined) delete process.env.RETAKE_HOME;
  else process.env.RETAKE_HOME = savedHome;
  if (ws) await rm(ws, { recursive: true, force: true });
});

async function scenario() {
  return (await loadScenario(await openProjectBySlug(engine.workspace, 'northfield-fixture'), 'sql-hooks', { files: fileFacts(PERSON_POLICY) })).scenario;
}

describe("an agent's sql hooks in jobs (trust mcp)", () => {
  for (const [label, which] of [
    ['the hooks package', () => engine],
    ['the in-memory runner', () => fake],
  ] as const) {
    it(`a capture asks about each sql hook of the scenario (setup, teardown, step) — ${label}`, async () => {
      const a = accept();
      const sub = await which().runs.submit({ project: 'northfield-fixture', scenario: 'sql-hooks', mode: 'capture' }, { approver: a });
      try {
        expect(a.asked).toHaveLength(1);
        expect(a.asked[0].items.map((i) => [i.phase, i.index, i.name, i.reason])).toEqual([
          ['setup', 0, 'seed', AGENT_SQL_REASON],
          ['teardown', 0, 'tidy', AGENT_SQL_REASON],
          ['step', 0, 'count', AGENT_SQL_REASON],
        ]);
        expect((sub.job.input as RunJobInput).approvals?.map((x) => x.fingerprint)).toEqual(a.asked[0].items.map((i) => i.fingerprint));
      } finally {
        await which().runs.cancel('northfield-fixture', sub.run_id);
      }
    });
  }

  it('each approval is the fingerprint the worker checks (hookFingerprint, the sql file bound)', async () => {
    const a = accept();
    const sub = await engine.runs.submit({ project: 'northfield-fixture', scenario: 'sql-hooks', mode: 'capture' }, { approver: a });
    try {
      const sc = await scenario();
      const tidy = sc.teardown![0];
      const files = hookFiles(tidy, { projectDir: project }).files;
      expect(Object.keys(files)).toEqual(['hooks/tidy.sql']);
      expect((sub.job.input as RunJobInput).approvals?.map((x) => x.fingerprint)).toEqual([
        hookFingerprint(sc.setup![0], { phase: 'setup', index: 0, env: 'local' }),
        hookFingerprint(tidy, { phase: 'teardown', index: 0, env: 'local', files }),
        hookFingerprint(stepHookList(sc)[0], { phase: 'step', index: 0, env: 'local' }),
      ]);
    } finally {
      await engine.runs.cancel('northfield-fixture', sub.run_id);
    }
  });

  it('the approval shows the statement and its rollback; without an approver: needs_approval, nothing queued', async () => {
    const a = accept();
    const sub = await engine.runs.submit({ project: 'northfield-fixture', scenario: 'sql-hooks', mode: 'capture' }, { approver: a });
    try {
      const seed = a.asked[0].items[0];
      expect(seed.lines.some((l) => l.includes("INSERT INTO replies (text) VALUES ('hi')"))).toBe(true);
      expect(seed.lines.some((l) => l.startsWith('rollback ') && l.includes("INSERT INTO undone (text) VALUES ('hi')"))).toBe(true);
    } finally {
      await engine.runs.cancel('northfield-fixture', sub.run_id);
    }
    const before = (await engine.jobs.list()).length;
    const none = await refusal(engine.runs.submit({ project: 'northfield-fixture', scenario: 'sql-hooks', mode: 'capture' }));
    expect(none.code).toBe('needs_approval');
    expect(none.message).toContain(`setup hook 1 "seed" (${AGENT_SQL_REASON})`);
    expect((await engine.jobs.list()).length).toBe(before);
  });

  it("the in-memory runner keeps the hooks package's rule: an agent's sql hook asks, a person's does not", async () => {
    const runner = new MemoryHookRunner();
    const ctx = { project: { dir: project }, env: { name: 'local', pages: {} }, trust: 'mcp', dryRun: true, vars: {}, saved: {}, log: () => undefined } as unknown as HookContext;
    const journal = await runner.journals.open(await runner.journals.standaloneFile(project, '20261112-100000-hooks-sql'));
    const hooks = [{ name: 'q', sql: 'SELECT 1' }];
    const agent = await runner.run(hooks, ctx, { phase: 'setup', journal, agentWritten: true });
    expect(agent.results[0].approval?.reason).toBe(AGENT_SQL_REASON);
    const own = await runner.run(hooks, ctx, { phase: 'setup', journal });
    expect(own.results[0].approval).toBeUndefined();
    // A person's hook rendered with the agent's vars counts as the agent's (the package's rule).
    const steered = await runner.run([{ name: 'v', sql: 'SELECT {{vars.who}}' }], { ...ctx, agentVars: ['who'] } as HookContext, { phase: 'setup', journal });
    expect(steered.results[0].approval?.reason).toBe(AGENT_SQL_REASON);
  });

  it("a person's named sql hook whose file renders the scenario's vars is asked, its statement shown as it will run", async () => {
    const a = accept();
    const sub = await engine.runs.submit({ project: 'northfield-fixture', scenario: 'sql-vars', mode: 'capture' }, { approver: a });
    try {
      expect(a.asked[0].items.map((i) => [i.phase, i.name, i.reason])).toEqual([['step', 'add', AGENT_SQL_REASON]]);
      expect(a.asked[0].items[0].lines).toEqual(expect.arrayContaining(['file: hooks/add.sql', "query: INSERT INTO users (name) VALUES ('x'); SELECT ('y');"]));
    } finally {
      await engine.runs.cancel('northfield-fixture', sub.run_id);
    }
  });

  it('a hook the dry run cannot prepare (a database not declared) is still asked about, from its file', async () => {
    const a = accept();
    await engine.hooks.submit({ project: 'northfield-fixture', source: 'sql-other-db:teardown', dry: false }, { approver: a });
    expect(a.asked[0].items.map((i) => [i.name, i.reason])).toEqual([['tidy', AGENT_SQL_REASON]]);
  });

  it("a hooks job of the scenario's setup / teardown asks; a person's hooks/<name>.yaml sql hook does not", async () => {
    for (const [source, name] of [
      ['sql-hooks:setup', 'seed'],
      ['sql-hooks:teardown', 'tidy'],
    ] as const) {
      const a = accept();
      const sub = await engine.hooks.submit({ project: 'northfield-fixture', source, dry: false }, { approver: a });
      expect(a.asked[0].items.map((i) => [i.name, i.reason])).toEqual([[name, AGENT_SQL_REASON]]);
      expect((sub.job.input as HooksJobInput).approvals).toHaveLength(1);
    }
    const a = accept();
    const mine = await engine.hooks.submit({ project: 'northfield-fixture', source: 'hooks/mine.yaml', dry: false }, { approver: a });
    expect(a.asked).toEqual([]);
    expect((mine.job.input as HooksJobInput).approvals).toBeUndefined();
  });
});
