/**
 * The take's screen recording: `simctl io <udid> recordVideo --codec h264 --mask ignored --force <mov>`. Capture time 0
 * is the moment its "Recording started" line is read (simctl writes it once the first frame is processed), stamped as
 * its chunk is read; a recorder that does not say it within 10 s fails the take. Stopped with SIGINT (simctl finishes
 * the file), then SIGKILL after 15 s.
 *
 * How late that stamp is: the movie's own duration (mov-box.ts) runs from its first frame to the moment simctl handled
 * the SIGINT, both on the host's clock, so (movie − (SIGINT − stamp)) is how far the first frame lies before capture
 * time 0 — a few ms on a quiet Mac, tens under load (recordingLateness). The film and its frame times are shifted by it
 * after the take (take.ts), in one place.
 */
import type { Exec, ProcHandle, ProcResult } from './proc.js';

/** The line simctl writes on stderr once the first frame is recorded. */
export const RECORDING_STARTED = /Recording started/;
/** How long the recorder gets to say it started. */
export const RECORD_START_MS = 10_000;
/** How long the recorder gets to finish its file after SIGINT. */
export const RECORD_STOP_MS = 15_000;

/** The arguments of the recording. Pure. */
export function recordArgs(udid: string, mov: string): string[] {
  return ['simctl', 'io', udid, 'recordVideo', '--codec', 'h264', '--mask', 'ignored', '--force', mov];
}

/** The longest believable lateness of the start stamp: past it the movie's duration is not trusted (none applied). */
export const MAX_LATENESS_S = 0.5;

/**
 * How late capture time 0 is after the recording's first frame (s): the movie's duration less the span from the start
 * stamp to the SIGINT (process.hrtime ns), never below 0; null when it is not believable (past MAX_LATENESS_S) or a
 * time is missing. Pure.
 */
export function recordingLateness(o: { startedNs: bigint | null; stopNs: bigint | null; movieS: number | null }): number | null {
  if (o.startedNs === null || o.stopNs === null || o.movieS === null || !(o.movieS > 0)) return null;
  const between = Number(o.stopNs - o.startedNs) / 1e9;
  const late = o.movieS - between;
  if (late > MAX_LATENESS_S || late < -MAX_LATENESS_S) return null;
  return Math.max(0, Math.round(late * 1e4) / 1e4);
}

export class ScreenRecording {
  /** process.hrtime (ns) of the "Recording started" line's read, and of the SIGINT that stopped it. */
  private stopAt: bigint | null = null;
  private constructor(
    private readonly proc: ProcHandle,
    readonly startedNs: bigint,
    private readonly unwatch: () => void,
  ) {}

  /** When the SIGINT was sent (null: not stopped by it). */
  get stopNs(): bigint | null {
    return this.stopAt;
  }

  /**
   * Start recording; `onStarted` is called the moment the "Recording started" line is read (capture time 0), before
   * this resolves. Throws when the recorder ends or stays silent first.
   */
  static async start(o: { exec: Exec; xcrun: string; udid: string; mov: string; onStarted: () => void; startMs?: number }): Promise<ScreenRecording> {
    let started!: () => void;
    const seen = new Promise<void>((r) => {
      started = r;
    });
    let said: bigint | null = null;
    const proc = o.exec.start(o.xcrun, recordArgs(o.udid, o.mov), {
      onLine: (line, stream, at) => {
        if (said !== null || stream !== 'stderr' || !RECORDING_STARTED.test(line)) return;
        said = at;
        o.onStarted();
        started();
      },
    });
    // A host that dies hard (SIGKILL, a crash) leaves no recording running: a watcher stops it then.
    const unwatch = proc.pid !== undefined && o.exec.watch ? o.exec.watch(proc.pid) : () => undefined;
    const limit = o.startMs ?? RECORD_START_MS;
    let timer: NodeJS.Timeout | undefined;
    const outcome = await Promise.race([
      seen.then(() => 'started' as const),
      proc.exited.then((r) => r),
      new Promise<'silent'>((r) => {
        timer = setTimeout(() => r('silent'), limit);
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (outcome === 'started') return new ScreenRecording(proc, said ?? process.hrtime.bigint(), unwatch);
    unwatch();
    if (outcome === 'silent') {
      proc.signal('SIGKILL');
      throw new Error(`the screen recording did not start within ${limit / 1000} s (simctl io recordVideo said nothing)`);
    }
    const r = outcome as ProcResult;
    throw new Error(`the screen recording ended before it started (exit ${r.code ?? r.signal}${r.stderr.trim() ? `: ${r.stderr.trim().split('\n').slice(-1)[0]}` : ''})`);
  }

  /** Stop and finish the file: SIGINT, then SIGKILL past RECORD_STOP_MS (the file is then unusable: thrown). */
  async stop(stopMs = RECORD_STOP_MS): Promise<void> {
    try {
      await this.stopRecording(stopMs);
    } finally {
      this.unwatch();
    }
  }

  private async stopRecording(stopMs: number): Promise<void> {
    if (this.proc.done) {
      const r = await this.proc.exited;
      throw new Error(`the screen recording stopped during the take (exit ${r.code ?? r.signal})`);
    }
    this.stopAt = process.hrtime.bigint();
    this.proc.signal('SIGINT');
    let timer: NodeJS.Timeout | undefined;
    const r = await Promise.race([
      this.proc.exited,
      new Promise<null>((res) => {
        timer = setTimeout(() => res(null), stopMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (r === null) {
      this.proc.signal('SIGKILL');
      throw new Error(`the screen recording did not finish its file within ${stopMs / 1000} s`);
    }
    if (r.code !== 0) throw new Error(`the screen recording ended with exit ${r.code ?? r.signal}`);
  }

  /** Synchronously killed (a second signal). */
  killSync(): void {
    if (!this.proc.done) this.proc.signal('SIGKILL');
    this.unwatch();
  }
}
