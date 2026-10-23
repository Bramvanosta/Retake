/**
 * L3.1 review (trust `mcp`, core agent-trust): what work submitted through MCP may reference — no secret in a scenario,
 * no file outside the project folder (absolute, `..`, a symbolic link out of it), no code from a file an agent can
 * write — and the rollbacks that need a human.
 */
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { agentTrustProblems, agentWritable, insideFolder, isTemplatePath, projectFileProblem, renderFileProblems, rollbackApprovalReason, scenarioFileRefs, templateRefProblem } from '../src/index.js';
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
    // The refusal never names where the link leads.
    expect(projectFileProblem(project, 'assets/link.txt')).not.toContain(root);
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

  it('L4.2: the same refusals worded for the Studio (via studio) never say MCP; the default stays the MCP wording', () => {
    const sc = scenario({
      template: '../themes/x',
      vars: { k: '{{env:TOKEN}}' },
      scenes: [{ id: 'a', page: 'console', steps: [{ drop_file: { zone: { css: 'body' }, path: '../outside.txt' } }, { eval: { file: 'scenarios/x.js' } }, { eval: { file: '/etc/hosts' } }] }] as Scenario['scenes'],
    });
    const studio = agentTrustProblems({ dir: project, config: {} }, sc, { via: 'studio' });
    const mcp = agentTrustProblems({ dir: project, config: {} }, sc);
    expect(studio).toHaveLength(5);
    expect(mcp).toHaveLength(5);
    for (const p of studio) {
      expect(p).not.toMatch(/MCP|template_list/);
      expect(p).toContain('from the Studio');
    }
    for (const p of mcp) expect(p).toContain('through MCP');
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

describe('render trust rules (L3.2)', () => {
  it('a theme is named; a folder only when it is project.yaml\'s own template', () => {
    for (const ref of ['./template', '../x', '/abs/t', 'a/b', '~/t', '.hidden']) expect(isTemplatePath(ref), ref).toBe(true);
    for (const ref of ['editorial', 'Motion_2']) expect(isTemplatePath(ref), ref).toBe(false);
    expect(templateRefProblem('editorial', undefined, 'the theme')).toBeNull();
    expect(templateRefProblem('./template', './template', 'the theme')).toBeNull();
    expect(templateRefProblem('../../x', './template', "the scenario's template")).toMatch(/^the scenario's template is a folder \(\.\.\/\.\.\/x\): through MCP a theme is named/);
    expect(templateRefProblem(undefined, undefined, 'x')).toBeNull();
  });

  it('a scenario naming a theme folder is refused through MCP (validate, save, run) when the project config is known', () => {
    const sc = { video: 'x', template: '../../elsewhere', scenes: [{ id: 'a', page: 'console', steps: [] }] } as unknown as Scenario;
    expect(agentTrustProblems({ dir: project, config: { template: 'editorial' } }, sc)).toEqual([expect.stringContaining("the scenario's template is a folder")]);
    expect(agentTrustProblems({ dir: project, config: { template: '../../elsewhere' } }, sc)).toEqual([]);
  });

  it('files a render reads: project files; a Lottie file (.json) is code, never agent-writable', () => {
    expect(renderFileProblems(project, [{ ref: 'assets/data.csv', where: 'scene a, card slot data' }])).toEqual([]);
    expect(renderFileProblems(project, [{ ref: '../outside.txt', where: 'scene a, card slot data' }])).toEqual([expect.stringMatching(/^scene a, card slot data: \.\.\/outside\.txt resolves outside/)]);
    expect(renderFileProblems(project, [{ ref: 'scenarios/anim.json', where: 'video intro (lottie file)' }])[0]).toContain('a Lottie file is code');
    expect(renderFileProblems(project, [{ ref: 'scenarios/shot.png', where: 'video intro (image file)' }])).toEqual([]);
    expect(renderFileProblems(project, [{ ref: 'assets/anim.json', where: 'video intro (lottie file)' }])).toEqual([]);
  });

  it('agent-writable folders are matched without case (a case-insensitive file system: RUNS/ is runs/)', async () => {
    await mkdir(join(project, 'runs', 'r1', 'artefacts'), { recursive: true });
    await writeFile(join(project, 'runs', 'r1', 'artefacts', 'anim.json'), '{}');
    await mkdir(join(project, 'hooks'), { recursive: true });
    await writeFile(join(project, 'hooks', 'reset.sql'), 'select 1');
    for (const ref of ['RUNS/r1/artefacts/anim.json', 'Runs/r1/artefacts/anim.json', './runs/../Runs/r1/artefacts/anim.json', 'Scenarios/x.json', '.Demo-Studio/a.json']) {
      expect(agentWritable(ref.replace(/^\.\/runs\/\.\.\//, '')), ref).toBe(true);
      expect(renderFileProblems(project, [{ ref, where: 'video intro (lottie file)' }])[0], ref).toContain('a Lottie file is code');
      expect(projectFileProblem(project, ref, { code: true }), ref).toContain('a file an agent can write through MCP');
    }
    expect(projectFileProblem(project, 'ReadMe.MD', { code: true })).toContain('a file an agent can write through MCP');
    expect(projectFileProblem(project, 'HOOKS/reset.sql', { code: true })).toBeNull();
  });

  it('insideFolder follows symbolic links on both sides', () => {
    expect(insideFolder(project, join(project, 'assets', 'data.csv'))).toBe(true);
    expect(insideFolder(project, join(project, 'assets', 'link.txt'))).toBe(false);
    expect(insideFolder(project, join(project, 'assets', 'up', 'outside.txt'))).toBe(false);
    // Back in through the link: still the project.
    expect(insideFolder(project, join(project, 'assets', 'up', 'p', 'assets'))).toBe(true);
    expect(insideFolder(project, project)).toBe(true);
    // On a case-insensitive file system (macOS by default), the case on disk is what counts.
    if (existsSync(join(root, 'P'))) {
      expect(insideFolder(project, join(root, 'P', 'Assets', 'data.csv'))).toBe(true);
      expect(projectFileProblem(join(root, 'P'), 'assets/data.csv')).toBeNull();
    }
  });
});
