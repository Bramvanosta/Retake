import { copyFile, mkdir, readdir, rm, stat, statfs, writeFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import type { Page } from 'playwright-core';
import {
  ARTEFACTS_DIR,
  agentTrustProblems,
  channelWords,
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
  templateSceneEntry,
  templateVideo,
  timelineVideo,
  writeJson,
  writingHooks,
  hookStepNames,
  resolveNamedHook,
  stepHookList,
} from '@demo-studio/core';
import type {
  AgentChannel,
  TimelineEvent,
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
  RunPerf,
  RunPerfCpu,
  RunRecord,
  Scenario,
  TemplateContext,
  TimelineEnvironment,
  TimelineWrite,
  WritePolicy,
} from '@demo-studio/core';
import { snapshotMailbox } from './actions/artefacts.js';
import { ActivityRecorder, analyzeActivity, clicksOf, slowTransitions } from './activity.js';
import { watchNotifications } from './notifications.js';
import { mergeCapture, mergePacing, projectBrowser } from './config.js';
import { runFfmpeg } from './encode.js';
import { runEngine } from './engine.js';
import { CancelledError, EncodeError, LoginPageError, PreflightError, RunnerError, StepError, errorMessage, isCancelled } from './errors.js';
import { LoginGuard, checkPersona, preflight, prepareSessions, removeSessionCopiesSync, signInMatchers, writeStatus } from './auth.js';
import type { PreparedSession } from './auth.js';
import { evalHookInPage } from './hook-page.js';
import { hookResultFailed, hookResultName, loadHooksModule } from './hooks-bridge.js';
import type { ConfirmHook, HookContextLike, HooksModule, JournalLike } from './hooks-bridge.js';
import { HOLD_MAX_MS } from './hold.js';
import { INSPECT_PACING, inspectPage } from './inspect.js';
import type { InspectContext, InspectRequest } from './inspect.js';
import { kitConfigFor } from './kit/source.js';
import { LivePreview } from './live-preview.js';
import type { LiveSink } from './live-preview.js';
import { RunPauser } from './pause.js';
import type { PauseGate } from './pause.js';
import { ScreencastRecorder } from './recorder.js';
import type { FrameIndexEntry } from './recorder.js';
import { probePages, preflightRefusal } from './page-preflight.js';
import { PerfSampler, UNFILMED_WARN_CORES, listeningPids, localPorts } from './perf.js';
import { prewarmPages, prewarmTargets } from './prewarm.js';
import { RunFiles } from './runfiles.js';
import { Runtime } from './runtime.js';
import type { HookStepOutcome } from './runtime.js';
import type { LogLevel } from './runtime.js';
import { StepFailure, describeStep, runScenes, templated, untilSteps } from './scenes.js';
import { settleEffectChecks } from './actions/effects.js';
import { RunSecrets } from './secrets.js';
import { BrowserSession } from './session.js';
import type { GpuInfo } from './session.js';
import { StreamEncoder, encoderLabel, resolveEncoder } from './stream.js';
import type { StreamEncoderOptions } from './stream.js';
import { CaptureClock, TimelineBuilder, motionCapture } from './timeline.js';
import type { MotionCapture } from './timeline.js';
import { fileSlug, pad, throwIfAborted, wallNow } from './util.js';
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
export function motionWarnings(motion: MotionCapture | null, minFps: number, prefix: string, cause?: string): string[] {
  if (!motion) return [];
  const out: string[] = [];
  if (motion.slow > 0 && motion.worst) {
    out.push(
      `${prefix}${motion.slow} of ${motion.moves} cursor moves were captured below ${Math.round(minFps)} fps ` +
        `(lowest ${motion.worst.fps.toFixed(0)} fps at ${motion.worst.t.toFixed(1)} s), so motion will look choppy` +
        (cause ? ` — ${cause}` : ''),
    );
  }
  if (motion.stalls.length) {
    const worst = motion.stalls.reduce((a, b) => (b.ms > a.ms ? b : a));
    const where = motion.stalls.slice(0, 4).map((s) => `${s.t.toFixed(1)} s (${s.ms} ms, ${s.during === 'move' ? 'cursor moving' : 'click ripple'})`);
    out.push(
      `${prefix}the capture froze ${motion.stalls.length === 1 ? 'once' : `${motion.stalls.length} times`} while the cursor moved or a click ripple played ` +
        `(longest ${worst.ms} ms): ${where.join(', ')}${motion.stalls.length > 4 ? ', …' : ''} — the frames show a stop, then a jump` +
        (motion.stalls.some((s) => s.during === 'ripple')
          ? '; a freeze during a click ripple is usually a closing dialog whose overlay has a backdrop-filter (Chromium stops drawing ≈ 0.26 s): the edit cuts the frozen part'
          : ''),
    );
  }
  return out;
}

/**
 * Why cursor moves were filmed below the frame rate (L5.7, R-FLD-24), from what the take measured: the GPU, the
 * machine's load, Chromium's CPU, the frame-rate limiter, several browsers. The most likely cause first, then the
 * figures it rests on.
 */
export function choppyCause(m: { gpu?: GpuInfo; cpu?: RunPerfCpu; machine: RunPerf['machine']; seconds: number; frameRateLimit: boolean }): string {
  const figures: string[] = [];
  if (m.gpu) figures.push(m.gpu.accelerated ? `GPU hardware accelerated${m.gpu.renderer ? ` (${m.gpu.renderer})` : ''}` : `no GPU acceleration (${m.gpu.renderer ?? 'software'})`);
  figures.push(`machine load up to ${m.machine.load_max.toFixed(1)} on ${m.machine.cpus} cores`);
  const cores = (x: number) => (x / Math.max(0.001, m.seconds)).toFixed(2);
  if (m.cpu) figures.push(`Chromium ${cores(m.cpu.browser + m.cpu.gpu + m.cpu.renderer + m.cpu.chromium_other)} cores (renderer ${cores(m.cpu.renderer)}, GPU process ${cores(m.cpu.gpu)})`);
  let why: string;
  if (m.gpu && !m.gpu.accelerated) why = 'the browser renders in software: run `studio doctor` (browser.channel: headless-shell has no GPU)';
  else if (m.machine.load_max > m.machine.cpus) why = 'the machine was busy with other work: film when it is quiet';
  else if (m.cpu && m.cpu.renderer / Math.max(0.001, m.seconds) > 0.8) why = "the page's own rendering is heavy (large blurs or shadows, animations): its renderer stayed busy";
  else if (m.cpu?.browsers && m.cpu.browsers.length > 1 && m.cpu.browsers.some((b) => b.cpu / Math.max(0.001, m.seconds) > 0.5)) why = 'several browsers (one per persona) rendered at once';
  else if (!m.frameRateLimit) why = 'browser.frame_rate_limit: false makes Chromium draw back to back';
  else why = 'no load measured: the page itself drew slowly at those moments';
  return `measured: ${why} (${figures.join(', ')})`;
}

/** Size of a folder in MB (files only; never fails). */
async function folderMB(dir: string): Promise<number> {
  let bytes = 0;
  const walk = async (d: string): Promise<void> => {
    for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile()) bytes += (await stat(p).catch(() => null))?.size ?? 0;
    }
  };
  await walk(dir);
  return Math.round((bytes / 1e6) * 10) / 10;
}

