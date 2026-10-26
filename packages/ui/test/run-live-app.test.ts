/**
 * L4.4 part C: the Run screen's state from the stream's view events (app/run-live.ts `applyEvent`) — the log capped at
 * LOG_KEEP lines (the oldest dropped and counted), texts kept as plain strings (markup is never interpreted: the screen
 * renders them through Txt), a phase's start marker replaced by its hooks' results, step and pause states, malformed
 * or unknown events ignored. L4.4 part E: the live picture's letterbox (`nextLayout`, `placeFrame`). Review fixes: a
 * step row's status (`stepStatus`: only the step a stop interrupted says "stopped here", a step left running by a
 * killed worker "interrupted", a skipped `hook:` step says so), done counts without failures (`stepCounts`), a `hook:`
 * step's entries on its row, the log in time order, the job's state in words that are not the run's, the end of the
 * elapsed time of a run without run_end (`lastTs`), the pause's maximum, and the SSE block parser (U+2028).
 */
import { describe, expect, it } from 'vitest';
import { EMPTY, LIVE_BOX, LOG_KEEP, SETTLE_FRAMES, applyEvent, nextLayout, pauseMaxWords, placeFrame, stepCounts, stepStatus } from '../src/app/run-live.js';
import { parseSseBlock } from '../src/app/sse.js';
import type { RunLiveState } from '../src/app/run-live.js';

const fold = (events: Array<Record<string, unknown>>, s: RunLiveState = EMPTY) => events.reduce((acc, ev, i) => applyEvent(acc, 'log', (i + 1) * 100, ev), s);

describe('the Run screen state (applyEvent)', () => {
  it('keeps the last LOG_KEEP log lines, counts the dropped ones, keys every line apart, keeps markup as text', () => {
    const lines = Array.from({ length: LOG_KEEP + 250 }, (_, i) => ({ type: 'log', level: 'info', untrusted: { message: `line ${i} <img src=x onerror=alert(1)>` } }));
    const s = fold(lines);
    expect(s.log.length).toBe(LOG_KEEP);
    expect(s.logDropped).toBe(250);
    expect(s.log[0].text).toBe('line 250 <img src=x onerror=alert(1)>');
    expect(s.log.at(-1)!.text).toBe(`line ${LOG_KEEP + 249} <img src=x onerror=alert(1)>`);
    expect(new Set(s.log.map((l) => l.key)).size).toBe(LOG_KEEP);
    // Worker notes and the Studio's own notes are lines too, said as such.
    const t = fold([{ type: 'job_log', level: 'warn', untrusted: { message: 'sandbox reset' } }, { type: 'note', message: 'a line longer than 64 KiB was skipped' }, { type: 'job_state', state: 'running' }]);
    expect(t.log.map((l) => [l.from, l.level, l.text])).toEqual([
      ['worker', 'warn', 'sandbox reset'],
      ['studio', 'warn', 'a line longer than 64 KiB was skipped'],
      ['worker', 'info', 'the worker started the job'],
    ]);
  });

  it('outline, steps, sessions, pauses, hooks (the phase marker goes when its first hook reports), the end', () => {
    const s = fold([
      { type: 'run_start', status: 'running', mode: 'dry', env: 'local', steps_total: 2, ts: '2026-10-26T12:00:00.000Z' },
      { type: 'outline', steps: [{ scene: 'a', step: 0, action: 'click', desc: 'click "<b>Go</b>"' }, { scene: 'a', step: 1, action: 'hold', desc: 'hold 1 s' }, { scene: 7, step: 'x' }] },
      { type: 'session', persona: 'owner', status: 'signed_in_auto', untrusted: { detail: 'Welcome back' } },
      { type: 'hook', phase: 'setup', name: 'setup', status: 'start', untrusted: { message: '1 hook(s)' } },
      { type: 'hook', phase: 'setup', name: 'reset', status: 'ok', untrusted: { message: '200 OK' } },
      { type: 'step_start', scene: 'a', step: 0, action: 'click', desc: 'x' },
      { type: 'step_end', scene: 'a', step: 0, action: 'click', status: 'dry', ms: 120 },
      { type: 'pause', state: 'paused', scene: 'a', step: 1 },
    ]);
    expect(s.outline).toEqual([
      { scene: 'a', step: 0, action: 'click', desc: 'click "<b>Go</b>"' },
      { scene: 'a', step: 1, action: 'hold', desc: 'hold 1 s' },
    ]);
    expect(s.sessions).toEqual([{ persona: 'owner', status: 'signed_in_auto', detail: 'Welcome back' }]);
    expect(s.hooks).toEqual([{ phase: 'setup', name: 'reset', status: 'ok', message: '200 OK' }]);
    expect(s.steps).toEqual({ 'a.0': { status: 'dry', ms: 120 } });
    expect(s.paused).toMatchObject({ state: 'paused', scene: 'a', step: 1 });
    const t = fold(
      [
        { type: 'pause', state: 'resumed', scene: 'a', step: 1, ms: 2100 },
        { type: 'hook', phase: 'teardown', name: 'teardown', status: 'start' },
        { type: 'run_end', status: 'cancelled', steps_total: 2, steps_done: 1, warnings: 0, hooks: { setup: 'ok', teardown: 'ok' }, untrusted: { error: 'run cancelled' } },
      ],
      s,
    );
    expect(t.paused).toBeNull();
    expect(t.pauses).toEqual([{ state: 'resumed', scene: 'a', step: 1, ms: 2100 }]);
    expect(t.hooks.at(-1)).toMatchObject({ phase: 'teardown', marker: true });
    expect(t.end).toMatchObject({ status: 'cancelled', steps_done: 1, hooks: { setup: 'ok', teardown: 'ok' }, untrusted: { error: 'run cancelled' } });
    expect(t.current).toBeNull();
  });

  it('ignores malformed and unknown events (the state object is unchanged)', () => {
    for (const ev of [{}, { type: 'frame' }, { type: 'run_start', status: 'running' }, { type: 'step_end', scene: 'a', step: -1, status: 'ok' }, { type: 'session', persona: 3 }, { type: 'pause', state: 'paused' }, { type: '__proto__' }]) {
      expect(applyEvent(EMPTY, 'log', 1, ev)).toBe(EMPTY);
    }
  });
});

