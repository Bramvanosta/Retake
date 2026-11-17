/**
 * The browser driver of a capture run (driver.ts): Chromium through Playwright, with the in-page kit — the environment's
 * pages probed, the write guard armed, the personas' sessions copied and checked off camera, the product's clock, the
 * runtime that plays the scenes, the prewarm, the recorders and their encoders fed during the take, the live picture,
 * the CPU sampler, the pause of a take, the inspection, the sign-in guard and the session check after a failure; after
 * the take, the recorders' frames, the encodes, the step pictures, what the screen did after each click and what the
 * take cost.
 */
import { copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page } from 'playwright-core';
import { AGENT_CONFINEMENT } from '@retake/core/model';
import { isCaptureScene } from '@retake/core/language';
import { templateSceneEntry } from '@retake/core/language';
import { compileWritePolicy, guardsWrites, loginCommand as defaultLoginCommand, planPersonas, resolvePersonas } from '@retake/core/environment';
import { pageOrigins } from '@retake/core/run';
import { ffmpegBin, retakeHome } from '@retake/core/io';
import type { RunPerf, RunPerfCpu, TimelineEvent } from '@retake/core/run';
import type { PersonaPlan, ResolvedPersona } from '@retake/core/environment';
import { snapshotMailbox } from '../actions/artefacts.js';
import { settleEffectChecks } from '../actions/effects.js';
import { projectBrowser } from '../config.js';
import { ActivityRecorder, analyzeActivity, clicksOf, slowTransitions } from '../activity.js';
import { type LoginGuard, preflight, prepareSessions, removeSessionCopiesSync, writeStatus } from '../auth.js';
import type { PreparedSession } from '../auth.js';
import { runEngine } from '../engine.js';
import { EncodeError, LoginPageError, PreflightError, RunnerError, errorMessage, isCancelled } from '../errors.js';
import { evalHookInPage } from '../hook-page.js';
import { inspectPage } from '../inspect.js';
import type { InspectContext, InspectRequest } from '../inspect.js';
import { kitConfigFor } from '../kit/source.js';
import { launchCredentials } from '../launch.js';
import { LivePreview } from '../live-preview.js';
import { LoadingWatch } from '../loading-watch.js';
import { watchNotifications } from '../notifications.js';
import { openProblem } from '../opens.js';
import { probePages, preflightRefusal } from '../page-preflight.js';
import { RunPauser } from '../pause.js';
import { PerfSampler, UNFILMED_WARN_CORES, listeningPids, localPorts } from '../perf.js';
import { prewarmPages, prewarmTargets } from '../prewarm.js';
import { ScreencastRecorder } from '../recorder.js';
import type { FrameIndexEntry } from '../recorder.js';
import { Runtime } from '../runtime.js';
import type { HookStepOutcome } from '../runtime.js';
import { StepFailure, runScenes, untilSteps } from '../scenes.js';
import { BrowserSession } from '../session.js';
import type { GpuInfo } from '../session.js';
import { StreamEncoder, encoderLabel, resolveEncoder } from '../stream.js';
import type { StreamEncoderOptions } from '../stream.js';
import { motionCapture } from '../timeline.js';
import type { MotionCapture } from '../timeline.js';
import { diagnoseSession, foreignSignIn, refuseIosEnvironment, formatIssuePath, hookLanding, hookPersonaAuth, personaOf, personaOfKey, readOnlyGuard, signInGuard } from './browser-guards.js';
import type { CaptureDriver, CaptureRun, DriverTake } from './driver.js';
import type { DriverHooks } from './hooks.js';
import type { FilmingReport } from './options.js';
import { choppyCause, diskCheck, folderMB, motionWarnings, warnLimitedLoads } from './perf-words.js';
import { discardCapture, stepShots, videoStepShots } from './step-shots.js';
import type { WriteGuardOptions } from '../write-guard.js';
import { bestEffort } from '@retake/core/base';

/** Inspect the page the run shows and hand the report over (inspect.ts). */
async function inspectNow(req: InspectRequest, rt: Runtime, ctx: InspectContext): Promise<void> {
  const { onResult, ...request } = req;
  const report = await inspectPage(rt, request, ctx);
  await onResult(report);
}

/** The browser driver of `run` (runScenario's). */
export function browserDriver(run: CaptureRun): CaptureDriver {
  return new BrowserDriver(run);
}

class BrowserDriver implements CaptureDriver {
  private session: BrowserSession | null = null;
  private prepared: PreparedSession[] = [];
  private personas: ResolvedPersona[] = [];
  /** Personas whose session expired during the run: their status says so at the end (`retake auth status`). */
  private readonly expiredDuring = new Map<string, { at: string; detail: string }>();
  private guard: LoginGuard | null = null;
  private planned: PersonaPlan | null = null;
  private rt: Runtime | null = null;
  private notifications: { settled: () => Promise<void> } | null = null;
  private recorder: ScreencastRecorder | null = null;
  /** The live picture: on camera only, from capture time 0 to the start of `stop`. */
  private live: LivePreview | null = null;
  /** What watching the live picture cost (perf.live_preview). */
  private livePreview: { seconds: number; frames_sent: number } | null = null;
  private frames: FrameIndexEntry[] = [];
  // capture.mp4 encoded during the take, what it showed after each click, what the take cost.
  private encoderKind: StreamEncoderOptions['encoder'] | null = null;
  private perfMotion: MotionCapture | null = null;
  private mainEncoder: StreamEncoder | null = null;
  private readonly activity = new ActivityRecorder();
  private sampler: PerfSampler | null = null;
  // Hotfix v0.2.6: the loading indicators the filmed page shows (the review's `loading-filmed`).
  private loadingWatch: LoadingWatch | null = null;
  private gpu: GpuInfo | undefined;
  private perfCpu: RunPerfCpu | undefined;
  private perfMachine: RunPerf['machine'] | undefined;
  private readonly browserConfig: ReturnType<typeof projectBrowser>;
  private readonly frameRateLimit: boolean;
  private writeGuard: WriteGuardOptions | null = null;
  private httpCredentials: ReturnType<typeof launchCredentials> = undefined;

