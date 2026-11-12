/**
 * What a capture run is given (runScenario's options, whatever drives the product) and what it tells its caller while
 * it films (onFilming).
 */
import type { AgentChannel, BrowserConfig, CaptureHookRunner, ConfirmHook, HookResult, HookTrust, LoadedProject, LoadedScenario, LoadedTemplate, RunMode, RunProgress, RunSandbox, WorkPolicy } from '@retake/core';
import type { InspectRequest } from '../inspect.js';
import type { LiveSink } from '../live-preview.js';
import type { PauseGate } from '../pause.js';

export interface RunOptions {
  project: LoadedProject;
  /** What the work runs under (core WorkPolicy): which Chromium and ffmpeg, which switches, under its agent policy. */
  policy: WorkPolicy;

  scenario: LoadedScenario;
  template?: LoadedTemplate;
  mode: RunMode;
  /** Environment name (default: scenario.env, project.default_env, first environment). */
  env?: string;
  /** Stop after this step (`scene.step`, `scene.<index>`, a step id or a scene id). */
  until?: string;
  /** Default: capture = run, dry = skip. */
  hooks?: 'run' | 'skip';
  headed?: boolean;
  runId?: string;
  /** Default <project>/runs. */
  runsDir?: string;
  onProgress?: (e: RunProgress) => void;
  signal?: AbortSignal;
  /** Overrides project.config.browser. */
  browser?: BrowserConfig;
  /** ffmpeg binary (default: core `ffmpegBin()` — retake.yaml, $RETAKE_FFMPEG, the app's, PATH). */
  ffmpeg?: string;
  /**
   * Capture without the in-page cursor (raw export for editors, L2.13: `retake run --raw --cursor none|layer`). The
   * pointer still drives real input and the cursor track, icon, presses and ripples are recorded; nothing of the
   * cursor is drawn in the pictures. The timeline says so (`capture.cursor: hidden`).
   */
  hideCursor?: boolean;
  /** Resolves `{{env:…}}` / `{{keychain:…}}` references (default core resolveSecretRef; tests inject one). */
  resolveSecret?: (ref: string) => Promise<string>;
  /** The command that signs a persona in again, as messages print it (default `retake login <project> --env … --persona …`). */
  loginCommand?: (p: { project: string; env: string; persona?: string }) => string;
  /**
   * `--allow-writes` (L1.7): lets a run on a production environment whose project.yaml sets `access: read-write` write.
   * On a read-only environment it is refused (core AccessError, thrown before anything is recorded).
   */
  allowWrites?: boolean;
  /**
   * The sandbox reset made before this take (L1.8, `retake run --sandbox`: @retake/sandbox prepareTake), recorded as
   * run.json / timeline.json `environment.sandbox`. A run on a sandbox environment without it records the sandbox
   * without a reset.
   */
  sandbox?: RunSandbox;
  /**
   * Who stands behind the trust flags of the scenario's hooks (L3.1, core HookTrust; default `author`). `mcp` (a job
   * submitted through the MCP server): `confirm: true` does not count, every shell hook needs an approval
   * (`confirmHook`) and always counts as writing — a read-only run refuses it before anything runs.
   */
  hookTrust?: HookTrust;
  /**
   * What runs the scenario's setup, teardown and hook steps (L7.12: the engine's HookRunner, its composition root's;
   * the runner never loads the hooks package itself). Loaded when the run's hooks are opened (a failed load fails the
   * run, as before); a run whose hooks run without one is refused before anything runs.
   */
  hookRunner?: CaptureHookRunner;
  /**
   * Reports each hook and rollback this run executes (hooks HookContext.recordRun) with the run's id: the engine journals
   * it in the workspace journal as its caller's (absent: not journaled).
   */
  recordHookRun?: (result: HookResult, runId: string) => Promise<void>;
  /**
   * The channel a trust-`mcp` run came through, for the wording of its refusals (L4.2): `studio` (a Studio user is told
   * "from the Studio", never about MCP) or `mcp` (default).
   */
  hookVia?: AgentChannel;
  /**
   * Approves a hook that needs a human (L3.1: the jobs worker checks the hook's fingerprint against its job's
   * approvals). Without it such hooks are refused, as before.
   */
  confirmHook?: ConfirmHook;
  /**
   * Inspect the page at the end (L3.3, inspect.ts): after the last step (or `until`), or at the step that failed — never
   * after a sign-in landing. Needs `mode: 'dry'` (the environment's own access, as `run_dry`); hooks are skipped, the
   * replay runs at INSPECT_PACING without per-step screenshots. With `runsDir` / `runId` the run folder (and the
   * report's files) go where the caller keeps inspections, out of `runs/`.
   */
  inspect?: InspectRequest;
  /**
   * The live picture (L4.4, live-preview.ts): frames of the page the run acts on, from capture time 0 to the end of the
   * scenes, while the sink says someone watches. Memory only.
   */
  live?: LiveSink;
  /** Pauses between steps (L4.4, pause.ts): a dry run waits while the gate asks; a capture says it does not pause. */
  pause?: PauseGate;
  /**
   * Captures first (L5.14): told when a capture starts filming (capture time 0), pauses and resumes (L4.4: the pause is
   * not filmed; `resume` comes before the recorders film again) and stops filming (its recorders stopped, before the
   * teardown). Setup and teardown hooks, prewarm and the encode's end are not filming. Never called for a dry run.
   * Its answer to `stop` is what the take saw beside it (run.json `perf.machine`).
   */
  onFilming?: (state: FilmingEvent) => void | FilmingReport;
}

/** What onFilming says (L5.14). */
export type FilmingEvent = 'start' | 'pause' | 'resume' | 'stop';

/**
 * What a take saw beside it while it filmed (L5.14, the caller's captures sampler): the most other takes filming at once
 * on this Mac, and whether a heavy job of its workspace ran slowed (background priority) during it.
 */
export interface FilmingReport {
  takes_beside: number;
  heavy_slowed: boolean;
}
