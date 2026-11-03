/**
 * L4.6 part A2 (T8): the timeline's preview of a proposal (engine timeline.view with `proposal`, critique B9). The take
 * is planned from the proposed text in memory, on the commented run: ⚑ the view shows the proposed caption, writes
 * nothing (file bytes and mtime unchanged) and ⚑ never makes the proposed text a version the Studio may restore (no
 * `text` beside the view; `restore` of it refused); ⚑ the Studio's full write checks run on every preview (a planted
 * proposal changing `setup:` is refused); the state is checked on every call (applied, superseded, stale refused); the
 * memo keeps the file's view and the proposal's apart; the plan carries the workspace components the proposal uses
 * (what the Studio's preview hold reads: part C's ops).
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { diffLines, textLines } from '@retake/core';
import { scaffoldDir } from '@retake/components';
import { usedComponentIds } from '@retake/editor';
import { EngineError, clearTimelineViewMemo, createEngine, knownScenarioVersion } from '../src/index.js';
import type { Engine, TimelineViewResult } from '../src/index.js';
import { synthTimeline } from '../../editor/test/helpers.js';
import { TEMPLATES, hasTool } from '../../editor/test/render-helpers.js';

const canEncode = hasTool('ffmpeg');
const SCENARIO = 'tl';
const RUN = '20261027-100000-tl';
const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
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
const PROPOSED = TEXT.replace('Every frame has its own colour.', 'Each frame shows its colour.');
const HOOKED = 'video: H\nsetup:\n  - http: {method: POST, url: "{{app}}/reset"}\nscenes:\n  - id: a\n    page: app\n    open: /\n    steps:\n      - hold: 1\n';

let root: string;
let dir: string;
let ui: Engine;
let mcp: Engine;
const savedHome = process.env.RETAKE_HOME;
let n = 0;
const scenarioFile = (name = SCENARIO) => join(dir, 'scenarios', `${name}.yaml`);

const view = async (r: Promise<TimelineViewResult>) => {
  const v = await r;
  if (!('view' in v)) throw new Error(`blocked: ${JSON.stringify(v.blocked)}`);
  return v;
};

async function failure(p: Promise<unknown>): Promise<EngineError> {
  const e = await p.then(() => undefined, (x: unknown) => x);
  expect(e).toBeInstanceOf(EngineError);
  return e as EngineError;
}

/** An open thread on scenario `scenario` made on a render of the commented run (by hand), with optional entries. */
async function thread(scenario = SCENARIO, entries: unknown[] = []): Promise<string> {
  const id = `c_01JQ2000000000000000000${String(++n).padStart(3, '0')}`;
  await mkdir(join(dir, 'comments', scenario), { recursive: true });
  await writeFile(
    join(dir, 'comments', scenario, `${id}.json`),
    JSON.stringify({
      version: 1, id, scenario,
      render: { id: `${scenario}-v1`, created_at: '2026-10-27T10:01:00.000Z', run_id: RUN, variant: 'landscape', fps: 30, frames: 120, width: 1920, height: 1080 },
      frame: 20, time_s: 0.667, text: 'Shorter caption, please.', author: { via: 'studio', name: 'Reviewer' }, created_at: '2026-10-27T10:05:00.000Z',
      anchor: { segment: 'a', kind: 'clip', scene: 'a', step: 0, area: 'caption' }, entries,
    }),
  );
  return id;
}

