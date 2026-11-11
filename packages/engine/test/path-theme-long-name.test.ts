/**
 * A theme a project names by a path, in a folder whose name is longer than a theme's name (L7.5). The id module has
 * one rule for the name of a theme that exists (at most 100 characters) and one for a new theme's (60). A folder a
 * project.yaml points at may be named otherwise: the theme still loads, plans and renders, and everything that reads
 * its renders by their id keeps working (the render list, prune, comments). Its name is then read nowhere: a render's
 * `theme` says unknown and the project board compares no theme. Naming it in a request stays refused, where a theme
 * is named: a render's `template`, a copy's `from`.
 *
 * A temp workspace; hand-made take and records; nothing is rendered, no browser is opened, no job runs.
 */
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LoadedProject } from '@retake/core';
import { PERSON_POLICY, isThemeName } from '@retake/core';
import { STARTER_TEMPLATES_DIR, fileFacts, loadProject, loadProjectTemplate } from '@retake/core/io';
import type { RenderRecord } from '@retake/editor';
import { EngineError, addComment, createEngine, listComments, pruneProject, packageReviewer } from '../src/index.js';
import type { Engine } from '../src/index.js';
import { checkRenderRequest } from '../src/jobs/render-job.js';
import { makeCase, scenesTimeline, workspace } from '../../review/test/helpers.js';
import type { Case, Workspace } from '../../review/test/helpers.js';
import { authorScope } from './helpers.js';

/** The product's frames (the review package's): the stills and frames these tests check are real. */
const FRAMES = packageReviewer().frames;

const LONG = 't'.repeat(120);
const SCENARIO_YAML = 'video: quote\nscenes:\n  - id: one\n    open: /\n    steps:\n      - click: First\n';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const short = (s: string) => s.replace(/(.)\1{30,}/g, (m, ch: string) => `<${m.length} ${ch}>`);

let ws: Workspace;
let engine: Engine;
let project: LoadedProject;
let demo: Case;
const savedHome = process.env.RETAKE_HOME;

async function outcome(p: Promise<unknown> | (() => unknown)): Promise<string> {
  try {
    await (typeof p === 'function' ? p() : p);
    return 'ok';
  } catch (e) {
    return e instanceof EngineError ? `${e.code}: ${e.message}` : `${(e as Error).name}: ${(e as Error).message}`;
  }
}

/** renders/<id>.json and its (empty) video: the case's record under another id, theme and date. */
async function record(id: string, template: string, created_at: string): Promise<void> {
  const dir = join(project.dir, 'renders');
  const r = { ...demo.record, id, template, created_at, overrides: {}, edit: { from: 'scenario', sha256: sha(SCENARIO_YAML) }, file: join(dir, `${id}.mp4`), record: join(dir, `${id}.json`) } as unknown as RenderRecord;
  await writeFile(join(dir, `${id}.mp4`), '');
  await writeFile(join(dir, `${id}.json`), JSON.stringify(r));
}

beforeAll(async () => {
  ws = await workspace();
  process.env.RETAKE_HOME = join(ws.root, '.home');
  const dir = ws.project.dir;
  // The theme: a copy of a starter in a folder of the project, named by its path in project.yaml.
  await mkdir(join(dir, 'themes'), { recursive: true });
  await cp(join(STARTER_TEMPLATES_DIR, 'editorial'), join(dir, 'themes', LONG), { recursive: true });
  await writeFile(join(dir, 'project.yaml'), `name: Demo\nenvironments:\n  local: {app: "http://app.test"}\ntemplate: ./themes/${LONG}\n`);
  await mkdir(join(dir, 'scenarios'), { recursive: true });
  await writeFile(join(dir, 'scenarios', 'quote.yaml'), SCENARIO_YAML);
  // A take with its timeline (the case's), finished as a capture; its renders are written below.
  // (The take names no theme of its own: a plan of it uses the project's.)
  const timeline = scenesTimeline([5, 5]);
  if (timeline.video) delete timeline.video.template;
  demo = await makeCase(ws, 'quote', timeline, { noVideo: true });
  await writeFile(
    join(demo.run.dir, 'run.json'),
    JSON.stringify({ version: 1, id: demo.run.id, project: 'demo', scenario: 'quote', mode: 'capture', status: 'succeeded', started_at: '2026-01-01T12:00:00.000Z', finished_at: '2026-01-01T12:01:00.000Z', dir: demo.run.dir, env: 'local', options: { hooks: 'run', headed: false }, steps_total: 1, steps_done: 1, screenshots: [], hooks: { setup: 'none', teardown: 'none' }, warnings: [] }),
  );
  await writeFile(join(demo.run.dir, 'scenario.yaml'), SCENARIO_YAML);
  project = await loadProject('demo', ws.root);
  // quote-v1: today's theme. quote-v2, newer: the same file and take rendered with another theme.
  await record('quote-v1', LONG, '2026-10-20T11:00:00.000Z');
  await record('quote-v2', 'editorial', '2026-10-20T12:00:00.000Z');
  engine = await createEngine({ root: ws.root, client: 'test', autoStartWorker: false });
}, 120_000);

afterAll(async () => {
  if (savedHome === undefined) delete process.env.RETAKE_HOME;
  else process.env.RETAKE_HOME = savedHome;
  await ws?.cleanup();
});

