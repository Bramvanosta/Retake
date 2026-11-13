/**
 * The engine's clock (the port Clock): when Retake stamps what it writes — job records and their markers, journal and
 * history lines, thread entries, approvals taken, the run records it reserves or closes. Never the product clock (the
 * date the filmed page sees: `clock:` in project.yaml, core clock.ts) nor the capture clock (runner-web): see the
 * glossary's homonyms.
 *
 * The clock is chosen at the composition roots (ports.ts `enginePorts`: createEngine's `ports`, the jobs worker, the job
 * process, the CLI's `cliPorts`) and handed down; nothing else names `systemClock` (the import-rules ratchet's
 * `clock-read` check). Elapsed time and deadlines (the worker's timers, waits, grace periods, a line's `ms`) are not
 * stamps: they read the same port's monotonic side (`monotonic()`), so a scheduler is tested on a ManualClock without
 * real time. Memo lifetimes and file times stay on the system's time, each file pinned by the same check with its reason.
 *
 * `ManualClock` is the in-memory adapter for tests (here, not under test/, so that `implements Clock` is compiled).
 */

/** A wall clock — the time now, in epoch milliseconds — and a monotonic one for elapsed time. */
export interface Clock {
  now(): number;
  /**
   * Milliseconds from an arbitrary origin that never goes back (a wall clock set back does not move it): what elapsed
   * time, deadlines and waits are measured on. Never a stamp, never written.
   */
  monotonic(): number;
}

/** The system's clock: the one place the engine's stamps read the time; its monotonic side is `performance.now()`. */
export const systemClock: Clock = { now: () => Date.now(), monotonic: () => performance.now() };

/** The time of `clock` as an ISO 8601 stamp (what the records store). */
export function stampOf(clock: Pick<Clock, 'now'>): string {
  return new Date(clock.now()).toISOString();
}

/** The time of `clock` as a Date (local-time names, a file's times). */
export function dateOf(clock: Pick<Clock, 'now'>): Date {
  return new Date(clock.now());
}

function epochOf(at: string | number): number {
  const ms = typeof at === 'number' ? at : Date.parse(at);
  if (!Number.isFinite(ms)) throw new RangeError(`not a time: ${String(at)}`);
  return ms;
}

/**
 * A clock that stands still until it is set or moved (tests). `advance` moves both sides; `set` moves the wall clock
 * only (a wall clock set back or forward is not elapsed time). What is timed on the monotonic side then waits for the
 * test: a worker's idle exit, its build check, its cancel and orphan grace periods and the QoS rewalk end only when the
 * clock is advanced, whatever the real time (their polls still sleep in real time). `engine.jobs.wait` alone fails,
 * said, once its timeout plus a second (facade/jobs-api.ts STALLED_CLOCK_MS) of real time passed on a clock that did
 * not move.
 */
export class ManualClock implements Clock {
  #now: number;
  #monotonic = 0;

  /** `start`: an ISO 8601 stamp or epoch milliseconds. */
  constructor(start: string | number = '2026-01-01T00:00:00.000Z') {
    this.#now = epochOf(start);
  }

  now(): number {
    return this.#now;
  }

  monotonic(): number {
    return this.#monotonic;
  }

  set(at: string | number): void {
    this.#now = epochOf(at);
  }

  advance(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) throw new RangeError(`a clock moves forward only: ${ms}`);
    this.#now += ms;
    this.#monotonic += ms;
  }
}
