/**
 * The capture driver of an iOS environment (runner-web's driver seam): the lifecycle's phases played on the iOS
 * Simulator. prepare — a Mac, a capture (no dry run yet), the app checked, Retake's device found or made and locked,
 * the driver built (once per Xcode), the device booted headless, the app installed. open — the driver started on the
 * device, the status bar set (the scenario clock's time, else 9:41), the app launched and in front before anything is
 * filmed. film — the screen recording started (capture time 0 when it says so), the scenes played. stop — the take's
 * end on the host clock, the recording finished. close — the driver stopped, the status bar cleared, the device shut
 * down if this run booted it, the lock released. finish — the touches timed from the video, the overlay burnt in,
 * capture.mp4 made at the device's pixels (402×874 pt at 3: 1206×2622).
 */
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileFacts, loadProjectTemplate, nodeFileFacts, programLookup } from '@retake/core/io';
import { policyProgram } from '@retake/core/policy';
import type { CaptureDevice } from '@retake/core/run';
import type { CaptureDriver, CaptureRun, CaptureTools, DriverFactory, DriverHooks, DriverTake, HookStepOutcome } from '@retake/runner-web/types';
import { installApp, resolveApp } from './app.js';
import type { RunApp } from './app.js';
import { DeviceLock, bootDevice, deviceScreen, findOrCreateDevice } from './device.js';
import type { DeviceScreen, RunDevice } from './device.js';
import { ensureDriver } from './driver-build.js';
import type { BuiltDriver } from './driver-build.js';
import { DriverSession } from './driver-session.js';
import type { Exec } from './proc.js';
import { procExec } from './proc.js';
import { ScreenRecording } from './record-video.js';
import { playScenes } from './scenes.js';
import { Simctl } from './simctl.js';
import type { IosStage } from './steps.js';
import { DEFAULT_RIPPLE, parseColor } from './touch-look.js';
import type { Rgba } from './touch-look.js';
import type { TouchRecord } from './touch-track.js';
import { finishTake } from './take.js';

/** What the driver starts programs with (the tests hand their own). */
export interface IosDriverDeps {
  exec: Exec;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
}

/** The status bar's time of a take: the scenario clock's, in its zone (H:MM, 12-hour as the US locale shows it), else 9:41. Pure. */
export function statusBarTime(clock: { epoch_ms: number; timezone?: string } | undefined): string {
  if (!clock) return '9:41';
  const parts = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, ...(clock.timezone ? { timeZone: clock.timezone } : {}) }).formatToParts(new Date(clock.epoch_ms));
  const h = parts.find((p) => p.type === 'hour')?.value ?? '9';
  const m = parts.find((p) => p.type === 'minute')?.value ?? '41';
  return `${h}:${m}`;
}

/** Whether a run shuts its device down at its end: only one it booted, unless RETAKE_IOS_KEEP_BOOTED=1. Pure. */
export function shutsDown(bootedHere: boolean, env: NodeJS.ProcessEnv): boolean {
  return bootedHere && env.RETAKE_IOS_KEEP_BOOTED !== '1';
}

class IosDriver implements CaptureDriver {
  private xcrun = 'xcrun';
  private plutil = 'plutil';
  private simctl: Simctl | null = null;
  private app: RunApp | null = null;
  private device: RunDevice | null = null;
  private screen: DeviceScreen | null = null;
  private lock: DeviceLock | null = null;
  private built: BuiltDriver | null = null;
  private bootedHere = false;
  private session: DriverSession | null = null;
  private recording: ScreenRecording | null = null;
  private recorded = false;
  /** The recording's start stamp and SIGINT (process.hrtime ns): its start's lateness (record-video.ts). */
  private stamps: { startedNs: bigint | null; stopNs: bigint | null } = { startedNs: null, stopNs: null };
  private statusBarSet = false;
  private hookStep: ((name: string) => Promise<HookStepOutcome>) | undefined;
  private readonly touches: TouchRecord[] = [];
  private readonly iosDir: string;

