import { DEFAULT_CAPTURE, DEFAULT_PACING } from '@retake/core/project';
import type { BrowserConfig, CaptureSettings, LoadedProject, Pacing } from '@retake/core/project';

function defined<T extends object>(o: Partial<T> | undefined): Partial<T> {
  const out: Partial<T> = {};
  if (!o) return out;
  for (const [k, v] of Object.entries(o)) if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  return out;
}

/** DEFAULT_PACING ← project.config.pacing ← scenario.pacing. */
export function mergePacing(...layers: Array<Partial<Pacing> | undefined>): Pacing {
  return Object.assign({}, DEFAULT_PACING, ...layers.map((l) => defined(l)));
}

/** DEFAULT_CAPTURE ← project.config.capture ← scenario.capture. */
export function mergeCapture(...layers: Array<Partial<CaptureSettings> | undefined>): CaptureSettings {
  return Object.assign({}, DEFAULT_CAPTURE, ...layers.map((l) => defined(l)));
}

export function mergeBrowser(...layers: Array<BrowserConfig | undefined>): BrowserConfig {
  const out: BrowserConfig = Object.assign({}, ...layers.map((l) => defined(l)));
  const args = layers.flatMap((l) => l?.args ?? []);
  if (args.length) out.args = args;
  return out;
}

/**
 * Browser settings of a project run: project.config.browser ← override; the project's `locale` drives the browser
 * locale (navigator.language, Accept-Language, Intl formatting) unless `browser.locale` is set.
 */
export function projectBrowser(project: LoadedProject, override?: BrowserConfig): BrowserConfig {
  const b = mergeBrowser(project.config.browser, override);
  if (b.locale === undefined && project.config.locale) b.locale = project.config.locale;
  return b;
}

/** The legacy single-account profile / storage state of an environment: core's (its one rule), named here for the package's callers. */
export { resolveAuth } from '@retake/core/environment';