/** Free space below which a capture warns (R-FLD-28): this many GB, or this share of the disk. */
export const DISK_FREE_MIN_GB = 10;
export const DISK_FREE_MIN_SHARE = 0.05;

/** Free GB on the disk of `dir` and the warning when it is low (undefined: not measurable). */
export async function diskCheck(dir: string, project: string): Promise<{ free_gb?: number; warning?: string }> {
  try {
    const f = await statfs(dir);
    const free = (f.bavail * f.bsize) / 1e9;
    const total = (f.blocks * f.bsize) / 1e9;
    const free_gb = Math.round(free * 10) / 10;
    if (free < DISK_FREE_MIN_GB || free < total * DISK_FREE_MIN_SHARE) {
      return { free_gb, warning: `only ${free_gb} GB left on this disk: \`studio prune ${project}\` removes failed takes, dry runs and old renders (it says how much first)` };
    }
    return { free_gb };
  } catch {
    return {};
  }
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
  /** The live picture (L4.4): on camera only, from capture time 0 to the start of `finally`. */
  let live: LivePreview | null = null;
  /** What watching the live picture cost (perf.live_preview). */
  let livePreview: { seconds: number; frames_sent: number } | null = null;
  let hooks: HooksState | null = null;
  let failure: unknown = null;
  let frames: FrameIndexEntry[] = [];
  let endT = 0;
  // L5.7: capture.mp4 encoded during the take, what it showed after each click, what the take cost.
  let encoderKind: StreamEncoderOptions['encoder'] | null = null;
  let perfMotion: MotionCapture | null = null;
  let mainEncoder: StreamEncoder | null = null;
  const activity = new ActivityRecorder();
  let sampler: PerfSampler | null = null;
  let gpu: GpuInfo | undefined;
  let perfCpu: RunPerfCpu | undefined;
  let perfMachine: RunPerf['machine'] | undefined;
  const browserConfig = projectBrowser(project, opts.browser);
  const frameRateLimit = browserConfig.frame_rate_limit !== false;
  const newEncoder = (o: { out: string; width: number; height: number; horizon: () => number; thumbs?: boolean }): StreamEncoder =>
    new StreamEncoder({
      out: o.out,
      fps: capture.fps,
      width: o.width,
      height: o.height,
      format: capture.format,
      encoder: encoderKind ?? 'libx264',
      crf: capture.crf,
      ...(opts.ffmpeg ? { ffmpeg: opts.ffmpeg } : {}),
      horizon: o.horizon,
      ...(o.thumbs ? { onThumb: (n: number, g: Buffer) => activity.add(n, g) } : {}),
    });
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
      const problems = agentTrustProblems(project, sc, { via: opts.hookVia ?? 'mcp' });
      if (problems.length) throw new RunnerError(`refused (work submitted ${channelWords(opts.hookVia)}): ${problems.join('; ')}`);
    }
    // A read-only run (L1.7) refuses hooks that write before anything runs: no browser, no session copy, no hook.
    if (access.mode === 'read-only' && hooksMode === 'run') {
      const writing = writingHooks({ setup: sc.setup, teardown: sc.teardown, step: stepHookList(sc, project) }, { projectDir: project.dir, ...(opts.hookTrust ? { trust: opts.hookTrust } : {}), ...(opts.hookVia ? { via: opts.hookVia } : {}) });
      if (writing.length) throw new RunnerError(readOnlyRunRefusal(writing, access));
    }
    // L5.8 (R-FLD-33): every page of the environment answers before anything opens (a port that moved, a stopped server).
    const probes = await probePages(env.pages, { signal });
    const down = probes.filter((p) => !p.ok);
    if (down.length) {
      throw new RunnerError(preflightRefusal(env.name, down, env.sandbox ? { sandbox: `studio sandbox up ${project.slug} --env ${env.name}, or run with --sandbox` } : {}));
    }
    log('debug', `pages answer: ${probes.map((p) => `${p.keys.join('/')} HTTP ${p.status} (${p.ms} ms)`).join(', ')}`);
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
    // A sandbox account's plain password (L1.8) is a secret as written: registered now, before anything this run writes
    // can hold it (the outline below; autoLogin registers it again when its login runs).
    for (const p of personas) for (const v of p.secrets ?? []) secrets.addValue(v);
    // The steps this run executes (L4.4: the Studio's step list), described as step_start will describe them — once
    // every secret is known (the prefetched ones, the sandbox accounts' passwords), so a value written as is in a step
    // is masked here too (review A).
    emit({ type: 'outline', steps: toRun.map((l) => ({ scene: sceneId(l.scene, l.sceneIndex), step: l.step.index, action: l.step.action, desc: describeStep(secrets.redactDeep(l.step)), ...(l.scene.offscreen === true ? { offscreen: true as const } : {}) })) });
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
    if (mode === 'capture') {
      // L5.7: the encoder fed during the take, the GPU the capture renders with, a limiter turned off.
      encoderKind = await resolveEncoder(capture.encoder, opts.ffmpeg);
      gpu = await session.gpuInfo();
      if (gpu && !gpu.accelerated) {
        const m = `the capture browser renders without its GPU (${gpu.renderer ?? 'software'}${gpu.software?.length ? `; in software: ${gpu.software.join(', ')}` : ''}): motion may look choppy and the CPU climbs — see \`studio doctor\`${browserConfig.channel === 'headless-shell' ? ' (browser.channel: headless-shell has no GPU: remove it)' : ''}`;
        timeline.warn(m);
        log('warn', m);
      }
      if (!frameRateLimit) {
        const m =
          'browser.frame_rate_limit: false makes Chromium draw back to back (measured on the fixture: ×2.8 its CPU, its GPU and renderer processes ×7) — ' +
          'the dialog-close freeze it was set for is handled without it now (fresh frames during a click ripple, the edit cuts what is left): remove it';
        timeline.warn(m);
        log('warn', m);
      }
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
        onPersona: (persona, status, detail) => emit({ type: 'session', persona, status, ...(detail !== undefined ? { detail } : {}) }),
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
      // Step defaults (L5.6): the scenario's win over the project's.
      ...((sc.defaults?.timeout_s ?? project.config.defaults?.timeout_s) !== undefined ? { defaultTimeoutS: sc.defaults?.timeout_s ?? project.config.defaults?.timeout_s } : {}),
      log,
      guard,
      ...(prepared.length ? { plannedPersonas: plan.pages } : {}),
      ...(mode === 'capture' ? { encoderFor: (o: { out: string; width: number; height: number; horizon: () => number }) => newEncoder(o) } : {}),
    });

    if (opts.hideCursor) log('info', 'capturing without the in-page cursor (raw export): its track, icon, presses and ripples are recorded as data');
    notifications = watchNotifications(rt);
    // wait_for_email takes only the messages that arrive during the run: remember those already there (before setup).
    if (readsMail) await snapshotMailbox(rt);

    // `hook:` steps (L5.8) run named hooks during the take, in the same context as the setup's (journal, saved results).
    const hookSteps = hookStepNames(sc).length > 0;
    if (hookSteps) record.hooks.steps = hooksMode === 'skip' ? 'skipped' : 'ok';
    const hasHooks = (sc.setup?.length ?? 0) + (sc.teardown?.length ?? 0) > 0 || hookSteps;
    if (hasHooks && hooksMode === 'skip') {
      if (sc.setup?.length) record.hooks.setup = 'skipped';
      if (sc.teardown?.length) record.hooks.teardown = 'skipped';
      if (hookSteps) rt.runHook = async (name) => {
        log('info', `hook step "${name}" not run: the run's hooks are skipped`);
        return { hook: name, skipped: true };
      };
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
        ...(opts.hookVia ? { via: opts.hookVia } : {}),
        ...(opts.confirmHook ? { confirmHook: opts.confirmHook } : {}),
      };
      hooks = await openHooks(deps);
      await setupHooks(hooks, sc.setup ?? [], deps);
      if (hookSteps) rt.runHook = stepHookRunner(hooks, sc, deps);
    }
    // The video's title, intro, outro and tutorial switches are templated once the setup hooks saved their results.
    const meta = timeline.meta;
    // All of it is text the video shows: `{{page}}` reads the page's display URL (L1.7).
    if (meta.video) meta.video = templated(() => templateVideo(meta.video!, { ...template, pages: displayPages(env) }), record);

    const captured = sc.scenes.filter(isCaptureScene).filter((s) => !s.skip);
    const firstScene = captured[0];
    const firstPage = firstScene?.pages !== undefined ? undefined : (firstScene?.page ?? Object.keys(env.pages)[0]);
    if (firstScene?.pages === undefined && !firstPage) throw new RunnerError(`environment "${env.name}" declares no pages`);
    // L5.7 (R-FLD-27): every page the scenario opens, visited once off camera, so the take does not film it cold.
    if (mode === 'capture' && capture.prewarm) {
      const r = rt;
      const targets = prewarmTargets(sc, {
        envPages: env.pages,
        capture: { width: capture.width, height: capture.height },
        template: (entry, si) => {
          try {
            return templateSceneEntry(untilSteps(entry, si, until), si, r.template, r.editTemplate);
          } catch {
            return null;
          }
        },
        ...(until ? { lastScene: until.sceneIndex } : {}),
      });
      const done = await prewarmPages(r, targets);
      log('info', `prewarm: ${done.visited} of ${targets.length} page${targets.length === 1 ? '' : 's'} visited off camera in ${(done.ms / 1000).toFixed(1)} s`);
      for (const f of done.failed) log('warn', `prewarm: ${f}`);
    }
    // Capture time 0: right before the first page is shown and the screencast starts. The product's clock reads its
    // time now (L1.7), in every browser.
    await session.anchorClock();
    clock.t0Wall = wallNow();
    captureStarted = true;
    if (opts.live) {
      const r = rt;
      live = new LivePreview({ sink: opts.live, page: () => r.page, pageId: (p) => session?.idOf(p), width: capture.width, height: capture.height });
      live.start();
    }
    // A scenario whose first scene films several pages starts with their tracks (the main capture starts with the
    // first single-page scene, if any).
    if (firstPage) await rt.activate(firstPage);
    if (mode === 'capture' && captured.some((s) => s.pages === undefined)) {
      mainEncoder = newEncoder({
        out: join(dir, 'capture.mp4'),
        width: capture.width * capture.scale,
        height: capture.height * capture.scale,
        horizon: () => recorder?.horizon() ?? 0,
        thumbs: true,
      });
      mainEncoder.start();
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
        keepFrames: capture.keep_frames,
        sink: mainEncoder,
      });
      if (firstPage) await recorder.start(rt.page);
      else await recorder.prepare();
      rt.recorder = recorder;
    }
    if (mode === 'capture') {
      // What the take costs (R-FLD-23): Chromium's processes, the encoders, the product's local servers.
      const s = new PerfSampler({
        chromium: () => session?.processInfo() ?? Promise.resolve([]),
        // The personas' browsers a recorder films now (the main capture's page, the pages of a multi-page scene).
        filmed: () => {
          const pages = [recorder?.recordingPage, ...[...(rt?.tracks.values() ?? [])].map((t) => t.recorder?.recordingPage)];
          return new Set(pages.filter((p): p is Page => !!p).map((p) => session?.realmName(p) ?? ''));
        },
      });
      s.addEncoder(mainEncoder?.pid);
      s.addProduct(await listeningPids(localPorts(Object.values(env.pages))));
      s.start();
      sampler = s;
    }
    const pauseRt = rt;
    const pauser = opts.pause
      ? new RunPauser({
          gate: opts.pause,
          signal,
          record,
          emit,
          save: () => void files.saveRecord(),
          log,
          // A capture does not film the pause (L4.4): its recorders, clock and CPU sampler stop meanwhile (pause.ts).
          take: {
            clock,
            filming: () => {
              const out: Array<{ recorder: ScreencastRecorder; page: Page }> = [];
              for (const rec of [recorder, ...[...pauseRt.tracks.values()].map((t) => t.recorder)]) {
                const page = rec?.recordingPage;
                if (rec && page) out.push({ recorder: rec, page });
              }
              return out;
            },
            lastPress: () => {
              const ts = [timeline.cursorEffects, ...timeline.tracks.map((t) => t.cursorEffects)].flat().filter((e) => e.type === 'press' || e.type === 'ripple').map((e) => e.t);
              return ts.length ? Math.max(...ts) : null;
            },
            settleEffects: () => settleEffectChecks({ rt: pauseRt }),
            sampler: () => sampler,
            note: (p) => timeline.pauses.push(p),
          },
        })
      : null;
    await runScenes(rt, {
      scenario: sc,
      scenarioName: loaded.name,
      until,
      record,
      emit,
      save: () => void files.saveRecord(),
      ...(pauser ? { beforeStep: (scene: string, step: number) => pauser.before(scene, step) } : {}),
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
    // Off camera from here (L4.4): the live picture stops before anything else (teardown, diagnosis, artefacts).
    await live?.stop().catch(() => undefined);
    // A capture filmed while someone watched its live picture says so (review A L4): the screencast's JPEG encoding ran
    // in Chromium's browser process during the take.
    livePreview = live ? live.watched() : null;
    if (mode === 'capture' && livePreview && livePreview.seconds > 0) {
      const m = `the live picture was watched for ${livePreview.seconds.toFixed(1)} s of the take (${livePreview.frames_sent} frames sent): Chromium encoded it on top of the capture`;
      timeline.warn(m);
      log('info', m);
    }
    // The last click's effect check (R-FLD-12) ends before the capture does (--until, a failed step included).
    if (rt) await settleEffectChecks({ rt }).catch(() => undefined);
    endT = clock.now();
    if (mode === 'capture' && timeline.pauses.length) {
      const n = timeline.pauses.length;
      const s = timeline.pauses.reduce((x, p) => x + p.ms, 0) / 1000;
      const m = `paused ${n === 1 ? 'once' : `${n} times`} (${s.toFixed(1)} s, not filmed): the video goes on where it paused — what the page did meanwhile (timers, animations, the product's clock) shows as a jump there`;
      timeline.warn(m);
      log('info', m);
    }
    // The encoders write no tick past the end of the take.
    mainEncoder?.endAt(endT);
    for (const t of rt?.tracks.values() ?? []) {
      t.encoder?.endAt(endT);
      sampler?.addEncoder(t.encoder?.pid);
    }
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
      } catch (e) {
        log('error', `stopping the recorder failed: ${errorMessage(e)}`);
      }
    }
    if (sampler) {
      perfCpu = await sampler.stop().catch(() => undefined);
      perfMachine = sampler.machine();
      // R-FLD-25: a persona's page that costs CPU while nobody films it (measured on the fixture: ≈ 0.02 core).
      for (const b of perfCpu?.browsers ?? []) {
        if (!b.unfilmed || b.unfilmed.seconds < 4 || b.unfilmed.cpu / b.unfilmed.seconds <= UNFILMED_WARN_CORES) continue;
        const m = `persona ${b.persona ?? '(none)'}: its browser kept ${(b.unfilmed.cpu / b.unfilmed.seconds).toFixed(2)} cores busy while not filmed (${b.unfilmed.seconds.toFixed(0)} s) — its page polls or animates off screen and slows the take: leave a quieter page open there between its scenes`;
        timeline.warn(m);
        log('warn', m);
      }
    }
    if (recorder) {
      const minFps = Math.min(capture.fps, 30) * 0.6;
      // Without the drawn cursor a move changes nothing on screen: the frame rate during moves cannot be judged.
      const motion = opts.hideCursor
        ? null
        : motionCapture(frames.map((f) => f.t), timeline.cursor, minFps, timeline.cursorEffects, timeline.pages.map((p) => p.t_start), timeline.loading);
      timeline.stalls = (motion?.stalls ?? []).map((x) => ({ t_start: x.t, t_end: x.t_end, during: x.during }));
      const cause = perfMachine ? choppyCause({ gpu, cpu: perfCpu, machine: perfMachine, seconds: endT, frameRateLimit }) : undefined;
      for (const message of motionWarnings(motion, minFps, '', cause)) {
        timeline.warn(message);
        log('warn', message);
      }
      perfMotion = motion;
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
  // The encoders fed during the take (L5.7): nothing of a cancelled or discarded take is kept.
  const trackEncoders = [...(rt?.tracks.values() ?? [])].map((t) => t.encoder).filter((e): e is StreamEncoder => e !== null);
  if (cancelled || discard) {
    await Promise.all([mainEncoder, ...trackEncoders].map((e) => e?.abort()));
    mainEncoder = null;
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
      const cause = perfMachine ? choppyCause({ gpu, cpu: perfCpu, machine: perfMachine, seconds: endT, frameRateLimit }) : undefined;
      for (const message of motionWarnings(motion, minFps, `page ${id}: `, cause)) {
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
  let encodeDone: { finish_ms: number; late_frames: number } | null = null;
  if (mainEncoder && frames.length === 0) {
    await mainEncoder.abort();
    mainEncoder = null;
  }
  if (mainEncoder) {
    const out = join(dir, 'capture.mp4');
    emit({ type: 'encode', status: 'start', message: `${frames.length} frames → ${out}` });
    try {
      await mainEncoder.finish(endT);
      record.capture = out;
      encodeDone = { finish_ms: mainEncoder.finishMs, late_frames: mainEncoder.late };
      emit({ type: 'encode', status: 'done', message: out });
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
        await t.encoder?.abort();
        continue;
      }
      const out = join(dir, t.builder.info.file);
      if (!t.encoder) continue;
      emit({ type: 'encode', status: 'start', message: `page ${id}: ${list.length} frames → ${out}` });
      try {
        await t.encoder.finish(endT);
        emit({ type: 'encode', status: 'done', message: out });
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
  // One picture per step of a capture (R-FLD-16, capture.step_shots): its frame at the end of the step — copied from the
  // kept frames, else read from the video (L5.7: no frame written during the take). Nothing is taken during the take.
  if (rt && mode === 'capture' && capture.step_shots && !cancelled && !discard) {
    const multi = new Set(timeline.scenes.filter((x) => x.pages !== undefined).map((x) => x.id));
    const trackOf = (ev: TimelineEvent) => {
      const page = multi.has(ev.scene) ? ev.page : undefined;
      return page ? rt!.tracks.get(page) : undefined;
    };
    record.screenshots = capture.keep_frames
      ? await stepShots(timeline.events, screenshotsDir, { dir: framesDir, frames }, (ev) => {
          const t = trackOf(ev);
          const list = t ? trackFrames.get(t.builder.info.id) : undefined;
          return t && list?.length ? { dir: join(dir, t.builder.info.frames_file.replace(/\.jsonl$/, '')), frames: list } : null;
        }, log)
      : await videoStepShots(timeline.events, screenshotsDir, (ev) => {
          const t = trackOf(ev);
          const file = t ? join(dir, t.builder.info.file) : record.capture;
          return file ? { video: file, count: Math.max(1, Math.round(endT * capture.fps)) } : null;
        }, capture.fps, opts.ffmpeg ?? 'ffmpeg', log);
  }
  // What the screen did after each click (R-FLD-23, R-FLD-26): slow transitions, waits the edit shortens.
  let transitions: RunPerf['transitions'];
  if (record.capture && !mainFromTrack && activity.masks.length) {
    const multi = new Set(timeline.scenes.filter((x) => x.pages !== undefined).map((x) => x.id));
    const events = timeline.events.filter((e) => !multi.has(e.scene));
    if (process.env.DS_DEBUG_ACTIVITY) await writeFile(join(dir, 'activity.bin'), Buffer.concat(activity.masks)); // TEMP L5.7
    const act = analyzeActivity({
      masks: activity.masks,
      fps: capture.fps,
      width: capture.width,
      height: capture.height,
      cursor: opts.hideCursor ? [] : timeline.cursor,
      effects: timeline.cursorEffects,
      events,
      loading: timeline.loading,
    });
    timeline.busy = act.busy;
    log('debug', `transitions: ${act.transitions.map((x) => `${x.scene}.${x.step} ${x.ms} ms`).join(', ')}; waits: ${act.busy.map((b) => `${b.t_start}–${b.t_end} s`).join(', ') || 'none'}`);
    const slow = slowTransitions(act.transitions);
    transitions = { measured: clicksOf(events).length, slow: slow.slice(0, 10).map((x) => ({ t: x.t, ms: x.ms, scene: x.scene, step: x.step, ...(x.target ? { target: secrets.redactText(x.target) } : {}) })) };
    if (slow.length) {
      log('info', `slow transitions (click → stable screen over 0.8 s): ${slow.slice(0, 4).map((x) => `${x.scene}.${x.step} ${(x.ms / 1000).toFixed(1)} s`).join(', ')}${slow.length > 4 ? ', …' : ''}`);
    }
  }
  if (mode === 'capture' && !cancelled && !discard && perfMachine) {
    const disk = await diskCheck(dir, project.slug);
    if (disk.warning) {
      timeline.warn(disk.warning);
      log('warn', disk.warning);
    }
    const st = recorder?.stats();
    const perf: RunPerf = {
      seconds: Math.round(endT * 100) / 100,
      ...(perfCpu ? { cpu: perfCpu } : {}),
      machine: perfMachine,
      ...(gpu ? { gpu } : {}),
      frame_rate_limit: frameRateLimit,
      frames: {
        received: frames.length,
        fps: endT > 0 ? Math.round((frames.length / endT) * 10) / 10 : 0,
        ...(perfMotion?.worst ? { motion_fps_min: Math.round(perfMotion.worst.fps * 10) / 10 } : {}),
        dropped: st?.dropped ?? 0,
        kicked: (st?.kicked ?? 0) + [...(rt?.tracks.values() ?? [])].reduce((n, t) => n + (t.recorder?.kicked ?? 0), 0),
      },
      stalls: (perfMotion?.stalls ?? []).map((x) => ({ t: x.t, ms: x.ms, during: x.during })),
      ...(transitions ? { transitions } : {}),
      ...(livePreview && livePreview.seconds > 0 ? { live_preview: livePreview } : {}),
      ...(encodeDone && encoderKind ? { encode: { ...encoderLabel({ encoder: encoderKind, crf: capture.crf }), ...encodeDone } } : {}),
      disk: { run_mb: await folderMB(dir), frames_kept: capture.keep_frames, ...(disk.free_gb !== undefined ? { free_gb: disk.free_gb } : {}) },
    };
    record.perf = perf;
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
      if (failure.missing) err.missing_targets = failure.missing;
    }
    record.error = err;
  }
  emit({ type: 'run_end', run: { ...record } });
  await files.close().catch(() => undefined);
  return secrets.redactRecord(record);
}

/**
 * capture.step_shots (R-FLD-16): for every step that ran, the last captured frame at or before its end (its page's track
 * in a multi-page scene), copied to screenshots/<scene>-<nn>-<action>.<ext> — the names a dry run gives its pictures.
 */
async function stepShots(
  events: readonly TimelineEvent[],
  screenshotsDir: string,
  main: { dir: string; frames: FrameIndexEntry[] },
  track: (ev: TimelineEvent) => { dir: string; frames: FrameIndexEntry[] } | null,
  log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void,
): Promise<string[]> {
  const out: string[] = [];
  for (const ev of events) {
    if (ev.step < 0 || ev.status === 'skipped') continue;
    const src = track(ev) ?? main;
    let pick: FrameIndexEntry | undefined;
    for (const f of src.frames) {
      if (f.t > ev.t_end + 1e-6) break;
      pick = f;
    }
    if (!pick) continue;
    const ext = extname(pick.file) || '.jpg';
    const file = join(screenshotsDir, `${fileSlug(ev.scene)}-${pad(ev.step, 2)}-${ev.action}${ext}`);
    try {
      await copyFile(join(src.dir, pick.file), file);
      out.push(file);
    } catch (e) {
      log('warn', `step picture of ${ev.scene}.${ev.step} not kept: ${errorMessage(e)}`);
    }
  }
  return out;
}

/**
 * capture.step_shots without kept frames (L5.7): for every step that ran, the frame of its video (capture.mp4, or its
 * page's track) shown at its end — output frame floor(t_end · fps), the CFR schedule's latest captured frame at or before
 * it — read in one ffmpeg pass per video, saved as screenshots/<scene>-<nn>-<action>.jpg.
 */
async function videoStepShots(
  events: readonly TimelineEvent[],
  screenshotsDir: string,
  videoOf: (ev: TimelineEvent) => { video: string; count: number } | null,
  fps: number,
  ffmpeg: string,
  log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void,
): Promise<string[]> {
  const byVideo = new Map<string, Array<{ ev: TimelineEvent; n: number }>>();
  for (const ev of events) {
    if (ev.step < 0 || ev.status === 'skipped') continue;
    const src = videoOf(ev);
    if (!src) continue;
    const n = Math.min(src.count - 1, Math.max(0, Math.floor(ev.t_end * fps + 1e-6)));
    let list = byVideo.get(src.video);
    if (!list) byVideo.set(src.video, (list = []));
    list.push({ ev, n });
  }
  const out: string[] = [];
  for (const [video, list] of byVideo) {
    const ns = [...new Set(list.map((x) => x.n))].sort((a, b) => a - b);
    const tmp = join(screenshotsDir, `.step-shots-${process.pid}`);
    try {
      await rm(tmp, { recursive: true, force: true });
      await mkdir(tmp, { recursive: true });
      const select = ns.map((n) => `eq(n\\,${n})`).join('+');
      await runFfmpeg(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-i', video, '-vf', `select='${select}'`, '-fps_mode', 'passthrough', '-q:v', '2', join(tmp, '%05d.jpg')]);
      for (const { ev, n } of list) {
        const file = join(screenshotsDir, `${fileSlug(ev.scene)}-${pad(ev.step, 2)}-${ev.action}.jpg`);
        try {
          await copyFile(join(tmp, `${pad(ns.indexOf(n) + 1, 5)}.jpg`), file);
          out.push(file);
        } catch (e) {
          log('warn', `step picture of ${ev.scene}.${ev.step} not kept: ${errorMessage(e)}`);
        }
      }
    } catch (e) {
      log('warn', `step pictures not kept (${errorMessage(e)})`);
    } finally {
      await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    }
  }
  return out.sort();
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
  via?: AgentChannel;
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
  return new StepFailure(message, failure.scene, failure.step, failure.action, failure.screenshot, failure.dom, failure.missing);
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
    ...(d.via ? { via: d.via } : {}),
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
 * The runner of `hook:` steps (L5.8): the named hook (the scenario's, else project.yaml's) runs in the setup's context
 * — the same journal (its rollbacks are undone with the setup's, after the teardown), the same saved results
 * (`{{hooks.<save_as>…}}` in later steps) — with the run's cancel. A failed or refused entry fails the step.
 */
function stepHookRunner(h: HooksState, sc: Scenario, d: SetupDeps): (name: string) => Promise<HookStepOutcome> {
  return async (name) => {
    const named = resolveNamedHook(name, sc, d.project);
    if (!named) throw new StepError(`unknown hook "${name}": declare it under \`hooks:\` in the scenario or in project.yaml`);
    d.emit({ type: 'hook', phase: 'step', name, status: 'start', message: `${named.hooks.length} hook(s)` });
    h.ctx.signal = d.signal;
    let res: Awaited<ReturnType<HooksModule['runHooks']>>;
    try {
      res = await h.mod.runHooks(named.hooks, h.ctx, { phase: 'step', journal: h.journal });
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