  constructor(
    private readonly run: CaptureRun,
    private readonly tools: CaptureTools,
    private readonly deps: IosDriverDeps,
  ) {
    this.iosDir = join(run.dir, '.ios');
  }

  private log(level: 'info' | 'warn' | 'debug', m: string): void {
    this.run.log(level, m);
  }

  /** A program of the machine under the work's policy (its real path), or the refusal. */
  private program(name: string): string {
    const r = policyProgram(this.run.opts.policy, name, name, programLookup());
    if (r.problem) throw this.tools.runnerError(r.problem);
    return r.program;
  }

  async prepare(): Promise<void> {
    const { run, tools, deps } = this;
    const ios = run.env.ios;
    if (!ios) throw tools.runnerError(`environment ${run.env.name} is no iOS environment`);
    if (deps.platform !== 'darwin') throw tools.runnerError(`environment ${run.env.name} films the iOS Simulator: it runs on a Mac with Xcode only`);
    if (run.mode !== 'capture') throw tools.runnerError(`a dry run is not available on iOS environment ${run.env.name} yet: run it as a capture`);
    if (run.opts.inspect) throw tools.runnerError(`an inspection is not available on iOS environment ${run.env.name}`);
    if (run.opts.pause) this.log('info', 'pausing a take is not available on an iOS environment: this take runs to its end');
    if (run.opts.live) this.log('info', 'the live picture is not available on an iOS environment: nothing is sent to it');
    this.xcrun = this.program('xcrun');
    this.plutil = this.program('plutil');
    const simctl = (this.simctl = new Simctl(deps.exec, this.xcrun, run.signal));
    try {
      this.app = await resolveApp(ios.app, { projectDir: run.project.dir, policy: run.opts.policy, files: nodeFileFacts, exec: deps.exec, plutil: this.plutil });
      const device = (this.device = await findOrCreateDevice(simctl, ios.device, (m) => this.log('info', m), undefined, run.signal));
      this.lock = DeviceLock.acquire(device.udid, `run ${run.runId}`, undefined, (m) => this.log('info', m));
      this.screen = await deviceScreen(deps.exec, this.plutil, device.type);
      this.built = await ensureDriver({ exec: deps.exec, xcrun: this.xcrun, log: (m) => this.log('info', m), signal: run.signal });
      // Told before a boot starts: one cut short is shut down at the end too.
      const booted = await bootDevice(
        simctl,
        device,
        (m) => this.log('info', m),
        () => (this.bootedHere = true),
      );
      this.bootedHere ||= booted;
      await installApp(simctl, device.udid, this.app);
      await mkdir(this.iosDir, { recursive: true });
    } catch (e) {
      if (tools.isCancelled(e) || run.signal.aborted) throw e;
      throw tools.runnerError(tools.errorMessage(e));
    }
  }

  identify(): void {
    // An iOS environment signs nobody in: no persona, no secret of its own.
  }

  async open(): Promise<void> {
    const { run, tools } = this;
    const device = this.device!;
    const simctl = this.simctl!;
    try {
      this.session = await DriverSession.start({
        exec: this.deps.exec,
        // Its stop terminates the runner and the app: never under the run's cancel.
        simctl: this.offCamera(),
        xcrun: this.xcrun,
        xctestrun: this.built!.xctestrun,
        derivedData: this.built!.derivedData,
        udid: device.udid,
        dir: this.iosDir,
        redact: (l) => run.secrets.redactText(l),
        log: (level, m) => this.log(level, m),
        signal: run.signal,
      });
      this.statusBarSet = true;
      await simctl.statusBar(device.udid, statusBarTime(run.runClock));
      const client = this.session.client;
      const launched = await client.cmd<{ state: string }>('launch', { bundleId: this.app!.bundleId }, 120_000);
      const state = launched.state === 'runningForeground' ? launched.state : (await client.cmd<{ state: string }>('activate', {}, 60_000)).state;
      if (state !== 'runningForeground') throw new Error(`the app ${this.app!.bundleId} did not come to the foreground (${state})`);
    } catch (e) {
      if (tools.isCancelled(e) || run.signal.aborted) throw e;
      throw tools.runnerError(tools.errorMessage(e));
    }
  }

