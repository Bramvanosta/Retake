/**
 * L4.2 part 2: the scenario screen's read (engine scenarios.view, scenario-view.ts) on synthetic runs, and the events
 * that tell it what changed.
 *
 * - Source run (critique B8): the newest complete run with pictures, newer partial runs named, a running run reported
 *   and never a source; a run asked for; refusals (another scenario's run, an unfinished one, a bad id).
 * - Binding (critique B4): unchanged → by position; changed → by step identity (an inserted step is new and the
 *   others keep their pictures; an argument change is changed; a caption-only change keeps the picture; a scene's
 *   `open` change → scene_changed); no snapshot → by position, "cannot tell". Not reached (failed, until), the steps a
 *   dry run skipped after an irreversible step, a skipped scene; page text only under `untrusted`, URL userinfo out.
 * - Memo (critique B1): a repeat recomputes nothing; a running run's run.json rewritten 20 times recomputes no text
 *   layer and no binding; an edit of the file recomputes both.
 * - Events (critique B1): an in-place save is a `scenario:` key of its own; run changes carry the run's scenario
 *   (new, progress, status, removed).
 */
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixtureWorkspace } from '@retake/test-support/workspace';
import { EngineError, RunDataCache, ScenarioViews, VIEW_STEPS_MAX, WorkspaceIndex, createEngine, openProjectBySlug, runChanges, workspaceChanges } from '../src/index.js';
import type { Engine, ScenarioView, StepBinding } from '../src/index.js';
import { BLOCKS_YAML, BLUE, GREEN, RED, capture, writeRun } from '@retake/test-support/runs';
import { scratchHome } from '@retake/test-support/home';

let ws: string;
let projectDir: string;
let engine: Engine;
const P = 'northfield-fixture';
const retakeHome = scratchHome();
const CAP = '20261020-100000-blocks';
const DRY_UNTIL = '20261021-090000-blocks';
const RUNNING = '20261021-100000-blocks';

const bound = (b: StepBinding | undefined) => (b && 'picture' in b ? b : undefined);

beforeAll(async () => {
  ws = await mkdtemp(join(tmpdir(), 'studio-scenario-view-'));
  retakeHome.use(join(ws, '.home'));
  await fixtureWorkspace(ws);
  projectDir = join(ws, 'projects', P);
  await writeFile(join(projectDir, 'scenarios', 'blocks.yaml'), BLOCKS_YAML);
  await writeRun(projectDir, capture(CAP, { video: false }));
  await writeRun(projectDir, {
    id: DRY_UNTIL,
    scenario: 'blocks',
    mode: 'dry',
    snapshot: BLOCKS_YAML,
    scenes: [{ id: 'one' }, { id: 'two' }],
    events: [
      { scene: 'one', step: 0, action: 'click', t_start: 0, t_end: 0.5 },
      { scene: 'one', step: 1, action: 'click', t_start: 0.5, t_end: 1 },
      { scene: 'one', step: 2, action: 'hold', t_start: 1, t_end: 2 },
      { scene: 'two', step: 0, action: 'click', t_start: 2, t_end: 3 },
    ],
    screenshots: { 'one-00-click.png': RED, 'one-01-click.png': GREEN, 'one-02-hold.png': BLUE, 'two-00-click.png': RED },
    stopped_at: { scene: 'two', step: 0, reason: 'until' },
  });
  await writeRun(projectDir, { id: RUNNING, scenario: 'blocks', mode: 'capture', status: 'running', noTimeline: true, steps_total: 5 });
  engine = await createEngine({ root: ws, client: 'ui', autoStartWorker: false });
}, 60_000);

afterAll(async () => {
  retakeHome.restore();
  if (ws) await rm(ws, { recursive: true, force: true });
});

