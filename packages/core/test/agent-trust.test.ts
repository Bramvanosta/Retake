/**
 * L3.1 review (trust `mcp`, core agent-trust): what work submitted through MCP may reference — no secret in a scenario,
 * no file outside the project folder (absolute, `..`, a symbolic link out of it), no code from a file an agent can
 * write — and the rollbacks that need a human.
 */
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { agentTrustProblems, agentWritable, projectFileProblem, rollbackApprovalReason, scenarioFileRefs } from '../src/index.js';
import type { HookStep, Scenario } from '../src/index.js';

let root: string;
let project: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'studio-agent-trust-'));
  project = join(root, 'p');
  await mkdir(join(project, 'assets'), { recursive: true });
  await writeFile(join(root, 'outside.txt'), 'top secret');
  await writeFile(join(project, 'assets', 'data.csv'), 'a,b');
  await symlink(join(root, 'outside.txt'), join(project, 'assets', 'link.txt'));
  await symlink(root, join(project, 'assets', 'up'));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('projectFileProblem', () => {
  it('a file of the project folder is fine; absolute, `..`, ~ and symbolic links out of it are refused', () => {
    expect(projectFileProblem(project, 'assets/data.csv')).toBeNull();
    expect(projectFileProblem(project, './assets/../assets/data.csv')).toBeNull();
    expect(projectFileProblem(project, 'assets/missing.csv')).toBeNull(); // reading it fails later, inside the project
    expect(projectFileProblem(project, join(root, 'outside.txt'))).toContain('is an absolute path');
    expect(projectFileProblem(project, '~/.ssh/id_rsa')).toContain('is an absolute path');
    expect(projectFileProblem(project, '../outside.txt')).toContain('resolves outside the project folder');
    expect(projectFileProblem(project, 'assets/link.txt')).toContain('resolves outside the project folder');
    expect(projectFileProblem(project, 'assets/up/outside.txt')).toContain('resolves outside the project folder');
    expect(projectFileProblem(project, 'assets/up/missing/x.js')).toContain('resolves outside the project folder');
  });

  it('code: never from a file an agent can write (README.md, scenarios/, runs/, renders/, review/, exports/, .demo-studio/)', () => {
    for (const ref of ['README.md', 'readme.md', 'scenarios/x.yaml', 'runs/r1/artefacts/doc.txt', '.demo-studio/journals/a.json', 'exports/a/b.js']) {
      expect(agentWritable(ref), ref).toBe(true);
      expect(projectFileProblem(project, ref, { code: true }), ref).toContain('a file an agent can write through MCP');
      expect(projectFileProblem(project, ref), ref).toBeNull();
    }
    expect(agentWritable('hooks/reset.sql')).toBe(false);
    expect(agentWritable('scenarios-old/x.js')).toBe(false);
    expect(projectFileProblem(project, 'hooks/reset.sql', { code: true })).toBeNull();
  });
});

describe('agentTrustProblems', () => {
  const scenario = (extra: Partial<Scenario>): Scenario =>
    ({ video: 'x', scenes: [{ id: 'a', page: 'console', steps: [{ click: { text: 'Go' } }] }], ...extra }) as Scenario;

  it('a scenario that names a secret anywhere (a step, a hook, its vars) is refused; `note` is never templated', () => {
    expect(agentTrustProblems({ dir: project }, scenario({}))).toEqual([]);
    const steps = scenario({ scenes: [{ id: 'a', page: 'console', steps: [{ eval: { js: "throw new Error(btoa('{{env:TOKEN}}'))" } }] }] as Scenario['scenes'] });
    expect(agentTrustProblems({ dir: project }, steps)).toEqual([expect.stringContaining('the scenario uses {{env:TOKEN}}: through MCP a scenario never resolves a secret')]);
    const hook = scenario({ setup: [{ http: { method: 'POST', url: '{{console}}/x', headers: { authorization: 'Bearer {{ keychain:svc/acct }}' } } }] });
    expect(agentTrustProblems({ dir: project }, hook)[0]).toContain('{{keychain:svc/acct}}');
    expect(agentTrustProblems({ dir: project }, scenario({ vars: { k: '{{secret:env:X}}' } }))[0]).toContain('{{env:X}}');
    expect(agentTrustProblems({ dir: project }, scenario({ scenes: [{ id: 'a', page: 'console', note: '{{env:X}}', steps: [] }] as unknown as Scenario['scenes'] }))).toEqual([]);
  });

  it('the files a scenario names: drop_file.path inside the project; eval.file and hook files also not agent-writable', () => {
    const sc = scenario({
      scenes: [
        {
          id: 'a',
          page: 'console',
          steps: [{ drop_file: { zone: { css: 'body' }, path: '../outside.txt' } }, { drop_file: { zone: { css: 'body' }, path: 'assets/data.csv' } }, { eval: { file: 'scenarios/x.js' } }],
        },
      ] as Scenario['scenes'],
      setup: [{ sql: 'hooks/reset.sql' }, { sql: { query: 'SELECT 1', rollback: { file: 'README.md' } } }, { js: { file: '/etc/hosts' } }] as HookStep[],
    });
    expect(scenarioFileRefs(sc).map((f) => f.ref)).toEqual(['../outside.txt', 'assets/data.csv', 'scenarios/x.js', 'hooks/reset.sql', 'README.md', '/etc/hosts']);
    const problems = agentTrustProblems({ dir: project }, sc);
    expect(problems).toHaveLength(4);
    expect(problems[0]).toMatch(/^step a\.0 \(drop_file\.path\): \.\.\/outside\.txt resolves outside the project folder/);
    expect(problems[1]).toMatch(/^step a\.2 \(eval\.file\): scenarios\/x\.js is a file an agent can write/);
    expect(problems[2]).toMatch(/^setup hook 2 \(sql rollback file\): README\.md is a file an agent can write/);
    expect(problems[3]).toMatch(/^setup hook 3 \(js file\): \/etc\/hosts is an absolute path/);
  });
});

describe('rollbackApprovalReason', () => {
  it('a destructive rollback, and every shell or js one, needs a human through MCP', () => {
    const http = (method: string): HookStep => ({ http: { method: 'POST', url: 'http://x/a', rollback: { method: method as 'DELETE', url: 'http://x/a/1' } } });
    expect(rollbackApprovalReason(http('DELETE'))).toBe('its rollback: HTTP DELETE');
    expect(rollbackApprovalReason(http('POST'))).toBeNull();
    expect(rollbackApprovalReason({ http: { method: 'POST', url: 'http://x' } })).toBeNull();
    expect(rollbackApprovalReason({ sql: { query: 'SELECT 1', rollback: 'DROP TABLE customers' } })).toBe('its rollback: SQL DROP');
    expect(rollbackApprovalReason({ sql: { query: 'SELECT 1', rollback: 'INSERT INTO t VALUES (1)' } })).toBeNull();
    expect(rollbackApprovalReason({ shell: { run: 'echo', rollback: 'echo undo' } })).toBe('its rollback: a shell command (runs local code)');
    expect(rollbackApprovalReason({ js: { code: 'return 1', rollback: 'localStorage.clear()' } })).toBe('its rollback: JavaScript run in the page');
  });
});
