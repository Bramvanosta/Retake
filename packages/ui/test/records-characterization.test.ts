/**
 * The take the Studio's timeline plans and its Render edits (L7.6a): `timelineRun` over the runs the engine lists, state
 * by state (core/test/fixtures/records/states.json; OLD: a good capture of `quote`; NEW: the state named).
 *
 * The front end holds no rule: it takes the first run the engine marks as a take (`take`: the one rule of the domain).
 *
 * A row marked `D-<n>` is an outcome a decision of the lot changed; `F-<n>` one a fix made on the way changed; `U-1`
 * the row of a capture stopped by `--until`.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEngine } from '@retake/engine';
import type { Engine } from '@retake/engine';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { RunRows } from '../src/app/ProductionsScreen.js';
import { LastRun } from '../src/app/WelcomeScreen.js';
import { timelineRun } from '../src/app/scenario-words.js';
import { STATES, buildState, stateIds, writeRunFolder, writeWorkspace } from '../../core/test/fixtures/records/build.js';
import type { BuiltState } from '../../core/test/fixtures/records/build.js';
import { buildRenderState, renderStateIds } from '../../core/test/fixtures/records/build-renders.js';
import { startStudioServer } from '../src/index.js';
import type { StudioServer } from '../src/index.js';
import { raw } from './http.js';

let root: string;
let engine: Engine;
const savedHome = process.env.RETAKE_HOME;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'retake-records-ui-'));
  process.env.RETAKE_HOME = join(root, '.home');
  writeWorkspace(root);
  engine = await createEngine({ root, client: 'ui', autoStartWorker: false });
});
afterAll(() => {
  if (savedHome === undefined) delete process.env.RETAKE_HOME;
  else process.env.RETAKE_HOME = savedHome;
  rmSync(root, { recursive: true, force: true });
});

async function picked(b: BuiltState): Promise<string> {
  const id = timelineRun(await engine.scenarios.actions(b.slug, STATES.scenario));
  return id === undefined ? '-' : id === b.old ? 'OLD' : id === b.new ? 'NEW' : id;
}

/** The states where the Studio takes NEW; every other state: OLD. */
const NEW = ['ctl', 'h', 'i', 'q', 't5', 't6', 'v', 'z'];
// h: F-2 — was OLD (frames kept beside the film: the newest capture was never offered). l: D-1 — was NEW (its timeline
// does not read). m, m2: D-4 — were NEW (a folder named to sort above the dates). t6: U-1, NEW as before (the scenario
// screen marks the take "until step …"). i: D-8, did not move. q: D-5, NEW as before. z: by design. v: D-8 — a record a
// later version of the same format wrote. hr, hf (a timeline made by hand): OLD — were NEW.

describe('the take the timeline plans and Render edits, state by state', () => {
  it('every state of the table', async () => {
    const got: Record<string, string> = {};
    for (const id of stateIds()) got[id] = await picked(buildState(root, id));
    expect(got).toEqual(Object.fromEntries(stateIds().map((id) => [id, NEW.includes(id) ? 'NEW' : 'OLD'])));
  }, 120_000);

  it('the answer comes from the runs listed: OLD without its film is not taken; a capture that kept its frames beside its film is', async () => {
    expect(await picked(buildState(root, 'a', { old: 'no-film', slug: 's-a-bare' }))).toBe('-');
    // F-2: was "-" (a project whose only capture kept its frames: Render said there was no finished capture).
    expect(await picked(buildState(root, 'h', { old: 'none', slug: 's-h-alone' }))).toBe('NEW');
    expect(timelineRun({})).toBeUndefined();
  });

  it('the front end decides nothing: it takes the capture the engine names, and looks through no list', () => {
    // The capture the engine names is the answer — the front end looks through no list and holds no predicate: a
    // succeeded capture with its video that the engine does not name is not taken (the old predicate took it), and a
    // take older than the runs listed is (before: the first run of the list marked as a take, so none past the list).
    const run = (id: string, o: Record<string, unknown>) => ({ id, mode: 'capture', status: 'succeeded', pictures: 'video', take: false, ...o });
    const view = (o: object) => o as Parameters<typeof timelineRun>[0];
    expect(timelineRun(view({ runs: [run('b', {}), run('a', { take: true, pictures: 'frames' })], capture: { id: 'a' } }))).toBe('a');
    expect(timelineRun(view({ runs: [run('b', {})] }))).toBeUndefined();
    expect(timelineRun(view({ runs: [run('c', {}), run('b', {})], capture: { id: 'old-take', finished_at: 'x' } }))).toBe('old-take');
  });

  it('the scenario view names the same capture as the status bar, also past the runs it lists', async () => {
    const b = buildState(root, 'k3', { slug: 'ui-window' });
    for (let n = 0; n < 21; n++) {
      const id = `202611${String(n + 1).padStart(2, '0')}-100000-quote`;
      writeRunFolder(join(b.runs, id), id, b.slug, STATES.states.c);
    }
    const [view, actions] = [await engine.scenarios.view(b.slug, STATES.scenario), await engine.scenarios.actions(b.slug, STATES.scenario)];
    expect([view.runs.length, view.runs.some((r) => r.take), timelineRun(view), timelineRun(actions)]).toEqual([20, false, b.old, b.old]);
  }, 60_000);

  it('a run.json that does not read as a record: the Studio shows the run\'s id and fixed words, never a row of empty fields', async () => {
    const b = buildState(root, 's', { slug: 'ui-unread' });
    const runs = await engine.runs.list(b.slug);
    expect(runs.map((r) => [r.id === b.new ? 'NEW' : 'OLD', r.unread])).toEqual([['NEW', 'its run.json does not read as a record'], ['OLD', undefined]]);
    const rows = renderToStaticMarkup(createElement(RunRows, { runs }));
    expect(rows).toContain(`<li class="sc-quiet"><bdi class="k-mono">${b.new}</bdi><bdi>: its run.json does not read as a record</bdi></li>`);
    expect(rows.match(/<li /g)?.length).toBe(2);
    expect(rows).not.toContain('undefined');
    const last = renderToStaticMarkup(createElement(LastRun, { extras: { slug: b.slug, environments: [], last_run: runs[0] } }));
    expect(last).toBe('<span class="sc-quiet"><bdi>Last run: its run.json does not read as a record</bdi></span>');
  });

  it("the take the status bar's Render names is the same one (the engine's `capture`)", async () => {
    for (const id of ['ctl', 'c', 'h', 'l', 'm', 't6']) {
      const a = await engine.scenarios.actions(`s-${id}`, STATES.scenario);
      expect([id, a.capture?.id], id).toEqual([id, timelineRun(a)]);
    }
  });
});