describe('the step rows after review (stepStatus, stepCounts) and the other review fixes', () => {
  const ts = (s: number) => `2026-10-26T12:00:${String(s).padStart(2, '0')}.000Z`;
  const rows = [
    { scene: 'a', step: 0, action: 'click' },
    { scene: 'a', step: 1, action: 'click' },
    { scene: 'a', step: 2, action: 'hook' },
    { scene: 'a', step: 3, action: 'hold' },
  ];
  const started = fold([
    { type: 'run_start', status: 'running', mode: 'dry', steps_total: 4, hooks: 'skip', ts: ts(0) },
    { type: 'step_start', scene: 'a', step: 0, action: 'click', desc: 'x', ts: ts(1) },
    { type: 'step_end', scene: 'a', step: 0, action: 'click', status: 'failed', ms: 10, untrusted: { message: 'optional: not found' }, ts: ts(2) },
    { type: 'step_start', scene: 'a', step: 1, action: 'click', desc: 'y', ts: ts(3) },
    { type: 'step_end', scene: 'a', step: 1, action: 'click', status: 'dry', ms: 10, ts: ts(4) },
    { type: 'step_start', scene: 'a', step: 2, action: 'hook', desc: 'hook reset', ts: ts(5) },
  ]);

  it('a stop: only the step it interrupted says "stopped here"; an optional step that failed before stays failed (B M2)', () => {
    const s = fold([{ type: 'step_end', scene: 'a', step: 2, action: 'hook', status: 'failed', ms: 5, ts: ts(6) }, { type: 'run_end', status: 'cancelled', steps_total: 4, steps_done: 3, warnings: 0, ts: ts(7) }], started);
    expect(rows.map((r) => stepStatus(s, r, true))).toEqual(['failed', 'dry', 'stopped', 'not_reached']);
    // Stopped between steps (the last one ended well): nothing says "stopped here".
    const between = fold([{ type: 'step_end', scene: 'a', step: 2, action: 'hook', status: 'ok', ms: 5 }, { type: 'run_end', status: 'cancelled', steps_total: 4, warnings: 0 }], started);
    expect(rows.map((r) => stepStatus(between, r, true))).not.toContain('stopped');
  });

  it('a run whose worker was killed (no run_end): the running step says interrupted; the clock ends at the last event (B M1)', () => {
    expect(stepStatus(started, rows[2], false)).toBe('running');
    expect(stepStatus(started, rows[2], true)).toBe('interrupted');
    expect(stepStatus(started, rows[3], true)).toBe('not_reached');
    expect(started.lastTs).toBe(ts(5));
    expect(started.end).toBeNull();
  });

  it('a skipped hook: step says so; its entries are on its row, not after the scenes (B L8); done counts no failure (B L9)', () => {
    const s = fold([{ type: 'step_end', scene: 'a', step: 2, action: 'hook', status: 'dry', ms: 1 }], started);
    expect(stepStatus(s, rows[2], false)).toBe('hook_skipped');
    expect(stepCounts(s, rows, false)).toEqual({ done: 1, skipped: 1 });
    // A run that runs its hooks: the hook step's entries go to its row.
    const run = fold(
      [
        { type: 'run_start', status: 'running', mode: 'capture', steps_total: 1, hooks: 'run' },
        { type: 'step_start', scene: 'a', step: 2, action: 'hook', desc: 'hook reset' },
        { type: 'hook', phase: 'step', name: 'reset', status: 'start', untrusted: { message: '1 hook(s)' } },
        { type: 'hook', phase: 'step', name: 'POST /api/reset', status: 'ok', untrusted: { message: '200' } },
        { type: 'step_end', scene: 'a', step: 2, action: 'hook', status: 'ok', ms: 30 },
      ],
      EMPTY,
    );
    expect(run.stepHooks['a.2']).toEqual([{ phase: 'step', name: 'POST /api/reset', status: 'ok', message: '200' }]);
    expect(run.hooks).toEqual([]);
    expect(stepStatus(run, rows[2], true)).toBe('ok');
    expect(stepCounts(run, rows, true)).toEqual({ done: 1, skipped: 0 });
  });

  it('the log in time order whatever file a line came from; the job\'s state is never the run\'s outcome; the pause\'s maximum (B L5, L7, L9)', () => {
    const s = fold([
      { type: 'log', level: 'info', untrusted: { message: 'run 1' }, ts: ts(1) },
      { type: 'log', level: 'info', untrusted: { message: 'run 3' }, ts: ts(3) },
      { type: 'job_state', state: 'running', ts: ts(2) },
      { type: 'job_state', state: 'succeeded', ts: ts(4) },
      { type: 'pause', state: 'paused', scene: 'a', step: 1, max_ms: 90_000 },
    ]);
    expect(s.log.map((l) => l.text)).toEqual(['run 1', 'the worker started the job', 'run 3', 'the worker finished the job (the run’s own outcome is above)']);
    expect(s.paused?.max_ms).toBe(90_000);
    expect(pauseMaxWords(90_000)).toBe('90 s');
    expect(pauseMaxWords(30 * 60_000)).toBe('30 min');
  });

  it('an SSE block is split on \\n only: U+2028 / U+2029 inside the data never end a line (A M1)', () => {
    const data = JSON.stringify({ message: 'Total\u2028due\u2029now' });
    expect(parseSseBlock(`event: progress\ndata: ${data}`)).toEqual({ type: 'progress', data });
    expect(parseSseBlock(': keepalive')).toBeNull();
  });
});

