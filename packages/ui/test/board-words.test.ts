/**
 * L5.10a: the Project screen's state words (board-words.ts) — every row of the table yields a mark AND a non-empty word
 * (never colour alone), the smart groups, the render rule shared with the scenario screen (sameVersion), every review
 * state and every run status, the length and content words, search and sort.
 */
import { describe, expect, it } from 'vitest';
import type { BoardRun, BoardScenario, RenderReviewSummary } from '@demo-studio/engine';
import { MARK_STATES } from '../src/app/ui-kit/marks.js';
import { boardEventAction } from '../src/app/project-data.js';
import { onlyRunProgress } from '../src/app/events.js';
import { contentWords, filterSort, groupCounts, lastTakeWords, lengthWords, productionState, reviewState, runningWords } from '../src/app/board-words.js';

const H = 'a'.repeat(64);
const base = (o: Partial<BoardScenario> = {}): BoardScenario => ({
  name: 'quote',
  hash: H,
  file: { parsed: true, ok: true, errors: 0, warnings: 0 },
  content: { scenes: 4, cards: 1, interstitials: 1, steps: 25, hooks: 3 },
  untrusted: {},
  ...o,
});
const run = (id: string, o: Partial<BoardRun> = {}): BoardRun => ({ id, mode: 'capture', status: 'succeeded', started_at: '2026-10-20T10:00:00.000Z', finished_at: '2026-10-20T10:01:00.000Z', steps_done: 18, steps_total: 18, ...o });
const CAP = '20261020-100000-quote';
const capture = (current: boolean | null) => ({ id: CAP, env: 'local', finished_at: '2026-10-20T10:01:00.000Z', current });
const render = (review: RenderReviewSummary, o: Partial<NonNullable<BoardScenario['render']>> = {}): NonNullable<BoardScenario['render']> => ({
  render_id: 'quote-v1', status: 'succeeded', created_at: '2026-10-20T11:00:00.000Z', run_id: CAP, theme: 'default', variant: 'landscape', duration_s: 60, width: 1920, height: 1080, size_bytes: 1, edit: { from: 'scenario', sha256: H }, fps: 30, overrides: [], review, ...o,
});
const CLEAN: RenderReviewSummary = { state: 'clean', counts: { error: 0, warning: 0, info: 0 } };

