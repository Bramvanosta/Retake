/**
 * Where playwright-core keeps its browsers (L7.25, U14 — finding X9: its private registry was read from two packages,
 * each with its own copy of the registry's shape): the one module that names playwright-core's browser registry. Its
 * path is private to playwright-core (`lib/server/registry`), so the registry's path and shape are written here once;
 * the import-rules ratchet's `browser-registry` check counts the path named anywhere else in packages/*\/src.
 *
 * Core does not depend on playwright-core: each caller hands its own `require` (its `createRequire(import.meta.url)`),
 * so the registry is the caller's own playwright-core, resolved from its package as before — the runner's for a capture
 * (runner-web launch.ts), the editor's for a render's headless shell (editor render/browser.ts). It follows
 * PLAYWRIGHT_BROWSERS_PATH and the installed revision (the app bundle's own browsers when Retake runs from one).
 */
import { existsSync } from 'node:fs';

/** The private module of playwright-core that holds its browser registry. */
export const PLAYWRIGHT_REGISTRY_MODULE = 'playwright-core/lib/server/registry/index';

/** The registry's names of the browsers Retake starts: Chromium (headed, a channel's default) and its headless shell. */
export type PlaywrightBrowserName = 'chromium' | 'chromium-headless-shell' | (string & {});

/** The part of the registry read here (playwright-core's own shape, private). */
interface PlaywrightRegistry {
  registry: { findExecutable(name: string): { executablePath(lang?: string): string | undefined } | undefined };
}

/** What loads a module for the caller (its `createRequire(import.meta.url)`). */
export type ModuleRequire = (id: string) => unknown;

/**
 * The executable playwright-core starts for `name` — a browser of its own (PLAYWRIGHT_BROWSERS_PATH, else its cache) or
 * an installed channel such as `chrome` — as its registry says, through the caller's playwright-core (`require`). Null
 * when it does not say (playwright-core missing, its registry moved, no such browser, an empty path); with `installed`,
 * also when the file is not there.
 */
export function playwrightBrowser(require: ModuleRequire, name: PlaywrightBrowserName, o: { installed?: boolean } = {}): string | null {
  try {
    const { registry } = require(PLAYWRIGHT_REGISTRY_MODULE) as PlaywrightRegistry;
    const exe = registry.findExecutable(name)?.executablePath('javascript');
    if (!exe) return null;
    return o.installed && !existsSync(exe) ? null : exe;
  } catch {
    return null;
  }
}
