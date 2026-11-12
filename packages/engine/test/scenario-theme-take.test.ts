/**
 * L4.7 part A2 (critique B1): "Use in this scenario" re-themes the takes the person is looking at. A scenario's
 * `template` set through scenario_edit `set_field` is an edit value: the next plan of an EXISTING take (the timeline
 * view, the plan a render makes) uses the new theme — its name and its folder's content hash (`theme_sha256`, what a
 * render records as `template_sha256`) — with no new capture; a Studio edit of that theme (templates.edit) changes the
 * hash of the next plan; removing `template` goes back to the project's theme. L4.7 part D2: the timeline inspector
 * offers the switch (`choices.video` field `template`: the project's theme, then every theme the workspace lists).
 */
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { STARTER_TEMPLATES_DIR } from '@retake/core/io';
import { themeContentHash } from '@retake/editor';
import { clearTimelineViewMemo, createEngine } from '../src/index.js';
import type { Engine, TimelineViewResult } from '../src/index.js';
import { synthTimeline } from '../../editor/test/helpers.js';

const SCENARIO = 'tl';
const RUN = '20260101-120000-tl';
const TEXT = `video: Timeline
title: {text: Timeline}
intro: false
outro: false
scenes:
  - id: a
    page: app
    open: /
    steps:
      - hold: 1
`;
let root: string;
let engine: Engine;
const savedHome = process.env.RETAKE_HOME;
const view = async (r: Promise<TimelineViewResult>) => {
  const v = await r;
  if (!('view' in v)) throw new Error(`blocked: ${JSON.stringify(v.blocked)}`);
  return v.view;
};

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'ds-scenario-theme-'));
  process.env.RETAKE_HOME = join(root, '.home');
  await writeFile(join(root, 'retake.yaml'), 'version: 1\nprojects_dir: projects\ntemplates_dir: templates\n');
  await cp(join(STARTER_TEMPLATES_DIR, 'editorial'), join(root, 'templates', 'brand'), { recursive: true });
  // Its own name (a byte-identical copy would have the starter's content hash).
  const tpl = join(root, 'templates', 'brand', 'template.yaml');
  await writeFile(tpl, (await readFile(tpl, 'utf8')).replace('name: editorial', 'name: brand'));
  const dir = join(root, 'projects', 'demo');
  const runDir = join(dir, 'runs', RUN);
  await mkdir(runDir, { recursive: true });
  await mkdir(join(dir, 'scenarios'), { recursive: true });
  await writeFile(join(dir, 'project.yaml'), 'version: 1\nname: Demo\nenvironments:\n  local: {app: "http://app.test"}\ntemplate: editorial\n');
  const t = synthTimeline({
    duration: 2,
    entries: [{ id: 'a', t_start: 0.5, t_end: 2, steps: [{ action: 'hold', t_start: 0.5, t_end: 2 }] }],
    video: { title: { text: 'Timeline' }, intro: false, outro: false, frame: 'card', template: 'editorial' },
  });
  t.run_id = RUN;
  t.project = 'demo';
  t.scenario = SCENARIO;
  await writeFile(join(runDir, 'timeline.json'), JSON.stringify(t));
  await writeFile(join(runDir, 'scenario.yaml'), TEXT);
  await writeFile(
    join(runDir, 'run.json'),
    JSON.stringify({
      version: 1,
      id: RUN,
      project: 'demo',
      scenario: SCENARIO,
      mode: 'capture',
      status: 'succeeded',
      started_at: '2026-01-01T12:00:00.000Z',
      finished_at: '2026-01-01T12:01:00.000Z',
      dir: runDir,
      env: 'local',
      options: { hooks: 'run', headed: false },
      steps_total: 1,
      steps_done: 1,
      screenshots: [],
      hooks: { setup: 'ok', teardown: 'ok' },
      warnings: [],
    }),
  );
  await writeFile(join(runDir, 'capture.mp4'), 'not a video');
  await writeFile(join(dir, 'scenarios', `${SCENARIO}.yaml`), TEXT);
  engine = await createEngine({ root, client: 'ui', autoStartWorker: false });
}, 60_000);

afterAll(async () => {
  if (savedHome === undefined) delete process.env.RETAKE_HOME;
  else process.env.RETAKE_HOME = savedHome;
  await rm(root, { recursive: true, force: true });
});