describe('a theme named by a path whose folder name is longer than a theme\'s name', () => {
  it('its folder\'s name is no theme name: one rule for a theme that exists, a listed one or a folder alike', () => {
    expect([isThemeName(LONG), isThemeName('t'.repeat(100)), isThemeName('t'.repeat(101)), isThemeName('a.b'), isThemeName('../x'), isThemeName('')]).toEqual([false, true, false, false, false, false]);
  });

  it('loads, and a plan of its project is made with it', async () => {
    expect((await loadProjectTemplate(project, undefined, { files: fileFacts(PERSON_POLICY) })).name).toBe(LONG);
    const plan = await engine.renders.plan({ project: 'demo', scenario: 'quote', run_id: demo.run.id });
    expect([short(plan.theme), plan.next_render_id]).toEqual(['<120 t>', 'quote-v3']);
  });

  it('its renders are listed by their id; their theme says unknown', async () => {
    const list = (await engine.renders.ofScenario('demo', 'quote')).renders.map((r) => [r.render_id, short(r.theme)]);
    expect(list.sort()).toEqual([['quote-v1', 'unknown'], ['quote-v2', 'editorial']]);
  });

  // L7.8 (changed, BL-164): the board compares the theme by its identity. Before, it named no theme and compared none:
  // the row held quote-v2, the newer render made with another theme, as if it showed today's file.
  it('the board names no theme for it, but compares it by its identity: the row holds the render of today\'s file, take and theme', async () => {
    const s = (await engine.projects.board('demo')).scenarios.find((x) => x.name === 'quote');
    expect(s?.capture?.id).toBe(demo.run.id);
    expect(s?.hash).toBe(sha(SCENARIO_YAML));
    expect([s?.render?.render_id, s?.render_current, short(s?.theme ?? '(none)'), short(s?.render?.theme ?? '')]).toEqual(['quote-v1', true, '(none)', 'unknown']);
  });

  it('with no render of today\'s theme, the row holds the newest render and says it does not show today\'s file (BL-164)', async () => {
    const dir = join(project.dir, 'renders');
    const v1 = await readFile(join(dir, 'quote-v1.json'), 'utf8');
    await rm(join(dir, 'quote-v1.json'));
    await rm(join(dir, 'quote-v1.mp4'));
    try {
      const s = (await engine.projects.board('demo')).scenarios.find((x) => x.name === 'quote');
      expect([s?.render?.render_id, s?.render_current, short(s?.render?.theme ?? '')]).toEqual(['quote-v2', false, 'editorial']);
    } finally {
      await writeFile(join(dir, 'quote-v1.json'), v1);
      await writeFile(join(dir, 'quote-v1.mp4'), '');
    }
  });

  it('a reference over 200 characters is compared by its identity too (BL-164)', async () => {
    const yaml = join(project.dir, 'project.yaml');
    const before = await readFile(yaml, 'utf8');
    const ref = `./${'themes/../'.repeat(20)}themes/${LONG}`;
    expect(ref.length).toBeGreaterThan(200);
    await writeFile(yaml, before.replace(`template: ./themes/${LONG}`, `template: ${ref}`));
    try {
      const s = (await engine.projects.board('demo')).scenarios.find((x) => x.name === 'quote');
      expect([s?.render?.render_id, s?.render_current, s?.theme]).toEqual(['quote-v1', true, undefined]);
    } finally {
      await writeFile(yaml, before);
    }
  });

  it('prune counts its renders as any other\'s: the older one beyond what is kept can go, with its files only', async () => {
    const r = await pruneProject(project, { keep_renders: 1 });
    expect(r.items.map((i) => [i.kind, i.id, i.reason, i.paths.map((p) => p.slice(project.dir.length + 1)).sort()])).toEqual([['render', 'quote-v1', 'older render', ['renders/quote-v1.json', 'renders/quote-v1.mp4']]]);
    expect((await pruneProject(project)).items).toEqual([]);
    expect(r.threads_unread).toBeUndefined();
  });

  it('a comment is made on its render, listed, and keeps that render from prune', async () => {
    expect(await outcome(addComment(project, { render: 'quote-v1', frame: 10, text: 'A comment' }, { via: 'cli', name: 'Reviewer' }, authorScope(project, { via: 'cli', name: 'Reviewer' }), PERSON_POLICY, FRAMES))).toBe('ok');
    const list = await listComments(project, { status: 'all' });
    expect([list.threads.map((t) => [t.render_id, t.render_present]), list.problems]).toEqual([[['quote-v1', true]], []]);
    expect((await pruneProject(project, { keep_renders: 1 })).items).toEqual([]);
    await rm(join(project.dir, 'comments'), { recursive: true, force: true });
  });

  it('a request names a theme by its name: a render\'s template and a copy\'s source of that length are refused, and nothing is written', async () => {
    expect(await outcome(() => checkRenderRequest({ project: 'demo', scenario: 'quote' }))).toBe('ok');
    expect(short(await outcome(() => checkRenderRequest({ project: 'demo', scenario: 'quote', template: LONG })))).toBe('invalid: invalid theme "<120 t>": a theme name (template_list names them), never a path');
    const before = (await readdir(project.dir)).sort();
    expect(short(await outcome(engine.templates.copy({ from: LONG, name: 'from-long' })))).toMatch(/^invalid: /);
    expect((await readdir(project.dir)).sort()).toEqual(before);
    expect(await readFile(join(project.dir, 'themes', LONG, 'template.yaml'), 'utf8')).toContain('name:');
  });
});
