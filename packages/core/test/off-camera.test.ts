/**
 * L5.8 — the scenario language side of off-camera work (R-FLD-31) and of the environment (R-FLD-30): `hook: <name>`
 * steps and named hooks (`hooks:` of a scenario or project.yaml), a scene's `offscreen`; their validation, agent trust,
 * read-only refusals, the L5.5 filmed part and edit re-plan, the L4.3 Studio blocks and protected sections; and the
 * sandbox advice `retake doctor` and `project_get` give.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  agentTrustProblems,
  changedHookSections,
  filmedChanges,
  hookApprovalReason,
  hookStepNames,
  parseProjectYaml,
  parseScenario,
  replanEdit,
  resolveNamedHook,
  sandboxAdvice,
  sandboxAdviceText,
  scenarioBlocks,
  stepHookList,
  usedNamedHooks,
  writingHooks,
} from '@retake/core';
import type { LoadedProject, Scenario, Timeline, ValidationIssue } from '@retake/core';
import { errors, warnings } from './helpers.js';
import { fileFacts, nodeFileFacts } from '@retake/core/io';
import { PERSON_POLICY } from '@retake/core';

const errs = (issues: ValidationIssue[]) => errors(issues).map((i) => `${i.path.join('.')}: ${i.message}`);
const warns = (issues: ValidationIssue[]) => warnings(issues).map((i) => `${i.path.join('.')}: ${i.message}`);

const PROJECT = ['name: Northfield', 'environments:', '  local: {console: "http://localhost:4401", shop: "http://localhost:4402"}', ''];

function project(extra: string[] = []): LoadedProject {
  const { config, issues } = parseProjectYaml([...PROJECT, ...extra, ''].join('\n'));
  if (!config) throw new Error(errs(issues).join('\n'));
  const dir = mkdtempSync(join(tmpdir(), 'ds-off-camera-'));
  return { slug: 'northfield', dir, root: dir, config, readme: null, scenarios: [], file: join(dir, 'project.yaml'), issues };
}

const SCENARIO = [
  'video: demo',
  'hooks:',
  '  request:',
  '    http: {method: POST, url: "{{console}}/api/quotes", json: {bags: 1}}',
  '  queue:',
  '    - name: push',
  '      http: {method: POST, url: "{{console}}/api/jobs"}',
  '    - writes: false',
  '      shell: "sleep 1"',
  'scenes:',
  '  - id: prepare',
  '    offscreen: true',
  '    page: console',
  '    open: /products',
  '    steps:',
  '      - click: Quote requests',
  '  - id: list',
  '    steps:',
  '      - hold: 1',
  '      - hook: request',
  '      - hook: {name: queue}',
  '      - wait_for: {text: New}',
  '',
].join('\n');

const parsed = (text: string, p?: LoadedProject): Scenario => {
  const r = parseScenario(text, p ? { project: p } : {});
  if (!r.scenario) throw new Error(errs(r.issues).join('\n'));
  return r.scenario;
};

describe('hook steps and named hooks (R-FLD-31)', () => {
  it('a hook step names a hook of the scenario, else of project.yaml; each entry runs under its own name, else the hook\'s', () => {
    const p = project(['hooks:', '  shared: {http: {method: POST, url: "{{console}}/api/reset"}}', '  request: {sql: "select 1"}']);
    const sc = parsed(SCENARIO.replace('      - hook: request', '      - hook: request\n      - hook: shared'), p);
    expect(hookStepNames(sc)).toEqual(['request', 'shared', 'queue']);
    // The scenario's `request` wins over project.yaml's.
    expect(resolveNamedHook('request', sc, p)).toMatchObject({ source: 'scenario', hooks: [{ name: 'request', http: { method: 'POST' } }] });
    expect(resolveNamedHook('shared', sc, p)).toMatchObject({ source: 'project', hooks: [{ name: 'shared' }] });
    expect(resolveNamedHook('queue', sc, p)!.hooks.map((h) => h.name)).toEqual(['push', 'queue']);
    expect(resolveNamedHook('nope', sc, p)).toBeUndefined();
    expect(usedNamedHooks(sc, p).map((h) => h.name)).toEqual(['request', 'shared', 'queue']);
    expect(stepHookList(sc, p)).toHaveLength(4);
    // A skipped scene's hook steps are not run.
    const skipped = parsed(SCENARIO.replace('  - id: list\n', '  - id: list\n    skip: true\n'));
    expect(hookStepNames(skipped)).toEqual([]);
  });

  it('validation: an unknown hook (with a suggestion), edit values on a hook step, a named hook no step runs, a destructive one without confirm', () => {
    const p = project();
    expect(errs(parseScenario(SCENARIO.replace('- hook: request', '- hook: requst'), { files: fileFacts(PERSON_POLICY), project: p }).issues)).toEqual([
      expect.stringMatching(/^scenes\.1\.steps\.1\.hook: unknown hook "requst" \(did you mean "request"\?\): declare it under `hooks:` in the scenario or in project\.yaml \(hooks: request, queue\)$/),
    ]);
    // Without a project, a name the scenario does not declare may be project.yaml's: not an error.
    expect(errs(parseScenario(SCENARIO.replace('hooks:\n  request:', 'hooks:\n  other:').replace('- hook: {name: queue}', '- hold: 1'), { files: fileFacts(PERSON_POLICY),}).issues)).toEqual(
      expect.arrayContaining([expect.stringMatching(/unknown hook "request"/)]),
    );
    const w = warns(parseScenario(SCENARIO.replace('      - hook: request', '      - hook: request\n        caption: Sent\n        mark: sent').replace('  queue:', '  unused: {http: {method: GET, url: "{{console}}/api/health"}}\n  queue:'), { files: fileFacts(PERSON_POLICY), project: p }).issues);
    expect(w).toEqual(
      expect.arrayContaining([
        'scenes.1.steps.1: a hook step runs off camera and the edit cuts it: its caption, mark are never shown — put them on the next step',
        'hooks.unused: hook "unused" is run by no `hook: unused` step',
      ]),
    );
    expect(errs(parseScenario(SCENARIO.replace('http: {method: POST, url: "{{console}}/api/quotes", json: {bags: 1}}', 'http: {method: DELETE, url: "{{console}}/api/quotes/1"}'), { files: fileFacts(PERSON_POLICY), project: p }).issues)).toEqual([
      expect.stringMatching(/^hooks\.request: destructive hook \(HTTP DELETE\) requires "confirm: true"$/),
    ]);
    // project.yaml's named hooks are checked like its reset hooks.
    expect(errs(parseProjectYaml([...PROJECT, 'hooks:', '  wipe: {http: {method: DELETE, url: "{{console}}/api/all"}}', ''].join('\n')).issues)).toEqual([expect.stringMatching(/^hooks\.wipe: destructive hook/)]);
    expect(errs(parseScenario(SCENARIO.replace('hook: request', 'hook: Not A Slug')).issues)).not.toEqual([]);
  });

  it('a read-only environment refuses the named hooks that write; through MCP a named hook\'s file and secrets are checked like setup hooks\'', () => {
    const sc = parsed(SCENARIO);
    // Its shell entry declares `writes: false`: counted only when that flag does not count (through MCP).
    expect(writingHooks({ step: stepHookList(sc) }).map((w) => `${w.phase} ${w.index} ${w.name}: ${w.reason}`)).toEqual(['step 0 request: HTTP POST', 'step 1 push: HTTP POST']);
    expect(writingHooks({ step: stepHookList(sc) }, { trust: 'mcp' }).map((w) => `${w.phase} ${w.index} ${w.name}`)).toEqual(['step 0 request', 'step 1 push', 'step 2 queue']);
    const p = project();
    const bad = parsed(SCENARIO.replace('    http: {method: POST, url: "{{console}}/api/quotes", json: {bags: 1}}', '    sql: {file: scenarios/x.sql, db: main}'));
    expect(agentTrustProblems(p, bad, { files: nodeFileFacts }).join('\n')).toMatch(/hook "request" \(sql file\): scenarios\/x\.sql is a file an agent can write through MCP/);
    const secret = parsed(SCENARIO.replace('{bags: 1}', '{token: "{{env:API_TOKEN}}"}'));
    expect(agentTrustProblems(p, secret, { files: nodeFileFacts }).join('\n')).toMatch(/the scenario uses \{\{env:API_TOKEN\}\}/);
    // A step hook's rollback is approved with it (it runs later, after the teardown), as a setup hook's.
    expect(hookApprovalReason({ http: { method: 'POST', url: 'http://localhost:4401/x', rollback: { method: 'DELETE', url: 'http://localhost:4401/x' } } }, 'step')).toMatch(/its rollback: HTTP DELETE/);
  });
});

describe('the filmed part and the edit (L5.5) with hook steps and offscreen scenes', () => {
  it('a hook step and a named hook are filmed; `offscreen` is edit', () => {
    expect(filmedChanges(SCENARIO.replace('      - hook: request\n', ''), SCENARIO)).toEqual([expect.stringMatching(/list/)]);
    expect(filmedChanges(SCENARIO.replace('json: {bags: 1}', 'json: {bags: 2}'), SCENARIO)).toEqual(['the named hooks (hooks)']);
    expect(filmedChanges(SCENARIO.replace('    offscreen: true\n', ''), SCENARIO)).toEqual([]);
  });

  it('replanEdit carries today\'s `offscreen` onto the take\'s timeline', () => {
    const then = parsed(SCENARIO);
    const now = parsed(SCENARIO.replace('    offscreen: true\n', '').replace('  - id: list\n', '  - id: list\n    offscreen: true\n'));
    const timeline = {
      version: 1,
      scenes: [
        { id: 'prepare', index: 0, kind: 'scene', t_start: 0, t_end: 2, offscreen: true, status: 'ok' },
        { id: 'list', index: 1, kind: 'scene', t_start: 2, t_end: 6, status: 'ok' },
      ],
      events: [],
      markers: [],
    } as unknown as Timeline;
    const r = replanEdit({ timeline, now, then, project: { frame: 'card', template: 'default' }, ctx: { pages: {}, vars: {} } as never });
    expect(r.timeline.scenes.map((s) => [s.id, s.offscreen ?? false])).toEqual([
      ['prepare', false],
      ['list', true],
    ]);
    expect(r.changes).toEqual(expect.arrayContaining(['offscreen of prepare', 'offscreen of list']));
  });
});

describe('the Studio (L4.3) with hook steps and named hooks', () => {
  it('blocks: a hook step has its badge and words, named hooks show by name, an offscreen scene says so', () => {
    const b = scenarioBlocks(SCENARIO);
    const list = b.entries.find((e) => e.type === 'scene' && e.id === 'list');
    expect(list?.type === 'scene' && list.steps.filter((s) => s.category === 'hook').map((s) => [s.target, s.summary])).toEqual([
      ['hook “request”', 'off camera: cut from the video'],
      ['hook “queue”', 'off camera: cut from the video'],
    ]);
    expect(b.hooks.named.map((h) => [h.hook, h.index, h.name, h.kind, h.needs_person ?? null])).toEqual([
      ['request', 0, 'request', 'http', null],
      ['queue', 0, 'push', 'http', null],
      ['queue', 1, 'queue', 'shell', 'a shell command (runs local code)'],
    ]);
    expect(b.hooks.named[0].range?.line).toBe(4);
    const prepare = b.entries.find((e) => e.type === 'scene' && e.id === 'prepare');
    expect(prepare?.type === 'scene' && prepare.offscreen).toBe(true);
  });

  it('a Studio save that changes the named hooks is refused like one that changes setup hooks; moving a hook step is not', () => {
    const a = parsed(SCENARIO) as unknown;
    expect(changedHookSections(a, parsed(SCENARIO.replace('json: {bags: 1}', 'json: {bags: 3}')))).toEqual(['hooks']);
    const moved = SCENARIO.replace('      - hold: 1\n      - hook: request\n', '      - hook: request\n      - hold: 1\n');
    expect(changedHookSections(a, parsed(moved))).toEqual([]);
  });
});

describe('sandbox advice (R-FLD-30)', () => {
  it('a local environment with a database, a mailbox or reset hooks and no sandbox gets it; production, remote pages or a sandbox do not', () => {
    const local = project(['databases: {main: {url: "postgres://demo@localhost:5432/app"}}', 'mailbox: {provider: mailpit, url: "http://localhost:8025"}']);
    const a = sandboxAdvice(local);
    expect(a).toEqual({ env: 'local', holds: ['database main', 'the mailbox'] });
    const t = sandboxAdviceText(a!, 'northfield');
    expect(t.detail).toBe('none — environment local films this machine with database main and the mailbox: each take starts from whatever the last one (or a hand-made reset) left');
    expect(t.hint).toMatch(/retake sandbox init northfield writes a sandbox\.yaml to fill in \(docs\/guide\/sandbox\.md\), then retake run northfield <scenario> --env sandbox --sandbox$/);
    expect(sandboxAdvice(project(['reset: [{http: {method: POST, url: "{{console}}/api/reset"}}]']))).toEqual({ env: 'local', holds: ['reset hooks'] });
    expect(sandboxAdvice(project())).toBeNull();
    const remote = parseProjectYaml(['name: R', 'environments:', '  staging: {app: "https://app.staging.example.com"}', 'mailbox: {provider: mailpit, url: "http://localhost:8025"}', ''].join('\n'));
    expect(sandboxAdvice({ config: remote.config! })).toBeNull();
    const withSandbox = { config: { ...local.config, sandboxes: { sandbox: 'sandbox/sandbox.yaml' } } };
    expect(sandboxAdvice(withSandbox)).toBeNull();
  });
});
