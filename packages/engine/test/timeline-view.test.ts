/**
 * L4.5 part A: the Studio timeline's view of a take (engine timeline-view.ts) on a synthetic project and on the
 * fixture's `quote` timeline:
 * - the tracks, the edit source (today's file re-planned on the run), the inspector's choices with every option usable
 *   or disabled with why (critique B7), whether the file takes switches now;
 * - ⚑ path-free and plan-free (critique B4): no absolute path, no `ds-asset:` map, no plan key; text the scenario wrote
 *   only under `untrusted`;
 * - a filmed change pending: switches disabled with why; a trust refusal: `blocked` with the command (no exception);
 * - the memo (critique B13): one planning per change — a second read, the event after a write, are memo hits — and
 *   the switch time measured (a write plus the view that follows, p95 over 10 switches; the fixture's quote cold and
 *   memoised);
 * - the capture's codec and keyframe spacing (critique B14), read from a descriptor without following a link;
 * - L4.5 fixes: an intro / outro with its own text is not switched (review B H2); a thread added is pinned in the next
 *   view (mutation M4); the plan and theme signatures, a thread of a render of this very version pinned at its own
 *   frame (review B M5); a theme file, a served file or project.yaml changed plans again (review B H3 / A N6); steps of
 *   a filmed change in 1-based words.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseYaml, stepGuard } from '@retake/core';
import { captureInfo, clearTimelineViewMemo, createEngine, planSignature } from '../src/index.js';
import type { Engine, TimelineViewResult } from '../src/index.js';
import { FIXTURES, synthTimeline } from '../../editor/test/helpers.js';
import { TEMPLATES, hasTool } from '../../editor/test/render-helpers.js';
import { fixtureWorkspace } from './helpers.js';

const canProbe = hasTool('ffmpeg') && hasTool('ffprobe');
const SCENARIO = 'tl';
const RUN = '20260101-120000-tl';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const TEXT = `video: Timeline
title: {text: Timeline}
intro: false
outro: false
scenes:
  - id: a
    page: app
    open: /
    caption: Every frame has its own colour.
    steps:
      - hold: 1
  - card: {slots: {title: Chapter two}}
    id: c1
  - id: b
    steps:
      - hold: 1
`;
let root: string;
let dir: string;
let engine: Engine;
const savedHome = process.env.RETAKE_HOME;
const scenarioFile = () => join(dir, 'scenarios', `${SCENARIO}.yaml`);
const view = async (r: Promise<TimelineViewResult>) => {
  const v = await r;
  if (!('view' in v)) throw new Error(`blocked: ${JSON.stringify(v.blocked)}`);
  return v;
};

/** A comment thread of the scenario (engine comments' file), made on render `render` at `frame`. */
async function writeThread(id: string, o: { render: string; created: string; frame: number; anchor: Record<string, unknown> }): Promise<void> {
  const d = join(dir, 'comments', SCENARIO);
  await mkdir(d, { recursive: true });
  await writeFile(
    join(d, `${id}.json`),
    JSON.stringify({
      version: 1, id, scenario: SCENARIO,
      render: { id: o.render, created_at: o.created, run_id: RUN, variant: 'landscape', fps: 30, frames: 300, width: 1920, height: 1080 },
      frame: o.frame, time_s: o.frame / 30, text: 'Look here', author: { via: 'cli', name: 'Reviewer' }, created_at: '2026-01-01T13:05:00.000Z', anchor: o.anchor, entries: [],
    }),
  );
}

function encode(file: string, gop?: number): void {
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30', '-t', '4', '-c:v', 'libx264', '-preset', 'veryfast', ...(gop ? ['-g', String(gop), '-bf', '0'] : []), '-pix_fmt', 'yuv420p', file]);
}

