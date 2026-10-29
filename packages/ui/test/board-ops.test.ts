/**
 * L5.10a part A: `project_board` — the Project screen's read over HTTP (allow-list, READ, Studio-only, path-free, the
 * titles under `untrusted`) and its facts on a fixture copy: a capture (current, poster, length), a render and its
 * review (sameVersion: "Rendered"), a newer capture ("Render outdated"), a failed take ("Failed at step 2 of one"), a
 * filmed change ("Script changed since the shoot"), a never-run scenario ("Not shot yet"). Its memos are its own: a
 * board read leaves the open scenario screen's view memo untouched (critique H1). Budgets on the fixture (15
 * scenarios) and on a 40-scenario copy with 30 runs: cold ≤ 1.5 s, warm ≤ 150 ms measured (pinned loosely here).
 * L5.10a fixes (reviews A and B), on the board itself (ProjectBoards with its counters): a removed asset shows at once
 * and anything else within the TTL (A-M1); an environment the project lacks only under `untrusted`, capped (A-M2); one
 * pass over a 3000-job queue, warm ≤ 20 ms measured, no second pass for a take from a terminal (A-M3); older runs
 * summed up once (A-L2); report.json read once (A-L3); review/ watched (A-L4); the render that shows today's file wins
 * over a newer override, today's theme counts (B-L2); a failed take's poster is its error screenshot (B-L5).
 */
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadWorkspaceConfig } from '@demo-studio/core';
import type { WorkspaceConfig } from '@demo-studio/core';
import { FILE_FACTS_TTL_MS, FileJobQueue, ProjectBoards, ScenarioViews, openProjectBySlug, reportReads, scanSources } from '@demo-studio/engine';
import type { BoardScenario, ProjectBoardView } from '@demo-studio/engine';
import { OWN_OPS, UI_OPS, startStudioServer } from '../src/index.js';
import type { StudioServer } from '../src/index.js';
import { productionState } from '../src/app/board-words.js';
import { fixtureWorkspace } from '../../engine/test/helpers.js';
import { BLOCKS_YAML, capture, writeRun } from '../../engine/test/synthetic-runs.js';
import { raw } from './http.js';

let ws: string;
let studio: StudioServer;
const P = 'northfield-fixture';
const BIG = 'big';
const savedHome = process.env.DEMO_STUDIO_HOME;
const project = (slug = P) => join(ws, 'projects', slug);
const A = '20261020-100000-blocks';
const B = '20261021-100000-blocks';
const C = '20261022-100000-blocks';

beforeAll(async () => {
  ws = await mkdtemp(join(tmpdir(), 'studio-ui-board-'));
  process.env.DEMO_STUDIO_HOME = join(ws, '.home');
  await fixtureWorkspace(ws);
  await writeFile(join(project(), 'scenarios', 'blocks.yaml'), `title: {kicker: K, text: "<img src=x onerror=alert(1)> ‮gnp.exe ${'t'.repeat(400)}"}\n${BLOCKS_YAML}`);
  await writeRun(project(), { ...capture(A), snapshot: await readFile(join(project(), 'scenarios', 'blocks.yaml'), 'utf8') });
  // A 40-scenario copy: the fixture's quote 40 times, 30 dry runs over them.
  const big = project(BIG);
  await cp(project(), big, { recursive: true, filter: (src) => !/\/(?:runs|renders|review|scenarios)(?:\/|$)/.test(src.slice(project().length)) });
  await mkdir(join(big, 'scenarios'), { recursive: true });
  const quote = await readFile(join(project(), 'scenarios', 'quote.yaml'), 'utf8');
  for (let i = 0; i < 40; i++) await writeFile(join(big, 'scenarios', `q${String(i).padStart(2, '0')}.yaml`), quote.replace(/^video: quote$/m, `video: q${i}`));
  for (let i = 0; i < 30; i++) {
    const n = `q${String(i % 40).padStart(2, '0')}`;
    await writeRun(big, { id: `20261019-10${String(i).padStart(2, '0')}00-${n}`, scenario: n, mode: 'dry', events: [{ scene: 'catalog', step: 0, action: 'open', t_start: 0, t_end: 0.5 }], scenes: [{ id: 'catalog' }] });
  }
  studio = await startStudioServer({ root: ws, pollMs: 100 });
}, 120_000);

