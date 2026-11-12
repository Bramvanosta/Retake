/**
 * The hook phases of a capture run, whatever drives the product: the journal and the context the setup, the `hook:`
 * steps, the teardown and the rollbacks share. What reaches into the product (a js hook's page, a persona's session)
 * is the driver's (`DriverHooks`).
 */
import { join } from 'node:path';
import { resolveNamedHook } from '@retake/core/hooks';
import type { TemplateContext } from '@retake/core/base';
import type { Confinement, HookStep, LoadedProject, Scenario } from '@retake/core/model';
import type { RunAccess } from '@retake/core/environment';
import type { WorkPolicy } from '@retake/core/policy';
import type { CaptureHookRunner, ConfirmHook, HookContext, HookJournal, HookResult, HookTrust, TrustedHookFiles } from '@retake/core/hooks';
import type { RunProgress, RunRecord, RunningRun } from '@retake/core/run';
import { RunnerError, StepError } from '../errors.js';
import { hookResultFailed, hookResultName, loadHookRunner } from '../hooks-bridge.js';
import type { HookStepOutcome, LogLevel } from '../runtime.js';
import { throwIfAborted } from '../util.js';
import type { RunOptions } from './options.js';

export interface HooksState {
  runner: CaptureHookRunner;
  journal: HookJournal;
  ctx: HookContext;
}

/** What the driver hands the hooks of its run (its product's side of the hook context). */
export interface DriverHooks {
  /** A js hook's code, run in a page of the product (HookContext.evalInPage). */
  evalInPage?: HookContext['evalInPage'];
  /** `auth: {persona}` of an http hook (hotfix v0.2.3): the persona's session, read in its browser of the run. */
  personaAuth?: HookContext['personaAuth'];
}

export interface SetupDeps extends DriverHooks {
  /** What the run runs under (RunOptions.policy): its hooks get it too. */
  policy: WorkPolicy;
  project: LoadedProject;
  env: { name: string; pages: Record<string, string> };
  /** The run's access: a read-only run refuses hooks that write (each one again, on its templated content). */
  access: RunAccess;
  template: TemplateContext;
  runId: string;
  dir: string;
  emit: (e: RunProgress) => void;
  log: (level: LogLevel, message: string) => void;
  record: RunningRun;
  /** The run's cancel (Ctrl-C, SIGTERM, opts.signal): it stops the setup — a running shell command's process group too. */
  signal: AbortSignal;
  /** The process groups of the shell hooks running now (any phase): a second signal kills them before the process quits. */
  running: Set<number>;
  trust?: HookTrust;
  via?: Confinement;
  /** Trust `mcp`: the scenario's own vars, the agent's (HookContext.agentVars). */
  agentVars?: readonly string[];
  /** L7.39: the files a person checked before the run (HookContext.trustedFiles). */
  trustedFiles?: TrustedHookFiles;
  confirmHook?: ConfirmHook;
  recordHookRun?: RunOptions['recordHookRun'];
}

/**
 * The hooks of a run: the journal and the context the setup, the teardown and the rollbacks share. Opened before the
 * setup runs, so the teardown runs even when the setup failed or was interrupted.
 */
export async function openHooks(runner: CaptureHookRunner, d: SetupDeps): Promise<HooksState> {
  await loadHookRunner(runner);
  const journal = await runner.journals.open(join(d.dir, 'hooks-journal.json'));
  const saved: Record<string, unknown> = {};
  d.template.hooks = saved;
  const ctx: HookContext = {
    project: d.project,
    policy: d.policy,
    env: d.env,
    vars: Object.fromEntries(Object.entries(d.template.vars ?? {}).map(([k, v]) => [k, String(v)])),
    runId: d.runId,
    runDir: d.dir,
    // Hooks only get here when they are enabled; in a dry run that takes an explicit `hooks: 'run'`, so they
    // really execute: the dry run then sees the same prepared data as a capture.
    dryRun: false,
    log: (level, msg) => d.log(level, msg),
    access: d.access,
    // js hooks run where the driver says (the browser's: a guarded tab of their own, kept for the run, never a capture tab).
    ...(d.evalInPage ? { evalInPage: d.evalInPage } : {}),
    saved,
    // Every phase's shell commands (setup, teardown, rollbacks): a second signal kills them before the process quits.
    running: d.running,
    ...(d.trust ? { trust: d.trust } : {}),
    ...(d.via ? { via: d.via } : {}),
    ...(d.agentVars ? { agentVars: d.agentVars } : {}),
    ...(d.trustedFiles ? { trustedFiles: d.trustedFiles } : {}),
    ...(d.confirmHook ? { confirmDestructive: d.confirmHook } : {}),
    ...(d.recordHookRun ? { recordRun: (r: HookResult, run?: string) => d.recordHookRun!(r, run ?? d.runId) } : {}),
    ...(d.personaAuth ? { personaAuth: d.personaAuth } : {}),
  };
  return { runner, journal, ctx };
}

/**
 * The setup hooks. A cancel stops them — a running shell command's process group gets SIGTERM (an http, sql or js
 * hook ends first), the remaining hooks do not run, the completed ones are rolled back (never interrupted themselves)
 * before the teardown — and cancels the run.
 */
