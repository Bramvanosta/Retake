/**
 * The tuning of a run's time map (what plays at which speed, what a cut keeps) and the capture spans the planner
 * reads off the timeline events: `hook:` steps, waits for the product, held loads beside other pages, quick month runs.
 */
import type { TimelineEvent } from '@retake/core/run';
import type { Interval } from './util.js';
import { mergeIntervals, stepEnd, subtractIntervals } from './util.js';

/** Seconds around a marked step (and through its hold end) always played at 1×. */
export const MARK_WINDOW_S = 0.6;
/** Output seconds over which a speed change is ramped. */
export const SPEED_RAMP_S = 0.3;
/** Idle gaps (outside protected spans) longer than this are shortened (seconds). */
export const DEFAULT_IDLE_THRESHOLD_S = 1.2;
/** What is left of a shortened idle gap (seconds of capture: half before the cut, half after). */
export const IDLE_KEEP_S = 0.4;
/**
 * A wait after a click (R-FLD-26) keeps this much of its start (the viewer sees that it loads) and this much before
 * the content appears; waits whose middle is shorter than BUSY_CUT_MIN_S are left alone.
 */
export const BUSY_KEEP_BEFORE_S = 0.3;
export const BUSY_KEEP_AFTER_S = 0.1;
export const BUSY_CUT_MIN_S = 0.2;
/**
 * Waiting (the root cause of the catalogue `long-wait`): a wait step (`wait_for`, `wait_for_email`) and the
 * post-navigation pause of the step right before it show a loading state (placeholders, spinners — they animate, so the
 * capture is never idle and idle trimming cannot shorten them). The planner plays such a span at `WAIT_SPEED` after its
 * first `WAIT_KEEP_S` (the viewer sees that it loads), ramped like any speed change; marks, holds and the opening still
 * stay at 1×, a step's own `speed` wins, a faster scene speed is kept. A marked wait step protects the moment it waited
 * for (its end), not the waiting.
 */
export const WAIT_SPEED = 4;
export const WAIT_KEEP_S = 0.5;
/** Waiting shorter than this (after the kept part) is left alone. */
export const WAIT_MIN_S = 0.3;
/** Wait steps that waited at least this long in all show that the page before them was still loading. */
export const WAIT_LOADING_MIN_S = 0.3;
/** Steps that wait for the product. */
export const WAIT_ACTIONS: ReadonlySet<string> = new Set(['wait_for', 'wait_for_email']);
/**
 * Quick month runs of a `date` step (R-CHO-24, `data.quick_runs`: presses ~110 ms apart) are played at up to
 * QUICK_RUN_SPEED, from QUICK_RUN_PAD_BEFORE_S before the first press to QUICK_RUN_PAD_AFTER_S after the last (its
 * ripple), ramped like any speed change (a short run never reaches the full speed); a step's own `speed` wins, marks
 * and holds stay at 1×.
 */
export const QUICK_RUN_SPEED = 3;
export const QUICK_RUN_PAD_BEFORE_S = 0.1;
export const QUICK_RUN_PAD_AFTER_S = 0.35;

/** The spans of `hook:` steps: the action ran off camera (its `hold`, after it, stays). Pure. */
export function hookSpans(events: readonly TimelineEvent[]): Array<{ t_start: number; t_end: number }> {
  return events.filter((e) => e.action === 'hook' && e.step >= 0 && e.t_end > e.t_start).map((e) => ({ t_start: e.t_start, t_end: e.t_end }));
}

/**
 * The capture seconds a scene spends waiting for the product (see `WAIT_SPEED`): each wait step without its own speed,
 * and — when a run of consecutive wait steps actually waited (≥ `WAIT_LOADING_MIN_S` in all: the new page was still
 * loading) right after a step that changed the page — that step's pause after the change (from the URL change,
 * `pageChanges` in capture seconds, to the step's end): the viewer was looking at the loading page. Contiguous spans
 * merge; the first `WAIT_KEEP_S` of each is left out (played as usual). Pure.
 */
