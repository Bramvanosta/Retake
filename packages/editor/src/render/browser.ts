/**
 * The browser Remotion renders with: `$DEMO_STUDIO_CHROMIUM_HEADLESS_SHELL`, else Playwright's Chromium headless shell
 * (looked up through playwright-core's browser registry, so it follows PLAYWRIGHT_BROWSERS_PATH and the installed
 * revision), else none (Remotion then downloads its own headless shell).
 */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export const HEADLESS_SHELL_ENV = 'DEMO_STUDIO_CHROMIUM_HEADLESS_SHELL';

export interface RenderBrowser {
  /** Executable path, or null to let Remotion use its own. */
  path: string | null;
  source: 'env' | 'playwright' | 'remotion';
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

export function renderBrowser(env: NodeJS.ProcessEnv = process.env): RenderBrowser {
  const fromEnv = env[HEADLESS_SHELL_ENV];
  if (fromEnv) {
    if (existsSync(fromEnv)) return { path: fromEnv, source: 'env' };
    const pw = playwrightHeadlessShell();
    const note = `$${HEADLESS_SHELL_ENV} points to a missing file (${fromEnv})`;
    return pw ? { path: pw, source: 'playwright', note } : { path: null, source: 'remotion', note };
  }
  const pw = playwrightHeadlessShell();
  if (pw) return { path: pw, source: 'playwright' };
  return { path: null, source: 'remotion', note: "Playwright's chromium headless shell is not installed (playwright-core install chromium-headless-shell): Remotion uses its own" };
}
