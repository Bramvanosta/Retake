/**
 * The rendering library on the Node side: the only file of this package's render code that names it (the import-rules
 * ratchet, R10). What renders, bundles and opens the render browser is asked from here; the calls themselves
 * (renderMedia, selectComposition, openBrowser, bundle) stay with their callers, which take them from these loaders.
 * The bundle side has its own file (../remotion/host.ts), and the kit its own (components kit/renderer.ts).
 *
 * Both loaders are lazy: the library pulls in a lot, and planning (`retake plan`) must not pay for it.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { appToolPath, bundleInfo, toolProblem } from '@retake/core/io';
import type { BundleInfo } from '@retake/core/io';
import { RenderError } from './types.js';

const require = createRequire(import.meta.url);

/** The renderer package (renderMedia, renderStill, selectComposition, openBrowser, makeCancelSignal, its ffmpeg caller). */
export function rendererLibrary(): Promise<typeof import('@remotion/renderer')> {
  return import('@remotion/renderer');
}

/** The bundler package (bundle). */
export function bundlerLibrary(): Promise<typeof import('@remotion/bundler')> {
  return import('@remotion/bundler');
}

/**
 * The compositor folder every library call is handed as `binariesDirectory` (its compositor, ffmpeg, ffprobe and their
 * libraries): in the app, its downloaded compositor (`<RETAKE_HOME>/tools/compositor-<version>`, core/io tools.ts) — a
 * RenderError saying what to do while it is not downloaded or its check fails (the app ships no compositor package: a
 * call without it fails loudly); null in a checkout (the library's own package in node_modules). A source scan
 * (test/tools-resolvers.test.ts) requires every library call of this package to name `binariesDirectory`.
 */
export function libraryBinaries(env: NodeJS.ProcessEnv = process.env, bundle: BundleInfo | null = bundleInfo()): string | null {
  if (!bundle) return null;
  const problem = toolProblem('compositor', env, bundle);
  if (problem) throw new RenderError(`no compositor to render with: ${problem}`);
  return appToolPath('compositor', env, bundle);
}

/**
 * The folder of the library's own programs (its compositor, ffmpeg, ffprobe and their libraries): the app's downloaded
 * compositor (libraryBinaries), else the library's own package. The encode tools (encode-tools.ts) link to it.
 */
export async function compositorDir(): Promise<string> {
  const own = libraryBinaries();
  if (own) return own;
  const { RenderInternals } = await rendererLibrary();
  return dirname(RenderInternals.getExecutablePath({ type: 'compositor', binariesDirectory: null, indent: false, logLevel: 'error' }));
}

/** A browser the library opened (openBrowser): what a render session, a still and a preview draw in. */
export type LibraryBrowser = Awaited<ReturnType<Awaited<ReturnType<typeof rendererLibrary>>['openBrowser']>>;

/**
 * The part of a library browser this package's own code reads: its CDP connection (the GPU check, the sandbox check,
 * the network guard, the process report). Kept this loose so a test hands a stand-in.
 */
export interface RenderBrowserHandle {
  connection: unknown;
}

/** The CDP connection of a RenderBrowserHandle, as far as this package talks to it. */
export interface CdpConnection {
  send(method: string, params?: unknown): Promise<unknown>;
  on(event: string, handler: (e: unknown) => void): unknown;
  off(event: string, handler: (e: unknown) => void): unknown;
}

/** The version a package.json says; the path is resolved by the caller, so the package's name is written there. */
function versionAt(resolvePackageJson: () => string): string {
  try {
    return (JSON.parse(readFileSync(resolvePackageJson(), 'utf8')) as { version: string }).version;
  } catch {
    return 'unknown';
  }
}

/**
 * The versions of the library a bundle is built with, as one string: "<remotion> <@remotion/bundler>". It is part of
 * every bundle's cache key (bundle.ts), so its form is fixed: another order or separator would re-key every cache.
 * Both names are written out (not computed) so the import-rules ratchet sees them: LIBRARY_SEAMS allows this file to
 * resolve `remotion` and nothing more of it.
 */
export function libraryVersions(): string {
  const core = versionAt(() => require.resolve('remotion/package.json'));
  const bundler = versionAt(() => require.resolve('@remotion/bundler/package.json'));
  return `${core} ${bundler}`;
}
