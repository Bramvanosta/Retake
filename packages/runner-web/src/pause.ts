/**
 * Pausing a run between steps (L4.4, R-UI-19). The run looks at the gate at the top of every step, once the page it acts
 * on is loaded and signed in (scenes.ts runStep), never inside a step (a half-typed field, a held button), never in
 * hooks, teardown or encoding. While paused it waits, polling the gate; a cancel (or the sign-in guard) ends the wait at
 * once and the run stops as any cancelled run does (teardown and rollbacks still run). A pause longer than its maximum
 * stops the run the same way: a paused run holds the single worker, the session copies and a sandbox take.
 *
 * A capture does not film the pause (critique B1, B3, B4): the last click's effect check ends and its ripple plays out
 * first; then the capture clock stops and, at the same instant, every recorder filming now stops taking frames (its
 * screencast then detaches) and the take's CPU sampler pauses — capture time stands still, so the encoders fed during
 * the take (their ticks follow the clock) write nothing for it. On resume the recorders re-attach to their pages and the clock goes on from the paint time of the
 * first fresh frame: that frame lands at the pause instant, with no frameless gap a motion check could take for a freeze.
 * The page itself keeps running during the pause (timers, animations, a running product clock): the video shows what it
 * shows after the resume — a jump at that point when it changed.
 */
import type { Page } from 'playwright-core';
import type { RunProgress, RunningRun, TimelinePause } from '@retake/core';
import { CancelledError } from './errors.js';
import type { ScreencastRecorder } from './recorder.js';
import type { LogLevel } from './runtime.js';
import { RIPPLE_S } from './timeline.js';
import type { CaptureClock } from './timeline.js';
import { sleep, throwIfAborted, wallNow } from './util.js';

/** The longest pause by default (ms): 30 min. */
export const PAUSE_MAX_MS = 30 * 60_000;
/** How often a paused run looks at its gate again (ms). */
const PAUSE_POLL_MS = 100;
/** How long a re-attached recorder may take to send its first frame before the pause closes anyway (ms). */
export const RESUME_FRAME_MS = 1000;
/** Margin after a click ripple's end before a capture pauses (s). */
const RIPPLE_MARGIN_S = 0.1;

/** What asks a run to pause (the jobs worker: the `pause` marker of the job, polled). */
export interface PauseGate {
  /** A pause is asked now. */
  readonly requested: boolean;
  /** The longest pause (ms); default PAUSE_MAX_MS. */
  readonly maxMs?: number;
}

/** What a pause stops besides the run (run.ts): the capture clock, and for a capture its recorders and CPU sampler. */
export interface PauseTake {
  clock: CaptureClock;
  /** The recorders filming now, with the page each films (the main capture, the pages of a multi-page scene). */
  filming(): Array<{ recorder: ScreencastRecorder; page: Page }>;
  /** Capture time (s) of the last press or ripple of any cursor (null: none). */
  lastPress(): number | null;
  /** Ends the last click's effect check (R-FLD-12). */
  settleEffects(): Promise<void>;
  /** The take's CPU sampler (R-FLD-23), when it runs. */
  sampler(): { pause(): Promise<void>; resume(): Promise<void> } | null;
  /** The pause, for the timeline. */
  note(p: TimelinePause): void;
}

export interface PausePoint {
  gate: PauseGate;
  /** The run's signal (the cancel and the sign-in guard). */
  signal: AbortSignal;
  record: RunningRun;
  take: PauseTake;
  emit(e: RunProgress): void;
  save(): void;
  log(level: LogLevel, message: string): void;
  /** Captures first (L5.14): the take stopped filming (false, once its recorders paused) or films again (true, first). */
  filming?(on: boolean): void;
}

/** The pause logic of one run: `before(scene, step)` at the top of each step. */
export class RunPauser {
  constructor(private readonly p: PausePoint) {}

