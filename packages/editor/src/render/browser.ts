/**
 * The browser Remotion renders with: `$RETAKE_CHROMIUM_HEADLESS_SHELL`, else Playwright's Chromium headless shell
 * (looked up through playwright-core's browser registry, so it follows PLAYWRIGHT_BROWSERS_PATH and the installed
 * revision: the app bundle's own when Retake runs from one — `@retake/core/io` bundle.ts), else none: a render then refuses to start
 * and says how to install the headless shell. Remotion never downloads a browser of its own.
 */
import { existsSync, realpathSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { policyProgram } from '@retake/core';
import type { WorkPolicy } from '@retake/core';
import { bundleInfo, insideBundle, programLookup } from '@retake/core/io';
import type { BundleInfo } from '@retake/core/io';
import { RenderError } from './types.js';

const require = createRequire(import.meta.url);

export const HEADLESS_SHELL_ENV = 'RETAKE_CHROMIUM_HEADLESS_SHELL';

/** The command that installs Playwright's headless shell in a repository checkout. */
export const HEADLESS_SHELL_INSTALL = 'pnpm --filter @retake/runner-web exec playwright-core install chromium-headless-shell';

export interface RenderBrowser {
  /** Executable path, or null when there is none (a render refuses: `note` says what to install). */
  path: string | null;
  source: 'env' | 'bundled' | 'playwright' | 'none';
  /** Why the preferred source was not used (shown as a warning), or why there is no render browser. */
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

/** Why there is no render browser: an app without its headless shell, else a machine without Playwright's. */
function missingNote(bundle: BundleInfo | null): string {
  return bundle
    ? `the app's headless shell is missing (${bundle.paths.browsers}): reinstall Retake`
    : `Playwright's Chromium headless shell is not installed: install it (${HEADLESS_SHELL_INSTALL}) or point $${HEADLESS_SHELL_ENV} at one`;
}

export function renderBrowser(env: NodeJS.ProcessEnv = process.env, bundle: BundleInfo | null = bundleInfo(), shell: () => string | null = playwrightHeadlessShell): RenderBrowser {
  const found = (p: string): RenderBrowser['source'] => (insideBundle(p, bundle) ? 'bundled' : 'playwright');
  const fromEnv = env[HEADLESS_SHELL_ENV];
  if (fromEnv) {
    if (existsSync(fromEnv)) return { path: fromEnv, source: 'env' };
    const pw = shell();
    const note = `$${HEADLESS_SHELL_ENV} points to a missing file (${fromEnv})`;
    return pw ? { path: pw, source: found(pw), note } : { path: null, source: 'none', note: `${note}; ${missingNote(bundle)}` };
  }
  const pw = shell();
  if (pw) return { path: pw, source: found(pw) };
  return { path: null, source: 'none', note: missingNote(bundle) };
}

/**
 * A render may start with this browser (else a RenderError saying what to change): one there is — Remotion never
 * downloads its own, from an app bundle or anywhere else — and, under the agent policy (core policyProgram: a job of
 * the worker), one outside the workspace. Returns the executable to start: under the policy, the real path that was
 * checked.
 */
export function assertRenderBrowser(b: RenderBrowser, work: WorkPolicy, bundle: BundleInfo | null = bundleInfo()): string {
  if (!b.path) throw new RenderError(`no browser to render with: ${b.note ?? missingNote(bundle)}`);
  const what = b.source === 'env' ? `$${HEADLESS_SHELL_ENV}` : b.source === 'playwright' && process.env.PLAYWRIGHT_BROWSERS_PATH?.trim() ? '$PLAYWRIGHT_BROWSERS_PATH' : 'the render browser';
  const checked = policyProgram(work, b.path, what, programLookup());
  if (checked.problem) throw new RenderError(checked.problem);
  return checked.program;
}

/**
 * Which browser renders (pure but for a stat): Playwright's headless shell or `$RETAKE_CHROMIUM_HEADLESS_SHELL` by
 * its real path (the revision is in Playwright's folder name), size and date; `none` when there is none (no render
 * starts then). A library preview's key covers it (L4.7 review A L3): a browser update is a new picture.
 */
export function renderBrowserIdentity(env: NodeJS.ProcessEnv = process.env): string {
  const b = renderBrowser(env);
  if (!b.path) return 'none';
  try {
    const real = realpathSync(b.path);
    const st = statSync(real);
    return `${b.source} ${real} ${st.size} ${Math.round(st.mtimeMs)}`;
  } catch {
    return `${b.source} ${b.path}`;
  }
}
