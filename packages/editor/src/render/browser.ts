/**
 * The browser Remotion renders with: `$RETAKE_CHROMIUM_HEADLESS_SHELL`, else — in the app — its downloaded render
 * browser (`<RETAKE_HOME>/tools`, core/io tools.ts: used only once its cheap check says ready), else — in a checkout —
 * Playwright's Chromium headless shell (looked up through playwright-core's browser registry, core/io browsers.ts, so it
 * follows PLAYWRIGHT_BROWSERS_PATH and the installed revision), else none: a render then refuses to start and says what
 * to do (`retake tools install` in the app, the install command in a checkout). Remotion never downloads a browser of
 * its own.
 */
import { existsSync, realpathSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { policyProgram } from '@retake/core/policy';
import type { WorkPolicy } from '@retake/core/policy';
import { appToolPath, bundleInfo, playwrightBrowser, programLookup, toolProblem } from '@retake/core/io';
import type { BundleInfo } from '@retake/core/io';
import { RenderError } from './types.js';

const require = createRequire(import.meta.url);

export const HEADLESS_SHELL_ENV = 'RETAKE_CHROMIUM_HEADLESS_SHELL';

/** The command that installs Playwright's headless shell in a repository checkout. */
export const HEADLESS_SHELL_INSTALL = 'pnpm --filter @retake/runner-web exec playwright-core install chromium-headless-shell';

export interface RenderBrowser {
  /** Executable path, or null when there is none (a render refuses: `note` says what to install). */
  path: string | null;
  /** `tools`: the app's downloaded render browser. */
  source: 'env' | 'tools' | 'playwright' | 'none';
  /** Why the preferred source was not used (shown as a warning), or why there is no render browser. */
  note?: string;
}

/** Playwright's headless shell executable, if playwright-core knows one and it is installed (core/io playwrightBrowser, through this package's playwright-core). */
export function playwrightHeadlessShell(): string | null {
  return playwrightBrowser(require, 'chromium-headless-shell', { installed: true });
}

/** Why there is no render browser in a checkout: Playwright's headless shell is not installed. */
function missingNote(): string {
  return `Playwright's Chromium headless shell is not installed: install it (${HEADLESS_SHELL_INSTALL}) or point $${HEADLESS_SHELL_ENV} at one`;
}

/**
 * The render browser of this engine's copy, without `$RETAKE_CHROMIUM_HEADLESS_SHELL`: the app's downloaded one (none,
 * with what to do, while it is not downloaded or its check fails), else Playwright's (a checkout).
 */
function ownRenderBrowser(env: NodeJS.ProcessEnv, bundle: BundleInfo | null, shell: () => string | null): RenderBrowser {
  if (bundle) {
    const problem = toolProblem('render-browser', env, bundle);
    return problem ? { path: null, source: 'none', note: problem } : { path: appToolPath('render-browser', env, bundle), source: 'tools' };
  }
  const pw = shell();
  return pw ? { path: pw, source: 'playwright' } : { path: null, source: 'none', note: missingNote() };
}

export function renderBrowser(env: NodeJS.ProcessEnv = process.env, bundle: BundleInfo | null = bundleInfo(), shell: () => string | null = playwrightHeadlessShell): RenderBrowser {
  const fromEnv = env[HEADLESS_SHELL_ENV];
  if (fromEnv) {
    if (existsSync(fromEnv)) return { path: fromEnv, source: 'env' };
    const own = ownRenderBrowser(env, bundle, shell);
    const note = `$${HEADLESS_SHELL_ENV} points to a missing file (${fromEnv})`;
    return own.path ? { ...own, note } : { ...own, note: `${note}; ${own.note}` };
  }
  return ownRenderBrowser(env, bundle, shell);
}

/**
 * A render may start with this browser (else a RenderError saying what to change): one there is — Remotion never
 * downloads its own, from an app bundle or anywhere else — and, under the agent policy (core policyProgram: a job of
 * the worker), one outside the workspace. Returns the executable to start: under the policy, the real path that was
 * checked.
 */
export function assertRenderBrowser(b: RenderBrowser, work: WorkPolicy): string {
  if (!b.path) throw new RenderError(`no browser to render with: ${b.note ?? missingNote()}`);
  const what = b.source === 'env' ? `$${HEADLESS_SHELL_ENV}` : b.source === 'playwright' && process.env.PLAYWRIGHT_BROWSERS_PATH?.trim() ? '$PLAYWRIGHT_BROWSERS_PATH' : 'the render browser';
  const checked = policyProgram(work, b.path, what, programLookup());
  if (checked.problem) throw new RenderError(checked.problem);
  return checked.program;
}

/**
 * Which browser renders (pure but for a stat): Playwright's headless shell or `$RETAKE_CHROMIUM_HEADLESS_SHELL` by
 * its real path (the revision is in Playwright's folder name), size and date; `none` when there is none (no render
 * starts then). A library preview's key covers it: a browser update is a new picture.
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
