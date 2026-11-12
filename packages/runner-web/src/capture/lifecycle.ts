/**
 * A capture run's lifecycle, whatever drives the product (driver.ts): the options checked, the run folder, its record
 * and log (run.json, log.jsonl), the secrets masked wherever the run writes, the cancel (signals, RunOptions.signal),
 * `--until`, the refusals made before anything runs (agent trust, a read-only run's writing hooks), the secrets fetched
 * up front, the outline, the hook phases (setup, `hook:` steps, teardown and rollbacks), the filming notices
 * (onFilming), the timeline assembled and written, and the run's end. Never throws for step failures: the returned
 * RunRecord carries the status and error.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { FORMAT_VERSIONS } from '@retake/core/base';
import { AGENT_CONFINEMENT, confinementWords, isCaptureScene } from '@retake/core/model';
import { parseRunId } from '@retake/core/ids';
import { listSteps, resolveStepRef, sceneId, templateVideo, timelineVideo } from '@retake/core/language';
import { displayPages, displayTable, resolveClock, resolveEnvironment, resolveRunAccess } from '@retake/core/environment';
import { hookStepNames, stepHookList, writingHooks } from '@retake/core/hooks';
import { projectPath } from '@retake/core/project';
import { mailboxFor } from '@retake/core/sandbox';
import { agentTrustProblems } from '@retake/core/scenario';
import { finishRun, startedRun } from '@retake/core/run';
import { nodeFileFacts, reserveRunId, writeJson } from '@retake/core/io';
import type { TemplateContext } from '@retake/core/base';
import type { MailboxConfig, ResolvedClock, ResolvedEnvironment, RunError, RunSandbox, Scenario, TimelineEnvironment } from '@retake/core/model';
import type { RunAccess } from '@retake/core/environment';
import type { RunEnd, RunProgress, RunRecord, RunningRun } from '@retake/core/run';
import { mergeCapture, mergePacing, projectBrowser } from '../config.js';
import { runEngine } from '../engine.js';
import { CancelledError, RunnerError, errorMessage, isCancelled } from '../errors.js';
import { NO_HOOK_RUNNER } from '../hooks-bridge.js';
import { INSPECT_PACING } from '../inspect.js';
import type { LogLevel } from '../runtime.js';
import { RunFiles } from '../runfiles.js';
import { StepFailure, describeStep, templated, untilSteps } from '../scenes.js';
import { RunSecrets } from '../secrets.js';
import { CaptureClock, TimelineBuilder } from '../timeline.js';
import { throwIfAborted, wallNow } from '../util.js';
import type { CaptureDriver, CaptureRun } from './driver.js';
import { openHooks, setupHooks, stepHookRunner, teardownHooks } from './hooks.js';
import type { HooksState, SetupDeps } from './hooks.js';
import type { FilmingEvent, FilmingReport, RunOptions } from './options.js';

/**
 * SIGINT/SIGTERM abort the run (teardown still runs); a second signal kills the process — after the driver's cleanup
 * (the browser's: removing the session copies it made, which hold a persona's cookies; L1.6) and killing the shell hooks
 * still running (`groups`: their process groups, which a signal to this process alone would leave running).
 */