afterAll(async () => {
  vi.restoreAllMocks();
  await studio?.close();
  if (savedHome === undefined) delete process.env.DEMO_STUDIO_HOME;
  else process.env.DEMO_STUDIO_HOME = savedHome;
  if (ws) await rm(ws, { recursive: true, force: true });
});

const call = (op: string, args: unknown = {}) => raw(studio.port, 'POST', `/v1/call/${op}`, { authorization: `Bearer ${studio.token}`, 'content-type': 'application/json' }, JSON.stringify(args));
async function board(slug = P): Promise<{ ms: number; v: ProjectBoardView; body: string }> {
  const t0 = performance.now();
  const r = await call('project_board', { project: slug });
  const ms = performance.now() - t0;
  expect(r.status, r.body).toBe(200);
  return { ms, v: r.json<{ data: ProjectBoardView }>().data, body: r.body };
}
const of = (v: ProjectBoardView, name: string): BoardScenario => v.scenarios.find((s) => s.name === name)!;

describe('project_board: the op', () => {
  it('is a Studio-only read: in OWN_OPS and the ui allow-list; zod refuses a path before any read', async () => {
    expect(OWN_OPS as readonly string[]).toContain('project_board');
    expect(UI_OPS as readonly string[]).toContain('project_board');
    for (const project of ['../x', '/etc', P.toUpperCase()]) {
      const r = await call('project_board', { project });
      expect(r.status, project).toBe(400);
    }
    expect((await call('project_board', { project: P, extra: 1 })).status).toBe(400);
  });

  it('every scenario of the fixture with its facts; path-free; a title from the file only under untrusted, capped', async () => {
    const { v, body } = await board();
    expect(v.scenarios.map((s) => s.name).sort()).toEqual([...v.scenarios.map((s) => s.name)].sort());
    expect(v.scenarios).toHaveLength(16);
    expect(body).not.toContain(ws);
    expect(body).not.toMatch(/"(?:path|dir)"\s*:/);
    const quote = of(v, 'quote');
    expect(quote.untrusted.title).toBe('Request a quote in a minute');
    expect(quote.file).toEqual({ parsed: true, ok: true, errors: 0, warnings: 0 });
    expect(quote.content.scenes).toBeGreaterThan(2);
    expect(quote.content.hooks).toBeGreaterThan(0);
    expect(quote.last_run).toMatchObject({ id: '20261017-120000-quote', mode: 'dry', status: 'failed' });
    expect(productionState(quote).group).toBe('failed');
    const blocks = of(v, 'blocks');
    expect(blocks.untrusted.title?.startsWith('<img src=x onerror=alert(1)> ‮gnp.exe')).toBe(true);
    expect(blocks.untrusted.title).toHaveLength(200);
    expect(Object.keys(blocks).filter((k) => typeof (blocks as unknown as Record<string, unknown>)[k] === 'string')).toEqual(expect.not.arrayContaining(['title']));
    // Never run: not shot yet.
    const never = v.scenarios.find((s) => !s.last_run && !s.running)!;
    expect(productionState(never)).toEqual({ state: 'idle', word: 'Draft · not shot yet', group: 'shoot' });
  });

  it('a capture: current, its poster (the last pictured step), its length; then a render and its review, a newer capture, a failure, a filmed change', async () => {
    let s = of((await board()).v, 'blocks');
    expect(s.capture).toMatchObject({ id: A, current: true });
    expect(s.poster).toEqual({ run: A, key: 'two.1' });
    expect(s.length).toEqual({ seconds: 5, from: 'capture' });
    expect(productionState(s)).toEqual({ state: 'waiting', word: 'Shot · ready to render', group: 'ready' });
    // A render of this capture on this file (sameVersion), then its review.
    await mkdir(join(project(), 'renders'), { recursive: true });
    // The fixture's theme is editorial (project.yaml `template:`): a render with it (L5.10a fixes: the theme counts).
    const render = { version: 1, id: 'blocks-v1', created_at: '2026-10-20T11:00:00.000Z', status: 'succeeded', run_id: A, template: 'editorial', variant: 'landscape', duration_s: 6.5, edit: { from: 'scenario', sha256: s.hash } };
    await writeFile(join(project(), 'renders', 'blocks-v1.json'), JSON.stringify(render));
    s = of((await board()).v, 'blocks');
    expect(productionState(s)).toEqual({ state: 'waiting', word: 'Rendered · review pending', group: null });
    expect(s.length).toEqual({ seconds: 6.5, from: 'render' });
    await mkdir(join(project(), 'review', 'blocks-v1'), { recursive: true });
    await writeFile(join(project(), 'review', 'blocks-v1', 'report.json'), JSON.stringify({ version: 1, findings: [], counts: { error: 0, warning: 2, info: 0 }, review: { created_at: '2026-10-20T11:05:00.000Z' } }));
    s = of((await board()).v, 'blocks');
    expect(productionState(s)).toEqual({ state: 'warn', word: 'Rendered · 2 warnings', group: null });
    // A newer capture: the render shows an earlier take.
    await writeRun(project(), { ...capture(B), snapshot: await readFile(join(project(), 'scenarios', 'blocks.yaml'), 'utf8') });
    s = of((await board()).v, 'blocks');
    expect(s.capture?.id).toBe(B);
    expect(productionState(s)).toEqual({ state: 'warn', word: 'Render outdated', group: 'ready' });
    // A dry run that failed after it.
    await writeRun(project(), { id: C, scenario: 'blocks', mode: 'dry', status: 'failed', error: { scene: 'one', step: 1, message: 'gone' }, events: [{ scene: 'one', step: 0, action: 'click', t_start: 0, t_end: 1 }] });
    s = of((await board()).v, 'blocks');
    expect(s.last_run).toMatchObject({ id: C, status: 'failed', partial: 'failed at step 2 of one' });
    expect(productionState(s)).toEqual({ state: 'fail', word: 'Failed at step 2 of one', group: 'failed' });
    await rm(join(project(), 'runs', C), { recursive: true });
    // A filmed change: the take no longer matches the file.
    await writeFile(join(project(), 'scenarios', 'blocks.yaml'), `${await readFile(join(project(), 'scenarios', 'blocks.yaml'), 'utf8')}      - click: Fifth\n`);
    s = of((await board()).v, 'blocks');
    expect(s.capture).toMatchObject({ id: B, current: false });
    expect(productionState(s)).toEqual({ state: 'warn', word: 'Script changed since the shoot', group: 'shoot' });
  });
});

