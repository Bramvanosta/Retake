/**
 * Captures first in the terminal (L5.14): `retake render` / `still` / `export` / `review` / `export-capture` and the raw
 * export of `run --raw` are heavy work. While a filming take of this user holds (a Studio or agent take in any workspace,
 * another terminal's `retake run`: engine captures.ts), such a command waits to start with one line on stderr (stdout
 * stays what it was); once running, it yields during a later take — background QoS on its own process tree, reversed
 * when the take ends (engine yield.ts; never SIGSTOP: a stopped foreground command would hand the terminal back).
 * `--no-wait` skips both. A take's own hooks never wait for it (markers owned by an ancestor of this process do not
 * hold). Nothing filming: one read of an empty folder, no line, no delay.
 */
import { FilmingWatch, QosYield, ancestorPids, capMinutes } from '@retake/engine';
import type { FilmingState } from '@retake/engine';
import { CliError, EXIT } from './errors.js';
import type { Ui } from './ui.js';

export interface HeavyGateOptions {
  /** The workspace root (its takes are "in this workspace"). */
  root: string;
  /** What waits, for the line ("rendering", "exporting"…). */
  what: string;
  /** `--no-wait`: no wait, no yield. */
  noWait?: boolean;
  /** How often the markers are read (ms, default 1 000). */
  pollMs?: number;
  /** Tests: the environment (RETAKE_CAPTURES_DIR). */
  env?: NodeJS.ProcessEnv;
  /** Tests: the hold of this process's tree. */
  qos?: Pick<QosYield, 'hold' | 'release' | 'held'>;
}

export interface HeavyGate {
  /** It waited for a take before starting. */
  readonly waited: boolean;
  /** Stop yielding (normal priority again). */
  dispose(): Promise<void>;
}

const NO_GATE: HeavyGate = { waited: false, dispose: async () => undefined };

/** A take still films but has held heavy work for longer than the cap (it holds nothing any more). */
const pastCap = (st: FilmingState) => !st.holding && st.takes.some((t) => t.capped && !t.paused);

/** Wait while a take films, then yield during later ones; Ctrl-C while waiting exits interrupted, nothing written. */
export async function heavyGate(ui: Ui, o: HeavyGateOptions): Promise<HeavyGate> {
  if (o.noWait) return NO_GATE;
  const pollMs = o.pollMs ?? 1000;
  let ancestors: Promise<ReadonlySet<number>> | undefined;
  const watch = new FilmingWatch({ root: o.root, ...(o.env ? { env: o.env } : {}), ignorePids: () => (ancestors ??= ancestorPids()) });
  let st = await watch.scan();
  let waited = false;
  if (st.holding) {
    waited = true;
    ui.info(`waiting for a take to finish (${st.cause === 'here' ? 'in this workspace' : 'elsewhere on this Mac'}) before ${o.what} — Ctrl-C to quit, --no-wait to start now`);
    const ac = new AbortController();
    const onSignal = () => ac.abort();
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
    try {
      while (st.holding) {
        await new Promise<void>((r) => {
          const t = setTimeout(r, pollMs);
          ac.signal.addEventListener('abort', () => (clearTimeout(t), r()), { once: true });
        });
        if (ac.signal.aborted) throw new CliError(`interrupted while waiting for a take to finish: nothing was ${o.what === 'rendering' ? 'rendered' : 'written'}`, EXIT.interrupted);
        st = await watch.scan();
      }
    } finally {
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
    }
  }
  // The cap reached is said, not only obeyed: a take films but has held heavy work for longer than the cap.
  if (pastCap(st)) ui.warn(`a take has held heavy work for over ${capMinutes(o.env ?? process.env)} min: ${o.what} starts now`);
  // During a later take: background priority for this command and every process it started, back after the take.
  const qos = o.qos ?? new QosYield(process.pid, { group: false, self: true });
  let busy = false;
  let capSaid = pastCap(st);
  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    void (async () => {
      try {
        const now = await watch.scan();
        if (now.holding) {
          if (!qos.held) ui.debug(`a take started (${now.cause === 'here' ? 'in this workspace' : 'elsewhere on this Mac'}): ${o.what} goes on at background priority`);
          await qos.hold();
        } else {
          if (qos.held) await qos.release();
          if (pastCap(now) && !capSaid) {
            capSaid = true;
            ui.warn(`a take has held heavy work for over ${capMinutes(o.env ?? process.env)} min: ${o.what} goes on at normal priority`);
          } else if (!now.takes.length) capSaid = false;
        }
      } catch {
        /* the next poll tries again */
      } finally {
        busy = false;
      }
    })();
  }, pollMs);
  timer.unref();
  return {
    waited,
    dispose: async () => {
      clearInterval(timer);
      if (qos.held) await qos.release();
    },
  };
}
