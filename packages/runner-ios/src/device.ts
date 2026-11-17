/**
 * The simulator a run films on: Retake's own device of the environment's device type, never one of the person's —
 * found by its ASCII name ("Retake - iPhone 17 Pro - iOS 26.5") in the default device set (xcodebuild reaches no other
 * set), made on first use (under a lock of its name: two runs never make two), set to US English and a QWERTY keyboard
 * whenever its own preferences say otherwise (a new device takes the Mac's language; checked at each boot, so a device
 * whose first run stopped early is set too), booted headless (Simulator.app never opens), and shut down at the end only
 * when this run booted it (or may have: a boot cut short counts). A run holds the device's lock (one take per device
 * at a time) from its boot to its end; the locks are the machine's, per user (core iosDeviceLockDir), not a Retake
 * home's. Its screen's size comes from the device type's profile.plist.
 */
import { join } from 'node:path';
import { breakStale, createExclusive, describeLock, iosDeviceLockDir, lockAlive, readLock } from '@retake/core/io';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import type { Exec } from './proc.js';
import { procProblem } from './proc.js';
import type { SimDeviceType, SimRuntime, Simctl } from './simctl.js';
import { deviceTypeNamed, newestRuntimeFor, retakeDeviceName } from './simctl.js';

/** The device a run films on. */
export interface RunDevice {
  udid: string;
  name: string;
  type: SimDeviceType;
  runtime: SimRuntime;
  /** This run made it (first use of this device type and runtime). */
  created: boolean;
}

/** The screen of a device type: points and pixels per point. */
export interface DeviceScreen {
  width: number;
  height: number;
  scale: number;
}

/** The device's own preferences a new device gets (inside the device only, never the Mac's). */
export const DEVICE_DEFAULTS: ReadonlyArray<{ key: string; value: readonly string[] }> = [
  { key: 'AppleLanguages', value: ['-array', 'en-US'] },
  { key: 'AppleLocale', value: ['en_US'] },
  { key: 'AppleKeyboards', value: ['-array', 'en_US@sw=QWERTY;hw=Automatic', 'emoji@sw=Emoji'] },
];

/** The device's language that says its preferences are set (AppleLocale). */
export const DEVICE_LOCALE = 'en_US';

/**
 * Retake's device of the type named `typeName` on the newest iOS runtime that runs it: found, or made — the finding and
 * the making under a lock of its name (`lockDir`: the machine's simulator locks).
 */
export async function findOrCreateDevice(simctl: Simctl, typeName: string, log: (m: string) => void, lockDir?: string, signal?: AbortSignal): Promise<RunDevice> {
  const types = await simctl.deviceTypes();
  const type = deviceTypeNamed(types, typeName);
  if (!type) {
    const phones = types.filter((t) => t.productFamily === 'iPhone' || /^iPhone/.test(t.name)).map((t) => t.name);
    throw new Error(`device "${typeName}" is not a simulator device type of this Xcode (iPhones: ${phones.slice(-8).join(', ') || 'none'}) — see xcrun simctl list devicetypes`);
  }
  const runtime = newestRuntimeFor(await simctl.runtimes(), type.identifier);
  if (!runtime) throw new Error(`no installed iOS runtime runs "${type.name}": install one in Xcode (Settings → Components)`);
  const name = retakeDeviceName(type.name, runtime.name);
  const find = async () => (await simctl.devices()).find((d) => d.name === name && d.runtime === runtime.identifier && d.isAvailable);
  const seen = await find();
  if (seen) return { udid: seen.udid, name, type, runtime, created: false };
  const lock = await waitForLock(`make-${name.replace(/[^A-Za-z0-9.-]+/g, '_')}`, `making the simulator ${name}`, lockDir ?? iosDeviceLockDir(), { signal });
  try {
    // Made by another run while this one waited.
    const found = await find();
    if (found) return { udid: found.udid, name, type, runtime, created: false };
    log(`creating the simulator "${name}" (once: it is Retake's own device, delete it with xcrun simctl delete "${name}")`);
    const udid = await simctl.create(name, type.identifier, runtime.identifier);
    return { udid, name, type, runtime, created: true };
  } finally {
    lock.release();
  }
}

/**
 * The device booted, headless, with US English and QWERTY (read from its own preferences each time: set, then booted
 * again, when they say otherwise); true when this call booted it (the run shuts it down at its end then).
 * `onBooting` is told before a boot starts: a boot cut short (a cancel, a failure) still counts as this run's.
 */