  constructor(private readonly run: CaptureRun) {
    this.browserConfig = projectBrowser(run.project, run.opts.browser);
    this.frameRateLimit = this.browserConfig.frame_rate_limit !== false;
  }

  /** The `retake login` command of a persona (the legacy one has no --persona). */
  private readonly commandOf = (persona: string): string => {
    const { opts, project, env } = this.run;
    return (opts.loginCommand ?? defaultLoginCommand)({ project: project.slug, env: env.name, persona: this.personas.find((p) => p.name === persona)?.legacy ? undefined : persona });
  };

  private readonly expire = (persona: string, at: string, detail: string): void => {
    if (!this.expiredDuring.has(persona)) this.expiredDuring.set(persona, { at, detail });
  };

  private newEncoder(o: { out: string; width: number; height: number; horizon: () => number; thumbs?: boolean }): StreamEncoder {
    const { capture, opts } = this.run;
    return new StreamEncoder({
      out: o.out,
      fps: capture.fps,
      width: o.width,
      height: o.height,
      format: capture.format,
      encoder: this.encoderKind ?? 'libx264',
      crf: capture.crf,
      ...(opts.ffmpeg ? { ffmpeg: opts.ffmpeg } : {}),
      policy: opts.policy,
      horizon: o.horizon,
      ...(o.thumbs ? { onThumb: (n: number, g: Buffer) => this.activity.add(n, g) } : {}),
    });
  }

  private inspectContext(at: InspectContext['at'], failed: StepFailure | null): InspectContext {
    const { rt, planned, run } = this;
    return {
      at,
      persona: (rt?.activeId ? planned?.pages.get(rt.activeId) : null) ?? null,
      replay: {
        steps_done: run.record.steps_done,
        steps_total: run.total,
        until: run.opts.until ?? null,
        skipped_irreversible: rt ? rt.timeline.events.filter((e) => e.status === 'dry').length : 0,
        hooks: run.record.hooks.setup === 'skipped' || run.record.hooks.teardown === 'skipped' ? 'skipped' : 'none',
        failed: failed ? { scene: failed.scene, step: failed.step, action: failed.action } : null,
      },
      ...(failed ? { error: run.secrets.redactText(failed.message) } : {}),
    };
  }

  async prepare(): Promise<void> {
    const { project, env, sc, access, secrets, timeline, clock, log, signal } = this.run;
    refuseIosEnvironment(env);
    // Sign-in details written in the environment's page URLs: the browser's HTTP credentials for that origin, masked
    // like a secret wherever the run writes (resolveEnvironment already took them out of the URLs).
    const httpCredentials = (this.httpCredentials = launchCredentials(project, env.name));
    if (httpCredentials?.password) secrets.addValue(httpCredentials.password);
    // R-FLD-33: every page of the environment answers before anything opens (a port that moved, a stopped server).
    const probes = await probePages(env.pages, { signal });
    const down = probes.filter((p) => !p.ok);
    if (down.length) {
      throw new RunnerError(preflightRefusal(env.name, down, env.sandbox ? { sandbox: `retake sandbox up ${project.slug} --env ${env.name}, or run with --sandbox` } : {}));
    }
    log('debug', `pages answer: ${probes.map((p) => `${p.keys.join('/')} HTTP ${p.status} (${p.ms} ms)`).join(', ')}`);
    // A read-only run stops the browser's writes (write-guard.ts): armed in every browser at launch. Any run
    // stops writes to the hosts of the project's other read-only environments (none: a read-write run arms nothing).
    const policy = compileWritePolicy(env, { scenarioMocks: sc.mocks, access });
    if (guardsWrites(policy)) {
      this.writeGuard = readOnlyGuard(policy, {
        timeline,
        log,
        captureStarted: () => this.run.captureStarted,
        where: () => {
          const cur = this.rt?.current;
          const at = `${clock.now().toFixed(1)} s`;
          return cur ? `${cur.step >= 0 ? `step ${cur.scene}.${cur.step}` : `scene ${cur.scene}`}, ${at}` : at;
        },
        pageId: (p) => this.session?.idOf(p),
      });
    }
    if (!policy.readOnly && sc.mocks?.length) {
      log('warn', `the scenario's mocks apply to read-only runs only: environment ${env.name} runs read-write, its writes really happen`);
    }
  }

  identify(): void {
    const { project, env, secrets } = this.run;
    // Sessions & personas: which persona films each page, each one's browser on a copy of its session, checked
    // off camera before anything runs — no setup hook, no recorder yet.
    this.personas = resolvePersonas(project, env.name, { home: retakeHome() });
    // A sandbox account's plain password is a secret as written: registered now, before anything this run writes
    // can hold it (the outline; autoLogin registers it again when its login runs).
    for (const p of this.personas) for (const v of p.secrets ?? []) secrets.addValue(v);
  }