// ── The render records (L7.6b): the Studio's `scenario_renders` op, state by state ─
//
// The states are those of core/test/fixtures/records/render-states.json. Every row was first pinned on the code before
// the lot (its P0): the op's status, its summary, the renders it lists and the members of its answer; the thirteen rows
// the lot's engine part changed are marked `moved: <row>` (the lead's plan §4) — each flipped on purpose, no other moved.

describe("the Studio's list of renders, state by state", () => {
  let studio: StudioServer;
  beforeAll(async () => {
    studio = await startStudioServer({ root, startWorker: false });
  }, 60_000);
  afterAll(async () => {
    await studio.close();
  });
  const RTABLE: Record<string, string> = {
    ctl: '200 quote: 1 render, 0 queued or running | quote-v1:succeeded | project,scenario,jobs,renders,untrusted',
    v2: '200 quote: 2 renders, 0 queued or running | quote-v2:succeeded quote-v1:succeeded | project,scenario,jobs,renders,untrusted',
    // moved: the answer gains `not_shown` (a count and fixed words) for quote-v2.json, which the list does not show — row 1
    'no-created': '200 quote: 1 render, 0 queued or running | quote-v1:succeeded | project,scenario,jobs,renders,untrusted,not_shown',
    // moved: the answer gains `not_shown` (a count and fixed words) for quote-v2.json, which the list does not show — row 1
    'created-5': '200 quote: 1 render, 0 queued or running | quote-v1:succeeded | project,scenario,jobs,renders,untrusted,not_shown',
    'renamed-newest': '200 quote: 1 render, 0 queued or running | quote-v1:succeeded | project,scenario,jobs,renders,untrusted',
    'renamed-fixed': '200 quote: 1 render, 0 queued or running | quote-v1:succeeded | project,scenario,jobs,renders,untrusted',
    'renamed-old': '200 quote: 3 renders, 0 queued or running | quote-v3:succeeded quote-v2:succeeded quote-v1:succeeded | project,scenario,jobs,renders,untrusted',
    'renamed-reused': '200 quote: 4 renders, 0 queued or running | quote-v4:succeeded quote-v3:succeeded quote-v2:succeeded quote-v1:succeeded | project,scenario,jobs,renders,untrusted',
    copy: '200 quote: 1 render, 0 queued or running | quote-v1:succeeded | project,scenario,jobs,renders,untrusted',
    'copy-backup': '200 quote: 1 render, 0 queued or running | quote-v1:succeeded | project,scenario,jobs,renders,untrusted',
    'video-gone': '200 quote: 2 renders, 0 queued or running | quote-v2:succeeded quote-v1:succeeded | project,scenario,jobs,renders,untrusted',
    // moved: row 11 — quote-v2 is not shown under `quote` (its record says another scenario): counted in `not_shown`
    'scenario-other': '200 quote: 1 render, 0 queued or running | quote-v1:succeeded | project,scenario,jobs,renders,untrusted,not_shown',
    // moved: row 11 — quote-v2 is not shown (its scenario is no text): counted in `not_shown`
    'scenario-7': '200 quote: 1 render, 0 queued or running | quote-v1:succeeded | project,scenario,jobs,renders,untrusted,not_shown',
    // moved: row 11 — quote-v2 is not shown (no scenario): counted in `not_shown`
    'no-scenario': '200 quote: 1 render, 0 queued or running | quote-v1:succeeded | project,scenario,jobs,renders,untrusted,not_shown',
    'no-variant': '200 quote: 2 renders, 0 queued or running | quote-v2:succeeded quote-v1:succeeded | project,scenario,jobs,renders,untrusted',
    'lock-only': '200 quote: 1 render, 0 queued or running | quote-v1:succeeded | project,scenario,jobs,renders,untrusted',
    'video-only': '200 quote: 1 render, 0 queued or running | quote-v1:succeeded | project,scenario,jobs,renders,untrusted',
    // moved: row 12 — quote-v2 is not shown as succeeded: counted in `not_shown` (its status is not one Retake writes)
    paused: '200 quote: 1 render, 0 queued or running | quote-v1:succeeded | project,scenario,jobs,renders,untrusted,not_shown',
    failed: '200 quote: 2 renders, 0 queued or running | quote-v2:failed quote-v1:succeeded | project,scenario,jobs,renders,untrusted',
    'variant-cube': '200 quote: 2 renders, 0 queued or running | quote-v2:succeeded quote-v1:succeeded | project,scenario,jobs,renders,untrusted',
    // moved: the answer gains `not_shown` (a count and fixed words) for quote-v2.json, which the list does not show — row 10
    'version-2': '200 quote: 1 render, 0 queued or running | quote-v1:succeeded | project,scenario,jobs,renders,untrusted,not_shown',
    // moved: the answer gains `not_shown` (a count and fixed words) for quote-v2.json, which the list does not show — row 14
    link: '200 quote: 1 render, 0 queued or running | quote-v1:succeeded | project,scenario,jobs,renders,untrusted,not_shown',
    'out-name': '200 quote: 1 render, 0 queued or running | quote-v1:succeeded | project,scenario,jobs,renders,untrusted',
    // moved: row 13 — quote-v2 is not shown (no plan): counted in `not_shown`
    'no-plan': '200 quote: 1 render, 0 queued or running | quote-v1:succeeded | project,scenario,jobs,renders,untrusted,not_shown',
    // moved: the answer gains `not_shown` (a count and fixed words) for quote-v2.json, which the list does not show — row 15
    'cut-short': '200 quote: 1 render, 0 queued or running | quote-v1:succeeded | project,scenario,jobs,renders,untrusted,not_shown',
    // moved: the answer gains `not_shown` (a count and fixed words) for quote-v2.json, which the list does not show — row 15
    array: '200 quote: 1 render, 0 queued or running | quote-v1:succeeded | project,scenario,jobs,renders,untrusted,not_shown',
    // moved: the answer gains `not_shown` (a count and fixed words) for quote-v2.json, which the list does not show — row 15
    null: '200 quote: 1 render, 0 queued or running | quote-v1:succeeded | project,scenario,jobs,renders,untrusted,not_shown',
    // moved: row 15 — quote-v2 is not shown as succeeded (no status: no record): counted in `not_shown`
    'no-status': '200 quote: 1 render, 0 queued or running | quote-v1:succeeded | project,scenario,jobs,renders,untrusted,not_shown',
    'no-run-id': '200 quote: 2 renders, 0 queued or running | quote-v2:succeeded quote-v1:succeeded | project,scenario,jobs,renders,untrusted',
    'empty-id': '200 quote: 1 render, 0 queued or running | quote-v1:succeeded | project,scenario,jobs,renders,untrusted',
    'file-outside': '200 quote: 2 renders, 0 queued or running | quote-v2:succeeded quote-v1:succeeded | project,scenario,jobs,renders,untrusted',
    'keep-json': '200 quote: 4 renders, 0 queued or running | quote-v4:succeeded quote-v3:succeeded quote-v2:succeeded quote-v1:succeeded | project,scenario,jobs,renders,untrusted',
    'keep-json-without': '200 quote: 4 renders, 0 queued or running | quote-v4:succeeded quote-v3:succeeded quote-v2:succeeded quote-v1:succeeded | project,scenario,jobs,renders,untrusted',
    'final-files': '200 quote: 4 renders, 0 queued or running | quote-v4:succeeded quote-v3:succeeded quote-v2:succeeded quote-v1:succeeded | project,scenario,jobs,renders,untrusted',

  };

  it('every state of the table through the op', async () => {
    const got: Record<string, string> = {};
    for (const id of renderStateIds()) {
      const b = buildRenderState(root, id);
      const r = await raw(studio.port, 'POST', '/v1/call/scenario_renders', { authorization: `Bearer ${studio.token}`, 'content-type': 'application/json' }, JSON.stringify({ project: b.slug, name: 'quote' }));
      const body = r.json<{ summary?: string; data?: { renders: Array<{ render_id: string; status: string }> } & Record<string, unknown> }>();
      got[id] = `${r.status} ${body.summary ?? ''} | ${body.data?.renders.map((x) => `${x.render_id}:${x.status}`).join(' ') || '-'} | ${Object.keys(body.data ?? {}).join(',')}`;
    }
    expect(got).toEqual(RTABLE);
  }, 120_000);
});
