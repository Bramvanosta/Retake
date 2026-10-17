/**
 * The interrupt port (L3.1): how engine code that holds something a signal must not leave behind (a sandbox take that
 * started processes) learns that it should stop. The CLI implements it with its Ctrl-C handler (`onInterrupt`: the first
 * signal aborts, a second one quits after `onQuitSync`); the jobs worker with the job's AbortSignal and its own signal
 * rule (worker.ts). Engine code never installs process signal handlers itself.
 */

export interface InterruptScope {
  /** Aborted by the first interrupt: the code holding the scope stops and settles. */
  readonly signal: AbortSignal;
  /** An interrupt arrived while the scope was open. */
  readonly interrupted: boolean;
  /** The scope is over (the handlers it installed are removed). */
  dispose(): void;
}

export interface InterruptOptions {
  /** What the user is told on the first interrupt (CLI: replaces "closing the browser…"). */
  message?: string;
  /** Run synchronously when the process quits on a later interrupt (kill what this scope started). */
  onQuitSync?: () => void;
}

export interface InterruptPort {
  open(opts?: InterruptOptions): Promise<InterruptScope>;
}

/** A port for code that is never interrupted by a signal, only by `signal` (tests, a job without a worker rule). */
export function signalInterrupts(signal?: AbortSignal): InterruptPort {
  return {
    open: async () => {
      const s = signal ?? new AbortController().signal;
      return {
        signal: s,
        get interrupted() {
          return s.aborted;
        },
        dispose: () => undefined,
      };
    },
  };
}
