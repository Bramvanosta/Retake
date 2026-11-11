/**
 * The ids of the domain as the engine accepts, refuses, lists and matches them (L7.5), site by site: run ids (a folder
 * name of runs/), render ids (`<scenario>-v<N>[-vertical|-square]`), job and site ids, theme names. Hand-made folders
 * and records in a temp workspace; nothing is rendered, no browser is opened, no job runs.
 *
 * A row marked `D-<n>` is an outcome a decision of the lot changed; the mark names the decision. A row marked `N-<x>`
 * is an outcome a fix made on the way changed, never a decision: stricter only.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LoadedProject, StoredRenderRecord } from '@retake/core';
import { PERSON_POLICY, projectRenderOf, ulid } from '@retake/core';
import { STARTER_TEMPLATES_DIR, loadProject } from '@retake/core/io';
import type { RenderRecord } from '@retake/editor';
import { APPROVALS_USED_DIR, EngineError, JOB_RECORD_VERSION, LIVE_FILE_VERSION, RunFolder, addComment, checkRunId, checkTemplateName, consumeApprovals, createEngine, listComments, listRuns, openLiveChannel, pruneProject, readLiveChannel, renderForWork, restoreApprovals, selfIdentity, toEngineError } from '../src/index.js';
import type { Engine } from '../src/index.js';
import { recordShapeOk } from '../src/comments/views.js';
import { checkJobId } from '../src/jobs/queue-core.js';
import { checkRenderRequest, renderVersionOf } from '../src/jobs/render-job.js';
import { readListedRecord, renderView } from '../src/renders.js';
import { makeCase, scenesTimeline, workspace } from '../../review/test/helpers.js';
import type { Case, Workspace } from '../../review/test/helpers.js';
import { authorScope } from './helpers.js';
import { capture, writeRun } from './synthetic-runs.js';

const a = (n: number, ch = 'a') => ch.repeat(n);
const STAMP = '20261017-142233-';
const BODY = '01K8AB1CDE2FGH3JKM4NPQ5RST';
const SCENARIO_YAML = 'video: quote\nscenes:\n  - id: one\n    open: /\n    steps:\n      - click: First\n';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

let ws: Workspace;
let themes: string;
let engine: Engine;
let themeEngine: Engine;
let demo: Case;
const savedHome = process.env.RETAKE_HOME;

/** What a call answered: `ok`, or the error's code and message. */
async function outcome(p: Promise<unknown> | (() => unknown)): Promise<string> {
  try {
    await (typeof p === 'function' ? p() : p);
    return 'ok';
  } catch (e) {
    return e instanceof EngineError ? `${e.code}: ${e.message}` : `${(e as Error).name}: ${(e as Error).message}`;
  }
}
const short = (s: string) => s.replace(/(.)\1{30,}/g, (m, ch: string) => `<${m.length} ${ch}>`);

/** A project of the workspace: project.yaml, scenarios/<name>.yaml for each name. */
async function project(slug: string, scenarios: Record<string, string> = {}, yaml = 'name: P\nenvironments:\n  local: {app: "http://app.test"}\ntemplate: editorial\n'): Promise<LoadedProject> {
  const dir = join(ws.root, 'projects', slug);
  await mkdir(join(dir, 'scenarios'), { recursive: true });
  await mkdir(join(dir, 'renders'), { recursive: true });
  await writeFile(join(dir, 'project.yaml'), yaml);
  for (const [name, text] of Object.entries(scenarios)) await writeFile(join(dir, 'scenarios', `${name}.yaml`), text);
  return loadProject(slug, ws.root);
}

/** runs/<id>/run.json, written by hand. */
async function run(dir: string, id: string, o: { scenario?: string; mode?: 'capture' | 'dry'; status?: string } = {}): Promise<void> {
  const d = join(dir, 'runs', id);
  await mkdir(d, { recursive: true });
  await writeFile(
    join(d, 'run.json'),
    JSON.stringify({ version: 1, id, project: 'p', scenario: o.scenario ?? 'quote', mode: o.mode ?? 'dry', status: o.status ?? 'succeeded', started_at: '2026-10-20T10:00:00.000Z', finished_at: '2026-10-20T10:01:00.000Z', dir: d, env: 'local', options: { hooks: 'run', headed: false }, steps_total: 1, steps_done: 1, screenshots: [], hooks: { setup: 'none', teardown: 'none' }, warnings: [] }),
  );
}

/** renders/<file>.json, written by hand: a record of `id` (the file's base name unless `file` says otherwise), with a plan (L7.6b: a record without its plan is in no list). */
async function record(dir: string, id: string, o: Partial<RenderRecord> & { file_name?: string } = {}): Promise<void> {
  const { file_name, ...rest } = o;
  const scenario = id.replace(/-v\d+(-vertical|-square)?$/, '');
  await writeFile(join(dir, 'renders', `${file_name ?? id}.json`), JSON.stringify({ version: 1, id, scenario, run_id: '20261017-142233-quote', status: 'succeeded', created_at: '2026-10-20T11:00:00.000Z', variant: 'landscape', template: 'editorial', plan: {}, ...rest }));
}

beforeAll(async () => {
  ws = await workspace();
  process.env.RETAKE_HOME = join(ws.root, '.home');
  demo = await makeCase(ws, 'quote', scenesTimeline([5, 5]), { noVideo: true });
  engine = await createEngine({ root: ws.root, client: 'test', autoStartWorker: false });
  themes = await mkdtemp(join(tmpdir(), 'retake-ids-themes-'));
  await writeFile(join(themes, 'retake.yaml'), 'version: 1\nprojects_dir: projects\ntemplates_dir: templates\n');
  await mkdir(join(themes, 'projects'), { recursive: true });
  themeEngine = await createEngine({ root: themes, client: 'ui', autoStartWorker: false });
}, 120_000);

afterAll(async () => {
  if (savedHome === undefined) delete process.env.RETAKE_HOME;
  else process.env.RETAKE_HOME = savedHome;
  await ws?.cleanup();
  if (themes) await rm(themes, { recursive: true, force: true });
});

// ── The checks of a name ─────────────────────────────────────────────────────

