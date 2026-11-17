/**
 * The XCUITest driver running on the run's device: `xcodebuild test-without-building` of the built driver
 * (driver-build.ts) on the device, with a port of 127.0.0.1 and a token of its own (random, 32 bytes) handed to the
 * test runner (TEST_RUNNER_RETAKE_DRIVER_PORT / _TOKEN), its result bundle in the run's `.ios/` (deleted at the end:
 * it holds what was typed), no diagnostics, no parallel testing, no test time limit. xcodebuild's output goes to
 * `.ios/xcodebuild.log`, the run's secrets masked. Ready when `/status` answers (up to two minutes: a new device
 * installs and launches the runner first) with the proof that it holds the token (driver-client.ts); a port taken
 * meanwhile is retried once on another. The driver quits by itself after DRIVER_IDLE_S without a command (a host that
 * died leaves nothing running); while the run waits (a long hold, a hook), a `ping` keeps it up every KEEPALIVE_MS.
 * Stopped by the `quit` command, then SIGTERM and SIGKILL to xcodebuild's process group, then the runner and the app
 * terminated — none of it under the run's cancel: a cancelled run still cleans up.
 */
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { DriverClient } from './driver-client.js';
import { DRIVER_RUNNER_BUNDLE_ID } from './driver-build.js';
import type { Exec, ProcHandle } from './proc.js';
import type { Simctl } from './simctl.js';

/** How long the driver gets to answer /status after xcodebuild starts (a new device: about 50 s). */
export const DRIVER_READY_MS = 120_000;

/** The driver quits by itself after this long without a command (s). */
export const DRIVER_IDLE_S = 120;
/** How often the host pings a driver it has sent nothing for (ms). */
export const KEEPALIVE_MS = 30_000;

/** The line xcodebuild prints when XCUITest's interruption monitor dismissed a system alert (it taps Cancel). */
export const INTERRUPTION_LINE = /Found \d+ interrupting element/;

/** A free TCP port of 127.0.0.1 (the system's choice). */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error('no free port'))));
    });
  });
}

/** The arguments of the driver's run on a device. Pure. */
export function testArgs(o: { xctestrun: string; udid: string; resultBundle: string; derivedData: string }): string[] {
  return [
    'xcodebuild',
    'test-without-building',
    '-xctestrun',
    o.xctestrun,
    '-destination',
    `id=${o.udid}`,
    '-resultBundlePath',
    o.resultBundle,
    '-collect-test-diagnostics',
    'never',
    '-parallel-testing-enabled',
    'NO',
    '-test-timeouts-enabled',
    'NO',
    '-derivedDataPath',
    o.derivedData,
  ];
}

export interface DriverSessionOptions {
  exec: Exec;
  /** The stop's simctl (terminating the runner and the app): one without the run's cancel. */
  simctl: Simctl;
  xcrun: string;
  xctestrun: string;
  derivedData: string;
  udid: string;
  /** The run's `.ios/` folder (log and result bundle). */
  dir: string;
  /** The run's secrets masked in the log. */
  redact: (line: string) => string;
  log: (level: 'info' | 'warn' | 'debug', m: string) => void;
  signal?: AbortSignal;
  /** How long /status may take (default DRIVER_READY_MS). */
  readyMs?: number;
  /** A port to use first (default: a free one). */
  port?: () => Promise<number>;
  /** The driver's idle limit (s, default DRIVER_IDLE_S) and the host's ping period (ms, default KEEPALIVE_MS). */
  idleS?: number;
  keepaliveMs?: number;
}

/** The driver running on the device: its client, and how it stops. */
export class DriverSession {
  private proc: ProcHandle | null = null;
  private interrupted = false;
  private keepalive: NodeJS.Timeout | null = null;
  private constructor(
    private readonly o: DriverSessionOptions,
    readonly client: DriverClient,
    private readonly resultBundle: string,
  ) {}

