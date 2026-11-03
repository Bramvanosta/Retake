import { EXIT } from './errors.js';
import type { Ui } from './ui.js';

/** A command's handling of Ctrl-C / SIGTERM (onInterrupt). */
export interface Interrupt {
  /** Aborted by the first signal: the command closes its browser and settles. */
  readonly signal: AbortSignal;
  /** A signal was received: the command ends with EXIT.interrupted. */
  readonly interrupted: boolean;
  /** Remove the handlers (the command is over). */
  dispose(): void;
}

/**
 * Ctrl-C (SIGINT) / SIGTERM while a command holds a persona's browser (L1.6: `retake login`, `auth status --check`, the
 * js hooks of `hooks run` / `hooks rollback` / `env reset`, the sign-ins of `retake new`). Without a handler Node.js
 * would quit at once and leave the session copies — a persona's cookies — in the system temp folder. The first signal
 * aborts `signal`: the command closes its browser (which removes its copies) and ends with EXIT.interrupted; with
 * `exit` (a command that cannot be aborted: the hooks), `exit` closes what it holds and the process exits 130 at once.
 * A second signal removes the copies synchronously, runs `onQuitSync` (a sandbox kills the processes this call started,
 * L1.8) and exits. `message` replaces the "closing the browser" line of the first signal.
 */
export async function onInterrupt(ui: Ui, opts: { exit?: () => Promise<void>; onQuitSync?: () => void; message?: string } = {}): Promise<Interrupt> {
  const { removeSessionCopiesSync } = await import('@retake/runner-web');
  const controller = new AbortController();
  let count = 0;
  const quit = (): never => {
    removeSessionCopiesSync();
    try {
      opts.onQuitSync?.();
    } catch {
      /* exiting anyway */
    }
    process.exit(EXIT.interrupted);
  };
  const handler = () => {
    count++;
    if (count > 1) quit();
    ui.clearStatus();
    ui.warn(opts.message ?? 'interrupted: closing the browser…');
    controller.abort();
    if (opts.exit) void opts.exit().catch(() => undefined).finally(quit);
  };
  process.on('SIGINT', handler);
  process.on('SIGTERM', handler);
  return {
    signal: controller.signal,
    get interrupted() {
      return count > 0;
    },
    dispose: () => {
      process.off('SIGINT', handler);
      process.off('SIGTERM', handler);
    },
  };
}
