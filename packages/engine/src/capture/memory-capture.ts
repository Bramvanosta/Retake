/**
 * The CaptureRunner port in memory, for tests: no browser, no ffmpeg. Not exported from the package (a test imports
 * this file). It lives under src, not test, so that `implements CaptureRunner` is compiled: the port and its second
 * adapter cannot drift apart unseen.
 *
 * What it does of the port: `load()` resolves; `cancelled(message)` is a `MemoryCancelledError` — named
 * `CancelledError`, of kind `cancelled`, as the runner's (the engine tells a cancel by its name or its kind, never by
 * its class); `cleanupSync()` counts its calls (`cleanups`) and removes nothing. As the runner package, both refuse
 * (`internal`, the package adapter's words) until `load()` or a `run` loaded it: a composition root that forgot its
 * `load()` fails on this runner too. Every call is kept in `calls`. A run
 * (`run`) is memory-run.ts's — a run folder, its records and events, the signal, `until`, the pause gate, the live sink,
 * an inspection's report, the filming events and the hooks through the handed hook runner, with no browser — and the
 * run contract (engine/test/capture-runner-contract.ts) runs it beside the runner package; the recording's window, the
 * sessions, the js-hook pages and the site come from memory-sessions.ts, the raw export from memory-raw.ts (its calls
 * kept in `calls` too), or from the options.
 */
import type { ErrorKind } from '@retake/core/base';
import type { RunRecord } from '@retake/core/run';
import { ManualClock } from '../clock.js';
import { EngineError } from '../errors.js';
import type { Clock } from '../clock.js';
import { memoryRun } from './memory-run.js';
import type { MemoryStepFailure } from './memory-run.js';
import { memoryRaw } from './memory-raw.js';
import type { MemoryRawCall } from './memory-raw.js';
import { memoryHookPages, memoryRecord, memorySessions, memorySite } from './memory-sessions.js';
import type { CaptureRaw, CaptureRequest, CaptureRunner, CaptureSessions, HookPages } from './runner.js';

/** The in-memory runner's cancel: the runner's name and kind. */
export class MemoryCancelledError extends Error {
  constructor(message = 'run cancelled') {
    super(message);
    this.name = 'CancelledError';
  }

  /** What a client outside the CLI is told (core error-kind.ts). */
  get errorKind(): ErrorKind {
    return 'cancelled';
  }
}

export type MemoryCaptureCall = { member: 'load' } | { member: 'run'; req: CaptureRequest } | { member: 'cancelled'; message?: string } | { member: 'cleanupSync' } | MemoryRawCall;

export interface MemoryCaptureRunnerOptions {
  /** What its runs stamp (default a ManualClock at 2026-11-11T12:00:00Z: the stamps stand still, elapsed times do not). */
  clock?: Clock;
  /** A step the runs fail, by its reference (`<scene id>.<step index>`): the failure's message (undefined: it passes). */
  fail?: MemoryStepFailure;
  record?: CaptureRunner['record'];
  sessions?: CaptureSessions;
  hookPages?: HookPages;
  site?: CaptureRunner['site'];
  raw?: CaptureRaw;
}

export class MemoryCaptureRunner implements CaptureRunner {
  readonly calls: MemoryCaptureCall[] = [];
  /** How many times `cleanupSync` was called. */
  cleanups = 0;
  readonly record: CaptureRunner['record'];
  readonly sessions: CaptureSessions;
  readonly hookPages: HookPages;
  readonly site: CaptureRunner['site'];
  readonly raw: CaptureRaw;
  readonly #fail: MemoryStepFailure | undefined;
  readonly #clock: Clock;
  #loaded = false;

  constructor(o: MemoryCaptureRunnerOptions = {}) {
    this.record = o.record ?? memoryRecord();
    this.sessions = o.sessions ?? memorySessions();
    this.hookPages = o.hookPages ?? memoryHookPages();
    this.site = o.site ?? memorySite();
    this.raw = o.raw ?? memoryRaw(this.calls);
    this.#fail = o.fail;
    this.#clock = o.clock ?? new ManualClock('2026-11-11T12:00:00.000Z');
  }

  async load(): Promise<void> {
    this.calls.push({ member: 'load' });
    this.#loaded = true;
  }

  /** As runner-web-capture.ts: a synchronous member needs the runner loaded. */
  #sync(member: string): void {
    if (!this.#loaded) throw new EngineError('internal', `the capture runner's ${member} was called before it was loaded: its composition root awaits capture.load() first`);
  }

  async run(req: CaptureRequest): Promise<RunRecord> {
    this.calls.push({ member: 'run', req });
    // A run loads the package adapter's runner too.
    this.#loaded = true;
    return memoryRun(req, { clock: this.#clock, ...(this.#fail ? { fail: this.#fail } : {}) });
  }

  cancelled(message?: string): Error {
    this.calls.push({ member: 'cancelled', ...(message !== undefined ? { message } : {}) });
    this.#sync('cancelled');
    return new MemoryCancelledError(message);
  }

  cleanupSync(): number {
    this.calls.push({ member: 'cleanupSync' });
    this.#sync('cleanupSync');
    this.cleanups++;
    return 0;
  }
}