describe('the checks a client\'s names go through', () => {
  it('a run id: the folder grammar, at most 200 characters, a string', async () => {
    const rows: Array<[unknown, boolean]> = [
      [`${STAMP}quote`, true],
      [`${STAMP}Quote`, true],
      [`${STAMP}quote.bak`, true],
      [STAMP, true],
      ['zz-quote', true],
      ['quote', true],
      ['a..b', true],
      [a(200), true],
      [a(201), false],
      ['.tmp-quote', false],
      ['-quote', false],
      ['a/b', false],
      ['..', false],
      ['', false],
      [`${STAMP}quote\n`, false],
      [`${STAMP}qu\u0000ote`, false],
      [`\uff120261017-142233-quote`, false],
      [7, false],
      [undefined, false],
      [[`${STAMP}quote`], false],
    ];
    expect(rows.map(([v]) => { try { return checkRunId(v as string) === v; } catch { return false; } })).toEqual(rows.map((r) => r[1]));
    expect(await outcome(() => checkRunId('a/b'))).toBe('invalid: invalid run id "a/b": a folder name of runs/ (e.g. 20261017-142233-quote), never a path');
  });

  it('a theme name: the any-case grammar, at most 100 characters, a string', async () => {
    const rows: Array<[unknown, boolean]> = [
      ['editorial', true],
      ['My_Theme', true],
      [a(100), true],
      [a(100, 'A'), true],
      [a(101), false],
      ['a.b', false],
      ['', false],
      ['-x', false],
      ['../x', false],
      ['x\n', false],
      [7, false],
    ];
    expect(rows.map(([v]) => { try { return checkTemplateName(v as string) === v; } catch { return false; } })).toEqual(rows.map((r) => r[1]));
    expect(await outcome(() => checkTemplateName('a.b'))).toBe('invalid: invalid theme "a.b": a theme name (template_list names them), never a path');
    // A render request names its theme the same way.
    const req = (template: unknown) => outcome(() => checkRenderRequest({ project: 'demo', scenario: 'quote', template: template as string }));
    expect(await Promise.all([a(100), a(101), 'a.b', 7].map(req))).toEqual([
      'ok',
      `invalid: invalid theme "${a(101)}": a theme name (template_list names them), never a path`,
      'invalid: invalid theme "a.b": a theme name (template_list names them), never a path',
      'invalid: invalid theme "7": a theme name (template_list names them), never a path',
    ]);
  });

  it('a job id: j_ and 26 Crockford characters', async () => {
    const rows: Array<[string, boolean]> = [
      [`j_${BODY}`, true],
      [`j_${BODY.slice(0, 25)}`, false],
      [`j_${BODY}0`, false],
      [`j_${BODY.toLowerCase()}`, false],
      [`j_U${BODY.slice(1)}`, false],
      [`p_${BODY}`, false],
      [`j_${BODY}\n`, false],
      [`../j_${BODY}`, false],
      ['', false],
    ];
    expect(rows.map(([v]) => { try { return checkJobId(v) === v; } catch { return false; } })).toEqual(rows.map((r) => r[1]));
    expect(await outcome(() => checkJobId('j_x'))).toBe('invalid: invalid job id "j_x": j_ followed by 26 characters (job_list names them)');
    // A string only: a value that merely prints as a job id is refused.
    expect(await outcome(() => checkJobId([`j_${BODY}`] as unknown as string))).toBe(`invalid: invalid job id "j_${BODY}": j_ followed by 26 characters (job_list names them)`); // N-s
    expect(await outcome(engine.jobs.get('j_x'))).toBe('invalid: invalid job id "j_x": j_ followed by 26 characters (job_list names them)');
  });

  it('the version and variant a render id names, for its scenario', () => {
    const of = (id: string, scenario: string) => {
      try {
        const r = renderVersionOf(id, scenario);
        return `${r.version} ${r.variant}`;
      } catch (e) {
        return (e as EngineError).message;
      }
    };
    const not = (id: string, scenario: string) => `render id ${id} is not a render of scenario ${scenario}`;
    // L7.5 D-6: a version is at most 999999. N-b: the id is a render id (a scenario name, then -v<N>).
    const rows: Array<[string, string, string]> = [
      ['quote-v3', 'quote', '3 landscape'],
      ['quote-v3-vertical', 'quote', '3 vertical'],
      ['quote-v3-square', 'quote', '3 square'],
      ['quote-v0', 'quote', '0 landscape'],
      ['quote-v007', 'quote', '7 landscape'],
      ['quote-v999999', 'quote', '999999 landscape'],
      ['quote-v1000000', 'quote', not('quote-v1000000', 'quote')], // D-6
      ['quote-v9007199254740993', 'quote', not('quote-v9007199254740993', 'quote')], // D-6
      ['quote-v2-v1', 'quote-v2', '1 landscape'],
      ['quote-v2-v1', 'quote', not('quote-v2-v1', 'quote')],
      ['Quote-v1', 'quote', not('Quote-v1', 'quote')],
      ['quote-v1', 'Quote', not('quote-v1', 'Quote')],
      ['mobile-quote-v1', 'quote', not('mobile-quote-v1', 'quote')],
      ['quote', 'quote', not('quote', 'quote')],
      ['quote-v1-tall', 'quote', not('quote-v1-tall', 'quote')],
      ['quote-v1-vertical-square', 'quote', not('quote-v1-vertical-square', 'quote')],
      ['-v1', '', not('-v1', '')], // N-b
    ];
    expect(rows.map(([id, s]) => of(id, s))).toEqual(rows.map((r) => r[2]));
  });
});

// ── Run folders ──────────────────────────────────────────────────────────────

/** Folder names of runs/ a disk can hold, each a finished dry run of `quote` (a case-insensitive disk: one case each). */
const RUN_FOLDERS = [
  `${STAMP}quote`,
  '20261017-142234-Quote',
  '20261017-142235-quote.bak',
  '20261017-142236-quote_2',
  '20261017-142237-',
  '20261017-142238-a--b',
  '20261017-142239-quote-',
  '2026101-142233-quote',
  'my-take-quote',
  'zz-quote',
  'quote',
  'a..b',
  `20261017-142240-${a(184)}`, // 200 characters, the dated shape
  `20261017-142241-${a(185)}`, // 201 characters, the dated shape
  a(200, 'b'),
  a(201, 'c'),
  '.tmp-quote',
  '-quote',
  '20261017-142242-quote\n',
  `\uff120261017-142243-quote`,
];