async function runJson(runDir: string, id: string, scenario: string): Promise<void> {
  await writeFile(
    join(runDir, 'run.json'),
    JSON.stringify({ version: 1, id, project: 'demo', scenario, mode: 'capture', status: 'succeeded', started_at: '2026-01-01T12:00:00.000Z', finished_at: '2026-01-01T12:01:00.000Z', dir: runDir, env: 'local', options: { hooks: 'run', headed: false }, steps_total: 2, steps_done: 2, screenshots: [], hooks: { setup: 'ok', teardown: 'ok' }, warnings: [] }),
  );
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'ds-timeline-view-'));
  process.env.RETAKE_HOME = join(root, '.home');
  await writeFile(join(root, 'retake.yaml'), `projects_dir: projects\ntemplates_dir: ${JSON.stringify(TEMPLATES)}\n`);
  dir = join(root, 'projects', 'demo');
  const runDir = join(dir, 'runs', RUN);
  await mkdir(runDir, { recursive: true });
  await mkdir(join(dir, 'scenarios'), { recursive: true });
  await writeFile(join(dir, 'project.yaml'), 'name: Demo\nenvironments:\n  local: {app: "http://app.test"}\ntemplate: editorial\n');
  const t = synthTimeline({
    duration: 4,
    entries: [
      { id: 'a', t_start: 0.5, t_end: 2, caption: { text: 'Every frame has its own colour.' }, steps: [{ action: 'hold', t_start: 0.5, t_end: 2 }] },
      { card: { id: 'c1', slots: { title: 'Chapter two' } } },
      { id: 'b', t_start: 2.5, t_end: 4, open_end: 2.6, steps: [{ action: 'hold', t_start: 2.6, t_end: 4 }] },
    ],
    video: { title: { text: 'Timeline' }, intro: false, outro: false, frame: 'card', template: 'editorial' },
  });
  t.run_id = RUN;
  t.project = 'demo';
  t.scenario = SCENARIO;
  await writeFile(join(runDir, 'timeline.json'), JSON.stringify(t));
  await writeFile(join(runDir, 'scenario.yaml'), TEXT);
  await runJson(runDir, RUN, SCENARIO);
  if (canProbe) encode(join(runDir, 'capture.mp4'));
  else await writeFile(join(runDir, 'capture.mp4'), 'no ffmpeg here');
  await writeFile(scenarioFile(), TEXT);
  engine = await createEngine({ root, client: 'ui', autoStartWorker: false });
}, 60_000);

afterAll(async () => {
  if (savedHome === undefined) delete process.env.RETAKE_HOME;
  else process.env.RETAKE_HOME = savedHome;
  await rm(root, { recursive: true, force: true });
});

