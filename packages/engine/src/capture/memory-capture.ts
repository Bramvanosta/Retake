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
 * kept in `calls` too), the browser's probe (`probe`) finds no browser — or each from the options.
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
  /** What `probe` answers (default: a browser that is not found — no browser in memory). */
  probe?: CaptureRunner['probe'];
}

/** The capture browser of a runner with no browser: none is known, none launched. */
/** No browser: none known (Playwright's registry, as the runner says it), or the project's own executable, never there. */
const NO_BROWSER: CaptureRunner['probe'] = async (browser) =>
  browser?.executable ? { path: browser.executable, source: 'browser.executable', exists: false, launched: false } : { path: null, source: 'playwright', exists: false, launched: false };

export class MemoryCaptureRunner implements CaptureRunner {
  readonly calls: MemoryCaptureCall[] = [];
  /** How many times `cleanupSync` was called. */
  cleanups = 0;
  readonly record: CaptureRunner['record'];
  readonly sessions: CaptureSessions;
  readonly hookPages: HookPages;
  readonly site: CaptureRunner['site'];
  readonly raw: CaptureRaw;
  readonly probe: CaptureRunner['probe'];
  readonly #fail: MemoryStepFailure | undefined;
  readonly #clock: Clock;
  #loaded = false;

  constructor(o: MemoryCaptureRunnerOptions = {}) {
    this.#clock = o.clock ?? new ManualClock('2026-11-11T12:00:00.000Z');
    this.record = o.record ?? memoryRecord();
    // Its sessions stamp what they save with the runner's clock.
    this.sessions = o.sessions ?? memorySessions({ clock: this.#clock });
    this.hookPages = o.hookPages ?? memoryHookPages();
    this.site = o.site ?? memorySite();
    this.raw = o.raw ?? memoryRaw(this.calls);
    this.probe = o.probe ?? NO_BROWSER;
    this.#fail = o.fail;
  }

  async load(): Promise<void> {
    this.calls.push({ member: 'load' });
    this.#loaded = true;
  }

  /** As the composition package's runner-web-capture.ts: a synchronous member needs the runner loaded. */
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