describe('run folders', () => {
  let p: LoadedProject;
  beforeAll(async () => {
    p = await project('runs-table', { quote: SCENARIO_YAML });
    for (const id of RUN_FOLDERS) await run(p.dir, id);
    await mkdir(join(p.dir, 'runs', 'no-record'), { recursive: true });
    await writeFile(join(p.dir, 'runs', 'a-file'), '');
  });

  it('the run list holds the folders whose name is a run id', async () => {
    const listed = (await listRuns(p, { limit: 100 })).map((r) => short(r.id)).sort();
    expect(listed).toEqual(
      [
        `${STAMP}quote`,
        '20261017-142234-Quote',
        '20261017-142235-quote.bak',
        '20261017-142236-quote_2',
        '20261017-142237-',
        '20261017-142238-a--b',
        '20261017-142239-quote-',
        '2026101-142233-quote',
        'my-take-quote',
        'zz-quote',
        'quote',
        'a..b',
        '20261017-142240-<184 a>',
        '<200 b>',
        // D-1: the two folders of 201 characters ('20261017-142241-<185 a>', '<201 c>') are not run ids.
      ].sort(),
    );
  });

  it('a run folder opens by its id: the grammar, at most 200 characters, a real folder of the project', async () => {
    const opened: string[] = [];
    for (const id of [...RUN_FOLDERS, 'no-record', 'a-file', 'missing', '..', '']) if (await RunFolder.open(p.dir, id)) opened.push(short(id));
    expect(opened).toEqual([
      `${STAMP}quote`,
      '20261017-142234-Quote',
      '20261017-142235-quote.bak',
      '20261017-142236-quote_2',
      '20261017-142237-',
      '20261017-142238-a--b',
      '20261017-142239-quote-',
      '2026101-142233-quote',
      'my-take-quote',
      'zz-quote',
      'quote',
      'a..b',
      '20261017-142240-<184 a>',
      '<200 b>',
      'no-record',
    ]);
  });

  it('the status of a run and its poster refuse an id past 200 characters', async () => {
    expect(short(await outcome(engine.runs.status('runs-table', a(201, 'c'))))).toBe('invalid: invalid run id "<201 c>": a folder name of runs/ (e.g. 20261017-142233-quote), never a path');
    expect(short(await outcome(engine.runs.poster('runs-table', a(201, 'c'))))).toBe('invalid: invalid run id "<201 c>": a folder name of runs/ (e.g. 20261017-142233-quote), never a path');
    expect(await engine.runs.poster('runs-table', a(200, 'b'))).toEqual({ run: a(200, 'b'), key: null });
  });

  it('a live channel is opened for a run id only', async () => {
    const open = (runId: string) => outcome(openLiveChannel({ files: { live: () => join(p.dir, 'never-written.json') }, jobId: `j_${BODY}`, runId, worker: { pid: process.pid, started: '' } as never }));
    expect((await Promise.all([a(201), '.tmp-quote', 'a/b', ''].map(open))).map(short)).toEqual(['Error: invalid run id "<201 a>"', 'Error: invalid run id ".tmp-quote"', 'Error: invalid run id "a/b"', 'Error: invalid run id ""']);
    expect(existsSync(join(p.dir, 'never-written.json'))).toBe(false);
  });

  it('a live channel file is read when the run it names is a run id', async () => {
    const me = await selfIdentity();
    const file = join(p.dir, 'live.json');
    const read = async (run: unknown) => {
      await writeFile(file, JSON.stringify({ v: LIVE_FILE_VERSION, job: `j_${BODY}`, run, port: 4999, token: 'a'.repeat(43), pid: me.pid, ...(me.started_at ? { started_at: me.started_at } : {}) }), { mode: 0o600 });
      return (await readLiveChannel({ claimOf: async () => ({ ...me, at: '2026-10-20T10:00:00.000Z' }) as never }, { live: () => file }, `j_${BODY}`)) !== null;
    };
    expect([await read(`${STAMP}quote`), await read(a(200))]).toEqual([true, true]);
    expect([await read(a(201)), await read('.tmp-quote'), await read('a/b'), await read(''), await read(7)]).toEqual([false, false, false, false, false]);
    await rm(file);
  });

  it('pruning considers only the folders whose name is a run id the tool makes', async () => {
    const r = await pruneProject(p);
    expect(r.items.filter((i) => i.kind === 'run').map((i) => [short(i.id), i.reason])).toEqual([
      // Every one a dry run: each folder considered goes.
      [`${STAMP}quote`, 'dry run'],
      ['20261017-142238-a--b', 'dry run'],
      ['20261017-142239-quote-', 'dry run'],
      ['20261017-142240-<184 a>', 'dry run'],
      // D-1: '20261017-142241-<185 a>' (201 characters) is not a run id: not considered.
    ]);
    // Folders that are not considered are not counted as kept either.
    expect(r.kept.runs).toBe(0);
  });
});

describe('the scenario view\'s run argument', () => {
  it('is a run id', async () => {
    await project('view', { quote: SCENARIO_YAML });
    const view = (runId: string) => outcome(engine.scenarios.view('view', 'quote', { run: runId }));
    expect((await Promise.all(['a/b', '.tmp-quote', '', a(200), a(201)].map(view))).map(short)).toEqual([
      'invalid: "a/b" is not a run id',
      'invalid: ".tmp-quote" is not a run id',
      'invalid: "" is not a run id',
      'not_found: run "<200 a>" not found in view (scenario_blocks lists the runs of a scenario)',
      'invalid: "<60 a>" is not a run id', // D-1: 201 characters
    ]);
  });
});