describe('timeline view (L4.5)', () => {
  it('tracks, edit source and the inspector\'s choices, each option usable or disabled with why', async () => {
    clearTimelineViewMemo();
    const r = await view(engine.timeline.view({ project: 'demo', scenario: SCENARIO }));
    const { view: v, plan } = r;
    expect(v).toMatchObject({ project: 'demo', scenario: SCENARIO, run_id: RUN, theme: 'editorial', hash: sha(TEXT), editable: true, source: { edit: 'scenario', scenario_changed: false, edit_sha256: sha(TEXT) } });
    // Beside the view (part D): the file's text, what the Studio's undo restores.
    expect(r.text).toBe(TEXT);
    expect(v.model.segments.map((s) => [s.id, s.kind])).toEqual(plan.segments.map((s) => [s.id, s.kind]));
    expect(v.runs).toEqual([RUN]);
    expect(v.untrusted.captions.map((c) => c.text)).toEqual(['Every frame has its own colour.']);
    expect(v.untrusted.steps).toMatchObject({ 'a.0': expect.stringMatching(/hold/) });
    // The video's switches.
    const caption = v.choices.video.find((c) => c.field === 'caption_component')!;
    expect(caption).toMatchObject({ at: { entry: 'top' }, editable: true });
    expect(caption.current).toBeUndefined();
    expect(caption.options[0]).toEqual({ value: null, label: 'Theme default', usable: true });
    expect(caption.options.find((o) => o.value === 'studio/caption-overlay')?.usable).toBe(true);
    // A scene's layout: the frame styles by name, then the other layout components; a multi-page layout disabled.
    const frame = v.choices.segments.a.find((c) => c.field === 'frame')!;
    expect(frame.at).toEqual({ entry: 'scene', id: 'a', guard: stepGuard((parseYaml(TEXT).value as { scenes: unknown[] }).scenes[0]) });
    expect(frame.options.slice(0, 7).map((o) => o.label)).toEqual(['Theme default', 'Card', 'Browser', 'Laptop', 'Phone', 'Tablet', 'Full screen']);
    expect(frame.options.some((o) => o.value === 'studio/layout-laptop')).toBe(false);
    expect(v.choices.segments.a.find((c) => c.field === 'speed')!.range).toEqual({ min_exclusive: 0, max: 16 });
    // A card's component: one that drops its title is disabled with why.
    const card = v.choices.segments.c1.find((c) => c.field === 'card.component')!;
    expect(card.options.find((o) => o.value === 'studio/card-title')?.usable).toBe(true);
    expect(card.options.find((o) => o.value === 'studio/card-testimonial')?.usable).toEqual({ why: 'studio/card-testimonial does not show slots.title' });
    expect(v.pins).toEqual({ placed: [], elsewhere: [] });
    if (canProbe) expect(v.capture).toMatchObject({ codec: 'h264', b_frames: true, slow_scrub: expect.stringMatching(/scrubbing is slow on this take/) });
  });

  it('⚑ path-free and plan-free: no absolute path, no asset map, no plan; scenario text only under untrusted', async () => {
    const { view: v, plan, folders } = await view(engine.timeline.view({ project: 'demo', scenario: SCENARIO }));
    const json = JSON.stringify(v);
    for (const bad of [root, dir, folders.run, folders.theme, 'ds-asset:', '"plan"', '"assets"', '"file"', '/Users/', process.env.HOME ?? '/nonexistent']) expect(json, bad).not.toContain(bad);
    const { untrusted: _u, ...shape } = v;
    expect(JSON.stringify(shape)).not.toContain('Every frame has its own colour.');
    // The plan beside it (for the in-process player) is the plan a render would make.
    expect(plan.meta).toMatchObject({ run_id: RUN, scenario: SCENARIO });
  });

  it('memo (critique B13): a second read and the event after a write plan once; a switch shows in the next view; the switch time measured', async () => {
    clearTimelineViewMemo();
    const t0 = performance.now();
    const first = await view(engine.timeline.view({ project: 'demo', scenario: SCENARIO }));
    const cold = performance.now() - t0;
    expect(first.memo).toBeUndefined();
    const t1 = performance.now();
    const again = await view(engine.timeline.view({ project: 'demo', scenario: SCENARIO }));
    const hit = performance.now() - t1;
    expect(again.memo).toBe(true);
    expect(again.view.key).toBe(first.view.key);
    // A layout switch shows in the next view (a new file: planned again), and the view after it is a memo hit.
    const frame = first.view.choices.segments.a.find((c) => c.field === 'frame')!;
    const sw = await engine.scenarios.edit('demo', SCENARIO, { hash: first.view.hash!, edit: { kind: 'set_field', at: frame.at, field: 'frame', to: 'laptop' } });
    const switched = await view(engine.timeline.view({ project: 'demo', scenario: SCENARIO }));
    expect(switched.memo).toBeUndefined();
    expect(switched.view.model.segments.find((s) => s.id === 'a')!.component.id).toBe('studio/layout-laptop');
    expect((await view(engine.timeline.view({ project: 'demo', scenario: SCENARIO }))).memo).toBe(true);
    // Undo (restore) gives back a version the memo still holds: no planning at all.
    await engine.scenarios.edit('demo', SCENARIO, { hash: sw.hash, edit: { kind: 'restore', text: TEXT, text_hash: sha(TEXT) } });
    expect((await view(engine.timeline.view({ project: 'demo', scenario: SCENARIO }))).memo).toBe(true);
    // Ten switches, each to a new version (a speed): the write (scenario_edit) and the view the screen reads after it.
    const times: number[] = [];
    let hash = sha(TEXT);
    for (let i = 0; i < 10; i++) {
      const choice = (await view(engine.timeline.view({ project: 'demo', scenario: SCENARIO }))).view.choices.segments.a.find((c) => c.field === 'speed')!;
      const to = Math.round((1.1 + i * 0.1) * 10) / 10;
      const s0 = performance.now();
      const w = await engine.scenarios.edit('demo', SCENARIO, { hash, edit: { kind: 'set_field', at: choice.at, field: 'speed', ...(choice.current !== undefined ? { from: choice.current } : {}), to } });
      const after = await view(engine.timeline.view({ project: 'demo', scenario: SCENARIO }));
      times.push(performance.now() - s0);
      expect(after.memo).toBeUndefined();
      expect(after.view.hash).toBe(w.hash);
      expect(after.view.choices.segments.a.find((c) => c.field === 'speed')!.current).toBe(to);
      // The scenario event the write raises reads the same view again: a memo hit.
      expect((await view(engine.timeline.view({ project: 'demo', scenario: SCENARIO }))).memo).toBe(true);
      hash = w.hash;
    }
    const sorted = [...times].sort((a, b) => a - b);
    const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1];
    console.log(`timeline view: cold ${cold.toFixed(0)} ms, memo hit ${hit.toFixed(1)} ms; switch (write + view) median ${sorted[5].toFixed(0)} ms, p95 ${p95.toFixed(0)} ms`);
    expect(hit).toBeLessThan(50);
    expect(p95).toBeLessThan(1500);
    await writeFile(scenarioFile(), TEXT);
  });

  it('a filmed change pending: the take as captured, switches disabled with why', async () => {
    await writeFile(scenarioFile(), TEXT.replace('      - hold: 1\n  - card', '      - hold: 2\n  - card'));
    const r = await view(engine.timeline.view({ project: 'demo', scenario: SCENARIO }));
    const { view: v } = r;
    expect(v.source).toMatchObject({ edit: 'run', scenario_changed: true });
    // No switch: no text for undo either.
    expect(r.text).toBeUndefined();
    // Steps in a person's words, 1-based (review B: core's key a.0 is the first step).
    expect(v.editable).toEqual({ why: expect.stringMatching(/^The scenario's filmed part changed since this take \(scene a: step 1 changed\).*capture again/) });
    for (const c of [...v.choices.video, ...Object.values(v.choices.segments).flat()]) expect(c.editable).toEqual(v.editable);
    await writeFile(scenarioFile(), TEXT);
  });

  it('review B H2: an intro / outro with its own text is not switched from the timeline (disabled with why)', async () => {
    await writeFile(scenarioFile(), TEXT.replace('outro: false', 'outro: {tagline: Order in two clicks}'));
    const { view: v } = await view(engine.timeline.view({ project: 'demo', scenario: SCENARIO }));
    const outro = v.choices.segments.outro;
    expect(outro.find((c) => c.field === 'outro')).toMatchObject({ current: true, editable: { why: "the outro has its own tagline here: turn it off or back to the theme's in the YAML view (a switch would drop it)" } });
    // Its component and duration still switch (they keep the tagline).
    expect(outro.find((c) => c.field === 'outro.component')?.editable).toBe(true);
    await writeFile(scenarioFile(), TEXT);
  });

  it('review B M4 / mutation M4: a thread added after a view is pinned in the next one (the comments folder is in the key)', async () => {
    clearTimelineViewMemo();
    const before = await view(engine.timeline.view({ project: 'demo', scenario: SCENARIO }));
    expect(before.view.pins).toEqual({ placed: [], elsewhere: [] });
    await writeThread('c_01JAAAAAAAAAAAAAAAAAAAAAAA', { render: 'tl-v1', created: '2026-01-01T13:00:00.000Z', frame: 10, anchor: { segment: 'a', kind: 'clip', scene: 'a', step: 0 } });
    const after = await view(engine.timeline.view({ project: 'demo', scenario: SCENARIO }));
    expect(after.memo).toBeUndefined();
    expect(after.view.pins.placed.map((p) => [p.id, p.by])).toEqual([['c_01JAAAAAAAAAAAAAAAAAAAAAAA', 'step']]);
    await rm(join(dir, 'comments'), { recursive: true, force: true });
  });

  it('review B M5 / H1: plan and theme signatures; a thread made on a render of this very version is pinned at its own frame', async () => {
    clearTimelineViewMemo();
    const r = await view(engine.timeline.view({ project: 'demo', scenario: SCENARIO }));
    expect(r.view.plan_sha256).toBe(planSignature(r.plan));
    expect(r.view.theme_sha256).toMatch(/^[0-9a-f]{16}$/);
    // The notes and warnings are not the plan's signature (a render adds its own).
    expect(planSignature({ ...JSON.parse(JSON.stringify(r.plan)), notes: ['another'], warnings: [] })).toBe(r.view.plan_sha256);
    const step = r.view.model.steps.find((x) => x.key === 'a.0')!;
    const frame = step.from + 5;
    const record = async (plan: unknown, theme: string) => {
      await mkdir(join(dir, 'renders'), { recursive: true });
      await writeFile(join(dir, 'renders', 'tl-v1.json'), JSON.stringify({ version: 1, id: 'tl-v1', created_at: '2026-01-01T13:00:00.000Z', template_sha256: theme, plan }));
    };
    await record(JSON.parse(JSON.stringify(r.plan)), r.view.theme_sha256);
    await writeThread('c_01JBBBBBBBBBBBBBBBBBBBBBBB', { render: 'tl-v1', created: '2026-01-01T13:00:00.000Z', frame, anchor: { segment: 'a', kind: 'clip', scene: 'a', step: 0 } });
    const same = await view(engine.timeline.view({ project: 'demo', scenario: SCENARIO }));
    expect(same.view.pins.placed).toEqual([{ id: 'c_01JBBBBBBBBBBBBBBBBBBBBBBB', status: 'open', frame, by: 'frame' }]);
    // A render of another plan (other options), or of other theme files: the step's first frame, not its frame.
    for (const [plan, theme] of [[{ ...JSON.parse(JSON.stringify(r.plan)), fps: 25 }, r.view.theme_sha256], [JSON.parse(JSON.stringify(r.plan)), '0123456789abcdef']] as const) {
      clearTimelineViewMemo();
      await record(plan, theme);
      const other = await view(engine.timeline.view({ project: 'demo', scenario: SCENARIO }));
      expect(other.view.pins.placed).toEqual([{ id: 'c_01JBBBBBBBBBBBBBBBBBBBBBBB', status: 'open', frame: step.from, by: 'step' }]);
    }
    await rm(join(dir, 'comments'), { recursive: true, force: true });
    await rm(join(dir, 'renders'), { recursive: true, force: true });
  });

  it('review B H3 / A N6: a theme file, a served file or project.yaml changed since a view plans again', async () => {
    // A project with its own theme folder (a copy: the repository's templates are never touched).
    const own = join(root, 'projects', 'own');
    await mkdir(join(own, 'scenarios'), { recursive: true });
    await cp(join(TEMPLATES, 'editorial'), join(own, 'template'), { recursive: true });
    await writeFile(join(own, 'project.yaml'), 'name: Own\nenvironments:\n  local: {app: "http://app.test"}\ntemplate: ./template\n');
    await cp(join(dir, 'runs'), join(own, 'runs'), { recursive: true });
    const t = JSON.parse(readFileSync(join(own, 'runs', RUN, 'timeline.json'), 'utf8')) as { project: string; video: { template: string } };
    t.project = 'own';
    t.video.template = './template';
    await writeFile(join(own, 'runs', RUN, 'timeline.json'), JSON.stringify(t));
    await writeFile(join(own, 'scenarios', `${SCENARIO}.yaml`), TEXT);
    clearTimelineViewMemo();
    const read = () => view(engine.timeline.view({ project: 'own', scenario: SCENARIO }));
    const a = await read();
    expect((await read()).memo).toBe(true);
    // template.yaml: a colour of the theme (in the plan) — planned again, another plan signature.
    const yaml = join(own, 'template', 'template.yaml');
    await writeFile(yaml, readFileSync(yaml, 'utf8').replace('accent: "#8a2332"', 'accent: "#225588"'));
    const b = await read();
    expect(b.memo).toBeUndefined();
    expect(b.view.plan_sha256).not.toBe(a.view.plan_sha256);
    expect(b.view.theme_sha256).not.toBe(a.view.theme_sha256);
    expect((await read()).memo).toBe(true);
    // The logo's bytes (a file the plan serves, not in its JSON): planned again, the same plan, other theme files.
    await writeFile(join(own, 'template', 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12"/>');
    const c = await read();
    expect(c.memo).toBeUndefined();
    expect(c.view.plan_sha256).toBe(b.view.plan_sha256);
    expect(c.view.theme_sha256).not.toBe(b.view.theme_sha256);
    // project.yaml (its key): planned again.
    await writeFile(join(own, 'project.yaml'), 'name: Own\nenvironments:\n  local: {app: "http://app.test"}\ntemplate: ./template\n# edited\n');
    expect((await read()).memo).toBeUndefined();
    await rm(own, { recursive: true, force: true });
  });

  it('a trust refusal is `blocked` with the command a person types (no exception, no plan)', async () => {
    await writeFile(scenarioFile(), TEXT.replace('{slots: {title: Chapter two}}', '{slots: {title: Chapter two, kicker: "https://example.com/tracker.png"}}'));
    const r = await engine.timeline.view({ project: 'demo', scenario: SCENARIO });
    expect(r).not.toHaveProperty('view');
    expect(r).not.toHaveProperty('plan');
    expect(r).toMatchObject({ blocked: { problems: [expect.stringMatching(/kicker: https:\/\/example\.com\/tracker\.png is a remote URL/)], command: expect.stringMatching(/ render demo tl/) } });
    await writeFile(scenarioFile(), TEXT);
  });
});

describe('timeline view of the fixture\'s quote (critique B13: measured)', () => {
  it('plans the real take\'s timeline cold, then from the memo', async () => {
    const ws = await mkdtemp(join(tmpdir(), 'ds-timeline-quote-'));
    try {
      await fixtureWorkspace(ws);
      const p = join(ws, 'projects', 'northfield-fixture');
      const id = '20261020-100000-quote';
      const runDir = join(p, 'runs', id);
      await mkdir(runDir, { recursive: true });
      const tl = JSON.parse(readFileSync(join(FIXTURES, 'quote.timeline.json'), 'utf8'));
      tl.run_id = id;
      await writeFile(join(runDir, 'timeline.json'), JSON.stringify(tl));
      await writeFile(join(runDir, 'scenario.yaml'), readFileSync(join(p, 'scenarios', 'quote.yaml')));
      await writeFile(join(runDir, 'capture.mp4'), 'not read');
      await writeFile(join(runDir, 'run.json'), JSON.stringify({ version: 1, id, project: 'northfield-fixture', scenario: 'quote', mode: 'capture', status: 'succeeded', started_at: '2026-10-20T08:00:00.000Z', dir: runDir, env: 'local', options: {}, steps_total: 1, steps_done: 1, screenshots: [], hooks: {}, warnings: [] }));
      const e = await createEngine({ root: ws, client: 'ui', autoStartWorker: false });
      clearTimelineViewMemo();
      const t0 = performance.now();
      const cold = await view(e.timeline.view({ project: 'northfield-fixture', scenario: 'quote' }));
      const coldMs = performance.now() - t0;
      const t1 = performance.now();
      expect((await view(e.timeline.view({ project: 'northfield-fixture', scenario: 'quote' }))).memo).toBe(true);
      const hitMs = performance.now() - t1;
      console.log(`quote timeline view: cold ${coldMs.toFixed(0)} ms (planning ${cold.view.ms.planning} ms), memo ${hitMs.toFixed(1)} ms, ${cold.view.model.segments.length} segments, view ${JSON.stringify(cold.view).length} B, plan ${JSON.stringify(cold.plan).length} B`);
      expect(cold.view.model.steps.length).toBeGreaterThan(20);
      expect(Object.keys(cold.view.choices.segments)).toEqual(expect.arrayContaining(['discover', 'request', 'chapter-request']));
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('timeline view of a 4-minute take (critique B13: measured)', () => {
  it('8 scenes of 30 s, 96 steps: planned cold, then each switch re-planned once', async () => {
    const id = '20260101-130000-long';
    const runDir = join(dir, 'runs', id);
    await mkdir(runDir, { recursive: true });
    const entries = Array.from({ length: 8 }, (_, k) => ({
      id: `s${k}`,
      t_start: k * 30,
      t_end: k * 30 + 30,
      open_end: k * 30 + 0.5,
      still: [k * 30 + 0.5, k * 30 + 2] as [number, number],
      caption: { text: `Scene ${k}` },
      steps: Array.from({ length: 12 }, (_, i) => ({ action: 'click' as const, t_start: k * 30 + 2 + i * 2.2, t_end: k * 30 + 3 + i * 2.2 })),
    }));
    const t = synthTimeline({ entries, duration: 240, video: { title: { text: 'Long' }, intro: false, outro: false, frame: 'card', template: 'editorial' } });
    Object.assign(t, { run_id: id, project: 'demo', scenario: 'long' });
    await writeFile(join(runDir, 'timeline.json'), JSON.stringify(t));
    const text = `video: Long\ntitle: {text: Long}\nintro: false\noutro: false\nscenes:\n${entries.map((e, k) => `  - id: s${k}\n    page: app\n    open: /s${k}\n    caption: Scene ${k}\n    steps:\n${e.steps.map((_, i) => `      - click: Button ${i}\n`).join('')}`).join('')}`;
    await writeFile(join(runDir, 'scenario.yaml'), text);
    await writeFile(join(runDir, 'capture.mp4'), 'not read');
    await runJson(runDir, id, 'long');
    await writeFile(join(dir, 'scenarios', 'long.yaml'), text);
    clearTimelineViewMemo();
    const t0 = performance.now();
    const cold = await view(engine.timeline.view({ project: 'demo', scenario: 'long' }));
    const coldMs = performance.now() - t0;
    expect(cold.view.source.edit).toBe('scenario');
    expect(cold.view.model.steps.filter((x) => x.step >= 0)).toHaveLength(96);
    const times: number[] = [];
    let hash = cold.view.hash!;
    for (let i = 0; i < 5; i++) {
      const choice = (await view(engine.timeline.view({ project: 'demo', scenario: 'long' }))).view.choices.segments.s3.find((c) => c.field === 'speed')!;
      const s0 = performance.now();
      const w = await engine.scenarios.edit('demo', 'long', { hash, edit: { kind: 'set_field', at: choice.at, field: 'speed', ...(choice.current !== undefined ? { from: choice.current } : {}), to: 1.2 + i * 0.2 } });
      expect((await view(engine.timeline.view({ project: 'demo', scenario: 'long' }))).memo).toBeUndefined();
      times.push(performance.now() - s0);
      hash = w.hash;
    }
    const sorted = [...times].sort((a, b) => a - b);
    console.log(`4-minute timeline view: cold ${coldMs.toFixed(0)} ms (planning ${cold.view.ms.planning} ms), ${cold.plan.durationInFrames} frames, view ${JSON.stringify(cold.view).length} B, plan ${JSON.stringify(cold.plan).length} B; switch median ${sorted[2].toFixed(0)} ms, max ${sorted[4].toFixed(0)} ms`);
    expect(sorted[4]).toBeLessThan(3000);
  }, 60_000);
});

describe.skipIf(!canProbe)('the capture\'s codec and keyframes (critique B14)', () => {
  it('libx264 defaults: keyframes seconds apart, B-frames (slow scrub); a 12-frame GOP: fast; a link is not followed', async () => {
    const d = await mkdtemp(join(tmpdir(), 'ds-gop-'));
    try {
      encode(join(d, 'long.mp4'));
      encode(join(d, 'short.mp4'), 12);
      const long = await captureInfo(join(d, 'long.mp4'));
      expect(long).toMatchObject({ codec: 'h264', b_frames: true, at_least: true, slow_scrub: expect.stringMatching(/keyframes at least every \d\.\d s/) });
      expect(long.keyframe_interval_s).toBeGreaterThan(3.5);
      const short = await captureInfo(join(d, 'short.mp4'));
      expect(short).toEqual({ codec: 'h264', b_frames: false, keyframe_interval_s: 0.4 });
      await symlink(join(d, 'short.mp4'), join(d, 'link.mp4'));
      expect(await captureInfo(join(d, 'link.mp4'))).toEqual({});
      expect(await captureInfo(join(d, 'missing.mp4'))).toEqual({});
    } finally {
      await rm(d, { recursive: true, force: true });
    }
  });
});
