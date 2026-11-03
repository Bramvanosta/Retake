/**
 * L4.8 part 5: the Record screen's pure rules (app/record-words.ts, RecordScreen's draftRows, events.ts
 * recordEventAction) — states in words, who started a recording, the window note (full size, never "side by side"),
 * the time left, the target flags, the inserts, the check (B7 wording, the events changed after it), the preflight
 * refusal a Sign in answers, the Studio's text rules (core studioText's, before anything is sent), the writes' reset
 * advice, the status line, and which events make the screen read its recording again. L5.11b: a recording's state in the
 * Shoot browser and beside its mark — a shape and a state word for every state (the colour-only rule).
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { RecordInsert } from '@retake/core';
import type { RecordCheckView, RecordState } from '@retake/engine';
import { recordEventAction } from '../src/app/events.js';
import { cursorRow, draftRows } from '../src/app/RecordScreen.js';
import { RECORD_MARK, ShootBrowser, recordStateWord, recordingWords } from '../src/app/ShootBrowser.js';
import type { RecordViewAnswer } from '../src/server/record-ops.js';
import {
  CHECK_SCOPE_NOTE,
  LIVE_STATES,
  STATE_WORDS,
  WINDOW_NOTE,
  WINDOW_OPEN,
  annotateErrorWords,
  annotatedWords,
  checkFailedAt,
  checkWords,
  fragileWords,
  holdSeconds,
  insertAnchor,
  insertText,
  insertWords,
  nameProblem,
  newerView,
  personaProblem,
  preflightSignIn,
  readOnlyWords,
  saveWhyWords,
  startedByWords,
  stateSentence,
  statusLine,
  textProblem,
  timeLeft,
  writesWords,
} from '../src/app/record-words.js';

const STATES: RecordState[] = ['queued', 'preflight', 'recording', 'draft', 'check', 'done', 'interrupted', 'tampered', 'nothing_recorded', 'failed', 'cancelled', 'discarded', 'missing'];

describe('the Record screen words', () => {
  it('every state has words, a sentence and a tone; live = queued → check', () => {
    for (const s of STATES) {
      expect(STATE_WORDS[s][0].length, s).toBeGreaterThan(0);
      expect(stateSentence(s).length, s).toBeGreaterThan(0);
    }
    expect([...LIVE_STATES]).toEqual(['queued', 'preflight', 'recording', 'draft', 'check']);
    expect(stateSentence('interrupted')).toMatch(/kept, unchecked/);
    expect(STATE_WORDS.tampered).toEqual(['cannot be verified', 'danger']);
    expect(stateSentence('tampered')).toMatch(/cannot be saved/);
  });

  it('⚑ the window: full size, the desktop layout filmed, Cmd-Tab — never "side by side"', () => {
    for (const t of [WINDOW_NOTE, WINDOW_OPEN, stateSentence('recording')]) {
      expect(t).toMatch(/full size/);
      expect(t).not.toMatch(/side by side/i);
    }
    expect(WINDOW_NOTE).toMatch(/desktop layout/);
    expect(WINDOW_OPEN).toMatch(/Cmd-Tab/);
    expect(WINDOW_OPEN).toMatch(/title bar/);
  });

  it('who started it; read-only words for Claude and a terminal', () => {
    expect(['ui', 'mcp', 'cli', 'test', null].map((c) => startedByWords(c as never))).toEqual(['the Studio', 'Claude', 'a terminal', 'a test', 'someone unknown']);
    expect(readOnlyWords('mcp')).toMatch(/^Started by Claude: shown read-only/);
  });

  it('the time left, mm:ss, never negative; nothing without an end', () => {
    const now = Date.parse('2026-10-28T10:00:00.000Z');
    expect(timeLeft('2026-10-28T10:12:05.000Z', now)).toBe('12:05 left');
    expect(timeLeft('2026-10-28T09:59:00.000Z', now)).toBe('0:00 left');
    expect(timeLeft(null, now)).toBeNull();
    expect(timeLeft('not a time', now)).toBeNull();
  });

  it('target flags and inserts in words; the Studio text of an insert apart (shown through Txt)', () => {
    expect(fragileWords(['css', 'dynamic_text', 'broader', 'other'])).toEqual(['depends on the page’s code (a CSS selector)', 'holds a number or a date that may change', 'matches a wider text than its own', 'may be fragile']);
    const ins = (x: Record<string, unknown>) => ({ id: 'i1', after_seq: 1, ...x }) as RecordInsert;
    expect(insertWords(ins({ kind: 'hold', seconds: 2 }))).toBe('Hold 2 s');
    expect(insertWords(ins({ kind: 'wait_for', until: 'next_target' }))).toBe('Wait for the next target');
    expect(insertWords(ins({ kind: 'wait_for', until: 'idle' }))).toBe('Wait until the page is idle');
    expect(insertWords(ins({ kind: 'camera', zoom: 1.5, until: 'scene_end' }))).toBe('Zoom 1.5× until the scene ends');
    expect(insertWords(ins({ kind: 'caption', text: '<b>x</b>' }))).toBe('Caption');
    expect(insertText(ins({ kind: 'caption', text: 'Add a note', kicker: 'Notes' }))).toBe('Notes — Add a note');
    expect(insertText(ins({ kind: 'wait_for', until: 'text', text: 'Saved' }))).toBe('Saved');
    expect(insertText(ins({ kind: 'mark', name: 'm1' }))).toBe('m1');
    expect(insertText(ins({ kind: 'hold', seconds: 2 }))).toBeNull();
  });

  it('the check: passed, until the first write, failed, skipped, and the events changed after it (B7 / B8) — recorded steps, without the picks and inserts (B-M4)', () => {
    const c = (x: Partial<RecordCheckView>): RecordCheckView => ({ status: 'passed', scope: 'all', steps_passed: 3, steps_total: 3, events_changed: false, ...x });
    expect(checkWords(c({}))).toMatchObject({ title: 'Check passed', tone: 'info', detail: '3 of 3 recorded steps replayed on a fresh page, without your picks and inserts.' });
    expect(checkWords(c({ status: 'failed', steps_passed: 1 })).detail).toMatch(/^1 of 3 recorded steps replayed \(without your picks and inserts\)/);
    expect(CHECK_SCOPE_NOTE).toMatch(/without your picks and inserts — none of them is checked/);
    // Where it failed: the row on screen, else the recorded step (said so); nothing without a failure.
    const at = { scene: 'lab', step: 1 };
    expect(checkFailedAt({ failed_at: at, failed_row: { scene: 'lab', step: 3 } })).toEqual({ scene: 'lab', step: 3, recorded: false });
    expect(checkFailedAt({ failed_at: at, failed_row: null })).toEqual({ scene: 'lab', step: 1, recorded: true });
    expect(checkFailedAt({ failed_at: at })).toEqual({ scene: 'lab', step: 1, recorded: true });
    expect(checkFailedAt({})).toBeNull();
    expect(checkFailedAt(undefined)).toBeNull();
    expect(checkWords(c({ scope: 'until_write', steps_passed: 2, steps_total: 5 })).title).toBe('Check passed up to the first write');
    expect(checkWords(c({ status: 'failed', steps_passed: 1 }))).toMatchObject({ title: 'Check failed', tone: 'warning' });
    expect(checkWords(c({ status: 'skipped', scope: null, reason: 'stopped' })).detail).toMatch(/worker stopped/);
    expect(checkWords(c({ events_changed: true }))).toMatchObject({ title: 'The check no longer holds', tone: 'danger' });
  });

  it('⚑ a preflight refusal for a persona not signed in maps to Sign in — nothing else does', () => {
    const v = (code: string, message: string, persona: string | null = 'supplier') => ({ job: { error: { code, message } }, persona, env: 'signed-in' });
    expect(preflightSignIn(v('refused', 'persona supplier is not signed in on signed-in (expired): sign it in first — retake -C . login p'))).toEqual({ persona: 'supplier', env: 'signed-in' });
    expect(preflightSignIn(v('refused', 'persona supplier could not be signed in by its login steps (x): sign it in by hand — retake -C . login p'))).toEqual({ persona: 'supplier', env: 'signed-in' });
    expect(preflightSignIn(v('refused', 'page shop of environment local is not an http(s) URL: nothing to record'))).toBeNull();
    expect(preflightSignIn(v('failed', 'persona supplier is not signed in'))).toBeNull();
    // Before the folder exists the view has no persona: the engine's message names it (and the environment).
    expect(preflightSignIn({ job: { error: { code: 'refused', message: 'persona supplier is not signed in on signed-in (never): sign it in first' } }, persona: null, env: null })).toEqual({ persona: 'supplier', env: 'signed-in' });
    expect(preflightSignIn({ job: { error: { code: 'refused', message: 'persona supplier could not be signed in by its login steps (x)' } }, persona: null, env: null })).toBeNull();
    expect(preflightSignIn({ job: { error: { code: 'refused', message: 'persona ../x is not signed in on y (never)' } }, persona: null, env: null })).toBeNull();
    expect(preflightSignIn({ job: null, persona: 'x', env: 'y' })).toBeNull();
  });

  it('the Studio text and names are checked before they are sent (core studioText / SLUG_RE rules)', () => {
    expect(textProblem('Add a note', 200)).toBeNull();
    expect(textProblem('  ', 200)).toMatch(/empty/);
    expect(textProblem('x'.repeat(201), 200)).toMatch(/200/);
    expect(textProblem('a {{env:HOME}}', 200)).toMatch(/\{\{/);
    for (const c of [0x0a, 0x09, 0x200b, 0x202e, 0x2066, 0xfeff, 0x00ad, 0x2028]) expect(textProblem(`a${String.fromCharCode(c)}b`, 200), c.toString(16)).toMatch(/One line/);
    expect(textProblem('Café — 東京 עברית', 200)).toBeNull();
    expect(nameProblem('my-flow_2')).toBeNull();
    for (const bad of ['', '-x', 'a b', '../x', 'a/b', 'x'.repeat(101)]) expect(nameProblem(bad), bad).not.toBeNull();
    expect(holdSeconds('2')).toBe(2);
    expect(holdSeconds('0.2')).toMatch(/Between/);
    expect(holdSeconds('x')).toMatch(/number/);
  });

  it('writes: the reset advice on a read-write environment; nothing when none', () => {
    expect(writesWords({ total: 0, by_steps: 0, ambient: 0 }, 'read-write')).toBeNull();
    expect(writesWords({ total: 2, by_steps: 1, ambient: 1 }, 'read-write')).toMatch(/reset hook/);
    expect(writesWords({ total: 1, by_steps: 1, ambient: 0 }, 'read-only')).toMatch(/stopped or answered by a mock/);
  });

  it('the status line and the annotate refusals in words', () => {
    expect(statusLine('recording', false)).toBe('The window is open: recording.');
    expect(statusLine('done', true)).toBe('Saved as a scenario.');
    expect(annotateErrorWords(409, 'conflict', 'stale revision: rev: 4')).toMatch(/changed meanwhile/);
    expect(annotateErrorWords(423, 'busy', 'locked')).toMatch(/try again/);
    expect(annotateErrorWords(400, 'invalid', 'a caption is empty')).toBe('a caption is empty');
  });
});

describe('after the reviews (the screen)', () => {
  it('B-L1: a poll answer older than the screen\'s revision never replaces a newer annotate answer', () => {
    expect(newerView(null, { rev: 0 })).toBe(true);
    expect(newerView({ rev: 3 }, { rev: 3 })).toBe(true);
    expect(newerView({ rev: 3 }, { rev: 4 })).toBe(true);
    expect(newerView({ rev: 4 }, { rev: 3 })).toBe(false);
    expect(newerView({ rev: 3 }, { rev: 5, unchanged: true })).toBe(false);
  });

  it('B-H1: where an insert goes from the cursor\'s row — after an action or the recorder\'s scroll, right after its wait, right after an insert', () => {
    expect(insertAnchor({ role: 'action', seqs: [3, 5] })).toEqual({ after_step_seq: 5 });
    expect(insertAnchor({ role: 'helper', helper: 'scroll', seqs: [2, 4] })).toEqual({ after_step_seq: 4 });
    expect(insertAnchor({ role: 'helper', helper: 'wait', seqs: [6, 6] })).toEqual({ after_step_seq: 6, row: 'wait' });
    expect(insertAnchor({ role: 'insert', seqs: [6, 6], insert: 'i3' })).toEqual({ after_insert: 'i3' });
  });

  it('B-M1: the cursor is keyed by its row\'s identity — an insert before it moves the row, the cursor and its words follow; a row that is gone has none', () => {
    const view = (sources: unknown[], steps: number) =>
      ({
        blocks: { entries: [{ type: 'scene', id: 'lab', steps: Array.from({ length: steps }, (_, i) => ({ key: `lab.${i}`, index: i })) }] },
        sources,
        alternatives: [],
        inserts: [{ id: 'i1', after_seq: 0, kind: 'hold', seconds: 2 }],
      }) as unknown as NonNullable<RecordViewAnswer['untrusted']>;
    const before = view(
      [
        { scene: 'lab', step: 0, seqs: [1, 1], role: 'action', row: 'a1' },
        { scene: 'lab', step: 1, seqs: [2, 3], role: 'helper', helper: 'scroll', row: 's2' },
        { scene: 'lab', step: 2, seqs: [4, 4], role: 'action', row: 'a4' },
      ],
      3,
    );
    const after = view(
      [
        { scene: 'lab', step: 0, seqs: [0, 0], role: 'insert', insert: 'i1', row: 'i:i1' },
        { scene: 'lab', step: 1, seqs: [1, 1], role: 'action', row: 'a1' },
        { scene: 'lab', step: 2, seqs: [2, 3], role: 'helper', helper: 'scroll', row: 's2' },
        { scene: 'lab', step: 3, seqs: [4, 4], role: 'action', row: 'a4' },
      ],
      4,
    );
    const cursor = { at: 'after' as const, row: 's2' };
    expect(cursorRow(before, cursor)).toEqual({ label: 'step 2 of lab', at: { after_step_seq: 3 } });
    expect(cursorRow(after, cursor)).toEqual({ label: 'step 3 of lab', at: { after_step_seq: 3 } });
    expect(draftRows(after)[0].rows.map((r) => r.id)).toEqual(['i:i1', 'a1', 's2', 'a4']);
    expect(cursorRow(after, { at: 'after', row: 'w9' })).toBeNull();
    expect(cursorRow(after, { at: 'end' })).toBeNull();
  });

  it('B-L4 / B-L5: what a done change says; Start refused for a persona that cannot sign in by itself', () => {
    expect(annotatedWords({ op: 'insert', insert: { kind: 'hold' } }, 'step 2 of products')).toBe('Hold added after step 2 of products.');
    expect(annotatedWords({ op: 'insert', insert: { kind: 'camera' } }, null)).toBe('Zoom added at the end.');
    expect(annotatedWords({ op: 'choose' }, null)).toBe('Target picked.');
    expect(annotatedWords({ op: 'remove' }, null)).toBe('Insert removed.');
    expect(personaProblem(undefined)).toBeNull();
    expect(personaProblem({ status: 'valid', login_steps: false, sandbox: false })).toBeNull();
    expect(personaProblem({ status: 'expired', login_steps: true, sandbox: false })).toBeNull();
    expect(personaProblem({ status: 'never', login_steps: false, sandbox: true })).toBeNull();
    for (const status of ['never', 'expired', 'error', null]) expect(personaProblem({ status, login_steps: false, sandbox: false }), String(status)).toMatch(/sign it in first/);
  });
});

describe('the draft rows and the events', () => {
  it('rows by scene with their source, alternatives, inserted step and modifiers', () => {
    const u = {
      blocks: { entries: [{ type: 'card', id: 'c' }, { type: 'scene', id: 'lab', page: 'shop', open: '/record-lab', steps: [{ key: 'lab.0', index: 0 }, { key: 'lab.1', index: 1 }] }] },
      sources: [
        { scene: 'lab', step: 0, seqs: [1, 2], role: 'action', row: 'a1', modifiers: ['i2', 'gone'] },
        { scene: 'lab', step: 1, seqs: [2, 2], role: 'insert', insert: 'i1', row: 'i:i1' },
      ],
      alternatives: [{ scene: 'lab', step: 0, seq: 1, chosen: 0, options: [] }],
      inserts: [
        { id: 'i1', after_seq: 2, kind: 'hold', seconds: 2 },
        { id: 'i2', after_seq: 0, kind: 'mark', name: 'm1' },
      ],
    } as unknown as NonNullable<RecordViewAnswer['untrusted']>;
    const [scene] = draftRows(u);
    expect(scene).toMatchObject({ scene: 'lab', page: 'shop', open: '/record-lab' });
    expect(scene.rows.map((r) => [r.key, r.source?.role, r.alt?.seq ?? null, r.insert?.id ?? null, r.modifiers.map((m) => m.id)])).toEqual([
      ['lab.0', 'action', 1, null, ['i2']],
      ['lab.1', 'insert', null, 'i1', []],
    ]);
  });

  it('the screen reads its recording on its own records event, a job change or a resync — not on another recording', () => {
    const w = (records: string[]) => ({ type: 'workspace' as const, projects: [], readme: [], records });
    expect(recordEventAction(w(['p/rec_a']), 'p', 'rec_a')).toBe(true);
    expect(recordEventAction(w(['p/rec_b', 'q/rec_a']), 'p', 'rec_a')).toBe(false);
    expect(recordEventAction({ type: 'workspace', projects: ['p'], readme: [] }, 'p', 'rec_a')).toBe(false);
    expect(recordEventAction({ type: 'jobs', changed: ['j_x'] }, 'p', 'rec_a')).toBe(true);
    expect(recordEventAction({ type: 'resync' }, 'p', 'rec_a')).toBe(true);
    // The start form: any recording of the project.
    expect(recordEventAction(w(['p/rec_b']), 'p', undefined)).toBe(true);
    expect(recordEventAction(w(['pq/rec_b']), 'p', undefined)).toBe(false);
  });
});

describe('L5.11b: a recording\'s state beside its mark (Shoot\'s browser, the screen)', () => {
  const STATES = Object.keys(STATE_WORDS) as RecordState[];
  /** The a11y checker's vocabulary a status mark needs beside it (a11y.ts saysState), as far as these words go. */
  const SAYS = /\b(waiting|pending|recording|draft|recorded|interrupted|invalid|failed|cancelled|discarded|missing|ended|done|saved)\b/i;
  it('every state has a mark and a word that says a state; live states say "now"-ish words', () => {
    for (const st of STATES) {
      expect(RECORD_MARK[st], st).toBeDefined();
      expect(recordStateWord(st), st).toMatch(SAYS);
      expect(recordStateWord(st).charAt(0), st).toBe(recordStateWord(st).charAt(0).toUpperCase());
    }
    expect(RECORD_MARK.recording).toBe('recording');
    expect(RECORD_MARK.done).toBe('ok');
    expect(RECORD_MARK.failed).toBe('fail');
    expect(recordStateWord('preflight')).toBe('Pending: opening the window');
  });

  it('the browser\'s words: the actions while it goes, "not saved" / "saved as" once over, who started it when not the Studio', () => {
    const r = { state: 'recording' as RecordState, actions: 7, saved: null, studio: true, started_by: 'ui' as const };
    expect(recordingWords(r)).toBe('Recording · 7 actions');
    expect(recordingWords({ ...r, state: 'done' })).toBe('Recorded · not saved');
    expect(recordingWords({ ...r, state: 'done', saved: { name: 'quote-v2', file: 'scenarios/quote-v2.yaml' } })).toBe('Recorded · saved as quote-v2');
    expect(recordingWords({ ...r, state: 'done', studio: false, started_by: 'mcp' })).toBe('Recorded · by Claude');
    expect(recordingWords({ ...r, state: 'discarded', studio: false })).toBe('Discarded');
    expect(recordingWords({ ...r, state: 'queued', actions: null })).toBe('Waiting for the worker');
    // L5.11b fixes (review B-L6): its location, and its steps once over (L4.8's list said both).
    expect(recordingWords({ ...r, env: 'local', steps: 5 })).toBe('Recording · 7 actions · local');
    expect(recordingWords({ ...r, state: 'done', env: 'staging', steps: 12, saved: { name: 'quote-v2', file: 'scenarios/quote-v2.yaml' } })).toBe('Recorded · 12 steps · staging · saved as quote-v2');
    expect(recordingWords({ ...r, state: 'done', env: 'local', steps: 1 })).toBe('Recorded · 1 step · local · not saved');
  });

  it('⚑ the Recordings group: a saved recording links its scenario (a row under it); its words through Txt (B-L6)', () => {
    const item = (rec_id: string, saved: { name: string; file: string } | null) => ({ rec_id, state: 'done' as const, job: null, started_by: 'ui' as const, started_at: null, name: `draft-${rec_id}`, env: 'local', persona: null, page: 'shop', path: '/', steps: 4, actions: 4, saved, studio: saved === null });
    const html = renderToStaticMarkup(createElement(ShootBrowser, { slug: 'p', name: null, runs: null, current: null, recordings: { items: [item('rec_a', { name: 'quote-v2', file: 'scenarios/quote-v2.yaml' }), item('rec_b', null)], current: 'rec_a' } }));
    expect(html).toMatch(/<a href="#\/p\/p\/s\/quote-v2"[^>]*data-testid="record-recent-saved"[^>]*>.*Open quote-v2/);
    expect((html.match(/data-testid="record-recent-saved"/g) ?? []).length).toBe(1);
    expect(html).toContain('Recorded · 4 steps · local · saved as quote-v2');
    expect(html).toContain('Recorded · 4 steps · local · not saved');
  });
});

