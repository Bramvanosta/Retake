import { copyFile, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Page } from 'playwright-core';
import {
  ARTEFACTS_DIR,
  agentTrustProblems,
  FORMAT_VERSIONS,
  compileWritePolicy,
  guardsWrites,
  displayPages,
  displayTable,
  isCaptureScene,
  listSteps,
  loginCommand as defaultLoginCommand,
  loginMatchers,
  mailboxFor,
  networkHost,
  scenePageEntries,
  planPersonas,
  reserveRunId,
  resolveClock,
  resolveEnvironment,
  resolvePersonas,
  resolveRunAccess,
  resolveStepRef,
  sceneId,
  templateVideo,
  timelineVideo,
  writeJson,
  writingHooks,
} from '@demo-studio/core';
import type {
  BrowserConfig,
  HookStep,
  HookTrust,
  LoadedProject,
  LoadedScenario,
  LoadedTemplate,
  MailboxConfig,
  RunError,
  RunMode,
  RunProgress,
  RunSandbox,
  PersonaPlan,
  ResolvedPersona,
  ResolvedClock,
  RunAccess,
  RunRecord,
  Scenario,
  TemplateContext,
  TimelineEnvironment,
  TimelineWrite,
  WritePolicy,
} from '@demo-studio/core';
import { snapshotMailbox } from './actions/artefacts.js';
import { watchNotifications } from './notifications.js';
import { mergeCapture, mergePacing, projectBrowser } from './config.js';
import { encodeFrames } from './encode.js';
import { runEngine } from './engine.js';
import { CancelledError, EncodeError, LoginPageError, PreflightError, RunnerError, errorMessage, isCancelled } from './errors.js';
import { LoginGuard, checkPersona, preflight, prepareSessions, removeSessionCopiesSync, signInMatchers, writeStatus } from './auth.js';
import type { PreparedSession } from './auth.js';
import { evalHookInPage } from './hook-page.js';
import { hookResultFailed, hookResultName, loadHooksModule } from './hooks-bridge.js';
import type { ConfirmHook, HookContextLike, HooksModule, JournalLike } from './hooks-bridge.js';
import { HOLD_MAX_MS } from './hold.js';
import { INSPECT_PACING, inspectPage } from './inspect.js';
import type { InspectContext, InspectRequest } from './inspect.js';
import { kitConfigFor } from './kit/source.js';
import { ScreencastRecorder } from './recorder.js';
import type { FrameIndexEntry } from './recorder.js';
import { RunFiles } from './runfiles.js';
import { Runtime } from './runtime.js';
import type { LogLevel } from './runtime.js';
import { StepFailure, runScenes, templated, untilSteps } from './scenes.js';
import { RunSecrets } from './secrets.js';
import { BrowserSession } from './session.js';
import { CaptureClock, TimelineBuilder, motionCapture } from './timeline.js';
import type { MotionCapture } from './timeline.js';
import { throwIfAborted, wallNow } from './util.js';
import type { GuardedWrite, WriteGuardOptions } from './write-guard.js';