/** Every row of the table, first match wins: [facts, state, word, group]. */
const ROWS: Array<[string, BoardScenario, string, string, string | null]> = [
  ['unreadable', base({ file: { parsed: false, ok: false, errors: 1, warnings: 0, unreadable: true } }), 'attention', 'Broken file: cannot be read', null],
  ['not YAML', base({ file: { parsed: false, ok: false, errors: 1, warnings: 0 } }), 'attention', 'File has errors', null],
  ['errors', base({ file: { parsed: true, ok: false, errors: 2, warnings: 0 }, capture: capture(true) }), 'attention', 'File has errors', null],
  ['running capture', base({ running: run('20261021-100000-quote', { status: 'running', steps_done: 6, steps_total: 18 }) }), 'running', 'Capture running · step 7 of 18', null],
  ['running dry, starting', base({ running: run('20261021-100000-quote', { mode: 'dry', status: 'running', steps_done: 0, steps_total: 0 }) }), 'running', 'Dry run running · starting', null],
  ['queued', base({ running: run('20261021-100000-quote', { status: 'queued', steps_done: 0 }) }), 'running', 'Capture · queued', null],
  ['rendering', base({ capture: capture(true), render_job: { job: 'j_1', state: 'running', reviewing: false, fraction: 0.4 } }), 'running', 'Render running · 40 %', null],
  ['rendering, no fraction', base({ capture: capture(true), render_job: { job: 'j_1', state: 'running', reviewing: false } }), 'running', 'Render running', null],
  ['render queued', base({ capture: capture(true), render_job: { job: 'j_1', state: 'queued', reviewing: false } }), 'running', 'Render queued', null],
  ['reviewing', base({ capture: capture(true), render_job: { job: 'j_1', state: 'running', reviewing: true } }), 'running', 'Review running', null],
  ['failed after the capture', base({ capture: capture(true), last_run: run('20261022-100000-quote', { mode: 'dry', status: 'failed', partial: 'failed at step 3 of proposal' }) }), 'fail', 'Failed at step 3 of proposal', 'failed'],
  ['failed, no capture', base({ last_run: run('20261022-100000-quote', { status: 'failed' }) }), 'fail', 'Failed', 'failed'],
  ['interrupted', base({ last_run: run('20261022-100000-quote', { status: 'interrupted', partial: 'interrupted' }) }), 'fail', 'Interrupted', 'failed'],
  ['status unknown', base({ last_run: run('20261022-100000-quote', { status: 'unknown' }) }), 'attention', 'Last take: status invalid', null],
  ['render failed after the capture', base({ capture: capture(true), last_run: run(CAP), render_failed: { render_id: 'quote-v2', at: '2026-10-20T12:00:00.000Z' } }), 'fail', 'Render failed', 'failed'],
  ['script changed', base({ capture: capture(false), last_run: run(CAP), render: render(CLEAN) }), 'warn', 'Script changed since the shoot', 'shoot'],
  ['rendered, clean', base({ capture: capture(true), last_run: run(CAP), render: render(CLEAN) }), 'ok', 'Rendered · clean', null],
  ['rendered, warnings', base({ capture: capture(true), render: render({ state: 'warnings', counts: { error: 0, warning: 2, info: 0 } }) }), 'warn', 'Rendered · 2 warnings', null],
  ['rendered, one error', base({ capture: capture(true), render: render({ state: 'errors', counts: { error: 1, warning: 0, info: 0 } }) }), 'attention', 'Rendered · 1 error', null],
  ['rendered, not reviewed', base({ capture: capture(true), render: render({ state: 'none' }) }), 'waiting', 'Rendered · review pending', null],
  ['rendered, review queued', base({ capture: capture(true), render: render({ state: 'queued', job: 'j_2' }) }), 'running', 'Rendered · review running', null],
  ['rendered, review running', base({ capture: capture(true), render: render({ state: 'running', job: 'j_2' }) }), 'running', 'Rendered · review running', null],
  ['rendered, review failed', base({ capture: capture(true), render: render({ state: 'failed' }) }), 'warn', 'Rendered · review stopped', null],
  ['rendered, review cancelled', base({ capture: capture(true), render: render({ state: 'cancelled' }) }), 'warn', 'Rendered · review stopped', null],
  ['rendered on this file, no snapshot', base({ capture: capture(null), render: render(CLEAN) }), 'ok', 'Rendered · clean', null],
  ['render of another capture', base({ capture: capture(true), render: render(CLEAN, { run_id: '20261019-100000-quote' }) }), 'warn', 'Render outdated', 'ready'],
  ['render of an earlier file', base({ capture: capture(true), render: render(CLEAN, { edit: { from: 'scenario', sha256: 'b'.repeat(64) } }) }), 'warn', 'Render outdated', 'ready'],
  ['render as captured', base({ capture: capture(true), render: render(CLEAN, { edit: { from: 'run' } }) }), 'warn', 'Render outdated', 'ready'],
  // L5.10a fixes (review B-L2): the theme a render would use today counts, as on the scenario screen.
  ['render with the theme of today', base({ theme: 'default', capture: capture(true), render: render(CLEAN) }), 'ok', 'Rendered · clean', null],
  ['render with another theme than today\'s', base({ theme: 'editorial', capture: capture(true), render: render(CLEAN) }), 'warn', 'Render outdated', 'ready'],
  ['shot, not rendered', base({ capture: capture(true), last_run: run(CAP) }), 'waiting', 'Shot · ready to render', 'ready'],
  ['shot, cannot tell', base({ capture: capture(null) }), 'idle', 'Ready to render · cannot tell if current', 'ready'],
  ['cancelled after the capture: the take stands', base({ capture: capture(true), last_run: run('20261022-100000-quote', { status: 'cancelled', partial: 'cancelled' }) }), 'waiting', 'Shot · ready to render', 'ready'],
  ['cancelled, no capture', base({ last_run: run('20261022-100000-quote', { status: 'cancelled', partial: 'cancelled' }) }), 'idle', 'Last take cancelled · not shot', 'shoot'],
  ['a newer partial until run: the take stands', base({ capture: capture(true), last_run: run('20261022-100000-quote', { partial: 'until step 4 of request' }) }), 'waiting', 'Shot · ready to render', 'ready'],
  ['dry run passed', base({ dry: { id: '20261019-100000-quote' }, last_run: run('20261019-100000-quote', { mode: 'dry' }) }), 'idle', 'Dry run passed · not shot', 'shoot'],
  ['nothing', base(), 'idle', 'Draft · not shot yet', 'shoot'],
];

describe('productionState (L5.10a): every row a shape and a word', () => {
  for (const [what, s, state, word, group] of ROWS) {
    it(what, () => {
      expect(productionState(s)).toEqual({ state, word, group });
    });
  }

  it('⚑ never colour alone: every state is a kit mark and every word is visible text', () => {
    for (const [, s] of ROWS) {
      const p = productionState(s);
      expect(MARK_STATES).toContain(p.state);
      expect(p.word.trim().length).toBeGreaterThan(3);
    }
  });

  it('the smart groups count what the words group', () => {
    expect(groupCounts(ROWS.map(([, s]) => s))).toEqual({
      ready: ROWS.filter((r) => r[4] === 'ready').length,
      shoot: ROWS.filter((r) => r[4] === 'shoot').length,
      failed: ROWS.filter((r) => r[4] === 'failed').length,
    });
  });
});

