/**
 * The driver's build cache (src/driver-build.ts): its key (the Xcode build and the sources' sha256, 12 digits), the
 * sources copied into the cache and built there once — a second run reuses the build, a run that waits for another's
 * build reuses it too; the build folder is locked while it builds.
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { DeviceLock } from '../src/device.js';
import { DRIVER_SOURCES, buildArgs, driverKey, ensureDriver, parseXcodeVersion, sourceFiles, sourcesHash } from '../src/driver-build.js';
import type { Exec, ProcResult } from '../src/proc.js';

const dir = mkdtempSync(join(tmpdir(), 'retake-driver-build-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const ok = (stdout = ''): ProcResult => ({ code: 0, signal: null, stdout, stderr: '' });

/** A fake xcrun: `xcodebuild -version`, and a build that makes the .xctestrun (after `delayMs`), checking the lock. */
function fakeXcode(o: { delayMs?: number; locks?: boolean[] } = {}) {
  const builds: string[][] = [];
  const exec: Exec = {
    run: async (_p, args) => {
      if (args.join(' ') === 'xcodebuild -version') return ok('Xcode 26.6\nBuild version 17F113\n');
      builds.push([...args]);
      const derived = args[args.indexOf('-derivedDataPath') + 1];
      o.locks?.push(existsSync(join(derived, '..', 'build.lock')));
      await new Promise((r) => setTimeout(r, o.delayMs ?? 0));
      mkdirSync(join(derived, 'Build', 'Products'), { recursive: true });
      writeFileSync(join(derived, 'Build', 'Products', 'RetakeDriver_iphonesimulator26.5-arm64.xctestrun'), '<plist/>');
      return ok();
    },
    start: () => {
      throw new Error('not here');
    },
  };
  return { exec, builds };
}

describe("the driver's build", () => {
  it('its key: the Xcode build and 12 hex digits of the sources (xcuserdata and .DS_Store left out)', () => {
    expect(parseXcodeVersion('Xcode 26.6\nBuild version 17F113\n')).toEqual({ version: '26.6', build: '17F113' });
    expect(parseXcodeVersion('nope')).toBeNull();
    expect(driverKey('17F113', 'abcdef0123456789ffff')).toBe('17F113-abcdef012345');
    const src = join(dir, 'src-a');
    cpSync(DRIVER_SOURCES, src, { recursive: true });
    const h = sourcesHash(src);
    expect(h).toBe(sourcesHash(DRIVER_SOURCES));
    mkdirSync(join(src, 'RetakeDriver.xcodeproj', 'xcuserdata'), { recursive: true });
    writeFileSync(join(src, 'RetakeDriver.xcodeproj', 'xcuserdata', 'me.plist'), 'x');
    writeFileSync(join(src, '.DS_Store'), 'x');
    expect(sourcesHash(src)).toBe(h);
    expect(sourceFiles(src)).toContain('RetakeDriverUITests/Server.swift');
    writeFileSync(join(src, 'RetakeDriverUITests', 'Server.swift'), '// changed');
    expect(sourcesHash(src)).not.toBe(h);
  });

  it('built once into the cache (sources copied there, build-for-testing, derived data beside), then reused', async () => {
    const cache = join(dir, 'cache-1');
    const locks: boolean[] = [];
    const { exec, builds } = fakeXcode({ locks });
    const logs: string[] = [];
    const first = await ensureDriver({ exec, xcrun: 'xcrun', log: (m) => logs.push(m), cacheOf: (k) => join(cache, k) });
    expect(first.built).toBe(true);
    expect(first.key).toBe(driverKey('17F113', sourcesHash(DRIVER_SOURCES)));
    const folder = join(cache, first.key);
    expect(builds).toEqual([buildArgs(join(folder, 'src'), join(folder, 'dd'))]);
    expect(builds[0]).toEqual(expect.arrayContaining(['build-for-testing', '-derivedDataPath', join(folder, 'dd'), 'generic/platform=iOS Simulator']));
    expect(existsSync(join(folder, 'src', 'RetakeDriverUITests', 'DriverTests.swift'))).toBe(true);
    expect(locks).toEqual([true]);
    expect(existsSync(join(folder, 'build.lock'))).toBe(false);
    expect(logs[0]).toMatch(/building the iOS driver \(once per Xcode version: Xcode 26\.6, 17F113\)/);
    // A build there is reused at once, even while another run holds the folder's lock.
    const held = DeviceLock.acquire('build', 'another run', folder);
    try {
      const again = await ensureDriver({ exec, xcrun: 'xcrun', log: () => undefined, cacheOf: (k) => join(cache, k) });
      expect(again).toMatchObject({ built: false, xctestrun: first.xctestrun });
    } finally {
      held.release();
    }
    expect(builds).toHaveLength(1);
  }, 10_000);

  it('two runs at once: one builds, the other waits for its lock and reuses the build', async () => {
    const cache = join(dir, 'cache-2');
    const { exec, builds } = fakeXcode({ delayMs: 1500 });
    const [a, b] = await Promise.all([
      ensureDriver({ exec, xcrun: 'xcrun', log: () => undefined, cacheOf: (k) => join(cache, k) }),
      new Promise((r) => setTimeout(r, 300)).then(() => ensureDriver({ exec, xcrun: 'xcrun', log: () => undefined, cacheOf: (k) => join(cache, k) })),
    ]);
    expect(builds).toHaveLength(1);
    expect([a.built, b.built]).toEqual([true, false]);
    expect(b.xctestrun).toBe(a.xctestrun);
  });
});
