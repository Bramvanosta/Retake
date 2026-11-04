/**
 * The browser Remotion renders with: `$RETAKE_CHROMIUM_HEADLESS_SHELL`, else Playwright's Chromium headless shell
 * (looked up through playwright-core's browser registry, so it follows PLAYWRIGHT_BROWSERS_PATH and the installed
 * revision: the app bundle's own when Retake runs from one — core bundle.ts), else none (Remotion then downloads its own
 * headless shell — never from an app bundle, which nothing may write to: a bundle without its headless shell is broken).
 */
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { bundleInfo, insideBundle } from '@retake/core';
import type { BundleInfo } from '@retake/core';
import { RenderError } from './types.js';

const require = createRequire(import.meta.url);

export const HEADLESS_SHELL_ENV = 'RETAKE_CHROMIUM_HEADLESS_SHELL';

export interface RenderBrowser {
  /** Executable path, or null to let Remotion use its own. */
  path: string | null;
  source: 'env' | 'bundled' | 'playwright' | 'remotion';
  /** Why the preferred source was not used (shown as a warning). */
  note?: string;
}

interface PlaywrightRegistry {
  registry: { findExecutable(name: string): { executablePath(lang?: string): string | undefined } | undefined };
}

/** Playwright's headless shell executable, if playwright-core knows one and it is installed. */
export function playwrightHeadlessShell(): string | null {
  try {
    const { registry } = require('playwright-core/lib/server/registry/index') as PlaywrightRegistry;
    const exe = registry.findExecutable('chromium-headless-shell')?.executablePath('javascript');
    return exe && existsSync(exe) ? exe : null;
  } catch {
    return null;
  }
}

export function renderBrowser(env: NodeJS.ProcessEnv = process.env, bundle: BundleInfo | null = bundleInfo(), shell: () => string | null = playwrightHeadlessShell): RenderBrowser {
  const found = (p: string): RenderBrowser['source'] => (insideBundle(p, bundle) ? 'bundled' : 'playwright');
  const fromEnv = env[HEADLESS_SHELL_ENV];
  if (fromEnv) {
    if (existsSync(fromEnv)) return { path: fromEnv, source: 'env' };
    const pw = shell();
    const note = `$${HEADLESS_SHELL_ENV} points to a missing file (${fromEnv})`;
    return pw ? { path: pw, source: found(pw), note } : { path: null, source: 'remotion', note };
  }
  const pw = shell();
  if (pw) return { path: pw, source: found(pw) };
  if (bundle) return { path: null, source: 'remotion', note: `the app's headless shell is missing (${bundle.paths.browsers}): reinstall Retake` };
  return { path: null, source: 'remotion', note: "Playwright's chromium headless shell is not installed (playwright-core install chromium-headless-shell): Remotion uses its own" };
}

/** A render may start with this browser: never Remotion's download from inside an app bundle (RenderError). */
export function assertRenderBrowser(b: RenderBrowser, bundle: BundleInfo | null = bundleInfo()): void {
  if (!b.path && bundle) throw new RenderError(b.note ?? "the app's headless shell is missing: reinstall Retake");
}

/**
 * Which browser renders (pure but for a stat): Playwright's headless shell or `$RETAKE_CHROMIUM_HEADLESS_SHELL` by
 * its real path (the revision is in Playwright's folder name), size and date; Remotion's own by @remotion/renderer's
 * version. A library preview's key covers it (L4.7 review A L3): a browser update is a new picture.
 */
export function renderBrowserIdentity(env: NodeJS.ProcessEnv = process.env): string {
  const b = renderBrowser(env);
  if (!b.path) {
    let version = 'unknown';
    try {
      version = (JSON.parse(readFileSync(require.resolve('@remotion/renderer/package.json'), 'utf8')) as { version: string }).version;
    } catch {
      /* unknown */
    }
    return `remotion ${version}`;
  }
  try {
    const real = realpathSync(b.path);
    const st = statSync(real);
    return `${b.source} ${real} ${st.size} ${Math.round(st.mtimeMs)}`;
  } catch {
    return `${b.source} ${b.path}`;
  }
}