describe('the inspector words', () => {
  it('every review state and every run status has words', () => {
    for (const r of [CLEAN, { state: 'none' }, { state: 'queued', job: 'j' }, { state: 'running', job: 'j' }, { state: 'failed' }, { state: 'cancelled' }, { state: 'warnings', counts: { error: 0, warning: 1, info: 0 } }, { state: 'errors', counts: { error: 3, warning: 0, info: 0 } }] as RenderReviewSummary[]) {
      expect(reviewState(r).words.length, r.state).toBeGreaterThan(3);
    }
    expect(reviewState({ state: 'errors', counts: { error: 3, warning: 0, info: 0 } }).words).toBe('3 errors');
    const words = (['succeeded', 'failed', 'cancelled', 'interrupted', 'queued', 'running', 'unknown'] as const).map((status) => lastTakeWords(run('r', { status, steps_done: 2, steps_total: 5 })).words);
    expect(words).toEqual(['Capture succeeded', 'Capture failed', 'Capture cancelled', 'Capture interrupted', 'Capture · queued', 'Capture running · step 3 of 5', 'Capture: status invalid']);
    expect(lastTakeWords(run('r', { mode: 'dry', status: 'failed', partial: 'failed at step 3 of proposal' })).words).toBe('Dry run failed at step 3 of proposal');
    expect(lastTakeWords(run('r', { partial: 'until step 4 of request' })).words).toBe('Capture stopped until step 4 of request');
    expect(runningWords({ mode: 'capture', status: 'running', steps_done: 18, steps_total: 18 })).toBe('Capture running · step 18 of 18');
  });

  it('length and content in words', () => {
    expect(lengthWords(60)).toBe('1:00.0');
    expect(lengthWords(65.04)).toBe('1:05.0');
    expect(lengthWords(9.36)).toBe('0:09.4');
    expect(contentWords({ scenes: 4, cards: 1, interstitials: 1, steps: 25, hooks: 3 })).toBe('4 scenes · 2 cards · 25 steps');
    expect(contentWords({ scenes: 1, cards: 0, interstitials: 0, steps: 1, hooks: 0 })).toBe('1 scene · 1 step');
  });

  it('search by name or title (every word), sort by activity, name or length', () => {
    const a = base({ name: 'alpha', untrusted: { title: 'Request a quote' }, length: { seconds: 10, from: 'capture' }, last_run: run('1', { finished_at: '2026-10-20T10:00:00.000Z' }) });
    const b = base({ name: 'beta', untrusted: {}, length: { seconds: 30, from: 'render' }, last_run: run('2', { finished_at: '2026-10-22T10:00:00.000Z' }) });
    const c = base({ name: 'gamma', untrusted: { title: 'Quote on the phone' } });
    expect(filterSort([a, b, c], 'quote', 'name').map((s) => s.name)).toEqual(['alpha', 'gamma']);
    expect(filterSort([a, b, c], 'QUOTE phone', 'name').map((s) => s.name)).toEqual(['gamma']);
    expect(filterSort([a, b, c], '', 'activity').map((s) => s.name)).toEqual(['beta', 'alpha', 'gamma']);
    expect(filterSort([a, b, c], '', 'length').map((s) => s.name)).toEqual(['beta', 'alpha', 'gamma']);
  });
});

