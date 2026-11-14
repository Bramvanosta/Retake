/**
 * The run records and takes as the editor answers them (L7.6a), state by state: which run `latest` names, what a named
 * run answers at a terminal and under trust `mcp`, and what the plan of each says. The states are those of
 * core/test/fixtures/records/states.json (OLD: a good capture of `quote`; NEW: the state named), one project per state
 * in a temp workspace; nothing is rendered.
 *
 * A row marked `D-<n>` is an outcome a decision of the lot changed; `F-<n>` one a fix made on the way changed; `U-1`
 * the row of a capture stopped by `--until` (it stays usable; the pick carries where it stopped, the shells say it).
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PERSON_POLICY, takeWords } from '@retake/core';
import { loadProject } from '@retake/core/io';
import { loadComponentRegistry } from '@retake/components';
import type { ComponentRegistry } from '@retake/components';
import { PlanTrustError, RenderError, exportRender, findRenderRecord, findRun, listRenders, planRun, runEnv } from '@retake/editor';
import { NoCaptureRunError } from '../src/render/runs.js';
import type { RunRef } from '@retake/editor';
import { STATES, buildState, recordFixture, stateIds, writeRunFolder, writeWorkspace } from '../../core/test/fixtures/records/build.js';
import type { BuiltState } from '../../core/test/fixtures/records/build.js';
import { buildRenderState, renderStateIds } from '../../core/test/fixtures/records/build-renders.js';
import type { BuiltRenders } from '../../core/test/fixtures/records/build-renders.js';

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
  const plan = (trust: 'author' | 'mcp') =>
    answer(b, async () => `plans ${who(b, (await planRun({ workPolicy: PERSON_POLICY, project: p, run: b.new, scenario: STATES.scenario, root, registry, trust })).run.id)}`);
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
    const named = async (x: BuiltState) =>
      answer(x, async () => `plans ${who(x, (await planRun({ workPolicy: PERSON_POLICY, project: await project(x), run: x.old, scenario: STATES.scenario, root, registry })).run.id)}`);
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

// ── The render records (L7.6b), state by state ──────────────────────────────
//
// The states are those of core/test/fixtures/records/render-states.json: two good captures (OLD, NEW), a good render
// `quote-v1` and the file(s) the state names. The cells were written before the lot (its P0) and flipped by its editor
// part on purpose: a cell that changed is marked `moved: <row>` with the row of the lot's table of visible changes (the
// lead's plan §4, and §1b's rows 21–29) and says what it held before. A state without a mark did not move: a thing a
// person NAMES keeps working. Since the lot the listing is the complete records of their own file (D-10); a terminal's
// `latest` takes the newest succeeded complete record whatever its file is called, and acts on THAT FILE (ruling 2).

describe('the render records as the editor answers them, state by state', () => {
  let films: { film: Buffer; alt: Buffer };
  const rb = new Map<string, BuiltRenders>();
  const rstate = (id: string): BuiltRenders => {
    if (!rb.has(id)) rb.set(id, buildRenderState(root, id, films));
    return rb.get(id)!;
  };
  beforeAll(() => {
    // Two real (tiny) films that differ by their bytes: an export copies and probes the video it was given.
    const make = (colour: string): Buffer => {
      const file = join(root, `${colour}.mp4`);
      execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=${colour}:s=64x36:r=30:d=1`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', file]);
      return readFileSync(file);
    };
    films = { film: make('black'), alt: make('white') };
  }, 60_000);

  /** What a person types to name the state's file (default: quote-v2). */
  const NAME: Record<string, string> = {
    ctl: 'quote-v1',
    'renamed-newest': 'quote-final',
    'renamed-fixed': 'quote-final',
    'renamed-old': 'quote-final',
    'renamed-reused': 'quote-final',
    copy: 'quote-v1 copy',
    'copy-backup': 'quote-v1-backup',
    'out-name': 'quote-final',
    'empty-id': 'x',
    'keep-json': 'keep',
    'keep-json-without': 'quote-v1',
    'final-files': 'quote-v1.final',
  };
  const name = (id: string) => NAME[id] ?? 'quote-v2';
  const rwords = (b: BuiltRenders, e: unknown): string => `${(e as Error).name}: ${(e as Error).message.replaceAll(root, '<root>').replaceAll(b.new, 'NEW').replaceAll(b.old, 'OLD')}`;
  const ranswer = async (b: BuiltRenders, fn: () => Promise<string>): Promise<string> => fn().catch((e: unknown) => rwords(b, e));
  /** An export of the named render to one copied format: the id it says, the folder it writes by default, whose bytes went out. */
  const exported = (b: BuiltRenders, trust: 'author' | 'mcp') =>
    ranswer(b, async () => {
      const r = await exportRender({ workPolicy: PERSON_POLICY, project: await loadProject(b.slug, root), root, render: name(b.state), formats: ['mp4_1080p'], trust });
      const bytes = readFileSync(r.outputs[0]!.file);
      return `export ${r.render} → ${r.dir.slice(b.dir.length + 1)} (${r.outputs[0]!.method}, ${bytes.equals(films.alt) ? 'the alt film' : bytes.equals(films.film) ? 'the film' : 'other bytes'})`;
    });
  const rsites = {
    // Reader 1: the listing (editor listRenders).
    list: (b: BuiltRenders) => ranswer(b, async () => (await listRenders(await loadProject(b.slug, root))).map((r) => r.id || '""').join(' ') || '-'),
    // A terminal's `latest` (export's).
    latest: (b: BuiltRenders) => ranswer(b, async () => (await findRenderRecord(await loadProject(b.slug, root), 'latest', 'quote')).id || '""'),
    // Reader 2: a render named at a terminal.
    named: (b: BuiltRenders) => ranswer(b, async () => `taken ${(await findRenderRecord(await loadProject(b.slug, root), name(b.state))).id || '""'}`),
    export: (b: BuiltRenders) => exported(b, 'author'),
    exportMcp: (b: BuiltRenders) => exported(b, 'mcp'),
  };
  type RRow = Record<keyof typeof rsites, string>;
  const RTABLE: Record<string, RRow> = {
    ctl: {
      list: 'quote-v1',
      latest: 'quote-v1',
      named: 'taken quote-v1',
      export: 'export quote-v1 → exports/quote-v1 (copy, the film)',
      exportMcp: 'export quote-v1 → exports/quote-v1 (copy, the film)',
    },
    v2: {
      list: 'quote-v1 quote-v2',
      latest: 'quote-v2',
      named: 'taken quote-v2',
      export: 'export quote-v2 → exports/quote-v2 (copy, the film)',
      exportMcp: 'export quote-v2 → exports/quote-v2 (copy, the film)',
    },
    // N3 — named, it exports (did not move). moved: row 1 — list and latest answer quote-v1, the file passed over (before: a raw TypeError)
    'no-created': {
      list: 'quote-v1',
      latest: 'quote-v1',
      named: 'taken quote-v2',
      export: 'export quote-v2 → exports/quote-v2 (copy, the film)',
      exportMcp: 'export quote-v2 → exports/quote-v2 (copy, the film)',
    },
    // N3 — named, it exports (did not move). moved: row 1 — list and latest answer (before: a raw TypeError)
    'created-5': {
      list: 'quote-v1',
      latest: 'quote-v1',
      named: 'taken quote-v2',
      export: 'export quote-v2 → exports/quote-v2 (copy, the film)',
      exportMcp: 'export quote-v2 → exports/quote-v2 (copy, the film)',
    },
    // moved: row 6 — the list without quote-v2 (before: `quote-v1 quote-v2`). Ruling 2: a terminal's latest takes the renamed record by its file (the CLI's table says the line); named, its video is still missing
    'renamed-newest': {
      list: 'quote-v1',
      latest: 'quote-v2',
      named: 'taken quote-v2',
      export: 'ExportError: the video of render quote-v2 is missing (<root>/projects/r-renamed-newest/renders/quote-v2.mp4)',
      exportMcp: 'ExportError: render "quote-final": through MCP a render is named by its id',
    },
    // N1 — a renamed record whose `file` was corrected exports (did not move; at a terminal row 8 adds one line). moved: row 6 as above
    'renamed-fixed': {
      list: 'quote-v1',
      latest: 'quote-v2',
      named: 'taken quote-v2',
      export: 'export quote-v2 → exports/quote-v2 (copy, the film)',
      exportMcp: 'ExportError: render "quote-final": through MCP a render is named by its id',
    },
    // moved: row 6 — the list without quote-v0 (before: `quote-v0 quote-v1 quote-v2 quote-v3`); named, its video is missing (as before)
    'renamed-old': {
      list: 'quote-v1 quote-v2 quote-v3',
      latest: 'quote-v3',
      named: 'taken quote-v0',
      export: 'ExportError: the video of render quote-v0 is missing (<root>/projects/r-renamed-old/renders/quote-v0.mp4)',
      exportMcp: 'ExportError: render "quote-final": through MCP a render is named by its id',
    },
    // moved: row 9 — named and exported: refused (before: taken, and the export copied the OTHER render's video — `the film` is quote-v1's, the renamed record's own is `the alt film` — into exports/quote-v1); row 6: the list names quote-v1 once
    'renamed-reused': {
      list: 'quote-v1 quote-v2 quote-v3 quote-v4',
      latest: 'quote-v4',
      named:
        'ExportError: renders/quote-final.json says it is quote-v1, and renders/quote-v1.mp4 is now the video of another render: nothing to export — correct "file" in the record, or render again with --out',
      export:
        'ExportError: renders/quote-final.json says it is quote-v1, and renders/quote-v1.mp4 is now the video of another render: nothing to export — correct "file" in the record, or render again with --out',
      exportMcp: 'ExportError: render "quote-final": through MCP a render is named by its id',
    },
    // N1 — a copy beside its original exports (did not move; at a terminal row 8 adds one line). moved: row 6 — the list names quote-v1 once (before: twice)
    copy: {
      list: 'quote-v1',
      latest: 'quote-v1',
      named: 'taken quote-v1',
      export: 'export quote-v1 copy → exports/quote-v1 copy (copy, the film)', // moved: fix pass, H2 — named after its file: quote-v1's folders are quote-v1's (before: exports/quote-v1, the real render's)
      exportMcp: 'ExportError: render "quote-v1 copy": through MCP a render is named by its id',
    },
    // N1 — the same. moved: row 6
    'copy-backup': {
      list: 'quote-v1',
      latest: 'quote-v1',
      named: 'taken quote-v1',
      export: 'export quote-v1-backup → exports/quote-v1-backup (copy, the film)', // moved: fix pass, H2 — named after its file: quote-v1's folders are quote-v1's (before: exports/quote-v1, the real render's)
      exportMcp: 'ExportError: render "quote-v1-backup": through MCP a render is named by its id',
    },
    'video-gone': {
      list: 'quote-v1 quote-v2',
      latest: 'quote-v2',
      named: 'taken quote-v2',
      export: 'ExportError: the video of render quote-v2 is missing (<root>/projects/r-video-gone/renders/quote-v2.mp4)',
      exportMcp: 'ExportError: the video of render quote-v2 is missing (the file its record names)', // moved: fix pass (before: the record's path, file text, in a sentence for MCP)
    },
    // N9 — named, taken and exported (must not move)
    'scenario-other': {
      list: 'quote-v1 quote-v2',
      latest: 'quote-v1',
      named: 'taken quote-v2',
      export: 'export quote-v2 → exports/quote-v2 (copy, the film)',
      exportMcp: 'export quote-v2 → exports/quote-v2 (copy, the film)',
    },
    // N2 — named, it exports (did not move). moved: row 11 — the list without it (it lacks its scenario; before: listed)
    'scenario-7': {
      list: 'quote-v1',
      latest: 'quote-v1',
      named: 'taken quote-v2',
      export: 'export quote-v2 → exports/quote-v2 (copy, the film)',
      exportMcp: 'export quote-v2 → exports/quote-v2 (copy, the film)',
    },
    // N2 — named, it exports (did not move). moved: row 11 — the list without it (it lacks its scenario; before: listed)
    'no-scenario': {
      list: 'quote-v1',
      latest: 'quote-v1',
      named: 'taken quote-v2',
      export: 'export quote-v2 → exports/quote-v2 (copy, the film)',
      exportMcp: 'export quote-v2 → exports/quote-v2 (copy, the film)',
    },
    // N4 — exports with the plan's variant (must not move)
    'no-variant': {
      list: 'quote-v1 quote-v2',
      latest: 'quote-v2',
      named: 'taken quote-v2',
      export: 'export quote-v2 → exports/quote-v2 (copy, the film)',
      exportMcp: 'export quote-v2 → exports/quote-v2 (copy, the film)',
    },
    // moved: row 15 — under trust mcp, a file that is not there is "not found" (before: `cannot read the render record …: ENOENT …`)
    'lock-only': {
      list: 'quote-v1',
      latest: 'quote-v1',
      named: 'ExportError: render "quote-v2" not found in <root>/projects/r-lock-only/renders (renders: quote-v1); use a render id, a .json/.mp4 path or "latest"',
      export: 'ExportError: render "quote-v2" not found in <root>/projects/r-lock-only/renders (renders: quote-v1); use a render id, a .json/.mp4 path or "latest"',
      exportMcp: 'ExportError: render "quote-v2" not found in <root>/projects/r-lock-only/renders (renders: quote-v1); use a render id, a .json/.mp4 path or "latest"',
    },
    // moved: row 15 — under trust mcp, a file that is not there is "not found" (before: `cannot read the render record …: ENOENT …`)
    'video-only': {
      list: 'quote-v1',
      latest: 'quote-v1',
      named: 'ExportError: render "quote-v2" not found in <root>/projects/r-video-only/renders (renders: quote-v1); use a render id, a .json/.mp4 path or "latest"',
      export: 'ExportError: render "quote-v2" not found in <root>/projects/r-video-only/renders (renders: quote-v1); use a render id, a .json/.mp4 path or "latest"',
      exportMcp: 'ExportError: render "quote-v2" not found in <root>/projects/r-video-only/renders (renders: quote-v1); use a render id, a .json/.mp4 path or "latest"',
    },
    // N10 — the sentence stays. moved: row 12 — the list without it (before: listed)
    paused: {
      list: 'quote-v1',
      latest: 'quote-v1',
      named: 'taken quote-v2',
      export: 'ExportError: render quote-v2 paused: nothing to export',
      exportMcp: 'ExportError: render quote-v2 has a status Retake never writes: nothing to export', // moved: fix pass (before: the file's word)
    },
    // N10 — the sentence stays
    failed: {
      list: 'quote-v1 quote-v2',
      latest: 'quote-v1',
      named: 'taken quote-v2',
      export: 'ExportError: render quote-v2 failed: nothing to export',
      exportMcp: 'ExportError: render quote-v2 failed: nothing to export',
    },
    // N9 — named, the reader takes it. moved: row 22 — the export refuses in one sentence (before: a raw TypeError — no size is known for a variant this version does not write)
    'variant-cube': {
      list: 'quote-v1 quote-v2',
      latest: 'quote-v2',
      named: 'taken quote-v2',
      export: 'ExportError: render quote-v2: its record says variant "cube", which this Retake does not export (landscape, vertical or square)',
      exportMcp: 'ExportError: render quote-v2: its record says a variant this Retake does not export (landscape, vertical or square)', // moved: fix pass, M4 (before: the word, in a sentence for MCP)
    },
    // moved: row 10 — named and exported: the newer-Retake sentence (before: `… is not a render record (renders/<id>.json)`)
    'version-2': {
      list: 'quote-v1',
      latest: 'quote-v1',
      named: 'ExportError: <root>/projects/r-version-2/renders/quote-v2.json: this render record is version 2: it was made for a newer Retake (this one reads version 1) — update Retake',
      export: 'ExportError: <root>/projects/r-version-2/renders/quote-v2.json: this render record is version 2: it was made for a newer Retake (this one reads version 1) — update Retake',
      exportMcp: 'ExportError: render "quote-v2": this render record is version 2: it was made for a newer Retake (this one reads version 1) — update Retake',
    },
    // N7 — named at a terminal, read through the link (did not move). moved: row 14 — the list without it, latest is quote-v1 (said at a terminal), under trust mcp refused (before: listed, latest, exported)
    link: {
      list: 'quote-v1',
      latest: 'quote-v1',
      named: 'taken quote-v2',
      export: 'export quote-v2 → exports/quote-v2 (copy, the film)',
      exportMcp: 'ExportError: render "quote-v2": renders/quote-v2.json is a link: through MCP a render is read from its own file',
    },
    // N8 — taken, and a terminal's `latest` (D-11: must not move)
    'out-name': {
      list: 'quote-v1 quote-final',
      latest: 'quote-final',
      named: 'taken quote-final',
      export: 'export quote-final → exports/quote-final (copy, the film)',
      exportMcp: 'ExportError: render "quote-final": through MCP a render is named by its id',
    },
    // moved: row 13 — named and exported: the record has no plan (before: `… is not a render record (renders/<id>.json)`)
    'no-plan': {
      list: 'quote-v1',
      latest: 'quote-v1',
      named: 'ExportError: render quote-v2 has no plan (<root>/projects/r-no-plan/renders/quote-v2.json): nothing to export',
      export: 'ExportError: render quote-v2 has no plan (<root>/projects/r-no-plan/renders/quote-v2.json): nothing to export',
      exportMcp: 'ExportError: render quote-v2 has no plan (renders/quote-v2.json): nothing to export',
    },
    // moved: row 15 — the file does not read as a render record (before: a JSON parser's message)
    'cut-short': {
      list: 'quote-v1',
      latest: 'quote-v1',
      named: 'ExportError: <root>/projects/r-cut-short/renders/quote-v2.json does not read as a render record (it is not JSON)',
      export: 'ExportError: <root>/projects/r-cut-short/renders/quote-v2.json does not read as a render record (it is not JSON)',
      exportMcp: 'ExportError: render "quote-v2": renders/quote-v2.json does not read as a render record (it is not JSON)',
    },
    // moved: row 15 — the same sentence (before: `… is not a render record (renders/<id>.json)`)
    array: {
      list: 'quote-v1',
      latest: 'quote-v1',
      named: 'ExportError: <root>/projects/r-array/renders/quote-v2.json does not read as a render record',
      export: 'ExportError: <root>/projects/r-array/renders/quote-v2.json does not read as a render record',
      exportMcp: 'ExportError: render "quote-v2": renders/quote-v2.json does not read as a render record',
    },
    // moved: row 15 — the same sentence (before: `… is not a render record (renders/<id>.json)`)
    'null': {
      list: 'quote-v1',
      latest: 'quote-v1',
      named: 'ExportError: <root>/projects/r-null/renders/quote-v2.json does not read as a render record',
      export: 'ExportError: <root>/projects/r-null/renders/quote-v2.json does not read as a render record',
      exportMcp: 'ExportError: render "quote-v2": renders/quote-v2.json does not read as a render record',
    },
    // moved: rows 15 and 28 — named: the file does not read as a render record (status); the list without it (before: listed, taken, and `render quote-v2 undefined: nothing to export` — a bug)
    'no-status': {
      list: 'quote-v1',
      latest: 'quote-v1',
      named: 'ExportError: <root>/projects/r-no-status/renders/quote-v2.json does not read as a render record (status)',
      export: 'ExportError: <root>/projects/r-no-status/renders/quote-v2.json does not read as a render record (status)',
      exportMcp: 'ExportError: render "quote-v2": renders/quote-v2.json does not read as a render record (status)',
    },
    // N9 — taken and exported (must not move)
    'no-run-id': {
      list: 'quote-v1 quote-v2',
      latest: 'quote-v2',
      named: 'taken quote-v2',
      export: 'export quote-v2 → exports/quote-v2 (copy, the film)',
      exportMcp: 'export quote-v2 → exports/quote-v2 (copy, the film)',
    },
    // moved: rows 16 and 25 — not listed; exported into exports/x, named after its file (before: listed, and the export went straight into exports/ — a bug). A terminal's latest still picks it BY ITS FILE (ruling 25)
    'empty-id': {
      list: 'quote-v1',
      latest: '""',
      named: 'taken ""',
      export: 'export x → exports/x (copy, the film)',
      exportMcp: 'ExportError: render "x": through MCP a render is named by its id',
    },
    // N9 — a render named at a terminal is read as its record says; under trust mcp its video must lie in the project (must not move)
    'file-outside': {
      list: 'quote-v1 quote-v2',
      latest: 'quote-v2',
      named: 'taken quote-v2',
      export: 'export quote-v2 → exports/quote-v2 (copy, other bytes)',
      exportMcp: 'ExportError: the video of render quote-v2 (/etc/hosts) is outside the project folder: through MCP a render is read only from the project',
    },
    // moved: row 6 — the list names quote-v1 once (before: twice); named, it exports (at a terminal row 8 adds one line)
    'keep-json': {
      list: 'quote-v1 quote-v2 quote-v3 quote-v4',
      latest: 'quote-v4',
      named: 'taken quote-v1',
      export: 'export keep → exports/keep (copy, the film)', // moved: fix pass, H2 — named after its file: quote-v1's folders are quote-v1's (before: exports/quote-v1, the real render's)
      exportMcp: 'ExportError: render "keep": through MCP a render is named by its id',
    },
    'keep-json-without': {
      list: 'quote-v1 quote-v2 quote-v3 quote-v4',
      latest: 'quote-v4',
      named: 'taken quote-v1',
      export: 'export quote-v1 → exports/quote-v1 (copy, the film)',
      exportMcp: 'export quote-v1 → exports/quote-v1 (copy, the film)',
    },
    // a record of its own file under a name that is no render id: a terminal's `latest` (D-11: must not move)
    'final-files': {
      list: 'quote-v1 quote-v2 quote-v3 quote-v4 quote-v1.final',
      latest: 'quote-v1.final',
      named: 'taken quote-v1.final',
      export: 'export quote-v1.final → exports/quote-v1.final (copy, the film)',
      exportMcp: 'ExportError: render "quote-v1.final": through MCP a render is named by its id',
    },
  };

  it("every state of the table: the listing, a terminal's `latest`, a render named, its export at a terminal and under trust mcp", async () => {
    const got: Record<string, RRow> = {};
    for (const id of renderStateIds()) {
      const b = rstate(id);
      const row = {} as RRow;
      for (const k of Object.keys(rsites) as Array<keyof typeof rsites>) row[k] = await rsites[k](b);
      got[id] = row;
    }
    expect(got).toEqual(RTABLE);
  }, 240_000);

  it('records as older builds wrote them (fixtures written by hand from the type of their commit): listed, in order, and taken by name', async () => {
    const b = buildRenderState(root, 'ctl', { slug: 'r-past' });
    rmSync(join(b.renders, 'quote-v1.json'));
    const PAST = ['render-l24.json', 'render-l55.json', 'render-l515.json', 'render-l73.json'];
    for (const f of PAST) {
      const value = recordFixture(`past/${f}`) as { id: string };
      writeFileSync(join(b.renders, `${value.id}.json`), `${JSON.stringify(value, null, 2)}\n`);
    }
    const project = await loadProject(b.slug, root);
    const list = await listRenders(project);
    expect(list.map((r) => `${r.id} ${r.status} ${r.encoding?.encoder ?? '-'} ${r.browser?.source} ${r.edit?.from ?? '-'} ${r.policy?.ffmpeg?.used ?? '-'}`)).toEqual([
      'quote-v1 succeeded - remotion - -',
      'quote-v2 succeeded - playwright scenario -',
      'quote-v3 succeeded h264_videotoolbox bundled run -',
      'quote-v4 succeeded libx264 none run library',
    ]);
    // What a version wrote is handed on as the file holds it: every member, in the file's order.
    for (const f of PAST) {
      const value = recordFixture(`past/${f}`) as { id: string };
      const r = await findRenderRecord(project, value.id);
      expect(JSON.stringify(r), f).toBe(JSON.stringify(value));
    }
    expect((await findRenderRecord(project, 'latest', 'quote')).id).toBe('quote-v4');
  });

  it('a video that is missing is said with the path the record names made printable, or — no `file` in the record — in fixed words; through MCP never with the path (L7.6b fix pass)', async () => {
    const b = buildRenderState(root, 'v2', { ...films, slug: 'r-file-words' });
    const file = join(b.renders, 'quote-v2.json');
    const v = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    const exported = async (trust: 'author' | 'mcp'): Promise<string> => {
      try {
        await exportRender({ workPolicy: PERSON_POLICY, project: await loadProject(b.slug, root), root, render: 'quote-v2', formats: ['mp4_1080p'], trust });
        return 'exported';
      } catch (e) {
        return (e as Error).message.replaceAll(root, '<root>');
      }
    };
    writeFileSync(file, JSON.stringify({ ...v, file: join(b.renders, 'gone\u001b[2J\nline.mp4') }));
    expect(await exported('author')).toBe('the video of render quote-v2 is missing (<root>/projects/r-file-words/renders/gone [2J line.mp4)');
    const { file: _f, ...noFile } = v;
    writeFileSync(file, JSON.stringify(noFile));
    expect(await exported('author')).toBe('the video of render quote-v2 is missing (no "file" in its record)');
  });
});