describe('project_board: cost (critique H1)', () => {
  it('budgets: the fixture and a 40-scenario copy with 30 runs, cold then warm (numbers in the log; pinned loosely)', async () => {
    const big1 = await board(BIG);
    const big2 = await board(BIG);
    const big3 = await board(BIG);
    expect(big1.v.scenarios).toHaveLength(40);
    expect(big2.v.scenarios.filter((s) => s.last_run?.mode === 'dry').length).toBe(30);
    const fx = await board();
    const fx2 = await board();
    console.log(`project_board budget: 40 scenarios cold ${big1.ms.toFixed(0)} ms, warm ${big2.ms.toFixed(0)} / ${big3.ms.toFixed(0)} ms; fixture (16) warm ${fx.ms.toFixed(0)} / ${fx2.ms.toFixed(0)} ms`);
    expect(big1.ms).toBeLessThan(6000);
    expect(Math.min(big2.ms, big3.ms)).toBeLessThan(600);
    expect(Math.min(fx.ms, fx2.ms)).toBeLessThan(600);
  });
  it('⚑ a board read never touches the scenario views: the open scenario keeps its memo (no text, binding or run-list recompute)', async () => {
    let views: ScenarioViews | undefined;
    const original = ScenarioViews.prototype.view;
    const spy = vi.spyOn(ScenarioViews.prototype, 'view').mockImplementation(function (this: ScenarioViews, ...args: Parameters<ScenarioViews['view']>) {
      views = this;
      return original.apply(this, args);
    });
    expect((await call('scenario_blocks', { project: P, name: 'quote' })).status).toBe(200);
    expect(views).toBeDefined();
    const before = { ...views!.stats };
    const calls = spy.mock.calls.length;
    await board(BIG);
    await board();
    expect(spy.mock.calls.length).toBe(calls);
    expect((await call('scenario_blocks', { project: P, name: 'quote' })).status).toBe(200);
    expect(views!.stats).toEqual(before);
    spy.mockRestore();
  });
});