export function waitingSpans(events: readonly TimelineEvent[], pageChanges: readonly number[] = []): Array<{ t_start: number; t_end: number }> {
  const steps = events.filter((e) => e.step >= 0 && e.status !== 'skipped').sort((a, b) => a.t_start - b.t_start || a.step - b.step);
  const isWait = (e: TimelineEvent) => WAIT_ACTIONS.has(e.action) && !(typeof e.speed === 'number' && e.speed > 0) && e.t_end > e.t_start;
  const contiguous = (prev: TimelineEvent, next: TimelineEvent) => next.t_start - stepEnd(prev) <= 0.1 && !(prev.hold && prev.hold.t_end > prev.hold.t_start);
  const raw: Interval[] = [];
  for (let i = 0; i < steps.length; i++) {
    if (!isWait(steps[i])) continue;
    // A run of consecutive waits.
    let j = i;
    while (j + 1 < steps.length && isWait(steps[j + 1]) && contiguous(steps[j], steps[j + 1])) j++;
    const run = steps.slice(i, j + 1);
    for (const w of run) raw.push({ a: w.t_start, b: w.t_end });
    const waited = run.reduce((n, w) => n + (w.t_end - w.t_start), 0);
    const prev = steps[i - 1];
    if (prev && !WAIT_ACTIONS.has(prev.action) && contiguous(prev, steps[i]) && waited >= WAIT_LOADING_MIN_S) {
      // The page changed during the previous step and was still loading after its pause.
      const from = prev.t_click ?? prev.t_start;
      const change = pageChanges.find((t) => t >= from - 1e-6 && t < prev.t_end);
      if (change !== undefined) raw.push({ a: change, b: prev.t_end });
    }
    i = j;
  }
  const out: Array<{ t_start: number; t_end: number }> = [];
  for (const m of mergeIntervals(raw.map((x) => ({ a: x.a, b: x.b + 0.1 })))) {
    const a = m.a + WAIT_KEEP_S;
    const b = m.b - 0.1;
    if (b - a >= WAIT_MIN_S) out.push({ t_start: Math.round(a * 1e4) / 1e4, t_end: Math.round(b * 1e4) / 1e4 });
  }
  return out;
}

/**
 * Held page loads a multi-page run may cut (R-ISS-08): the time map is shared by every page the run shows, so a load
 * held on one page is not cut where another page acts — a step through its hold, ±MARK_WINDOW_S around a marked one —
 * nor during the opening still: that page's picture goes on, the loading page keeps its previous frame meanwhile. Pure.
 */
export function loadsBesideOtherPages<T extends { t_start: number; t_end: number; page?: string }>(loads: readonly T[], events: readonly TimelineEvent[]): T[] {
  const out: T[] = [];
  for (const l of loads) {
    const busy = events
      .filter((e) => e.status !== 'skipped' && (e.action === 'scene_still' || (e.step >= 0 && e.page !== undefined && e.page !== l.page)))
      .map((e) => (e.mark ? { a: e.t_start - MARK_WINDOW_S, b: stepEnd(e) + MARK_WINDOW_S } : { a: e.t_start, b: stepEnd(e) }));
    for (const x of subtractIntervals({ a: l.t_start, b: l.t_end }, busy)) out.push({ ...l, t_start: x.a, t_end: x.b });
  }
  return out;
}

/** The quick month runs of `date` steps (`data.quick_runs`), padded around their presses (capture seconds). */
export function quickRunSpans(events: readonly TimelineEvent[]): Array<{ t_start: number; t_end: number }> {
  const out: Array<{ t_start: number; t_end: number }> = [];
  for (const e of events) {
    if (e.step < 0 || e.action !== 'date' || (typeof e.speed === 'number' && e.speed > 0)) continue;
    const runs = (e.data as { quick_runs?: unknown } | undefined)?.quick_runs;
    if (!Array.isArray(runs)) continue;
    for (const r of runs as Array<{ t_start?: unknown; t_end?: unknown }>) {
      if (typeof r.t_start !== 'number' || typeof r.t_end !== 'number' || r.t_end < r.t_start) continue;
      const a = Math.max(e.t_start, r.t_start - QUICK_RUN_PAD_BEFORE_S);
      const b = Math.min(e.t_end, r.t_end + QUICK_RUN_PAD_AFTER_S);
      if (b > a) out.push({ t_start: Math.round(a * 1e4) / 1e4, t_end: Math.round(b * 1e4) / 1e4 });
    }
  }
  return out;
}
