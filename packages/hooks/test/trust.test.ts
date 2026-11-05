/**
 * L3.1 (R-MCP-35, safety S1): hooks run with trust `mcp` — work submitted through the MCP server, whose agent can write
 * the hook files — ignore `confirm: true`, need a human approval for every destructive or shell hook (bound to the
 * raw hook's fingerprint), and count every shell hook as writing; a dry run asks nobody. Trust `author` (the CLI) is
 * unchanged.
 */
import { existsSync } from 'node:fs';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Journal, hookFiles, hookFingerprint, runHooks } from '@retake/hooks';
import type { HookApprovalRequest } from '@retake/hooks';
import { writingHooks } from '@retake/core';
import type { HookAccess, HookStep } from '@retake/core';
import { makeContext, makeProject, startApi, tempProject } from './helpers.js';

let tmp: Awaited<ReturnType<typeof tempProject>>;
let api: Awaited<ReturnType<typeof startApi>>;
beforeEach(async () => {
  tmp = await tempProject();
  api = await startApi();
});
afterEach(async () => {
  await api.close();
  await tmp.cleanup();
});

const READ_ONLY: HookAccess = { env: 'production', mode: 'read-only', production: true, configured: 'read-only' };
const journal = () => Journal.open(join(tmp.dir, 'runs/r1/hooks-journal.json'));
const context = (over: Parameters<typeof makeContext>[1] = {}) => makeContext(makeProject(tmp.dir, { console: api.base }), over);

const DELETE_CONFIRMED: HookStep = { name: 'free', http: { method: 'DELETE', url: '{{console}}/api/replies/1', expect: [200, 204, 404] }, confirm: true };
const SHELL_READS: HookStep = { name: 'echo', shell: { run: 'echo hello' }, writes: false };

