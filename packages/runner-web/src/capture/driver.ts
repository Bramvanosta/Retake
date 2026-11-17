/**
 * The seam between a capture run's lifecycle (lifecycle.ts: the run folder and record, the log, the secrets, the
 * cancel, `until`, the hook phases, filming notices, the timeline and the run's end) and what drives the product and
 * films it (a driver: browser-driver.ts drives Chromium through Playwright with the in-page kit). Internal to the
 * runner: the lifecycle calls a driver's phases in this order — prepare, identify, open, hooks / setHookSteps, film
 * (failed when anything of the run threw), then always stop, close and finish — and a driver reads and writes the run
 * through `CaptureRun`. Nothing here names a browser.
 */
import type { TemplateContext } from '@retake/core/base';
import type { CaptureSettings, LoadedProject, Pacing } from '@retake/core/project';
import type { LoadedScenario, Scenario } from '@retake/core/scenario';
import type { CaptionSpec, NormalizedStep, SceneEntry } from '@retake/core/language';
import type { MailboxConfig, ResolvedClock, ResolvedEnvironment } from '@retake/core/environment';
import type { CaptureDevice, MissingTarget, RunMode } from '@retake/core/run';
import type { RunAccess } from '@retake/core/environment';
import type { RunProgress, RunningRun } from '@retake/core/run';
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
  /** The environment's mailbox (a sandbox's own, else the project's) and whether this run reads mail. */
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
  /** A capture told onFilming: its pauses and resumes are told too; undefined otherwise. */
  readonly filmingPause: ((on: boolean) => void) | undefined;
}

/** What a driver's take gives the timeline (TimelineBuilder.build, but the duration: the run's endT). */
export interface DriverTake {
  /** Nothing of the take is kept (a sign-in landing, a failed preflight): no timeline either. */
  discard: boolean;
  capture: {
    file: string;
    frames: number;
    frameTimes: number[];
    idleFrameTimes?: number[];
    /**
     * The picture's size in points and, when it is not the project's `capture.scale`, its pixels per point (a device's
     * screen: an iOS simulator's 402×874 pt at 3). Absent: the project's capture size and scale.
     */
    size?: { width: number; height: number; scale?: number };
    /** The device it was filmed on, when it is no browser page (timeline `capture.device`). */
    device?: CaptureDevice;
  };
}

/**
 * The lifecycle's own tools a driver outside this package plays its steps with (a driver of another package imports
 * nothing of the runner but its types: `@retake/runner-web/types`). A failure made by `stepFailure` is read by the run's
 * end as a failed step (its scene, step, action, screenshot and snippet in run.json).
 */
export interface CaptureTools {
  /** A failed step: the error the run aborts with (StepFailure). */
  stepFailure(message: string, o: { scene: string; step: number; action: string; screenshot?: string; dom?: string; missing?: MissingTarget[] }): Error;
  /** A refusal or failure of the run, said as it is (RunnerError). */
  runnerError(message: string): Error;
  /** Whether `e` is the run's cancel. */
  isCancelled(e: unknown): boolean;
  /** An error's message (any thrown value). */
  errorMessage(e: unknown): string;
  /** A step as progress events and the outline describe it. */
  describeStep(step: NormalizedStep): string;
  /** A scene's or a step's caption as the timeline records it. */
  caption(c: CaptionSpec | undefined): { kicker?: string; text: string } | undefined;
  /** A part of the scenario templated: a TemplateError fails the run in its words. */
  templated<T>(fn: () => T, record: RunningRun): T;
  /** A scene entry as far as the run goes (`--until`). */
  untilSteps<T extends SceneEntry>(entry: T, si: number, until: StepRef | null): T;
  /** Throws the run's cancel (or failure) when `signal` is aborted. */
  throwIfAborted(signal?: AbortSignal): void;
  /** An abortable sleep. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

/** What makes the driver of a run: the browser's (browserDriver), or another package's (RunOptions.driver). */
export type DriverFactory = (run: CaptureRun, tools: CaptureTools) => CaptureDriver;

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
  /** What runs a `hook:` step: the run's hook context, or the line that says the hooks are skipped. */
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
  /** A second signal, before the process quits (synchronous): what must not outlive it (session copies). */
  cleanupSync(): void;
}
