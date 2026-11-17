/**
 * The XCUITest driver built once per Xcode version and version of its sources: its sources (the package's `driver/`)
 * copied into the Retake home (`ios-driver/<key>/src`, core homeIosDriverCache) and built there for testing
 * (`xcodebuild build-for-testing`, derived data beside them) — never in the package, which may be read-only (the app
 * bundle). The key is the Xcode build version and the first 12 hex digits of the sources' sha256. A lock keeps two
 * runs from building the same folder at once; the one that waits reuses what the other built.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { cp, mkdir, readdir, rm } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homeIosDriverCache } from '@retake/core/io';
import { waitForLock } from './device.js';
import type { Exec } from './proc.js';
import { procProblem } from './proc.js';

/** The package's driver sources (beside dist/ and src/). */
export const DRIVER_SOURCES = fileURLToPath(new URL('../driver', import.meta.url));

/** The bundle id of the driver's test runner (the app xcodebuild installs on the device). */
export const DRIVER_RUNNER_BUNDLE_ID = 'com.example.retake.driver.xctrunner';

/** Names never part of the sources (Xcode's per-user state, Finder's files). */
const IGNORED = /(^|[\\/])(xcuserdata|\.DS_Store|build|DerivedData)([\\/]|$)/;

/** Every file of the sources, relative and sorted (POSIX separators). */
export function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      const rel = relative(dir, p);
      if (IGNORED.test(rel)) continue;
      if (statSync(p).isDirectory()) walk(p);
      else out.push(rel.split(sep).join('/'));
    }
  };
  walk(dir);
  return out.sort();
}

/** sha256 of the sources: each file's relative path and bytes, in order. */
export function sourcesHash(dir: string): string {
  const h = createHash('sha256');
  for (const rel of sourceFiles(dir)) {
    h.update(`${rel}\0`);
    h.update(readFileSync(join(dir, rel)));
    h.update('\0');
  }
  return h.digest('hex');
}

/** The Xcode version and build of `xcodebuild -version` ("Xcode 26.6\nBuild version 17F113"). Pure. */
export function parseXcodeVersion(text: string): { version: string; build: string } | null {
  const v = /Xcode\s+(\S+)/.exec(text);
  const b = /Build version\s+(\S+)/.exec(text);
  return v && b ? { version: v[1], build: b[1] } : null;
}

/** The cache key of a build: the Xcode build and the sources' hash (12 hex digits). Pure. */
export function driverKey(xcodeBuild: string, hash: string): string {
  return `${xcodeBuild.replace(/[^A-Za-z0-9.]/g, '_')}-${hash.slice(0, 12)}`;
}

/** What a run needs of the built driver. */
export interface BuiltDriver {
  key: string;
  /** The .xctestrun file `test-without-building` runs. */
  xctestrun: string;
  derivedData: string;
  xcode: { version: string; build: string };
  /** This call built it (the first run with this Xcode and these sources). */
  built: boolean;
}

/** The Xcode of this machine (`xcrun xcodebuild -version`), or the error. */
export async function xcodeVersion(exec: Exec, xcrun: string, signal?: AbortSignal): Promise<{ version: string; build: string }> {
  const r = await exec.run(xcrun, ['xcodebuild', '-version'], { timeoutMs: 30_000, ...(signal ? { signal } : {}) });
  const problem = procProblem(r, 'xcodebuild -version');
  if (problem) throw new Error(`${problem} — iOS runs need Xcode (xcode-select -p names the one in use)`);
  const v = parseXcodeVersion(r.stdout);
  if (!v) throw new Error(`xcodebuild -version said nothing readable (${r.stdout.trim().slice(0, 80)})`);
  return v;
}

/** The .xctestrun of a built folder, or null. */
export async function findXctestrun(derivedData: string): Promise<string | null> {
  const products = join(derivedData, 'Build', 'Products');
  try {
    const f = (await readdir(products)).find((n) => n.endsWith('.xctestrun'));
    return f ? join(products, f) : null;
  } catch {
    return null;
  }
}

export interface DriverBuildOptions {
  exec: Exec;
  xcrun: string;
  log: (m: string) => void;
  signal?: AbortSignal;
  /** The sources (default: the package's driver/). */
  sources?: string;
  /** The cache folder of a key (default: core homeIosDriverCache). */
  cacheOf?: (key: string) => string;
}

/** The driver built for this Xcode and these sources: from the cache, else built now (once). */
export async function ensureDriver(o: DriverBuildOptions): Promise<BuiltDriver> {
  const sources = o.sources ?? DRIVER_SOURCES;
  if (!existsSync(join(sources, 'RetakeDriver.xcodeproj'))) throw new Error(`the iOS driver's sources are missing (${sources})`);
  const xcode = await xcodeVersion(o.exec, o.xcrun, o.signal);
  const key = driverKey(xcode.build, sourcesHash(sources));
  const dir = (o.cacheOf ?? homeIosDriverCache)(key);
  const derivedData = join(dir, 'dd');
  const cached = await findXctestrun(derivedData);
  if (cached) return { key, xctestrun: cached, derivedData, xcode, built: false };
  await mkdir(dir, { recursive: true });
  const lock = await waitForLock('build', 'building the iOS driver', dir, o.signal ? { signal: o.signal } : {});
  try {
    // Built by another run while this one waited.
    const done = await findXctestrun(derivedData);
    if (done) return { key, xctestrun: done, derivedData, xcode, built: false };
    o.log(`building the iOS driver (once per Xcode version: Xcode ${xcode.version}, ${xcode.build})`);
    const src = join(dir, 'src');
    await rm(src, { recursive: true, force: true });
    await cp(sources, src, { recursive: true, filter: (p) => !IGNORED.test(relative(sources, p)) });
    const t0 = Date.now();
    const r = await o.exec.run(o.xcrun, buildArgs(src, derivedData), { timeoutMs: 15 * 60_000, ...(o.signal ? { signal: o.signal } : {}), maxOutput: 64 * 1024 * 1024 });
    const problem = procProblem(r, 'building the iOS driver (xcodebuild build-for-testing)');
    if (problem) {
      const errors = r.stdout
        .split('\n')
        .filter((l) => /error:/.test(l))
        .slice(0, 3)
        .join(' | ');
      throw new Error(`${problem}${errors ? ` — ${errors}` : ''}`);
    }
    const xctestrun = await findXctestrun(derivedData);
    if (!xctestrun) throw new Error(`building the iOS driver made no .xctestrun under ${derivedData}`);
    o.log(`iOS driver built in ${((Date.now() - t0) / 1000).toFixed(1)} s (${dir})`);
    return { key, xctestrun, derivedData, xcode, built: true };
  } finally {
    lock.release();
  }
}

/** The arguments of the driver's build. Pure. */
export function buildArgs(src: string, derivedData: string): string[] {
  return [
    'xcodebuild',
    'build-for-testing',
    '-project',
    join(src, 'RetakeDriver.xcodeproj'),
    '-scheme',
    'RetakeDriver',
    '-destination',
    'generic/platform=iOS Simulator',
    '-derivedDataPath',
    derivedData,
    'CODE_SIGN_IDENTITY=-',
    'CODE_SIGNING_REQUIRED=NO',
  ];
}