describe('the open project\'s reads: what an event re-reads (project-data boardEventAction, critique M2)', () => {
  const P = 'northfield-fixture';
  const run = (change: 'new' | 'status' | 'progress' | 'removed', project = P) => ({ project, run: '20261020-100000-quote', scenario: 'quote', status: 'running', finished: false, change });
  const ws = (o: Record<string, unknown>) => ({ type: 'workspace' as const, projects: [P], readme: [], ...o });
  it('a take that only progressed re-reads nothing; one that started, ended or went away re-reads the board', () => {
    const seen = new Set<string>();
    expect(boardEventAction(ws({ runs: [run('progress')] }), P, new Set(), seen)).toEqual({ view: false, board: null, cast: null });
    for (const c of ['new', 'status', 'removed'] as const) expect(boardEventAction(ws({ runs: [run(c)] }), P, new Set(), seen).board).toBe('now');
    // Another project's runs: nothing.
    expect(boardEventAction({ type: 'workspace', projects: ['other'], readme: [], runs: [run('status', 'other')] }, P, new Set(), seen)).toEqual({ view: false, board: null, cast: null });
  });
  it('⚑ ten steps of a capture: one board read for its unseen job at most, none for its progress (the take is followed by run_status)', () => {
    const seen = new Set<string>();
    let boards = 0;
    const count = (a: ReturnType<typeof boardEventAction>) => (boards += a.board ? 1 : 0);
    count(boardEventAction({ type: 'jobs', changed: ['j_run'] }, P, new Set(), seen));
    for (let i = 0; i < 10; i++) {
      count(boardEventAction(ws({ runs: [run('progress')] }), P, new Set(), seen));
      count(boardEventAction({ type: 'jobs', changed: ['j_run'] }, P, new Set(), seen));
    }
    expect(boards).toBe(1);
    // A render job the board shows: its progress re-reads the board (throttled by the store).
    expect(boardEventAction({ type: 'jobs', changed: ['j_render'] }, P, new Set(['j_render']), seen).board).toBe('throttled');
  });
  it('L5.10a fixes (review A-L7): a job of another project (the event names its projects) re-reads neither the board nor the Cast; one of this project does', () => {
    const seen = new Set<string>();
    expect(boardEventAction({ type: 'jobs', changed: ['j_other'], projects: ['other'] }, P, new Set(), seen)).toEqual({ view: false, board: null, cast: null });
    expect(seen.has('j_other')).toBe(true);
    expect(boardEventAction({ type: 'jobs', changed: ['j_mine'], projects: [P] }, P, new Set(), seen)).toEqual({ view: false, board: 'throttled', cast: 'throttled' });
    // An older server's event (no projects): as before, an unseen job re-reads.
    expect(boardEventAction({ type: 'jobs', changed: ['j_old'] }, P, new Set(), seen).board).toBe('throttled');
    // A job the board shows re-reads it whatever the event says.
    expect(boardEventAction({ type: 'jobs', changed: ['j_shown'], projects: ['other'] }, P, new Set(['j_shown']), seen).board).toBe('throttled');
  });
  it('L5.10a fixes: a server that names the project-file changes (`files`) — project.yaml re-reads all; a runs folder told no run re-reads the board only', () => {
    expect(boardEventAction(ws({ files: [P] }), P, new Set(), new Set())).toEqual({ view: true, board: 'now', cast: 'now' });
    expect(boardEventAction(ws({ files: [] }), P, new Set(), new Set())).toEqual({ view: false, board: 'now', cast: null });
    expect(boardEventAction(ws({ files: ['other'], runs: [run('progress')] }), P, new Set(), new Set())).toEqual({ view: false, board: null, cast: null });
    expect(boardEventAction(ws({ files: [], readme: [P] }), P, new Set(), new Set())).toEqual({ view: true, board: null, cast: null });
    expect(onlyRunProgress(ws({ files: [P], runs: [run('progress')] }))).toBe(false);
    expect(onlyRunProgress(ws({ files: [], runs: [run('progress')] }))).toBe(true);
  });
  it('L5.10a fixes (review A-L5): onlyRunProgress — a step of a take, nothing else; a run that started, a file or a list named: not only progress', () => {
    const ev = (o: Record<string, unknown>) => ({ type: 'workspace' as const, projects: [P], readme: [], ...o });
    expect(onlyRunProgress(ev({ runs: [run('progress')] }))).toBe(true);
    expect(onlyRunProgress(ev({ runs: [run('progress'), run('status')] }))).toBe(false);
    expect(onlyRunProgress(ev({ runs: [run('progress')], scenarios: [`${P}/quote`] }))).toBe(false);
    expect(onlyRunProgress(ev({ runs: [run('progress')], readme: [P] }))).toBe(false);
    expect(onlyRunProgress(ev({ runs: [run('progress')], renders: [P] }))).toBe(false);
    expect(onlyRunProgress(ev({}))).toBe(false);
    expect(onlyRunProgress({ type: 'resync' })).toBe(false);
    expect(onlyRunProgress({ type: 'jobs', changed: ['j'] })).toBe(false);
  });
  it('a scenario or render file re-reads the board; the README the project; files no list names everything; a reconnection everything', () => {
    expect(boardEventAction(ws({ scenarios: [`${P}/quote`] }), P, new Set(), new Set())).toEqual({ view: false, board: 'now', cast: null });
    expect(boardEventAction(ws({ renders: [P] }), P, new Set(), new Set())).toEqual({ view: false, board: 'now', cast: null });
    expect(boardEventAction(ws({ readme: [P] }), P, new Set(), new Set())).toEqual({ view: true, board: null, cast: null });
    expect(boardEventAction(ws({ comments: [`${P}/quote`] }), P, new Set(), new Set())).toEqual({ view: false, board: null, cast: null });
    expect(boardEventAction(ws({}), P, new Set(), new Set())).toEqual({ view: true, board: 'now', cast: 'now' });
    expect(boardEventAction({ type: 'resync' }, P, new Set(), new Set())).toEqual({ view: true, board: 'now', cast: 'now' });
    expect(boardEventAction({ type: 'index', generation: 3 }, P, new Set(), new Set())).toEqual({ view: false, board: null, cast: null });
  });
});