  /** The capture's browsers: one per persona the plan uses (on its session's copy), the default one if needed. */
  private openBrowsers(plan: PersonaPlan, prepared: PreparedSession[]): Promise<BrowserSession> {
    const { opts, project, env, capture, log } = this.run;
    const personas = this.personas;
    const realmOf = personaOf(plan, personas, env, () => this.rt);
    const writeGuard = this.writeGuard;
    const httpCredentials = this.httpCredentials;
    return BrowserSession.open({
      policy: opts.policy,
      width: capture.width,
      height: capture.height,
      scale: capture.scale,
      kit: kitConfigFor(opts.template, opts.hideCursor ? { hidden: true } : undefined),
      browser: projectBrowser(project, opts.browser),
      headed: opts.headed,
      log,
      ...(writeGuard ? { writes: writeGuard } : {}),
      ...(httpCredentials ? { httpCredentials } : {}),
      ...(prepared.length
        ? {
            realms: [...prepared.map((p) => p.realm), ...(plan.needsDefault ? [{ name: '' }] : [])],
            realmOf: (id: string) => realmOf(id) ?? '',
            hookRealmOf: (key: string) => (plan.hookPages.has(key) ? (plan.hookPages.get(key) ?? '') : (personaOfKey(personas, key) ?? '')),
          }
        : {}),
    });
  }

  /** The encoder fed during the take, the GPU the capture renders with, a limiter turned off. */
  private async checkRendering(session: BrowserSession): Promise<void> {
    const { opts, capture, timeline, log } = this.run;
    this.encoderKind = await resolveEncoder(capture.encoder, opts.ffmpeg, opts.policy);
    const gpu = (this.gpu = await session.gpuInfo());
    if (gpu && !gpu.accelerated) {
      const m = `the capture browser renders without its GPU (${gpu.renderer ?? 'software'}${gpu.software?.length ? `; in software: ${gpu.software.join(', ')}` : ''}): motion may look choppy and the CPU climbs — see \`retake doctor\`${this.browserConfig.channel === 'headless-shell' ? ' (browser.channel: headless-shell has no GPU: remove it)' : ''}`;
      timeline.warn(m);
      log('warn', m);
    }
    if (!this.frameRateLimit) {
      const m =
        'browser.frame_rate_limit: false makes Chromium draw back to back (measured on the fixture: ×2.8 its CPU, its GPU and renderer processes ×7) — ' +
        'the dialog-close freeze it was set for is handled without it now (fresh frames during a click ripple, the edit cuts what is left): remove it';
      timeline.warn(m);
      log('warn', m);
    }
  }

  /** The runtime that plays the scenes in `session`. */
  private newRuntime(session: BrowserSession, guard: LoginGuard | null, plan: PersonaPlan, signedIn: boolean): Runtime {
    const r = this.run;
    const { opts, project, env, sc, mode, capture, secrets, timeline, template, log, signal } = r;
    return new Runtime({
      session,
      timeline,
      pacing: r.pacing,
      capture,
      mode,
      signal,
      project,
      env,
      runDir: r.dir,
      screenshotsDir: r.screenshotsDir,
      template,
      secrets,
      recorder: null,
      cursorHidden: opts.hideCursor === true,
      ...(opts.hookTrust === 'mcp' ? { agentTrust: true } : {}),
      // What its navigations open (opens.ts): http(s) or about:blank; work an agent wrote, the environment's origins only.
      navigation: opts.hookTrust === 'mcp' ? { origins: pageOrigins(env.pages), envName: env.name, via: opts.hookVia ?? AGENT_CONFINEMENT } : {},
      ...(opts.inspect ? { inspecting: true } : {}),
      // Step defaults: the scenario's win over the project's.
      ...((sc.defaults?.timeout_s ?? project.config.defaults?.timeout_s) !== undefined ? { defaultTimeoutS: sc.defaults?.timeout_s ?? project.config.defaults?.timeout_s } : {}),
      log,
      guard,
      ...(signedIn ? { plannedPersonas: plan.pages } : {}),
      ...(mode === 'capture' ? { encoderFor: (o: { out: string; width: number; height: number; horizon: () => number }) => this.newEncoder(o) } : {}),
    });
  }

