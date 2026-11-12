/**
 * A run of a scenario, as `retake run` and the jobs worker both start it (L3.1, moved from the CLI's run command):
 * prepare (project, sandbox pick, scenario validated against the environment it runs on, template), then execute (the
 * scenario's warnings and notes, the sandbox take or check, the capture runner's run). Native options and native errors: the CLI keeps
 * its messages, output and exit codes; what it prints goes through `RunPorts`, in the same order as before.
 */
import { parseScenarioSource, resolveEnvironment, resolveRunAccess, sandboxNames, sandboxOf, scenarioSourceEnv, GUIDE, sandboxErrorKind } from '@retake/core';
import { loadProjectTemplate, readScenarioSource, fileFacts } from '@retake/core/io';
import type { AgentChannel, HookTrust, LoadedProject, LoadedScenario, LoadedTemplate, RunProgress, RunRecord, Timeline, ValidationIssue, ErrorKind, WorkPolicy } from '@retake/core';
import type { ConfirmHook, FilmingEvent, FilmingReport, LiveSink, PauseGate } from '@retake/runner-web/types';
import type { SandboxLog, Take } from '@retake/sandbox';
import type { CaptureRunner } from './capture/runner.js';
import type { HookRunner } from './hook-run/runner.js';
import { hookRunRecorder } from './store/journal.js';
import { formatMs, sandboxUpText } from './format.js';
import type { InterruptPort } from './interrupts.js';
import type { OpenedWorkspace } from './workspace.js';
import type { JournalAs } from './store/journal.js';

/** A run option that cannot be used as given (the CLI reports it as a usage error, exit 2). */
export class RunOptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunOptionError';
  }

  /** What a client outside the CLI is told (core error-kind.ts). */
  get errorKind(): ErrorKind {
    return 'invalid';
  }
}

/** The sandbox take before a run failed (`interrupted`: a signal stopped it — the CLI exits 130). */
export class SandboxTakeError extends Error {
  constructor(
    message: string,
    readonly interrupted: boolean,
    /** The sandbox error's code (busy, down, interrupted…), when it was one. */
    readonly code?: string,
  ) {
    super(message);
    this.name = 'SandboxTakeError';
  }

  /** What a client outside the CLI is told (core error-kind.ts). */
  get errorKind(): ErrorKind {
    return sandboxErrorKind(this.code, this.message, 'unavailable');
  }