  async before(scene: string, step: number): Promise<void> {
    const { gate, record, take } = this.p;
    if (!gate.requested) return;
    throwIfAborted(this.p.signal);
    // B3: the last click's effects end before the take stops (its ripple is not cut by the pause).
    await take.settleEffects();
    const press = take.lastPress();
    if (press !== null) {
      const wait = (press + RIPPLE_S + RIPPLE_MARGIN_S - take.clock.now()) * 1000;
      if (wait > 0) await sleep(wait, this.p.signal);
    }
    if (!gate.requested) return;
    const maxMs = gate.maxMs ?? PAUSE_MAX_MS;
    const since = new Date();
    const t0 = performance.now();
    // Capture time stops first, at the wall time read now, and the recorders take no frame from that instant (a
    // recorder's pause drops what comes at once; its screencast then stops): before, they stopped first and capture
    // time went on until they had — a frameless span of ~0.1 s filmed per pause (review B L10). The CPU sampler last.
    const t = take.clock.pause(wallNow());
    const filming = take.filming();
    const stopped = Promise.all(filming.map((f) => f.recorder.pause()));
    await take.sampler()?.pause().catch(() => undefined);
    await stopped;
    this.p.filming?.(false);
    record.paused = { scene, step, since: since.toISOString() };
    this.p.save();
    this.p.emit({ type: 'pause', state: 'paused', scene, step, max_ms: maxMs });
    this.p.log('info', `paused before step ${scene}.${step} (at most ${formatMax(maxMs)})`);
    let ended = false;
    try {
      while (gate.requested) {
        if (performance.now() - t0 >= maxMs) {
          throw new CancelledError(`paused longer than ${formatMax(maxMs)} before step ${scene}.${step}: the run was stopped (its teardown and rollbacks still run)`);
        }
        await sleep(Math.min(PAUSE_POLL_MS, Math.max(1, maxMs - (performance.now() - t0))), this.p.signal);
      }
      ended = true;
    } finally {
      const cut = await this.resumeTake(filming, ended);
      // One length for the pause everywhere (run.json, the event, the log, the timeline): the time capture time stood
      // still — from the pause to the first fresh frame after it.
      const ms = Math.round(cut);
      take.note({ t, ms, scene, step });
      delete record.paused;
      (record.pauses ??= []).push({ scene, step, at: since.toISOString(), ms });
      this.p.save();
      if (ended) {
        this.p.emit({ type: 'pause', state: 'resumed', scene, step, ms });
        this.p.log('info', `resumed before step ${scene}.${step} after ${(ms / 1000).toFixed(1)} s`);
      }
    }
  }

  /**
   * Re-attach the recorders paused for the pause (not when the run stops there) and close the clock's pause at the paint
   * time of the first fresh frame (B3; the time limit, else). Returns the wall ms capture time left out.
   */
  private async resumeTake(filming: ReturnType<PauseTake['filming']>, resumed: boolean): Promise<number> {
    const { take } = this.p;
    // Heavy work held by this take is held again before its recorders film (L5.14).
    if (resumed) this.p.filming?.(true);
    const resumeWall = wallNow();
    let to = resumeWall;
    if (resumed && filming.length) {
      const back = await Promise.all(
        filming.map(async (f) => {
          try {
            await f.recorder.switchTo(f.page);
            return f.recorder;
          } catch (e) {
            this.p.log('warn', `after the pause, a recorder could not film its page again: ${(e as Error).message}`);
            return null;
          }
        }),
      );
      const recs = back.filter((r): r is ScreencastRecorder => r !== null);
      if (recs.length) {
        await new Promise<void>((resolve) => {
          let left = recs.length;
          for (const r of recs) void r.waitFrameAfter(resumeWall, RESUME_FRAME_MS).then((ok) => (ok || --left === 0 ? resolve() : undefined));
        });
        const firsts = recs.map((r) => r.lastFrameAt).filter((w) => w > resumeWall);
        to = firsts.length ? Math.min(...firsts) : wallNow();
      }
    }
    const cut = take.clock.resume(to);
    await take.sampler()?.resume().catch(() => undefined);
    return cut;
  }
}

function formatMax(ms: number): string {
  return ms >= 60_000 && ms % 60_000 === 0 ? `${ms / 60_000} min` : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
}