describe('the live picture’s letterbox (nextLayout, placeFrame)', () => {
  it('centres the frame in the 16:9 box; a new height of the same width moves nothing until it lasts, a new width at once', () => {
    // A 960×471 frame (what a 1920×1080 dry run mostly sends): centred, equal dark bands above and below.
    expect(placeFrame({ w: 960, h: 471 }, { w: 960, h: 471 })).toEqual({ s: 1, x: 0, y: 35, dw: 960, dh: 471 });
    // Taller than 16:9 (a phone): fitted to the height, centred across.
    expect(placeFrame({ w: 390, h: 844 }, { w: 390, h: 844 })).toMatchObject({ x: 355, y: 0, dh: LIVE_BOX.h });
    const pending = { w: 0, h: 0, n: 0 };
    let layout = nextLayout(null, pending, { w: 960, h: 471 });
    expect(layout).toEqual({ w: 960, h: 471 });
    // A lone 960×540 frame between 471 ones is drawn at the current place (top at the picture's top), no jump.
    layout = nextLayout(layout, pending, { w: 960, h: 540 });
    expect(layout).toEqual({ w: 960, h: 471 });
    expect(placeFrame(layout, { w: 960, h: 540 })).toMatchObject({ x: 0, y: 35, dh: 540 });
    layout = nextLayout(layout, pending, { w: 960, h: 471 });
    // The streak starts over after a frame of the laid-out size; SETTLE_FRAMES in a row lay it out again.
    for (let i = 1; i < SETTLE_FRAMES; i++) expect((layout = nextLayout(layout, pending, { w: 960, h: 540 }))).toEqual({ w: 960, h: 471 });
    expect((layout = nextLayout(layout, pending, { w: 960, h: 540 }))).toEqual({ w: 960, h: 540 });
    expect(placeFrame(layout, { w: 960, h: 540 })).toMatchObject({ x: 0, y: 0 });
    // Another width (another page or viewport): at once.
    expect(nextLayout(layout, pending, { w: 390, h: 844 })).toEqual({ w: 390, h: 844 });
  });
});