  hooks(): DriverHooks {
    const name = this.run.env.name;
    return {
      evalInPage: async () => {
        throw this.tools.runnerError(`a js hook runs in a page: iOS environment ${name} has none`);
      },
    };
  }

  setHookSteps(run: (name: string) => Promise<HookStepOutcome>): void {
    this.hookStep = run;
  }

  private stage(): IosStage {
    const { run, tools } = this;
    const ios = run.env.ios!;
    const timeoutS = run.sc.defaults?.timeout_s ?? run.project.config.defaults?.timeout_s ?? 15;
    return {
      run,
      tools,
      client: this.session!.client,
      screen: { width: this.screen!.width, height: this.screen!.height },
      bundleId: this.app!.bundleId,
      schemes: ios.schemes ?? [],
      touches: this.touches,
      screenshot: (file) => this.simctl!.screenshot(this.device!.udid, file),
      ...(this.hookStep ? { hookStep: this.hookStep } : {}),
      timeoutS,
      warned: new Set(),
    };
  }

  async film(): Promise<void> {
    const { run } = this;
    const mov = join(this.iosDir, 'capture.mov');
    this.recording = await ScreenRecording.start({ exec: this.deps.exec, xcrun: this.xcrun, udid: this.device!.udid, mov, onStarted: () => run.startCapture() }).catch((e: unknown) => {
      throw this.tools.runnerError(this.tools.errorMessage(e));
    });
    this.recorded = true;
    this.stamps = { startedNs: this.recording.startedNs, stopNs: null };
    markFrameDefault(run);
    // One page segment: the app, from capture time 0 (no URL); the timeline stretches it to the end of the take.
    run.timeline.pages.push({ id: run.env.name, t_start: 0, t_end: 0 });
    await playScenes(this.stage());
  }

  async failed(e: unknown): Promise<unknown> {
    return e;
  }

  async stop(): Promise<void> {
    const r = this.run;
    r.endT = r.captureStarted ? r.clock.now() : 0;
    if (this.recording) {
      try {
        await this.recording.stop();
        this.stamps.stopNs = this.recording.stopNs;
      } catch (e) {
        r.failure ??= e;
        this.recorded = false;
      }
      this.recording = null;
    }
    r.stopFilming();
  }

  /** The simctl of the clean-up (the driver's stop, the status bar, the shutdown): never under the run's cancel. */
  private offCamera(): Simctl {
    return new Simctl(this.deps.exec, this.xcrun);
  }

  /**
   * Off camera: the driver stopped, the status bar cleared, the device shut down if this run booted it, the lock
   * released — each with its own time limit and never the run's cancel (a cancelled run still cleans up).
   */
  async close(): Promise<void> {
    const simctl = this.simctl ? this.offCamera() : null;
    const udid = this.device?.udid;
    await this.session?.stop(this.app?.bundleId);
    this.session = null;
    if (simctl && udid && this.statusBarSet) await simctl.clearStatusBar(udid).catch(() => undefined);
    if (simctl && udid && shutsDown(this.bootedHere, this.deps.env)) {
      await simctl.shutdown(udid).catch((e: unknown) => this.log('warn', `shutting the simulator down failed: ${this.tools.errorMessage(e)}`));
    }
    this.lock?.release();
    this.lock = null;
  }

  /** The ripple colour of the run's theme (its `cursor.ripple_color`: the scenario's theme, else the project's), else the default theme's. */
  private async rippleColor(): Promise<Rgba> {
    const { run } = this;
    if (run.opts.template) return parseColor(run.opts.template.template.cursor?.ripple_color) ?? DEFAULT_RIPPLE;
    try {
      const t = await loadProjectTemplate(run.project, run.sc.template, { files: fileFacts(run.opts.policy) });
      return parseColor(t.template.cursor?.ripple_color) ?? DEFAULT_RIPPLE;
    } catch {
      return DEFAULT_RIPPLE;
    }
  }

