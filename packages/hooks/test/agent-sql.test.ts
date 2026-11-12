/**
 * L7.33: under trust `mcp`, an sql hook the agent wrote is asked about like its shell hooks — whatever its statement —
 * bound to the same fingerprint (hookFingerprint, its files' bytes included). A person's sql hook keeps the destructive
 * rule only, and a sandbox's seed steps are not concerned. The runs against a real Postgres need RETAKE_TEST_PG
 * (`pnpm test:pg`); the others reach a closed port, so an approved hook gets as far as connecting and fails there.
 */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AGENT_SQL_REASON, hookApprovalReason, scenarioBlocks } from '@retake/core';
import type { HookStep } from '@retake/core';
import { Journal, hookFiles, hookFingerprint, runHooks } from '@retake/hooks';
import type { HookApprovalRequest } from '@retake/hooks';
import { makeContext, makeProject, tempProject, writeFiles } from './helpers.js';

let tmp: Awaited<ReturnType<typeof tempProject>>;
beforeEach(async () => {
  tmp = await tempProject();
});
afterEach(async () => {
  await tmp.cleanup();
});

const journal = () => Journal.open(join(tmp.dir, 'runs/r1/hooks-journal.json'));
/** A database nobody listens on: an approved hook fails when it connects, an unapproved one never gets there. */
const CLOSED = 'postgres://app@127.0.0.1:1/northfield';
const context = (url: string, over: Parameters<typeof makeContext>[1] = {}) => makeContext(makeProject(tmp.dir, {}, { databases: { main: { url } } }), over);
const SELECT: HookStep = { name: 'count', sql: 'SELECT count(*) FROM replies' };
const INSERT: HookStep = { name: 'seed', sql: { query: "INSERT INTO replies (text) VALUES ('hi')", rollback: "INSERT INTO undone (text) VALUES ('hi')" } };
const FILE: HookStep = { name: 'file', sql: 'hooks/seed.sql' };

/** An approver that records what it is asked and answers from a set of approved fingerprints (the worker's rule). */
function approver(approved: readonly string[] = []) {
  const asked: HookApprovalRequest[] = [];
  const set = new Set(approved);
  return { asked, confirm: (_d: string, _r: string, req: HookApprovalRequest) => (asked.push(req), set.has(req.fingerprint)) };
}