  get errorDocs(): string {
    return GUIDE.sandbox;
  }
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export interface RunRequest {
  dry?: boolean;
  until?: string;
  hooks?: 'run' | 'skip';
  env?: string;
  headed?: boolean;
  /** Reset the sandbox environment to its seed before the take (L1.8): up if needed, health, reset. */
  sandbox?: boolean;
  /** sha256 the scenario file's bytes must have (a job's): core ScenarioChangedError otherwise, before they are parsed. */
  expectSha256?: string;
  /** Reads the scenario file's bytes (default node:fs; a test seam): called once per prepareRun. */
  readFile?: (file: string) => Promise<Uint8Array>;
}

export interface PreparedRun {
  ws: OpenedWorkspace;
  project: LoadedProject;
  scenario: LoadedScenario;
  template?: LoadedTemplate;
  /** The template did not load: the capture uses the default cursor colours. */
  templateWarning?: string;
  /** `sandbox: true`: the sandbox environment the run is on (pickSandboxEnv). */
  sandboxEnv?: string;
}

/**
 * The sandbox environment of `run --sandbox`: `env` (it must be a sandbox), else the scenario's `env` when it is a
 * sandbox, else `default_env` when it is one, else the first sandbox. RunOptionError otherwise.
 */
export function pickSandboxEnv(project: LoadedProject, env: string | undefined, scenarioEnv: string | undefined): string {
  const names = sandboxNames(project);
  if (!names.length) throw new RunOptionError(`--sandbox resets a sandbox before the take, and project ${project.slug} has none: add \`sandboxes:\` to project.yaml (see docs/guide/sandbox.md)`);
  if (env !== undefined) {
    if (!names.includes(env)) throw new RunOptionError(`--sandbox resets a sandbox before the take: environment ${env} is not a sandbox (sandboxes: ${names.join(', ')})`);
    return env;
  }
  if (scenarioEnv !== undefined && names.includes(scenarioEnv)) return scenarioEnv;
  const def = project.config.default_env;
  if (def !== undefined && names.includes(def)) return def;
  return names[0];
}

/** `--allow-writes` where the environment is read-only in project.yaml: AccessError before anything runs (CLI: exit 2). */
export function checkAllowWrites(project: Parameters<typeof resolveEnvironment>[0], env: string | undefined): void {
  let resolved: ReturnType<typeof resolveEnvironment>;
  try {
    resolved = resolveEnvironment(project, env);
  } catch {
    return; // an unknown environment is reported where it is used
  }
  resolveRunAccess(resolved, { allowWrites: true });
}

/**
 * Load what a run needs. `sandbox`: no sandbox, or an `env` that is not one, is a RunOptionError before anything is
 * read. The sandbox is picked from the scenario's raw `env:` first, then the scenario is validated once, against the
 * environment it runs on (its pages, its mailbox): a scenario without `env:` that waits for an email only the sandbox's
 * mailbox receives. The file is read once (its sha256 is `scenario.sha256`, checked against `expectSha256` when given):
 * the sandbox's pick and the validation work on the same bytes.
 */
export async function prepareRun(ws: OpenedWorkspace, project: LoadedProject, scenarioRef: string, req: RunRequest): Promise<PreparedRun> {
  if (req.sandbox) pickSandboxEnv(project, req.env, undefined); // no sandbox, or `env` not one: refused before the read
  const src = await readScenarioSource(project, scenarioRef, { ...(req.expectSha256 !== undefined ? { expectSha256: req.expectSha256 } : {}), ...(req.readFile ? { readFile: req.readFile } : {}) });
  const sandboxEnv = req.sandbox ? pickSandboxEnv(project, req.env, scenarioSourceEnv(src.text)) : undefined;
  const scenario = parseScenarioSource(project, src, { files: fileFacts(ws.policy), env: sandboxEnv ?? req.env, until: req.until });
  let template: LoadedTemplate | undefined;
  let templateWarning: string | undefined;
  try {
    template = await loadProjectTemplate(project, scenario.scenario.template, { files: fileFacts(ws.policy) });
  } catch (e) {
    // Phase 1 only takes the cursor ripple colour from the template: capture with the defaults.
    templateWarning = `${errorMessage(e)} — capturing with the default cursor colours`;
  }
  if (req.headed && process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    throw new Error('--headed needs a display, and none is available (DISPLAY / WAYLAND_DISPLAY are not set)');
  }
  return { ws, project, scenario, ...(template ? { template } : {}), ...(templateWarning ? { templateWarning } : {}), ...(sandboxEnv ? { sandboxEnv } : {}) };
}

/** What a run tells its client before and while it runs (the CLI prints it; the worker records it as job events). */
export interface RunPorts {
  /** The scenario's validation warnings (it loaded, so none is an error). */
  issues(issues: readonly ValidationIssue[], file: string): void;
  /** Notes before the run: a template that did not load, a dry run without its setup, the sandbox take or check. */
  note(level: 'info' | 'warn', message: string): void;
  /** Messages of the sandbox calls (a take's up, health, reset). */
  sandboxLog: SandboxLog;
  /** The runner's progress events (redacted by the runner). */
  progress(e: RunProgress): void;
  /** A signal during the sandbox take (the runner handles its own). */
  interrupts: InterruptPort;
}

export interface ExecuteRunOptions {
  /** What the work runs under (core WorkPolicy): its programs, browser and ffmpeg, under the agent policy. */
  policy: WorkPolicy;
  /** What films the run (its composition root's capture runner, capture/runner.ts). */
  capture: CaptureRunner;
  /** What the run's setup, teardown and hook steps run through (its composition root's hook runner). */
  hooks: HookRunner;
  /** A run id reserved ahead (core reserveRunId: a job's); default a new one. */
  runId?: string;
  /** `--allow-writes` (L1.7): checked by the caller first (checkAllowWrites). */
  allowWrites?: boolean;
  /** Capture without the in-page cursor (`run --raw --cursor none|layer`). */
  hideCursor?: boolean;
  signal?: AbortSignal;
  /** The command that signs a persona in again, as messages print it. */
  loginCommand?: (p: { project: string; env: string; persona?: string }) => string;
  /** Who stands behind the scenario's hook flags (default `author`; `mcp` for a job submitted through MCP). */
  hookTrust?: HookTrust;
  /** Who runs it: each hook, rollback and sandbox seed step run is a line of the workspace journal as this caller's. */
  recordAs?: JournalAs;
  /** The channel a trust-`mcp` job came through, for the wording of refusals (`studio`: the Studio; default `mcp`). */
  hookVia?: AgentChannel;
  /** Approves a hook that needs a human (the worker: the job's approvals). */
  confirmHook?: ConfirmHook;
  /** The live picture's sink (L4.4, the worker's live channel): memory only, from capture time 0 to the scenes' end. */
  live?: LiveSink;
  /** Pauses between steps (L4.4, the worker's `pause` marker): a dry run waits; a capture says it does not pause. */
  pause?: PauseGate;
  /** Captures first (L5.14): when a capture films (runner onFilming) — the caller writes the filming marker. */
  onFilming?: (state: FilmingEvent) => void | FilmingReport;
}

/** `sandbox: true`: lock, up if needed, health, reset — under the interrupt port (what it started is stopped). */
async function prepareSandboxTake(project: LoadedProject, env: string, scenario: string, ports: RunPorts, opts: ExecuteRunOptions): Promise<Take> {
  const { openSandbox } = await import('@retake/sandbox');
  const sb = openSandbox(project, env, opts.policy);
  const stop = await ports.interrupts.open({ message: 'interrupted: stopping what this take started…', onQuitSync: () => sb.killStartedSync() });
  let take: Take;
  try {
    take = await sb.prepareTake({
      signal: stop.signal,
      log: ports.sandboxLog,
      command: `run ${scenario}`,
      // The seed a reset may run is under the run's trust: through MCP a shell seed step needs its approval too.
      ...(opts.hookTrust ? { seedTrust: { trust: opts.hookTrust, ...(opts.confirmHook ? { confirm: opts.confirmHook } : {}) } } : {}),
      ...(opts.recordAs ? { recordSeedRun: hookRunRecorder(project.root, opts.recordAs, { project: project.slug }) } : {}),
    });
  } catch (e) {
    const code = (e as { code?: string })?.code;
    throw new SandboxTakeError(errorMessage(e), code === 'interrupted', code);
  } finally {
    stop.dispose();
  }
  if (stop.interrupted) {
    await take.release();
    throw new SandboxTakeError(`sandbox ${env}: interrupted`, true, 'interrupted');
  }
  const restored = take.reset.snapshot?.action === 'restored' ? ` (snapshot restored in ${formatMs(take.reset.snapshot.ms)})` : take.reset.snapshot ? ' (seeded, snapshot taken)' : '';
  ports.note('info', `sandbox ${env} (${sb.kind}) · ${sandboxUpText(take.up)} · reset ${take.reset.strategy} ${formatMs(take.reset.ms)}${restored}`);
  return take;
}

/**
 * A run on a sandbox environment without `sandbox`: no reset, and the sandbox must be up (its SandboxError otherwise);
 * a take holding its lock is a warning. Nothing for other environments.
 */
export async function checkSandboxEnv(project: LoadedProject, env: string, note: RunPorts['note'], policy: WorkPolicy): Promise<void> {
  if (!sandboxOf(project, env)) return;
  const { openSandbox, describeLock } = await import('@retake/sandbox');
  const { lock } = await openSandbox(project, env, policy).checkRunning();
  if (lock) note('warn', `sandbox ${env} is in use by ${describeLock(lock)}: this run films it as it is, while that command may reset it`);
  note('info', `sandbox ${env}: filmed as it is, without a reset (--sandbox resets it to its seed first)`);
}

/**
 * Execute a prepared run: its warnings and notes, the sandbox take (or the check of a sandbox environment), then the
 * capture runner (`opts.capture`, its hooks through `opts.hooks`). Returns the run record (a failed or cancelled run is a record, not an error). Throws before the run:
 * SandboxTakeError (the take failed), the sandbox check's error, the runner's own early errors (access, --until, clock).
 * A sandbox failure creates no run folder (a reserved one stays as it was: the caller finalises it).
 */
export async function executeRun(p: PreparedRun, req: RunRequest, opts: ExecuteRunOptions, ports: RunPorts): Promise<RunRecord> {
  const { ws, project, scenario, template, sandboxEnv } = p;
  // sandbox (L1.8): the run is on the sandbox environment pickSandboxEnv chose.
  const runEnv = sandboxEnv ?? req.env;
  const notes = p.templateWarning ? [p.templateWarning] : [];
  if (req.dry && req.hooks === undefined && (scenario.scenario.setup?.length ?? 0) > 0) {
    notes.push('dry run without its setup hooks: steps that need prepared data may fail (add --hooks run to execute them)');
  }
  ports.issues(scenario.issues, scenario.file);
  for (const n of notes) ports.note('warn', n);

  // L1.8: `sandbox` resets the sandbox before the take (it stays up after); a sandbox environment without it is filmed
  // as it is, and must be up.
  let take: Take | undefined;
  if (sandboxEnv) take = await prepareSandboxTake(project, sandboxEnv, scenario.name, ports, opts);
  else await checkSandboxEnv(project, resolveEnvironment(project, req.env ?? scenario.scenario.env).name, ports.note, opts.policy);

  try {
    return await opts.capture.run({
      policy: opts.policy,
      project,
      scenario,
      template,
      mode: req.dry ? 'dry' : 'capture',
      env: runEnv,
      until: req.until,
      hooks: req.hooks,
      headed: req.headed,
      ffmpeg: ws.ffmpeg,
      ...(opts.loginCommand ? { loginCommand: opts.loginCommand } : {}),
      ...(opts.runId !== undefined ? { runId: opts.runId } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(opts.allowWrites ? { allowWrites: true } : {}),
      ...(opts.hideCursor ? { hideCursor: true } : {}),
      ...(opts.hookTrust ? { hookTrust: opts.hookTrust } : {}),
      ...(opts.recordAs ? { recordHookRun: hookRunRecorder(project.root, opts.recordAs, { project: project.slug }) } : {}),
      ...(opts.hookVia ? { hookVia: opts.hookVia } : {}),
      ...(opts.confirmHook ? { confirmHook: opts.confirmHook } : {}),
      ...(opts.live ? { live: opts.live } : {}),
      ...(opts.pause ? { pause: opts.pause } : {}),
      ...(opts.onFilming ? { onFilming: opts.onFilming } : {}),
      ...(take ? { sandbox: take.info } : {}),
      onProgress: (e) => {
        if (take && e.type === 'run_start') take.note(e.run.id);
        ports.progress(e);
      },
      hookRunner: opts.hooks,
    });
  } finally {
    await take?.release();
  }
}

/**
 * "1 mocked, 0 stopped" (+ allowed, to unguarded hosts) for a read-only run; "1 stopped (hosts of read-only
 * environments)" for a read-write run whose guard stopped a write to another environment's host; undefined otherwise.
 * The automated sign-in's exempt writes are not counted.
 */
export function writesSummary(tl: Pick<Timeline, 'environment'> | undefined): { text: string; stopped: number } | undefined {
  const env = tl?.environment;
  if (!env) return undefined;
  const n = { blocked: 0, mocked: 0, allowed: 0, passed: 0 };
  for (const w of env.writes ?? []) if (w.outcome !== 'exempt') n[w.outcome]++;
  if (env.access !== 'read-only') return n.blocked ? { text: `${n.blocked} stopped (hosts of read-only environments)`, stopped: n.blocked } : undefined;
  const parts = [`${n.mocked} mocked`, `${n.blocked} stopped`];
  if (n.allowed) parts.push(`${n.allowed} allowed`);
  if (n.passed) parts.push(`${n.passed} to unguarded hosts`);
  return { text: `${parts.join(', ')} (read-only)`, stopped: n.blocked };
}