describe('the project board', () => {
  it('reads the takes of the folders whose name is a run id', async () => {
    const p = await project('board-runs', { quote: SCENARIO_YAML });
    await run(p.dir, a(200, 'y'));
    const s = async () => (await engine.projects.board('board-runs')).scenarios.find((x) => x.name === 'quote');
    expect(short((await s())?.last_run?.id ?? '')).toBe('<200 y>');
    await run(p.dir, a(201, 'z'));
    expect(short((await s())?.last_run?.id ?? '')).toBe('<200 y>'); // D-1: 201 characters
    // L7.6a (one order of runs): a dated run is before a folder named by hand, whatever that name sorts as.
    await run(p.dir, `${STAMP}quote`);
    expect((await s())?.last_run?.id).toBe(`${STAMP}quote`);
  });

  it('a scenario whose theme is a folder path: the render of today\'s file is the one shown', async () => {
    const long = a(101, 't');
    const yaml = `${SCENARIO_YAML}template: ./themes/${long}\n`;
    const p = await project('board-theme', { quote: yaml });
    const cap = '20261020-100000-quote';
    await writeRun(p.dir, { ...capture(cap), scenario: 'quote' });
    await record(p.dir, 'quote-v1', { run_id: cap, template: long, created_at: '2026-10-20T11:00:00.000Z', edit: { from: 'scenario', sha256: sha(yaml) } } as Partial<RenderRecord>);
    await record(p.dir, 'quote-v2', { run_id: cap, template: 'editorial', created_at: '2026-10-20T12:00:00.000Z', edit: { from: 'scenario', sha256: sha(yaml) } } as Partial<RenderRecord>);
    const s = (await engine.projects.board('board-theme')).scenarios.find((x) => x.name === 'quote');
    expect(s?.capture?.id).toBe(cap);
    expect(s?.hash).toBe(sha(yaml));
    // One rule for a theme that exists (at most 100 characters): a folder named by a path whose name is longer still
    // loads and renders, and its name is shown on neither side — the row holds no theme, the render's says unknown —;
    // the board compares it by its identity (the folder's name the record holds), so the render of today's theme is
    // the one in the row.
    expect([s?.render?.render_id, s?.render_current]).toEqual(['quote-v1', true]); // L7.8 (BL-164): was quote-v2, the newest render of today's file and take, of another theme
    expect([short(s?.theme ?? '(none)'), short(s?.render?.theme ?? '')]).toEqual(['(none)', 'unknown']); // D-2: 101 characters; L7.8 (BL-164): the render in the row is quote-v1, whose theme says unknown (was quote-v2's editorial)
    expect(((await engine.renders.ofScenario('board-theme', 'quote')).renders.map((r) => [r.render_id, r.theme]))).toEqual([['quote-v2', 'editorial'], ['quote-v1', 'unknown']]); // D-2: 101 characters
    // With a theme folder of 100 characters: its name on both sides, and the older render — the one of today's theme —
    // is shown, not the newest.
    const ok = a(100, 't');
    const yaml2 = `${SCENARIO_YAML}template: ./themes/${ok}\n`;
    const p2 = await project('board-theme-ok', { quote: yaml2 });
    await writeRun(p2.dir, { ...capture(cap), scenario: 'quote' });
    await record(p2.dir, 'quote-v1', { run_id: cap, template: ok, created_at: '2026-10-20T11:00:00.000Z', edit: { from: 'scenario', sha256: sha(yaml2) } } as Partial<RenderRecord>);
    await record(p2.dir, 'quote-v2', { run_id: cap, template: 'editorial', created_at: '2026-10-20T12:00:00.000Z', edit: { from: 'scenario', sha256: sha(yaml2) } } as Partial<RenderRecord>);
    const s2 = (await engine.projects.board('board-theme-ok')).scenarios.find((x) => x.name === 'quote');
    expect([s2?.render?.render_id, short(s2?.theme ?? '(none)'), short(s2?.render?.theme ?? '')]).toEqual(['quote-v1', '<100 t>', '<100 t>']);
  });

  it('a record of renders/ belongs to the scenario its file name ends in -v<N> of', async () => {
    const files = async (dir: string) => {
      await record(dir, 'quote-v3', { created_at: '2026-10-20T11:00:00.000Z' });
      await record(dir, 'quote-v2-v1', { created_at: '2026-10-20T12:00:00.000Z' });
      await record(dir, 'my render-v1', { created_at: '2026-10-20T13:00:00.000Z' });
    };
    const one = await project('files-a', { quote: SCENARIO_YAML });
    await files(one.dir);
    const two = await project('files-b', { quote: SCENARIO_YAML, 'quote-v2': SCENARIO_YAML });
    await files(two.dir);
    const renders = async (slug: string) => Object.fromEntries((await engine.projects.board(slug)).scenarios.map((s) => [s.name, s.render?.render_id ?? null]));
    expect(await renders('files-a')).toEqual({ quote: 'quote-v3' });
    expect(await renders('files-b')).toEqual({ quote: 'quote-v3', 'quote-v2': 'quote-v2-v1' });
    // L7.5 D-6: a record whose version is above 999999 is not a render.
    const big = await project('files-c', { quote: SCENARIO_YAML });
    await files(big.dir);
    await record(big.dir, 'quote-v1000000', { created_at: '2026-10-20T14:00:00.000Z' });
    expect(await renders('files-c')).toEqual({ quote: 'quote-v3' }); // D-6
  });
});

// ── Render records ───────────────────────────────────────────────────────────