async function propose(id: string, yaml: string, base = TEXT): Promise<{ entry: string; hash: string }> {
  const w = await mcp.comments.reply('demo', id, 'A shorter caption.', { proposal: { scenario_yaml: yaml, scenario_hash: sha(base) } });
  return { entry: w.entry, hash: w.hash };
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'ds-timeline-proposal-'));
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
  await writeFile(
    join(runDir, 'run.json'),
    JSON.stringify({ version: 1, id: RUN, project: 'demo', scenario: SCENARIO, mode: 'capture', status: 'succeeded', started_at: '2026-10-27T10:00:00.000Z', finished_at: '2026-10-27T10:01:00.000Z', dir: runDir, env: 'local', options: { hooks: 'run', headed: false }, steps_total: 2, steps_done: 2, screenshots: [], hooks: { setup: 'ok', teardown: 'ok' }, warnings: [] }),
  );
  if (canEncode) execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30', '-t', '4', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', join(runDir, 'capture.mp4')]);
  else await writeFile(join(runDir, 'capture.mp4'), 'no ffmpeg here');
  await writeFile(scenarioFile(), TEXT);
  // A workspace component (agent-writable code: the Studio's preview holds it until the person allows it).
  const comp = join(root, 'components', 'acme', 'marked');
  await mkdir(comp, { recursive: true });
  await cp(scaffoldDir('card'), comp, { recursive: true });
  await writeFile(join(comp, 'component.yaml'), (await readFile(join(comp, 'component.yaml'), 'utf8')).replace(/^id: .*$/m, 'id: acme/marked'));
  ui = await createEngine({ root, client: 'ui', autoStartWorker: false });
  mcp = await createEngine({ root, client: 'mcp', autoStartWorker: false });
}, 60_000);

afterAll(async () => {
  if (savedHome === undefined) delete process.env.RETAKE_HOME;
  else process.env.RETAKE_HOME = savedHome;
  await rm(root, { recursive: true, force: true });
});

