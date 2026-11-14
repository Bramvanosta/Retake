/**
 * L5.11a: what the Studio's status bar reads for the scenario in context (`engine.scenarios.actions`) and the gate kinds
 * of the run blockers.
 *
 * - critique H3: each blocker says which gate refused (`kind`) — agent trust, a protected host, a refused hook, a
 *   read-only location's writing hook, hooks to approve (with their `count`), an invalid file — so the Studio's short
 *   words never name a safety reason that is not the one (a planted swap of two kinds fails here).
 * - critique M4: a queued or running run carries its job (null: a terminal's run); with a terminal's run and a Studio job
 *   both unfinished, `running` is the one with the job (L5.11a fixes, review A-L4 / B-M5: Stop reaches it).
 * - critique H2: the actions layer has its own memo — it reads a fresh text layer of the scenario screen but never
 *   inserts into that 16-entry cache (the open scenario's view stays a hit however many scenarios the status bar reads),
 *   and two reads at once compute once (single flight), for the view's text layer too.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EngineError, RunDataCache, ScenarioViews, createEngine, openProjectBySlug, openWorkspace, diskWorkspaceReads } from '../src/index.js';
import type { Engine, RunBlocker } from '../src/index.js';
import { blockerKind } from '../src/jobs/run-job.js';
import { writeRun } from '@retake/test-support/runs';
import { scratchHome } from '@retake/test-support/home';

let ws: string;
let ui: Engine;
const retakeHome = scratchHome();

const project = (name: string, envs: string[]) => ['name: ' + name, 'environments:', ...envs, 'capture: {width: 1280, height: 720, scale: 1, fps: 30}', 'template: default', ''].join('\n');
const SHORT = 'video: short\nscenes:\n  - id: a\n    page: console\n    open: /\n    steps:\n      - hold: 0.2\n      - hold: 0.3\n';
const LEAK = SHORT.replace('video: short', 'video: leak').replace('      - hold: 0.2', '      - eval: {js: "throw new Error(btoa(\'{{env:HOME}}\'))"}');
const PLAIN_HOOK = SHORT.replace('video: short', 'video: plain').replace(
  'scenes:',
  'setup:\n  - http: {method: POST, url: "{{console}}/x", rollback: {method: DELETE, url: "{{console}}/x"}}\nscenes:',
);
const BROKEN = 'video: broken\nscenes:\n  - id: a\n    page: console\n    open: /\n    steps:\n      - clik: Save\n';

beforeAll(async () => {
  ws = await mkdtemp(join(tmpdir(), 'studio-scenario-actions-'));
  retakeHome.use(join(ws, '.home'));
  await writeFile(join(ws, 'retake.yaml'), 'projects_dir: projects\n');
  const files: Record<string, string> = {
    'prod/project.yaml': project('Prod', [
      '  production:',
      '    production: true',
      '    pages:',
      '      console: http://127.0.0.1:4999',
      '  frozen:',
      '    access: read-only',
      '    pages:',
      '      console: https://frozen.example.com',
    ]),
    'prod/scenarios/armed.yaml': PLAIN_HOOK.replace('video: plain', 'video: armed\nenv: frozen'),
    'twin/project.yaml': project('Twin', ['  staging:', '    console: http://localhost:4999']),
    'twin/scenarios/short.yaml': SHORT.replace('video: short', 'video: short\nenv: staging'),
    'w/project.yaml': project('W', ['  local:', '    console: http://127.0.0.1:4997']),
    'w/scenarios/short.yaml': SHORT,
    'w/scenarios/leak.yaml': LEAK,
    'w/scenarios/plain.yaml': PLAIN_HOOK,
    'w/scenarios/broken.yaml': BROKEN,
  };
  for (let i = 0; i < 20; i++) files[`w/scenarios/many-${i}.yaml`] = SHORT.replace('video: short', `video: many ${i}`);
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(join(ws, 'projects', rel, '..'), { recursive: true });
    await writeFile(join(ws, 'projects', rel), text);
  }
  ui = await createEngine({ root: ws, client: 'ui', autoStartWorker: false });
});

afterAll(async () => {
  retakeHome.restore();
  if (ws) await rm(ws, { recursive: true, force: true });
});

describe('blocker kinds (critique H3)', () => {
  it('⚑ blockerKind: each gate names its own kind; anything a gate did not word as its refusal is `prepare` (never a safety reason)', () => {
    const e = (code: ConstructorParameters<typeof EngineError>[0], details?: Record<string, unknown>) => new EngineError(code, 'x', details ? { details } : {});
    expect(blockerKind(e('invalid'), null)).toEqual({ kind: 'invalid' });
    expect(blockerKind(e('not_found'), null)).toEqual({ kind: 'invalid' });
    expect(blockerKind(e('refused'), null)).toEqual({ kind: 'prepare' });
    expect(blockerKind(e('refused', { problems: ['a secret'] }), 0)).toEqual({ kind: 'agent_trust' });
    expect(blockerKind(e('refused', { problems: ['another origin'], navigation: 1 }), 0)).toEqual({ kind: 'opens_other_site' });
    expect(blockerKind(e('refused', { problems: ['another origin', 'a secret'], navigation: 1 }), 0)).toEqual({ kind: 'agent_trust' });
    expect(blockerKind(e('refused', { problems: [], navigation: 0 }), 0)).toEqual({ kind: 'agent_trust' });
    expect(blockerKind(e('refused'), 0)).toEqual({ kind: 'prepare' });
    expect(blockerKind(e('refused'), 1)).toEqual({ kind: 'protected_host' });
    expect(blockerKind(e('refused', { refused: [{}, {}], env: { access: 'read-write' } }), 2)).toEqual({ kind: 'hook_refused', count: 2 });
    expect(blockerKind(e('refused', { refused: [{}], env: { access: 'read-only' } }), 2)).toEqual({ kind: 'read_only', count: 1 });
    expect(blockerKind(e('needs_approval', { hooks: [{}, {}, {}] }), 3)).toEqual({ kind: 'needs_approval', count: 3 });
    // A form too long to read: its own words (a terminal runs it), not a refused hook.
    expect(blockerKind(e('refused', { hooks: [{}, {}], too_long: true }), 3)).toEqual({ kind: 'too_long', count: 2 });
    expect(blockerKind(e('refused', { hooks: [{}] }), 3)).toEqual({ kind: 'prepare' });
    // A hooks preflight that failed fails gates 2 and 3 with its own error: not a refusal, not an approval.
    expect(blockerKind(e('not_found'), 2)).toEqual({ kind: 'prepare' });
    expect(blockerKind(e('invalid'), 3)).toEqual({ kind: 'invalid' });
    expect(blockerKind(e('internal'), 3)).toEqual({ kind: 'prepare' });
  });

  it('⚑ the real gates through the Studio’s engine: agent trust, a protected host, a read-only location’s writing hook, hooks to approve (counted), an invalid file', async () => {
    const kinds = async (slug: string, name: string) => {
      const a = await ui.scenarios.actions(slug, name);
      const k = (l: RunBlocker[]) => l.map((b) => [b.kind, b.count ?? null]);
      return { dry: k(a.run_blockers.dry), capture: k(a.run_blockers.capture) };
    };
    expect(await kinds('w', 'short')).toEqual({ dry: [], capture: [] });
    expect(await kinds('w', 'leak')).toEqual({ dry: [['agent_trust', null]], capture: [['agent_trust', null]] });
    expect(await kinds('twin', 'short')).toEqual({ dry: [['protected_host', null]], capture: [['protected_host', null]] });
    expect(await kinds('w', 'plain')).toEqual({ dry: [], capture: [['needs_approval', 1]] });
    expect(await kinds('prod', 'armed')).toEqual({ dry: [], capture: [['read_only', 1]] });
    const broken = await ui.scenarios.actions('w', 'broken');
    expect(broken.ok).toBe(false);
    expect(broken.run_blockers.dry).toEqual([{ code: 'invalid', kind: 'invalid', message: expect.stringMatching(/^the file has 1 error/), fix_file: true }]);
  });
});

describe('scenarios.actions: the status bar’s read', () => {
  it('the hash, the location, the counts, no run; a queued rehearsal is `running` with its job (critique M4), and it carries no path but the commands', async () => {
    const check = await ui.scenarios.check('w', 'short');
    const a = await ui.scenarios.actions('w', 'short');
    expect(a).toMatchObject({
      project: 'w',
      name: 'short',
      hash: check.hash,
      ok: true,
      environment: { name: 'local', production: false, access: 'read-write', sandbox: false },
      content: { scenes: 1, steps: 2 },
      runs: [],
      running: null,
    });
    expect(a.capture).toBeUndefined();
    expect(a.render_job).toBeUndefined();
    const sub = await ui.runs.submit({ project: 'w', scenario: 'short', mode: 'dry' });
    try {
      const b = await ui.scenarios.actions('w', 'short');
      expect(b.running).toMatchObject({ id: sub.run_id, mode: 'dry', status: 'queued', job: sub.job.id });
      expect(JSON.stringify(b)).not.toContain(ws);
      const plain = await ui.scenarios.actions('w', 'plain');
      // The only absolute paths: the commands a person types (fix, fix_node).
      const text = JSON.stringify({ ...plain, run_blockers: plain.run_blockers.capture.map((x) => ({ ...x, fix: undefined, fix_node: undefined })) });
      expect(text).not.toContain(ws);
    } finally {
      await ui.runs.cancel('w', sub.run_id);
    }
    const c = await ui.scenarios.actions('w', 'short');
    expect(c.running).toBeNull();
    expect(c.runs[0]).toMatchObject({ id: sub.run_id, status: 'cancelled' });
    expect(c.runs[0].job).toBeUndefined();
  });

  it("⚑ a terminal's run and a Studio job unfinished together: `running` is the job's run (Stop reaches it), however new the terminal's is", async () => {
    const term = '20991231-000000-short';
    await writeRun(join(ws, 'projects', 'w'), { id: term, scenario: 'short', mode: 'dry', status: 'running', noTimeline: true, steps_total: 2, events: [] });
    const sub = await ui.runs.submit({ project: 'w', scenario: 'short', mode: 'dry' });
    try {
      const a = await ui.scenarios.actions('w', 'short');
      expect(a.runs.filter((r) => r.status === 'queued' || r.status === 'running').map((r) => [r.id, r.job])).toEqual([
        [term, null],
        [sub.run_id, sub.job.id],
      ]);
      expect(a.running).toMatchObject({ id: sub.run_id, job: sub.job.id });
    } finally {
      await ui.runs.cancel('w', sub.run_id);
    }
    // The terminal's run alone: it is `running` (Ctrl-C there).
    const b = await ui.scenarios.actions('w', 'short');
    expect(b.running).toMatchObject({ id: term, job: null });
    await rm(join(ws, 'projects', 'w', 'runs', term), { recursive: true, force: true });
  });
});

describe('memo (critique H2)', () => {
  const views = async () => {
    const wsc = await openWorkspace({ root: ws, agent: false, reads: diskWorkspaceReads });
    let blockers = 0;
    const v = new ScenarioViews({
      ws: wsc,
      project: (slug) => openProjectBySlug(wsc, slug),
      blockers: async () => {
        blockers++;
        return { dry: [], capture: [] };
      },
      overlay: async (_slug, r) => r.status,
      runs: new RunDataCache(),
    });
    return { v, blockers: () => blockers };
  };

  it('⚑ actions never insert into the view’s text layer: reading 20 other scenarios leaves the open scenario’s view a hit; a fresh text layer serves actions', async () => {
    const { v } = await views();
    await v.view('w', 'short');
    expect(v.stats.text).toBe(1);
    // The open scenario's text layer is fresh: the status bar reads it, computes nothing.
    await v.actions('w', 'short');
    expect(v.stats).toMatchObject({ text: 1, actions: 0 });
    // The status bar walks 20 scenarios (selecting posters): its own memo, the view's cache untouched.
    for (let i = 0; i < 20; i++) await v.actions('w', `many-${i}`);
    expect(v.stats).toMatchObject({ text: 1, actions: 20 });
    await v.view('w', 'short');
    expect(v.stats.text).toBe(1);
    // An actions read is not a text layer: the view of a scenario read only by the status bar computes its own.
    await v.view('w', 'many-0');
    expect(v.stats.text).toBe(2);
    // A second read of one of them is the actions memo's hit.
    await v.actions('w', 'many-3');
    expect(v.stats.actions).toBe(20);
  });

  it('⚑ single flight: two views of the same file at once compute one text layer; two actions reads at once, one actions layer', async () => {
    const { v, blockers } = await views();
    await Promise.all([v.view('w', 'plain'), v.view('w', 'plain')]);
    expect(v.stats.text).toBe(1);
    expect(blockers()).toBe(1);
    await Promise.all([v.actions('w', 'leak'), v.actions('w', 'leak'), v.actions('w', 'leak')]);
    expect(v.stats.actions).toBe(1);
    expect(blockers()).toBe(2);
  });
});