describe('hook trust', () => {
  it('author (the CLI): confirm: true counts, a shell hook declared `writes: false` needs nobody', async () => {
    const confirm = vi.fn(() => false);
    const { ctx } = context({ confirmDestructive: confirm });
    const res = await runHooks([DELETE_CONFIRMED, SHELL_READS], ctx, { phase: 'teardown', journal: await journal() });
    expect(res.results.map((r) => r.status)).toEqual(['ok', 'ok']);
    expect(confirm).not.toHaveBeenCalled();
    expect(res.results.every((r) => r.approval === undefined)).toBe(true);
  });

  it('mcp: confirm: true is ignored — refused without an approval, nothing sent', async () => {
    const { ctx } = context({ trust: 'mcp' });
    const res = await runHooks([DELETE_CONFIRMED], ctx, { phase: 'teardown', journal: await journal() });
    expect(res.results[0]).toMatchObject({ status: 'refused' });
    expect(res.results[0].error).toContain('without a human approval: through MCP, "confirm: true" does not count');
    expect(api.requests).toEqual([]);
  });

  it('from the Studio (via studio, L4.2): the same refusals, worded for a Studio user — never MCP', async () => {
    const refused = await runHooks([DELETE_CONFIRMED], context({ trust: 'mcp', via: 'studio' }).ctx, { phase: 'teardown', journal: await journal() });
    expect(refused.results[0]).toMatchObject({ status: 'refused' });
    expect(refused.results[0].error).toContain('without a human approval: from the Studio, "confirm: true" does not count and the Studio cannot approve hooks yet — run it in a terminal');
    const ro = await runHooks([SHELL_READS], context({ trust: 'mcp', via: 'studio', access: READ_ONLY }).ctx, { phase: 'teardown', journal: await journal() });
    expect(ro.results[0].status).toBe('refused');
    expect(ro.results[0].error).toContain('from the Studio a shell hook always counts as writing');
    for (const r of [...refused.results, ...ro.results]) expect(r.error).not.toMatch(/MCP/);
    expect(writingHooks({ teardown: [SHELL_READS] }, { trust: 'mcp', via: 'studio' })[0].reason).toBe('a shell command (from the Studio a shell hook always counts as writing: its `writes: false` is not trusted)');
    expect(api.requests).toEqual([]);
  });

  it('mcp: the approver is asked with the raw hook and its fingerprint; it runs only when approved', async () => {
    const asked: HookApprovalRequest[] = [];
    const approve = (ok: boolean) => (_d: string, _r: string, req: HookApprovalRequest) => (asked.push(req), ok);
    const declined = await runHooks([SHELL_READS], context({ trust: 'mcp', confirmDestructive: approve(false) }).ctx, { phase: 'teardown', journal: await journal() });
    expect(declined.results[0].status).toBe('refused');
    const fp = hookFingerprint(SHELL_READS, { phase: 'teardown', index: 0, env: 'local' });
    expect(asked[0]).toMatchObject({ phase: 'teardown', index: 0, env: 'local', fingerprint: fp, hook: SHELL_READS });
    const ran = await runHooks([SHELL_READS], context({ trust: 'mcp', confirmDestructive: approve(true) }).ctx, { phase: 'teardown', journal: await journal() });
    expect(ran.results[0]).toMatchObject({ status: 'ok', approval: { reason: 'a shell command (runs local code)', fingerprint: fp } });
  });

  it('mcp: a shell hook always writes — `writes: false` on a read-only environment is refused before anyone is asked', async () => {
    const confirm = vi.fn(() => true);
    const curl: HookStep = { name: 'post', shell: { run: `curl -s -X POST ${api.base}/api/replies` }, writes: false };
    const res = await runHooks([curl], context({ trust: 'mcp', access: READ_ONLY, confirmDestructive: confirm }).ctx, { phase: 'teardown', journal: await journal() });
    expect(res.results[0].status).toBe('refused');
    expect(res.results[0].error).toContain('through MCP a shell hook always counts as writing');
    expect(confirm).not.toHaveBeenCalled();
    expect(api.requests).toEqual([]);
    // The same hook from a terminal (author): `writes: false` is trusted, it is not refused as a write.
    const author = await runHooks([SHELL_READS], context({ access: READ_ONLY }).ctx, { phase: 'teardown', journal: await journal() });
    expect(author.results[0].status).toBe('ok');
  });

  it('mcp dry run: nobody is asked; each hook that needs approval says so, with its fingerprint', async () => {
    const confirm = vi.fn(() => true);
    const get: HookStep = { name: 'list', http: { url: '{{console}}/api/replies' } };
    const res = await runHooks([get, DELETE_CONFIRMED, SHELL_READS], context({ trust: 'mcp', dryRun: true, confirmDestructive: confirm }).ctx, { phase: 'setup', journal: await journal() });
    expect(confirm).not.toHaveBeenCalled();
    expect(res.results.map((r) => [r.status, r.approval?.reason])).toEqual([
      ['dry', undefined],
      ['dry', 'HTTP DELETE'],
      ['dry', 'a shell command (runs local code)'],
    ]);
    expect(res.results[1].approval?.fingerprint).toBe(hookFingerprint(DELETE_CONFIRMED, { phase: 'setup', index: 1, env: 'local' }));
    expect(res.results[1].message).toBe('not executed (dry run); needs a human approval: HTTP DELETE');
    expect(api.requests).toEqual([]);
  });

  it('seed (a sandbox): with trust mcp only a shell step asks — a destructive http one does not; trust author never asks', async () => {
    const asked: HookApprovalRequest[] = [];
    const del: HookStep = { name: 'wipe', http: { method: 'DELETE', url: '{{console}}/api/replies/1', expect: [200, 204, 404] } };
    const approve = (_d: string, _r: string, req: HookApprovalRequest) => (asked.push(req), false);
    const mcp = await runHooks([del, SHELL_READS], context({ trust: 'mcp', confirmDestructive: approve }).ctx, { phase: 'seed', journal: await journal() });
    expect(mcp.results.map((r) => r.status)).toEqual(['ok', 'refused']);
    expect(asked).toEqual([expect.objectContaining({ phase: 'seed', index: 1, hook: SHELL_READS })]);
    expect(mcp.results[1].error).toContain('without a human approval');
    asked.length = 0;
    const author = await runHooks([del, SHELL_READS], context({ confirmDestructive: approve }).ctx, { phase: 'seed', journal: await journal() });
    expect(author.results.map((r) => r.status)).toEqual(['ok', 'ok']);
    expect(asked).toEqual([]);
  });

  it('the runner\'s static check of a read-only run counts a `writes: false` shell hook as writing with trust mcp', () => {
    expect(writingHooks({ setup: [SHELL_READS] })).toEqual([]);
    expect(writingHooks({ setup: [SHELL_READS] }, { trust: 'mcp' })).toEqual([
      { phase: 'setup', index: 0, name: 'echo', reason: 'a shell command (through MCP a shell hook always counts as writing: its `writes: false` is not trusted)' },
    ]);
  });

  it('a fingerprint is the raw hook with its place: key order does not matter; any change does', () => {
    const place = { phase: 'setup' as const, index: 1, env: 'local' };
    const a: HookStep = { name: 'x', http: { method: 'DELETE', url: '{{console}}/a' }, confirm: true };
    const b = { confirm: true, http: { url: '{{console}}/a', method: 'DELETE' }, name: 'x' } as HookStep;
    expect(hookFingerprint(a, place)).toBe(hookFingerprint(b, place));
    expect(hookFingerprint(a, place)).toMatch(/^[0-9a-f]{64}$/);
    for (const other of [
      hookFingerprint({ ...a, http: { method: 'DELETE', url: '{{console}}/b' } }, place),
      hookFingerprint(a, { ...place, index: 0 }),
      hookFingerprint(a, { ...place, phase: 'teardown' }),
      hookFingerprint(a, { ...place, env: 'production' }),
    ]) {
      expect(other).not.toBe(hookFingerprint(a, place));
    }
  });
});