  async finish(): Promise<DriverTake> {
    const r = this.run;
    const { record, capture } = r;
    const screen = this.screen;
    const device: CaptureDevice | undefined =
      this.device && this.built ? { kind: 'ios', name: this.device.type.name, runtime: this.device.runtime.name, xcode: `${this.built.xcode.version} (${this.built.xcode.build})` } : undefined;
    const size = screen ? { width: screen.width, height: screen.height, scale: screen.scale } : undefined;
    const take: DriverTake = { discard: false, capture: { file: '', frames: 0, frameTimes: [], ...(size ? { size } : {}), ...(device ? { device } : {}) } };
    const cancelled = (r.failure !== null && this.tools.isCancelled(r.failure)) || r.signal.aborted;
    const mov = join(this.iosDir, 'capture.mov');
    const keepMov = this.deps.env.RETAKE_IOS_KEEP_RECORDING === '1';
    if (!this.recorded || !screen || cancelled || !r.captureStarted) {
      // Nothing to make of it (cancelled, its stop failed, nothing filmed): the recording goes (it holds what was typed).
      if (!keepMov) await rm(mov, { force: true }).catch(() => undefined);
      return take;
    }
    const out = join(r.dir, 'capture.mp4');
    r.emit({ type: 'encode', status: 'start', message: `the recording → ${out}` });
    try {
      const done = await finishTake({
        policy: r.opts.policy,
        mov,
        dir: this.iosDir,
        out,
        endT: r.endT,
        fps: capture.fps,
        crf: capture.crf,
        screen,
        touches: this.touches,
        burn: !r.opts.hideCursor,
        recording: this.stamps,
        ripple: await this.rippleColor(),
        timeline: r.timeline,
        log: (level, m) => this.log(level, m),
        signal: r.signal,
        keepMov,
      });
      record.capture = out;
      r.emit({ type: 'encode', status: 'done', message: out });
      this.log('debug', `iOS take: touch-down search ${done.ms.detect} ms, overlay ${done.ms.overlay} ms, encode ${done.ms.encode} ms`);
      return { ...take, capture: { ...take.capture, file: 'capture.mp4', frames: done.frames, frameTimes: done.frameTimes, idleFrameTimes: done.idleFrameTimes } };
    } catch (e) {
      // Cancelled while it was being made: the run is cancelled, not failed.
      const why = r.signal.aborted ? (this.tools.isCancelled(r.signal.reason) ? r.signal.reason : e) : e;
      r.emit({ type: 'encode', status: 'done', message: `${r.signal.aborted ? 'cancelled' : 'failed'}: ${this.tools.errorMessage(why)}` });
      r.failure ??= why;
      if (!keepMov) await rm(mov, { force: true }).catch(() => undefined);
      return take;
    }
  }

  cleanupSync(): void {
    this.recording?.killSync();
    this.session?.killSync();
    this.lock?.release();
  }
}

/** No frame written (the scenario's, the project's): the edit may frame the take as a phone (a written one is kept). */
export function markFrameDefault(run: Pick<CaptureRun, 'timeline' | 'sc' | 'project'>): void {
  const video = run.timeline.meta.video;
  if (video && run.sc.frame === undefined && run.project.config.frame_defaulted) video.frame_default = true;
}

/** The iOS driver factory over `deps` (the tests'), or the machine's (iosDriver). */
export function createIosDriver(deps: IosDriverDeps): DriverFactory {
  return (run, tools) => new IosDriver(run, tools, deps);
}

/** The driver of a run on an iOS environment. */
export const iosDriver: DriverFactory = (run, tools) => new IosDriver(run, tools, { exec: procExec, platform: process.platform, env: process.env });
