/**
 * The engine's clock (the port Clock): when Retake stamps what it writes — job records and their markers, journal and
 * history lines, thread entries, approvals taken, the run records it reserves or closes. Never the product clock (the
 * date the filmed page sees: `clock:` in project.yaml, core clock.ts) nor the capture clock (runner-web): see the
 * glossary's homonyms.
 *
 * The clock is chosen at the composition roots (ports.ts `enginePorts`: createEngine's `ports`, the jobs worker, the job
 * process, the CLI's `cliPorts`) and handed down; nothing else names `systemClock` (the import-rules ratchet's
 * `clock-read` check). Elapsed time, deadlines, memo lifetimes and file times are not stamps: they stay on the
 * system's time, each file pinned by the same check with its reason.
 *
 * `ManualClock` is the in-memory adapter for tests (here, not under test/, so that `implements Clock` is compiled).
 */

/** A wall clock: the time now, in epoch milliseconds. */
export interface Clock {
  now(): number;
}

/** The system's clock: the one place the engine's stamps read the time. */
export const systemClock: Clock = { now: () => Date.now() };

/** The time of `clock` as an ISO 8601 stamp (what the records store). */
export function stampOf(clock: Clock): string {
  return new Date(clock.now()).toISOString();
}

/** The time of `clock` as a Date (local-time names, a file's times). */
export function dateOf(clock: Clock): Date {
  return new Date(clock.now());
}

function epochOf(at: string | number): number {
  const ms = typeof at === 'number' ? at : Date.parse(at);
  if (!Number.isFinite(ms)) throw new RangeError(`not a time: ${String(at)}`);
  return ms;
}

/** A clock that stands still until it is set or moved (tests). */
export class ManualClock implements Clock {
  #now: number;

  /** `start`: an ISO 8601 stamp or epoch milliseconds. */
  constructor(start: string | number = '2026-01-01T00:00:00.000Z') {
    this.#now = epochOf(start);
  }

  now(): number {
    return this.#now;
  }

  set(at: string | number): void {
    this.#now = epochOf(at);
  }

  advance(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) throw new RangeError(`a clock moves forward only: ${ms}`);
    this.#now += ms;
  }
}