describe('L5.11b fixes: why Save waits, in the words of each state (review B-M2)', () => {
  const v = (state: RecordState, save = false, draft: string | null = null) => ({ state, can: { save }, draft_sha256: draft });
  it('after Stop while the window is open; once the check is over while it runs; enabled when done', () => {
    for (const s of ['queued', 'preflight', 'recording'] as const) expect(saveWhyWords(v(s), 'quote-v2', null), s).toBe('Saving opens after Stop. It writes a new file, scenarios/quote-v2.yaml.');
    expect(saveWhyWords(v('recording'), 'bad name', 'Letters only')).toBe('Saving opens after Stop. It writes a new file, scenarios/<name>.yaml.');
    for (const s of ['draft', 'check'] as const) expect(saveWhyWords(v(s), 'quote-v2', null), s).toBe('Saving opens once the check is over.');
    expect(saveWhyWords(v('interrupted'), 'quote-v2', null)).toBe('This recording cannot be saved.');
    expect(saveWhyWords(v('done', true, 'abc'), 'quote-v2', null)).toBeNull();
    expect(saveWhyWords(v('done', true, 'abc'), 'x y', 'Letters only')).toBe('The name needs fixing first.');
    expect(saveWhyWords(v('done', true, null), 'quote-v2', null)).toBe('There is no draft to save.');
  });
});