describe('render records', () => {
  let p: LoadedProject;
  beforeAll(async () => {
    p = await project('records', { quote: SCENARIO_YAML });
    await record(p.dir, 'quote-v3');
    await record(p.dir, 'quote-v1-vertical', { variant: 'vertical' });
    await record(p.dir, 'quote-v2-v1');
    await record(p.dir, 'Quote-v1');
    await record(p.dir, 'quote-v999999');
    await record(p.dir, 'quote-v1000000');
    await record(p.dir, `${a(197)}-v1`);
    await record(p.dir, `${a(198)}-v1`);
    await record(p.dir, 'final');
    await record(p.dir, 'quote-v7', { file_name: 'quote-v8' });
    await record(p.dir, 'quote-v9', { created_at: 7 as unknown as string });
  });

  it('a file of renders/ is a render record when its id is its file name, a render id', async () => {
    // L7.6b: read by the one reader of renders/, and a render by core's rule (a complete record of its own file whose id is one of its scenario).
    const read = async (file: string): Promise<string | null> => projectRenderOf(await readListedRecord(p.dir, file))?.id ?? null;
    expect((await Promise.all(['quote-v3', 'quote-v1-vertical', 'quote-v2-v1', 'Quote-v1', 'quote-v999999', `${a(197)}-v1`, 'final', 'quote-v8', 'quote-v9', 'missing-v1'].map(read))).map((x) => x && short(x))).toEqual(['quote-v3', 'quote-v1-vertical', 'quote-v2-v1', 'Quote-v1', 'quote-v999999', '<197 a>-v1', null, null, null, null]);
    expect(await read('quote-v1000000')).toBe(null); // D-6
    expect(short((await read(`${a(198)}-v1`)) ?? '(none)')).toBe('(none)'); // D-2: 201 characters
  });

  it('a scenario\'s renders are the records named <scenario>-v<N>[-vertical|-square].json', async () => {
    const ids = (await engine.renders.ofScenario('records', 'quote')).renders.map((r) => r.render_id).sort();
    expect(ids).toEqual(['quote-v1-vertical', 'quote-v3', 'quote-v999999']); // D-6: not 'quote-v1000000'
    expect((await engine.renders.ofScenario('records', 'quote-v2')).renders.map((r) => r.render_id)).toEqual(['quote-v2-v1']);
  });

  it('a render as listed names its take and its theme, or says unknown', () => {
    const view = (extra: Record<string, unknown>) => {
      const v = renderView(p.dir, { version: 1, id: 'quote-v3', scenario: 'quote', status: 'succeeded', created_at: '2026-10-20T11:00:00.000Z', variant: 'landscape', run_id: `${STAMP}quote`, template: 'editorial', ...extra } as unknown as StoredRenderRecord, [], []);
      return [short(v.run_id), short(v.theme)];
    };
    expect(view({})).toEqual([`${STAMP}quote`, 'editorial']);
    expect(view({ run_id: a(200), template: a(100) })).toEqual(['<200 a>', '<100 a>']);
    expect(view({ run_id: 'a/b', template: 'a.b' })).toEqual(['unknown', 'unknown']);
    expect(view({ run_id: 7, template: null })).toEqual(['unknown', 'unknown']);
    expect(view({ run_id: '.tmp-quote', template: '../x' })).toEqual(['unknown', 'unknown']);
    expect(view({ run_id: a(201) })[0]).toBe('unknown'); // D-1: 201 characters
    // The theme is the name of a theme that exists: at most 100 characters, a listed theme's or a folder's alike.
    expect(view({ template: a(100, 'T') })[1]).toBe('<100 T>');
    expect(view({ template: a(101) })[1]).toBe('unknown'); // D-2: 101 characters
  });

  it('a record whose fields a message may quote: a render id, a scenario name, a date, a variant', () => {
    const ok = (extra: Record<string, unknown>) => recordShapeOk({ id: 'quote-v3', scenario: 'quote', created_at: '2026-10-20T11:00:00.000Z', variant: 'landscape', ...extra } as unknown as RenderRecord);
    // L7.6b: the rule is core's quotableRender — the id is one of the scenario the record says (a render id of another scenario is not quoted).
    expect([ok({}), ok({ id: 'final' }), ok({ id: 7 }), ok({ id: `${a(197)}-v1`, scenario: a(197) }), ok({ scenario: 'a.b' }), ok({ variant: 'tall' })]).toEqual([true, false, false, true, false, false]);
    expect(ok({ id: `${a(197)}-v1` })).toBe(false);
    expect(ok({ id: `${a(198)}-v1` })).toBe(false); // D-2: 201 characters
    expect(ok({ id: 'quote-v1000000' })).toBe(false); // D-6
  });

  it('work on a render names it by its id, or latest', async () => {
    const work = (id: string) => outcome(renderForWork(p, id));
    const status = (id: string) => outcome(engine.renders.status('records', id));
    const invalid = (id: string) => `invalid: invalid render id "${id}": <scenario>-v<N> (render returns it), or "latest"`;
    for (const call of [work, status]) {
      expect((await Promise.all(['final', 'quote', 'a/b-v1', '', `${a(198)}-v1`].map(call))).map(short)).toEqual(['final', 'quote', 'a/b-v1', '', '<198 a>-v1'].map(invalid));
    }
    expect(await work('quote-v5')).toBe('not_found: render "quote-v5" not found in records (no renders/quote-v5.json): render_status says whether it is still running');
    expect(await status('quote-v5')).toBe('not_found: render "quote-v5" not found in records (no job, no renders/quote-v5.json): render starts one');
    // L7.5 D-6: a version above 999999 is not a render id.
    expect(await work('quote-v2000000')).toBe(invalid('quote-v2000000')); // D-6
    expect(await status('quote-v2000000')).toBe(invalid('quote-v2000000')); // D-6
  });

  it('latest names a render a by-id call takes: a record or a job that is no render of its scenario is never the newest', async () => {
    const q = await project('latest', { quote: SCENARIO_YAML });
    // A record as a listing of renders/ keeps it: with a plan.
    const made = (id: string, o: Partial<RenderRecord> & { file_name?: string }) => record(q.dir, id, { plan: { fps: 30 }, ...o } as unknown as Partial<RenderRecord>);
    const newest = async (scenario?: string) => {
      try {
        return (await engine.renders.status('latest', 'latest', scenario === undefined ? {} : { scenario })).render_id;
      } catch (e) {
        return `${(e as EngineError).code}: ${(e as Error).message}`;
      }
    };
    const work = (scenario?: string) => outcome(renderForWork(q, 'latest', scenario === undefined ? {} : { scenario }));
    const NONE = { status: 'not_found: no render of latest yet: render starts one', statusOf: 'not_found: no render of latest · quote yet: render starts one', work: 'not_found: no finished render of latest yet: render makes one', workOf: 'not_found: no finished render of latest · quote yet: render makes one' };
    // Newer than any render, and renders of their scenario nowhere: a version past the highest, a name of its own,
    // a name past 200 characters, another scenario's name.
    await made('quote-v1000000', { created_at: '2026-10-21T10:00:00.000Z' });
    await made('final', { scenario: 'quote', created_at: '2026-10-21T11:00:00.000Z' });
    await made(`${a(198)}-v1`, { file_name: 'long', scenario: a(198), created_at: '2026-10-21T12:00:00.000Z' });
    await made('other-v7', { scenario: 'quote', created_at: '2026-10-21T13:00:00.000Z' });
    expect([await newest(), await newest('quote'), await work(), await work('quote')]).toEqual([NONE.status, NONE.statusOf, NONE.work, NONE.workOf]);
    // A render of quote, older than all of them: it is the newest.
    await made('quote-v4', { created_at: '2026-10-20T11:00:00.000Z' });
    expect([await newest(), await newest('quote')]).toEqual(['quote-v4', 'quote-v4']);
    for (const w of [await work(), await work('quote')]) expect(w).toContain('quote-v4');
    // What latest names, the by-id calls take.
    expect((await engine.renders.status('latest', 'quote-v4')).render_id).toBe('quote-v4');
    expect(await outcome(renderForWork(q, 'quote-v4'))).toBe(await work());
    // A render job whose render id is not one of its scenario is not the newest either.
    const job = `j_${ulid()}`;
    await mkdir(join(ws.root, '.retake', 'jobs', job), { recursive: true });
    const input = { version: 1, kind: 'render', project: 'latest', scenario: 'quote', run_id: `${STAMP}quote`, render_id: 'other-v8', submitted_by: 'test' };
    await writeFile(join(ws.root, '.retake', 'jobs', job, 'job.json'), JSON.stringify({ version: JOB_RECORD_VERSION, id: job, kind: 'render', input, state: 'queued', created_at: '2026-10-22T10:00:00.000Z' }));
    expect((await engine.jobs.list({ project: 'latest' })).map((j) => j.id)).toEqual([job]);
    expect([await newest(), await newest('quote')]).toEqual(['quote-v4', 'quote-v4']);
    await rm(join(ws.root, '.retake', 'jobs', job), { recursive: true });
  });
});