export async function setupHooks(h: HooksState, setup: HookStep[], d: SetupDeps): Promise<void> {
  if (!setup.length) {
    d.record.hooks.setup = 'none';
    return;
  }
  d.emit({ type: 'hook', phase: 'setup', name: 'setup', status: 'start', message: `${setup.length} hook(s)` });
  // Only the setup sees the run's cancel. The same context object as the teardown's and the rollbacks': the secrets
  // the hooks resolve are looked up once per run and stay registered for redaction.
  h.ctx.signal = d.signal;
  let res: Awaited<ReturnType<CaptureHookRunner['run']>>;
  try {
    // The scenario's own hooks: the agent's with trust `mcp` (a shell one is plain words, core agentShellProblems).
    res = await h.runner.run(setup, h.ctx, { phase: 'setup', journal: h.journal, agentWritten: true });
  } finally {
    delete h.ctx.signal;
  }
  res.results.forEach((r, i) => d.emit({ type: 'hook', phase: 'setup', name: hookResultName(r, i), status: hookResultFailed(r) ? 'failed' : 'ok', message: r.error ?? r.message }));
  d.record.hooks.setup = res.ok ? 'ok' : 'failed';
  if (!res.ok) {
    throwIfAborted(d.signal);
    // An optional hook may have failed before the one that stopped the setup: report the blocking one.
    const failed = res.results.find((r) => hookResultFailed(r) && r.optional !== true) ?? res.results.find(hookResultFailed);
    throw new RunnerError(
      `setup hooks failed${failed ? ` (${hookResultName(failed, res.results.indexOf(failed))}: ${failed.error ?? failed.message ?? 'error'})` : ''}; completed setup hooks were rolled back`,
    );
  }
}

/**
 * The runner of `hook:` steps (L5.8): the named hook (the scenario's, else project.yaml's) runs in the setup's context
 * — the same journal (its rollbacks are undone with the setup's, after the teardown), the same saved results
 * (`{{hooks.<save_as>…}}` in later steps) — with the run's cancel. A failed or refused entry fails the step.
 */
export function stepHookRunner(h: HooksState, sc: Scenario, d: SetupDeps): (name: string) => Promise<HookStepOutcome> {
  return async (name) => {
    const named = resolveNamedHook(name, sc, d.project);
    if (!named) throw new StepError(`unknown hook "${name}": declare it under \`hooks:\` in the scenario or in project.yaml`);
    d.emit({ type: 'hook', phase: 'step', name, status: 'start', message: `${named.hooks.length} hook(s)` });
    h.ctx.signal = d.signal;
    let res: Awaited<ReturnType<CaptureHookRunner['run']>>;
    try {
      // A scenario's named hook is the agent's with trust `mcp`; project.yaml's is a person's (unless it uses the scenario's vars).
      res = await h.runner.run(named.hooks, h.ctx, { phase: 'step', journal: h.journal, agentWritten: named.source === 'scenario' });
    } finally {
      delete h.ctx.signal;
    }
    res.results.forEach((r, i) => d.emit({ type: 'hook', phase: 'step', name: hookResultName(r, i), status: hookResultFailed(r) ? 'failed' : 'ok', message: r.error ?? r.message }));
    const results = res.results.map((r, i) => `${hookResultName(r, i)}: ${hookResultFailed(r) ? `failed${r.optional ? ' (optional)' : ''}` : (r.message ?? 'ok')}`);
    if (!res.ok) {
      throwIfAborted(d.signal);
      d.record.hooks.steps = 'failed';
      const failed = res.results.find((r) => hookResultFailed(r) && r.optional !== true) ?? res.results.find(hookResultFailed);
      throw new StepError(`hook "${name}" failed${failed ? ` (${hookResultName(failed, res.results.indexOf(failed))}: ${failed.error ?? failed.message ?? 'error'})` : ''}`);
    }
    return { hook: name, results };
  };
}

/**
 * Teardown hooks always run, then the setup hooks still pending in the journal are rolled back (most recent first),
 * like `finally` blocks unwinding: teardown cleans what the scenario did, rollbacks undo what setup did.
 */
export async function teardownHooks(h: HooksState, teardown: HookStep[], emit: (e: RunProgress) => void, log: (level: LogLevel, message: string) => void): Promise<RunRecord['hooks']['teardown']> {
  let ok = true;
  let ran = false;
  if (teardown.length) {
    ran = true;
    emit({ type: 'hook', phase: 'teardown', name: 'teardown', status: 'start', message: `${teardown.length} hook(s)` });
    const res = await h.runner.run(teardown, h.ctx, { phase: 'teardown', journal: h.journal, agentWritten: true });
    res.results.forEach((r, i) => emit({ type: 'hook', phase: 'teardown', name: hookResultName(r, i), status: hookResultFailed(r) ? 'failed' : 'ok', message: r.error ?? r.message }));
    ok = res.ok;
  }
  const pending = h.journal.pending().length;
  if (pending) {
    ran = true;
    log('info', `rolling back ${pending} setup hook(s)`);
    emit({ type: 'hook', phase: 'rollback', name: 'rollback', status: 'start', message: `${pending} setup hook(s)` });
    const results = await h.journal.rollbackAll(h.ctx);
    results.forEach((r, i) => emit({ type: 'hook', phase: 'rollback', name: hookResultName(r, i), status: hookResultFailed(r) ? 'failed' : 'ok', message: r.error ?? r.message }));
    if (results.some(hookResultFailed)) ok = false;
  }
  if (!ran) return 'none';
  return ok ? 'ok' : 'failed';
}