describe('trust mcp: rollbacks and referenced files', () => {
  const ARMED: HookStep = { name: 'arm', http: { method: 'POST', url: '{{console}}/api/replies', json: { text: 'x' }, rollback: { method: 'DELETE', url: '{{console}}/api/replies/{{response.json.id}}' } } };
  const UNDO_POST: HookStep = { name: 'undo-post', http: { method: 'POST', url: '{{console}}/api/replies', json: { text: 'y' }, rollback: { method: 'POST', url: '{{console}}/api/replies' } } };
  const PLAIN: HookStep = { name: 'plain', http: { method: 'POST', url: '{{console}}/api/replies', json: { text: 'z' } } };
  const JS_UNDO: HookStep = { name: 'js-undo', js: { code: 'return 1', rollback: 'localStorage.clear()' } };

  it('a setup hook whose rollback is destructive, a shell command or JavaScript needs a human — the approval names the rollback; the CLI is unchanged', async () => {
    const shellRollback: HookStep = { name: 'seed', shell: { run: 'echo seeded', rollback: 'rm -rf "$HOME/important"' }, writes: false };
    const dry = await runHooks([ARMED, UNDO_POST, PLAIN, shellRollback, JS_UNDO], context({ trust: 'mcp', dryRun: true }).ctx, { phase: 'setup', journal: await journal() });
    expect(dry.results.map((r) => r.approval?.reason ?? null)).toEqual([
      'its rollback: HTTP DELETE',
      null,
      null,
      'a shell command (runs local code); its rollback: a shell command (runs local code)',
      'its rollback: JavaScript run in the page',
    ]);
    expect(dry.results[0].rollback).toBe(`http DELETE ${api.base}/api/replies/<response.json.id>`);
    expect(dry.results[3].rollback).toBe('shell "rm -rf "$HOME/important""');
    expect(dry.results[1].rollback).toBe(`http POST ${api.base}/api/replies`);
    // A real run without an approval: refused before its request is sent.
    const real = await runHooks([ARMED], context({ trust: 'mcp' }).ctx, { phase: 'setup', journal: await journal() });
    expect(real.results[0]).toMatchObject({ status: 'refused' });
    expect(api.requests).toEqual([]);
    // Trust author (the CLI): a rollback asks nobody, as before.
    const confirm = vi.fn(() => false);
    const author = await runHooks([ARMED], context({ confirmDestructive: confirm }).ctx, { phase: 'setup', journal: await journal() });
    expect(author.results[0]).toMatchObject({ status: 'ok' });
    expect(author.results[0].rollback).toBeUndefined();
    expect(confirm).not.toHaveBeenCalled();
  });

  it('referenced files: outside the project, through a symbolic link, or code in an agent-writable file are refused; a secret in a code file too', async () => {
    const outside = await tempProject('retake-outside-');
    try {
      await writeFile(join(outside.dir, 'secret.js'), 'return document.title');
      await mkdir(join(tmp.dir, 'assets'), { recursive: true });
      await mkdir(join(tmp.dir, 'scenarios'), { recursive: true });
      await symlink(join(outside.dir, 'secret.js'), join(tmp.dir, 'assets', 'link.js'));
      await writeFile(join(tmp.dir, 'scenarios', 'x.js'), 'return 1');
      await writeFile(join(tmp.dir, 'assets', 'token.js'), "return '{{env:HOME}}'");
      await writeFile(join(tmp.dir, 'assets', 'ok.js'), 'return 2');
      await writeFile(join(tmp.dir, 'scenarios', 'run.sh'), 'echo agent');
      const hooks: HookStep[] = [
        { js: { file: join(outside.dir, 'secret.js') } },
        { js: { file: '../' + outside.dir.split('/').pop() + '/secret.js' } },
        { js: { file: 'assets/link.js' } },
        { js: { file: 'scenarios/x.js' } },
        { js: { file: 'assets/token.js' } },
        { sql: { file: '../outside.sql' } },
        { shell: { run: 'sh scenarios/run.sh' }, writes: false },
        { js: { file: 'assets/ok.js' } },
      ];
      const res = await runHooks(hooks, context({ trust: 'mcp', dryRun: true }).ctx, { phase: 'teardown', journal: await journal() });
      expect(res.results.map((r) => r.status)).toEqual(['refused', 'refused', 'refused', 'refused', 'refused', 'refused', 'refused', 'dry']);
      expect(res.results[0].error).toContain('is an absolute path');
      expect(res.results[1].error).toContain('resolves outside the project folder');
      expect(res.results[2].error).toContain('resolves outside the project folder');
      expect(res.results[3].error).toContain('a file an agent can write through MCP (scenarios/x.js)');
      expect(res.results[4].error).toContain('{{env:HOME}}');
      expect(res.results[6].error).toContain('a file an agent can write through MCP (scenarios/run.sh)');
      // The CLI (trust author) reads them as before.
      const author = await runHooks([hooks[3], hooks[4]], context({ dryRun: true }).ctx, { phase: 'teardown', journal: await journal() });
      expect(author.results.map((r) => r.status)).toEqual(['dry', 'dry']);
    } finally {
      await outside.cleanup();
    }
  });

  it('the files a hook references are bound to its approval: a script changed after the approval is refused', async () => {
    await mkdir(join(tmp.dir, 'scripts'), { recursive: true });
    await writeFile(join(tmp.dir, 'scripts', 'seed.sh'), 'echo one');
    const hook: HookStep = { name: 'seed', shell: { run: 'sh ./scripts/seed.sh' }, writes: false };
    const place = { phase: 'teardown' as const, index: 0, env: 'local' };
    const { files, problems } = hookFiles(hook, { projectDir: tmp.dir });
    expect(problems).toEqual([]);
    expect(Object.keys(files)).toEqual(['./scripts/seed.sh']);
    const approved = new Set([hookFingerprint(hook, { ...place, files })]);
    // The fingerprint without the file differs: the bytes are part of what was approved.
    expect(approved.has(hookFingerprint(hook, place))).toBe(false);
    const confirmDestructive = (_d: string, _r: string, req: HookApprovalRequest) => approved.has(req.fingerprint);
    const ran = await runHooks([hook], context({ trust: 'mcp', confirmDestructive }).ctx, { phase: 'teardown', journal: await journal() });
    expect(ran.results[0].status).toBe('ok');
    await writeFile(join(tmp.dir, 'scripts', 'seed.sh'), 'echo two');
    const changed = await runHooks([hook], context({ trust: 'mcp', confirmDestructive }).ctx, { phase: 'teardown', journal: await journal() });
    expect(changed.results[0]).toMatchObject({ status: 'refused' });
  });

  it('a hook written by the agent may not set a loader variable — in its env or as a NAME= word of any simple command, its rollback too; nothing runs', async () => {
    const confirm = vi.fn(() => true);
    const marker = join(tmp.dir, 'ran');
    const hooks: HookStep[] = [
      { name: 'env', shell: { run: `touch ${marker}`, env: { NODE_OPTIONS: '--require ./x.cjs' } } },
      { name: 'later', shell: { run: `echo ok; touch ${marker} && LD_PRELOAD=/tmp/x.so ls` } },
      { name: 'quoted', shell: { run: `touch ${marker}; env "PATH=/tmp/bin" ls` } },
      { name: 'nested', shell: { run: `echo "$(GIT_DIR=/tmp/g git status)"; touch ${marker}` } },
      { name: 'undo', shell: { run: `touch ${marker}`, rollback: 'export HOME=/tmp/h; rm -f x' } },
    ];
    const res = await runHooks(hooks, context({ trust: 'mcp', confirmDestructive: confirm }).ctx, { phase: 'setup', journal: await journal(), agentWritten: true });
    expect(res.results.map((r) => r.status)).toEqual(['refused']);
    expect(res.results[0].error).toBe(
      "refusing shell hook: it sets NODE_OPTIONS — a loader variable (it changes what a program loads or the shell it starts), which a hook written through MCP may not set: remove it from the hook, or have a person declare the hook in project.yaml (`hooks:`, without the scenario's vars) or run it in a terminal",
    );
    for (const [i, hook] of hooks.entries()) {
      const one = await runHooks([hook], context({ trust: 'mcp', via: i === 2 ? 'studio' : 'mcp', confirmDestructive: confirm }).ctx, { phase: 'setup', journal: await journal(), agentWritten: true });
      expect(one.results[0].status, hook.name).toBe('refused');
      expect(one.results[0].error, hook.name).toContain(['NODE_OPTIONS', 'LD_PRELOAD', 'PATH', 'GIT_DIR', 'HOME'][i]);
    }
    expect((await runHooks([hooks[4]], context({ trust: 'mcp', confirmDestructive: confirm }).ctx, { phase: 'setup', journal: await journal(), agentWritten: true })).results[0].error).toContain('its rollback sets HOME');
    expect((await runHooks([hooks[2]], context({ trust: 'mcp', via: 'studio', confirmDestructive: confirm }).ctx, { phase: 'setup', journal: await journal(), agentWritten: true })).results[0].error).toContain('written from the Studio may not set');
    // A dry run (the submit's preflight) refuses it the same way, before anyone is asked.
    const dry = await runHooks([hooks[1]], context({ trust: 'mcp', dryRun: true }).ctx, { phase: 'setup', journal: await journal(), agentWritten: true });
    expect(dry.results[0].status).toBe('refused');
    expect(confirm).not.toHaveBeenCalled();
    expect(existsSync(marker)).toBe(false);
  });

  it("a person's hook (not agent-written) that sets one is only shown in full; the CLI's trust is unchanged", async () => {
    const confirm = vi.fn(() => true);
    const hook: HookStep = { name: 'tooling', shell: { run: 'PATH=/usr/bin:/bin echo "$PATH"', env: { NODE_OPTIONS: '--max-old-space-size=512' } } };
    const mcp = await runHooks([hook], context({ trust: 'mcp', confirmDestructive: confirm }).ctx, { phase: 'teardown', journal: await journal() });
    expect(mcp.results[0].status).toBe('ok');
    expect(mcp.results[0].shown).toEqual(['run: PATH=/usr/bin:/bin echo "$PATH"', 'env NODE_OPTIONS: --max-old-space-size=512']);
    expect(confirm).toHaveBeenCalledTimes(1);
    const author = await runHooks([hook], context().ctx, { phase: 'teardown', journal: await journal(), agentWritten: true });
    expect(author.results[0].status).toBe('ok');
    expect(author.results[0].shown).toBeUndefined();
  });

  it("a project hook rendered with the agent's variables counts as the agent's (HookContext.agentVars); one using a person's variable does not", async () => {
    const confirm = vi.fn(() => true);
    const hook: HookStep = { name: 'warm', shell: { run: '{{vars.prefix}} echo warm' } };
    const agent = await runHooks([hook], context({ trust: 'mcp', vars: { prefix: 'PATH=/tmp/bin' }, agentVars: ['prefix'], confirmDestructive: confirm }).ctx, { phase: 'step', journal: await journal() });
    expect(agent.results[0].status).toBe('refused');
    expect(agent.results[0].error).toContain('it sets PATH');
    // A bare {{prefix}} is the same variable.
    const bare = await runHooks([{ name: 'warm', shell: { run: '{{prefix}} echo warm' } }], context({ trust: 'mcp', vars: { prefix: 'PATH=/tmp/bin' }, agentVars: ['prefix'], confirmDestructive: confirm }).ctx, { phase: 'step', journal: await journal() });
    expect(bare.results[0].status).toBe('refused');
    const person = await runHooks([hook], context({ trust: 'mcp', vars: { prefix: 'PATH=/usr/bin:/bin', sku: 'x' }, agentVars: ['sku'], confirmDestructive: confirm }).ctx, { phase: 'step', journal: await journal() });
    expect(person.results[0].status).toBe('ok');
  });

  it('a result shows what ran in full, through MCP: every field, its rollback, secrets as ***, hidden characters written out', async () => {
    await mkdir(join(tmp.dir, 'scripts'), { recursive: true });
    const saved = process.env.RETAKE_TEST_SHOWN_TOKEN;
    process.env.RETAKE_TEST_SHOWN_TOKEN = 'tok-1234567';
    try {
      const long = `echo ${'y'.repeat(300)}`;
      const hook: HookStep = { name: 'seed', shell: { run: `${long}\u202e\necho two`, cwd: 'scripts', env: { TOKEN: '{{env:RETAKE_TEST_SHOWN_TOKEN}}' }, rollback: 'echo undo' } };
      const res = await runHooks([hook], context({ trust: 'mcp', confirmDestructive: () => true }).ctx, { phase: 'setup', journal: await journal() });
      expect(res.results[0].status).toBe('ok');
      expect(res.results[0].shown).toEqual([`run: ${long}\\u{202e}`, '  | echo two', 'cwd: scripts', 'env TOKEN: ***', 'rollback run: echo undo', 'rollback cwd: scripts', 'rollback env TOKEN: ***']);
    } finally {
      if (saved === undefined) delete process.env.RETAKE_TEST_SHOWN_TOKEN;
      else process.env.RETAKE_TEST_SHOWN_TOKEN = saved;
    }
  });

  it('a hook written by the agent may not use what core agentShellProblems lists — refused before anyone is asked, its rollback and working folder too; nothing runs', async () => {
    const confirm = vi.fn(() => true);
    const marker = join(tmp.dir, 'ran');
    await mkdir(join(tmp.dir, 'scenarios'), { recursive: true });
    await writeFile(join(tmp.dir, 'scenarios', 'run.sh'), `touch ${marker}`);
    const hooks: HookStep[] = [
      { name: 'expand', shell: { run: `touch ${marker}; echo "$(id)"` } },
      { name: 'inline', shell: { run: `node -e "require('fs').writeFileSync('${marker}', '')"` } },
      { name: 'pipe', shell: { run: `printf 'touch ${marker}' | sh` } },
      { name: 'run-dir', shell: { run: 'sh {{run.dir}}/x.sh' } },
      { name: 'missing', shell: { run: 'sh scenarios/not-yet.sh' } },
      { name: 'written', shell: { run: 'sh scenarios/run.sh' } },
      { name: 'cwd', shell: { run: 'sh run.sh', cwd: 'scenarios' } },
      { name: 'undo', shell: { run: `touch ${marker}`, rollback: 'cd scenarios && sh run.sh' } },
    ];
    const ctx = () => context({ trust: 'mcp', runId: 'r1', runDir: join(tmp.dir, 'runs', 'r1'), confirmDestructive: confirm }).ctx;
    const res = await runHooks(hooks, ctx(), { phase: 'setup', journal: await journal(), agentWritten: true });
    expect(res.results.map((r) => r.status)).toEqual(['refused']);
    expect(res.results[0].error).toBe(
      "refusing shell hook: it uses `$` outside single quotes (an expansion: `$NAME`, `${…}`, `$(…)`, `$((…))`) — write the value itself, in single quotes — a hook written through MCP may not: have a person put it in hooks/<name>.yaml (`retake hooks run <project> hooks/<name>.yaml`) or project.yaml's `hooks:` (without the scenario's vars), or run it in a terminal",
    );
    const expected = ['`$` outside', '`node -e`', '`| sh`', '(a path through runs/, which an agent can write)', '`scenarios/not-yet.sh` (a path through scenarios/', '`scenarios/run.sh` (a path through scenarios/', 'its working folder `scenarios`', 'its rollback uses `cd`'];
    for (const [i, hook] of hooks.entries()) {
      const one = await runHooks([hook], ctx(), { phase: 'setup', journal: await journal(), agentWritten: true });
      expect(one.results[0].status, hook.name).toBe('refused');
      expect(one.results[0].error, hook.name).toContain(expected[i]);
      // The submit's preflight (a dry run) refuses it the same way — {{run.dir}} has no value before the run: it fails there.
      const dry = await runHooks([hook], context({ trust: 'mcp', dryRun: true }).ctx, { phase: 'setup', journal: await journal(), agentWritten: true });
      expect(dry.results[0].status, `${hook.name} (dry)`).toBe(hook.name === 'run-dir' ? 'failed' : 'refused');
    }
    // From the Studio, worded for it.
    const studio = await runHooks([hooks[0]], context({ trust: 'mcp', via: 'studio', confirmDestructive: confirm }).ctx, { phase: 'setup', journal: await journal(), agentWritten: true });
    expect(studio.results[0].error).toContain('a hook written from the Studio may not');
    expect(confirm).not.toHaveBeenCalled();
    expect(existsSync(marker)).toBe(false);
  });

  it("the same hook in a person's file (hooks/<name>.yaml) is shown and asked about, then runs; the CLI is unchanged", async () => {
    const confirm = vi.fn(() => true);
    const marker = join(tmp.dir, 'ran');
    const hook: HookStep = { name: 'expand', shell: { run: `X=1; touch "${marker}$X"; node -e "1"` } };
    const person = await runHooks([hook], context({ trust: 'mcp', confirmDestructive: confirm }).ctx, { phase: 'setup', journal: await journal() });
    expect(person.results[0].status).toBe('ok');
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(existsSync(`${marker}1`)).toBe(true);
    const author = await runHooks([hook], context().ctx, { phase: 'teardown', journal: await journal(), agentWritten: true });
    expect(author.results[0].status).toBe('ok');
  });

  it("an agent-written hook's file words are judged by the agent rules, a person's by the file binding as before; ordinary commands and saved responses pass", async () => {
    await mkdir(join(tmp.dir, 'scenarios'), { recursive: true });
    await mkdir(join(tmp.dir, 'scripts'), { recursive: true });
    await writeFile(join(tmp.dir, 'scenarios', 'run.sh'), 'echo agent');
    await writeFile(join(tmp.dir, 'scripts', 'seed.sh'), 'echo person');
    const written: HookStep = { shell: { run: 'sh scenarios/run.sh' }, writes: false };
    const agent = await runHooks([written], context({ trust: 'mcp', dryRun: true }).ctx, { phase: 'teardown', journal: await journal(), agentWritten: true });
    expect(agent.results[0].error).toContain('refusing shell hook: it uses `scenarios/run.sh` (a path through scenarios/, which an agent can write)');
    expect(hookFiles(written, { projectDir: tmp.dir, agentWritten: true })).toEqual({ files: {}, problems: [] });
    const person = await runHooks([written], context({ trust: 'mcp', dryRun: true }).ctx, { phase: 'teardown', journal: await journal() });
    expect(person.results[0].error).toContain('a file an agent can write through MCP (scenarios/run.sh)');
    // A person's script named by an agent-written hook is still bound to its approval.
    expect(Object.keys(hookFiles({ shell: { run: 'sh ./scripts/seed.sh' } }, { projectDir: tmp.dir, agentWritten: true }).files)).toEqual(['./scripts/seed.sh']);
    const confirm = vi.fn(() => true);
    const ordinary: HookStep[] = [
      { name: 'post', http: { method: 'POST', url: `${api.base}/api/replies`, json: { text: 'x' }, expect: 201, save_as: 'reply' } },
      { name: 'seed', shell: { run: 'sh ./scripts/seed.sh && echo id {{hooks.reply.json.id}} && sleep 0.1', cwd: '.' } },
    ];
    const dry = await runHooks(ordinary, context({ trust: 'mcp', dryRun: true }).ctx, { phase: 'setup', journal: await journal(), agentWritten: true });
    expect(dry.results.map((r) => r.status)).toEqual(['dry', 'dry']);
    const ran = await runHooks(ordinary, context({ trust: 'mcp', confirmDestructive: confirm }).ctx, { phase: 'setup', journal: await journal(), agentWritten: true });
    expect(ran.results.map((r) => r.status)).toEqual(['ok', 'ok']);
  });
});