  async open(): Promise<void> {
    const r = this.run;
    const { opts, project, env, sc, mode, until, hooksMode, runId, secrets, template, log, emit, signal } = r;
    const personas = this.personas;
    const plan = planPersonas(sc, { env: env.name, envPages: env.pages, personas, until, hooks: hooksMode === 'run', ...(project.config.hooks ? { projectHooks: project.config.hooks } : {}) });
    if (plan.issues.length) throw new RunnerError(plan.issues.map((i) => `${formatIssuePath(i.path)}: ${i.message}`).join('\n'));
    this.planned = plan;
    const prepared = (this.prepared = await prepareSessions(
      personas.filter((p) => plan.used.includes(p.name)),
      { runId, log },
    ));
    const session = (this.session = await this.openBrowsers(plan, prepared));
    const chromium = await session.browserVersion();
    if (chromium) {
      r.record.engine = runEngine(chromium);
      void r.files.saveRecord();
    }
    if (mode === 'capture') await this.checkRendering(session);
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
        signInTab: (p, onSignInPage) => this.session?.markSignIn(p, onSignInPage),
        ...(opts.loginCommand ? { loginCommand: opts.loginCommand } : {}),
        onPersona: (persona, status, detail) => emit({ type: 'session', persona, status, ...(detail !== undefined ? { detail } : {}) }),
      });
    }
    // The product's clock (R-ENV-05): after the preflight (a sign-in under a far clock may fail its token checks),
    // before the setup hooks; set back to its time at capture time 0 (anchorClock).
    const runClock = r.runClock;
    if (runClock) {
      await session.installClock(runClock);
      log(
        'info',
        `clock: the product's browser reads ${runClock.at}${runClock.timezone ? ` (${runClock.timezone})` : ''} at capture time 0${runClock.freeze ? ' and never moves (freeze)' : ', then runs'}`,
      );
    }
    const guard = (this.guard = signInGuard({
      project,
      env,
      personas,
      plan,
      session: () => this.session,
      command: this.commandOf,
      hooksJustRan: () => r.record.steps_done === 0 && r.record.hooks.setup === 'ok',
      redact: (t) => secrets.redactText(t),
      abort: (e) => r.abort.abort(e),
    }));
    const rt = (this.rt = this.newRuntime(session, guard, plan, prepared.length > 0));

    if (opts.hideCursor) log('info', 'capturing without the in-page cursor (raw export): its track, icon, presses and ripples are recorded as data');
    this.notifications = watchNotifications(rt);
    // wait_for_email takes only the messages that arrive during the run: remember those already there (before setup).
    if (r.readsMail) await snapshotMailbox(rt);
  }

  hooks(): DriverHooks {
    const { project, env, log, opts } = this.run;
    const session = this.session!;
    const loginLanding = hookLanding(this.guard, { personas: this.personas, env, session, command: this.commandOf, expire: this.expire });
    const writeGuard = this.writeGuard;
    const writes = writeGuard ? { policy: writeGuard.policy, ...(writeGuard.onWrite ? { onWrite: writeGuard.onWrite } : {}) } : undefined;
    return {
      // js hooks run in a guarded tab of their own, kept for the run (hook-page.ts), never in a capture tab.
      evalInPage: (pageKey, code) => evalHookInPage(session, { project, env, log, ...(loginLanding ? { loginLanding } : {}), ...(writes ? { writes } : {}) }, pageKey, code),
      personaAuth: hookPersonaAuth(this.personas, env, session, this.commandOf, opts.hookTrust === 'mcp'),
    };
  }

  setHookSteps(run: (name: string) => Promise<HookStepOutcome>): void {
    this.rt!.runHook = run;
  }

  /** R-FLD-27: every page the scenario opens, visited once off camera, so the take does not film it cold. */
  private async prewarm(rt: Runtime): Promise<void> {
    const { env, sc, capture, until, log } = this.run;
    const targets = prewarmTargets(sc, {
      envPages: env.pages,
      capture: { width: capture.width, height: capture.height },
      template: (entry, si) => {
        try {
          return templateSceneEntry(untilSteps(entry, si, until), si, rt.template, rt.editTemplate);
        } catch {
          return null;
        }
      },
      ...(until ? { lastScene: until.sceneIndex } : {}),
      // A page the take may not open is not visited either (its step fails when it runs).
      mayOpen: (url) => openProblem(url, rt.navigation) === null,
    });
    const done = await prewarmPages(rt, targets);
    log('info', `prewarm: ${done.visited} of ${targets.length} page${targets.length === 1 ? '' : 's'} visited off camera in ${(done.ms / 1000).toFixed(1)} s`);
    for (const f of done.failed) log('warn', `prewarm: ${f}`);
  }

  /** capture.mp4: its encoder fed during the take, the screencast recorder and the loading watch of the filmed page. */
  private async startMainCapture(rt: Runtime, firstPage: string | undefined): Promise<void> {
    const { capture, timeline, clock, dir, framesDir } = this.run;
    const mainEncoder = (this.mainEncoder = this.newEncoder({
      out: join(dir, 'capture.mp4'),
      width: capture.width * capture.scale,
      height: capture.height * capture.scale,
      horizon: () => this.recorder?.horizon() ?? 0,
      thumbs: true,
    }));
    mainEncoder.start();
    const recorder = (this.recorder = new ScreencastRecorder({
      framesDir,
      indexFile: join(dir, 'frames.jsonl'),
      format: capture.format,
      quality: capture.quality,
      width: capture.width,
      height: capture.height,
      scale: capture.scale,
      clock,
      onError: (m) => timeline.warn(m),
      pageId: (p) => this.session?.idOf(p),
      keepFrames: capture.keep_frames,
      sink: mainEncoder,
    }));
    if (firstPage) await recorder.start(rt.page);
    else await recorder.prepare();
    rt.recorder = recorder;
    this.loadingWatch = new LoadingWatch(
      () => recorder.recordingPage ?? undefined,
      () => clock.now(),
      (p) => this.session?.idOf(p),
    );
    this.loadingWatch.start();
  }

  /** What the take costs (R-FLD-23): Chromium's processes, the encoders, the product's local servers. */
  private async startSampler(): Promise<PerfSampler> {
    const { env } = this.run;
    const s = new PerfSampler({
      chromium: () => this.session?.processInfo() ?? Promise.resolve([]),
      // The personas' browsers a recorder films now (the main capture's page, the pages of a multi-page scene).
      filmed: () => {
        const pages = [this.recorder?.recordingPage, ...[...(this.rt?.tracks.values() ?? [])].map((t) => t.recorder?.recordingPage)];
        return new Set(pages.filter((p): p is Page => !!p).map((p) => this.session?.realmName(p) ?? ''));
      },
    });
    s.addEncoder(this.mainEncoder?.pid);
    s.addProduct(await listeningPids(localPorts(Object.values(env.pages))));
    s.start();
    return s;
  }

  /** The pause of a take: a capture does not film it (its recorders, clock and CPU sampler stop meanwhile). */
  private pauser(gate: NonNullable<CaptureRun['opts']['pause']>, rt: Runtime): RunPauser {
    const r = this.run;
    const { record, emit, log, signal, files, clock, timeline } = r;
    return new RunPauser({
      gate,
      signal,
      record,
      emit,
      save: () => void files.saveRecord(),
      log,
      ...(r.filmingPause ? { filming: r.filmingPause } : {}),
      // A capture does not film the pause: its recorders, clock and CPU sampler stop meanwhile (pause.ts).
      take: {
        clock,
        filming: () => {
          const out: Array<{ recorder: ScreencastRecorder; page: Page }> = [];
          for (const rec of [this.recorder, ...[...rt.tracks.values()].map((t) => t.recorder)]) {
            const page = rec?.recordingPage;
            if (rec && page) out.push({ recorder: rec, page });
          }
          return out;
        },
        lastPress: () => {
          const ts = [timeline.cursorEffects, ...timeline.tracks.map((t) => t.cursorEffects)]
            .flat()
            .filter((e) => e.type === 'press' || e.type === 'ripple')
            .map((e) => e.t);
          return ts.length ? Math.max(...ts) : null;
        },
        settleEffects: () => settleEffectChecks({ rt }),
        sampler: () => this.sampler,
        note: (p) => timeline.pauses.push(p),
      },
    });
  }

  async film(): Promise<void> {
    const r = this.run;
    const { opts, env, sc, mode, capture, until, record, emit, files } = r;
    const rt = this.rt!;
    const session = this.session!;
    const captured = sc.scenes.filter(isCaptureScene).filter((s) => !s.skip);
    const firstScene = captured[0];
    const firstPage = firstScene?.pages !== undefined ? undefined : (firstScene?.page ?? Object.keys(env.pages)[0]);
    if (firstScene?.pages === undefined && !firstPage) throw new RunnerError(`environment "${env.name}" declares no pages`);
    // R-FLD-27: every page the scenario opens, visited once off camera, so the take does not film it cold.
    if (mode === 'capture' && capture.prewarm) await this.prewarm(rt);
    // Capture time 0: right before the first page is shown and the screencast starts. The product's clock reads its
    // time now, in every browser.
    await session.anchorClock();
    r.startCapture();
    if (opts.live) {
      this.live = new LivePreview({ sink: opts.live, page: () => rt.page, pageId: (p) => this.session?.idOf(p), width: capture.width, height: capture.height });
      this.live.start();
    }
    // A scenario whose first scene films several pages starts with their tracks (the main capture starts with the
    // first single-page scene, if any).
    if (firstPage) await rt.activate(firstPage);
    if (mode === 'capture' && captured.some((s) => s.pages === undefined)) await this.startMainCapture(rt, firstPage);
    if (mode === 'capture') this.sampler = await this.startSampler();
    const pauser = opts.pause ? this.pauser(opts.pause, rt) : null;
    await runScenes(rt, {
      scenario: sc,
      scenarioName: r.loaded.name,
      until,
      record,
      emit,
      save: () => void files.saveRecord(),
      ...(pauser ? { beforeStep: (scene: string, step: number) => pauser.before(scene, step) } : {}),
    });
    rt.assertSignedIn();
    if (opts.inspect) await inspectNow(opts.inspect, rt, this.inspectContext(until ? 'until' : 'end', null));
  }

  async failed(e: unknown): Promise<unknown> {
    const { opts, log } = this.run;
    // A step that failed because its page landed on a sign-in page reports the landing.
    let failure = this.guard?.error ?? e;
    // The step that failed is where an author needs to see the page (never a sign-in landing: nothing of it is kept).
    if (opts.inspect && this.rt && failure === e && e instanceof StepFailure) {
      try {
        await inspectNow(opts.inspect, this.rt, this.inspectContext('failed_step', e));
      } catch (err) {
        if (this.guard?.error) failure = this.guard.error;
        else log('warn', `inspection at the failed step: ${errorMessage(err)}`);
      }
    }
    return failure;
  }

  /** Every recorder of the take stopped: the page tracks' frames and loads, then the main capture's. */
  private async stopRecorders(): Promise<void> {
    const { timeline, log } = this.run;
    const { rt, recorder } = this;
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
        this.frames = await recorder.stop();
        timeline.loading = recorder.loadingIntervals();
        warnLimitedLoads(recorder, timeline, log);
        const st = recorder.stats();
        if (st.write_errors) timeline.warn(`${st.write_errors} frames could not be written`);
      } catch (e) {
        log('error', `stopping the recorder failed: ${errorMessage(e)}`);
      }
    }
  }

  /** The CPU sampler stopped: what the take cost, and a persona's browser busy while nobody filmed it. */
  private async stopSampler(beside: FilmingReport | undefined): Promise<void> {
    const { timeline, log } = this.run;
    const sampler = this.sampler;
    if (!sampler) return;
    const perfCpu = (this.perfCpu = await sampler.stop().catch(() => undefined));
    this.perfMachine = { ...sampler.machine(), ...(beside ? { takes_beside: beside.takes_beside, ...(beside.heavy_slowed ? { heavy_slowed: true as const } : {}) } : {}) };
    // R-FLD-25: a persona's page that costs CPU while nobody films it (measured on the fixture: ≈ 0.02 core).
    for (const b of perfCpu?.browsers ?? []) {
      if (!b.unfilmed || b.unfilmed.seconds < 4 || b.unfilmed.cpu / b.unfilmed.seconds <= UNFILMED_WARN_CORES) continue;
      const m = `persona ${b.persona ?? '(none)'}: its browser kept ${(b.unfilmed.cpu / b.unfilmed.seconds).toFixed(2)} cores busy while not filmed (${b.unfilmed.seconds.toFixed(0)} s) — its page polls or animates off screen and slows the take: leave a quieter page open there between its scenes`;
      timeline.warn(m);
      log('warn', m);
    }
  }

  /** The main capture's motion: the frame rate while the cursor moves, its stalls and their warnings. */
  private measureMotion(endT: number): void {
    const { opts, capture, timeline, log } = this.run;
    const minFps = Math.min(capture.fps, 30) * 0.6;
    // Without the drawn cursor a move changes nothing on screen: the frame rate during moves cannot be judged.
    const motion = opts.hideCursor
      ? null
      : motionCapture({
          frameTimes: this.frames.map((f) => f.t),
          samples: timeline.cursor,
          minFps,
          effects: timeline.cursorEffects,
          pageChanges: timeline.pages.map((p) => p.t_start),
          held: timeline.loading,
        });
    timeline.stalls = (motion?.stalls ?? []).map((x) => ({ t_start: x.t, t_end: x.t_end, during: x.during }));
    const cause = this.perfMachine ? choppyCause({ gpu: this.gpu, cpu: this.perfCpu, machine: this.perfMachine, seconds: endT, frameRateLimit: this.frameRateLimit }) : undefined;
    for (const message of motionWarnings(motion, minFps, '', cause)) {
      timeline.warn(message);
      log('warn', message);
    }
    this.perfMotion = motion;
  }

  async stop(): Promise<void> {
    const r = this.run;
    const { mode, timeline, clock, log, env, secrets, signal } = r;
    const { rt, recorder, guard, session } = this;
    // Off camera from here: the live picture stops before anything else (teardown, diagnosis, artefacts).
    await this.live?.stop().catch(() => undefined);
    // A capture filmed while someone watched its live picture says so: the screencast's JPEG encoding ran
    // in Chromium's browser process during the take.
    const livePreview = (this.livePreview = this.live ? this.live.watched() : null);
    if (mode === 'capture' && livePreview && livePreview.seconds > 0) {
      const m = `the live picture was watched for ${livePreview.seconds.toFixed(1)} s of the take (${livePreview.frames_sent} frames sent): Chromium encoded it on top of the capture`;
      timeline.warn(m);
      log('info', m);
    }
    // The last click's effect check (R-FLD-12) ends before the capture does (--until, a failed step included).
    if (rt) await settleEffectChecks({ rt }).catch(() => undefined);
    const endT = (r.endT = clock.now());
    if (mode === 'capture' && timeline.pauses.length) {
      const n = timeline.pauses.length;
      const s = timeline.pauses.reduce((x, p) => x + p.ms, 0) / 1000;
      const m = `paused ${n === 1 ? 'once' : `${n} times`} (${s.toFixed(1)} s, not filmed): the video goes on where it paused — what the page did meanwhile (timers, animations, the product's clock) shows as a jump there`;
      timeline.warn(m);
      log('info', m);
    }
    // The encoders write no tick past the end of the take.
    this.mainEncoder?.endAt(endT);
    for (const t of rt?.tracks.values() ?? []) {
      t.encoder?.endAt(endT);
      this.sampler?.addEncoder(t.encoder?.pid);
    }
    if (r.failure === null && guard?.error) r.failure = guard.error;
    await this.stopRecorders();
    // Off camera: heavy work held for this take may go on (teardown, diagnosis and artefacts are not filming).
    const beside: FilmingReport | undefined = r.stopFilming();
    if (this.loadingWatch) {
      const spans = this.loadingWatch.stop();
      if (spans.length) timeline.loading_ui = spans;
    }
    await this.stopSampler(beside);
    if (recorder) this.measureMotion(endT);
    // A landing seen while the run was ending (after a step failed, or a cancel): nothing of the capture is kept either.
    if (guard?.error) r.failure = guard.error;
    // A step failure on a persona's page: was it the session? One check, off camera, now that nothing is filmed.
    if (r.failure instanceof StepFailure && session && this.prepared.length)
      r.failure = await diagnoseSession(r.failure, {
        session,
        rt,
        prepared: this.prepared,
        envPages: env.pages,
        secrets,
        command: this.commandOf,
        signal,
        expire: this.expire,
      });
  }

  async close(): Promise<void> {
    const r = this.run;
    const { rt } = this;
    const failure = r.failure;
    if (this.notifications) await bestEffort(this.notifications.settled(), 'a notification stream that failed has nothing more to settle');
    await this.session?.close().catch((e: unknown) => r.log('warn', `closing the browser failed: ${errorMessage(e)}`));
    // Artefact images (emails, PDF pages, icons, project documents) are rendered after the capture, in a clean browser.
    if (rt && !(failure !== null && (isCancelled(failure) || failure instanceof LoginPageError))) {
      try {
        await rt.artefacts.finalize({ browser: projectBrowser(r.project, r.opts.browser), scenario: r.sc, project: r.project, policy: r.opts.policy });
      } catch (e) {
        r.timeline.warn(`artefacts: ${errorMessage(e)}`);
      }
    }
    if (rt) r.timeline.artefacts = rt.artefacts.items;
  }

  /** The personas whose session expired during the run (a sign-in landing included): their status says so. */
  private async saveExpiredSessions(): Promise<void> {
    const r = this.run;
    const { env, secrets, log, runId } = r;
    const { guard, personas, prepared, planned } = this;
    // The session of a persona whose page landed on its own sign-in page expired during the run.
    const landing = guard?.landing;
    if (landing?.persona && r.failure instanceof LoginPageError && !foreignSignIn(landing.url, landing.persona, env.pages, personas, planned)) {
      this.expire(landing.persona, landing.url, `page ${landing.pageId} landed on the sign-in page during run ${runId}`);
    }
    for (const [name, x] of this.expiredDuring) {
      const persona = prepared.find((p) => p.persona.name === name)?.persona;
      if (!persona) continue;
      await writeStatus(persona.statusFile, { status: 'expired', by: 'run', run: runId, ...(x.at ? { at: x.at } : {}), detail: secrets.redactText(x.detail) }).catch((e: unknown) =>
        log('warn', `persona ${name}: its status could not be saved: ${errorMessage(e)}`),
      );
    }
  }

  /** Per-page tracks of multi-page scenes: their frames in time order, with their motion warnings. */
  private trackFramesOf(rt: Runtime): Map<string, FrameIndexEntry[]> {
    const { opts, capture, timeline, log } = this.run;
    const endT = this.run.endT;
    const frameRateLimit = this.frameRateLimit;
    const trackFrames = new Map<string, FrameIndexEntry[]>();
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
        : motionCapture({
            frameTimes: list.map((f) => f.t),
            samples: t.builder.cursor,
            minFps,
            effects: t.builder.cursorEffects,
            pageChanges: t.builder.pages.map((p) => p.t_start),
            held: t.builder.loading,
          });
      const cause = this.perfMachine ? choppyCause({ gpu: this.gpu, cpu: this.perfCpu, machine: this.perfMachine, seconds: endT, frameRateLimit }) : undefined;
      for (const message of motionWarnings(motion, minFps, `page ${id}: `, cause)) {
        timeline.warn(message);
        log('warn', message);
      }
    }
    return trackFrames;
  }

  /** capture.mp4 finished (the encoder fed during the take); what finishing it cost, null without one. */
  private async encodeMain(): Promise<{ finish_ms: number; late_frames: number } | null> {
    const r = this.run;
    const { emit, dir, record } = r;
    if (this.mainEncoder && this.frames.length === 0) {
      await this.mainEncoder.abort();
      this.mainEncoder = null;
    }
    const mainEncoder = this.mainEncoder;
    if (!mainEncoder) return null;
    const out = join(dir, 'capture.mp4');
    emit({ type: 'encode', status: 'start', message: `${this.frames.length} frames → ${out}` });
    try {
      await mainEncoder.finish(r.endT);
      record.capture = out;
      emit({ type: 'encode', status: 'done', message: out });
      return { finish_ms: mainEncoder.finishMs, late_frames: mainEncoder.late };
    } catch (e) {
      emit({ type: 'encode', status: 'done', message: `failed: ${errorMessage(e)}` });
      r.failure ??= e;
      return null;
    }
  }

  /** Each page track's video finished; the track `mainFromTrack` becomes capture.mp4 too. */
  private async encodeTracks(rt: Runtime, trackFrames: Map<string, FrameIndexEntry[]>, mainFromTrack: string | undefined): Promise<void> {
    const r = this.run;
    const { timeline, log, emit, dir, record } = r;
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
        await t.encoder.finish(r.endT);
        emit({ type: 'encode', status: 'done', message: out });
        if (mainFromTrack === id) {
          await copyFile(out, join(dir, 'capture.mp4'));
          record.capture = join(dir, 'capture.mp4');
          this.frames = list;
          log('info', `every scene films several pages: capture.mp4 is the track of page "${id}"`);
        }
      } catch (e) {
        emit({ type: 'encode', status: 'done', message: `failed: ${errorMessage(e)}` });
        r.failure ??= e;
      }
    }
  }

  /**
   * One picture per step of a capture (R-FLD-16, capture.step_shots): its frame at the end of the step — copied from the
   * kept frames, else read from the video (no frame written during the take). Nothing is taken during the take.
   */
  private stepPictures(rt: Runtime, trackFrames: Map<string, FrameIndexEntry[]>): Promise<string[]> {
    const { opts, capture, timeline, log, dir, screenshotsDir, framesDir, record } = this.run;
    const endT = this.run.endT;
    const frames = this.frames;
    const multi = new Set(timeline.scenes.filter((x) => x.pages !== undefined).map((x) => x.id));
    const trackOf = (ev: TimelineEvent) => {
      const page = multi.has(ev.scene) ? ev.page : undefined;
      return page ? rt.tracks.get(page) : undefined;
    };
    return capture.keep_frames
      ? stepShots(
          timeline.events,
          screenshotsDir,
          { dir: framesDir, frames },
          (ev) => {
            const t = trackOf(ev);
            const list = t ? trackFrames.get(t.builder.info.id) : undefined;
            return t && list?.length ? { dir: join(dir, t.builder.info.frames_file.replace(/\.jsonl$/, '')), frames: list } : null;
          },
          log,
        )
      : videoStepShots(timeline.events, {
          screenshotsDir,
          videoOf: (ev) => {
            const t = trackOf(ev);
            const file = t ? join(dir, t.builder.info.file) : record.capture;
            return file ? { video: file, count: Math.max(1, Math.round(endT * capture.fps)) } : null;
          },
          fps: capture.fps,
          ffmpeg: ffmpegBin(opts.policy, opts.ffmpeg),
          log,
        });
  }

  /** What the screen did after each click (R-FLD-23, R-FLD-26): slow transitions, waits the edit shortens. */
  private async transitions(): Promise<RunPerf['transitions']> {
    const { opts, capture, timeline, secrets, log } = this.run;
    const activity = this.activity;
    const multi = new Set(timeline.scenes.filter((x) => x.pages !== undefined).map((x) => x.id));
    const events = timeline.events.filter((e) => !multi.has(e.scene));
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
    const transitions = {
      measured: clicksOf(events).length,
      slow: slow.slice(0, 10).map((x) => ({ t: x.t, ms: x.ms, scene: x.scene, step: x.step, ...(x.target ? { target: secrets.redactText(x.target) } : {}) })),
    };
    if (slow.length) {
      log(
        'info',
        `slow transitions (click → stable screen over 0.8 s): ${slow
          .slice(0, 4)
          .map((x) => `${x.scene}.${x.step} ${(x.ms / 1000).toFixed(1)} s`)
          .join(', ')}${slow.length > 4 ? ', …' : ''}`,
      );
    }
    return transitions;
  }

  /** What the take cost (run.json `perf`): its CPU, machine, GPU, frames, stalls, transitions, encode and disk. */
  private async takePerf(perfMachine: RunPerf['machine'], transitions: RunPerf['transitions'], encodeDone: { finish_ms: number; late_frames: number } | null): Promise<RunPerf> {
    const { capture, timeline, log, dir, project } = this.run;
    const endT = this.run.endT;
    const { rt, recorder, frameRateLimit } = this;
    const frames = this.frames;
    const disk = await diskCheck(dir, project.slug);
    if (disk.warning) {
      timeline.warn(disk.warning);
      log('warn', disk.warning);
    }
    const st = recorder?.stats();
    const perfMotion = this.perfMotion;
    const livePreview = this.livePreview;
    const encoderKind = this.encoderKind;
    return {
      seconds: Math.round(endT * 100) / 100,
      ...(this.perfCpu ? { cpu: this.perfCpu } : {}),
      machine: perfMachine,
      ...(this.gpu ? { gpu: this.gpu } : {}),
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
  }

  async finish(): Promise<DriverTake> {
    const r = this.run;
    const { mode, capture, timeline, dir, screenshotsDir, record } = r;
    const { rt } = this;
    await this.saveExpiredSessions();
    const cancelled = r.failure !== null && isCancelled(r.failure);
    // Nothing of a run that landed on a sign-in page is kept: no frames, no video, no screenshot, no timeline (so
    // `render latest` never picks it); a preflight failure recorded nothing either.
    const discard = r.failure instanceof LoginPageError || r.failure instanceof PreflightError;
    if (discard) {
      this.frames = [];
      await discardCapture(dir, screenshotsDir);
      record.screenshots = [];
    }
    // The encoders fed during the take: nothing of a cancelled or discarded take is kept.
    const trackEncoders = [...(rt?.tracks.values() ?? [])].map((t) => t.encoder).filter((e): e is StreamEncoder => e !== null);
    if (cancelled || discard) {
      await Promise.all([this.mainEncoder, ...trackEncoders].map((e) => e?.abort()));
      this.mainEncoder = null;
    }
    // Per-page tracks of multi-page scenes: their frames, encoded on the same CFR grid as capture.mp4.
    const trackFrames = rt && mode === 'capture' && !discard ? this.trackFramesOf(rt) : new Map<string, FrameIndexEntry[]>();
    const allTrackFrames = [...trackFrames.values()].flat();
    // A scenario made only of multi-page scenes has no main capture of its own: capture.mp4 is its first page's track.
    const mainFromTrack = mode === 'capture' && this.frames.length === 0 && allTrackFrames.length > 0 ? [...trackFrames.keys()].find((k) => trackFrames.get(k)!.length > 0) : undefined;
    if (mode === 'capture' && !cancelled && !discard && r.failure === null && this.frames.length === 0 && !mainFromTrack) {
      // A capture without a single frame is a failed capture, never a "succeeded" run without capture.mp4.
      const why = timeline.warnings.find((w) => w.startsWith('screencast frames stay'));
      r.failure = new EncodeError(`the capture recorded no frame${why ? ` (${why}: every frame was dropped)` : ''}`);
    }
    const encodeDone = await this.encodeMain();
    if (rt && mode === 'capture' && !cancelled && !discard) await this.encodeTracks(rt, trackFrames, mainFromTrack);
    const frames = this.frames;
    if (rt && mode === 'capture' && capture.step_shots && !cancelled && !discard) record.screenshots = await this.stepPictures(rt, trackFrames);
    const transitions = record.capture && !mainFromTrack && this.activity.masks.length ? await this.transitions() : undefined;
    const perfMachine = this.perfMachine;
    if (mode === 'capture' && !cancelled && !discard && perfMachine) record.perf = await this.takePerf(perfMachine, transitions, encodeDone);
    return {
      discard,
      capture: {
        file: record.capture ? 'capture.mp4' : '',
        frames: frames.length,
        frameTimes: frames.map((f) => f.t),
        ...(allTrackFrames.length ? { idleFrameTimes: [...(mainFromTrack ? [] : frames), ...allTrackFrames].map((f) => f.t) } : {}),
        // capture.mp4 copied from a page's track has that page's size.
        ...(mainFromTrack && rt?.tracks.get(mainFromTrack) ? { size: { width: rt.tracks.get(mainFromTrack)!.viewport.width, height: rt.tracks.get(mainFromTrack)!.viewport.height } } : {}),
      },
    };
  }

  cleanupSync(): void {
    removeSessionCopiesSync();
  }
}