describe("a scenario's theme on an existing take (critique B1)", () => {
  it("set_field template → the take's next plan uses the new theme and its hash; a theme edit changes the hash; removing it restores the project's", async () => {
    clearTimelineViewMemo();
    const before = await view(engine.timeline.view({ project: 'demo', scenario: SCENARIO }));
    expect(before).toMatchObject({ theme: 'editorial', theme_sha256: themeContentHash(join(STARTER_TEMPLATES_DIR, 'editorial')), source: { scenario_changed: false } });
    // The inspector's switch: the project's theme (null), then the listed themes by name.
    const choice = before.choices.video.find((c) => c.field === 'template')!;
    expect(choice).toMatchObject({ at: { entry: 'top' }, field: 'template', editable: true });
    expect(choice.current).toBeUndefined();
    expect(choice.options[0]).toEqual({ value: null, label: "The project's theme (editorial)", usable: true });
    expect(choice.options.slice(1).map((o) => o.value)).toEqual(['brand', 'default', 'editorial', 'motion']);
    const set = await engine.scenarios.edit('demo', SCENARIO, { hash: before.hash!, edit: { kind: 'set_field', at: { entry: 'top' }, field: 'template', to: 'brand' } });
    expect(set.change).toBe('edit');
    const themed = await view(engine.timeline.view({ project: 'demo', scenario: SCENARIO }));
    const brandDir = join(root, 'templates', 'brand');
    expect(themed).toMatchObject({ theme: 'brand', run_id: RUN, source: { edit: 'scenario', scenario_changed: false } });
    expect(themed.theme_sha256).toBe(themeContentHash(brandDir));
    expect(themed.theme_sha256).not.toBe(before.theme_sha256);
    expect(themed.choices.video.find((c) => c.field === 'template')!.current).toBe('brand');
    // The Studio edits the theme: the next plan of the same take has the new files' hash.
    const tv = await engine.templates.view('brand');
    await engine.templates.edit('brand', { if_match: tv.sha256, edit: { kind: 'set_field', field: 'colors.accent', from: '#8a2332', to: '#225588' } });
    const edited = await view(engine.timeline.view({ project: 'demo', scenario: SCENARIO }));
    expect(edited.theme).toBe('brand');
    expect(edited.theme_sha256).toBe(themeContentHash(brandDir));
    expect(edited.theme_sha256).not.toBe(themed.theme_sha256);
    // Back to the project's theme.
    await engine.scenarios.edit('demo', SCENARIO, { hash: set.hash, edit: { kind: 'set_field', at: { entry: 'top' }, field: 'template', from: 'brand' } });
    expect(await view(engine.timeline.view({ project: 'demo', scenario: SCENARIO }))).toMatchObject({ theme: 'editorial', theme_sha256: before.theme_sha256 });
  });

  it('review B L4: a listed theme whose components do not resolve is offered disabled, with why (path-free)', async () => {
    const broken = join(root, 'templates', 'broken');
    await cp(join(root, 'templates', 'brand'), broken, { recursive: true });
    const tpl = join(broken, 'template.yaml');
    await writeFile(tpl, (await readFile(tpl, 'utf8')).replace('name: brand', 'name: broken').replace('intro: studio/intro-stack', 'intro: acme/missing-intro'));
    try {
      const v = await view(engine.timeline.view({ project: 'demo', scenario: SCENARIO }));
      const options = v.choices.video.find((c) => c.field === 'template')!.options;
      expect(options.find((o) => o.value === 'brand')!.usable).toBe(true);
      const bad = options.find((o) => o.value === 'broken')!;
      expect(bad.usable).toMatchObject({ why: expect.stringMatching(/^this theme cannot be used: .*acme\/missing-intro/) });
      expect(JSON.stringify(bad)).not.toContain(root);
    } finally {
      await rm(broken, { recursive: true, force: true });
    }
    // Gone again: the switch follows (the theme list is in the view's memo key).
    const after = await view(engine.timeline.view({ project: 'demo', scenario: SCENARIO }));
    expect(after.choices.video.find((c) => c.field === 'template')!.options.map((o) => o.value)).not.toContain('broken');
  });
});