describe('project_board: L5.10a fixes (reviews A and B), on the board and its counters', () => {
  let wsc: WorkspaceConfig;
  let boards: ProjectBoards;
  let overlays = 0;
  const fresh = () => {
    boards = new ProjectBoards({
      ws: wsc,
      queue: new FileJobQueue(ws),
      project: (slug) => openProjectBySlug(wsc, slug),
      overlay: async (_slug, r) => {
        overlays++;
        return r.status;
      },
    });
  };
  /** A copy of the fixture project (no runs, renders or reviews). */
  async function copy(slug: string): Promise<string> {
    const dir = project(slug);
    await cp(project(), dir, { recursive: true, filter: (src) => !/\/(?:runs|renders|review)(?:\/|$)/.test(src.slice(project().length)) });
    return dir;
  }
  beforeAll(async () => {
    wsc = await loadWorkspaceConfig(ws);
    fresh();
  });

  it('A-M1: a removed asset shows at once (the files its checks looked for are re-statted); anything else within the TTL', async () => {
    const dir = await copy('media');
    const own = async () => of(await boards.board('media'), 'own-media');
    expect((await own()).file).toMatchObject({ ok: true, errors: 0 });
    const n = boards.stats.files;
    expect((await own()).file.ok).toBe(true);
    expect(boards.stats.files).toBe(n);
    // The intro video goes away: the next read says so (review A-M1 saw "ok" until the scenario file was touched).
    await rename(join(dir, 'assets', 'intro.mp4'), join(dir, 'assets', 'intro.mp4.gone'));
    const gone = await own();
    expect(gone.file.ok).toBe(false);
    expect(gone.file.errors).toBeGreaterThan(0);
    expect(productionState(gone).word).toBe('File has errors');
    await rename(join(dir, 'assets', 'intro.mp4.gone'), join(dir, 'assets', 'intro.mp4'));
    expect((await own()).file.ok).toBe(true);
    // Past the TTL every entry is computed again (a component or a theme file the checks read without a stat).
    const before = boards.stats.files;
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + FILE_FACTS_TTL_MS + 1000);
    try {
      await boards.board('media');
    } finally {
      clock.mockRestore();
    }
    expect(boards.stats.files - before).toBe((await boards.board('media')).scenarios.length);
  });

  it('A-M2: an environment the file names is the location only when the project has it; else under untrusted, capped', async () => {
    const dir = await copy('envs');
    const quote = await readFile(join(dir, 'scenarios', 'quote.yaml'), 'utf8');
    const planted = `\u202ezzz<script>alert(1)</script>${'e'.repeat(3000)}`;
    await writeFile(join(dir, 'scenarios', 'planted.yaml'), `env: ${JSON.stringify(planted)}\n${quote.replace(/^video: quote$/m, 'video: planted')}`);
    await writeFile(join(dir, 'scenarios', 'prod.yaml'), `env: production\n${quote.replace(/^video: quote$/m, 'video: prod')}`);
    const v = await boards.board('envs');
    const p = of(v, 'planted');
    expect(p.env).toBeUndefined();
    expect(p.untrusted.env).toBe(planted.slice(0, 200));
    expect(of(v, 'prod').env).toBe('production');
    expect(of(v, 'prod').untrusted.env).toBeUndefined();
    expect(of(v, 'quote').env).toBe('local');
    // Strings from run.json pass only with their shape: an environment name, an ISO time.
    await writeRun(dir, { ...capture('20261020-100000-blocks'), snapshot: BLOCKS_YAML });
    await writeFile(join(dir, 'scenarios', 'blocks.yaml'), BLOCKS_YAML);
    const runJson = join(dir, 'runs', '20261020-100000-blocks', 'run.json');
    const rec = JSON.parse(await readFile(runJson, 'utf8')) as Record<string, unknown>;
    await writeFile(runJson, JSON.stringify({ ...rec, env: `\u202e${'x'.repeat(500)}`, finished_at: `<b>${'t'.repeat(500)}` }));
    const b = of(await boards.board('envs'), 'blocks');
    expect(b.capture).toMatchObject({ id: '20261020-100000-blocks', env: 'unknown' });
    expect(b.capture?.finished_at).toBeUndefined();
  });

  it('A-M3: one pass over a 3000-job queue (each job.json read once), warm ≤ 20 ms measured; a take from a terminal costs no second pass', async () => {
    const dir = await copy('queue');
    const jobsDir = join(ws, '.demo-studio', 'jobs');
    const ALPHA = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    const id = (i: number) => `j_01JB${Array.from({ length: 22 }, (_, k) => ALPHA[Math.floor(i / 32 ** (21 - k)) % 32]).join('')}`;
    for (let i = 0; i < 3000; i++) {
      const j = id(i);
      await mkdir(join(jobsDir, j), { recursive: true });
      await writeFile(join(jobsDir, j, 'job.json'), JSON.stringify({ version: 1, id: j, kind: 'run', input: { kind: 'run', project: 'other', scenario: 'quote', run_id: `20261001-100000-q${i}` }, state: 'succeeded', created_at: '2026-10-01T10:00:00.000Z', finished_at: '2026-10-01T10:01:00.000Z' }));
    }
    // A take started from a terminal, still running: no job anywhere.
    await writeFile(join(dir, 'scenarios', 'blocks.yaml'), BLOCKS_YAML);
    await writeRun(dir, { id: '20261023-100000-blocks', scenario: 'blocks', mode: 'capture', status: 'running', events: [{ scene: 'one', step: 0, action: 'click', t_start: 0, t_end: 1 }] });
    fresh();
    const cold = await boards.board('queue');
    expect(boards.stats.jobs).toBeGreaterThanOrEqual(3000);
    expect(of(cold, 'blocks').running).toMatchObject({ id: '20261023-100000-blocks', status: 'running' });
    expect(overlays).toBe(0);
    const reads = boards.stats.jobs;
    const times: number[] = [];
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now();
      await boards.board('queue');
      times.push(performance.now() - t0);
    }
    console.log(`project_board with 3000 jobs of another project: warm ${times.map((t) => t.toFixed(1)).join(' / ')} ms`);
    expect(boards.stats.jobs).toBe(reads);
    expect(overlays).toBe(0);
    expect(Math.min(...times)).toBeLessThan(150);
    await rm(jobsDir, { recursive: true, force: true });
  }, 60_000);

  it('A-L2: older runs (past the window) are summed up once; a new run adds itself, not a walk of the folder', async () => {
    const dir = await copy('many');
    await writeFile(join(dir, 'scenarios', 'blocks.yaml'), BLOCKS_YAML);
    const write = async (id: string, scenario: string) => {
      await mkdir(join(dir, 'runs', id), { recursive: true });
      await writeFile(join(dir, 'runs', id, 'run.json'), JSON.stringify({ version: 1, id, scenario, mode: 'dry', status: 'failed', started_at: '2026-10-01T10:00:00.000Z', finished_at: '2026-10-01T10:01:00.000Z', env: 'local', steps_total: 1, steps_done: 0 }));
    };
    // 400 runs of blocks (the window holds 300); the oldest is the only run of catalogue; reports has an old run and
    // one that is the last of the window (it sorts just before the 299 newest blocks runs).
    await write('20260901-000000-catalogue', 'catalogue');
    await write('20260801-000000-reports', 'reports');
    await write('20261001-100100-reports', 'reports');
    for (let i = 0; i < 400; i++) await write(`20261001-${String(100000 + i)}-blocks`, 'blocks');
    fresh();
    const first = await boards.board('many');
    expect(of(first, 'catalogue').last_run?.id).toBe('20260901-000000-catalogue');
    expect(of(first, 'reports').last_run?.id).toBe('20261001-100100-reports');
    expect(boards.stats.older).toBe(103);
    await boards.board('many');
    expect(boards.stats.older).toBe(103);
    // A new run: the window moves on by one, the run leaving it (reports' newest) joins the summed-up head — and wins
    // over the older reports run held.
    await write('20261002-100000-blocks', 'blocks');
    const again = await boards.board('many');
    expect(boards.stats.older).toBe(104);
    expect(of(again, 'catalogue').last_run?.id).toBe('20260901-000000-catalogue');
    expect(of(again, 'blocks').last_run?.id).toBe('20261002-100000-blocks');
    expect(of(again, 'reports').last_run?.id).toBe('20261001-100100-reports');
    // A run removed from the older ones: summed up again from the files (memoised run.json: no read).
    await rm(join(dir, 'runs', '20260901-000000-catalogue'), { recursive: true });
    const after = await boards.board('many');
    expect(of(after, 'catalogue').last_run).toBeUndefined();
  });

  it('A-L3, B-L2, B-L5: report.json read once; the render of today\'s file wins over a newer override; today\'s theme counts; a failed take shows its error screenshot', async () => {
    const dir = await copy('renders');
    const A1 = '20261020-100000-blocks';
    await writeFile(join(dir, 'scenarios', 'blocks.yaml'), BLOCKS_YAML);
    await writeRun(dir, { ...capture(A1), snapshot: BLOCKS_YAML });
    fresh();
    const hash = of(await boards.board('renders'), 'blocks').hash;
    await mkdir(join(dir, 'renders'), { recursive: true });
    const rec = (id: string, at: string, o: Record<string, unknown> = {}) => writeFile(join(dir, 'renders', `${id}.json`), JSON.stringify({ version: 1, id, created_at: at, status: 'succeeded', run_id: A1, template: 'editorial', variant: 'landscape', duration_s: 6, edit: { from: 'scenario', sha256: hash }, ...o }));
    await rec('blocks-v1', '2026-10-20T11:00:00.000Z');
    await mkdir(join(dir, 'review', 'blocks-v1'), { recursive: true });
    await writeFile(join(dir, 'review', 'blocks-v1', 'report.json'), JSON.stringify({ version: 1, findings: [], counts: { error: 0, warning: 0, info: 0 }, review: { created_at: '2026-10-20T11:05:00.000Z' } }));
    // A newer render with an option (--no-intro): another video, not the version of today's file.
    await rec('blocks-v2', '2026-10-21T11:00:00.000Z', { overrides: { intro: false } });
    let s = of(await boards.board('renders'), 'blocks');
    expect(s.theme).toBe('editorial');
    expect(s.render?.render_id).toBe('blocks-v1');
    expect(productionState(s)).toEqual({ state: 'ok', word: 'Rendered · clean', group: null });
    const n = reportReads.n;
    await boards.board('renders');
    await boards.board('renders');
    expect(reportReads.n).toBe(n);
    // project.yaml's theme changes: a render with editorial is no longer today's version.
    const yaml = join(dir, 'project.yaml');
    await writeFile(yaml, (await readFile(yaml, 'utf8')).replace(/^template: editorial$/m, 'template: default'));
    s = of(await boards.board('renders'), 'blocks');
    expect(s.theme).toBe('default');
    expect(productionState(s)).toEqual({ state: 'warn', word: 'Render outdated', group: 'ready' });
    // A failed capture after it with its error screenshot: the poster is that screenshot (the word is the failure).
    await writeRun(dir, { id: '20261022-100000-blocks', scenario: 'blocks', mode: 'capture', status: 'failed', error: { scene: 'two', step: 1, message: 'gone' }, screenshots: { 'error-two-1.png': [200, 40, 40] }, events: [{ scene: 'one', step: 0, action: 'click', t_start: 0, t_end: 1 }] });
    s = of(await boards.board('renders'), 'blocks');
    expect(productionState(s).word).toBe('Failed at step 2 of two');
    expect(s.poster).toEqual({ run: '20261022-100000-blocks', key: 'two.1' });
  });

  it('A-L4: review/ is a watched source — a review swapped in from a terminal changes the renders key (a board re-reads)', async () => {
    const dir = await copy('watched');
    const key = async () => (await scanSources(wsc)).get('renders:watched');
    const before = await key();
    await mkdir(join(dir, 'review', 'watched-v1'), { recursive: true });
    expect(await key()).not.toBe(before);
  });
});
