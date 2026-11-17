/**
 * Retake's own simulator (src/device.ts) through a fake `xcrun simctl`: found by its name or made on the newest
 * runtime (made once under a lock of its name, however many runs ask at once), set to US English and QWERTY then
 * booted again whenever its own preferences say otherwise (read each time, not trusted to its first run), a booted one
 * left booted (and never shut down by the run), one this run booted — or began to boot — shut down at its end; one
 * take per device at a time (its lock); a lock is waited for only while another process holds it.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { DEVICE_DEFAULTS, DeviceLock, LockBusy, bootDevice, findOrCreateDevice, waitForLock } from '../src/device.js';
import { shutsDown } from '../src/ios-driver.js';
import type { Exec, ProcResult } from '../src/proc.js';
import { Simctl } from '../src/simctl.js';

const dir = mkdtempSync(join(tmpdir(), 'retake-device-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const TYPE = 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro';
const RUNTIME = 'com.apple.CoreSimulator.SimRuntime.iOS-26-5';
const NAME = 'Retake - iPhone 17 Pro - iOS 26.5';
const UDID = '0E0E0E0E-0000-4000-8000-00000000000A';

/** A fake simctl with one device of `state` (or none) whose AppleLocale is `o.locale` (none: unset), recording every command. */
function fakeSimctl(device: { state: string } | null, o: { locale?: string; bootFails?: boolean; createMs?: number } = {}) {
  const calls: string[] = [];
  const ok = (stdout = ''): ProcResult => ({ code: 0, signal: null, stdout, stderr: '' });
  let made = false;
  const exec: Exec = {
    run: async (_p, args) => {
      const a = args.slice(1).join(' ');
      calls.push(a);
      if (a === `spawn ${UDID} defaults read -g AppleLocale`) return o.locale ? ok(`${o.locale}\n`) : { code: 1, signal: null, stdout: '', stderr: 'does not exist' };
      if (a.startsWith('boot ') && o.bootFails) return { code: 1, signal: null, stdout: '', stderr: 'boot failed' };
      if (a === 'list devicetypes -j') return ok(JSON.stringify({ devicetypes: [{ name: 'iPhone 17 Pro', identifier: TYPE, bundlePath: '/p', productFamily: 'iPhone' }] }));
      if (a === 'list runtimes -j')
        return ok(JSON.stringify({ runtimes: [{ name: 'iOS 26.5', identifier: RUNTIME, version: '26.5', platform: 'iOS', isAvailable: true, supportedDeviceTypes: [{ identifier: TYPE }] }] }));
      if (a === 'list devices -j') return ok(JSON.stringify({ devices: { [RUNTIME]: device || made ? [{ udid: UDID, name: NAME, state: device?.state ?? 'Shutdown', isAvailable: true }] : [] } }));
      if (a.startsWith('create ')) {
        await new Promise((r) => setTimeout(r, o.createMs ?? 0));
        made = true;
        return ok(`${UDID}\n`);
      }
      return ok();
    },
    start: () => {
      throw new Error('not here');
    },
  };
  return { calls, simctl: new Simctl(exec, 'xcrun') };
}