  /** Start the driver on the device and wait until it answers; a port taken is retried once on another. */
  static async start(o: DriverSessionOptions): Promise<DriverSession> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      const s = await DriverSession.launch(o, attempt);
      try {
        await s.waitReady();
        s.keepAlive();
        return s;
      } catch (e) {
        lastError = e;
        await s.stop();
        if (o.signal?.aborted || !(e instanceof PortTaken)) throw e;
        o.log('info', 'the iOS driver could not listen on its port: retrying on another');
      }
    }
    throw lastError;
  }

  private static async launch(o: DriverSessionOptions, attempt: number): Promise<DriverSession> {
    const port = await (o.port ?? freePort)();
    const token = randomBytes(32).toString('hex');
    const resultBundle = join(o.dir, `driver-${attempt}.xcresult`);
    await rm(resultBundle, { recursive: true, force: true });
    const client = new DriverClient({ port, token, ...(o.signal ? { signal: o.signal } : {}) });
    const s = new DriverSession(o, client, resultBundle);
    s.proc = o.exec.start(o.xcrun, testArgs({ xctestrun: o.xctestrun, udid: o.udid, resultBundle, derivedData: o.derivedData }), {
      env: {
        ...process.env,
        TEST_RUNNER_RETAKE_DRIVER_PORT: String(port),
        TEST_RUNNER_RETAKE_DRIVER_TOKEN: token,
        TEST_RUNNER_RETAKE_DRIVER_IDLE_S: String(o.idleS ?? DRIVER_IDLE_S),
      },
      logFile: join(o.dir, 'xcodebuild.log'),
      redact: o.redact,
      onLine: (line) => s.onLine(line),
    });
    return s;
  }

  private listenerFailed = false;

  private onLine(line: string): void {
    if (/retake-driver: listener failed/.test(line)) this.listenerFailed = true;
    if (!this.interrupted && INTERRUPTION_LINE.test(line)) {
      this.interrupted = true;
      this.o.log('warn', 'XCUITest dismissed a system alert during the take (it taps Cancel on alerts it meets): a permission prompt of the app may have been denied — see .ios/xcodebuild.log');
    }
  }

  /** XCUITest dismissed a system alert during the run. */
  get alertDismissed(): boolean {
    return this.interrupted;
  }

  private async waitReady(): Promise<void> {
    const limit = this.o.readyMs ?? DRIVER_READY_MS;
    const t0 = Date.now();
    let told = t0;
    while (Date.now() - t0 < limit) {
      if (this.o.signal?.aborted) throw this.o.signal.reason ?? new Error('cancelled');
      if (await this.client.status(1000)) {
        this.o.log('debug', `iOS driver ready in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
        return;
      }
      if (this.proc?.done) {
        const r = await this.proc.exited;
        if (this.listenerFailed) throw new PortTaken();
        throw new Error(`the iOS driver stopped before it answered (xcodebuild exit ${r.code ?? r.signal}): see .ios/xcodebuild.log of the run`);
      }
      if (Date.now() - told > 15_000) {
        told = Date.now();
        this.o.log('info', `waiting for the iOS driver on the simulator (${Math.round((told - t0) / 1000)} s; a new simulator takes about a minute)`);
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`the iOS driver did not answer within ${limit / 1000} s: see .ios/xcodebuild.log of the run`);
  }

  /** A ping whenever nothing was sent to the driver for the ping period (it would quit after its idle limit). */
  private keepAlive(): void {
    const every = this.o.keepaliveMs ?? KEEPALIVE_MS;
    this.keepalive = setInterval(() => {
      if (Date.now() - this.client.lastSent < every * 0.9) return;
      this.client.cmd('ping', {}, 10_000).catch(() => undefined);
    }, every);
    this.keepalive.unref();
  }

  /**
   * Stop the driver: `quit`, then SIGTERM and SIGKILL to xcodebuild's group; the runner and `bundleId` (the app)
   * terminated on the device; the result bundle deleted. Never throws; never under the run's cancel.
   */
  async stop(bundleId?: string): Promise<void> {
    if (this.keepalive) clearInterval(this.keepalive);
    this.keepalive = null;
    const proc = this.proc;
    if (proc && !proc.done) {
      await this.client.cmd('quit', {}, 3000, { uncancelled: true }).catch(() => undefined);
      if (!(await settles(proc.exited, 5000))) {
        proc.signal('SIGTERM');
        if (!(await settles(proc.exited, 3000))) {
          proc.signal('SIGKILL');
          await settles(proc.exited, 3000);
        }
      }
    }
    await this.o.simctl.terminate(this.o.udid, DRIVER_RUNNER_BUNDLE_ID).catch(() => undefined);
    if (bundleId) await this.o.simctl.terminate(this.o.udid, bundleId).catch(() => undefined);
    await rm(this.resultBundle, { recursive: true, force: true }).catch(() => undefined);
  }

  /** Synchronously: xcodebuild's group killed (a second signal before the process quits). */
  killSync(): void {
    if (this.keepalive) clearInterval(this.keepalive);
    if (this.proc && !this.proc.done) this.proc.signal('SIGKILL');
  }
}

/** The driver's test failed at once: its listener could not bind its port. */
class PortTaken extends Error {
  constructor() {
    super('the iOS driver could not listen on its port');
  }
}

/** Whether `p` settles within `ms`. */
async function settles(p: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const t = new Promise<false>((r) => {
    timer = setTimeout(() => r(false), ms);
  });
  const r = await Promise.race([p.then(() => true as const), t]);
  if (timer) clearTimeout(timer);
  return r;
}