describe('the timeline previews a proposal (T8, critique B9)', () => {
  it('⚑ plans the proposed caption on the commented take, writes nothing and ⚑ never makes the proposed text a restorable version; the memo keeps the two views apart', async () => {
    clearTimelineViewMemo();
    await writeFile(scenarioFile(), TEXT);
    const id = await thread();
    const p = await propose(id, PROPOSED);
    const before = [await readFile(scenarioFile()), (await stat(scenarioFile())).mtimeMs];
    const r = await view(ui.timeline.view({ project: 'demo', scenario: SCENARIO, proposal: { comment_id: id, entry_id: p.entry } }));
    expect(r.view.untrusted.captions.map((c) => c.text)).toEqual(['Each frame shows its colour.']);
    expect(r.view).toMatchObject({
      run_id: RUN,
      hash: sha(TEXT),
      editable: { why: 'Previewing a proposal: apply it to edit' },
      source: { edit: 'scenario', edit_sha256: sha(PROPOSED) },
      proposal: { comment_id: id, entry_id: p.entry, result_sha256: sha(PROPOSED), shown: true },
    });
    expect(r.text).toBeUndefined();
    expect([await readFile(scenarioFile()), (await stat(scenarioFile())).mtimeMs]).toEqual(before);
    // Never a version `restore` accepts (critique B9 b): restore writes any remembered version and skips the hidden-character check.
    expect(knownScenarioVersion(scenarioFile(), sha(PROPOSED))).toBe(false);
    const restore = await failure(ui.scenarios.edit('demo', SCENARIO, { hash: sha(TEXT), edit: { kind: 'restore', text: PROPOSED, text_hash: sha(PROPOSED) } }));
    expect(restore).toMatchObject({ code: 'refused', message: expect.stringMatching(/not a version of scenarios\/tl.yaml the Studio showed or wrote/) });
    expect(await readFile(scenarioFile())).toEqual(before[0]);
    // The file's own view: today's caption, switches on, its text for undo — and the proposal's view again from the memo.
    const file = await view(ui.timeline.view({ project: 'demo', scenario: SCENARIO }));
    expect(file.view.untrusted.captions.map((c) => c.text)).toEqual(['Every frame has its own colour.']);
    expect(file.view.proposal).toBeUndefined();
    expect(file.view.editable).toBe(true);
    expect(file.text).toBe(TEXT);
    const again = await view(ui.timeline.view({ project: 'demo', scenario: SCENARIO, proposal: { comment_id: id, entry_id: p.entry } }));
    expect(again.memo).toBe(true);
    expect(again.view.untrusted.captions.map((c) => c.text)).toEqual(['Each frame shows its colour.']);
    // Another run than the commented one: refused.
    expect(await failure(ui.timeline.view({ project: 'demo', scenario: SCENARIO, run_id: '20200101-000000-tl', proposal: { comment_id: id, entry_id: p.entry } }))).toMatchObject({ code: 'invalid', details: { argument: 'run_id' } });
  }, 120_000);

  it('⚑ the Studio\'s full write checks run on every preview: a planted proposal changing setup: is refused, nothing planned', async () => {
    await writeFile(scenarioFile('hooked'), HOOKED);
    const result = HOOKED.replace('/reset', '/wipe');
    const planted = {
      id: 'r_01JQ2000000000000000000PR1', kind: 'reply', author: { via: 'mcp', name: 'agent' }, text: 'Proposed.', created_at: '2026-10-27T10:06:00.000Z',
      proposal: { base_sha256: sha(HOOKED), result_sha256: sha(result), eol: 'lf', delta: 'edit', hunks: diffLines(textLines(HOOKED), textLines(result)) },
    };
    const id = await thread('hooked', [planted]);
    const e = await failure(ui.timeline.view({ project: 'demo', scenario: 'hooked', proposal: { comment_id: id, entry_id: planted.id } }));
    expect(e).toMatchObject({ code: 'refused', details: { sections: ['setup'] } });
    expect(e.message).toMatch(/^not previewed: setup changed: hooks and mocks run on this Mac/);
  });

  it('the state is checked on every call: an applied, a superseded or a stale proposal is refused; a thread of another scenario too', async () => {
    clearTimelineViewMemo();
    await writeFile(scenarioFile(), TEXT);
    const id = await thread();
    const first = await propose(id, PROPOSED);
    const second = await propose(id, TEXT.replace('Every frame has its own colour.', 'Colour in every frame.'));
    expect(await failure(ui.timeline.view({ project: 'demo', scenario: SCENARIO, proposal: { comment_id: id, entry_id: first.entry } }))).toMatchObject({ code: 'conflict', details: { state: 'superseded' } });
    await view(ui.timeline.view({ project: 'demo', scenario: SCENARIO, proposal: { comment_id: id, entry_id: second.entry } }));
    const applied = await ui.comments.apply('demo', id, { entry_id: second.entry, if_match: second.hash });
    expect(await failure(ui.timeline.view({ project: 'demo', scenario: SCENARIO, proposal: { comment_id: id, entry_id: second.entry } }))).toMatchObject({ code: 'conflict', details: { state: 'applied' } });
    // Undone, then the file moves on: stale.
    await ui.scenarios.edit('demo', SCENARIO, { hash: applied.scenario.hash, edit: { kind: 'restore', text: applied.scenario.previous.text, text_hash: applied.scenario.previous.hash } });
    await view(ui.timeline.view({ project: 'demo', scenario: SCENARIO, proposal: { comment_id: id, entry_id: second.entry } }));
    await writeFile(scenarioFile(), TEXT.replace('title: {text: Timeline}', 'title: {text: Timeline two}'));
    expect(await failure(ui.timeline.view({ project: 'demo', scenario: SCENARIO, proposal: { comment_id: id, entry_id: second.entry } }))).toMatchObject({ code: 'conflict', details: { state: 'stale' } });
    await writeFile(scenarioFile(), TEXT);
    expect(await failure(ui.timeline.view({ project: 'demo', scenario: 'hooked', proposal: { comment_id: id, entry_id: second.entry } }))).toMatchObject({ code: 'invalid', details: { argument: 'proposal' } });
    expect(await failure(ui.timeline.view({ project: 'demo', scenario: SCENARIO, proposal: { comment_id: '../x', entry_id: second.entry } }))).toMatchObject({ code: 'invalid', details: { argument: 'proposal' } });
  }, 120_000);

  it('the plan carries the workspace components the proposal uses: what the Studio\'s preview hold reads (part C)', async () => {
    clearTimelineViewMemo();
    await writeFile(scenarioFile(), TEXT);
    const id = await thread();
    const p = await propose(id, TEXT.replace('{slots: {title: Chapter two}}', '{component: acme/marked, slots: {title: Chapter two}}'));
    const r = await view(ui.timeline.view({ project: 'demo', scenario: SCENARIO, proposal: { comment_id: id, entry_id: p.entry } }));
    expect(usedComponentIds(r.plan)).toContain('acme/marked');
    const file = await view(ui.timeline.view({ project: 'demo', scenario: SCENARIO }));
    expect(usedComponentIds(file.plan)).not.toContain('acme/marked');
  }, 120_000);
});