describe("an agent's sql hooks under trust mcp", () => {
  it.each(['setup', 'teardown', 'step'] as const)('%s: refused without a person, asked with the raw hook and its fingerprint — nothing connects', async (phase) => {
    const a = approver();
    const { ctx } = context(CLOSED, { trust: 'mcp', confirmDestructive: a.confirm });
    const res = await runHooks([SELECT], ctx, { phase, journal: await journal(), agentWritten: true });
    expect(res.results[0]).toMatchObject({ status: 'refused', approval: { reason: AGENT_SQL_REASON } });
    expect(res.results[0].error).toContain(`refusing hook (${AGENT_SQL_REASON}) without a human approval`);
    expect(res.results[0].error).not.toContain('cannot connect');
    expect(a.asked).toEqual([expect.objectContaining({ phase, index: 0, hook: SELECT, fingerprint: hookFingerprint(SELECT, { phase, index: 0, env: 'local' }) })]);
  });

  it('approved by its fingerprint: it runs (here it reaches the database and fails to connect)', async () => {
    const fp = hookFingerprint(SELECT, { phase: 'setup', index: 0, env: 'local' });
    const { ctx } = context(CLOSED, { trust: 'mcp', confirmDestructive: approver([fp]).confirm });
    const res = await runHooks([SELECT], ctx, { phase: 'setup', journal: await journal(), agentWritten: true });
    expect(res.results[0]).toMatchObject({ status: 'failed', approval: { reason: AGENT_SQL_REASON, fingerprint: fp } });
    expect(res.results[0].error).toContain('cannot connect to database main');
  });

  it('changed since its approval: another statement, or the file it reads with other bytes, is refused', async () => {
    await writeFiles(tmp.dir, { 'hooks/seed.sql': "INSERT INTO replies (text) VALUES ('a');\n" });
    const fpOf = (hook: HookStep) => hookFingerprint(hook, { phase: 'setup', index: 0, env: 'local', files: hookFiles(hook, { projectDir: tmp.dir }).files });
    const approved = [fpOf(SELECT), fpOf(FILE)];
    const changed: HookStep = { ...SELECT, sql: 'SELECT count(*) FROM orders' };
    const run = async (hook: HookStep) => (await runHooks([hook], context(CLOSED, { trust: 'mcp', confirmDestructive: approver(approved).confirm }).ctx, { phase: 'setup', journal: await journal(), agentWritten: true })).results[0];
    expect((await run(changed)).status).toBe('refused');
    expect((await run(FILE)).status).toBe('failed'); // approved: it connects (and fails there)
    await writeFile(join(tmp.dir, 'hooks/seed.sql'), "INSERT INTO replies (text) VALUES ('b');\n");
    expect((await run(FILE)).status).toBe('refused');
  });

  it('its rollback is shown in the approval and approved with it', async () => {
    const { ctx } = context(CLOSED, { trust: 'mcp', dryRun: true });
    const res = await runHooks([INSERT], ctx, { phase: 'setup', journal: await journal(), agentWritten: true });
    expect(res.results[0]).toMatchObject({ status: 'dry', approval: { reason: AGENT_SQL_REASON } });
    expect(res.results[0].message).toBe(`not executed (dry run); needs a human approval: ${AGENT_SQL_REASON}`);
    expect(res.results[0].shown?.some((l) => l.startsWith('rollback ') && l.includes("INSERT INTO undone (text) VALUES ('hi')"))).toBe(true);
  });

  it("a person's hook rendered with the agent's vars counts as the agent's", async () => {
    const hook: HookStep = { sql: 'SELECT * FROM {{vars.table}}' };
    const { ctx } = context(CLOSED, { trust: 'mcp', dryRun: true, vars: { table: 'replies' }, agentVars: ['table'] });
    const res = await runHooks([hook], ctx, { phase: 'teardown', journal: await journal() });
    expect(res.results[0].approval?.reason).toBe(AGENT_SQL_REASON);
  });

  it("a person's hook whose file, rollback file or database URL uses the agent's vars counts as the agent's", async () => {
    await writeFiles(tmp.dir, { 'hooks/add.sql': "INSERT INTO users (name) VALUES ('{{vars.name}}');\n", 'hooks/plain.sql': 'SELECT 1;\n', 'hooks/undo.sql': "DELETE FROM users WHERE name = '{{name}}';\n" });
    const over = { trust: 'mcp' as const, dryRun: true, vars: { name: 'x' }, agentVars: ['name'] };
    const reasons = async (hooks: HookStep[], url = CLOSED, phase: 'step' | 'setup' = 'step') =>
      (await runHooks(hooks, context(url, over).ctx, { phase, journal: await journal() })).results.map((r) => r.approval?.reason);
    expect(await reasons([{ name: 'add', sql: 'hooks/add.sql' }, { sql: { file: 'hooks/add.sql' } }, { sql: 'hooks/plain.sql' }])).toEqual([AGENT_SQL_REASON, AGENT_SQL_REASON, undefined]);
    // Its rollback file (setup and step journal one): asked, its destructive rollback named too.
    expect(await reasons([{ sql: { file: 'hooks/plain.sql', rollback: 'hooks/undo.sql' } }], CLOSED, 'setup')).toEqual([`${AGENT_SQL_REASON}; its rollback: hooks/undo.sql contains DELETE`]);
    // Its database URL.
    expect(await reasons([{ sql: 'hooks/plain.sql' }], 'postgres://app@127.0.0.1:1/{{vars.name}}')).toEqual([AGENT_SQL_REASON]);
    // Without the agent's vars (a terminal, or vars the person wrote): not asked.
    const own = await runHooks([{ sql: 'hooks/add.sql' }], context(CLOSED, { ...over, agentVars: [] }).ctx, { phase: 'step', journal: await journal() });
    expect(own.results[0].approval).toBeUndefined();
  });

  it('the approval shows a file hook\'s statement as it will run, rendered with the vars, beside the file and its database', async () => {
    await writeFiles(tmp.dir, { 'hooks/add.sql': "INSERT INTO users (name) VALUES ('{{vars.name}}');\n", 'hooks/undo.sql': "INSERT INTO undone VALUES ('{{vars.name}}');\n" });
    const { ctx } = context(CLOSED, { trust: 'mcp', dryRun: true, vars: { name: "x'); SELECT ('y" } });
    const res = await runHooks([{ sql: { file: 'hooks/add.sql', rollback: 'hooks/undo.sql' } }], ctx, { phase: 'setup', journal: await journal(), agentWritten: true });
    const lines = res.results[0].shown ?? [];
    expect(lines).toEqual(expect.arrayContaining(['file: hooks/add.sql', "query: INSERT INTO users (name) VALUES ('x'); SELECT ('y');", 'rollback file: hooks/undo.sql', "rollback query: INSERT INTO undone VALUES ('x'); SELECT ('y');"]));
  });

  it("a person's sql hook (not the agent's) keeps the destructive rule only; a sandbox's seed is not asked", async () => {
    const { ctx } = context(CLOSED, { trust: 'mcp', dryRun: true });
    const own = await runHooks([SELECT, { sql: 'DELETE FROM replies' }], ctx, { phase: 'teardown', journal: await journal() });
    expect(own.results.map((r) => r.approval?.reason)).toEqual([undefined, 'SQL DELETE']);
    const seed = await runHooks([SELECT], ctx, { phase: 'seed', journal: await journal(), agentWritten: true });
    expect(seed.results[0].approval).toBeUndefined();
  });

  it('a destructive statement the agent wrote keeps its destructive reason', async () => {
    const { ctx } = context(CLOSED, { trust: 'mcp', dryRun: true });
    const res = await runHooks([{ sql: 'DELETE FROM replies' }], ctx, { phase: 'teardown', journal: await journal(), agentWritten: true });
    expect(res.results[0].approval?.reason).toBe('SQL DELETE');
  });

  it('trust author (a terminal) is unchanged: an sql hook needs nobody', async () => {
    const a = approver();
    const { ctx } = context(CLOSED, { confirmDestructive: a.confirm });
    const res = await runHooks([SELECT], ctx, { phase: 'setup', journal: await journal(), agentWritten: true });
    expect(res.results[0].status).toBe('failed');
    expect(res.results[0].error).toContain('cannot connect');
    expect(a.asked).toEqual([]);
  });

  it("the static reason (core hookApprovalReason): an agent's sql hook needs a person, a person's does not", () => {
    expect(hookApprovalReason(SELECT, 'setup', { agentWritten: true })).toBe(AGENT_SQL_REASON);
    expect(hookApprovalReason(SELECT, 'setup')).toBeNull();
    expect(hookApprovalReason({ sql: 'DROP TABLE replies' }, 'setup', { agentWritten: true })).toBe('SQL DROP');
    expect(hookApprovalReason({ http: { url: 'https://console.example.com/api' } }, 'setup', { agentWritten: true })).toBeNull();
  });

  it("a scenario's blocks (the Studio's hooks strip, scenario_blocks) say that its sql hooks need a person", () => {
    const blocks = scenarioBlocks('video: x\nsetup:\n  - sql: "SELECT 1"\nhooks:\n  n:\n    sql: "SELECT 2"\nscenes: []\n');
    expect(blocks.hooks.setup.map((h) => h.needs_person)).toEqual([AGENT_SQL_REASON]);
    expect(blocks.hooks.named.map((h) => h.needs_person)).toEqual([AGENT_SQL_REASON]);
  });
});