describe('the source run (B8)', () => {
  it('default: the newest complete run with pictures; the newer until-run named; the running run reported, never the source', async () => {
    const v = await engine.scenarios.view(P, 'blocks');
    expect([v.project, v.name, v.file, v.ok, v.text]).toEqual([P, 'blocks', 'scenarios/blocks.yaml', true, BLOCKS_YAML]);
    expect(v.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(v.blocks.step_count).toBe(5);
    expect(v.run_blockers).toEqual({ dry: [], capture: [] });
    expect(v.environment).toEqual({ name: 'local', production: false, access: 'read-write', sandbox: false });
    expect(v.runs.map((r) => [r.id, r.status, r.pictures, r.complete, r.partial])).toEqual([
      [RUNNING, 'running', null, false, undefined],
      [DRY_UNTIL, 'succeeded', 'screenshots', false, 'until step 1 of two'],
      [CAP, 'succeeded', 'frames', true, undefined],
    ]);
    expect(v.running?.id).toBe(RUNNING);
    expect(v.source).toEqual({
      run: CAP,
      mode: 'capture',
      status: 'succeeded',
      finished_at: '2026-10-20T10:01:00.000Z',
      picked: false,
      changed: false,
      binding: 'position',
      hooks: { setup: 'none', teardown: 'none' },
      newer_partial: [{ id: DRY_UNTIL, mode: 'dry', partial: 'until step 1 of two', pictures: 'screenshots' }],
    });
    expect(v.scenes.one).toEqual({ url: 'http://localhost:4401/', display: expect.stringMatching(/console\.northfield\.example\/$/), captured_s: 2, run_status: 'ok' });
    expect(v.scenes.two).toEqual({ url: 'http://localhost:4401/catalog', display: expect.stringMatching(/console\.northfield\.example\/catalog$/), captured_s: 3, run_status: 'ok' });
  });

  it('unchanged file: every step bound by position to the run’s own key, with its picture source and duration', async () => {
    const v = await engine.scenarios.view(P, 'blocks');
    expect(v.steps).toEqual({
      'one.0': { run_key: 'one.0', status: 'ok', ms: 750, picture: 'frame' },
      'one.1': { run_key: 'one.1', status: 'ok', ms: 50, picture: 'frame' },
      'one.2': { run_key: 'one.2', status: 'ok', ms: 200, picture: 'frame' },
      'two.0': { run_key: 'two.0', status: 'ok', ms: 1050, picture: 'frame' },
      'two.1': { run_key: 'two.1', status: 'ok', ms: 1150, picture: 'frame' },
    });
    // Page text only under untrusted.
    expect(v.untrusted.steps['one.0']).toEqual({ target: 'button "First"' });
    expect(JSON.stringify({ ...v, untrusted: undefined })).not.toContain('button \\"First\\"');
  });

  it('a run asked for: an until dry run — screenshots, the step after `until` not reached', async () => {
    const v = await engine.scenarios.view(P, 'blocks', { run: DRY_UNTIL });
    expect(v.source).toMatchObject({ run: DRY_UNTIL, picked: true, changed: false, newer_partial: [] });
    expect(bound(v.steps['one.2'])?.picture).toBe('screenshot');
    expect(v.steps['two.1']).toEqual({ missing: 'not_reached', why: 'the run stopped at step 1 of two (until)', run_key: 'two.1' });
  });

  it('refusals: another scenario’s run, an unfinished run, an unknown run, a bad id', async () => {
    const code = async (run: string) => ((await engine.scenarios.view(P, 'blocks', { run }).catch((e: unknown) => e)) as EngineError).code;
    expect(await code('20261017-120000-quote')).toBe('invalid');
    expect(await code(RUNNING)).toBe('invalid');
    expect(await code('20261099-000000-blocks')).toBe('not_found');
    expect(await code('../x')).toBe('invalid');
  });
});

describe('binding a changed file (B4)', () => {
  const view = async (yaml: string, run?: string): Promise<ScenarioView> => {
    await writeFile(join(projectDir, 'scenarios', 'edited.yaml'), yaml);
    await writeRun(projectDir, capture('20261019-100000-edited', { scenario: 'edited', video: false }));
    return engine.scenarios.view(P, 'edited', run ? { run } : {});
  };

  it('a step inserted, an argument changed, a caption added: new / changed / kept — pictures stay with their steps', async () => {
    const yaml = BLOCKS_YAML.replace('      - click: First\n', '      - click: Zeroth\n      - click: First\n')
      .replace('      - click: Second\n', '      - click: Second\n        caption: Now the second\n')
      .replace('click: Third', 'click: Third!');
    const v = await view(yaml);
    expect(v.source).toMatchObject({ changed: true, binding: 'identity', notice: 'changed', filmed_changes: ['scene one: step one.0 added', 'scene two: step two.0 changed'] });
    expect(v.steps['one.0']).toEqual({ missing: 'new' });
    expect(bound(v.steps['one.1'])?.run_key).toBe('one.0');
    expect(bound(v.steps['one.2'])?.run_key).toBe('one.1');
    expect(bound(v.steps['one.3'])?.run_key).toBe('one.2');
    expect(v.steps['two.0']).toEqual({ missing: 'changed', run_key: 'two.0' });
    expect(bound(v.steps['two.1'])?.run_key).toBe('two.1');
    // Page text follows the run's step, keyed by today's step.
    expect(v.untrusted.steps['one.1']).toEqual({ target: 'button "First"' });
  });

  it('a scene’s open changed: its steps scene_changed; formatting only: unchanged (by position)', async () => {
    const v = await view(BLOCKS_YAML.replace('open: /catalog', 'open: /catalog?all=1'));
    expect([v.steps['two.0'], v.steps['two.1']]).toEqual([{ missing: 'scene_changed' }, { missing: 'scene_changed' }]);
    expect(bound(v.steps['one.0'])?.run_key).toBe('one.0');
    const w = await view(`# a comment\n${BLOCKS_YAML.replace('click: First', 'click: "First"')}`);
    expect(w.source).toMatchObject({ changed: false, binding: 'position' });
  });

  it('only the edit changed (a caption): notice edit_changed, every picture kept (L5.5)', async () => {
    const v = await view(BLOCKS_YAML.replace('      - click: Second\n', '      - click: Second\n        caption: Now the second\n'));
    expect(v.source).toMatchObject({ changed: true, notice: 'edit_changed' });
    expect(v.source).not.toHaveProperty('filmed_changes');
    expect(bound(v.steps['two.0'])?.run_key).toBe('two.0');
    expect(bound(v.steps['two.1'])?.run_key).toBe('two.1');
  });

  it('no snapshot in the run: bound by position, "cannot tell"', async () => {
    await writeRun(projectDir, capture('20261019-110000-blocks', { snapshot: undefined, video: false }));
    const v = await engine.scenarios.view(P, 'blocks', { run: '20261019-110000-blocks' });
    expect(v.source).toMatchObject({ changed: null, binding: 'position', notice: 'cannot_tell' });
    expect(bound(v.steps['two.1'])?.run_key).toBe('two.1');
  });
});

describe('steps a run did not picture', () => {
  it('a dry run stopped at an irreversible step: that step pictured, the scene’s later steps skipped and why; a skipped scene', async () => {
    const yaml = BLOCKS_YAML.replace('      - click: Second\n', '      - click: Second\n        irreversible: true\n');
    await writeFile(join(projectDir, 'scenarios', 'irr.yaml'), yaml);
    await writeRun(projectDir, {
      id: '20261019-120000-irr',
      scenario: 'irr',
      mode: 'dry',
      snapshot: yaml,
      scenes: [
        { id: 'one', status: 'partial' },
        { id: 'two', status: 'skipped' },
      ],
      events: [
        { scene: 'one', step: 0, action: 'click', t_start: 0, t_end: 1 },
        { scene: 'one', step: 1, action: 'click', t_start: 1, t_end: 2, status: 'dry' },
        { scene: 'one', step: 2, action: 'hold', t_start: 2, t_end: 2, status: 'skipped' },
      ],
      screenshots: { 'one-00-click.png': RED, 'one-01-click.png': GREEN },
      stopped_at: { scene: 'one', step: 1, reason: 'irreversible' },
    });
    const v = await engine.scenarios.view(P, 'irr');
    expect(v.source?.run).toBe('20261019-120000-irr');
    expect(v.steps['one.1']).toEqual({ run_key: 'one.1', status: 'dry', ms: 1000, picture: 'screenshot' });
    // 1-based like every step a person reads (review B M2).
    expect(v.steps['one.2']).toEqual({ run_key: 'one.2', status: 'skipped', ms: 0, picture: null, why: 'after step 2 of one, irreversible: a dry run stops the scene there' });
    expect(v.steps['two.0']).toEqual({ missing: 'scene_skipped', run_key: 'two.0' });
  });

  it('a failed run: the failure’s step, later steps not reached naming it; page text and URLs under untrusted, userinfo out', async () => {
    const yaml = BLOCKS_YAML.replace('open: /catalog', 'open: https://user:secret@shop.example.test/catalog');
    await writeFile(join(projectDir, 'scenarios', 'failing.yaml'), yaml);
    const run = capture('20261019-130000-failing', {
      scenario: 'failing',
      snapshot: yaml,
      status: 'failed',
      video: false,
      error: { scene: 'two', step: 0, message: '<img src=x onerror=alert(1)> not found' },
    });
    run.events = run.events!.slice(0, 4);
    run.events[3] = { ...run.events[3], status: 'failed', error: '<img src=x onerror=alert(1)> not found', url: 'https://u:p@shop.example.test/x' };
    await writeRun(projectDir, run);
    const v = await engine.scenarios.view(P, 'failing');
    expect(v.runs[0]).toMatchObject({ id: run.id, complete: false, partial: 'failed at step 1 of two' });
    expect(v.source?.run).toBe(run.id);
    expect(v.scenes.two.url).toBe('https://shop.example.test/catalog');
    expect(v.steps['two.0']).toEqual({ run_key: 'two.0', status: 'failed', ms: 1050, picture: 'frame' });
    expect(v.steps['two.1']).toEqual({ missing: 'not_reached', why: 'the run failed at step 1 of two', run_key: 'two.1' });
    expect(v.untrusted.steps['two.0']).toEqual({ error: '<img src=x onerror=alert(1)> not found', url: 'https://shop.example.test/x' });
    expect(v.untrusted.run_error).toBe('<img src=x onerror=alert(1)> not found');
    expect(JSON.stringify({ ...v, untrusted: undefined, text: undefined, blocks: undefined })).not.toMatch(/onerror|secret|u:p@/);
  });

  it('a page base URL with user:password@ (an environment behind basic auth): the scene URL shown without it', async () => {
    const file = join(projectDir, 'project.yaml');
    const yaml = await readFile(file, 'utf8');
    await writeFile(file, yaml.replace('environments:\n', 'environments:\n  staging:\n    console: {url: "http://user:pw@localhost:4401", display: console.northfield.example}\n'));
    try {
      const v = await engine.scenarios.view(P, 'blocks', { env: 'staging' });
      expect(v.environment?.name).toBe('staging');
      expect([v.scenes.one.url, v.scenes.two.url]).toEqual(['http://localhost:4401/', 'http://localhost:4401/catalog']);
      expect(JSON.stringify({ ...v, text: undefined })).not.toContain('user:pw');
    } finally {
      await writeFile(file, yaml);
    }
  });

  it('a person’s scenario with {{env:…}}: valid on the screen (no agent trust), both runs blocked with Studio wording (#6, B2)', async () => {
    await writeFile(
      join(projectDir, 'scenarios', 'person.yaml'),
      'video: person\nscenes:\n  - id: a\n    page: console\n    open: /\n    steps:\n      - type: {into: {label: Token}, text: "{{env:API_KEY}}"}\n',
    );
    const v = await engine.scenarios.view(P, 'person');
    expect([v.ok, v.issues.filter((i) => i.severity === 'error')]).toEqual([true, []]);
    for (const mode of ['dry', 'capture'] as const) {
      expect(v.run_blockers[mode].map((b) => b.code)).toEqual(['refused']);
      expect(v.run_blockers[mode][0].message).toMatch(/^refused from the Studio: /);
    }
  });

  it('a scenario with no run yet: blocks and blockers, no source, no bindings', async () => {
    await writeFile(join(projectDir, 'scenarios', 'fresh.yaml'), BLOCKS_YAML);
    const v = await engine.scenarios.view(P, 'fresh');
    expect([v.runs, v.source, v.running, v.steps]).toEqual([[], null, null, {}]);
    expect(v.blocks.step_count).toBe(5);
  });
});

describe('review fixes (L4.2)', () => {
  it('a run.json status or scene the runner never writes: `unknown`, no name (review A #4)', async () => {
    await writeFile(join(projectDir, 'scenarios', 'hostile.yaml'), BLOCKS_YAML);
    await writeRun(projectDir, capture('20261018-100000-hostile', { scenario: 'hostile', video: false }));
    await writeRun(projectDir, { id: '20261018-100100-hostile', scenario: 'hostile', mode: 'dry', status: 'failed', error: { scene: '\u202Egnp.exe', step: 0, message: 'x' } });
    const file = join(projectDir, 'runs', '20261018-100200-hostile', 'run.json');
    await writeRun(projectDir, { id: '20261018-100200-hostile', scenario: 'hostile', mode: 'dry' });
    await writeFile(file, (await readFile(file, 'utf8')).replace('"status":"succeeded"', '"status":"\u202Edeeccus — XXXX"'));
    const v = await engine.scenarios.view(P, 'hostile');
    expect(v.runs.map((r) => [r.id, r.status, r.partial])).toEqual([
      ['20261018-100200-hostile', 'unknown', undefined],
      ['20261018-100100-hostile', 'failed', 'failed at step 1 of a scene'],
      ['20261018-100000-hostile', 'succeeded', undefined],
    ]);
    expect(JSON.stringify(v.runs)).not.toMatch(/\u202E|gnp|deeccus/);
  });

  it('a newer run that failed before its first step (no picture) is named over the pictures (review B H1)', async () => {
    await writeFile(join(projectDir, 'scenarios', 'down.yaml'), BLOCKS_YAML);
    await writeRun(projectDir, capture('20261018-110000-down', { scenario: 'down', video: false }));
    await writeRun(projectDir, {
      id: '20261018-110100-down',
      scenario: 'down',
      mode: 'dry',
      status: 'failed',
      noTimeline: true,
      error: { scene: 'one', step: 0, message: 'net::ERR_CONNECTION_REFUSED' },
    });
    await writeRun(projectDir, { id: '20261018-110200-down', scenario: 'down', mode: 'dry', status: 'succeeded', noTimeline: true });
    const v = await engine.scenarios.view(P, 'down');
    expect(v.source?.run).toBe('20261018-110000-down');
    expect(v.source?.newer_partial).toEqual([
      { id: '20261018-110200-down', mode: 'dry', partial: 'no pictures', pictures: null },
      { id: '20261018-110100-down', mode: 'dry', partial: 'failed at step 1 of one', pictures: null },
    ]);
  });

  it('the default source prefers a complete run it can match over a newer one without a snapshot (review B L6)', async () => {
    await writeFile(join(projectDir, 'scenarios', 'snap.yaml'), BLOCKS_YAML);
    await writeRun(projectDir, capture('20261018-120000-snap', { scenario: 'snap', video: false }));
    await writeRun(projectDir, capture('20261018-120100-snap', { scenario: 'snap', snapshot: undefined, video: false }));
    const v = await engine.scenarios.view(P, 'snap');
    expect(v.runs.map((r) => [r.id, r.complete, r.snapshot])).toEqual([
      ['20261018-120100-snap', true, false],
      ['20261018-120000-snap', true, true],
    ]);
    expect(v.source).toMatchObject({ run: '20261018-120000-snap', changed: false, binding: 'position' });
    expect(v.source?.notice).toBeUndefined();
  });

  it('a step with two actions: why in words, not "the timeline cannot be read" (review B M3)', async () => {
    const yaml = BLOCKS_YAML.replace('      - click: Second\n', '      - {click: Second, hover: Elsewhere}\n');
    await writeFile(join(projectDir, 'scenarios', 'two-actions.yaml'), yaml);
    await writeRun(projectDir, capture('20261018-130000-two-actions', { scenario: 'two-actions', snapshot: yaml, video: false }));
    const v = await engine.scenarios.view(P, 'two-actions');
    expect(v.steps['one.1']).toEqual({ missing: 'unreadable', why: 'this step has no single action (fix it in the file)' });
    // Changed since the run (bound by identity): the same words.
    await writeFile(join(projectDir, 'scenarios', 'two-actions.yaml'), yaml.replace('click: First', 'click: Firstly'));
    const w = await engine.scenarios.view(P, 'two-actions');
    expect(w.source?.binding).toBe('identity');
    expect(w.steps['one.1']).toEqual({ missing: 'unreadable', why: 'this step has no single action (fix it in the file)' });
  });

  it('a multi-page scene: each page with its environment page and full URL, or the scene it continues from (review B M1)', async () => {
    const v = await engine.scenarios.view(P, 'phone-and-desktop');
    expect(v.scenes.phone.pages).toEqual([
      { id: 'desk', page: 'shop', url: 'http://localhost:4402/quotes', display: expect.stringMatching(/\/quotes$/) },
      { id: 'phone', page: 'shop', url: 'http://localhost:4402/products/selowa-ridge', display: expect.stringMatching(/\/products\/selowa-ridge$/) },
    ]);
    expect(v.scenes.send.pages).toEqual([
      { id: 'desk', page: 'shop', continues_from: 'phone' },
      { id: 'phone', page: 'shop', continues_from: 'phone' },
    ]);
    expect(v.scenes.phone.url).toBeUndefined();
  });

  it('a file with errors: one blocker per mode, "fix the file first", no command (review B M6); paths in words, the node command (M2, L6)', async () => {
    await writeFile(join(projectDir, 'scenarios', 'broken.yaml'), 'video: broken\nscenes:\n  - id: a\n    page: console\n    open: /\n    steps:\n      - clik: A\n      - click: B\n');
    const v = await engine.scenarios.view(P, 'broken');
    expect(v.ok).toBe(false);
    for (const mode of ['dry', 'capture'] as const) {
      expect(v.run_blockers[mode]).toEqual([
        { code: 'invalid', kind: 'invalid', message: expect.stringMatching(/^the file has 1 error \(listed with the blocks\): fix the file first/), fix_file: true },
      ]);
    }
    const views = new ScenarioViews({
      ws: engine.workspace,
      project: (slug) => openProjectBySlug(engine.workspace, slug),
      blockers: async () => {
        const b = {
          code: 'refused' as const,
          message: 'refused from the Studio: scenes[1].steps[0].click and setup[0] need a person; scenes[0] too',
          fix: 'retake -C /w run northfield-fixture blocks',
        };
        return { dry: [b], capture: [b] };
      },
      overlay: async (_slug, r) => r.status,
      runs: new RunDataCache(),
    });
    const w = await views.view(P, 'blocks');
    expect(w.run_blockers.dry[0].message).toBe('refused from the Studio: step 1 of scene two (click) and setup hook 1 need a person; scene one too');
    expect(w.run_blockers.dry[0].fix).toBe('retake -C /w run northfield-fixture blocks');
    expect(w.run_blockers.dry[0].fix_node).toMatch(/\/packages\/cli\/dist\/bin\.js -C \/w run northfield-fixture blocks$/);
    expect(w.run_blockers.dry[0].fix_node?.startsWith(process.execPath)).toBe(true);
  });

  it('a file of more steps than the view returns: the first VIEW_STEPS_MAX, and how many there are (review A #8)', async () => {
    const yaml = `video: huge\nscenes:\n${Array.from({ length: 3 }, (_s, i) => `  - id: s${i}\n    page: console\n    open: /\n    steps:\n${Array.from({ length: 800 }, (_x, j) => `      - click: B${i}-${j}\n`).join('')}`).join('')}`;
    await writeFile(join(projectDir, 'scenarios', 'huge.yaml'), yaml);
    await writeRun(projectDir, {
      id: '20261018-140000-huge',
      scenario: 'huge',
      mode: 'capture',
      snapshot: yaml,
      scenes: [
        { id: 's0', t_start: 0, t_end: 1 },
        { id: 's1', t_start: 1, t_end: 2 },
        { id: 's2', t_start: 2, t_end: 3 },
      ],
      events: Array.from({ length: 2400 }, (_x, k) => ({ scene: `s${Math.floor(k / 800)}`, step: k % 800, action: 'click', t_start: k / 800, t_end: k / 800 + 0.001 })),
      frames: [[0, RED]],
      duration: 3,
    });
    const v = await engine.scenarios.view(P, 'huge');
    expect(v.limit).toEqual({ steps_shown: VIEW_STEPS_MAX, steps_total: 2400, issues_shown: 0, issues_total: 0 });
    expect(v.blocks.step_count).toBe(2400);
    const shown = v.blocks.entries.flatMap((e) => (e.type === 'scene' ? e.steps : []));
    expect(shown).toHaveLength(VIEW_STEPS_MAX);
    expect(v.blocks.entries.map((e) => (e.type === 'scene' ? e.steps.length : -1))).toEqual([800, 800, 400]);
    // Past the cut nothing more: a file of many small scenes does not send every scene's header.
    const many = `video: many\nscenes:\n${Array.from({ length: 1500 }, (_s, i) => `  - id: m${i}\n    page: console\n    open: /\n    steps:\n      - click: A\n      - click: B\n`).join('')}`;
    await writeFile(join(projectDir, 'scenarios', 'many.yaml'), many);
    const m = await engine.scenarios.view(P, 'many');
    expect(m.blocks.entries).toHaveLength(VIEW_STEPS_MAX / 2);
    expect(m.limit?.steps_total).toBe(3000);
    expect(Object.keys(v.steps)).toHaveLength(VIEW_STEPS_MAX);
    expect(v.steps['s2.400']).toBeUndefined();
    expect((await engine.scenarios.view(P, 'blocks')).limit).toBeUndefined();
  });
});

describe('memo (B1)', () => {
  it('a repeat recomputes nothing; 20 run.json rewrites of a running run recompute no text and no binding; an edit recomputes both', async () => {
    let blockers = 0;
    const runs = new RunDataCache();
    const views = new ScenarioViews({
      ws: engine.workspace,
      project: (slug) => openProjectBySlug(engine.workspace, slug),
      blockers: async () => {
        blockers++;
        return { dry: [], capture: [] };
      },
      overlay: async (_slug, r) => r.status,
      runs,
    });
    const a = await views.view(P, 'blocks');
    const reads = runs.reads;
    // L7.6a: whether a run is a take is read once per succeeded capture, then held (a repeat reads no run folder).
    const takes = views.stats.takes;
    // (These captures kept their frames and no film: none is a take.)
    expect([takes > 0, a.runs.filter((r) => r.take).length, a.runs.filter((r) => r.mode === 'capture' && r.status === 'succeeded').length]).toEqual([true, 0, takes]);
    const b = await views.view(P, 'blocks');
    expect(b).toEqual(a);
    expect([views.stats.text, views.stats.bind, views.stats.list, blockers, runs.reads, views.stats.takes]).toEqual([1, 1, 1, 1, reads, takes]);
    const file = join(projectDir, 'runs', RUNNING, 'run.json');
    const rec = JSON.parse(await readFile(file, 'utf8')) as { steps_done: number };
    for (let i = 0; i < 20; i++) {
      rec.steps_done = i;
      await writeFile(file, JSON.stringify(rec));
      const v = await views.view(P, 'blocks');
      expect(v.running?.steps_done).toBe(i);
    }
    expect([views.stats.text, views.stats.bind, blockers, views.stats.takes]).toEqual([1, 1, 1, takes]);
    await writeFile(join(projectDir, 'scenarios', 'blocks.yaml'), `${BLOCKS_YAML}# edited\n`);
    const c = await views.view(P, 'blocks');
    expect([views.stats.text, views.stats.bind, blockers]).toEqual([2, 2, 2]);
    expect(c.source?.changed).toBe(false);
    await writeFile(join(projectDir, 'scenarios', 'blocks.yaml'), BLOCKS_YAML);
  });

  it('1,200 steps: the first read and a repeat (numbers in the log)', async () => {
    const scenes = Array.from(
      { length: 12 },
      (_s, i) => `  - id: s${i}\n    page: console\n    open: /p${i}\n    steps:\n${Array.from({ length: 100 }, (_x, j) => `      - click: Button ${i}-${j}\n`).join('')}`,
    );
    const yaml = `video: long\nscenes:\n${scenes.join('')}`;
    await writeFile(join(projectDir, 'scenarios', 'long.yaml'), yaml);
    await writeRun(projectDir, {
      id: '20261019-140000-long',
      scenario: 'long',
      mode: 'capture',
      snapshot: yaml,
      scenes: Array.from({ length: 12 }, (_s, i) => ({ id: `s${i}`, t_start: i, t_end: i + 1 })),
      events: Array.from({ length: 1200 }, (_x, k) => ({ scene: `s${Math.floor(k / 100)}`, step: k % 100, action: 'click', t_start: k / 100, t_end: k / 100 + 0.005 })),
      frames: [[0, RED]],
      duration: 12,
    });
    let t = performance.now();
    const v = await engine.scenarios.view(P, 'long');
    const first = performance.now() - t;
    t = performance.now();
    await engine.scenarios.view(P, 'long');
    const repeat = performance.now() - t;
    console.log(`1,200-step view: first ${Math.round(first)} ms, repeat ${Math.round(repeat)} ms, ${Math.round(JSON.stringify(v).length / 1024)} KB`);
    expect(Object.keys(v.steps).length).toBe(1200);
    expect(Object.values(v.steps).every((s) => 'picture' in s && s.picture === 'frame')).toBe(true);
    expect(repeat).toBeLessThan(first);
  });
});

describe('events (B1): scenario files and runs named', () => {
  it('runChanges: new, progress (an unfinished run’s run.json signature), status, removed — each with its scenario', () => {
    const before = [
      { id: 'r1', scenario: 'a', status: 'running' },
      { id: 'r2', scenario: 'b', status: 'succeeded' },
      { id: 'r3', scenario: 'c', status: 'running' },
    ];
    const after = [
      { id: 'r1', scenario: 'a', status: 'running' },
      { id: 'r3', scenario: 'c', status: 'failed' },
      { id: 'r4', scenario: 'a', status: 'queued' },
    ];
    expect(runChanges(P, before, after, 'd|r1=1:2:3|r3=4:5:6', 'd|r1=1:9:9|r3=4:5:7')).toEqual([
      { project: P, run: 'r1', scenario: 'a', status: 'running', finished: false, change: 'progress' },
      { project: P, run: 'r2', scenario: 'b', status: 'succeeded', finished: true, change: 'removed' },
      { project: P, run: 'r3', scenario: 'c', status: 'failed', finished: true, change: 'status' },
      { project: P, run: 'r4', scenario: 'a', status: 'queued', finished: false, change: 'new' },
    ]);
    expect(workspaceChanges([`scenario:${P}/quote`, `runs:${P}`])).toEqual({ projects: [P], readme: [], scenarios: [`${P}/quote`], history: false });
  });

  it('the index: an in-place save is its own key; a run that starts, progresses and finishes is named with its scenario', async () => {
    const ix = await WorkspaceIndex.open(engine.workspace, { queue: engine.queue.withOwnMemory() });
    if (!ix) throw new Error('node:sqlite did not load: no index to watch');
    try {
      // The second pass also watches the run.json of the runs the first found unfinished.
      await ix.reconcile();
      await ix.reconcile();
      expect((await ix.reconcile()).keys).toEqual([]);
      await writeFile(join(projectDir, 'scenarios', 'quote.yaml'), `${await readFile(join(projectDir, 'scenarios', 'quote.yaml'), 'utf8')}# saved\n`);
      expect((await ix.reconcile()).keys).toEqual([`scenario:${P}/quote`]);
      const id = '20261022-100000-quote';
      await writeRun(projectDir, { id, scenario: 'quote', mode: 'dry', status: 'running', noTimeline: true });
      expect((await ix.reconcile()).runs).toEqual([{ project: P, run: id, scenario: 'quote', status: 'running', finished: false, change: 'new' }]);
      // The pass after a run appears starts watching its run.json (no change of its own to tell).
      expect((await ix.reconcile()).runs).toEqual([]);
      const file = join(projectDir, 'runs', id, 'run.json');
      const rec = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
      await writeFile(file, JSON.stringify({ ...rec, steps_done: 3 }));
      expect((await ix.reconcile()).runs).toEqual([{ project: P, run: id, scenario: 'quote', status: 'running', finished: false, change: 'progress' }]);
      await writeFile(file, JSON.stringify({ ...rec, status: 'succeeded', finished_at: '2026-10-22T10:00:00.000Z' }));
      expect((await ix.reconcile()).runs).toEqual([{ project: P, run: id, scenario: 'quote', status: 'succeeded', finished: true, change: 'status' }]);
      await rm(join(projectDir, 'runs', id), { recursive: true });
      expect((await ix.reconcile()).runs).toEqual([{ project: P, run: id, scenario: 'quote', status: 'succeeded', finished: true, change: 'removed' }]);
    } finally {
      ix.close();
    }
  });
});
