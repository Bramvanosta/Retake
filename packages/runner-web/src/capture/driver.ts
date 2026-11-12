/**
 * The seam between a capture run's lifecycle (lifecycle.ts: the run folder and record, the log, the secrets, the
 * cancel, `until`, the hook phases, filming notices, the timeline and the run's end) and what drives the product and
 * films it (a driver: browser-driver.ts drives Chromium through Playwright with the in-page kit). Internal to the
 * runner: the lifecycle calls a driver's phases in this order — prepare, identify, open, hooks / setHookSteps, film
 * (failed when anything of the run threw), then always stop, close and finish — and a driver reads and writes the run
 * through `CaptureRun`. Nothing here names a browser.
 */
import type { CaptureSettings, LoadedProject, LoadedScenario, MailboxConfig, Pacing, ResolvedClock, RunAccess, RunMode, ResolvedEnvironment, RunProgress, RunningRun, Scenario, TemplateContext } from '@retake/core';
import type { HookStepOutcome, LogLevel } from '../runtime.js';
import type { RunSecrets } from '../secrets.js';
import type { RunFiles } from '../runfiles.js';
import type { CaptureClock, TimelineBuilder } from '../timeline.js';
import type { DriverHooks } from './hooks.js';
import type { FilmingReport, RunOptions } from './options.js';

/** A step of the scenario, by its scene and step index (core resolveStepRef: `--until`). */
export type StepRef = { sceneIndex: number; stepIndex: number };

/** A run in flight as the lifecycle holds it and its driver sees it. */
export interface CaptureRun {
  readonly opts: RunOptions;
  readonly project: LoadedProject;
  readonly loaded: LoadedScenario;
  readonly sc: Scenario;
  readonly mode: RunMode;
  readonly env: ResolvedEnvironment;
  readonly access: RunAccess;
  readonly runClock: ResolvedClock | undefined;
  readonly pacing: Pacing;
  readonly capture: CaptureSettings;
  readonly hooksMode: 'run' | 'skip';
  /** `--until`: the last step this run executes (null: all of them). */
  readonly until: StepRef | null;
  /** How many steps this run executes. */
  readonly total: number;
  readonly runId: string;
  readonly dir: string;
  readonly screenshotsDir: string;
  readonly framesDir: string;
  /** The run's record while it is in flight (its end makes another one: lifecycle.ts). */
  readonly record: RunningRun;
  readonly secrets: RunSecrets;
  readonly files: RunFiles;
  readonly emit: (e: RunProgress) => void;
  readonly log: (level: LogLevel, message: string) => void;
  /** The run's own cancel (a signal, a sign-in landing): `signal` aborts with it and with RunOptions.signal. */
  readonly abort: AbortController;
  readonly signal: AbortSignal;
  readonly clock: CaptureClock;
  readonly timeline: TimelineBuilder;
  readonly template: TemplateContext;
  /** The environment's mailbox (L1.8: a sandbox's own, else the project's) and whether this run reads mail. */
  readonly mailbox: MailboxConfig | undefined;
  readonly readsMail: boolean;
  /** Capture time 0 is set (writes and the like are stamped from then on). */
  readonly captureStarted: boolean;
  /** What failed the run (null: nothing yet); the driver may say more of it (a sign-in landing, an expired session). */
  failure: unknown;
  /** Capture time the take ended at (set by the driver's `stop`). */
  endT: number;
  /** Capture time 0, right before the first picture: the clock starts, a capture tells onFilming `start`. */
  startCapture(): void;
  /** Off camera: a capture that told `start` tells `stop` now, once; its answer is what the take saw beside it. */
  stopFilming(): FilmingReport | undefined;
  /** A capture told onFilming: its pauses and resumes are told too (L4.4); undefined otherwise. */
  readonly filmingPause: ((on: boolean) => void) | undefined;
}

/** What a driver's take gives the timeline (TimelineBuilder.build, but the duration: the run's endT). */
export interface DriverTake {
  /** Nothing of the take is kept (L1.6: a sign-in landing, a failed preflight): no timeline either. */
  discard: boolean;
  capture: { file: string; frames: number; frameTimes: number[]; idleFrameTimes?: number[]; size?: { width: number; height: number } };
}

/** What drives the product and films it, phase by phase (the module comment says the order). */
export interface CaptureDriver {
  /** Off camera, before the run's secrets are fetched: the product answers, its guards are armed. */
  prepare(): Promise<void>;
  /** The secrets fetched: who the run acts as, their own secret values registered (before the outline is told). */
  identify(): void;
  /** Opens what films (the sessions checked, the product's clock set), after the outline. */
  open(): Promise<void>;
  /** The product's side of the hooks' context (asked once, when the run's hooks are opened). */
  hooks(): DriverHooks;
  /** What runs a `hook:` step (L5.8): the run's hook context, or the line that says the hooks are skipped. */
  setHookSteps(run: (name: string) => Promise<HookStepOutcome>): void;
  /** Films the scenes: capture time 0 (`run.startCapture()`) to the last step, or `until`. */
  film(): Promise<void>;
  /** The run threw `e`: the failure as the driver reads it (what it does at a failed step included). */
  failed(e: unknown): Promise<unknown>;
  /** Off camera, before the teardown: filming stops (`run.stopFilming()`), `run.endT` is set. Never throws for the take. */
  stop(): Promise<void>;
  /** After the teardown: what the driver opened is closed. */
  close(): Promise<void>;
  /** After the run's signals are released: what is kept of the take, and what the timeline is built from. */
  finish(): Promise<DriverTake>;
  /** A second signal, before the process quits (synchronous): what must not outlive it (L1.6: session copies). */
  cleanupSync(): void;
}
