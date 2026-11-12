/**
 * The browser driver of a capture run (driver.ts): Chromium through Playwright, with the in-page kit — the environment's
 * pages probed, the write guard armed, the personas' sessions copied and checked off camera, the product's clock, the
 * runtime that plays the scenes, the prewarm, the recorders and their encoders fed during the take, the live picture,
 * the CPU sampler, the pause of a take, the inspection, the sign-in guard and the session check after a failure; after
 * the take, the recorders' frames, the encodes, the step pictures, what the screen did after each click and what the
 * take cost.
 */
import { copyFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page } from 'playwright-core';
import { compileWritePolicy, guardsWrites, isCaptureScene, loginCommand as defaultLoginCommand, pageOrigins, planPersonas, resolvePersonas, templateSceneEntry } from '@retake/core';
import { ffmpegBin, retakeHome } from '@retake/core/io';
import type { PersonaPlan, ResolvedPersona, RunPerf, RunPerfCpu, TimelineEvent } from '@retake/core';
import { snapshotMailbox } from '../actions/artefacts.js';
import { settleEffectChecks } from '../actions/effects.js';
import { projectBrowser } from '../config.js';
import { ActivityRecorder, analyzeActivity, clicksOf, slowTransitions } from '../activity.js';
import { LoginGuard, preflight, prepareSessions, removeSessionCopiesSync, writeStatus } from '../auth.js';
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
import { diagnoseSession, foreignSignIn, formatIssuePath, hookLanding, hookPersonaAuth, personaOf, personaOfKey, readOnlyGuard, signInGuard } from './browser-guards.js';
import type { CaptureDriver, CaptureRun, DriverTake } from './driver.js';
import type { DriverHooks } from './hooks.js';
import type { FilmingReport } from './options.js';
import { choppyCause, diskCheck, folderMB, motionWarnings, warnLimitedLoads } from './perf-words.js';
import { discardCapture, stepShots, videoStepShots } from './step-shots.js';
import type { WriteGuardOptions } from '../write-guard.js';

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
  /** The live picture (L4.4): on camera only, from capture time 0 to the start of `stop`. */
  private live: LivePreview | null = null;
  /** What watching the live picture cost (perf.live_preview). */
  private livePreview: { seconds: number; frames_sent: number } | null = null;
  private frames: FrameIndexEntry[] = [];
  // L5.7: capture.mp4 encoded during the take, what it showed after each click, what the take cost.
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
    // Sign-in details written in the environment's page URLs: the browser's HTTP credentials for that origin, masked
    // like a secret wherever the run writes (resolveEnvironment already took them out of the URLs).
    const httpCredentials = (this.httpCredentials = launchCredentials(project, env.name));
    if (httpCredentials?.password) secrets.addValue(httpCredentials.password);
    // L5.8 (R-FLD-33): every page of the environment answers before anything opens (a port that moved, a stopped server).
    const probes = await probePages(env.pages, { signal });
    const down = probes.filter((p) => !p.ok);
    if (down.length) {
      throw new RunnerError(preflightRefusal(env.name, down, env.sandbox ? { sandbox: `retake sandbox up ${project.slug} --env ${env.name}, or run with --sandbox` } : {}));
    }
    log('debug', `pages answer: ${probes.map((p) => `${p.keys.join('/')} HTTP ${p.status} (${p.ms} ms)`).join(', ')}`);
    // A read-only run stops the browser's writes (L1.7, write-guard.ts): armed in every browser at launch. Any run
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
    // Sessions & personas (L1.6): which persona films each page, each one's browser on a copy of its session, checked
    // off camera before anything runs — no setup hook, no recorder yet.
    this.personas = resolvePersonas(project, env.name, { home: retakeHome() });
    // A sandbox account's plain password (L1.8) is a secret as written: registered now, before anything this run writes
    // can hold it (the outline; autoLogin registers it again when its login runs).
    for (const p of this.personas) for (const v of p.secrets ?? []) secrets.addValue(v);
  }

  async open(): Promise<void> {
    const r = this.run;
    const { opts, project, env, sc, mode, capture, until, hooksMode, runId, secrets, timeline, template, log, emit, signal } = r;
    const personas = this.personas;
    const plan = planPersonas(sc, { env: env.name, envPages: env.pages, personas, until, hooks: hooksMode === 'run', ...(project.config.hooks ? { projectHooks: project.config.hooks } : {}) });
    if (plan.issues.length) throw new RunnerError(plan.issues.map((i) => `${formatIssuePath(i.path)}: ${i.message}`).join('\n'));
    this.planned = plan;
    const prepared = (this.prepared = await prepareSessions(personas.filter((p) => plan.used.includes(p.name)), { runId, log }));
    const realmOf = personaOf(plan, personas, env, () => this.rt);
    const writeGuard = this.writeGuard;
    const httpCredentials = this.httpCredentials;
    const session = (this.session = await BrowserSession.open({
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
    }));
    const chromium = await session.browserVersion();
    if (chromium) {
      r.record.engine = runEngine(chromium);
      void r.files.saveRecord();
    }
    if (mode === 'capture') {
      // L5.7: the encoder fed during the take, the GPU the capture renders with, a limiter turned off.
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
    // The product's clock (L1.7, R-ENV-05): after the preflight (a sign-in under a far clock may fail its token checks),
    // before the setup hooks; set back to its time at capture time 0 (anchorClock).
    const runClock = r.runClock;
    if (runClock) {
      await session.installClock(runClock);
      log('info', `clock: the product's browser reads ${runClock.at}${runClock.timezone ? ` (${runClock.timezone})` : ''} at capture time 0${runClock.freeze ? ' and never moves (freeze)' : ', then runs'}`);
    }
    const guard = (this.guard = signInGuard(project, env, personas, plan, () => this.session, {
      command: this.commandOf,
      hooksJustRan: () => r.record.steps_done === 0 && r.record.hooks.setup === 'ok',
      redact: (t) => secrets.redactText(t),
      abort: (e) => r.abort.abort(e),
    }));
    const rt = (this.rt = new Runtime({
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
      navigation: opts.hookTrust === 'mcp' ? { origins: pageOrigins(env.pages), envName: env.name, via: opts.hookVia ?? 'mcp' } : {},
      ...(opts.inspect ? { inspecting: true } : {}),
      // Step defaults (L5.6): the scenario's win over the project's.
      ...((sc.defaults?.timeout_s ?? project.config.defaults?.timeout_s) !== undefined ? { defaultTimeoutS: sc.defaults?.timeout_s ?? project.config.defaults?.timeout_s } : {}),
      log,
      guard,
      ...(prepared.length ? { plannedPersonas: plan.pages } : {}),
      ...(mode === 'capture' ? { encoderFor: (o: { out: string; width: number; height: number; horizon: () => number }) => this.newEncoder(o) } : {}),
    }));

    if (opts.hideCursor) log('info', 'capturing without the in-page cursor (raw export): its track, icon, presses and ripples are recorded as data');
    this.notifications = watchNotifications(rt);
    // wait_for_email takes only the messages that arrive during the run: remember those already there (before setup).
    if (r.readsMail) await snapshotMailbox(rt);
  }

  hooks(): DriverHooks {
    const { project, env, log, opts } = this.run;
    const session = this.session!;
    const loginLanding = hookLanding(this.guard, this.personas, env, session, this.commandOf, this.expire);
    const writeGuard = this.writeGuard;
    const writes = writeGuard ? { policy: writeGuard.policy, ...(writeGuard.onWrite ? { onWrite: writeGuard.onWrite } : {}) } : undefined;
    return {
      // js hooks run in a guarded tab of their own, kept for the run (hook-page.ts), never in a capture tab.
      evalInPage: (pageKey, code) =>
        evalHookInPage(session, { project, env, log, ...(loginLanding ? { loginLanding } : {}), ...(writes ? { writes } : {}) }, pageKey, code),
      personaAuth: hookPersonaAuth(this.personas, env, session, this.commandOf, opts.hookTrust === 'mcp'),
    };
  }

  setHookSteps(run: (name: string) => Promise<HookStepOutcome>): void {
    this.rt!.runHook = run;
  }

  async film(): Promise<void> {
    const r = this.run;
    const { opts, env, sc, mode, capture, until, timeline, clock, record, emit, log, signal, dir, framesDir, files } = r;
    const rt = this.rt!;
    const session = this.session!;
    const captured = sc.scenes.filter(isCaptureScene).filter((s) => !s.skip);
    const firstScene = captured[0];
    const firstPage = firstScene?.pages !== undefined ? undefined : (firstScene?.page ?? Object.keys(env.pages)[0]);
    if (firstScene?.pages === undefined && !firstPage) throw new RunnerError(`environment "${env.name}" declares no pages`);
    // L5.7 (R-FLD-27): every page the scenario opens, visited once off camera, so the take does not film it cold.
    if (mode === 'capture' && capture.prewarm) {
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
    // Capture time 0: right before the first page is shown and the screencast starts. The product's clock reads its
    // time now (L1.7), in every browser.
    await session.anchorClock();
    r.startCapture();
    if (opts.live) {
      this.live = new LivePreview({ sink: opts.live, page: () => rt.page, pageId: (p) => this.session?.idOf(p), width: capture.width, height: capture.height });
      this.live.start();
    }
    // A scenario whose first scene films several pages starts with their tracks (the main capture starts with the
    // first single-page scene, if any).
    if (firstPage) await rt.activate(firstPage);
    if (mode === 'capture' && captured.some((s) => s.pages === undefined)) {
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
      this.loadingWatch = new LoadingWatch(() => recorder.recordingPage ?? undefined, () => clock.now(), (p) => this.session?.idOf(p));
      this.loadingWatch.start();
    }
    if (mode === 'capture') {
      // What the take costs (R-FLD-23): Chromium's processes, the encoders, the product's local servers.
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
      this.sampler = s;
    }
    const pauser = opts.pause
      ? new RunPauser({
          gate: opts.pause,
          signal,
          record,
          emit,
          save: () => void files.saveRecord(),
          log,
          ...(r.filmingPause ? { filming: r.filmingPause } : {}),
          // A capture does not film the pause (L4.4): its recorders, clock and CPU sampler stop meanwhile (pause.ts).
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
              const ts = [timeline.cursorEffects, ...timeline.tracks.map((t) => t.cursorEffects)].flat().filter((e) => e.type === 'press' || e.type === 'ripple').map((e) => e.t);
              return ts.length ? Math.max(...ts) : null;
            },
            settleEffects: () => settleEffectChecks({ rt }),
            sampler: () => this.sampler,
            note: (p) => timeline.pauses.push(p),
          },
        })
      : null;
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
    // A step that failed because its page landed on a sign-in page reports the landing (L1.6).
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

  async stop(): Promise<void> {
    const r = this.run;
    const { opts, mode, capture, timeline, clock, log, env, secrets, signal } = r;
    const { rt, recorder, guard, session } = this;
    // Off camera from here (L4.4): the live picture stops before anything else (teardown, diagnosis, artefacts).
    await this.live?.stop().catch(() => undefined);
    // A capture filmed while someone watched its live picture says so (review A L4): the screencast's JPEG encoding ran
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
    // Off camera (L5.14): heavy work held for this take may go on (teardown, diagnosis and artefacts are not filming).
    const beside: FilmingReport | undefined = r.stopFilming();
    if (this.loadingWatch) {
      const spans = this.loadingWatch.stop();
      if (spans.length) timeline.loading_ui = spans;
    }
    const sampler = this.sampler;
    if (sampler) {
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
    if (recorder) {
      const minFps = Math.min(capture.fps, 30) * 0.6;
      // Without the drawn cursor a move changes nothing on screen: the frame rate during moves cannot be judged.
      const motion = opts.hideCursor
        ? null
        : motionCapture(this.frames.map((f) => f.t), timeline.cursor, minFps, timeline.cursorEffects, timeline.pages.map((p) => p.t_start), timeline.loading);
      timeline.stalls = (motion?.stalls ?? []).map((x) => ({ t_start: x.t, t_end: x.t_end, during: x.during }));
      const cause = this.perfMachine ? choppyCause({ gpu: this.gpu, cpu: this.perfCpu, machine: this.perfMachine, seconds: endT, frameRateLimit: this.frameRateLimit }) : undefined;
      for (const message of motionWarnings(motion, minFps, '', cause)) {
        timeline.warn(message);
        log('warn', message);
      }
      this.perfMotion = motion;
    }
    // A landing seen while the run was ending (after a step failed, or a cancel): nothing of the capture is kept either.
    if (guard?.error) r.failure = guard.error;
    // A step failure on a persona's page: was it the session? One check, off camera, now that nothing is filmed (L1.6).
    if (r.failure instanceof StepFailure && session && this.prepared.length) r.failure = await diagnoseSession(r.failure, session, rt, this.prepared, env.pages, secrets, this.commandOf, signal, this.expire);
  }

  async close(): Promise<void> {
    const r = this.run;
    const { rt } = this;
    const failure = r.failure;
    await this.notifications?.settled().catch(() => undefined);
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

  async finish(): Promise<DriverTake> {
    const r = this.run;
    const { opts, mode, capture, timeline, env, secrets, log, emit, dir, screenshotsDir, framesDir, record, runId, project } = r;
    const { rt, guard, recorder, personas, prepared, planned, frameRateLimit } = this;
    const endT = r.endT;
    // The session of a persona whose page landed on its own sign-in page expired during the run (L1.6).
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
    const cancelled = r.failure !== null && isCancelled(r.failure);
    // Nothing of a run that landed on a sign-in page is kept (L1.6): no frames, no video, no screenshot, no timeline (so
    // `render latest` never picks it); a preflight failure recorded nothing either.
    const discard = r.failure instanceof LoginPageError || r.failure instanceof PreflightError;
    if (discard) {
      this.frames = [];
      await discardCapture(dir, screenshotsDir);
      record.screenshots = [];
    }
    // The encoders fed during the take (L5.7): nothing of a cancelled or discarded take is kept.
    const trackEncoders = [...(rt?.tracks.values() ?? [])].map((t) => t.encoder).filter((e): e is StreamEncoder => e !== null);
    if (cancelled || discard) {
      await Promise.all([this.mainEncoder, ...trackEncoders].map((e) => e?.abort()));
      this.mainEncoder = null;
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
        const cause = this.perfMachine ? choppyCause({ gpu: this.gpu, cpu: this.perfCpu, machine: this.perfMachine, seconds: endT, frameRateLimit }) : undefined;
        for (const message of motionWarnings(motion, minFps, `page ${id}: `, cause)) {
          timeline.warn(message);
          log('warn', message);
        }
      }
    }
    const allTrackFrames = [...trackFrames.values()].flat();
    // A scenario made only of multi-page scenes has no main capture of its own: capture.mp4 is its first page's track.
    const mainFromTrack = mode === 'capture' && this.frames.length === 0 && allTrackFrames.length > 0 ? [...trackFrames.keys()].find((k) => trackFrames.get(k)!.length > 0) : undefined;
    if (mode === 'capture' && !cancelled && !discard && r.failure === null && this.frames.length === 0 && !mainFromTrack) {
      // A capture without a single frame is a failed capture, never a "succeeded" run without capture.mp4.
      const why = timeline.warnings.find((w) => w.startsWith('screencast frames stay'));
      r.failure = new EncodeError(`the capture recorded no frame${why ? ` (${why}: every frame was dropped)` : ''}`);
    }
    let encodeDone: { finish_ms: number; late_frames: number } | null = null;
    if (this.mainEncoder && this.frames.length === 0) {
      await this.mainEncoder.abort();
      this.mainEncoder = null;
    }
    const mainEncoder = this.mainEncoder;
    if (mainEncoder) {
      const out = join(dir, 'capture.mp4');
      emit({ type: 'encode', status: 'start', message: `${this.frames.length} frames → ${out}` });
      try {
        await mainEncoder.finish(endT);
        record.capture = out;
        encodeDone = { finish_ms: mainEncoder.finishMs, late_frames: mainEncoder.late };
        emit({ type: 'encode', status: 'done', message: out });
      } catch (e) {
        emit({ type: 'encode', status: 'done', message: `failed: ${errorMessage(e)}` });
        r.failure ??= e;
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
            this.frames = list;
            log('info', `every scene films several pages: capture.mp4 is the track of page "${id}"`);
          }
        } catch (e) {
          emit({ type: 'encode', status: 'done', message: `failed: ${errorMessage(e)}` });
          r.failure ??= e;
        }
      }
    }
    const frames = this.frames;
    // One picture per step of a capture (R-FLD-16, capture.step_shots): its frame at the end of the step — copied from the
    // kept frames, else read from the video (L5.7: no frame written during the take). Nothing is taken during the take.
    if (rt && mode === 'capture' && capture.step_shots && !cancelled && !discard) {
      const multi = new Set(timeline.scenes.filter((x) => x.pages !== undefined).map((x) => x.id));
      const trackOf = (ev: TimelineEvent) => {
        const page = multi.has(ev.scene) ? ev.page : undefined;
        return page ? rt.tracks.get(page) : undefined;
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
          }, capture.fps, ffmpegBin(opts.policy, opts.ffmpeg), log);
    }
    // What the screen did after each click (R-FLD-23, R-FLD-26): slow transitions, waits the edit shortens.
    let transitions: RunPerf['transitions'];
    const activity = this.activity;
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
    const perfMachine = this.perfMachine;
    if (mode === 'capture' && !cancelled && !discard && perfMachine) {
      const disk = await diskCheck(dir, project.slug);
      if (disk.warning) {
        timeline.warn(disk.warning);
        log('warn', disk.warning);
      }
      const st = recorder?.stats();
      const perfMotion = this.perfMotion;
      const livePreview = this.livePreview;
      const encoderKind = this.encoderKind;
      const perf: RunPerf = {
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
      record.perf = perf;
    }
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
