/**
 * The run records and takes as the editor answers them (L7.6a), state by state: which run `latest` names, what a named
 * run answers at a terminal and under trust `mcp`, and what the plan of each says. The states are those of
 * core/test/fixtures/records/states.json (OLD: a good capture of `quote`; NEW: the state named), one project per state
 * in a temp workspace; nothing is rendered.
 *
 * A row marked `D-<n>` is an outcome a decision of the lot changed; `F-<n>` one a fix made on the way changed; `U-1`
 * the row of a capture stopped by `--until` (it stays usable; the pick carries where it stopped, the shells say it).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PERSON_POLICY, takeWords } from '@retake/core';
import { loadProject } from '@retake/core/io';
import { loadComponentRegistry } from '@retake/components';
import type { ComponentRegistry } from '@retake/components';
import { PlanTrustError, RenderError, findRun, planRun, runEnv } from '@retake/editor';
import { NoCaptureRunError } from '../src/render/runs.js';
import type { RunRef } from '@retake/editor';
import { STATES, buildState, stateIds, writeRunFolder, writeWorkspace } from '../../core/test/fixtures/records/build.js';
import type { BuiltState } from '../../core/test/fixtures/records/build.js';

let root: string;
let registry: ComponentRegistry;
const built = new Map<string, BuiltState>();

/** `OLD`, `NEW` or the id itself. */
const who = (b: BuiltState, id: string): string => (id === b.old ? 'OLD' : id === b.new ? 'NEW' : id);
/** An error as its class and its message with the workspace's paths and the run ids replaced. */
function words(b: BuiltState, e: unknown): string {
  const kind = e instanceof PlanTrustError ? 'PlanTrustError' : e instanceof RenderError ? 'RenderError' : (e as Error).name;
  const text = (e as Error).message.replaceAll(root, '<root>').replaceAll(b.new, 'NEW').replaceAll(b.old, 'OLD');
  return `${kind}: ${text}`;
}
async function answer(b: BuiltState, fn: () => Promise<string> | string): Promise<string> {
  try {
    return await fn();
  } catch (e) {
    return words(b, e);
  }
}
const state = (id: string, o: Parameters<typeof buildState>[2] = {}): BuiltState => {
  const key = `${id}/${o.old ?? 'good'}`;
  if (!built.has(key)) built.set(key, buildState(root, id, { ...o, slug: `s-${id.toLowerCase()}${o.old && o.old !== 'good' ? `-${o.old}` : ''}` }));
  return built.get(key)!;
};
const project = (b: BuiltState) => loadProject(b.slug, root);

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'retake-records-editor-'));
  writeWorkspace(root);
  registry = await loadComponentRegistry({ root });
}, 120_000);
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** A run `latest` picked, with what the pick carries: where `--until` stopped it, what it passed over (as core's table says it). */
function said(b: BuiltState, run: RunRef): string {
  const parts = [who(b, run.id)];
  const pick = run.latest;
  if (pick?.take?.until) parts.push(`until ${pick.take.until.scene}.${pick.take.until.step}`);
  if (pick?.passed.length) parts.push(`passed ${pick.passed.map((x) => `${who(b, x.run)} ${takeWords(x.why, { run: x.run, verb: 'render' })}`).join('; ')}`);
  if (pick?.without_record) parts.push(`${pick.without_record} without a record`);
  return parts.join(' | ');
}

/** The run `latest` names (findRun), then what its plan says. */
async function latest(b: BuiltState): Promise<[string, string]> {
  const p = await project(b);
  return [
    await answer(b, async () => said(b, await findRun(p, 'latest', STATES.scenario))),
    await answer(b, async () => `plans ${who(b, (await planRun({ workPolicy: PERSON_POLICY, project: p, run: 'latest', scenario: STATES.scenario, root, registry })).run.id)}`),
  ];
}
/** NEW named by its folder: at a terminal, then under trust `mcp`. */
async function named(b: BuiltState): Promise<[string, string]> {
  const p = await project(b);
  const plan = (trust: 'author' | 'mcp') => answer(b, async () => `plans ${who(b, (await planRun({ workPolicy: PERSON_POLICY, project: p, run: b.new, scenario: STATES.scenario, root, registry, trust })).run.id)}`);
  return [await plan('author'), await plan('mcp')];
}

const NO_FILM = (slug: string) => `RenderError: run NEW has no capture video (<root>/projects/${slug}/runs/NEW/capture.mp4)`;
const NO_TIMELINE = (slug: string) => `RenderError: run NEW has no timeline.json (<root>/projects/${slug}/runs/NEW)`;
const NEWER = 'RenderError: run NEW: this run.json is version 2: it was made for a newer Retake (this one reads version 1) — update Retake';
const OTHER = 'RenderError: run NEW is a run of scenario "other", not "quote"';
const DRY = 'RenderError: run NEW is a dry run: there is no capture to render';
const NONE = (slug: string) => `RenderError: no capture run of scenario "quote" in <root>/projects/${slug}/runs: capture one with \`retake run ${slug} quote\``;

const UNREADABLE = 'RenderError: run NEW: its timeline does not read (timeline.json is not JSON)';
const LINKS = 'PlanTrustError: refused through MCP:\n- run NEW: its files are links: through MCP a render reads only the files of the run folder itself';
const LINKED = 'PlanTrustError: refused through MCP:\n- run NEW is a link to a folder outside the project: through MCP a render reads only the runs inside it';

/**
 * Per state: the run `latest` names (findRun) with what it passed over, what planning `latest` says, then NEW named by
 * its folder at a terminal and under trust `mcp`. `=`: the same as the cell on its left. The comment names the decision
 * or the fix that moved the row (L7.6a part B); a row without one did not move. The first column is the one of
 * core/test/run-folder.test.ts, state for state.
 */
const TABLE: Record<string, [latest: string, latestPlan: string, named: string, namedMcp: string]> = {
  ctl: ['NEW', 'plans NEW', 'plans NEW', '='],
  a: ['OLD | passed NEW not finished, or interrupted', 'plans OLD', NO_TIMELINE('s-a'), '='], // D-2: the notice (a capture still filming is said too)
  b: ['OLD | passed NEW not finished, or interrupted', 'plans OLD', NO_TIMELINE('s-b'), '='], // D-2: the notice
  c: ['OLD | passed NEW failed', 'plans OLD', 'plans NEW', '='], // D-1, D-2: was NEW
  d: ['OLD | passed NEW failed', 'plans OLD', NO_FILM('s-d'), '='], // D-1: was NEW, then "no capture video"
  e: ['OLD | passed NEW cancelled', 'plans OLD', NO_FILM('s-e'), '='], // D-1: was NEW, then "no capture video"
  f: ['OLD', 'plans OLD', DRY, '='],
  g: ['OLD | passed NEW its film is missing', 'plans OLD', NO_FILM('s-g'), '='], // D-1: was NEW, then "no capture video"
  gn: ['OLD | passed NEW its timeline is missing', 'plans OLD', NO_TIMELINE('s-gn'), '='], // D-2: the notice
  gf: ['OLD | passed NEW its film is missing', 'plans OLD', NO_FILM('s-gf'), '='], // D-1: was NEW, then "no capture video"
  h: ['NEW', 'plans NEW', 'plans NEW', '='],
  i: ['NEW', 'plans NEW', 'plans NEW', '='], // D-8: must not move
  j: ['OLD | 1 without a record', 'plans OLD', 'plans NEW', '='], // D-3: was NEW
  k: ['OLD | 1 without a record', 'plans OLD', 'plans NEW', '='], // D-3: was NEW
  l: ['OLD | passed NEW its timeline does not read', 'plans OLD', UNREADABLE, '='], // D-2: the notice; F-4: the named run's sentence (was a raw SyntaxError)
  o: ['OLD | passed NEW written by a newer Retake', 'plans OLD', NEWER, '='], // D-6: was the newer-format refusal of the whole command
  of: ['OLD | passed NEW written by a newer Retake', 'plans OLD', NEWER, '='], // D-6: the same
  p: ['OLD', 'plans OLD', OTHER, '='], // D-5: was NEW, then "is a run of scenario …"
  p2: ['OLD', 'plans OLD', 'plans NEW', '='], // D-5: was NEW
  r: ['OLD | passed NEW its status is not one Retake writes', 'plans OLD', 'plans NEW', '='], // D-1: was NEW
  s: ['OLD | 1 without a record', 'plans OLD', 'plans NEW', '='], // D-3: was NEW
  m: ['OLD', 'plans OLD', 'plans NEW', '='],
  m2: ['OLD', 'plans OLD', 'plans NEW', '='],
  q: ['NEW', 'plans NEW', 'plans NEW', '='], // D-5: was OLD (the record says quote, whatever the folder is called)
  t5: ['NEW', 'plans NEW', 'plans NEW', '='],
  t6: ['NEW | until catalog.1', 'plans NEW', 'plans NEW', '='], // U-1: still NEW; the pick now carries where `--until` stopped it
  t7: ['OLD | passed NEW not finished, or interrupted', 'plans OLD', 'plans NEW', '='], // D-1: was NEW
  t8: ['-', '=', 'plans NEW', '='],
  t9: ['OLD | passed NEW its files are links', 'plans OLD', 'plans NEW', LINKS], // through MCP the files of a named run are its folder's own (before: the plan's second gate refused the film it served)
  // A timeline made by hand (no run id; no film named): named, it plans as it always has, at a terminal and through
  // MCP; `latest` wants a complete head and passes it over (was NEW).
  hr: ['OLD | passed NEW its timeline does not read', 'plans OLD', 'plans NEW', '='],
  hf: ['OLD | passed NEW its timeline does not read', 'plans OLD', 'plans NEW', '='],
  v: ['NEW', 'plans NEW', 'plans NEW', '='], // D-8: a record of a later version of the same format is a capture like any other
  k1: ['OLD', 'plans OLD', 'plans NEW', LINKED], // D-7: was NEW; named under mcp was planned
  k1f: ['OLD', 'plans OLD', 'plans NEW', LINKED], // D-7: the same
  k2: ['OLD', 'plans OLD', '-', '='], // F-1: was "no capture run" (a dangling link beside OLD)
  k3: ['OLD', 'plans OLD', '-', '='],
  z: ['NEW', 'plans NEW', 'plans NEW', '='],
};

describe('the editor, state by state: the run `latest` names and a run named by its folder', () => {
  it('every state of the table, at a terminal and under trust mcp', async () => {
    expect(Object.keys(TABLE).sort()).toEqual(stateIds({ named: true }).sort());
    const got: typeof TABLE = {};
    for (const [id, want] of Object.entries(TABLE)) {
      const b = state(id);
      const [l, lp] = want[0] === '-' ? ['-', '-'] : await latest(b);
      const [n, nm] = want[2] === '-' ? ['-', '-'] : await named(b);
      got[id] = [l, lp === l ? '=' : lp, n, nm === n ? '=' : nm];
    }
    expect(got).toEqual(TABLE);
  }, 240_000);

  it('NEW alone: a state `latest` passes over leaves no capture run and says what it passed over, never by a name; the folder a name sorts first is taken', async () => {
    const alone = async (id: string) => (await latest(state(id, { old: 'none' })))[0];
    // Today's sentence is the prefix, byte for byte; then the counts, in the rule's fixed words.
    expect(await alone('a')).toBe(`${NONE('s-a-none')} — 1 capture of it cannot be edited: not finished, or interrupted (1)`);
    expect(await alone('c')).toBe(`${NONE('s-c-none')} — 1 capture of it cannot be edited: failed (1)`);
    expect(await alone('k')).toBe(`${NONE('s-k-none')} — 1 run folder without a readable run.json was not considered (name one with \`--run <id>\`)`); // D-3
    expect(await alone('f')).toBe(NONE('s-f-none')); // a dry run is never "passed over"
    expect(await alone('k1')).toBe(NONE('s-k1-none')); // D-7: a linked folder is not read, so not counted
    expect(await alone('m')).toBe('NEW');
    expect(await alone('o')).toBe(NEWER); // D-6: stays the "update Retake" sentence
    expect(await alone('q')).toBe('NEW'); // D-5: was "no capture run" (its record says quote)
    // No run id in the sentence of a pick that found nothing (it may reach a trusted line).
    for (const id of ['a', 'c', 'k']) expect(await alone(id)).not.toContain('NEW');
  });

  it('nothing usable among several: a count per reason, the folders without a record apart', async () => {
    const b = state('c', { old: 'no-film' });
    writeRunFolder(join(b.runs, '20261003-100000-quote'), '20261003-100000-quote', b.slug, STATES.states.e!);
    writeRunFolder(join(b.runs, '20261004-100000-quote'), '20261004-100000-quote', b.slug, STATES.states.c!);
    writeRunFolder(join(b.runs, '20261005-100000-quote'), '20261005-100000-quote', b.slug, STATES.states.k!);
    const p = await project(b);
    const e = await findRun(p, 'latest', STATES.scenario).then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(e).toBeInstanceOf(NoCaptureRunError);
    expect(e).toBeInstanceOf(RenderError);
    expect(words(b, e)).toBe(
      `${NONE('s-c-no-film')} — 4 captures of it cannot be edited: failed (2), cancelled (1), its film is missing (1); 1 run folder without a readable run.json was not considered (name one with \`--run <id>\`)`,
    );
    const pick = (e as NoCaptureRunError).pick;
    expect(pick.take).toBeUndefined();
    expect(pick.passed.map((x) => `${who(b, x.run)} ${x.why}`)).toEqual(['20261004-100000-quote failed', '20261003-100000-quote cancelled', 'NEW failed', 'OLD no-film']);
    expect([pick.passed_more, pick.without_record]).toEqual([0, 1]);
  });

  it('`latest` without a scenario: the newest capture timeline of any name', async () => {
    const any = async (id: string) => {
      const b = state(id);
      const p = await project(b);
      return answer(b, async () => said(b, await findRun(p, 'latest')));
    };
    expect(await any('p')).toBe('NEW'); // a good capture of `other`
    expect(await any('p2')).toBe('OLD | passed NEW its timeline is of another scenario'); // D-5: was NEW
    expect(await any('q')).toBe('NEW');
    expect(await any('m')).toBe('OLD');
    expect(await any('f')).toBe('OLD');
  });

  it('each column reads the folder it answers about: OLD without its film, or gone, changes the answer', async () => {
    // `latest` reads OLD's film (D-1: before, findRun read the timeline only and the plan then said "no capture video").
    expect((await latest(state('a')))[0]).toBe('OLD | passed NEW not finished, or interrupted');
    const nothing = `${NONE('s-a-no-film')} — 2 captures of it cannot be edited: not finished, or interrupted (1), its film is missing (1)`;
    expect(await latest(state('a', { old: 'no-film' }))).toEqual([nothing, nothing]);
    // The named run: OLD named, with and without its film.
    const b = state('a', { old: 'no-film' });
    const named = async (x: BuiltState) => answer(x, async () => `plans ${who(x, (await planRun({ workPolicy: PERSON_POLICY, project: await project(x), run: x.old, scenario: STATES.scenario, root, registry })).run.id)}`);
    expect(await named(state('a'))).toBe('plans OLD');
    expect(await named(b)).toBe('RenderError: run OLD has no capture video (<root>/projects/s-a-no-film/runs/OLD/capture.mp4)');
  });

  it('a run folder given by its path, whatever its name', async () => {
    const b = state('t8');
    const p = await project(b);
    expect(await findRun(p, b.newDir)).toEqual({ id: 'my take', dir: b.newDir });
    expect(await findRun(p, 'my take')).toEqual({ id: 'my take', dir: b.newDir });
    await expect(findRun(p, 'no-such-run')).rejects.toThrow(`run "no-such-run" not found in ${b.runs} (use a run id, a run directory or "latest")`);
  });

  it('the environment a run filmed, from its record (runEnv)', async () => {
    const env = (id: string) => runEnv(state(id).newDir);
    expect(await env('ctl')).toBe('local');
    expect(await env('i')).toBe('local');
    expect(await env('r')).toBe('local');
    expect(await env('o')).toBeUndefined(); // through the one reader a newer record is not read (was `local`; the run is refused before its env is asked)
    expect(await env('j')).toBeUndefined();
    expect(await env('k')).toBeUndefined();
    expect(await env('s')).toBeUndefined();
  });
});