/** Real Postgres (`pnpm test:pg`): the statement runs only once a person approved it. */
const PG = process.env.RETAKE_TEST_PG;

describe.skipIf(!PG)("an agent's sql hooks under trust mcp, against Postgres", () => {
  const table = `nf_agent_${process.pid}_${Date.now() % 100000}`;
  let admin: pg.Client;
  beforeAll(async () => {
    admin = new pg.Client({ connectionString: PG });
    await admin.connect();
    await admin.query(`CREATE TABLE ${table} (id serial PRIMARY KEY, text text NOT NULL)`);
  });
  afterAll(async () => {
    await admin.query(`DROP TABLE IF EXISTS ${table}`);
    await admin.end();
  });
  beforeEach(async () => {
    await admin.query(`TRUNCATE ${table}`);
  });
  const texts = async () => (await admin.query(`SELECT text FROM ${table} ORDER BY id`)).rows.map((r: { text: string }) => r.text);

  it('refused without a person (the table untouched); approved, it runs; changed since, refused', async () => {
    const hook: HookStep = { name: 'seed', sql: `INSERT INTO ${table} (text) VALUES ('agent')` };
    const fp = hookFingerprint(hook, { phase: 'setup', index: 0, env: 'local' });
    const run = async (h: HookStep, approved: string[]) =>
      (await runHooks([h], context('{{env:RETAKE_TEST_PG}}', { trust: 'mcp', confirmDestructive: approver(approved).confirm }).ctx, { phase: 'setup', journal: await journal(), agentWritten: true })).results[0];
    expect((await run(hook, [])).status).toBe('refused');
    expect(await texts()).toEqual([]);
    expect(await run(hook, [fp])).toMatchObject({ status: 'ok', message: '1 statement, 1 row affected' });
    expect(await texts()).toEqual(['agent']);
    expect((await run({ ...hook, sql: `INSERT INTO ${table} (text) VALUES ('other')` }, [fp])).status).toBe('refused');
    expect(await texts()).toEqual(['agent']);
  });

  it("a person's hook whose file renders the agent's vars: refused without a person, nothing written", async () => {
    await writeFiles(tmp.dir, { 'hooks/add.sql': `INSERT INTO ${table} (text) VALUES ('{{vars.name}}');\n` });
    const { ctx } = context('{{env:RETAKE_TEST_PG}}', { trust: 'mcp', vars: { name: "x'), ('injected" }, agentVars: ['name'], confirmDestructive: approver().confirm });
    const res = await runHooks([{ name: 'add', sql: 'hooks/add.sql' }], ctx, { phase: 'step', journal: await journal() });
    expect(res.results[0]).toMatchObject({ status: 'refused', approval: { reason: AGENT_SQL_REASON } });
    expect(await texts()).toEqual([]);
  });
});