// ── Reviews, comments and frames of a render ─────────────────────────────────

describe('a render\'s review, comments and frames', () => {
  it('a review names the render it was compared with by its id, or says unknown', async () => {
    const dir = join(ws.project.dir, 'review', 'quote-v1');
    await mkdir(dir, { recursive: true });
    const previous = async (value: unknown) => {
      await writeFile(join(dir, 'report.json'), JSON.stringify({ version: 1, findings: [], diff: { previous: value } }));
      const v = await engine.reviews.get('demo', 'quote-v1');
      return [short(String(v.diff?.previous)), v.untrusted.diff_previous === undefined ? 'trusted' : 'held'];
    };
    expect(await previous('quote-v0')).toEqual(['quote-v0', 'trusted']);
    expect(await previous('final')).toEqual(['unknown', 'held']);
    expect(await previous(7)).toEqual(['unknown', 'held']);
    expect(await previous(`${a(197)}-v1`)).toEqual(['<197 a>-v1', 'trusted']);
    expect(await previous(`${a(198)}-v1`)).toEqual(['unknown', 'held']); // D-2: 201 characters
    expect(await previous('quote-v1000000')).toEqual(['unknown', 'held']); // D-6
    await rm(dir, { recursive: true, force: true });
  });

  it('a review image and a review job name renders by their id', async () => {
    const image = (id: string) => outcome(engine.reviews.image('demo', id, 'sheet_1.jpg'));
    expect((await Promise.all(['final', `${a(198)}-v1`].map(image))).map(short)).toEqual(['invalid: invalid render id "final": <scenario>-v<N>', 'invalid: invalid render id "<198 a>-v1": <scenario>-v<N>']);
    expect(await image('quote-v2000000')).toBe('invalid: invalid render id "quote-v2000000": <scenario>-v<N>'); // D-6
    const submit = (previous: unknown) => outcome(engine.reviews.submit({ project: 'demo', render_id: 'quote-v1', previous: previous as string }));
    expect(await submit('final')).toBe('invalid: invalid previous "final": a render id, or false for no comparison');
    expect(await submit(7)).toBe('invalid: invalid previous "7": a render id, or false for no comparison');
    // L7.5 D-2, D-6: a previous past 200 characters, or of a version above 999999, is not a render id.
    expect(short(await submit(`${a(198)}-v1`))).toBe('invalid: invalid previous "<198 a>-v1": a render id, or false for no comparison'); // D-2: 201 characters
    expect(await submit('quote-v2000000')).toBe('invalid: invalid previous "quote-v2000000": a render id, or false for no comparison'); // D-6
    expect(await engine.jobs.list({ project: 'demo' })).toEqual([]);
  });

  it('comments are listed for a render named by its id', async () => {
    const list = (render: string) => outcome(listComments(ws.project, { render }));
    expect(await list('quote-v1')).toBe('ok');
    expect((await Promise.all(['final', `${a(198)}-v1`].map(list))).map(short)).toEqual(['invalid: invalid render id "final": <scenario>-v<N>, or "latest"', 'invalid: invalid render id "<80 a>": <scenario>-v<N>, or "latest"']);
    expect(await list('quote-v2000000')).toBe('invalid: invalid render id "quote-v2000000": <scenario>-v<N>, or "latest"'); // D-6
  });

  it('a thread file whose scenario is not a scenario name is reported, and the others are listed', async () => {
    const thread = (scenario: string) => ({
      version: 1,
      id: `c_${BODY}`,
      scenario,
      render: { id: 'quote-v1', created_at: demo.record.created_at, run_id: demo.run.id, variant: 'landscape', fps: 30, frames: 300, width: 1920, height: 1080 },
      frame: 10,
      time_s: 0.33,
      text: 'A comment',
      author: { via: 'cli', name: 'Reviewer' },
      created_at: '2026-10-20T10:00:00.000Z',
      anchor: { segment: 'intro', kind: 'intro' },
      entries: [],
    });
    const dir = join(ws.project.dir, 'comments', 'quote');
    await mkdir(dir, { recursive: true });
    const listed = async (scenario: string) => {
      await writeFile(join(dir, `c_${BODY}.json`), JSON.stringify(thread(scenario)));
      try {
        const r = await listComments(ws.project, { status: 'all' });
        return `${r.threads.length} listed, ${r.problems?.length ?? 0} reported`;
      } catch (e) {
        return `throws ${(e as Error).name}`;
      }
    };
    expect(await listed('quote')).toBe('1 listed, 0 reported');
    // A file of the folder whose name is not a thread id + ".json" is no thread: neither listed nor reported.
    for (const other of ['notes.json', `c_${BODY.slice(0, 25)}.json`, `j_${BODY}.json`, `c_${BODY}.json.tmp`]) await writeFile(join(dir, other), JSON.stringify(thread('quote')));
    expect(await listed('quote')).toBe('1 listed, 0 reported');
    expect(await listed('a.b')).toBe('0 listed, 1 reported');
    // L7.5 N-c (row of part A): the scenario of a thread file is compared as text.
    expect(await listed('a(')).toBe('0 listed, 1 reported'); // N-c
    await rm(join(ws.project.dir, 'comments'), { recursive: true, force: true });
  });

  it('a comment and a frame are of a record whose id is <its scenario>-v<N>', async () => {
    // A hand-edited record: the id of a render of "quote-v2", the scenario "quote".
    const mixed = { ...demo.record, id: 'quote-v2-v1', file: join(ws.project.dir, 'renders', 'quote-v2-v1.mp4'), record: join(ws.project.dir, 'renders', 'quote-v2-v1.json') };
    await writeFile(mixed.file, '');
    await writeFile(mixed.record, JSON.stringify(mixed));
    const add = (render: string) => outcome(addComment(ws.project, { render, frame: 10, text: 'A comment' }, { via: 'cli', name: 'Reviewer' }, authorScope(ws.project, { via: 'cli', name: 'Reviewer' }), PERSON_POLICY));
    const frame = (render: string) => outcome(engine.renders.frame('demo', { render_id: render, created_at: demo.record.created_at, frame: 0 }));
    // L7.5 D-5: the id is the scenario's exactly, not by its start.
    expect(await add('quote-v2-v1')).toBe('invalid: render quote-v2-v1 has no <scenario>-v<N> id (written with --out?): only renders of renders/ take comments'); // D-5
    expect(await frame('quote-v2-v1')).toBe('refused: renders/quote-v2-v1.json has an id, scenario, created_at or variant the tool never writes: not used'); // D-5
    // (The videos here are empty files: a frame request that passed the checks of the record stops at the video.)
    expect(await frame('quote-v1')).toBe('invalid: the video of render quote-v1 cannot be read (ffprobe): not shown');
    expect(await frame('final')).toBe('invalid: invalid render id "final": <scenario>-v<N> (the renders list names them)');
    expect(await frame('quote-v2000000')).toBe('invalid: invalid render id "quote-v2000000": <scenario>-v<N> (the renders list names them)'); // D-6
    expect(short(await frame(`${a(198)}-v1`))).toBe('invalid: invalid render id "<80 a>": <scenario>-v<N> (the renders list names them)');
    // The same file as a render of "quote-v2": accepted by both.
    await writeFile(mixed.record, JSON.stringify({ ...mixed, scenario: 'quote-v2' }));
    expect(await add('quote-v2-v1')).toBe('ok');
    expect(await frame('quote-v2-v1')).toBe('invalid: the video of render quote-v2-v1 cannot be read (ffprobe): not shown');
    await rm(mixed.file);
    await rm(mixed.record);
    await rm(join(ws.project.dir, 'comments'), { recursive: true, force: true });
  });

  it('a plan names the next free render id of its scenario', async () => {
    const plan = await engine.renders.plan({ project: 'demo', scenario: 'quote', run_id: demo.run.id });
    expect(plan.next_render_id).toBe('quote-v2');
    // With the suffix of the variant planned: the id a vertical or a square render gets (the versions are shared).
    const next = async (variant: 'landscape' | 'vertical' | 'square') => {
      const p = await engine.renders.plan({ project: 'demo', scenario: 'quote', run_id: demo.run.id, overrides: { variant } });
      return [p.variant, p.next_render_id];
    };
    expect([await next('landscape'), await next('vertical'), await next('square')]).toEqual([['landscape', 'quote-v2'], ['vertical', 'quote-v2-vertical'], ['square', 'quote-v2-square']]);
  });

  it('a file of renders/ that claims the highest version or more: a plan and a render are refused with its name', async () => {
    const dir = join(ws.project.dir, 'renders');
    const req = { project: 'demo', scenario: 'quote', run_id: demo.run.id };
    for (const digits of ['999999', '9007199254740992']) {
      const planted = join(dir, `quote-v${digits}.json`);
      await writeFile(planted, '{}');
      const before = (await readdir(dir)).sort();
      const refusal = `renders/ holds quote-v${digits}.json, which claims version ${digits} of quote: the highest version is 999999. Remove or rename that file, then render again.`;
      // The editor's refusal, as a client is told it (its kind and its sentence).
      const told = (p: Promise<unknown>) => p.then(() => 'ok', (e: unknown) => `${toEngineError(e).code}: ${toEngineError(e).message}`);
      expect(await told(engine.renders.plan(req))).toBe(`invalid: ${refusal}`);
      expect(await told(engine.renders.submit(req))).toBe(`invalid: ${refusal}`);
      // Nothing is queued, no lock is left.
      expect(await engine.jobs.list({ project: 'demo' })).toEqual([]);
      expect((await readdir(dir)).sort()).toEqual(before);
      await rm(planted);
    }
    // One below the highest version: the plan names the last id there is.
    const last = join(dir, 'quote-v999998.json');
    await writeFile(last, '{}');
    expect((await engine.renders.plan(req)).next_render_id).toBe('quote-v999999');
    await rm(last);
    expect((await engine.renders.plan(req)).next_render_id).toBe('quote-v2');
  });
});