export interface RunOptions {
  project: LoadedProject;
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
  /** ffmpeg binary (default "ffmpeg" on PATH). */
  ffmpeg?: string;
  /**
   * Capture without the in-page cursor (raw export for editors, L2.13: `studio run --raw --cursor none|layer`). The
   * pointer still drives real input and the cursor track, icon, presses and ripples are recorded; nothing of the
   * cursor is drawn in the pictures. The timeline says so (`capture.cursor: hidden`).
   */
  hideCursor?: boolean;
  /** Resolves `{{env:…}}` / `{{keychain:…}}` references (default core resolveSecretRef; tests inject one). */
  resolveSecret?: (ref: string) => Promise<string>;
  /** The command that signs a persona in again, as messages print it (default `studio login <project> --env … --persona …`). */
  loginCommand?: (p: { project: string; env: string; persona?: string }) => string;
  /**
   * `--allow-writes` (L1.7): lets a run on a production environment whose project.yaml sets `access: read-write` write.
   * On a read-only environment it is refused (core AccessError, thrown before anything is recorded).
   */
  allowWrites?: boolean;
  /**
   * The sandbox reset made before this take (L1.8, `studio run --sandbox`: @demo-studio/sandbox prepareTake), recorded as
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
}

/**
 * SIGINT/SIGTERM abort the run (teardown still runs); a second signal kills the process — after removing the session
 * copies it made (they hold a persona's cookies; L1.6) and killing the shell hooks still running (`groups`: their
 * process groups, which a signal to this process alone would leave running).
 */
function installSignalHandlers(onSignal: (sig: NodeJS.Signals) => void, groups: ReadonlySet<number>): () => void {
  let count = 0;
  const handler = (sig: NodeJS.Signals) => {
    count++;
    if (count === 1) {
      onSignal(sig);
      return;
    }
    remove();
    removeSessionCopiesSync();
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

interface HooksState {
  mod: HooksModule;
  journal: JournalLike;
  ctx: HookContextLike;
}


/**
 * A hold the recorder ended at its time limit (R-ISS-08): a page load that painted nothing within HOLD_MAX_MS, or a
 * fresh tab left blank that long — from then on the page is filmed as it is. Names the page and the capture time,
 * never the URL.
 */
function warnLimitedLoads(rec: ScreencastRecorder, timeline: TimelineBuilder, log: (level: LogLevel, message: string) => void): void {
  const limit = HOLD_MAX_MS / 1000;
  for (const l of rec.limitedLoads()) {
    const message =
      l.kind === 'blank'
        ? `page ${l.page ?? '?'}: a new page stayed blank from ${l.t.toFixed(1)} s for ${limit} s (nothing opened in it) — it is filmed blank from then on: give it \`open\``
        : `page ${l.page ?? '?'}: a page load at ${l.t.toFixed(1)} s painted nothing within ${limit} s — its blank or loading frames are in the capture from then on`;
    timeline.warn(message);
    log('warn', message);
  }
}

/**
 * Run warnings about the motion a capture shows: moves below `minFps` (slow rendering) and stalls — the capture froze
 * ≥ STALL_MIN_S (150 ms) while the cursor moved or a click ripple played (L1.3). Null (cursor hidden): nothing can be
 * judged.
 */
export function motionWarnings(motion: MotionCapture | null, minFps: number, prefix: string): string[] {
  if (!motion) return [];
  const out: string[] = [];
  if (motion.slow > 0 && motion.worst) {
    out.push(
      `${prefix}${motion.slow} of ${motion.moves} cursor moves were captured below ${Math.round(minFps)} fps ` +
        `(lowest ${motion.worst.fps.toFixed(0)} fps at ${motion.worst.t.toFixed(1)} s): the browser renders this page slowly ` +
        `(software rendering without a GPU, heavy effects such as backdrop-filter blur, or several pages at once), so motion will look choppy`,
    );
  }
  if (motion.stalls.length) {
    const worst = motion.stalls.reduce((a, b) => (b.ms > a.ms ? b : a));
    const where = motion.stalls.slice(0, 4).map((s) => `${s.t.toFixed(1)} s (${s.ms} ms, ${s.during === 'move' ? 'cursor moving' : 'click ripple'})`);
    out.push(
      `${prefix}the capture froze ${motion.stalls.length === 1 ? 'once' : `${motion.stalls.length} times`} while the cursor moved or a click ripple played ` +
        `(longest ${worst.ms} ms): ${where.join(', ')}${motion.stalls.length > 4 ? ', …' : ''} — the frames show a stop, then a jump` +
        (motion.stalls.some((s) => s.during === 'ripple')
          ? '; a freeze during a click ripple is usually a closing dialog whose overlay has a backdrop-filter (Chromium stops drawing ≈ 0.26 s): browser.frame_rate_limit: false avoids it, see the README'
          : ''),
    );
  }
  return out;
}

/**
 * Run a scenario in a headless browser: setup hooks, scenes (page switching, open, still, steps), screencast
 * capture, teardown hooks (always), encoding, timeline.json and run.json. Never throws for step failures:
 * the returned RunRecord carries the status and error.
 */
export async function runScenario(opts: RunOptions): Promise<RunRecord> {
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
  let until: { sceneIndex: number; stepIndex: number } | null = null;
  if (opts.until !== undefined) {
    until = resolveStepRef(sc, opts.until);
    if (!until) {
      throw new RunnerError(
        `--until "${opts.until}" matches no step (use <scene>.<step id|index>, a unique step id, or a scene id)`,
      );
    }
  }
  const runsDir = resolve(opts.runsDir ?? join(project.dir, 'runs'));
  // Two runs of one scenario started in the same second (concurrent runs, L1.6) never share a folder: the later one
  // takes the next free second (core reserveRunId). A pre-assigned id (a job's, reserved at submit) reuses its folder.
  const { id: runId, dir } = opts.runId !== undefined ? { id: opts.runId, dir: join(runsDir, opts.runId) } : await reserveRunId(runsDir, loaded.name);
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
  const record: RunRecord = {
    version: FORMAT_VERSIONS.run,
    id: runId,
    project: project.slug,
    scenario: loaded.name,
    mode,
    status: 'running',
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
  };
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
  const removeSignals = installSignalHandlers((sig) => abort.abort(new CancelledError(`run cancelled (${sig})`)), hookGroups);
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

  let session: BrowserSession | null = null;
  let prepared: PreparedSession[] = [];
  let personas: ResolvedPersona[] = [];
  /** The `studio login` command of a persona (the legacy one has no --persona). */
  const commandOf = (persona: string): string =>
    (opts.loginCommand ?? defaultLoginCommand)({ project: project.slug, env: env.name, persona: personas.find((p) => p.name === persona)?.legacy ? undefined : persona });
  /** Personas whose session expired during the run: their status says so at the end (`studio auth status`). */
  const expiredDuring = new Map<string, { at: string; detail: string }>();
  const expire = (persona: string, at: string, detail: string): void => {
    if (!expiredDuring.has(persona)) expiredDuring.set(persona, { at, detail });
  };
  let guard: LoginGuard | null = null;
  let planned: PersonaPlan | null = null;
  let rt: Runtime | null = null;
  let notifications: { settled: () => Promise<void> } | null = null;
  let recorder: ScreencastRecorder | null = null;
  let hooks: HooksState | null = null;
  let failure: unknown = null;
  let frames: FrameIndexEntry[] = [];
  let endT = 0;
  /** Capture time 0 is set (writes and the like are stamped from then on). */
  let captureStarted = false;
  let writeGuard: WriteGuardOptions | null = null;
  const inspectContext = (at: InspectContext['at'], failed: StepFailure | null): InspectContext => ({
    at,
    persona: (rt?.activeId ? planned?.pages.get(rt.activeId) : null) ?? null,
    replay: {
      steps_done: record.steps_done,
      steps_total: total,
      until: opts.until ?? null,
      skipped_irreversible: rt ? rt.timeline.events.filter((e) => e.status === 'dry').length : 0,
      hooks: record.hooks.setup === 'skipped' || record.hooks.teardown === 'skipped' ? 'skipped' : 'none',
      failed: failed ? { scene: failed.scene, step: failed.step, action: failed.action } : null,
    },
    ...(failed ? { error: secrets.redactText(failed.message) } : {}),
  });

  try {
    throwIfAborted(signal);
    // Work submitted through MCP (L3.1, core agent-trust): the scenario names no secret, and its files stay in the
    // project (code never from a file an agent can write) — refused before anything runs.
    if (opts.hookTrust === 'mcp') {
      const problems = agentTrustProblems(project, sc);
      if (problems.length) throw new RunnerError(`refused (work submitted through MCP): ${problems.join('; ')}`);
    }
    // A read-only run (L1.7) refuses hooks that write before anything runs: no browser, no session copy, no hook.
    if (access.mode === 'read-only' && hooksMode === 'run') {
      const writing = writingHooks({ setup: sc.setup, teardown: sc.teardown }, { projectDir: project.dir, ...(opts.hookTrust ? { trust: opts.hookTrust } : {}) });
      if (writing.length) throw new RunnerError(readOnlyRunRefusal(writing, access));
    }
    // A read-only run stops the browser's writes (L1.7, write-guard.ts): armed in every browser at launch. Any run
    // stops writes to the hosts of the project's other read-only environments (none: a read-write run arms nothing).
    const policy = compileWritePolicy(env, { scenarioMocks: sc.mocks, access });
    if (guardsWrites(policy)) {
      writeGuard = readOnlyGuard(policy, {
        timeline,
        log,
        captureStarted: () => captureStarted,
        where: () => {
          const cur = rt?.current;
          const at = `${clock.now().toFixed(1)} s`;
          return cur ? `${cur.step >= 0 ? `step ${cur.scene}.${cur.step}` : `scene ${cur.scene}`}, ${at}` : at;
        },
        pageId: (p) => session?.idOf(p),
      });
    }
    if (!policy.readOnly && sc.mocks?.length) {
      log('warn', `the scenario's mocks apply to read-only runs only: environment ${env.name} runs read-write, its writes really happen`);
    }
    // Every secret the run uses, before the browser opens and the setup hooks run: a keychain prompt never stalls the
    // capture, and a missing one fails the run up front.
    await prefetchSecrets(secrets, sc, until, readsMail ? (mailbox ?? null) : null);
    // Sessions & personas (L1.6): which persona films each page, each one's browser on a copy of its session, checked
    // off camera before anything runs — no setup hook, no recorder yet.
    personas = resolvePersonas(project, env.name);
    const plan = planPersonas(sc, { env: env.name, envPages: env.pages, personas, until, hooks: hooksMode === 'run' });
    if (plan.issues.length) throw new RunnerError(plan.issues.map((i) => `${formatIssuePath(i.path)}: ${i.message}`).join('\n'));
    planned = plan;
    prepared = await prepareSessions(personas.filter((p) => plan.used.includes(p.name)), { runId, log });
    const realmOf = personaOf(plan, personas, env, () => rt);
    session = await BrowserSession.open({
      width: capture.width,
      height: capture.height,
      scale: capture.scale,
      kit: kitConfigFor(opts.template, opts.hideCursor ? { hidden: true } : undefined),
      browser: projectBrowser(project, opts.browser),
      headed: opts.headed,
      log,
      ...(writeGuard ? { writes: writeGuard } : {}),
      ...(prepared.length
        ? {
            realms: [...prepared.map((p) => p.realm), ...(plan.needsDefault ? [{ name: '' }] : [])],
            realmOf: (id: string) => realmOf(id) ?? '',
            hookRealmOf: (key: string) => (plan.hookPages.has(key) ? (plan.hookPages.get(key) ?? '') : (personaOfKey(personas, key) ?? '')),
          }
        : {}),
    });
    const chromium = await session.browserVersion();
    if (chromium) {
      record.engine = runEngine(chromium);
      void files.saveRecord();
    }
    if (prepared.length) {
      await preflight(session, prepared, {
        project: project.slug,
        env: env.name,
        envPages: env.pages,
        runId,
        secrets,
        template,
        kitSource: session.source,
        log,
        signal,
        // The automated sign-in tab is exempt from the write guard on its sign-in page (its POST /sign-in must happen).
        signInTab: (p, onSignInPage) => session?.markSignIn(p, onSignInPage),
        ...(opts.loginCommand ? { loginCommand: opts.loginCommand } : {}),
      });
    }
    // The product's clock (L1.7, R-ENV-05): after the preflight (a sign-in under a far clock may fail its token checks),
    // before the setup hooks; set back to its time at capture time 0 (anchorClock).
    if (runClock) {
      await session.installClock(runClock);
      log('info', `clock: the product's browser reads ${runClock.at}${runClock.timezone ? ` (${runClock.timezone})` : ''} at capture time 0${runClock.freeze ? ' and never moves (freeze)' : ', then runs'}`);
    }
    guard = signInGuard(project, env, personas, plan, () => session, {
      command: commandOf,
      hooksJustRan: () => record.steps_done === 0 && record.hooks.setup === 'ok',
      redact: (t) => secrets.redactText(t),
      abort: (e) => abort.abort(e),
    });
    rt = new Runtime({
      session,
      timeline,
      pacing,
      capture,
      mode,
      signal,
      project,
      env,
      runDir: dir,
      screenshotsDir,
      template,
      secrets,
      recorder: null,
      cursorHidden: opts.hideCursor === true,
      ...(opts.hookTrust === 'mcp' ? { agentTrust: true } : {}),
      ...(opts.inspect ? { inspecting: true } : {}),
      log,
      guard,
      ...(prepared.length ? { plannedPersonas: plan.pages } : {}),
    });

    if (opts.hideCursor) log('info', 'capturing without the in-page cursor (raw export): its track, icon, presses and ripples are recorded as data');
    notifications = watchNotifications(rt);
    // wait_for_email takes only the messages that arrive during the run: remember those already there (before setup).
    if (readsMail) await snapshotMailbox(rt);

    const hasHooks = (sc.setup?.length ?? 0) + (sc.teardown?.length ?? 0) > 0;
    if (hasHooks && hooksMode === 'skip') {
      if (sc.setup?.length) record.hooks.setup = 'skipped';
      if (sc.teardown?.length) record.hooks.teardown = 'skipped';
    } else if (hasHooks) {
      const deps: SetupDeps = {
        rt,
        session,
        project,
        env,
        access,
        template,
        runId,
        dir,
        emit,
        log,
        record,
        hookLanding: hookLanding(guard, personas, env, session, commandOf, expire),
        ...(writeGuard ? { writes: { policy: writeGuard.policy, ...(writeGuard.onWrite ? { onWrite: writeGuard.onWrite } : {}) } } : {}),
        signal,
        running: hookGroups,
        ...(opts.hookTrust ? { trust: opts.hookTrust } : {}),
        ...(opts.confirmHook ? { confirmHook: opts.confirmHook } : {}),
      };
      hooks = await openHooks(deps);
      await setupHooks(hooks, sc.setup ?? [], deps);
    }
    // The video's title, intro, outro and tutorial switches are templated once the setup hooks saved their results.
    const meta = timeline.meta;
    // All of it is text the video shows: `{{page}}` reads the page's display URL (L1.7).
    if (meta.video) meta.video = templated(() => templateVideo(meta.video!, { ...template, pages: displayPages(env) }), record);

    const captured = sc.scenes.filter(isCaptureScene).filter((s) => !s.skip);
    const firstScene = captured[0];
    const firstPage = firstScene?.pages !== undefined ? undefined : (firstScene?.page ?? Object.keys(env.pages)[0]);
    if (firstScene?.pages === undefined && !firstPage) throw new RunnerError(`environment "${env.name}" declares no pages`);
    // Capture time 0: right before the first page is shown and the screencast starts. The product's clock reads its
    // time now (L1.7), in every browser.
    await session.anchorClock();
    clock.t0Wall = wallNow();
    captureStarted = true;
    // A scenario whose first scene films several pages starts with their tracks (the main capture starts with the
    // first single-page scene, if any).
    if (firstPage) await rt.activate(firstPage);
    if (mode === 'capture' && captured.some((s) => s.pages === undefined)) {
      recorder = new ScreencastRecorder({
        framesDir,
        indexFile: join(dir, 'frames.jsonl'),
        format: capture.format,
        quality: capture.quality,
        width: capture.width,
        height: capture.height,
        scale: capture.scale,
        clock,
        onError: (m) => timeline.warn(m),
        pageId: (p) => session?.idOf(p),
      });
      if (firstPage) await recorder.start(rt.page);
      else await recorder.prepare();
      rt.recorder = recorder;
    }
    await runScenes(rt, {
      scenario: sc,
      scenarioName: loaded.name,
      until,
      record,
      emit,
      save: () => void files.saveRecord(),
    });
    rt.assertSignedIn();
    if (opts.inspect) await inspectNow(opts.inspect, rt, inspectContext(until ? 'until' : 'end', null));
  } catch (e) {
    // A step that failed because its page landed on a sign-in page reports the landing (L1.6).
    failure = guard?.error ?? e;
    // The step that failed is where an author needs to see the page (never a sign-in landing: nothing of it is kept).
    if (opts.inspect && rt && failure === e && e instanceof StepFailure) {
      try {
        await inspectNow(opts.inspect, rt, inspectContext('failed_step', e));
      } catch (err) {
        if (guard?.error) failure = guard.error;
        else log('warn', `inspection at the failed step: ${errorMessage(err)}`);
      }
    }
  } finally {
    endT = clock.now();
    if (failure === null && guard?.error) failure = guard.error;
    if (rt) {
      for (const [id, t] of rt.tracks) {
        if (!t.recorder) continue;
        try {
          t.builder.frames = (await t.recorder.stop()).length;
          t.builder.loading = t.recorder.loadingIntervals();
          warnLimitedLoads(t.recorder, timeline, log);
        } catch (e) {
          log('error', `stopping the recorder of page ${id} failed: ${errorMessage(e)}`);
        }
      }
    }
    if (recorder) {
      try {
        frames = await recorder.stop();
        timeline.loading = recorder.loadingIntervals();
        warnLimitedLoads(recorder, timeline, log);
        const st = recorder.stats();
        if (st.write_errors) timeline.warn(`${st.write_errors} frames could not be written`);
        const minFps = Math.min(capture.fps, 30) * 0.6;
        // Without the drawn cursor a move changes nothing on screen: the frame rate during moves cannot be judged.
        const motion = opts.hideCursor
          ? null
          : motionCapture(frames.map((f) => f.t), timeline.cursor, minFps, timeline.cursorEffects, timeline.pages.map((p) => p.t_start), timeline.loading);
        for (const message of motionWarnings(motion, minFps, '')) {
          timeline.warn(message);
          log('warn', message);
        }
      } catch (e) {
        log('error', `stopping the recorder failed: ${errorMessage(e)}`);
      }
    }
    // A landing seen while the run was ending (after a step failed, or a cancel): nothing of the capture is kept either.
    if (guard?.error) failure = guard.error;
    // A step failure on a persona's page: was it the session? One check, off camera, now that nothing is filmed (L1.6).
    if (failure instanceof StepFailure && session && prepared.length) failure = await diagnoseSession(failure, session, rt, prepared, env.pages, secrets, commandOf, signal, expire);
    if (hooks) {
      try {
        record.hooks.teardown = await teardownHooks(hooks, sc.teardown ?? [], emit, log);
      } catch (e) {
        record.hooks.teardown = 'failed';
        log('error', `teardown failed: ${errorMessage(e)}`);
      }
    }
    await notifications?.settled().catch(() => undefined);
    await session?.close().catch((e: unknown) => log('warn', `closing the browser failed: ${errorMessage(e)}`));
    // Artefact images (emails, PDF pages, icons, project documents) are rendered after the capture, in a clean browser.
    if (rt && !(failure !== null && (isCancelled(failure) || failure instanceof LoginPageError))) {
      try {
        await rt.artefacts.finalize({ browser: projectBrowser(project, opts.browser), scenario: sc, project });
      } catch (e) {
        timeline.warn(`artefacts: ${errorMessage(e)}`);
      }
    }
    if (rt) timeline.artefacts = rt.artefacts.items;
    removeSignals();
  }

  // The session of a persona whose page landed on its own sign-in page expired during the run (L1.6).
  const landing = guard?.landing;
  if (landing?.persona && failure instanceof LoginPageError && !foreignSignIn(landing.url, landing.persona, env.pages, personas, planned)) {
    expire(landing.persona, landing.url, `page ${landing.pageId} landed on the sign-in page during run ${runId}`);
  }
  for (const [name, x] of expiredDuring) {
    const persona = prepared.find((p) => p.persona.name === name)?.persona;
    if (!persona) continue;
    await writeStatus(persona.statusFile, { status: 'expired', by: 'run', run: runId, ...(x.at ? { at: x.at } : {}), detail: secrets.redactText(x.detail) }).catch((e: unknown) =>
      log('warn', `persona ${name}: its status could not be saved: ${errorMessage(e)}`),
    );
  }
  const cancelled = failure !== null && isCancelled(failure);
  // Nothing of a run that landed on a sign-in page is kept (L1.6): no frames, no video, no screenshot, no timeline (so
  // `render latest` never picks it); a preflight failure recorded nothing either.
  const discard = failure instanceof LoginPageError || failure instanceof PreflightError;
  if (discard) {
    frames = [];
    await discardCapture(dir, screenshotsDir);
    record.screenshots = [];
  }
  // Per-page tracks of multi-page scenes (L2.11): their frames, encoded on the same CFR grid as capture.mp4.
  const trackFrames = new Map<string, FrameIndexEntry[]>();
  if (rt && mode === 'capture' && !discard) {
    for (const [id, t] of rt.tracks) {
      if (!t.recorder) continue;
      const list = [...t.recorder.frames].sort((a, b) => a.t - b.t);
      trackFrames.set(id, list);
      t.builder.frames = list.length;
      const st = t.recorder.stats();
      if (st.write_errors) timeline.warn(`page ${id}: ${st.write_errors} frames could not be written`);
      const minFps = Math.min(capture.fps, 30) * 0.6;
      const motion = opts.hideCursor
        ? null
        : motionCapture(list.map((f) => f.t), t.builder.cursor, minFps, t.builder.cursorEffects, t.builder.pages.map((p) => p.t_start), t.builder.loading);
      for (const message of motionWarnings(motion, minFps, `page ${id}: `)) {
        timeline.warn(message);
        log('warn', message);
      }
    }
  }
  const allTrackFrames = [...trackFrames.values()].flat();
  // A scenario made only of multi-page scenes has no main capture of its own: capture.mp4 is its first page's track.
  const mainFromTrack = mode === 'capture' && frames.length === 0 && allTrackFrames.length > 0 ? [...trackFrames.keys()].find((k) => trackFrames.get(k)!.length > 0) : undefined;
  if (mode === 'capture' && !cancelled && !discard && failure === null && frames.length === 0 && !mainFromTrack) {
    // A capture without a single frame is a failed capture, never a "succeeded" run without capture.mp4.
    const why = timeline.warnings.find((w) => w.startsWith('screencast frames stay'));
    failure = new EncodeError(`the capture recorded no frame${why ? ` (${why}: every frame was dropped)` : ''}`);
  }
  if (mode === 'capture' && !cancelled && !discard && frames.length > 0) {
    const out = join(dir, 'capture.mp4');
    emit({ type: 'encode', status: 'start', message: `${frames.length} frames → ${out}` });
    try {
      await encodeFrames(framesDir, frames, out, {
        fps: capture.fps,
        crf: capture.crf,
        endT,
        width: capture.width * capture.scale,
        height: capture.height * capture.scale,
        jpeg: capture.format === 'jpeg',
        ffmpeg: opts.ffmpeg,
      });
      record.capture = out;
      emit({ type: 'encode', status: 'done', message: out });
      if (!capture.keep_frames) await rm(framesDir, { recursive: true, force: true });
    } catch (e) {
      emit({ type: 'encode', status: 'done', message: `failed: ${errorMessage(e)}` });
      failure ??= e;
    }
  }
  if (rt && mode === 'capture' && !cancelled && !discard) {
    for (const [id, t] of rt.tracks) {
      const list = trackFrames.get(id) ?? [];
      if (list.length === 0) {
        timeline.warn(`page ${id}: its track recorded no frame`);
        continue;
      }
      const tframes = join(dir, t.builder.info.frames_file.replace(/\.jsonl$/, ''));
      const out = join(dir, t.builder.info.file);
      emit({ type: 'encode', status: 'start', message: `page ${id}: ${list.length} frames → ${out}` });
      try {
        await encodeFrames(tframes, list, out, {
          fps: capture.fps,
          crf: capture.crf,
          endT,
          width: t.viewport.width * capture.scale,
          height: t.viewport.height * capture.scale,
          jpeg: capture.format === 'jpeg',
          ffmpeg: opts.ffmpeg,
        });
        emit({ type: 'encode', status: 'done', message: out });
        if (!capture.keep_frames) await rm(tframes, { recursive: true, force: true });
        if (mainFromTrack === id) {
          await copyFile(out, join(dir, 'capture.mp4'));
          record.capture = join(dir, 'capture.mp4');
          frames = list;
          log('info', `every scene films several pages: capture.mp4 is the track of page "${id}"`);
        }
      } catch (e) {
        emit({ type: 'encode', status: 'done', message: `failed: ${errorMessage(e)}` });
        failure ??= e;
      }
    }
  }

  const tl = timeline.build({
    file: record.capture ? 'capture.mp4' : '',
    duration: endT,
    frames: frames.length,
    frameTimes: frames.map((f) => f.t),
    ...(allTrackFrames.length ? { idleFrameTimes: [...(mainFromTrack ? [] : frames), ...allTrackFrames].map((f) => f.t) } : {}),
    // capture.mp4 copied from a page's track has that page's size.
    ...(mainFromTrack && rt?.tracks.get(mainFromTrack) ? { size: { width: rt.tracks.get(mainFromTrack)!.viewport.width, height: rt.tracks.get(mainFromTrack)!.viewport.height } } : {}),
  });
  const timelineFile = join(dir, 'timeline.json');
  if (!discard) {
    try {
      await writeJson(timelineFile, secrets.redactTimeline(tl));
      record.timeline = timelineFile;
    } catch (e) {
      failure ??= e;
    }
  }

  record.warnings = [...timeline.warnings];
  record.finished_at = new Date().toISOString();
  delete record.current;
  if (failure === null) {
    record.status = 'succeeded';
  } else {
    record.status = isCancelled(failure) ? 'cancelled' : 'failed';
    const err: RunError = { message: errorMessage(failure) };
    if (failure instanceof StepFailure) {
      err.scene = failure.scene;
      err.step = failure.step;
      err.action = failure.action;
      if (failure.screenshot) err.screenshot = failure.screenshot;
      if (failure.dom) err.dom = failure.dom;
    }
    record.error = err;
  }
  emit({ type: 'run_end', run: { ...record } });
  await files.close().catch(() => undefined);
  return secrets.redactRecord(record);
}

/** Inspect the page the run shows and hand the report over (inspect.ts). */
async function inspectNow(req: InspectRequest, rt: Runtime, ctx: InspectContext): Promise<void> {
  const { onResult, ...request } = req;
  const report = await inspectPage(rt, request, ctx);
  await onResult(report);
}

/**
 * The environment block of the timeline (L1.7): name, production, the run's access, the display table, the clock.
 * The read-only guard adds `writes` while the run goes.
 */
function timelineEnvironment(env: ReturnType<typeof resolveEnvironment>, access: RunAccess, runClock: ResolvedClock | undefined): TimelineEnvironment {
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

/**
 * The write guard of a run (L1.7): each write it sees goes to `timeline.environment.writes` (capture time from capture
 * time 0 on); a stopped write warns once per request (`POST shop:/api/x`), a write to a host it does not watch once per
 * host, a WebSocket to a guarded host once per host; mocked / allowed writes and the sign-in's exempt ones are logged.
 * A read-write run's guard only stops writes to the hosts of the project's read-only environments.
 */
function readOnlyGuard(
  policy: WritePolicy,
  o: {
    timeline: TimelineBuilder;
    log: (level: LogLevel, message: string) => void;
    captureStarted: () => boolean;
    /** Where the run is (capture time, scene / step): for messages from capture time 0 on. */
    where: () => string;
    pageId: (page: Page) => string | undefined;
  },
): WriteGuardOptions {
  const writes: TimelineWrite[] = [];
  if (o.timeline.environment) o.timeline.environment.writes = writes;
  const warned = new Set<string>();
  const warnOnce = (key: string, message: string) => {
    if (warned.has(key)) return;
    warned.add(key);
    o.timeline.warn(message);
    o.log('warn', message);
  };
  const rules = [
    ...(policy.mocks.length ? [`${policy.mocks.length} mock${policy.mocks.length === 1 ? '' : 's'}`] : []),
    ...(policy.allow.length ? [`${policy.allow.length} allow entr${policy.allow.length === 1 ? 'y' : 'ies'}`] : []),
  ];
  const foreign = [...new Set(policy.protected.map((p) => p.env))].map((e) => `${e} (${policy.protected.filter((p) => p.env === e).map((p) => p.host).join(', ')})`);
  if (policy.readOnly) {
    o.log('info', `read-only run: writes to ${policy.hosts.includes('*') ? 'every host' : policy.hosts.join(', ')} are stopped${rules.length ? ` (${rules.join(', ')})` : ''}`);
  }
  if (foreign.length) o.log('info', `writes to the hosts of read-only environment${foreign.length > 1 ? 's' : ''} ${foreign.join(', ')} are stopped`);
  return {
    policy,
    onWrite: (w) => {
      const started = o.captureStarted();
      writes.push({
        ...(started ? { t: o.timeline.clock.now() } : {}),
        method: w.method,
        url: w.url,
        ...(w.operation ? { operation: w.operation } : {}),
        outcome: w.outcome,
        ...(w.rule ? { rule: w.rule } : {}),
        ...(w.status !== undefined ? { status: w.status } : {}),
        via: w.via,
        ...(w.protectedBy ? { protected_by: w.protectedBy } : {}),
      });
      const where = started ? o.where() : w.via === 'sign-in' ? 'the automated sign-in, before the capture started' : 'before the capture started';
      // A js hook tab says what it stopped itself (the hook is refused, or warned about).
      if (w.via === 'hook') return;
      if (w.outcome === 'exempt') {
        o.log('debug', `the automated sign-in sent ${w.label} (${where}) from its sign-in page: exempt from the write guard`);
        return;
      }
      if (w.outcome === 'blocked') {
        warnOnce(
          `blocked ${w.label}`,
          w.protectedBy
            ? `a write was stopped (${w.label}, ${where}): ${networkHost(w.url) ?? '?'} is a host of read-only environment ${w.protectedBy}, and this run is on environment ${policy.env} — the app may show an error`
            : `a write was stopped (${w.label}, ${where}): environment ${policy.env} is read-only — the app may show an error; answer it with a mock (\`mocks:\` of the scenario)`,
        );
      } else if (w.outcome === 'passed') {
        const host = networkHost(w.url) ?? '?';
        warnOnce(
          `passed ${host}`,
          `a write went to ${host} (${w.label}, ${where}), a host the read-only guard does not watch: it was sent — list ${host} in read_only.hosts of environment ${policy.env} if it writes your data`,
        );
      } else if (w.outcome === 'mocked') {
        o.log('info', `${w.label} (${where}): answered by the mock "${w.rule}" (HTTP ${w.status})`);
      } else {
        o.log('info', `${w.label} (${where}): let through by read_only.allow "${w.rule}"`);
      }
    },
    onWebSocket: (host, page) => {
      const id = o.pageId(page);
      warnOnce(
        `ws ${host}`,
        `${id ? `page ${id}: ` : ''}a WebSocket to ${host} is open — the read-only guard does not check its messages: writes sent over it are NOT stopped`,
      );
    },
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

interface SetupDeps {
  /** A read-only run: the js hook tabs stop writes (never mocked) and report them. */
  writes?: { policy: WritePolicy; onWrite?: (w: GuardedWrite) => void };
  rt: Runtime;
  session: BrowserSession;
  project: LoadedProject;
  env: { name: string; pages: Record<string, string> };
  /** The run's access: a read-only run refuses hooks that write (each one again, on its templated content). */
  access: RunAccess;
  template: TemplateContext;
  runId: string;
  dir: string;
  emit: (e: RunProgress) => void;
  log: (level: LogLevel, message: string) => void;
  record: RunRecord;
  /** Refuses a js hook tab that landed on its persona's sign-in page (L1.6). */
  hookLanding?: (key: string, url: string) => string | null;
  /** The run's cancel (Ctrl-C, SIGTERM, opts.signal): it stops the setup — a running shell command's process group too. */
  signal: AbortSignal;
  /** The process groups of the shell hooks running now (any phase): a second signal kills them before the process quits. */
  running: Set<number>;
  trust?: HookTrust;
  confirmHook?: ConfirmHook;
}

function formatIssuePath(path: ReadonlyArray<string | number>): string {
  return path.reduce<string>((s, seg) => (typeof seg === 'number' ? `${s}[${seg}]` : s ? `${s}.${seg}` : seg), '');
}

/** The persona whose `pages` list an environment page (else the legacy one), or null. */
function personaOfKey(personas: readonly ResolvedPersona[], key: string | undefined): string | null {
  if (key !== undefined) {
    const p = personas.find((x) => !x.legacy && x.pages.includes(key));
    if (p) return p.name;
  }
  return personas.find((x) => x.legacy)?.name ?? null;
}

/**
 * The persona a capture page id is created in: the static plan's, else (a page the plan did not foresee) its
 * environment page's persona, else none. Tabs are created in the realm of the page that opens them (session.newPage).
 */
function personaOf(plan: PersonaPlan, personas: readonly ResolvedPersona[], env: { pages: Record<string, string> }, rt: () => Runtime | null): (id: string) => string | null {
  return (id) => {
    if (plan.pages.has(id)) return plan.pages.get(id) ?? null;
    const key = Object.hasOwn(env.pages, id) ? id : rt()?.declaredPages.get(id)?.page;
    return personaOfKey(personas, key);
  };
}

/** The persona an environment page is filmed as: the plan's binding of that page, else its default. */
function ownerOfKey(key: string, personas: readonly ResolvedPersona[], plan: PersonaPlan | null): string | null {
  return plan?.pages.has(key) ? (plan.pages.get(key) ?? null) : personaOfKey(personas, key);
}

/**
 * The environment page whose sign-in page a page of `persona` reached when that is another persona's app (a tab or a
 * link that left this persona's pages): its key and the persona it is filmed as. Null when the URL is on one of this
 * persona's pages (its own sign-in page: its session expired) or on no environment page.
 */
function foreignSignIn(
  url: string,
  persona: string,
  envPages: Record<string, string>,
  personas: readonly ResolvedPersona[],
  plan: PersonaPlan | null,
): { key: string; owner: string | null } | null {
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    return null;
  }
  const keys = Object.keys(envPages).filter((k) => {
    try {
      return new URL(envPages[k]).origin === origin;
    } catch {
      return false;
    }
  });
  if (keys.length === 0 || keys.some((k) => ownerOfKey(k, personas, plan) === persona)) return null;
  return { key: keys[0], owner: ownerOfKey(keys[0], personas, plan) };
}

/**
 * The sign-in guard of a run (L1.6): a page filmed as a persona is guarded with that persona's sign-in patterns; a page
 * without one with the environment's (auth.login_url) unless written `persona: none` — or opened (new_tab) from such a
 * page. Null when there is nothing to watch.
 */
function signInGuard(
  project: LoadedProject,
  env: { name: string; pages: Record<string, string> },
  personas: readonly ResolvedPersona[],
  plan: PersonaPlan,
  session: () => BrowserSession | null,
  o: { command: (persona: string) => string; hooksJustRan: () => boolean; redact: (t: string) => string; abort: (e: LoginPageError) => void },
): LoginGuard | null {
  const byPersona = new Map(personas.map((p) => [p.name, signInMatchers(project, env, p)]));
  const envMatchers = signInMatchers(project, env, null);
  if (envMatchers.length === 0 && [...byPersona.values()].every((m) => m.length === 0)) return null;
  // Pages seen as `persona: none` (a tab keeps it after its opener closed).
  const none = new WeakSet<Page>();
  const isNone = (id: string | undefined, page: Page, depth = 0): boolean => {
    if (none.has(page)) return true;
    const s = session();
    const opener = s?.openerOf(page);
    if ((id !== undefined && plan.none.has(id)) || (opener !== undefined && depth < 32 && s?.realmName(opener) === '' && isNone(s.idOf(opener), opener, depth + 1))) {
      none.add(page);
      return true;
    }
    return false;
  };
  return new LoginGuard({
    targetOf: (id, page) => {
      const realm = session()?.realmName(page);
      if (realm) return { persona: realm, matchers: byPersona.get(realm) ?? envMatchers };
      if (isNone(id, page)) return null;
      return { persona: null, matchers: envMatchers };
    },
    describe: ({ pageId, page, persona, url, what }) => {
      const s = session();
      const opener = s?.openerOf(page);
      const from = opener ? s?.idOf(opener) : undefined;
      const who = `${what ? `${what} on ` : ''}page "${pageId}"${persona ? ` (persona ${persona}${from ? `, opened from page "${from}"` : ''})` : from ? ` (opened from page "${from}")` : ''}`;
      const foreign = persona ? foreignSignIn(url, persona, env.pages, personas, plan) : null;
      return o.redact(
        `${who} landed on the sign-in page (${url}) — ` +
          (foreign
            ? `that is page "${foreign.key}", filmed ${foreign.owner ? `as persona ${foreign.owner}` : 'without a persona'}: a ${from ? 'tab keeps the persona of the page it is opened from' : 'page keeps one persona for the whole run'} — film "${foreign.key}" on its own page (\`page: ${foreign.key}\`, or \`switch_page: ${foreign.key}\`); nothing of the capture was kept`
            : persona
              ? `the session expired during the run${o.hooksJustRan() ? ' (a setup hook ran just before: it may have reset the sessions)' : ''}; nothing of the capture was kept. Sign in again: ${o.command(persona)}`
              : `this page has no persona: bind it to one (auth.personas.<name>.pages, or \`persona:\` on the scene); nothing of the capture was kept`),
      );
    },
    onLanding: (e) => o.abort(e),
  });
}

/** A js hook tab's landing check: its persona's sign-in patterns (the guard's), or null when not guarded. */
function hookLanding(
  guard: LoginGuard | null,
  personas: readonly ResolvedPersona[],
  env: { name: string; pages: Record<string, string> },
  session: BrowserSession,
  command: (persona: string) => string,
  expire: (persona: string, at: string, detail: string) => void,
): ((key: string, url: string) => string | null) | undefined {
  if (!guard) return undefined;
  return (key, url) => {
    const tab = session.hookPages.get(key);
    const persona = tab ? session.realmName(tab) : undefined;
    const p = personas.find((x) => x.name === persona);
    if (!p) return null;
    const m = loginMatchers(p.loginPatterns, env.pages).find((x) => x.test(url));
    if (!m) return null;
    const at = url.split(/[?#]/)[0];
    expire(p.name, at, `js hook page ${key} landed on the sign-in page`);
    return `js hook page "${key}" (persona ${p.name}) landed on the sign-in page (${at}): its session expired — sign in again: ${command(p.name)}`;
  };
}

/**
 * After a step failure on a persona's page, check that persona once (off camera, in its own browser; a cancel stops
 * it): when its session is no longer valid, the failure says so and how to fix it.
 */
async function diagnoseSession(
  failure: StepFailure,
  session: BrowserSession,
  rt: Runtime | null,
  prepared: readonly PreparedSession[],
  envPages: Record<string, string>,
  secrets: RunSecrets,
  command: (persona: string) => string,
  signal: AbortSignal,
  expire: (persona: string, at: string, detail: string) => void,
): Promise<StepFailure> {
  const id = rt?.activeId;
  const page = id ? session.pages.get(id) : undefined;
  const realm = page && !page.isClosed() ? session.realmName(page) : undefined;
  const p = prepared.find((x) => x.persona.name === realm);
  if (!p?.persona.check) return failure;
  const r = await checkPersona(await session.contextOf(p.persona.name), p.persona, { envPages, kitSource: session.source, signal }).catch(() => null);
  if (!r || r.status !== 'expired') return failure;
  expire(p.persona.name, r.at ?? '', `${r.detail} (checked after step ${failure.scene}.${failure.step} failed)`);
  const message = `${failure.message} — the session of persona ${p.persona.name} is no longer valid (${secrets.redactText(r.detail)}): sign in again: ${command(p.persona.name)}`;
  return new StepFailure(message, failure.scene, failure.step, failure.action, failure.screenshot, failure.dom);
}

/** Remove what a run filmed: frames (main and per page), their indexes, the screenshots and the artefacts. */
async function discardCapture(dir: string, screenshotsDir: string): Promise<void> {
  let names: string[] = [];
  try {
    names = await readdir(dir);
  } catch {
    /* nothing there */
  }
  for (const n of names) {
    if (n === 'frames' || n === 'frames.jsonl' || n === ARTEFACTS_DIR || /^frames-.+/.test(n) || /^capture(-.+)?\.mp4$/.test(n)) {
      await rm(join(dir, n), { recursive: true, force: true }).catch(() => undefined);
    }
  }
  await rm(screenshotsDir, { recursive: true, force: true }).catch(() => undefined);
  await mkdir(screenshotsDir, { recursive: true }).catch(() => undefined);
}

/**
 * The hooks of a run: the journal and the context the setup, the teardown and the rollbacks share. Opened before the
 * setup runs, so the teardown runs even when the setup failed or was interrupted.
 */
async function openHooks(d: SetupDeps): Promise<HooksState> {
  const mod = await loadHooksModule();
  const journal = await mod.Journal.open(join(d.dir, 'hooks-journal.json'));
  const saved: Record<string, unknown> = {};
  d.template.hooks = saved;
  const ctx: HookContextLike = {
    project: d.project,
    env: d.env,
    vars: Object.fromEntries(Object.entries(d.template.vars ?? {}).map(([k, v]) => [k, String(v)])),
    runId: d.runId,
    runDir: d.dir,
    // Hooks only get here when they are enabled; in a dry run that takes an explicit `hooks: 'run'`, so they
    // really execute: the dry run then sees the same prepared data as a capture.
    dryRun: false,
    log: (level, msg) => d.log(level, msg),
    access: d.access,
    // js hooks run in a guarded tab of their own, kept for the run (hook-page.ts), never in a capture tab.
    evalInPage: (pageKey, code) =>
      evalHookInPage(
        d.session,
        { project: d.project, env: d.env, log: d.log, ...(d.hookLanding ? { loginLanding: d.hookLanding } : {}), ...(d.writes ? { writes: d.writes } : {}) },
        pageKey,
        code,
      ),
    saved,
    // Every phase's shell commands (setup, teardown, rollbacks): a second signal kills them before the process quits.
    running: d.running,
    ...(d.trust ? { trust: d.trust } : {}),
    ...(d.confirmHook ? { confirmDestructive: d.confirmHook } : {}),
  };
  return { mod, journal, ctx };
}

/**
 * The setup hooks. A cancel stops them — a running shell command's process group gets SIGTERM (an http, sql or js
 * hook ends first), the remaining hooks do not run, the completed ones are rolled back (never interrupted themselves)
 * before the teardown — and cancels the run.
 */
async function setupHooks(h: HooksState, setup: HookStep[], d: SetupDeps): Promise<void> {
  if (!setup.length) {
    d.record.hooks.setup = 'none';
    return;
  }
  d.emit({ type: 'hook', phase: 'setup', name: 'setup', status: 'start', message: `${setup.length} hook(s)` });
  // Only the setup sees the run's cancel. The same context object as the teardown's and the rollbacks': the secrets
  // the hooks resolve are looked up once per run and stay registered for redaction.
  h.ctx.signal = d.signal;
  let res: Awaited<ReturnType<HooksModule['runHooks']>>;
  try {
    res = await h.mod.runHooks(setup, h.ctx, { phase: 'setup', journal: h.journal });
  } finally {
    delete h.ctx.signal;
  }
  res.results.forEach((r, i) =>
    d.emit({ type: 'hook', phase: 'setup', name: hookResultName(r, i), status: hookResultFailed(r) ? 'failed' : 'ok', message: r.error ?? r.message }),
  );
  d.record.hooks.setup = res.ok ? 'ok' : 'failed';
  if (!res.ok) {
    throwIfAborted(d.signal);
    // An optional hook may have failed before the one that stopped the setup: report the blocking one.
    const failed = res.results.find((r) => hookResultFailed(r) && r.optional !== true) ?? res.results.find(hookResultFailed);
    throw new RunnerError(`setup hooks failed${failed ? ` (${hookResultName(failed, res.results.indexOf(failed))}: ${failed.error ?? failed.message ?? 'error'})` : ''}; completed setup hooks were rolled back`);
  }
}

/**
 * Teardown hooks always run, then the setup hooks still pending in the journal are rolled back (most recent first),
 * like `finally` blocks unwinding: teardown cleans what the scenario did, rollbacks undo what setup did.
 */
async function teardownHooks(
  h: HooksState,
  teardown: HookStep[],
  emit: (e: RunProgress) => void,
  log: (level: LogLevel, message: string) => void,
): Promise<RunRecord['hooks']['teardown']> {
  let ok = true;
  let ran = false;
  if (teardown.length) {
    ran = true;
    emit({ type: 'hook', phase: 'teardown', name: 'teardown', status: 'start', message: `${teardown.length} hook(s)` });
    const res = await h.mod.runHooks(teardown, h.ctx, { phase: 'teardown', journal: h.journal });
    res.results.forEach((r, i) =>
      emit({ type: 'hook', phase: 'teardown', name: hookResultName(r, i), status: hookResultFailed(r) ? 'failed' : 'ok', message: r.error ?? r.message }),
    );
    ok = res.ok;
  }
  const pending = h.journal.pending().length;
  if (pending) {
    ran = true;
    log('info', `rolling back ${pending} setup hook(s)`);
    emit({ type: 'hook', phase: 'rollback', name: 'rollback', status: 'start', message: `${pending} setup hook(s)` });
    const results = await h.journal.rollbackAll(h.ctx);
    results.forEach((r, i) =>
      emit({ type: 'hook', phase: 'rollback', name: hookResultName(r, i), status: hookResultFailed(r) ? 'failed' : 'ok', message: r.error ?? r.message }),
    );
    if (results.some(hookResultFailed)) ok = false;
  }
  if (!ran) return 'none';
  return ok ? 'ok' : 'failed';
}