describe("Retake's simulator", () => {
  it('made on first use (newest runtime), set to US English and QWERTY, booted twice; the run shuts it down', async () => {
    const { calls, simctl } = fakeSimctl(null);
    const dev = await findOrCreateDevice(simctl, 'iPhone 17 Pro', () => undefined, dir);
    expect(dev).toMatchObject({ udid: UDID, name: NAME, created: true });
    expect(calls).toContain(`create ${NAME} ${TYPE} ${RUNTIME}`);
    calls.length = 0;
    expect(await bootDevice(simctl, dev, () => undefined)).toBe(true);
    expect(calls.filter((c) => c.startsWith('boot ')).length).toBe(2);
    for (const d of DEVICE_DEFAULTS) expect(calls).toContain(`spawn ${UDID} defaults write -g ${d.key} ${d.value.join(' ')}`);
    expect(calls).toContain(`spawn ${UDID} defaults write -g AppleKeyboards -array en_US@sw=QWERTY;hw=Automatic emoji@sw=Emoji`);
    expect(calls.indexOf(`shutdown ${UDID}`)).toBeGreaterThan(calls.findIndex((c) => c.includes('AppleLocale')));
    expect(shutsDown(true, {})).toBe(true);
  });

  it('a booted device is left booted: no boot, never shut down at the end; a shut one is booted and shut down', async () => {
    const booted = fakeSimctl({ state: 'Booted' }, { locale: 'en_US' });
    const dev = await findOrCreateDevice(booted.simctl, 'iPhone 17 Pro', () => undefined, dir);
    expect(dev.created).toBe(false);
    expect(await bootDevice(booted.simctl, dev, () => undefined)).toBe(false);
    expect(booted.calls.some((c) => c.startsWith('boot ') || c.startsWith('shutdown ') || c.includes('defaults write'))).toBe(false);
    expect(shutsDown(false, {})).toBe(false);
    const shut = fakeSimctl({ state: 'Shutdown' }, { locale: 'en_US' });
    expect(await bootDevice(shut.simctl, dev, () => undefined)).toBe(true);
    expect(shut.calls).toContain(`boot ${UDID}`);
    expect(shutsDown(true, { RETAKE_IOS_KEEP_BOOTED: '1' })).toBe(false);
  });

  it('a device found but not set (its first run stopped early, or made by hand): its own preferences say so, it is set and booted again', async () => {
    const { calls, simctl } = fakeSimctl({ state: 'Booted' }, { locale: 'fr_FR' });
    const dev = await findOrCreateDevice(simctl, 'iPhone 17 Pro', () => undefined, dir);
    expect(dev.created).toBe(false);
    expect(await bootDevice(simctl, dev, () => undefined)).toBe(true);
    for (const d of DEVICE_DEFAULTS) expect(calls).toContain(`spawn ${UDID} defaults write -g ${d.key} ${d.value.join(' ')}`);
    expect(calls.filter((c) => c.startsWith('boot ')).length).toBe(1);
  });

  it("a boot cut short still counts as this run's (told before it starts): the run shuts the device down", async () => {
    const { simctl } = fakeSimctl({ state: 'Shutdown' }, { bootFails: true });
    const dev = await findOrCreateDevice(simctl, 'iPhone 17 Pro', () => undefined, dir);
    let booting = false;
    await expect(
      bootDevice(
        simctl,
        dev,
        () => undefined,
        () => (booting = true),
      ),
    ).rejects.toThrow(/boot failed/);
    expect(booting).toBe(true);
  });

  it('two runs asking at once for a device not made yet make it once (the second finds it under the lock)', async () => {
    const { calls, simctl } = fakeSimctl(null, { createMs: 300 });
    const [a, b] = await Promise.all([findOrCreateDevice(simctl, 'iPhone 17 Pro', () => undefined, dir), findOrCreateDevice(simctl, 'iPhone 17 Pro', () => undefined, dir)]);
    expect(calls.filter((c) => c.startsWith('create ')).length).toBe(1);
    expect([a.created, b.created].sort()).toEqual([false, true]);
    expect(a.udid).toBe(b.udid);
  });

  it('a lock is waited for while a live process holds it; a folder it cannot be made in fails at once', async () => {
    const held = DeviceLock.acquire('build', 'run a', dir);
    const t0 = Date.now();
    setTimeout(() => held.release(), 700);
    const got = await waitForLock('build', 'run b', dir, { untilMs: 5000 });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(600);
    got.release();
    expect(() => DeviceLock.acquire('build', 'run c', dir) && DeviceLock.acquire('build', 'run d', dir)).toThrow(LockBusy);
    const shut = join(dir, 'read-only');
    mkdirSync(shut);
    chmodSync(shut, 0o500);
    const t1 = Date.now();
    await expect(waitForLock('build', 'run e', shut, { untilMs: 10_000 })).rejects.not.toBeInstanceOf(LockBusy);
    expect(Date.now() - t1).toBeLessThan(3000);
    chmodSync(shut, 0o700);
  });

  it('an unknown device type names the iPhones there are', async () => {
    const { simctl } = fakeSimctl(null);
    await expect(findOrCreateDevice(simctl, 'iPhone 99', () => undefined)).rejects.toThrow(/device "iPhone 99" is not a simulator device type of this Xcode \(iPhones: iPhone 17 Pro\)/);
  });

  it('a lock left by a process that is gone is broken (said), not waited for', () => {
    const gone = spawnSync('/usr/bin/true').pid;
    const udid = 'STALE-UDID';
    writeFileSync(join(dir, `${udid}.lock`), JSON.stringify({ pid: gone, command: 'run gone', since: new Date().toISOString() }));
    const notes: string[] = [];
    const lock = DeviceLock.acquire(udid, 'run a', dir, (m) => notes.push(m));
    expect(lock.held).toBe(true);
    expect(notes).toEqual(['removed a stale lock of the simulator']);
    lock.release();
  });

  it('one take per device: its lock is held until released', () => {
    const lock = DeviceLock.acquire(UDID, 'run a', dir);
    expect(lock.held).toBe(true);
    expect(() => DeviceLock.acquire(UDID, 'run b', dir)).toThrow(/the simulator is in use by run a \(pid \d+\)/);
    lock.release();
    expect(lock.held).toBe(false);
    const again = DeviceLock.acquire(UDID, 'run b', dir);
    expect(again.held).toBe(true);
    again.release();
  });
});