// ── Pruning renders ──────────────────────────────────────────────────────────

describe('pruning: the files of a render that goes', () => {
  const names = (paths: string[]) => paths.map((x) => x.slice(x.lastIndexOf('/') + 1)).sort();
  const renderItems = async (p: LoadedProject) => (await pruneProject(p)).items.filter((i) => i.kind === 'render').map((i) => [i.id, names(i.paths)]);
  const failed = { status: 'failed', plan: { fps: 30 } } as unknown as Partial<RenderRecord>;

  it('a render that goes takes its record, its video and its other files', async () => {
    const p = await project('prune-own');
    await record(p.dir, 'quote-v1', failed);
    for (const f of ['quote-v1.mp4', 'quote-v1.partial.mp4', 'quote-v10.mp4', 'quote-v1-vertical.mp4', '.quote-v1.lock']) await writeFile(join(p.dir, 'renders', f), 'x');
    expect(await renderItems(p)).toEqual([['quote-v1', ['quote-v1.json', 'quote-v1.mp4', 'quote-v1.partial.mp4']]]);
  });

  it('a record written with another name in renders/ goes when it is old, with its own files', async () => {
    const p = await project('prune-out');
    await record(p.dir, 'final', failed);
    await writeFile(join(p.dir, 'renders', 'final.mp4'), 'x');
    await writeFile(join(p.dir, 'renders', 'finale.mp4'), 'x');
    expect(await renderItems(p)).toEqual([['final', ['final.json', 'final.mp4']]]);
  });

  it('a record whose id is not its file\'s name', async () => {
    const p = await project('prune-other');
    await record(p.dir, 'quote-v7', { ...failed, file_name: 'quote-v8' });
    await writeFile(join(p.dir, 'renders', 'quote-v7.mp4'), 'x');
    await writeFile(join(p.dir, 'renders', 'quote-v8.mp4'), 'x');
    // L7.6b (D-10, R-1): a render is the record of its own file — this one is left alone, and no path of an item
    // comes from the id a file says (before: an item `quote-v7` whose one path was another file's video).
    expect(await renderItems(p)).toEqual([]);
  });

  it('a record whose id is empty, starts with a dot or holds a separator', async () => {
    const files = ['.quote-v3.lock', '.quote-v3.partial.mp4', '.catalogue-v1.lock', 'quote-v3.mp4', 'x.mp4'];
    const of = async (slug: string, id: string) => {
      const p = await project(slug);
      await record(p.dir, id, { ...failed, file_name: 'x' });
      for (const f of files) await writeFile(join(p.dir, 'renders', f), 'x');
      return renderItems(p);
    };
    // L7.5 D-8: an id that is empty or starts with a dot names no render's files — its record is no item.
    expect(await of('prune-empty', '')).toEqual([]); // D-8
    expect(await of('prune-dot', '.quote-v3')).toEqual([]); // D-8
    expect(await of('prune-up', '..')).toEqual([]); // D-8
    // An id that holds a separator is the name of no file of renders/: its record is left alone (L7.6b; before: an item without a path).
    expect(await of('prune-sep', 'a/b')).toEqual([]);
  });
});