function installSignalHandlers(onSignal: (sig: NodeJS.Signals) => void, groups: ReadonlySet<number>, cleanupSync: () => void): () => void {
  let count = 0;
  const handler = (sig: NodeJS.Signals) => {
    count++;
    if (count === 1) {
      onSignal(sig);
      return;
    }
    remove();
    cleanupSync();
    for (const pgid of groups) {
      try {
        process.kill(-pgid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
    process.kill(process.pid, sig);
  };
  const remove = () => {
    process.off('SIGINT', handler);
    process.off('SIGTERM', handler);
  };
  process.on('SIGINT', handler);
  process.on('SIGTERM', handler);
  return remove;
}

/** A caller's onFilming never breaks a take; its report (to `stop`) is kept only when well formed. */
function tell(f: (state: FilmingEvent) => void | FilmingReport, state: FilmingEvent): FilmingReport | undefined {
  try {
    const r = f(state);
    return r && Number.isInteger(r.takes_beside) && r.takes_beside >= 0 && typeof r.heavy_slowed === 'boolean' ? { takes_beside: r.takes_beside, heavy_slowed: r.heavy_slowed } : undefined;
  } catch {
    /* the caller's marker: not the take's business */
    return undefined;
  }
}

/**
 * The environment block of the timeline (L1.7): name, production, the run's access, the display table, the clock.
 * The read-only guard adds `writes` while the run goes.
 */
function timelineEnvironment(env: ResolvedEnvironment, access: RunAccess, runClock: ResolvedClock | undefined): TimelineEnvironment {
  const display = displayTable(env);
  return {
    name: env.name,
    ...(access.production ? { production: true as const } : {}),
    access: access.mode,
    ...(access.allow_writes ? { allow_writes: true as const } : {}),
    ...(display.length ? { display } : {}),
    ...(runClock ? { clock: runClock } : {}),
  };
}

/** Why a read-only run refuses to start: its hooks that write, and the ways out. */
function readOnlyRunRefusal(writing: ReturnType<typeof writingHooks>, access: RunAccess): string {
  const list = writing.map((w) => `${w.phase} hook ${w.index + 1}${w.name ? ` "${w.name}"` : ''} (${w.reason})`);
  const env = `environment ${access.env} is ${access.production ? 'production, ' : ''}read-only${access.configured === 'read-write' ? ' without --allow-writes' : ''}`;
  const out = access.configured === 'read-write' ? 'pass --allow-writes to write to production' : 'run it on a read-write environment';
  return (
    `${env} and ${writing.length === 1 ? 'a hook writes' : `${writing.length} hooks write`}: ${list.join(', ')} — nothing ran. ` +
    `Run with --hooks skip (no hooks), or ${out}; \`optional: true\` does not skip a refusal`
  );
}

/**
 * Resolve the secret references of the scenes this run reaches (skipped scenes and the steps after --until excluded)
 * and of the mailbox headers when the run reads mail. A missing one fails the run naming where it is used.
 */
async function prefetchSecrets(
  secrets: RunSecrets,
  sc: Scenario,
  until: { sceneIndex: number; stepIndex: number } | null,
  mailbox: MailboxConfig | null,
): Promise<void> {
  const last = until ? until.sceneIndex : sc.scenes.length - 1;
  for (let si = 0; si <= last; si++) {
    const entry = sc.scenes[si];
    if (isCaptureScene(entry) && entry.skip) continue;
    try {
      await secrets.prefetch(untilSteps(entry, si, until));
    } catch (e) {
      throw new RunnerError(`scene ${sceneId(entry, si)}: ${errorMessage(e)}`);
    }
  }
  try {
    await secrets.prefetch(mailbox?.headers);
  } catch (e) {
    throw new RunnerError(`mailbox headers: ${errorMessage(e)}`);
  }
}

/** Run a scenario with `driverOf`'s driver (runScenario: the browser's). */
export async function runCapture(opts: RunOptions, driverOf: (run: CaptureRun) => CaptureDriver): Promise<RunRecord> {
  const { project, scenario: loaded, mode } = opts;
  const sc = loaded.scenario;
  const env = resolveEnvironment(project, opts.env ?? sc.env);
  // L1.7: the run's access (a read-only run refuses writing hooks) and the product's clock, settled before anything
  // is recorded — a refused --allow-writes or an unusable clock fails here, like --until.
  const access = resolveRunAccess(env, { allowWrites: opts.allowWrites === true, project });
  const runClock = resolveClock(sc.clock, project.config.clock, { timezone: projectBrowser(project, opts.browser).timezone });
  if (opts.inspect && mode !== 'dry') throw new RunnerError('an inspection replays the scenario as a dry run (mode: dry)');
  const pacing = mergePacing(project.config.pacing, sc.pacing, opts.inspect ? INSPECT_PACING : undefined);
  const capture = mergeCapture(project.config.capture, sc.capture);
  const hooksMode = opts.inspect ? 'skip' : (opts.hooks ?? (mode === 'capture' ? 'run' : 'skip'));
  const hookRunner = opts.hookRunner;
  if (hooksMode === 'run' && !hookRunner && ((sc.setup?.length ?? 0) + (sc.teardown?.length ?? 0) > 0 || hookStepNames(sc).length > 0)) throw new RunnerError(NO_HOOK_RUNNER);
  let until: { sceneIndex: number; stepIndex: number } | null = null;
  if (opts.until !== undefined) {
    until = resolveStepRef(sc, opts.until);
    if (!until) {
      throw new RunnerError(
        `--until "${opts.until}" matches no step (use <scene>.<step id|index>, a unique step id, or a scene id)`,
      );
    }
  }
  const runsDir = resolve(opts.runsDir ?? projectPath(project.dir, 'runs'));
  // Two runs of one scenario started in the same second (concurrent runs, L1.6) never share a folder: the later one
  // takes the next free second (core reserveRunId). A pre-assigned id (a job's, reserved at submit) reuses its folder.
  // A pre-assigned id names a folder of runs/: one that is no run id is refused before any folder is made.
  const given = opts.runId !== undefined ? parseRunId(opts.runId) : undefined;
  if (given === null) throw new RunnerError(`run id ${JSON.stringify(String(opts.runId).slice(0, 60))} is not a run id (a folder name of runs/: letters, digits, ".", "_" and "-", never a path)`);
  const { id: runId, dir } = given !== undefined ? { id: given, dir: join(runsDir, given) } : await reserveRunId(runsDir, loaded.name);
  const screenshotsDir = join(dir, 'screenshots');
  const framesDir = join(dir, 'frames');
  await mkdir(screenshotsDir, { recursive: true });
  await writeFile(join(dir, 'scenario.yaml'), loaded.text);

  const listed = listSteps(sc);
  // The steps this run executes (all, or up to --until).
  const toRun = until
    ? listed.filter((s) => s.sceneIndex < until!.sceneIndex || (s.sceneIndex === until!.sceneIndex && s.step.index <= until!.stepIndex))
    : listed;
  const total = toRun.length;
  // L1.8: the sandbox of a sandbox environment, with the reset made before the take when there was one (--sandbox).
  const sandbox: RunSandbox | undefined = env.sandbox ? (opts.sandbox?.name === env.name ? { ...opts.sandbox } : { name: env.name, provider: env.sandbox.provider }) : undefined;
  // The run's record while it is in flight; its end makes another one (finishRun), which is what the last save writes.
  const record: RunningRun = startedRun({
    version: FORMAT_VERSIONS.run,
    id: runId,
    project: project.slug,
    scenario: loaded.name,
    mode,
    started_at: new Date().toISOString(),
    dir,
    env: env.name,
    options: { hooks: hooksMode, headed: opts.headed ?? false },
    steps_total: total,
    steps_done: 0,
    screenshots: [],
    hooks: { setup: 'none', teardown: 'none' },
    warnings: [],
    environment: {
      ...(access.production ? { production: true as const } : {}),
      access: access.mode,
      ...(runClock ? { clock: { at: runClock.at, ...(runClock.timezone ? { timezone: runClock.timezone } : {}), ...(runClock.freeze ? { freeze: true as const } : {}) } } : {}),
      ...(sandbox ? { sandbox } : {}),
    },
    engine: runEngine(),
  });
  if (opts.until !== undefined) record.options.until = opts.until;
  if (access.allow_writes) record.options.allow_writes = true;
  if (opts.hideCursor) record.options.cursor = 'hidden';
  // Secret values ({{env:…}}, {{keychain:…}}) are masked wherever the run writes: run.json, log.jsonl, the progress
  // events, timeline.json, error snippets and the returned record (R-RUN-17).
  const secrets = new RunSecrets(opts.resolveSecret);
  const files = new RunFiles(dir, record, (r) => secrets.redactRecord(r));
  const emit = (e: RunProgress) => {
    const safe = secrets.redactProgress(e);
    files.progress(safe);
    try {
      opts.onProgress?.(safe);
    } catch {
      /* a listener error must not break the run */
    }
  };
  const log = (level: LogLevel, message: string) => emit({ type: 'log', level, message });
  emit({ type: 'run_start', run: { ...record } });
  await files.saveRecord();
  if (access.notice) log('warn', access.notice);
  if (access.warning) log('warn', access.warning);

  const abort = new AbortController();
  const signal = opts.signal ? AbortSignal.any([opts.signal, abort.signal]) : abort.signal;
  /** The process groups of the shell hooks running now (a second signal kills them). */
  const hookGroups = new Set<number>();
  const clock = new CaptureClock();
  const video = timelineVideo(sc, project.config, opts.template?.name);
  const timeline = new TimelineBuilder(
    { run_id: runId, project: project.slug, scenario: loaded.name, mode, capture, video, ...(opts.hideCursor ? { cursor: 'hidden' as const } : {}) },
    clock,
  );
  timeline.environment = timelineEnvironment(env, access, runClock);
  if (sandbox) timeline.environment.sandbox = { ...sandbox };
  const template: TemplateContext = {
    pages: env.pages,
    vars: { ...(project.config.vars ?? {}), ...(sc.vars ?? {}) },
    run: { id: runId, dir },
    hooks: {},
    secrets: secrets.resolver,
  };
  // The environment's mailbox (L1.8: a sandbox's own, else the project's).
  const mailbox = mailboxFor(project, env.name);
  const readsMail = mailbox !== undefined && toRun.some((l) => l.step.action === 'wait_for_email');
  /** Captures first (L5.14): onFilming said `start` and not yet `stop`. */
  let filming = false;
  const onFilming = mode === 'capture' ? opts.onFilming : undefined;
  const run: CaptureRun = {
    opts,
    project,
    loaded,
    sc,
    mode,
    env,
    access,
    runClock,
    pacing,
    capture,
    hooksMode,
    until,
    total,
    runId,
    dir,
    screenshotsDir,
    framesDir,
    record,
    secrets,
    files,
    emit,
    log,
    abort,
    signal,
    clock,
    timeline,
    template,
    mailbox,
    readsMail,
    captureStarted: false,
    failure: null,
    endT: 0,
    startCapture: () => {
      clock.t0Wall = wallNow();
      (run as { captureStarted: boolean }).captureStarted = true;
      if (onFilming) {
        filming = true;
        tell(onFilming, 'start');
      }
    },
    stopFilming: () => {
      if (!filming) return undefined;
      filming = false;
      return tell(onFilming!, 'stop');
    },
    filmingPause: onFilming ? (on: boolean) => void tell(onFilming, on ? 'resume' : 'pause') : undefined,
  };
  const driver = driverOf(run);
  const removeSignals = installSignalHandlers((sig) => abort.abort(new CancelledError(`run cancelled (${sig})`)), hookGroups, () => driver.cleanupSync());
  let hooks: HooksState | null = null;

  try {
    throwIfAborted(signal);
    // Work submitted through MCP or from the Studio (L3.1, core agent-trust): the scenario names no secret, its files
    // stay in the project (code never from a file an agent can write) and the URLs it opens are on the environment's
    // origins — refused before anything runs.
    if (opts.hookTrust === 'mcp') {
      const problems = agentTrustProblems(project, sc, { via: opts.hookVia ?? AGENT_CONFINEMENT, env, files: nodeFileFacts });
      if (problems.length) throw new RunnerError(`refused (work submitted ${confinementWords(opts.hookVia)}): ${problems.join('; ')}`);
    }
    // A read-only run (L1.7) refuses hooks that write before anything runs: no browser, no session copy, no hook.
    if (access.mode === 'read-only' && hooksMode === 'run') {
      const writing = writingHooks({ setup: sc.setup, teardown: sc.teardown, step: stepHookList(sc, project) }, { projectDir: project.dir, files: nodeFileFacts, ...(opts.hookTrust ? { trust: opts.hookTrust } : {}), ...(opts.hookVia ? { via: opts.hookVia } : {}) });
      if (writing.length) throw new RunnerError(readOnlyRunRefusal(writing, access));
    }
    await driver.prepare();
    // Every secret the run uses, before the product opens and the setup hooks run: a keychain prompt never stalls the
    // capture, and a missing one fails the run up front.
    await prefetchSecrets(secrets, sc, until, readsMail ? (mailbox ?? null) : null);
    driver.identify();
    // The steps this run executes (L4.4: the Studio's step list), described as step_start will describe them — once
    // every secret is known (the prefetched ones, the sandbox accounts' passwords), so a value written as is in a step
    // is masked here too (review A).
    emit({ type: 'outline', steps: toRun.map((l) => ({ scene: sceneId(l.scene, l.sceneIndex), step: l.step.index, action: l.step.action, desc: describeStep(secrets.redactDeep(l.step)), ...(l.scene.offscreen === true ? { offscreen: true as const } : {}) })) });
    await driver.open();

    // `hook:` steps (L5.8) run named hooks during the take, in the same context as the setup's (journal, saved results).
    const hookSteps = hookStepNames(sc).length > 0;
    if (hookSteps) record.hooks.steps = hooksMode === 'skip' ? 'skipped' : 'ok';
    const hasHooks = (sc.setup?.length ?? 0) + (sc.teardown?.length ?? 0) > 0 || hookSteps;
    if (hasHooks && hooksMode === 'skip') {
      if (sc.setup?.length) record.hooks.setup = 'skipped';
      if (sc.teardown?.length) record.hooks.teardown = 'skipped';
      if (hookSteps) driver.setHookSteps(async (name) => {
        log('info', `hook step "${name}" not run: the run's hooks are skipped`);
        return { hook: name, skipped: true };
      });
    } else if (hasHooks) {
      const deps: SetupDeps = {
        policy: opts.policy,
        project,
        env,
        access,
        template,
        runId,
        dir,
        emit,
        log,
        record,
        ...driver.hooks(),
        signal,
        running: hookGroups,
        ...(opts.hookTrust ? { trust: opts.hookTrust } : {}),
        ...(opts.hookVia ? { via: opts.hookVia } : {}),
        ...(opts.hookTrust === 'mcp' && sc.vars && Object.keys(sc.vars).length ? { agentVars: Object.keys(sc.vars) } : {}),
        ...(opts.confirmHook ? { confirmHook: opts.confirmHook } : {}),
        ...(opts.recordHookRun ? { recordHookRun: opts.recordHookRun } : {}),
      };
      hooks = await openHooks(hookRunner!, deps);
      await setupHooks(hooks, sc.setup ?? [], deps);
      if (hookSteps) driver.setHookSteps(stepHookRunner(hooks, sc, deps));
    }
    // The video's title, intro, outro and tutorial switches are templated once the setup hooks saved their results.
    const meta = timeline.meta;
    // All of it is text the video shows: `{{page}}` reads the page's display URL (L1.7).
    if (meta.video) meta.video = templated(() => templateVideo(meta.video!, { ...template, pages: displayPages(env) }), record);

    await driver.film();
  } catch (e) {
    run.failure = await driver.failed(e);
  } finally {
    // Off camera from here: the driver stops filming (teardown, diagnosis and artefacts are not filmed).
    await driver.stop();
    if (hooks) {
      try {
        record.hooks.teardown = await teardownHooks(hooks, sc.teardown ?? [], emit, log);
      } catch (e) {
        record.hooks.teardown = 'failed';
        log('error', `teardown failed: ${errorMessage(e)}`);
      }
    }
    await driver.close();
    removeSignals();
  }

  const take = await driver.finish();
  const tl = timeline.build({ ...take.capture, duration: run.endT });
  const timelineFile = join(dir, 'timeline.json');
  if (!take.discard) {
    try {
      await writeJson(timelineFile, secrets.redactTimeline(tl));
      record.timeline = timelineFile;
    } catch (e) {
      run.failure ??= e;
    }
  }

  const failure = run.failure;
  const warnings = [...timeline.warnings];
  const at = new Date().toISOString();
  let end: RunEnd;
  if (failure === null) {
    end = { status: 'succeeded', at, warnings };
  } else {
    const err: RunError = { message: errorMessage(failure) };
    if (failure instanceof StepFailure) {
      err.scene = failure.scene;
      err.step = failure.step;
      err.action = failure.action;
      if (failure.screenshot) err.screenshot = failure.screenshot;
      if (failure.dom) err.dom = failure.dom;
      if (failure.missing) err.missing_targets = failure.missing;
    }
    end = { status: isCancelled(failure) ? 'cancelled' : 'failed', at, warnings, error: err };
  }
  // The only change of status: the record of the run that ended (the step it was at is dropped).
  const done = finishRun(record, end);
  files.finish(done);
  emit({ type: 'run_end', run: { ...done } });
  await files.close().catch(() => undefined);
  return secrets.redactRecord(done);
}
