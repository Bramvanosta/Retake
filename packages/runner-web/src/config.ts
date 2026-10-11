import { isAbsolute, resolve } from 'node:path';
import { DEFAULT_CAPTURE, DEFAULT_PACING, expandHome } from '@demo-studio/core';
import type { AuthConfig, BrowserConfig, CaptureSettings, LoadedProject, Pacing } from '@demo-studio/core';

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

function isAuthConfig(v: unknown): v is AuthConfig {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return typeof o.profile === 'string' || typeof o.storage_state === 'string';
}

function projectPath(project: LoadedProject, p: string): string {
  const e = expandHome(p);
  return isAbsolute(e) ? e : resolve(project.dir, e);
}

/** Profile / storage state for an environment: `auth` is global, or keyed by environment name. */
export function resolveAuth(project: LoadedProject, envName: string): { profileDir?: string; storageState?: string } {
  const a = project.config.auth;
  if (!a) return {};
  const cfg = isAuthConfig(a) ? a : (a as Record<string, AuthConfig>)[envName];
  if (!cfg) return {};
  return {
    profileDir: cfg.profile ? projectPath(project, cfg.profile) : undefined,
    storageState: cfg.storage_state ? projectPath(project, cfg.storage_state) : undefined,
  };
}