export async function bootDevice(simctl: Simctl, dev: RunDevice, log: (m: string) => void, onBooting: () => void = () => undefined): Promise<boolean> {
  const state = (await simctl.devices()).find((d) => d.udid === dev.udid)?.state ?? 'Shutdown';
  let booted = false;
  if (state !== 'Booted') {
    log(dev.created ? 'booting the new simulator (its first boot takes about a minute)' : `booting the simulator "${dev.name}"`);
    onBooting();
    await simctl.boot(dev.udid);
    booted = true;
  }
  await simctl.bootStatus(dev.udid);
  const locale = await simctl.readGlobalDefault(dev.udid, 'AppleLocale');
  if (locale !== DEVICE_LOCALE) {
    log(`setting the simulator to US English and a QWERTY keyboard (it said ${locale ?? 'nothing'}), then booting it again`);
    for (const d of DEVICE_DEFAULTS) await simctl.writeGlobalDefault(dev.udid, d.key, d.value);
    onBooting();
    await simctl.shutdown(dev.udid);
    await simctl.boot(dev.udid);
    await simctl.bootStatus(dev.udid);
    booted = true;
  }
  return booted;
}

/** The screen of a device type from its profile.plist (plutil), or the error. */
export async function deviceScreen(exec: Exec, plutil: string, type: SimDeviceType): Promise<DeviceScreen> {
  const file = join(type.bundlePath, 'Contents', 'Resources', 'profile.plist');
  const r = await exec.run(plutil, ['-convert', 'json', '-o', '-', file], { timeoutMs: 15_000 });
  const problem = procProblem(r, 'plutil');
  if (problem) throw new Error(`the screen of "${type.name}" could not be read (${file}): ${problem}`);
  return screenOfProfile(r.stdout, type.name);
}

/** The screen of a profile.plist as JSON: its pixels divided by its scale. Pure. */
export function screenOfProfile(json: string, name: string): DeviceScreen {
  let p: Record<string, unknown>;
  try {
    p = JSON.parse(json) as Record<string, unknown>;
  } catch {
    throw new Error(`the profile of "${name}" is no JSON`);
  }
  const w = Number(p.mainScreenWidth);
  const h = Number(p.mainScreenHeight);
  const s = Number(p.mainScreenScale);
  if (!(w > 0 && h > 0 && s > 0)) throw new Error(`the profile of "${name}" gives no screen size`);
  return { width: Math.round(w / s), height: Math.round(h / s), scale: s };
}

/** A lock another live process holds (the only refusal worth waiting out). */
export class LockBusy extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LockBusy';
  }
}

/**
 * A lock of `dir` named `name`, waited for while another live process holds it (up to `o.untilMs`, default 15
 * minutes); any other failure (the folder cannot be written…) is thrown at once.
 */
export async function waitForLock(name: string, what: string, dir: string, o: { signal?: AbortSignal; untilMs?: number } = {}): Promise<DeviceLock> {
  const until = Date.now() + (o.untilMs ?? 15 * 60_000);
  for (;;) {
    try {
      return DeviceLock.acquire(name, what, dir);
    } catch (e) {
      if (!(e instanceof LockBusy) || Date.now() > until || o.signal?.aborted) throw e;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

/** One take per device at a time: a lock file per device udid among the machine's simulator locks. */
export class DeviceLock {
  private released = false;
  private readonly onExit = () => this.release();

  private constructor(
    readonly file: string,
    private readonly since: string,
  ) {
    process.once('exit', this.onExit);
  }

  /** The lock of device `udid` for `what` (a run); throws when a live process holds it. */
  static acquire(udid: string, what: string, dir: string = iosDeviceLockDir(), note?: (m: string) => void): DeviceLock {
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${udid}.lock`);
    const since = new Date().toISOString();
    const text = JSON.stringify({ pid: process.pid, command: what, since }, null, 2);
    for (let tries = 0; tries < 50; tries++) {
      if (createExclusive(file, text)) return new DeviceLock(file, since);
      let seen: string;
      try {
        seen = readFileSync(file, 'utf8');
      } catch {
        continue; // released meanwhile
      }
      const held = readLock(file);
      if (held && lockAlive(held)) throw new LockBusy(`the simulator is in use by ${describeLock(held)} — wait for that take to end`);
      if (breakStale(file, seen)) note?.('removed a stale lock of the simulator');
    }
    throw new Error(`the simulator's lock (${file}) keeps changing — try again`);
  }

  /** Still held by this process. */
  get held(): boolean {
    if (this.released) return false;
    const rec = readLock(this.file);
    return rec !== null && rec.pid === process.pid && rec.since === this.since;
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    process.off('exit', this.onExit);
    const rec = readLock(this.file);
    if (rec && rec.pid === process.pid && rec.since === this.since) rmSync(this.file, { force: true });
  }
}