// ── Theme names ──────────────────────────────────────────────────────────────

describe('a new theme\'s name, and a theme that exists under a long one', () => {
  it('a copy takes a lower-case name of at most 60 characters', async () => {
    const copy = (name: unknown) => outcome(themeEngine.templates.copy({ from: 'editorial', name: name as string }));
    const invalid = (name: string) => `invalid: invalid theme name "${name.slice(0, 80)}": lower-case letters, digits and dashes (e.g. my-brand)`;
    expect(await copy('My_Theme')).toBe(invalid('My_Theme'));
    expect(await copy('a.b')).toBe(invalid('a.b'));
    expect(await copy('')).toBe(invalid(''));
    expect(await copy(7)).toBe(invalid('7'));
    expect(await copy(a(65))).toBe(invalid(a(65)));
    expect(await copy(a(101))).toBe(invalid(a(101)));
    // L7.5 D-3: a new theme's name holds at most 60 characters, whatever creates it.
    expect(await copy(a(61, 'b'))).toBe(invalid(a(61, 'b'))); // D-3
    expect(await copy(a(64, 'c'))).toBe(invalid(a(64, 'c'))); // D-3
    expect(existsSync(join(themes, 'templates'))).toBe(false);
    expect(await copy(a(60))).toBe('ok');
    expect((await readdir(join(themes, 'templates'))).map(short).sort()).toEqual(['<60 a>']); // D-3
  });

  it('a theme folder of 80 lower-case characters is listed, opened, named by a render request and copied from', async () => {
    const long = a(80, 'l');
    await mkdir(join(themes, 'templates'), { recursive: true });
    await cp(join(STARTER_TEMPLATES_DIR, 'editorial'), join(themes, 'templates', long), { recursive: true });
    const yaml = join(themes, 'templates', long, 'template.yaml');
    await writeFile(yaml, (await readFile(yaml, 'utf8')).replace('name: editorial', `name: ${long}`));
    expect((await themeEngine.templates.list()).templates.map((t) => t.name)).toContain(long);
    expect((await themeEngine.templates.get({ template: long })).name).toBe(long);
    expect(await outcome(() => checkRenderRequest({ project: 'demo', scenario: 'quote', template: long }))).toBe('ok');
    expect(await outcome(themeEngine.templates.copy({ from: long, name: 'from-long' }))).toBe('ok');
  });
});

// ── The time in an id ────────────────────────────────────────────────────────

describe('the time a site extraction\'s id holds', () => {
  it('is read from its first ten characters', async () => {
    const root = join(themes, '.retake', 'site');
    const ids = [`s_01K8AB1CDE${a(16, '0')}`, `s_${a(26, '0')}`, `s_${a(26, 'Z')}`, `s_${BODY.slice(0, 25)}`, `s_U${BODY.slice(1)}`, `j_${BODY}`];
    for (const id of ids) await mkdir(join(root, id), { recursive: true });
    const sites = (await themeEngine.templates.sites()).sites.map((s) => [s.site_id, s.at ?? null]);
    expect(sites).toEqual([
      [`s_${a(26, 'Z')}`, '+037648-05-06T22:07:22.623Z'],
      [`s_01K8AB1CDE${a(16, '0')}`, '2025-10-24T05:28:35.502Z'],
      [`s_${a(26, '0')}`, null],
    ]);
  });
});

describe('the time a job id holds, for the approvals a claim takes', () => {
  const approvals = [{ fingerprint: 'b'.repeat(64), by: 'human-elicitation' as const, at: '2026-10-17T12:00:00.000Z' }];
  const rec = (id: string) => ({ id, input: { version: 1, kind: 'hooks', project: 'w', source: 'hooks/x.yaml', dry: false, submitted_by: 'mcp', approvals } as never });

  it('is read of a job id only: any other text takes no approval and writes no record', async () => {
    const home = join(ws.root, 'approvals-home');
    const env = { ...process.env, RETAKE_HOME: home };
    const at = Date.parse('2025-10-24T05:28:35.502Z'); // the time in 01K8AB1CDE…
    const used = async () => (await readdir(join(home, APPROVALS_USED_DIR), { recursive: true }).catch(() => [] as string[])).sort();
    // Not job ids: another prefix, a prefix that is a path, a body of 25 or 27 characters, a letter that is no digit of a ULID.
    for (const id of [`s_${BODY}`, `xx${BODY}`, `a/${BODY}`, `..${BODY}`, `j_${BODY.slice(0, 25)}`, `j_${BODY}0`, `j_U${BODY.slice(1)}`, `j_${BODY.toLowerCase()}`, `j_${BODY}\n`, '']) {
      expect(await consumeApprovals(rec(id), env, at), JSON.stringify(id)).toBe(false);
    }
    expect(await used()).toEqual([]);
    // A job id: taken once; a year and a day after the time its id holds, no more.
    expect(await consumeApprovals(rec(`j_${BODY}`), env, at + 365 * 24 * 3600_000 + 24 * 3600_000)).toBe(false);
    expect(await consumeApprovals(rec(`j_${BODY}`), env, at + 1000)).toBe(true);
    expect(await consumeApprovals(rec(`j_${BODY}`), env, at + 2000)).toBe(false);
    expect(await used()).toEqual([`j_${BODY}`]);
    // Giving back and cleaning read job ids only.
    await restoreApprovals(`../${APPROVALS_USED_DIR}/j_${BODY}`, env);
    expect(await used()).toEqual([`j_${BODY}`]);
    await restoreApprovals(`j_${BODY}`, env);
    expect(await used()).toEqual([]);
  });
});
